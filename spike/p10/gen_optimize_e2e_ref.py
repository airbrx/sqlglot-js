#!/usr/bin/env python3
"""CPython oracle for AIR-2119 ("8.2 End-to-end optimize() differential oracle").

R78 (AIR-2118, PR #96) built the first real oracle for `optimizer/optimizer.py`'s
`RULES` tuple + `optimize()` entry point, replaying `TestOptimizer.test_optimize`
(the `tests/fixtures/optimizer/optimizer.sql` fixture, 82 pairs, plus its own one
inline `identify=False` assertion) -- EXACT 56 / GENERATOR_GAP 25 / MISMATCH 0 /
ERROR 0 / SKIPPED 2. This script extends that to EVERY OTHER real
`optimizer.optimize(...)`-based assertion in `tests/test_optimizer.py`, per AIR-2119's
own framing: "the actual 'is Track 2 done' gate, not any individual module's own
oracle passing in isolation."

Found by a full `grep -n "optimizer\.optimize\b" tests/test_optimizer.py` (18 call
sites; `test_optimize` itself, R78's own target, is excluded below):

  - `test_tpch` / `test_tpcds`      -- the two named targets: real TPC-H (22 queries)
    and TPC-DS (99 queries) fixtures, the actual CTE/subquery/predicate-pushdown
    combinatorial surface no per-module oracle has exercised.
  - `test_merge_subqueries`        -- `rules=[qualify_tables, qualify_columns,
    merge_subqueries]` override, `check_file("merge_subqueries", ..., execute=True)`.
  - `test_canonicalize`            -- `rules=[qualify, quote_identifiers,
    annotate_types, canonicalize]` override, `check_file("canonicalize", ...)` plus
    one inline tsql-parse/postgres-render assertion.
  - `test_optimize_error_highlighting`, `test_expand_alias_refs`, `test_file_schema`,
    `test_lateral_annotation`, `test_union_annotation` (3 of its calls),
    `test_pushdown_projections_keeps_recursive_cte_self_referenced_columns`,
    `test_pushdown_projections_prunes_non_self_referencing_ctes` (2 calls),
    `test_schema_with_spaces`, `test_quotes`, `test_no_pseudocolumn_expansion`,
    `test_semi_anti_join`, `test_case_sensitive_json_dot_access` (2 call sites, one
    invoked 10 times via its own `_parse_and_optimize` closure) -- small, individually
    hand-written ad-hoc assertions, each reproduced with ITS OWN real kwargs below,
    not folded into a generic shape that would silently drop one.

Execution (`# execute: true`/upstream's own `execute=True` kwarg) is OUT OF SCOPE
(AIR-2119's brief, and this port doesn't have a DuckDB bridge): every fixture row's
SQL-text half is kept, the duckdb-vs-duckdb execution half is dropped, same as every
prior P10 fixture-driven oracle.

    PYTHONHASHSEED=0 python3 spike/p10/gen_optimize_e2e_ref.py > spike/out/optimize_e2e.json
    node spike/p10/fuzz_optimize_e2e.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-complete-pin")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import exp, optimizer, parse_one  # noqa: E402
from sqlglot.optimizer.annotate_types import annotate_types  # noqa: E402
from sqlglot.optimizer.qualify_columns import quote_identifiers  # noqa: E402
from sqlglot.schema import MappingSchema  # noqa: E402
from tests.helpers import TPCDS_SCHEMA, TPCH_SCHEMA  # noqa: E402

# test_optimizer.py:131-176 `TestOptimizer.setUp`'s own `self.schema` -- used (as
# `self.schema`) by both `test_merge_subqueries` and `test_canonicalize`'s own
# `check_file(...)` calls below. Copied verbatim rather than re-derived.
SELF_SCHEMA = {
    "x": {"a": "INT", "b": "INT"},
    "y": {"b": "INT", "c": "INT"},
    "z": {"b": "INT", "c": "INT"},
    "w": {"d": "TEXT", "e": "TEXT"},
    "temporal": {"d": "DATE", "t": "DATETIME"},
    "structs": {
        "one": "STRUCT<a_1 INT, b_1 VARCHAR>",
        "nested_0": "STRUCT<a_1 INT, nested_1 STRUCT<a_2 INT, nested_2 STRUCT<a_3 INT>>>",
        "quoted": 'STRUCT<"foo bar" INT>',
    },
    "t_bool": {"a": "BOOLEAN", "b": "BOOLEAN"},
    "unpivotable": {"id": "INT", "jan": "INT", "feb": "INT", "north": "INT", "south": "INT"},
    "pivotable": {"id": "INT", "cat": "TEXT", "val": "INT", "kind": "TEXT", "amt": "INT"},
}


# Mirrors `tests/helpers.py`'s `_filter_comments`/`_extract_meta`/`load_sql_fixture_pairs`
# directly -- same recipe `gen_optimizer_ref.py` (R78) already uses, rather than
# importing the `tests` package's heavier `TestOptimizer` machinery (duckdb/pandas).
def _filter_comments(s):
    return "\n".join(line for line in s.splitlines() if line and not line.startswith("--"))


def _extract_meta(sql):
    meta = {}
    lines = sql.split("\n")
    i = 0
    while lines[i].startswith("#"):
        key, val = lines[i].split(":", maxsplit=1)
        meta[key.lstrip("#").strip()] = val.strip()
        i += 1
    return "\n".join(lines[i:]), meta


def load_pairs(path):
    with open(path, encoding="utf-8") as f:
        statements = _filter_comments(f.read()).split(";")
    size = len(statements)
    for i in range(0, size, 2):
        if i + 1 < size:
            sql = statements[i].strip()
            sql, meta = _extract_meta(sql)
            expected = statements[i + 1].strip()
            yield meta, sql, expected


def _structural_key(node):
    # A sort key that never calls `.sql()` -- a leaf of the AND/OR chain being
    # canonicalized below can itself contain an unported generator construct (e.g.
    # `a / b` inside one AND-ed join condition), and `.sql()` would raise for that
    # leaf exactly like it does for the row's own top-level gap. Reuses the same
    # (class name, sorted scalar args) shape as `fingerprint`'s own DFS below, just
    # scoped to one leaf and json-dumped for a total order.
    return json.dumps([
        [type(n).__name__, {k: v for k, v in sorted(n.args.items())
                             if v is None or isinstance(v, (str, int, float, bool))}]
        for n in node.dfs()
    ], default=str)


def fingerprint(ast):
    # Same (class name, sorted scalar-only args) shape `gen_optimizer_ref.py`/
    # `gen_canonicalize_ref.py`'s own `fingerprint` established, but walked by a
    # custom recursive visitor rather than plain `.dfs()`/`ast.copy().dfs()`:
    # `Expr.iter_expressions` (core.py:1148) yields `self.args.values()` in DICT
    # INSERTION order, not the class's declared `arg_types` order -- so if two
    # equally-correct rule compositions `.set()` two sibling args (e.g. "order" and
    # "limit" on the same `Select`) in a different sequence, `.dfs()`'s traversal
    # order differs even though `Generator.select_sql` always renders ORDER BY before
    # LIMIT regardless of dict order. That divergence is as non-observable as the
    # AND/OR associativity `_canonicalize_connectors` already handles, so child
    # traversal here is ALSO sorted by arg KEY NAME (never by insertion order) --
    # note this sorts which SIBLING ARG comes first, not list-valued args' own
    # internal element order (e.g. a SELECT's `expressions` list), which stays as-is
    # since THAT order is real and observable.
    def visit(n):
        scalars = {
            k: v for k, v in n.args.items() if v is None or isinstance(v, (str, int, float, bool))
        }
        out = [[type(n).__name__, {k: scalars[k] for k in sorted(scalars)}]]
        if isinstance(n, (exp.And, exp.Or)):
            for leaf in sorted(n.flatten(), key=_structural_key):
                out.extend(visit(leaf))
            return out
        for key in sorted(n.args):
            v = n.args[key]
            if isinstance(v, list):
                for item in v:
                    if isinstance(item, exp.Expr):
                        out.extend(visit(item))
            elif isinstance(v, exp.Expr):
                out.extend(visit(v))
        return out

    return visit(ast)


results = []


# `optimize_kwargs` (real Python kwargs -- may hold callables / `MappingSchema`
# instances / real rule-function references, used only to drive THIS oracle's own
# call) and `kwargs_json` (a JSON-safe mirror the JS fuzzer actually reads: schema as
# a plain dict, `rules` as a short tag string the JS side maps to its own real rule
# function references, `on_qualify`/`schema_kind` as tags) are deliberately separate --
# collapsing them would mean inventing a serializer for Python callables.


def sql_row(name, sql, *, optimize_kwargs=None, kwargs_json=None, render_dialect=None,
            pretty=False, read_dialect=None, expected=None):
    """A row whose check is full `.sql()` text equality -- the dominant shape."""
    optimize_kwargs = dict(optimize_kwargs or {})
    parsed = parse_one(sql, read=read_dialect) if isinstance(sql, str) else sql
    ast = optimizer.optimize(parsed, **optimize_kwargs)
    output = ast.sql(pretty=pretty, dialect=render_dialect)
    if expected is not None:
        assert output == expected, (
            f"{name}: oracle pipeline != documented expected\n  got:      {output}\n  expected: {expected}"
        )
    results.append({
        "name": name,
        "kind": "sql",
        "sql": sql if isinstance(sql, str) else sql.sql(),
        "read_dialect": read_dialect,
        "render_dialect": render_dialect,
        "pretty": pretty,
        "kwargs": kwargs_json or {},
        "fingerprint": fingerprint(ast),
        "output": output,
    })


def type_row(name, sql, path, expected_type_name, *, optimize_kwargs=None, kwargs_json=None,
             read_dialect=None):
    """A row whose check is `<path-of(ast)>.type.this.name` equality (type-annotation
    checks reached THROUGH the full pipeline -- `test_lateral_annotation` /
    `test_union_annotation`). Plain `.sql()` text would not catch a type-inference
    regression here since neither row's output text depends on the annotated type."""
    optimize_kwargs = dict(optimize_kwargs or {})
    parsed = parse_one(sql, read=read_dialect)
    ast = optimizer.optimize(parsed, **optimize_kwargs)
    node = ast.expressions[0] if path == "expressions0" else ast.selects[0]
    got_name = node.type.this.name
    assert got_name == expected_type_name, (
        f"{name}: oracle pipeline != documented expected type\n  got: {got_name}  expected: {expected_type_name}"
    )
    results.append({
        "name": name,
        "kind": "type",
        "sql": sql,
        "read_dialect": read_dialect,
        "path": path,
        "kwargs": kwargs_json or {},
        "expected_type_name": expected_type_name,
    })


def error_row(name, sql, *, optimize_kwargs, kwargs_json, must_contain, must_not_contain=None):
    """A row whose check is `OptimizeError` message content, not output SQL --
    `test_optimize_error_highlighting`'s two ANSI-highlighting assertions."""
    try:
        optimizer.optimize(sql, **optimize_kwargs)
        raised = False
        message = ""
    except Exception as e:  # OptimizeError, but caught broadly like a real harness
        raised = True
        message = str(e)
    assert raised, f"{name}: oracle pipeline did not raise as the real test expects"
    for s in must_contain:
        assert s in message, f"{name}: expected substring {s!r} missing from: {message!r}"
    for s in must_not_contain or []:
        assert s not in message, f"{name}: unexpected substring {s!r} present in: {message!r}"
    results.append({
        "name": name,
        "kind": "error",
        "sql": sql,
        "kwargs": kwargs_json,
        "must_contain": must_contain,
        "must_not_contain": must_not_contain or [],
    })


# ---------------------------------------------------------------------------
# 1. test_tpch / test_tpcds -- the two named, primary targets.
# ---------------------------------------------------------------------------

for fixture, schema_tag, schema in (
    ("tpc-h/tpc-h", "TPCH", TPCH_SCHEMA), ("tpc-ds/tpc-ds", "TPCDS", TPCDS_SCHEMA),
):
    path = os.path.join(REF, f"tests/fixtures/optimizer/{fixture}.sql")
    for i, (meta, sql, expected) in enumerate(load_pairs(path), start=1):
        title = meta.get("title") or f"{i}"
        name = f"{fixture}-{i}-{title}"
        dialect = meta.get("dialect")
        # `pretty` is check_file's OWN named parameter (py:178-186), never forwarded
        # into `optimize()`'s own `**kwargs` -- it governs ONLY the later
        # `.sql(pretty=pretty, dialect=dialect)` call, same as `sql_row`'s own
        # separate `pretty=` argument below. It must NOT be stuffed into
        # `optimize_kwargs`/`kwargs_json`: upstream's `optimize()` would silently
        # drop an unmatched `pretty` kwarg (no rule names that parameter), but this
        # port's `validateKwargs` correctly RAISES on an unrecognized kwarg, so
        # passing it through here would make a real "no bug" row misreport as ERROR.
        kwargs = {"schema": schema}
        if dialect:
            kwargs["dialect"] = dialect
        # Embedded directly (not a "TPCH"/"TPCDS" tag) so the JS fuzzer needs no
        # side-loaded schema file -- `schema_tag` is kept only for log/debug clarity.
        kwargs_json = {"schema": schema, "schema_tag": schema_tag}
        if dialect:
            kwargs_json["dialect"] = dialect
        sql_row(name, sql, optimize_kwargs=kwargs, kwargs_json=kwargs_json,
                render_dialect=dialect, pretty=True, read_dialect=dialect, expected=expected)

# ---------------------------------------------------------------------------
# 2. test_merge_subqueries -- `rules=` override naming RAW rule functions
#    (`qualify_tables`, `qualify_columns`, `merge_subqueries`), not the orchestrating
#    `qualify()`. Per R78's own PORT_PLAN entry, a `rules=` override naming a function
#    outside the 14 `RULES` entries falls through `optimizer.js`'s `ADAPTERS.get(rule)`
#    to a no-kwargs `rule(optimized)` call -- a DOCUMENTED, deferred-to-this-issue
#    limitation this oracle is specifically positioned to surface.
# ---------------------------------------------------------------------------

from sqlglot.optimizer.qualify_tables import qualify_tables  # noqa: E402
from sqlglot.optimizer.qualify_columns import qualify_columns  # noqa: E402
from sqlglot.optimizer.merge_subqueries import merge_subqueries  # noqa: E402
from sqlglot.optimizer.qualify import qualify  # noqa: E402
from sqlglot.optimizer.canonicalize import canonicalize  # noqa: E402

merge_path = os.path.join(REF, "tests/fixtures/optimizer/merge_subqueries.sql")
for i, (meta, sql, expected) in enumerate(load_pairs(merge_path), start=1):
    title = meta.get("title") or f"{i}"
    name = f"merge_subqueries-{i}-{title}"
    dialect = meta.get("dialect")
    leave_tables_isolated = meta.get("leave_tables_isolated")
    kwargs = {
        "schema": SELF_SCHEMA,
        "rules": [qualify_tables, qualify_columns, merge_subqueries],
    }
    kwargs_json = {"schema": "SELF", "rules": "qualify_tables+qualify_columns+merge_subqueries"}
    if dialect:
        kwargs["dialect"] = dialect
        kwargs_json["dialect"] = dialect
    if leave_tables_isolated is not None:
        flag = leave_tables_isolated.strip().lower() == "true"
        kwargs["leave_tables_isolated"] = flag
        kwargs_json["leave_tables_isolated"] = flag
    sql_row(name, sql, optimize_kwargs=kwargs, kwargs_json=kwargs_json, render_dialect=dialect,
            pretty=False, read_dialect=dialect, expected=expected)

# ---------------------------------------------------------------------------
# 3. test_canonicalize -- `rules=` override naming `qualify`/`quote_identifiers`/
#    `annotate_types`/`canonicalize`. UNLIKE #2 above, all four ARE real `RULES`
#    members with real `ADAPTERS` entries already, so this exercises the
#    ALREADY-SUPPORTED override path (schema/dialect DO reach these rules), a useful
#    contrast with #2's unsupported-override gap.
# ---------------------------------------------------------------------------

canon_path = os.path.join(REF, "tests/fixtures/optimizer/canonicalize.sql")
for i, (meta, sql, expected) in enumerate(load_pairs(canon_path), start=1):
    title = meta.get("title") or f"{i}"
    name = f"canonicalize-{i}-{title}"
    dialect = meta.get("dialect")
    kwargs = {
        "schema": SELF_SCHEMA,
        "rules": [qualify, quote_identifiers, annotate_types, canonicalize],
    }
    kwargs_json = {"schema": "SELF", "rules": "qualify+quote_identifiers+annotate_types+canonicalize"}
    if dialect:
        kwargs["dialect"] = dialect
        kwargs_json["dialect"] = dialect
    sql_row(name, sql, optimize_kwargs=kwargs, kwargs_json=kwargs_json, render_dialect=dialect,
            pretty=False, read_dialect=dialect, expected=expected)

# test_canonicalize's own one inline assertion: tsql-PARSE, postgres-RENDER.
sql_row(
    "canonicalize-inline-tsql-to-postgres",
    "SELECT CAST(a AS TEXT) + CAST(b AS TEXT) FROM t",
    optimize_kwargs={
        "dialect": "tsql",
        "rules": [qualify, quote_identifiers, annotate_types, canonicalize],
    },
    kwargs_json={
        "dialect": "tsql",
        "rules": "qualify+quote_identifiers+annotate_types+canonicalize",
    },
    render_dialect="postgres",
    read_dialect="tsql",
    expected='SELECT CAST("t"."a" AS TEXT) || CAST("t"."b" AS TEXT) AS "_col_0" FROM "t" AS "t"',
)

# ---------------------------------------------------------------------------
# 4. test_optimize_error_highlighting -- OptimizeError message/highlighting, not
#    output SQL. Two rows: `sql=sql` (highlighted) and `sql=None` (not highlighted).
# ---------------------------------------------------------------------------

from sqlglot.errors import ANSI_RESET, ANSI_UNDERLINE  # noqa: E402

_err_schema = SELF_SCHEMA
_err_sql = "SELECT nonexistent FROM x"
error_row(
    "optimize_error_highlighting-with-sql",
    _err_sql,
    optimize_kwargs={"schema": _err_schema, "sql": _err_sql},
    kwargs_json={"schema": "SELF", "sql_kwarg": True},
    must_contain=["Column 'nonexistent' could not be resolved", f"{ANSI_UNDERLINE}nonexistent{ANSI_RESET}"],
)
error_row(
    "optimize_error_highlighting-without-sql",
    _err_sql,
    optimize_kwargs={"schema": _err_schema, "sql": None},
    kwargs_json={"schema": "SELF", "sql_kwarg": False},
    must_contain=["Column 'nonexistent' could not be resolved"],
    must_not_contain=[f"{ANSI_UNDERLINE}nonexistent{ANSI_RESET}"],
)

# ---------------------------------------------------------------------------
# 5. test_expand_alias_refs -- two plain `optimizer.optimize(sql)` calls, no schema.
# ---------------------------------------------------------------------------

sql_row(
    "expand_alias_refs-negative-group-by",
    "SELECT -99 AS e GROUP BY e",
    expected='SELECT -99 AS "e" GROUP BY 1',
)
sql_row(
    "expand_alias_refs-lateral-expansion-no-schema",
    "SELECT a + 1 AS d, d + 1 AS e FROM x WHERE e > 1 GROUP BY e",
    expected='SELECT "x"."a" + 1 AS "d", "x"."a" + 1 + 1 AS "e" FROM "x" AS "x" WHERE ("x"."a" + 2) > 1 GROUP BY "x"."a" + 1 + 1',
)

# ---------------------------------------------------------------------------
# 6. test_file_schema -- `on_qualify` callback kwarg.
# ---------------------------------------------------------------------------

sql_row(
    "file_schema-on_qualify-callback",
    "SELECT * FROM foo",
    optimize_kwargs={"on_qualify": lambda table: table.replace(exp.to_table("bar"))},
    kwargs_json={"on_qualify": "replace_with_bar"},
    expected='SELECT * FROM "bar"',
)

# ---------------------------------------------------------------------------
# 7. test_lateral_annotation / test_union_annotation -- type-annotation checks
#    reached through the FULL pipeline (optimizer.optimize), not a bare
#    `annotate_types()` call (those are out of scope -- not `optimize()`-based).
# ---------------------------------------------------------------------------

type_row(
    "lateral_annotation",
    "SELECT c FROM (select 1 a) as x LATERAL VIEW EXPLODE (a) AS c",
    "expressions0",
    "INT",
)

type_row(
    "union_annotation-chained-unions",
    """
            WITH t AS
            (
                SELECT NULL AS col
                UNION
                SELECT NULL AS col
                UNION
                SELECT 'a' AS col
                UNION
                SELECT NULL AS col
                UNION
                SELECT NULL AS col
            )
            SELECT col FROM t;
        """,
    "selects0",
    "VARCHAR",
)
type_row(
    "union_annotation-nested-subqueries-1",
    """
            WITH t AS
            (
                SELECT NULL AS col
                UNION
                (SELECT NULL AS col UNION ALL SELECT 'a' AS col)
            )
            SELECT col FROM t;
        """,
    "selects0",
    "VARCHAR",
)
type_row(
    "union_annotation-nested-subqueries-2",
    """
            WITH t AS
            (
                (SELECT NULL AS col UNION ALL SELECT 'a' AS col)
                UNION
                SELECT NULL AS col
            )
            SELECT col FROM t;
        """,
    "selects0",
    "VARCHAR",
)

# ---------------------------------------------------------------------------
# 8. test_pushdown_projections_keeps_recursive_cte_self_referenced_columns /
#    test_pushdown_projections_prunes_non_self_referencing_ctes -- RECURSIVE CTEs,
#    postgres dialect + explicit schema. The real test asserts a structural property
#    (which columns survive projection pruning on a CTE); comparing full `.sql()` text
#    is a STRICT SUPERSET of that check (if the rendered SQL matches byte-for-byte,
#    every column that survived pruning is visible in it), so no bespoke structural
#    comparator is built on the JS side for these three rows.
# ---------------------------------------------------------------------------

sql_row(
    "pushdown_projections_keeps_recursive_cte_self_referenced_columns",
    """
                WITH RECURSIVE t AS (
                  SELECT id, link FROM graph WHERE id = 1
                  UNION ALL
                  SELECT g.id, g.link FROM graph AS g, t WHERE g.id = t.link
                )
                SELECT id FROM t
                """,
    optimize_kwargs={"schema": {"graph": {"id": "INT", "link": "INT"}}, "dialect": "postgres"},
    kwargs_json={"schema": {"graph": {"id": "INT", "link": "INT"}}, "dialect": "postgres"},
    render_dialect="postgres",
    read_dialect="postgres",
)
sql_row(
    "pushdown_projections_prunes_non_self_referencing_ctes-1",
    """
                WITH RECURSIVE t AS (
                  SELECT id, link FROM graph WHERE id = 1
                  UNION ALL
                  SELECT g.id, g.link FROM graph AS g, t WHERE g.id = t.link
                ), helper AS (
                  SELECT id, link, junk FROM graph LIMIT 5
                )
                SELECT t.id FROM t JOIN helper ON t.id = helper.id
                """,
    optimize_kwargs={
        "schema": {"graph": {"id": "INT", "link": "INT", "junk": "INT"}},
        "dialect": "postgres",
    },
    kwargs_json={
        "schema": {"graph": {"id": "INT", "link": "INT", "junk": "INT"}},
        "dialect": "postgres",
    },
    render_dialect="postgres",
    read_dialect="postgres",
)
sql_row(
    "pushdown_projections_prunes_non_self_referencing_ctes-2-db-qualified",
    """
                WITH RECURSIVE t AS (
                  SELECT id, link FROM db.t
                  UNION ALL
                  SELECT id, link FROM db.t
                )
                SELECT id FROM t
                """,
    optimize_kwargs={
        "schema": {"db": {"t": {"id": "INT", "link": "INT"}}},
        "dialect": "postgres",
    },
    kwargs_json={
        "schema": {"db": {"t": {"id": "INT", "link": "INT"}}},
        "dialect": "postgres",
    },
    render_dialect="postgres",
    read_dialect="postgres",
)

# ---------------------------------------------------------------------------
# 9. test_schema_with_spaces -- schema with space-containing / pre-quoted column
#    names. Real test asserts AST equality against `parse_one(expected)`; both sides
#    are deterministic functions of the AST so comparing rendered `.sql()` text is
#    equivalent.
# ---------------------------------------------------------------------------

sql_row(
    "schema_with_spaces",
    "SELECT * FROM a",
    optimize_kwargs={"schema": {"a": {"b c": "text", '"d e"': "text"}}},
    kwargs_json={"schema": {"a": {"b c": "text", '"d e"': "text"}}},
    expected=parse_one('SELECT "a"."b c" AS "b c", "a"."d e" AS "d e" FROM "a" AS "a"').sql(),
)

# ---------------------------------------------------------------------------
# 10. test_quotes -- snowflake dialect, pre-quoted schema keys, pretty=True.
# ---------------------------------------------------------------------------

_quotes_schema = {"example": {'"source"': {"id": "text", '"name"': "text", '"payload"': "text"}}}
_quotes_expected = parse_one(
    """
            SELECT
             "source"."ID" AS "ID",
             "source"."name" AS "name",
             "source"."payload" AS "payload"
            FROM "EXAMPLE"."source" AS "source"
            """,
    read="snowflake",
).sql(pretty=True, dialect="snowflake")
sql_row(
    "quotes-snowflake",
    'SELECT * FROM example."source" AS "source"',
    optimize_kwargs={"dialect": "snowflake", "schema": _quotes_schema},
    kwargs_json={"dialect": "snowflake", "schema": _quotes_schema},
    render_dialect="snowflake",
    pretty=True,
    read_dialect="snowflake",
    expected=_quotes_expected,
)

# ---------------------------------------------------------------------------
# 11. test_no_pseudocolumn_expansion -- schema passed as a real `MappingSchema`
#     instance (not a plain dict), constructed WITH its own `dialect="bigquery"`.
# ---------------------------------------------------------------------------

_pseudo_schema = MappingSchema(
    {"a": {"a": "text", "b": "text", "_PARTITIONDATE": "date", "_PARTITIONTIME": "timestamp"}},
    dialect="bigquery",
)
sql_row(
    "no_pseudocolumn_expansion",
    "SELECT * FROM a",
    optimize_kwargs={"schema": _pseudo_schema},
    kwargs_json={
        "schema_kind": "mapping_bigquery",
        "schema": {"a": {"a": "text", "b": "text", "_PARTITIONDATE": "date", "_PARTITIONTIME": "timestamp"}},
    },
    expected=parse_one('SELECT "a"."a" AS "a", "a"."b" AS "b" FROM "a" AS "a"').sql(),
)

# ---------------------------------------------------------------------------
# 12. test_semi_anti_join -- three join kinds, no schema.
# ---------------------------------------------------------------------------

for join_kind in ("LEFT ANTI", "ANTI", "SEMI"):
    query = f"WITH x AS (SELECT 1 AS b UNION ALL SELECT 2 AS b) SELECT x.b FROM x {join_kind} JOIN (SELECT 1 AS b) AS sub ON x.b = sub.b"
    expected = f'WITH "x" AS (SELECT 1 AS "b" UNION ALL SELECT 2 AS "b"), "sub" AS (SELECT 1 AS "b") SELECT "x"."b" AS "b" FROM "x" AS "x" {join_kind} JOIN "sub" AS "sub" ON "sub"."b" = "x"."b"'
    sql_row(f"semi_anti_join-{join_kind.replace(' ', '_')}", query, expected=expected)

# ---------------------------------------------------------------------------
# 13. test_case_sensitive_json_dot_access -- schema + dialect, 10 rows across
#     bigquery/databricks/clickhouse/duckdb/snowflake, plus one bigquery row with
#     no schema at all (the final JSON_VALUE/UNNEST assertion).
# ---------------------------------------------------------------------------

_json_schema = {"t": {"col": "JSON", "struct_col": "STRUCT<STRUCT<STRUCT<VARCHAR>>>"}}


def _json_row(name, sql, dialect, expected):
    sql_row(
        name, sql,
        optimize_kwargs={"schema": _json_schema, "dialect": dialect},
        kwargs_json={"schema": _json_schema, "dialect": dialect},
        render_dialect=dialect, read_dialect=dialect, expected=expected,
    )


for dot_access, norm in (
    ("col.fOo.BaR.BaZ", "`t`.`col`.`fOo`.`BaR`.`BaZ`"),
    ("t.col.fOo.BaR.BaZ", "`t`.`col`.`fOo`.`BaR`.`BaZ`"),
):
    _json_row(
        f"case_sensitive_json_dot_access-bigquery-json_value-{dot_access}",
        f"SELECT JSON_VALUE({dot_access}, '$') AS col FROM t",
        "bigquery",
        f"SELECT JSON_VALUE({norm}, '$') AS `col` FROM `t` AS `t`",
    )
    _json_row(
        f"case_sensitive_json_dot_access-bigquery-bare-{dot_access}",
        f"SELECT {dot_access} AS col FROM t",
        "bigquery",
        f"SELECT {norm} AS `col` FROM `t` AS `t`",
    )

_json_row(
    "case_sensitive_json_dot_access-bigquery-struct",
    "SELECT struct_col.FlD1.flD2.FLD3 AS col FROM t",
    "bigquery",
    "SELECT `t`.`struct_col`.`fld1`.`fld2`.`fld3` AS `col` FROM `t` AS `t`",
)
_json_row(
    "case_sensitive_json_dot_access-databricks",
    "SELECT col:A.a, col:a.A FROM t",
    "databricks",
    "SELECT `t`.`col`:A.a AS `a`, `t`.`col`:a.A AS `a` FROM `t` AS `t`",
)
_json_row(
    "case_sensitive_json_dot_access-clickhouse",
    "SELECT col.A.a, col.a.A FROM t",
    "clickhouse",
    'SELECT "t"."col"."A"."a" AS "a", "t"."col"."a"."A" AS "A" FROM "t" AS "t"',
)
_json_row(
    "case_sensitive_json_dot_access-duckdb",
    "SELECT col.A.a, col.a.A FROM t",
    "duckdb",
    'SELECT "t"."col"."A"."a" AS "a", "t"."col"."a"."A" AS "a" FROM "t" AS "t"',
)
_json_row(
    "case_sensitive_json_dot_access-snowflake",
    "SELECT col:A.a, col:a.A FROM t",
    "snowflake",
    'SELECT GET_PATH("T"."COL", \'A.a\') AS "A", GET_PATH("T"."COL", \'a.A\') AS "A" FROM "T" AS "T"',
)

sql_row(
    "case_sensitive_json_dot_access-bigquery-unnest-no-schema",
    'SELECT JSON_VALUE(item.id) FROM UNNEST(JSON_QUERY_ARRAY(PARSE_JSON(\'[{"id": 1}]\'))) AS item',
    optimize_kwargs={"dialect": "bigquery"},
    kwargs_json={"dialect": "bigquery"},
    render_dialect="bigquery",
    read_dialect="bigquery",
    expected='SELECT JSON_VALUE(`item`.`id`, \'$\') AS `_col_0` FROM UNNEST(JSON_QUERY_ARRAY(PARSE_JSON(\'[{"id": 1}]\'), \'$\')) AS `item`',
)

print(json.dumps(results))
