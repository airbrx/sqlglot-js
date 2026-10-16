// py: sqlglot/parsers/dremio.py @ 91119bc — WHOLE FILE (136 LOC), AIR-2292 (epic
// AIR-2272, "12.7 Small dialects", batch B).
//
// `class DremioParser(parser.Parser)` — the READ-side Dremio SQL grammar. Lands
// in the same round as `dialects/dremio.py` (`src/dialects/dremio.js`) and
// `generators/dremio.py` (`src/generators/dremio.js`). Self-contained: extends
// the base `Parser` directly.
//
// `build_date_delta`/`build_formatted_time`/`build_timetostr_or_tochar` already
// exist in `src/dialects/dialect.js` from earlier dialect ports.
//
// py:65 `f"{int(year.this):04d}-{int(month.this):02d}-{int(day.this):02d}"` is
// the ONE `corpus/deny/py_builtins.json` site this dialect carries (3 rows, one
// per `:0Nd` format spec, category "format-spec", shim "pyFormat"). Routes
// through the new `pyFormat(value, spec)` shim (`src/_py/str.js`), the single
// named entry point `tools/deny/gen_py_builtins.py` hardcodes for every
// format-spec site in the corpus; it delegates to the pre-existing
// `pyFormatInt` (already built in anticipation of exactly this call site —
// "parsers/dremio.py:65 does..." is its own doc comment) for the actual
// sign-aware zero-padding.
//
// Dialect-aware FUNCTIONS builders (`to_char_is_numeric_handler`,
// `datetype_handler`) are declared with the literal 2-parameter shape
// `(args, dialect)` — `src/parser.js`'s own dispatcher calls any builder whose
// `.length >= 2` as `func_builder(args, this.dialect)`, so no special
// registration is needed beyond matching that arity (AIR-2284's documented
// Databricks-site precedent).

import { Parser } from "../parser.js";
import { TokenType } from "../tokens.js";
import { seqGet } from "../helper.js";
import * as exp from "../expressions/index.js";
import { pyFormat } from "../_py/str.js";
import {
  build_date_delta,
  build_formatted_time,
  build_timetostr_or_tochar,
  Dialect,
} from "../dialects/dialect.js";

/** py: sqlglot/parsers/dremio.py:21 `to_char_is_numeric_handler(args, dialect)`. */
function to_char_is_numeric_handler(args, dialect) {
  const expression = build_timetostr_or_tochar(args, dialect);
  const fmt = seqGet(args, 1);

  // Only mark as numeric if format is a literal containing #
  if (fmt && expression instanceof exp.ToChar && fmt.is_string && fmt.name.includes("#")) {
    expression.set("is_numeric", true);
  }

  return expression;
}

/** py: sqlglot/parsers/dremio.py:32 `build_date_delta_with_cast_interval(expression_class)`. */
function build_date_delta_with_cast_interval(expression_class) {
  const fallback_builder = build_date_delta(expression_class);

  return function _builder(args) {
    if (args.length === 2) {
      const [date_arg, interval_arg] = args;

      if (
        interval_arg instanceof exp.Cast
        && interval_arg.to instanceof exp.DataType
        && interval_arg.to.this instanceof exp.Interval
      ) {
        return new expression_class({
          this: date_arg,
          expression: interval_arg.this,
          unit: interval_arg.to.this.unit,
        });
      }

      return new expression_class({ this: date_arg, expression: interval_arg });
    }

    return fallback_builder(args);
  };
}

/** py: sqlglot/parsers/dremio.py:59 `datetype_handler(args, dialect)`. */
function datetype_handler(args, dialect) {
  const [year, month, day] = args;

  if ([year, month, day].every((arg) => arg instanceof exp.Literal && arg.is_int)) {
    const date_str = `${pyFormat(Number(year.this), "04d")}-${pyFormat(Number(month.this), "02d")}-${pyFormat(Number(day.this), "02d")}`;
    return new exp.Date({ this: exp.Literal.string(date_str) });
  }

  const d = Dialect.get_or_raise(dialect);

  return new exp.Cast({
    this: new exp.Concat({
      expressions: [year, exp.Literal.string("-"), month, exp.Literal.string("-"), day],
      coalesce: d.CONCAT_COALESCE,
    }),
    to: exp.DType.DATE.into_expr(),
  });
}

/** py: sqlglot/parsers/dremio.py:85 `class DremioParser(parser.Parser)`. */
export class DremioParser extends Parser {
  /** py:86 */
  static LOG_DEFAULTS_TO_LN = true;

  /** py:88 */
  static TABLE_ALIAS_TOKENS = new Set([
    ...Parser.TABLE_ALIAS_TOKENS,
    TokenType.ANTI,
    TokenType.SEMI,
  ]);

  /** py:93 */
  static NO_PAREN_FUNCTION_PARSERS = new Map([
    ...Parser.NO_PAREN_FUNCTION_PARSERS,
    ["CURRENT_DATE_UTC", (self) => self._parse_current_date_utc()],
  ]);

  /** py:98 */
  static FUNCTIONS = new Map([
    ...Parser.FUNCTIONS,
    ["ARRAY_GENERATE_RANGE", exp.GenerateSeries.from_arg_list],
    ["BIT_AND", exp.BitwiseAndAgg.from_arg_list],
    ["BIT_OR", exp.BitwiseOrAgg.from_arg_list],
    ["DATE_ADD", build_date_delta_with_cast_interval(exp.DateAdd)],
    ["DATE_FORMAT", build_formatted_time(exp.TimeToStr)],
    ["DATE_SUB", build_date_delta_with_cast_interval(exp.DateSub)],
    ["REGEXP_MATCHES", exp.RegexpLike.from_arg_list],
    ["REGEXP_SPLIT", (args) => new exp.RegexpSplit({
      this: seqGet(args, 0),
      expression: seqGet(args, 1),
      mode: seqGet(args, 2),
      limit: seqGet(args, 3),
    })],
    ["REPEATSTR", exp.Repeat.from_arg_list],
    ["TO_CHAR", to_char_is_numeric_handler],
    ["TO_DATE", build_formatted_time(exp.TsOrDsToDate)],
    ["DATE_PART", exp.Extract.from_arg_list],
    ["DATETYPE", datetype_handler],
  ]);

  /** py:120 */
  static VERSION_PHRASES = new Map([
    ...Parser.VERSION_PHRASES,
    [["AT", "TIMESTAMP"], "TIMESTAMP"],
    [["AT", "SNAPSHOT"], "VERSION"],
  ]);

  /** py:126 `_parse_current_date_utc(self) -> exp.Cast`. */
  _parse_current_date_utc() {
    if (this._match(TokenType.L_PAREN)) this._match_r_paren();

    return new exp.Cast({
      this: new exp.AtTimeZone({
        this: new exp.CurrentTimestamp({}),
        zone: exp.Literal.string("UTC"),
      }),
      to: exp.DType.DATE.into_expr(),
    });
  }
}
