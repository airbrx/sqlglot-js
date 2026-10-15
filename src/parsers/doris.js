// py: sqlglot/parsers/doris.py @ 91119bc — WHOLE FILE (135 LOC), AIR-2286 (epic
// AIR-2272, "12.1 MySQL family" part 2: starrocks + doris, children of R104's
// `MySQLParser`).
//
// `class DorisParser(MySQLParser)` — extends the MySQL parser (`src/parsers/
// mysql.js`) directly, the same link closing `dialects/doris.py`'s `Parser =
// DorisParser` wiring point. `sqlglot/dialects/doris.py` (settings) and
// `sqlglot/generators/doris.py` (write side) stay separate files, same split every
// prior dialect uses.

import { Parser } from "../parser.js";
import { TokenType } from "../tokens.js";
import { seqGet } from "../helper.js";
import { pyIsDigit } from "../_py/str.js";
import { pyTruthy } from "../_py/truthy.js";
import { build_date_delta_with_interval } from "../dialects/dialect.js";
import * as exp from "../expressions/index.js";
import { MySQLParser } from "./mysql.js";

/** py: sqlglot/parsers/doris.py:11-24 — accept both DATE_TRUNC(datetime, unit) and DATE_TRUNC(unit, datetime). */
function _is_unit_like(e) {
  if (!(e instanceof exp.Literal && e.is_string)) return false;
  const text = e.this;
  for (const ch of text) {
    if (pyIsDigit(ch)) return false;
  }
  return true;
}

/** py: sqlglot/parsers/doris.py:12 */
function _build_date_trunc(args) {
  const a0 = seqGet(args, 0);
  const a1 = seqGet(args, 1);

  // Determine which argument is the unit
  const [unit, this_] = _is_unit_like(a0) ? [a0, a1] : [a1, a0];

  return new exp.TimestampTrunc({ this: this_, unit });
}

/** py: sqlglot/parsers/doris.py:27 */
export class DorisParser extends MySQLParser {
  /** py:28 */
  static FUNCTIONS = new Map([
    ...MySQLParser.FUNCTIONS,
    ["ADDDATE", build_date_delta_with_interval(exp.DateAdd, "DAY")],
    ["COLLECT_SET", exp.ArrayUniqueAgg.from_arg_list],
    ["DATE_ADD", build_date_delta_with_interval(exp.DateAdd, "DAY")],
    ["DATE_SUB", build_date_delta_with_interval(exp.DateSub, "DAY")],
    ["DATE_TRUNC", _build_date_trunc],
    ["L2_DISTANCE", exp.EuclideanDistance.from_arg_list],
    ["MONTHS_ADD", exp.AddMonths.from_arg_list],
    ["REGEXP", exp.RegexpLike.from_arg_list],
    ["SUBDATE", build_date_delta_with_interval(exp.DateSub, "DAY")],
    ["TO_DATE", exp.TsOrDsToDate.from_arg_list],
  ]);

  /** py:42 */
  static FUNCTION_PARSERS = new Map(
    [...MySQLParser.FUNCTION_PARSERS].filter(([k]) => k !== "GROUP_CONCAT"),
  );

  /** py:46 */
  static NO_PAREN_FUNCTIONS = new Map(
    [...MySQLParser.NO_PAREN_FUNCTIONS].filter(([k]) => k !== TokenType.CURRENT_DATE),
  );

  /** py:50 */
  static PROPERTY_PARSERS = new Map([
    ...MySQLParser.PROPERTY_PARSERS,
    ["PROPERTIES", (self) => self._parse_wrapped_properties()],
    ["UNIQUE", (self) => self._parse_composite_key_property(exp.UniqueKeyProperty)],
    // Plain KEY without UNIQUE/DUPLICATE/AGGREGATE prefixes should be treated as
    // UniqueKeyProperty with unique=False
    ["KEY", (self) => self._parse_composite_key_property(exp.UniqueKeyProperty)],
    ["BUILD", (self) => self._parse_build_property()],
    ["REFRESH", (self) => self._parse_refresh_property()],
  ]);

  /** py:60 */
  _parse_partition_property() {
    const expr = super._parse_partition_property();

    if (!pyTruthy(expr)) return this._parse_partitioned_by();

    if (expr instanceof exp.Property) return expr;

    this._match_l_paren();

    const create_expressions = this._match_text_seq("FROM", { advance: false })
      ? this._parse_csv(() => this._parse_partitioning_granularity_dynamic())
      : null;

    this._match_r_paren();

    return this.expression(new exp.PartitionByRangeProperty({
      partition_expressions: expr, create_expressions,
    }));
  }

  /** py:86 */
  _parse_partitioning_granularity_dynamic() {
    this._match_text_seq("FROM");
    const start = this._parse_wrapped(() => this._parse_string());
    this._match_text_seq("TO");
    const end = this._parse_wrapped(() => this._parse_string());
    this._match_text_seq("INTERVAL");
    const number = this._parse_number();
    const unit = this._parse_var(true);
    const every = this.expression(new exp.Interval({ this: number, unit }));
    return this.expression(new exp.PartitionByRangePropertyDynamic({ start, end, every }));
  }

  /** py:99 */
  _parse_partition_range_value() {
    const expr = super._parse_partition_range_value();

    if (expr instanceof exp.Partition) return expr;

    this._match_text_seq("VALUES");
    const name = expr;

    // Doris-specific bracket syntax: VALUES [(...), (...))
    this._match(TokenType.L_BRACKET);
    const values = this._parse_csv(() => this._parse_wrapped_csv(() => this._parse_expression()));

    this._match(TokenType.R_BRACKET);
    this._match(TokenType.R_PAREN);

    const part_range = this.expression(new exp.PartitionRange({ this: name, expressions: values }));
    return this.expression(new exp.Partition({ expressions: [part_range] }));
  }

  /** py:118 */
  _parse_build_property() {
    return this.expression(new exp.BuildProperty({ this: this._parse_var(false, null, true) }));
  }

  /**
   * py:121
   *
   * `self._match_texts(...) and self._prev.text.upper()` / `self._match_text_seq(...)
   * and self._parse_...()` — Python's `and` returns the literal `False` on no match
   * (the first falsy operand), not `None`. The AST-coverage oracle dumps the raw arg
   * value, so `kind`/`every`/`starts` below must be `false`, not `null`, on the
   * no-match path to byte-match (PORT_PLAN.md starrocks.js's own `_parse_refresh_
   * property` hits the identical trap).
   */
  _parse_refresh_property() {
    const method = this._parse_var(false, null, true);

    this._match(TokenType.ON);

    const kind = this._match_texts(["MANUAL", "COMMIT", "SCHEDULE"]) ? this._prev.text.toUpperCase() : false;
    const every = this._match_text_seq("EVERY") ? this._parse_number() : false;
    const unit = every ? this._parse_var(true) : null;
    const starts = this._match_text_seq("STARTS") ? this._parse_string() : false;

    return this.expression(new exp.RefreshTriggerProperty({
      method, kind, every, unit, starts,
    }));
  }
}
