#!/usr/bin/env python3
"""CPython oracle for `sqlglot/typing/snowflake.py`'s `EXPRESSION_METADATA` overlay
(AIR-2098), exercised through the real `TypeAnnotator` (AIR-2097/R54) it plugs into.

Same "type fingerprint over `.walk(bfs=False)`" scheme `gen_annotate_types_ref.py`
already established for the BASE table — see that file's own header for why the
`.sql()`-string-equality trick every other greenfield P7 oracle uses does not apply to
an annotation pass. The only structural difference here: every scenario parses with
`read="snowflake"` and annotates with `dialect="snowflake"`, so `TypeAnnotator.__init__`
(`dialect = schema.dialect or Dialect()`) resolves `dialect.EXPRESSION_METADATA` to the
real `Snowflake` class's 457-entry table (`src/dialects/snowflake.js`'s
`static EXPRESSION_METADATA`) rather than the base `Dialect`'s 294-entry one -- the
thing this file is actually here to prove reaches the right table at all, on top of
proving each entry's own logic is faithful.

Coverage: every one of `typing/snowflake.py`'s 14 module-level `_annotate_*` helpers at
least once (`_annotate_reverse` both the NULL and non-NULL branch, `_annotate_
timestamp_from_parts` both with and without a zone, `_annotate_date_or_time_add` both
the DATE-non-day-part special case and its `_annotate_by_args` fallback, `_annotate_
decode_case` both the odd-length/no-default and even-length/has-default arg shapes,
`_annotate_arg_max_min` (ArgMax and ArgMin share it), `_annotate_within_group` both the
PercentileCont/Ordered-rewrite branch and its plain fallback, `_annotate_median`'s
DOUBLE and NUMBER(p,s) branches, `_annotate_variance`'s DECFLOAT/DOUBLE/scale-0/
scale-nonzero branches, `_annotate_kurtosis`'s three branches, `_annotate_math_with_
float_decfloat`'s DECFLOAT-vs-DOUBLE branches, `_annotate_str_to_time`'s target_type
dispatch), plus a representative sample of the 163 `returns`/inline-lambda entries
(an ARRAY-returns override of a base-table BIGINT entry, a BOOLEAN-returns entry, a
NUMBER-builder inline lambda, a TINYINT-returns override of the base's INT entry for
the same class, and `ArrayAgg`'s Snowflake-specific ARRAY-returns override of the base
table's own by-args annotator for the same class -- proving OVERRIDE precedence, not
just new-key coverage).

    PYTHONHASHSEED=0 python3 spike/p7/gen_annotate_types_snowflake_ref.py \
        > spike/out/annotate_types_snowflake.json
    node spike/p7/fuzz_annotate_types_snowflake.mjs
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
    # --- _annotate_reverse ---
    ("reverse-null", "SELECT REVERSE(NULL)", None),
    ("reverse-string", "SELECT REVERSE('abc')", None),

    # --- _annotate_timestamp_from_parts ---
    ("timestamp-from-parts-no-zone", "SELECT TIMESTAMP_FROM_PARTS(2024, 1, 1, 0, 0, 0)", None),
    (
        "timestamp-from-parts-with-zone",
        "SELECT TIMESTAMP_FROM_PARTS(2024, 1, 1, 0, 0, 0, 0, 'UTC')",
        None,
    ),

    # --- _annotate_date_or_time_add (DateAdd and TimeAdd share it) ---
    (
        "dateadd-date-day-part",
        "SELECT DATEADD(DAY, 1, CAST('2024-01-01' AS DATE))",
        None,
    ),
    (
        "dateadd-date-hour-part",
        "SELECT DATEADD(HOUR, 1, CAST('2024-01-01' AS DATE))",
        None,
    ),
    (
        "dateadd-non-date",
        "SELECT DATEADD(DAY, 1, s.x) FROM t AS s",
        {"t": {"x": "TIMESTAMP"}},
    ),
    (
        "timeadd-date-hour-part",
        "SELECT TIMEADD(HOUR, 1, CAST('2024-01-01' AS DATE))",
        None,
    ),

    # --- _annotate_decode_case ---
    (
        "decode-with-default",
        "SELECT DECODE(s.x, 1, 'a', 2, 'b', 'default') FROM t AS s",
        {"t": {"x": "INT"}},
    ),
    (
        "decode-no-default",
        "SELECT DECODE(s.x, 1, 'a', 2, 'b') FROM t AS s",
        {"t": {"x": "INT"}},
    ),

    # --- _annotate_arg_max_min (ArgMax, ArgMin) ---
    ("arg-max", "SELECT ARG_MAX(s.x, s.y) FROM t AS s", {"t": {"x": "VARCHAR", "y": "INT"}}),
    ("arg-min", "SELECT ARG_MIN(s.x, s.y) FROM t AS s", {"t": {"x": "VARCHAR", "y": "INT"}}),

    # --- _annotate_within_group (WithinGroup) ---
    (
        "within-group-percentile-cont",
        "SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY s.x) FROM t AS s",
        {"t": {"x": "DOUBLE"}},
    ),
    (
        "within-group-listagg-fallback",
        "SELECT LISTAGG(s.x, ',') WITHIN GROUP (ORDER BY s.x) FROM t AS s",
        {"t": {"x": "VARCHAR"}},
    ),

    # --- _annotate_median ---
    ("median-double", "SELECT MEDIAN(s.x) FROM t AS s", {"t": {"x": "DOUBLE"}}),
    ("median-number", "SELECT MEDIAN(s.x) FROM t AS s", {"t": {"x": "NUMBER(10, 2)"}}),

    # --- _annotate_variance (Variance, VariancePop) ---
    ("variance-decfloat", "SELECT VARIANCE(s.x) FROM t AS s", {"t": {"x": "DECFLOAT"}}),
    ("variance-double", "SELECT VARIANCE(s.x) FROM t AS s", {"t": {"x": "DOUBLE"}}),
    ("variance-number-scale-zero", "SELECT VARIANCE(s.x) FROM t AS s", {"t": {"x": "NUMBER(10, 0)"}}),
    (
        "variance-pop-number-scale-nonzero",
        "SELECT VAR_POP(s.x) FROM t AS s",
        {"t": {"x": "NUMBER(10, 4)"}},
    ),

    # --- _annotate_kurtosis ---
    ("kurtosis-decfloat", "SELECT KURTOSIS(s.x) FROM t AS s", {"t": {"x": "DECFLOAT"}}),
    ("kurtosis-double", "SELECT KURTOSIS(s.x) FROM t AS s", {"t": {"x": "DOUBLE"}}),
    ("kurtosis-number", "SELECT KURTOSIS(s.x) FROM t AS s", {"t": {"x": "NUMBER(10, 2)"}}),

    # --- _annotate_math_with_float_decfloat (Acos etc.) ---
    ("acos-decfloat", "SELECT ACOS(s.x) FROM t AS s", {"t": {"x": "DECFLOAT"}}),
    ("acos-int", "SELECT ACOS(s.x) FROM t AS s", {"t": {"x": "INT"}}),
    ("sqrt-double", "SELECT SQRT(s.x) FROM t AS s", {"t": {"x": "DOUBLE"}}),

    # --- _annotate_str_to_time (StrToTime target_type dispatch) ---
    (
        "str-to-time-timestamp",
        "SELECT TO_TIMESTAMP('20240115', 'YYYYMMDD')",
        None,
    ),
    (
        "str-to-time-timestampltz",
        "SELECT TO_TIMESTAMP_LTZ('20240115', 'YYYYMMDD')",
        None,
    ),

    # --- ConvertTimezone inline lambda ---
    (
        "convert-timezone-2arg",
        "SELECT CONVERT_TIMEZONE('UTC', s.x) FROM t AS s",
        {"t": {"x": "TIMESTAMP"}},
    ),
    (
        "convert-timezone-3arg",
        "SELECT CONVERT_TIMEZONE('UTC', 'America/Los_Angeles', s.x) FROM t AS s",
        {"t": {"x": "TIMESTAMP"}},
    ),

    # --- HashAgg inline lambda (fixed NUMBER(19,0)) ---
    ("hash-agg", "SELECT HASH_AGG(s.x) FROM t AS s", {"t": {"x": "INT"}}),

    # --- ConcatWs inline lambda (annotate by expressions) ---
    (
        "concat-ws",
        "SELECT CONCAT_WS('-', s.a, s.b) FROM t AS s",
        {"t": {"a": "VARCHAR", "b": "VARCHAR"}},
    ),

    # --- a representative sample of plain `returns`/inline-lambda entries ---
    ("returns-array-split", "SELECT SPLIT(s.x, ',') FROM t AS s", {"t": {"x": "VARCHAR"}}),
    ("returns-bigint-factorial", "SELECT FACTORIAL(s.x) FROM t AS s", {"t": {"x": "INT"}}),
    (
        "returns-boolean-booland",
        "SELECT BOOLAND(s.a, s.b) FROM t AS s",
        {"t": {"a": "INT", "b": "INT"}},
    ),
    (
        "returns-number-builder-to-number",
        "SELECT TO_NUMBER(s.x) FROM t AS s",
        {"t": {"x": "VARCHAR"}},
    ),
    # DayOfWeek: base table says INT (typing/__init__.py), Snowflake overrides to TINYINT.
    ("override-tinyint-dayofweek", "SELECT DAYOFWEEK(s.x) FROM t AS s", {"t": {"x": "DATE"}}),
    # ArrayAgg: base table's own by-args-array annotator vs Snowflake's flat ARRAY-returns
    # override for the SAME class -- proves override precedence, not just new-key coverage.
    (
        "override-array-returns-arrayagg",
        "SELECT ARRAY_AGG(s.x) FROM t AS s",
        {"t": {"x": "INT"}},
    ),
    # Round: base table has no entry (falls through to UNKNOWN); Snowflake adds a
    # by-args annotator.
    ("new-key-round", "SELECT ROUND(s.x) FROM t AS s", {"t": {"x": "DOUBLE"}}),
]


def dump_types(node):
    out = []
    for n in node.walk(bfs=False):
        t = n.type
        out.append([type(n).__name__, t.this.name if t is not None else None])
    return out


def run_one(sql, schema):
    try:
        ast = parse_one(sql, read="snowflake")
        annotated = annotate_types(ast, schema=schema, dialect="snowflake")
        return {"ok": dump_types(annotated)}
    except Exception as e:  # noqa: BLE001
        return {"error": type(e).__name__, "message": str(e)}


records = [
    {"name": name, "sql": sql, "schema": schema, "result": run_one(sql, schema)}
    for name, sql, schema in SCENARIOS
]

print(json.dumps({"scenarios": records}))
