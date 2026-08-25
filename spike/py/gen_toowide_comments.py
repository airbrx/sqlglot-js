#!/usr/bin/env python3
"""Oracles for fuzz_toowide and fuzz_comments — PORT_PLAN.md §3.4 targets 4 and 5.

  python3 spike/py/gen_toowide_comments.py > spike/out/toowide_comments.jsonl

Both targets exist because they are PROVABLY corpus-invisible (review-B O2 / R4):

  too_wide          generator.py uses Python len() = CODE POINTS. A port writing
                    .length (UTF-16 units) passes 15,540/15,540 atoms and is wrong.
                    Instrumentation shows 118 too_wide calls in the dialect suite,
                    12 returning True, and ZERO with any non-ASCII argument.

  sanitize_comment  45 calls in the corpus, all ASCII.

A generic Unicode fuzzer will not construct the straddling case, which is why these
are named targets with purpose-built generators rather than a coverage afterthought.
"""

import json
import random
import sys

sys.path.insert(0, "/tmp/sqlglot-ref")

SEED = 20260825
rng = random.Random(SEED)


def emit(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":"), ensure_ascii=False) + "\n")


# --------------------------------------------------------------------------- #
# too_wide — len() is code points, .length is UTF-16 units
# --------------------------------------------------------------------------- #

# Characters chosen so code-point count and UTF-16 length DIVERGE.
#   BMP  : 1 code point, 1 UTF-16 unit  (no divergence, control)
#   astral: 1 code point, 2 UTF-16 units (divergence)
ASCII = "abcdefghijklmnopqrstuvwxyz"
BMP2 = "éüñ日本語"          # 1 cp, 1 unit each
ASTRAL = "\U0001F600\U0001F601\U00020000\U0001D400"  # 1 cp, 2 units each

WIDTH = 80  # generator.py's default max_text_width


def make_identifiers(n_ident, chars, per_ident):
    return [
        "".join(rng.choice(chars) for _ in range(per_ident)) for _ in range(n_ident)
    ]


cases = []

# Straddle the 80 boundary from both sides, in each alphabet.
for chars, label in ((ASCII, "ascii"), (BMP2, "bmp"), (ASTRAL, "astral")):
    for per_ident in (1, 2, 3, 5, 8):
        for n_ident in range(1, 40):
            idents = make_identifiers(n_ident, chars, per_ident)
            text = ", ".join(idents)
            cases.append({"label": label, "text": text})

# Explicitly hand-built straddlers: exactly 80 code points, but >80 UTF-16 units.
for pad in range(0, 6):
    astral_run = "\U0001F600" * (40 - pad)
    ascii_pad = "a" * (WIDTH - len(astral_run) - pad)
    cases.append({"label": "straddle", "text": astral_run + ascii_pad + "b" * pad})

# Random mixtures.
ALL = ASCII + BMP2 + ASTRAL
for _ in range(4000):
    n = rng.randint(60, 100)
    cases.append({"label": "mixed", "text": "".join(rng.choice(ALL) for _ in range(n))})

for c in cases:
    text = c["text"]
    emit(
        {
            "k": "toowide",
            "label": c["label"],
            "text": text,
            # py: Generator.too_wide is `len(text) > max_text_width`
            "len_codepoints": len(text),
            "too_wide_80": len(text) > WIDTH,
        }
    )


# --------------------------------------------------------------------------- #
# sanitize_comment
# --------------------------------------------------------------------------- #

from sqlglot.generator import Generator  # noqa: E402

sanitize = getattr(Generator, "sanitize_comment", None)

COMMENT_CASES = [
    "", " ", "plain", "with */ inside", "with /* inside", "both /* and */",
    "*/", "/*", "*/*", "/**/", "nested /* a */ b",
    "tab\there", "nl\nhere", "cr\rhere",
    "é comment", "\U0001F600 comment", "日本語 comment",
    "trailing space ", " leading space", "  both  ",
    "\x00nul", "\x1fctrl", " line-sep", " para-sep",
    "﻿bom", " nbsp", "fs", "nel",
    "a" * 200, "*/" * 20,
]
for _ in range(3000):
    n = rng.randint(0, 12)
    alphabet = "ab */\t\n\ré\U0001F600 "
    COMMENT_CASES.append("".join(rng.choice(alphabet) for _ in range(n)))

n_emitted = 0
for c in COMMENT_CASES:
    if sanitize is None:
        break
    try:
        # sanitize_comment is an instance method on some versions; try both.
        try:
            want = sanitize(c)
        except TypeError:
            want = sanitize(Generator(), c)
    except Exception as e:  # noqa: BLE001
        want = {"__error__": type(e).__name__}
    emit({"k": "sanitize_comment", "text": c, "want": want})
    n_emitted += 1

emit({"k": "meta", "sanitize_available": sanitize is not None, "sanitize_cases": n_emitted})
