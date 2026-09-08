// py: sqlglot/parsers/databricks.py @ 91119bc
//
// `class DatabricksParser(SparkParser)` — link 4 of 4, the leaf of
// `Hive <- Spark2 <- Spark <- Databricks`.
//
// ONE table here does not extend its immediate parent. Upstream writes:
//
//     COLUMN_OPERATORS = {**parser.Parser.COLUMN_OPERATORS, TokenType.QDCOLON: ...}
//
// — `parser.Parser`, the BASE class, not `SparkParser`. Every other table on this class
// spreads `SparkParser.X`. Reading it as "…SparkParser.COLUMN_OPERATORS" would silently
// inherit three links' worth of overrides that upstream deliberately drops, so the base
// `Parser` is imported here for that single line and used nowhere else. This is exactly
// the per-table check `src/parsers/snowflake.js`'s header calls for: decide EXTEND vs
// REPLACE vs EXTEND-FROM-WHERE from upstream, one table at a time.
//
// `CAST_COLUMN_OPERATORS` (py:56) is a SET literal (`{*SparkParser.X, ...}`), not a dict
// — a union, spelled with `new Set([...])` rather than `new Map([...])`.

import { Parser } from "../parser.js";
import { TokenType } from "../tokens.js";
import { seqGet } from "../helper.js";
import { pyUpper } from "../_py/str.js";
import * as exp from "../expressions/index.js";
import { build_date_delta, build_formatted_time } from "../dialects/dialect.js";
import { SparkParser } from "./spark.js";

export class DatabricksParser extends SparkParser {
  /* py:11 */ static LOG_DEFAULTS_TO_LN = true;
  /* py:12 */ static STRICT_CAST = true;
  /* py:13 */ static COLON_IS_VARIANT_EXTRACT = true;
  /* py:14 */ static COLON_CHAIN_IS_SINGLE_EXTRACT = false;

  /** py: sqlglot/parsers/databricks.py:16 */
  static FUNCTIONS = new Map([
    /* py:17 */ ...SparkParser.FUNCTIONS,
    /* py:18 */ ["IFF", exp.If.from_arg_list],
    /* py:19 */ ["GETDATE", exp.CurrentTimestamp.from_arg_list],
    /* py:20 */ ["DATEDIFF", build_date_delta(exp.DateDiff)],
    /* py:21 */ ["DATE_DIFF", build_date_delta(exp.DateDiff)],
    /* py:22 */ ["NOW", exp.CurrentTimestamp.from_arg_list],
    /* py:23 */ ["TO_DATE", build_formatted_time(exp.TsOrDsToDate)],
    /* py:24 */ ["UNIFORM", (args) => new exp.Uniform({
      this: seqGet(args, 0), expression: seqGet(args, 1), seed: seqGet(args, 2),
    })],
  ]);

  /** py: sqlglot/parsers/databricks.py:29 */
  static NO_PAREN_FUNCTION_PARSERS = new Map([
    /* py:30 */ ...SparkParser.NO_PAREN_FUNCTION_PARSERS,
    /* py:31 */ ["CURDATE", (self) => self._parse_curdate()],
  ]);

  /** py: sqlglot/parsers/databricks.py:34 */
  static FUNCTION_PARSERS = new Map([
    /* py:35 */ ...SparkParser.FUNCTION_PARSERS,
    /* py:36 */ ["REGR_AVGX", (self) => self._parse_distinct_arg_function(exp.RegrAvgx, 1)],
    /* py:37 */ ["REGR_AVGY", (self) => self._parse_distinct_arg_function(exp.RegrAvgy)],
    /* py:38 */ ["REGR_SXX", (self) => self._parse_distinct_arg_function(exp.RegrSxx, 1)],
    /* py:39 */ ["REGR_SXY", (self) => self._parse_distinct_arg_function(exp.RegrSxy)],
    /* py:40 */ ["REGR_SYY", (self) => self._parse_distinct_arg_function(exp.RegrSyy, 1)],
  ]);

  /** py: sqlglot/parsers/databricks.py:43 */
  static FACTOR = new Map([
    /* py:44 */ ...SparkParser.FACTOR,
    /* py:45 */ [TokenType.COLON, exp.JSONExtract],
  ]);

  // py:48 — spreads `parser.Parser.COLUMN_OPERATORS`, NOT `SparkParser`'s. See header.
  /** py: sqlglot/parsers/databricks.py:48 */
  static COLUMN_OPERATORS = new Map([
    /* py:49 */ ...Parser.COLUMN_OPERATORS,
    /* py:50 */ [TokenType.QDCOLON, (self, this_, to) => self.build_cast(
      /* py:51 */ false,
      /* py:52 */ this_,
      /* py:53 */ to,
    )],
  ]);

  /** py: sqlglot/parsers/databricks.py:56 */
  static CAST_COLUMN_OPERATORS = new Set([
    /* py:57 */ ...SparkParser.CAST_COLUMN_OPERATORS,
    /* py:58 */ TokenType.QDCOLON,
  ]);

  /** py: sqlglot/parsers/databricks.py:61 */
  _parse_curdate() {
    // CURDATE, an alias for CURRENT_DATE, has optional parentheses
    if (this._match(TokenType.L_PAREN)) {
      this._match_r_paren();
    }
    return this.expression(new exp.CurrentDate());
  }

  /** py: sqlglot/parsers/databricks.py:67 */
  _parse_primary_key_part() {
    const this_ = super._parse_primary_key_part();
    if (this_ && this._match_text_seq("TIMESERIES")) {
      return this.expression(new exp.TimeseriesKey({ this: this_ }));
    }
    return this_;
  }

  /** py: sqlglot/parsers/databricks.py:73 */
  _parse_cluster_property() {
    if (this._match_texts(["AUTO", "NONE"])) {
      return this.expression(new exp.ClusterProperty({ this: pyUpper(this._prev.text) }));
    }
    return super._parse_cluster_property();
  }
}
