#!/usr/bin/env python3
"""Generate corpus/deny/implicit_str.json — PORT_PLAN.md §4.6, §7 P0 item 8.

`Expression.__str__` is `return self.sql()` (expressions/core.py:1237), and
`sql()` with no dialect renders with the **default** dialect. So every implicit
coercion of an Expr to a string silently picks the default dialect, which is a
behaviour difference from an explicit `.sql(dialect=...)` — and in JS there is no
`__str__` at all, so a transliteration that writes `${expr}` produces
`[object Object]` rather than SQL.

Coercion forms this finds, all via AST:

  f-string      f"{expr}" and f"{expr!s}"      -> __str__
  str()         str(expr)                      -> __str__
  %-format      "... %s" % expr                -> __str__
  .format()     "{}".format(expr)              -> __str__
  logging       logger.warning("%s", expr)     -> __str__, lazily

`f"{expr!r}"` is reported separately: it calls `__repr__`, which returns the AST
dump (`_to_s()`), not SQL. That is not a dialect hazard but it is still a port
hazard, so it is recorded with `renders: "repr"` rather than dropped.

String concatenation (`"x" + expr`) is deliberately NOT here: Python resolves it
to `Expr.__radd__` and builds an `exp.Add` node, so it belongs to
corpus/deny/operators.json.

Usage:
    python3 tools/deny/gen_implicit_str.py --ref /tmp/sqlglot-ref-regex \\
        --out corpus/deny/implicit_str.json
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import (  # noqa: E402
    KIND_CONTAINER,
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

LOGGING_METHODS = {"debug", "info", "warning", "warn", "error", "exception", "critical"}


def analyse(ref: str) -> tuple[list[dict], dict]:
    knowledge = ExprKnowledge(ref)
    findings: list[dict] = []
    stats = {"files_scanned": 0, "fstring_slots": 0, "str_calls": 0, "percent_formats": 0}

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

        def add(node: ast.AST, form: str, renders: str, verdict, extra=None) -> None:
            entry = {
                "form": form,
                "renders": renders,
                "confidence": verdict[1],
                "why": verdict[2],
                "py": f"{relpath}:{node.lineno}",
                "file": relpath,
                "line": node.lineno,
                "col": node.col_offset,
                "source": source_segment(path, node),
                "statement": source_line(path, node.lineno),
                "executor": is_executor(relpath),
            }
            if extra:
                entry.update(extra)
            findings.append(entry)

        for node in ast.walk(tree):
            # ---- f-strings -------------------------------------------------
            if isinstance(node, ast.FormattedValue):
                stats["fstring_slots"] += 1
                tp = typer_for(node)
                v = tp.classify(node.value)
                if v is None or v[0] != KIND_EXPR:
                    continue
                # conversion: -1 none, 115 's', 114 'r', 97 'a'
                if node.conversion == 114:
                    add(node, "f-string {x!r}", "repr", v)
                elif node.conversion in (-1, 115):
                    add(node, "f-string {x}" if node.conversion == -1 else "f-string {x!s}",
                        "sql-default-dialect", v)
                elif node.conversion == 97:
                    add(node, "f-string {x!a}", "repr", v)

            # ---- str(x) / "...".format(x) / logging ------------------------
            elif isinstance(node, ast.Call):
                fn = node.func
                if isinstance(fn, ast.Name) and fn.id == "str":
                    stats["str_calls"] += 1
                    if node.args:
                        tp = typer_for(node)
                        v = tp.classify(node.args[0])
                        if v is not None and v[0] == KIND_EXPR:
                            add(node, "str(x)", "sql-default-dialect", v)
                elif isinstance(fn, ast.Attribute) and fn.attr == "format":
                    if isinstance(fn.value, (ast.Constant, ast.JoinedStr)):
                        tp = typer_for(node)
                        for arg in [*node.args, *[k.value for k in node.keywords]]:
                            v = tp.classify(arg)
                            if v is not None and v[0] == KIND_EXPR:
                                add(node, "str.format(x)", "sql-default-dialect", v)
                                break
                elif isinstance(fn, ast.Attribute) and fn.attr in LOGGING_METHODS:
                    base = fn.value
                    base_name = base.id if isinstance(base, ast.Name) else getattr(base, "attr", "")
                    if "log" not in str(base_name).lower():
                        continue
                    tp = typer_for(node)
                    for arg in node.args[1:]:
                        v = tp.classify(arg)
                        if v is not None and v[0] == KIND_EXPR:
                            add(node, f"logger.{fn.attr}(..., x)", "sql-default-dialect", v)
                            break

            # ---- "%s" % x --------------------------------------------------
            elif isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mod):
                left = node.left
                if not (isinstance(left, ast.Constant) and isinstance(left.value, str)):
                    continue
                stats["percent_formats"] += 1
                tp = typer_for(node)
                targets = (
                    node.right.elts if isinstance(node.right, ast.Tuple) else [node.right]
                )
                for target in targets:
                    v = tp.classify(target)
                    if v is not None and v[0] in (KIND_EXPR, KIND_CONTAINER):
                        add(node, '"%s" % x', "sql-default-dialect", v)
                        break

    findings.sort(key=lambda e: (e["file"], e["line"], e["col"]))
    return findings, stats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default="/tmp/sqlglot-ref-regex")
    ap.add_argument("--out", default="corpus/deny/implicit_str.json")
    args = ap.parse_args()

    if not os.path.isdir(os.path.join(args.ref, "sqlglot")):
        print(f"error: {args.ref} is not a sqlglot checkout", file=sys.stderr)
        return 2

    findings, stats = analyse(args.ref)
    in_scope = [f for f in findings if not f["executor"]]
    sql_rendering = [f for f in in_scope if f["renders"] == "sql-default-dialect"]

    by_form: dict[str, int] = {}
    for f in sql_rendering:
        by_form[f["form"]] = by_form.get(f["form"], 0) + 1
    by_conf: dict[str, int] = {}
    for f in sql_rendering:
        by_conf[f["confidence"]] = by_conf.get(f["confidence"], 0) + 1

    doc = {
        "_comment": (
            "Implicit Expression->str coercions inside sqlglot/. Each renders with the "
            "DEFAULT dialect via Expression.__str__ (expressions/core.py:1237 -> self.sql()). "
            "JS has no __str__, so a transliterated `${expr}` yields '[object Object]'. "
            "Entries with renders='repr' call __repr__/_to_s instead and are a separate "
            "(non-dialect) port hazard. PORT_PLAN.md 4.6 / P0 item 8. "
            "Regenerate: python3 tools/deny/gen_implicit_str.py"
        ),
        "ref": args.ref,
        "python": sys.version.split()[0],
        "stats": stats,
        "counts": {
            "total": len(findings),
            "in_scope": len(in_scope),
            "executor_only": len(findings) - len(in_scope),
            "sql_default_dialect": len(sql_rendering),
            "repr_only": len(in_scope) - len(sql_rendering),
            "by_form": by_form,
            "by_confidence": by_conf,
            "files": len({f["file"] for f in sql_rendering}),
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
