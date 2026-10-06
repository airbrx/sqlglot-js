// py: sqlglot/anonymize.py @ 91119bc
//
// `anonymize()`/`render()` replace sensitive tokens (identifiers, strings, numbers)
// with fixed-width, length-preserving aliases, and blank out comments/hint bodies.
// NOT a cryptographic hash: there is no `hash()`/`hashlib` anywhere in this module —
// the "deterministic naming scheme" is a plain base-26 counter (`_alias`) or a
// counter-derived same-width digit string (`_number_alias`), both reproduced exactly
// below with no approximation needed.
//
// `Token.start`/`Token.end` are CODE-POINT offsets into the source SQL (per
// tokenizer_core.js's own `Token` docstring), so every index into `sql` here is
// taken through `cpSlice`/`cpArray`/`cpLen` (§4.2/§4.6) rather than raw JS string
// indexing — a plain `.slice()`/`.indexOf()` would silently misalign the moment the
// SQL contains an astral character (outside the BMP), which none of upstream's own
// `tests/test_anonymize.py` assertions happen to exercise but is otherwise the same
// R4 "too_wide" class this port has repeatedly found and fixed elsewhere.

import { Dialect } from "./dialects/dialect.js";
import { TokenError } from "./errors.js";
import { Token, TokenType } from "./tokens.js";
import { pyUpper, pyIsSpace, pyIsDigit, pyRjust, pyPartition, pyStartswith, cpLen, cpSlice, cpArray } from "./_py/str.js";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";
const ALPHABET_SIZE = ALPHABET.length;

const ANONYMIZED_TYPES = new Set([
  TokenType.BIT_STRING,
  TokenType.BYTE_STRING,
  TokenType.HEX_STRING,
  TokenType.HEREDOC_STRING,
  TokenType.IDENTIFIER,
  TokenType.NATIONAL_STRING,
  TokenType.NUMBER,
  TokenType.RAW_STRING,
  TokenType.STRING,
  TokenType.UNICODE_STRING,
  TokenType.VAR,
]);
const QUOTED_TYPES = new Set(
  [...ANONYMIZED_TYPES].filter((t) => t !== TokenType.NUMBER && t !== TokenType.VAR),
);
const REWRITTEN_TYPES = new Set([TokenType.HINT, TokenType.UNKNOWN]);

/**
 * py: anonymize.py:29 `anonymize(sql_or_tokens, dialect=None)`.
 *
 * Replaces sensitive tokens (identifiers, strings, numbers) with fixed-width,
 * length-preserving, consistent aliases, and blanks out comments and hint bodies.
 * When a SQL string is given, it is tokenized with `dialect` first; any
 * un-tokenized remainder (e.g. an unterminated literal) is appended as a blanked
 * UNKNOWN token. Mutates and returns `sqlOrTokens`.
 *
 * @param {Token[]|string} sqlOrTokens
 * @param {string|import("./dialects/dialect.js").Dialect|null} [dialect]
 * @returns {Token[]}
 */
export function anonymize(sqlOrTokens, dialect = null) {
  const dialectInst = Dialect.get_or_raise(dialect);
  const tokenizer_class = dialectInst.tokenizer_class;
  const parser_class = dialectInst.parser_class;

  let errored = false;
  let tokens, sql;
  if (typeof sqlOrTokens === "string") {
    sql = sqlOrTokens;
    const tokenizer = dialectInst.tokenizer();
    try {
      ({ tokens } = tokenizer.tokenize(sql));
    } catch (e) {
      if (!(e instanceof TokenError)) throw e;
      tokens = tokenizer.tokens;
      errored = true;
    }
  } else {
    tokens = sqlOrTokens;
    sql = null;
  }

  const hint_start = tokenizer_class.HINT_START;
  const hint_end = tokenizer_class._COMMENTS.get(hint_start);
  const nested = tokenizer_class.NESTED_COMMENTS;

  // py: `seen: dict[tuple[bool, str], str]`. Two Maps instead of one Map keyed by a
  // concatenated string: a NUL-joined key would risk a (vanishingly unlikely but
  // real) collision between a NUMBER and a STRING whose text happens to contain the
  // separator, and `test_number_and_string_same_text_stay_distinct` exists precisely
  // to pin that the two namespaces never merge.
  const seenNumber = new Map();
  const seenOther = new Map();
  let counter = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    token.comments = token.comments.map((comment) => _blank(comment));

    if (token.token_type === TokenType.HINT) {
      // A hint's text is the whole /*+ ... */ comment, so its body is blanked as well
      const [text, stop] = _blank_comment(token.text, 0, hint_start, hint_end, nested);
      token.text = text + _blank(cpSlice(token.text, stop));
      continue;
    }

    if (
      token.token_type === TokenType.VAR &&
      i + 1 < tokens.length &&
      tokens[i + 1].token_type === TokenType.L_PAREN
    ) {
      // A function name can live in either registry, e.g. JSON_OBJECT is only in
      // FUNCTION_PARSERS. They're consulted separately to avoid building their union
      const name = pyUpper(token.text);
      if (parser_class.FUNCTIONS.has(name) || parser_class.FUNCTION_PARSERS.has(name)) continue;
    }
    if (!ANONYMIZED_TYPES.has(token.token_type)) continue;
    if (!token.text) continue;

    const is_number = token.token_type === TokenType.NUMBER;
    const seen = is_number ? seenNumber : seenOther;
    let alias = seen.get(token.text);
    if (alias === undefined) {
      alias = is_number ? _number_alias(counter, token.text) : _alias(counter, token.text);
      seen.set(token.text, alias);
      counter += 1;
    }
    token.text = alias;
  }

  if (sql !== null && errored) {
    const cps = cpArray(sql);
    let start = tokens.length ? tokens[tokens.length - 1].end + 1 : 0;
    const length = cps.length;
    while (start < length && pyIsSpace(cps[start])) start += 1;
    if (start < length) {
      let newlineCount = 0;
      for (let k = 0; k < start; k++) if (cps[k] === "\n") newlineCount++;
      const lastNl = _cpRfind(cps, "\n", 0, start);
      // The first two characters are kept so that the delimiter the tokenizer choked
      // on is still visible, e.g. 'u, /*, $$, `u
      tokens.push(
        new Token(
          TokenType.UNKNOWN,
          cps.slice(start, start + 2).join("") + ".".repeat(Math.max(0, length - start - 2)),
          newlineCount + 1,
          start - lastNl,
          start,
          length - 1,
        ),
      );
    }
  }

  return tokens;
}

/**
 * py: anonymize.py:123 `render(sql, tokens, dialect=None)`.
 *
 * Recreates the (anonymized) SQL string from the original `sql` and token positions.
 * Every token is rendered over its own source span, so the result is always as long
 * as `sql`: a token that wasn't anonymized is emitted verbatim, keeping the spelling
 * the tokenizer normalized away, and an anonymized one has its alias fitted between
 * the quotes of its span. The gaps between tokens hold only whitespace and comments,
 * so they're redacted rather than reconstructed: comment markers and whitespace
 * survive, everything else is blanked. That covers anything the tokenizer didn't
 * reach as well, which is a trailing gap whenever `anonymize` wasn't the one to
 * tokenize `sql`.
 *
 * @param {string} sql
 * @param {Token[]} tokens
 * @param {string|import("./dialects/dialect.js").Dialect|null} [dialect]
 * @returns {string}
 */
export function render(sql, tokens, dialect = null) {
  const tokenizer_class = Dialect.get_or_raise(dialect).tokenizer_class;
  const comments = [...tokenizer_class._COMMENTS.entries()].sort(
    (a, b) => cpLen(b[0]) - cpLen(a[0]),
  );
  const nested = tokenizer_class.NESTED_COMMENTS;

  // py: `{**tokenizer_class._QUOTES, **{start: end for start, (end, _) in
  // tokenizer_class._FORMAT_STRINGS.items()}, **tokenizer_class._IDENTIFIERS}` — a
  // `Map.set` on an already-present key, like a dict-merge `**`, overwrites the value
  // without moving the key, so this reproduces the 3-way merge's insertion order.
  const merged = new Map(tokenizer_class._QUOTES);
  for (const [start, pair] of tokenizer_class._FORMAT_STRINGS) merged.set(start, pair[0]);
  for (const [start, end] of tokenizer_class._IDENTIFIERS) merged.set(start, end);
  const quotes = [...merged.entries()].sort(
    (a, b) => cpLen(b[0]) - cpLen(a[0]) || cpLen(b[1]) - cpLen(a[1]),
  );

  const result = [];
  let prev = 0;

  for (const token of tokens) {
    result.push(_redact(cpSlice(sql, prev, token.start), comments, nested));
    prev = token.end + 1;
    const span = cpSlice(sql, token.start, prev);
    if (REWRITTEN_TYPES.has(token.token_type)) {
      // Blanked in place by `anonymize`, or synthesized by it, so already span-shaped
      result.push(token.text);
    } else if (ANONYMIZED_TYPES.has(token.token_type)) {
      result.push(_fit(span, token.text, quotes, token.token_type));
    } else {
      result.push(span);
    }
  }

  result.push(_redact(cpSlice(sql, prev), comments, nested));

  return result.join("");
}

// py: anonymize.py:172 `_alias(counter, text)`.
function _alias(counter, text) {
  const digits = [];
  while (counter) {
    const digit = counter % ALPHABET_SIZE;
    counter = Math.floor(counter / ALPHABET_SIZE);
    digits.push(ALPHABET[digit]);
  }

  let nonSpaceCount = 0;
  for (const char of text) if (!pyIsSpace(char)) nonSpaceCount++;
  const letters = pyRjust(digits.reverse().join(""), nonSpaceCount, "a");

  let alias = "";
  let i = 0;
  for (const char of text) {
    if (pyIsSpace(char)) {
      alias += char;
    } else {
      alias += letters[i];
      i += 1;
    }
  }

  return alias;
}

// py: anonymize.py:192 `_number_alias(counter, text)`. `text` is always a NUMBER
// token's own text (digits, at most one of "." / "e" / "E" / a leading sign on the
// exponent) — always ASCII, so plain JS string ops are code-point-safe here without
// going through `cp*` helpers. `counter`/`digits`/`exponent_length` arithmetic uses
// BigInt, matching Python's arbitrary-precision `int` (`10 ** (digits - 1)` would
// lose precision past 2**53 as a plain JS Number once `digits` exceeds ~16).
function _number_alias(counter, text) {
  if (cpLen(text) > 4000) {
    let digits_seen = false;
    let blanked = "";
    for (const char of text) {
      if (pyIsDigit(char)) {
        blanked += digits_seen ? "0" : "1";
        digits_seen = true;
      } else {
        blanked += char;
      }
    }
    return blanked;
  }

  const sep = text.includes("e") ? "e" : text.includes("E") ? "E" : "";
  const [mantissa, , exponentRaw] = sep ? pyPartition(text, sep) : [text, "", ""];
  let sign = "";
  let exponent = exponentRaw;
  if (pyStartswith(exponent, ["-", "+"])) {
    sign = exponent[0];
    exponent = exponent.slice(1);
  }
  const exponent_length = exponent.length;

  const [integer, dot, fraction] = pyPartition(mantissa, ".");
  const integer_length = integer.length;
  const digits = integer_length + fraction.length;

  const counterBig = BigInt(counter);
  const base = 10n ** BigInt(digits - 1);
  const mantissa_value = base + (counterBig % (9n * base));
  let result = mantissa_value.toString();
  if (dot) {
    result = result.slice(0, integer_length) + "." + result.slice(integer_length);
  }
  if (sep) {
    // The exponent marker is kept even when there are no digits after it, e.g. 1e
    result += sep + sign;
    if (exponent_length) {
      const ebase = 10n ** BigInt(exponent_length - 1);
      const exponent_value = ebase + ((counterBig / (9n * base)) % (9n * ebase));
      result += exponent_value.toString();
    }
  }

  return result;
}

// py: anonymize.py:230 `_fit(span, alias, quotes, token_type)`. Fits `alias` into the
// quoted region of `span`, so the two are always the same length (in CODE POINTS).
function _fit(span, alias, quotes, token_type) {
  const cps = cpArray(span);
  let start = 0;
  let end = 0;

  if (QUOTED_TYPES.has(token_type)) {
    for (const [open_quote, close_quote] of quotes) {
      const oLen = cpLen(open_quote);
      const cLen = cpLen(close_quote);
      if (
        cps.length >= oLen + cLen &&
        _cpStartsWith(cps, 0, open_quote) &&
        _cpStartsWith(cps, cps.length - cLen, close_quote)
      ) {
        start = oLen;
        end = cLen;

        if (token_type === TokenType.HEREDOC_STRING) {
          // A heredoc's tag is part of its delimiter, e.g. $tag$body$tag$
          const open_end = _cpFind(cps, close_quote, start);
          const close_start = _cpRfind(cps, open_quote, 0, cps.length - end);
          if (start <= open_end && open_end < close_start) {
            start = open_end + cLen;
            end = cps.length - close_start;
          }
        }

        break;
      }
    }
  }

  const width = cps.length - start - end;
  const pad = token_type === TokenType.NUMBER ? "0" : "a";

  return (
    cps.slice(0, start).join("") +
    pyRjust(cpSlice(alias, 0, width), width, pad) +
    cps.slice(cps.length - end).join("")
  );
}

// py: anonymize.py:258 `_blank(sql)`.
function _blank(sql) {
  let out = "";
  for (const char of sql) out += pyIsSpace(char) ? char : ".";
  return out;
}

// py: anonymize.py:262 `_blank_comment(sql, i, start, end, nested)`. Blanks the body
// of the comment at code-point index `i`, returning its text and the code-point
// index past it.
function _blank_comment(sql, i, start, end, nested) {
  const cps = cpArray(sql);
  const body = i + cpLen(start);

  if (!end) {
    let stop = _cpFind(cps, "\n", body);
    stop = stop === -1 ? cps.length : stop;
    return [start + _blank(cps.slice(body, stop).join("")), stop];
  }

  let depth = 1;
  let j = body;
  while (j < cps.length) {
    if (nested && _cpStartsWith(cps, j, start)) {
      depth += 1;
      j += cpLen(start);
    } else if (_cpStartsWith(cps, j, end)) {
      j += cpLen(end);
      depth -= 1;
      if (depth === 0) {
        return [start + _blank(cps.slice(body, j - cpLen(end)).join("")) + end, j];
      }
    } else {
      j += 1;
    }
  }

  return [start + _blank(cps.slice(body).join("")), cps.length];
}

// py: anonymize.py:288 `_redact(sql, comments, nested)`.
function _redact(sql, comments, nested) {
  if (!sql || pyIsSpace(sql)) return sql;

  const cps = cpArray(sql);
  const result = [];
  let i = 0;
  const length = cps.length;

  while (i < length) {
    let matched = false;
    for (const [start, end] of comments) {
      if (_cpStartsWith(cps, i, start)) {
        const [text, next] = _blank_comment(sql, i, start, end, nested);
        result.push(text);
        i = next;
        matched = true;
        break;
      }
    }
    if (!matched) {
      const char = cps[i];
      result.push(pyIsSpace(char) ? char : ".");
      i += 1;
    }
  }

  return result.join("");
}

/* ------------------------------------------------------------------------- *
 * Internal code-point search helpers (not shared `_py/` shims: `.find()`/     *
 * `.startswith()`/`.rfind()` on a single-string needle are not py_builtins    *
 * deny sites here, but the *positions* they return must still be CODE POINT   *
 * offsets to line up with `Token.start`/`Token.end` and `span`'s own code-    *
 * point width — see this file's header note.                                 *
 * ------------------------------------------------------------------------- */

// Does `needle` occur in the code-point array `cps` starting exactly at `idx`?
function _cpStartsWith(cps, idx, needle) {
  if (idx < 0) return false;
  const needleArr = [...needle];
  if (idx + needleArr.length > cps.length) return false;
  for (let k = 0; k < needleArr.length; k++) {
    if (cps[idx + k] !== needleArr[k]) return false;
  }
  return true;
}

// py: str.find(needle, from) over a code-point array.
function _cpFind(cps, needle, from = 0) {
  const needleArr = [...needle];
  const n = needleArr.length;
  for (let idx = Math.max(from, 0); idx <= cps.length - n; idx++) {
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (cps[idx + k] !== needleArr[k]) {
        ok = false;
        break;
      }
    }
    if (ok) return idx;
  }
  return -1;
}

// py: str.rfind(needle, from, to) over a code-point array.
function _cpRfind(cps, needle, from = 0, to) {
  const needleArr = [...needle];
  const n = needleArr.length;
  const upper = (to === undefined ? cps.length : to) - n;
  for (let idx = upper; idx >= from; idx--) {
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (cps[idx + k] !== needleArr[k]) {
        ok = false;
        break;
      }
    }
    if (ok) return idx;
  }
  return -1;
}
