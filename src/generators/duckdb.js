// py: sqlglot/generators/duckdb.py — `class DuckDBGenerator(generator.Generator)`.
//
// @ported-ranges sqlglot/generators/duckdb.py 50-50 93-101 213-214 217-229 320-357 359-450 452-540 545-547 549-563 607-648 654-662 670-678 827-845 890-901 903-908 910-949 953-977 1017-1020 1123-1130 1261-1274 1428-1455 1459-1497 1497-1523 1554-1590 1591-1814 1816-1821 1823-1844 1852-1931 2004-2017 2652-2677 2987-3050 3299-3326 3412-3422 3952-3971 4349-4406 4419-4497 4670-4712
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
  array_compact_sql,
  array_concat_sql,
  arrow_json_extract_sql,
  date_delta_to_binary_interval_op,
  count_if_to_sum,
  datestrtodate_sql,
  encode_decode_sql,
  explode_to_unnest_sql,
  generate_series_sql,
  getbit_sql,
  groupconcat_sql,
  inline_array_unless_query,
  no_comment_column_constraint_sql,
  no_datetime_sql,
  no_make_interval_sql,
  no_time_sql,
  no_timestamp_sql,
  remove_from_array_using_filter,
  rename_func,
  strposition_sql,
  timestrtotime_sql,
  unit_to_str,
  week_unit_to_dow,
  weekstart_unit_to_str,
  WEEK_START_DAY_TO_DOW,
  months_between_sql,
} from "../dialects/dialect.js";
import { isDateUnit, seqGet } from "../helper.js";
import { annotate_types } from "../optimizer/annotate_types.js";
import { decDiv, pyDecimal } from "../_py/num.js";
import { pyRepr, pyRstrip, pyUpper } from "../_py/str.js";

// py:50 — used only by `_implicit_datetime_cast` below.
const TIMEZONE_PATTERN = /:\d{2}.*?[+\-]\d{2}(?::\d{2})?/;

// py:74 — used only by `bitmapbitposition_sql` below.
const MAX_BIT_POSITION = exp.Literal.number(32768);

// py:93-101 — SEQ function constants, each a module-level `exp.maybe_parse(...)`
// template parsed once at import time (mirrored here as module-level `maybeParse`
// calls for the same reason) and filled in per call via `exp.replace_placeholders`.
const _SEQ_BASE = exp.maybeParse("(ROW_NUMBER() OVER (ORDER BY 1) - 1)");
const _SEQ_RESTRICTED = [exp.Where, exp.Having, exp.AggFunc, exp.Order, exp.Select];
// Maps SEQ expression types to their byte width (suffix indicates bytes: SEQ1=1, SEQ2=2, etc.)
const _SEQ_BYTE_WIDTH = new Map([[exp.Seq1, 1], [exp.Seq2, 2], [exp.Seq4, 4], [exp.Seq8, 8]]);

// Template for generating signed and unsigned SEQ values within a specified range
const _SEQ_UNSIGNED = exp.maybeParse(":base % :max_val");
const _SEQ_SIGNED = exp.maybeParse(
  "(CASE WHEN :base % :max_val >= :half "
  + "THEN :base % :max_val - :max_val "
  + "ELSE :base % :max_val END)",
);

// py:62-63 — RANDSTR constants used by `randstr_sql` below.
const RANDSTR_CHAR_POOL = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const RANDSTR_SEED = 123456;

// py:1954 `ZIPF_TEMPLATE` — CDF-based inverse sampling for Snowflake's ZIPF.
const ZIPF_TEMPLATE = exp.maybeParse(`
  WITH rand AS (SELECT :random_expr AS r),
  weights AS (
      SELECT i, 1.0 / POWER(i, :s) AS w
      FROM RANGE(1, :n + 1) AS t(i)
  ),
  cdf AS (
      SELECT i, SUM(w) OVER (ORDER BY i) / SUM(w) OVER () AS p
      FROM weights
  )
  SELECT MIN(i)
  FROM cdf
  WHERE p >= (SELECT r FROM rand)
`);

// py:1973 `NORMAL_TEMPLATE` — Box-Muller transform:
// mean + (stddev * sqrt(-2 * ln(u1)) * cos(2 * pi * u2))
const NORMAL_TEMPLATE = exp.maybeParse(
  ":mean + (:stddev * SQRT(-2 * LN(GREATEST(:u1, 1e-10))) * COS(2 * PI() * :u2))",
);

// py:1978 `SEEDED_RANDOM_TEMPLATE` — a seeded pseudo-random value in [0, 1) from a hash.
const SEEDED_RANDOM_TEMPLATE = exp.maybeParse("(ABS(HASH(:seed)) % 1000000) / 1000000.0");

// py:1990 `MAPCAT_TEMPLATE` — Snowflake MAP_CAT semantics: NULL if either input is NULL,
// COALESCE(m2[k], m1[k]) for duplicate keys, NULL-valued entries filtered out.
const MAPCAT_TEMPLATE = exp.maybeParse(`
  CASE
      WHEN :map1 IS NULL OR :map2 IS NULL THEN NULL
      ELSE MAP_FROM_ENTRIES(LIST_FILTER(LIST_TRANSFORM(
          LIST_DISTINCT(LIST_CONCAT(MAP_KEYS(:map1), MAP_KEYS(:map2))),
          __k -> STRUCT_PACK(key := __k, value := COALESCE(:map2[__k], :map1[__k]))
      ), __x -> __x.value IS NOT NULL))
  END
`);

// py:2081 `RANDSTR_TEMPLATE`.
const RANDSTR_TEMPLATE = exp.maybeParse(`
  SELECT LISTAGG(
      SUBSTRING(
          '${RANDSTR_CHAR_POOL}',
          1 + CAST(FLOOR(random_value * 62) AS INT),
          1
      ),
      ''
  )
  FROM (
      SELECT (ABS(HASH(i + :seed)) % 1000) / 1000.0 AS random_value
      FROM RANGE(:length) AS t(i)
  )
`);

/**
 * py:2181 `ARRAY_BAG_TEMPLATE` — shared bag semantics outer frame for ARRAY_EXCEPT
 * and ARRAY_INTERSECTION.
 *
 * Each element is paired with its 1-based position via LIST_ZIP, then filtered
 * by a comparison operator (supplied via :cond) that determines the operation:
 *   EXCEPT (>):        keep the N-th occurrence only if N > count in arr2
 *                      e.g. [2,2,2] EXCEPT [2,2] -> [2]
 *   INTERSECTION (<=): keep the N-th occurrence only if N <= count in arr2
 *                      e.g. [2,2,2] INTERSECT [2,2] -> [2,2]
 * IS NOT DISTINCT FROM is used for NULL-safe element comparison.
 */
// py:2157 `UUID_V5_TEMPLATE` — UUID v5 (namespace + name), emulated via SHA1.
const UUID_V5_TEMPLATE = exp.maybeParse(`
  (SELECT
      LOWER(
          SUBSTR(h, 1, 8) || '-' ||
          SUBSTR(h, 9, 4) || '-' ||
          '5' || SUBSTR(h, 14, 3) || '-' ||
          FORMAT('{:02x}', CAST('0x' || SUBSTR(h, 17, 2) AS INT) & 63 | 128) || SUBSTR(h, 19, 2) || '-' ||
          SUBSTR(h, 21, 12)
      )
  FROM (
      SELECT SUBSTR(SHA1(UNHEX(REPLACE(:namespace, '-', '')) || ENCODE(:name, 'utf8')), 1, 32) AS h
  ))
`);

const ARRAY_BAG_TEMPLATE = exp.maybeParse(`
  CASE
      WHEN :arr1 IS NULL OR :arr2 IS NULL THEN NULL
      ELSE LIST_TRANSFORM(
          LIST_FILTER(
              LIST_ZIP(:arr1, GENERATE_SERIES(1, LEN(:arr1))),
              pair -> :cond
          ),
          pair -> pair[0]
      )
  END
`);

// py:2196 `ARRAY_EXCEPT_CONDITION`.
const ARRAY_EXCEPT_CONDITION = exp.maybeParse(
  "LEN(LIST_FILTER(:arr1[1:pair[1]], e -> e IS NOT DISTINCT FROM pair[0]))"
  + " > LEN(LIST_FILTER(:arr2, e -> e IS NOT DISTINCT FROM pair[0]))",
);

// py:2201 `ARRAY_INTERSECTION_CONDITION`.
const ARRAY_INTERSECTION_CONDITION = exp.maybeParse(
  "LEN(LIST_FILTER(:arr1[1:pair[1]], e -> e IS NOT DISTINCT FROM pair[0]))"
  + " <= LEN(LIST_FILTER(:arr2, e -> e IS NOT DISTINCT FROM pair[0]))",
);

/**
 * py:2210 `ARRAY_EXCEPT_SET_TEMPLATE` — set semantics for ARRAY_EXCEPT. Deduplicates
 * arr1 via LIST_DISTINCT, then filters out any element that appears at least once in
 * arr2.
 *   e.g. [1,1,2,3] EXCEPT [1] -> [2,3]
 * IS NOT DISTINCT FROM is used for NULL-safe element comparison.
 */
const ARRAY_EXCEPT_SET_TEMPLATE = exp.maybeParse(`
  CASE
      WHEN :arr1 IS NULL OR :arr2 IS NULL THEN NULL
      ELSE LIST_FILTER(
          LIST_DISTINCT(:arr1),
          e -> LEN(LIST_FILTER(:arr2, x -> x IS NOT DISTINCT FROM e)) = 0
      )
  END
`);

/**
 * py:2230 `IN_UNNEST_TEMPLATE` — BigQuery's `x IN UNNEST(arr)` NULL semantics:
 *   NULL IN UNNEST([1, 2])  -> NULL
 *   3 IN UNNEST([1, NULL])  -> NULL
 *   3 IN UNNEST([1, 2])     -> FALSE
 *   1 IN UNNEST(NULL)       -> FALSE (not NULL)
 *   1 IN UNNEST([])         -> FALSE
 * The default `IN (SELECT UNNEST(...))` rewrite creates a correlated subquery
 * that DuckDB rejects inside non-inner joins, so a CASE expression is used instead.
 */
const IN_UNNEST_TEMPLATE = exp.maybeParse(`
  CASE
      WHEN :arr IS NULL OR ARRAY_LENGTH(:arr) = 0 THEN FALSE
      WHEN ARRAY_CONTAINS(:arr, :value) THEN TRUE
      WHEN :value IS NULL OR ARRAY_LENGTH(:arr) <> LIST_COUNT(:arr) THEN NULL
      ELSE FALSE
  END
`);

/** py:670 `_build_seq_expression(base, byte_width, signed)`. */
function _build_seq_expression(base, byte_width, signed) {
  const bits = byte_width * 8;
  // `2 ** bits` as a JS float loses precision for bits=64 (2^64 doesn't fit in a
  // double's 53-bit mantissa); BigInt exponentiation keeps the exact integer.
  const max_val = exp.Literal.number(2n ** BigInt(bits));

  if (signed) {
    const half = exp.Literal.number(2n ** BigInt(bits - 1));
    return exp.replacePlaceholders(_SEQ_SIGNED.copy(), { base, max_val, half });
  }
  return exp.replacePlaceholders(_SEQ_UNSIGNED.copy(), { base, max_val });
}

/**
 * py:827 `_seq_sql(self, expression, byte_width)`.
 *
 * Transpile Snowflake SEQ1/SEQ2/SEQ4/SEQ8 to DuckDB. Generates monotonically
 * increasing integers starting from 0. The signed parameter (0 or 1) affects
 * wrap-around behavior: unsigned (0) wraps at 2^(bits) - 1; signed (1) wraps
 * at 2^(bits-1) - 1, then goes negative.
 */
function _seq_sql(self, expression, byte_width) {
  // Warn if SEQ is in a restricted context (Select stops search at current scope)
  const ancestor = expression.findAncestor(..._SEQ_RESTRICTED);
  if (
    ancestor
    && (!(ancestor instanceof exp.Order || ancestor instanceof exp.Select)
      || (ancestor instanceof exp.Order && ancestor.parent instanceof exp.Window))
  ) {
    self.unsupported("SEQ in restricted context is not supported - use CTE or subquery");
  }

  const result = _build_seq_expression(_SEQ_BASE.copy(), byte_width, expression.name === "1");
  return self.sql(result);
}

/**
 * py:1497 `_explode_to_unnest_sql(self, expression)` for `exp.Lateral`.
 * Handles LATERAL VIEW EXPLODE/INLINE conversion to UNNEST for DuckDB.
 */
function _explode_to_unnest_sql(self, expression) {
  const explode = expression.this;

  if (explode instanceof exp.Inline) {
    // For INLINE, create CROSS JOIN LATERAL (SELECT UNNEST(..., max_depth => 2))
    // Build the UNNEST call with DuckDB-style named parameter
    const unnest_expr = new exp.Unnest({
      expressions: [explode.this, new exp.Kwarg({ this: exp.var("max_depth"), expression: exp.Literal.number(2) })],
    });
    const select_expr = new exp.Select({ expressions: [unnest_expr] }).subquery();

    let alias_expr = expression.args.alias;
    if (alias_expr && !alias_expr.this) {
      // we need to provide a table name if not present
      alias_expr.set("this", exp.toIdentifier(`_u_${expression.index}`));
    }

    const transformed_lateral_expr = new exp.Lateral({ this: select_expr, alias: alias_expr });
    const cross_join_lateral_expr = new exp.Join({ this: transformed_lateral_expr, kind: "CROSS" });

    return self.sql(cross_join_lateral_expr);
  }

  // For other cases, use the standard conversion
  return explode_to_unnest_sql(self, expression);
}

/** py:545 */
function _array_sort_sql(self, expression) {
  return self.func("ARRAY_SORT", expression.this);
}

/**
 * py:565 `_array_overlaps_sql(self, expression)`.
 *
 * Translates Snowflake's NULL-safe ARRAYS_OVERLAP to DuckDB.
 *
 * DuckDB's native && operator is not NULL-safe: [1,NULL,3] && [NULL,4,5] returns FALSE.
 * Snowflake returns TRUE when both arrays contain NULL (NULLs are treated as known values).
 *
 * Generated SQL: (arr1 && arr2) OR (ARRAY_LENGTH(arr1) <> LIST_COUNT(arr1) AND ARRAY_LENGTH(arr2) <> LIST_COUNT(arr2))
 *
 * ARRAY_LENGTH counts all elements (including NULLs); LIST_COUNT counts only non-NULLs.
 * When they differ, the array contains at least one NULL, matching Snowflake's NULL-safe semantics.
 */
function _array_overlaps_sql(self, expression) {
  if (!expression.args.null_safe) return self.binary(expression, "&&");

  const arr1 = expression.this;
  const arr2 = expression.expression;

  const check_nulls = exp.and_(
    new exp.NEQ({ this: new exp.ArraySize({ this: arr1.copy() }), expression: exp.func("LIST_COUNT", arr1.copy()) }),
    new exp.NEQ({ this: new exp.ArraySize({ this: arr2.copy() }), expression: exp.func("LIST_COUNT", arr2.copy()) }),
    { copy: false },
  );

  const overlap = new exp.ArrayOverlaps({ this: arr1.copy(), expression: arr2.copy() });

  return self.sql(
    exp.or_(exp.paren(overlap, false), exp.paren(check_nulls, false), { copy: false, wrap: false }),
  );
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

/** py:981 `_generate_datetime_array_sql(self, expression)`. */
function _generate_datetime_array_sql(self, expression) {
  const is_generate_date_array = expression instanceof exp.GenerateDateArray;

  const type = is_generate_date_array ? exp.DType.DATE : exp.DType.TIMESTAMP;
  const start = _implicit_datetime_cast(expression.args.start, { type });
  const end = _implicit_datetime_cast(expression.args.end, { type });

  // BQ's GENERATE_DATE_ARRAY & GENERATE_TIMESTAMP_ARRAY are transformed to DuckDB'S GENERATE_SERIES
  let gen_series = new exp.GenerateSeries({ start, end, step: expression.args.step });

  if (is_generate_date_array) {
    // The GENERATE_SERIES result type is TIMESTAMP array, so to match BQ's semantics for
    // GENERATE_DATE_ARRAY we must cast it back to DATE array
    gen_series = exp.cast(gen_series, exp.DataType.fromStr("ARRAY<DATE>"));
  }

  return self.sql(gen_series);
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

// py:305-306 — BigQuery -> DuckDB conversion for the TIME_DIFF function
/** py:306 `_timediff_sql(self, expression)`. */
function _timediff_sql(self, expression) {
  const unit = expression.args.unit;

  if (_is_nanosecond_unit(unit)) return _handle_nanosecond_diff(self, expression.expression, expression.this);

  const this_ = exp.cast(expression.this, exp.DType.TIME);
  const expr = exp.cast(expression.expression, exp.DType.TIME);

  // Although the 2 dialects share similar signatures, BQ seems to inverse
  // the sign of the result so the start/end time operands are flipped
  return self.func("DATE_DIFF", unit_to_str(expression), expr, this_);
}

/**
 * py:1360 `_regr_val_sql(self, expression)`.
 *
 * Transpile Snowflake's REGR_VALX/REGR_VALY to DuckDB equivalent.
 *
 * REGR_VALX(y, x) returns NULL if y is NULL; otherwise returns x.
 * REGR_VALY(y, x) returns NULL if x is NULL; otherwise returns y.
 */
function _regr_val_sql(self, expression) {
  const y = expression.this;
  const x = expression.expression;

  // Determine which argument to check for NULL and which to return based on expression type
  let check_for_null, return_value, return_value_attr;
  if (expression instanceof exp.RegrValx) {
    // REGR_VALX: check y for NULL, return x
    check_for_null = y;
    return_value = x;
    return_value_attr = "expression";
  } else {
    // REGR_VALY: check x for NULL, return y
    check_for_null = x;
    return_value = y;
    return_value_attr = "this";
  }

  // Get the type from the return argument
  let result_type = return_value.type;

  // If no type info, annotate the expression to infer types
  if (!result_type || result_type.this === exp.DType.UNKNOWN) {
    try {
      const annotated = annotate_types(expression.copy(), { dialect: self.dialect });
      result_type = annotated.args[return_value_attr].type;
    } catch { /* fall through to the DOUBLE default below */ }
  }

  // Default to DOUBLE for regression functions if type still unknown
  if (!result_type || result_type.this === exp.DType.UNKNOWN) {
    result_type = exp.DType.DOUBLE.intoExpr();
  }

  // Cast NULL to the same type as return_value to avoid DuckDB type inference issues
  const typed_null = new exp.Cast({ this: new exp.Null(), to: result_type });

  return self.sql(
    new exp.If({
      this: new exp.Is({ this: check_for_null.copy(), expression: new exp.Null() }),
      true: typed_null,
      false: return_value.copy(),
    }),
  );
}

/**
 * py:1312 `_scale_rounding_sql(self, expression, rounding_func)`.
 *
 * Handle scale parameter transformation for rounding functions.
 *
 * DuckDB doesn't support the scale parameter for certain functions (e.g., FLOOR, CEIL),
 * so we transform: FUNC(x, n) to ROUND(FUNC(x * 10^n) / 10^n, n)
 *
 * Returns the transformed SQL string if decimals parameter exists, `null` otherwise.
 */
function _scale_rounding_sql(self, expression, rounding_func) {
  const decimals = expression.args.decimals;

  if (decimals === null || decimals === undefined || expression.args.to !== null && expression.args.to !== undefined) {
    return null;
  }

  let this_ = expression.this;
  if (this_ instanceof exp.Binary) this_ = new exp.Paren({ this: this_ });

  let n_int = decimals;
  if (!(decimals.isInt || decimals.isType(...exp.DataType.INTEGER_TYPES))) {
    n_int = exp.cast(decimals, exp.DType.INT);
  }

  const pow_ = new exp.Pow({ this: exp.Literal.number("10"), expression: n_int });
  const rounded = new rounding_func({ this: new exp.Mul({ this: this_, expression: pow_ }) });
  const result = new exp.Div({ this: rounded, expression: pow_.copy() });

  return self.round_sql(new exp.Round({ this: result, decimals, casts_non_integer_decimals: true }));
}

/** py:1353 `_ceil_floor(self, expression)`. */
function _ceil_floor(self, expression) {
  const scaled_sql = _scale_rounding_sql(self, expression, expression.constructor);
  if (scaled_sql !== null) return scaled_sql;
  return self.ceil_floor(expression);
}

/**
 * py:107 `_apply_base64_alphabet_replacements(result, alphabet, reverse=False)`.
 *
 * Apply base64 alphabet character replacements.
 *
 * Base64 alphabet can be 1-3 chars: 1st = index 62 ('+'), 2nd = index 63 ('/'), 3rd = padding ('=').
 * `zip` truncates to the shorter string, so a 1-char alphabet only replaces '+', 2-char replaces '+/', etc.
 *
 * `reverse`: if False, replace default with custom (encode); if True, replace custom with default (decode).
 */
function _apply_base64_alphabet_replacements(result, alphabet, reverse = false) {
  if (alphabet instanceof exp.Literal && alphabet.isString) {
    const defaults = [..."+/="];
    const news = [...alphabet.this];
    const n = Math.min(defaults.length, news.length);
    for (let i = 0; i < n; i++) {
      const default_char = defaults[i], new_char = news[i];
      if (new_char !== default_char) {
        const [find, replace] = reverse ? [new_char, default_char] : [default_char, new_char];
        result = new exp.Replace({ this: result, expression: exp.Literal.string(find), replacement: exp.Literal.string(replace) });
      }
    }
  }
  return result;
}

/**
 * py:136 `_base64_decode_sql(self, expression, to_string)`.
 *
 * Transpile Snowflake BASE64_DECODE_STRING/BINARY to DuckDB.
 *
 * DuckDB uses FROM_BASE64() which returns BLOB. For string output, wrap with DECODE().
 * Custom alphabets require REPLACE() calls to convert to standard base64.
 */
function _base64_decode_sql(self, expression, to_string) {
  let input_expr = expression.this;
  const alphabet = expression.args.alphabet;

  // Handle custom alphabet by replacing non-standard chars with standard ones
  input_expr = _apply_base64_alphabet_replacements(input_expr, alphabet, true);

  // FROM_BASE64 returns BLOB
  input_expr = new exp.FromBase64({ this: input_expr });

  if (to_string) input_expr = new exp.Decode({ this: input_expr });

  return self.sql(input_expr);
}

/**
 * py:234 `_to_boolean_sql(self, expression)`.
 *
 * Transpile TO_BOOLEAN and TRY_TO_BOOLEAN functions from Snowflake to DuckDB equivalent.
 *
 * DuckDB's CAST to BOOLEAN supports most of Snowflake's TO_BOOLEAN strings except 'on'/'off'.
 * We need to handle the 'on'/'off' cases explicitly.
 *
 * For TO_BOOLEAN (safe=False): NaN and INF values cause errors. We use DuckDB's native ERROR()
 * function to replicate this behavior with a clear error message.
 *
 * For TRY_TO_BOOLEAN (safe=True): Use DuckDB's TRY_CAST for conversion, which returns NULL
 * for invalid inputs instead of throwing errors.
 */
function _to_boolean_sql(self, expression) {
  const arg = expression.this;
  const is_safe = expression.args.safe || false;

  const base_case_expr = exp.case()
    // Handle 'on' -> TRUE (case insensitive)
    .when(new exp.Upper({ this: exp.cast(arg, exp.DType.VARCHAR) }).eq(exp.Literal.string("ON")), exp.true_())
    // Handle 'off' -> FALSE (case insensitive)
    .when(new exp.Upper({ this: exp.cast(arg.copy(), exp.DType.VARCHAR) }).eq(exp.Literal.string("OFF")), exp.false_());

  let case_expr;
  if (is_safe) {
    // TRY_TO_BOOLEAN: handle 'on'/'off' and use TRY_CAST for everything else
    case_expr = base_case_expr.else_(exp.func("TRY_CAST", arg.copy(), exp.DType.BOOLEAN.intoExpr()));
  } else {
    // TO_BOOLEAN: handle NaN/INF errors, 'on'/'off', and use regular CAST
    const cast_to_real = exp.func("TRY_CAST", arg.copy(), exp.DType.FLOAT.intoExpr());

    // Check for NaN and INF values
    const nan_inf_check = new exp.Or({ this: exp.func("ISNAN", cast_to_real), expression: exp.func("ISINF", cast_to_real.copy()) });

    case_expr = base_case_expr
      .when(nan_inf_check, exp.func("ERROR", exp.Literal.string("TO_BOOLEAN: Non-numeric values NaN and INF are not supported")))
      .else_(exp.cast(arg.copy(), exp.DType.BOOLEAN));
  }

  return self.sql(case_expr);
}

/** py:288 `_date_sql(self, expression)`. */
function _date_sql(self, expression) {
  let this_ = expression.this;
  const zone = self.sql(expression, "zone");

  if (zone) {
    // BigQuery considers "this" at UTC, converts it to the specified
    // time zone and then keeps only the DATE part
    // To micmic that, we:
    //   (1) Cast to TIMESTAMP to remove DuckDB's local tz
    //   (2) Apply consecutive AtTimeZone calls for UTC -> zone conversion
    this_ = exp.cast(this_, exp.DType.TIMESTAMP);
    const at_utc = new exp.AtTimeZone({ this: this_, zone: exp.Literal.string("UTC") });
    this_ = new exp.AtTimeZone({ this: at_utc, zone: expression.args.zone });
  }

  return self.sql(exp.cast(this_, exp.DType.DATE));
}

/**
 * py:158 `_last_day_sql(self, expression)`.
 *
 * DuckDB's LAST_DAY only supports finding the last day of a month.
 * For other date parts (year, quarter, week), we need to implement equivalent logic.
 */
function _last_day_sql(self, expression) {
  const date_expr = expression.this;
  const unit_expr = expression.args.unit;

  const week_start = week_unit_to_dow(unit_expr);
  if (week_start) {
    // The week's last day precedes its start day; DuckDB DAYOFWEEK: Sunday=0, ..., Saturday=6
    const last_dow = week_start - 1;
    const dow = exp.func("EXTRACT", "DAYOFWEEK", date_expr);

    // Days to the last day of week: (last_dow + 7 - dayofweek) % 7
    const days_to_last_expr = new exp.Mod({
      this: exp.paren(new exp.Sub({ this: exp.Literal.number(last_dow + 7), expression: dow })),
      expression: exp.Literal.number(7),
    });
    const interval_expr = new exp.Interval({ this: days_to_last_expr, unit: exp.var("DAY") });
    const add_expr = new exp.Add({ this: date_expr, expression: interval_expr });

    return self.sql(exp.cast(add_expr, exp.DType.DATE));
  }

  const unit = expression.text("unit");

  if (!unit || unit.toUpperCase() === "MONTH") {
    // Default behavior - use DuckDB's native LAST_DAY
    return self.func("LAST_DAY", date_expr);
  }

  if (unit.toUpperCase() === "YEAR") {
    // Last day of year: December 31st of the same year
    const year_expr = exp.func("EXTRACT", "YEAR", date_expr);
    const make_date_expr = exp.func("MAKE_DATE", year_expr, exp.Literal.number(12), exp.Literal.number(31));
    return self.sql(make_date_expr);
  }

  if (unit.toUpperCase() === "QUARTER") {
    // Last day of quarter
    const year_expr = exp.func("EXTRACT", "YEAR", date_expr);
    const quarter_expr = exp.func("EXTRACT", "QUARTER", date_expr);

    // Calculate last month of quarter: quarter * 3. Quarter can be 1 to 4
    const last_month_expr = new exp.Mul({ this: quarter_expr, expression: exp.Literal.number(3) });
    const first_day_last_month_expr = exp.func("MAKE_DATE", year_expr, last_month_expr, exp.Literal.number(1));

    // Last day of the last month of the quarter
    const last_day_expr = exp.func("LAST_DAY", first_day_last_month_expr);
    return self.sql(last_day_expr);
  }

  self.unsupported(`Unsupported date part '${unit}' in LAST_DAY function`);
  return self.function_fallback_sql(expression);
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
/** py:654 `_datatype_sql(self, expression)` for `exp.DataType`. */
function _datatype_sql(self, expression) {
  if (expression.isType("array")) {
    return `${self.expressions(expression, null, { flat: true })}[${self.expressions(expression, "values", { flat: true })}]`;
  }

  // Modifiers are not supported for TIME, [TIME | TIMESTAMP] WITH TIME ZONE
  if (expression.isType(exp.DType.TIME, exp.DType.TIMETZ, exp.DType.TIMESTAMPTZ)) {
    return expression.this.value;
  }

  return self.datatype_sql(expression);
}

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

/** py:878 */
const WRAPPED_JSON_EXTRACT_EXPRESSIONS = [exp.Binary, exp.Bracket, exp.In, exp.Not];

/** py:881 `_arrow_json_extract_sql(self, expression)`. */
function _arrow_json_extract_sql(self, expression) {
  let arrow_sql = arrow_json_extract_sql(self, expression);
  if (!expression.sameParent && WRAPPED_JSON_EXTRACT_EXPRESSIONS.some((cls) => expression.parent instanceof cls)) {
    arrow_sql = self.wrap(arrow_sql);
  }
  return arrow_sql;
}

/** py:1003 `_json_extract_value_array_sql(self, expression)`. */
function _json_extract_value_array_sql(self, expression) {
  const json_extract = new exp.JSONExtract({ this: expression.this, expression: expression.expression });
  const data_type = expression instanceof exp.JSONValueArray ? "ARRAY<STRING>" : "ARRAY<JSON>";
  return self.sql(exp.cast(json_extract, exp.DataType.fromStr(data_type)));
}

/** py:665 `_json_format_sql(self, expression)`. */
function _json_format_sql(self, expression) {
  const sql = self.func("TO_JSON", expression.this, expression.args.options);
  return `CAST(${sql} AS TEXT)`;
}

/** py:848 `_unix_to_time_sql(self, expression)`. */
function _unix_to_time_sql(self, expression) {
  const scale = expression.args.scale;
  let timestamp = expression.this;
  const target_type = expression.args.target_type;

  // Check if we need NTZ (naive timestamp in UTC)
  const is_ntz = target_type && (target_type.this === exp.DType.TIMESTAMP || target_type.this === exp.DType.TIMESTAMPNTZ);

  if (scale && scale.equals(exp.UnixToTime.MILLIS)) {
    // EPOCH_MS already returns TIMESTAMP (naive, UTC)
    return self.func("EPOCH_MS", timestamp);
  }
  if (scale && scale.equals(exp.UnixToTime.MICROS)) {
    // MAKE_TIMESTAMP already returns TIMESTAMP (naive, UTC)
    return self.func("MAKE_TIMESTAMP", timestamp);
  }

  // Other scales: divide and use TO_TIMESTAMP
  if (scale && !scale.equals(exp.UnixToTime.SECONDS)) {
    timestamp = new exp.Div({ this: timestamp, expression: exp.func("POW", 10, scale) });
  }

  let to_timestamp = new exp.Anonymous({ this: "TO_TIMESTAMP", expressions: [timestamp] });

  if (is_ntz) {
    to_timestamp = new exp.AtTimeZone({ this: to_timestamp, zone: exp.Literal.string("UTC") });
  }

  return self.sql(to_timestamp);
}

/** py:1023 `_is_binary(arg)`. */
/**
 * py:1414 `_maybe_corr_null_to_false(expression)`.
 *
 * Unwraps a `Window`/`Filter`-wrapped `exp.Corr` and, if it has
 * `null_on_zero_variance` set, clears the flag and returns the (unwrapped-then-
 * rewrapped) expression; otherwise returns `null`.
 */
function _maybe_corr_null_to_false(expression) {
  let corr = expression;
  while (corr instanceof exp.Window || corr instanceof exp.Filter) corr = corr.this;

  if (!(corr instanceof exp.Corr) || !corr.args.null_on_zero_variance) return null;

  corr.set("null_on_zero_variance", false);
  return expression;
}

/**
 * Shared helper for this file's two `self.dialect.version >= (1, 2)` checks
 * (py:3156 `countif_sql`, py:3168 `bracket_sql`). `dialect.version` is a 3-element
 * BigInt array (PORT_PLAN.md's "non-2^63 sentinel" note); Python tuple comparison
 * `(v0, v1, v2) >= (1, 2)` only ever inspects the first two elements.
 */
function _dialectAtLeast(dialect, major, minor) {
  const v = dialect.version;
  return v[0] > major || (v[0] === major && v[1] >= minor);
}

function _is_binary(arg) {
  return arg.isType(exp.DType.BINARY, exp.DType.VARBINARY, exp.DType.BLOB);
}

/** py:1031 `_gen_with_cast_to_blob(self, expression, result_sql)`. */
function _gen_with_cast_to_blob(self, expression, result_sql) {
  if (_is_binary(expression)) {
    const blob = exp.DataType.fromStr("BLOB", { dialect: "duckdb" });
    result_sql = self.sql(new exp.Cast({ this: result_sql, to: blob }));
  }
  return result_sql;
}

/** py:1038 `_cast_to_bit(arg)`. */
function _cast_to_bit(arg) {
  if (!_is_binary(arg)) return arg;

  if (arg instanceof exp.HexString) arg = new exp.Unhex({ this: exp.Literal.string(arg.this) });

  return exp.cast(arg, exp.DType.BIT);
}

/** py:1048 `_prepare_binary_bitwise_args(expression)`. */
function _prepare_binary_bitwise_args(expression) {
  if (_is_binary(expression.this)) expression.set("this", _cast_to_bit(expression.this));
  if (_is_binary(expression.expression)) expression.set("expression", _cast_to_bit(expression.expression));
}

/**
 * py:1276 `_bitshift_sql(self, expression)`.
 *
 * Transform bitshift expressions for DuckDB by injecting BIT/INT128 casts.
 *
 * DuckDB's bitwise shift operators don't work with BLOB/BINARY types, so we cast
 * them to BIT for the operation, then cast the result back to the original type.
 *
 * Note: Assumes type annotation has been applied with the source dialect.
 */
function _bitshift_sql(self, expression) {
  const operator = expression instanceof exp.BitwiseLeftShift ? "<<" : ">>";
  let result_is_blob = false;
  const this_ = expression.this;

  if (_is_binary(this_)) {
    result_is_blob = true;
    expression.set("this", exp.cast(this_, exp.DType.BIT));
  } else if (expression.args.requires_int128) {
    this_.replace(exp.cast(this_, exp.DType.INT128));
  }

  let result_sql = self.binary(expression, operator);

  // Wrap in parentheses if parent is a bitwise operator to "fix" DuckDB precedence issue
  // DuckDB parses: a << b | c << d  as  (a << b | c) << d
  if (expression.parent instanceof exp.Binary) {
    result_sql = self.sql(new exp.Paren({ this: result_sql }));
  }

  if (result_is_blob) {
    result_sql = self.sql(new exp.Cast({ this: result_sql, to: exp.DataType.fromStr("BLOB", { dialect: "duckdb" }) }));
  }

  return result_sql;
}

/** py:1526 `_sha_sql(self, expression, hash_func, is_binary=False)`. */
function _sha_sql(self, expression, hash_func, is_binary = false) {
  let arg = expression.this;

  // For SHA2 variants, check digest length (DuckDB only supports SHA256)
  if (hash_func === "SHA256") {
    const length = expression.text("length") || "256";
    if (length !== "256") self.unsupported("DuckDB only supports SHA256 hashing algorithm.");
  }

  // Cast if type is incompatible with DuckDB
  if (arg.type && arg.type.this !== exp.DType.UNKNOWN && !arg.isType(...exp.DataType.TEXT_TYPES) && !_is_binary(arg)) {
    arg = exp.cast(arg, exp.DType.VARCHAR);
  }

  const result = self.func(hash_func, arg);
  return is_binary ? self.func("UNHEX", result) : result;
}

/** py:1017 */
function _cast_to_boolean(arg) {
  if (arg && !arg.isType(exp.DType.BOOLEAN)) return exp.cast(arg, exp.DType.BOOLEAN);
  return arg;
}

/**
 * py:1055 `_day_navigation_sql(self, expression)`.
 *
 * Transpile Snowflake's NEXT_DAY / PREVIOUS_DAY to DuckDB using date arithmetic.
 *
 * Returns the DATE of the next/previous occurrence of the specified weekday.
 *
 * Formulas:
 * - NEXT_DAY: (target_dow - current_dow + 6) % 7 + 1
 * - PREVIOUS_DAY: (current_dow - target_dow + 6) % 7 + 1
 */
function _day_navigation_sql(self, expression) {
  const date_expr = expression.this;
  const day_name_expr = expression.expression;

  // Build ISODOW call for current day of week
  const isodow_call = exp.func("ISODOW", date_expr);

  let target_dow;
  if (day_name_expr instanceof exp.Literal) {
    // Literal day name: lookup target_dow directly
    const day_name_str = pyUpper(day_name_expr.name);
    const matching_day = [...WEEK_START_DAY_TO_DOW.keys()].find((day) => day.startsWith(day_name_str));
    if (matching_day) {
      target_dow = exp.Literal.number(WEEK_START_DAY_TO_DOW.get(matching_day));
    } else {
      // Unrecognized day name, use fallback
      return self.function_fallback_sql(expression);
    }
  } else {
    // Non-literal day name: build CASE statement for runtime mapping
    const upper_day_name = new exp.Upper({ this: day_name_expr });
    target_dow = new exp.Case({
      ifs: [...WEEK_START_DAY_TO_DOW].map(([day, dow_num]) =>
        new exp.If({
          this: exp.func("STARTS_WITH", upper_day_name.copy(), exp.Literal.string(day.slice(0, 2))),
          true: exp.Literal.number(dow_num),
        }),
      ),
    });
  }

  // Calculate days offset and apply interval based on direction
  let date_with_offset;
  if (expression instanceof exp.NextDay) {
    // NEXT_DAY: (target_dow - current_dow + 6) % 7 + 1
    const days_offset = exp.paren(target_dow.sub(isodow_call).add(6), false).mod(7).add(1);
    date_with_offset = date_expr.add(new exp.Interval({ this: days_offset, unit: exp.var("DAY") }));
  } else {
    // PREVIOUS_DAY: (current_dow - target_dow + 6) % 7 + 1
    const days_offset = exp.paren(isodow_call.sub(target_dow).add(6), false).mod(7).add(1);
    date_with_offset = date_expr.sub(new exp.Interval({ this: days_offset, unit: exp.var("DAY") }));
  }

  // Build final: CAST(date_with_offset AS DATE)
  return self.sql(exp.cast(date_with_offset, exp.DType.DATE));
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

/**
 * py:1132 `_bitwise_agg_sql(self, expression)`.
 *
 * DuckDB's bitwise aggregate functions only accept integer types. For other types:
 * - DECIMAL/STRING: Use CAST(arg AS INT) to convert directly, will round to nearest int
 * - FLOAT/DOUBLE: Use ROUND(arg)::INT to round to nearest integer, required due to float precision loss
 */
function _bitwise_agg_sql(self, expression) {
  let func_name;
  if (expression instanceof exp.BitwiseOrAgg) func_name = "BIT_OR";
  else if (expression instanceof exp.BitwiseAndAgg) func_name = "BIT_AND";
  else func_name = "BIT_XOR";

  let arg = expression.this;

  if (!arg.type) arg = annotate_types(arg, { dialect: self.dialect });

  if (arg.isType(...exp.DataType.REAL_TYPES, ...exp.DataType.TEXT_TYPES)) {
    if (arg.isType(...exp.DataType.FLOAT_TYPES)) {
      // float types need to be rounded first due to precision loss
      arg = exp.func("ROUND", arg);
    }
    arg = exp.cast(arg, exp.DType.INT);
  }

  return self.func(func_name, arg);
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

  /** py:1951 `IGNORE_RESPECT_NULLS_WINDOW_FUNCTIONS` — py:84 `_IGNORE_RESPECT_NULLS_WINDOW_FUNCTIONS`. */
  static IGNORE_RESPECT_NULLS_WINDOW_FUNCTIONS = [exp.FirstValue, exp.Lag, exp.LastValue, exp.Lead, exp.NthValue];
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
    // py:1602 `ArrayCompact`
    [exp.ArrayCompact, array_compact_sql],
    // py:1603 `ArrayConstructCompact`
    [exp.ArrayConstructCompact, (self, e) => self.sql(new exp.ArrayCompact({ this: new exp.Array({ expressions: e.expressions }) }))],
    [exp.ArrayConcat, array_concat_sql("LIST_CONCAT")],
    // py:1607 [exp.ArrayContains, _array_contains_sql] — NOTE: real DuckDB `ArrayContains` (Snowflake-sourced,
    // `check_null` flag) is ported above as `_array_contains_sql`, wired below.
    [exp.ArrayContains, _array_contains_sql],
    // py:1608 `ArrayOverlaps`
    [exp.ArrayOverlaps, _array_overlaps_sql],
    [exp.ArrayFilter, rename_func("LIST_FILTER")],
    [exp.ArrayInsert, _array_insert_sql],
    // py:1611 `ArrayPosition`
    [
      exp.ArrayPosition,
      (self, e) => e.args.zero_based
        ? self.sql(new exp.Sub({ this: new exp.ArrayPosition({ this: e.this, expression: e.expression }), expression: exp.Literal.number(1) }))
        : self.func("ARRAY_POSITION", e.this, e.expression),
    ],
    [exp.ArrayRemoveAt, _array_remove_at_sql],
    // py:1622 `ArrayRemove`
    [exp.ArrayRemove, remove_from_array_using_filter],
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
    // py:1628-1629 `Base64DecodeBinary`/`Base64DecodeString`
    [exp.Base64DecodeBinary, (self, e) => _base64_decode_sql(self, e, false)],
    [exp.Base64DecodeString, (self, e) => _base64_decode_sql(self, e, true)],
    // py:1630 `BitwiseAnd`
    [exp.BitwiseAnd, (self, e) => self._bitwise_op(e, "&")],
    [exp.BitwiseAndAgg, _bitwise_agg_sql],
    [exp.BitwiseCount, rename_func("BIT_COUNT")],
    // py:1633 `BitwiseLeftShift`
    [exp.BitwiseLeftShift, _bitshift_sql],
    // py:1634 `BitwiseOr`
    [exp.BitwiseOr, (self, e) => self._bitwise_op(e, "|")],
    [exp.BitwiseOrAgg, _bitwise_agg_sql],
    // py:1636 `BitwiseRightShift`
    [exp.BitwiseRightShift, _bitshift_sql],
    [exp.BitwiseXorAgg, _bitwise_agg_sql],
    [exp.BoolxorAgg, _boolxor_agg_sql],
    [exp.CommentColumnConstraint, no_comment_column_constraint_sql],
    // py:1639 `Corr`
    [exp.Corr, (self, e) => self._corr_sql(e)],
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
    [exp.DataType, _datatype_sql],
    // py:1669 `Date`
    [exp.Date, _date_sql],
    [exp.DateAdd, _date_delta_to_binary_interval_op()],
    [exp.DateFromParts, _date_from_parts_sql],
    [exp.DateSub, _date_delta_to_binary_interval_op()],
    [exp.DateDiff, _date_diff_sql],
    [exp.DateStrToDate, datestrtodate_sql],
    // py:1675 `Datetime`
    [exp.Datetime, no_datetime_sql],
    [exp.DatetimeDiff, _date_diff_sql],
    [exp.DatetimeSub, _date_delta_to_binary_interval_op()],
    [exp.DatetimeAdd, _date_delta_to_binary_interval_op()],
    // py:1679-1681 `DateToDi`
    [exp.DateToDi, (self, e) => `CAST(STRFTIME(${self.sql(e, "this")}, ${self.dialect.DATEINT_FORMAT}) AS INT)`],
    // py:1682 `Decode`
    [exp.Decode, (self, e) => encode_decode_sql(self, e, "DECODE", false)],
    // py:1683 `HexDecodeString`
    [exp.HexDecodeString, (self, e) => self.sql(new exp.Decode({ this: new exp.Unhex({ this: e.this }) }))],
    // py:1684-1686 `DiToDate`
    [exp.DiToDate, (self, e) => `CAST(STRPTIME(CAST(${self.sql(e, "this")} AS TEXT), ${self.dialect.DATEINT_FORMAT}) AS DATE)`],
    // py:1687 `Encode`
    [exp.Encode, (self, e) => encode_decode_sql(self, e, "ENCODE", false)],
    [
      exp.EqualNull,
      (self, e) => self.sql(new exp.NullSafeEQ({ this: e.this, expression: e.expression })),
    ],
    [exp.EuclideanDistance, rename_func("LIST_DISTANCE")],
    // py:1692,1694 `GenerateDateArray`/`GenerateTimestampArray`
    [exp.GenerateDateArray, _generate_datetime_array_sql],
    [exp.GenerateTimestampArray, _generate_datetime_array_sql],
    // py:1693 [exp.GenerateSeries, generate_series_sql("GENERATE_SERIES", "RANGE")] —
    // unblocked: `generate_series_sql` (src/dialects/dialect.js:1279) was already a
    // real export, just not imported here (same R22 staleness as the `exp.Array` entry
    // above).
    [exp.GenerateSeries, generate_series_sql("GENERATE_SERIES", "RANGE")],
    // py:1695 `Getbit`
    [exp.Getbit, getbit_sql],
    [exp.GroupConcat, (self, e) => groupconcat_sql(self, e, { within_group: false })],
    [exp.Explode, rename_func("UNNEST")],
    [exp.IcebergProperty, () => ""],
    [exp.IntDiv, (self, e) => self.binary(e, "//")],
    [exp.IsInf, rename_func("ISINF")],
    [exp.IsNan, rename_func("ISNAN")],
    // py:1702 `IsNullValue`
    [exp.IsNullValue, (self, e) => self.sql(exp.func("JSON_TYPE", e.this).eq(exp.Literal.string("NULL")))],
    // py:1705 `IsArray`
    [exp.IsArray, (self, e) => self.sql(exp.func("JSON_TYPE", e.this).eq(exp.Literal.string("ARRAY")))],
    // py:1708-1709 `Ceil`/`Floor`
    [exp.Ceil, _ceil_floor],
    [exp.Floor, _ceil_floor],
    // and base `round_sql`/`ceil_floor`
    [exp.JSONBExists, rename_func("JSON_EXISTS")],
    // py:1711 `JSONExtract`
    [exp.JSONExtract, _arrow_json_extract_sql],
    // py:1712 `JSONExtractArray`
    [exp.JSONExtractArray, _json_extract_value_array_sql],
    // py:1713 `JSONFormat`
    [exp.JSONFormat, _json_format_sql],
    // py:1714 `JSONValueArray`
    [exp.JSONValueArray, _json_extract_value_array_sql],
    [exp.Lateral, _explode_to_unnest_sql],
    [exp.LogicalOr, (self, e) => self.func("BOOL_OR", _cast_to_boolean(e.this))],
    [exp.LogicalAnd, (self, e) => self.func("BOOL_AND", _cast_to_boolean(e.this))],
    // py:1718-1720 [exp.Select, transforms.preprocess([connect_by_to_recursive_cte, _seq_to_range_in_generator])] — blocked
    [exp.Seq1, (self, e) => _seq_sql(self, e, 1)],
    [exp.Seq2, (self, e) => _seq_sql(self, e, 2)],
    [exp.Seq4, (self, e) => _seq_sql(self, e, 4)],
    [exp.Seq8, (self, e) => _seq_sql(self, e, 8)],
    // py:1725 [exp.BoolxorAgg, _boolxor_agg_sql] — dup of the real entry already wired above (py:1261)
    // py:1726 [exp.MakeInterval, lambda] wraps `no_make_interval_sql` directly — real, wired below
    [exp.MakeInterval, (self, e) => no_make_interval_sql(self, e, " ")],
    // py:1727 [exp.Initcap, _initcap_sql] — blocked, local helper out of scope this pass
    // py:1728 `MD5Digest`
    [exp.MD5Digest, (self, e) => self.func("UNHEX", self.func("MD5", e.this))],
    // py:1729-1732 `SHA`/`SHA1Digest`/`SHA2`/`SHA2Digest`
    [exp.SHA, (self, e) => _sha_sql(self, e, "SHA1")],
    [exp.SHA1Digest, (self, e) => _sha_sql(self, e, "SHA1", true)],
    [exp.SHA2, (self, e) => _sha_sql(self, e, "SHA256")],
    [exp.SHA2Digest, (self, e) => _sha_sql(self, e, "SHA256", true)],
    // py:1733-1734 `MonthsBetween`/`NextDay`/`PreviousDay`
    [exp.MonthsBetween, months_between_sql],
    [exp.NextDay, _day_navigation_sql],
    [exp.PreviousDay, _day_navigation_sql],
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
    // py:1741 `RegexpILike`
    [exp.RegexpILike, (self, e) => self.func("REGEXP_MATCHES", e.this, e.expression, exp.Literal.string("i"))],
    // py:1745-1746 `RegrValx`/`RegrValy`
    [exp.RegrValx, _regr_val_sql],
    [exp.RegrValy, _regr_val_sql],
    // py:1747-1748 [exp.Return, exp.ReturnsProperty] — real, wired below
    [exp.Return, (self, e) => self.sql(e, "this")],
    [exp.ReturnsProperty, (self, e) => (e.this instanceof exp.Schema ? "TABLE" : "")],
    // py:1749-1751 `StrToUnix`
    [exp.StrToUnix, (self, e) => self.func("EPOCH", self.func("STRPTIME", e.this, self.format_time(e)))],
    [exp.Struct, _struct_sql],
    [exp.Transform, rename_func("LIST_TRANSFORM")],
    [exp.TimeAdd, _date_delta_to_binary_interval_op()],
    [exp.TimeSub, _date_delta_to_binary_interval_op()],
    [exp.Time, no_time_sql],
    // py:1757 `TimeDiff`
    [exp.TimeDiff, _timediff_sql],
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
    // py:1770 `ToBoolean`
    [exp.ToBoolean, _to_boolean_sql],
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
    // py:1793 `UnixToTime`
    [exp.UnixToTime, _unix_to_time_sql],
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
    // py:1813 `LastDay`
    [exp.LastDay, _last_day_sql],
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

  /** py:1846 `TYPE_PARAM_SETTINGS`. */
  static TYPE_PARAM_SETTINGS = new Map([
    ...Generator.TYPE_PARAM_SETTINGS,
    [exp.DType.BIGDECIMAL, [[38, 5], [38, 38]]],
    [exp.DType.DECFLOAT, [[38, 5], [38, 38]]],
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

  /** py:4150 `_regexp_extract_sql(self, expression)`. */
  _regexp_extract_sql(expression) {
    let this_ = expression.this;
    let group = expression.args.group;
    let params = expression.args.parameters;
    const position = expression.args.position;
    const occurrence = expression.args.occurrence;
    const null_if_pos_overflow = expression.args.null_if_pos_overflow;

    // Handle Snowflake's 'e' flag: it enables capture group extraction
    // In DuckDB, this is controlled by the group parameter directly
    if (params && params.isString && params.name.includes("e")) {
      params = exp.Literal.string(params.name.replace(/e/g, ""));
    }

    const validated_flags = this._validate_regexp_flags(params, "cims");

    // Strip default group when no following params (DuckDB default is same as group=0)
    if (!validated_flags && group && group.name === String(this.dialect.REGEXP_EXTRACT_DEFAULT_GROUP)) {
      group = null;
    }

    const flags_expr = validated_flags ? exp.Literal.string(validated_flags) : null;

    // use substring to handle position argument
    if (position && (!position.isInt || Number(position.toPy()) > 1)) {
      this_ = new exp.Substring({ this: this_, start: position });

      if (null_if_pos_overflow) {
        this_ = new exp.Nullif({ this: this_, expression: exp.Literal.string("") });
      }
    }

    const is_extract_all = expression instanceof exp.RegexpExtractAll;
    const non_single_occurrence = occurrence && (!occurrence.isInt || Number(occurrence.toPy()) > 1);

    const name = is_extract_all || non_single_occurrence ? "REGEXP_EXTRACT_ALL" : "REGEXP_EXTRACT";

    let result = new exp.Anonymous({ this: name, expressions: [this_, expression.expression, group, flags_expr] });

    // Array slicing for REGEXP_EXTRACT_ALL with occurrence
    if (is_extract_all && non_single_occurrence) {
      result = new exp.Bracket({ this: result, expressions: [new exp.Slice({ this: occurrence })] });
    } else if (non_single_occurrence) {
      // ARRAY_EXTRACT for REGEXP_EXTRACT with occurrence > 1
      result = new exp.Anonymous({ this: "ARRAY_EXTRACT", expressions: [result, occurrence] });
    }

    return this.sql(result);
  }

  /** py:4203 `regexpextract_sql(self, expression)`. */
  regexpextract_sql(expression) {
    return this._regexp_extract_sql(expression);
  }

  /** py:4206 `regexpextractall_sql(self, expression)`. */
  regexpextractall_sql(expression) {
    return this._regexp_extract_sql(expression);
  }

  /** py:3329 `regexpcount_sql(self, expression)`. */
  regexpcount_sql(expression) {
    let this_ = expression.this;
    let pattern = expression.expression;
    const position = expression.args.position;
    const parameters = expression.args.parameters;

    // Validate flags - only "ims" flags are supported for embedded patterns
    const validated_flags = this._validate_regexp_flags(parameters, "ims");

    if (position) this_ = new exp.Substring({ this: this_, start: position });

    // Embed flags in pattern (REGEXP_EXTRACT_ALL doesn't support flags argument)
    if (validated_flags) {
      pattern = new exp.Concat({ expressions: [exp.Literal.string(`(?${validated_flags})`), pattern] });
    }

    // Handle empty pattern: Snowflake returns 0, DuckDB would match between every character
    const result = exp.case()
      .when(new exp.EQ({ this: pattern, expression: exp.Literal.string("") }), exp.Literal.number(0))
      .else_(new exp.Length({ this: new exp.Anonymous({ this: "REGEXP_EXTRACT_ALL", expressions: [this_, pattern] }) }));

    return this.sql(result);
  }

  /** py:3361 `regexpreplace_sql(self, expression)`. */
  regexpreplace_sql(expression) {
    let subject = expression.this;
    const pattern = expression.expression;
    const replacement = expression.args.replacement || exp.Literal.string("");
    const position = expression.args.position;
    let occurrence = expression.args.occurrence;
    const modifiers = expression.args.modifiers;

    let validated_flags = this._validate_regexp_flags(modifiers, "cimsg") || "";

    // Handle occurrence (only literals supported)
    if (occurrence && !occurrence.isInt) {
      this.unsupported("REGEXP_REPLACE with non-literal occurrence");
    } else {
      occurrence = occurrence && occurrence.isInt ? Number(occurrence.toPy()) : 0;
      if (occurrence > 1) {
        this.unsupported(`REGEXP_REPLACE occurrence=${occurrence} not supported`);
      } else if (occurrence === 0 && !validated_flags.includes("g") && !expression.args.single_replace) {
        // flag duckdb to do either all or none, single_replace check is for duckdb round trip
        validated_flags += "g";
      }
    }

    // Handle position (only literals supported)
    let prefix = null;
    if (position && !position.isInt) {
      this.unsupported("REGEXP_REPLACE with non-literal position");
    } else if (position && position.isInt && Number(position.toPy()) > 1) {
      const pos = Number(position.toPy());
      prefix = new exp.Substring({ this: subject, start: exp.Literal.number(1), length: exp.Literal.number(pos - 1) });
      subject = new exp.Substring({ this: subject, start: exp.Literal.number(pos) });
    }

    let result = new exp.Anonymous({
      this: "REGEXP_REPLACE",
      expressions: [subject, pattern, replacement, validated_flags ? exp.Literal.string(validated_flags) : null],
    });

    if (prefix) result = new exp.Concat({ expressions: [prefix, result] });

    return this.sql(result);
  }

  /**
   * py:3299 `_validate_regexp_flags(self, flags, supported_flags)`.
   *
   * Validate and filter regexp flags for DuckDB compatibility. `flags` is
   * the flags expression to validate; `supported_flags` is a string of
   * supported flags (e.g. "ims", "cims") -- only those are returned.
   * Returns the validated/filtered flag string, or null if none remain.
   */
  _validate_regexp_flags(flags, supported_flags) {
    if (!(flags instanceof exp.Expr)) return null;

    if (!flags.isString) {
      this.unsupported("Non-literal regexp flags are not fully supported in DuckDB");
      return null;
    }

    const flag_str = flags.this;
    const unsupported = [...new Set(flag_str)].filter((f) => !supported_flags.includes(f));

    if (unsupported.length) {
      this.unsupported(`Regexp flags ${pyRepr(unsupported.sort())} are not supported in this context`);
    }

    const filtered = [...flag_str].filter((f) => supported_flags.includes(f)).join("");
    return filtered || null;
  }

  /** py:3412 `regexplike_sql(self, expression)`. */
  regexplike_sql(expression) {
    const this_ = expression.this;
    const pattern = expression.expression;
    let flag = expression.args.flag;

    if (expression.args.full_match) {
      const validated_flags = this._validate_regexp_flags(flag, "cims");
      flag = validated_flags ? exp.Literal.string(validated_flags) : null;
      return this.func("REGEXP_FULL_MATCH", this_, pattern, flag);
    }

    return this.func("REGEXP_MATCHES", this_, pattern, flag);
  }

  /** py:2770 `_strptime_default_year(self, expression)`. */
  _strptime_default_year(expression) {
    let value = expression.this;
    let formatted_time = this.format_time(expression);

    const default_year = expression.args.default_year;
    if (default_year) {
      value = new exp.DPipe({ this: exp.Literal.string(`${default_year.name} `), expression: value });
      formatted_time = new exp.DPipe({ this: exp.Literal.string("%Y "), expression: formatted_time });
    }

    return [value, formatted_time];
  }

  /** py:2736 `strtotime_sql(self, expression)`. */
  strtotime_sql(expression) {
    const target_type = expression.args.target_type;
    const needs_tz = target_type && (target_type.this === exp.DType.TIMESTAMPLTZ || target_type.this === exp.DType.TIMESTAMPTZ);

    const [value, formatted_time] = this._strptime_default_year(expression);

    if (expression.args.safe) {
      const cast_type = needs_tz ? exp.DType.TIMESTAMPTZ : exp.DType.TIMESTAMP;
      return this.sql(exp.cast(this.func("TRY_STRPTIME", value, formatted_time), cast_type));
    }

    const base_sql = this.func("STRPTIME", value, formatted_time);
    if (needs_tz) return this.sql(exp.cast(base_sql, new exp.DataType({ this: exp.DType.TIMESTAMPTZ })));
    return base_sql;
  }

  /** py:2760 `strtodate_sql(self, expression)`. */
  strtodate_sql(expression) {
    const [value, formatted_time] = this._strptime_default_year(expression);
    const function_name = expression.args.safe ? "TRY_STRPTIME" : "STRPTIME";
    return this.sql(
      exp.cast(this.func(function_name, value, formatted_time), new exp.DataType({ this: exp.DType.DATE }))
    );
  }

  /** py:2782 `parsedatetime_sql(self, expression)`. */
  parsedatetime_sql(expression) {
    const [value, formatted_time] = this._strptime_default_year(expression);
    return this.func("STRPTIME", value, formatted_time);
  }

  /** py:2786 `parsetime_sql(self, expression)`. */
  parsetime_sql(expression) {
    const formatted_time = this.format_time(expression);
    return this.sql(
      exp.cast(this.func("STRPTIME", expression.this, formatted_time), new exp.DataType({ this: exp.DType.TIME }))
    );
  }

  /** py:2795 `tsordstotime_sql(self, expression)`. */
  tsordstotime_sql(expression) {
    const this_ = expression.this;
    const time_format = this.format_time(expression);
    const safe = expression.args.safe;
    const time_type = exp.DataType.fromStr("TIME", { dialect: "duckdb" });
    const cast_expr = safe ? exp.TryCast : exp.Cast;

    if (time_format) {
      const func_name = safe ? "TRY_STRPTIME" : "STRPTIME";
      const strptime = new exp.Anonymous({ this: func_name, expressions: [this_, time_format] });
      return this.sql(new cast_expr({ this: strptime, to: time_type }));
    }

    if (this_ instanceof exp.TsOrDsToTime || this_.isType(exp.DType.TIME)) return this.sql(this_);

    return this.sql(new cast_expr({ this: this_, to: time_type }));
  }

  /**
   * py:2943 `timefromparts_sql(self, expression)`.
   *
   * The upstream `try`/`except ValueError` around `to_py()` is unreachable here: the
   * `is_int` check just above it already guarantees `toPy()` succeeds.
   */
  timefromparts_sql(expression) {
    const nano = expression.args.nano;
    const overflow = expression.args.overflow;

    // Snowflake's TIME_FROM_PARTS supports overflow
    if (overflow) {
      const hour = expression.args.hour;
      const minute = expression.args.min;
      let sec = expression.args.sec;

      // Check if values are within normal ranges - use MAKE_TIME for efficiency
      if (!nano && [hour, minute, sec].every((arg) => arg.isInt)) {
        const h_val = Number(hour.toPy());
        const m_val = Number(minute.toPy());
        const s_val = Number(sec.toPy());
        if (h_val >= 0 && h_val <= 23 && m_val >= 0 && m_val <= 59 && s_val >= 0 && s_val <= 59) {
          return rename_func("MAKE_TIME")(this, expression);
        }
      }

      // Overflow or nanoseconds detected - use INTERVAL arithmetic
      if (nano) sec = sec.add(nano.pop().div(exp.Literal.number("1000000000.0")));

      const total_seconds = hour.mul(exp.Literal.number(3600)).add(minute.mul(exp.Literal.number(60))).add(sec);

      return this.sql(
        new exp.Add({
          this: new exp.Cast({ this: exp.Literal.string("00:00:00"), to: exp.DType.TIME.intoExpr() }),
          expression: new exp.Interval({ this: total_seconds, unit: exp.var("SECOND") }),
        }),
      );
    }

    // Default: MAKE_TIME
    if (nano) {
      expression.set("sec", expression.args.sec.add(nano.pop().div(exp.Literal.number("1000000000.0"))));
    }

    return rename_func("MAKE_TIME")(this, expression);
  }

  /** py:3052 `timestampfromparts_sql(self, expression)`. */
  timestampfromparts_sql(expression) {
    // Check if this is the date/time expression form: TIMESTAMP_FROM_PARTS(date_expr, time_expr)
    const date_expr = expression.this;
    const time_expr = expression.expression;

    if (date_expr !== null && date_expr !== undefined && time_expr !== null && time_expr !== undefined) {
      // In DuckDB, DATE + TIME produces TIMESTAMP
      return this.sql(new exp.Add({ this: date_expr, expression: time_expr }));
    }

    // Component-based form: TIMESTAMP_FROM_PARTS(year, month, day, hour, minute, second, ...)
    let sec = expression.args.sec;
    if (sec === null || sec === undefined) {
      // This shouldn't happen with valid input, but handle gracefully
      return rename_func("MAKE_TIMESTAMP")(this, expression);
    }

    const milli = expression.args.milli;
    if (milli !== null && milli !== undefined) sec = sec.add(milli.pop().div(exp.Literal.number("1000.0")));

    const nano = expression.args.nano;
    if (nano !== null && nano !== undefined) sec = sec.add(nano.pop().div(exp.Literal.number("1000000000.0")));

    if (milli || nano) expression.set("sec", sec);

    return rename_func("MAKE_TIMESTAMP")(this, expression);
  }

  /** py:3081 `timestampltzfromparts_sql(self, expression)`. */
  timestampltzfromparts_sql(expression) {
    const nano = expression.args.nano;
    if (nano) {
      this.unsupported(
        `Argument 'nano' is not supported for expression '${expression.constructor.name}' when targeting ${this.dialect.constructor.name}.`,
      );
      nano.pop();
    }

    const timestamp = rename_func("MAKE_TIMESTAMP")(this, expression);
    return `CAST(${timestamp} AS TIMESTAMPTZ)`;
  }

  /** py:3090 `timestamptzfromparts_sql(self, expression)`. */
  timestamptzfromparts_sql(expression) {
    // Extract zone before popping
    let zone = expression.args.zone;
    // Pop zone and nano so rename_func only passes args that MAKE_TIMESTAMP accepts
    if (zone) zone = zone.pop();

    const nano = expression.args.nano;
    if (nano) {
      this.unsupported(
        `Argument 'nano' is not supported for expression '${expression.constructor.name}' when targeting ${this.dialect.constructor.name}.`,
      );
      nano.pop();
    }

    const timestamp = rename_func("MAKE_TIMESTAMP")(this, expression);

    if (zone) {
      // Use AT TIME ZONE to apply the explicit timezone
      return `${timestamp} AT TIME ZONE ${this.sql(zone)}`;
    }

    return timestamp;
  }

  /** py:3492 `arrayuniqueagg_sql(self, expression)`. */
  arrayuniqueagg_sql(expression) {
    return this.sql(
      new exp.Filter({
        this: exp.func("LIST", new exp.Distinct({ expressions: [expression.this] })),
        expression: new exp.Where({ this: expression.this.copy().is_(exp.null_()).not_() }),
      }),
    );
  }

  /** py:3500 `arrayconcatagg_sql(self, expression)`. */
  arrayconcatagg_sql(expression) {
    let this_ = expression.this;

    if (this_ instanceof exp.Limit) {
      this.unsupported("LIMIT in ARRAY_CONCAT_AGG cannot be transpiled to DuckDB");
      this_ = this_.this;
    }

    const inner = this_ instanceof exp.Order ? this_.this : this_;

    return this.func(
      "FLATTEN",
      new exp.Filter({
        this: new exp.ArrayAgg({ this: this_ }),
        expression: new exp.Where({ this: inner.copy().is_(exp.null_()).not_() }),
      }),
    );
  }

  /** py:3521 `arraydistinct_sql(self, expression)`. */
  arraydistinct_sql(expression) {
    const arr = expression.this;
    const func = this.func("LIST_DISTINCT", arr);

    if (expression.args.check_null) {
      const add_null_to_array = exp.func(
        "LIST_APPEND",
        exp.func("LIST_DISTINCT", new exp.ArrayCompact({ this: arr })),
        new exp.Null(),
      );
      return this.sql(
        new exp.If({
          this: new exp.NEQ({ this: new exp.ArraySize({ this: arr }), expression: exp.func("LIST_COUNT", arr) }),
          true: add_null_to_array,
          false: func,
        }),
      );
    }

    return func;
  }

  /** py:4093 `arraytostring_sql(self, expression)`. */
  arraytostring_sql(expression) {
    const null_ = expression.args.null;

    if (expression.args.null_is_empty) {
      const x = exp.toIdentifier("x");
      const list_transform = new exp.Transform({
        this: expression.this.copy(),
        expression: new exp.Lambda({
          this: new exp.Coalesce({ this: exp.cast(x, "TEXT"), expressions: [exp.Literal.string("")] }),
          expressions: [x],
        }),
      });
      const array_to_string = new exp.ArrayToString({ this: list_transform, expression: expression.expression });
      if (expression.args.null_delim_is_null) {
        return this.sql(
          exp.case()
            .when(expression.expression.copy().is_(exp.null_()), exp.null_())
            .else_(array_to_string),
        );
      }
      return this.sql(array_to_string);
    }

    if (null_) {
      const x = exp.toIdentifier("x");
      return this.sql(
        new exp.ArrayToString({
          this: new exp.Transform({
            this: expression.this,
            expression: new exp.Lambda({ this: new exp.Coalesce({ this: x, expressions: [null_] }), expressions: [x] }),
          }),
          expression: expression.expression,
        }),
      );
    }

    return this.func("ARRAY_TO_STRING", expression.this, expression.expression);
  }

  /** py:2692 `strposition_sql(self, expression)`. */
  strposition_sql(expression) {
    const this_ = expression.this;
    const substr = expression.args.substr;
    let position = expression.args.position;

    // For BINARY/BLOB: DuckDB's STRPOS doesn't support BLOB types
    // Convert to HEX strings, use STRPOS, then convert hex position to byte position
    if (_is_binary(this_)) {
      // Build expression: STRPOS(HEX(haystack), HEX(needle))
      const hex_strpos = new exp.StrPosition({
        this: new exp.Hex({ this: this_ }),
        substr: new exp.Hex({ this: substr }),
      });

      return this.sql(exp.cast(hex_strpos.add(1).div(2), exp.DType.INT));
    }

    // For VARCHAR: handle clamp_position
    if (expression.args.clamp_position && position) {
      expression = expression.copy();
      expression.set(
        "position",
        new exp.If({
          this: new exp.LTE({ this: position, expression: exp.Literal.number(0) }),
          true: exp.Literal.number(1),
          false: position.copy(),
        }),
      );
    }

    return strposition_sql(this, expression);
  }

  /** py:3108 `tablesample_sql(self, expression, tablesample_keyword=None)`. */
  tablesample_sql(expression, tablesample_keyword = null) {
    if (!(expression.parent instanceof exp.Select)) {
      // This sample clause only applies to a single source, not the entire resulting relation
      tablesample_keyword = "TABLESAMPLE";
    }

    if (expression.args.size) {
      const method = expression.args.method;
      if (method && method.name.toUpperCase() !== "RESERVOIR") {
        this.unsupported(
          `Sampling method ${method} is not supported with a discrete sample count, defaulting to reservoir sampling`,
        );
        expression.set("method", exp.var("RESERVOIR"));
      }
    }

    return super.tablesample_sql(expression, tablesample_keyword);
  }

  /**
   * py:2317 `timeslice_sql(self, expression)`.
   *
   * Transform Snowflake's TIME_SLICE to DuckDB's time_bucket.
   *
   * Snowflake: TIME_SLICE(date_expr, slice_length, 'UNIT' [, 'START'|'END'])
   * DuckDB:    time_bucket(INTERVAL 'slice_length' UNIT, date_expr)
   *
   * For 'END' kind, add the interval to get the end of the slice.
   * For DATE type with 'END', cast result back to DATE to preserve type.
   */
  timeslice_sql(expression) {
    const date_expr = expression.this;
    const slice_length = expression.expression;
    const unit = expression.args.unit;
    const kind = expression.text("kind").toUpperCase();

    // Create INTERVAL expression: INTERVAL 'N' UNIT
    const interval_expr = new exp.Interval({ this: slice_length, unit });

    // Create base time_bucket expression
    const time_bucket_expr = exp.func("time_bucket", interval_expr, date_expr);

    // Check if we need the end of the slice (default is start)
    if (kind !== "END") {
      // For 'START', return time_bucket directly
      return this.sql(time_bucket_expr);
    }

    // For 'END', add the interval to get end of slice
    const add_expr = new exp.Add({ this: time_bucket_expr, expression: interval_expr.copy() });

    // If input is DATE type, cast result back to DATE to preserve type
    // DuckDB converts DATE to TIMESTAMP when adding intervals
    if (date_expr.isType(exp.DType.DATE)) {
      return this.sql(exp.cast(add_expr, exp.DType.DATE));
    }

    return this.sql(add_expr);
  }

  /**
   * py:2353 `bitmapbucketnumber_sql(self, expression)`.
   *
   * Transpile BITMAP_BUCKET_NUMBER function from Snowflake to DuckDB equivalent.
   *
   * Snowflake's BITMAP_BUCKET_NUMBER returns a 1-based bucket identifier where:
   * - Each bucket covers 32,768 values
   * - Bucket numbering starts at 1
   * - Formula: ((value - 1) // 32768) + 1 for positive values
   *
   * For non-positive values (0 and negative), we use value // 32768 to avoid
   * producing bucket 0 or positive bucket IDs for negative inputs.
   */
  bitmapbucketnumber_sql(expression) {
    const value = expression.this;

    const positive_formula = value.sub(exp.Literal.number(1)).floordiv(exp.Literal.number(32768)).add(exp.Literal.number(1));
    const non_positive_formula = value.floordiv(exp.Literal.number(32768));

    // CASE WHEN value > 0 THEN ((value - 1) // 32768) + 1 ELSE value // 32768 END
    const case_expr = exp.case()
      .when(new exp.GT({ this: value, expression: exp.Literal.number(0) }), positive_formula)
      .else_(non_positive_formula);
    return this.sql(case_expr);
  }

  /**
   * py:2378 `bitmapbitposition_sql(self, expression)`.
   *
   * Transpile Snowflake's BITMAP_BIT_POSITION to DuckDB CASE expression.
   *
   * Snowflake's BITMAP_BIT_POSITION behavior:
   * - For n <= 0: returns ABS(n) % 32768
   * - For n > 0: returns (n - 1) % 32768 (maximum return value is 32767)
   */
  bitmapbitposition_sql(expression) {
    const this_ = expression.this;

    return this.sql(
      new exp.Mod({
        this: exp.paren(
          new exp.If({
            this: new exp.GT({ this: this_, expression: exp.Literal.number(0) }),
            true: this_.sub(exp.Literal.number(1)),
            false: new exp.Abs({ this: this_ }),
          }),
        ),
        expression: MAX_BIT_POSITION,
      }),
    );
  }

  /** py:2860 `trunc_sql(self, expression)`. */
  trunc_sql(expression) {
    let decimals = expression.args.decimals;
    if (expression.args.fractions_supported && decimals && !decimals.isType(exp.DType.INT)) {
      decimals = exp.cast(decimals, exp.DType.INT, { dialect: "duckdb" });
    }

    return this.func("TRUNC", expression.this, decimals);
  }

  /** py:4743 `window_sql(self, expression)`. */
  window_sql(expression) {
    const this_ = expression.this;
    if (this_ instanceof exp.Corr || (this_ instanceof exp.Filter && this_.this instanceof exp.Corr)) {
      return this._corr_sql(expression);
    }

    return super.window_sql(expression);
  }

  /** py:4752 `filter_sql(self, expression)`. */
  filter_sql(expression) {
    if (expression.this instanceof exp.Corr) return this._corr_sql(expression);

    return super.filter_sql(expression);
  }

  /** py:4758 `_corr_sql(self, expression)`. */
  _corr_sql(expression) {
    if (expression instanceof exp.Corr && !expression.args.null_on_zero_variance) {
      return this.func("CORR", expression.this, expression.expression);
    }

    let corr_expr = _maybe_corr_null_to_false(expression);
    if (corr_expr === null) {
      if (expression instanceof exp.Window) return super.window_sql(expression);
      if (expression instanceof exp.Filter) return super.filter_sql(expression);
      corr_expr = expression;
    }

    return this.sql(exp.case().when(new exp.IsNan({ this: corr_expr }), exp.null_()).else_(corr_expr));
  }

  /** py:3189 `withingroup_sql(self, expression)`. */
  withingroup_sql(expression) {
    const func = expression.this;

    // For ARRAY_AGG, DuckDB requires ORDER BY inside the function, not in WITHIN GROUP
    // Transform: ARRAY_AGG(x) WITHIN GROUP (ORDER BY y) -> ARRAY_AGG(x ORDER BY y)
    if (func instanceof exp.ArrayAgg) {
      const order = expression.expression;
      if (!(order instanceof exp.Order)) return this.sql(func);

      // Save the original column for FILTER clause (before wrapping with Order)
      const original_this = func.this;

      // Move ORDER BY inside ARRAY_AGG by wrapping its argument with Order
      // ArrayAgg.this should become Order(this=ArrayAgg.this, expressions=order.expressions)
      func.set("this", new exp.Order({ this: func.this.copy(), expressions: order.expressions }));

      // Generate the ARRAY_AGG function with ORDER BY and add FILTER clause if needed
      // Use original_this (not the Order-wrapped version) for the FILTER condition
      const array_agg_sql = this.function_fallback_sql(func);
      return this._add_arrayagg_null_filter(array_agg_sql, func, original_this);
    }

    // For other functions (like PERCENTILES), use existing logic
    const expression_sql = this.sql(expression, "expression");

    if (func instanceof exp.PercentileCont || func instanceof exp.PercentileDisc) {
      // Make the order key the first arg and slide the fraction to the right
      // https://duckdb.org/docs/sql/aggregates#ordered-set-aggregate-functions
      const order_col = expression.find(exp.Ordered);
      if (order_col) {
        func.set("expression", func.this);
        func.set("this", order_col.this);
      }
    }

    const this_ = pyRstrip(this.sql(expression, "this"), ")");

    return `${this_}${expression_sql})`;
  }

  /**
   * py:2472 `randstr_sql(self, expression)`.
   *
   * Transpile Snowflake's RANDSTR to DuckDB equivalent using deterministic hash-based random.
   * Uses a pre-parsed template with placeholders replaced by expression nodes.
   *
   * RANDSTR(length, generator) generates a random string of specified length.
   * - With numeric seed: Use HASH(i + seed) for deterministic output (same seed = same result)
   * - With RANDOM(): Use RANDOM() in the hash for non-deterministic output
   * - No generator: Use default seed value
   */
  randstr_sql(expression) {
    const length = expression.this;
    const generator = expression.args.generator;

    let seed_value;
    if (generator) {
      if (generator instanceof exp.Rand) {
        // If it's RANDOM(), use its seed if available, otherwise use RANDOM() itself
        seed_value = generator.this || generator;
      } else {
        // Const/int or other expression - use as seed directly
        seed_value = generator;
      }
    } else {
      // No generator specified, use default seed (arbitrary but deterministic)
      seed_value = exp.Literal.number(RANDSTR_SEED);
    }

    const replacements = { seed: seed_value, length };
    return `(${this.sql(exp.replacePlaceholders(RANDSTR_TEMPLATE, replacements))})`;
  }

  /**
   * py:2510 `zipf_sql(self, expression)`.
   *
   * Transpile Snowflake's ZIPF to DuckDB using CDF-based inverse sampling.
   * Uses a pre-parsed template with placeholders replaced by expression nodes.
   */
  zipf_sql(expression) {
    const s = expression.this;
    const n = expression.args.elementcount;
    const gen = expression.args.gen;

    let random_expr;
    if (!(gen instanceof exp.Rand)) {
      // (ABS(HASH(seed)) % 1000000) / 1000000.0
      random_expr = new exp.Div({
        this: exp.paren(
          new exp.Mod({
            this: new exp.Abs({ this: new exp.Anonymous({ this: "HASH", expressions: [gen.copy()] }) }),
            expression: exp.Literal.number(1000000),
          }),
        ),
        expression: exp.Literal.number("1000000.0"),
      });
    } else {
      // Use RANDOM() for non-deterministic output
      random_expr = new exp.Rand();
    }

    const replacements = { s, n, random_expr };
    return `(${this.sql(exp.replacePlaceholders(ZIPF_TEMPLATE, replacements))})`;
  }

  /**
   * py:2871 `normal_sql(self, expression)`.
   *
   * Transpile Snowflake's NORMAL(mean, stddev, gen) to DuckDB.
   * Uses the Box-Muller transform via NORMAL_TEMPLATE.
   */
  normal_sql(expression) {
    const mean = expression.this;
    const stddev = expression.args.stddev;
    const gen = expression.args.gen;

    // Build two uniform random values [0, 1) for Box-Muller transform
    let u1, u2;
    if (gen instanceof exp.Rand && (gen.this === null || gen.this === undefined)) {
      u1 = new exp.Rand();
      u2 = new exp.Rand();
    } else {
      // Seeded: derive two values using HASH with different inputs
      const seed = gen instanceof exp.Rand ? gen.this : gen;
      u1 = exp.replacePlaceholders(SEEDED_RANDOM_TEMPLATE, { seed });
      u2 = exp.replacePlaceholders(SEEDED_RANDOM_TEMPLATE, {
        seed: new exp.Add({ this: seed.copy(), expression: exp.Literal.number(1) }),
      });
    }

    const replacements = { mean, stddev, u1, u2 };
    return this.sql(exp.replacePlaceholders(NORMAL_TEMPLATE, replacements));
  }

  /**
   * py:2897 `uniform_sql(self, expression)`.
   *
   * Transpile Snowflake's UNIFORM(min, max, gen) to DuckDB.
   *
   * UNIFORM returns a random value in [min, max]:
   * - Integer result if both min and max are integers
   * - Float result if either min or max is a float
   */
  uniform_sql(expression) {
    const min_val = expression.this;
    const max_val = expression.expression;
    const gen = expression.args.gen;

    // Determine if result should be integer (both bounds are integers).
    // We do this to emulate Snowflake's behavior, INT -> INT, FLOAT -> FLOAT
    const is_int_result = min_val.isInt && max_val.isInt;

    // Build the random value expression [0, 1)
    let random_expr;
    if (!(gen instanceof exp.Rand)) {
      // Seed value: (ABS(HASH(seed)) % 1000000) / 1000000.0
      random_expr = new exp.Div({
        this: exp.paren(
          new exp.Mod({
            this: new exp.Abs({ this: new exp.Anonymous({ this: "HASH", expressions: [gen] }) }),
            expression: exp.Literal.number(1000000),
          }),
        ),
        expression: exp.Literal.number("1000000.0"),
      });
    } else {
      random_expr = new exp.Rand();
    }

    // Build: min + random * (max - min [+ 1 for int])
    let range_expr = new exp.Sub({ this: max_val, expression: min_val });
    if (is_int_result) range_expr = new exp.Add({ this: range_expr, expression: exp.Literal.number(1) });

    let result = new exp.Add({
      this: min_val,
      expression: new exp.Mul({ this: random_expr, expression: exp.paren(range_expr) }),
    });

    if (is_int_result) {
      result = new exp.Cast({ this: new exp.Floor({ this: result }), to: exp.DType.BIGINT.intoExpr() });
    }

    return this.sql(result);
  }

  /** py:3842 `mapcat_sql(self, expression)`. */
  mapcat_sql(expression) {
    const result = exp.replacePlaceholders(MAPCAT_TEMPLATE.copy(), {
      map1: expression.this,
      map2: expression.expression,
    });
    return this.sql(result);
  }

  /** py:3850 `mapcontainskey_sql(self, expression)`. */
  mapcontainskey_sql(expression) {
    return this.func("ARRAY_CONTAINS", exp.func("MAP_KEYS", expression.args.key), expression.this);
  }

  /** py:3855 `mapdelete_sql(self, expression)`. */
  mapdelete_sql(expression) {
    const map_arg = expression.this;
    const keys_to_delete = expression.expressions;

    const x_dot_key = new exp.Dot({ this: exp.toIdentifier("x"), expression: exp.toIdentifier("key") });

    const lambda_expr = new exp.Lambda({
      this: new exp.In({ this: x_dot_key, expressions: keys_to_delete }).not_(),
      expressions: [exp.toIdentifier("x")],
    });
    const result = exp.func(
      "MAP_FROM_ENTRIES",
      new exp.ArrayFilter({ this: exp.func("MAP_ENTRIES", map_arg), expression: lambda_expr }),
    );
    return this.sql(result);
  }

  /** py:3871 `mappick_sql(self, expression)`. */
  mappick_sql(expression) {
    const map_arg = expression.this;
    const keys_to_pick = expression.expressions;

    const x_dot_key = new exp.Dot({ this: exp.toIdentifier("x"), expression: exp.toIdentifier("key") });

    let lambda_expr;
    if (keys_to_pick.length === 1 && keys_to_pick[0].isType(exp.DType.ARRAY)) {
      lambda_expr = new exp.Lambda({
        this: exp.func("ARRAY_CONTAINS", keys_to_pick[0], x_dot_key),
        expressions: [exp.toIdentifier("x")],
      });
    } else {
      lambda_expr = new exp.Lambda({
        this: new exp.In({ this: x_dot_key, expressions: keys_to_pick }),
        expressions: [exp.toIdentifier("x")],
      });
    }

    const result = exp.func(
      "MAP_FROM_ENTRIES",
      exp.func("LIST_FILTER", exp.func("MAP_ENTRIES", map_arg), lambda_expr),
    );
    return this.sql(result);
  }

  /** py:3894 `mapsize_sql(self, expression)`. */
  mapsize_sql(expression) {
    return this.func("CARDINALITY", expression.this);
  }

  /** py:3897-3898 `@unsupported_args("update_flag") mapinsert_sql(self, expression)`. */
  mapinsert_sql(expression) {
    if (expression.args.update_flag) {
      this.unsupported(
        `Argument 'update_flag' is not supported for expression '${expression.constructor.name}' when targeting ${this.dialect.constructor.name}.`,
      );
    }

    const map_arg = expression.this;
    const key = expression.args.key;
    let value = expression.args.value;

    const map_type = map_arg.type;

    if (value !== null && value !== undefined) {
      if (map_type && map_type.expressions && map_type.expressions.length > 1) {
        // Extract the value type from MAP(key_type, value_type)
        const value_type = map_type.expressions[1];
        // Cast value to match the map's value type to avoid type conflicts
        value = exp.cast(value, value_type);
      }
      // else: polymorphic MAP case - no type parameters available, use value as-is
    }

    // Create a single-entry map for the new key-value pair
    const new_entry_struct = new exp.Struct({ expressions: [new exp.PropertyEQ({ this: key, expression: value })] });
    const new_entry = new exp.ToMap({ this: new_entry_struct });

    // Use MAP_CONCAT to merge the original map with the new entry
    // This automatically handles both insert and update cases
    const result = exp.func("MAP_CONCAT", map_arg, new_entry);

    return this.sql(result);
  }

  /** py:3726 `rand_sql(self, expression)`. */
  rand_sql(expression) {
    const seed = expression.this;
    if (seed !== null && seed !== undefined) {
      this.unsupported("RANDOM with seed is not supported in DuckDB");
    }

    const lower = expression.args.lower;
    const upper = expression.args.upper;

    if (lower && upper) {
      // scale DuckDB's [0,1) to the specified range
      const range_size = exp.paren(upper.sub(lower));
      const scaled = new exp.Add({ this: lower, expression: exp.func("random").mul(range_size) });

      // For now we assume that if bounds are set, return type is BIGINT. Snowflake/Teradata
      const result = exp.cast(scaled, exp.DType.BIGINT);
      return this.sql(result);
    }

    // Default DuckDB behavior - just return RANDOM() as float
    return "RANDOM()";
  }

  /**
   * py:2588 `_greatest_least_sql(self, expression)`.
   *
   * Handle GREATEST/LEAST functions with dialect-aware NULL behavior.
   *
   * - If ignore_nulls=False (BigQuery-style): return NULL if any argument is NULL
   * - If ignore_nulls=True (DuckDB/PostgreSQL-style): ignore NULLs, return greatest/least non-NULL value
   */
  _greatest_least_sql(expression) {
    // Get all arguments
    const all_args = [expression.this, ...expression.expressions];
    const fallback_sql = this.function_fallback_sql(expression);

    if (expression.args.ignore_nulls) {
      // DuckDB/PostgreSQL behavior: use native GREATEST/LEAST (ignores NULLs)
      return this.sql(fallback_sql);
    }

    // return NULL if any argument is NULL
    const case_expr = exp.case().when(
      exp.or_(...all_args.map((arg) => arg.is_(exp.null_())), { copy: false }),
      exp.null_(),
      { copy: false },
    );
    case_expr.set("default", fallback_sql);
    return this.sql(case_expr);
  }

  /** py:2626 `greatest_sql(self, expression)`. */
  greatest_sql(expression) {
    return this._greatest_least_sql(expression);
  }

  /** py:2629 `least_sql(self, expression)`. */
  least_sql(expression) {
    return this._greatest_least_sql(expression);
  }

  /** py:2632 `lambda_sql(self, expression, arrow_sep="->", wrap=True)`. */
  lambda_sql(expression, arrow_sep = "->", wrap = true) {
    let prefix;
    if (expression.args.colon) {
      prefix = "LAMBDA ";
      arrow_sep = ":";
      wrap = false;
    } else {
      prefix = "";
    }

    const lambda_sql = super.lambda_sql(expression, arrow_sep, wrap);
    return `${prefix}${lambda_sql}`;
  }

  /** py:2643 `show_sql(self, expression)`. */
  show_sql(expression) {
    let from_ = this.sql(expression, "from_");
    from_ = from_ ? ` FROM ${from_}` : "";
    return `SHOW ${expression.name}${from_}`;
  }

  /** py:2648 `soundex_sql(self, expression)`. */
  soundex_sql(expression) {
    this.unsupported("SOUNDEX is not supported in DuckDB");
    return this.func("SOUNDEX", expression.this);
  }

  /** py:3155 `countif_sql(self, expression)`. */
  countif_sql(expression) {
    if (_dialectAtLeast(this.dialect, 1n, 2n)) {
      const this_ = expression.this;
      if (expression.args.zero_on_all_null && !(this_ instanceof exp.Distinct)) {
        expression = new exp.CountIf({ this: exp.paren(this_).is_(exp.true_()) });
      }
      return this.function_fallback_sql(expression);
    }

    // https://github.com/tobymao/sqlglot/pull/4749
    return count_if_to_sum(this, expression);
  }

  /** py:3167 `bracket_sql(self, expression)`. */
  bracket_sql(expression) {
    if (_dialectAtLeast(this.dialect, 1n, 2n)) return super.bracket_sql(expression);

    // https://duckdb.org/2025/02/05/announcing-duckdb-120.html#breaking-changes
    let this_ = expression.this;
    if (this_ instanceof exp.Array) this_.replace(exp.paren(this_));

    let bracket = super.bracket_sql(expression);

    if (!expression.args.returns_list_for_maps) {
      if (!this_.type) this_ = annotate_types(this_, { dialect: this.dialect });

      if (this_.isType(exp.DType.MAP)) bracket = `(${bracket})[1]`;
    }

    return bracket;
  }

  /** py:3930 `space_sql(self, expression)`. */
  space_sql(expression) {
    // DuckDB's REPEAT requires BIGINT for the count parameter
    return this.sql(
      new exp.Repeat({ this: exp.Literal.string(" "), times: exp.cast(expression.this, exp.DType.BIGINT) }),
    );
  }

  /** py:2812 `currentdate_sql(self, expression)`. */
  currentdate_sql(expression) {
    if (!expression.this) return "CURRENT_DATE";

    const expr = new exp.Cast({
      this: new exp.AtTimeZone({ this: new exp.CurrentTimestamp(), zone: expression.this }),
      to: new exp.DataType({ this: exp.DType.DATE }),
    });
    return this.sql(expr);
  }

  /** py:3817 `_bitwise_op(self, expression, op)`. */
  _bitwise_op(expression, op) {
    _prepare_binary_bitwise_args(expression);
    const result_sql = this.binary(expression, op);
    return _gen_with_cast_to_blob(this, expression, result_sql);
  }

  /** py:3822 `bitwisexor_sql(self, expression)`. */
  bitwisexor_sql(expression) {
    _prepare_binary_bitwise_args(expression);
    const result_sql = this.func("XOR", expression.this, expression.expression);
    return _gen_with_cast_to_blob(this, expression, result_sql);
  }

  /** py:3827 `objectinsert_sql(self, expression)`. */
  objectinsert_sql(expression) {
    const this_ = expression.this;
    const key = expression.args.key;
    const key_sql = key instanceof exp.Expr ? key.name : "";
    const value_sql = this.sql(expression, "value");

    const kv_sql = `${key_sql} := ${value_sql}`;

    // If the input struct is empty e.g. transpiling OBJECT_INSERT(OBJECT_CONSTRUCT(), key, value) from Snowflake
    // then we can generate STRUCT_PACK which will build it since STRUCT_INSERT({}, key := value) is not valid DuckDB
    if (this_ instanceof exp.Struct && !this_.expressions.length) {
      return this.func("STRUCT_PACK", kv_sql);
    }

    return this.func("STRUCT_INSERT", this_, kv_sql);
  }

  /** py:2574 `tonumber_sql(self, expression)`. */
  tonumber_sql(expression) {
    const fmt = expression.args.format;
    const precision = expression.args.precision;
    const scale = expression.args.scale;

    if (!fmt && precision && scale) {
      return this.sql(exp.cast(expression.this, `DECIMAL(${precision.name}, ${scale.name})`, { dialect: "duckdb" }));
    }

    return super.tonumber_sql(expression);
  }

  /** py:2679 `install_sql(self, expression)`. */
  install_sql(expression) {
    const force = expression.args.force ? "FORCE " : "";
    const this_ = this.sql(expression, "this");
    let from_clause = this.sql(expression, "from_");
    from_clause = from_clause ? ` FROM ${from_clause}` : "";
    return `${force}INSTALL ${this_}${from_clause}`;
  }

  /** py:3138 `join_sql(self, expression)`. */
  join_sql(expression) {
    if (
      !expression.args.using
      && !expression.args.on
      && !expression.method
      && ["", "INNER", "OUTER"].includes(expression.kind)
    ) {
      // Some dialects support `LEFT/INNER JOIN UNNEST(...)` without an explicit ON clause
      // DuckDB doesn't, but we can just add a dummy ON clause that is always true
      if (expression.this instanceof exp.Unnest) {
        return super.join_sql(expression.on(exp.true_()));
      }

      expression.set("side", null);
      expression.set("kind", null);
    }

    return super.join_sql(expression);
  }

  /** py:3939 `tablefromrows_sql(self, expression)`. */
  tablefromrows_sql(expression) {
    // For GENERATOR, unwrap TABLE() - just emit the Generator (becomes RANGE)
    if (expression.this instanceof exp.Generator) {
      // Preserve alias, joins, and other table-level args
      const table = new exp.Table({
        this: expression.this,
        alias: expression.args.alias,
        joins: expression.args.joins,
      });
      return this.sql(table);
    }

    return super.tablefromrows_sql(expression);
  }

  /** py:3974 `arrayagg_sql(self, expression)`. */
  arrayagg_sql(expression) {
    if (expression.this instanceof exp.Limit) {
      this.unsupported("LIMIT inside ARRAY_AGG is not supported in DuckDB");
    }

    return super.arrayagg_sql(expression);
  }

  /** py:3980 `ignorenulls_sql(self, expression)`. */
  ignorenulls_sql(expression) {
    let this_ = expression.this;

    if (this.constructor.IGNORE_RESPECT_NULLS_WINDOW_FUNCTIONS.some((cls) => this_ instanceof cls)) {
      // DuckDB should render IGNORE NULLS only for the general-purpose
      // window functions that accept it e.g. FIRST_VALUE(... IGNORE NULLS) OVER (...)
      return super.ignorenulls_sql(expression);
    }

    // For ARRAY_AGG(expr IGNORE NULLS ...), convert IGNORE NULLS to a
    // FILTER(WHERE expr IS NOT NULL) clause by setting nulls_excluded on
    // the ArrayAgg.  The existing _add_arrayagg_null_filter method will
    // emit the FILTER clause during arrayagg_sql / withingroup_sql.
    if (this_ instanceof exp.ArrayAgg) {
      this_.set("nulls_excluded", true);
      return this.sql(this_);
    }

    if (this_ instanceof exp.First) this_ = new exp.AnyValue({ this: this_.this });

    if (!(this_ instanceof exp.AnyValue || this_ instanceof exp.ApproxQuantiles)) {
      this.unsupported("IGNORE NULLS is not supported for non-window functions.");
    }

    return this.sql(this_);
  }

  /** py:4004 `split_sql(self, expression)`. */
  split_sql(expression) {
    const base_func = exp.func("STR_SPLIT", expression.this, expression.expression);

    let case_expr = exp.case().else_(base_func);
    let needs_case = false;

    if (expression.args.null_returns_null) {
      case_expr = case_expr.when(expression.expression.is_(exp.null_()), exp.null_());
      needs_case = true;
    }

    if (expression.args.empty_delimiter_returns_whole) {
      // When delimiter is empty string, return input string as single array element
      const array_with_input = exp.array(expression.this);
      case_expr = case_expr.when(expression.expression.eq(exp.Literal.string("")), array_with_input);
      needs_case = true;
    }

    return this.sql(needs_case ? case_expr : base_func);
  }

  /** py:4084 `respectnulls_sql(self, expression)`. */
  respectnulls_sql(expression) {
    if (this.constructor.IGNORE_RESPECT_NULLS_WINDOW_FUNCTIONS.some((cls) => expression.this instanceof cls)) {
      // DuckDB should render RESPECT NULLS only for the general-purpose
      // window functions that accept it e.g. FIRST_VALUE(... RESPECT NULLS) OVER (...)
      return super.respectnulls_sql(expression);
    }

    this.unsupported("RESPECT NULLS is not supported for non-window functions.");
    return this.sql(expression, "this");
  }

  /** py:2612 `generator_sql(self, expression)`. */
  generator_sql(expression) {
    // Transpile Snowflake GENERATOR to DuckDB range()
    const rowcount = expression.args.rowcount;
    const time_limit = expression.args.time_limit;

    if (time_limit) this.unsupported("GENERATOR TIMELIMIT parameter is not supported in DuckDB");

    if (!rowcount) {
      this.unsupported("GENERATOR without ROWCOUNT is not supported in DuckDB");
      return this.func("range", exp.Literal.number(0));
    }

    return this.func("range", rowcount);
  }

  /** py:4509 `round_sql(self, expression)`. */
  round_sql(expression) {
    const this_ = expression.this;
    let decimals = expression.args.decimals;
    let truncate = expression.args.truncate;

    // DuckDB requires the scale (decimals) argument to be an INT
    // Some dialects (e.g., Snowflake) allow non-integer scales and cast to an integer internally
    if (decimals !== null && decimals !== undefined && expression.args.casts_non_integer_decimals) {
      if (!(decimals.isInt || decimals.isType(...exp.DataType.INTEGER_TYPES))) {
        decimals = exp.cast(decimals, exp.DType.INT);
      }
    }

    let func = "ROUND";
    if (truncate) {
      // BigQuery uses ROUND_HALF_EVEN; Snowflake uses HALF_TO_EVEN
      if (["ROUND_HALF_EVEN", "HALF_TO_EVEN"].includes(truncate.this)) {
        func = "ROUND_EVEN";
        truncate = null;
      } else if (["ROUND_HALF_AWAY_FROM_ZERO", "HALF_AWAY_FROM_ZERO"].includes(truncate.this)) {
        // BigQuery uses ROUND_HALF_AWAY_FROM_ZERO; Snowflake uses HALF_AWAY_FROM_ZERO
        truncate = null;
      }
    }

    return this.func(func, this_, decimals, truncate);
  }

  /** py:3756 `base64encode_sql(self, expression)`. */
  base64encode_sql(expression) {
    // DuckDB TO_BASE64 requires BLOB input
    // Snowflake BASE64_ENCODE accepts both VARCHAR and BINARY - for VARCHAR it implicitly
    // encodes UTF-8 bytes. We add ENCODE unless the input is a binary type.
    let result = expression.this;

    // Check if input is a string type - ENCODE only accepts VARCHAR
    if (result.isType(...exp.DataType.TEXT_TYPES)) result = new exp.Encode({ this: result });

    result = new exp.ToBase64({ this: result });

    const max_line_length = expression.args.max_line_length;
    const alphabet = expression.args.alphabet;

    // Handle custom alphabet by replacing standard chars with custom ones
    result = _apply_base64_alphabet_replacements(result, alphabet);

    // Handle max_line_length by inserting newlines every N characters
    const line_length =
      max_line_length instanceof exp.Literal && max_line_length.isNumber ? Number(max_line_length.toPy()) : 0;
    if (line_length > 0) {
      const newline = new exp.Chr({ expressions: [exp.Literal.number(10)] });
      result = new exp.Trim({
        this: new exp.RegexpReplace({
          this: result,
          expression: exp.Literal.string(`(.{${line_length}})`),
          replacement: new exp.Concat({ expressions: [exp.Literal.string("\\1"), newline.copy()] }),
        }),
        expression: newline,
        position: "TRAILING",
      });
    }

    return this.sql(result);
  }

  /** py:3794 `hex_sql(self, expression)`. */
  hex_sql(expression) {
    const case_ = expression.args.case;

    if (!case_) return this.func("HEX", expression.this);

    const hex_expr = new exp.Hex({ this: expression.this });
    return this.sql(
      exp.case()
        .when(case_.is_(exp.null_()), exp.null_())
        .when(case_.copy().eq(0), new exp.Lower({ this: hex_expr.copy() }))
        .else_(hex_expr),
    );
  }

  /** py:2457 `jarowinklersimilarity_sql(self, expression)`. */
  jarowinklersimilarity_sql(expression) {
    let this_ = expression.this;
    let expr = expression.expression;

    if (expression.args.case_insensitive) {
      this_ = new exp.Upper({ this: this_ });
      expr = new exp.Upper({ this: expr });
    }

    let result = exp.func("JARO_WINKLER_SIMILARITY", this_, expr);

    if (expression.args.integer_scale) {
      result = exp.cast(result.mul(exp.Literal.number(100)), "INTEGER");
    }

    return this.sql(result);
  }

  /** py:2843 `unicode_sql(self, expression)`. */
  unicode_sql(expression) {
    if (expression.args.empty_is_zero) {
      return this.sql(
        exp.case()
          .when(expression.this.eq(exp.Literal.string("")), exp.Literal.number(0))
          .else_(new exp.Anonymous({ this: "UNICODE", expressions: [expression.this] })),
      );
    }

    return this.func("UNICODE", expression.this);
  }

  /** py:3425 `levenshtein_sql(self, expression)`. */
  levenshtein_sql(expression) {
    const this_ = expression.this;
    const expr = expression.expression;
    const max_dist = expression.args.max_dist;

    if (max_dist === null || max_dist === undefined) return this.func("LEVENSHTEIN", this_, expr);

    // Emulate Snowflake semantics: if distance > max_dist, return max_dist
    const levenshtein = new exp.Levenshtein({ this: this_, expression: expr });
    return this.sql(new exp.Least({ this: levenshtein, expressions: [max_dist] }));
  }

  /** py:4024 `splitpart_sql(self, expression)`. */
  splitpart_sql(expression) {
    const string_arg = expression.this;
    const delimiter_arg = expression.args.delimiter;
    let part_index_arg = expression.args.part_index;

    if (delimiter_arg && part_index_arg) {
      // Handle Snowflake's "index 0 and 1 both return first element" behavior
      if (expression.args.part_index_zero_as_one) {
        // Convert 0 to 1 for compatibility
        part_index_arg = new exp.Paren({
          this: exp.case()
            .when(part_index_arg.eq(exp.Literal.number("0")), exp.Literal.number("1"))
            .else_(part_index_arg),
        });
      }

      // Use Anonymous to avoid recursion
      const base_func_expr = new exp.Anonymous({ this: "SPLIT_PART", expressions: [string_arg, delimiter_arg, part_index_arg] });
      let needs_case_transform = false;
      let case_expr = exp.case().else_(base_func_expr);

      if (expression.args.empty_delimiter_returns_whole) {
        // When delimiter is empty string:
        // - Return whole string if part_index is 1 or -1
        // - Return empty string otherwise
        const empty_case = new exp.Paren({
          this: exp.case()
            .when(
              exp.or_(part_index_arg.eq(exp.Literal.number("1")), part_index_arg.eq(exp.Literal.number("-1"))),
              string_arg,
            )
            .else_(exp.Literal.string("")),
        });

        case_expr = case_expr.when(delimiter_arg.eq(exp.Literal.string("")), empty_case);
        needs_case_transform = true;
      }

      // Output looks something like this:
      //
      // CASE
      // WHEN delimiter is '' THEN
      //     (
      //         CASE
      //         WHEN adjusted_part_index = 1 OR adjusted_part_index = -1 THEN input
      //         ELSE '' END
      //     )
      // ELSE SPLIT_PART(input, delimiter, adjusted_part_index)
      // END
      return this.sql(needs_case_transform ? case_expr : base_func_expr);
    }

    return this.function_fallback_sql(expression);
  }

  /**
   * py:3558 `arrayslice_sql(self, expression)`.
   *
   * Transpiles Snowflake's ARRAY_SLICE (0-indexed, exclusive end) to DuckDB's
   * ARRAY_SLICE (1-indexed, inclusive end) by wrapping start and end in CASE
   * expressions that adjust the index at query time:
   *   - start: CASE WHEN start >= 0 THEN start + 1 ELSE start END
   *   - end:   CASE WHEN end < 0 THEN end - 1 ELSE end END
   */
  arrayslice_sql(expression) {
    let start = expression.args.start;
    let end = expression.args.end;

    if (expression.args.zero_based) {
      if (start !== null && start !== undefined) {
        start = exp.case()
          .when(new exp.GTE({ this: start.copy(), expression: exp.Literal.number(0) }), new exp.Add({ this: start.copy(), expression: exp.Literal.number(1) }))
          .else_(start);
      }
      if (end !== null && end !== undefined) {
        end = exp.case()
          .when(new exp.LT({ this: end.copy(), expression: exp.Literal.number(0) }), new exp.Sub({ this: end.copy(), expression: exp.Literal.number(1) }))
          .else_(end);
      }
    }

    return this.func("ARRAY_SLICE", expression.this, start, end, expression.args.step);
  }

  /** py:2311 `_array_bag_sql(self, condition, arr1, arr2)`. */
  _array_bag_sql(condition, arr1, arr2) {
    const cond = new exp.Paren({ this: exp.replacePlaceholders(condition, { arr1, arr2 }) });
    return this.sql(exp.replacePlaceholders(ARRAY_BAG_TEMPLATE, { arr1, arr2, cond }));
  }

  /** py:3541 `arrayintersect_sql(self, expression)`. */
  arrayintersect_sql(expression) {
    if (expression.args.is_multiset && expression.expressions.length === 2) {
      return this._array_bag_sql(ARRAY_INTERSECTION_CONDITION, expression.expressions[0], expression.expressions[1]);
    }
    return this.function_fallback_sql(expression);
  }

  /** py:3550 `arrayexcept_sql(self, expression)`. */
  arrayexcept_sql(expression) {
    const arr1 = expression.this, arr2 = expression.expression;
    if (expression.args.is_multiset) return this._array_bag_sql(ARRAY_EXCEPT_CONDITION, arr1, arr2);
    return this.sql(exp.replacePlaceholders(ARRAY_EXCEPT_SET_TEMPLATE, { arr1, arr2 }));
  }

  /** py:3128 `in_sql(self, expression)`. */
  in_sql(expression) {
    const unnest = expression.args.unnest;
    if (unnest) {
      return this.sql(exp.replacePlaceholders(IN_UNNEST_TEMPLATE, { arr: unnest.expressions[0], value: expression.this }));
    }
    return super.in_sql(expression);
  }

  /** py:4726 `bitwisenot_sql(self, expression)`. */
  bitwisenot_sql(expression) {
    const this_ = expression.this;

    if (_is_binary(this_)) expression.type = exp.DType.BINARY.intoExpr();

    let arg = _cast_to_bit(this_);

    if (this_ instanceof exp.Neg) arg = new exp.Paren({ this: arg });

    expression.set("this", arg);

    const result_sql = `~${this.sql(expression, "this")}`;

    return _gen_with_cast_to_blob(this, expression, result_sql);
  }

  /** py:4304 `aliases_sql(self, expression)`. */
  aliases_sql(expression) {
    const this_ = expression.this;
    if (this_ instanceof exp.Posexplode) return this.posexplode_sql(this_);

    return super.aliases_sql(expression);
  }

  /** py:4311 `posexplode_sql(self, expression)`. */
  posexplode_sql(expression) {
    const this_ = expression.this;
    const parent = expression.parent;

    // The default Spark aliases are "pos" and "col", unless specified otherwise
    let pos = exp.toIdentifier("pos"), col = exp.toIdentifier("col");

    if (parent instanceof exp.Aliases) {
      // Column case: SELECT POSEXPLODE(col) [AS (a, b)]
      [pos, col] = parent.expressions;
    } else if (parent instanceof exp.Table) {
      // Table case: SELECT * FROM POSEXPLODE(col) [AS (a, b)]
      const alias = parent.args.alias;
      if (alias) {
        [pos, col] = alias.columns.length ? alias.columns : [pos, col];
        alias.pop();
      }
    }

    // Translate POSEXPLODE to UNNEST + GENERATE_SUBSCRIPTS
    // Note: In Spark pos is 0-indexed, but in DuckDB it's 1-indexed, so we subtract 1 from GENERATE_SUBSCRIPTS
    const unnest_sql = this.sql(new exp.Unnest({ expressions: [this_], alias: col }));
    const gen_subscripts = this.sql(
      new exp.Alias({
        this: new exp.Anonymous({ this: "GENERATE_SUBSCRIPTS", expressions: [this_, exp.Literal.number(1)] }).sub(exp.Literal.number(1)),
        alias: pos,
      }),
    );

    const posexplode_sql = this.format_args(gen_subscripts, unnest_sql);

    if (parent instanceof exp.From || (parent && parent.parent instanceof exp.From)) {
      // SELECT * FROM POSEXPLODE(col) -> SELECT * FROM (SELECT GENERATE_SUBSCRIPTS(...), UNNEST(...))
      return this.sql(new exp.Subquery({ this: new exp.Select({ expressions: [posexplode_sql] }) }));
    }

    return posexplode_sql;
  }

  /** py:4209 `regexpinstr_sql(self, expression)`. */
  regexpinstr_sql(expression) {
    let this_ = expression.this;
    let pattern = expression.expression;
    const position = expression.args.position;
    const orig_occ = expression.args.occurrence;
    const occurrence = orig_occ || exp.Literal.number(1);
    const option = expression.args.option;
    const parameters = expression.args.parameters;

    const validated_flags = this._validate_regexp_flags(parameters, "ims");
    if (validated_flags) {
      pattern = new exp.Concat({ expressions: [exp.Literal.string(`(?${validated_flags})`), pattern] });
    }

    // Handle starting position offset
    let pos_offset = exp.Literal.number(0);
    if (position && (!position.isInt || Number(position.toPy()) > 1)) {
      this_ = new exp.Substring({ this: this_, start: position });
      pos_offset = position.sub(exp.Literal.number(1));
    }

    // Helper: LIST_SUM(LIST_TRANSFORM(list[1:end], x -> LENGTH(x)))
    const sum_lengths = (func_name, end) => {
      const lst = new exp.Bracket({
        this: new exp.Anonymous({ this: func_name, expressions: [this_, pattern] }),
        expressions: [new exp.Slice({ this: exp.Literal.number(1), expression: end })],
        offset: 1,
      });
      const transform = new exp.Anonymous({
        this: "LIST_TRANSFORM",
        expressions: [lst, new exp.Lambda({ this: new exp.Length({ this: exp.toIdentifier("x") }), expressions: [exp.toIdentifier("x")] })],
      });
      return new exp.Coalesce({ this: new exp.Anonymous({ this: "LIST_SUM", expressions: [transform] }), expressions: [exp.Literal.number(0)] });
    };

    // Position = 1 + sum(split_lengths[1:occ]) + sum(match_lengths[1:occ-1]) + offset
    let base_pos = exp.Literal.number(1)
      .add(sum_lengths("STRING_SPLIT_REGEX", occurrence))
      .add(sum_lengths("REGEXP_EXTRACT_ALL", occurrence.sub(exp.Literal.number(1))))
      .add(pos_offset);

    // option=1: add match length for end position
    if (option && option.isInt && Number(option.toPy()) === 1) {
      const match_at_occ = new exp.Bracket({
        this: new exp.Anonymous({ this: "REGEXP_EXTRACT_ALL", expressions: [this_, pattern] }),
        expressions: [occurrence],
        offset: 1,
      });
      base_pos = base_pos.add(new exp.Coalesce({ this: new exp.Length({ this: match_at_occ }), expressions: [exp.Literal.number(0)] }));
    }

    // NULL checks for all provided arguments
    // .copy() is used strictly because .is_() alters the node's parent pointer, mutating the parsed AST
    const null_args = [expression.this, expression.expression, position, orig_occ, option, parameters];
    const null_checks = null_args.filter((arg) => arg).map((arg) => arg.copy().is_(exp.null_()));

    const matches = new exp.Anonymous({ this: "REGEXP_EXTRACT_ALL", expressions: [this_, pattern] });

    return this.sql(
      exp.case()
        .when(exp.or_(...null_checks), exp.null_())
        .when(pattern.copy().eq(exp.Literal.string("")), exp.Literal.number(0))
        .when(new exp.LT({ this: new exp.Length({ this: matches }), expression: occurrence }), exp.Literal.number(0))
        .else_(base_pos),
    );
  }

  /** py:3231 `length_sql(self, expression)`. */
  length_sql(expression) {
    const arg = expression.this;

    // Dialects like BQ and Snowflake also accept binary values as args, so
    // DDB will attempt to infer the type or resort to case/when resolution
    if (!expression.args.binary || arg.isString) return this.func("LENGTH", arg);

    let arg_ = arg;
    if (!arg_.type) arg_ = annotate_types(arg_, { dialect: this.dialect });

    if (arg_.isType(...exp.DataType.TEXT_TYPES)) return this.func("LENGTH", arg_);

    // We need these casts to make duckdb's static type checker happy
    const blob = exp.cast(arg_, exp.DType.VARBINARY);
    const varchar = exp.cast(arg_, exp.DType.VARCHAR);

    const case_ = exp.case(new exp.Anonymous({ this: "TYPEOF", expressions: [arg_] }))
      .when(exp.Literal.string("BLOB"), new exp.ByteLength({ this: blob }))
      .else_(new exp.Anonymous({ this: "LENGTH", expressions: [varchar] }));
    return this.sql(case_);
  }

  /** py:3746 `bytelength_sql(self, expression)`. */
  bytelength_sql(expression) {
    const arg = expression.this;

    // Check if it's a text type (handles both literals and annotated expressions)
    if (arg.isType(...exp.DataType.TEXT_TYPES)) return this.func("OCTET_LENGTH", new exp.Encode({ this: arg }));

    // Default: pass through as-is (conservative for DuckDB, handles binary and unannotated)
    return this.func("OCTET_LENGTH", arg);
  }

  /** py:4775 `uuid_sql(self, expression)`. */
  uuid_sql(expression) {
    const namespace = expression.this;
    const name = expression.args.name;

    // UUID v5 (namespace + name) - Emulate using SHA1
    if (namespace && name) {
      const result = exp.replacePlaceholders(UUID_V5_TEMPLATE.copy(), { namespace, name });
      return this.sql(result);
    }

    return super.uuid_sql(expression);
  }

  /** py:2822 `checkjson_sql(self, expression)`. */
  checkjson_sql(expression) {
    const arg = expression.this;
    return this.sql(
      exp.case()
        .when(exp.or_(arg.is_(exp.null_()), arg.eq(""), exp.func("json_valid", arg)), exp.null_())
        .else_(exp.Literal.string("Invalid JSON"))
    );
  }

  /** py:2833 `parsejson_sql(self, expression)`. */
  parsejson_sql(expression) {
    const arg = expression.this;
    if (expression.args.safe) {
      return this.sql(
        exp.case()
          .when(exp.func("json_valid", arg), exp.cast(arg.copy(), "JSON"))
          .else_(exp.null_())
      );
    }
    return this.func("JSON", arg);
  }

  /** py:4714 `jsonextractscalar_sql(self, expression)`. */
  jsonextractscalar_sql(expression) {
    if (expression.args.scalar_only) {
      const json_value = new exp.JSONExtractScalar({
        this: rename_func("JSON_VALUE")(this, expression),
        expression: "'$'",
      });

      // `->>` binds looser than most operators, so the wrap logic needs the parent
      json_value.parent = expression.parent;
      expression = json_value;
    }

    return _arrow_json_extract_sql(this, expression);
  }

  /** py:2853 `stripnullvalue_sql(self, expression)`. */
  stripnullvalue_sql(expression) {
    return this.sql(
      exp.case()
        .when(exp.func("json_type", expression.this).eq("NULL"), exp.null_())
        .else_(expression.this)
    );
  }
}
