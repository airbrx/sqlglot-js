#!/usr/bin/env python3
"""CPython oracle for `sqlglot/dialects/mysql.py`'s `MySQL(Dialect)` class.

Same shape as `gen_duckdb_dialect_ref.py`/`gen_snowflake_dialect_ref.py` (PORT_PLAN.md
R42's template): `dialects/mysql.py` is 9 setting overrides, three hand-authored tables
(`TIME_FORMAT`, `TIME_MAPPING`, `VALID_INTERVAL_UNITS`), and a nested `Tokenizer` with
~70 added/replaced keywords plus bit-string/hex-string/escape-char support. Unlike
DuckDB/Snowflake, `MySQL` declares NO method overrides at all (no `to_json_path`,
no `can_quote`) -- every reachable behavior lives in the settings and the Tokenizer,
so there is no section 4 here. A single wrong entry would not throw; it would surface
much later as an ordinary output MISMATCH in whatever query happens to read it.

    PYTHONHASHSEED=0 python3 spike/p5/gen_mysql_dialect_ref.py \
        > spike/out/mysql_dialect.json
    node spike/p5/fuzz_mysql_dialect.mjs
"""

import json
import os
import sys

sys.path.insert(0, os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref"))

from sqlglot import expressions as exp  # noqa: E402
from sqlglot.dialects.dialect import Dialect, NormalizationStrategy  # noqa: E402
from sqlglot.dialects.mysql import MySQL  # noqa: E402
from sqlglot.tokens import TokenType  # noqa: E402

TRIE_END = 0

# `EXPRESSION_METADATA` is `sqlglot/typing/mysql.py`'s type-inference table: real (335
# entries), but its values are closures/option records `enc()` cannot encode -- dumped
# as a COUNT rather than skipped, exactly as `gen_duckdb_dialect_ref.py` does, so the JS
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
# accidentally shadowed AND a MySQL-declared one the base derives to empty.
names = sorted({n for n in vars(MySQL) if n.isupper()} | {n for n in vars(Dialect) if n.isupper()})

attrs = {}
overrides = []
for name in names:
    value = getattr(MySQL, name)
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
# failure of the MySQL lexer that nonetheless still parses most SQL.
tk = MySQL.tokenizer_class
tokenizer = {
    "name": tk.__name__,
    "base": tk.__bases__[0].__name__,
    "QUOTES": enc(tk.QUOTES),
    "COMMENTS": enc(tk.COMMENTS),
    "IDENTIFIERS": enc(tk.IDENTIFIERS),
    "STRING_ESCAPES": enc(tk.STRING_ESCAPES),
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
    "hint_start_in_keywords": tk.HINT_START in tk.KEYWORDS,
    "hint_start_in_comments": tk.HINT_START in tk._COMMENTS,
    # py:156 `COMMANDS = {*tokens.Tokenizer.COMMANDS, TokenType.REPLACE} - {TokenType.SHOW}`.
    "show_in_commands": TokenType.SHOW in tk.COMMANDS,
    "replace_in_commands": TokenType.REPLACE in tk.COMMANDS,
}

instance = MySQL()

print(
    json.dumps(
        {
            "attrs": attrs,
            "overrides": overrides,
            "tokenizer": tokenizer,
            "classes": {
                "parser_class": MySQL.parser_class.__name__,
                "parser_class_module": MySQL.parser_class.__module__,
                "tokenizer_class": MySQL.tokenizer_class.__name__,
                "generator_class": MySQL.generator_class.__name__,
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
