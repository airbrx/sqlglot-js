#!/usr/bin/env python3
"""CPython oracle for `sqlglot/optimizer/eliminate_ctes.py`.

`src/optimizer/eliminate_ctes.js` is greenfield -- like its sibling file `eliminate_
subqueries.js` (this same issue) and `optimize_joins.js` (P7/R45), it has no consumer
yet in this port and zero `corpus/atoms.jsonl` tie-in, so this is the honest
differential signal: exercise the REAL CPython function with a curated battery and dump
`.sql()`, following the exact recipe `gen_optimize_joins_ref.py` established.

Every scenario is hand-picked to hit one specific branch, each verified against a live
CPython REPL before being written down here:
  - the module's own docstring example: a single unused CTE is removed, and the WITH
    clause itself disappears since it was the only CTE
  - a CTE referenced exactly once is KEPT, not inlined -- this module only ever DELETES
    zero-reference CTEs, it never rewrites a reference into its definition (confirmed
    directly against the source: there is no inlining code path at all)
  - multiple CTEs where only SOME are unused: the used one survives, the WITH clause
    survives (it still has a member), and the unused ones are removed
  - a CHAIN of unused CTEs (`a` unused, `b` selects only from unused `a`, `c` selects
    only from unused `b`, the final query selects from neither): traversing the scope
    tree in REVERSE (py:35) lets one pass remove the whole chain, since removing `c`
    decrements `b`'s ref count to zero, which decrements `a`'s in the same pass
  - a CTE that references another CTE and both are actually used: neither is removed
  - no WITH clause at all: `build_scope` still returns a root, but no scope is ever
    `is_cte`, so the query passes through completely untouched
  - a CTE referenced only via a SEMI or ANTI join: `_semi_anti_join_tables` bumps the
    ref count anyway (py:638-642 upstream / the `Scope.ref_count` docstring's own
    comment) specifically so a join whose right side is never "selected" in the normal
    sense doesn't get optimized away
  - a CTE referenced only from a correlated (WHERE-clause) subquery of a later part of
    the query: `ref_count` is computed over the WHOLE scope tree via `root.traverse()`,
    not just direct FROM/JOIN references, so this still counts as a real reference

    PYTHONHASHSEED=0 python3 spike/p7/gen_eliminate_ctes_ref.py > spike/out/eliminate_ctes.json
    node spike/p7/fuzz_eliminate_ctes.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import parse_one  # noqa: E402
from sqlglot.optimizer.eliminate_ctes import eliminate_ctes  # noqa: E402

SCENARIOS = [
    # --- The module's own docstring example (py:17-22), mirrored exactly. ---
    ("docstring-unused-cte-removed", "WITH y AS (SELECT a FROM x) SELECT a FROM z"),

    # --- A CTE referenced exactly once is KEPT, not inlined. ---
    ("used-cte-kept", "WITH y AS (SELECT a FROM x) SELECT a FROM y"),

    # --- Multiple CTEs where only some are unused: the used one and the WITH clause
    #     itself both survive. ---
    ("multiple-ctes-some-unused",
     "WITH a AS (SELECT 1), b AS (SELECT 2), c AS (SELECT 3) SELECT * FROM b"),

    # --- A chain of unused CTEs: reverse traversal (py:35) removes the whole chain in
    #     one pass, since removing the last link decrements the ref count of the one
    #     before it. ---
    ("chain-of-unused-ctes-removed-in-one-pass",
     "WITH a AS (SELECT * FROM x), b AS (SELECT * FROM a), c AS (SELECT * FROM b) SELECT 1"),

    # --- A CTE that references another CTE, both actually used: neither is removed. ---
    ("cte-references-another-used-cte-both-kept",
     "WITH a AS (SELECT * FROM x), b AS (SELECT * FROM a) SELECT * FROM b"),

    # --- No WITH clause at all: passes through completely untouched. ---
    ("no-with-clause-full-noop", "SELECT a FROM x"),

    # --- A CTE referenced only via a SEMI or ANTI join: `_semi_anti_join_tables` bumps
    #     the ref count anyway, so it is kept even though it's never a "selected
    #     source" in the ordinary sense. ---
    ("semi-join-keeps-cte",
     "WITH a AS (SELECT id FROM x) SELECT * FROM y SEMI JOIN a ON y.id = a.id"),
    ("anti-join-keeps-cte",
     "WITH a AS (SELECT id FROM x) SELECT * FROM y ANTI JOIN a ON y.id = a.id"),

    # --- A CTE referenced only from a correlated (WHERE-clause) subquery: `ref_count`
    #     walks the WHOLE scope tree, not just direct FROM/JOIN references. ---
    ("cte-used-only-in-correlated-subquery-kept",
     "WITH a AS (SELECT id FROM x) SELECT * FROM y WHERE y.id IN (SELECT id FROM a)"),
]


def run_one(sql):
    try:
        ast = parse_one(sql)
        out = eliminate_ctes(ast)
        return {"ok": out.sql()}
    except Exception as e:  # noqa: BLE001
        return {"error": type(e).__name__, "message": str(e)}


records = [{"name": name, "sql": sql, "result": run_one(sql)} for name, sql in SCENARIOS]

print(json.dumps({"scenarios": records}))
