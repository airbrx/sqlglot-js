#!/usr/bin/env python3
"""CPython oracle for `sqlglot/dialects/clickhouse.py`'s `ClickHouse(Dialect)` class.

AIR-2288 (epic AIR-2272, "12.3 ClickHouse"). Same template R21/R42/R103's
`gen_presto_dialect_ref.py` established: compare the RESOLVED attribute (`getattr`,
not `vars`), so the probe catches both a missing OVERRIDE and an ACCIDENTAL one. It
also covers the nested `Tokenizer` subclass, including its one post-merge
`KEYWORDS.pop("/*+")` mutation, and -- unlike Presto/MySQL, which declared no method
overrides at all -- a section 4 exercising `generate_values_aliases`, the one method
ClickHouse overrides (the "VALUES('person String, place String', (...))" embedded-
structure syntax vs. the default "c1, c2, ..." column aliases).

    PYTHONHASHSEED=0 python3 spike/p5/gen_clickhouse_dialect_ref.py \
        > spike/out/clickhouse_dialect.json
    node spike/p5/fuzz_clickhouse_dialect.mjs
"""

import json
import os
import sys

sys.path.insert(0, os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref"))

import sqlglot  # noqa: E402
from sqlglot import expressions as exp  # noqa: E402
from sqlglot.dialects.dialect import Dialect, NormalizationStrategy  # noqa: E402
from sqlglot.dialects.clickhouse import ClickHouse  # noqa: E402
from sqlglot.tokens import TokenType  # noqa: E402

TRIE_END = 0

# `EXPRESSION_METADATA` is `sqlglot/typing/clickhouse.py`'s type-inference table (297
# entries: 294 base + 3 ClickHouse-specific). Its values are closures/option records
# that cannot be JSON-encoded, so it is dumped as a COUNT, exactly as `gen_dialect_ref.py`
# and `gen_presto_dialect_ref.py` already do for their own tables.
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
# `vars(ClickHouse)` would miss a base setting the port accidentally shadowed, and
# iterating only `vars(Dialect)` would miss a value ClickHouse declares that the base
# derives differently.
names = sorted({n for n in vars(ClickHouse) if n.isupper()} | {n for n in vars(Dialect) if n.isupper()})

attrs = {}
overrides = []
for name in names:
    value = getattr(ClickHouse, name)
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
tk = ClickHouse.tokenizer_class
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
    # py:122 `KEYWORDS.pop("/*+")` -- asserted as its own row rather than left implicit
    # in the KEYWORDS dump, because the interesting consequence is downstream:
    # HINT_START only reaches `_COMMENTS` when it is present in KEYWORDS.
    "hint_start_in_keywords": tk.HINT_START in tk.KEYWORDS,
    "hint_start_in_comments": tk.HINT_START in tk._COMMENTS,
}

instance = ClickHouse()


# py:44-68 `generate_values_aliases(self, expression)`.
#
# Driven by REAL parsing (`sqlglot.parse_one(sql, read="clickhouse")`), not a
# hand-built AST: the method reads `expression.expressions[0].expressions`, which
# only has the shape it expects after `ClickHouseParser._parse_value`'s own rewrite
# has run (every scalar in a non-Tuple-terminated row gets wrapped in its own
# singleton Tuple -- see that method's own docstring). Hand-building the AST without
# reproducing that rewrite silently produces a DIFFERENT shape than any real parse
# ever does, which is exactly the trap this oracle exists to avoid.
#
# The non-structure ("default") branch reads `len(values[0].expressions)`, where
# `values[0]` is ALWAYS one of those post-rewrite singleton Tuples -- so this count is
# ALWAYS 1, regardless of the real column count. That looks like a bug, but it is
# upstream's actual, verified-against-real-CPython behavior (confirmed interactively
# against the pin: `VALUES(1,2,3)` and `VALUES(1,2),(3,4)` both yield exactly
# `["c1"]`), so the port reproduces it rather than "fixing" it.
def generate_values_aliases_cases():
    d = ClickHouse()
    cases = []

    def case(name, sql):
        e = sqlglot.parse_one(sql, read="clickhouse")
        v = e.find(exp.Values)
        out = [i.name for i in d.generate_values_aliases(v)]
        cases.append({"name": name, "sql": sql, "out": out})

    # Structure branch: leading string literal + a second row-item that IS a Tuple
    # (parenthesized with a comma -- a single-value paren parses as `Paren`, not
    # `Tuple`, which is exactly why `structure_single_value_paren` below does NOT
    # take this branch).
    case("structure", "SELECT * FROM VALUES('person String, place String', ('Noah', 'Paris'))")
    case("structure_whitespace", "SELECT * FROM VALUES(' person  String , place String ', ('Noah', 'Paris'))")
    case("structure_multi_row", "SELECT * FROM VALUES('a String, b String', ('x', 'y'), ('p', 'q'))")

    # Default branch: single row, no leading string -- falls back to c1 (always,
    # per the always-1 count explained above).
    case("default_single_row", "SELECT * FROM VALUES(1, 2, 3)")
    # Default branch: multiple rows, still always c1.
    case("default_multi_row", "SELECT * FROM VALUES(1, 2), (3, 4)")
    # Default branch: leading item IS a string, but the second row-item is a
    # single-value paren (`Paren`, not `Tuple`), so the structure guard's
    # `isinstance(values[1], exp.Tuple)` check excludes it.
    case("structure_single_value_paren", "SELECT * FROM VALUES('a String', ('x'))")
    # Default branch: leading item is a string, but there is only ONE value in the
    # row overall, so `values[1]` does not even exist as a Tuple candidate.
    case("default_single_value_leading_string", "SELECT * FROM VALUES('a')")
    # Default branch: a single scalar value.
    case("default_single_value", "SELECT * FROM VALUES(1)")

    return cases


print(
    json.dumps(
        {
            "attrs": attrs,
            "overrides": overrides,
            "tokenizer": tokenizer,
            "classes": {
                "parser_class": ClickHouse.parser_class.__name__,
                "parser_class_module": ClickHouse.parser_class.__module__,
                "tokenizer_class": ClickHouse.tokenizer_class.__name__,
                "generator_class": ClickHouse.generator_class.__name__,
                "generator_class_module": ClickHouse.generator_class.__module__,
            },
            "instance": {
                "version": [str(p) for p in instance.version],
                "normalization_strategy": instance.normalization_strategy.name,
            },
            "generate_values_aliases": generate_values_aliases_cases(),
        },
        indent=1,
        sort_keys=True,
    )
)
