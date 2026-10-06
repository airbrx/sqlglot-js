#!/usr/bin/env python3
"""CPython oracle for `sqlglot/optimizer/qualify.py` (AIR-2108, epic AIR-2087, "4.5
qualify.js orchestrator + end-to-end qualify() oracle" -- the LAST issue in the epic).

`src/optimizer/qualify.js` ports the single `qualify()` function that wires together,
in upstream's exact order and exact kwarg surface, five steps this port has already
landed in isolation: `normalize_identifiers` (R42), `qualify_tables` +
`isolate_table_selects` (R47), `qualify_columns` (R67), and `quote_identifiers` +
`validate_qualify_columns` (R73). Each of those five has its own passing differential
oracle already; what none of them has ever tested is their COMPOSITION under
`qualify()`'s real kwarg surface (`db`/`catalog`/`schema`/`expand_alias_refs`/
`expand_stars`/`infer_schema`/`isolate_tables`/`qualify_columns`/
`allow_partial_qualification`/`validate_qualify_columns`/`quote_identifiers`/
`identify`/`canonicalize_table_aliases`/`on_qualify`/`sql`) -- that composition is
this file's whole reason to exist, per the issue's own framing as "the key proof
point for this whole epic".

Two kinds of coverage, both driving the REAL upstream `optimizer.qualify.qualify`
entry point (never the narrower `qualify_tables`/`qualify_columns` functions
directly, even where a fixture's own historical test calls one of those -- this
oracle always re-derives a FRESH expected value by calling the real orchestrator
itself, never reusing the fixture file's own pre-recorded "expected" column, which in
several cases was computed by a *different*, narrower function):

  1. FIXTURE-DRIVEN: the five real upstream fixture files named in AIR-2108 --
     `tests/fixtures/optimizer/{qualify_columns,qualify_columns_ddl,
     qualify_columns__with_invisible,qualify_tables}.sql` (pairs) and
     `qualify_columns__invalid.sql` (single statements) -- each replayed through
     `optimizer.qualify.qualify` with the SAME kwargs its own upstream consuming test
     uses (`tests/test_optimizer.py`'s `check_file`/`qualify_columns` wrapper for the
     first three, `db="db", catalog="c"` for the fourth, matching
     `test_qualify_tables`'s own `check_file` call, with `qualify_columns=False,
     quote_identifiers=False` to isolate table-qualification behavior the way that
     test's own narrower-function call did -- but note `qualify()` ALSO runs
     `normalize_identifiers` first, which the narrower `qualify_tables()` call never
     did, so this oracle's own fresh-computed values are the ground truth, not the
     fixture file's pre-recorded "expected" column). `check_file`'s own exact meta
     extraction is reproduced directly (`dialect`/`validate_qualify_columns`/
     `canonicalize_table_aliases`; `leave_tables_isolated` and `allow_partial_
     qualification` meta keys exist in these fixture files but `check_file` itself
     never reads them for these functions, so neither does this oracle -- faithful to
     what the real upstream TEST does, not to what the meta line's name suggests).
     Rows tagged with a dialect this port does not implement (`clickhouse`, `mysql`,
     `oracle`, `presto`, `risingwave`, `starrocks`) are skipped with a named reason,
     the same "skip + count" shape `gen_pushdown_predicates_ref.py` already
     established for its own presto/trino/athena rows.

  2. HAND-PICKED kwarg-surface battery: the direct (non-fixture) assertions in
     `tests/test_optimizer.py`'s `test_qualify_tables`/`test_qualify_columns`/
     `test_qualify_snowflake_positional_column_*`/`test_qualify_positional_columns_is_
     snowflake_only`/`test_optimize_error_highlighting`, reproduced verbatim, covering
     (at minimum, per the issue) with/without schema, db/catalog defaults,
     quote_identifiers on/off, identify on/off, expand_stars off, validate off,
     infer_schema explicit/default, isolate_tables, canonicalize_table_aliases, and
     on_qualify, across snowflake/bigquery/postgres/duckdb.

    PYTHONHASHSEED=0 python3 spike/p10/gen_qualify_ref.py > spike/out/qualify.json
    node spike/p10/fuzz_qualify.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-complete-pin")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import parse_one, optimizer  # noqa: E402
from sqlglot.optimizer.qualify import qualify  # noqa: E402
from sqlglot.schema import MappingSchema  # noqa: E402
from sqlglot.errors import OptimizeError, SchemaError  # noqa: E402

# Dialects this port implements (`src/dialects/*.js`). Any fixture row tagged with a
# dialect outside this set is skipped -- `parse_one` would already fail independently
# of anything `qualify.js` itself does.
SUPPORTED_DIALECTS = {
    None, "bigquery", "snowflake", "postgres", "duckdb", "redshift",
    "spark", "spark2", "hive", "databricks", "tsql",
}

# The standard `TestOptimizer.schema` (tests/test_optimizer.py:132), reused verbatim --
# it's what every `qualify_columns*.sql`/`qualify_columns_ddl.sql` fixture row assumes.
SCHEMA = {
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
    "unpivotable": {
        "id": "INT", "jan": "INT", "feb": "INT", "north": "INT", "south": "INT",
    },
    "pivotable": {
        "id": "INT", "cat": "TEXT", "val": "INT", "kind": "TEXT", "amt": "INT",
    },
}

# tests/test_optimizer.py:37-45's local wrapper, reproduced verbatim: every fixture
# row for qualify_columns.sql/qualify_columns_ddl.sql/qualify_columns__with_invisible.sql
# is run through the REAL `qualify()` entry point with these three hardcoded kwargs,
# plus whatever `check_file` adds per-row from fixture meta.
def qualify_columns_wrapper(expression, validate_qualify_columns=True, **kwargs):
    return qualify(
        expression,
        infer_schema=True,
        validate_qualify_columns=validate_qualify_columns,
        identify=False,
        **kwargs,
    )


# --- fixture plumbing: mirrors tests/helpers.py's _filter_comments/_extract_meta/
# load_sql_fixture_pairs/load_sql_fixtures directly, so this script has no import-path
# dependency on how the pinned checkout's own test suite is laid out (same approach
# gen_eliminate_joins_ref.py/gen_normalize_ref.py already use). ---
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


def load_sql_fixture_pairs(path):
    with open(path, encoding="utf-8") as f:
        statements = _filter_comments(f.read()).split(";")
    size = len(statements)
    for i in range(0, size, 2):
        if i + 1 < size:
            sql = statements[i].strip()
            sql, meta = _extract_meta(sql)
            expected = statements[i + 1].strip()
            yield meta, sql, expected


def load_sql_fixtures(path):
    with open(path, encoding="utf-8") as f:
        yield from _filter_comments(f.read()).splitlines()


def string_to_bool(s):
    if s is None:
        return False
    return s.lower() in ("true", "1")


def run_qualify(sql, dialect, kwargs):
    try:
        out = qualify(parse_one(sql, read=dialect), dialect=dialect, **kwargs)
        return {"ok": out.sql(dialect=dialect)}
    except Exception as e:  # noqa: BLE001 -- oracle: capture, don't crash the harness
        return {"error": e.__class__.__name__, "message": str(e)}


# --- 1a/1b/1c: qualify_columns.sql / qualify_columns_ddl.sql / qualify_columns__with_invisible.sql
# -- replayed through check_file's own exact meta-extraction + the local `qualify_columns`
# wrapper above. ---
def run_fixture_pairs(path, schema):
    rows = []
    skipped = 0
    for i, (meta, sql, _expected) in enumerate(load_sql_fixture_pairs(path), start=1):
        dialect = meta.get("dialect")
        if dialect not in SUPPORTED_DIALECTS:
            skipped += 1
            continue

        kwargs = {"schema": schema}
        if "validate_qualify_columns" in meta:
            kwargs["validate_qualify_columns"] = string_to_bool(meta["validate_qualify_columns"])
        if dialect:
            kwargs["dialect"] = dialect

        try:
            out = qualify_columns_wrapper(parse_one(sql, read=dialect), **kwargs)
            result = {"ok": out.sql(dialect=dialect)}
        except Exception as e:  # noqa: BLE001
            result = {"error": e.__class__.__name__, "message": str(e)}

        rows.append({
            "id": i, "title": meta.get("title"), "sql": sql, "dialect": dialect,
            "kwargs": {k: v for k, v in kwargs.items() if k != "schema"},
            "result": result,
        })
    return rows, skipped


# --- 1d: qualify_tables.sql -- same db="db", catalog="c" as test_qualify_tables's own
# check_file call, with qualify_columns=False/quote_identifiers=False to isolate
# table-qualification behavior (schema is irrelevant since qualify_columns is off). ---
def run_qualify_tables_fixture(path):
    rows = []
    skipped = 0
    for i, (meta, sql, _expected) in enumerate(load_sql_fixture_pairs(path), start=1):
        dialect = meta.get("dialect")
        if dialect not in SUPPORTED_DIALECTS:
            skipped += 1
            continue

        kwargs = {"db": "db", "catalog": "c", "qualify_columns": False, "quote_identifiers": False}
        if "canonicalize_table_aliases" in meta:
            kwargs["canonicalize_table_aliases"] = string_to_bool(meta["canonicalize_table_aliases"])
        if dialect:
            kwargs["dialect"] = dialect

        try:
            out = qualify(parse_one(sql, read=dialect), **kwargs)
            result = {"ok": out.sql(dialect=dialect)}
        except Exception as e:  # noqa: BLE001
            result = {"error": e.__class__.__name__, "message": str(e)}

        rows.append({
            "id": i, "title": meta.get("title"), "sql": sql, "dialect": dialect,
            "kwargs": {k: v for k, v in kwargs.items()},
            "result": result,
        })
    return rows, skipped


# --- 1e: qualify_columns__invalid.sql -- single statements that upstream's own
# `test_qualify_columns__invalid` expects to raise (OptimizeError, SchemaError) when
# run through the NARROW two-step `qualify_columns(...)` + `validate_qualify_columns(...)`
# call, with NO prior `qualify_tables` pass. Run through the REAL, FULL `qualify()`
# entry point here instead (this file's actual scope), and a genuine, CONFIRMED
# composition difference surfaces on row 13 (`SELECT a FROM (SELECT * FROM x CROSS
# JOIN y)`): the narrow call raises "Ambiguous column 'a'", because the un-aliased
# derived table's two star-expanded sources (`x`: a,b and `y`: b,c) look ambiguous to
# a resolver that has no name for that source at all; but `qualify()` ALWAYS runs
# `qualify_tables` first (unconditionally, matching upstream's own qualify.py:85-92 --
# unlike `isolate_tables`/`qualify_columns`/`quote_identifiers`/
# `validate_qualify_columns`, there is no kwarg that skips it), which gives the
# derived table a real synthetic alias (`_0`) before `qualify_columns` ever runs, and
# under that alias "a" resolves UNAMBIGUOUSLY (it only appears once, as `x.a`) --
# verified directly against this exact pin (both call shapes checked side by side);
# every other row in this fixture raises identically under both call shapes. This is
# not a bug in either function: the fixture was authored to probe `qualify_columns`
# in ISOLATION, a usage pattern `qualify()` structurally cannot reproduce (it has no
# "skip qualify_tables" switch), so row 13's real, fresh `qualify()` output -- not the
# fixture's own unrelated narrower-function expectation -- is what this oracle
# records and what `qualify.js` must match. See PORT_PLAN.md's entry for this round.
def run_invalid_fixture(path, schema):
    rows = []
    for i, sql in enumerate(load_sql_fixtures(path), start=1):
        try:
            out = qualify(parse_one(sql), schema=schema)
            result = {"ok": out.sql()}
        except (OptimizeError, SchemaError) as e:
            result = {"error": e.__class__.__name__, "message": str(e)}
        rows.append({"id": i, "sql": sql, "result": result})

    # tests/test_optimizer.py:1184-1209 -- the resolver get_table fallback scenario,
    # verifying the error message names the COLUMN, not an "unknown table".
    sql = """
        SELECT
        INLINE_VIEW.a AS ACCOUNT
        FROM (
        (
            SELECT
            a
            FROM table1
        ) inline_view
        LEFT JOIN table2
            ON a = table2.id
        )
        LEFT JOIN table3
        ON inline_view.a = table3.a
    """
    resolver_schema = MappingSchema()
    resolver_schema.add_table("table3", ["a"])
    try:
        qualify(parse_one(sql), schema=resolver_schema)
        result = {"ok": "NO_RAISE"}
    except (OptimizeError, SchemaError) as e:
        result = {"error": e.__class__.__name__, "message": str(e)}
    rows.append({"id": "resolver-get-table-fallback", "sql": sql, "result": result})

    return rows


qc_rows, qc_skipped = run_fixture_pairs("tests/fixtures/optimizer/qualify_columns.sql", SCHEMA)
qc_ddl_rows, qc_ddl_skipped = run_fixture_pairs("tests/fixtures/optimizer/qualify_columns_ddl.sql", SCHEMA)

with_invisible_schema = MappingSchema(SCHEMA, {"x": {"a"}, "y": {"b"}, "z": {"b"}})
qc_invisible_rows, qc_invisible_skipped = run_fixture_pairs(
    "tests/fixtures/optimizer/qualify_columns__with_invisible.sql", with_invisible_schema
)

qt_rows, qt_skipped = run_qualify_tables_fixture("tests/fixtures/optimizer/qualify_tables.sql")
invalid_rows = run_invalid_fixture("tests/fixtures/optimizer/qualify_columns__invalid.sql", SCHEMA)


# --- 2: hand-picked kwarg-surface battery, reproducing the direct (non-fixture)
# assertions in test_qualify_tables/test_qualify_columns/test_qualify_snowflake_*/
# test_optimize_error_highlighting verbatim. Each entry: (name, sql, dialect, schema,
# kwargs, on_qualify_probe). `on_qualify_probe=True` means this scenario also records
# which table names on_qualify was invoked with, as a SEPARATE assertion from the
# rendered SQL (on_qualify has no return value and isn't visible in .sql() alone). ---
KWARG_SCENARIOS = [
    ("docstring-example", "SELECT col FROM tbl", None, {"tbl": {"col": "INT"}}, {}, False),
    ("db-catalog-bigquery-quote-off", "WITH tesT AS (SELECT * FROM t1) SELECT * FROM test",
     "bigquery", None, {"db": "db", "catalog": "catalog", "quote_identifiers": False}, False),
    ("bigquery-join-groupby-positional",
     """SELECT Teams.Name, count(*)
        FROM raw.TeamMemberships as TeamMemberships
        join raw.Teams
            on Teams.Id = TeamMemberships.TeamId
        GROUP BY 1""",
     "bigquery",
     {"raw": {"TeamMemberships": {"Id": "INTEGER", "UserId": "INTEGER", "TeamId": "INTEGER"},
              "Teams": {"Id": "INTEGER", "Name": "STRING"}}},
     {}, False),
    ("schema-qualified-table-joined-twice",
     "SELECT 1 FROM dbo.a JOIN dbo.b ON dbo.b.id = dbo.a.id JOIN dbo.b AS x ON x.id = dbo.a.id",
     None, None, {}, False),
    ("quote-identifiers-false-reserved-word-stays-plain",
     "SELECT * FROM t", None, {"t": {"end": "text"}}, {"quote_identifiers": False}, False),
    ("error-highlighting-with-sql",
     "SELECT nonexistent FROM x", None, {"x": {"a": "INT", "b": "INT"}},
     {"sql": "SELECT nonexistent FROM x"}, False),
    ("error-no-highlighting-without-sql",
     "SELECT nonexistent FROM x", None, {"x": {"a": "INT", "b": "INT"}}, {"sql": None}, False),
    ("validate-false-suppresses-raise",
     "SELECT nonexistent FROM x", None, {"x": {"a": "INT", "b": "INT"}},
     {"validate_qualify_columns": False, "quote_identifiers": False}, False),
    ("expand-stars-false",
     "SELECT * FROM t", None, {"t": {"a": "INT", "b": "INT"}}, {"expand_stars": False}, False),
    ("isolate-tables-true",
     "SELECT a FROM x CROSS JOIN y", None, {"x": {"a": "INT"}, "y": {"b": "INT"}},
     {"isolate_tables": True}, False),
    ("canonicalize-table-aliases-true",
     "SELECT 1 FROM tbl1, tbl2", None, None,
     {"canonicalize_table_aliases": True, "quote_identifiers": False}, False),
    ("qualify-columns-false-validate-false",
     "SELECT a FROM t", None, {"t": {"a": "INT"}},
     {"qualify_columns": False, "validate_qualify_columns": False, "quote_identifiers": False}, False),
    ("ddl-create-with-cte",
     "WITH cte AS (SELECT b FROM y) CREATE TABLE s AS SELECT * FROM cte", None, {"y": {"b": "INT"}},
     {"quote_identifiers": False, "identify": False}, False),
    ("duckdb-star-rename",
     "SELECT * RENAME(a AS c) FROM t", "duckdb", {"t": {"a": "INT", "b": "INT"}}, {}, False),
    ("postgres-distinct-on-positional",
     "SELECT DISTINCT ON (1) a, b FROM t", "postgres", {"t": {"a": "INT", "b": "INT"}}, {}, False),
    ("infer-schema-explicit-false-leaves-column-unqualified-partial",
     "SELECT a FROM t", None, {},
     {"infer_schema": False, "allow_partial_qualification": True, "quote_identifiers": False,
      "validate_qualify_columns": False}, False),
    ("infer-schema-default-none-empty-schema-infers",
     "SELECT a AS b FROM t WHERE b > 1", None, {}, {"quote_identifiers": False}, False),
    ("on-qualify-callback-table-names",
     "with foo AS (select * from bar) select * from foo join baz", None, None,
     {"qualify_columns": False}, True),
    ("qualify-tables-on-qualify-db-catalog-lateral-unnest-once",
     "SELECT a, x FROM t, UNNEST(arr) AS x", None, None,
     {"db": "db", "catalog": "c", "qualify_columns": False, "quote_identifiers": False,
      "validate_qualify_columns": False}, True),
]


def run_kwarg_scenario(name, sql, dialect, schema, kwargs, on_qualify_probe):
    extra = dict(kwargs)
    if schema is not None:
        extra["schema"] = schema
    qualified_names = []
    if on_qualify_probe:
        extra["on_qualify"] = lambda t: qualified_names.append(t.name)
    try:
        out = qualify(parse_one(sql, read=dialect), dialect=dialect, **extra)
        result = {"ok": out.sql(dialect=dialect)}
    except Exception as e:  # noqa: BLE001
        result = {"error": e.__class__.__name__, "message": str(e)}
    if on_qualify_probe:
        result["qualified_names"] = qualified_names
    return result


kwarg_rows = [
    {"name": name, "sql": sql, "dialect": dialect, "schema": schema, "kwargs": kwargs,
     "onQualifyProbe": on_qualify_probe,
     "result": run_kwarg_scenario(name, sql, dialect, schema, kwargs, on_qualify_probe)}
    for name, sql, dialect, schema, kwargs, on_qualify_probe in KWARG_SCENARIOS
]

# --- snowflake positional-column scenarios. The first case needs a visible-columns
# restriction a plain schema dict can't express, so its schema is carried as
# {"mapping": ..., "visible": ...} (JSON-serializable) instead of a `schema` dict,
# letting the JS fuzzer reconstruct an equivalent `MappingSchema` itself. ---
visible_schema = MappingSchema(
    {"t": {"hidden": "INT", "HAS SPACE": "INT"}}, visible={"T": {"HAS SPACE"}}, dialect="snowflake",
)
positional_rows = [
    {
        "name": "snowflake-positional-visible-schema",
        "sql": "SELECT t.$1 FROM t",
        "dialect": "snowflake",
        "visibleSchema": {"mapping": {"t": {"hidden": "INT", "HAS SPACE": "INT"}}, "visible": {"T": ["HAS SPACE"]}},
        "kwargs": {"quote_identifiers": False},
        "result": run_qualify(
            "SELECT t.$1 FROM t", "snowflake",
            {"quote_identifiers": False, "schema": visible_schema},
        ),
    },
    {
        "name": "postgres-positional-is-snowflake-only",
        "sql": "WITH t AS (SELECT 1 AS a) SELECT t.$1 FROM t",
        "dialect": "postgres",
        "kwargs": {"allow_partial_qualification": True, "quote_identifiers": False},
        "result": run_qualify(
            "WITH t AS (SELECT 1 AS a) SELECT t.$1 FROM t", "postgres",
            {"allow_partial_qualification": True, "quote_identifiers": False},
        ),
    },
    {
        "name": "snowflake-positional-out-of-range-raises",
        "sql": "WITH t AS (SELECT 1 AS a) SELECT t.$2 FROM t",
        "dialect": "snowflake",
        "kwargs": {},
        "result": run_qualify("WITH t AS (SELECT 1 AS a) SELECT t.$2 FROM t", "snowflake", {}),
    },
    {
        "name": "snowflake-positional-out-of-range-partial",
        "sql": "WITH t AS (SELECT 1 AS a) SELECT t.$2 FROM t",
        "dialect": "snowflake",
        "kwargs": {"allow_partial_qualification": True, "quote_identifiers": False},
        "result": run_qualify(
            "WITH t AS (SELECT 1 AS a) SELECT t.$2 FROM t", "snowflake",
            {"allow_partial_qualification": True, "quote_identifiers": False},
        ),
    },
]

print(json.dumps({
    "qualify_columns": qc_rows,
    "qualify_columns_skipped": qc_skipped,
    "qualify_columns_ddl": qc_ddl_rows,
    "qualify_columns_ddl_skipped": qc_ddl_skipped,
    "qualify_columns__with_invisible": qc_invisible_rows,
    "qualify_columns__with_invisible_skipped": qc_invisible_skipped,
    "qualify_tables": qt_rows,
    "qualify_tables_skipped": qt_skipped,
    "qualify_columns__invalid": invalid_rows,
    "kwargs": kwarg_rows,
    "positional": positional_rows,
}))
