// py: sqlglot/dialects/clickhouse.py @ 91119bc — WHOLE FILE (131 LOC), AIR-2288.
//
// SETTINGS ONLY, same split as every other dialect: `sqlglot/parsers/clickhouse.py`
// (the grammar, 1010 LOC) and `sqlglot/generators/clickhouse.py` (722 LOC) are
// DIFFERENT upstream files, ported to `src/parsers/clickhouse.js` and
// `src/generators/clickhouse.js` in this same round (AIR-2288, epic AIR-2272) — the
// same "full stack in one round" shape R38 (Redshift) and R42/R43/R103/R104
// (BigQuery/TSQL/Presto/MySQL) already used. ClickHouse extends `Dialect` directly,
// no subclass chain.

import * as exp from "../expressions/index.js";
import { Tokenizer, TokenType, initTokenizerSubclass } from "../tokens.js";
import { ClickHouseParser } from "../parsers/clickhouse.js";
import { ClickHouseGenerator } from "../generators/clickhouse.js";
import { Dialect, Dialects, NormalizationStrategy, registerDialect } from "./dialect.js";
import { EXPRESSION_METADATA as CLICKHOUSE_EXPRESSION_METADATA } from "../typing/clickhouse.js";
import { pyStrip } from "../_py/str.js";

/**
 * py: sqlglot/dialects/clickhouse.py:70 `class Tokenizer(tokens.Tokenizer)`.
 *
 * Declared at module level, same convention as every other dialect's nested
 * `Tokenizer`; `ClickHouse.Tokenizer` below points at it, which is the name
 * `registerDialect` looks for. `initTokenizerSubclass` is called explicitly right
 * after the body for the same reason every other dialect does — Python's
 * `__init_subclass__` runs at class-creation time and JS has no equivalent hook.
 */
class ClickHouseTokenizer extends Tokenizer {
  static COMMENTS = ["--", "#", "#!", ["/*", "*/"]];
  static IDENTIFIERS = ['"', "`"];
  static IDENTIFIER_ESCAPES = ["\\"];
  static STRING_ESCAPES = ["'", "\\"];
  static BIT_STRINGS = [["0b", ""]];
  static HEX_STRINGS = [["0x", ""], ["0X", ""]];
  static HEREDOC_STRINGS = ["$"];

  static KEYWORDS = new Map([
    ...Tokenizer.KEYWORDS,
    [".:", TokenType.DOTCOLON],
    [".^", TokenType.DOTCARET],
    ["ATTACH", TokenType.COMMAND],
    ["DATE32", TokenType.DATE32],
    ["DETACH", TokenType.DETACH],
    ["DATETIME64", TokenType.DATETIME64],
    ["DICTIONARY", TokenType.DICTIONARY],
    ["DYNAMIC", TokenType.DYNAMIC],
    ["ENUM8", TokenType.ENUM8],
    ["ENUM16", TokenType.ENUM16],
    ["EXCHANGE", TokenType.COMMAND],
    ["FINAL", TokenType.FINAL],
    ["FIXEDSTRING", TokenType.FIXEDSTRING],
    ["FLOAT32", TokenType.FLOAT],
    ["FLOAT64", TokenType.DOUBLE],
    ["GLOBAL", TokenType.GLOBAL],
    ["LOWCARDINALITY", TokenType.LOWCARDINALITY],
    ["MAP", TokenType.MAP],
    ["NESTED", TokenType.NESTED],
    ["NOTHING", TokenType.NOTHING],
    ["SAMPLE", TokenType.TABLE_SAMPLE],
    ["TUPLE", TokenType.STRUCT],
    ["UINT16", TokenType.USMALLINT],
    ["UINT32", TokenType.UINT],
    ["UINT64", TokenType.UBIGINT],
    ["UINT8", TokenType.UTINYINT],
    ["IPV4", TokenType.IPV4],
    ["IPV6", TokenType.IPV6],
    ["POINT", TokenType.POINT],
    ["PROJECTION", TokenType.PROJECTION],
    ["RING", TokenType.RING],
    ["LINESTRING", TokenType.LINESTRING],
    ["MULTILINESTRING", TokenType.MULTILINESTRING],
    ["POLYGON", TokenType.POLYGON],
    ["MULTIPOLYGON", TokenType.MULTIPOLYGON],
    ["AGGREGATEFUNCTION", TokenType.AGGREGATEFUNCTION],
    ["SIMPLEAGGREGATEFUNCTION", TokenType.SIMPLEAGGREGATEFUNCTION],
    ["SYSTEM", TokenType.COMMAND],
    ["PREWHERE", TokenType.PREWHERE],
  ]);

  static SINGLE_TOKENS = new Map([
    ...Tokenizer.SINGLE_TOKENS,
    ["$", TokenType.HEREDOC_STRING],
  ]);
}
// py:122 `KEYWORDS.pop("/*+")` — a mutation AFTER the merge, not an entry omitted
// from it; same `initTokenizerSubclass`-ordering shape every other dialect's own
// `KEYWORDS.delete(...)` call documents.
ClickHouseTokenizer.KEYWORDS.delete("/*+");
initTokenizerSubclass(ClickHouseTokenizer);

/** py: sqlglot/dialects/clickhouse.py:15 `class ClickHouse(Dialect)`. */
export class ClickHouse extends Dialect {
  static INDEX_OFFSET = 1;
  static NORMALIZE_FUNCTIONS = false;
  static NULL_ORDERING = "nulls_are_last";
  static SUPPORTS_USER_DEFINED_TYPES = false;
  /** py:20 `LOG_BASE_FIRST: bool | None = None`. Ported as JS `null`, same sentinel
   * shape `dialects/presto.js` (AIR-2287) already used — see that file's own note. */
  static LOG_BASE_FIRST = null;
  static FORCE_EARLY_ALIAS_REF_EXPANSION = true;
  static PRESERVE_ORIGINAL_NAMES = true;
  static NUMBERS_CAN_BE_UNDERSCORE_SEPARATED = true;
  static IDENTIFIERS_CAN_START_WITH_DIGIT = true;
  static HEX_STRING_IS_INTEGER_TYPE = true;

  // https://github.com/ClickHouse/ClickHouse/issues/33935#issue-1112165779
  static NORMALIZATION_STRATEGY = NormalizationStrategy.CASE_SENSITIVE;

  /**
   * py:30 `EXPRESSION_METADATA = EXPRESSION_METADATA.copy()`, from
   * `sqlglot/typing/clickhouse.py` (AIR-2288) — the base `Dialect`'s own 294-entry
   * table (`src/typing/index.js`, AIR-2096/R51), with ClickHouse's 3 keys layered on
   * top in upstream's own top-to-bottom merge order. `src/typing/clickhouse.js` is
   * that table; this field is its wiring onto the class, the same shape every other
   * dialect's `EXPRESSION_METADATA` field already established.
   */
  static EXPRESSION_METADATA = CLICKHOUSE_EXPRESSION_METADATA;

  /** py:32-34 */
  static UNESCAPED_SEQUENCES = new Map([
    ["\\0", "\0"],
  ]);

  /** py:36 */
  static CREATABLE_KIND_MAPPING = new Map([
    ["DATABASE", "SCHEMA"],
  ]);

  /** py:38-42 */
  static SET_OP_DISTINCT_BY_DEFAULT = new Map([
    [exp.Except, false],
    [exp.Intersect, false],
    [exp.Union, null],
  ]);

  /**
   * py:44-68 `generate_values_aliases(self, expression)`.
   *
   * "Clickhouse allows VALUES to have an embedded structure e.g:
   * VALUES('person String, place String', ('Noah', 'Paris'), ...)
   * In this case, we don't want to qualify the columns"
   */
  generate_values_aliases(expression) {
    const values = expression.expressions[0].expressions;

    const structure =
      values.length > 1 && values[0].is_string && values[1] instanceof exp.Tuple
        ? values[0]
        : null;

    let column_aliases;
    if (structure) {
      // Split each column definition into the column name e.g:
      // 'person String, place String' -> ['person', 'place']
      const structure_coldefs = structure.name.split(",").map((coldef) => pyStrip(coldef));
      column_aliases = structure_coldefs.map((coldef) => exp.toIdentifier(coldef.split(" ")[0]));
    } else {
      // Default column aliases in CH are "c1", "c2", etc.
      column_aliases = values[0].expressions.map((_, i) => exp.toIdentifier(`c${i + 1}`));
    }

    return column_aliases;
  }

  /** py:70 `class Tokenizer(tokens.Tokenizer)`; see `ClickHouseTokenizer` above. */
  static Tokenizer = ClickHouseTokenizer;

  /** py:129 `Parser = ClickHouseParser`. */
  static Parser = ClickHouseParser;

  /** py:131 `Generator = ClickHouseGenerator`. */
  static Generator = ClickHouseGenerator;
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the class
// body above. Same placement and same argument as every other dialect's own call at
// the bottom of its file. Importing this module is what makes
// `Dialect.get_or_raise("clickhouse")` resolve.
registerDialect(Dialects.CLICKHOUSE, ClickHouse);
