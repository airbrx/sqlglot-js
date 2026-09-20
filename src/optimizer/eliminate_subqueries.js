// py: sqlglot/optimizer/eliminate_subqueries.py @ 91119bc — WHOLE FILE (211 LOC).
//
// Genuinely greenfield, the same shape `qualify_tables.js`/`isolate_table_selects.js`
// (R50) and `optimize_joins.js` (R45) already established: nothing in this port calls
// `eliminate_subqueries` yet (the `optimizer.js` RULES orchestrator that would wire it
// in is a separate future issue). Both named dependencies are real: `Scope`/`build_scope`
// (`./scope.js`, landed R44/R46) and `helper.find_new_name` (already ported as
// `findNewName`, `../helper.js`). The upstream `_typing.E` TypeVar and the
// `TYPE_CHECKING`-guarded `ExistingCTEsMapping`/`TakenNameMapping` aliases are type-only
// and dropped, matching `optimize_joins.js`'s own header for the identical import.
//
// `existing_ctes` (upstream: `dict[exp.Expr, str]`) is keyed by an EXPRESSION OBJECT,
// and Python's `dict` lookup on an `Expr` key uses `Expression.__eq__`/`__hash__` —
// STRUCTURAL equality, not identity (§4.5) — which is exactly how this function
// deduplicates two textually-identical derived tables into one CTE (the module's own
// second docstring example). A plain JS `Map` compares keys by reference and would never
// match two distinct-but-equal subquery nodes, so `existing_ctes` uses `_py/collections.js`'s
// `ExprMap`, the same value-keyed container `unnest_subqueries.js` already established
// for this exact hazard. `taken` (upstream: `dict[str, Union[Scope, Expr]]`) is keyed by
// a plain STRING alias name, so a plain JS `Map` is correct there and also satisfies
// `findNewName`'s `taken instanceof Map` fast path.
//
// Two Python-truthiness traps (§4.5/R37's standing hazard, hit again here): `if new_ctes:`
// gates on a non-empty LIST, ported as `newCtes.length` not bare truthiness (an empty JS
// array is always truthy); `with_.expressions` reads through `Expr.expressions`, which
// already defaults to `[]` (never null) per `Expression.expressions`'s own contract —
// `eliminate_ctes.js` (this issue's sibling file) has the same `with_.expressions.length`
// pattern for the identical reason.

import * as exp from "../expressions/index.js";
import { findNewName } from "../helper.js";
import { ExprMap } from "../_py/collections.js";
import { buildScope } from "./scope.js";

/**
 * py: eliminate_subqueries.py:16 `eliminate_subqueries(expression)`.
 *
 * Rewrite derived tables as CTEs, deduplicating if possible.
 *
 * Example:
 *   eliminate_subqueries(parseOne("SELECT a FROM (SELECT * FROM x) AS y")).sql()
 *   -> "WITH y AS (SELECT * FROM x) SELECT a FROM y AS y"
 *
 * This also deduplicates common subqueries:
 *   eliminate_subqueries(parseOne(
 *     "SELECT a FROM (SELECT * FROM x) AS y CROSS JOIN (SELECT * FROM x) AS z",
 *   )).sql()
 *   -> "WITH y AS (SELECT * FROM x) SELECT a FROM y AS y CROSS JOIN y AS z"
 */
export function eliminate_subqueries(expression) {
  if (expression instanceof exp.Subquery) {
    // It's possible to have subqueries at the root, e.g. (SELECT * FROM x) LIMIT 1
    eliminate_subqueries(expression.this);
    return expression;
  }

  const root = buildScope(expression);

  if (!root) return expression;

  // Map of alias->Scope|Table
  // These are all aliases that are already used in the expression.
  // We don't want to create new CTEs that conflict with these names.
  const taken = new Map();

  // All CTE aliases in the root scope are taken
  for (const scope of root.cteScopes) {
    const parent = scope.expression.parent;
    if (parent) taken.set(parent.alias, scope);
  }

  // All table names are taken
  for (const scope of root.traverse()) {
    for (const [, source] of scope.sources) {
      if (source instanceof exp.Table) taken.set(source.name, source);
    }
  }

  // Map of Expr->alias
  // Existing CTES in the root expression. We'll use this for deduplication.
  const existingCtes = new ExprMap();

  const with_ = root.expression.args.with_;
  let recursive = false;
  if (with_) {
    recursive = with_.args.recursive;
    for (const cte of with_.expressions) existingCtes.set(cte.this, cte.alias);
  }
  const newCtes = [];

  // We're adding more CTEs, but we want to maintain the DAG order.
  // Derived tables within an existing CTE need to come before the existing CTE.
  for (const cteScope of root.cteScopes) {
    // Append all the new CTEs from this existing CTE
    for (const scope of cteScope.traverse()) {
      if (scope === cteScope) {
        // Don't try to eliminate this CTE itself
        continue;
      }
      const newCte = _eliminate(scope, existingCtes, taken);
      if (newCte) newCtes.push(newCte);
    }

    // Append the existing CTE itself
    const cteParent = cteScope.expression.parent;
    if (cteParent) newCtes.push(cteParent);
  }

  // Now append the rest
  for (const scope of [...root.unionScopes, ...root.subqueryScopes, ...root.tableScopes]) {
    for (const childScope of scope.traverse()) {
      const newCte = _eliminate(childScope, existingCtes, taken);
      if (newCte) newCtes.push(newCte);
    }
  }

  if (newCtes.length) {
    let query = expression instanceof exp.DDL ? expression.expression : expression;
    if (!(query instanceof exp.Query)) {
      // This can be reached for DMLs, which shouldn't hold the WITH clause; attach it to
      // the root query, which is also where any pre-existing CTEs in `new_ctes` came from
      query = root.expression.unnest();
    }

    query.set("with_", new exp.With({ expressions: newCtes, recursive }));
  }

  return expression;
}

// py: eliminate_subqueries.py:116 `_eliminate(scope, existing_ctes, taken)`.
function _eliminate(scope, existingCtes, taken) {
  if (scope.isDerivedTable) return _eliminate_derived_table(scope, existingCtes, taken);

  if (scope.isCte) return _eliminate_cte(scope, existingCtes, taken);

  return null;
}

// py: eliminate_subqueries.py:128 `_eliminate_derived_table(scope, existing_ctes, taken)`.
function _eliminate_derived_table(scope, existingCtes, taken) {
  // This makes sure that we don't:
  // - drop the "pivot" arg from a pivoted subquery
  // - eliminate a lateral correlated subquery
  const parentScope = scope.parent;
  if (!parentScope || parentScope.pivots.length || parentScope.expression instanceof exp.Lateral) {
    return null;
  }

  const exprParent = scope.expression.parent;
  if (!(exprParent instanceof exp.Subquery) || exprParent === parentScope.expression) {
    // In the latter case the wrapper is the parent scope's root, e.g., the FROM clause
    // of a DML statement or a parenthesized DDL source, not one of its derived tables
    return null;
  }

  // Get rid of redundant exp.Subquery expressions, i.e. those that are just used as wrappers
  const toReplace = exprParent.unwrap();
  const [name, cte] = _new_cte(scope, existingCtes, taken);
  const table = exp.alias_(exp.table_(name), toReplace.alias || name);
  table.set("joins", toReplace.args.joins);

  toReplace.replace(table);

  return cte;
}

// py: eliminate_subqueries.py:155 `_eliminate_cte(scope, existing_ctes, taken)`.
function _eliminate_cte(scope, existingCtes, taken) {
  const parent = scope.expression.parent;
  if (!parent) return null;
  const [name, cte] = _new_cte(scope, existingCtes, taken);

  const with_ = parent.parent;
  parent.pop();
  if (with_ && !with_.expressions.length) with_.pop();

  // Rename references to this CTE
  if (!scope.parent) return cte;
  for (const childScope of scope.parent.traverse()) {
    for (const [table, source] of childScope.selectedSources.values()) {
      if (source === scope) {
        const newTable = exp.alias_(exp.table_(name), table.aliasOrName, { copy: false });
        table.replace(newTable);
      }
    }
  }

  return cte;
}

/**
 * py: eliminate_subqueries.py:180 `_new_cte(scope, existing_ctes, taken)`.
 *
 * Returns [name, cte] where `name` is a new name for this CTE in the root scope and
 * `cte` is a new CTE instance. If this CTE duplicates an existing CTE, `cte` is null.
 */
function _new_cte(scope, existingCtes, taken) {
  const duplicateCteAlias = existingCtes.get(scope.expression);
  const parent = scope.expression.parent;
  let name = parent ? parent.alias : "";

  if (!name) name = findNewName(taken, "cte");

  if (duplicateCteAlias) {
    name = duplicateCteAlias;
  } else if (taken.get(name)) {
    name = findNewName(taken, name);
  }

  taken.set(name, scope);

  let cte = null;
  if (!duplicateCteAlias) {
    existingCtes.set(scope.expression, name);
    cte = new exp.CTE({
      this: scope.expression,
      alias: new exp.TableAlias({ this: exp.toIdentifier(name) }),
    });
  }
  return [name, cte];
}
