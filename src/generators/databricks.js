// py: sqlglot/generators/databricks.py — `class DatabricksGenerator(SparkGenerator)`.
//
// Fourth and last link in the four-link chain `Hive <- Spark2 <- Spark <- Databricks`
// (PORT_PLAN.md, Databricks-chain generator step). See `hive.js`'s header for the
// shared context.
//
// One more base `Generator` method needed porting for real here: `jsonpath_sql`,
// reached by this file's own override's `super().jsonpath_sql(expression)` call.
//
// `create_sql` is the one method here whose `super().create_sql(expression)` call
// stays a live `NotPorted` guard rather than being closed: base `Generator.create_sql`
// is DDL rendering, explicitly out of scope for the P4 "render a basic SELECT
// statement" keystone group (R25's own header: "Deliberately OUT: create_sql/
// createable_sql/truncatetable_sql (DDL, not 'a basic SELECT')") and for every dialect
// port since. Porting it is its own separate, much larger task, not something this
// session's "port the Databricks-chain GENERATOR files" scope covers — the override
// below is real and correctly reachable for the narrow condition it guards, but any
// row that actually reaches the `super()` call still throws, announced rather than
// faked, same as every other pre-existing base gap this chain's dialects surface
// (`lateral_sql` before this same step, `set_operation`/`Union` handling, still).

import * as exp from "../expressions/index.js";
import { date_delta_sql, groupconcat_sql, timestamptrunc_sql } from "../dialects/dialect.js";
import { any_to_exists, eliminate_distinct_on, preprocess, unnest_to_explode } from "../transforms.js";
import { SparkGenerator } from "./spark.js";

/** py:13 `class DatabricksGenerator(SparkGenerator)`. */
export class DatabricksGenerator extends SparkGenerator {
  static TABLESAMPLE_SEED_KEYWORD = "REPEATABLE";
  static COPY_PARAMS_ARE_WRAPPED = false;
  static COPY_PARAMS_EQ_REQUIRED = true;
  static JSON_PATH_SINGLE_QUOTE_ESCAPE = false;
  static JSON_PATH_KEY_QUOTED_FORCES_BRACKETS = true;
  static SAFE_JSON_PATH_KEY_RE = exp.SAFE_IDENTIFIER_RE;
  static QUOTE_JSON_PATH = false;
  static PARSE_JSON_NAME = "PARSE_JSON";

  /**
   * py:23 `TRANSFORMS = {k: v for k, v in {**SparkGenerator.TRANSFORMS, ...}.items() if v is not None}`.
   * Same build-then-delete shape `spark2.js`/`spark.js` already established:
   * `exp.RegexpLike`/`exp.TryCast` are removed so dispatch falls through to base
   * `Generator`'s own methods (real, for both — `TryCast` reaches `trycast_sql`,
   * `RegexpLike` reaches nothing named `regexplike_sql` anywhere in the MRO and so
   * falls to the generic `exp.Func` fallback) instead of the Hive/Spark rewrites.
   */
  static TRANSFORMS = (() => {
    const t = new Map([
      ...SparkGenerator.TRANSFORMS,
      [exp.CurrentVersion, () => "CURRENT_VERSION()"],
      [exp.DateAdd, date_delta_sql("DATEADD")],
      [exp.DateDiff, date_delta_sql("DATEDIFF")],
      [exp.DatetimeAdd, (self, e) => self.func("TIMESTAMPADD", e.args.unit, e.expression, e.this)],
      [
        exp.DatetimeSub,
        (self, e) =>
          self.func(
            "TIMESTAMPADD",
            e.args.unit,
            new exp.Mul({ this: e.expression, expression: exp.Literal.number(-1) }),
            e.this,
          ),
      ],
      [exp.DatetimeTrunc, timestamptrunc_sql()],
      [exp.GroupConcat, groupconcat_sql],
      [exp.Select, preprocess([eliminate_distinct_on, unnest_to_explode, any_to_exists])],
      [exp.JSONExtract, (self, e) => `${self.sql(e, "this")}:${self.sql(e, "expression")}`],
      [
        exp.JSONPathRoot,
        (self, e) => {
          const p = e.parent;
          const check = p ? p.parent : p;
          return check instanceof exp.JSONExtractScalar ? "$" : "";
        },
      ],
      [
        exp.ToChar,
        (self, e) =>
          e.args.is_numeric
            ? self.cast_sql(new exp.Cast({ this: e.this, to: new exp.DataType({ this: "STRING" }) }))
            : self.function_fallback_sql(e),
      ],
      [exp.CurrentCatalog, () => "CURRENT_CATALOG()"],
      [exp.RegrAvgx, (self, e) => self._regr_sql(e)],
      [exp.RegrSxx, (self, e) => self._regr_sql(e)],
      [exp.RegrSyy, (self, e) => self._regr_sql(e)],
    ]);

    t.delete(exp.RegexpLike);
    t.delete(exp.TryCast);

    return t;
  })();

  static TYPE_MAPPING = new Map([...SparkGenerator.TYPE_MAPPING, [exp.DType.NULL, "VOID"]]);

  /**
   * py:72
   * @param {exp.Create} expression
   * @returns {string}
   */
  create_sql(expression) {
    const body = expression.expression;
    if (
      body &&
      !(body instanceof exp.Return) &&
      expression.kind === "FUNCTION" &&
      [...expression.findAll(exp.ReturnsProperty)].some((p) => p.args.is_table)
    ) {
      expression.set("expression", new exp.Return({ this: body }));
    }
    return super.create_sql(expression);
  }

  /**
   * py:83 `columndef_sql(self, expression, sep=" ")`.
   * @param {exp.ColumnDef} expression
   * @param {string} [sep]
   * @returns {string}
   */
  columndef_sql(expression, sep = " ") {
    const constraint = expression.find(exp.GeneratedAsIdentityColumnConstraint);
    const kind = expression.kind;
    if (constraint && kind instanceof exp.DataType && exp.DataType.INTEGER_TYPES.has(kind.this)) {
      // only BIGINT generated identity constraints are supported
      expression.set("kind", exp.DType.BIGINT.intoExpr());
    }

    return super.columndef_sql(expression, sep);
  }

  /**
   * py:96
   * @param {exp.TimeseriesKey} expression
   * @returns {string}
   */
  timeserieskey_sql(expression) {
    return `${this.sql(expression, "this")} TIMESERIES`;
  }

  /**
   * py:99
   * @param {exp.JSONPath} expression
   * @returns {string}
   */
  jsonpath_sql(expression) {
    expression.set("escape", null);
    const path = super.jsonpath_sql(expression);

    if (expression.parent instanceof exp.JSONExtractScalar) {
      return `${this.dialect.QUOTE_START}${path}${this.dialect.QUOTE_END}`;
    }

    return path;
  }

  /**
   * py:108
   * @param {exp.Uniform} expression
   * @returns {string}
   */
  uniform_sql(expression) {
    let seed = expression.args.seed;

    // From Snowflake UNIFORM(min, max, gen) as RANDOM(), RANDOM(seed), or constant value -> Extract seed
    const gen = expression.args.gen;
    if (gen) seed = gen.this;

    return this.func("UNIFORM", expression.this, expression.expression, seed);
  }

  /**
   * py:118
   * @param {exp.RegrAvgx|exp.RegrSxx|exp.RegrSyy} expression
   * @returns {string}
   */
  _regr_sql(expression) {
    const name = expression.constructor.sqlName();
    const x = expression.expression;
    if (x instanceof exp.Distinct) {
      return this.func(name, new exp.Distinct({ expressions: [expression.this] }), ...x.expressions);
    }
    return this.func(name, expression.this, x);
  }

  /**
   * py:125
   * @param {exp.ClusterProperty} expression
   * @returns {string}
   */
  clusterproperty_sql(expression) {
    const this_ = this.sql(expression, "this") || `(${this.expressions(expression, null, { flat: true })})`;
    return `CLUSTER BY ${this_}`;
  }
}
