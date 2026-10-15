#!/usr/bin/env python3
"""CPython oracle for `sqlglot/dialects/singlestore.py`'s `SingleStore(MySQL)` class.

Same template R105's `gen_trino_dialect_ref.py` established (itself one subclass
level past R104's `gen_mysql_dialect_ref.py`): `SingleStore` extends `MySQL` (not
`Dialect` directly), so the RESOLVED-attribute union walks THREE classes
(`SingleStore` | `MySQL` | `Dialect`) rather than two, catching a base setting the
port accidentally shadowed at EITHER inherited level.

There is no `typing/singlestore.py` upstream, so `EXPRESSION_METADATA` is inherited
verbatim from `MySQL` -- dumped as a COUNT, same reason `gen_trino_dialect_ref.py`
does for Trino's own inherited-from-Presto table.

SingleStore overrides no method on the `Dialect` class itself (its own real logic
lives in `parsers/singlestore.py`/`generators/singlestore.py`, each with its own
corpus-driven coverage), so this file has no section 4, same as `gen_trino_dialect_ref.py`.

    PYTHONHASHSEED=0 python3 spike/p5/gen_singlestore_dialect_ref.py \
        > spike/out/singlestore_dialect.json
    node spike/p5/fuzz_singlestore_dialect.mjs
"""

import json
import os
import sys

sys.path.insert(0, os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref"))

from sqlglot import expressions as exp  # noqa: E402
from sqlglot.dialects.dialect import Dialect, NormalizationStrategy  # noqa: E402
from sqlglot.dialects.mysql import MySQL  # noqa: E402
from sqlglot.dialects.singlestore import SingleStore  # noqa: E402
from sqlglot.tokens import TokenType  # noqa: E402

TRIE_END = 0

# `EXPRESSION_METADATA` is inherited verbatim from `MySQL` (no `typing/singlestore.py`
# exists upstream), but still dumped as a COUNT rather than skipped, same reason every
# oracle in this family does: its values are closures/option records that cannot be
# JSON-encoded. `CAST_TO_TIME6` is a plain function reference (`staticmethod(...)`),
# also uncomparable by value -- dumped as a COUNT-shaped marker (its own name) so the
# JS side only has to assert it resolves to a callable, not byte-match a closure.
COUNT_ONLY = {"EXPRESSION_METADATA"}
FUNC_ONLY = {"CAST_TO_TIME6"}


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


# RESOLVED, not own. The three-way union (`SingleStore` | `MySQL` | `Dialect`) is
# deliberate: SingleStore's own settings overrides are few (SUPPORTS_ORDER_BY_ALL plus
# the MYSQL_INVERSE_TIME_*/CAST_TO_TIME6/TIME_MAPPING/VECTOR_TYPE_ALIASES/
# INVERSE_VECTOR_TYPE_ALIASES tables), so most of the interesting coverage here is
# verifying MySQL's own 9 settings survive unshadowed through ANOTHER level of JS
# static inheritance.
names = sorted(
    {n for n in vars(SingleStore) if n.isupper()}
    | {n for n in vars(MySQL) if n.isupper()}
    | {n for n in vars(Dialect) if n.isupper()}
)

attrs = {}
overrides = []
for name in names:
    value = getattr(SingleStore, name)
    if name in FUNC_ONLY:
        attrs[name] = {"$func": value.__name__}
    elif name in COUNT_ONLY:
        attrs[name] = {"$count": len(value)}
    else:
        attrs[name] = enc(value)
    if name not in COUNT_ONLY and name not in FUNC_ONLY:
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
# that call would leave every one of these inherited from MySQL's own tokenizer.
tk = SingleStore.tokenizer_class
tokenizer = {
    "name": tk.__name__,
    "base": tk.__bases__[0].__name__,
    "QUOTES": enc(tk.QUOTES),
    "COMMENTS": enc(tk.COMMENTS),
    "IDENTIFIERS": enc(tk.IDENTIFIERS),
    "STRING_ESCAPES": enc(tk.STRING_ESCAPES),
    "BYTE_STRINGS": enc(tk.BYTE_STRINGS),
    "BIT_STRINGS": enc(tk.BIT_STRINGS),
    "HEX_STRINGS": enc(tk.HEX_STRINGS),
    "ESCAPE_FOLLOW_CHARS": enc(tk.ESCAPE_FOLLOW_CHARS),
    "NESTED_COMMENTS": tk.NESTED_COMMENTS,
    "KEYWORDS": enc(tk.KEYWORDS),
    "COMMANDS": enc(tk.COMMANDS),
    # Derived by `__init_subclass__`:
    "_QUOTES": enc(tk._QUOTES),
    "_IDENTIFIERS": enc(tk._IDENTIFIERS),
    "_FORMAT_STRINGS": enc(tk._FORMAT_STRINGS),
    "_COMMENTS": enc(tk._COMMENTS),
    "_STRING_ESCAPES": enc(tk._STRING_ESCAPES),
    "_KEYWORD_TRIE_SIZE": len(tk._KEYWORD_TRIE),
    # py:44 `BYTE_STRINGS = [("e'", "'"), ("E'", "'")]` -- SingleStore's own override,
    # MySQL's base Tokenizer has none.
    "byte_strings_differ_from_mysql": tk.BYTE_STRINGS != MySQL.tokenizer_class.BYTE_STRINGS,
    # py:48-59 -- a handful of representative added/replaced keyword entries.
    "bson_in_keywords": "BSON" in tk.KEYWORDS,
    "colon_gt_in_keywords": ":>" in tk.KEYWORDS,
    "ncolon_gt_in_keywords": "!:>" in tk.KEYWORDS,
    "record_in_keywords": "RECORD" in tk.KEYWORDS,
    "timestamp_token_type": tk.KEYWORDS.get("TIMESTAMP").name,
    "timestamp_token_type_in_base_mysql": MySQL.tokenizer_class.KEYWORDS.get("TIMESTAMP").name,
}

instance = SingleStore()

print(
    json.dumps(
        {
            "attrs": attrs,
            "overrides": overrides,
            "tokenizer": tokenizer,
            "vector_type_aliases": enc(SingleStore.VECTOR_TYPE_ALIASES),
            "inverse_vector_type_aliases": enc(SingleStore.INVERSE_VECTOR_TYPE_ALIASES),
            "classes": {
                "parser_class": SingleStore.parser_class.__name__,
                "parser_class_module": SingleStore.parser_class.__module__,
                "parser_class_base": SingleStore.parser_class.__bases__[0].__name__,
                "tokenizer_class": SingleStore.tokenizer_class.__name__,
                "tokenizer_class_base": SingleStore.tokenizer_class.__bases__[0].__name__,
                "generator_class": SingleStore.generator_class.__name__,
                "generator_class_module": SingleStore.generator_class.__module__,
                "generator_class_base": SingleStore.generator_class.__bases__[0].__name__,
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
