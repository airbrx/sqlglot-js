// py: sqlglot/generators/snowflake.py — `class SnowflakeGenerator(generator.Generator)`.
//
// @ported-ranges sqlglot/generators/snowflake.py 1-43 62-118 203-1222
//
// Five upstream ranges are excluded, each a module-level helper reachable ONLY through
// one of the five still-blocked `TRANSFORMS` entries this file's header explains below
// (`sqlglot/transforms.py` functions not yet ported, and/or `sqlglot/optimizer/scope.py`,
// unported):
//   44-61   _build_datediff, _build_date_time_add       (-> _unnest_generate_date_array)
//   75-99   _unqualify_pivot_columns                     (-> exp.Pivot)
//   119-178 _unnest_generate_date_array                  (-> _transform_generate_date_array)
//   179-202 _transform_generate_date_array                (-> exp.Select)
//   246-341 _qualify_unnested_columns                     (-> exp.Select)
//   342-375 _eliminate_dot_variant_lookup                 (-> exp.Select)
// (100-118, `_flatten_structured_types_unless_iceberg`, is now PORTED — see below.)
// Porting any of the remaining five would be dead code with no caller. Checked against
// `corpus/deny/{operators,implicit_str}.json`: none of them carries a deny-listed site,
// so excluding them does not silently skip an unacknowledged one.
//
// The other big half of the Snowflake port (the small half is `src/dialects/snowflake.js`,
// settings only). This file mirrors the file-layout precedent already established for
// this dialect: `parsers/snowflake.js` (grammar), `dialects/snowflake.js` (Dialect
// settings class), and this file (Generator settings + overrides) are three separate,
// non-comingled directories, matching upstream's own three separate files.
//
// FIVE `TRANSFORMS` ENTRIES ARE STILL NOT PORTED, EACH WITH A LIVE POINTER
// --------------------------------------------------------------------------
// `exp.Array`, `exp.PercentileCont`, `exp.PercentileDisc`, `exp.Pivot`, and `exp.Select`
// all route through `transforms.preprocess([...])` upstream. `src/transforms.js`
// landed on a parallel branch (PORT_PLAN.md R26) with `preprocess` plus
// `eliminate_distinct_on`/`eliminate_qualify`/`eliminate_semi_and_anti_joins` — enough
// to unblock `exp.Create` (ported below, using this file's own
// `_flatten_structured_types_unless_iceberg`), but not the other five: `exp.Array`
// needs `transforms.inherit_struct_field_names` (unported), `exp.PercentileCont`/
// `PercentileDisc` need `transforms.add_within_group_for_percentiles` (unported),
// `exp.Pivot`'s own `_unqualify_pivot_columns` needs `transforms.unqualify_columns`
// (unported), and `exp.Select` needs `transforms.eliminate_window_clause` +
// `transforms.explode_projection_to_unnest` (both unported) PLUS
// `sqlglot/optimizer/scope.py`'s `build_scope`/`find_all_in_scope` (unported, P6+) for
// its own three local helpers. Each remaining blocked entry is commented out at its
// upstream anchor, exactly like base `Generator`'s own still-unseeded `TRANSFORMS`
// lines (`src/generator.js`'s `// py:138 [exp.Adjacent, /* TODO lambda */]`
// convention) — so this file's line count under-claims rather than growing dead code.
//
// This is also why `SnowflakeGenerator.select_sql`'s own override (py:1007, ported
// below) still routes through a `TRANSFORMS`-less `super().select_sql()`: the
// dispatch-precedence rule (`TRANSFORMS` beats `*_sql`, `src/generator.js`'s
// `_buildDispatch`) means the *_sql override IS reachable today, it just cannot yet
// apply the seven preprocessing passes upstream's `Select` TRANSFORMS entry chains in
// front of it.

import { NotPorted } from "../errors.js";
import { seqGet } from "../helper.js";
import { preprocess } from "../transforms.js";
import * as exp from "../expressions/index.js";
import { TokenType } from "../tokens.js";
import { Generator, unsupported_args } from "../generator.js";
import {
  array_append_sql,
  array_concat_sql,
  date_delta_sql,
  datestrtodate_sql,
  groupconcat_sql,
  if_sql,
  inline_array_sql,
  map_date_part,
  max_or_greatest,
  min_or_least,
  no_make_interval_sql,
  no_timestamp_sql,
  nth_value_from_sql,
  rename_func,
  strposition_sql,
  timestampdiff_sql,
  timestamptrunc_sql,
  timestrtotime_sql,
  unit_to_str,
  var_map_sql,
} from "../dialects/dialect.js";
import {
  RANKING_WINDOW_FUNCTIONS_WITH_FRAME,
  SnowflakeParser,
  TIMESTAMP_TYPES,
  build_object_construct,
} from "../parsers/snowflake.js";

// py:44 `_build_datediff` and py:53 `_build_date_time_add` — both are ONLY called from
// `_unnest_generate_date_array` (py:119, blocked on `sqlglot/optimizer/scope.py`'s
// `build_scope`, unported). Not ported: they would be dead code with no caller, the
// same reasoning as the other five module-level helpers this file leaves as anchored
// comments rather than unreachable functions.

/** py: sqlglot/generators/snowflake.py:64 */
function _regexpilike_sql(self, expression) {
  let flag = expression.text("flag");

  if (!flag.includes("i")) flag += "i";

  return self.func("REGEXP_LIKE", expression.this, expression.expression, exp.Literal.string(flag));
}

// py:75 `_unqualify_pivot_columns` — blocked on `transforms.unqualify_columns`
// (sqlglot/transforms.py, unported, parallel branch). The only caller is the
// `exp.Pivot` TRANSFORMS entry below, itself commented out for the same reason.

/**
 * py: sqlglot/generators/snowflake.py:100
 *
 * Was blocked pending `transforms.preprocess` (the only thing wrapping this in the
 * `exp.Create` TRANSFORMS entry); `src/transforms.js` landed with `preprocess` ported
 * (PORT_PLAN.md R26), and this function's own body has no OTHER unported dependency,
 * so it is real now.
 */
function _flatten_structured_types_unless_iceberg(expression) {
  function _flatten_structured_type(node) {
    if (node instanceof exp.DataType && exp.DataType.NESTED_TYPES.has(node.this)) {
      node.set("expressions", null);
    }
    return node;
  }

  const props = expression.args.properties;
  if (
    expression.this instanceof exp.Schema &&
    !(props && props.find(exp.IcebergProperty))
  ) {
    for (const schema_expression of expression.this.expressions) {
      if (schema_expression instanceof exp.ColumnDef) {
        const column_type = schema_expression.args.kind;
        if (column_type instanceof exp.DataType) {
          column_type.transform(_flatten_structured_type, { copy: false });
        }
      }
    }
  }

  return expression;
}

// py:119 `_unnest_generate_date_array` — blocked on `sqlglot/optimizer/scope.py`'s
// `build_scope` (unported, P6+). Only caller is `_transform_generate_date_array` below.

// py:179 `_transform_generate_date_array` — blocked transitively via
// `_unnest_generate_date_array`. Only caller is the `exp.Select` TRANSFORMS entry.

/** py: sqlglot/generators/snowflake.py:203 */
function _regexpextract_sql(self, expression) {
  // Other dialects don't support all of the following parameters, so we need to
  // generate default values as necessary to ensure the transpilation is correct
  let group = expression.args.group;

  // To avoid generating all these default values, we set group to None if
  // it's 0 (also default value) which doesn't trigger the following chain
  if (group && group.name === "0") group = null;

  const parameters = expression.args.parameters || (group && exp.Literal.string("c"));
  const occurrence = expression.args.occurrence || (parameters && exp.Literal.number(1));
  const position = expression.args.position || (occurrence && exp.Literal.number(1));

  return self.func(
    expression instanceof exp.RegexpExtract ? "REGEXP_SUBSTR" : "REGEXP_SUBSTR_ALL",
    expression.this,
    expression.expression,
    position,
    occurrence,
    parameters,
    group,
  );
}

/** py: sqlglot/generators/snowflake.py:230 */
function _json_extract_value_array_sql(self, expression) {
  const json_extract = new exp.JSONExtract({ this: expression.this, expression: expression.expression });
  const ident = exp.toIdentifier("x");

  let this_;
  if (expression instanceof exp.JSONValueArray) {
    this_ = exp.cast(ident, exp.DType.VARCHAR);
  } else {
    // deny:implicit_str sqlglot/generators/snowflake.py:239 — f-string on an Expr calls
    // Python's implicit `str(ident)` == `ident.sql()`; a bare JS template literal would
    // call `.toString()` (this port's verbose `to_s`/repr), not `.sql()`, so the call is
    // explicit (same trap R21 already found once).
    this_ = new exp.ParseJSON({ this: `TO_JSON(${ident.sql()})` });
  }

  const transform_lambda = new exp.Lambda({ expressions: [ident], this: this_ });

  return self.func("TRANSFORM", json_extract, transform_lambda);
}

// py:246 `_qualify_unnested_columns` — blocked on `sqlglot/optimizer/scope.py`'s
// `build_scope` (unported, P6+). Only caller is the `exp.Select` TRANSFORMS entry.

// py:342 `_eliminate_dot_variant_lookup` — blocked on `sqlglot/optimizer/scope.py`'s
// `find_all_in_scope` (unported, P6+). Only caller is the `exp.Select` TRANSFORMS entry.

/**
 * py: sqlglot/expressions/aggregate.py:223 `PERCENTILES = (PercentileCont, PercentileDisc)`.
 * A different upstream file's module constant, needed only for `filter_sql`'s
 * `isinstance(agg_arg, (exp.Mode, *exp.PERCENTILES))` check below; scoped locally
 * rather than standing up the whole of `aggregate.py` for a 2-element tuple.
 */
const PERCENTILES = [exp.PercentileCont, exp.PercentileDisc];

/** py: sqlglot/generators/snowflake.py:376 `class SnowflakeGenerator(generator.Generator)`. */
export class SnowflakeGenerator extends Generator {
  static SELECT_KINDS = [];
  static PARAMETER_TOKEN = "$";
  static MATCHED_BY_SOURCE = false;
  static SINGLE_STRING_INTERVAL = true;
  static JOIN_HINTS = false;
  static TABLE_HINTS = false;
  static QUERY_HINTS = false;
  static SUPPORTS_TABLE_COPY = false;
  static COLLATE_IS_FUNC = true;
  static LIMIT_ONLY_LITERALS = true;
  static JSON_KEY_VALUE_PAIR_SEP = ",";
  static INSERT_OVERWRITE = " OVERWRITE INTO";
  static STRUCT_DELIMITER = ["(", ")"];
  static COPY_PARAMS_ARE_WRAPPED = false;
  static COPY_PARAMS_EQ_REQUIRED = true;
  static STAR_EXCEPT = "EXCLUDE";
  static SUPPORTS_EXPLODING_PROJECTIONS = false;
  static ARRAY_CONCAT_IS_VAR_LEN = false;
  static SUPPORTS_CONVERT_TIMEZONE = true;
  static EXCEPT_INTERSECT_SUPPORT_ALL_CLAUSE = false;
  static SUPPORTS_MEDIAN = true;
  static ARRAY_SIZE_NAME = "ARRAY_SIZE";
  static SUPPORTS_DECODE_CASE = true;

  /** py:401 `AFTER_HAVING_MODIFIER_TRANSFORMS = generator.AFTER_HAVING_MODIFIER_TRANSFORMS` */
  static AFTER_HAVING_MODIFIER_TRANSFORMS = Generator.AFTER_HAVING_MODIFIER_TRANSFORMS;

  static IS_BOOL_ALLOWED = false;
  static DIRECTED_JOINS = true;
  static SUPPORTS_UESCAPE = false;
  static TRY_SUPPORTED = false;

  /** py:408 */
  static TRANSFORMS = new Map([
    ...Generator.TRANSFORMS,
    [exp.ApproxDistinct, rename_func("APPROX_COUNT_DISTINCT")],
    [exp.ArgMax, rename_func("MAX_BY")],
    [exp.ArgMin, rename_func("MIN_BY")],
    // py:413 [exp.Array, transforms.preprocess([transforms.inherit_struct_field_names])] — blocked, transforms.js
    [exp.ArrayConcat, array_concat_sql("ARRAY_CAT")],
    [exp.ArrayAppend, array_append_sql("ARRAY_APPEND")],
    [exp.ArrayPrepend, array_append_sql("ARRAY_PREPEND")],
    [
      exp.ArrayContains,
      (self, e) =>
        self.func(
          "ARRAY_CONTAINS",
          e.args.ensure_variant === false ? e.expression : exp.cast(e.expression, exp.DType.VARIANT, { copy: false }),
          e.this,
        ),
    ],
    [exp.ArrayPosition, (self, e) => self.func("ARRAY_POSITION", e.expression, e.this)],
    [exp.ArrayIntersect, rename_func("ARRAY_INTERSECTION")],
    [exp.ArrayOverlaps, rename_func("ARRAYS_OVERLAP")],
    [exp.AtTimeZone, (self, e) => self.func("CONVERT_TIMEZONE", e.args.zone, e.this)],
    [exp.BitwiseOr, rename_func("BITOR")],
    [exp.BitwiseXor, rename_func("BITXOR")],
    [exp.BitwiseAnd, rename_func("BITAND")],
    [exp.BitwiseAndAgg, rename_func("BITANDAGG")],
    [exp.BitwiseOrAgg, rename_func("BITORAGG")],
    [exp.BitwiseXorAgg, rename_func("BITXORAGG")],
    [exp.BitwiseNot, rename_func("BITNOT")],
    [exp.BitwiseLeftShift, rename_func("BITSHIFTLEFT")],
    [exp.BitwiseRightShift, rename_func("BITSHIFTRIGHT")],
    [exp.Create, preprocess([_flatten_structured_types_unless_iceberg])],
    [
      exp.CurrentTimestamp,
      (self, e) => (e.args.sysdate ? self.func("SYSDATE") : self.function_fallback_sql(e)),
    ],
    [exp.CurrentSchemas, (self) => self.func("CURRENT_SCHEMAS")],
    [exp.Localtime, (self, e) => (e.this ? self.func("CURRENT_TIME", e.this) : "CURRENT_TIME")],
    [
      exp.Localtimestamp,
      (self, e) => (e.this ? self.func("CURRENT_TIMESTAMP", e.this) : "CURRENT_TIMESTAMP"),
    ],
    [exp.DateAdd, date_delta_sql("DATEADD")],
    [exp.DateDiff, date_delta_sql("DATEDIFF")],
    [exp.DatetimeAdd, date_delta_sql("TIMESTAMPADD")],
    [exp.DatetimeDiff, timestampdiff_sql],
    [exp.DateStrToDate, datestrtodate_sql],
    [
      exp.Decrypt,
      (self, e) =>
        self.func(
          `${e.args.safe ? "TRY_" : ""}DECRYPT`,
          e.this,
          e.args.passphrase,
          e.args.aad,
          e.args.encryption_method,
        ),
    ],
    [
      exp.DecryptRaw,
      (self, e) =>
        self.func(
          `${e.args.safe ? "TRY_" : ""}DECRYPT_RAW`,
          e.this,
          e.args.key,
          e.args.iv,
          e.args.aad,
          e.args.encryption_method,
          e.args.aead,
        ),
    ],
    [exp.DayOfMonth, rename_func("DAYOFMONTH")],
    [exp.DayOfWeek, rename_func("DAYOFWEEK")],
    [exp.DayOfWeekIso, rename_func("DAYOFWEEKISO")],
    [exp.DayOfYear, rename_func("DAYOFYEAR")],
    [exp.DotProduct, rename_func("VECTOR_INNER_PRODUCT")],
    [exp.Explode, rename_func("FLATTEN")],
    [
      exp.Extract,
      (self, e) => self.func("DATE_PART", map_date_part(e.this, self.dialect), e.expression),
    ],
    [exp.CosineDistance, rename_func("VECTOR_COSINE_SIMILARITY")],
    [exp.EuclideanDistance, rename_func("VECTOR_L2_DISTANCE")],
    [exp.HandlerProperty, (self, e) => `HANDLER = ${self.sql(e, "this")}`],
    [
      exp.FileFormatProperty,
      (self, e) => `FILE_FORMAT=(${self.expressions(e, "expressions", { sep: " " })})`,
    ],
    [
      exp.FromTimeZone,
      (self, e) => self.func("CONVERT_TIMEZONE", e.args.zone, "'UTC'", e.this),
    ],
    [
      exp.GenerateSeries,
      (self, e) =>
        self.func(
          "ARRAY_GENERATE_RANGE",
          e.args.start,
          // deny:operators sqlglot/generators/snowflake.py:494 — Python `+` on an Expr
          // (`__add__`) builds `exp.Add`; `.add()` is this port's `_binop` equivalent.
          e.args.is_end_exclusive ? e.args.end : e.args.end.add(exp.Literal.number(1)),
          e.args.step,
        ),
    ],
    [exp.GetExtract, rename_func("GET")],
    [exp.GroupConcat, (self, e) => groupconcat_sql(self, e, { sep: "" })],
    [exp.If, if_sql("IFF", "NULL")],
    [exp.JSONArray, (self, e) => self.func("TO_VARIANT", self.func("ARRAY_CONSTRUCT", ...e.expressions))],
    [exp.JSONExtractArray, _json_extract_value_array_sql],
    [exp.JSONExtractScalar, (self, e) => self.func("JSON_EXTRACT_PATH_TEXT", e.this, e.expression)],
    [exp.JSONKeys, rename_func("OBJECT_KEYS")],
    [exp.JSONObject, (self, e) => self.func("OBJECT_CONSTRUCT_KEEP_NULL", ...e.expressions)],
    [exp.JSONPathRoot, () => ""],
    [exp.JSONValueArray, _json_extract_value_array_sql],
    [
      exp.Levenshtein,
      unsupported_args("ins_cost", "del_cost", "sub_cost")(rename_func("EDITDISTANCE")),
    ],
    [exp.LocationProperty, (self, e) => `LOCATION=${self.sql(e, "this")}`],
    [exp.LogicalAnd, rename_func("BOOLAND_AGG")],
    [exp.LogicalOr, rename_func("BOOLOR_AGG")],
    [exp.Map, (self, e) => var_map_sql(self, e, "OBJECT_CONSTRUCT")],
    [exp.ManhattanDistance, rename_func("VECTOR_L1_DISTANCE")],
    [exp.MakeInterval, no_make_interval_sql],
    [exp.Max, max_or_greatest],
    [exp.Min, min_or_least],
    [exp.NthValue, nth_value_from_sql],
    [
      exp.ParseJSON,
      (self, e) => self.func(`${e.args.safe ? "TRY_" : ""}PARSE_JSON`, e.this),
    ],
    [
      exp.ToBinary,
      (self, e) => self.func(`${e.args.safe ? "TRY_" : ""}TO_BINARY`, e.this, e.args.format),
    ],
    [exp.ToBoolean, (self, e) => self.func(`${e.args.safe ? "TRY_" : ""}TO_BOOLEAN`, e.this)],
    [
      exp.ToDouble,
      (self, e) => self.func(`${e.args.safe ? "TRY_" : ""}TO_DOUBLE`, e.this, e.args.format),
    ],
    [exp.ToFile, (self, e) => self.func(`${e.args.safe ? "TRY_" : ""}TO_FILE`, e.this, e.args.path)],
    [exp.JSONFormat, rename_func("TO_JSON")],
    [exp.PartitionedByProperty, (self, e) => `PARTITION BY ${self.sql(e, "this")}`],
    // py:540 [exp.PercentileCont, transforms.preprocess([transforms.add_within_group_for_percentiles])] — blocked, transforms.js
    // py:541 [exp.PercentileDisc, transforms.preprocess([transforms.add_within_group_for_percentiles])] — blocked, transforms.js
    // py:542 [exp.Pivot, transforms.preprocess([_unqualify_pivot_columns])] — blocked, transforms.js
    [exp.RegexpExtract, _regexpextract_sql],
    [exp.RegexpExtractAll, _regexpextract_sql],
    [exp.RegexpILike, _regexpilike_sql],
    [exp.RowAccessProperty, (self, e) => self.rowaccessproperty_sql(e)],
    // py:547 [exp.Select, transforms.preprocess([...7 fns...])] — blocked, transforms.js + optimizer/scope.js
    [exp.SHA, rename_func("SHA1")],
    [exp.SHA1Digest, rename_func("SHA1_BINARY")],
    [exp.MD5Digest, rename_func("MD5_BINARY")],
    [exp.MD5NumberLower64, rename_func("MD5_NUMBER_LOWER64")],
    [exp.MD5NumberUpper64, rename_func("MD5_NUMBER_UPPER64")],
    [exp.Hex, rename_func("HEX_ENCODE")],
    [exp.LowerHex, rename_func("TO_CHAR")],
    [exp.Skewness, rename_func("SKEW")],
    [exp.StarMap, rename_func("OBJECT_CONSTRUCT")],
    [exp.StartsWith, rename_func("STARTSWITH")],
    [exp.EndsWith, rename_func("ENDSWITH")],
    [exp.Rand, (self, e) => self.func("RANDOM", e.this)],
    [
      exp.StrPosition,
      (self, e) => strposition_sql(self, e, { func_name: "CHARINDEX", supports_position: true }),
    ],
    [exp.StrToDate, (self, e) => self.func("DATE", e.this, self.format_time(e))],
    [exp.StringToArray, rename_func("STRTOK_TO_ARRAY")],
    [exp.StrtokToArray, rename_func("STRTOK_TO_ARRAY")],
    [exp.Stuff, rename_func("INSERT")],
    [exp.StPoint, rename_func("ST_MAKEPOINT")],
    [exp.TimeAdd, date_delta_sql("TIMEADD")],
    [
      exp.TimeSlice,
      (self, e) => self.func("TIME_SLICE", e.this, e.expression, unit_to_str(e), e.args.kind),
    ],
    [exp.Timestamp, no_timestamp_sql],
    [exp.TimestampAdd, date_delta_sql("TIMESTAMPADD")],
    [
      exp.TimestampDiff,
      (self, e) => self.func("TIMESTAMPDIFF", e.args.unit, e.expression, e.this),
    ],
    [exp.TimestampTrunc, timestamptrunc_sql()],
    [exp.TimeStrToTime, timestrtotime_sql],
    [exp.TimeToUnix, (self, e) => `EXTRACT(epoch_second FROM ${self.sql(e, "this")})`],
    [exp.ToArray, rename_func("TO_ARRAY")],
    [exp.ToChar, (self, e) => self.function_fallback_sql(e)],
    [exp.TsOrDsAdd, date_delta_sql("DATEADD", true)],
    [exp.TsOrDsDiff, date_delta_sql("DATEDIFF")],
    [
      exp.TsOrDsToDate,
      (self, e) => self.func(`${e.args.safe ? "TRY_" : ""}TO_DATE`, e.this, self.format_time(e)),
    ],
    [
      exp.TsOrDsToTime,
      (self, e) => self.func(`${e.args.safe ? "TRY_" : ""}TO_TIME`, e.this, self.format_time(e)),
    ],
    [exp.Unhex, rename_func("HEX_DECODE_BINARY")],
    [exp.UnixToTime, (self, e) => self.func("TO_TIMESTAMP", e.this, e.args.scale)],
    [exp.Uuid, rename_func("UUID_STRING")],
    [exp.VarMap, (self, e) => var_map_sql(self, e, "OBJECT_CONSTRUCT")],
    [exp.Booland, rename_func("BOOLAND")],
    [exp.Boolor, rename_func("BOOLOR")],
    [exp.WeekOfYear, rename_func("WEEKISO")],
    [exp.YearOfWeek, rename_func("YEAROFWEEK")],
    [exp.YearOfWeekIso, rename_func("YEAROFWEEKISO")],
    [exp.Xor, rename_func("BOOLXOR")],
    [exp.ByteLength, rename_func("OCTET_LENGTH")],
    [exp.Flatten, rename_func("ARRAY_FLATTEN")],
    [
      exp.ArrayConcatAgg,
      (self, e) => self.func("ARRAY_FLATTEN", new exp.ArrayAgg({ this: e.this })),
    ],
    [
      exp.SHA2Digest,
      (self, e) => self.func("SHA2_BINARY", e.this, e.args.length || exp.Literal.number(256)),
    ],
  ]);

  /** py:620 */
  dynamicidentifier_sql(expression) {
    const this_ = this.func("IDENTIFIER", expression.this);
    if ("expressions" in expression.args) {
      // `IDENTIFIER(...)` invoked as a function, e.g. `IDENTIFIER('my_func')(1, 2)`
      return this.func(this_, ...expression.expressions, { normalize: false });
    }
    return this_;
  }

  /** py:627 */
  sortarray_sql(expression) {
    const asc = expression.args.asc;
    const nulls_first = expression.args.nulls_first;
    let nf = nulls_first;
    if (asc?.equals?.(exp.false_()) && nulls_first?.equals?.(exp.true_())) {
      nf = null;
    }
    return this.func("ARRAY_SORT", expression.this, asc, nf);
  }

  /** py:634 */
  static SUPPORTED_JSON_PATH_PARTS = new Set([exp.JSONPathKey, exp.JSONPathRoot, exp.JSONPathSubscript]);

  /** py:640 */
  static TYPE_MAPPING = new Map([
    ...Generator.TYPE_MAPPING,
    [exp.DType.BIGDECIMAL, "DOUBLE"],
    [exp.DType.JSON, "VARIANT"],
    [exp.DType.NESTED, "OBJECT"],
    [exp.DType.STRUCT, "OBJECT"],
    [exp.DType.TEXT, "VARCHAR"],
  ]);

  /** py:649 */
  static TOKEN_MAPPING = new Map([[TokenType.AUTO_INCREMENT, "AUTOINCREMENT"]]);

  /** py:653 */
  static PROPERTIES_LOCATION = new Map([
    ...Generator.PROPERTIES_LOCATION,
    [exp.CredentialsProperty, exp.Properties.Location.POST_WITH],
    [exp.LocationProperty, exp.Properties.Location.POST_WITH],
    [exp.PartitionedByProperty, exp.Properties.Location.POST_SCHEMA],
    [exp.RowAccessProperty, exp.Properties.Location.POST_SCHEMA],
    [exp.SetProperty, exp.Properties.Location.UNSUPPORTED],
    [exp.VolatileProperty, exp.Properties.Location.UNSUPPORTED],
  ]);

  /** py:663 */
  static UNSUPPORTED_VALUES_EXPRESSIONS = new Set([exp.Map, exp.StarMap, exp.Struct, exp.VarMap]);

  /** py:670 */
  static RESPECT_IGNORE_NULLS_UNSUPPORTED_EXPRESSIONS = [exp.ArrayAgg];

  /** py:672 */
  with_properties(properties) {
    return this.properties(properties, { wrapped: false, prefix: this.sep(""), sep: " " });
  }

  /** py:675 */
  values_sql(expression, values_as_table = true) {
    if (expression.find(...this.constructor.UNSUPPORTED_VALUES_EXPRESSIONS)) {
      values_as_table = false;
    }
    return super.values_sql(expression, values_as_table);
  }

  /** py:681 */
  datatype_sql(expression) {
    // Check if this is a FLOAT type nested inside a VECTOR type
    // VECTOR only accepts FLOAT (not DOUBLE), INT, and STRING as element types
    // https://docs.snowflake.com/en/sql-reference/data-types-vector
    if (expression.isType(exp.DType.DOUBLE)) {
      const parent = expression.parent;
      if (parent instanceof exp.DataType && parent.isType(exp.DType.VECTOR)) {
        // Preserve FLOAT for VECTOR types instead of mapping to synonym DOUBLE
        return "FLOAT";
      }
    }

    const expressions = expression.expressions;
    if (expressions?.length && expression.isType(...exp.DataType.STRUCT_TYPES)) {
      for (const field_type of expressions) {
        // The correct syntax is OBJECT [ (<key> <value_type [NOT NULL] [, ...]) ]
        if (field_type instanceof exp.DataType) return "OBJECT";
        if (field_type instanceof exp.ColumnDef && field_type.this && field_type.this.is_string) {
          // Doing OBJECT('foo' VARCHAR) is invalid snowflake Syntax. Moreover, besides
          // converting 'foo' into an identifier, we also need to quote it because these
          // keys are case-sensitive. For example:
          //
          // WITH t AS (SELECT OBJECT_CONSTRUCT('x', 'y') AS c) SELECT c:x FROM t -- correct
          // WITH t AS (SELECT OBJECT_CONSTRUCT('x', 'y') AS c) SELECT c:X FROM t -- incorrect, returns NULL
          field_type.this.replace(exp.toIdentifier(field_type.name, { quoted: true }));
        }
      }
    }

    return super.datatype_sql(expression);
  }

  /** py:712 */
  tonumber_sql(expression) {
    let precision = expression.args.precision;
    let scale = expression.args.scale;

    const default_precision = precision instanceof exp.Literal && precision.name === "38";
    const default_scale = scale instanceof exp.Literal && scale.name === "0";

    if (default_precision && default_scale) {
      precision = null;
      scale = null;
    } else if (default_scale) {
      scale = null;
    }

    const func_name = expression.args.safe ? "TRY_TO_NUMBER" : "TO_NUMBER";

    return this.func(func_name, expression.this, expression.args.format, precision, scale);
  }

  /** py:735 */
  timestampfromparts_sql(expression) {
    const milli = expression.args.milli;
    if (milli !== null && milli !== undefined) {
      // deny:operators sqlglot/generators/snowflake.py:738 — Python `*` on an Expr
      // (`__mul__`) builds `exp.Mul`; `.mul()` is this port's `_binop` equivalent.
      const milli_to_nano = milli.pop().mul(exp.Literal.number(1000000));
      expression.set("nano", milli_to_nano);
    }

    return rename_func("TIMESTAMP_FROM_PARTS")(this, expression);
  }

  /** py:743 */
  cast_sql(expression, safe_prefix = null) {
    if (expression.isType(exp.DType.GEOGRAPHY)) return this.func("TO_GEOGRAPHY", expression.this);
    if (expression.isType(exp.DType.GEOMETRY)) return this.func("TO_GEOMETRY", expression.this);

    return super.cast_sql(expression, safe_prefix);
  }

  /** py:751 */
  trycast_sql(expression) {
    let value = expression.this;

    if (value.type === null || value.type === undefined) {
      throw new NotPorted("trycast_sql (annotate_types)", "sqlglot/optimizer/annotate_types.py");
    }

    // Snowflake requires that TRY_CAST's value be a string
    // If TRY_CAST is being roundtripped (since Snowflake is the only dialect that sets "requires_string") or
    // if we can deduce that the value is a string, then we can generate TRY_CAST
    if (expression.args.requires_string || value.isType(...exp.DataType.TEXT_TYPES)) {
      return super.trycast_sql(expression);
    }

    return this.cast_sql(expression);
  }

  /** py:767 */
  log_sql(expression) {
    if (!expression.expression) return this.func("LN", expression.this);
    return super.log_sql(expression);
  }

  /** py:773 */
  greatest_sql(expression) {
    const name = expression.args.ignore_nulls ? "GREATEST_IGNORE_NULLS" : "GREATEST";
    return this.func(name, expression.this, ...expression.expressions);
  }

  /** py:777 */
  least_sql(expression) {
    const name = expression.args.ignore_nulls ? "LEAST_IGNORE_NULLS" : "LEAST";
    return this.func(name, expression.this, ...expression.expressions);
  }

  /** py:781 */
  generator_sql(expression) {
    const args = [];
    const rowcount = expression.args.rowcount;
    const timelimit = expression.args.timelimit;

    if (rowcount) args.push(new exp.Kwarg({ this: exp.var("ROWCOUNT"), expression: rowcount }));
    if (timelimit) args.push(new exp.Kwarg({ this: exp.var("TIMELIMIT"), expression: timelimit }));

    return this.func("GENERATOR", ...args);
  }

  /** py:793 */
  unnest_sql(expression) {
    let unnest_alias = expression.args.alias;
    const offset = expression.args.offset;

    const unnest_alias_columns = unnest_alias ? unnest_alias.columns : [];
    const value = seqGet(unnest_alias_columns, 0) || exp.toIdentifier("value");

    const columns = [
      exp.toIdentifier("seq"),
      exp.toIdentifier("key"),
      exp.toIdentifier("path"),
      offset instanceof exp.Expr ? offset.pop() : exp.toIdentifier("index"),
      value,
      exp.toIdentifier("this"),
    ];

    if (unnest_alias) {
      unnest_alias.set("columns", columns);
    } else {
      unnest_alias = new exp.TableAlias({ this: "_u", columns });
    }

    let table_input = this.sql(expression.expressions[0]);
    if (!table_input.startsWith("INPUT =>")) table_input = `INPUT => ${table_input}`;

    const expression_parent = expression.parent;

    const explode =
      expression_parent instanceof exp.Lateral
        ? `FLATTEN(${table_input})`
        : `TABLE(FLATTEN(${table_input}))`;
    let alias = this.sql(unnest_alias);
    alias = alias ? ` AS ${alias}` : "";
    const value_prefix =
      expression_parent instanceof exp.From ||
      expression_parent instanceof exp.Join ||
      expression_parent instanceof exp.Lateral
        ? ""
        : `${this.sql(value)} FROM `;

    return `${value_prefix}${explode}${alias}`;
  }

  /** py:835 */
  undrop_sql(expression) {
    const this_ = this.sql(expression, "this");
    const kind = String(expression.args.kind).toUpperCase();
    let rename = this.sql(expression, "rename");
    rename = rename ? ` RENAME TO ${rename}` : "";
    // deny:implicit_str sqlglot/generators/snowflake.py:840 — static analysis flags
    // `kind` conservatively (`expression.kind` COULD be an Expr in general), but
    // `Undrop.kind` (expressions/ddl.py:378) is `self.args["kind"].upper()`, a plain
    // Python str; `kind` above is already the JS string equivalent, so no `.sql()` call
    // belongs here.
    return `UNDROP ${kind} ${this_}${rename}`;
  }

  /** py:842 */
  show_sql(expression) {
    const terse = expression.args.terse ? "TERSE " : "";
    const iceberg = expression.args.iceberg ? "ICEBERG " : "";
    const history = expression.args.history ? " HISTORY" : "";
    let like = this.sql(expression, "like");
    like = like ? ` LIKE ${like}` : "";

    let scope = this.sql(expression, "scope");
    scope = scope ? ` ${scope}` : "";

    let scope_kind = this.sql(expression, "scope_kind");
    if (scope_kind) scope_kind = ` IN ${scope_kind}`;

    let starts_with = this.sql(expression, "starts_with");
    if (starts_with) starts_with = ` STARTS WITH ${starts_with}`;

    const limit = this.sql(expression, "limit");

    let from_ = this.sql(expression, "from_");
    if (from_) from_ = ` FROM ${from_}`;

    let privileges = this.expressions(expression, "privileges", { flat: true });
    privileges = privileges ? ` WITH PRIVILEGES ${privileges}` : "";

    return `SHOW ${terse}${iceberg}${expression.name}${history}${like}${scope_kind}${scope}${starts_with}${limit}${from_}${privileges}`;
  }

  /** py:871 */
  rowaccessproperty_sql(expression) {
    if (!expression.this) return "ROW ACCESS";
    const on = expression.expressions?.length
      ? ` ON (${this.expressions(expression, null, { flat: true })})`
      : "";
    return `WITH ROW ACCESS POLICY ${this.sql(expression, "this")}${on}`;
  }

  /** py:877 */
  describe_sql(expression) {
    const kind_value = expression.args.kind || "TABLE";

    const properties = expression.args.properties;
    let kind;
    if (properties) {
      const qualifier = this.expressions(properties, null, { sep: " " });
      // deny:implicit_str sqlglot/generators/snowflake.py:883 — static analysis flags
      // `kind_value` conservatively (`.args.get("kind")` COULD be an Expr in general),
      // but Snowflake's DESCRIBE grammar stores `kind` as the raw keyword text (a plain
      // string, same shape as `Undrop.kind` above), verified empirically against the
      // corpus (`DESCRIBE MASKING POLICY`/`MATERIALIZED VIEW`/etc render correctly with
      // no `.sql()` call here).
      kind = ` ${qualifier} ${kind_value}`;
    } else {
      // deny:implicit_str sqlglot/generators/snowflake.py:885 — same site, `properties`-less branch.
      kind = ` ${kind_value}`;
    }

    const this_ = ` ${this.sql(expression, "this")}`;
    let expressions = this.expressions(expression, null, { flat: true });
    expressions = expressions ? ` ${expressions}` : "";
    return `DESCRIBE${kind}${this_}${expressions}`;
  }

  /** py:892 */
  generatedasidentitycolumnconstraint_sql(expression) {
    const start_val = expression.args.start;
    const start = start_val ? ` START ${start_val}` : "";
    const increment_val = expression.args.increment;
    const increment = increment_val ? ` INCREMENT ${increment_val}` : "";

    const order = expression.args.order;
    let order_clause = "";
    if (order !== null && order !== undefined) {
      order_clause = order ? " ORDER" : " NOORDER";
    }

    return `AUTOINCREMENT${start}${increment}${order_clause}`;
  }

  /** py:908 */
  struct_sql(expression) {
    if (expression.expressions.length === 1) {
      const arg = expression.expressions[0];
      if (arg.isStar || (arg instanceof exp.ILike && arg.this.isStar)) {
        // Wildcard syntax: https://docs.snowflake.com/en/sql-reference/data-types-semistructured#object
        return `{${this.sql(expression.expressions[0])}}`;
      }
    }

    const keys = [];
    const values = [];

    expression.expressions.forEach((e, i) => {
      if (e instanceof exp.PropertyEQ) {
        keys.push(e.this instanceof exp.Identifier ? exp.Literal.string(e.name) : e.this);
        values.push(e.expression);
      } else {
        keys.push(exp.Literal.string(`_${i}`));
        values.push(e);
      }
    });

    const args = [];
    for (let i = 0; i < keys.length; i++) args.push(keys[i], values[i]);

    return this.func("OBJECT_CONSTRUCT", ...args);
  }

  /**
   * py:930 `@unsupported_args("weight", "accuracy") def approxquantile_sql(self, expression)`.
   * Routed through a standalone `(self, expression)` function rather than wrapping this
   * bound method directly — see `_approxquantile_sql`'s own note below, and
   * `unsupported_args`'s docstring in `src/generator.js`.
   */
  approxquantile_sql(expression) {
    return _approxquantile_sql(this, expression);
  }

  /** py:934 */
  alterset_sql(expression) {
    let exprs = this.expressions(expression, null, { flat: true });
    exprs = exprs ? ` ${exprs}` : "";
    let file_format = this.expressions(expression, "file_format", { flat: true, sep: " " });
    file_format = file_format ? ` STAGE_FILE_FORMAT = (${file_format})` : "";
    let copy_options = this.expressions(expression, "copy_options", { flat: true, sep: " " });
    copy_options = copy_options ? ` STAGE_COPY_OPTIONS = (${copy_options})` : "";
    let tag = this.expressions(expression, "tag", { flat: true });
    tag = tag ? ` TAG ${tag}` : "";

    return `SET${exprs}${file_format}${copy_options}${tag}`;
  }

  /** py:946 */
  strtotime_sql(expression) {
    // target_type is stored as a DataType instance
    const target_type = expression.args.target_type;

    // Get the type enum from DataType instance or from type annotation
    let type_enum;
    if (target_type instanceof exp.DataType) {
      type_enum = target_type.this;
    } else if (expression.type) {
      type_enum = expression.type.this;
    } else {
      type_enum = exp.DType.TIMESTAMP;
    }

    const func_name = TIMESTAMP_TYPES.get(type_enum) || "TO_TIMESTAMP";

    return this.func(
      `${expression.args.safe ? "TRY_" : ""}${func_name}`,
      expression.this,
      this.format_time(expression),
    );
  }

  /** py:966 */
  timestampsub_sql(expression) {
    return this.sql(
      new exp.TimestampAdd({
        this: expression.this,
        // deny:operators sqlglot/generators/snowflake.py:970 — Python `*` (`__mul__`)
        // builds `exp.Mul`; `.mul()` is this port's `_binop` equivalent.
        expression: expression.expression.mul(exp.Literal.number(-1)),
        unit: expression.args.unit,
      }),
    );
  }

  /** py:975 */
  jsonextract_sql(expression) {
    let this_ = expression.this;

    // JSON strings are valid coming from other dialects such as BQ so
    // for these cases we PARSE_JSON preemptively
    if (
      !(this_ instanceof exp.ParseJSON) &&
      !(this_ instanceof exp.JSONExtract) &&
      !expression.args.requires_json
    ) {
      this_ = new exp.ParseJSON({ this: this_ });
    }

    return this.func("GET_PATH", this_, expression.expression);
  }

  /** py:991 */
  timetostr_sql(expression) {
    let this_ = expression.this;
    if (this_.is_string) this_ = exp.cast(this_, exp.DType.TIMESTAMP);

    return this.func("TO_CHAR", this_, this.format_time(expression));
  }

  /** py:998 */
  datesub_sql(expression) {
    const value = expression.expression;
    if (value) {
      // deny:operators sqlglot/generators/snowflake.py:1001 — Python `*` (`__mul__`)
      // builds `exp.Mul`; `.mul()` is this port's `_binop` equivalent. `_binop` copies
      // its left operand first, so replacing `value` with `value.mul(-1)` (which holds
      // a COPY of value inside) is not a self-reference cycle.
      value.replace(value.mul(exp.Literal.number(-1)));
    } else {
      this.unsupported("DateSub cannot be transpiled if the subtracted count is unknown");
    }

    return date_delta_sql("DATEADD")(this, expression);
  }

  /** py:1007 */
  select_sql(expression) {
    const limit = expression.args.limit;
    const offset = expression.args.offset;
    if (offset && !limit) {
      expression.limit(new exp.Null(), { copy: false });
    }
    return super.select_sql(expression);
  }

  /** py:1014 */
  createable_sql(expression, locations) {
    const is_materialized = expression.find(exp.MaterializedProperty);
    const copy_grants_property = expression.find(exp.CopyGrantsProperty);

    if (expression.kind === "VIEW" && is_materialized && copy_grants_property) {
      // For materialized views, COPY GRANTS is located *before* the columns list
      // This is in contrast to normal views where COPY GRANTS is located *after* the columns list
      // We default CopyGrantsProperty to POST_SCHEMA which means we need to output it POST_NAME if a materialized view is detected
      // ref: https://docs.snowflake.com/en/sql-reference/sql/create-materialized-view#syntax
      // ref: https://docs.snowflake.com/en/sql-reference/sql/create-view#syntax
      const post_schema_properties = locations.get(exp.Properties.Location.POST_SCHEMA);
      post_schema_properties.splice(post_schema_properties.indexOf(copy_grants_property), 1);

      const this_name = this.sql(expression.this, "this");
      const copy_grants = this.sql(copy_grants_property);
      let this_schema = this.schema_columns_sql(expression.this);
      this_schema = this_schema ? `${this.sep()}${this_schema}` : "";

      return `${this_name}${this.sep()}${copy_grants}${this_schema}`;
    }

    return super.createable_sql(expression, locations);
  }

  /** py:1036 */
  arrayagg_sql(expression) {
    const this_ = expression.this;

    // If an ORDER BY clause is present, we need to remove it from ARRAY_AGG
    // and add it later as part of the WITHIN GROUP clause
    const order = this_ instanceof exp.Order ? this_ : null;
    if (order) {
      expression.set("this", order.this.pop());
    }

    let expr_sql = super.arrayagg_sql(expression);

    if (order) {
      expr_sql = this.sql(new exp.WithinGroup({ this: expr_sql, expression: order }));
    }

    return expr_sql;
  }

  /** py:1052 */
  arraydistinct_sql(expression) {
    if (expression.args.check_null) return this.func("ARRAY_DISTINCT", expression.this);
    return this.func("ARRAY_DISTINCT", new exp.ArrayCompact({ this: expression.this }));
  }

  /** py:1057 */
  arraytostring_sql(expression) {
    return this.func("ARRAY_TO_STRING", expression.this, expression.expression);
  }

  /** py:1060 */
  array_sql(expression) {
    const expressions = expression.expressions;

    const first_expr = seqGet(expressions, 0);
    if (first_expr instanceof exp.Select) {
      // SELECT AS STRUCT foo AS alias_foo -> ARRAY_AGG(OBJECT_CONSTRUCT('alias_foo', foo))
      if (String(first_expr.args.kind || "").toUpperCase() === "STRUCT") {
        const object_construct_args = [];
        for (const expr of first_expr.expressions) {
          // Alias case: SELECT AS STRUCT foo AS alias_foo -> OBJECT_CONSTRUCT('alias_foo', foo)
          // Column case: SELECT AS STRUCT foo -> OBJECT_CONSTRUCT('foo', foo)
          const name = expr instanceof exp.Alias ? expr.this : expr;

          object_construct_args.push(exp.Literal.string(expr.aliasOrName), name);
        }

        const array_agg = new exp.ArrayAgg({ this: build_object_construct(object_construct_args) });

        first_expr.set("kind", null);
        first_expr.set("expressions", [array_agg]);

        return this.sql(first_expr.subquery());
      }
    }

    return inline_array_sql(this, expression);
  }

  /** py:1084 */
  currentdate_sql(expression) {
    const zone = this.sql(expression, "this");
    if (!zone) return super.currentdate_sql(expression);

    const expr = new exp.Cast({
      this: new exp.ConvertTimezone({ target_tz: zone, timestamp: new exp.CurrentTimestamp() }),
      to: new exp.DataType({ this: exp.DType.DATE }),
    });
    return this.sql(expr);
  }

  /** py:1095 */
  dot_sql(expression) {
    const this_ = expression.this;

    if (!this_.type) {
      throw new NotPorted("dot_sql (annotate_types)", "sqlglot/optimizer/annotate_types.py");
    }

    if (!(this_ instanceof exp.Dot) && this_.isType(exp.DType.STRUCT)) {
      // Generate colon notation for the top level STRUCT
      return `${this.sql(this_)}:${this.sql(expression, "expression")}`;
    }

    return super.dot_sql(expression);
  }

  /** py:1109 */
  modelattribute_sql(expression) {
    return `${this.sql(expression, "this")}!${this.sql(expression, "expression")}`;
  }

  /** py:1112 */
  format_sql(expression) {
    if (expression.name.toLowerCase() === "%s" && expression.expressions.length === 1) {
      return this.func("TO_CHAR", expression.expressions[0]);
    }

    return this.function_fallback_sql(expression);
  }

  /** py:1118 */
  splitpart_sql(expression) {
    // Set part_index to 1 if missing
    if (!expression.args.delimiter) {
      expression.set("delimiter", exp.Literal.string(" "));
    }

    if (!expression.args.part_index) {
      expression.set("part_index", exp.Literal.number(1));
    }

    return rename_func("SPLIT_PART")(this, expression);
  }

  /** py:1128 */
  uniform_sql(expression) {
    let gen = expression.args.gen;
    const seed = expression.args.seed;

    // From Databricks UNIFORM(min, max, seed) -> Wrap gen in RANDOM(seed)
    if (seed) gen = new exp.Rand({ this: seed });

    // No gen argument (from Databricks 2-arg UNIFORM(min, max)) -> Add RANDOM()
    if (!gen) gen = new exp.Rand();

    return this.func("UNIFORM", expression.this, expression.expression, gen);
  }

  /** py:1142 */
  window_sql(expression) {
    const spec = expression.args.spec;
    const this_ = expression.this;

    const is_ranking = RANKING_WINDOW_FUNCTIONS_WITH_FRAME.some((cls) => this_ instanceof cls);
    const is_nulls_wrapped_ranking =
      (this_ instanceof exp.RespectNulls || this_ instanceof exp.IgnoreNulls) &&
      RANKING_WINDOW_FUNCTIONS_WITH_FRAME.some((cls) => this_.this instanceof cls);

    if (
      (is_ranking || is_nulls_wrapped_ranking) &&
      spec &&
      spec.text("kind").toUpperCase() === "ROWS" &&
      spec.text("start").toUpperCase() === "UNBOUNDED" &&
      spec.text("start_side").toUpperCase() === "PRECEDING" &&
      spec.text("end").toUpperCase() === "UNBOUNDED" &&
      spec.text("end_side").toUpperCase() === "FOLLOWING"
    ) {
      // omit the default window from window ranking functions
      expression.set("spec", null);
    }
    return super.window_sql(expression);
  }

  /** py:1167 */
  filter_sql(expression) {
    // Snowflake doesn't support FILTER (WHERE cond), so we rewrite it into an
    // equivalent conditional aggregation, i.e. wrap the input values in an IFF
    const agg = expression.this;
    let agg_arg = agg instanceof exp.Anonymous ? seqGet(agg.expressions, 0) : agg.this;
    const cond = expression.expression.this;

    if (agg instanceof exp.WithinGroup) {
      // Ordered-set aggregates take their input from the ORDER BY key, so the
      // condition has to wrap that instead of the aggregate's own argument
      if (agg_arg instanceof exp.Mode || PERCENTILES.some((cls) => agg_arg instanceof cls)) {
        for (const ordered of agg.expression.expressions) {
          const key = ordered.this;
          key.replace(new exp.If({ this: cond.copy(), true: key.copy() }));
        }

        return this.sql(agg);
      }

      // Besides the percentile functions, these are the only functions Snowflake
      // accepts WITHIN GROUP for, so anything else can't be rewritten correctly
      if (agg_arg instanceof exp.ArrayAgg || agg_arg instanceof exp.GroupConcat) {
        agg_arg = agg_arg.this;
      } else {
        this.unsupported("Unable to rewrite FILTER into the aggregate's arguments");
        return this.sql(agg);
      }
    }

    // `COUNT(*/t.*) FILTER (WHERE cond)` counts qualifying rows, but a star can't be an IFF
    // argument: `IFF(cond, *, NULL)` expands to multiple columns once the table has 2+ of
    // them, which Snowflake rejects. Use its native COUNT_IF instead.
    if (agg instanceof exp.Count && agg_arg instanceof exp.Expr && agg_arg.isStar) {
      return this.func("COUNT_IF", cond);
    }

    // `DISTINCT` and `ORDER BY` are part of the aggregate's own argument list, so the
    // condition has to wrap the values underneath them rather than the whole clause --
    // `IFF(cond, DISTINCT x, NULL)` is not a call any dialect accepts.
    if (agg_arg instanceof exp.Order) {
      agg_arg = agg_arg.this;
    }

    let targets;
    if (agg_arg instanceof exp.Distinct) {
      targets = agg_arg.expressions;
    } else {
      targets = [agg_arg];
    }

    for (const target of targets) {
      target.replace(new exp.If({ this: cond.copy(), true: target.copy() }));
    }

    return this.sql(agg);
  }

  /** py:1214 */
  withingroup_sql(expression) {
    // Snowflake's MODE doesn't support the ordered-set syntax, i.e. it only
    // accepts the value to aggregate as an argument: MODE(<expr>)
    if (expression.this instanceof exp.Mode && !expression.this.this) {
      const order = expression.expression;
      if (order instanceof exp.Order && order.expressions.length === 1) {
        return this.sql(new exp.Mode({ this: order.expressions[0].this }));
      }
    }

    return super.withingroup_sql(expression);
  }
}

// py:930 `@unsupported_args("weight", "accuracy") def approxquantile_sql(self, expression)`.
// `unsupported_args`'s wrapper (src/generator.js) is `_func(generator, expression)` —
// TWO explicit params, matching every other TRANSFORMS-shaped function in this file —
// so the body it wraps is written the same shape, never a bound method taking one
// implicit-`this` argument. The class's own `approxquantile_sql` above is a thin
// `this`-forwarding shim onto this, which is what stays reachable via ordinary
// `generator.approxquantile_sql(expr)` dispatch.
const _approxquantile_sql = unsupported_args("weight", "accuracy")(
  (self, expression) => self.func("APPROX_PERCENTILE", expression.this, expression.args.quantile),
);
