#!/usr/bin/env python3
"""CPython oracle for `sqlglot/dialects/materialize.py`'s `Materialize(Postgres)` class.

AIR-2292, epic AIR-2272, "12.7 Small dialects", batch A. Same shape
`gen_redshift_dialect_ref.py`/`gen_starrocks_dialect_ref.py` established: the RESOLVED-
attribute union walks `Materialize` | `Postgres` | `Dialect` so a setting the port
accidentally shadows at EITHER inherited level is caught. Materialize's own settings
override is a single scalar (`NORMALIZE_NOT_NULL`); it declares NO nested `Tokenizer`
and NO method override on `Dialect` itself (same shape StarRocks/Doris/SingleStore's
own oracles have no section 4/5) -- every reachable behavior beyond that one setting
lives in `parsers/materialize.py`/`generators/materialize.py`, each with its own
corpus-driven coverage.

    PYTHONHASHSEED=0 python3 spike/p5/gen_materialize_dialect_ref.py \
        > spike/out/materialize_dialect.json
    node spike/p5/fuzz_materialize_dialect.mjs
"""

import json
import os
import sys

sys.path.insert(0, os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref"))

from sqlglot import expressions as exp  # noqa: E402
from sqlglot.dialects.dialect import Dialect, NormalizationStrategy  # noqa: E402
from sqlglot.dialects.postgres import Postgres  # noqa: E402
from sqlglot.dialects.materialize import Materialize  # noqa: E402
from sqlglot.tokens import TokenType  # noqa: E402

TRIE_END = 0

# `EXPRESSION_METADATA` is inherited verbatim from `Postgres` (no `typing/
# materialize.py` exists upstream), but still dumped as a COUNT for the same reason
# every other oracle in this family does: its values are closures/option records that
# cannot be JSON-encoded.
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


# RESOLVED, not own. The three-way union (`Materialize` | `Postgres` | `Dialect`) is
# deliberate: Materialize's own settings override is one scalar
# (`NORMALIZE_NOT_NULL`), so most of the interesting coverage here is verifying
# Postgres's own ~14 settings survive unshadowed through another level of JS static
# inheritance.
names = sorted(
    {n for n in vars(Materialize) if n.isupper()}
    | {n for n in vars(Postgres) if n.isupper()}
    | {n for n in vars(Dialect) if n.isupper()}
)

attrs = {}
overrides = []
for name in names:
    value = getattr(Materialize, name)
    attrs[name] = {"$count": len(value)} if name in COUNT_ONLY else enc(value)
    if name not in COUNT_ONLY:
        base = getattr(Dialect, name, None)
        try:
            same = base == value
        except Exception:  # noqa: BLE001
            same = False
        if not same:
            overrides.append(name)

# No `Tokenizer` is declared upstream, so `tokenizer_class` is a FRESH empty subclass
# of `Postgres.tokenizer_class` (the `klass.__dict__.get("Tokenizer", type(...))`
# fallback), not an alias of it.
tk = Materialize.tokenizer_class

instance = Materialize()

print(
    json.dumps(
        {
            "attrs": attrs,
            "overrides": overrides,
            "classes": {
                "parser_class": Materialize.parser_class.__name__,
                "parser_class_module": Materialize.parser_class.__module__,
                "parser_class_base": Materialize.parser_class.__bases__[0].__name__,
                "tokenizer_class_is_fresh_subclass": tk is not Postgres.tokenizer_class,
                "tokenizer_class_base": tk.__bases__[0].__name__,
                "generator_class": Materialize.generator_class.__name__,
                "generator_class_module": Materialize.generator_class.__module__,
                "generator_class_base": Materialize.generator_class.__bases__[0].__name__,
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
