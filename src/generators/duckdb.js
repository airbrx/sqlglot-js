// py: sqlglot/generators/duckdb.py — `class DuckDBGenerator(generator.Generator)`.
//
// @ported-ranges sqlglot/generators/duckdb.py 50-50 545-547 549-563 890-901 1017-1020 1123-1130 1261-1274 1459-1497 1554-1590 1591-1814 1816-1821 1823-1844 1852-1931
//
// SCOPE — a deliberately small, honest slice of a 4,788-line file (PORT_PLAN.md,
// "DuckDB generator is an outlier size" — ~4x every other single-file dialect
// generator ported so far). This file does NOT attempt exhaustive coverage; see
// PORT_PLAN.md's R32 entry for the marginal analysis that drove the cut and the
// follow-on stub queue (140 methods, ~110 TRANSFORMS entries, PROPERTIES_LOCATION /
// the CREATE-statement properties system, and every ClassVar SQL template are all
// still NotPorted).
//
// WHAT IS HERE:
//   - The ~35 scalar class settings (py:1554-1589) — these change how ALREADY-PORTED
//     base `Generator` methods render DuckDB SQL even without a single DuckDB-specific
//     override or TRANSFORMS entry (tablesample_sql, join_sql, etc. all read them).
//   - `TRANSFORMS` (py:1590-1814): ~60 of 147 entries. Two tiers:
//       Tier 1 (~35): wired verbatim to shared helpers `src/dialects/dialect.js`
//       already ports unmodified (`rename_func`, `array_append_sql`, `datestrtodate_sql`,
//       `groupconcat_sql`, `no_make_interval_sql`, `approx_count_distinct_sql`,
//       `no_time_sql`, `no_timestamp_sql`, `timestrtotime_sql`) — zero new logic.
//       Tier 2 (~25): small (4-40 line) DuckDB-local helper functions with no further
//       unported dependency, ported below (boolean-coercion group, ArraySort/
//       ArrayContains, AnyValue, BoolxorAgg, the Unix*-to-timestamp implicit-cast
//       group) plus a batch of self-contained one-line lambdas.
//     Every OTHER entry is commented out at its upstream anchor, matching the
//     established "still-unseeded TRANSFORMS" convention (`src/generator.js`'s own
//     stub-`TRANSFORMS` lines; `src/generators/snowflake.js`'s five blocked entries).
//     The largest excluded group is `_date_delta_to_binary_interval_op` (9 entries) —
//     it wraps `dialect.js`'s shared `date_delta_to_binary_interval_op` with its own
//     nanosecond/float-interval handling and was judged too large for this pass.
//   - `SUPPORTED_JSON_PATH_PARTS`, `TYPE_MAPPING`, `RESERVED_KEYWORDS` (py:1816-1931):
//     cheap, mechanical, real upstream data with no code-logic risk.
//
// WHAT IS DELIBERATELY NOT HERE (left for a follow-on session, named rather than
// silently skipped):
//   - All 140 `*_sql` method overrides (py:2311 onward) — `create_sql`/`createable_sql`
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
import {
  approx_count_distinct_sql,
  array_append_sql,
  array_concat_sql,
  datestrtodate_sql,
  groupconcat_sql,
  no_comment_column_constraint_sql,
  no_make_interval_sql,
  no_time_sql,
  no_timestamp_sql,
  rename_func,
  timestrtotime_sql,
} from "../dialects/dialect.js";

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
    // py:1597 [exp.Array, transforms.preprocess([transforms.inherit_struct_field_names], generator=inline_array_unless_query)] — blocked, needs this file's own `inline_array_unless_query`
    [exp.ArrayAppend, array_append_sql("LIST_APPEND")],
    // py:1602 [exp.ArrayCompact, array_compact_sql] — blocked, dialect.js does not yet export `array_compact_sql`
    // py:1603 [exp.ArrayConstructCompact, lambda] — blocked, depends on the excluded ArrayCompact entry
    [exp.ArrayConcat, array_concat_sql("LIST_CONCAT")],
    // py:1607 [exp.ArrayContains, _array_contains_sql] — NOTE: real DuckDB `ArrayContains` (Snowflake-sourced,
    // `check_null` flag) is ported above as `_array_contains_sql`, wired below.
    [exp.ArrayContains, _array_contains_sql],
    // py:1608 [exp.ArrayOverlaps, _array_overlaps_sql] — blocked, `_array_overlaps_sql` (42 lines) out of scope this pass
    [exp.ArrayFilter, rename_func("LIST_FILTER")],
    // py:1610 [exp.ArrayInsert, _array_insert_sql] — blocked, 94-line local helper out of scope this pass
    // py:1611 [exp.ArrayPosition, lambda] — blocked, needs `zero_based` arg semantics not yet checked against a base method this pass touches
    // py:1621 [exp.ArrayRemoveAt, _array_remove_at_sql] — blocked, 91-line local helper out of scope this pass
    // py:1622 [exp.ArrayRemove, remove_from_array_using_filter] — blocked, dialect.js does not yet export `remove_from_array_using_filter`
    [exp.ArraySort, _array_sort_sql],
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
    // py:1670-1678,1754-1755,1759,1763,1778 [*Add/*Sub via _date_delta_to_binary_interval_op] — blocked,
    // the local nanosecond/float-interval wrapper (py:320) is out of scope this pass; see file header.
    [exp.DateStrToDate, datestrtodate_sql],
    // py:1675 [exp.Datetime, no_datetime_sql] — blocked, needs the unported `TIMEZONES` set
    // py:1679-1681 [exp.DateToDi, lambda] — skipped, low value (DI = Julian "date-as-int" legacy format)
    // py:1682-1683 [exp.Decode, exp.HexDecodeString] — blocked, dialect.js does not yet export `encode_decode_sql`
    // py:1684-1686 [exp.DiToDate, lambda] — skipped, pairs with the excluded DateToDi above
    // py:1687 [exp.Encode, lambda] — blocked, same as Decode above
    [
      exp.EqualNull,
      (self, e) => self.sql(new exp.NullSafeEQ({ this: e.this, expression: e.expression })),
    ],
    [exp.EuclideanDistance, rename_func("LIST_DISTANCE")],
    // py:1692-1694 [exp.GenerateDateArray/Series/TimestampArray] — blocked, local helpers out of scope this pass
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
    // py:1739 [exp.Pivot, transforms.preprocess([transforms.unqualify_columns])] — blocked, `exp.Pivot` DuckDB
    // qualification quirk needs its own verification pass, deferred with the rest of transforms.preprocess entries
    [exp.RegexpSplit, rename_func("STR_SPLIT_REGEX")],
    // py:1741-1743,1745-1746 [exp.RegexpILike, exp.RegrValx, exp.RegrValy] — blocked, local helpers out of scope
    // py:1747-1748 [exp.Return, exp.ReturnsProperty] — real, wired below
    [exp.Return, (self, e) => self.sql(e, "this")],
    [exp.ReturnsProperty, (self, e) => (e.this instanceof exp.Schema ? "TABLE" : "")],
    // py:1749-1751 [exp.StrToUnix, lambda] — skipped, chains through DuckDB's own `format_time` handling not
    // separately verified this pass
    // py:1752 [exp.Struct, _struct_sql] — blocked, local helper out of scope this pass
    [exp.Transform, rename_func("LIST_TRANSFORM")],
    // py:1754-1755,1759,1763,1778 — see the _date_delta_to_binary_interval_op note above (py:1670-1678)
    // py:1756 [exp.Time, no_time_sql] wires directly — real, wired below
    [exp.Time, no_time_sql],
    // py:1757 [exp.TimeDiff, _timediff_sql] — blocked, BigQuery-specific local helper out of scope this pass
    [exp.Timestamp, no_timestamp_sql],
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
    // py:1778 [exp.TsOrDsAdd, _date_delta_to_binary_interval_op] — blocked, see py:1670-1678 note above
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
    // py:1797,1803 [exp.YearOfWeek, exp.YearOfWeekIso] — blocked. Both build an
    // `exp.Extract` node and render it, which dispatches to base `extract_sql`
    // (sqlglot/generator.py:3649, still NotPorted). `extract_sql` itself is small (17
    // lines) but needs `dialects/dialect.js`'s `map_date_part` — and `generator.js`
    // cannot import `dialects/dialect.js` (the reverse import already exists,
    // `dialect.js:49`, so this direction would cycle). Newly-found hazard, written up
    // as PORT_PLAN.md R32: porting `extract_sql` needs either a lazy dynamic import (it
    // is a sync method on a sync call chain, so that does not work directly) or a
    // registration-hook indirection (`registerGenerator`-style) neither of which is a
    // same-pass fix.
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
}
