// py: sqlglot/dialects/hive.py — `class Hive(Dialect)`.
//
// SETTINGS ONLY, same split as `src/dialects/snowflake.js` (PORT_PLAN.md R15/R16/R21):
// `sqlglot/parsers/hive.py` is a DIFFERENT upstream file, already ported whole to
// `src/parsers/hive.js`. This file adds `class Hive extends Dialect` with its ~8
// overridden settings, the nested `Tokenizer` subclass, and is the ROOT of the four-link
// chain `Hive <- Spark2 <- Spark <- Databricks` that upstream splits across four
// dialect-settings files (`hive.py`, `spark2.py`, `spark.py`, `databricks.py`), mirroring
// the same split `src/parsers/{hive,spark2,spark,databricks}.js` already established for
// the grammar side of this exact chain.
//
// WHY THE `registerDialect` CALL AT THE BOTTOM IS THE WHOLE POINT: see the identical
// note in `snowflake.js` (PORT_PLAN.md R20) — JS `static` fields are not on the
// prototype, so an instance's settings are `undefined` until `registerDialect` mirrors
// them, as its last step, after every derivation is final. All FOUR files in this chain
// need their own `registerDialect` call — one per class, matching how the parser chain
// registers each link separately.
//
// THREE DELIBERATE GAPS, all announced rather than faked, same reasons Snowflake's are:
//
//   `Generator = HiveGenerator` (py:118) is NOT declared, in any of the four files.
//   `generators/{hive,spark2,spark,databricks}.js` do not exist yet — this is explicitly
//   the NEXT per-dialect item in Ben's corrected priority order (PORT_PLAN.md §1),
//   not this one. Omitting `Generator` lets `registerDialect` fall through to
//   `base_generator` (the real base `Generator`, R27) exactly as `postgres.js`/
//   `duckdb.js` already do — verified this still works with zero new hazard code
//   needed (R28's finding), not merely assumed.
//
//   `EXPRESSION_METADATA = EXPRESSION_METADATA.copy()` (py:30, from the unported
//   `sqlglot/typing/hive.py`) is declared as an empty `Map()`, same treatment as every
//   other dialect's copy of this note. Spark2/Spark/Databricks each re-assign their OWN
//   `EXPRESSION_METADATA` from a DIFFERENT unported `typing/<dialect>.py` module in
//   upstream — the re-assignment is kept at each link (rather than only declaring it
//   once here and letting it inherit) to mirror upstream's actual class-body shape,
//   even though the content is identically empty at every link today.
//
//   `COERCES_TO` (py:37-42, from `sqlglot/optimizer/annotate_types.py`'s `TypeAnnotator`)
//   is declared as an empty `Map()` for the same reason: the optimizer package is P6+.
//   Only Hive and Databricks touch `COERCES_TO` in upstream (Spark2/Spark inherit
//   Hive's); the base `Dialect.COERCES_TO` is already an empty `Map()`, so Databricks's
//   own declaration below is the only place this note repeats.
//
//   `class JSONPathTokenizer(jsonpath.JSONPathTokenizer)` (py:82) is NOT declared, same
//   reason as `Dialect.jsonpath_tokenizer_class` being null everywhere: `sqlglot/
//   jsonpath.py` is unported. This one is worth flagging beyond the usual note: Hive is
//   the only class in this chain whose Python source actually defines its own
//   `JSONPathTokenizer` (Spark2/Spark don't redeclare one, and Databricks's own
//   `class JSONPathTokenizer(Spark.JSONPathTokenizer)` resolves, via ordinary Python
//   attribute lookup up the MRO, to Hive's — NOT to some intermediate Spark-specific
//   class, since neither Spark2 nor Spark shadow the name). See PORT_PLAN.md R30: when
//   this class eventually gets ported, `DatabricksJSONPathTokenizer` must extend
//   `Hive`'s JSONPathTokenizer directly (or whatever class actually owns it after
//   MRO resolution), not `Spark.JSONPathTokenizer` read naively as "the immediate
//   parent's own nested class" — the two are not always the same thing in a chain this
//   deep, and the `Tokenizer` chain below happens NOT to hit this trap only because
//   every one of Spark2/Spark/Databricks DOES redeclare its own `Tokenizer`.
//
// Every setting below is diffed value-by-value against CPython by
// `spike/p5/fuzz_dialect_parse.mjs`'s HIVE row (and transitively, via inheritance, by
// the SPARK2/SPARK/DATABRICKS rows in the same file).

import { Tokenizer, TokenType, initTokenizerSubclass } from "../tokens.js";
import { HiveParser } from "../parsers/hive.js";
import { Dialect, Dialects, NormalizationStrategy, registerDialect } from "./dialect.js";

/**
 * py: sqlglot/dialects/hive.py:84 `class Tokenizer(tokens.Tokenizer)`.
 *
 * Declared at module level rather than inside the class body because JS has no nested
 * class declarations; `Hive.Tokenizer` below points at it, which is the name
 * `registerDialect` (py:291 `klass.__dict__.get("Tokenizer", ...)`) looks for.
 *
 * `initTokenizerSubclass` is called explicitly right after the body, exactly as
 * `src/tokens.js` does for the base `Tokenizer` and every other dialect's own copy of
 * this note: without it, `_KEYWORD_TRIE`/`_COMMENTS`/`_FORMAT_STRINGS`/`_STRING_ESCAPES`
 * would all be inherited from the base class and Hive's backtick identifiers, `ADD JAR`-
 * style multi-word commands, and numeric-literal suffixes would never be scanned.
 */
class HiveTokenizer extends Tokenizer {
  static QUOTES = ["'", '"'];
  static IDENTIFIERS = ["`"];
  static STRING_ESCAPES = ["\\"];

  static SINGLE_TOKENS = new Map([...Tokenizer.SINGLE_TOKENS, ["$", TokenType.PARAMETER]]);

  static KEYWORDS = new Map([
    ...Tokenizer.KEYWORDS,
    ["ADD ARCHIVE", TokenType.COMMAND],
    ["ADD ARCHIVES", TokenType.COMMAND],
    ["ADD FILE", TokenType.COMMAND],
    ["ADD FILES", TokenType.COMMAND],
    ["ADD JAR", TokenType.COMMAND],
    ["ADD JARS", TokenType.COMMAND],
    ["MINUS", TokenType.EXCEPT],
    ["MSCK REPAIR", TokenType.COMMAND],
    ["REFRESH", TokenType.REFRESH],
    ["SERDEPROPERTIES", TokenType.SERDE_PROPERTIES],
  ]);

  static NUMERIC_LITERALS = new Map([
    ["L", "BIGINT"],
    ["S", "SMALLINT"],
    ["Y", "TINYINT"],
    ["D", "DOUBLE"],
    ["F", "FLOAT"],
    ["BD", "DECIMAL"],
  ]);
}
initTokenizerSubclass(HiveTokenizer);

/** py: sqlglot/dialects/hive.py:17 `class Hive(Dialect)`. */
export class Hive extends Dialect {
  static ALIAS_POST_TABLESAMPLE = true;
  static IDENTIFIERS_CAN_START_WITH_DIGIT = true;
  static SUPPORTS_USER_DEFINED_TYPES = false;
  static SAFE_DIVISION = true;
  static CONCAT_WS_COALESCE = true;
  static ARRAY_AGG_INCLUDES_NULLS = null;
  static REGEXP_EXTRACT_DEFAULT_GROUP = 1;
  static ALTER_TABLE_SUPPORTS_CASCADE = true;

  // https://spark.apache.org/docs/latest/sql-ref-identifier.html#description
  static NORMALIZATION_STRATEGY = NormalizationStrategy.CASE_INSENSITIVE;

  /**
   * py:30 `EXPRESSION_METADATA = EXPRESSION_METADATA.copy()`, from
   * `sqlglot/typing/hive.py`. Unported, same as every other dialect's copy of this
   * note — `sqlglot/optimizer/annotate_types.py` and `typing/` are P6+.
   */
  static EXPRESSION_METADATA = new Map();

  // https://cwiki.apache.org/confluence/pages/viewpage.action?pageId=27362046#LanguageManualUDF-StringFunctions
  // https://github.com/apache/hive/blob/master/ql/src/java/org/apache/hadoop/hive/ql/exec/Utilities.java#L266-L269
  //
  // A plain string, not a regex, and — unlike every other dialect's copy of this
  // setting so far — one whose Python literal contains raw control characters
  // (`\t\n\r\x0c\x0b\x1c\x1d\x1e\x1f`). PORT_PLAN.md §4.2's control-byte lint bans a
  // literal control byte in committed source (it makes `file`/`grep` silently treat the
  // whole file as binary), so every one of these is spelled as a JS escape — `\t`/`\n`/
  // `\r`/`\f` are the standard ones, \u000b/\u001c/\u001d/\u001e/\u001f are explicit unicode
  // escapes for VT and the four ASCII separator characters — never as a raw byte typed
  // into the file.
  static INITCAP_DEFAULT_DELIMITER_CHARS = "\t\n\r\f\u000b\u001c\u001d\u001e\u001f";

  /**
   * py:37-42 `COERCES_TO = defaultdict(set, deepcopy(TypeAnnotator.COERCES_TO))`, then a
   * loop widening NUMERIC/TEMPORAL/INTERVAL types to also coerce to TEXT. Both the base
   * table and the loop depend on `sqlglot/optimizer/annotate_types.py`'s `TypeAnnotator`
   * (P6+, unported) — same gap as `EXPRESSION_METADATA` above, and the base
   * `Dialect.COERCES_TO` is already an empty `Map()`, so this declaration exists only to
   * mirror upstream's own class body rather than to add real content.
   */
  static COERCES_TO = new Map();

  static TIME_MAPPING = new Map([
    ["y", "%Y"],
    ["Y", "%Y"],
    ["YYYY", "%Y"],
    ["yyyy", "%Y"],
    ["YY", "%y"],
    ["yy", "%y"],
    ["MMMM", "%B"],
    ["MMM", "%b"],
    // Hive 4.0+ parses MM/dd/HH/hh/mm/ss strictly (java.time.DateTimeFormatter, see
    // HIVE-25458/HIVE-25576)
    ["MM", "%mstrict"],
    ["M", "%-m"],
    ["dd", "%dstrict"],
    ["d", "%-d"],
    ["HH", "%Hstrict"],
    ["H", "%-H"],
    ["hh", "%Istrict"],
    ["h", "%-I"],
    ["mm", "%Mstrict"],
    ["m", "%-M"],
    ["ss", "%Sstrict"],
    ["s", "%-S"],
    ["SSSSSS", "%f"],
    ["a", "%p"],
    ["DD", "%j"],
    ["D", "%-j"],
    ["E", "%a"],
    ["EE", "%a"],
    ["EEE", "%a"],
    ["EEEE", "%A"],
    ["z", "%Z"],
    ["Z", "%z"],
  ]);

  static DATE_FORMAT = "'yyyy-MM-dd'";
  static DATEINT_FORMAT = "'yyyyMMdd'";
  static TIME_FORMAT = "'yyyy-MM-dd HH:mm:ss'";

  /** py:118 `Parser = HiveParser` — what `registerDialect` turns into `parser_class`. */
  static Parser = HiveParser;

  /** py:84 `class Tokenizer(tokens.Tokenizer)`; see `HiveTokenizer` above. */
  static Tokenizer = HiveTokenizer;
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the class
// body above. Same placement and same argument as `registerDialect(Dialects.SNOWFLAKE,
// Snowflake)` at the bottom of `snowflake.js`. Importing this module is what makes
// `Dialect.get_or_raise("hive")` resolve — and, transitively, what `spark2.js` needs
// already done before it can extend `Hive.Tokenizer` and read `Hive.TIME_MAPPING`.
registerDialect(Dialects.HIVE, Hive);
