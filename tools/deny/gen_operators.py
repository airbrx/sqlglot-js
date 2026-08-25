#!/usr/bin/env python3
"""Generate corpus/deny/operators.json — PORT_PLAN.md §4.6, §7 P0 item 8.

Every site inside `sqlglot/` where a Python operator is applied to an `Expr` and
therefore *builds an AST node* instead of computing a value. JS has no operator
overloading, so a transliteration that keeps the `-` produces a number (or a
TypeError) where Python produced `exp.Sub`. `dialect.py` has the canonical
example:

    exp.Length(this=...) - exp.paren(expression.expression - 1)

Two independent passes, because neither alone is trustworthy:

  static   an AST walk with annotation-driven type inference (tools/deny/common.py).
           Complete over the source, but a dynamically typed codebase means some
           verdicts are inferred rather than certain.
  runtime  tools/deny/instrument_operators.py monkeypatches the operator dunders
           on `exp.Expression` and runs upstream's own unittest suite, recording
           the caller's file:line. Certain, but only covers what the suite reaches.

The emitted JSON carries both verdicts per site, so "found by static analysis
only" and "observed executing" are distinguishable. That distinction matters: a
static-only site is a lint target, a runtime-confirmed site is a proven hazard.

Usage:
    python3 tools/deny/gen_operators.py --ref /tmp/sqlglot-ref-regex \\
        --out corpus/deny/operators.json [--runtime build/deny/runtime_operators.json]
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import (  # noqa: E402
    KIND_EXPR,
    ExprKnowledge,
    ExprTyper,
    ModuleImports,
    is_executor,
    owning_scope,
    rel,
    source_line,
    source_segment,
    sqlglot_files,
)

# ast node -> the dunder Python actually dispatches to. `and`/`or` (ast.BoolOp)
# are deliberately absent: they use __bool__, not __and__/__or__, and conflating
# them would put ~900 false entries in the list.
BINOP_DUNDER = {
    ast.Add: "__add__",
    ast.Sub: "__sub__",
    ast.Mult: "__mul__",
    ast.Div: "__truediv__",
    ast.FloorDiv: "__floordiv__",
    ast.Mod: "__mod__",
    ast.Pow: "__pow__",
    ast.BitAnd: "__and__",
    ast.BitOr: "__or__",
}
UNARY_DUNDER = {ast.USub: "__neg__", ast.Invert: "__invert__"}
CMP_DUNDER = {
    ast.Lt: "__lt__",
    ast.LtE: "__le__",
    ast.Gt: "__gt__",
    ast.GtE: "__ge__",
}
# __eq__/__ne__ return bool rather than a node, so they are a §4.5 concern
# (equality/hashing), not an operator-overload deny-list entry.


def analyse(ref: str) -> tuple[list[dict], dict]:
    knowledge = ExprKnowledge(ref)
    findings: list[dict] = []
    stats = {
        "files_scanned": 0,
        "binop_nodes": 0,
        "unary_nodes": 0,
        "compare_nodes": 0,
        "subscript_nodes": 0,
        "augassign_nodes": 0,
    }

    for path in sqlglot_files(ref):
        relpath = rel(ref, path)
        try:
            tree = ast.parse(open(path, encoding="utf-8").read(), filename=path)
        except (OSError, SyntaxError):
            continue
        stats["files_scanned"] += 1

        imports = ModuleImports(tree, relpath)
        owner = owning_scope(tree)
        typers: dict[int, ExprTyper] = {}

        def typer_for(node: ast.AST) -> ExprTyper:
            scope = owner.get(id(node), tree)
            if id(scope) not in typers:
                typers[id(scope)] = ExprTyper(knowledge, imports, scope, relpath)
            return typers[id(scope)]

        def as_expr(tp: ExprTyper, node: ast.AST):
            """Only a value that IS an Expr dispatches to the operator dunders;
            a container of Exprs does not."""
            v = tp.classify(node)
            if v is None or v[0] != KIND_EXPR:
                return None
            return (v[1], v[2])

        for node in ast.walk(tree):
            entry = None

            if isinstance(node, ast.BinOp):
                stats["binop_nodes"] += 1
                dunder = BINOP_DUNDER.get(type(node.op))
                if dunder is None:
                    continue
                tp = typer_for(node)
                left = as_expr(tp, node.left)
                right = as_expr(tp, node.right)
                if left is None and right is None:
                    continue
                # Python dispatches to the reflected form when only the RIGHT
                # operand is the Expr: `1 - expr` calls expr.__rsub__(1).
                if left is None:
                    dunder = "__r" + dunder[2:]
                conf, reason = left or right  # type: ignore[misc]
                entry = {
                    "op": _op_symbol(node.op),
                    "dunder": dunder,
                    "builds": _node_for(dunder),
                    "confidence": conf,
                    "why": reason,
                    "operands": {
                        "left": "Expr" if left else "other",
                        "right": "Expr" if right else "other",
                    },
                }

            elif isinstance(node, ast.AugAssign):
                stats["augassign_nodes"] += 1
                dunder = BINOP_DUNDER.get(type(node.op))
                if dunder is None:
                    continue
                tp = typer_for(node)
                target = as_expr(tp, node.target)
                value = as_expr(tp, node.value)
                if target is None and value is None:
                    continue
                conf, reason = target or value  # type: ignore[misc]
                entry = {
                    "op": _op_symbol(node.op) + "=",
                    "dunder": dunder,
                    "builds": _node_for(dunder),
                    "confidence": conf,
                    "why": f"augmented assignment over {reason}",
                    "operands": {
                        "left": "Expr" if target else "other",
                        "right": "Expr" if value else "other",
                    },
                }

            elif isinstance(node, ast.UnaryOp):
                stats["unary_nodes"] += 1
                dunder = UNARY_DUNDER.get(type(node.op))
                if dunder is None:
                    continue
                tp = typer_for(node)
                operand = as_expr(tp, node.operand)
                if operand is None:
                    continue
                entry = {
                    "op": "-" if dunder == "__neg__" else "~",
                    "dunder": dunder,
                    "builds": _node_for(dunder),
                    "confidence": operand[0],
                    "why": operand[1],
                    "operands": {"operand": "Expr"},
                }

            elif isinstance(node, ast.Compare):
                stats["compare_nodes"] += 1
                if len(node.ops) != 1:
                    continue
                dunder = CMP_DUNDER.get(type(node.ops[0]))
                if dunder is None:
                    continue
                tp = typer_for(node)
                left = as_expr(tp, node.left)
                right = as_expr(tp, node.comparators[0])
                if left is None and right is None:
                    continue
                conf, reason = left or right  # type: ignore[misc]
                entry = {
                    "op": _op_symbol(node.ops[0]),
                    "dunder": dunder,
                    "builds": _node_for(dunder),
                    "confidence": conf,
                    "why": reason,
                    "operands": {
                        "left": "Expr" if left else "other",
                        "right": "Expr" if right else "other",
                    },
                }

            elif isinstance(node, ast.Subscript):
                stats["subscript_nodes"] += 1
                tp = typer_for(node)
                # Only flag when the subscripted value IS an Expr: `expr[key]`
                # is Expr.__getitem__ and builds a Bracket. Indexing a *container*
                # of Exprs (`expression.expressions[0]`) is ordinary indexing and
                # is not a hazard — `as_expr` already rejects that case.
                value = as_expr(tp, node.value)
                if value is None:
                    continue
                # Expr.__getitem__ does `convert(e) for e in ensure_list(other)`
                # (expressions/core.py:1409), which cannot accept a slice object.
                # A slice subscript is therefore never Expr.__getitem__.
                if isinstance(node.slice, ast.Slice):
                    continue
                if value[1].startswith("Bracket from"):
                    continue
                entry = {
                    "op": "[]",
                    "dunder": "__getitem__",
                    "builds": "exp.Bracket",
                    "confidence": value[0],
                    "why": value[1],
                    "operands": {"value": "Expr"},
                }

            if entry is None:
                continue

            entry.update(
                {
                    "py": f"{relpath}:{node.lineno}",
                    "file": relpath,
                    "line": node.lineno,
                    "col": node.col_offset,
                    "source": source_segment(path, node),
                    "statement": source_line(path, node.lineno),
                    "executor": is_executor(relpath),
                    "found_by": ["static"],
                }
            )
            findings.append(entry)

    findings.sort(key=lambda e: (e["file"], e["line"], e["col"]))
    return findings, stats


def _op_symbol(op: ast.AST) -> str:
    return {
        ast.Add: "+", ast.Sub: "-", ast.Mult: "*", ast.Div: "/",
        ast.FloorDiv: "//", ast.Mod: "%", ast.Pow: "**",
        ast.BitAnd: "&", ast.BitOr: "|",
        ast.Lt: "<", ast.LtE: "<=", ast.Gt: ">", ast.GtE: ">=",
    }.get(type(op), "?")


def _node_for(dunder: str) -> str:
    return {
        "__add__": "exp.Add", "__radd__": "exp.Add",
        "__sub__": "exp.Sub", "__rsub__": "exp.Sub",
        "__mul__": "exp.Mul", "__rmul__": "exp.Mul",
        "__truediv__": "exp.Div", "__rtruediv__": "exp.Div",
        "__floordiv__": "exp.IntDiv", "__rfloordiv__": "exp.IntDiv",
        "__mod__": "exp.Mod", "__rmod__": "exp.Mod",
        "__pow__": "exp.Pow", "__rpow__": "exp.Pow",
        "__and__": "exp.And", "__rand__": "exp.And",
        "__or__": "exp.Or", "__ror__": "exp.Or",
        "__lt__": "exp.LT", "__le__": "exp.LTE",
        "__gt__": "exp.GT", "__ge__": "exp.GTE",
        "__neg__": "exp.Neg", "__invert__": "exp.Not",
        "__getitem__": "exp.Bracket",
    }.get(dunder, "?")


def merge_runtime(findings: list[dict], runtime_path: str | None) -> dict:
    """Fold in observed-at-runtime sites from instrument_operators.py."""
    summary = {"runtime_available": False}
    if not runtime_path or not os.path.exists(runtime_path):
        return summary

    with open(runtime_path, encoding="utf-8") as fh:
        observed = json.load(fh)
    summary["runtime_available"] = True
    summary["runtime_meta"] = observed.get("meta", {})

    by_key = {(f["file"], f["line"]): f for f in findings}
    hits = observed.get("hits", [])
    confirmed = 0
    runtime_only: list[dict] = []
    for hit in hits:
        key = (hit["file"], hit["line"])
        target = by_key.get(key)
        if target is not None:
            if "runtime" not in target["found_by"]:
                target["found_by"].append("runtime")
            target["confidence"] = "confirmed"
            target["runtime_count"] = hit["count"]
            target.setdefault("runtime_dunders", []).extend(
                d for d in hit["dunders"] if d not in target.get("runtime_dunders", [])
            )
            confirmed += 1
        else:
            runtime_only.append(hit)

    for hit in runtime_only:
        findings.append(
            {
                "op": "?",
                "dunder": hit["dunders"][0] if hit["dunders"] else "?",
                "builds": _node_for(hit["dunders"][0]) if hit["dunders"] else "?",
                "confidence": "confirmed",
                "why": "observed executing; static pass did not flag this line",
                "operands": {},
                "py": f"{hit['file']}:{hit['line']}",
                "file": hit["file"],
                "line": hit["line"],
                "col": -1,
                "source": hit.get("source", ""),
                "executor": is_executor(hit["file"]),
                "found_by": ["runtime"],
                "runtime_count": hit["count"],
                "runtime_dunders": hit["dunders"],
            }
        )

    findings.sort(key=lambda e: (e["file"], e["line"], e["col"]))
    summary["runtime_confirmed"] = confirmed
    summary["runtime_only"] = len(runtime_only)
    return summary


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default="/tmp/sqlglot-ref-regex")
    ap.add_argument("--out", default="corpus/deny/operators.json")
    ap.add_argument("--runtime", default="build/deny/runtime_operators.json")
    args = ap.parse_args()

    if not os.path.isdir(os.path.join(args.ref, "sqlglot")):
        print(f"error: {args.ref} is not a sqlglot checkout", file=sys.stderr)
        return 2

    findings, stats = analyse(args.ref)
    runtime_summary = merge_runtime(findings, args.runtime)

    in_scope = [f for f in findings if not f["executor"]]
    by_conf: dict[str, int] = {}
    for f in in_scope:
        by_conf[f["confidence"]] = by_conf.get(f["confidence"], 0) + 1
    by_dunder: dict[str, int] = {}
    for f in in_scope:
        by_dunder[f["dunder"]] = by_dunder.get(f["dunder"], 0) + 1

    doc = {
        "_comment": (
            "Operator-overload sites inside sqlglot/. Every entry is a line where a "
            "Python operator builds an AST node because the operand is an exp.Expr; a "
            "JS transliteration that keeps the operator is wrong there. "
            "PORT_PLAN.md 4.6 / P0 item 8. Regenerate: python3 tools/deny/gen_operators.py"
        ),
        "ref": args.ref,
        "python": sys.version.split()[0],
        "stats": stats,
        "runtime": runtime_summary,
        "counts": {
            "total": len(findings),
            "in_scope": len(in_scope),
            "executor_only": len(findings) - len(in_scope),
            "by_confidence": by_conf,
            "by_dunder": by_dunder,
            "files": len({f["file"] for f in in_scope}),
        },
        "sites": findings,
    }

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=1, ensure_ascii=True)
        fh.write("\n")

    print(f"wrote {args.out}", file=sys.stderr)
    print(json.dumps(doc["counts"], indent=2), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
