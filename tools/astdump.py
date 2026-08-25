#!/usr/bin/env python3
"""Lossless AST oracle + generate oracle.

PORT_PLAN.md §3.1(B) and §3.1(D).

  python3 tools/astdump.py --ref /tmp/sqlglot-ref

Writes, per read dialect:
  corpus/ast/<dialect>.jsonl   {atom_id, ast, repr}
  corpus/gen/<dialect>.jsonl   {atom_id, ast_ref, dialect, flags, sql, unsupported_messages}

Deliberately NOT sqlglot's `serde`, which drops 34% of arg entries (`None` and `[]`)
and would let a wrong AST satisfy the gate. `a` is an ORDERED array of `[key, value]`
pairs **including nulls and empty lists**, which is what pins `arg_types` insertion
order — observable in output SQL (§4.6).

`repr` is Python's `Expression.__repr__`, byte-exact. Asserting it is what makes the
AST gate non-tautological and human-readable (§3.1(B)).
"""

import argparse
import enum
import json
import os
import sys
from collections import OrderedDict


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default="/tmp/sqlglot-ref")
    ap.add_argument("--atoms", default="corpus/atoms.jsonl")
    ap.add_argument("--astdir", default="corpus/ast")
    ap.add_argument("--gendir", default="corpus/gen")
    ap.add_argument("--limit", type=int, default=0, help="debug: only N atoms")
    args = ap.parse_args()

    sys.path.insert(0, args.ref)

    from sqlglot import exp, parse_one, ErrorLevel
    from sqlglot.generator import Generator
    from sqlglot.dialects.dialect import Dialect

    # ---- capture unsupported_messages (§3.1 D) -------------------------------
    last = {"messages": []}
    orig_generate = Generator.generate

    def generate_capture(self, expression, copy=True):
        out = orig_generate(self, expression, copy=copy)
        last["messages"] = list(self.unsupported_messages)
        return out

    Generator.generate = generate_capture

    def dump(node):
        """Lossless, order-preserving serialisation of an Expr tree."""
        if isinstance(node, exp.Expr):
            out = OrderedDict()
            out["c"] = type(node).__name__
            # ORDERED, and keeps None / [] — the whole point vs serde.
            out["a"] = [[k, dump(v)] for k, v in node.args.items()]
            meta = node._meta
            out["m"] = dict(meta) if meta else None
            out["cm"] = list(node.comments) if node.comments else None
            return out
        if isinstance(node, list):
            return [dump(v) for v in node]
        if isinstance(node, tuple):
            # Tagged so the JS side can tell a tuple from a list.
            return {"__tuple__": [dump(v) for v in node]}
        if isinstance(node, bool) or node is None:
            return node
        if isinstance(node, (str, int, float)):
            return node
        if isinstance(node, enum.Enum):
            # exp.DType and friends. `name` is the stable identity; `value` is carried
            # too because some enums round-trip by value.
            return {"__enum__": type(node).__name__, "name": node.name, "value": node.value}
        if isinstance(node, type):
            # e.g. arg values that are classes (DataType refs)
            return {"__type__": node.__name__}
        if isinstance(node, Dialect):
            # A parsed-in Dialect instance (e.g. ClickHouse) held on an arg.
            return {"__dialect__": type(node).__name__}
        # Anything else is a leak in this dumper, not something to coerce silently.
        return {"__unknown__": repr(node), "__pytype__": type(node).__name__}

    atoms = []
    with open(args.atoms, encoding="utf8") as f:
        for line in f:
            if line.strip():
                atoms.append(json.loads(line))
    if args.limit:
        atoms = atoms[: args.limit]

    os.makedirs(args.astdir, exist_ok=True)
    os.makedirs(args.gendir, exist_ok=True)

    ast_files = {}
    gen_files = {}
    unknown_kinds = {}
    n_ast = n_gen = n_skip = 0

    def fname(d):
        return d if d else "_default"

    for a in atoms:
        read = a["read"] or None
        write = a["write"] or None
        try:
            expr = parse_one(a["sql"], read=read)
        except Exception:
            n_skip += 1
            continue

        # ---- AST oracle, keyed by READ dialect --------------------------------
        key = fname(a["read"])
        if key not in ast_files:
            ast_files[key] = open(os.path.join(args.astdir, f"{key}.jsonl"), "w", encoding="utf8")
        try:
            ast = dump(expr)
            row = {"atom_id": a["atom_id"], "ast": ast, "repr": repr(expr)}
            blob = json.dumps(row, separators=(",", ":"), ensure_ascii=False)
            ast_files[key].write(blob + "\n")
            n_ast += 1
            # Surface dumper leaks loudly rather than shipping an incomplete oracle.
            if '"__unknown__"' in blob:
                for frag in blob.split('"__pytype__":"')[1:]:
                    t = frag.split('"')[0]
                    unknown_kinds[t] = unknown_kinds.get(t, 0) + 1
        except Exception as e:  # noqa: BLE001
            print(f"  ast dump failed for {a['atom_id']}: {e}", file=sys.stderr)
            n_skip += 1
            continue

        # ---- generate oracle, keyed by WRITE dialect --------------------------
        gkey = fname(a["write"])
        if gkey not in gen_files:
            gen_files[gkey] = open(os.path.join(args.gendir, f"{gkey}.jsonl"), "w", encoding="utf8")
        last["messages"] = []
        try:
            sql = expr.sql(
                write,
                unsupported_level=ErrorLevel.IGNORE,
                pretty=a["pretty"],
                identify=a["identify"],
            )
            msgs = list(last["messages"])
        except Exception:
            sql = None
            msgs = list(last["messages"])
        gen_files[gkey].write(
            json.dumps(
                {
                    "atom_id": a["atom_id"],
                    "ast_ref": a["atom_id"],
                    "dialect": a["write"],
                    "flags": {"pretty": a["pretty"], "identify": a["identify"]},
                    "sql": sql,
                    "unsupported_messages": msgs,
                },
                separators=(",", ":"),
                ensure_ascii=False,
            )
            + "\n"
        )
        n_gen += 1

    for f in list(ast_files.values()) + list(gen_files.values()):
        f.close()

    n_unsup = 0
    for gkey in gen_files:
        with open(os.path.join(args.gendir, f"{gkey}.jsonl"), encoding="utf8") as f:
            for line in f:
                if line.strip() and json.loads(line)["unsupported_messages"]:
                    n_unsup += 1

    print(f"  ast rows:   {n_ast} across {len(ast_files)} read dialects", file=sys.stderr)
    print(f"  gen rows:   {n_gen} across {len(gen_files)} write dialects", file=sys.stderr)
    print(f"  with unsupported_messages: {n_unsup}", file=sys.stderr)
    print(f"  skipped (parse/dump failed): {n_skip}", file=sys.stderr)
    if unknown_kinds:
        print("  DUMPER LEAKS — arg types not handled losslessly:", file=sys.stderr)
        for t, c in sorted(unknown_kinds.items(), key=lambda kv: -kv[1]):
            print(f"    {t}: {c}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
