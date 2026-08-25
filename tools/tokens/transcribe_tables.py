#!/usr/bin/env python3
"""Transcribe tokens.py's SINGLE_TOKENS and KEYWORDS literals to JS, and check them.

  python3 tools/tokens/transcribe_tables.py            # emit the JS entry lines
  python3 tools/tokens/transcribe_tables.py --check     # diff against src/tokens.js

`src/tokens.js` is hand-ported source, not `_gen/`. But two of its literals are 348
mechanical `"KEY": TokenType.X,` lines, and transcribing those by hand is a
transcription-error generator. They were emitted by this script from upstream's SOURCE
TEXT — so line order and inline comments survive verbatim — and `--check` re-derives
them and diffs, which turns "these were transcribed faithfully" from a claim in a PR
into something CI can fail on.

The values are also asserted entry-for-entry against corpus/tokens/settings.json by
tools/tokens/check_streams.mjs. This checks the SOURCE ORDER, which that cannot: a
snapshot of a Python dict cannot distinguish "transcribed in upstream's order" from
"sorted", and §4.6 establishes that table order is observable.
"""

import os
import re
import sys
import pathlib

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
PY = pathlib.Path(REF) / "sqlglot" / "tokens.py"
JS = pathlib.Path("src/tokens.js")

# Upstream line ranges of the two literals (tokens.py @ 91119bc).
SINGLE_TOKENS_END = 154
KEYWORDS_END = 513


def block(src, start_pat, end_line):
    out = []
    inside = False
    for i, line in enumerate(src, 1):
        if re.match(start_pat, line):
            inside = True
            continue
        if inside:
            if i > end_line:
                break
            out.append((i, line))
    return out


def transcribe(src, start_pat, end_line, label):
    lines = []
    for i, line in block(src, start_pat, end_line):
        s = line.strip()
        if s == "}":
            break
        if s.startswith("**"):
            # A dict-comprehension spread. Emitted as a `// py:` marker; the JS spread
            # that replaces it is hand-written and NOT checked here, which is stated
            # rather than glossed over — it is 4 lines and 10 entries, and their values
            # are covered by the settings snapshot.
            lines.append(f"    // py: {s}")
            continue
        if s.startswith("#"):
            lines.append(f"    // {s[1:].strip()}")
            continue
        if s == "HINT_START: TokenType.HINT,":
            lines.append("    [this.HINT_START, TokenType.HINT],")
            continue
        m = re.match(r'^(".*?"|\'.*?\'): TokenType\.(\w+),$', s)
        if not m:
            sys.exit(f"{label} line {i} unparsed: {s!r}")
        key, tt = m.groups()
        # Every key in both literals is an ASCII string whose Python and JS literal
        # spellings are identical, including the escaped backslash and both quote
        # characters. Asserted rather than assumed:
        if "\\" in key and key != '"\\\\"':
            sys.exit(f"{label} line {i}: unexpected escape in key {key!r}")
        lines.append(f"    [{key}, TokenType.{tt}],")
    return lines


def extract_js(marker, end_marker):
    text = JS.read_text().split("\n")
    out = []
    inside = False
    for line in text:
        if marker in line:
            inside = True
            continue
        if inside:
            if line.strip() == end_marker:
                break
            # The hand-written spreads replacing upstream's dict comprehensions.
            if line.strip().startswith("..."):
                continue
            out.append(line.rstrip())
    return out


def main():
    src = PY.read_text().split("\n")
    single = transcribe(src, r"^    SINGLE_TOKENS = \{$", SINGLE_TOKENS_END, "SINGLE_TOKENS")
    keywords = transcribe(
        src, r"^    KEYWORDS: t\.ClassVar\[dict\[str, TokenType\]\] = \{$", KEYWORDS_END, "KEYWORDS"
    )

    if "--check" not in sys.argv:
        print("\n".join(single))
        print()
        print("\n".join(keywords))
        return 0

    bad = 0
    for label, want, marker in (
        ("SINGLE_TOKENS", single, "static SINGLE_TOKENS = new Map(["),
        ("KEYWORDS", keywords, "static KEYWORDS = new Map(["),
    ):
        got = extract_js(marker, "]);")
        if got == want:
            print(f"  ok   {label}: {len(want)} lines match upstream source order")
            continue
        bad += 1
        print(f"  FAIL {label}: {len(got)} JS lines vs {len(want)} transcribed")
        for n, (a, b) in enumerate(zip(want, got)):
            if a != b:
                print(f"       first difference at entry {n}:\n         want {a!r}\n         got  {b!r}")
                break
        else:
            extra = want[len(got):] or got[len(want):]
            print(f"       length differs; first unmatched: {extra[0]!r}")

    print(
        "\n  TABLE TRANSCRIPTION: ok\n"
        if bad == 0
        else f"\n  TABLE TRANSCRIPTION: FAILED ({bad})\n"
    )
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
