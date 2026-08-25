"""Demonstrate that `\\w` in SAFE_IDENTIFIER_RE is output-visible.

PORT_PLAN.md §4.6 asserts `\\w` maps to `[\\p{L}\\p{Nd}\\p{Nl}\\p{No}_]` "for identifier
quoting specifically", and that this "gates identifier quoting, so it is directly
output-visible". This script checks that claim against the real code rather than
taking it on trust.

Call site under test:
    sqlglot/expressions/core.py:2810   SAFE_IDENTIFIER_RE = re.compile(r"^[_a-zA-Z][\\w]*$")
    sqlglot/expressions/core.py:2843   quoted=not SAFE_IDENTIFIER_RE.match(name) if quoted is None else quoted

Run from a checkout of sqlglot @ 91119bc:
    PYTHONPATH=/tmp/sqlglot-ref-regex python3 spike/py/demo_identifier_quoting.py
"""

import re

import sqlglot
from sqlglot import exp

# py: sqlglot/expressions/core.py:2810, verbatim
PY_SAFE = re.compile(r"^[_a-zA-Z][\w]*$")
# What a port that spells `\w` as a JS `\w` (i.e. [A-Za-z0-9_]) would compute
NAIVE_JS_SAFE = re.compile(r"^[_a-zA-Z][A-Za-z0-9_]*$")
# What PORT_PLAN.md §4.6 prescribes, expressed in Python's own Unicode terms
PLAN_SAFE = re.compile(r"^[_a-zA-Z][^\W]*$")

NAMES = [
    "abc",
    "a1",
    "café",
    "aÊß",
    "aж",
    "naïve_col",
    "a☺",
    "a\U0001F600",
    "a　b",
    "aⅣ",  # Nl  (ROMAN NUMERAL FOUR)
    "a½",  # No  (VULGAR FRACTION ONE HALF)
    "a٠",  # Nd (ARABIC-INDIC DIGIT ZERO)
]


def main() -> None:
    # A bare checkout has no __version__ (it is set by the build), so report the
    # import path instead -- what matters is that this is the pinned clone.
    print(f"sqlglot from {sqlglot.__file__}")
    print()
    # NB: no backslash inside the f-string expression -- CPython 3.9 rejects it.
    header_py = "py " + chr(92) + "w"
    print(f"{'name':14} {header_py:7} {'naive js':9} {'plan':6} {'to_identifier(name).sql()':28}")
    print("-" * 74)
    divergent = []
    for name in NAMES:
        p = bool(PY_SAFE.match(name))
        j = bool(NAIVE_JS_SAFE.match(name))
        pl = bool(PLAN_SAFE.match(name))
        ident = exp.to_identifier(name)
        if p != j:
            divergent.append(name)
        print(f"{name!r:14} {p!s:7} {j!s:9} {pl!s:6} {ident.sql()!r:28}")

    print()
    print("Statement-level effect (exp.column -> to_identifier -> quoted):")
    for name in ["café", "abc"]:
        print("   ", repr(exp.select(exp.column(name)).from_("t").sql()))

    print()
    print("Alias path (Expression.as_ -> to_identifier):")
    for name in ["café", "abc"]:
        sel = sqlglot.parse_one("SELECT x FROM t").selects[0]
        print("   ", repr(sel.as_(name).sql()))

    print()
    print(f"names where a naive JS `\\w` port diverges from CPython: {divergent}")
    plan_ok = all(bool(PY_SAFE.match(n)) == bool(PLAN_SAFE.match(n)) for n in NAMES)
    print(f"PORT_PLAN §4.6 mapping agrees with CPython on every name: {plan_ok}")


if __name__ == "__main__":
    main()
