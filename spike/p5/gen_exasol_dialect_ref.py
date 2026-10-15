#!/usr/bin/env python3
"""CPython oracle for `sqlglot/dialects/exasol.py`'s `Exasol(Dialect)` class.

AIR-2289 (epic AIR-2272, "12.4 Exasol"). Same template R21/R42/R103's
`gen_snowflake_dialect_ref.py`/`gen_presto_dialect_ref.py` established: compare the
RESOLVED attribute (`getattr`, not `vars`), so the probe catches both a missing
OVERRIDE (Exasol declares `NORMALIZATION_STRATEGY` and the port forgetting it would
silently inherit the base's "nulls_are_small"-style default) and an ACCIDENTAL one (a
setting the port added that upstream leaves inherited). It also covers the values
`_Dialect.__new__` DERIVES rather than reads, and the nested `Tokenizer` subclass,
including the `KEYWORDS.pop("DIV")` mutation made AFTER the merge.

Exasol overrides no method on the `Dialect` class itself (unlike Snowflake's
`can_quote`) -- every reachable behavior lives in the settings, the `TIME_MAPPING`
dict, and the Tokenizer, so this file has no section 4, same shape Presto's own oracle
used (`dialects/presto.py` also declares no method override).

    PYTHONHASHSEED=0 python3 spike/p5/gen_exasol_dialect_ref.py \
        > spike/out/exasol_dialect.json
    node spike/p5/fuzz_exasol_dialect.mjs
"""

import json
import os
import sys

sys.path.insert(0, os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref"))

from sqlglot import expressions as exp  # noqa: E402
from sqlglot.dialects.dialect import Dialect, NormalizationStrategy  # noqa: E402
from sqlglot.dialects.exasol import Exasol  # noqa: E402
from sqlglot.tokens import TokenType  # noqa: E402

TRIE_END = 0

# `EXPRESSION_METADATA` is the base `Dialect`'s own type-inference table -- there is no
# `typing/exasol.py` upstream, so Exasol inherits it unmodified, but it is still
# unencodable (closures/option records) and must be dumped as a COUNT, exactly as
# `gen_dialect_ref.py`/`gen_presto_dialect_ref.py` already do for their own tables.
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
# `vars(Exasol)` would miss a base setting the port accidentally shadowed, and
# iterating only `vars(Dialect)` would miss a value Exasol declares that the base
# derives differently (none here, but the union is the safe default every prior
# dialect oracle used).
names = sorted({n for n in vars(Exasol) if n.isupper()} | {n for n in vars(Dialect) if n.isupper()})

attrs = {}
overrides = []
for name in names:
    value = getattr(Exasol, name)
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
tk = Exasol.tokenizer_class
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
    # Derived by `__init_subclass__`:
    "_QUOTES": enc(tk._QUOTES),
    "_IDENTIFIERS": enc(tk._IDENTIFIERS),
    "_FORMAT_STRINGS": enc(tk._FORMAT_STRINGS),
    "_COMMENTS": enc(tk._COMMENTS),
    "_STRING_ESCAPES": enc(tk._STRING_ESCAPES),
    "_KEYWORD_TRIE_SIZE": len(tk._KEYWORD_TRIE),
    # py:66 `KEYWORDS.pop("DIV")` -- a mutation AFTER the merge, not an entry omitted
    # from it; asserted as its own row rather than left implicit in the KEYWORDS dump.
    "div_in_keywords": "DIV" in tk.KEYWORDS,
}

instance = Exasol()

print(
    json.dumps(
        {
            "attrs": attrs,
            "overrides": overrides,
            "tokenizer": tokenizer,
            "classes": {
                "parser_class": Exasol.parser_class.__name__,
                "parser_class_module": Exasol.parser_class.__module__,
                "tokenizer_class": Exasol.tokenizer_class.__name__,
                "generator_class": Exasol.generator_class.__name__,
                "generator_class_module": Exasol.generator_class.__module__,
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
