// py: (Python builtins + CPython Lib/_pydecimal.py) — Python numeric semantics shim
//
// Scope, per PORT_PLAN.md §4.6 ("Numeric") and §9 Appendix B5: this is NOT a general
// CPython `decimal` clone. It covers exactly the reachable operation set — `+ - * /`,
// unary negation, comparison, and `str()` — across the ~63 Decimal invocations in
// sqlglot's dialect suite, plus Python's `str(float)` / `str(int)` reprs.
//
// The load-bearing case (PORT_PLAN.md §7 P4 exit, tests/dialects/test_snowflake.py:367):
//
//   exp.Literal.number(-9223372036854775808.0)  ->  Neg(Literal('9.223372036854776E+18'))
//   exp.Literal.number( 9223372036854775807.0)  ->      Literal('9.223372036854776e+18')
//
// The casing differs because expressions/core.py:1755 `Literal.number` renders the
// positive value with `str(float)` (lowercase 'e', 2-digit zero-padded exponent) but
// re-renders the negative one through `str(abs(Decimal(...)))` (uppercase 'E',
// unpadded signed exponent). Both functions must be byte-exact.

import { isSpace, decimalValue } from "../_gen/unicode.js";

/* ------------------------------------------------------------------------- *
 * float                                                                      *
 * ------------------------------------------------------------------------- */

// py: CPython Python/pystrtod.c format_float_short(), mode 'r' (repr)
//
// Python and JS both emit the *shortest* decimal string that round-trips, so the
// digits agree; only the *formatting* around them differs. We therefore take JS's
// shortest digits from `toExponential()` and re-format them under Python's rules
// rather than reimplementing Grisu/Ryu.
//
// Divergences from JS `String(x)` that this function exists to fix:
//   1. exponential threshold: Python at decpt > 16 / decpt <= -4; JS at 1e21 / 1e-7
//   2. integral floats: Python appends '.0'   (`1.0`   vs JS `1`)
//   3. exponent padding:  Python pads to 2    (`1e-05` vs JS `1e-7`)
//   4. negative zero:     Python `-0.0`       (JS `0`)
//   5. non-finite:        Python `inf`/`-inf`/`nan` (JS `Infinity`/`NaN`)
export function pyFloatToStr(x) {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";

  const neg = x < 0;
  const a = neg ? -x : x;

  // Shortest round-tripping significand + exponent. ECMA-262 specifies that
  // toExponential() with no argument uses "the number of digits necessary to
  // uniquely specify the Number value".
  const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(a.toExponential());
  const digits = m[1] + (m[2] || "");
  // value === 0.<digits> * 10**decpt, matching CPython's `decpt`.
  const decpt = parseInt(m[3], 10) + 1;

  let s;
  if (decpt <= -4 || decpt > 16) {
    const frac = digits.slice(1);
    s = digits[0] + (frac ? "." + frac : "") + "e" + floatExpStr(decpt - 1);
  } else if (decpt <= 0) {
    s = "0." + "0".repeat(-decpt) + digits;
  } else if (decpt >= digits.length) {
    // integral value: Py_DTSF_ADD_DOT_0
    s = digits + "0".repeat(decpt - digits.length) + ".0";
  } else {
    s = digits.slice(0, decpt) + "." + digits.slice(decpt);
  }
  return neg ? "-" + s : s;
}

// Python float exponents carry a sign and are zero-padded to >= 2 digits.
function floatExpStr(e) {
  const av = Math.abs(e);
  return (e < 0 ? "-" : "+") + (av < 10 ? "0" + av : String(av));
}

/* ------------------------------------------------------------------------- *
 * int                                                                        *
 * ------------------------------------------------------------------------- */

// py: str(int) — arbitrary precision, so BigInt.
export function pyIntToStr(n) {
  return String(n);
}

/* ------------------------------------------------------------------------- *
 * Decimal                                                                    *
 * ------------------------------------------------------------------------- */

// py: Lib/_pydecimal.py — default context
export const DEFAULT_PREC = 28;
const ROUND_HALF_EVEN = "ROUND_HALF_EVEN";

const NAN = "nan";
const INF = "inf";

// py: _pydecimal.Decimal — (sign, coefficient digit-string, exponent) triple.
// The digit string is kept as a string (not BigInt) because `len(self._int)` and
// prefix slicing drive rounding, exactly as upstream.
export class PyDecimal {
  constructor(sign, intDigits, exp, special = null) {
    this._sign = sign; // 0 | 1
    this._int = intDigits; // digit string, no leading zeros (except "0")
    this._exp = exp; // number
    this._special = special; // null | "inf" | "nan"
  }

  get isSpecial() {
    return this._special !== null;
  }

  // py: Decimal.__bool__ — a Decimal is falsy iff its coefficient is zero.
  isZero() {
    return !this.isSpecial && this._int === "0";
  }

  // py: Decimal.adjusted()
  adjusted() {
    return this._exp + this._int.length - 1;
  }

  copyNegate() {
    return new PyDecimal(this._sign ? 0 : 1, this._int, this._exp, this._special);
  }

  copyAbs() {
    return new PyDecimal(0, this._int, this._exp, this._special);
  }

  get coeff() {
    return BigInt(this._int);
  }

  // py: Decimal.__str__ (to-scientific-string), with context.capitals = 1
  toString() {
    if (this.isSpecial) {
      const sign = this._sign ? "-" : "";
      return this._special === INF ? sign + "Infinity" : sign + "NaN";
    }
    const sign = this._sign ? "-" : "";
    const leftdigits = this._exp + this._int.length;

    let dotplace;
    if (this._exp <= 0 && leftdigits > -6) {
      dotplace = leftdigits; // no exponent required
    } else {
      dotplace = 1; // usual scientific notation: 1 digit left of the point
    }

    let intpart, fracpart;
    if (dotplace <= 0) {
      intpart = "0";
      fracpart = "." + "0".repeat(-dotplace) + this._int;
    } else if (dotplace >= this._int.length) {
      intpart = this._int + "0".repeat(dotplace - this._int.length);
      fracpart = "";
    } else {
      intpart = this._int.slice(0, dotplace);
      fracpart = "." + this._int.slice(dotplace);
    }

    let expPart;
    if (leftdigits === dotplace) {
      expPart = "";
    } else {
      // "%+d" — signed, and NOT zero-padded (unlike float repr).
      const e = leftdigits - dotplace;
      expPart = "E" + (e >= 0 ? "+" : "-") + Math.abs(e);
    }
    return sign + intpart + fracpart + expPart;
  }
}

// py: _dec_from_triple — does not normalize leading zeros.
function decFromTriple(sign, coeff, exp) {
  return new PyDecimal(sign, coeff, exp);
}

function decFromBig(sign, coeff, exp) {
  return new PyDecimal(sign, String(coeff), exp);
}

// py: _pydecimal.Decimal.__new__ (string branch)
const DEC_RE =
  /^[ \t\n\r\f\v]*([-+])?(?:(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([-+]?\d+))?|(inf(?:inity)?)|((?:s)?nan)(\d*))[ \t\n\r\f\v]*$/i;

export function pyDecimal(value) {
  if (value instanceof PyDecimal) return value;
  if (typeof value === "bigint") {
    return value < 0n ? decFromBig(1, -value, 0) : decFromBig(0, value, 0);
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return pyDecimal(BigInt(value));
  }
  const s = String(value).replace(/_/g, "");
  const m = DEC_RE.exec(s);
  if (!m) throw new Error(`InvalidOperation: ${JSON.stringify(String(value))}`);

  // Capture groups: 1 sign, 2 int, 3 frac-after-int, 4 frac-after-dot,
  //                 5 exponent, 6 inf, 7 nan, 8 nan-payload
  const sign = m[1] === "-" ? 1 : 0;
  if (m[7] !== undefined) return new PyDecimal(sign, m[8] || "", 0, NAN);
  if (m[6] !== undefined) return new PyDecimal(sign, "0", 0, INF);

  let intpart = m[2];
  let fracpart;
  if (intpart !== undefined) {
    fracpart = m[3] || "";
  } else {
    intpart = "";
    fracpart = m[4];
  }
  const rawExp = m[5] === undefined ? 0 : parseInt(m[5], 10);

  // py: self._int = str(int(intpart + fracpart)) — strips leading zeros
  const digits = String(BigInt(intpart + fracpart || "0"));
  return new PyDecimal(sign, digits, rawExp - fracpart.length);
}

/* ---- rounding ----------------------------------------------------------- */

function allZeros(s, prec) {
  for (let i = prec; i < s.length; i++) if (s[i] !== "0") return false;
  return true;
}

function exactHalf(s, prec) {
  if (s[prec] !== "5") return false;
  return allZeros(s, prec + 1);
}

// py: Decimal._round_half_up -> 1 (increment) | -1 | 0 (exact)
function roundHalfUp(d, prec) {
  const c = d._int[prec];
  if (c !== undefined && "56789".includes(c)) return 1;
  if (allZeros(d._int, prec)) return 0;
  return -1;
}

// py: Decimal._round_half_even
function roundHalfEven(d, prec) {
  if (exactHalf(d._int, prec) && (prec === 0 || "02468".includes(d._int[prec - 1]))) {
    return -1;
  }
  return roundHalfUp(d, prec);
}

function pickRounding(rounding) {
  if (rounding !== ROUND_HALF_EVEN) throw new Error(`unsupported rounding ${rounding}`);
  return roundHalfEven;
}

/* ---- context ------------------------------------------------------------ */

// py: Decimal._fix(context). Emin/Emax are +-999999 in the default context, which is
// far outside anything sqlglot can reach, so the subnormal/overflow branches are
// deliberately omitted (they would be dead code, and §4.2 forbids inventing behaviour).
function fix(d, prec = DEFAULT_PREC) {
  if (d.isSpecial) return d;
  if (d.isZero()) return d;

  const expMin = d._int.length + d._exp - prec;
  if (d._exp < expMin) {
    let self = d;
    let digits = self._int.length + self._exp - expMin;
    let expMinAdj = expMin;
    if (digits < 0) {
      self = decFromTriple(self._sign, "1", expMinAdj - 1);
      digits = 0;
    }
    const changed = pickRounding(ROUND_HALF_EVEN)(self, digits);
    let coeff = self._int.slice(0, digits) || "0";
    if (changed > 0) {
      coeff = String(BigInt(coeff) + 1n);
      if (coeff.length > prec) {
        coeff = coeff.slice(0, -1);
        expMinAdj += 1;
      }
    }
    return decFromTriple(self._sign, coeff, expMinAdj);
  }
  return d;
}

// py: Decimal._rescale
function rescale(d, exp, rounding = ROUND_HALF_EVEN) {
  if (d.isSpecial) return d;
  if (d.isZero()) return decFromTriple(d._sign, "0", exp);
  if (d._exp >= exp) {
    return decFromTriple(d._sign, d._int + "0".repeat(d._exp - exp), exp);
  }
  let self = d;
  let digits = self._int.length + self._exp - exp;
  if (digits < 0) {
    self = decFromTriple(self._sign, "1", exp - 1);
    digits = 0;
  }
  const changed = pickRounding(rounding)(self, digits);
  let coeff = self._int.slice(0, digits) || "0";
  if (changed === 1) coeff = String(BigInt(coeff) + 1n);
  return decFromTriple(self._sign, coeff, exp);
}

/* ---- _WorkRep / _normalize --------------------------------------------- */

// py: _pydecimal._WorkRep
function workRep(d) {
  return { sign: d._sign, int: d.coeff, exp: d._exp };
}

// py: _pydecimal._normalize
function normalize(op1, op2, prec) {
  let tmp, other;
  if (op1.exp < op2.exp) {
    tmp = op2;
    other = op1;
  } else {
    tmp = op1;
    other = op2;
  }
  const tmpLen = String(tmp.int).length;
  const otherLen = String(other.int).length;
  const exp = tmp.exp + Math.min(-1, tmpLen - prec - 2);
  if (otherLen + other.exp - 1 < exp) {
    other.int = 1n;
    other.exp = exp;
  }
  tmp.int *= 10n ** BigInt(tmp.exp - other.exp);
  tmp.exp = other.exp;
  return [op1, op2];
}

/* ---- arithmetic --------------------------------------------------------- */

// py: Decimal.__add__
export function decAdd(a, b, prec = DEFAULT_PREC) {
  a = pyDecimal(a);
  b = pyDecimal(b);
  if (a.isSpecial || b.isSpecial) return specialAdd(a, b);

  let exp = Math.min(a._exp, b._exp);

  if (a.isZero() && b.isZero()) {
    const sign = Math.min(a._sign, b._sign);
    return fix(decFromTriple(sign, "0", exp), prec);
  }
  if (a.isZero()) {
    exp = Math.max(exp, b._exp - prec - 1);
    return fix(rescale(b, exp), prec);
  }
  if (b.isZero()) {
    exp = Math.max(exp, a._exp - prec - 1);
    return fix(rescale(a, exp), prec);
  }

  let op1 = workRep(a);
  let op2 = workRep(b);
  [op1, op2] = normalize(op1, op2, prec);

  let resultSign;
  if (op1.sign !== op2.sign) {
    if (op1.int === op2.int) {
      return fix(decFromTriple(0, "0", exp), prec);
    }
    if (op1.int < op2.int) {
      const t = op1;
      op1 = op2;
      op2 = t;
    }
    if (op1.sign === 1) {
      resultSign = 1;
      const s = op1.sign;
      op1.sign = op2.sign;
      op2.sign = s;
    } else {
      resultSign = 0;
    }
  } else if (op1.sign === 1) {
    resultSign = 1;
    op1.sign = 0;
    op2.sign = 0;
  } else {
    resultSign = 0;
  }

  const resultInt = op2.sign === 0 ? op1.int + op2.int : op1.int - op2.int;
  return fix(decFromBig(resultSign, resultInt, op1.exp), prec);
}

// py: Decimal.__sub__ -> self + (-other)
export function decSub(a, b, prec = DEFAULT_PREC) {
  a = pyDecimal(a);
  b = pyDecimal(b);
  if (a.isSpecial || b.isSpecial) return specialAdd(a, b.copyNegate());
  return decAdd(a, b.copyNegate(), prec);
}

// py: Decimal.__mul__
export function decMul(a, b, prec = DEFAULT_PREC) {
  a = pyDecimal(a);
  b = pyDecimal(b);
  const resultSign = a._sign ^ b._sign;
  if (a.isSpecial || b.isSpecial) return specialMul(a, b, resultSign);

  const resultExp = a._exp + b._exp;
  if (a.isZero() || b.isZero()) {
    return fix(decFromTriple(resultSign, "0", resultExp), prec);
  }
  return fix(decFromBig(resultSign, a.coeff * b.coeff, resultExp), prec);
}

// py: Decimal.__truediv__
export function decDiv(a, b, prec = DEFAULT_PREC) {
  a = pyDecimal(a);
  b = pyDecimal(b);
  const sign = a._sign ^ b._sign;

  if (a.isSpecial || b.isSpecial) return specialDiv(a, b, sign);
  if (b.isZero()) {
    if (a.isZero()) throw new Error("InvalidOperation: 0 / 0");
    throw new Error("DivisionByZero");
  }
  if (a.isZero()) {
    return fix(decFromTriple(sign, "0", a._exp - b._exp), prec);
  }

  const shift = b._int.length - a._int.length + prec + 1;
  let exp = a._exp - b._exp - shift;
  let coeff, remainder;
  if (shift >= 0) {
    const num = a.coeff * 10n ** BigInt(shift);
    coeff = num / b.coeff;
    remainder = num % b.coeff;
  } else {
    const den = b.coeff * 10n ** BigInt(-shift);
    coeff = a.coeff / den;
    remainder = a.coeff % den;
  }

  if (remainder !== 0n) {
    // result is not exact; adjust to ensure correct rounding
    if (coeff % 5n === 0n) coeff += 1n;
  } else {
    // result is exact; get as close to ideal exponent as possible
    const idealExp = a._exp - b._exp;
    while (exp < idealExp && coeff % 10n === 0n) {
      coeff /= 10n;
      exp += 1;
    }
  }
  return fix(decFromBig(sign, coeff, exp), prec);
}

// py: Decimal.__neg__ — note that -Decimal('0') is Decimal('0'), not '-0'.
export function decNeg(a, prec = DEFAULT_PREC) {
  a = pyDecimal(a);
  if (a.isSpecial) return a.copyNegate();
  const ans = a.isZero() ? a.copyAbs() : a.copyNegate();
  return fix(ans, prec);
}

// py: Decimal.__abs__ (round=True path) — abs(x) is -x if x is negative, else +x
export function decAbs(a, prec = DEFAULT_PREC) {
  a = pyDecimal(a);
  if (a._sign) return decNeg(a, prec);
  if (a.isSpecial) return a.copyAbs();
  return fix(a.copyAbs(), prec);
}

// py: Decimal._cmp — returns -1 | 0 | 1
export function decCmp(a, b) {
  a = pyDecimal(a);
  b = pyDecimal(b);
  if (a.isSpecial || b.isSpecial) {
    if (a._special === NAN || b._special === NAN) return NaN;
    const av = a._special === INF ? (a._sign ? -1 : 1) : 0;
    const bv = b._special === INF ? (b._sign ? -1 : 1) : 0;
    if (av !== 0 || bv !== 0) return av < bv ? -1 : av > bv ? 1 : 0;
  }

  if (a.isZero()) {
    if (b.isZero()) return 0;
    return -(b._sign ? -1 : 1);
  }
  if (b.isZero()) return a._sign ? -1 : 1;

  if (b._sign < a._sign) return -1;
  if (a._sign < b._sign) return 1;

  const aAdj = a.adjusted();
  const bAdj = b.adjusted();
  const s = a._sign ? -1 : 1;
  if (aAdj === bAdj) {
    const aPad = BigInt(a._int + "0".repeat(Math.max(0, a._exp - b._exp)));
    const bPad = BigInt(b._int + "0".repeat(Math.max(0, b._exp - a._exp)));
    if (aPad === bPad) return 0;
    return aPad < bPad ? -s : s;
  }
  return aAdj > bAdj ? s : -s;
}

/* ---- special-value plumbing (minimal; sqlglot cannot reach most of it) --- */

function specialAdd(a, b) {
  if (a._special === NAN) return a;
  if (b._special === NAN) return b;
  if (a._special === INF && b._special === INF && a._sign !== b._sign) {
    throw new Error("InvalidOperation: -INF + INF");
  }
  if (a._special === INF) return a;
  return b;
}

function specialMul(a, b, sign) {
  if (a._special === NAN) return a;
  if (b._special === NAN) return b;
  if (a._special === INF) {
    if (b.isZero()) throw new Error("InvalidOperation: (+-)INF * 0");
    return new PyDecimal(sign, "0", 0, INF);
  }
  if (a.isZero()) throw new Error("InvalidOperation: 0 * (+-)INF");
  return new PyDecimal(sign, "0", 0, INF);
}

function specialDiv(a, b, sign) {
  if (a._special === NAN) return a;
  if (b._special === NAN) return b;
  if (a._special === INF && b._special === INF) {
    throw new Error("InvalidOperation: (+-)INF/(+-)INF");
  }
  if (a._special === INF) return new PyDecimal(sign, "0", 0, INF);
  return decFromTriple(sign, "0", 0);
}

/* ------------------------------------------------------------------------- *
 * int(str) / float(str) — helper.py:244-257 is_int / is_float / is_type       *
 * ------------------------------------------------------------------------- */

// py: Objects/unicodeobject.c _PyUnicode_TransformDecimalAndSpaceToASCII
//
// Both int() and float() run their argument through this before parsing, which is
// why `int('٢٠٢٣') == 2023` and why a non-breaking space behaves like a plain
// space (and so still fails *inside* a number). Note the `ch < 127` short-circuit
// comes FIRST, so ASCII passes through untouched.
function transformDecimalAndSpaceToAscii(s) {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp < 127) {
      out += ch;
      continue;
    }
    if (isSpace(cp)) {
      out += " ";
      continue;
    }
    const d = decimalValue(cp);
    out += d < 0 ? "?" : String(d);
  }
  return out;
}

// py: underscores are permitted only BETWEEN digits ('1_000' ok; '_1', '1_', '1__0' not).
function stripValidUnderscores(s) {
  if (!s.includes("_")) return s;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "_") continue;
    const prev = s[i - 1];
    const next = s[i + 1];
    const isDigit = (c) => c !== undefined && c >= "0" && c <= "9";
    if (!isDigit(prev) || !isDigit(next)) return null;
  }
  return s.replace(/_/g, "");
}

const INT_RE = /^[+-]?[0-9]+$/;
const FLOAT_RE = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
const INF_NAN_RE = /^([+-]?)(inf(?:inity)?|nan)$/i;

/**
 * py: int(text) — returns a BigInt, or null where Python raises ValueError.
 * Accepts surrounding whitespace, a sign, Unicode decimal digits, and
 * underscores between digits.
 */
export function pyIntFromStr(text) {
  const t = stripValidUnderscores(transformDecimalAndSpaceToAscii(text).trim());
  if (t === null || !INT_RE.test(t)) return null;
  return BigInt(t);
}

/** py: float(text) — returns a Number, or null where Python raises ValueError. */
export function pyFloatFromStr(text) {
  const t = stripValidUnderscores(transformDecimalAndSpaceToAscii(text).trim());
  if (t === null) return null;
  const m = INF_NAN_RE.exec(t);
  if (m) {
    if (m[2].toLowerCase() === "nan") return NaN;
    return m[1] === "-" ? -Infinity : Infinity;
  }
  if (!FLOAT_RE.test(t)) return null;
  return Number(t);
}

/** py: helper.is_int */
export function pyIsInt(text) {
  return pyIntFromStr(text) !== null;
}

/** py: helper.is_float */
export function pyIsFloat(text) {
  return pyFloatFromStr(text) !== null;
}

/* ------------------------------------------------------------------------- *
 * expressions/core.py:1755 Literal.number — the go/no-go path                *
 * ------------------------------------------------------------------------- */

// py: sqlglot/expressions/core.py:1755
//
// Returns the rendered literal text plus whether upstream wraps it in `Neg`.
// This is the exact composition the E+18/e+18 assertion depends on.
export function literalNumberText(value) {
  // py: lit = cls(this=str(number), is_string=False)
  const text =
    typeof value === "bigint"
      ? pyIntToStr(value)
      : typeof value === "number"
        ? pyFloatToStr(value)
        : String(value);

  // py: to_py = lit.to_py()  ->  int(this), falling back to Decimal(this)
  let toPy;
  try {
    toPy = /^[-+]?\d+$/.test(text.trim()) ? BigInt(text) : pyDecimal(text);
  } catch {
    return { text, neg: false };
  }

  const isNeg = typeof toPy === "bigint" ? toPy < 0n : decCmp(toPy, pyDecimal("0")) < 0;
  if (!isNeg) return { text, neg: false };

  // py: lit.set("this", str(abs(to_py))); return Neg(this=lit)
  const absText = typeof toPy === "bigint" ? pyIntToStr(-toPy) : decAbs(toPy).toString();
  return { text: absText, neg: true };
}
