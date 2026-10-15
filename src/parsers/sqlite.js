// py: sqlglot/parsers/sqlite.py @ 91119bc — WHOLE FILE (204 LOC), AIR-2291.
//
// `class SQLiteParser(parser.Parser)` — the READ-side SQLite grammar, landing
// alongside `dialects/sqlite.py` (settings) and `generators/sqlite.py` (write side)
// in this same round, PORT_PLAN.md R38's "full stack in one round" shape. SQLite is
// standalone (`extends Parser` directly), same as Presto/MySQL/ClickHouse — no
// subclass chain.

import {
  Parser,
  setDiff,
  setUnion,
  binary_range_parser,
  build_extract_json_with_path,
  build_json_extract,
  build_json_extract_scalar,
} from "../parser.js";
import { TokenType } from "../tokens.js";
import * as exp from "../expressions/index.js";

/** py: sqlglot/parsers/sqlite.py:10 */
function _build_strftime(args) {
  if (args.length === 1) args.push(new exp.CurrentTimestamp());
  if (args.length === 2) {
    return new exp.TimeToStr({
      this: new exp.TsOrDsToTimestamp({ this: args[1] }),
      format: args[0],
    });
  }
  return new exp.Anonymous({ this: "STRFTIME", expressions: args });
}

/** py: sqlglot/parsers/sqlite.py:18 */
function _build_dpipe(self, this_, expression) {
  return self.expression(
    new exp.DPipe({ this: this_, expression, safe: !self.dialect.STRICT_STRING_CONCAT }),
  );
}

/** py: sqlglot/parsers/sqlite.py:26 */
function _build_json_extract(args, dialect) {
  // Single-path json_extract() returns an SQL representation like ->>, except
  // that object/array results keep the JSON subtype (json_subtype); the
  // multi-path form returns a JSON array. https://www.sqlite.org/json1.html#jex
  if (args.length === 2) {
    const extract = build_extract_json_with_path(exp.JSONExtractScalar)(args, dialect);
    extract.set("json_subtype", true);
    return extract;
  }
  return build_extract_json_with_path(exp.JSONExtract)(args, dialect);
}

/** py: sqlglot/parsers/sqlite.py:37 */
export class SQLiteParser extends Parser {
  static STRING_ALIASES = true;
  static ALTER_RENAME_REQUIRES_COLUMN = false;
  static JOINS_HAVE_EQUAL_PRECEDENCE = true;
  static ADD_JOIN_ON_TRUE = true;

  /** py:43-46 `parser.Parser.TABLE_ALIAS_TOKENS | {TokenType.ANTI, TokenType.SEMI}`. */
  static TABLE_ALIAS_TOKENS = setUnion(Parser.TABLE_ALIAS_TOKENS, new Set([TokenType.ANTI, TokenType.SEMI]));

  /** py:48-52 */
  static COLUMN_OPERATORS = new Map(
    [...Parser.COLUMN_OPERATORS].filter(([k]) => k !== TokenType.ARROW && k !== TokenType.DARROW),
  );

  /**
   * py:57-61
   *
   * ||, -> and ->> form a single left-associative precedence tier that binds tighter
   * than multiplication, so it's consumed in _parse_factor_operand rather than in
   * _parse_bitwise: https://sqlite.org/lang_expr.html
   */
  static CONCAT_OPERATORS = new Map([
    [TokenType.DPIPE, _build_dpipe],
    [TokenType.ARROW, build_json_extract],
    [TokenType.DARROW, build_json_extract_scalar],
  ]);

  /** py:63-67 */
  static ARITHMETIC_TOKENS = setDiff(
    setUnion(setUnion(new Set(Parser.BITWISE.keys()), new Set(Parser.TERM.keys())), new Set(Parser.FACTOR.keys())),
    new Set([TokenType.COLLATE]),
  );

  /** py:69-79 */
  static FUNCTIONS = new Map([
    ...Parser.FUNCTIONS,
    ["DATETIME", (args) => new exp.Anonymous({ this: "DATETIME", expressions: args })],
    ["EDITDIST3", exp.Levenshtein.from_arg_list],
    ["JSON_EXTRACT", _build_json_extract],
    ["JSON_GROUP_ARRAY", exp.JSONArrayAgg.from_arg_list],
    ["JSON_GROUP_OBJECT", (args) => new exp.JSONObjectAgg({ expressions: args })],
    ["STRFTIME", _build_strftime],
    ["SQLITE_VERSION", exp.CurrentVersion.from_arg_list],
    ["TIME", (args) => new exp.Anonymous({ this: "TIME", expressions: args })],
  ]);

  /** py:81-85 */
  static PROPERTY_PARSERS = new Map([
    ...Parser.PROPERTY_PARSERS,
    ["USING", (self) => self._parse_module_property()],
    ["VIRTUAL", (self) => self.expression(new exp.VirtualProperty())],
  ]);

  /** py:87-92 */
  static STATEMENT_PARSERS = new Map([
    ...Parser.STATEMENT_PARSERS,
    [TokenType.ATTACH, (self) => self._parse_attach_detach()],
    [TokenType.DETACH, (self) => self._parse_attach_detach(false)],
    [TokenType.PRAGMA, (self) => self._parse_pragma()],
  ]);

  /** py:94-98 */
  static RANGE_PARSERS = new Map([
    ...Parser.RANGE_PARSERS,
    // https://www.sqlite.org/lang_expr.html
    [TokenType.MATCH, binary_range_parser(exp.Match)],
  ]);

  /** py:100-123 */
  _parse_factor_operand() {
    const in_arithmetic_operand = this.constructor.ARITHMETIC_TOKENS.has(this._prev.token_type);
    let this_ = this._parse_concat_operand();
    let parsed_op = false;

    let build;
    while (this._curr && (build = this.constructor.CONCAT_OPERATORS.get(this._curr.token_type))) {
      if (this._curr.token_type !== TokenType.DPIPE && this_ instanceof exp.DPipe) {
        // Parenthesize so that dialects where the arrows bind tighter
        // than || still produce the same, left-associative grouping
        this_ = this.expression(new exp.Paren({ this: this_ }));
      }

      this._advance();
      this_ = build(this, this_, this._parse_concat_operand());
      parsed_op = true;
    }

    if (
      parsed_op &&
      (in_arithmetic_operand || (this._curr && this.constructor.ARITHMETIC_TOKENS.has(this._curr.token_type)))
    ) {
      // This tier binds tighter than arithmetic in SQLite but looser elsewhere,
      // so parenthesize it to preserve the grouping in other dialects
      this_ = this.expression(new exp.Paren({ this: this_ }));
    }

    return this_;
  }

  /** py:125-134 */
  _parse_concat_operand() {
    let this_ = this._parse_unary();

    // COLLATE binds tighter than any binary operator, including this tier
    while (this._match(TokenType.COLLATE)) {
      const collate = this.expression(new exp.Collate({ this: this_, expression: this._parse_unary() }));
      this._normalize_collate(collate);
      this_ = collate;
    }

    return this_;
  }

  /** py:136-142 */
  _parse_unique() {
    // Do not consume more tokens if UNIQUE is used as a standalone constraint, e.g:
    // CREATE TABLE foo (bar TEXT UNIQUE REFERENCES baz ...)
    if (this.constructor.CONSTRAINT_PARSERS.has(this._curr.text.toUpperCase())) {
      return this.expression(new exp.UniqueColumnConstraint());
    }

    return super._parse_unique();
  }

  /** py:144-151 */
  _parse_module_property() {
    const name = this._parse_id_var();
    const expressions = this._match(TokenType.L_PAREN, false)
      ? this._parse_wrapped_csv(() => this._parse_id_var())
      : null;
    return this.expression(new exp.ModuleProperty({ this: name, expressions }));
  }

  /** py:153-168 */
  _parse_pragma() {
    let name = this._parse_var(true);

    if (this._match(TokenType.DOT)) {
      name = new exp.Dot({ this: name, expression: this._parse_var(true) });
    }

    this._match(TokenType.EQ);

    const value = this._parse_wrapped(() => this._parse_unary() || this._parse_var(true), true);

    if (value) {
      return this.expression(new exp.Pragma({ this: new exp.EQ({ this: name, expression: value }) }));
    }

    return this.expression(new exp.Pragma({ this: name }));
  }

  /** py:170-178 */
  _parse_attach_detach(is_attach = true) {
    this._match(TokenType.DATABASE);
    const this_ = this._parse_expression();

    return is_attach
      ? this.expression(new exp.Attach({ this: this_ }))
      : this.expression(new exp.Detach({ this: this_ }));
  }

  /** py:180-204. https://www.sqlite.org/gencol.html */
  _parse_generated_as_identity() {
    const this_ = super._parse_generated_as_identity();

    // Only expression-bearing GENERATED ALWAYS AS (expr) forms are computed
    // columns. Match STORED/VIRTUAL inside this branch so true identity
    // (AS IDENTITY) does not silently consume a trailing storage keyword.
    if (this_ instanceof exp.GeneratedAsIdentityColumnConstraint && this_.expression !== null && this_.expression !== undefined) {
      const persisted = this._match_texts(["STORED", "VIRTUAL"]) && this._prev.text.toUpperCase() === "STORED";
      return this.expression(new exp.ComputedColumnConstraint({ this: this_.expression, persisted }));
    }

    return this_;
  }
}
