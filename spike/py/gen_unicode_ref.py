#!/usr/bin/env python3
"""Dump CPython's per-code-point classification over the FULL sys.maxunicode range.

PORT_PLAN.md §7 P0 item 1 / §3.4 target 3 / §4.6 "Strings".

Covers 0 .. sys.maxunicode inclusive (1,114,112 code points) — not a sample.
Output is run-length encoded (ranges where the predicate is True) so the file
stays small; JS reconstructs the exact same predicate from it.

Note on surrogates: chr(0xD800..0xDFFF) yields a lone surrogate str in CPython.
The predicates are well-defined on those and are included, because sqlglot can
be handed such strings (e.g. via a surrogate escape) and JS strings can contain
them natively.
"""

import json
import sys
import unicodedata

PREDICATES = {
    "isprintable": lambda c: c.isprintable(),
    "islower": lambda c: c.islower(),
    "isupper": lambda c: c.isupper(),
    "isspace": lambda c: c.isspace(),
}


def rle(flags):
    """[bool] -> [[start, end], ...] inclusive ranges where flag is True."""
    ranges = []
    start = None
    for cp, v in enumerate(flags):
        if v and start is None:
            start = cp
        elif not v and start is not None:
            ranges.append([start, cp - 1])
            start = None
    if start is not None:
        ranges.append([start, len(flags) - 1])
    return ranges


def main():
    maxcp = sys.maxunicode  # 0x10FFFF
    out = {
        "python_version": sys.version.split()[0],
        "unidata_version": unicodedata.unidata_version,
        "maxunicode": maxcp,
        "predicates": {},
        "counts": {},
    }

    for name, fn in PREDICATES.items():
        flags = [False] * (maxcp + 1)
        for cp in range(maxcp + 1):
            try:
                flags[cp] = bool(fn(chr(cp)))
            except (ValueError, UnicodeError):
                flags[cp] = False
        out["predicates"][name] = rle(flags)
        out["counts"][name] = sum(flags)

    # General_Category per code point, RLE'd by category name. This lets the JS side
    # explain *why* a divergence happened (unassigned-in-13.0 vs assigned-in-15.x)
    # rather than just reporting a count.
    cats = {}
    prev = None
    start = 0
    for cp in range(maxcp + 1):
        try:
            c = unicodedata.category(chr(cp))
        except (ValueError, UnicodeError):
            c = "Cn"
        if c != prev:
            if prev is not None:
                cats.setdefault(prev, []).append([start, cp - 1])
            prev = c
            start = cp
    cats.setdefault(prev, []).append([start, maxcp])
    out["categories"] = cats

    json.dump(out, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
