// py: sqlglot/generators/trino.py @ 91119bc — WHOLE FILE (145 LOC), AIR-2287 (epic
// AIR-2272, "12.2 Presto family"), part 2 of the chain. Third link of this round
// (parser: `src/parsers/trino.js`; dialect settings: `src/dialects/trino.js`).
//
// `class TrinoGenerator(PrestoGenerator)` — overrides Presto's own base-`Generator`
// "Unsupported ... syntax" fallbacks (`functionspecification_sql`/`ifblock_sql`/
// `casestatement_sql`/`whileblock_sql`/`loopblock_sql`/`repeatblock_sql`, all already
// real, non-stub methods on `src/generator.js` matching upstream's own base-class
// defaults) with Trino's real SQL-UDF-routine-body rendering, the generator-side half
// of `src/parsers/trino.js`'s own routine grammar.
//
// `exp.Select`'s `TRANSFORMS` ENTRY INCLUDES `explode_projection_to_unnest(1)` — NO GAP
// -------------------------------------------------------------------------
// `generators/presto.js`'s own header documents a DELIBERATE omission of
// `transforms.explode_projection_to_unnest` from ITS `exp.Select` chain, because at
// R103 time the function did not exist in this port's `src/transforms.js` yet.
// AIR-2300/#119 has since landed it (merged into `main`, R104/R10x), so this file's
// own `exp.Select` entry — which upstream defines FRESH on `TrinoGenerator`, not by
// inheriting Presto's chain — uses the real function directly; there is no gap to
// file here. (Presto's own chain still omits it; that is Presto's own residual, not
// this round's scope per the brief.)

import * as exp from "../expressions/index.js";
import * as transforms from "../transforms.js";
import {
  merge_without_target_sql,
  trim_sql,
  timestrtotime_sql,
  groupconcat_sql,
  rename_func,
} from "../dialects/dialect.js";
import { PrestoGenerator, amend_exploded_column_table } from "./presto.js";

/** py: sqlglot/generators/trino.py:14 `class TrinoGenerator(PrestoGenerator)`. */
export class TrinoGenerator extends PrestoGenerator {
  static EXCEPT_INTERSECT_SUPPORT_ALL_CLAUSE = true;
  static DECLARE_DEFAULT_ASSIGNMENT = "DEFAULT";

  static PROPERTIES_LOCATION = new Map([
    ...PrestoGenerator.PROPERTIES_LOCATION,
    [exp.LocationProperty, exp.Properties.Location.POST_WITH],
  ]);

  static TRANSFORMS = new Map([
    ...PrestoGenerator.TRANSFORMS,
    [exp.ArraySum, (self, e) => (
      `REDUCE(${self.sql(e, "this")}, 0, (acc, x) -> acc + x, acc -> acc)`
    )],
    [exp.ArrayUniqueAgg, (self, e) => `ARRAY_AGG(DISTINCT ${self.sql(e, "this")})`],
    [exp.CurrentVersion, rename_func("VERSION")],
    [exp.FromISO8601TimestampNanos, rename_func("FROM_ISO8601_TIMESTAMP_NANOS")],
    [exp.GroupConcat, (self, e) => groupconcat_sql(self, e, { on_overflow: true })],
    [exp.LocationProperty, (self, e) => self.property_sql(e)],
    [exp.Merge, merge_without_target_sql],
    [exp.Select, transforms.preprocess([
      transforms.eliminate_qualify,
      transforms.eliminate_distinct_on,
      transforms.explode_projection_to_unnest(1),
      transforms.eliminate_semi_and_anti_joins,
      amend_exploded_column_table,
    ])],
    [exp.StabilityProperty, (self, e) => (
      e.name === "IMMUTABLE" ? "DETERMINISTIC" : "NOT DETERMINISTIC"
    )],
    [exp.TimeStrToTime, (self, e) => timestrtotime_sql(self, e, true)],
    [exp.Trim, trim_sql],
  ]);

  static SUPPORTED_JSON_PATH_PARTS = new Set([
    exp.JSONPathKey,
    exp.JSONPathRoot,
    exp.JSONPathSubscript,
  ]);

  /** py:55 */
  functionspecification_sql(expression) {
    const characteristics = expression.args.characteristics;
    const characteristics_sql = characteristics
      ? this.properties(characteristics, " ", " ", "", false)
      : "";
    const properties = expression.args.properties;
    const with_sql = properties ? ` ${this.with_properties(properties)}` : "";
    const body = this.sql(expression, "expression");
    return `FUNCTION ${this.sql(expression, "this")}${characteristics_sql}${with_sql} ${body}`;
  }

  /** py:67 */
  ifblock_sql(expression) {
    // ELSEIF chains are nested into `false` at parse time (see
    // TrinoParser._parse_routine_if), so this flattens them back out rather
    // than recursing on ifblock_sql itself, which would re-wrap each link in
    // its own IF ... END IF.
    const branches = [];
    let node = expression;

    while (node instanceof exp.IfBlock) {
      const keyword = branches.length ? "ELSEIF" : "IF";
      branches.push(`${keyword} ${this.sql(node, "this")} THEN ${this.sql(node, "true")};`);
      node = node.args.false;
    }

    if (node !== null && node !== undefined) {
      branches.push(`ELSE ${this.sql(node)};`);
    }

    return `${branches.join(" ")} END IF`;
  }

  /** py:85 */
  casestatement_sql(expression) {
    // Mirrors case_sql, using `;`-terminated statement bodies and END CASE
    // instead of a single value expression per branch and bare END.
    const this_ = this.sql(expression, "this");
    const branches = [this_ ? `CASE ${this_}` : "CASE"];

    for (const node of expression.args.ifs) {
      branches.push(`WHEN ${this.sql(node, "this")} THEN ${this.sql(node, "true")};`);
    }

    const default_ = expression.args.default;
    if (default_) {
      branches.push(`ELSE ${this.sql(default_)};`);
    }

    branches.push("END CASE");
    return branches.join(" ");
  }

  /** py:101 */
  whileblock_sql(expression) {
    const label = expression.args.label;
    const label_sql = label ? `${this.sql(label)}: ` : "";
    const condition = this.sql(expression, "this");
    const body = this.sql(expression, "body");
    return `${label_sql}WHILE ${condition} DO ${body}; END WHILE`;
  }

  /** py:108 */
  loopblock_sql(expression) {
    const label = expression.args.label;
    const label_sql = label ? `${this.sql(label)}: ` : "";
    const body = this.sql(expression, "body");
    return `${label_sql}LOOP ${body}; END LOOP`;
  }

  /** py:114 */
  repeatblock_sql(expression) {
    const label = expression.args.label;
    const label_sql = label ? `${this.sql(label)}: ` : "";
    const body = this.sql(expression, "body");
    const until = this.sql(expression, "until");
    return `${label_sql}REPEAT ${body}; UNTIL ${until} END REPEAT`;
  }

  /** py:121 */
  leave_sql(expression) {
    return `LEAVE ${this.sql(expression, "this")}`;
  }

  /** py:124 */
  iterate_sql(expression) {
    return `ITERATE ${this.sql(expression, "this")}`;
  }

  /** py:127 */
  jsonextract_sql(expression) {
    if (!expression.args.json_query) {
      return super.jsonextract_sql(expression);
    }

    const json_path = this.sql(expression, "expression");
    let option = this.sql(expression, "option");
    option = option ? ` ${option}` : "";

    let quote = this.sql(expression, "quote");
    quote = quote ? ` ${quote}` : "";

    let on_condition = this.sql(expression, "on_condition");
    on_condition = on_condition ? ` ${on_condition}` : "";

    return this.func(
      "JSON_QUERY",
      expression.this,
      json_path + option + quote + on_condition,
    );
  }
}
