// py: sqlglot/parsers/clickhouse.py @ 91119bc — WHOLE FILE (1010 LOC), AIR-2288.
//
// `class ClickHouseParser(parser.Parser)` — the READ-side ClickHouse grammar, landing
// alongside `dialects/clickhouse.py` (settings) and `generators/clickhouse.py` (write
// side) in this same round, PORT_PLAN.md R38's "full stack in one round" shape.
// Extends the base `Parser` directly, same self-contained shape TSQL/Snowflake/
// Postgres/Presto/MySQL already used.
//
// `_resolve_clickhouse_agg`'s `deque` is ported as a plain JS array: `appendleft` is
// `unshift`, which is the only deque operation this method uses — no O(1) requirement
// crosses into observable behavior here.
//
// `utf8Len` (src/_py/str.js, pre-built for exactly this call site — see that file's
// own comment) stands in for `len(sep_value.encode("utf-8"))` in `_build_split_by_char`:
// a `.length` port would pass every corpus atom (all ASCII) and still misclassify a
// multi-byte single-character separator like `'é'`.

import * as exp from "../expressions/index.js";
import { Parser, build_var_map } from "../parser.js";
import { TokenType } from "../tokens.js";
import { seqGet } from "../helper.js";
import {
  build_date_delta,
  build_formatted_time,
  build_json_extract_path,
  build_like,
} from "../dialects/dialect.js";
import { pyUpper } from "../_py/str.js";
import { utf8Len } from "../_py/str.js";

/** py: sqlglot/parsers/clickhouse.py:23 */
function _build_datetime_format(expr_type) {
  return function _builder(args, dialect) {
    const expr = build_formatted_time(expr_type)(args, dialect);

    const timezone = seqGet(args, 2);
    if (timezone) expr.set("zone", timezone);

    return expr;
  };
}

/** py: sqlglot/parsers/clickhouse.py:38 */
function _build_count_if(args) {
  if (args.length === 1) return new exp.CountIf({ this: seqGet(args, 0) });

  return new exp.CombinedAggFunc({ this: "countIf", expressions: args });
}

/** py: sqlglot/parsers/clickhouse.py:45 */
function _build_str_to_date(args) {
  if (args.length === 3) return new exp.Anonymous({ this: "STR_TO_DATE", expressions: args });

  const strtodate = exp.StrToDate.from_arg_list(args);
  return exp.cast(strtodate, exp.DType.DATETIME.into_expr());
}

/** py: sqlglot/parsers/clickhouse.py:53 */
function _build_timestamp_trunc(unit) {
  return (args) =>
    new exp.TimestampTrunc({ this: seqGet(args, 0), unit: exp.var(unit), zone: seqGet(args, 1) });
}

/** py: sqlglot/parsers/clickhouse.py:59 */
function _build_split_by_char(args) {
  const sep = seqGet(args, 0);
  if (sep instanceof exp.Literal) {
    const sep_value = sep.to_py();
    if (typeof sep_value === "string" && utf8Len(sep_value) === 1) {
      return _build_split(exp.Split)(args);
    }
  }

  return new exp.Anonymous({ this: "splitByChar", expressions: args });
}

/** py: sqlglot/parsers/clickhouse.py:69 */
function _build_split(exp_class) {
  return (args) =>
    new exp_class({ this: seqGet(args, 1), expression: seqGet(args, 0), limit: seqGet(args, 2) });
}

// py:75-87 "Skip the 'week' unit since ClickHouse's toStartOfWeek uses an extra mode
// argument to specify the first day of the week"
const TIMESTAMP_TRUNC_UNITS = new Set([
  "MICROSECOND",
  "MILLISECOND",
  "SECOND",
  "MINUTE",
  "HOUR",
  "DAY",
  "MONTH",
  "QUARTER",
  "YEAR",
]);

/** py:90-208 `_AGG_FUNCTIONS`. */
const _AGG_FUNCTIONS = new Set([
  "count", "min", "max", "sum", "avg", "any", "stddevPop", "stddevSamp", "varPop", "varSamp",
  "corr", "covarPop", "covarSamp", "entropy", "exponentialMovingAverage", "intervalLengthSum",
  "kolmogorovSmirnovTest", "mannWhitneyUTest", "median", "rankCorr", "sumKahan", "studentTTest",
  "welchTTest", "anyHeavy", "anyLast", "boundingRatio", "first_value", "last_value", "argMin",
  "argMax", "avgWeighted", "topK", "approx_top_sum", "topKWeighted", "deltaSum",
  "deltaSumTimestamp", "groupArray", "groupArrayLast", "groupConcat", "groupUniqArray",
  "groupArrayInsertAt", "groupArrayMovingAvg", "groupArrayMovingSum", "groupArraySample",
  "groupBitAnd", "groupBitOr", "groupBitXor", "groupBitmap", "groupBitmapAnd", "groupBitmapOr",
  "groupBitmapXor", "sumWithOverflow", "sumMap", "minMap", "maxMap", "skewSamp", "skewPop",
  "kurtSamp", "kurtPop", "uniq", "uniqExact", "uniqCombined", "uniqCombined64", "uniqHLL12",
  "uniqTheta", "quantile", "quantiles", "quantileExact", "quantileExactInclusive",
  "quantilesExact", "quantilesExactExclusive", "quantileExactLow", "quantilesExactLow",
  "quantileExactHigh", "quantilesExactHigh", "quantileExactWeighted", "quantilesExactWeighted",
  "quantileTiming", "quantilesTiming", "quantileTimingWeighted", "quantilesTimingWeighted",
  "quantileDeterministic", "quantilesDeterministic", "quantileTDigest", "quantilesTDigest",
  "quantileTDigestWeighted", "quantilesTDigestWeighted", "quantileBFloat16", "quantilesBFloat16",
  "quantileBFloat16Weighted", "quantilesBFloat16Weighted", "simpleLinearRegression",
  "stochasticLinearRegression", "stochasticLogisticRegression", "categoricalInformationValue",
  "contingency", "cramersV", "cramersVBiasCorrected", "theilsU", "maxIntersections",
  "maxIntersectionsPosition", "meanZTest", "quantileInterpolatedWeighted",
  "quantilesInterpolatedWeighted", "quantileGK", "quantilesGK", "sparkBar", "sumCount",
  "largestTriangleThreeBuckets", "histogram", "sequenceMatch", "sequenceCount", "windowFunnel",
  "retention", "uniqUpTo", "sequenceNextNode", "exponentialTimeDecayedAvg",
]);

/**
 * py:210-232 `_AGG_FUNCTIONS_SUFFIXES` — "Sorted longest-first so that compound
 * suffixes (e.g. "SimpleState") are matched before their sub-suffixes (e.g. "State")
 * when resolving multi-combinator functions." Python's `sorted(..., key=len,
 * reverse=True)` is a STABLE sort, so entries of equal length keep their original
 * relative order; `Array.prototype.sort` is also stable (ES2019+), so a plain
 * length-descending comparator reproduces it exactly.
 */
const _AGG_FUNCTIONS_SUFFIXES = [
  "If", "Array", "ArrayIf", "Map", "SimpleState", "State", "Merge", "MergeState", "ForEach",
  "Distinct", "OrDefault", "OrNull", "Resample", "ArgMin", "ArgMax",
].sort((a, b) => b.length - a.length);

/**
 * py:234-237 `_AGG_FUNC_MAPPING` — "Memoized examples of all 0- and 1-suffix
 * aggregate function names." Built in the SAME two-pass order as the dict-union
 * (`|`) upstream uses: every `{f}{sfx}` entry first (outer loop over suffixes, inner
 * over functions, matching upstream's comprehension order exactly), then every
 * 0-suffix `{f: (f, None)}` entry, whose keys never collide with the first pass since
 * `_AGG_FUNCTIONS` and its suffixed forms are disjoint by construction.
 */
const _AGG_FUNC_MAPPING = new Map();
for (const sfx of _AGG_FUNCTIONS_SUFFIXES) {
  for (const f of _AGG_FUNCTIONS) _AGG_FUNC_MAPPING.set(`${f}${sfx}`, [f, sfx]);
}
for (const f of _AGG_FUNCTIONS) _AGG_FUNC_MAPPING.set(f, [f, null]);

/** py: sqlglot/parsers/clickhouse.py:240 `class ClickHouseParser(parser.Parser)`. */
export class ClickHouseParser extends Parser {
  // py:241-244 "Tested in ClickHouse's playground, it seems that the following two
  // queries do the same thing: `select x from t1 union all select x from t2 limit 1`
  // and `select x from t1 union all (select x from t2 limit 1)`."
  static MODIFIERS_ATTACHED_TO_SET_OP = false;
  static INTERVAL_SPANS = false;
  static OPTIONAL_ALIAS_TOKEN_CTE = false;
  static JOINS_HAVE_EQUAL_PRECEDENCE = true;

  /** py:249-325 */
  static FUNCTIONS = new Map([
    ...[...Parser.FUNCTIONS].filter(([k]) => k !== "TRANSFORM" && k !== "APPROX_TOP_SUM"),
    ...["REGEXPEXTRACT", "REGEXP_EXTRACT", "REGEXP_SUBSTR"].map((regexp_extract) => [
      regexp_extract,
      (args) => new exp.RegexpExtract({
        this: seqGet(args, 0), expression: seqGet(args, 1), group: seqGet(args, 2),
      }),
    ]),
    ...[...TIMESTAMP_TRUNC_UNITS].map((unit) => [`TOSTARTOF${unit}`, _build_timestamp_trunc(unit)]),
    ["ANY", exp.AnyValue.from_arg_list],
    ["ARRAYCOMPACT", exp.ArrayCompact.from_arg_list],
    ["ARRAYCONCAT", exp.ArrayConcat.from_arg_list],
    ["ARRAYDISTINCT", exp.ArrayDistinct.from_arg_list],
    ["ARRAYEXCEPT", exp.ArrayExcept.from_arg_list],
    ["ARRAYSUM", exp.ArraySum.from_arg_list],
    ["ARRAYMAX", exp.ArrayMax.from_arg_list],
    ["ARRAYMIN", exp.ArrayMin.from_arg_list],
    ["ARRAYREVERSE", exp.ArrayReverse.from_arg_list],
    ["ARRAYSLICE", exp.ArraySlice.from_arg_list],
    ["ARRAYFILTER", (args) => new exp.ArrayFilter({ this: seqGet(args, 1), expression: seqGet(args, 0) })],
    ["ARRAYMAP", (args) => new exp.Transform({ this: seqGet(args, 1), expression: seqGet(args, 0) })],
    ["CURRENTDATABASE", exp.CurrentDatabase.from_arg_list],
    ["CURRENTSCHEMAS", exp.CurrentSchemas.from_arg_list],
    ["COUNTIF", _build_count_if],
    ["CITYHASH64", exp.CityHash64.from_arg_list],
    ["COSINEDISTANCE", exp.CosineDistance.from_arg_list],
    ["VERSION", exp.CurrentVersion.from_arg_list],
    ["DATE_ADD", build_date_delta(exp.DateAdd, null, null)],
    ["DATEADD", build_date_delta(exp.DateAdd, null, null)],
    ["DATE_DIFF", build_date_delta(exp.DateDiff, null, null, true)],
    ["DATEDIFF", build_date_delta(exp.DateDiff, null, null, true)],
    ["DATE_FORMAT", _build_datetime_format(exp.TimeToStr)],
    ["DATE_SUB", build_date_delta(exp.DateSub, null, null)],
    ["DATESUB", build_date_delta(exp.DateSub, null, null)],
    ["DATETRUNC", exp.DateTrunc.from_arg_list],
    ["FORMATDATETIME", _build_datetime_format(exp.TimeToStr)],
    ["HAS", exp.ArrayContains.from_arg_list],
    ["ILIKE", build_like(exp.ILike)],
    ["JSONEXTRACTSTRING", build_json_extract_path(exp.JSONExtractScalar, false)],
    ["LENGTH", (args) => new exp.Length({ this: seqGet(args, 0), binary: true })],
    ["LIKE", build_like(exp.Like)],
    ["L2Distance", exp.EuclideanDistance.from_arg_list],
    ["MAP", build_var_map],
    ["MATCH", exp.RegexpLike.from_arg_list],
    ["NOTLIKE", build_like(exp.Like, true)],
    ["PARSEDATETIME", _build_datetime_format(exp.ParseDatetime)],
    ["RANDCANONICAL", exp.Rand.from_arg_list],
    ["STR_TO_DATE", _build_str_to_date],
    ["TIMESTAMP_SUB", build_date_delta(exp.TimestampSub, null, null)],
    ["TIMESTAMPSUB", build_date_delta(exp.TimestampSub, null, null)],
    ["TIMESTAMP_ADD", build_date_delta(exp.TimestampAdd, null, null)],
    ["TIMESTAMPADD", build_date_delta(exp.TimestampAdd, null, null)],
    ["TOMONDAY", _build_timestamp_trunc("WEEK")],
    ["UNIQ", exp.ApproxDistinct.from_arg_list],
    ["MD5", exp.MD5Digest.from_arg_list],
    ["SHA256", (args) => new exp.SHA2({ this: seqGet(args, 0), length: exp.Literal.number(256) })],
    ["SHA512", (args) => new exp.SHA2({ this: seqGet(args, 0), length: exp.Literal.number(512) })],
    ["SPLITBYCHAR", _build_split_by_char],
    ["SPLITBYREGEXP", _build_split(exp.RegexpSplit)],
    ["SPLITBYSTRING", _build_split(exp.Split)],
    ["SUBSTRINGINDEX", exp.SubstringIndex.from_arg_list],
    ["TOTYPENAME", exp.Typeof.from_arg_list],
    ["EDITDISTANCE", exp.Levenshtein.from_arg_list],
    ["JAROWINKLERSIMILARITY", exp.JarowinklerSimilarity.from_arg_list],
    ["LEVENSHTEINDISTANCE", exp.Levenshtein.from_arg_list],
    ["UTCTIMESTAMP", exp.UtcTimestamp.from_arg_list],
  ]);

  /** py:327 `AGG_FUNCTIONS: t.ClassVar = _AGG_FUNCTIONS`. */
  static AGG_FUNCTIONS = _AGG_FUNCTIONS;
  /** py:328 `AGG_FUNCTIONS_SUFFIXES: t.ClassVar = _AGG_FUNCTIONS_SUFFIXES`. */
  static AGG_FUNCTIONS_SUFFIXES = _AGG_FUNCTIONS_SUFFIXES;

  /** py:330-336 */
  static FUNC_TOKENS = new Set([
    ...Parser.FUNC_TOKENS,
    TokenType.AND,
    TokenType.FILE,
    TokenType.OR,
    TokenType.SET,
  ]);

  /** py:338 */
  static RESERVED_TOKENS = new Set([...Parser.RESERVED_TOKENS].filter((t) => t !== TokenType.SELECT));

  /** py:340-343 */
  static ID_VAR_TOKENS = new Set([...Parser.ID_VAR_TOKENS, TokenType.LIKE]);

  /** py:345 `AGG_FUNC_MAPPING: t.ClassVar = _AGG_FUNC_MAPPING`. */
  static AGG_FUNC_MAPPING = _AGG_FUNC_MAPPING;

  /**
   * py:347-375 `_resolve_clickhouse_agg` — a `@classmethod` upstream; ported as a
   * static method, same convention every other classmethod in this port uses.
   *
   * "ClickHouse allows chaining multiple combinators on aggregate functions. [...]
   * N.B. this resolution allows any suffix stack, including ones that ClickHouse
   * rejects syntactically such as sumMergeMerge (due to repeated adjacent suffixes)."
   *
   * "Until we are able to identify a 1- or 0-suffix aggregate function by name,
   * repeatedly strip and queue suffixes (checking longer suffixes first [...]). This
   * loop only runs for 2 or more suffixes, as AGG_FUNC_MAPPING memoizes all 0- and
   * 1-suffix [forms]."
   *
   * @returns {[string, string[]] | null}
   */
  static _resolve_clickhouse_agg(name) {
    const accumulated_suffixes = [];
    let parts = _AGG_FUNC_MAPPING.get(name);
    while (parts === undefined) {
      let matched = false;
      for (const suffix of _AGG_FUNCTIONS_SUFFIXES) {
        if (name.endsWith(suffix) && name.length !== suffix.length) {
          accumulated_suffixes.unshift(suffix);
          name = name.slice(0, name.length - suffix.length);
          matched = true;
          break;
        }
      }
      if (!matched) return null;
      parts = _AGG_FUNC_MAPPING.get(name);
    }

    // We now have a 0- or 1-suffix aggregate
    const [agg_func_name, inner_suffix] = parts;
    if (inner_suffix) {
      // this is a 1-suffix aggregate (either naturally or via repeated suffix
      // stripping). prepend the innermost suffix.
      accumulated_suffixes.unshift(inner_suffix);
    }

    return [agg_func_name, accumulated_suffixes];
  }

  /** py:377-388 */
  static FUNCTION_PARSERS = new Map([
    ...[...Parser.FUNCTION_PARSERS].filter(([k]) => k !== "MATCH"),
    ["ARRAYJOIN", (self) => self.expression(new exp.Explode({ this: self._parse_expression() }))],
    ["GROUPCONCAT", (self) => self._parse_group_concat()],
    ["QUANTILE", (self) => self._parse_quantile()],
    ["MEDIAN", (self) => self._parse_quantile()],
    ["COLUMNS", (self) => self._parse_columns()],
    ["TUPLE", (self) => exp.Struct.from_arg_list(self._parse_function_args(true))],
    ["AND", (self) => self._parse_connector_function(exp.and_)],
    ["OR", (self) => self._parse_connector_function(exp.or_)],
    ["XOR", (self) => exp.xor(...self._parse_function_args(false))],
  ]);

  /** py:390-395 */
  static PROPERTY_PARSERS = new Map([
    ...[...Parser.PROPERTY_PARSERS].filter(([k]) => k !== "DYNAMIC"),
    ["ENGINE", (self) => self._parse_engine_property()],
    ["REFRESH", (self) => self._parse_auto_refresh_property()],
    ["UUID", (self) => self.expression(new exp.UuidProperty({ this: self._parse_string() }))],
  ]);

  /** py:397-399 */
  static NO_PAREN_FUNCTION_PARSERS = new Map(
    [...Parser.NO_PAREN_FUNCTION_PARSERS].filter(([k]) => k !== "ANY"),
  );

  /** py:401-405 */
  static NO_PAREN_FUNCTIONS = new Map(
    [...Parser.NO_PAREN_FUNCTIONS].filter(([k]) => k !== TokenType.CURRENT_TIMESTAMP),
  );

  /** py:407-410 */
  static RANGE_PARSERS = new Map([
    ...Parser.RANGE_PARSERS,
    [TokenType.GLOBAL, (self, this_) => self._parse_global_in(this_)],
  ]);

  /** py:412-417 */
  static COLUMN_OPERATORS = new Map([
    ...[...Parser.COLUMN_OPERATORS].filter(([k]) => k !== TokenType.PLACEHOLDER),
    [TokenType.DOTCARET, (self, this_, field) => self.expression(new exp.NestedJSONSelect({ this: this_, expression: field }))],
  ]);

  /** py:419-425 */
  static JOIN_KINDS = new Set([
    ...Parser.JOIN_KINDS,
    TokenType.ALL,
    TokenType.ANY,
    TokenType.ASOF,
    TokenType.ARRAY,
  ]);

  /** py:427-435 */
  static TABLE_ALIAS_TOKENS = new Set(
    [...Parser.TABLE_ALIAS_TOKENS].filter((t) => ![
      TokenType.ALL, TokenType.ANY, TokenType.ARRAY, TokenType.ASOF, TokenType.FINAL,
      TokenType.FORMAT, TokenType.SETTINGS,
    ].includes(t)),
  );

  /** py:437-440 */
  static ALIAS_TOKENS = new Set(
    [...Parser.ALIAS_TOKENS].filter((t) => t !== TokenType.FORMAT && t !== TokenType.SETTINGS),
  );

  /** py:442 */
  static LOG_DEFAULTS_TO_LN = true;

  /** py:444-451 */
  static QUERY_MODIFIER_PARSERS = new Map([
    ...Parser.QUERY_MODIFIER_PARSERS,
    [TokenType.SETTINGS, (self) => ["settings", self._advance() || self._parse_csv(() => self._parse_assignment())]],
    [TokenType.FORMAT, (self) => ["format", self._advance() || self._parse_id_var()]],
  ]);

  /** py:453-458 */
  static CONSTRAINT_PARSERS = new Map([
    ...Parser.CONSTRAINT_PARSERS,
    ["INDEX", (self) => self._parse_index_constraint()],
    ["CODEC", (self) => self._parse_compress()],
    ["ASSUME", (self) => self._parse_assume_constraint()],
  ]);

  /** py:460-464 */
  static ALTER_PARSERS = new Map([
    ...Parser.ALTER_PARSERS,
    ["MODIFY", (self) => self._parse_alter_table_alter()],
    ["REPLACE", (self) => self._parse_alter_table_replace()],
  ]);

  /** py:466-469 */
  static SCHEMA_UNNAMED_CONSTRAINTS = new Set(
    [...new Set([...Parser.SCHEMA_UNNAMED_CONSTRAINTS, "INDEX"])].filter((k) => k !== "CHECK"),
  );

  /** py:471-474 */
  static PLACEHOLDER_PARSERS = new Map([
    ...Parser.PLACEHOLDER_PARSERS,
    [TokenType.L_BRACE, (self) => self._parse_query_parameter()],
  ]);

  /** py:476-479 */
  static STATEMENT_PARSERS = new Map([
    ...Parser.STATEMENT_PARSERS,
    [TokenType.DETACH, (self) => self._parse_detach()],
  ]);

  /** py:481-484 */
  _parse_wrapped_select_or_assignment() {
    return this._parse_wrapped(() => this._parse_select() || this._parse_assignment(), true);
  }

  /** py:486-489 */
  _parse_check_constraint() {
    return this.expression(new exp.CheckColumnConstraint({ this: this._parse_wrapped_select_or_assignment() }));
  }

  /** py:491-494 */
  _parse_assume_constraint() {
    return this.expression(new exp.AssumeColumnConstraint({ this: this._parse_wrapped_select_or_assignment() }));
  }

  /** py:496-500 */
  _parse_engine_property() {
    this._match(TokenType.EQ);
    return this.expression(new exp.EngineProperty({ this: this._parse_field(true, null, true) }));
  }

  // https://clickhouse.com/docs/en/sql-reference/statements/create/function
  /** py:503-504 */
  _parse_user_defined_function_expression() {
    return this._parse_lambda();
  }

  /** py:506-527 */
  _parse_types(check_func = false, schema = false, allow_identifiers = true, with_collation = false) {
    const dtype = super._parse_types(check_func, schema, allow_identifiers, with_collation);
    if (dtype instanceof exp.DataType && dtype.args.nullable !== true) {
      // Mark every type as non-nullable which is ClickHouse's default, unless it's
      // already marked as nullable. This marker helps us transpile types from other
      // dialects to ClickHouse, so that we can e.g. produce `CAST(x AS Nullable(String))`
      // from `CAST(x AS TEXT)`. If there is a `NULL` value in `x`, the former would
      // fail in ClickHouse without the `Nullable` type constructor.
      dtype.set("nullable", false);
    }

    return dtype;
  }

  /** py:529-544 */
  _parse_extract() {
    const index = this._index;
    const this_ = this._parse_bitwise();
    if (this._match(TokenType.FROM)) {
      this._retreat(index);
      return super._parse_extract();
    }

    // We return Anonymous here because extract and regexpExtract have different semantics,
    // so parsing extract(foo, bar) into RegexpExtract can potentially break queries. E.g.,
    // `extract('foobar', 'b')` works, but ClickHouse crashes for `regexpExtract('foobar', 'b')`.
    //
    // TODO: can we somehow convert the former into an equivalent `regexpExtract` call?
    this._match(TokenType.COMMA);
    return this.expression(new exp.Anonymous({ this: "extract", expressions: [this_, this._parse_bitwise()] }));
  }

  /** py:546-558 */
  _parse_assignment() {
    const this_ = super._parse_assignment();

    if (this._match(TokenType.PLACEHOLDER)) {
      return this.expression(new exp.If({
        this: this_,
        true: this._parse_assignment(),
        false: this._match(TokenType.COLON) && this._parse_assignment(),
      }));
    }

    return this_;
  }

  /**
   * Parse a placeholder expression like SELECT {abc: UInt32} or FROM {table: Identifier}
   * https://clickhouse.com/docs/en/sql-reference/syntax#defining-and-using-query-parameters
   *
   * py:560-582
   */
  _parse_query_parameter() {
    const index = this._index;

    let this_ = this._parse_id_var();
    this._match(TokenType.COLON);
    const kind = this._parse_types(false, false, false)
      || (this._match_text_seq("IDENTIFIER") && "Identifier");

    if (!kind) {
      this._retreat(index);
      return null;
    }
    if (!this._match(TokenType.R_BRACE)) {
      this.raise_error("Expecting }");
    }

    if (this_ instanceof exp.Identifier && !this_.args.quoted) {
      this_ = exp.var(this_.name);
    }

    return this.expression(new exp.Placeholder({ this: this_, kind }));
  }

  /** py:584-615 */
  _parse_bracket(this_ = null) {
    if (this_) {
      let bracket_json_type = null;

      while (this._match_pair(TokenType.L_BRACKET, TokenType.R_BRACKET)) {
        bracket_json_type = new exp.DataType({
          this: exp.DType.ARRAY,
          expressions: [
            bracket_json_type
              || exp.DType.JSON.into_expr({ dialect: this.dialect, nullable: false }),
          ],
          nested: true,
        });
      }

      if (bracket_json_type) {
        return this.expression(new exp.JSONCast({ this: this_, to: bracket_json_type }));
      }
    }

    const l_brace = this._match(TokenType.L_BRACE, false);
    const bracket = super._parse_bracket(this_);

    if (l_brace && bracket instanceof exp.Struct) {
      const varmap = new exp.VarMap({ keys: new exp.Array(), values: new exp.Array() });
      for (const expression of bracket.expressions) {
        if (!(expression instanceof exp.PropertyEQ)) break;

        varmap.args.keys.append("expressions", exp.Literal.string(expression.name));
        varmap.args.values.append("expressions", expression.expression);
      }

      return varmap;
    }

    return bracket;
  }

  /** py:617-623 */
  _parse_global_in(this_) {
    const is_negated = this._match(TokenType.NOT);
    let in_expr = null;
    if (this._match(TokenType.IN)) {
      in_expr = this._parse_in(this_);
      in_expr.set("is_global", true);
    }
    return is_negated ? this.expression(new exp.Not({ this: in_expr })) : in_expr;
  }

  /** py:625-653 */
  _parse_table(schema = false, joins = false, alias_tokens = null, parse_bracket = false, is_db_reference = false, parse_partition = false, consume_pipe = false) {
    let this_ = super._parse_table(schema, joins, alias_tokens, parse_bracket, is_db_reference);

    if (this_ instanceof exp.Table) {
      const inner = this_.this;
      const alias = this_.args.alias;

      if (inner instanceof exp.GenerateSeries && alias && !alias.args.columns) {
        alias.set("columns", [exp.toIdentifier("generate_series")]);
      }
    }

    if (this._match(TokenType.FINAL)) {
      this_ = this.expression(new exp.Final({ this: this_ }));
    }

    return this_;
  }

  /** py:655-656 */
  _parse_position(haystack_first = false) {
    return super._parse_position(true);
  }

  // https://clickhouse.com/docs/en/sql-reference/statements/select/with/
  /** py:658-669 */
  _parse_cte() {
    // WITH <identifier> AS <subquery expression>
    let cte = this._try_parse(() => super._parse_cte());

    if (!cte) {
      // WITH <expression> AS <identifier>
      cte = this.expression(new exp.CTE({
        this: this._parse_assignment(), alias: this._parse_table_alias(), scalar: true,
      }));
    }

    return cte;
  }

  /** py:671-680 */
  _parse_join_parts() {
    const is_global = this._match(TokenType.GLOBAL) ? this._prev : null;

    const kind_pre = this._match_set(this.constructor.JOIN_KINDS) ? this._prev : null;
    const side = this._match_set(this.constructor.JOIN_SIDES) ? this._prev : null;
    const kind = this._match_set(this.constructor.JOIN_KINDS) ? this._prev : null;

    return [is_global, side || kind, kind_pre || kind];
  }

  /** py:682-702 */
  _parse_join(skip_join_token = false, parse_bracket = false, alias_tokens = null) {
    const join = super._parse_join(skip_join_token, true, alias_tokens);
    if (join) {
      const method = join.args.method;
      join.set("method", null);
      join.set("global_", method);

      // tbl ARRAY JOIN arr <-- this should be a `Column` reference, not a `Table`
      // https://clickhouse.com/docs/en/sql-reference/statements/select/array-join
      if (join.kind === "ARRAY") {
        for (const table of join.findAll(exp.Table)) {
          table.replace(table.to_column());
        }
      }
    }

    return join;
  }

  /** py:704-750 */
  _parse_function(functions = null, anonymous = false, optional_parens = true, any_token = false) {
    const expr = super._parse_function(functions, anonymous, optional_parens, any_token);

    const func = expr instanceof exp.Window ? expr.this : expr;

    // Aggregate functions can be split in 2 parts: <func_name><suffix[es]>
    const parts = func instanceof exp.Anonymous
      ? this.constructor._resolve_clickhouse_agg(func.name)
      : null;

    if (parts) {
      const anon_func = func;
      const params = this._parse_func_params(anon_func);

      const exp_class = parts[1].length > 0
        ? (params ? exp.CombinedParameterizedAgg : exp.CombinedAggFunc)
        : (params ? exp.ParameterizedAgg : exp.AnonymousAggFunc);

      const instance = new exp_class({ this: anon_func.this, expressions: anon_func.expressions });
      if (params) instance.set("params", params);
      let out = this.expression(instance);

      if (expr instanceof exp.Window) {
        // The window's func was parsed as Anonymous in base parser, fix its
        // type to be ClickHouse style CombinedAnonymousAggFunc / AnonymousAggFunc
        expr.set("this", out);
        return expr;
      }
      if (params) {
        // Params have blocked super()._parse_function() from parsing the following window
        // (if that exists) as they're standing between the function call and the window spec
        return this._parse_window(out);
      }
      return out;
    }

    return expr;
  }

  /** py:752-761 */
  _parse_func_params(this_ = null) {
    if (this._match_pair(TokenType.R_PAREN, TokenType.L_PAREN)) {
      return this._parse_csv(() => this._parse_lambda());
    }

    if (this._match(TokenType.L_PAREN)) {
      const params = this._parse_csv(() => this._parse_lambda());
      this._match_r_paren(this_);
      return params;
    }

    return null;
  }

  /** py:763-777 */
  _parse_group_concat() {
    const args = this._parse_csv(() => this._parse_lambda());
    const params = this._parse_func_params();

    if (params) {
      // groupConcat(sep [, limit])(expr)
      const separator = seqGet(args, 0);
      const limit = seqGet(args, 1);
      let this_ = seqGet(params, 0);
      if (limit !== null && limit !== undefined) this_ = new exp.Limit({ this: this_, expression: limit });
      return this.expression(new exp.GroupConcat({ this: this_, separator }));
    }

    // groupConcat(expr)
    return this.expression(new exp.GroupConcat({ this: seqGet(args, 0) }));
  }

  /** py:779-784 */
  _parse_quantile() {
    const this_ = this._parse_lambda();
    const params = this._parse_func_params();
    if (params) {
      return this.expression(new exp.Quantile({ this: params[0], quantile: this_ }));
    }
    return this.expression(new exp.Quantile({ this: this_, quantile: exp.Literal.number(0.5) }));
  }

  /** py:786-787 */
  _parse_wrapped_id_vars(optional = false) {
    return super._parse_wrapped_id_vars(true);
  }

  /** py:789-795 */
  _parse_column_def(this_, computed_column = true) {
    if (this._match(TokenType.DOT)) {
      return new exp.Dot({ this: this_, expression: this._parse_id_var() });
    }

    return super._parse_column_def(this_, computed_column);
  }

  /** py:797-807 */
  _parse_primary_key(wrapped_optional = false, in_props = false, named_primary_key = false) {
    return super._parse_primary_key(wrapped_optional || in_props, in_props, named_primary_key);
  }

  /** py:809-817 */
  _parse_on_property() {
    const index = this._index;
    if (this._match_text_seq("CLUSTER")) {
      const this_ = this._parse_string() || this._parse_id_var();
      if (this_) {
        return this.expression(new exp.OnCluster({ this: this_ }));
      }
      this._retreat(index);
    }
    return null;
  }

  /** py:819-869 */
  _parse_auto_refresh_property() {
    const index = this._index - 1;
    const cadence = this._match_texts(["EVERY", "AFTER"]) ? pyUpper(this._prev.text) : null;
    const interval = cadence
      ? this._parse_interval(false, false)
      : null;

    if (cadence && !interval) {
      this._retreat(index);
      return null;
    }

    let offset = null;
    if (this._match_text_seq("OFFSET")) {
      offset = this._parse_interval(false, false);
      if (!offset) {
        this._retreat(index);
        return null;
      }
    }

    let randomize = null;
    if (this._match_text_seq("RANDOMIZE", "FOR")) {
      randomize = this._parse_interval(false, false);
      if (!randomize) {
        this._retreat(index);
        return null;
      }
    }

    let dependencies = null;
    if (this._match_text_seq("DEPENDS", "ON")) {
      dependencies = this._parse_csv(() => this._parse_table_parts(true));
      if (!dependencies) {
        this._retreat(index);
        return null;
      }
    }

    if (!cadence && !dependencies) {
      this._retreat(index);
      return null;
    }

    const settings = this._match_text_seq("SETTINGS") ? this._parse_settings_property() : null;

    return this.expression(new exp.AutoRefreshProperty({
      this: interval,
      cadence,
      offset,
      randomize,
      expressions: dependencies,
      settings,
      append: this._match_text_seq("APPEND"),
    }));
  }

  /** py:871-884 */
  _parse_index_constraint(kind = null) {
    // INDEX name1 expr TYPE type1(args) GRANULARITY value
    const this_ = this._parse_id_var();
    const expression = this._parse_assignment();

    const index_type = this._match_text_seq("TYPE") && (this._parse_function() || this._parse_var());

    const granularity = this._match_text_seq("GRANULARITY") && this._parse_term();

    return this.expression(new exp.IndexColumnConstraint({
      this: this_, expression, index_type, granularity,
    }));
  }

  /** py:886-899 */
  _parse_partition() {
    // https://clickhouse.com/docs/en/sql-reference/statements/alter/partition#how-to-set-partition-expression
    if (!this._match(TokenType.PARTITION)) return null;

    let expressions;
    if (this._match_text_seq("ID")) {
      // Corresponds to the PARTITION ID <string_value> syntax
      expressions = [this.expression(new exp.PartitionId({ this: this._parse_string() }))];
    } else {
      expressions = this._parse_expressions();
    }

    return this.expression(new exp.Partition({ expressions }));
  }

  /** py:901-909 */
  _parse_alter_table_replace() {
    const partition = this._parse_partition();

    if (!partition || !this._match(TokenType.FROM)) return null;

    return this.expression(new exp.ReplacePartition({
      expression: partition, source: this._parse_table_parts(),
    }));
  }

  /** py:911-923 */
  _parse_alter_table_alter() {
    // MODIFY forms other than MODIFY COLUMN (SQL SECURITY, ORDER BY, TTL, COMMENT, ...)
    // are parsed as properties, since ALTER can now reach this path too
    if (pyUpper(this._prev.text) === "MODIFY" && !this._match(TokenType.COLUMN, false)) {
      const properties = this._parse_properties();
      if (properties) {
        return this.expression(new exp.AlterModifySqlSecurity({ expressions: properties.expressions }));
      }
      return null;
    }

    // https://clickhouse.com/docs/sql-reference/statements/alter/column#modify-column
    const alter = super._parse_alter_table_alter();
    return this._curr ? null : alter;
  }

  /** py:925-929 */
  _parse_definer() {
    this._match(TokenType.EQ);
    if (this._match(TokenType.CURRENT_USER)) {
      return new exp.DefinerProperty({ this: new exp.Var({ this: pyUpper(this._prev.text) }) });
    }
    return new exp.DefinerProperty({ this: this._parse_string() });
  }

  /** py:931-939 */
  _parse_projection_def() {
    if (!this._match(TokenType.PROJECTION)) return null;

    return this.expression(new exp.ProjectionDef({
      this: this._parse_id_var(), expression: this._parse_wrapped(() => this._parse_statement()),
    }));
  }

  /** py:941-942 */
  _parse_constraint() {
    return super._parse_constraint() || this._parse_projection_def();
  }

  // In clickhouse "SELECT <expr> APPLY(...)" is a query modifier,
  // so "APPLY" shouldn't be parsed as <expr>'s alias. However, "SELECT <expr> apply" is a valid alias
  /** py:944-950 */
  _parse_alias(this_, explicit = false) {
    if (this._match_pair(TokenType.APPLY, TokenType.L_PAREN, false)) {
      return this_;
    }

    return super._parse_alias(this_, explicit);
  }

  /** py:952-960 */
  _parse_expression() {
    let this_ = super._parse_expression();

    // Clickhouse allows "SELECT <expr> [APPLY(func)] [...]]" modifier
    while (this._match_pair(TokenType.APPLY, TokenType.L_PAREN)) {
      this_ = new exp.Apply({ this: this_, expression: this._parse_var(true) });
      this._match(TokenType.R_PAREN);
    }

    return this_;
  }

  /** py:962-968 */
  _parse_columns() {
    let this_ = this.expression(new exp.Columns({ this: this._parse_lambda() }));

    while (this._next && this._match_text_seq(")", "APPLY", "(")) {
      this._match(TokenType.R_PAREN);
      this_ = new exp.Apply({ this: this_, expression: this._parse_var(true) });
    }
    return this_;
  }

  /** py:970-989 */
  _parse_value(values = true) {
    const value = super._parse_value(values);
    if (!value) return null;

    // In Clickhouse "SELECT * FROM VALUES (1, 2, 3)" generates a table with a single column, in contrast
    // to other dialects. For this case, we canonicalize the values into a tuple-of-tuples AST if it's not already one.
    // In INSERT INTO statements the same clause actually references multiple columns (opposite semantics),
    // but the final result is not altered by the extra parentheses.
    // Note: Clickhouse allows VALUES([structure], value, ...) so the branch checks for the last expression
    // A single-value tuple is generated as "(x)", which is parsed back into a Paren
    // rather than a Tuple, so it's unwrapped here to keep this rewrite idempotent
    const expressions = value.expressions;
    if (values && !(expressions.at(-1) instanceof exp.Tuple)) {
      value.set(
        "expressions",
        expressions.map((expr) => this.expression(new exp.Tuple({ expressions: [expr.unnest()] }))),
      );
    }

    return value;
  }

  /** py:991-994 */
  _parse_partitioned_by() {
    // ClickHouse allows custom expressions as partition key
    // https://clickhouse.com/docs/engines/table-engines/mergetree-family/custom-partitioning-key
    return this.expression(new exp.PartitionedByProperty({ this: this._parse_assignment() }));
  }

  /** py:996-1010 */
  _parse_detach() {
    const kind = this._match_set(this.constructor.DB_CREATABLES) && pyUpper(this._prev.text);
    const exists = this._parse_exists();
    const this_ = this._parse_table_parts();

    return this.expression(new exp.Detach({
      this: this_,
      kind,
      exists,
      cluster: this._match(TokenType.ON) ? this._parse_on_property() : null,
      permanent: this._match_text_seq("PERMANENTLY"),
      sync: this._match_text_seq("SYNC"),
    }));
  }
}
