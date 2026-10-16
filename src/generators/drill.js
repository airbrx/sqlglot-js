// py: sqlglot/generators/drill.py @ 91119bc — WHOLE FILE (127 LOC), AIR-2292
// (epic AIR-2272, "12.7 Small dialects", batch B).
//
// `class DrillGenerator(generator.Generator)` — lands in the same round as
// `dialects/drill.py` (`src/dialects/drill.js`) and `parsers/drill.py`
// (`src/parsers/drill.js`). Self-contained: extends the base `Generator`
// directly.
//
// SHARED HELPERS ALREADY AVAILABLE
// -------------------------------------------------------------------------
// `dialects/dialect.js` already carries `datestrtodate_sql`, `no_trycast_sql`,
// `rename_func`, `strposition_sql`, `timestrtotime_sql`. `generators/mysql.js`
// already carries `date_add_sql`. `transforms.js` already carries `preprocess`,
// `move_schema_columns_to_partitioned_by`, `eliminate_distinct_on`,
// `eliminate_semi_and_anti_joins`. `generator.js` already carries
// `unsupported_args` (R27's own precedent). No new base-helper work was
// required for this round.

import * as exp from "../expressions/index.js";
import { Generator, AFTER_HAVING_MODIFIER_TRANSFORMS, unsupported_args } from "../generator.js";
import { Dialect } from "../dialects/dialect.js";
import {
  datestrtodate_sql,
  no_trycast_sql,
  rename_func,
  strposition_sql,
  timestrtotime_sql,
} from "../dialects/dialect.js";
import { date_add_sql } from "./mysql.js";
import {
  preprocess,
  move_schema_columns_to_partitioned_by,
  eliminate_distinct_on,
  eliminate_semi_and_anti_joins,
} from "../transforms.js";

/**
 * py: sqlglot/generators/drill.py:17 `_str_to_date(self, expression)`.
 *
 * py:18-19 upstream imports `Drill` lazily, inside the function, to avoid the
 * dialects.drill <-> generators.drill circular import (`dialects/drill.js`
 * imports THIS file, so a module-level import back would cycle). Resolved via
 * `Dialect.get_or_raise("drill")` at CALL time instead, the same precedent
 * `generators/tsql.js`'s own `_format_sql` established (R43).
 */
function _str_to_date(self, expression) {
  const this_ = self.sql(expression, "this");
  const time_format = self.format_time(expression);
  if (time_format === Dialect.get_or_raise("drill").DATE_FORMAT) {
    return self.sql(exp.cast(this_, exp.DType.DATE));
  }
  return self.func("TO_DATE", this_, time_format);
}

/** py: sqlglot/generators/drill.py:84 `_drill_dateint_format()`. See `_str_to_date`
 * above for why `Dialect.get_or_raise("drill")` replaces the lazy import. */
function _drill_dateint_format() {
  return Dialect.get_or_raise("drill").DATEINT_FORMAT;
}

/** py: sqlglot/generators/drill.py:27 `class DrillGenerator(generator.Generator)`. */
export class DrillGenerator extends Generator {
  /** py:28 */
  static SELECT_KINDS = [];
  /** py:29 */
  static TRY_SUPPORTED = false;
  /** py:30 */
  static SUPPORTS_UESCAPE = false;
  /** py:31 */
  static SUPPORTS_DECODE_CASE = false;
  /** py:32 */
  static SUPPORTS_LIKE_QUANTIFIERS = false;

  /** py:34 */
  static AFTER_HAVING_MODIFIER_TRANSFORMS = AFTER_HAVING_MODIFIER_TRANSFORMS;

  /** py:36 */
  static JOIN_HINTS = false;
  /** py:37 */
  static TABLE_HINTS = false;
  /** py:38 */
  static QUERY_HINTS = false;
  /** py:39 */
  static NVL2_SUPPORTED = false;
  /** py:40 */
  static LAST_DAY_SUPPORTS_DATE_PART = false;
  /** py:41 */
  static SUPPORTS_CREATE_TABLE_LIKE = false;
  /** py:42 */
  static ARRAY_SIZE_NAME = "REPEATED_COUNT";

  /** py:44 */
  static TYPE_MAPPING = new Map([
    ...Generator.TYPE_MAPPING,
    [exp.DType.INT, "INTEGER"],
    [exp.DType.SMALLINT, "INTEGER"],
    [exp.DType.TINYINT, "INTEGER"],
    [exp.DType.BINARY, "VARBINARY"],
    [exp.DType.TEXT, "VARCHAR"],
    [exp.DType.NCHAR, "VARCHAR"],
    [exp.DType.TIMESTAMPLTZ, "TIMESTAMP"],
    [exp.DType.TIMESTAMPTZ, "TIMESTAMP"],
    [exp.DType.DATETIME, "TIMESTAMP"],
  ]);

  /** py:56 */
  static PROPERTIES_LOCATION = new Map([
    ...Generator.PROPERTIES_LOCATION,
    [exp.PartitionedByProperty, exp.Properties.Location.POST_SCHEMA],
    [exp.VolatileProperty, exp.Properties.Location.UNSUPPORTED],
  ]);

  /** py:61 */
  static TRANSFORMS = new Map([
    ...Generator.TRANSFORMS,
    [exp.CurrentTimestamp, () => "CURRENT_TIMESTAMP"],
    [exp.ArrayContains, rename_func("REPEATED_CONTAINS")],
    [exp.Create, preprocess([move_schema_columns_to_partitioned_by])],
    [exp.DateAdd, date_add_sql("ADD")],
    [exp.DateStrToDate, datestrtodate_sql],
    [exp.DateSub, date_add_sql("SUB")],
    [exp.DateToDi, (self, e) => `CAST(TO_DATE(${self.sql(e, "this")}, ${_drill_dateint_format()}) AS INT)`],
    [exp.DiToDate, (self, e) => `TO_DATE(CAST(${self.sql(e, "this")} AS VARCHAR), ${_drill_dateint_format()})`],
    [exp.If, (self, e) => `\`IF\`(${self.format_args(e.this, e.args.true, e.args.false)})`],
    [exp.Levenshtein, unsupported_args("ins_cost", "del_cost", "sub_cost", "max_dist")(rename_func("LEVENSHTEIN_DISTANCE"))],
    [exp.PartitionedByProperty, (self, e) => `PARTITION BY ${self.sql(e, "this")}`],
    [exp.RegexpLike, rename_func("REGEXP_MATCHES")],
    [exp.StrToDate, _str_to_date],
    [exp.Pow, rename_func("POW")],
    [exp.Select, preprocess([eliminate_distinct_on, eliminate_semi_and_anti_joins])],
    [exp.StrPosition, strposition_sql],
    [exp.StrToTime, (self, e) => self.func("TO_TIMESTAMP", e.this, self.format_time(e))],
    [exp.TimeStrToDate, (self, e) => self.sql(exp.cast(e.this, exp.DType.DATE))],
    [exp.TimeStrToTime, timestrtotime_sql],
    [exp.TimeStrToUnix, rename_func("UNIX_TIMESTAMP")],
    [exp.TimeToStr, (self, e) => self.func("TO_CHAR", e.this, self.format_time(e))],
    [exp.TimeToUnix, rename_func("UNIX_TIMESTAMP")],
    [exp.ToChar, (self, e) => self.function_fallback_sql(e)],
    [exp.TryCast, no_trycast_sql],
    [exp.TsOrDsAdd, (self, e) => `DATE_ADD(CAST(${self.sql(e, "this")} AS DATE), ${self.sql(new exp.Interval({ this: e.expression, unit: exp.var("DAY") }))})`],
    [exp.TsOrDiToDi, (self, e) => `CAST(SUBSTR(REPLACE(CAST(${self.sql(e, "this")} AS VARCHAR), '-', ''), 1, 8) AS INT)`],
  ]);

  /** py:110 `ilike_sql(self, expression: exp.ILike) -> str`. */
  ilike_sql(expression) {
    if (expression.expression instanceof exp.All || expression.expression instanceof exp.Any) {
      return super.ilike_sql(expression);
    }
    return this._ilike_func_sql(expression);
  }

  /** py:115 `escape_sql(self, expression: exp.Escape) -> str`. */
  escape_sql(expression) {
    // Drill takes the escape character as ILIKE's third argument instead of an
    // ESCAPE clause
    const this_ = expression.this;
    if (this_ instanceof exp.ILike && !(this_.expression instanceof exp.All || this_.expression instanceof exp.Any)) {
      return this._ilike_func_sql(this_, expression.expression);
    }
    return super.escape_sql(expression);
  }

  /** py:122 `_ilike_func_sql(self, expression, escape=None) -> str`. */
  _ilike_func_sql(expression, escape = null) {
    const ilike = this.func("ILIKE", expression.this, expression.expression, escape);
    return expression.args.negate ? `NOT ${ilike}` : ilike;
  }
}
