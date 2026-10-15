// py: sqlglot/generators/duckdb.py — `class DuckDBGenerator(generator.Generator)`.
//
// @ported-ranges sqlglot/generators/duckdb.py 50-50 213-214 217-229 320-357 359-450 452-540 545-547 549-563 607-648 890-901 903-908 910-949 953-977 1017-1020 1123-1130 1261-1274 1428-1455 1459-1497 1554-1590 1591-1814 1816-1821 1823-1844 1852-1931 2004-2017 2652-2677 2987-3050 3952-3971 4349-4406 4419-4497 4670-4712
//
// SCOPE — a deliberately small, honest slice of a 4,788-line file (PORT_PLAN.md,
// "DuckDB generator is an outlier size" — ~4x every other single-file dialect
// generator ported so far). This file does NOT attempt exhaustive coverage; see
// PORT_PLAN.md's R32 entry for the marginal analysis that drove the cut and the
// follow-on stub queue (139 methods, ~108 TRANSFORMS entries, PROPERTIES_LOCATION /
// the CREATE-statement properties system, and every ClassVar SQL template are all
// still NotPorted).
//
// AIR-2282/R85 (PORT_PLAN.md Epic 11, generator-fidelity census): re-examined because
// `exp.Array`, `exp.SortArray`, and `exp.GenerateSeries` were the single biggest
// SQL_MISMATCH clusters against `tools/mismatch_report.mjs` (duckdb as the WRITE
// dialect) — see PORT_PLAN.md R85 for the ranked table. All three were "blocked" on
// dependencies that had since landed in other sessions (R22 "stubs outlive their
// stated blocker"): `inherit_struct_field_names`/`inline_array_unless_query` for
// `Array`, and `generate_series_sql` for `GenerateSeries`, were both already real
// exports; `SortArray` just had no entry at all (its upstream form is a `*_sql`
// method override, py:2652, outside this file's original TRANSFORMS-table scope).
//
// WHAT IS HERE:
//   - The ~35 scalar class settings (py:1554-1589) — these change how ALREADY-PORTED
//     base `Generator` methods render DuckDB SQL even without a single DuckDB-specific
//     override or TRANSFORMS entry (tablesample_sql, join_sql, etc. all read them).
//   - `TRANSFORMS` (py:1590-1814): ~62 of 147 entries. Two tiers:
//       Tier 1 (~37): wired verbatim to shared helpers `src/dialects/dialect.js`
//       already ports unmodified (`rename_func`, `array_append_sql`, `datestrtodate_sql`,
//       `groupconcat_sql`, `no_make_interval_sql`, `approx_count_distinct_sql`,
//       `no_time_sql`, `no_timestamp_sql`, `timestrtotime_sql`, `generate_series_sql`,
//       `inline_array_unless_query`) — zero new logic.
//       Tier 2 (~25): small (4-40 line) DuckDB-local helper functions with no further
//       unported dependency, ported below (boolean-coercion group, ArraySort/
//       ArrayContains, AnyValue, BoolxorAgg, the Unix*-to-timestamp implicit-cast
//       group) plus a batch of self-contained one-line lambdas.
//     Every OTHER entry is commented out at its upstream anchor, matching the
//     established "still-unseeded TRANSFORMS" convention (`src/generator.js`'s own
//     stub-`TRANSFORMS` lines; `src/generators/snowflake.js`'s five blocked entries).
//     The largest excluded group was `_date_delta_to_binary_interval_op` (9 entries,
//     wrapping `dialect.js`'s shared `date_delta_to_binary_interval_op` with its own
//     nanosecond/float-interval handling) — unblocked in AIR-2283 (PORT_PLAN.md R90+)
//     once `_date_diff_sql`'s own week-boundary path needed `exp.DateAdd` to render
//     correctly; all 9 entries (DateAdd/DateSub/DatetimeAdd/DatetimeSub/TimeAdd/
//     TimeSub/TimestampAdd/TimestampSub/TsOrDsAdd) are wired below.
//   - `SUPPORTED_JSON_PATH_PARTS`, `TYPE_MAPPING`, `RESERVED_KEYWORDS` (py:1816-1931):
//     cheap, mechanical, real upstream data with no code-logic risk.
//   - `sortarray_sql` (py:2652) — the one `*_sql` method override pulled forward from
//     the "WHAT IS DELIBERATELY NOT HERE" queue below, as `_sortarray_sql`, wired
//     through TRANSFORMS rather than as a same-named instance method (matching this
//     file's existing convention for `_array_sort_sql`/`_array_contains_sql`, both of
//     which are TRANSFORMS lambdas upstream too, not methods).
//
// WHAT IS DELIBERATELY NOT HERE (left for a follow-on session, named rather than
// silently skipped):
//   - The remaining 139 `*_sql` method overrides (py:2311 onward, minus `sortarray_sql`
//     above) — `create_sql`/`createable_sql`
//     (base `Generator`, NotPorted — the CREATE-statement properties subsystem is its
//     own multi-session port, not a DuckDB-generator task), `window_sql`/`tablesample_sql`/
//     `pad_sql`/`parsejson_sql` (DuckDB overrides that `super()` into base methods this
//     pass does not touch), `round_sql`/`ceil_floor` (chained through the unported
//     `_scale_rounding_sql`), `TYPE_PARAM_SETTINGS`, `PROPERTIES_LOCATION`,
//     `UNWRAPPED_INTERVAL_VALUES`, and every `t.ClassVar[exp.Expr] = exp.maybe_parse(...)`
//     SQL-string template (ZIPF/NORMAL/SEEDED_RANDOM/MAPCAT/bitmap templates) — all are
//     reachable only from methods this pass excludes.
//
// `generator_class` DOES NOT throw. The header this file replaces (removed from
// `src/dialects/duckdb.js`) claimed `registerDialect` throws `NotPorted` "the moment
// any dialect sets generator_class", citing py:304's `SUPPORTED_JSON_PATH_PARTS`
// pruning. That claim predates `registerDialect`'s current code
// (`dialects/dialect.js` ~line 1958): the read is already wrapped in a `try`/`catch`
// that falls back to `undefined` and skips pruning silently — the same defensive shape
// `SnowflakeGenerator` (PR #39) and the Databricks chain (PR #43) already exercise
// successfully. There was never a live guard here to trip.

import * as exp from "../expressions/index.js";
import { Generator, unsupported_args } from "../generator.js";
import { inherit_struct_field_names, preprocess, unqualify_columns } from "../transforms.js";
import {
  approx_count_distinct_sql,
  array_append_sql,
  array_concat_sql,
  date_delta_to_binary_interval_op,
  datestrtodate_sql,
  generate_series_sql,
  groupconcat_sql,
  inline_array_unless_query,
  no_comment_column_constraint_sql,
  no_make_interval_sql,
  no_time_sql,
  no_timestamp_sql,
  rename_func,
  timestrtotime_sql,
  unit_to_str,
  week_unit_to_dow,
  weekstart_unit_to_str,
} from "../dialects/dialect.js";
import { isDateUnit, seqGet } from "../helper.js";
import { annotate_types } from "../optimizer/annotate_types.js";
import { decDiv, pyDecimal } from "../_py/num.js";

// py:50 — used only by `_implicit_datetime_cast` below.
const TIMEZONE_PATTERN = /:\d{2}.*?[+\-]\d{2}(?::\d{2})?/;

/** py:545 */
function _array_sort_sql(self, expression) {
  return self.func("ARRAY_SORT", expression.this);
}

/** py:549 */
function _array_contains_sql(self, expression) {
  const this_ = expression.this;
  const expr = expression.expression;
  const func = self.func("ARRAY_CONTAINS", this_, expr);

  if (expression.args.check_null) {
    const check_null_in_array = new exp.Nullif({
      this: new exp.NEQ({ this: new exp.ArraySize({ this: this_ }), expression: self.func("LIST_COUNT", this_) }),
      expression: exp.false_(),
    });
    return self.sql(new exp.If({ this: expr.is_(exp.null_()), true: check_null_in_array, false: func }));
  }

  return func;
}

/** py:2652 `DuckDBGenerator.sortarray_sql(expression: exp.SortArray)` */
function _sortarray_sql(self, expression) {
  const arr = expression.this;
  const asc = expression.args.asc;
  const nulls_first = expression.args.nulls_first;

  if (!(asc instanceof exp.Boolean) && !(nulls_first instanceof exp.Boolean)) {
    return self.func("LIST_SORT", arr, asc, nulls_first);
  }

  const nulls_are_first = !!nulls_first?.equals(exp.true_());
  const nulls_first_sql = nulls_are_first ? exp.Literal.string("NULLS FIRST") : null;

  if (!(asc instanceof exp.Boolean)) {
    return self.func("LIST_SORT", arr, asc, nulls_first_sql);
  }

  const descending = asc.equals(exp.false_());

  if (!descending && !nulls_are_first) return self.func("LIST_SORT", arr);
  if (!nulls_are_first) return self.func("ARRAY_REVERSE_SORT", arr);
  return self.func(
    "LIST_SORT",
    arr,
    exp.Literal.string(descending ? "DESC" : "ASC"),
    exp.Literal.string("NULLS FIRST"),
  );
}

/**
 * py:890 `_implicit_datetime_cast(arg, type=exp.DType.DATE)`.
 *
 * Keyword-only `type` with a default — trailing options object (rule 2), per
 * PORT_PLAN.md R18.
 */
function _implicit_datetime_cast(arg, { type = exp.DType.DATE } = {}) {
  if (arg instanceof exp.Literal && arg.isString) {
    const ts = arg.name;
    if (type === exp.DType.DATE && ts.includes(":")) {
      type = TIMEZONE_PATTERN.test(ts) ? exp.DType.TIMESTAMPTZ : exp.DType.TIMESTAMP;
    }
    arg = exp.cast(arg, type);
  }
  return arg;
}

/** py:213 */
function _is_nanosecond_unit(unit) {
  return (unit instanceof exp.Var || unit instanceof exp.Literal) && unit.name.toUpperCase() === "NANOSECOND";
}

/**
 * py:219 `_handle_nanosecond_diff(self, end_time, start_time)`.
 * Generate NANOSECOND diff using EPOCH_NS since DATE_DIFF doesn't support it.
 */
function _handle_nanosecond_diff(self, end_time, start_time) {
  const end_ns = exp.cast(end_time, exp.DType.TIMESTAMP_NS);
  const start_ns = exp.cast(start_time, exp.DType.TIMESTAMP_NS);
  return self.sql(new exp.Sub({ this: self.func("EPOCH_NS", end_ns), expression: self.func("EPOCH_NS", start_ns) }));
}

/**
 * py:903 `_week_trunc_start_dow(unit)`.
 * DuckDB's weeks are ISO 8601, so ISOWEEK maps to its plain WEEK unit.
 */
function _week_trunc_start_dow(unit) {
  if (unit instanceof exp.Literal && unit.name.toUpperCase() === "ISOWEEK") return 1;
  return week_unit_to_dow(unit);
}

/**
 * py:910 `_build_week_trunc_expression(date_expr, start_dow, preserve_start_day=False, cast_to_date=True)`.
 *
 * Build DATE_TRUNC expression for week boundaries with custom start day.
 * DuckDB's DATE_TRUNC('WEEK', ...) always returns Monday. To align to a
 * different start day, we shift the date before truncating.
 *
 * `preserve_start_day`: if true, reverse the shift after truncating so the
 * result lands on the correct week start day. Needed for DATE_TRUNC
 * (absolute result matters) but not for DATE_DIFF (only relative alignment
 * matters). `cast_to_date`: if true, cast the shifted result back to DATE;
 * set to false for timestamp-valued inputs, where the result must remain a
 * timestamp.
 *
 * Shift formula: Sunday (7) gets +1, others get (1 - start_dow).
 */
function _build_week_trunc_expression(date_expr, start_dow, { preserve_start_day = false, cast_to_date = true } = {}) {
  const shift_days = start_dow === 7 ? 1 : 1 - start_dow;
  const truncated = new exp.DateTrunc({ unit: exp.var("WEEK"), this: date_expr });
  if (shift_days === 0) return truncated;

  const shift = new exp.Interval({ this: exp.Literal.string(String(shift_days)), unit: exp.var("DAY") });
  const shifted_date = new exp.DateAdd({ this: date_expr, expression: shift });
  truncated.set("this", shifted_date);

  if (preserve_start_day) {
    const interval = new exp.Interval({ this: exp.Literal.string(String(-shift_days)), unit: exp.var("DAY") });
    const shifted_back = new exp.DateAdd({ this: truncated, expression: interval });
    if (cast_to_date) return exp.cast(shifted_back, exp.DType.DATE, { copy: false });
    return shifted_back;
  }

  return truncated;
}

/** py:953 `_date_diff_sql(self, expression)` for `exp.DateDiff | exp.DatetimeDiff`. */
function _date_diff_sql(self, expression) {
  const unit = expression.unit;

  if (_is_nanosecond_unit(unit)) return _handle_nanosecond_diff(self, expression.this, expression.expression);

  let this_ = _implicit_datetime_cast(expression.this);
  let expr = _implicit_datetime_cast(expression.expression);

  // DuckDB's WEEK diff does not respect Monday crossing (week boundaries), it checks
  // (end_day - start_day) / 7; other units such as MONTH do respect their boundaries.
  const date_part_boundary = expression.args.date_part_boundary;

  const week_start = week_unit_to_dow(unit);
  if (date_part_boundary && week_start && this_ && expr) {
    expression.set("unit", exp.Literal.string("WEEK"));
    this_ = _build_week_trunc_expression(this_, week_start);
    expr = _build_week_trunc_expression(expr, week_start);
  }

  return self.func("DATE_DIFF", unit_to_str(expression), expr, this_);
}

/**
 * py:320 `_date_delta_to_binary_interval_op(cast=True)`.
 *
 * DuckDB override of `dialect.js`'s shared `date_delta_to_binary_interval_op`
 * to handle: (1) NANOSECOND operations (DuckDB doesn't support
 * `INTERVAL ... NANOSECOND`), (2) float/decimal interval values (DuckDB
 * `INTERVAL` requires integer expressions).
 */
function _date_delta_to_binary_interval_op(cast = true) {
  const base_impl = date_delta_to_binary_interval_op(cast);

  return function _duckdb_date_delta_sql(self, expression) {
    const unit = expression.unit;
    let interval_value = expression.expression;

    if (_is_nanosecond_unit(unit)) {
      if (interval_value instanceof exp.Interval) interval_value = interval_value.this;
      const timestamp_ns = exp.cast(expression.this, exp.DType.TIMESTAMP_NS);
      return self.sql(
        exp.func("MAKE_TIMESTAMP_NS", new exp.Add({ this: self.func("EPOCH_NS", timestamp_ns), expression: interval_value })),
      );
    }

    // Handle float/decimal interval values as duckDB INTERVAL requires integer expressions
    if (!interval_value || interval_value instanceof exp.Interval) return base_impl(self, expression);

    if (interval_value.isType(...exp.DataType.REAL_TYPES)) {
      expression.set("expression", exp.cast(self.func("ROUND", interval_value), "INT"));
    }

    return base_impl(self, expression);
  };
}

/** py:607 `_struct_sql(self, expression)` for `exp.Struct`. */
function _struct_sql(self, expression) {
  let ancestor_cast = expression.findAncestor(exp.Cast, exp.Select);
  ancestor_cast = ancestor_cast instanceof exp.Select ? null : ancestor_cast;

  // Empty struct cast works with MAP() since DuckDB can't parse {}
  if (!expression.expressions.length) {
    if (ancestor_cast instanceof exp.Cast && ancestor_cast.to.isType(exp.DType.MAP)) return "MAP()";
  }

  const args = [];

  // BigQuery allows inline construction such as "STRUCT<a STRING, b INTEGER>('str', 1)" which is
  // canonicalized to "ROW('str', 1) AS STRUCT(a TEXT, b INT)" in DuckDB
  // The transformation to ROW will take place if:
  //  1. The STRUCT itself does not have proper fields (key := value) as a "proper" STRUCT would
  //  2. A cast to STRUCT / ARRAY of STRUCTs is found
  const is_bq_inline_struct = Boolean(
    expression.find(exp.PropertyEQ) === null
    && ancestor_cast
    && [...ancestor_cast.findAll(exp.DataType)].some((casted_type) => casted_type.isType(exp.DType.STRUCT)),
  );

  const exprs = expression.expressions;
  for (let i = 0; i < exprs.length; i++) {
    const expr = exprs[i];
    const is_property_eq = expr instanceof exp.PropertyEQ;
    const this_ = expr.this;
    const value = is_property_eq ? expr.expression : expr;

    if (is_bq_inline_struct) {
      args.push(self.sql(value));
    } else {
      let key;
      if (this_ instanceof exp.Identifier) key = self.sql(exp.Literal.string(expr.name));
      else if (is_property_eq) key = self.sql(this_);
      else key = self.sql(exp.Literal.string(`_${i}`));
      args.push(`${key}: ${self.sql(value)}`);
    }
  }

  const csv_args = args.join(", ");

  return is_bq_inline_struct ? `ROW(${csv_args})` : `{${csv_args}}`;
}

/**
 * py:359 `_array_insert_sql(self, expression)` for `exp.ArrayInsert`.
 *
 * Transpile ARRAY_INSERT to DuckDB using LIST_CONCAT and slicing. Handles
 * 0-based and 1-based indexing (normalizes to 0-based for calculations),
 * negative position conversion (requires array length), and NULL
 * propagation (source dialects return NULL, DuckDB creates a single-element
 * array) — all dialects that support ARRAY_INSERT (Snowflake, Spark,
 * Databricks) have ARRAY_FUNCS_PROPAGATES_NULLS=True, so NULL propagation is
 * always assumed. Only a literal position can be transpiled.
 */
function _array_insert_sql(self, expression) {
  const this_ = expression.this;
  const position = expression.args.position;
  const element = expression.expression;
  const element_array = new exp.Array({ expressions: [element] });
  const index_offset = expression.args.offset ?? 0;

  if (!position || !position.isInt) {
    self.unsupported("ARRAY_INSERT can only be transpiled with a literal position");
    return self.func("ARRAY_INSERT", this_, position, element);
  }

  let pos_value = Number(position.toPy());

  // Normalize one-based indexing to zero-based for slice calculations
  // Spark (1-based) -> Snowflake (0-based):
  //   Positive: pos=1 -> pos=0 (subtract 1)
  //   Negative: pos=-2 -> pos=-1 (add 1)
  // Example: Spark array_insert([a,b,c], -2, d) -> [a,b,d,c] is same as Snowflake pos=-1
  if (pos_value > 0) pos_value -= index_offset;
  else if (pos_value < 0) pos_value += index_offset;

  // Build the appropriate list_concat expression based on position
  let concat_exprs;
  if (pos_value === 0) {
    // insert at beginning
    concat_exprs = [element_array, this_];
  } else if (pos_value > 0) {
    // Positive position: LIST_CONCAT(arr[1:pos], [elem], arr[pos+1:])
    // 0-based -> DuckDB 1-based slicing

    // left slice: arr[1:pos]
    const slice_start = new exp.Bracket({
      this: this_,
      expressions: [new exp.Slice({ this: exp.Literal.number(1), expression: exp.Literal.number(pos_value) })],
    });

    // right slice: arr[pos+1:]
    const slice_end = new exp.Bracket({
      this: this_,
      expressions: [new exp.Slice({ this: exp.Literal.number(pos_value + 1) })],
    });

    concat_exprs = [slice_start, element_array, slice_end];
  } else {
    // Negative position: arr[1:LEN(arr)+pos], [elem], arr[LEN(arr)+pos+1:]
    // pos=-1 means insert before last element
    const arr_len = new exp.Length({ this: this_ });

    // Calculate slice position: LEN(arr) + pos (e.g., LEN(arr) + (-1) = LEN(arr) - 1)
    // deny:operators sqlglot/generators/duckdb.py:429 — Python `+` on an Expr
    const slice_end_pos = arr_len.add(exp.Literal.number(pos_value));
    // deny:operators sqlglot/generators/duckdb.py:430 — Python `+` on an Expr
    const slice_start_pos = slice_end_pos.add(exp.Literal.number(1));

    // left slice: arr[1:LEN(arr)+pos]
    const slice_start = new exp.Bracket({
      this: this_,
      expressions: [new exp.Slice({ this: exp.Literal.number(1), expression: slice_end_pos })],
    });

    // right slice: arr[LEN(arr)+pos+1:]
    const slice_end = new exp.Bracket({ this: this_, expressions: [new exp.Slice({ this: slice_start_pos })] });

    concat_exprs = [slice_start, element_array, slice_end];
  }

  // All dialects that support ARRAY_INSERT propagate NULLs (Snowflake/Spark/Databricks)
  // Wrap in CASE WHEN array IS NULL THEN NULL ELSE func_expr END
  return self.sql(
    new exp.If({
      this: new exp.Is({ this: this_, expression: new exp.Null() }),
      true: new exp.Null(),
      false: self.func("LIST_CONCAT", ...concat_exprs),
    }),
  );
}

/**
 * py:452 `_array_remove_at_sql(self, expression)` for `exp.ArrayRemoveAt`.
 *
 * Transpile ARRAY_REMOVE_AT to DuckDB using LIST_CONCAT and slicing: pos=0
 * (first) -> arr[2:], pos>0 (middle) -> LIST_CONCAT(arr[1:p], arr[p+2:]),
 * pos=-1 (last) -> arr[1:LEN(arr)-1], pos<-1 -> LIST_CONCAT(arr[1:LEN(arr)+p],
 * arr[LEN(arr)+p+2:]) — all wrapped in CASE WHEN arr IS NULL THEN NULL ELSE
 * ... END (Snowflake's ARRAY_FUNCS_PROPAGATES_NULLS=True). Only a literal
 * position can be transpiled.
 */
function _array_remove_at_sql(self, expression) {
  const this_ = expression.this;
  const position = expression.args.position;

  if (!position || !position.isInt) {
    self.unsupported("ARRAY_REMOVE_AT can only be transpiled with a literal position");
    return self.func("ARRAY_REMOVE_AT", this_, position);
  }

  const pos_value = Number(position.toPy());

  let result_expr;
  if (pos_value === 0) {
    // Remove first element: arr[2:]
    result_expr = new exp.Bracket({ this: this_, expressions: [new exp.Slice({ this: exp.Literal.number(2) })] });
  } else if (pos_value > 0) {
    // Remove at positive position: LIST_CONCAT(arr[1:pos], arr[pos+2:])
    // DuckDB uses 1-based slicing
    const left_slice = new exp.Bracket({
      this: this_,
      expressions: [new exp.Slice({ this: exp.Literal.number(1), expression: exp.Literal.number(pos_value) })],
    });
    const right_slice = new exp.Bracket({
      this: this_,
      expressions: [new exp.Slice({ this: exp.Literal.number(pos_value + 2) })],
    });
    result_expr = self.func("LIST_CONCAT", left_slice, right_slice);
  } else if (pos_value === -1) {
    // Remove last element: arr[1:LEN(arr)-1]
    // Optimization: simpler than general negative case
    const arr_len = new exp.Length({ this: this_ });
    // deny:operators sqlglot/generators/duckdb.py:512 — Python `+` on an Expr
    const slice_end = arr_len.add(exp.Literal.number(-1));
    result_expr = new exp.Bracket({
      this: this_,
      expressions: [new exp.Slice({ this: exp.Literal.number(1), expression: slice_end })],
    });
  } else {
    // Remove at negative position: LIST_CONCAT(arr[1:LEN(arr)+pos], arr[LEN(arr)+pos+2:])
    const arr_len = new exp.Length({ this: this_ });
    // deny:operators sqlglot/generators/duckdb.py:520 — Python `+` on an Expr
    const slice_end_pos = arr_len.add(exp.Literal.number(pos_value));
    // deny:operators sqlglot/generators/duckdb.py:521 — Python `+` on an Expr
    const slice_start_pos = slice_end_pos.add(exp.Literal.number(2));

    const left_slice = new exp.Bracket({
      this: this_,
      expressions: [new exp.Slice({ this: exp.Literal.number(1), expression: slice_end_pos })],
    });
    const right_slice = new exp.Bracket({ this: this_, expressions: [new exp.Slice({ this: slice_start_pos })] });
    result_expr = self.func("LIST_CONCAT", left_slice, right_slice);
  }

  // Snowflake ARRAY_FUNCS_PROPAGATES_NULLS=True, so wrap in NULL check
  // CASE WHEN array IS NULL THEN NULL ELSE result_expr END
  return self.sql(
    new exp.If({
      this: new exp.Is({ this: this_, expression: new exp.Null() }),
      true: new exp.Null(),
      false: result_expr,
    }),
  );
}

/**
 * py:1428 `_date_from_parts_sql(self, expression)` for `exp.DateFromParts`.
 *
 * Snowflake's DATE_FROM_PARTS allows out-of-range values for the month and
 * day input (e.g. month=13, day=100, or zero/negative values), but DuckDB's
 * MAKE_DATE does not. DuckDB's INTERVAL type does, so when `allow_overflow`
 * is set this converts to date arithmetic:
 * MAKE_DATE(year, 1, 1) + INTERVAL (month-1) MONTH + INTERVAL (day-1) DAY
 */
function _date_from_parts_sql(self, expression) {
  const year_expr = expression.args.year;
  const month_expr = expression.args.month;
  const day_expr = expression.args.day;

  if (expression.args.allow_overflow) {
    let base_date = exp.func("MAKE_DATE", year_expr, exp.Literal.number(1), exp.Literal.number(1));

    if (month_expr) {
      // deny:operators sqlglot/generators/duckdb.py:1449 — Python `+`/`-` on an Expr
      base_date = base_date.add(new exp.Interval({ this: month_expr.sub(exp.Literal.number(1)), unit: exp.var("MONTH") }));
    }

    if (day_expr) {
      // deny:operators sqlglot/generators/duckdb.py:1452 — Python `+`/`-` on an Expr
      base_date = base_date.add(new exp.Interval({ this: day_expr.sub(exp.Literal.number(1)), unit: exp.var("DAY") }));
    }

    return self.sql(exp.cast(base_date, exp.DType.DATE));
  }

  return self.func("MAKE_DATE", year_expr, month_expr, day_expr);
}

/** py:1017 */
function _cast_to_boolean(arg) {
  if (arg && !arg.isType(exp.DType.BOOLEAN)) return exp.cast(arg, exp.DType.BOOLEAN);
  return arg;
}

/** py:1123 */
function _anyvalue_sql(self, expression) {
  const having = expression.this;
  if (having instanceof exp.HavingMax) {
    const func_name = having.args.max ? "ARG_MAX_NULL" : "ARG_MIN_NULL";
    return self.func(func_name, having.this, having.expression);
  }
  return self.function_fallback_sql(expression);
}

/** py:1261 */
function _boolxor_agg_sql(self, expression) {
  return self.sql(
    new exp.EQ({
      this: new exp.CountIf({ this: _cast_to_boolean(expression.this) }),
      expression: exp.Literal.number(1),
    }),
  );
}

/** py:1459 */
function _round_arg(arg, round_input = null) {
  if (round_input) return exp.func("ROUND", arg, exp.Literal.number(0));
  return arg;
}

/** py:1465 */
function _boolnot_sql(self, expression) {
  const arg = _round_arg(expression.this, expression.args.round_input);
  return self.sql(exp.not_(exp.paren(arg)));
}

/** py:1470 */
function _booland_sql(self, expression) {
  const round_input = expression.args.round_input;
  const left = _round_arg(expression.this, round_input);
  const right = _round_arg(expression.expression, round_input);
  return self.sql(exp.paren(exp.and_(exp.paren(left), exp.paren(right), { wrap: false })));
}

/** py:1477 */
function _boolor_sql(self, expression) {
  const round_input = expression.args.round_input;
  const left = _round_arg(expression.this, round_input);
  const right = _round_arg(expression.expression, round_input);
  return self.sql(exp.paren(exp.or_(exp.paren(left), exp.paren(right), { wrap: false })));
}

/** py:1484 */
function _xor_sql(self, expression) {
  const round_input = expression.args.round_input;
  const left = _round_arg(expression.this, round_input);
  const right = _round_arg(expression.expression, round_input);
  return self.sql(
    exp.or_(
      exp.paren(exp.and_(left.copy(), exp.paren(right.not_()), { wrap: false })),
      exp.paren(exp.and_(exp.paren(left.not_()), right.copy(), { wrap: false })),
      { wrap: false },
    ),
  );
}

/** py:1553 `class DuckDBGenerator(generator.Generator)`. */
export class DuckDBGenerator extends Generator {
  // Instance method overrides (base `Generator` has no `datetrunc_sql`/
  // `datetimetrunc_sql`/`timestamptrunc_sql` of its own — `exp.DateTrunc` etc.
  // fall back to `function_fallback_sql` unless a dialect generator defines one
  // of these; `_buildDispatch` (src/generator.js) only fills in a method-name
  // string for a class with no matching `TRANSFORMS` entry, which is the case
  // for all three here, so defining them is sufficient to wire the dispatch).

  /** py:4419 `datetrunc_sql(self, expression)` */
  datetrunc_sql(expression) {
    const unit_expr = expression.args.unit;
    const date = expression.this;

    const week_start = _week_trunc_start_dow(unit_expr);
    const unit = unit_to_str(expression);

    let result;
    if (week_start) {
      result = this.sql(_build_week_trunc_expression(date, week_start, { preserve_start_day: true }));
    } else {
      result = this.func("DATE_TRUNC", unit, date);
    }

    if (
      expression.args.input_type_preserved
      && date.isType(...exp.DataType.TEMPORAL_TYPES)
      && !(isDateUnit(unit) && date.isType(exp.DType.DATE))
    ) {
      return this.sql(new exp.Cast({ this: result, to: date.type }));
    }

    return result;
  }

  /** py:4438 `datetimetrunc_sql(self, expression)` */
  datetimetrunc_sql(expression) {
    const this_ = exp.cast(expression.this, exp.DType.DATETIME);
    const week_start = _week_trunc_start_dow(expression.args.unit);
    if (week_start) {
      return this.sql(_build_week_trunc_expression(this_, week_start, { preserve_start_day: true, cast_to_date: false }));
    }
    return this.func("DATE_TRUNC", unit_to_str(expression), this_);
  }

  /** py:4448 `timestamptrunc_sql(self, expression)` */
  timestamptrunc_sql(expression) {
    const zone = expression.args.zone;
    let timestamp = expression.this;
    const week_start = _week_trunc_start_dow(expression.args.unit);

    // The week start emulation below is exact, so avoid weekstart_unit_to_str's degrade warning
    const unit = week_start ? unit_to_str(expression) : weekstart_unit_to_str(this, expression);
    const date_unit = isDateUnit(unit) || Boolean(week_start);

    const trunc_expr = (this_) => {
      if (week_start) return _build_week_trunc_expression(this_, week_start, { preserve_start_day: true, cast_to_date: false });
      return exp.func("DATE_TRUNC", unit, this_);
    };

    if (date_unit && zone) {
      // BigQuery's TIMESTAMP_TRUNC with timezone truncates in the target timezone and returns as UTC.
      // Double AT TIME ZONE needed for BigQuery compatibility:
      // 1. First AT TIME ZONE: ensures truncation happens in the target timezone
      // 2. Second AT TIME ZONE: converts the DATE result back to TIMESTAMPTZ (preserving time component)
      timestamp = new exp.AtTimeZone({ this: timestamp, zone });
      let trunced = trunc_expr(timestamp);
      if (trunced instanceof exp.DateAdd) {
        // Parenthesize so the trailing AT TIME ZONE binds to the whole shifted expression
        trunced = new exp.Paren({ this: trunced });
      }
      return this.sql(new exp.AtTimeZone({ this: trunced, zone }));
    }

    let result = this.sql(trunc_expr(timestamp));
    if (expression.args.input_type_preserved) {
      if (timestamp.type && timestamp.isType(exp.DType.TIME, exp.DType.TIMETZ)) {
        const dummy_date = new exp.Cast({ this: exp.Literal.string("1970-01-01"), to: new exp.DataType({ this: exp.DType.DATE }) });
        const date_time = new exp.Add({ this: dummy_date, expression: timestamp });
        result = this.func("DATE_TRUNC", unit, date_time);
        return this.sql(new exp.Cast({ this: result, to: timestamp.type }));
      }

      if (timestamp.isType(...exp.DataType.TEMPORAL_TYPES) && !(date_unit && timestamp.isType(exp.DType.DATE))) {
        return this.sql(new exp.Cast({ this: result, to: timestamp.type }));
      }
    }

    return result;
  }

  static PARAMETER_TOKEN = "$";
  static NAMED_PLACEHOLDER_TOKEN = "$";
  static JOIN_HINTS = false;
  static TABLE_HINTS = false;
  static QUERY_HINTS = false;
  static LIMIT_FETCH = "LIMIT";
  static STRUCT_DELIMITER = ["(", ")"];
  static RENAME_TABLE_WITH_DB = false;
  static NVL2_SUPPORTED = false;
  static SEMI_ANTI_JOIN_WITH_SIDE = false;
  static TABLESAMPLE_KEYWORDS = "USING SAMPLE";
  static TABLESAMPLE_SEED_KEYWORD = "REPEATABLE";
  static LAST_DAY_SUPPORTS_DATE_PART = false;
  static JSON_KEY_VALUE_PAIR_SEP = ",";
  static IGNORE_NULLS_IN_FUNC = true;
  static IGNORE_NULLS_BEFORE_ORDER = false;
  static JSON_PATH_BRACKETED_KEY_SUPPORTED = false;
  static SUPPORTS_CREATE_TABLE_LIKE = false;
  static MULTI_ARG_DISTINCT = false;
  static CAN_IMPLEMENT_ARRAY_ANY = true;
  static SUPPORTS_TO_NUMBER = false;
  static SELECT_KINDS = [];
  static SUPPORTS_DECODE_CASE = false;
  static SUPPORTS_DROP_ALTER_ICEBERG_PROPERTY = false;

  /** py:1579 `AFTER_HAVING_MODIFIER_TRANSFORMS = generator.AFTER_HAVING_MODIFIER_TRANSFORMS` */
  static AFTER_HAVING_MODIFIER_TRANSFORMS = Generator.AFTER_HAVING_MODIFIER_TRANSFORMS;
  static SUPPORTS_WINDOW_EXCLUDE = true;
  static COPY_HAS_INTO_KEYWORD = false;
  static STAR_EXCEPT = "EXCLUDE";
  static PAD_FILL_PATTERN_IS_REQUIRED = true;
  static ARRAY_SIZE_DIM_REQUIRED = false;
  static NORMALIZE_EXTRACT_DATE_PARTS = true;
  static SUPPORTS_LIKE_QUANTIFIERS = false;
  static HISTORICAL_DATA_POST_ALIAS = true;
  static SET_ASSIGNMENT_REQUIRES_VARIABLE_KEYWORD = true;

  /** py:1590 */
  static TRANSFORMS = new Map([
    ...Generator.TRANSFORMS,
    [exp.AnyValue, _anyvalue_sql],
    [exp.ApproxDistinct, approx_count_distinct_sql],
    [exp.Boolnot, _boolnot_sql],
    [exp.Booland, _booland_sql],
    [exp.Boolor, _boolor_sql],
    // py:1597 — both `inherit_struct_field_names` (src/transforms.js) and
    // `inline_array_unless_query` (src/dialects/dialect.js) were ported in a later
    // session than this file's own pass (R22 "stubs outlive their stated blocker");
    // this entry was still commented out as "blocked" despite both existing.
    [exp.Array, preprocess([inherit_struct_field_names], inline_array_unless_query)],
    [exp.ArrayAppend, array_append_sql("LIST_APPEND")],
    // py:1602 [exp.ArrayCompact, array_compact_sql] — blocked, dialect.js does not yet export `array_compact_sql`
    // py:1603 [exp.ArrayConstructCompact, lambda] — blocked, depends on the excluded ArrayCompact entry
    [exp.ArrayConcat, array_concat_sql("LIST_CONCAT")],
    // py:1607 [exp.ArrayContains, _array_contains_sql] — NOTE: real DuckDB `ArrayContains` (Snowflake-sourced,
    // `check_null` flag) is ported above as `_array_contains_sql`, wired below.
    [exp.ArrayContains, _array_contains_sql],
    // py:1608 [exp.ArrayOverlaps, _array_overlaps_sql] — blocked, `_array_overlaps_sql` (42 lines) out of scope this pass
    [exp.ArrayFilter, rename_func("LIST_FILTER")],
    [exp.ArrayInsert, _array_insert_sql],
    // py:1611 [exp.ArrayPosition, lambda] — blocked, needs `zero_based` arg semantics not yet checked against a base method this pass touches
    [exp.ArrayRemoveAt, _array_remove_at_sql],
    // py:1622 [exp.ArrayRemove, remove_from_array_using_filter] — blocked, dialect.js does not yet export `remove_from_array_using_filter`
    [exp.ArraySort, _array_sort_sql],
    // py:2652 `sortarray_sql` — a `*_sql` METHOD override upstream, not a TRANSFORMS
    // lambda, so it sits outside this file's py:1590-1814 anchor range; ported here as
    // a module-level function (`_sortarray_sql`) matching this file's existing
    // TRANSFORMS-entry convention (`_array_sort_sql`, `_array_contains_sql` above).
    [exp.SortArray, _sortarray_sql],
    [exp.ArrayPrepend, array_append_sql("LIST_PREPEND", true)],
    [exp.ArraySum, rename_func("LIST_SUM")],
    [exp.ArrayMax, rename_func("LIST_MAX")],
    [exp.ArrayMin, rename_func("LIST_MIN")],
    // py:1628-1629 [exp.Base64DecodeBinary/String, lambda] — blocked, needs this file's own `_base64_decode_sql`
    // py:1630 [exp.BitwiseAnd, lambda self._bitwise_op] — blocked, `_bitwise_op` is a DuckDBGenerator method not ported this pass
    // py:1631 [exp.BitwiseAndAgg, _bitwise_agg_sql] — blocked, 33-line local helper out of scope this pass
    [exp.BitwiseCount, rename_func("BIT_COUNT")],
    // py:1633 [exp.BitwiseLeftShift, _bitshift_sql] — blocked, 36-line local helper out of scope this pass
    // py:1634 [exp.BitwiseOr, lambda self._bitwise_op] — blocked, same as BitwiseAnd above
    // py:1635 [exp.BitwiseOrAgg, _bitwise_agg_sql] — blocked, same as BitwiseAndAgg above
    // py:1636 [exp.BitwiseRightShift, _bitshift_sql] — blocked, same as BitwiseLeftShift above
    // py:1637 [exp.BitwiseXorAgg, _bitwise_agg_sql] — blocked, same as BitwiseAndAgg above
    [exp.BoolxorAgg, _boolxor_agg_sql],
    [exp.CommentColumnConstraint, no_comment_column_constraint_sql],
    // py:1639 [exp.Corr, lambda self._corr_sql] — blocked, `_corr_sql` is a DuckDBGenerator method not ported this pass
    [exp.CosineDistance, rename_func("LIST_COSINE_DISTANCE")],
    [exp.CurrentTime, () => "CURRENT_TIME"],
    [exp.CurrentSchemas, (self, e) => self.func("current_schemas", e.this || exp.true_())],
    [
      exp.CurrentTimestamp,
      (self, e) =>
        e.args.sysdate
          ? self.sql(new exp.AtTimeZone({ this: exp.var_("CURRENT_TIMESTAMP"), zone: exp.Literal.string("UTC") }))
          : "CURRENT_TIMESTAMP",
    ],
    [exp.CurrentVersion, rename_func("version")],
    [exp.Localtime, unsupported_args("this")(() => "LOCALTIME")],
    [exp.DayOfMonth, rename_func("DAYOFMONTH")],
    [exp.DayOfWeek, rename_func("DAYOFWEEK")],
    [exp.DayOfWeekIso, rename_func("ISODOW")],
    [exp.DayOfYear, rename_func("DAYOFYEAR")],
    [
      exp.Dayname,
      (self, e) => (e.args.abbreviated ? self.func("STRFTIME", e.this, exp.Literal.string("%a")) : self.func("DAYNAME", e.this)),
    ],
    [
      exp.Monthname,
      (self, e) => (e.args.abbreviated ? self.func("STRFTIME", e.this, exp.Literal.string("%b")) : self.func("MONTHNAME", e.this)),
    ],
    // py:1668 [exp.DataType, _datatype_sql] — blocked, DECIMAL/BIGDECIMAL/DECFLOAT scale handling out of scope this pass
    // py:1669 [exp.Date, _date_sql] — blocked, local helper out of scope this pass
    [exp.DateAdd, _date_delta_to_binary_interval_op()],
    [exp.DateFromParts, _date_from_parts_sql],
    [exp.DateSub, _date_delta_to_binary_interval_op()],
    [exp.DateDiff, _date_diff_sql],
    [exp.DateStrToDate, datestrtodate_sql],
    // py:1675 [exp.Datetime, no_datetime_sql] — blocked, needs the unported `TIMEZONES` set
    [exp.DatetimeDiff, _date_diff_sql],
    [exp.DatetimeSub, _date_delta_to_binary_interval_op()],
    [exp.DatetimeAdd, _date_delta_to_binary_interval_op()],
    // py:1679-1681 [exp.DateToDi, lambda] — skipped, low value (DI = Julian "date-as-int" legacy format)
    // py:1682-1683 [exp.Decode, exp.HexDecodeString] — blocked, dialect.js does not yet export `encode_decode_sql`
    // py:1684-1686 [exp.DiToDate, lambda] — skipped, pairs with the excluded DateToDi above
    // py:1687 [exp.Encode, lambda] — blocked, same as Decode above
    [
      exp.EqualNull,
      (self, e) => self.sql(new exp.NullSafeEQ({ this: e.this, expression: e.expression })),
    ],
    [exp.EuclideanDistance, rename_func("LIST_DISTANCE")],
    // py:1692,1694 [exp.GenerateDateArray/TimestampArray, _generate_datetime_array_sql]
    // — still blocked, the local helper is out of scope this pass.
    // py:1693 [exp.GenerateSeries, generate_series_sql("GENERATE_SERIES", "RANGE")] —
    // unblocked: `generate_series_sql` (src/dialects/dialect.js:1279) was already a
    // real export, just not imported here (same R22 staleness as the `exp.Array` entry
    // above).
    [exp.GenerateSeries, generate_series_sql("GENERATE_SERIES", "RANGE")],
    // py:1695 [exp.Getbit, getbit_sql] — blocked, dialect.js does not yet export `getbit_sql`
    [exp.GroupConcat, (self, e) => groupconcat_sql(self, e, { within_group: false })],
    [exp.Explode, rename_func("UNNEST")],
    [exp.IcebergProperty, () => ""],
    [exp.IntDiv, (self, e) => self.binary(e, "//")],
    [exp.IsInf, rename_func("ISINF")],
    [exp.IsNan, rename_func("ISNAN")],
    // py:1702-1707 [exp.IsNullValue, exp.IsArray] — skipped, low value (Snowflake-only JSON predicate sugar)
    // py:1708-1709 [exp.Ceil, exp.Floor, _ceil_floor] — blocked, chains through the unported `_scale_rounding_sql`
    // and base `round_sql`/`ceil_floor`
    [exp.JSONBExists, rename_func("JSON_EXISTS")],
    // py:1711-1714 [exp.JSONExtract*, exp.JSONFormat, exp.JSONValueArray] — blocked, local helpers out of scope
    // py:1715 [exp.Lateral, _explode_to_unnest_sql] — blocked, local helper out of scope this pass
    [exp.LogicalOr, (self, e) => self.func("BOOL_OR", _cast_to_boolean(e.this))],
    [exp.LogicalAnd, (self, e) => self.func("BOOL_AND", _cast_to_boolean(e.this))],
    // py:1718-1720 [exp.Select, transforms.preprocess([connect_by_to_recursive_cte, _seq_to_range_in_generator])] — blocked
    // py:1721-1725 [exp.Seq1/2/4/8, exp.BoolxorAgg dup-region] — blocked, `_seq_sql` local helper out of scope this pass
    // py:1726 [exp.MakeInterval, lambda] wraps `no_make_interval_sql` directly — real, wired below
    [exp.MakeInterval, (self, e) => no_make_interval_sql(self, e, " ")],
    // py:1727-1732 [exp.Initcap, exp.MD5Digest, exp.SHA*] — blocked, local helpers out of scope this pass
    // py:1733-1734 [exp.MonthsBetween, exp.NextDay, exp.PreviousDay] — blocked, dialect.js `months_between_sql` not
    // yet checked against this file's needs; `_day_navigation_sql` (68 lines) out of scope this pass
    [exp.PercentileCont, rename_func("QUANTILE_CONT")],
    [exp.PercentileDisc, rename_func("QUANTILE_DISC")],
    // py:1739 [exp.Pivot, transforms.preprocess([transforms.unqualify_columns])] — real now (AIR-2194,
    // PORT_PLAN.md): base `generator.js`'s own `pivot_sql` becoming real surfaced this exact entry as a live
    // MISMATCH (`#dialect: duckdb`'s "Expand PIVOT column combinations" qualify_columns.js fixture — the pivot's
    // aggregate args AND its FOR-list both stay table-qualified through `optimizer/qualify_columns.js`, same as
    // every other column, and this is the dialect-specific GENERATE-time strip that removes it again), verified
    // directly against that fixture, not merely transliterated on faith.
    [exp.Pivot, preprocess([unqualify_columns])],
    [exp.RegexpSplit, rename_func("STR_SPLIT_REGEX")],
    // py:1741-1743,1745-1746 [exp.RegexpILike, exp.RegrValx, exp.RegrValy] — blocked, local helpers out of scope
    // py:1747-1748 [exp.Return, exp.ReturnsProperty] — real, wired below
    [exp.Return, (self, e) => self.sql(e, "this")],
    [exp.ReturnsProperty, (self, e) => (e.this instanceof exp.Schema ? "TABLE" : "")],
    // py:1749-1751 [exp.StrToUnix, lambda] — skipped, chains through DuckDB's own `format_time` handling not
    // separately verified this pass
    [exp.Struct, _struct_sql],
    [exp.Transform, rename_func("LIST_TRANSFORM")],
    [exp.TimeAdd, _date_delta_to_binary_interval_op()],
    [exp.TimeSub, _date_delta_to_binary_interval_op()],
    [exp.Time, no_time_sql],
    // py:1757 [exp.TimeDiff, _timediff_sql] — blocked, BigQuery-specific local helper out of scope this pass
    [exp.Timestamp, no_timestamp_sql],
    [exp.TimestampAdd, _date_delta_to_binary_interval_op()],
    [
      exp.TimestampDiff,
      // py: `exp.Literal.string(e.unit)` — `e.unit` is upstream's `TimeUnit` mixin
      // property (`self.args.get("unit")`, an Expr, usually a `Var`), and `str(Expr)`
      // is `Expr.__str__` -> `self.sql()` (the implicit-`__str__` trap, PORT_PLAN.md
      // "static analysis misses implicit __str__" finding, repeated here since a bare
      // JS template literal on an Expr would call `.toString()`, not `.sql()`).
      // `.args.unit` is read directly rather than `.unit`, because this port has not
      // installed a `unit` getter for `TimestampDiff` (only `DateTrunc` has one so far,
      // `expressions/focused_methods.js:251`) — always the same value, no getter needed.
      (self, e) => self.func("DATE_DIFF", exp.Literal.string(e.args.unit ? e.args.unit.sql() : "None"), e.expression, e.this),
    ],
    [exp.TimestampSub, _date_delta_to_binary_interval_op()],
    [exp.TimeStrToDate, (self, e) => self.sql(exp.cast(e.this, exp.DType.DATE))],
    [exp.TimeStrToTime, timestrtotime_sql],
    [
      exp.TimeStrToUnix,
      (self, e) => self.func("EPOCH", exp.cast(e.this, exp.DType.TIMESTAMP)),
    ],
    [exp.TimeToStr, (self, e) => self.func("STRFTIME", e.this, self.format_time(e))],
    // py:1770 [exp.ToBoolean, _to_boolean_sql] — blocked, 54-line local helper out of scope this pass
    [
      exp.ToVariant,
      (self, e) => self.sql(exp.cast(e.this, exp.DataType.build("VARIANT", { dialect: "duckdb" }))),
    ],
    [exp.TimeToUnix, rename_func("EPOCH")],
    [
      exp.TsOrDiToDi,
      (self, e) => `CAST(SUBSTR(REPLACE(CAST(${self.sql(e, "this")} AS TEXT), '-', ''), 1, 8) AS INT)`,
    ],
    [exp.TsOrDsAdd, _date_delta_to_binary_interval_op()],
    [
      exp.TsOrDsDiff,
      (self, e) =>
        self.func(
          "DATE_DIFF",
          // deny:implicit_str sqlglot/generators/duckdb.py:1781 — py: `f"'{e.args.get('unit') or 'DAY'}'"`.
          // `e.args.unit` is an Expr (usually a `Var`) when present, and Python's f-string
          // calls its implicit `str()` -> `Expr.__str__` -> `self.sql()`; a bare JS
          // template literal would call `.toString()` instead, which this port's `Expr`
          // overrides to the VERBOSE repr (`Var(this=DAY)`, not `DAY`) — so `.sql()` is
          // explicit here (same trap R21 already found once, `_json_extract_value_array_sql`).
          `'${e.args.unit ? e.args.unit.sql() : "DAY"}'`,
          exp.cast(e.expression, exp.DType.TIMESTAMP),
          exp.cast(e.this, exp.DType.TIMESTAMP),
        ),
    ],
    [exp.UnixMicros, (self, e) => self.func("EPOCH_US", _implicit_datetime_cast(e.this))],
    [exp.UnixMillis, (self, e) => self.func("EPOCH_MS", _implicit_datetime_cast(e.this))],
    [
      exp.UnixSeconds,
      (self, e) => self.sql(exp.cast(self.func("EPOCH", _implicit_datetime_cast(e.this)), exp.DType.BIGINT)),
    ],
    [
      exp.UnixToStr,
      (self, e) => self.func("STRFTIME", self.func("TO_TIMESTAMP", e.this), self.format_time(e)),
    ],
    // py:1793 [exp.UnixToTime, _unix_to_time_sql] — blocked, 33-line local helper out of scope this pass
    [
      exp.UnixToTimeStr,
      (self, e) => `CAST(TO_TIMESTAMP(${self.sql(e, "this")}) AS TEXT)`,
    ],
    [exp.VariancePop, rename_func("VAR_POP")],
    [exp.WeekOfYear, rename_func("WEEKOFYEAR")],
    // py:1797,1803 [exp.YearOfWeek, exp.YearOfWeekIso] — unblocked: both build an
    // `exp.Extract` node and render it, which now dispatches to the DuckDB-specific
    // `extract_sql` override below (base `generator.js`'s own `extract_sql` is real
    // too, `map_date_part`'s cross-module-import hazard from R32 having since been
    // resolved — stale per R22, "stubs outlive their stated blocker").
    [
      exp.YearOfWeek,
      (self, e) => self.sql(new exp.Extract({ this: exp.var("ISOYEAR"), expression: e.this })),
    ],
    [
      exp.YearOfWeekIso,
      (self, e) => self.sql(new exp.Extract({ this: exp.var("ISOYEAR"), expression: e.this })),
    ],
    [exp.Xor, _xor_sql],
    [exp.JSONObjectAgg, rename_func("JSON_GROUP_OBJECT")],
    [exp.JSONBObjectAgg, rename_func("JSON_GROUP_OBJECT")],
    [exp.DateBin, rename_func("TIME_BUCKET")],
    // py:1813 [exp.LastDay, _last_day_sql] — blocked, 57-line local helper out of scope this pass
  ]);

  /** py:1816 */
  static SUPPORTED_JSON_PATH_PARTS = new Set([
    exp.JSONPathKey,
    exp.JSONPathRoot,
    exp.JSONPathSubscript,
    exp.JSONPathWildcard,
  ]);

  /** py:1823 */
  static TYPE_MAPPING = new Map([
    ...Generator.TYPE_MAPPING,
    [exp.DType.BINARY, "BLOB"],
    [exp.DType.BPCHAR, "TEXT"],
    [exp.DType.CHAR, "TEXT"],
    [exp.DType.DATETIME, "TIMESTAMP"],
    [exp.DType.DECFLOAT, "DECIMAL"],
    [exp.DType.FLOAT, "REAL"],
    [exp.DType.JSONB, "JSON"],
    [exp.DType.NCHAR, "TEXT"],
    [exp.DType.NVARCHAR, "TEXT"],
    [exp.DType.UINT, "UINTEGER"],
    [exp.DType.VARBINARY, "BLOB"],
    [exp.DType.ROWVERSION, "BLOB"],
    [exp.DType.VARCHAR, "TEXT"],
    [exp.DType.TIMESTAMPLTZ, "TIMESTAMPTZ"],
    [exp.DType.TIMESTAMPNTZ, "TIMESTAMP"],
    [exp.DType.TIMESTAMP_S, "TIMESTAMP_S"],
    [exp.DType.TIMESTAMP_MS, "TIMESTAMP_MS"],
    [exp.DType.TIMESTAMP_NS, "TIMESTAMP_NS"],
    [exp.DType.BIGDECIMAL, "DECIMAL"],
  ]);

  /**
   * py:1852 https://github.com/duckdb/duckdb/blob/ff7f24fd8e3128d94371827523dae85ebaf58713/third_party/libpg_query/grammar/keywords/reserved_keywords.list#L1-L77
   */
  static RESERVED_KEYWORDS = new Set([
    "array", "analyse", "union", "all", "when", "in_p", "default", "create_p", "window",
    "asymmetric", "to", "else", "localtime", "from", "end_p", "select", "current_date",
    "foreign", "with", "grant", "session_user", "or", "except", "references", "fetch",
    "limit", "group_p", "leading", "into", "collate", "offset", "do", "then",
    "localtimestamp", "check_p", "lateral_p", "current_role", "where", "asc_p", "placing",
    "desc_p", "user", "unique", "initially", "column", "both", "some", "as", "any",
    "only", "deferrable", "null_p", "current_time", "true_p", "table", "case", "trailing",
    "variadic", "for", "on", "distinct", "false_p", "not", "constraint",
    "current_timestamp", "returning", "primary", "intersect", "having", "analyze",
    "current_user", "and", "cast", "symmetric", "using", "order", "current_catalog",
  ]);

  /**
   * py:2004 `EXTRACT_STRFTIME_MAPPINGS`.
   * Maps Snowflake specifiers unsupported in DuckDB to strftime format codes.
   */
  static EXTRACT_STRFTIME_MAPPINGS = new Map([
    ["WEEKISO", ["%V", "INTEGER"]],
    ["YEAROFWEEK", ["%G", "INTEGER"]],
    ["YEAROFWEEKISO", ["%G", "INTEGER"]],
    ["NANOSECOND", ["%n", "BIGINT"]],
  ]);

  /** py:2012 `EXTRACT_EPOCH_MAPPINGS`. Maps epoch-based specifiers to DuckDB epoch functions. */
  static EXTRACT_EPOCH_MAPPINGS = new Map([
    ["EPOCH_SECOND", "EPOCH"],
    ["EPOCH_MILLISECOND", "EPOCH_MS"],
    ["EPOCH_MICROSECOND", "EPOCH_US"],
    ["EPOCH_NANOSECOND", "EPOCH_NS"],
  ]);

  /**
   * py:2987 `extract_sql(self, expression)`.
   *
   * Transpile EXTRACT/DATE_PART for DuckDB, handling specifiers not natively
   * supported: WEEKISO, YEAROFWEEK, YEAROFWEEKISO, NANOSECOND, EPOCH_SECOND
   * (as integer), EPOCH_MILLISECOND, EPOCH_MICROSECOND, EPOCH_NANOSECOND.
   */
  extract_sql(expression) {
    const this_ = expression.this;
    const datetime_expr = expression.expression;

    // TIMESTAMPTZ extractions may produce different results between Snowflake and DuckDB
    // because Snowflake applies server timezone while DuckDB uses local timezone
    if (datetime_expr.isType(exp.DType.TIMESTAMPTZ, exp.DType.TIMESTAMPLTZ)) {
      this.unsupported(
        "EXTRACT from TIMESTAMPTZ / TIMESTAMPLTZ may produce different results due to timezone handling differences",
      );
    }

    const part_name = this_.name.toUpperCase();

    if (this.constructor.EXTRACT_STRFTIME_MAPPINGS.has(part_name)) {
      const [fmt, cast_type] = this.constructor.EXTRACT_STRFTIME_MAPPINGS.get(part_name);

      // Problem: strftime doesn't accept TIME and there's no NANOSECOND function
      // So, for NANOSECOND with TIME, fallback to MICROSECOND * 1000
      const is_nano_time = part_name === "NANOSECOND" && datetime_expr.isType(exp.DType.TIME, exp.DType.TIMETZ);

      if (is_nano_time) {
        this.unsupported("Parameter NANOSECOND is not supported with TIME type in DuckDB");
        return this.sql(
          exp.cast(
            new exp.Mul({
              this: new exp.Extract({ this: exp.var("MICROSECOND"), expression: datetime_expr }),
              expression: exp.Literal.number(1000),
            }),
            exp.DataType.build(cast_type, { dialect: "duckdb" }),
          ),
        );
      }

      // For NANOSECOND, cast to TIMESTAMP_NS to preserve nanosecond precision
      let strftime_input = datetime_expr;
      if (part_name === "NANOSECOND") strftime_input = exp.cast(datetime_expr, exp.DType.TIMESTAMP_NS);

      return this.sql(
        exp.cast(
          new exp.Anonymous({ this: "STRFTIME", expressions: [strftime_input, exp.Literal.string(fmt)] }),
          exp.DataType.build(cast_type, { dialect: "duckdb" }),
        ),
      );
    }

    if (this.constructor.EXTRACT_EPOCH_MAPPINGS.has(part_name)) {
      const func_name = this.constructor.EXTRACT_EPOCH_MAPPINGS.get(part_name);
      let result = new exp.Anonymous({ this: func_name, expressions: [datetime_expr] });
      // EPOCH returns float, cast to BIGINT for integer result
      if (part_name === "EPOCH_SECOND") result = exp.cast(result, exp.DataType.build("BIGINT", { dialect: "duckdb" }));
      return this.sql(result);
    }

    return super.extract_sql(expression);
  }

  /**
   * py:4349 `addmonths_sql(self, expression)`.
   *
   * Handles three key issues:
   * 1. Float/decimal months: e.g., Snowflake rounds, whereas DuckDB INTERVAL requires integers
   * 2. End-of-month preservation: If input is last day of month, result is last day of result month
   * 3. Type preservation: Maintains DATE/TIMESTAMPTZ types (DuckDB defaults to TIMESTAMP)
   */
  addmonths_sql(expression) {
    let this_ = expression.this;
    if (!this_.type) this_ = annotate_types(this_, { dialect: this.dialect });

    if (this_.isType(...exp.DataType.TEXT_TYPES)) {
      this_ = new exp.Cast({ this: this_, to: new exp.DataType({ this: exp.DType.TIMESTAMP }) });
    }

    // Detect float/decimal months to apply rounding (Snowflake behavior)
    // DuckDB INTERVAL syntax doesn't support non-integer expressions, so use TO_MONTHS
    let months_expr = expression.expression;
    if (!months_expr.type) months_expr = annotate_types(months_expr, { dialect: this.dialect });

    // Build interval or to_months expression based on type
    // Float/decimal case: Round and use TO_MONTHS(CAST(ROUND(value) AS INT))
    const interval_or_to_months = months_expr.isType(exp.DType.FLOAT, exp.DType.DOUBLE, exp.DType.DECIMAL)
      ? exp.func("TO_MONTHS", exp.cast(exp.func("ROUND", months_expr), "INT"))
      // Integer case: standard INTERVAL N MONTH syntax
      : new exp.Interval({ this: months_expr, unit: exp.var("MONTH") });

    const date_add_expr = new exp.Add({ this: this_, expression: interval_or_to_months });

    // Apply end-of-month preservation if Snowflake flag is set
    // CASE WHEN LAST_DAY(date) = date THEN LAST_DAY(result) ELSE result END
    const preserve_eom = expression.args.preserve_end_of_month;
    const result_expr = preserve_eom
      ? exp.case()
          .when(new exp.EQ({ this: exp.func("LAST_DAY", this_), expression: this_ }), exp.func("LAST_DAY", date_add_expr))
          .else_(date_add_expr)
      : date_add_expr;

    // DuckDB's DATE_ADD function returns TIMESTAMP/DATETIME by default, even when the input is DATE
    // To match for example Snowflake's ADD_MONTHS behavior (which preserves the input type)
    // We need to cast the result back to the original type when the input is DATE or TIMESTAMPTZ
    // Example: ADD_MONTHS('2023-01-31'::date, 1) should return DATE, not TIMESTAMP
    if (this_.isType(exp.DType.DATE, exp.DType.TIMESTAMPTZ)) {
      return this.sql(new exp.Cast({ this: result_expr, to: this_.type }));
    }
    return this.sql(result_expr);
  }

  /** py:4670 `approxquantile_sql(self, expression)`. */
  approxquantile_sql(expression) {
    let result = this.func("APPROX_QUANTILE", expression.this, expression.args.quantile);

    // DuckDB returns integers for APPROX_QUANTILE, cast to DOUBLE if the expected type is a real type
    if (expression.isType(...exp.DataType.REAL_TYPES)) result = `CAST(${result} AS DOUBLE)`;

    return result;
  }

  /**
   * py:4679 `approxquantiles_sql(self, expression)`.
   *
   * BigQuery's APPROX_QUANTILES(expr, n) returns an array of n+1 approximate
   * quantile values dividing the input distribution into n equal-sized
   * buckets. Both BigQuery and DuckDB use approximate algorithms for
   * quantile estimation, but BigQuery does not document the specific
   * algorithm used so results may differ. DuckDB does not support RESPECT
   * NULLS.
   */
  approxquantiles_sql(expression) {
    const this_ = expression.this;
    let num_quantiles_expr;
    if (this_ instanceof exp.Distinct) {
      // APPROX_QUANTILES requires 2 args and DISTINCT node grabs both
      if (this_.expressions.length < 2) {
        this.unsupported("APPROX_QUANTILES requires a bucket count argument");
        return this.function_fallback_sql(expression);
      }
      num_quantiles_expr = this_.expressions[1].pop();
    } else {
      num_quantiles_expr = expression.expression;
    }

    if (!(num_quantiles_expr instanceof exp.Literal) || !num_quantiles_expr.isInt) {
      this.unsupported("APPROX_QUANTILES bucket count must be a positive integer");
      return this.function_fallback_sql(expression);
    }

    const num_quantiles = Number(num_quantiles_expr.toPy());
    if (num_quantiles <= 0) {
      this.unsupported("APPROX_QUANTILES bucket count must be a positive integer");
      return this.function_fallback_sql(expression);
    }

    const quantiles = [];
    const denom = pyDecimal(num_quantiles);
    for (let i = 0; i <= num_quantiles; i++) quantiles.push(exp.Literal.number(decDiv(pyDecimal(i), denom)));

    return this.sql(new exp.ApproxQuantile({ this: this_, quantile: new exp.Array({ expressions: quantiles }) }));
  }

  /** py:3952 `unnest_sql(self, expression)`. */
  unnest_sql(expression) {
    const explode_array = expression.args.explode_array;
    if (explode_array) {
      // In BigQuery, UNNESTing a nested array leads to explosion of the top-level array & struct
      // This is transpiled to DDB by transforming "FROM UNNEST(...)" to "FROM (SELECT UNNEST(..., max_depth => 2))"
      expression.expressions.push(new exp.Kwarg({ this: exp.var("max_depth"), expression: exp.Literal.number(2) }));

      // If BQ's UNNEST is aliased, we transform it from a column alias to a table alias in DDB
      let alias = expression.args.alias;
      if (alias instanceof exp.TableAlias) {
        expression.set("alias", null);
        if (alias.columns.length) alias = new exp.TableAlias({ this: seqGet(alias.columns, 0) });
      }

      const unnest_sql = super.unnest_sql(expression);
      const select = new exp.Select({ expressions: [unnest_sql] }).subquery(alias);
      return this.sql(select);
    }

    return super.unnest_sql(expression);
  }
}
