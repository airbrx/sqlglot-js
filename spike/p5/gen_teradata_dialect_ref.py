#!/usr/bin/env python3
"""CPython oracle for `sqlglot/dialects/teradata.py`'s `Teradata(Dialect)` class.

AIR-2291 (epic AIR-2272, "12.6 SQLite + Teradata"). Same template R21/R42/R103's
`gen_presto_dialect_ref.py` established: compare the RESOLVED attribute (`getattr`,
not `vars`), so the probe catches both a missing OVERRIDE and an ACCIDENTAL one. It
also covers the nested `Tokenizer` subclass, including its one post-merge
`KEYWORDS.pop("/*+")` mutation and its `SINGLE_TOKENS.pop("%")` mutation (Teradata
does not support `%` as a modulo operator).

Teradata overrides no method on the `Dialect` class itself (unlike ClickHouse's
`generate_values_aliases`), so this file has no section 4 — just settings,
tokenizer, and the autofilled classes.

    PYTHONHASHSEED=0 python3 spike/p5/gen_teradata_dialect_ref.py \
        > spike/out/teradata_dialect.json
    node spike/p5/fuzz_teradata_dialect.mjs
"""

import json
import os
import sys

sys.path.insert(0, os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref"))

from sqlglot import expressions as exp  # noqa: E402
from sqlglot.dialects.dialect import Dialect, NormalizationStrategy  # noqa: E402
from sqlglot.dialects.teradata import Teradata  # noqa: E402
from sqlglot.tokens import TokenType  # noqa: E402

TRIE_END = 0

# `EXPRESSION_METADATA` has no `typing/teradata.py` upstream, so `Teradata` inherits
# the base `Dialect`'s own 294-entry table verbatim. Still dumped as a COUNT (not a
# value comparison) because its values are closures/option records that cannot be
# JSON-encoded — same unencodable-lambda problem every prior dialect oracle's own
# `COUNT_ONLY` set solves.
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
# `vars(Teradata)` would miss a base setting the port accidentally shadowed, and
# iterating only `vars(Dialect)` would miss a value Teradata declares that the base
# derives differently.
names = sorted({n for n in vars(Teradata) if n.isupper()} | {n for n in vars(Dialect) if n.isupper()})

attrs = {}
overrides = []
for name in names:
    value = getattr(Teradata, name)
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
tk = Teradata.tokenizer_class
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
    # py:73 `KEYWORDS.pop("/*+")` -- asserted as its own row rather than left implicit
    # in the KEYWORDS dump, because the interesting consequence is downstream:
    # HINT_START only reaches `_COMMENTS` when it is present in KEYWORDS.
    "hint_start_in_keywords": tk.HINT_START in tk.KEYWORDS,
    "hint_start_in_comments": tk.HINT_START in tk._COMMENTS,
    # py:75-77 `SINGLE_TOKENS.pop("%")` -- Teradata does not support % as a modulo
    # operator. Asserted as its own row for the same reason the KEYWORDS pop is.
    "percent_in_single_tokens": "%" in tk.SINGLE_TOKENS,
}

instance = Teradata()

print(
    json.dumps(
        {
            "attrs": attrs,
            "overrides": overrides,
            "tokenizer": tokenizer,
            "classes": {
                "parser_class": Teradata.parser_class.__name__,
                "parser_class_module": Teradata.parser_class.__module__,
                "tokenizer_class": Teradata.tokenizer_class.__name__,
                "generator_class": Teradata.generator_class.__name__,
                "generator_class_module": Teradata.generator_class.__module__,
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
