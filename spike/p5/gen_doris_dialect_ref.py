#!/usr/bin/env python3
"""CPython oracle for `sqlglot/dialects/doris.py`'s `Doris(MySQL)` class.

Same shape as `gen_starrocks_dialect_ref.py` (base for the "which settings differ"
comparison is `MySQL`, not `Dialect`), but `dialects/doris.py` declares NO nested
`Tokenizer` at all -- unlike StarRocks, so upstream's own `_Dialect.__new__` builds a
FRESH, empty subclass of `MySQL.Tokenizer` for it (py:291's own comment in
`registerDialect`), rather than aliasing `MySQL.Tokenizer` directly. The oracle checks
BOTH halves of that: `Doris.tokenizer_class is not MySQL.tokenizer_class` (a real,
distinct class) AND that every derived value on it is identical to MySQL's (since
Doris changes nothing). `dialects/doris.py` is 3 resolved settings (`DATE_FORMAT`,
`DATEINT_FORMAT`, `TIME_FORMAT`) and declares no method overrides either.

    PYTHONHASHSEED=0 python3 spike/p5/gen_doris_dialect_ref.py \
        > spike/out/doris_dialect.json
    node spike/p5/fuzz_doris_dialect.mjs
"""

import json
import os
import sys

sys.path.insert(0, os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref"))

from sqlglot import expressions as exp  # noqa: E402
from sqlglot.dialects.dialect import Dialect, NormalizationStrategy  # noqa: E402
from sqlglot.dialects.doris import Doris  # noqa: E402
from sqlglot.dialects.mysql import MySQL  # noqa: E402
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
    {n for n in vars(Doris) if n.isupper()}
    | {n for n in vars(MySQL) if n.isupper()}
    | {n for n in vars(Dialect) if n.isupper()}
)

attrs = {}
overrides = []
for name in names:
    value = getattr(Doris, name)
    attrs[name] = {"$count": len(value)} if name in COUNT_ONLY else enc(value)
    if name not in COUNT_ONLY:
        base = getattr(MySQL, name, None)
        try:
            same = base == value
        except Exception:  # noqa: BLE001
            same = False
        if not same:
            overrides.append(name)

# No nested Tokenizer upstream -- `tokenizer_class` is a FRESH, empty subclass of
# `MySQL.Tokenizer`, not an alias of it, with every derived value identical to
# MySQL's own (since Doris adds nothing).
tk = Doris.tokenizer_class
mysql_tk = MySQL.tokenizer_class
tokenizer = {
    "name": tk.__name__,
    "is_fresh_subclass": tk is not mysql_tk and issubclass(tk, mysql_tk),
    "base": tk.__bases__[0].__name__,
    "KEYWORDS": enc(tk.KEYWORDS),
    "COMMANDS": enc(tk.COMMANDS),
    "_QUOTES": enc(tk._QUOTES),
    "_IDENTIFIERS": enc(tk._IDENTIFIERS),
    "_FORMAT_STRINGS": enc(tk._FORMAT_STRINGS),
    "_COMMENTS": enc(tk._COMMENTS),
    "_STRING_ESCAPES": enc(tk._STRING_ESCAPES),
    "_KEYWORD_TRIE_SIZE": len(tk._KEYWORD_TRIE),
}

instance = Doris()

print(
    json.dumps(
        {
            "attrs": attrs,
            "overrides": overrides,
            "tokenizer": tokenizer,
            "classes": {
                "parser_class": Doris.parser_class.__name__,
                "parser_class_module": Doris.parser_class.__module__,
                "tokenizer_class": Doris.tokenizer_class.__name__,
                "generator_class": Doris.generator_class.__name__,
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
