// py: sqlglot/dialects/exasol.py @ 91119bc — `class Exasol(Dialect)`, AIR-2289 (epic
// AIR-2272, "12.4 Exasol").
//
// SETTINGS ONLY, same split as every other dialect: `sqlglot/parsers/exasol.py` (the
// grammar, 164 LOC) is a DIFFERENT upstream file, ported to `src/parsers/exasol.js`
// in this same round. `sqlglot/generators/exasol.py` (963 LOC, `src/generators/
// exasol.js`) also lands in this round — same "full stack in one round" shape R38
// (Redshift) and R103 (Presto) used. `Exasol(Dialect)` is standalone, not part of a
// subclass chain.
//
// There is no `typing/exasol.py` upstream — Exasol inherits the base `Dialect`'s
// 294-entry `EXPRESSION_METADATA` table unmodified, unlike every dialect that DOES
// declare its own overlay (Presto, MySQL, ...). No field is declared here for it.
//
// `KEYWORDS.pop("DIV")` (py:66) is a mutation AFTER the merge, not an entry omitted
// from it — same `initTokenizerSubclass`-ordering shape `presto.js`'s own two
// `KEYWORDS.delete(...)` calls document. `DIV` is dropped from the tokenizer's
// keyword table because `ExasolParser.FUNCTIONS` (`src/parsers/exasol.js`) maps the
// `DIV` function-call spelling to `exp.IntDiv` directly; without the pop, `DIV` would
// tokenize as an infix operator keyword instead of reaching the function parser.
//
// `SUPPORTS_COLUMN_JOIN_MARKS = True` (py:20) is faithfully transliterated below even
// though it has no observable effect: `registerDialect`'s metaclass-equivalent step
// unconditionally OVERWRITES this field with `tokenizer_class.KEYWORDS.has("(+)")`
// (`src/dialects/dialect.js`, mirroring `_Dialect.__new__`'s own unconditional
// `klass.SUPPORTS_COLUMN_JOIN_MARKS = "(+)" in klass.tokenizer_class.KEYWORDS`), and
// Exasol's own Tokenizer never adds `"(+)"` to KEYWORDS — verified against the pin:
// the resolved value is `False` either way, so this line is dead code upstream too,
// not a port defect. Kept here for line-for-line fidelity with py:20.

import { Tokenizer, TokenType, initTokenizerSubclass } from "../tokens.js";
import { ExasolParser, DATE_UNITS } from "../parsers/exasol.js";
import { ExasolGenerator } from "../generators/exasol.js";
import { Dialect, Dialects, NormalizationStrategy, registerDialect } from "./dialect.js";

export { DATE_UNITS };

/**
 * py: sqlglot/dialects/exasol.py:53 `class Tokenizer(tokens.Tokenizer)`.
 *
 * Declared at module level, same convention as every other dialect's nested
 * `Tokenizer`; `Exasol.Tokenizer` below points at it, which is the name
 * `registerDialect` looks for. `initTokenizerSubclass` is called explicitly right
 * after the body for the same reason every other dialect does — Python's
 * `__init_subclass__` runs at class-creation time and JS has no equivalent hook.
 */
class ExasolTokenizer extends Tokenizer {
  /** py:54 `IDENTIFIERS = ['"', ("[", "]")]`. */
  static IDENTIFIERS = ['"', ["[", "]"]];

  static KEYWORDS = new Map([
    ...Tokenizer.KEYWORDS,
    ["USER", TokenType.CURRENT_USER],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/if.htm
    ["ENDIF", TokenType.END],
    ["LONG VARCHAR", TokenType.TEXT],
    ["REGEXP_LIKE", TokenType.RLIKE],
    ["SEPARATOR", TokenType.SEPARATOR],
    ["SYSTIMESTAMP", TokenType.SYSTIMESTAMP],
    ["MINUS", TokenType.EXCEPT],
  ]);
}
// py:66 `KEYWORDS.pop("DIV")`. See file header.
ExasolTokenizer.KEYWORDS.delete("DIV");
initTokenizerSubclass(ExasolTokenizer);

/** py: sqlglot/dialects/exasol.py:14 `class Exasol(Dialect)`. */
export class Exasol extends Dialect {
  // https://docs.exasol.com/db/latest/sql_references/basiclanguageelements.htm#SQLidentifier
  static NORMALIZATION_STRATEGY = NormalizationStrategy.UPPERCASE;
  // https://docs.exasol.com/db/latest/sql_references/data_types/datatypesoverview.htm
  static SUPPORTS_USER_DEFINED_TYPES = false;
  // https://docs.exasol.com/db/latest/sql/select.htm
  static SUPPORTS_COLUMN_JOIN_MARKS = true;
  static NULL_ORDERING = "nulls_are_last";
  // https://docs.exasol.com/db/latest/sql_references/literals.htm#StringLiterals
  static CONCAT_COALESCE = true;

  /** py:25 `TIME_MAPPING`. */
  static TIME_MAPPING = new Map([
    ["yyyy", "%Y"],
    ["YYYY", "%Y"],
    ["yy", "%y"],
    ["YY", "%y"],
    ["mm", "%m"],
    ["MM", "%m"],
    ["MONTH", "%B"],
    ["MON", "%b"],
    ["dd", "%d"],
    ["DD", "%d"],
    ["DAY", "%A"],
    ["DY", "%a"],
    ["H12", "%I"],
    ["H24", "%H"],
    ["HH", "%H"],
    ["ID", "%u"],
    ["vW", "%V"],
    ["IW", "%V"],
    ["vYYY", "%G"],
    ["IYYY", "%G"],
    ["MI", "%M"],
    ["SS", "%S"],
    ["uW", "%W"],
    ["UW", "%U"],
    ["Z", "%z"],
  ]);

  /** py:68 `Parser = ExasolParser`. */
  static Parser = ExasolParser;

  /** py:70 `Generator = ExasolGenerator`. */
  static Generator = ExasolGenerator;

  /** py:53 `class Tokenizer(tokens.Tokenizer)`; see `ExasolTokenizer` above. */
  static Tokenizer = ExasolTokenizer;
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the class
// body above. Same placement and same argument as every other dialect's own call at
// the bottom of its file. Importing this module is what makes
// `Dialect.get_or_raise("exasol")` resolve.
registerDialect(Dialects.EXASOL, Exasol);
