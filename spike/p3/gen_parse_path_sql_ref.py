#!/usr/bin/env python3
"""The DECISIVE generator-kernel oracle: what the parse path actually generates.

`fuzz_generator_kernel.mjs` proves the kernel is CORRECT over 73k nodes. This proves it
is SUFFICIENT: every sub-AST that CPython's parser hands to the generator mid-parse,
with the string it produced. The kernel must render all of them with zero refusals —
a refusal here means a real parse would silently get a different AST.

Instrumented rather than reasoned about: `Expression.sql` is wrapped, the caller's frame
is inspected, and every corpus input is parsed. That is how the five IMPLICIT `f"{expr}"`
call sites were found at all — `grep '\\.sql('` shows only two of the seven.
"""
import json
import logging
import os
import re
import sys
from collections import OrderedDict

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)
logging.disable(logging.CRITICAL)
import sqlglot  # noqa: E402
from sqlglot import expressions as exp  # noqa: E402

_OBJ_ADDR_RE = re.compile(r" object at 0x[0-9a-fA-F]+")


def dump(node):
    """Same shape as tools/astdump.py's dump(), so the JS side can `astLoad` it."""
    if isinstance(node, exp.Expr):
        out = OrderedDict()
        out["c"] = type(node).__name__
        out["a"] = [[k, dump(v)] for k, v in node.args.items()]
        meta = node._meta
        out["m"] = dict(meta) if meta else None
        out["cm"] = list(node.comments) if node.comments else None
        node_type = node.type
        out["t"] = dump(node_type) if (node_type is not None and not node.is_data_type) else None
        return out
    if isinstance(node, list):
        return [dump(v) for v in node]
    if isinstance(node, tuple):
        return {"__tuple__": [dump(v) for v in node]}
    if isinstance(node, bool) or node is None:
        return node
    if isinstance(node, (str, int, float)):
        return node
    return {"__repr__": _OBJ_ADDR_RE.sub(" object at 0x0", repr(node))}


rows = []
seen = set()


def make(orig):
    def traced(self, *a, **kw):
        depth = 1
        while depth <= 8:
            try:
                frame = sys._getframe(depth)
            except ValueError:
                break
            if frame.f_code.co_filename.endswith("sqlglot/parser.py"):
                out = orig(self, *a, **kw)
                key = (frame.f_lineno, out, type(self).__name__)
                if key not in seen:
                    seen.add(key)
                    rows.append({
                        "site": f"parser.py:{frame.f_lineno}",
                        "fn": frame.f_code.co_name,
                        "cls": type(self).__name__,
                        "sql": out,
                        "ast": dump(self),
                    })
                return out
            depth += 1
        return orig(self, *a, **kw)
    return traced


# BOTH classes: `Expression` (core.py:824) overrides `Expr` (core.py:52), and real nodes
# are Expression subclasses — patching only `Expr.sql` silently records nothing.
exp.Expression.sql = make(exp.Expression.sql)
exp.Expr.sql = make(exp.Expr.sql)

n = 0
inputs = set()
for line in open("corpus/atoms.jsonl"):
    a = json.loads(line)
    key = (a["read"], a["sql"])
    if key in inputs:
        continue
    inputs.add(key)
    n += 1
    try:
        sqlglot.parse(a["sql"], read=a["read"] or None)
    except Exception:  # noqa: BLE001
        pass

# Synthetic cases for the sites the corpus does not reach, so the kernel is still
# checked against them rather than being assumed fine.
EXTRA = [
    ("mysql", "CREATE DEFINER=`u`@`h` VIEW v AS SELECT 1"),
    ("mysql", "ALTER DEFINER = 'admin'@'localhost' VIEW v AS SELECT * FROM foo"),
    ("", "SELECT CASE WHEN a THEN b ELSE INTERVAL END"),
    ("snowflake", "SELECT CASE WHEN a THEN b ELSE INTERVAL END"),
    ("snowflake", "SELECT * FROM t PIVOT(SUM(x) FOR y IN (SELECT DISTINCT q FROM z ORDER BY q NULLS LAST))"),
    ("tsql", "CREATE TABLE t (a INT) WITH (SYSTEM_VERSIONING = ON (HISTORY_RETENTION_PERIOD = 5 DAYS))"),
]
for read, sql in EXTRA:
    try:
        sqlglot.parse(sql, read=read or None)
    except Exception:  # noqa: BLE001
        pass

for row in rows:
    print(json.dumps(row, ensure_ascii=False))

sites = sorted({r["site"] for r in rows})
print(f"  {len(rows)} distinct parse-path generate calls over {n} corpus inputs "
      f"+ {len(EXTRA)} synthetic; sites: {', '.join(sites)}", file=sys.stderr)
