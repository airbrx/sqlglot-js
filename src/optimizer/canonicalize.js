// py: sqlglot/optimizer/canonicalize.py @ 91119bc — TIER A ONLY, same shape as
// `src/optimizer/scope.js`'s own header.
//
// One function ported: `ensure_bools(expression, replace_func)` (py:149) — the only
// symbol `sqlglot/transforms.py`'s own, DIFFERENTLY-SHAPED `ensure_bools` imports
// from this module (`src/transforms.js`'s copy of that wrapper). Needed because
// `src/generators/tsql.js` is the first dialect in this port to set
// `Generator.ENSURE_BOOLS = true` (every other ported dialect leaves it at the base
// `false`), which makes `Generator.preprocess()` (src/generator.js) call
// `transforms.ensure_bools` on EVERY `.generate()` call — previously dead code,
// stubbed `NotPorted` at generator.py:981 since nothing reached it. The rest of
// `optimizer/canonicalize.py` (~250 more LOC: `canonicalize`, `remove_ascending_order`,
// `coerce_type`, `_replace_int_predicate`, ...) is Tier B and deliberately absent
// rather than stubbed, so an accidental caller fails loudly.
// @ported-ranges sqlglot/optimizer/canonicalize.py 149-163

import * as exp from "../expressions/index.js";

/**
 * py: optimizer/canonicalize.py:149 `ensure_bools(expression, replace_func)`
 *
 * For the four expression shapes where a child position is used as a BOOLEAN
 * predicate — a `Connector`'s two sides, a `Not`'s operand, an `If`'s condition
 * (unless it's really a CASE branch value rather than a real IF), or a
 * `Where`/`Having`'s condition — calls `replace_func` on that child, so the caller
 * can rewrite a bare numeric predicate into an explicit boolean comparison.
 *
 * @param {exp.Expr} expression
 * @param {(node: exp.Expr) => void} replace_func
 * @returns {exp.Expr}
 */
export function ensure_bools(expression, replace_func) {
  if (expression instanceof exp.Connector) {
    replace_func(expression.left);
    replace_func(expression.right);
  } else if (expression instanceof exp.Not) {
    replace_func(expression.this);
    // We can't replace num in CASE x WHEN num ..., because it's not the full predicate
  } else if (
    expression instanceof exp.If
    && !(expression.parent instanceof exp.Case && expression.parent.this)
  ) {
    replace_func(expression.this);
  } else if (expression instanceof exp.Where || expression instanceof exp.Having) {
    replace_func(expression.this);
  }

  return expression;
}
