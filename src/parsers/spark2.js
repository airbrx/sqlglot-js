// py: sqlglot/parsers/spark2.py @ 91119bc
//
// `class Spark2Parser(HiveParser)` — link 2 of 4 in `Hive <- Spark2 <- Spark <-
// Databricks`. Every table below extends `HiveParser`'s, never `parser.Parser`'s:
// upstream spells them `{**HiveParser.FUNCTIONS, ...}`, so Hive's own 30 `FUNCTIONS`
// entries and its `NO_PAREN_FUNCTIONS` CURRENT_TIME subtraction are inherited through
// the chain rather than re-derived. `FUNC_TOKENS` uses the set-union operator
// (`HiveParser.FUNC_TOKENS | {...}`) rather than a comprehension — an extension.
//
// This file adds no method that reads a class table, so `this.constructor.X` does not
// appear here; the two methods it does define are overrides that Spark and Databricks
// inherit unchanged.

import { build_trim } from "../parser.js";
import { TokenType } from "../tokens.js";
import { ensureList, seqGet } from "../helper.js";
import * as exp from "../expressions/index.js";
import {
  binary_from_function,
  build_formatted_time,
  pivot_column_names,
} from "../dialects/dialect.js";
import { HiveParser } from "./hive.js";

/** py: sqlglot/parsers/spark2.py:17 */
export function build_as_cast(to_type) {
  return (args) => new exp.Cast({ this: seqGet(args, 0), to: exp.DataType.fromStr(to_type) });
}

/** py: sqlglot/parsers/spark2.py:21 */
export function build_int_div(args) {
  let this_ = seqGet(args, 0);
  let expression = seqGet(args, 1);

  // py: `this is None or expression is None` — an identity test against None, so a
  // present-but-falsy operand (`0`) still takes the second branch. `seq_get` returns
  // `null` here, never `undefined`, so `=== null` is the faithful spelling.
  if (this_ === null || expression === null) {
    return new exp.IntDiv({ this: this_, expression });
  }

  this_ = this_ instanceof exp.Binary ? new exp.Paren({ this: this_ }) : this_;
  expression = expression instanceof exp.Binary ? new exp.Paren({ this: expression }) : expression;

  return new exp.Paren({ this: new exp.IntDiv({ this: this_, expression }) });
}

export class Spark2Parser extends HiveParser {
  /* py:35 */ static TRIM_PATTERN_FIRST = true;
  /* py:36 */ static CHANGE_COLUMN_ALTER_SYNTAX = true;
  /* py:37 */ static PIVOT_COLUMN_NAMING = "agg_name_if_multiple";

  /* py:39 */ static FUNC_TOKENS = new Set([
    ...HiveParser.FUNC_TOKENS, TokenType.AND, TokenType.OR, TokenType.DIV,
  ]);

  /** py: sqlglot/parsers/spark2.py:41 */
  static FUNCTIONS = new Map([
    /* py:42 */ ...HiveParser.FUNCTIONS,
    /* py:43 */ ["AGGREGATE", exp.Reduce.from_arg_list],
    /* py:44 */ ["BOOLEAN", build_as_cast("boolean")],
    /* py:45 */ ["DATE", build_as_cast("date")],
    /* py:46 */ ["DATE_TRUNC", (args) => new exp.TimestampTrunc({
      this: seqGet(args, 1), unit: exp.var_(seqGet(args, 0)),
    })],
    /* py:49 */ ["DAYOFMONTH", (args) => new exp.DayOfMonth({ this: new exp.TsOrDsToDate({ this: seqGet(args, 0) }) })],
    /* py:50 */ ["DAYOFWEEK", (args) => new exp.DayOfWeek({ this: new exp.TsOrDsToDate({ this: seqGet(args, 0) }) })],
    /* py:51 */ ["DAYOFYEAR", (args) => new exp.DayOfYear({ this: new exp.TsOrDsToDate({ this: seqGet(args, 0) }) })],
    /* py:52 */ ["DIV", build_int_div],
    /* py:53 */ ["DOUBLE", build_as_cast("double")],
    /* py:54 */ ["ELEMENT_AT", (args) => new exp.Bracket({
      this: seqGet(args, 0),
      expressions: ensureList(seqGet(args, 1)),
      offset: 1,
      safe: false,
    })],
    /* py:60 */ ["FLOAT", build_as_cast("float")],
    /* py:61 */ ["FORMAT_STRING", exp.Format.from_arg_list],
    /* py:62 */ ["FROM_UTC_TIMESTAMP", (args, dialect) => new exp.AtTimeZone({
      this: exp.cast(
        seqGet(args, 0) || new exp.Var({ this: "" }),
        exp.DType.TIMESTAMP,
        { dialect },
      ),
      zone: seqGet(args, 1),
    })],
    /* py:70 */ ["LTRIM", (args) => build_trim(args, true, true)],
    /* py:71 */ ["INT", build_as_cast("int")],
    /* py:72 */ ["MAP_FROM_ARRAYS", exp.Map.from_arg_list],
    /* py:73 */ ["RLIKE", exp.RegexpLike.from_arg_list],
    /* py:74 */ ["RTRIM", (args) => build_trim(args, false, true)],
    /* py:75 */ ["SHIFTLEFT", binary_from_function(exp.BitwiseLeftShift)],
    /* py:76 */ ["SHIFTRIGHT", binary_from_function(exp.BitwiseRightShift)],
    /* py:77 */ ["STRING", build_as_cast("string")],
    /* py:78 */ ["SLICE", exp.ArraySlice.from_arg_list],
    /* py:79 */ ["TIMESTAMP", build_as_cast("timestamp")],
    /* py:80 */ ["TO_TIMESTAMP", (args, dialect) => (
      args.length === 1
        ? build_as_cast("timestamp")(args)
        : build_formatted_time(exp.StrToTime)(args, dialect)
    )],
    /* py:85 */ ["TO_UNIX_TIMESTAMP", exp.StrToUnix.from_arg_list],
    /* py:86 */ ["TO_UTC_TIMESTAMP", (args, dialect) => new exp.FromTimeZone({
      this: exp.cast(
        seqGet(args, 0) || new exp.Var({ this: "" }),
        exp.DType.TIMESTAMP,
        { dialect },
      ),
      zone: seqGet(args, 1),
    })],
    /* py:94 */ ["TRUNC", (args) => new exp.DateTrunc({ unit: seqGet(args, 1), this: seqGet(args, 0) })],
    /* py:95 */ ["WEEKOFYEAR", (args) => new exp.WeekOfYear({ this: new exp.TsOrDsToDate({ this: seqGet(args, 0) }) })],
  ]);

  /** py: sqlglot/parsers/spark2.py:98 */
  static FUNCTION_PARSERS = new Map([
    /* py:99 */ ...HiveParser.FUNCTION_PARSERS,
    /* py:100 */ ["AND", (self) => self._parse_connector_function(exp.and_)],
    /* py:101 */ ["APPROX_PERCENTILE", (self) => self._parse_distinct_arg_function(exp.ApproxQuantile)],
    /* py:102 */ ["BROADCAST", (self) => self._parse_join_hint("BROADCAST")],
    /* py:103 */ ["BROADCASTJOIN", (self) => self._parse_join_hint("BROADCASTJOIN")],
    /* py:104 */ ["MAPJOIN", (self) => self._parse_join_hint("MAPJOIN")],
    /* py:105 */ ["MERGE", (self) => self._parse_join_hint("MERGE")],
    /* py:106 */ ["OR", (self) => self._parse_connector_function(exp.or_)],
    /* py:107 */ ["SHUFFLEMERGE", (self) => self._parse_join_hint("SHUFFLEMERGE")],
    /* py:108 */ ["MERGEJOIN", (self) => self._parse_join_hint("MERGEJOIN")],
    /* py:109 */ ["SHUFFLE_HASH", (self) => self._parse_join_hint("SHUFFLE_HASH")],
    /* py:110 */ ["SHUFFLE_REPLICATE_NL", (self) => self._parse_join_hint("SHUFFLE_REPLICATE_NL")],
  ]);

  /** py: sqlglot/parsers/spark2.py:113 */
  _parse_drop_column() {
    return this._match_text_seq("DROP", "COLUMNS")
      ? this.expression(new exp.Drop({ tables: [this._parse_schema()], kind: "COLUMNS" }))
      : null;
  }

  /** py: sqlglot/parsers/spark2.py:120 */
  _pivot_column_names(aggregations) {
    if (aggregations.length === 1) {
      return [];
    }
    return pivot_column_names(aggregations, "spark");
  }
}
