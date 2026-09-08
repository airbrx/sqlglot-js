// py: sqlglot/dialects/snowflake.py — `class Snowflake(Dialect)`.
//
// SETTINGS ONLY. This file is the small half of the Snowflake port and is deliberately
// not where the grammar lives: `sqlglot/parsers/snowflake.py` (1,440 LOC, 38 methods,
// 17 class-table overrides) is a DIFFERENT upstream file and is already ported to
// `src/parsers/snowflake.js` (PORT_PLAN.md R15/R16 — an earlier revision of R15 named
// the wrong one of the two, which is why the distinction is restated here). All this
// file adds is `class Snowflake extends Dialect` with ~20 overridden settings, the
// nested `Tokenizer` subclass, `can_quote`, and the `registerDialect` call that makes
// `Dialect.get_or_raise("snowflake")` return it.
//
// WHY THE `registerDialect` CALL AT THE BOTTOM IS THE WHOLE POINT
// ---------------------------------------------------------------
// `src/parsers/snowflake.js` reads settings off `this.dialect` — the resolved Dialect
// INSTANCE. JS `static` fields live on the CONSTRUCTOR and are not on the prototype, so
// `instance.NULL_ORDERING` is `undefined` unless something mirrors them (PORT_PLAN.md
// R20). `registerDialect` does that mirroring, as its last step, after every derivation
// is final. Declaring the class without registering it would therefore produce a class
// that looks complete and whose settings are invisible to every consumer.
//
// ONE GAP REMAINS, announced rather than faked; the other closed in this round:
//
//   `Generator = SnowflakeGenerator` (py:189) IS now declared — `generators/snowflake.js`
//   exists (P4, PORT_PLAN.md R21 follow-up). `registerDialect`'s py:304
//   `SUPPORTED_JSON_PATH_PARTS` pruning no longer needs `sqlglot/jsonpath.py`: the
//   `ALL_JSON_PATH_PARTS` half of that logic is trait-derived from `_gen/expr_meta.js`
//   (generator.js), which is exactly as real as reading it from the unported module.
//
//   `class JSONPathTokenizer(jsonpath.JSONPathTokenizer)` (py:130) is NOT declared, for
//   the same reason `Dialect.jsonpath_tokenizer_class` is null: `sqlglot/jsonpath.py` is
//   unported. Omitting it leaves `jsonpath_tokenizer_class` null (registerDialect's own
//   fallback) and `jsonpath_tokenizer()` throwing, rather than handing `to_json_path` a
//   scanner that lexes JSON paths as SQL.
//
// Every setting below is diffed value-by-value against CPython by
// `spike/p5/fuzz_snowflake_dialect.mjs`, including the twelve `registerDialect` DERIVES
// rather than reads (`VALID_INTERVAL_UNITS`, `ESCAPED_SEQUENCES`, `INVERSE_TIME_MAPPING`,
// `QUOTE_START`, `HEX_START`, ...). That probe exists because R21's hazard class is
// exactly this file's shape: a hand-transcribed class-level VALUE that nothing anywhere
// compares against upstream, invisible until some far-away dialect finally reads it.

import { Tokenizer, TokenType, initTokenizerSubclass } from "../tokens.js";
import { SnowflakeParser } from "../parsers/snowflake.js";
import { SnowflakeGenerator } from "../generators/snowflake.js";
import * as exp from "../expressions/index.js";
import {
  DATE_PART_MAPPING,
  Dialect,
  Dialects,
  NormalizationStrategy,
  registerDialect,
} from "./dialect.js";

/**
 * py: sqlglot/dialects/snowflake.py:132 `class Tokenizer(tokens.Tokenizer)`.
 *
 * Declared at module level rather than inside the class body because JS has no nested
 * class declarations; `Snowflake.Tokenizer` below points at it, which is the name
 * `registerDialect` (py:291 `klass.__dict__.get("Tokenizer", ...)`) looks for.
 *
 * `initTokenizerSubclass` is called explicitly right after the body, exactly as
 * `src/tokens.js` does for the base `Tokenizer`: Python runs `__init_subclass__` at
 * class-creation time and JS has no equivalent hook. It is NOT optional here —
 * `registerDialect` only auto-derives the tokenizer it synthesises itself, so without
 * this call `_KEYWORD_TRIE`, `_COMMENTS`, `_FORMAT_STRINGS` and `_STRING_ESCAPES` would
 * all be inherited from the base class and the Snowflake-only `$$` raw strings, `x'…'`
 * hex strings, `//` comments and `\` escapes would never be scanned.
 */
class SnowflakeTokenizer extends Tokenizer {
  static STRING_ESCAPES = ["\\", "'"];
  static HEX_STRINGS = [
    ["x'", "'"],
    ["X'", "'"],
  ];
  static RAW_STRINGS = ["$$"];
  static COMMENTS = ["--", "//", ["/*", "*/"]];
  static NESTED_COMMENTS = false;

  static KEYWORDS = new Map([
    ...Tokenizer.KEYWORDS,
    ["BYTEINT", TokenType.INT],
    ["FILE://", TokenType.URI_START],
    ["FILE FORMAT", TokenType.FILE_FORMAT],
    ["GET", TokenType.GET],
    ["INTEGRATION", TokenType.INTEGRATION],
    ["MATCH_CONDITION", TokenType.MATCH_CONDITION],
    ["MATCH_RECOGNIZE", TokenType.MATCH_RECOGNIZE],
    ["MINUS", TokenType.EXCEPT],
    ["NCHAR VARYING", TokenType.VARCHAR],
    ["PACKAGE", TokenType.PACKAGE],
    ["POLICY", TokenType.POLICY],
    ["POOL", TokenType.POOL],
    ["PUT", TokenType.PUT],
    ["UNDROP", TokenType.UNDROP],
    ["REMOVE", TokenType.COMMAND],
    ["RM", TokenType.COMMAND],
    ["ROLE", TokenType.ROLE],
    ["RULE", TokenType.RULE],
    ["SAMPLE", TokenType.TABLE_SAMPLE],
    ["SEMANTIC VIEW", TokenType.SEMANTIC_VIEW],
    ["SQL_DOUBLE", TokenType.DOUBLE],
    ["SQL_VARCHAR", TokenType.VARCHAR],
    ["STAGE", TokenType.STAGE],
    ["STORAGE INTEGRATION", TokenType.STORAGE_INTEGRATION],
    ["STREAMLIT", TokenType.STREAMLIT],
    ["TAG", TokenType.TAG],
    ["TIMESTAMP_TZ", TokenType.TIMESTAMPTZ],
    ["TOP", TokenType.TOP],
    ["VOLUME", TokenType.VOLUME],
    ["WAREHOUSE", TokenType.WAREHOUSE],
    // https://docs.snowflake.com/en/sql-reference/data-types-numeric#float
    // FLOAT is a synonym for DOUBLE in Snowflake
    ["FLOAT", TokenType.DOUBLE],
  ]);

  static SINGLE_TOKENS = new Map([
    ...Tokenizer.SINGLE_TOKENS,
    ["$", TokenType.PARAMETER],
    // Base maps "!" to `NOT`; Snowflake re-points it, so this is an OVERRIDE of an
    // existing key rather than an addition. `Map` keeps the original insertion
    // position on re-set, which is Python's `{**base, "!": ...}` rule exactly.
    ["!", TokenType.EXCLAMATION],
  ]);

  static VAR_SINGLE_TOKENS = new Set(["$"]);

  // py:187 `COMMANDS = tokens.Tokenizer.COMMANDS - {TokenType.SHOW}` — Snowflake parses
  // SHOW rather than swallowing it as a Command (`_parse_show_snowflake`).
  static COMMANDS = new Set([...Tokenizer.COMMANDS].filter((t) => t !== TokenType.SHOW));
}
// py:154 `KEYWORDS.pop("/*+")` — a mutation of the dict AFTER the merge, not an entry
// omitted from it. It matters beyond the keyword table: `initTokenizerSubclass` copies
// `HINT_START` into `_COMMENTS` only `if HINT_START in KEYWORDS`, so removing it here is
// what stops `/*+ ... */` being scanned as a hint comment in Snowflake.
SnowflakeTokenizer.KEYWORDS.delete("/*+");
initTokenizerSubclass(SnowflakeTokenizer);

/** py: sqlglot/dialects/snowflake.py:16 `class Snowflake(Dialect)`. */
export class Snowflake extends Dialect {
  // https://docs.snowflake.com/en/sql-reference/identifiers-syntax
  static NORMALIZATION_STRATEGY = NormalizationStrategy.UPPERCASE;
  // https://docs.snowflake.com/en/sql-reference/data-types-text#escape-sequences
  static UNESCAPED_SEQUENCES = new Map([
    ["\\a", "a"],
    ["\\v", "v"],
  ]);
  static NULL_ORDERING = "nulls_are_large";
  static TIME_FORMAT = "'YYYY-MM-DD HH24:MI:SS'";
  static SUPPORTS_USER_DEFINED_TYPES = false;
  static PREFER_CTE_ALIAS_COLUMN = true;
  static SUPPORTS_POSITIONAL_COLUMN_REFS = true;
  static TABLESAMPLE_SIZE_IS_PERCENT = true;
  static COPY_PARAMS_ARE_CSV = false;
  static ARRAY_AGG_INCLUDES_NULLS = null;
  static ARRAY_FUNCS_PROPAGATES_NULLS = true;
  static ALTER_TABLE_ADD_REQUIRED_FOR_EACH_COLUMN = false;
  static TRY_CAST_REQUIRES_STRING = true;
  static SUPPORTS_ALIAS_REFS_IN_JOIN_CONDITIONS = true;
  static LEAST_GREATEST_IGNORES_NULLS = false;
  static UUID_IS_STRING_TYPE = true;
  static STAR_ILIKE_BACKSLASH_ESCAPE = true;

  /**
   * py:38 `EXPRESSION_METADATA = EXPRESSION_METADATA.copy()`, from
   * `sqlglot/typing/snowflake.py` — a 457-entry type-inference table.
   *
   * Unported, exactly as the base `Dialect`'s own 294-entry version is unported:
   * `sqlglot/optimizer/annotate_types.py` and the `typing/` package are P6+. Declared
   * as an empty Map rather than omitted so the attribute EXISTS with the right shape,
   * and `spike/p5/fuzz_snowflake_dialect.mjs` prints CPython's 457 against the port's 0
   * on every run — a gap that states its own size rather than a table nobody remembers
   * is missing (PORT_PLAN.md R19).
   */
  static EXPRESSION_METADATA = new Map();

  // https://docs.snowflake.com/en/en/sql-reference/functions/initcap
  // py:41. A plain Python string, not a regex: `\\-` and `\\[`/`\\]` are a literal
  // backslash followed by the character, and JS `\\` is the same literal backslash, so
  // the doubling carries over verbatim. Same convention as the base class's py:773.
  static INITCAP_DEFAULT_DELIMITER_CHARS = ' \t\n\r\f\v!?@"^#$&~_,.:;+\\-*%/|\\[\\](){}<>';

  static INVERSE_TIME_MAPPING = new Map([
    // in TIME_MAPPING we map '"T"' with the double quotes to 'T', and we want to
    // prevent 'T' from being mapped back to '"T"' so that 'AUTO' doesn't become 'AU"T"O'
    ["T", "T"],
  ]);

  static TIME_MAPPING = new Map([
    ["YYYY", "%Y"],
    ["yyyy", "%Y"],
    ["YY", "%y"],
    ["yy", "%y"],
    ["MMMM", "%B"],
    ["mmmm", "%B"],
    ["MON", "%b"],
    ["mon", "%b"],
    ["MM", "%m"],
    ["mm", "%m"],
    ["DD", "%d"],
    ["dd", "%-d"],
    ["DY", "%a"],
    ["dy", "%w"],
    ["HH24", "%H"],
    ["hh24", "%H"],
    ["HH12", "%I"],
    ["hh12", "%I"],
    ["MI", "%M"],
    ["mi", "%M"],
    ["SS", "%S"],
    ["ss", "%S"],
    ["FF", "%f_nine"], // %f_ internal representation with precision specified
    ["ff", "%f_nine"],
    ["FF0", "%f_zero"],
    ["ff0", "%f_zero"],
    ["FF1", "%f_one"],
    ["ff1", "%f_one"],
    ["FF2", "%f_two"],
    ["ff2", "%f_two"],
    ["FF3", "%f_three"],
    ["ff3", "%f_three"],
    ["FF4", "%f_four"],
    ["ff4", "%f_four"],
    ["FF5", "%f_five"],
    ["ff5", "%f_five"],
    ["FF6", "%f"],
    ["ff6", "%f"],
    ["FF7", "%f_seven"],
    ["ff7", "%f_seven"],
    ["FF8", "%f_eight"],
    ["ff8", "%f_eight"],
    ["FF9", "%f_nine"],
    ["ff9", "%f_nine"],
    ["TZHTZM", "%z"],
    ["tzhtzm", "%z"],
    ["TZH:TZM", "%:z"], // internal representation for ±HH:MM
    ["tzh:tzm", "%:z"],
    ["TZH", "%-z"], // internal representation ±HH
    ["tzh", "%-z"],
    // remove the optional double quotes around the separator between the date and time
    ['"T"', "T"],
    // Seems like Snowflake treats AM/PM in the format string as equivalent,
    // only the time (stamp) value's AM/PM affects the output
    ["AM", "%p"],
    ["am", "%p"],
    ["PM", "%p"],
    ["pm", "%p"],
  ]);

  // py:105 `{**Dialect.DATE_PART_MAPPING, ...}`. Re-setting an existing key keeps its
  // original position in both a Python dict and a JS `Map`, so spreading the base first
  // reproduces the merge exactly — order included, which `map_date_part` does not care
  // about but `VALID_INTERVAL_UNITS`'s derived Set iteration order would.
  static DATE_PART_MAPPING = new Map([
    ...DATE_PART_MAPPING,
    ["ISOWEEK", "WEEKISO"],
    // The base Dialect maps EPOCH_SECOND -> EPOCH, but we need to preserve
    // EPOCH_SECOND as a distinct value for two reasons:
    // 1. Type annotation: EPOCH_SECOND returns BIGINT, while EPOCH returns DOUBLE
    // 2. Transpilation: DuckDB's EPOCH() returns float, so we cast EPOCH_SECOND
    //    to BIGINT to match Snowflake's integer behavior
    // Without this override, EXTRACT(EPOCH_SECOND FROM ts) would be normalized
    // to EXTRACT(EPOCH FROM ts) and lose the integer semantics.
    ["EPOCH_SECOND", "EPOCH_SECOND"],
    ["EPOCH_SECONDS", "EPOCH_SECOND"],
  ]);

  static PSEUDOCOLUMNS = new Set(["LEVEL"]);

  /** py:186 `Parser = SnowflakeParser` — what `registerDialect` turns into `parser_class`. */
  static Parser = SnowflakeParser;

  /** py:189 `Generator = SnowflakeGenerator` — what `registerDialect` turns into `generator_class`. */
  static Generator = SnowflakeGenerator;

  /** py:188 `class Tokenizer(tokens.Tokenizer)`; see `SnowflakeTokenizer` above. */
  static Tokenizer = SnowflakeTokenizer;

  /**
   * py: sqlglot/dialects/snowflake.py:123
   *
   * This disables quoting DUAL in SELECT ... FROM DUAL, because Snowflake treats an
   * unquoted DUAL keyword in a special way and does not map it to a user-defined table.
   *
   * `identifier.name.lower()` is `pyLower`-free on purpose: `Identifier.name` is the
   * ported accessor and the comparison is against the ASCII literal "dual", so a
   * locale-independent `toLowerCase()` matches Python here. (The full-range `pyIsLower`
   * tables are needed for `case_sensitive`'s per-character classification, which is a
   * different question.)
   */
  can_quote(identifier, identify = "safe") {
    return (
      super.can_quote(identifier, identify) &&
      !(
        identifier.parent instanceof exp.Table &&
        !identifier.quoted &&
        identifier.name.toLowerCase() === "dual"
      )
    );
  }
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the class
// body above. Same placement and same argument as `registerDialect(Dialects.DIALECT,
// Dialect)` at the bottom of `dialect.js`: the ~20 derivations a metaclass performs at
// class-creation time are performed once here, after the body, in declaration order.
// Importing this module is what makes `Dialect.get_or_raise("snowflake")` resolve.
registerDialect(Dialects.SNOWFLAKE, Snowflake);
