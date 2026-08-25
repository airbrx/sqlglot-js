#!/usr/bin/env python3
"""Extract the parity-probe snapshots from upstream.

PORT_PLAN.md §7 P0 item 6 ("6 parity probes"), §8.3, and the P1/P2/P4 exits.

  python3 tools/parity/extract.py

Writes corpus/parity/*.json. These are the ground truth that `tools/parity/check.mjs`
asserts the JS runtime against. They exist at P0 so P1/P2/P4 agents have their oracle
before writing a line — §8.2's whole point.

Probes:
  1 tokens      TokenType members + Tokenizer class-level settings per dialect
  2 exprs       the expression classes: ORDERED arg_types, required_args, traits
  3 functions   ALL_FUNCTIONS / FUNCTION_BY_NAME / sql_names
  4 dispatch    resolved generator method dispatch (TRANSFORMS beats *_sql)
  5 dialects    the registry, and each dialect's class-level settings
  6 parsers     parser class-level table shapes and sizes
"""

import json
import os
import sys
from collections import OrderedDict

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)

OUT = "corpus/parity"


def write(name, obj):
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, f"{name}.json"), "w", encoding="utf8") as f:
        json.dump(obj, f, indent=1, sort_keys=False, ensure_ascii=False)
        f.write("\n")
    return obj


def jsonable(v):
    """Best-effort stable rendering of a class-attribute value."""
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, (list, tuple)):
        return [jsonable(x) for x in v]
    if isinstance(v, (set, frozenset)):
        # Sets are unordered in Python; sort so the snapshot is stable.
        return {"__set__": sorted((str(jsonable(x)) for x in v))}
    if isinstance(v, dict):
        # Order IS significant (§4.6) — keep insertion order, EXCEPT when keyed by
        # class objects: a class's default __hash__ is id()-based (no __hash__
        # override on Expr subclasses), so a dict built from a class-keyed
        # comprehension/set has memory-address-dependent iteration order — not
        # stabilized by PYTHONHASHSEED. Found while validating seed-pinning
        # reproducibility: corpus/parity/dialects.json still churned on a class-keyed
        # function-return-type table after PYTHONHASHSEED=0 fixed everything else.
        # These tables carry no SQL-observable ordering semantics (unlike arg_types),
        # so sorting by the rendered key is safe.
        items = list(v.items())
        if items and all(isinstance(k, type) for k, _ in items):
            items.sort(key=lambda kv: kv[0].__name__)
        return {"__dict__": [[str(jsonable(k)), jsonable(val)] for k, val in items]}
    if isinstance(v, type):
        return {"__class__": v.__name__}
    if callable(v):
        return {"__callable__": getattr(v, "__name__", "<lambda>")}
    return {"__repr__": repr(v)}


def main():
    from sqlglot import exp, tokens
    from sqlglot.dialects.dialect import Dialect
    from sqlglot.generator import Generator
    from sqlglot.parser import Parser
    from sqlglot.tokens import Tokenizer, TokenType

    # ---- probe 1: tokens ----------------------------------------------------
    write(
        "tokens",
        {
            "token_types": [t.name for t in TokenType],
            "count": len(list(TokenType)),
        },
    )

    # ---- probe 2: expression classes ----------------------------------------
    exprs = OrderedDict()
    for key, cls in exp.EXPR_CLASSES.items():
        exprs[key] = {
            "name": cls.__name__,
            # ORDERED — this is what pins arg_types insertion order, observable in SQL.
            "arg_types": [[k, bool(v)] for k, v in cls.arg_types.items()],
            "required_args": sorted(cls.required_args),
            "bases": [b.__name__ for b in cls.__mro__[1:] if b is not object],
            "is_primitive": bool(getattr(cls, "is_primitive", False)),
            "hash_raw_args": bool(getattr(cls, "_hash_raw_args", False)),
        }
    write("exprs", {"count": len(exprs), "classes": exprs})

    # ---- probe 3: functions --------------------------------------------------
    all_functions = [c.__name__ for c in exp.ALL_FUNCTIONS]
    fbn = OrderedDict((name, cls.__name__) for name, cls in exp.FUNCTION_BY_NAME.items())
    sql_names = OrderedDict(
        (c.__name__, list(c.sql_names())) for c in exp.ALL_FUNCTIONS
    )
    write(
        "functions",
        {
            "all_functions_count": len(all_functions),
            "function_by_name_count": len(fbn),
            "all_functions": all_functions,
            "function_by_name": [[k, v] for k, v in fbn.items()],
            "sql_names": [[k, v] for k, v in sql_names.items()],
        },
    )

    # ---- probe 4: generator dispatch -----------------------------------------
    # The RESOLVED table per generator class. Uses upstream's own `_build_dispatch`
    # rather than reimplementing it, so the snapshot cannot drift from the algorithm
    # it is meant to pin. Semantics that matter (generator.py:78):
    #   - seeded from TRANSFORMS, so TRANSFORMS beats *_sql
    #   - only `*_sql` whose stripped key is a real EXPR_CLASS key participates
    #     (so helpers like `binary_sql` are excluded)
    #   - `_`-prefixed methods are excluded
    from sqlglot.generator import _build_dispatch

    def dispatch_for(gcls):
        resolved = _build_dispatch(gcls)
        transforms = getattr(gcls, "TRANSFORMS", {}) or {}
        entries = []
        for expr_cls, handler in resolved.items():
            entries.append(
                [
                    expr_cls.__name__,
                    "transform" if expr_cls in transforms else getattr(handler, "__name__", "?"),
                ]
            )
        entries.sort()
        return {
            "resolved_count": len(resolved),
            "transform_count": len(transforms),
            "from_transforms": sum(1 for _, h in entries if h == "transform"),
            "from_method": sum(1 for _, h in entries if h != "transform"),
            "entries": entries,
        }

    dispatch = OrderedDict()
    dispatch["Generator"] = dispatch_for(Generator)
    for name, dcls in sorted(Dialect.classes.items()):
        gcls = getattr(dcls, "Generator", None)
        if gcls is not None:
            dispatch[name] = dispatch_for(gcls)
    write("dispatch", {"count": len(dispatch), "classes": dispatch})

    # ---- probe 5: dialect registry + settings --------------------------------
    SETTING_PREFIXES = ("__", "Parser", "Generator", "Tokenizer")

    def settings_of(cls):
        out = OrderedDict()
        for name in sorted(dir(cls)):
            if name.startswith(SETTING_PREFIXES):
                continue
            if not name.isupper():
                continue
            try:
                out[name] = jsonable(getattr(cls, name))
            except Exception:  # noqa: BLE001
                out[name] = {"__error__": True}
        return out

    dialects = OrderedDict()
    for name, dcls in sorted(Dialect.classes.items()):
        dialects[name] = {
            "class": dcls.__name__,
            "bases": [b.__name__ for b in dcls.__mro__[1:] if b is not object],
            "settings": settings_of(dcls),
        }
    write("dialects", {"count": len(dialects), "dialects": dialects})

    # ---- probe 6: parser + tokenizer table shapes ----------------------------
    def table_sizes(cls, names):
        out = OrderedDict()
        for n in names:
            v = getattr(cls, n, None)
            if v is None:
                continue
            try:
                out[n] = len(v)
            except TypeError:
                out[n] = None
        return out

    PARSER_TABLES = [
        "FUNCTIONS", "STATEMENT_PARSERS", "EXPRESSION_PARSERS", "PROPERTY_PARSERS",
        "ALTER_PARSERS", "RANGE_PARSERS", "NO_PAREN_FUNCTIONS", "TYPE_TOKENS",
        "ID_VAR_TOKENS", "TABLE_ALIAS_TOKENS", "FUNC_TOKENS", "CONJUNCTION",
        "EQUALITY", "COMPARISON", "BITWISE", "TERM", "FACTOR",
    ]
    TOKENIZER_TABLES = ["KEYWORDS", "SINGLE_TOKENS", "COMMANDS", "COMMAND_PREFIX_TOKENS"]

    parsers = OrderedDict()
    parsers["Parser"] = table_sizes(Parser, PARSER_TABLES)
    tokenizers = OrderedDict()
    tokenizers["Tokenizer"] = table_sizes(Tokenizer, TOKENIZER_TABLES)
    for name, dcls in sorted(Dialect.classes.items()):
        p = getattr(dcls, "Parser", None)
        if p is not None:
            parsers[name] = table_sizes(p, PARSER_TABLES)
        t = getattr(dcls, "Tokenizer", None)
        if t is not None:
            tokenizers[name] = table_sizes(t, TOKENIZER_TABLES)
    write("parsers", {"parsers": parsers, "tokenizers": tokenizers})

    print(f"  probe 1 tokens     {len(list(TokenType))} token types", file=sys.stderr)
    print(f"  probe 2 exprs      {len(exprs)} expression classes", file=sys.stderr)
    print(
        f"  probe 3 functions  {len(all_functions)} ALL_FUNCTIONS, "
        f"{len(fbn)} FUNCTION_BY_NAME",
        file=sys.stderr,
    )
    print(
        f"  probe 4 dispatch   {len(dispatch)} generator classes "
        f"(base {dispatch['Generator']['resolved_count']} resolved, "
        f"snowflake {dispatch.get('snowflake', {}).get('resolved_count', '?')})",
        file=sys.stderr,
    )
    print(f"  probe 5 dialects   {len(dialects)} registered", file=sys.stderr)
    print(f"  probe 6 parsers    {len(parsers)} parser / {len(tokenizers)} tokenizer classes",
          file=sys.stderr)


if __name__ == "__main__":
    main()
