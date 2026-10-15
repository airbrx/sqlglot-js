// py: sqlglot/parsers/trino.py @ 91119bc — WHOLE FILE (267 LOC), AIR-2287 (epic
// AIR-2272, "12.2 Presto family"), part 2 of the chain.
//
// `class TrinoParser(PrestoParser)` — extends the Presto grammar (`parsers/presto.js`,
// PORT_PLAN.md R103) with Trino-only syntax: `VERSION()`/`CURRENT_CATALOG`, the
// `JSON_QUERY`/`JSON_VALUE`/`LISTAGG`/`TRIM` function-parser overrides Presto's own
// file dropped, `NOT DETERMINISTIC` as a `StabilityProperty`, and the inline SQL UDF
// ("routine") body grammar — `WITH function foo(...) ... AS BEGIN ... END` — which is
// Trino-specific and not shared with Presto at all.
//
// `exp.Block`/`IfBlock`/`CaseStatement`/`WhileBlock`/`LoopBlock`/`RepeatBlock`/
// `Iterate`/`Leave`/`Return`/`FunctionSpecification`/`JSONExtractQuote` are all
// pre-existing seeded skeleton classes (`src/expressions/classes.js`, generated from
// upstream ARG_TYPES) — no new Expression-class work was needed to port this file.
// The base `Generator`'s own `functionspecification_sql`/`ifblock_sql`/
// `casestatement_sql`/`whileblock_sql`/`loopblock_sql`/`repeatblock_sql` are likewise
// already real "Unsupported ... syntax" fallbacks (matching upstream's own base
// `generator.py` defaults) and `block_sql`/`return_sql`/`leave_sql`/`iterate_sql` are
// already real, non-stub implementations — this file's own real overrides for the
// first group land in `src/generators/trino.js`, the next link in this round.

import { PrestoParser } from "./presto.js";
import { TokenType } from "../tokens.js";
import * as exp from "../expressions/index.js";
import { ensureList } from "../helper.js";
import { pyUpper } from "../_py/str.js";

/**
 * py: sqlglot/parsers/trino.py:30 `JSON_QUERY_OPTIONS`.
 *
 * `("WRAPPER")` (no trailing comma) is a bare string in Python, not a 1-tuple; the
 * literal "WRAPPED" at py:37 (vs. every sibling's "WRAPPER") is upstream's own text,
 * preserved verbatim rather than "corrected".
 */
const JSON_QUERY_WITH_WITHOUT_OPTIONS = [
  "WRAPPER",
  ["ARRAY", "WRAPPER"],
  ["CONDITIONAL", "WRAPPER"],
  ["CONDITIONAL", "ARRAY", "WRAPPED"],
  ["UNCONDITIONAL", "WRAPPER"],
  ["UNCONDITIONAL", "ARRAY", "WRAPPER"],
];

/** py: sqlglot/parsers/trino.py:11 `class TrinoParser(PrestoParser)`. */
export class TrinoParser extends PrestoParser {
  /** py:12 */
  static NO_PAREN_FUNCTIONS = new Map([
    ...PrestoParser.NO_PAREN_FUNCTIONS,
    [TokenType.CURRENT_CATALOG, exp.CurrentCatalog],
  ]);

  /** py:17 */
  static FUNCTIONS = new Map([
    ...PrestoParser.FUNCTIONS,
    ["VERSION", exp.CurrentVersion.from_arg_list],
  ]);

  /** py:22 */
  static FUNCTION_PARSERS = new Map([
    ...PrestoParser.FUNCTION_PARSERS,
    ["TRIM", (self) => self._parse_trim()],
    ["JSON_QUERY", (self) => self._parse_json_query()],
    ["JSON_VALUE", (self) => self._parse_json_value()],
    ["LISTAGG", (self) => self._parse_string_agg()],
  ]);

  /** py:30 */
  static JSON_QUERY_OPTIONS = new Map([
    ["WITH", JSON_QUERY_WITH_WITHOUT_OPTIONS],
    ["WITHOUT", JSON_QUERY_WITH_WITHOUT_OPTIONS],
  ]);

  /** py:44 */
  _parse_json_query_quote() {
    if (!(this._match_text_seq("KEEP", "QUOTES") || this._match_text_seq("OMIT", "QUOTES"))) {
      return null;
    }

    return this.expression(new exp.JSONExtractQuote({
      option: pyUpper(this._tokens[this._index - 2].text),
      scalar: this._match_text_seq("ON", "SCALAR", "STRING"),
    }));
  }

  /** py:55 */
  _parse_json_query() {
    return this.expression(new exp.JSONExtract({
      this: this._parse_bitwise(),
      expression: this._match(TokenType.COMMA) && this._parse_bitwise(),
      option: this._parse_var_from_options(this.constructor.JSON_QUERY_OPTIONS, false),
      json_query: true,
      quote: this._parse_json_query_quote(),
      on_condition: this._parse_on_condition(),
    }));
  }

  /** py:67 */
  _parse_property() {
    if (this._match_text_seq("NOT", "DETERMINISTIC")) {
      return this.expression(new exp.StabilityProperty({ this: exp.Literal.string("VOLATILE") }));
    }

    return super._parse_property();
  }

  /** py:73 */
  _parse_cte() {
    // A `WITH` clause entry that starts with `FUNCTION <name>` is an inline SQL UDF
    // specification (https://trino.io/docs/current/udf/sql.html), as opposed to a
    // CTE that happens to be named "function", e.g. `WITH function AS (SELECT 1)`
    if (
      this._match(TokenType.FUNCTION, false) &&
      this._next.bool() &&
      this.constructor.ID_VAR_TOKENS.has(this._next.token_type)
    ) {
      this._advance();
      return this._parse_function_specification();
    }

    return super._parse_cte();
  }

  /** py:87 */
  _parse_function_specification() {
    const this_ = this._parse_user_defined_function(TokenType.FUNCTION);

    // Collected separately (rather than one _parse_properties() call) so the
    // generator can place `WITH (...)` in its own bracketed clause at the end,
    // instead of it blending into the bare characteristics list.
    const characteristics = [];
    const properties = [];

    while (true) {
      if (this._match(TokenType.WITH)) {
        properties.push(...this._parse_wrapped_csv(this._parse_key_value_property.bind(this)));
        continue;
      }

      const characteristic = this._parse_property();
      if (!characteristic) break;

      characteristics.push(...ensureList(characteristic));
    }

    return this.expression(new exp.FunctionSpecification({
      this: this_,
      characteristics: characteristics.length
        ? this.expression(new exp.Properties({ expressions: characteristics }))
        : null,
      properties: properties.length
        ? this.expression(new exp.Properties({ expressions: properties }))
        : null,
      expression: this._parse_routine_statement(),
    }));
  }

  /** py:120 */
  _parse_routine_statements(...terminators) {
    // Unlike _parse_block(), stops on any of `terminators` even when tokens
    // follow (Trino's own END is always followed by the enclosing query, left
    // for the caller), matching them as text rather than just TokenType.END, so
    // this same chunk-continuation loop also serves IF/ELSEIF/ELSE.
    const statements = [];

    while (!this._match_texts(terminators)) {
      if (!this._curr.bool()) {
        if (this._chunk_index >= this._chunks.length) {
          this.raise_error("Unexpected end of routine body");
          break;
        }

        this._advance_chunk();
      } else if (!this._match(TokenType.SEMICOLON)) {
        const statement = this._parse_routine_statement();
        if (!statement) break;

        statements.push(statement);
      }
    }

    return statements;
  }

  /** py:143 */
  _parse_routine_block() {
    this._match(TokenType.BEGIN);
    const statements = this._parse_routine_statements("END");
    statements.push(new exp.EndStatement());

    return this.expression(new exp.Block({ expressions: statements, begin: true }));
  }

  /** py:150 */
  _parse_routine_if() {
    // https://trino.io/docs/current/udf/sql/if.html
    // ELSEIF chains nest into `false` rather than a flat list, reusing the
    // existing binary IfBlock instead of a new N-way expression; each loop
    // iteration links the next branch into the previous one's `false` slot.
    const parse_branch = () => {
      const condition = this._parse_disjunction();
      this._match_text_seq("THEN");
      const true_ = this.expression(new exp.Block({
        expressions: this._parse_routine_statements("ELSEIF", "ELSE", "END"),
      }));
      return this.expression(new exp.IfBlock({ this: condition, true: true_ }));
    };

    const this_ = parse_branch();
    let tail = this_;
    while (pyUpper(this._prev.text) === "ELSEIF") {
      const node = parse_branch();
      tail.set("false", node);
      tail = node;
    }

    if (pyUpper(this._prev.text) === "ELSE") {
      tail.set(
        "false",
        this.expression(new exp.Block({ expressions: this._parse_routine_statements("END") })),
      );
    }

    this._match_text_seq("IF");
    return this_;
  }

  /** py:178 */
  _parse_routine_case() {
    // https://trino.io/docs/current/udf/sql/case.html
    const this_ = this._parse_disjunction();

    const parse_branch = () => {
      const condition = this._parse_disjunction();
      this._match_text_seq("THEN");
      const true_ = this.expression(new exp.Block({
        expressions: this._parse_routine_statements("WHEN", "ELSE", "END"),
      }));
      return this.expression(new exp.If({ this: condition, true: true_ }));
    };

    const ifs = [];
    this._match_text_seq("WHEN");
    while (pyUpper(this._prev.text) === "WHEN") {
      ifs.push(parse_branch());
    }

    let default_ = null;
    if (pyUpper(this._prev.text) === "ELSE") {
      default_ = this.expression(
        new exp.Block({ expressions: this._parse_routine_statements("END") }),
      );
    }

    this._match_text_seq("CASE");
    return this.expression(new exp.CaseStatement({ this: this_, ifs, default: default_ }));
  }

  /** py:202 */
  _parse_routine_while(label = null) {
    // https://trino.io/docs/current/udf/sql/while.html
    const condition = this._parse_disjunction();
    this._match_text_seq("DO");
    const body = this.expression(
      new exp.Block({ expressions: this._parse_routine_statements("END") }),
    );
    this._match_text_seq("WHILE");
    return this.expression(new exp.WhileBlock({ this: condition, body, label }));
  }

  /** py:210 */
  _parse_routine_loop(label = null) {
    // https://trino.io/docs/current/udf/sql/loop.html
    const body = this.expression(
      new exp.Block({ expressions: this._parse_routine_statements("END") }),
    );
    this._match_text_seq("LOOP");
    return this.expression(new exp.LoopBlock({ body, label }));
  }

  /** py:216 */
  _parse_routine_repeat(label = null) {
    // https://trino.io/docs/current/udf/sql/repeat.html - unlike WHILE/LOOP,
    // the body is evaluated at least once, with UNTIL <condition> tested after
    const body = this.expression(
      new exp.Block({ expressions: this._parse_routine_statements("UNTIL") }),
    );
    const until = this._parse_disjunction();
    this._match_text_seq("END", "REPEAT");
    return this.expression(new exp.RepeatBlock({ body, until, label }));
  }

  /** py:224 */
  _parse_routine_statement() {
    // An optional `label :` can precede WHILE, LOOP, or REPEAT to name the block for
    // ITERATE/LEAVE. Any non-reserved keyword (SET, IF, ITERATE etc) is a valid label
    // name, so the colon lookahead has to run first, before the statement keywords
    // are matched.
    let label = null;
    if (this._next.bool() && this._next.token_type === TokenType.COLON) {
      label = this._parse_id_var();
      this._match(TokenType.COLON);
    }

    if (this._match(TokenType.BEGIN, false)) {
      return this._parse_routine_block();
    }

    if (this._match_text_seq("RETURN")) {
      return this.expression(new exp.Return({ this: this._parse_disjunction() }));
    }

    if (this._match_text_seq("IF")) {
      return this._parse_routine_if();
    }

    if (this._match_text_seq("CASE")) {
      return this._parse_routine_case();
    }

    if (this._match(TokenType.DECLARE)) {
      return this._parse_declare();
    }

    if (this._match(TokenType.SET)) {
      return this._parse_set();
    }

    if (this._match_text_seq("ITERATE")) {
      return this.expression(new exp.Iterate({ this: this._parse_id_var() }));
    }

    if (this._match_text_seq("LEAVE")) {
      return this.expression(new exp.Leave({ this: this._parse_id_var() }));
    }

    if (this._match_text_seq("WHILE")) {
      return this._parse_routine_while(label);
    }

    if (this._match_text_seq("LOOP")) {
      return this._parse_routine_loop(label);
    }

    if (this._match_text_seq("REPEAT")) {
      return this._parse_routine_repeat(label);
    }

    this.raise_error("Expected routine statement");
    return null;
  }
}
