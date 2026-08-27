#!/usr/bin/env python3
"""CPython oracle for optimizer Tier A's `walk_in_scope` traversal ORDER.

The scope-boundary rules (CTE / derived table / UDTF / UNWRAPPED_QUERIES) are subtle and
order-sensitive, and `find_in_scope` returns the FIRST match — so an order bug is a
wrong answer, not a cosmetic difference. Run over every AST-oracle row rather than a
handful of hand-written queries.

Keyed by `atom_id` and driven by `parse_one`, so the JS side can reconstruct the SAME
tree with `astLoad(corpus/ast/<dialect>.jsonl)` and compare without needing a working
JS parser — which is the point, since at P3's blocking step most `_parse_*` are stubs.
"""
import json
import logging
import os
import re
import sys

# Same normalization tools/astdump.py:36 applies. A `DataType` can carry a Dialect
# INSTANCE as an arg (clickhouse `JSON`), and `repr()` of that embeds a heap address, so
# an un-normalized oracle diverges from itself between runs.
_OBJ_ADDR_RE = re.compile(r" object at 0x[0-9a-fA-F]+")

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)
logging.disable(logging.CRITICAL)
import enum  # noqa: E402
from collections import OrderedDict  # noqa: E402

import sqlglot  # noqa: E402
from sqlglot import expressions as exp  # noqa: E402
from sqlglot.dialects.dialect import Dialect  # noqa: E402
from sqlglot.optimizer.scope import find_in_scope, walk_in_scope  # noqa: E402


def dump(node):
    """Same encoding as tools/astdump.py, so the JS side can `astLoad` it directly."""
    if isinstance(node, exp.Expr):
        out = OrderedDict()
        out["c"] = type(node).__name__
        out["a"] = [[k, dump(v)] for k, v in node.args.items()]
        meta = node._meta
        out["m"] = dict(meta) if meta else None
        out["cm"] = list(node.comments) if node.comments else None
        node_type = node.type
        out["t"] = dump(node_type) if (node_type is not None and not node.is_data_type) else None
        return out
    if isinstance(node, list):
        return [dump(v) for v in node]
    if isinstance(node, tuple):
        return {"__tuple__": [dump(v) for v in node]}
    if isinstance(node, bool) or node is None:
        return node
    if isinstance(node, (str, int, float)):
        return node
    if isinstance(node, enum.Enum):
        return {"__enum__": type(node).__name__, "name": node.name, "value": node.value}
    if isinstance(node, type):
        return {"__type__": node.__name__}
    if isinstance(node, Dialect):
        return {"__dialect__": type(node).__name__}
    return {"__unknown__": repr(node), "__pytype__": type(node).__name__}

# The pair `parser.py:8675` actually looks for, plus broader ones to widen coverage.
PROBE_TYPES = [
    ("ignore_respect", (exp.IgnoreNulls, exp.RespectNulls)),
    ("column", (exp.Column,)),
    ("select", (exp.Select,)),
    ("subquery", (exp.Subquery,)),
]

sql_by_atom = {}
for line in open("corpus/atoms.jsonl"):
    a = json.loads(line)
    sql_by_atom[a["atom_id"]] = (a["read"], a["sql"])

n = 0
missing = 0
for name in sorted(os.listdir("corpus/ast")):
    dialect = name[:-6]
    for line in open(os.path.join("corpus/ast", name)):
        row = json.loads(line)
        entry = sql_by_atom.get(row["atom_id"])
        if entry is None:
            missing += 1
            continue
        read, sql = entry
        try:
            tree = sqlglot.parse_one(sql, read=read or None)
        except Exception:  # noqa: BLE001
            continue
        if tree is None:
            continue
        n += 1
        finds = {}
        for probe, types in PROBE_TYPES:
            hit = find_in_scope(tree, *types)
            finds[probe] = None if hit is None else _OBJ_ADDR_RE.sub(" object at 0x0", repr(hit))
        # The walked TREE is emitted, not just its atom_id. Re-parsing the atom's SQL
        # to rebuild it on the JS side would have been the obvious shortcut, and it is
        # wrong: 4 of the 15,540 committed AST rows are not reproduced by a fresh
        # parse_one at the pinned commit (all `UNION ... ORDER BY ... LIMIT`, where the
        # corpus records `limit` before `order`). Emitting the tree removes the
        # assumption entirely — both sides walk the same nodes by construction.
        print(json.dumps({
            "atom_id": row["atom_id"],
            "dialect": dialect,
            "ast": dump(tree),
            "order": [type(x).__name__ for x in walk_in_scope(tree)],
            "finds": finds,
        }, ensure_ascii=False))

print(f"  {n} trees walked ({missing} ast rows had no atom)", file=sys.stderr)
