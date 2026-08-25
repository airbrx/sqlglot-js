#!/usr/bin/env python3
"""Honest LOC accounting for the P0 calibration spike.

Raw `wc -l` overstates the work badly here: sqlglot/time.py is 688 lines of which
~600 are the TIMEZONES data literal, extracted mechanically. This counts:
  - raw lines
  - code lines (blank + comment + docstring lines removed)
  - data lines (inside the TIMEZONES tuple / generated tables)
"""

import io
import sys
import tokenize


def py_counts(path):
    src = open(path, encoding="utf8").read()
    raw = src.count("\n")
    blank = 0
    comment_lines = set()
    string_only_lines = set()
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
    except tokenize.TokenError:
        toks = []
    for tok in toks:
        if tok.type == tokenize.COMMENT:
            comment_lines.add(tok.start[0])
        elif tok.type == tokenize.STRING:
            # A STRING token that is the only thing on its logical line is a docstring.
            line = tok.line.strip()
            if line.startswith(('"""', "'''", '"', "'")):
                for ln in range(tok.start[0], tok.end[0] + 1):
                    string_only_lines.add(ln)
    lines = src.splitlines()
    code = 0
    for i, line in enumerate(lines, 1):
        s = line.strip()
        if not s:
            blank += 1
            continue
        if i in comment_lines and s.startswith("#"):
            continue
        if i in string_only_lines:
            continue
        code += 1
    return raw, code


def js_counts(path):
    raw = 0
    code = 0
    in_block = False
    for line in open(path, encoding="utf8"):
        raw += 1
        s = line.strip()
        if in_block:
            if "*/" in s:
                in_block = False
            continue
        if not s:
            continue
        if s.startswith("//"):
            continue
        if s.startswith("/*"):
            if "*/" not in s:
                in_block = True
            continue
        code += 1
    return raw, code


PY = [
    "/tmp/sqlglot-ref/sqlglot/time.py",
    "/tmp/sqlglot-ref/sqlglot/helper.py",
    "/tmp/sqlglot-ref/sqlglot/trie.py",
]
JS_PORT = [
    "src/trie.js", "src/time.js", "src/helper.js",
    "src/_py/datetime.js", "src/_py/difflib.js", "src/_py/sort.js",
    "src/_py/errors.js", "src/_py/str.js", "src/_py/num.js",
]
JS_TOOLS = ["tools/gen_timezones.mjs", "tools/gen_unicode_tables.mjs"]
HARNESS = [
    "spike/py/gen_calib_cases.py", "spike/fuzz_calib.mjs",
    "spike/py/recon_calibration.py", "spike/py/recon_isoformat.py",
    "spike/py/probe_iso_edge.py", "spike/py/probe_isotime.py",
    "spike/py/probe_isotime_grid.py",
]

print(f"{'file':<46}{'raw':>8}{'code':>8}")
print("-" * 62)
tot_raw = tot_code = 0
for p in PY:
    r, c = py_counts(p)
    tot_raw += r
    tot_code += c
    print(f"  {p.replace('/tmp/sqlglot-ref/', ''):<44}{r:>8}{c:>8}")
print(f"  {'PYTHON PORTED (upstream)':<44}{tot_raw:>8}{tot_code:>8}\n")

j_raw = j_code = 0
for p in JS_PORT:
    r, c = js_counts(p)
    j_raw += r
    j_code += c
    print(f"  {p:<44}{r:>8}{c:>8}")
print(f"  {'JS HAND-WRITTEN (production)':<44}{j_raw:>8}{j_code:>8}\n")

t_raw = t_code = 0
for p in JS_TOOLS:
    r, c = js_counts(p)
    t_raw += r
    t_code += c
    print(f"  {p:<44}{r:>8}{c:>8}")
print(f"  {'JS CODEGEN TOOLS':<44}{t_raw:>8}{t_code:>8}\n")

h_raw = h_code = 0
for p in HARNESS:
    r, c = (py_counts(p) if p.endswith(".py") else js_counts(p))
    h_raw += r
    h_code += c
    print(f"  {p:<44}{r:>8}{c:>8}")
print(f"  {'DIFFERENTIAL HARNESS + RECON':<44}{h_raw:>8}{h_code:>8}\n")

print(f"  TOTAL AUTHORED THIS TASK{'':<20}{j_raw + t_raw + h_raw:>8}{j_code + t_code + h_code:>8}")
