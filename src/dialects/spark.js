// py: sqlglot/dialects/spark.py — `class Spark(Spark2)`.
//
// Link 3 of 4 in `Hive <- Spark2 <- Spark <- Databricks` — see `hive.js`'s header for
// the full explanation of the split, the `registerDialect` requirement, and the
// remaining deliberate gaps that apply verbatim to every file in this chain.
// `Generator = SparkGenerator` (py:46) IS now declared — `generators/spark.js` exists
// (PORT_PLAN.md, the Databricks-chain generator step). This file adds `class Spark
// extends Spark2` with its 4 overridden settings and the nested `Tokenizer` subclass.
//
// Every setting below is diffed value-by-value against CPython by
// `spike/p5/fuzz_dialect_parse.mjs`'s SPARK row.

import { TokenType, initTokenizerSubclass } from "../tokens.js";
import { SparkParser } from "../parsers/spark.js";
import { SparkGenerator } from "../generators/spark.js";
import { Dialects, registerDialect } from "./dialect.js";
import { Spark2 } from "./spark2.js";

/**
 * py: sqlglot/dialects/spark.py:16 `class Tokenizer(Spark2.Tokenizer)`.
 *
 * Extends `Spark2.Tokenizer` DIRECTLY, matching upstream's own class statement exactly
 * — see `spark2.js`'s identical note on `Hive.Tokenizer` for why this file names which
 * class it means rather than reaching for `Spark2.tokenizer_class`. Spark2 DOES declare
 * its own `Tokenizer` (`spark2.js`'s `Spark2Tokenizer`), so this is a direct extension
 * with no MRO skip involved.
 */
class SparkTokenizer extends Spark2.Tokenizer {
  static STRING_ESCAPES_ALLOWED_IN_RAW_STRINGS = false;

  /**
   * py:19 `RAW_STRINGS = [(prefix + q, q) for q in t.cast(list[str],
   * Spark2.Tokenizer.QUOTES) for prefix in ("r", "R")]` — a nested comprehension, OUTER
   * loop over `q` (the quote characters), INNER loop over the two case variants of the
   * `r`/`R` prefix. `Spark2.Tokenizer.QUOTES` is not redeclared by `Spark2Tokenizer`, so
   * it resolves through ordinary JS static inheritance to `Hive.Tokenizer.QUOTES`
   * (`["'", '"']`) — the same value Python's own attribute lookup would find.
   * `.flatMap` over the outer loop with an inner `.map` reproduces the exact iteration
   * order: `[["r'","'"],["R'","'"],['r"','"'],['R"','"']]`.
   */
  static RAW_STRINGS = Spark2.Tokenizer.QUOTES.flatMap((q) => ["r", "R"].map((prefix) => [prefix + q, q]));

  static KEYWORDS = new Map([...Spark2.Tokenizer.KEYWORDS, ["DECLARE", TokenType.DECLARE]]);
}
initTokenizerSubclass(SparkTokenizer);

/** py: sqlglot/dialects/spark.py:11 `class Spark(Spark2)`. */
export class Spark extends Spark2 {
  static SUPPORTS_ORDER_BY_ALL = true;
  static SUPPORTS_LIMIT_ALL = true;
  static SUPPORTS_NULL_TYPE = true;
  static ARRAY_FUNCS_PROPAGATES_NULLS = true;

  /**
   * py:16 `EXPRESSION_METADATA = EXPRESSION_METADATA.copy()`, from
   * `sqlglot/typing/spark.py`. Unported — see `hive.js`'s class-level note.
   */
  static EXPRESSION_METADATA = new Map();

  // Spark 3+ parses MM/dd/HH/hh/mm/ss strictly, unlike Spark 2 (SimpleDateFormat)
  static TIME_MAPPING = new Map([
    ...Spark2.TIME_MAPPING,
    ["MM", "%mstrict"],
    ["dd", "%dstrict"],
    ["HH", "%Hstrict"],
    ["hh", "%Istrict"],
    ["mm", "%Mstrict"],
    ["ss", "%Sstrict"],
  ]);

  /** py:44 `Parser = SparkParser` — what `registerDialect` turns into `parser_class`. */
  static Parser = SparkParser;

  /** py:46 `Generator = SparkGenerator` — what `registerDialect` turns into `generator_class`. */
  static Generator = SparkGenerator;

  /** py:16 `class Tokenizer(Spark2.Tokenizer)`; see `SparkTokenizer` above. */
  static Tokenizer = SparkTokenizer;
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the class
// body above. Same placement and same argument as `registerDialect(Dialects.SPARK2,
// Spark2)` at the bottom of `spark2.js`. Importing this module is what makes
// `Dialect.get_or_raise("spark")` resolve — and what `databricks.js` needs already done
// before it can extend `Spark.Tokenizer`.
registerDialect(Dialects.SPARK, Spark);
