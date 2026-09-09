// py: sqlglot/generators/hive.py — `class HiveGenerator(generator.Generator)`.
//
// The generator-side half of the four-link chain `Hive <- Spark2 <- Spark <-
// Databricks` (PORT_PLAN.md, Ben's corrected priority §1). The other three files in
// this directory — `spark2.js`, `spark.js`, `databricks.js` — extend this one in the
// same order upstream does. `src/dialects/{hive,spark2,spark,databricks}.js` (P5,
// already landed) are the SETTINGS half of this same split, same as every other
// dialect's `parsers/<x>.js` + `dialects/<x>.js` + `generators/<x>.js` three-way split.
//
// This is also this port's FIRST class in the chain whose method OVERRIDES call
// `super()` on base `Generator` methods that no earlier dialect had ever reached —
// `columndef_sql`, `schema_sql`/`schema_columns_sql`, `version_sql`, `exists_sql`,
// `ignorenulls_sql`/`_embed_ignore_nulls`, `_jsonpathkey_sql`/`json_path_part`,
// `trim_sql`, `like_sql`/`ilike_sql`/`_like_sql`/`escape_sql`,
// `bracket_sql`/`bracket_offset_expressions`, `interval_sql`, and `var_sql` were all
// still `NotPorted` stubs before this file and are ported for real in `src/generator.js`
// as part of this same change — see PORT_PLAN.md R31 for the shape of the hazard this
// is (a `super()` call reaching a base method no previous single-file dialect needed).
//
// `sqlglot/transforms.py` also grows by nine functions this file (and its three
// descendants) need and the parallel `p4-transforms` branch (R26) did not carry:
// `unnest_generate_series`, `unnest_to_explode`, `remove_within_group_for_percentiles`,
// `unqualify_columns`, `unqualify_pivot_fields`, `remove_unique_constraints`,
// `ctas_with_tmp_tables_to_create_tmp_view`, `move_schema_columns_to_partitioned_by`,
// `move_partitioned_by_to_schema_columns`, `any_to_exists`, and
// `inherit_struct_field_names` — see `src/transforms.js`'s own updated header.
//
// `sqlglot/dialects/dialect.py` gains eighteen more shared generator helpers this file
// (and its descendants) need: `bracket_to_element_at_sql`, `approx_count_distinct_sql`,
// `no_ilike_sql`, `no_recursive_cte_sql`, `no_trycast_sql`, `property_sql`,
// `struct_extract_sql`, `time_format`, `left_to_substring_sql`,
// `right_to_substring_sql`, `trim_sql`, `regexp_extract_sql`, `regexp_replace_sql`,
// `is_parse_json`, `arg_max_or_min_no_count`, `DATETIME_ADD`,
// `date_delta_to_binary_interval_op`, and `sequence_sql` — see `src/dialects/dialect.js`'s
// own updated header for the same reasoning R27 already established for this pattern.

import { compile as pyReCompile } from "../_py/re.js";
import { cpAt, pyIsAlnum, pyIsDigit } from "../_py/str.js";
import { pyIntFromStr } from "../_py/num.js";
import * as exp from "../expressions/index.js";
import { Generator, unsupported_args } from "../generator.js";
import { formatTime } from "../time.js";
import {
  approx_count_distinct_sql,
  arg_max_or_min_no_count,
  datestrtodate_sql,
  if_sql,
  left_to_substring_sql,
  max_or_greatest,
  min_or_least,
  no_ilike_sql,
  no_recursive_cte_sql,
  no_trycast_sql,
  property_sql,
  regexp_extract_sql,
  regexp_replace_sql,
  rename_func,
  right_to_substring_sql,
  sequence_sql,
  strposition_sql,
  struct_extract_sql,
  time_format,
  timestrtotime_sql,
  trim_sql,
  var_map_sql,
  weekstart_unit_to_str,
} from "../dialects/dialect.js";
import {
  any_to_exists,
  ctas_with_tmp_tables_to_create_tmp_view,
  eliminate_distinct_on,
  eliminate_qualify,
  inherit_struct_field_names,
  move_schema_columns_to_partitioned_by,
  preprocess,
  remove_unique_constraints,
  unnest_generate_series,
  unnest_to_explode,
} from "../transforms.js";

// py:43 "These constants are duplicated from the Hive dialect class to avoid circular
// imports. They must be kept in sync with Hive.TIME_FORMAT, Hive.DATE_FORMAT,
// Hive.DATEINT_FORMAT." — `src/dialects/hive.js` sets the identical three literals
// (DATE_FORMAT/DATEINT_FORMAT/TIME_FORMAT); this file cannot import that module (it
// would create hive.js <-> generators/hive.js <-> hive.js), so the duplication is
// upstream's own, reproduced rather than "fixed" by a shared import.
export const HIVE_TIME_FORMAT = "'yyyy-MM-dd HH:mm:ss'";
export const HIVE_DATE_FORMAT = "'yyyy-MM-dd'";
const HIVE_DATEINT_FORMAT = "'yyyyMMdd'";

// py:50 "The default formats above, as rendered by the lenient rewrite (non-padded
// month/day/time)".
const HIVE_NON_PADDED_TIME_FORMATS = ["'yyyy-M-d H:m:s'", "'yyyy-M-d'"];

/** py:53 `PARSE_TIME_EXPRESSIONS: tuple[type[exp.Expr], ...]`. */
const PARSE_TIME_EXPRESSIONS = [exp.StrToTime, exp.StrToDate, exp.StrToUnix, exp.TsOrDsToDate];

/**
 * py:55 `CANONICAL_TIME_FORMAT = re.compile(r"%(?:[mdHIMS]strict|[-:].|.)")`.
 *
 * A real `_py/re.js` pattern, not a JS `RegExp` literal: this is a Python `str`
 * pattern applied to a Python `str` (the already-translated `%`-format string), so
 * `.split`/`.findall` need CPython's own scanning semantics (`must_advance`, `$`, `\w`
 * — R24), not JS `String.prototype.split`/`match`. This is the first call site in
 * `src/` (outside `_py/` itself) to use the ported engine rather than a hand-rolled
 * `.test()`-only wrapper, because `_lenient_parse_format` below genuinely needs
 * `split`/`findall`, not just membership testing.
 */
const CANONICAL_TIME_FORMAT = pyReCompile("%(?:[mdHIMS]strict|[-:].|.)");

/** py:57 `LAX_TO_NON_PADDED_FORMATS`. */
const LAX_TO_NON_PADDED_FORMATS = new Map([
  ["%m", "%-m"],
  ["%d", "%-d"],
  ["%H", "%-H"],
  ["%I", "%-I"],
  ["%M", "%-M"],
  ["%S", "%-S"],
]);

/**
 * py:67 `_lenient_parse_format(fmt)`.
 *
 * Changes a lax month/day/hour/minute/second in a canonical format to its non-padded
 * form (e.g. %m -> %-m), which java.time parses with or without a leading zero. This
 * is only safe for delimited specifiers, because adjacent fields parse greedily, so
 * e.g. 'yyyyMd' (from '%Y%m%d') can't even parse '20200101'.
 *
 * `left[-1].isdigit()` / `right[0].isdigit()` are CODE-POINT single-character reads
 * (rule 3), via `cpAt`, even though every literal separator here is realistically
 * ASCII — the port's own discipline, not a guess about the input.
 *
 * @param {string} fmt
 * @returns {string}
 */
function _lenient_parse_format(fmt) {
  const parts = CANONICAL_TIME_FORMAT.split(fmt);
  const formats = CANONICAL_TIME_FORMAT.findall(fmt);

  for (let i = 0; i < formats.length; i++) {
    const fmt_ = formats[i];
    if (LAX_TO_NON_PADDED_FORMATS.has(fmt_)) {
      const left = parts[i];
      const right = parts[i + 1];
      const left_adjacent = (!left && i > 0) || (!!left && pyIsDigit(cpAt(left, -1)));
      const right_adjacent = (!right && i < formats.length - 1) || (!!right && pyIsDigit(cpAt(right, 0)));
      if (!left_adjacent && !right_adjacent) {
        formats[i] = LAX_TO_NON_PADDED_FORMATS.get(fmt_);
      }
    }
  }

  const formats_plus = [...formats, ""];
  let out = "";
  for (let i = 0; i < parts.length; i++) out += parts[i] + (formats_plus[i] ?? "");
  return out;
}

// py:93 `DATE_DELTA_INTERVAL` — (FuncType, Multiplier).
const DATE_DELTA_INTERVAL = new Map([
  ["YEAR", ["ADD_MONTHS", 12]],
  ["MONTH", ["ADD_MONTHS", 1]],
  ["QUARTER", ["ADD_MONTHS", 3]],
  ["WEEK", ["DATE_ADD", 7]],
  ["DAY", ["DATE_ADD", 1]],
]);

// py:102 `TIME_DIFF_FACTOR`.
const TIME_DIFF_FACTOR = new Map([
  ["MILLISECOND", " * 1000"],
  ["SECOND", ""],
  ["MINUTE", " / 60"],
  ["HOUR", " / 3600"],
]);

// py:109 `DIFF_MONTH_SWITCH`.
const DIFF_MONTH_SWITCH = ["YEAR", "QUARTER", "MONTH"];

/** py:111 `HIVE_TS_OR_DS_EXPRESSIONS`. */
export const HIVE_TS_OR_DS_EXPRESSIONS = [exp.DateDiff, exp.Day, exp.Month, exp.Year];

/** py:119 `_add_date_sql(self, expression: DATE_ADD_OR_SUB)`. */
function _add_date_sql(self, expression) {
  if (expression instanceof exp.TsOrDsAdd && !expression.args.unit) {
    return self.func("DATE_ADD", expression.this, expression.expression);
  }

  const unit = expression.text("unit").toUpperCase();
  const [func, base_multiplier] = DATE_DELTA_INTERVAL.get(unit) || ["DATE_ADD", 1];
  let multiplier = base_multiplier;

  if (expression instanceof exp.DateSub) multiplier *= -1;

  let increment = expression.expression;
  if (increment instanceof exp.Literal) {
    const value = increment.is_number ? increment.toPy() : pyIntFromStr(increment.name);
    increment = exp.Literal.number(typeof value === "bigint" ? value * BigInt(multiplier) : Number(value) * multiplier);
  } else if (multiplier !== 1) {
    // deny:operators sqlglot/generators/hive.py:134 — Python `*=` on an Expr
    // (`__imul__`/`__mul__`) builds `exp.Mul`; `.mul()` is this port's `_binop`
    // equivalent, not the JS `*` operator.
    increment = increment.mul(exp.Literal.number(multiplier));
  }

  return self.func(func, expression.this, increment);
}

/** py:139 `_date_diff_sql(self, expression: exp.DateDiff | exp.TsOrDsDiff)`. */
function _date_diff_sql(self, expression) {
  const unit = expression.text("unit").toUpperCase();

  const factor = TIME_DIFF_FACTOR.get(unit);
  if (factor !== undefined) {
    const left = self.sql(expression, "this");
    const right = self.sql(expression, "expression");
    const sec_diff = `UNIX_TIMESTAMP(${left}) - UNIX_TIMESTAMP(${right})`;
    return factor ? `(${sec_diff})${factor}` : sec_diff;
  }

  const months_between = DIFF_MONTH_SWITCH.includes(unit);
  const sql_func = months_between ? "MONTHS_BETWEEN" : "DATEDIFF";
  const [, multiplier] = DATE_DELTA_INTERVAL.get(unit) || ["", 1];
  const multiplier_sql = multiplier > 1 ? ` / ${multiplier}` : "";
  let diff_sql = `${sql_func}(${self.format_args(expression.this, expression.expression)})`;

  if (months_between || multiplier_sql) {
    // MONTHS_BETWEEN returns a float, so we need to truncate the fractional part.
    // For the same reason, we want to truncate if there's a divisor present.
    diff_sql = `CAST(${diff_sql}${multiplier_sql} AS INT)`;
  }

  return diff_sql;
}

/** py:163 `@generator.unsupported_args(("expression", "Hive's SORT_ARRAY does not support a comparator.")) def _array_sort_sql`. */
const _array_sort_sql = unsupported_args([
  "expression",
  "Hive's SORT_ARRAY does not support a comparator.",
])((self, expression) => self.func("SORT_ARRAY", expression.this));

/** py:168 `_str_to_unix_sql(self, expression: exp.StrToUnix)`. */
function _str_to_unix_sql(self, expression) {
  return self.func("UNIX_TIMESTAMP", expression.this, time_format("hive")(self, expression));
}

/** py:172 `_unix_to_time_sql(self, expression: exp.UnixToTime)`. */
function _unix_to_time_sql(self, expression) {
  const timestamp = self.sql(expression, "this");
  const scale = expression.args.scale;
  if (scale == null || scale.equals(exp.UnixToTime.SECONDS)) {
    return rename_func("FROM_UNIXTIME")(self, expression);
  }

  // deny:implicit_str sqlglot/generators/hive.py:178 — f-string on `scale` (an Expr,
  // `expression.args.get("scale")`) calls Python's implicit `str(scale)` == `.sql()`;
  // `self.sql(scale)` is explicit here rather than relying on template-literal coercion.
  return `FROM_UNIXTIME(${timestamp} / POW(10, ${self.sql(scale)}))`;
}

/** py:181 `_is_cast_time_format(self, expression, time_format)` — "Checks whether CAST subsumes the expression's parse format." */
function _is_cast_time_format(self, expression, time_format_str) {
  if (time_format_str === HIVE_TIME_FORMAT || time_format_str === HIVE_DATE_FORMAT) return true;

  if (HIVE_NON_PADDED_TIME_FORMATS.includes(time_format_str)) {
    // The base render skips the lenient rewrite: a lax specifier pads back (e.g.
    // %m -> MM), an explicit non-padded specifier (e.g. %-m) doesn't
    const padded_format = Generator.prototype.format_time.call(self, expression);
    return padded_format === HIVE_TIME_FORMAT || padded_format === HIVE_DATE_FORMAT;
  }

  return false;
}

/** py:195 `_str_to_date_sql(self, expression: exp.StrToDate)`. */
function _str_to_date_sql(self, expression) {
  let this_ = self.sql(expression, "this");
  const time_format_ = self.format_time(expression);
  if (time_format_ && !_is_cast_time_format(self, expression, time_format_)) {
    this_ = `FROM_UNIXTIME(UNIX_TIMESTAMP(${this_}, ${time_format_}))`;
  }
  return `CAST(${this_} AS DATE)`;
}

/** py:203 `_str_to_time_sql(self, expression: exp.StrToTime)`. */
function _str_to_time_sql(self, expression) {
  let this_ = self.sql(expression, "this");
  const time_format_ = self.format_time(expression);
  if (time_format_ && !_is_cast_time_format(self, expression, time_format_)) {
    this_ = `FROM_UNIXTIME(UNIX_TIMESTAMP(${this_}, ${time_format_}))`;
  }
  return `CAST(${this_} AS TIMESTAMP)`;
}

/** py:211 `_to_date_sql(self, expression: exp.TsOrDsToDate)`. */
function _to_date_sql(self, expression) {
  const time_format_ = self.format_time(expression);
  if (time_format_ && !_is_cast_time_format(self, expression, time_format_)) {
    return self.func("TO_DATE", expression.this, time_format_);
  }

  if (self.constructor.TS_OR_DS_EXPRESSIONS.some((cls) => expression.parent instanceof cls)) {
    return self.sql(expression, "this");
  }

  return self.func("TO_DATE", expression.this);
}

/**
 * py:237 `SAFE_JSON_PATH_KEY_RE = re.compile(r"^[_\-a-zA-Z][\-\w]*$")`.
 *
 * Same "NOT a `RegExp`" treatment `exp.SAFE_IDENTIFIER_RE` (expressions/core.js)
 * documents for exactly this override — its own doc comment names this file and this
 * line by upstream path — because `\w` and `$` carry the same Python-vs-JS semantic
 * gap R24 found (Unicode-aware `\w`, and `$` allowing one trailing newline).
 */
const HIVE_SAFE_JSON_PATH_KEY_RE = Object.freeze({
  source: "^[_\\-a-zA-Z][\\-\\w]*$",
  toString() {
    return this.source;
  },
  test(s) {
    if (typeof s !== "string") return false;
    const body = s.endsWith("\n") ? s.slice(0, -1) : s;
    const chars = [...body];
    if (chars.length === 0) return false;
    const first = chars[0];
    if (!(first === "_" || first === "-" || (first >= "a" && first <= "z") || (first >= "A" && first <= "Z"))) {
      return false;
    }
    for (let i = 1; i < chars.length; i++) {
      if (chars[i] !== "_" && chars[i] !== "-" && !pyIsAlnum(chars[i])) return false;
    }
    return true;
  },
});

/** py:222 `class HiveGenerator(generator.Generator)`. */
export class HiveGenerator extends Generator {
  static SELECT_KINDS = [];
  static TRY_SUPPORTED = false;
  static SUPPORTS_UESCAPE = false;
  static SUPPORTS_DECODE_CASE = false;
  static LIMIT_FETCH = "LIMIT";
  static TABLESAMPLE_WITH_METHOD = false;
  static JOIN_HINTS = false;
  static TABLE_HINTS = false;
  static QUERY_HINTS = false;
  static INDEX_ON = "ON TABLE";
  static EXTRACT_ALLOWS_QUOTES = false;
  static NVL2_SUPPORTED = false;
  static LAST_DAY_SUPPORTS_DATE_PART = false;
  static JSON_PATH_SINGLE_QUOTE_ESCAPE = true;
  static SAFE_JSON_PATH_KEY_RE = HIVE_SAFE_JSON_PATH_KEY_RE;
  static SUPPORTS_TO_NUMBER = false;
  static WITH_PROPERTIES_PREFIX = "TBLPROPERTIES";
  static PARSE_JSON_NAME = "PARSE_JSON";
  static PAD_FILL_PATTERN_IS_REQUIRED = true;
  static SUPPORTS_MEDIAN = false;
  static ARRAY_SIZE_NAME = "SIZE";
  static ALTER_SET_TYPE = "";

  static EXPRESSIONS_WITHOUT_NESTED_CTES = new Set([exp.Insert, exp.Select, exp.Subquery, exp.SetOperation]);

  static SUPPORTED_JSON_PATH_PARTS = new Set([
    exp.JSONPathKey,
    exp.JSONPathRoot,
    exp.JSONPathSubscript,
    exp.JSONPathWildcard,
  ]);

  static TYPE_MAPPING = new Map([
    ...Generator.TYPE_MAPPING,
    [exp.DType.BIT, "BOOLEAN"],
    [exp.DType.BLOB, "BINARY"],
    [exp.DType.DATETIME, "TIMESTAMP"],
    [exp.DType.ROWVERSION, "BINARY"],
    [exp.DType.TEXT, "STRING"],
    [exp.DType.TIME, "TIMESTAMP"],
    [exp.DType.TIMESTAMPNTZ, "TIMESTAMP"],
    [exp.DType.TIMESTAMPTZ, "TIMESTAMP"],
    [exp.DType.UTINYINT, "SMALLINT"],
    [exp.DType.VARBINARY, "BINARY"],
  ]);

  static TRANSFORMS = new Map([
    ...Generator.TRANSFORMS,
    [exp.Property, property_sql],
    [exp.AnyValue, rename_func("FIRST")],
    [exp.ApproxDistinct, approx_count_distinct_sql],
    [exp.ArgMax, arg_max_or_min_no_count("MAX_BY")],
    [exp.ArgMin, arg_max_or_min_no_count("MIN_BY")],
    [exp.Array, preprocess([inherit_struct_field_names])],
    [exp.ArrayConcat, rename_func("CONCAT")],
    [exp.ArrayToString, (self, e) => self.func("CONCAT_WS", e.expression, e.this)],
    [exp.ArraySort, _array_sort_sql],
    [exp.With, no_recursive_cte_sql],
    [exp.DateAdd, _add_date_sql],
    [exp.DateDiff, _date_diff_sql],
    [exp.DateStrToDate, datestrtodate_sql],
    [exp.DateSub, _add_date_sql],
    [exp.DateToDi, (self, e) => `CAST(DATE_FORMAT(${self.sql(e, "this")}, ${HIVE_DATEINT_FORMAT}) AS INT)`],
    [exp.DiToDate, (self, e) => `TO_DATE(CAST(${self.sql(e, "this")} AS STRING), ${HIVE_DATEINT_FORMAT})`],
    [exp.StorageHandlerProperty, (self, e) => `STORED BY ${self.sql(e, "this")}`],
    [exp.FromBase64, rename_func("UNBASE64")],
    [exp.GenerateSeries, sequence_sql],
    [exp.GenerateDateArray, sequence_sql],
    [exp.If, if_sql()],
    [exp.ILike, no_ilike_sql],
    [exp.IntDiv, (self, e) => self.binary(e, "DIV")],
    [exp.IsNan, rename_func("ISNAN")],
    [exp.JSONExtract, (self, e) => self.func("GET_JSON_OBJECT", e.this, e.expression)],
    [exp.JSONExtractScalar, (self, e) => self.func("GET_JSON_OBJECT", e.this, e.expression)],
    [exp.JSONFormat, rename_func("TO_JSON")],
    [exp.Left, left_to_substring_sql],
    [exp.Map, var_map_sql],
    [exp.Max, max_or_greatest],
    [exp.MD5Digest, (self, e) => self.func("UNHEX", self.func("MD5", e.this))],
    [exp.Min, min_or_least],
    [exp.MonthsBetween, (self, e) => self.func("MONTHS_BETWEEN", e.this, e.expression)],
    [exp.NotNullColumnConstraint, (_self, e) => (e.args.allow_null ? "" : "NOT NULL")],
    [exp.VarMap, var_map_sql],
    [
      exp.Create,
      preprocess([remove_unique_constraints, ctas_with_tmp_tables_to_create_tmp_view, move_schema_columns_to_partitioned_by]),
    ],
    [exp.Quantile, rename_func("PERCENTILE")],
    [exp.ApproxQuantile, rename_func("PERCENTILE_APPROX")],
    [exp.RegexpExtract, regexp_extract_sql],
    [exp.RegexpExtractAll, regexp_extract_sql],
    [exp.RegexpReplace, regexp_replace_sql],
    [exp.RegexpLike, (self, e) => self.binary(e, "RLIKE")],
    [exp.RegexpSplit, rename_func("SPLIT")],
    [exp.Right, right_to_substring_sql],
    [exp.SchemaCommentProperty, (self, e) => self.naked_property(e)],
    [exp.ArrayUniqueAgg, rename_func("COLLECT_SET")],
    [
      exp.Split,
      (self, e) => self.func("SPLIT", e.this, self.func("CONCAT", "'\\\\Q'", e.expression, "'\\\\E'")),
    ],
    [
      exp.Select,
      preprocess([
        eliminate_qualify,
        eliminate_distinct_on,
        (e) => unnest_to_explode(e, false),
        any_to_exists,
      ]),
    ],
    [
      exp.StrPosition,
      (self, e) => strposition_sql(self, e, { func_name: "LOCATE", supports_position: true }),
    ],
    [exp.StrToDate, _str_to_date_sql],
    [exp.StrToTime, _str_to_time_sql],
    [exp.StrToUnix, _str_to_unix_sql],
    [exp.StructExtract, struct_extract_sql],
    [exp.StarMap, rename_func("MAP")],
    [exp.Table, preprocess([unnest_generate_series])],
    [exp.TimeStrToDate, rename_func("TO_DATE")],
    [exp.TimeStrToTime, timestrtotime_sql],
    [exp.TimeStrToUnix, rename_func("UNIX_TIMESTAMP")],
    [exp.TimestampTrunc, (self, e) => self.func("TRUNC", e.this, weekstart_unit_to_str(self, e))],
    [exp.TimeToUnix, rename_func("UNIX_TIMESTAMP")],
    [exp.ToBase64, rename_func("BASE64")],
    [
      exp.TsOrDiToDi,
      (self, e) =>
        `CAST(SUBSTR(REPLACE(CAST(${self.sql(e, "this")} AS STRING), '-', ''), 1, 8) AS INT)`,
    ],
    [exp.TsOrDsAdd, _add_date_sql],
    [exp.TsOrDsDiff, _date_diff_sql],
    [exp.TsOrDsToDate, _to_date_sql],
    [exp.TryCast, no_trycast_sql],
    [exp.Trim, trim_sql],
    [exp.Unicode, rename_func("ASCII")],
    [exp.UnixToStr, (self, e) => self.func("FROM_UNIXTIME", e.this, time_format("hive")(self, e))],
    [exp.UnixToTime, _unix_to_time_sql],
    [exp.UnixToTimeStr, rename_func("FROM_UNIXTIME")],
    [exp.Unnest, rename_func("EXPLODE")],
    [exp.PartitionedByProperty, (self, e) => `PARTITIONED BY ${self.sql(e, "this")}`],
    [exp.NumberToStr, rename_func("FORMAT_NUMBER")],
    [exp.National, (self, e) => self.national_sql(e, "")],
    [exp.ClusteredColumnConstraint, (self, e) => `(${self.expressions(e, "this", { indent: false })})`],
    [exp.NonClusteredColumnConstraint, (self, e) => `(${self.expressions(e, "this", { indent: false })})`],
    [exp.NotForReplicationColumnConstraint, () => ""],
    [exp.OnProperty, () => ""],
    [exp.PartitionedByBucket, (self, e) => self.func("BUCKET", e.expression, e.this)],
    [exp.PartitionByTruncate, (self, e) => self.func("TRUNCATE", e.expression, e.this)],
    [exp.PrimaryKeyColumnConstraint, () => "PRIMARY KEY"],
    [exp.WeekOfYear, rename_func("WEEKOFYEAR")],
    [exp.DayOfMonth, rename_func("DAYOFMONTH")],
    [exp.DayOfWeek, rename_func("DAYOFWEEK")],
    [
      exp.Levenshtein,
      unsupported_args("ins_cost", "del_cost", "sub_cost", "max_dist")(rename_func("LEVENSHTEIN")),
    ],
  ]);

  static PROPERTIES_LOCATION = new Map([
    ...Generator.PROPERTIES_LOCATION,
    [exp.FileFormatProperty, exp.Properties.Location.POST_SCHEMA],
    [exp.PartitionedByProperty, exp.Properties.Location.POST_SCHEMA],
    [exp.VolatileProperty, exp.Properties.Location.UNSUPPORTED],
    [exp.WithDataProperty, exp.Properties.Location.UNSUPPORTED],
  ]);

  /** py:405 `TS_OR_DS_EXPRESSIONS: t.ClassVar = HIVE_TS_OR_DS_EXPRESSIONS`. */
  static TS_OR_DS_EXPRESSIONS = HIVE_TS_OR_DS_EXPRESSIONS;

  /** py:407 `IGNORE_NULLS_FUNCS: t.ClassVar = (exp.First, exp.Last, exp.FirstValue, exp.LastValue)`. */
  static IGNORE_NULLS_FUNCS = [exp.First, exp.Last, exp.FirstValue, exp.LastValue];

  /**
   * py:409 `format_time(self, expression, inverse_time_mapping=None, inverse_time_trie=None)`.
   * @param {exp.Expr} expression
   * @param {Map<string,string>|null} [inverse_time_mapping]
   * @param {*} [inverse_time_trie]
   * @returns {string|null}
   */
  format_time(expression, inverse_time_mapping = null, inverse_time_trie = null) {
    // Inferred property because this method is reused by other dialects under Hive
    const is_dialect_strict = this.dialect.TIME_MAPPING.get("MM") === "%mstrict";

    if (
      is_dialect_strict &&
      inverse_time_mapping === null &&
      PARSE_TIME_EXPRESSIONS.some((cls) => expression instanceof cls)
    ) {
      // Render a lenient %m/%d non-padded (M/d) so single-digit sources stay parseable
      return formatTime(
        _lenient_parse_format(this.sql(expression, "format")),
        this.dialect.INVERSE_TIME_MAPPING,
        this.dialect.INVERSE_TIME_TRIE,
      );
    }

    return super.format_time(expression, inverse_time_mapping, inverse_time_trie);
  }

  /**
   * py:432
   * @param {exp.IgnoreNulls} expression
   * @returns {string}
   */
  ignorenulls_sql(expression) {
    const this_ = expression.this;
    if (this.constructor.IGNORE_NULLS_FUNCS.some((cls) => this_ instanceof cls)) {
      return this.func(this_.constructor.sqlName(), this_.this, exp.true_());
    }
    return super.ignorenulls_sql(expression);
  }

  /**
   * py:439
   * @param {exp.Unnest} expression
   * @returns {string}
   */
  unnest_sql(expression) {
    return rename_func("EXPLODE")(this, expression);
  }

  /**
   * py:442
   * @param {exp.JSONPathKey} expression
   * @returns {string}
   */
  _jsonpathkey_sql(expression) {
    if (expression.this instanceof exp.JSONPathWildcard) {
      this.unsupported("Unsupported wildcard in JSONPathKey expression");
      return "";
    }

    return super._jsonpathkey_sql(expression);
  }

  /**
   * py:449
   * @param {exp.Parameter} expression
   * @returns {string}
   */
  parameter_sql(expression) {
    const this0 = this.sql(expression, "this");
    const expression_sql = this.sql(expression, "expression");

    const parent = expression.parent;
    const this_ = expression_sql ? `${this0}:${expression_sql}` : this0;

    if (parent instanceof exp.EQ && parent.parent instanceof exp.SetItem) {
      // We need to produce SET key = value instead of SET ${key} = value
      return this_;
    }

    return `\${${this_}}`;
  }

  /**
   * py:462
   * @param {exp.Schema} expression
   * @returns {string}
   */
  schema_sql(expression) {
    for (const ordered of [...expression.findAll(exp.Ordered)]) {
      if (ordered.args.desc === false) ordered.set("desc", null);
    }

    return super.schema_sql(expression);
  }

  /**
   * py:469
   * @param {exp.Constraint} expression
   * @returns {string}
   */
  constraint_sql(expression) {
    for (const prop of [...expression.findAll(exp.Properties)]) prop.pop();

    const this_ = this.sql(expression, "this");
    const expressions = this.expressions(expression, null, { sep: " ", flat: true });
    return `CONSTRAINT ${this_} ${expressions}`;
  }

  /**
   * py:477
   * @param {exp.RowFormatSerdeProperty} expression
   * @returns {string}
   */
  rowformatserdeproperty_sql(expression) {
    let serde_props = this.sql(expression, "serde_properties");
    serde_props = serde_props ? ` ${serde_props}` : "";
    return `ROW FORMAT SERDE ${this.sql(expression, "this")}${serde_props}`;
  }

  /**
   * py:482
   * @param {exp.ArrayAgg} expression
   * @returns {string}
   */
  arrayagg_sql(expression) {
    return this.func(
      "COLLECT_LIST",
      expression.this instanceof exp.Order ? expression.this.this : expression.this,
    );
  }

  /**
   * py:490-493 "Hive/Spark lack native numeric TRUNC. CAST to BIGINT truncates toward
   * zero (not rounds)." `@unsupported_args("decimals") def trunc_sql`, same
   * bound-method-vs-TRANSFORMS-value shim shape `generators/snowflake.js`'s
   * `approxquantile_sql`/`_approxquantile_sql` pair already established.
   * @param {exp.Trunc} expression
   * @returns {string}
   */
  trunc_sql(expression) {
    return _trunc_sql(this, expression);
  }

  /**
   * py:495
   * @param {exp.DataType} expression
   * @returns {string}
   */
  datatype_sql(expression) {
    if (
      this.constructor.PARAMETERIZABLE_TEXT_TYPES.has(expression.this) &&
      (!expression.expressions.length || expression.expressions[0].name === "MAX")
    ) {
      expression.set("this", exp.DType.TEXT);
      expression.set("expressions", null);
    } else if (expression.isType(exp.DType.TEXT) && expression.expressions.length) {
      expression.set("this", exp.DType.VARCHAR);
    } else if (exp.DataType.TEMPORAL_TYPES.has(expression.this)) {
      expression.set("expressions", null);
    } else if (expression.isType("float")) {
      const size_expression = expression.find(exp.DataTypeParam);
      if (size_expression) {
        const size = Number(pyIntFromStr(size_expression.name));
        expression.set("this", size <= 32 ? exp.DType.FLOAT : exp.DType.DOUBLE);
        expression.set("expressions", null);
      }
    }
    return super.datatype_sql(expression);
  }

  /**
   * py:513
   * @param {exp.Version} expression
   * @returns {string}
   */
  version_sql(expression) {
    const sql = super.version_sql(expression);
    return sql.replace("FOR ", "");
  }

  /**
   * py:517
   * @param {exp.Struct} expression
   * @returns {string}
   */
  struct_sql(expression) {
    const values = [];

    for (const e of expression.expressions) {
      if (e instanceof exp.PropertyEQ) {
        this.unsupported("Hive does not support named structs.");
        values.push(e.expression);
      } else {
        values.push(e);
      }
    }

    return this.func("STRUCT", ...values);
  }

  /**
   * py:529 `columndef_sql(self, expression, sep=" ")`.
   * @param {exp.ColumnDef} expression
   * @param {string} [sep]
   * @returns {string}
   */
  columndef_sql(expression, sep = " ") {
    return super.columndef_sql(
      expression,
      expression.parent instanceof exp.DataType && expression.parent.isType("struct") ? ": " : sep,
    );
  }

  /**
   * py:540
   * @param {exp.AlterColumn} expression
   * @returns {string}
   */
  altercolumn_sql(expression) {
    if (expression.args.exists) {
      this.unsupported("ALTER COLUMN IF EXISTS is not supported by this dialect");
    }

    const this_ = this.sql(expression, "this");
    const new_name = this.sql(expression, "rename_to") || this_;
    const dtype = this.sql(expression, "dtype");
    const comment_sql = this.sql(expression, "comment");
    const comment = comment_sql ? ` COMMENT ${comment_sql}` : "";
    const default_ = this.sql(expression, "default");
    const visible = expression.args.visible;
    const allow_null = expression.args.allow_null;
    const drop = expression.args.drop;

    if ([default_, drop, visible].some(Boolean) || allow_null !== null) {
      this.unsupported("Unsupported CHANGE COLUMN syntax");
    }

    if (!dtype) {
      this.unsupported("CHANGE COLUMN without a type is not supported");
    }

    return `CHANGE COLUMN ${this_} ${new_name} ${dtype}${comment}`;
  }

  /**
   * py:563
   * @param {exp.RenameColumn} _expression
   * @returns {string}
   */
  renamecolumn_sql(_expression) {
    this.unsupported("Cannot rename columns without data type defined in Hive");
    return "";
  }

  /**
   * py:567
   * @param {exp.AlterSet} expression
   * @returns {string}
   */
  alterset_sql(expression) {
    const exprs_ = this.expressions(expression, null, { flat: true });
    const exprs = exprs_ ? ` ${exprs_}` : "";
    const location_ = this.sql(expression, "location");
    const location = location_ ? ` LOCATION ${location_}` : "";
    const file_format_ = this.expressions(expression, "file_format", { flat: true, sep: " " });
    const file_format = file_format_ ? ` FILEFORMAT ${file_format_}` : "";
    const serde_ = this.sql(expression, "serde");
    const serde = serde_ ? ` SERDE ${serde_}` : "";
    const tags_ = this.expressions(expression, "tag", { flat: true, sep: "" });
    const tags = tags_ ? ` TAGS ${tags_}` : "";

    return `SET${serde}${exprs}${location}${file_format}${tags}`;
  }

  /**
   * py:581
   * @param {exp.SerdeProperties} expression
   * @returns {string}
   */
  serdeproperties_sql(expression) {
    const prefix = expression.args.with_ ? "WITH " : "";
    const exprs = this.expressions(expression, null, { flat: true });

    return `${prefix}SERDEPROPERTIES (${exprs})`;
  }

  /**
   * py:587
   * @param {exp.Exists} expression
   * @returns {string}
   */
  exists_sql(expression) {
    if (expression.expression) return this.function_fallback_sql(expression);

    return super.exists_sql(expression);
  }

  /**
   * py:593
   * @param {exp.TimeToStr} expression
   * @returns {string}
   */
  timetostr_sql(expression) {
    let this_ = expression.this;
    if (this_ instanceof exp.TimeStrToTime) this_ = this_.this;

    return this.func("DATE_FORMAT", this_, this.format_time(expression));
  }

  /**
   * py:600
   * @param {exp.UsingProperty} expression
   * @returns {string}
   */
  usingproperty_sql(expression) {
    // deny:implicit_str sqlglot/generators/hive.py:602 — `kind` reads as an Expr arg to
    // the static scanner, but `parsers/hive.py:245`'s only builder
    // (`_parse_using_property`) always sets it to `self._prev.text.upper()`, a plain
    // token-text STRING, never an Expr — verified against the parser, not assumed; a
    // bare template literal is correct here.
    const kind = expression.args.kind;
    return `USING ${kind} ${this.sql(expression, "this")}`;
  }

  /**
   * py:604
   * @param {exp.FileFormatProperty} expression
   * @returns {string}
   */
  fileformatproperty_sql(expression) {
    let this_;
    if (expression.this instanceof exp.InputOutputFormat) {
      this_ = this.sql(expression, "this");
    } else {
      this_ = expression.name.toUpperCase();
    }

    return `STORED AS ${this_}`;
  }
}

// py:491 `@unsupported_args("decimals") def trunc_sql(self, expression)` — the
// `unsupported_args`-wrapped body itself, in the same 2-explicit-arg shape every
// other TRANSFORMS-value callable in this file uses (R27), with `trunc_sql` above as
// its thin `this`-forwarding class-method shim — the identical split
// `generators/snowflake.js` uses for `approxquantile_sql`/`_approxquantile_sql`.
const _trunc_sql = unsupported_args("decimals")((self, expression) =>
  self.sql(exp.cast(expression.this, exp.DType.BIGINT)),
);
