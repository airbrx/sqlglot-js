// py: sqlglot/generators/dremio.py @ 91119bc — WHOLE FILE (111 LOC), AIR-2292
// (epic AIR-2272, "12.7 Small dialects", batch B).
//
// `class DremioGenerator(generator.Generator)` — lands in the same round as
// `dialects/dremio.py` (`src/dialects/dremio.js`) and `parsers/dremio.py`
// (`src/parsers/dremio.js`). Self-contained: extends the base `Generator`
// directly.
//
// `rename_func`/`no_trycast_sql` already exist in `src/dialects/dialect.js`
// from earlier dialect ports — no new base-helper work required here.

import * as exp from "../expressions/index.js";
import { Generator, AFTER_HAVING_MODIFIER_TRANSFORMS } from "../generator.js";
import { rename_func, no_trycast_sql } from "../dialects/dialect.js";
import { pyUpper } from "../_py/str.js";

/** py: sqlglot/generators/dremio.py:15 `_date_delta_sql(name)`. */
function _date_delta_sql(name) {
  /** py:16 `_delta_sql(self, expression)`. */
  return function _delta_sql(self, expression) {
    const unit = pyUpper(expression.text("unit"));

    // Fallback to default behavior if unit is missing or 'DAY'
    if (!unit || unit === "DAY") return self.func(name, expression.this, expression.expression);

    const this_sql = self.sql(expression, "this");
    const expr_sql = self.sql(expression, "expression");

    const interval_sql = `CAST(${expr_sql} AS INTERVAL ${unit})`;
    return `${name}(${this_sql}, ${interval_sql})`;
  };
}

/** py: sqlglot/generators/dremio.py:32 `class DremioGenerator(generator.Generator)`. */
export class DremioGenerator extends Generator {
  /** py:33 */
  static SELECT_KINDS = [];
  /** py:34 */
  static TRY_SUPPORTED = false;
  /** py:35 */
  static SUPPORTS_UESCAPE = false;
  /** py:36 */
  static SUPPORTS_DECODE_CASE = false;

  /** py:38 */
  static AFTER_HAVING_MODIFIER_TRANSFORMS = AFTER_HAVING_MODIFIER_TRANSFORMS;

  /** py:40 */
  static NVL2_SUPPORTED = false;
  /** py:41 */
  static SUPPORTS_CONVERT_TIMEZONE = true;
  /** py:42 */
  static INTERVAL_ALLOWS_PLURAL_FORM = false;
  /** py:43 */
  static JOIN_HINTS = false;
  /** py:44 */
  static LIMIT_ONLY_LITERALS = true;
  /** py:45 */
  static MULTI_ARG_DISTINCT = false;
  /** py:46 */
  static SUPPORTS_BETWEEN_FLAGS = true;

  /** py:48 https://docs.dremio.com/current/reference/sql/data-types/ */
  static TYPE_MAPPING = new Map([
    ...Generator.TYPE_MAPPING,
    [exp.DType.SMALLINT, "INT"],
    [exp.DType.TINYINT, "INT"],
    [exp.DType.BINARY, "VARBINARY"],
    [exp.DType.TEXT, "VARCHAR"],
    [exp.DType.NCHAR, "VARCHAR"],
    [exp.DType.CHAR, "VARCHAR"],
    [exp.DType.TIMESTAMPNTZ, "TIMESTAMP"],
    [exp.DType.DATETIME, "TIMESTAMP"],
    [exp.DType.ARRAY, "LIST"],
    [exp.DType.BIT, "BOOLEAN"],
  ]);

  /** py:63 */
  static TRANSFORMS = new Map([
    ...Generator.TRANSFORMS,
    [exp.BitwiseAndAgg, rename_func("BIT_AND")],
    [exp.BitwiseOrAgg, rename_func("BIT_OR")],
    [exp.ToChar, rename_func("TO_CHAR")],
    [exp.TimeToStr, (self, e) => self.func("TO_CHAR", e.this, self.format_time(e))],
    [exp.TryCast, no_trycast_sql],
    [exp.DateAdd, _date_delta_sql("DATE_ADD")],
    [exp.DateSub, _date_delta_sql("DATE_SUB")],
    [exp.GenerateSeries, rename_func("ARRAY_GENERATE_RANGE")],
    [exp.RegexpSplit, (self, e) => self.func("REGEXP_SPLIT", e.this, e.expression, e.args.mode, e.args.limit)],
  ]);

  /** py:78 `version_sql(self, expression: exp.Version) -> str`. */
  version_sql(expression) {
    if (expression.text("kind") === "AS OF") {
      const this_ = expression.name === "VERSION" ? "SNAPSHOT" : expression.name;
      return `AT ${this_} ${this.sql(expression, "expression")}`;
    }

    this.unsupported("Range time travel is not supported in Dremio");
    return super.version_sql(expression);
  }

  /**
   * py:86 `datatype_sql(self, expression: exp.DataType) -> str`.
   *
   * Reject time-zone-aware TIMESTAMPs, which Dremio does not accept
   */
  datatype_sql(expression) {
    if (expression.isType(exp.DType.TIMESTAMPTZ, exp.DType.TIMESTAMPLTZ)) {
      this.unsupported("Dremio does not support time-zone-aware TIMESTAMP");
    }

    return super.datatype_sql(expression);
  }

  /** py:98 `cast_sql(self, expression: exp.Cast, safe_prefix=None) -> str`. */
  cast_sql(expression, safe_prefix = null) {
    // Match: CAST(CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AS DATE)
    if (expression.isType(exp.DType.DATE)) {
      const at_time_zone = expression.this;

      if (
        at_time_zone instanceof exp.AtTimeZone
        && at_time_zone.this instanceof exp.CurrentTimestamp
        && at_time_zone.args.zone instanceof exp.Literal
        && pyUpper(at_time_zone.text("zone")) === "UTC"
      ) {
        return "CURRENT_DATE_UTC";
      }
    }

    return super.cast_sql(expression, safe_prefix);
  }
}
