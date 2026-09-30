#!/usr/bin/env python3
"""CPython oracle for `sqlglot/optimizer/normalize.py`.

Unlike the P7 optimizer modules (`optimize_joins.js`, `resolver.js`,
`unnest_subqueries.js` -- see their own `gen_*_ref.py` headers), `normalize.py` is NOT
greenfield: upstream ships a real declarative corpus for it,
`tests/fixtures/optimizer/normalize.sql` (25 SQL/expected pairs), consumed by
`TestOptimizer.test_normalize` via `check_file`. That test wraps `normalize()` in a
small pipeline (`tests/test_optimizer.py:55-59`):

    def normalize(expression, **kwargs):
        expression = optimizer.normalize.normalize(expression, dnf=False)
        expression = annotate_types(expression, schema=schema)
        return optimizer.simplify.simplify(expression)

-- not `normalize()` alone. This oracle reproduces that exact wrapper (both
`annotate_types.js` and `simplify.js` are already ported, so this is a legitimate
end-to-end check of `normalize.js` in the same harness upstream uses for it, not a
hand-invented one) and dumps the resulting `.sql()` for each fixture pair, so the JS
side's ONE POINT OF FAILURE is `normalize.js` itself (`annotate_types`/`simplify` are
independently verified elsewhere, P7).

Also captures, directly against `optimizer.normalize`:
  - the three `test_normalize` inline assertions (`test_optimizer.py:362-386`): plain
    CNF, `dnf=True`, and the Snowflake BOOLXOR/Xor-arity scenario (a Connector with a
    THIRD arg, `round_input`, so `unpack` via 3 values forces `_predicate_lengths` to
    recurse into the Xor node itself rather than treat it as an opaque predicate)
  - the three `test_normalization_distance` scenarios (`test_optimizer.py:3195-3201`),
    run directly against `normalization_distance` (no annotate_types/simplify --
    that test doesn't build a full expression pipeline, just measures distance)

Unlike every other gen_*_ref.py in this repo, this script's DEFAULT `SQLGLOT_REF` is
the COMPLETE checkout, not the lean one: `/tmp/sqlglot-ref` has no
`tests/fixtures/optimizer/normalize.sql` at all (verified -- its `tests/fixtures/
optimizer/` only carries `tpc-ds`/`tpc-h`), so this oracle is fixture-dependent by
construction and the lean ref cannot serve it, unlike scripts whose corpus is
hand-written in Python itself.

    python3 spike/p10/gen_normalize_ref.py > spike/out/normalize.json
    node spike/p10/fuzz_normalize.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-complete-pin")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import parse_one  # noqa: E402
from sqlglot.optimizer import normalize as normalize_mod  # noqa: E402
from sqlglot.optimizer.annotate_types import annotate_types  # noqa: E402
from sqlglot.optimizer.simplify import simplify  # noqa: E402

# Mirrors `tests/helpers._filter_comments`/`_extract_meta`/`load_sql_fixture_pairs`
# directly rather than importing the `tests` package, so this script has no
# import-path dependency on how the pinned checkout's own test suite is laid out.


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


# py: tests/test_optimizer.py:132-172 `self.schema`, the exact schema `test_normalize`
# runs `check_file("normalize", ...)` against.
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


def normalize_pipeline(sql, read_dialect=None):
    expression = parse_one(sql, read=read_dialect)
    expression = normalize_mod.normalize(expression, dnf=False)
    expression = annotate_types(expression, schema=SCHEMA)
    return simplify(expression).sql()


results = {"fixtures": [], "assertions": [], "distances": []}

fixture_path = os.path.join(REF, "tests/fixtures/optimizer/normalize.sql")
for i, (meta, sql, expected) in enumerate(load_sql_fixture_pairs(fixture_path), start=1):
    dialect = meta.get("dialect")
    try:
        computed = normalize_pipeline(sql, dialect)
        results["fixtures"].append(
            {"id": i, "sql": sql, "dialect": dialect, "expected": expected, "computed": computed}
        )
    except Exception as e:  # noqa: BLE001 -- oracle: capture, don't crash the harness
        results["fixtures"].append(
            {"id": i, "sql": sql, "dialect": dialect, "expected": expected, "error": str(e)}
        )

# py: tests/test_optimizer.py:362-386 `test_normalize`'s three inline assertions.
ASSERTIONS = [
    ("cnf-plain-a-and-yorz", "x AND (y OR z)", None, False),
    ("dnf-plain-a-and-yorz", "x AND (y OR z)", None, True),
    ("snowflake-boolxor", "(a AND b) OR BOOLXOR(x, y)", "snowflake", False),
]
for name, sql, dialect, dnf in ASSERTIONS:
    expression = parse_one(sql, read=dialect)
    out = normalize_mod.normalize(expression, dnf=dnf).sql(dialect=dialect)
    results["assertions"].append({"name": name, "sql": sql, "dialect": dialect, "dnf": dnf, "sql_out": out})

# py: tests/test_optimizer.py:3195-3201 `test_normalization_distance`'s three scenarios.
for depth in (2, 3, 10):
    expr = parse_one(" OR ".join("a AND b" for _ in range(depth)))
    dist = normalize_mod.normalization_distance(expr, max_=100)
    results["distances"].append({"depth": depth, "distance": dist})

print(json.dumps(results, indent=2))
