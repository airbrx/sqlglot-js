#!/usr/bin/env python3
"""CPython oracle for `sqlglot/optimizer/optimize_joins.py`.

`src/optimizer/optimize_joins.js` is greenfield -- it has zero dependency on any other
unported optimizer module (verified: the only imports beyond `exp` are `errors.
OptimizeError` and `helper.tsort`, both already ported), so unlike the AST-parsing/
generation corpus this module has no existing `corpus/atoms.jsonl` coverage at all.
This is the honest differential signal instead, following the same recipe
`spike/p6/gen_schema_ref.py` established for another greenfield module: exercise the
REAL CPython function with a curated battery and dump the results, so a JS-side
mismatch is provably an `optimize_joins.js` bug and not a coincidence.

Unlike `schema.js` (whose scenarios are constructor args + method calls), this module
is a pure `Expr -> Expr` AST transform over a parsed query, and its own module
docstring already asserts on `.sql()` output rather than AST shape -- so the oracle
follows that lead directly: parse a SQL string, run `optimize_joins`, dump the
resulting `.sql()`. This is simpler than an AST-dump comparison and just as strict,
because the port's own `Generator` (already verified elsewhere, PORT_PLAN.md P4/P5)
turns any AST divergence into a visibly different SQL string.

Every scenario is hand-picked to hit one specific branch:
  - the module's own two doctests (`optimize_joins`'s docstring, `_is_reorderable`'s)
  - cross-join-to-inner-join promotion, single- and multi-hop
  - the ANTI-join skip (`dep.kind == "ANTI"` -- conjuncts are not extracted)
  - a plain (undirected) ANTI/SEMI join, which IS reorderable (no `side`) but SEMI
    still gets its conjuncts extracted since only ANTI is negation-excluded
  - `side`-bearing joins (LEFT/RIGHT/FULL/LEFT ANTI) that block reordering entirely,
    for the WHOLE select's join list, not just themselves
  - an `OR`-condition ON clause: reordering still happens, conjunct extraction does not
    (only `exp.And` is walked)
  - implicit comma joins (`FROM x, y, z ... WHERE`), which `normalize()` turns into
    explicit `CROSS JOIN`
  - `JOIN ... USING (...)` with no `ON`, which is neither promoted (no name it can
    reference) nor given a synthetic `TRUE` predicate (matches upstream: `using` is
    itself a JOIN_ATTRS member)
  - INNER/OUTER keyword removal, independent of any cross-join work
  - a subquery, so the module-level `find_all(exp.Select)` loop in `optimize_joins`
    (not just the module-level `find_all(exp.From)` in `reorder_joins`) is exercised
    more than once in a single statement

    PYTHONHASHSEED=0 python3 spike/p7/gen_optimize_joins_ref.py > spike/out/optimize_joins.json
    node spike/p7/fuzz_optimize_joins.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import parse_one  # noqa: E402
from sqlglot.optimizer.optimize_joins import optimize_joins, _is_reorderable  # noqa: E402

SCENARIOS = [
    # --- optimize_joins's own module docstring (py:16-19), mirrored exactly. ---
    ("module-docstring", "SELECT * FROM x CROSS JOIN y JOIN z ON x.a = z.a AND y.a = z.a"),

    # --- _is_reorderable's own doctest (py:127-132), mirrored as a full-pipeline
    #     scenario rather than a direct call to the private predicate (see
    #     src/optimizer/optimize_joins.js's own file header for why). Both leave the
    #     query fully unchanged when run through the *whole* module, since neither has
    #     a cross join to promote -- the interesting signal here is the SECOND one
    #     staying unreordered/untouched despite the LEFT JOIN gating reorder_joins too.
    ("is-reorderable-true", "SELECT * FROM x JOIN y ON x.id = y.id JOIN z ON y.id = z.id"),
    ("is-reorderable-false-left", "SELECT * FROM x LEFT JOIN y ON x.id = y.id JOIN z ON y.id = z.id"),

    # --- A non-`And` ON clause (bare EQ) referencing a cross join's name is NEVER
    #     promoted -- only `exp.And` roots are inspected at all (py:50); the
    #     `other_table_names(dep) < 2` guard is a DIFFERENT, later check that only
    #     applies once `on` is already known to be an And. ---
    ("single-eq-predicate-never-promoted-non-and", "SELECT * FROM x CROSS JOIN y JOIN z ON y.a = z.a"),
    ("cross-promote-two-crosses-one-join",
     "SELECT * FROM x CROSS JOIN y CROSS JOIN z JOIN w ON x.a = w.a AND y.a = w.a AND z.a = w.a"),
    ("cross-promote-chained",
     "SELECT * FROM x CROSS JOIN y JOIN z ON x.a = z.a JOIN w ON y.a = w.a AND z.a = w.a"),
    ("cross-promote-in-where-clause",
     "SELECT a.x FROM a CROSS JOIN b JOIN c ON a.id = c.id AND b.id = c.id WHERE a.x > 1"),

    # --- ANTI join: conjuncts are never extracted from it (py:44-45), but the ANTI
    #     join itself is still reorderable (no `side`) so plain topological reorder
    #     still applies. SEMI is the contrast case -- also has no `side`, but IS
    #     extracted from, unlike ANTI. ---
    ("anti-join-skips-extraction",
     "SELECT * FROM x CROSS JOIN y ANTI JOIN z ON x.a = z.a AND y.a = z.a"),
    ("semi-join-still-extracts",
     "SELECT * FROM x CROSS JOIN y SEMI JOIN z ON x.a = z.a AND y.a = z.a"),
    ("left-anti-join-blocks-whole-query",
     "SELECT * FROM x LEFT ANTI JOIN y ON x.a = y.a AND z.a = y.a CROSS JOIN z"),

    # --- `side`-bearing joins block BOTH extraction and reordering for the entire
    #     select's join list, not just the side-bearing join itself. ---
    ("full-join-blocks-whole-query", "SELECT * FROM x FULL JOIN y ON x.a = y.a CROSS JOIN z"),
    ("right-join-blocks-whole-query", "SELECT * FROM x RIGHT JOIN y ON x.a = y.a CROSS JOIN z"),
    ("outer-keyword-join-is-not-a-side",
     # OUTER (bare, no LEFT/RIGHT/FULL) is a `kind`, not a `side` -- `_is_reorderable`
     # only inspects `.side`, so this one stays reorderable AND has its OUTER keyword
     # stripped by `normalize()` in the same pass.
     "SELECT * FROM x OUTER JOIN y ON x.a = y.a CROSS JOIN z"),

    # --- Only `exp.And` conjuncts are extracted; an `OR` root is left alone, but
    #     reordering (a wholly separate mechanism) still moves the cross join. ---
    ("or-condition-not-extracted-but-still-reordered",
     "SELECT * FROM x JOIN y ON x.a = y.a OR x.b = y.b CROSS JOIN z"),

    # --- Implicit comma joins: normalize() turns bare FROM-list entries into explicit
    #     CROSS JOIN, entirely independent of any extraction/reordering (no ON clause
    #     exists yet for extraction to work with). ---
    ("comma-joins-become-explicit-cross",
     "SELECT * FROM x, y, z WHERE x.a = y.a AND y.b = z.b"),
    ("comma-joins-no-predicates", "SELECT * FROM x, y, z"),

    # --- JOIN ... USING: no `on`, so other_table_names() sees it as reference-less
    #     (same as a bare cross join) for the extraction loop, but `using` is itself
    #     a JOIN_ATTRS member so normalize() does NOT force it to CROSS or backfill a
    #     synthetic TRUE predicate. ---
    ("using-join-not-promoted-not-normalized-to-cross",
     "SELECT * FROM x JOIN y USING (a) CROSS JOIN z"),

    # --- INNER/OUTER keyword removal (normalize, py:104-105), independent of any
    #     cross-join work -- no cross join present in either case. ---
    ("inner-keyword-stripped", "SELECT * FROM x INNER JOIN y ON x.a = y.a"),
    ("outer-keyword-stripped-no-cross", "SELECT * FROM x OUTER JOIN y ON x.a = y.a"),

    # --- A cross join whose name matches nothing (no join's ON references it) stays
    #     a cross join; unrelated joins in the same query are untouched. ---
    ("unreferenced-cross-join-untouched", "SELECT * FROM x CROSS JOIN y JOIN z ON y.a = z.a"),
    ("all-cross-no-references", "SELECT * FROM x CROSS JOIN y CROSS JOIN z"),

    # --- optimize_joins itself walks `find_all(exp.Select)`, so a subquery's inner
    #     SELECT is optimized independently of the outer one, and reorder_joins's own
    #     `find_all(exp.From)` walk sees both FROM clauses in the same statement. ---
    ("subquery-inner-select-optimized-independently",
     "SELECT * FROM (SELECT * FROM p CROSS JOIN q JOIN r ON p.a = r.a AND q.a = r.a) sub"),
    ("two-selects-one-reorderable-one-not",
     "SELECT * FROM (SELECT * FROM p CROSS JOIN q JOIN r ON p.a = r.a AND q.a = r.a) sub "
     "LEFT JOIN (SELECT * FROM m LEFT JOIN n ON m.a = n.a JOIN o ON n.a = o.a) sub2 "
     "ON sub.a = sub2.a"),

    # --- A cross join promoted into TWO different real joins (both reference it),
    #     each extraction independently replacing its own conjunct with TRUE. ---
    ("cross-join-referenced-by-two-real-joins",
     "SELECT * FROM x CROSS JOIN y JOIN z ON x.a = z.a AND y.a = z.a "
     "JOIN w ON x.b = w.b AND y.b = w.b"),

    # --- A 3-conjunct AND where only the MIDDLE one matches the cross join's name:
    #     per-conjunct selectivity -- only the matching conjunct is replaced with TRUE
    #     and extracted, the other two AND operands (one referencing an unrelated
    #     table, one referencing only the join's own table) are left exactly as
    #     written in place. ---
    ("mixed-match-and-non-match-conjuncts",
     "SELECT * FROM x CROSS JOIN y JOIN z ON x.a = z.a AND y.a = z.a AND z.b > 5"),
    ("single-table-and-predicate-skips-extraction",
     # `other_table_names(dep)` excludes the join's OWN alias, so an AND whose every
     # conjunct only ever references the join's own table has size 0 (< 2), and the
     # guard (py:51-52) skips extraction entirely even though `on` is an And.
     "SELECT * FROM x CROSS JOIN y JOIN z ON z.a = z.b AND z.c = z.d"),
]


def run_one(sql):
    try:
        ast = parse_one(sql)
        out = optimize_joins(ast)
        return {"ok": out.sql()}
    except Exception as e:  # noqa: BLE001
        return {"error": type(e).__name__, "message": str(e)}


records = [{"name": name, "sql": sql, "result": run_one(sql)} for name, sql in SCENARIOS]

# The `_is_reorderable` doctest itself, called directly, recorded alongside (not as a
# substitute for the full-pipeline scenarios above -- both are asserted).
_direct = []
for label, sql in [
    ("true", "SELECT * FROM x JOIN y ON x.id = y.id JOIN z ON y.id = z.id"),
    ("false", "SELECT * FROM x LEFT JOIN y ON x.id = y.id JOIN z ON y.id = z.id"),
]:
    ast = parse_one(sql)
    joins = ast.find(__import__("sqlglot").exp.Select).args.get("joins", [])
    _direct.append({"label": label, "sql": sql, "result": _is_reorderable(joins)})

print(json.dumps({"scenarios": records, "is_reorderable_direct": _direct}))
