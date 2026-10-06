#!/usr/bin/env python3
"""CPython oracle for `sqlglot/optimizer/pushdown_projections.py` (AIR-2111).

Not greenfield: upstream ships a real declarative corpus for it,
`tests/fixtures/optimizer/pushdown_projections.sql` (74 SQL/expected pairs), consumed
by `TestOptimizer.test_pushdown_projection` via `check_file`. That test wraps
`pushdown_projections()` in a small pipeline (`tests/test_optimizer.py:45-49`):

    def pushdown_projections(expression, **kwargs):
        expression = optimizer.qualify_tables.qualify_tables(expression)
        expression = optimizer.qualify_columns.qualify_columns(expression, infer_schema=True, **kwargs)
        expression = optimizer.pushdown_projections.pushdown_projections(expression, **kwargs)
        return expression

-- not `pushdown_projections()` alone, and `qualify_tables` runs with NO kwargs at all
(not even `dialect`), exactly as `check_file`'s own `parse_and_optimize` invokes it.
This oracle reproduces that exact wrapper rather than inventing a narrower one (the
same call `gen_normalize_ref.py`/R68 made for `normalize.sql`): `qualify_tables.js`
(R45-era, greenfield), `qualify_columns.js` (R67, core), and `Resolver`/`Scope`
(R48/R44+R46) are all already ported, so this is a legitimate end-to-end check of
`pushdown_projections.js` itself -- not a hand-invented scenario battery.

`check_file` (`tests/test_optimizer.py:178-`) derives `func_kwargs` per case from
fixture meta: `schema=self.schema` always, plus `dialect=meta["dialect"]` when present
(this fixture has no `leave_tables_isolated`/`validate_qualify_columns`/
`canonicalize_table_aliases` lines, verified by grep, so those three branches never
fire here). The comparison itself is `optimized.sql(pretty=False, dialect=dialect)`
against the fixture's own `expected` text.

    python3 spike/p10/gen_pushdown_projections_ref.py > spike/out/pushdown_projections.json
    node spike/p10/fuzz_pushdown_projections.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-complete-pin")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import optimizer, parse_one  # noqa: E402

# Mirrors `tests/helpers._filter_comments`/`_extract_meta`/`load_sql_fixture_pairs`
# directly (same reimplementation `gen_normalize_ref.py` already uses), so this script
# has no import-path dependency on how the pinned checkout's own test suite is laid out.


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


# py: tests/test_optimizer.py:132-172 `self.schema`, the exact schema
# `test_pushdown_projection` runs `check_file("pushdown_projections", ...)` against.
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
    "unpivotable": {"id": "INT", "jan": "INT", "feb": "INT", "north": "INT", "south": "INT"},
    "pivotable": {"id": "INT", "cat": "TEXT", "val": "INT", "kind": "TEXT", "amt": "INT"},
}


# py: tests/test_optimizer.py:45-49 `pushdown_projections` test wrapper.
def pushdown_projections_pipeline(expression, **kwargs):
    expression = optimizer.qualify_tables.qualify_tables(expression)
    expression = optimizer.qualify_columns.qualify_columns(expression, infer_schema=True, **kwargs)
    expression = optimizer.pushdown_projections.pushdown_projections(expression, **kwargs)
    return expression


# These 3 fixture pairs reach base-`Generator` methods that are pre-existing
# `NotPorted` stubs in THIS port's `src/generator.js` (`cube_sql`, `in_unnest_op`, and
# `JSONPathKey`'s missing TRANSFORMS entry) -- unrelated to `pushdown_projections.js`
# itself (the AST `pushdown_projections()` produces is unaffected; only rendering it
# back to SQL text fails), the same "structural check instead of .sql()" treatment
# `gen_qualify_columns_ref.py`'s own `STRUCTURAL` set already established. `repr(expr)`
# is Python's `Expression.__repr__`, a pure structural dump that never calls the SQL
# generator; this port's `Expr.toString()` is the verified byte-exact equivalent (R21).
STRUCTURAL_IDS = {35, 50, 73}

results = {"fixtures": []}

fixture_path = os.path.join(REF, "tests/fixtures/optimizer/pushdown_projections.sql")
for i, (meta, sql, expected) in enumerate(load_sql_fixture_pairs(fixture_path), start=1):
    dialect = meta.get("dialect")
    title = meta.get("title") or f"{i}, {sql}"

    kwargs = {"schema": SCHEMA}
    if dialect:
        kwargs["dialect"] = dialect

    try:
        expression = parse_one(sql, read=dialect)
        optimized = pushdown_projections_pipeline(expression, **kwargs)
        record = {"id": i, "title": title, "sql": sql, "dialect": dialect, "expected": expected}
        if i in STRUCTURAL_IDS:
            record["computed_repr"] = repr(optimized)
        else:
            record["computed"] = optimized.sql(pretty=False, dialect=dialect)
        results["fixtures"].append(record)
    except Exception as e:  # noqa: BLE001 -- oracle: capture, don't crash the harness
        results["fixtures"].append(
            {
                "id": i,
                "title": title,
                "sql": sql,
                "dialect": dialect,
                "expected": expected,
                "error": type(e).__name__,
                "message": str(e),
            }
        )

print(json.dumps(results))
