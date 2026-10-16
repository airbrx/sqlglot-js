#!/usr/bin/env python3
"""CPython oracle replaying representative Dremio fixtures drawn from
upstream's own `tests/dialects/test_dremio.py` through
`sqlglot.parse(sql, read=<read>).sql(dialect=<write>)`.

AIR-2292 (epic AIR-2272, "12.7 Small dialects", batch B). `gen_dremio_dialect_
ref.py`/`fuzz_dremio_dialect.mjs` cover only the settings surface (Tokenizer
override, scalar settings); neither calls a single PARSER or GENERATOR method.
This file and its JS counterpart (`fuzz_dremio_grammar.mjs`) close that gap for
Dremio's real logic: `DremioGenerator.version_sql`/`datatype_sql`/`cast_sql`,
and `DremioParser`'s `datetype_handler`/`to_char_is_numeric_handler`/
`build_date_delta_with_cast_interval`/`_parse_current_date_utc`.

Each row is `[read_dialect_or_null, sql, write_dialect_or_null]`; `null` means
"dremio" (the default for both sides in upstream's own `Validator` subclass,
which sets `dialect = "dremio"`).

    PYTHONHASHSEED=0 python3 spike/p5/gen_dremio_grammar_ref.py \
        > spike/out/dremio_grammar.json
    node spike/p5/fuzz_dremio_grammar.mjs
"""

import json
import os
import sys

sys.path.insert(0, os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref"))

import sqlglot  # noqa: E402

CASES = [
    # test_type_mappings
    [None, "CAST(x AS SMALLINT)", None],
    [None, "CAST(x AS TINYINT)", None],
    [None, "CAST(x AS BINARY)", None],
    [None, "CAST(x AS TEXT)", None],
    [None, "CAST(x AS NCHAR)", None],
    [None, "CAST(x AS CHAR)", None],
    [None, "CAST(x AS TIMESTAMPNTZ)", None],
    [None, "CAST(x AS DATETIME)", None],
    [None, "CAST(x AS ARRAY)", None],
    [None, "CAST(x AS BIT)", None],
    # test_concat_coalesce
    [None, "SELECT CONCAT('a', NULL)", None],
    # test_null_ordering
    [None, "SELECT * FROM t ORDER BY a NULLS LAST", None],
    [None, "SELECT * FROM t ORDER BY a DESC NULLS LAST", None],
    [None, "SELECT * FROM t ORDER BY a NULLS FIRST", None],
    [None, "SELECT * FROM t ORDER BY a DESC NULLS FIRST", None],
    # test_time_travel
    [None, "SELECT * FROM t AT SNAPSHOT '4132119532727284872'", None],
    [None, "SELECT * FROM t AT TIMESTAMP '2024-01-01 12:00:00.000'", None],
    [None, "SELECT * FROM t AT SNAPSHOT '4132119532727284872' AS a", None],
    ["spark", "SELECT * FROM t VERSION AS OF '123'", None],
    ["trino", "SELECT * FROM t FOR VERSION AS OF '123'", None],
    ["spark", "SELECT * FROM t TIMESTAMP AS OF '2024-01-01'", None],
    # test_convert_timezone
    [None, "SELECT CONVERT_TIMEZONE('America/Chicago', DateColumn)", None],
    [None, "SELECT CONVERT_TIMEZONE('America/Chicago', DateColumn)", ""],
    # test_interval_plural
    [None, "INTERVAL '7' DAYS", None],
    # test_multi_arg_distinct_unsupported
    [None, "SELECT COUNT(DISTINCT a, b) FROM t", None],
    # test_time_mapping
    [
        None,
        "SELECT TO_CHAR(CAST('2025-06-24 12:34:56' AS TIMESTAMP), 'yyyy-mm-dd hh24:mi:ss')",
        None,
    ],
    [
        "postgres",
        "SELECT TO_CHAR(CAST('2025-06-24 12:34:56' AS TIMESTAMP), 'YYYY-MM-DD HH24:MI:SS')",
        None,
    ],
    [
        "duckdb",
        "SELECT STRFTIME(CAST('2025-06-24 12:34:56' AS TIMESTAMP), '%Y-%m-%d %H:%M:%S')",
        None,
    ],
    [
        None,
        "SELECT TO_CHAR(CAST('2025-06-24 12:34:56' AS TIMESTAMP), 'yy-ddd hh24:mi:ss.fff tzd')",
        None,
    ],
    # test_date_add / test_date_sub
    [None, "SELECT DATE_ADD(col, 1)", None],
    [None, "SELECT DATE_ADD(col, CAST(1 AS INTERVAL HOUR))", None],
    [
        None,
        "SELECT DATE_ADD(TIMESTAMP '2022-01-01 12:00:00', CAST(-1 AS INTERVAL HOUR))",
        None,
    ],
    [None, "SELECT DATE_SUB(col, 1)", None],
    [None, "SELECT DATE_SUB(col, CAST(1 AS INTERVAL HOUR))", None],
    [
        None,
        "SELECT DATE_SUB(TIMESTAMP '2022-01-01 12:00:00', CAST(-1 AS INTERVAL HOUR))",
        None,
    ],
    # test_datetime_parsing
    [
        None,
        "SELECT DATE_FORMAT(CAST('2025-08-18 15:30:00' AS TIMESTAMP), 'yyyy-mm-dd')",
        None,
    ],
    # test_array_generate_range
    [None, "ARRAY_GENERATE_RANGE(1, 4)", "duckdb"],
    # test_current_date_utc
    [None, "SELECT CURRENT_DATE_UTC", None],
    [None, "SELECT CURRENT_DATE_UTC()", None],
    # test_repeatstr
    [None, "SELECT REPEAT(x, 5)", None],
    [None, "SELECT REPEATSTR(x, 5)", None],
    # test_regexp_like
    [None, "REGEXP_MATCHES(x, y)", "duckdb"],
    [None, "REGEXP_MATCHES(x, y)", "presto"],
    [None, "REGEXP_MATCHES(x, y)", "hive"],
    [None, "REGEXP_MATCHES(x, y)", None],
    # test_date_part
    [None, "SELECT DATE_PART('YEAR', date '2021-04-01')", None],
    # test_datetype
    [None, "DATETYPE(2024,2,2)", None],
    [None, "DATETYPE(x,y,z)", None],
    # test_regexp_split
    [None, "SELECT REGEXP_SPLIT(tags, ',', 'ALL', 1000) AS t", None],
    # test_try_cast
    [None, "CAST(a AS FLOAT)", None],
    ["", "TRY_CAST(a AS FLOAT)", None],
    ["hive", "CAST(a AS FLOAT)", None],
]

rows = []
for read_dialect, sql, write_dialect in CASES:
    read_dialect = read_dialect if read_dialect is not None else "dremio"
    write_dialect = write_dialect if write_dialect is not None else "dremio"
    row = {"read": read_dialect, "sql": sql, "write": write_dialect}
    try:
        parsed = sqlglot.parse(sql, read=read_dialect)
        row["out"] = parsed[0].sql(dialect=write_dialect)
    except Exception as e:  # noqa: BLE001
        row["error"] = f"{type(e).__name__}: {e}"
    rows.append(row)

print(json.dumps(rows, indent=1))
