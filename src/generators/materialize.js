// py: sqlglot/generators/materialize.py — `class MaterializeGenerator(PostgresGenerator)`.
//
// Last link of the Materialize port (parser -> dialect settings -> generator),
// extending the already-real `PostgresGenerator` (src/generators/postgres.js) at a
// single level, same shape `dialects/materialize.js` uses for its own settings class.
// AIR-2292, "12.7 Small dialects", batch A.
//
// Every setting below is diffed value-by-value against CPython by
// `spike/p5/fuzz_materialize_dialect.mjs`.

import * as exp from "../expressions/index.js";
import { seqGet } from "../helper.js";
import * as transforms from "../transforms.js";
import { PostgresGenerator } from "./postgres.js";

/** py: sqlglot/generators/materialize.py:14 `class MaterializeGenerator(PostgresGenerator)`. */
export class MaterializeGenerator extends PostgresGenerator {
  static SUPPORTS_CREATE_TABLE_LIKE = false;
  static SUPPORTS_BETWEEN_FLAGS = false;

  // py:19 `{**{k: v for k, v in PostgresGenerator.TRANSFORMS.items() if k != exp.ToMap}, ...}`
  static TRANSFORMS = new Map([
    ...[...PostgresGenerator.TRANSFORMS].filter(([k]) => k !== exp.ToMap),
    [exp.AutoIncrementColumnConstraint, () => ""],
    [exp.Create, transforms.preprocess([
      transforms.remove_unique_constraints,
      transforms.ctas_with_tmp_tables_to_create_tmp_view,
    ])],
    [exp.GeneratedAsIdentityColumnConstraint, () => ""],
    [exp.OnConflict, () => ""],
    [exp.PrimaryKeyColumnConstraint, () => ""],
  ]);

  /** py:32 */
  propertyeq_sql(expression) {
    return this.binary(expression, "=>");
  }

  /** py:35 */
  datatype_sql(expression) {
    if (expression.isType(exp.DType.LIST)) {
      if (expression.expressions.length) {
        return `${this.expressions(expression, null, { flat: true })} LIST`;
      }
      return "LIST";
    }

    if (expression.isType(exp.DType.MAP) && expression.expressions.length === 2) {
      const [key, value] = expression.expressions;
      return `MAP[${this.sql(key)} => ${this.sql(value)}]`;
    }

    return super.datatype_sql(expression);
  }

  /** py:47 */
  list_sql(expression) {
    if (seqGet(expression.expressions, 0) instanceof exp.Select) {
      return this.func("LIST", seqGet(expression.expressions, 0));
    }

    return `${this.normalize_func("LIST")}[${this.expressions(expression, null, { flat: true })}]`;
  }

  /** py:53 */
  tomap_sql(expression) {
    if (expression.this instanceof exp.Select) {
      return this.func("MAP", expression.this);
    }
    return `${this.normalize_func("MAP")}[${this.expressions(expression.this)}]`;
  }
}
