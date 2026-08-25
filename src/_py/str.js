// py: Objects/unicodeobject.c — Python str classification predicates.
//
// PORT_PLAN.md §4.6 "Strings". These are *string* methods, not code-point
// predicates: the per-code-point tables in _gen/unicode.js are necessary but not
// sufficient, because CPython's str.islower()/isupper() additionally require at
// least one cased character and reject strings containing the opposite case.
//
// Iteration is over CODE POINTS (for..of), never UTF-16 units, so astral
// characters are classified once rather than twice as surrogate halves.

import {
  isPrintable,
  isLowercase,
  isUppercase,
  isSpace,
  isTitlecase,
  isAlnum,
  isIdentifierStart,
  isDigit,
  upperCodePoint,
} from "../_gen/unicode.js";
import { PyValueError, PyTypeError } from "./errors.js";
// No cycle: num.js imports from _gen/unicode.js, never from this module.
import { pyFloatToStr, pyIntToStr } from "./num.js";

// py: unicode_isprintable_impl — the empty string is printable.
export function pyIsPrintable(s) {
  for (const ch of s) {
    if (!isPrintable(ch.codePointAt(0))) return false;
  }
  return true;
}

// py: unicode_islower_impl
//   - a single cased char shortcuts
//   - any upper/title char => False
//   - requires at least one cased char
export function pyIsLower(s) {
  let cased = false;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (isUppercase(cp) || isTitlecase(cp)) return false;
    if (!cased && isLowercase(cp)) cased = true;
  }
  return cased;
}

// py: unicode_isupper_impl
export function pyIsUpper(s) {
  let cased = false;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (isLowercase(cp) || isTitlecase(cp)) return false;
    if (!cased && isUppercase(cp)) cased = true;
  }
  return cased;
}

// py: unicode_isspace_impl — the empty string is NOT space.
export function pyIsSpace(s) {
  let any = false;
  for (const ch of s) {
    if (!isSpace(ch.codePointAt(0))) return false;
    any = true;
  }
  return any;
}

// py: unicode_isalnum_impl — the empty string is NOT alnum.
// Reached from tokenizer_core.py:741/748 (`_advance(alnum=True)`), which decides how
// far a comment, var or quoted value scan runs — i.e. token boundaries.
export function pyIsAlnum(s) {
  let any = false;
  for (const ch of s) {
    if (!isAlnum(ch.codePointAt(0))) return false;
    any = true;
  }
  return any;
}

// py: unicode_isdigit_impl — the empty string is NOT a digit string.
export function pyIsDigit(s) {
  let any = false;
  for (const ch of s) {
    if (!isDigit(ch.codePointAt(0))) return false;
    any = true;
  }
  return any;
}

/**
 * py: str.isidentifier() restricted to a SINGLE code point.
 *
 * tokenizer_core.py:970 is the only caller in scope and it passes `self._peek`, which
 * is exactly one code point or `""`. The full multi-character rule (first code point
 * XID_Start-or-'_', the rest XID_Continue) is deliberately NOT implemented: writing an
 * unused, untested branch of a Unicode predicate is how the wrong one ends up called
 * later. Throws rather than guessing if handed a longer string.
 */
export function pyIsIdentifierChar(s) {
  const a = [...s];
  if (a.length === 0) return false;
  if (a.length > 1) {
    throw new PyValueError("pyIsIdentifierChar: single code point only (see _py/str.js)");
  }
  return isIdentifierStart(a[0].codePointAt(0));
}

/**
 * py: str.upper()
 *
 * NOT `String.prototype.toUpperCase()`. Same hazard as a runtime Unicode property
 * escape: JS case conversion is bound to the *engine's* Unicode version, and Node v22
 * (Unicode 16.0) disagrees with CPython 3.9.25 (unicodedata 13.0.0) on 67 code
 * points — see the count printed by spike/verify_unicode_tables.mjs. The mapping is
 * one-to-many — `'ß'.upper() === 'SS'`, `'ﬆ'.upper() === 'ST'`, so `'ﬆRUCT'` uppercases
 * to `'STRUCT'` and tokenizes as `TokenType.STRUCT`.
 *
 * Output-visible: tokenizer_core.py:853 emits `text=word.upper()` for matched keywords.
 */
export function pyUpper(s) {
  let out = "";
  for (const ch of s) {
    const mapped = upperCodePoint(ch.codePointAt(0));
    out += mapped === null ? ch : mapped;
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * code-point indexing (PORT_PLAN.md §4.2, §4.6 "Indexing")                    *
 * ------------------------------------------------------------------------- */

/**
 * py: len(str) — number of CODE POINTS, not UTF-16 units.
 * §4.2 requires this instead of `.length` inside generator.js and time.js.
 */
export function cpLen(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // Count a well-formed surrogate pair as one code point.
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** Code-point array for a string. py: list(s) */
export function cpArray(s) {
  return [...s];
}

/* ------------------------------------------------------------------------- *
 * strip / zfill                                                              *
 * ------------------------------------------------------------------------- */

// Default predicate: Python's str.strip() with no argument strips str.isspace().
function stripPred(chars) {
  if (chars === undefined || chars === null) return (cp) => isSpace(cp);
  const set = new Set([...chars].map((c) => c.codePointAt(0)));
  return (cp) => set.has(cp);
}

// py: str.lstrip([chars])
export function pyLstrip(s, chars) {
  const pred = stripPred(chars);
  const a = [...s];
  let i = 0;
  while (i < a.length && pred(a[i].codePointAt(0))) i++;
  return a.slice(i).join("");
}

// py: str.rstrip([chars])
export function pyRstrip(s, chars) {
  const pred = stripPred(chars);
  const a = [...s];
  let j = a.length;
  while (j > 0 && pred(a[j - 1].codePointAt(0))) j--;
  return a.slice(0, j).join("");
}

// py: str.strip([chars])
export function pyStrip(s, chars) {
  return pyRstrip(pyLstrip(s, chars), chars);
}

// py: str.zfill(width) — left-pads with '0', moving a leading sign to the front.
export function pyZfill(s, width) {
  const a = [...s];
  if (a.length >= width) return s;
  const fill = width - a.length;
  let out = "0".repeat(fill) + s;
  if (a.length && (a[0] === "+" || a[0] === "-")) {
    // py: move sign to beginning of string
    out = a[0] + "0".repeat(fill) + a.slice(1).join("");
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * builtins added by review B (PORT_PLAN.md §4.6) — all corpus-invisible       *
 * ------------------------------------------------------------------------- */

// py: len(s.encode("utf-8"))
//
// `parsers/clickhouse.py:63` does `len(sep_value.encode("utf-8")) == 1`. Corpus
// coverage is `splitByChar('', x)` only, so a `.length` port passes every atom and
// still turns `splitByChar('é', x)` into `Split` instead of `Anonymous`.
//
// Note this is NOT `new TextEncoder().encode(s).length`: that substitutes U+FFFD
// (3 bytes) for a lone surrogate, whereas Python raises UnicodeEncodeError.
export function utf8Len(s) {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xd800 && cp <= 0xdfff) {
      throw new PyValueError(
        `'utf-8' codec can't encode character '\\ud${cp.toString(16)}' in position 0: surrogates not allowed`,
      );
    }
    if (cp < 0x80) n += 1;
    else if (cp < 0x800) n += 2;
    else if (cp < 0x10000) n += 3;
    else n += 4;
  }
  return n;
}

// py: chr(i)
//
// `generators/singlestore.py:25` does `chr(int(m.group(1), 16))`.
// `String.fromCharCode` truncates above 0xFFFF and is deny-listed outright.
// Python's chr() also accepts lone surrogates, which fromCodePoint handles.
export function pyChr(cp) {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) {
    throw new PyValueError("chr() arg not in range(0x110000)");
  }
  return String.fromCodePoint(cp);
}

// py: ord(c) — code point of a single-character string.
export function pyOrd(s) {
  const a = [...s];
  if (a.length !== 1) {
    throw new PyTypeError(`ord() expected a character, but string of length ${a.length} found`);
  }
  return a[0].codePointAt(0);
}

// py: f"{n:0{width}d}"
//
// `parsers/dremio.py:65` does `f"{int(year.this):04d}-..."`. `padStart` puts the
// zeros before the sign (`0-01`); Python puts the sign first (`-001`).
export function pyFormatInt(n, width) {
  const neg = typeof n === "bigint" ? n < 0n : n < 0;
  const digits = (neg ? -n : n).toString();
  const sign = neg ? "-" : "";
  const pad = Math.max(0, width - digits.length - sign.length);
  return sign + "0".repeat(pad) + digits;
}

/* ------------------------------------------------------------------------- *
 * repr                                                                       *
 * ------------------------------------------------------------------------- */

// py: Objects/unicodeobject.c unicode_repr
//
// Quote selection: single quotes, unless the string contains ' and no ".
// Printability is decided by the generated table, NOT by \p{...}.
export function pyReprStr(s) {
  let quote = "'";
  if (s.includes("'") && !s.includes('"')) quote = '"';

  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === quote || ch === "\\") out += "\\" + ch;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (cp < 0x20 || cp === 0x7f) out += "\\x" + cp.toString(16).padStart(2, "0");
    else if (cp < 0x7f) out += ch;
    else if (!isPrintable(cp)) {
      if (cp <= 0xff) out += "\\x" + cp.toString(16).padStart(2, "0");
      else if (cp <= 0xffff) out += "\\u" + cp.toString(16).padStart(4, "0");
      else out += "\\U" + cp.toString(16).padStart(8, "0");
    } else out += ch;
  }
  return out + quote;
}

/**
 * py: repr(v) for the value kinds sqlglot renders into error and warning messages
 * (§4.6 "Strings": list/tuple/set/dict rendering).
 *
 * Containers are tagged rather than guessed: JS cannot distinguish a Python list
 * from a tuple, so pass `{__tuple__: [...]}` / `Set` / `Map` explicitly.
 */
export function pyRepr(v) {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "string") return pyReprStr(v);
  // BigInt models a Python int (repr has no '.0'); Number models a Python float.
  if (typeof v === "bigint") return pyIntToStr(v);
  if (typeof v === "number") return pyFloatToStr(v);
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (v instanceof Set) {
    // py: an empty set reprs as `set()`, not `{}` — `{}` is an empty dict.
    if (v.size === 0) return "set()";
    return "{" + [...v].map(pyRepr).join(", ") + "}";
  }
  if (v instanceof Map) {
    return "{" + [...v].map(([k, val]) => `${pyRepr(k)}: ${pyRepr(val)}`).join(", ") + "}";
  }
  if (typeof v === "object" && Array.isArray(v.__tuple__)) {
    const items = v.__tuple__;
    if (items.length === 1) return `(${pyRepr(items[0])},)`;
    return "(" + items.map(pyRepr).join(", ") + ")";
  }
  if (typeof v === "object") {
    return (
      "{" +
      Object.entries(v)
        .map(([k, val]) => `${pyReprStr(k)}: ${pyRepr(val)}`)
        .join(", ") +
      "}"
    );
  }
  return String(v);
}

export {
  isPrintable,
  isLowercase,
  isUppercase,
  isSpace,
  isTitlecase,
  isAlnum,
  isIdentifierStart,
  isDigit,
};
