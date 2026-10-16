// py: sqlglot/dialects/solr.py @ 91119bc — `class Solr(Dialect)`, AIR-2292 (epic
// AIR-2272, "12.7 Small dialects", batch B).
//
// SETTINGS ONLY, same split as every other dialect: `sqlglot/parsers/solr.py` (the
// grammar, 16 LOC) and `sqlglot/generators/solr.py` (7 LOC) are different upstream
// files, ported to `src/parsers/solr.js`/`src/generators/solr.js` in this same
// round. `Solr(Dialect)` is standalone, not part of a subclass chain.
//
// There is no `typing/solr.py` upstream — Solr inherits the base `Dialect`'s
// 294-entry `EXPRESSION_METADATA` table unmodified.

import { Tokenizer, initTokenizerSubclass } from "../tokens.js";
import { SolrParser } from "../parsers/solr.js";
import { SolrGenerator } from "../generators/solr.js";
import { Dialect, Dialects, NormalizationStrategy, registerDialect } from "./dialect.js";

/** py: sqlglot/dialects/solr.py:19 `class Tokenizer(tokens.Tokenizer)`. */
class SolrTokenizer extends Tokenizer {
  /** py:20 */
  static QUOTES = ["'"];
  /** py:21 */
  static IDENTIFIERS = ["`"];
}
initTokenizerSubclass(SolrTokenizer);

/** py: sqlglot/dialects/solr.py:10 `class Solr(Dialect)`. */
export class Solr extends Dialect {
  // https://solr.apache.org/guide/solr/latest/query-guide/sql-query.html
  static NORMALIZATION_STRATEGY = NormalizationStrategy.CASE_INSENSITIVE;
  static DPIPE_IS_STRING_CONCAT = false;

  /** py:16 `Generator = SolrGenerator`. */
  static Generator = SolrGenerator;

  /** py:18 `Parser = SolrParser`. */
  static Parser = SolrParser;

  /** py:19 `class Tokenizer(tokens.Tokenizer)`; see `SolrTokenizer` above. */
  static Tokenizer = SolrTokenizer;
}

registerDialect(Dialects.SOLR, Solr);
