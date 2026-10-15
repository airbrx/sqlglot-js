// py: sqlglot/generators/starrocks.py @ 91119bc — WHOLE FILE (354 LOC), AIR-2286
// (epic AIR-2272, "12.1 MySQL family" part 2: starrocks + doris, children of R104's
// `MySQLGenerator`).
//
// `class StarRocksGenerator(MySQLGenerator)` — the WRITE-side counterpart of
// `src/parsers/starrocks.js` (grammar) and `src/dialects/starrocks.js` (settings),
// same three-file split every prior dialect uses.

import * as exp from "../expressions/index.js";
import * as transforms from "../transforms.js";
import {
  approx_count_distinct_sql,
  arrow_json_extract_sql,
  rename_func,
  weekstart_unit_to_str,
  inline_array_sql,
  property_sql,
  var_map_sql,
} from "../dialects/dialect.js";
import { MySQLGenerator } from "./mysql.js";

/**
 * py: sqlglot/generators/starrocks.py:18
 *
 * StarRocks doesn't support BETWEEN in DELETE statements, so we convert BETWEEN
 * expressions to explicit comparisons.
 * https://docs.starrocks.io/docs/sql-reference/sql-statements/table_bucket_part_index/DELETE/#parameters
 *
 * Example: `DELETE FROM t WHERE x BETWEEN 1 AND 10` -> `DELETE FROM t WHERE x >= 1 AND x <= 10`
 */
function _eliminate_between_in_delete(expression) {
  const where = expression.args.where;
  if (where) {
    for (const between of where.findAll(exp.Between)) {
      between.replace(
        exp.and_(
          new exp.GTE({ this: between.this.copy(), expression: between.args.low }),
          new exp.LTE({ this: between.this.copy(), expression: between.args.high }),
          { copy: false },
        ),
      );
    }
  }
  return expression;
}

// https://docs.starrocks.io/docs/sql-reference/sql-functions/spatial-functions/st_distance_sphere/
/** py: sqlglot/generators/starrocks.py:44 */
function st_distance_sphere(self, expression) {
  const point1 = expression.this;
  const point2 = expression.expression;

  const point1_x = self.func("ST_X", point1);
  const point1_y = self.func("ST_Y", point1);
  const point2_x = self.func("ST_X", point2);
  const point2_y = self.func("ST_Y", point2);

  return self.func("ST_Distance_Sphere", point1_x, point1_y, point2_x, point2_y);
}

/** py: sqlglot/generators/starrocks.py:56 */
export class StarRocksGenerator extends MySQLGenerator {
  static EXCEPT_INTERSECT_SUPPORT_ALL_CLAUSE = false;
  static JSON_TYPE_REQUIRED_FOR_EXTRACTION = false;
  static VARCHAR_REQUIRES_SIZE = false;
  static PARSE_JSON_NAME = "PARSE_JSON";
  static WITH_PROPERTIES_PREFIX = "PROPERTIES";
  static UPDATE_STATEMENT_SUPPORTS_FROM = true;
  static INSERT_OVERWRITE = " OVERWRITE";

  // StarRocks doesn't support "IS TRUE/FALSE" syntax.
  static IS_BOOL_ALLOWED = false;
  // StarRocks doesn't support renaming a table with a database.
  static RENAME_TABLE_WITH_DB = false;

  /** py:70 */
  static CAST_MAPPING = new Map();

  /** py:72 */
  static TYPE_MAPPING = new Map([
    ...MySQLGenerator.TYPE_MAPPING,
    [exp.DType.INT128, "LARGEINT"],
    [exp.DType.TEXT, "STRING"],
    [exp.DType.TIMESTAMP, "DATETIME"],
    [exp.DType.TIMESTAMPTZ, "DATETIME"],
  ]);

  static SQL_SECURITY_VIEW_LOCATION = exp.Properties.Location.POST_SCHEMA;

  /** py:82 */
  static PROPERTIES_LOCATION = new Map([
    ...MySQLGenerator.PROPERTIES_LOCATION,
    [exp.PrimaryKey, exp.Properties.Location.POST_SCHEMA],
    [exp.UniqueKeyProperty, exp.Properties.Location.POST_SCHEMA],
    [exp.RollupProperty, exp.Properties.Location.POST_SCHEMA],
    [exp.PartitionedByProperty, exp.Properties.Location.POST_SCHEMA],
  ]);

  /**
   * py:90
   *
   * StarRocks uses the native TRIM(str, chars)/LTRIM/RTRIM function form, not MySQL's
   * TRIM(chars FROM str) syntax, so it falls back to the base generator — the
   * build-then-`.delete()` idiom PORT_PLAN.md R31 (`spark2.js`'s own TRANSFORMS) uses
   * for the same "dict comprehension excludes a key" shape.
   */
  static TRANSFORMS = (() => {
    const t = new Map([
      ...MySQLGenerator.TRANSFORMS,
      [exp.ArgMax, rename_func("MAX_BY")],
      [exp.ArgMin, rename_func("MIN_BY")],
      [exp.Array, inline_array_sql],
      [exp.ArrayAgg, rename_func("ARRAY_AGG")],
      // a <@ b (ArrayContainedBy) is equivalent to ARRAY_CONTAINS_ALL(b, a)
      [exp.ArrayContainedBy, (self, e) => self.func("ARRAY_CONTAINS_ALL", e.expression, e.this)],
      [exp.ArrayContainsAll, rename_func("ARRAY_CONTAINS_ALL")],
      [exp.ArrayFilter, rename_func("ARRAY_FILTER")],
      [exp.ArrayToString, rename_func("ARRAY_JOIN")],
      [exp.ApproxDistinct, approx_count_distinct_sql],
      [exp.CurrentVersion, () => "CURRENT_VERSION()"],
      [exp.DateDiff, (self, e) => self.func(
        "DATE_DIFF", weekstart_unit_to_str(self, e), e.this, e.expression,
      )],
      [exp.Delete, transforms.preprocess([_eliminate_between_in_delete])],
      [exp.Flatten, rename_func("ARRAY_FLATTEN")],
      [exp.JSONExtractScalar, arrow_json_extract_sql],
      [exp.JSONExtract, arrow_json_extract_sql],
      // Both MAP forms (two-array MAP([keys], [values]) and variadic MAP(k1, v1, ...))
      // generate StarRocks' variadic MAP(k1, v1, k2, v2, ...) constructor
      [exp.Map, (self, e) => var_map_sql(self, e, "MAP")],
      [exp.Property, property_sql],
      [exp.RegexpLike, rename_func("REGEXP")],
      // Inherited from MySQL, minus operations StarRocks supports natively
      // (QUALIFY, FULL OUTER JOIN, SEMI/ANTI JOIN)
      [exp.Select, transforms.preprocess([
        transforms.eliminate_distinct_on,
        transforms.unnest_generate_date_array_using_recursive_cte,
      ])],
      [exp.SchemaCommentProperty, (self, e) => self.naked_property(e)],
      [exp.SqlSecurityProperty, (self, e) => `SECURITY ${self.sql(e, "this")}`],
      [exp.StDistance, st_distance_sphere],
      [exp.StrToUnix, (self, e) => self.func("UNIX_TIMESTAMP", e.this, self.format_time(e))],
      [exp.TimestampTrunc, (self, e) => self.func(
        "DATE_TRUNC", weekstart_unit_to_str(self, e), e.this,
      )],
      [exp.TimeStrToDate, rename_func("TO_DATE")],
      [exp.UnixToStr, (self, e) => self.func("FROM_UNIXTIME", e.this, self.format_time(e))],
      [exp.UnixToTime, rename_func("FROM_UNIXTIME")],
      [exp.VarMap, (self, e) => var_map_sql(self, e, "MAP")],
    ]);
    t.delete(exp.DateTrunc);
    t.delete(exp.Trim);
    return t;
  })();

  // https://docs.starrocks.io/docs/sql-reference/sql-statements/keywords/#reserved-keywords
  /** py:141 */
  static RESERVED_KEYWORDS = new Set([
    "add", "all", "alter", "analyze", "and", "array", "as", "asc", "between", "bigint",
    "bitmap", "both", "by", "case", "char", "character", "check", "collate", "column",
    "compaction", "convert", "create", "cross", "cube", "current_date", "current_role",
    "current_time", "current_timestamp", "current_user", "database", "databases",
    "decimal", "decimalv2", "decimal32", "decimal64", "decimal128", "default",
    "deferred", "delete", "dense_rank", "desc", "describe", "distinct", "double",
    "drop", "dual", "else", "except", "exists", "explain", "false", "first_value",
    "float", "for", "force", "from", "full", "function", "grant", "group", "grouping",
    "grouping_id", "groups", "having", "hll", "host", "if", "ignore", "immediate",
    "in", "index", "infile", "inner", "insert", "int", "integer", "intersect", "into",
    "is", "join", "json", "key", "keys", "kill", "lag", "largeint", "last_value",
    "lateral", "lead", "left", "like", "limit", "load", "localtime", "localtimestamp",
    "maxvalue", "minus", "mod", "not", "ntile", "null", "on", "or", "order", "outer",
    "outfile", "over", "partition", "percentile", "primary", "procedure", "qualify",
    "range", "rank", "read", "regexp", "release", "rename", "replace", "revoke",
    "right", "rlike", "row", "row_number", "rows", "schema", "schemas", "select",
    "set", "set_var", "show", "smallint", "system", "table", "terminated", "text",
    "then", "tinyint", "to", "true", "union", "unique", "unsigned", "update", "use",
    "using", "values", "varchar", "when", "where", "with",
  ]);

  /** py:295 */
  create_sql(expression) {
    // Starrocks' primary key is defined outside of the schema, so we need to move it there
    const schema = expression.this;
    if (schema instanceof exp.Schema) {
      const primary_key = schema.find(exp.PrimaryKey);

      if (primary_key) {
        let props = expression.args.properties;

        if (!props) {
          props = new exp.Properties({ expressions: [] });
          expression.set("properties", props);
        }

        // Verify if the first one is an engine property. Is true then insert it after the
        // engine, otherwise insert it at the beginning
        const engine = props.find(exp.EngineProperty);
        const engine_index = engine ? (engine.index || 0) : -1;
        props.set("expressions", primary_key.pop(), engine_index + 1, false);
      }
    }

    return super.create_sql(expression);
  }

  /** py:316 */
  partitionedbyproperty_sql(expression) {
    const this_ = expression.this;
    if (this_ instanceof exp.Schema) {
      // For MVs, StarRocks needs outer parentheses.
      const create = expression.findAncestor(exp.Create);

      let sql = this.expressions(this_, null, { flat: true });
      if (
        (create && create.kind === "VIEW")
        || this_.expressions.every((col) => col instanceof exp.Column || col instanceof exp.Identifier)
      ) {
        sql = `(${sql})`;
      }

      return `PARTITION BY ${sql}`;
    }

    return `PARTITION BY ${this.sql(this_)}`;
  }

  /** py:332 */
  clusterproperty_sql(expression) {
    if (expression.this) {
      this.unsupported(`Unsupported CLUSTER BY ${this.sql(expression, "this")}`);
      return "";
    }
    const expressions = this.expressions(expression, null, { flat: true });
    return `ORDER BY (${expressions})`;
  }

  /**
   * py:340
   *
   * Generate StarRocks REFRESH clause for materialized views. There is a little
   * difference of the syntax between StarRocks and Doris.
   */
  refreshtriggerproperty_sql(expression) {
    let method = this.sql(expression, "method");
    method = method ? ` ${method}` : "";
    let kind = this.sql(expression, "kind");
    kind = kind ? ` ${kind}` : "";
    let starts = this.sql(expression, "starts");
    starts = starts ? ` START (${starts})` : "";
    const every = this.sql(expression, "every");
    const unit = this.sql(expression, "unit");
    const everySql = every && unit ? ` EVERY (INTERVAL ${every} ${unit})` : "";

    return `REFRESH${method}${kind}${starts}${everySql}`;
  }
}
