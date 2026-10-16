// py: sqlglot/parsers/dax.py @ 91119bc — WHOLE FILE (48 LOC), AIR-2292 (epic
// AIR-2272, "12.7 Small dialects", batch B).
//
// `class DAXParser(parser.Parser)` — the READ-side DAX grammar (Microsoft's
// Power BI / Analysis Services query language). Lands in the same round as
// `dialects/dax.py` (`src/dialects/dax.js`) and `generators/dax.py`
// (`src/generators/dax.js`). Self-contained: extends the base `Parser` directly.

import { Parser } from "../parser.js";
import { TokenType } from "../tokens.js";
import * as exp from "../expressions/index.js";

/** py: sqlglot/parsers/dax.py:8 `class DAXParser(parser.Parser)`. */
export class DAXParser extends Parser {
  /** py:9 */
  static CONJUNCTION = new Map([
    ...Parser.CONJUNCTION,
    [TokenType.DAMP, exp.And],
  ]);

  /** py:14 */
  static DISJUNCTION = new Map([
    ...Parser.DISJUNCTION,
    [TokenType.DPIPE, exp.Or],
  ]);

  /** py:19 `_parse_statement(self) -> exp.Expr | None`. */
  _parse_statement() {
    if (!this._match_text_seq("EVALUATE")) return null;

    let query = this._parse_table_expression();

    if (query && this._match(TokenType.ORDER_BY)) {
      const order = new exp.Order({ expressions: this._parse_csv(() => this._parse_ordered()) });
      query = query.order_by(this.expression(order), { copy: false });
    }

    return query;
  }

  /** py:29 `_parse_table_expression(self) -> exp.Query | None`. */
  _parse_table_expression() {
    if (this._match_pair(TokenType.FILTER, TokenType.L_PAREN)) {
      const query = this._parse_table_expression();
      this._match(TokenType.COMMA);
      const where = this._parse_disjunction();
      this._match_r_paren();
      return query ? query.where(where, { copy: false }) : null;
    }

    const table = this._parse_table_parts();
    return table ? exp.select("*").from_(table, { copy: false }) : null;
  }

  /** py:39 `_parse_column(self) -> exp.Expr | None`. */
  _parse_column() {
    let this_ = super._parse_column();

    // py:43-44 Combine adjacent identifiers into a column reference: Table[Column].
    // `self._parse_identifier()` must only run when `this` IS an exp.Column — Python's
    // `and` short-circuits on the walrus, and calling it unconditionally would consume
    // an identifier token even when the left side wasn't a Column.
    if (this_ instanceof exp.Column) {
      const column = this._parse_identifier();
      if (column) this_ = this.expression(new exp.Column({ this: column, table: this_.this }));
    }

    return this_;
  }
}
