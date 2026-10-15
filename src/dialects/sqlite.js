// py: sqlglot/dialects/sqlite.py @ 91119bc — `class SQLite(Dialect)`, AIR-2291.
//
// SETTINGS ONLY, same split as every other dialect: `sqlglot/parsers/sqlite.py`
// (the grammar, 204 LOC/7 methods, `src/parsers/sqlite.js`) and
// `sqlglot/generators/sqlite.py` (379 LOC/21 methods, `src/generators/sqlite.js`)
// land in this same round, PORT_PLAN.md R38's "full stack in one round" shape.
// SQLite is standalone (`extends Dialect` directly), same as Presto/MySQL/
// ClickHouse — no subclass chain.
//
// No `typing/sqlite.py` exists upstream, so `SQLite.EXPRESSION_METADATA` is left
// undeclared and resolves through ordinary JS static-field inheritance to the
// base `Dialect.EXPRESSION_METADATA`, same shape `dialects/doris.js`'s own header
// documents for its `MySQL`-derived case (here the base is `Dialect` itself, not
// an intermediate dialect).

import { Tokenizer, TokenType, initTokenizerSubclass } from "../tokens.js";
import { SQLiteParser } from "../parsers/sqlite.js";
import { SQLiteGenerator } from "../generators/sqlite.js";
import { Dialect, Dialects, NormalizationStrategy, registerDialect } from "./dialect.js";

/**
 * py: sqlglot/dialects/sqlite.py:21 `class Tokenizer(tokens.Tokenizer)`.
 *
 * Declared at module level, same convention as every other dialect's nested
 * `Tokenizer`; `SQLite.Tokenizer` below points at it, which is the name
 * `registerDialect` looks for. `initTokenizerSubclass` is called explicitly right
 * after the body for the same reason every other dialect does — Python's
 * `__init_subclass__` runs at class-creation time and JS has no equivalent hook.
 */
class SQLiteTokenizer extends Tokenizer {
  static IDENTIFIERS = ['"', ["[", "]"], "`"];
  static HEX_STRINGS = [
    ["x'", "'"],
    ["X'", "'"],
    ["0x", ""],
    ["0X", ""],
  ];

  static NESTED_COMMENTS = false;

  static KEYWORDS = new Map([
    ...Tokenizer.KEYWORDS,
    ["ATTACH", TokenType.ATTACH],
    ["DETACH", TokenType.DETACH],
    ["INDEXED BY", TokenType.INDEXED_BY],
    ["MATCH", TokenType.MATCH],
  ]);

  /** py:37 `COMMANDS = {*tokens.Tokenizer.COMMANDS, TokenType.REPLACE}`. */
  static COMMANDS = new Set([...Tokenizer.COMMANDS, TokenType.REPLACE]);
}
// py:35 `KEYWORDS.pop("/*+")` — a mutation AFTER the merge, not an entry omitted
// from it; same `initTokenizerSubclass`-ordering shape `snowflake.js`/`bigquery.js`'s
// own `KEYWORDS.delete(...)` calls document.
SQLiteTokenizer.KEYWORDS.delete("/*+");
initTokenizerSubclass(SQLiteTokenizer);

/** py: sqlglot/dialects/sqlite.py:13 `class SQLite(Dialect)`. */
export class SQLite extends Dialect {
  // https://sqlite.org/forum/forumpost/5e575586ac5c711b?raw
  static NORMALIZATION_STRATEGY = NormalizationStrategy.CASE_INSENSITIVE;
  static ASCII_ONLY_NORMALIZATION = true;
  static TYPED_DIVISION = true;
  static SAFE_DIVISION = true;
  static SAFE_TO_ELIMINATE_DOUBLE_NEGATION = false;

  /** py:21 `class Tokenizer(tokens.Tokenizer)`; see `SQLiteTokenizer` above. */
  static Tokenizer = SQLiteTokenizer;

  /** py:39 `Parser = SQLiteParser`. */
  static Parser = SQLiteParser;

  /** py:41 `Generator = SQLiteGenerator`. */
  static Generator = SQLiteGenerator;
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the class
// body above. Same placement and same argument as every other dialect's own call at
// the bottom of its file. Importing this module is what makes
// `Dialect.get_or_raise("sqlite")` resolve.
registerDialect(Dialects.SQLITE, SQLite);
