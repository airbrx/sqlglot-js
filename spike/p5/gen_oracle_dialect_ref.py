#!/usr/bin/env python3
"""CPython oracle for `sqlglot/dialects/oracle.py`'s `Oracle(Dialect)` class.

AIR-2290 (epic AIR-2272, "12.5 Oracle"). Same template R21/R42's
`gen_snowflake_dialect_ref.py`/`gen_dialect_ref.py` (base) established: compare the
RESOLVED attribute (`getattr`, not `vars`), so the probe catches both a missing
OVERRIDE (Oracle declares `NULL_ORDERING` and the port forgetting it would silently
inherit the base's "nulls_are_small") and an ACCIDENTAL one. It also covers the
values `_Dialect.__new__` DERIVES rather than reads, the nested `Tokenizer`
subclass, and Oracle's one method override (`can_quote`, the same shape
Snowflake's own oracle exercises, here with a Pseudocolumn-parent DUAL instead of
Snowflake's Table-parent "dual" DUAL).

Oracle has no `typing/oracle.py` upstream (unlike Presto/ClickHouse/MySQL), so
`EXPRESSION_METADATA` is the bare base 294-entry table — recorded as a count like
every other dialect oracle, for consistency, even though the count is unchanged
from the base `Dialect`'s own.

    PYTHONHASHSEED=0 python3 spike/p5/gen_oracle_dialect_ref.py \
        > spike/out/oracle_dialect.json
    node spike/p5/fuzz_oracle_dialect.mjs
"""

import json
import os
import sys

sys.path.insert(0, os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref"))

from sqlglot import expressions as exp  # noqa: E402
from sqlglot.dialects.dialect import Dialect, NormalizationStrategy  # noqa: E402
from sqlglot.dialects.oracle import Oracle  # noqa: E402
from sqlglot.tokens import TokenType  # noqa: E402

TRIE_END = 0

# `EXPRESSION_METADATA` is the base `Dialect`'s own 294-entry type-inference table
# (`src/typing/index.js`) -- Oracle has no `typing/oracle.py` overlay upstream, so this
# is a real count comparison of the UNCHANGED base table, not an overlay. Dumped as a
# COUNT rather than skipped, exactly as every other dialect oracle does for its own
# table (closures/option records in the values are not JSON-encodable).
COUNT_ONLY = {"EXPRESSION_METADATA"}


def _sort_key(encoded):
    return json.dumps(encoded, sort_keys=True, separators=(",", ":"))


def enc(v):
    # `TokenType`/`NormalizationStrategy` checked BEFORE the primitive branch: both
    # derive from `int`/`str`, and the port's own `TokenType` numbering is not
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
# `vars(Oracle)` would miss a base setting the port accidentally shadowed, and
# iterating only `vars(Dialect)` would miss a value Oracle declares that the base
# derives differently.
names = sorted({n for n in vars(Oracle) if n.isupper()} | {n for n in vars(Dialect) if n.isupper()})

attrs = {}
overrides = []
for name in names:
    value = getattr(Oracle, name)
    attrs[name] = {"$count": len(value)} if name in COUNT_ONLY else enc(value)
    # Which of them actually DIFFER from the base. Printed, not asserted -- it lets
    # the port's diff-from-base be eyeballed against upstream's class body, which a
    # value-by-value check alone cannot show.
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
# `initTokenizerSubclass` explicitly (JS has no `__init_subclass__` hook).
tk = Oracle.tokenizer_class
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
    # py:72 `"(+)": TokenType.JOIN_MARKER` -- Oracle's own outer-join marker keyword.
    "join_marker_in_keywords": "(+)" in tk.KEYWORDS,
}

# py:52-57 `can_quote` -- the DUAL exception, which is the whole point of the
# override: quoting is disabled for an UNQUOTED pseudocolumn identifier
# (`exp.Pseudocolumn` parent), same shape Snowflake's "dual" Table-parent case uses,
# here gated on the PARENT TYPE rather than the identifier's own text.
CAN_QUOTE_TEXTS = ["ROWNUM", "rownum", "ROWID", "LEVEL", "abc", "a b"]


def can_quote_cases():
    rows = []
    d = Oracle()
    for text in CAN_QUOTE_TEXTS:
        for quoted in (False, True):
            for parent in ("pseudocolumn", "table", None):
                for identify in (True, False, "safe", "unsafe"):
                    ident = exp.Identifier(this=text, quoted=quoted)
                    if parent == "pseudocolumn":
                        exp.Pseudocolumn(this=ident)
                    elif parent == "table":
                        exp.Table(this=ident)
                    try:
                        out = d.can_quote(ident, identify)
                    except ValueError as e:
                        out = {"error": str(e)}
                    rows.append({
                        "text": text, "quoted": quoted, "parent": parent,
                        "identify": identify, "out": out,
                    })
    return rows


instance = Oracle()

print(
    json.dumps(
        {
            "attrs": attrs,
            "overrides": overrides,
            "tokenizer": tokenizer,
            "classes": {
                "parser_class": Oracle.parser_class.__name__,
                "parser_class_module": Oracle.parser_class.__module__,
                "tokenizer_class": Oracle.tokenizer_class.__name__,
                "generator_class": Oracle.generator_class.__name__,
                "generator_class_module": Oracle.generator_class.__module__,
            },
            "instance": {
                "version": [str(p) for p in instance.version],
                "normalization_strategy": instance.normalization_strategy.name,
            },
            "can_quote": can_quote_cases(),
        },
        indent=1,
        sort_keys=True,
    )
)
