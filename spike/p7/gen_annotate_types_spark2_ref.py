#!/usr/bin/env python3
"""CPython oracle for `sqlglot/typing/spark2.py`'s `EXPRESSION_METADATA` overlay
(AIR-2100), exercised through the real `TypeAnnotator` (AIR-2097/R54) it plugs into.

Link 2 of 4 in the `Hive <- Spark2 <- Spark <- Databricks` typing-overlay chain — see
`gen_annotate_types_hive_ref.py`'s own header for the "type fingerprint over
`.walk(bfs=False)`" scheme this reuses unchanged. Every scenario parses with
`read="spark2"` and annotates with `dialect="spark2"`, so `dialect.EXPRESSION_METADATA`
resolves to the real `Spark2` class's 330-entry table (seeded from `Hive`'s 321-entry
table, `src/dialects/spark2.js`'s `static EXPRESSION_METADATA`).

Coverage: the module-level `_annotate_by_similar_args` helper's all three branches
(all-BINARY -> BINARY via CONCAT of two binary columns; mixed known-scalar -> TEXT via
CONCAT of a VARCHAR and an INT column; all-UNKNOWN -> UNKNOWN via CONCAT of two
unqualified/untyped columns), both call sites that share it (`Concat` with a single
`expressions` arg key, `Pad` with two arg keys `this`/`fill_pattern`); every `setEach`
group (DOUBLE x2, VARCHAR x2, `_annotate_by_args(e, "this")` x3); every individually
listed entry including `ApproxQuantile`'s `array=...` kwarg BOTH ways (scalar quantile
vs an ARRAY-typed quantile arg, since the kwarg's value is itself computed per-call from
`e.args["quantile"].is_type(exp.DType.ARRAY)` rather than a fixed boolean); and two
override-precedence proofs against Hive's own table for the SAME class (`AddMonths`:
Hive's VARCHAR-returns vs Spark2's DATE-returns; `NextDay`: Hive's VARCHAR-returns vs
Spark2's DATE-returns).

    PYTHONHASHSEED=0 python3 spike/p7/gen_annotate_types_spark2_ref.py \
        > spike/out/annotate_types_spark2.json
    node spike/p7/fuzz_annotate_types_spark2.mjs
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
    # --- _annotate_by_similar_args via Concat: all-BINARY -> BINARY ---
    (
        "concat-all-binary",
        "SELECT CONCAT(s.a, s.b) FROM t AS s",
        {"t": {"a": "BINARY", "b": "BINARY"}},
    ),
    # --- _annotate_by_similar_args via Concat: mixed known-scalar -> TEXT ---
    (
        "concat-mixed-scalar",
        "SELECT CONCAT(s.a, s.b) FROM t AS s",
        {"t": {"a": "VARCHAR", "b": "INT"}},
    ),
    # --- _annotate_by_similar_args via Concat: all-UNKNOWN -> UNKNOWN ---
    ("concat-all-unknown", "SELECT CONCAT(s.a, s.b) FROM t AS s", None),
    # --- _annotate_by_similar_args via Pad (two arg keys: this, fill_pattern) ---
    (
        "pad-mixed-scalar",
        "SELECT LPAD(s.x, 5, s.fill) FROM t AS s",
        {"t": {"x": "INT", "fill": "VARCHAR"}},
    ),
    (
        "pad-all-binary",
        "SELECT LPAD(s.x, 5, s.fill) FROM t AS s",
        {"t": {"x": "BINARY", "fill": "BINARY"}},
    ),

    # --- returns: DOUBLE group ---
    ("returns-double-atan2", "SELECT ATAN2(s.x, s.y) FROM t AS s", {"t": {"x": "DOUBLE", "y": "DOUBLE"}}),
    ("returns-double-randn", "SELECT RANDN()", None),

    # --- returns: VARCHAR group ---
    ("returns-varchar-format", 'SELECT FORMAT_STRING("%d", s.x) FROM t AS s', {"t": {"x": "INT"}}),
    ("returns-varchar-right", "SELECT RIGHT(s.x, 3) FROM t AS s", {"t": {"x": "VARCHAR"}}),

    # --- annotator: _annotate_by_args(e, "this") group ---
    (
        "by-args-this-array-filter",
        "SELECT FILTER(s.x, y -> y > 1) FROM t AS s",
        {"t": {"x": "ARRAY<INT>"}},
    ),
    ("by-args-this-shuffle", "SELECT SHUFFLE(s.x) FROM t AS s", {"t": {"x": "ARRAY<INT>"}}),
    ("by-args-this-substring", "SELECT SUBSTRING(s.x, 1, 2) FROM t AS s", {"t": {"x": "VARCHAR"}}),

    # --- returns: DOUBLE (Nanvl) ---
    ("returns-double-nanvl", "SELECT NANVL(s.x, s.y) FROM t AS s", {"t": {"x": "DOUBLE", "y": "DOUBLE"}}),

    # --- override: AddMonths (Hive VARCHAR -> Spark2 DATE) ---
    ("override-date-add-months", "SELECT ADD_MONTHS(s.x, 1) FROM t AS s", {"t": {"x": "DATE"}}),

    # --- ApproxQuantile: array=False (scalar quantile) ---
    (
        "approx-quantile-scalar",
        "SELECT APPROX_PERCENTILE(s.x, 0.5) FROM t AS s",
        {"t": {"x": "DOUBLE"}},
    ),
    # --- ApproxQuantile: array=True (ARRAY-typed quantile arg) ---
    (
        "approx-quantile-array",
        "SELECT APPROX_PERCENTILE(s.x, ARRAY(0.1, 0.5)) FROM t AS s",
        {"t": {"x": "DOUBLE"}},
    ),

    # --- AtTimeZone. `x`'s schema type is deliberately VARCHAR, not TIMESTAMP: Spark2's
    # own tokenizer remaps the bare keyword TIMESTAMP to TokenType.TIMESTAMPTZ
    # (`Spark2Tokenizer.KEYWORDS`, `src/dialects/spark2.js`), and `MappingSchema`'s
    # string-to-DataType parsing is itself dialect-aware, so a `"TIMESTAMP"` schema
    # string here would silently resolve to TIMESTAMPTZ -- a real, separate
    # dialect-aware-schema-parsing behavior, not something `AtTimeZone`'s own fixed
    # TIMESTAMP `returns` entry depends on, so it's avoided rather than encoded here.
    ("at-time-zone", "SELECT s.x AT TIME ZONE 'UTC' FROM t AS s", {"t": {"x": "VARCHAR"}}),

    # --- override: NextDay (Hive VARCHAR -> Spark2 DATE) ---
    ("override-date-next-day", "SELECT NEXT_DAY(s.x, 'MO') FROM t AS s", {"t": {"x": "DATE"}}),
]


def dump_types(node):
    out = []
    for n in node.walk(bfs=False):
        t = n.type
        out.append([type(n).__name__, t.this.name if t is not None else None])
    return out


def run_one(sql, schema):
    try:
        ast = parse_one(sql, read="spark2")
        annotated = annotate_types(ast, schema=schema, dialect="spark2")
        return {"ok": dump_types(annotated)}
    except Exception as e:  # noqa: BLE001
        return {"error": type(e).__name__, "message": str(e)}


records = [
    {"name": name, "sql": sql, "schema": schema, "result": run_one(sql, schema)}
    for name, sql, schema in SCENARIOS
]

print(json.dumps({"scenarios": records}))
