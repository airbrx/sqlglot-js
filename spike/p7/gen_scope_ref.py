#!/usr/bin/env python3
"""CPython oracle for `sqlglot/optimizer/scope.py`'s `Scope` class CORE surface (AIR-2093).

`traverse_scope`/`build_scope` (the module-level functions that WALK an expression tree
and BUILD a `Scope` tree, wiring `sources`/`parent`/every `*_scopes` list) are deferred to
AIR-2094 and are not exercised here or ported in `src/optimizer/scope.js` -- see that
file's own header. Instead, both this oracle and `spike/p7/fuzz_scope.mjs` hand-wire five
small `Scope` trees directly through the class's own public constructor and `branch()`
method: a minimal, symmetric stand-in for what `_traverse_select`/`_traverse_ctes`/
`_traverse_tables`/`_traverse_union`/`_traverse_subqueries` would build for exactly these
five fixed inputs (verified against those functions' real bodies while writing this file,
so the wiring is faithful even though the general-purpose builder isn't ported). Wiring
each scenario IDENTICALLY, by hand, on both the Python and JS sides isolates defects in
the `Scope` class ITSELF -- the actual target of this port -- rather than in a tree
builder neither side has yet.

Nodes (columns, tables, CTEs, ...) are compared by their RENDERED SQL text (`.sql()` /
the port's `toS()`), not a full lossless AST dump. This is the same choice
`spike/p3/gen_walk_in_scope_ref.py` already made for `find_in_scope`'s oracle (see
`fuzz_walk_in_scope.mjs`'s `toS(hit)`), and is safe here for the same reason: `.sql()` is
independently byte-exact-verified through this port's P4/P5 work, and no two distinct
nodes across any of these five scenarios render identically.

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
from sqlglot.optimizer.scope import Scope, ScopeType  # noqa: E402


def sqls(nodes):
    """A node list, rendered to SQL text -- order-preserving."""
    return [n.sql() for n in nodes]


def label_of(source):
    """A `Scope.sources`/`ref_count()` VALUE (a Table `Expr` or a `Scope`) rendered to a
    single comparable string -- `source.sql()` for a Table, `source.expression.sql()`
    for a Scope. Unique across every scenario below, so it doubles as an identity key."""
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


def dump_tree(root, per_scope_probes):
    """`root.traverse()` (post-order) and `root.ref_count()`, both whole-tree methods
    exercised once per scenario against the tree just built."""
    traverse_order = [s.expression.sql() for s in root.traverse()]
    id_to_label = {}
    for s in root.traverse():
        for _, source in s.sources.items():
            id_to_label[id(source)] = label_of(source)
    ref_count = {id_to_label.get(k, "<unknown>"): v for k, v in root.ref_count().items()}
    return {"traverse_order": traverse_order, "ref_count": ref_count}


scenarios = {}


def add_scenario(name, sql, build_fn):
    expr = sqlglot.parse_one(sql)
    scopes, root, per_scope_probes = build_fn(expr)
    dumped = {}
    for label, scope in scopes.items():
        probes = per_scope_probes.get(label, ())
        d = dump_scope(scope, probes)
        _fix_column_index(d, scope)
        dumped[label] = d
    scenarios[name] = {
        "sql": sql,
        "scopes": dumped,
        "tree": dump_tree(root, per_scope_probes),
    }


# ---------------------------------------------------------------------------------
# 1. Plain SELECT -- one Scope, one Table source.
# ---------------------------------------------------------------------------------
def build_plain(expr):
    root = Scope(expr, scope_type=ScopeType.ROOT)
    table_x = expr.args["from_"].this
    root.sources["x"] = table_x
    return {"root": root}, root, {"root": ["x"]}


add_scenario("plain_select", "SELECT a, b FROM x WHERE a > 1", build_plain)


# ---------------------------------------------------------------------------------
# 2. Subquery in FROM -- a DERIVED_TABLE child scope, branched via `root.branch()`.
# ---------------------------------------------------------------------------------
def build_subquery_from(expr):
    root = Scope(expr, scope_type=ScopeType.ROOT)
    subquery_node = expr.args["from_"].this  # exp.Subquery, aliased y
    inner_scope = root.branch(
        subquery_node,
        scope_type=ScopeType.DERIVED_TABLE,
        outer_columns=subquery_node.alias_column_names,
    )
    inner_select = inner_scope.expression  # branch() already unnested the Subquery
    inner_table = inner_select.args["from_"].this
    inner_scope.sources["x"] = inner_table

    root.table_scopes.append(inner_scope)
    root.derived_table_scopes.append(inner_scope)
    root.sources["y"] = inner_scope

    return {"root": root, "inner": inner_scope}, root, {"root": ["y"], "inner": ["x"]}


add_scenario(
    "subquery_in_from",
    "SELECT a FROM (SELECT a, c FROM x WHERE c > 0) AS y",
    build_subquery_from,
)


# ---------------------------------------------------------------------------------
# 3. CTE -- a CTE-typed child scope, referenced by name from the root's own FROM.
# ---------------------------------------------------------------------------------
def build_cte(expr):
    root = Scope(expr, scope_type=ScopeType.ROOT)
    cte_node = expr.args["with_"].expressions[0]
    cte_scope = root.branch(
        cte_node.this,
        scope_type=ScopeType.CTE,
        outer_columns=cte_node.alias_column_names,
    )
    cte_table = cte_scope.expression.args["from_"].this
    cte_scope.sources["x"] = cte_table

    cte_name = cte_node.alias
    root.cte_scopes.append(cte_scope)
    root.sources[cte_name] = cte_scope
    root.cte_sources[cte_name] = cte_scope

    return {"root": root, "cte": cte_scope}, root, {"root": ["y"], "cte": ["x"]}


add_scenario("cte", "WITH y AS (SELECT a FROM x) SELECT a FROM y", build_cte)


# ---------------------------------------------------------------------------------
# 4. UNION -- two UNION-typed sibling scopes, both children of the SetOperation root.
# ---------------------------------------------------------------------------------
def build_union(expr):
    root = Scope(expr, scope_type=ScopeType.ROOT)
    left_expr = expr.this
    right_expr = expr.args["expression"]

    left_scope = root.branch(left_expr, outer_columns=root.outer_columns, scope_type=ScopeType.UNION)
    right_scope = root.branch(right_expr, outer_columns=root.outer_columns, scope_type=ScopeType.UNION)

    left_scope.sources["x"] = left_scope.expression.args["from_"].this
    right_scope.sources["y"] = right_scope.expression.args["from_"].this

    root.union_scopes = [left_scope, right_scope]

    return (
        {"root": root, "left": left_scope, "right": right_scope},
        root,
        {"left": ["x"], "right": ["y"]},
    )


add_scenario("union", "SELECT a FROM x UNION ALL SELECT a FROM y", build_union)


# ---------------------------------------------------------------------------------
# 5. Correlated subquery in WHERE -- a SUBQUERY-typed child scope whose WHERE clause
#    references the parent's own table, exercising `external_columns`/
#    `is_correlated_subquery`.
# ---------------------------------------------------------------------------------
def build_correlated_subquery(expr):
    root = Scope(expr, scope_type=ScopeType.ROOT)
    table_x = expr.args["from_"].this
    root.sources["x"] = table_x

    subquery_select = None
    for node in expr.args["where"].walk():
        if isinstance(node, exp.Select):
            subquery_select = node
            break
    assert subquery_select is not None

    subquery_scope = root.branch(subquery_select, scope_type=ScopeType.SUBQUERY)
    subquery_scope.sources["y"] = subquery_scope.expression.args["from_"].this
    root.subquery_scopes.append(subquery_scope)

    return (
        {"root": root, "subquery": subquery_scope},
        root,
        {"root": ["x"], "subquery": ["y", "x"]},
    )


add_scenario(
    "correlated_subquery",
    "SELECT a FROM x WHERE a IN (SELECT b FROM y WHERE y.b = x.a)",
    build_correlated_subquery,
)


print(json.dumps(scenarios, indent=None))
