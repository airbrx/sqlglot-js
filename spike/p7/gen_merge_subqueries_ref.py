#!/usr/bin/env python3
"""CPython oracle for `sqlglot/optimizer/merge_subqueries.py` (AIR-2116).

`src/optimizer/merge_subqueries.js` is greenfield -- same "no `corpus/atoms.jsonl`
tie-in" shape as `schema.js` (R41), `optimize_joins.js` (R45), `resolver.js` (R48) and
`unnest_subqueries.js` (R49): parse a SQL string, run `merge_subqueries`, dump the
resulting `.sql()`, and diff against CPython doing the same. There is no upstream
`tests/optimizer/test_merge_subqueries.py` at this pin either.

This is flagged in the epic plan as THE highest correctness-risk module in this batch:
a wrong mergeability guard silently changes result cardinality (not just SQL shape),
so this battery is organized guard-by-guard rather than feature-by-feature, and several
guards get an explicit SHOULD-merge / SHOULD-NOT-merge *pair* rather than a single
scenario, specifically to catch an off-by-one in a guard condition (e.g. `<` vs `<=`,
or a `from_or_join instanceof X` check applied to the wrong operand).

Two guards (`_window_projection_blocks_merge`'s window-function case, and the
`exp.QueryTransform` guard) cannot be exercised through a `.sql()` string comparison in
this port TODAY: `generator.py`'s `window_sql`/`querytransform_sql` are unrelated
base-`Generator` methods that are not yet ported (the "generator chain surfaces
base-Generator gaps" pattern R31/R38/R49 already named, recurring a fourth time) --
porting them is out of this issue's scope (`merge_subqueries.py` only). Those four
scenarios instead record a STRUCTURAL signal -- whether a `Subquery` node aliased
`sub` still exists anywhere in the tree after `merge_subqueries` runs, i.e. whether the
merge actually happened -- which needs no SQL rendering on either side and still
exercises the real guard code on both CPython and the port. See `is_merged` below.

Adversarial finding worth calling out up front (mirrored as scenarios 20-22 below):
`_outer_select_joins_on_inner_select_join`'s own doctest-style comment (py:218-223)
claims `SELECT * FROM x JOIN (SELECT y.a AS a FROM y JOIN z) AS q ON x.a = q.a` "can be
merged" and the z-sourced variant "can't". Verified directly against CPython: NEITHER
merges, because the earlier, unconditional guard `isinstance(from_or_join, exp.Join)
and inner_select.args.get("joins")` (py:278) already blocks any JOIN-position subquery
that itself has a JOIN, before `_outer_select_joins_on_inner_select_join` ever gets a
chance to distinguish the two cases by which table the ON-clause's columns actually
come from. The docstring's illustrative "can be merged" case is therefore DEAD given
current guard ordering -- reachable only by removing scenario 20's blocking guard
entirely, e.g. by attaching the same subquery via a bare FROM position instead of JOIN
(scenario 22), which merges fine and pulls the inner JOIN up with it via `_merge_joins`.

    PYTHONHASHSEED=0 python3 spike/p7/gen_merge_subqueries_ref.py > spike/out/merge_subqueries.json
    node spike/p7/fuzz_merge_subqueries.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import parse_one, exp  # noqa: E402
from sqlglot.optimizer.merge_subqueries import merge_subqueries  # noqa: E402

# --- SQL-comparison scenarios: (name, sql, leave_tables_isolated, dialect) ---
SQL_SCENARIOS = [
    # --- merge_subqueries's own module docstring (py:23-33), mirrored exactly:
    #     the plain case merges, the `leave_tables_isolated=True` case does not. ---
    ("module-docstring-mergeable",
     "SELECT a FROM (SELECT x.a FROM x) CROSS JOIN y", False, None),
    ("module-docstring-leave-tables-isolated-blocks",
     "SELECT a FROM (SELECT x.a FROM x) CROSS JOIN y", True, None),
    ("leave-tables-isolated-single-source-still-merges",
     # leave_tables_isolated only blocks when > 1 selected source would remain; a
     # single derived table alone in the FROM clause is unaffected by the flag.
     "SELECT a FROM (SELECT x.a FROM x) sub", True, None),

    # --- UNMERGABLE_ARGS: GROUP BY / LIMIT / DISTINCT on the inner SELECT are each,
    #     individually, enough to block the merge outright (py:56-64, 274). ---
    ("group-by-in-subquery-blocks",
     "SELECT a FROM (SELECT x.a AS a FROM x GROUP BY x.a) sub", False, None),
    ("limit-in-subquery-blocks",
     "SELECT a FROM (SELECT x.a AS a FROM x LIMIT 5) sub", False, None),
    ("distinct-in-subquery-blocks",
     "SELECT a FROM (SELECT DISTINCT x.a AS a FROM x) sub", False, None),

    # --- Non-INNER joins: the guard only fires when the inner SELECT ALSO has its own
    #     WHERE clause (py:279-283/284-288) -- a LEFT/RIGHT/FULL join to a WHERE-less
    #     derived table still merges fine. Each side gets both halves of the pair. ---
    ("left-join-inner-where-blocks",
     "SELECT x.id, sub.a FROM x LEFT JOIN (SELECT b.id, b.a FROM b WHERE b.a > 1) sub ON x.id = sub.id",
     False, None),
    ("left-join-no-inner-where-merges",
     "SELECT x.id, sub.a FROM x LEFT JOIN (SELECT b.id, b.a FROM b) sub ON x.id = sub.id",
     False, None),
    ("right-join-inner-where-blocks",
     "SELECT x.id, sub.a FROM x RIGHT JOIN (SELECT b.id, b.a FROM b WHERE b.a > 1) sub ON x.id = sub.id",
     False, None),
    ("full-join-via-join-position-inner-where-blocks",
     "SELECT x.id, sub.a FROM x FULL JOIN (SELECT b.id, b.a FROM b WHERE b.a > 1) sub ON x.id = sub.id",
     False, None),
    # --- The FROM-position variant of the same guard (py:284-288): the subquery
    #     itself is plain FROM, but a FULL/RIGHT join ELSEWHERE in the same outer
    #     query still blocks it -- again gated on the inner SELECT having a WHERE. ---
    ("from-with-full-join-elsewhere-blocks",
     "SELECT sub.a FROM (SELECT b.a FROM b WHERE b.a > 1) sub FULL JOIN c ON sub.a = c.a",
     False, None),
    ("from-with-full-join-elsewhere-no-where-merges",
     "SELECT sub.a FROM (SELECT b.a FROM b) sub FULL JOIN c ON sub.a = c.a",
     False, None),

    # --- A correlated subquery predicate (WHERE EXISTS) is not a derived table at all
    #     -- it never appears in `outer_scope.derived_tables`, so merge_subqueries
    #     never even considers it; the whole statement round-trips unchanged. ---
    ("correlated-exists-untouched",
     "SELECT * FROM x WHERE EXISTS (SELECT 1 FROM y WHERE y.id = x.id)", False, None),

    # --- CTEs: merged only when selected from exactly once (py:97-98, the
    #     `len(v) == 1` filter over `cte_selections`); a CTE joined to itself
    #     (two selections of the same scope) is left alone. ---
    ("cte-single-use-merges",
     "WITH cte AS (SELECT x.a FROM x) SELECT a FROM cte", False, None),
    ("cte-multi-use-blocks",
     "WITH cte AS (SELECT x.a AS a FROM x) SELECT c1.a FROM cte c1 JOIN cte c2 ON c1.a = c2.a",
     False, None),
    # --- Recursive CTEs (`_is_recursive`, py:242-256): a self-reference inside the
    #     CTE's own recursive arm is walked up from `outer.parent` looking for the
    #     CTE node itself. The "both referenced" case is actually blocked one guard
    #     earlier (2 selections of the same scope, the multi-use check above) -- the
    #     "self-reference only" case (outer query doesn't touch the CTE at all) is the
    #     one that isolates `_is_recursive` itself, since it leaves exactly one
    #     selection (the internal self-reference) for `_mergeable` to evaluate. ---
    ("recursive-cte-both-referenced-blocks",
     "WITH RECURSIVE cte AS (SELECT 1 AS n FROM x UNION ALL SELECT cte.n + 1 AS n FROM cte WHERE cte.n < 5) "
     "SELECT cte.n FROM cte", False, None),
    ("recursive-cte-self-reference-only-blocks",
     "WITH RECURSIVE cte AS (SELECT 1 AS n FROM x UNION ALL SELECT cte.n + 1 AS n FROM cte WHERE cte.n < 5) "
     "SELECT 1 AS z", False, None),

    # --- Column reference rewriting after merge, and alias preservation
    #     (`_merge_expressions`, py:399-467). ---
    ("column-rewrite-after-merge",
     "SELECT sub.a + 1 AS total FROM (SELECT x.col AS a FROM x) sub", False, None),
    ("alias-preservation-required",
     # column.name ("b") != expression.name ("a" via x.a, no output name) forces
     # `exp.alias_` to re-attach "b" so the outer projection's name doesn't change.
     "SELECT sub.b FROM (SELECT x.a + 1 AS b FROM x) sub", False, None),

    # --- Structural gates ahead of any projection-level analysis (py:270-292). ---
    ("outer-star-blocks", "SELECT * FROM (SELECT x.a FROM x) sub", False, None),
    ("inner-union-blocks",
     "SELECT a FROM (SELECT x.a FROM x UNION SELECT y.a FROM y) sub", False, None),
    ("inner-no-from-blocks",
     "SELECT a FROM (SELECT 1 AS a) sub CROSS JOIN y", False, None),

    # --- Adversarial finding (see module docstring above): `_outer_select_joins_on_
    #     inner_select_join`'s own illustrative doctest comment is DEAD CODE given
    #     guard ordering -- both its "can merge" and "can't merge" examples are
    #     already blocked by the earlier, unconditional
    #     `isinstance(from_or_join, exp.Join) and inner_select.args.get("joins")`
    #     guard. Attaching the identical subquery via a bare FROM position instead
    #     (no JOIN keyword) sidesteps that earlier guard entirely and merges,
    #     pulling the inner JOIN up into the outer query via `_merge_joins` --
    #     confirming the guard ordering, not just asserting it. ---
    ("join-position-join-in-subquery-blocks-1",
     "SELECT q.a FROM x JOIN (SELECT y.a AS a FROM y JOIN z ON y.id = z.id) AS q ON x.a = q.a",
     False, None),
    ("join-position-join-in-subquery-blocks-2",
     "SELECT q.a FROM x JOIN (SELECT z.a AS a FROM y JOIN z ON y.id = z.id) AS q ON x.a = q.a",
     False, None),
    ("from-position-join-in-subquery-merges",
     "SELECT a FROM (SELECT y.a AS a FROM y JOIN z ON y.id = z.id) AS q", False, None),

    # --- Numeric-literal projections (`_literal_group_unmergeable`/`_literal_in_
    #     order_by`, py:179-212/258-268): a bare integer alias referenced as a
    #     TOP-LEVEL GROUP BY item merges (canonicalized to its ordinal); the same
    #     alias nested inside a GROUP BY expression, or referenced from ORDER BY at
    #     all, blocks the merge instead (both are positional-context hazards). ---
    ("numeric-literal-group-ordinal-merges",
     "SELECT sub.n FROM (SELECT 1 AS n FROM x) sub GROUP BY sub.n", False, None),
    ("numeric-literal-nested-in-group-blocks",
     "SELECT sub.n FROM (SELECT 1 AS n FROM x) sub GROUP BY sub.n + 1", False, None),
    ("literal-in-order-by-blocks",
     "SELECT sub.n FROM (SELECT 1 AS n FROM x) sub ORDER BY sub.n", False, None),
]

# --- Structural-only scenarios: (name, sql, alias, dialect). See is_merged() and the
#     module docstring above for why these can't be a `.sql()` comparison today. ---
STRUCTURAL_SCENARIOS = [
    # `_window_projection_blocks_merge` (py:159-177): a window-function alias is safe
    # to merge on its own, unsafe once the outer query adds a WHERE (changes the row
    # set the window function saw) or references the window column from GROUP BY.
    ("window-merges-plain",
     "SELECT sub.rn FROM (SELECT ROW_NUMBER() OVER (ORDER BY x.a) AS rn FROM x) sub",
     "sub", None),
    ("window-blocks-outer-where",
     "SELECT sub.rn FROM (SELECT ROW_NUMBER() OVER (ORDER BY x.a) AS rn FROM x) sub WHERE sub.rn > 1",
     "sub", None),
    ("window-blocks-group-usage",
     "SELECT sub.rn FROM (SELECT ROW_NUMBER() OVER (ORDER BY x.a) AS rn FROM x) sub GROUP BY sub.rn",
     "sub", None),
    # `seq_get(inner_select.expressions, 0) instanceof exp.QueryTransform` (py:290),
    # a Hive/Spark-only construct.
    ("query-transform-blocks",
     "SELECT sub.a FROM x JOIN (SELECT TRANSFORM(a) USING 'cat' FROM y) sub ON x.id = sub.id",
     "sub", "hive"),
]


def is_merged(ast, alias):
    """True iff no `Subquery` aliased `alias` remains anywhere in the tree."""
    return not any(sq.alias_or_name == alias for sq in ast.find_all(exp.Subquery))


def run_sql(sql, leave_tables_isolated, dialect):
    try:
        ast = parse_one(sql, read=dialect)
        out = merge_subqueries(ast, leave_tables_isolated)
        return {"ok": out.sql(dialect=dialect)}
    except Exception as e:  # noqa: BLE001
        return {"error": type(e).__name__, "message": str(e)}


def run_structural(sql, alias, dialect):
    try:
        ast = parse_one(sql, read=dialect)
        out = merge_subqueries(ast)
        return {"merged": is_merged(out, alias)}
    except Exception as e:  # noqa: BLE001
        return {"error": type(e).__name__, "message": str(e)}


sql_records = [
    {"name": name, "sql": sql, "leave_tables_isolated": iso, "dialect": dialect,
     "result": run_sql(sql, iso, dialect)}
    for name, sql, iso, dialect in SQL_SCENARIOS
]
structural_records = [
    {"name": name, "sql": sql, "alias": alias, "dialect": dialect,
     "result": run_structural(sql, alias, dialect)}
    for name, sql, alias, dialect in STRUCTURAL_SCENARIOS
]

print(json.dumps({"sql_scenarios": sql_records, "structural_scenarios": structural_records}))
