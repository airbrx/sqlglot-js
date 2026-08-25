#!/usr/bin/env python3
"""Stub- and table-seeder.

PORT_PLAN.md §4.3 ("drafts the literal portion so the human starts from a filled
skeleton"), §8.1 Rule 2 (method stubs) and Rule 2' (per-line table seeding).

  python3 tools/seed_static.py --file sqlglot/generator.py --class Generator
  python3 tools/seed_static.py --file sqlglot/parser.py --class Parser --out src/parser.js

Emits a JS skeleton in which:

  * every method is a stub, IN UPSTREAM SOURCE ORDER, carrying its own
    `// py: <path>:<line>` anchor and throwing `NotPorted`. One task replaces exactly
    one stub, so two agents produce non-adjacent hunks that git merges cleanly, and
    `grep -c NotPorted` is a free burndown.

  * every class-level dict/set/list literal is seeded ONE ENTRY PER LINE, each with its
    own anchor. Rule 2 alone was not enough: `parser.py` is 405 methods / 8,143 LOC,
    leaving 2,337 LOC of class body (FUNCTIONS 648 entries, the precedence maps, ~162
    attributes) where the grammar shards actually collide. A per-line seed makes an
    addition a single non-adjacent line.

Values that are callables (76% of dialect dict entries, 94% in generators/) cannot be
seeded — they are emitted as anchored TODO lines rather than guessed at.
"""

import argparse
import ast
import json
import os
import sys

HEADER = """// py: {path} @ {commit}
// @seeded by tools/seed_static.py — method stubs and class-table skeletons.
//
// Each stub and each table entry carries its own upstream anchor so that one task
// replaces exactly one line/method and two agents never touch adjacent hunks
// (PORT_PLAN.md §8.1 Rules 2 and 2'). Table ORDER is CI-asserted against a _gen/
// snapshot, because §4.6 establishes that insertion order is observable in output SQL.

import {{ NotPorted }} from "./errors.js";

"""


def js_literal(node):
    """Render a Python AST literal as JS, or None if it is not a literal."""
    try:
        v = ast.literal_eval(node)
    except Exception:  # noqa: BLE001
        return None
    return json.dumps(v, ensure_ascii=False) if not isinstance(v, tuple) else json.dumps(
        list(v), ensure_ascii=False
    )


def describe_value(node):
    """A short, honest description of a non-literal value."""
    if isinstance(node, ast.Lambda):
        return "lambda"
    if isinstance(node, ast.Call):
        f = node.func
        name = getattr(f, "id", None) or getattr(f, "attr", None) or "call"
        return f"{name}(...)"
    if isinstance(node, ast.Attribute):
        return ast.unparse(node) if hasattr(ast, "unparse") else "attr"
    if isinstance(node, ast.Name):
        return node.id
    return type(node).__name__


def seed_table(name, node, path, out):
    """Seed one class-level dict/set/list, one entry per line, each anchored."""
    if isinstance(node, ast.Dict):
        out.append(f"  /** py: {path}:{node.lineno} */")
        out.append(f"  static {name} = new Map([")
        for k, v in zip(node.keys, node.values):
            if k is None:  # {**other}
                out.append(f"    // py:{getattr(v, 'lineno', node.lineno)}  SPREAD: "
                           f"{describe_value(v)} — merge manually (§4.4 MRO)")
                continue
            kl = js_literal(k)
            vl = js_literal(v)
            ln = getattr(k, "lineno", node.lineno)
            if kl is None:
                kl = f'"{describe_value(k)}"'
            if vl is None:
                out.append(f"    // py:{ln}  [{kl}, /* TODO {describe_value(v)} */],")
            else:
                out.append(f"    /* py:{ln} */ [{kl}, {vl}],")
        out.append("  ]);")
        return True

    if isinstance(node, (ast.Set, ast.List, ast.Tuple)):
        kind = "new Set([" if isinstance(node, ast.Set) else "["
        close = "]);" if isinstance(node, ast.Set) else "];"
        out.append(f"  /** py: {path}:{node.lineno} */")
        out.append(f"  static {name} = {kind}")
        for el in node.elts:
            el_l = js_literal(el)
            ln = getattr(el, "lineno", node.lineno)
            if el_l is None:
                out.append(f"    // py:{ln}  /* TODO {describe_value(el)} */,")
            else:
                out.append(f"    /* py:{ln} */ {el_l},")
        out.append(f"  {close}")
        return True

    lit = js_literal(node)
    if lit is not None:
        out.append(f"  /** py: {path}:{node.lineno} */")
        out.append(f"  static {name} = {lit};")
        return True

    out.append(f"  // py:{node.lineno}  static {name} = /* TODO {describe_value(node)} */;")
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default="/tmp/sqlglot-ref")
    ap.add_argument("--file", required=True, help="upstream path, e.g. sqlglot/generator.py")
    ap.add_argument("--class", dest="cls", required=True)
    ap.add_argument("--out", default=None, help="write here instead of stdout")
    ap.add_argument("--commit", default=None)
    args = ap.parse_args()

    full = os.path.join(args.ref, args.file)
    with open(full, encoding="utf8") as f:
        tree = ast.parse(f.read())

    commit = args.commit
    if commit is None:
        try:
            with open("UPSTREAM.txt", encoding="utf8") as f:
                for line in f:
                    if line.startswith("commit:"):
                        commit = line.split(":", 1)[1].strip()
        except OSError:
            commit = "unknown"

    target = None
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == args.cls:
            target = node
            break
    if target is None:
        sys.exit(f"class {args.cls} not found in {args.file}")

    out = [HEADER.format(path=args.file, commit=commit)]
    out.append(f"export class {args.cls} {{")

    n_tables = 0
    n_tables_partial = 0
    n_methods = 0

    # Class body in SOURCE ORDER — that order is the contract (§8.1 Rule 2').
    for node in target.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(
            node.targets[0], ast.Name
        ):
            name = node.targets[0].id
            if name.startswith("_"):
                continue
            complete = seed_table(name, node.value, args.file, out)
            n_tables += 1
            if not complete:
                n_tables_partial += 1
            out.append("")
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            name = node.target.id
            if name.startswith("_") or node.value is None:
                continue
            complete = seed_table(name, node.value, args.file, out)
            n_tables += 1
            if not complete:
                n_tables_partial += 1
            out.append("")
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            argnames = [a.arg for a in node.args.args if a.arg != "self"]
            jsargs = ", ".join(argnames)
            anchor = f"{args.file}:{node.lineno}"
            out.append(f"  /** @returns {{*}} */")
            out.append(f"  // py: {anchor}")
            out.append(
                f'  {node.name}({jsargs}) {{ throw new NotPorted("{node.name}", "{anchor}"); }}'
            )
            out.append("")
            n_methods += 1

    out.append("}")
    text = "\n".join(out) + "\n"

    if args.out:
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf8") as f:
            f.write(text)
        where = args.out
    else:
        sys.stdout.write(text)
        where = "<stdout>"

    print(
        f"  {args.file}::{args.cls} -> {where}\n"
        f"    {n_methods} method stubs\n"
        f"    {n_tables} class tables ({n_tables_partial} contain non-literal entries "
        f"needing hand-porting)",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
