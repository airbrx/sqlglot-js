// py: sqlglot/generators/redshift.py — `class RedshiftGenerator(PostgresGenerator)`.
//
// Last link of the Redshift port (parser -> dialect settings -> generator), extending
// the already-real `PostgresGenerator` (src/generators/postgres.js) at a single level,
// same shape `dialects/redshift.js` uses for its own settings class. `src/dialects/
// redshift.js` declares `static Generator = RedshiftGenerator` once this file exists,
// closing that file's own deferred-Generator note.
//
// THREE base-`transforms.js`/`dialects/dialect.js` GAPS CLOSED ALONGSIDE THIS FILE,
// same "Generator chain surfaces base-Generator gaps" precedent `generators/postgres.js`
// documents — this port reaches them via Redshift's own `TRANSFORMS[exp.Select]`
// pipeline, so they get finished here rather than staying `NotPorted` stubs with a new
// caller (see `transforms.js`'s header for the exact ranges added):
//   - `transforms.js`'s `unnest_generate_date_array_using_recursive_cte` and
//     `eliminate_window_clause` — neither has any unported dependency.
//   - `transforms.js`'s `unqualify_unnest` — its `find_all_in_scope` call is real,
//     via `optimizer/scope.js`'s already-landed Tier A `findAllInScope`.
//   - `dialects/dialect.js`'s `no_tablesample_sql`, `concat_to_dpipe_sql`,
//     `concat_ws_to_dpipe_sql`, `generatedasidentitycolumnconstraint_sql` — plain
//     module-level helpers upstream, ported alongside this file the same way
//     `array_concat_sql`/`date_delta_sql`/etc. were for earlier dialects.
//
// ONE REMAINING GAP, a live `NotPorted` throw rather than an approximation, same
// precedent as `generators/postgres.js`'s `_round_sql`/`unnest_sql`: `respectnulls_sql`
// calls the BASE `Generator.respectnulls_sql` directly (bypassing Postgres's own
// "unsupported" override, exactly as upstream's `Generator.respectnulls_sql(self,
// expression)` does) — and the base method is itself still a `NotPorted` stub
// (`src/generator.js:4430`), so this is reached rather than invented. `ignorenulls_sql`
// takes the identical shape but does NOT throw: the base's `_embed_ignore_nulls` only
// hits its own `NotPorted` branch when `IGNORE_NULLS_IN_FUNC` is set, which neither
// Postgres nor Redshift turns on.
//
// Every setting below is diffed value-by-value against CPython by
// `spike/p5/fuzz_dialect_generate.mjs`'s REDSHIFT row.

import * as exp from "../expressions/index.js";
import { Generator } from "../generator.js";
import * as transforms from "../transforms.js";
import {
  array_concat_sql,
  concat_to_dpipe_sql,
  concat_ws_to_dpipe_sql,
  date_delta_sql,
  generatedasidentitycolumnconstraint_sql,
  json_extract_segments,
  no_tablesample_sql,
  rename_func,
} from "../dialects/dialect.js";
import { PostgresGenerator } from "./postgres.js";

/** py: sqlglot/generators/redshift.py:20 `class RedshiftGenerator(PostgresGenerator)`. */
export class RedshiftGenerator extends PostgresGenerator {
  static LOCKING_READS_SUPPORTED = false;
  static QUERY_HINTS = false;
  static VALUES_AS_TABLE = false;
  static TZ_TO_WITH_TIME_ZONE = true;
  static NVL2_SUPPORTED = true;
  static LAST_DAY_SUPPORTS_DATE_PART = false;
  static CAN_IMPLEMENT_ARRAY_ANY = false;
  static MULTI_ARG_DISTINCT = true;
  static COPY_PARAMS_ARE_WRAPPED = false;
  static HEX_FUNC = "TO_HEX";
  static PARSE_JSON_NAME = "JSON_PARSE";
  static ARRAY_CONCAT_IS_VAR_LEN = false;
  static SUPPORTS_CONVERT_TIMEZONE = true;
  static EXCEPT_INTERSECT_SUPPORT_ALL_CLAUSE = false;
  static SUPPORTS_MEDIAN = true;
  static ALTER_SET_TYPE = "TYPE";
  static SUPPORTS_DECODE_CASE = true;
  static SUPPORTS_BETWEEN_FLAGS = false;
  static LIMIT_FETCH = "LIMIT";
  static STAR_EXCEPT = "EXCLUDE";
  static STAR_EXCLUDE_REQUIRES_DERIVED_TABLE = false;

  // Redshift doesn't have `WITH` as part of their with_properties so we remove it
  static WITH_PROPERTIES_PREFIX = " ";

  static TYPE_MAPPING = new Map([
    ...PostgresGenerator.TYPE_MAPPING,
    [exp.DType.BINARY, "VARBYTE"],
    [exp.DType.BLOB, "VARBYTE"],
    [exp.DType.INT, "INTEGER"],
    [exp.DType.TIMETZ, "TIME"],
    [exp.DType.TIMESTAMPTZ, "TIMESTAMP"],
    [exp.DType.VARBINARY, "VARBYTE"],
    [exp.DType.ROWVERSION, "VARBYTE"],
  ]);

  // py:57 `{**{k: v for k, v in PostgresGenerator.TRANSFORMS.items() if k not in {...}}, ...}`
  static TRANSFORMS = new Map([
    ...[...PostgresGenerator.TRANSFORMS].filter(([k]) => ![
      exp.Pivot,
      exp.ParseJSON,
      exp.AnyValue,
      exp.LastDay,
      exp.SHA2,
      exp.Getbit,
      exp.Round,
      exp.TryCast,
    ].includes(k)),
    [exp.ArrayConcat, array_concat_sql("ARRAY_CONCAT")],
    [exp.Concat, concat_to_dpipe_sql],
    [exp.ConcatWs, concat_ws_to_dpipe_sql],
    [exp.ApproxDistinct, (self, e) => `APPROXIMATE COUNT(DISTINCT ${self.sql(e, "this")})`],
    [exp.CurrentTimestamp, (self, e) => (e.args.sysdate ? "SYSDATE" : "GETDATE()")],
    [exp.CurrentUserId, () => "CURRENT_USER_ID"],
    [exp.DateAdd, date_delta_sql("DATEADD")],
    [exp.DateDiff, date_delta_sql("DATEDIFF")],
    [exp.DistKeyProperty, (self, e) => self.func("DISTKEY", e.this)],
    [exp.DistStyleProperty, (self, e) => self.naked_property(e)],
    [exp.Explode, (self, e) => self.explode_sql(e)],
    [exp.FarmFingerprint, rename_func("FARMFINGERPRINT64")],
    [exp.FromBase, rename_func("STRTOL")],
    [exp.GeneratedAsIdentityColumnConstraint, generatedasidentitycolumnconstraint_sql],
    [exp.JSONExtract, json_extract_segments("JSON_EXTRACT_PATH_TEXT")],
    [exp.JSONExtractScalar, json_extract_segments("JSON_EXTRACT_PATH_TEXT")],
    [exp.GroupConcat, rename_func("LISTAGG")],
    [exp.Hex, (self, e) => self.func("UPPER", self.func("TO_HEX", self.sql(e, "this")))],
    [exp.RegexpExtract, rename_func("REGEXP_SUBSTR")],
    [
      exp.Select,
      transforms.preprocess([
        transforms.eliminate_window_clause,
        transforms.eliminate_distinct_on,
        transforms.eliminate_semi_and_anti_joins,
        transforms.unqualify_unnest,
        transforms.unnest_generate_date_array_using_recursive_cte,
      ]),
    ],
    [exp.SortKeyProperty, (self, e) => (
      `${e.args.compound ? "COMPOUND " : ""}SORTKEY(${self.format_args(...e.this)})`
    )],
    [exp.StartsWith, (self, e) => `${self.sql(e.this)} LIKE ${self.sql(e.expression)} || '%'`],
    [exp.StringToArray, rename_func("SPLIT_TO_ARRAY")],
    [exp.TableSample, no_tablesample_sql],
    [exp.TsOrDsAdd, date_delta_sql("DATEADD")],
    [exp.TsOrDsDiff, date_delta_sql("DATEDIFF")],
    [exp.UnixToTime, (self, e) => self._unix_to_time_sql(e)],
    [exp.SHA2Digest, (self, e) => self.func("SHA2", e.this, e.args.length || exp.Literal.number(256))],
  ]);

  static RESERVED_KEYWORDS = new Set([
    "aes128", "aes256", "all", "allowoverwrite", "analyse", "analyze", "and", "any",
    "array", "as", "asc", "authorization", "az64", "backup", "between", "binary",
    "blanksasnull", "both", "bytedict", "bzip2", "case", "cast", "check", "collate",
    "column", "constraint", "create", "credentials", "cross", "current_date",
    "current_time", "current_timestamp", "current_user", "current_user_id", "default",
    "deferrable", "deflate", "defrag", "delta", "delta32k", "desc", "disable",
    "distinct", "do", "else", "emptyasnull", "enable", "encode", "encrypt     ",
    "encryption", "end", "except", "explicit", "false", "for", "foreign", "freeze",
    "from", "full", "globaldict256", "globaldict64k", "grant", "group", "gzip",
    "having", "identity", "ignore", "ilike", "in", "initially", "inner", "intersect",
    "interval", "into", "is", "isnull", "join", "leading", "left", "like", "limit",
    "localtime", "localtimestamp", "lun", "luns", "lzo", "lzop", "minus", "mostly16",
    "mostly32", "mostly8", "natural", "new", "not", "notnull", "null", "nulls", "off",
    "offline", "offset", "oid", "old", "on", "only", "open", "or", "order", "outer",
    "overlaps", "parallel", "partition", "percent", "permissions", "pivot", "placing",
    "primary", "raw", "readratio", "recover", "references", "rejectlog", "resort",
    "respect", "restore", "right", "select", "session_user", "similar", "snapshot",
    "some", "sysdate", "system", "table", "tag", "tdes", "text255", "text32k", "then",
    "timestamp", "to", "top", "trailing", "true", "truncatecolumns", "type", "union",
    "unique", "unnest", "unpivot", "user", "using", "verbose", "wallet", "when",
    "where", "with", "without",
  ]);

  /** py:275 */
  stpoint_sql(expression) {
    // ST_POINT only accepts 2 args in Redshift; use ST_MAKEPOINT for 3 or 4 args
    if (expression.args.z || expression.args.m) {
      return this.func(
        "ST_MAKEPOINT",
        expression.this,
        expression.expression,
        expression.args.z,
        expression.args.m,
      );
    }
    return this.func("ST_POINT", expression.this, expression.expression);
  }

  /** py:287 */
  arraycontains_sql(expression) {
    return this.func(
      "ARRAY_CONTAINS",
      expression.this,
      expression.expression,
      expression.args.check_null,
    );
  }

  /** py:295 */
  objecttransform_sql(expression) {
    const this_ = this.sql(expression, "this");
    const keep = this.expressions(expression, "keep", { flat: true });
    const set_ = this.expressions(expression, "set_", { flat: true });
    const keep_sql = keep ? ` KEEP ${keep}` : "";
    const set_sql = set_ ? ` SET ${set_}` : "";
    return `OBJECT_TRANSFORM(${this_}${keep_sql}${set_sql})`;
  }

  /** py:303 */
  approxquantile_sql(expression) {
    return `APPROXIMATE ${this.sql(new exp.WithinGroup({
      this: new exp.PercentileDisc({ this: expression.args.quantile }),
      expression: new exp.Order({ expressions: [new exp.Ordered({ this: expression.this })] }),
    }))}`;
  }

  /** py:311 */
  unnest_sql(expression) {
    const args = expression.expressions;
    const num_args = args.length;

    if (num_args !== 1) {
      this.unsupported(`Unsupported number of arguments in UNNEST: ${num_args}`);
      return "";
    }

    if (expression.findAncestor(exp.From, exp.Join, exp.Select) instanceof exp.Select) {
      this.unsupported("Unsupported UNNEST when not used in FROM/JOIN clauses");
      return "";
    }

    const arg = this.sql(args[0]);

    const alias = this.expressions(expression.args.alias, "columns", { flat: true });
    return alias ? `${arg} AS ${alias}` : arg;
  }

  /** py:328 */
  cast_sql(expression, safe_prefix = null) {
    if (expression.isType(exp.DType.JSON)) {
      // Redshift doesn't support a JSON type, so casting to it is treated as a noop
      return this.sql(expression, "this");
    }

    return super.cast_sql(expression, safe_prefix);
  }

  /**
   * py:335
   *
   * Redshift converts the `TEXT` data type to `VARCHAR(255)` by default when people
   * more generally mean VARCHAR of max length which is `VARCHAR(max)` in Redshift.
   * Therefore if we get a `TEXT` data type without precision we convert it to
   * `VARCHAR(max)` and if it does have precision then we just convert `TEXT` to
   * `VARCHAR`.
   */
  datatype_sql(expression) {
    if (expression.isType("text")) {
      expression.set("this", exp.DType.VARCHAR);
      const precision = expression.args.expressions;

      if (!precision || !precision.length) expression.append("expressions", exp.var("MAX"));
    }

    return super.datatype_sql(expression);
  }

  /** py:351 */
  alterset_sql(expression) {
    let exprs = this.expressions(expression, null, { flat: true });
    exprs = exprs ? ` TABLE PROPERTIES (${exprs})` : "";
    let location = this.sql(expression, "location");
    location = location ? ` LOCATION ${location}` : "";
    let file_format = this.expressions(expression, "file_format", { flat: true, sep: " " });
    file_format = file_format ? ` FILE FORMAT ${file_format}` : "";

    return `SET${exprs}${location}${file_format}`;
  }

  /** py:361 */
  array_sql(expression) {
    if (expression.args.bracket_notation) return super.array_sql(expression);

    return rename_func("ARRAY")(this, expression);
  }

  /** py:367 */
  ignorenulls_sql(expression) {
    return Generator.prototype.ignorenulls_sql.call(this, expression);
  }

  /** py:370 */
  respectnulls_sql(expression) {
    return Generator.prototype.respectnulls_sql.call(this, expression);
  }

  /** py:373 */
  explode_sql(expression) {
    this.unsupported("Unsupported EXPLODE() function");
    return "";
  }

  /** py:377 */
  _unix_to_time_sql(expression) {
    const scale = expression.args.scale;
    const this_ = this.sql(expression.this);

    if (scale !== null && scale !== undefined && !scale.equals(exp.UnixToTime.SECONDS) && scale.is_int) {
      return `(TIMESTAMP 'epoch' + (${this_} / POWER(10, ${scale.toPy()})) * INTERVAL '1 SECOND')`;
    }

    return `(TIMESTAMP 'epoch' + ${this_} * INTERVAL '1 SECOND')`;
  }
}
