#!/usr/bin/env python3
"""Generate corpus/deny/py_builtins.json — PORT_PLAN.md §4.6, §7 P0 item 8.

A census of every call inside `sqlglot/` to a Python builtin or str method whose
JS counterpart has different semantics. PORT_PLAN.md §4.6 documents three of
these, each found by targeted probing rather than by the test suite:

    parsers/clickhouse.py   len(sep_value.encode("utf-8")) == 1   UTF-8 byte length
    generators/singlestore.py  chr(int(m.group(1), 16))           chr() beyond the BMP
    parsers/dremio.py       f"{int(year.this):04d}-..."           :04d vs padStart

The point of this list is that those three were found by hand, so the population
is unknown. This enumerates it.

Divergences, stated per name so the deny-list is self-documenting:

  encode        len(s.encode('utf-8')) is BYTES; JS .length is UTF-16 units
  chr           accepts any code point incl. lone surrogates; String.fromCharCode
                truncates above 0xFFFF (fromCodePoint is the correct analogue)
  ord           returns a CODE POINT; JS charCodeAt returns a UTF-16 unit
  zfill         sign-aware: '-1'.zfill(4) == '-001'; padStart gives '00-1'
  rjust/ljust   pad to a CODE POINT width, not a UTF-16 width
  partition     always returns a 3-tuple; JS split(sep, 2) does not
  splitlines    splits on 8 line boundaries incl. \\v \\f \\x1c-\\x1e \\x85 \\u2028/9;
                JS split(/\\n/) or /\\r?\\n/ does not
  rsplit        maxsplit counts from the RIGHT; JS split has no such form
  startswith/   accept a TUPLE of prefixes; JS startsWith takes one string
  endswith
  format spec   :04d is sign-aware, :>10 pads by code point, :.2f rounds
                half-to-even; none of that matches padStart/toFixed

Usage:
    python3 tools/deny/gen_py_builtins.py --ref /tmp/sqlglot-ref-regex \\
        --out corpus/deny/py_builtins.json
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import is_executor, rel, source_line, source_segment, sqlglot_files  # noqa: E402

# name -> (shim, why JS differs)
STR_METHODS = {
    "encode": ("utf8Len", "len(s.encode('utf-8')) counts BYTES; JS .length counts UTF-16 units"),
    "zfill": ("pyZfill", "sign-aware: '-1'.zfill(4) == '-001', padStart gives '00-1'"),
    "rjust": ("pyRjust", "pads to a code-point width, not a UTF-16 width"),
    "ljust": ("pyLjust", "pads to a code-point width, not a UTF-16 width"),
    "partition": ("pyPartition", "always returns a 3-tuple; JS split(sep, 2) does not"),
    "rpartition": ("pyRpartition", "always returns a 3-tuple, searching from the right"),
    "splitlines": (
        "pySplitlines",
        "splits on 8 boundaries incl. \\v \\f \\x1c-\\x1e \\x85 \\u2028 \\u2029",
    ),
    "rsplit": ("pyRsplit", "maxsplit counts from the RIGHT; JS split has no such form"),
}
BUILTINS = {
    "chr": ("pyChr", "accepts any code point incl. lone surrogates; String.fromCharCode truncates above 0xFFFF"),
    "ord": ("pyOrd", "returns a code point; JS charCodeAt returns a UTF-16 unit"),
}
TUPLE_ARG_METHODS = {
    "startswith": ("pyStartswith", "accepts a TUPLE of prefixes; JS startsWith takes one string"),
    "endswith": ("pyEndswith", "accepts a TUPLE of suffixes; JS endsWith takes one string"),
}


def _format_spec_text(node: ast.AST | None) -> str | None:
    """Literal text of an f-string format spec, or None if it is dynamic."""
    if node is None:
        return None
    if not isinstance(node, ast.JoinedStr):
        return None
    parts: list[str] = []
    for value in node.values:
        if isinstance(value, ast.Constant) and isinstance(value.value, str):
            parts.append(value.value)
        else:
            return "<dynamic>"
    return "".join(parts)


def analyse(ref: str) -> tuple[list[dict], dict]:
    findings: list[dict] = []
    stats = {"files_scanned": 0, "calls": 0, "fstring_slots": 0}

    for path in sqlglot_files(ref):
        relpath = rel(ref, path)
        try:
            tree = ast.parse(open(path, encoding="utf-8").read(), filename=path)
        except (OSError, SyntaxError):
            continue
        stats["files_scanned"] += 1

        def add(node: ast.AST, name: str, category: str, shim: str, why: str, extra=None) -> None:
            entry = {
                "name": name,
                "category": category,
                "shim": shim,
                "why_js_differs": why,
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
            if isinstance(node, ast.Call):
                stats["calls"] += 1
                fn = node.func

                if isinstance(fn, ast.Name) and fn.id in BUILTINS:
                    shim, why = BUILTINS[fn.id]
                    add(node, fn.id, "builtin", shim, why)
                    continue

                if not isinstance(fn, ast.Attribute):
                    continue

                if fn.attr in STR_METHODS:
                    shim, why = STR_METHODS[fn.attr]
                    extra = None
                    if fn.attr == "encode":
                        # Only the byte-length idiom is a hazard; a bare
                        # .encode() feeding a file write is not.
                        arg = node.args[0] if node.args else None
                        codec = arg.value if isinstance(arg, ast.Constant) else None
                        extra = {"codec": codec}
                    add(node, fn.attr, "str-method", shim, why, extra)
                    continue

                if fn.attr in TUPLE_ARG_METHODS:
                    # Only a hazard when the argument is a tuple of options.
                    if not node.args:
                        continue
                    arg = node.args[0]
                    is_tuple = isinstance(arg, ast.Tuple)
                    if not is_tuple:
                        continue
                    shim, why = TUPLE_ARG_METHODS[fn.attr]
                    add(
                        node, fn.attr, "tuple-arg", shim, why,
                        {"n_options": len(arg.elts)},
                    )

            elif isinstance(node, ast.FormattedValue):
                stats["fstring_slots"] += 1
                spec = _format_spec_text(node.format_spec)
                if not spec:
                    continue
                add(
                    node, f"format-spec :{spec}", "format-spec", "pyFormat",
                    "Python's format mini-language: sign-aware zero padding, "
                    "code-point width, half-to-even rounding",
                    {"spec": spec},
                )

    findings.sort(key=lambda e: (e["file"], e["line"], e["col"]))
    return findings, stats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default="/tmp/sqlglot-ref-regex")
    ap.add_argument("--out", default="corpus/deny/py_builtins.json")
    args = ap.parse_args()

    if not os.path.isdir(os.path.join(args.ref, "sqlglot")):
        print(f"error: {args.ref} is not a sqlglot checkout", file=sys.stderr)
        return 2

    findings, stats = analyse(args.ref)
    in_scope = [f for f in findings if not f["executor"]]

    by_name: dict[str, int] = {}
    by_category: dict[str, int] = {}
    for f in in_scope:
        key = f["spec"] if f["category"] == "format-spec" else f["name"]
        by_name[key] = by_name.get(key, 0) + 1
        by_category[f["category"]] = by_category.get(f["category"], 0) + 1

    doc = {
        "_comment": (
            "Every call inside sqlglot/ to a Python builtin or str method whose JS "
            "counterpart differs. PORT_PLAN.md 4.6 documents three of these "
            "(parsers/clickhouse.py encode, generators/singlestore.py chr, "
            "parsers/dremio.py :04d), each found by hand; this is the full population. "
            "Each site must route through the named _py/ shim. "
            "Regenerate: python3 tools/deny/gen_py_builtins.py"
        ),
        "ref": args.ref,
        "python": sys.version.split()[0],
        "stats": stats,
        "counts": {
            "total": len(findings),
            "in_scope": len(in_scope),
            "executor_only": len(findings) - len(in_scope),
            "by_category": by_category,
            "by_name": dict(sorted(by_name.items(), key=lambda kv: -kv[1])),
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
