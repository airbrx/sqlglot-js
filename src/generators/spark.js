// py: sqlglot/generators/spark.py — `class SparkGenerator(Spark2Generator)`.
//
// Third link in the four-link chain `Hive <- Spark2 <- Spark <- Databricks`
// (PORT_PLAN.md, Databricks-chain generator step). See `hive.js`'s header for the
// shared context.
//
// `ignorenulls_sql`'s explicit `generator.Generator.ignorenulls_sql(self, expression)`
// unbound-base-class call is this file's own copy of the same "call the grandparent by
// name, not `super()`" shape `spark2.js`'s `struct_sql` already established, since
// Python's `super().ignorenulls_sql` here would resolve to `Spark2Generator`'s
// (inherited, unoverridden) `HiveGenerator.ignorenulls_sql` — the explicit
// `generator.Generator.ignorenulls_sql` module-qualified call is what skips past it.

import { seqGet } from "../helper.js";
import * as exp from "../expressions/index.js";
import { Generator } from "../generator.js";
import {
  array_append_sql,
  date_delta_to_binary_interval_op,
  groupconcat_sql,
  rename_func,
  timestampdiff_sql,
  unit_to_var,
} from "../dialects/dialect.js";
import { Spark2Generator, temporary_storage_provider } from "./spark2.js";
import {
  ctas_with_tmp_tables_to_create_tmp_view,
  move_partitioned_by_to_schema_columns,
  preprocess,
  remove_unique_constraints,
} from "../transforms.js";

/** py:23 `_normalize_partition(e)` — "Normalize the expressions in PARTITION BY (<expression>, <expression>, ...)". */
function _normalize_partition(e) {
  if (typeof e === "string") return exp.toIdentifier(e);
  if (e instanceof exp.Literal) return exp.toIdentifier(e.name);
  return e;
}

/** py:32 `_dateadd_sql(self, expression: exp.TsOrDsAdd | exp.TimestampAdd)`. */
function _dateadd_sql(self, expression) {
  if (!expression.args.unit || (expression instanceof exp.TsOrDsAdd && expression.text("unit").toUpperCase() === "DAY")) {
    // Coming from Hive/Spark2 DATE_ADD or roundtripping the 2-arg version of Spark3/DB
    return self.func("DATE_ADD", expression.this, expression.expression);
  }

  let this_ = self.func("DATE_ADD", unit_to_var(expression), expression.expression, expression.this);

  if (expression instanceof exp.TsOrDsAdd) {
    // The 3 arg version of DATE_ADD produces a timestamp in Spark3/DB but possibly not
    // in other dialects
    const return_type = expression.returnType;
    if (!return_type.isType(exp.DType.TIMESTAMP, exp.DType.DATETIME)) {
      // deny:implicit_str sqlglot/generators/spark.py:51 — f-string on an Expr calls
      // Python's implicit `str(return_type)` == `.sql()`; a bare JS template literal
      // would call `.toString()` (this port's verbose debug repr), not `.sql()`.
      this_ = `CAST(${this_} AS ${self.sql(return_type)})`;
    }
  }

  return this_;
}

/**
 * Python tuple `<` over `Dialect.version`, for `_groupconcat_sql`'s
 * `self.dialect.version < (4,)` (py:57). Same shape as `parsers/duckdb.js`'s own local
 * `_versionLt` (no shared export exists yet for this comparison) — `version` is a
 * 3-element BigInt array (`dialects/dialect.js:952`), and JS `<` on arrays coerces to
 * strings rather than comparing element-wise, so a hand-rolled tuple compare is needed.
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

/** py:56 `_groupconcat_sql(self, expression: exp.GroupConcat)`. */
function _groupconcat_sql(self, expression) {
  if (_versionLt(self.dialect.version, 4n)) {
    const expr = new exp.ArrayToString({
      this: new exp.ArrayAgg({ this: expression.this }),
      expression: expression.args.separator || exp.Literal.string(""),
    });
    return self.sql(expr);
  }

  return groupconcat_sql(self, expression);
}

/** py:67 `class SparkGenerator(Spark2Generator)`. */
export class SparkGenerator extends Spark2Generator {
  static SUPPORTS_TO_NUMBER = true;
  static PAD_FILL_PATTERN_IS_REQUIRED = false;
  static SUPPORTS_CONVERT_TIMEZONE = true;
  static SUPPORTS_MEDIAN = true;
  static SUPPORTS_UNIX_SECONDS = true;
  static SUPPORTS_DECODE_CASE = true;
  static SET_ASSIGNMENT_REQUIRES_VARIABLE_KEYWORD = true;

  static TYPE_MAPPING = new Map([
    ...Spark2Generator.TYPE_MAPPING,
    [exp.DType.MONEY, "DECIMAL"],
    [exp.DType.SMALLMONEY, "DECIMAL"],
    [exp.DType.UUID, "STRING"],
    [exp.DType.TIMESTAMPLTZ, "TIMESTAMP_LTZ"],
    [exp.DType.TIMESTAMPNTZ, "TIMESTAMP_NTZ"],
  ]);

  static TYPE_PARAM_SETTINGS = new Map([
    ...Spark2Generator.TYPE_PARAM_SETTINGS,
    [exp.DType.MONEY, [[15, 4], []]],
    [exp.DType.SMALLMONEY, [[6, 4], []]],
  ]);

  /**
   * py:91 `TRANSFORMS = {k: v for k, v in {**Spark2Generator.TRANSFORMS, ...}.items() if v is not None}`.
   * Same build-then-delete shape `spark2.js`'s own `TRANSFORMS` uses, for the same
   * reason: `exp.AnyValue`/`exp.DateDiff`/`exp.With` are removed so dispatch falls
   * through to base `Generator`'s own methods/`exp.Func` fallback instead of
   * `HiveGenerator`'s Hive-specific rewrites — Spark3/Databricks support these natively.
   */
  static TRANSFORMS = (() => {
    const t = new Map([
      ...Spark2Generator.TRANSFORMS,
      [
        exp.ArrayConstructCompact,
        (self, e) => self.func("ARRAY_COMPACT", self.func("ARRAY", ...e.expressions)),
      ],
      [
        exp.ArrayInsert,
        (self, e) => self.func("ARRAY_INSERT", e.this, e.args.position, e.expression),
      ],
      [exp.ArrayAppend, array_append_sql("ARRAY_APPEND")],
      [exp.ArrayPrepend, array_append_sql("ARRAY_PREPEND")],
      [exp.BitwiseAndAgg, rename_func("BIT_AND")],
      [exp.BitwiseOrAgg, rename_func("BIT_OR")],
      [exp.BitwiseXorAgg, rename_func("BIT_XOR")],
      [exp.BitwiseCount, rename_func("BIT_COUNT")],
      [
        exp.Create,
        preprocess([
          remove_unique_constraints,
          (e) => ctas_with_tmp_tables_to_create_tmp_view(e, temporary_storage_provider),
          move_partitioned_by_to_schema_columns,
        ]),
      ],
      [exp.CurrentVersion, rename_func("VERSION")],
      [exp.DateFromUnixDate, rename_func("DATE_FROM_UNIX_DATE")],
      [exp.DatetimeAdd, date_delta_to_binary_interval_op(false)],
      [exp.DatetimeSub, date_delta_to_binary_interval_op(false)],
      [exp.GroupConcat, _groupconcat_sql],
      [exp.EndsWith, rename_func("ENDSWITH")],
      [exp.JSONKeys, rename_func("JSON_OBJECT_KEYS")],
      [
        exp.PartitionedByProperty,
        (self, e) =>
          `PARTITIONED BY ${self.wrap(self.expressions(null, null, { sqls: e.this.expressions.map((x) => _normalize_partition(x)), skip_first: true }))}`,
      ],
      [exp.SafeAdd, rename_func("TRY_ADD")],
      [exp.SafeDivide, rename_func("TRY_DIVIDE")],
      [exp.SafeMultiply, rename_func("TRY_MULTIPLY")],
      [exp.SafeSubtract, rename_func("TRY_SUBTRACT")],
      [exp.StartsWith, rename_func("STARTSWITH")],
      [exp.TimeAdd, date_delta_to_binary_interval_op(false)],
      [exp.TimeSub, date_delta_to_binary_interval_op(false)],
      [exp.TsOrDsAdd, _dateadd_sql],
      [exp.TimestampAdd, _dateadd_sql],
      [exp.TimestampFromParts, rename_func("MAKE_TIMESTAMP")],
      [exp.TimestampSub, date_delta_to_binary_interval_op(false)],
      [exp.DatetimeDiff, timestampdiff_sql],
      [exp.TimestampDiff, timestampdiff_sql],
      [
        exp.TryCast,
        (self, e) => (e.args.safe ? self.trycast_sql(e) : self.cast_sql(e)),
      ],
    ]);

    t.delete(exp.AnyValue);
    t.delete(exp.DateDiff);
    t.delete(exp.With);

    return t;
  })();

  /**
   * py:149
   * @param {exp.IgnoreNulls} expression
   * @returns {string}
   */
  ignorenulls_sql(expression) {
    return Generator.prototype.ignorenulls_sql.call(this, expression);
  }

  /**
   * py:152
   * @param {exp.Bracket} expression
   * @returns {string}
   */
  bracket_sql(expression) {
    if (expression.args.safe) {
      const key = seqGet(this.bracket_offset_expressions(expression, 1), 0);
      return this.func("TRY_ELEMENT_AT", expression.this, key);
    }

    return super.bracket_sql(expression);
  }

  /**
   * py:159
   * @param {exp.ComputedColumnConstraint} expression
   * @returns {string}
   */
  computedcolumnconstraint_sql(expression) {
    return `GENERATED ALWAYS AS (${this.sql(expression, "this")})`;
  }

  /**
   * py:162
   * @param {exp.AnyValue} expression
   * @returns {string}
   */
  anyvalue_sql(expression) {
    return this.function_fallback_sql(expression);
  }

  /**
   * py:165
   * @param {exp.DateDiff} expression
   * @returns {string}
   */
  datediff_sql(expression) {
    const end = this.sql(expression, "this");
    const start = this.sql(expression, "expression");

    if (expression.args.unit) {
      return this.func("DATEDIFF", unit_to_var(expression), start, end);
    }

    return this.func("DATEDIFF", end, start);
  }

  /**
   * py:174
   * @param {exp.Placeholder} expression
   * @returns {string}
   */
  placeholder_sql(expression) {
    if (!expression.args.widget) return super.placeholder_sql(expression);

    return `{${expression.name}}`;
  }

  /**
   * py:180
   * @param {exp.ReadParquet} expression
   * @returns {string}
   */
  readparquet_sql(expression) {
    if (expression.expressions.length !== 1) {
      this.unsupported("READ_PARQUET with multiple arguments is not supported");
      return "";
    }

    const parquet_file = expression.expressions[0];
    return `parquet.\`${parquet_file.name}\``;
  }

  /**
   * py:188
   * @param {exp.IfBlock} expression
   * @returns {string}
   */
  ifblock_sql(expression) {
    const condition = expression.this;
    const true_block = expression.args.true;

    let condition_expr = null;
    if (condition instanceof exp.Not) {
      const inner = condition.this;
      if (inner instanceof exp.Is && inner.expression instanceof exp.Null) {
        condition_expr = inner.this;
      }
    }

    if (condition_expr instanceof exp.ObjectId) {
      const object_type = condition_expr.expression;
      const drop = true_block instanceof exp.Block ? true_block.expressions[0] : null;
      if (
        (object_type === null || object_type === undefined || object_type.name.toUpperCase() === "U") &&
        true_block instanceof exp.Block &&
        drop instanceof exp.Drop
      ) {
        drop.set("exists", true);
        return this.sql(drop);
      }
    }

    return super.ifblock_sql(expression);
  }
}
