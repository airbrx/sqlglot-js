// py: sqlglot/parsers/redshift.py @ 91119bc
//
// `class RedshiftParser(PostgresParser)` — small and self-contained, extending the
// already-real `PostgresParser` (src/parsers/postgres.js) at a single link, the way
// PORT_PLAN.md's Databricks-chain precedent extends Hive but with just one `extends`
// instead of four. `sqlglot/dialects/redshift.py` (the `Redshift(Postgres)` SETTINGS
// class) and `sqlglot/generators/redshift.py` stay separate P5/P4 files, the same
// split every prior dialect port used.

import { PostgresParser } from "./postgres.js";
import { build_convert_timezone } from "../parser.js";
import { TokenType } from "../tokens.js";
import { seqGet } from "../helper.js";
import { map_date_part } from "../dialects/dialect.js";
import * as exp from "../expressions/index.js";

/** py: sqlglot/parsers/redshift.py:18 */
function _build_date_delta(expr_type) {
  return (args) => {
    const expr = new expr_type({
      this: seqGet(args, 2),
      expression: seqGet(args, 1),
      unit: map_date_part(seqGet(args, 0)),
    });
    if (expr_type === exp.TsOrDsAdd) {
      expr.set("return_type", exp.DType.TIMESTAMP.into_expr());
    }

    return expr;
  };
}

/** py: sqlglot/parsers/redshift.py:33 */
export class RedshiftParser extends PostgresParser {
  // py:35 `{**{k: v for k, v in PostgresParser.FUNCTIONS.items() if k != "GET_BIT"}, ...}`
  /** py: sqlglot/parsers/redshift.py:34 */
  static FUNCTIONS = new Map([
    /* py:35 */ ...[...PostgresParser.FUNCTIONS].filter(([k]) => k !== "GET_BIT"),
    /* py:36 */ ["ADD_MONTHS", (args) => new exp.TsOrDsAdd({
      this: seqGet(args, 0),
      expression: seqGet(args, 1),
      unit: exp.var("month"),
      return_type: exp.DType.TIMESTAMP.into_expr(),
    })],
    /* py:42 */ ["CONVERT_TIMEZONE", (args) => build_convert_timezone(args, "UTC")],
    /* py:43 */ ["DATEADD", _build_date_delta(exp.TsOrDsAdd)],
    /* py:44 */ ["DATE_ADD", _build_date_delta(exp.TsOrDsAdd)],
    /* py:45 */ ["DATEDIFF", _build_date_delta(exp.TsOrDsDiff)],
    /* py:46 */ ["DATE_DIFF", _build_date_delta(exp.TsOrDsDiff)],
    /* py:47 */ ["GETDATE", exp.CurrentTimestamp.from_arg_list],
    /* py:48 */ ["LISTAGG", exp.GroupConcat.from_arg_list],
    /* py:49 */ ["REGEXP_SUBSTR", (args) => new exp.RegexpExtract({
      this: seqGet(args, 0),
      expression: seqGet(args, 1),
      position: seqGet(args, 2),
      occurrence: seqGet(args, 3),
      parameters: seqGet(args, 4),
    })],
    /* py:56 */ ["SPLIT_TO_ARRAY", (args) => new exp.StringToArray({
      this: seqGet(args, 0), expression: seqGet(args, 1) || exp.Literal.string(","),
    })],
    /* py:59 */ ["ARRAY_CONTAINS", (args) => new exp.ArrayContains({
      this: seqGet(args, 0),
      expression: seqGet(args, 1),
      check_null: seqGet(args, 2),
    })],
    /* py:64 */ ["STRTOL", exp.FromBase.from_arg_list],
    /* py:65 */ ["TEXTLEN", exp.Length.from_arg_list],
  ]);

  /** py: sqlglot/parsers/redshift.py:68 */
  static NO_PAREN_FUNCTIONS = new Map([
    /* py:69 */ ...PostgresParser.NO_PAREN_FUNCTIONS,
    /* py:70 */ [TokenType.CURRENT_USER_ID, exp.CurrentUserId],
  ]);

  /** py: sqlglot/parsers/redshift.py:73 */
  static NO_PAREN_FUNCTION_PARSERS = new Map([
    /* py:74 */ ...PostgresParser.NO_PAREN_FUNCTION_PARSERS,
    /* py:75 */ ["APPROXIMATE", (self) => self._parse_approximate_count()],
    /* py:76 */ ["SYSDATE", (self) => self.expression(new exp.CurrentTimestamp({ sysdate: true }))],
  ]);

  /** py: sqlglot/parsers/redshift.py:79 */
  static FUNCTION_PARSERS = new Map([
    /* py:80 */ ...PostgresParser.FUNCTION_PARSERS,
    /* py:81 */ ["OBJECT_TRANSFORM", (self) => self._parse_object_transform()],
  ]);

  /* py:84 */ static SUPPORTS_IMPLICIT_UNNEST = true;

  /** py: sqlglot/parsers/redshift.py:86 */
  _parse_table(
    schema = false,
    joins = false,
    alias_tokens = null,
    parse_bracket = false,
    is_db_reference = false,
    parse_partition = false,
    consume_pipe = false,
  ) {
    // Redshift supports UNPIVOTing SUPER objects, e.g. `UNPIVOT foo.obj[0] AS val AT attr`
    const unpivot = this._match(TokenType.UNPIVOT);
    const table = super._parse_table(schema, joins, alias_tokens, parse_bracket, is_db_reference);

    return unpivot ? this.expression(new exp.Pivot({ this: table, unpivot: true })) : table;
  }

  /** py: sqlglot/parsers/redshift.py:108 */
  _parse_convert(strict, safe = null) {
    const to = this._parse_types();
    this._match(TokenType.COMMA);
    const this_ = this._parse_bitwise();
    return this.expression(new exp.Cast({ this: this_, to, safe }));
  }

  /** py: sqlglot/parsers/redshift.py:114 */
  _parse_object_transform() {
    const this_ = this._parse_column();
    let keep = [];
    let set_ = [];
    if (this._match(TokenType.KEEP)) {
      keep = this._parse_csv(() => this._parse_primary());
    }
    if (this._match(TokenType.SET)) {
      set_ = this._parse_csv(() => this._parse_expression());
    }
    return this.expression(new exp.ObjectTransform({ this: this_, keep, set_ }));
  }

  /** py: sqlglot/parsers/redshift.py:124 */
  _parse_approximate_count() {
    const index = this._index - 1;
    const func = this._parse_function();

    if (func instanceof exp.Count && func.this instanceof exp.Distinct) {
      return this.expression(new exp.ApproxDistinct({ this: seqGet(func.this.expressions, 0) }));
    }
    if (func instanceof exp.WithinGroup && func.this instanceof exp.PercentileDisc) {
      const ordered = seqGet(func.expression.expressions, 0);
      return this.expression(new exp.ApproxQuantile({
        this: ordered ? ordered.this : null,
        quantile: func.this.this,
      }));
    }
    this._retreat(index);
    return null;
  }

  /**
   * py: sqlglot/parsers/redshift.py:141
   *
   * EXCLUDE clause always comes at the end of the projection list and applies to it as
   * a whole.
   */
  _parse_projections() {
    const [projections] = super._parse_projections();
    if (this._prev.text.toUpperCase() === "EXCLUDE" && this._curr) {
      this._retreat(this._index - 1);
    }

    const exclude = this._match_text_seq("EXCLUDE")
      ? this._parse_wrapped_csv(() => this._parse_expression(), TokenType.COMMA, true)
      : [];

    if (
      exclude.length &&
      projections[projections.length - 1] instanceof exp.Alias &&
      projections[projections.length - 1].alias.toUpperCase() === "EXCLUDE"
    ) {
      projections[projections.length - 1] = projections[projections.length - 1].this.pop();
    }

    return [projections, exclude];
  }
}
