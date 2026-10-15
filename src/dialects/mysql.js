// py: sqlglot/dialects/mysql.py — `class MySQL(Dialect)`.
//
// SETTINGS ONLY, same split as every other dialect: `sqlglot/parsers/mysql.py` (the
// grammar) and `sqlglot/generators/mysql.py` (the write side) are different upstream
// files, already ported to `src/parsers/mysql.js`/`src/generators/mysql.js`
// (PORT_PLAN.md, AIR-2286). This file adds `class MySQL extends Dialect` — matching
// upstream's own `MySQL(Dialect)` class statement — with its ~9 overridden settings,
// three hand-authored tables (`TIME_FORMAT`, `TIME_MAPPING`, `VALID_INTERVAL_UNITS`),
// the nested `Tokenizer` subclass, and the `registerDialect` call that makes
// `Dialect.get_or_raise("mysql")` resolve — same shape `tsql.js`/`snowflake.js`
// establish, including the "settings mirroring onto the prototype" point
// (PORT_PLAN.md R20) `registerDialect` exists for.
//
// `EXPRESSION_METADATA` (py:34 `= EXPRESSION_METADATA.copy()`, from
// `sqlglot/typing/mysql.py`, AIR-2099) is wired from `src/typing/mysql.js` — a
// 335-entry type-inference table (294 base + 41 MySQL-specific), seeded from the BASE
// table (not another dialect's), matching upstream's own `from sqlglot.typing import
// EXPRESSION_METADATA` at that file's own top.
//
// `Parser = MySQLParser` / `Generator = MySQLGenerator` close out this round's last
// two wiring points; both classes are real (not stubs) as of this file.

import { Tokenizer, TokenType, initTokenizerSubclass } from "../tokens.js";
import { MySQLParser } from "../parsers/mysql.js";
import { MySQLGenerator } from "../generators/mysql.js";
import { Dialects, registerDialect, Dialect, NormalizationStrategy } from "./dialect.js";
import { EXPRESSION_METADATA as MYSQL_EXPRESSION_METADATA } from "../typing/mysql.js";

/**
 * py: sqlglot/dialects/mysql.py:69 `class Tokenizer(tokens.Tokenizer)`.
 *
 * Declared at module level, same convention as every other dialect's nested
 * `Tokenizer` (JS has no nested class declarations); `MySQL.Tokenizer` below points at
 * it, which is the name `registerDialect` looks for. `initTokenizerSubclass` runs
 * right after the body for the same `__init_subclass__`-has-no-JS-equivalent reason
 * `tsql.js`/`snowflake.js`/`postgres.js` already document.
 */
class MySQLTokenizer extends Tokenizer {
  static QUOTES = ["'", '"'];
  static COMMENTS = ["--", "#", ["/*", "*/"]];
  static IDENTIFIERS = ["`"];
  static STRING_ESCAPES = ["'", '"', "\\"];
  static BIT_STRINGS = [["b'", "'"], ["B'", "'"], ["0b", ""]];
  static HEX_STRINGS = [["x'", "'"], ["X'", "'"], ["0x", ""]];
  // https://dev.mysql.com/doc/refman/8.4/en/string-literals.html
  static ESCAPE_FOLLOW_CHARS = ["0", "b", "n", "r", "t", "Z", "%", "_"];

  static NESTED_COMMENTS = false;

  static KEYWORDS = new Map([
    ...Tokenizer.KEYWORDS,
    ["BLOB", TokenType.BLOB],
    ["CHARSET", TokenType.CHARACTER_SET],
    ["DISTINCTROW", TokenType.DISTINCT],
    ["EXPLAIN", TokenType.DESCRIBE],
    ["FORCE", TokenType.FORCE],
    ["IGNORE", TokenType.IGNORE],
    ["KEY", TokenType.KEY],
    ["LOCK TABLES", TokenType.COMMAND],
    ["LONGBLOB", TokenType.LONGBLOB],
    ["LONGTEXT", TokenType.LONGTEXT],
    ["MEDIUMBLOB", TokenType.MEDIUMBLOB],
    ["MEDIUMINT", TokenType.MEDIUMINT],
    ["MEDIUMTEXT", TokenType.MEDIUMTEXT],
    ["MEMBER OF", TokenType.MEMBER_OF],
    ["MOD", TokenType.MOD],
    ["SEPARATOR", TokenType.SEPARATOR],
    ["SERIAL", TokenType.SERIAL],
    ["SIGNED", TokenType.BIGINT],
    ["SIGNED INTEGER", TokenType.BIGINT],
    ["START", TokenType.BEGIN],
    ["TIMESTAMP", TokenType.TIMESTAMPTZ],
    ["TINYBLOB", TokenType.TINYBLOB],
    ["TINYTEXT", TokenType.TINYTEXT],
    ["UNLOCK TABLES", TokenType.COMMAND],
    ["UNSIGNED", TokenType.UBIGINT],
    ["UNSIGNED INTEGER", TokenType.UBIGINT],
    ["YEAR", TokenType.YEAR],
    ["_ARMSCII8", TokenType.INTRODUCER],
    ["_ASCII", TokenType.INTRODUCER],
    ["_BIG5", TokenType.INTRODUCER],
    ["_BINARY", TokenType.INTRODUCER],
    ["_CP1250", TokenType.INTRODUCER],
    ["_CP1251", TokenType.INTRODUCER],
    ["_CP1256", TokenType.INTRODUCER],
    ["_CP1257", TokenType.INTRODUCER],
    ["_CP850", TokenType.INTRODUCER],
    ["_CP852", TokenType.INTRODUCER],
    ["_CP866", TokenType.INTRODUCER],
    ["_CP932", TokenType.INTRODUCER],
    ["_DEC8", TokenType.INTRODUCER],
    ["_EUCJPMS", TokenType.INTRODUCER],
    ["_EUCKR", TokenType.INTRODUCER],
    ["_GB18030", TokenType.INTRODUCER],
    ["_GB2312", TokenType.INTRODUCER],
    ["_GBK", TokenType.INTRODUCER],
    ["_GEOSTD8", TokenType.INTRODUCER],
    ["_GREEK", TokenType.INTRODUCER],
    ["_HEBREW", TokenType.INTRODUCER],
    ["_HP8", TokenType.INTRODUCER],
    ["_KEYBCS2", TokenType.INTRODUCER],
    ["_KOI8R", TokenType.INTRODUCER],
    ["_KOI8U", TokenType.INTRODUCER],
    ["_LATIN1", TokenType.INTRODUCER],
    ["_LATIN2", TokenType.INTRODUCER],
    ["_LATIN5", TokenType.INTRODUCER],
    ["_LATIN7", TokenType.INTRODUCER],
    ["_MACCE", TokenType.INTRODUCER],
    ["_MACROMAN", TokenType.INTRODUCER],
    ["_SJIS", TokenType.INTRODUCER],
    ["_SWE7", TokenType.INTRODUCER],
    ["_TIS620", TokenType.INTRODUCER],
    ["_UCS2", TokenType.INTRODUCER],
    ["_UJIS", TokenType.INTRODUCER],
    // https://dev.mysql.com/doc/refman/8.0/en/string-literals.html
    ["_UTF8", TokenType.INTRODUCER],
    ["_UTF16", TokenType.INTRODUCER],
    ["_UTF16LE", TokenType.INTRODUCER],
    ["_UTF32", TokenType.INTRODUCER],
    ["_UTF8MB3", TokenType.INTRODUCER],
    ["_UTF8MB4", TokenType.INTRODUCER],
    ["@@", TokenType.SESSION_PARAMETER],
  ]);

  // py:156 `COMMANDS = {*tokens.Tokenizer.COMMANDS, TokenType.REPLACE} - {TokenType.SHOW}`.
  static COMMANDS = new Set(
    [...Tokenizer.COMMANDS, TokenType.REPLACE].filter((t) => t !== TokenType.SHOW),
  );
}
initTokenizerSubclass(MySQLTokenizer);

/** py: sqlglot/dialects/mysql.py:14 `class MySQL(Dialect)`. */
export class MySQL extends Dialect {
  static PROMOTE_TO_INFERRED_DATETIME_TYPE = true;

  // https://dev.mysql.com/doc/refman/8.0/en/identifiers.html
  static IDENTIFIERS_CAN_START_WITH_DIGIT = true;

  // We default to treating all identifiers as case-sensitive, since it matches MySQL's
  // behavior on Linux systems. For MacOS and Windows systems, one can override this
  // setting by specifying `dialect="mysql, normalization_strategy = lowercase"`.
  //
  // See also https://dev.mysql.com/doc/refman/8.2/en/identifier-case-sensitivity.html
  static NORMALIZATION_STRATEGY = NormalizationStrategy.CASE_SENSITIVE;

  static TIME_FORMAT = "'%Y-%m-%d %T'";
  static DPIPE_IS_STRING_CONCAT = false;
  static SUPPORTS_USER_DEFINED_TYPES = false;
  static SAFE_DIVISION = true;
  static SAFE_TO_ELIMINATE_DOUBLE_NEGATION = false;
  static LEAST_GREATEST_IGNORES_NULLS = false;

  /**
   * py:34 `EXPRESSION_METADATA = EXPRESSION_METADATA.copy()`, from
   * `sqlglot/typing/mysql.py` (AIR-2099) — seeded from the BASE table (not another
   * dialect's), matching upstream's own `from sqlglot.typing import
   * EXPRESSION_METADATA`. See `src/typing/mysql.js` for the table itself.
   */
  static EXPRESSION_METADATA = MYSQL_EXPRESSION_METADATA;

  // https://prestodb.io/docs/current/functions/datetime.html#mysql-date-functions
  static TIME_MAPPING = new Map([
    ["%M", "%B"],
    ["%c", "%-m"],
    ["%e", "%-d"],
    ["%h", "%I"],
    ["%i", "%M"],
    ["%s", "%S"],
    ["%u", "%W"],
    ["%k", "%-H"],
    ["%l", "%-I"],
    ["%r", "%I:%M:%S %p"],
    ["%T", "%H:%M:%S"],
    ["%W", "%A"],
    ["%x", "%G"],
    // %v (ISO week) is unmapped due to collision with %V (roundtrip issue)
  ]);

  static VALID_INTERVAL_UNITS = new Set([
    ...Dialect.VALID_INTERVAL_UNITS,
    "SECOND_MICROSECOND",
    "MINUTE_MICROSECOND",
    "MINUTE_SECOND",
    "HOUR_MICROSECOND",
    "HOUR_SECOND",
    "HOUR_MINUTE",
    "DAY_MICROSECOND",
    "DAY_SECOND",
    "DAY_MINUTE",
    "DAY_HOUR",
    "YEAR_MONTH",
  ]);

  /** py:158 `Parser = MySQLParser` — what `registerDialect` turns into `parser_class`. */
  static Parser = MySQLParser;

  /** py:160 `Generator = MySQLGenerator` — what `registerDialect` turns into `generator_class`. */
  static Generator = MySQLGenerator;

  /** py:69 `class Tokenizer(tokens.Tokenizer)`; see `MySQLTokenizer` above. */
  static Tokenizer = MySQLTokenizer;
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the class
// body above. Same placement and same argument as every other dialect's own call at
// the bottom of its file. Importing this module is what makes
// `Dialect.get_or_raise("mysql")` resolve.
registerDialect(Dialects.MYSQL, MySQL);
