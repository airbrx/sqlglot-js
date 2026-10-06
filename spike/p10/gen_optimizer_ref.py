#!/usr/bin/env python3
"""CPython oracle for `sqlglot/optimizer/optimizer.py` (AIR-2118).

`optimizer.py` is the end-to-end composition of all fourteen already-ported
optimizer rules (`RULES`) through the single `optimize()` entry point. Every rule
has its own prior differential oracle verifying it in isolation; this oracle instead
reproduces `TestOptimizer.test_optimize`'s own real pipeline -- the one place
upstream itself runs the full default `RULES` sequence together -- and asserts the
result against the real fixture file's own quoted "expected" text directly, the same
"reproduce the real test wrapper, not a reduced substitute" shape
`gen_canonicalize_ref.py` (R76) established once `qualify()`/`quote_identifiers`
existed for real.

    optimizer.optimize(parse_one(sql), schema=schema, infer_schema=True,
                        dialect=dialect).sql(pretty=True, dialect=dialect)

`schema` is `test_optimize`'s own LOCAL schema (test_optimizer.py:255-260), not the
bigger `self.schema` other tests in the same file use -- this fixture's own rows never
reference `w`/`temporal`/`structs`/etc, only `x`/`y`/`z`/`u`.

Three real, pre-existing gaps this oracle's own first full run surfaced (not assumed):
mysql rows, a DuckDB-generator-chain-only construct, and a UNION-type-annotation
case -- each recorded below by name/regex so the JS fuzzer can skip or fingerprint
them, not silently fold them into EXACT. See this round's PORT_PLAN.md entry for the
full list with row titles.

    python3 spike/p10/gen_optimizer_ref.py > spike/out/optimizer.json
    node spike/p10/fuzz_optimizer.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-complete-pin")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import optimizer, parse_one  # noqa: E402

# test_optimizer.py:255-260 `test_optimize`'s own LOCAL schema (NOT `self.schema`).
SCHEMA = {
    "x": {"a": "INT", "b": "INT"},
    "y": {"b": "INT", "c": "INT"},
    "z": {"a": "INT", "c": "INT"},
    "u": {"f": "INT", "g": "INT", "h": "TEXT"},
}


# Mirrors `tests/helpers.py`'s `_filter_comments`/`_extract_meta`/`load_sql_fixture_pairs`
# directly (same recipe every other `spike/p10/gen_*_ref.py` already uses), rather than
# importing the `tests` package.
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


def load_pairs(path):
    with open(path, encoding="utf-8") as f:
        statements = _filter_comments(f.read()).split(";")
    size = len(statements)
    for i in range(0, size, 2):
        if i + 1 < size:
            sql = statements[i].strip()
            sql, meta = _extract_meta(sql)
            expected = statements[i + 1].strip()
            yield meta, sql, expected


def fingerprint(ast):
    # (class name, sorted scalar-only args) per node, DFS preorder -- identical
    # recipe to `gen_canonicalize_ref.py`'s own `fingerprint`, reused verbatim rather
    # than re-derived, for the same base-Generator-gap fallback purpose.
    out = []
    for n in ast.dfs():
        scalars = {
            k: v for k, v in n.args.items() if v is None or isinstance(v, (str, int, float, bool))
        }
        out.append([type(n).__name__, {k: scalars[k] for k in sorted(scalars)}])
    return out


def scenario(name, sql, dialect=None, expected=None):
    ast = optimizer.optimize(
        parse_one(sql, read=dialect), schema=SCHEMA, infer_schema=True, dialect=dialect
    )
    output = ast.sql(pretty=True, dialect=dialect)
    if expected is not None:
        # Self-check: this oracle's own pipeline must reproduce the real fixture's
        # documented expectation byte for byte, or the oracle itself -- not
        # optimizer.js -- is wrong.
        assert output == expected, (
            f"{name}: oracle pipeline != fixture expected\n  got:      {output}\n  expected: {expected}"
        )
    return {
        "name": name,
        "sql": sql,
        "dialect": dialect,
        "fingerprint": fingerprint(ast),
        "output": output,
    }


results = []

fixture_path = os.path.join(REF, "tests/fixtures/optimizer/optimizer.sql")
for i, (meta, sql, expected) in enumerate(load_pairs(fixture_path), start=1):
    title = meta.get("title") or f"{i}"
    results.append(scenario(f"fixture-{i}-{title}", sql, meta.get("dialect"), expected))

# test_optimizer.py:253 `test_optimize`'s own inline (non-fixture-file) assertion.
# `schema=None`/no dialect, matching upstream's own call exactly (it passes neither).
r = optimizer.optimize(parse_one("x = 1 + 1"), identify=False)
output = r.sql()
assert output == "x = 2", f"inline assertion: oracle pipeline != expected\n  got: {output}"
results.append({
    "name": "inline-identify-false",
    "sql": "x = 1 + 1",
    "dialect": None,
    "identify_false": True,
    "fingerprint": fingerprint(r),
    "output": output,
})

print(json.dumps(results))
