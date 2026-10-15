// py: sqlglot/generators/doris.py @ 91119bc — WHOLE FILE (619 LOC), AIR-2286 (epic
// AIR-2272, "12.1 MySQL family" part 2: starrocks + doris, children of R104's
// `MySQLGenerator`).
//
// `class DorisGenerator(MySQLGenerator)` — the WRITE-side counterpart of
// `src/parsers/doris.js` (grammar) and `src/dialects/doris.js` (settings), same
// three-file split every prior dialect uses.

import * as exp from "../expressions/index.js";
import {
  approx_count_distinct_sql,
  property_sql,
  rename_func,
  time_format,
  weekstart_unit_to_str,
} from "../dialects/dialect.js";
import { MySQLGenerator } from "./mysql.js";

/** py: sqlglot/generators/doris.py:16 */
function _lag_lead_sql(self, expression) {
  return self.func(
    expression instanceof exp.Lag ? "LAG" : "LEAD",
    expression.this,
    expression.args.offset || exp.Literal.number(1),
    expression.args.default || exp.null(),
  );
}

/** py: sqlglot/generators/doris.py:25 */
export class DorisGenerator extends MySQLGenerator {
  static LAST_DAY_SUPPORTS_DATE_PART = false;
  static SUPPORTS_ALTER_COLUMN_NULLABILITY = false;
  static VARCHAR_REQUIRES_SIZE = false;
  static WITH_PROPERTIES_PREFIX = "PROPERTIES";
  static RENAME_TABLE_WITH_DB = false;
  static UPDATE_STATEMENT_SUPPORTS_FROM = true;

  /** py:33 */
  static TYPE_MAPPING = new Map([
    ...MySQLGenerator.TYPE_MAPPING,
    [exp.DType.TEXT, "STRING"],
    [exp.DType.TIMESTAMP, "DATETIME"],
    [exp.DType.TIMESTAMPTZ, "DATETIME"],
  ]);

  /** py:40 */
  static PROPERTIES_LOCATION = new Map([
    ...MySQLGenerator.PROPERTIES_LOCATION,
    [exp.UniqueKeyProperty, exp.Properties.Location.POST_SCHEMA],
    [exp.PartitionedByProperty, exp.Properties.Location.POST_SCHEMA],
    [exp.BuildProperty, exp.Properties.Location.POST_SCHEMA],
  ]);

  static CAST_MAPPING = new Map();
  static TIMESTAMP_FUNC_TYPES = new Set();

  /** py:50 */
  static TRANSFORMS = new Map([
    ...MySQLGenerator.TRANSFORMS,
    [exp.AddMonths, rename_func("MONTHS_ADD")],
    [exp.ApproxDistinct, approx_count_distinct_sql],
    [exp.ArgMax, rename_func("MAX_BY")],
    [exp.ArgMin, rename_func("MIN_BY")],
    [exp.ArrayAgg, rename_func("COLLECT_LIST")],
    [exp.ArrayToString, rename_func("ARRAY_JOIN")],
    [exp.ArrayUniqueAgg, rename_func("COLLECT_SET")],
    [exp.CurrentDate, (self) => self.func("CURRENT_DATE")],
    [exp.CurrentTimestamp, (self) => self.func("NOW")],
    [exp.DateTrunc, (self, e) => self.func("DATE_TRUNC", e.this, weekstart_unit_to_str(self, e))],
    [exp.EuclideanDistance, rename_func("L2_DISTANCE")],
    [exp.GroupConcat, (self, e) => self.func(
      "GROUP_CONCAT", e.this, e.args.separator || exp.Literal.string(","),
    )],
    [exp.JSONExtractScalar, (self, e) => self.func("JSON_EXTRACT", e.this, e.expression)],
    [exp.Lag, _lag_lead_sql],
    [exp.Lead, _lag_lead_sql],
    [exp.Map, rename_func("ARRAY_MAP")],
    [exp.Property, property_sql],
    [exp.RegexpLike, rename_func("REGEXP")],
    [exp.RegexpSplit, rename_func("SPLIT_BY_STRING")],
    [exp.SchemaCommentProperty, (self, e) => self.naked_property(e)],
    [exp.Split, rename_func("SPLIT_BY_STRING")],
    [exp.StringToArray, rename_func("SPLIT_BY_STRING")],
    [exp.StrToUnix, (self, e) => self.func("UNIX_TIMESTAMP", e.this, self.format_time(e))],
    [exp.TimeStrToDate, rename_func("TO_DATE")],
    [exp.TsOrDsAdd, (self, e) => self.func("DATE_ADD", e.this, e.expression)],
    [exp.TsOrDsToDate, (self, e) => self.func("TO_DATE", e.this)],
    [exp.TimeToUnix, rename_func("UNIX_TIMESTAMP")],
    [exp.TimestampTrunc, (self, e) => self.func("DATE_TRUNC", e.this, weekstart_unit_to_str(self, e))],
    [exp.UnixToStr, (self, e) => self.func("FROM_UNIXTIME", e.this, time_format("doris")(self, e))],
    [exp.UnixToTime, rename_func("FROM_UNIXTIME")],
  ]);

  // https://github.com/apache/doris/blob/e4f41dbf1ec03f5937fdeba2ee1454a20254015b/fe/fe-core/src/main/antlr4/org/apache/doris/nereids/DorisLexer.g4#L93
  /** py:93 */
  static RESERVED_KEYWORDS = new Set([
    "account_lock", "account_unlock", "add", "adddate", "admin", "after", "agg_state",
    "aggregate", "alias", "all", "alter", "analyze", "analyzed", "and", "anti",
    "append", "array", "array_range", "as", "asc", "at", "authors", "auto",
    "auto_increment", "backend", "backends", "backup", "begin", "belong", "between",
    "bigint", "bin", "binary", "binlog", "bitand", "bitmap", "bitmap_union", "bitor",
    "bitxor", "blob", "boolean", "brief", "broker", "buckets", "build", "builtin",
    "bulk", "by", "cached", "call", "cancel", "case", "cast", "catalog", "catalogs",
    "chain", "char", "character", "charset", "check", "clean", "cluster", "clusters",
    "collate", "collation", "collect", "column", "columns", "comment", "commit",
    "committed", "compact", "complete", "config", "connection", "connection_id",
    "consistent", "constraint", "constraints", "convert", "copy", "count", "create",
    "creation", "cron", "cross", "cube", "current", "current_catalog", "current_date",
    "current_time", "current_timestamp", "current_user", "data", "database",
    "databases", "date", "date_add", "date_ceil", "date_diff", "date_floor",
    "date_sub", "dateadd", "datediff", "datetime", "datetimev2", "datev2",
    "datetimev1", "datev1", "day", "days_add", "days_sub", "decimal", "decimalv2",
    "decimalv3", "decommission", "default", "deferred", "delete", "demand", "desc",
    "describe", "diagnose", "disk", "distinct", "distinctpc", "distinctpcsa",
    "distributed", "distribution", "div", "do", "doris_internal_table_id", "double",
    "drop", "dropp", "dual", "duplicate", "dynamic", "else", "enable", "encryptkey",
    "encryptkeys", "end", "ends", "engine", "engines", "enter", "errors", "events",
    "every", "except", "exclude", "execute", "exists", "expired", "explain", "export",
    "extended", "external", "extract", "failed_login_attempts", "false", "fast",
    "feature", "fields", "file", "filter", "first", "float", "follower", "following",
    "for", "foreign", "force", "format", "free", "from", "frontend", "frontends",
    "full", "function", "functions", "generic", "global", "grant", "grants", "graph",
    "group", "grouping", "groups", "hash", "having", "hdfs", "help", "histogram",
    "hll", "hll_union", "hostname", "hour", "hub", "identified", "if", "ignore",
    "immediate", "in", "incremental", "index", "indexes", "infile", "inner", "insert",
    "install", "int", "integer", "intermediate", "intersect", "interval", "into",
    "inverted", "ipv4", "ipv6", "is", "is_not_null_pred", "is_null_pred", "isnull",
    "isolation", "job", "jobs", "join", "json", "jsonb", "key", "keys", "kill",
    "label", "largeint", "last", "lateral", "ldap", "ldap_admin_password", "left",
    "less", "level", "like", "limit", "lines", "link", "list", "load", "local",
    "localtime", "localtimestamp", "location", "lock", "logical", "low_priority",
    "manual", "map", "match", "match_all", "match_any", "match_phrase",
    "match_phrase_edge", "match_phrase_prefix", "match_regexp", "materialized",
    "max", "maxvalue", "memo", "merge", "migrate", "migrations", "min", "minus",
    "minute", "modify", "month", "mtmv", "name", "names", "natural", "negative",
    "never", "next", "ngram_bf", "no", "non_nullable", "not", "null", "nulls",
    "observer", "of", "offset", "on", "only", "open", "optimized", "or", "order",
    "outer", "outfile", "over", "overwrite", "parameter", "parsed", "partition",
    "partitions", "password", "password_expire", "password_history",
    "password_lock_time", "password_reuse", "path", "pause", "percent", "period",
    "permissive", "physical", "plan", "process", "plugin", "plugins", "policy",
    "preceding", "prepare", "primary", "proc", "procedure", "processlist", "profile",
    "properties", "property", "quantile_state", "quantile_union", "query", "quota",
    "random", "range", "read", "real", "rebalance", "recover", "recycle", "refresh",
    "references", "regexp", "release", "rename", "repair", "repeatable", "replace",
    "replace_if_not_null", "replica", "repositories", "repository", "resource",
    "resources", "restore", "restrictive", "resume", "returns", "revoke", "rewritten",
    "right", "rlike", "role", "roles", "rollback", "rollup", "routine", "row", "rows",
    "s3", "sample", "schedule", "scheduler", "schema", "schemas", "second", "select",
    "semi", "sequence", "serializable", "session", "set", "sets", "shape", "show",
    "signed", "skew", "smallint", "snapshot", "soname", "split", "sql_block_rule",
    "start", "starts", "stats", "status", "stop", "storage", "stream", "streaming",
    "string", "struct", "subdate", "sum", "superuser", "switch", "sync", "system",
    "table", "tables", "tablesample", "tablet", "tablets", "task", "tasks",
    "temporary", "terminated", "text", "than", "then", "time", "timestamp",
    "timestampadd", "timestampdiff", "tinyint", "to", "transaction", "trash", "tree",
    "triggers", "trim", "true", "truncate", "type", "type_cast", "types", "unbounded",
    "uncommitted", "uninstall", "union", "unique", "unlock", "unsigned", "update",
    "use", "user", "using", "value", "values", "varchar", "variables", "variant",
    "vault", "verbose", "version", "view", "warnings", "week", "when", "where",
    "whitelist", "with", "work", "workload", "write", "xor", "year",
  ]);

  /** py:566 */
  uniquekeyproperty_sql(expression, prefix = "UNIQUE KEY") {
    const create_stmt = expression.findAncestor(exp.Create);
    if (create_stmt && create_stmt.args.properties.find(exp.MaterializedProperty)) {
      return super.uniquekeyproperty_sql(expression, "KEY");
    }

    return super.uniquekeyproperty_sql(expression);
  }

  /** py:575 */
  partitionrange_sql(expression) {
    const name = this.sql(expression, "this");
    const values = expression.expressions;

    if (values.length !== 1) {
      // Multiple values: use VALUES [ ... )
      let values_sql;
      if (values.length && Array.isArray(values[0])) {
        values_sql = values.map((inner) => `(${inner.map((v) => this.sql(v)).join(", ")})`).join(", ");
      } else {
        values_sql = values.map((v) => `(${this.sql(v)})`).join(", ");
      }

      return `PARTITION ${name} VALUES [${values_sql})`;
    }

    return `PARTITION ${name} VALUES LESS THAN (${this.sql(values[0])})`;
  }

  /** py:592 */
  partitionbyrangepropertydynamic_sql(expression) {
    // Generates: FROM ("start") TO ("end") INTERVAL N UNIT
    const start = this.sql(expression, "start");
    const end = this.sql(expression, "end");
    const every = expression.args.every;

    let interval;
    if (every) {
      const number = this.sql(every, "this");
      interval = `INTERVAL ${number} ${this.sql(every, "unit")}`;
    } else {
      interval = "";
    }

    return `FROM (${start}) TO (${end}) ${interval}`;
  }

  /** py:608 */
  partitionedbyproperty_sql(expression) {
    const this_ = expression.this;
    if (this_ instanceof exp.Schema) {
      return `PARTITION BY (${this.expressions(this_, null, { flat: true })})`;
    }
    return `PARTITION BY (${this.sql(this_)})`;
  }

  /** py:614 — avoid the AS keyword in UPDATE and DELETE statements. */
  table_sql(expression, sep = " AS ") {
    const ancestor = expression.findAncestor(exp.Update, exp.Delete, exp.Select);
    if (!(ancestor instanceof exp.Select)) sep = " ";
    return super.table_sql(expression, sep);
  }
}
