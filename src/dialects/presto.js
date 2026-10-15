// py: sqlglot/dialects/presto.py @ 91119bc — `class Presto(Dialect)`, AIR-2287.
//
// SETTINGS ONLY, same split as every other dialect: `sqlglot/parsers/presto.py` (the
// grammar, 141 LOC) is a DIFFERENT upstream file, ported to `src/parsers/presto.js`
// in this same round. `sqlglot/generators/presto.py` (705 LOC, `src/generators/
// presto.js`) also lands in this round — Presto is the first dialect in this port to
// land its full stack (Parser + Dialect settings + Generator) in one round other than
// Redshift (PORT_PLAN.md R38); `trino`/`athena`/`dune` extend THIS file in later
// rounds, the same relationship `redshift.js extends postgres.js` already models.
//
// `TIME_FORMAT = MySQL.TIME_FORMAT` / `TIME_MAPPING = MySQL.TIME_MAPPING` (py:20,30)
// READ MYSQL'S OWN CLASS ATTRIBUTES, NOT AN `extends MySQL` RELATIONSHIP
// -------------------------------------------------------------------------
// Upstream `Presto(Dialect)` imports `from sqlglot.dialects.mysql import MySQL` purely
// to copy two plain data values off it (`TIME_FORMAT = "'%Y-%m-%d %T'"` and the
// 13-entry `TIME_MAPPING` dict at `dialects/mysql.py:27,37-49` — see that file's own
// "https://prestodb.io/docs/current/functions/datetime.html#mysql-date-functions"
// comment, confirming the borrow is intentional and bidirectional in spirit). `MySQL`
// is not yet ported in this project (AIR-2286, a concurrent session, owns it), and
// these two values are inert literals with no method/MRO dependency on the `MySQL`
// class itself, so they are inlined here verbatim rather than adding an import this
// port cannot yet satisfy. Future note for whoever ports MySQL: if `MySQL.TIME_FORMAT`
// or `MySQL.TIME_MAPPING` ever change, this file's copies must be re-synced by hand
// (there is no live binding), exactly the same risk upstream's own non-DRY copy-via-
// import carries if MySQL's values ever drift without Presto being revisited.
//
// `LOG_BASE_FIRST: bool | None = None` (py:24) is the exact `None`-sentinel shape
// PORT_PLAN.md R88 named ("neither presto nor clickhouse ported yet" at the time) —
// ported as JS `null`, matching `generator.js`'s `log_sql`'s `LOG_BASE_FIRST === null`
// branch, which this dialect is now the first (of two named) to actually exercise.
//
// `PARSE_JSON_NAME = "JSON_PARSE"` lives on `PrestoGenerator` (`generators/presto.js`),
// not here — upstream's own `PARSE_JSON_NAME` is a `Generator` class attribute, not a
// `Dialect` one; restated here only because R88's own comment groups the two null-vs-
// value sentinels together and a reader of this file's header might otherwise expect
// it in both places.

import { Tokenizer, TokenType, initTokenizerSubclass } from "../tokens.js";
import { PrestoParser } from "../parsers/presto.js";
import { PrestoGenerator } from "../generators/presto.js";
import { Dialect, Dialects, NormalizationStrategy, registerDialect } from "./dialect.js";
import { EXPRESSION_METADATA as PRESTO_EXPRESSION_METADATA } from "../typing/presto.js";

/** py: sqlglot/dialects/mysql.py:27 `TIME_FORMAT = "'%Y-%m-%d %T'"`. See file header. */
const MYSQL_TIME_FORMAT = "'%Y-%m-%d %T'";

/**
 * py: sqlglot/dialects/mysql.py:37-49 `TIME_MAPPING`. See file header — copied
 * verbatim rather than imported because `MySQL` is not yet ported in this project.
 */
const MYSQL_TIME_MAPPING = new Map([
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

/**
 * py: sqlglot/dialects/presto.py:44 `class Tokenizer(tokens.Tokenizer)`.
 *
 * Declared at module level, same convention as every other dialect's nested
 * `Tokenizer`; `Presto.Tokenizer` below points at it, which is the name
 * `registerDialect` looks for. `initTokenizerSubclass` is called explicitly right
 * after the body for the same reason every other dialect does — Python's
 * `__init_subclass__` runs at class-creation time and JS has no equivalent hook.
 */
class PrestoTokenizer extends Tokenizer {
  static HEX_STRINGS = [
    ["x'", "'"],
    ["X'", "'"],
  ];

  /** py:46-50 `[(prefix + q, q) for q in tokens.Tokenizer.QUOTES for prefix in ("U&", "u&")]`. */
  static UNICODE_STRINGS = Tokenizer.QUOTES.flatMap((q) =>
    ["U&", "u&"].map((prefix) => [prefix + q, q]),
  );

  static NESTED_COMMENTS = false;

  static KEYWORDS = new Map([
    ...Tokenizer.KEYWORDS,
    ["DEALLOCATE PREPARE", TokenType.COMMAND],
    ["DESCRIBE INPUT", TokenType.COMMAND],
    ["DESCRIBE OUTPUT", TokenType.COMMAND],
    ["RESET SESSION", TokenType.COMMAND],
    ["START", TokenType.BEGIN],
    ["MATCH_RECOGNIZE", TokenType.MATCH_RECOGNIZE],
    ["ROW", TokenType.STRUCT],
    ["IPADDRESS", TokenType.IPADDRESS],
    ["IPPREFIX", TokenType.IPPREFIX],
    ["TDIGEST", TokenType.TDIGEST],
    ["HYPERLOGLOG", TokenType.HLLSKETCH],
  ]);
}
// py:68-69 `KEYWORDS.pop("/*+")` / `KEYWORDS.pop("QUALIFY")` — mutations AFTER the
// merge, not entries omitted from it; same `initTokenizerSubclass`-ordering shape
// `snowflake.js`/`bigquery.js`'s own `KEYWORDS.delete(...)` calls document.
PrestoTokenizer.KEYWORDS.delete("/*+");
PrestoTokenizer.KEYWORDS.delete("QUALIFY");
initTokenizerSubclass(PrestoTokenizer);

/** py: sqlglot/dialects/presto.py:17 `class Presto(Dialect)`. */
export class Presto extends Dialect {
  static INDEX_OFFSET = 1;
  static NULL_ORDERING = "nulls_are_last";
  /** py:20 `TIME_FORMAT = MySQL.TIME_FORMAT`. See file header. */
  static TIME_FORMAT = MYSQL_TIME_FORMAT;
  static STRICT_STRING_CONCAT = true;
  static TYPED_DIVISION = true;
  static TABLESAMPLE_SIZE_IS_PERCENT = true;
  /** py:24 `LOG_BASE_FIRST: bool | None = None`. See file header — ported as `null`. */
  static LOG_BASE_FIRST = null;
  static SUPPORTS_LIMIT_ALL = true;
  static SUPPORTS_VALUES_DEFAULT = false;
  static LEAST_GREATEST_IGNORES_NULLS = false;
  static UUID_IS_STRING_TYPE = false;

  /** py:30 `TIME_MAPPING = MySQL.TIME_MAPPING`. See file header. */
  static TIME_MAPPING = MYSQL_TIME_MAPPING;

  // https://github.com/trinodb/trino/issues/17
  // https://github.com/trinodb/trino/issues/12289
  // https://github.com/prestodb/presto/issues/2863
  static NORMALIZATION_STRATEGY = NormalizationStrategy.CASE_INSENSITIVE;

  /**
   * py:37 `EXPRESSION_METADATA = EXPRESSION_METADATA.copy()`, from
   * `sqlglot/typing/presto.py` (AIR-2099) — the base `Dialect`'s own 294-entry table
   * (`src/typing/index.js`, AIR-2096/R51), with Presto's 8 keys layered on top in
   * upstream's own top-to-bottom merge order. `src/typing/presto.js` is that table;
   * this field is its wiring onto the class, the same shape every other dialect's
   * `EXPRESSION_METADATA` field already established.
   */
  static EXPRESSION_METADATA = PRESTO_EXPRESSION_METADATA;

  /** py:39-42 `{*Dialect.SUPPORTED_SETTINGS, "variant_extract_is_json_extract"}`. */
  static SUPPORTED_SETTINGS = new Set([
    ...Dialect.SUPPORTED_SETTINGS,
    "variant_extract_is_json_extract",
  ]);

  /** py:71 `Parser = PrestoParser`. */
  static Parser = PrestoParser;

  /** py:73 `Generator = PrestoGenerator`. */
  static Generator = PrestoGenerator;

  /** py:44 `class Tokenizer(tokens.Tokenizer)`; see `PrestoTokenizer` above. */
  static Tokenizer = PrestoTokenizer;
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the class
// body above. Same placement and same argument as every other dialect's own call at
// the bottom of its file. Importing this module is what makes
// `Dialect.get_or_raise("presto")` resolve.
registerDialect(Dialects.PRESTO, Presto);
