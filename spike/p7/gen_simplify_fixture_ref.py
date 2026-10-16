#!/usr/bin/env python3
"""CPython oracle for `tests/fixtures/optimizer/simplify.sql` (AIR-2315 Part 2),
replaying upstream's own `TestOptimizer.test_simplify` (test_optimizer.py ~:1249)
pair-for-pair against the real fixture file.

`test_simplify` calls `self.check_file("simplify", simplify, schema=self.schema)` --
note that `simplify` here is test_optimizer.py's own LOCAL wrapper (~:63), NOT
`sqlglot.optimizer.simplify.simplify` directly:

    def simplify(expression, **kwargs):
        dialect = kwargs.get("dialect")
        schema = kwargs.get("schema")
        expression = annotate_types(expression, schema=schema, dialect=dialect)
        return optimizer.simplify.simplify(
            expression, constant_propagation=True, coalesce_simplification=True, dialect=dialect
        )

It annotates types FIRST (constant folding over typed literals -- e.g. DATE/INTERVAL
arithmetic -- depends on this), then runs the real `Simplifier` with
`constant_propagation=True, coalesce_simplification=True` (both default False in the
bare `simplify()` entry point `spike/p7/gen_simplify_ref.py`'s hand-built battery
already exercises -- this file's wrapper always turns both on).

`check_file`'s own generic driver (test_optimizer.py ~:178), reproduced exactly:

    for i, (meta, sql, expected) in enumerate(load_sql_fixture_pairs(...), start=1):
        dialect = meta.get("dialect")       # scalar -- no `, `-separated fan-out like
                                             # annotate_functions.sql's own meta shape
        func_kwargs = {"schema": self.schema}
        if dialect:
            func_kwargs["dialect"] = dialect
        optimized = simplify(parse_one(sql, read=dialect), **func_kwargs)
        actual = optimized.sql(pretty=False, dialect=dialect)   # check_file's own
                                                                  # pretty=False default;
                                                                  # test_simplify never
                                                                  # overrides it
        assertEqual(expected, actual)

521 pairs total; 61 carry a `# dialect:` meta key (verified against the pin: `bigquery,
clickhouse, duckdb, mysql, postgres, redshift, snowflake, spark, sqlite, tsql`, no
comma-separated multi-dialect metas), so this oracle emits exactly one record per pair
(521 total), not pair x dialect like `gen_annotate_functions_ref.py`.

Unlike `annotate_functions.sql`'s `DataType.build(...)`-normalized comparison, nothing
here re-normalizes `expected` -- `check_file`'s own `assertEqual(expected, actual)` is
a plain string compare against the raw fixture text (already `.strip()`-ed by
`_extract_meta`/`load_sql_fixture_pairs`). This script records CPython's own computed
`got` and `upstream_ok` (`got == expected`) purely as a self-consistency signal; a false
`upstream_ok` would mean the fixture itself is stale against this pinned commit --
flag it, never "fix" the fixture text to match a buggy port.

    PYTHONHASHSEED=0 python3 spike/p7/gen_simplify_fixture_ref.py > spike/out/simplify_fixture.json
    node spike/p7/fuzz_simplify_fixture.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)
os.chdir(REF)

# Fail infrastructure loudly: upstream catches missing optional dateutil and silently
# declines date folds, creating a different oracle on clean CI hosts (see the
# hand-built `gen_simplify_ref.py`'s own identical guard).
from dateutil.relativedelta import relativedelta  # noqa: F401, E402

from sqlglot import optimizer, parse_one  # noqa: E402
from sqlglot.optimizer.annotate_types import annotate_types  # noqa: E402
from tests.helpers import load_sql_fixture_pairs  # noqa: E402

# py: tests/test_optimizer.py `TestOptimizer.setUp`'s own `self.schema` literal.
TEST_SCHEMA = {
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


def simplify(expression, **kwargs):
    # py: test_optimizer.py's own local `simplify(expression, **kwargs)` helper --
    # the function `test_simplify` actually passes to `check_file`, NOT
    # `optimizer.simplify.simplify` directly.
    dialect = kwargs.get("dialect")
    schema = kwargs.get("schema")
    expression = annotate_types(expression, schema=schema, dialect=dialect)
    return optimizer.simplify.simplify(
        expression, constant_propagation=True, coalesce_simplification=True, dialect=dialect
    )


def run_one(i, title, dialect, sql, expected):
    record = {"i": i, "title": title, "dialect": dialect, "sql": sql, "expected": expected}
    try:
        func_kwargs = {"schema": TEST_SCHEMA}
        if dialect:
            func_kwargs["dialect"] = dialect
        ast = parse_one(sql, read=dialect)
        optimized = simplify(ast, **func_kwargs)
        actual = optimized.sql(pretty=False, dialect=dialect)
        record["got"] = actual
        record["upstream_ok"] = actual == expected
    except Exception as e:  # noqa: BLE001
        record["got"] = None
        record["error"] = type(e).__name__
        record["message"] = str(e)
        record["upstream_ok"] = False
    return record


records = []
for i, (meta, sql, expected) in enumerate(
    load_sql_fixture_pairs("optimizer/simplify.sql"), start=1
):
    title = meta.get("title") or f"{i}, {sql}"
    dialect = meta.get("dialect")
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
        f"pin (CPython's own `test_simplify` wrapper output != the fixture's expected "
        f"string) -- see 'upstream_inconsistent_count' in the emitted JSON.\n"
    )
