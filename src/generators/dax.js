// py: sqlglot/generators/dax.py @ 91119bc — WHOLE FILE (7 LOC), AIR-2292 (epic
// AIR-2272, "12.7 Small dialects", batch B).
//
// `class DAXGenerator(generator.Generator)` — lands in the same round as
// `dialects/dax.py` (`src/dialects/dax.js`) and `parsers/dax.py`
// (`src/parsers/dax.js`). Self-contained: extends the base `Generator` directly.

import { Generator, AFTER_HAVING_MODIFIER_TRANSFORMS } from "../generator.js";

/** py: sqlglot/generators/dax.py:6 `class DAXGenerator(generator.Generator)`. */
export class DAXGenerator extends Generator {
  /** py:7 */
  static AFTER_HAVING_MODIFIER_TRANSFORMS = AFTER_HAVING_MODIFIER_TRANSFORMS;
}
