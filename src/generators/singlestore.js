// py: sqlglot/generators/singlestore.py @ 91119bc — WHOLE FILE (1,602 LOC),
// AIR-2286 (epic AIR-2272, "12.1 MySQL family"), part 3 of the chain: `class
// SingleStoreGenerator(MySQLGenerator)` extends R104's `src/generators/mysql.js`
// directly, the same `TrinoGenerator extends PrestoGenerator` relationship R105 used
// one dialect-family over. By far the bulk of this file's LOC is a single
// `RESERVED_KEYWORDS` set literal (upstream py:375-1426, ~1,050 lowercase names) and
// a ~65-entry `TRANSFORMS` table; only 18 small `*_sql` method overrides follow it.
//
// `src/dialects/singlestore.js` (settings + nested `Tokenizer`) and
// `src/parsers/singlestore.js` (grammar) stay separate files, same split every prior
// dialect uses; both land this same round.

import * as exp from "../expressions/index.js";
import { DataType } from "../expressions/index.js";
import {
  json_extract_segments,
  json_path_key_only_name,
  rename_func,
  bool_xor_sql,
  count_if_to_sum,
  timestamptrunc_sql,
  date_add_interval_sql,
  timestampdiff_sql,
  remove_ts_or_ds_to_date,
} from "../dialects/dialect.js";
import { unsupported_args } from "../generator.js";
import { MySQLGenerator, date_add_sql } from "./mysql.js";

/**
 * py: sqlglot/generators/singlestore.py:24 `_unicode_substitute(m: re.Match[str])`.
 *
 * DEVIATION: this is consumed as `this_.replace(escape_pattern, ...)`'s replacer
 * (generator.js:2382) — a Python `re.Match` exposes its capture group via
 * `m.group(1)`, but `String.prototype.replace`'s function form calls the replacer
 * positionally as `(match, group1, offset, string)`, so the capture group is the
 * SECOND parameter here, not a property read off the first.
 */
function _unicode_substitute(match, group1) {
  return String.fromCodePoint(Number.parseInt(group1, 16));
}

/** py: sqlglot/generators/singlestore.py:28 */
export class SingleStoreGenerator extends MySQLGenerator {
  static SUPPORTS_UESCAPE = false;
  static SUPPORTS_ALTER_COLUMN_NULLABILITY = false;
  static NULL_ORDERING_SUPPORTED = true;
  static MATCH_AGAINST_TABLE_PREFIX = "TABLE ";
  static STRUCT_DELIMITER = ["(", ")"];

  /** py:35 `UNICODE_SUBSTITUTE: t.ClassVar[t.Any] = staticmethod(_unicode_substitute)`. */
  static UNICODE_SUBSTITUTE = _unicode_substitute;

  /** py:37 */
  static SUPPORTED_JSON_PATH_PARTS = new Set([
    exp.JSONPathKey,
    exp.JSONPathRoot,
    exp.JSONPathSubscript,
  ]);

  /** py:43 */
  static TRANSFORMS = new Map([
    ...[...MySQLGenerator.TRANSFORMS].filter(
      ([k]) => k !== exp.JSONExtractScalar && k !== exp.CurrentDate,
    ),
    [exp.TsOrDsToDate, (self, e) => (
      e.args.format
        ? self.func("TO_DATE", e.this, self.format_time(e))
        : self.func("DATE", e.this)
    )],
    [exp.StrToTime, (self, e) => self.func("TO_TIMESTAMP", e.this, self.format_time(e))],
    [exp.ToChar, (self, e) => self.func("TO_CHAR", e.this, self.format_time(e))],
    [exp.StrToDate, (self, e) => self.func(
      "STR_TO_DATE",
      e.this,
      self.format_time(e, self.dialect.MYSQL_INVERSE_TIME_MAPPING, self.dialect.MYSQL_INVERSE_TIME_TRIE),
    )],
    [exp.TimeToStr, (self, e) => self.func(
      "DATE_FORMAT",
      e.this,
      self.format_time(e, self.dialect.MYSQL_INVERSE_TIME_MAPPING, self.dialect.MYSQL_INVERSE_TIME_TRIE),
    )],
    [exp.Date, unsupported_args("zone", "expressions")(rename_func("DATE"))],
    [exp.Cast, unsupported_args("format", "action", "default")(
      (self, e) => `${self.sql(e, "this")} :> ${self.sql(e, "to")}`,
    )],
    [exp.TryCast, unsupported_args("format", "action", "default")(
      (self, e) => `${self.sql(e, "this")} !:> ${self.sql(e, "to")}`,
    )],
    [exp.CastToStrType, (self, e) => self.sql(exp.cast(e.this, DataType.fromStr(e.args.to.name)))],
    [exp.StrToUnix, unsupported_args("format")(rename_func("UNIX_TIMESTAMP"))],
    [exp.TimeToUnix, rename_func("UNIX_TIMESTAMP")],
    [exp.TimeStrToUnix, rename_func("UNIX_TIMESTAMP")],
    [exp.UnixSeconds, rename_func("UNIX_TIMESTAMP")],
    [exp.UnixToStr, (self, e) => self.func(
      "FROM_UNIXTIME",
      e.this,
      self.format_time(e, self.dialect.MYSQL_INVERSE_TIME_MAPPING, self.dialect.MYSQL_INVERSE_TIME_TRIE),
    )],
    [exp.UnixToTime, unsupported_args("scale", "zone", "hours", "minutes")(
      (self, e) => self.func(
        "FROM_UNIXTIME",
        e.this,
        self.format_time(e, self.dialect.MYSQL_INVERSE_TIME_MAPPING, self.dialect.MYSQL_INVERSE_TIME_TRIE),
      ),
    )],
    [exp.UnixToTimeStr, (self, e) => `FROM_UNIXTIME(${self.sql(e, "this")}) :> TEXT`],
    [exp.DateBin, unsupported_args("unit", "zone")(
      (self, e) => self.func("TIME_BUCKET", e.this, e.expression, e.args.origin),
    )],
    [exp.TimeStrToDate, (self, e) => self.sql(exp.cast(e.this, exp.DType.DATE))],
    [exp.FromTimeZone, (self, e) => self.func("CONVERT_TZ", e.this, e.args.zone, "'UTC'")],
    [exp.DiToDate, (self, e) => `STR_TO_DATE(${self.sql(e, "this")}, ${self.dialect.DATEINT_FORMAT})`],
    [exp.DateToDi, (self, e) => `(DATE_FORMAT(${self.sql(e, "this")}, ${self.dialect.DATEINT_FORMAT}) :> INT)`],
    [exp.TsOrDiToDi, (self, e) => `(DATE_FORMAT(${self.sql(e, "this")}, ${self.dialect.DATEINT_FORMAT}) :> INT)`],
    [exp.Time, unsupported_args("zone")((self, e) => `${self.sql(e, "this")} :> TIME`)],
    [exp.DatetimeAdd, remove_ts_or_ds_to_date(date_add_sql("ADD"))],
    [exp.DatetimeTrunc, unsupported_args("zone")(timestamptrunc_sql())],
    [exp.DatetimeSub, date_add_interval_sql("DATE", "SUB")],
    [exp.DatetimeDiff, timestampdiff_sql],
    [exp.DateTrunc, unsupported_args("zone")(timestamptrunc_sql())],
    [exp.DateDiff, unsupported_args("zone")(
      (self, e) => (e.unit != null ? timestampdiff_sql(self, e) : self.func("DATEDIFF", e.this, e.expression)),
    )],
    [exp.TsOrDsDiff, (self, e) => (
      e.unit != null ? timestampdiff_sql(self, e) : self.func("DATEDIFF", e.this, e.expression)
    )],
    [exp.TimestampTrunc, unsupported_args("zone")(timestamptrunc_sql())],
    [exp.CurrentDatetime, (self, e) => self.sql(
      self.dialect.CAST_TO_TIME6(
        new exp.CurrentTimestamp({ this: exp.Literal.number(6) }), exp.DType.DATETIME,
      ),
    )],
    [exp.JSONExtract, unsupported_args(
      "only_json_types",
      "expressions",
      "variant_extract",
      "json_query",
      "option",
      "quote",
      "on_condition",
      "requires_json",
    )(json_extract_segments("JSON_EXTRACT_JSON"))],
    [exp.JSONBExtract, json_extract_segments("BSON_EXTRACT_BSON")],
    [exp.JSONPathKey, json_path_key_only_name],
    [exp.JSONPathSubscript, (self, e) => self.json_path_part(e.this)],
    [exp.JSONPathRoot, () => ""],
    [exp.JSONFormat, unsupported_args("options", "is_json")(rename_func("JSON_PRETTY"))],
    [exp.JSONArrayAgg, unsupported_args("null_handling", "return_type", "strict")(
      (self, e) => self.func("JSON_AGG", e.this, { suffix: `${self.sql(e, "order")})` }),
    )],
    [exp.JSONArray, unsupported_args("null_handling", "return_type", "strict")(
      rename_func("JSON_BUILD_ARRAY"),
    )],
    [exp.JSONBExists, (self, e) => self.func("BSON_MATCH_ANY_EXISTS", e.this, e.args.path)],
    [exp.JSONExists, (self, e) => (
      e.args.from_dcolonqmark
        ? `${self.sql(e.this)}::?${self.sql(e.args.path)}`
        : self.func("JSON_MATCH_ANY_EXISTS", e.this, e.args.path)
    )],
    [exp.JSONObject, unsupported_args("null_handling", "unique_keys", "return_type", "encoding")(
      rename_func("JSON_BUILD_OBJECT"),
    )],
    [exp.DayOfWeekIso, (self, e) => `((${self.func("DAYOFWEEK", e.this)} % 7) + 1)`],
    [exp.DayOfMonth, rename_func("DAY")],
    [exp.Hll, rename_func("APPROX_COUNT_DISTINCT")],
    [exp.ApproxDistinct, rename_func("APPROX_COUNT_DISTINCT")],
    [exp.CountIf, count_if_to_sum],
    [exp.LogicalOr, (self, e) => `MAX(ABS(${self.sql(e, "this")}))`],
    [exp.LogicalAnd, (self, e) => `MIN(ABS(${self.sql(e, "this")}))`],
    [exp.ApproxQuantile, unsupported_args("accuracy", "weight")(
      (self, e) => self.func("APPROX_PERCENTILE", e.this, e.args.quantile, e.args.error_tolerance),
    )],
    [exp.Variance, rename_func("VAR_SAMP")],
    [exp.VariancePop, rename_func("VAR_POP")],
    [exp.Xor, bool_xor_sql],
    [exp.Cbrt, (self, e) => self.sql(
      new exp.Pow({ this: e.this, expression: exp.Literal.number(1).truediv(exp.Literal.number(3)) }),
    )],
    [exp.RegexpLike, (self, e) => self.binary(e, "RLIKE")],
    [exp.Repeat, (self, e) => self.func(
      "LPAD",
      exp.Literal.string(""),
      new exp.Mul({ this: self.func("LENGTH", e.this), expression: e.args.times }),
      e.this,
    )],
    [exp.IsAscii, (self, e) => `(${self.sql(e, "this")} RLIKE '^[\x00-\x7f]*$')`],
    [exp.MD5Digest, (self, e) => self.func("UNHEX", self.func("MD5", e.this))],
    [exp.Contains, rename_func("INSTR")],
    [exp.RegexpExtractAll, unsupported_args("position", "occurrence", "group")(
      (self, e) => self.func("REGEXP_MATCH", e.this, e.expression, e.args.parameters),
    )],
    [exp.RegexpExtract, unsupported_args("group")(
      (self, e) => self.func(
        "REGEXP_SUBSTR", e.this, e.expression, e.args.position, e.args.occurrence, e.args.parameters,
      ),
    )],
    [exp.StartsWith, (self, e) => self.func(
      "REGEXP_INSTR", e.this, self.func("CONCAT", exp.Literal.string("^"), e.expression),
    )],
    [exp.FromBase, (self, e) => self.func("CONV", e.this, e.expression, exp.Literal.number(10))],
    [exp.RegexpILike, (self, e) => self.binary(
      new exp.RegexpLike({
        this: new exp.Lower({ this: e.this }),
        expression: new exp.Lower({ this: e.expression }),
      }),
      "RLIKE",
    )],
    [exp.Stuff, (self, e) => self.func(
      "CONCAT",
      self.func("SUBSTRING", e.this, exp.Literal.number(1), e.args.start.sub(1)),
      e.expression,
      self.func("SUBSTRING", e.this, e.args.start.add(e.args.length)),
    )],
    [exp.National, (self, e) => self.national_sql(e, "")],
    [exp.Reduce, unsupported_args("finish")(
      (self, e) => self.func("REDUCE", e.args.initial, e.this, e.args.merge),
    )],
    [exp.MatchAgainst, unsupported_args("modifier")((self, e) => self.matchagainst_sql(e))],
    [exp.Show, unsupported_args(
      "history",
      "terse",
      "offset",
      "starts_with",
      "limit",
      "from_",
      "scope",
      "scope_kind",
      "mutex",
      "query",
      "channel",
      "log",
      "types",
      "privileges",
    )((self, e) => self.show_sql(e))],
    [exp.Describe, unsupported_args(
      "style",
      "kind",
      "expressions",
      "partition",
      "format",
    )((self, e) => self.describe_sql(e))],
  ]);

  /** py:281 */
  static UNSUPPORTED_TYPES = new Set([
    exp.DType.ARRAY,
    exp.DType.AGGREGATEFUNCTION,
    exp.DType.SIMPLEAGGREGATEFUNCTION,
    exp.DType.BIGSERIAL,
    exp.DType.BPCHAR,
    exp.DType.DATEMULTIRANGE,
    exp.DType.DATERANGE,
    exp.DType.DYNAMIC,
    exp.DType.HLLSKETCH,
    exp.DType.HSTORE,
    exp.DType.IMAGE,
    exp.DType.INET,
    exp.DType.INT128,
    exp.DType.INT256,
    exp.DType.INT4MULTIRANGE,
    exp.DType.INT4RANGE,
    exp.DType.INT8MULTIRANGE,
    exp.DType.INT8RANGE,
    exp.DType.INTERVAL,
    exp.DType.IPADDRESS,
    exp.DType.IPPREFIX,
    exp.DType.IPV4,
    exp.DType.IPV6,
    exp.DType.LIST,
    exp.DType.MAP,
    exp.DType.LOWCARDINALITY,
    exp.DType.MONEY,
    exp.DType.MULTILINESTRING,
    exp.DType.NAME,
    exp.DType.NESTED,
    exp.DType.NOTHING,
    exp.DType.NULL,
    exp.DType.NUMMULTIRANGE,
    exp.DType.NUMRANGE,
    exp.DType.OBJECT,
    exp.DType.RANGE,
    exp.DType.ROWVERSION,
    exp.DType.SERIAL,
    exp.DType.SMALLSERIAL,
    exp.DType.SMALLMONEY,
    exp.DType.SUPER,
    exp.DType.TIMETZ,
    exp.DType.TIMESTAMPNTZ,
    exp.DType.TIMESTAMPLTZ,
    exp.DType.TIMESTAMPTZ,
    exp.DType.TIMESTAMP_NS,
    exp.DType.TSMULTIRANGE,
    exp.DType.TSRANGE,
    exp.DType.TSTZMULTIRANGE,
    exp.DType.TSTZRANGE,
    exp.DType.UINT128,
    exp.DType.UINT256,
    exp.DType.UNION,
    exp.DType.UNKNOWN,
    exp.DType.USERDEFINED,
    exp.DType.UUID,
    exp.DType.VARIANT,
    exp.DType.XML,
    exp.DType.TDIGEST,
  ]);

  /** py:343 */
  static TYPE_MAPPING = new Map([
    ...MySQLGenerator.TYPE_MAPPING,
    [exp.DType.BIGDECIMAL, "DECIMAL"],
    [exp.DType.BIT, "BOOLEAN"],
    [exp.DType.DATE32, "DATE"],
    [exp.DType.DATETIME64, "DATETIME"],
    [exp.DType.DECIMAL32, "DECIMAL"],
    [exp.DType.DECIMAL64, "DECIMAL"],
    [exp.DType.DECIMAL128, "DECIMAL"],
    [exp.DType.DECIMAL256, "DECIMAL"],
    [exp.DType.ENUM8, "ENUM"],
    [exp.DType.ENUM16, "ENUM"],
    [exp.DType.FIXEDSTRING, "TEXT"],
    [exp.DType.GEOMETRY, "GEOGRAPHY"],
    [exp.DType.POINT, "GEOGRAPHYPOINT"],
    [exp.DType.RING, "GEOGRAPHY"],
    [exp.DType.LINESTRING, "GEOGRAPHY"],
    [exp.DType.POLYGON, "GEOGRAPHY"],
    [exp.DType.MULTIPOLYGON, "GEOGRAPHY"],
    [exp.DType.STRUCT, "RECORD"],
    [exp.DType.JSONB, "BSON"],
    [exp.DType.TIMESTAMP, "TIMESTAMP"],
    [exp.DType.TIMESTAMP_S, "TIMESTAMP"],
    [exp.DType.TIMESTAMP_MS, "TIMESTAMP"],
  ]);

  /** py:369 */
  static TYPE_PARAM_SETTINGS = new Map([
    ...MySQLGenerator.TYPE_PARAM_SETTINGS,
    [exp.DType.TIMESTAMP_MS, [[6], []]],
  ]);

  // py:374 https://docs.singlestore.com/cloud/reference/sql-reference/restricted-keywords/list-of-restricted-keywords/
  static RESERVED_KEYWORDS = new Set([
    "abs", "absolute", "access", "account", "acos", "action", "add", "adddate", "addtime",
    "admin", "aes_decrypt", "aes_encrypt", "after", "against", "aggregate", "aggregates",
    "aggregator", "aggregator_id", "aggregator_plan_hash", "aggregators", "algorithm", "all",
    "also", "alter", "always", "analyse", "analyze", "and", "anti_join", "any", "any_value",
    "approx_count_distinct", "approx_count_distinct_accumulate",
    "approx_count_distinct_combine", "approx_count_distinct_estimate",
    "approx_geography_intersects", "approx_percentile", "arghistory", "arrange", "arrangement",
    "array", "as", "asc", "ascii", "asensitive", "asin", "asm", "assertion", "assignment",
    "ast", "asymmetric", "async", "at", "atan", "atan2", "attach", "attribute",
    "authorization", "auto", "auto_increment", "auto_reprovision", "autostats",
    "autostats_cardinality_mode", "autostats_enabled", "autostats_histogram_mode",
    "autostats_sampling", "availability", "avg", "avg_row_length", "avro", "azure",
    "background", "_background_threads_for_cleanup", "backup", "backup_history", "backup_id",
    "backward", "batch", "batches", "batch_interval", "_batch_size_limit", "before", "begin",
    "between", "bigint", "bin", "binary", "_binary", "bit", "bit_and", "bit_count", "bit_or",
    "bit_xor", "blob", "bool", "boolean", "bootstrap", "both", "_bt", "btree", "bucket_count",
    "by", "byte", "byte_length", "cache", "call", "call_for_pipeline", "called", "capture",
    "cascade", "cascaded", "case", "cast", "catalog", "ceil", "ceiling", "chain", "change",
    "char", "character", "characteristics", "character_length", "char_length", "charset",
    "check", "checkpoint", "_check_can_connect", "_check_consistency", "checksum", "_checksum",
    "class", "clear", "client", "client_found_rows", "close", "cluster", "clustered", "cnf",
    "coalesce", "coercibility", "collate", "collation", "collect", "column", "columnar",
    "columns", "columnstore", "columnstore_segment_rows", "comment", "comments", "commit",
    "committed", "_commit_log_tail", "committed", "compact", "compile", "compressed",
    "compression", "concat", "concat_ws", "concurrent", "concurrently", "condition",
    "configuration", "connection", "connection_id", "connections", "config", "constraint",
    "constraints", "content", "continue", "_continue_replay", "conv", "conversion", "convert",
    "convert_tz", "copy", "_core", "cos", "cost", "cot", "count", "create", "credentials",
    "cross", "cube", "csv", "cume_dist", "curdate", "current", "current_catalog",
    "current_date", "current_role", "current_schema", "current_security_groups",
    "current_security_roles", "current_time", "current_timestamp", "current_user", "cursor",
    "curtime", "cycle", "data", "database", "databases", "date", "date_add", "datediff",
    "date_format", "date_sub", "date_trunc", "datetime", "day", "day_hour", "day_microsecond",
    "day_minute", "dayname", "dayofmonth", "dayofweek", "dayofyear", "day_second",
    "deallocate", "dec", "decimal", "declare", "decode", "default", "defaults", "deferrable",
    "deferred", "defined", "definer", "degrees", "delayed", "delay_key_write", "delete",
    "delimiter", "delimiters", "dense_rank", "desc", "describe", "detach", "deterministic",
    "dictionary", "differential", "directory", "disable", "discard", "_disconnect", "disk",
    "distinct", "distinctrow", "distributed_joins", "div", "do", "document", "domain",
    "dot_product", "double", "drop", "_drop_profile", "dual", "dump", "duplicate", "dynamic",
    "earliest", "each", "echo", "election", "else", "elseif", "elt", "enable", "enclosed",
    "encoding", "encrypted", "end", "engine", "engines", "enum", "errors", "escape", "escaped",
    "estimate", "euclidean_distance", "event", "events", "except", "exclude", "excluding",
    "exclusive", "execute", "exists", "exit", "exp", "explain", "extended", "extension",
    "external", "external_host", "external_port", "extract", "extractor", "extractors",
    "extra_join", "_failover", "failed_login_attempts", "failure", "false", "family", "fault",
    "fetch", "field", "fields", "file", "files", "fill", "first", "first_value", "fix_alter",
    "fixed", "float", "float4", "float8", "floor", "flush", "following", "for", "force",
    "force_compiled_mode", "force_interpreter_mode", "foreground", "foreign", "format",
    "forward", "found_rows", "freeze", "from", "from_base64", "from_days", "from_unixtime",
    "fs", "_fsync", "full", "fulltext", "function", "functions", "gc", "gcs", "get_format",
    "_gc", "_gcx", "generate", "geography", "geography_area", "geography_contains",
    "geography_distance", "geography_intersects", "geography_latitude", "geography_length",
    "geography_longitude", "geographypoint", "geography_point", "geography_within_distance",
    "geometry", "geometry_area", "geometry_contains", "geometry_distance", "geometry_filter",
    "geometry_intersects", "geometry_length", "geometrypoint", "geometry_point",
    "geometry_within_distance", "geometry_x", "geometry_y", "global",
    "_global_version_timestamp", "grant", "granted", "grants", "greatest", "group", "grouping",
    "groups", "group_concat", "gzip", "handle", "handler", "hard_cpu_limit_percentage", "hash",
    "has_temp_tables", "having", "hdfs", "header", "heartbeat_no_logging", "hex", "highlight",
    "high_priority", "hold", "holding", "host", "hosts", "hour", "hour_microsecond",
    "hour_minute", "hour_second", "identified", "identity", "if", "ifnull", "ignore", "ilike",
    "immediate", "immutable", "implicit", "import", "in", "including", "increment",
    "incremental", "index", "indexes", "inet_aton", "inet_ntoa", "inet6_aton", "inet6_ntoa",
    "infile", "inherit", "inherits", "_init_profile", "init", "initcap", "initialize",
    "initially", "inject", "inline", "inner", "inout", "input", "insensitive", "insert",
    "insert_method", "instance", "instead", "instr", "int", "int1", "int2", "int3", "int4",
    "int8", "integer", "_internal_dynamic_typecast", "interpreter_mode", "intersect",
    "interval", "into", "invoker", "is", "isnull", "isolation", "iterate", "join", "json",
    "json_agg", "json_array_contains_double", "json_array_contains_json",
    "json_array_contains_string", "json_array_push_double", "json_array_push_json",
    "json_array_push_string", "json_delete_key", "json_extract_double", "json_extract_json",
    "json_extract_string", "json_extract_bigint", "json_get_type", "json_length",
    "json_set_double", "json_set_json", "json_set_string", "json_splice_double",
    "json_splice_json", "json_splice_string", "kafka", "key", "key_block_size", "keys", "kill",
    "killall", "label", "lag", "language", "large", "last", "last_day", "last_insert_id",
    "last_value", "lateral", "latest", "lc_collate", "lc_ctype", "lcase", "lead", "leading",
    "leaf", "leakproof", "least", "leave", "leaves", "left", "length", "level", "license",
    "like", "limit", "lines", "listen", "llvm", "ln", "load", "loaddata_where", "_load",
    "local", "localtime", "localtimestamp", "locate", "location", "lock", "log", "log10",
    "log2", "long", "longblob", "longtext", "loop", "lower", "low_priority", "lpad", "_ls",
    "ltrim", "lz4", "management", "_management_thread", "mapping", "master", "match",
    "materialized", "max", "maxvalue", "max_concurrency", "max_errors",
    "max_partitions_per_batch", "max_queue_depth", "max_retries_per_batch_partition",
    "max_rows", "mbc", "md5", "mpl", "median", "mediumblob", "mediumint", "mediumtext",
    "member", "memory", "memory_percentage", "_memsql_table_id_lookup", "memsql",
    "memsql_deserialize", "memsql_imitating_kafka", "memsql_serialize", "merge", "metadata",
    "microsecond", "middleint", "min", "min_rows", "minus", "minute", "minute_microsecond",
    "minute_second", "minvalue", "mod", "mode", "model", "modifies", "modify", "month",
    "monthname", "months_between", "move", "mpl", "names", "named", "namespace", "national",
    "natural", "nchar", "next", "no", "node", "none", "no_query_rewrite", "noparam", "not",
    "nothing", "notify", "now", "nowait", "no_write_to_binlog", "no_query_rewrite", "norely",
    "nth_value", "ntile", "null", "nullcols", "nullif", "nulls", "numeric", "nvarchar",
    "object", "octet_length", "of", "off", "offline", "offset", "offsets", "oids", "on",
    "online", "only", "open", "operator", "optimization", "optimize", "optimizer",
    "optimizer_state", "option", "options", "optionally", "or", "order", "ordered_serialize",
    "orphan", "out", "out_of_order", "outer", "outfile", "over", "overlaps", "overlay",
    "owned", "owner", "pack_keys", "paired", "parser", "parquet", "partial", "partition",
    "partition_id", "partitioning", "partitions", "passing", "password", "password_lock_time",
    "parser", "pause", "_pause_replay", "percent_rank", "percentile_cont", "percentile_disc",
    "periodic", "persisted", "pi", "pipeline", "pipelines", "pivot", "placing", "plan",
    "plans", "plancache", "plugins", "pool", "pools", "port", "position", "pow", "power",
    "preceding", "precision", "prepare", "prepared", "preserve", "primary", "prior",
    "privileges", "procedural", "procedure", "procedures", "process", "processlist", "profile",
    "profiles", "program", "promote", "proxy", "purge", "quarter", "queries", "query",
    "query_timeout", "queue", "quote", "radians", "rand", "range", "rank", "read", "_read",
    "reads", "real", "reassign", "rebalance", "recheck", "record", "recursive", "redundancy",
    "redundant", "ref", "reference", "references", "refresh", "regexp", "reindex", "relative",
    "release", "reload", "rely", "remote", "remove", "rename", "repair", "_repair_table",
    "repeat", "repeatable", "_repl", "_reprovisioning", "replace", "replica", "replicate",
    "replicating", "replication", "durability", "require", "resource", "resource_pool",
    "reset", "restart", "restore", "restrict", "result", "_resurrect", "retry", "return",
    "returning", "returns", "reverse", "revoke", "rg_pool", "right", "right_anti_join",
    "right_semi_join", "right_straight_join", "rlike", "role", "roles", "rollback", "rollup",
    "round", "routine", "row", "row_count", "row_format", "row_number", "rows", "rowstore",
    "rule", "rpad", "_rpc", "rtrim", "running", "s3", "safe", "save", "savepoint", "scalar",
    "schema", "schemas", "schema_binding", "scroll", "search", "second", "second_microsecond",
    "sec_to_time", "security", "select", "semi_join", "_send_threads", "sensitive",
    "separator", "sequence", "sequences", "serial", "serializable", "series", "service_user",
    "server", "session", "session_user", "set", "setof", "security_lists_intersect", "sha",
    "sha1", "sha2", "shard", "sharded", "sharded_id", "share", "show", "shutdown", "sigmoid",
    "sign", "signal", "similar", "simple", "site", "signed", "sin", "skip", "skipped_batches",
    "sleep", "_sleep", "smallint", "snapshot", "_snapshot", "_snapshots",
    "soft_cpu_limit_percentage", "some", "soname", "sparse", "spatial", "spatial_check_index",
    "specific", "split", "sql", "sql_big_result", "sql_buffer_result", "sql_cache",
    "sql_calc_found_rows", "sqlexception", "sql_mode", "sql_no_cache", "sql_no_logging",
    "sql_small_result", "sqlstate", "sqlwarning", "sqrt", "ssl", "stable", "standalone",
    "start", "starting", "state", "statement", "statistics", "stats", "status", "std",
    "stddev", "stddev_pop", "stddev_samp", "stdin", "stdout", "stop", "storage", "str_to_date",
    "straight_join", "strict", "string", "strip", "subdate", "substr", "substring",
    "substring_index", "success", "sum", "super", "symmetric", "sync_snapshot", "sync",
    "_sync", "_sync2", "_sync_partitions", "_sync_snapshot", "synchronize", "sysid", "system",
    "table", "table_checksum", "tables", "tablespace", "tags", "tan", "target_size", "task",
    "temp", "template", "temporary", "temptable", "_term_bump", "terminate", "terminated",
    "test", "text", "then", "time", "timediff", "time_bucket", "time_format", "timeout",
    "timestamp", "timestampadd", "timestampdiff", "timezone", "time_to_sec", "tinyblob",
    "tinyint", "tinytext", "to", "to_base64", "to_char", "to_date", "to_days", "to_json",
    "to_number", "to_seconds", "to_timestamp", "tracelogs", "traditional", "trailing",
    "transform", "transaction", "_transactions_experimental", "treat", "trigger", "triggers",
    "trim", "true", "trunc", "truncate", "trusted", "two_phase", "_twopcid", "type", "types",
    "ucase", "unbounded", "uncommitted", "undefined", "undo", "unencrypted", "unenforced",
    "unhex", "unhold", "unicode", "union", "unique", "_unittest", "unix_timestamp", "unknown",
    "unlisten", "_unload", "unlock", "unlogged", "unpivot", "unsigned", "until", "update",
    "upgrade", "upper", "usage", "use", "user", "users", "using", "utc_date", "utc_time",
    "utc_timestamp", "_utf8", "vacuum", "valid", "validate", "validator", "value", "values",
    "varbinary", "varchar", "varcharacter", "variables", "variadic", "variance", "var_pop",
    "var_samp", "varying", "vector_sub", "verbose", "version", "view", "void", "volatile",
    "voting", "wait", "_wake", "warnings", "week", "weekday", "weekofyear", "when", "where",
    "while", "whitespace", "window", "with", "without", "within", "_wm_heartbeat", "work",
    "workload", "wrapper", "write", "xact_id", "xor", "year", "year_month", "yes", "zerofill",
    "zone",
  ]);

  /** py:1428 */
  jsonextractscalar_sql(expression) {
    const json_type = expression.args.json_type;
    const func_name = json_type == null ? "JSON_EXTRACT_JSON" : `JSON_EXTRACT_${json_type}`;
    return json_extract_segments(func_name)(this, expression);
  }

  /** py:1433 */
  jsonbextractscalar_sql(expression) {
    const json_type = expression.args.json_type;
    const func_name = json_type == null ? "BSON_EXTRACT_BSON" : `BSON_EXTRACT_${json_type}`;
    return json_extract_segments(func_name)(this, expression);
  }

  /** py:1438 */
  jsonextractarray_sql(expression) {
    this.unsupported("Arrays are not supported in SingleStore");
    return this.function_fallback_sql(expression);
  }

  /** py:1442 */
  jsonvalue_sql(expression) {
    if (expression.args.on_condition) {
      this.unsupported("JSON_VALUE does not support on_condition");
    }
    let res = new exp.JSONExtractScalar({
      this: expression.this,
      expression: expression.args.path,
      json_type: "STRING",
    });

    const returning = expression.args.returning;
    if (returning != null) {
      res = new exp.Cast({ this: res, to: returning });
    }

    return this.sql(res);
  }

  /** py:1457 */
  all_sql(expression) {
    this.unsupported("ALL subquery predicate is not supported in SingleStore");
    return super.all_sql(expression);
  }

  /** py:1461 */
  jsonarraycontains_sql(expression) {
    const json_type = expression.text("json_type").toUpperCase();

    if (json_type) {
      return this.func(`JSON_ARRAY_CONTAINS_${json_type}`, expression.expression, expression.this);
    }

    return this.func(
      "JSON_ARRAY_CONTAINS_JSON",
      expression.expression,
      this.func("TO_JSON", expression.this),
    );
  }

  /** py:1475 */
  datatype_sql(expression) {
    for (const arg_name of ["kind", "values"]) {
      if (expression.args[arg_name]) {
        this.unsupported(`DATATYPE does not support ${arg_name}`);
      }
    }
    if (expression.args.nested && !expression.isType(exp.DType.STRUCT)) {
      this.unsupported(
        `Argument 'nested' is not supported for representation of '${expression.this.value}' in SingleStore`,
      );
    }

    if (expression.isType(exp.DType.VARBINARY) && !expression.expressions.length) {
      // `VARBINARY` must always have a size - if it doesn't, we always generate `BLOB`
      return "BLOB";
    }
    if (expression.isType(
      exp.DType.DECIMAL32,
      exp.DType.DECIMAL64,
      exp.DType.DECIMAL128,
      exp.DType.DECIMAL256,
    )) {
      // py:1493,1504-1507 — `self.expressions(..., flat=True)` never returns `None`
      // (it returns `""` when `expressions` is empty — same in `src/generator.js`),
      // so `if scale is not None` is unconditionally true upstream and `scale[0]`
      // indexes the FIRST CHARACTER of the flat-joined SQL string, not the first
      // element of a list. Faithful, not "fixed": a multi-digit scale (e.g. `12`)
      // is truncated to its first digit, and an absent scale (`scale === ""`)
      // indexes past the end — Python raises `IndexError` there, JS instead reads
      // `undefined` (ported as-is; `scale[0]` on `""` is `undefined` in JS, not a
      // thrown error, a genuine cross-language divergence for that corner only).
      const scale = this.expressions(expression, null, { flat: true });

      let precision;
      if (expression.isType(exp.DType.DECIMAL32)) precision = "9";
      else if (expression.isType(exp.DType.DECIMAL64)) precision = "18";
      else if (expression.isType(exp.DType.DECIMAL128)) precision = "38";
      else precision = "65"; // 65 is a maximum precision supported in SingleStore

      return `DECIMAL(${precision}, ${scale[0]})`;
    }
    if (expression.isType(exp.DType.VECTOR)) {
      const expressions = expression.expressions;
      if (expressions.length === 2) {
        let type_name = this.sql(expressions[0]);
        if (this.dialect.INVERSE_VECTOR_TYPE_ALIASES.has(type_name)) {
          type_name = this.dialect.INVERSE_VECTOR_TYPE_ALIASES.get(type_name);
        }

        return `VECTOR(${this.sql(expressions[1])}, ${type_name})`;
      }
    }

    return super.datatype_sql(expression);
  }

  /** py:1519 */
  collate_sql(expression) {
    // SingleStore does not support setting a collation for column in the SELECT query,
    // so we cast column to a LONGTEXT type with specific collation
    return this.binary(expression, ":> LONGTEXT COLLATE");
  }

  /** py:1524 */
  currentdate_sql(expression) {
    const timezone = expression.this;
    if (timezone) {
      if (timezone instanceof exp.Literal && timezone.name.toLowerCase() === "utc") {
        return this.func("UTC_DATE");
      }
      this.unsupported("CurrentDate with timezone is not supported in SingleStore");
    }

    return this.func("CURRENT_DATE");
  }

  /** py:1533 */
  currenttime_sql(expression) {
    const arg = expression.this;
    if (arg) {
      if (arg instanceof exp.Literal && arg.name.toLowerCase() === "utc") {
        return this.func("UTC_TIME");
      }
      if (arg instanceof exp.Literal && arg.isNumber) {
        return this.func("CURRENT_TIME", arg);
      }
      this.unsupported("CurrentTime with timezone is not supported in SingleStore");
    }

    return this.func("CURRENT_TIME");
  }

  /** py:1544 */
  currenttimestamp_sql(expression) {
    const arg = expression.this;
    if (arg) {
      if (arg instanceof exp.Literal && arg.name.toLowerCase() === "utc") {
        return this.func("UTC_TIMESTAMP");
      }
      if (arg instanceof exp.Literal && arg.isNumber) {
        return this.func("CURRENT_TIMESTAMP", arg);
      }
      this.unsupported("CurrentTimestamp with timezone is not supported in SingleStore");
    }

    return this.func("CURRENT_TIMESTAMP");
  }

  /** py:1555 */
  standardhash_sql(expression) {
    const hash_function = expression.expression;
    if (hash_function == null) {
      return this.func("SHA", expression.this);
    }
    if (hash_function instanceof exp.Literal) {
      if (hash_function.name.toLowerCase() === "sha") return this.func("SHA", expression.this);
      if (hash_function.name.toLowerCase() === "md5") return this.func("MD5", expression.this);

      this.unsupported(`${hash_function.this} hash method is not supported in SingleStore`);
      return this.func("SHA", expression.this);
    }

    this.unsupported("STANDARD_HASH function is not supported in SingleStore");
    return this.func("SHA", expression.this);
  }

  /** py:1571 */
  truncatetable_sql(expression) {
    for (const arg_name of ["is_database", "exists", "cluster", "identity", "option", "partition"]) {
      if (expression.args[arg_name]) {
        this.unsupported(`TRUNCATE TABLE does not support ${arg_name}`);
      }
    }
    const statements = [];
    for (const table of expression.expressions) {
      statements.push(`TRUNCATE ${this.sql(table)}`);
    }

    return statements.join("; ");
  }

  /** py:1581 */
  renamecolumn_sql(expression) {
    if (expression.args.exists) {
      this.unsupported("RENAME COLUMN does not support exists");
    }
    const old_column = this.sql(expression, "this");
    const new_column = this.sql(expression, "to");
    return `CHANGE ${old_column} ${new_column}`;
  }

  /** py:1588 */
  altercolumn_sql(expression) {
    for (const arg_name of ["drop", "comment", "visible", "using"]) {
      if (expression.args[arg_name]) {
        this.unsupported(`ALTER COLUMN does not support ${arg_name}`);
      }
    }
    const alter = super.altercolumn_sql(expression);

    let collate = this.sql(expression, "collate");
    collate = collate ? ` COLLATE ${collate}` : "";
    return `${alter}${collate}`;
  }

  /** py:1598 */
  computedcolumnconstraint_sql(expression) {
    const this_ = this.sql(expression, "this");
    const not_null = expression.args.not_null ? " NOT NULL" : "";
    const type = this.sql(expression, "data_type") || "AUTO";
    return `AS ${this_} PERSISTED ${type}${not_null}`;
  }
}
