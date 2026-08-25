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
    # Needed for the *string-level* semantics of islower/isupper: CPython's
    # str.islower() rejects a string containing any titlecase char.
    #
    # NOTE this is the CHARACTER property Py_UNICODE_ISTITLE (category Lt), NOT the
    # string method str.istitle(). They are different: 'A'.istitle() is True because
    # "A" is titlecase-*formatted*, but 'A' is not a titlecase character. Dumping
    # str.istitle() here makes every uppercase char look titlecase, which makes
    # str.isupper() return False for 'A'.
    "istitlechar": lambda c: unicodedata.category(c) == "Lt",
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

    # Cross-check the character-property claim: CPython's str.istitle() on a
    # single char is documented-equivalent to ISUPPER(ch) or ISTITLE(ch). If that
    # identity holds across the whole range, "category == Lt" really is the
    # character property the string predicates need.
    mismatches = []
    for cp in range(maxcp + 1):
        try:
            ch = chr(cp)
            derived = ch.isupper() or (unicodedata.category(ch) == "Lt")
            if bool(ch.istitle()) != bool(derived):
                mismatches.append(cp)
        except (ValueError, UnicodeError):
            pass
    out["istitle_identity_mismatches"] = mismatches

    # Decimal digit values, needed because Python's int()/float() accept any
    # Unicode decimal digit: int('٢٠٢٣') == 2023. Emitted as [start, end, value_at_start]
    # triples; the assertion below pins that the value increments by 1 across a run,
    # which is what makes that encoding lossless.
    dec = []
    run_start = None
    run_val = None
    prev_cp = None
    for cp in range(maxcp + 1):
        try:
            v = unicodedata.decimal(chr(cp))
        except (ValueError, TypeError):
            v = None
        if v is None:
            if run_start is not None:
                dec.append([run_start, prev_cp, run_val])
                run_start = None
            continue
        if run_start is not None and cp == prev_cp + 1 and v == (run_val + (cp - run_start)):
            prev_cp = cp
            continue
        if run_start is not None:
            dec.append([run_start, prev_cp, run_val])
        run_start = cp
        run_val = v
        prev_cp = cp
    if run_start is not None:
        dec.append([run_start, prev_cp, run_val])
    out["decimal_runs"] = dec

    # Verify the encoding round-trips exactly.
    bad = []
    lut = {}
    for s, e, v0 in dec:
        for cp in range(s, e + 1):
            lut[cp] = v0 + (cp - s)
    for cp in range(maxcp + 1):
        try:
            v = unicodedata.decimal(chr(cp))
        except (ValueError, TypeError):
            v = None
        if lut.get(cp) != v:
            bad.append(cp)
    out["decimal_encoding_mismatches"] = bad

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
