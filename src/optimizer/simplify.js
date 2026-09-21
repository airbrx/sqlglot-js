// py: sqlglot/optimizer/simplify.py @ 91119bc — WHOLE FILE (1,880 LOC).
//
// Originally scoped as three separate issues (boolean algebra / arithmetic+date /
// range-merging+Simplifier+flatten), but the real file is one 1,880-LOC module built
// around a single `Simplifier` class whose own `_simplify` dispatcher chains almost
// every other method in sequence — a partial port would leave the dispatcher calling
// `NotPorted` stubs mid-pipeline and unable to run end to end. Ported whole in one
// session instead, the same judgment call `optimizer/annotate_types.js` made for an
// analogous reason (R54), and consistent with how full-dialect sessions in this
// project (TSQL, BigQuery) have handled similarly-sized, tightly-coupled units.
//
// Four deliberate, documented departures from a line-for-line transliteration:
//
// 1. `Simplifier`'s upstream `t.ClassVar` tables (`COMPLEMENT_COMPARISONS`,
//    `COMPARISONS`, `INVERSE_OPS`, `JOINS`, ...) are hoisted to MODULE-level `const`s
//    rather than `static` class fields. `Simplifier` is never subclassed anywhere in
//    this codebase, so there is no dialect-style override use case for them, and a
//    `static` field read via a bare `this.X` inside an instance method is `undefined`
//    in JS (generated classes' statics are not on the instance prototype chain — the
//    same hazard PORT_PLAN.md's `js-static-fields-need-this-constructor` note already
//    tracks). Reading a module-level `const` directly by name sidesteps the whole
//    hazard class instead of remembering `this.constructor.X` at every call site.
//
// 2. `Binary.left`/`.right`, `TimeUnit.unit` and `IntervalOp.interval()` — three real
//    upstream properties/methods this file is the FIRST caller of in this port — are
//    installed in `expressions/query_methods.js`'s `installQueryMethods`, not here.
//    Generated expression classes do not form a real JS inheritance chain (that file's
//    own module comment explains why), so a getter/method defined on the `Binary`/
//    `TimeUnit`/`IntervalOp` TRAIT class itself is never reached by a concrete
//    subclass like `Add`/`DateTrunc`/`DateAdd` — it has to be installed on every class
//    whose `bases` names the trait, the same pattern that file already uses for
//    `Binary.left`/`.right` (added there, not duplicated here).
//
// 3. `dateutil.relativedelta.relativedelta` — a real runtime dependency upstream, not
//    a type-only import — is ported as `PyRelativedelta` in `_py/datetime.js`, scoped
//    to the RELATIVE fields `interval()` (below) ever constructs with (years/months/
//    days/hours/minutes/seconds/microseconds; no absolute year=/month=/.../weekday=/
//    leapdays=/yearday= overrides). `PyDate`/`PyDateTime` (also new in that file) are
//    this port's stand-in for Python's `date`/`datetime` VALUES (not just the ISO
//    string parsing `_py/datetime.js` already had) — a proleptic-Gregorian ordinal
//    representation, verified scenario-by-scenario against the pinned CPython's real
//    `dateutil.relativedelta.relativedelta`, including the month-end clamp (Jan 31 + 1
//    month -> Feb 28/29, not an overflow into March).
//
// 4. `sqlglot.optimizer.normalize.normalized` — `propagate_constants` (below) needs
//    exactly this ONE function from a different, larger upstream module
//    (`optimizer/normalize.py`) that itself imports `Simplifier`/`flatten` FROM this
//    file, which would be a real import cycle if `normalize.js` existed yet and this
//    file imported it back. `normalized()` (py:70-91) has no dependency on the rest of
//    that module (only `exp` and the already-ported `find_all_in_scope`), so it is
//    ported here as a small local function instead, narrowly, with a note for whoever
//    ports `optimizer/normalize.js` for real later to re-point this file at that
//    module's copy rather than keep two.
//
// Python's `id(x)`-keyed containers become plain JS `Set`/`Map` (object-reference
// equality already matches `id()`); Python's `__eq__`/`__hash__`-keyed containers
// (`set(expression.flatten())`, `frozenset((a, b))` as a dict key) become
// `_py/collections.js`'s `ExprSet`/`ExprMap`/`frozensetKey`, this port's established
// structural-equality containers — `Expression.__eq__` (core.py:836) is itself
// content-based (`hash(self) == hash(other)`), not identity, so a native JS `Set`
// would silently under-dedupe two syntactically-identical-but-distinct subtrees.

import * as exp from "../expressions/index.js";
import { Dialect, WEEK_START_DAY_TO_DOW, week_offset_to_dow } from "../dialects/dialect.js";
import { TypeAnnotator } from "./annotate_types.js";
import { ensureSchema } from "../schema.js";
import { findAllInScope, walkInScope } from "./scope.js";
import { first, mergeRanges, whileChanging } from "../helper.js";
import { ExprSet, ExprMap, frozensetKey } from "../_py/collections.js";
import { PyDate, PyDateTime, pyDateTimeFromIsoFormat, PyRelativedelta } from "../_py/datetime.js";
import { PyDecimal, decAdd, decSub, decMul, decDiv, decCmp } from "../_py/num.js";
import { pyStrCmp } from "../_py/sort.js";

// py: simplify.py:33 `FINAL = "final"` — expression should not be simplified further.
export const FINAL = "final";

// py: simplify.py:35-41 `SIMPLIFIABLE`.
const SIMPLIFIABLE = [exp.Binary, exp.Func, exp.Lambda, exp.Predicate, exp.Unary];

/**
 * py: simplify.py:44 `simplify(expression, constant_propagation=False,
 * coalesce_simplification=False, dialect=None)`.
 *
 * Rewrite sqlglot AST to simplify expressions.
 *
 * Example:
 *   simplify(parseOne("TRUE AND TRUE")).sql() -> 'TRUE'
 */
export function simplify(expression, options = {}) {
  const {
    constant_propagation = false,
    coalesce_simplification = false,
    dialect = null,
  } = options;
  return new Simplifier(dialect).simplify(expression, constant_propagation, coalesce_simplification);
}

// py: simplify.py:75 `class UnsupportedUnit(Exception)`.
export class UnsupportedUnit extends Error {}

/**
 * py: simplify.py:79 `catch(*exceptions)` — decorator that ignores a simplification
 * function if any of `exceptions` are raised.
 */
function catchDecorator(...exceptionClasses) {
  return function decorator(func) {
    return function wrapped(expression, ...args) {
      try {
        return func.call(this, expression, ...args);
      } catch (e) {
        if (exceptionClasses.some((E) => e instanceof E)) return expression;
        throw e;
      }
    };
  };
}

/** py: simplify.py:94 `annotate_types_on_change(func)`. */
function annotateTypesOnChange(func) {
  return function wrapped(expression, ...args) {
    let newExpression = func.call(this, expression, ...args);

    if (newExpression === null || newExpression === undefined) {
      return newExpression;
    }

    if (this.annotate_new_expressions && !expression.equals(newExpression)) {
      this._annotator.clear();

      // We annotate this to ensure new children nodes are also annotated
      newExpression = this._annotator.annotate(newExpression, false);

      // Whatever expression the original expression is transformed into needs to
      // preserve the original type, otherwise the simplification could result in a
      // different schema.
      newExpression.type = expression.type;
    }

    return newExpression;
  };
}

/**
 * py: simplify.py:120 `flatten(expression)`.
 *
 * A AND (B AND C) -> A AND B AND C
 * A OR (B OR C) -> A OR B OR C
 */
export function flatten(expression) {
  if (expression instanceof exp.Connector) {
    for (const node of Object.values(expression.args)) {
      if (!(node instanceof exp.Expr)) continue;
      const child = node.unnest();
      if (child.constructor === expression.constructor) node.replace(child);
    }
  }
  return expression;
}

/** py: simplify.py:133 `simplify_parens(expression, dialect)`. */
export function simplify_parens(expression, dialect) {
  if (!(expression instanceof exp.Paren)) return expression;

  const this_ = expression.this;
  const parent = expression.parent;
  const parentIsPredicate = parent instanceof exp.Predicate;

  if (this_ instanceof exp.Select) return expression;

  if (parent instanceof exp.SubqueryPredicate || parent instanceof exp.Bracket) return expression;

  if (
    Dialect.get_or_raise(dialect).REQUIRES_PARENTHESIZED_STRUCT_ACCESS
    && parent instanceof exp.Dot
    && (parent.right instanceof exp.Identifier || parent.right instanceof exp.Star)
  ) {
    return expression;
  }

  if (
    this_ instanceof exp.Predicate
    && !(
      parentIsPredicate
      // unary operators that bind tighter than the predicate, unlike NOT
      || parent instanceof exp.Neg
      || parent instanceof exp.BitwiseNot
      || (parent instanceof exp.Binary && !(parent instanceof exp.Connector))
    )
  ) {
    return this_;
  }

  if (
    !(parent instanceof exp.Condition || parent instanceof exp.Binary)
    || parent instanceof exp.Paren
    || (
      !(this_ instanceof exp.Binary)
      && !((this_ instanceof exp.Not || this_ instanceof exp.Is) && parentIsPredicate)
    )
    || (this_ instanceof exp.Add && parent instanceof exp.Add)
    || (this_ instanceof exp.Mul && parent instanceof exp.Mul)
    || (this_ instanceof exp.Mul && (parent instanceof exp.Add || parent instanceof exp.Sub))
  ) {
    return this_;
  }

  return expression;
}

/**
 * py: optimizer/normalize.py:70 `normalized(expression, dnf=False)` — ported here,
 * narrowly, rather than imported from `optimizer/normalize.js` (see module header
 * note 4): it has no dependency on the rest of that upstream module, which itself
 * imports `Simplifier`/`flatten` FROM this file.
 */
function normalized(expression, dnf = false) {
  const [ancestor, root] = dnf ? [exp.And, exp.Or] : [exp.Or, exp.And];
  for (const connector of findAllInScope(expression, root)) {
    if (connector.findAncestor(ancestor)) return false;
  }
  return true;
}

/**
 * py: simplify.py:180 `propagate_constants(expression, root=True)`.
 *
 * Propagate constants for conjunctions in DNF:
 *
 * SELECT * FROM t WHERE a = b AND b = 5 becomes
 * SELECT * FROM t WHERE a = 5 AND b = 5
 *
 * Reference: https://www.sqlite.org/optoverview.html
 */
export function propagate_constants(expression, root = true) {
  if (
    expression instanceof exp.And
    && (root || !expression.sameParent)
    && normalized(expression, true)
  ) {
    // py: `constant_mapping = {}` — structurally (`__eq__`/`__hash__`) keyed, so an
    // `ExprMap`, not a plain `Map`. The stored `id(l)` becomes the actual node
    // reference `l` itself: JS `!==` on object references is exactly what `id(column)
    // != column_id` tests.
    const constantMapping = new ExprMap();
    for (const expr of walkInScope(expression, (node) => node instanceof exp.If)) {
      if (expr instanceof exp.EQ) {
        const l = expr.left, r = expr.right;
        // TODO: create a helper that can be used to detect nested literal expressions
        // such as CAST(123456 AS BIGINT), since we usually want to treat those as
        // literals too.
        if (l instanceof exp.Column && r instanceof exp.Literal) {
          constantMapping.set(l, [l, r]);
        }
      }
    }

    if (constantMapping.size) {
      for (const column of findAllInScope(expression, exp.Column)) {
        const parent = column.parent;
        const entry = constantMapping.get(column);
        const [columnId, constant] = entry ?? [null, null];
        if (
          columnId !== null
          && column !== columnId
          && !(parent instanceof exp.Is && parent.expression instanceof exp.Null)
        ) {
          column.replace(constant.copy());
        }
      }
    }
  }

  return expression;
}

/** py: simplify.py:219 `_is_number(expression)`. */
function _is_number(expression) {
  return expression.isNumber;
}

/** py: simplify.py:223 `_is_interval(expression)`. */
function _is_interval(expression) {
  return expression instanceof exp.Interval && extract_interval(expression) !== null;
}

/** py: simplify.py:227 `_is_nonnull_constant(expression)`. */
function _is_nonnull_constant(expression) {
  return exp.NONNULL_CONSTANTS.some((K) => expression instanceof K) || _is_date_literal(expression);
}

/** py: simplify.py:231 `_is_constant(expression)`. */
function _is_constant(expression) {
  const expr = expression instanceof exp.Neg ? expression.this : expression;
  return exp.CONSTANTS.some((K) => expr instanceof K) || _is_date_literal(expr);
}

/**
 * py: simplify.py:236 `_datetrunc_range(date, unit, dialect)`.
 *
 * Get the date range for a DATE_TRUNC equality comparison.
 *
 * Example:
 *   _datetrunc_range(date(2021,1,1), 'year') == [date(2021,1,1), date(2022,1,1)]
 * Returns:
 *   [min, max) or null if a value can never be equal to `date` for `unit`.
 */
function _datetrunc_range(date, unit, dialect) {
  const floor = datetime_floor(date, unit, dialect);

  if (!date.equals(floor)) {
    // This will always be False, except for NULL values.
    return null;
  }

  return [floor, interval(unit).addToDate(floor)];
}

/** py: simplify.py:254 `_datetrunc_eq_expression(left, drange, target_type)`. */
function _datetrunc_eq_expression(left, drange, targetType) {
  // deny:operators sqlglot/optimizer/simplify.py:259 — `left >= ...` builds a GTE node
  // (`Condition.__ge__`), ported as the equivalent `.gte()` builder method.
  // deny:operators sqlglot/optimizer/simplify.py:260 — same, `left < ...` -> `.lt()`.
  return exp.and_(
    left.gte(date_literal(drange[0], targetType)),
    left.lt(date_literal(drange[1], targetType)),
    { copy: false },
  );
}

/** py: simplify.py:265 `_datetrunc_eq(left, date, unit, dialect, target_type)`. */
function _datetrunc_eq(left, date, unit, dialect, targetType) {
  const drange = _datetrunc_range(date, unit, dialect);
  if (!drange) return null;

  return _datetrunc_eq_expression(left, drange, targetType);
}

/** py: simplify.py:279 `_datetrunc_neq(left, date, unit, dialect, target_type)`. */
function _datetrunc_neq(left, date, unit, dialect, targetType) {
  const drange = _datetrunc_range(date, unit, dialect);
  if (!drange) return null;

  // deny:operators sqlglot/optimizer/simplify.py:291 — `left < ...` -> `.lt()`.
  // deny:operators sqlglot/optimizer/simplify.py:292 — `left >= ...` -> `.gte()`.
  return exp.or_(
    left.lt(date_literal(drange[0], targetType)),
    left.gte(date_literal(drange[1], targetType)),
    { copy: false },
  );
}

/**
 * py: simplify.py:297 `_parenthesize_nested_connector(expression, parent)`.
 *
 * The generator flattens nested connectors and relies on Paren nodes for grouping.
 * Operator precedence varies across dialects, so wrap unless the parent is the same
 * connector type, in which case flattening is safe by associativity.
 */
function _parenthesize_nested_connector(expression, parent) {
  if (
    expression instanceof exp.Connector
    && (parent instanceof exp.Not || (parent instanceof exp.Connector && parent.constructor !== expression.constructor))
  ) {
    return exp.paren(expression, false);
  }

  return expression;
}

/** py: simplify.py:312 `always_true(expression)`. */
export function always_true(expression) {
  return (expression instanceof exp.Boolean && !!expression.this)
    || (expression instanceof exp.Literal && expression.isNumber && !is_zero(expression));
}

/** py: simplify.py:318 `always_false(expression)`. */
export function always_false(expression) {
  return is_false(expression) || is_null(expression) || is_zero(expression);
}

/** py: simplify.py:322 `is_zero(expression)`. */
export function is_zero(expression) {
  return expression instanceof exp.Literal && expression.toPy() === 0n;
}

/** py: simplify.py:326 `is_complement(a, b)`. */
export function is_complement(a, b) {
  return b instanceof exp.Not && b.this.equals(a);
}

/** py: simplify.py:330 `is_false(a)`. */
export function is_false(a) {
  return a.constructor === exp.Boolean && !a.this;
}

/** py: simplify.py:334 `is_null(a)`. */
export function is_null(a) {
  return a.constructor === exp.Null;
}

// py: simplify.py:338 `class SupportsComparison(t.Protocol)` — a type-only protocol
// with no runtime behaviour, dropped like every other TYPE_CHECKING-only construct
// this port drops elsewhere.

/** py: simplify.py:347 `eval_boolean(expression, a, b)`. */
function eval_boolean(expression, a, b) {
  if (expression instanceof exp.EQ || expression instanceof exp.Is) {
    if (expression instanceof exp.Is && expression.args.negate) return boolean_literal(pyLikeCmp(a, b) !== 0);
    return boolean_literal(pyLikeCmp(a, b) === 0);
  }
  if (expression instanceof exp.NEQ) return boolean_literal(pyLikeCmp(a, b) !== 0);
  if (expression instanceof exp.GT) return boolean_literal(pyLikeCmp(a, b) > 0);
  if (expression instanceof exp.GTE) return boolean_literal(pyLikeCmp(a, b) >= 0);
  if (expression instanceof exp.LT) return boolean_literal(pyLikeCmp(a, b) < 0);
  if (expression instanceof exp.LTE) return boolean_literal(pyLikeCmp(a, b) <= 0);
  return null;
}

// Not upstream: a shared comparator for the number/string/date value kinds
// `eval_boolean`/`_simplify_comparison` actually compare, standing in for Python's
// polymorphic `<`/`<=`/`==`/`>=`/`>` on those same value kinds. `Literal.to_py()`
// (`expressions/core.js`) returns a BigInt for an int literal or a `PyDecimal` for a
// float one — never a plain JS `number` — so `decCmp` (which coerces BigInt args
// itself) covers both alone without a separate BigInt-BigInt fast path.
function _numericLike(v) {
  return typeof v === "bigint" || v instanceof PyDecimal;
}
function pyLikeCmp(a, b) {
  if (_numericLike(a) && _numericLike(b)) return decCmp(a, b);
  if (typeof a === "string" && typeof b === "string") return pyStrCmp(a, b);
  if (a instanceof PyDate && b instanceof PyDate) {
    if (a.constructor !== b.constructor) {
      throw new TypeError(`'<' not supported between instances of '${a.constructor.name}' and '${b.constructor.name}'`);
    }
    return a.compareKey < b.compareKey ? -1 : a.compareKey > b.compareKey ? 1 : 0;
  }
  throw new TypeError(`'<' not supported between instances of '${typeof a}' and '${typeof b}'`);
}

/** py: simplify.py:367 `cast_as_date(value)`. */
function cast_as_date(value) {
  if (value instanceof PyDateTime) return value.date();
  if (value instanceof PyDate) return value;
  try {
    const { year, month, day } = pyDateTimeFromIsoFormat(value);
    return new PyDate(year, month, day);
  } catch {
    return null;
  }
}

/** py: simplify.py:378 `cast_as_datetime(value)`. */
function cast_as_datetime(value) {
  if (value instanceof PyDateTime) return value;
  if (value instanceof PyDate) return new PyDateTime(value.year, value.month, value.day);
  try {
    const { year, month, day, hour, minute, second, microsecond } = pyDateTimeFromIsoFormat(value);
    return new PyDateTime(year, month, day, hour, minute, second, microsecond);
  } catch {
    return null;
  }
}

/** py: simplify.py:391 `cast_value(value, to)`. */
function cast_value(value, to) {
  if (!value) return null;
  if (to.isType(exp.DType.DATE)) return cast_as_date(value);
  if (to.isType(...exp.DataType.TEMPORAL_TYPES)) return cast_as_datetime(value);
  return null;
}

/** py: simplify.py:401 `extract_date(cast)`. */
function extract_date(cast) {
  let to;
  if (cast instanceof exp.Cast) {
    to = cast.to;
  } else if (cast instanceof exp.TsOrDsToDate && !cast.args.format) {
    to = exp.DType.DATE.intoExpr();
  } else {
    return null;
  }

  let value;
  if (cast.this instanceof exp.Literal) {
    value = cast.this.name;
  } else if (cast.this instanceof exp.Cast || cast.this instanceof exp.TsOrDsToDate) {
    value = extract_date(cast.this);
  } else {
    return null;
  }
  return cast_value(value, to);
}

/** py: simplify.py:418 `_is_date_literal(expression)`. */
function _is_date_literal(expression) {
  return extract_date(expression) !== null;
}

/** py: simplify.py:422 `extract_interval(expression)`. */
function extract_interval(expression) {
  try {
    const n = Number(expression.this.toPy());
    const unit = expression.text("unit").toLowerCase();
    return interval(unit, n);
  } catch (e) {
    if (e instanceof UnsupportedUnit) return null;
    throw e;
  }
}

/** py: simplify.py:431 `extract_type(*expressions)`. */
function extract_type(...expressions) {
  let targetType = null;
  for (const expression of expressions) {
    targetType = expression instanceof exp.Cast ? expression.to : expression.type;
    if (targetType) break;
  }

  return targetType;
}

/** py: simplify.py:441 `date_literal(date, target_type=None)`. */
function date_literal(date, targetType = null) {
  if (!targetType || !targetType.isType(...exp.DataType.TEMPORAL_TYPES)) {
    targetType = date instanceof PyDateTime ? exp.DType.DATETIME : exp.DType.DATE;
  }

  return exp.cast(exp.Literal.string(date instanceof PyDateTime ? date.toISODateTime() : date.toISODate()), targetType);
}

/** py: simplify.py:448 `interval(unit, n=1)`. */
function interval(unit, n = 1) {
  if (unit === "year") return new PyRelativedelta({ years: 1 * n });
  if (unit === "quarter") return new PyRelativedelta({ months: 3 * n });
  if (unit === "month") return new PyRelativedelta({ months: 1 * n });
  if (unit === "week") return new PyRelativedelta({ days: 7 * n });
  if (unit === "day") return new PyRelativedelta({ days: 1 * n });
  if (unit === "hour") return new PyRelativedelta({ hours: 1 * n });
  if (unit === "minute") return new PyRelativedelta({ minutes: 1 * n });
  if (unit === "second") return new PyRelativedelta({ seconds: 1 * n });
  if (unit === "millisecond") return new PyRelativedelta({ microseconds: 1000 * n });
  if (unit === "microsecond") return new PyRelativedelta({ microseconds: 1 * n });

  throw new UnsupportedUnit(`Unsupported unit: ${unit}`);
}

/** py: simplify.py:475 `datetime_floor(d, unit, dialect)`. */
function datetime_floor(d, unit, dialect) {
  // Truncate sub-day units — only valid for datetime inputs
  if (d instanceof PyDateTime) {
    if (unit === "hour") return d.replace({ minute: 0, second: 0, microsecond: 0 });
    if (unit === "minute") return d.replace({ second: 0, microsecond: 0 });
    if (unit === "second") return d.replace({ microsecond: 0 });
    if (unit === "millisecond") return d.replace({ microsecond: Math.floor(d.microsecond / 1000) * 1000 });
    if (unit === "microsecond") return d;
  }

  // Truncate date-level units, shared for both date and datetime
  let result;
  if (unit === "year") {
    result = d.replace({ month: 1, day: 1 });
  } else if (unit === "quarter") {
    if (d.month <= 3) result = d.replace({ month: 1, day: 1 });
    else if (d.month <= 6) result = d.replace({ month: 4, day: 1 });
    else if (d.month <= 9) result = d.replace({ month: 7, day: 1 });
    else result = d.replace({ month: 10, day: 1 });
  } else if (unit === "month") {
    result = d.replace({ month: d.month, day: 1 });
  } else if (unit === "week") {
    // Week truncation respects dialect.WEEK_OFFSET (0=Monday, -1=Sunday)
    result = d.addDays(-(((d.weekday() - dialect.WEEK_OFFSET) % 7 + 7) % 7));
  } else if (unit === "day") {
    result = d;
  } else {
    throw new UnsupportedUnit(`Unsupported unit: ${unit}`);
  }

  // For datetime inputs, zero out the time component after date-level truncation
  if (result instanceof PyDateTime) {
    return result.replace({ hour: 0, minute: 0, second: 0, microsecond: 0 });
  }
  return result;
}

/** py: simplify.py:517 `_trunc_unit(unit, dialect)`. */
function _trunc_unit(unit, dialect) {
  if (unit instanceof exp.WeekStart) {
    if (WEEK_START_DAY_TO_DOW.get(unit.name.toUpperCase()) !== week_offset_to_dow(dialect.WEEK_OFFSET)) {
      // deny:implicit_str sqlglot/optimizer/simplify.py:522 — `unit` is an Expr here
      // (a WeekStart node), so `str(unit)` (py) needs `.sql()`, not template-literal
      // interpolation (which calls this port's verbose `.toString()` repr, R21).
      throw new UnsupportedUnit(`Unsupported unit: ${unit.sql()}`);
    }
    return "week";
  }

  return unit.name.toLowerCase();
}

/** py: simplify.py:528 `date_ceil(d, unit, dialect)`. */
function date_ceil(d, unit, dialect) {
  const floor = datetime_floor(d, unit, dialect);

  if (floor.equals(d)) return d;

  return interval(unit).addToDate(floor);
}

/** py: simplify.py:537 `boolean_literal(condition)`. */
function boolean_literal(condition) {
  return condition ? exp.true_() : exp.false_();
}

// Not upstream: a `defaultdict(list)`-shaped get-or-create for the `ExprMap`
// (structurally-keyed) `subops` table `absorb_and_eliminate` builds below.
function pushToExprMap(map, key, value) {
  let list = map.get(key);
  if (!list) { list = []; map.set(key, list); }
  list.push(value);
  return list;
}
// Same shape, plain-`Map` (string-keyed) version for the `pairs` table below.
function pushToMap(map, key, value) {
  let list = map.get(key);
  if (!list) { list = []; map.set(key, list); }
  list.push(value);
  return list;
}

// py: simplify.py:556-640 — the `Simplifier` class's own `t.ClassVar` tables, hoisted
// to module scope (module header note 1).

// Value ranges for byte-sized signed/unsigned integers
const TINYINT_MIN = -128;
const TINYINT_MAX = 127;
const UTINYINT_MIN = 0;
const UTINYINT_MAX = 255;

const COMPLEMENT_COMPARISONS = new Map([
  [exp.LT, exp.GTE],
  [exp.GT, exp.LTE],
  [exp.LTE, exp.GT],
  [exp.GTE, exp.LT],
  [exp.EQ, exp.NEQ],
  [exp.NEQ, exp.EQ],
]);

const COMPLEMENT_SUBQUERY_PREDICATES = new Map([
  [exp.All, exp.Any],
  [exp.Any, exp.All],
]);

const LT_LTE = [exp.LT, exp.LTE];
const GT_GTE = [exp.GT, exp.GTE];

const COMPARISONS = [...LT_LTE, ...GT_GTE, exp.EQ, exp.NEQ, exp.Is];

// Operand types that allow a connector pair to combine in _flat_simplify: constants
// (matched by the is_false/is_null/is_zero/always_true checks) and comparisons.
const CONNECTOR_COMBINABLE = [exp.Boolean, exp.Literal, exp.Null, ...COMPARISONS];

const INVERSE_COMPARISONS = new Map([
  [exp.LT, exp.GT],
  [exp.GT, exp.LT],
  [exp.LTE, exp.GTE],
  [exp.GTE, exp.LTE],
]);

const NONDETERMINISTIC = [exp.Rand, exp.Randn];
const AND_OR = [exp.And, exp.Or];

const INVERSE_DATE_OPS = new Map([
  [exp.DateAdd, exp.Sub],
  [exp.DateSub, exp.Add],
  [exp.DatetimeAdd, exp.Sub],
  [exp.DatetimeSub, exp.Add],
]);

const INVERSE_OPS = new Map([
  ...INVERSE_DATE_OPS,
  [exp.Add, exp.Sub],
  [exp.Sub, exp.Add],
]);

const NULL_OK = [exp.NullSafeEQ, exp.NullSafeNEQ, exp.PropertyEQ];

const CONCATS = [exp.Concat, exp.DPipe];

// deny:operators sqlglot/optimizer/simplify.py:614 — `l < date_literal(...)` -> `.lt()`.
// deny:operators sqlglot/optimizer/simplify.py:620 — `l >= date_literal(...)` -> `.gte()`.
// deny:operators sqlglot/optimizer/simplify.py:621 — `l < date_literal(...)` -> `.lt()`.
// deny:operators sqlglot/optimizer/simplify.py:622 — `l >= date_literal(...)` -> `.gte()`.
const DATETRUNC_BINARY_COMPARISONS = new Map([
  [exp.LT, (l, dt, u, d, t) => l.lt(date_literal(
    dt.equals(datetime_floor(dt, u, d)) ? dt : interval(u).addToDate(datetime_floor(dt, u, d)),
    t,
  ))],
  [exp.GT, (l, dt, u, d, t) => l.gte(date_literal(interval(u).addToDate(datetime_floor(dt, u, d)), t))],
  [exp.LTE, (l, dt, u, d, t) => l.lt(date_literal(interval(u).addToDate(datetime_floor(dt, u, d)), t))],
  [exp.GTE, (l, dt, u, d, t) => l.gte(date_literal(date_ceil(dt, u, d), t))],
  [exp.EQ, _datetrunc_eq],
  [exp.NEQ, _datetrunc_neq],
]);

const DATETRUNC_COMPARISONS = new Set([exp.In, ...DATETRUNC_BINARY_COMPARISONS.keys()]);
const DATETRUNCS = [exp.DateTrunc, exp.TimestampTrunc];

const SAFE_CONNECTOR_ELIMINATION_RESULT = [exp.Connector, exp.Boolean];

// CROSS joins result in an empty table if the right table is empty.
// So we can only simplify certain types of joins to CROSS.
// Or in other words, LEFT JOIN x ON TRUE != CROSS JOIN x
const JOINS = new Set(["|", "|INNER", "RIGHT|", "RIGHT|OUTER"]);

/** py: simplify.py:541 `class Simplifier`. */
export class Simplifier {
  // py:542-548 `__init__`.
  constructor(dialect = null, annotateNewExpressions = true) {
    this.dialect = Dialect.get_or_raise(dialect);
    this.annotate_new_expressions = annotateNewExpressions;

    this._annotator = new TypeAnnotator(ensureSchema(null, { dialect: this.dialect }), { overwriteTypes: false });
  }

  // py:642 `simplify(expression, constant_propagation=False, coalesce_simplification=False)`.
  simplify(expression, constant_propagation = false, coalesce_simplification = false) {
    const wheres = [];
    const joins = [];

    for (const node of expression.walk(true, (n) => (n instanceof exp.Condition) || !!n.metaGet(FINAL))) {
      if (node.metaGet(FINAL)) continue;

      // group by expressions cannot be simplified, for example
      // select x + 1 + 1 FROM y GROUP BY x + 1 + 1
      // the projection must exactly match the group by key
      const group = node.args.group;

      if (group && node.selects !== undefined) {
        const groups = new ExprSet(group.expressions);
        group.meta[FINAL] = true;

        for (const s of node.selects) {
          for (const n of s.walk()) {
            if (groups.has(n)) { s.meta[FINAL] = true; break; }
          }
        }

        const having = node.args.having;
        if (having) {
          for (const n of having.walk()) {
            if (groups.has(n)) { having.meta[FINAL] = true; break; }
          }
        }
      }

      if (node instanceof exp.Condition) {
        const simplified = whileChanging(node, (e) => this._simplify(e, constant_propagation, coalesce_simplification));

        if (node === expression) expression = simplified;
      } else if (node instanceof exp.Where) {
        wheres.push(node);
      } else if (node instanceof exp.Join) {
        // snowflake match_conditions have very strict ordering rules
        const match = node.args.match_condition;
        if (match) match.meta[FINAL] = true;

        joins.push(node);
      }
    }

    for (const where of wheres) {
      if (always_true(where.this)) where.pop();
    }
    for (const join of joins) {
      if (
        always_true(join.args.on)
        && !join.args.using
        && !join.args.method
        && JOINS.has(`${join.side}|${join.kind}`)
      ) {
        join.args.on.pop();
        join.set("side", null);
        join.set("kind", "CROSS");
      }
    }

    return expression;
  }

  // py:712 `_simplify(expression, constant_propagation, coalesce_simplification)`.
  _simplify(expression, constant_propagation, coalesce_simplification) {
    const preTransformationStack = [expression];
    const postTransformationStack = [];
    let node;

    while (preTransformationStack.length) {
      const original = preTransformationStack.pop();
      node = original;

      if (!SIMPLIFIABLE.some((K) => node instanceof K)) {
        if (node instanceof exp.Query) {
          this.simplify(node, constant_propagation, coalesce_simplification);
        }
        continue;
      }

      const parent = node.parent;
      const root = node === expression;

      node = this.rewrite_between(node);
      node = this.uniq_sort(node, root);
      node = this.absorb_and_eliminate(node, root);
      node = this.simplify_concat(node);
      node = this.simplify_conditionals(node);

      if (constant_propagation) {
        node = propagate_constants(node, root);
      }

      if (node !== original) {
        original.replace(node);
      }

      for (const n of [...node.iterExpressions(true)]) {
        if (!n.metaGet(FINAL)) preTransformationStack.push(n);
      }
      postTransformationStack.push([node, parent]);
    }

    while (postTransformationStack.length) {
      const [original, parent] = postTransformationStack.pop();
      const root = original === expression;

      // Resets parent, arg_key, index pointers — needed because some of the previous
      // transformations mutate the AST, leading to an inconsistent state. We only fix
      // pointers instead of calling `set` because the values are unchanged: actual
      // mutations go through `set`/`replace`, which already invalidate cached hashes,
      // so clearing them again here would force `while_changing` to rehash entire
      // subtrees after every (mostly no-op) pass.
      for (const [k, v] of Object.entries({ ...original.args })) {
        if (v === null || v === undefined) delete original.args[k];
        else original._setParent(k, v);
      }

      // Post-order transformations
      node = this.simplify_not(original);
      node = flatten(node);
      node = this.simplify_connectors(node, root);
      node = this.remove_complements(node, root);

      if (coalesce_simplification) {
        node = this.simplify_coalesce(node);
      }
      node.parent = parent;

      node = this.simplify_literals(node, root);
      node = this.simplify_equality(node);
      node = simplify_parens(node, this.dialect);
      node = this.simplify_datetrunc(node);
      node = this.sort_comparison(node);
      node = this.simplify_startswith(node);

      if (node !== original) {
        original.replace(node);
      }
    }

    return node;
  }

  // py:785 `rewrite_between(expression)`.
  //
  // Rewrite x between y and z to x >= y AND x <= z.
  //
  // This is done because comparison simplification is only done on lt/lte/gt/gte.
  rewrite_between(expression) {
    if (expression instanceof exp.Between) {
      const negate = expression.parent instanceof exp.Not;

      let rewritten = exp.and_(
        new exp.GTE({ this: expression.this.copy(), expression: expression.args.low }),
        new exp.LTE({ this: expression.this.copy(), expression: expression.args.high }),
        { copy: false },
      );

      if (negate) rewritten = exp.paren(rewritten, false);

      return rewritten;
    }

    return expression;
  }

  // py:805 `simplify_not(expression)`.
  //
  // Demorgan's Law
  // NOT (x OR y) -> NOT x AND NOT y
  // NOT (x AND y) -> NOT x OR NOT y
  simplify_not(expression) {
    if (expression instanceof exp.Not) {
      const this_ = expression.this;
      if (is_null(this_)) {
        return _parenthesize_nested_connector(exp.and_(exp.null_(), exp.true_(), { copy: false }), expression.parent);
      }
      if (COMPLEMENT_COMPARISONS.has(this_.constructor)) {
        let right = this_.expression;
        const complementSubqueryPredicate = COMPLEMENT_SUBQUERY_PREDICATES.get(right.constructor);
        if (complementSubqueryPredicate) {
          right = new complementSubqueryPredicate({ this: right.this });
        }

        const Complement = COMPLEMENT_COMPARISONS.get(this_.constructor);
        return new Complement({ this: this_.this, expression: right });
      }
      if (this_ instanceof exp.Paren) {
        const condition = this_.unnest();
        if (condition instanceof exp.And) {
          return exp.paren(
            exp.or_(exp.not_(condition.left, { copy: false }), exp.not_(condition.right, { copy: false }), { copy: false }),
            false,
          );
        }
        if (condition instanceof exp.Or) {
          return exp.paren(
            exp.and_(exp.not_(condition.left, { copy: false }), exp.not_(condition.right, { copy: false }), { copy: false }),
            false,
          );
        }
        if (is_null(condition)) {
          return _parenthesize_nested_connector(exp.and_(exp.null_(), exp.true_(), { copy: false }), expression.parent);
        }
      }
      if (always_true(this_)) return exp.false_();
      if (is_false(this_)) return exp.true_();
      if (this_ instanceof exp.Not && this.dialect.SAFE_TO_ELIMINATE_DOUBLE_NEGATION) {
        const inner = this_.this;
        if (inner.isType(exp.DType.BOOLEAN)) {
          // double negation
          // NOT NOT x -> x, if x is BOOLEAN type
          return inner;
        }
      }
    }
    return expression;
  }

  // py:863 `simplify_connectors(expression, root=True)`.
  simplify_connectors(expression, root = true) {
    const self = this;
    function _simplify_connectors(expression, left, right) {
      if (expression instanceof exp.And) {
        if (is_false(left) || is_false(right)) return exp.false_();
        if (is_zero(left) || is_zero(right)) return exp.false_();
        if (
          (is_null(left) && is_null(right))
          || (is_null(left) && always_true(right))
          || (always_true(left) && is_null(right))
        ) {
          return exp.null_();
        }
        if (always_true(left) && always_true(right)) return exp.true_();
        if (always_true(left)) return right;
        if (always_true(right)) return left;
        return self._simplify_comparison(expression, left, right);
      } else if (expression instanceof exp.Or) {
        if (always_true(left) || always_true(right)) return exp.true_();
        if (
          (is_null(left) && is_null(right))
          || (is_null(left) && always_false(right))
          || (always_false(left) && is_null(right))
        ) {
          return exp.null_();
        }
        if (is_false(left)) return right;
        if (is_false(right)) return left;
        return self._simplify_comparison(expression, left, right, true);
      }
      return undefined;
    }

    if (expression instanceof exp.Connector) {
      let originalParent = expression.parent;
      expression = this._flat_simplify(expression, _simplify_connectors, root);

      // If we reduced a connector to, e.g., a column (t1 AND ... AND tn -> Tk), then we
      // need to ensure that the resulting type is boolean. We know this is true only
      // for connectors, boolean values and columns that are essentially operands to a
      // connector:
      //
      // A AND (((B)))
      //          ~ this is safe to keep because it will eventually be part of another
      //            connector
      if (
        !SAFE_CONNECTOR_ELIMINATION_RESULT.some((K) => expression instanceof K)
        && !expression.isType(exp.DType.BOOLEAN)
      ) {
        for (;;) {
          if (originalParent instanceof exp.Connector) break;
          if (!(originalParent instanceof exp.Paren)) {
            expression = expression.and_(exp.true_(), { copy: false });
            break;
          }

          originalParent = originalParent.parent;
        }
      }
    }

    return expression;
  }

  // py:923 `_simplify_comparison(expression, left, right, or_=False)`.
  _simplify_comparison(expression, left, right, or_ = false) {
    if (COMPARISONS.some((K) => left instanceof K) && COMPARISONS.some((K) => right instanceof K)) {
      if ([left, right].some((e) => e instanceof exp.Is && e.args.negate)) return null;

      const ll = left.this, lr = left.expression;
      const rl = right.this, rr = right.expression;

      const largs = new ExprSet([ll, lr]);
      const rargs = new ExprSet([rl, rr]);

      const matching = new ExprSet([...largs].filter((m) => rargs.has(m)));
      const columns = new ExprSet(
        [...matching].filter((m) => !_is_constant(m) && !m.find(...NONDETERMINISTIC)),
      );

      if (matching.size && columns.size) {
        let l, r;
        try {
          l = first([...largs].filter((x) => !columns.has(x)));
          r = first([...rargs].filter((x) => !columns.has(x)));
        } catch {
          return expression;
        }

        let lv, rv;
        if (l.isNumber && r.isNumber) {
          lv = l.toPy();
          rv = r.toPy();
        } else if (l.isString && r.isString) {
          lv = l.name;
          rv = r.name;
        } else {
          lv = extract_date(l);
          if (!lv) return null;
          rv = extract_date(r);
          if (!rv) return null;
          // python won't compare date and datetime, but many engines will upcast
          lv = cast_as_datetime(lv);
          rv = cast_as_datetime(rv);
        }

        const pairs = [
          [[left, lv], [right, rv]],
          [[right, rv], [left, lv]],
        ];
        for (const [[a, av], [b, bv]] of pairs) {
          if (LT_LTE.some((K) => a instanceof K) && LT_LTE.some((K) => b instanceof K)) {
            return (or_ ? pyLikeCmp(av, bv) > 0 : pyLikeCmp(av, bv) <= 0) ? left : right;
          }
          if (GT_GTE.some((K) => a instanceof K) && GT_GTE.some((K) => b instanceof K)) {
            return (or_ ? pyLikeCmp(av, bv) < 0 : pyLikeCmp(av, bv) >= 0) ? left : right;
          }

          // we can't ever shortcut to true because the column could be null
          if (!or_) {
            if (a instanceof exp.LT && GT_GTE.some((K) => b instanceof K)) {
              if (pyLikeCmp(av, bv) <= 0) return exp.false_();
            } else if (a instanceof exp.GT && LT_LTE.some((K) => b instanceof K)) {
              if (pyLikeCmp(av, bv) >= 0) return exp.false_();
            } else if (a instanceof exp.EQ) {
              if (b instanceof exp.LT) return pyLikeCmp(av, bv) >= 0 ? exp.false_() : a;
              if (b instanceof exp.LTE) return pyLikeCmp(av, bv) > 0 ? exp.false_() : a;
              if (b instanceof exp.GT) return pyLikeCmp(av, bv) <= 0 ? exp.false_() : a;
              if (b instanceof exp.GTE) return pyLikeCmp(av, bv) < 0 ? exp.false_() : a;
              if (b instanceof exp.NEQ) return pyLikeCmp(av, bv) === 0 ? exp.false_() : a;
            }
          }
        }
      }
    }
    return null;
  }

  // py:992 `remove_complements(expression, root=True)`.
  //
  // Removing complements.
  //
  // A AND NOT A -> FALSE (only for non-NULL A)
  // A OR NOT A -> TRUE (only for non-NULL A)
  remove_complements(expression, root = true) {
    if (AND_OR.some((K) => expression instanceof K) && (root || !expression.sameParent)) {
      const ops = new ExprSet(expression.flatten());
      for (const op of ops) {
        if (op instanceof exp.Not && ops.has(op.this)) {
          if (expression.metaGet("nonnull") === true) {
            return expression instanceof exp.And ? exp.false_() : exp.true_();
          }
        }
      }
    }

    return expression;
  }

  // py:1009 `uniq_sort(expression, root=True)`.
  //
  // Uniq and sort a connector.
  //
  // C AND A AND B AND B -> A AND B AND C
  uniq_sort(expression, root = true) {
    if (expression instanceof exp.Connector && (root || !expression.sameParent)) {
      const flattened = [...expression.flatten()];

      let resultFunc, deduped, arr;
      if (expression instanceof exp.Xor) {
        resultFunc = exp.xor;
        // Do not deduplicate XOR as A XOR A != A if A == True
        deduped = null;
        arr = flattened.map((e) => [gen(e), e]);
      } else {
        resultFunc = expression instanceof exp.And ? exp.and_ : exp.or_;
        deduped = new Map();
        for (const e of flattened) {
          const key = gen(e);
          if (!deduped.has(key)) deduped.set(key, e);
        }
        arr = [...deduped.entries()];
      }

      // check if the operands are already sorted, if not sort them
      // A AND C AND B -> A AND B AND C
      let sorted = false;
      for (let i = 1; i < arr.length; i++) {
        if (arr[i][0] < arr[i - 1][0]) {
          const sortedArr = [...arr].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
          expression = resultFunc(...sortedArr.map(([, e]) => e), { copy: false });
          sorted = true;
          break;
        }
      }
      if (!sorted) {
        // we didn't have to sort but maybe we need to dedup
        if (deduped && deduped.size < flattened.length) {
          const uniqueOperand = flattened[0];
          if (deduped.size === 1) {
            expression = uniqueOperand.and_(exp.true_(), { copy: false });
          } else {
            expression = resultFunc(...deduped.values(), { copy: false });
          }
        }
      }
    }

    return expression;
  }

  // py:1046 `absorb_and_eliminate(expression, root=True)`.
  //
  // absorption:
  //   A AND (A OR B) -> A
  //   A OR (A AND B) -> A
  //   A AND (NOT A OR B) -> A AND B (only for non-NULL A)
  //   A OR (NOT A AND B) -> A OR B (only for non-NULL A)
  // elimination:
  //   (A AND B) OR (A AND NOT B) -> A (only for non-NULL B)
  //   (A OR B) AND (A OR NOT B) -> A (only for non-NULL B)
  absorb_and_eliminate(expression, root = true) {
    if (AND_OR.some((K) => expression instanceof K) && (root || !expression.sameParent)) {
      const kind = expression instanceof exp.And ? exp.Or : exp.And;

      const ops = [...expression.flatten()];

      // Initialize lookup tables:
      // Set of all operands, used to find complements for absorption.
      const opSet = new ExprSet();
      // Sub-operands, used to find subsets for absorption.
      const subops = new ExprMap();
      // Pairs of complements, used for elimination.
      const pairs = new Map();

      // Populate the lookup tables
      for (const op of ops) {
        opSet.add(op);

        if (!(op instanceof kind)) {
          // In cases like: A OR (A AND B)
          // Subop will be: ^
          pushToExprMap(subops, op, new ExprSet([op]));
          continue;
        }

        // In cases like: (A AND B) OR (A AND B AND C)
        // Subops will be: ^     ^
        const subset = new ExprSet(op.flatten());
        for (const i of subset) {
          pushToExprMap(subops, i, subset);
        }

        const [a, b] = op.unnestOperands();

        if (a instanceof exp.Not && a.this.metaGet("nonnull") === true) {
          pushToMap(pairs, frozensetKey([a.this, b], (x) => x.hash()), [op, b]);
        }
        if (b instanceof exp.Not && b.this.metaGet("nonnull") === true) {
          pushToMap(pairs, frozensetKey([a, b.this], (x) => x.hash()), [op, a]);
        }
      }

      for (const op of ops) {
        if (!(op instanceof kind)) continue;

        const [a, b] = op.unnestOperands();

        // Absorb
        if (a instanceof exp.Not && opSet.has(a.this) && a.this.metaGet("nonnull") === true) {
          a.replace(kind === exp.And ? exp.true_() : exp.false_());
          continue;
        }
        if (b instanceof exp.Not && opSet.has(b.this) && b.this.metaGet("nonnull") === true) {
          b.replace(kind === exp.And ? exp.true_() : exp.false_());
          continue;
        }
        const superset = new ExprSet(op.flatten());
        let anySubset = false;
        for (const i of superset) {
          for (const subset of subops.get(i) || []) {
            if (subset.size < superset.size && [...subset].every((x) => superset.has(x))) {
              anySubset = true;
              break;
            }
          }
          if (anySubset) break;
        }
        if (anySubset) {
          op.replace(kind === exp.And ? exp.false_() : exp.true_());
          continue;
        }

        // Eliminate
        for (const [other, complement] of pairs.get(frozensetKey([a, b], (x) => x.hash())) || []) {
          op.replace(complement);
          other.replace(complement);
        }
      }
    }

    return expression;
  }

  // py:1129 `simplify_equality(expression)`.
  //
  // Use the subtraction and addition properties of equality to simplify expressions:
  //
  //   x + 1 = 3 becomes x = 2
  //
  // There are two binary operations in the above expression: + and =
  // Here's how we reference all the operands in the code below:
  //
  //   l     r
  //   x + 1 = 3
  //   a   b
  //
  // Subtraction is not commutative, so when the variable is the subtrahend the
  // operands can't simply be swapped; the comparison is inverted instead:
  //
  //   5 - x = 2 becomes x = 3
  //   5 - x < 2 becomes x > 3
  simplify_equality(expression) {
    if (COMPARISONS.some((K) => expression instanceof K)) {
      let l = expression.left, r = expression.right;

      if (!INVERSE_OPS.has(l.constructor)) return expression;

      let aPredicate, bPredicate;
      if (r.isNumber) {
        aPredicate = _is_number;
        bPredicate = _is_number;
      } else if (_is_date_literal(r)) {
        aPredicate = _is_date_literal;
        bPredicate = _is_interval;
      } else {
        return expression;
      }

      let a, b;
      if (INVERSE_DATE_OPS.has(l.constructor)) {
        a = l.this;
        b = l.interval();
      } else {
        a = l.left;
        b = l.right;
      }

      if (!aPredicate(a) && bPredicate(b)) {
        // fallthrough
      } else if (!aPredicate(b) && bPredicate(a)) {
        if (l instanceof exp.Sub) {
          const Comparison = INVERSE_COMPARISONS.get(expression.constructor) || expression.constructor;
          return new Comparison({ this: b, expression: new exp.Sub({ this: a, expression: r }) });
        }
        [a, b] = [b, a];
      } else {
        return expression;
      }

      const InverseOp = INVERSE_OPS.get(l.constructor);
      return new expression.constructor({ this: a, expression: new InverseOp({ this: r, expression: b }) });
    }
    return expression;
  }

  // py:1187 `_is_inverse_date_op(expression)`.
  _is_inverse_date_op(expression) {
    return INVERSE_DATE_OPS.has(expression.constructor);
  }

  // py:1190 `simplify_literals(expression, root=True)`.
  simplify_literals(expression, root = true) {
    if (expression instanceof exp.Binary && !(expression instanceof exp.Connector)) {
      return this._flat_simplify(expression, (e, a, b) => this._simplify_binary(e, a, b), root);
    }

    if (expression instanceof exp.Neg && expression.this instanceof exp.Neg) {
      return expression.this.this;
    }

    if (this._is_inverse_date_op(expression)) {
      return this._simplify_binary(expression, expression.this, expression.interval()) || expression;
    }

    return expression;
  }

  // py:1206 `_simplify_integer_cast(expr)`.
  _simplify_integer_cast(expr) {
    let this_;
    if (expr instanceof exp.Cast && expr.this instanceof exp.Cast) {
      this_ = this._simplify_integer_cast(expr.this);
    } else {
      this_ = expr.this;
    }

    if (expr instanceof exp.Cast && this_.isInt) {
      const num = this_.toPy();

      // Remove the (up)cast from small (byte-sized) integers in predicates which is
      // side-effect free. Downcasts on any integer type might cause overflow, thus the
      // cast cannot be eliminated and the behavior is engine-dependent.
      if (
        (TINYINT_MIN <= num && num <= TINYINT_MAX && exp.DataType.SIGNED_INTEGER_TYPES.has(expr.to.this))
        || (UTINYINT_MIN <= num && num <= UTINYINT_MAX && exp.DataType.UNSIGNED_INTEGER_TYPES.has(expr.to.this))
      ) {
        return this_;
      }
    }

    return expr;
  }

  // py:1229 `_simplify_binary(expression, a, b)`.
  _simplify_binary(expression, a, b) {
    if (COMPARISONS.some((K) => expression instanceof K)) {
      a = this._simplify_integer_cast(a);
      b = this._simplify_integer_cast(b);
    }

    if (expression instanceof exp.Is) {
      let c, not_;
      if (b instanceof exp.Not) {
        c = b.this;
        not_ = true;
      } else {
        c = b;
        not_ = false;
      }

      if (expression.args.negate) not_ = !not_;

      if (is_null(c)) {
        if (a instanceof exp.Literal) return not_ ? exp.true_() : exp.false_();
        if (is_null(a)) return not_ ? exp.false_() : exp.true_();
      }
    } else if (NULL_OK.some((K) => expression instanceof K)) {
      return null;
    } else if ((is_null(a) || is_null(b)) && expression.parent instanceof exp.If) {
      return exp.null_();
    }

    if (a.isNumber && b.isNumber) {
      const numA = a.toPy();
      const numB = b.toPy();

      if (expression instanceof exp.Add) return exp.Literal.number(numAdd(numA, numB));
      if (expression instanceof exp.Mul) return exp.Literal.number(numMul(numA, numB));

      // We only simplify Sub, Div if a and b have the same parent because they're not
      // associative
      if (expression instanceof exp.Sub) {
        return a.parent === b.parent ? exp.Literal.number(numSub(numA, numB)) : null;
      }
      if (expression instanceof exp.Div) {
        // engines have differing int div behavior so intdiv is not safe
        if ((typeof numA === "bigint" && typeof numB === "bigint") || a.parent !== b.parent) {
          return null;
        }
        return exp.Literal.number(decDiv(numA, numB));
      }

      const boolean = eval_boolean(expression, numA, numB);

      if (boolean) return boolean;
    } else if (a.isString && b.isString) {
      const boolean = eval_boolean(expression, a.this, b.this);

      if (boolean) return boolean;
    } else if (_is_date_literal(a) && b instanceof exp.Interval) {
      const date = extract_date(a);
      const bInterval = extract_interval(b);
      if (date && bInterval) {
        if (expression instanceof exp.Add || expression instanceof exp.DateAdd || expression instanceof exp.DatetimeAdd) {
          return date_literal(bInterval.addToDate(date), extract_type(a));
        }
        if (expression instanceof exp.Sub || expression instanceof exp.DateSub || expression instanceof exp.DatetimeSub) {
          return date_literal(bInterval.subFromDate(date), extract_type(a));
        }
      }
    } else if (a instanceof exp.Interval && _is_date_literal(b)) {
      const aInterval = extract_interval(a);
      const date = extract_date(b);
      // you cannot subtract a date from an interval
      if (aInterval && date && expression instanceof exp.Add) {
        return date_literal(aInterval.addToDate(date), extract_type(b));
      }
    } else if (_is_date_literal(a) && _is_date_literal(b)) {
      if (expression instanceof exp.Predicate) {
        const da = extract_date(a), db = extract_date(b);
        const boolean = eval_boolean(expression, da, db);
        if (boolean) return boolean;
      }
    }

    return null;
  }

  // py:1303 `simplify_coalesce(expression)`.
  simplify_coalesce(expression) {
    // COALESCE(x) -> x
    if (
      expression instanceof exp.Coalesce
      && (!expression.expressions.length || _is_nonnull_constant(expression.this))
      // COALESCE is also used as a Spark partitioning hint
      && !(expression.parent instanceof exp.Hint)
    ) {
      return expression.this;
    }

    if (this.dialect.COALESCE_COMPARISON_NON_STANDARD) return expression;

    if (!COMPARISONS.some((K) => expression instanceof K)) return expression;

    let coalesce, other;
    if (expression.left instanceof exp.Coalesce) {
      coalesce = expression.left;
      other = expression.right;
    } else if (expression.right instanceof exp.Coalesce) {
      coalesce = expression.right;
      other = expression.left;
    } else {
      return expression;
    }

    // This transformation is valid for non-constants, but it really only does anything
    // if they are both constants.
    if (!_is_constant(other)) return expression;

    // Find the first constant arg
    let argIndex = -1;
    let arg = null;
    for (let i = 0; i < coalesce.expressions.length; i++) {
      if (_is_constant(coalesce.expressions[i])) { argIndex = i; arg = coalesce.expressions[i]; break; }
    }
    if (argIndex === -1) return expression;

    coalesce.set("expressions", coalesce.expressions.slice(0, argIndex));

    // Remove the COALESCE function. This is an optimization, skipping a simplify
    // iteration, since we already remove COALESCE at the top of this function.
    const this_ = coalesce.expressions.length ? coalesce : coalesce.this;

    // This expression is more complex than when we started, but it will get simplified
    // further
    return exp.paren(
      exp.or_(
        exp.and_(this_.is_(exp.null_()).not_(false), expression.copy(), { copy: false }),
        exp.and_(this_.is_(exp.null_()), new expression.constructor({ this: arg.copy(), expression: other.copy() }), { copy: false }),
        { copy: false },
      ),
      false,
    );
  }

  // py:1365 `simplify_concat(expression)`.
  //
  // Reduces all groups that contain string literals by concatenating them.
  simplify_concat(expression) {
    if (
      !CONCATS.some((K) => expression instanceof K)
      // We can't reduce a CONCAT_WS call if we don't statically know the separator
      || (expression instanceof exp.ConcatWs && !expression.expressions[0].isString)
    ) {
      return expression;
    }

    let expressions, sep, concatType, sepExpr = null;
    if (expression instanceof exp.ConcatWs) {
      [sepExpr, ...expressions] = expression.expressions;
      sep = sepExpr.name;
      concatType = exp.ConcatWs;
    } else {
      expressions = expression.expressions;
      sep = "";
      concatType = exp.Concat;
    }

    const args = {
      safe: expression.args.safe,
      coalesce: expression.args.coalesce,
    };

    const newArgs = [];
    const source = expressions.length ? expressions : [...expression.flatten()];
    let i = 0;
    while (i < source.length) {
      const isStringGroup = source[i].isString;
      const group = [];
      while (i < source.length && source[i].isString === isStringGroup) { group.push(source[i]); i++; }
      if (isStringGroup) {
        newArgs.push(exp.Literal.string(group.map((s) => s.name).join(sep)));
      } else {
        newArgs.push(...group);
      }
    }

    if (newArgs.length === 1 && newArgs[0].isString) return newArgs[0];

    if (concatType === exp.ConcatWs) {
      return new concatType({ expressions: [sepExpr, ...newArgs], ...args });
    } else if (expression instanceof exp.DPipe) {
      return newArgs.reduce((x, y) => new exp.DPipe({ this: x, expression: y, safe: args.safe }));
    }

    return new concatType({ expressions: newArgs, ...args });
  }

  // py:1407 `simplify_conditionals(expression)`.
  //
  // Simplifies expressions like IF, CASE if their condition is statically known.
  simplify_conditionals(expression) {
    if (expression instanceof exp.Case) {
      // py: `this = expression.this` — captured ONCE before the loop. `this.pop()`
      // detaches it from `expression.args.this` on the first truthy iteration; on
      // later iterations `this_.pop()` is a no-op replace (parent already null) that
      // still returns `this_` itself, matching Python's `pop()` returning `self`
      // unconditionally — `.eq()` copies its receiver (`_binop`), so reusing the same
      // detached node across iterations never re-inserts one node in two places.
      const this_ = expression.this;
      for (const case_ of [...expression.args.ifs]) {
        let cond = case_.this;
        if (this_) {
          // Convert CASE x WHEN matching_value ... to CASE WHEN x = matching_value ...
          cond = cond.replace(this_.pop().eq(cond));
        }

        if (always_true(cond)) {
          return case_.args.true;
        }

        if (always_false(cond)) {
          case_.pop();
          if (!expression.args.ifs.length) {
            return expression.args.default || exp.null_();
          }
        }
      }
    } else if (expression instanceof exp.If && !(expression.parent instanceof exp.Case)) {
      if (always_true(expression.this)) return expression.args.true;
      if (always_false(expression.this)) return expression.args.false || exp.null_();
    }

    return expression;
  }

  // py:1433 `simplify_startswith(expression)`.
  //
  // Reduces a prefix check to either TRUE or FALSE if both the string and the prefix
  // are statically known.
  //
  // Example:
  //   Simplifier().simplify_startswith(parseOne("STARTSWITH('foo', 'f')")).sql() -> 'TRUE'
  simplify_startswith(expression) {
    if (
      expression instanceof exp.StartsWith
      && expression.this.isString
      && expression.expression.isString
    ) {
      return exp.convert(expression.name.startsWith(expression.expression.name));
    }

    return expression;
  }

  // py:1453 `_is_datetrunc_predicate(left, right)`.
  _is_datetrunc_predicate(left, right) {
    return DATETRUNCS.some((K) => left instanceof K) && _is_date_literal(right);
  }

  // py:1458 `simplify_datetrunc(expression)`.
  //
  // Simplify expressions like `DATE_TRUNC('year', x) >= CAST('2021-01-01' AS DATE)`.
  simplify_datetrunc(expression) {
    const comparison = expression.constructor;

    if (DATETRUNCS.some((K) => expression instanceof K)) {
      const this_ = expression.this;
      const truncType = extract_type(this_);
      const date = extract_date(this_);
      if (date && expression.unit) {
        return date_literal(
          datetime_floor(date, _trunc_unit(expression.unit, this.dialect), this.dialect),
          truncType,
        );
      }
    } else if (!DATETRUNC_COMPARISONS.has(comparison)) {
      return expression;
    }

    if (expression instanceof exp.Binary) {
      const l = expression.left, r = expression.right;

      if (!this._is_datetrunc_predicate(l, r) || !(l instanceof exp.DateTrunc || l instanceof exp.TimestampTrunc)) {
        return expression;
      }

      const truncArg = l.this;
      const unit = _trunc_unit(l.args.unit, this.dialect);
      const date = extract_date(r);

      if (!date) return expression;

      const fn = DATETRUNC_BINARY_COMPARISONS.get(comparison);
      const simplified = fn(truncArg, date, unit, this.dialect, extract_type(r));
      if (simplified === null || simplified === undefined) return expression;

      return _parenthesize_nested_connector(simplified, expression.parent);
    }

    if (expression instanceof exp.In) {
      const l = expression.this;
      const rs = expression.expressions;

      if (
        rs.length
        && rs.every((r) => this._is_datetrunc_predicate(l, r))
        && (l instanceof exp.DateTrunc || l instanceof exp.TimestampTrunc)
      ) {
        const unit = _trunc_unit(l.args.unit, this.dialect);

        const ranges = [];
        for (const r of rs) {
          const date = extract_date(r);
          if (!date) return expression;
          const drange = _datetrunc_range(date, unit, this.dialect);
          if (drange) ranges.push(drange);
        }

        if (!ranges.length) return expression;

        const merged = mergeRanges(ranges);
        const targetType = extract_type(...rs);

        const simplified = exp.or_(...merged.map((drange) => _datetrunc_eq_expression(l, drange, targetType)), { copy: false });
        return _parenthesize_nested_connector(simplified, expression.parent);
      }
    }

    return expression;
  }

  // py:1531 `sort_comparison(expression)`.
  sort_comparison(expression) {
    if (COMPLEMENT_COMPARISONS.has(expression.constructor)) {
      const l = expression.this, r = expression.expression;
      const lColumn = l instanceof exp.Column;
      const rColumn = r instanceof exp.Column;
      const lConst = _is_constant(l);
      const rConst = _is_constant(r);

      if (
        (lColumn && !rColumn)
        || (rConst && !lConst)
        || r instanceof exp.SubqueryPredicate
      ) {
        return expression;
      }
      if ((rColumn && !lColumn) || (lConst && !rConst) || gen(l) > gen(r)) {
        const Comparison = INVERSE_COMPARISONS.get(expression.constructor) || expression.constructor;
        return new Comparison({ this: r, expression: l });
      }
    }
    return expression;
  }

  // py:1552 `_flat_simplify(expression, simplifier, root=True)`.
  _flat_simplify(expression, simplifier, root = true) {
    if (root || !expression.sameParent) {
      let operands = [];
      let queue = [...expression.flatten(false)];
      const size = queue.length;

      // The pairwise scan below is O(n^2). For connectors, a pair only combines if one
      // side is a constant or both are comparisons (see _simplify_connectors /
      // _simplify_comparison); if no operand is combinable the scan is a guaranteed
      // no-op, so return early. This avoids the quadratic blowup on large connectors of
      // inert operands (e.g. a 1000-way OR of ANDs). Non-connector callers
      // (simplify_equality) are unaffected by the type guard.
      if (
        expression instanceof exp.Connector
        && !queue.some((op) => CONNECTOR_COMBINABLE.some((K) => op instanceof K))
      ) {
        return expression;
      }

      while (queue.length) {
        const a = queue.shift();

        let combined = false;
        for (let i = 0; i < queue.length; i++) {
          const b = queue[i];
          const result = simplifier(expression, a, b);

          if (result && result !== expression) {
            queue.splice(i, 1);
            queue.unshift(result);
            combined = true;
            break;
          }
        }
        if (!combined) operands.push(a);
      }

      if (operands.length < size) {
        return operands.reduce((a, b) => new expression.constructor({ this: a, expression: b }));
      }
    }
    return expression;
  }
}

function numAdd(a, b) {
  return (typeof a === "bigint" && typeof b === "bigint") ? a + b : decAdd(a, b);
}
function numMul(a, b) {
  return (typeof a === "bigint" && typeof b === "bigint") ? a * b : decMul(a, b);
}
function numSub(a, b) {
  return (typeof a === "bigint" && typeof b === "bigint") ? a - b : decSub(a, b);
}

// py:785-1550 `@annotate_types_on_change`/`@catch(...)` decorator application.
// Python applies these at `def` time; JS applies them once, after the class body,
// to the same prototype methods, in the same order (closest-to-`def` first).
Simplifier.prototype.rewrite_between = annotateTypesOnChange(Simplifier.prototype.rewrite_between);
Simplifier.prototype.simplify_not = annotateTypesOnChange(Simplifier.prototype.simplify_not);
Simplifier.prototype.simplify_connectors = annotateTypesOnChange(Simplifier.prototype.simplify_connectors);
Simplifier.prototype._simplify_comparison = annotateTypesOnChange(Simplifier.prototype._simplify_comparison);
Simplifier.prototype.remove_complements = annotateTypesOnChange(Simplifier.prototype.remove_complements);
Simplifier.prototype.uniq_sort = annotateTypesOnChange(Simplifier.prototype.uniq_sort);
Simplifier.prototype.absorb_and_eliminate = annotateTypesOnChange(Simplifier.prototype.absorb_and_eliminate);
// py:1127-1128 `@annotate_types_on_change` / `@catch(ModuleNotFoundError, UnsupportedUnit)`.
// `ModuleNotFoundError` has no JS equivalent here: upstream's is a lazy, OPTIONAL
// `import dateutil.relativedelta` inside `interval()`; this port's `PyRelativedelta`
// (`_py/datetime.js`) is a real, always-present dependency, so that failure mode does
// not exist — only `UnsupportedUnit` (an unrecognized date/trunc unit) is caught.
Simplifier.prototype.simplify_equality = annotateTypesOnChange(catchDecorator(UnsupportedUnit)(Simplifier.prototype.simplify_equality));
Simplifier.prototype.simplify_literals = annotateTypesOnChange(Simplifier.prototype.simplify_literals);
Simplifier.prototype.simplify_coalesce = annotateTypesOnChange(Simplifier.prototype.simplify_coalesce);
Simplifier.prototype.simplify_concat = annotateTypesOnChange(Simplifier.prototype.simplify_concat);
Simplifier.prototype.simplify_conditionals = annotateTypesOnChange(Simplifier.prototype.simplify_conditionals);
Simplifier.prototype.simplify_startswith = annotateTypesOnChange(Simplifier.prototype.simplify_startswith);
Simplifier.prototype.simplify_datetrunc = annotateTypesOnChange(catchDecorator(UnsupportedUnit)(Simplifier.prototype.simplify_datetrunc));
Simplifier.prototype.sort_comparison = annotateTypesOnChange(Simplifier.prototype.sort_comparison);

// py: simplify.py:1593-1881 `gen(expression, comments=False)` + `class Gen` +
// `_build_gen_dispatch()`/`GEN_DISPATCH`.
//
// A minimal, LOCAL pseudo-SQL generator used ONLY inside this file, for producing
// sortable/uniq strings (`uniq_sort`, `sort_comparison`, `absorb_and_eliminate`'s
// `subops`/`pairs` keys via `.hash()`... no — those use the real structural `.hash()`;
// `gen()` itself is what `uniq_sort`/`sort_comparison` need for a STABLE TEXTUAL sort
// key, and IS load-bearing: it determines conjunct/disjunct ordering in the final
// simplified SQL, so its output has to sort the same way CPython's `gen()` does for
// the node shapes this file actually produces, not merely be internally consistent.

/** py: simplify.py:1593 `gen(expression, comments=False)`. */
export function gen(expression, comments = false) {
  return new Gen().gen(expression, comments);
}

// Not upstream: Python's `str()` applied to a raw (non-Expr, non-list) value popped
// off `Gen`'s stack — `bool`/`None` render as `True`/`False`/`None`, an AutoName enum
// renders as its `.value`, everything else via plain stringification.
function pyStrOf(v) {
  if (v === true) return "True";
  if (v === false) return "False";
  if (v === null || v === undefined) return "None";
  if (typeof v === "bigint") return v.toString();
  if (v && v.__enum__) return v.value ?? v.name;
  return String(v);
}

// Not upstream: Python's `repr(str)` — quote-char selection, backslash/quote/control
// escaping — needed by `Gen._args`'s `repr(v) if isinstance(v, str) else v`.
function pyReprStr(s) {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let escaped = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === "\\") escaped += "\\\\";
    else if (ch === "\n") escaped += "\\n";
    else if (ch === "\r") escaped += "\\r";
    else if (ch === "\t") escaped += "\\t";
    else if (ch === quote) escaped += `\\${quote}`;
    else if (cp < 0x20 || cp === 0x7f) escaped += `\\x${`0${cp.toString(16)}`.slice(-2)}`;
    else escaped += ch;
  }
  return `${quote}${escaped}${quote}`;
}

/** py: simplify.py:1606 `class Gen`. */
class Gen {
  constructor() {
    this.stack = [];
    this.sqls = [];
  }

  gen(expression, comments = false) {
    this.stack = [expression];
    this.sqls.length = 0;
    const dispatch = GEN_DISPATCH;

    while (this.stack.length) {
      const node = this.stack.pop();

      if (node instanceof exp.Expr) {
        if (comments && node.comments && node.comments.length) {
          this.stack.push(` /*${node.comments.join(",")}*/`);
        }

        const handler = dispatch.get(node.key);

        if (handler !== undefined) {
          handler(this, node);
        } else if (node instanceof exp.Func) {
          this._function(node);
        } else {
          const key = node.key.toUpperCase();
          this.stack.push(this._args(node) ? `${key} ` : key);
        }
      } else if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) {
          const n = node[i];
          if (n !== null && n !== undefined) this.stack.push(n, ",");
        }
        if (node.length) this.stack.pop();
      } else if (node !== null && node !== undefined) {
        this.sqls.push(pyStrOf(node));
      }
    }

    return this.sqls.join("");
  }

  add_sql(e) { this._binary(e, " + "); }
  alias_sql(e) { this.stack.push(e.args.alias, " AS ", e.args.this); }
  and_sql(e) { this._binary(e, " AND "); }
  anonymous_sql(e) {
    const this_ = e.this;
    let name;
    if (typeof this_ === "string") {
      name = this_.toUpperCase();
    } else if (this_ instanceof exp.Identifier) {
      name = this_.this;
      if (this_.quoted) {
        const escaped = name.replaceAll('"', '""');
        name = `"${escaped}"`;
      } else {
        name = name.toUpperCase();
      }
    } else {
      throw new TypeError(`Anonymous.this expects a str or an Identifier, got '${this_?.constructor?.name}'.`);
    }

    this.stack.push(")", e.expressions, "(", name);
  }
  between_sql(e) { this.stack.push(e.args.high, " AND ", e.args.low, " BETWEEN ", e.this); }
  boolean_sql(e) { this.stack.push(e.this ? "TRUE" : "FALSE"); }
  bracket_sql(e) { this.stack.push("]", e.expressions, "[", e.this); }
  column_sql(e) {
    const parts = [...e.parts].reverse();
    for (const p of parts) this.stack.push(p, ".");
    this.stack.pop();
  }
  datatype_sql(e) { this._args(e, 1); this.stack.push(`${e.this.name} `); }
  div_sql(e) { this._binary(e, " / "); }
  dot_sql(e) { this._binary(e, "."); }
  eq_sql(e) { this._binary(e, " = "); }
  from_sql(e) { this.stack.push(e.this, "FROM "); }
  gt_sql(e) { this._binary(e, " > "); }
  gte_sql(e) { this._binary(e, " >= "); }
  identifier_sql(e) {
    if (e.quoted) {
      const escaped = e.this.replaceAll('"', '""');
      this.stack.push(`"${escaped}"`);
    } else {
      this.stack.push(e.this);
    }
  }
  ilike_sql(e) { this._binary(e, e.args.negate ? " NOT ILIKE " : " ILIKE "); }
  in_sql(e) {
    this.stack.push(")");
    this._args(e, 1);
    this.stack.push("(", " IN ", e.this);
  }
  intdiv_sql(e) { this._binary(e, " DIV "); }
  is_sql(e) { this._binary(e, e.args.negate ? " IS NOT " : " IS "); }
  like_sql(e) { this._binary(e, e.args.negate ? " NOT Like " : " Like "); }
  literal_sql(e) {
    if (e.isString) {
      const escaped = String(e.this).replaceAll("'", "''");
      this.stack.push(`'${escaped}'`);
    } else {
      this.stack.push(e.this);
    }
  }
  lt_sql(e) { this._binary(e, " < "); }
  lte_sql(e) { this._binary(e, " <= "); }
  mod_sql(e) { this._binary(e, " % "); }
  mul_sql(e) { this._binary(e, " * "); }
  neg_sql(e) { this._unary(e, "-"); }
  neq_sql(e) { this._binary(e, " <> "); }
  not_sql(e) { this._unary(e, "NOT "); }
  null_sql() { this.stack.push("NULL"); }
  or_sql(e) { this._binary(e, " OR "); }
  paren_sql(e) { this.stack.push(")", e.this, "("); }
  sub_sql(e) { this._binary(e, " - "); }
  subquery_sql(e) {
    this._args(e, 2);
    const alias = e.args.alias;
    if (alias) this.stack.push(alias);
    this.stack.push(")", e.this, "(");
  }
  table_sql(e) {
    this._args(e, 4);
    const alias = e.args.alias;
    if (alias) this.stack.push(alias);
    const parts = [...e.parts].reverse();
    for (const p of parts) this.stack.push(p, ".");
    this.stack.pop();
  }
  tablealias_sql(e) {
    const columns = e.columns;
    if (columns.length) this.stack.push(")", columns, "(");
    this.stack.push(e.this, " AS ");
  }
  var_sql(e) { this.stack.push(e.this); }

  _binary(e, op) { this.stack.push(e.expression, op, e.this); }
  _unary(e, op) { this.stack.push(e.this, op); }
  _function(e) { this.stack.push(")", Object.values(e.args), "(", e.constructor.sqlName()); }
  _args(node, argIndex = 0) {
    const kvs = [];
    const allKeys = [...node.constructor.argTypes.keys()];
    const argTypes = argIndex ? allKeys.slice(argIndex) : allKeys;

    for (const k of argTypes) {
      const v = node.args[k];

      if (v !== null && v !== undefined) {
        kvs.push([`:${k}`, typeof v === "string" ? pyReprStr(v) : v]);
      }
    }
    if (kvs.length) {
      this.stack.push(kvs);
      return true;
    }
    return false;
  }
}

/** py: simplify.py:1870 `_build_gen_dispatch()` + `GEN_DISPATCH`. */
function _build_gen_dispatch() {
  const dispatch = new Map();
  for (const name of Object.getOwnPropertyNames(Gen.prototype)) {
    if (name.endsWith("_sql") && !name.startsWith("_")) {
      const key = name.slice(0, -4);
      const fn = Gen.prototype[name];
      dispatch.set(key, (self, node) => fn.call(self, node));
    }
  }
  return dispatch;
}

const GEN_DISPATCH = _build_gen_dispatch();
