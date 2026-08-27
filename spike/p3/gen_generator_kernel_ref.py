#!/usr/bin/env python3
"""CPython oracle for the P3 generator kernel.

The kernel only has to serve seven parse-path call sites, which the corpus reaches ~30
times. Checking 30 strings would be exactly the narrow-probe mistake P2 made three
times, so instead: walk EVERY node of EVERY AST-oracle tree, and for every node whose
class is in the kernel's supported set, record `node.sql()` at the default dialect.

That turns a 30-sample check into tens of thousands, over real ASTs, and it is the same
set the kernel claims to cover — `fuzz_generator_kernel.mjs` asserts the two sets match
so the kernel cannot quietly grow an unverified case.
"""
import json
import logging
import os
import re
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)
logging.disable(logging.CRITICAL)
import enum  # noqa: E402
from collections import OrderedDict  # noqa: E402

import sqlglot  # noqa: E402
from sqlglot import expressions as exp  # noqa: E402
from sqlglot.dialects.dialect import Dialect  # noqa: E402


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

_OBJ_ADDR_RE = re.compile(r" object at 0x[0-9a-fA-F]+")

# Must equal KERNEL_CLASSES in src/generator_kernel.js.
KERNEL_CLASSES = [
    "Boolean", "Column", "Distinct", "EQ", "From", "Identifier", "Literal",
    "Order", "Ordered", "Select", "Table", "Var", "Where",
]
KERNEL_SET = set(KERNEL_CLASSES)

sql_by_atom = {}
for line in open("corpus/atoms.jsonl"):
    a = json.loads(line)
    sql_by_atom[a["atom_id"]] = (a["read"], a["sql"])

n_trees = 0
n_nodes = 0
for name in sorted(os.listdir("corpus/ast")):
    dialect = name[:-6]
    for line in open(os.path.join("corpus/ast", name)):
        row = json.loads(line)
        entry = sql_by_atom.get(row["atom_id"])
        if entry is None:
            continue
        read, sql = entry
        try:
            tree = sqlglot.parse_one(sql, read=read or None)
        except Exception:  # noqa: BLE001
            continue
        if tree is None:
            continue
        n_trees += 1
        for i, node in enumerate(tree.walk()):
            if type(node).__name__ not in KERNEL_SET:
                continue
            # Only nodes whose WHOLE SUBTREE is in scope. A `Select` containing a
            # HexString is not something the kernel claims to render — demanding it
            # would be testing an invented requirement, and "fixing" it would grow the
            # kernel into the P4 generator one class at a time.
            if any(type(d).__name__ not in KERNEL_SET for d in node.walk()):
                continue
            # Default dialect, non-pretty — exactly what the parse path invokes.
            try:
                out = node.sql()
                err = None
            except Exception as e:  # noqa: BLE001
                out = None
                err = type(e).__name__
            n_nodes += 1
            # The NODE is emitted, not an index into the tree walk. Indexing assumed
            # `astLoad(corpus_ast)` and a fresh `parse_one` produce the same walk — and
            # for 4 of the 15,540 atoms they do not, which misaligned every subsequent
            # node and reported class mismatches that were purely an artefact of the
            # probe.
            print(json.dumps({
                "atom_id": row["atom_id"],
                "dialect": dialect,
                "ast": dump(node),
                "cls": type(node).__name__,
                "sql": out,
                "err": err,
                "repr": _OBJ_ADDR_RE.sub(" object at 0x0", repr(node)),
            }, ensure_ascii=False))

print(f"  {n_nodes} kernel-class nodes across {n_trees} trees", file=sys.stderr)
