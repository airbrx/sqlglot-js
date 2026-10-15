// py: sqlglot/parsers/risingwave.py @ 91119bc
//
// `class RisingWaveParser(PostgresParser)` — small and self-contained, extending the
// already-real `PostgresParser` (src/parsers/postgres.js) at a single link, the same
// shape `parsers/redshift.js`/`parsers/materialize.js` use. AIR-2292, "12.7 Small
// dialects", batch A. No `sqlglot/typing/risingwave.py` exists upstream.

import * as exp from "../expressions/index.js";
import { PostgresParser } from "./postgres.js";
import { TokenType } from "../tokens.js";

/** py: sqlglot/parsers/risingwave.py:9 */
export class RisingWaveParser extends PostgresParser {
  /* py:10 */ static WRAPPED_TRANSFORM_COLUMN_CONSTRAINT = false;

  /** py: sqlglot/parsers/risingwave.py:12 */
  static PROPERTY_PARSERS = new Map([
    /* py:13 */ ...PostgresParser.PROPERTY_PARSERS,
    /* py:14 */ ["ENCODE", (self) => self._parse_encode_property()],
    /* py:15 */ ["INCLUDE", (self) => self._parse_include_property()],
    /* py:16 */ ["KEY", (self) => self._parse_encode_property(true)],
  ]);

  /** py: sqlglot/parsers/risingwave.py:19 */
  static CONSTRAINT_PARSERS = new Map([
    /* py:20 */ ...PostgresParser.CONSTRAINT_PARSERS,
    /* py:21 */ ["WATERMARK", (self) => self.expression(new exp.WatermarkColumnConstraint({
      this: self._match(TokenType.FOR) && self._parse_column(),
      expression: self._match(TokenType.ALIAS) && self._parse_disjunction(),
    }))],
  ]);

  /** py: sqlglot/parsers/risingwave.py:29 */
  static SCHEMA_UNNAMED_CONSTRAINTS = new Set([
    /* py:30 */ ...PostgresParser.SCHEMA_UNNAMED_CONSTRAINTS,
    /* py:31 */ "WATERMARK",
  ]);

  /**
   * py: sqlglot/parsers/risingwave.py:34
   *
   * There is no hint in risingwave. Do nothing here to avoid WITH keywords conflict
   * in CREATE SINK statement.
   */
  _parse_table_hints() {
    return null;
  }

  /** py: sqlglot/parsers/risingwave.py:39 */
  _parse_include_property() {
    let header = null;
    let coldef = null;

    const this_ = this._parse_var_or_string();

    if (!this._match(TokenType.ALIAS)) {
      header = this._parse_field();
      if (header) {
        coldef = this.expression(new exp.ColumnDef({ this: header, kind: this._parse_types() }));
      }
    }

    this._match(TokenType.ALIAS);
    const alias = this._parse_id_var(true, this.constructor.ALIAS_TOKENS);

    return this.expression(new exp.IncludeProperty({ this: this_, alias, column_def: coldef }));
  }

  /** py: sqlglot/parsers/risingwave.py:55 */
  _parse_encode_property(key = null) {
    this._match_text_seq("ENCODE");
    const this_ = this._parse_var_or_string();

    let properties;
    if (this._match(TokenType.L_PAREN, false)) {
      properties = this.expression(new exp.Properties({ expressions: this._parse_wrapped_properties() }));
    } else {
      properties = null;
    }

    return this.expression(new exp.EncodeProperty({ this: this_, properties, key }));
  }
}
