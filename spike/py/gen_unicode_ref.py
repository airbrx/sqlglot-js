#!/usr/bin/env python3
"""Dump CPython's per-code-point classification over the FULL sys.maxunicode range.

PORT_PLAN.md §7 P0 item 1 / §3.4 target 3 / §4.6 "Strings".

Covers 0 .. sys.maxunicode inclusive (1,114,112 code points) — not a sample.
Output is run-length encoded (ranges where the predicate is True) so the file
stays small; JS reconstructs the exact same predicate from it.

Note on surrogates: chr(0xD800..0xDFFF) yields a lone surrogate str in CPython.
The predicates are well-defined on those and are included, because sqlglot can
be handed such strings (e.g. via a surrogate escape) and JS strings can contain
them natively.
"""

import json
import sys
import unicodedata

PREDICATES = {
    "isprintable": lambda c: c.isprintable(),
    "islower": lambda c: c.islower(),
    "isupper": lambda c: c.isupper(),
    "isspace": lambda c: c.isspace(),
    # Needed for the *string-level* semantics of islower/isupper: CPython's
    # str.islower() rejects a string containing any titlecase char.
    #
    # NOTE this is the CHARACTER property Py_UNICODE_ISTITLE (category Lt), NOT the
    # string method str.istitle(). They are different: 'A'.istitle() is True because
    # "A" is titlecase-*formatted*, but 'A' is not a titlecase character. Dumping
    # str.istitle() here makes every uppercase char look titlecase, which makes
    # str.isupper() return False for 'A'.
    "istitlechar": lambda c: unicodedata.category(c) == "Lt",
    # --- added at P1: the four predicates sqlglot/tokenizer_core.py reaches ---
    #
    # `_advance(alnum=True)` (tokenizer_core.py:741,748) runs isalnum() on the current
    # and peeked character on every comment, var and quoted-value scan; `_scan_number`
    # (:970) branches on isidentifier(); `_scan_string` (:1062) calls isdigit() on a
    # heredoc tag. All three decide token boundaries, so all three are output-visible.
    "isalnum": lambda c: c.isalnum(),
    # str.isidentifier() on a SINGLE character is Py_UNICODE_ISIDSTART, i.e. XID_Start
    # plus '_'. tokenizer_core.py:970 only ever calls it on `self._peek`, which is one
    # code point or "". `"".isidentifier()` is False and is handled by the caller.
    "isidentifier": lambda c: c.isidentifier(),
    "isdigit": lambda c: c.isdigit(),
}


def rle(flags):
    """[bool] -> [[start, end], ...] inclusive ranges where flag is True."""
    ranges = []
    start = None
    for cp, v in enumerate(flags):
        if v and start is None:
            start = cp
        elif not v and start is not None:
            ranges.append([start, cp - 1])
            start = None
    if start is not None:
        ranges.append([start, len(flags) - 1])
    return ranges


def main():
    maxcp = sys.maxunicode  # 0x10FFFF
    out = {
        "python_version": sys.version.split()[0],
        "unidata_version": unicodedata.unidata_version,
        "maxunicode": maxcp,
        "predicates": {},
        "counts": {},
    }

    for name, fn in PREDICATES.items():
        flags = [False] * (maxcp + 1)
        for cp in range(maxcp + 1):
            try:
                flags[cp] = bool(fn(chr(cp)))
            except (ValueError, UnicodeError):
                flags[cp] = False
        out["predicates"][name] = rle(flags)
        out["counts"][name] = sum(flags)

    # Cross-check the character-property claim: CPython's str.istitle() on a
    # single char is documented-equivalent to ISUPPER(ch) or ISTITLE(ch). If that
    # identity holds across the whole range, "category == Lt" really is the
    # character property the string predicates need.
    mismatches = []
    for cp in range(maxcp + 1):
        try:
            ch = chr(cp)
            derived = ch.isupper() or (unicodedata.category(ch) == "Lt")
            if bool(ch.istitle()) != bool(derived):
                mismatches.append(cp)
        except (ValueError, UnicodeError):
            pass
    out["istitle_identity_mismatches"] = mismatches

    # Decimal digit values, needed because Python's int()/float() accept any
    # Unicode decimal digit: int('٢٠٢٣') == 2023. Emitted as [start, end, value_at_start]
    # triples; the assertion below pins that the value increments by 1 across a run,
    # which is what makes that encoding lossless.
    dec = []
    run_start = None
    run_val = None
    prev_cp = None
    for cp in range(maxcp + 1):
        try:
            v = unicodedata.decimal(chr(cp))
        except (ValueError, TypeError):
            v = None
        if v is None:
            if run_start is not None:
                dec.append([run_start, prev_cp, run_val])
                run_start = None
            continue
        if run_start is not None and cp == prev_cp + 1 and v == (run_val + (cp - run_start)):
            prev_cp = cp
            continue
        if run_start is not None:
            dec.append([run_start, prev_cp, run_val])
        run_start = cp
        run_val = v
        prev_cp = cp
    if run_start is not None:
        dec.append([run_start, prev_cp, run_val])
    out["decimal_runs"] = dec

    # Verify the encoding round-trips exactly.
    bad = []
    lut = {}
    for s, e, v0 in dec:
        for cp in range(s, e + 1):
            lut[cp] = v0 + (cp - s)
    for cp in range(maxcp + 1):
        try:
            v = unicodedata.decimal(chr(cp))
        except (ValueError, TypeError):
            v = None
        if lut.get(cp) != v:
            bad.append(cp)
    out["decimal_encoding_mismatches"] = bad

    # General_Category per code point, RLE'd by category name. This lets the JS side
    # explain *why* a divergence happened (unassigned-in-13.0 vs assigned-in-15.x)
    # rather than just reporting a count.
    cats = {}
    prev = None
    start = 0
    for cp in range(maxcp + 1):
        try:
            c = unicodedata.category(chr(cp))
        except (ValueError, UnicodeError):
            c = "Cn"
        if c != prev:
            if prev is not None:
                cats.setdefault(prev, []).append([start, cp - 1])
            prev = c
            start = cp
    cats.setdefault(prev, []).append([start, maxcp])
    out["categories"] = cats

    # str.upper(), per code point, for every code point where it is not the identity.
    #
    # Added at P1. `str.upper()` is NOT safe to delegate to JS `toUpperCase()`: it is
    # bound to the engine's Unicode version exactly as `\p{...}` is, and Node v22
    # (Unicode 16.0) disagrees with CPython 3.9.25 (unicodedata 13.0.0) on 67 code
    # points — U+019B, U+0264, U+1C8A, U+2C5F, ten of U+A7Cx-A7Dx, and the 54-point
    # Vithkuqi block U+10570-105BC, all of which gained an uppercase mapping after 13.0.
    #
    # It reaches token TEXT, not just token type: tokenizer_core.py:853 emits
    # `text=word.upper()` for every matched keyword, and :1119 uppercases arbitrary
    # source text to look it up in KEYWORDS. The mapping is 1-to-MANY ('ß' -> 'SS',
    # 'ﬆ' -> 'ST', so 'ﬆRUCT'.upper() == 'STRUCT' and tokenizes as TokenType.STRUCT),
    # so this is a code-point -> string map, not a code-point -> code-point map.
    upper = {}
    for cp in range(maxcp + 1):
        try:
            ch = chr(cp)
        except (ValueError, UnicodeError):
            continue
        u = ch.upper()
        if u != ch:
            upper[cp] = u
    out["upper_map"] = [[cp, s] for cp, s in sorted(upper.items())]

    # str.upper() is documented as a full, per-character mapping with no context
    # sensitivity (unlike str.lower()'s final-sigma rule). Assert that here rather than
    # trusting it: if any string's upper() differs from the concatenation of its
    # characters' upper(), the per-code-point table above is not a faithful model.
    probes = [
        "ß", "ﬆRUCT", "ΣΣ", "ΑΣ", "aßb", "İ", "ǰ", "ﬄ", "ᾨ", "İı",
        "SELECT", "select", "ſelect", "ıd", "ǅ", "ǆx",
    ]
    ctx = [
        p for p in probes if p.upper() != "".join(chr(c).upper() for c in map(ord, p))
    ]
    out["upper_context_sensitive"] = ctx

    # str.lower(), per code point, same shape and same reason as upper_map above.
    #
    # Added at P4, which is where PORT_PLAN.md R20 said it had to land: the Dialect port
    # left `normalize_identifier` an announced stub (dialects/dialect.js:1028) precisely
    # because `_py/str.js` had `pyUpper` and no `pyLower`, and `Generator.identifier_sql`
    # is the caller that makes it real. Measured over the full range against this
    # interpreter: JS `toLowerCase()` maps 67 code points that CPython 3.9.25 does not —
    # the same 67 the upper table exists for — and identifier normalization is directly
    # output-visible, so `toLowerCase()` is the R4 `too_wide` hazard exactly (it passes
    # every one of the 15,540 corpus rows and is still wrong).
    lower = {}
    for cp in range(maxcp + 1):
        try:
            ch = chr(cp)
        except (ValueError, UnicodeError):
            continue
        low = ch.lower()
        if low != ch:
            lower[cp] = low
    out["lower_map"] = [[cp, s] for cp, s in sorted(lower.items())]

    # UNLIKE str.upper(), str.lower() IS context-sensitive, so the assertion above is not
    # merely a formality here — it fires. CPython's `handle_capital_sigma`
    # (unicodeobject.c) lowercases U+03A3 to final sigma U+03C2 rather than U+03C3 when
    # it stands at the end of a word, which a per-code-point table cannot express.
    #
    # This sweeps the WHOLE range in five contexts rather than a probe list, because the
    # table's faithfulness claim is "every code point except the ones listed here", and
    # a hand-written probe list cannot support that quantifier. Measured at the pin the
    # answer is exactly one code point, U+03A3; `pyLower` refuses to guess on that one.
    ctx_sensitive = []
    for cp in range(maxcp + 1):
        if 0xD800 <= cp <= 0xDFFF:
            continue
        ch = chr(cp)
        iso = ch.lower()
        for before, after in (("A", ""), ("", "A"), ("A", "A"), ("Α", ""), ("", "Α")):
            if (before + ch + after).lower() != before.lower() + iso + after.lower():
                ctx_sensitive.append(cp)
                break
    out["lower_context_sensitive"] = ctx_sensitive

    json.dump(out, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
