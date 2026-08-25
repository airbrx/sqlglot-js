// py: Objects/unicodeobject.c — Python str classification predicates.
//
// PORT_PLAN.md §4.6 "Strings". These are *string* methods, not code-point
// predicates: the per-code-point tables in _gen/unicode.js are necessary but not
// sufficient, because CPython's str.islower()/isupper() additionally require at
// least one cased character and reject strings containing the opposite case.
//
// Iteration is over CODE POINTS (for..of), never UTF-16 units, so astral
// characters are classified once rather than twice as surrogate halves.

import { isPrintable, isLowercase, isUppercase, isSpace, isTitlecase } from "../_gen/unicode.js";

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

export { isPrintable, isLowercase, isUppercase, isSpace, isTitlecase };
