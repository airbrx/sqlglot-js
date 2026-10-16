#!/usr/bin/env python3
"""CPython oracle for `sqlglot/dialects/risingwave.py`'s `RisingWave(Postgres)` class.

AIR-2292, epic AIR-2272, "12.7 Small dialects", batch A. Same shape
`gen_redshift_dialect_ref.py` established: the RESOLVED-attribute union walks
`RisingWave` | `Postgres` | `Dialect`, and the nested `Tokenizer` subclass (extending
`Postgres.Tokenizer` directly, adding `SINK`/`SOURCE` keywords) is dumped the same way.
RisingWave declares NO method override on `Dialect` itself (same shape StarRocks/
Doris/SingleStore's own oracles have no section 5) -- every reachable behavior beyond
settings/Tokenizer lives in `parsers/risingwave.py`/`generators/risingwave.py`, each
with its own corpus-driven coverage.

    PYTHONHASHSEED=0 python3 spike/p5/gen_risingwave_dialect_ref.py \
        > spike/out/risingwave_dialect.json
    node spike/p5/fuzz_risingwave_dialect.mjs
"""

import json
import os
import sys

sys.path.insert(0, os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref"))

from sqlglot import expressions as exp  # noqa: E402
from sqlglot.dialects.dialect import Dialect, NormalizationStrategy  # noqa: E402
from sqlglot.dialects.postgres import Postgres  # noqa: E402
from sqlglot.dialects.risingwave import RisingWave  # noqa: E402
from sqlglot.tokens import TokenType  # noqa: E402

TRIE_END = 0

# `EXPRESSION_METADATA` is inherited verbatim from `Postgres` (no `typing/
# risingwave.py` exists upstream), but still dumped as a COUNT for the same reason
# every other oracle in this family does: its values are closures/option records that
# cannot be JSON-encoded.
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


# RESOLVED, not own. The three-way union (`RisingWave` | `Postgres` | `Dialect`) is
# deliberate: RisingWave's own settings overrides are few (NORMALIZE_NOT_NULL,
# REQUIRES_PARENTHESIZED_STRUCT_ACCESS, SUPPORTS_STRUCT_STAR_EXPANSION), so most of
# the interesting coverage here is verifying Postgres's own ~14 settings/Tokenizer
# survive unshadowed through another level of JS static inheritance.
names = sorted(
    {n for n in vars(RisingWave) if n.isupper()}
    | {n for n in vars(Postgres) if n.isupper()}
    | {n for n in vars(Dialect) if n.isupper()}
)

attrs = {}
overrides = []
for name in names:
    value = getattr(RisingWave, name)
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
# that call would leave every one of these inherited from Postgres's own tokenizer.
tk = RisingWave.tokenizer_class
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
    # py:18-19 adds `SINK`/`SOURCE`.
    "sink_in_keywords": "SINK" in tk.KEYWORDS,
    "source_in_keywords": "SOURCE" in tk.KEYWORDS,
    "sink_in_base_postgres_keywords": "SINK" in Postgres.tokenizer_class.KEYWORDS,
    "source_in_base_postgres_keywords": "SOURCE" in Postgres.tokenizer_class.KEYWORDS,
}

instance = RisingWave()

print(
    json.dumps(
        {
            "attrs": attrs,
            "overrides": overrides,
            "tokenizer": tokenizer,
            "classes": {
                "parser_class": RisingWave.parser_class.__name__,
                "parser_class_module": RisingWave.parser_class.__module__,
                "parser_class_base": RisingWave.parser_class.__bases__[0].__name__,
                "tokenizer_class": RisingWave.tokenizer_class.__name__,
                "tokenizer_class_base": RisingWave.tokenizer_class.__bases__[0].__name__,
                "generator_class": RisingWave.generator_class.__name__,
                "generator_class_module": RisingWave.generator_class.__module__,
                "generator_class_base": RisingWave.generator_class.__bases__[0].__name__,
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
