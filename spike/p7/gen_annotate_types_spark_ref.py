#!/usr/bin/env python3
"""CPython oracle for `sqlglot/typing/spark.py`'s `EXPRESSION_METADATA` overlay
(AIR-2100), exercised through the real `TypeAnnotator` (AIR-2097/R54) it plugs into.

Link 3 of 4 in the `Hive <- Spark2 <- Spark <- Databricks` typing-overlay chain — see
`gen_annotate_types_hive_ref.py`'s own header for the "type fingerprint over
`.walk(bfs=False)`" scheme this reuses unchanged. Every scenario parses with
`read="spark"` and annotates with `dialect="spark"`, so `dialect.EXPRESSION_METADATA`
resolves to the real `Spark` class's 348-entry table (seeded from `Spark2`'s 330-entry
table, `src/dialects/spark.js`'s `static EXPRESSION_METADATA`).

Coverage: every `setEach` group (BINARY, DATE — including the 2-arg `DATE_ADD` ->
`TsOrDsAdd` routing the module's own comment calls out, DOUBLE, VARCHAR,
`_annotate_by_args(e, "this")`), every individually listed entry (`BitmapCount`,
`Grouping`, `Localtimestamp`), and the one override-precedence proof against Spark2's
own table for the SAME class (`Grouping`: Hive's BIGINT-returns, unchanged through
Spark2, vs Spark's TINYINT-returns override).

    PYTHONHASHSEED=0 python3 spike/p7/gen_annotate_types_spark_ref.py \
        > spike/out/annotate_types_spark.json
    node spike/p7/fuzz_annotate_types_spark.mjs
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
    ("returns-binary-bitmap-construct-agg", "SELECT BITMAP_CONSTRUCT_AGG(s.x) FROM t AS s", {"t": {"x": "INT"}}),
    ("returns-binary-to-binary", "SELECT TO_BINARY(s.x) FROM t AS s", {"t": {"x": "VARCHAR"}}),

    # --- returns: DATE group ---
    ("returns-date-from-unix-date", "SELECT DATE_FROM_UNIX_DATE(s.x) FROM t AS s", {"t": {"x": "INT"}}),
    # 2-arg date_add(startDate, numDays) routes to TsOrDsAdd per Hive/Spark parsers.
    ("returns-date-ts-or-ds-add", "SELECT DATE_ADD(s.x, 3) FROM t AS s", {"t": {"x": "DATE"}}),

    # --- returns: DOUBLE (Sec) ---
    ("returns-double-sec", "SELECT SEC(s.x) FROM t AS s", {"t": {"x": "DOUBLE"}}),

    # --- returns: VARCHAR group ---
    ("returns-varchar-collation", "SELECT COLLATION(s.x) FROM t AS s", {"t": {"x": "VARCHAR"}}),
    ("returns-varchar-current-timezone", "SELECT CURRENT_TIMEZONE()", None),
    ("returns-varchar-randstr", "SELECT RANDSTR(10, 0)", None),
    ("returns-varchar-to-char", 'SELECT TO_CHAR(s.x, "format") FROM t AS s', {"t": {"x": "INT"}}),

    # --- annotator: _annotate_by_args(e, "this") group ---
    ("by-args-this-array-compact", "SELECT ARRAY_COMPACT(s.x) FROM t AS s", {"t": {"x": "ARRAY<INT>"}}),
    ("by-args-this-array-insert", "SELECT ARRAY_INSERT(s.x, 1, 5) FROM t AS s", {"t": {"x": "ARRAY<INT>"}}),
    ("by-args-this-bitwise-and-agg", "SELECT BITWISE_AND_AGG(s.x) FROM t AS s", {"t": {"x": "INT"}}),
    ("by-args-this-left", "SELECT LEFT(s.x, 3) FROM t AS s", {"t": {"x": "VARCHAR"}}),
    # `exp.Overlay` itself is deliberately NOT exercised here: its `OVERLAY(x PLACING y
    # FROM n)` special-form syntax needs `_parse_overlay`-equivalent grammar this port's
    # `src/parser.js` doesn't have yet (no `Overlay` reference anywhere in that file) --
    # an unrelated, pre-existing parser gap, not something this overlay's own
    # `_annotate_by_args(e, "this")` entry depends on. Covered instead by a
    # hand-built-AST unit test in `test/typing_spark.test.mjs` that calls the shared
    # annotator closure directly, same treatment R51's own header gives entries its
    # real parser/generator can't yet reach through `.sql()`.

    # --- individually-listed entries ---
    ("bitmap-count", "SELECT BITMAP_COUNT(s.x) FROM t AS s", {"t": {"x": "BINARY"}}),
    # override: Grouping (Hive BIGINT, unchanged through Spark2, -> Spark TINYINT)
    ("override-tinyint-grouping", "SELECT GROUPING(s.x) FROM t AS s GROUP BY s.x", {"t": {"x": "INT"}}),
    ("localtimestamp", "SELECT LOCALTIMESTAMP()", None),
]


def dump_types(node):
    out = []
    for n in node.walk(bfs=False):
        t = n.type
        out.append([type(n).__name__, t.this.name if t is not None else None])
    return out


def run_one(sql, schema):
    try:
        ast = parse_one(sql, read="spark")
        annotated = annotate_types(ast, schema=schema, dialect="spark")
        return {"ok": dump_types(annotated)}
    except Exception as e:  # noqa: BLE001
        return {"error": type(e).__name__, "message": str(e)}


records = [
    {"name": name, "sql": sql, "schema": schema, "result": run_one(sql, schema)}
    for name, sql, schema in SCENARIOS
]

print(json.dumps({"scenarios": records}))
