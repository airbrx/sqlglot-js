#!/usr/bin/env python3
"""Unicode differential corpus for the tokenizer — PORT_PLAN.md §3.4 target 3.

  python3 spike/py/gen_tokens_cases.py > spike/out/tokens_fuzz.jsonl

Why a purpose-built generator rather than random bytes
------------------------------------------------------
The harvested corpus is 4 non-ASCII SQL strings out of 8,454 (0.05%). Measured on the
finished port: replacing `pyUpper` with the engine's own `toUpperCase()` — a wrong
answer on 67 code points — leaves **all 23,389 corpus rows byte-identical**, and
replacing code-point length with `.length` is caught by only 2 of them. Those are
`too_wide`-class hazards (§4.6, R4) living inside the tokenizer, and generic fuzzing
does not construct the inputs that reach them. Each generator below targets one
specific decision the scanner makes:

  case_fold     `_scan_keywords` emits `text=word.upper()`, and str.upper() is
                one-to-MANY and version-pinned. 'ﬆRUCT'.upper() == 'STRUCT'.
  astral        every offset in a Token is a code-point offset; a UTF-16 port is
                wrong from the first character outside the BMP.
  py_space      `char.isspace()` gates the whitespace skip, `_scan_var`'s stop
                condition, and `_extract_value`'s strip. Python and JS disagree on
                exactly 6 code points: U+001C-001F and U+0085 (Python-only) and
                U+FEFF (JS-only).
  alnum_edge    `_advance(alnum=True)` runs `isalnum()` on every comment, var and
                value scan, deciding where the token ends.
  ident_edge    `_scan_number` branches on `str.isidentifier()` (XID_Start plus '_').
  uni_digits    `int(text, base)` folds Unicode decimal digits to ASCII, so
                `x'١٠'` is a valid hex string and `0x١٠` is a valid hex number.
  surrogate     lone surrogates round-trip as one code point on both sides.
  soup          random code points as a background, to catch what the above missed.

Lone surrogate PAIRS are excluded and counted, per CONTRACTS.md §8: a Python str can
hold a high then a low surrogate as TWO code points, while the same pair in a JS
string IS one astral character. That case is unrepresentable, not skipped quietly.
"""

import json
import random
import sys
import os

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)

SEED = 20260825
rng = random.Random(SEED)

DIALECTS = ["", "snowflake", "mysql", "postgres", "duckdb", "bigquery", "clickhouse", "hive", "tsql"]


def emit(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":"), ensure_ascii=True) + "\n")


# --------------------------------------------------------------------------- #
# reverse case map: ASCII uppercase run -> code points that upper() into it
# --------------------------------------------------------------------------- #
FOLDS = {}
for cp in range(sys.maxunicode + 1):
    ch = chr(cp)
    up = ch.upper()
    if up != ch and up.isascii() and up.isupper() and up.isalpha():
        FOLDS.setdefault(up, []).append(ch)

# Sanity: the specific folds this port depends on must exist, or the generator is
# silently producing plain-ASCII cases and proving nothing.
REQUIRED = {"S": "ſ", "I": "ı", "ST": "ﬆ", "SS": "ß", "FI": "ﬁ"}
for want_up, want_ch in REQUIRED.items():
    if want_ch not in FOLDS.get(want_up, []):
        sys.exit(f"reverse case map is missing {want_ch!r} -> {want_up!r}")


def case_fold(word):
    """Rewrite an ASCII keyword using characters that upper() back into it."""
    out = []
    i = 0
    while i < len(word):
        # Prefer a multi-character fold (ST, SS, FI) when the next letters allow it.
        for width in (2, 1):
            run = word[i : i + width]
            if run in FOLDS and rng.random() < (0.9 if width == 2 else 0.5):
                out.append(rng.choice(FOLDS[run]))
                i += width
                break
        else:
            out.append(word[i])
            i += 1
    return "".join(out)


# --------------------------------------------------------------------------- #
# generators
# --------------------------------------------------------------------------- #
KEYWORDS = [
    "SELECT", "STRUCT", "FROM", "WHERE", "IS", "IN", "INSERT", "SET", "FIRST",
    "FILTER", "DISTINCT", "CASE", "FALSE", "LIST", "ASC", "INTERSECT", "USING",
]
# str.isspace() is True for these; JS /\s/ disagrees on the first five and would
# additionally accept U+FEFF. Built from code points, never written as literal bytes
# in a source file (tools/lint_control_bytes.mjs, CONTRACTS.md §8).
PY_SPACES = [chr(c) for c in (0x1C, 0x1D, 0x1E, 0x1F, 0x85, 0xA0, 0x2028, 0x2029, 0x3000, 0x0B, 0x0C)]
JS_ONLY_SPACE = "﻿"
ALNUM_EDGE = [chr(c) for c in (0xB2, 0xB3, 0xB9, 0x660, 0x16EE, 0x2160, 0x3007, 0xFF10, 0x1D7CE, 0x0301, 0x00AA)]
IDENT_EDGE = [chr(c) for c in (0x5F, 0x16EE, 0x3007, 0x00AA, 0x0345, 0x2118, 0x212E, 0x1885)]
ASTRAL = [chr(c) for c in (0x10000, 0x1F600, 0x10FFFF, 0x2070E, 0x10400, 0x1D400)]
UNI_DIGITS = ["٠١", "１０", "१०"]

cases = []


def add(dialect, sql, kind):
    cases.append((dialect, sql, kind))


for kw in KEYWORDS:
    for _ in range(6):
        folded = case_fold(kw)
        if folded == kw:
            continue
        add("", f"SELECT 1 {folded} 2", "case_fold")
        add("", f"{folded} x FROM t", "case_fold")
        add("", f"SELECT {folded}", "case_fold")
        add("", f'SELECT "{folded}" FROM {folded}', "case_fold")

for ch in ASTRAL:
    add("", f"SELECT '{ch}' AS {ch}x FROM t{ch}", "astral")
    add("", f'SELECT "{ch}" FROM "a{ch}b"', "astral")
    add("", f"SELECT 1 -- {ch}\nFROM t", "astral")
    add("", f"SELECT /* {ch} */ 1", "astral")
    add("snowflake", f"SELECT $${ch}$$", "astral")
    add("mysql", f"SELECT `{ch}` FROM x", "astral")
    add("", f"SELECT 1{ch}", "astral")

for sp in PY_SPACES + [JS_ONLY_SPACE]:
    add("", f"SELECT{sp}1", "py_space")
    add("", f"SELECT 1{sp}FROM t", "py_space")
    add("", f"SELECT a{sp}b", "py_space")
    add("", f"SELECT 'x'{sp}", "py_space")
    add("", f"SELECT 0x1{sp}2", "py_space")
    add("", f"GROUP{sp}BY x", "py_space")

for ch in ALNUM_EDGE:
    add("", f"SELECT a{ch}b FROM t", "alnum_edge")
    add("", f"SELECT 1 -- x{ch}y\nFROM t", "alnum_edge")
    add("", f"SELECT /* a{ch} */ 1", "alnum_edge")
    add("", f"SELECT 0x{ch}", "alnum_edge")

for ch in IDENT_EDGE:
    add("", f"SELECT 1{ch}", "ident_edge")
    add("", f"SELECT 1{ch}2", "ident_edge")
    add("hive", f"SELECT 1{ch}", "ident_edge")
    add("bigquery", f"SELECT 1{ch}", "ident_edge")

for digits in UNI_DIGITS:
    add("", f"SELECT 0x{digits}", "uni_digits")
    add("", f"SELECT 0b{digits}", "uni_digits")
    add("mysql", f"SELECT x'{digits}'", "uni_digits")
    add("mysql", f"SELECT b'{digits}'", "uni_digits")
    add("", f"SELECT {digits}", "uni_digits")

# Postgres-family dollar-quoted heredocs. `_scan_string` decides between a heredoc
# and the HEREDOC_STRING_ALTERNATIVE fallback with `tag.isdigit()` and
# `any(c.isspace() for c in tag)` — both full-Unicode predicates on a tag taken
# straight from the source. Only reachable on the five dialects whose tokenizer sets
# HEREDOC_TAG_IS_IDENTIFIER, so it is generated explicitly for them.
HEREDOC_DIALECTS = ["duckdb", "postgres", "redshift", "materialize", "risingwave"]
HEREDOC_TAGS = ["1", "٢", "²", "1٢", "ᛮ", "a", "aﬆ", "ſ", "x y", "x" + chr(0x1C) + "y",
                "x" + chr(0xA0) + "y", "", "\U0001F600", "١٠"]
for d in HEREDOC_DIALECTS:
    for tag in HEREDOC_TAGS:
        add(d, f"SELECT ${tag}$body${tag}$", "heredoc")
        add(d, f"SELECT ${tag}$", "heredoc")

for cp in (0xD800, 0xDBFF, 0xDC00, 0xDFFF):
    ch = chr(cp)
    add("", f"SELECT '{ch}'", "surrogate")
    add("", f'SELECT "{ch}" FROM t', "surrogate")
    add("", f"SELECT a{ch}b", "surrogate")

# Adjacent lone-surrogate pairs, so the CONTRACTS.md §8 exclusion below is actually
# exercised rather than being an unarmed guard that reports 0 every run.
for hi, lo in ((0xD800, 0xDC00), (0xDBFF, 0xDFFF), (0xD83D, 0xDE00)):
    pair = chr(hi) + chr(lo)
    add("", f"SELECT '{pair}'", "surrogate_pair")
    add("", f"SELECT a{pair}b", "surrogate_pair")

ALPHABET = (
    [chr(c) for c in range(0x20, 0x7F)]
    + PY_SPACES
    + ALNUM_EDGE
    + IDENT_EDGE
    + ASTRAL
    + [JS_ONLY_SPACE, "'", '"', "`", "$", "\\", "\n", "\r", "\t"]
    + ["SELECT ", "FROM ", "/*", "*/", "--", "::", "$$", "x'", "0x", "{%", "%}"]
)
for _ in range(4000):
    n = rng.randint(1, 14)
    sql = "".join(rng.choice(ALPHABET) for _ in range(n))
    add(rng.choice(DIALECTS), sql, "soup")


def has_surrogate_pair(s):
    """CONTRACTS.md §8 — a high surrogate immediately followed by a low one is two
    Python code points and ONE JS character. Unrepresentable, excluded, counted."""
    for a, b in zip(s, s[1:]):
        if 0xD800 <= ord(a) <= 0xDBFF and 0xDC00 <= ord(b) <= 0xDFFF:
            return True
    return False


def main():
    from sqlglot.dialects.dialect import Dialect
    from sqlglot.errors import SqlglotError
    from sqlglot.jsonpath import JSONPathTokenizer

    tokenizers = {}

    def tokenizer_for(name):
        if name not in tokenizers:
            tokenizers[name] = (
                JSONPathTokenizer() if name == "$jsonpath" else Dialect.get_or_raise(name).tokenizer()
            )
        return tokenizers[name]

    # The JSONPath tokenizer is the only one with NUMBERS_CAN_HAVE_DECIMALS=False.
    for sql in ("$.a.1", "$[0].b", "1.5", "$.a[1].b", "$['x'].y"):
        add("$jsonpath", sql, "jsonpath")

    seen = set()
    excluded = 0
    kinds = {}
    for dialect, sql, kind in cases:
        if has_surrogate_pair(sql):
            excluded += 1
            continue
        key = (dialect, sql)
        if key in seen:
            continue
        seen.add(key)

        row = {"d": dialect, "s": sql, "k": kind}
        try:
            tokens = tokenizer_for(dialect).tokenize(sql)
        except SqlglotError as e:
            row["e"] = [type(e).__name__, str(e)]
        else:
            row["t"] = [
                [t.token_type.name, None if sql[t.start : t.end + 1] == t.text else t.text,
                 t.line, t.col, t.start, t.end] + ([t.comments] if t.comments else [])
                for t in tokens
            ]
        kinds[kind] = kinds.get(kind, 0) + 1
        emit(row)

    # --- _py shim cases: pyUpper / pyIsAlnum / pyIsIdentifierChar / pyIsDigit ---
    probe_cps = set()
    for ch in ALNUM_EDGE + IDENT_EDGE + ASTRAL + PY_SPACES + [JS_ONLY_SPACE]:
        probe_cps.add(ord(ch))
    for lst in FOLDS.values():
        for ch in lst[:4]:
            probe_cps.add(ord(ch))
    for _ in range(6000):
        probe_cps.add(rng.randint(0, sys.maxunicode))
    for cp in sorted(probe_cps):
        ch = chr(cp)
        emit({
            "k": "$char",
            "cp": cp,
            "upper": ch.upper(),
            "isalnum": ch.isalnum(),
            "isidentifier": ch.isidentifier(),
            "isdigit": ch.isdigit(),
            "isspace": ch.isspace(),
        })

    # --- _py shim cases: int(s, base) ---
    INT_ALPHABET = "01239abfxXBo_+- \t ٠１.gz"
    int_probes = ["0b1010", "0xFF", "DEADBEEF", "0b_10", "0b__10", "0b", "0x", "",
                  "١٠", "１０", "de_ad", "0B10", "0X1F", "0o17", "1__0", "10_", "_10"]
    for _ in range(4000):
        n = rng.randint(0, 7)
        int_probes.append("".join(rng.choice(INT_ALPHABET) for _ in range(n)))
    for s in int_probes:
        for base in (2, 16):
            try:
                want = str(int(s, base))
            except ValueError:
                want = None
            emit({"k": "$int", "s": s, "base": base, "want": want})

    print(
        f"  tokens_fuzz: {len(seen)} sql cases "
        f"({', '.join(f'{k}={v}' for k, v in sorted(kinds.items()))}), "
        f"{len(probe_cps)} char probes, {len(int_probes) * 2} int probes; "
        f"{excluded} excluded as lone-surrogate PAIRS (CONTRACTS.md §8)",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
