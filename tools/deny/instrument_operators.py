#!/usr/bin/env python3
"""Runtime confirmation for corpus/deny/operators.json.

Static analysis over a dynamically typed codebase produces both false positives
and false negatives, and no amount of care removes them entirely. So the static
census gets cross-checked against ground truth: patch every AST-building dunder
on `exp.Expression`, run upstream's own test suite, and record the *caller's*
file:line each time one fires.

What this proves and what it does not:
  * A recorded site is certain — that operator really did build an AST node.
  * A site the suite never reaches is not thereby safe; it is merely unproven,
    which is why the static list is the deny-list and this is the cross-check.

`__eq__`/`__ne__` are deliberately not patched: they return bool rather than a
node, so they are a §4.5 equality/hashing concern, not an operator-overload one.

Env is set inside this script rather than on the command line, so no `VAR=value
cmd` prefix is needed to run it.

Usage:
    python3 tools/deny/instrument_operators.py --ref /tmp/sqlglot-ref-regex \\
        --out build/deny/runtime_operators.json [--pattern 'test_*.py']
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import sys
import time

# Every dunder on Expression that returns an AST node.
NODE_BUILDING_DUNDERS = [
    "__add__", "__radd__",
    "__sub__", "__rsub__",
    "__mul__", "__rmul__",
    "__truediv__", "__rtruediv__",
    "__floordiv__", "__rfloordiv__",
    "__mod__", "__rmod__",
    "__pow__", "__rpow__",
    "__and__", "__rand__",
    "__or__", "__ror__",
    "__lt__", "__le__", "__gt__", "__ge__",
    "__neg__", "__invert__",
    "__getitem__",
    "__iter__",
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default="/tmp/sqlglot-ref-regex")
    ap.add_argument("--out", default="build/deny/runtime_operators.json")
    ap.add_argument("--pattern", default="test_*.py")
    ap.add_argument("--start-dir", default="tests")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    ref = os.path.abspath(args.ref)
    out = os.path.abspath(args.out)
    if not os.path.isdir(os.path.join(ref, "sqlglot")):
        print(f"error: {ref} is not a sqlglot checkout", file=sys.stderr)
        return 2

    # Set env in-process; no `VAR=value cmd` prefix required.
    os.environ.setdefault("PYTHONHASHSEED", "0")
    sys.path.insert(0, ref)
    os.chdir(ref)

    from sqlglot import expressions as exp  # noqa: E402

    hits: collections.Counter = collections.Counter()

    def make_wrapper(name, original):
        def wrapper(self, *a, **kw):
            frame = sys._getframe(1)
            hits[(frame.f_code.co_filename, frame.f_lineno, name)] += 1
            return original(self, *a, **kw)

        wrapper.__name__ = name
        return wrapper

    patched = []
    for name in NODE_BUILDING_DUNDERS:
        original = getattr(exp.Expression, name, None)
        if original is None:
            continue
        setattr(exp.Expression, name, make_wrapper(name, original))
        patched.append(name)

    import unittest  # noqa: E402

    started = time.time()
    loader = unittest.TestLoader()
    suite = loader.discover(args.start_dir, pattern=args.pattern, top_level_dir=ref)
    stream = open(os.devnull, "w") if args.quiet else sys.stderr
    runner = unittest.TextTestRunner(stream=stream, verbosity=0)
    result = runner.run(suite)
    elapsed = time.time() - started

    # Collapse (file, line, dunder) -> one record per (file, line).
    by_site: dict[tuple[str, int], dict] = {}
    skipped_outside = 0
    for (filename, lineno, dunder), count in hits.items():
        try:
            relpath = os.path.relpath(filename, ref)
        except ValueError:
            skipped_outside += 1
            continue
        if not relpath.startswith("sqlglot/") or relpath.startswith("sqlglot/executor/"):
            # Operator use inside the tests themselves is expected and not a
            # port hazard; only sqlglot/ counts.
            skipped_outside += 1
            continue
        key = (relpath, lineno)
        rec = by_site.setdefault(
            key, {"file": relpath, "line": lineno, "count": 0, "dunders": []}
        )
        rec["count"] += count
        if dunder not in rec["dunders"]:
            rec["dunders"].append(dunder)

    for rec in by_site.values():
        rec["dunders"].sort()
        path = os.path.join(ref, rec["file"])
        try:
            with open(path, encoding="utf-8") as fh:
                lines = fh.read().splitlines()
            rec["source"] = lines[rec["line"] - 1].strip() if rec["line"] <= len(lines) else ""
        except OSError:
            rec["source"] = ""

    records = sorted(by_site.values(), key=lambda r: (r["file"], r["line"]))
    doc = {
        "meta": {
            "ref": ref,
            "python": sys.version.split()[0],
            "patched_dunders": patched,
            "pattern": args.pattern,
            "tests_run": result.testsRun,
            "failures": len(result.failures),
            "errors": len(result.errors),
            "elapsed_sec": round(elapsed, 1),
            "distinct_sites_in_sqlglot": len(records),
            "hits_outside_sqlglot": skipped_outside,
        },
        "hits": records,
    }

    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=1)
        fh.write("\n")

    print(json.dumps(doc["meta"], indent=2), file=sys.stderr)
    print(f"wrote {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
