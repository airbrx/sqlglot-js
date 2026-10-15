// py: sqlglot/parsers/exasol.py @ 91119bc — WHOLE FILE (164 LOC), AIR-2289 (epic
// AIR-2272, "12.4 Exasol").
//
// `class ExasolParser(parser.Parser)` — the READ-side Exasol grammar. Lands in the
// same round as `dialects/exasol.py` (`src/dialects/exasol.js`) and
// `generators/exasol.py` (`src/generators/exasol.js`), the same "full stack in one
// round" shape R38 (Redshift) and R103 (Presto) used. Self-contained: extends the
// base `Parser` directly rather than sitting in a subclass chain.
//
// `DATE_UNITS` (py:15) is a MODULE-LEVEL constant re-exported through
// `dialects/exasol.py` (`from sqlglot.parsers.exasol import DATE_UNITS as
// DATE_UNITS`, an explicit re-export, used by `tests/dialects/test_exasol.py:577`),
// so it is declared here and re-exported from `src/dialects/exasol.js` too.
//
// All module-level helper functions this file needs (`binary_from_function`,
// `build_date_delta`, `build_formatted_time`, `build_timetostr_or_tochar`,
// `build_trunc`) already exist in `src/dialects/dialect.js` from earlier dialect
// ports — no new base-helper work required here.

import { Parser } from "../parser.js";
import { TokenType } from "../tokens.js";
import { seqGet } from "../helper.js";
import * as exp from "../expressions/index.js";
import {
  binary_from_function,
  build_date_delta,
  build_formatted_time,
  build_timetostr_or_tochar,
  build_trunc,
} from "../dialects/dialect.js";

/** py: sqlglot/parsers/exasol.py:15 */
export const DATE_UNITS = new Set(["DAY", "WEEK", "MONTH", "YEAR", "HOUR", "MINUTE", "SECOND"]);

/** py: sqlglot/parsers/exasol.py:19 `_build_zeroifnull(args)`. */
function _build_zeroifnull(args) {
  const cond = new exp.Is({ this: seqGet(args, 0), expression: new exp.Null({}) });
  return new exp.If({ this: cond, true: exp.Literal.number(0), false: seqGet(args, 0) });
}

/** py: sqlglot/parsers/exasol.py:25 `_build_nullifzero(args)`. */
function _build_nullifzero(args) {
  const cond = new exp.EQ({ this: seqGet(args, 0), expression: exp.Literal.number(0) });
  return new exp.If({ this: cond, true: new exp.Null({}), false: seqGet(args, 0) });
}

/** py: sqlglot/parsers/exasol.py:30 `class ExasolParser(parser.Parser)`. */
export class ExasolParser extends Parser {
  /** py:31 */
  static TABLE_ALIAS_TOKENS = new Set([
    ...Parser.TABLE_ALIAS_TOKENS,
    TokenType.ANTI,
    TokenType.SEMI,
  ]);

  /** py:36 */
  static FUNCTIONS = new Map([
    ...Parser.FUNCTIONS,
    ...[...DATE_UNITS].map((unit) => [`ADD_${unit}S`, build_date_delta(exp.DateAdd, null, unit)]),
    ...[...DATE_UNITS].map((unit) => [`${unit}S_BETWEEN`, build_date_delta(exp.DateDiff, null, unit)]),
    ["APPROXIMATE_COUNT_DISTINCT", exp.ApproxDistinct.from_arg_list],
    ["BIT_AND", binary_from_function(exp.BitwiseAnd)],
    ["BIT_OR", binary_from_function(exp.BitwiseOr)],
    ["BIT_XOR", binary_from_function(exp.BitwiseXor)],
    ["BIT_NOT", (args) => new exp.BitwiseNot({ this: seqGet(args, 0) })],
    ["BIT_LSHIFT", binary_from_function(exp.BitwiseLeftShift)],
    ["BIT_RSHIFT", binary_from_function(exp.BitwiseRightShift)],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/convert_tz.htm
    ["CONVERT_TZ", (args) => new exp.ConvertTimezone({
      source_tz: seqGet(args, 1),
      target_tz: seqGet(args, 2),
      timestamp: seqGet(args, 0),
      options: seqGet(args, 3),
    })],
    ["CURDATE", exp.CurrentDate.from_arg_list],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/date_trunc.htm#DATE_TRUNC
    ["DATE_TRUNC", (args) => new exp.TimestampTrunc({ this: seqGet(args, 1), unit: seqGet(args, 0) })],
    ["DIV", binary_from_function(exp.IntDiv)],
    ["EVERY", (args) => new exp.All({ this: seqGet(args, 0) })],
    ["EDIT_DISTANCE", exp.Levenshtein.from_arg_list],
    ["FROM_POSIX_TIME", exp.UnixToTime.from_arg_list],
    ["HASH_SHA", exp.SHA.from_arg_list],
    ["HASH_SHA1", exp.SHA.from_arg_list],
    ["HASH_MD5", exp.MD5.from_arg_list],
    ["HASHTYPE_MD5", exp.MD5Digest.from_arg_list],
    ["HASH_SHA256", (args) => new exp.SHA2({ this: seqGet(args, 0), length: exp.Literal.number(256) })],
    ["HASH_SHA512", (args) => new exp.SHA2({ this: seqGet(args, 0), length: exp.Literal.number(512) })],
    ["NOW", exp.CurrentTimestamp.from_arg_list],
    ["NULLIFZERO", _build_nullifzero],
    ["REGEXP_LIKE", (args) => new exp.RegexpLike({
      this: seqGet(args, 0),
      expression: seqGet(args, 1),
      flag: seqGet(args, 2),
      full_match: true,
    })],
    ["REGEXP_SUBSTR", exp.RegexpExtract.from_arg_list],
    ["REGEXP_REPLACE", (args) => new exp.RegexpReplace({
      this: seqGet(args, 0),
      expression: seqGet(args, 1),
      replacement: seqGet(args, 2),
      position: seqGet(args, 3),
      occurrence: seqGet(args, 4),
    })],
    ["TRUNC", build_trunc],
    ["TRUNCATE", build_trunc],
    ["TO_CHAR", build_timetostr_or_tochar],
    ["TO_DATE", build_formatted_time(exp.TsOrDsToDate)],
    ["USER", exp.CurrentUser.from_arg_list],
    ["VAR_POP", exp.VariancePop.from_arg_list],
    ["ZEROIFNULL", _build_zeroifnull],
  ]);

  /** py:94 */
  static CONSTRAINT_PARSERS = new Map([
    ...Parser.CONSTRAINT_PARSERS,
    ["COMMENT", (self) => self.expression(new exp.CommentColumnConstraint({
      this: self._match(TokenType.IS) && self._parse_string(),
    }))],
  ]);

  /** py:101 */
  static RANGE_PARSERS = new Map([
    ...Parser.RANGE_PARSERS,
    [TokenType.RLIKE, (self, this_) => self.expression(new exp.RegexpLike({
      this: this_, expression: self._parse_bitwise(), full_match: true,
    }))],
  ]);

  /** py:108 */
  static FUNC_TOKENS = new Set([
    ...Parser.FUNC_TOKENS,
    TokenType.SYSTIMESTAMP,
  ]);

  /** py:113 */
  static NO_PAREN_FUNCTIONS = new Map([
    ...Parser.NO_PAREN_FUNCTIONS,
    [TokenType.SYSTIMESTAMP, exp.Systimestamp],
    [TokenType.CURRENT_SCHEMA, exp.CurrentSchema],
  ]);

  /** py:119 */
  static FUNCTION_PARSERS = new Map([
    ...Parser.FUNCTION_PARSERS,
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/group_concat.htm
    ["GROUP_CONCAT", (self) => self._parse_group_concat()],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/listagg.htm
    ["LISTAGG", (self) => self._parse_string_agg()],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/json_value.htm
    ["JSON_VALUE", (self) => self._parse_json_value()],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/json_extract.htm
    ["JSON_EXTRACT", (self) => self._parse_json_extract()],
  ]);

  /** py:131 */
  _parse_statement() {
    // https://docs.exasol.com/db/latest/sql/open_schema.htm
    if (this._match_text_seq("OPEN", "SCHEMA")) {
      return this.expression(new exp.Use({ this: this._parse_table(false) }));
    }
    return super._parse_statement();
  }

  /** py:137 */
  _parse_column() {
    const column = super._parse_column();
    if (!(column instanceof exp.Column)) return column;
    const table_ident = column.args.table;
    if (
      table_ident instanceof exp.Identifier
      && table_ident.name.toUpperCase() === "LOCAL"
      && !table_ident.args.quoted
    ) {
      column.set("table", null);
    }
    return column;
  }

  /** py:150 */
  _parse_json_extract() {
    const args = this._parse_expressions();
    this._match_r_paren();

    const expression = new exp.JSONExtract({ expressions: args });

    if (this._match_text_seq("EMITS")) {
      expression.set("emits", this._parse_schema());
    }

    return expression;
  }

  /** py:161 */
  static ODBC_DATETIME_LITERALS = new Map([
    ["d", exp.Date],
    ["ts", exp.Timestamp],
  ]);
}
