#!/usr/bin/env python3
"""CPython oracle for `sqlglot/dialects/prql.py`'s `PRQL(Dialect)` class.

AIR-2292 (epic AIR-2272, "12.7 Small dialects", batch B). Same template
R21/R42/R103/R109's `gen_snowflake_dialect_ref.py`/`gen_exasol_dialect_ref.py`
established: compare the RESOLVED attribute (`getattr`, not `vars`).

This covers only the SETTINGS surface -- the real grammar fidelity (PRQL's
whole pipeline-to-SQL transform) is covered by the differential parse/generate
corpus and by `spike/p5/fuzz_prql_pipeline.mjs` (every assertion in upstream's
own `tests/dialects/test_prql.py`), not by this file.

PRQL overrides no method on the `Dialect` class itself, so this file has no
section 4, same shape Presto's/Exasol's/Solr's/Druid's/DAX's/Tableau's/Drill's
own oracle used.

There is no `typing/prql.py` upstream, so `EXPRESSION_METADATA` is the bare
base 294-entry table.

    PYTHONHASHSEED=0 python3 spike/p5/gen_prql_dialect_ref.py \
        > spike/out/prql_dialect.json
    node spike/p5/fuzz_prql_dialect.mjs
"""

import json
import os
import sys

sys.path.insert(0, os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref"))

from sqlglot import expressions as exp  # noqa: E402
from sqlglot.dialects.dialect import Dialect, NormalizationStrategy  # noqa: E402
from sqlglot.dialects.prql import PRQL  # noqa: E402
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


names = sorted({n for n in vars(PRQL) if n.isupper()} | {n for n in vars(Dialect) if n.isupper()})

attrs = {}
overrides = []
for name in names:
    value = getattr(PRQL, name)
    attrs[name] = {"$count": len(value)} if name in COUNT_ONLY else enc(value)
    if name not in COUNT_ONLY:
        base = getattr(Dialect, name, None)
        try:
            same = base == value
        except Exception:  # noqa: BLE001
            same = False
        if not same:
            overrides.append(name)

tk = PRQL.tokenizer_class
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
    "IDENTIFIERS": enc(tk.IDENTIFIERS),
    "_QUOTES": enc(tk._QUOTES),
    "_IDENTIFIERS": enc(tk._IDENTIFIERS),
    "_FORMAT_STRINGS": enc(tk._FORMAT_STRINGS),
    "_COMMENTS": enc(tk._COMMENTS),
    "_STRING_ESCAPES": enc(tk._STRING_ESCAPES),
    "_KEYWORD_TRIE_SIZE": len(tk._KEYWORD_TRIE),
}

instance = PRQL()

print(
    json.dumps(
        {
            "attrs": attrs,
            "overrides": overrides,
            "tokenizer": tokenizer,
            "classes": {
                "parser_class": PRQL.parser_class.__name__,
                "parser_class_module": PRQL.parser_class.__module__,
                "tokenizer_class": PRQL.tokenizer_class.__name__,
                "generator_class": PRQL.generator_class.__name__,
                "generator_class_module": PRQL.generator_class.__module__,
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
