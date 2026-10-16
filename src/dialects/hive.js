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
// ALL THREE CLOSED:
//
//   `Generator = HiveGenerator` (py:126) IS now declared — `generators/hive.js` exists
//   (PORT_PLAN.md, the Databricks-chain generator step, following Ben's corrected
//   priority order §1). `registerDialect` no longer falls through to `base_generator`
//   for this dialect; it resolves the real chain-specific `Generator` subclass instead.
//
//   `EXPRESSION_METADATA = EXPRESSION_METADATA.copy()` (py:30) now resolves to the real
//   `typing/hive.js` table (AIR-2100) — root of the four-link overlay chain, see that
//   file's own header. Spark2/Spark/Databricks each re-assign their OWN
//   `EXPRESSION_METADATA` from their OWN `typing/<dialect>.js` module, layered on top of
//   this one, mirroring upstream's actual class-body shape at each link.
//
//   `COERCES_TO` (py:37-42, from `sqlglot/optimizer/annotate_types.py`'s `TypeAnnotator`)
//   was an empty `Map()` stub since the optimizer package was P6+/unported; now that
//   `src/optimizer/annotate_types.js` is real, R119's own `buildHiveCoercesTo()` below
//   widens NUMERIC/TEMPORAL/INTERVAL to also coerce to TEXT (AIR-2315 Part 1 — surfaced
//   by 25 real MISMATCHes replaying `annotate_functions.sql`'s IF/COALESCE rows against
//   this dialect chain). Only Hive and Databricks touch `COERCES_TO` in upstream
//   (Spark2/Spark inherit Hive's); Databricks's own override (widening the opposite
//   direction — TEXT coerces to NUMERIC/TEMPORAL/BINARY/BOOLEAN/INTERVAL) lives in
//   `databricks.js`.
//
// `class JSONPathTokenizer(jsonpath.JSONPathTokenizer)` (py:82) IS now declared below
// (AIR-2274, `src/jsonpath.js`) — `HiveJSONPathTokenizer`. Worth flagging beyond the
// usual note: Hive is the only class in this chain whose Python source actually defines
// its own `JSONPathTokenizer` (Spark2/Spark don't redeclare one, and Databricks's own
// `class JSONPathTokenizer(Spark.JSONPathTokenizer)` resolves, via ordinary Python
// attribute lookup up the MRO, to Hive's — NOT to some intermediate Spark-specific
// class, since neither Spark2 nor Spark shadow the name). Per PORT_PLAN.md R30's own
// prediction: `databricks.js`'s `DatabricksJSONPathTokenizer` extends
// `Spark.jsonpath_tokenizer_class` — the RESOLVED value after `registerDialect` has run
// the whole chain, which is what actually owns the behavior after MRO resolution — not
// `Spark.JSONPathTokenizer` read naively as "the immediate parent's own nested class"
// (Spark never declares one; the two are not always the same thing in a chain this
// deep, and the `Tokenizer` chain below never hit this trap only because every one of
// Spark2/Spark/Databricks DOES redeclare its own `Tokenizer`).
//
// Every setting below is diffed value-by-value against CPython by
// `spike/p5/fuzz_dialect_parse.mjs`'s HIVE row (and transitively, via inheritance, by
// the SPARK2/SPARK/DATABRICKS rows in the same file).

import { Tokenizer, TokenType, initTokenizerSubclass } from "../tokens.js";
import { JSONPathTokenizer } from "../jsonpath.js";
import { HiveParser } from "../parsers/hive.js";
import { HiveGenerator } from "../generators/hive.js";
import { Dialect, Dialects, NormalizationStrategy, registerDialect } from "./dialect.js";
import { EXPRESSION_METADATA as HIVE_EXPRESSION_METADATA } from "../typing/hive.js";
import * as exp from "../expressions/index.js";
import { TypeAnnotator } from "../optimizer/annotate_types.js";

// py:37-42 `COERCES_TO = defaultdict(set, deepcopy(TypeAnnotator.COERCES_TO))`, then a
// loop widening NUMERIC/TEMPORAL/INTERVAL types to also coerce to TEXT (AIR-2315 Part
// 1: this stub's own stated blocker, "`annotate_types.py` is P6+, unported", resolved
// once `src/optimizer/annotate_types.js` landed for real — R22's "stub outlives its
// blocker" pattern). `TypeAnnotator.COERCES_TO`'s own entries only cover the types
// named in its three precedence lists (text/numeric/timelike); every other
// NUMERIC_TYPES/TEMPORAL_TYPES member defaultdict's in starting from an empty set,
// which is why the widening below unions into `existing ?? new Set()` rather than
// assuming every target already has an entry.
function buildHiveCoercesTo() {
  const coercesTo = new Map();
  for (const [k, v] of TypeAnnotator.COERCES_TO) coercesTo.set(k, new Set(v));
  for (const targetType of new Set([
    ...exp.DataType.NUMERIC_TYPES,
    ...exp.DataType.TEMPORAL_TYPES,
    exp.DType.INTERVAL,
  ])) {
    coercesTo.set(targetType, new Set([...(coercesTo.get(targetType) ?? []), ...exp.DataType.TEXT_TYPES]));
  }
  return coercesTo;
}

/** py: sqlglot/dialects/hive.py:82 `class JSONPathTokenizer(jsonpath.JSONPathTokenizer)`. */
class HiveJSONPathTokenizer extends JSONPathTokenizer {
  static VAR_TOKENS = new Set([...JSONPathTokenizer.VAR_TOKENS, TokenType.DASH]);
}
initTokenizerSubclass(HiveJSONPathTokenizer);

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
   * `sqlglot/typing/hive.py` (AIR-2100). Root of the four-link
   * `Hive <- Spark2 <- Spark <- Databricks` overlay chain — see `typing/hive.js`'s own
   * header.
   */
  static EXPRESSION_METADATA = HIVE_EXPRESSION_METADATA;

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
  static INITCAP_DEFAULT_DELIMITER_CHARS = " \t\n\r\f\u000b\u001c\u001d\u001e\u001f";

  static COERCES_TO = buildHiveCoercesTo();

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

  /** py:126 `Generator = HiveGenerator` — what `registerDialect` turns into `generator_class`. */
  static Generator = HiveGenerator;

  /** py:84 `class Tokenizer(tokens.Tokenizer)`; see `HiveTokenizer` above. */
  static Tokenizer = HiveTokenizer;

  /** py:82 `class JSONPathTokenizer(jsonpath.JSONPathTokenizer)`; see `HiveJSONPathTokenizer` above. */
  static JSONPathTokenizer = HiveJSONPathTokenizer;
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the class
// body above. Same placement and same argument as `registerDialect(Dialects.SNOWFLAKE,
// Snowflake)` at the bottom of `snowflake.js`. Importing this module is what makes
// `Dialect.get_or_raise("hive")` resolve — and, transitively, what `spark2.js` needs
// already done before it can extend `Hive.Tokenizer` and read `Hive.TIME_MAPPING`.
registerDialect(Dialects.HIVE, Hive);
