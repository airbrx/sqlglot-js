// py: sqlglot/generators/prql.py @ 91119bc — WHOLE FILE (7 LOC), AIR-2292 (epic
// AIR-2272, "12.7 Small dialects", batch B).
//
// `class PRQLGenerator(generator.Generator)` — lands in the same round as
// `dialects/prql.py` (`src/dialects/prql.js`) and `parsers/prql.py`
// (`src/parsers/prql.js`). Self-contained: extends the base `Generator`
// directly. PRQL is read-only in practice — the Parser builds an ordinary
// `exp.Select` tree, so no PRQL-specific generation logic exists upstream
// either; this class exists only so `dialects/prql.py`'s `Generator = ` link
// resolves and `write="prql"` is reachable (it renders plain SQL).

import { Generator, AFTER_HAVING_MODIFIER_TRANSFORMS } from "../generator.js";

/** py: sqlglot/generators/prql.py:6 `class PRQLGenerator(generator.Generator)`. */
export class PRQLGenerator extends Generator {
  /** py:7 */
  static AFTER_HAVING_MODIFIER_TRANSFORMS = AFTER_HAVING_MODIFIER_TRANSFORMS;
}
