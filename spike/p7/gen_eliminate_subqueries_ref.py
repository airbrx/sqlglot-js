#!/usr/bin/env python3
"""CPython oracle for `sqlglot/optimizer/eliminate_subqueries.py`.

`src/optimizer/eliminate_subqueries.js` is greenfield -- like `optimize_joins.js`
(P7/R45) and `qualify_tables.js`/`isolate_table_selects.js` (P7/R50), it has no
consumer yet in this port and zero `corpus/atoms.jsonl` tie-in, so this is the honest
differential signal: exercise the REAL CPython function with a curated battery and dump
`.sql()`, following the exact recipe `gen_optimize_joins_ref.py` established.

Every scenario is hand-picked to hit one specific branch, each verified against a live
CPython REPL before being written down here:
  - the module's own two docstring examples (single derived table -> CTE; two
    STRUCTURALLY IDENTICAL derived tables deduplicated into one CTE, reused by alias)
  - a derived table whose inner query is a UNION (SetOperation), not a bare Select
  - an already-aliased derived table that duplicates an EXISTING top-level CTE's body --
    `existing_ctes` is pre-populated from `with_.expressions` before any new CTE is
    minted, so the duplicate reuses the existing CTE's own alias rather than getting a
    fresh one
  - a query with no derived tables or CTEs at all: `build_scope` still returns a root,
    but `_eliminate` never fires, so `new_ctes` stays empty and the query passes through
    completely untouched (the genuine top-level no-op)
  - a derived table NESTED INSIDE an existing CTE's own body: exercises the "maintain
    the DAG order" comment (py:80-81) -- the newly-minted inner CTE must be emitted
    BEFORE the existing outer CTE it was pulled out of, not after
  - `eliminate_subqueries` itself is a `Subquery`-rooted expression (e.g. a parenthesized
    query with a trailing `LIMIT`): the top-of-function `isinstance(expression,
    exp.Subquery)` branch recurses into `expression.this` and mutates it in place,
    leaving the outer wrapper's own shape (and the LIMIT) untouched
  - the `parent_scope.pivots` guard (py:135, a PIVOTed derived table is never
    eliminated) is NOT exercised here: this port's `_parse_pivot` is not ported yet
    (`parser.py:5404`, unrelated to this issue), so no SQL string can reach it through
    `parseOne`. Covered instead by a hand-built-AST unit test in
    `test/eliminate_subqueries.test.mjs` that sets the `pivots` arg directly, bypassing
    the parser gap.
  - a LATERAL correlated subquery is never eliminated (`isinstance(parent_scope.
    expression, exp.Lateral)` guard, py:135)
  - a WHERE-clause (value-position) subquery is SUBQUERY-scoped, not DERIVED_TABLE- or
    CTE-scoped, so `_eliminate` returns None for it and it is left exactly as written --
    contrasting derived tables (FROM/JOIN position), which ARE eliminated
  - `WITH RECURSIVE`: the `recursive` flag threads through even when nothing new is
    eliminated from the CTE's own body (the WITH clause gets rebuilt, but the rendered
    SQL is byte-identical to the input, since the sole CTE is re-appended unchanged)
  - an aliased derived table whose alias STRING collides with an already-`taken` name --
    two flavors: colliding with a REAL bare table reference elsewhere in the same query
    (`find_new_name` bumps `t` -> `t_2`), and two UNALIASED derived tables colliding with
    each other and with the synthetic `"cte"` base name (`cte`, then `cte_2`)
  - an UPDATE ... FROM (subquery) AS s: a genuine upstream STRUCTURAL gap, not a bug in
    this port -- `_traverse_scope`'s DML branch only scopes bare `exp.Table` relations
    into `root.table_scopes`; a Subquery in FROM/USING position gets re-scoped as a
    disconnected ROOT-type scope that is never appended to `root.table_scopes` /
    `subquery_scopes` / `union_scopes`, so the loop that calls `_eliminate` never visits
    it and the subquery is left completely untouched. Recorded here specifically so a
    correct-but-surprising upstream quirk doesn't get "fixed" into a divergence later.

    PYTHONHASHSEED=0 python3 spike/p7/gen_eliminate_subqueries_ref.py > spike/out/eliminate_subqueries.json
    node spike/p7/fuzz_eliminate_subqueries.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import parse_one  # noqa: E402
from sqlglot.optimizer.eliminate_subqueries import eliminate_subqueries  # noqa: E402

SCENARIOS = [
    # --- The module's own two docstring examples (py:20-29), mirrored exactly. ---
    ("docstring-basic", "SELECT a FROM (SELECT * FROM x) AS y"),
    ("docstring-dedup-cross-join",
     "SELECT a FROM (SELECT * FROM x) AS y CROSS JOIN (SELECT * FROM x) AS z"),

    # --- A derived table whose inner query is a SetOperation, not a bare Select. ---
    ("union-subquery", "SELECT a FROM (SELECT * FROM x UNION ALL SELECT * FROM y) AS z"),

    # --- A derived table that duplicates an EXISTING top-level CTE's body: `existing_
    #     ctes` is seeded from `with_.expressions` up front, so the duplicate reuses
    #     `w`'s own alias rather than minting a new one. ---
    ("existing-cte-dedup",
     "WITH w AS (SELECT * FROM x) SELECT a FROM w CROSS JOIN (SELECT * FROM x) AS y"),

    # --- No derived tables or CTEs anywhere: `new_ctes` stays empty, the query passes
    #     through completely untouched. ---
    ("full-noop-no-subqueries", "SELECT a FROM x"),
    ("full-noop-root-union", "SELECT * FROM x UNION SELECT * FROM y"),

    # --- A derived table nested INSIDE an existing CTE's own body: the newly-minted
    #     inner CTE must be emitted BEFORE the existing outer CTE (DAG order, py:80-81),
    #     and the outer CTE's body is rewritten to reference it by name. ---
    ("nested-derived-table-inside-existing-cte",
     "WITH w AS (SELECT * FROM (SELECT * FROM x) AS inner_) SELECT * FROM w"),

    # --- `eliminate_subqueries` itself is called on a `Subquery`-rooted expression (a
    #     parenthesized query with a trailing LIMIT): recurses into `expression.this`
    #     in place, leaving the LIMIT wrapper itself untouched. ---
    ("root-is-subquery-with-limit",
     "(SELECT a FROM (SELECT * FROM x) AS y) LIMIT 1"),

    # --- A LATERAL correlated subquery is never eliminated (`isinstance(parent_scope.
    #     expression, exp.Lateral)` guard). ---
    ("lateral-preserved",
     "SELECT * FROM x, LATERAL (SELECT * FROM y WHERE y.a = x.a) AS z"),

    # --- A WHERE-clause (value-position) subquery is SUBQUERY-scoped, not derived-table-
    #     or CTE-scoped, so it is left exactly as written -- contrast with the FROM-
    #     position derived tables above, which ARE eliminated. ---
    ("where-clause-subquery-not-eliminated",
     "SELECT a FROM x WHERE x.id IN (SELECT id FROM y)"),

    # --- WITH RECURSIVE: the `recursive` flag threads through the rebuilt WITH clause
    #     even though nothing new is eliminated from the CTE's own (SetOperation) body --
    #     the sole CTE is re-appended unchanged, so the rendered SQL is byte-identical
    #     to the input. ---
    ("recursive-cte-flag-preserved",
     "WITH RECURSIVE w AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM w WHERE n < 5) "
     "SELECT * FROM w"),

    # --- An aliased derived table whose alias string collides with a REAL bare table
    #     reference elsewhere in the same query: `taken` is pre-populated with every
    #     real table name before any CTE is minted, so `find_new_name` bumps `t` -> `t_2`. ---
    ("alias-collides-with-real-table-reference",
     "SELECT a FROM (SELECT * FROM x) AS t CROSS JOIN t"),

    # --- Two UNALIASED derived tables: the first falls back to the synthetic `"cte"`
    #     base name, the second collides with it and gets bumped to `cte_2`. ---
    ("unaliased-derived-table", "SELECT a FROM (SELECT * FROM x)"),
    ("two-unaliased-derived-tables-collide",
     "SELECT a FROM (SELECT * FROM x) CROSS JOIN (SELECT * FROM y)"),

    # --- UPDATE ... FROM (subquery): a genuine upstream STRUCTURAL gap, not a bug --
    #     `_traverse_scope`'s DML branch never links a FROM/USING-position Subquery into
    #     `root.table_scopes`, so it is never visited and stays completely untouched.
    #     Recorded so this surprising-but-correct quirk isn't "fixed" into a divergence
    #     later. ---
    ("dml-update-from-subquery-structural-noop",
     "UPDATE t SET a = 1 FROM (SELECT id FROM x) AS s WHERE t.id = s.id"),
]


def run_one(sql):
    try:
        ast = parse_one(sql)
        out = eliminate_subqueries(ast)
        return {"ok": out.sql()}
    except Exception as e:  # noqa: BLE001
        return {"error": type(e).__name__, "message": str(e)}


records = [{"name": name, "sql": sql, "result": run_one(sql)} for name, sql in SCENARIOS]

print(json.dumps({"scenarios": records}))
