#!/usr/bin/env python3
"""CPython oracle for `sqlglot/optimizer/unnest_subqueries.py`.

`src/optimizer/unnest_subqueries.js` is greenfield -- no consumer in this port yet,
same shape as `optimize_joins.js` (R45) and `schema.js` (R41), so unlike the AST-
parsing/generation corpus this module has no `corpus/atoms.jsonl` coverage at all.
Following the recipe `spike/p7/gen_optimize_joins_ref.py` established: exercise the
REAL CPython function with a curated battery and dump `.sql()` output, so a JS-side
mismatch is provably an `unnest_subqueries.js` bug and not a coincidence. Every
scenario runs through the top-level `unnest_subqueries(parse_one(sql))` entry point
(not `unnest`/`decorrelate` directly), matching the task's own framing and this port's
own `Generator` (already verified elsewhere) turning any AST divergence into visibly
different SQL text.

Every scenario is hand-picked and was independently verified against a live CPython
REPL before being written down here (not predicted by reading the Python source),
because this module has two non-obvious dispatch gates that are easy to get wrong by
inspection alone:

  1. `Scope.external_columns` (scope.py:463) is a SYNTACTIC heuristic with no schema:
     an UNQUALIFIED column (no `table.` prefix) is conservatively treated as
     "references an outer scope" even when it plainly resolves to the subquery's own
     single FROM source. `MAX(a)` inside `(SELECT MAX(a) FROM y)` therefore makes that
     subquery's scope look "correlated" and routes it to `decorrelate()` -- which then
     no-ops if there is no WHERE clause to hang the (nonexistent) correlation off of.
     Every scenario below that is meant to hit `unnest()`'s (uncorrelated) path
     qualifies every column explicitly to avoid tripping this heuristic by accident.
  2. `unnest()`'s scalar-subquery branch (py:88, `elif not isinstance(select.parent,
     exp.Subquery): return`) means `EXISTS(...)`/`ANY(...)`/`ALL(...)` -- which wrap
     their argument directly as `this` with NO intervening `Subquery` node -- almost
     never take the scalar-cross-join path when UNCORRELATED (only the Having/group/
     agg Max-wrap branch can still fire for them, since it never inspects
     `select.parent`); only a genuinely parenthesized value subquery like `(SELECT
     ...) = 5` gets a `Subquery` wrapper and can fall through to the plain CROSS JOIN.
     Several scenarios below assert this "stays exactly as parsed" outcome directly,
     because it is easy to *expect* EXISTS/IN symmetry here and there isn't any.

    PYTHONHASHSEED=0 python3 spike/p7/gen_unnest_subqueries_ref.py > spike/out/unnest_subqueries.json
    node spike/p7/fuzz_unnest_subqueries.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import parse_one  # noqa: E402
from sqlglot.optimizer.unnest_subqueries import unnest_subqueries  # noqa: E402

SCENARIOS = [
    # --- The module's own docstring example (py:16-19), mirrored exactly: a
    #     correlated scalar subquery in WHERE, unaliased projection (empty
    #     `value.alias`), decorrelate()'s plain-EQ tail. ---
    ("module-docstring",
     "SELECT * FROM x AS x WHERE (SELECT y.a AS a FROM y AS y WHERE x.a = y.a) = 1"),

    # === unnest() -- UNCORRELATED subqueries (ScopeType.SUBQUERY, no external cols) ===

    # A genuinely parenthesized scalar subquery DOES get a `Subquery` wrapper, so the
    # `elif not isinstance(select.parent, exp.Subquery): return` guard passes and the
    # plain CROSS JOIN path fires. Every column is qualified to keep external_columns
    # empty (see file header, hazard 1).
    ("uncorrelated-scalar-cross-join", "SELECT * FROM x WHERE (SELECT MAX(y.a) FROM y) = 5"),
    ("uncorrelated-scalar-cross-join-column-operand",
     "SELECT * FROM x WHERE (SELECT y.a FROM y) = x.b"),
    ("uncorrelated-scalar-in-join-on-clause",
     "SELECT x.a FROM x JOIN y ON x.a = (SELECT MAX(z.b) FROM z)"),

    # EXISTS/ANY/ALL wrap their argument directly (no `Subquery` node) -- see file
    # header hazard 2. Uncorrelated EXISTS/IN/ANY/NOT-IN/NOT-EXISTS, and a bare
    # unwrapped-operator scalar subquery projection, all stay exactly as parsed.
    ("uncorrelated-exists-left-alone",
     "SELECT * FROM x WHERE EXISTS(SELECT 1 FROM y WHERE y.a = 1)"),
    ("uncorrelated-not-exists-left-alone",
     "SELECT * FROM x WHERE NOT EXISTS(SELECT 1 FROM y WHERE y.a = 1)"),
    ("uncorrelated-not-in-left-alone-not-guard",
     # py:58 -- `isinstance(predicate, exp.In) and isinstance(predicate.parent, exp.Not)`
     # -- the ONE case `unnest()` explicitly refuses, independent of the Subquery guard.
     "SELECT * FROM x WHERE x.a NOT IN (SELECT y.a FROM y)"),
    ("uncorrelated-projection-no-condition-ancestor-left-alone",
     # No enclosing operator at all -> find_ancestor(exp.Condition) is None -> py:46-47
     # early return. Contrast with the next scenario, wrapped in `+`.
     "SELECT (SELECT MAX(y.a) FROM y) FROM x"),
    ("uncorrelated-projection-with-group-left-alone",
     # Still no Condition ancestor (bare projection), independent of the sibling
     # GROUP BY -- confirms the guard is about the AST shape, not the query shape.
     "SELECT x.c, (SELECT MAX(y.a) FROM y) FROM x GROUP BY x.c"),

    # ANY/IN uncorrelated: the `isinstance(predicate, (exp.In, exp.Any))` branch (the
    # ARRAY_AGG-and-join-key path, py:106-145) rather than the scalar cross-join path.
    ("uncorrelated-in-array-agg-join", "SELECT * FROM x WHERE x.a IN (SELECT y.a FROM y)"),
    ("uncorrelated-any-array-agg-join", "SELECT * FROM x WHERE x.a = ANY(SELECT y.a FROM y)"),

    # A `SetOperation` (UNION) subquery gets rewrapped into a fresh single-column
    # `Select` over itself as a derived table (py:62-69) before the rest of `unnest()`
    # runs -- only reachable via IN/ANY, since a bare UNION can't be a scalar operand.
    ("uncorrelated-union-subquery-rewrapped",
     "SELECT * FROM x WHERE x.a IN (SELECT y.a FROM y UNION SELECT z.a FROM z)"),

    # Table-valued-function guard (py:48-53): a subquery used as an argument to a
    # function that is itself the direct child of a Table/From/Join is left alone so
    # join order is preserved.
    ("table-valued-func-guard-left-alone",
     "SELECT * FROM x, UNNEST((SELECT ARRAY_AGG(y.a) FROM y)) AS t"),

    # No FROM on the outer query (py:55 `not parent_select.args.get("from_")`).
    ("no-outer-from-left-alone", "SELECT (SELECT 1 FROM y)"),

    # HAVING clause containing the scalar subquery, matching `clause_parent_select is
    # parent_select` -> the Having branch of the Max-wrap condition (py:80), distinct
    # from the group/agg-sibling branch the GROUP BY scenario above exercises.
    ("having-clause-max-wrap", "SELECT * FROM x HAVING (SELECT MAX(y.a) FROM y) = 5"),

    # === decorrelate() -- CORRELATED subqueries (external_columns non-empty) ===

    ("correlated-exists", "SELECT * FROM x WHERE EXISTS(SELECT 1 FROM y WHERE y.a = x.a)"),
    ("correlated-not-exists",
     # The outer NOT wrapper is untouched; decorrelate() only rewrites the EXISTS node
     # it found via find_ancestor(exp.Predicate), same as py:249-251's own note.
     "SELECT * FROM x WHERE NOT EXISTS(SELECT 1 FROM y WHERE y.a = x.a)"),
    ("correlated-scalar-eq-in-where",
     "SELECT * FROM x WHERE x.a = (SELECT MAX(y.b) FROM y WHERE y.a = x.a)"),
    ("correlated-scalar-projection-unaliased",
     "SELECT x.a, (SELECT MAX(y.b) FROM y WHERE y.a = x.a) FROM x"),
    ("correlated-scalar-projection-aliased",
     # `is_subquery_projection and select.parent.alias` branch (py:275-276).
     "SELECT x.a, (SELECT MAX(y.b) FROM y WHERE y.a = x.a) AS m FROM x"),
    ("correlated-count-projection-coalesce",
     # find_in_scope(value, exp.Count) -> remove_aggs/Coalesce rewrite (py:280-289).
     "SELECT x.a, (SELECT COUNT(*) FROM y WHERE y.a = x.a) FROM x"),
    ("correlated-in", "SELECT * FROM x WHERE x.a IN (SELECT y.a FROM y WHERE y.b = x.b)"),
    ("correlated-not-in",
     "SELECT * FROM x WHERE x.a NOT IN (SELECT y.a FROM y WHERE y.b = x.b)"),
    ("correlated-any", "SELECT * FROM x WHERE x.a = ANY(SELECT y.a FROM y WHERE y.b = x.b)"),
    ("correlated-all", "SELECT * FROM x WHERE x.a > ALL(SELECT y.a FROM y WHERE y.b = x.b)"),
    ("correlated-key-equals-value-collapses-dedup",
     # py:199-201 -- the correlation key IS the subquery's own projected value, so
     # `key_aliases[key] = value.alias` reuses the value's own alias instead of
     # minting a fresh one, and the join key becomes `_u_0.a` not a synthetic name.
     "SELECT * FROM x WHERE x.a IN (SELECT y.a FROM y WHERE y.a = x.b)"),
    ("correlated-or-left-alone",
     # py:151 `where.find(exp.Or)` guard -- an OR anywhere in the subquery's WHERE
     # blocks decorrelate() entirely, regardless of correlation.
     "SELECT * FROM x WHERE EXISTS(SELECT 1 FROM y WHERE y.a = x.a OR y.b = 1)"),
    ("correlated-limit-left-alone",
     # py:151 `select.find(exp.Limit, exp.Offset)` guard.
     "SELECT * FROM x WHERE EXISTS(SELECT 1 FROM y WHERE y.a = x.a LIMIT 1)"),
    ("correlated-two-eq-keys",
     # Two correlated columns, both EQ predicates -> both become group-by/join keys.
     "SELECT * FROM x WHERE EXISTS(SELECT 1 FROM y WHERE y.a = x.a AND y.b = x.b)"),
    ("correlated-eq-plus-non-eq-array-any",
     # One EQ correlation key (join/group-by) plus one non-EQ (`>`) correlation key,
     # which needs the ARRAY_AGG + ARRAY_ANY/Lambda rewrite (py:303-316) instead of a
     # simple key.replace().
     "SELECT * FROM x WHERE EXISTS(SELECT 1 FROM y WHERE y.a = x.a AND y.b > x.c)"),
    ("correlated-inside-derived-table",
     # decorrelate() reached via a FROM-clause derived table's own inner scope, not
     # the top-level query -- `unnest_subqueries`'s `find_all(exp.Select)`-style scope
     # walk (via traverse_scope) has to reach it there too.
     "SELECT * FROM (SELECT * FROM p WHERE EXISTS(SELECT 1 FROM q WHERE q.a = p.a)) AS sub"),
    ("two-independent-correlated-subqueries-shared-alias-counter",
     # One correlated SELECT-list scalar and one correlated IN, in the same outer
     # query -- both rewrite, and next_alias_name() is shared/threaded across both
     # (`_u_0`..`_u_3`), not reset per-subquery.
     "SELECT t1.a, t1.b, (SELECT MAX(t2.c) FROM t2 WHERE t2.a = t1.a) AS m FROM t1 "
     "WHERE t1.b IN (SELECT t3.b FROM t3 WHERE t3.c = t1.c)"),
]


def run_one(sql):
    try:
        out = unnest_subqueries(parse_one(sql)).sql()
        return {"ok": out}
    except Exception as e:  # noqa: BLE001
        return {"error": type(e).__name__, "message": str(e)}


records = [{"name": name, "sql": sql, "result": run_one(sql)} for name, sql in SCENARIOS]

print(json.dumps({"scenarios": records}))
