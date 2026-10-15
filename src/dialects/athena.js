// py: sqlglot/dialects/athena.py @ 91119bc — WHOLE FILE (120 LOC), AIR-2287 (epic
// AIR-2272, "12.2 Presto family"), part 2 of the chain.
//
// Athena is not simply hosted Trino: AWS routes a query to either a Hive-flavored
// DDL engine or a Trino DML engine depending on statement shape. `class Athena
// (Dialect)` extends the BASE `Dialect` directly — NOT `Presto`/`Trino` — and its own
// `Tokenizer` extends the BASE `tokens.Tokenizer`, combining Hive's and Trino's
// quoting/keyword settings into one merged tokenizer whose SOLE job is to decide,
// via `_tokenize_as_hive`, which REAL sub-tokenizer (`Hive().tokenizer()` or a Trino
// tokenizer with one extra `UNLOAD` keyword) should actually produce the token
// stream the parser/generator see. `src/parsers/athena.js`/`src/generators/
// athena.js` mirror this same Hive-vs-Trino composite shape one layer up.
//
// `tokenize(sql)` RETURNS `{tokens, codePoints}`, NOT A BARE ARRAY
// -------------------------------------------------------------------------
// Upstream's `Tokenizer.tokenize(sql) -> list[Token]` returns a bare list; this
// port's `Tokenizer.prototype.tokenize` (`tokens.js`) returns `{tokens, codePoints}`
// per CONTRACTS.md §2, so that error columns stay correct under astral characters.
// `Dialect.prototype.tokenize` (`dialects/dialect.js`) already does
// `this.tokenizer(dialect).tokenize(sql).tokens` to unwrap this, so this file's own
// override preserves the SAME shape: the merged-settings `super.tokenize(sql)` call
// is read only for its `.tokens` array (fed to `_tokenize_as_hive`'s heuristic), and
// whichever real sub-tokenizer's `{tokens, codePoints}` result is chosen is returned
// as-is (with the `HIVE_TOKEN_STREAM` sentinel token prepended to `.tokens` on the
// Hive branch) — not unwrapped early, so the generic `Dialect.tokenize` caller still
// gets a consistent shape to unwrap itself.

import { Tokenizer, TokenType, Token, initTokenizerSubclass } from "../tokens.js";
import { Dialect, Dialects, registerDialect } from "./dialect.js";
import { AthenaParser } from "../parsers/athena.js";
import { AthenaGenerator } from "../generators/athena.js";
import { Hive } from "./hive.js";
import { Trino } from "./trino.js";
import { pyUpper } from "../_py/str.js";

/** py: sqlglot/dialects/athena.py:115 `class _TrinoTokenizer(Trino.Tokenizer)`. */
class _AthenaTrinoTokenizer extends Trino.Tokenizer {
  /** py:116-119 */
  static KEYWORDS = new Map([
    ...Trino.Tokenizer.KEYWORDS,
    ["UNLOAD", TokenType.COMMAND],
  ]);
}
initTokenizerSubclass(_AthenaTrinoTokenizer);

/** py: sqlglot/dialects/athena.py:89 `_tokenize_as_hive`. */
function _tokenize_as_hive(toks) {
  if (toks.length < 2) return false;

  const [first, second, ...rest] = toks;

  const first_type = first.token_type;
  const first_text = pyUpper(first.text);
  const second_type = second.token_type;
  const second_text = pyUpper(second.text);

  if (
    first_type === TokenType.DESCRIBE ||
    first_type === TokenType.SHOW ||
    first_text === "MSCK REPAIR"
  ) {
    return true;
  }

  if (
    first_type === TokenType.ALTER ||
    first_type === TokenType.CREATE ||
    first_type === TokenType.DROP
  ) {
    if (["DATABASE", "EXTERNAL", "SCHEMA"].includes(second_text)) {
      return true;
    }
    if (second_type === TokenType.VIEW) {
      return false;
    }

    return rest.every((t) => t.token_type !== TokenType.SELECT);
  }

  return false;
}

/**
 * py: sqlglot/dialects/athena.py:53 `class Tokenizer(tokens.Tokenizer)`.
 *
 * Declared at module level, same convention every other dialect's nested
 * `Tokenizer` uses; `Athena.Tokenizer` below points at it.
 */
class AthenaTokenizer extends Tokenizer {
  /** py:54 */
  static IDENTIFIERS = [...Trino.Tokenizer.IDENTIFIERS, ...Hive.Tokenizer.IDENTIFIERS];
  /** py:55 */
  static STRING_ESCAPES = [...Trino.Tokenizer.STRING_ESCAPES, ...Hive.Tokenizer.STRING_ESCAPES];
  /** py:56 */
  static HEX_STRINGS = [...Trino.Tokenizer.HEX_STRINGS, ...Hive.Tokenizer.HEX_STRINGS];
  /** py:57 */
  static UNICODE_STRINGS = [...Trino.Tokenizer.UNICODE_STRINGS, ...Hive.Tokenizer.UNICODE_STRINGS];

  /** py:59-62 */
  static NUMERIC_LITERALS = new Map([
    ...Trino.Tokenizer.NUMERIC_LITERALS,
    ...Hive.Tokenizer.NUMERIC_LITERALS,
  ]);

  /** py:64-68 */
  static KEYWORDS = new Map([
    ...Hive.Tokenizer.KEYWORDS,
    ...Trino.Tokenizer.KEYWORDS,
    ["UNLOAD", TokenType.COMMAND],
  ]);

  /** py:70 `__init__`. */
  constructor(dialect = null) {
    super(dialect);

    this._hive_tokenizer = new Hive().tokenizer();
    this._trino_tokenizer = new _AthenaTrinoTokenizer(new Trino());
  }

  /** py:76 */
  tokenize(sql) {
    const { tokens: mergedTokens } = super.tokenize(sql);

    if (_tokenize_as_hive(mergedTokens)) {
      const hiveResult = this._hive_tokenizer.tokenize(sql);
      return {
        tokens: [new Token(TokenType.HIVE_TOKEN_STREAM, ""), ...hiveResult.tokens],
        codePoints: hiveResult.codePoints,
      };
    }

    return this._trino_tokenizer.tokenize(sql);
  }
}
initTokenizerSubclass(AthenaTokenizer);

/** py: sqlglot/dialects/athena.py:13 `class Athena(Dialect)`. */
export class Athena extends Dialect {
  /** py:53 `class Tokenizer(tokens.Tokenizer)`; see `AthenaTokenizer` above. */
  static Tokenizer = AthenaTokenizer;

  /** py:84 `Parser = AthenaParser`. */
  static Parser = AthenaParser;

  /** py:86 `Generator = AthenaGenerator`. */
  static Generator = AthenaGenerator;
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the
// class body above.
registerDialect(Dialects.ATHENA, Athena);
