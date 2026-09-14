// py: sqlglot/parsers/tsql.py @ 91119bc
//
// `class TSQLParser(parser.Parser)` — the READ-side SQL Server / Azure SQL Database
// grammar. Fourth in PORT_PLAN.md §10's dialect priority order (after Snowflake,
// Postgres, DuckDB), and self-contained the same way: it extends the base `Parser`
// directly rather than sitting in a subclass chain. `sqlglot/dialects/tsql.py` (the
// `TSQL(Dialect)` SETTINGS class) and `sqlglot/generators/tsql.py` stay P5/P7,
// deferred to follow-up sessions — the same phased split every prior dialect port
// used (Snowflake PR #24, Postgres PR #28, DuckDB PR #31).
//
// Two real forward-dependency gaps fall out of that split, both handled the way
// `annotate_types`/`_to_interval` are handled in postgres.js — a file-local stub
// that throws `NotPorted` rather than fabricating or duplicating data that belongs
// to a not-yet-ported component:
//
//   * `_build_formatted_time` and `_build_format` (upstream :133, :166) both do
//     `from sqlglot.dialects.tsql import TSQL` INSIDE their own function body — a
//     REAL circular-import workaround upstream (`dialects/tsql.py` imports
//     `TSQLParser` FROM this file, so this file cannot import `TSQL` back at module
//     level), not merely a phasing artifact. `_tsqlSettings()` below reproduces that
//     unavailability honestly until `src/dialects/tsql.js` exists.
//
// The two static-field rules `snowflake.js`/`postgres.js` document apply here
// unchanged: a subclass's STATIC FIELD INITIALIZER names its parent explicitly, and
// an INSTANCE METHOD reads a class table through `self.constructor.X`, never a bare
// `self.X`.
//
// Table shape, decided per table from upstream, same three shapes as Postgres:
//
//   * EXTEND (`{**parser.Parser.X, ...}`): NO_PAREN_FUNCTIONS, QUERY_MODIFIER_PARSERS
//     (also OVERWRITES the inherited FOR key — T-SQL's FOR XML/JSON/BROWSE replaces
//     base's FOR-UPDATE-style row locking), FUNCTIONS, STATEMENT_PARSERS,
//     RANGE_PARSERS, NO_PAREN_FUNCTION_PARSERS, FUNCTION_PARSERS, COLUMN_OPERATORS
//     (also OVERWRITES the inherited DCOLON key).
//   * REPLACE outright (bare literal): JOIN_HINTS, PROCEDURE_OPTIONS,
//     COLUMN_DEFINITION_MODES, RETURNS_TABLE_TOKENS, SET_OP_MODIFIERS,
//     ODBC_DATETIME_LITERALS.
//   * DIFFERENCE/UNION the parent (`X - {...}` / `X | {...}`): ID_VAR_TOKENS,
//     ALIAS_TOKENS, TABLE_ALIAS_TOKENS (union AND diff), COMMENT_TABLE_ALIAS_TOKENS,
//     UPDATE_ALIAS_TOKENS — T-SQL does not allow BEGIN as an identifier, so every one
//     of these drops it.

import { Parser, build_coalesce, build_extract_json_with_path, setDiff, setUnion } from "../parser.js";
import { TokenType } from "../tokens.js";
import { seqGet } from "../helper.js";
import { pyLower, pyUpper, cpLen, pyZfill } from "../_py/str.js";
import { NotPorted } from "../errors.js";
import * as exp from "../expressions/index.js";
import { build_date_delta, map_date_part } from "../dialects/dialect.js";
import { formatTime } from "../time.js";

/** py: sqlglot/parsers/tsql.py:22 */
const FULL_FORMAT_TIME_MAPPING = new Map([
  ["weekday", "%A"], ["dw", "%A"], ["w", "%A"],
  ["month", "%B"], ["mm", "%B"], ["m", "%B"],
]);

/** py: sqlglot/parsers/tsql.py:31 */
const DATE_DELTA_INTERVAL = new Map([
  ["year", "year"], ["yyyy", "year"], ["yy", "year"],
  ["quarter", "quarter"], ["qq", "quarter"], ["q", "quarter"],
  ["month", "month"], ["mm", "month"], ["m", "month"],
  ["week", "week"], ["ww", "week"], ["wk", "week"],
  ["day", "day"], ["dd", "day"], ["d", "day"],
]);

/** py: sqlglot/parsers/tsql.py:49 */
const DATE_FMT_RE = /([dD]{1,2})|([mM]{1,2})|([yY]{1,4})|([hH]{1,2})|([sS]{1,2})/;

/** py: sqlglot/parsers/tsql.py:52 -- N = Numeric, C = Currency */
const TRANSPILE_SAFE_NUMBER_FMT = new Set(["N", "C"]);

/**
 * py: sqlglot/parsers/tsql.py:54 `DEFAULT_START_DATE = datetime.date(1900, 1, 1)`,
 * used at :220 via `DEFAULT_START_DATE + datetime.timedelta(days=...)` then
 * `.strftime("%F")`. `days` arrives as the BigInt `Literal.toPy()` returns for an
 * int literal (the `start_date.is_int` guard above every call site gates on exactly
 * that), so it is widened to Number before the day-granularity arithmetic -- safe
 * here since T-SQL day offsets never approach `Number.MAX_SAFE_INTEGER`.
 */
const DEFAULT_START_DATE_UTC_MS = Date.UTC(1900, 0, 1);
function _addDaysToDefaultStartDate(days) {
  const d = new Date(DEFAULT_START_DATE_UTC_MS + Number(days) * 86400000);
  const pad = (n) => pyZfill(String(n), 2);
  return `${pyZfill(String(d.getUTCFullYear()), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// Unsupported options:
// - OPTIMIZE FOR ( @variable_name { UNKNOWN | = <literal_constant> } [ , ...n ] )
// - TABLE HINT
/**
 * py: sqlglot/parsers/tsql.py:59 `OPTIONS: parser.OPTIONS_TYPE`
 *
 * `parser.OPTIONS_TYPE` is `dict[str, tuple[str | tuple[str, ...], ...]]` -- a
 * continuation-keyword-sequence table read by `_parse_var_from_options`
 * (parser.js:6239). A single bare string entry like `("UNION",)` is ONE one-word
 * continuation; a nested tuple like `(("FOR", "UNKNOWN"),)` is ONE multi-word
 * continuation. `dict.fromkeys((...), tuple())` gives every name in that list an
 * EMPTY continuation list (a bare option, matched with no trailing words).
 */
const OPTIONS = new Map([
  ...[
    "DISABLE_OPTIMIZED_PLAN_FORCING", "FAST", "IGNORE_NONCLUSTERED_COLUMNSTORE_INDEX",
    "LABEL", "MAXDOP", "MAXRECURSION", "MAX_GRANT_PERCENT", "MIN_GRANT_PERCENT",
    "NO_PERFORMANCE_SPOOL", "QUERYTRACEON", "RECOMPILE",
  ].map((k) => [k, []]),
  ["CONCAT", ["UNION"]],
  ["DISABLE", ["EXTERNALPUSHDOWN", "SCALEOUTEXECUTION"]],
  ["EXPAND", ["VIEWS"]],
  ["FORCE", ["EXTERNALPUSHDOWN", "ORDER", "SCALEOUTEXECUTION"]],
  ["HASH", ["GROUP", "JOIN", "UNION"]],
  ["KEEP", ["PLAN"]],
  ["KEEPFIXED", ["PLAN"]],
  ["LOOP", ["JOIN"]],
  ["MERGE", ["JOIN", "UNION"]],
  ["OPTIMIZE", [["FOR", "UNKNOWN"]]],
  ["ORDER", ["GROUP"]],
  ["PARAMETERIZATION", ["FORCED", "SIMPLE"]],
  ["ROBUST", ["PLAN"]],
  ["USE", ["PLAN"]],
]);

/** py: sqlglot/parsers/tsql.py:93 */
const FOR_XML_OPTIONS = new Map([
  ...["AUTO", "EXPLICIT", "TYPE"].map((k) => [k, []]),
  ["ELEMENTS", ["XSINIL", "ABSENT"]],
  ["BINARY", ["BASE64"]],
]);

// FOR JSON { AUTO | PATH } [, ROOT [ ( 'name' ) ] ] [, INCLUDE_NULL_VALUES ]
//                          [, WITHOUT_ARRAY_WRAPPER ]
// https://learn.microsoft.com/en-us/sql/relational-databases/json/format-query-results-as-json-with-for-json-sql-server
/** py: sqlglot/parsers/tsql.py:113 */
const FOR_JSON_OPTIONS = new Map(
  ["AUTO", "PATH", "INCLUDE_NULL_VALUES", "WITHOUT_ARRAY_WRAPPER"].map((k) => [k, []]),
);

/**
 * py: sqlglot/parsers/tsql.py:124
 *
 * Read by nothing in this file -- `sqlglot/generators/tsql.py:21` imports it
 * (`from sqlglot.parsers.tsql import OPTIONS_THAT_REQUIRE_EQUAL`) for its own
 * `_parse_for`-mirroring OPTION rendering. That Generator is P7/deferred (this PR is
 * parser-only), so exporting it here -- rather than dropping it as unreachable dead
 * code -- is what keeps the eventual `generators/tsql.js` import working the same
 * way the upstream cross-module import does.
 */
export const OPTIONS_THAT_REQUIRE_EQUAL = new Set(["MAX_GRANT_PERCENT", "MIN_GRANT_PERCENT", "LABEL"]);

/**
 * py: sqlglot/parsers/tsql.py:133, :166
 *
 * See the file header: both `_build_formatted_time` and `_build_format` read
 * `TSQL.TIME_MAPPING` / `TSQL.FORMAT_TIME_MAPPING` off the not-yet-ported
 * `src/dialects/tsql.js` settings class. Throwing here -- rather than copying the
 * two mapping tables into this file as a second source of truth that would drift
 * from the real ones once the Dialect-settings session lands them -- is deliberate.
 */
function _tsqlSettings() {
  throw new NotPorted(
    "TSQL dialect settings (TIME_MAPPING / FORMAT_TIME_MAPPING)",
    "sqlglot/dialects/tsql.py",
  );
}

/** py: sqlglot/parsers/tsql.py:127 */
function _build_formatted_time(exp_class, full_format_mapping = null) {
  return (args) => {
    let fmt = seqGet(args, 0);
    if (fmt instanceof exp.Expr) {
      const TSQL = _tsqlSettings();
      fmt = exp.Literal.string(
        formatTime(
          pyLower(fmt.name),
          full_format_mapping
            ? new Map([...TSQL.TIME_MAPPING, ...FULL_FORMAT_TIME_MAPPING])
            : TSQL.TIME_MAPPING,
        ),
      );
    }

    let this_ = seqGet(args, 1);
    if (this_ instanceof exp.Expr) this_ = exp.cast(this_, exp.DType.DATETIME2);

    return new exp_class({ this: this_, format: fmt });
  };
}

/** py: sqlglot/parsers/tsql.py:155 */
function _build_format(args) {
  const this_ = seqGet(args, 0);
  let fmt = seqGet(args, 1);
  const culture = seqGet(args, 2);

  const number_fmt = fmt && (TRANSPILE_SAFE_NUMBER_FMT.has(fmt.name) || !DATE_FMT_RE.test(fmt.name));

  if (number_fmt) {
    return new exp.NumberToStr({ this: this_, format: fmt, culture });
  }

  if (fmt) {
    const TSQL = _tsqlSettings();
    fmt = exp.Literal.string(
      cpLen(fmt.name) === 1
        ? formatTime(fmt.name, TSQL.FORMAT_TIME_MAPPING)
        : formatTime(fmt.name, TSQL.TIME_MAPPING),
    );
  }

  return new exp.TimeToStr({ this: this_, format: fmt, culture });
}

/** py: sqlglot/parsers/tsql.py:177 */
function _build_eomonth(args) {
  const date = new exp.TsOrDsToDate({ this: seqGet(args, 0) });
  const month_lag = seqGet(args, 1);

  let this_;
  if (month_lag === null || month_lag === undefined) {
    this_ = date;
  } else {
    const unit = DATE_DELTA_INTERVAL.get("month");
    // py: `unit and exp.var(unit)` -- `unit` is always the truthy string "month"
    // here, but the ternary preserves the Python `and` operand-return shape rather
    // than assuming it (R18).
    this_ = new exp.DateAdd({ this: date, expression: month_lag, unit: unit ? exp.var(unit) : unit });
  }

  return new exp.LastDay({ this: this_ });
}

/** py: sqlglot/parsers/tsql.py:190 */
function _build_hashbytes(args) {
  let [kind, data] = args;
  kind = kind.is_string ? pyUpper(kind.name) : "";

  if (kind === "MD5") {
    args.shift();
    return new exp.MD5({ this: data });
  }
  if (kind === "SHA" || kind === "SHA1") {
    args.shift();
    return new exp.SHA({ this: data });
  }
  if (kind === "SHA2_256") return new exp.SHA2({ this: data, length: exp.Literal.number(256) });
  if (kind === "SHA2_512") return new exp.SHA2({ this: data, length: exp.Literal.number(512) });

  return exp.func("HASHBYTES", ...args);
}

/** py: sqlglot/parsers/tsql.py:208 */
function _build_date_delta(exp_class, unit_mapping = null, big_int = false) {
  return (args) => {
    let unit = seqGet(args, 0);
    if (unit && unit_mapping) {
      const key = pyLower(unit.name);
      unit = exp.var(unit_mapping.has(key) ? unit_mapping.get(key) : unit.name);
    }

    let start_date = seqGet(args, 1);
    if (start_date && start_date.is_number) {
      // Numeric types are valid DATETIME values
      if (start_date.is_int) {
        start_date = exp.Literal.string(_addDaysToDefaultStartDate(start_date.toPy()));
      } else {
        // We currently don't handle float values, i.e. they're not converted to equivalent DATETIMEs.
        // This is not a problem when generating T-SQL code, it is when transpiling to other dialects.
        return new exp_class({ this: seqGet(args, 2), expression: start_date, unit, big_int });
      }
    }

    return new exp_class({
      this: new exp.TimeStrToTime({ this: seqGet(args, 2) }),
      expression: new exp.TimeStrToTime({ this: start_date }),
      unit,
      big_int,
    });
  };
}

// https://learn.microsoft.com/en-us/sql/t-sql/functions/datetimefromparts-transact-sql?view=sql-server-ver16#syntax
/** py: sqlglot/parsers/tsql.py:240 */
function _build_datetimefromparts(args) {
  return new exp.TimestampFromParts({
    year: seqGet(args, 0),
    month: seqGet(args, 1),
    day: seqGet(args, 2),
    hour: seqGet(args, 3),
    min: seqGet(args, 4),
    sec: seqGet(args, 5),
    milli: seqGet(args, 6),
  });
}

// https://learn.microsoft.com/en-us/sql/t-sql/functions/timefromparts-transact-sql?view=sql-server-ver16#syntax
/** py: sqlglot/parsers/tsql.py:253 */
function _build_timefromparts(args) {
  return new exp.TimeFromParts({
    hour: seqGet(args, 0),
    min: seqGet(args, 1),
    sec: seqGet(args, 2),
    fractions: seqGet(args, 3),
    precision: seqGet(args, 4),
  });
}

/** py: sqlglot/parsers/tsql.py:263 */
function _build_with_arg_as_text(klass) {
  return (args) => {
    let this_ = seqGet(args, 0);

    if (this_ && !this_.is_string) this_ = exp.cast(this_, exp.DType.TEXT);

    const expression = seqGet(args, 1);
    const kwargs = { this: this_ };

    if (expression) kwargs.expression = expression;

    return new klass(kwargs);
  };
}

// https://learn.microsoft.com/en-us/sql/t-sql/functions/parsename-transact-sql?view=sql-server-ver16
/** py: sqlglot/parsers/tsql.py:284 */
function _build_parsename(args) {
  // PARSENAME(...) will be stored into exp.SplitPart if:
  // - All args are literals
  // - The part index (2nd arg) is <= 4 (max valid value, otherwise TSQL returns NULL)
  if (args.length === 2 && args.every((arg) => arg instanceof exp.Literal)) {
    const this_ = args[0];
    const part_index = args[1];
    const split_count = this_.name.split(".").length;
    if (split_count <= 4) {
      return new exp.SplitPart({
        this: this_,
        delimiter: exp.Literal.string("."),
        part_index: exp.Literal.number(split_count + 1 - Number(part_index.toPy())),
      });
    }
  }

  return new exp.Anonymous({ this: "PARSENAME", expressions: args });
}

/** py: sqlglot/parsers/tsql.py:302 */
function _build_json_query(args, dialect) {
  if (args.length === 1) {
    // The default value for path is '$'. As a result, if you don't provide a
    // value for path, JSON_QUERY returns the input expression.
    args.push(exp.Literal.string("$"));
  }

  return build_extract_json_with_path(exp.JSONExtract)(args, dialect);
}

/** py: sqlglot/parsers/tsql.py:311 */
function _build_datetrunc(args) {
  const unit = seqGet(args, 0);
  let this_ = seqGet(args, 1);

  if (this_ && this_.is_string) this_ = exp.cast(this_, exp.DType.DATETIME2);

  return new exp.TimestampTrunc({ this: this_, unit });
}

/** py: sqlglot/parsers/tsql.py:321 */
export class TSQLParser extends Parser {
  /* py:322 */ static SET_REQUIRES_ASSIGNMENT_DELIMITER = false;
  /* py:323 */ static LOG_DEFAULTS_TO_LN = true;
  /* py:324 */ static STRING_ALIASES = true;
  /* py:325 */ static NO_PAREN_IF_COMMANDS = false;
  /* py:326 */ static UNPIVOT_VALUE_COLUMNS_FIRST = true;

  /** py: sqlglot/parsers/tsql.py:328 */
  static NO_PAREN_FUNCTIONS = new Map([
    /* py:329 */ ...Parser.NO_PAREN_FUNCTIONS,
    /* py:330 */ [TokenType.SESSION_USER, exp.SessionUser],
  ]);

  // py:334 OVERWRITES the inherited FOR entry (base maps it to `_parse_locks`, the
  // ANSI FOR UPDATE/FOR SHARE row-locking clause T-SQL doesn't have) with T-SQL's own
  // FOR XML/JSON/BROWSE clause parser.
  /** py: sqlglot/parsers/tsql.py:333 */
  static QUERY_MODIFIER_PARSERS = new Map([
    /* py:334 */ ...Parser.QUERY_MODIFIER_PARSERS,
    /* py:335 */ [TokenType.OPTION, (self) => ["options", self._parse_options()]],
    /* py:336 */ [TokenType.FOR, (self) => ["for_", self._parse_for()]],
  ]);

  // T-SQL does not allow BEGIN to be used as an identifier
  /** py: sqlglot/parsers/tsql.py:340 */
  static ID_VAR_TOKENS = setDiff(Parser.ID_VAR_TOKENS, new Set([TokenType.BEGIN]));
  /** py: sqlglot/parsers/tsql.py:341 */
  static ALIAS_TOKENS = setDiff(Parser.ALIAS_TOKENS, new Set([TokenType.BEGIN]));
  /** py: sqlglot/parsers/tsql.py:342 */
  static TABLE_ALIAS_TOKENS = setDiff(
    setUnion(Parser.TABLE_ALIAS_TOKENS, new Set([TokenType.ANTI, TokenType.SEMI])),
    new Set([TokenType.BEGIN]),
  );
  /** py: sqlglot/parsers/tsql.py:345 */
  static COMMENT_TABLE_ALIAS_TOKENS = setDiff(Parser.COMMENT_TABLE_ALIAS_TOKENS, new Set([TokenType.BEGIN]));
  /** py: sqlglot/parsers/tsql.py:346 */
  static UPDATE_ALIAS_TOKENS = setDiff(Parser.UPDATE_ALIAS_TOKENS, new Set([TokenType.BEGIN]));

  /** py: sqlglot/parsers/tsql.py:348 */
  static FUNCTIONS = new Map([
    /* py:349 */ ...Parser.FUNCTIONS,
    /* py:350 */ ["ATN2", exp.Atan2.from_arg_list],
    /* py:351 */ ["CHARINDEX", (args) => new exp.StrPosition({
      this: seqGet(args, 1), substr: seqGet(args, 0), position: seqGet(args, 2),
    })],
    /* py:356 */ ["COUNT", (args) => new exp.Count({ this: seqGet(args, 0), expressions: args.slice(1), big_int: false })],
    /* py:357 */ ["COUNT_BIG", (args) => new exp.Count({ this: seqGet(args, 0), expressions: args.slice(1), big_int: true })],
    /* py:360 */ ["DATEADD", build_date_delta(exp.DateAdd, DATE_DELTA_INTERVAL)],
    /* py:361 */ ["DATEDIFF", _build_date_delta(exp.DateDiff, DATE_DELTA_INTERVAL)],
    /* py:362 */ ["DATEDIFF_BIG", _build_date_delta(exp.DateDiff, DATE_DELTA_INTERVAL, true)],
    /* py:365 */ ["DATENAME", _build_formatted_time(exp.TimeToStr, true)],
    /* py:366 */ ["DATETIMEFROMPARTS", _build_datetimefromparts],
    /* py:367 */ ["DAY", (args) => new exp.Day({
      this: new exp.TsOrDsToDate({ this: seqGet(args, 0), default_date: exp.Literal.string("1900-01-01") }),
    })],
    /* py:372 */ ["EOMONTH", _build_eomonth],
    /* py:373 */ ["FORMAT", _build_format],
    /* py:374 */ ["GETDATE", exp.CurrentTimestamp.from_arg_list],
    /* py:375 */ ["HASHBYTES", _build_hashbytes],
    /* py:376 */ ["ISNULL", (args) => build_coalesce(args, null, true)],
    /* py:377 */ ["JSON_QUERY", _build_json_query],
    /* py:378 */ ["JSON_VALUE", build_extract_json_with_path(exp.JSONExtractScalar)],
    /* py:379 */ ["LEN", _build_with_arg_as_text(exp.Length)],
    /* py:380 */ ["LEFT", _build_with_arg_as_text(exp.Left)],
    /* py:381 */ ["MONTH", (args) => new exp.Month({
      this: new exp.TsOrDsToDate({ this: seqGet(args, 0), default_date: exp.Literal.string("1900-01-01") }),
    })],
    /* py:386 */ ["NEWID", exp.Uuid.from_arg_list],
    /* py:387 */ ["RIGHT", _build_with_arg_as_text(exp.Right)],
    /* py:388 */ ["PARSENAME", _build_parsename],
    /* py:389 */ ["REPLICATE", exp.Repeat.from_arg_list],
    /* py:390 */ ["SCHEMA_NAME", exp.CurrentSchema.from_arg_list],
    /* py:391 */ ["SQUARE", (args) => new exp.Pow({ this: seqGet(args, 0), expression: exp.Literal.number(2) })],
    /* py:392 */ ["SYSDATETIME", exp.CurrentTimestamp.from_arg_list],
    /* py:393 */ ["SUSER_NAME", exp.CurrentUser.from_arg_list],
    /* py:394 */ ["SUSER_SNAME", exp.CurrentUser.from_arg_list],
    /* py:395 */ ["SYSDATETIMEOFFSET", exp.CurrentTimestampLTZ.from_arg_list],
    /* py:396 */ ["SYSTEM_USER", exp.CurrentUser.from_arg_list],
    /* py:397 */ ["TIMEFROMPARTS", _build_timefromparts],
    /* py:398 */ ["DATETRUNC", _build_datetrunc],
    /* py:399 */ ["YEAR", (args) => new exp.Year({
      this: new exp.TsOrDsToDate({ this: seqGet(args, 0), default_date: exp.Literal.string("1900-01-01") }),
    })],
  ]);

  /** py: sqlglot/parsers/tsql.py:406 */
  static JOIN_HINTS = new Set(["LOOP", "HASH", "MERGE", "REMOTE"]);

  /** py: sqlglot/parsers/tsql.py:408 */
  static PROCEDURE_OPTIONS = new Map(
    ["ENCRYPTION", "RECOMPILE", "SCHEMABINDING", "NATIVE_COMPILATION", "EXECUTE"].map((k) => [k, []]),
  );

  /** py: sqlglot/parsers/tsql.py:412 */
  static COLUMN_DEFINITION_MODES = new Set(["OUT", "OUTPUT", "READONLY"]);

  /** py: sqlglot/parsers/tsql.py:414 */
  static RETURNS_TABLE_TOKENS = setDiff(
    Parser.ID_VAR_TOKENS,
    new Set([TokenType.TABLE, ...Parser.TYPE_TOKENS]),
  );

  /** py: sqlglot/parsers/tsql.py:419 */
  static STATEMENT_PARSERS = new Map([
    /* py:420 */ ...Parser.STATEMENT_PARSERS,
    /* py:421 */ [TokenType.EXECUTE, (self) => self._parse_execute()],
  ]);

  /** py: sqlglot/parsers/tsql.py:424 */
  static RANGE_PARSERS = new Map([
    /* py:425 */ ...Parser.RANGE_PARSERS,
    /* py:426 */ [TokenType.DCOLON, (self, this_) => self.expression(new exp.ScopeResolution({
      this: this_, expression: self._parse_function() || self._parse_var(true),
    }))],
  ]);

  /** py: sqlglot/parsers/tsql.py:433 */
  static NO_PAREN_FUNCTION_PARSERS = new Map([
    /* py:434 */ ...Parser.NO_PAREN_FUNCTION_PARSERS,
    /* py:435 */ ["NEXT", (self) => self._parse_next_value_for()],
  ]);

  /** py: sqlglot/parsers/tsql.py:438 */
  static FUNCTION_PARSERS = new Map([
    /* py:439 */ ...Parser.FUNCTION_PARSERS,
    /* py:440 */ ["JSON_ARRAYAGG", (self) => self.expression(new exp.JSONArrayAgg({
      this: self._parse_bitwise(),
      order: self._parse_order(),
      null_handling: self._parse_on_handling("NULL", "NULL", "ABSENT"),
    }))],
    /* py:447 */ ["DATEPART", (self) => self._parse_datepart()],
  ]);

  // The DCOLON (::) operator serves as a scope resolution (exp.ScopeResolution) operator in T-SQL
  /** py: sqlglot/parsers/tsql.py:451 */
  static COLUMN_OPERATORS = new Map([
    /* py:452 */ ...Parser.COLUMN_OPERATORS,
    /* py:453 */ [TokenType.DCOLON, (self, this_, to) => (
      to instanceof exp.DataType && to.this !== exp.DType.USERDEFINED
        ? self.expression(new exp.Cast({ this: this_, to }))
        : self.expression(new exp.ScopeResolution({ this: this_, expression: to }))
    )],
  ]);

  /** py: sqlglot/parsers/tsql.py:460 */
  static SET_OP_MODIFIERS = new Set(["offset"]);

  /** py: sqlglot/parsers/tsql.py:462 */
  static ODBC_DATETIME_LITERALS = new Map([
    /* py:463 */ ["d", exp.Date],
    /* py:464 */ ["t", exp.Time],
    /* py:465 */ ["ts", exp.Timestamp],
  ]);

  /** py: sqlglot/parsers/tsql.py:468 */
  _parse_execute() {
    let return_status = null;
    const index = this._index;
    if (this._match(TokenType.PARAMETER)) {
      const param = this._parse_parameter();
      if (this._match(TokenType.EQ)) {
        return_status = param;
      } else {
        this._retreat(index);
      }
    }

    let execute = this.expression(new exp.Execute({
      this: this._parse_table(true),
      expressions: this._parse_csv(() => this._parse_expression()),
      return_status,
    }));

    if (pyLower(execute.name) === "sp_executesql") {
      execute = this.expression(new exp.ExecuteSql({ ...execute.args }));
    }

    return execute;
  }

  /** py: sqlglot/parsers/tsql.py:491 */
  _parse_datepart() {
    const this_ = this._parse_var(false, new Set([TokenType.IDENTIFIER]));
    const expression = this._match(TokenType.COMMA) && this._parse_bitwise();
    const name = map_date_part(this_, this.dialect);

    return this.expression(new exp.Extract({ this: name, expression }));
  }

  /** py: sqlglot/parsers/tsql.py:498 */
  _parse_alter_table_set() {
    return this._parse_wrapped(() => super._parse_alter_table_set());
  }

  /** py: sqlglot/parsers/tsql.py:501 */
  _parse_wrapped_select(table = false) {
    if (this._match(TokenType.MERGE)) {
      const comments = this._prev_comments;
      const merge = this._parse_merge();
      merge.addComments(comments, true);
      return merge;
    }

    return super._parse_wrapped_select(table);
  }

  /** py: sqlglot/parsers/tsql.py:510 */
  // We want to use _parse_types() if the first token after :: is a known type,
  // otherwise we could parse something like x::varchar(max) into a function
  _parse_dcolon() {
    if (this._match_set(this.constructor.TYPE_TOKENS, false)) {
      return this._parse_types();
    }

    return this._parse_function() || this._parse_types();
  }

  /** py: sqlglot/parsers/tsql.py:518 */
  _parse_options() {
    if (!this._match(TokenType.OPTION)) return null;

    const _parse_option = () => {
      const option = this._parse_var_from_options(OPTIONS);
      if (!option) return null;

      this._match(TokenType.EQ);
      return this.expression(new exp.QueryOption({ this: option, expression: this._parse_primary_or_var() }));
    };

    return this._parse_wrapped_csv(_parse_option);
  }

  /** py: sqlglot/parsers/tsql.py:534 */
  _parse_key_value_option() {
    const this_ = this._parse_primary_or_var();
    const expression = this._match(TokenType.L_PAREN, false)
      ? this._parse_wrapped(() => this._parse_string())
      : null;

    return new exp.XMLKeyValueOption({ this: this_, expression });
  }

  /** py: sqlglot/parsers/tsql.py:543 */
  _parse_for_clause_option(options) {
    return this.expression(new exp.QueryOption({
      this: this._parse_var_from_options(options, false) || this._parse_key_value_option(),
    }));
  }

  /** py: sqlglot/parsers/tsql.py:551 */
  _parse_for() {
    if (this._match_pair(TokenType.FOR, TokenType.XML)) {
      return this.expression(new exp.ForClause({
        kind: "XML",
        expressions: this._parse_csv(() => this._parse_for_clause_option(FOR_XML_OPTIONS)),
      }));
    }

    if (this._match_pair(TokenType.FOR, TokenType.JSON)) {
      return this.expression(new exp.ForClause({
        kind: "JSON",
        expressions: this._parse_csv(() => this._parse_for_clause_option(FOR_JSON_OPTIONS)),
      }));
    }

    // FOR BROWSE — bare keyword, no options. BROWSE has no dedicated TokenType.
    if (this._match_text_seq("FOR", "BROWSE")) {
      return this.expression(new exp.ForClause({ kind: "BROWSE" }));
    }

    return null;
  }

  /**
   * py: sqlglot/parsers/tsql.py:578
   *
   * T-SQL supports the syntax alias = expression in the SELECT's projection list,
   * so we transform all parsed Selects to convert their EQ projections into Aliases.
   *
   * See: https://learn.microsoft.com/en-us/sql/t-sql/queries/select-clause-transact-sql?view=sql-server-ver16#syntax
   */
  _parse_projections() {
    const [projections] = super._parse_projections();
    return [
      projections.map((projection) => (
        projection instanceof exp.EQ && projection.this instanceof exp.Column
          ? exp.alias_(projection.expression, projection.this.this, { copy: false })
          : projection
      )),
      null,
    ];
  }

  /**
   * py: sqlglot/parsers/tsql.py:597
   *
   * Applies to SQL Server and Azure SQL Database
   * COMMIT [ { TRAN | TRANSACTION }
   *     [ transaction_name | @tran_name_variable ] ]
   *     [ WITH ( DELAYED_DURABILITY = { OFF | ON } ) ]
   *
   * ROLLBACK { TRAN | TRANSACTION }
   *     [ transaction_name | @tran_name_variable
   *     | savepoint_name | @savepoint_variable ]
   */
  _parse_commit_or_rollback() {
    const rollback = this._prev.token_type === TokenType.ROLLBACK;

    this._match_texts(["TRAN", "TRANSACTION"]);
    const this_ = this._parse_id_var();

    if (rollback) return this.expression(new exp.Rollback({ this: this_ }));

    let durability = null;
    if (this._match_pair(TokenType.WITH, TokenType.L_PAREN)) {
      this._match_text_seq("DELAYED_DURABILITY");
      this._match(TokenType.EQ);

      if (this._match_text_seq("OFF")) {
        durability = false;
      } else {
        this._match(TokenType.ON);
        durability = true;
      }

      this._match_r_paren();
    }

    return this.expression(new exp.Commit({ this: this_, durability }));
  }

  /**
   * py: sqlglot/parsers/tsql.py:630
   *
   * Applies to SQL Server and Azure SQL Database
   * BEGIN { TRAN | TRANSACTION }
   * [ { transaction_name | @tran_name_variable }
   * [ WITH MARK [ 'description' ] ]
   * ]
   */
  _parse_transaction() {
    if (this._match_texts(["TRAN", "TRANSACTION"])) {
      const transaction = this.expression(new exp.Transaction({ this: this._parse_id_var() }));
      if (this._match_text_seq("WITH", "MARK")) {
        transaction.set("mark", this._parse_string());
      }

      return transaction;
    }

    return this._parse_as_command(this._prev);
  }

  /** py: sqlglot/parsers/tsql.py:646 */
  _parse_returns() {
    const table = this._parse_id_var(false, this.constructor.RETURNS_TABLE_TOKENS);
    const returns = super._parse_returns();
    returns.set("table", table);
    return returns;
  }

  /** py: sqlglot/parsers/tsql.py:652 */
  _parse_convert(strict, safe = null) {
    const this_ = this._parse_types();
    this._match(TokenType.COMMA);
    const args = [this_, ...this._parse_csv(() => this._parse_assignment())];
    const convert = exp.Convert.from_arg_list(args);
    convert.set("safe", safe);
    return convert;
  }

  /** py: sqlglot/parsers/tsql.py:660 */
  _parse_column_def(this_, computed_column = true) {
    this_ = super._parse_column_def(this_, computed_column);
    if (!this_) return null;
    if (this._match(TokenType.EQ)) this_.set("default", this._parse_disjunction());
    if (this._match_texts(this.constructor.COLUMN_DEFINITION_MODES)) this_.set("output", this._prev.text);
    return this_;
  }

  /** py: sqlglot/parsers/tsql.py:672 */
  _parse_user_defined_function(kind = null) {
    const this_ = super._parse_user_defined_function(kind);

    if (kind === TokenType.FUNCTION || this_ instanceof exp.UserDefinedFunction) {
      return this_;
    }

    if (kind === TokenType.PROCEDURE && this_) {
      let expressions = this_.expressions;
      if (!(expressions?.length || this._match_set(new Set([TokenType.ALIAS, TokenType.WITH]), false))) {
        expressions = this._parse_csv(() => this._parse_function_parameter());
      }

      return this.expression(new exp.StoredProcedure({
        this: this_ instanceof exp.Table ? this_ : this_.this,
        expressions,
        wrapped: this_.args.wrapped,
      }));
    }

    return this.expression(new exp.UserDefinedFunction({ this: this_ }));
  }

  /** py: sqlglot/parsers/tsql.py:695 */
  _parse_into() {
    const into = super._parse_into();

    const table = into instanceof exp.Into && into.find(exp.Table);
    if (table instanceof exp.Table) {
      const table_identifier = table.this;
      if (table_identifier.args.temporary) {
        // Promote the temporary property from the Identifier to the Into expression
        into.set("temporary", true);
      }
    }

    return into;
  }

  /** py: sqlglot/parsers/tsql.py:707 */
  _parse_id_var(any_token = true, tokens = null) {
    const is_temporary = this._match(TokenType.HASH);
    const is_global = is_temporary && this._match(TokenType.HASH);

    const this_ = super._parse_id_var(any_token, tokens);
    if (this_) {
      if (is_global) this_.set("global_", true);
      else if (is_temporary) this_.set("temporary", true);
    }

    return this_;
  }

  /** py: sqlglot/parsers/tsql.py:724 */
  _parse_table_parts(schema = false, is_db_reference = false, wildcard = false, fast = false) {
    const table = super._parse_table_parts(schema, is_db_reference, wildcard, fast);
    if (
      table instanceof exp.Table
      && table.this instanceof exp.Identifier
      && table.name.startsWith("#")
    ) {
      const table_name = table.name;
      if (table_name.startsWith("##")) {
        table.this.set("this", table_name.slice(2));
        table.this.set("global_", true);
      } else {
        table.this.set("this", table_name.slice(1));
        table.this.set("temporary", true);
      }
    }

    return table;
  }

  /** py: sqlglot/parsers/tsql.py:751 */
  _parse_create() {
    const create = super._parse_create();

    if (create instanceof exp.Create) {
      const table = create.this instanceof exp.Schema ? create.this.this : create.this;
      if (table instanceof exp.Table && table.this && table.this.args.temporary) {
        if (!create.args.properties) {
          create.set("properties", new exp.Properties({ expressions: [] }));
        }

        create.args.properties.append("expressions", new exp.TemporaryProperty());
      }
    }

    return create;
  }

  /** py: sqlglot/parsers/tsql.py:764 */
  _parse_if() {
    const this_ = this._parse_condition();
    const true_ = this._parse_block();

    const false_ = this._match(TokenType.ELSE) && this._parse_block();

    return this.expression(new exp.IfBlock({ this: this_, true: true_, false: false_ }));
  }

  /** py: sqlglot/parsers/tsql.py:772 */
  _parse_unique() {
    let this_;
    if (this._match_texts(["CLUSTERED", "NONCLUSTERED"])) {
      this_ = this.constructor.CONSTRAINT_PARSERS.get(pyUpper(this._prev.text))(this);
    } else {
      this_ = this._parse_schema(this._parse_id_var(false));
    }

    return this.expression(new exp.UniqueColumnConstraint({ this: this_ }));
  }

  /** py: sqlglot/parsers/tsql.py:780 */
  _parse_update() {
    const expression = super._parse_update();
    expression.set("options", this._parse_options());
    return expression;
  }

  /** py: sqlglot/parsers/tsql.py:785 */
  _parse_partition() {
    if (!this._match_text_seq("WITH", "(", "PARTITIONS")) return null;

    const parse_range = () => {
      const low = this._parse_bitwise();
      const high = this._match_text_seq("TO") ? this._parse_bitwise() : null;

      return high ? this.expression(new exp.PartitionRange({ this: low, expression: high })) : low;
    };

    const partition = this.expression(new exp.Partition({ expressions: this._parse_wrapped_csv(parse_range) }));

    this._match_r_paren();

    return partition;
  }

  /** py: sqlglot/parsers/tsql.py:801 */
  _parse_alter_table_alter() {
    const expression = super._parse_alter_table_alter();

    if (expression !== null && expression !== undefined) {
      const collation = expression.args.collate;
      if (collation instanceof exp.Column && collation.this instanceof exp.Identifier) {
        const identifier = collation.this;
        collation.set("this", new exp.Var({ this: identifier.name }));
      }

      if (expression.args.dtype) {
        if (this._match_pair(TokenType.NOT, TokenType.NULL)) {
          expression.set("allow_null", false);
        } else if (this._match(TokenType.NULL)) {
          expression.set("allow_null", true);
        }
      }
    }

    return expression;
  }

  /** py: sqlglot/parsers/tsql.py:818 */
  _parse_primary_key_part() {
    return this._parse_ordered();
  }
}
