#!/usr/bin/env python3
"""CPython oracle for five per-dialect type-inference overlays (AIR-2099):
`sqlglot/typing/postgres.py`, `redshift.py`, `duckdb.py`, `bigquery.py`, `tsql.py` —
exercised through the real `TypeAnnotator` (AIR-2097/R54) each one plugs into, the same
"type fingerprint over `.walk(bfs=False)`" scheme `gen_annotate_types_ref.py` (R54) and
`gen_annotate_types_snowflake_ref.py` (R66) already established. One combined oracle
covers all five dialects rather than five separate files, since four of the five
modules are tiny (13/3/24/14 keys) and only BigQuery's (83 keys, 7 custom
`_annotate_*` helpers) is large enough to need real branch coverage on its own.

Every scenario uses a QUALIFIED column (`FROM t AS s`, `s.x`) per R66's own standing
lesson: `_annotate_expression`'s Scope-aware Column branch only fires for a qualified
reference, so an unqualified column never reaches the schema and both sides silently
agree on UNKNOWN — a wasted scenario, not a real one. Every scenario's SQL was run
directly against this pinned CPython checkout before being locked in below, to confirm
its key node resolves a real, distinguishing (non-UNKNOWN) type.

Coverage:
  - Postgres (13 new keys): all 14 EXPRESSION_METADATA entries the module sets, one
    scenario each (Ntile/WidthBucket -> INT; Encode/Left/Right/Overlay/Reverse/Pad/
    Format/Hex/SplitPart/Normalize -> TEXT; Decode -> VARBINARY; ToNumber -> DECIMAL).
  - Redshift (seeded from Postgres, not the base table): its 3 overrides — StrToTime
    (-> TIMESTAMPTZ), Rank (-> INT), Ntile (-> BIGINT, restoring the base default over
    Postgres's own INT override — an override-of-an-override, the same precedence proof
    R66 made for Snowflake's DayOfWeek/ArrayAgg).
  - DuckDB (16 new keys): all 24 EXPRESSION_METADATA entries the module sets (16 BIGINT,
    2 INT128, 3 DOUBLE, 3 VARCHAR, 2 VARBINARY, plus DateBin/PercentileDisc's two
    `_annotate_by_args` annotator entries and Localtimestamp/ToDays/TimeFromParts).
  - TSQL (4 new keys): all 14 entries (8 FLOAT, 2 VARCHAR, Degrees/Radians's
    `_annotate_by_args` annotator entries, CurrentTimezone -> NVARCHAR, CurrentTimestamp
    -> DATETIME).
  - BigQuery (83 new keys, the bulk of this issue): each of the 7 module-level helpers
    at least once per real branch (`_annotate_math_functions`'s INT64->DOUBLE and
    NUMERIC-preserved branches; `_annotate_date_func`'s literal-string-first-arg and
    typed-first-arg branches; `_annotate_safe_divide`'s both-INT64->DOUBLE and
    NUMERIC/NUMERIC-coerce branches, also proving `SafeDivide`'s own dedicated override
    beats the generic `_annotate_by_args_with_coerce` group it's declared alongside;
    `_annotate_by_args_with_coerce` directly via SafeAdd/PercentileCont;
    `_annotate_by_args_approx_top`; `_annotate_concat`'s STRING and BINARY-input
    branches; `_annotate_array`'s four paths — ARRAY(SELECT col), ARRAY(SELECT AS
    STRUCT ...), ARRAY(SELECT ... UNION ALL ...), and the literal-array fallback to
    `_annotate_by_args(..., array=True)`), plus a representative sample of the
    `returns`/inline-lambda entries across every DType group the table sets
    (BIGINT/BINARY/BOOLEAN/DATETIME/DOUBLE/JSON/TIME/VARCHAR/TIMESTAMPTZ) and the six
    standalone inline-lambda entries (GenerateTimestampArray, JSONFormat's two `to_json`
    branches, JSONKeysAtDepth, JSONValueArray, ToCodePoints).

    PYTHONHASHSEED=0 python3 spike/p7/gen_typing_overlay_family_ref.py \
        > spike/out/typing_overlay_family.json
    node spike/p7/fuzz_typing_overlay_family.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import parse_one  # noqa: E402
from sqlglot.optimizer.annotate_types import annotate_types  # noqa: E402

# Each entry: (name, dialect, sql, schema).
SCENARIOS = [
    # ==================== Postgres (14 entries) ====================
    ("pg-ntile", "postgres", "SELECT NTILE(4) OVER (ORDER BY s.x) FROM t AS s", {"t": {"x": "INT"}}),
    (
        "pg-widthbucket",
        "postgres",
        "SELECT WIDTH_BUCKET(s.x, 0, 10, 5) FROM t AS s",
        {"t": {"x": "INT"}},
    ),
    ("pg-encode", "postgres", "SELECT ENCODE(s.x, 'hex') FROM t AS s", {"t": {"x": "BYTEA"}}),
    ("pg-left", "postgres", "SELECT LEFT(s.x, 3) FROM t AS s", {"t": {"x": "TEXT"}}),
    ("pg-right", "postgres", "SELECT RIGHT(s.x, 3) FROM t AS s", {"t": {"x": "TEXT"}}),
    # Comma-call form (`OVERLAY(x, 'abc', 1)`), not the `PLACING ... FROM` syntax:
    # `_parse_overlay` (the dedicated PLACING/FROM parser hook) is a pre-existing,
    # unrelated `NotPorted` stub (`src/parser.js:6708`) — this form reaches the same
    # `exp.Overlay` node through the generic `FUNCTION_BY_NAME`/`from_arg_list` path,
    # which is already ported, so it stays a real scenario without depending on that
    # gap.
    (
        "pg-overlay",
        "postgres",
        "SELECT OVERLAY(s.x, 'abc', 1) FROM t AS s",
        {"t": {"x": "TEXT"}},
    ),
    ("pg-reverse", "postgres", "SELECT REVERSE(s.x) FROM t AS s", {"t": {"x": "TEXT"}}),
    ("pg-pad", "postgres", "SELECT LPAD(s.x, 5) FROM t AS s", {"t": {"x": "TEXT"}}),
    ("pg-format", "postgres", "SELECT FORMAT('%s', s.x) FROM t AS s", {"t": {"x": "TEXT"}}),
    ("pg-hex", "postgres", "SELECT TO_HEX(s.x) FROM t AS s", {"t": {"x": "INT"}}),
    (
        "pg-splitpart",
        "postgres",
        "SELECT SPLIT_PART(s.x, ',', 1) FROM t AS s",
        {"t": {"x": "TEXT"}},
    ),
    ("pg-normalize", "postgres", "SELECT NORMALIZE(s.x) FROM t AS s", {"t": {"x": "TEXT"}}),
    ("pg-decode", "postgres", "SELECT DECODE(s.x, 'hex') FROM t AS s", {"t": {"x": "TEXT"}}),
    (
        "pg-tonumber",
        "postgres",
        "SELECT TO_NUMBER(s.x, '999') FROM t AS s",
        {"t": {"x": "TEXT"}},
    ),
    # ==================== Redshift (3 overrides on top of Postgres) ====================
    (
        "rs-strtotime",
        "redshift",
        "SELECT TO_TIMESTAMP(s.x, 'YYYYMMDD') FROM t AS s",
        {"t": {"x": "TEXT"}},
    ),
    ("rs-rank", "redshift", "SELECT RANK() OVER (ORDER BY s.x) FROM t AS s", {"t": {"x": "INT"}}),
    (
        "rs-ntile-restores-bigint",
        "redshift",
        "SELECT NTILE(4) OVER (ORDER BY s.x) FROM t AS s",
        {"t": {"x": "INT"}},
    ),
    # ==================== DuckDB (24 entries) ====================
    ("dd-bitlength", "duckdb", "SELECT BIT_LENGTH(s.x) FROM t AS s", {"t": {"x": "VARCHAR"}}),
    (
        "dd-datediff",
        "duckdb",
        "SELECT DATEDIFF('day', s.x, s.y) FROM t AS s",
        {"t": {"x": "DATE", "y": "DATE"}},
    ),
    ("dd-day", "duckdb", "SELECT DAY(s.x) FROM t AS s", {"t": {"x": "DATE"}}),
    ("dd-dayofmonth", "duckdb", "SELECT DAYOFMONTH(s.x) FROM t AS s", {"t": {"x": "DATE"}}),
    ("dd-dayofweek", "duckdb", "SELECT DAYOFWEEK(s.x) FROM t AS s", {"t": {"x": "DATE"}}),
    ("dd-dayofweekiso", "duckdb", "SELECT ISODOW(s.x) FROM t AS s", {"t": {"x": "DATE"}}),
    ("dd-dayofyear", "duckdb", "SELECT DAYOFYEAR(s.x) FROM t AS s", {"t": {"x": "DATE"}}),
    ("dd-extract", "duckdb", "SELECT EXTRACT(YEAR FROM s.x) FROM t AS s", {"t": {"x": "DATE"}}),
    ("dd-hour", "duckdb", "SELECT HOUR(s.x) FROM t AS s", {"t": {"x": "TIMESTAMP"}}),
    ("dd-length", "duckdb", "SELECT LENGTH(s.x) FROM t AS s", {"t": {"x": "VARCHAR"}}),
    ("dd-minute", "duckdb", "SELECT MINUTE(s.x) FROM t AS s", {"t": {"x": "TIMESTAMP"}}),
    ("dd-month", "duckdb", "SELECT MONTH(s.x) FROM t AS s", {"t": {"x": "DATE"}}),
    ("dd-quarter", "duckdb", "SELECT QUARTER(s.x) FROM t AS s", {"t": {"x": "DATE"}}),
    ("dd-second", "duckdb", "SELECT SECOND(s.x) FROM t AS s", {"t": {"x": "TIMESTAMP"}}),
    ("dd-week", "duckdb", "SELECT WEEK(s.x) FROM t AS s", {"t": {"x": "DATE"}}),
    ("dd-year", "duckdb", "SELECT YEAR(s.x) FROM t AS s", {"t": {"x": "DATE"}}),
    ("dd-countif", "duckdb", "SELECT COUNT_IF(s.x > 1) FROM t AS s", {"t": {"x": "INT"}}),
    ("dd-factorial", "duckdb", "SELECT FACTORIAL(s.x) FROM t AS s", {"t": {"x": "INT"}}),
    ("dd-atan2", "duckdb", "SELECT ATAN2(s.x, s.y) FROM t AS s", {"t": {"x": "DOUBLE", "y": "DOUBLE"}}),
    (
        "dd-jarowinkler",
        "duckdb",
        "SELECT JARO_WINKLER_SIMILARITY(s.x, s.y) FROM t AS s",
        {"t": {"x": "VARCHAR", "y": "VARCHAR"}},
    ),
    ("dd-timetounix", "duckdb", "SELECT EPOCH(s.x) FROM t AS s", {"t": {"x": "TIMESTAMP"}}),
    ("dd-format", "duckdb", "SELECT FORMAT('{}', s.x) FROM t AS s", {"t": {"x": "VARCHAR"}}),
    ("dd-reverse", "duckdb", "SELECT REVERSE(s.x) FROM t AS s", {"t": {"x": "VARCHAR"}}),
    ("dd-decode", "duckdb", "SELECT DECODE(s.x) FROM t AS s", {"t": {"x": "BLOB"}}),
    ("dd-encode", "duckdb", "SELECT ENCODE(s.x) FROM t AS s", {"t": {"x": "VARCHAR"}}),
    ("dd-unhex", "duckdb", "SELECT UNHEX(s.x) FROM t AS s", {"t": {"x": "VARCHAR"}}),
    (
        "dd-datebin",
        "duckdb",
        "SELECT DATE_BIN(INTERVAL '1 hour', s.x, s.y) FROM t AS s",
        {"t": {"x": "TIMESTAMP", "y": "TIMESTAMP"}},
    ),
    (
        "dd-percentiledisc",
        "duckdb",
        "SELECT PERCENTILE_DISC(s.x) WITHIN GROUP (ORDER BY s.y) FROM t AS s",
        {"t": {"x": "DOUBLE", "y": "INT"}},
    ),
    ("dd-localtimestamp", "duckdb", "SELECT LOCALTIMESTAMP FROM t AS s", {"t": {"x": "INT"}}),
    ("dd-todays", "duckdb", "SELECT TO_DAYS(s.x) FROM t AS s", {"t": {"x": "INT"}}),
    ("dd-timefromparts", "duckdb", "SELECT MAKE_TIME(1, 2, 3) FROM t AS s", {"t": {"x": "INT"}}),
    # ==================== TSQL (14 entries) ====================
    ("ts-acos", "tsql", "SELECT ACOS(s.x) FROM t AS s", {"t": {"x": "FLOAT"}}),
    ("ts-asin", "tsql", "SELECT ASIN(s.x) FROM t AS s", {"t": {"x": "FLOAT"}}),
    ("ts-atan", "tsql", "SELECT ATAN(s.x) FROM t AS s", {"t": {"x": "FLOAT"}}),
    ("ts-atan2", "tsql", "SELECT ATN2(s.x, s.y) FROM t AS s", {"t": {"x": "FLOAT", "y": "FLOAT"}}),
    ("ts-cos", "tsql", "SELECT COS(s.x) FROM t AS s", {"t": {"x": "FLOAT"}}),
    ("ts-cot", "tsql", "SELECT COT(s.x) FROM t AS s", {"t": {"x": "FLOAT"}}),
    ("ts-sin", "tsql", "SELECT SIN(s.x) FROM t AS s", {"t": {"x": "FLOAT"}}),
    ("ts-tan", "tsql", "SELECT TAN(s.x) FROM t AS s", {"t": {"x": "FLOAT"}}),
    ("ts-soundex", "tsql", "SELECT SOUNDEX(s.x) FROM t AS s", {"t": {"x": "VARCHAR"}}),
    (
        "ts-stuff",
        "tsql",
        "SELECT STUFF(s.x, 1, 2, 'ab') FROM t AS s",
        {"t": {"x": "VARCHAR"}},
    ),
    ("ts-degrees", "tsql", "SELECT DEGREES(s.x) FROM t AS s", {"t": {"x": "FLOAT"}}),
    ("ts-radians", "tsql", "SELECT RADIANS(s.x) FROM t AS s", {"t": {"x": "FLOAT"}}),
    ("ts-currenttimezone", "tsql", "SELECT CURRENT_TIMEZONE() FROM t AS s", {"t": {"x": "INT"}}),
    ("ts-currenttimestamp", "tsql", "SELECT CURRENT_TIMESTAMP FROM t AS s", {"t": {"x": "INT"}}),
    # ==================== BigQuery (83 new keys) ====================
    # --- _annotate_math_functions: INT64 -> FLOAT64, NUMERIC -> preserved ---
    ("bq-math-int64", "bigquery", "SELECT CEIL(s.i) FROM t AS s", {"t": {"i": "INT64"}}),
    ("bq-math-numeric", "bigquery", "SELECT SQRT(s.n) FROM t AS s", {"t": {"n": "NUMERIC"}}),
    # --- by-args "this" group ---
    ("bq-byargs-reverse", "bigquery", "SELECT REVERSE(s.st) FROM t AS s", {"t": {"st": "STRING"}}),
    ("bq-byargs-lower", "bigquery", "SELECT LOWER(s.st) FROM t AS s", {"t": {"st": "STRING"}}),
    # --- _annotate_date_func: literal-string first arg vs typed first arg ---
    (
        "bq-datefunc-literal",
        "bigquery",
        "SELECT DATE_ADD('2020-01-01', INTERVAL 1 DAY)",
        None,
    ),
    (
        "bq-datefunc-typed",
        "bigquery",
        "SELECT DATE_ADD(s.dt, INTERVAL 1 DAY) FROM t AS s",
        {"t": {"dt": "DATETIME"}},
    ),
    (
        "bq-datefunc-tstrunc-literal",
        "bigquery",
        "SELECT TIMESTAMP_TRUNC('2020-01-01 00:00:00', DAY)",
        None,
    ),
    # --- BIGINT group ---
    ("bq-bigint-bytelength", "bigquery", "SELECT BYTE_LENGTH(s.st) FROM t AS s", {"t": {"st": "STRING"}}),
    (
        "bq-bigint-farmfingerprint",
        "bigquery",
        "SELECT FARM_FINGERPRINT(s.st) FROM t AS s",
        {"t": {"st": "STRING"}},
    ),
    # --- BINARY group ---
    ("bq-binary-md5digest", "bigquery", "SELECT MD5(s.st) FROM t AS s", {"t": {"st": "STRING"}}),
    ("bq-binary-sha2digest", "bigquery", "SELECT SHA256(s.st) FROM t AS s", {"t": {"st": "STRING"}}),
    # --- BOOLEAN group ---
    ("bq-boolean-laxbool", "bigquery", "SELECT LAX_BOOL(s.j) FROM t AS s", {"t": {"j": "JSON"}}),
    # --- DATETIME group ---
    (
        "bq-datetime-parsedatetime",
        "bigquery",
        "SELECT PARSE_DATETIME('%F', s.st) FROM t AS s",
        {"t": {"st": "STRING"}},
    ),
    # --- DOUBLE group ---
    (
        "bq-double-cosinedistance",
        "bigquery",
        "SELECT COSINE_DISTANCE(s.a, s.b) FROM t AS s",
        {"t": {"a": "ARRAY<FLOAT64>", "b": "ARRAY<FLOAT64>"}},
    ),
    # --- JSON group. Not JSON_OBJECT: BigQuery's own `JSON_OBJECT` function-name
    # registration is a separate, unrelated parser gap (builds `exp.Anonymous` instead
    # of `exp.JSONObject`) that would exercise the base table's `Anonymous` entry
    # rather than this module's own `JSONObject` key. ---
    ("bq-json-jsonstripnulls", "bigquery", "SELECT JSON_STRIP_NULLS(s.j) FROM t AS s", {"t": {"j": "JSON"}}),
    # --- TIME group ---
    ("bq-time-parsetime", "bigquery", "SELECT PARSE_TIME('%H', s.st) FROM t AS s", {"t": {"st": "STRING"}}),
    # --- VARCHAR group ---
    ("bq-varchar-host", "bigquery", "SELECT HOST(s.st) FROM t AS s", {"t": {"st": "STRING"}}),
    ("bq-varchar-uuid", "bigquery", "SELECT UUID() FROM t AS s", {"t": {"st": "STRING"}}),
    # --- TIMESTAMP_EXPRESSIONS -> TIMESTAMPTZ ---
    ("bq-timestamptz-currenttimestamp", "bigquery", "SELECT CURRENT_TIMESTAMP() FROM t AS s", {"t": {"st": "STRING"}}),
    # --- _annotate_by_args_with_coerce group ---
    ("bq-coerce-safeadd", "bigquery", "SELECT SAFE_ADD(s.i, s.n) FROM t AS s", {"t": {"i": "INT64", "n": "NUMERIC"}}),
    (
        "bq-coerce-percentilecont",
        "bigquery",
        "SELECT PERCENTILE_CONT(s.i, 0.5) OVER () FROM t AS s",
        {"t": {"i": "INT64"}},
    ),
    # --- _annotate_safe_divide (own annotator): both-INT64 -> DOUBLE, else coerce ---
    (
        "bq-safedivide-bothint",
        "bigquery",
        "SELECT SAFE_DIVIDE(s.i, s.i2) FROM t AS s",
        {"t": {"i": "INT64", "i2": "INT64"}},
    ),
    (
        "bq-safedivide-numeric",
        "bigquery",
        "SELECT SAFE_DIVIDE(s.n, s.n2) FROM t AS s",
        {"t": {"n": "NUMERIC", "n2": "NUMERIC"}},
    ),
    # --- array-wrap group (_annotate_by_args this array=True) ---
    (
        "bq-arraywrap-approxquantiles",
        "bigquery",
        "SELECT APPROX_QUANTILES(s.i, 100) FROM t AS s",
        {"t": {"i": "INT64"}},
    ),
    ("bq-arraywrap-split", "bigquery", "SELECT SPLIT(s.st, ',') FROM t AS s", {"t": {"st": "STRING"}}),
    # --- _annotate_by_args_approx_top ---
    ("bq-approxtopk", "bigquery", "SELECT APPROX_TOP_COUNT(s.st, 5) FROM t AS s", {"t": {"st": "STRING"}}),
    # --- _annotate_concat: STRING vs BINARY input ---
    ("bq-concat-string", "bigquery", "SELECT CONCAT(s.a, s.b) FROM t AS s", {"t": {"a": "STRING", "b": "STRING"}}),
    ("bq-concat-binary", "bigquery", "SELECT CONCAT(s.a, s.b) FROM t AS s", {"t": {"a": "BYTES", "b": "BYTES"}}),
    # --- _annotate_array: four paths. Every inner column is qualified (`s.x`, not
    # `x`) per R66's own standing lesson: `scope.table_columns` only picks up a
    # QUALIFIED column reference, so an unqualified one inside the ARRAY(...)
    # subquery never reaches the schema and comes back UNKNOWN on both sides — a
    # wasted scenario, confirmed by running the unqualified form directly against
    # this pinned CPython checkout before locking these in. ---
    (
        "bq-array-select-col",
        "bigquery",
        "SELECT ARRAY(SELECT s.x FROM t AS s)",
        {"t": {"x": "STRING"}},
    ),
    (
        "bq-array-select-struct",
        "bigquery",
        "SELECT ARRAY(SELECT AS STRUCT s.x AS a, s.y AS b FROM t AS s)",
        {"t": {"x": "INT64", "y": "STRING"}},
    ),
    (
        "bq-array-setop",
        "bigquery",
        "SELECT ARRAY(SELECT s.x FROM t AS s UNION ALL SELECT s2.x FROM t AS s2)",
        {"t": {"x": "INT64"}},
    ),
    ("bq-array-literal-fallback", "bigquery", "SELECT [1, 2, 3]", None),
    # --- standalone inline-lambda entries ---
    ("bq-datefromunixdate", "bigquery", "SELECT DATE_FROM_UNIX_DATE(s.i) FROM t AS s", {"t": {"i": "INT64"}}),
    (
        "bq-generatetimestamparray",
        "bigquery",
        "SELECT GENERATE_TIMESTAMP_ARRAY('2020-01-01', '2020-01-02', INTERVAL 1 DAY)",
        None,
    ),
    ("bq-jsonformat-tojsonstring", "bigquery", "SELECT TO_JSON_STRING(s.i) FROM t AS s", {"t": {"i": "INT64"}}),
    ("bq-jsonformat-tojson", "bigquery", "SELECT TO_JSON(s.i) FROM t AS s", {"t": {"i": "INT64"}}),
    ("bq-jsonkeysatdepth", "bigquery", "SELECT JSON_KEYS(s.j, 2) FROM t AS s", {"t": {"j": "JSON"}}),
    # JSONValueArray (py:382-386) is NOT scenario-covered: even a bare
    # `JSON_VALUE_ARRAY(s.j)` with no explicit path builds a default `'$'` `JSONPath`
    # node under the hood (confirmed against this pinned CPython checkout), and
    # `Dialect.to_json_path` (`sqlglot/jsonpath.py`) is a pre-existing, unrelated
    # unported gap — the same one `fuzz_duckdb_dialect.mjs`'s own `to_json_path` cases
    # already name. The table entry itself (`{"returns": DType.ARRAY<VARCHAR>}` via an
    # inline lambda, identical shape to the two scenarios directly above/below it) is
    # not meaningfully different from `JSONKeysAtDepth`'s own already-covered case.
    ("bq-parsebignumeric", "bigquery", "SELECT PARSE_BIGNUMERIC(s.st) FROM t AS s", {"t": {"st": "STRING"}}),
    ("bq-parsenumeric", "bigquery", "SELECT PARSE_NUMERIC(s.st) FROM t AS s", {"t": {"st": "STRING"}}),
    ("bq-tocodepoints", "bigquery", "SELECT TO_CODE_POINTS(s.st) FROM t AS s", {"t": {"st": "STRING"}}),
]


def dump_types(node):
    out = []
    for n in node.walk(bfs=False):
        t = n.type
        out.append([type(n).__name__, t.this.name if t is not None else None])
    return out


def run_one(sql, dialect, schema):
    try:
        ast = parse_one(sql, read=dialect)
        annotated = annotate_types(ast, schema=schema, dialect=dialect)
        return {"ok": dump_types(annotated)}
    except Exception as e:  # noqa: BLE001
        return {"error": type(e).__name__, "message": str(e)}


records = [
    {"name": name, "dialect": dialect, "sql": sql, "schema": schema, "result": run_one(sql, dialect, schema)}
    for name, dialect, sql, schema in SCENARIOS
]

print(json.dumps({"scenarios": records}))
