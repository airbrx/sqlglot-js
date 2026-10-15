#!/usr/bin/env python3
"""CPython oracle for `sqlglot/dialects/starrocks.py`'s `StarRocks(MySQL)` class.

Same shape as `gen_mysql_dialect_ref.py` (PORT_PLAN.md R42's template), but the base
for the "which settings differ" comparison is `MySQL`, not `Dialect` -- `StarRocks`
extends `MySQL` (AIR-2286 part 2), so a setting StarRocks does NOT override should
read as MySQL's own value, not MySQL's own override of Dialect's default.
`dialects/starrocks.py` is 2 resolved settings (`STRICT_JSON_PATH_SYNTAX`,
`INDEX_OFFSET`) plus a nested Tokenizer adding two keywords (`LARGEINT`, `REFRESH`)
on top of `MySQL.Tokenizer.KEYWORDS`, and declares NO method overrides at all (same as
MySQL's own oracle has no section 4) -- every reachable behavior lives in the settings
and the Tokenizer.

    PYTHONHASHSEED=0 python3 spike/p5/gen_starrocks_dialect_ref.py \
        > spike/out/starrocks_dialect.json
    node spike/p5/fuzz_starrocks_dialect.mjs
"""

import json
import os
import sys

sys.path.insert(0, os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref"))

from sqlglot import expressions as exp  # noqa: E402
from sqlglot.dialects.dialect import Dialect, NormalizationStrategy  # noqa: E402
from sqlglot.dialects.mysql import MySQL  # noqa: E402
from sqlglot.dialects.starrocks import StarRocks  # noqa: E402
from sqlglot.tokens import TokenType  # noqa: E402

TRIE_END = 0

# `EXPRESSION_METADATA` is inherited straight from `MySQL` (no `typing/starrocks.py`
# upstream) -- real (335 entries), but its values are closures/option records `enc()`
# cannot encode, dumped as a COUNT exactly as `gen_mysql_dialect_ref.py` does.
COUNT_ONLY = {"EXPRESSION_METADATA"}


def _sort_key(encoded):
    return json.dumps(encoded, sort_keys=True, separators=(",", ":"))


def enc(v):
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


# RESOLVED, not own: the union of all three classes' names catches a MySQL setting the
# port accidentally shadowed, a StarRocks-declared one that derives to empty, AND a
# Dialect-only setting neither subclass touches.
names = sorted(
    {n for n in vars(StarRocks) if n.isupper()}
    | {n for n in vars(MySQL) if n.isupper()}
    | {n for n in vars(Dialect) if n.isupper()}
)

attrs = {}
overrides = []
for name in names:
    value = getattr(StarRocks, name)
    attrs[name] = {"$count": len(value)} if name in COUNT_ONLY else enc(value)
    if name not in COUNT_ONLY:
        base = getattr(MySQL, name, None)
        try:
            same = base == value
        except Exception:  # noqa: BLE001
            same = False
        if not same:
            overrides.append(name)

# The nested `Tokenizer` subclass, its own declared settings plus the values
# `__init_subclass__` derives.
tk = StarRocks.tokenizer_class
tokenizer = {
    "name": tk.__name__,
    "base": tk.__bases__[0].__name__,
    "KEYWORDS": enc(tk.KEYWORDS),
    "COMMANDS": enc(tk.COMMANDS),
    # Derived by `__init_subclass__`:
    "_QUOTES": enc(tk._QUOTES),
    "_IDENTIFIERS": enc(tk._IDENTIFIERS),
    "_FORMAT_STRINGS": enc(tk._FORMAT_STRINGS),
    "_COMMENTS": enc(tk._COMMENTS),
    "_STRING_ESCAPES": enc(tk._STRING_ESCAPES),
    "_KEYWORD_TRIE_SIZE": len(tk._KEYWORD_TRIE),
    # py:14/17 `KEYWORDS = {**MySQL.Tokenizer.KEYWORDS, "LARGEINT": ..., "REFRESH": ...}`.
    "largeint_is_int128": tk.KEYWORDS.get("LARGEINT") == TokenType.INT128,
    "refresh_is_refresh": tk.KEYWORDS.get("REFRESH") == TokenType.REFRESH,
}

instance = StarRocks()

print(
    json.dumps(
        {
            "attrs": attrs,
            "overrides": overrides,
            "tokenizer": tokenizer,
            "classes": {
                "parser_class": StarRocks.parser_class.__name__,
                "parser_class_module": StarRocks.parser_class.__module__,
                "tokenizer_class": StarRocks.tokenizer_class.__name__,
                "generator_class": StarRocks.generator_class.__name__,
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
