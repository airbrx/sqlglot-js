// py: sqlglot/parsers/materialize.py @ 91119bc
//
// `class MaterializeParser(PostgresParser)` — small and self-contained, extending the
// already-real `PostgresParser` (src/parsers/postgres.js) at a single link, the same
// shape `parsers/redshift.js` uses for `RedshiftParser(PostgresParser)`.
// `sqlglot/dialects/materialize.py` (the `Materialize(Postgres)` SETTINGS class) and
// `sqlglot/generators/materialize.py` stay separate files, the same split every prior
// dialect port used. AIR-2292, "12.7 Small dialects", batch A. No
// `sqlglot/typing/materialize.py` exists upstream.

import * as exp from "../expressions/index.js";
import { seqGet } from "../helper.js";
import { PostgresParser } from "./postgres.js";
import { TokenType } from "../tokens.js";

/** py: sqlglot/parsers/materialize.py:10 */
export class MaterializeParser extends PostgresParser {
  /* py:11 */ static TYPED_LAMBDA_ARGS = true;

  /** py: sqlglot/parsers/materialize.py:13 */
  static NO_PAREN_FUNCTION_PARSERS = new Map([
    /* py:14 */ ...PostgresParser.NO_PAREN_FUNCTION_PARSERS,
    /* py:15 */ ["MAP", (self) => self._parse_map()],
  ]);

  /** py: sqlglot/parsers/materialize.py:18 */
  static LAMBDAS = new Map([
    /* py:19 */ ...PostgresParser.LAMBDAS,
    /* py:20 */ [TokenType.FARROW, (self, expressions) => self.expression(new exp.Kwarg({
      this: seqGet(expressions, 0),
      expression: self._parse_assignment(),
    }))],
  ]);

  /** py: sqlglot/parsers/materialize.py:25 */
  _parse_lambda_arg() {
    return this._parse_field();
  }

  /** py: sqlglot/parsers/materialize.py:28 */
  _parse_map() {
    if (this._match(TokenType.L_PAREN)) {
      const to_map = this.expression(new exp.ToMap({ this: this._parse_select() }));
      this._match_r_paren();
      return to_map;
    }

    if (!this._match(TokenType.L_BRACKET)) {
      this.raise_error("Expecting [");
    }

    const entries = this._parse_csv(() => this._parse_lambda()).map((e) => new exp.PropertyEQ({
      this: e.this,
      expression: e.expression,
    }));

    if (!this._match(TokenType.R_BRACKET)) {
      this.raise_error("Expecting ]");
    }

    return this.expression(new exp.ToMap({ this: this.expression(new exp.Struct({ expressions: entries })) }));
  }
}
