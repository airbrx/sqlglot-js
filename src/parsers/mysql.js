// py: sqlglot/parsers/mysql.py @ 91119bc — WHOLE FILE (657 LOC), AIR-2286.
//
// `class MySQLParser(parser.Parser)` — extends the base `Parser` (`src/parser.js`)
// directly, the same link `postgres.js`/`bigquery.js` use (not `base.js`'s
// `BaseParser`, which is only for the DEFAULT dialect — see that file's own header).
//
// `sqlglot/dialects/mysql.py` (the `MySQL(Dialect)` SETTINGS class, including the
// `Tokenizer` subclass) and `sqlglot/generators/mysql.py` stay separate P5/P4 files,
// the same split every prior dialect port used.
//
// `Dialect["mysql"]`/`Dialect.get_or_raise("mysql")` (py:38, `_str_to_date`; py:112-115,
// the `DATE_FORMAT` builder) is a RUNTIME registry lookup, not a module import — same
// circular-import workaround `parsers/tsql.js`'s `_tsqlSettings()` documents at length.
// `dialects/mysql.js` imports `MySQLParser` FROM this file at module level, so a plain
// top-level `import { MySQL } from "../dialects/mysql.js"` here would recreate the
// cycle with ES modules' sharper temporal-dead-zone failure mode.

import { Parser, setDiff, setUnion } from "../parser.js";
import { TokenType } from "../tokens.js";
import { seqGet } from "../helper.js";
import { newTrie } from "../trie.js";
import {
  Dialect,
  build_date_delta,
  build_date_delta_with_interval,
  build_formatted_time,
  isnull_to_is_null,
} from "../dialects/dialect.js";
import * as exp from "../expressions/index.js";

// py:20 `TIME_SPECIFIERS` — all specifiers for time parts (as opposed to date parts).
const TIME_SPECIFIERS = new Set(["f", "H", "h", "I", "i", "k", "l", "p", "r", "S", "s", "T"]);

/** py: sqlglot/parsers/mysql.py:23 */
function _has_time_specifier(date_format) {
  let i = 0;
  const length = date_format.length;

  while (i < length) {
    if (date_format[i] === "%") {
      i += 1;
      if (i < length && TIME_SPECIFIERS.has(date_format[i])) return true;
    }
    i += 1;
  }
  return false;
}

/** py: sqlglot/parsers/mysql.py:36 */
function _str_to_date(args) {
  const mysql_date_format = seqGet(args, 1);
  const date_format = Dialect.get_or_raise("mysql").format_time(mysql_date_format);
  const this_ = seqGet(args, 0);

  if (mysql_date_format && _has_time_specifier(mysql_date_format.name)) {
    return new exp.StrToTime({ this: this_, format: date_format });
  }

  return new exp.StrToDate({ this: this_, format: date_format });
}

/**
 * py: sqlglot/parsers/mysql.py:47 `_show_parser(*args, **kwargs)`. Only `this` is ever
 * passed positionally upstream, and `target`/`full`/`global_` by keyword, so the
 * keywords arrive as a trailing options object — same deviation `parsers/snowflake.js`
 * already documents for its own `_show_parser`.
 */
export function _show_parser(this_, kwargs = {}) {
  return function _parse(self) {
    return self._parse_show_mysql(this_, kwargs.target ?? false, kwargs.full ?? null, kwargs.global_ ?? null);
  };
}

/** py: sqlglot/parsers/mysql.py:54 */
export class MySQLParser extends Parser {
  /** py:55 */
  static NO_PAREN_FUNCTIONS = new Map([
    ...Parser.NO_PAREN_FUNCTIONS,
    [TokenType.LOCALTIME, exp.Localtime],
    [TokenType.LOCALTIMESTAMP, exp.Localtimestamp],
  ]);

  /** py:61 */
  static ID_VAR_TOKENS = setDiff(Parser.ID_VAR_TOKENS, new Set([TokenType.STRAIGHT_JOIN]));

  /** py:63 */
  static FUNC_TOKENS = new Set([
    ...Parser.FUNC_TOKENS,
    TokenType.DATABASE,
    TokenType.MOD,
    TokenType.SCHEMA,
    TokenType.VALUES,
    TokenType.CHARACTER_SET,
  ]);

  /** py:72 */
  static CONJUNCTION = new Map([
    ...Parser.CONJUNCTION,
    [TokenType.DAMP, exp.And],
    [TokenType.XOR, exp.Xor],
  ]);

  /** py:78 */
  static DISJUNCTION = new Map([
    ...Parser.DISJUNCTION,
    [TokenType.DPIPE, exp.Or],
  ]);

  /** py:83 */
  static TABLE_ALIAS_TOKENS = setDiff(
    setUnion(Parser.TABLE_ALIAS_TOKENS, new Set([TokenType.ANTI, TokenType.SEMI])),
    setUnion(Parser.TABLE_INDEX_HINT_TOKENS, new Set([TokenType.STRAIGHT_JOIN])),
  );

  /** py:89 */
  static RANGE_PARSERS = new Map([
    ...Parser.RANGE_PARSERS,
    [TokenType.MEMBER_OF, (self, this_) => self.expression(
      new exp.JSONArrayContains({ this: this_, expression: self._parse_wrapped(() => self._parse_expression()) }),
    )],
  ]);

  /** py:96 */
  static FUNCTIONS = new Map([
    ...Parser.FUNCTIONS,
    ["BIT_AND", exp.BitwiseAndAgg.from_arg_list],
    ["BIT_OR", exp.BitwiseOrAgg.from_arg_list],
    ["BIT_XOR", exp.BitwiseXorAgg.from_arg_list],
    ["BIT_COUNT", exp.BitwiseCount.from_arg_list],
    ["CONVERT_TZ", (args) => new exp.ConvertTimezone({
      source_tz: seqGet(args, 1), target_tz: seqGet(args, 2), timestamp: seqGet(args, 0),
    })],
    ["CURDATE", exp.CurrentDate.from_arg_list],
    ["CURTIME", exp.CurrentTime.from_arg_list],
    ["DATE", (args) => new exp.TsOrDsToDate({ this: seqGet(args, 0) })],
    ["DATEDIFF", (args) => new exp.DateDiff({
      this: seqGet(args, 0), expression: seqGet(args, 1), date_part_boundary: true,
    })],
    ["DATE_ADD", build_date_delta_with_interval(exp.DateAdd)],
    ["DATE_FORMAT", (args) => new exp.TimeToStr({
      this: new exp.TsOrDsToTimestamp({ this: seqGet(args, 0) }),
      format: Dialect.get_or_raise("mysql").format_time(seqGet(args, 1)),
    })],
    ["DATE_SUB", build_date_delta_with_interval(exp.DateSub)],
    ["DAY", (args) => new exp.Day({ this: new exp.TsOrDsToDate({ this: seqGet(args, 0) }) })],
    ["DAYOFMONTH", (args) => new exp.DayOfMonth({ this: new exp.TsOrDsToDate({ this: seqGet(args, 0) }) })],
    ["DAYOFWEEK", (args) => new exp.DayOfWeek({ this: new exp.TsOrDsToDate({ this: seqGet(args, 0) }) })],
    ["DAYOFYEAR", (args) => new exp.DayOfYear({ this: new exp.TsOrDsToDate({ this: seqGet(args, 0) }) })],
    ["FORMAT", exp.NumberToStr.from_arg_list],
    ["FROM_UNIXTIME", build_formatted_time(exp.UnixToTime)],
    ["ISNULL", isnull_to_is_null],
    ["LENGTH", (args) => new exp.Length({ this: seqGet(args, 0), binary: true })],
    ["MAKETIME", exp.TimeFromParts.from_arg_list],
    ["MONTH", (args) => new exp.Month({ this: new exp.TsOrDsToDate({ this: seqGet(args, 0) }) })],
    ["MONTHNAME", (args) => new exp.TimeToStr({
      this: new exp.TsOrDsToDate({ this: seqGet(args, 0) }),
      format: exp.Literal.string("%B"),
    })],
    ["SCHEMA", exp.CurrentSchema.from_arg_list],
    ["DATABASE", exp.CurrentSchema.from_arg_list],
    ["STR_TO_DATE", _str_to_date],
    ["TIMESTAMPDIFF", build_date_delta(exp.TimestampDiff)],
    ["TO_DAYS", (args) => exp.paren(
      // deny:operators sqlglot/parsers/mysql.py:136 — Python `+ 1` on an Expr
      // (`__add__`) builds `exp.Add`; `.add(1)` is this port's `_binop` equivalent.
      new exp.DateDiff({
        this: new exp.TsOrDsToDate({ this: seqGet(args, 0) }),
        expression: new exp.TsOrDsToDate({ this: exp.Literal.string("0000-01-01") }),
        unit: exp.var("DAY"),
      }).add(1),
    )],
    ["VERSION", exp.CurrentVersion.from_arg_list],
    ["WEEK", (args) => new exp.Week({
      this: new exp.TsOrDsToDate({ this: seqGet(args, 0) }), mode: seqGet(args, 1),
    })],
    ["WEEKOFYEAR", (args) => new exp.WeekOfYear({ this: new exp.TsOrDsToDate({ this: seqGet(args, 0) }) })],
    ["YEAR", (args) => new exp.Year({ this: new exp.TsOrDsToDate({ this: seqGet(args, 0) }) })],
  ]);

  /** py:151 */
  static FUNCTION_PARSERS = new Map([
    ...Parser.FUNCTION_PARSERS,
    ["GROUP_CONCAT", (self) => self._parse_group_concat()],
    // https://dev.mysql.com/doc/refman/5.7/en/miscellaneous-functions.html#function_values
    ["VALUES", (self) => self.expression(
      new exp.Anonymous({ this: "VALUES", expressions: [self._parse_id_var()] }),
    )],
    ["JSON_VALUE", (self) => self._parse_json_value()],
    ["SUBSTR", (self) => self._parse_substring()],
  ]);

  /** py:162 */
  static STATEMENT_PARSERS = new Map([
    ...Parser.STATEMENT_PARSERS,
    [TokenType.SHOW, (self) => self._parse_show()],
  ]);

  /** py:167 */
  static SHOW_PARSERS = new Map([
    ["BINARY LOGS", _show_parser("BINARY LOGS")],
    ["MASTER LOGS", _show_parser("BINARY LOGS")],
    ["BINLOG EVENTS", _show_parser("BINLOG EVENTS")],
    ["CHARACTER SET", _show_parser("CHARACTER SET")],
    ["CHARSET", _show_parser("CHARACTER SET")],
    ["COLLATION", _show_parser("COLLATION")],
    ["FULL COLUMNS", _show_parser("COLUMNS", { target: "FROM", full: true })],
    ["COLUMNS", _show_parser("COLUMNS", { target: "FROM" })],
    ["CREATE DATABASE", _show_parser("CREATE DATABASE", { target: true })],
    ["CREATE EVENT", _show_parser("CREATE EVENT", { target: true })],
    ["CREATE FUNCTION", _show_parser("CREATE FUNCTION", { target: true })],
    ["CREATE PROCEDURE", _show_parser("CREATE PROCEDURE", { target: true })],
    ["CREATE TABLE", _show_parser("CREATE TABLE", { target: true })],
    ["CREATE TRIGGER", _show_parser("CREATE TRIGGER", { target: true })],
    ["CREATE VIEW", _show_parser("CREATE VIEW", { target: true })],
    ["DATABASES", _show_parser("DATABASES")],
    ["SCHEMAS", _show_parser("DATABASES")],
    ["ENGINE", _show_parser("ENGINE", { target: true })],
    ["STORAGE ENGINES", _show_parser("ENGINES")],
    ["ENGINES", _show_parser("ENGINES")],
    ["ERRORS", _show_parser("ERRORS")],
    ["EVENTS", _show_parser("EVENTS")],
    ["FUNCTION CODE", _show_parser("FUNCTION CODE", { target: true })],
    ["FUNCTION STATUS", _show_parser("FUNCTION STATUS")],
    ["GRANTS", _show_parser("GRANTS", { target: "FOR" })],
    ["INDEX", _show_parser("INDEX", { target: "FROM" })],
    ["MASTER STATUS", _show_parser("MASTER STATUS")],
    ["OPEN TABLES", _show_parser("OPEN TABLES")],
    ["PLUGINS", _show_parser("PLUGINS")],
    ["PROCEDURE CODE", _show_parser("PROCEDURE CODE", { target: true })],
    ["PROCEDURE STATUS", _show_parser("PROCEDURE STATUS")],
    ["PRIVILEGES", _show_parser("PRIVILEGES")],
    ["FULL PROCESSLIST", _show_parser("PROCESSLIST", { full: true })],
    ["PROCESSLIST", _show_parser("PROCESSLIST")],
    ["PROFILE", _show_parser("PROFILE")],
    ["PROFILES", _show_parser("PROFILES")],
    ["RELAYLOG EVENTS", _show_parser("RELAYLOG EVENTS")],
    ["REPLICAS", _show_parser("REPLICAS")],
    ["SLAVE HOSTS", _show_parser("REPLICAS")],
    ["REPLICA STATUS", _show_parser("REPLICA STATUS")],
    ["SLAVE STATUS", _show_parser("REPLICA STATUS")],
    ["GLOBAL STATUS", _show_parser("STATUS", { global_: true })],
    ["SESSION STATUS", _show_parser("STATUS")],
    ["STATUS", _show_parser("STATUS")],
    ["TABLE STATUS", _show_parser("TABLE STATUS")],
    ["FULL TABLES", _show_parser("TABLES", { full: true })],
    ["TABLES", _show_parser("TABLES")],
    ["TRIGGERS", _show_parser("TRIGGERS")],
    ["GLOBAL VARIABLES", _show_parser("VARIABLES", { global_: true })],
    ["SESSION VARIABLES", _show_parser("VARIABLES")],
    ["VARIABLES", _show_parser("VARIABLES")],
    ["WARNINGS", _show_parser("WARNINGS")],
  ]);

  /** py:222 */
  static PROPERTY_PARSERS = new Map([
    ...Parser.PROPERTY_PARSERS,
    ["LOCK", (self) => self._parse_property_assignment(exp.LockProperty)],
    ["PARTITION BY", (self) => self._parse_partition_property()],
  ]);

  /** py:228 */
  static SET_PARSERS = new Map([
    ...Parser.SET_PARSERS,
    ["PERSIST", (self) => self._parse_set_item_assignment("PERSIST")],
    ["PERSIST_ONLY", (self) => self._parse_set_item_assignment("PERSIST_ONLY")],
    ["CHARACTER SET", (self) => self._parse_set_item_charset("CHARACTER SET")],
    ["CHARSET", (self) => self._parse_set_item_charset("CHARACTER SET")],
    ["NAMES", (self) => self._parse_set_item_names()],
  ]);

  /* py:237 */ static SHOW_TRIE = newTrie([...this.SHOW_PARSERS.keys()].map((key) => key.split(" ")));
  /* py:238 */ static SET_TRIE = newTrie([...this.SET_PARSERS.keys()].map((key) => key.split(" ")));

  /** py:240 */
  static CONSTRAINT_PARSERS = new Map([
    ...Parser.CONSTRAINT_PARSERS,
    ["FULLTEXT", (self) => self._parse_index_constraint("FULLTEXT")],
    ["INDEX", (self) => self._parse_index_constraint()],
    ["KEY", (self) => self._parse_index_constraint()],
    ["SPATIAL", (self) => self._parse_index_constraint("SPATIAL")],
    ["ZEROFILL", (self) => self.expression(new exp.ZeroFillColumnConstraint())],
    ["INVISIBLE", (self) => self.expression(new exp.InvisibleColumnConstraint())],
  ]);

  /** py:250 */
  static ALTER_PARSERS = new Map([
    ...Parser.ALTER_PARSERS,
    ["CHANGE", (self) => self._parse_alter_table_modify(true)],
    ["MODIFY", (self) => self._parse_alter_table_modify()],
    ["AUTO_INCREMENT", (self) => self._parse_property_assignment(exp.AutoIncrementProperty)],
  ]);

  /** py:257 */
  static ALTER_ALTER_PARSERS = new Map([
    ...Parser.ALTER_ALTER_PARSERS,
    ["INDEX", (self) => self._parse_alter_table_alter_index()],
  ]);

  /** py:262 */
  static SCHEMA_UNNAMED_CONSTRAINTS = new Set([
    ...Parser.SCHEMA_UNNAMED_CONSTRAINTS,
    "FULLTEXT",
    "INDEX",
    "KEY",
    "SPATIAL",
  ]);

  /** py:270 */
  static PROFILE_TYPES = new Map([
    ...["ALL", "CPU", "IPC", "MEMORY", "SOURCE", "SWAPS"].map((k) => [k, []]),
    ["BLOCK", ["IO"]],
    ["CONTEXT", ["SWITCHES"]],
    ["PAGE", ["FAULTS"]],
  ]);

  /** py:277 */
  static TYPE_TOKENS = new Set([...Parser.TYPE_TOKENS, TokenType.SET]);

  /** py:282 */
  static ENUM_TYPE_TOKENS = new Set([...Parser.ENUM_TYPE_TOKENS, TokenType.SET]);

  // py:287 SELECT [ ALL | DISTINCT | DISTINCTROW ] [ <OPERATION_MODIFIERS> ]
  /** py:288 */
  static OPERATION_MODIFIERS = new Set([
    "HIGH_PRIORITY",
    "STRAIGHT_JOIN",
    "SQL_SMALL_RESULT",
    "SQL_BIG_RESULT",
    "SQL_BUFFER_RESULT",
    "SQL_NO_CACHE",
    "SQL_CALC_FOUND_ROWS",
  ]);

  /* py:298 */ static LOG_DEFAULTS_TO_LN = true;
  /* py:299 */ static STRING_ALIASES = true;
  /* py:300 */ static VALUES_FOLLOWED_BY_PAREN = false;
  /* py:301 */ static SUPPORTS_PARTITION_SELECTION = true;

  /** py:303 */
  _parse_column_constraint() {
    if (this._match(TokenType.KEY)) {
      return this.expression(new exp.ColumnConstraint({ kind: this._parse_primary_key() }));
    }

    return super._parse_column_constraint();
  }

  /** py:309 */
  _parse_range(this_ = null) {
    this_ = this_ || this._parse_bitwise();

    if (this._match_text_seq("SOUNDS", "LIKE")) {
      this_ = this.expression(new exp.EQ({
        this: this.expression(new exp.Soundex({ this: this_ })),
        expression: this.expression(new exp.Soundex({ this: this._parse_bitwise() })),
      }));
      // MySQL evaluates = and IS left to right because they have the same precedence.
      if (this._match(TokenType.IS, false)) {
        this_ = this.expression(new exp.Paren({ this: this_ }));
      }
    }

    return super._parse_range(this_);
  }

  /** py:325 */
  _parse_alter_table_rename() {
    if (this._match_texts(["INDEX", "KEY"])) {
      const old = this._parse_field(true);
      this._match_text_seq("TO");
      const new_ = this._parse_field(true);
      return this.expression(new exp.RenameIndex({ this: old, to: new_ }));
    }
    return super._parse_alter_table_rename();
  }

  /** py:333 */
  _parse_alter_drop_action() {
    if (this._match_pair(TokenType.DROP, TokenType.PRIMARY_KEY)) {
      return this.expression(new exp.DropPrimaryKey());
    }
    return super._parse_alter_drop_action();
  }

  /** py:338 */
  _parse_alter_table_modify(rename = false) {
    // MODIFY [COLUMN]            col_name      column_definition [FIRST | AFTER col_name]
    // CHANGE [COLUMN] old_col_name new_col_name column_definition [FIRST | AFTER col_name]
    this._match(TokenType.COLUMN);

    let column = this._parse_field(true);
    if (column === null) return null;

    let rename_from = null;
    if (rename) {
      rename_from = column;
      column = this._parse_field(true);
      if (column === null) return null;
    }

    const column_def = this._parse_column_def(column);
    if (!(column_def instanceof exp.ColumnDef)) return null;

    return this.expression(new exp.ModifyColumn({ this: column_def, rename_from }));
  }

  /** py:360 */
  _parse_generated_as_identity() {
    const this_ = super._parse_generated_as_identity();

    if (this._match_texts(["STORED", "VIRTUAL"])) {
      const persisted = this._prev.text.toUpperCase() === "STORED";

      if (this_ instanceof exp.ComputedColumnConstraint) {
        this_.set("persisted", persisted);
      } else if (this_ instanceof exp.GeneratedAsIdentityColumnConstraint) {
        return this.expression(new exp.ComputedColumnConstraint({ this: this_.expression, persisted }));
      }
    }

    return this_;
  }

  /** py:381 */
  _parse_primary_key_part() {
    const this_ = this._parse_id_var();
    if (!this._match(TokenType.L_PAREN)) return this_;

    const expression = this._parse_number();
    this._match_r_paren();
    return this.expression(new exp.ColumnPrefix({ this: this_, expression }));
  }

  /** py:390 */
  _parse_index_constraint(kind = null) {
    if (kind) this._match_texts(["INDEX", "KEY"]);

    const this_ = this._parse_id_var(false);
    const index_type = this._match(TokenType.USING) && this._advance_any() && this._prev.text;
    const expressions = this._parse_wrapped_csv(() => this._parse_ordered());

    const options = [];
    while (true) {
      let opt;
      if (this._match_text_seq("KEY_BLOCK_SIZE")) {
        this._match(TokenType.EQ);
        opt = new exp.IndexConstraintOption({ key_block_size: this._parse_number() });
      } else if (this._match(TokenType.USING)) {
        opt = new exp.IndexConstraintOption({ using: this._advance_any() && this._prev.text });
      } else if (this._match_text_seq("WITH", "PARSER")) {
        opt = new exp.IndexConstraintOption({ parser: this._parse_var(true) });
      } else if (this._match(TokenType.COMMENT)) {
        opt = new exp.IndexConstraintOption({ comment: this._parse_string() });
      } else if (this._match_text_seq("VISIBLE")) {
        opt = new exp.IndexConstraintOption({ visible: true });
      } else if (this._match_text_seq("INVISIBLE")) {
        opt = new exp.IndexConstraintOption({ visible: false });
      } else if (this._match_text_seq("ENGINE_ATTRIBUTE")) {
        this._match(TokenType.EQ);
        opt = new exp.IndexConstraintOption({ engine_attr: this._parse_string() });
      } else if (this._match_text_seq("SECONDARY_ENGINE_ATTRIBUTE")) {
        this._match(TokenType.EQ);
        opt = new exp.IndexConstraintOption({ secondary_engine_attr: this._parse_string() });
      } else {
        opt = null;
      }

      if (!opt) break;

      options.push(opt);
    }

    return this.expression(new exp.IndexColumnConstraint({
      this: this_,
      expressions,
      kind,
      index_type,
      options,
    }));
  }

  /** py:437 */
  _parse_show_mysql(this_, target = false, full = null, global_ = null) {
    const json = this._match_text_seq("JSON");

    let target_id;
    if (target) {
      if (typeof target === "string") this._match_text_seq(...target.split(" "));
      target_id = this._parse_id_var();
    } else {
      target_id = null;
    }

    const index = this._index;
    let log;
    if (this._match_text_seq("IN")) {
      log = this._parse_string();
      if (log === null) this._retreat(index);
    } else {
      log = null;
    }

    let position, db;
    if (this_ === "BINLOG EVENTS" || this_ === "RELAYLOG EVENTS") {
      position = this._match_text_seq("FROM") ? this._parse_number() : null;
      db = null;
    } else {
      position = null;
      db = null;

      if (this._match(TokenType.FROM) || this._match_text_seq("IN")) {
        db = this._parse_id_var();
      } else if (this._match(TokenType.DOT)) {
        db = target_id;
        target_id = this._parse_id_var();
      }
    }

    const channel = this._match_text_seq("FOR", "CHANNEL") ? this._parse_id_var() : null;

    const like = this._match_text_seq("LIKE") ? this._parse_string() : null;
    const where = this._parse_where();

    let types, query, offset, limit;
    if (this_ === "PROFILE") {
      types = this._parse_csv(() => this._parse_var_from_options(this.constructor.PROFILE_TYPES));
      query = this._match_text_seq("FOR", "QUERY") ? this._parse_number() : null;
      offset = this._match_text_seq("OFFSET") ? this._parse_number() : null;
      limit = this._match_text_seq("LIMIT") ? this._parse_number() : null;
    } else {
      types = null;
      query = null;
      [offset, limit] = this._parse_oldstyle_limit();
    }

    let mutex = this._match_text_seq("MUTEX") ? true : null;
    mutex = this._match_text_seq("STATUS") ? false : mutex;

    const for_table = this._match_text_seq("FOR", "TABLE") ? this._parse_id_var() : null;
    const for_group = this._match_text_seq("FOR", "GROUP") ? this._parse_string() : null;
    const for_user = this._match_text_seq("FOR", "USER") ? this._parse_string() : null;
    const for_role = this._match_text_seq("FOR", "ROLE") ? this._parse_string() : null;
    const into_outfile = this._match_text_seq("INTO", "OUTFILE") ? this._parse_string() : null;

    return this.expression(new exp.Show({
      this: this_,
      target: target_id,
      full,
      log,
      position,
      db,
      channel,
      like,
      where,
      types,
      query,
      offset,
      limit,
      mutex,
      for_table,
      for_group,
      for_user,
      for_role,
      into_outfile,
      json,
      global_,
    }));
  }

  /** py:523 */
  _parse_oldstyle_limit() {
    let limit = null;
    let offset = null;
    if (this._match_text_seq("LIMIT")) {
      const parts = this._parse_csv(() => this._parse_number());
      if (parts.length === 1) {
        limit = parts[0];
      } else if (parts.length === 2) {
        limit = parts[1];
        offset = parts[0];
      }
    }

    return [offset, limit];
  }

  /** py:538 */
  _parse_set_item_charset(kind) {
    const this_ = this._parse_string() || this._parse_unquoted_field();
    return this.expression(new exp.SetItem({ this: this_, kind }));
  }

  /**
   * py:542
   *
   * Preserve quoting when a charset name has characters that require it (e.g. spaces,
   * as allowed for custom XML-registered charsets). Safe names unwrap to a bare Var so
   * roundtrips remain minimal.
   */
  _parse_charset_name() {
    const identifier = this._parse_identifier();
    if (identifier) {
      const name = identifier.name;
      return exp.SAFE_IDENTIFIER_RE.test(name) ? new exp.Var({ this: name }) : identifier;
    }
    return this._parse_var(false, new Set([TokenType.BINARY]));
  }

  /** py:556 */
  _parse_set_item_names() {
    const charset = this._parse_string() || this._parse_unquoted_field();
    const collate = this._match_text_seq("COLLATE")
      ? (this._parse_string() || this._parse_unquoted_field())
      : null;

    return this.expression(new exp.SetItem({ this: charset, collate, kind: "NAMES" }));
  }

  /** py:565 */
  _parse_type(parse_interval = true, fallback_to_identifier = false) {
    // mysql binary is special and can work anywhere, even in order by operations
    // it operates like a no paren func
    if (this._match(TokenType.BINARY, false)) {
      const data_type = this._parse_types(true, false, false);

      if (data_type instanceof exp.DataType) {
        return this.expression(new exp.Cast({ this: this._parse_column(), to: data_type }));
      }
    }

    return super._parse_type(parse_interval, fallback_to_identifier);
  }

  /** py:580 */
  _parse_alter_table_alter_index() {
    const index = this._parse_field(true);

    let visible;
    if (this._match_text_seq("VISIBLE")) {
      visible = true;
    } else if (this._match_text_seq("INVISIBLE")) {
      visible = false;
    } else {
      visible = null;
    }

    return this.expression(new exp.AlterIndex({ this: index, visible }));
  }

  /** py:592 */
  _parse_partition_property() {
    let partition_cls = null;
    let value_parser = null;

    if (this._match_text_seq("RANGE")) {
      partition_cls = exp.PartitionByRangeProperty;
      value_parser = () => this._parse_partition_range_value();
    } else if (this._match_text_seq("LIST")) {
      partition_cls = exp.PartitionByListProperty;
      value_parser = () => this._parse_partition_list_value();
    }

    if (!partition_cls || !value_parser) return null;

    const partition_expressions = this._parse_wrapped_csv(() => this._parse_assignment());

    // For Doris and Starrocks
    if (!this._match_text_seq("(", "PARTITION", { advance: false })) return partition_expressions;

    const create_expressions = this._parse_wrapped_csv(value_parser);

    return this.expression(new partition_cls({ partition_expressions, create_expressions }));
  }

  /** py:622 */
  _parse_partition_range_value() {
    this._match_text_seq("PARTITION");
    const name = this._parse_id_var();

    if (!this._match_text_seq("VALUES", "LESS", "THAN")) return name;

    let values = this._parse_wrapped_csv(() => this._parse_expression());

    if (
      values.length === 1 &&
      values[0] instanceof exp.Column &&
      values[0].name.toUpperCase() === "MAXVALUE"
    ) {
      values = [exp.var("MAXVALUE")];
    }

    const part_range = this.expression(new exp.PartitionRange({ this: name, expressions: values }));
    return this.expression(new exp.Partition({ expressions: [part_range] }));
  }

  /** py:641 */
  _parse_partition_list_value() {
    this._match_text_seq("PARTITION");
    const name = this._parse_id_var();
    this._match_text_seq("VALUES", "IN");
    const values = this._parse_wrapped_csv(() => this._parse_expression());
    const part_list = this.expression(new exp.PartitionList({ this: name, expressions: values }));
    return this.expression(new exp.Partition({ expressions: [part_list] }));
  }

  /** py:649 */
  _parse_primary_key(wrapped_optional = false, in_props = false, named_primary_key = false) {
    return super._parse_primary_key(wrapped_optional, in_props, true);
  }
}
