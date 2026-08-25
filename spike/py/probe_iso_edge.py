#!/usr/bin/env python3
"""Nail down the exact C-accelerator behaviour for the datetime.fromisoformat
edge cases where the JS port diverged."""

import datetime

CASES = [
    "2023-01-01 ",
    "2023-01-01Z",
    "2023-01-01z",
    "2023-01-01.123+00:00",
    "2023-01-01.123-05:30",
    "2023-01-01.123+00:00:00",
    "2023-01-01.123",
    "2023-01-01.123456",
    "2023-01-01T123",
    "2023-01-01T12:13:14.123+00:00",
    "2023-01-01x",
    "2023-01-01xx",
    "2023-01-01T1",
    "2023-01-01T12",
]

for s in CASES:
    try:
        d = datetime.datetime.fromisoformat(s)
        print(f"  {s!r:<32} -> OK  {d!r}")
    except Exception as e:  # noqa: BLE001
        print(f"  {s!r:<32} -> {type(e).__name__}: {e}")

print("\nDecomposition (what the C impl sees):")
for s in CASES:
    dstr = s[0:10]
    sep = s[10:11]
    tstr = s[11:]
    print(f"  {s!r:<32} dstr={dstr!r} sep={sep!r} tstr={tstr!r} len(tstr)={len(tstr)}")
