// py: sqlglot/dialects/singlestore.py @ 91119bc — WHOLE FILE (64 LOC), AIR-2286 (epic
// AIR-2272, "12.1 MySQL family"), part 3 of the chain: `src/dialects/mysql.js` (R104)
// is the base this file extends. `sqlglot/parsers/singlestore.py` (248 LOC) lands in
// `src/parsers/singlestore.js`, `sqlglot/generators/singlestore.py` (1,602 LOC — by
// far the bulk of this dialect) in `src/generators/singlestore.js`, both this same
// round. There is NO `typing/singlestore.py` upstream, so `EXPRESSION_METADATA` is
// inherited verbatim from `MySQL` — the dialect-settings oracle dumps it as a COUNT
// for that reason, same shape R105's `gen_trino_dialect_ref.py` uses for Trino's own
// inherited-from-Presto table.
//
// `class SingleStore(MySQL)` has NO corresponding member in upstream's `Dialects`
// enum (`dialects/dialect.py`'s `class Dialects(str, Enum)` — checked directly: no
// `SINGLESTORE = "singlestore"` line exists there, unlike every other dialect this
// port has registered so far). Upstream's own `_Dialect` metaclass falls back to
// `clsname.lower()` for an un-enumerated class (py: `dialects/dialect.py`'s own
// `cls._classes[enum.value if enum is not None else clsname.lower()]`), so the
// registry key is the bare string `"singlestore"` below rather than a
// `Dialects.SINGLESTORE` entry — adding one to the port's own `Dialects` object would
// be inventing a setting upstream does not have.

import { TokenType, initTokenizerSubclass } from "../tokens.js";
import { SingleStoreParser, cast_to_time6 } from "../parsers/singlestore.js";
import { SingleStoreGenerator } from "../generators/singlestore.js";
import { registerDialect } from "./dialect.js";
import { MySQL } from "./mysql.js";

/**
 * py: sqlglot/dialects/singlestore.py:43 `class Tokenizer(MySQL.Tokenizer)`.
 *
 * Declared at module level, same convention every other dialect's nested `Tokenizer`
 * uses; `SingleStore.Tokenizer` below points at it.
 */
class SingleStoreTokenizer extends MySQL.Tokenizer {
  static BYTE_STRINGS = [["e'", "'"], ["E'", "'"]];

  static KEYWORDS = new Map([
    ...MySQL.Tokenizer.KEYWORDS,
    ["BSON", TokenType.JSONB],
    ["GEOGRAPHYPOINT", TokenType.GEOGRAPHYPOINT],
    ["TIMESTAMP", TokenType.TIMESTAMP],
    ["UTC_DATE", TokenType.UTC_DATE],
    ["UTC_TIME", TokenType.UTC_TIME],
    ["UTC_TIMESTAMP", TokenType.UTC_TIMESTAMP],
    [":>", TokenType.COLON_GT],
    ["!:>", TokenType.NCOLON_GT],
    ["::$", TokenType.DCOLONDOLLAR],
    ["::%", TokenType.DCOLONPERCENT],
    ["::?", TokenType.DCOLONQMARK],
    ["RECORD", TokenType.STRUCT],
  ]);
}
initTokenizerSubclass(SingleStoreTokenizer);

/** py: sqlglot/dialects/singlestore.py:7 `class SingleStore(MySQL)`. */
export class SingleStore extends MySQL {
  static SUPPORTS_ORDER_BY_ALL = true;

  /** py:10 `MYSQL_INVERSE_TIME_MAPPING = MySQL.INVERSE_TIME_MAPPING`. */
  static MYSQL_INVERSE_TIME_MAPPING = MySQL.INVERSE_TIME_MAPPING;

  /** py:11 `MYSQL_INVERSE_TIME_TRIE = MySQL.INVERSE_TIME_TRIE`. */
  static MYSQL_INVERSE_TIME_TRIE = MySQL.INVERSE_TIME_TRIE;

  /**
   * py:12 `CAST_TO_TIME6 = staticmethod(cast_to_time6)`. A SHOUT_CASE name holding a
   * plain function reference — `registerDialect`'s `_mirrorSettingsOntoPrototype`
   * mirrors it onto `SingleStore.prototype` the same as any data setting (its own
   * regex test is name-shape only, not value-type), so `this.dialect.CAST_TO_TIME6(...)`
   * reads correctly from a generator instance.
   */
  static CAST_TO_TIME6 = cast_to_time6;

  static TIME_MAPPING = new Map([
    ["D", "%u"], // Day of week (1-7)
    ["DD", "%d"], // day of month (01-31)
    ["DY", "%a"], // abbreviated name of day
    ["HH", "%I"], // Hour of day (01-12)
    ["HH12", "%I"], // alias for HH
    ["HH24", "%H"], // Hour of day (00-23)
    ["MI", "%M"], // Minute (00-59)
    ["MM", "%m"], // Month (01-12; January = 01)
    ["MON", "%b"], // Abbreviated name of month
    ["MONTH", "%B"], // Name of month
    ["SS", "%S"], // Second (00-59)
    ["RR", "%y"], // 15
    ["YY", "%y"], // 15
    ["YYYY", "%Y"], // 2015
    ["FF6", "%f"], // only 6 digits are supported in python formats
  ]);

  static VECTOR_TYPE_ALIASES = new Map([
    ["I8", "TINYINT"],
    ["I16", "SMALLINT"],
    ["I32", "INT"],
    ["I64", "BIGINT"],
    ["F32", "FLOAT"],
    ["F64", "DOUBLE"],
  ]);

  static INVERSE_VECTOR_TYPE_ALIASES = new Map(
    [...this.VECTOR_TYPE_ALIASES].map(([k, v]) => [v, k]),
  );

  /** py:43 `class Tokenizer(MySQL.Tokenizer)`; see `SingleStoreTokenizer` above. */
  static Tokenizer = SingleStoreTokenizer;

  /** py:62 `Parser = SingleStoreParser`. */
  static Parser = SingleStoreParser;

  /** py:64 `Generator = SingleStoreGenerator`. */
  static Generator = SingleStoreGenerator;
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the
// class body above, falling back to `clsname.lower()` since `SingleStore` has no
// `Dialects` enum member (see this file's own header note).
registerDialect("singlestore", SingleStore);
