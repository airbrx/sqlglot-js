#!/usr/bin/env python3
"""Differential corpus for the P0 calibration spike (time.py / helper.py / trie.py).

Imports the REAL sqlglot modules from the pinned reference clone, so the oracle is
upstream's own code rather than a reimplementation of it.

  PYTHONPATH=/tmp/sqlglot-ref python3 spike/py/gen_calib_cases.py > spike/out/calib.jsonl
"""

import datetime
import difflib
import json
import random
import sys

sys.path.insert(0, "/tmp/sqlglot-ref")

from sqlglot.time import format_time, subsecond_precision, TIMEZONES  # noqa: E402
from sqlglot.trie import TrieResult, in_trie, new_trie  # noqa: E402
import sqlglot.helper as H  # noqa: E402

SEED = 20260825
rng = random.Random(SEED)


def emit(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":"), ensure_ascii=False) + "\n")


# --------------------------------------------------------------------------- #
# trie
# --------------------------------------------------------------------------- #

TRIE_WORDS = [
    ["bla", "foo", "blab"],
    ["cat"],
    ["%Y", "%m", "%d", "%H", "%M", "%S", "%f"],
    ["0", "00", "000"],          # digit keys: collide with the int-0 marker in JS objects
    ["a0", "0a", "0"],
    ["yyyy", "yy", "y", "mm", "m"],
    ["\U0001F600", "\U0001F600x", "a"],   # astral
    [],
]
TRIE_PROBES = ["bob", "ca", "cat", "", "0", "00", "000", "0000", "a", "%Y", "y", "yy",
               "\U0001F600", "\U0001F600x", "z"]


def dump_trie(t):
    """Serialize a trie to a JSON-safe nested form, distinguishing key 0 from '0'."""
    out = {"end": False, "children": {}}
    for k, v in t.items():
        if k == 0 and isinstance(k, int):
            out["end"] = True
        else:
            out["children"][k] = dump_trie(v)
    return out


for words in TRIE_WORDS:
    t = new_trie(words)
    emit({"k": "trie_build", "words": words, "want": dump_trie(t)})
    for probe in TRIE_PROBES:
        res, sub = in_trie(t, probe)
        emit({"k": "trie_in", "words": words, "probe": probe,
              "want": res.value, "sub": dump_trie(sub)})


# --------------------------------------------------------------------------- #
# format_time
# --------------------------------------------------------------------------- #

MAPPINGS = [
    {"%Y": "yyyy", "%m": "MM", "%d": "dd"},
    {"%Y": "YYYY"},
    {"yyyy": "%Y", "yy": "%y", "mm": "%m", "m": "%-m", "dd": "%d"},
    {"a": "1", "aa": "2", "aaa": "3"},
    {"0": "zero", "00": "double"},
    {"\U0001F600": "smile", "\U0001F600\U0001F600": "two"},
    {},
]
FT_INPUTS = [
    "%Y-%m-%d", "%Y", "", "yyyy-mm-dd", "yyyymmdd", "aaaa", "aa", "a", "aaaaa",
    "000", "00", "0", "0000", "x0y", "\U0001F600", "\U0001F600\U0001F600",
    "\U0001F600x", "no match here", "%Y%Y", "mmm", "yyyyy",
    "café", "naïve %Y", "é%Yé",
]
for mapping in MAPPINGS:
    for s in FT_INPUTS:
        try:
            want = format_time(s, mapping)
        except Exception as e:  # noqa: BLE001
            want = {"__error__": type(e).__name__}
        emit({"k": "format_time", "mapping": mapping, "s": s, "want": want})

# randomized format_time
ALPHABET = "aby0%Y\U0001F600é"
for _ in range(6000):
    keys = list({"".join(rng.choice(ALPHABET) for _ in range(rng.randint(1, 3)))
                 for _ in range(rng.randint(1, 5))})
    mapping = {k: f"<{k}>" for k in keys}
    s = "".join(rng.choice(ALPHABET) for _ in range(rng.randint(0, 10)))
    try:
        want = format_time(s, mapping)
    except Exception as e:  # noqa: BLE001
        want = {"__error__": type(e).__name__}
    emit({"k": "format_time", "mapping": mapping, "s": s, "want": want})


# --------------------------------------------------------------------------- #
# subsecond_precision  (the R6 interpreter-version-dependent one)
# --------------------------------------------------------------------------- #

SS_BASE = ["2023-01-01", "2023-01-01 12:13:14", "2023-01-01T12:13:14",
           "2023-01-01x12:13:14", "1999-12-31T23:59:59"]
SS_FRACS = ["", ".0", ".1", ".12", ".123", ".1234", ".12345", ".123456", ".1234567",
            ".000", ".000000", ".100000", ".000001", ".999999"]
SS_TZ = ["", "Z", "+00:00", "-05:30", "+00:00:00", "+00:00:00.000000", "+0000", "z"]
for b in SS_BASE:
    for f in SS_FRACS:
        for tz in SS_TZ:
            s = b + f + tz
            emit({"k": "subsecond", "s": s, "want": subsecond_precision(s)})

# also feed it junk
for s in ["", "not a date", "2023-13-01", "2023-01-32", "2023-01-01T25:00:00",
          "2023-02-29", "2024-02-29", "0000-01-01", "9999-12-31T23:59:59.999999"]:
    emit({"k": "subsecond", "s": s, "want": subsecond_precision(s)})


# --------------------------------------------------------------------------- #
# is_iso_date / is_iso_datetime  (pyFromIsoFormat acceptance)
# --------------------------------------------------------------------------- #

ISO_PROBES = []
for b in ["2023-01-01", "2023-1-1", "20230101", "2023-01-01 ", " 2023-01-01",
          "0001-01-01", "9999-12-31", "2023-02-29", "2024-02-29", "2023-00-01",
          "2023-01-00", "2023-13-01", "0000-01-01", "٢٠٢٣-01-01", "+023-01-01"]:
    ISO_PROBES.append(b)
for b in SS_BASE:
    for f in SS_FRACS:
        for tz in SS_TZ:
            ISO_PROBES.append(b + f + tz)
# structural fuzz around the separators
for _ in range(4000):
    parts = ["2023", "-", "01", "-", "01", rng.choice("T x-+:"), "12", ":", "13", ":", "14"]
    i = rng.randrange(len(parts))
    parts[i] = rng.choice(["", "1", "-", ":", "+", "x", "0", "99"])
    ISO_PROBES.append("".join(parts))
for s in ISO_PROBES:
    emit({"k": "iso", "s": s, "date": H.is_iso_date(s), "dt": H.is_iso_datetime(s)})


# --------------------------------------------------------------------------- #
# helper: is_int / is_float
# --------------------------------------------------------------------------- #

NUM_STRINGS = [
    "12", " 12 ", "+12", "-12", "1_000", "1__0", "_1", "1_", "12.0", "0x10",
    "٢٠٢٣", "１２", "", " ", "inf", "-inf", "nan", "1e5", "1.5", ".5", "5.",
    "1e", "infinity", "INF", "NaN", "0x1p3", "1\xa0000", "  12  ",
    "²", "①", "1.5e-3", "1_000.5", "--1", "+-1", "1.2.3", "e5", "٣.٥",
    "٠١", "၀၁", "\U0001D7CE\U0001D7CF", "1,000", "1 000",
]
for _ in range(4000):
    n = rng.randint(1, 8)
    NUM_STRINGS.append("".join(rng.choice("0123456789+-._eE ٠١٢xX") for _ in range(n)))
for s in NUM_STRINGS:
    emit({"k": "isnum", "s": s, "is_int": H.is_int(s), "is_float": H.is_float(s)})


# --------------------------------------------------------------------------- #
# helper: get_close_matches (via SequenceMatcher ratios)
# --------------------------------------------------------------------------- #

DIALECTS = ["snowflake", "spark", "spark2", "sqlite", "presto", "postgres", "duckdb",
            "databricks", "bigquery", "mysql", "tsql", "trino", "redshift", "hive",
            "clickhouse", "oracle", "teradata", "athena", "drill", "druid"]
WORDS = ["snowflak", "postgre", "xyz", "DUCKDB", "", "spark", "sparks", "duck",
         "bigquerry", "mysqll", "t-sql", "click", "orcl", "s", "snowflakes",
         "presto2", "hivve", "readshift", "sqlit", "a" * 30]
for w in WORDS:
    for n in (1, 3):
        emit({"k": "close_matches", "word": w, "poss": DIALECTS, "n": n,
              "want": difflib.get_close_matches(w, DIALECTS, n=n)})
    emit({"k": "ratios", "word": w, "poss": DIALECTS,
          "want": [difflib.SequenceMatcher(None, x, w).ratio() for x in DIALECTS],
          "quick": [difflib.SequenceMatcher(None, x, w).quick_ratio() for x in DIALECTS],
          "realquick": [difflib.SequenceMatcher(None, x, w).real_quick_ratio()
                        for x in DIALECTS]})

# randomized ratio fuzz — this is where SequenceMatcher bugs actually show up
ALPHA = "abcdexyz "
for _ in range(6000):
    a = "".join(rng.choice(ALPHA) for _ in range(rng.randint(0, 12)))
    b = "".join(rng.choice(ALPHA) for _ in range(rng.randint(0, 12)))
    emit({"k": "ratio1", "a": a, "b": b,
          "ratio": difflib.SequenceMatcher(None, a, b).ratio(),
          "quick": difflib.SequenceMatcher(None, a, b).quick_ratio(),
          "realquick": difflib.SequenceMatcher(None, a, b).real_quick_ratio(),
          "blocks": [list(m) for m in difflib.SequenceMatcher(None, a, b).get_matching_blocks()]})


# --------------------------------------------------------------------------- #
# helper: misc pure functions
# --------------------------------------------------------------------------- #

for name in ["CamelCase", "camelCase", "ABC", "AbcDEF", "A", "", "aB1C", "Ærø",
             "XMLHttpRequest", "snake_case", "Aa", "aA", "\U0001F600A"]:
    emit({"k": "camel", "s": name, "want": H.camel_to_snake_case(name)})

for value, sep, n, ffs in [
    ("db.table", ".", 3, True), ("db.table", ".", 3, False), ("db.table", ".", 1, True),
    ("a", ".", 5, True), ("", ".", 2, True), ("a.b.c.d", ".", 2, True),
    ("a..b", ".", 4, False), ("x", "", 2, True),
]:
    try:
        want = H.split_num_words(value, sep, n, ffs)
    except Exception as e:  # noqa: BLE001
        want = {"__error__": type(e).__name__}
    emit({"k": "split_num_words", "value": value, "sep": sep, "n": n,
          "fill_from_start": ffs, "want": want})

for taken, base in [(["a"], "a"), ([], "a"), (["a", "a_2"], "a"),
                    (["a", "a_2", "a_3"], "a"), (["b"], "a")]:
    emit({"k": "find_new_name", "taken": taken, "base": base,
          "want": H.find_new_name(set(taken), base)})

for v in ["true", "TRUE", "True", "1", "false", "FALSE", "0", "yes", "", "maybe",
          "TrUe", "Ktrue"]:
    emit({"k": "to_bool", "v": v, "want": H.to_bool(v)})

RANGE_SETS = [
    [[1, 3], [2, 6]], [[1, 2], [3, 4]], [[5, 6], [1, 2]], [],
    [[1, 10], [2, 3], [4, 5]], [[1, 1]], [[1, 3], [3, 5]], [[1, 3], [4, 5], [2, 9]],
]
for _ in range(2000):
    n = rng.randint(0, 6)
    RANGE_SETS.append([sorted((rng.randint(0, 20), rng.randint(0, 20))) for _ in range(n)])
for rs in RANGE_SETS:
    want = [list(x) for x in H.merge_ranges([tuple(r) for r in rs])]
    emit({"k": "merge_ranges", "ranges": rs, "want": want})

DAGS = [
    {"a": ["b"], "b": []},
    {"a": ["b", "c"], "b": ["c"], "c": []},
    {"z": [], "a": [], "m": []},
    {"a": []},
    {},
    {"b": ["a"], "c": ["a"], "a": []},
    {"\U0001F600": [], "z": [], "�": []},   # code-point vs UTF-16 sort order
]
for dag in DAGS:
    d = {k: set(v) for k, v in dag.items()}
    try:
        want = H.tsort(d)
    except Exception as e:  # noqa: BLE001
        want = {"__error__": type(e).__name__}
    emit({"k": "tsort", "dag": dag, "want": want})

for d in [None, {}, {"a": "b"}, {"a": {}}, {"a": {"b": {}}}, {"a": {"b": {"c": 1}}},
          {"a": 1, "b": {"c": {}}}]:
    emit({"k": "dict_depth", "d": d, "want": H.dict_depth(d)})

for args, sep in [(["a", "b"], ", "), (["a", "", "b"], ", "), ([], ", "),
                  (["", ""], ", "), (["a"], " "), (["a", "b", "c"], "|")]:
    emit({"k": "csv", "args": args, "sep": sep, "want": H.csv(*args, sep=sep)})

for seq, idx in [([1, 2, 3], 0), ([1, 2, 3], 2), ([1, 2, 3], 3), ([1, 2, 3], -1),
                 ([1, 2, 3], -3), ([1, 2, 3], -4), ([], 0), ([], -1), ([1, 2, 3], 100)]:
    emit({"k": "seq_get", "seq": seq, "index": idx, "want": H.seq_get(seq, idx)})

emit({"k": "timezones_count", "want": len(TIMEZONES)})
emit({"k": "timezones_sample", "want": sorted(TIMEZONES)[:20]})
emit({"k": "timezones_all_hash", "want": hash(tuple(sorted(TIMEZONES)))})
emit({"k": "timezones_sorted", "want": sorted(TIMEZONES)})
