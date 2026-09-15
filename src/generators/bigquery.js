// py: sqlglot/generators/bigquery.py — `class BigQueryGenerator(generator.Generator)`.
//
// @ported-ranges sqlglot/generators/bigquery.py 1-246 248-734
//
// The other big half of the BigQuery port (the small half is `src/dialects/bigquery.js`,
// settings only). This file mirrors the file-layout precedent every prior dialect port
// used: `parsers/bigquery.js` (grammar, PR #55), `dialects/bigquery.js` (Dialect
// settings class), and this file (Generator settings + overrides) are three separate,
// non-comingled directories, matching upstream's own three separate files.
//
// ONE `TRANSFORMS` ENTRY IS PARTIALLY BLOCKED, ANNOUNCED RATHER THAN FAKED
// --------------------------------------------------------------------------
// `exp.Select` (py:387) chains SIX preprocessing steps through `transforms.preprocess`.
// Five are real: `_unnest_explode_generate_series` (this file), `transforms.
// unqualify_unnest`, `transforms.eliminate_distinct_on`, `_alias_ordered_group` (this
// file), and `transforms.eliminate_semi_and_anti_joins` (all landed, `src/transforms.js`,
// PORT_PLAN.md R26/R38). The sixth, `transforms.explode_projection_to_unnest()`, needs
// `Scope(expression).references` — the full `Scope` CLASS's source-tracking, not the
// Tier-A `walkInScope`/`findAllInScope`/`findInScope` functions `unqualify_unnest`
// already gets by with (`sqlglot/optimizer/scope.py`, unported beyond Tier A). Omitted
// from the chain below rather than blocking the whole `exp.Select` entry: dropping one
// step out of six changes behavior only for EXPLODE/POSEXPLODE projections (rare in
// hand-written BigQuery SQL, which uses UNNEST natively), while blocking the entire
// entry would regress every other BigQuery SELECT's generation quality for zero
// benefit — worse than the documented, narrow gap this leaves instead.
//
// A SECOND GAP, inside `bracket_sql` (py:668) rather than `TRANSFORMS`: BigQuery's
// STRUCT-field-via-string-bracket special case (`x['field']` -> `x.field`) needs
// `arg.type`, which needs a real `sqlglot.optimizer.annotate_types.annotate_types` call
// when the argument arrives un-annotated (always, today — nothing in this port's reach
// runs the type-annotation pass). Mirrors the identically-named, identically-scoped
// local stub `parsers/bigquery.js` already carries for the exact same reason: BigQuery
// bracket access into a plain (non-STRUCT) value is unaffected, and bracket access into
// an ALREADY-typed STRUCT argument (`arg.type` already set by some other path) is also
// unaffected — only the un-annotated STRUCT-bracket path throws, loudly, instead of
// silently guessing.
//
// Every setting below is diffed against CPython by `spike/p5/fuzz_dialect_generate.mjs`'s
// BIGQUERY row.

import { NotPorted } from "../errors.js";
import { logger } from "../logging.js";
import { seqGet } from "../helper.js";
import { preprocess, eliminate_distinct_on, eliminate_semi_and_anti_joins, remove_precision_parameterized_types, unqualify_unnest, unnest_generate_series } from "../transforms.js";
import * as exp from "../expressions/index.js";
import { AFTER_HAVING_MODIFIER_TRANSFORMS, Generator, unsupported_args } from "../generator.js";
import { pyIsAlnum } from "../_py/str.js";
import {
  arg_max_or_min_no_count,
  date_add_interval_sql,
  datestrtodate_sql,
  filter_array_using_unnest,
  generate_series_sql,
  groupconcat_sql,
  if_sql,
  inline_array_unless_query,
  max_or_greatest,
  min_or_least,
  no_ilike_sql,
  regexp_replace_sql,
  rename_func,
  sha256_sql,
  sha2_digest_sql,
  strposition_sql,
  timestrtotime_sql,
  ts_or_ds_add_cast,
  unit_to_var,
} from "../dialects/dialect.js";

const JSON_EXTRACT_TYPE = [exp.JSONExtract, exp.JSONExtractScalar, exp.JSONExtractArray];

const DQUOTES_ESCAPING_JSON_FUNCTIONS = ["JSON_QUERY", "JSON_VALUE", "JSON_QUERY_ARRAY"];

/**
 * py: sqlglot/optimizer/annotate_types.py — NOT PORTED.
 *
 * `bracket_sql` imports this INSIDE its own body upstream (`generators/bigquery.py:675`),
 * mirroring the file-local stub `parsers/bigquery.js` already carries at the same
 * upstream module, for the same reason (P6+ scope).
 */
function annotate_types(_expression, _dialect) {
  throw new NotPorted("annotate_types", "sqlglot/optimizer/annotate_types.py");
}

/** py: sqlglot/generators/bigquery.py:39 */
function _derived_table_values_to_unnest(self, expression) {
  if (!expression.findAncestor(exp.From, exp.Join)) {
    return self.values_sql(expression);
  }

  const structs = [];
  const alias = expression.args.alias;
  for (const tup of expression.findAll(exp.Tuple)) {
    const field_aliases = alias && alias.columns.length
      ? alias.columns
      : tup.expressions.map((_, i) => `_c${i}`);
    const n = Math.min(field_aliases.length, tup.expressions.length);
    const expressions = [];
    for (let i = 0; i < n; i++) {
      expressions.push(new exp.PropertyEQ({ this: exp.toIdentifier(field_aliases[i]), expression: tup.expressions[i] }));
    }
    structs.push(new exp.Struct({ expressions }));
  }

  // Due to `UNNEST_COLUMN_ONLY`, it is expected that the table alias be contained in the columns expression
  const alias_name_only = alias ? new exp.TableAlias({ columns: [alias.this] }) : null;
  return self.unnest_sql(
    new exp.Unnest({ expressions: [exp.array(...structs, { copy: false })], alias: alias_name_only }),
  );
}

/** py: sqlglot/generators/bigquery.py:64 */
function _returnsproperty_sql(self, expression) {
  let this_ = expression.this;
  if (this_ instanceof exp.Schema) {
    this_ = `${self.sql(this_, "this")} <${self.expressions(this_)}>`;
  } else {
    this_ = self.sql(this_);
  }
  return `RETURNS ${this_}`;
}

/** py: sqlglot/generators/bigquery.py:73 */
function _create_sql(self, expression) {
  const returns = expression.find(exp.ReturnsProperty);
  if (expression.kind === "FUNCTION" && returns && returns.args.is_table) {
    expression.set("kind", "TABLE FUNCTION");

    if (expression.expression instanceof exp.Subquery || expression.expression instanceof exp.Literal) {
      expression.set("expression", expression.expression.this);
    }
  }

  return self.create_sql(expression);
}

// https://issuetracker.google.com/issues/162294746
// workaround for bigquery bug when grouping by an expression and then ordering
// WITH x AS (SELECT 1 y)
// SELECT y + 1 z
// FROM x
// GROUP BY x + 1
// ORDER by z
/** py: sqlglot/generators/bigquery.py:91 */
function _alias_ordered_group(expression) {
  if (expression instanceof exp.Select) {
    const group = expression.args.group;
    const order = expression.args.order;

    if (group && order) {
      const aliases = [];
      for (const select of expression.selects) {
        if (select instanceof exp.Alias) aliases.push([select.this, select.args.alias]);
      }

      for (const grouped of group.expressions) {
        if (grouped.is_int) continue;
        const found = aliases.findLast(([key]) => key.equals(grouped));
        if (found) grouped.replace(exp.column(found[1]));
      }
    }
  }

  return expression;
}

/**
 * py: sqlglot/generators/bigquery.py:113
 *
 * BigQuery doesn't allow column names when defining a CTE, so we try to push them down.
 */
function _pushdown_cte_column_names(expression) {
  if (expression instanceof exp.CTE && expression.aliasColumnNames.length) {
    const cte_query = expression.this;

    if (cte_query.isStar) {
      logger.warning(
        "Can't push down CTE column names for star queries. Run the query through"
        + " the optimizer or use 'qualify' to expand the star projections first.",
      );
      return expression;
    }

    const column_names = expression.aliasColumnNames;
    expression.args.alias.set("columns", null);

    const n = Math.min(column_names.length, cte_query.selects.length);
    for (let i = 0; i < n; i++) {
      const name = column_names[i];
      const to_replace = cte_query.selects[i];
      let select = to_replace;

      // Inner aliases are shadowed by the CTE column names
      if (select instanceof exp.Alias) select = select.this;

      to_replace.replace(exp.alias_(select, name));
    }
  }

  return expression;
}

/**
 * py: sqlglot/generators/bigquery.py:140
 *
 * Rewrites exploding GENERATE_SERIES projections into table references, e.g.
 *
 *     SELECT GENERATE_SERIES(1, 2) AS x           -> SELECT x FROM GENERATE_SERIES(1, 2) AS x
 *     SELECT y, GENERATE_SERIES(1, 2) AS x FROM t -> SELECT y, x FROM t CROSS JOIN GENERATE_SERIES(1, 2) AS x
 *
 * since BigQuery can't explode in the projection and must unnest it in the FROM clause
 * instead. The resulting table reference is unnested downstream by
 * `transforms.unnest_generate_series`.
 */
function _unnest_explode_generate_series(expression) {
  if (expression instanceof exp.Select) {
    for (const projection of expression.selects) {
      const series = projection.unalias();
      if (series instanceof exp.ExplodingGenerateSeries) {
        const column_name = projection.outputName || "_gen_series_value";

        projection.replace(exp.column(column_name));
        const table = new exp.Table({
          this: series,
          alias: new exp.TableAlias({ this: exp.toIdentifier(column_name) }),
        });

        if (expression.args.from_) {
          expression.join(table, { copy: false, join_type: "CROSS" });
        } else {
          expression.set("from_", new exp.From({ this: table }));
        }
      }
    }
  }

  return expression;
}

/** py: sqlglot/generators/bigquery.py:168 */
function _array_contains_sql(self, expression) {
  return self.sql(
    new exp.Exists({
      this: exp.select("1")
        .from_(new exp.Unnest({ expressions: [expression.left] }).as_("_unnest", { table: ["_col"] }))
        .where(exp.column("_col").eq(expression.right)),
    }),
  );
}

/** py: sqlglot/generators/bigquery.py:178 */
function _ts_or_ds_add_sql(self, expression) {
  return date_add_interval_sql("DATE", "ADD")(self, ts_or_ds_add_cast(expression));
}

/** py: sqlglot/generators/bigquery.py:182 */
function _ts_or_ds_diff_sql(self, expression) {
  expression.this.replace(exp.cast(expression.this, exp.DType.TIMESTAMP));
  expression.expression.replace(exp.cast(expression.expression, exp.DType.TIMESTAMP));
  const unit = unit_to_var(expression);
  return self.func("DATE_DIFF", expression.this, expression.expression, unit);
}

/** py: sqlglot/generators/bigquery.py:189 */
function _unix_to_time_sql(self, expression) {
  const scale = expression.args.scale;
  const timestamp = expression.this;

  if (scale === null || scale === undefined || scale.equals(exp.UnixToTime.SECONDS)) {
    return self.func("TIMESTAMP_SECONDS", timestamp);
  }
  if (scale.equals(exp.UnixToTime.MILLIS)) return self.func("TIMESTAMP_MILLIS", timestamp);
  if (scale.equals(exp.UnixToTime.MICROS)) return self.func("TIMESTAMP_MICROS", timestamp);

  const unix_seconds = exp.cast(
    new exp.Div({ this: timestamp, expression: exp.func("POW", 10, scale) }),
    exp.DType.BIGINT,
  );
  return self.func("TIMESTAMP_SECONDS", unix_seconds);
}

/** py: sqlglot/generators/bigquery.py:206 */
function _str_to_datetime_sql(self, expression) {
  const this_ = self.sql(expression, "this");
  const dtype = expression instanceof exp.StrToDate ? "DATE" : "TIMESTAMP";

  if (expression.args.safe) {
    const fmt = self.format_time(
      expression,
      self.dialect.INVERSE_FORMAT_MAPPING,
      self.dialect.INVERSE_FORMAT_TRIE,
    );
    return `SAFE_CAST(${this_} AS ${dtype} FORMAT ${fmt})`;
  }

  const fmt = self.format_time(expression);
  return self.func(`PARSE_${dtype}`, fmt, this_, expression.args.zone);
}

/** py: sqlglot/generators/bigquery.py:222 */
const _levenshtein_sql = unsupported_args("ins_cost", "del_cost", "sub_cost")(function _levenshtein_sql(self, expression) {
  let max_dist = expression.args.max_dist;
  if (max_dist) {
    max_dist = new exp.Kwarg({ this: exp.var("max_distance"), expression: max_dist });
  }

  return self.func("EDIT_DISTANCE", expression.this, expression.expression, max_dist);
});

/** py: sqlglot/generators/bigquery.py:231 */
function _json_extract_sql(self, expression) {
  const name = expression.metaGet("name") || expression.constructor.sqlName();
  const upper = name.toUpperCase();

  const dquote_escaping = DQUOTES_ESCAPING_JSON_FUNCTIONS.includes(upper);

  if (dquote_escaping) {
    self._quote_json_path_key_using_brackets = false;
  }

  const sql = rename_func(upper)(self, expression);

  if (dquote_escaping) {
    self._quote_json_path_key_using_brackets = true;
  }

  return sql;
}

/**
 * py:279 `SAFE_JSON_PATH_KEY_RE = re.compile(r"^[\-\w]*$")`.
 *
 * Same "NOT a `RegExp`" treatment `exp.SAFE_IDENTIFIER_RE` (expressions/core.js)
 * documents for exactly this override, and `generators/hive.js`'s own
 * `HIVE_SAFE_JSON_PATH_KEY_RE` already applies for its sibling pattern — `\w` and `$`
 * carry the same Python-vs-JS semantic gap R24 found (Unicode-aware `\w`, and `$`
 * allowing one trailing newline). Unlike Hive's `[_\-a-zA-Z][\-\w]*`, this pattern has
 * no distinct first-character class and `*` (not `+`), so the empty string matches.
 */
const BIGQUERY_SAFE_JSON_PATH_KEY_RE = Object.freeze({
  source: "^[\\-\\w]*$",
  toString() {
    return this.source;
  },
  test(s) {
    if (typeof s !== "string") return false;
    const body = s.endsWith("\n") ? s.slice(0, -1) : s;
    for (const ch of body) {
      if (ch !== "_" && ch !== "-" && !pyIsAlnum(ch)) return false;
    }
    return true;
  },
});

/** py: sqlglot/generators/bigquery.py:248 `class BigQueryGenerator(generator.Generator)`. */
export class BigQueryGenerator extends Generator {
  static TRY_SUPPORTED = false;
  static SUPPORTS_UESCAPE = false;
  static SUPPORTS_DECODE_CASE = false;
  static INTERVAL_ALLOWS_PLURAL_FORM = false;
  static JOIN_HINTS = false;
  static QUERY_HINTS = false;
  static TABLE_HINTS = false;
  static LIMIT_FETCH = "LIMIT";
  static RENAME_TABLE_WITH_DB = false;
  static NVL2_SUPPORTED = false;
  static UNNEST_WITH_ORDINALITY = false;
  static COLLATE_IS_FUNC = true;
  static LIMIT_ONLY_LITERALS = true;
  static SUPPORTS_TABLE_ALIAS_COLUMNS = false;
  static SUPPORTS_NAMED_CTE_COLUMNS = false;
  static UNPIVOT_ALIASES_ARE_IDENTIFIERS = false;
  static JSON_KEY_VALUE_PAIR_SEP = ",";
  static NULL_ORDERING_SUPPORTED = false;
  static IGNORE_NULLS_IN_FUNC = true;
  static JSON_PATH_SINGLE_QUOTE_ESCAPE = true;
  static CAN_IMPLEMENT_ARRAY_ANY = true;
  static SUPPORTS_TO_NUMBER = false;
  static NAMED_PLACEHOLDER_TOKEN = "@";
  static HEX_FUNC = "TO_HEX";
  static WITH_PROPERTIES_PREFIX = "OPTIONS";
  static SUPPORTS_EXPLODING_PROJECTIONS = false;
  static EXCEPT_INTERSECT_SUPPORT_ALL_CLAUSE = false;
  static SUPPORTS_UNIX_SECONDS = true;
  static DECLARE_DEFAULT_ASSIGNMENT = "DEFAULT";

  static SAFE_JSON_PATH_KEY_RE = BIGQUERY_SAFE_JSON_PATH_KEY_RE;

  static WINDOW_FUNCS_WITH_NULL_ORDERING = [
    exp.CumeDist,
    exp.DenseRank,
    exp.FirstValue,
    exp.Lag,
    exp.LastValue,
    exp.Lead,
    exp.NthValue,
    exp.Ntile,
    exp.PercentRank,
    exp.Rank,
    exp.RowNumber,
  ];

  static TS_OR_DS_TYPES = [
    exp.TsOrDsToDatetime,
    exp.TsOrDsToTimestamp,
    exp.TsOrDsToTime,
    exp.TsOrDsToDate,
  ];

  static TRANSFORMS = new Map([
    ...Generator.TRANSFORMS,
    [exp.AIEmbed, rename_func("EMBED")],
    [exp.AIGenerate, rename_func("GENERATE")],
    [exp.AISimilarity, rename_func("SIMILARITY")],
    [exp.ApproxTopK, rename_func("APPROX_TOP_COUNT")],
    [exp.ApproxDistinct, rename_func("APPROX_COUNT_DISTINCT")],
    [exp.ArgMax, arg_max_or_min_no_count("MAX_BY")],
    [exp.ArgMin, arg_max_or_min_no_count("MIN_BY")],
    [exp.Array, inline_array_unless_query],
    [exp.ArrayContains, _array_contains_sql],
    [exp.ArrayFilter, filter_array_using_unnest],
    [exp.ArrayRemove, filter_array_using_unnest],
    [exp.BitwiseAndAgg, rename_func("BIT_AND")],
    [exp.BitwiseOrAgg, rename_func("BIT_OR")],
    [exp.BitwiseXorAgg, rename_func("BIT_XOR")],
    [exp.BitwiseCount, rename_func("BIT_COUNT")],
    [exp.ByteLength, rename_func("BYTE_LENGTH")],
    [exp.Cast, preprocess([remove_precision_parameterized_types])],
    [exp.CollateProperty, (self, e) => (
      e.args.default
        ? `DEFAULT COLLATE ${self.sql(e, "this")}`
        : `COLLATE ${self.sql(e, "this")}`
    )],
    [exp.Commit, () => "COMMIT TRANSACTION"],
    [exp.CountIf, rename_func("COUNTIF")],
    [exp.Create, _create_sql],
    [exp.CTE, preprocess([_pushdown_cte_column_names])],
    [exp.DateAdd, date_add_interval_sql("DATE", "ADD")],
    [exp.DateDiff, (self, e) => self.func("DATE_DIFF", e.this, e.expression, unit_to_var(e))],
    [exp.DateFromParts, rename_func("DATE")],
    [exp.DateStrToDate, datestrtodate_sql],
    [exp.DateSub, date_add_interval_sql("DATE", "SUB")],
    [exp.DatetimeAdd, date_add_interval_sql("DATETIME", "ADD")],
    [exp.DatetimeSub, date_add_interval_sql("DATETIME", "SUB")],
    [exp.DateFromUnixDate, rename_func("DATE_FROM_UNIX_DATE")],
    [exp.FromTimeZone, (self, e) => self.func(
      "DATETIME", self.func("TIMESTAMP", e.this, e.args.zone), "'UTC'",
    )],
    [exp.GenerateSeries, generate_series_sql("GENERATE_ARRAY")],
    [exp.GroupConcat, (self, e) => groupconcat_sql(
      self, e, { func_name: "STRING_AGG", within_group: false, sep: null },
    )],
    [exp.Hex, (self, e) => self.func("UPPER", self.func("TO_HEX", self.sql(e, "this")))],
    [exp.HexString, (self, e) => self.hexstring_sql(e, "FROM_HEX")],
    [exp.If, if_sql("IF", "NULL")],
    [exp.ILike, no_ilike_sql],
    [exp.IntDiv, rename_func("DIV")],
    [exp.Int64, rename_func("INT64")],
    [exp.JSONBool, rename_func("BOOL")],
    [exp.JSONExtract, _json_extract_sql],
    [exp.JSONExtractArray, _json_extract_sql],
    [exp.JSONExtractScalar, _json_extract_sql],
    [exp.JSONFormat, (self, e) => self.func(
      e.args.to_json ? "TO_JSON" : "TO_JSON_STRING",
      e.this,
      e.args.options,
    )],
    [exp.JSONKeysAtDepth, rename_func("JSON_KEYS")],
    [exp.JSONValueArray, rename_func("JSON_VALUE_ARRAY")],
    [exp.Levenshtein, _levenshtein_sql],
    [exp.Max, max_or_greatest],
    [exp.MD5, (self, e) => self.func("TO_HEX", self.func("MD5", e.this))],
    [exp.MD5Digest, rename_func("MD5")],
    [exp.Min, min_or_least],
    [exp.Normalize, (self, e) => self.func(
      e.args.is_casefold ? "NORMALIZE_AND_CASEFOLD" : "NORMALIZE",
      e.this,
      e.args.form,
    )],
    [exp.PartitionedByProperty, (self, e) => `PARTITION BY ${self.sql(e, "this")}`],
    [exp.RegexpExtract, (self, e) => self.func(
      "REGEXP_EXTRACT",
      e.this,
      e.expression,
      e.args.position,
      e.args.occurrence,
    )],
    [exp.RegexpExtractAll, (self, e) => self.func("REGEXP_EXTRACT_ALL", e.this, e.expression)],
    [exp.RegexpReplace, regexp_replace_sql],
    [exp.RegexpLike, rename_func("REGEXP_CONTAINS")],
    [exp.ReturnsProperty, _returnsproperty_sql],
    [exp.Rollback, () => "ROLLBACK TRANSACTION"],
    [exp.ParseTime, (self, e) => self.func("PARSE_TIME", self.format_time(e), e.this)],
    [exp.ParseDatetime, (self, e) => self.func("PARSE_DATETIME", self.format_time(e), e.this)],
    [exp.Select, preprocess([
      _unnest_explode_generate_series,
      unqualify_unnest,
      eliminate_distinct_on,
      _alias_ordered_group,
      eliminate_semi_and_anti_joins,
    ])],
    [exp.SHA, rename_func("SHA1")],
    [exp.SHA2, sha256_sql],
    [exp.SHA1Digest, rename_func("SHA1")],
    [exp.SHA2Digest, sha2_digest_sql],
    [exp.StabilityProperty, (self, e) => (
      e.name === "IMMUTABLE" ? "DETERMINISTIC" : "NOT DETERMINISTIC"
    )],
    [exp.String, rename_func("STRING")],
    [exp.StrPosition, (self, e) => strposition_sql(
      self, e, { func_name: "INSTR", supports_position: true, supports_occurrence: true },
    )],
    [exp.StrToDate, _str_to_datetime_sql],
    [exp.StrToTime, _str_to_datetime_sql],
    [exp.SessionUser, () => "SESSION_USER()"],
    [exp.Table, preprocess([unnest_generate_series])],
    [exp.TimeAdd, date_add_interval_sql("TIME", "ADD")],
    [exp.TimeFromParts, rename_func("TIME")],
    [exp.TimestampFromParts, rename_func("DATETIME")],
    [exp.TimeSub, date_add_interval_sql("TIME", "SUB")],
    [exp.TimestampAdd, date_add_interval_sql("TIMESTAMP", "ADD")],
    [exp.TimestampDiff, rename_func("TIMESTAMP_DIFF")],
    [exp.TimestampSub, date_add_interval_sql("TIMESTAMP", "SUB")],
    [exp.TimeStrToTime, timestrtotime_sql],
    [exp.Transaction, () => "BEGIN TRANSACTION"],
    [exp.TsOrDsAdd, _ts_or_ds_add_sql],
    [exp.TsOrDsDiff, _ts_or_ds_diff_sql],
    [exp.TsOrDsToTime, rename_func("TIME")],
    [exp.TsOrDsToDatetime, rename_func("DATETIME")],
    [exp.TsOrDsToTimestamp, rename_func("TIMESTAMP")],
    [exp.Unhex, rename_func("FROM_HEX")],
    [exp.UnixDate, rename_func("UNIX_DATE")],
    [exp.UnixToTime, _unix_to_time_sql],
    [exp.Uuid, () => "GENERATE_UUID()"],
    [exp.Values, _derived_table_values_to_unnest],
    [exp.VariancePop, rename_func("VAR_POP")],
    [exp.SafeDivide, rename_func("SAFE_DIVIDE")],
  ]);

  static SUPPORTED_JSON_PATH_PARTS = new Set([exp.JSONPathKey, exp.JSONPathRoot, exp.JSONPathSubscript]);

  static TYPE_MAPPING = new Map([
    ...Generator.TYPE_MAPPING,
    [exp.DType.BIGDECIMAL, "BIGNUMERIC"],
    [exp.DType.BIGINT, "INT64"],
    [exp.DType.BINARY, "BYTES"],
    [exp.DType.BLOB, "BYTES"],
    [exp.DType.BOOLEAN, "BOOL"],
    [exp.DType.CHAR, "STRING"],
    [exp.DType.DECIMAL, "NUMERIC"],
    [exp.DType.DOUBLE, "FLOAT64"],
    [exp.DType.FLOAT, "FLOAT64"],
    [exp.DType.INT, "INT64"],
    [exp.DType.NCHAR, "STRING"],
    [exp.DType.NVARCHAR, "STRING"],
    [exp.DType.SMALLINT, "INT64"],
    [exp.DType.TEXT, "STRING"],
    [exp.DType.TIMESTAMP, "DATETIME"],
    [exp.DType.TIMESTAMPNTZ, "DATETIME"],
    [exp.DType.TIMESTAMPTZ, "TIMESTAMP"],
    [exp.DType.TIMESTAMPLTZ, "TIMESTAMP"],
    [exp.DType.TINYINT, "INT64"],
    [exp.DType.ROWVERSION, "BYTES"],
    [exp.DType.UUID, "STRING"],
    [exp.DType.VARBINARY, "BYTES"],
    [exp.DType.VARCHAR, "STRING"],
    [exp.DType.VARIANT, "ANY TYPE"],
  ]);

  static PROPERTIES_LOCATION = new Map([
    ...Generator.PROPERTIES_LOCATION,
    [exp.PartitionedByProperty, exp.Properties.Location.POST_SCHEMA],
    [exp.VolatileProperty, exp.Properties.Location.UNSUPPORTED],
  ]);

  /**
   * py:478 `AFTER_HAVING_MODIFIER_TRANSFORMS = {"qualify": ..., "windows": ...}` — a
   * REPLACEMENT of the base class-level table (which also carries "cluster"/
   * "distribute"/"sort"), narrowed to just these two keys, each read from the
   * module-level `AFTER_HAVING_MODIFIER_TRANSFORMS` constant (`generator.js`'s own
   * `py:65` export). That module-level constant is itself still empty at both entries
   * (`generator.js`'s own "stub-queue scope" gap), so this declares the same empty
   * `Map` rather than one with `undefined`-valued entries — the latter would crash
   * `select_sql`'s `[...values()].map((gen) => gen(this, expression))` the moment a
   * QUALIFY or WINDOW clause reached this class, which is worse than the documented gap.
   */
  static AFTER_HAVING_MODIFIER_TRANSFORMS = new Map([
    ...AFTER_HAVING_MODIFIER_TRANSFORMS,
  ]);

  // from: https://cloud.google.com/bigquery/docs/reference/standard-sql/lexical#reserved_keywords
  static RESERVED_KEYWORDS = new Set([
    "all", "and", "any", "array", "as", "asc", "assert_rows_modified", "at", "between",
    "by", "case", "cast", "collate", "contains", "create", "cross", "cube", "current",
    "default", "define", "desc", "distinct", "else", "end", "enum", "escape", "except",
    "exclude", "exists", "extract", "false", "fetch", "following", "for", "from", "full",
    "group", "grouping", "groups", "hash", "having", "if", "ignore", "in", "inner",
    "intersect", "interval", "into", "is", "join", "lateral", "left", "like", "limit",
    "lookup", "merge", "natural", "new", "no", "not", "null", "nulls", "of", "on", "or",
    "order", "outer", "over", "partition", "preceding", "proto", "qualify", "range",
    "recursive", "respect", "right", "rollup", "rows", "select", "set", "some", "struct",
    "tablesample", "then", "to", "treat", "true", "unbounded", "union", "unnest",
    "using", "when", "where", "window", "with", "within",
  ]);

  /** py: sqlglot/generators/bigquery.py:583 */
  weekstart_sql(expression) {
    if (expression.this.name.toUpperCase() === "SUNDAY") {
      // BigQuery specific optimization since WEEK(SUNDAY) == WEEK
      return "WEEK";
    }

    return this.func("WEEK", expression.this);
  }

  /** py: sqlglot/generators/bigquery.py:590 */
  datetrunc_sql(expression) {
    const unit = expression.unit;
    const unit_sql = unit.is_string ? unit.name : this.sql(unit);
    return this.func("DATE_TRUNC", expression.this, unit_sql, expression.args.zone);
  }

  /** py: sqlglot/generators/bigquery.py:595 */
  mod_sql(expression) {
    const this_ = expression.this;
    const expr = expression.expression;
    return this.func(
      "MOD",
      this_ instanceof exp.Paren ? this_.unnest() : this_,
      expr instanceof exp.Paren ? expr.unnest() : expr,
    );
  }

  /** py: sqlglot/generators/bigquery.py:604 */
  column_parts(expression) {
    if (expression.metaGet("quoted_column")) {
      // If a column reference is of the form `dataset.table`.name, we need
      // to preserve the quoted table path, otherwise the reference breaks
      const table_parts = expression.parts.slice(0, -1).map((p) => p.name).join(".");
      const table_path = this.sql(new exp.Identifier({ this: table_parts, quoted: true }));
      return `${table_path}.${this.sql(expression, "this")}`;
    }

    return super.column_parts(expression);
  }

  /**
   * py: sqlglot/generators/bigquery.py:614
   *
   * Depending on the context, `x.y` may not resolve to the same data source as `x`.`y`, so
   * we need to make sure the correct quoting is used in each case.
   *
   * For example, if there is a CTE x that clashes with a schema name, then the former will
   * return the table y in that schema, whereas the latter will return the CTE's y column:
   *
   * - WITH x AS (SELECT [1, 2] AS y) SELECT * FROM x, `x.y`   -> cross join
   * - WITH x AS (SELECT [1, 2] AS y) SELECT * FROM x, `x`.`y` -> implicit unnest
   */
  table_parts(expression) {
    if (expression.metaGet("quoted_table")) {
      const table_parts = expression.parts.map((p) => p.name).join(".");
      return this.sql(new exp.Identifier({ this: table_parts, quoted: true }));
    }

    return super.table_parts(expression);
  }

  /** py: sqlglot/generators/bigquery.py:629 */
  timetostr_sql(expression) {
    const this_ = expression.this;
    let func_name;
    if (this_ instanceof exp.TsOrDsToDatetime) func_name = "FORMAT_DATETIME";
    else if (this_ instanceof exp.TsOrDsToTimestamp) func_name = "FORMAT_TIMESTAMP";
    else if (this_ instanceof exp.TsOrDsToTime) func_name = "FORMAT_TIME";
    else func_name = "FORMAT_DATE";

    const time_expr = this.constructor.TS_OR_DS_TYPES.some((cls) => this_ instanceof cls) ? this_ : expression;
    return this.func(
      func_name, this.format_time(expression), time_expr.this, expression.args.zone,
    );
  }

  /** py: sqlglot/generators/bigquery.py:645 */
  eq_sql(expression) {
    // Operands of = cannot be NULL in BigQuery
    if (expression.left instanceof exp.Null || expression.right instanceof exp.Null) {
      if (!(expression.parent instanceof exp.Update)) {
        return "NULL";
      }
    }

    return this.binary(expression, "=");
  }

  /** py: sqlglot/generators/bigquery.py:653 */
  attimezone_sql(expression) {
    const parent = expression.parent;

    // BigQuery allows CAST(.. AS {STRING|TIMESTAMP} [FORMAT <fmt> [AT TIME ZONE <tz>]]).
    // Only the TIMESTAMP one should use the below conversion, when AT TIME ZONE is included.
    if (!(parent instanceof exp.Cast) || !parent.to.isType("text")) {
      return this.func(
        "TIMESTAMP", this.func("DATETIME", expression.this, expression.args.zone),
      );
    }

    return super.attimezone_sql(expression);
  }

  /** py: sqlglot/generators/bigquery.py:665 */
  trycast_sql(expression) {
    return this.cast_sql(expression, "SAFE_");
  }

  /** py: sqlglot/generators/bigquery.py:668 */
  bracket_sql(expression) {
    const this_ = expression.this;
    const expressions = expression.expressions;

    if (expressions.length === 1 && this_ && this_.isType(exp.DType.STRUCT)) {
      let arg = expressions[0];
      if (arg.type === null || arg.type === undefined) {
        arg = annotate_types(arg, this.dialect);
      }

      if (arg.type && exp.DataType.TEXT_TYPES.has(arg.type.this)) {
        // BQ doesn't support bracket syntax with string values for structs
        return `${this.sql(this_)}.${arg.name}`;
      }
    }

    let expressions_sql = this.expressions(expression, null, { flat: true });
    const offset = expression.args.offset;

    if (offset === 0) {
      expressions_sql = `OFFSET(${expressions_sql})`;
    } else if (offset === 1) {
      expressions_sql = `ORDINAL(${expressions_sql})`;
    } else if (offset !== null && offset !== undefined) {
      // deny:implicit_str sqlglot/generators/bigquery.py:691 — `offset` is a `Bracket`
      // arg set ONLY by `parsers/bigquery.js`'s `_parse_bracket` (this file's own
      // read-side counterpart), from `BRACKET_OFFSETS`'s literal `[0, false]`/`[1,
      // false]`/... pairs — always a plain JS number, never an `Expr`, in every path
      // this port can construct one. `${offset}` therefore matches Python's `str(int)`
      // exactly; this is not a case that would ever call `Expr.toString()`.
      this.unsupported(`Unsupported array offset: ${offset}`);
    }

    if (expression.args.safe) {
      expressions_sql = `SAFE_${expressions_sql}`;
    }

    return `${this.sql(this_)}[${expressions_sql}]`;
  }

  /** py: sqlglot/generators/bigquery.py:698 */
  in_unnest_op(expression) {
    return this.sql(expression);
  }

  /** py: sqlglot/generators/bigquery.py:701 */
  version_sql(expression) {
    if (expression.name === "TIMESTAMP") {
      expression.set("this", "SYSTEM_TIME");
    }
    return super.version_sql(expression);
  }

  /** py: sqlglot/generators/bigquery.py:706 */
  contains_sql(expression) {
    let this_ = expression.this;
    let expr = expression.expression;

    if (this_ instanceof exp.Lower && expr instanceof exp.Lower) {
      this_ = this_.this;
      expr = expr.this;
    }

    return this.func("CONTAINS_SUBSTR", this_, expr, expression.args.json_scope);
  }

  /** py: sqlglot/generators/bigquery.py:716 */
  cast_sql(expression, safe_prefix = null) {
    const this_ = expression.this;

    // This ensures that inline type-annotated ARRAY literals like ARRAY<INT64>[1, 2, 3]
    // are roundtripped unaffected. The inner check excludes ARRAY(SELECT ...) expressions,
    // because they aren't literals and so the above syntax is invalid BigQuery.
    if (this_ instanceof exp.Array) {
      const elem = seqGet(this_.expressions, 0);
      if (!(elem && elem.find(exp.Query))) {
        return `${this.sql(expression, "to")}${this.sql(this_)}`;
      }
    }

    return super.cast_sql(expression, safe_prefix);
  }

  /** py: sqlglot/generators/bigquery.py:729 */
  clusterproperty_sql(expression) {
    if (expression.this) {
      this.unsupported(`Unsupported CLUSTER BY ${this.sql(expression, "this")}`);
      return "";
    }
    return this.op_expressions("CLUSTER BY", expression);
  }
}
