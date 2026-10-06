// py: sqlglot/optimizer/pushdown_projections.py @ 91119bc — WHOLE FILE (287 LOC).
//
// AIR-2111 (epic AIR-2088): the real fixture-driven test for this file is
// `TestOptimizer.test_pushdown_projection` (singular), which runs
// `tests/fixtures/optimizer/pushdown_projections.sql` (74 SQL/expected pairs) through
// a small pipeline (`tests/test_optimizer.py:45-49`) — `qualify_tables()` (no kwargs at
// all) -> `qualify_columns(infer_schema=True, **kwargs)` -> `pushdown_projections(**kwargs)`
// — not this file's own entry point alone. `spike/p10/gen_pushdown_projections_ref.py`
// reproduces that exact wrapper against pinned CPython rather than a hand-invented
// scenario battery, the same call `gen_normalize_ref.py`/R68 made for `normalize.sql`.
//
// All four named dependencies are real: `Journal`/`record` (`./journal.js`, R53),
// `Resolver` (`./resolver.js`, R48 — re-exported from `./qualify_columns.js` below,
// since upstream imports it `from sqlglot.optimizer.qualify_columns import Resolver`
// and this port's `qualify_columns.js` did not yet re-export it), `Scope`/
// `find_all_in_scope`/`find_in_scope`/`traverse_scope` (`./scope.js`, R44/R46), and
// `ensure_schema` (`../schema.js`, R41).
//
// `SELECT_ALL` (upstream: a Python `object()` sentinel, compared only by identity) is
// a module-level `Symbol`, the same "no separate id-allocator, a unique value is
// enough" idiom this port's other optimizer files use for `id()`-based identity.
//
// Three Python-truthiness traps (greppable class per
// `sqlglot-js-empty-array-truthy-vs-python-empty-list-falsy`), each checked against a
// `.length`/`.size`, not bare truthiness: `scope.pivots` (array, py:152's `or`),
// `order_refs` (a JS `Set`, py:117's `if order_refs:`), and `column_aliases` (array,
// py:159-160's `node.alias_column_names` / `if column_aliases:`). `group.expressions`
// in `_is_implicit_group_by_all` (py:262) is the same trap once more.
//
// `defaultdict(set)` (py:74 `referenced_columns`, py:143 `selects`) has no single JS
// builtin equivalent; both are a plain `Map` plus the small local `getOrCreateSet`
// get-or-create helper below, the same "defaultdict(list)-shaped get-or-create" idiom
// `simplify.js`'s `pushToExprMap`/`pushToMap` already established for this project's
// optimizer tier (not upstream).
//
// `id(selection)`/`id(source)`-keyed sets and dicts (py:178 `group_ordinal_selection_ids`,
// py:242-244 `new_pos`) are ported storing the node/selection object itself as the
// `Map`/`Set` key, with no separate id-allocator — the same reasoning this project's
// `scope.js`/`annotate_types.js`/`eliminate_ctes.js` class headers already give for
// every other `id()`-based identity table in this port.

import * as exp from "../expressions/index.js";
import { alias_ as alias } from "../expressions/index.js";
import { record } from "./journal.js";
import { Resolver } from "./qualify_columns.js";
import { Scope, findAllInScope, findInScope, traverseScope } from "./scope.js";
import { ensureSchema } from "../schema.js";
import { OptimizeError } from "../errors.js";
import { seqGet } from "../helper.js";

// py: pushdown_projections.py:20 `SELECT_ALL = object()` — sentinel value that means
// an outer query selecting ALL columns.
const SELECT_ALL = Symbol("SELECT_ALL");

// py: pushdown_projections.py:26 `SET_RETURNING_FUNCTIONS = (exp.Explode, exp.Inline, exp.Unnest)`.
//
// Set-returning (table) functions multiply the rows of the entire query, so a
// projection containing one affects the cardinality of every output column and must
// never be pruned, even when the projection itself is otherwise unreferenced.
// Posexplode and the *Outer variants are subclasses of Explode, so matching Explode
// covers them too.
const SET_RETURNING_FUNCTIONS = [exp.Explode, exp.Inline, exp.Unnest];

// Not upstream: a `defaultdict(set)`-shaped get-or-create, same idiom `simplify.js`'s
// `pushToExprMap`/`pushToMap` already established for this project's optimizer tier.
function getOrCreateSet(map, key) {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

/** py: pushdown_projections.py:29 `_is_self_referencing_cte(scope)`. */
function _is_self_referencing_cte(scope) {
  const cte = scope.expression.parent;
  return (
    cte instanceof exp.CTE
    && cte.parent instanceof exp.With
    && cte.parent.recursive
    && [...scope.expression.findAll(exp.Table)].some(
      (table) => !table.db && table.name === cte.alias,
    )
  );
}

/** py: pushdown_projections.py:43 `default_selection(is_agg)` — selection to use if selection list is empty. */
function default_selection(is_agg) {
  return alias(is_agg ? new exp.Max({ this: exp.Literal.number(1) }) : "1", "_").assertIs(
    exp.Alias,
  );
}

/**
 * py: pushdown_projections.py:47 `pushdown_projections(expression, schema=None,
 * remove_unused_selections=True, dialect=None, journal=None)`.
 *
 * Rewrite sqlglot AST to remove unused columns projections.
 *
 * Example:
 *   pushdown_projections(parseOne("SELECT y.a AS a FROM (SELECT x.a AS a, x.b AS b FROM x) AS y")).sql()
 *   -> "SELECT y.a AS a FROM (SELECT x.a AS a FROM x) AS y"
 *
 * @param {object} expression Expression to optimize.
 * @param {object|null} [schema] Schema to resolve columns/tables against.
 * @param {{removeUnusedSelections?: boolean, dialect?: *, journal?: Array|null}} [options]
 * @returns {object} The optimized expression.
 */
export function pushdown_projections(expression, schema = null, options = {}) {
  const { removeUnusedSelections = true, dialect = null, journal = null } = options;

  schema = ensureSchema(schema, { dialect });
  const source_column_alias_count = new Map();

  // Map of Scope to all columns being selected by outer queries.
  const referenced_columns = new Map();

  // We build the scope tree (which is traversed in DFS postorder), then iterate
  // over the result in reverse order. This should ensure that the set of selected
  // columns for a particular scope are completely build by the time we get to it.
  const scopes = traverseScope(expression);
  for (let idx = scopes.length - 1; idx >= 0; idx--) {
    const scope = scopes[idx];
    const scope_expression = scope.expression;
    let parent_selections = referenced_columns.get(scope) || new Set([SELECT_ALL]);
    const alias_count = source_column_alias_count.get(scope) || 0;

    // SELECT DISTINCT, UNION DISTINCT, INTERSECT, and EXCEPT consume the entire row, so we
    // can't remove any columns, otherwise we risk changing the query's semantics. Also, we
    // conservatively skip pruning on recursive CTEs that read their own output for now.
    if (
      scope_expression.args.distinct
      || scope_expression instanceof exp.Intersect
      || scope_expression instanceof exp.Except
      || _is_self_referencing_cte(scope)
    ) {
      parent_selections = new Set([SELECT_ALL]);
    }

    if (scope_expression instanceof exp.SetOperation) {
      if (scope_expression.kind || scope_expression.side) {
        // Do not optimize this set operation if it's using the BigQuery specific kind / side
        // syntax (e.g INNER UNION ALL BY NAME) which changes the semantics of the operation
        continue;
      }

      const [left, right] = scope.unionScopes;
      const le = left.expression;
      const re = right.expression;

      if (!(le instanceof exp.Selectable && re instanceof exp.Selectable)) continue;

      const by_name = scope_expression.args.by_name;

      if (!by_name && le.selects.length !== re.selects.length) {
        const scope_sql = scope_expression.sql(dialect);
        throw new OptimizeError(`Invalid set operation due to column mismatch: ${scope_sql}.`);
      }

      // Columns in ORDER BY need to be kept too
      const order = scope_expression.args.order;
      if (order && !parent_selections.has(SELECT_ALL)) {
        const order_refs = new Set(
          [...findAllInScope(order, exp.Column)].filter((c) => !c.table).map((c) => c.name),
        );
        if (order_refs.size) {
          parent_selections = new Set([...parent_selections, ...order_refs]);
        }
      }

      referenced_columns.set(left, parent_selections);

      if (re.isStar) {
        referenced_columns.set(right, parent_selections);
      } else if (!le.isStar) {
        if (by_name) {
          referenced_columns.set(right, parent_selections);
        } else if (!parent_selections.has(SELECT_ALL)) {
          // This being unset means looking up `right` later yields SELECT_ALL (default)
          const rightNames = new Set();
          for (let i = 0; i < le.selects.length; i++) {
            if (parent_selections.has(le.selects[i].aliasOrName)) {
              rightNames.add(re.selects[i].aliasOrName);
            }
          }
          referenced_columns.set(right, rightNames);
        }
      }
    }

    if (scope_expression instanceof exp.Select) {
      if (removeUnusedSelections) {
        _remove_unused_selections(scope, parent_selections, schema, alias_count, journal);
      }

      if (scope.scansAllSubscopeColumns) continue;

      // Group columns by source name
      const selects = new Map();
      for (const col of scope.columns) getOrCreateSet(selects, col.table).add(col.name);

      // Push the selected columns down to the next scope
      for (const [name, [node, source]] of scope.selectedSources) {
        if (source instanceof Scope && source.expression instanceof exp.Selectable) {
          const select = seqGet(source.expression.selects, 0);

          let columns;
          if (scope.pivots.length || select instanceof exp.QueryTransform) {
            columns = new Set([SELECT_ALL]);
          } else {
            columns = selects.get(name) || new Set();
          }

          const target = getOrCreateSet(referenced_columns, source);
          for (const c of columns) target.add(c);
        }

        const column_aliases = node.aliasColumnNames;
        if (column_aliases.length) {
          source_column_alias_count.set(source, column_aliases.length);
        }
      }
    }
  }

  return expression;
}

/** py: pushdown_projections.py:166 `_remove_unused_selections(scope, parent_selections, schema, alias_count, journal=None)`. */
function _remove_unused_selections(scope, parent_selections, schema, alias_count, journal = null) {
  const expression = scope.expression;
  const order = expression.args.order;

  let order_refs;
  if (order) {
    // Assume columns without a qualified table are references to output columns
    order_refs = new Set([...order.findAll(exp.Column)].filter((c) => !c.table).map((c) => c.name));
  } else {
    order_refs = new Set();
  }

  // Resolve bare GROUP BY ordinals before pruning
  const ordinal_refs = _bare_group_by_ordinal_refs(expression);
  const group_ordinal_selection_ids = new Set(ordinal_refs.map(([, selection]) => selection));

  // GROUP BY ALL with no explicit keys implicitly groups by every non-aggregate
  // projection, so those projections are grouping keys and can't be pruned
  const implicit_group_by_all = _is_implicit_group_by_all(expression);

  const new_selections = [];
  let removed = false;
  let star = false;
  let is_agg = false;

  const select_all = parent_selections.has(SELECT_ALL);

  for (const selection of expression.selects) {
    const name = selection.aliasOrName;
    const is_agg_selection =
      (implicit_group_by_all || !is_agg) && findInScope(selection, exp.AggFunc) !== null;

    if (
      select_all
      || parent_selections.has(name)
      || order_refs.has(name)
      || alias_count > 0
      || group_ordinal_selection_ids.has(selection)
      || (implicit_group_by_all && !is_agg_selection)
    ) {
      new_selections.push(selection);
      alias_count -= 1;
    } else if (findInScope(selection, ...SET_RETURNING_FUNCTIONS) !== null) {
      // A set-returning function multiplies the rows of the whole query, so this
      // projection affects the cardinality of every output column and must be kept
      // even though it is otherwise unreferenced. It is not a positional alias slot,
      // so alias_count is left untouched.
      new_selections.push(selection);
    } else {
      if (selection.isStar) star = true;
      removed = true;
    }

    if (!is_agg && is_agg_selection) is_agg = true;
  }

  if (star) {
    const resolver = new Resolver(scope, schema);
    const names = new Set(new_selections.map((s) => s.aliasOrName));

    for (const name of [...parent_selections].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (!names.has(name)) {
        new_selections.push(alias(exp.column(name, resolver.getTable(name)), name, { copy: false }));
      }
    }
  }

  // If there are no remaining selections, just select a single constant
  if (!new_selections.length) {
    new_selections.push(default_selection(is_agg));
  }

  if (journal !== null && removed) {
    record(journal, expression, "expressions");
  }

  expression.select(...new_selections, { append: false, copy: false });

  // Rewrite bare GROUP BY ordinals to their positions in the pruned SELECT list
  if (ordinal_refs.length) {
    const new_pos = new Map(new_selections.map((selection, i) => [selection, i + 1]));
    for (const [node, old_selection] of ordinal_refs) {
      const pos = new_pos.get(old_selection);
      if (pos !== undefined && Number(node.this) !== pos) {
        if (journal !== null) record(journal, node, "this");
        node.set("this", String(pos));
      }
    }
  }

  if (removed) scope.clearCache();
}

/**
 * py: pushdown_projections.py:254 `_is_implicit_group_by_all(select)`.
 *
 * Bare GROUP BY ALL infers its keys from the SELECT list, unlike ALL as a
 * grouping-sets modifier (e.g. GROUP BY ALL CUBE (...) or GROUP BY ALL a, b).
 */
function _is_implicit_group_by_all(select) {
  const group = select.args.group;
  if (!group || !group.args.all) return false;

  return !(
    group.expressions.length
    || group.args.cube
    || group.args.rollup
    || group.args.grouping_sets
  );
}

/** py: pushdown_projections.py:269 `_bare_group_by_ordinal_refs(select)` — map each bare GROUP BY integer ordinal to its pre-prune projection. */
function _bare_group_by_ordinal_refs(select) {
  const group = select.args.group;
  if (!group) return [];

  const selects = select.selects;
  const n = selects.length;
  const refs = [];

  for (const node of group.expressions) {
    if (node.isInt && node instanceof exp.Literal) {
      const pos = Number(node.this);
      if (pos >= 1 && pos <= n) {
        refs.push([node, selects[pos - 1]]);
      }
    }
  }

  return refs;
}
