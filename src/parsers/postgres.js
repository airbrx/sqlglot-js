// py: sqlglot/parsers/postgres.py @ 91119bc
//
// `class PostgresParser(parser.Parser)` — the READ-side Postgres grammar. Third in
// PORT_PLAN.md §10's dialect priority order, and self-contained: it extends the base
// `Parser` directly, like `snowflake.js`, rather than sitting in a chain the way
// `hive <- spark2 <- spark <- databricks` does. `sqlglot/dialects/postgres.py` (the
// `Postgres(Dialect)` SETTINGS class) stays P5, the same split every prior dialect
// port used.
//
// The two static-field rules `snowflake.js` documents apply here unchanged:
//
//   * A subclass's STATIC FIELD INITIALIZER names its parent explicitly
//     (`new Map([...Parser.BITWISE, ...])`), evaluated once at module load.
//   * An INSTANCE METHOD — or a lambda stored in a table and later called with `self`
//     — reads a class table or flag through `self.constructor.X`, never a bare
//     `self.X`. `JSON_OPERATORS`'s two arrow entries below depend on this for
//     `JSON_ARROWS_REQUIRE_JSON_TYPE`; a bare `self.JSON_ARROWS_REQUIRE_JSON_TYPE`
//     would read `undefined` and silently flip the flag to false.
//
// Whether a table EXTENDS or REPLACES its parent is decided per table from upstream,
// and Postgres uses three distinct shapes rather than one:
//
//   * EXTEND (`{**parser.Parser.X, ...}`): PLACEHOLDER_PARSERS, FUNCTIONS,
//     NO_PAREN_FUNCTION_PARSERS, NO_PAREN_FUNCTIONS, FUNCTION_PARSERS, BITWISE,
//     RANGE_PARSERS, STATEMENT_PARSERS, UNARY_PARSERS.
//   * REPLACE outright (bare literal, no parent spread): EXPONENT, JSON_OPERATORS,
//     ARG_MODE_TOKENS.
//   * FILTER the parent (a dict comprehension over `parser.Parser.X.items()`):
//     PROPERTY_PARSERS drops "INPUT" before re-adding "SET"; COLUMN_OPERATORS drops
//     the five JSON operator tokens that `JSON_OPERATORS` then re-homes at a
//     different precedence tier.
//
// That last pair is the interesting one and is easy to get backwards. Postgres does
// not merely re-implement `->`/`->>`/`#>`/`#>>`/`?`: it MOVES them out of the
// accessor-tier `COLUMN_OPERATORS` and into `JSON_OPERATORS`, which `_parse_bitwise`
// consults at Postgres's "any other operator" precedence (level with `||`, below
// `+`/`-`). Porting only the `JSON_OPERATORS` half would leave the operators bound at
// the wrong precedence; porting only the `COLUMN_OPERATORS` half would delete them.

import {
  Parser,
  binary_range_parser,
  build_jsonb_contains_top_key,
  build_jsonb_extract,
  build_jsonb_extract_scalar,
} from "../parser.js";
import { TokenType } from "../tokens.js";
import { isInt, seqGet } from "../helper.js";
import { pyTruthy } from "../_py/truthy.js";
import { NotPorted } from "../errors.js";
import * as exp from "../expressions/index.js";
import {
  binary_from_function,
  build_formatted_time,
  build_json_extract_path,
  build_timestamp_trunc,
} from "../dialects/dialect.js";

/**
 * py: sqlglot/optimizer/annotate_types.py — NOT PORTED.
 *
 * `_build_regexp_replace` imports this INSIDE its own body upstream
 * (`parsers/postgres.py:56`), so a file-local stub mirrors upstream's own structure
 * rather than widening `dialects/dialect.js`'s export surface with a member that is
 * not part of `dialects/dialect.py` at all. Same reasoning, and same P6+ scope, as
 * the identically-named stub there.
 */
function annotate_types(_expression, _dialect) {
  throw new NotPorted("annotate_types", "sqlglot/optimizer/annotate_types.py");
}

/**
 * py: sqlglot/parsers/postgres.py:21
 *
 * `exp.to_interval` routes through `maybe_parse`, which needs the `registerParser`
 * hook that PORT_PLAN.md R17 records as exported-and-never-called (a P5 Dialect
 * concern, outside this parser). Left bare it raises a plain `TypeError`, which
 * `_parse_function_call` (parser.js:4870) would mistake for the arity signal in its
 * `builder(args)` / `builder(args, dialect)` dispatch and silently retry — turning a
 * missing component into a confusing double-call rather than a counted stub. The two
 * `to_interval` call sites are therefore re-raised as `NotPorted`.
 *
 * Only the string / unit-less-INTERVAL step forms reach that path; the ordinary
 * two-argument `GENERATE_SERIES(a, b)` and numeric-step calls never touch it.
 */
function _build_generate_series(args) {
  // The goal is to convert step values like '1 day' or INTERVAL '1 day' into INTERVAL '1' day
  // Note: postgres allows calls with just two arguments -- the "step" argument defaults to 1
  const step = seqGet(args, 2);
  if (step !== null && step !== undefined) {
    if (step.isString) {
      args[2] = _to_interval(step.this);
    } else if (step instanceof exp.Interval && !pyTruthy(step.args.unit)) {
      args[2] = _to_interval(step.this.this);
    }
  }

  return exp.ExplodingGenerateSeries.from_arg_list(args);
}

/** py: sqlglot/expressions/builders.py:343 `to_interval`, via the R17 hook. */
function _to_interval(value) {
  try {
    return exp.toInterval(value);
  } catch (e) {
    if (e instanceof TypeError) {
      throw new NotPorted(
        "to_interval (maybe_parse needs registerParser; PORT_PLAN.md R17)",
        "sqlglot/expressions/builders.py:351",
      );
    }
    throw e;
  }
}

/** py: sqlglot/parsers/postgres.py:34 */
function _build_to_timestamp(args, dialect) {
  // TO_TIMESTAMP accepts either a single double argument or (text, text)
  if (args.length === 1) {
    // https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-TABLE
    return exp.UnixToTime.from_arg_list(args);
  }

  // https://www.postgresql.org/docs/current/functions-formatting.html
  return build_formatted_time(exp.StrToTime)(args, dialect);
}

/** py: sqlglot/parsers/postgres.py:44 */
function _build_regexp_replace(args, dialect = null) {
  // The signature of REGEXP_REPLACE is:
  // regexp_replace(source, pattern, replacement [, start [, N ]] [, flags ])
  //
  // Any one of `start`, `N` and `flags` can be column references, meaning that
  // unless we can statically see that the last argument is a non-integer string
  // (eg. not '0'), then it's not possible to construct the correct AST
  let regexp_replace = null;
  if (args.length > 3) {
    let last = args[args.length - 1];
    if (!isInt(last.name)) {
      if (!last.type || last.isType(exp.DType.UNKNOWN, exp.DType.NULL)) {
        last = annotate_types(last, dialect);
      }

      if (last.isType(...exp.DataType.TEXT_TYPES)) {
        regexp_replace = exp.RegexpReplace.from_arg_list(args.slice(0, -1));
        regexp_replace.set("modifiers", last);
      }
    }
  }

  regexp_replace = regexp_replace || exp.RegexpReplace.from_arg_list(args);
  regexp_replace.set("single_replace", true);
  return regexp_replace;
}

/** py: sqlglot/parsers/postgres.py:69 */
function _build_levenshtein_less_equal(args) {
  // Postgres has two signatures for levenshtein_less_equal function, but in both cases
  // max_dist is the last argument
  // levenshtein_less_equal(source, target, ins_cost, del_cost, sub_cost, max_d)
  // levenshtein_less_equal(source, target, max_d)
  const max_dist = args.pop();

  return new exp.Levenshtein({
    this: seqGet(args, 0),
    expression: seqGet(args, 1),
    ins_cost: seqGet(args, 2),
    del_cost: seqGet(args, 3),
    sub_cost: seqGet(args, 4),
    max_dist,
  });
}

/** py: sqlglot/parsers/postgres.py:86 */
export class PostgresParser extends Parser {
  /* py:87 */ static SUPPORTS_OMITTED_INTERVAL_SPAN_UNIT = true;

  // py:89 `{**{k: v for k, v in Parser.PROPERTY_PARSERS.items() if k != "INPUT"}, "SET": ...}`
  // "SET" already exists on the base parser and survives the filter, so the explicit
  // entry OVERWRITES it while KEEPING the base's insertion position — Python dicts and
  // JS Maps agree on that, so the spread-then-append form transliterates one-for-one.
  /** py: sqlglot/parsers/postgres.py:89 */
  static PROPERTY_PARSERS = new Map([
    /* py:90 */ ...[...Parser.PROPERTY_PARSERS].filter(([k]) => k !== "INPUT"),
    /* py:91 */ ["SET", (self) => self.expression(new exp.SetConfigProperty({ this: self._parse_set() }))],
  ]);

  /** py: sqlglot/parsers/postgres.py:94 */
  static PLACEHOLDER_PARSERS = new Map([
    /* py:95 */ ...Parser.PLACEHOLDER_PARSERS,
    /* py:96 */ [TokenType.PLACEHOLDER, (self) => self.expression(new exp.Placeholder({ jdbc: true }))],
    /* py:97 */ [TokenType.MOD, (self) => self._parse_query_parameter()],
  ]);

  /** py: sqlglot/parsers/postgres.py:100 */
  static FUNCTIONS = new Map([
    /* py:101 */ ...Parser.FUNCTIONS,
    /* py:102 */ ["ARRAY_PREPEND", (args) => new exp.ArrayPrepend({
      this: seqGet(args, 1), expression: seqGet(args, 0),
    })],
    /* py:105 */ ["BIT_AND", exp.BitwiseAndAgg.from_arg_list],
    /* py:106 */ ["BIT_OR", exp.BitwiseOrAgg.from_arg_list],
    /* py:107 */ ["BIT_XOR", exp.BitwiseXorAgg.from_arg_list],
    /* py:108 */ ["BTRIM", exp.Trim.from_arg_list],
    /* py:109 */ ["VERSION", exp.CurrentVersion.from_arg_list],
    /* py:110 */ ["DATE_TRUNC", build_timestamp_trunc],
    /* py:111 */ ["DIV", (args) => exp.cast(binary_from_function(exp.IntDiv)(args), exp.DType.DECIMAL)],
    /* py:112 */ ["GENERATE_SERIES", _build_generate_series],
    /* py:113 */ ["GET_BIT", (args) => new exp.Getbit({
      this: seqGet(args, 0), expression: seqGet(args, 1), zero_is_msb: true,
    })],
    /* py:116 */ ["JSON_EXTRACT_PATH", build_json_extract_path(exp.JSONExtract)],
    /* py:117 */ ["JSON_EXTRACT_PATH_TEXT", build_json_extract_path(exp.JSONExtractScalar)],
    /* py:118 */ ["LENGTH", (args) => new exp.Length({ this: seqGet(args, 0), encoding: seqGet(args, 1) })],
    /* py:119 */ ["MAKE_TIME", exp.TimeFromParts.from_arg_list],
    /* py:120 */ ["MAKE_TIMESTAMP", exp.TimestampFromParts.from_arg_list],
    /* py:121 */ ["NOW", exp.CurrentTimestamp.from_arg_list],
    /* py:122 */ ["REGEXP_REPLACE", _build_regexp_replace],
    /* py:123 */ ["TO_CHAR", build_formatted_time(exp.TimeToStr)],
    /* py:124 */ ["TO_DATE", build_formatted_time(exp.StrToDate)],
    /* py:125 */ ["TO_TIMESTAMP", _build_to_timestamp],
    /* py:126 */ ["UNNEST", exp.Explode.from_arg_list],
    /* py:127 */ ["SHA256", (args) => new exp.SHA2({ this: seqGet(args, 0), length: exp.Literal.number(256) })],
    /* py:128 */ ["SHA384", (args) => new exp.SHA2({ this: seqGet(args, 0), length: exp.Literal.number(384) })],
    /* py:129 */ ["SHA512", (args) => new exp.SHA2({ this: seqGet(args, 0), length: exp.Literal.number(512) })],
    /* py:130 */ ["LEVENSHTEIN_LESS_EQUAL", _build_levenshtein_less_equal],
    /* py:131 */ ["JSON_OBJECT_AGG", (args) => new exp.JSONObjectAgg({ expressions: args })],
    /* py:132 */ ["JSONB_OBJECT_AGG", exp.JSONBObjectAgg.from_arg_list],
    /* py:133 */ ["WIDTH_BUCKET", (args) => (
      args.length === 2
        ? new exp.WidthBucket({ this: seqGet(args, 0), threshold: seqGet(args, 1) })
        : exp.WidthBucket.from_arg_list(args)
    )],
    // py:138 `exp.cast(args[0], exp.DType.UUID) if args else exp.Uuid()` — `if args` is
    // Python list truthiness, so an EMPTY arg list takes the `exp.Uuid()` branch.
    /* py:138 */ ["UUID", (args) => (pyTruthy(args) ? exp.cast(args[0], exp.DType.UUID) : new exp.Uuid())],
  ]);

  /** py: sqlglot/parsers/postgres.py:141 */
  static NO_PAREN_FUNCTION_PARSERS = new Map([
    /* py:142 */ ...Parser.NO_PAREN_FUNCTION_PARSERS,
    /* py:143 */ ["VARIADIC", (self) => self.expression(new exp.Variadic({ this: self._parse_bitwise() }))],
  ]);

  /** py: sqlglot/parsers/postgres.py:146 */
  static NO_PAREN_FUNCTIONS = new Map([
    /* py:147 */ ...Parser.NO_PAREN_FUNCTIONS,
    /* py:148 */ [TokenType.LOCALTIME, exp.Localtime],
    /* py:149 */ [TokenType.LOCALTIMESTAMP, exp.Localtimestamp],
    /* py:150 */ [TokenType.CURRENT_CATALOG, exp.CurrentCatalog],
    /* py:151 */ [TokenType.SESSION_USER, exp.SessionUser],
    /* py:152 */ [TokenType.CURRENT_SCHEMA, exp.CurrentSchema],
  ]);

  /** py: sqlglot/parsers/postgres.py:155 */
  static FUNCTION_PARSERS = new Map([
    /* py:156 */ ...Parser.FUNCTION_PARSERS,
    /* py:157 */ ["DATE_PART", (self) => self._parse_date_part()],
    /* py:158 */ ["JSON_AGG", (self) => self.expression(new exp.JSONArrayAgg({
      this: self._parse_lambda(), order: self._parse_order(),
    }))],
    /* py:161 */ ["JSONB_EXISTS", (self) => self._parse_jsonb_exists()],
  ]);

  /** py: sqlglot/parsers/postgres.py:164 */
  static BITWISE = new Map([
    /* py:165 */ ...Parser.BITWISE,
    /* py:166 */ [TokenType.HASH, exp.BitwiseXor],
  ]);

  // py:169 — REPLACES the parent outright (no `**parser.Parser.EXPONENT` spread). The
  // base table is empty, and `_parse_factor_operand` switches on `EXPONENT.size`, so
  // this is what turns `^` into exponentiation for Postgres.
  /** py: sqlglot/parsers/postgres.py:169 */
  static EXPONENT = new Map([
    /* py:170 */ [TokenType.CARET, exp.Pow],
  ]);

  /** py: sqlglot/parsers/postgres.py:173 */
  static RANGE_PARSERS = new Map([
    /* py:174 */ ...Parser.RANGE_PARSERS,
    /* py:175 */ [TokenType.DAMP, binary_range_parser(exp.ArrayOverlaps)],
    /* py:176 */ [TokenType.DAT, (self, this_) => self.expression(new exp.MatchAgainst({
      this: self._parse_bitwise(), expressions: [this_],
    }))],
  ]);

  /** py: sqlglot/parsers/postgres.py:181 */
  static STATEMENT_PARSERS = new Map([
    /* py:182 */ ...Parser.STATEMENT_PARSERS,
    /* py:183 */ [TokenType.END, (self) => self._parse_commit_or_rollback()],
  ]);

  /** py: sqlglot/parsers/postgres.py:186 */
  static UNARY_PARSERS = new Map([
    /* py:187 */ ...Parser.UNARY_PARSERS,
    // The `~` token is remapped from TILDE to RLIKE in Postgres due to the binary REGEXP LIKE operator
    /* py:189 */ [TokenType.RLIKE, (self) => self.expression(new exp.BitwiseNot({ this: self._parse_unary() }))],
  ]);

  /* py:192 */ static JSON_ARROWS_REQUIRE_JSON_TYPE = true;

  // py:194 — a dict comprehension that FILTERS the parent, removing the five tokens
  // `JSON_OPERATORS` below re-homes at bitwise precedence. Two of these five (ARROW,
  // DARROW) are not present on the JS base table at all — it leaves them unwired
  // pending the jsonpath module — so removing them is a no-op here; the other three
  // are present and really are dropped.
  /** py: sqlglot/parsers/postgres.py:194 */
  static COLUMN_OPERATORS = new Map(
    [...Parser.COLUMN_OPERATORS].filter(([k]) => ![
      /* py:199 */ TokenType.ARROW,
      /* py:200 */ TokenType.DARROW,
      /* py:201 */ TokenType.HASH_ARROW,
      /* py:202 */ TokenType.DHASH_ARROW,
      /* py:203 */ TokenType.PLACEHOLDER,
    ].includes(k)),
  );

  // py:207 — REPLACES outright. Read by `_parse_bitwise` (parser.py:6330). The two
  // arrow entries build their JSONPath from LITERAL segments via
  // `build_json_extract_path`, so unlike the base parser's unwired ARROW/DARROW they
  // do NOT need `dialect.to_json_path` / the jsonpath module.
  /** py: sqlglot/parsers/postgres.py:207 */
  static JSON_OPERATORS = new Map([
    /* py:208 */ [TokenType.ARROW, (self, this_, path) => self.validate_expression(
      build_json_extract_path(
        exp.JSONExtract, true, self.constructor.JSON_ARROWS_REQUIRE_JSON_TYPE,
      )([this_, path]),
    )],
    /* py:213 */ [TokenType.DARROW, (self, this_, path) => self.validate_expression(
      build_json_extract_path(
        exp.JSONExtractScalar, true, self.constructor.JSON_ARROWS_REQUIRE_JSON_TYPE,
      )([this_, path]),
    )],
    /* py:218 */ [TokenType.HASH_ARROW, build_jsonb_extract],
    /* py:219 */ [TokenType.DHASH_ARROW, build_jsonb_extract_scalar],
    /* py:220 */ [TokenType.PLACEHOLDER, build_jsonb_contains_top_key],
  ]);

  /** py: sqlglot/parsers/postgres.py:223 */
  static ARG_MODE_TOKENS = new Set([
    TokenType.IN, TokenType.OUT, TokenType.INOUT, TokenType.VARIADIC,
  ]);

  /**
   * py: sqlglot/parsers/postgres.py:225
   *
   * Parse PostgreSQL function parameter mode (IN, OUT, INOUT, VARIADIC).
   *
   * Disambiguates between mode keywords and identifiers with the same name:
   * - MODE TYPE      -> keyword is identifier (e.g., "out INT")
   * - MODE NAME TYPE -> keyword is mode (e.g., "OUT x INT")
   *
   * `not self._next` is `Token.__bool__` on the SENTINEL — "no token after this one",
   * not "`_next` is null"; the cursor fields are never null in this port.
   */
  _parse_parameter_mode() {
    if (!this._match_set(this.constructor.ARG_MODE_TOKENS, false) || !this._next.bool()) {
      return null;
    }

    const mode_token = this._curr;

    // Check Pattern 1: MODE TYPE
    // Try parsing next token as a built-in type (not UDT)
    // If successful, the keyword is an identifier, not a mode
    // py: `self._advance() or self._parse_types(check_func=False, allow_identifiers=False)`
    // — `_advance` returns None/undefined, so `or` always evaluates the right operand.
    const is_followed_by_builtin_type = this._try_parse(
      () => this._advance() || this._parse_types(false, false, false),
      true,
    );
    if (is_followed_by_builtin_type) {
      return null; // Pattern: "out INT" -> out is parameter name
    }

    // Check Pattern 2: MODE NAME TYPE
    // If next token is an identifier, check if there's a type after it
    // The type can be built-in or user-defined (allow_identifiers=True)
    if (!this.constructor.ID_VAR_TOKENS.has(this._next.token_type)) {
      return null;
    }

    const is_followed_by_any_type = this._try_parse(
      () => this._advance(2) || this._parse_types(false, false, true),
      true,
    );

    if (is_followed_by_any_type) {
      return mode_token.token_type; // Pattern: "OUT x INT" -> OUT is mode
    }

    return null;
  }

  /**
   * py: sqlglot/parsers/postgres.py:273
   *
   * Create parameter mode constraint for function parameters.
   */
  _create_mode_constraint(param_mode) {
    return this.expression(new exp.InOutColumnConstraint({
      input_: param_mode === TokenType.IN || param_mode === TokenType.INOUT,
      output: param_mode === TokenType.OUT || param_mode === TokenType.INOUT,
      variadic: param_mode === TokenType.VARIADIC,
    }));
  }

  /** py: sqlglot/parsers/postgres.py:291 */
  _parse_function_parameter() {
    const param_mode = this._parse_parameter_mode();

    if (param_mode) this._advance();

    // Parse parameter name and type
    const param_name = this._parse_id_var();
    const column_def = this._parse_column_def(param_name, false);

    // Attach mode as constraint
    if (param_mode && column_def) {
      const constraint = this._create_mode_constraint(param_mode);
      // py: `if not column_def.args.get("constraints")` — Python falsiness, so an
      // EMPTY list is replaced too, not just a missing key.
      if (!pyTruthy(column_def.args.constraints)) column_def.set("constraints", []);
      column_def.args.constraints.unshift(constraint);
    }

    return column_def;
  }

  /** py: sqlglot/parsers/postgres.py:310 */
  _parse_query_parameter() {
    const this_ = this._match(TokenType.L_PAREN, false)
      ? this._parse_wrapped(() => this._parse_id_var())
      : null;
    this._match_text_seq("S");
    return this.expression(new exp.Placeholder({ this: this_ }));
  }

  /** py: sqlglot/parsers/postgres.py:319 */
  _parse_date_part() {
    let part = this._parse_type();
    this._match(TokenType.COMMA);
    const value = this._parse_bitwise();

    if (part && (part instanceof exp.Column || part instanceof exp.Literal)) {
      part = exp.var(part.name);
    }

    return this.expression(new exp.Extract({ this: part, expression: value }));
  }

  /** py: sqlglot/parsers/postgres.py:329 */
  _parse_unique_key() {
    return null;
  }

  /**
   * py: sqlglot/parsers/postgres.py:332
   *
   * `path=self._match(COMMA) and self.dialect.to_json_path(...)` — Python `and` yields
   * the FALSE OPERAND, not None, so a missing comma stores `False` and dumps as
   * `false`. Same defect class as `_parse_grant_principal`'s `kind` (parser.js:6351).
   */
  _parse_jsonb_exists() {
    return this.expression(new exp.JSONBExists({
      this: this._parse_bitwise(),
      path: this._match(TokenType.COMMA)
        ? this.dialect.to_json_path(this._parse_bitwise())
        : false,
    }));
  }

  /** py: sqlglot/parsers/postgres.py:341 */
  _parse_generated_as_identity() {
    let this_ = super._parse_generated_as_identity();

    if (this._match_text_seq("STORED")) {
      this_ = this.expression(new exp.ComputedColumnConstraint({ this: this_.expression }));
    }

    return this_;
  }

  /** py: sqlglot/parsers/postgres.py:355 */
  _parse_user_defined_type(identifier) {
    let udt_type = identifier;

    while (this._match(TokenType.DOT)) {
      const part = this._parse_id_var();
      if (part) udt_type = new exp.Dot({ this: udt_type, expression: part });
    }

    return exp.DataType.build(udt_type, { udt: true });
  }
}
