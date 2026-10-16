// py: sqlglot/parsers/prql.py @ 91119bc — WHOLE FILE (194 LOC), AIR-2292 (epic
// AIR-2272, "12.7 Small dialects", batch B).
//
// `class PRQLParser(parser.Parser)` — the READ-side PRQL grammar. PRQL (Pipelined
// Relational Query Language, https://prql-lang.org) is NOT SQL: a query is a
// `FROM table | TRANSFORM | TRANSFORM | ...` pipeline, where each `TRANSFORM`
// (DERIVE/SELECT/TAKE/FILTER/APPEND/REMOVE/INTERSECT/SORT/AGGREGATE) rewrites the
// `exp.Select` built so far. The whole grammar reduces to building one SQL
// `exp.Select` tree by replaying the pipeline left to right, so no PRQL-specific
// Expression classes are needed — only this Parser and a near-empty Generator
// (`generators/prql.py`, 7 LOC, ported alongside in `src/generators/prql.js`).
// `dialects/prql.py` (32 LOC, `src/dialects/prql.js`) lands in the same round.
// Self-contained: extends the base `Parser` directly.

import { Parser } from "../parser.js";
import { TokenType } from "../tokens.js";
import { seqGet } from "../helper.js";
import * as exp from "../expressions/index.js";
import { func } from "../expressions/builders.js";
import { pyUpper } from "../_py/str.js";

/** py: sqlglot/parsers/prql.py:11 `_select_all(table)`. */
function _select_all(table) {
  return table ? exp.select("*").from_(table, { copy: false }) : null;
}

/** py: sqlglot/parsers/prql.py:15 `_resolve_projection(s, projections)`. */
function _resolve_projection(s, projections) {
  if (s instanceof exp.Column && Object.hasOwn(projections, s.name)) {
    return projections[s.name].copy();
  }
  return s;
}

/** py: sqlglot/parsers/prql.py:21 `class PRQLParser(parser.Parser)`. */
export class PRQLParser extends Parser {
  /** py:22 */
  static CONJUNCTION = new Map([
    ...Parser.CONJUNCTION,
    [TokenType.DAMP, exp.And],
  ]);

  /** py:27 */
  static DISJUNCTION = new Map([
    ...Parser.DISJUNCTION,
    [TokenType.DPIPE, exp.Or],
  ]);

  /** py:32 `TRANSFORM_PARSERS: t.ClassVar`. */
  static TRANSFORM_PARSERS = new Map([
    ["DERIVE", (self, query) => self._parse_selection(query)],
    ["SELECT", (self, query) => self._parse_selection(query, null, false)],
    ["TAKE", (self, query) => self._parse_take(query)],
    ["FILTER", (self, query) => query.where(self._parse_disjunction())],
    ["APPEND", (self, query) => query.union(_select_all(self._parse_table()), { distinct: false, copy: false })],
    ["REMOVE", (self, query) => query.except_(_select_all(self._parse_table()), { distinct: false, copy: false })],
    ["INTERSECT", (self, query) => query.intersect(_select_all(self._parse_table()), { distinct: false, copy: false })],
    ["SORT", (self, query) => self._parse_order_by(query)],
    ["AGGREGATE", (self, query) => self._parse_selection(query, (...a) => self._parse_aggregate(...a), false)],
  ]);

  /** py:52 */
  static FUNCTIONS = new Map([
    ...Parser.FUNCTIONS,
    ["AVERAGE", exp.Avg.from_arg_list],
    ["SUM", (args) => func("COALESCE", new exp.Sum({ this: seqGet(args, 0) }), 0)],
  ]);

  /** py:58 `_parse_equality(self) -> exp.Expr | None`. */
  _parse_equality() {
    let eq = this._parse_comparison();
    while (this._match_set(this.constructor.EQUALITY)) {
      const comments = this._prev_comments;
      const K = this.constructor.EQUALITY.get(this._prev.token_type);
      eq = this.expression(new K({ this: eq, expression: this._parse_comparison() }), null, comments);
    }
    if (!(eq instanceof exp.EQ) && !(eq instanceof exp.NEQ)) return eq;

    // https://prql-lang.org/book/reference/spec/null.html
    if (eq.expression instanceof exp.Null) {
      const is_exp = new exp.Is({ this: eq.this, expression: eq.expression });
      return eq instanceof exp.EQ ? is_exp : new exp.Not({ this: is_exp });
    }
    if (eq.this instanceof exp.Null) {
      const is_exp = new exp.Is({ this: eq.expression, expression: eq.this });
      return eq instanceof exp.EQ ? is_exp : new exp.Not({ this: is_exp });
    }
    return eq;
  }

  /** py:78 `_parse_statement(self) -> exp.Expr | None`. */
  _parse_statement() {
    let expression = this._parse_expression();
    expression = expression || this._parse_query();
    return expression;
  }

  /** py:83 `_parse_query(self) -> exp.Query | None`. */
  _parse_query() {
    const from_ = this._parse_from();

    if (!from_) return null;

    let query = exp.select("*").from_(from_, { copy: false });

    while (this._match_texts(this.constructor.TRANSFORM_PARSERS)) {
      query = this.constructor.TRANSFORM_PARSERS.get(pyUpper(this._prev.text))(this, query);
    }

    return query;
  }

  /** py:96 `_parse_selection(self, query, parse_method=None, append=True) -> exp.Query`. */
  _parse_selection(query, parse_method = null, append = true) {
    parse_method = parse_method || (() => this._parse_expression());
    let selects;
    if (this._match(TokenType.L_BRACE)) {
      selects = this._parse_csv(parse_method);

      if (!this._match(TokenType.R_BRACE, true, query)) this.raise_error("Expecting }");
    } else {
      const expression = parse_method();
      selects = expression ? [expression] : [];
    }

    const projections = {};
    for (const select of query.selects) {
      // py: `select.alias_or_name` -- the port's property for this is `aliasOrName`
      // (camelCase); every other call site in this codebase uses that spelling.
      projections[select.aliasOrName] = select instanceof exp.Alias ? select.this : select;
    }

    const resolved = selects.map((select) => select.transform(_resolve_projection, projections, { copy: false }));

    return query.select(...resolved, { append, copy: false });
  }

  /** py:124 `_parse_take(self, query) -> exp.Query | None`. */
  _parse_take(query) {
    // TODO: TAKE for ranges a..b
    const num = this._parse_number();
    return num ? query.limit(num) : null;
  }

  /** py:128 `_parse_ordered(self, parse_method=None) -> exp.Ordered | None`. */
  _parse_ordered(parse_method = null) {
    const asc = this._match(TokenType.PLUS);
    const desc = this._match(TokenType.DASH) || (asc && false);
    const term = super._parse_ordered(parse_method);
    if (term && desc) {
      term.set("desc", true);
      term.set("nulls_first", false);
    }
    return term;
  }

  /** py:137 `_parse_order_by(self, query) -> exp.Query | None`. */
  _parse_order_by(query) {
    const l_brace = this._match(TokenType.L_BRACE);
    const expressions = this._parse_csv(() => this._parse_ordered());
    if (l_brace && !this._match(TokenType.R_BRACE)) this.raise_error("Expecting }");
    return query.order_by(this.expression(new exp.Order({ expressions })), { copy: false });
  }

  /** py:144 `_parse_aggregate(self) -> exp.Expr | None`. */
  _parse_aggregate() {
    let alias = null;
    if (this._next.token_type === TokenType.ALIAS) {
      alias = this._parse_id_var(true);
      this._match(TokenType.ALIAS);
    }

    const name = pyUpper(this._curr.text);
    const func_builder = this.constructor.FUNCTIONS.get(name);
    let func_;
    if (func_builder) {
      this._advance();
      const args = this._parse_column();
      func_ = func_builder([args]);
    } else {
      this.raise_error(`Unsupported aggregation function ${name}`);
    }
    if (alias) return this.expression(new exp.Alias({ this: func_, alias }));
    return func_;
  }

  /** py:162 `_parse_expression(self) -> exp.Expr | None`. */
  _parse_expression() {
    if (this._next.token_type === TokenType.ALIAS) {
      const alias = this._parse_id_var(true);
      this._match(TokenType.ALIAS);
      return this.expression(new exp.Alias({ this: this._parse_assignment(), alias }));
    }
    return this._parse_assignment();
  }

  /** py:169 `_parse_table(self, ...) -> exp.Expr | None`. */
  _parse_table(
    schema = false,
    joins = false,
    alias_tokens = null,
    parse_bracket = false,
    is_db_reference = false,
    parse_partition = false,
    consume_pipe = false,
  ) {
    return this._parse_table_parts();
  }

  /** py:181 `_parse_from(self, ...) -> exp.From | None`. */
  _parse_from(joins = false, skip_from_token = false, consume_pipe = false) {
    if (!skip_from_token && !this._match(TokenType.FROM)) return null;

    const comments = this._prev_comments;
    return this.expression(new exp.From({ this: this._parse_table(false, joins) }), null, comments);
  }
}
