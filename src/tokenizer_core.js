// py: sqlglot/tokenizer_core.py @ 91119bc
//
// PORT_PLAN.md §7 P1. Transliteration contract (§2): same class names, same method
// names, same method order, same control flow.
//
// Two deliberate, contract-mandated deviations from a literal transliteration; both
// are recorded in CONTRACTS.md §8:
//
//   1. INDEXING IS BY CODE POINT.  Python's `sql[i]` and `sql[a:b]` index code points;
//      JS string indexing is by UTF-16 unit and cuts astral characters in half. Every
//      offset this file computes — `_current`, `_start`, `_col`, `Token.start`,
//      `Token.end` — is a code-point offset, matching Python exactly, because
//      `errors.js` and `parser.js` slice the code-point array (CONTRACTS.md §2). The
//      scanner therefore works over `this._cp`, the `[...sql]` array of one-code-point
//      strings, and `tokenize()` returns it as `codePoints`.
//
//   2. KWARGS BECOME AN OPTIONS OBJECT.  `TokenizerCore.__init__` is called with 26
//      keyword arguments; JS has no keyword arguments. Same precedent as
//      `helper.csv` (CONTRACTS.md §8).
//
// Every dict becomes a `Map` and every set a `Set`, never a plain object. Same reason
// as `trie.js`: JS object keys coerce to strings, so `keywords["constructor"]` would
// find `Object.prototype.constructor` and hand the scanner a function where it expects
// a TokenType. Maps have no prototype chain to fall through to.

import { TokenError } from "./errors.js";
import { PyIndexError, PyKeyError } from "./_py/errors.js";
import {
  cpLen,
  pyChr,
  pyIsAlnum,
  pyIsDigit,
  pyIsIdentifierChar,
  pyIsSpace,
  pyRepr,
  pyStrip,
  pyUpper,
} from "./_py/str.js";
import { pyIntFromStrBase } from "./_py/num.js";
import { TRIE_END } from "./trie.js";

// py: tokenizer_core.py:9 — "dict lookup is faster than .upper() and .isdigit()".
// ASCII-only by construction (`range(97, 123)`); this is NOT `str.upper()`, and the
// difference is load-bearing — the keyword trie is walked with _CHAR_UPPER, so a
// non-ASCII lowercase letter never folds onto an ASCII trie key.
const _CHAR_UPPER = new Map();
for (let i = 97; i < 123; i++) {
  // pyChr, not String.fromCharCode: the latter is deny-listed outright (§4.6,
  // corpus/deny/py_builtins.json) because it truncates above U+FFFF. Provably safe at
  // these code points, which is exactly the reasoning the deny-list exists to refuse.
  _CHAR_UPPER.set(pyChr(i), pyChr(i - 32));
}

// py: tokenizer_core.py:10
const _DIGIT_CHARS = new Set(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);

/**
 * py: `s[a:b]` for an arbitrary Python str — a CODE-POINT slice with Python's
 * clamping and negative-index semantics. Used where upstream slices a value that is
 * not `self.sql`, e.g. `self._text[n:-m+1]` and `value[2:]`.
 *
 * @param {string} s
 * @param {number} start
 * @param {number} [end]
 * @returns {string}
 */
export function pyStrSlice(s, start, end) {
  const a = [...s];
  const n = a.length;
  let i = start === undefined ? 0 : start < 0 ? Math.max(n + start, 0) : Math.min(start, n);
  let j = end === undefined ? n : end < 0 ? Math.max(n + end, 0) : Math.min(end, n);
  return j <= i ? "" : a.slice(i, j).join("");
}

// py: tokenizer_core.py:13 — `class TokenType(IntEnum)` with `auto()`.
//
// Plain integers, 1..443, in upstream's declaration order — an IntEnum IS its integer
// value, so `TokenType.L_PAREN === 1` holds on both sides and the types work directly
// as `Set`/`Map` keys in the parser's dispatch tables. `TOKEN_TYPE_NAMES` below
// recovers the name for `__repr__` and for the parity oracle.
export const TokenType = Object.freeze({
  L_PAREN: 1,
  R_PAREN: 2,
  L_BRACKET: 3,
  R_BRACKET: 4,
  L_BRACE: 5,
  R_BRACE: 6,
  COMMA: 7,
  DOT: 8,
  DASH: 9,
  PLUS: 10,
  COLON: 11,
  DOTCOLON: 12,
  DOTCARET: 13,
  DCOLON: 14,
  DCOLONDOLLAR: 15,
  DCOLONPERCENT: 16,
  DCOLONQMARK: 17,
  DQMARK: 18,
  SEMICOLON: 19,
  STAR: 20,
  BACKSLASH: 21,
  SLASH: 22,
  LT: 23,
  LTE: 24,
  GT: 25,
  GTE: 26,
  NOT: 27,
  EQ: 28,
  NEQ: 29,
  NULLSAFE_EQ: 30,
  COLON_EQ: 31,
  COLON_GT: 32,
  NCOLON_GT: 33,
  AND: 34,
  OR: 35,
  AMP: 36,
  DPIPE: 37,
  PIPE_GT: 38,
  PIPE: 39,
  PIPE_SLASH: 40,
  DPIPE_SLASH: 41,
  CARET: 42,
  CARET_AT: 43,
  TILDE: 44,
  ARROW: 45,
  DARROW: 46,
  FARROW: 47,
  HASH: 48,
  HASH_ARROW: 49,
  DHASH_ARROW: 50,
  LR_ARROW: 51,
  LLRR_ARROW: 52,
  DAT: 53,
  AT_QMARK: 54,
  LT_AT: 55,
  AT_GT: 56,
  DOLLAR: 57,
  PARAMETER: 58,
  SESSION: 59,
  SESSION_PARAMETER: 60,
  SESSION_USER: 61,
  DAMP: 62,
  AMP_LT: 63,
  AMP_GT: 64,
  ADJACENT: 65,
  XOR: 66,
  DSTAR: 67,
  QMARK_AMP: 68,
  QMARK_PIPE: 69,
  HASH_DASH: 70,
  EXCLAMATION: 71,

  URI_START: 72,

  BLOCK_START: 73,
  BLOCK_END: 74,

  SPACE: 75,
  BREAK: 76,

  STRING: 77,
  NUMBER: 78,
  IDENTIFIER: 79,
  DATABASE: 80,
  COLUMN: 81,
  COLUMN_DEF: 82,
  SCHEMA: 83,
  TABLE: 84,
  WAREHOUSE: 85,
  STAGE: 86,
  STREAM: 87,
  STREAMLIT: 88,
  VAR: 89,
  BIT_STRING: 90,
  HEX_STRING: 91,
  BYTE_STRING: 92,
  NATIONAL_STRING: 93,
  RAW_STRING: 94,
  HEREDOC_STRING: 95,
  UNICODE_STRING: 96,

  // types
  BIT: 97,
  BOOLEAN: 98,
  TINYINT: 99,
  UTINYINT: 100,
  SMALLINT: 101,
  USMALLINT: 102,
  MEDIUMINT: 103,
  UMEDIUMINT: 104,
  INT: 105,
  UINT: 106,
  BIGINT: 107,
  UBIGINT: 108,
  BIGNUM: 109,
  INT128: 110,
  UINT128: 111,
  INT256: 112,
  UINT256: 113,
  FLOAT: 114,
  DOUBLE: 115,
  UDOUBLE: 116,
  DECIMAL: 117,
  DECIMAL32: 118,
  DECIMAL64: 119,
  DECIMAL128: 120,
  DECIMAL256: 121,
  DECFLOAT: 122,
  UDECIMAL: 123,
  BIGDECIMAL: 124,
  CHAR: 125,
  NCHAR: 126,
  VARCHAR: 127,
  NVARCHAR: 128,
  BPCHAR: 129,
  TEXT: 130,
  MEDIUMTEXT: 131,
  LONGTEXT: 132,
  BLOB: 133,
  MEDIUMBLOB: 134,
  LONGBLOB: 135,
  TINYBLOB: 136,
  TINYTEXT: 137,
  NAME: 138,
  BINARY: 139,
  VARBINARY: 140,
  JSON: 141,
  JSONB: 142,
  TIME: 143,
  TIMETZ: 144,
  TIME_NS: 145,
  TIMESTAMP: 146,
  TIMESTAMPTZ: 147,
  TIMESTAMPLTZ: 148,
  TIMESTAMPNTZ: 149,
  TIMESTAMP_S: 150,
  TIMESTAMP_MS: 151,
  TIMESTAMP_NS: 152,
  DATETIME: 153,
  DATETIME2: 154,
  DATETIME64: 155,
  SMALLDATETIME: 156,
  DATE: 157,
  DATE32: 158,
  INT4RANGE: 159,
  INT4MULTIRANGE: 160,
  INT8RANGE: 161,
  INT8MULTIRANGE: 162,
  NUMRANGE: 163,
  NUMMULTIRANGE: 164,
  TSRANGE: 165,
  TSMULTIRANGE: 166,
  TSTZRANGE: 167,
  TSTZMULTIRANGE: 168,
  DATERANGE: 169,
  DATEMULTIRANGE: 170,
  UUID: 171,
  GEOGRAPHY: 172,
  GEOGRAPHYPOINT: 173,
  NULLABLE: 174,
  GEOMETRY: 175,
  POINT: 176,
  RING: 177,
  LINESTRING: 178,
  LOCALTIME: 179,
  LOCALTIMESTAMP: 180,
  SYSTIMESTAMP: 181,
  MULTILINESTRING: 182,
  POLYGON: 183,
  MULTIPOLYGON: 184,
  HLLSKETCH: 185,
  HSTORE: 186,
  SUPER: 187,
  SERIAL: 188,
  SMALLSERIAL: 189,
  BIGSERIAL: 190,
  XML: 191,
  YEAR: 192,
  USERDEFINED: 193,
  MONEY: 194,
  SMALLMONEY: 195,
  ROWVERSION: 196,
  IMAGE: 197,
  VARIANT: 198,
  OBJECT: 199,
  INET: 200,
  IPADDRESS: 201,
  IPPREFIX: 202,
  IPV4: 203,
  IPV6: 204,
  ENUM: 205,
  ENUM8: 206,
  ENUM16: 207,
  FIXEDSTRING: 208,
  LOWCARDINALITY: 209,
  NESTED: 210,
  AGGREGATEFUNCTION: 211,
  SIMPLEAGGREGATEFUNCTION: 212,
  TDIGEST: 213,
  UNKNOWN: 214,
  VECTOR: 215,
  DYNAMIC: 216,
  VOID: 217,

  // keywords
  ALIAS: 218,
  ALTER: 219,
  ALL: 220,
  ANTI: 221,
  ANY: 222,
  APPLY: 223,
  ARRAY: 224,
  ASC: 225,
  ASOF: 226,
  ATTACH: 227,
  AUTO_INCREMENT: 228,
  BEGIN: 229,
  BETWEEN: 230,
  BULK_COLLECT_INTO: 231,
  CACHE: 232,
  CASE: 233,
  CHARACTER_SET: 234,
  CLUSTER_BY: 235,
  COLLATE: 236,
  COMMAND: 237,
  COMMENT: 238,
  COMMIT: 239,
  CONNECT_BY: 240,
  CONSTRAINT: 241,
  COPY: 242,
  CREATE: 243,
  CROSS: 244,
  CUBE: 245,
  CURRENT_DATE: 246,
  CURRENT_DATETIME: 247,
  CURRENT_SCHEMA: 248,
  CURRENT_TIME: 249,
  CURRENT_TIMESTAMP: 250,
  CURRENT_USER: 251,
  CURRENT_USER_ID: 252,
  CURRENT_ROLE: 253,
  CURRENT_CATALOG: 254,
  DECLARE: 255,
  DEFAULT: 256,
  DELETE: 257,
  DESC: 258,
  DESCRIBE: 259,
  DETACH: 260,
  DICTIONARY: 261,
  DISTINCT: 262,
  DISTRIBUTE_BY: 263,
  DIV: 264,
  DROP: 265,
  ELSE: 266,
  END: 267,
  ESCAPE: 268,
  EXCEPT: 269,
  EXECUTE: 270,
  EXISTS: 271,
  FALSE: 272,
  FETCH: 273,
  FILE: 274,
  FILE_FORMAT: 275,
  FILTER: 276,
  FINAL: 277,
  FIRST: 278,
  FOR: 279,
  FORCE: 280,
  FOREIGN_KEY: 281,
  FORMAT: 282,
  FROM: 283,
  FULL: 284,
  FUNCTION: 285,
  GET: 286,
  GLOB: 287,
  GLOBAL: 288,
  GRANT: 289,
  GROUP_BY: 290,
  GROUPING_SETS: 291,
  HAVING: 292,
  HINT: 293,
  IGNORE: 294,
  ILIKE: 295,
  IN: 296,
  INDEX: 297,
  INDEXED_BY: 298,
  INNER: 299,
  INSERT: 300,
  INSTALL: 301,
  INTEGRATION: 302,
  INTERSECT: 303,
  INTERVAL: 304,
  INTO: 305,
  INTRODUCER: 306,
  IRLIKE: 307,
  IS: 308,
  ISNULL: 309,
  JOIN: 310,
  JOIN_MARKER: 311,
  KEEP: 312,
  KEY: 313,
  KILL: 314,
  LANGUAGE: 315,
  LATERAL: 316,
  LEFT: 317,
  LIKE: 318,
  LIMIT: 319,
  LIST: 320,
  LOAD: 321,
  LOCK: 322,
  MAP: 323,
  MATCH: 324,
  MATCH_CONDITION: 325,
  MATCH_RECOGNIZE: 326,
  MEMBER_OF: 327,
  MERGE: 328,
  MOD: 329,
  MODEL: 330,
  NATURAL: 331,
  NEXT: 332,
  NOTHING: 333,
  NOTNULL: 334,
  NULL: 335,
  OBJECT_IDENTIFIER: 336,
  OFFSET: 337,
  ON: 338,
  ONLY: 339,
  OPERATOR: 340,
  ORDER_BY: 341,
  ORDER_SIBLINGS_BY: 342,
  ORDERED: 343,
  ORDINALITY: 344,
  OUT: 345,
  INOUT: 346,
  OUTER: 347,
  OVER: 348,
  OVERLAPS: 349,
  OVERWRITE: 350,
  PACKAGE: 351,
  PARTITION: 352,
  PARTITION_BY: 353,
  PERCENT: 354,
  PIVOT: 355,
  PLACEHOLDER: 356,
  POLICY: 357,
  POOL: 358,
  POSITIONAL: 359,
  PRAGMA: 360,
  PREWHERE: 361,
  PRIMARY_KEY: 362,
  PROCEDURE: 363,
  PROPERTIES: 364,
  PROJECTION: 365,
  PSEUDO_TYPE: 366,
  PUT: 367,
  QUALIFY: 368,
  QUOTE: 369,
  QDCOLON: 370,
  RANGE: 371,
  RECURSIVE: 372,
  REFRESH: 373,
  RENAME: 374,
  REPLACE: 375,
  RETURNING: 376,
  REVOKE: 377,
  REFERENCES: 378,
  RIGHT: 379,
  RLIKE: 380,
  ROLE: 381,
  ROLLBACK: 382,
  ROLLUP: 383,
  ROW: 384,
  ROWS: 385,
  RULE: 386,
  SELECT: 387,
  SEMI: 388,
  SEPARATOR: 389,
  SEQUENCE: 390,
  SERDE_PROPERTIES: 391,
  SET: 392,
  SETTINGS: 393,
  SHOW: 394,
  SIMILAR_TO: 395,
  SOME: 396,
  SORT_BY: 397,
  SOUNDS_LIKE: 398,
  SQL_SECURITY: 399,
  START_WITH: 400,
  STORAGE_INTEGRATION: 401,
  STRAIGHT_JOIN: 402,
  STRUCT: 403,
  SUMMARIZE: 404,
  TABLE_SAMPLE: 405,
  TAG: 406,
  TEMPORARY: 407,
  TOP: 408,
  THEN: 409,
  TRUE: 410,
  TRUNCATE: 411,
  TRIGGER: 412,
  TYPE: 413,
  UNCACHE: 414,
  UNDROP: 415,
  UNION: 416,
  UNNEST: 417,
  UNPIVOT: 418,
  UPDATE: 419,
  USE: 420,
  USING: 421,
  VALUES: 422,
  VARIADIC: 423,
  VIEW: 424,
  SEMANTIC_VIEW: 425,
  VOLATILE: 426,
  VOLUME: 427,
  WHEN: 428,
  WHERE: 429,
  WINDOW: 430,
  WITH: 431,
  UNIQUE: 432,
  UTC_DATE: 433,
  UTC_TIME: 434,
  UTC_TIMESTAMP: 435,
  OPTION: 436,
  SINK: 437,
  SOURCE: 438,
  ANALYZE: 439,
  NAMESPACE: 440,
  EXPORT: 441,

  // sentinels
  HIVE_TOKEN_STREAM: 442,
  SENTINEL: 443,
});

/**
 * `TokenType.X` -> "X". Index 0 is unused: upstream's `auto()` starts at 1, and
 * keeping the offset means `TOKEN_TYPE_NAMES[t]` is a direct lookup.
 */
export const TOKEN_TYPE_NAMES = (() => {
  const names = new Array(Object.keys(TokenType).length + 1).fill(null);
  for (const [name, value] of Object.entries(TokenType)) names[value] = name;
  return Object.freeze(names);
})();

/** py: TokenType.__str__ — `f"TokenType.{self.name}"`. */
export function tokenTypeStr(tokenType) {
  return `TokenType.${TOKEN_TYPE_NAMES[tokenType]}`;
}

// py: tokenizer_core.py:472
export class Token {
  // py: Token._attrs — the repr iterates these in order.
  static _attrs = Object.freeze([
    "token_type",
    "text",
    "line",
    "col",
    "start",
    "end",
    "comments",
  ]);

  /** py: Token.number(number) — a NUMBER token with `number` as its text. */
  static number(number) {
    return new Token(TokenType.NUMBER, String(number));
  }

  /** py: Token.string(string) */
  static string(string) {
    return new Token(TokenType.STRING, string);
  }

  /** py: Token.identifier(identifier) */
  static identifier(identifier) {
    return new Token(TokenType.IDENTIFIER, identifier);
  }

  /** py: Token.var(var) */
  static var(varName) {
    return new Token(TokenType.VAR, varName);
  }

  /**
   * @param {number} tokenType  a TokenType member
   * @param {string} text
   * @param {number} [line]
   * @param {number} [col]
   * @param {number} [start] code-point offset, inclusive
   * @param {number} [end]   code-point offset, inclusive
   * @param {string[]|null} [comments]
   */
  constructor(tokenType, text, line = 1, col = 1, start = 0, end = 0, comments = null) {
    this.token_type = tokenType;
    this.text = text;
    this.line = line;
    this.col = col;
    this.start = start;
    this.end = end;
    this.comments = comments === null ? [] : comments;
  }

  /**
   * py: Token.__bool__ — a SENTINEL token is falsy.
   *
   * JS has no `__bool__`, so every `if token:` in `parser.py` becomes an explicit
   * `token.bool()` at P3. This is why `SENTINEL_NONE` is called out as a P3 primitive
   * (§7 P3): silently truthy sentinels are the failure mode.
   */
  bool() {
    return this.token_type !== TokenType.SENTINEL;
  }

  /** py: Token.__repr__ */
  toString() {
    const attributes = Token._attrs
      .map((k) =>
        k === "token_type"
          ? `${k}: TokenType.${TOKEN_TYPE_NAMES[this.token_type]}`
          : `${k}: ${pyAttrStr(this[k])}`,
      )
      .join(", ");
    return `<Token ${attributes}>`;
  }
}

// py: f"{k}: {getattr(self, k)}" — `str()` of the attribute. Only `comments` is not
// already a str or int, and `str(list)` renders its elements with repr(), so the
// single-quote form `['hi']`, not JSON's `["hi"]`.
function pyAttrStr(v) {
  if (Array.isArray(v)) return pyRepr(v);
  return String(v);
}

// py: tokenizer_core.py:536
export class TokenizerCore {
  /**
   * py: TokenizerCore.__init__ — 26 keyword arguments, passed here as one options
   * object (CONTRACTS.md §8). Field order below is upstream's parameter order; the
   * settings oracle asserts it.
   *
   * @param {object} opts
   */
  constructor(opts) {
    this.single_tokens = opts.single_tokens;
    this.keywords = opts.keywords;
    this.quotes = opts.quotes;
    this.format_strings = opts.format_strings;
    this.identifiers = opts.identifiers;
    this.comments = opts.comments;
    this.string_escapes = opts.string_escapes;
    this.byte_string_escapes = opts.byte_string_escapes;
    this.identifier_escapes = opts.identifier_escapes;
    this.escape_follow_chars = opts.escape_follow_chars;
    this.commands = opts.commands;
    this.command_prefix_tokens = opts.command_prefix_tokens;
    this.nested_comments = opts.nested_comments;
    this.hint_start = opts.hint_start;
    this.tokens_preceding_hint = opts.tokens_preceding_hint;
    this.has_bit_strings = opts.has_bit_strings;
    this.has_hex_strings = opts.has_hex_strings;
    this.numeric_literals = opts.numeric_literals;
    this.var_single_tokens = opts.var_single_tokens;
    this.string_escapes_allowed_in_raw_strings = opts.string_escapes_allowed_in_raw_strings;
    this.heredoc_tag_is_identifier = opts.heredoc_tag_is_identifier;
    this.heredoc_string_alternative = opts.heredoc_string_alternative;
    this.keyword_trie = opts.keyword_trie;
    this.numbers_can_be_underscore_separated = opts.numbers_can_be_underscore_separated;
    this.numbers_can_have_decimals = opts.numbers_can_have_decimals;
    this.identifiers_can_start_with_digit = opts.identifiers_can_start_with_digit;
    this.unescaped_sequences = opts.unescaped_sequences;
    this.sql = "";
    // The code-point array of `sql`. Not an upstream field: in Python `self.sql` IS
    // code-point indexable, so this is what makes `self.sql[i]` portable.
    this._cp = [];
    this.size = 0;
    /** @type {Token[]} */
    this.tokens = [];
    this._start = 0;
    this._current = 0;
    this._line = 1;
    this._col = 0;
    /** @type {string[]} */
    this._comments = [];
    this._char = "";
    this._end = false;
    this._peek = "";
    this._prev_token_line = -1;
  }

  // py: TokenizerCore.reset
  reset() {
    this.sql = "";
    this._cp = [];
    this.size = 0;
    this.tokens = [];
    this._start = 0;
    this._current = 0;
    this._line = 1;
    this._col = 0;
    this._comments = [];
    this._char = "";
    this._end = false;
    this._peek = "";
    this._prev_token_line = -1;
  }

  /* ----------------------------------------------------------------------- *
   * Python string indexing over `self.sql`, by code point.                    *
   * Not upstream methods — they exist so every `sql[...]` below reads like    *
   * upstream while behaving like Python.                                      *
   * ----------------------------------------------------------------------- */

  /** py: `sql[i]` — negative indices wrap; out of range raises IndexError. */
  _at(i) {
    const j = i < 0 ? this.size + i : i;
    if (j < 0 || j >= this.size) {
      // Reachable: `_advance` can push `_current` past the end, and Python's
      // IndexError there is caught by `tokenize` and reported as a TokenError.
      throw new PyIndexError("string index out of range");
    }
    return this._cp[j];
  }

  /** py: `sql[a:b]` — clamping slice, never raises. */
  _slice(start, end) {
    const n = this.size;
    const i = start === undefined ? 0 : start < 0 ? Math.max(n + start, 0) : Math.min(start, n);
    const j = end === undefined ? n : end < 0 ? Math.max(n + end, 0) : Math.min(end, n);
    return j <= i ? "" : this._cp.slice(i, j).join("");
  }

  /** py: `sql.find(needle, start[, end])` — code-point offset, or -1. */
  _find(needle, start, end) {
    const pat = [...needle];
    const n = this.size;
    const hi = end === undefined ? n : end < 0 ? Math.max(n + end, 0) : Math.min(end, n);
    let lo = start === undefined ? 0 : start < 0 ? Math.max(n + start, 0) : Math.min(start, n);
    if (pat.length === 0) return lo <= hi ? lo : -1;
    const cp = this._cp;
    const last = hi - pat.length;
    outer: for (let i = lo; i <= last; i++) {
      for (let k = 0; k < pat.length; k++) {
        if (cp[i + k] !== pat[k]) continue outer;
      }
      return i;
    }
    return -1;
  }

  /** py: `sql.count(ch, start, end)` for a single-code-point needle. */
  _count(ch, start, end) {
    let n = 0;
    for (let i = start; i < end; i++) if (this._cp[i] === ch) n++;
    return n;
  }

  /** py: `sql.rfind(ch, start, end)` for a single-code-point needle. */
  _rfind(ch, start, end) {
    for (let i = end - 1; i >= start; i--) if (this._cp[i] === ch) return i;
    return -1;
  }

  /**
   * py: TokenizerCore.tokenize(sql)
   *
   * DEVIATION (CONTRACTS.md §2, frozen at P0): returns `{tokens, codePoints}` rather
   * than upstream's bare `list[Token]`. Three components depend on it — `errors.js`
   * and `parser.js` slice `codePoints`, never the raw JS string, so error columns and
   * `highlight_sql` stay correct under astral characters.
   *
   * @param {string} sql
   * @returns {{tokens: Token[], codePoints: string[]}}
   */
  tokenize(sql) {
    this.reset();
    this.sql = sql;
    this._cp = [...sql];
    // py: len(sql) — CODE POINTS. `sql.length` is UTF-16 units and would make every
    // offset after the first astral character wrong.
    this.size = this._cp.length;

    try {
      this._scan();
    } catch (e) {
      const start = Math.max(this._current - 50, 0);
      const end = Math.min(this._current + 50, this.size - 1);
      const context = this._slice(start, end);
      const err = new TokenError(`Error tokenizing '${context}'`, start, end);
      // py: `raise ... from e`
      err.cause = e;
      throw err;
    }

    return { tokens: this.tokens, codePoints: this._cp };
  }

  // py: TokenizerCore._scan
  _scan(check_semicolon = false) {
    const identifiers = this.identifiers;
    const digit_chars = _DIGIT_CHARS;

    while (this.size && !this._end) {
      let current = this._current;

      // Skip spaces here rather than iteratively calling advance() for performance reasons
      while (current < this.size) {
        const char = this._cp[current];

        if (char === " " || char === "\t") {
          current += 1;
        } else {
          break;
        }
      }

      const offset = current > this._current ? current - this._current : 1;

      this._start = current;
      this._advance(offset);

      if (!pyIsSpace(this._char)) {
        if (digit_chars.has(this._char)) {
          this._scan_number();
        } else if (identifiers.has(this._char)) {
          this._scan_identifier(identifiers.get(this._char));
        } else {
          this._scan_keywords();
        }
      }

      if (check_semicolon && this._peek === ";") {
        break;
      }
    }

    if (this.tokens.length && this._comments.length) {
      this.tokens[this.tokens.length - 1].comments.push(...this._comments);
    }
  }

  // py: TokenizerCore._chars
  _chars(size) {
    if (size === 1) {
      return this._char;
    }

    const start = this._current - 1;
    const end = start + size;

    return end <= this.size ? this._slice(start, end) : "";
  }

  // py: TokenizerCore._advance
  _advance(i = 1, alnum = false) {
    const char = this._char;

    if (char === "\n" || char === "\r") {
      // Ensures we don't count an extra line if we get a \r\n line break sequence
      if (!(char === "\r" && this._peek === "\n")) {
        this._col = i;
        this._line += 1;
      }
    } else {
      this._col += i;
    }

    this._current += i;
    const size = this.size;
    this._end = this._current >= size;
    this._char = this._at(this._current - 1);
    this._peek = this._end ? "" : this._cp[this._current];

    if (alnum && pyIsAlnum(this._char)) {
      // Cache to local variables instead of attributes for better performance
      let _col = this._col;
      let _current = this._current;
      let _end = this._end;
      let _peek = this._peek;

      while (pyIsAlnum(_peek)) {
        _col += 1;
        _current += 1;
        _end = _current >= size;
        _peek = _end ? "" : this._cp[_current];
      }

      this._col = _col;
      this._current = _current;
      this._end = _end;
      this._peek = _peek;
      this._char = this._at(_current - 1);
    }
  }

  // py: TokenizerCore._text (a property)
  get _text() {
    return this._slice(this._start, this._current);
  }

  // py: TokenizerCore._add
  _add(token_type, text = null) {
    this._prev_token_line = this._line;

    if (this._comments.length && token_type === TokenType.SEMICOLON && this.tokens.length) {
      this.tokens[this.tokens.length - 1].comments.push(...this._comments);
      this._comments = [];
    }

    if (text === null) {
      text = this._slice(this._start, this._current);
    }

    this.tokens.push(
      new Token(
        token_type,
        text,
        this._line,
        this._col,
        this._start,
        this._current - 1,
        this._comments,
      ),
    );
    this._comments = [];

    // If we have either a semicolon or a begin token before the command's token, we'll parse
    // whatever follows the command's token as a string
    if (
      this.commands.has(token_type) &&
      this._peek !== ";" &&
      (this.tokens.length === 1 ||
        this.command_prefix_tokens.has(this.tokens[this.tokens.length - 2].token_type))
    ) {
      const start = this._current;
      const tokens = this.tokens.length;
      this._scan(true);
      this.tokens = this.tokens.slice(0, tokens);
      text = pyStrip(this._slice(start, this._current));
      if (text) {
        this._add(TokenType.STRING, text);
      }
    }
  }

  // py: TokenizerCore._scan_keywords
  _scan_keywords() {
    const sql_size = this.size;
    const single_tokens = this.single_tokens;
    const char_upper = _CHAR_UPPER;
    let size = 0;
    let word = null;
    let chars = this._char;
    let char = chars;
    let prev_space = false;
    let skip = false;
    let trie = this.keyword_trie;
    let single_token = single_tokens.has(char);

    while (chars) {
      if (!skip) {
        const sub = trie.get(char_upper.has(char) ? char_upper.get(char) : char);
        if (sub === undefined) {
          break;
        }
        trie = sub;
        if (trie.has(TRIE_END)) {
          word = chars;
        }
      }

      const end = this._current + size;
      size += 1;

      if (end < sql_size) {
        char = this._cp[end];
        single_token = single_token || single_tokens.has(char);
        const is_space = pyIsSpace(char);

        if (!is_space || !prev_space) {
          if (is_space) {
            char = " ";
          }
          chars += char;
          prev_space = is_space;
          skip = false;
        } else {
          skip = true;
        }
      } else {
        char = "";
        break;
      }
    }

    if (word) {
      if (this._scan_string(word)) {
        return;
      }
      if (this._scan_comment(word)) {
        return;
      }
      if (prev_space || single_token || !char) {
        this._advance(size - 1);
        word = pyUpper(word);
        // py: `self.keywords[word]` — a bare dict access, so a miss is a KeyError,
        // which `tokenize` converts into a TokenError. `.get()` returning undefined
        // would instead construct a Token with an undefined type.
        if (!this.keywords.has(word)) throw new PyKeyError(word);
        this._add(this.keywords.get(word), word);
        return;
      }
    }

    if (single_tokens.has(this._char)) {
      this._add(single_tokens.get(this._char), this._char);
      return;
    }

    this._scan_var();
  }

  // py: TokenizerCore._scan_comment
  _scan_comment(comment_start) {
    if (!this.comments.has(comment_start)) {
      return false;
    }

    const comment_start_line = this._line;
    const comment_start_size = cpLen(comment_start);
    const comment_end = this.comments.get(comment_start);

    if (comment_end) {
      // Skip the comment's start delimiter
      this._advance(comment_start_size);

      let comment_count = 1;
      const comment_end_size = cpLen(comment_end);
      const nested_comments = this.nested_comments;

      while (!this._end) {
        if (this._chars(comment_end_size) === comment_end) {
          comment_count -= 1;
          if (!comment_count) {
            break;
          }
        }

        this._advance(1, true);

        // Nested comments are allowed by some dialects, e.g. databricks, duckdb, postgres
        if (
          nested_comments &&
          !this._end &&
          // py: yes, `comment_end_size` against `comment_start`. Upstream reads the
          // END delimiter's width and compares it to the START delimiter. The widths
          // DIFFER for HINT_START ("/*+" -> "*/", 3 code points vs 2) in 17 of 34
          // configs, which makes this branch dead for hints -- on both sides,
          // identically. That is upstream's behaviour and must be preserved, not
          // "fixed" (§2: transliterate, don't improve).
          this._chars(comment_end_size) === comment_start
        ) {
          this._advance(comment_start_size);
          comment_count += 1;
        }
      }

      this._comments.push(pyStrSlice(this._text, comment_start_size, -comment_end_size + 1));
      this._advance(comment_end_size - 1);
    } else {
      let _peek = this._peek;
      while (!this._end && _peek !== "\n" && _peek !== "\r") {
        this._advance(1, true);
        _peek = this._peek;
      }
      this._comments.push(pyStrSlice(this._text, comment_start_size));
    }

    if (
      comment_start === this.hint_start &&
      this.tokens.length &&
      this.tokens_preceding_hint.has(this.tokens[this.tokens.length - 1].token_type)
    ) {
      this._add(TokenType.HINT);
    }

    // Leading comment is attached to the succeeding token, whilst trailing comment to the preceding.
    // Multiple consecutive comments are preserved by appending them to the current comments list.
    if (comment_start_line === this._prev_token_line) {
      this.tokens[this.tokens.length - 1].comments.push(...this._comments);
      this._comments = [];
      this._prev_token_line = this._line;
    }

    return true;
  }

  // py: TokenizerCore._scan_number
  _scan_number() {
    if (this._char === "0") {
      const peek = _CHAR_UPPER.has(this._peek) ? _CHAR_UPPER.get(this._peek) : this._peek;
      if (peek === "B") {
        return this.has_bit_strings ? this._scan_bits() : this._add(TokenType.NUMBER);
      } else if (peek === "X") {
        return this.has_hex_strings ? this._scan_hex() : this._add(TokenType.NUMBER);
      }
    }

    let decimal = false;
    let scientific = 0;
    const numbers_can_be_underscore_separated = this.numbers_can_be_underscore_separated;
    const single_tokens = this.single_tokens;
    const keywords = this.keywords;
    const numeric_literals = this.numeric_literals;
    const identifiers_can_start_with_digit = this.identifiers_can_start_with_digit;

    let is_underscore_separated = false;
    let number_text = "";
    let numeric_literal = "";
    let numeric_type = null;

    for (;;) {
      if (_DIGIT_CHARS.has(this._peek)) {
        // Batch consecutive digits: scan ahead to find how many
        const cp = this._cp;
        let end = this._current + 1;
        const size = this.size;
        while (end < size && _DIGIT_CHARS.has(cp[end])) {
          end += 1;
        }
        this._advance(end - this._current);
      } else if (this._peek === "." && !decimal) {
        if (
          (this.tokens.length &&
            this.tokens[this.tokens.length - 1].token_type === TokenType.PARAMETER) ||
          !this.numbers_can_have_decimals
        ) {
          break;
        }
        decimal = true;
        this._advance();
      } else if ((this._peek === "-" || this._peek === "+") && scientific === 1) {
        // Only consume +/- if followed by a digit
        if (this._current + 1 < this.size && _DIGIT_CHARS.has(this._cp[this._current + 1])) {
          scientific += 1;
          this._advance();
        } else {
          break;
        }
      } else if (
        (_CHAR_UPPER.has(this._peek) ? _CHAR_UPPER.get(this._peek) : this._peek) === "E" &&
        !scientific
      ) {
        scientific += 1;
        this._advance();
      } else if (this._peek === "_" && numbers_can_be_underscore_separated) {
        is_underscore_separated = true;
        this._advance();
      } else if (pyIsIdentifierChar(this._peek)) {
        number_text = this._text;

        while (this._peek && !pyIsSpace(this._peek) && !single_tokens.has(this._peek)) {
          numeric_literal += this._peek;
          this._advance();
        }

        const literal = numeric_literals.get(pyUpper(numeric_literal));
        numeric_type = keywords.get(literal === undefined ? "" : literal) ?? null;

        if (numeric_type) {
          break;
        } else if (identifiers_can_start_with_digit) {
          return this._add(TokenType.VAR);
        }

        this._advance(-cpLen(numeric_literal));
        break;
      } else {
        break;
      }
    }

    number_text = number_text || this._slice(this._start, this._current);

    // Normalize inputs such as 100_000 to 100000
    if (is_underscore_separated) {
      number_text = number_text.split("_").join("");
    }

    this._add(TokenType.NUMBER, number_text);

    // Normalize inputs such as 123L to 123::BIGINT so that they're parsed as casts
    if (numeric_type) {
      this._add(TokenType.DCOLON, "::");
      this._add(numeric_type, numeric_literal);
    }
  }

  // py: TokenizerCore._scan_bits
  _scan_bits() {
    this._advance();
    const value = this._extract_value();
    // py: `int(value, 2)` inside try/except ValueError. Only success/failure is
    // observed; the value is discarded.
    if (pyIntFromStrBase(value, 2) !== null) {
      this._add(TokenType.BIT_STRING, pyStrSlice(value, 2)); // Drop the 0b
    } else {
      this._add(TokenType.IDENTIFIER);
    }
  }

  // py: TokenizerCore._scan_hex
  _scan_hex() {
    this._advance();
    const value = this._extract_value();
    // py: `int(value, 16)` inside try/except ValueError.
    if (pyIntFromStrBase(value, 16) !== null) {
      this._add(TokenType.HEX_STRING, pyStrSlice(value, 2)); // Drop the 0x
    } else {
      this._add(TokenType.IDENTIFIER);
    }
  }

  // py: TokenizerCore._extract_value
  _extract_value() {
    const single_tokens = this.single_tokens;

    for (;;) {
      const char = pyStrip(this._peek);
      if (char && !single_tokens.has(char)) {
        this._advance(1, true);
      } else {
        break;
      }
    }

    return this._text;
  }

  // py: TokenizerCore._scan_string
  _scan_string(start) {
    let base = null;
    let token_type = TokenType.STRING;
    let end;

    if (this.quotes.has(start)) {
      end = this.quotes.get(start);
    } else if (this.format_strings.has(start)) {
      [end, token_type] = this.format_strings.get(start);

      if (token_type === TokenType.HEX_STRING) {
        base = 16;
      } else if (token_type === TokenType.BIT_STRING) {
        base = 2;
      } else if (token_type === TokenType.HEREDOC_STRING) {
        this._advance();

        let tag;
        if (this._char === end) {
          tag = "";
        } else {
          tag = this._extract_string(end, undefined, true, !this.heredoc_tag_is_identifier);
        }

        if (
          tag &&
          this.heredoc_tag_is_identifier &&
          (this._end || pyIsDigit(tag) || [...tag].some((c) => pyIsSpace(c)))
        ) {
          if (!this._end) {
            this._advance(-1);
          }

          this._advance(-cpLen(tag));
          this._add(this.heredoc_string_alternative);
          return true;
        }

        end = `${start}${tag}${end}`;
      }
    } else {
      return false;
    }

    this._advance(cpLen(start));
    const text = this._extract_string(
      end,
      token_type === TokenType.BYTE_STRING ? this.byte_string_escapes : this.string_escapes,
      token_type === TokenType.RAW_STRING,
    );

    if (base && text) {
      // py: bare `except Exception` around `int(text, base)`.
      if (pyIntFromStrBase(text, base) === null) {
        throw new TokenError(
          `Numeric string contains invalid characters from ${this._line}:${this._start}`,
        );
      }
    }

    this._add(token_type, text);
    return true;
  }

  // py: TokenizerCore._scan_identifier
  _scan_identifier(identifier_end) {
    this._advance();
    const text = this._extract_string(
      identifier_end,
      new Set([...this.identifier_escapes, identifier_end]),
    );
    this._add(TokenType.IDENTIFIER, text);
  }

  // py: TokenizerCore._scan_var
  _scan_var() {
    const var_single_tokens = this.var_single_tokens;
    const single_tokens = this.single_tokens;

    for (;;) {
      const peek = this._peek;
      if (!peek || pyIsSpace(peek)) {
        break;
      }
      if (!var_single_tokens.has(peek) && single_tokens.has(peek)) {
        break;
      }
      this._advance(1, true);
    }

    this._add(
      this.tokens.length && this.tokens[this.tokens.length - 1].token_type === TokenType.PARAMETER
        ? TokenType.VAR
        : this.keywords.get(pyUpper(this._slice(this._start, this._current))) ?? TokenType.VAR,
    );
  }

  // py: TokenizerCore._extract_string
  _extract_string(delimiter, escapes = undefined, raw_string = false, raise_unmatched = true) {
    let text = "";
    const delim_size = cpLen(delimiter);
    escapes = escapes === undefined ? this.string_escapes : escapes;
    const unescaped_sequences = this.unescaped_sequences;
    const escape_follow_chars = this.escape_follow_chars;
    const string_escapes_allowed_in_raw_strings = this.string_escapes_allowed_in_raw_strings;
    const quotes = this.quotes;

    // use str.find() when the string is simple... no \ or other escapes
    if (delim_size === 1) {
      const pos = this._current - 1;
      const end = this._find(delimiter, pos);

      if (
        // the closing delimiter was found
        end !== -1 &&
        // there's no doubled delimiter (e.g. '' escape), or the delimiter isn't an escape char
        (end + 1 >= this.size || this._cp[end + 1] !== delimiter || !escapes.has(delimiter)) &&
        // no backslash in the string that would need escape processing
        (!(unescaped_sequences.size || escapes.has("\\")) || this._find("\\", pos, end) === -1)
      ) {
        const newlines = this._count("\n", pos, end);
        if (newlines) {
          this._line += newlines;
          this._col = end - this._rfind("\n", pos, end);
        } else {
          this._col += end - pos;
        }

        this._current = end + 1;
        this._end = this._current >= this.size;
        this._char = this._cp[end];
        this._peek = this._end ? "" : this._cp[this._current];
        return this._slice(pos, end);
      }
    }

    for (;;) {
      if (!raw_string && unescaped_sequences.size && this._peek && escapes.has(this._char)) {
        const unescaped_sequence = unescaped_sequences.get(this._char + this._peek);
        if (unescaped_sequence) {
          this._advance(2);
          text += unescaped_sequence;
          continue;
        }
      }

      const is_valid_custom_escape =
        escape_follow_chars.size &&
        this._char === "\\" &&
        !escape_follow_chars.has(this._peek);

      // An escaped quote before the closing delimiter (e.g. \" in """a\"""") must be
      // consumed here, otherwise it'd be picked up by the delimiter check below and
      // terminate the string early. This is only relevant for multi-char delimiters
      // made up of quote chars, e.g. it shouldn't apply to Snowflake's $$ strings
      const escaped_delimiter =
        this._peek === delimiter ||
        (delim_size > 1 && this._peek === [...delimiter][0] && quotes.has(this._peek));

      if (
        (string_escapes_allowed_in_raw_strings || !raw_string) &&
        escapes.has(this._char) &&
        (escaped_delimiter || escapes.has(this._peek) || is_valid_custom_escape) &&
        (!quotes.has(this._char) || this._char === this._peek)
      ) {
        if (escaped_delimiter) {
          text += !raw_string ? this._peek : this._char + this._peek;
        } else if (is_valid_custom_escape && this._char !== this._peek) {
          text += this._peek;
        } else {
          text += this._char + this._peek;
        }

        if (this._current + 1 < this.size) {
          this._advance(2);
        } else {
          throw new TokenError(`Missing ${delimiter} from ${this._line}:${this._current}`);
        }
      } else {
        if (this._chars(delim_size) === delimiter) {
          if (delim_size > 1) {
            this._advance(delim_size - 1);
          }
          break;
        }

        if (this._end) {
          if (!raise_unmatched) {
            return text + this._char;
          }

          throw new TokenError(`Missing ${delimiter} from ${this._line}:${this._start}`);
        }

        const current = this._current - 1;
        this._advance(1, true);
        text += this._slice(current, this._current - 1);
      }
    }

    return text;
  }
}
