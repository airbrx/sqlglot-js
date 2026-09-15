// py: sqlglot/dialects/bigquery.py — `class BigQuery(Dialect)`.
//
// SETTINGS ONLY, same split every prior dialect used: the grammar lives in
// `sqlglot/parsers/bigquery.py` (already ported, `src/parsers/bigquery.js`, PR #55),
// and generation lives in `sqlglot/generators/bigquery.py` (ported alongside this file
// in the same round, `src/generators/bigquery.js`). This file is `class BigQuery
// extends Dialect` with ~25 overridden settings, the nested `Tokenizer` subclass, the
// `normalize_identifier` override, and the `registerDialect` call that makes
// `Dialect.get_or_raise("bigquery")` resolve.
//
// WHY THE `registerDialect` CALL AT THE BOTTOM IS THE WHOLE POINT
// ---------------------------------------------------------------
// `src/parsers/bigquery.js` reads settings off `this.dialect` — the resolved Dialect
// INSTANCE. JS `static` fields live on the CONSTRUCTOR and are not on the prototype, so
// `instance.WEEK_OFFSET` is `undefined` unless something mirrors them (PORT_PLAN.md
// R20). `registerDialect` does that mirroring, as its last step, after every derivation
// is final.
//
// TWO GAPS, EACH ANNOUNCED RATHER THAN FAKED — the same shape `snowflake.js` already
// documents for its own two:
//
//   `EXPRESSION_METADATA` (py:132 `= EXPRESSION_METADATA.copy()`, from the unported
//   `sqlglot/typing/bigquery.py`, a type-inference table) and `COERCES_TO` (py:118,
//   `{**TypeAnnotator.COERCES_TO, ...}` — `TypeAnnotator` is `sqlglot/optimizer/
//   annotate_types.py`, also unported) both stay empty `Map`s, exactly matching base
//   `Dialect`'s own current (unported-optimizer) default for each. Declared explicitly
//   below rather than omitted, so the attribute EXISTS with the right shape and a gap
//   that states its own size (PORT_PLAN.md R19) rather than one nobody remembers.
//
//   `class JSONPathTokenizer(jsonpath.JSONPathTokenizer)` (py:163) is NOT declared, for
//   the same reason `Dialect.jsonpath_tokenizer_class` is null: `sqlglot/jsonpath.py` is
//   unported. Omitting it leaves `jsonpath_tokenizer_class` null (registerDialect's own
//   fallback) and `jsonpath_tokenizer()` throwing, rather than handing `to_json_path` a
//   scanner that lexes JSON paths as SQL.
//
// Every setting below is diffed value-by-value against CPython by
// `spike/p5/fuzz_dialect_parse.mjs`'s BIGQUERY row.

import { Tokenizer, TokenType, initTokenizerSubclass } from "../tokens.js";
import { BigQueryParser } from "../parsers/bigquery.js";
import { BigQueryGenerator } from "../generators/bigquery.js";
import * as exp from "../expressions/index.js";
import {
  _asciiTranslate,
  Dialect,
  Dialects,
  NormalizationStrategy,
  registerDialect,
} from "./dialect.js";

/**
 * py: sqlglot/dialects/bigquery.py:170 `class Tokenizer(tokens.Tokenizer)`.
 *
 * Declared at module level rather than inside the class body because JS has no nested
 * class declarations; `BigQuery.Tokenizer` below points at it, which is the name
 * `registerDialect` (py:291 `klass.__dict__.get("Tokenizer", ...)`) looks for.
 *
 * `initTokenizerSubclass` is called explicitly right after the body, exactly as
 * `snowflake.js`/`postgres.js`/`duckdb.js` do for their own Tokenizer subclasses:
 * Python runs `__init_subclass__` at class-creation time and JS has no equivalent hook.
 */
class BigQueryTokenizer extends Tokenizer {
  static QUOTES = ["'", '"', '"""', "'''"];
  static COMMENTS = ["--", "#", ["/*", "*/"]];
  static IDENTIFIERS = ["`"];
  static STRING_ESCAPES = ["\\"];

  static HEX_STRINGS = [
    ["0x", ""],
    ["0X", ""],
  ];

  // py:178 `[(prefix + q, q) for q in QUOTES for prefix in ("b", "B")]` — QUOTES is the
  // array declared just above, not the base `Tokenizer.QUOTES`.
  static BYTE_STRINGS = BigQueryTokenizer.QUOTES.flatMap((q) => ["b", "B"].map((prefix) => [prefix + q, q]));

  static RAW_STRINGS = BigQueryTokenizer.QUOTES.flatMap((q) => ["r", "R"].map((prefix) => [prefix + q, q]));

  static NESTED_COMMENTS = false;

  static KEYWORDS = new Map([
    ...Tokenizer.KEYWORDS,
    ["ANY TYPE", TokenType.VARIANT],
    ["BEGIN", TokenType.COMMAND],
    ["BEGIN TRANSACTION", TokenType.BEGIN],
    ["BYTEINT", TokenType.INT],
    ["BYTES", TokenType.BINARY],
    ["CURRENT_DATETIME", TokenType.CURRENT_DATETIME],
    ["DATETIME", TokenType.TIMESTAMP],
    ["DECLARE", TokenType.DECLARE],
    ["ELSEIF", TokenType.COMMAND],
    ["EXCEPTION", TokenType.COMMAND],
    ["EXPORT", TokenType.EXPORT],
    ["FLOAT64", TokenType.DOUBLE],
    ["LOOP", TokenType.COMMAND],
    ["MODEL", TokenType.MODEL],
    ["RECORD", TokenType.STRUCT],
    ["REPEAT", TokenType.COMMAND],
    ["TIMESTAMP", TokenType.TIMESTAMPTZ],
    ["WHILE", TokenType.COMMAND],
  ]);
}
// py:205-207 `KEYWORDS.pop("DIV")` / `KEYWORDS.pop("VALUES")` / `KEYWORDS.pop("/*+")` —
// mutations of the dict AFTER the merge, not entries omitted from it. Same
// `initTokenizerSubclass` interaction with `HINT_START` that `snowflake.js` documents
// for its own `.delete("/*+")`: removing it here is what stops `/*+ ... */` being
// scanned as a hint comment in BigQuery.
BigQueryTokenizer.KEYWORDS.delete("DIV");
BigQueryTokenizer.KEYWORDS.delete("VALUES");
BigQueryTokenizer.KEYWORDS.delete("/*+");
initTokenizerSubclass(BigQueryTokenizer);

/** py: sqlglot/dialects/bigquery.py:24 `class BigQuery(Dialect)`. */
export class BigQuery extends Dialect {
  static WEEK_OFFSET = -1;
  static UNNEST_COLUMN_ONLY = true;
  static SUPPORTS_USER_DEFINED_TYPES = false;
  static LOG_BASE_FIRST = false;
  static HEX_LOWERCASE = true;
  static FORCE_EARLY_ALIAS_REF_EXPANSION = true;
  static EXPAND_ONLY_GROUP_ALIAS_REF = true;
  static PRESERVE_ORIGINAL_NAMES = true;
  static HEX_STRING_IS_INTEGER_TYPE = true;
  static BYTE_STRING_IS_BYTES_TYPE = true;
  static UUID_IS_STRING_TYPE = true;
  static ANNOTATE_ALL_SCOPES = true;
  static PROJECTION_ALIASES_SHADOW_SOURCE_NAMES = true;
  static TABLES_REFERENCEABLE_AS_COLUMNS = true;
  static SUPPORTS_STRUCT_STAR_EXPANSION = true;
  static EXCLUDES_PSEUDOCOLUMNS_FROM_STAR = true;
  static QUERY_RESULTS_ARE_STRUCTS = true;
  static JSON_EXTRACT_SCALAR_SCALAR_ONLY = true;
  static JSON_PATH_SINGLE_DOT_IS_WILDCARD = true;
  static LEAST_GREATEST_IGNORES_NULLS = false;
  static DEFAULT_NULL_TYPE = exp.DType.BIGINT;
  static PRIORITIZE_NON_LITERAL_TYPES = true;
  static ALIAS_POST_VERSION = false;

  // https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/string_functions#initcap
  static INITCAP_DEFAULT_DELIMITER_CHARS = ' \t\n\r\f\v\\[\\](){}/|<>!?@"^#$&~_,.:;*%+\\-';

  // https://cloud.google.com/bigquery/docs/reference/standard-sql/lexical#case_sensitivity
  static NORMALIZATION_STRATEGY = NormalizationStrategy.CASE_INSENSITIVE;
  static ASCII_ONLY_NORMALIZATION = true;

  // bigquery udfs are case sensitive
  static NORMALIZE_FUNCTIONS = false;

  // https://cloud.google.com/bigquery/docs/reference/standard-sql/format-elements#format_elements_date_time
  static TIME_MAPPING = new Map([
    ["%x", "%m/%d/%y"],
    ["%D", "%m/%d/%y"],
    ["%E6S", "%S.%f"],
    ["%e", "%-d"],
    ["%F", "%Y-%m-%d"],
    ["%T", "%H:%M:%S"],
    ["%c", "%a %b %e %H:%M:%S %Y"],
  ]);

  static INVERSE_TIME_MAPPING = new Map([
    // Preserve %E6S instead of expanding to %T.%f - since both %E6S & %T.%f are semantically different in BigQuery
    // %E6S is semantically different from %T.%f: %E6S works as a single atomic specifier for seconds with microseconds, while %T.%f expands incorrectly and fails to parse.
    ["%H:%M:%S.%f", "%H:%M:%E6S"],
  ]);

  static FORMAT_MAPPING = new Map([
    ["dd", "%d"],
    ["DD", "%d"],
    ["mm", "%m"],
    ["MM", "%m"],
    ["mon", "%b"],
    ["MON", "%b"],
    ["month", "%B"],
    ["MONTH", "%B"],
    ["yyyy", "%Y"],
    ["YYYY", "%Y"],
    ["yy", "%y"],
    ["YY", "%y"],
    ["HH", "%I"],
    ["HH12", "%I"],
    ["hh24", "%H"],
    ["HH24", "%H"],
    ["mi", "%M"],
    ["MI", "%M"],
    ["ss", "%S"],
    ["SS", "%S"],
    ["SSSSS", "%f"],
    ["tzh", "%z"],
    ["TZH", "%z"],
  ]);

  // The _PARTITIONTIME and _PARTITIONDATE pseudo-columns are not returned by a SELECT * statement
  // https://cloud.google.com/bigquery/docs/querying-partitioned-tables#query_an_ingestion-time_partitioned_table
  // https://cloud.google.com/bigquery/docs/querying-wildcard-tables#scanning_a_range_of_tables_using_table_suffix
  // https://cloud.google.com/bigquery/docs/query-cloud-storage-data#query_the_file_name_pseudo-column
  static PSEUDOCOLUMNS = new Set(["_PARTITIONTIME", "_PARTITIONDATE", "_TABLE_SUFFIX", "_FILE_NAME", "_DBT_MAX_PARTITION"]);

  // All set operations require either a DISTINCT or ALL specifier
  static SET_OP_DISTINCT_BY_DEFAULT = new Map([
    [exp.Except, null],
    [exp.Intersect, null],
    [exp.Union, null],
  ]);

  /**
   * py:118 `COERCES_TO = {**TypeAnnotator.COERCES_TO, ...}`, from the unported
   * `sqlglot/optimizer/annotate_types.py` — see the file header. Base `Dialect`'s own
   * `COERCES_TO` is likewise an empty `Map` today, so this matches it exactly rather
   * than diverging into a differently-shaped gap.
   */
  static COERCES_TO = new Map();

  /**
   * py:132 `EXPRESSION_METADATA = EXPRESSION_METADATA.copy()`, from
   * `sqlglot/typing/bigquery.py` — unported, exactly as the base `Dialect`'s own
   * (unported) version. See the file header.
   */
  static EXPRESSION_METADATA = new Map();

  /** py:186 `Parser = BigQueryParser` — what `registerDialect` turns into `parser_class`. */
  static Parser = BigQueryParser;

  /** py:211 `Generator = BigQueryGenerator` — what `registerDialect` turns into `generator_class`. */
  static Generator = BigQueryGenerator;

  /** py:170 `class Tokenizer(tokens.Tokenizer)`; see `BigQueryTokenizer` above. */
  static Tokenizer = BigQueryTokenizer;

  /**
   * py: sqlglot/dialects/bigquery.py:134
   *
   * In BigQuery, CTEs are case-insensitive, but UDF and table names are case-sensitive
   * by default. The following check uses a heuristic to detect tables based on whether
   * they are qualified. This should generally be correct, because tables in BigQuery
   * must be qualified with at least a dataset, unless @@dataset_id is set.
   *
   * `expression.this.translate(ASCII_LOWER)` (py:157) is `_asciiTranslate(expression.this,
   * false)` — the same helper `Dialect.normalize_identifier` uses internally for its own
   * `ASCII_ONLY_NORMALIZATION` branch, exported from `dialect.js` for exactly this
   * second call site.
   */
  normalize_identifier(expression) {
    if (
      expression instanceof exp.Identifier
      && this.normalization_strategy === NormalizationStrategy.CASE_INSENSITIVE
    ) {
      let parent = expression.parent;
      while (parent instanceof exp.Dot) parent = parent.parent;

      const case_sensitive =
        parent instanceof exp.UserDefinedFunction
        || (
          parent instanceof exp.Table
          && parent.db
          && (parent.metaGet("quoted_table") || !parent.metaGet("maybe_column"))
        )
        || !!expression.metaGet("is_table");

      if (!case_sensitive) {
        expression.set("this", _asciiTranslate(expression.this, false));
      }

      return expression;
    }

    return super.normalize_identifier(expression);
  }
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the class
// body above. Same placement and argument shape as every other dialect's own call at
// the bottom of its file. Importing this module is what makes
// `Dialect.get_or_raise("bigquery")` resolve.
registerDialect(Dialects.BIGQUERY, BigQuery);
