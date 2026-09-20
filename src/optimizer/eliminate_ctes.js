// py: sqlglot/optimizer/eliminate_ctes.py @ 91119bc — WHOLE FILE (58 LOC).
//
// Genuinely greenfield, the same shape `eliminate_subqueries.js` (this issue's sibling
// file) already established: nothing in this port calls `eliminate_ctes` yet (the
// `optimizer.js` RULES orchestrator that would wire it in is a separate future issue).
// Both named dependencies are real: `Journal`/`record` (`./journal.js`, this issue's own
// third file) and `Scope`/`build_scope` (`./scope.js`, landed R44/R46). The upstream
// `_typing.E` TypeVar import is type-only and dropped, matching every other ported
// file's header for the identical import (`eliminate_subqueries.js`, `optimize_joins.js`).
//
// `ref_count` (upstream: `dict[int, int]` keyed by `id(source)`) is ported per
// `scope.js`'s own class header as a JS `Map` keyed by the source object itself — no
// separate id-allocator, since a `Map` already compares object keys by reference.
//
// Two Python-truthiness traps: `len(with_node.expressions) <= 0` is a length check
// already, ported directly as `withNode.expressions.length <= 0` (NOT bare truthiness —
// `Expr.expressions` defaults to `[]`, always truthy as a JS object, the same hazard
// `eliminate_subqueries.js`'s header names); `count <= 0` is a plain number comparison
// with no such trap.

import { record } from "./journal.js";
import { Scope, buildScope } from "./scope.js";

/**
 * py: eliminate_ctes.py:13 `eliminate_ctes(expression, journal=None)`.
 *
 * Remove unused CTEs from an expression.
 *
 * Example:
 *   eliminate_ctes(parseOne("WITH y AS (SELECT a FROM x) SELECT a FROM z")).sql()
 *   -> "SELECT a FROM z"
 */
export function eliminate_ctes(expression, journal = null) {
  const root = buildScope(expression);

  if (root) {
    const refCount = root.refCount();

    // Traverse the scope tree in reverse so we can remove chains of unused CTEs
    for (const scope of [...root.traverse()].reverse()) {
      if (scope.isCte) {
        const count = refCount.get(scope) || 0;
        if (count <= 0) {
          const cteNode = scope.expression.parent;
          if (!cteNode) continue;
          const withNode = cteNode.parent;
          if (journal !== null && withNode) record(journal, withNode, "expressions");
          cteNode.pop();

          // Pop the entire WITH clause if this is the last CTE
          if (withNode && withNode.expressions.length <= 0) {
            if (journal !== null && withNode.parent) record(journal, withNode.parent, "with_");
            withNode.pop();
          }

          // Decrement the ref count for all sources this CTE selects from
          for (const [, source] of scope.selectedSources.values()) {
            if (source instanceof Scope) refCount.set(source, (refCount.get(source) || 0) - 1);
          }
        }
      }
    }
  }

  return expression;
}
