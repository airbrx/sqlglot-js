// py: sqlglot/optimizer/normalize.py @ 91119bc — WHOLE FILE (228 LOC).
//
// Rewrites a boolean expression tree into conjunctive or disjunctive normal form.
// Depends on `optimizer/simplify.js`'s `Simplifier` class and module-level `flatten`
// helper (both already ported), and `optimizer/scope.js`'s `findAllInScope` (Epic 1).
// The upstream `collections.abc.Callable`/`Iterator` imports are type-only annotations
// with no JS analogue and are dropped, matching how every other ported file in this
// repo drops upstream's type-only imports.
//
// `logger.info(...)` (py:45-47, py:58) is the first call site in this port to reach
// the "sqlglot" logger's INFO level — `src/logging.js` only had `warning`/`error`
// before this file. Added there as a strictly-additive method (§8.1 Rule 3): by
// default (no active capture) it emits nothing, matching Python's own default
// behavior, since the "sqlglot" logger's default effective level is WARNING and an
// INFO record is never even constructed outside of an `assertLogs`-style capture.
//
// `logger.info(e)` (py:58, `e` an `OptimizeError`) needs the explicit `String(e.message)`
// spelling rather than passing the Error object directly — a template literal would
// call `.toString()`, and this port's own `Expr.toString()` override means that
// hazard is normally about `Expr` values, but `Error#toString()` also doesn't match
// Python's `str(exception)` (`"Error: <message>"` vs `<message>`), so the explicit
// `.message` read is required here too, following the same style as
// `src/parser.js`'s `logger.error(String(error.message))`.

import * as exp from "../expressions/index.js";
import { OptimizeError } from "../errors.js";
import { whileChanging } from "../helper.js";
import { logger } from "../logging.js";
import { findAllInScope } from "./scope.js";
import { Simplifier, flatten } from "./simplify.js";

/**
 * py: normalize.py:15 `normalize(expression, dnf=False, max_distance=128)`.
 *
 * Rewrite sqlglot AST into conjunctive normal form or disjunctive normal form.
 *
 * Example:
 *   normalize(parse_one("(x AND y) OR z"), false).sql() -> '(x OR z) AND (y OR z)'
 *
 * @param {import("../expressions/core.js").Expr} expression expression to normalize
 * @param {boolean} dnf rewrite in disjunctive normal form instead.
 * @param {number} max_distance the maximal estimated distance from cnf/dnf to attempt conversion
 */
export function normalize(expression, dnf = false, max_distance = 128) {
  const simplifier = new Simplifier(null, false);

  for (const node of [...expression.walk(true, (e) => e instanceof exp.Connector)]) {
    if (node instanceof exp.Connector) {
      if (normalized(node, dnf)) continue;
      const root = node === expression;
      const original = node.copy();

      node.transform(simplifier.rewrite_between.bind(simplifier), { copy: false });
      const distance = normalization_distance(node, dnf, max_distance);

      if (distance > max_distance) {
        logger.info(`Skipping normalization because distance ${distance} exceeds max ${max_distance}`);
        return expression;
      }

      let newNode;
      try {
        newNode = node.replace(
          whileChanging(node, (e) => distributive_law(e, dnf, max_distance, simplifier)),
        );
      } catch (e) {
        if (!(e instanceof OptimizeError)) throw e;
        logger.info(String(e.message));
        node.replace(original);
        if (root) return original;
        return expression;
      }

      if (root) expression = newNode;
    }
  }

  return expression;
}

/**
 * py: normalize.py:70 `normalized(expression, dnf=False)`.
 *
 * Checks whether a given expression is in a normal form of interest.
 *
 * Example:
 *   normalized(parse_one("(a AND b) OR c OR (d AND e)"), true) -> true
 *   normalized(parse_one("(a OR b) AND c")) // Checks CNF by default -> true
 *   normalized(parse_one("a AND (b OR c)"), true) -> false
 *
 * @param {boolean} dnf Whether to check if the expression is in Disjunctive Normal
 *   Form (DNF). Default: false, i.e. we check if it's in Conjunctive Normal Form (CNF).
 */
export function normalized(expression, dnf = false) {
  const [ancestor, root] = dnf ? [exp.And, exp.Or] : [exp.Or, exp.And];
  for (const connector of findAllInScope(expression, root)) {
    if (connector.findAncestor(ancestor)) return false;
  }
  return true;
}

/**
 * py: normalize.py:94 `normalization_distance(expression, dnf=False, max_=float("inf"))`.
 *
 * The difference in the number of predicates between a given expression and its
 * normalized form.
 *
 * This is used as an estimate of the cost of the conversion which is exponential in
 * complexity.
 *
 * Example:
 *   normalization_distance(parse_one("(a AND b) OR (c AND d)")) -> 4
 *
 * @param {number} max_ stop early if count exceeds this.
 */
export function normalization_distance(expression, dnf = false, max_ = Infinity) {
  let total = -([...expression.findAll(exp.Connector)].length + 1);

  for (const length of _predicate_lengths(expression, dnf, max_)) {
    total += length;
    if (total > max_) return total;
  }

  return total;
}

/**
 * py: normalize.py:127 `_predicate_lengths(expression, dnf, max_=float("inf"), depth=0)`.
 *
 * Returns a list of predicate lengths when expanded to normalized form.
 *
 * (A AND B) OR C -> [2, 2] because len(A OR C), len(B OR C).
 */
function* _predicate_lengths(expression, dnf, max_ = Infinity, depth = 0) {
  if (depth > max_) {
    yield depth;
    return;
  }

  expression = expression.unnest();

  if (!(expression instanceof exp.Connector)) {
    yield 1;
    return;
  }

  depth += 1;
  const left = expression.left, right = expression.right;

  if (expression instanceof (dnf ? exp.And : exp.Or)) {
    for (const a of _predicate_lengths(left, dnf, max_, depth)) {
      for (const b of _predicate_lengths(right, dnf, max_, depth)) {
        yield a + b;
      }
    }
  } else {
    yield* _predicate_lengths(left, dnf, max_, depth);
    yield* _predicate_lengths(right, dnf, max_, depth);
  }
}

/**
 * py: normalize.py:157 `distributive_law(expression, dnf, max_distance, simplifier=None)`.
 *
 * x OR (y AND z) -> (x OR y) AND (x OR z)
 * (x AND y) OR (y AND z) -> (x OR y) AND (x OR z) AND (y OR y) AND (y OR z)
 */
export function distributive_law(expression, dnf, max_distance, simplifier = null) {
  if (normalized(expression, dnf)) return expression;

  const distance = normalization_distance(expression, dnf, max_distance);

  if (distance > max_distance) {
    throw new OptimizeError(`Normalization distance ${distance} exceeds max ${max_distance}`);
  }

  exp.replaceChildren(expression, (e) => distributive_law(e, dnf, max_distance));
  const [to_exp, from_exp] = dnf ? [exp.Or, exp.And] : [exp.And, exp.Or];

  if (expression instanceof from_exp) {
    const [a, b] = expression.unnestOperands();

    const from_func = from_exp === exp.And ? exp.and_ : exp.or_;
    const to_func = to_exp === exp.And ? exp.and_ : exp.or_;

    simplifier = simplifier || new Simplifier(null, false);

    if (a instanceof to_exp && b instanceof to_exp) {
      if ([...a.findAll(exp.Connector)].length > [...b.findAll(exp.Connector)].length) {
        return _distribute(a, b, from_func, to_func, simplifier);
      }
      return _distribute(b, a, from_func, to_func, simplifier);
    }
    if (a instanceof to_exp) return _distribute(b, a, from_func, to_func, simplifier);
    if (b instanceof to_exp) return _distribute(a, b, from_func, to_func, simplifier);
  }

  return expression;
}

/** py: normalize.py:195 `_distribute(a, b, from_func, to_func, simplifier)`. */
function _distribute(a, b, from_func, to_func, simplifier) {
  // When `a` and `b` are connectors of the SAME polarity (e.g. both AND in
  // CNF mode), `b` is distributed across `a`'s children so the existing
  // cross-product handling can simplify them.
  if (a instanceof exp.Connector && a instanceof b.constructor) {
    exp.replaceChildren(
      a,
      (c) => to_func(
        simplifier.uniq_sort(flatten(from_func(c, b.left))),
        simplifier.uniq_sort(flatten(from_func(c, b.right))),
        { copy: false },
      ),
    );
    return a;
  }

  // Otherwise apply the textbook rule
  // `a OR (b.left AND b.right) -> (a OR b.left) AND (a OR b.right)` (or
  // the AND/OR dual). When `a` is a connector of the OPPOSITE polarity to
  // `b` (e.g. `Or(...) OR And(...)` in CNF mode) the previous behaviour was
  // to push `b` into each child of `a`, leaving an intermediate
  // `Or(And, And)` that `while_changing` would later cross-product into
  // redundant superset and duplicate clauses. Returning the direct rewrite
  // avoids that detour.
  return to_func(
    simplifier.uniq_sort(flatten(from_func(a, b.left))),
    simplifier.uniq_sort(flatten(from_func(a, b.right))),
    { copy: false },
  );
}
