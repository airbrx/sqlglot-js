// py: sqlglot/dialects/databricks.py — `class Databricks(Spark)`.
//
// Link 4 of 4, the LEAF of `Hive <- Spark2 <- Spark <- Databricks` — see `hive.js`'s
// header for the full explanation of the split and the `registerDialect` requirement.
// `Generator = DatabricksGenerator` (py:42) IS now declared — `generators/databricks.js`
// exists (PORT_PLAN.md, the Databricks-chain generator step; this is the fourth and
// final link, closing out the whole chain). `EXPRESSION_METADATA` (py:16) now resolves
// to the real `typing/databricks.js` table (AIR-2100), Link 4 — the LEAF — of the
// overlay chain, see that file's own header. `COERCES_TO` (py:18-26) now resolves to a
// real widened table too (AIR-2315 Part 1 — see `buildDatabricksCoercesTo` below; the
// stub's stated blocker, `annotate_types.py` being unported, is resolved). This file
// adds `class Databricks extends Spark` with its 2 overridden settings and the nested
// `Tokenizer`/`JSONPathTokenizer` subclasses (the latter AIR-2274, `src/jsonpath.js` —
// no gaps remain in this chain).
//
// Every setting below is diffed value-by-value against CPython by
// `spike/p5/fuzz_dialect_parse.mjs`'s DATABRICKS row.

import { TokenType, initTokenizerSubclass } from "../tokens.js";
import { DatabricksParser } from "../parsers/databricks.js";
import { DatabricksGenerator } from "../generators/databricks.js";
import { Dialects, registerDialect } from "./dialect.js";
import { Spark } from "./spark.js";
import { EXPRESSION_METADATA as DATABRICKS_EXPRESSION_METADATA } from "../typing/databricks.js";
import * as exp from "../expressions/index.js";
import { TypeAnnotator } from "../optimizer/annotate_types.js";

// py:18-26 `COERCES_TO = defaultdict(set, deepcopy(TypeAnnotator.COERCES_TO))`, then a
// loop widening TEXT types to also coerce to NUMERIC/TEMPORAL/BINARY/BOOLEAN/INTERVAL
// (AIR-2315 Part 1 — this stub's own stated blocker, "`annotate_types.py` is P6+,
// unported", resolved now that `src/optimizer/annotate_types.js` is real; see
// `hive.js`'s own `buildHiveCoercesTo` for the identical-shape widening in the
// OPPOSITE direction it still owns for Hive/Spark2/Spark).
function buildDatabricksCoercesTo() {
  const coercesTo = new Map();
  for (const [k, v] of TypeAnnotator.COERCES_TO) coercesTo.set(k, new Set(v));
  const widenTo = new Set([
    ...exp.DataType.NUMERIC_TYPES,
    ...exp.DataType.TEMPORAL_TYPES,
    exp.DType.BINARY,
    exp.DType.BOOLEAN,
    exp.DType.INTERVAL,
  ]);
  for (const textType of exp.DataType.TEXT_TYPES) {
    coercesTo.set(textType, new Set([...(coercesTo.get(textType) ?? []), ...widenTo]));
  }
  return coercesTo;
}

/**
 * py: sqlglot/dialects/databricks.py:29 `class JSONPathTokenizer(Spark.JSONPathTokenizer)`.
 *
 * `Spark.JSONPathTokenizer` (the nested-class property) is NOT an own property of
 * either `Spark` or `Spark2` — Hive is the only link that redeclares it — so Python
 * attribute lookup walks past both to `Hive.JSONPathTokenizer`. The JS equivalent of
 * that resolved value is `Spark.jsonpath_tokenizer_class` (set by `registerDialect`
 * when `spark.js`'s own `registerDialect(Dialects.SPARK, Spark)` call ran, below this
 * module's own `import { Spark } from "./spark.js"`): a fresh, empty subclass of
 * Spark2's own fresh subclass of Hive's real `HiveJSONPathTokenizer` — functionally
 * identical to extending Hive's directly, PORT_PLAN.md R31's own named hazard avoided
 * by reading the RESOLVED value rather than the naive `Spark.JSONPathTokenizer` (which
 * is `undefined`).
 */
class DatabricksJSONPathTokenizer extends Spark.jsonpath_tokenizer_class {
  static IDENTIFIERS = ["`", '"'];
}
initTokenizerSubclass(DatabricksJSONPathTokenizer);

/**
 * py: sqlglot/dialects/databricks.py:31 `class Tokenizer(Spark.Tokenizer)`.
 *
 * Extends `Spark.Tokenizer` DIRECTLY, matching upstream's own class statement exactly —
 * see `spark2.js`/`spark.js`'s identical notes. Spark DOES declare its own `Tokenizer`
 * (`spark.js`'s `SparkTokenizer`), so this is a direct extension with no MRO skip.
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
   * `sqlglot/typing/databricks.py` (AIR-2100). Link 4, the LEAF of the four-link overlay
   * chain — see `typing/databricks.js`'s own header.
   */
  static EXPRESSION_METADATA = DATABRICKS_EXPRESSION_METADATA;

  static COERCES_TO = buildDatabricksCoercesTo();

  /** py:40 `Parser = DatabricksParser` — what `registerDialect` turns into `parser_class`. */
  static Parser = DatabricksParser;

  /** py:42 `Generator = DatabricksGenerator` — what `registerDialect` turns into `generator_class`. */
  static Generator = DatabricksGenerator;

  /** py:31 `class Tokenizer(Spark.Tokenizer)`; see `DatabricksTokenizer` above. */
  static Tokenizer = DatabricksTokenizer;

  /** py:29 `class JSONPathTokenizer(Spark.JSONPathTokenizer)`; see above. */
  static JSONPathTokenizer = DatabricksJSONPathTokenizer;
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the class
// body above. Same placement and same argument as `registerDialect(Dialects.SPARK,
// Spark)` at the bottom of `spark.js`. Importing this module is what makes
// `Dialect.get_or_raise("databricks")` resolve.
registerDialect(Dialects.DATABRICKS, Databricks);
