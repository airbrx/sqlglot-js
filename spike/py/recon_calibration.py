#!/usr/bin/env python3
"""Recon for the P0 calibration spike: pin down the exact CPython semantics that
time.py / helper.py depend on, BEFORE writing the JS.

Every one of these is a place where the obvious JS transliteration is wrong.
"""

import datetime
import difflib
import sys

print(f"CPython {sys.version.split()[0]}\n")


def show(label, fn):
    try:
        print(f"  {label:<52} -> {fn()!r}")
    except Exception as e:  # noqa: BLE001
        print(f"  {label:<52} -> {type(e).__name__}: {e}")


print("=== datetime.date.fromisoformat (3.9 grammar) ===")
for s in ["2023-01-01", "20230101", "2023-1-1", "2023-01-01T00:00", "2023-W01-1",
          "0001-01-01", "9999-12-31", "2023-02-29", "2023-01-01 ", "+2023-01-01"]:
    show(f"date.fromisoformat({s!r})", lambda s=s: datetime.date.fromisoformat(s))

print("\n=== datetime.datetime.fromisoformat (3.9 grammar) ===")
for s in [
    "2023-01-01", "2023-01-01 12:13:14", "2023-01-01T12:13:14",
    "2023-01-01x12:13:14", "2023-01-01T12:13:14.123", "2023-01-01T12:13:14.123456",
    "2023-01-01T12:13:14.1234", "2023-01-01T12:13:14.12", "2023-01-01T12:13:14.1",
    "2023-01-01T12:13:14.1234567", "2023-01-01T12:13:14Z", "2023-01-01T12:13:14+00:00",
    "2023-01-01T12:13:14+0000", "2023-01-01T12:13:14+00:00:00",
    "2023-01-01T12:13:14.123456+00:00", "2023-01-01T12", "2023-01-01T12:13",
    "2023-01-01T24:00:00", "2023-01-01T12:13:14-05:30", "2023-01-01T12:13:14.123456-05:30:15",
]:
    show(f"dt.fromisoformat({s!r})", lambda s=s: datetime.datetime.fromisoformat(s))

print("\n=== subsecond_precision (the R6 version-dependent one) ===")
for s in ["2023-01-01 12:13:14.1234", "2023-01-01 12:13:14.123456",
          "2023-01-01 12:13:14Z", "2023-01-01 12:13:14.123", "2023-01-01 12:13:14",
          "2023-01-01 12:13:14.000000", "2023-01-01 12:13:14.100000"]:
    def f(s=s):
        try:
            parsed = datetime.datetime.fromisoformat(s)
            n = len(str(parsed.microsecond).zfill(6).rstrip("0"))
            return 6 if n > 3 else (3 if n > 0 else 0)
        except ValueError:
            return 0
    show(f"subsecond_precision({s!r})", f)

print("\n=== int(str) / float(str) — is_int / is_float ===")
for s in ["12", " 12 ", "+12", "-12", "1_000", "1__0", "_1", "1_", "12.0", "0x10",
          "١٢٣", "１２", "١٢٣", "", " ", "inf", "nan",
          "1e5", "١٢٣.٤", "²", "①", "1 000"]:
    show(f"int({s!r})", lambda s=s: int(s))
for s in ["1.5", " 1.5 ", "inf", "-inf", "nan", "1e5", "1_000.5", "١٢٣.٤",
          "infinity", "INF", "NaN", ".5", "5.", "1e", "", "0x1p3"]:
    show(f"float({s!r})", lambda s=s: float(s))

print("\n=== difflib.get_close_matches (drives error messages) ===")
cases = [
    ("snowflak", ["snowflake", "spark", "sqlite", "presto"]),
    ("postgre", ["postgres", "presto", "prql"]),
    ("xyz", ["snowflake", "spark"]),
    ("DUCKDB", ["duckdb", "databricks"]),
    ("", ["duckdb"]),
    ("spark", ["spark2", "spark", "sparkx"]),
]
for word, poss in cases:
    show(f"get_close_matches({word!r}, {poss})",
         lambda w=word, p=poss: difflib.get_close_matches(w, p, n=1))
    show(f"  ...n=3", lambda w=word, p=poss: difflib.get_close_matches(w, p, n=3))
    show(f"  ...ratios", lambda w=word, p=poss: [
        round(difflib.SequenceMatcher(None, w, x).ratio(), 6) for x in p])

print("\n=== sorted() / tuple compare — tsort, merge_ranges ===")
show("sorted(['b','A','a','B'])", lambda: sorted(["b", "A", "a", "B"]))
show("sorted(['z', '\\U0001F600', '\\uFFFD'])", lambda: sorted(["z", "\U0001F600", "�"]))
show("sorted([(1,3),(1,2),(0,9)])", lambda: sorted([(1, 3), (1, 2), (0, 9)]))
show("sorted(['a10','a2','a1'])", lambda: sorted(["a10", "a2", "a1"]))

print("\n=== list*negative, split, str.lower ===")
show("[None] * -3", lambda: [None] * -3)
show("'db.table'.split('.')", lambda: "db.table".split("."))
show("''.split('.')", lambda: "".split("."))
show("'a..b'.split('.')", lambda: "a..b".split("."))
show("'TRUE'.lower()", lambda: "TRUE".lower())
show("'\\u0130'.lower() (dotted I)", lambda: "İ".lower())
show("'\\u212A'.lower() (Kelvin)", lambda: "K".lower())
show("'\\u1E9E'.lower() (capital sharp s)", lambda: "ẞ".lower())

print("\n=== seq_get negative index ===")
show("[1,2,3][-1]", lambda: [1, 2, 3][-1])
show("[1,2,3][-5]", lambda: [1, 2, 3][-5])

print("\n=== camel_to_snake_case ===")
import re
P = re.compile("(?<!^)(?=[A-Z])")
for n in ["CamelCase", "camelCase", "ABC", "AbcDEF", "A", "", "aB1C", "Ærø"]:
    show(f"camel_to_snake_case({n!r})", lambda n=n: P.sub("_", n).upper())

print("\n=== str.zfill / str.rstrip ===")
show("str(0).zfill(6)", lambda: str(0).zfill(6))
show("str(0).zfill(6).rstrip('0')", lambda: str(0).zfill(6).rstrip("0"))
show("str(100000).zfill(6).rstrip('0')", lambda: str(100000).zfill(6).rstrip("0"))
show("str(123456).zfill(6).rstrip('0')", lambda: str(123456).zfill(6).rstrip("0"))
