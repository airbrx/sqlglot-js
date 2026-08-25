#!/usr/bin/env python3
"""Print a sample of deny-list entries grouped by dunder, for human audit.

The deny-lists are only useful if a reviewer can check them, so this exists to
make false positives obvious rather than to be part of the pipeline.

Usage: python3 tools/deny/audit.py corpus/deny/operators.json [--dunder __getitem__] [-n 25]
"""

from __future__ import annotations

import argparse
import collections
import json


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--dunder", default=None)
    ap.add_argument("--confidence", default=None)
    ap.add_argument("--key", default="dunder", help="group by this field")
    ap.add_argument("-n", type=int, default=20)
    args = ap.parse_args()

    doc = json.load(open(args.path, encoding="utf-8"))
    sites = [s for s in doc["sites"] if not s.get("executor")]
    if args.dunder:
        sites = [s for s in sites if s.get("dunder") == args.dunder]
    if args.confidence:
        sites = [s for s in sites if s.get("confidence") == args.confidence]

    groups = collections.defaultdict(list)
    for s in sites:
        groups[s.get(args.key, "?")].append(s)

    for key, items in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        print(f"\n=== {key}  ({len(items)} sites) ===")
        for s in items[: args.n]:
            note = s.get("why") or s.get("why_js_differs") or ""
            conf = s.get("confidence", s.get("shim", ""))
            print(f"  {s['py']:52} [{conf}] {note[:90]}")
            print(f"      {s.get('source','')[:150]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
