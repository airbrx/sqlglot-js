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

export { isPrintable, isLowercase, isUppercase, isSpace, isTitlecase };
