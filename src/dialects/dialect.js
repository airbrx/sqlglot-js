// py: sqlglot/dialects/dialect.py @ 91119bc — MODULE-LEVEL BUILDERS ONLY.
//
// Scope, deliberately narrow
// --------------------------
// The `Dialect` class itself is P5. This file holds only the module-level *builder
// functions* that `sqlglot/parsers/snowflake.py` imports at its top — the ones that
// appear as values inside `SnowflakeParser.FUNCTIONS` / `TYPE_CONVERTERS` and are
// therefore hard dependencies of the parser subclass, not of the dialect settings
// class. Upstream keeps them in `dialects/dialect.py`, so this file mirrors that
// location rather than inventing a new home; when P5 ports the `Dialect` class it
// lands in this same file next to them.
//
// Nothing here resolves a dialect by NAME (CONTRACTS.md §8). Every function that needs
// dialect state takes an already-resolved dialect object, exactly as upstream's
// `_builder(args, dialect)` signature does. The single exception is `map_date_part`'s
// default argument, which upstream itself defines as the BASE `Dialect` class
// (`def map_date_part(part, dialect: DialectType = Dialect)`) — that is not a fallback
// for a missing dialect, it is the documented default, and it is reproduced by
// consulting the base `DATE_PART_MAPPING` literal below rather than by any lookup.

import { seqGet } from "../helper.js";
import { NotPorted } from "../errors.js";
import { pyUpper } from "../_py/str.js";
import { pyTruthy } from "../_py/truthy.js";
import * as exp from "../expressions/index.js";

/**
 * py: sqlglot/optimizer/annotate_types.py — NOT PORTED.
 *
 * `build_trunc` and `build_timetostr_or_tochar` call it to decide date-vs-numeric
 * truncation and TimeToStr-vs-ToChar from the ANNOTATED type of an argument. The type
 * annotator is a separate upstream module (P6+) with its own scope; there is no honest
 * partial answer here, so the two call sites announce themselves as stubs rather than
 * guessing a type and silently building the wrong node.
 */
function annotate_types(_expression, _dialect) {
  throw new NotPorted("annotate_types", "sqlglot/optimizer/annotate_types.py");
}

/** py: sqlglot/dialects/dialect.py:1916 */
export function binary_from_function(expr_type) {
  return (args) => new expr_type({ this: seqGet(args, 0), expression: seqGet(args, 1) });
}

/**
 * py: sqlglot/dialects/dialect.py:1610
 *
 * `dialect_override` is a dialect NAME upstream (`Dialect[dialect_override]`), which
 * §8 forbids resolving here. No caller in `parsers/snowflake.py` passes it, so the
 * parameter is accepted and rejected rather than silently ignored.
 */
export function build_formatted_time(exp_class, dialect_override = null, default_ = null) {
  return function _builder(args, dialect) {
    if (typeof dialect_override === "string") {
      throw new NotPorted(
        `build_formatted_time(dialect_override=${JSON.stringify(dialect_override)})`,
        "sqlglot/dialects/dialect.py:1624",
      );
    }
    const target_dialect = dialect;

    let fmt = seqGet(args, 1);
    if (!fmt) fmt = default_ === true ? target_dialect.TIME_FORMAT : default_ || null;

    return new exp_class({ this: seqGet(args, 0), format: target_dialect.format_time(fmt) });
  };
}

/** py: sqlglot/dialects/dialect.py:1700 */
export function date_trunc_to_time(args) {
  const unit = seqGet(args, 0);
  const this_ = seqGet(args, 1);

  if (this_ instanceof exp.Cast && this_.isType("date")) {
    return new exp.DateTrunc({ unit, this: this_ });
  }
  return new exp.TimestampTrunc({ this: this_, unit });
}

/** py: sqlglot/dialects/dialect.py:1925 */
export function build_trunc(args, dialect, options = {}) {
  const {
    date_trunc_unabbreviate = true,
    default_date_trunc_unit = null,
    date_trunc_requires_part = true,
    fractions_supported = false,
  } = options;

  let this_ = seqGet(args, 0);
  let second = seqGet(args, 1);

  if (this_ && !this_.type) this_ = annotate_types(this_, dialect);
  if (second && !second.type) second = annotate_types(second, dialect);

  // Date truncation
  if (
    (this_ && this_.isType(...exp.DataType.TEMPORAL_TYPES) && (second || default_date_trunc_unit))
    || (second && second.isType(...exp.DataType.TEXT_TYPES))
  ) {
    const unit = second || exp.Literal.string(default_date_trunc_unit);
    return new exp.DateTrunc({ this: this_, unit, unabbreviate: date_trunc_unabbreviate });
  }

  // Numeric truncation
  if (
    (this_ && this_.isType(...exp.DataType.NUMERIC_TYPES))
    || (second && second.isType(...exp.DataType.NUMERIC_TYPES))
    || (!date_trunc_requires_part && !second)
  ) {
    return new exp.Trunc({ this: this_, decimals: second, fractions_supported });
  }

  return new exp.Anonymous({ this: "TRUNC", expressions: args });
}

/** py: sqlglot/dialects/dialect.py:2384 */
export function build_default_decimal_type(precision = null, scale = null) {
  return function _builder(dtype) {
    if (pyTruthy(dtype.expressions) || precision === null) return dtype;

    const params = `${precision}${scale !== null ? `, ${scale}` : ""}`;
    return exp.DataType.fromStr(`DECIMAL(${params})`);
  };
}

/** py: sqlglot/dialects/dialect.py:2462 */
export function build_like(expr_type, not_like = false) {
  return function _builder(args) {
    let like_expr = new expr_type({ this: seqGet(args, 0), expression: seqGet(args, 1) });

    const escape = seqGet(args, 2);
    if (escape) like_expr = new exp.Escape({ this: like_expr, expression: escape });

    if (not_like) like_expr = new exp.Not({ this: like_expr });

    return like_expr;
  };
}

/** py: sqlglot/dialects/dialect.py:2604 */
export function build_timetostr_or_tochar(args, dialect) {
  if (args.length === 2) {
    const this_ = args[0];
    if (!this_.type) annotate_types(this_, dialect);

    if (this_.isType(...exp.DataType.TEMPORAL_TYPES)) {
      return build_formatted_time(exp.TimeToStr, null, true)(args, dialect);
    }
  }

  return exp.ToChar.from_arg_list(args);
}

/** py: sqlglot/dialects/dialect.py:2620 */
export function build_replace_with_optional_replacement(args) {
  return new exp.Replace({
    this: seqGet(args, 0),
    expression: seqGet(args, 1),
    replacement: seqGet(args, 2) || exp.Literal.string(""),
  });
}

/**
 * py: sqlglot/dialects/dialect.py:858 `Dialect.DATE_PART_MAPPING`.
 *
 * A `Map`, not a plain object, for the reason CONTRACTS.md §8 records for every other
 * lookup table in this port: `mapping["constructor"]` on a plain object returns
 * `Object.prototype.constructor`. Iteration order is upstream's insertion order.
 */
export const DATE_PART_MAPPING = new Map([
    ["Y", "YEAR"],
    ["YY", "YEAR"],
    ["YYY", "YEAR"],
    ["YYYY", "YEAR"],
    ["YR", "YEAR"],
    ["YEARS", "YEAR"],
    ["YRS", "YEAR"],
    ["MM", "MONTH"],
    ["MON", "MONTH"],
    ["MONS", "MONTH"],
    ["MONTHS", "MONTH"],
    ["D", "DAY"],
    ["DD", "DAY"],
    ["DAYS", "DAY"],
    ["DAYOFMONTH", "DAY"],
    ["DAY OF WEEK", "DAYOFWEEK"],
    ["WEEKDAY", "DAYOFWEEK"],
    ["DOW", "DAYOFWEEK"],
    ["DW", "DAYOFWEEK"],
    ["WEEKDAY_ISO", "DAYOFWEEKISO"],
    ["DOW_ISO", "DAYOFWEEKISO"],
    ["DW_ISO", "DAYOFWEEKISO"],
    ["DAYOFWEEK_ISO", "DAYOFWEEKISO"],
    ["DAY OF YEAR", "DAYOFYEAR"],
    ["DOY", "DAYOFYEAR"],
    ["DY", "DAYOFYEAR"],
    ["W", "WEEK"],
    ["WK", "WEEK"],
    ["WEEKOFYEAR", "WEEK"],
    ["WOY", "WEEK"],
    ["WY", "WEEK"],
    ["WEEK_ISO", "WEEKISO"],
    ["WEEKOFYEARISO", "WEEKISO"],
    ["WEEKOFYEAR_ISO", "WEEKISO"],
    ["Q", "QUARTER"],
    ["QTR", "QUARTER"],
    ["QTRS", "QUARTER"],
    ["QUARTERS", "QUARTER"],
    ["H", "HOUR"],
    ["HH", "HOUR"],
    ["HR", "HOUR"],
    ["HOURS", "HOUR"],
    ["HRS", "HOUR"],
    ["M", "MINUTE"],
    ["MI", "MINUTE"],
    ["MIN", "MINUTE"],
    ["MINUTES", "MINUTE"],
    ["MINS", "MINUTE"],
    ["S", "SECOND"],
    ["SEC", "SECOND"],
    ["SECONDS", "SECOND"],
    ["SECS", "SECOND"],
    ["MS", "MILLISECOND"],
    ["MSEC", "MILLISECOND"],
    ["MSECS", "MILLISECOND"],
    ["MSECOND", "MILLISECOND"],
    ["MSECONDS", "MILLISECOND"],
    ["MILLISEC", "MILLISECOND"],
    ["MILLISECS", "MILLISECOND"],
    ["MILLISECON", "MILLISECOND"],
    ["MILLISECONDS", "MILLISECOND"],
    ["US", "MICROSECOND"],
    ["USEC", "MICROSECOND"],
    ["USECS", "MICROSECOND"],
    ["MICROSEC", "MICROSECOND"],
    ["MICROSECS", "MICROSECOND"],
    ["USECOND", "MICROSECOND"],
    ["USECONDS", "MICROSECOND"],
    ["MICROSECONDS", "MICROSECOND"],
    ["NS", "NANOSECOND"],
    ["NSEC", "NANOSECOND"],
    ["NANOSEC", "NANOSECOND"],
    ["NSECOND", "NANOSECOND"],
    ["NSECONDS", "NANOSECOND"],
    ["NANOSECS", "NANOSECOND"],
    ["EPOCH_SECOND", "EPOCH"],
    ["EPOCH_SECONDS", "EPOCH"],
    ["EPOCH_MILLISECONDS", "EPOCH_MILLISECOND"],
    ["EPOCH_MICROSECONDS", "EPOCH_MICROSECOND"],
    ["EPOCH_NANOSECONDS", "EPOCH_NANOSECOND"],
    ["TZH", "TIMEZONE_HOUR"],
    ["TZM", "TIMEZONE_MINUTE"],
    ["DEC", "DECADE"],
    ["DECS", "DECADE"],
    ["DECADES", "DECADE"],
    ["MIL", "MILLENNIUM"],
    ["MILS", "MILLENNIUM"],
    ["MILLENIA", "MILLENNIUM"],
    ["C", "CENTURY"],
    ["CENT", "CENTURY"],
    ["CENTS", "CENTURY"],
    ["CENTURIES", "CENTURY"],
]);

/**
 * py: sqlglot/dialects/dialect.py:2167
 *
 * `dialect` defaults to the base `Dialect` upstream; `null` here means the same thing
 * and reads `DATE_PART_MAPPING` above. Note that every `FUNCTIONS` entry in
 * `parsers/snowflake.py` calls this WITHOUT a dialect (so it gets the base mapping)
 * while `_parse_date_part` passes `self.dialect` (so it gets Snowflake's). That
 * asymmetry is upstream's, and it is observable — Snowflake's mapping differs from the
 * base one in three entries — so it is reproduced rather than normalised away.
 */
export function map_date_part(part, dialect = null) {
  const mapping = dialect === null ? DATE_PART_MAPPING : dialect.DATE_PART_MAPPING;
  const mapped = part && !(part instanceof exp.Column && part.parts.length !== 1)
    ? mapping.get(pyUpper(part.name))
    : null;
  if (mapped) return part.isString ? exp.Literal.string(mapped) : exp.var(mapped);

  return part;
}
