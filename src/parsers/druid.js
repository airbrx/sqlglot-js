// py: sqlglot/parsers/druid.py @ 91119bc — WHOLE FILE (10 LOC), AIR-2292 (epic
// AIR-2272, "12.7 Small dialects", batch B).
//
// `class DruidParser(Parser)` — the READ-side Druid SQL grammar. Lands in the same
// round as `dialects/druid.py` (`src/dialects/druid.js`) and `generators/druid.py`
// (`src/generators/druid.js`). Self-contained: extends the base `Parser` directly.

import { Parser } from "../parser.js";

/** py: sqlglot/parsers/druid.py:6 `class DruidParser(Parser)`. */
export class DruidParser extends Parser {
  /** py:7 */
  static FUNCTION_PARSERS = new Map([
    ...Parser.FUNCTION_PARSERS,
    ["JSON_VALUE", (self) => self._parse_json_value()],
  ]);
}
