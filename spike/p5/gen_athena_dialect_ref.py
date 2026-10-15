#!/usr/bin/env python3
"""CPython oracle for `sqlglot/dialects/athena.py`'s `Athena(Dialect)` class.

AIR-2287 (epic AIR-2272, "12.2 Presto family"), part 2 of the chain. Athena extends
the BASE `Dialect` directly (not Presto/Trino) and declares no scalar setting of its
own — ALL its real behavior lives in its composite `Tokenizer` (merging Hive's and
Trino's quoting/keyword settings to decide, via `_tokenize_as_hive`, which REAL sub-
tokenizer should actually run) and in `AthenaParser`/`AthenaGenerator`'s own Hive-vs-
Trino dispatch (`src/parsers/athena.js`/`src/generators/athena.js`, with their own
corpus-driven coverage).

Unlike every sibling oracle in this family, THIS one adds a section 4: the actual
`_tokenize_as_hive` ROUTING DECISION for a representative set of statements covering
every branch of that heuristic (DESCRIBE/SHOW/MSCK REPAIR, CREATE/ALTER/DROP x
DATABASE/EXTERNAL/SCHEMA/VIEW/TABLE, and a plain SELECT) — a behavioral check on top
of the usual settings-table comparison, because this dialect's whole point IS the
routing decision, not a scalar override list.

    PYTHONHASHSEED=0 python3 spike/p5/gen_athena_dialect_ref.py \
        > spike/out/athena_dialect.json
    node spike/p5/fuzz_athena_dialect.mjs
"""

import json
import os
import sys

sys.path.insert(0, os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref"))

from sqlglot import expressions as exp  # noqa: E402
from sqlglot.dialects.athena import Athena  # noqa: E402
from sqlglot.dialects.dialect import Dialect, NormalizationStrategy  # noqa: E402
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


# RESOLVED, not own. Athena adds nothing of its own at the Dialect-settings level, so
# this is expected to show ZERO overrides vs. the base `Dialect` -- the oracle still
# runs the full comparison, because the interesting failure mode is the port
# ACCIDENTALLY adding/shadowing a setting, not a missing one.
names = sorted({n for n in vars(Athena) if n.isupper()} | {n for n in vars(Dialect) if n.isupper()})

attrs = {}
overrides = []
for name in names:
    value = getattr(Athena, name)
    attrs[name] = {"$count": len(value)} if name in COUNT_ONLY else enc(value)
    if name not in COUNT_ONLY:
        base = getattr(Dialect, name, None)
        try:
            same = base == value
        except Exception:  # noqa: BLE001
            same = False
        if not same:
            overrides.append(name)

# The composite `Tokenizer` -- NOT a Presto/Trino/Hive subclass, but its own
# `tokens.Tokenizer` subclass merging both dialects' quoting settings, used only to
# decide (via `_tokenize_as_hive`) which real sub-tokenizer actually runs.
tk = Athena.tokenizer_class
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
    "NUMERIC_LITERALS": enc(tk.NUMERIC_LITERALS),
    "_QUOTES": enc(tk._QUOTES),
    "_IDENTIFIERS": enc(tk._IDENTIFIERS),
    "_FORMAT_STRINGS": enc(tk._FORMAT_STRINGS),
    "_COMMENTS": enc(tk._COMMENTS),
    "_STRING_ESCAPES": enc(tk._STRING_ESCAPES),
    "_KEYWORD_TRIE_SIZE": len(tk._KEYWORD_TRIE),
    # py:67 `"UNLOAD": TokenType.COMMAND` -- added on top of the Hive+Trino merge.
    "unload_in_keywords": "UNLOAD" in tk.KEYWORDS,
}

# Section 4: the actual routing decision for a representative set of statements,
# covering every branch of `_tokenize_as_hive` (py:89-111).
ROUTING_CASES = [
    "SELECT * FROM t LIMIT 10",
    "CREATE TABLE foo (id INT)",
    "CREATE TABLE foo AS SELECT * FROM bar",
    "CREATE EXTERNAL TABLE foo (id INT)",
    "CREATE DATABASE foo",
    "CREATE SCHEMA foo",
    "CREATE VIEW v AS SELECT 1",
    "ALTER TABLE foo ADD COLUMNS (bar INT)",
    "ALTER DATABASE foo SET DBPROPERTIES ('a'='b')",
    "DROP VIEW v",
    "DROP TABLE foo",
    "DROP DATABASE foo",
    "DESCRIBE foo",
    "SHOW TABLES",
    "MSCK REPAIR TABLE foo",
    "UNLOAD (SELECT 1) TO 's3://bucket/path' WITH (format = 'JSON')",
]

routing = {}
for sql in ROUTING_CASES:
    toks = Athena().tokenizer().tokenize(sql)
    routing[sql] = bool(toks) and toks[0].token_type == TokenType.HIVE_TOKEN_STREAM

instance = Athena()

print(
    json.dumps(
        {
            "attrs": attrs,
            "overrides": overrides,
            "tokenizer": tokenizer,
            "routing": routing,
            "classes": {
                "parser_class": Athena.parser_class.__name__,
                "parser_class_module": Athena.parser_class.__module__,
                "parser_class_base": Athena.parser_class.__bases__[0].__name__,
                "tokenizer_class": Athena.tokenizer_class.__name__,
                "tokenizer_class_base": Athena.tokenizer_class.__bases__[0].__name__,
                "generator_class": Athena.generator_class.__name__,
                "generator_class_module": Athena.generator_class.__module__,
                "generator_class_base": Athena.generator_class.__bases__[0].__name__,
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
