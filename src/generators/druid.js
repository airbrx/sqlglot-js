// py: sqlglot/generators/druid.py @ 91119bc — WHOLE FILE (30 LOC), AIR-2292 (epic
// AIR-2272, "12.7 Small dialects", batch B).
//
// `class DruidGenerator(generator.Generator)` — lands in the same round as
// `dialects/druid.py` (`src/dialects/druid.js`) and `parsers/druid.py`
// (`src/parsers/druid.js`). Self-contained: extends the base `Generator` directly.
//
// `rename_func` already exists in `src/dialects/dialect.js` from earlier dialect
// ports — no new base-helper work required here.

import * as exp from "../expressions/index.js";
import { Generator, AFTER_HAVING_MODIFIER_TRANSFORMS } from "../generator.js";
import { rename_func } from "../dialects/dialect.js";

/** py: sqlglot/generators/druid.py:9 `class DruidGenerator(generator.Generator)`. */
export class DruidGenerator extends Generator {
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

  /** py:18 https://druid.apache.org/docs/latest/querying/sql-data-types/ */
  static TYPE_MAPPING = new Map([
    ...Generator.TYPE_MAPPING,
    [exp.DType.NCHAR, "STRING"],
    [exp.DType.NVARCHAR, "STRING"],
    [exp.DType.TEXT, "STRING"],
    [exp.DType.UUID, "STRING"],
  ]);

  /** py:26 */
  static TRANSFORMS = new Map([
    ...Generator.TRANSFORMS,
    [exp.CurrentTimestamp, () => "CURRENT_TIMESTAMP"],
    [exp.Mod, rename_func("MOD")],
    [exp.Array, (self, e) => `ARRAY[${self.expressions(e)}]`],
  ]);
}
