// py: sqlglot/generators/risingwave.py — `class RisingWaveGenerator(PostgresGenerator)`.
//
// Last link of the RisingWave port (parser -> dialect settings -> generator),
// extending the already-real `PostgresGenerator` (src/generators/postgres.js) at a
// single level, same shape `dialects/risingwave.js` uses for its own settings class.
// AIR-2292, "12.7 Small dialects", batch A.
//
// `computedcolumnconstraint_sql` (py:24) calls the BASE `Generator` method directly,
// bypassing Postgres's own override — same shape `generators/redshift.js`'s
// `ignorenulls_sql`/`respectnulls_sql` already established for this port.
//
// Every setting below is diffed value-by-value against CPython by
// `spike/p5/fuzz_risingwave_dialect.mjs`.

import * as exp from "../expressions/index.js";
import { Generator } from "../generator.js";
import { PostgresGenerator } from "./postgres.js";

/** py: sqlglot/generators/risingwave.py:8 `class RisingWaveGenerator(PostgresGenerator)`. */
export class RisingWaveGenerator extends PostgresGenerator {
  static LOCKING_READS_SUPPORTED = false;
  static SUPPORTS_BETWEEN_FLAGS = false;

  static TRANSFORMS = new Map([
    ...PostgresGenerator.TRANSFORMS,
    [exp.FileFormatProperty, (self, e) => `FORMAT ${self.sql(e, "this")}`],
  ]);

  static PROPERTIES_LOCATION = new Map([
    ...PostgresGenerator.PROPERTIES_LOCATION,
    [exp.FileFormatProperty, exp.Properties.Location.POST_EXPRESSION],
  ]);

  static EXPRESSION_PRECEDES_PROPERTIES_CREATABLES = new Set(["SINK"]);

  /** py:24 */
  computedcolumnconstraint_sql(expression) {
    return Generator.prototype.computedcolumnconstraint_sql.call(this, expression);
  }

  /** py:27 */
  datatype_sql(expression) {
    if (expression.isType(exp.DType.MAP) && expression.expressions.length === 2) {
      const [key_type, value_type] = expression.expressions;
      return `MAP(${this.sql(key_type)}, ${this.sql(value_type)})`;
    }

    return super.datatype_sql(expression);
  }
}
