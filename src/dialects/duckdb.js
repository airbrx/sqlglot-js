// py: sqlglot/dialects/duckdb.py — `class DuckDB(Dialect)`.
//
// SETTINGS ONLY, same split as `src/dialects/snowflake.js` (PORT_PLAN.md R15/R16-style
// distinction, restated here because it recurs every dialect): the DuckDB GRAMMAR is a
// different upstream file, `sqlglot/parsers/duckdb.py` (414 LOC, 14 methods, already
// ported whole -- PORT_PLAN.md R22 -- into `src/parsers/duckdb.js`). All this file adds
// is `class DuckDB extends Dialect` with its ~14 overridden settings, the nested
// `Tokenizer` subclass, and `to_json_path`.
//
// WHY THE `registerDialect` CALL AT THE BOTTOM IS THE WHOLE POINT
// ---------------------------------------------------------------
// `src/parsers/duckdb.js:523` reads `this.dialect.version` off the resolved Dialect
// INSTANCE. JS `static` fields live on the CONSTRUCTOR and are not on the prototype, so
// `instance.version` — and every other setting a caller reads off `this.dialect` — is
// `undefined` unless something mirrors the class's settings onto the prototype
// (PORT_PLAN.md R20). `registerDialect` does that mirroring, as its last step, after
// every derivation is final. Before this file existed, `Dialect.get_or_raise("duckdb")`
// resolved through the synthetic stand-in class the P3 probes still declare inline
// (`spike/p3/dialect_tokenizer.mjs`'s `dialectClassFor`), which carries harvested BASE
// settings rather than DuckDB's own — measurably less accurate than the harness's
// internal routing until now.
//
// ONE DELIBERATE GAP, announced rather than faked:
//
//   `Generator = DuckDBGenerator` (py:128) is NOT declared. `generators/duckdb.js`
//   does not exist — P4 landed the base `Generator` and explicitly deferred the
//   per-dialect ones (PORT_PLAN.md R21). `registerDialect` itself throws `NotPorted`
//   the moment any dialect sets `generator_class`, because py:304's
//   `SUPPORTED_JSON_PATH_PARTS` pruning needs the unported `sqlglot/jsonpath.py`; so
//   this is not a silent omission, it is a hole with a live guard on it, same shape as
//   Snowflake's.
//
// `EXPRESSION_METADATA` (py:38, from the unported `sqlglot/typing/duckdb.py`) is
// declared as an empty Map for the same reason Snowflake's is: `sqlglot/typing/` and
// `sqlglot/optimizer/annotate_types.py` are P6+, and an empty Map states the gap's own
// shape rather than omitting the attribute.
//
// Every setting below is diffed value-by-value against CPython by
// `spike/p5/fuzz_duckdb_dialect.mjs`.

import { Tokenizer, TokenType, initTokenizerSubclass } from "../tokens.js";
import { DuckDBParser } from "../parsers/duckdb.js";
import * as exp from "../expressions/index.js";
import { DATE_PART_MAPPING, Dialect, Dialects, NormalizationStrategy, registerDialect } from "./dialect.js";

/**
 * py: sqlglot/dialects/duckdb.py:69 `class Tokenizer(tokens.Tokenizer)`.
 *
 * Declared at module level rather than inside the class body because JS has no nested
 * class declarations; `DuckDB.Tokenizer` below points at it, which is the name
 * `registerDialect` (py:291 `klass.__dict__.get("Tokenizer", ...)`) looks for.
 *
 * `initTokenizerSubclass` is called explicitly right after the body, exactly as
 * `src/tokens.js` does for the base `Tokenizer` and `snowflake.js` does for its own:
 * Python runs `__init_subclass__` at class-creation time and JS has no equivalent
 * hook. Without this call `_KEYWORD_TRIE`, `_FORMAT_STRINGS`, `_HEREDOC_STRINGS`, etc.
 * would all be inherited from the base class and DuckDB-only syntax (`e'...'` byte
 * strings, `$tag$...$tag$` heredocs, the `//`/`**`/`^@`/`@>`/`<@` operators) would
 * never be scanned.
 */
class DuckDBTokenizer extends Tokenizer {
  static BYTE_STRINGS = [
    ["e'", "'"],
    ["E'", "'"],
  ];
  static BYTE_STRING_ESCAPES = ["'", "\\"];
  static HEREDOC_STRINGS = ["$"];

  static HEREDOC_TAG_IS_IDENTIFIER = true;
  static HEREDOC_STRING_ALTERNATIVE = TokenType.PARAMETER;

  static KEYWORDS = new Map([
    ...Tokenizer.KEYWORDS,
    ["//", TokenType.DIV],
    ["**", TokenType.DSTAR],
    ["^@", TokenType.CARET_AT],
    ["@>", TokenType.AT_GT],
    ["<@", TokenType.LT_AT],
    ["ATTACH", TokenType.ATTACH],
    ["BINARY", TokenType.VARBINARY],
    ["BITSTRING", TokenType.BIT],
    ["BPCHAR", TokenType.TEXT],
    ["CHAR", TokenType.TEXT],
    ["DATETIME", TokenType.TIMESTAMPNTZ],
    ["DETACH", TokenType.DETACH],
    ["FORCE", TokenType.FORCE],
    ["INSTALL", TokenType.INSTALL],
    ["INT8", TokenType.BIGINT],
    ["LOGICAL", TokenType.BOOLEAN],
    ["MACRO", TokenType.FUNCTION],
    ["ONLY", TokenType.ONLY],
    ["PIVOT_WIDER", TokenType.PIVOT],
    ["POSITIONAL", TokenType.POSITIONAL],
    ["RESET", TokenType.COMMAND],
    ["ROW", TokenType.STRUCT],
    ["SIGNED", TokenType.INT],
    ["STRING", TokenType.TEXT],
    ["SUMMARIZE", TokenType.SUMMARIZE],
    ["TIMESTAMP", TokenType.TIMESTAMPNTZ],
    ["TIMESTAMP_S", TokenType.TIMESTAMP_S],
    ["TIMESTAMP_MS", TokenType.TIMESTAMP_MS],
    ["TIMESTAMP_NS", TokenType.TIMESTAMP_NS],
    ["TIMESTAMP_US", TokenType.TIMESTAMP],
    ["UBIGINT", TokenType.UBIGINT],
    ["UINTEGER", TokenType.UINT],
    ["USMALLINT", TokenType.USMALLINT],
    ["UTINYINT", TokenType.UTINYINT],
    ["VARCHAR", TokenType.TEXT],
  ]);

  static SINGLE_TOKENS = new Map([
    ...Tokenizer.SINGLE_TOKENS,
    ["$", TokenType.PARAMETER],
  ]);

  static VAR_SINGLE_TOKENS = new Set(["$"]);

  // py:124 `COMMANDS = tokens.Tokenizer.COMMANDS - {TokenType.SHOW}` — DuckDB parses
  // SHOW rather than swallowing it as a Command.
  static COMMANDS = new Set([...Tokenizer.COMMANDS].filter((t) => t !== TokenType.SHOW));
}
// py:115 `KEYWORDS.pop("/*+")` — a mutation of the merged map AFTER construction, not
// an entry omitted from it. `initTokenizerSubclass` copies `HINT_START` into
// `_COMMENTS` only `if HINT_START in KEYWORDS`, so removing it here is what stops
// `/*+ ... */` being scanned as a hint comment in DuckDB.
DuckDBTokenizer.KEYWORDS.delete("/*+");
initTokenizerSubclass(DuckDBTokenizer);

/** py: sqlglot/dialects/duckdb.py:16 `class DuckDB(Dialect)`. */
export class DuckDB extends Dialect {
  static NULL_ORDERING = "nulls_are_last";
  static SUPPORTS_USER_DEFINED_TYPES = true;
  static INDEX_OFFSET = 1;
  static CONCAT_COALESCE = true;
  static CONCAT_WS_COALESCE = true;
  static SUPPORTS_ORDER_BY_ALL = true;
  static SUPPORTS_LIMIT_ALL = true;
  static SUPPORTS_FIXED_SIZE_ARRAYS = true;
  static STRICT_JSON_PATH_SYNTAX = false;
  static NUMBERS_CAN_BE_UNDERSCORE_SEPARATED = true;
  static UUID_IS_STRING_TYPE = false;

  // https://duckdb.org/docs/sql/introduction.html#creating-a-new-table
  static NORMALIZATION_STRATEGY = NormalizationStrategy.CASE_INSENSITIVE;
  static ASCII_ONLY_NORMALIZATION = true;

  /**
   * py:38 `EXPRESSION_METADATA = EXPRESSION_METADATA.copy()`, from
   * `sqlglot/typing/duckdb.py` — a type-inference table.
   *
   * Unported, exactly as the base `Dialect`'s own version is unported:
   * `sqlglot/optimizer/annotate_types.py` and the `typing/` package are P6+. Declared
   * as an empty Map rather than omitted so the attribute EXISTS with the right shape
   * (PORT_PLAN.md R19), same treatment as `snowflake.js`'s copy of this note.
   */
  static EXPRESSION_METADATA = new Map();

  // py:33 `{**Dialect.DATE_PART_MAPPING, "DAYOFWEEKISO": "ISODOW"}`, then py:40
  // `DATE_PART_MAPPING.pop("WEEKDAY")` — a mutation AFTER the merge, not an entry
  // omitted from the literal. Reproduced as an add followed by a delete, in that
  // order, so the surviving key set and iteration order both match upstream.
  static DATE_PART_MAPPING = new Map([...DATE_PART_MAPPING, ["DAYOFWEEKISO", "ISODOW"]]);

  static INVERSE_TIME_MAPPING = new Map([
    // BigQuery's space-padded day (%e) -> DuckDB's no-padding day (%-d)
    ["%e", "%-d"],
    // In DuckDB %z can represent +/-HH:MM, +/-HHMM, or +/-HH.
    ["%:z", "%z"],
    ["%-z", "%z"],
    ["%f_zero", "%n"],
    ["%f_one", "%n"],
    ["%f_two", "%n"],
    ["%f_three", "%g"],
    ["%f_four", "%n"],
    ["%f_five", "%n"],
    ["%f_seven", "%n"],
    ["%f_eight", "%n"],
    ["%f_nine", "%n"],
  ]);

  /** py:186 `Parser = DuckDBParser` — what `registerDialect` turns into `parser_class`. */
  static Parser = DuckDBParser;

  /** py:69 `class Tokenizer(tokens.Tokenizer)`; see `DuckDBTokenizer` above. */
  static Tokenizer = DuckDBTokenizer;

  /**
   * py: sqlglot/dialects/duckdb.py:57
   *
   * DuckDB also supports the JSON pointer syntax, where every path starts with a `/`.
   * Additionally, it allows accessing the back of lists using the `[#-i]` syntax. This
   * check ensures we'll avoid trying to parse these as JSON paths, which can either
   * result in a noisy warning or in an invalid representation of the path.
   *
   * `path_text.startswith("/")` is a single-string `.startswith`, not the tuple form
   * CONTRACTS.md §8 flags as needing `pyStartswith` — a plain `.startsWith()` carries
   * over exactly. `"[#" in path_text` is JS `.includes()`.
   */
  to_json_path(path) {
    if (path instanceof exp.Literal) {
      const path_text = path.name;
      if (path_text.startsWith("/") || path_text.includes("[#")) return path;
    }

    return super.to_json_path(path);
  }
}
// py:40 `DATE_PART_MAPPING.pop("WEEKDAY")` — a mutation of the merged map AFTER the
// class body, not an entry omitted from the literal above. Same pattern as
// `DuckDBTokenizer.KEYWORDS.delete("/*+")` a few lines up.
DuckDB.DATE_PART_MAPPING.delete("WEEKDAY");

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the class
// body above. Same placement and same argument as `registerDialect(Dialects.SNOWFLAKE,
// Snowflake)` at the bottom of `snowflake.js`. Importing this module is what makes
// `Dialect.get_or_raise("duckdb")` resolve.
registerDialect(Dialects.DUCKDB, DuckDB);
