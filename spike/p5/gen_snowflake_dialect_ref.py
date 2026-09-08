#!/usr/bin/env python3
"""CPython oracle for `sqlglot/dialects/snowflake.py`'s `Snowflake(Dialect)` class.

PORT_PLAN.md R21 named the hazard this file closes: **a hand-transcribed class-level
VALUE that nothing anywhere compares against upstream.** `dialects/snowflake.py` is
almost nothing BUT such values — 19 setting overrides, a 55-entry `TIME_MAPPING`, a
`DATE_PART_MAPPING` merge, and a nested `Tokenizer` with 33 added keywords — so it is
the purest instance of that shape the port has produced so far. A single wrong entry
would not throw; it would surface much later as an ordinary output MISMATCH in some
dialect that happens to read it, far from its cause.

`spike/p5/gen_dialect_ref.py` does this for the BASE `Dialect` and stops there. This is
the same idea one class down, and it compares the RESOLVED attribute (`getattr`, not
`vars`), which is the load-bearing choice twice over:

  * It catches a missing OVERRIDE — Snowflake declares `NULL_ORDERING` and the port
    forgetting it would silently inherit the base's "nulls_are_small".
  * It catches an ACCIDENTAL override — a setting the port added that upstream leaves
    inherited is just as wrong, and no "did we port every line of the class body?" check
    can see it.

It also covers the twelve values `_Dialect.__new__` DERIVES rather than reads
(`VALID_INTERVAL_UNITS`, `ESCAPED_SEQUENCES`, `INVERSE_TIME_MAPPING`, `QUOTE_START`,
`HEX_START`, `SUPPORTS_COLUMN_JOIN_MARKS`, ...). Reading the upstream class body gives
the wrong answer for every one of them, and three depend on the nested `Tokenizer`
subclass specifically, so they are the sharpest available test that the tokenizer port
landed — `INITCAP_SUPPORTS_CUSTOM_DELIMITERS` in particular, which py:352 turns OFF for
every dialect except "", "bigquery" and "snowflake".

Finally it exercises `can_quote`, the class's one method override, including the DUAL
case that is its entire reason for existing.

    PYTHONHASHSEED=0 python3 spike/p5/gen_snowflake_dialect_ref.py \
        > spike/out/snowflake_dialect.json
    node spike/p5/fuzz_snowflake_dialect.mjs
"""

import json
import os
import sys

sys.path.insert(0, os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref"))

from sqlglot import expressions as exp  # noqa: E402
from sqlglot.dialects.dialect import Dialect, NormalizationStrategy  # noqa: E402
from sqlglot.dialects.snowflake import Snowflake  # noqa: E402
from sqlglot.tokens import TokenType  # noqa: E402

TRIE_END = 0

# `EXPRESSION_METADATA` is `sqlglot/typing/snowflake.py`'s type-inference table (457
# entries for Snowflake, vs 294 for the base Dialect). The `typing/` package and
# `optimizer/annotate_types.py` are unported (P6+). Dumped as a COUNT rather than
# skipped, exactly as `gen_dialect_ref.py` does for the base, so the JS side has to
# state a number and cannot quietly pretend the attribute does not exist.
COUNT_ONLY = {"EXPRESSION_METADATA"}


def _sort_key(encoded):
    return json.dumps(encoded, sort_keys=True, separators=(",", ":"))


def enc(v):
    # `TokenType` and `NormalizationStrategy` are checked BEFORE the primitive branch,
    # not after: both derive from `int`/`str`, so `isinstance(v, (bool, int, float,
    # str))` matches them first and would emit a bare `237` for `TokenType.SHOW`. The
    # port's own `TokenType` is an independent integer table whose numbering is not
    # asserted to match CPython's anywhere, so comparing by NAME (the same `$t` wire
    # format `corpus/tokens/settings.json` uses) is the only sound encoding.
    if isinstance(v, NormalizationStrategy):
        return {"$e": v.name}
    if isinstance(v, TokenType):
        return {"$t": v.name}
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, exp.DType):
        return {"$dtype": v.name}
    if isinstance(v, type):
        return {"$c": v.__name__}
    if isinstance(v, (set, frozenset)):
        # Sorted by the encoded value's canonical JSON, not by the value itself:
        # `Tokenizer.COMMANDS` is a set of `TokenType`, which encodes to a dict and is
        # unorderable in Python. `separators` is pinned to JS `JSON.stringify`'s
        # spelling so the JS side can sort by the identical key.
        return {"$s": sorted((enc(x) for x in v), key=_sort_key)}
    if isinstance(v, dict):
        return {"$d": [["$end" if k is TRIE_END else enc(k), enc(val)] for k, val in v.items()]}
    if isinstance(v, (list, tuple)):
        return [enc(x) for x in v]
    raise TypeError(f"unencodable {type(v)!r}: {v!r}")


# RESOLVED, not own. The union of both classes' names is deliberate: iterating only
# `vars(Snowflake)` would miss a base setting the port accidentally shadowed, and
# iterating only `vars(Dialect)` would miss `INVERSE_TIME_MAPPING`, which Snowflake
# declares and the base derives to empty.
names = sorted({n for n in vars(Snowflake) if n.isupper()} | {n for n in vars(Dialect) if n.isupper()})

attrs = {}
overrides = []
for name in names:
    value = getattr(Snowflake, name)
    attrs[name] = {"$count": len(value)} if name in COUNT_ONLY else enc(value)
    # Which of them actually DIFFER from the base. Not used as an assertion — it is
    # printed by the probe so the port's diff-from-base can be eyeballed against
    # upstream's class body, which is the one thing a value-by-value check cannot show.
    if name not in COUNT_ONLY:
        base = getattr(Dialect, name, None)
        try:
            same = base == value
        except Exception:  # noqa: BLE001
            same = False
        if not same:
            overrides.append(name)

# The nested `Tokenizer` subclass. Its own declared settings plus the four values
# `_TokenizerBase.__init_subclass__` derives, because the port must call
# `initTokenizerSubclass` explicitly (JS has no `__init_subclass__` hook) and skipping
# that call would leave every one of these inherited from the base tokenizer -- which is
# a silent, total failure of the Snowflake lexer that still parses most SQL fine.
tk = Snowflake.tokenizer_class
tokenizer = {
    "name": tk.__name__,
    "base": tk.__bases__[0].__name__,
    "KEYWORDS": enc(tk.KEYWORDS),
    "SINGLE_TOKENS": enc(tk.SINGLE_TOKENS),
    "COMMANDS": enc(tk.COMMANDS),
    "COMMENTS": enc(tk.COMMENTS),
    "STRING_ESCAPES": enc(tk.STRING_ESCAPES),
    "BYTE_STRING_ESCAPES": enc(tk.BYTE_STRING_ESCAPES),
    "HEX_STRINGS": enc(tk.HEX_STRINGS),
    "RAW_STRINGS": enc(tk.RAW_STRINGS),
    "VAR_SINGLE_TOKENS": enc(tk.VAR_SINGLE_TOKENS),
    "NESTED_COMMENTS": tk.NESTED_COMMENTS,
    # Derived by `__init_subclass__`:
    "_QUOTES": enc(tk._QUOTES),
    "_IDENTIFIERS": enc(tk._IDENTIFIERS),
    "_FORMAT_STRINGS": enc(tk._FORMAT_STRINGS),
    "_COMMENTS": enc(tk._COMMENTS),
    "_STRING_ESCAPES": enc(tk._STRING_ESCAPES),
    "_KEYWORD_TRIE_SIZE": len(tk._KEYWORD_TRIE),
    # py:154 `KEYWORDS.pop("/*+")`. Asserted as its own row rather than left implicit in
    # the KEYWORDS dump, because the interesting consequence is downstream: HINT_START
    # only reaches `_COMMENTS` when it is present in KEYWORDS.
    "hint_start_in_keywords": tk.HINT_START in tk.KEYWORDS,
    "hint_start_in_comments": tk.HINT_START in tk._COMMENTS,
    "show_in_commands": TokenType.SHOW in tk.COMMANDS,
}

# py:123 `can_quote` -- the DUAL exception, which is the whole point of the override.
# Every case pairs an identifier with a PARENT, because the override tests
# `isinstance(identifier.parent, exp.Table)` and a bare Identifier takes the base path.
CAN_QUOTE_TEXTS = ["dual", "DUAL", "Dual", "duall", "abc", "ABC", "a b"]


def can_quote_cases():
    rows = []
    d = Snowflake()
    for text in CAN_QUOTE_TEXTS:
        for quoted in (False, True):
            for parent in ("table", "func", None):
                for identify in (True, False, "safe", "unsafe"):
                    ident = exp.Identifier(this=text, quoted=quoted)
                    if parent == "table":
                        exp.Table(this=ident)
                    elif parent == "func":
                        exp.Anonymous(this=ident, expressions=[])
                    try:
                        out = d.can_quote(ident, identify)
                    except ValueError as e:
                        out = {"error": str(e)}
                    rows.append({
                        "text": text, "quoted": quoted, "parent": parent,
                        "identify": identify, "out": out,
                    })
    return rows


instance = Snowflake()

print(
    json.dumps(
        {
            "attrs": attrs,
            "overrides": overrides,
            "tokenizer": tokenizer,
            "classes": {
                "parser_class": Snowflake.parser_class.__name__,
                "parser_class_module": Snowflake.parser_class.__module__,
                "tokenizer_class": Snowflake.tokenizer_class.__name__,
                "generator_class": Snowflake.generator_class.__name__,
                "jsonpath_tokenizer_class": Snowflake.jsonpath_tokenizer_class.__name__,
            },
            "instance": {
                "version": [str(p) for p in instance.version],
                "normalization_strategy": instance.normalization_strategy.name,
            },
            "can_quote": can_quote_cases(),
        },
        indent=1,
        sort_keys=True,
    )
)
