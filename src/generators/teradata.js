// py: sqlglot/generators/teradata.py @ 91119bc — WHOLE FILE (182 LOC, 13 methods), AIR-2291.
//
// `class TeradataGenerator(generator.Generator)` — the WRITE-side Teradata grammar,
// landing alongside `parsers/teradata.py` (read side) and `dialects/teradata.py`
// (settings) in this same round, PORT_PLAN.md R38's "full stack in one round"
// shape. Teradata is standalone (`extends Generator` directly), same as
// Presto/MySQL/ClickHouse — no subclass chain. No `typing/teradata.py` exists
// upstream, so `EXPRESSION_METADATA` is left undeclared on `Teradata` (the
// dialect class) and resolves through ordinary JS static-field inheritance to
// the base `Dialect.EXPRESSION_METADATA`, same shape `dialects/doris.js`'s own
// header documents for its `MySQL`-derived case.
//
// `to_number_with_nls_param` (py: dialects/dialect.py:2375) is the one module-level
// helper this file needs that no earlier dialect port had reached — Teradata is the
// only dialect in this corpus whose `TO_NUMBER` goes through it. Ported into
// `src/dialects/dialect.js` (own `// py:` anchor, right after `remove_from_array_
// using_filter`) in this same round.

import * as exp from "../expressions/index.js";
import { Generator } from "../generator.js";
import { max_or_greatest, min_or_least, rename_func, strposition_sql, to_number_with_nls_param } from "../dialects/dialect.js";
import * as transforms from "../transforms.js";

/** py: sqlglot/generators/teradata.py:16-36 */
function _date_add_sql(kind) {
  return function func(self, expression) {
    const this_ = self.sql(expression, "this");
    const unit = expression.args.unit;
    let value = self._simplify_unless_literal(expression.expression);

    if (!(value instanceof exp.Literal)) self.unsupported("Cannot add non literal");

    const kind_to_op = {};
    if (value instanceof exp.Neg) {
      kind_to_op["+"] = "-";
      kind_to_op["-"] = "+";
      value = exp.Literal.string(value.this.toPy());
    } else {
      kind_to_op["+"] = "+";
      kind_to_op["-"] = "-";
      value.set("is_string", true);
    }

    return `${this_} ${kind_to_op[kind]} ${self.sql(new exp.Interval({ this: value, unit }))}`;
  };
}

/** py: sqlglot/generators/teradata.py:39 `class TeradataGenerator(generator.Generator)`. */
export class TeradataGenerator extends Generator {
  static SELECT_KINDS = [];
  static TRY_SUPPORTED = false;
  static SUPPORTS_UESCAPE = false;
  static SUPPORTS_DECODE_CASE = false;

  static AFTER_HAVING_MODIFIER_TRANSFORMS = Generator.AFTER_HAVING_MODIFIER_TRANSFORMS;

  static LIMIT_IS_TOP = true;
  static JOIN_HINTS = false;
  static TABLE_HINTS = false;
  static QUERY_HINTS = false;
  static TABLESAMPLE_KEYWORDS = "SAMPLE";
  static LAST_DAY_SUPPORTS_DATE_PART = false;
  static CAN_IMPLEMENT_ARRAY_ANY = true;
  static TZ_TO_WITH_TIME_ZONE = true;
  static ARRAY_SIZE_NAME = "CARDINALITY";

  /** py:57-62 */
  static TYPE_MAPPING = new Map([
    ...Generator.TYPE_MAPPING,
    [exp.DType.GEOMETRY, "ST_GEOMETRY"],
    [exp.DType.DOUBLE, "DOUBLE PRECISION"],
    [exp.DType.TIMESTAMPTZ, "TIMESTAMP"],
  ]);

  /** py:64-69 */
  static PROPERTIES_LOCATION = new Map([
    ...Generator.PROPERTIES_LOCATION,
    [exp.OnCommitProperty, exp.Properties.Location.POST_INDEX],
    [exp.PartitionedByProperty, exp.Properties.Location.POST_EXPRESSION],
    [exp.StabilityProperty, exp.Properties.Location.POST_CREATE],
  ]);

  /** py:71-94 */
  static TRANSFORMS = new Map([
    ...Generator.TRANSFORMS,
    [exp.ArgMax, rename_func("MAX_BY")],
    [exp.ArgMin, rename_func("MIN_BY")],
    [exp.Max, max_or_greatest],
    [exp.Min, min_or_least],
    [exp.Pow, (self, e) => self.binary(e, "**")],
    [exp.Rand, (self, e) => self.func("RANDOM", e.args.lower, e.args.upper)],
    [
      exp.Select,
      transforms.preprocess([transforms.eliminate_distinct_on, transforms.eliminate_semi_and_anti_joins]),
    ],
    [
      exp.StrPosition,
      (self, e) => strposition_sql(self, e, { func_name: "INSTR", supports_position: true, supports_occurrence: true }),
    ],
    [
      exp.StrToDate,
      (self, e) => `CAST(${self.sql(e, "this")} AS DATE FORMAT ${self.format_time(e)})`,
    ],
    [exp.ToChar, (self, e) => self.function_fallback_sql(e)],
    [exp.ToNumber, to_number_with_nls_param],
    [exp.Use, (self, e) => `DATABASE ${self.sql(e, "this")}`],
    [exp.DateAdd, _date_add_sql("+")],
    [exp.DateSub, _date_add_sql("-")],
    [exp.Quarter, (self, e) => self.sql(new exp.Extract({ this: "QUARTER", expression: e.this }))],
  ]);

  /** py:96-98 */
  currenttimestamp_sql(expression) {
    const [prefix, suffix] = expression.this ? ["(", ")"] : ["", ""];
    return this.func("CURRENT_TIMESTAMP", expression.this, { prefix, suffix });
  }

  /** py:100-105 */
  cast_sql(expression, safe_prefix = null) {
    if (expression.to.this === exp.DType.UNKNOWN && expression.args.format) {
      // We don't actually want to print the unknown type in CAST(<value> AS FORMAT <format>)
      expression.to.pop();
    }

    return super.cast_sql(expression, safe_prefix);
  }

  /** py:107-108 */
  trycast_sql(expression) {
    return this.cast_sql(expression, "TRY");
  }

  /** py:110-115 */
  tablesample_sql(expression, tablesample_keyword = null) {
    return `${this.sql(expression, "this")} SAMPLE ${this.expressions(expression)}`;
  }

  /** py:117-118 */
  partitionedbyproperty_sql(expression) {
    return `PARTITION BY ${this.sql(expression, "this")}`;
  }

  /**
   * py:120-128. FROM before SET in Teradata UPDATE syntax
   * https://docs.teradata.com/r/Enterprise_IntelliFlex_VMware/Teradata-VantageTM-SQL-Data-Manipulation-Language-17.20/Statement-Syntax/UPDATE/UPDATE-Syntax-Basic-Form-FROM-Clause
   */
  update_sql(expression) {
    const this_ = this.sql(expression, "this");
    const from_sql = this.sql(expression, "from_");
    const set_sql = this.expressions(expression, null, { flat: true });
    const where_sql = this.sql(expression, "where");
    const sql = `UPDATE ${this_}${from_sql} SET ${set_sql}${where_sql}`;
    return this.prepend_ctes(expression, sql);
  }

  /** py:130-131 */
  mod_sql(expression) {
    return this.binary(expression, "MOD");
  }

  /** py:133-139 */
  rangen_sql(expression) {
    const this_ = this.sql(expression, "this");
    const expressions_sql = this.expressions(expression);
    let each_sql = this.sql(expression, "each");
    each_sql = each_sql ? ` EACH ${each_sql}` : "";

    return `RANGE_N(${this_} BETWEEN ${expressions_sql}${each_sql})`;
  }

  /** py:141-146 */
  lockingstatement_sql(expression) {
    const locking_clause = this.sql(expression, "this");
    const query_sql = this.sql(expression, "expression");

    return `${locking_clause} ${query_sql}`;
  }

  /** py:148-160 */
  createable_sql(expression, locations) {
    const kind = this.sql(expression, "kind").toUpperCase();
    if (kind === "TABLE" && locations.get(exp.Properties.Location.POST_NAME)) {
      const this_name = this.sql(expression.this, "this");
      const this_properties = this.properties(
        new exp.Properties({ expressions: locations.get(exp.Properties.Location.POST_NAME) }),
        ",",
        ", ",
        "",
        false,
      );
      const this_schema = this.schema_columns_sql(expression.this);
      return `${this_name}${this_properties}${this.sep()}${this_schema}`;
    }

    return super.createable_sql(expression, locations);
  }

  /** py:162-168 */
  extract_sql(expression) {
    const this_ = this.sql(expression, "this");
    if (this_.toUpperCase() !== "QUARTER") return super.extract_sql(expression);

    const to_char = exp.func("to_char", expression.expression, exp.Literal.string("Q"));
    return this.sql(exp.cast(to_char, exp.DType.INT));
  }

  /** py:170-182 */
  interval_sql(expression) {
    let multiplier = 0;
    const unit = expression.text("unit");

    if (unit.startsWith("WEEK")) multiplier = 7;
    else if (unit.startsWith("QUARTER")) multiplier = 90;

    if (multiplier) {
      return `(${multiplier} * ${super.interval_sql(new exp.Interval({ this: expression.this, unit: exp.var("DAY") }))})`;
    }

    return super.interval_sql(expression);
  }
}
