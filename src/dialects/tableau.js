// py: sqlglot/dialects/tableau.py @ 91119bc — `class Tableau(Dialect)`, AIR-2292
// (epic AIR-2272, "12.7 Small dialects", batch B).
//
// SETTINGS ONLY, same split as every other dialect: `sqlglot/parsers/tableau.py`
// (16 LOC) and `sqlglot/generators/tableau.py` (50 LOC) are different upstream
// files, ported to `src/parsers/tableau.js`/`src/generators/tableau.js` in this
// same round. `Tableau(Dialect)` is standalone, not part of a subclass chain.
//
// There is no `typing/tableau.py` upstream — Tableau inherits the base
// `Dialect`'s 294-entry `EXPRESSION_METADATA` table unmodified.

import { Tokenizer, initTokenizerSubclass } from "../tokens.js";
import { TableauParser } from "../parsers/tableau.js";
import { TableauGenerator } from "../generators/tableau.js";
import { Dialect, Dialects, registerDialect } from "./dialect.js";

/** py: sqlglot/dialects/tableau.py:10 `class Tokenizer(tokens.Tokenizer)`. */
class TableauTokenizer extends Tokenizer {
  /** py:11 */
  static IDENTIFIERS = [["[", "]"]];
  /** py:12 */
  static QUOTES = ["'", '"'];
}
initTokenizerSubclass(TableauTokenizer);

/** py: sqlglot/dialects/tableau.py:8 `class Tableau(Dialect)`. */
export class Tableau extends Dialect {
  static LOG_BASE_FIRST = false;

  /** py:10 `class Tokenizer(tokens.Tokenizer)`; see `TableauTokenizer` above. */
  static Tokenizer = TableauTokenizer;

  /** py:14 `Generator = TableauGenerator`. */
  static Generator = TableauGenerator;

  /** py:16 `Parser = TableauParser`. */
  static Parser = TableauParser;
}

registerDialect(Dialects.TABLEAU, Tableau);
