// py: sqlglot/dialects/starrocks.py — `class StarRocks(MySQL)`.
//
// SETTINGS ONLY, same split as `redshift.js`/`databricks.js`: `sqlglot/parsers/
// starrocks.py` and `sqlglot/generators/starrocks.py` are different upstream files,
// already ported to `src/parsers/starrocks.js`/`src/generators/starrocks.js`
// (PORT_PLAN.md, AIR-2286 part 2). This file adds `class StarRocks extends MySQL` —
// matching upstream's own `StarRocks(MySQL)` class statement, the same DIALECT-settings
// inheritance shape `databricks.js` uses for `Databricks(Spark)` — with its two
// overridden settings and the nested `Tokenizer` subclass, which extends
// `MySQL.Tokenizer` directly (again like `databricks.js`'s `DatabricksTokenizer
// (Spark.Tokenizer)`).
//
// NO `src/typing/starrocks.js`: `sqlglot/typing/starrocks.py` does not exist upstream
// (checked against the pin), so `StarRocks.EXPRESSION_METADATA` is left undeclared and
// resolves through ordinary JS static-field inheritance to `MySQL.EXPRESSION_METADATA`
// — the same thing a plain Python class-attribute lookup does when a subclass never
// assigns its own `EXPRESSION_METADATA`. `registerDialect`'s own prototype-mirroring
// pass (PORT_PLAN.md R20) walks the FULL static chain at call time, so this inherited
// value is picked up correctly without any extra wiring here.

import { TokenType, initTokenizerSubclass } from "../tokens.js";
import { StarRocksParser } from "../parsers/starrocks.js";
import { StarRocksGenerator } from "../generators/starrocks.js";
import { Dialects, registerDialect } from "./dialect.js";
import { MySQL } from "./mysql.js";

/**
 * py: sqlglot/dialects/starrocks.py:13 `class Tokenizer(MySQL.Tokenizer)`.
 *
 * Extends `MySQL.Tokenizer` DIRECTLY, matching upstream's own class statement exactly —
 * same shape as `databricks.js`'s `DatabricksTokenizer(Spark.Tokenizer)`.
 */
class StarRocksTokenizer extends MySQL.Tokenizer {
  static KEYWORDS = new Map([
    ...MySQL.Tokenizer.KEYWORDS,
    ["LARGEINT", TokenType.INT128],
    ["REFRESH", TokenType.REFRESH],
  ]);
}
initTokenizerSubclass(StarRocksTokenizer);

/** py: sqlglot/dialects/starrocks.py:9 `class StarRocks(MySQL)`. */
export class StarRocks extends MySQL {
  static STRICT_JSON_PATH_SYNTAX = false;
  static INDEX_OFFSET = 1;

  /** py:20 `Parser = StarRocksParser` — what `registerDialect` turns into `parser_class`. */
  static Parser = StarRocksParser;

  /** py:22 `Generator = StarRocksGenerator` — what `registerDialect` turns into `generator_class`. */
  static Generator = StarRocksGenerator;

  /** py:13 `class Tokenizer(MySQL.Tokenizer)`; see `StarRocksTokenizer` above. */
  static Tokenizer = StarRocksTokenizer;
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the class
// body above. Same placement and same argument as every other dialect's own call at
// the bottom of its file. Importing this module is what makes
// `Dialect.get_or_raise("starrocks")` resolve.
registerDialect(Dialects.STARROCKS, StarRocks);
