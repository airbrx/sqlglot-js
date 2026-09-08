// py: sqlglot/parsers/hive.py @ 91119bc
//
// `class HiveParser(parser.Parser)` — the READ-side Hive grammar, and the ROOT of the
// four-link chain `Hive <- Spark2 <- Spark <- Databricks` that upstream splits across
// four files. Each link is ported into its own file and `extends` the previous one,
// mirroring upstream's own inheritance exactly; a defect here propagates to all four,
// which is why this file lands and is measured first.
//
// The two rules `src/parsers/snowflake.js` documents apply verbatim here:
//
//   * A subclass's STATIC FIELD INITIALIZER names its parent explicitly — `new Map([
//     ...Parser.FUNCTIONS, ...])`, mirroring upstream's `{**parser.Parser.FUNCTIONS,
//     ...}`. Evaluated once at module load against the imported base class.
//   * An INSTANCE METHOD reading a class table goes through `this.constructor.X`, so a
//     further subclass (Spark2, Spark, Databricks — all of which exist) sees its own
//     override. That matters far more in this file than it did in Snowflake's, because
//     here there really are three subclasses below.
//
// Whether a table EXTENDS or REPLACES is decided per table from upstream. Five of the
// six tables below extend (`{**parser.Parser.X, ...}`); `NO_PAREN_FUNCTIONS` is the odd
// one out — a dict COMPREHENSION over the parent (`{k: v for k, v in
// parser.Parser.NO_PAREN_FUNCTIONS.items() if k != TokenType.CURRENT_TIME}`) that
// SUBTRACTS a key rather than adding one. It reads like a definition and is really a
// filter; same family as the second-assignment idiom Snowflake's `FUNCTIONS` uses.

import { Parser, build_var_map } from "../parser.js";
import { TokenType } from "../tokens.js";
import { seqGet } from "../helper.js";
import { pyUpper } from "../_py/str.js";
import * as exp from "../expressions/index.js";
import { build_formatted_time, build_regexp_extract } from "../dialects/dialect.js";

/** py: sqlglot/parsers/hive.py:14 */
export function build_with_ignore_nulls(exp_class) {
  return function _parse(args) {
    const this_ = new exp_class({ this: seqGet(args, 0) });
    // py: `seq_get(args, 1) == exp.true()` is Python `__eq__` (same class + same hash),
    // which is `Expr.equals` here. NOT `Expr.eq`, which is the SQL `=` BUILDER
    // (`Expression.eq`, core.py:329) and would return a truthy `EQ` node for every arg.
    const second = seqGet(args, 1);
    if (second !== null && second !== undefined && second.equals(exp.true_())) {
      return new exp.IgnoreNulls({ this: this_ });
    }
    return this_;
  };
}

/** py: sqlglot/parsers/hive.py:26 */
function _build_to_date(args, dialect) {
  const expr = build_formatted_time(exp.TsOrDsToDate)(args, dialect);
  expr.set("safe", true);
  return expr;
}

/**
 * py: sqlglot/parsers/hive.py:32
 *
 * Map named_struct('k', v, ...) to exp.Struct so _annotate_struct sees it.
 */
function _build_named_struct(args) {
  const expressions = [];
  // py: `range(0, len(args) - 1, 2)` — stops one short, so a trailing odd arg is dropped.
  for (let i = 0; i < args.length - 1; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    const name = key.name;
    expressions.push(new exp.PropertyEQ({ this: exp.toIdentifier(name), expression: value }));
  }
  return new exp.Struct({ expressions });
}

/** py: sqlglot/parsers/hive.py:42 */
function _build_date_add(args) {
  let expression = seqGet(args, 1);
  // py: `expression * -1` — Expression.__mul__, which builds exp.Mul.
  if (expression) expression = expression.mul(exp.Literal.number(-1));

  return new exp.TsOrDsAdd({
    this: seqGet(args, 0),
    expression,
    unit: exp.Literal.string("DAY"),
  });
}

export class HiveParser extends Parser {
  /* py:53 */ static LOG_DEFAULTS_TO_LN = true;
  /* py:54 */ static STRICT_CAST = false;
  /* py:55 */ static VALUES_FOLLOWED_BY_PAREN = false;
  /* py:56 */ static JOINS_HAVE_EQUAL_PRECEDENCE = true;
  /* py:57 */ static ADD_JOIN_ON_TRUE = true;
  /* py:58 */ static ALTER_TABLE_PARTITIONS = true;

  /* py:60 */ static CHANGE_COLUMN_ALTER_SYNTAX = false;
  // Whether the dialect supports using ALTER COLUMN syntax with CHANGE COLUMN.

  /** py: sqlglot/parsers/hive.py:63 */
  static FUNCTION_PARSERS = new Map([
    /* py:64 */ ...Parser.FUNCTION_PARSERS,
    /* py:65 */ ["PERCENTILE", (self) => self._parse_distinct_arg_function(exp.Quantile)],
    /* py:66 */ ["PERCENTILE_APPROX", (self) => self._parse_distinct_arg_function(exp.ApproxQuantile)],
  ]);

  /** py: sqlglot/parsers/hive.py:69 */
  static FUNCTIONS = new Map([
    /* py:70 */ ...Parser.FUNCTIONS,
    /* py:71 */ ["BASE64", exp.ToBase64.from_arg_list],
    /* py:72 */ ["COLLECT_LIST", (args) => new exp.ArrayAgg({ this: seqGet(args, 0), nulls_excluded: true })],
    /* py:73 */ ["COLLECT_SET", exp.ArrayUniqueAgg.from_arg_list],
    /* py:74 */ ["DATE_ADD", (args) => new exp.TsOrDsAdd({
      this: seqGet(args, 0), expression: seqGet(args, 1), unit: exp.Literal.string("DAY"),
    })],
    /* py:77 */ ["DATE_FORMAT", (args, dialect) => build_formatted_time(exp.TimeToStr)(
      [
        new exp.TimeStrToTime({ this: seqGet(args, 0) }),
        seqGet(args, 1),
      ],
      dialect,
    )],
    /* py:84 */ ["DATE_SUB", _build_date_add],
    /* py:85 */ ["DATEDIFF", (args) => new exp.DateDiff({
      this: new exp.TsOrDsToDate({ this: seqGet(args, 0) }),
      expression: new exp.TsOrDsToDate({ this: seqGet(args, 1) }),
    })],
    /* py:89 */ ["DAY", (args) => new exp.Day({ this: new exp.TsOrDsToDate({ this: seqGet(args, 0) }) })],
    /* py:90 */ ["FIRST", build_with_ignore_nulls(exp.First)],
    /* py:91 */ ["FIRST_VALUE", build_with_ignore_nulls(exp.FirstValue)],
    /* py:92 */ ["FROM_UNIXTIME", build_formatted_time(exp.UnixToStr, null, true)],
    /* py:93 */ ["GET_JSON_OBJECT", (args, dialect) => new exp.JSONExtractScalar({
      this: seqGet(args, 0), expression: dialect.to_json_path(seqGet(args, 1)),
    })],
    /* py:96 */ ["LAST", build_with_ignore_nulls(exp.Last)],
    /* py:97 */ ["LAST_VALUE", build_with_ignore_nulls(exp.LastValue)],
    /* py:98 */ ["MAP", build_var_map],
    /* py:99 */ ["MONTH", (args) => new exp.Month({ this: exp.TsOrDsToDate.from_arg_list(args) })],
    /* py:100 */ ["NAMED_STRUCT", _build_named_struct],
    /* py:101 */ ["REGEXP_EXTRACT", build_regexp_extract(exp.RegexpExtract)],
    /* py:102 */ ["REGEXP_EXTRACT_ALL", build_regexp_extract(exp.RegexpExtractAll)],
    /* py:103 */ ["SEQUENCE", exp.GenerateSeries.from_arg_list],
    /* py:104 */ ["SIZE", exp.ArraySize.from_arg_list],
    /* py:105 */ ["SPLIT", exp.RegexpSplit.from_arg_list],
    /* py:106 */ ["STR_TO_MAP", (args) => new exp.StrToMap({
      this: seqGet(args, 0),
      pair_delim: seqGet(args, 1) || exp.Literal.string(","),
      key_value_delim: seqGet(args, 2) || exp.Literal.string(":"),
    })],
    /* py:111 */ ["TO_DATE", _build_to_date],
    /* py:112 */ ["TO_JSON", exp.JSONFormat.from_arg_list],
    /* py:113 */ ["TRUNC", exp.TimestampTrunc.from_arg_list],
    /* py:114 */ ["UNBASE64", exp.FromBase64.from_arg_list],
    /* py:115 */ ["UNIX_TIMESTAMP", (args, dialect) => build_formatted_time(exp.StrToUnix, null, true)(
      // py: `args or [exp.CurrentTimestamp()]` — an EMPTY list is falsy in Python.
      args.length ? args : [new exp.CurrentTimestamp()], dialect,
    )],
    /* py:118 */ ["YEAR", (args) => new exp.Year({ this: exp.TsOrDsToDate.from_arg_list(args) })],
  ]);

  /** py: sqlglot/parsers/hive.py:121 */
  static NO_PAREN_FUNCTION_PARSERS = new Map([
    /* py:122 */ ...Parser.NO_PAREN_FUNCTION_PARSERS,
    /* py:123 */ ["TRANSFORM", (self) => self._parse_transform()],
  ]);

  // py:126 — a dict COMPREHENSION over the PARENT's table, not an extension of it: it
  // SUBTRACTS `CURRENT_TIME` so that `CURRENT_TIME` falls through to ordinary
  // identifier/function parsing in Hive. Reads like a fresh definition; it is a filter.
  /* py:126 */ static NO_PAREN_FUNCTIONS = new Map(
    [...Parser.NO_PAREN_FUNCTIONS].filter(([k]) => k !== TokenType.CURRENT_TIME),
  );

  /** py: sqlglot/parsers/hive.py:130 */
  static PROPERTY_PARSERS = new Map([
    /* py:131 */ ...Parser.PROPERTY_PARSERS,
    /* py:132 */ ["SERDEPROPERTIES", (self) => new exp.SerdeProperties({
      expressions: self._parse_wrapped_csv(self._parse_property.bind(self)),
    })],
    /* py:135 */ ["USING", (self) => self._parse_using_property()],
  ]);

  /** py: sqlglot/parsers/hive.py:138 */
  static ALTER_PARSERS = new Map([
    /* py:139 */ ...Parser.ALTER_PARSERS,
    /* py:140 */ ["CHANGE", (self) => self._parse_alter_table_change()],
  ]);

  /** py: sqlglot/parsers/hive.py:143 */
  _parse_transform() {
    if (!this._match(TokenType.L_PAREN, false)) {
      this._retreat(this._index - 1);
      return null;
    }

    const args = this._parse_wrapped_csv(this._parse_lambda.bind(this));
    const row_format_before = this._parse_row_format(true);

    let record_writer = null;
    if (this._match_text_seq("RECORDWRITER")) {
      record_writer = this._parse_string();
    }

    if (!this._match(TokenType.USING)) {
      return exp.Transform.from_arg_list(args);
    }

    const command_script = this._parse_string();

    this._match(TokenType.ALIAS);
    const schema = this._parse_schema();

    const row_format_after = this._parse_row_format(true);
    let record_reader = null;
    if (this._match_text_seq("RECORDREADER")) {
      record_reader = this._parse_string();
    }

    return this.expression(
      new exp.QueryTransform({
        expressions: args,
        command_script,
        schema,
        row_format_before,
        record_writer,
        row_format_after,
        record_reader,
      }),
    );
  }

  /**
   * py: sqlglot/parsers/hive.py:180
   *
   * Spark (and most likely Hive) treats casts to CHAR(length) and VARCHAR(length) as casts to
   * STRING in all contexts except for schema definitions. For example, this is in Spark v3.4.0:
   *
   *     spark-sql (default)> select cast(1234 as varchar(2));
   *     23/06/06 15:51:18 WARN CharVarcharUtils: The Spark cast operator does not support
   *     char/varchar type and simply treats them as string type. Please use string type
   *     directly to avoid confusion. Otherwise, you can set spark.sql.legacy.charVarcharAsString
   *     to true, so that Spark treat them as string type as same as Spark 3.0 and earlier
   *
   *     1234
   *     Time taken: 4.265 seconds, Fetched 1 row(s)
   *
   * This shows that Spark doesn't truncate the value into '12', which is inconsistent with
   * what other dialects (e.g. postgres) do, so we need to drop the length to transpile correctly.
   *
   * Reference: https://spark.apache.org/docs/latest/sql-ref-datatypes.html
   */
  _parse_types(check_func = false, schema = false, allow_identifiers = true, with_collation = false) {
    const this_ = super._parse_types(check_func, schema, allow_identifiers, with_collation);

    if (this_ && !schema) {
      /** py:214 */
      const _to_text = (node) => {
        if (node instanceof exp.DataType && node.isType("char", "varchar")) {
          node.set("this", exp.DType.TEXT);
          node.set("expressions", null);
        }
        return node;
      };

      return this_.transform(_to_text, { copy: false });
    }

    return this_;
  }

  /** py: sqlglot/parsers/hive.py:224 */
  _parse_alter_table_change() {
    this._match(TokenType.COLUMN);
    const this_ = this._parse_field(true);

    if (this.constructor.CHANGE_COLUMN_ALTER_SYNTAX && this._match_text_seq("TYPE")) {
      return this.expression(new exp.AlterColumn({ this: this_, dtype: this._parse_types(false, true) }));
    }

    const column_new = this._parse_field(true);
    const dtype = this._parse_types(false, true);

    // py: `self._match(...) and self._parse_string()` — False, not None, when unmatched.
    const comment = this._match(TokenType.COMMENT) ? this._parse_string() : false;

    if (!this_ || !column_new || !dtype) {
      this.raise_error(
        "Expected 'CHANGE COLUMN' to be followed by 'column_name' 'column_name' 'data_type'",
      );
    }

    return this.expression(
      new exp.AlterColumn({ this: this_, rename_to: column_new, dtype, comment }),
    );
  }

  /** py: sqlglot/parsers/hive.py:245 */
  _parse_using_property() {
    if (this._match_texts(["JAR", "FILE", "ARCHIVE"])) {
      const kind = pyUpper(this._prev.text);
      return new exp.UsingProperty({ this: this._parse_string(), kind });
    }

    return this._parse_property_assignment(exp.FileFormatProperty);
  }

  /** py: sqlglot/parsers/hive.py:252 */
  _parse_partition_and_order() {
    return [
      this._match_set(new Set([TokenType.PARTITION_BY, TokenType.DISTRIBUTE_BY]))
        ? this._parse_csv(this._parse_assignment.bind(this))
        : [],
      super._parse_order(null, this._match(TokenType.SORT_BY)),
    ];
  }

  /** py: sqlglot/parsers/hive.py:264 */
  _parse_parameter() {
    this._match(TokenType.L_BRACE);
    const this_ = this._parse_identifier() || this._parse_primary_or_var();
    // py: `self._match(...) and (...)` — False, not None, when unmatched.
    const expression = this._match(TokenType.COLON)
      ? (this._parse_identifier() || this._parse_primary_or_var())
      : false;
    this._match(TokenType.R_BRACE);
    return this.expression(new exp.Parameter({ this: this_, expression }));
  }

  /** py: sqlglot/parsers/hive.py:273 */
  _to_prop_eq(expression, index) {
    if (expression.isStar) {
      return expression;
    }

    let key;
    if (expression instanceof exp.Column) {
      key = expression.this;
    } else {
      key = exp.toIdentifier(`col${index + 1}`);
    }

    return this.expression(new exp.PropertyEQ({ this: key, expression }));
  }
}
