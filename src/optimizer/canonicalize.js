// py: sqlglot/optimizer/canonicalize.py @ 91119bc (AIR-2117, epic AIR-2090) — WHOLE FILE.
// `ensure_bools(expression, replace_func)` (py:149) landed first (R43, as the only
// symbol `transforms.js`'s differently-shaped `ensure_bools` wrapper imports from this
// module); this round ports the remaining ~243 LOC: `canonicalize()` itself,
// `add_text_to_concat`, `replace_date_funcs`, `coerce_type` and its
// `_coerce_date`/`_coerce_timeunit_arg`/`_coerce_datediff_args`/`_replace_cast` helpers,
// `remove_redundant_casts`, `remove_ascending_order`, and `_replace_int_predicate`.
//
// Dependencies, all verified real (read directly, not assumed) rather than stubs:
// `TypeAnnotator`/`annotate_types` (R54 + per-dialect overlays), `exp.DataType`/`DType`
// (TEXT_TYPES/TEMPORAL_TYPES/INTEGER_TYPES/NUMERIC_TYPES are real Sets, not stubs),
// `Dialect.get_or_raise` (P5), and `helper.js`'s `isDateUnit`/`isIsoDate`/`isIsoDatetime`
// (already real, already backed by `_py/datetime.js`'s CPython-faithful ISO parsing —
// no changes needed here).
//
// CIRCULAR-IMPORT CHECK (done, not assumed, and the first attempt at it was WRONG):
// `transforms.js` already imports this module's `ensure_bools` (R43), and
// `transforms.js` is itself reached from `dialects/dialect.js` via `generator.js` — so
// this file is already part of `dialect.js`'s transitive closure. A top-level `import {
// Dialect } from "../dialects/dialect.js"` here therefore closes a real two-directional
// ES-module cycle (`canonicalize.js` -> `dialect.js` -> `generator.js` ->
// `transforms.js` -> `canonicalize.js`), the same hazard class R32/R42/R43 already
// named. Deferring every `Dialect` reference into a function body (never touching it at
// module top level) looked sufficient and tested clean under two import orders
// (`index.js` first, `canonicalize.js` first) — but a THIRD real order breaks it:
// importing `generator.js` directly first (`test/generator_dispatch.test.mjs` does
// exactly this) walks generator.js -> transforms.js -> canonicalize.js -> dialect.js
// BEFORE generator.js's own `class Generator` declaration has run, and `dialect.js`'s
// class bodies read `Generator` EAGERLY in a static field initializer
// (`generator_class = Generator`, evaluated at class-definition time, not deferred) —
// so the cycle breaks during import linking, before canonicalize() is ever called, no
// matter how carefully its own body defers the read. `tokens.js`'s own `Tokenizer`
// constructor already documents and solves this exact shape (its own one-directional
// version) by NOT statically importing `dialects/dialect.js` at all: `dialect.js`
// injects `Dialect.get_or_raise` into `tokens.js` via `setDialectResolver()`, called
// once dialect.js finishes loading. `tokens.js` is a true leaf here (imports only
// `trie.js`/`_py/str.js`/`tokenizer_core.js`, nothing that reaches `dialect.js` or this
// file), so reusing that SAME injected resolver via the new `getDialectResolver()`
// export below is safe with zero new cycle risk, and reuses the real
// `Dialect.get_or_raise` (string-with-settings parsing, registry lookup, the works)
// rather than reimplementing any of it locally.
//
// Fixing ONLY the `Dialect` import was not enough, though (verified -- this was the
// actual residual failure, not just a hypothetical one): `optimizer/annotate_types.js`
// ALSO imports `dialects/dialect.js` directly at its own top level, so a top-level
// `import { annotate_types } from "./annotate_types.js"` here pulls `dialect.js` in
// transitively through the SAME cyclic path, independent of whether this file touches
// `Dialect` itself. `annotate_types.js` is not a true leaf like `tokens.js`, so it
// cannot relay through the same mechanism in the same direction; instead
// `annotate_types.js` PUSHES its own `annotate_types`/`TypeAnnotator` into `tokens.js`'s
// relay (`setAnnotateTypesRef`) once it finishes loading, and this file reads them back
// via `getAnnotateTypesRef()` — the same leaf, the same no-new-cycle guarantee, just
// push instead of pull. Re-verified empirically after both fixes: `node --test
// test/generator_dispatch.test.mjs` and `test/optimizer_resolver.test.mjs` (the two
// cases that broke under the top-level-import attempt) both pass again, and the full
// `npm test` suite is green.
//
// Python-list/empty-array-truthy hazard (R37/R38/R48/R67 precedent) hit twice below:
// `not node.expressions` (py:97, `Date`/`TsOrDsToDate`'s extra-args list) and `not
// expression.this.type.expressions` (py:142, a scalar `DataType`'s nested-type list) are
// both ported with an explicit `.length` check, never bare truthiness.
//
// `expression.to == expression.this.type` (py:134, comparing two separately-built
// `DataType` AST nodes) is Python's `Expr.__eq__`, structural-hash equality — ported as
// `.equals()`, this project's established idiom (`eliminate_joins.js`/`simplify.js`/
// `unnest_subqueries.js`), not JS `===` (reference equality, which would wrongly treat
// two structurally-identical-but-distinct `DataType` instances as unequal).
//
// `_coerce_date`'s `for a, b in itertools.permutations([a, b]):` (py:179) evaluates
// `[a, b]` ONCE against the function's ORIGINAL parameters, then rebinds `a`/`b` fresh
// each of the two iterations — a plain `for (const [a, b] of [[a, b], [b, a]])` in JS
// hits a `ReferenceError` (the loop variables' TDZ covers the head's own iterable
// expression), so the loop variables are named `x`/`y` here instead, aliasing upstream's
// per-iteration `a`/`b` exactly without JS's self-reference trap.
//
// `exp.cast`'s `to` parameter already accepts either a bare `DType` enum member or a
// real `DataType` node (`DataType.build` handles both) — `_coerce_date`'s `target_type`
// upstream is genuinely one-or-the-other across the two ternary branches (`b_type`, a
// bare `DType`, or `a_type`, a `DataType` node), reproduced as-is rather than normalized,
// matching upstream's own inconsistency; `target_type != a_type` (py:212) is ported as
// `target_type !== a_type` (reference inequality), which reproduces Python's `!=` here
// exactly: when the ternary chose `a_type` literally, `target_type` IS that same object
// (true shortcut on both sides); when it chose `b_type`, a frozen `DType` singleton is
// never reference-equal to a `DataType` AST node (true mismatch on both sides, since
// Python's default `__eq__` also requires `type(self) is type(other)`).
// @ported-ranges sqlglot/optimizer/canonicalize.py 1-258

import * as exp from "../expressions/index.js";
import { isDateUnit, isIsoDate, isIsoDatetime } from "../helper.js";
import { getAnnotateTypesRef, getDialectResolver } from "../tokens.js";

// py: `Dialect.get_or_raise(dialect)` — see the module header's circular-import note.
// `getDialectResolver()` returns null only if no dialect module has been imported
// anywhere yet (impossible in this port's own real call sites, which all go through
// `index.js` or an individual `dialects/*.js`); the fallback below mirrors the one real
// case that still needs no registry at all, `Dialect.get_or_raise(null)`'s base-class
// defaults (`dialects/dialect.js:1783` `PROMOTE_TO_INFERRED_DATETIME_TYPE = false`).
function _get_or_raise_dialect(dialect) {
  const resolver = getDialectResolver();
  if (resolver) return resolver(dialect);
  if (dialect === null || dialect === undefined || dialect === "") {
    return { PROMOTE_TO_INFERRED_DATETIME_TYPE: false };
  }
  throw new Error(
    `canonicalize: cannot resolve dialect ${JSON.stringify(dialect)} — no dialect module ` +
      "has been imported yet (import dialects/dialect.js or any dialects/*.js first).",
  );
}

// See the module header: `optimizer/annotate_types.js` pushes its own exports into
// `tokens.js`'s relay once it finishes loading, instead of this file pulling them via
// a top-level import.
function _getAnnotateTypesModule() {
  const ref = getAnnotateTypesRef();
  if (!ref) {
    throw new Error(
      "canonicalize: annotate_types not loaded yet — import optimizer/annotate_types.js first.",
    );
  }
  return ref;
}

/**
 * py: optimizer/canonicalize.py:12 `canonicalize(expression, dialect=None)`
 *
 * Converts a sql expression into a standard form.
 *
 * This method relies on annotate_types because many of the conversions rely on type
 * inference.
 *
 * @param {exp.Expr} expression The expression to canonicalize.
 * @param {{ dialect?: * }} [options]
 * @returns {exp.Expr}
 */
export function canonicalize(expression, options = {}) {
  const { dialect = null } = options;

  // py:22 `_dialect = Dialect.get_or_raise(dialect)`.
  const _dialect = _get_or_raise_dialect(dialect);

  function _canonicalize(expr) {
    if (!_CANONICALIZE_TYPES.some((T) => expr instanceof T)) return expr;
    expr = add_text_to_concat(expr);
    expr = replace_date_funcs(expr, { dialect: _dialect });
    expr = coerce_type(expr, _dialect.PROMOTE_TO_INFERRED_DATETIME_TYPE);
    expr = remove_redundant_casts(expr);
    expr = ensure_bools(expr, _replace_int_predicate);
    expr = remove_ascending_order(expr);
    return expr;
  }

  return exp.replaceTree(expression, _canonicalize);
}

// py:38-49 `COERCIBLE_DATE_OPS`.
export const COERCIBLE_DATE_OPS = [
  exp.Add,
  exp.Sub,
  exp.EQ,
  exp.NEQ,
  exp.GT,
  exp.GTE,
  exp.LT,
  exp.LTE,
  exp.NullSafeEQ,
  exp.NullSafeNEQ,
];

// py:52-80 `_CANONICALIZE_TYPES` — all expression types any canonicalize function can
// act on. Upstream builds this as a deduplicating `set` then freezes it to a `tuple`;
// a plain JS array works identically here since it is only ever used for `instanceof`
// membership tests, never iterated for order.
const _CANONICALIZE_TYPES = [
  // add_text_to_concat
  exp.Add,
  // replace_date_funcs
  exp.Date,
  exp.TsOrDsToDate,
  exp.Timestamp,
  // coerce_type (COERCIBLE_DATE_OPS + Between, Extract, DateAdd, DateSub, DateTrunc, DateDiff)
  ...COERCIBLE_DATE_OPS,
  exp.Between,
  exp.Extract,
  exp.DateAdd,
  exp.DateSub,
  exp.DateTrunc,
  exp.DateDiff,
  // remove_redundant_casts
  exp.Cast,
  // ensure_bools (Connector, Not, If, Where, Having)
  exp.Connector,
  exp.Not,
  exp.If,
  exp.Where,
  exp.Having,
  // remove_ascending_order
  exp.Ordered,
];

/** py: optimizer/canonicalize.py:83 `add_text_to_concat(node)` */
export function add_text_to_concat(node) {
  if (node instanceof exp.Add && node.type && exp.DataType.TEXT_TYPES.has(node.type.this)) {
    node = new exp.Concat({
      expressions: [node.left, node.right],
      // All known dialects, i.e. Redshift and T-SQL, that support
      // concatenating strings with the + operator do not coalesce NULLs.
      coalesce: false,
    });
  }
  return node;
}

/** py: optimizer/canonicalize.py:94 `replace_date_funcs(node, dialect)` */
export function replace_date_funcs(node, options = {}) {
  const { dialect = null } = options;

  if (
    (node instanceof exp.Date || node instanceof exp.TsOrDsToDate)
    && !node.expressions.length
    && !node.args.zone
    && node.this.is_string
    && isIsoDate(node.this.name)
  ) {
    return exp.cast(node.this, exp.DType.DATE);
  }
  if (node instanceof exp.Timestamp && !node.args.zone) {
    if (!node.type) {
      node = _getAnnotateTypesModule().annotate_types(node, { dialect });
    }
    return exp.cast(node.this, node.type || exp.DType.TIMESTAMP);
  }

  return node;
}

/** py: optimizer/canonicalize.py:113 `coerce_type(node, promote_to_inferred_datetime_type)` */
export function coerce_type(node, promote_to_inferred_datetime_type) {
  if (COERCIBLE_DATE_OPS.some((K) => node instanceof K)) {
    _coerce_date(node.left, node.right, promote_to_inferred_datetime_type);
  } else if (node instanceof exp.Between) {
    _coerce_date(node.this, node.args.low, promote_to_inferred_datetime_type);
  } else if (
    node instanceof exp.Extract
    && !node.expression.isType(...exp.DataType.TEMPORAL_TYPES)
  ) {
    _replace_cast(node.expression, exp.DType.DATETIME);
  } else if (node instanceof exp.DateAdd || node instanceof exp.DateSub || node instanceof exp.DateTrunc) {
    _coerce_timeunit_arg(node.this, node.unit);
  } else if (node instanceof exp.DateDiff) {
    _coerce_datediff_args(node);
  }

  return node;
}

/** py: optimizer/canonicalize.py:130 `remove_redundant_casts(expression)` */
export function remove_redundant_casts(expression) {
  if (
    expression instanceof exp.Cast
    && expression.this.type
    && expression.to.equals(expression.this.type)
  ) {
    return expression.this;
  }

  if (
    (expression instanceof exp.Date || expression instanceof exp.TsOrDsToDate)
    && expression.this.type
    && expression.this.type.this === exp.DType.DATE
    && !expression.this.type.expressions.length
  ) {
    return expression.this;
  }

  return expression;
}

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

/** py: optimizer/canonicalize.py:166 `remove_ascending_order(expression)` */
export function remove_ascending_order(expression) {
  if (expression instanceof exp.Ordered && expression.args.desc === false) {
    // Convert ORDER BY a ASC to ORDER BY a
    expression.set("desc", null);
  }

  return expression;
}

/** py: optimizer/canonicalize.py:174 `_coerce_date(a, b, promote_to_inferred_datetime_type)` */
function _coerce_date(a, b, promote_to_inferred_datetime_type) {
  // py:179 `for a, b in itertools.permutations([a, b]):` — see the module header's
  // note on why the loop variables are `x`/`y` rather than shadowing `a`/`b`.
  for (let [x, y] of [[a, b], [b, a]]) {
    if (y instanceof exp.Interval) {
      x = _coerce_timeunit_arg(x, y.unit);
    }

    const x_type = x.type;
    if (
      !x_type
      || !exp.DataType.TEMPORAL_TYPES.has(x_type.this)
      || !y.type
      || !exp.DataType.TEXT_TYPES.has(y.type.this)
    ) {
      continue;
    }

    let target_type;
    if (promote_to_inferred_datetime_type) {
      let y_type;
      if (y.is_string) {
        const date_text = y.name;
        if (isIsoDate(date_text)) {
          y_type = exp.DType.DATE;
        } else if (isIsoDatetime(date_text)) {
          y_type = exp.DType.DATETIME;
        } else {
          y_type = x_type.this;
        }
      } else {
        // If y is not a datetime string, we conservatively promote it to a DATETIME,
        // in order to ensure there are no surprising truncations due to downcasting
        y_type = exp.DType.DATETIME;
      }

      const coercesTo = _getAnnotateTypesModule().TypeAnnotator.COERCES_TO.get(x_type.this);
      target_type = coercesTo?.has(y_type) ? y_type : x_type;
    } else {
      target_type = x_type;
    }

    if (target_type !== x_type) {
      _replace_cast(x, target_type);
    }

    _replace_cast(y, target_type);
  }
}

/** py: optimizer/canonicalize.py:218 `_coerce_timeunit_arg(arg, unit)` */
function _coerce_timeunit_arg(arg, unit) {
  if (!arg.type) return arg;

  if (exp.DataType.TEXT_TYPES.has(arg.type.this)) {
    const date_text = arg.name;
    const is_iso_date_ = isIsoDate(date_text);

    if (is_iso_date_ && isDateUnit(unit)) {
      return arg.replace(exp.cast(arg.copy(), exp.DType.DATE));
    }

    // An ISO date is also an ISO datetime, but not vice versa
    if (is_iso_date_ || isIsoDatetime(date_text)) {
      return arg.replace(exp.cast(arg.copy(), exp.DType.DATETIME));
    }
  } else if (arg.type.this === exp.DType.DATE && !isDateUnit(unit)) {
    return arg.replace(exp.cast(arg.copy(), exp.DType.DATETIME));
  }

  return arg;
}

/** py: optimizer/canonicalize.py:239 `_coerce_datediff_args(node)` */
function _coerce_datediff_args(node) {
  for (const e of [node.this, node.expression]) {
    if (!e.type || !exp.DataType.TEMPORAL_TYPES.has(e.type.this)) {
      e.replace(exp.cast(e.copy(), exp.DType.DATETIME));
    }
  }
}

/** py: optimizer/canonicalize.py:245 `_replace_cast(node, to)` */
function _replace_cast(node, to) {
  node.replace(exp.cast(node.copy(), to));
}

// this was originally designed for presto, there is a similar transform for tsql
// this is different in that it only operates on int types, this is because
// presto has a boolean type whereas tsql doesn't (people use bits)
// with y as (select true as x) select x = 0 FROM y -- illegal presto query
//
// py: optimizer/canonicalize.py:253 `_replace_int_predicate(expression)`
function _replace_int_predicate(expression) {
  if (expression instanceof exp.Coalesce) {
    for (const child of expression.iterExpressions()) {
      _replace_int_predicate(child);
    }
  } else if (expression.type && exp.DataType.INTEGER_TYPES.has(expression.type.this)) {
    expression.replace(expression.neq(0));
  }
}
