// py: sqlglot/parsers/snowflake.py @ 91119bc
//
// `class SnowflakeParser(parser.Parser)` — the READ-side Snowflake grammar. This is the
// second half of P3's title ("Parser base + Snowflake parser"); PORT_PLAN.md R15
// records why it had never been started and what it gates.
//
// Two rules this file follows that differ from `src/parser.js`'s own conventions, and
// which are easy to conflate:
//
//   * A subclass's STATIC FIELD INITIALIZER names its parent explicitly — `new Set([
//     ...Parser.TYPE_TOKENS, TokenType.FILE])`, mirroring upstream's
//     `{*parser.Parser.TYPE_TOKENS, TokenType.FILE}`. It is evaluated once at module
//     load, against the imported base class, exactly as Python evaluates a class body.
//   * An INSTANCE METHOD reading a class table still goes through
//     `this.constructor.X` (never a bare `this.X`, never `SnowflakeParser.X`), so a
//     further subclass would see its own override. That is the lesson recorded in
//     memory as "js-static-fields-need-this-constructor"; it is about method bodies,
//     not about the field initializers above.
//
// Whether a table EXTENDS or REPLACES its parent is decided per table from upstream:
// `TYPE_TOKENS = {*parser.Parser.TYPE_TOKENS, ...}` extends, `SHOW_PARSERS = {...}`
// replaces outright. `FUNCTIONS` and `FUNCTION_PARSERS` additionally get a SECOND
// assignment that filters one key back out (`PREDICT`, `TRIM`) — a Python idiom that
// looks like a duplicate definition and is easy to drop on the floor.

import { Parser, build_var_map, setDiff, setUnion } from "../parser.js";
import { TokenType } from "../tokens.js";
import { newTrie } from "../trie.js";
import { isDateUnit, isInt, seqGet } from "../helper.js";
import { pyUpper } from "../_py/str.js";
import { pyTruthy } from "../_py/truthy.js";
import * as exp from "../expressions/index.js";
import {
  binary_from_function,
  build_default_decimal_type,
  build_formatted_time,
  build_like,
  build_replace_with_optional_replacement,
  build_timetostr_or_tochar,
  build_trunc,
  date_trunc_to_time,
  map_date_part,
} from "../dialects/dialect.js";

/**
 * py: expressions/core.py:2792 `_wrap(expression, kind)`.
 *
 * Module-private upstream and not re-exported by `expressions/index.js`; inlined here
 * for the two DIV0 builders that are its only callers in this file.
 */
function _wrap(expression, kind) {
  return expression instanceof kind ? new exp.Paren({ this: expression }) : expression;
}

/** py: sqlglot/parsers/snowflake.py:29 */
function _build_approx_top_k(args) {
  // Add default k=1 if only column is provided
  if (args.length === 1) args.push(exp.Literal.number(1));

  return exp.ApproxTopK.from_arg_list(args);
}

/** py: sqlglot/parsers/snowflake.py:44 */
function _build_to_number(args, safe = false) {
  const second_arg = seqGet(args, 1);
  let fmt;
  let precision;
  let scale;
  if (second_arg && second_arg.isNumber) {
    fmt = null;
    precision = second_arg;
    scale = seqGet(args, 2) || exp.Literal.number(0);
  } else {
    fmt = second_arg;
    precision = seqGet(args, 2) || exp.Literal.number(38);
    scale = seqGet(args, 3) || exp.Literal.number(0);
  }

  return new exp.ToNumber({
    this: seqGet(args, 0),
    format: fmt,
    precision,
    scale,
    safe,
  });
}

/** py: sqlglot/parsers/snowflake.py:64 */
function _build_date_from_parts(args) {
  return new exp.DateFromParts({
    year: seqGet(args, 0),
    month: seqGet(args, 1),
    day: seqGet(args, 2),
    allow_overflow: true,
  });
}

// py: sqlglot/parsers/snowflake.py:74 — Timestamp types used in _build_datetime
const TIMESTAMP_TYPES = new Map([
  [exp.DType.TIMESTAMP, "TO_TIMESTAMP"],
  [exp.DType.TIMESTAMPLTZ, "TO_TIMESTAMP_LTZ"],
  [exp.DType.TIMESTAMPNTZ, "TO_TIMESTAMP_NTZ"],
  [exp.DType.TIMESTAMPTZ, "TO_TIMESTAMP_TZ"],
]);

/** py: sqlglot/parsers/snowflake.py:82 */
function _build_datetime(name, kind, safe = false) {
  return function _builder(args, dialect) {
    const value = seqGet(args, 0);
    const scale_or_fmt = seqGet(args, 1);

    const int_value = value !== null && value !== undefined && isInt(value.name);
    const int_scale_or_fmt = scale_or_fmt !== null && scale_or_fmt !== undefined && scale_or_fmt.isInt;

    if ((value instanceof exp.Literal || value instanceof exp.Neg) || (value && scale_or_fmt)) {
      // Converts calls like `TO_TIME('01:02:03')` into casts
      if (args.length === 1 && value.isString && !int_value) {
        const cast = safe
          ? new exp.TryCast({ this: value, to: kind.into_expr(), requires_string: true })
          : exp.cast(value, kind);
        if (safe && kind === exp.DType.DATE) cast.set("probe_date_format", true);
        return cast;
      }

      // Handles `TO_TIMESTAMP(str, fmt)` and `TO_TIMESTAMP(num, scale)` as special
      // cases so we can transpile them, since they're relatively common
      if (TIMESTAMP_TYPES.has(kind)) {
        if (!safe && (int_scale_or_fmt || (int_value && (scale_or_fmt === null || scale_or_fmt === undefined)))) {
          // TRY_TO_TIMESTAMP('integer') is not parsed into exp.UnixToTime as
          // it's not easily transpilable. Also, numeric-looking strings with
          // format strings (e.g., TO_TIMESTAMP('20240115', 'YYYYMMDD')) should
          // use StrToTime, not UnixToTime.
          const unix_expr = new exp.UnixToTime({ this: value, scale: scale_or_fmt });
          unix_expr.set("target_type", kind.into_expr());
          return unix_expr;
        }
        if (scale_or_fmt && !int_scale_or_fmt) {
          // Format string provided (e.g., 'YYYY-MM-DD'), use StrToTime
          const strtotime_expr = build_formatted_time(exp.StrToTime)(args, dialect);
          strtotime_expr.set("safe", safe);
          strtotime_expr.set("target_type", kind.into_expr());
          return strtotime_expr;
        }
      }
    }

    // Handle DATE/TIME with format strings - allow int_value if a format string is provided
    const has_format_string = scale_or_fmt && !int_scale_or_fmt;
    if ((kind === exp.DType.DATE || kind === exp.DType.TIME) && (!int_value || has_format_string)) {
      const klass = kind === exp.DType.DATE ? exp.TsOrDsToDate : exp.TsOrDsToTime;
      const formatted_exp = build_formatted_time(klass)(args, dialect);
      formatted_exp.set("safe", safe);
      return formatted_exp;
    }

    return new exp.Anonymous({ this: name, expressions: args });
  };
}

/** py: sqlglot/parsers/snowflake.py:133 */
function _build_bitwise(expr_type, name) {
  return function _builder(args) {
    if (args.length === 3) {
      // Special handling for bitwise operations with padside argument
      if (expr_type === exp.BitwiseAnd || expr_type === exp.BitwiseOr || expr_type === exp.BitwiseXor) {
        return new expr_type({
          this: seqGet(args, 0), expression: seqGet(args, 1), padside: seqGet(args, 2),
        });
      }
      return new exp.Anonymous({ this: name, expressions: args });
    }

    const result = binary_from_function(expr_type)(args);

    // Snowflake specifies INT128 for bitwise shifts
    if (expr_type === exp.BitwiseLeftShift || expr_type === exp.BitwiseRightShift) {
      result.set("requires_int128", true);
    }

    return result;
  };
}

// https://docs.snowflake.com/en/sql-reference/functions/div0
/** py: sqlglot/parsers/snowflake.py:155 */
function _build_if_from_div0(args) {
  const lhs = _wrap(seqGet(args, 0), exp.Binary);
  const rhs = _wrap(seqGet(args, 1), exp.Binary);

  const cond = new exp.EQ({ this: rhs, expression: exp.Literal.number(0) })
    .and_(new exp.Is({ this: lhs, expression: exp.null_() }).not_());
  const true_ = exp.Literal.number(0);
  const false_ = new exp.Div({ this: lhs, expression: rhs });
  return new exp.If({ this: cond, true: true_, false: false_ });
}

// https://docs.snowflake.com/en/sql-reference/functions/div0null
/** py: sqlglot/parsers/snowflake.py:168 */
function _build_if_from_div0null(args) {
  const lhs = _wrap(seqGet(args, 0), exp.Binary);
  const rhs = _wrap(seqGet(args, 1), exp.Binary);

  // Returns 0 when divisor is 0 OR NULL
  const cond = new exp.EQ({ this: rhs, expression: exp.Literal.number(0) })
    .or_(new exp.Is({ this: rhs, expression: exp.null_() }));
  const true_ = exp.Literal.number(0);
  const false_ = new exp.Div({ this: lhs, expression: rhs });
  return new exp.If({ this: cond, true: true_, false: false_ });
}

// https://docs.snowflake.com/en/sql-reference/functions/zeroifnull
/** py: sqlglot/parsers/snowflake.py:182 */
function _build_if_from_zeroifnull(args) {
  const cond = new exp.Is({ this: seqGet(args, 0), expression: new exp.Null() });
  return new exp.If({ this: cond, true: exp.Literal.number(0), false: seqGet(args, 0) });
}

/** py: sqlglot/parsers/snowflake.py:187 */
function _build_search(args) {
  const kwargs = {
    this: seqGet(args, 0),
    expression: seqGet(args, 1),
  };
  for (const arg of args.slice(2)) if (arg instanceof exp.Kwarg) kwargs[arg.name.toLowerCase()] = arg;
  return new exp.Search(kwargs);
}

// https://docs.snowflake.com/en/sql-reference/functions/zeroifnull
/** py: sqlglot/parsers/snowflake.py:197 */
function _build_if_from_nullifzero(args) {
  const cond = new exp.EQ({ this: seqGet(args, 0), expression: exp.Literal.number(0) });
  return new exp.If({ this: cond, true: new exp.Null(), false: seqGet(args, 0) });
}

/** py: sqlglot/parsers/snowflake.py:202 */
function _build_regexp_replace(args) {
  const regexp_replace = exp.RegexpReplace.from_arg_list(args);

  if (!pyTruthy(regexp_replace.args.replacement)) {
    regexp_replace.set("replacement", exp.Literal.string(""));
  }

  return regexp_replace;
}

/** py: sqlglot/parsers/snowflake.py:211 */
function _build_regexp_like(args) {
  return new exp.RegexpLike({
    this: seqGet(args, 0),
    expression: seqGet(args, 1),
    flag: seqGet(args, 2),
    full_match: true,
  });
}

/** py: sqlglot/parsers/snowflake.py:220 */
function _date_trunc_to_time(args) {
  const trunc = date_trunc_to_time(args);
  const unit = map_date_part(trunc.args.unit);
  trunc.set("unit", unit);
  const is_time_input = trunc.this.isType(exp.DType.TIME, exp.DType.TIMETZ);
  if (
    ((trunc instanceof exp.TimestampTrunc && isDateUnit(unit)) || is_time_input)
    || (trunc instanceof exp.DateTrunc && !isDateUnit(unit))
  ) {
    trunc.set("input_type_preserved", true);
  }
  return trunc;
}

/** py: sqlglot/parsers/snowflake.py:232 */
function _build_regexp_extract(expr_type) {
  return function _builder(args, dialect) {
    const kwargs = {
      this: seqGet(args, 0),
      expression: seqGet(args, 1),
      position: seqGet(args, 2),
      occurrence: seqGet(args, 3),
      parameters: seqGet(args, 4),
      group: seqGet(args, 5) || exp.Literal.number(0),
    };
    if (expr_type === exp.RegexpExtract) {
      kwargs.null_if_pos_overflow = dialect.REGEXP_EXTRACT_POSITION_OVERFLOW_RETURNS_NULL;
    }
    return new expr_type(kwargs);
  };
}

/**
 * py: sqlglot/parsers/snowflake.py:251
 *
 * Build TimestampFromParts with support for both syntaxes:
 * 1. TIMESTAMP_FROM_PARTS(year, month, day, hour, minute, second [, nanosecond] [, time_zone])
 * 2. TIMESTAMP_FROM_PARTS(date_expr, time_expr) - Snowflake specific
 */
function _build_timestamp_from_parts(args) {
  if (args.length === 2) {
    return new exp.TimestampFromParts({ this: seqGet(args, 0), expression: seqGet(args, 1) });
  }

  return exp.TimestampFromParts.from_arg_list(args);
}

/**
 * py: sqlglot/parsers/snowflake.py:262
 *
 * Build Round expression, unwrapping Snowflake's named parameters.
 * Maps EXPR => this, SCALE => decimals, ROUNDING_MODE => truncate.
 *
 * Note: Snowflake does not support mixing named and positional arguments.
 * Arguments are either all named or all positional.
 */
function _build_round(args) {
  const kwarg_map = new Map([["EXPR", "this"], ["SCALE", "decimals"], ["ROUNDING_MODE", "truncate"]]);
  const round_args = {};
  const positional_keys = ["this", "decimals", "truncate"];
  let positional_idx = 0;

  for (const arg of args) {
    if (arg instanceof exp.Kwarg) {
      const key = pyUpper(arg.this.name);
      const round_key = kwarg_map.get(key);
      if (round_key) round_args[round_key] = arg.expression;
    } else if (positional_idx < positional_keys.length) {
      round_args[positional_keys[positional_idx]] = arg;
      positional_idx += 1;
    }
  }

  const expression = new exp.Round(round_args);
  expression.set("casts_non_integer_decimals", true);
  return expression;
}

/** py: sqlglot/parsers/snowflake.py:292 */
function _build_array_sort(args) {
  const asc = seqGet(args, 1);
  let nulls_first = seqGet(args, 2);
  if ((nulls_first === null || nulls_first === undefined) && asc instanceof exp.Boolean) {
    nulls_first = new exp.Boolean({ this: !asc.this });
  }
  return new exp.SortArray({ this: seqGet(args, 0), asc, nulls_first });
}

/**
 * py: sqlglot/parsers/snowflake.py:300
 *
 * Build Generator expression, unwrapping Snowflake's named parameters.
 * Maps ROWCOUNT => rowcount, TIMELIMIT => timelimit.
 */
function _build_generator(args) {
  const kwarg_map = new Map([["ROWCOUNT", "rowcount"], ["TIMELIMIT", "timelimit"]]);
  const gen_args = {};

  const positional_keys = ["rowcount", "timelimit"];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg instanceof exp.Kwarg) {
      const key = pyUpper(arg.this.name);
      const gen_key = kwarg_map.get(key);
      if (gen_key) gen_args[gen_key] = arg.expression;
    } else if (i < positional_keys.length) {
      gen_args[positional_keys[i]] = arg;
    }
  }

  return new exp.Generator(gen_args);
}

/**
 * py: sqlglot/parsers/snowflake.py:323
 *
 * `_show_parser(*args, **kwargs)`. Only `this` is ever passed positionally upstream,
 * and only `terse`/`iceberg` by keyword, so the keywords arrive as a trailing options
 * object (the same deviation `helper.csv` records in CONTRACTS.md §8).
 */
function _show_parser(this_, kwargs = {}) {
  return function _parse(self) {
    return self._parse_show_snowflake(this_, kwargs.terse ?? false, kwargs.iceberg ?? false);
  };
}


/** py: sqlglot/parsers/snowflake.py:330 */
export class SnowflakeParser extends Parser {
  /* py:331 */ static IDENTIFY_PIVOT_STRINGS = true;
  /* py:332 */ static TYPED_LAMBDA_ARGS = true;
  /* py:333 */ static DEFAULT_SAMPLING_METHOD = "BERNOULLI";
  /* py:334 */ static COLON_IS_VARIANT_EXTRACT = true;
  /* py:335 */ static JSON_EXTRACT_REQUIRES_JSON_EXPRESSION = true;
  /* py:336 */ static SUPPORTS_NTH_VALUE_FROM_MODIFIER = true;

  /* py:338 */ static TYPE_TOKENS = new Set([...Parser.TYPE_TOKENS, TokenType.FILE]);
  /* py:339 */ static STRUCT_TYPE_TOKENS = new Set([...Parser.STRUCT_TYPE_TOKENS, TokenType.FILE]);
  /* py:340 */ static NESTED_TYPE_TOKENS = new Set([...Parser.NESTED_TYPE_TOKENS, TokenType.FILE]);

  /** py: sqlglot/parsers/snowflake.py:342 */
  static ID_VAR_TOKENS = new Set([
    /* py:343 */ ...Parser.ID_VAR_TOKENS,
    /* py:344 */ TokenType.EXCEPT,
    /* py:345 */ TokenType.INTEGRATION,
    /* py:346 */ TokenType.MATCH_CONDITION,
    /* py:347 */ TokenType.PACKAGE,
    /* py:348 */ TokenType.POLICY,
    /* py:349 */ TokenType.POOL,
    /* py:350 */ TokenType.ROLE,
    /* py:351 */ TokenType.RULE,
    /* py:352 */ TokenType.VOLUME,
  ]);

  /** py: sqlglot/parsers/snowflake.py:355 */
  static ALIAS_TOKENS = setUnion(Parser.ALIAS_TOKENS, new Set([
    /* py:356 */ TokenType.INTEGRATION,
    /* py:357 */ TokenType.PACKAGE,
    /* py:358 */ TokenType.POLICY,
    /* py:359 */ TokenType.POOL,
    /* py:360 */ TokenType.ROLE,
    /* py:361 */ TokenType.RULE,
    /* py:362 */ TokenType.VOLUME,
  ]));

  /** py: sqlglot/parsers/snowflake.py:365 */
  static TABLE_ALIAS_TOKENS = setDiff(
    setUnion(Parser.TABLE_ALIAS_TOKENS, new Set([
      /* py:368 */ TokenType.ANTI,
      /* py:369 */ TokenType.INTEGRATION,
      /* py:370 */ TokenType.PACKAGE,
      /* py:371 */ TokenType.POLICY,
      /* py:372 */ TokenType.POOL,
      /* py:373 */ TokenType.ROLE,
      /* py:374 */ TokenType.RULE,
      /* py:375 */ TokenType.SEMI,
      /* py:376 */ TokenType.VOLUME,
      /* py:377 */ TokenType.WINDOW,
    ])),
    /* py:379 */ new Set([TokenType.MATCH_CONDITION]),
  );

  // py:381 — `ID_VAR_TOKENS` unqualified in the Python class body is THIS class's
  // override (py:342), not `parser.Parser`'s. `this` in a static field initializer is
  // the class under construction and the field above has already run, so it reads the
  // same value.
  /* py:381 */ static COLON_PLACEHOLDER_TOKENS = setUnion(this.ID_VAR_TOKENS, new Set([TokenType.NUMBER]));

  /** py: sqlglot/parsers/snowflake.py:383 */
  static NO_PAREN_FUNCTIONS = new Map([
    /* py:384 */ ...Parser.NO_PAREN_FUNCTIONS,
    /* py:385 */ [TokenType.LOCALTIME, exp.Localtime],
    /* py:386 */ [TokenType.LOCALTIMESTAMP, exp.Localtimestamp],
    /* py:387 */ [TokenType.CURRENT_TIME, exp.Localtime],
  ]);

  /** py: sqlglot/parsers/snowflake.py:390 */
  static RANGE_PARSERS = new Map([
    /* py:391 */ ...Parser.RANGE_PARSERS,
    /* py:392 */ [TokenType.RLIKE, (self, this_) => self.expression(
      new exp.RegexpLike({ this: this_, expression: self._parse_bitwise(), full_match: true }),
    )],
  ]);

  /** py: sqlglot/parsers/snowflake.py:397 */
  static FUNCTIONS = new Map([
    /* py:398 */ ...Parser.FUNCTIONS,
    /* py:399 */ ["CHARINDEX", (args) => new exp.StrPosition({
      this: seqGet(args, 1),
      substr: seqGet(args, 0),
      position: seqGet(args, 2),
      clamp_position: true,
    })],
    /* py:405 */ ["ADD_MONTHS", (args) => new exp.AddMonths({
      this: seqGet(args, 0),
      expression: seqGet(args, 1),
      preserve_end_of_month: true,
    })],
    /* py:410 */ ["APPROX_PERCENTILE", exp.ApproxQuantile.from_arg_list],
    /* py:411 */ ["CURRENT_TIME", (args) => new exp.Localtime({ this: seqGet(args, 0) })],
    /* py:412 */ ["APPROX_TOP_K", _build_approx_top_k],
    /* py:413 */ ["ARRAY_CONSTRUCT", (args) => new exp.Array({ expressions: args })],
    /* py:414 */ ["ARRAY_CONTAINS", (args) => new exp.ArrayContains({
      this: seqGet(args, 1),
      expression: seqGet(args, 0),
      ensure_variant: false,
      check_null: true,
    })],
    /* py:420 */ ["ARRAY_DISTINCT", (args) => new exp.ArrayDistinct({
      this: seqGet(args, 0),
      check_null: true,
    })],
    /* py:424 */ ["ARRAY_GENERATE_RANGE", (args) => new exp.GenerateSeries({
      // Snowflake has exclusive end semantics
      start: seqGet(args, 0),
      end: seqGet(args, 1),
      step: seqGet(args, 2),
      is_end_exclusive: true,
    })],
    /* py:431 */ ["ARRAY_EXCEPT", (args) => new exp.ArrayExcept({
      this: seqGet(args, 0),
      expression: seqGet(args, 1),
      is_multiset: true,
    })],
    /* py:436 */ ["ARRAY_INTERSECTION", (args) => new exp.ArrayIntersect({
      expressions: args,
      is_multiset: true,
    })],
    /* py:440 */ ["ARRAY_POSITION", (args) => new exp.ArrayPosition({
      this: seqGet(args, 1),
      expression: seqGet(args, 0),
      zero_based: true,
    })],
    /* py:445 */ ["ARRAY_SLICE", (args) => new exp.ArraySlice({
      this: seqGet(args, 0),
      start: seqGet(args, 1),
      end: seqGet(args, 2),
      zero_based: true,
    })],
    /* py:451 */ ["ARRAY_SORT", _build_array_sort],
    /* py:452 */ ["ARRAY_FLATTEN", exp.Flatten.from_arg_list],
    /* py:453 */ ["ARRAY_TO_STRING", (args) => new exp.ArrayToString({
      this: seqGet(args, 0),
      expression: seqGet(args, 1),
      null_is_empty: true,
      null_delim_is_null: true,
    })],
    /* py:459 */ ["ARRAYS_OVERLAP", (args) => new exp.ArrayOverlaps({
      this: seqGet(args, 0), expression: seqGet(args, 1), null_safe: true,
    })],
    /* py:462 */ ["BITAND", _build_bitwise(exp.BitwiseAnd, "BITAND")],
    /* py:463 */ ["BIT_AND", _build_bitwise(exp.BitwiseAnd, "BITAND")],
    /* py:464 */ ["BITNOT", (args) => new exp.BitwiseNot({ this: seqGet(args, 0) })],
    /* py:465 */ ["BIT_NOT", (args) => new exp.BitwiseNot({ this: seqGet(args, 0) })],
    /* py:466 */ ["BITXOR", _build_bitwise(exp.BitwiseXor, "BITXOR")],
    /* py:467 */ ["BIT_XOR", _build_bitwise(exp.BitwiseXor, "BITXOR")],
    /* py:468 */ ["BITOR", _build_bitwise(exp.BitwiseOr, "BITOR")],
    /* py:469 */ ["BIT_OR", _build_bitwise(exp.BitwiseOr, "BITOR")],
    /* py:470 */ ["BITSHIFTLEFT", _build_bitwise(exp.BitwiseLeftShift, "BITSHIFTLEFT")],
    /* py:471 */ ["BIT_SHIFTLEFT", _build_bitwise(exp.BitwiseLeftShift, "BIT_SHIFTLEFT")],
    /* py:472 */ ["BITSHIFTRIGHT", _build_bitwise(exp.BitwiseRightShift, "BITSHIFTRIGHT")],
    /* py:473 */ ["BIT_SHIFTRIGHT", _build_bitwise(exp.BitwiseRightShift, "BIT_SHIFTRIGHT")],
    /* py:474 */ ["BITANDAGG", exp.BitwiseAndAgg.from_arg_list],
    /* py:475 */ ["BITAND_AGG", exp.BitwiseAndAgg.from_arg_list],
    /* py:476 */ ["BIT_AND_AGG", exp.BitwiseAndAgg.from_arg_list],
    /* py:477 */ ["BIT_ANDAGG", exp.BitwiseAndAgg.from_arg_list],
    /* py:478 */ ["BITORAGG", exp.BitwiseOrAgg.from_arg_list],
    /* py:479 */ ["BITOR_AGG", exp.BitwiseOrAgg.from_arg_list],
    /* py:480 */ ["BIT_OR_AGG", exp.BitwiseOrAgg.from_arg_list],
    /* py:481 */ ["BIT_ORAGG", exp.BitwiseOrAgg.from_arg_list],
    /* py:482 */ ["BITXORAGG", exp.BitwiseXorAgg.from_arg_list],
    /* py:483 */ ["BITXOR_AGG", exp.BitwiseXorAgg.from_arg_list],
    /* py:484 */ ["BIT_XOR_AGG", exp.BitwiseXorAgg.from_arg_list],
    /* py:485 */ ["BIT_XORAGG", exp.BitwiseXorAgg.from_arg_list],
    /* py:486 */ ["BITMAP_OR_AGG", exp.BitmapOrAgg.from_arg_list],
    /* py:487 */ ["BOOLAND", (args) => new exp.Booland({
      this: seqGet(args, 0), expression: seqGet(args, 1), round_input: true,
    })],
    /* py:490 */ ["BOOLOR", (args) => new exp.Boolor({
      this: seqGet(args, 0), expression: seqGet(args, 1), round_input: true,
    })],
    /* py:493 */ ["BOOLNOT", (args) => new exp.Boolnot({ this: seqGet(args, 0), round_input: true })],
    /* py:494 */ ["BOOLXOR", (args) => new exp.Xor({
      this: seqGet(args, 0), expression: seqGet(args, 1), round_input: true,
    })],
    /* py:497 */ ["CORR", (args) => new exp.Corr({
      this: seqGet(args, 0),
      expression: seqGet(args, 1),
      null_on_zero_variance: true,
    })],
    /* py:502 */ ["COUNT_IF", (args) => new exp.CountIf({ this: seqGet(args, 0), zero_on_all_null: true })],
    /* py:503 */ ["DATE", _build_datetime("DATE", exp.DType.DATE)],
    /* py:504 */ ["DATEFROMPARTS", _build_date_from_parts],
    /* py:505 */ ["DATE_FROM_PARTS", _build_date_from_parts],
    /* py:506 */ ["DATE_TRUNC", _date_trunc_to_time],
    /* py:507 */ ["DATEADD", (args) => new exp.DateAdd({
      this: seqGet(args, 2),
      expression: seqGet(args, 1),
      unit: map_date_part(seqGet(args, 0)),
    })],
    /* py:512 */ ["DATEDIFF", (args) => new exp.DateDiff({
      this: seqGet(args, 2),
      expression: seqGet(args, 1),
      unit: map_date_part(seqGet(args, 0)),
      date_part_boundary: true,
    })],
    /* py:518 */ ["DAYNAME", (args) => new exp.Dayname({ this: seqGet(args, 0), abbreviated: true })],
    /* py:519 */ ["DAYOFWEEKISO", exp.DayOfWeekIso.from_arg_list],
    /* py:520 */ ["DIV0", _build_if_from_div0],
    /* py:521 */ ["DIV0NULL", _build_if_from_div0null],
    /* py:522 */ ["EDITDISTANCE", (args) => new exp.Levenshtein({
      this: seqGet(args, 0), expression: seqGet(args, 1), max_dist: seqGet(args, 2),
    })],
    /* py:525 */ ["FLATTEN", exp.Explode.from_arg_list],
    /* py:526 */ ["GENERATOR", _build_generator],
    /* py:527 */ ["GET", exp.GetExtract.from_arg_list],
    /* py:528 */ ["GETDATE", exp.CurrentTimestamp.from_arg_list],
    /* py:529 */ ["GET_PATH", (args, dialect) => new exp.JSONExtract({
      this: seqGet(args, 0),
      expression: dialect.to_json_path(seqGet(args, 1)),
      requires_json: true,
    })],
    /* py:534 */ ["GREATEST_IGNORE_NULLS", (args) => new exp.Greatest({
      this: seqGet(args, 0), expressions: args.slice(1), ignore_nulls: true,
    })],
    /* py:537 */ ["LEAST_IGNORE_NULLS", (args) => new exp.Least({
      this: seqGet(args, 0), expressions: args.slice(1), ignore_nulls: true,
    })],
    /* py:540 */ ["LEFT", (args) => new exp.Left({
      this: seqGet(args, 0), expression: seqGet(args, 1), negative_length_returns_empty: true,
    })],
    /* py:543 */ ["HEX_DECODE_BINARY", exp.Unhex.from_arg_list],
    /* py:544 */ ["HEX_ENCODE", exp.Hex.from_arg_list],
    /* py:545 */ ["IFF", exp.If.from_arg_list],
    /* py:546 */ ["JAROWINKLER_SIMILARITY", (args) => new exp.JarowinklerSimilarity({
      this: seqGet(args, 0),
      expression: seqGet(args, 1),
      case_insensitive: true,
      integer_scale: true,
    })],
    /* py:552 */ ["MD5_HEX", exp.MD5.from_arg_list],
    /* py:553 */ ["MD5_BINARY", exp.MD5Digest.from_arg_list],
    /* py:554 */ ["MD5_NUMBER_LOWER64", exp.MD5NumberLower64.from_arg_list],
    /* py:555 */ ["MD5_NUMBER_UPPER64", exp.MD5NumberUpper64.from_arg_list],
    /* py:556 */ ["MONTHNAME", (args) => new exp.Monthname({ this: seqGet(args, 0), abbreviated: true })],
    /* py:557 */ ["LAST_DAY", (args) => new exp.LastDay({
      this: seqGet(args, 0), unit: map_date_part(seqGet(args, 1)),
    })],
    /* py:560 */ ["LEN", (args) => new exp.Length({ this: seqGet(args, 0), binary: true })],
    /* py:561 */ ["LENGTH", (args) => new exp.Length({ this: seqGet(args, 0), binary: true })],
    /* py:562 */ ["LOCALTIMESTAMP", exp.CurrentTimestamp.from_arg_list],
    /* py:563 */ ["NULLIFZERO", _build_if_from_nullifzero],
    /* py:564 */ ["OBJECT_CONSTRUCT", (args) => build_object_construct(args)],
    /* py:565 */ ["OBJECT_KEYS", exp.JSONKeys.from_arg_list],
    /* py:566 */ ["OCTET_LENGTH", exp.ByteLength.from_arg_list],
    /* py:567 */ ["PARSE_URL", (args) => new exp.ParseUrl({ this: seqGet(args, 0), permissive: seqGet(args, 1) })],
    /* py:568 */ ["REGEXP_EXTRACT_ALL", _build_regexp_extract(exp.RegexpExtractAll)],
    /* py:569 */ ["REGEXP_LIKE", _build_regexp_like],
    /* py:570 */ ["REGEXP_REPLACE", _build_regexp_replace],
    /* py:571 */ ["REGEXP_SUBSTR", _build_regexp_extract(exp.RegexpExtract)],
    /* py:572 */ ["REGEXP_SUBSTR_ALL", _build_regexp_extract(exp.RegexpExtractAll)],
    /* py:573 */ ["RANDOM", (args) => new exp.Rand({
      this: seqGet(args, 0),
      lower: exp.Literal.number(-9223372036854775808.0), // -2^63 as float to avoid overflow
      upper: exp.Literal.number(9223372036854775807.0), // 2^63-1 as float
    })],
    /* py:578 */ ["REPLACE", build_replace_with_optional_replacement],
    /* py:579 */ ["RIGHT", (args) => new exp.Right({
      this: seqGet(args, 0), expression: seqGet(args, 1), negative_length_returns_empty: true,
    })],
    /* py:582 */ ["RLIKE", _build_regexp_like],
    /* py:583 */ ["ROUND", _build_round],
    /* py:584 */ ["SHA1_BINARY", exp.SHA1Digest.from_arg_list],
    /* py:585 */ ["SHA1_HEX", exp.SHA.from_arg_list],
    /* py:586 */ ["SHA2_BINARY", exp.SHA2Digest.from_arg_list],
    /* py:587 */ ["SHA2_HEX", exp.SHA2.from_arg_list],
    /* py:588 */ ["SPLIT", (args) => new exp.Split({
      this: seqGet(args, 0),
      expression: seqGet(args, 1),
      null_returns_null: true,
      empty_delimiter_returns_whole: true,
    })],
    /* py:594 */ ["SQUARE", (args) => new exp.Pow({ this: seqGet(args, 0), expression: exp.Literal.number(2) })],
    /* py:595 */ ["STDDEV_SAMP", exp.Stddev.from_arg_list],
    /* py:596 */ ["SYSDATE", (args) => new exp.CurrentTimestamp({ this: seqGet(args, 0), sysdate: true })],
    /* py:597 */ ["TABLE", (args) => new exp.TableFromRows({ this: seqGet(args, 0) })],
    /* py:598 */ ["TIMEADD", (args) => new exp.TimeAdd({
      this: seqGet(args, 2),
      expression: seqGet(args, 1),
      unit: map_date_part(seqGet(args, 0)),
    })],
    /* py:603 */ ["TIMEDIFF", (args) => new exp.DateDiff({
      this: seqGet(args, 2),
      expression: seqGet(args, 1),
      unit: map_date_part(seqGet(args, 0)),
      date_part_boundary: true,
    })],
    /* py:609 */ ["TIME_FROM_PARTS", (args) => new exp.TimeFromParts({
      hour: seqGet(args, 0),
      min: seqGet(args, 1),
      sec: seqGet(args, 2),
      nano: seqGet(args, 3),
      overflow: true,
    })],
    /* py:616 */ ["TIMESTAMPADD", (args) => new exp.DateAdd({
      this: seqGet(args, 2),
      expression: seqGet(args, 1),
      unit: map_date_part(seqGet(args, 0)),
    })],
    /* py:621 */ ["TIMESTAMPDIFF", (args) => new exp.DateDiff({
      this: seqGet(args, 2),
      expression: seqGet(args, 1),
      unit: map_date_part(seqGet(args, 0)),
      date_part_boundary: true,
    })],
    /* py:627 */ ["TIMESTAMPFROMPARTS", _build_timestamp_from_parts],
    /* py:628 */ ["TIMESTAMP_FROM_PARTS", _build_timestamp_from_parts],
    /* py:629 */ ["TIMESTAMPNTZFROMPARTS", _build_timestamp_from_parts],
    /* py:630 */ ["TIMESTAMP_NTZ_FROM_PARTS", _build_timestamp_from_parts],
    /* py:631 */ ["TRUNC", (args, dialect) => build_trunc(
      args, dialect, { date_trunc_requires_part: false, fractions_supported: true },
    )],
    /* py:634 */ ["TRUNCATE", (args, dialect) => build_trunc(
      args, dialect, { date_trunc_requires_part: false, fractions_supported: true },
    )],
    /* py:637 */ ["TRY_DECRYPT", (args) => new exp.Decrypt({
      this: seqGet(args, 0),
      passphrase: seqGet(args, 1),
      aad: seqGet(args, 2),
      encryption_method: seqGet(args, 3),
      safe: true,
    })],
    /* py:644 */ ["TRY_DECRYPT_RAW", (args) => new exp.DecryptRaw({
      this: seqGet(args, 0),
      key: seqGet(args, 1),
      iv: seqGet(args, 2),
      aad: seqGet(args, 3),
      encryption_method: seqGet(args, 4),
      aead: seqGet(args, 5),
      safe: true,
    })],
    /* py:653 */ ["TRY_PARSE_JSON", (args) => new exp.ParseJSON({ this: seqGet(args, 0), safe: true })],
    /* py:654 */ ["TRY_TO_BINARY", (args) => new exp.ToBinary({
      this: seqGet(args, 0), format: seqGet(args, 1), safe: true,
    })],
    /* py:657 */ ["TRY_TO_BOOLEAN", (args) => new exp.ToBoolean({ this: seqGet(args, 0), safe: true })],
    /* py:658 */ ["TRY_TO_DATE", _build_datetime("TRY_TO_DATE", exp.DType.DATE, true)],
    // py:659 `**dict.fromkeys((...), lambda args: _build_to_number(args, safe=True))`
    /* py:660 */ ["TRY_TO_DECIMAL", (args) => _build_to_number(args, true)],
    /* py:660 */ ["TRY_TO_NUMBER", (args) => _build_to_number(args, true)],
    /* py:660 */ ["TRY_TO_NUMERIC", (args) => _build_to_number(args, true)],
    /* py:663 */ ["TRY_TO_DOUBLE", (args) => new exp.ToDouble({
      this: seqGet(args, 0), format: seqGet(args, 1), safe: true,
    })],
    /* py:666 */ ["TRY_TO_FILE", (args) => new exp.ToFile({
      this: seqGet(args, 0), path: seqGet(args, 1), safe: true,
    })],
    /* py:669 */ ["TRY_TO_TIME", _build_datetime("TRY_TO_TIME", exp.DType.TIME, true)],
    /* py:670 */ ["TRY_TO_TIMESTAMP", _build_datetime("TRY_TO_TIMESTAMP", exp.DType.TIMESTAMP, true)],
    /* py:671 */ ["TRY_TO_TIMESTAMP_LTZ", _build_datetime("TRY_TO_TIMESTAMP_LTZ", exp.DType.TIMESTAMPLTZ, true)],
    /* py:674 */ ["TRY_TO_TIMESTAMP_NTZ", _build_datetime("TRY_TO_TIMESTAMP_NTZ", exp.DType.TIMESTAMPNTZ, true)],
    /* py:677 */ ["TRY_TO_TIMESTAMP_TZ", _build_datetime("TRY_TO_TIMESTAMP_TZ", exp.DType.TIMESTAMPTZ, true)],
    /* py:680 */ ["TO_CHAR", build_timetostr_or_tochar],
    /* py:681 */ ["TO_DATE", _build_datetime("TO_DATE", exp.DType.DATE)],
    // py:682 `**dict.fromkeys((...), lambda args: _build_to_number(args))`
    /* py:683 */ ["TO_DECIMAL", (args) => _build_to_number(args)],
    /* py:683 */ ["TO_NUMBER", (args) => _build_to_number(args)],
    /* py:683 */ ["TO_NUMERIC", (args) => _build_to_number(args)],
    /* py:686 */ ["TO_TIME", _build_datetime("TO_TIME", exp.DType.TIME)],
    /* py:687 */ ["TO_TIMESTAMP", _build_datetime("TO_TIMESTAMP", exp.DType.TIMESTAMP)],
    /* py:688 */ ["TO_TIMESTAMP_LTZ", _build_datetime("TO_TIMESTAMP_LTZ", exp.DType.TIMESTAMPLTZ)],
    /* py:689 */ ["TO_TIMESTAMP_NTZ", _build_datetime("TO_TIMESTAMP_NTZ", exp.DType.TIMESTAMPNTZ)],
    /* py:690 */ ["TO_TIMESTAMP_TZ", _build_datetime("TO_TIMESTAMP_TZ", exp.DType.TIMESTAMPTZ)],
    /* py:691 */ ["TO_GEOGRAPHY", (args) => (
      args.length === 1
        ? exp.cast(args[0], exp.DType.GEOGRAPHY)
        : new exp.Anonymous({ this: "TO_GEOGRAPHY", expressions: args })
    )],
    /* py:696 */ ["TO_GEOMETRY", (args) => (
      args.length === 1
        ? exp.cast(args[0], exp.DType.GEOMETRY)
        : new exp.Anonymous({ this: "TO_GEOMETRY", expressions: args })
    )],
    /* py:701 */ ["TO_VARCHAR", build_timetostr_or_tochar],
    /* py:702 */ ["TO_JSON", exp.JSONFormat.from_arg_list],
    /* py:703 */ ["VECTOR_COSINE_SIMILARITY", exp.CosineDistance.from_arg_list],
    /* py:704 */ ["VECTOR_INNER_PRODUCT", exp.DotProduct.from_arg_list],
    /* py:705 */ ["VECTOR_L1_DISTANCE", exp.ManhattanDistance.from_arg_list],
    /* py:706 */ ["VECTOR_L2_DISTANCE", exp.EuclideanDistance.from_arg_list],
    /* py:707 */ ["ZEROIFNULL", _build_if_from_zeroifnull],
    /* py:708 */ ["LIKE", build_like(exp.Like)],
    /* py:709 */ ["ILIKE", build_like(exp.ILike)],
    /* py:710 */ ["SEARCH", _build_search],
    /* py:711 */ ["SKEW", exp.Skewness.from_arg_list],
    /* py:712 */ ["SPLIT_PART", (args) => new exp.SplitPart({
      this: seqGet(args, 0),
      delimiter: seqGet(args, 1),
      part_index: seqGet(args, 2),
      part_index_zero_as_one: true,
      empty_delimiter_returns_whole: true,
    })],
    /* py:719 */ ["STRTOK", (args) => new exp.Strtok({
      this: seqGet(args, 0),
      delimiter: seqGet(args, 1) || exp.Literal.string(" "),
      part_index: seqGet(args, 2) || exp.Literal.number("1"),
    })],
    /* py:724 */ ["STRTOK_TO_ARRAY", (args) => new exp.StrtokToArray({
      this: seqGet(args, 0),
      expression: seqGet(args, 1) || exp.Literal.string(" "),
    })],
    /* py:728 */ ["SYSTIMESTAMP", exp.CurrentTimestamp.from_arg_list],
    /* py:729 */ ["IDENTIFIER", exp.DynamicIdentifier.from_arg_list],
    /* py:730 */ ["UNICODE", (args) => new exp.Unicode({ this: seqGet(args, 0), empty_is_zero: true })],
    /* py:731 */ ["WEEKISO", exp.WeekOfYear.from_arg_list],
    /* py:732 */ ["WEEKOFYEAR", exp.Week.from_arg_list],
  ]);

  // py:734 `FUNCTIONS = {k: v for k, v in FUNCTIONS.items() if k != "PREDICT"}` — a
  // SECOND assignment to the same class attribute, dropping one key the base parser
  // defines. It reads like a duplicate definition and is easy to miss; JS allows the
  // same duplicate static declaration, and `this.FUNCTIONS` here reads the value the
  // initializer above just produced, so the two lines transliterate one-for-one.
  /* py:734 */ static FUNCTIONS = new Map([...this.FUNCTIONS].filter(([k]) => k !== "PREDICT"));

  /** py: sqlglot/parsers/snowflake.py:736 */
  static FUNCTION_PARSERS = new Map([
    /* py:737 */ ...Parser.FUNCTION_PARSERS,
    /* py:738 */ ["DATE_PART", (self) => self._parse_date_part()],
    /* py:739 */ ["DIRECTORY", (self) => self._parse_directory()],
    /* py:740 */ ["OBJECT_CONSTRUCT_KEEP_NULL", (self) => self._parse_json_object()],
    /* py:741 */ ["LISTAGG", (self) => self._parse_string_agg()],
    /* py:742 */ ["SEMANTIC_VIEW", (self) => self._parse_semantic_view()],
    /* py:743 */ ["SUBSTR", (self) => self._parse_substring()],
  ]);

  /* py:745 */ static FUNCTION_PARSERS = new Map([...this.FUNCTION_PARSERS].filter(([k]) => k !== "TRIM"));

  /* py:747 */ static TIMESTAMPS = setDiff(Parser.TIMESTAMPS, new Set([TokenType.TIME]));

  /** py: sqlglot/parsers/snowflake.py:749 */
  static ALTER_PARSERS = new Map([
    /* py:750 */ ...Parser.ALTER_PARSERS,
    /* py:751 */ ["MODIFY", (self) => self._parse_alter_table_alter()],
    /* py:752 */ ["SESSION", (self) => self._parse_alter_session()],
    /* py:753 */ ["UNSET", (self) => self.expression(new exp.Set({
      tag: self._match_text_seq("TAG"),
      expressions: self._parse_csv(() => self._parse_id_var()),
      unset: true,
    }))],
  ]);

  /** py: sqlglot/parsers/snowflake.py:762 */
  static STATEMENT_PARSERS = new Map([
    /* py:763 */ ...Parser.STATEMENT_PARSERS,
    /* py:764 */ [TokenType.GET, (self) => self._parse_get()],
    /* py:765 */ [TokenType.PUT, (self) => self._parse_put()],
    /* py:766 */ [TokenType.SHOW, (self) => self._parse_show()],
    /* py:767 */ [TokenType.UNDROP, (self) => self._parse_undrop()],
  ]);

  /** py: sqlglot/parsers/snowflake.py:770 */
  static PROPERTY_PARSERS = new Map([
    /* py:771 */ ...Parser.PROPERTY_PARSERS,
    /* py:772 */ ["CREDENTIALS", (self) => self._parse_credentials_property()],
    /* py:773 */ ["FILE_FORMAT", (self) => self._parse_file_format_property()],
    /* py:774 */ ["LOCATION", (self) => self._parse_location_property()],
    /* py:775 */ ["ROW", (self) => (
      self._match_text_seq("ACCESS", "POLICY")
        ? self._parse_row_access_policy()
        : self._parse_row()
    )],
    /* py:780 */ ["TAG", (self) => self._parse_tag()],
    /* py:781 */ ["USING", (self) => (
      self._match_text_seq("TEMPLATE")
      && self.expression(new exp.UsingTemplateProperty({ this: self._parse_statement() }))
    )],
  ]);

  /** py: sqlglot/parsers/snowflake.py:787 */
  static DESCRIBE_QUALIFIER_PARSERS = new Map([
    /* py:788 */ ["API", (self) => self.expression(new exp.ApiProperty())],
    /* py:789 */ ["APPLICATION", (self) => self.expression(new exp.ApplicationProperty())],
    /* py:790 */ ["CATALOG", (self) => self.expression(new exp.CatalogProperty())],
    /* py:791 */ ["COMPUTE", (self) => self.expression(new exp.ComputeProperty())],
    /* py:792 */ ["DATABASE", (self) => (
      self._curr.bool() && pyUpper(self._curr.text) === "ROLE"
        ? self.expression(new exp.DatabaseProperty())
        : null
    )],
    /* py:797 */ ["DYNAMIC", (self) => self.expression(new exp.DynamicProperty())],
    /* py:798 */ ["EXTERNAL", (self) => self.expression(new exp.ExternalProperty())],
    /* py:799 */ ["HYBRID", (self) => self.expression(new exp.HybridProperty())],
    /* py:800 */ ["ICEBERG", (self) => self.expression(new exp.IcebergProperty())],
    /* py:801 */ ["MASKING", (self) => self.expression(new exp.MaskingProperty())],
    /* py:802 */ ["MATERIALIZED", (self) => self.expression(new exp.MaterializedProperty())],
    /* py:803 */ ["NETWORK", (self) => self.expression(new exp.NetworkProperty())],
    /* py:804 */ ["ROW", (self) => (
      self._match_text_seq("ACCESS") ? self.expression(new exp.RowAccessProperty()) : null
    )],
    /* py:807 */ ["SECURITY", (self) => (
      self._curr.bool() && pyUpper(self._curr.text) === "INTEGRATION"
        ? self.expression(new exp.SecurityIntegrationProperty())
        : null
    )],
  ]);

  /** py: sqlglot/parsers/snowflake.py:814 */
  static TYPE_CONVERTERS = new Map([
    // https://docs.snowflake.com/en/sql-reference/data-types-numeric#number
    /* py:816 */ [exp.DType.DECIMAL, build_default_decimal_type(38, 0)],
  ]);

  /** py: sqlglot/parsers/snowflake.py:819 */
  static SHOW_PARSERS = new Map([
    /* py:820 */ ["DATABASES", _show_parser("DATABASES")],
    /* py:821 */ ["SCHEMAS", _show_parser("SCHEMAS")],
    /* py:822 */ ["OBJECTS", _show_parser("OBJECTS")],
    /* py:823 */ ["TABLES", _show_parser("TABLES")],
    /* py:824 */ ["VIEWS", _show_parser("VIEWS")],
    /* py:825 */ ["PRIMARY KEYS", _show_parser("PRIMARY KEYS")],
    /* py:826 */ ["IMPORTED KEYS", _show_parser("IMPORTED KEYS")],
    /* py:827 */ ["UNIQUE KEYS", _show_parser("UNIQUE KEYS")],
    /* py:828 */ ["SEQUENCES", _show_parser("SEQUENCES")],
    /* py:829 */ ["STAGES", _show_parser("STAGES")],
    /* py:830 */ ["COLUMNS", _show_parser("COLUMNS")],
    /* py:831 */ ["USERS", _show_parser("USERS")],
    /* py:832 */ ["FILE FORMATS", _show_parser("FILE FORMATS")],
    /* py:833 */ ["FUNCTIONS", _show_parser("FUNCTIONS")],
    /* py:834 */ ["PROCEDURES", _show_parser("PROCEDURES")],
    /* py:835 */ ["WAREHOUSES", _show_parser("WAREHOUSES")],
    /* py:836 */ ["ICEBERG TABLES", _show_parser("TABLES", { iceberg: true })],
    /* py:837 */ ["TERSE ICEBERG TABLES", _show_parser("TABLES", { terse: true, iceberg: true })],
    /* py:838 */ ["TERSE DATABASES", _show_parser("DATABASES", { terse: true })],
    /* py:839 */ ["TERSE SCHEMAS", _show_parser("SCHEMAS", { terse: true })],
    /* py:840 */ ["TERSE OBJECTS", _show_parser("OBJECTS", { terse: true })],
    /* py:841 */ ["TERSE TABLES", _show_parser("TABLES", { terse: true })],
    /* py:842 */ ["TERSE VIEWS", _show_parser("VIEWS", { terse: true })],
    /* py:843 */ ["TERSE SEQUENCES", _show_parser("SEQUENCES", { terse: true })],
    /* py:844 */ ["TERSE USERS", _show_parser("USERS", { terse: true })],
    // TERSE has no semantic effect for KEYS, so we do not set the terse AST arg
    /* py:846 */ ["TERSE PRIMARY KEYS", _show_parser("PRIMARY KEYS")],
    /* py:847 */ ["TERSE IMPORTED KEYS", _show_parser("IMPORTED KEYS")],
    /* py:848 */ ["TERSE UNIQUE KEYS", _show_parser("UNIQUE KEYS")],
  ]);

  /* py:851 */ static SHOW_TRIE = newTrie([...this.SHOW_PARSERS.keys()].map((key) => key.split(" ")));

  /** py: sqlglot/parsers/snowflake.py:853 */
  static CONSTRAINT_PARSERS = new Map([
    /* py:854 */ ...Parser.CONSTRAINT_PARSERS,
    /* py:855 */ ["WITH", (self) => self._parse_with_constraint()],
    /* py:856 */ ["MASKING", (self) => self._parse_with_constraint()],
    /* py:857 */ ["PROJECTION", (self) => self._parse_with_constraint()],
    /* py:858 */ ["TAG", (self) => self._parse_with_constraint()],
  ]);

  /** py: sqlglot/parsers/snowflake.py:861 */
  static STAGED_FILE_SINGLE_TOKENS = new Set([
    /* py:862 */ TokenType.DOT,
    /* py:863 */ TokenType.MOD,
    /* py:864 */ TokenType.SLASH,
  ]);

  /* py:867 */ static FLATTEN_COLUMNS = ["SEQ", "KEY", "PATH", "INDEX", "VALUE", "THIS"];

  /** py: sqlglot/parsers/snowflake.py:869 */
  static SCHEMA_KINDS = new Set([
    /* py:870 */ "OBJECTS",
    /* py:871 */ "TABLES",
    /* py:872 */ "VIEWS",
    /* py:873 */ "SEQUENCES",
    /* py:874 */ "UNIQUE KEYS",
    /* py:875 */ "IMPORTED KEYS",
  ]);

  /* py:878 */ static NON_TABLE_CREATABLES = new Set(["STORAGE INTEGRATION", "TAG", "WAREHOUSE", "STREAMLIT"]);

  /** py: sqlglot/parsers/snowflake.py:880 — `parser.OPTIONS_TYPE`, i.e. name -> list of
   * continuation keyword sequences. `dict.fromkeys(..., tuple())` is an EMPTY list of
   * continuations, which `_parse_var_from_options` distinguishes from "absent". */
  static UNDROP_OBJECTS = new Map([
    /* py:883 */ ["ACCOUNT", []],
    /* py:884 */ ["DATABASE", []],
    /* py:885 */ ["NOTEBOOK", []],
    /* py:886 */ ["SCHEMA", []],
    /* py:887 */ ["SNAPSHOT", []],
    /* py:888 */ ["STREAMLIT", []],
    /* py:889 */ ["TABLE", []],
    /* py:890 */ ["TAG", []],
    /* py:891 */ ["TYPE", []],
    /* py:895 */ ["DYNAMIC", ["TABLE"]],
    /* py:896 */ ["EXTERNAL", ["VOLUME"]],
    /* py:897 */ ["ICEBERG", ["TABLE"]],
  ]);

  /** py: sqlglot/parsers/snowflake.py:900 */
  static CREATABLES = new Set([
    /* py:901 */ ...Parser.CREATABLES,
    /* py:902 */ TokenType.INTEGRATION,
    /* py:903 */ TokenType.PACKAGE,
    /* py:904 */ TokenType.POLICY,
    /* py:905 */ TokenType.POOL,
    /* py:906 */ TokenType.ROLE,
    /* py:907 */ TokenType.RULE,
    /* py:908 */ TokenType.VOLUME,
  ]);

  /** py: sqlglot/parsers/snowflake.py:911 */
  static LAMBDAS = new Map([
    /* py:912 */ ...Parser.LAMBDAS,
    // `_replace_lambda` is still a NotPorted stub in the base parser, which is why the
    // BASE table leaves its own ARROW entry (parser.py:1057) commented out. Upstream
    // Snowflake really does define this entry, so it is wired here and announces the
    // missing base helper as a STUB at runtime rather than silently building a
    // different node. See this branch's report for the count it accounts for.
    /* py:913 */ [TokenType.ARROW, (self, expressions) => self.expression(
      new exp.Lambda({
        this: self._replace_lambda(self._parse_assignment(), expressions),
        expressions: expressions.map((e) => (e instanceof exp.Cast ? e.this : e)),
      }),
    )],
  ]);

  /** py: sqlglot/parsers/snowflake.py:924 */
  static COLUMN_OPERATORS = new Map([
    /* py:925 */ ...Parser.COLUMN_OPERATORS,
    /* py:926 */ [TokenType.EXCLAMATION, (self, this_, attr) => self.expression(
      new exp.ModelAttribute({ this: this_, expression: attr }),
    )],
  ]);

  /** py: sqlglot/parsers/snowflake.py:931 */
  _parse_directory() {
    const table = this._parse_table_parts();
    const this_ = table instanceof exp.Table ? table.this : table;
    return this.expression(new exp.DirectoryStage({ this: this_ }));
  }

  /** py: sqlglot/parsers/snowflake.py:936 */
  _parse_describe() {
    const index = this._index;

    if (this._match_texts(this.constructor.DESCRIBE_QUALIFIER_PARSERS)) {
      const qualifier = this.constructor.DESCRIBE_QUALIFIER_PARSERS.get(pyUpper(this._prev.text))(this);

      if (qualifier) {
        const kind = this._match_set(this.constructor.CREATABLES) && pyUpper(this._prev.text);

        if (kind) {
          const this_ = this._parse_table(true);
          const properties = this.expression(new exp.Properties({ expressions: [qualifier] }));
          const post_props = this._parse_properties();
          const expressions = post_props ? post_props.expressions : null;
          return this.expression(new exp.Describe({
            this: this_,
            kind,
            properties,
            expressions,
          }));
        }
      }
    }

    this._retreat(index);
    return super._parse_describe();
  }

  /** py: sqlglot/parsers/snowflake.py:962 */
  _parse_use() {
    if (this._match_text_seq("SECONDARY", "ROLES")) {
      const this_ = this._match_texts(["ALL", "NONE"]) && exp.var(pyUpper(this._prev.text));
      const roles = this_ ? null : this._parse_csv(() => this._parse_table(false));
      return this.expression(new exp.Use({ kind: "SECONDARY ROLES", this: this_, expressions: roles }));
    }

    return super._parse_use();
  }

  /** py: sqlglot/parsers/snowflake.py:970 */
  _negate_range(this_ = null) {
    if (!this_) return this_;

    const query = this_.args.query;
    if (this_ instanceof exp.In && query instanceof exp.Query) {
      // Snowflake treats `value NOT IN (subquery)` as `VALUE <> ALL (subquery)`, so
      // we do this conversion here to avoid parsing it into `NOT value IN (subquery)`
      // which can produce different results (most likely a SnowFlake bug).
      //
      // https://docs.snowflake.com/en/sql-reference/functions/in
      // Context: https://github.com/tobymao/sqlglot/issues/3890
      return this.expression(new exp.NEQ({ this: this_.this, expression: new exp.All({ this: query.unnest() }) }));
    }

    return this.expression(new exp.Not({ this: this_ }));
  }

  /** py: sqlglot/parsers/snowflake.py:986 */
  _parse_tag() {
    return this.expression(new exp.Tags({
      expressions: this._parse_wrapped_csv(() => this._parse_property()),
    }));
  }

  /** py: sqlglot/parsers/snowflake.py:989 */
  _parse_property_before() {
    const prop = super._parse_property_before();
    if (pyTruthy(prop)) return prop;

    if (!this._next.bool() || this._next.token_type !== TokenType.EQ) return null;

    return this._parse_sequence_properties()
      || this._parse_key_value_property(() => this._parse_primary_or_var());
  }

  /** py: sqlglot/parsers/snowflake.py:1001 */
  _parse_with_constraint() {
    if (this._prev.token_type !== TokenType.WITH) this._retreat(this._index - 1);

    if (this._match_text_seq("MASKING", "POLICY")) {
      const policy = this._parse_column();
      return this.expression(new exp.MaskingPolicyColumnConstraint({
        this: policy instanceof exp.Column ? policy.to_dot() : policy,
        expressions: this._match(TokenType.USING)
          && this._parse_wrapped_csv(() => this._parse_id_var()),
      }));
    }
    if (this._match_text_seq("PROJECTION", "POLICY")) {
      const policy = this._parse_column();
      return this.expression(new exp.ProjectionPolicyColumnConstraint({
        this: policy instanceof exp.Column ? policy.to_dot() : policy,
      }));
    }
    if (this._match(TokenType.TAG)) return this._parse_tag();

    return null;
  }

  /** py: sqlglot/parsers/snowflake.py:1026 */
  _parse_with_property() {
    if (this._match(TokenType.TAG)) return this._parse_tag();

    if (this._match_text_seq("ROW", "ACCESS", "POLICY")) return this._parse_row_access_policy();

    return super._parse_with_property();
  }

  /** py: sqlglot/parsers/snowflake.py:1035 */
  _parse_row_access_policy() {
    let policy;
    let expressions;
    // GET_DDL outputs #unknown_policy when the user lacks privileges to see the policy name
    if (this._match(TokenType.HASH)) {
      policy = this._parse_var(true);
      if (policy) policy = new exp.Var({ this: `#${policy.name}` });
      expressions = null;
    } else {
      policy = this._parse_column();
      if (policy instanceof exp.Column) policy = policy.to_dot();
      if (!this._match(TokenType.ON)) this.raise_error("Expected ON after ROW ACCESS POLICY name");
      expressions = this._parse_wrapped_csv(() => this._parse_id_var());
    }

    return this.expression(new exp.RowAccessProperty({ this: policy, expressions }));
  }

  /** py: sqlglot/parsers/snowflake.py:1052 */
  _parse_create() {
    const expression = super._parse_create();
    if (expression instanceof exp.Create && this.constructor.NON_TABLE_CREATABLES.has(expression.kind)) {
      // Replace the Table node with the enclosed Identifier
      expression.this.replace(expression.this.this);
    }

    return expression;
  }

  // https://docs.snowflake.com/en/sql-reference/functions/date_part.html
  // https://docs.snowflake.com/en/sql-reference/functions-date-time.html#label-supported-date-time-parts
  /** py: sqlglot/parsers/snowflake.py:1062 */
  _parse_date_part() {
    const this_ = this._parse_var() || this._parse_type();

    if (!this_) return null;

    // Handle both syntaxes: DATE_PART(part, expr) and DATE_PART(part FROM expr)
    const expression = this._match_set(new Set([TokenType.FROM, TokenType.COMMA])) && this._parse_bitwise();
    return this.expression(new exp.Extract({
      this: map_date_part(this_, this.dialect),
      expression,
    }));
  }

  /** py: sqlglot/parsers/snowflake.py:1074 */
  _parse_bracket_key_value(is_map = false) {
    if (is_map) {
      // Keys are strings in Snowflake's objects, see also:
      // - https://docs.snowflake.com/en/sql-reference/data-types-semistructured
      // - https://docs.snowflake.com/en/sql-reference/functions/object_construct
      return this._parse_slice(this._parse_string()) || this._parse_assignment();
    }

    return this._parse_slice(this._parse_alias(this._parse_assignment(), true));
  }

  /** py: sqlglot/parsers/snowflake.py:1083 */
  _parse_lateral() {
    const lateral = super._parse_lateral();
    if (!lateral) return lateral;

    if (lateral.this instanceof exp.Explode) {
      const table_alias = lateral.args.alias;
      const columns = this.constructor.FLATTEN_COLUMNS.map((col) => exp.toIdentifier(col));
      if (table_alias && !pyTruthy(table_alias.args.columns)) table_alias.set("columns", columns);
      else if (!table_alias) exp.alias_(lateral, "_flattened", { table: columns, copy: false });
    }

    return lateral;
  }

  /** py: sqlglot/parsers/snowflake.py:1098 */
  _parse_table_parts(schema = false, is_db_reference = false, wildcard = false, fast = false) {
    let table;
    // https://docs.snowflake.com/en/user-guide/querying-stage
    if (this._match(TokenType.STRING, false)) table = this._parse_string();
    else if (this._match_text_seq("@", { advance: false })) table = this._parse_location_path();
    else table = null;

    if (table) {
      let file_format = null;
      let pattern = null;

      const wrapped = this._match(TokenType.L_PAREN);
      while (this._curr.bool() && wrapped && !this._match(TokenType.R_PAREN)) {
        if (this._match_text_seq("FILE_FORMAT", "=>")) {
          file_format = this._parse_string() || super._parse_table_parts(false, is_db_reference);
        } else if (this._match_text_seq("PATTERN", "=>")) {
          pattern = this._parse_string();
        } else {
          break;
        }

        this._match(TokenType.COMMA);
      }

      table = this.expression(new exp.Table({ this: table, format: file_format, pattern }));
    } else {
      table = super._parse_table_parts(schema, is_db_reference, wildcard, fast);
    }

    return table;
  }

  /** py: sqlglot/parsers/snowflake.py:1140 */
  _parse_table(
    schema = false,
    joins = false,
    alias_tokens = null,
    parse_bracket = false,
    is_db_reference = false,
    parse_partition = false,
    consume_pipe = false,
  ) {
    // py:1150 — upstream deliberately does NOT forward `consume_pipe` to super().
    let table = super._parse_table(
      schema,
      joins,
      alias_tokens,
      parse_bracket,
      is_db_reference,
      parse_partition,
    );
    if (table instanceof exp.Table && table.this instanceof exp.TableFromRows) {
      const table_from_rows = table.this;
      for (const [arg] of exp.EXPR_META.tablefromrows.argTypes) {
        if (arg !== "this") table_from_rows.set(arg, table.args[arg]);
      }

      table = table_from_rows;
    }

    return table;
  }

  /** py: sqlglot/parsers/snowflake.py:1168 */
  _parse_function_call(functions = null, anonymous = false, optional_parens = true, any_token = false) {
    const this_ = super._parse_function_call(functions, anonymous, optional_parens, any_token);

    // Snowflake can invoke a function whose name is dynamically resolved, e.g.
    // `IDENTIFIER('my_func')(1, 2)`. The trailing argument list is the call's arguments.
    //
    // https://docs.snowflake.com/en/sql-reference/identifier-literal
    if (this_ instanceof exp.DynamicIdentifier && this._match(TokenType.L_PAREN, false)) {
      this_.set("expressions", this._parse_wrapped_csv(() => this._parse_lambda()));
    }

    return this_;
  }

  /** py: sqlglot/parsers/snowflake.py:1193 */
  _parse_id_var(any_token = true, tokens = null) {
    if (this._match_text_seq("IDENTIFIER", "(")) {
      const identifier = super._parse_id_var(any_token, tokens) || this._parse_string();
      this._match_r_paren();
      return this.expression(new exp.DynamicIdentifier({ this: identifier }));
    }

    return super._parse_id_var(any_token, tokens);
  }

  /** py: sqlglot/parsers/snowflake.py:1207 */
  _parse_show_snowflake(this_, terse = false, iceberg = false) {
    let scope = null;
    let scope_kind = null;

    const history = this._match_text_seq("HISTORY");

    const like = this._match(TokenType.LIKE) ? this._parse_string() : null;

    if (this._match(TokenType.IN)) {
      if (this._match_text_seq("ACCOUNT")) {
        scope_kind = "ACCOUNT";
      } else if (this._match_text_seq("CLASS")) {
        scope_kind = "CLASS";
        scope = this._parse_table_parts();
      } else if (this._match_text_seq("APPLICATION")) {
        scope_kind = "APPLICATION";
        if (this._match_text_seq("PACKAGE")) scope_kind += " PACKAGE";
        scope = this._parse_table_parts();
      } else if (this._match_set(this.constructor.DB_CREATABLES)) {
        scope_kind = pyUpper(this._prev.text);
        if (this._curr.bool()) scope = this._parse_table_parts();
      } else if (this._curr.bool()) {
        scope_kind = this.constructor.SCHEMA_KINDS.has(this_) ? "SCHEMA" : "TABLE";
        scope = this._parse_table_parts();
      }
    }

    return this.expression(new exp.Show({
      terse,
      iceberg,
      this: this_,
      history,
      like,
      scope,
      scope_kind,
      starts_with: this._match_text_seq("STARTS", "WITH") && this._parse_string(),
      limit: this._parse_limit(),
      from_: this._match(TokenType.FROM) ? this._parse_string() : null,
      privileges: this._match_text_seq("WITH", "PRIVILEGES")
        && this._parse_csv(() => this._parse_var(true, null, true)),
    }));
  }

  /** py: sqlglot/parsers/snowflake.py:1253 */
  _parse_undrop() {
    const start = this._prev;
    const kind = this._parse_var_from_options(this.constructor.UNDROP_OBJECTS, false);
    if (!kind) return this._parse_as_command(start);

    const this_ = this._parse_table_parts(
      false,
      ["ACCOUNT", "DATABASE", "SCHEMA"].includes(kind.name),
    );
    const rename = this._match_text_seq("RENAME", "TO") ? this._parse_table_parts() : null;
    return this.expression(new exp.Undrop({ this: this_, kind: kind.name, rename }));
  }

  /** py: sqlglot/parsers/snowflake.py:1265 */
  _parse_put() {
    if (this._curr.token_type !== TokenType.STRING) return this._parse_as_command(this._prev);

    return this.expression(new exp.Put({
      this: this._parse_string(),
      target: this._parse_location_path(),
      properties: this._parse_properties(),
    }));
  }

  /** py: sqlglot/parsers/snowflake.py:1277 */
  _parse_get() {
    const start = this._prev;

    // If we detect GET( then we need to parse a function, not a statement
    if (this._match(TokenType.L_PAREN)) {
      this._retreat(this._index - 2);
      return this._parse_expression();
    }

    const target = this._parse_location_path();

    // Parse as command if unquoted file path
    if (this._curr.token_type === TokenType.URI_START) return this._parse_as_command(start);

    return this.expression(new exp.Get({
      this: this._parse_string(),
      target,
      properties: this._parse_properties(),
    }));
  }

  /** py: sqlglot/parsers/snowflake.py:1295 */
  _parse_location_property() {
    this._match(TokenType.EQ);
    return this.expression(new exp.LocationProperty({ this: this._parse_location_path() }));
  }

  /** py: sqlglot/parsers/snowflake.py:1299 */
  _parse_file_location() {
    // Parse either a subquery or a staged file
    return this._match(TokenType.L_PAREN, false)
      ? this._parse_select(false, true, false)
      : this._parse_table_parts();
  }

  /** py: sqlglot/parsers/snowflake.py:1307 */
  _parse_location_path() {
    const start = this._curr;
    this._advance_any(true);

    // We avoid consuming a comma token because external tables like @foo and @bar
    // can be joined in a query with a comma separator, as well as closing paren
    // in case of subqueries
    while (
      this._is_connected()
      && !this._match_set(new Set([TokenType.COMMA, TokenType.L_PAREN, TokenType.R_PAREN]), false)
    ) {
      this._advance_any(true);
    }

    return exp.var(this._find_sql(start, this._prev));
  }

  /** py: sqlglot/parsers/snowflake.py:1321 */
  _parse_lambda_arg() {
    const this_ = super._parse_lambda_arg();

    if (!this_) return this_;

    const typ = this._parse_types();

    if (typ) return this.expression(new exp.Cast({ this: this_, to: typ }));

    return this_;
  }

  /** py: sqlglot/parsers/snowflake.py:1334 */
  _parse_foreign_key() {
    // inlineFK, the REFERENCES columns are implied
    if (this._match(TokenType.REFERENCES, false)) return this.expression(new exp.ForeignKey());

    // outoflineFK, explicitly names the columns
    return super._parse_foreign_key();
  }

  /** py: sqlglot/parsers/snowflake.py:1342 */
  _parse_file_format_property() {
    this._match(TokenType.EQ);
    let expressions;
    if (this._match(TokenType.L_PAREN, false)) expressions = this._parse_wrapped_options();
    else expressions = [this._parse_format_name()];

    return this.expression(new exp.FileFormatProperty({ expressions }));
  }

  /** py: sqlglot/parsers/snowflake.py:1351 */
  _parse_credentials_property() {
    return this.expression(new exp.CredentialsProperty({ expressions: this._parse_wrapped_options() }));
  }

  /** py: sqlglot/parsers/snowflake.py:1354 */
  _parse_semantic_view() {
    const kwargs = { this: this._parse_table_parts() };

    while (this._curr.bool() && !this._match(TokenType.R_PAREN, false)) {
      if (this._match_texts(["DIMENSIONS", "METRICS", "FACTS"])) {
        const keyword = this._prev.text.toLowerCase();
        kwargs[keyword] = this._parse_csv(() => this._parse_alias(this._parse_disjunction(), true));
      } else if (this._match_text_seq("WHERE")) {
        kwargs.where = this._parse_expression();
      } else {
        this.raise_error("Expecting ) or encountered unexpected keyword");
        break;
      }
    }

    return this.expression(new exp.SemanticView(kwargs));
  }

  /** py: sqlglot/parsers/snowflake.py:1371 */
  _parse_set(unset = false, tag = false) {
    const set = super._parse_set(unset, tag);

    if (set instanceof exp.Set) {
      for (const expr of set.expressions) {
        if (expr instanceof exp.SetItem) expr.set("kind", "VARIABLE");
      }
    }
    return set;
  }

  /** py: sqlglot/parsers/snowflake.py:1380 */
  _parse_position(haystack_first = false) {
    const result = super._parse_position(haystack_first);
    result.set("clamp_position", true);
    return result;
  }

  /** py: sqlglot/parsers/snowflake.py:1385 */
  _parse_substring() {
    const result = super._parse_substring();
    result.set("zero_start", true);
    return result;
  }

  /**
   * py: sqlglot/parsers/snowflake.py:1390
   *
   * Upstream takes `**kwargs`; the base port spells the six cast args out positionally
   * (parser.js:build_cast), so `kwargs.get("to")` / `kwargs.get("this")` become the
   * `to` / `this_` parameters and the whole list is forwarded to super unchanged.
   */
  build_cast(strict, this_, to, format, safe, action, default_) {
    if (!strict && to && to.this === exp.DataType.Type.BOOLEAN) {
      return this.expression(new exp.ToBoolean({ this: this_, safe: true }));
    }
    const cast = super.build_cast(strict, this_, to, format, safe, action, default_);
    if (cast instanceof exp.TryCast && to) {
      if (exp.DataType.TEXT_TYPES.has(to.this) && pyTruthy(to.expressions)) {
        cast.set("null_on_text_overflow", true);
      } else if (to.this === exp.DType.DATE && cast.this.isString) {
        cast.set("probe_date_format", true);
      }
    }
    return cast;
  }

  /** py: sqlglot/parsers/snowflake.py:1402 */
  _parse_window(this_, alias = false) {
    const result = super._parse_window(this_, alias);

    // Set default window frame for ranking functions if not present
    if (
      result instanceof exp.Window
      && RANKING_WINDOW_FUNCTIONS_WITH_FRAME.some((K) => this_ instanceof K)
      && !pyTruthy(result.args.spec)
    ) {
      const frame = new exp.WindowSpec({
        kind: "ROWS",
        start: "UNBOUNDED",
        start_side: "PRECEDING",
        end: "UNBOUNDED",
        end_side: "FOLLOWING",
      });
      result.set("spec", frame);
    }
    return result;
  }
}

// py: sqlglot/parsers/snowflake.py:1423 — "This is imported and used by both the parser
// (above) and the generator in the dialect file". It stays AFTER the class, as upstream
// has it: `_parse_window` is the only reader and resolves it when called, by which time
// this `const`'s temporal dead zone is long over.
export const RANKING_WINDOW_FUNCTIONS_WITH_FRAME = [
  exp.FirstValue,
  exp.LastValue,
  exp.NthValue,
];

/** py: sqlglot/parsers/snowflake.py:1430 */
export function build_object_construct(args) {
  const expression = build_var_map(args);

  if (expression instanceof exp.StarMap) return expression;

  const keys = expression.keys;
  const values = expression.values;
  return new exp.Struct({
    expressions: keys.map((k, i) => new exp.PropertyEQ({ this: k, expression: values[i] })),
  });
}
