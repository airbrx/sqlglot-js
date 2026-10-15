#!/usr/bin/env python3
"""CPython oracle for `sqlglot/dialects/presto.py`'s `Presto(Dialect)` class.

AIR-2287 (epic AIR-2272, "12.2 Presto family"). Same template R21/R42's
`gen_snowflake_dialect_ref.py` and `gen_dialect_ref.py` (base) established: compare
the RESOLVED attribute (`getattr`, not `vars`), so the probe catches both a missing
OVERRIDE (Presto declares `NULL_ORDERING` and the port forgetting it would silently
inherit the base's "nulls_are_small") and an ACCIDENTAL one (a setting the port added
that upstream leaves inherited). It also covers the values `_Dialect.__new__`
DERIVES rather than reads, and the nested `Tokenizer` subclass, including the two
`KEYWORDS.pop(...)` mutations (`/*+`, `QUALIFY`) made AFTER the merge.

Presto overrides no method (unlike Snowflake's `can_quote`), so this file has no
section 4 — just settings, tokenizer, and the autofilled classes.

    PYTHONHASHSEED=0 python3 spike/p5/gen_presto_dialect_ref.py \
        > spike/out/presto_dialect.json
    node spike/p5/fuzz_presto_dialect.mjs
"""

import json
import os
import sys

sys.path.insert(0, os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref"))

from sqlglot import expressions as exp  # noqa: E402
from sqlglot.dialects.dialect import Dialect, NormalizationStrategy  # noqa: E402
from sqlglot.dialects.presto import Presto  # noqa: E402
from sqlglot.tokens import TokenType  # noqa: E402

TRIE_END = 0

# `EXPRESSION_METADATA` is `sqlglot/typing/presto.py`'s type-inference table (302
# entries: 294 base + 8 Presto-specific). Its values are closures/option records that
# cannot be JSON-encoded, so it is dumped as a COUNT, exactly as `gen_dialect_ref.py`
# and `gen_snowflake_dialect_ref.py` already do for their own tables.
COUNT_ONLY = {"EXPRESSION_METADATA"}


def _sort_key(encoded):
    return json.dumps(encoded, sort_keys=True, separators=(",", ":"))


def enc(v):
    # `TokenType` and `NormalizationStrategy` are checked BEFORE the primitive branch:
    # both derive from `int`/`str`, and the port's own `TokenType` numbering is not
    # asserted to match CPython's anywhere, so comparing by NAME is the only sound
    # encoding (same `$t` wire format `corpus/tokens/settings.json` uses).
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
        return {"$s": sorted((enc(x) for x in v), key=_sort_key)}
    if isinstance(v, dict):
        return {"$d": [["$end" if k is TRIE_END else enc(k), enc(val)] for k, val in v.items()]}
    if isinstance(v, (list, tuple)):
        return [enc(x) for x in v]
    raise TypeError(f"unencodable {type(v)!r}: {v!r}")


# RESOLVED, not own. The union of both classes' names is deliberate: iterating only
# `vars(Presto)` would miss a base setting the port accidentally shadowed, and
# iterating only `vars(Dialect)` would miss a value Presto declares that the base
# derives differently (none here, but the union is the safe default every prior
# dialect oracle used).
names = sorted({n for n in vars(Presto) if n.isupper()} | {n for n in vars(Dialect) if n.isupper()})

attrs = {}
overrides = []
for name in names:
    value = getattr(Presto, name)
    attrs[name] = {"$count": len(value)} if name in COUNT_ONLY else enc(value)
    if name not in COUNT_ONLY:
        base = getattr(Dialect, name, None)
        try:
            same = base == value
        except Exception:  # noqa: BLE001
            same = False
        if not same:
            overrides.append(name)

# The nested `Tokenizer` subclass. Its own declared settings plus the values
# `_TokenizerBase.__init_subclass__` derives, because the port must call
# `initTokenizerSubclass` explicitly (JS has no `__init_subclass__` hook) and skipping
# that call would leave every one of these inherited from the base tokenizer.
tk = Presto.tokenizer_class
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
    "UNICODE_STRINGS": enc(tk.UNICODE_STRINGS),
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
    # py:68-69 `KEYWORDS.pop("/*+")` / `KEYWORDS.pop("QUALIFY")` -- asserted as their
    # own rows rather than left implicit in the KEYWORDS dump, because the interesting
    # consequence (`/*+`) is downstream: HINT_START only reaches `_COMMENTS` when it is
    # present in KEYWORDS.
    "hint_start_in_keywords": tk.HINT_START in tk.KEYWORDS,
    "hint_start_in_comments": tk.HINT_START in tk._COMMENTS,
    "qualify_in_keywords": "QUALIFY" in tk.KEYWORDS,
}

instance = Presto()

print(
    json.dumps(
        {
            "attrs": attrs,
            "overrides": overrides,
            "tokenizer": tokenizer,
            "classes": {
                "parser_class": Presto.parser_class.__name__,
                "parser_class_module": Presto.parser_class.__module__,
                "tokenizer_class": Presto.tokenizer_class.__name__,
                "generator_class": Presto.generator_class.__name__,
                "generator_class_module": Presto.generator_class.__module__,
            },
            "instance": {
                "version": [str(p) for p in instance.version],
                "normalization_strategy": instance.normalization_strategy.name,
            },
        },
        indent=1,
        sort_keys=True,
    )
)
