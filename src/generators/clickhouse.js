// py: sqlglot/generators/clickhouse.py @ 91119bc — WHOLE FILE (722 LOC), AIR-2288.
//
// `class ClickHouseGenerator(generator.Generator)` — the WRITE-side ClickHouse
// grammar, landing alongside `dialects/clickhouse.py` (settings) and
// `parsers/clickhouse.py` (read side) in this same round, PORT_PLAN.md R38's "full
// stack in one round" shape.
//
// `datetime.datetime.fromisoformat(...).isoformat(sep=" ")` (`_timestrtotime_sql`)
// has no shared port-wide helper: `src/_py/datetime.js` only has the PARSING half
// (`pyDateTimeFromIsoFormat`, pre-built for exactly this call site per that file's
// own header). The SERIALIZING half (`.isoformat(sep=" ")` with `tzinfo=None`) is
// narrow enough — one call site, fixed `sep`, no timezone to render — that it is
// written as a local `_isoformatNoTz` helper below rather than widened into a
// general-purpose export.

import * as exp from "../expressions/index.js";
import { Generator, unsupported_args } from "../generator.js";
import {
  arg_max_or_min_no_count,
  inline_array_sql,
  jarowinkler_similarity,
  json_extract_segments,
  json_path_key_only_name,
  length_or_char_length_sql,
  no_pivot_sql,
  rename_func,
  remove_from_array_using_filter,
  sha256_sql,
  strposition_sql,
  var_map_sql,
  weekstart_unit_to_str,
  unit_to_var,
  trim_sql,
  sha2_digest_sql,
} from "../dialects/dialect.js";
import { isInt } from "../helper.js";
import { pyDateTimeFromIsoFormat } from "../_py/datetime.js";

/** py:29 `DATETIME_DELTA = t.Union[exp.DateAdd, exp.DateDiff, exp.DateSub, exp.TimestampSub, exp.TimestampAdd]`. */

function _unix_to_time_sql(self, expression) {
  const scale = expression.args.scale;
  const timestamp = expression.this;

  if (scale === null || scale === undefined || scale.equals(exp.UnixToTime.SECONDS)) {
    return self.func("fromUnixTimestamp", exp.cast(timestamp, exp.DType.BIGINT));
  }
  if (scale.equals(exp.UnixToTime.MILLIS)) {
    return self.func("fromUnixTimestamp64Milli", exp.cast(timestamp, exp.DType.BIGINT));
  }
  if (scale.equals(exp.UnixToTime.MICROS)) {
    return self.func("fromUnixTimestamp64Micro", exp.cast(timestamp, exp.DType.BIGINT));
  }
  if (scale.equals(exp.UnixToTime.NANOS)) {
    return self.func("fromUnixTimestamp64Nano", exp.cast(timestamp, exp.DType.BIGINT));
  }

  return self.func(
    "fromUnixTimestamp",
    exp.cast(new exp.Div({ this: timestamp, expression: exp.func("POW", 10, scale) }), exp.DType.BIGINT),
  );
}

function _lower_func(sql) {
  const index = sql.indexOf("(");
  return sql.slice(0, index).toLowerCase() + sql.slice(index);
}

function _quantile_sql(self, expression) {
  const quantile = expression.args.quantile;
  const args = `(${self.sql(expression, "this")})`;

  let func;
  if (quantile instanceof exp.Array) {
    func = self.func("quantiles", ...quantile.expressions);
  } else {
    func = self.func("quantile", quantile);
  }

  return func + args;
}

function _datetime_delta_sql(name) {
  return function _delta_sql(self, expression) {
    if (!expression.args.unit) {
      return rename_func(name)(self, expression);
    }

    return self.func(
      name,
      unit_to_var(expression),
      expression.expression,
      expression.this,
      expression.args.zone,
    );
  };
}

/**
 * py: sqlglot/generators/clickhouse.py:84 `_timestrtotime_sql`.
 *
 * `datetime.isoformat(sep=" ")` with `tzinfo=None`: `YYYY-MM-DD HH:MM:SS`, plus a
 * `.ffffff` suffix only when the microsecond component is nonzero (Python's own
 * `isoformat` omits it entirely otherwise — not padded to always show).
 */
function _isoformatNoTz({ year, month, day, hour, minute, second, microsecond }) {
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const date = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  const time = `${pad(hour)}:${pad(minute)}:${pad(second)}`;
  const frac = microsecond ? `.${pad(microsecond, 6)}` : "";
  return `${date} ${time}${frac}`;
}

function _timestrtotime_sql(self, expression) {
  const ts = expression.this;

  const tz = expression.args.zone;
  let literal = ts;
  if (tz && ts instanceof exp.Literal) {
    // Clickhouse will not accept timestamps that include a UTC offset, so we must remove them.
    // The first step to removing is parsing the string with `datetime.datetime.fromisoformat`.
    //
    // In python <3.11, `fromisoformat()` can only parse timestamps of millisecond (3 digit)
    // or microsecond (6 digit) precision. It will error if passed any other number of fractional
    // digits, so we extract the fractional seconds and pad to 6 digits before parsing.
    let ts_string = ts.name.trim();

    // separate [date and time] from [fractional seconds and UTC offset]
    const ts_parts = ts_string.split(".");
    if (ts_parts.length === 2) {
      // separate fractional seconds and UTC offset
      const offset_sep = ts_parts[1].includes("+") ? "+" : "-";
      const ts_frac_parts = ts_parts[1].split(offset_sep);
      const num_frac_parts = ts_frac_parts.length;

      // pad to 6 digits if fractional seconds present
      ts_frac_parts[0] = ts_frac_parts[0].padEnd(6, "0");
      ts_string = [
        ts_parts[0], // date and time
        ".",
        ts_frac_parts[0], // fractional seconds
        num_frac_parts > 1 ? offset_sep : "",
        num_frac_parts > 1 ? ts_frac_parts[1] : "", // utc offset (if present)
      ].join("");
    }

    // return literal with no timezone, eg turn '2020-01-01 12:13:14-08:00' into '2020-01-01 12:13:14'
    // this is because Clickhouse encodes the timezone as a data type parameter and throws an error if
    // it's part of the timestamp string
    const parsed = pyDateTimeFromIsoFormat(ts_string);
    const ts_without_tz = _isoformatNoTz(parsed);
    literal = exp.Literal.string(ts_without_tz);
  }

  // Non-nullable DateTime64 with microsecond precision
  const expressions = tz ? [new exp.DataTypeParam({ this: tz })] : [];
  const datatype = exp.DType.DATETIME64.into_expr({
    expressions: [new exp.DataTypeParam({ this: exp.Literal.number(6) }), ...expressions],
    nullable: false,
  });

  return self.sql(exp.cast(literal, datatype, { dialect: self.dialect }));
}

function _map_sql(self, expression) {
  if (!(expression.parent && expression.parent.argKey === "settings")) {
    return _lower_func(var_map_sql(self, expression));
  }

  const keys = expression.args.keys;
  const values = expression.args.values;

  if (!(keys instanceof exp.Array) || !(values instanceof exp.Array)) {
    self.unsupported("Cannot convert array columns into map.");
    return "";
  }

  const args = [];
  const keyExprs = keys.expressions;
  const valueExprs = values.expressions;
  const n = Math.min(keyExprs.length, valueExprs.length);
  for (let i = 0; i < n; i++) {
    args.push(`${self.sql(keyExprs[i])}: ${self.sql(valueExprs[i])}`);
  }

  const csv_args = args.join(", ");

  return `{${csv_args}}`;
}

function _json_cast_sql(self, expression) {
  const this_ = self.sql(expression, "this");
  const to = expression.to;
  let to_sql = self.sql(to);

  if (to.expressions) {
    to_sql = self.sql(exp.toIdentifier(to_sql));
  }

  return `${this_}.:${to_sql}`;
}

/** py: sqlglot/generators/clickhouse.py:166 `class ClickHouseGenerator(generator.Generator)`. */
export class ClickHouseGenerator extends Generator {
  static SELECT_KINDS = [];
  static TRY_SUPPORTED = false;
  static SUPPORTS_UESCAPE = false;
  static SUPPORTS_DECODE_CASE = false;

  static AFTER_HAVING_MODIFIER_TRANSFORMS = Generator.AFTER_HAVING_MODIFIER_TRANSFORMS;

  static QUERY_HINTS = false;
  static STRUCT_DELIMITER = ["(", ")"];
  static NVL2_SUPPORTED = false;
  static ALTER_SET_TYPE = "TYPE";
  static SUPPORTS_ALTER_COLUMN_IF_EXISTS = true;
  static TABLESAMPLE_REQUIRES_PARENS = false;
  static TABLESAMPLE_SIZE_IS_ROWS = false;
  static TABLESAMPLE_KEYWORDS = "SAMPLE";
  static LAST_DAY_SUPPORTS_DATE_PART = false;
  static CAN_IMPLEMENT_ARRAY_ANY = true;
  static SUPPORTS_TO_NUMBER = false;
  static JOIN_HINTS = false;
  static TABLE_HINTS = false;
  static GROUPINGS_SEP = "";
  static SET_OP_MODIFIERS = false;
  static ARRAY_SIZE_NAME = "LENGTH";
  static WRAP_DERIVED_VALUES = false;
  static AUTO_REFRESH_BARE_INTERVALS = true;

  /** py:193-205 */
  static STRING_TYPE_MAPPING = new Map([
    [exp.DType.BLOB, "String"],
    [exp.DType.CHAR, "String"],
    [exp.DType.LONGBLOB, "String"],
    [exp.DType.LONGTEXT, "String"],
    [exp.DType.MEDIUMBLOB, "String"],
    [exp.DType.MEDIUMTEXT, "String"],
    [exp.DType.TINYBLOB, "String"],
    [exp.DType.TINYTEXT, "String"],
    [exp.DType.TEXT, "String"],
    [exp.DType.VARBINARY, "String"],
    [exp.DType.VARCHAR, "String"],
  ]);

  /** py:207-211 */
  static SUPPORTED_JSON_PATH_PARTS = new Set([
    exp.JSONPathKey,
    exp.JSONPathRoot,
    exp.JSONPathSubscript,
  ]);

  /** py:213-276 */
  static TYPE_MAPPING = new Map([
    ...Generator.TYPE_MAPPING,
    [exp.DType.BLOB, "String"],
    [exp.DType.CHAR, "String"],
    [exp.DType.LONGBLOB, "String"],
    [exp.DType.LONGTEXT, "String"],
    [exp.DType.MEDIUMBLOB, "String"],
    [exp.DType.MEDIUMTEXT, "String"],
    [exp.DType.TINYBLOB, "String"],
    [exp.DType.TINYTEXT, "String"],
    [exp.DType.TEXT, "String"],
    [exp.DType.VARBINARY, "String"],
    [exp.DType.VARCHAR, "String"],
    [exp.DType.ARRAY, "Array"],
    [exp.DType.BOOLEAN, "Bool"],
    [exp.DType.BIGINT, "Int64"],
    [exp.DType.DATE32, "Date32"],
    [exp.DType.DATETIME, "DateTime"],
    [exp.DType.DATETIME2, "DateTime"],
    [exp.DType.SMALLDATETIME, "DateTime"],
    [exp.DType.DATETIME64, "DateTime64"],
    [exp.DType.DECIMAL, "Decimal"],
    [exp.DType.DECIMAL32, "Decimal32"],
    [exp.DType.DECIMAL64, "Decimal64"],
    [exp.DType.DECIMAL128, "Decimal128"],
    [exp.DType.DECIMAL256, "Decimal256"],
    [exp.DType.TIMESTAMP, "DateTime"],
    [exp.DType.TIMESTAMPNTZ, "DateTime"],
    [exp.DType.TIMESTAMPTZ, "DateTime"],
    [exp.DType.DOUBLE, "Float64"],
    [exp.DType.ENUM, "Enum"],
    [exp.DType.ENUM8, "Enum8"],
    [exp.DType.ENUM16, "Enum16"],
    [exp.DType.FIXEDSTRING, "FixedString"],
    [exp.DType.FLOAT, "Float32"],
    [exp.DType.INT, "Int32"],
    [exp.DType.MEDIUMINT, "Int32"],
    [exp.DType.INT128, "Int128"],
    [exp.DType.INT256, "Int256"],
    [exp.DType.LOWCARDINALITY, "LowCardinality"],
    [exp.DType.MAP, "Map"],
    [exp.DType.NESTED, "Nested"],
    [exp.DType.NOTHING, "Nothing"],
    [exp.DType.SMALLINT, "Int16"],
    [exp.DType.STRUCT, "Tuple"],
    [exp.DType.TINYINT, "Int8"],
    [exp.DType.UBIGINT, "UInt64"],
    [exp.DType.UINT, "UInt32"],
    [exp.DType.UINT128, "UInt128"],
    [exp.DType.UINT256, "UInt256"],
    [exp.DType.USMALLINT, "UInt16"],
    [exp.DType.UTINYINT, "UInt8"],
    [exp.DType.IPV4, "IPv4"],
    [exp.DType.IPV6, "IPv6"],
    [exp.DType.POINT, "Point"],
    [exp.DType.RING, "Ring"],
    [exp.DType.LINESTRING, "LineString"],
    [exp.DType.MULTILINESTRING, "MultiLineString"],
    [exp.DType.POLYGON, "Polygon"],
    [exp.DType.MULTIPOLYGON, "MultiPolygon"],
    [exp.DType.AGGREGATEFUNCTION, "AggregateFunction"],
    [exp.DType.SIMPLEAGGREGATEFUNCTION, "SimpleAggregateFunction"],
    [exp.DType.DYNAMIC, "Dynamic"],
  ]);

  /** py:278-387 */
  static TRANSFORMS = new Map([
    ...[...Generator.TRANSFORMS].filter(([k]) => k !== exp.AutoRefreshProperty),
    [exp.AnyValue, rename_func("any")],
    [exp.ApproxDistinct, rename_func("uniq")],
    [exp.ArrayDistinct, rename_func("arrayDistinct")],
    [exp.ArrayConcat, rename_func("arrayConcat")],
    [exp.ArrayContains, rename_func("has")],
    [exp.ArrayFilter, (self, e) => self.func("arrayFilter", e.expression, e.this)],
    [exp.Transform, (self, e) => self.func("arrayMap", e.expression, e.this)],
    [exp.ArrayRemove, remove_from_array_using_filter],
    [exp.ArrayReverse, rename_func("arrayReverse")],
    [exp.ArraySlice, rename_func("arraySlice")],
    [exp.ArraySum, rename_func("arraySum")],
    [exp.ArrayMax, rename_func("arrayMax")],
    [exp.ArrayMin, rename_func("arrayMin")],
    [exp.ArgMax, arg_max_or_min_no_count("argMax")],
    [exp.ArgMin, arg_max_or_min_no_count("argMin")],
    [exp.Array, inline_array_sql],
    [exp.CityHash64, rename_func("cityHash64")],
    [exp.CastToStrType, rename_func("CAST")],
    [exp.CurrentDatabase, rename_func("CURRENT_DATABASE")],
    [exp.CurrentSchemas, rename_func("CURRENT_SCHEMAS")],
    [exp.CountIf, rename_func("countIf")],
    [exp.CosineDistance, rename_func("cosineDistance")],
    [exp.CompressColumnConstraint, (self, e) => `CODEC(${self.expressions(e, "this", { flat: true })})`],
    [exp.ComputedColumnConstraint, (self, e) =>
      `${e.args.persisted ? "MATERIALIZED" : "ALIAS"} ${self.sql(e, "this")}`],
    [exp.CurrentDate, (self) => self.func("CURRENT_DATE")],
    [exp.CurrentVersion, rename_func("VERSION")],
    [exp.DateAdd, _datetime_delta_sql("DATE_ADD")],
    [exp.DateDiff, _datetime_delta_sql("DATE_DIFF")],
    [exp.DateStrToDate, rename_func("toDate")],
    [exp.DateSub, _datetime_delta_sql("DATE_SUB")],
    [exp.Explode, rename_func("arrayJoin")],
    [exp.FarmFingerprint, rename_func("farmFingerprint64")],
    [exp.Final, (self, e) => `${self.sql(e, "this")} FINAL`],
    [exp.IsNan, rename_func("isNaN")],
    [exp.JarowinklerSimilarity, jarowinkler_similarity("jaroWinklerSimilarity")],
    [exp.JSONCast, _json_cast_sql],
    [exp.JSONExtract, json_extract_segments("JSONExtractString", { quoted_index: false })],
    [exp.JSONExtractScalar, json_extract_segments("JSONExtractString", { quoted_index: false })],
    [exp.JSONPathKey, json_path_key_only_name],
    [exp.JSONPathRoot, () => ""],
    [exp.Length, length_or_char_length_sql],
    [exp.Map, _map_sql],
    [exp.Median, rename_func("median")],
    [exp.Nullif, rename_func("nullIf")],
    [exp.PartitionedByProperty, (self, e) => `PARTITION BY ${self.sql(e, "this")}`],
    [exp.Pivot, no_pivot_sql],
    [exp.Quantile, _quantile_sql],
    [exp.RegexpLike, (self, e) => self.func("match", e.this, e.expression)],
    [exp.Rand, rename_func("randCanonical")],
    [exp.StartsWith, rename_func("startsWith")],
    [exp.Struct, rename_func("tuple")],
    [exp.Trunc, rename_func("trunc")],
    [exp.EndsWith, rename_func("endsWith")],
    [exp.EuclideanDistance, rename_func("L2Distance")],
    [exp.StrPosition, (self, e) => strposition_sql(self, e, {
      func_name: "POSITION", supports_position: true, use_ansi_position: false,
    })],
    [exp.TimeToStr, (self, e) => self.func(
      "formatDateTime",
      e.this instanceof exp.TsOrDsToTimestamp ? e.this.this : e.this,
      self.format_time(e),
      e.args.zone,
    )],
    [exp.TimeStrToTime, _timestrtotime_sql],
    [exp.TimestampAdd, _datetime_delta_sql("TIMESTAMP_ADD")],
    [exp.TimestampSub, _datetime_delta_sql("TIMESTAMP_SUB")],
    [exp.Typeof, rename_func("toTypeName")],
    [exp.VarMap, _map_sql],
    [exp.Xor, (self, e) => self.func("xor", e.this, e.expression)],
    [exp.MD5Digest, rename_func("MD5")],
    [exp.MD5, (self, e) => self.func("LOWER", self.func("HEX", self.func("MD5", e.this)))],
    [exp.SHA, rename_func("SHA1")],
    [exp.SHA1Digest, rename_func("SHA1")],
    [exp.SHA2, sha256_sql],
    [exp.SHA2Digest, sha2_digest_sql],
    [exp.Split, (self, e) => self.func("splitByString", e.args.expression, e.this, e.args.limit)],
    [exp.RegexpSplit, (self, e) => self.func("splitByRegexp", e.args.expression, e.this, e.args.limit)],
    [exp.UnixToTime, _unix_to_time_sql],
    [exp.Trim, (self, e) => trim_sql(self, e, "BOTH")],
    [exp.Variance, rename_func("varSamp")],
    [exp.SchemaCommentProperty, (self, e) => self.naked_property(e)],
    [exp.Stddev, rename_func("stddevSamp")],
    [exp.Chr, rename_func("CHAR")],
    [exp.Lag, (self, e) => self.func("lagInFrame", e.this, e.args.offset, e.args.default)],
    [exp.Lead, (self, e) => self.func("leadInFrame", e.this, e.args.offset, e.args.default)],
    [exp.Levenshtein, unsupported_args("ins_cost", "del_cost", "sub_cost", "max_dist")(rename_func("editDistance"))],
    [exp.ParseDatetime, (self, e) => self.func("parseDateTime", e.this, e.args.format, e.args.zone)],
  ]);

  /** py:389-398 */
  static PROPERTIES_LOCATION = new Map([
    ...Generator.PROPERTIES_LOCATION,
    [exp.AutoRefreshProperty, exp.Properties.Location.POST_NAME],
    [exp.DefinerProperty, exp.Properties.Location.POST_SCHEMA],
    [exp.OnCluster, exp.Properties.Location.POST_NAME],
    [exp.PartitionedByProperty, exp.Properties.Location.POST_SCHEMA],
    [exp.ToTableProperty, exp.Properties.Location.POST_NAME],
    [exp.UuidProperty, exp.Properties.Location.POST_NAME],
    [exp.VolatileProperty, exp.Properties.Location.UNSUPPORTED],
  ]);

  // There's no list in docs, but it can be found in Clickhouse code
  // see `ClickHouse/src/Parsers/ParserCreate*.cpp`
  /** py:400-411 */
  static ON_CLUSTER_TARGETS = new Set([
    "SCHEMA", // Transpiled CREATE SCHEMA may have OnCluster property set
    "DATABASE",
    "TABLE",
    "VIEW",
    "DICTIONARY",
    "INDEX",
    "FUNCTION",
    "NAMED COLLECTION",
  ]);

  // https://clickhouse.com/docs/en/sql-reference/data-types/nullable
  /** py:413-424 */
  static NON_NULLABLE_TYPES = new Set([
    exp.DType.ARRAY,
    exp.DType.MAP,
    exp.DType.STRUCT,
    exp.DType.POINT,
    exp.DType.RING,
    exp.DType.LINESTRING,
    exp.DType.MULTILINESTRING,
    exp.DType.POLYGON,
    exp.DType.MULTIPOLYGON,
  ]);

  /** py:426-450 */
  groupconcat_sql(expression) {
    let this_ = expression.this;
    const separator = expression.args.separator;

    if (this_ instanceof exp.Limit && this_.this) {
      const limit = this_;
      this_ = limit.this.pop();
      return this.sql(new exp.ParameterizedAgg({
        this: "groupConcat",
        params: [this_],
        expressions: [separator, limit.expression],
      }));
    }

    if (separator) {
      return this.sql(new exp.ParameterizedAgg({
        this: "groupConcat",
        params: [this_],
        expressions: [separator],
      }));
    }

    return this.func("groupConcat", this_);
  }

  /** py:452-461 */
  offset_sql(expression) {
    let offset = super.offset_sql(expression);

    // OFFSET ... FETCH syntax requires a "ROW" or "ROWS" keyword
    // https://clickhouse.com/docs/sql-reference/statements/select/offset
    const parent = expression.parent;
    if (parent instanceof exp.Select && parent.args.limit instanceof exp.Fetch) {
      offset = `${offset} ROWS`;
    }

    return offset;
  }

  /** py:463-471 */
  strtodate_sql(expression) {
    const strtodate_sql = this.function_fallback_sql(expression);

    if (!(expression.parent instanceof exp.Cast)) {
      // StrToDate returns DATEs in other dialects (eg. postgres), so
      // this branch aims to improve the transpilation to clickhouse
      return this.cast_sql(exp.cast(expression, "DATE"));
    }

    return strtodate_sql;
  }

  /** py:473-479 */
  cast_sql(expression, safe_prefix = null) {
    const this_ = expression.this;

    if (this_ instanceof exp.StrToDate && expression.to.equals(exp.DType.DATETIME.into_expr())) {
      return this.sql(this_);
    }

    return super.cast_sql(expression, safe_prefix);
  }

  /** py:481-487 */
  trycast_sql(expression) {
    const dtype = expression.to;
    if (!dtype.isType(...this.constructor.NON_NULLABLE_TYPES, { checkNullable: true })) {
      // Casting x into Nullable(T) appears to behave similarly to TRY_CAST(x AS T)
      dtype.set("nullable", true);
    }

    return super.cast_sql(expression);
  }

  /** py:489-491 */
  _jsonpathsubscript_sql(expression) {
    const this_ = this.json_path_part(expression.this);
    return isInt(this_) ? String(Number.parseInt(this_, 10) + 1) : this_;
  }

  /** py:493-494 */
  likeproperty_sql(expression) {
    return `AS ${this.sql(expression, "this")}`;
  }

  /** py:496-511 */
  _any_to_has(expression, default_, prefix = "") {
    let arr;
    let this_;
    if (expression.left instanceof exp.Any) {
      arr = expression.left;
      this_ = expression.right;
    } else if (expression.right instanceof exp.Any) {
      arr = expression.right;
      this_ = expression.left;
    } else {
      return default_(expression);
    }

    return prefix + this.func("has", arr.this.unnest(), this_);
  }

  /** py:513-514 */
  eq_sql(expression) {
    return this._any_to_has(expression, (e) => super.eq_sql(e));
  }

  /** py:516-517 */
  neq_sql(expression) {
    return this._any_to_has(expression, (e) => super.neq_sql(e), "NOT ");
  }

  /** py:519-522 */
  regexpilike_sql(expression) {
    // Manually add a flag to make the search case-insensitive
    const regex = this.func("CONCAT", "'(?i)'", expression.expression);
    return this.func("match", expression.this, regex);
  }

  /** py:524-554 */
  datatype_sql(expression) {
    // String is the standard ClickHouse type, every other variant is just an alias.
    // Additionally, any supplied length parameter will be ignored.
    //
    // https://clickhouse.com/docs/en/sql-reference/data-types/string
    let dtype;
    if (this.constructor.STRING_TYPE_MAPPING.has(expression.this)) {
      dtype = "String";
    } else {
      dtype = super.datatype_sql(expression);
    }

    // This section changes the type to `Nullable(...)` if the following conditions hold:
    // - It's marked as nullable - this ensures we won't wrap ClickHouse types with `Nullable`
    //   and change their semantics
    // - It's not the key type of a `Map`. This is because ClickHouse enforces the following
    //   constraint: "Type of Map key must be a type, that can be represented by integer or
    //   String or FixedString (possibly LowCardinality) or UUID or IPv6"
    // - It's not a composite type, e.g. `Nullable(Array(...))` is not a valid type
    const parent = expression.parent;
    const nullable = expression.args.nullable;
    if (
      nullable === true
      || (
        (nullable === null || nullable === undefined)
        && !(
          parent instanceof exp.DataType
          && parent.isType(exp.DType.MAP, { checkNullable: true })
          && (expression.index === null || expression.index === undefined || expression.index === 0)
        )
        && !expression.isType(...this.constructor.NON_NULLABLE_TYPES, { checkNullable: true })
      )
    ) {
      dtype = `Nullable(${dtype})`;
    }

    return dtype;
  }

  /** py:556-562 */
  cte_sql(expression) {
    if (expression.args.scalar) {
      const this_ = this.sql(expression, "this");
      const alias = this.sql(expression, "alias");
      return `${this_} AS ${alias}`;
    }

    return super.cte_sql(expression);
  }

  /** py:564-576 */
  after_limit_modifiers(expression) {
    return [
      ...super.after_limit_modifiers(expression),
      expression.args.settings
        ? this.seg("SETTINGS ") + this.expressions(expression, "settings", { flat: true })
        : "",
      expression.args.format
        ? this.seg("FORMAT ") + this.sql(expression, "format")
        : "",
    ];
  }

  /** py:578-579 */
  placeholder_sql(expression) {
    return `{${expression.name}: ${this.sql(expression, "kind")}}`;
  }

  /** py:581-582 */
  oncluster_sql(expression) {
    return `ON CLUSTER ${this.sql(expression, "this")}`;
  }

  /** py:584-587 */
  _refresh_interval_sql(expression) {
    if (expression instanceof exp.Add) {
      return `${this._refresh_interval_sql(expression.this)} ${this._refresh_interval_sql(expression.expression)}`;
    }
    return this.sql(expression.assertIs(exp.Interval));
  }

  /** py:589-605 */
  autorefreshproperty_sql(expression) {
    const cadence = this.sql(expression, "cadence");
    const interval = expression.this;
    let schedule = cadence && interval ? ` ${cadence} ${this._refresh_interval_sql(interval)}` : "";
    let offset = expression.args.offset;
    offset = offset ? ` OFFSET ${this._refresh_interval_sql(offset)}` : "";
    let randomize = expression.args.randomize;
    randomize = randomize ? ` RANDOMIZE FOR ${this._refresh_interval_sql(randomize)}` : "";
    let dependencies = this.expressions(expression, null, { flat: true });
    dependencies = dependencies ? ` DEPENDS ON ${dependencies}` : "";
    let settings = this.sql(expression, "settings");
    settings = settings ? ` ${settings}` : "";
    const append = expression.args.append ? " APPEND" : "";

    return `REFRESH${schedule}${offset}${randomize}${dependencies}${settings}${append}`;
  }

  /** py:607-623 */
  createable_sql(expression, locations) {
    if (
      this.constructor.ON_CLUSTER_TARGETS.has(expression.kind)
      && locations.get(exp.Properties.Location.POST_NAME)?.length
    ) {
      const this_name = this.sql(
        expression.this instanceof exp.Schema ? expression.this : expression,
        "this",
      );
      const this_properties = locations.get(exp.Properties.Location.POST_NAME)
        .map((prop) => this.sql(prop))
        .join(" ");
      let this_schema = this.schema_columns_sql(expression.this);
      this_schema = this_schema ? `${this.sep()}${this_schema}` : "";

      return `${this_name}${this.sep()}${this_properties}${this_schema}`;
    }

    return super.createable_sql(expression, locations);
  }

  /** py:625-641 */
  create_sql(expression) {
    // The comment property comes last in CTAS statements, i.e. after the query
    const query = expression.expression;
    let comment_prop = null;
    if (query instanceof exp.Query) {
      comment_prop = expression.find(exp.SchemaCommentProperty);
      if (comment_prop) {
        comment_prop.pop();
        query.replace(exp.paren(query));
      }
    }

    const create_sql = super.create_sql(expression);

    let comment_sql = this.sql(comment_prop);
    comment_sql = comment_sql ? ` ${comment_sql}` : "";

    return `${create_sql}${comment_sql}`;
  }

  /** py:643-645 */
  prewhere_sql(expression) {
    const this_ = this.indent(this.sql(expression, "this"));
    return `${this.seg("PREWHERE")}${this.sep()}${this_}`;
  }

  /** py:647-657 */
  indexcolumnconstraint_sql(expression) {
    let this_ = this.sql(expression, "this");
    this_ = this_ ? ` ${this_}` : "";
    let expr = this.sql(expression, "expression");
    expr = expr ? ` ${expr}` : "";
    let index_type = this.sql(expression, "index_type");
    index_type = index_type ? ` TYPE ${index_type}` : "";
    let granularity = this.sql(expression, "granularity");
    granularity = granularity ? ` GRANULARITY ${granularity}` : "";

    return `INDEX${this_}${expr}${index_type}${granularity}`;
  }

  /** py:659-660 */
  partition_sql(expression) {
    return `PARTITION ${this.expressions(expression, null, { flat: true })}`;
  }

  /** py:662-663 */
  partitionid_sql(expression) {
    return `ID ${this.sql(expression.this)}`;
  }

  /** py:665-666 */
  replacepartition_sql(expression) {
    return `REPLACE ${this.sql(expression.expression)} FROM ${this.sql(expression, "source")}`;
  }

  /** py:668-669 */
  projectiondef_sql(expression) {
    return `PROJECTION ${this.sql(expression.this)} ${this.wrap(expression.expression)}`;
  }

  /** py:671-672 */
  nestedjsonselect_sql(expression) {
    return `${this.sql(expression, "this")}.^${this.sql(expression, "expression")}`;
  }

  /** py:674-681 */
  is_sql(expression) {
    let is_sql = super.is_sql(expression);

    if (expression.parent instanceof exp.Not) {
      // value IS NOT NULL -> NOT (value IS NULL)
      is_sql = this.wrap(is_sql);
    }

    return is_sql;
  }

  /** py:683-689 */
  in_sql(expression) {
    let in_sql = super.in_sql(expression);

    if (expression.parent instanceof exp.Not && expression.args.is_global) {
      in_sql = in_sql.replace("GLOBAL IN", "GLOBAL NOT IN");
    }

    return in_sql;
  }

  /** py:691-699 */
  not_sql(expression) {
    if (expression.this instanceof exp.In) {
      if (expression.this.args.is_global) {
        // let `GLOBAL IN` child interpose `NOT`
        return this.sql(expression, "this");
      }

      expression.set("this", exp.paren(expression.this, false));
    }

    return super.not_sql(expression);
  }

  /** py:701-712 */
  values_sql(expression, values_as_table = true) {
    // If the VALUES clause contains tuples of expressions, we need to treat it
    // as a table since Clickhouse will automatically alias it as such.
    const alias = expression.args.alias;

    if (alias && alias.args.columns && expression.expressions.length) {
      const values = expression.expressions[0].expressions;
      values_as_table = values.some((value) => value instanceof exp.Tuple);
    } else {
      values_as_table = true;
    }

    return super.values_sql(expression, values_as_table);
  }

  /** py:714-719 */
  timestamptrunc_sql(expression) {
    let unit = weekstart_unit_to_str(this, expression);
    // https://clickhouse.com/docs/whats-new/changelog/2023#improvement
    if (_versionLt(this.dialect.version, 23n, 12n) && unit && unit.is_string) {
      unit = exp.Literal.string(unit.name.toLowerCase());
    }
    return this.func("dateTrunc", unit, expression.this, expression.args.zone);
  }

  /** py:721-722 */
  datetrunc_sql(expression) {
    return this.timestamptrunc_sql(expression);
  }
}

/**
 * Python tuple `<` over `Dialect.version`, same local helper (no shared export exists
 * yet for this comparison) as `generators/postgres.js`'s own `_versionLt`.
 */
function _versionLt(version, ...bound) {
  const n = Math.min(version.length, bound.length);
  for (let i = 0; i < n; i++) {
    const a = BigInt(version[i]);
    const b = BigInt(bound[i]);
    if (a !== b) return a < b;
  }
  return version.length < bound.length;
}
