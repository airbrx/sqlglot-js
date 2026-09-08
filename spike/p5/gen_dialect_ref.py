#!/usr/bin/env python3
"""CPython oracle for the base `Dialect` class's ~106 class-level settings.

P5 hand-ports `class Dialect` out of `sqlglot/dialects/dialect.py`. Roughly forty of
those settings are read by `src/parser.js` and the ported `src/parsers/*.js`
subclasses as `self.dialect.X`, and **twenty-four of the base defaults are falsy**, so
a setting that is simply MISSING from the port reads back `undefined` and behaves like
Python for those twenty-four — silently, and only for those twenty-four. The eight
truthy defaults then take the opposite branch from CPython on every row. That is the
exact failure `spike/p3/dialect_tokenizer.mjs`'s header describes having hit while
growing `standInDialect` one crash at a time.

So the port's defaults are not eyeballed against the upstream file; they are diffed
against CPython, attribute by attribute, including the ones the metaclass DERIVES
rather than declares (`VALID_INTERVAL_UNITS` is 116 entries at the base dialect, not
the empty set the class body shows; `INVERSE_TIME_MAPPING` is non-empty for the same
reason). Those derived values are where a hand-port most plausibly goes wrong, because
reading only the class body gives the wrong answer for all six of them.

    python3 spike/p5/gen_dialect_ref.py > spike/out/dialect_defaults.json
    node spike/p5/fuzz_dialect_defaults.mjs
"""

import json
import os
import sys

sys.path.insert(0, os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref"))

from sqlglot import expressions as exp  # noqa: E402
from sqlglot.dialects.dialect import Dialect, NormalizationStrategy  # noqa: E402

# `trie.new_trie` marks a completed keyword with the literal integer key 0 (there is no
# named constant upstream; `src/trie.js` calls it `TRIE_END`).
TRIE_END = 0

# `EXPRESSION_METADATA` is `sqlglot/optimizer/annotate_types.py`'s 294-entry type
# inference table, an unported module (P6+). It is dumped as a COUNT rather than
# skipped, so the JS side has to state a number and cannot quietly pretend the
# attribute does not exist.
COUNT_ONLY = {"EXPRESSION_METADATA"}


def enc(v):
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, NormalizationStrategy):
        return {"$e": v.name}
    if isinstance(v, exp.DType):
        return {"$dtype": v.name}
    if isinstance(v, type):
        # Expression classes appear as dict KEYS (SET_OP_DISTINCT_BY_DEFAULT).
        return {"$c": v.__name__}
    if isinstance(v, (set, frozenset)):
        # Sorted: Python set iteration order is not a contract and the port stores
        # these as JS `Set`s, whose order is insertion order. Membership is the only
        # thing either side promises.
        return {"$s": sorted(enc(x) for x in v)}
    if isinstance(v, dict):
        # A trie's end marker is the INTEGER 0, which JSON cannot distinguish from
        # the string "0" as an object key — same wire encoding as
        # `spike/p3/dialect_tokenizer.mjs`'s `trieFromJson`.
        return {"$d": [["$end" if k is TRIE_END else enc(k), enc(val)] for k, val in v.items()]}
    if isinstance(v, (list, tuple)):
        return [enc(x) for x in v]
    raise TypeError(f"unencodable {type(v)!r}: {v!r}")


names = sorted(n for n in vars(Dialect) if n.isupper())

attrs = {}
for name in names:
    value = getattr(Dialect, name)
    attrs[name] = {"$count": len(value)} if name in COUNT_ONLY else enc(value)

instance = Dialect()

# The `"name [, k [= v]]"` settings grammar `get_or_raise` accepts (dialect.py:990).
# Every case is a real CPython invocation, so the port is diffed against behaviour
# rather than against a reading of the code — including the four that RAISE, whose
# messages are part of the contract (`suggest_closest_match_and_fail` appends a
# "Did you mean ...?" only when difflib finds a close match).
GET_OR_RAISE_CASES = [
    "",
    "duckdb",
    " duckdb ",
    "duckdb, version=1.1",
    "duckdb, version = 1.1",
    "duckdb, version=1",
    "duckdb, version=1.2.3.4",
    "duckdb, normalization_strategy = case_sensitive",
    "duckdb, normalization_strategy=CASE_INSENSITIVE",
    "duckdb, version=1.1, normalization_strategy=uppercase",
    "duckdb, version=true",
    "duckdb,",
    "duckdb, version",
    "duckdb, bogus_setting=1",
    "duckdb, version=1=2",
    "nosuchdialect",
    "duckdbb",
]


def kv_case(s):
    row = {"input": s}
    try:
        d = Dialect.get_or_raise(s)
    except Exception as e:  # noqa: BLE001 — the message IS the contract
        row["error"] = {"type": type(e).__name__, "message": str(e)}
        return row
    row["version"] = [str(x) for x in d.version]
    row["normalization_strategy"] = d.normalization_strategy.name
    row["settings"] = enc(d.settings)
    row["dialect"] = type(d).__name__.lower()
    return row


# PORT_PLAN.md R16 applied to this port's OWN new code: "a method being non-stub is not
# evidence it was ported; it is evidence someone wrote a body." Five `Dialect` methods
# have no caller in `src/` yet — their consumers are the P4 generator and the P6
# optimizer — so nothing else in the repo would notice if they were wrong. They get a
# CPython oracle now rather than when something finally reaches them.
#
# `normalize_identifier` is absent on purpose: the port announces it as NotPorted
# because it needs a `pyLower` shim that does not exist, and generating expectations for
# a method the port refuses to implement would be noise.
CASE_SENSITIVE_TEXTS = ["abc", "ABC", "Abc", "aBc", "abc1", "_a", "", "ÄÖÜ", "äöü", "1234", "a_B"]
STRATEGIES = [
    "lowercase",
    "uppercase",
    "case_sensitive",
    "case_insensitive",
    "case_insensitive_uppercase",
]


def method_cases():
    rows = []
    for strategy in STRATEGIES:
        d = Dialect(normalization_strategy=strategy)
        for text in CASE_SENSITIVE_TEXTS:
            rows.append(
                {"m": "case_sensitive", "strategy": strategy, "text": text, "out": d.case_sensitive(text)}
            )

    d = Dialect()
    # `identify` is a real positional parameter upstream, tri-valued: True / "safe" /
    # "unsafe" / falsy. `parent` matters too — an Identifier inside a Func is never
    # quoted (py:1142).
    for text in ["abc", "ABC", "Abc", "a b", "sELECT", "a1", "1a"]:
        for quoted in (False, True):
            for identify in (True, False, "safe", "unsafe"):
                for in_func in (False, True):
                    ident = exp.Identifier(this=text, quoted=quoted)
                    if in_func:
                        exp.Anonymous(this=ident, expressions=[])
                    try:
                        out = d.can_quote(ident, identify)
                    except ValueError as e:
                        out = {"error": str(e)}
                    rows.append({
                        "m": "can_quote", "text": text, "quoted": quoted,
                        "identify": identify, "in_func": in_func, "out": out,
                    })
        for identify in (True, False):
            ident = exp.Identifier(this=text, quoted=False)
            rows.append({
                "m": "quote_identifier", "text": text, "identify": identify,
                "out": d.quote_identifier(ident, identify).args["quoted"],
            })

    # py:1222 — `_col_0`, `_col_1`, ... one per column of the FIRST VALUES row.
    for width in (0, 1, 3):
        values = exp.Values(expressions=[exp.Tuple(expressions=[exp.Literal.number(i) for i in range(width)])])
        rows.append({
            "m": "generate_values_aliases", "width": width,
            "out": [i.name for i in d.generate_values_aliases(values)],
        })

    # py:1025 — with an EMPTY TIME_MAPPING the base dialect still strips the quotes.
    for value in ["'%Y-%m-%d'", "'abc'", "''"]:
        rows.append({"m": "format_time", "value": value, "out": Dialect.format_time(value).name})
    return rows


print(
    json.dumps(
        {
            "attrs": attrs,
            # The four "autofilled" class references the metaclass resolves. Names
            # only: the port asserts identity against its own imports, and the point
            # here is WHICH class upstream picked. `parser_class` is the load-bearing
            # one — it is `BaseParser` (sqlglot/parsers/base.py), NOT `parser.Parser`,
            # a distinction the default dialect's AST depends on.
            "classes": {
                "tokenizer_class": Dialect.tokenizer_class.__name__,
                "tokenizer_class_base": Dialect.tokenizer_class.__bases__[0].__name__,
                "tokenizer_class_module": Dialect.tokenizer_class.__bases__[0].__module__,
                "parser_class": Dialect.parser_class.__name__,
                "parser_class_module": Dialect.parser_class.__module__,
                "generator_class": Dialect.generator_class.__name__,
                "jsonpath_tokenizer_class": Dialect.jsonpath_tokenizer_class.__bases__[0].__name__,
            },
            # `Dialect.__init__` state, i.e. what `get_or_raise("")` yields.
            "instance": {
                "version": [str(p) for p in instance.version],
                "normalization_strategy": instance.normalization_strategy.name,
                "settings": enc(instance.settings),
            },
            "get_or_raise": [kv_case(s) for s in GET_OR_RAISE_CASES],
            "methods": method_cases(),
        },
        indent=1,
        sort_keys=True,
    )
)
