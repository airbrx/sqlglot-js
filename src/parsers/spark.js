// py: sqlglot/parsers/spark.py @ 91119bc
//
// `class SparkParser(Spark2Parser)` — link 3 of 4. Everything extends `Spark2Parser`,
// which extends `HiveParser`, which extends `Parser`; by this depth a single table read
// walks four class bodies, which is why the field initializers below name
// `Spark2Parser` explicitly rather than reaching for `super` (a static field
// initializer has no `super` binding to a parent's FIELD, only to its methods).
//
// `STATEMENT_PARSERS` (py:124) is a pure copy of the parent's with NOTHING added. It is
// reproduced rather than omitted because upstream writes it: the assignment makes
// `SparkParser.STATEMENT_PARSERS` its own object, so a later mutation of the parent's
// would not be seen here. Behaviourally identical today, structurally faithful.
//
// `SET_TRIE` (py:67) is DERIVED from `SET_PARSERS` in the same class body — unqualified
// `SET_PARSERS` in Python's class scope is the override two lines above, not the
// parent's. `this` in a JS static field initializer is the class under construction and
// the field above has already run, so `this.SET_PARSERS` reads the same value. Same
// idiom the base `Parser.SET_TRIE` (src/parser.js:2090) already uses.

import { TokenType } from "../tokens.js";
import { newTrie } from "../trie.js";
import { ensureList, seqGet } from "../helper.js";
import * as exp from "../expressions/index.js";
import { build_date_delta, build_like } from "../dialects/dialect.js";
import { build_with_ignore_nulls } from "./hive.js";
import { Spark2Parser, build_as_cast } from "./spark2.js";

/**
 * py: sqlglot/parsers/spark.py:14
 *
 * Although Spark docs don't mention the "unit" argument, Spark3 added support for
 * it at some point. Databricks also supports this variant (see below).
 *
 * For example, in spark-sql (v3.3.1):
 * - SELECT DATEDIFF('2020-01-01', '2020-01-05') results in -4
 * - SELECT DATEDIFF(day, '2020-01-01', '2020-01-05') results in 4
 *
 * See also:
 * - https://docs.databricks.com/sql/language-manual/functions/datediff3.html
 * - https://docs.databricks.com/sql/language-manual/functions/datediff.html
 */
function _build_datediff(args) {
  let unit = null;
  let this_ = seqGet(args, 0);
  const expression = seqGet(args, 1);

  if (args.length === 3) {
    unit = exp.var_(this_.name);
    this_ = args[2];
  }

  return new exp.DateDiff({
    this: new exp.TsOrDsToDate({ this: this_ }),
    expression: new exp.TsOrDsToDate({ this: expression }),
    unit,
  });
}

/** py: sqlglot/parsers/spark.py:40 */
function _build_dateadd(args) {
  const expression = seqGet(args, 1);

  if (args.length === 2) {
    // DATE_ADD(startDate, numDays INTEGER)
    // https://docs.databricks.com/en/sql/language-manual/functions/date_add.html
    return new exp.TsOrDsAdd({
      this: seqGet(args, 0), expression, unit: exp.Literal.string("DAY"),
    });
  }

  // DATE_ADD / DATEADD / TIMESTAMPADD(unit, value integer, expr)
  // https://docs.databricks.com/en/sql/language-manual/functions/date_add3.html
  return new exp.TimestampAdd({
    this: seqGet(args, 2), expression, unit: seqGet(args, 0),
  });
}

export class SparkParser extends Spark2Parser {
  /** py: sqlglot/parsers/spark.py:56 */
  static NO_PAREN_FUNCTIONS = new Map([
    /* py:57 */ ...Spark2Parser.NO_PAREN_FUNCTIONS,
    /* py:58 */ [TokenType.SESSION_USER, exp.SessionUser],
  ]);

  /** py: sqlglot/parsers/spark.py:61 */
  static SET_PARSERS = new Map([
    /* py:62 */ ...Spark2Parser.SET_PARSERS,
    /* py:63 */ ["VAR", (self) => self._parse_set_item_assignment("VARIABLE")],
    /* py:64 */ ["VARIABLE", (self) => self._parse_set_item_assignment("VARIABLE")],
  ]);

  /* py:67 */ static SET_TRIE = newTrie([...this.SET_PARSERS.keys()].map((key) => key.split(" ")));

  /** py: sqlglot/parsers/spark.py:69 */
  static FUNCTIONS = new Map([
    /* py:70 */ ...Spark2Parser.FUNCTIONS,
    /* py:71 */ ["ANY_VALUE", build_with_ignore_nulls(exp.AnyValue)],
    /* py:72 */ ["ARRAY_INSERT", (args) => new exp.ArrayInsert({
      this: seqGet(args, 0),
      position: seqGet(args, 1),
      expression: seqGet(args, 2),
      offset: 1,
    })],
    /* py:78 */ ["BIT_AND", exp.BitwiseAndAgg.from_arg_list],
    /* py:79 */ ["BIT_GET", exp.Getbit.from_arg_list],
    /* py:80 */ ["BIT_OR", exp.BitwiseOrAgg.from_arg_list],
    /* py:81 */ ["BIT_XOR", exp.BitwiseXorAgg.from_arg_list],
    /* py:82 */ ["BIT_COUNT", exp.BitwiseCount.from_arg_list],
    /* py:83 */ ["CURDATE", exp.CurrentDate.from_arg_list],
    /* py:84 */ ["DATE_ADD", _build_dateadd],
    /* py:85 */ ["DATEADD", _build_dateadd],
    /* py:86 */ ["MAKE_TIMESTAMP", exp.TimestampFromParts.from_arg_list],
    /* py:87 */ ["TIMESTAMPADD", _build_dateadd],
    /* py:88 */ ["TIMESTAMPDIFF", build_date_delta(exp.TimestampDiff)],
    /* py:89 */ ["TRY_ADD", exp.SafeAdd.from_arg_list],
    /* py:90 */ ["TRY_DIVIDE", exp.SafeDivide.from_arg_list],
    /* py:91 */ ["TRY_MULTIPLY", exp.SafeMultiply.from_arg_list],
    /* py:92 */ ["TRY_SUBTRACT", exp.SafeSubtract.from_arg_list],
    /* py:93 */ ["DATEDIFF", _build_datediff],
    /* py:94 */ ["DATE_DIFF", _build_datediff],
    /* py:95 */ ["JSON_OBJECT_KEYS", exp.JSONKeys.from_arg_list],
    /* py:96 */ ["LISTAGG", exp.GroupConcat.from_arg_list],
    /* py:97 */ ["TIMESTAMP_LTZ", build_as_cast("TIMESTAMP_LTZ")],
    /* py:98 */ ["TIMESTAMP_NTZ", build_as_cast("TIMESTAMP_NTZ")],
    /* py:99 */ ["TRY_ELEMENT_AT", (args) => new exp.Bracket({
      this: seqGet(args, 0),
      expressions: ensureList(seqGet(args, 1)),
      offset: 1,
      safe: true,
    })],
    /* py:105 */ ["LIKE", build_like(exp.Like)],
    /* py:106 */ ["ILIKE", build_like(exp.ILike)],
  ]);

  /** py: sqlglot/parsers/spark.py:109 */
  static PLACEHOLDER_PARSERS = new Map([
    /* py:110 */ ...Spark2Parser.PLACEHOLDER_PARSERS,
    /* py:111 */ [TokenType.L_BRACE, (self) => self._parse_query_parameter()],
  ]);

  /** py: sqlglot/parsers/spark.py:114 */
  _parse_query_parameter() {
    const this_ = this._parse_id_var();
    this._match(TokenType.R_BRACE);
    return this.expression(new exp.Placeholder({ this: this_, widget: true }));
  }

  /** py: sqlglot/parsers/spark.py:119 */
  static FUNCTION_PARSERS = new Map([
    /* py:120 */ ...Spark2Parser.FUNCTION_PARSERS,
    /* py:121 */ ["SUBSTR", (self) => self._parse_substring()],
  ]);

  /** py: sqlglot/parsers/spark.py:124 */
  static STATEMENT_PARSERS = new Map([
    /* py:125 */ ...Spark2Parser.STATEMENT_PARSERS,
  ]);

  /** py: sqlglot/parsers/spark.py:128 */
  _parse_generated_as_identity() {
    const this_ = super._parse_generated_as_identity();
    if (this_.expression) {
      return this.expression(new exp.ComputedColumnConstraint({ this: this_.expression }));
    }
    return this_;
  }

  /** py: sqlglot/parsers/spark.py:140 */
  _parse_pivot_aggregation() {
    // Spark 3+ and Databricks support non aggregate functions in PIVOT too, e.g
    // PIVOT (..., 'foo' AS bar FOR col_to_pivot IN (...))
    const aggregate_expr = this._parse_function() || this._parse_disjunction();
    return this._parse_alias(aggregate_expr);
  }
}
