// py: sqlglot/generators/fabric.py — `class FabricGenerator(TSQLGenerator)`.
//
// Last link of the Fabric port (parser -> dialect settings -> generator), extending
// the already-real `TSQLGenerator` (src/generators/tsql.js) at a single level, same
// shape `dialects/fabric.js` uses for its own settings class. AIR-2292, "12.7 Small
// dialects", batch A.
//
// `unixtotime_sql` (py:129) has no base-`Generator` counterpart at all upstream either
// — same shape R104's ten MySQL-only methods and R109's `jsonextract_sql`/
// `regexplike_sql` already established: the per-class prototype walk `_buildDispatch`
// picks it up with no base registration needed.
//
// Every setting below is diffed value-by-value against CPython by
// `spike/p5/fuzz_fabric_dialect.mjs`.

import * as exp from "../expressions/index.js";
import * as transforms from "../transforms.js";
import { findInScope } from "../optimizer/scope.js";
import { TSQLGenerator } from "./tsql.js";

/**
 * py: sqlglot/generators/fabric.py:8
 *
 * Cap the precision of to a maximum of `max_precision` digits. If no precision is
 * specified, default to `max_precision`.
 */
function _cap_data_type_precision(expression, max_precision = 6) {
  const precision_param = expression.find(exp.DataTypeParam);

  let target_precision;
  if (precision_param && precision_param.this.is_int) {
    const current_precision = precision_param.this.toPy();
    target_precision = Math.min(Number(current_precision), max_precision);
  } else {
    target_precision = max_precision;
  }

  return new exp.DataType({
    this: expression.this,
    expressions: [new exp.DataTypeParam({ this: exp.Literal.number(target_precision) })],
  });
}

/**
 * py: sqlglot/generators/fabric.py:28
 *
 * Transform function to add VARCHAR(MAX) or CHAR(MAX) for cross-dialect conversion.
 */
function _add_default_precision_to_varchar(expression) {
  if (
    expression instanceof exp.Create
    && expression.kind === "TABLE"
    && expression.this instanceof exp.Schema
  ) {
    for (const column of expression.this.expressions) {
      if (column instanceof exp.ColumnDef) {
        const column_type = column.kind;
        if (
          column_type instanceof exp.DataType
          && (column_type.this === exp.DType.VARCHAR || column_type.this === exp.DType.CHAR)
          && !column_type.expressions.length
        ) {
          // For transpilation, VARCHAR/CHAR without precision becomes VARCHAR(MAX)/CHAR(MAX)
          column_type.set("expressions", [exp.var("MAX")]);
        }
      }
    }
  }

  return expression;
}

/** py: sqlglot/generators/fabric.py:49 `class FabricGenerator(TSQLGenerator)`. */
export class FabricGenerator extends TSQLGenerator {
  // Fabric-specific type mappings - override T-SQL types that aren't supported
  // Reference: https://learn.microsoft.com/en-us/fabric/data-warehouse/data-types
  static TYPE_MAPPING = new Map([
    ...TSQLGenerator.TYPE_MAPPING,
    [exp.DType.DATETIME, "DATETIME2"],
    [exp.DType.DECIMAL, "DECIMAL"],
    [exp.DType.IMAGE, "VARBINARY"],
    [exp.DType.INT, "INT"],
    [exp.DType.JSON, "VARCHAR"],
    [exp.DType.MONEY, "DECIMAL"],
    [exp.DType.NCHAR, "CHAR"],
    [exp.DType.NVARCHAR, "VARCHAR"],
    [exp.DType.ROWVERSION, "ROWVERSION"],
    [exp.DType.SMALLDATETIME, "DATETIME2"],
    [exp.DType.SMALLMONEY, "DECIMAL"],
    [exp.DType.TIMESTAMP, "DATETIME2"],
    [exp.DType.TIMESTAMPNTZ, "DATETIME2"],
    [exp.DType.TIMESTAMPTZ, "DATETIME2"],
    [exp.DType.TINYINT, "SMALLINT"],
    [exp.DType.UTINYINT, "SMALLINT"],
    [exp.DType.UUID, "UNIQUEIDENTIFIER"],
    [exp.DType.XML, "VARCHAR"],
  ]);

  static TRANSFORMS = new Map([
    ...TSQLGenerator.TRANSFORMS,
    [exp.Create, transforms.preprocess([_add_default_precision_to_varchar])],
  ]);

  /** py:79 */
  datatype_sql(expression) {
    // Check if this is a temporal type that needs precision handling. Fabric limits temporal
    // types to max 6 digits precision. When no precision is specified, we default to 6 digits.
    if (expression.isType(...exp.DataType.TEMPORAL_TYPES) && expression.this !== exp.DType.DATE) {
      // Create a new expression with the capped precision
      expression = _cap_data_type_precision(expression);
    }

    return super.datatype_sql(expression);
  }

  /** py:88 */
  cast_sql(expression, safe_prefix = null) {
    // Cast to DATETIMEOFFSET if inside an AT TIME ZONE expression
    // https://learn.microsoft.com/en-us/sql/t-sql/data-types/datetimeoffset-transact-sql#microsoft-fabric-support
    if (expression.isType(exp.DType.TIMESTAMPTZ)) {
      const at_time_zone = expression.findAncestor(exp.AtTimeZone, exp.Select);

      // Return normal cast, if the expression is not in an AT TIME ZONE context
      if (!(at_time_zone instanceof exp.AtTimeZone)) {
        return super.cast_sql(expression, safe_prefix);
      }

      // Get the precision from the original TIMESTAMPTZ cast and cap it to 6
      const capped_data_type = _cap_data_type_precision(expression.to, 6);
      const precision = capped_data_type.find(exp.DataTypeParam);
      const precision_value = precision && precision.this.is_int ? precision.this.toPy() : 6;

      // Do the cast explicitly to bypass sqlglot's default handling.
      // deny:implicit_str sqlglot/generators/fabric.py:104 — py: `f"CAST(
      // {expression.this} AS DATETIMEOFFSET({precision_value}))"` — `expression.this`
      // is interpolated via `Expression.__str__`, which calls `self.sql()` (same
      // implicit-`__str__` hazard PORT_PLAN.md already names for `pyStr`/`toS`); JS's
      // `toString()` is wired to the debug-dump `toS` instead, so this must call
      // `this.sql(...)` explicitly rather than interpolate the node directly.
      const datetimeoffset = `CAST(${this.sql(expression.this)} AS DATETIMEOFFSET(${precision_value}))`;

      return this.sql(datetimeoffset);
    }

    return super.cast_sql(expression, safe_prefix);
  }

  /** py:110 */
  attimezone_sql(expression) {
    // Wrap the AT TIME ZONE expression in a cast to DATETIME2 if it contains a TIMESTAMPTZ
    // https://learn.microsoft.com/en-us/sql/t-sql/data-types/datetimeoffset-transact-sql#microsoft-fabric-support
    const timestamptz_cast = findInScope(expression, exp.Cast);
    if (timestamptz_cast && timestamptz_cast.to.isType(exp.DType.TIMESTAMPTZ)) {
      // Get the precision from the original TIMESTAMPTZ cast and cap it to 6
      const data_type = timestamptz_cast.to;
      const capped_data_type = _cap_data_type_precision(data_type, 6);
      const precision_param = capped_data_type.find(exp.DataTypeParam);
      const precision = precision_param ? precision_param.this.toPy() : 6;

      // Generate the AT TIME ZONE expression (which will handle the inner cast conversion)
      const at_time_zone_sql = super.attimezone_sql(expression);

      // Wrap it in an outer cast to DATETIME2
      return `CAST(${at_time_zone_sql} AS DATETIME2(${precision}))`;
    }

    return super.attimezone_sql(expression);
  }

  /** py:129 */
  unixtotime_sql(expression) {
    const scale = expression.args.scale;
    const timestamp = expression.this;

    if (scale !== null && scale !== undefined && !scale.equals(exp.UnixToTime.SECONDS)) {
      // deny:implicit_str sqlglot/generators/fabric.py:134 — py: `f"UnixToTime scale
      // {scale} is not supported by Fabric"` — same implicit `__str__`-calls-`.sql()`
      // hazard as `cast_sql` above.
      this.unsupported(`UnixToTime scale ${this.sql(scale)} is not supported by Fabric`);
      return "";
    }

    // Convert unix timestamp (seconds) to microseconds and round to avoid decimals
    // deny:operators sqlglot/generators/fabric.py:138 — Python `*` on an Expr
    // (`timestamp * exp.Literal.number("1e6")`) is `Expr.mul`, not a JS multiply.
    const microseconds = timestamp.mul(exp.Literal.number("1e6"));
    const rounded = exp.func("round", microseconds, 0);
    const rounded_ms_as_bigint = exp.cast(rounded, exp.DType.BIGINT);

    // Create the base datetime as '1970-01-01' cast to DATETIME2(6)
    const epoch_start = exp.cast("'1970-01-01'", "datetime2(6)", { dialect: "fabric" });

    const dateadd = new exp.DateAdd({
      this: epoch_start,
      expression: rounded_ms_as_bigint,
      unit: exp.Literal.string("MICROSECONDS"),
    });
    return this.sql(dateadd);
  }
}
