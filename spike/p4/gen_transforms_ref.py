#!/usr/bin/env python3
"""CPython oracle for the P4-transforms functions.

  python3 spike/p4/gen_transforms_ref.py > spike/out/transforms.json
  node spike/p4/fuzz_transforms.mjs

`src/transforms.js` is greenfield and unreachable from the generate-oracle corpus (see
its own file header and PORT_PLAN.md R26): every consuming row also needs a dialect's
own `Generator` subclass, which does not exist in this port yet. This is the honest
differential signal instead — parse a curated SQL case with CPython, apply the real
`sqlglot.transforms` function to it, and dump the resulting tree losslessly (same `dump`
shape `tools/astdump.py` uses: an ORDERED `[key, value]` array per node, keeping `None`
and `[]`, plus `repr()` so a JS-side mismatch is provably a generator-shaped tree bug and
not a dump-format coincidence).
"""
import json
import os
import re
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)
os.chdir(REF)

import sqlglot  # noqa: E402
from sqlglot import exp, transforms  # noqa: E402

_OBJ_ADDR_RE = re.compile(r" object at 0x[0-9a-fA-F]+")


def dump(node):
    if isinstance(node, exp.Expr):
        return {
            "c": type(node).__name__,
            "a": [[k, dump(v)] for k, v in node.args.items()],
            "m": dict(node._meta) if node._meta else None,
            "cm": list(node.comments) if node.comments else None,
        }
    if isinstance(node, list):
        return [dump(v) for v in node]
    if isinstance(node, tuple):
        return {"__tuple__": [dump(v) for v in node]}
    return node


CASES = [
    # ---- eliminate_distinct_on ------------------------------------------------
    {"fn": "eliminate_distinct_on", "sql": "SELECT DISTINCT ON (a) a, b FROM t"},
    {
        "fn": "eliminate_distinct_on",
        "sql": "SELECT DISTINCT ON (a) a, b FROM t ORDER BY b DESC",
    },
    {"fn": "eliminate_distinct_on", "sql": "SELECT DISTINCT ON (a, b) * FROM t"},
    {
        "fn": "eliminate_distinct_on",
        "sql": "SELECT DISTINCT ON (a) t.a AS x, b FROM t",
    },
    {"fn": "eliminate_distinct_on", "sql": "SELECT a, b FROM t"},
    {"fn": "eliminate_distinct_on", "sql": "SELECT DISTINCT a, b FROM t"},
    # ---- eliminate_qualify ------------------------------------------------------
    {
        "fn": "eliminate_qualify",
        "sql": (
            "SELECT a, ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) AS rn "
            "FROM t QUALIFY rn = 1"
        ),
    },
    {
        "fn": "eliminate_qualify",
        "sql": (
            "SELECT a, b FROM t "
            "QUALIFY ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) = 1"
        ),
    },
    {
        "fn": "eliminate_qualify",
        "sql": (
            "SELECT * FROM t "
            "QUALIFY ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) = 1"
        ),
    },
    {"fn": "eliminate_qualify", "sql": "SELECT a AS x FROM t QUALIFY x > 1"},
    {"fn": "eliminate_qualify", "sql": "SELECT a FROM t QUALIFY b > 1"},
    {"fn": "eliminate_qualify", "sql": "SELECT a FROM t WHERE a > 1"},
    # ---- eliminate_semi_and_anti_joins ------------------------------------------
    {
        "fn": "eliminate_semi_and_anti_joins",
        "sql": "SELECT * FROM a LEFT SEMI JOIN b ON a.id = b.id",
    },
    {
        "fn": "eliminate_semi_and_anti_joins",
        "sql": "SELECT * FROM a LEFT ANTI JOIN b ON a.id = b.id",
    },
    {
        "fn": "eliminate_semi_and_anti_joins",
        "sql": (
            "SELECT * FROM a "
            "LEFT SEMI JOIN b ON a.id = b.id "
            "LEFT ANTI JOIN c ON a.id = c.id"
        ),
    },
    {
        "fn": "eliminate_semi_and_anti_joins",
        "sql": "SELECT * FROM a JOIN b ON a.id = b.id",
    },
]

out = []
for case in CASES:
    fn = getattr(transforms, case["fn"])
    tree = sqlglot.parse_one(case["sql"])
    result = fn(tree)
    out.append(
        {
            "fn": case["fn"],
            "sql": case["sql"],
            "dump": dump(result),
            "repr": _OBJ_ADDR_RE.sub("", repr(result)),
            "resql": result.sql(),
        }
    )

print(json.dumps(out))
