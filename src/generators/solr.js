// py: sqlglot/generators/solr.py @ 91119bc — WHOLE FILE (7 LOC), AIR-2292 (epic
// AIR-2272, "12.7 Small dialects", batch B).
//
// `class SolrGenerator(generator.Generator)` — lands in the same round as
// `dialects/solr.py` (`src/dialects/solr.js`) and `parsers/solr.py`
// (`src/parsers/solr.js`). Self-contained: extends the base `Generator` directly.
// The one line this file carries (re-declaring `AFTER_HAVING_MODIFIER_TRANSFORMS`
// to the base module-level constant) is a no-op transliterated for fidelity —
// `Generator.AFTER_HAVING_MODIFIER_TRANSFORMS` already equals that constant.

import { Generator, AFTER_HAVING_MODIFIER_TRANSFORMS } from "../generator.js";

/** py: sqlglot/generators/solr.py:6 `class SolrGenerator(generator.Generator)`. */
export class SolrGenerator extends Generator {
  /** py:7 */
  static AFTER_HAVING_MODIFIER_TRANSFORMS = AFTER_HAVING_MODIFIER_TRANSFORMS;
}
