// py: sqlglot/dialects/postgres.py — `class Postgres(Dialect)`.
//
// SETTINGS ONLY, same split as `src/dialects/snowflake.js` (PORT_PLAN.md R15/R16/R21):
// `sqlglot/parsers/postgres.py` is a DIFFERENT upstream file, already ported to
// `src/parsers/postgres.js`. This file adds `class Postgres extends Dialect` with ~14
// overridden settings, the nested `Tokenizer` subclass, and the `registerDialect` call
// that makes `Dialect.get_or_raise("postgres")` return it instead of a stand-in.
//
// WHY THE `registerDialect` CALL AT THE BOTTOM IS THE WHOLE POINT: see the identical
// note in `snowflake.js` (PORT_PLAN.md R20) — JS `static` fields are not on the
// prototype, so an instance's settings are `undefined` until `registerDialect` mirrors
// them, as its last step, after every derivation is final.
//
// ONE REMAINING DELIBERATE GAP, announced rather than faked, same reason as
// Snowflake's:
//
//   `EXPRESSION_METADATA = EXPRESSION_METADATA.copy()` (py:12, from
//   `sqlglot/typing/postgres.py`) is declared as an empty `Map()` for the same reason
//   Snowflake's is: `sqlglot/optimizer/annotate_types.py` and `typing/` are P6+.
//
// `Generator = PostgresGenerator` (py:143) IS now declared (PORT_PLAN.md P4,
// `generators/postgres.js`) — the `SUPPORTED_JSON_PATH_PARTS` pruning this file's
// header used to say would throw is guarded defensively in `registerDialect`
// (`dialects/dialect.js`'s `try { ... gen_cls.SUPPORTED_JSON_PATH_PARTS } catch {}`),
// same as it already was for Snowflake/Databricks/DuckDB before this dialect.
//
// Every setting below is diffed value-by-value against CPython by
// `spike/p5/fuzz_dialect_parse.mjs`'s POSTGRES row.

import { Tokenizer, TokenType, initTokenizerSubclass } from "../tokens.js";
import { PostgresParser } from "../parsers/postgres.js";
import { PostgresGenerator } from "../generators/postgres.js";
import * as exp from "../expressions/index.js";
import { Dialect, Dialects, registerDialect } from "./dialect.js";

/**
 * py: sqlglot/dialects/postgres.py:72 `class Tokenizer(tokens.Tokenizer)`.
 *
 * Declared at module level, same reason as `SnowflakeTokenizer`: JS has no nested class
 * declarations, and `Postgres.Tokenizer` below points at it — the name `registerDialect`
 * (py:291 `klass.__dict__.get("Tokenizer", ...)`) looks for.
 *
 * `initTokenizerSubclass` is called explicitly right after the body for the same reason
 * given in `snowflake.js`: without it, `_KEYWORD_TRIE`/`_COMMENTS`/`_FORMAT_STRINGS`/
 * `_STRING_ESCAPES` would all be inherited from the base class and Postgres's bit
 * strings, hex strings, `E'...'` byte strings, `U&'...'` unicode strings and `$...$`
 * heredoc strings would never be scanned.
 */
class PostgresTokenizer extends Tokenizer {
  static BIT_STRINGS = [
    ["b'", "'"],
    ["B'", "'"],
  ];
  static HEX_STRINGS = [
    ["x'", "'"],
    ["X'", "'"],
  ];
  static BYTE_STRINGS = [
    ["e'", "'"],
    ["E'", "'"],
  ];
  static UNICODE_STRINGS = [
    ["U&'", "'"],
    ["u&'", "'"],
  ];
  static BYTE_STRING_ESCAPES = ["'", "\\"];
  static HEREDOC_STRINGS = ["$"];

  static HEREDOC_TAG_IS_IDENTIFIER = true;
  static HEREDOC_STRING_ALTERNATIVE = TokenType.PARAMETER;

  static KEYWORDS = new Map([
    ...Tokenizer.KEYWORDS,
    ["~", TokenType.RLIKE],
    ["@@", TokenType.DAT],
    ["@?", TokenType.AT_QMARK],
    ["@>", TokenType.AT_GT],
    ["<@", TokenType.LT_AT],
    ["?&", TokenType.QMARK_AMP],
    ["?|", TokenType.QMARK_PIPE],
    ["#-", TokenType.HASH_DASH],
    ["|/", TokenType.PIPE_SLASH],
    ["||/", TokenType.DPIPE_SLASH],
    ["BEGIN", TokenType.BEGIN],
    ["BIGSERIAL", TokenType.BIGSERIAL],
    ["CSTRING", TokenType.PSEUDO_TYPE],
    ["DECLARE", TokenType.COMMAND],
    ["DO", TokenType.COMMAND],
    ["EXEC", TokenType.COMMAND],
    ["HSTORE", TokenType.HSTORE],
    ["INT8", TokenType.BIGINT],
    ["MONEY", TokenType.MONEY],
    ["NAME", TokenType.NAME],
    ["OID", TokenType.OBJECT_IDENTIFIER],
    ["ONLY", TokenType.ONLY],
    ["POINT", TokenType.POINT],
    ["REFRESH", TokenType.COMMAND],
    ["REINDEX", TokenType.COMMAND],
    ["RESET", TokenType.COMMAND],
    ["SERIAL", TokenType.SERIAL],
    ["SMALLSERIAL", TokenType.SMALLSERIAL],
    ["TEMP", TokenType.TEMPORARY],
    ["TYPE", TokenType.TYPE],
    ["REGCLASS", TokenType.OBJECT_IDENTIFIER],
    ["REGCOLLATION", TokenType.OBJECT_IDENTIFIER],
    ["REGCONFIG", TokenType.OBJECT_IDENTIFIER],
    ["REGDICTIONARY", TokenType.OBJECT_IDENTIFIER],
    ["REGNAMESPACE", TokenType.OBJECT_IDENTIFIER],
    ["REGOPER", TokenType.OBJECT_IDENTIFIER],
    ["REGOPERATOR", TokenType.OBJECT_IDENTIFIER],
    ["REGPROC", TokenType.OBJECT_IDENTIFIER],
    ["REGPROCEDURE", TokenType.OBJECT_IDENTIFIER],
    ["REGROLE", TokenType.OBJECT_IDENTIFIER],
    ["REGTYPE", TokenType.OBJECT_IDENTIFIER],
    ["FLOAT", TokenType.DOUBLE],
    ["XML", TokenType.XML],
    ["VARIADIC", TokenType.VARIADIC],
    ["INOUT", TokenType.INOUT],
  ]);

  static SINGLE_TOKENS = new Map([...Tokenizer.SINGLE_TOKENS, ["$", TokenType.HEREDOC_STRING]]);

  static VAR_SINGLE_TOKENS = new Set(["$"]);
}
// py:131-132 `KEYWORDS.pop("/*+")` / `KEYWORDS.pop("DIV")` — mutations of the dict AFTER
// the merge, not entries omitted from it. Same `Map#delete` spelling as Snowflake's
// `/*+` pop.
PostgresTokenizer.KEYWORDS.delete("/*+");
PostgresTokenizer.KEYWORDS.delete("DIV");
initTokenizerSubclass(PostgresTokenizer);

/** py: sqlglot/dialects/postgres.py:11 `class Postgres(Dialect)`. */
export class Postgres extends Dialect {
  /**
   * py:12 `EXPRESSION_METADATA = EXPRESSION_METADATA.copy()`, from
   * `sqlglot/typing/postgres.py`. Unported, same as `Snowflake.EXPRESSION_METADATA` —
   * see the class-level note above for why this is an empty `Map` rather than omitted.
   */
  static EXPRESSION_METADATA = new Map();

  static INDEX_OFFSET = 1;
  static ASCII_ONLY_NORMALIZATION = true;
  // Normalizing `x IS NOT NULL` to `NOT x IS NULL` is unsafe due to row values,
  // e.g. `ROW(1, NULL) IS NOT NULL` is false whereas `NOT ROW(1, NULL) IS NULL` is true
  static NORMALIZE_NOT_NULL = false;
  static TYPED_DIVISION = true;
  static CONCAT_COALESCE = true;
  static CONCAT_WS_COALESCE = true;
  static NULL_ORDERING = "nulls_are_large";
  static SUPPORTS_LIMIT_ALL = true;
  static TIME_FORMAT = "'YYYY-MM-DD HH24:MI:SS'";
  static TABLESAMPLE_SIZE_IS_PERCENT = true;
  static TABLES_REFERENCEABLE_AS_COLUMNS = true;

  static DEFAULT_FUNCTIONS_COLUMN_NAMES = new Map([[exp.ExplodingGenerateSeries, "generate_series"]]);

  static TIME_MAPPING = new Map([
    ["d", "%u"], // 1-based day of week
    ["D", "%u"], // 1-based day of week
    ["dd", "%d"], // day of month
    ["DD", "%d"], // day of month
    ["ddd", "%j"], // zero padded day of year
    ["DDD", "%j"], // zero padded day of year
    ["FMDD", "%-d"], // - is no leading zero for Python; same for FM in postgres
    ["FMDDD", "%-j"], // day of year
    ["FMHH12", "%-I"], // 9
    ["FMHH24", "%-H"], // 9
    ["FMMI", "%-M"], // Minute
    ["FMMM", "%-m"], // 1
    ["FMSS", "%-S"], // Second
    ["HH12", "%I"], // 09
    ["HH24", "%H"], // 09
    ["mi", "%M"], // zero padded minute
    ["MI", "%M"], // zero padded minute
    ["mm", "%m"], // 01
    ["MM", "%m"], // 01
    ["OF", "%z"], // utc offset
    ["ss", "%S"], // zero padded second
    ["SS", "%S"], // zero padded second
    ["TMDay", "%A"], // TM is locale dependent
    ["TMDy", "%a"],
    ["TMMon", "%b"], // Sep
    ["TMMonth", "%B"], // September
    ["day", "%Aenlower"], // tuesday
    ["dy", "%aenlower"], // tue
    ["TZ", "%Z"], // uppercase timezone name
    ["US", "%f"], // zero padded microsecond
    ["ww", "%U"], // 1-based week of year
    ["WW", "%U"], // 1-based week of year
    ["yy", "%y"], // 15
    ["YY", "%y"], // 15
    ["yyy", "%Ythree"], // 015
    ["YYY", "%Ythree"], // 015
    ["yyyy", "%Y"], // 2015
    ["YYYY", "%Y"], // 2015
  ]);

  /** py:141 `Parser = PostgresParser` — what `registerDialect` turns into `parser_class`. */
  static Parser = PostgresParser;

  /** py:143 `Generator = PostgresGenerator` — what `registerDialect` turns into `generator_class`. */
  static Generator = PostgresGenerator;

  /** py:72 `class Tokenizer(tokens.Tokenizer)`; see `PostgresTokenizer` above. */
  static Tokenizer = PostgresTokenizer;
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the class
// body above. Same placement as `Snowflake`'s call at the bottom of `snowflake.js`.
// Importing this module is what makes `Dialect.get_or_raise("postgres")` resolve.
registerDialect(Dialects.POSTGRES, Postgres);
