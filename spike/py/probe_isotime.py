#!/usr/bin/env python3
"""Reverse-engineer the C accelerator's parse_isoformat_time by probing
datetime.time.fromisoformat, which uses it directly.

Lib/datetime.py's pure-Python _parse_isoformat_time is NOT what runs; the goal
here is the observable C behaviour.
"""

import datetime

PROBES = [
    "12", "123", "1234", "12345", "123456",
    "12:13", "12:13:14",
    "123+00:00", "12+00:00", "1234+00:00", "12345+00:00",
    "123-05:30",
    "12:13:14.123", "12:13:14.123456", "12:13:14.1234",
    "12.123", "12.123456",
    "12:13.123",
    "1", "", "1x", "12x", "12x13", "12:13x14",
    "12:13:14+00:00", "12:13:14+00:00:00", "12:13:14+00:00:00.000000",
    "12:13:14+00:00:00.0000",
    "24:00", "23:59:59.999999",
    "12:60", "12:13:60",
]

print(f"{'input':<28}{'result':<48}")
print("-" * 78)
for s in PROBES:
    try:
        t = datetime.time.fromisoformat(s)
        print(f"  {s!r:<26} -> {t!r}")
    except Exception as e:  # noqa: BLE001
        print(f"  {s!r:<26} -> {type(e).__name__}: {e}")
