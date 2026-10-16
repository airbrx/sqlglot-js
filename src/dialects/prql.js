// py: sqlglot/dialects/prql.py @ 91119bc — `class PRQL(Dialect)`, AIR-2292 (epic
// AIR-2272, "12.7 Small dialects", batch B).
//
// SETTINGS ONLY, same split as every other dialect: `sqlglot/parsers/prql.py`
// (194 LOC, the real grammar — PRQL is NOT SQL, see that file's own header) and
// `sqlglot/generators/prql.py` (7 LOC) are different upstream files, ported to
// `src/parsers/prql.js`/`src/generators/prql.js` in this same round.
// `PRQL(Dialect)` is standalone, not part of a subclass chain. Note upstream
// declares NO `Parser =` link in the class body text order (it comes after the
// nested `Tokenizer`); the `static` field order below follows that, though JS
// static-field evaluation order has no observable effect on resolution either
// way since `registerDialect` reads the finished class, not field-by-field.
//
// There is no `typing/prql.py` upstream — PRQL inherits the base `Dialect`'s
// 294-entry `EXPRESSION_METADATA` table unmodified.

import { Tokenizer, TokenType, initTokenizerSubclass } from "../tokens.js";
import { PRQLParser } from "../parsers/prql.js";
import { PRQLGenerator } from "../generators/prql.js";
import { Dialect, Dialects, registerDialect } from "./dialect.js";

/** py: sqlglot/dialects/prql.py:15 `class Tokenizer(tokens.Tokenizer)`. */
class PRQLTokenizer extends Tokenizer {
  /** py:16 */
  static IDENTIFIERS = ["`"];
  /** py:17 */
  static QUOTES = ["'", '"'];

  /** py:19 */
  static SINGLE_TOKENS = new Map([
    ...Tokenizer.SINGLE_TOKENS,
    ["=", TokenType.ALIAS],
    ["'", TokenType.QUOTE],
    ['"', TokenType.QUOTE],
    ["`", TokenType.IDENTIFIER],
    ["#", TokenType.COMMENT],
  ]);

  // py:28 `KEYWORDS = {**tokens.Tokenizer.KEYWORDS}`. A COPY, not the inherited
  // Map by reference — see `drill.js`'s own note on why an inherited static Map
  // must be copied before any later mutation, even though nothing here mutates
  // this one afterward; kept as a genuine copy for fidelity with the upstream
  // dict-unpacking line regardless.
  static KEYWORDS = new Map(Tokenizer.KEYWORDS);
}
initTokenizerSubclass(PRQLTokenizer);

/** py: sqlglot/dialects/prql.py:10 `class PRQL(Dialect)`. */
export class PRQL extends Dialect {
  static DPIPE_IS_STRING_CONCAT = false;

  /** py:13 `Generator = PRQLGenerator`. */
  static Generator = PRQLGenerator;

  /** py:15 `class Tokenizer(tokens.Tokenizer)`; see `PRQLTokenizer` above. */
  static Tokenizer = PRQLTokenizer;

  /** py:32 `Parser = PRQLParser`. */
  static Parser = PRQLParser;
}

registerDialect(Dialects.PRQL, PRQL);
