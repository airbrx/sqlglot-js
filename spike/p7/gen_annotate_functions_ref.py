#!/usr/bin/env python3
"""CPython oracle for `tests/fixtures/optimizer/annotate_functions.sql` (AIR-2315 Part
1), replaying upstream's own `TestOptimizer.test_annotate_funcs` (test_optimizer.py
~:2266) pair-for-pair and dialect-for-dialect against the real `annotate_types()`.

This is the single largest zero-oracle gap `docs/verification/optimizer-fixture-rollup.md`
(R95/AIR-2295) found: 1,932 pairs, 54% of the whole 3,589-pair optimizer corpus, with
no oracle anywhere in spike/p7 or spike/p10 replaying the real fixture file (the 6
`fuzz_annotate_types*.mjs`/`gen_annotate_types*_ref.py` files are named after the same
TypeAnnotator surface but ship their own independent, hand-written corpora -- none
loads this file).

Upstream's test, reproduced exactly (not approximately):

    for i, (meta, sql, expected) in enumerate(load_sql_fixture_pairs(...), start=1):
        dialect = meta.get("dialect") or ""
        sql = f"SELECT {sql} FROM tbl"
        for dialect in dialect.split(", "):
            result = annotate_functions(parse_one(sql, read=dialect),
                                         schema=test_schema, dialect=dialect)
            assertEqual(result.type.sql(dialect),
                        exp.DataType.build(expected, dialect=dialect).sql(dialect))

Two details that are easy to get wrong if you only skim the fixture file:
  - `dialect.split(", ")` on an EMPTY string yields `[""]`, one iteration with the
    default dialect -- not zero iterations. 86 of the 1,932 pairs have no `# dialect:`
    meta at all and still produce exactly one (pair, dialect="") record.
  - The expected string is NOT compared raw. It is re-parsed and re-rendered through
    `exp.DataType.build(expected, dialect=dialect).sql(dialect)` first, which can
    reformat it (e.g. normalize whitespace/casing). This script does that
    normalization once, in Python, and bakes the FINAL normalized string into
    `expected` below -- the JS side only needs byte-for-byte string equality against
    that, it does not need to reimplement `DataType.build`.

Emits one JSON record per (pair index, dialect) -- 2,396 total (1,932 pairs x their
`# dialect:` meta fan-out, verified by direct count against the pin). Each record
carries `upstream_ok`: whether CPython's OWN computed type string equals the
normalized expected string, i.e. whether the committed fixture is internally
consistent at this pin. A false `upstream_ok` would mean the fixture itself is stale
against this pinned commit -- flag it, never "fix" the fixture text to match a buggy
port.

    PYTHONHASHSEED=0 python3 spike/p7/gen_annotate_functions_ref.py > spike/out/annotate_functions.json
    node spike/p7/fuzz_annotate_functions.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import exp, parse_one  # noqa: E402
from sqlglot.optimizer.annotate_types import annotate_types  # noqa: E402
from tests.helpers import load_sql_fixture_pairs  # noqa: E402

# py: tests/test_optimizer.py `test_annotate_funcs`'s own `test_schema` literal.
TEST_SCHEMA = {
    "tbl": {
        "bin_col": "BINARY",
        "str_col": "STRING",
        "bignum_col": "BIGNUMERIC",
        "date_col": "DATE",
        "decfloat_col": "DECFLOAT",
        "float_col": "FLOAT",
        "timestamp_col": "TIMESTAMP",
        "double_col": "DOUBLE",
        "bigint_col": "BIGINT",
        "obj_col": "OBJECT",
        "int_col": "INT",
        "bool_col": "BOOLEAN",
        "bytes_col": "BYTES",
        "interval_col": "INTERVAL",
        "array_col": "ARRAY<STRING>",
    }
}


def run_one(i, title, dialect, raw_sql, raw_expected):
    full_sql = f"SELECT {raw_sql} FROM tbl"
    record = {"i": i, "title": title, "dialect": dialect, "sql": full_sql}

    try:
        expected = exp.DataType.build(raw_expected, dialect=dialect).sql(dialect)
    except Exception as e:  # noqa: BLE001
        record["expected_error"] = f"{type(e).__name__}: {e}"
        expected = None
    record["expected"] = expected

    try:
        ast = parse_one(full_sql, read=dialect)
        # py: test_optimizer.py's local `annotate_functions(expression, **kwargs)`
        # helper -- `annotate_types(expression, dialect=dialect, schema=schema)`
        # then `.expressions[0]`.
        annotated = annotate_types(ast, dialect=dialect, schema=TEST_SCHEMA)
        got = annotated.expressions[0].type.sql(dialect)
        record["got"] = got
        record["upstream_ok"] = expected is not None and got == expected
    except Exception as e:  # noqa: BLE001
        record["got"] = None
        record["error"] = type(e).__name__
        record["message"] = str(e)
        record["upstream_ok"] = False

    return record


records = []
for i, (meta, sql, expected) in enumerate(
    load_sql_fixture_pairs("optimizer/annotate_functions.sql"), start=1
):
    title = meta.get("title") or f"{i}, {sql}"
    dialect_meta = meta.get("dialect") or ""
    for dialect in dialect_meta.split(", "):
        records.append(run_one(i, title, dialect, sql, expected))

inconsistent = [r for r in records if not r["upstream_ok"]]

print(
    json.dumps(
        {
            "records": records,
            "total": len(records),
            "upstream_inconsistent_count": len(inconsistent),
        }
    )
)

if inconsistent:
    sys.stderr.write(
        f"WARNING: {len(inconsistent)} record(s) are upstream-inconsistent at this "
        f"pin (CPython's own computed type != the fixture's normalized expected "
        f"string) -- see 'upstream_inconsistent_count' in the emitted JSON.\n"
    )
