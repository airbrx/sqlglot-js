// py: sqlglot/jsonpath.py @ 91119bc
//
// Greenfield whole-file port: the JSONPath tokenizer, the recursive-descent `parse()`
// entry point, and the generator-side `JSON_PATH_PART_TRANSFORMS` table the ten
// `JSONPath*` expression classes dispatch through. Those classes themselves are not
// defined here — `src/_gen/expr_meta.js` already generates all ten (`traits:
// ["JSONPathPart"]`), seeded before this module existed.
//
// CIRCULAR-IMPORT NOTE (R32/R76/R82's hazard, same shape here): `dialects/dialect.js`
// imports `JSONPathTokenizer`/`parse` (as `parse_json_path`) FROM this file (for
// `Dialect.jsonpath_tokenizer_class`/`to_json_path`), so this file must not import
// `dialects/dialect.js` at module level — that would close a real two-directional
// cycle. `parse()` needs `Dialect.get_or_raise(dialect)` (py: a function-level `from
// sqlglot.dialects import Dialect` import, for the identical reason), so it goes
// through the SAME injected relay `tokens.js`'s own `Tokenizer.__init__` already
// established and `optimizer/canonicalize.js` already reuses: `getDialectResolver()`,
// called from inside the function body (after every module has finished loading),
// never at module-evaluation time.
//
// `generator.js` imports `JSON_PATH_PART_TRANSFORMS` from here for its own `TRANSFORMS`
// table's `**JSON_PATH_PART_TRANSFORMS` spread (R21's "ten entries, not one" note) —
// safe, since this file does not import `generator.js` back.

import * as exp from "./expressions/index.js";
import { ParseError } from "./errors.js";
import { PyValueError } from "./_py/errors.js";
import { pyIntFromStr } from "./_py/num.js";
import { cpSlice } from "./_py/str.js";
import { Tokenizer, TokenType, initTokenizerSubclass, getDialectResolver } from "./tokens.js";

/** py: sqlglot/jsonpath.py:14 `class JSONPathTokenizer(Tokenizer)`. */
export class JSONPathTokenizer extends Tokenizer {
  static SINGLE_TOKENS = new Map([
    ["(", TokenType.L_PAREN],
    [")", TokenType.R_PAREN],
    ["[", TokenType.L_BRACKET],
    ["]", TokenType.R_BRACKET],
    [":", TokenType.COLON],
    [",", TokenType.COMMA],
    ["-", TokenType.DASH],
    [".", TokenType.DOT],
    ["?", TokenType.PLACEHOLDER],
    ["@", TokenType.PARAMETER],
    ["'", TokenType.QUOTE],
    ['"', TokenType.QUOTE],
    ["$", TokenType.DOLLAR],
    ["*", TokenType.STAR],
  ]);

  static KEYWORDS = new Map([[ "..", TokenType.DOT ]]);

  static IDENTIFIER_ESCAPES = ["\\"];
  static STRING_ESCAPES = ["\\"];
  static NUMBERS_CAN_HAVE_DECIMALS = false;

  static VAR_TOKENS = new Set([TokenType.VAR]);
}
initTokenizerSubclass(JSONPathTokenizer);

/**
 * py: sqlglot/jsonpath.py:45 `parse(path, dialect=None)`.
 *
 * Takes in a JSON path string and parses it into a JSONPath expression.
 * @param {string} path
 * @param {*} [dialect]
 * @returns {exp.JSONPath}
 */
export function parse(path, dialect = null) {
  const resolveDialect = getDialectResolver();
  if (!resolveDialect) {
    throw new Error(
      "jsonpath.parse: the dialect registry is not installed yet. " +
        "dialects/dialect.js calls setDialectResolver() once at module load.",
    );
  }
  const dialect_inst = resolveDialect(dialect);
  const jsonpath_tokenizer = dialect_inst.jsonpath_tokenizer();
  const VAR_TOKENS = jsonpath_tokenizer.constructor.VAR_TOKENS;
  const { tokens } = jsonpath_tokenizer.tokenize(path);
  const size = tokens.length;

  let i = 0;

  const _curr = () => (i < size ? tokens[i].token_type : null);
  const _prev = () => tokens[i - 1];
  const _advance = () => {
    i += 1;
    return _prev();
  };
  const _error = (msg) => `${msg} at index ${i}: ${path}`;

  const _match = (token_type, raise_unmatched = false) => {
    if (_curr() === token_type) return _advance();
    if (raise_unmatched) throw new ParseError(_error(`Expected ${token_type}`));
    return null;
  };

  const _match_set = (types) => (types.has(_curr()) ? _advance() : null);

  const _parse_literal = () => {
    const token = _match(TokenType.STRING) || _match(TokenType.IDENTIFIER);
    if (token) return token.text;
    if (_match(TokenType.STAR)) return new exp.JSONPathWildcard();
    if (_match(TokenType.PLACEHOLDER) || _match(TokenType.L_PAREN)) {
      const script = _prev().text === "(";
      const start = i;

      while (true) {
        if (_match(TokenType.L_BRACKET)) _parse_bracket(); // nested call which we can throw away
        if (_curr() === TokenType.R_BRACKET || _curr() === null) break;
        _advance();
      }

      const expr_type = script ? exp.JSONPathScript : exp.JSONPathFilter;
      const end = i < size ? tokens[i].end : tokens[size - 1].end;
      // `this` here is always a plain substring of `path` (never an Expr) — this is
      // the one construction site feeding the `JSONPathScript`/`JSONPathFilter`
      // `deny:implicit_str` markers below, which guarantees it.
      return new expr_type({ this: cpSlice(path, tokens[start].start, end) });
    }

    let number = _match(TokenType.DASH) ? "-" : "";

    const number_token = _match(TokenType.NUMBER);
    if (number_token) number += number_token.text;

    if (number) {
      // py: `int(number)` — raises ValueError (NOT ParseError) for the single
      // malformed case this can reach, a lone "-" with no digit after it. Faithfully
      // uncaught here: `to_json_path`'s caller only catches `ParseError`.
      const parsed = pyIntFromStr(number);
      if (parsed === null) {
        throw new PyValueError(`invalid literal for int() with base 10: '${number}'`);
      }
      return Number(parsed);
    }

    return false;
  };

  const _parse_slice = () => {
    const start = _parse_literal();
    const end = _match(TokenType.COLON) ? _parse_literal() : null;
    const step = _match(TokenType.COLON) ? _parse_literal() : null;

    if (end === null && step === null) return start;

    return new exp.JSONPathSlice({ start, end, step });
  };

  const _parse_bracket = () => {
    let literal = _parse_slice();
    let node;

    if (typeof literal === "string" || literal !== false) {
      const indexes = [literal];
      while (_match(TokenType.COMMA)) {
        literal = _parse_slice();

        if (typeof literal === "string" || literal !== false) {
          indexes.push(literal);
        }
      }

      if (indexes.length === 1) {
        if (typeof indexes[0] === "string") {
          node = new exp.JSONPathKey({ this: indexes[0] });
        } else if (
          indexes[0] instanceof exp.JSONPathPart
          && (indexes[0] instanceof exp.JSONPathScript || indexes[0] instanceof exp.JSONPathFilter)
        ) {
          node = new exp.JSONPathSelector({ this: indexes[0] });
        } else {
          node = new exp.JSONPathSubscript({ this: indexes[0] });
        }
      } else {
        node = new exp.JSONPathUnion({ expressions: indexes });
      }
    } else {
      throw new ParseError(_error("Cannot have empty segment"));
    }

    _match(TokenType.R_BRACKET, true);

    return node;
  };

  /**
   * Consumes & returns the text for a var. In BigQuery it's valid to have a key with
   * spaces in it, e.g `JSON_QUERY(..., '$. a b c ')` should produce a single
   * `JSONPathKey(' a b c ')`. This is done by merging "consecutive" vars until a key
   * separator is found (dot, colon etc) or the path string is exhausted.
   */
  const _parse_var_text = () => {
    const prev_index = i - 2;

    while (_match_set(VAR_TOKENS)) {
      // consume
    }

    const start = prev_index < 0 ? 0 : tokens[prev_index].end + 1;

    // py: `path[start:]` when the key is the last token for the path, so its text is
    // the remaining path; otherwise `path[start:tokens[i].start]`.
    return i >= tokens.length ? cpSlice(path, start) : cpSlice(path, start, tokens[i].start);
  };

  // We canonicalize the JSON path AST so that it always starts with a
  // "root" element, so paths like "field" will be generated as "$.field"
  _match(TokenType.DOLLAR);
  const expressions = [new exp.JSONPathRoot()];

  while (_curr()) {
    if (_match(TokenType.DOT) || _match(TokenType.COLON)) {
      const recursive = _prev().text === "..";

      let value;
      if (_match_set(VAR_TOKENS)) {
        value = _parse_var_text();
      } else if (_match(TokenType.IDENTIFIER)) {
        value = _prev().text;
      } else if (_match(TokenType.STAR)) {
        value = new exp.JSONPathWildcard();
      } else {
        value = null;
      }

      if (recursive) {
        expressions.push(new exp.JSONPathRecursive({ this: value }));
      } else if (value) {
        expressions.push(new exp.JSONPathKey({ this: value }));
      } else if (!dialect_inst.JSON_PATH_SINGLE_DOT_IS_WILDCARD) {
        throw new ParseError(_error("Expected key name or * after DOT"));
      }
    } else if (_match(TokenType.L_BRACKET)) {
      expressions.push(_parse_bracket());
    } else if (_match_set(VAR_TOKENS)) {
      expressions.push(new exp.JSONPathKey({ this: _parse_var_text() }));
    } else if (_match(TokenType.IDENTIFIER)) {
      expressions.push(new exp.JSONPathKey({ this: _prev().text }));
    } else if (_match(TokenType.STAR)) {
      expressions.push(new exp.JSONPathWildcard());
    } else {
      throw new ParseError(_error(`Unexpected ${tokens[i].token_type}`));
    }
  }

  return new exp.JSONPath({ expressions });
}

/**
 * py: sqlglot/jsonpath.py:219 `JSON_PATH_PART_TRANSFORMS`.
 *
 * The generator-side dispatch table for the ten `JSONPathPart` expression classes.
 * `generator.js`'s own `Generator.TRANSFORMS` spreads this in whole (R21's "ten
 * entries, not one" note).
 */
export const JSON_PATH_PART_TRANSFORMS = new Map([
  // deny:implicit_str sqlglot/jsonpath.py:220 — `e.this` is always a plain string at
  // this class's one construction site in `parse()` above (the script/filter branch
  // of `_parse_literal`), never an Expr, so direct interpolation is safe.
  [exp.JSONPathFilter, (_self, e) => `?${e.this}`],
  [exp.JSONPathKey, (self, e) => self._jsonpathkey_sql(e)],
  // deny:implicit_str sqlglot/jsonpath.py:222 — UNLIKE Filter/Script above, `this` CAN
  // be an `exp.JSONPathWildcard()` instance here (the `_match(TokenType.STAR)` branch
  // in `parse()`'s main loop), so the Python f-string's implicit `__str__` -> `.sql()`
  // call is reproduced explicitly: a bare template-literal interpolation would call
  // this port's `toString()` instead, which is `__repr__`'s equivalent, not `.sql()`.
  [exp.JSONPathRecursive, (_self, e) => `..${e.this ? (typeof e.this === "string" ? e.this : e.this.sql()) : ""}`],
  [exp.JSONPathRoot, () => "$"],
  // deny:implicit_str sqlglot/jsonpath.py:224 — same plain-string guarantee as Filter.
  [exp.JSONPathScript, (_self, e) => `(${e.this}`],
  [exp.JSONPathSelector, (self, e) => `[${self.json_path_part(e.this)}]`],
  [
    exp.JSONPathSlice,
    (self, e) =>
      [e.args.start, e.args.end, e.args.step]
        .filter((p) => p !== null)
        .map((p) => (p === false ? "" : self.json_path_part(p)))
        .join(":"),
  ],
  [exp.JSONPathSubscript, (self, e) => self._jsonpathsubscript_sql(e)],
  [exp.JSONPathUnion, (self, e) => `[${e.expressions.map((p) => self.json_path_part(p)).join(",")}]`],
  [exp.JSONPathWildcard, () => "*"],
]);

/** py: sqlglot/jsonpath.py:238 `ALL_JSON_PATH_PARTS = set(JSON_PATH_PART_TRANSFORMS)`. */
export const ALL_JSON_PATH_PARTS = new Set(JSON_PATH_PART_TRANSFORMS.keys());
