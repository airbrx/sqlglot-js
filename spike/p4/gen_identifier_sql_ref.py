"""Reference for `Generator.identifier_sql` across the flag space, from CPython at the pin.

    PYTHONHASHSEED=0 python3 spike/p4/gen_identifier_sql_ref.py > spike/out/identifier_sql_ref.json

Why a dedicated oracle when the generate corpus already exists
-------------------------------------------------------------
`identifier_sql` is the hottest method in the generator — the demand trace has it on
10,870 of 15,540 rows — and the corpus reaches almost none of its INTERESTING inputs:
15,540 rows exercise 0.024% non-ASCII text, no empty identifier, and only the default
`normalize=False, identify=False` corner of a 2 x 4 x 2 flag space. Two real defects in
the first port of it were invisible to all 15,540 rows and fell out of this file's first
run: `text[:1]` written with `cpAt` (an INDEX, which raises) instead of `cpSlice` (a
SLICE, which clamps), crashing on `Identifier(this="")`; and the port's
`SAFE_IDENTIFIER_RE` disagreeing with Python's on any non-ASCII word character.

That is the R4/`too_wide` lesson in its general form: a corpus-shaped probe measures what
the corpus happens to contain, and for a method whose whole job is quoting decisions over
arbitrary text, that is not the same as measuring the method.

Also records, per name, whether `SAFE_IDENTIFIER_RE` matched. The probe uses it to tell
the two failure kinds apart: a case whose only difference is that verdict is the KNOWN,
attributed `expressions/core.js` gap; anything else is a hard failure.
"""

import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)

import sqlglot.expressions as exp  # noqa: E402
from sqlglot.expressions.core import SAFE_IDENTIFIER_RE  # noqa: E402
from sqlglot.generator import Generator  # noqa: E402

# Chosen to hit the branches, not to look varied: reserved words, leading digits, the
# quote character itself, an embedded newline (the `_replace_line_breaks` path), the
# empty string, non-ASCII with and without case, a one-to-many uppercase mapping, and
# the two code points where Node's Unicode version disagrees with the pin.
NAMES = [
    "a", "A", "Abc", "x y", "1abc", "_x", "sel ect", '"q"', 'a"b',
    "from", "select", "order", "café", "ÄÖÜ", "᳊" + "x", "ﬆruct", "ǅx", "ıd",
    "αΒγ", "日本", "a.b", "x$1", "", "0", "12", "1e3", "__x__", "T", "très",
    "ß", "İstanbul", "a\nb", "Ünter", "naïve", "_", "a_1", "ΑΣ", "σ",
]

IDENTIFY = [False, True, "safe", "unsafe"]


def main() -> int:
    if os.environ.get("PYTHONHASHSEED") != "0":
        print("refusing to run without PYTHONHASHSEED=0", file=sys.stderr)
        return 2

    cases = []
    for i, name in enumerate(NAMES):
        for normalize in (False, True):
            for identify in IDENTIFY:
                for quoted in (False, True):
                    for pretty in (False, True):
                        gen = Generator(normalize=normalize, identify=identify, pretty=pretty)
                        node = exp.Identifier(this=name, quoted=quoted)
                        try:
                            out = gen.identifier_sql(node)
                        except Exception as err:  # noqa: BLE001
                            out = "ERR:" + type(err).__name__
                        cases.append([i, normalize, identify, quoted, pretty, out])

    json.dump(
        {
            "names": NAMES,
            "safe_identifier_re": [bool(SAFE_IDENTIFIER_RE.match(n)) for n in NAMES],
            "cases": cases,
        },
        sys.stdout,
        separators=(",", ":"),
    )
    print(f"{len(cases)} identifier_sql cases over {len(NAMES)} names", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
