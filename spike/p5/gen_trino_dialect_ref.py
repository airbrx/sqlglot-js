#!/usr/bin/env python3
"""CPython oracle for `sqlglot/dialects/trino.py`'s `Trino(Presto)` class.

AIR-2287 (epic AIR-2272, "12.2 Presto family"), part 2 of the chain. Same template
R103's `gen_presto_dialect_ref.py` established, one subclass level further: `Trino`
extends `Presto` (not `Dialect` directly), so the RESOLVED-attribute union walks
THREE classes (`Trino` | `Presto` | `Dialect`) rather than two, catching a base
setting the port accidentally shadowed at EITHER inherited level.

Trino overrides no method on the `Dialect` class itself (its own real logic lives in
`parsers/trino.py`/`generators/trino.py`, each with its own corpus-driven coverage),
so this file has no section 4 — just settings, tokenizer, and the autofilled classes.

    PYTHONHASHSEED=0 python3 spike/p5/gen_trino_dialect_ref.py \
        > spike/out/trino_dialect.json
    node spike/p5/fuzz_trino_dialect.mjs
"""

import json
import os
import sys

sys.path.insert(0, os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref"))

from sqlglot import expressions as exp  # noqa: E402
from sqlglot.dialects.dialect import Dialect, NormalizationStrategy  # noqa: E402
from sqlglot.dialects.presto import Presto  # noqa: E402
from sqlglot.dialects.trino import Trino  # noqa: E402
from sqlglot.tokens import TokenType  # noqa: E402

TRIE_END = 0

# `EXPRESSION_METADATA` is inherited verbatim from `Presto` (no `typing/trino.py`
# exists upstream), but still dumped as a COUNT for the same reason every other
# oracle in this family does: its values are closures/option records that cannot be
# JSON-encoded.
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


# RESOLVED, not own. The three-way union (`Trino` | `Presto` | `Dialect`) is
# deliberate: Trino's own settings overrides are few (SUPPORTS_USER_DEFINED_TYPES,
# LOG_BASE_FIRST, CONCAT_WS_COALESCE), so most of the interesting coverage here is
# verifying Presto's own 11 settings/2 borrowed tables survive unshadowed through
# ANOTHER level of JS static inheritance.
names = sorted(
    {n for n in vars(Trino) if n.isupper()}
    | {n for n in vars(Presto) if n.isupper()}
    | {n for n in vars(Dialect) if n.isupper()}
)

attrs = {}
overrides = []
for name in names:
    value = getattr(Trino, name)
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
# that call would leave every one of these inherited from Presto's own tokenizer.
tk = Trino.tokenizer_class
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
    # py:20-22 `KEYWORDS.pop("SQL SECURITY")` — Trino has no `SQL SECURITY` clause,
    # only bare `SECURITY DEFINER`/`INVOKER`.
    "sql_security_in_keywords": "SQL SECURITY" in tk.KEYWORDS,
    "sql_security_in_base_presto_keywords": "SQL SECURITY" in Presto.tokenizer_class.KEYWORDS,
    "refresh_in_keywords": "REFRESH" in tk.KEYWORDS,
    "declare_in_keywords": "DECLARE" in tk.KEYWORDS,
}

instance = Trino()

print(
    json.dumps(
        {
            "attrs": attrs,
            "overrides": overrides,
            "tokenizer": tokenizer,
            "classes": {
                "parser_class": Trino.parser_class.__name__,
                "parser_class_module": Trino.parser_class.__module__,
                "parser_class_base": Trino.parser_class.__bases__[0].__name__,
                "tokenizer_class": Trino.tokenizer_class.__name__,
                "tokenizer_class_base": Trino.tokenizer_class.__bases__[0].__name__,
                "generator_class": Trino.generator_class.__name__,
                "generator_class_module": Trino.generator_class.__module__,
                "generator_class_base": Trino.generator_class.__bases__[0].__name__,
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
