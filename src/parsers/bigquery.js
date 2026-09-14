// py: sqlglot/parsers/bigquery.py @ 91119bc
//
// `class BigQueryParser(parser.Parser)` — the READ-side BigQuery grammar. First of the
// three dialects in Ben's 2026-09-14 priority order (BigQuery, Redshift, TSQL), and
// self-contained: it extends the base `Parser` directly, like `snowflake.js`,
// `postgres.js` and `duckdb.js`, rather than sitting in a chain the way
// `hive <- spark2 <- spark <- databricks` does. `sqlglot/dialects/bigquery.py` (the
// `BigQuery(Dialect)` SETTINGS class) stays a follow-up session, the same split every
// prior dialect port used — this PR is PARSER ONLY.
//
// The two static-field rules the earlier ports document apply here unchanged:
//
//   * A subclass's STATIC FIELD INITIALIZER names its parent explicitly
//     (`new Map([...Parser.X, ...])` / `setUnion(Parser.X, ...)`), evaluated once at
//     module load.
//   * An INSTANCE METHOD — or a lambda stored in a table and later called with `self`
//     — reads a class table through `self.constructor`, never a bare `self.X`.
//     `BRACKET_OFFSETS` below depends on this; a bare `self.BRACKET_OFFSETS` would read
//     `undefined` (PORT_PLAN.md R20).
//
// Whether a table EXTENDS, REPLACES or FILTERS its parent is decided per table from
// upstream, and BigQuery uses all three shapes:
//
//   * EXTEND (`{**parser.Parser.X, ...}`): NO_PAREN_FUNCTIONS, NESTED_TYPE_TOKENS,
//     PROPERTY_PARSERS, CONSTRAINT_PARSERS, STATEMENT_PARSERS.
//   * REPLACE outright (no parent spread — the table is BigQuery-specific and has no
//     base-`Parser` counterpart): DASHED_TABLE_PART_FOLLOW_TOKENS, BRACKET_OFFSETS.
//   * FILTER the parent (a dict comprehension over `parser.Parser.X.items()`):
//     FUNCTIONS drops SEARCH, FUNCTION_PARSERS drops TRIM, RANGE_PARSERS drops
//     OVERLAPS.
//
// The four ID/alias token sets (`ID_VAR_TOKENS`, `ALIAS_TOKENS`, `TABLE_ALIAS_TOKENS`,
// `COMMENT_TABLE_ALIAS_TOKENS`, `UPDATE_ALIAS_TOKENS`) are each `{*parent, GRANT} -
// {ASC, DESC}` (and `ALIAS_TOKENS` additionally drops `*JOIN_SIDES`) — BigQuery allows
// GRANT as an identifier but disallows ASC/DESC, the opposite of the base grammar's
// defaults. Getting only the union or only the difference half of any of these right
// is the same two-part-move trap `duckdb.js`/`postgres.js` document for their own
// token-set moves.

import { Parser, build_extract_json_with_path, setDiff, setUnion } from "../parser.js";
import { TokenType } from "../tokens.js";
import { seqGet, splitNumWords } from "../helper.js";
import { pyUpper } from "../_py/str.js";
import { pyTruthy } from "../_py/truthy.js";
import { pyReGroups, PyReError } from "../_py/re.js";
import { kernelSql } from "../generator_kernel.js";
import { NotPorted } from "../errors.js";
import * as exp from "../expressions/index.js";
import {
  binary_from_function,
  build_date_delta_with_interval,
  build_formatted_time,
} from "../dialects/dialect.js";

/**
 * py: sqlglot/optimizer/annotate_types.py — NOT PORTED.
 *
 * `_parse_unnest` imports this INSIDE its own body upstream (`parsers/bigquery.py:613`),
 * so a file-local stub mirrors upstream's own structure rather than widening
 * `dialects/dialect.js`'s export surface with a member that is not part of
 * `dialects/dialect.py` at all. Same reasoning, and same P6+ scope, as the
 * identically-named stub in `postgres.js`.
 */
function annotate_types(_expression, _dialect) {
  throw new NotPorted("annotate_types", "sqlglot/optimizer/annotate_types.py");
}

/** py: sqlglot/parsers/bigquery.py:20 */
function _build_contains_substring(args) {
  const this_ = new exp.Lower({ this: seqGet(args, 0) });
  const expr = new exp.Lower({ this: seqGet(args, 1) });
  return new exp.Contains({ this: this_, expression: expr, json_scope: seqGet(args, 2) });
}

/** py: sqlglot/parsers/bigquery.py:26 */
function _build_date(args) {
  const expr_type = args.length === 3 ? exp.DateFromParts : exp.Date;
  return expr_type.from_arg_list(args);
}

/** py: sqlglot/parsers/bigquery.py:31 */
function _normalize_bare_week(expr) {
  // In BigQuery, a bare WEEK date part is equivalent to WEEK(SUNDAY)
  const unit = expr.args.unit;
  if ((unit instanceof exp.Literal || unit instanceof exp.Var) && pyUpper(unit.name) === "WEEK") {
    expr.set("unit", new exp.WeekStart({ this: exp.var("SUNDAY") }));
  }

  return expr;
}

/** py: sqlglot/parsers/bigquery.py:40 */
function build_date_diff(expr_type) {
  return function _builder(args) {
    return _normalize_bare_week(
      new expr_type({
        this: seqGet(args, 0),
        expression: seqGet(args, 1),
        unit: seqGet(args, 2),
        date_part_boundary: true,
      }),
    );
  };
}

/** py: sqlglot/parsers/bigquery.py:56 */
function _build_datetime(args) {
  if (args.length === 1) return exp.TsOrDsToDatetime.from_arg_list(args);
  if (args.length === 2) return exp.Datetime.from_arg_list(args);
  return exp.TimestampFromParts.from_arg_list(args);
}

/** py: sqlglot/parsers/bigquery.py:64 */
function _build_extract_json_with_default_path(expr_type) {
  return function _builder(args, dialect) {
    if (args.length === 1) args.push(exp.Literal.string("$"));
    return build_extract_json_with_path(expr_type)(args, dialect);
  };
}

/** py: sqlglot/parsers/bigquery.py:75 */
function _build_format_time(expr_type) {
  return function _builder(args, dialect) {
    const formatted_time = build_formatted_time(exp.TimeToStr)(
      [new expr_type({ this: seqGet(args, 1) }), seqGet(args, 0)],
      dialect,
    );
    formatted_time.set("zone", seqGet(args, 2));
    return formatted_time;
  };
}

/** py: sqlglot/parsers/bigquery.py:86 */
function _build_json_strip_nulls(args) {
  const expression = new exp.JSONStripNulls({ this: seqGet(args, 0) });
  for (const arg of args.slice(1)) {
    if (arg instanceof exp.Kwarg) expression.set(arg.this.name.toLowerCase(), arg);
    else expression.set("expression", arg);
  }
  return expression;
}

/** py: sqlglot/parsers/bigquery.py:96 */
function _build_levenshtein(args) {
  const max_dist = seqGet(args, 2);
  return new exp.Levenshtein({
    this: seqGet(args, 0),
    expression: seqGet(args, 1),
    max_dist: max_dist ? max_dist.expression : null,
  });
}

/** py: sqlglot/parsers/bigquery.py:105 */
function _build_parse_date(args, dialect) {
  const this_ = build_formatted_time(exp.StrToDate)([seqGet(args, 1), seqGet(args, 0)], dialect);
  this_.set("default_year", exp.Literal.number(1970));
  return this_;
}

/** py: sqlglot/parsers/bigquery.py:111 */
function _build_parse_timestamp(args, dialect) {
  const this_ = build_formatted_time(exp.StrToTime)([seqGet(args, 1), seqGet(args, 0)], dialect);
  this_.set("zone", seqGet(args, 2));
  this_.set("default_year", exp.Literal.number(1970));
  return this_;
}

/** py: sqlglot/parsers/bigquery.py:118 */
function _build_parse_datetime(args, dialect) {
  const this_ = build_formatted_time(exp.ParseDatetime)([seqGet(args, 1), seqGet(args, 0)], dialect);
  this_.set("default_year", exp.Literal.number(1970));
  return this_;
}

/**
 * py: sqlglot/parsers/bigquery.py:124
 *
 * `re.compile(args[1].name).groups == 1` — group COUNTING over the Python regex
 * grammar, not a JS `RegExp` construction, so this routes through `_py/re.js`'s
 * `pyReGroups` (a pure-AST parse, never translated to a runtime JS pattern) rather than
 * `new RegExp`. `except re.error: group = False` becomes a `PyReError` catch.
 */
function _build_regexp_extract(expr_type, default_group = null) {
  return function _builder(args, dialect) {
    let group;
    try {
      group = pyReGroups(args[1].name) === 1;
    } catch (e) {
      if (e instanceof PyReError) group = false;
      else throw e;
    }

    const kwargs = {
      this: seqGet(args, 0),
      expression: seqGet(args, 1),
      position: seqGet(args, 2),
      occurrence: seqGet(args, 3),
      group: group ? exp.Literal.number(1) : default_group,
    };
    if (expr_type === exp.RegexpExtract) {
      kwargs.null_if_pos_overflow = dialect.REGEXP_EXTRACT_POSITION_OVERFLOW_RETURNS_NULL;
    }
    return new expr_type(kwargs);
  };
}

/** py: sqlglot/parsers/bigquery.py:147 */
function _build_time(args) {
  if (args.length === 1) return new exp.TsOrDsToTime({ this: args[0] });
  if (args.length === 2) return exp.Time.from_arg_list(args);
  return exp.TimeFromParts.from_arg_list(args);
}

/** py: sqlglot/parsers/bigquery.py:155 */
function _build_timestamp(args) {
  const timestamp = exp.Timestamp.from_arg_list(args);
  timestamp.set("with_tz", true);
  return timestamp;
}

/** py: sqlglot/parsers/bigquery.py:161 */
function _build_to_hex(args) {
  const arg = seqGet(args, 0);
  return arg instanceof exp.MD5Digest
    ? new exp.MD5({ this: arg.this })
    : new exp.LowerHex({ this: arg });
}

// py:166 — `_DOMAIN_DOT = "\0"` upstream: a placeholder that cannot occur in a SQL
// identifier. Written as the JS escape sequence, never a literal control byte in the
// source file (PORT_PLAN.md §4.2's control-byte lint bans the latter, not the former —
// the file's own bytes stay printable ASCII either way).
const _DOMAIN_DOT = "\u0000";

/**
 * py: sqlglot/parsers/bigquery.py:169 `_split_qualified_name(name, min_num_words)`
 *
 * A dotted reference (e.g. `project.dataset.table`) is split into a fixed number of
 * parts, the first of which is the project. Domain-scoped (legacy) project IDs have the
 * form `domain.com:project-id`, where the dots belong to the domain, not the path — and
 * a project ID itself can't contain dots, so every such dot precedes the colon. Mask
 * those, then let `splitNumWords` split and pad as usual, to avoid corrupting the
 * project ID. See: https://docs.cloud.google.com/artifact-registry/docs/docker/names#domain
 */
function _split_qualified_name(name, min_num_words) {
  const colon = name.indexOf(":");
  if (colon !== -1 && name.slice(0, colon).includes(".")) {
    name = name.slice(0, colon).split(".").join(_DOMAIN_DOT) + name.slice(colon);
    return splitNumWords(name, ".", min_num_words).map(
      (p) => p && p.split(_DOMAIN_DOT).join("."),
    );
  }

  return splitNumWords(name, ".", min_num_words);
}

/** py: sqlglot/parsers/bigquery.py:186 */
const MAKE_INTERVAL_KWARGS = ["year", "month", "day", "hour", "minute", "second"];

/** py: sqlglot/parsers/bigquery.py:189 */
export class BigQueryParser extends Parser {
  /* py:190 */ static PREFIXED_PIVOT_COLUMNS = true;
  /* py:191 */ static LOG_DEFAULTS_TO_LN = true;
  /* py:192 */ static SUPPORTS_IMPLICIT_UNNEST = true;
  /* py:193 */ static JOINS_HAVE_EQUAL_PRECEDENCE = true;
  /* py:194 */ static ADJACENT_STRINGS_CANNOT_BE_CONNECTED = true;
  /* py:195 */ static SUPPORTS_DIGIT_PREFIXED_FIELD_NAMES = true;

  // BigQuery does not allow ASC/DESC to be used as an identifier, allows GRANT as an
  // identifier.
  /** py: sqlglot/parsers/bigquery.py:198 */
  static ID_VAR_TOKENS = setDiff(
    setUnion(Parser.ID_VAR_TOKENS, new Set([TokenType.GRANT])),
    new Set([TokenType.ASC, TokenType.DESC]),
  );

  /** py: sqlglot/parsers/bigquery.py:203 */
  static ALIAS_TOKENS = setDiff(
    setUnion(Parser.ALIAS_TOKENS, new Set([TokenType.GRANT])),
    setUnion(new Set([TokenType.ASC, TokenType.DESC]), Parser.JOIN_SIDES),
  );

  /** py: sqlglot/parsers/bigquery.py:208 */
  static TABLE_ALIAS_TOKENS = setDiff(
    setUnion(Parser.TABLE_ALIAS_TOKENS, new Set([TokenType.ANTI, TokenType.GRANT, TokenType.SEMI])),
    new Set([TokenType.ASC, TokenType.DESC]),
  );

  /** py: sqlglot/parsers/bigquery.py:215 */
  static COMMENT_TABLE_ALIAS_TOKENS = setDiff(
    setUnion(Parser.COMMENT_TABLE_ALIAS_TOKENS, new Set([TokenType.GRANT])),
    new Set([TokenType.ASC, TokenType.DESC]),
  );

  /** py: sqlglot/parsers/bigquery.py:220 */
  static UPDATE_ALIAS_TOKENS = setDiff(
    setUnion(Parser.UPDATE_ALIAS_TOKENS, new Set([TokenType.GRANT])),
    new Set([TokenType.ASC, TokenType.DESC]),
  );

  /** py: sqlglot/parsers/bigquery.py:225 */
  static FUNCTIONS = new Map([
    // py:226 — FILTERS the parent before merging: BigQuery has no SEARCH.
    /* py:226 */ ...[...Parser.FUNCTIONS].filter(([k]) => k !== "SEARCH"),
    /* py:227 */ ["APPROX_TOP_COUNT", exp.ApproxTopK.from_arg_list],
    /* py:228 */ ["BIT_AND", exp.BitwiseAndAgg.from_arg_list],
    /* py:229 */ ["BIT_OR", exp.BitwiseOrAgg.from_arg_list],
    /* py:230 */ ["BIT_XOR", exp.BitwiseXorAgg.from_arg_list],
    /* py:231 */ ["BIT_COUNT", exp.BitwiseCount.from_arg_list],
    /* py:232 */ ["BOOL", exp.JSONBool.from_arg_list],
    /* py:233 */ ["CONTAINS_SUBSTR", _build_contains_substring],
    /* py:234 */ ["DATE", _build_date],
    /* py:235 */ ["DATE_ADD", build_date_delta_with_interval(exp.DateAdd)],
    /* py:236 */ ["DATE_DIFF", build_date_diff(exp.DateDiff)],
    /* py:237 */ ["DATE_SUB", build_date_delta_with_interval(exp.DateSub)],
    /* py:238 */ ["DATE_TRUNC", (args) => _normalize_bare_week(
      new exp.DateTrunc({ unit: seqGet(args, 1), this: seqGet(args, 0), zone: seqGet(args, 2) }),
    )],
    /* py:245 */ ["DATETIME", _build_datetime],
    /* py:246 */ ["DATETIME_ADD", build_date_delta_with_interval(exp.DatetimeAdd)],
    /* py:247 */ ["DATETIME_DIFF", build_date_diff(exp.DatetimeDiff)],
    /* py:248 */ ["DATETIME_SUB", build_date_delta_with_interval(exp.DatetimeSub)],
    /* py:249 */ ["DATETIME_TRUNC", (args) => _normalize_bare_week(exp.DatetimeTrunc.from_arg_list(args))],
    /* py:250 */ ["DIV", binary_from_function(exp.IntDiv)],
    /* py:251 */ ["EDIT_DISTANCE", _build_levenshtein],
    /* py:252 */ ["EMBED", exp.AIEmbed.from_arg_list],
    /* py:253 */ ["FORMAT_DATE", _build_format_time(exp.TsOrDsToDate)],
    /* py:254 */ ["GENERATE", exp.AIGenerate.from_arg_list],
    /* py:255 */ ["GENERATE_ARRAY", exp.GenerateSeries.from_arg_list],
    /* py:256 */ ["JSON_EXTRACT_SCALAR", _build_extract_json_with_default_path(exp.JSONExtractScalar)],
    /* py:257 */ ["JSON_EXTRACT_ARRAY", _build_extract_json_with_default_path(exp.JSONExtractArray)],
    /* py:258 */ ["JSON_EXTRACT_STRING_ARRAY", _build_extract_json_with_default_path(exp.JSONValueArray)],
    /* py:259 */ ["JSON_KEYS", exp.JSONKeysAtDepth.from_arg_list],
    /* py:260 */ ["JSON_QUERY", build_extract_json_with_path(exp.JSONExtract)],
    /* py:261 */ ["JSON_QUERY_ARRAY", _build_extract_json_with_default_path(exp.JSONExtractArray)],
    /* py:262 */ ["JSON_STRIP_NULLS", _build_json_strip_nulls],
    /* py:263 */ ["JSON_VALUE", _build_extract_json_with_default_path(exp.JSONExtractScalar)],
    /* py:264 */ ["JSON_VALUE_ARRAY", _build_extract_json_with_default_path(exp.JSONValueArray)],
    /* py:265 */ ["LAST_DAY", (args) => _normalize_bare_week(exp.LastDay.from_arg_list(args))],
    /* py:266 */ ["LENGTH", (args) => new exp.Length({ this: seqGet(args, 0), binary: true })],
    /* py:267 */ ["MD5", exp.MD5Digest.from_arg_list],
    /* py:268 */ ["SHA1", exp.SHA1Digest.from_arg_list],
    /* py:269 */ ["NORMALIZE_AND_CASEFOLD", (args) => new exp.Normalize({
      this: seqGet(args, 0), form: seqGet(args, 1), is_casefold: true,
    })],
    /* py:272 */ ["OCTET_LENGTH", exp.ByteLength.from_arg_list],
    /* py:273 */ ["TO_HEX", _build_to_hex],
    /* py:274 */ ["PARSE_DATE", _build_parse_date],
    /* py:275 */ ["PARSE_TIME", (args, dialect) => build_formatted_time(exp.ParseTime)(
      [seqGet(args, 1), seqGet(args, 0)], dialect,
    )],
    /* py:278 */ ["PARSE_TIMESTAMP", _build_parse_timestamp],
    /* py:279 */ ["PARSE_DATETIME", _build_parse_datetime],
    /* py:280 */ ["REGEXP_CONTAINS", exp.RegexpLike.from_arg_list],
    /* py:281 */ ["REGEXP_EXTRACT", _build_regexp_extract(exp.RegexpExtract)],
    /* py:282 */ ["REGEXP_SUBSTR", _build_regexp_extract(exp.RegexpExtract)],
    /* py:283 */ ["REGEXP_EXTRACT_ALL", _build_regexp_extract(exp.RegexpExtractAll, exp.Literal.number(0))],
    /* py:286 */ ["SHA256", (args) => new exp.SHA2Digest({ this: seqGet(args, 0), length: exp.Literal.number(256) })],
    /* py:289 */ ["SHA512", (args) => new exp.SHA2Digest({ this: seqGet(args, 0), length: exp.Literal.number(512) })],
    /* py:292 */ ["SIMILARITY", exp.AISimilarity.from_arg_list],
    /* py:293 */ ["SPLIT", (args) => new exp.Split({
      // https://cloud.google.com/bigquery/docs/reference/standard-sql/string_functions#split
      this: seqGet(args, 0),
      expression: seqGet(args, 1) || exp.Literal.string(","),
    })],
    /* py:298 */ ["STRPOS", exp.StrPosition.from_arg_list],
    /* py:299 */ ["TIME", _build_time],
    /* py:300 */ ["TIME_ADD", build_date_delta_with_interval(exp.TimeAdd)],
    /* py:301 */ ["TIME_SUB", build_date_delta_with_interval(exp.TimeSub)],
    /* py:302 */ ["TIMESTAMP", _build_timestamp],
    /* py:303 */ ["TIMESTAMP_ADD", build_date_delta_with_interval(exp.TimestampAdd)],
    /* py:304 */ ["TIMESTAMP_SUB", build_date_delta_with_interval(exp.TimestampSub)],
    /* py:305 */ ["TIMESTAMP_MICROS", (args) => new exp.UnixToTime({ this: seqGet(args, 0), scale: exp.UnixToTime.MICROS })],
    /* py:308 */ ["TIMESTAMP_MILLIS", (args) => new exp.UnixToTime({ this: seqGet(args, 0), scale: exp.UnixToTime.MILLIS })],
    /* py:311 */ ["TIMESTAMP_SECONDS", (args) => new exp.UnixToTime({ this: seqGet(args, 0) })],
    /* py:312 */ ["TIMESTAMP_TRUNC", (args) => _normalize_bare_week(exp.TimestampTrunc.from_arg_list(args))],
    /* py:315 */ ["TO_JSON", (args) => new exp.JSONFormat({ this: seqGet(args, 0), options: seqGet(args, 1), to_json: true })],
    /* py:318 */ ["TO_JSON_STRING", exp.JSONFormat.from_arg_list],
    /* py:319 */ ["FORMAT_DATETIME", _build_format_time(exp.TsOrDsToDatetime)],
    /* py:320 */ ["FORMAT_TIMESTAMP", _build_format_time(exp.TsOrDsToTimestamp)],
    /* py:321 */ ["FORMAT_TIME", _build_format_time(exp.TsOrDsToTime)],
    /* py:322 */ ["FROM_HEX", exp.Unhex.from_arg_list],
    /* py:323 */ ["WEEK", (args) => new exp.WeekStart({ this: exp.var(seqGet(args, 0)) })],
  ]);

  /** py: sqlglot/parsers/bigquery.py:326 */
  static FUNCTION_PARSERS = new Map([
    // py:327 — FILTERS the parent: BigQuery's TRIM is handled by base grammar, not a
    // dedicated FUNCTION_PARSERS entry.
    /* py:327 */ ...[...Parser.FUNCTION_PARSERS].filter(([k]) => k !== "TRIM"),
    /* py:328 */ ["ARRAY", (self) => self.expression(
      new exp.Array({ expressions: [self._parse_statement()], struct_name_inheritance: true }),
    )],
    /* py:331 */ ["JSON_ARRAY", (self) => self.expression(
      new exp.JSONArray({ expressions: self._parse_csv(self._parse_bitwise.bind(self)) }),
    )],
    /* py:334 */ ["MAKE_INTERVAL", (self) => self._parse_make_interval()],
    /* py:335 */ ["PREDICT", (self) => self._parse_ml(exp.Predict)],
    /* py:336 */ ["TRANSLATE", (self) => self._parse_translate()],
    /* py:337 */ ["FEATURES_AT_TIME", (self) => self._parse_features_at_time()],
    /* py:338 */ ["GENERATE_EMBEDDING", (self) => self._parse_ml(exp.GenerateEmbedding)],
    /* py:339 */ ["GENERATE_TEXT_EMBEDDING", (self) => self._parse_ml(exp.GenerateEmbedding, { is_text: true })],
    /* py:340 */ ["GENERATE_TEXT", (self) => self._parse_generate(exp.GenerateText)],
    /* py:341 */ ["GENERATE_TABLE", (self) => self._parse_generate(exp.GenerateTable)],
    /* py:342 */ ["GENERATE_BOOL", (self) => self._parse_generate(exp.GenerateBool)],
    /* py:343 */ ["GENERATE_INT", (self) => self._parse_generate(exp.GenerateInt)],
    /* py:344 */ ["GENERATE_DOUBLE", (self) => self._parse_generate(exp.GenerateDouble)],
    /* py:345 */ ["VECTOR_SEARCH", (self) => self._parse_vector_search()],
    /* py:346 */ ["FORECAST", (self) => self._parse_forecast()],
  ]);

  /** py: sqlglot/parsers/bigquery.py:349 */
  static NO_PAREN_FUNCTIONS = new Map([
    /* py:350 */ ...Parser.NO_PAREN_FUNCTIONS,
    /* py:351 */ [TokenType.CURRENT_DATETIME, exp.CurrentDatetime],
  ]);

  /** py: sqlglot/parsers/bigquery.py:354 */
  static NESTED_TYPE_TOKENS = new Set([
    /* py:355 */ ...Parser.NESTED_TYPE_TOKENS,
    /* py:356 */ TokenType.TABLE,
  ]);

  /** py: sqlglot/parsers/bigquery.py:359 */
  static PROPERTY_PARSERS = new Map([
    /* py:360 */ ...Parser.PROPERTY_PARSERS,
    /* py:361 */ ["OPTIONS", (self) => self._parse_with_property()],
  ]);

  /** py: sqlglot/parsers/bigquery.py:364 */
  static CONSTRAINT_PARSERS = new Map([
    /* py:365 */ ...Parser.CONSTRAINT_PARSERS,
    /* py:366 */ ["OPTIONS", (self) => new exp.Properties({ expressions: self._parse_with_property() })],
  ]);

  // py:369 — FILTERS the parent, dropping OVERLAPS.
  /** py: sqlglot/parsers/bigquery.py:369 */
  static RANGE_PARSERS = new Map(
    [...Parser.RANGE_PARSERS].filter(([k]) => k !== TokenType.OVERLAPS),
  );

  // py:373 — REPLACES outright: no base-`Parser` counterpart for this table.
  /** py: sqlglot/parsers/bigquery.py:373 */
  static DASHED_TABLE_PART_FOLLOW_TOKENS = new Set([
    /* py:374 */ TokenType.DOT,
    /* py:375 */ TokenType.L_PAREN,
    /* py:376 */ TokenType.R_PAREN,
  ]);

  /** py: sqlglot/parsers/bigquery.py:379 */
  static STATEMENT_PARSERS = new Map([
    /* py:380 */ ...Parser.STATEMENT_PARSERS,
    /* py:381 */ [TokenType.ELSE, (self) => self._parse_as_command(self._prev)],
    /* py:382 */ [TokenType.END, (self) => self._parse_as_command(self._prev)],
    /* py:383 */ [TokenType.FOR, (self) => self._parse_for_in()],
    /* py:384 */ [TokenType.EXPORT, (self) => self._parse_export_data()],
  ]);

  // py:387 — REPLACES outright: no base-`Parser` counterpart. Values are `[offset,
  // safe]` pairs; read through `this.constructor.BRACKET_OFFSETS` (R20) in
  // `_parse_bracket` below.
  /** py: sqlglot/parsers/bigquery.py:387 */
  static BRACKET_OFFSETS = new Map([
    /* py:388 */ ["OFFSET", [0, false]],
    /* py:389 */ ["ORDINAL", [1, false]],
    /* py:390 */ ["SAFE_OFFSET", [0, true]],
    /* py:391 */ ["SAFE_ORDINAL", [1, true]],
  ]);

  /** py: sqlglot/parsers/bigquery.py:394 */
  _parse_for_in() {
    const index = this._index;
    const this_ = this._parse_range();
    this._match_text_seq("DO");
    if (this._match(TokenType.COMMAND)) {
      this._retreat(index);
      return this._parse_as_command(this._prev);
    }
    return this.expression(new exp.ForIn({ this: this_, expression: this._parse_statement() }));
  }

  /** py: sqlglot/parsers/bigquery.py:403 */
  _parse_table_part(schema = false) {
    let this_ = super._parse_table_part(schema) || this._parse_number();

    // https://cloud.google.com/bigquery/docs/reference/standard-sql/lexical#table_names
    if (this_ instanceof exp.Identifier) {
      let table_name = this_.name;
      while (this._match(TokenType.DASH, false) && this._next.bool()) {
        const start = this._curr;
        while (
          this._is_connected()
          && !this._match_set(this.constructor.DASHED_TABLE_PART_FOLLOW_TOKENS, false)
        ) {
          this._advance();
        }

        if (start === this._curr) break;

        table_name += this._find_sql(start, this._prev);
      }

      this_ = new exp.Identifier({ this: table_name, quoted: this_.args.quoted }).updatePositions(this_);
    } else if (this_ instanceof exp.Literal) {
      let table_name = this_.name;

      if (this._is_connected() && this._parse_var(true)) {
        table_name += this._prev.text;
      }

      this_ = new exp.Identifier({ this: table_name, quoted: true }).updatePositions(this_);
    }

    return this_;
  }

  /** py: sqlglot/parsers/bigquery.py:434 */
  _parse_table_parts(schema = false, is_db_reference = false, wildcard = false, fast = false) {
    let table = super._parse_table_parts(schema, is_db_reference, true, fast);

    if (!(table instanceof exp.Table)) return table;

    // proj-1.db.tbl -- `1.` is tokenized as a float so we need to unravel it here
    if (!table.catalog) {
      if (table.db) {
        const previous_db = table.args.db;
        const parts = table.db.split(".");
        if (parts.length === 2 && !table.args.db.quoted) {
          table.set("catalog", new exp.Identifier({ this: parts[0] }).updatePositions(previous_db));
          table.set("db", new exp.Identifier({ this: parts[1] }).updatePositions(previous_db));
        }
      } else {
        const previous_this = table.this;
        const parts = table.name.split(".");
        if (parts.length === 2 && !table.this.quoted) {
          table.set("db", new exp.Identifier({ this: parts[0] }).updatePositions(previous_this));
          table.set("this", new exp.Identifier({ this: parts[1] }).updatePositions(previous_this));
        }
      }
    }

    let alias;
    if (table.this instanceof exp.Identifier && table.parts.some((p) => p.name.includes("."))) {
      alias = table.this;
      const [catalog, db, this_id, ...rest] = _split_qualified_name(
        table.parts.map((p) => p.name).join("."),
        3,
      ).map((p) => exp.toIdentifier(p, true));

      for (const part of [catalog, db, this_id]) {
        if (part) part.updatePositions(table.this);
      }

      let this_ = this_id;
      if (pyTruthy(rest) && this_) this_ = exp.Dot.build([this_, ...rest]);

      table = new exp.Table({ this: this_, db, catalog, pivots: table.args.pivots });
      table.meta.quoted_table = true;
    } else {
      alias = null;
    }

    // The `INFORMATION_SCHEMA` views in BigQuery need to be qualified by a region or
    // dataset, so if the project identifier is omitted we need to fix the ast so that
    // the `INFORMATION_SCHEMA.X` bit is represented as a single (quoted) Identifier.
    // Otherwise, we wouldn't correctly qualify a `Table` node that references these
    // views, because it would seem like the "catalog" part is set, when it'd actually
    // be the region/dataset. Merging the two identifiers into a single one is done to
    // avoid producing a 4-part Table reference, which would cause issues in the schema
    // module, when there are 3-part table names mixed with information schema views.
    //
    // See: https://cloud.google.com/bigquery/docs/information-schema-intro#syntax
    const table_parts = table.parts;
    if (table_parts.length > 1 && pyUpper(seqGet(table_parts, -2).name) === "INFORMATION_SCHEMA") {
      // We need to alias the table here to avoid breaking existing qualified columns.
      // This is expected to be safe, because if there's an actual alias coming up in
      // the token stream, it will overwrite this one. If there isn't one, we are only
      // exposing the name that can be used to reference the view explicitly (a no-op).
      exp.alias_(table, alias || seqGet(table_parts, -1), { table: true, copy: false });

      const info_schema_view = `${seqGet(table_parts, -2).name}.${seqGet(table_parts, -1).name}`;
      const new_this = new exp.Identifier({ this: info_schema_view, quoted: true }).updatePositions(
        null,
        seqGet(table_parts, -2).metaGet("line"),
        seqGet(table_parts, -1).metaGet("col"),
        seqGet(table_parts, -2).metaGet("start"),
        seqGet(table_parts, -1).metaGet("end"),
      );
      table.set("this", new_this);
      table.set("db", seqGet(table_parts, -3));
      table.set("catalog", seqGet(table_parts, -4));
    }

    return table;
  }

  /** py: sqlglot/parsers/bigquery.py:521 */
  _parse_column() {
    const column = super._parse_column();
    if (column instanceof exp.Column) {
      const parts = column.parts;
      if (parts.some((p) => p.name.includes("."))) {
        const [catalog, db, table, this_id, ...rest] = _split_qualified_name(
          parts.map((p) => p.name).join("."),
          4,
        ).map((p) => exp.toIdentifier(p, true));

        let this_ = this_id;
        if (pyTruthy(rest) && this_) this_ = exp.Dot.build([this_, ...rest]);

        const newColumn = new exp.Column({ this: this_, table, db, catalog });
        newColumn.meta.quoted_column = true;
        return newColumn;
      }
    }

    return column;
  }

  /** py: sqlglot/parsers/bigquery.py:540 */
  _parse_cluster_property() {
    return this.expression(
      new exp.ClusterProperty({ expressions: this._parse_csv(this._parse_column.bind(this)) }),
    );
  }

  /** py: sqlglot/parsers/bigquery.py:547 */
  _parse_property() {
    if (this._match_text_seq("NOT", "DETERMINISTIC")) {
      return this.expression(new exp.StabilityProperty({ this: exp.Literal.string("VOLATILE") }));
    }

    return super._parse_property();
  }

  /**
   * py: sqlglot/parsers/bigquery.py:553-559
   *
   * py:553/556 are `@t.overload` type-only signatures (body `...`), not real methods —
   * only py:559's undecorated definition has a runtime body upstream, matching the
   * convention `parser.js:5485`'s base stub comment already documents for this same
   * method. `super()._parse_json_object()` reaches that base `NotPorted` stub, so this
   * override stays unreachable for now — tracked the same way R16's residual tracks
   * `_parse_json_object` STUB rows, not a regression this PR introduces.
   */
  _parse_json_object(_agg = false) {
    const json_object = super._parse_json_object();
    const array_kv_pair = seqGet(json_object.expressions, 0);

    // Converts BQ's "signature 2" of JSON_OBJECT into SQLGlot's canonical representation
    // https://cloud.google.com/bigquery/docs/reference/standard-sql/json_functions#json_object_signature2
    if (
      array_kv_pair
      && array_kv_pair.this instanceof exp.Array
      && array_kv_pair.expression instanceof exp.Array
    ) {
      const keys = array_kv_pair.this.expressions;
      const values = array_kv_pair.expression.expressions;

      const pairs = [];
      const n = Math.min(keys.length, values.length);
      for (let i = 0; i < n; i++) {
        pairs.push(new exp.JSONKeyValue({ this: keys[i], expression: values[i] }));
      }
      json_object.set("expressions", pairs);
    }

    return json_object;
  }

  /** py: sqlglot/parsers/bigquery.py:580 */
  _parse_bracket(this_ = null) {
    const bracket = super._parse_bracket(this_);

    if (bracket instanceof exp.Array) {
      bracket.set("struct_name_inheritance", true);
    }

    if (this_ === bracket) {
      return bracket;
    }

    if (bracket instanceof exp.Bracket) {
      for (const expression of bracket.expressions) {
        const name = pyUpper(expression.name);

        const expressions = expression.expressions;

        if (!this.constructor.BRACKET_OFFSETS.has(name) || !pyTruthy(expressions)) break;

        const [offset, safe] = this.constructor.BRACKET_OFFSETS.get(name);
        bracket.set("offset", offset);
        bracket.set("safe", safe);
        expression.replace(expressions[0]);
      }
    }

    return bracket;
  }

  /** py: sqlglot/parsers/bigquery.py:605 */
  _parse_unnest(with_alias = true) {
    const unnest = super._parse_unnest(with_alias);

    if (!unnest) return null;

    const unnest_expr = seqGet(unnest.expressions, 0);
    if (unnest_expr) {
      const annotated = annotate_types(unnest_expr, this.dialect);

      // Unnesting a nested array (i.e array of structs) explodes the top-level struct fields,
      // in contrast to other dialects such as DuckDB which flattens only the array by default
      if (
        annotated.isType(exp.DType.ARRAY)
        && annotated._type.expressions.some((array_elem) => array_elem.isType(exp.DType.STRUCT))
      ) {
        unnest.set("explode_array", true);
      }
    }

    return unnest;
  }

  /** py: sqlglot/parsers/bigquery.py:626 */
  _parse_make_interval() {
    const expr = new exp.MakeInterval();

    for (let arg_key of MAKE_INTERVAL_KWARGS) {
      const value = this._parse_lambda();

      if (!pyTruthy(value)) break;

      // Non-named arguments are filled sequentially, (optionally) followed by named arguments
      // that can appear in any order e.g MAKE_INTERVAL(1, minute => 5, day => 2)
      if (value instanceof exp.Kwarg) arg_key = value.this.name;

      expr.set(arg_key, value);

      this._match(TokenType.COMMA);
    }

    return expr;
  }

  /** py: sqlglot/parsers/bigquery.py:646 */
  _parse_ml(expr_type, kwargs = {}) {
    this._match_text_seq("MODEL");
    const this_ = this._parse_table();

    this._match(TokenType.COMMA);
    this._match_text_seq("TABLE");

    // Certain functions like ML.FORECAST require a STRUCT argument but not a TABLE/SELECT one
    const expression = this._match(TokenType.STRUCT, false) ? null : this._parse_table();

    this._match(TokenType.COMMA);

    return this.expression(
      new expr_type({ this: this_, expression, params_struct: this._parse_bitwise(), ...kwargs }),
    );
  }

  /** py: sqlglot/parsers/bigquery.py:666 */
  _parse_generate(expr_type, kwargs = {}) {
    this._match_text_seq("MODEL");
    const this_ = this._parse_table();

    this._match(TokenType.COMMA);

    let expression;
    if (this._match_text_seq("TABLE")) {
      expression = this._parse_table();
    } else if (this._match(TokenType.L_PAREN, false)) {
      expression = this._parse_table();
    } else {
      expression = this._parse_bitwise();
    }

    // py: `self._match(TokenType.COMMA) and self._parse_bitwise()` — Python `and`
    // short-circuits to `False` (not `None`) when the comma isn't there (PORT_PLAN.md
    // R18); `&&` reproduces that operand-return value exactly.
    const params_struct = this._match(TokenType.COMMA) && this._parse_bitwise();

    return this.expression(
      new expr_type({ this: this_, expression, params_struct, ...kwargs }),
    );
  }

  /** py: sqlglot/parsers/bigquery.py:685 */
  _parse_translate() {
    // Check if this is ML.TRANSLATE by looking at previous tokens
    const token = seqGet(this._tokens, this._index - 4);
    if (token && pyUpper(token.text) === "ML") {
      return this._parse_ml(exp.MLTranslate);
    }

    return exp.Translate.from_arg_list(this._parse_function_args());
  }

  /** py: sqlglot/parsers/bigquery.py:693 */
  _parse_forecast() {
    // Check if this is ML.FORECAST by looking at previous tokens.
    const token = seqGet(this._tokens, this._index - 4);
    if (token && pyUpper(token.text) === "ML") {
      return this._parse_ml(exp.MLForecast);
    }

    // AI.FORECAST is a TVF, where the first argument is either TABLE <table>
    // or a parenthesized query statement, followed by named arguments.
    this._match(TokenType.TABLE);
    const this_ = this._parse_table();
    if (!this_) {
      this.raise_error("Expected table or query statement");
    }

    const expr = this.expression(new exp.AIForecast({ this: this_ }));
    while (this._match(TokenType.COMMA)) {
      const arg = this._parse_lambda();
      if (arg instanceof exp.Kwarg) {
        expr.set(arg.this.name, arg);
      } else {
        // py: `f"...got {arg}"` — implicit `str(Expr | None)`, corpus/deny/implicit_str.json
        // "sqlglot/parsers/bigquery.py:712" (route: kernelSql). `None` renders as "None"
        // (not JS's "null"); a non-Kwarg Expr routes through the parse-path generator
        // kernel, which stands in for `Expression.__str__` -> `.sql()` here.
        // deny:implicit_str sqlglot/parsers/bigquery.py:712
        const argStr = arg === null || arg === undefined ? "None" : kernelSql(arg);
        this.raise_error(`Expected key => value syntax for AI.FORECAST, got ${argStr}`);
      }
    }

    return expr;
  }

  /** py: sqlglot/parsers/bigquery.py:717 */
  _parse_features_at_time() {
    this._match(TokenType.TABLE);
    const this_ = this._parse_table();

    const expr = this.expression(new exp.FeaturesAtTime({ this: this_ }));

    while (this._match(TokenType.COMMA)) {
      const arg = this._parse_lambda();

      // Get the LHS of the Kwarg and set the arg to that value, e.g
      // "num_rows => 1" sets the expr's `num_rows` arg
      if (arg) {
        expr.set(arg.this.name, arg);
      }
    }

    return expr;
  }

  /** py: sqlglot/parsers/bigquery.py:733 */
  _parse_vector_search() {
    this._match(TokenType.TABLE);
    const base_table = this._parse_table();

    this._match(TokenType.COMMA);

    const column_to_search = this._parse_bitwise();
    this._match(TokenType.COMMA);

    this._match(TokenType.TABLE);
    const query_table = this._parse_table();

    const expr = this.expression(
      new exp.VectorSearch({ this: base_table, column_to_search, query_table }),
    );

    while (this._match(TokenType.COMMA)) {
      // query_column_to_search can be named argument or positional
      if (this._match(TokenType.STRING, false)) {
        const query_column = this._parse_string();
        expr.set("query_column_to_search", query_column);
      } else {
        const arg = this._parse_lambda();
        if (arg) {
          expr.set(arg.this.name, arg);
        }
      }
    }

    return expr;
  }

  /** py: sqlglot/parsers/bigquery.py:763 */
  _parse_export_data() {
    this._match_text_seq("DATA");

    // py: three `X and Y` Python expressions below, each operand-return (PORT_PLAN.md
    // R18): a failed match yields `False`, not `null`, and `&&` reproduces that exactly.
    return this.expression(
      new exp.Export({
        connection: this._match_text_seq("WITH", "CONNECTION") && this._parse_table_parts(),
        options: this._parse_properties(),
        this: this._match_text_seq("AS") && this._parse_select(true),
      }),
    );
  }

  /** py: sqlglot/parsers/bigquery.py:774 */
  _parse_column_ops(this_) {
    const func_index = this._index + 1;
    let result = super._parse_column_ops(this_);

    if (result instanceof exp.Dot && result.expression instanceof exp.Func) {
      const prefix = pyUpper(result.this.name);

      let func = null;
      if (prefix === "NET") func = exp.NetFunc;
      else if (prefix === "SAFE") func = exp.SafeFunc;

      if (func) {
        // Retreat to try and parse a known function instead of an anonymous one,
        // which is parsed by the base column ops parser due to anonymous_func=true
        this._retreat(func_index);
        result = new func({ this: this._parse_function(null, false, true, true) });
      } else if (prefix === "AI" || prefix === "ML") {
        // AI.* and ML.* function calls can use custom BigQuery signatures that rely on
        // function parsers, so re-parse the function in non-anonymous mode.
        this._retreat(func_index);
        const parsed = this._parse_function(null, false, true, true);
        if (parsed) {
          result = this.expression(new exp.Dot({ this: result.this, expression: parsed }));
        }
      }
    }

    return result;
  }
}
