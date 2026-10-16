// py: sqlglot/dialects/teradata.py @ 91119bc — `class Teradata(Dialect)`, AIR-2291.
//
// SETTINGS ONLY, same split as every other dialect: `sqlglot/parsers/teradata.py`
// (the grammar, 207 LOC/8 methods, `src/parsers/teradata.js`) and
// `sqlglot/generators/teradata.py` (182 LOC/13 methods, `src/generators/
// teradata.js`) land in this same round, PORT_PLAN.md R38's "full stack in one
// round" shape. Teradata is standalone (`extends Dialect` directly), same as
// Presto/MySQL/ClickHouse — no subclass chain.
//
// No `typing/teradata.py` exists upstream, so `Teradata.EXPRESSION_METADATA` is
// left undeclared and resolves through ordinary JS static-field inheritance to
// the base `Dialect.EXPRESSION_METADATA`, same shape `dialects/doris.js`'s own
// header documents for its `MySQL`-derived case (here the base is `Dialect`
// itself, not an intermediate dialect).

import { Tokenizer, TokenType, initTokenizerSubclass } from "../tokens.js";
import { TeradataParser } from "../parsers/teradata.js";
import { TeradataGenerator } from "../generators/teradata.js";
import { Dialect, Dialects, registerDialect } from "./dialect.js";

/**
 * py: sqlglot/dialects/teradata.py:42 `class Tokenizer(tokens.Tokenizer)`.
 *
 * Declared at module level, same convention as every other dialect's nested
 * `Tokenizer`; `Teradata.Tokenizer` below points at it, which is the name
 * `registerDialect` looks for. `initTokenizerSubclass` is called explicitly right
 * after the body for the same reason every other dialect does — Python's
 * `__init_subclass__` runs at class-creation time and JS has no equivalent hook.
 */
class TeradataTokenizer extends Tokenizer {
  // Tested each of these and they work, although there is no
  // Teradata documentation explicitly mentioning them.
  static HEX_STRINGS = [
    ["X'", "'"],
    ["x'", "'"],
    ["0x", ""],
  ];

  // https://docs.teradata.com/r/Teradata-Database-SQL-Functions-Operators-Exprs-and-Predicates/March-2017/Comparison-Operators-and-Functions/Comparison-Operators/ANSI-Compliance
  // https://docs.teradata.com/r/SQL-Functions-Operators-Exprs-and-Predicates/June-2017/Arithmetic-Trigonometric-Hyperbolic-Operators/Functions
  static KEYWORDS = new Map([
    ...Tokenizer.KEYWORDS,
    ["**", TokenType.DSTAR],
    ["^=", TokenType.NEQ],
    ["BYTEINT", TokenType.SMALLINT],
    ["COLLECT", TokenType.COMMAND],
    ["DEL", TokenType.DELETE],
    ["EQ", TokenType.EQ],
    ["GE", TokenType.GTE],
    ["GT", TokenType.GT],
    ["HELP", TokenType.COMMAND],
    ["INS", TokenType.INSERT],
    ["LE", TokenType.LTE],
    ["LOCKING", TokenType.LOCK],
    ["LT", TokenType.LT],
    ["MINUS", TokenType.EXCEPT],
    ["MOD", TokenType.MOD],
    ["NE", TokenType.NEQ],
    ["NOT=", TokenType.NEQ],
    ["SAMPLE", TokenType.TABLE_SAMPLE],
    ["SEL", TokenType.SELECT],
    ["ST_GEOMETRY", TokenType.GEOMETRY],
    ["TOP", TokenType.TOP],
    ["UPD", TokenType.UPDATE],
  ]);
}
// py:73 `KEYWORDS.pop("/*+")` — a mutation AFTER the merge, not an entry omitted
// from it; same `initTokenizerSubclass`-ordering shape `snowflake.js`/`bigquery.js`'s
// own `KEYWORDS.delete(...)` calls document. Both this and the `SINGLE_TOKENS`
// mutation below happen INSIDE the Python class body, i.e. before
// `__init_subclass__` runs — `initTokenizerSubclass`'s own `_KEYWORD_TRIE`
// derivation (tokens.js) reads `SINGLE_TOKENS`, so both mutations below must
// land BEFORE the `initTokenizerSubclass` call, not after.
TeradataTokenizer.KEYWORDS.delete("/*+");

// py:75-77 `SINGLE_TOKENS = {**tokens.Tokenizer.SINGLE_TOKENS}; SINGLE_TOKENS.pop("%")`.
// Teradata does not support % as a modulo operator.
TeradataTokenizer.SINGLE_TOKENS = new Map(Tokenizer.SINGLE_TOKENS);
TeradataTokenizer.SINGLE_TOKENS.delete("%");

initTokenizerSubclass(TeradataTokenizer);

/** py: sqlglot/dialects/teradata.py:10 `class Teradata(Dialect)`. */
export class Teradata extends Dialect {
  static TYPED_DIVISION = true;

  /** py:13-40 */
  static TIME_MAPPING = new Map([
    ["YY", "%y"],
    ["Y4", "%Y"],
    ["YYYY", "%Y"],
    ["M4", "%B"],
    ["M3", "%b"],
    ["M", "%-M"],
    ["MI", "%M"],
    ["MM", "%m"],
    ["MMM", "%b"],
    ["MMMM", "%B"],
    ["D", "%-d"],
    ["DD", "%d"],
    ["D3", "%j"],
    ["DDD", "%j"],
    ["H", "%-H"],
    ["HH", "%H"],
    ["HH24", "%H"],
    ["S", "%-S"],
    ["SS", "%S"],
    ["SSSSSS", "%f"],
    ["E", "%a"],
    ["EE", "%a"],
    ["E3", "%a"],
    ["E4", "%A"],
    ["EEE", "%a"],
    ["EEEE", "%A"],
  ]);

  /** py:42 `class Tokenizer(tokens.Tokenizer)`; see `TeradataTokenizer` above. */
  static Tokenizer = TeradataTokenizer;

  /** py:79 `Parser = TeradataParser`. */
  static Parser = TeradataParser;

  /** py:81 `Generator = TeradataGenerator`. */
  static Generator = TeradataGenerator;
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the class
// body above. Same placement and same argument as every other dialect's own call at
// the bottom of its file. Importing this module is what makes
// `Dialect.get_or_raise("teradata")` resolve.
registerDialect(Dialects.TERADATA, Teradata);
