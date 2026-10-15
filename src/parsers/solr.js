// py: sqlglot/parsers/solr.py @ 91119bc — WHOLE FILE (16 LOC), AIR-2292 (epic
// AIR-2272, "12.7 Small dialects", batch B).
//
// `class SolrParser(parser.Parser)` — the READ-side Solr SQL grammar. Lands in the
// same round as `dialects/solr.py` (`src/dialects/solr.js`) and `generators/solr.py`
// (`src/generators/solr.js`), the "full stack in one round" shape R38/R103/R109/R110
// used. Self-contained: extends the base `Parser` directly, no subclass chain.

import { Parser } from "../parser.js";
import { TokenType } from "../tokens.js";
import * as exp from "../expressions/index.js";

/** py: sqlglot/parsers/solr.py:8 `class SolrParser(parser.Parser)`. */
export class SolrParser extends Parser {
  /** py:9 */
  static TABLE_ALIAS_TOKENS = new Set([
    ...Parser.TABLE_ALIAS_TOKENS,
    TokenType.ANTI,
    TokenType.SEMI,
  ]);

  /** py:14 */
  static DISJUNCTION = new Map([
    ...Parser.DISJUNCTION,
    [TokenType.DPIPE, exp.Or],
  ]);
}
