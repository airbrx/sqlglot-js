// py: sqlglot/tokens.py @ 91119bc
//
// PORT_PLAN.md §7 P1. The data half of the tokenizer: the class-level tables and the
// `__init_subclass__` derivation that turns them into the flat structures
// `TokenizerCore` scans with. `tokenizer_core.js` is the scanner.
//
// Class-attribute inheritance (§4.4): Python merges these tables by MRO. JS static
// inheritance gives the same READ behaviour — `Snowflake.Tokenizer.KEYWORDS` falls
// back to `Tokenizer.KEYWORDS` through the constructor's prototype chain — so dialect
// subclasses at P5-P9 are `class X extends Tokenizer { static KEYWORDS = ... }`
// followed by one `initTokenizerSubclass(X)` call, which is the explicit stand-in for
// `__init_subclass__` (JS has no such hook).
//
// Dicts are `Map`s and sets are `Set`s throughout, never plain objects — see the note
// at the top of tokenizer_core.js.

import { newTrie } from "./trie.js";
import { pyUpper } from "./_py/str.js";
import { Token, TokenizerCore, TokenType, TOKEN_TYPE_NAMES, tokenTypeStr } from "./tokenizer_core.js";

export { Token, TokenizerCore, TokenType, TOKEN_TYPE_NAMES, tokenTypeStr };

// py: tokens.py:13 — SQLGLOTC_INSTALLED
//
// Upstream detects the compiled `sqlglotc` overlay by checking whether
// `tokenizer_core` was loaded from a `.py` file. There is no compiled overlay in the
// JS port and there never will be, so this is a constant. Kept (rather than deleted)
// because `dialects/dialect.py` and `parser.py` read it, and a missing export at P3
// is a worse failure than a `false`.
export const SQLGLOTC_INSTALLED = false;

/**
 * py: tokens.py:32 — `_convert_quotes`
 * @param {Array<string|[string, string]>} arr
 * @returns {Map<string, string>}
 */
function _convert_quotes(arr) {
  return new Map(arr.map((item) => (typeof item === "string" ? [item, item] : [item[0], item[1]])));
}

/**
 * py: tokens.py:36 — `_quotes_to_format`
 * @param {number} token_type
 * @param {Array<string|[string, string]>} arr
 * @returns {Map<string, [string, number]>}
 */
function _quotes_to_format(token_type, arr) {
  return new Map([..._convert_quotes(arr)].map(([k, v]) => [k, [v, token_type]]));
}

/** `k in cls.__dict__` — an OWN static, not an inherited one. */
function ownStatic(cls, name) {
  return Object.prototype.hasOwnProperty.call(cls, name);
}

// py: tokens.py:42 — `class _TokenizerBase`
//
// The Python class body is nothing but `t.ClassVar` annotations (no values), so there
// is nothing to transliterate into the JS class body; the whole content of this class
// is `__init_subclass__`, extracted below as `initTokenizerSubclass`.
export class _TokenizerBase {}

/**
 * py: tokens.py:78 — `_TokenizerBase.__init_subclass__`
 *
 * Must be called exactly once, immediately after each tokenizer class body, in
 * upstream's declaration order. Python runs it automatically at class creation; JS has
 * no equivalent hook, so it is explicit (§4.4). The derived values are asserted
 * against `corpus/tokens/settings.json` by parity probe #1.
 *
 * @param {typeof Tokenizer} cls
 */
export function initTokenizerSubclass(cls) {
  cls._QUOTES = _convert_quotes(cls.QUOTES);
  cls._IDENTIFIERS = _convert_quotes(cls.IDENTIFIERS);
  cls._FORMAT_STRINGS = new Map([
    // py: dict-merge — a LATER key overwrites an earlier one, and `Map` constructed
    // from a pair list has the same last-wins rule, so the merge order is the
    // semantics and is preserved verbatim.
    ...[...cls._QUOTES].flatMap(([s, e]) =>
      ["n", "N"].map((p) => [p + s, [e, TokenType.NATIONAL_STRING]]),
    ),
    ..._quotes_to_format(TokenType.BIT_STRING, cls.BIT_STRINGS),
    ..._quotes_to_format(TokenType.BYTE_STRING, cls.BYTE_STRINGS),
    ..._quotes_to_format(TokenType.HEX_STRING, cls.HEX_STRINGS),
    ..._quotes_to_format(TokenType.RAW_STRING, cls.RAW_STRINGS),
    ..._quotes_to_format(TokenType.HEREDOC_STRING, cls.HEREDOC_STRINGS),
    ..._quotes_to_format(TokenType.UNICODE_STRING, cls.UNICODE_STRINGS),
  ]);
  if (!ownStatic(cls, "BYTE_STRING_ESCAPES")) {
    // py: `cls.STRING_ESCAPES.copy()` — a shallow copy, so a subclass mutating one
    // does not reach the other.
    cls.BYTE_STRING_ESCAPES = cls.STRING_ESCAPES.slice();
  }
  cls._STRING_ESCAPES = new Set(cls.STRING_ESCAPES);
  cls._BYTE_STRING_ESCAPES = new Set(cls.BYTE_STRING_ESCAPES);
  cls._ESCAPE_FOLLOW_CHARS = new Set(cls.ESCAPE_FOLLOW_CHARS);
  cls._IDENTIFIER_ESCAPES = new Set(cls.IDENTIFIER_ESCAPES);
  cls._COMMENTS = new Map([
    ...cls.COMMENTS.filter((c) => typeof c === "string").map((c) => [c, null]),
    ...cls.COMMENTS.filter((c) => typeof c !== "string").map((c) => [c[0], c[1]]),
    ["{#", "#}"], // Ensure Jinja comments are tokenized correctly in all dialects
  ]);
  if (cls.KEYWORDS.has(cls.HINT_START)) {
    cls._COMMENTS.set(cls.HINT_START, "*/");
  }
  cls._KEYWORD_TRIE = newTrie(
    [...cls.KEYWORDS.keys(), ...cls._COMMENTS.keys(), ...cls._QUOTES.keys(), ...cls._FORMAT_STRINGS.keys()]
      .filter(
        (key) =>
          key.includes(" ") || [...cls.SINGLE_TOKENS.keys()].some((single) => key.includes(single)),
      )
      // py: `key.upper()` — str.upper(), NOT the ASCII-only _CHAR_UPPER the scanner
      // walks the trie with. Every shipped key is ASCII so the two agree today; they
      // stop agreeing the moment a dialect adds a non-ASCII keyword, and the *trie*
      // side is the one that uses the full mapping.
      .map((key) => pyUpper(key)),
  );
}

// py: tokens.py:121 — `class Tokenizer(_TokenizerBase)`
export class Tokenizer extends _TokenizerBase {
  // py: tokens.py:122-154
  static SINGLE_TOKENS = new Map([
    ["(", TokenType.L_PAREN],
    [")", TokenType.R_PAREN],
    ["[", TokenType.L_BRACKET],
    ["]", TokenType.R_BRACKET],
    ["{", TokenType.L_BRACE],
    ["}", TokenType.R_BRACE],
    ["&", TokenType.AMP],
    ["^", TokenType.CARET],
    [":", TokenType.COLON],
    [",", TokenType.COMMA],
    [".", TokenType.DOT],
    ["-", TokenType.DASH],
    ["=", TokenType.EQ],
    [">", TokenType.GT],
    ["<", TokenType.LT],
    ["%", TokenType.MOD],
    ["!", TokenType.NOT],
    ["|", TokenType.PIPE],
    ["+", TokenType.PLUS],
    [";", TokenType.SEMICOLON],
    ["/", TokenType.SLASH],
    ["\\", TokenType.BACKSLASH],
    ["*", TokenType.STAR],
    ["~", TokenType.TILDE],
    ["?", TokenType.PLACEHOLDER],
    ["@", TokenType.PARAMETER],
    ["#", TokenType.HASH],
    // Used for breaking a var like x'y' but nothing else the token type doesn't matter
    ["'", TokenType.UNKNOWN],
    ["`", TokenType.UNKNOWN],
    ['"', TokenType.UNKNOWN],
  ]);

  // py: tokens.py:156-172
  static BIT_STRINGS = [];
  static BYTE_STRINGS = [];
  static HEX_STRINGS = [];
  static RAW_STRINGS = [];
  static HEREDOC_STRINGS = [];
  static UNICODE_STRINGS = [];
  static IDENTIFIERS = ['"'];
  static QUOTES = ["'"];
  static STRING_ESCAPES = ["'"];
  static BYTE_STRING_ESCAPES = [];
  static VAR_SINGLE_TOKENS = new Set();
  static ESCAPE_FOLLOW_CHARS = [];

  // The strings in this list can always be used as escapes, regardless of the surrounding
  // identifier delimiters. By default, the closing delimiter is assumed to also act as an
  // identifier escape, e.g. if we use double-quotes, then they also act as escapes: "x"""
  static IDENTIFIER_ESCAPES = [];

  // Whether the heredoc tags follow the same lexical rules as unquoted identifiers
  static HEREDOC_TAG_IS_IDENTIFIER = false;

  // Token that we'll generate as a fallback if the heredoc prefix doesn't correspond to a heredoc
  static HEREDOC_STRING_ALTERNATIVE = TokenType.VAR;

  // Whether string escape characters function as such when placed within raw strings
  static STRING_ESCAPES_ALLOWED_IN_RAW_STRINGS = true;

  static NESTED_COMMENTS = true;

  static HINT_START = "/*+";

  static TOKENS_PRECEDING_HINT = new Set([
    TokenType.SELECT,
    TokenType.INSERT,
    TokenType.UPDATE,
    TokenType.DELETE,
  ]);

  // Autofilled — py: tokens.py:189-198. Overwritten by initTokenizerSubclass below;
  // declared here so the shape is visible and a subclass that forgets the init call
  // fails on an empty table rather than on `undefined`.
  static _COMMENTS = new Map();
  static _FORMAT_STRINGS = new Map();
  static _IDENTIFIERS = new Map();
  static _IDENTIFIER_ESCAPES = new Set();
  static _QUOTES = new Map();
  static _STRING_ESCAPES = new Set();
  static _BYTE_STRING_ESCAPES = new Set();
  static _KEYWORD_TRIE = new Map();
  static _ESCAPE_FOLLOW_CHARS = new Set();

  // py: tokens.py:200-513
  //
  // One entry per line in upstream declaration order (§8.1 Rule 2'). Per-entry `// py:`
  // anchors are deliberately omitted here, unlike parser.js/generator.js: Rule 2' exists
  // because P9's 24 dialect efforts all append to those files' shared tables, whereas a
  // dialect's tokenizer keywords live in its own `dialects/<x>.js` subclass and never
  // touch this literal. Order is CI-asserted against corpus/tokens/settings.json.
  static KEYWORDS = new Map([
    // py: **{f"{{%{postfix}": TokenType.BLOCK_START for postfix in ("", "+", "-")},
    ...["", "+", "-"].map((postfix) => [`{%${postfix}`, TokenType.BLOCK_START]),
    // py: **{f"{prefix}%}}": TokenType.BLOCK_END for prefix in ("", "+", "-")},
    ...["", "+", "-"].map((prefix) => [`${prefix}%}`, TokenType.BLOCK_END]),
    // py: **{f"{{{{{postfix}": TokenType.BLOCK_START for postfix in ("+", "-")},
    ...["+", "-"].map((postfix) => [`{{${postfix}`, TokenType.BLOCK_START]),
    // py: **{f"{prefix}}}}}": TokenType.BLOCK_END for prefix in ("+", "-")},
    ...["+", "-"].map((prefix) => [`${prefix}}}`, TokenType.BLOCK_END]),
    [this.HINT_START, TokenType.HINT],
    ["&<", TokenType.AMP_LT],
    ["&>", TokenType.AMP_GT],
    ["==", TokenType.EQ],
    ["::", TokenType.DCOLON],
    ["?::", TokenType.QDCOLON],
    ["||", TokenType.DPIPE],
    ["|>", TokenType.PIPE_GT],
    [">=", TokenType.GTE],
    ["<=", TokenType.LTE],
    ["<>", TokenType.NEQ],
    ["!=", TokenType.NEQ],
    [":=", TokenType.COLON_EQ],
    ["<=>", TokenType.NULLSAFE_EQ],
    ["->", TokenType.ARROW],
    ["->>", TokenType.DARROW],
    ["=>", TokenType.FARROW],
    ["#>", TokenType.HASH_ARROW],
    ["#>>", TokenType.DHASH_ARROW],
    ["<->", TokenType.LR_ARROW],
    ["<<->>", TokenType.LLRR_ARROW],
    ["&&", TokenType.DAMP],
    ["??", TokenType.DQMARK],
    ["~~~", TokenType.GLOB],
    ["~~", TokenType.LIKE],
    ["~~*", TokenType.ILIKE],
    ["~*", TokenType.IRLIKE],
    ["-|-", TokenType.ADJACENT],
    ["ALL", TokenType.ALL],
    ["AND", TokenType.AND],
    ["ANTI", TokenType.ANTI],
    ["ANY", TokenType.ANY],
    ["ASC", TokenType.ASC],
    ["AS", TokenType.ALIAS],
    ["ASOF", TokenType.ASOF],
    ["AUTOINCREMENT", TokenType.AUTO_INCREMENT],
    ["AUTO_INCREMENT", TokenType.AUTO_INCREMENT],
    ["BEGIN", TokenType.BEGIN],
    ["BETWEEN", TokenType.BETWEEN],
    ["CACHE", TokenType.CACHE],
    ["UNCACHE", TokenType.UNCACHE],
    ["CASE", TokenType.CASE],
    ["CLUSTER BY", TokenType.CLUSTER_BY],
    ["COLLATE", TokenType.COLLATE],
    ["COLUMN", TokenType.COLUMN],
    ["COMMIT", TokenType.COMMIT],
    ["CONNECT BY", TokenType.CONNECT_BY],
    ["CONSTRAINT", TokenType.CONSTRAINT],
    ["COPY", TokenType.COPY],
    ["CREATE", TokenType.CREATE],
    ["CROSS", TokenType.CROSS],
    ["CUBE", TokenType.CUBE],
    ["CURRENT_DATE", TokenType.CURRENT_DATE],
    ["CURRENT_SCHEMA", TokenType.CURRENT_SCHEMA],
    ["CURRENT_TIME", TokenType.CURRENT_TIME],
    ["CURRENT_TIMESTAMP", TokenType.CURRENT_TIMESTAMP],
    ["CURRENT_USER", TokenType.CURRENT_USER],
    // Found via airbrx-gateway PR #228's review: parser.js already has a
    // CURRENT_ROLE -> exp.CurrentRole builder rule wired up (py:484-485
    // twin of CURRENT_USER's), and contrib/gatewaySqlMetadata.js's
    // classifyNonDeterministic() already handles exp.CurrentRole -- but
    // this keyword table had no entry to ever produce that token type in
    // the first place, so "CURRENT_ROLE" tokenized as a plain identifier
    // and parsed as exp.Column across every dialect, silently exempting it
    // from non-deterministic-function detection (a genuine identity-
    // dependent function, same class as CURRENT_USER/SESSION_USER, both of
    // which already worked correctly).
    ["CURRENT_ROLE", TokenType.CURRENT_ROLE],
    ["CURRENT_CATALOG", TokenType.CURRENT_CATALOG],
    ["DATABASE", TokenType.DATABASE],
    ["DEFAULT", TokenType.DEFAULT],
    ["DELETE", TokenType.DELETE],
    ["DESC", TokenType.DESC],
    ["DESCRIBE", TokenType.DESCRIBE],
    ["DISTINCT", TokenType.DISTINCT],
    ["DISTRIBUTE BY", TokenType.DISTRIBUTE_BY],
    ["DIV", TokenType.DIV],
    ["DROP", TokenType.DROP],
    ["ELSE", TokenType.ELSE],
    ["END", TokenType.END],
    ["ENUM", TokenType.ENUM],
    ["ESCAPE", TokenType.ESCAPE],
    ["EXCEPT", TokenType.EXCEPT],
    ["EXECUTE", TokenType.EXECUTE],
    ["EXISTS", TokenType.EXISTS],
    ["FALSE", TokenType.FALSE],
    ["FETCH", TokenType.FETCH],
    ["FILTER", TokenType.FILTER],
    ["FILE", TokenType.FILE],
    ["FIRST", TokenType.FIRST],
    ["FULL", TokenType.FULL],
    ["FUNCTION", TokenType.FUNCTION],
    ["FOR", TokenType.FOR],
    ["FOREIGN KEY", TokenType.FOREIGN_KEY],
    ["FORMAT", TokenType.FORMAT],
    ["FROM", TokenType.FROM],
    ["GEOGRAPHY", TokenType.GEOGRAPHY],
    ["GEOMETRY", TokenType.GEOMETRY],
    ["GLOB", TokenType.GLOB],
    ["GROUP BY", TokenType.GROUP_BY],
    ["GROUPING SETS", TokenType.GROUPING_SETS],
    ["HAVING", TokenType.HAVING],
    ["ILIKE", TokenType.ILIKE],
    ["IN", TokenType.IN],
    ["INDEX", TokenType.INDEX],
    ["INET", TokenType.INET],
    ["INNER", TokenType.INNER],
    ["INSERT", TokenType.INSERT],
    ["INTERVAL", TokenType.INTERVAL],
    ["INTERSECT", TokenType.INTERSECT],
    ["INTO", TokenType.INTO],
    ["IS", TokenType.IS],
    ["ISNULL", TokenType.ISNULL],
    ["JOIN", TokenType.JOIN],
    ["KEEP", TokenType.KEEP],
    ["KILL", TokenType.KILL],
    ["LATERAL", TokenType.LATERAL],
    ["LEFT", TokenType.LEFT],
    ["LIKE", TokenType.LIKE],
    ["LIMIT", TokenType.LIMIT],
    ["LOAD", TokenType.LOAD],
    ["LOCALTIME", TokenType.LOCALTIME],
    ["LOCALTIMESTAMP", TokenType.LOCALTIMESTAMP],
    ["LOCK", TokenType.LOCK],
    ["MERGE", TokenType.MERGE],
    ["NAMESPACE", TokenType.NAMESPACE],
    ["NATURAL", TokenType.NATURAL],
    ["NEXT", TokenType.NEXT],
    ["NOT", TokenType.NOT],
    ["NOTNULL", TokenType.NOTNULL],
    ["NULL", TokenType.NULL],
    ["OBJECT", TokenType.OBJECT],
    ["OFFSET", TokenType.OFFSET],
    ["ON", TokenType.ON],
    ["OR", TokenType.OR],
    ["XOR", TokenType.XOR],
    ["ORDER BY", TokenType.ORDER_BY],
    ["ORDINALITY", TokenType.ORDINALITY],
    ["OUT", TokenType.OUT],
    ["OUTER", TokenType.OUTER],
    ["OVER", TokenType.OVER],
    ["OVERLAPS", TokenType.OVERLAPS],
    ["OVERWRITE", TokenType.OVERWRITE],
    ["PARTITION", TokenType.PARTITION],
    ["PARTITION BY", TokenType.PARTITION_BY],
    ["PARTITIONED BY", TokenType.PARTITION_BY],
    ["PARTITIONED_BY", TokenType.PARTITION_BY],
    ["PERCENT", TokenType.PERCENT],
    ["PIVOT", TokenType.PIVOT],
    ["PRAGMA", TokenType.PRAGMA],
    ["PRIMARY KEY", TokenType.PRIMARY_KEY],
    ["PROCEDURE", TokenType.PROCEDURE],
    ["OPERATOR", TokenType.OPERATOR],
    ["QUALIFY", TokenType.QUALIFY],
    ["RANGE", TokenType.RANGE],
    ["RECURSIVE", TokenType.RECURSIVE],
    ["REGEXP", TokenType.RLIKE],
    ["RENAME", TokenType.RENAME],
    ["REPLACE", TokenType.REPLACE],
    ["RETURNING", TokenType.RETURNING],
    ["REFERENCES", TokenType.REFERENCES],
    ["RIGHT", TokenType.RIGHT],
    ["RLIKE", TokenType.RLIKE],
    ["ROLLBACK", TokenType.ROLLBACK],
    ["ROLLUP", TokenType.ROLLUP],
    ["ROW", TokenType.ROW],
    ["ROWS", TokenType.ROWS],
    ["SCHEMA", TokenType.SCHEMA],
    ["SELECT", TokenType.SELECT],
    ["SEMI", TokenType.SEMI],
    ["SESSION", TokenType.SESSION],
    ["SESSION_USER", TokenType.SESSION_USER],
    ["SET", TokenType.SET],
    ["SETTINGS", TokenType.SETTINGS],
    ["SHOW", TokenType.SHOW],
    ["SIMILAR TO", TokenType.SIMILAR_TO],
    ["SOME", TokenType.SOME],
    ["SORT BY", TokenType.SORT_BY],
    ["SQL SECURITY", TokenType.SQL_SECURITY],
    ["STRAIGHT_JOIN", TokenType.STRAIGHT_JOIN],
    ["TABLE", TokenType.TABLE],
    ["TABLESAMPLE", TokenType.TABLE_SAMPLE],
    ["TEMP", TokenType.TEMPORARY],
    ["TEMPORARY", TokenType.TEMPORARY],
    ["THEN", TokenType.THEN],
    ["TRUE", TokenType.TRUE],
    ["TRUNCATE", TokenType.TRUNCATE],
    ["TRIGGER", TokenType.TRIGGER],
    ["UNION", TokenType.UNION],
    ["UNKNOWN", TokenType.UNKNOWN],
    ["UNNEST", TokenType.UNNEST],
    ["UNPIVOT", TokenType.UNPIVOT],
    ["UPDATE", TokenType.UPDATE],
    ["USE", TokenType.USE],
    ["USING", TokenType.USING],
    ["UUID", TokenType.UUID],
    ["VALUES", TokenType.VALUES],
    ["VIEW", TokenType.VIEW],
    ["VOLATILE", TokenType.VOLATILE],
    ["WHEN", TokenType.WHEN],
    ["WHERE", TokenType.WHERE],
    ["WINDOW", TokenType.WINDOW],
    ["WITH", TokenType.WITH],
    ["APPLY", TokenType.APPLY],
    ["ARRAY", TokenType.ARRAY],
    ["BIT", TokenType.BIT],
    ["BOOL", TokenType.BOOLEAN],
    ["BOOLEAN", TokenType.BOOLEAN],
    ["BYTE", TokenType.TINYINT],
    ["MEDIUMINT", TokenType.MEDIUMINT],
    ["INT1", TokenType.TINYINT],
    ["TINYINT", TokenType.TINYINT],
    ["INT16", TokenType.SMALLINT],
    ["SHORT", TokenType.SMALLINT],
    ["SMALLINT", TokenType.SMALLINT],
    ["HUGEINT", TokenType.INT128],
    ["UHUGEINT", TokenType.UINT128],
    ["INT2", TokenType.SMALLINT],
    ["INTEGER", TokenType.INT],
    ["INT", TokenType.INT],
    ["INT4", TokenType.INT],
    ["INT32", TokenType.INT],
    ["INT64", TokenType.BIGINT],
    ["INT128", TokenType.INT128],
    ["INT256", TokenType.INT256],
    ["LONG", TokenType.BIGINT],
    ["BIGINT", TokenType.BIGINT],
    ["INT8", TokenType.TINYINT],
    ["UINT", TokenType.UINT],
    ["UINT128", TokenType.UINT128],
    ["UINT256", TokenType.UINT256],
    ["DEC", TokenType.DECIMAL],
    ["DECIMAL", TokenType.DECIMAL],
    ["DECIMAL32", TokenType.DECIMAL32],
    ["DECIMAL64", TokenType.DECIMAL64],
    ["DECIMAL128", TokenType.DECIMAL128],
    ["DECIMAL256", TokenType.DECIMAL256],
    ["DECFLOAT", TokenType.DECFLOAT],
    ["BIGDECIMAL", TokenType.BIGDECIMAL],
    ["BIGNUMERIC", TokenType.BIGDECIMAL],
    ["BIGNUM", TokenType.BIGNUM],
    ["LIST", TokenType.LIST],
    ["MAP", TokenType.MAP],
    ["NULLABLE", TokenType.NULLABLE],
    ["NUMBER", TokenType.DECIMAL],
    ["NUMERIC", TokenType.DECIMAL],
    ["FIXED", TokenType.DECIMAL],
    ["REAL", TokenType.FLOAT],
    ["FLOAT", TokenType.FLOAT],
    ["FLOAT4", TokenType.FLOAT],
    ["FLOAT8", TokenType.DOUBLE],
    ["DOUBLE", TokenType.DOUBLE],
    ["DOUBLE PRECISION", TokenType.DOUBLE],
    ["JSON", TokenType.JSON],
    ["JSONB", TokenType.JSONB],
    ["CHAR", TokenType.CHAR],
    ["CHARACTER", TokenType.CHAR],
    ["CHAR VARYING", TokenType.VARCHAR],
    ["CHARACTER VARYING", TokenType.VARCHAR],
    ["NCHAR", TokenType.NCHAR],
    ["VARCHAR", TokenType.VARCHAR],
    ["VARCHAR2", TokenType.VARCHAR],
    ["NVARCHAR", TokenType.NVARCHAR],
    ["NVARCHAR2", TokenType.NVARCHAR],
    ["BPCHAR", TokenType.BPCHAR],
    ["STR", TokenType.TEXT],
    ["STRING", TokenType.TEXT],
    ["TEXT", TokenType.TEXT],
    ["LONGTEXT", TokenType.LONGTEXT],
    ["MEDIUMTEXT", TokenType.MEDIUMTEXT],
    ["TINYTEXT", TokenType.TINYTEXT],
    ["CLOB", TokenType.TEXT],
    ["LONGVARCHAR", TokenType.TEXT],
    ["BINARY", TokenType.BINARY],
    ["BLOB", TokenType.VARBINARY],
    ["LONGBLOB", TokenType.LONGBLOB],
    ["MEDIUMBLOB", TokenType.MEDIUMBLOB],
    ["TINYBLOB", TokenType.TINYBLOB],
    ["BYTEA", TokenType.VARBINARY],
    ["VARBINARY", TokenType.VARBINARY],
    ["TIME", TokenType.TIME],
    ["TIMETZ", TokenType.TIMETZ],
    ["TIME_NS", TokenType.TIME_NS],
    ["TIMESTAMP", TokenType.TIMESTAMP],
    ["TIMESTAMPTZ", TokenType.TIMESTAMPTZ],
    ["TIMESTAMPLTZ", TokenType.TIMESTAMPLTZ],
    ["TIMESTAMP_LTZ", TokenType.TIMESTAMPLTZ],
    ["TIMESTAMPNTZ", TokenType.TIMESTAMPNTZ],
    ["TIMESTAMP_NTZ", TokenType.TIMESTAMPNTZ],
    ["DATE", TokenType.DATE],
    ["DATETIME", TokenType.DATETIME],
    ["INT4RANGE", TokenType.INT4RANGE],
    ["INT4MULTIRANGE", TokenType.INT4MULTIRANGE],
    ["INT8RANGE", TokenType.INT8RANGE],
    ["INT8MULTIRANGE", TokenType.INT8MULTIRANGE],
    ["NUMRANGE", TokenType.NUMRANGE],
    ["NUMMULTIRANGE", TokenType.NUMMULTIRANGE],
    ["TSRANGE", TokenType.TSRANGE],
    ["TSMULTIRANGE", TokenType.TSMULTIRANGE],
    ["TSTZRANGE", TokenType.TSTZRANGE],
    ["TSTZMULTIRANGE", TokenType.TSTZMULTIRANGE],
    ["DATERANGE", TokenType.DATERANGE],
    ["DATEMULTIRANGE", TokenType.DATEMULTIRANGE],
    ["UNIQUE", TokenType.UNIQUE],
    ["VECTOR", TokenType.VECTOR],
    ["STRUCT", TokenType.STRUCT],
    ["SEQUENCE", TokenType.SEQUENCE],
    ["VARIANT", TokenType.VARIANT],
    ["ALTER", TokenType.ALTER],
    ["ANALYZE", TokenType.ANALYZE],
    ["CALL", TokenType.COMMAND],
    ["COMMENT", TokenType.COMMENT],
    ["EXPLAIN", TokenType.COMMAND],
    ["GRANT", TokenType.GRANT],
    ["REVOKE", TokenType.REVOKE],
    ["OPTIMIZE", TokenType.COMMAND],
    ["PREPARE", TokenType.COMMAND],
    ["VACUUM", TokenType.COMMAND],
    ["USER-DEFINED", TokenType.USERDEFINED],
  ]);

  // py: tokens.py:515-521
  static COMMANDS = new Set([
    TokenType.COMMAND,
    TokenType.EXECUTE,
    TokenType.FETCH,
    TokenType.SHOW,
    TokenType.RENAME,
  ]);

  static COMMAND_PREFIX_TOKENS = new Set([TokenType.SEMICOLON, TokenType.BEGIN]);

  // Handle numeric literals like in hive (3L = BIGINT)
  static NUMERIC_LITERALS = new Map();

  // In tokenizers like JSONPath, dots are always key separators, never decimal points
  static NUMBERS_CAN_HAVE_DECIMALS = true;

  static COMMENTS = ["--", ["/*", "*/"]];

  /**
   * py: tokens.py:538 — `Tokenizer.__init__`
   *
   * DEVIATION (recorded in CONTRACTS.md §8): upstream calls
   * `Dialect.get_or_raise(dialect)` through a function-level import to break a circular
   * dependency. `src/dialects/dialect.js` does not exist until P5, and a JS constructor
   * cannot `await import(...)`, so the registry is injected instead:
   * `setDialectResolver()` is called once by `dialects/dialect.js` when it lands, and
   * until then only an already-resolved settings object (or `null`, meaning the base
   * `Dialect` defaults) is accepted. Resolving a dialect *name* without the registry
   * throws rather than silently tokenizing as the default dialect — a silent fallback
   * there would make every P1 parity row for every dialect vacuously green.
   *
   * @param {object|null} [dialect]
   */
  constructor(dialect = null) {
    super();
    this.dialect = resolveDialect(dialect);
    this._core = this._init_core();
  }

  // py: tokens.py:544 — `Tokenizer._init_core`
  _init_core() {
    const cls = /** @type {typeof Tokenizer} */ (this.constructor);
    return new TokenizerCore({
      single_tokens: cls.SINGLE_TOKENS,
      keywords: cls.KEYWORDS,
      quotes: cls._QUOTES,
      format_strings: cls._FORMAT_STRINGS,
      identifiers: cls._IDENTIFIERS,
      comments: cls._COMMENTS,
      string_escapes: cls._STRING_ESCAPES,
      byte_string_escapes: cls._BYTE_STRING_ESCAPES,
      identifier_escapes: cls._IDENTIFIER_ESCAPES,
      escape_follow_chars: cls._ESCAPE_FOLLOW_CHARS,
      commands: cls.COMMANDS,
      command_prefix_tokens: cls.COMMAND_PREFIX_TOKENS,
      nested_comments: cls.NESTED_COMMENTS,
      hint_start: cls.HINT_START,
      tokens_preceding_hint: cls.TOKENS_PRECEDING_HINT,
      has_bit_strings: Boolean(cls.BIT_STRINGS.length),
      has_hex_strings: Boolean(cls.HEX_STRINGS.length),
      numeric_literals: cls.NUMERIC_LITERALS,
      var_single_tokens: cls.VAR_SINGLE_TOKENS,
      string_escapes_allowed_in_raw_strings: cls.STRING_ESCAPES_ALLOWED_IN_RAW_STRINGS,
      heredoc_tag_is_identifier: cls.HEREDOC_TAG_IS_IDENTIFIER,
      heredoc_string_alternative: cls.HEREDOC_STRING_ALTERNATIVE,
      keyword_trie: cls._KEYWORD_TRIE,
      numbers_can_be_underscore_separated: this.dialect.NUMBERS_CAN_BE_UNDERSCORE_SEPARATED,
      numbers_can_have_decimals: cls.NUMBERS_CAN_HAVE_DECIMALS,
      identifiers_can_start_with_digit: this.dialect.IDENTIFIERS_CAN_START_WITH_DIGIT,
      unescaped_sequences: this.dialect.UNESCAPED_SEQUENCES,
    });
  }

  /**
   * py: tokens.py:575 — `Tokenizer.tokenize(sql)`
   *
   * Returns `{tokens, codePoints}` per CONTRACTS.md §2, not a bare token list.
   * @param {string} sql
   * @returns {{tokens: Token[], codePoints: string[]}}
   */
  tokenize(sql) {
    return this._core.tokenize(sql);
  }

  /** py: `Tokenizer.sql` — the SQL string being tokenized. */
  get sql() {
    return this._core.sql;
  }

  /** py: `Tokenizer.size` — length of the SQL string, in CODE POINTS. */
  get size() {
    return this._core.size;
  }

  /** py: `Tokenizer.tokens` — the list of tokens produced by tokenization. */
  get tokens() {
    return this._core.tokens;
  }
}

initTokenizerSubclass(Tokenizer);

/* --------------------------------------------------------------------------- *
 * Dialect resolution seam — see the note on Tokenizer's constructor.            *
 * --------------------------------------------------------------------------- */

/**
 * py: `dialects/dialect.py` — the three `Dialect` class attributes `_init_core` reads.
 * These are the base `Dialect`'s own defaults, verified against upstream.
 */
export const BASE_DIALECT_TOKENIZER_SETTINGS = Object.freeze({
  NUMBERS_CAN_BE_UNDERSCORE_SEPARATED: false,
  IDENTIFIERS_CAN_START_WITH_DIGIT: false,
  UNESCAPED_SEQUENCES: new Map(),
});

/** @type {((dialect: any) => any) | null} */
let _dialectResolver = null;

/**
 * Installed once by `dialects/dialect.js` at P5 with `Dialect.get_or_raise`. Exists so
 * P1 can be verified without the registry, and so P5 does not have to edit this file.
 * @param {(dialect: any) => any} fn
 */
export function setDialectResolver(fn) {
  _dialectResolver = fn;
}

function resolveDialect(dialect) {
  if (_dialectResolver) return _dialectResolver(dialect);
  if (dialect === null || dialect === undefined) return BASE_DIALECT_TOKENIZER_SETTINGS;
  if (typeof dialect === "object") return dialect;
  throw new Error(
    `Cannot resolve dialect ${JSON.stringify(dialect)}: the registry lands at P5. ` +
      "Pass a resolved settings object, or call setDialectResolver() first.",
  );
}
