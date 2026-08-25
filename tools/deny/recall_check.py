#!/usr/bin/env python3
"""False-negative check for corpus/deny/operators.json.

The strict classifier in common.py is tuned to avoid false positives, which
necessarily costs recall. This runs a deliberately *over-broad* pass — flag every
arithmetic/comparison BinOp whose source text so much as mentions an Expr-ish
token — and prints what the strict pass rejected. The delta is small enough to
read, which is the point: it turns "did I miss anything?" from an assertion into
a review.

This exists because the runtime cross-check (tools/deny/instrument_operators.py)
could not be run in this environment; see corpus/deny/FINDINGS.md.

Usage: python3 tools/deny/recall_check.py --ref /tmp/sqlglot-ref-regex \\
           --deny corpus/deny/operators.json
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import is_executor, rel, source_segment, sqlglot_files  # noqa: E402

# Tokens whose presence in an expression's source make an Expr operand plausible.
EXPR_HINTS = (
    "exp.", "expression", "expressions", ".this", ".left", ".right",
    "condition", "column(", "Literal", "paren(", "cast(", "func(",
    "seq_get", "alias_", "to_identifier", "node", "arg",
)

ARITH_OPS = (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod, ast.Pow,
             ast.BitAnd, ast.BitOr)
CMP_OPS = (ast.Lt, ast.LtE, ast.Gt, ast.GtE)
NUMERICISH = {"len", "int", "float", "round", "abs", "ord", "sum", "min", "max",
              "index", "count", "find", "rfind", "bit_length"}


def _is_plainly_numeric(node: ast.AST) -> bool:
    """True when every leaf is a literal or an obviously numeric call."""
    for leaf in ast.walk(node):
        if isinstance(leaf, ast.Call):
            fn = leaf.func
            name = fn.attr if isinstance(fn, ast.Attribute) else getattr(fn, "id", "")
            if name not in NUMERICISH:
                return False
        elif isinstance(leaf, ast.Constant):
            if not isinstance(leaf.value, (int, float)):
                return False
        elif isinstance(leaf, (ast.Name, ast.Attribute, ast.Subscript)):
            return False
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default="/tmp/sqlglot-ref-regex")
    ap.add_argument("--deny", default="corpus/deny/operators.json")
    ap.add_argument("--limit", type=int, default=200)
    args = ap.parse_args()

    doc = json.load(open(args.deny, encoding="utf-8"))
    flagged = {(s["file"], s["line"]) for s in doc["sites"]}

    candidates: list[dict] = []
    for path in sqlglot_files(args.ref):
        relpath = rel(args.ref, path)
        if is_executor(relpath):
            continue
        try:
            tree = ast.parse(open(path, encoding="utf-8").read(), filename=path)
        except (OSError, SyntaxError):
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.BinOp) and isinstance(node.op, ARITH_OPS):
                pass
            elif isinstance(node, ast.Compare) and len(node.ops) == 1 and isinstance(
                node.ops[0], CMP_OPS
            ):
                pass
            else:
                continue
            if (relpath, node.lineno) in flagged:
                continue
            seg = source_segment(path, node)
            if not any(h in seg for h in EXPR_HINTS):
                continue
            if _is_plainly_numeric(node):
                continue
            candidates.append({"py": f"{relpath}:{node.lineno}", "source": seg})

    print(f"strict deny-list: {len(doc['sites'])} sites")
    print(f"over-broad pass, rejected by strict classifier: {len(candidates)}\n")
    for c in candidates[: args.limit]:
        print(f"  {c['py']:46} {c['source'][:104]}")
    if len(candidates) > args.limit:
        print(f"  ... {len(candidates) - args.limit} more")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
