// py: `bool(x)` / the truth-value testing protocol (Python docs, "Truth Value Testing").
//
// WHY THIS EXISTS: JS `!x` and Python `not x` agree on `null`/`0`/`""`/`false` and
// disagree on every EMPTY CONTAINER. `not []` is True in Python; `![]` is false in JS.
// Upstream sqlglot leans on container falsiness constantly (`if not expressions`,
// `if not comments`, `if not this or retreat`), so a transliterated `!x` is right most
// of the time and silently wrong exactly when a parse produced nothing — the state a
// backtracking parser is built to detect.
//
// PR #6 review finding 2 is the concrete case: `_try_parse` restores the cursor when
// `not this`, and `parser.py:10382` passes it a `_parse_csv` lambda whose empty result
// is `[]`. The port's `!self` left the cursor advanced, so `_parse_as_command` quoted a
// different span of SQL than CPython — a byte-exact gated log line.
//
// Python's rules, in the order the interpreter applies them:
//   1. `__bool__`, if defined            -> its result
//   2. else `__len__`, if defined        -> len != 0
//   3. else                              -> True
// Numbers, strings and the builtin containers are just the standard implementations of
// those. Note `bool(float("nan"))` is True — NaN has no `__bool__`/`__len__`, so rule 3
// applies — where JS `!NaN` is `true`. That divergence is handled explicitly below.

import { PyTypeError } from "./errors.js";

/**
 * py: `bool(value)`.
 *
 * Use this — never bare `!x` / `if (x)` — wherever the upstream line being ported is a
 * truthiness test on something that is not statically known to be a Token, an Expr or
 * a plain boolean.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function pyTruthy(value) {
  // py: None
  if (value === null || value === undefined) return false;

  // py: bool
  if (typeof value === "boolean") return value;

  // py: int/float. NaN is TRUE in Python (no __bool__, no __len__ -> rule 3), which is
  // the opposite of JS coercion, so it cannot be left to `!!value`.
  if (typeof value === "number") return Number.isNaN(value) ? true : value !== 0;
  if (typeof value === "bigint") return value !== 0n;

  // py: str.__len__
  if (typeof value === "string") return value.length > 0;

  // py: list/tuple.__len__
  if (Array.isArray(value)) return value.length > 0;

  // py: set/frozenset/dict.__len__ for the containers this port uses to model them.
  if (value instanceof Map || value instanceof Set) return value.size > 0;

  if (typeof value === "function") return true;

  if (typeof value === "object") {
    // py: rule 1 — an explicit `__bool__`. `Token.__bool__` (tokenizer_core.py:523) is
    // the one that matters on the parse path: a SENTINEL token is falsy.
    if (typeof value.bool === "function") return value.bool() !== false;
    // py: rule 2 — `__len__`. `ExprSet`/`ExprMap` model Python containers keyed by
    // Expression, so their emptiness is their truth value.
    if (typeof value.size === "number") return value.size > 0;
    if (typeof value.length === "number") return value.length > 0;
    // py: a plain `{}` models a dict here (`expression.args` is one), and an empty dict
    // is falsy. A class instance is not a dict: `Expr` defines neither `__bool__` nor
    // `__len__`, so rule 3 makes every Expression truthy no matter how empty its args.
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) return Object.keys(value).length > 0;
    return true;
  }

  // Symbols and anything else this port does not model. Refuse rather than guess:
  // a wrong default here is invisible at the call site.
  throw new PyTypeError(`pyTruthy: unmodelled value of type ${typeof value}`);
}

/** py: `not value`. */
export function pyFalsy(value) {
  return !pyTruthy(value);
}
