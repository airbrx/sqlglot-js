// py: sqlglot/dialects/tsql.py — `class TSQL(Dialect)`.
//
// SETTINGS ONLY, same split as every other dialect: `sqlglot/parsers/tsql.py` (the
// grammar, 914 LOC) is a DIFFERENT upstream file, already ported to
// `src/parsers/tsql.js` (PORT_PLAN.md, TSQL Parser round). This file adds
// `class TSQL extends Dialect` with its ~10 overridden settings, four hand-authored
// mapping tables (`DATE_PART_MAPPING`, `TIME_MAPPING`, `CONVERT_FORMAT_MAPPING`,
// `FORMAT_TIME_MAPPING`), the nested `Tokenizer` subclass, and the `registerDialect`
// call that makes `Dialect.get_or_raise("tsql")` resolve — see `snowflake.js` for the
// same shape and why `registerDialect` at the bottom is the whole point (the settings
// mirroring onto the prototype, PORT_PLAN.md R20).
//
// `CONVERT_FORMAT_MAPPING` LOOKS TSQL-ONLY BUT HAS A CROSS-DIALECT READER
// -------------------------------------------------------------------------
// Every other table here is read only from THIS dialect's own Parser/Generator. This
// one is different: `sqlglot/generator.py:5337`'s BASE `Generator.convert_sql` (every
// dialect's fallback renderer for a T-SQL `CONVERT(...)` node reaching a non-T-SQL
// target) does `import sqlglot.dialects.tsql` then reads
// `TSQL.CONVERT_FORMAT_MAPPING.get(style_value)` — because T-SQL's numeric CONVERT
// "styles" are meaningless outside T-SQL and have to be translated to a strftime
// format before another dialect can render them. `src/generator.js`'s own
// `convert_sql` is still `NotPorted` (unrelated to this session — a base-Generator
// gap, not a TSQL one), so nothing in this port calls this table cross-dialect yet;
// it is declared here anyway so the table EXISTS with the right shape and the ~60
// upstream style codes it will need are already transliterated, matching this port's
// standing "declare it now, wire the reader later" convention (R19/R21).
//
// THE CIRCULAR IMPORT THIS FILE'S EXISTENCE RESOLVES
// -------------------------------------------------------------------------
// `sqlglot/parsers/tsql.py:133,166`'s `_build_formatted_time`/`_build_format` both do
// `from sqlglot.dialects.tsql import TSQL` INSIDE their own function body, because
// THIS file imports `TSQLParser` FROM that one at module level — a real upstream
// cycle, broken there by Python's late-import trick. `src/parsers/tsql.js`'s own
// `_tsqlSettings()` resolves the JS side via `Dialect.get_or_raise("tsql")` (a
// runtime registry lookup) rather than a mirrored late `import()`, because a plain
// top-level `import { TSQL } from "./tsql.js"` in that file would recreate the same
// cycle with a SHARPER failure mode in ES modules: this file's own `static Parser =
// TSQLParser` class-field read happens synchronously during THIS file's evaluation,
// so whichever of the two files is not the module graph's entry point would hit a
// temporal-dead-zone `ReferenceError` — reachable in practice, since
// `spike/p3/dialect_tokenizer.mjs` imports `TSQLParser` directly without ever
// touching this file. See that function's comment for the full trace.
//
// ONE GAP REMAINS, announced rather than faked, same as every prior dialect round:
//
//   `EXPRESSION_METADATA = EXPRESSION_METADATA.copy()` (py:27, from the 100+ entry
//   `sqlglot/typing/tsql.py`) is declared as an empty `Map` — `annotate_types` and
//   `sqlglot/typing/` are P6+ unported, exactly as the base `Dialect`'s own
//   `EXPRESSION_METADATA` and every other dialect's copy of this same field are.

import { Tokenizer, TokenType, initTokenizerSubclass } from "../tokens.js";
import { TSQLParser } from "../parsers/tsql.js";
import { TSQLGenerator } from "../generators/tsql.js";
import {
  DATE_PART_MAPPING,
  Dialect,
  Dialects,
  NormalizationStrategy,
  registerDialect,
} from "./dialect.js";

/**
 * py: sqlglot/dialects/tsql.py:150 `class Tokenizer(tokens.Tokenizer)`.
 *
 * Declared at module level, same convention as every other dialect's nested
 * `Tokenizer` (JS has no nested class declarations); `TSQL.Tokenizer` below points at
 * it, which is the name `registerDialect` (`dialect.js`'s `klass.__dict__.get("Tokenizer",
 * ...)` port) looks for. `initTokenizerSubclass` is called explicitly right after the
 * body for the same reason `snowflake.js`/`postgres.js` do — Python's
 * `__init_subclass__` runs at class-creation time and JS has no equivalent hook.
 */
class TSQLTokenizer extends Tokenizer {
  static IDENTIFIERS = [["[", "]"], '"'];
  static QUOTES = ["'", '"'];
  static HEX_STRINGS = [
    ["0x", ""],
    ["0X", ""],
  ];
  static VAR_SINGLE_TOKENS = new Set(["@", "$", "#"]);

  static KEYWORDS = new Map([
    ...Tokenizer.KEYWORDS,
    ["CLUSTERED INDEX", TokenType.INDEX],
    ["DATETIME2", TokenType.DATETIME2],
    ["DATETIMEOFFSET", TokenType.TIMESTAMPTZ],
    ["DECLARE", TokenType.DECLARE],
    ["EXEC", TokenType.EXECUTE],
    ["GO", TokenType.COMMAND],
    ["IMAGE", TokenType.IMAGE],
    ["MONEY", TokenType.MONEY],
    ["NONCLUSTERED INDEX", TokenType.INDEX],
    ["NTEXT", TokenType.TEXT],
    ["OPTION", TokenType.OPTION],
    ["OUTPUT", TokenType.RETURNING],
    ["PRINT", TokenType.COMMAND],
    ["PROC", TokenType.PROCEDURE],
    ["REAL", TokenType.FLOAT],
    ["ROWVERSION", TokenType.ROWVERSION],
    ["SMALLDATETIME", TokenType.SMALLDATETIME],
    ["SMALLMONEY", TokenType.SMALLMONEY],
    ["SQL_VARIANT", TokenType.VARIANT],
    ["SYSTEM_USER", TokenType.CURRENT_USER],
    ["TOP", TokenType.TOP],
    ["TIMESTAMP", TokenType.ROWVERSION],
    ["TINYINT", TokenType.UTINYINT],
    ["UNIQUEIDENTIFIER", TokenType.UUID],
    ["UPDATE STATISTICS", TokenType.COMMAND],
    ["XML", TokenType.XML],
  ]);

  // py:187 `COMMANDS = {*tokens.Tokenizer.COMMANDS, TokenType.END} - {TokenType.EXECUTE}`.
  static COMMANDS = new Set(
    [...Tokenizer.COMMANDS, TokenType.END].filter((t) => t !== TokenType.EXECUTE),
  );
}
// py:174 `KEYWORDS.pop("/*+")` — a mutation AFTER the merge, not an omitted entry;
// see `snowflake.js`'s identical line for why it matters beyond the keyword table
// (`initTokenizerSubclass` only copies `HINT_START` into `_COMMENTS` when the key is
// present).
TSQLTokenizer.KEYWORDS.delete("/*+");
initTokenizerSubclass(TSQLTokenizer);

/** py: sqlglot/dialects/tsql.py:16 `class TSQL(Dialect)`. */
export class TSQL extends Dialect {
  // Week truncation follows @@DATEFIRST, which defaults to 7 (Sunday).
  static WEEK_OFFSET = -1;

  static LOG_BASE_FIRST = false;
  static TYPED_DIVISION = true;
  static CONCAT_COALESCE = true;
  static CONCAT_WS_COALESCE = true;
  static NORMALIZATION_STRATEGY = NormalizationStrategy.CASE_INSENSITIVE;
  static ALTER_TABLE_ADD_REQUIRED_FOR_EACH_COLUMN = false;

  static TIME_FORMAT = "'yyyy-mm-dd hh:mm:ss'";

  /** py:27 `EXPRESSION_METADATA = EXPRESSION_METADATA.copy()`. See file header. */
  static EXPRESSION_METADATA = new Map();

  static DATE_PART_MAPPING = new Map([
    ...DATE_PART_MAPPING,
    ["QQ", "QUARTER"],
    ["M", "MONTH"],
    ["Y", "DAYOFYEAR"],
    ["WW", "WEEK"],
    ["N", "MINUTE"],
    ["SS", "SECOND"],
    ["MCS", "MICROSECOND"],
    ["TZOFFSET", "TIMEZONE_MINUTE"],
    ["TZ", "TIMEZONE_MINUTE"],
    ["ISO_WEEK", "WEEKISO"],
    ["ISOWK", "WEEKISO"],
    ["ISOWW", "WEEKISO"],
  ]);

  static TIME_MAPPING = new Map([
    ["year", "%Y"],
    ["dayofyear", "%j"],
    ["day", "%d"],
    ["dy", "%d"],
    ["y", "%Y"],
    ["week", "%W"],
    ["ww", "%W"],
    ["wk", "%W"],
    ["isowk", "%V"],
    ["isoww", "%V"],
    ["iso_week", "%V"],
    ["hour", "%h"],
    ["hh", "%I"],
    ["minute", "%M"],
    ["mi", "%M"],
    ["n", "%M"],
    ["second", "%S"],
    ["ss", "%S"],
    ["s", "%-S"],
    ["millisecond", "%f"],
    ["ms", "%f"],
    ["weekday", "%w"],
    ["dw", "%w"],
    ["month", "%m"],
    ["mm", "%M"],
    ["m", "%-M"],
    ["Y", "%Y"],
    ["YYYY", "%Y"],
    ["YY", "%y"],
    ["MMMM", "%B"],
    ["MMM", "%b"],
    ["MM", "%m"],
    ["M", "%-m"],
    ["dddd", "%A"],
    ["dd", "%d"],
    ["d", "%-d"],
    ["HH", "%H"],
    ["H", "%-H"],
    ["h", "%-I"],
    ["ffffff", "%f"],
    ["yyyy", "%Y"],
    ["yy", "%y"],
  ]);

  /** py:90 `CONVERT_FORMAT_MAPPING`. See file header for the cross-dialect reader. */
  static CONVERT_FORMAT_MAPPING = new Map([
    ["0", "%b %d %Y %-I:%M%p"],
    ["1", "%m/%d/%y"],
    ["2", "%y.%m.%d"],
    ["3", "%d/%m/%y"],
    ["4", "%d.%m.%y"],
    ["5", "%d-%m-%y"],
    ["6", "%d %b %y"],
    ["7", "%b %d, %y"],
    ["8", "%H:%M:%S"],
    ["9", "%b %d %Y %-I:%M:%S:%f%p"],
    ["10", "mm-dd-yy"],
    ["11", "yy/mm/dd"],
    ["12", "yymmdd"],
    ["13", "%d %b %Y %H:%M:ss:%f"],
    ["14", "%H:%M:%S:%f"],
    ["20", "%Y-%m-%d %H:%M:%S"],
    ["21", "%Y-%m-%d %H:%M:%S.%f"],
    ["22", "%m/%d/%y %-I:%M:%S %p"],
    ["23", "%Y-%m-%d"],
    ["24", "%H:%M:%S"],
    ["25", "%Y-%m-%d %H:%M:%S.%f"],
    ["100", "%b %d %Y %-I:%M%p"],
    ["101", "%m/%d/%Y"],
    ["102", "%Y.%m.%d"],
    ["103", "%d/%m/%Y"],
    ["104", "%d.%m.%Y"],
    ["105", "%d-%m-%Y"],
    ["106", "%d %b %Y"],
    ["107", "%b %d, %Y"],
    ["108", "%H:%M:%S"],
    ["109", "%b %d %Y %-I:%M:%S:%f%p"],
    ["110", "%m-%d-%Y"],
    ["111", "%Y/%m/%d"],
    ["112", "%Y%m%d"],
    ["113", "%d %b %Y %H:%M:%S:%f"],
    ["114", "%H:%M:%S:%f"],
    ["120", "%Y-%m-%d %H:%M:%S"],
    ["121", "%Y-%m-%d %H:%M:%S.%f"],
    ["126", "%Y-%m-%dT%H:%M:%S.%f"],
  ]);

  static FORMAT_TIME_MAPPING = new Map([
    ["y", "%B %Y"],
    ["d", "%m/%d/%Y"],
    ["H", "%-H"],
    ["h", "%-I"],
    ["s", "%Y-%m-%d %H:%M:%S"],
    ["D", "%A,%B,%Y"],
    ["f", "%A,%B,%Y %-I:%M %p"],
    ["F", "%A,%B,%Y %-I:%M:%S %p"],
    ["g", "%m/%d/%Y %-I:%M %p"],
    ["G", "%m/%d/%Y %-I:%M:%S %p"],
    ["M", "%B %-d"],
    ["m", "%B %-d"],
    ["O", "%Y-%m-%dT%H:%M:%S"],
    ["u", "%Y-%M-%D %H:%M:%S%z"],
    ["U", "%A, %B %D, %Y %H:%M:%S%z"],
    ["T", "%-I:%M:%S %p"],
    ["t", "%-I:%M"],
    ["Y", "%a %Y"],
  ]);

  /** py:188 `Parser = TSQLParser` — what `registerDialect` turns into `parser_class`. */
  static Parser = TSQLParser;

  /** py:190 `Generator = TSQLGenerator` — what `registerDialect` turns into `generator_class`. */
  static Generator = TSQLGenerator;

  /** py:186 `class Tokenizer(tokens.Tokenizer)`; see `TSQLTokenizer` above. */
  static Tokenizer = TSQLTokenizer;
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the class
// body above. Same placement and same argument as every other dialect's own call at
// the bottom of its file. Importing this module is what makes
// `Dialect.get_or_raise("tsql")` resolve.
registerDialect(Dialects.TSQL, TSQL);
