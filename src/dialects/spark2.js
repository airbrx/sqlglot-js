// py: sqlglot/dialects/spark2.py — `class Spark2(Hive)`.
//
// Link 2 of 4 in `Hive <- Spark2 <- Spark <- Databricks` — see `hive.js`'s header for
// the full explanation of the split, the `registerDialect` requirement, and the
// remaining deliberate gaps (`EXPRESSION_METADATA`, `COERCES_TO`/`JSONPathTokenizer`)
// that apply verbatim to every file in this chain. `Generator = Spark2Generator` (py:41)
// IS now declared, same as `hive.js`'s own `Generator` — `generators/spark2.js` exists
// (PORT_PLAN.md, the Databricks-chain generator step). This file adds `class Spark2
// extends Hive` with its 3 overridden settings and the nested `Tokenizer` subclass.
//
// Every setting below is diffed value-by-value against CPython by
// `spike/p5/fuzz_dialect_parse.mjs`'s SPARK2 row.

import { Tokenizer, TokenType, initTokenizerSubclass } from "../tokens.js";
import { Spark2Parser } from "../parsers/spark2.js";
import { Spark2Generator } from "../generators/spark2.js";
import { Dialects, registerDialect } from "./dialect.js";
import { Hive } from "./hive.js";

/**
 * py: sqlglot/dialects/spark2.py:29 `class Tokenizer(Hive.Tokenizer)`.
 *
 * Extends `Hive.Tokenizer` DIRECTLY, matching upstream's own class statement exactly —
 * not `Hive.tokenizer_class` (the metaclass-derived, possibly-fresh subclass
 * `registerDialect` builds when a dialect declares no `Tokenizer` of its own). Hive DOES
 * declare its own, so the two happen to be identical objects here, but `hive.js`'s R30
 * note is why this file states which one it means rather than treating them as
 * interchangeable by convention.
 */
class Spark2Tokenizer extends Hive.Tokenizer {
  static HEX_STRINGS = [
    ["X'", "'"],
    ["x'", "'"],
  ];

  static KEYWORDS = new Map([...Hive.Tokenizer.KEYWORDS, ["TIMESTAMP", TokenType.TIMESTAMPTZ]]);
}
initTokenizerSubclass(Spark2Tokenizer);

/** py: sqlglot/dialects/spark2.py:11 `class Spark2(Hive)`. */
export class Spark2 extends Hive {
  static ALTER_TABLE_SUPPORTS_CASCADE = false;

  /**
   * py:13 `EXPRESSION_METADATA = EXPRESSION_METADATA.copy()`, from
   * `sqlglot/typing/spark2.py`. Unported — see `hive.js`'s class-level note.
   */
  static EXPRESSION_METADATA = new Map();

  // Spark 2.x parses MM/dd/HH/hh/mm/ss leniently (SimpleDateFormat), unlike strict Hive/Spark 3+
  static TIME_MAPPING = new Map([
    ...Hive.TIME_MAPPING,
    ["MM", "%m"],
    ["dd", "%d"],
    ["HH", "%H"],
    ["hh", "%I"],
    ["mm", "%M"],
    ["ss", "%S"],
  ]);

  // https://spark.apache.org/docs/latest/api/sql/index.html#initcap
  // https://docs.databricks.com/aws/en/sql/language-manual/functions/initcap
  // https://github.com/apache/spark/blob/master/common/unsafe/src/main/java/org/apache/spark/unsafe/types/UTF8String.java#L859-L905
  static INITCAP_DEFAULT_DELIMITER_CHARS = " ";

  /** py:39 `Parser = Spark2Parser` — what `registerDialect` turns into `parser_class`. */
  static Parser = Spark2Parser;

  /** py:41 `Generator = Spark2Generator` — what `registerDialect` turns into `generator_class`. */
  static Generator = Spark2Generator;

  /** py:29 `class Tokenizer(Hive.Tokenizer)`; see `Spark2Tokenizer` above. */
  static Tokenizer = Spark2Tokenizer;
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the class
// body above. Same placement and same argument as `registerDialect(Dialects.HIVE, Hive)`
// at the bottom of `hive.js`. Importing this module is what makes
// `Dialect.get_or_raise("spark2")` resolve — and what `spark.js` needs already done
// before it can extend `Spark2.Tokenizer` and read `Spark2.TIME_MAPPING`.
registerDialect(Dialects.SPARK2, Spark2);
