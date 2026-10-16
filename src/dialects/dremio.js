// py: sqlglot/dialects/dremio.py @ 91119bc — `class Dremio(Dialect)`, AIR-2292
// (epic AIR-2272, "12.7 Small dialects", batch B).
//
// SETTINGS ONLY, same split as every other dialect: `sqlglot/parsers/dremio.py`
// (136 LOC) and `sqlglot/generators/dremio.py` (111 LOC) are different upstream
// files, ported to `src/parsers/dremio.js`/`src/generators/dremio.js` in this
// same round. `Dremio(Dialect)` is standalone, not part of a subclass chain.
//
// There is no `typing/dremio.py` upstream — Dremio inherits the base
// `Dialect`'s 294-entry `EXPRESSION_METADATA` table unmodified.

import { Tokenizer, initTokenizerSubclass } from "../tokens.js";
import { DremioParser } from "../parsers/dremio.js";
import { DremioGenerator } from "../generators/dremio.js";
import { Dialect, Dialects, registerDialect } from "./dialect.js";

/** py: sqlglot/dialects/dremio.py:67 `class Tokenizer(tokens.Tokenizer)`. */
class DremioTokenizer extends Tokenizer {
  /** py:68 */
  static COMMENTS = ["--", "//", ["/*", "*/"]];
}
initTokenizerSubclass(DremioTokenizer);

/** py: sqlglot/dialects/dremio.py:9 `class Dremio(Dialect)`. */
export class Dremio extends Dialect {
  static SUPPORTS_USER_DEFINED_TYPES = false;
  static CONCAT_COALESCE = true;
  static CONCAT_WS_COALESCE = true;
  static TYPED_DIVISION = true;
  static NULL_ORDERING = "nulls_are_last";
  static SUPPORTS_VALUES_DEFAULT = false;

  /** py:17 */
  static TIME_MAPPING = new Map([
    // year
    ["YYYY", "%Y"],
    ["yyyy", "%Y"],
    ["YY", "%y"],
    ["yy", "%y"],
    // month / day
    ["MM", "%m"],
    ["mm", "%m"],
    ["MON", "%b"],
    ["mon", "%b"],
    ["MONTH", "%B"],
    ["month", "%B"],
    ["DDD", "%j"],
    ["ddd", "%j"],
    ["DD", "%d"],
    ["dd", "%d"],
    ["DY", "%a"],
    ["dy", "%a"],
    ["DAY", "%A"],
    ["day", "%A"],
    // hours / minutes / seconds
    ["HH24", "%H"],
    ["hh24", "%H"],
    ["HH12", "%I"],
    ["hh12", "%I"],
    ["HH", "%I"],
    ["hh", "%I"], // 24- / 12-hour
    ["MI", "%M"],
    ["mi", "%M"],
    ["SS", "%S"],
    ["ss", "%S"],
    ["FFF", "%f"],
    ["fff", "%f"],
    ["AMPM", "%p"],
    ["ampm", "%p"],
    // ISO week / century etc.
    ["WW", "%W"],
    ["ww", "%W"],
    ["D", "%w"],
    ["d", "%w"],
    ["CC", "%C"],
    ["cc", "%C"],
    // timezone
    ["TZD", "%Z"],
    ["tzd", "%Z"], // abbreviation (UTC, PST, ...)
    ["TZO", "%z"],
    ["tzo", "%z"], // numeric offset (+0200)
  ]);

  /** py:67 `class Tokenizer(tokens.Tokenizer)`; see `DremioTokenizer` above. */
  static Tokenizer = DremioTokenizer;

  /** py:70 `Parser = DremioParser`. */
  static Parser = DremioParser;

  /** py:72 `Generator = DremioGenerator`. */
  static Generator = DremioGenerator;
}

registerDialect(Dialects.DREMIO, Dremio);
