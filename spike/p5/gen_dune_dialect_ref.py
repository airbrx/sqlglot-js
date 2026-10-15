#!/usr/bin/env python3
"""CPython oracle for `sqlglot/dialects/dune.py`'s `Dune(Trino)` class.

AIR-2287 (epic AIR-2272, "12.2 Presto family"), part 2 of the chain, last link
("Dune(Trino)" per the brief). Same template R103/this round's own
`gen_trino_dialect_ref.py` established, one subclass level further: `Dune` extends
`Trino`, which extends `Presto`, so the RESOLVED-attribute union walks FOUR classes
(`Dune` | `Trino` | `Presto` | `Dialect`).

`Dune` declares NO scalar settings override at all — only the three class links
(`Parser`, `Tokenizer`, `Generator`) and one `HEX_STRINGS` override on its nested
`Tokenizer` — so this oracle's own `overrides` list is expected to be empty relative
to `Trino` (every one of Trino's 23 differences-from-base survives unshadowed, and
Dune adds none of its own).

    PYTHONHASHSEED=0 python3 spike/p5/gen_dune_dialect_ref.py \
        > spike/out/dune_dialect.json
    node spike/p5/fuzz_dune_dialect.mjs
"""

import json
import os
import sys

sys.path.insert(0, os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref"))

from sqlglot import expressions as exp  # noqa: E402
from sqlglot.dialects.dialect import Dialect, NormalizationStrategy  # noqa: E402
from sqlglot.dialects.dune import Dune  # noqa: E402
from sqlglot.dialects.presto import Presto  # noqa: E402
from sqlglot.dialects.trino import Trino  # noqa: E402
from sqlglot.tokens import TokenType  # noqa: E402

TRIE_END = 0

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


names = sorted(
    {n for n in vars(Dune) if n.isupper()}
    | {n for n in vars(Trino) if n.isupper()}
    | {n for n in vars(Presto) if n.isupper()}
    | {n for n in vars(Dialect) if n.isupper()}
)

attrs = {}
overrides = []
for name in names:
    value = getattr(Dune, name)
    attrs[name] = {"$count": len(value)} if name in COUNT_ONLY else enc(value)
    if name not in COUNT_ONLY:
        base = getattr(Dialect, name, None)
        try:
            same = base == value
        except Exception:  # noqa: BLE001
            same = False
        if not same:
            overrides.append(name)

# The nested `Tokenizer` subclass.
tk = Dune.tokenizer_class
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
    "_QUOTES": enc(tk._QUOTES),
    "_IDENTIFIERS": enc(tk._IDENTIFIERS),
    "_FORMAT_STRINGS": enc(tk._FORMAT_STRINGS),
    "_COMMENTS": enc(tk._COMMENTS),
    "_STRING_ESCAPES": enc(tk._STRING_ESCAPES),
    "_KEYWORD_TRIE_SIZE": len(tk._KEYWORD_TRIE),
    # py:13 `HEX_STRINGS = ["0x", ("X'", "'")]` — Dune's own only Tokenizer override.
    "has_hex_strings": bool(tk.HEX_STRINGS),
}

instance = Dune()

print(
    json.dumps(
        {
            "attrs": attrs,
            "overrides": overrides,
            "tokenizer": tokenizer,
            "classes": {
                "parser_class": Dune.parser_class.__name__,
                "parser_class_module": Dune.parser_class.__module__,
                "parser_class_base": Dune.parser_class.__bases__[0].__name__,
                "tokenizer_class": Dune.tokenizer_class.__name__,
                "tokenizer_class_base": Dune.tokenizer_class.__bases__[0].__name__,
                "generator_class": Dune.generator_class.__name__,
                "generator_class_module": Dune.generator_class.__module__,
                "generator_class_base": Dune.generator_class.__bases__[0].__name__,
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
