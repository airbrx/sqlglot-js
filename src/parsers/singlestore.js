// py: sqlglot/parsers/singlestore.py @ 91119bc — WHOLE FILE (248 LOC), AIR-2286 (epic
// AIR-2272, "12.1 MySQL family"), part 3 of the chain. `class SingleStoreParser(
// MySQLParser)` — extends R104's `src/parsers/mysql.js` directly, the same
// `TrinoParser extends PrestoParser` relationship R105 used one dialect-family over.
//
// `sqlglot/dialects/singlestore.py` (the `SingleStore(MySQL)` SETTINGS class,
// including the `Tokenizer` subclass) and `sqlglot/generators/singlestore.py` stay
// separate files, same split every prior dialect uses.
//
// NAMED GAP, inherited from the generic `build_formatted_time` helper, not invented
// here: `build_formatted_time(exp.StrToDate, "mysql")`/`build_formatted_time(
// exp.TimeToStr, "mysql")` below pass a non-null STRING `dialect_override`, which
// `dialect.js`'s own `build_formatted_time` throws `NotPorted` on the instant the
// returned builder actually runs (CONTRACTS.md §8 forbids resolving a dialect by
// NAME from inside that generic helper) — the exact same shape `parsers/presto.js`'s
// own header already documents for `TO_CHAR`/`"teradata"`. Ported faithfully rather
// than "fixed": `STR_TO_DATE`/`DATE_FORMAT` under this dialect throw when actually
// invoked, a pre-existing architectural limitation this round inherits, not causes.
import { TokenType } from "../tokens.js";
import { newTrie } from "../trie.js";
import { seqGet } from "../helper.js";
import { build_formatted_time, build_json_extract_path } from "../dialects/dialect.js";
import { MySQL } from "../dialects/mysql.js";
import { MySQLParser, _show_parser } from "./mysql.js";
import * as exp from "../expressions/index.js";

/** py: sqlglot/parsers/singlestore.py:16 */
export function cast_to_time6(expression, time_type = exp.DType.TIME) {
  return new exp.Cast({
    this: expression,
    to: time_type.into_expr({ expressions: [new exp.DataTypeParam({ this: exp.Literal.number(6) })] }),
  });
}

/** py: sqlglot/parsers/singlestore.py:23 */
export class SingleStoreParser extends MySQLParser {
  /** py:24 */
  static FUNCTIONS = new Map([
    ...MySQLParser.FUNCTIONS,
    ["TO_DATE", build_formatted_time(exp.TsOrDsToDate)],
    ["TO_TIMESTAMP", build_formatted_time(exp.StrToTime)],
    ["TO_CHAR", build_formatted_time(exp.ToChar)],
    ["STR_TO_DATE", build_formatted_time(exp.StrToDate, "mysql")],
    ["DATE_FORMAT", build_formatted_time(exp.TimeToStr, "mysql")],
    // py:31-34 — the first argument of the following functions is converted to
    // TIME(6). Needed because `exp.TimeToStr` converts to `DATE_FORMAT`, which
    // interprets the first argument as DATETIME and fails to parse string literals
    // like '12:05:47' without a date part.
    ["TIME_FORMAT", (args) => new exp.TimeToStr({
      this: cast_to_time6(seqGet(args, 0)),
      format: MySQL.format_time(seqGet(args, 1)),
    })],
    ["HOUR", (args) => exp.cast(
      new exp.TimeToStr({
        this: cast_to_time6(seqGet(args, 0)),
        format: MySQL.format_time(exp.Literal.string("%k")),
      }),
      exp.DType.INT,
    )],
    ["MICROSECOND", (args) => exp.cast(
      new exp.TimeToStr({
        this: cast_to_time6(seqGet(args, 0)),
        format: MySQL.format_time(exp.Literal.string("%f")),
      }),
      exp.DType.INT,
    )],
    ["SECOND", (args) => exp.cast(
      new exp.TimeToStr({
        this: cast_to_time6(seqGet(args, 0)),
        format: MySQL.format_time(exp.Literal.string("%s")),
      }),
      exp.DType.INT,
    )],
    ["MINUTE", (args) => exp.cast(
      new exp.TimeToStr({
        this: cast_to_time6(seqGet(args, 0)),
        format: MySQL.format_time(exp.Literal.string("%i")),
      }),
      exp.DType.INT,
    )],
    ["MONTHNAME", (args) => new exp.TimeToStr({
      this: seqGet(args, 0),
      format: MySQL.format_time(exp.Literal.string("%M")),
    })],
    ["WEEKDAY", (args) => exp.paren(new exp.DayOfWeek({ this: seqGet(args, 0) }).add(5), false).mod(7)],
    ["UNIX_TIMESTAMP", exp.StrToUnix.from_arg_list],
    ["FROM_UNIXTIME", build_formatted_time(exp.UnixToTime, "mysql")],
    ["TIME_BUCKET", (args) => new exp.DateBin({
      this: seqGet(args, 0),
      expression: seqGet(args, 1),
      origin: seqGet(args, 2),
    })],
    ["BSON_EXTRACT_BSON", build_json_extract_path(exp.JSONBExtract)],
    ["BSON_EXTRACT_STRING", build_json_extract_path(exp.JSONBExtractScalar, true, false, "STRING")],
    ["BSON_EXTRACT_DOUBLE", build_json_extract_path(exp.JSONBExtractScalar, true, false, "DOUBLE")],
    ["BSON_EXTRACT_BIGINT", build_json_extract_path(exp.JSONBExtractScalar, true, false, "BIGINT")],
    ["JSON_EXTRACT_JSON", build_json_extract_path(exp.JSONExtract)],
    ["JSON_EXTRACT_STRING", build_json_extract_path(exp.JSONExtractScalar, true, false, "STRING")],
    ["JSON_EXTRACT_DOUBLE", build_json_extract_path(exp.JSONExtractScalar, true, false, "DOUBLE")],
    ["JSON_EXTRACT_BIGINT", build_json_extract_path(exp.JSONExtractScalar, true, false, "BIGINT")],
    ["JSON_ARRAY_CONTAINS_STRING", (args) => new exp.JSONArrayContains({
      this: seqGet(args, 1),
      expression: seqGet(args, 0),
      json_type: "STRING",
    })],
    ["JSON_ARRAY_CONTAINS_DOUBLE", (args) => new exp.JSONArrayContains({
      this: seqGet(args, 1),
      expression: seqGet(args, 0),
      json_type: "DOUBLE",
    })],
    ["JSON_ARRAY_CONTAINS_JSON", (args) => new exp.JSONArrayContains({
      this: seqGet(args, 1),
      expression: seqGet(args, 0),
      json_type: "JSON",
    })],
    ["JSON_KEYS", (args) => new exp.JSONKeys({
      this: seqGet(args, 0),
      expressions: args.slice(1),
    })],
    ["JSON_PRETTY", exp.JSONFormat.from_arg_list],
    ["JSON_BUILD_ARRAY", (args) => new exp.JSONArray({ expressions: args })],
    ["JSON_BUILD_OBJECT", (args) => new exp.JSONObject({ expressions: args })],
    ["DATE", exp.Date.from_arg_list],
    ["DAYNAME", (args) => new exp.TimeToStr({
      this: seqGet(args, 0),
      format: MySQL.format_time(exp.Literal.string("%W")),
    })],
    ["TIMESTAMPDIFF", (args) => new exp.TimestampDiff({
      this: seqGet(args, 2),
      expression: seqGet(args, 1),
      unit: seqGet(args, 0),
    })],
    ["APPROX_COUNT_DISTINCT", exp.Hll.from_arg_list],
    ["APPROX_PERCENTILE", (args, dialect) => new exp.ApproxQuantile({
      this: seqGet(args, 0),
      quantile: seqGet(args, 1),
      error_tolerance: seqGet(args, 2),
    })],
    ["VARIANCE", exp.VariancePop.from_arg_list],
    ["INSTR", exp.Contains.from_arg_list],
    ["REGEXP_MATCH", (args) => new exp.RegexpExtractAll({
      this: seqGet(args, 0),
      expression: seqGet(args, 1),
      parameters: seqGet(args, 2),
    })],
    ["REGEXP_SUBSTR", (args) => new exp.RegexpExtract({
      this: seqGet(args, 0),
      expression: seqGet(args, 1),
      position: seqGet(args, 2),
      occurrence: seqGet(args, 3),
      parameters: seqGet(args, 4),
    })],
    ["REDUCE", (args) => new exp.Reduce({
      initial: seqGet(args, 0),
      this: seqGet(args, 1),
      merge: seqGet(args, 2),
    })],
  ]);

  /** py:146 */
  static FUNCTION_PARSERS = new Map([
    ...MySQLParser.FUNCTION_PARSERS,
    ["JSON_AGG", (self) => new exp.JSONArrayAgg({
      this: self._parse_term(),
      order: self._parse_order(),
    })],
  ]);

  /** py:154 */
  static NO_PAREN_FUNCTIONS = new Map([
    ...MySQLParser.NO_PAREN_FUNCTIONS,
    [TokenType.UTC_DATE, exp.UtcDate],
    [TokenType.UTC_TIME, exp.UtcTime],
    [TokenType.UTC_TIMESTAMP, exp.UtcTimestamp],
  ]);

  /** py:161 */
  static CAST_COLUMN_OPERATORS = new Set([TokenType.COLON_GT, TokenType.NCOLON_GT]);

  /** py:163-191 — built then filtered, same two-step shape upstream's own two
   * `COLUMN_OPERATORS = {...}` class-body statements use. */
  static COLUMN_OPERATORS = (() => {
    const m = new Map([
      ...MySQLParser.COLUMN_OPERATORS,
      [TokenType.COLON_GT, (self, this_, to) => self.expression(new exp.Cast({ this: this_, to }))],
      [TokenType.NCOLON_GT, (self, this_, to) => self.expression(new exp.TryCast({ this: this_, to }))],
      [TokenType.DCOLON, (self, this_, path) => build_json_extract_path(exp.JSONExtract)(
        [this_, exp.Literal.string(path.name)],
      )],
      [TokenType.DCOLONDOLLAR, (self, this_, path) => build_json_extract_path(
        exp.JSONExtractScalar, true, false, "STRING",
      )([this_, exp.Literal.string(path.name)])],
      [TokenType.DCOLONPERCENT, (self, this_, path) => build_json_extract_path(
        exp.JSONExtractScalar, true, false, "DOUBLE",
      )([this_, exp.Literal.string(path.name)])],
      [TokenType.DCOLONQMARK, (self, this_, path) => self.expression(
        new exp.JSONExists({ this: this_, path: path.name, from_dcolonqmark: true }),
      )],
    ]);
    for (const k of [
      TokenType.ARROW,
      TokenType.DARROW,
      TokenType.HASH_ARROW,
      TokenType.DHASH_ARROW,
      TokenType.PLACEHOLDER,
    ]) {
      m.delete(k);
    }
    return m;
  })();

  /** py:193 */
  static SHOW_PARSERS = new Map([
    ...MySQLParser.SHOW_PARSERS,
    ["AGGREGATES", _show_parser("AGGREGATES")],
    ["CDC EXTRACTOR POOL", _show_parser("CDC EXTRACTOR POOL")],
    ["CREATE AGGREGATE", _show_parser("CREATE AGGREGATE", { target: true })],
    ["CREATE PIPELINE", _show_parser("CREATE PIPELINE", { target: true })],
    ["CREATE PROJECTION", _show_parser("CREATE PROJECTION", { target: true })],
    ["DATABASE STATUS", _show_parser("DATABASE STATUS")],
    ["DISTRIBUTED_PLANCACHE STATUS", _show_parser("DISTRIBUTED_PLANCACHE STATUS")],
    ["FULLTEXT SERVICE METRICS LOCAL", _show_parser("FULLTEXT SERVICE METRICS LOCAL")],
    ["FULLTEXT SERVICE METRICS FOR NODE", _show_parser("FULLTEXT SERVICE METRICS FOR NODE", { target: true })],
    ["FULLTEXT SERVICE STATUS", _show_parser("FULLTEXT SERVICE STATUS")],
    ["FUNCTIONS", _show_parser("FUNCTIONS")],
    ["GROUPS", _show_parser("GROUPS")],
    ["GROUPS FOR ROLE", _show_parser("GROUPS FOR ROLE", { target: true })],
    ["GROUPS FOR USER", _show_parser("GROUPS FOR USER", { target: true })],
    ["INDEXES", _show_parser("INDEX", { target: "FROM" })],
    ["KEYS", _show_parser("INDEX", { target: "FROM" })],
    ["LINKS", _show_parser("LINKS", { target: "ON" })],
    ["LOAD ERRORS", _show_parser("LOAD ERRORS")],
    ["LOAD WARNINGS", _show_parser("LOAD WARNINGS")],
    ["PARTITIONS", _show_parser("PARTITIONS", { target: "ON" })],
    ["PIPELINES", _show_parser("PIPELINES")],
    ["PLAN", _show_parser("PLAN", { target: true })],
    ["PLANCACHE", _show_parser("PLANCACHE")],
    ["PROCEDURES", _show_parser("PROCEDURES")],
    ["PROJECTIONS", _show_parser("PROJECTIONS", { target: "ON TABLE" })],
    ["REPLICATION STATUS", _show_parser("REPLICATION STATUS")],
    ["REPRODUCTION", _show_parser("REPRODUCTION")],
    ["RESOURCE POOLS", _show_parser("RESOURCE POOLS")],
    ["ROLES", _show_parser("ROLES")],
    ["ROLES FOR USER", _show_parser("ROLES FOR USER", { target: true })],
    ["ROLES FOR GROUP", _show_parser("ROLES FOR GROUP", { target: true })],
    ["STATUS EXTENDED", _show_parser("STATUS EXTENDED")],
    ["USERS", _show_parser("USERS")],
    ["USERS FOR ROLE", _show_parser("USERS FOR ROLE", { target: true })],
    ["USERS FOR GROUP", _show_parser("USERS FOR GROUP", { target: true })],
  ]);

  /** py:234 */
  static SHOW_TRIE = newTrie([...this.SHOW_PARSERS.keys()].map((key) => key.split(" ")));

  /** py:236 */
  static ALTER_PARSERS = new Map([
    ...MySQLParser.ALTER_PARSERS,
    ["CHANGE", (self) => self.expression(
      new exp.RenameColumn({ this: self._parse_column(), to: self._parse_column() }),
    )],
  ]);

  /** py:243 */
  _parse_vector_expressions(expressions) {
    let type_name = expressions[1].name.toUpperCase();
    if (this.dialect.VECTOR_TYPE_ALIASES.has(type_name)) {
      type_name = this.dialect.VECTOR_TYPE_ALIASES.get(type_name);
    }

    return [exp.DataType.build(type_name, { dialect: this.dialect }), expressions[0]];
  }
}
