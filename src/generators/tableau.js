// py: sqlglot/generators/tableau.py @ 91119bc — WHOLE FILE (50 LOC), AIR-2292 (epic
// AIR-2272, "12.7 Small dialects", batch B).
//
// `class TableauGenerator(generator.Generator)` — lands in the same round as
// `dialects/tableau.py` (`src/dialects/tableau.js`) and `parsers/tableau.py`
// (`src/parsers/tableau.js`). Self-contained: extends the base `Generator`
// directly.
//
// `rename_func` and `strposition_sql` (aliased `_strposition_sql`, same as
// upstream's own `as` import) already exist in `src/dialects/dialect.js`;
// `transforms.preprocess`/`transforms.eliminate_distinct_on` already exist in
// `src/transforms.js` — no new base-helper work required here.

import * as exp from "../expressions/index.js";
import { Generator, AFTER_HAVING_MODIFIER_TRANSFORMS } from "../generator.js";
import { rename_func, strposition_sql as _strposition_sql } from "../dialects/dialect.js";
import { preprocess, eliminate_distinct_on } from "../transforms.js";

/** py: sqlglot/generators/tableau.py:9 `class TableauGenerator(generator.Generator)`. */
export class TableauGenerator extends Generator {
  /** py:10 */
  static SELECT_KINDS = [];
  /** py:11 */
  static TRY_SUPPORTED = false;
  /** py:12 */
  static SUPPORTS_UESCAPE = false;
  /** py:13 */
  static SUPPORTS_DECODE_CASE = false;

  /** py:15 */
  static AFTER_HAVING_MODIFIER_TRANSFORMS = AFTER_HAVING_MODIFIER_TRANSFORMS;

  /** py:17 */
  static JOIN_HINTS = false;
  /** py:18 */
  static TABLE_HINTS = false;
  /** py:19 */
  static QUERY_HINTS = false;

  /** py:21 */
  static TRANSFORMS = new Map([
    ...Generator.TRANSFORMS,
    [exp.Coalesce, rename_func("IFNULL")],
    [exp.Select, preprocess([eliminate_distinct_on])],
  ]);

  /** py:27 */
  static PROPERTIES_LOCATION = new Map([
    ...Generator.PROPERTIES_LOCATION,
    [exp.VolatileProperty, exp.Properties.Location.UNSUPPORTED],
  ]);

  /** py:32 `if_sql(self, expression: exp.If) -> str`. */
  if_sql(expression) {
    const this_ = this.sql(expression, "this");
    const true_ = this.sql(expression, "true");
    const false_ = this.sql(expression, "false");
    return `IF ${this_} THEN ${true_} ELSE ${false_} END`;
  }

  /** py:38 `count_sql(self, expression: exp.Count) -> str`. */
  count_sql(expression) {
    const this_ = expression.this;
    if (this_ instanceof exp.Distinct) return this.func("COUNTD", ...this_.expressions);
    return this.func("COUNT", this_);
  }

  /** py:44 `strposition_sql(self, expression: exp.StrPosition) -> str`. */
  strposition_sql(expression) {
    const has_occurrence = "occurrence" in expression.args;
    return _strposition_sql(this, expression, {
      func_name: has_occurrence ? "FINDNTH" : "FIND",
      supports_occurrence: has_occurrence,
    });
  }
}
