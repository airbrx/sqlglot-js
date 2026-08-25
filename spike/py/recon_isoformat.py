#!/usr/bin/env python3
"""Does CPython use the C or the pure-Python fromisoformat, and do they differ?

Lib/datetime.py's _parse_isoformat_date uses Python's int(), which accepts
whitespace, signs and non-ASCII decimal digits. The C accelerator uses strict
ASCII digit parsing. If the C module is active (it is, by default) the JS port
must match the C behaviour, not the readable Python source.
"""
import datetime
import sys

print("datetime module file:", datetime.__file__)
print("C accelerator active:", type(datetime.datetime.fromisoformat).__name__,
      getattr(datetime.datetime, "__module__", "?"))
try:
    import _datetime  # noqa: F401
    print("_datetime importable: True")
except ImportError:
    print("_datetime importable: False")

PROBES = [
    " 023-01-01",     # int(' 023') == 23 in pure Python; C rejects
    "+023-01-01",
    "2023-01-01",
    "٢٠٢٣-01-01",     # Arabic-Indic digits: Python int() accepts, C does not
    "2023-0１-01",     # fullwidth digit
    "20 3-01-01",
    "2023-01-0 ",
]
print("\ndate.fromisoformat:")
for s in PROBES:
    try:
        print(f"  {s!r:<18} -> {datetime.date.fromisoformat(s)!r}")
    except Exception as e:  # noqa: BLE001
        print(f"  {s!r:<18} -> {type(e).__name__}: {e}")

print("\ndatetime.fromisoformat (tz '-' before '+' rule, fraction widths):")
DT = [
    "2023-01-01T12:13:14.123",
    "2023-01-01T12:13:14.123456",
    "2023-01-01T12:13:14.1234",
    "2023-01-01T12:13:14+00:00",
    "2023-01-01T12:13:14-00:00",
    "2023-01-01T12:13:14+00:00:00.000000",
    "2023-01-01T12:13:14+00:00:00.0000",
    "2023-01-01T12:13:14+1",
    "2023-01-01T12:13:14+00:0",
    "2023-01-01-12:13:14",     # '-' found first => treated as tz separator
    "2023-01-01T12-13",
    "2023-01-01T1",
    "2023-01-01T12:13:14.000000+05:00",
]
for s in DT:
    try:
        d = datetime.datetime.fromisoformat(s)
        print(f"  {s!r:<38} -> {d!r} micro={d.microsecond}")
    except Exception as e:  # noqa: BLE001
        print(f"  {s!r:<38} -> {type(e).__name__}: {e}")
