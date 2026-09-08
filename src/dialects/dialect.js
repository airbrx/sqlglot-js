// py: sqlglot/dialects/dialect.py @ 91119bc — MODULE-LEVEL BUILDERS ONLY.
//
// Scope, deliberately narrow
// --------------------------
// The `Dialect` class itself is P5. This file holds only the module-level *builder
// functions* that the ported `sqlglot/parsers/*.py` subclasses import at their top —
// the ones that appear as values inside a parser's `FUNCTIONS` / `TYPE_CONVERTERS` and
// are therefore hard dependencies of the parser subclass, not of the dialect settings
// class. Upstream keeps them in `dialects/dialect.py`, so this file mirrors that
// location rather than inventing a new home; when P5 ports the `Dialect` class it
// lands in this same file next to them.
//
// Members are added here strictly on demand, one per importing parser: `snowflake.js`
// established the first set; `hive.js` adds `build_regexp_extract`, `spark2.js` adds
// `pivot_column_names`, and `spark.js`/`databricks.js` add `build_date_delta`. A
// helper that is genuinely specific to ONE dialect belongs in that dialect's own file
// instead — all four of these are in upstream's shared `dialects/dialect.py`, imported
// by several dialects each, so they belong here.
//
// Nothing here resolves a dialect by NAME (CONTRACTS.md §8). Every function that needs
// dialect state takes an already-resolved dialect object, exactly as upstream's
// `_builder(args, dialect)` signature does. The single exception is `map_date_part`'s
// default argument, which upstream itself defines as the BASE `Dialect` class
// (`def map_date_part(part, dialect: DialectType = Dialect)`) — that is not a fallback
// for a missing dialect, it is the documented default, and it is reproduced by
// consulting the base `DATE_PART_MAPPING` literal below rather than by any lookup.
//
// @ported-ranges sqlglot/dialects/dialect.py 858-953 1610-1637 1654-1674 1700-1706 1892-1914 1916-1920 1925-1963 2167-2176 2384-2394 2462-2474 2477-2497 2604-2617 2620-2625
//
// One range per member ported, so `tools/lint_deny.mjs` measures this file against
// what it actually claims rather than against all 2,600 lines of `dialects/dialect.py`
// (the directive exists for exactly this: a file that deliberately ports part of an
// upstream module). Every deny-listed site in that file -- py_builtins:1179,
// operators:1375/1782, implicit_str:1815/2547 -- falls outside these ranges today; when
// P5 ports the surrounding code the range list grows and the lint starts demanding
// their markers.

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

/** py: sqlglot/dialects/dialect.py:1654 */
export function build_date_delta(
  exp_class,
  unit_mapping = null,
  default_unit = "DAY",
  supports_timezone = false,
) {
  return function _builder(args) {
    const unit_based = args.length >= 3;
    const has_timezone = args.length === 4;
    const this_ = unit_based ? args[2] : seqGet(args, 0);
    let unit = null;
    if (unit_based || default_unit) {
      unit = unit_based ? args[0] : exp.Literal.string(default_unit);
      // py: `unit_mapping.get(unit.name.lower(), unit.name)` — dict.get with a default.
      if (unit_mapping) {
        const key = unit.name.toLowerCase();
        unit = exp.var_(unit_mapping.has(key) ? unit_mapping.get(key) : unit.name);
      }
    }
    const expression = new exp_class({ this: this_, expression: seqGet(args, 1), unit });
    if (supports_timezone && has_timezone) expression.set("zone", args[args.length - 1]);
    return expression;
  };
}

/**
 * py: sqlglot/dialects/dialect.py:1892
 *
 * The non-`Alias` branch renders each aggregation back to SQL (`agg.sql(dialect=...,
 * normalize_functions="lower")`), which needs the full `Generator` — a P7 component,
 * not the minimal kernel this phase has. `Spark2Parser._pivot_column_names` short-
 * circuits to `[]` for the single-aggregation case before ever reaching here, so the
 * reachable-today path is the `Alias` one; anything else announces itself rather than
 * approximating a rendered name.
 */
export function pivot_column_names(aggregations, dialect) {
  const names = [];
  for (const agg of aggregations) {
    if (agg instanceof exp.Alias) {
      names.push(agg.alias);
    } else {
      throw new NotPorted(
        "pivot_column_names(non-Alias aggregation)",
        "sqlglot/dialects/dialect.py:1912 Expr.sql",
      );
    }
  }

  return names;
}

/** py: sqlglot/dialects/dialect.py:2477 */
export function build_regexp_extract(expr_type) {
  return function _builder(args, dialect) {
    // The "position" argument specifies the index of the string character to start matching from.
    // `null_if_pos_overflow` reflects the dialect's behavior when position is greater than the string
    // length. If true, returns NULL. If false, returns an empty string. `null_if_pos_overflow` is
    // only needed for exp.RegexpExtract - exp.RegexpExtractAll always returns an empty array if
    // position overflows.
    const kwargs = {
      this: seqGet(args, 0),
      expression: seqGet(args, 1),
      group: seqGet(args, 2) || exp.Literal.number(dialect.REGEXP_EXTRACT_DEFAULT_GROUP),
      parameters: seqGet(args, 3),
    };
    if (expr_type === exp.RegexpExtract) {
      kwargs.null_if_pos_overflow = dialect.REGEXP_EXTRACT_POSITION_OVERFLOW_RETURNS_NULL;
    }
    return new expr_type(kwargs);
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
