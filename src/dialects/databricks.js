// py: sqlglot/dialects/databricks.py — `class Databricks(Spark)`.
//
// Link 4 of 4, the LEAF of `Hive <- Spark2 <- Spark <- Databricks` — see `hive.js`'s
// header for the full explanation of the split, the `registerDialect` requirement, and
// the deliberate gaps that apply verbatim to every file in this chain. This file adds
// `class Databricks extends Spark` with its 2 overridden settings and the nested
// `Tokenizer` subclass.
//
// Every setting below is diffed value-by-value against CPython by
// `spike/p5/fuzz_dialect_parse.mjs`'s DATABRICKS row.

import { TokenType, initTokenizerSubclass } from "../tokens.js";
import { DatabricksParser } from "../parsers/databricks.js";
import { Dialects, registerDialect } from "./dialect.js";
import { Spark } from "./spark.js";

/**
 * py: sqlglot/dialects/databricks.py:31 `class Tokenizer(Spark.Tokenizer)`.
 *
 * Extends `Spark.Tokenizer` DIRECTLY, matching upstream's own class statement exactly —
 * see `spark2.js`/`spark.js`'s identical notes. Spark DOES declare its own `Tokenizer`
 * (`spark.js`'s `SparkTokenizer`), so this is a direct extension with no MRO skip.
 *
 * The would-be `JSONPathTokenizer(Spark.JSONPathTokenizer)` sibling (py:29) is the one
 * place in this chain where the skip DOES matter and is NOT ported — see `hive.js`'s
 * gap note and PORT_PLAN.md R30. `Spark.JSONPathTokenizer` is not an own property of
 * either `Spark` or `Spark2`, so Python attribute lookup would walk past both to
 * `Hive.JSONPathTokenizer`.
 */
class DatabricksTokenizer extends Spark.Tokenizer {
  static KEYWORDS = new Map([
    ...Spark.Tokenizer.KEYWORDS,
    ["STREAM", TokenType.STREAM],
    ["VOID", TokenType.VOID],
  ]);
}
initTokenizerSubclass(DatabricksTokenizer);

/** py: sqlglot/dialects/databricks.py:14 `class Databricks(Spark)`. */
export class Databricks extends Spark {
  static SAFE_DIVISION = false;
  static COPY_PARAMS_ARE_CSV = false;

  /**
   * py:16 `EXPRESSION_METADATA = EXPRESSION_METADATA.copy()`, from
   * `sqlglot/typing/databricks.py`. Unported — see `hive.js`'s class-level note.
   */
  static EXPRESSION_METADATA = new Map();

  /**
   * py:18-26 `COERCES_TO = defaultdict(set, deepcopy(TypeAnnotator.COERCES_TO))`, then a
   * loop widening TEXT types to also coerce to NUMERIC/TEMPORAL/BINARY/BOOLEAN/INTERVAL.
   * Unported, same reason and same empty-`Map()` treatment as `hive.js`'s `COERCES_TO`
   * note — `sqlglot/optimizer/annotate_types.py`'s `TypeAnnotator` is P6+.
   */
  static COERCES_TO = new Map();

  /** py:39 `Parser = DatabricksParser` — what `registerDialect` turns into `parser_class`. */
  static Parser = DatabricksParser;

  /** py:31 `class Tokenizer(Spark.Tokenizer)`; see `DatabricksTokenizer` above. */
  static Tokenizer = DatabricksTokenizer;
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the class
// body above. Same placement and same argument as `registerDialect(Dialects.SPARK,
// Spark)` at the bottom of `spark.js`. Importing this module is what makes
// `Dialect.get_or_raise("databricks")` resolve.
registerDialect(Dialects.DATABRICKS, Databricks);
