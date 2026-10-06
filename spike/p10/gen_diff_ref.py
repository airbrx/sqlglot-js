#!/usr/bin/env python3
"""CPython oracle for `sqlglot/diff.py` (AIR-2122).

`src/diff.js` is greenfield -- it depends only on already-ported `exp.*` tree
primitives (`walk`/`bfs`/`copy`/`hash`/`equals`, `iter_expressions`), so unlike the
AST-parsing/generation corpus this module has no existing `corpus/atoms.jsonl`
coverage at all. This follows the same recipe `spike/p6/gen_schema_ref.py` and
`spike/p7/gen_optimize_joins_ref.py` established for other greenfield modules.

Every scenario below reproduces one `diff_delta_only(...)`/`diff(...)` CALL from
`tests/test_diff.py`, in the same order as that file's own test methods. This oracle
compares the ACTUAL edit script `diff()` produces against CPython, not the literal
hand-written `expected` list each upstream test asserts against -- those are a
convenience for the test author (`Insert(expression=parse_one("c"))` builds a fresh,
separately-parsed node that is merely STRUCTURALLY equal to the one diff() actually
returned) and this oracle doesn't need to duplicate them to get the same signal.

THE COMPARISON CONTRACT, and why it isn't list equality:
  - `tests/test_diff.py`'s own `_validate_delta_only` asserts
    `set(actual_delta) == set(expected_delta)` -- never list equality. The edit
    script's internal `Remove`/`Insert`/`Keep` loops iterate Python `set`s/`dict`s
    built from `id()` (object-identity) keys, whose iteration order depends on
    CPython memory addresses -- not stable across runs even with `PYTHONHASHSEED`
    pinned (that only randomizes str/bytes/datetime hashing; `hash(int)` for a
    memory-address-sized id is the identity function). So list ORDER is not part of
    the contract, and this oracle canonicalizes + dedupes to a SET before comparing.
  - The edit list can also contain exact DUPLICATE entries by construction: a leaf
    pair that is structurally `identical_nodes` but whose matched parent differs from
    its node's real parent emits a `Move` directly in `_generate_edit_script`'s main
    loop, and the very same `Move` can ALSO be emitted by an ancestor's own
    `_generate_move_edits` LCS pass (verified against `test_node_position_changed`'s
    "SELECT aaaa OR bbbb OR cccc" case: the real edit list has 4 Move entries, 2 of
    them exact duplicates of the other 2 -- collapsing to the 2-element set upstream's
    own test asserts). A set-based comparison absorbs this by construction; a
    straightforward list-length check would not.

Each edit is canonicalized as a 3-tuple `(type, a, b)`:
  - Insert/Remove: `(type, expression.sql(), None)`
  - Move/Update/Keep: `(type, source.sql(), target.sql())`
`.sql()` (not an AST dump) is the comparison key for the same reason
`gen_optimize_joins_ref.py` uses it: this port's own parser+generator are verified
elsewhere (PORT_PLAN.md P3-P5), so any real AST-shape divergence here would already
show up as different SQL text -- simpler than a second AST-dump comparator and just
as strict.

NAMED EXCLUSION: two upstream assertions (`test_window_functions`'s third case,
`test_dialect_aware_diff`) parse under `dialect="oracle"`. This port has no real
Oracle `Parser`/`Dialect` registered at all (`src/dialects/` has no `oracle.js`), so
`Dialect.get_or_raise("oracle")` throws "Unknown dialect" before diffing even starts
-- a pre-existing, unrelated gap, not a `diff.js` bug. Both are recorded with
`"skip": "oracle dialect not ported"` instead of a `sql`/expected result, and the
fuzzer excludes them by that literal marker, not by row id. A substitute scenario
using a real, ported dialect (postgres) exercises the same `dialect=` plumbing
in `ChangeDistiller.__init__` instead.

    PYTHONHASHSEED=0 python3 spike/p10/gen_diff_ref.py > spike/out/diff.json
    node spike/p10/fuzz_diff.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-complete-pin")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import exp, parse_one  # noqa: E402
from sqlglot.diff import Insert, Keep, Move, Remove, Update, diff  # noqa: E402


def canon(e):
    if isinstance(e, Insert):
        return ["Insert", e.expression.sql(), None]
    if isinstance(e, Remove):
        return ["Remove", e.expression.sql(), None]
    if isinstance(e, Move):
        return ["Move", e.source.sql(), e.target.sql()]
    if isinstance(e, Update):
        return ["Update", e.source.sql(), e.target.sql()]
    if isinstance(e, Keep):
        return ["Keep", e.source.sql(), e.target.sql()]
    raise TypeError(type(e))


def run(source, target, matchings=None, delta_only=True, **kwargs):
    try:
        edits = diff(source, target, matchings=matchings, delta_only=delta_only, **kwargs)
        canonical = sorted({tuple(canon(e)) for e in edits})
        return {"ok": [list(c) for c in canonical]}
    except Exception as e:  # noqa: BLE001
        return {"error": type(e).__name__, "message": str(e)}


records = []


def add(name, source_sql, target_sql, **kwargs):
    records.append(
        {
            "name": name,
            "source_sql": source_sql,
            "target_sql": target_sql,
            "result": run(parse_one(source_sql), parse_one(target_sql), **kwargs),
        }
    )


# --- test_simple ---
add("simple-add-sub", "SELECT a + b", "SELECT a - b")
add("simple-remove-column", "SELECT a, b, c", "SELECT a, c")
add("simple-insert-column", "SELECT a, b", "SELECT a, b, c")
add("simple-update-table", "SELECT a FROM table_one", "SELECT a FROM table_two")

# --- test_lambda ---
add("lambda-rename", "SELECT a, b, c, x(a -> a)", "SELECT a, b, c, x(b -> b)")

# --- test_udf ---
add("udf-rename", 'SELECT a, b, "my.udf1"()', 'SELECT a, b, "my.udf2"()')
add("udf-arg-swap", 'SELECT a, b, "my.udf"(x, y, z)', 'SELECT a, b, "my.udf"(x, y, w)')

# --- test_node_position_changed ---
add("position-select-list", "SELECT a, b, c", "SELECT c, a, b")
add("position-add-operands", "SELECT a + b", "SELECT b + a")
add("position-and-operands", "SELECT aaaa AND bbbb", "SELECT bbbb AND aaaa")
add("position-or-chain", "SELECT aaaa OR bbbb OR cccc", "SELECT cccc OR bbbb OR aaaa")
add(
    "position-concat-move",
    "SELECT a, b FROM t WHERE CONCAT('a', 'b') = 'ab'",
    "SELECT a FROM t WHERE CONCAT('a', 'b', b) = 'ab'",
)
add(
    "position-alias-remove-and-move",
    "SELECT a as a, b as b FROM t WHERE CONCAT('a', 'b') = 'ab'",
    "SELECT a as a FROM t WHERE CONCAT('a', 'b', b) = 'ab'",
)

# --- test_cte ---
add(
    "cte",
    """
        WITH
            cte1 AS (SELECT a, b, LOWER(c) AS c FROM table_one WHERE d = 'filter'),
            cte2 AS (SELECT d, e, f FROM table_two)
        SELECT a, b, d, e FROM cte1 JOIN cte2 ON f = c
    """,
    """
        WITH
            cte1 AS (SELECT a, b, c FROM table_one WHERE d = 'different_filter'),
            cte2 AS (SELECT d, e, f FROM table_two)
        SELECT a, b, d, e FROM cte1 JOIN cte2 ON f = c
    """,
)

# --- test_join ---
add(
    "join-side-change",
    "SELECT a, b FROM t1 LEFT JOIN t2 ON t1.key = t2.key",
    "SELECT a, b FROM t1 RIGHT JOIN t2 ON t1.key = t2.key",
)
add(
    "join-case-insensitive-noop",
    "SELECT a.x FROM a INNER JOIN b ON a.x = b.y LEFT JOIN c ON a.p = c.q",
    "SELECT a.x FROM a inner JOIN b ON a.x = b.y left JOIN c ON a.p = c.q",
)

# --- test_window_functions ---
_wf_src = parse_one("SELECT ROW_NUMBER() OVER (PARTITION BY a ORDER BY b)")
records.append(
    {
        "name": "window-self-noop",
        "source_sql": "SELECT ROW_NUMBER() OVER (PARTITION BY a ORDER BY b)",
        "target_sql": "SELECT ROW_NUMBER() OVER (PARTITION BY a ORDER BY b)",
        "result": run(_wf_src, _wf_src.copy()),
    }
)
add(
    "window-func-change",
    "SELECT ROW_NUMBER() OVER (PARTITION BY a ORDER BY b)",
    "SELECT RANK() OVER (PARTITION BY a ORDER BY b)",
)
records.append(
    {
        "name": "window-oracle-keep",
        "skip": "oracle dialect not ported",
    }
)

# --- test_pre_matchings (object-identity matchings against ONE shared tree pair) ---
_pm_src = parse_one("SELECT 1")
_pm_tgt = parse_one("SELECT 1, 2, 3, 4")
records.append(
    {
        "name": "pre-matchings-none",
        "source_sql": "SELECT 1",
        "target_sql": "SELECT 1, 2, 3, 4",
        "result": run(_pm_src, _pm_tgt, matchings=None),
    }
)
records.append(
    {
        "name": "pre-matchings-one",
        "source_sql": "SELECT 1",
        "target_sql": "SELECT 1, 2, 3, 4",
        "result": run(_pm_src, _pm_tgt, matchings=[(_pm_src, _pm_tgt)]),
    }
)
records.append(
    {
        "name": "pre-matchings-duplicate-pair",
        "source_sql": "SELECT 1",
        "target_sql": "SELECT 1, 2, 3, 4",
        "result": run(_pm_src, _pm_tgt, matchings=[(_pm_src, _pm_tgt), (_pm_src, _pm_tgt)]),
    }
)
# py:259 `expr_tgt.selects[0].replace(expr_src.selects[0])` -- gives source and target
# a SHARED node, forcing diff()'s `copy` branch (and its node_mapping remap of
# `matchings` onto the copies) to actually run.
_pm_tgt.selects[0].replace(_pm_src.selects[0])
records.append(
    {
        "name": "pre-matchings-after-shared-node",
        "source_sql": "SELECT 1",
        "target_sql": "SELECT 1, 2, 3, 4 (post-replace, shares node with source)",
        "result": run(_pm_src, _pm_tgt, matchings=[(_pm_src, _pm_tgt)]),
    }
)

# --- test_identifier ---
add("identifier-insert-qualified-column", "SELECT a FROM tbl", "SELECT a, tbl.b from tbl")
add("identifier-alias-update", "SELECT 1 AS c1, 2 AS c2", "SELECT 2 AS c1, 3 AS c2")

# --- test_dialect_aware_diff: EXCLUDED (oracle dialect not ported). Substitute below
# exercises the same `dialect=` plumbing against a real, ported dialect instead. ---
records.append({"name": "dialect-aware-oracle-noop", "skip": "oracle dialect not ported"})
# `FOR UPDATE` (upstream's own oracle-dialect scenario) is deliberately NOT reused here:
# rendering it hits `lock_sql`, a separate pre-existing/unrelated base-Generator stub
# (`src/generator.js`'s own `NotPorted`), which would just trade one named exclusion for
# another instead of giving clean evidence that `dialect=` plumbing works end to end.
# Postgres's `DISTINCT ON (...)` is real on both sides and dialect-specific enough to
# prove the same point.
_pg_src = parse_one("SELECT DISTINCT ON (a) a, b FROM t", dialect="postgres")
records.append(
    {
        "name": "dialect-aware-postgres-noop-substitute",
        "source_sql": "SELECT DISTINCT ON (a) a, b FROM t",
        "target_sql": "SELECT DISTINCT ON (a) a, b FROM t",
        "result": run(_pg_src, _pg_src.copy(), dialect="postgres"),
    }
)

# --- test_non_expression_leaf_delta ---
add("non-expr-leaf-union-all", "SELECT a UNION SELECT b", "SELECT a UNION ALL SELECT b")
add("non-expr-leaf-order-direction", "SELECT a FROM t ORDER BY b ASC", "SELECT a FROM t ORDER BY b DESC")
add(
    "non-expr-leaf-order-direction-and-move",
    "SELECT a, b FROM t ORDER BY c ASC",
    "SELECT b, a FROM t ORDER BY c DESC",
)

# --- test_none_args_are_not_treated_as_leaves (hand-built, not parsed) ---
_none_src = exp.Column(
    this=exp.to_identifier("b"), table=exp.to_identifier("a"), db=None, catalog=None
)
_none_tgt = exp.Column(this=exp.to_identifier("b"), table=exp.to_identifier("a"))
records.append(
    {
        "name": "none-args-not-leaves",
        "source_sql": _none_src.sql(),
        "target_sql": _none_tgt.sql(),
        "note": "hand-built exp.Column, db/catalog explicitly None on source only",
        "result": run(_none_src, _none_tgt),
    }
)

# --- test_comments_do_not_affect_diff ---
add("comments-ignored", "select a from tbl", "select a from tbl -- this is comment")

print(json.dumps({"scenarios": records}, indent=None))
