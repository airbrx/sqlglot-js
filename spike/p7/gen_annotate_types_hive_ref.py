#!/usr/bin/env python3
"""CPython oracle for `sqlglot/typing/hive.py`'s `EXPRESSION_METADATA` overlay
(AIR-2100), exercised through the real `TypeAnnotator` (AIR-2097/R54) it plugs into.

Root of the four-link `Hive <- Spark2 <- Spark <- Databricks` typing-overlay chain —
see `gen_annotate_types_snowflake_ref.py`'s own header for the "type fingerprint over
`.walk(bfs=False)`" scheme this reuses unchanged. Every scenario parses with
`read="hive"` and annotates with `dialect="hive"`, so `TypeAnnotator.__init__`
(`dialect = schema.dialect or Dialect()`) resolves `dialect.EXPRESSION_METADATA` to the
real `Hive` class's 321-entry table (`src/dialects/hive.js`'s `static
EXPRESSION_METADATA`) rather than the base `Dialect`'s 294-entry one.

Coverage: every one of `typing/hive.py`'s 6 `setEach`-equivalent group literals
(BINARY/DOUBLE/VARCHAR/BIGINT/INT `returns` groups, the `_annotate_by_args(e, "this")`
group), plus every individually-listed entry (`ArrayIntersect`, `ApproxQuantile`,
`Coalesce`'s `promote=True` two-arg-key form, `Grouping`, `If`'s `promote=True` form,
`PercentileDisc`, `Quantile`, `RegexpSplit`'s literal `ARRAY<STRING>` DataType `returns`,
`StrToMap`'s literal `MAP<STRING, STRING>` DataType `returns`, `WithinGroup`), plus one
qualified-column-lookup scenario (`FROM t AS s`, `s.x`) proving the Scope-aware Column
branch still resolves correctly with Hive's dialect layered in, per R66's own lesson
that an UNQUALIFIED column never reaches the schema and silently returns UNKNOWN on both
sides.

    PYTHONHASHSEED=0 python3 spike/p7/gen_annotate_types_hive_ref.py \
        > spike/out/annotate_types_hive.json
    node spike/p7/fuzz_annotate_types_hive.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import parse_one  # noqa: E402
from sqlglot.optimizer.annotate_types import annotate_types  # noqa: E402

SCENARIOS = [
    # --- returns: BINARY group ---
    ("returns-binary-unhex", "SELECT UNHEX('abc')", None),
    ("returns-binary-encode", "SELECT ENCODE(s.x, 'utf-8') FROM t AS s", {"t": {"x": "VARCHAR"}}),

    # --- returns: DOUBLE group ---
    ("returns-double-sign", "SELECT SIGN(-5)", None),
    ("returns-double-corr", "SELECT CORR(s.x, s.y) FROM t AS s", {"t": {"x": "DOUBLE", "y": "DOUBLE"}}),
    (
        "returns-double-months-between",
        "SELECT MONTHS_BETWEEN(s.x, s.y) FROM t AS s",
        {"t": {"x": "DATE", "y": "DATE"}},
    ),

    # --- returns: VARCHAR group ---
    ("returns-varchar-hex", "SELECT HEX('abc')", None),
    ("returns-varchar-add-months", "SELECT ADD_MONTHS(s.x, 1) FROM t AS s", {"t": {"x": "DATE"}}),
    ("returns-varchar-current-database", "SELECT CURRENT_DATABASE()", None),
    (
        "returns-varchar-regexp-extract",
        "SELECT REGEXP_EXTRACT(s.x, 'a')",
        None,
    ),
    ("returns-varchar-soundex", "SELECT SOUNDEX(s.x) FROM t AS s", {"t": {"x": "VARCHAR"}}),

    # --- returns: BIGINT group ---
    ("returns-bigint-factorial", "SELECT FACTORIAL(5)", None),
    (
        "returns-bigint-intdiv",
        "SELECT s.x DIV s.y FROM t AS s",
        {"t": {"x": "INT", "y": "INT"}},
    ),
    ("returns-bigint-str-to-unix", "SELECT UNIX_TIMESTAMP('2024-01-01', 'yyyy-MM-dd')", None),

    # --- returns: INT group ---
    ("returns-int-array-size", "SELECT ARRAY_SIZE(ARRAY(1, 2, 3))", None),
    (
        "returns-int-dense-rank",
        "SELECT DENSE_RANK() OVER (ORDER BY s.x) FROM t AS s",
        {"t": {"x": "INT"}},
    ),
    ("returns-int-month", "SELECT MONTH(s.x) FROM t AS s", {"t": {"x": "DATE"}}),

    # --- annotator: _annotate_by_args(e, "this") group ---
    (
        "by-args-this-array-distinct",
        "SELECT ARRAY_DISTINCT(s.x) FROM t AS s",
        {"t": {"x": "ARRAY<INT>"}},
    ),
    ("by-args-this-reverse", "SELECT REVERSE(s.x) FROM t AS s", {"t": {"x": "VARCHAR"}}),
    ("by-args-this-first", "SELECT FIRST(s.x) FROM t AS s", {"t": {"x": "INT"}}),

    # --- individually-listed entries ---
    (
        "array-intersect",
        "SELECT ARRAY_INTERSECT(s.x, s.y) FROM t AS s",
        {"t": {"x": "ARRAY<INT>", "y": "ARRAY<INT>"}},
    ),
    (
        "approx-quantile",
        "SELECT APPROX_QUANTILE(s.x, 0.5) FROM t AS s",
        {"t": {"x": "DOUBLE"}},
    ),
    (
        "coalesce-promote",
        "SELECT COALESCE(s.x, s.y) FROM t AS s",
        {"t": {"x": "INT", "y": "DOUBLE"}},
    ),
    ("grouping", "SELECT GROUPING(s.x) FROM t AS s GROUP BY s.x", {"t": {"x": "INT"}}),
    (
        "if-promote",
        "SELECT IF(s.c, s.x, s.y) FROM t AS s",
        {"t": {"c": "BOOLEAN", "x": "INT", "y": "DOUBLE"}},
    ),
    ("percentile-disc", "SELECT PERCENTILE_DISC(s.x, 0.5) FROM t AS s", {"t": {"x": "DOUBLE"}}),
    ("quantile", "SELECT QUANTILE(s.x, 0.5) FROM t AS s", {"t": {"x": "DOUBLE"}}),
    ("regexp-split-returns-array", "SELECT SPLIT(s.x, ',') FROM t AS s", {"t": {"x": "VARCHAR"}}),
    (
        "str-to-map-returns-map",
        "SELECT STR_TO_MAP('a:1,b:2')",
        None,
    ),
    (
        "within-group",
        "SELECT PERCENTILE_CONT(s.x, 0.5) WITHIN GROUP (ORDER BY s.x) FROM t AS s",
        {"t": {"x": "DOUBLE"}},
    ),

    # --- qualified-column Scope-aware lookup, dialect="hive" layered in ---
    ("qualified-column-lookup", "SELECT s.x FROM t AS s", {"t": {"x": "INT"}}),
]


def dump_types(node):
    out = []
    for n in node.walk(bfs=False):
        t = n.type
        out.append([type(n).__name__, t.this.name if t is not None else None])
    return out


def run_one(sql, schema):
    try:
        ast = parse_one(sql, read="hive")
        annotated = annotate_types(ast, schema=schema, dialect="hive")
        return {"ok": dump_types(annotated)}
    except Exception as e:  # noqa: BLE001
        return {"error": type(e).__name__, "message": str(e)}


records = [
    {"name": name, "sql": sql, "schema": schema, "result": run_one(sql, schema)}
    for name, sql, schema in SCENARIOS
]

print(json.dumps({"scenarios": records}))
