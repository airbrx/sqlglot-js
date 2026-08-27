#!/usr/bin/env python3
"""Extract the FULL contents of every `Parser` class-level table from upstream.

PORT_PLAN.md §8.1 Rule 2' — "seed these tables one entry per line in upstream
declaration order ... Table ORDER is CI-asserted against a `_gen/` snapshot, because
§4.6 establishes that insertion order is observable in output SQL."

Parity probe 6 already existed at P0, but it compares `len()` only. A size check cannot
tell `{TokenType.SELECT, TokenType.FROM}` from `{TokenType.FROM, TokenType.WHERE}`, and
cannot see order at all — so it does not actually assert the thing Rule 2' is about.
This snapshot carries every entry, so `check_parser_tables.mjs` can assert values and,
for the dicts, order.

  python3 tools/parity/extract_parser_tables.py     # -> corpus/parity/parser_tables.json

ORDER SEMANTICS, and why they differ per container kind:

  * dict tables  — insertion order is defined by Python and observable, so the snapshot
    keeps it and the checker asserts the key SEQUENCE.
  * set tables   — a Python set has no insertion order; its iteration order is a hash
    artifact. Asserting it would pin a non-contract. The snapshot sorts them and the
    checker compares MEMBERSHIP. The *source* order the seeder emits is still the merge
    contract (one entry per line, upstream declaration order) — that is asserted from
    the source text by `lint_parser_shape.mjs`, not from runtime values.
"""

import json
import os
import sys
from collections import OrderedDict

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)

OUT = "corpus/parity"


def render_key(k):
    """Dict keys as a single comparable string.

    Non-scalar keys are real: `VERSION_PHRASES` is keyed by TUPLES of words. Both sides
    must agree on the encoding, so use JSON rather than each language's `str()` —
    Python's would give "['FOR', 'SYSTEM_TIME']" and JS's "FOR,SYSTEM_TIME".
    """
    r = render(k)
    # `separators` matters: Python's default emits ", " between items, JSON.stringify
    # emits ",". Same data, different bytes, and this key is compared as bytes.
    return r if isinstance(r, str) else json.dumps(
        r, ensure_ascii=False, separators=(",", ":")
    )


def render(v):
    """Symbolic, JS-comparable rendering of one table entry."""
    from sqlglot import exp
    from sqlglot.tokens import TokenType

    if isinstance(v, TokenType):
        return f"TokenType.{v.name}"
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, type):
        # exp.Select, exp.DataType, ... — a class reference the port resolves by name.
        if getattr(exp, v.__name__, None) is v:
            return f"exp.{v.__name__}"
        return f"<class:{v.__name__}>"
    if isinstance(v, (list, tuple)):
        return [render(x) for x in v]
    if isinstance(v, (set, frozenset)):
        return {"__set__": sorted(str(render(x)) for x in v)}
    if isinstance(v, dict):
        return {"__dict__": [[render_key(k), render(x)] for k, x in v.items()]}
    if callable(v):
        # Deliberately NOT compared by identity: 398 of `parser.py`'s 994 table entries
        # are lambdas/builders that the stub queue ports one at a time. The checker only
        # asserts that a ported entry is *present and callable*, never what it returns —
        # that is the individual stub task's own oracle (§8.3).
        return {"__callable__": getattr(v, "__name__", "<lambda>")}
    return {"__repr__": repr(v)}


def main():
    from sqlglot.parser import Parser

    tables = OrderedDict()
    for name in sorted(vars(Parser)):
        if name.startswith("_"):
            continue
        v = getattr(Parser, name)
        if isinstance(v, (dict, set, frozenset, list, tuple)):
            kind = (
                "dict" if isinstance(v, dict)
                else "set" if isinstance(v, (set, frozenset))
                else "seq"
            )
            tables[name] = {"kind": kind, "size": len(v), "entries": render(v)}

    n_callable = 0
    n_total = 0
    for t in tables.values():
        e = t["entries"]
        items = (
            [x[1] for x in e["__dict__"]] if t["kind"] == "dict"
            else e["__set__"] if t["kind"] == "set"
            else e
        )
        for x in items:
            n_total += 1
            if isinstance(x, dict) and "__callable__" in x:
                n_callable += 1

    payload = {
        "_comment": (
            "Full contents of every sqlglot.parser.Parser class-level container, for "
            "PORT_PLAN.md §8.1 Rule 2'. dict tables assert key ORDER; set tables assert "
            "MEMBERSHIP only (a Python set has no insertion order). Regenerate: "
            "python3 tools/parity/extract_parser_tables.py"
        ),
        "ref": REF,
        "python": sys.version.split()[0],
        "counts": {
            "tables": len(tables),
            "entries": n_total,
            "callable_entries": n_callable,
        },
        "tables": tables,
    }
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "parser_tables.json"), "w", encoding="utf8") as f:
        json.dump(payload, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print(
        f"  corpus/parity/parser_tables.json: {len(tables)} tables, {n_total} entries "
        f"({n_callable} callable-valued)",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
