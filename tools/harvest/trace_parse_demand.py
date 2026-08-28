"""Harvest, per AST-oracle row, the set of `Parser` methods CPython actually executes.

    PYTHONHASHSEED=0 python3 tools/harvest/trace_parse_demand.py > corpus/parse_demand.json

Why this exists
---------------
PORT_PLAN.md §8.3 says every task brief carries its own oracle, and the P3 stub-queue
briefs were sized with a per-method statistic of the form "`_parse_expression` blocks
15,440 of 15,478 oracle rows". That number is real but it is a *blocking* count, and
it does not compose: oracle-row closure is CONJUNCTIVE. A row is closed only when
EVERY `_parse_*` method its parse touches is implemented, so the rows a method blocks
are almost never the rows implementing it opens.

Summing or ranking "blocks N rows" across methods therefore triple-counts massively
(the per-method blocking counts over this corpus sum to ~1.1M against 15,540 real
rows) and tells an agent that one method is worth 15,440 rows when the true marginal
value is 31. This script harvests the raw material — the exact method set per row — so
`tools/closure_parser.mjs` can compute the honest marginal instead.

Method
------
Wrap every `Parser._parse_*` / `Parser.parse_*` with a recorder, parse each corpus row
at the pin under its own read dialect, and emit the set of methods that fired. This is
DEMAND-driven, not the static call graph: the static transitive closure of
`_parse_expression` reaches 383 of 405 methods because dispatch tables fan out to
everything, which over-approximates by ~10x and is useless for scheduling.

Output schema
-------------
Method names are interned into `methods` (descending frequency) and `per_row` stores
indices into it — the naive name-per-row form is 15 MB, this is 2.4 MB.

    {"upstream_commit": "...", "python_version": "...",
     "methods": ["_parse_statement", ...],
     "freq":    [<rows calling methods[0]>, ...],
     "per_row": {"<atom_id>": [<index>, ...], ...}}
"""

import collections
import functools
import glob
import json
import os
import sys
import types

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)

import sqlglot  # noqa: E402
from sqlglot.parser import Parser  # noqa: E402

CURRENT: set = set()


def _instrument() -> None:
    for name in dir(Parser):
        if not (name.startswith("_parse_") or name.startswith("parse_")):
            continue
        fn = getattr(Parser, name)
        if not isinstance(fn, types.FunctionType):
            continue

        def make(nm, f):
            @functools.wraps(f)
            def wrapper(self, *args, **kwargs):
                CURRENT.add(nm)
                return f(self, *args, **kwargs)

            return wrapper

        setattr(Parser, name, make(name, fn))


def main() -> int:
    if os.environ.get("PYTHONHASHSEED") != "0":
        # Same rule as every other oracle script here: dict/set iteration order is
        # observable in the harvested AST, so an unpinned seed makes runs disagree.
        print("refusing to run without PYTHONHASHSEED=0", file=sys.stderr)
        return 2

    _instrument()

    atoms = {}
    with open("corpus/atoms.jsonl") as fh:
        for line in fh:
            if line.strip():
                atom = json.loads(line)
                atoms[atom["atom_id"]] = atom

    freq: collections.Counter = collections.Counter()
    per_row: dict = {}
    failures = 0

    for path in sorted(glob.glob("corpus/ast/*.jsonl")):
        dialect = os.path.basename(path)[: -len(".jsonl")]
        if dialect == "_default":
            dialect = ""
        with open(path) as fh:
            for line in fh:
                if not line.strip():
                    continue
                atom = atoms.get(json.loads(line)["atom_id"])
                if not atom:
                    continue
                CURRENT.clear()
                try:
                    sqlglot.parse(atom["sql"], read=dialect or None)
                except Exception:
                    # A row upstream itself cannot parse carries no demand signal.
                    failures += 1
                    continue
                methods = sorted(CURRENT)
                per_row[atom["atom_id"]] = methods
                for method in methods:
                    freq[method] += 1

    provenance = json.load(open("corpus/PROVENANCE.json"))
    methods = [m for m, _ in freq.most_common()]
    index = {m: i for i, m in enumerate(methods)}
    json.dump(
        {
            "upstream_commit": provenance["upstream_commit"],
            "python_version": provenance["python_version"],
            "rows": len(per_row),
            "parse_failures": failures,
            "methods": methods,
            "freq": [freq[m] for m in methods],
            "per_row": {k: [index[m] for m in v] for k, v in per_row.items()},
        },
        sys.stdout,
        separators=(",", ":"),
    )
    print(f"traced {len(per_row)} rows, {len(freq)} distinct methods", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
