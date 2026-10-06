#!/usr/bin/env python3
"""CPython oracle for `sqlglot/optimizer/qualify_columns.py` (AIR-2106 CORE +
AIR-2107 remainder).

`src/optimizer/qualify_columns.js` ports `qualify_columns`, `validate_qualify_columns`,
`qualify_outputs`, `quote_identifiers`, `pushdown_cte_alias_columns`, and every
`_`-prefixed helper. The `qualify()` end-to-end orchestrator that wires this file and
`qualify_tables.js` together is a DIFFERENT upstream file, `optimizer/qualify.py`,
AIR-2108, still out of scope. Same "no `corpus/atoms.jsonl` tie-in" shape
`resolver.js`/R48, `merge_subqueries.js`/R52, and `simplify.js`/R59 already established
for this project's optimizer tier: nothing in `src/` calls `qualify_columns` yet, so
this hand-written scenario battery is the only differential signal on it. Comparison
is plain `.sql()` string equality (or, for the error-path scenarios, exception class +
message) -- simpler than an AST-dump diff and just as strict, since this port's own
parser+generator are independently verified elsewhere (PORT_PLAN.md P1-P5) and any
AST-shape divergence here would show up as different SQL text.

Every record carries an explicit `"fn"` tag (`qualify_columns`, `validate_qualify_columns`,
or `quote_identifiers`) so the JS fuzzer can dispatch each scenario to the right
top-level export instead of assuming one function for the whole file.

This module reads schema (column existence AND, via `TypeAnnotator`, column TYPE for
struct-star expansion) far more than any other greenfield P7 oracle, so most scenarios
carry a real schema dict. Coverage, organized by the upstream helper each scenario is
named after:

  qualify_columns (top-level orchestration):
    - the module's own docstring example
    - `infer_schema`/early-vs-late alias-ref-expansion ordering (schema empty vs not,
      and BigQuery's FORCE_EARLY_ALIAS_REF_EXPANSION override)
    - allow_partial_qualification suppressing the "Unknown column" raise

  _separate_pseudocolumns: Snowflake's LEVEL pseudocolumn, gated on CONNECT BY

  _pop_table_column_aliases + pushdown_cte_alias_columns (run together, exactly as the
  real pipeline does): a CTE declared `cte(x, y)` referenced by its pushed-down alias
  names in HAVING (Snowflake's PREFER_CTE_ALIAS_COLUMN)

  _expand_using: plain USING (2-way, COALESCE), 3-way chained USING (COALESCE over
  all prior sources), NATURAL JOIN synthesizing its own USING list, and a SEMI JOIN
  USING (no COALESCE -- is_semi_or_anti_join skip)

  _expand_alias_refs: WHERE/HAVING/QUALIFY/GROUP BY alias expansion, the GROUP BY
  literal-index rewrite, BigQuery's EXPAND_ONLY_GROUP_ALIAS_REF +
  PROJECTION_ALIASES_SHADOW_SOURCE_NAMES shadow-marking in GROUP BY/HAVING/QUALIFY, and
  a recursive CTE's right-subtree alias-exclusion branch being reached (WITH RECURSIVE)

  _expand_group_by / _expand_order_by_and_distinct_on / _expand_positional_references /
  _select_by_pos: GROUP BY N, ORDER BY N, Postgres DISTINCT ON (N)

  _convert_columns_to_dots: a 3-part `t.c.f1` column where `c` isn't a real source,
  rewritten into a qualified Dot chain

  _qualify_positional_column: Snowflake `t.$1` resolving against the schema's REAL
  column order

  _qualify_columns: join-disambiguation via schema, an unresolvable qualified column
  left untouched (no source named `x`), an unknown real column raising OptimizeError,
  Postgres's TABLES_REFERENCEABLE_AS_COLUMNS struct-style bare-table reference, and a
  PIVOT whose columns come from the pivot's OWN output names, not the base table's

  _expand_struct_stars_no_parens: BigQuery struct-field star expansion
  (`t.c.*` where `c: STRUCT<f1 INT>`)

  _expand_stars: bare `*`, `* EXCEPT(...)`, `* REPLACE(...)`, DuckDB `* RENAME(...)`,
  DuckDB `* ILIKE '...'`, and the PIVOT-output-columns star branch (same PIVOT query as
  above, star form)

  qualify_outputs: an unnamed arithmetic expression (`_col_N`), a bare Subquery
  PROJECTION (not a FROM-clause derived table) getting a synthetic alias

  validate_qualify_columns: a qualified-but-unresolvable column raising "could not be
  resolved" both with and without a `for table: '...'` suffix (the latter is the
  common unqualified-column case, not just a quirk -- an unqualified column's empty
  table text never matches a real source name, so it is ALWAYS also an "external"
  column; only `scope.pivots`/`is_correlated_subquery` gate which of the two error
  branches -- "could not be resolved" vs. "Ambiguous column" -- actually fires), a
  PIVOT scope's unqualified column taking the "Ambiguous column" branch instead (the
  pivot's presence is what skips the immediate per-scope raise), a clean pass once
  `qualify_columns` has already run, and the `sql=` kwarg's ANSI-highlighted snippet
  appended to the message

  quote_identifiers: default double-quote identify=True, an already-quoted identifier
  left alone, Snowflake's case-sensitive quoting, BigQuery's backtick quoting,
  Postgres/DuckDB double-quote quoting, and identify=False still quoting identifiers
  that NEED it regardless (a reserved word, a case-sensitive dialect's mixed-case
  identifier) while leaving a plain lowercase one unquoted

    PYTHONHASHSEED=0 python3 spike/p7/gen_qualify_columns_ref.py > spike/out/qualify_columns.json
    node spike/p7/fuzz_qualify_columns.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import parse_one  # noqa: E402
from sqlglot.optimizer.qualify_columns import (  # noqa: E402
    qualify_columns,
    quote_identifiers,
    validate_qualify_columns,
)

# (name, sql, schema_dict, kwargs, dialect)
SCENARIOS = [
    # --- qualify_columns's own module docstring (py:40-45). ---
    ("module-docstring", "SELECT col FROM tbl", {"tbl": {"col": "INT"}}, {}, None),

    # --- basic qualification / ambiguity / join disambiguation ---
    ("basic-unqualified", "SELECT a FROM t", {"t": {"a": "INT", "b": "INT"}}, {}, None),
    ("ambiguous-column-left-unqualified",
     "SELECT a FROM t1, t2", {"t1": {"a": "INT"}, "t2": {"a": "INT"}}, {}, None),
    ("join-disambiguate-via-schema",
     "SELECT a, b FROM t1 JOIN t2 ON t1.id = t2.id",
     {"t1": {"id": "INT", "a": "INT"}, "t2": {"id": "INT", "b": "INT"}}, {}, None),

    # --- infer_schema / early-vs-late alias-ref expansion ordering ---
    ("no-schema-triggers-early-alias-expansion",
     "SELECT a AS b FROM t WHERE b > 1", {}, {}, None),
    ("force-early-alias-ref-expansion-bigquery",
     "SELECT a AS b FROM t WHERE b > 1", {"t": {"a": "INT"}}, {}, "bigquery"),
    ("allow-partial-qualification-suppresses-unknown-column",
     "SELECT unknown_col FROM t", {"t": {"a": "INT"}}, {"allow_partial_qualification": True}, None),
    ("unknown-column-raises",
     "SELECT t.z FROM t", {"t": {"a": "INT"}}, {}, None),
    ("unresolvable-qualified-column-left-untouched",
     "SELECT x.a FROM t", {"t": {"a": "INT"}}, {}, None),

    # --- _separate_pseudocolumns: Snowflake LEVEL, gated on CONNECT BY ---
    ("snowflake-level-pseudocolumn-with-connect-by",
     "SELECT LEVEL FROM t START WITH id = 1 CONNECT BY PRIOR id = parent_id",
     {"t": {"id": "INT", "parent_id": "INT"}}, {}, "snowflake"),
    ("snowflake-level-without-connect-by-not-pseudocolumn",
     "SELECT level FROM t", {"t": {"level": "INT"}}, {}, "snowflake"),

    # --- _pop_table_column_aliases + pushdown_cte_alias_columns, Snowflake ---
    ("cte-alias-pushdown-snowflake-having",
     "WITH cte(x, y) AS (SELECT a, b FROM t) SELECT x FROM cte HAVING y > 1",
     {"t": {"a": "INT", "b": "INT"}}, {}, "snowflake"),

    # --- _expand_using ---
    ("using-two-way-coalesce",
     "SELECT id FROM t1 JOIN t2 USING (id)",
     {"t1": {"id": "INT", "a": "INT"}, "t2": {"id": "INT", "b": "INT"}}, {}, None),
    ("using-three-way-coalesce-chain",
     "SELECT id FROM t1 JOIN t2 USING (id) JOIN t3 USING (id)",
     {"t1": {"id": "INT"}, "t2": {"id": "INT"}, "t3": {"id": "INT"}}, {}, None),
    ("natural-join-synthesizes-using",
     "SELECT * FROM t1 NATURAL JOIN t2",
     {"t1": {"id": "INT", "a": "INT"}, "t2": {"id": "INT", "b": "INT"}}, {}, None),
    ("using-semi-join-no-coalesce",
     "SELECT t1.id FROM t1 LEFT SEMI JOIN t2 USING (id)",
     {"t1": {"id": "INT"}, "t2": {"id": "INT"}}, {}, "spark"),

    # --- _expand_alias_refs ---
    ("alias-ref-expands-in-where",
     "SELECT a AS b FROM t WHERE b > 1", {"t": {"a": "INT"}}, {}, None),
    ("alias-ref-groupby-literal-index",
     "SELECT a AS b, COUNT(*) FROM t GROUP BY b", {"t": {"a": "INT"}}, {}, None),
    ("bigquery-group-shadow-source-name",
     "SELECT id, ARRAY_AGG(col) AS custom_fields FROM custom_fields GROUP BY custom_fields.id",
     {"custom_fields": {"id": "INT", "col": "INT"}}, {}, "bigquery"),
    ("bigquery-having-shadow-source-name",
     "SELECT id, MAX(col) AS custom_fields FROM custom_fields GROUP BY id HAVING custom_fields > 1",
     {"custom_fields": {"id": "INT", "col": "INT"}}, {}, "bigquery"),
    ("bigquery-qualify-shadow-source-name",
     "SELECT id, MAX(col) AS custom_fields FROM custom_fields QUALIFY custom_fields > 1",
     {"custom_fields": {"id": "INT", "col": "INT"}}, {}, "bigquery"),
    ("recursive-cte-right-subtree-alias-exclusion",
     "WITH RECURSIVE cte AS (SELECT 1 AS n UNION ALL SELECT n + 1 AS n FROM cte WHERE n < 5) "
     "SELECT n FROM cte", {}, {}, None),

    # --- _expand_group_by / _expand_order_by_and_distinct_on / _select_by_pos ---
    ("groupby-positional-reference",
     "SELECT a, COUNT(*) FROM t GROUP BY 1", {"t": {"a": "INT"}}, {}, None),
    ("orderby-positional-reference",
     "SELECT a FROM t ORDER BY 1", {"t": {"a": "INT"}}, {}, None),
    ("distinct-on-positional-reference-postgres",
     "SELECT DISTINCT ON (1) a, b FROM t", {"t": {"a": "INT", "b": "INT"}}, {}, "postgres"),

    # --- _convert_columns_to_dots ---
    ("struct-field-column-converted-to-dot",
     "SELECT t.c.f1 FROM t", {"t": {"c": "STRUCT<f1 INT>"}}, {}, None),

    # --- _qualify_positional_column (Snowflake $N) ---
    ("positional-column-ref-snowflake",
     "SELECT t.$1 FROM t", {"t": {"a": "INT", "b": "INT"}}, {}, "snowflake"),

    # --- _qualify_columns: TABLES_REFERENCEABLE_AS_COLUMNS, PIVOT ---
    ("table-referenceable-as-column-postgres",
     "SELECT t FROM t", {"t": {"a": "INT"}}, {}, "postgres"),
    ("pivot-columns-resolve-against-pivot-output",
     "SELECT region, Q1, Q2 FROM t PIVOT (SUM(revenue) FOR quarter IN ('Q1', 'Q2'))",
     {"t": {"revenue": "INT", "quarter": "VARCHAR", "region": "VARCHAR"}}, {}, None),

    # --- _expand_struct_stars_no_parens (BigQuery) ---
    ("struct-star-expansion-bigquery",
     "SELECT t.c.f1.* FROM t", {"t": {"c": "STRUCT<f1 STRUCT<f2 INT>>"}}, {}, "bigquery"),
    ("struct-star-expansion-one-level-bigquery",
     "SELECT t.c.* FROM t", {"t": {"c": "STRUCT<f1 INT, f2 VARCHAR>"}}, {}, "bigquery"),

    # --- _expand_stars ---
    ("star-basic", "SELECT * FROM t", {"t": {"a": "INT", "b": "INT"}}, {}, None),
    ("star-except", "SELECT * EXCEPT(a) FROM t", {"t": {"a": "INT", "b": "INT"}}, {}, None),
    ("star-replace", "SELECT * REPLACE(a + 1 AS a) FROM t", {"t": {"a": "INT", "b": "INT"}}, {}, None),
    ("star-rename-duckdb", "SELECT * RENAME(a AS c) FROM t", {"t": {"a": "INT", "b": "INT"}}, {}, "duckdb"),
    ("star-ilike-duckdb", "SELECT * ILIKE '%a' FROM t", {"t": {"aa": "INT", "bb": "INT"}}, {}, "duckdb"),
    ("pivot-star-resolves-against-pivot-output",
     "SELECT * FROM t PIVOT (SUM(revenue) FOR quarter IN ('Q1', 'Q2'))",
     {"t": {"revenue": "INT", "quarter": "VARCHAR", "region": "VARCHAR"}}, {}, None),
    ("qualified-star-single-source",
     "SELECT t1.* FROM t1 JOIN t2 ON t1.id = t2.id",
     {"t1": {"id": "INT", "a": "INT"}, "t2": {"id": "INT", "b": "INT"}}, {}, None),

    # --- qualify_outputs ---
    ("unnamed-expression-gets-col-n-alias",
     "SELECT a + 1 FROM t", {"t": {"a": "INT"}}, {}, None),
    ("subquery-projection-gets-synthetic-alias",
     "SELECT (SELECT 1) FROM t", {"t": {"a": "INT"}}, {}, None),

    # --- a combined, realistic end-to-end query exercising several helpers together ---
    ("combined-join-alias-star-groupby",
     "SELECT a AS x, b FROM t1 JOIN t2 USING (id) WHERE x > 0 GROUP BY x, b",
     {"t1": {"id": "INT", "a": "INT"}, "t2": {"id": "INT", "b": "INT"}}, {}, None),
]


# These 7 scenarios hit base-Generator methods that are pre-existing `NotPorted`
# stubs in THIS port's `src/generator.js` (`pseudocolumn_sql`, `dot_sql`, `pivot_sql`,
# and `TableColumn`'s missing TRANSFORMS entry) -- unrelated to `qualify_columns.js`
# itself, the same "structural check instead of .sql()" treatment
# `gen_merge_subqueries_ref.py` already established for its own four scenarios that
# hit unported `window_sql`/`querytransform_sql`. `repr(expr)` is Python's
# `Expression.__repr__`, a pure structural dump that never calls the SQL generator;
# this port's `Expr.toString()` is the verified byte-exact equivalent (R21, and the
# same mechanism this whole project's AST-oracle gate already relies on).
STRUCTURAL = {
    "snowflake-level-pseudocolumn-with-connect-by",
    "struct-field-column-converted-to-dot",
    "table-referenceable-as-column-postgres",
    "pivot-columns-resolve-against-pivot-output",
    "struct-star-expansion-bigquery",
    "struct-star-expansion-one-level-bigquery",
    "pivot-star-resolves-against-pivot-output",
}


def run_one(name, sql, schema, kwargs, dialect):
    try:
        ast = parse_one(sql, dialect=dialect)
        out = qualify_columns(ast, schema, dialect=dialect, **kwargs)
        if name in STRUCTURAL:
            return {"repr": repr(out)}
        return {"ok": out.sql(dialect=dialect)}
    except Exception as e:  # noqa: BLE001
        return {"error": type(e).__name__, "message": str(e)}


# --- validate_qualify_columns (AIR-2107): (name, sql, pre_qualify_schema, dialect, sql_arg) ---
# `pre_qualify_schema`, when not None, is run through `qualify_columns` first (the real
# pipeline order, qualify.py:107-117) so `validate_qualify_columns` sees an
# already-qualified tree instead of a raw parse.
VALIDATE_SCENARIOS = [
    ("validate-could-not-be-resolved-for-table", "SELECT x.a FROM t", None, None, None),
    ("validate-could-not-be-resolved-no-table", "SELECT a FROM t1, t2", None, None, None),
    ("validate-ambiguous-column-via-pivot",
     "SELECT a FROM t PIVOT (SUM(revenue) FOR quarter IN ('Q1'))", None, None, None),
    ("validate-passes-after-qualify-columns", "SELECT a FROM t", {"t": {"a": "INT"}}, None, None),
    ("validate-sql-highlight-formatting", "SELECT x.a FROM t", None, None, "SELECT x.a FROM t"),
]


def run_validate(name, sql, pre_qualify_schema, dialect, sql_arg):
    try:
        ast = parse_one(sql, dialect=dialect)
        if pre_qualify_schema is not None:
            ast = qualify_columns(ast, pre_qualify_schema, dialect=dialect)
        out = validate_qualify_columns(ast, sql=sql_arg)
        return {"ok": out.sql(dialect=dialect)}
    except Exception as e:  # noqa: BLE001
        return {"error": type(e).__name__, "message": str(e)}


# --- quote_identifiers (AIR-2107): (name, sql, dialect, identify) ---
QUOTE_SCENARIOS = [
    ("quote-default-identify-true", "SELECT a FROM t", None, True),
    ("quote-already-quoted-stays", 'SELECT "a" FROM "t"', None, True),
    ("quote-mixed-case-needs-quote", 'SELECT a, "B" FROM t', None, True),
    ("quote-snowflake-case-sensitive", 'SELECT a, "B" FROM t', "snowflake", True),
    ("quote-bigquery-backtick", "SELECT a FROM t", "bigquery", True),
    ("quote-postgres", "SELECT a FROM t", "postgres", True),
    ("quote-duckdb", "SELECT a FROM t", "duckdb", True),
    ("quote-identify-false-plain-lower-no-quote", "SELECT a FROM t", None, False),
    ("quote-identify-false-reserved-word-quoted", 'SELECT a AS "select" FROM t', None, False),
    ("quote-identify-false-snowflake-mixed-case-quoted", 'SELECT "FooBar" FROM t', "snowflake", False),
]


def run_quote(name, sql, dialect, identify):
    try:
        ast = parse_one(sql, dialect=dialect)
        out = quote_identifiers(ast, dialect=dialect, identify=identify)
        return {"ok": out.sql(dialect=dialect)}
    except Exception as e:  # noqa: BLE001
        return {"error": type(e).__name__, "message": str(e)}


records = [
    {"fn": "qualify_columns", "name": name, "sql": sql, "schema": schema, "kwargs": kwargs,
     "dialect": dialect, "result": run_one(name, sql, schema, kwargs, dialect)}
    for name, sql, schema, kwargs, dialect in SCENARIOS
] + [
    {"fn": "validate_qualify_columns", "name": name, "sql": sql,
     "pre_qualify_schema": pre_qualify_schema, "dialect": dialect, "sql_arg": sql_arg,
     "result": run_validate(name, sql, pre_qualify_schema, dialect, sql_arg)}
    for name, sql, pre_qualify_schema, dialect, sql_arg in VALIDATE_SCENARIOS
] + [
    {"fn": "quote_identifiers", "name": name, "sql": sql, "dialect": dialect, "identify": identify,
     "result": run_quote(name, sql, dialect, identify)}
    for name, sql, dialect, identify in QUOTE_SCENARIOS
]

print(json.dumps({"scenarios": records}))
