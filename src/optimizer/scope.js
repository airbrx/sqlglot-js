// py: sqlglot/optimizer/scope.py @ 91119bc — TIER A ONLY.
//
// PORT_PLAN.md §6: "Tier A (P3, parser-path). The small helpers the parser itself
// calls." That is exactly one import — `parser.py:23`,
// `from sqlglot.optimizer.scope import find_in_scope` — reached from
// `parser.py:8675` (`_parse_window`'s IGNORE NULLS / RESPECT NULLS lookup).
//
// `find_in_scope` needs `find_all_in_scope`, which needs `walk_in_scope`, which needs
// `_is_derived_table`. Those four are the whole Tier A surface; the rest of scope.py
// (the `Scope` class, `build_scope`, `traverse_scope`, ~1,100 LOC) is Tier B at P5 and
// is deliberately absent rather than stubbed, so an accidental caller fails loudly.
//
// The directive below is machine-read by tools/lint_deny.mjs: it names the upstream
// line ranges this file actually ports, so the deny-list stops demanding
// acknowledgement markers for sites in the Tier B functions that are not here. Without
// it, "the file exists" is read as "the whole file is ported".
// @ported-ranges sqlglot/optimizer/scope.py 849-857 1008-1059 1062-1081 1084-1101

import * as exp from "../expressions/index.js";

// py: expressions/query.py:2165 `UNWRAPPED_QUERIES = (Select, SetOperation)`
const UNWRAPPED_QUERIES = () => [exp.Select, exp.SetOperation];

/**
 * py: scope.py:849 `_is_derived_table(expression)`
 *
 * `(tbl1 JOIN tbl2)` is represented as a Subquery but does not introduce a new scope.
 * An alias shadows every name underneath, which is the one exception.
 */
function isDerivedTable(expression) {
  return (
    expression instanceof exp.Subquery
    // py: `bool(expression.alias or isinstance(...))` — `alias` is a STRING here, so
    // the empty string is falsy. `!!expression.alias` reproduces that; a
    // `!== null` test would call an unaliased subquery derived.
    && !!(expression.alias || UNWRAPPED_QUERIES().some((C) => expression.this instanceof C))
  );
}

/**
 * py: scope.py:1008 `walk_in_scope(expression, prune=None)`
 *
 * Visits every node in the tree, stopping at nodes that start CHILD SCOPES. Upstream
 * notes it is a hand-rolled DFS rather than `expression.walk()` because nested
 * generators are not optimized by mypyc; the traversal ORDER is identical either way
 * and is preserved here exactly — pop from a stack, push args in REVERSE so siblings
 * come out in declaration order.
 *
 * @param {object} expression
 * @param {((node: object) => boolean)|null} [prune]
 */
export function* walkInScope(expression, prune = null) {
  const stack = [expression];

  while (stack.length) {
    const node = stack.pop();

    yield node;

    // py: only CTEs and Queries can start child scopes; checking that first lets every
    // other node skip the remaining boundary tests.
    if (
      node !== expression
      && (node instanceof exp.CTE || node instanceof exp.Query)
      && (
        node instanceof exp.CTE
        || ((node.parent instanceof exp.From || node.parent instanceof exp.Join)
          && isDerivedTable(node))
        || node.parent instanceof exp.UDTF
        || UNWRAPPED_QUERIES().some((C) => node instanceof C)
      )
    ) {
      if (node instanceof exp.Subquery || node instanceof exp.UDTF) {
        for (const key of ["joins", "laterals", "pivots"]) {
          for (const arg of node.args[key] || []) yield* walkInScope(arg);
        }
      }
      continue;
    }

    if (prune && prune(node)) continue;

    // py: `for vs in reversed(node.args.values())` then `for v in reversed(vs)` —
    // reversing twice so that popping the stack yields args, and list elements within
    // an arg, in their original declaration order.
    const values = Object.values(node.args);
    for (let i = values.length - 1; i >= 0; i--) {
      const vs = values[i];
      if (Array.isArray(vs)) {
        for (let j = vs.length - 1; j >= 0; j--) {
          if (vs[j] instanceof exp.Expr) stack.push(vs[j]);
        }
      } else if (vs instanceof exp.Expr) {
        stack.push(vs);
      }
    }
  }
}

/**
 * py: scope.py:1062 `find_all_in_scope(expression, *expression_types)`
 * Yields every node in this scope matching at least one type. Does NOT enter subscopes.
 */
export function* findAllInScope(expression, ...expressionTypes) {
  for (const node of walkInScope(expression)) {
    if (expressionTypes.some((C) => node instanceof C)) yield node;
  }
}

/**
 * py: scope.py:1084 `find_in_scope(expression, *expression_types)`
 * The first match, or null. py: `next(find_all_in_scope(...), None)`.
 */
export function findInScope(expression, ...expressionTypes) {
  for (const node of findAllInScope(expression, ...expressionTypes)) return node;
  return null;
}
