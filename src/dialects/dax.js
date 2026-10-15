// py: sqlglot/dialects/dax.py @ 91119bc — `class DAX(Dialect)`, AIR-2292 (epic
// AIR-2272, "12.7 Small dialects", batch B).
//
// SETTINGS ONLY, same split as every other dialect: `sqlglot/parsers/dax.py` (48
// LOC) and `sqlglot/generators/dax.py` (7 LOC) are different upstream files,
// ported to `src/parsers/dax.js`/`src/generators/dax.js` in this same round.
// `DAX(Dialect)` is standalone, not part of a subclass chain.
//
// There is no `typing/dax.py` upstream — DAX inherits the base `Dialect`'s
// 294-entry `EXPRESSION_METADATA` table unmodified.

import { Tokenizer, initTokenizerSubclass } from "../tokens.js";
import { DAXParser } from "../parsers/dax.js";
import { DAXGenerator } from "../generators/dax.js";
import { Dialect, Dialects, registerDialect } from "./dialect.js";

/** py: sqlglot/dialects/dax.py:11 `class Tokenizer(tokens.Tokenizer)`. */
class DAXTokenizer extends Tokenizer {
  /** py:12 */
  static IDENTIFIERS = ["'", ["[", "]"]];
  /** py:13 */
  static QUOTES = ['"'];
  /** py:14 */
  static STRING_ESCAPES = ['"'];
  /** py:15 */
  static COMMENTS = ["--", "//", ["/*", "*/"]];
}
initTokenizerSubclass(DAXTokenizer);

/** py: sqlglot/dialects/dax.py:8 `class DAX(Dialect)`. */
export class DAX extends Dialect {
  static DPIPE_IS_STRING_CONCAT = false;

  /** py:10 `Generator = DAXGenerator`. */
  static Generator = DAXGenerator;

  /** py:11 `class Tokenizer(tokens.Tokenizer)`; see `DAXTokenizer` above. */
  static Tokenizer = DAXTokenizer;

  /** py:17 `Parser = DAXParser`. */
  static Parser = DAXParser;
}

registerDialect(Dialects.DAX, DAX);
