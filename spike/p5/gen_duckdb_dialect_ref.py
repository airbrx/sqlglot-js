#!/usr/bin/env python3
"""CPython oracle for `sqlglot/dialects/duckdb.py`'s `DuckDB(Dialect)` class.

Same shape as `gen_snowflake_dialect_ref.py`, one class down: `dialects/duckdb.py` is
14 setting overrides, a `DATE_PART_MAPPING` merge-then-pop, an `INVERSE_TIME_MAPPING`
override, a nested `Tokenizer` with 30 added/replaced keywords plus heredoc/byte-string
support, and one method override (`to_json_path`, not `can_quote` — DuckDB has no DUAL
exception). A single wrong entry would not throw; it would surface much later as an
ordinary output MISMATCH in whatever query happens to read it.

    PYTHONHASHSEED=0 python3 spike/p5/gen_duckdb_dialect_ref.py \
        > spike/out/duckdb_dialect.json
    node spike/p5/fuzz_duckdb_dialect.mjs
"""

import json
import os
import sys

sys.path.insert(0, os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref"))

from sqlglot import expressions as exp  # noqa: E402
from sqlglot.dialects.dialect import Dialect, NormalizationStrategy  # noqa: E402
from sqlglot.dialects.duckdb import DuckDB  # noqa: E402
from sqlglot.tokens import TokenType  # noqa: E402

TRIE_END = 0

# `EXPRESSION_METADATA` is `sqlglot/typing/duckdb.py`'s type-inference table. The
# `typing/` package and `optimizer/annotate_types.py` are unported (P6+). Dumped as a
# COUNT rather than skipped, exactly as `gen_snowflake_dialect_ref.py` does, so the JS
# side has to state a number and cannot quietly pretend the attribute does not exist.
COUNT_ONLY = {"EXPRESSION_METADATA"}


def _sort_key(encoded):
    return json.dumps(encoded, sort_keys=True, separators=(",", ":"))


def enc(v):
    # `TokenType` and `NormalizationStrategy` are checked BEFORE the primitive branch:
    # both derive from `int`/`str`, so the primitive check would match them first and
    # emit a bare integer/string instead of a tagged one. The port's own `TokenType` is
    # an independent integer table not asserted to match CPython's numbering anywhere,
    # so comparing by NAME is the only sound encoding.
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


# RESOLVED, not own: the union of both classes' names catches a base setting the port
# accidentally shadowed AND a DuckDB-declared one (like `INVERSE_TIME_MAPPING`) the base
# derives to empty.
names = sorted({n for n in vars(DuckDB) if n.isupper()} | {n for n in vars(Dialect) if n.isupper()})

attrs = {}
overrides = []
for name in names:
    value = getattr(DuckDB, name)
    attrs[name] = {"$count": len(value)} if name in COUNT_ONLY else enc(value)
    if name not in COUNT_ONLY:
        base = getattr(Dialect, name, None)
        try:
            same = base == value
        except Exception:  # noqa: BLE001
            same = False
        if not same:
            overrides.append(name)

# The nested `Tokenizer` subclass, its own declared settings plus the values
# `__init_subclass__` derives. Skipping `initTokenizerSubclass` on the JS side would
# leave every derived value inherited from the base tokenizer -- a silent, total
# failure of the DuckDB lexer that nonetheless still parses most SQL.
tk = DuckDB.tokenizer_class
tokenizer = {
    "name": tk.__name__,
    "base": tk.__bases__[0].__name__,
    "KEYWORDS": enc(tk.KEYWORDS),
    "SINGLE_TOKENS": enc(tk.SINGLE_TOKENS),
    "COMMANDS": enc(tk.COMMANDS),
    "BYTE_STRINGS": enc(tk.BYTE_STRINGS),
    "BYTE_STRING_ESCAPES": enc(tk.BYTE_STRING_ESCAPES),
    "HEREDOC_STRINGS": enc(tk.HEREDOC_STRINGS),
    "HEREDOC_TAG_IS_IDENTIFIER": tk.HEREDOC_TAG_IS_IDENTIFIER,
    "HEREDOC_STRING_ALTERNATIVE": enc(tk.HEREDOC_STRING_ALTERNATIVE),
    "VAR_SINGLE_TOKENS": enc(tk.VAR_SINGLE_TOKENS),
    # Derived by `__init_subclass__`:
    "_QUOTES": enc(tk._QUOTES),
    "_IDENTIFIERS": enc(tk._IDENTIFIERS),
    "_FORMAT_STRINGS": enc(tk._FORMAT_STRINGS),
    "_COMMENTS": enc(tk._COMMENTS),
    "_STRING_ESCAPES": enc(tk._STRING_ESCAPES),
    "_KEYWORD_TRIE_SIZE": len(tk._KEYWORD_TRIE),
    # py:115 `KEYWORDS.pop("/*+")`. Asserted as its own row because the interesting
    # consequence is downstream: HINT_START only reaches `_COMMENTS` when present in
    # KEYWORDS.
    "hint_start_in_keywords": tk.HINT_START in tk.KEYWORDS,
    "hint_start_in_comments": tk.HINT_START in tk._COMMENTS,
    "show_in_commands": TokenType.SHOW in tk.COMMANDS,
}

# py:57 `to_json_path` -- DuckDB's one method override. No DUAL-style identifier
# exception exists here (that's Snowflake's `can_quote`); the interesting cases are the
# JSON-pointer/back-of-list fast paths and the Literal/non-Literal split that decides
# whether `super().to_json_path` (a NotPorted stub on the JS side, since
# `sqlglot/jsonpath.py` is unported) is even reached.
TO_JSON_PATH_LITERALS = [
    "/a/b", "/0", "[#-1]", "a[#-1]", "$.a.b", "a.b.c", "", "/", "[#",
]


def to_json_path_cases():
    d = DuckDB()
    rows = []
    for text in TO_JSON_PATH_LITERALS:
        lit = exp.Literal.string(text)
        try:
            out = d.to_json_path(lit)
            out_repr = "SAME_LITERAL" if out is lit else repr(out)
        except Exception as e:  # noqa: BLE001
            out_repr = {"error": f"{type(e).__name__}: {e}"}
        rows.append({"text": text, "out": out_repr})
    # The non-Literal path: upstream falls straight through to `super().to_json_path`,
    # which returns non-Literal input unchanged (py:1179's `Literal` branch is the only
    # one that does anything).
    non_literal = exp.Column(this=exp.Identifier(this="x"))
    out = d.to_json_path(non_literal)
    rows.append({"text": None, "out": "SAME_NODE" if out is non_literal else repr(out)})
    return rows


instance = DuckDB()

print(
    json.dumps(
        {
            "attrs": attrs,
            "overrides": overrides,
            "tokenizer": tokenizer,
            "classes": {
                "parser_class": DuckDB.parser_class.__name__,
                "parser_class_module": DuckDB.parser_class.__module__,
                "tokenizer_class": DuckDB.tokenizer_class.__name__,
                "generator_class": DuckDB.generator_class.__name__,
            },
            "instance": {
                "version": [str(p) for p in instance.version],
                "normalization_strategy": instance.normalization_strategy.name,
            },
            "to_json_path": to_json_path_cases(),
        },
        indent=1,
        sort_keys=True,
    )
)
