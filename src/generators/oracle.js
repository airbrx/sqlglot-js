// py: sqlglot/generators/oracle.py @ 91119bc — WHOLE FILE (179 LOC), AIR-2290
// (epic AIR-2272, "12.5 Oracle").
//
// `class OracleGenerator(generator.Generator)` — standalone, extends the base
// `Generator` directly (Oracle is `class Oracle(Dialect)`, no chain, same shape
// Presto/Snowflake/Postgres/TSQL/MySQL/ClickHouse use). `src/parsers/oracle.js`
// and `src/dialects/oracle.js` land alongside this file in the same round.
//
// `currenttimestamp_sql`, `coalesce_sql`, and `isascii_sql` have NO base-`Generator`
// counterpart upstream either (same shape R104's note on `mysql.js` names) — the
// per-class prototype walk in `_buildDispatch` (generator.js) picks each up under
// its own name with no base registration needed.

import { Generator } from "../generator.js";
import * as exp from "../expressions/index.js";
import * as transforms from "../transforms.js";
import {
  groupconcat_sql,
  no_ilike_sql,
  nth_value_from_sql,
  rename_func,
  strposition_sql,
  trim_sql,
} from "../dialects/dialect.js";

/** py: sqlglot/generators/oracle.py:14 `_trim_sql`. */
function _trim_sql(self, expression) {
  const position = expression.args.position;

  if (position && ["LEADING", "TRAILING"].includes(position.toUpperCase())) {
    return self.trim_sql(expression);
  }

  return trim_sql(self, expression);
}

/** py: sqlglot/generators/oracle.py:23 `class OracleGenerator(generator.Generator)`. */
export class OracleGenerator extends Generator {
  /** py:24 */
  static SELECT_KINDS = [];
  /** py:25 */
  static TRY_SUPPORTED = false;
  /** py:26 */
  static SUPPORTS_UESCAPE = false;
  /** py:27 */
  static LOCKING_READS_SUPPORTED = true;
  /** py:28 */
  static SUPPORTS_MERGE_WHERE = true;
  /** py:29 */
  static JOIN_HINTS = false;
  /** py:30 */
  static TABLE_HINTS = false;
  /** py:31 */
  static DATA_TYPE_SPECIFIERS_ALLOWED = true;
  /** py:32 */
  static ALTER_TABLE_INCLUDE_COLUMN_KEYWORD = false;
  /** py:33 */
  static LIMIT_FETCH = "FETCH";
  /** py:34 */
  static TABLESAMPLE_KEYWORDS = "SAMPLE";
  /** py:35 */
  static LAST_DAY_SUPPORTS_DATE_PART = false;
  /** py:36 */
  static SUPPORTS_SELECT_INTO = true;
  /** py:37 */
  static TZ_TO_WITH_TIME_ZONE = true;
  /** py:38 */
  static SUPPORTS_WINDOW_EXCLUDE = true;
  /** py:39 */
  static QUERY_HINT_SEP = " ";
  /** py:40 */
  static SUPPORTS_DECODE_CASE = true;
  /** py:41 */
  static UNPIVOT_ALIASES_ARE_IDENTIFIERS = false;
  /** py:42 */
  static PIVOT_ALIAS_WITH_AS = false;

  /** py:44 `AFTER_HAVING_MODIFIER_TRANSFORMS = generator.AFTER_HAVING_MODIFIER_TRANSFORMS`. */
  static AFTER_HAVING_MODIFIER_TRANSFORMS = Generator.AFTER_HAVING_MODIFIER_TRANSFORMS;

  /** py:46 */
  static TYPE_MAPPING = new Map([
    ...Generator.TYPE_MAPPING,
    [exp.DType.BLOB, "BLOB"],
    [exp.DType.TINYINT, "SMALLINT"],
    [exp.DType.SMALLINT, "SMALLINT"],
    [exp.DType.INT, "INT"],
    [exp.DType.BIGINT, "INT"],
    [exp.DType.DECIMAL, "NUMBER"],
    [exp.DType.DOUBLE, "DOUBLE PRECISION"],
    [exp.DType.VARCHAR, "VARCHAR2"],
    [exp.DType.NVARCHAR, "NVARCHAR2"],
    [exp.DType.NCHAR, "NCHAR"],
    [exp.DType.TEXT, "CLOB"],
    [exp.DType.TIMETZ, "TIME"],
    [exp.DType.TIMESTAMPNTZ, "TIMESTAMP"],
    [exp.DType.TIMESTAMPTZ, "TIMESTAMP"],
    [exp.DType.BINARY, "BLOB"],
    [exp.DType.VARBINARY, "BLOB"],
    [exp.DType.ROWVERSION, "BLOB"],
  ]);

  /** py:67 */
  static TRANSFORMS = new Map([
    ...Generator.TRANSFORMS,
    [exp.Pivot, transforms.preprocess([transforms.unqualify_pivot_fields])],
    [exp.GroupConcat, (self, e) => groupconcat_sql(self, e, { on_overflow: true })],
    [exp.DateStrToDate, (self, e) => self.func("TO_DATE", e.this, exp.Literal.string("YYYY-MM-DD"))],
    [exp.DateTrunc, (self, e) => self.func("TRUNC", e.this, e.unit)],
    [exp.EuclideanDistance, rename_func("L2_DISTANCE")],
    [exp.ILike, no_ilike_sql],
    [exp.LogicalOr, rename_func("MAX")],
    [exp.LogicalAnd, rename_func("MIN")],
    [exp.Mod, rename_func("MOD")],
    [exp.NthValue, nth_value_from_sql],
    [exp.Rand, rename_func("DBMS_RANDOM.VALUE")],
    [
      exp.Select,
      transforms.preprocess([transforms.eliminate_distinct_on, transforms.eliminate_qualify]),
    ],
    [
      exp.StrPosition,
      (self, e) => strposition_sql(self, e, { func_name: "INSTR", supports_position: true, supports_occurrence: true }),
    ],
    [exp.StrToTime, (self, e) => self.func("TO_TIMESTAMP", e.this, self.format_time(e))],
    [exp.StrToDate, (self, e) => self.func("TO_DATE", e.this, self.format_time(e))],
    [exp.Subquery, (self, e) => self.subquery_sql(e, " ")],
    [exp.Substring, rename_func("SUBSTR")],
    [exp.Table, (self, e) => self.table_sql(e, " ")],
    [exp.TableSample, (self, e) => self.tablesample_sql(e)],
    [exp.TemporaryProperty, (_, e) => `${e.name || "GLOBAL"} TEMPORARY`],
    [exp.TimeToStr, (self, e) => self.func("TO_CHAR", e.this, self.format_time(e))],
    [exp.ToChar, (self, e) => self.function_fallback_sql(e)],
    [exp.Trim, _trim_sql],
    [exp.Unicode, (self, e) => `ASCII(UNISTR(${self.sql(e.this)}))`],
    [
      exp.UnixToTime,
      (self, e) => `TO_DATE('1970-01-01', 'YYYY-MM-DD') + (${self.sql(e, "this")} / 86400)`,
    ],
    [exp.UtcTimestamp, rename_func("UTC_TIMESTAMP")],
    [exp.UtcTime, rename_func("UTC_TIME")],
    [exp.Systimestamp, () => "SYSTIMESTAMP"],
  ]);

  /** py:110 */
  static PROPERTIES_LOCATION = new Map([
    ...Generator.PROPERTIES_LOCATION,
    [exp.VolatileProperty, exp.Properties.Location.UNSUPPORTED],
  ]);

  /** py:115 */
  currenttimestamp_sql(expression) {
    if (expression.args.sysdate) {
      return "SYSDATE";
    }

    const this_ = expression.this;
    return this_ ? this.func("CURRENT_TIMESTAMP", this_) : "CURRENT_TIMESTAMP";
  }

  /** py:122 */
  offset_sql(expression) {
    return `${super.offset_sql(expression)} ROWS`;
  }

  /** py:125 */
  add_column_sql(expression) {
    return `ADD ${this.sql(expression)}`;
  }

  /** py:128 */
  queryoption_sql(expression) {
    const option = this.sql(expression, "this");
    const value = this.sql(expression, "expression");
    const value_ = value ? ` CONSTRAINT ${value}` : "";

    return `${option}${value_}`;
  }

  /** py:135 */
  coalesce_sql(expression) {
    const func_name = expression.args.is_nvl ? "NVL" : "COALESCE";
    return rename_func(func_name)(this, expression);
  }

  /** py:139 */
  into_sql(expression) {
    const into = expression.args.bulk_collect ? "BULK COLLECT INTO" : "INTO";
    if (expression.this) {
      return `${this.seg(into)} ${this.sql(expression, "this")}`;
    }

    return `${this.seg(into)} ${this.expressions(expression)}`;
  }

  /** py:146 */
  hint_sql(expression) {
    const expressions = [];

    for (const hint of expression.expressions) {
      if (hint instanceof exp.Anonymous) {
        const formatted_args = this.format_args(...hint.expressions, { sep: " " });
        expressions.push(`${this.sql(hint, "this")}(${formatted_args})`);
      } else {
        expressions.push(this.sql(hint));
      }
    }

    return ` /*+ ${this.expressions(null, null, { sqls: expressions, sep: this.constructor.QUERY_HINT_SEP }).trim()} */`;
  }

  /** py:158 */
  isascii_sql(expression) {
    return `NVL(REGEXP_LIKE(${this.sql(expression.this)}, '^[' || CHR(1) || '-' || CHR(127) || ']*$'), TRUE)`;
  }

  /** py:161 */
  interval_sql(expression) {
    const prefix = expression.this instanceof exp.Literal ? "INTERVAL " : "";
    return `${prefix}${this.sql(expression, "this")} ${this.sql(expression, "unit")}`;
  }

  /** py:164 */
  tonumber_sql(expression) {
    let this_ = this.sql(expression, "this");
    const default_ = this.sql(expression, "default");
    if (default_) {
      this_ = `${this_} DEFAULT ${default_} ON CONVERSION ERROR`;
    }

    return this.func("TO_NUMBER", this_, expression.args.format, expression.args.nlsparam);
  }

  /** py:174 */
  columndef_sql(expression, sep = " ") {
    const param_constraint = expression.find(exp.InOutColumnConstraint);
    if (param_constraint) {
      sep = ` ${this.sql(param_constraint)} `;
      param_constraint.pop();
    }
    return super.columndef_sql(expression, sep);
  }
}
