// py: sqlglot/generators/mysql.py @ 91119bc — WHOLE FILE (835 LOC), AIR-2286.
//
// `class MySQLGenerator(generator.Generator)` — the WRITE-side counterpart of
// `src/parsers/mysql.js` (grammar) and `src/dialects/mysql.js` (settings), same
// three-file split every prior dialect port uses.
//
// MOST `*_sql` METHODS BELOW HAVE NO BASE-GENERATOR COUNTERPART
// -------------------------------------------------------------------------
// `array_sql`, `arraycontainsall_sql`, `arraycontainedby_sql`, `jsonarraycontains_sql`,
// `timestamptrunc_sql`, `isascii_sql`, `currentschema_sql`, `partitionbylistproperty_sql`,
// `partitionlist_sql`, and `makeinterval_sql` do not exist on `src/generator.js`'s base
// `Generator` — they are first defined HERE, matching upstream (`generator.py` has no
// such methods either). This still works: `_buildDispatch(cls)` (generator.js) walks
// the INSTANTIATED CLASS's own prototype chain (memoised per class), so a method named
// `array_sql` on `MySQLGenerator.prototype` is picked up by the convention-based
// `exp.Array -> "array_sql"` mapping the same way it would be for the base class — no
// base-Generator registration needed for a brand-new method name.
//
// THREE REAL BASE-DIALECT GAPS, FIXED ALONGSIDE THIS FILE (ITS FIRST CALLERS)
// -------------------------------------------------------------------------
//   * `arrow_json_extract_sql` (dialects/dialect.js, py:1268) — `exp.JSONExtractScalar`.
//   * `length_or_char_length_sql` (dialects/dialect.js, py:2552) — `exp.Length`.
//   * `eliminate_full_outer_join` (transforms.js, py:632) — the `exp.Select`
//     TRANSFORMS pipeline's last stage.
// All three are small, single-purpose helpers already covered by prior dialects'
// `build_date_delta`/`unit_to_var`/etc. machinery; no larger optimizer/scope
// dependency chain behind any of them (checked — R31's "budget for base-Generator
// gaps" concern did not materialize into anything bigger this round).

import * as exp from "../expressions/index.js";
import * as transforms from "../transforms.js";
import { Generator, AFTER_HAVING_MODIFIER_TRANSFORMS, unsupported_args } from "../generator.js";
import {
  arrow_json_extract_sql,
  build_date_delta,
  build_date_delta_with_interval,
  date_add_interval_sql,
  datestrtodate_sql,
  length_or_char_length_sql,
  max_or_greatest,
  min_or_least,
  no_ilike_sql,
  no_paren_current_date_sql,
  no_pivot_sql,
  no_tablesample_sql,
  no_trycast_sql,
  remove_ts_or_ds_to_date,
  rename_func,
  strposition_sql,
  unit_to_var,
  trim_sql,
  timestrtotime_sql,
} from "../dialects/dialect.js";

/** py: sqlglot/generators/mysql.py:31 */
function _date_trunc_sql(self, expression) {
  const expr = self.sql(expression, "this");
  const unit_expr = expression.args.unit;
  const unit = unit_expr instanceof exp.WeekStart
    ? self.weekstart_name(unit_expr)
    : expression.text("unit").toUpperCase();

  let concat, date_format;
  if (unit === "WEEK") {
    concat = `CONCAT(YEAR(${expr}), ' ', WEEK(${expr}, 1), ' 1')`;
    date_format = "%Y %u %w";
  } else if (unit === "MONTH") {
    concat = `CONCAT(YEAR(${expr}), ' ', MONTH(${expr}), ' 1')`;
    date_format = "%Y %c %e";
  } else if (unit === "QUARTER") {
    concat = `CONCAT(YEAR(${expr}), ' ', QUARTER(${expr}) * 3 - 2, ' 1')`;
    date_format = "%Y %c %e";
  } else if (unit === "YEAR") {
    concat = `CONCAT(YEAR(${expr}), ' 1 1')`;
    date_format = "%Y %c %e";
  } else {
    if (unit !== "DAY") self.unsupported(`Unexpected interval unit: ${unit}`);
    return self.func("DATE", expr);
  }

  return self.func("STR_TO_DATE", concat, `'${date_format}'`);
}

/** py: sqlglot/generators/mysql.py:60 */
function _str_to_date_sql(self, expression) {
  return self.func("STR_TO_DATE", expression.this, self.format_time(expression));
}

/** py: sqlglot/generators/mysql.py:66 */
function _unix_to_time_sql(self, expression) {
  const scale = expression.args.scale;
  const timestamp = expression.this;

  if (scale === null || scale === undefined || scale.equals(exp.UnixToTime.SECONDS)) {
    return self.func("FROM_UNIXTIME", timestamp, self.format_time(expression));
  }

  return self.func(
    "FROM_UNIXTIME",
    new exp.Div({ this: timestamp, expression: exp.func("POW", 10, scale) }),
    self.format_time(expression),
  );
}

/** py: sqlglot/generators/mysql.py:80 */
function date_add_sql(kind) {
  return function func(self, expression) {
    return self.func(
      `DATE_${kind}`,
      expression.this,
      new exp.Interval({ this: expression.expression, unit: unit_to_var(expression) }),
    );
  };
}

/** py: sqlglot/generators/mysql.py:93 */
const _MAKE_INTERVAL_UNIT_ALIASES = new Map([
  ["years", "year"],
  ["months", "month"],
  ["weeks", "week"],
  ["days", "day"],
  ["hours", "hour"],
  ["minutes", "minute"],
  ["mins", "minute"],
  ["seconds", "second"],
  ["secs", "second"],
]);

/** py: sqlglot/generators/mysql.py:106 */
function _ts_or_ds_to_date_sql(self, expression) {
  const time_format = expression.args.format;
  return time_format ? _str_to_date_sql(self, expression) : self.func("DATE", expression.this);
}

/** py: sqlglot/generators/mysql.py:111 */
export class MySQLGenerator extends Generator {
  static SELECT_KINDS = [];
  static TRY_SUPPORTED = false;
  static SUPPORTS_UESCAPE = false;
  static SUPPORTS_DECODE_CASE = false;
  static SUPPORTS_MODIFY_COLUMN = true;
  static SUPPORTS_CHANGE_COLUMN = true;
  static SUPPORTS_ALTER_COLUMN_NULLABILITY = true;

  static AFTER_HAVING_MODIFIER_TRANSFORMS = AFTER_HAVING_MODIFIER_TRANSFORMS;

  static INTERVAL_ALLOWS_PLURAL_FORM = false;
  static LOCKING_READS_SUPPORTED = true;
  static NULL_ORDERING_SUPPORTED = null;
  static JOIN_HINTS = false;
  static TABLE_HINTS = true;
  static DUPLICATE_KEY_UPDATE_WITH_SET = false;
  static QUERY_HINT_SEP = " ";
  static VALUES_AS_TABLE = false;
  static NVL2_SUPPORTED = false;
  static LAST_DAY_SUPPORTS_DATE_PART = false;
  static JSON_TYPE_REQUIRED_FOR_EXTRACTION = true;
  static JSON_PATH_BRACKETED_KEY_SUPPORTED = false;
  static JSON_KEY_VALUE_PAIR_SEP = ",";
  static SUPPORTS_TO_NUMBER = false;
  static PARSE_JSON_NAME = null;
  static PAD_FILL_PATTERN_IS_REQUIRED = true;
  static WRAP_DERIVED_VALUES = false;
  static VARCHAR_REQUIRES_SIZE = true;
  static SUPPORTS_MEDIAN = false;
  static UPDATE_STATEMENT_SUPPORTS_FROM = false;

  /** py:143 */
  static TRANSFORMS = new Map([
    ...Generator.TRANSFORMS,
    [exp.ArrayAgg, rename_func("GROUP_CONCAT")],
    [exp.BitwiseAndAgg, rename_func("BIT_AND")],
    [exp.BitwiseOrAgg, rename_func("BIT_OR")],
    [exp.BitwiseXorAgg, rename_func("BIT_XOR")],
    [exp.BitwiseCount, rename_func("BIT_COUNT")],
    [exp.Chr, (self, e) => self.chr_sql(e, "CHAR")],
    [exp.CurrentDate, no_paren_current_date_sql],
    [exp.CurrentVersion, rename_func("VERSION")],
    [exp.DateDiff, remove_ts_or_ds_to_date(
      (self, e) => self.func("DATEDIFF", e.this, e.expression), ["this", "expression"],
    )],
    [exp.DateAdd, remove_ts_or_ds_to_date(date_add_sql("ADD"))],
    [exp.DateStrToDate, datestrtodate_sql],
    [exp.DateSub, remove_ts_or_ds_to_date(date_add_sql("SUB"))],
    [exp.DateTrunc, _date_trunc_sql],
    [exp.Day, remove_ts_or_ds_to_date()],
    [exp.DayOfMonth, remove_ts_or_ds_to_date(rename_func("DAYOFMONTH"))],
    [exp.DayOfWeek, remove_ts_or_ds_to_date(rename_func("DAYOFWEEK"))],
    [exp.DayOfYear, remove_ts_or_ds_to_date(rename_func("DAYOFYEAR"))],
    [exp.GroupConcat, (self, e) => (
      `GROUP_CONCAT(${self.sql(e, "this")} SEPARATOR ${self.sql(e, "separator") || "','"})`
    )],
    [exp.ILike, no_ilike_sql],
    [exp.JSONExtractScalar, arrow_json_extract_sql],
    [exp.Length, length_or_char_length_sql],
    [exp.LogicalOr, rename_func("MAX")],
    [exp.LogicalAnd, rename_func("MIN")],
    [exp.Max, max_or_greatest],
    [exp.Min, min_or_least],
    [exp.Month, remove_ts_or_ds_to_date()],
    [exp.NullSafeEQ, (self, e) => self.binary(e, "<=>")],
    [exp.NullSafeNEQ, (self, e) => `NOT ${self.binary(e, "<=>")}`],
    [exp.NumberToStr, rename_func("FORMAT")],
    [exp.Pivot, no_pivot_sql],
    [exp.Select, transforms.preprocess([
      transforms.eliminate_distinct_on,
      transforms.eliminate_semi_and_anti_joins,
      transforms.eliminate_qualify,
      transforms.eliminate_full_outer_join,
      transforms.unnest_generate_date_array_using_recursive_cte,
    ])],
    [exp.StrPosition, (self, e) => strposition_sql(self, e, { func_name: "LOCATE", supports_position: true })],
    [exp.StrToDate, _str_to_date_sql],
    [exp.StrToTime, _str_to_date_sql],
    [exp.Stuff, rename_func("INSERT")],
    [exp.SessionUser, () => "SESSION_USER()"],
    [exp.TableSample, no_tablesample_sql],
    [exp.TimeFromParts, rename_func("MAKETIME")],
    [exp.TimestampAdd, date_add_interval_sql("DATE", "ADD")],
    [exp.TimestampDiff, (self, e) => self.func("TIMESTAMPDIFF", unit_to_var(e), e.expression, e.this)],
    [exp.TimestampSub, date_add_interval_sql("DATE", "SUB")],
    [exp.TimeStrToUnix, rename_func("UNIX_TIMESTAMP")],
    [exp.TimeStrToTime, (self, e) => timestrtotime_sql(self, e, !e.args.zone)],
    [exp.TimeToStr, remove_ts_or_ds_to_date(
      (self, e) => self.func("DATE_FORMAT", e.this, self.format_time(e)),
    )],
    [exp.Trim, trim_sql],
    [exp.Trunc, rename_func("TRUNCATE")],
    [exp.TryCast, no_trycast_sql],
    [exp.TsOrDsAdd, date_add_sql("ADD")],
    [exp.TsOrDsDiff, (self, e) => self.func("DATEDIFF", e.this, e.expression)],
    [exp.TsOrDsToDate, _ts_or_ds_to_date_sql],
    [exp.Unicode, (self, e) => `ORD(CONVERT(${self.sql(e.this)} USING utf32))`],
    [exp.UnixToTime, _unix_to_time_sql],
    [exp.Week, remove_ts_or_ds_to_date()],
    [exp.WeekOfYear, remove_ts_or_ds_to_date(rename_func("WEEKOFYEAR"))],
    [exp.Year, remove_ts_or_ds_to_date()],
    [exp.UtcTimestamp, rename_func("UTC_TIMESTAMP")],
    [exp.UtcTime, rename_func("UTC_TIME")],
  ]);

  /** py:226 */
  static UNSIGNED_TYPE_MAPPING = new Map([
    [exp.DType.UBIGINT, "BIGINT"],
    [exp.DType.UINT, "INT"],
    [exp.DType.UMEDIUMINT, "MEDIUMINT"],
    [exp.DType.USMALLINT, "SMALLINT"],
    [exp.DType.UTINYINT, "TINYINT"],
    [exp.DType.UDECIMAL, "DECIMAL"],
    [exp.DType.UDOUBLE, "DOUBLE"],
  ]);

  /** py:236 */
  static TIMESTAMP_TYPE_MAPPING = new Map([
    [exp.DType.DATETIME2, "DATETIME"],
    [exp.DType.SMALLDATETIME, "DATETIME"],
    [exp.DType.TIMESTAMP, "DATETIME"],
    [exp.DType.TIMESTAMPNTZ, "DATETIME"],
    [exp.DType.TIMESTAMPTZ, "TIMESTAMP"],
    [exp.DType.TIMESTAMPLTZ, "TIMESTAMP"],
  ]);

  /** py:245 */
  static TYPE_MAPPING = new Map([
    [exp.DType.NCHAR, "CHAR"],
    [exp.DType.NVARCHAR, "VARCHAR"],
    [exp.DType.INET, "INET"],
    [exp.DType.ROWVERSION, "VARBINARY"],
    [exp.DType.UBIGINT, "BIGINT"],
    [exp.DType.UINT, "INT"],
    [exp.DType.UMEDIUMINT, "MEDIUMINT"],
    [exp.DType.USMALLINT, "SMALLINT"],
    [exp.DType.UTINYINT, "TINYINT"],
    [exp.DType.UDECIMAL, "DECIMAL"],
    [exp.DType.UDOUBLE, "DOUBLE"],
    [exp.DType.DATETIME2, "DATETIME"],
    [exp.DType.SMALLDATETIME, "DATETIME"],
    [exp.DType.TIMESTAMP, "DATETIME"],
    [exp.DType.TIMESTAMPNTZ, "DATETIME"],
    [exp.DType.TIMESTAMPTZ, "TIMESTAMP"],
    [exp.DType.TIMESTAMPLTZ, "TIMESTAMP"],
  ]);

  /** py:265 */
  static PROPERTIES_LOCATION = new Map([
    ...Generator.PROPERTIES_LOCATION,
    [exp.TransientProperty, exp.Properties.Location.UNSUPPORTED],
    [exp.VolatileProperty, exp.Properties.Location.UNSUPPORTED],
    [exp.PartitionedByProperty, exp.Properties.Location.UNSUPPORTED],
    [exp.PartitionByRangeProperty, exp.Properties.Location.POST_SCHEMA],
    [exp.PartitionByListProperty, exp.Properties.Location.POST_SCHEMA],
  ]);

  static LIMIT_FETCH = "LIMIT";

  static LIMIT_ONLY_LITERALS = true;

  /** py:278 */
  static CHAR_CAST_MAPPING = new Map([
    exp.DType.LONGTEXT,
    exp.DType.LONGBLOB,
    exp.DType.MEDIUMBLOB,
    exp.DType.MEDIUMTEXT,
    exp.DType.TEXT,
    exp.DType.TINYBLOB,
    exp.DType.TINYTEXT,
    exp.DType.VARCHAR,
  ].map((k) => [k, "CHAR"]));

  /** py:291 */
  static SIGNED_CAST_MAPPING = new Map([
    exp.DType.BIGINT,
    exp.DType.BOOLEAN,
    exp.DType.INT,
    exp.DType.SMALLINT,
    exp.DType.TINYINT,
    exp.DType.MEDIUMINT,
  ].map((k) => [k, "SIGNED"]));

  // MySQL doesn't support many datatypes in cast.
  // https://dev.mysql.com/doc/refman/8.0/en/cast-functions.html#function_cast
  /** py:305 */
  static CAST_MAPPING = new Map([
    [exp.DType.LONGTEXT, "CHAR"],
    [exp.DType.LONGBLOB, "CHAR"],
    [exp.DType.MEDIUMBLOB, "CHAR"],
    [exp.DType.MEDIUMTEXT, "CHAR"],
    [exp.DType.TEXT, "CHAR"],
    [exp.DType.TINYBLOB, "CHAR"],
    [exp.DType.TINYTEXT, "CHAR"],
    [exp.DType.VARCHAR, "CHAR"],
    [exp.DType.BIGINT, "SIGNED"],
    [exp.DType.BOOLEAN, "SIGNED"],
    [exp.DType.INT, "SIGNED"],
    [exp.DType.SMALLINT, "SIGNED"],
    [exp.DType.TINYINT, "SIGNED"],
    [exp.DType.MEDIUMINT, "SIGNED"],
    [exp.DType.UBIGINT, "UNSIGNED"],
  ]);

  /** py:323 */
  static TIMESTAMP_FUNC_TYPES = new Set([
    exp.DType.TIMESTAMPTZ,
    exp.DType.TIMESTAMPLTZ,
  ]);

  // https://dev.mysql.com/doc/refman/8.0/en/keywords.html
  /** py:329 */
  static RESERVED_KEYWORDS = new Set([
    "accessible", "add", "all", "alter", "analyze", "and", "as", "asc", "asensitive",
    "before", "between", "bigint", "binary", "blob", "both", "by", "call", "cascade",
    "case", "change", "char", "character", "check", "collate", "column", "condition",
    "constraint", "continue", "convert", "create", "cross", "cube", "cume_dist",
    "current_date", "current_time", "current_timestamp", "current_user", "cursor",
    "database", "databases", "day_hour", "day_microsecond", "day_minute", "day_second",
    "dec", "decimal", "declare", "default", "delayed", "delete", "dense_rank", "desc",
    "describe", "deterministic", "distinct", "distinctrow", "div", "double", "drop",
    "dual", "each", "else", "elseif", "empty", "enclosed", "escaped", "except",
    "exists", "exit", "explain", "false", "fetch", "first_value", "float", "float4",
    "float8", "for", "force", "foreign", "from", "fulltext", "function", "generated",
    "get", "grant", "group", "grouping", "groups", "having", "high_priority",
    "hour_microsecond", "hour_minute", "hour_second", "if", "ignore", "in", "index",
    "infile", "inner", "inout", "insensitive", "insert", "int", "int1", "int2", "int3",
    "int4", "int8", "integer", "intersect", "interval", "into", "io_after_gtids",
    "io_before_gtids", "is", "iterate", "join", "json_table", "key", "keys", "kill",
    "lag", "last_value", "lateral", "lead", "leading", "leave", "left", "like",
    "limit", "linear", "lines", "load", "localtime", "localtimestamp", "lock", "long",
    "longblob", "longtext", "loop", "low_priority", "master_bind",
    "master_ssl_verify_server_cert", "match", "maxvalue", "mediumblob", "mediumint",
    "mediumtext", "middleint", "minute_microsecond", "minute_second", "mod",
    "modifies", "natural", "not", "no_write_to_binlog", "nth_value", "ntile", "null",
    "numeric", "of", "on", "optimize", "optimizer_costs", "option", "optionally",
    "or", "order", "out", "outer", "outfile", "over", "partition", "percent_rank",
    "precision", "primary", "procedure", "purge", "range", "rank", "read", "reads",
    "read_write", "real", "recursive", "references", "regexp", "release", "rename",
    "repeat", "replace", "require", "resignal", "restrict", "return", "revoke",
    "right", "rlike", "row", "rows", "row_number", "schema", "schemas",
    "second_microsecond", "select", "sensitive", "separator", "set", "show", "signal",
    "smallint", "spatial", "specific", "sql", "sqlexception", "sqlstate",
    "sqlwarning", "sql_big_result", "sql_calc_found_rows", "sql_small_result", "ssl",
    "starting", "stored", "straight_join", "system", "table", "terminated", "then",
    "tinyblob", "tinyint", "tinytext", "to", "trailing", "trigger", "true", "undo",
    "union", "unique", "unlock", "unsigned", "update", "usage", "use", "using",
    "utc_date", "utc_time", "utc_timestamp", "values", "varbinary", "varchar",
    "varcharacter", "varying", "virtual", "when", "where", "while", "window", "with",
    "write", "xor", "year_month", "zerofill",
  ]);

  static SQL_SECURITY_VIEW_LOCATION = exp.Properties.Location.POST_CREATE;

  /** py:596 */
  makeinterval_sql(expression) {
    const intervals = [];
    for (const [arg_key, value0] of Object.entries(expression.args)) {
      if (value0 === null || value0 === undefined) continue;

      let unit_name, value;
      if (value0 instanceof exp.Kwarg) {
        const key = value0.this.name.toLowerCase();
        unit_name = _MAKE_INTERVAL_UNIT_ALIASES.get(key) || key;
        value = value0.expression;
      } else {
        unit_name = arg_key;
        value = value0;
      }

      intervals.push(new exp.Interval({ this: value.copy(), unit: exp.var(unit_name.toUpperCase()) }));
    }

    if (!intervals.length) return this.function_fallback_sql(expression);

    const parent = expression.parent;
    const sep = parent instanceof exp.Sub && parent.expression === expression ? " - " : " + ";

    return intervals.map((interval) => this.sql(interval)).join(sep);
  }

  /** py:620 */
  locate_properties(properties) {
    const locations = super.locate_properties(properties);

    // MySQL puts SQL SECURITY before VIEW but after the schema for functions/procedures
    const create = properties.parent;
    if (create instanceof exp.Create && create.kind === "VIEW") {
      const post_schema = locations.get(exp.Properties.Location.POST_SCHEMA) || [];
      for (let i = 0; i < post_schema.length; i++) {
        const p = post_schema[i];
        if (p instanceof exp.SqlSecurityProperty) {
          post_schema.splice(i, 1);
          const loc = this.constructor.SQL_SECURITY_VIEW_LOCATION;
          if (!locations.has(loc)) locations.set(loc, []);
          locations.get(loc).push(p);
          break;
        }
      }
    }

    return locations;
  }

  /** py:634 */
  computedcolumnconstraint_sql(expression) {
    const persisted = expression.args.persisted ? "STORED" : "VIRTUAL";
    return `GENERATED ALWAYS AS (${this.sql(expression.this.unnest())}) ${persisted}`;
  }

  /** py:638 */
  array_sql(expression) {
    this.unsupported("Arrays are not supported by MySQL");
    return this.function_fallback_sql(expression);
  }

  /** py:642 */
  arraycontainsall_sql(expression) {
    this.unsupported("Array operations are not supported by MySQL");
    return this.function_fallback_sql(expression);
  }

  /** py:646 */
  arraycontainedby_sql(expression) {
    this.unsupported("Array operations are not supported by MySQL");
    return this.function_fallback_sql(expression);
  }

  /** py:650 */
  dpipe_sql(expression) {
    return this.func("CONCAT", ...expression.flatten());
  }

  /** py:653 */
  extract_sql(expression) {
    const unit = expression.name;
    if (unit && unit.toLowerCase() === "epoch") {
      return this.func("UNIX_TIMESTAMP", expression.expression);
    }

    return super.extract_sql(expression);
  }

  /** py:660 */
  datatype_sql(expression) {
    if (
      this.constructor.VARCHAR_REQUIRES_SIZE
      && expression.isType(exp.DType.VARCHAR)
      && !expression.expressions.length
    ) {
      // `VARCHAR` must always have a size - if it doesn't, we always generate `TEXT`
      return "TEXT";
    }

    // https://dev.mysql.com/doc/refman/8.0/en/numeric-type-syntax.html
    let result = super.datatype_sql(expression);
    if (this.constructor.UNSIGNED_TYPE_MAPPING.has(expression.this)) {
      result = `${result} UNSIGNED`;
    }

    return result;
  }

  /** py:676 */
  jsonarraycontains_sql(expression) {
    return `${this.sql(expression, "this")} MEMBER OF(${this.sql(expression, "expression")})`;
  }

  /** py:679 */
  cast_sql(expression, safe_prefix = null) {
    if (this.constructor.TIMESTAMP_FUNC_TYPES.has(expression.to.this)) {
      return this.func("TIMESTAMP", expression.this);
    }

    const to = this.constructor.CAST_MAPPING.get(expression.to.this);

    if (to) expression.to.set("this", to);
    return super.cast_sql(expression, safe_prefix);
  }

  /** py:689 */
  show_sql(expression) {
    const this_ = ` ${expression.name}`;
    const full = expression.args.full ? " FULL" : "";
    const global_ = expression.args.global_ ? " GLOBAL" : "";

    let target = this.sql(expression, "target");
    target = target ? ` ${target}` : "";
    if (["COLUMNS", "INDEX"].includes(expression.name)) {
      target = ` FROM${target}`;
    } else if (expression.name === "GRANTS") {
      target = ` FOR${target}`;
    } else if (["LINKS", "PARTITIONS"].includes(expression.name)) {
      target = target ? ` ON${target}` : "";
    } else if (expression.name === "PROJECTIONS") {
      target = target ? ` ON TABLE${target}` : "";
    }

    const db = this._prefixed_sql("FROM", expression, "db");

    const like = this._prefixed_sql("LIKE", expression, "like");
    const where = this.sql(expression, "where");

    let types = this.expressions(expression, "types");
    types = types ? ` ${types}` : types;
    const query = this._prefixed_sql("FOR QUERY", expression, "query");

    let offset, limit;
    if (expression.name === "PROFILE") {
      offset = this._prefixed_sql("OFFSET", expression, "offset");
      limit = this._prefixed_sql("LIMIT", expression, "limit");
    } else {
      offset = "";
      limit = this._oldstyle_limit_sql(expression);
    }

    const log = this._prefixed_sql("IN", expression, "log");
    const position = this._prefixed_sql("FROM", expression, "position");

    const channel = this._prefixed_sql("FOR CHANNEL", expression, "channel");

    const mutex_or_status = expression.name === "ENGINE"
      ? (expression.args.mutex ? " MUTEX" : " STATUS")
      : "";

    const for_table = this._prefixed_sql("FOR TABLE", expression, "for_table");
    const for_group = this._prefixed_sql("FOR GROUP", expression, "for_group");
    const for_user = this._prefixed_sql("FOR USER", expression, "for_user");
    const for_role = this._prefixed_sql("FOR ROLE", expression, "for_role");
    const into_outfile = this._prefixed_sql("INTO OUTFILE", expression, "into_outfile");
    const json = expression.args.json ? " JSON" : "";

    return `SHOW${full}${global_}${this_}${json}${target}${for_table}${types}${db}${query}${log}${position}${channel}${mutex_or_status}${like}${where}${offset}${limit}${for_group}${for_user}${for_role}${into_outfile}`;
  }

  /**
   * py:740
   *
   * To avoid TO keyword in ALTER ... RENAME statements.
   * It's moved from Doris, because it's the same for all MySQL, Doris, and StarRocks.
   */
  alterrename_sql(expression, include_to = true) {
    return super.alterrename_sql(expression, false);
  }

  /** py:746 */
  altercolumn_sql(expression) {
    const dtype = this.sql(expression, "dtype");
    if (!dtype) return super.altercolumn_sql(expression);

    if (expression.args.exists) {
      this.unsupported("ALTER COLUMN IF EXISTS is not supported by this dialect");
    }

    const this_ = this.sql(expression, "this");
    const null_constraint = this._alter_column_null_constraint_sql(expression);
    return `MODIFY COLUMN ${this_} ${dtype}${null_constraint}`;
  }

  /** py:758 */
  _prefixed_sql(prefix, expression, arg) {
    const sql = this.sql(expression, arg);
    return sql ? ` ${prefix} ${sql}` : "";
  }

  /** py:762 */
  _oldstyle_limit_sql(expression) {
    const limit = this.sql(expression, "limit");
    const offset = this.sql(expression, "offset");
    if (limit) {
      const limit_offset = offset ? `${offset}, ${limit}` : limit;
      return ` LIMIT ${limit_offset}`;
    }
    return "";
  }

  /** py:770 */
  timestamptrunc_sql(expression) {
    let unit = expression.args.unit;
    if (unit instanceof exp.WeekStart) unit = exp.var(this.weekstart_name(unit));

    // Pick an old-enough date to avoid negative timestamp diffs
    const start_ts = "'0000-01-01 00:00:00'";

    // Source: https://stackoverflow.com/a/32955740
    const timestamp_diff = build_date_delta(exp.TimestampDiff)([unit, start_ts, expression.this]);
    const interval = new exp.Interval({ this: timestamp_diff, unit });
    const dateadd = build_date_delta_with_interval(exp.DateAdd)([start_ts, interval]);

    return this.sql(dateadd);
  }

  /** py:785 */
  converttimezone_sql(expression) {
    const from_tz = expression.args.source_tz;
    const to_tz = expression.args.target_tz;
    const dt = expression.args.timestamp;

    return this.func("CONVERT_TZ", dt, from_tz, to_tz);
  }

  /** py:792 */
  attimezone_sql(expression) {
    this.unsupported("AT TIME ZONE is not supported by MySQL");
    return this.sql(expression.this);
  }

  /** py:796 */
  isascii_sql(expression) {
    return `REGEXP_LIKE(${this.sql(expression.this)}, '^[[:ascii:]]*$')`;
  }

  /** py:799 */
  ignorenulls_sql(expression) {
    // https://dev.mysql.com/doc/refman/8.4/en/window-function-descriptions.html
    this.unsupported("MySQL does not support IGNORE NULLS.");
    return this.sql(expression.this);
  }

  /** py:804 `@unsupported_args("this")` */
  currentschema_sql(expression) {
    return _currentschema_sql(this, expression);
  }

  /** py:808 */
  partition_sql(expression) {
    const parent = expression.parent;
    if (parent instanceof exp.PartitionByRangeProperty || parent instanceof exp.PartitionByListProperty) {
      return this.expressions(expression, null, { flat: true });
    }
    return super.partition_sql(expression);
  }

  /** py:814 */
  _partition_by_sql(expression, kind) {
    const partitions = this.expressions(expression, "partition_expressions", { flat: true });
    const create = this.expressions(expression, "create_expressions", { flat: true });
    return `PARTITION BY ${kind} (${partitions}) (${create})`;
  }

  /** py:821 */
  partitionbyrangeproperty_sql(expression) {
    return this._partition_by_sql(expression, "RANGE");
  }

  /** py:824 */
  partitionbylistproperty_sql(expression) {
    return this._partition_by_sql(expression, "LIST");
  }

  /** py:827 */
  partitionlist_sql(expression) {
    const name = this.sql(expression, "this");
    const values = this.expressions(expression, null, { flat: true });
    return `PARTITION ${name} VALUES IN (${values})`;
  }

  /** py:832 */
  partitionrange_sql(expression) {
    const name = this.sql(expression, "this");
    const values = this.expressions(expression, null, { flat: true });
    return `PARTITION ${name} VALUES LESS THAN (${values})`;
  }
}

/** py:804 `@unsupported_args("this") def currentschema_sql(self, expression)`. */
const _currentschema_sql = unsupported_args("this")((self) => self.func("SCHEMA"));
