// py: sqlglot/dialects/drill.py @ 91119bc — `class Drill(Dialect)`, AIR-2292 (epic
// AIR-2272, "12.7 Small dialects", batch B).
//
// SETTINGS ONLY, same split as every other dialect: `sqlglot/parsers/drill.py`
// (32 LOC) and `sqlglot/generators/drill.py` (127 LOC) are different upstream
// files, ported to `src/parsers/drill.js`/`src/generators/drill.js` in this same
// round. `Drill(Dialect)` is standalone, not part of a subclass chain.
//
// There is no `typing/drill.py` upstream — Drill inherits the base `Dialect`'s
// 294-entry `EXPRESSION_METADATA` table unmodified.
//
// `KEYWORDS.pop("/*+")` (py:59) is a mutation AFTER the merge, not an entry
// omitted from it — same `initTokenizerSubclass`-ordering shape `exasol.js`'s own
// `KEYWORDS.delete("DIV")` call documents.

import { Tokenizer, initTokenizerSubclass } from "../tokens.js";
import { DrillParser } from "../parsers/drill.js";
import { DrillGenerator } from "../generators/drill.js";
import { Dialect, Dialects, registerDialect } from "./dialect.js";

/** py: sqlglot/dialects/drill.py:54 `class Tokenizer(tokens.Tokenizer)`. */
class DrillTokenizer extends Tokenizer {
  /** py:55 */
  static IDENTIFIERS = ["`"];
  /** py:56 */
  static STRING_ESCAPES = ["\\"];

  // py:58 `KEYWORDS = tokens.Tokenizer.KEYWORDS.copy()`. A COPY, not the inherited
  // Map by reference: without its own `KEYWORDS`, `DrillTokenizer.KEYWORDS` would
  // resolve through the prototype chain to the base `Tokenizer.KEYWORDS` Map
  // instance itself, and the `.delete()` below would mutate that SHARED base map
  // for every other dialect in the process, not just Drill's own table.
  static KEYWORDS = new Map(Tokenizer.KEYWORDS);
}
// py:59 `KEYWORDS.pop("/*+")`. See file header and the `.copy()` note just above.
DrillTokenizer.KEYWORDS.delete("/*+");
initTokenizerSubclass(DrillTokenizer);

/** py: sqlglot/dialects/drill.py:10 `class Drill(Dialect)`. */
export class Drill extends Dialect {
  static NORMALIZE_FUNCTIONS = false;
  static PRESERVE_ORIGINAL_NAMES = true;
  static NULL_ORDERING = "nulls_are_last";
  static DATE_FORMAT = "'yyyy-MM-dd'";
  static DATEINT_FORMAT = "'yyyyMMdd'";
  static TIME_FORMAT = "'yyyy-MM-dd HH:mm:ss'";
  static SUPPORTS_USER_DEFINED_TYPES = false;
  static TYPED_DIVISION = true;
  static CONCAT_COALESCE = true;
  static CONCAT_WS_COALESCE = true;

  /** py:22 */
  static TIME_MAPPING = new Map([
    ["y", "%Y"],
    ["Y", "%Y"],
    ["YYYY", "%Y"],
    ["yyyy", "%Y"],
    ["YY", "%y"],
    ["yy", "%y"],
    ["MMMM", "%B"],
    ["MMM", "%b"],
    ["MM", "%m"],
    ["M", "%-m"],
    ["dd", "%d"],
    ["d", "%-d"],
    ["HH", "%H"],
    ["H", "%-H"],
    ["hh", "%I"],
    ["h", "%-I"],
    ["mm", "%M"],
    ["m", "%-M"],
    ["ss", "%S"],
    ["s", "%-S"],
    ["SSSSSS", "%f"],
    ["a", "%p"],
    ["DD", "%j"],
    ["D", "%-j"],
    ["E", "%a"],
    ["EE", "%a"],
    ["EEE", "%a"],
    ["EEEE", "%A"],
    ["''T''", "T"],
  ]);

  /** py:54 `class Tokenizer(tokens.Tokenizer)`; see `DrillTokenizer` above. */
  static Tokenizer = DrillTokenizer;

  /** py:61 `Parser = DrillParser`. */
  static Parser = DrillParser;

  /** py:63 `Generator = DrillGenerator`. */
  static Generator = DrillGenerator;
}

registerDialect(Dialects.DRILL, Drill);
