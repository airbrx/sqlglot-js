#!/usr/bin/env python3
"""Explain the specific code points where the correct \\p{...} candidate still
diverges from CPython, so the diff set in SPIKE_RESULTS.md is enumerated with a
reason rather than just a count."""

import sys
import unicodedata

CPS = [0x10FC, 0xAB69, 0x1C, 0x1D, 0x1E, 0x1F, 0x85, 0xFEFF, 0xA7C1, 0x1C8A]

print(f"CPython {sys.version.split()[0]}  unicodedata {unicodedata.unidata_version}\n")
print(f"{'cp':<10}{'cat':<6}{'bidi':<6}{'islower':<9}{'isupper':<9}{'isspace':<9}"
      f"{'isprint':<9}name")
print("-" * 100)
for cp in CPS:
    ch = chr(cp)
    try:
        name = unicodedata.name(ch)
    except ValueError:
        name = "<unnamed / unassigned in %s>" % unicodedata.unidata_version
    print(
        f"U+{cp:04X}    "
        f"{unicodedata.category(ch):<6}"
        f"{unicodedata.bidirectional(ch) or '-':<6}"
        f"{str(ch.islower()):<9}"
        f"{str(ch.isupper()):<9}"
        f"{str(ch.isspace()):<9}"
        f"{str(ch.isprintable()):<9}"
        f"{name}"
    )
