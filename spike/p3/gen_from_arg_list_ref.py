#!/usr/bin/env python3
"""CPython oracle for `Func.from_arg_list` over EVERY function class.

P2 left `from_arg_list` unported; P3's `FUNCTIONS` table binds it for hundreds of
names, so it has to be right for all 563 `ALL_FUNCTIONS`, not for the three that
happened to surface it. Argument counts straddle each class's arity so the
zip-stops-at-shorter and var-len-tail behaviours are both exercised.
"""
import json
import os
import sys

sys.path.insert(0, os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref"))
from sqlglot import expressions as exp  # noqa: E402

# Simple, reprable leaf arguments — the point is arg PLACEMENT, not arg content.
def mk(i):
    return exp.Literal(this=str(i), is_string=False)

rows = []
for cls in exp.ALL_FUNCTIONS:
    n_keys = len(cls.arg_types)
    for count in sorted({0, 1, 2, max(0, n_keys - 1), n_keys, n_keys + 1, n_keys + 2}):
        args = [mk(i) for i in range(count)]
        try:
            node = cls.from_arg_list(args)
            out = repr(node)
        except Exception as e:  # noqa: BLE001
            out = f"<{type(e).__name__}>"
        rows.append({
            "cls": cls.__name__,
            "n": count,
            "is_var_len": bool(cls.is_var_len_args),
            "var_key": cls.var_len_arg_key,
            "repr": out,
        })

for r in rows:
    print(json.dumps(r, ensure_ascii=False))
print(f"  {len(rows)} from_arg_list cases over {len(exp.ALL_FUNCTIONS)} classes",
      file=sys.stderr)
