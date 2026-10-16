// py: sqlglot/parsers/teradata.py @ 91119bc — WHOLE FILE (207 LOC, 8 methods), AIR-2291.
//
// `class TeradataParser(parser.Parser)` — the READ-side Teradata grammar, landing
// alongside `dialects/teradata.py` (settings) and `generators/teradata.py` (write
// side) in this same round, PORT_PLAN.md R38's "full stack in one round" shape.
// Teradata is standalone (`extends Parser` directly), same as Presto/MySQL/
// ClickHouse — no subclass chain.
//
// `TokenType.LOCK`/`TokenType.LOCKING` (STATEMENT_PARSERS, py:1363-1364) route to
// `_parse_locking()`, a base-`Parser` method that was still a `NotPorted` stub
// (`parser.js:3290`) — ported in the same round as its own `// py:` anchor
// (`src/parser.js`, right above this file) since Teradata is the first dialect to
// actually reach it.

import { Parser, setDiff, setUnion } from "../parser.js";
import { TokenType } from "../tokens.js";
import { seqGet } from "../helper.js";
import { newTrie } from "../trie.js";
import * as exp from "../expressions/index.js";

/** py: sqlglot/parsers/teradata.py:11 `class TeradataParser(parser.Parser)`. */
export class TeradataParser extends Parser {
  static TABLESAMPLE_CSV = true;
  static VALUES_FOLLOWED_BY_PAREN = false;

  /** py:15-18 */
  static TABLE_ALIAS_TOKENS = setUnion(Parser.TABLE_ALIAS_TOKENS, new Set([TokenType.ANTI, TokenType.SEMI]));

  /** py:20-53 */
  static CHARSET_TRANSLATORS = new Set([
    "GRAPHIC_TO_KANJISJIS",
    "GRAPHIC_TO_LATIN",
    "GRAPHIC_TO_UNICODE",
    "GRAPHIC_TO_UNICODE_PadSpace",
    "KANJI1_KanjiEBCDIC_TO_UNICODE",
    "KANJI1_KanjiEUC_TO_UNICODE",
    "KANJI1_KANJISJIS_TO_UNICODE",
    "KANJI1_SBC_TO_UNICODE",
    "KANJISJIS_TO_GRAPHIC",
    "KANJISJIS_TO_LATIN",
    "KANJISJIS_TO_UNICODE",
    "LATIN_TO_GRAPHIC",
    "LATIN_TO_KANJISJIS",
    "LATIN_TO_UNICODE",
    "LOCALE_TO_UNICODE",
    "UNICODE_TO_GRAPHIC",
    "UNICODE_TO_GRAPHIC_PadGraphic",
    "UNICODE_TO_GRAPHIC_VarGraphic",
    "UNICODE_TO_KANJI1_KanjiEBCDIC",
    "UNICODE_TO_KANJI1_KanjiEUC",
    "UNICODE_TO_KANJI1_KANJISJIS",
    "UNICODE_TO_KANJI1_SBC",
    "UNICODE_TO_KANJISJIS",
    "UNICODE_TO_LATIN",
    "UNICODE_TO_LOCALE",
    "UNICODE_TO_UNICODE_FoldSpace",
    "UNICODE_TO_UNICODE_Fullwidth",
    "UNICODE_TO_UNICODE_Halfwidth",
    "UNICODE_TO_UNICODE_NFC",
    "UNICODE_TO_UNICODE_NFD",
    "UNICODE_TO_UNICODE_NFKC",
    "UNICODE_TO_UNICODE_NFKD",
  ]);

  /** py:55 */
  static FUNC_TOKENS = setDiff(Parser.FUNC_TOKENS, new Set([TokenType.REPLACE]));

  /** py:57-64 */
  static STATEMENT_PARSERS = new Map([
    ...Parser.STATEMENT_PARSERS,
    [TokenType.DATABASE, (self) => self.expression(new exp.Use({ this: self._parse_table(false) }))],
    [TokenType.REPLACE, (self) => self._parse_create()],
    [TokenType.LOCK, (self) => self._parse_locking_statement()],
  ]);

  /** py:66-76 */
  _parse_locking_statement() {
    // Reuse exp.LockingProperty parsing for the lock kind, type etc
    const locking_property = this._parse_locking();
    const wrapped_query = this._parse_select();

    if (!wrapped_query) this.raise_error("Expected SELECT statement after LOCKING clause");

    return this.expression(new exp.LockingStatement({ this: locking_property, expression: wrapped_query }));
  }

  /** py:78-81 */
  static SET_PARSERS = new Map([
    ...Parser.SET_PARSERS,
    ["QUERY_BAND", (self) => self._parse_query_band()],
  ]);

  /** py:83 */
  static SET_TRIE = newTrie([...this.SET_PARSERS.keys()].map((key) => key.split(" ")));

  /** py:85-91 */
  static FUNCTION_PARSERS = new Map([
    ...Parser.FUNCTION_PARSERS,
    // https://docs.teradata.com/r/SQL-Functions-Operators-Exprs-and-Predicates/June-2017/Data-Type-Conversions/TRYCAST
    ["TRYCAST", Parser.FUNCTION_PARSERS.get("TRY_CAST")],
    ["RANGE_N", (self) => self._parse_rangen()],
    ["TRANSLATE", (self) => self._parse_translate()],
  ]);

  /** py:93-97 */
  static FUNCTIONS = new Map([
    ...Parser.FUNCTIONS,
    ["CARDINALITY", exp.ArraySize.from_arg_list],
    ["RANDOM", (args) => new exp.Rand({ lower: seqGet(args, 0), upper: seqGet(args, 1) })],
  ]);

  /** py:99-101 */
  static EXPONENT = new Map([[TokenType.DSTAR, exp.Pow]]);

  /** py:103-114 */
  _parse_translate() {
    const this_ = this._parse_assignment();
    this._match(TokenType.USING);
    this._match_texts(this.constructor.CHARSET_TRANSLATORS);

    return this.expression(
      new exp.TranslateCharacters({
        this: this_,
        expression: this._prev.text.toUpperCase(),
        with_error: this._match_text_seq("WITH", "ERROR"),
      }),
    );
  }

  /**
   * py:116-126. FROM before SET in Teradata UPDATE syntax
   * https://docs.teradata.com/r/Enterprise_IntelliFlex_VMware/Teradata-VantageTM-SQL-Data-Manipulation-Language-17.20/Statement-Syntax/UPDATE/UPDATE-Syntax-Basic-Form-FROM-Clause
   */
  _parse_update() {
    return this.expression(
      new exp.Update({
        this: this._parse_table(false, false, this.constructor.UPDATE_ALIAS_TOKENS),
        from_: this._parse_from(true),
        expressions: this._match(TokenType.SET) && this._parse_csv(() => this._parse_equality()),
        where: this._parse_where(),
      }),
    );
  }

  /** py:128-135 */
  _parse_rangen() {
    const this_ = this._parse_id_var();
    this._match(TokenType.BETWEEN);

    const expressions = this._parse_csv(() => this._parse_assignment());
    const each = this._match_text_seq("EACH") && this._parse_assignment();

    return this.expression(new exp.RangeN({ this: this_, expressions, each }));
  }

  /** py:137-160 */
  _parse_query_band() {
    // Parse: SET QUERY_BAND = 'key=value;key2=value2;' FOR SESSION|TRANSACTION
    // Also supports: SET QUERY_BAND = 'key=value;' UPDATE FOR SESSION|TRANSACTION
    // Also supports: SET QUERY_BAND = NONE FOR SESSION|TRANSACTION
    this._match(TokenType.EQ);

    // Handle both string literals and NONE keyword
    let query_band_string;
    if (this._match_text_seq("NONE")) query_band_string = new exp.Var({ this: "NONE" });
    else query_band_string = this._parse_string();

    const update = this._match_text_seq("UPDATE");
    this._match_text_seq("FOR");

    // Handle scope - can be SESSION, TRANSACTION, VOLATILE, or SESSION VOLATILE
    let scope;
    if (this._match_text_seq("SESSION", "VOLATILE")) scope = "SESSION VOLATILE";
    else if (this._match_texts(["SESSION", "TRANSACTION"])) scope = this._prev.text.toUpperCase();
    else scope = null;

    return this.expression(new exp.QueryBand({ this: query_band_string, scope, update }));
  }

  /** py:162-168 */
  _parse_index_params() {
    const this_ = super._parse_index_params();

    if (this_.args.on) {
      this_.set("on", null);
      this._retreat(this._index - 2);
    }
    return this_;
  }

  /**
   * py:170-194
   *
   * Teradata uses a `(FORMAT <format_string>)` clause after column references to
   * override the output format. When we see this pattern we do not
   * parse it as a function call. The syntax is documented at
   * https://docs.teradata.com/r/Enterprise_IntelliFlex_VMware/SQL-Data-Types-and-Literals/Data-Type-Formats-and-Format-Phrases/FORMAT
   */
  _parse_function(functions = null, anonymous = false, optional_parens = true, any_token = false) {
    if (
      this._next &&
      this._next.token_type === TokenType.L_PAREN &&
      this._index + 2 < this._tokens.length &&
      this._tokens[this._index + 2].token_type === TokenType.FORMAT
    ) {
      return null;
    }

    return super._parse_function(functions, anonymous, optional_parens, any_token);
  }

  /** py:196-207 */
  _parse_column_ops(this_) {
    this_ = super._parse_column_ops(this_);

    if (this._match_pair(TokenType.L_PAREN, TokenType.FORMAT)) {
      // `(FORMAT <format_string>)` after a column specifies a Teradata format override.
      // See https://docs.teradata.com/r/Enterprise_IntelliFlex_VMware/SQL-Data-Types-and-Literals/Data-Type-Formats-and-Format-Phrases/FORMAT
      const fmt_string = this._parse_string();
      this._match_r_paren();

      this_ = this.expression(new exp.FormatPhrase({ this: this_, format: fmt_string }));
    }

    return this_;
  }
}
