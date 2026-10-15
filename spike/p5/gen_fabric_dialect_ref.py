#!/usr/bin/env python3
"""CPython oracle for `sqlglot/dialects/fabric.py`'s `Fabric(TSQL)` class.

AIR-2292, epic AIR-2272, "12.7 Small dialects", batch A. Same shape
`gen_redshift_dialect_ref.py`/`gen_risingwave_dialect_ref.py` established, but the
chain here is T-SQL rather than Postgres: the RESOLVED-attribute union walks
`Fabric` | `TSQL` | `Dialect`, and the nested `Tokenizer` subclass (extending
`TSQL.Tokenizer` directly, remapping `TIMESTAMP` and adding `UTINYINT`) is dumped the
same way. Fabric declares NO method override on `Dialect` itself (same shape
StarRocks/Doris/SingleStore/Materialize/RisingWave's own oracles have no section 5)
-- every reachable behavior beyond settings/Tokenizer lives in
`parsers/fabric.py`/`generators/fabric.py`, each with its own corpus-driven coverage.

    PYTHONHASHSEED=0 python3 spike/p5/gen_fabric_dialect_ref.py \
        > spike/out/fabric_dialect.json
    node spike/p5/fuzz_fabric_dialect.mjs
"""

import json
import os
import sys

sys.path.insert(0, os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref"))

from sqlglot import expressions as exp  # noqa: E402
from sqlglot.dialects.dialect import Dialect, NormalizationStrategy  # noqa: E402
from sqlglot.dialects.tsql import TSQL  # noqa: E402
from sqlglot.dialects.fabric import Fabric  # noqa: E402
from sqlglot.tokens import TokenType  # noqa: E402

TRIE_END = 0

# `EXPRESSION_METADATA` is inherited verbatim from `TSQL` (no `typing/fabric.py`
# exists upstream), but still dumped as a COUNT for the same reason every other
# oracle in this family does: its values are closures/option records that cannot be
# JSON-encoded.
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


# RESOLVED, not own. The three-way union (`Fabric` | `TSQL` | `Dialect`) is
# deliberate: Fabric's own settings override is a single scalar
# (`NORMALIZATION_STRATEGY`), so most of the interesting coverage here is verifying
# TSQL's own ~10 settings/Tokenizer survive unshadowed through another level of JS
# static inheritance.
names = sorted(
    {n for n in vars(Fabric) if n.isupper()}
    | {n for n in vars(TSQL) if n.isupper()}
    | {n for n in vars(Dialect) if n.isupper()}
)

attrs = {}
overrides = []
for name in names:
    value = getattr(Fabric, name)
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
# that call would leave every one of these inherited from TSQL's own tokenizer.
tk = Fabric.tokenizer_class
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
    # py:40 remaps TIMESTAMP (T-SQL's own KEYWORDS already has it mapped to
    # ROWVERSION); py:41 adds UTINYINT (absent from T-SQL's own KEYWORDS).
    "timestamp_token": tk.KEYWORDS.get("TIMESTAMP").name,
    "utinyint_in_keywords": "UTINYINT" in tk.KEYWORDS,
    "timestamp_token_in_base_tsql_keywords": TSQL.tokenizer_class.KEYWORDS.get("TIMESTAMP").name,
    "utinyint_in_base_tsql_keywords": "UTINYINT" in TSQL.tokenizer_class.KEYWORDS,
}

instance = Fabric()

print(
    json.dumps(
        {
            "attrs": attrs,
            "overrides": overrides,
            "tokenizer": tokenizer,
            "classes": {
                "parser_class": Fabric.parser_class.__name__,
                "parser_class_module": Fabric.parser_class.__module__,
                "parser_class_base": Fabric.parser_class.__bases__[0].__name__,
                "tokenizer_class": Fabric.tokenizer_class.__name__,
                "tokenizer_class_base": Fabric.tokenizer_class.__bases__[0].__name__,
                "generator_class": Fabric.generator_class.__name__,
                "generator_class_module": Fabric.generator_class.__module__,
                "generator_class_base": Fabric.generator_class.__bases__[0].__name__,
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
