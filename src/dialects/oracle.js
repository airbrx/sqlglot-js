// py: sqlglot/dialects/oracle.py @ 91119bc — `class Oracle(Dialect)`, AIR-2290
// (epic AIR-2272, "12.5 Oracle").
//
// SETTINGS ONLY, same split as every other dialect: `sqlglot/parsers/oracle.py`
// (262 LOC) and `sqlglot/generators/oracle.py` (179 LOC) are DIFFERENT upstream
// files, ported to `src/parsers/oracle.js`/`src/generators/oracle.js` in this
// same round. Oracle has no chain (`class Oracle(Dialect)` directly) and no
// `typing/oracle.py` upstream — `EXPRESSION_METADATA` is left on the base
// `Dialect`'s own default, the same shape `doris.js`/`starrocks.js` use for their
// own missing typing files (R106), except Oracle has no parent dialect to
// inherit a richer table from either, so it is the bare 294-entry base table.
//
// `LOCKING_READS_SUPPORTED = True` (py:17) is a vestigial `Generator`-only setting
// that leaks onto this `Dialect` class upstream with no reader anywhere in
// `Dialect` itself — ported faithfully anyway (R20/R27's "hand-transcribed
// class-level value" hazard: a byte-faithful oracle comparison needs it present
// even though nothing in this class consults it; `generators/oracle.js` carries
// its own, functional, copy).

import { Tokenizer, TokenType, initTokenizerSubclass } from "../tokens.js";
import { OracleParser } from "../parsers/oracle.js";
import { OracleGenerator } from "../generators/oracle.js";
import { Dialect, Dialects, NormalizationStrategy, registerDialect } from "./dialect.js";
import * as exp from "../expressions/index.js";

/** py: sqlglot/dialects/oracle.py:59 `class Tokenizer(tokens.Tokenizer)`. */
class OracleTokenizer extends Tokenizer {
  static VAR_SINGLE_TOKENS = new Set(["@", "$", "#"]);

  /** py:62-66 `[(prefix + q, q) for q in tokens.Tokenizer.QUOTES for prefix in ("U", "u")]`. */
  static UNICODE_STRINGS = Tokenizer.QUOTES.flatMap((q) =>
    ["U", "u"].map((prefix) => [prefix + q, q]),
  );

  static NESTED_COMMENTS = false;

  static KEYWORDS = new Map([
    ...Tokenizer.KEYWORDS,
    ["(+)", TokenType.JOIN_MARKER],
    // https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Comparison-Conditions.html
    ["^=", TokenType.NEQ],
    ["BINARY_DOUBLE", TokenType.DOUBLE],
    ["BINARY_FLOAT", TokenType.FLOAT],
    ["BULK COLLECT INTO", TokenType.BULK_COLLECT_INTO],
    ["COLUMNS", TokenType.COLUMN],
    ["MATCH_RECOGNIZE", TokenType.MATCH_RECOGNIZE],
    ["MINUS", TokenType.EXCEPT],
    ["NVARCHAR2", TokenType.NVARCHAR],
    ["ORDER SIBLINGS BY", TokenType.ORDER_SIBLINGS_BY],
    ["SAMPLE", TokenType.TABLE_SAMPLE],
    ["START", TokenType.BEGIN],
    ["TOP", TokenType.TOP],
    ["VARCHAR2", TokenType.VARCHAR],
    ["SYSTIMESTAMP", TokenType.SYSTIMESTAMP],
  ]);
}
initTokenizerSubclass(OracleTokenizer);

/** py: sqlglot/dialects/oracle.py:15 `class Oracle(Dialect)`. */
export class Oracle extends Dialect {
  /** py:16 */
  static ALIAS_POST_TABLESAMPLE = true;
  /** py:17 — see file header: vestigial on `Dialect`, functional on `Generator`. */
  static LOCKING_READS_SUPPORTED = true;
  /** py:18 */
  static TABLESAMPLE_SIZE_IS_PERCENT = true;
  /** py:19 */
  static NULL_ORDERING = "nulls_are_large";
  /** py:20 */
  static ON_CONDITION_EMPTY_BEFORE_ERROR = false;
  /** py:21 */
  static ALTER_TABLE_ADD_REQUIRED_FOR_EACH_COLUMN = false;
  /** py:22 */
  static DISABLES_ALIAS_REF_EXPANSION = true;

  // See section 8: https://docs.oracle.com/cd/A97630_01/server.920/a96540/sql_elements9a.htm
  /** py:25 */
  static NORMALIZATION_STRATEGY = NormalizationStrategy.UPPERCASE;

  /**
   * py:29-48 — https://docs.oracle.com/database/121/SQLRF/sql_elements004.htm#SQLRF00212
   * https://docs.python.org/3/library/datetime.html#strftime-and-strptime-format-codes
   */
  static TIME_MAPPING = new Map([
    ["D", "%u"], // Day of week (1-7)
    ["DAY", "%A"], // name of day
    ["DD", "%d"], // day of month (1-31)
    ["DDD", "%j"], // day of year (1-366)
    ["DY", "%a"], // abbreviated name of day
    ["HH", "%I"], // Hour of day (1-12)
    ["HH12", "%I"], // alias for HH
    ["HH24", "%H"], // Hour of day (0-23)
    ["IW", "%V"], // Calendar week of year (1-52 or 1-53), as defined by the ISO 8601 standard
    ["MI", "%M"], // Minute (0-59)
    ["MM", "%m"], // Month (01-12; January = 01)
    ["MON", "%b"], // Abbreviated name of month
    ["MONTH", "%B"], // Name of month
    ["SS", "%S"], // Second (0-59)
    ["WW", "%W"], // Week of year (1-53)
    ["YY", "%y"], // 15
    ["YYYY", "%Y"], // 2015
    ["FF6", "%f"], // only 6 digits are supported in python formats
  ]);

  /** py:50 */
  static PSEUDOCOLUMNS = new Set(["ROWNUM", "ROWID", "OBJECT_ID", "OBJECT_VALUE", "LEVEL"]);

  /**
   * py:52-57
   *
   * Disable quoting for pseudocolumns as it may break queries e.g
   * `WHERE "ROWNUM" = ...` does not work but `WHERE ROWNUM = ...` does
   */
  can_quote(identifier, identify = "safe") {
    return (
      (identifier.quoted || !(identifier.parent instanceof exp.Pseudocolumn)) &&
      super.can_quote(identifier, identify)
    );
  }

  /** py:59 `class Tokenizer(tokens.Tokenizer)`; see `OracleTokenizer` above. */
  static Tokenizer = OracleTokenizer;

  /** py:90 `Parser = OracleParser`. */
  static Parser = OracleParser;

  /** py:92 `Generator = OracleGenerator`. */
  static Generator = OracleGenerator;
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the class
// body above. Same placement and same argument as every other dialect's own call at
// the bottom of its file. Importing this module is what makes
// `Dialect.get_or_raise("oracle")` resolve.
registerDialect(Dialects.ORACLE, Oracle);
