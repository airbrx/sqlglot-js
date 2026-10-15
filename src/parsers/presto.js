// py: sqlglot/parsers/presto.py @ 91119bc — WHOLE FILE (141 LOC), AIR-2287.
//
// `class PrestoParser(parser.Parser)` — the READ-side Presto/Trino grammar. First
// link of the Presto-family chain (`dialects/presto.py` and `generators/presto.py`
// land alongside it in this same round, PORT_PLAN.md R38's "full stack in one
// round" shape); `trino`/`athena`/`dune` are separate later rounds that extend
// this file, same relationship `redshift.js extends postgres.js` already models.
// Self-contained the same way TSQL/Snowflake/Postgres were: it extends the base
// `Parser` directly rather than sitting in a subclass chain.
//
// All five module-level helper functions this file needs (`binary_from_function`,
// `build_formatted_time`, `build_regexp_extract`, `build_replace_with_optional_
// replacement`, `date_trunc_to_time`) already exist in `src/dialects/dialect.js`
// from earlier dialect ports — no new base-helper work required here.
//
// `_build_to_char`'s own `dialect: Dialect` parameter (py:48, used only for
// `build_formatted_time(exp.TimeToStr, "teradata")(args, dialect)`'s SIGNATURE,
// never read directly) is a plain pass-through; FUNCTIONS-table callables in this
// port already take `(args, dialect)` for exactly this shape (see
// `build_formatted_time`'s own JS signature in `dialect.js`), so no wrapper is
// needed beyond matching that call shape.

import { Parser, setUnion } from "../parser.js";
import { TokenType } from "../tokens.js";
import { seqGet } from "../helper.js";
import * as exp from "../expressions/index.js";
import {
  binary_from_function,
  build_formatted_time,
  build_regexp_extract,
  build_replace_with_optional_replacement,
  date_trunc_to_time,
} from "../dialects/dialect.js";
import { pyUpper } from "../_py/str.js";

/** py: sqlglot/parsers/presto.py:20 */
function _build_approx_percentile(args) {
  if (args.length === 4) {
    return new exp.ApproxQuantile({
      this: seqGet(args, 0),
      weight: seqGet(args, 1),
      quantile: seqGet(args, 2),
      accuracy: seqGet(args, 3),
    });
  }
  if (args.length === 3) {
    return new exp.ApproxQuantile({
      this: seqGet(args, 0),
      quantile: seqGet(args, 1),
      accuracy: seqGet(args, 2),
    });
  }
  return exp.ApproxQuantile.from_arg_list(args);
}

/** py: sqlglot/parsers/presto.py:35 */
function _build_from_unixtime(args) {
  if (args.length === 3) {
    return new exp.UnixToTime({
      this: seqGet(args, 0),
      hours: seqGet(args, 1),
      minutes: seqGet(args, 2),
    });
  }
  if (args.length === 2) {
    return new exp.UnixToTime({ this: seqGet(args, 0), zone: seqGet(args, 1) });
  }
  return exp.UnixToTime.from_arg_list(args);
}

/** py: sqlglot/parsers/presto.py:48 */
function _build_to_char(args, dialect) {
  const fmt = seqGet(args, 1);
  if (fmt instanceof exp.Literal) {
    // We uppercase this to match Teradata's format mapping keys
    fmt.set("this", pyUpper(fmt.this));
  }

  // We use "teradata" on purpose here, because the time formats are different in Presto.
  // See https://prestodb.io/docs/current/functions/teradata.html?highlight=to_char#to_char
  return build_formatted_time(exp.TimeToStr, "teradata")(args, dialect);
}

/** py: sqlglot/parsers/presto.py:59 `class PrestoParser(parser.Parser)`. */
export class PrestoParser extends Parser {
  static VALUES_FOLLOWED_BY_PAREN = false;
  static ZONE_AWARE_TIMESTAMP_CONSTRUCTOR = true;

  /** py:63 */
  static NO_PAREN_FUNCTIONS = new Map([
    ...Parser.NO_PAREN_FUNCTIONS,
    [TokenType.LOCALTIME, exp.Localtime],
    [TokenType.LOCALTIMESTAMP, exp.Localtimestamp],
  ]);

  /** py:69 */
  static TABLE_ALIAS_TOKENS = setUnion(
    Parser.TABLE_ALIAS_TOKENS,
    new Set([TokenType.ANTI, TokenType.SEMI]),
  );

  /** py:74 */
  static FUNCTIONS = new Map([
    ...Parser.FUNCTIONS,
    ["ARBITRARY", exp.AnyValue.from_arg_list],
    ["APPROX_DISTINCT", exp.ApproxDistinct.from_arg_list],
    ["APPROX_PERCENTILE", _build_approx_percentile],
    ["BITWISE_AND", binary_from_function(exp.BitwiseAnd)],
    ["BITWISE_NOT", (args) => new exp.BitwiseNot({ this: seqGet(args, 0) })],
    ["BITWISE_OR", binary_from_function(exp.BitwiseOr)],
    ["BITWISE_XOR", binary_from_function(exp.BitwiseXor)],
    ["CARDINALITY", exp.ArraySize.from_arg_list],
    ["CONTAINS", exp.ArrayContains.from_arg_list],
    ["DATE_ADD", (args) => new exp.DateAdd({
      this: seqGet(args, 2), expression: seqGet(args, 1), unit: seqGet(args, 0),
    })],
    ["DATE_DIFF", (args) => new exp.DateDiff({
      this: seqGet(args, 2), expression: seqGet(args, 1), unit: seqGet(args, 0),
    })],
    ["DATE_FORMAT", build_formatted_time(exp.TimeToStr)],
    ["DATE_PARSE", build_formatted_time(exp.StrToTime)],
    ["DATE_TRUNC", date_trunc_to_time],
    ["DAY_OF_WEEK", exp.DayOfWeekIso.from_arg_list],
    ["DOW", exp.DayOfWeekIso.from_arg_list],
    ["DOY", exp.DayOfYear.from_arg_list],
    ["ELEMENT_AT", (args) => new exp.Bracket({
      this: seqGet(args, 0), expressions: [seqGet(args, 1)], offset: 1, safe: true,
    })],
    ["FROM_HEX", exp.Unhex.from_arg_list],
    ["FROM_UNIXTIME", _build_from_unixtime],
    ["FROM_UTF8", (args) => new exp.Decode({
      this: seqGet(args, 0), replace: seqGet(args, 1), charset: exp.Literal.string("utf-8"),
    })],
    ["JSON_FORMAT", (args) => new exp.JSONFormat({
      this: seqGet(args, 0), options: seqGet(args, 1), is_json: true,
    })],
    ["LEVENSHTEIN_DISTANCE", exp.Levenshtein.from_arg_list],
    ["NOW", exp.CurrentTimestamp.from_arg_list],
    ["REGEXP_EXTRACT", build_regexp_extract(exp.RegexpExtract)],
    ["REGEXP_EXTRACT_ALL", build_regexp_extract(exp.RegexpExtractAll)],
    ["REGEXP_REPLACE", (args) => new exp.RegexpReplace({
      this: seqGet(args, 0),
      expression: seqGet(args, 1),
      replacement: seqGet(args, 2) || exp.Literal.string(""),
    })],
    ["REPLACE", build_replace_with_optional_replacement],
    ["ROW", exp.Struct.from_arg_list],
    ["SEQUENCE", exp.GenerateSeries.from_arg_list],
    ["SET_AGG", exp.ArrayUniqueAgg.from_arg_list],
    ["SPLIT_TO_MAP", exp.StrToMap.from_arg_list],
    ["STRPOS", (args) => new exp.StrPosition({
      this: seqGet(args, 0), substr: seqGet(args, 1), occurrence: seqGet(args, 2),
    })],
    ["SLICE", exp.ArraySlice.from_arg_list],
    ["TO_CHAR", _build_to_char],
    ["TO_UNIXTIME", exp.TimeToUnix.from_arg_list],
    ["TO_UTF8", (args) => new exp.Encode({
      this: seqGet(args, 0), charset: exp.Literal.string("utf-8"),
    })],
    ["MD5", exp.MD5Digest.from_arg_list],
    ["SHA256", (args) => new exp.SHA2Digest({
      this: seqGet(args, 0), length: exp.Literal.number(256),
    })],
    ["SHA512", (args) => new exp.SHA2Digest({
      this: seqGet(args, 0), length: exp.Literal.number(512),
    })],
    ["WEEK", exp.WeekOfYear.from_arg_list],
  ]);

  /** py:141 `{k: v for k, v in parser.Parser.FUNCTION_PARSERS.items() if k != "TRIM"}`. */
  static FUNCTION_PARSERS = new Map(
    [...Parser.FUNCTION_PARSERS].filter(([k]) => k !== "TRIM"),
  );
}
