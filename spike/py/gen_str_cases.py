#!/usr/bin/env python3
"""String-level differential corpus for str.isprintable/islower/isupper/isspace.

The per-code-point sweep proves the tables; this proves the *string* semantics
layered on them (cased-ness, empty-string handling, astral characters).

Strings are carried as JSON arrays of code points so nothing depends on the
transport's own encoding of lone surrogates.
"""

import json
import random
import sys

SEED = 20260825
N_RANDOM = 40000

# Pools chosen to exercise the cased/uncased interaction, not just ASCII.
POOLS = {
    "ascii": [ord(c) for c in "abcXYZ019 _-"],
    "space": [0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0x1C, 0x1D, 0x1E, 0x1F, 0x85, 0xA0, 0x2028, 0xFEFF],
    "cased": [0x61, 0x41, 0xDF, 0x130, 0x131, 0x1C5, 0x1C8, 0x1CB, 0x1F2, 0x10FC, 0xAB69, 0x2170, 0x2160],
    "astral": [0x10400, 0x10428, 0x1D400, 0x1D41A, 0x1F600, 0x20000, 0x104B0, 0x104D8],
    "weird": [0x00, 0x7F, 0xAD, 0x200B, 0x2028, 0x2029, 0xD800, 0xDFFF, 0xFFFD, 0x10FFFF],
}
ALL = [cp for pool in POOLS.values() for cp in pool]


def emit(cps):
    try:
        s = "".join(chr(cp) for cp in cps)
    except (ValueError, OverflowError):
        return
    try:
        rec = {
            "cps": cps,
            "isprintable": s.isprintable(),
            "islower": s.islower(),
            "isupper": s.isupper(),
            "isspace": s.isspace(),
        }
    except (UnicodeError, ValueError):
        return
    sys.stdout.write(json.dumps(rec, separators=(",", ":")) + "\n")


def main():
    rng = random.Random(SEED)

    emit([])  # empty string: isprintable True, everything else False
    for cp in ALL:
        emit([cp])
    for a in ALL:
        for b in ALL:
            emit([a, b])
    for _ in range(N_RANDOM):
        n = rng.randint(1, 6)
        emit([rng.choice(ALL) for _ in range(n)])
    # fully random code points, including surrogates
    for _ in range(N_RANDOM):
        n = rng.randint(1, 4)
        emit([rng.randint(0, 0x10FFFF) for _ in range(n)])


if __name__ == "__main__":
    main()
