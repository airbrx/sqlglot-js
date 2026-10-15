// py: sqlglot/parsers/oracle.py @ 91119bc — WHOLE FILE (262 LOC), AIR-2290 (epic
// AIR-2272, "12.5 Oracle").
//
// `class OracleParser(parser.Parser)` — standalone, extends the base `Parser`
// directly, the same shape Presto/Snowflake/Postgres/TSQL/MySQL/ClickHouse use
// (PORT_PLAN.md R38's "full stack in one round" template, here one-link). Oracle
// is `class Oracle(Dialect)`, no chain — `dialects/oracle.js` and
// `generators/oracle.js` land alongside this file in the same round.
//
// All module-level helpers this file needs (`build_formatted_time`,
// `build_timetostr_or_tochar`, `build_trunc`, `build_coalesce`) already exist from
// earlier dialect ports — `build_timetostr_or_tochar`/`build_trunc` specifically
// from `snowflake.js`'s own R24/R27 landing, `build_coalesce` from `parser.js`
// itself (upstream: `sqlglot.parser.build_coalesce`).

import { Parser } from "../parser.js";
import { TokenType } from "../tokens.js";
import { seqGet, ensureList } from "../helper.js";
import * as exp from "../expressions/index.js";
import {
  build_formatted_time,
  build_timetostr_or_tochar,
  build_trunc,
} from "../dialects/dialect.js";
import { build_coalesce } from "../parser.js";

/** py: sqlglot/parsers/oracle.py:16 `_build_to_timestamp`. */
function _build_to_timestamp(args, dialect) {
  if (args.length === 1) {
    return new exp.Anonymous({ this: "TO_TIMESTAMP", expressions: args });
  }
  return build_formatted_time(exp.StrToTime)(args, dialect);
}

/** py: sqlglot/parsers/oracle.py:23 `class OracleParser(parser.Parser)`. */
export class OracleParser extends Parser {
  /** py:24 */
  static WINDOW_BEFORE_PAREN_TOKENS = new Set([TokenType.OVER, TokenType.KEEP]);
  /** py:25 */
  static VALUES_FOLLOWED_BY_PAREN = false;
  /** py:26 */
  static SUPPORTS_NTH_VALUE_FROM_MODIFIER = true;

  /** py:28 `{k: v for k, v in parser.Parser.FUNCTIONS.items() if k != "TO_BOOLEAN"}`. */
  static FUNCTIONS = new Map([
    ...[...Parser.FUNCTIONS].filter(([k]) => k !== "TO_BOOLEAN"),
    ["CONVERT", exp.ConvertToCharset.from_arg_list],
    ["L2_DISTANCE", exp.EuclideanDistance.from_arg_list],
    ["NVL", (args) => build_coalesce(args, true)],
    ["SQUARE", (args) => new exp.Pow({ this: seqGet(args, 0), expression: exp.Literal.number(2) })],
    ["TO_CHAR", build_timetostr_or_tochar],
    ["TO_TIMESTAMP", _build_to_timestamp],
    ["TO_DATE", build_formatted_time(exp.StrToDate)],
    [
      "TRUNC",
      (args, dialect) => build_trunc(args, dialect, {
        date_trunc_unabbreviate: false,
        default_date_trunc_unit: "DD",
      }),
    ],
  ]);

  /** py:42 */
  static NO_PAREN_FUNCTION_PARSERS = new Map([
    ...Parser.NO_PAREN_FUNCTION_PARSERS,
    ["NEXT", (self) => self._parse_next_value_for()],
    ["PRIOR", (self) => self.expression(new exp.Prior({ this: self._parse_bitwise() }))],
    ["SYSDATE", (self) => self.expression(new exp.CurrentTimestamp({ sysdate: true }))],
    ["DBMS_RANDOM", (self) => self._parse_dbms_random()],
  ]);

  /** py:50 */
  static NO_PAREN_FUNCTIONS = new Map([
    ...Parser.NO_PAREN_FUNCTIONS,
    [TokenType.LOCALTIMESTAMP, exp.Localtimestamp],
    [TokenType.SYSTIMESTAMP, exp.Systimestamp],
  ]);

  /** py:56 `{k: v for k, v in parser.Parser.FUNCTION_PARSERS.items() if k != "CONVERT"}`. */
  static FUNCTION_PARSERS = new Map([
    ...[...Parser.FUNCTION_PARSERS].filter(([k]) => k !== "CONVERT"),
    ["JSON_ARRAY", (self) => self._parse_oracle_json_array()],
    ["JSON_ARRAYAGG", (self) => self._parse_oracle_json_arrayagg()],
    ["JSON_EXISTS", (self) => self._parse_json_exists()],
    ["LISTAGG", (self) => self._parse_string_agg()],
    ["TO_NUMBER", (self) => self._parse_to_number()],
  ]);

  /** py:65 */
  static PROPERTY_PARSERS = new Map([
    ...Parser.PROPERTY_PARSERS,
    ["GLOBAL", (self) => self._match_text_seq("TEMPORARY") && self.expression(new exp.TemporaryProperty({ this: "GLOBAL" }))],
    ["PRIVATE", (self) => self._match_text_seq("TEMPORARY") && self.expression(new exp.TemporaryProperty({ this: "PRIVATE" }))],
    ["FORCE", (self) => self.expression(new exp.ForceProperty())],
  ]);

  /** py:78 */
  static QUERY_MODIFIER_PARSERS = new Map([
    ...Parser.QUERY_MODIFIER_PARSERS,
    [TokenType.ORDER_SIBLINGS_BY, (self) => ["order", self._parse_order()]],
    [TokenType.WITH, (self) => ["options", ensureList(self._parse_query_restrictions())]],
  ]);

  /** py:87 */
  static TYPE_LITERAL_PARSERS = new Map([
    [exp.DType.DATE, (self, this_) => self.expression(new exp.DateStrToDate({ this: this_ }))],
    // https://docs.oracle.com/en/database/oracle/oracle-database/19/refrn/NLS_TIMESTAMP_FORMAT.html
    [
      exp.DType.TIMESTAMP,
      (self, this_) => _build_to_timestamp([this_, '"%Y-%m-%d %H:%M:%S.%f"'], self.dialect),
    ],
  ]);

  /**
   * py:95-97 — SELECT UNIQUE .. is old-style Oracle syntax for SELECT DISTINCT ..
   * Reference: https://stackoverflow.com/a/336455
   */
  static DISTINCT_TOKENS = new Set([TokenType.DISTINCT, TokenType.UNIQUE]);

  /**
   * py:99 `QUERY_RESTRICTIONS: t.ClassVar[OPTIONS_TYPE] = {"WITH": (("READ", "ONLY"),
   * ("CHECK", "OPTION"))}` — see `tsql.js`'s own `OPTIONS_TYPE` comment for the JS
   * shape (`Map<string, Array<string | string[]>>`).
   */
  static QUERY_RESTRICTIONS = new Map([["WITH", [["READ", "ONLY"], ["CHECK", "OPTION"]]]]);

  /** py:106 */
  _parse_to_number() {
    // https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/TO_NUMBER.html
    const this_ = this._parse_bitwise();

    let default_ = null;
    if (this._match(TokenType.DEFAULT)) {
      default_ = this._parse_bitwise();
      this._match_text_seq("ON", "CONVERSION", "ERROR");
    }

    let fmt = null;
    let nlsparam = null;
    if (this._match(TokenType.COMMA)) {
      fmt = this._parse_bitwise();
      if (this._match(TokenType.COMMA)) {
        nlsparam = this._parse_bitwise();
      }
    }

    return this.expression(
      new exp.ToNumber({ this: this_, format: fmt, nlsparam, default: default_ }),
    );
  }

  /** py:126 */
  _parse_dbms_random() {
    if (this._match_text_seq(".", "VALUE")) {
      let lower = null;
      let upper = null;
      if (this._match(TokenType.L_PAREN, false)) {
        const lower_upper = this._parse_wrapped_csv(() => this._parse_bitwise());
        if (lower_upper.length === 2) {
          [lower, upper] = lower_upper;
        }
      }

      return new exp.Rand({ lower, upper });
    }

    this._retreat(this._index - 1);
    return null;
  }

  /** py:139 */
  _parse_oracle_json_array() {
    return this._parse_json_array(exp.JSONArray, {
      expressions: this._parse_csv(() => this._parse_format_json(this._parse_bitwise())),
    });
  }

  /** py:145 */
  _parse_oracle_json_arrayagg() {
    return this._parse_json_array(exp.JSONArrayAgg, {
      this: this._parse_format_json(this._parse_bitwise()),
      order: this._parse_order(),
    });
  }

  /** py:152 */
  _parse_json_array(expr_type, kwargs = {}) {
    return this.expression(
      new expr_type({
        null_handling: this._parse_on_handling("NULL", "NULL", "ABSENT"),
        return_type: this._match_text_seq("RETURNING") && this._parse_type(),
        strict: this._match_text_seq("STRICT"),
        ...kwargs,
      }),
    );
  }

  /** py:162 */
  _parse_hint_function_call() {
    if (!this._curr.bool() || !this._next.bool() || this._next.token_type !== TokenType.L_PAREN) {
      return null;
    }

    const name = this._curr.text;

    this._advance(2);
    const args = this._parse_hint_args();
    const this_ = this.expression(new exp.Anonymous({ this: name, expressions: args }));
    this._match_r_paren(this_);
    return this_;
  }

  /** py:174 */
  _parse_hint_args() {
    const args = [];
    let result = this._parse_var();

    while (result) {
      args.push(result);
      result = this._parse_var();
    }

    return args;
  }

  /** py:184 */
  _parse_query_restrictions() {
    const kind = this._parse_var_from_options(this.constructor.QUERY_RESTRICTIONS, false);

    if (!kind) {
      return null;
    }

    return this.expression(
      new exp.QueryOption({
        this: kind,
        expression: this._match(TokenType.CONSTRAINT) && this._parse_field(),
      }),
    );
  }

  /** py:196 */
  _parse_json_exists() {
    const this_ = this._parse_format_json(this._parse_bitwise());
    this._match(TokenType.COMMA);
    return this.expression(
      new exp.JSONExists({
        this: this_,
        path: this.dialect.to_json_path(this._parse_bitwise()),
        passing: this._match_text_seq("PASSING") && this._parse_csv(() => this._parse_alias(this._parse_bitwise())),
        on_condition: this._parse_on_condition(),
      }),
    );
  }

  /** py:209 */
  _parse_into() {
    // https://docs.oracle.com/en/database/oracle/oracle-database/19/lnpls/SELECT-INTO-statement.html
    const bulk_collect = this._match(TokenType.BULK_COLLECT_INTO);
    if (!bulk_collect && !this._match(TokenType.INTO)) {
      return null;
    }

    const index = this._index;

    const expressions = this._parse_expressions();
    if (expressions.length === 1) {
      this._retreat(index);
      this._match(TokenType.TABLE);
      return this.expression(
        new exp.Into({ this: this._parse_table(true), bulk_collect }),
      );
    }

    return this.expression(new exp.Into({ bulk_collect, expressions }));
  }

  /** py:227 */
  _parse_connect_with_prior() {
    return this._parse_assignment();
  }

  /** py:230 */
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_column_ops(this_) {
    this_ = super._parse_column_ops(this_);

    if (!this_) {
      return this_;
    }

    const index = this._index;

    // https://docs.oracle.com/en/database/oracle/oracle-database/26/sqlrf/Interval-Exprs.html
    const interval_span = this._try_parse(() => this._parse_interval_span(this_));
    if (interval_span && interval_span.args.unit instanceof exp.IntervalSpan) {
      return interval_span;
    }

    this._retreat(index);
    return this_;
  }

  /** py:246 */
  _parse_insert_table() {
    // Oracle does not use AS for INSERT INTO alias
    // https://docs.oracle.com/en/database/oracle/oracle-database/18/sqlrf/INSERT.html
    // Parse table parts without schema to avoid parsing the alias with its columns
    const this_ = this._parse_table_parts(true);

    if (this_ instanceof exp.Table) {
      const alias_name = this._parse_id_var(false);
      if (alias_name) {
        this_.set("alias", new exp.TableAlias({ this: alias_name }));
      }

      this_.set("partition", this._parse_partition());

      // Now parse the schema (column list) if present
      return this._parse_schema(this_);
    }

    return this_;
  }
}
