#!/usr/bin/env python3
"""CPython oracle for `sqlglot/optimizer/scope.py`'s `traverse_scope`/`build_scope`
(AIR-2094) and the `Scope` class CORE surface they build (AIR-2093).

Both this oracle and `spike/p7/fuzz_scope.mjs` now call the REAL tree builder on their
own side -- `sqlglot.optimizer.scope.traverse_scope` here, `src/optimizer/scope.js`'s
`traverseScope` there -- rather than hand-wiring `Scope` trees through the class's own
constructor/`branch()`. The scenario corpus below is sized for a recursive builder, not
a single fixed scope: nested CTEs referencing each other, a derived table containing its
own CTE, a 3-way UNION, a WHERE-clause correlated subquery two levels deep, a recursive
CTE, and both flavors of UDTF join (UNNEST and a LATERAL subquery).

Nodes (columns, tables, CTEs, ...) are compared by their RENDERED SQL text (`.sql()` /
the port's `toS()`), not a full lossless AST dump. This is the same choice
`spike/p3/gen_walk_in_scope_ref.py` already made for `find_in_scope`'s oracle (see
`fuzz_walk_in_scope.mjs`'s `toS(hit)`), and is safe here for the same reason: `.sql()` is
independently byte-exact-verified through this port's P4/P5 work, and no two distinct
nodes across any of these scenarios render identically.

    python3 spike/p7/gen_scope_ref.py > spike/out/scope.json
    node spike/p7/fuzz_scope.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)
os.chdir(REF)

import sqlglot  # noqa: E402
from sqlglot import exp  # noqa: E402
from sqlglot.optimizer.scope import build_scope, traverse_scope  # noqa: E402


def sqls(nodes):
    """A node list, rendered to SQL text -- order-preserving."""
    return [n.sql() for n in nodes]


def label_of(source):
    """A `Scope.sources`/`ref_count()` VALUE (a Table `Expr` or a `Scope`) rendered to a
    single comparable string -- `source.sql()` for a Table, `source.expression.sql()`
    for a Scope."""
    return source.sql() if isinstance(source, exp.Expr) else source.expression.sql()


def dump_scope(scope, source_probes=()):
    """Every CORE-surface member `src/optimizer/scope.js`'s `Scope` class ports, in the
    same order as that file's own property declarations."""
    return {
        "scope_type": scope.scope_type.name,
        "expression_sql": scope.expression.sql(),
        "outer_columns": list(scope.outer_columns),
        "can_be_correlated": scope.can_be_correlated,
        "sources_keys": sorted(scope.sources.keys()),
        "tables": sqls(scope.tables),
        "ctes": sqls(scope.ctes),
        "derived_tables": sqls(scope.derived_tables),
        "udtfs": sqls(scope.udtfs),
        "subqueries": sqls(scope.subqueries),
        "scans_all_subscope_columns": scope.scans_all_subscope_columns,
        "stars": sqls(scope.stars),
        # `column_index` is filled in by `_fix_column_index` right after this literal is
        # built -- it needs `scope.column_index` (a `set`, unordered), not anything
        # already computed above.
        "column_index": [],
        "columns": sqls(scope.columns),
        "table_columns": sqls(scope.table_columns),
        "selected_sources": {k: [v[0].sql(), label_of(v[1])] for k, v in scope.selected_sources.items()},
        "references": [[name, node.sql()] for name, node in scope.references],
        "external_columns": sqls(scope.external_columns),
        "local_columns": sqls(scope.local_columns),
        "unqualified_columns": sqls(scope.unqualified_columns),
        "join_hints": sqls(scope.join_hints),
        "pivots": sqls(scope.pivots),
        "semi_or_anti_join_tables": sorted(scope.semi_or_anti_join_tables),
        "source_columns": {name: sqls(scope.source_columns(name)) for name in source_probes},
        "is_subquery": scope.is_subquery,
        "is_derived_table": scope.is_derived_table,
        "is_union": scope.is_union,
        "is_cte": scope.is_cte,
        "is_root": scope.is_root,
        "is_udtf": scope.is_udtf,
        "is_correlated_subquery": scope.is_correlated_subquery,
        "repr": repr(scope),
    }


def _fix_column_index(d, scope):
    """`column_index` is a `set[int]` of `id(Column)` in Python, not the columns
    themselves -- reverse it back to nodes by walking the scope's own tree for exact
    `type(node) is exp.Column` instances (`_collect`'s own criterion for membership),
    then render as a SORTED list of SQL text, matching every other node-list field.
    `set` iteration order is unspecified in Python and must never be asserted directly.
    """
    id_to_column = {id(n): n for n in scope.walk() if type(n) is exp.Column}
    d["column_index"] = sorted(id_to_column[i].sql() for i in scope.column_index)
    return d


def dump_tree(root):
    """`root.traverse()` (post-order) and `root.ref_count()`, both whole-tree methods
    exercised once per scenario against the ROOT scope `build_scope` returns."""
    traverse_order = [s.expression.sql() for s in root.traverse()]
    id_to_label = {}
    for s in root.traverse():
        for _, source in s.sources.items():
            id_to_label[id(source)] = label_of(source)
    ref_count = {id_to_label.get(k, "<unknown>"): v for k, v in root.ref_count().items()}
    return {"traverse_order": traverse_order, "ref_count": ref_count}


scenarios = {}


def add_scenario(name, sql, source_probes_by_index=None):
    """Runs the REAL `traverse_scope`/`build_scope` and dumps every scope it produces,
    in traversal order (index-keyed, since the builder -- not a hand-labeled dict --
    now owns scope identity)."""
    source_probes_by_index = source_probes_by_index or {}
    expr = sqlglot.parse_one(sql)
    scopes = traverse_scope(expr)

    dumped = []
    for i, scope in enumerate(scopes):
        d = dump_scope(scope, source_probes_by_index.get(i, ()))
        _fix_column_index(d, scope)
        dumped.append(d)

    root = build_scope(expr)
    scenarios[name] = {
        "sql": sql,
        "scope_count": len(scopes),
        "scopes": dumped,
        "tree": dump_tree(root) if root is not None else None,
    }


# ---------------------------------------------------------------------------------
# 1. Plain SELECT -- one Scope, one Table source.
# ---------------------------------------------------------------------------------
add_scenario("plain_select", "SELECT a, b FROM x WHERE a > 1", {0: ["x"]})

# ---------------------------------------------------------------------------------
# 2. Subquery in FROM -- a DERIVED_TABLE child scope.
# ---------------------------------------------------------------------------------
add_scenario(
    "subquery_in_from",
    "SELECT a FROM (SELECT a, c FROM x WHERE c > 0) AS y",
    {0: ["x"], 1: ["y"]},
)

# ---------------------------------------------------------------------------------
# 3. CTE -- a CTE-typed child scope, referenced by name from the root's own FROM.
# ---------------------------------------------------------------------------------
add_scenario("cte", "WITH y AS (SELECT a FROM x) SELECT a FROM y", {0: ["x"], 1: ["y"]})

# ---------------------------------------------------------------------------------
# 4. UNION -- two UNION-typed sibling scopes, both children of the SetOperation root.
# ---------------------------------------------------------------------------------
add_scenario("union", "SELECT a FROM x UNION ALL SELECT a FROM y", {0: ["x"], 1: ["y"]})

# ---------------------------------------------------------------------------------
# 5. Correlated subquery in WHERE -- a SUBQUERY-typed child scope whose WHERE clause
#    references the parent's own table.
# ---------------------------------------------------------------------------------
add_scenario(
    "correlated_subquery",
    "SELECT a FROM x WHERE a IN (SELECT b FROM y WHERE y.b = x.a)",
    {0: ["y", "x"], 1: ["x"]},
)

# ---------------------------------------------------------------------------------
# 6. Nested CTEs referencing each other -- `b` reads from `a`, both CTE-typed.
# ---------------------------------------------------------------------------------
add_scenario(
    "nested_ctes",
    "WITH a AS (SELECT 1 AS x), b AS (SELECT x FROM a) SELECT x FROM b",
)

# ---------------------------------------------------------------------------------
# 7. A derived table containing its own CTE -- CTE nested inside a DERIVED_TABLE.
# ---------------------------------------------------------------------------------
add_scenario(
    "derived_table_with_own_cte",
    "SELECT a FROM (WITH c AS (SELECT a FROM x) SELECT a FROM c) AS y",
)

# ---------------------------------------------------------------------------------
# 8. A 3-way UNION -- exercises `_traverse_union`'s stack-based left-nesting walk.
# ---------------------------------------------------------------------------------
add_scenario(
    "three_way_union",
    "SELECT a FROM x UNION SELECT a FROM y UNION SELECT a FROM z",
)

# ---------------------------------------------------------------------------------
# 9. A WHERE-clause correlated subquery two levels deep.
# ---------------------------------------------------------------------------------
add_scenario(
    "correlated_subquery_two_levels",
    "SELECT a FROM x WHERE a IN (SELECT b FROM y WHERE b IN (SELECT c FROM z WHERE z.c = x.a))",
)

# ---------------------------------------------------------------------------------
# 10. A recursive CTE -- exercises `_traverse_ctes`'s `with_.recursive` branch.
# ---------------------------------------------------------------------------------
add_scenario(
    "recursive_cte",
    "WITH RECURSIVE cte AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM cte WHERE n < 5) SELECT n FROM cte",
)

# ---------------------------------------------------------------------------------
# 11. LATERAL/UDTF join -- a LATERAL subquery (recurses into its own SUBQUERY child)
#     and a plain UNNEST table function (no child scope of its own).
# ---------------------------------------------------------------------------------
add_scenario(
    "lateral_subquery_join",
    "SELECT a, b FROM x CROSS JOIN LATERAL (SELECT y.b FROM y WHERE y.a = x.a) AS t",
)
add_scenario(
    "unnest_udtf_join",
    "SELECT a, b FROM x CROSS JOIN UNNEST(x.arr) AS t(b)",
)


print(json.dumps(scenarios, indent=None))
