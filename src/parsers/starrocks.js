// py: sqlglot/parsers/starrocks.py @ 91119bc — WHOLE FILE (166 LOC), AIR-2286 (epic
// AIR-2272, "12.1 MySQL family" part 2: starrocks + doris, children of R104's
// `MySQLParser`).
//
// `class StarRocksParser(MySQLParser)` — extends the MySQL parser (`src/parsers/
// mysql.js`) directly, the same link closing `dialects/starrocks.py`'s `Parser =
// StarRocksParser` wiring point. `sqlglot/dialects/starrocks.py` (settings) and
// `sqlglot/generators/starrocks.py` (write side) stay separate files, same split
// every prior dialect uses.

import { Parser, build_var_map, setDiff } from "../parser.js";
import { TokenType } from "../tokens.js";
import { seqGet } from "../helper.js";
import { build_date_delta_with_interval, build_timestamp_trunc } from "../dialects/dialect.js";
import { pyTruthy } from "../_py/truthy.js";
import * as exp from "../expressions/index.js";
import { MySQLParser } from "./mysql.js";

/** py: sqlglot/parsers/starrocks.py:11 */
export class StarRocksParser extends MySQLParser {
  // py:12-14 — StarRocks supports LEFT SEMI JOIN and LEFT ANTI JOIN natively.
  // https://docs.starrocks.io/docs/sql-reference/sql-statements/table_bucket_part_index/SELECT/SELECT_JOIN/
  /** py:14 */
  static TABLE_ALIAS_TOKENS = setDiff(
    MySQLParser.TABLE_ALIAS_TOKENS,
    new Set([TokenType.ANTI, TokenType.SEMI]),
  );

  /** py:16 */
  static FUNCTIONS = new Map([
    ...MySQLParser.FUNCTIONS,
    ["ADDDATE", build_date_delta_with_interval(exp.DateAdd, "DAY")],
    ["DATE_ADD", build_date_delta_with_interval(exp.DateAdd, "DAY")],
    ["DATE_SUB", build_date_delta_with_interval(exp.DateSub, "DAY")],
    ["SUBDATE", build_date_delta_with_interval(exp.DateSub, "DAY")],
    ["DATE_TRUNC", build_timestamp_trunc],
    ["DATEDIFF", (args) => new exp.DateDiff({
      this: seqGet(args, 0), expression: seqGet(args, 1), unit: exp.Literal.string("DAY"),
    })],
    ["DATE_DIFF", (args) => new exp.DateDiff({
      this: seqGet(args, 1), expression: seqGet(args, 2), unit: seqGet(args, 0),
    })],
    ["ARRAY_FLATTEN", exp.Flatten.from_arg_list],
    ["REGEXP", exp.RegexpLike.from_arg_list],
    // StarRocks' MAP() is a variadic constructor: MAP(k1, v1, k2, v2, ...)
    // https://docs.starrocks.io/docs/sql-reference/sql-functions/map-functions/map/
    ["MAP", build_var_map],
  ]);

  /** py:36 */
  static PROPERTY_PARSERS = new Map([
    ...MySQLParser.PROPERTY_PARSERS,
    ["PROPERTIES", (self) => self._parse_wrapped_properties()],
    ["UNIQUE", (self) => self._parse_composite_key_property(exp.UniqueKeyProperty)],
    ["ROLLUP", (self) => self._parse_rollup_property()],
    ["REFRESH", (self) => self._parse_refresh_property()],
  ]);

  /** py:44 */
  _parse_rollup_property() {
    // ROLLUP (rollup_name (col1, col2) [FROM from_index] [PROPERTIES (...)], ...)
    const parse_rollup_index = () => this.expression(new exp.RollupIndex({
      this: this._parse_id_var(),
      expressions: this._parse_wrapped_id_vars(),
      from_index: this._match_text_seq("FROM") ? this._parse_id_var() : null,
      properties: this._match_text_seq("PROPERTIES")
        ? this.expression(new exp.Properties({ expressions: this._parse_wrapped_properties() }))
        : null,
    }));

    return this.expression(new exp.RollupProperty({
      expressions: this._parse_wrapped_csv(parse_rollup_index),
    }));
  }

  /** py:64 */
  _parse_create() {
    const create = super._parse_create();

    // Starrocks' primary key is defined outside of the schema, so we need to move it
    // there. https://docs.starrocks.io/docs/table_design/table_types/primary_key_table/#usage
    if (create instanceof exp.Create && create.this instanceof exp.Schema) {
      const props = create.args.properties;
      if (props) {
        const primary_key = props.find(exp.PrimaryKey);
        if (primary_key) {
          create.this.append("expressions", primary_key.pop());
        }
      }
    }

    return create;
  }

  /** py:78 */
  _parse_unnest(with_alias = true) {
    const unnest = super._parse_unnest(with_alias);

    if (unnest) {
      let alias = unnest.args.alias;

      if (!alias) {
        // Starrocks defaults to naming the table alias as "unnest"
        alias = new exp.TableAlias({
          this: exp.toIdentifier("unnest"), columns: [exp.toIdentifier("unnest")],
        });
        unnest.set("alias", alias);
      } else if (!alias.args.columns) {
        // Starrocks defaults to naming the UNNEST column as "unnest"
        // if it's not otherwise specified
        alias.set("columns", [exp.toIdentifier("unnest")]);
      }
    }

    return unnest;
  }

  /** py:97 */
  _parse_partitioned_by() {
    return this.expression(new exp.PartitionedByProperty({
      this: new exp.Schema({
        expressions: this._parse_wrapped_csv(() => this._parse_assignment(), TokenType.COMMA, true),
      }),
    }));
  }

  /** py:106 */
  _parse_partition_property() {
    const expr = super._parse_partition_property();

    if (!pyTruthy(expr)) return this._parse_partitioned_by();

    if (expr instanceof exp.Property) return expr;

    this._match_l_paren();

    const create_expressions = this._match_text_seq("START", { advance: false })
      ? this._parse_csv(() => this._parse_partitioning_granularity_dynamic())
      : null;

    this._match_r_paren();

    return this.expression(new exp.PartitionByRangeProperty({
      partition_expressions: expr, create_expressions,
    }));
  }

  /** py:132 */
  _parse_partitioning_granularity_dynamic() {
    this._match_text_seq("START");
    const start = this._parse_wrapped(() => this._parse_string());
    this._match_text_seq("END");
    const end = this._parse_wrapped(() => this._parse_string());
    this._match_text_seq("EVERY");
    const every = this._parse_wrapped(() => this._parse_interval() || this._parse_number());
    return this.expression(new exp.PartitionByRangePropertyDynamic({ start, end, every }));
  }

  /**
   * py:143
   *
   * REFRESH [DEFERRED | IMMEDIATE]
   *         [ASYNC | ASYNC [START (<start_time>)] EVERY (INTERVAL <refresh_interval>) | MANUAL]
   */
  _parse_refresh_property() {
    // py: `self._match_texts(...) and self._prev.text.upper()` — Python's `and` returns
    // the FIRST falsy operand on no match, i.e. the literal `False` from
    // `_match_texts`/`_match_text_seq`, not `None`. The AST-coverage oracle dumps the
    // raw arg value, so this must be `false` (not `null`) to byte-match — a generator
    // read (`self.sql(expr, key)`) would have treated them identically, which is why
    // this is easy to miss.
    const method = this._match_texts(["DEFERRED", "IMMEDIATE"]) ? this._prev.text.toUpperCase() : false;
    const kind = this._match_texts(["ASYNC", "MANUAL"]) ? this._prev.text.toUpperCase() : false;
    const start = this._match_text_seq("START") ? this._parse_wrapped(() => this._parse_string()) : false;

    let every, unit;
    if (this._match_text_seq("EVERY")) {
      this._match_l_paren();
      this._match_text_seq("INTERVAL");
      every = this._parse_number();
      unit = this._parse_var(true);
      this._match_r_paren();
    } else {
      every = null;
      unit = null;
    }

    return this.expression(new exp.RefreshTriggerProperty({
      method, kind, starts: start, every, unit,
    }));
  }
}
