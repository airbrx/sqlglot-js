// py: sqlglot/optimizer/merge_subqueries.py @ 91119bc — WHOLE FILE (557 LOC).
//
// THE HIGHEST correctness-risk module ported in this batch (AIR-2116, epic AIR-2089):
// it merges a derived-table/CTE subquery directly into its parent SELECT wherever
// upstream's own `_mergeable` guards say it is semantically safe, eliminating an
// unnecessary nesting level. Getting a guard even slightly wrong changes result
// cardinality (merging past a DISTINCT/GROUP BY/LIMIT subquery, or past a non-INNER
// join in the wrong direction) rather than merely producing worse SQL, so every guard
// in `_mergeable` is transliterated literally — no guard is "simplified" or "obviously
// equivalent" rewritten — and each is exercised by both a should-merge and a
// should-NOT-merge oracle scenario (see `spike/p7/gen_merge_subqueries_ref.py`'s own
// header for the adversarial-pairing list).
//
// Greenfield module (no existing consumer in this port), same shape as
// `optimize_joins.js` (R45) and `schema.js` (R41): verified by its own new
// differential oracle rather than by `corpus/atoms.jsonl`, which has no rows for it.
// Imports the real `Scope`/`traverseScope` from `optimizer/scope.js` (R44/R46).
//
// The upstream `_typing.E`/`FromOrJoin` imports are type-only annotations with no JS
// analogue and are dropped, matching every other ported file's treatment of
// `TypeVar`/`Iterable`/`Union` type-only imports.
//
// Module-level function names (`merge_subqueries`, `merge_ctes`,
// `merge_derived_tables`, `_mergeable`, `_rename_inner_sources`, `_merge_from`,
// `_merge_joins`, `_merge_expressions`, `_merge_where`, `_merge_order`,
// `_merge_hints`, `_pop_cte`) stay snake_case verbatim, matching this project's
// established convention for optimizer top-level defs (R45/R49's own headers cite
// `normalize_identifiers.js`/`canonicalize.js`/`transforms.js`). The five
// underscore-prefixed helpers stay module-private and unexported, the same treatment
// `optimize_joins.js`'s `_is_reorderable` gets.
//
// `_mergeable`'s five upstream nested closures (`_window_projection_blocks_merge`,
// `_literal_group_unmergeable`, `_outer_select_joins_on_inner_select_join`,
// `_is_recursive`, `_literal_in_order_by`) stay nested arrow-function closures here
// too, in their exact upstream order, capturing the same outer locals
// (`outer`/`outer_args`/`outer_scope`/`inner_scope`/`from_or_join`/`inner_name`) —
// preserving upstream's own structure rather than hoisting them to module scope, since
// they are meaningless outside a single `_mergeable` call.
//
// `id(x)`/`id(x) in some_id_set` (Python object identity) is modeled as plain JS
// object-reference `Set` membership (`someSet.has(x)`) throughout — a JS `Set` already
// uses reference equality for object members, which is exactly what CPython `id()`
// compares, so no identity-shim is needed the way `_py/collections.js`'s `ExprSet` is
// needed for STRUCTURAL (`__eq__`) equality elsewhere in this port.
//
// R37's `sqlglot-js-empty-array-truthy-vs-python-empty-list-falsy` hazard recurs
// repeatedly in `_mergeable`: `exp.Select`'s own non-excluded arg keys
// (`windows`/`pivots`/`laterals`/`sort`/`cluster`/`distribute`/`locks`/`options`/
// `exclude`/`match`/`operation_modifiers`/`settings`) are ARRAY-valued, so the generic
// `any(v for k, v in inner_select.args.items() if k in UNMERGABLE_ARGS)` truthiness
// test needs an explicit `.length` check per array value, not a bare JS truthy test —
// handled by the local `argTruthy` helper below, matching the inline
// `array && array.length` idiom `optimizer/resolver.js` (R48) already established
// rather than a `_py/truthy.js` import, since every value shape here is either an
// `Expr` instance (always JS-truthy, matching Python's default-truthy object rule) or
// a plain array.

import * as exp from "../expressions/index.js";
import { findNewName, seqGet } from "../helper.js";
import { Scope, traverseScope } from "./scope.js";

// py: merge_subqueries.py:57 `UNMERGABLE_ARGS = set(exp.Select.arg_types) - {...}`.
const MERGABLE_ARGS = new Set(["expressions", "from_", "joins", "where", "order", "hint"]);
const UNMERGABLE_ARGS = new Set(
  exp.EXPR_META.select.argTypes.map(([key]) => key).filter((key) => !MERGABLE_ARGS.has(key)),
);

// py: merge_subqueries.py:69 `SAFE_TO_REPLACE_UNWRAPPED`.
const SAFE_TO_REPLACE_UNWRAPPED = [exp.Column, exp.EQ, exp.Func, exp.NEQ, exp.Paren];

/** py: merge_subqueries.py:159 — `Array.isArray` guards the R37 empty-array hazard. */
function argTruthy(value) {
  return Array.isArray(value) ? value.length > 0 : !!value;
}

/**
 * py: merge_subqueries.py:17 `merge_subqueries(expression, leave_tables_isolated=False)`.
 *
 * Rewrite sqlglot AST to merge derived tables into the outer query.
 *
 * This also merges CTEs if they are selected from only once.
 *
 * Example:
 *   merge_subqueries(parseOne("SELECT a FROM (SELECT x.a FROM x) CROSS JOIN y")).sql()
 *   -> 'SELECT x.a FROM x CROSS JOIN y'
 *
 * If `leaveTablesIsolated` is true, this will not merge inner queries into outer
 * queries if it would result in multiple table selects in a single query:
 *   merge_subqueries(parseOne("SELECT a FROM (SELECT x.a FROM x) CROSS JOIN y"), true).sql()
 *   -> 'SELECT a FROM (SELECT x.a FROM x) CROSS JOIN y'
 *
 * Inspired by https://dev.mysql.com/doc/refman/8.0/en/derived-table-optimization.html
 */
export function merge_subqueries(expression, leave_tables_isolated = false) {
  // Shared across both passes so the scope tree is only built once, as long as
  // merge_ctes doesn't mutate the AST; if it does, the scopes it was given are no
  // longer valid, so the scope tree needs to be rebuilt before merge_derived_tables
  // runs.
  let scopes = traverseScope(expression);
  let merged_ctes;
  [expression, merged_ctes] = merge_ctes(expression, leave_tables_isolated, scopes);

  if (merged_ctes) {
    scopes = traverseScope(expression);
  }

  expression = merge_derived_tables(expression, leave_tables_isolated, scopes);
  return expression;
}

/** py: merge_subqueries.py:78 `merge_ctes(expression, leave_tables_isolated=False, scopes=None)`. */
export function merge_ctes(expression, leave_tables_isolated = false, scopes = null) {
  // All places where we select from CTEs.
  // We key on the CTE scope so we can detect CTES that are selected from multiple times.
  const cte_selections = new Map();
  for (const outer_scope of scopes ?? traverseScope(expression)) {
    for (const [table, inner_scope] of outer_scope.selectedSources.values()) {
      if (inner_scope instanceof Scope && inner_scope.isCte) {
        if (!cte_selections.has(inner_scope)) cte_selections.set(inner_scope, []);
        cte_selections.get(inner_scope).push([outer_scope, inner_scope, table]);
      }
    }
  }

  let merged = false;
  const singular_cte_selections = [...cte_selections.values()]
    .filter((v) => v.length === 1)
    .map((v) => v[0]);
  for (const [outer_scope, inner_scope, table] of singular_cte_selections) {
    const from_or_join = table.findAncestor(exp.From, exp.Join);
    if (!(from_or_join instanceof exp.From || from_or_join instanceof exp.Join)) continue;
    if (_mergeable(outer_scope, inner_scope, leave_tables_isolated, from_or_join)) {
      const alias = table.aliasOrName;
      _rename_inner_sources(outer_scope, inner_scope, alias);
      _merge_from(outer_scope, inner_scope, table, alias);
      _merge_expressions(outer_scope, inner_scope, alias);
      _merge_order(outer_scope, inner_scope);
      _merge_joins(outer_scope, inner_scope, from_or_join);
      _merge_where(outer_scope, inner_scope, from_or_join);
      _merge_hints(outer_scope, inner_scope);
      _pop_cte(inner_scope);
      outer_scope.clearCache();
      merged = true;
    }
  }
  return [expression, merged];
}

/** py: merge_subqueries.py:118 `merge_derived_tables(expression, leave_tables_isolated=False, scopes=None)`. */
export function merge_derived_tables(expression, leave_tables_isolated = false, scopes = null) {
  for (const outer_scope of scopes ?? traverseScope(expression)) {
    for (const subquery of outer_scope.derivedTables) {
      const from_or_join = subquery.findAncestor(exp.From, exp.Join);
      if (!(from_or_join instanceof exp.From || from_or_join instanceof exp.Join)) continue;
      const alias = subquery.aliasOrName;
      const inner_scope = outer_scope.sources.get(alias);
      if (!(inner_scope instanceof Scope)) continue;
      if (_mergeable(outer_scope, inner_scope, leave_tables_isolated, from_or_join)) {
        _rename_inner_sources(outer_scope, inner_scope, alias);
        _merge_from(outer_scope, inner_scope, subquery, alias);
        _merge_expressions(outer_scope, inner_scope, alias);
        _merge_order(outer_scope, inner_scope);
        _merge_joins(outer_scope, inner_scope, from_or_join);
        _merge_where(outer_scope, inner_scope, from_or_join);
        _merge_hints(outer_scope, inner_scope);
        outer_scope.clearCache();
      }
    }
  }

  return expression;
}

/**
 * py: merge_subqueries.py:145 `_mergeable(outer_scope, inner_scope, leave_tables_isolated, from_or_join)`.
 *
 * Return True if `inner_select` can be merged into outer query.
 */
function _mergeable(outer_scope, inner_scope, leave_tables_isolated, from_or_join) {
  const inner_select = inner_scope.expression.unnest();
  const outer = outer_scope.expression;
  const outer_args = outer.args;
  const inner_name = from_or_join.aliasOrName;

  /**
   * A window function's result depends on the full row set it sees, so merging the
   * subquery into the outer query is unsafe when:
   *   - the outer query filters or joins (WHERE/JOIN), which changes that row set, or
   *   - a window column is referenced in an operation that isn't pushed down
   *     (GROUP BY, ORDER BY, HAVING, aggregate).
   */
  const _window_projection_blocks_merge = (window_aliases) => {
    if (window_aliases.size === 0) return false;

    if (outer_args.where || argTruthy(outer_args.joins)) return true;

    return outer_scope.columns.some(
      (column) =>
        column.table === inner_name
        && window_aliases.has(column.name)
        && column.findAncestor(exp.Group, exp.Order, exp.Having, exp.AggFunc),
    );
  };

  /**
   * A numeric-literal projection referenced in GROUP BY can't be inlined, because a
   * bare integer literal is positional. A reference that is itself a top-level GROUP
   * BY item can merge as the ordinal of the outer projection that selects it; any
   * other reference, e.g., ROLLUP / CUBE / GROUPING SETS, tuples, expressions, etc,
   * blocks the merge, since ordinals aren't universally supported there, e.g.,
   * Presto / Trino only accept columns.
   */
  const _literal_group_unmergeable = (number_literal_aliases) => {
    const group = outer_args.group;
    if (!group) return false;

    if (number_literal_aliases.size === 0) return false;

    const grouped = new Set();
    const top_level_ids = new Set(group.expressions.map((e) => e.unnest()));
    for (const col of group.findAll(exp.Column)) {
      if (col.table !== inner_name || !number_literal_aliases.has(col.name)) continue;
      if (!top_level_ids.has(col)) return true;
      grouped.add(col.name);
    }

    if (grouped.size === 0) return false;

    const projected = new Set();
    for (const s of outer.selects) {
      const unaliased = s.unalias();
      if (unaliased instanceof exp.Column && unaliased.table === inner_name) {
        projected.add(unaliased.name);
      }
    }

    return ![...grouped].every((name) => projected.has(name));
  };

  /**
   * All columns from the inner select in the ON clause must be from the first FROM table.
   *
   * That is, this can be merged:
   *     SELECT * FROM x JOIN (SELECT y.a AS a FROM y JOIN z) AS q ON x.a = q.a
   *                                  ^^^           ^
   * But this can't:
   *     SELECT * FROM x JOIN (SELECT z.a AS a FROM y JOIN z) AS q ON x.a = q.a
   *                                  ^^^                  ^
   */
  const _outer_select_joins_on_inner_select_join = (projections) => {
    if (!(from_or_join instanceof exp.Join)) return false;

    const on = from_or_join.args.on;
    if (!on) return false;
    const selections = [...on.findAll(exp.Column)]
      .filter((c) => c.table === inner_name)
      .map((c) => c.name);
    const inner_from = inner_scope.expression.args.from_;
    if (!inner_from) return false;
    const inner_from_table = inner_from.aliasOrName;
    return selections.some((selection) =>
      [...projections.get(selection).findAll(exp.Column)].some(
        (col) => col.table !== inner_from_table,
      ),
    );
  };

  // Recursive CTEs look like this:
  //     WITH RECURSIVE cte AS (
  //       SELECT * FROM x  <-- inner scope
  //       UNION ALL
  //       SELECT * FROM cte  <-- outer scope
  //     )
  const _is_recursive = () => {
    const cte = inner_scope.expression.parent;
    let node = outer.parent;

    while (node) {
      if (node === cte) return true;
      node = node.parent;
    }
    return false;
  };

  /** A numeric-literal projection under a bare ORDER BY key can't merge (would become positional). */
  const _literal_in_order_by = (number_literal_aliases) => {
    const order = outer_args.order;
    if (!order) return false;
    const ordered = new Set();
    for (const o of order.expressions) {
      const key = o.this.unnest();
      if (key instanceof exp.Column && key.table === inner_name) ordered.add(key.name);
    }
    return [...number_literal_aliases].some((name) => ordered.has(name));
  };

  if (
    !(outer instanceof exp.Select)
    || outer.isStar
    || !(inner_select instanceof exp.Select)
    || Object.entries(inner_select.args).some(([k, v]) => UNMERGABLE_ARGS.has(k) && argTruthy(v))
    || inner_select.args.from_ == null
    || argTruthy(outer_scope.pivots)
    || (leave_tables_isolated && outer_scope.selectedSources.size > 1)
    || (from_or_join instanceof exp.Join && argTruthy(inner_select.args.joins))
    || (from_or_join instanceof exp.Join
      && inner_select.args.where
      && ["FULL", "LEFT", "RIGHT"].includes(from_or_join.side))
    || (from_or_join instanceof exp.From
      && inner_select.args.where
      && (outer_args.joins || []).some((j) => ["FULL", "RIGHT"].includes(j.side)))
    || (inner_select.args.order && outer_scope.isUnion)
    || seqGet(inner_select.expressions, 0) instanceof exp.QueryTransform
  ) {
    return false;
  }

  // Single pass over the projections: replaces the separate AggFunc/Select/Explode and
  // Window tree walks, and precomputes what the checks below need per-projection.
  const window_aliases = new Set();
  const number_literal_aliases = new Set();
  const projections = new Map();

  for (const s of inner_select.selects) {
    const name = s.aliasOrName;
    projections.set(name, s);
    if (s.unalias().isNumber) number_literal_aliases.add(name);
    for (const node of s.walk()) {
      if (node instanceof exp.AggFunc || node instanceof exp.Select || node instanceof exp.Explode) {
        return false;
      }
      if (node instanceof exp.Window) window_aliases.add(name);
    }
  }

  return (
    !_outer_select_joins_on_inner_select_join(projections)
    && !_window_projection_blocks_merge(window_aliases)
    && !_literal_group_unmergeable(number_literal_aliases)
    && !_literal_in_order_by(number_literal_aliases)
    && !(inner_scope.isCte && _is_recursive())
  );
}

/**
 * py: merge_subqueries.py:320 `_rename_inner_sources(outer_scope, inner_scope, alias)`.
 *
 * Renames any sources in the inner query that conflict with names in the outer query.
 */
function _rename_inner_sources(outer_scope, inner_scope, alias) {
  const inner_taken = new Set(inner_scope.selectedSources.keys());
  const outer_taken = new Set(outer_scope.selectedSources.keys());
  const conflicts = new Set([...outer_taken].filter((x) => inner_taken.has(x)));
  conflicts.delete(alias);

  const taken = new Set([...outer_taken, ...inner_taken]);

  for (const conflict of conflicts) {
    const new_name = findNewName(taken, conflict);

    const [source] = inner_scope.selectedSources.get(conflict);
    const new_alias = exp.toIdentifier(new_name);

    if (source instanceof exp.Table && source.alias) {
      source.set("alias", new exp.TableAlias({ this: new_alias }));
    } else if (source instanceof exp.Table) {
      source.replace(exp.alias_(source, new_alias));
    } else if (source.parent instanceof exp.Subquery) {
      source.parent.set("alias", new exp.TableAlias({ this: new_alias }));
    }

    for (const column of inner_scope.sourceColumns(conflict)) {
      column.set("table", exp.toIdentifier(new_name));
    }

    inner_scope.renameSource(conflict, new_name);
  }
}

/**
 * py: merge_subqueries.py:350 `_merge_from(outer_scope, inner_scope, node_to_replace, alias)`.
 *
 * Merge FROM clause of inner query into outer query.
 */
function _merge_from(outer_scope, inner_scope, node_to_replace, alias) {
  const new_subquery = inner_scope.expression.args.from_.this;
  new_subquery.set("joins", node_to_replace.args.joins);
  node_to_replace.replace(new_subquery);
  for (const join_hint of outer_scope.joinHints) {
    const tables = join_hint.findAll(exp.Table);
    for (const table of tables) {
      if (table.aliasOrName === node_to_replace.aliasOrName) {
        table.set("this", exp.toIdentifier(new_subquery.aliasOrName));
      }
    }
  }
  outer_scope.removeSource(alias);
  outer_scope.addSource(new_subquery.aliasOrName, inner_scope.sources.get(new_subquery.aliasOrName));
}

/**
 * py: merge_subqueries.py:373 `_merge_joins(outer_scope, inner_scope, from_or_join)`.
 *
 * Merge JOIN clauses of inner query into outer query.
 */
function _merge_joins(outer_scope, inner_scope, from_or_join) {
  const new_joins = [];

  const joins = inner_scope.expression.args.joins || [];

  for (const join of joins) {
    new_joins.push(join);
    outer_scope.addSource(join.aliasOrName, inner_scope.sources.get(join.aliasOrName));
  }

  if (new_joins.length) {
    const outer_joins = outer_scope.expression.args.joins || [];

    // Maintain the join order
    let position;
    if (from_or_join instanceof exp.From) {
      position = 0;
    } else {
      position = outer_joins.indexOf(from_or_join) + 1;
    }
    outer_joins.splice(position, 0, ...new_joins);

    outer_scope.expression.set("joins", outer_joins);
  }
}

/**
 * py: merge_subqueries.py:399 `_merge_expressions(outer_scope, inner_scope, alias)`.
 *
 * Merge projections of inner query into outer query.
 */
function _merge_expressions(outer_scope, inner_scope, alias) {
  // Collect all columns that reference the alias of the inner query
  const outer_columns = new Map();
  for (const column of outer_scope.columns) {
    if (column.table === alias) {
      if (!outer_columns.has(column.name)) outer_columns.set(column.name, []);
      outer_columns.get(column.name).push(column);
    }
  }

  const group = outer_scope.expression.args.group;

  // Replace columns with the projection expression in the inner query
  for (const inner_expression of inner_scope.expression.expressions) {
    const projection_name = inner_expression.aliasOrName;
    if (!projection_name) continue;
    const columns_to_replace = outer_columns.get(projection_name) || [];
    if (!columns_to_replace.length) continue;

    let expression = inner_expression.unalias();
    const must_wrap_expression = !SAFE_TO_REPLACE_UNWRAPPED.some((c) => expression instanceof c);

    const is_number = expression.isNumber;
    const last = columns_to_replace.length - 1;

    let group_ordinal = null;
    if (is_number && outer_scope.expression instanceof exp.Select) {
      // Find the ordinal of the outer SELECT that references this inner projection.
      for (let j = 0; j < outer_scope.expression.selects.length; j++) {
        const s = outer_scope.expression.selects[j];
        const unaliased = s.unalias();
        if (
          unaliased instanceof exp.Column
          && unaliased.table === alias
          && unaliased.name === projection_name
        ) {
          group_ordinal = j + 1;
          break;
        }
      }
    }

    for (let i = 0; i < columns_to_replace.length; i++) {
      const column = columns_to_replace[i];
      const parent = column.parent;

      // A numeric-literal projection can't be inlined into a top-level GROUP BY item
      // (positional context), canonicalize to the projection's ordinal to match
      // qualify. _mergeable guarantees the ordinal exists.
      if (is_number && group) {
        const item = group.expressions.find((e) => e.unnest() === column);
        if (item !== undefined) {
          item.replace(exp.Literal.number(group_ordinal));
          continue;
        }
      }

      // Ensures we don't alter the intended operator precedence if there's additional
      // context surrounding the outer expression (i.e. it's not a simple projection).
      if ((parent instanceof exp.Unary || parent instanceof exp.Binary) && must_wrap_expression) {
        expression = exp.paren(expression, false);
      }

      // make sure we do not accidentally change the name of the column
      if (parent instanceof exp.Select && column.name !== expression.name) {
        expression = exp.alias_(expression, column.name);
      }

      // Skip the expensive deep copy for the last reference since the inner query
      // is about to be removed, so we can move the expression directly
      column.replace(i < last ? expression.copy() : expression);
    }
  }
}

/**
 * py: merge_subqueries.py:470 `_merge_where(outer_scope, inner_scope, from_or_join)`.
 *
 * Merge WHERE clause of inner query into outer query.
 */
function _merge_where(outer_scope, inner_scope, from_or_join) {
  const where = inner_scope.expression.args.where;
  if (!where || !where.this) return;

  const expression = outer_scope.expression;

  if (from_or_join instanceof exp.Join) {
    // Merge predicates from an outer join to the ON clause
    // if it only has columns that are already joined
    const from_ = expression.args.from_;
    const sources = from_ ? new Set([from_.aliasOrName]) : new Set();

    for (const join of expression.args.joins) {
      const source = join.aliasOrName;
      sources.add(source);
      if (source === from_or_join.aliasOrName) break;
    }

    if ([...exp.columnTableNames(where.this)].every((name) => sources.has(name))) {
      from_or_join.on(where.this, { copy: false });
      from_or_join.set("on", from_or_join.args.on);
      return;
    }
  }

  expression.where(where.this, { copy: false });
}

/**
 * py: merge_subqueries.py:505 `_merge_order(outer_scope, inner_scope)`.
 *
 * Merge ORDER clause of inner query into outer query.
 */
function _merge_order(outer_scope, inner_scope) {
  const inner_order = inner_scope.expression.args.order;
  if (!inner_order) return;

  if (
    ["group", "distinct", "having", "order"].some((arg) => outer_scope.expression.args[arg])
    || outer_scope.selectedSources.size !== 1
    || outer_scope.expression.expressions.some((expression) => expression.find(exp.AggFunc))
  ) {
    return;
  }

  outer_scope.expression.set("order", inner_order);
}

/** py: merge_subqueries.py:529 `_merge_hints(outer_scope, inner_scope)`. */
function _merge_hints(outer_scope, inner_scope) {
  const inner_scope_hint = inner_scope.expression.args.hint;
  if (!inner_scope_hint) return;
  const outer_scope_hint = outer_scope.expression.args.hint;
  if (outer_scope_hint) {
    for (const hint_expression of inner_scope_hint.expressions) {
      outer_scope_hint.append("expressions", hint_expression);
    }
  } else {
    outer_scope.expression.set("hint", inner_scope_hint);
  }
}

/**
 * py: merge_subqueries.py:541 `_pop_cte(inner_scope)`.
 *
 * Remove CTE from the AST.
 */
function _pop_cte(inner_scope) {
  const cte = inner_scope.expression.parent;
  if (!cte) return;
  const with_ = cte.parent;
  if (!with_) return;
  if (with_.expressions.length === 1) {
    with_.pop();
  } else {
    cte.pop();
  }
}
