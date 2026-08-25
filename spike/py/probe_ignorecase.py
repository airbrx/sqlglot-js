"""What does CPython's IGNORECASE do, with and without re.ASCII?

The differential surfaced `\\w+` under re.I|re.A failing on U+017F (LATIN SMALL
LETTER LONG S): CPython does not match, a JS `/[A-Za-z0-9_]+/ui` does, because
JS's `i` flag under `u` applies Unicode simple case folding and folds U+017F to
's'. Before fixing that, pin down exactly which pairs CPython considers equal in
each mode, rather than reasoning from the docs.

    python3 spike/py/probe_ignorecase.py
"""

import re
import sys

# The four non-ASCII letters the CPython docs call out as folding into ASCII
# ranges under Unicode IGNORECASE, plus ordinary accented pairs.
PAIRS = [
    ("s", "ſ", "LATIN SMALL LETTER LONG S"),
    ("k", "K", "KELVIN SIGN"),
    ("i", "İ", "LATIN CAPITAL LETTER I WITH DOT ABOVE"),
    ("i", "ı", "LATIN SMALL LETTER DOTLESS I"),
    ("a", "A", "plain ASCII pair"),
    ("é", "É", "e-acute pair"),
    ("ж", "Ж", "cyrillic zhe pair"),
    ("ß", "ẞ", "sharp s / capital sharp s"),
]

MODES = [
    ("I", re.IGNORECASE),
    ("I|A", re.IGNORECASE | re.ASCII),
]


def main() -> None:
    print(f"CPython {sys.version.split()[0]}\n")
    print(f"{'pattern':>10} {'subject':>10}  {'I':>6} {'I|A':>6}   note")
    print("-" * 62)
    for lo, hi, note in PAIRS:
        row = []
        for _label, flags in MODES:
            row.append(bool(re.fullmatch(re.escape(lo), hi, flags)))
        print(f"{lo!r:>10} {hi!r:>10}  {str(row[0]):>6} {str(row[1]):>6}   {note}")

    print("\nclass ranges under IGNORECASE:")
    print(f"{'pattern':>12} {'subject':>10}  {'I':>6} {'I|A':>6}")
    print("-" * 46)
    for pattern, subject in [
        ("[a-z]", "ſ"), ("[a-z]", "K"), ("[A-Z]", "ſ"),
        ("[a-z]", "A"), ("[A-Z]", "a"), ("[a-z]", "ı"), ("[a-z]", "İ"),
        ("[a-z]", "é"), (r"\w", "ſ"), (r"\w", "é"),
    ]:
        row = [bool(re.fullmatch(pattern, subject, f)) for _l, f in MODES]
        print(f"{pattern:>12} {subject!r:>10}  {str(row[0]):>6} {str(row[1]):>6}")


if __name__ == "__main__":
    main()
