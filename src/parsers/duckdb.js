// py: sqlglot/parsers/duckdb.py @ 91119bc
//
// `class DuckDBParser(parser.Parser)` — the READ-side DuckDB grammar. Fourth and last
// of the dialects named in PORT_PLAN.md §10's priority order, and self-contained: it
// extends the base `Parser` directly, like `snowflake.js` and `postgres.js`, rather
// than sitting in a chain the way `hive <- spark2 <- spark <- databricks` does.
// `sqlglot/dialects/duckdb.py` (the 128-LOC `DuckDB(Dialect)` SETTINGS class) stays
// P5, the same split every prior dialect port used.
//
// The two static-field rules the earlier ports document apply here unchanged:
//
//   * A subclass's STATIC FIELD INITIALIZER names its parent explicitly
//     (`new Map([...Parser.BITWISE, ...])`), evaluated once at module load.
//   * An INSTANCE METHOD — or a lambda stored in a table and later called with `self`
//     — reads a class table or flag through `self.constructor.X`, never a bare
//     `self.X`. `PLACEHOLDER_PARSERS`'s PARAMETER entry depends on this for
//     `ID_VAR_TOKENS`, and `_parse_table` for `TABLE_ALIAS_TOKENS`; a bare `self.X`
//     reads `undefined` (PORT_PLAN.md R20) and would make `_match_set` throw rather
//     than differ.
//
// Whether a table EXTENDS, REPLACES or FILTERS its parent is decided per table from
// upstream. DuckDB, like Postgres, uses all three shapes:
//
//   * EXTEND (`{**parser.Parser.X, ...}`): NO_PAREN_FUNCTIONS, RANGE_PARSERS,
//     EXPONENT, FUNCTIONS_WITH_ALIASED_ARGS, NO_PAREN_FUNCTION_PARSERS,
//     PLACEHOLDER_PARSERS, STATEMENT_PARSERS, SET_PARSERS.
//   * REPLACE outright (bare literal, no parent spread): JSON_OPERATORS, SHOW_PARSERS,
//     TYPE_CONVERTERS.
//   * FILTER the parent (a dict comprehension over `parser.Parser.X.items()`): BITWISE
//     drops CARET, COLUMN_OPERATORS drops ARROW/DARROW, FUNCTIONS drops DATE_SUB and
//     GLOB, FUNCTION_PARSERS drops DECODE.
//
// The `^` handling is the pair that is easiest to get half-right. DuckDB does not
// merely add `CARET -> exp.Pow` to `EXPONENT`: it also REMOVES `CARET` from `BITWISE`,
// where the base parser binds it as bitwise-xor. Porting only the `EXPONENT` half
// would leave `^` bound at both tiers with the base's precedence winning; porting only
// the `BITWISE` half would delete `^` entirely. The same shape repeats for
// `ARROW`/`DARROW`, which move out of the accessor-tier `COLUMN_OPERATORS` and into
// `JSON_OPERATORS` (consulted by `_parse_bitwise`), exactly as in `postgres.js`.

import {
  Parser,
  binary_range_parser,
  build_array_concat,
  build_extract_json_with_path,
  build_json_extract,
  build_json_extract_scalar,
} from "../parser.js";
import { TokenType } from "../tokens.js";
import { newTrie } from "../trie.js";
import { seqGet } from "../helper.js";
import { pyTruthy } from "../_py/truthy.js";
import * as exp from "../expressions/index.js";
import {
  binary_from_function,
  build_default_decimal_type,
  build_formatted_time,
  build_regexp_extract,
  date_trunc_to_time,
  pivot_column_names,
} from "../dialects/dialect.js";

/**
 * Python tuple `<` over `Dialect.version`, for `_parse_bracket`'s
 * `self.dialect.version < (1, 2)` (`parsers/duckdb.py:344`).
 *
 * `version` is a 3-element array of BigInt (`dialects/dialect.js:952`), and JS `<` on
 * arrays coerces BOTH sides to strings — `[1n,1n,0n] < [1n,2n]` would compare
 * `"1,1,0" < "1,2"` and happen to be right, while the DEFAULT
 * `[9223372036854775807n,0n,0n] < [1n,2n]` compares `"9223372036854775807,0,0"` and is
 * WRONG (string-wise "9" > "1", so it returns false by luck here, but the coercion is
 * not the comparison upstream performs and inverts as soon as a version starts with a
 * digit that sorts before the bound's). Python compares element-wise and, on a shared
 * prefix, treats the LONGER tuple as greater — hence the trailing length compare.
 */
function _versionLt(version, ...bound) {
  const n = Math.min(version.length, bound.length);
  for (let i = 0; i < n; i++) {
    const a = BigInt(version[i]);
    const b = BigInt(bound[i]);
    if (a !== b) return a < b;
  }
  return version.length < bound.length;
}

/** py: sqlglot/parsers/duckdb.py:21 */
function _build_sort_array_desc(args) {
  return new exp.SortArray({ this: seqGet(args, 0), asc: exp.false_() });
}

// py:25 — note the arguments are SWAPPED relative to their positions: `this` is
// args[1] and `expression` is args[0], because DuckDB's ARRAY_PREPEND/LIST_PREPEND
// take (element, list) while `exp.ArrayPrepend` stores (list, element).
/** py: sqlglot/parsers/duckdb.py:25 */
function _build_array_prepend(args) {
  return new exp.ArrayPrepend({ this: seqGet(args, 1), expression: seqGet(args, 0) });
}

// py:29 — likewise reversed: DuckDB's DATE_DIFF is (unit, end, start).
/** py: sqlglot/parsers/duckdb.py:29 */
function _build_date_diff(args) {
  return new exp.DateDiff({
    this: seqGet(args, 2),
    expression: seqGet(args, 1),
    unit: seqGet(args, 0),
  });
}

/** py: sqlglot/parsers/duckdb.py:33 */
function _build_generate_series(end_exclusive = false) {
  return function _builder(args) {
    // Check https://duckdb.org/docs/sql/functions/nested.html#range-functions
    if (args.length === 1) {
      // DuckDB uses 0 as a default for the series' start when it's omitted
      // py: `args.insert(0, ...)` — mutates the caller's list, as does `unshift`.
      args.unshift(exp.Literal.number("0"));
    }

    const gen_series = exp.GenerateSeries.from_arg_list(args);
    gen_series.set("is_end_exclusive", end_exclusive);

    return gen_series;
  };
}

/** py: sqlglot/parsers/duckdb.py:48 */
function _build_make_timestamp(args) {
  if (args.length === 1) {
    return new exp.UnixToTime({ this: seqGet(args, 0), scale: exp.UnixToTime.MICROS });
  }

  return new exp.TimestampFromParts({
    year: seqGet(args, 0),
    month: seqGet(args, 1),
    day: seqGet(args, 2),
    hour: seqGet(args, 3),
    min: seqGet(args, 4),
    sec: seqGet(args, 5),
  });
}

/**
 * py: sqlglot/parsers/duckdb.py:62
 *
 * `_show_parser(*args, **kwargs)` upstream; both call sites pass a single positional
 * string, and `_parse_show_duckdb` takes exactly that one parameter, so the rest
 * parameter below is the faithful shape rather than a widening.
 */
function _show_parser(...args) {
  return function _parse(self) {
    return self._parse_show_duckdb(...args);
  };
}

// py:69 — `dtype.set("expressions", None)`. `None` is the Python literal; the port's
// wire format renders a missing/`null` arg identically, so `null` (not `undefined`)
// is what keeps `TEXT(10)` collapsing to a bare `TEXT` the way upstream does.
/** py: sqlglot/parsers/duckdb.py:69 */
function _convert_text_type(dtype) {
  dtype.set("expressions", null);
  return dtype;
}

/** py: sqlglot/parsers/duckdb.py:74 */
export class DuckDBParser extends Parser {
  /* py:75 */ static MAP_KEYS_ARE_ARBITRARY_EXPRESSIONS = true;
  /* py:76 */ static PIVOT_COLUMN_NAMING = "agg_name_if_aliased_or_multiple";

  /** py: sqlglot/parsers/duckdb.py:78 */
  static NO_PAREN_FUNCTIONS = new Map([
    /* py:79 */ ...Parser.NO_PAREN_FUNCTIONS,
    /* py:80 */ [TokenType.LOCALTIME, exp.Localtime],
    /* py:81 */ [TokenType.LOCALTIMESTAMP, exp.Localtimestamp],
    /* py:82 */ [TokenType.CURRENT_CATALOG, exp.CurrentCatalog],
    /* py:83 */ [TokenType.SESSION_USER, exp.SessionUser],
  ]);

  // py:86 — FILTERS the parent, dropping CARET so `^` is free for `EXPONENT` below to
  // rebind as exponentiation instead of bitwise-xor. Half of a two-part move.
  /** py: sqlglot/parsers/duckdb.py:86 */
  static BITWISE = new Map(
    [...Parser.BITWISE].filter(([k]) => k !== TokenType.CARET),
  );

  // py:88 — FILTERS the parent, dropping the two arrow tokens `JSON_OPERATORS` below
  // re-homes at bitwise precedence. Same two-part move as `postgres.js`.
  /** py: sqlglot/parsers/duckdb.py:88 */
  static COLUMN_OPERATORS = new Map(
    [...Parser.COLUMN_OPERATORS].filter(([k]) => ![
      /* py:91 */ TokenType.ARROW,
      /* py:91 */ TokenType.DARROW,
    ].includes(k)),
  );

  // py:94 — REPLACES outright. Read by `_parse_bitwise` (parser.py:6330). Unlike
  // Postgres's, these two entries are the module-level `parser.build_json_extract`
  // pair rather than inline `build_json_extract_path` closures, so they route through
  // `dialect.to_json_path` and honour `JSON_ARROWS_REQUIRE_JSON_TYPE`.
  /** py: sqlglot/parsers/duckdb.py:94 */
  static JSON_OPERATORS = new Map([
    /* py:95 */ [TokenType.ARROW, build_json_extract],
    /* py:96 */ [TokenType.DARROW, build_json_extract_scalar],
  ]);

  /** py: sqlglot/parsers/duckdb.py:99 */
  static RANGE_PARSERS = new Map([
    /* py:100 */ ...Parser.RANGE_PARSERS,
    /* py:101 */ [TokenType.DAMP, binary_range_parser(exp.ArrayOverlaps)],
    /* py:102 */ [TokenType.CARET_AT, binary_range_parser(exp.StartsWith)],
    /* py:103 */ [TokenType.TILDE, binary_range_parser(exp.RegexpFullMatch)],
  ]);

  // py:106 — EXTENDS, but the base table is empty, so in practice these two entries
  // ARE the table. `_parse_factor_operand` switches on `EXPONENT.size`.
  /** py: sqlglot/parsers/duckdb.py:106 */
  static EXPONENT = new Map([
    /* py:107 */ ...Parser.EXPONENT,
    /* py:108 */ [TokenType.CARET, exp.Pow],
    /* py:109 */ [TokenType.DSTAR, exp.Pow],
  ]);

  /** py: sqlglot/parsers/duckdb.py:112 */
  static FUNCTIONS_WITH_ALIASED_ARGS = new Set([
    ...Parser.FUNCTIONS_WITH_ALIASED_ARGS,
    "STRUCT_PACK",
  ]);

  // py:114 — REPLACES outright: DuckDB's SHOW grammar is only these two forms, and
  // `SHOW_TRIE` below is derived from THIS table, not the parent's.
  /** py: sqlglot/parsers/duckdb.py:114 */
  static SHOW_PARSERS = new Map([
    /* py:115 */ ["TABLES", _show_parser("TABLES")],
    /* py:116 */ ["ALL TABLES", _show_parser("ALL TABLES")],
  ]);

  /** py: sqlglot/parsers/duckdb.py:119 */
  static FUNCTIONS = new Map([
    // py:120 — FILTERS the parent before merging: DuckDB has no DATE_SUB or GLOB.
    /* py:120 */ ...[...Parser.FUNCTIONS].filter(([k]) => k !== "DATE_SUB" && k !== "GLOB"),
    /* py:121 */ ["ANY_VALUE", (args) => new exp.IgnoreNulls({ this: exp.AnyValue.from_arg_list(args) })],
    /* py:122 */ ["ARRAY_PREPEND", _build_array_prepend],
    /* py:123 */ ["ARRAY_REVERSE_SORT", _build_sort_array_desc],
    /* py:124 */ ["ARRAY_INTERSECT", (args) => new exp.ArrayIntersect({ expressions: args })],
    /* py:125 */ ["ARRAY_SORT", exp.SortArray.from_arg_list],
    /* py:126 */ ["BIT_AND", exp.BitwiseAndAgg.from_arg_list],
    /* py:127 */ ["BIT_OR", exp.BitwiseOrAgg.from_arg_list],
    /* py:128 */ ["BIT_XOR", exp.BitwiseXorAgg.from_arg_list],
    /* py:129 */ ["CURRENT_LOCALTIMESTAMP", exp.Localtimestamp.from_arg_list],
    /* py:130 */ ["DATEDIFF", _build_date_diff],
    /* py:131 */ ["DATE_DIFF", _build_date_diff],
    /* py:132 */ ["DATE_TRUNC", date_trunc_to_time],
    /* py:133 */ ["DATETRUNC", date_trunc_to_time],
    /* py:134 */ ["DECODE", (args) => new exp.Decode({
      this: seqGet(args, 0), charset: exp.Literal.string("utf-8"),
    })],
    /* py:137 */ ["EDITDIST3", exp.Levenshtein.from_arg_list],
    /* py:138 */ ["ENCODE", (args) => new exp.Encode({
      this: seqGet(args, 0), charset: exp.Literal.string("utf-8"),
    })],
    /* py:141 */ ["EPOCH", exp.TimeToUnix.from_arg_list],
    /* py:142 */ ["EPOCH_MS", (args) => new exp.UnixToTime({
      this: seqGet(args, 0), scale: exp.UnixToTime.MILLIS,
    })],
    /* py:143 */ ["FROM_HEX", exp.Unhex.from_arg_list],
    /* py:144 */ ["GENERATE_SERIES", _build_generate_series()],
    /* py:145 */ ["GET_CURRENT_TIME", exp.CurrentTime.from_arg_list],
    /* py:146 */ ["GET_BIT", (args) => new exp.Getbit({
      this: seqGet(args, 0), expression: seqGet(args, 1), zero_is_msb: true,
    })],
    /* py:149 */ ["JARO_WINKLER_SIMILARITY", exp.JarowinklerSimilarity.from_arg_list],
    /* py:150 */ ["JSON", exp.ParseJSON.from_arg_list],
    /* py:151 */ ["JSON_ARRAY", (args) => new exp.JSONArray({ expressions: args })],
    /* py:152 */ ["JSON_EXTRACT_PATH", build_extract_json_with_path(exp.JSONExtract)],
    /* py:153 */ ["JSON_EXTRACT_STRING", build_extract_json_with_path(exp.JSONExtractScalar)],
    /* py:154 */ ["LIST", exp.ArrayAgg.from_arg_list],
    /* py:155 */ ["LIST_DISTINCT", exp.ArrayDistinct.from_arg_list],
    /* py:156 */ ["LIST_APPEND", exp.ArrayAppend.from_arg_list],
    /* py:157 */ ["LIST_CONCAT", build_array_concat],
    /* py:158 */ ["LIST_CONTAINS", exp.ArrayContains.from_arg_list],
    /* py:159 */ ["LIST_COSINE_DISTANCE", exp.CosineDistance.from_arg_list],
    /* py:160 */ ["LIST_DISTANCE", exp.EuclideanDistance.from_arg_list],
    /* py:161 */ ["LIST_FILTER", exp.ArrayFilter.from_arg_list],
    /* py:162 */ ["LIST_HAS", exp.ArrayContains.from_arg_list],
    /* py:163 */ ["LIST_HAS_ANY", exp.ArrayOverlaps.from_arg_list],
    /* py:164 */ ["LIST_MAX", exp.ArrayMax.from_arg_list],
    /* py:165 */ ["LIST_MIN", exp.ArrayMin.from_arg_list],
    /* py:166 */ ["LIST_PREPEND", _build_array_prepend],
    /* py:167 */ ["LIST_REVERSE_SORT", _build_sort_array_desc],
    /* py:168 */ ["LIST_SORT", exp.SortArray.from_arg_list],
    /* py:169 */ ["LIST_TRANSFORM", exp.Transform.from_arg_list],
    /* py:170 */ ["LIST_VALUE", (args) => new exp.Array({ expressions: args })],
    /* py:171 */ ["MAKE_DATE", exp.DateFromParts.from_arg_list],
    /* py:172 */ ["MAKE_TIME", exp.TimeFromParts.from_arg_list],
    /* py:173 */ ["MAKE_TIMESTAMP", _build_make_timestamp],
    /* py:174 */ ["QUANTILE_CONT", exp.PercentileCont.from_arg_list],
    /* py:175 */ ["QUANTILE_DISC", exp.PercentileDisc.from_arg_list],
    /* py:176 */ ["RANGE", _build_generate_series(true)],
    /* py:177 */ ["REGEXP_EXTRACT", build_regexp_extract(exp.RegexpExtract)],
    /* py:178 */ ["REGEXP_EXTRACT_ALL", build_regexp_extract(exp.RegexpExtractAll)],
    /* py:179 */ ["REGEXP_MATCHES", exp.RegexpLike.from_arg_list],
    /* py:180 */ ["REGEXP_REPLACE", (args) => new exp.RegexpReplace({
      this: seqGet(args, 0),
      expression: seqGet(args, 1),
      replacement: seqGet(args, 2),
      modifiers: seqGet(args, 3),
      single_replace: true,
    })],
    /* py:187 */ ["SHA256", (args) => new exp.SHA2({
      this: seqGet(args, 0), length: exp.Literal.number(256),
    })],
    /* py:188 */ ["STRFTIME", build_formatted_time(exp.TimeToStr)],
    /* py:189 */ ["STRING_SPLIT", exp.Split.from_arg_list],
    /* py:190 */ ["STRING_SPLIT_REGEX", exp.RegexpSplit.from_arg_list],
    /* py:191 */ ["STRING_TO_ARRAY", exp.Split.from_arg_list],
    /* py:192 */ ["STRPTIME", build_formatted_time(exp.StrToTime)],
    /* py:193 */ ["STRUCT_PACK", exp.Struct.from_arg_list],
    /* py:194 */ ["STR_SPLIT", exp.Split.from_arg_list],
    /* py:195 */ ["STR_SPLIT_REGEX", exp.RegexpSplit.from_arg_list],
    /* py:196 */ ["TODAY", exp.CurrentDate.from_arg_list],
    /* py:197 */ ["TIME_BUCKET", exp.DateBin.from_arg_list],
    /* py:198 */ ["TO_TIMESTAMP", exp.UnixToTime.from_arg_list],
    /* py:199 */ ["UNNEST", exp.Explode.from_arg_list],
    /* py:200 */ ["VERSION", exp.CurrentVersion.from_arg_list],
    /* py:201 */ ["XOR", binary_from_function(exp.BitwiseXor)],
  ]);

  /** py: sqlglot/parsers/duckdb.py:204 */
  static FUNCTION_PARSERS = new Map([
    // py:205 — FILTERS the parent: DuckDB's DECODE is a plain `FUNCTIONS` builder
    // (py:134), so the base's custom `_parse_decode` syntax parser must not shadow it.
    /* py:205 */ ...[...Parser.FUNCTION_PARSERS].filter(([k]) => k !== "DECODE"),
    // py:206 `dict.fromkeys((...), lambda self: ...)` — one shared lambda, three keys.
    /* py:206 */ ...["GROUP_CONCAT", "LISTAGG", "STRINGAGG"].map((k) => [k, (self) => self._parse_string_agg()]),
    /* py:209 */ ["APPROX_QUANTILE", (self) => self._parse_distinct_arg_function(exp.ApproxQuantile)],
    /* py:210 */ ["QUANTILE", (self) => self._parse_distinct_arg_function(exp.Quantile)],
    /* py:211 */ ["QUANTILE_CONT", (self) => self._parse_distinct_arg_function(exp.PercentileCont)],
    /* py:212 */ ["QUANTILE_DISC", (self) => self._parse_distinct_arg_function(exp.PercentileDisc)],
  ]);

  /** py: sqlglot/parsers/duckdb.py:215 */
  static NO_PAREN_FUNCTION_PARSERS = new Map([
    /* py:216 */ ...Parser.NO_PAREN_FUNCTION_PARSERS,
    /* py:217 */ ["MAP", (self) => self._parse_map()],
    /* py:218 */ ["@", (self) => new exp.Abs({ this: self._parse_bitwise() })],
  ]);

  /** py: sqlglot/parsers/duckdb.py:221 */
  static PLACEHOLDER_PARSERS = new Map([
    /* py:222 */ ...Parser.PLACEHOLDER_PARSERS,
    // py:223 — `self.ID_VAR_TOKENS` is a CLASS field; read via `self.constructor`
    // (R20), otherwise `_match_set(undefined)` throws instead of matching.
    /* py:223 */ [TokenType.PARAMETER, (self) => (
      self._match(TokenType.NUMBER) || self._match_set(self.constructor.ID_VAR_TOKENS)
        ? self.expression(new exp.Placeholder({ this: self._prev.text }))
        : null
    )],
  ]);

  // py:230 — REPLACES outright (the base table is empty anyway).
  /** py: sqlglot/parsers/duckdb.py:230 */
  static TYPE_CONVERTERS = new Map([
    // https://duckdb.org/docs/sql/data_types/numeric
    /* py:232 */ [exp.DType.DECIMAL, build_default_decimal_type(18, 3)],
    // https://duckdb.org/docs/sql/data_types/text
    /* py:234 */ [exp.DType.TEXT, _convert_text_type],
  ]);

  /** py: sqlglot/parsers/duckdb.py:237 */
  static STATEMENT_PARSERS = new Map([
    /* py:238 */ ...Parser.STATEMENT_PARSERS,
    /* py:239 */ [TokenType.ATTACH, (self) => self._parse_attach_detach()],
    /* py:240 */ [TokenType.DETACH, (self) => self._parse_attach_detach(false)],
    /* py:241 */ [TokenType.FORCE, (self) => self._parse_force()],
    /* py:242 */ [TokenType.INSTALL, (self) => self._parse_install()],
    /* py:243 */ [TokenType.SHOW, (self) => self._parse_show()],
  ]);

  /** py: sqlglot/parsers/duckdb.py:246 */
  static SET_PARSERS = new Map([
    /* py:247 */ ...Parser.SET_PARSERS,
    /* py:248 */ ["VARIABLE", (self) => self._parse_set_item_assignment("VARIABLE")],
  ]);

  // py:251-252 — both tries are built from THIS class's own tables (the names in
  // upstream's generator expressions are the class-body locals, not the parent's), so
  // `this` in a static initializer — which is the class being defined — is exactly
  // right. `SHOW_TRIE` therefore covers only TABLES/ALL TABLES; `SET_TRIE` covers the
  // parent's four plus VARIABLE.
  /* py:251 */ static SHOW_TRIE = newTrie([...this.SHOW_PARSERS.keys()].map((key) => key.split(" ")));
  /* py:252 */ static SET_TRIE = newTrie([...this.SET_PARSERS.keys()].map((key) => key.split(" ")));

  /** py: sqlglot/parsers/duckdb.py:254 */
  _parse_function_properties() {
    if (this._match(TokenType.TABLE)) {
      return new exp.Properties({
        expressions: [
          new exp.ReturnsProperty({
            this: new exp.Schema({ this: exp.var("TABLE") }),
            is_table: true,
          }),
        ],
      });
    }
    return super._parse_function_properties();
  }

  /** py: sqlglot/parsers/duckdb.py:266 */
  _parse_lambda(alias = false) {
    const index = this._index;
    if (!this._match_text_seq("LAMBDA")) {
      return super._parse_lambda(alias);
    }

    const expressions = this._parse_csv(() => this._parse_lambda_arg());
    if (!this._match(TokenType.COLON)) {
      this._retreat(index);
      return null;
    }

    const this_ = this._replace_lambda(this._parse_assignment(), expressions);
    return this.expression(new exp.Lambda({ this: this_, expressions, colon: true }));
  }

  /**
   * py: sqlglot/parsers/duckdb.py:279
   *
   * `comments += this.pop_comments() or []` is Python's IN-PLACE list extend on the
   * object `self._prev_comments` currently points at. `_parse_assignment` advances and
   * REBINDS `self._prev_comments` to a different list, so the mutation lands on the
   * detached original — which is what `expression(..., comments)` then consumes.
   * `push(...)` reproduces that aliasing exactly; building a fresh array would not.
   */
  _parse_expression() {
    // DuckDB supports prefix aliases, e.g. foo: 1
    if (this._next.token_type === TokenType.COLON) {
      const alias = this._parse_id_var(true, this.constructor.ALIAS_TOKENS);
      this._match(TokenType.COLON);
      const comments = this._prev_comments;

      const this_ = this._parse_assignment();
      if (this_ instanceof exp.Expr) {
        // Moves the comment next to the alias in `alias: expr /* comment */`
        comments.push(...(this_.popComments() || []));
      }

      return this.expression(new exp.Alias({ this: this_, alias }), null, comments);
    }

    return super._parse_expression();
  }

  /**
   * py: sqlglot/parsers/duckdb.py:295
   *
   * The `super()` call deliberately does NOT forward `consume_pipe`, matching upstream
   * (`parsers/duckdb.py:314-321`) — it is accepted so the override's signature stays
   * substitutable, then dropped. Reproduced as-is rather than "fixed": a divergence
   * here would show up as a silent AST difference on piped queries, not an error.
   */
  _parse_table(
    schema = false,
    joins = false,
    alias_tokens = null,
    parse_bracket = false,
    is_db_reference = false,
    parse_partition = false,
    consume_pipe = false,
  ) {
    let alias;
    let comments;
    // DuckDB supports prefix aliases, e.g. FROM foo: bar
    if (this._next.token_type === TokenType.COLON) {
      // py: `alias_tokens or self.TABLE_ALIAS_TOKENS` — Python `or`, so an explicitly
      // EMPTY collection also falls back. `TABLE_ALIAS_TOKENS` is a class field (R20).
      alias = this._parse_table_alias(
        pyTruthy(alias_tokens) ? alias_tokens : this.constructor.TABLE_ALIAS_TOKENS,
      );
      this._match(TokenType.COLON);
      comments = this._prev_comments;
    } else {
      alias = null;
      comments = [];
    }

    const table = super._parse_table(
      schema,
      joins,
      alias_tokens,
      parse_bracket,
      is_db_reference,
      parse_partition,
    );
    if (table instanceof exp.Expr && alias instanceof exp.TableAlias) {
      // Moves the comment next to the alias in `alias: table /* comment */`
      comments.push(...(table.popComments() || []));
      // py: `alias.pop_comments() + comments` — `+` on lists, so a NEW array.
      alias.comments = [...alias.popComments(), ...comments];
      table.set("alias", alias);
    }

    return table;
  }

  /** py: sqlglot/parsers/duckdb.py:330 */
  _parse_table_sample(as_modifier = false) {
    // https://duckdb.org/docs/sql/samples.html
    const sample = super._parse_table_sample(as_modifier);
    if (sample && !pyTruthy(sample.args.method)) {
      if (pyTruthy(sample.args.size)) {
        sample.set("method", exp.var("RESERVOIR"));
      } else {
        sample.set("method", exp.var("SYSTEM"));
      }
    }

    return sample;
  }

  /** py: sqlglot/parsers/duckdb.py:341 */
  _parse_bracket(this_ = null) {
    const bracket = super._parse_bracket(this_);

    if (_versionLt(this.dialect.version, 1n, 2n) && bracket instanceof exp.Bracket) {
      // https://duckdb.org/2025/02/05/announcing-duckdb-120.html#breaking-changes
      bracket.set("returns_list_for_maps", true);
    }

    return bracket;
  }

  /** py: sqlglot/parsers/duckdb.py:350 */
  _parse_map() {
    if (this._match(TokenType.L_BRACE, false)) {
      return this.expression(new exp.ToMap({ this: this._parse_bracket() }));
    }

    const args = this._parse_wrapped_csv(() => this._parse_assignment());
    return this.expression(new exp.Map({ keys: seqGet(args, 0), values: seqGet(args, 1) }));
  }

  // py:357 — `type_required` is accepted for signature compatibility and ignored;
  // DuckDB always delegates to `_parse_field_def`.
  /** py: sqlglot/parsers/duckdb.py:357 */
  _parse_struct_types(type_required = false) {
    return this._parse_field_def();
  }

  /** py: sqlglot/parsers/duckdb.py:360 */
  _pivot_column_names(aggregations) {
    if (aggregations.length === 1) {
      return super._pivot_column_names(aggregations);
    }
    return pivot_column_names(aggregations, "duckdb");
  }

  /**
   * py: sqlglot/parsers/duckdb.py:365
   *
   * `self._parse_exists(not_=is_attach)` — NOT negated. ATTACH takes `IF NOT EXISTS`
   * and DETACH takes `IF EXISTS`, so the flag passes straight through; writing
   * `!is_attach` here would invert both and is the exact R18 argument-shape trap.
   */
  _parse_attach_detach(is_attach = true) {
    const _parse_attach_option = () => this.expression(
      new exp.AttachOption({
        this: this._parse_var(true),
        expression: this._parse_field(true),
      }),
    );

    this._match(TokenType.DATABASE);
    const exists = this._parse_exists(is_attach);
    const this_ = this._parse_alias(this._parse_primary_or_var(), true);

    let expressions;
    if (this._match(TokenType.L_PAREN, false)) {
      expressions = this._parse_wrapped_csv(_parse_attach_option);
    } else {
      expressions = null;
    }

    return is_attach
      ? this.expression(new exp.Attach({ this: this_, exists, expressions }))
      : this.expression(new exp.Detach({ this: this_, exists }));
  }

  /** py: sqlglot/parsers/duckdb.py:389 */
  _parse_show_duckdb(this_) {
    const from_ = this._match(TokenType.FROM) ? this._parse_table(true) : null;
    return this.expression(new exp.Show({ this: this_, from_ }));
  }

  /** py: sqlglot/parsers/duckdb.py:393 */
  _parse_force() {
    // FORCE can only be followed by INSTALL or CHECKPOINT
    // In the case of CHECKPOINT, we fallback
    if (!this._match(TokenType.INSTALL)) {
      return this._parse_as_command(this._prev);
    }

    return this._parse_install(true);
  }

  /** py: sqlglot/parsers/duckdb.py:401 */
  _parse_install(force = false) {
    return this.expression(
      new exp.Install({
        this: this._parse_id_var(),
        from_: this._match(TokenType.FROM) ? this._parse_var_or_string() : null,
        force,
      }),
    );
  }

  // py:410 — the HASH+NUMBER branch returns a BARE node, not `self.expression(...)`:
  // no position update and no `validate_expression`. Faithful as written.
  /** py: sqlglot/parsers/duckdb.py:410 */
  _parse_primary() {
    if (this._match_pair(TokenType.HASH, TokenType.NUMBER)) {
      return new exp.PositionalColumn({ this: exp.Literal.number(this._prev.text) });
    }

    return super._parse_primary();
  }
}
