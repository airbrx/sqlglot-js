// py: Modules/_datetimemodule.c (CPython 3.9) — fromisoformat parsing.
//
// PORT_PLAN.md §4.6 "Datetime" (review-B O1, the most serious finding in either
// review) and R6. `sqlglot/time.py:65` subsecond_precision and `helper.py:432/440`
// is_iso_date/is_iso_datetime all route through this, and the result reaches output
// SQL via dialect.py:1796 -> CAST(x AS TIMESTAMP(6)) vs CAST(x AS TIMESTAMP).
//
// IMPORTANT — implemented against the **C accelerator**, not Lib/datetime.py.
// The readable Python source parses components with Python's int(), which accepts
// leading whitespace, signs and non-ASCII decimal digits; the C implementation
// requires strict ASCII digits. `_datetime` is active by default, so the C
// behaviour is the observable one. Verified on CPython 3.9.25:
//
//   date.fromisoformat(' 023-01-01') -> ValueError   (pure Python would give year 23)
//   date.fromisoformat('٢٠٢٣-01-01') -> ValueError   (pure Python would give year 2023)
//
// The grammar is CPython 3.9's restricted subset — emphatically NOT ISO-8601 and
// NOT `new Date()`. 3.11+ accepts more (notably 'Z' and 1/2/4/5-digit fractions),
// which is exactly why corpus provenance pins the interpreter version.

import { PyValueError, PyTypeError } from "./errors.js";

export { PyValueError };

export const MINYEAR = 1;
export const MAXYEAR = 9999;

const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// py: datetime._is_leap
function isLeap(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

// py: datetime._days_in_month
function daysInMonth(year, month) {
  if (month === 2 && isLeap(year)) return 29;
  return DAYS_IN_MONTH[month];
}

// Strict ASCII-digit parse of exactly `n` chars starting at `pos`.
// py: parse_digits() in _datetimemodule.c
function parseDigits(s, pos, n) {
  if (pos + n > s.length) return -1;
  let value = 0;
  for (let i = pos; i < pos + n; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return -1;
    value = value * 10 + (c - 0x30);
  }
  return value;
}

// py: _parse_isoformat_date — assumes a string of length exactly 10.
function parseIsoformatDate(dtstr) {
  const year = parseDigits(dtstr, 0, 4);
  if (year < 0) throw new PyValueError("Invalid isoformat string");
  if (dtstr[4] !== "-") throw new PyValueError(`Invalid date separator: ${dtstr[4]}`);
  const month = parseDigits(dtstr, 5, 2);
  if (month < 0) throw new PyValueError("Invalid isoformat string");
  if (dtstr[7] !== "-") throw new PyValueError("Invalid date separator");
  const day = parseDigits(dtstr, 8, 2);
  if (day < 0) throw new PyValueError("Invalid isoformat string");
  return [year, month, day];
}

// py: date.__new__ range checks
function checkDateArgs(year, month, day) {
  if (year < MINYEAR || year > MAXYEAR) {
    throw new PyValueError(`year ${year} is out of range`);
  }
  if (month < 1 || month > 12) throw new PyValueError("month must be in 1..12");
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new PyValueError("day is out of range for month");
  }
}

// py: time.__new__ range checks
function checkTimeArgs(hour, minute, second, microsecond) {
  if (hour < 0 || hour > 23) throw new PyValueError("hour must be in 0..23");
  if (minute < 0 || minute > 59) throw new PyValueError("minute must be in 0..59");
  if (second < 0 || second > 59) throw new PyValueError("second must be in 0..59");
  if (microsecond < 0 || microsecond > 999999) {
    throw new PyValueError("microsecond must be in 0..999999");
  }
}

// Reading one past a slice bound is MEANINGFUL here: the C code walks a
// NUL-terminated buffer while `p_end` is only a slice boundary (usually the
// timezone position). So `*(p++)` at `p_end` yields the '+'/'-' when a timezone
// follows, and '\0' only at the true end of the string.
function charAt(cps, i) {
  return i < cps.length ? cps[i] : "\0";
}

// py: parse_digits(p, &val, n) — strict ASCII digits; returns [newP, value] or [null, 0].
function parseDigitsAt(cps, p, n) {
  let value = 0;
  for (let i = 0; i < n; i++) {
    const c = charAt(cps, p + i);
    if (c < "0" || c > "9") return [null, 0];
    value = value * 10 + (c.charCodeAt(0) - 0x30);
  }
  return [p + n, value];
}

// py: parse_hh_mm_ss_ff(tstr, tstr_end, ...) — _datetimemodule.c:740
//
// Returns {rv, hour, minute, second, microsecond} where rv is
//   0  success, string fully consumed
//   1  success, but there is trailing content (fatal ONLY when no timezone follows)
//  -3  failed to parse a time component
//  -4  malformed time separator
function parseHhMmSsFf(cps, start, end) {
  let p = start;
  const vals = [0, 0, 0];
  let microsecond = 0;

  // py: Parse [HH[:MM[:SS]]]
  for (let i = 0; i < 3; i++) {
    const [np, v] = parseDigitsAt(cps, p, 2);
    if (np === null) return { rv: -3 };
    vals[i] = v;
    p = np;

    const c = charAt(cps, p);
    p += 1;
    if (p >= end) {
      // py: return c != '\0'
      return {
        rv: c !== "\0" ? 1 : 0,
        hour: vals[0],
        minute: vals[1],
        second: vals[2],
        microsecond,
      };
    } else if (c === ":") {
      continue;
    } else if (c === ".") {
      break;
    } else {
      return { rv: -4 }; // Malformed time separator
    }
  }

  // py: Parse .fff[fff]
  const lenRemains = end - p;
  if (!(lenRemains === 6 || lenRemains === 3)) return { rv: -3 };
  const [np, v] = parseDigitsAt(cps, p, lenRemains);
  if (np === null) return { rv: -3 };
  microsecond = lenRemains === 3 ? v * 1000 : v;
  p = np;

  // py: Return 1 if it's not the end of the string
  return {
    rv: charAt(cps, p) !== "\0" ? 1 : 0,
    hour: vals[0],
    minute: vals[1],
    second: vals[2],
    microsecond,
  };
}

// py: parse_isoformat_time(dtstr, dtlen, ...) — _datetimemodule.c:789
//
// Returns {rv, hour, minute, second, microsecond, tzoffsetSec, tzMicro} where rv is
//   0 success without tz, 1 success with tz, negative on failure.
function parseIsoformatTime(cps) {
  const dtlen = cps.length;

  // py: scan FORWARD for the first '+' or '-'. Note this differs from
  // Lib/datetime.py, which searches for '-' anywhere first and only then '+'.
  // The do/while reads before testing the bound, so an empty input leaves
  // tzinfoPos == 1 > dtlen, which then fails digit parsing — matching C.
  let tzinfoPos = 0;
  do {
    const c = charAt(cps, tzinfoPos);
    if (c === "+" || c === "-") break;
  } while (++tzinfoPos < dtlen);

  const r = parseHhMmSsFf(cps, 0, tzinfoPos);
  if (r.rv < 0) return { rv: r.rv };

  if (tzinfoPos === dtlen) {
    // No timezone, so trailing content is an error.
    if (r.rv === 1) return { rv: -5 };
    return { ...r, rv: 0, tzoffsetSec: 0, tzMicro: 0 };
  }

  // py: valid tz forms are +HH:MM (6), +HH:MM:SS (9), +HH:MM:SS.ffffff (16),
  // measured INCLUDING the sign character.
  const tzlen = dtlen - tzinfoPos;
  if (!(tzlen === 6 || tzlen === 9 || tzlen === 16)) return { rv: -5 };

  const tzsign = cps[tzinfoPos] === "-" ? -1 : 1;
  const tzr = parseHhMmSsFf(cps, tzinfoPos + 1, dtlen);
  const tzoffsetSec = tzsign * (tzr.hour * 3600 + tzr.minute * 60 + tzr.second);
  const tzMicro = (tzr.microsecond ?? 0) * tzsign;

  // py: return rv ? -5 : 1  — any nonzero rv (including negatives) is -5.
  if (tzr.rv) return { rv: -5 };
  return { ...r, rv: 1, tzoffsetSec, tzMicro };
}

// py: new_timezone — offset must be strictly between -24h and 24h.
function checkTimezone(tzoffsetSec, tzMicro) {
  const totalMicros = tzoffsetSec * 1000000 + tzMicro;
  if (Math.abs(totalMicros) >= 86400000000) {
    throw new PyValueError("offset must be a timedelta strictly between -24h and 24h");
  }
  return totalMicros === 0 ? { offsetMicros: 0, utc: true } : { offsetMicros: totalMicros, utc: false };
}

/**
 * py: datetime.date.fromisoformat — accepts EXACTLY `YYYY-MM-DD` (length 10).
 * @returns {{year:number, month:number, day:number}}
 */
export function pyDateFromIsoFormat(dateString) {
  if (typeof dateString !== "string") {
    throw new PyTypeError("fromisoformat: argument must be str");
  }
  if (dateString.length !== 10) {
    throw new PyValueError(`Invalid isoformat string: ${JSON.stringify(dateString)}`);
  }
  const [year, month, day] = parseIsoformatDate(dateString);
  checkDateArgs(year, month, day);
  return { year, month, day };
}

/**
 * py: datetime.datetime.fromisoformat
 *
 * `YYYY-MM-DD` optionally followed by ANY single separator character and a time.
 * Note the separator is skipped by slicing, so `'2023-01-01-12:13:14'` parses:
 * dstr = s[0:10], tstr = s[11:].
 *
 * @returns {{year:number, month:number, day:number, hour:number, minute:number,
 *            second:number, microsecond:number, tz:{offsetMicros:number}|null}}
 */
export function pyDateTimeFromIsoFormat(dateString) {
  if (typeof dateString !== "string") {
    throw new PyTypeError("fromisoformat: argument must be str");
  }
  // Work in code points. The C code advances past the separator by its UTF-8
  // byte width (1-4 bytes), which is exactly "skip one code point".
  const cps = [...dateString];
  const invalid = () =>
    new PyValueError(`Invalid isoformat string: ${JSON.stringify(dateString)}`);

  if (cps.length < 10) throw invalid();

  let dateComponents;
  try {
    dateComponents = parseIsoformatDate(cps.slice(0, 10).join(""));
  } catch (e) {
    if (e instanceof PyValueError) throw invalid();
    throw e;
  }

  let hour = 0;
  let minute = 0;
  let second = 0;
  let microsecond = 0;
  let tz = null;

  // py: if (!rv && len > 10)
  if (cps.length > 10) {
    const t = parseIsoformatTime(cps.slice(11));
    if (t.rv < 0) throw invalid();
    hour = t.hour ?? 0;
    minute = t.minute ?? 0;
    second = t.second ?? 0;
    microsecond = t.microsecond ?? 0;
    if (t.rv === 1) tz = checkTimezone(t.tzoffsetSec, t.tzMicro);
  }

  const [year, month, day] = dateComponents;
  // py: new_datetime_subclass_ex validates ranges, and those ValueErrors are NOT
  // wrapped as 'Invalid isoformat string'.
  checkDateArgs(year, month, day);
  checkTimeArgs(hour, minute, second, microsecond);

  return { year, month, day, hour, minute, second, microsecond, tz };
}

/** True iff `pyDateFromIsoFormat` would succeed. py: helper.is_iso_date */
export function pyIsIsoDate(text) {
  try {
    pyDateFromIsoFormat(text);
    return true;
  } catch (e) {
    if (e instanceof PyValueError) return false;
    throw e;
  }
}

/** True iff `pyDateTimeFromIsoFormat` would succeed. py: helper.is_iso_datetime */
export function pyIsIsoDateTime(text) {
  try {
    pyDateTimeFromIsoFormat(text);
    return true;
  } catch (e) {
    if (e instanceof PyValueError) return false;
    throw e;
  }
}

// py: Lib/datetime.py's proleptic-Gregorian ordinal math (`_days_before_year`,
// `_days_before_month`, `_ymd2ord`, `_ord2ymd`) plus `dateutil.relativedelta`.
//
// `optimizer/simplify.py` needs real `date`/`datetime` VALUES (not just ISO-string
// parsing) for `cast_as_date`/`cast_as_datetime`/`datetime_floor`/`date_ceil`/the
// `dateutil.relativedelta.relativedelta` arithmetic `interval()`/`extract_interval()`
// depend on. Scoped narrowly to what those need: construction, `.replace()`,
// ordering/equality, `.weekday()` (for `datetime_floor`'s week truncation), and
// relativedelta's RELATIVE fields only (years/months/days/hours/minutes/seconds/
// microseconds) — no absolute year=/month=/day=.../weekday=/leapdays=/yearday=
// overrides, none of which `interval()` (py:448) ever constructs with.

// py: datetime._days_before_year
function daysBeforeYear(year) {
  const y = year - 1;
  return y * 365 + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400);
}

// py: datetime._days_before_month
function daysBeforeMonth(year, month) {
  const DAYS_BEFORE_MONTH = [-1, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  return DAYS_BEFORE_MONTH[month] + (month > 2 && isLeap(year) ? 1 : 0);
}

// py: datetime._ymd2ord
function ymd2ord(year, month, day) {
  return daysBeforeYear(year) + daysBeforeMonth(year, month) + day;
}

const DI400Y = daysBeforeYear(401);
const DI100Y = daysBeforeYear(101);
const DI4Y = daysBeforeYear(5);

// py: datetime._ord2ymd
function ord2ymd(n) {
  n -= 1;
  let n400 = Math.floor(n / DI400Y);
  n %= DI400Y;
  let year = n400 * 400 + 1;

  let n100 = Math.floor(n / DI100Y);
  n %= DI100Y;
  let n4 = Math.floor(n / DI4Y);
  n %= DI4Y;
  let n1 = Math.floor(n / 365);
  n %= 365;

  year += n100 * 100 + n4 * 4 + n1;
  if (n1 === 4 || n100 === 4) {
    return [year - 1, 12, 31];
  }

  let month = (n + 50) >> 5;
  let preceding = daysBeforeMonth(year, month);
  if (preceding > n) {
    month -= 1;
    preceding -= daysInMonth(year, month);
  }
  n -= preceding;
  return [year, month, n + 1];
}

/**
 * py: datetime.date — the subset `optimizer/simplify.py` needs: construction with
 * range checks, `.replace()`, `.weekday()`, ordinal-based ordering/equality.
 */
export class PyDate {
  constructor(year, month, day) {
    checkDateArgs(year, month, day);
    this.year = year;
    this.month = month;
    this.day = day;
  }

  static fromOrdinal(n) {
    const [year, month, day] = ord2ymd(n);
    return new PyDate(year, month, day);
  }

  toOrdinal() {
    return ymd2ord(this.year, this.month, this.day);
  }

  // py: date.weekday() — Monday=0 .. Sunday=6.
  weekday() {
    return (this.toOrdinal() + 6) % 7;
  }

  replace(fields = {}) {
    return new PyDate(
      fields.year ?? this.year,
      fields.month ?? this.month,
      fields.day ?? this.day,
    );
  }

  // py: date + timedelta(days=...) restricted to whole-day deltas, which is all a
  // bare `PyDate` (no time-of-day) ever needs.
  addDays(days) {
    return PyDate.fromOrdinal(this.toOrdinal() + days);
  }

  equals(other) {
    return other instanceof PyDate && !(other instanceof PyDateTime)
      && this.year === other.year && this.month === other.month && this.day === other.day;
  }

  // Total order key for same-kind comparison (`pyCmp` in `_py/sort.js`).
  get compareKey() {
    return this.toOrdinal();
  }

  toISODate() {
    return `${String(this.year).padStart(4, "0")}-${String(this.month).padStart(2, "0")}-${String(this.day).padStart(2, "0")}`;
  }
}

/** py: datetime.datetime — `PyDate` plus a time-of-day. */
export class PyDateTime extends PyDate {
  constructor(year, month, day, hour = 0, minute = 0, second = 0, microsecond = 0) {
    super(year, month, day);
    checkTimeArgs(hour, minute, second, microsecond);
    this.hour = hour;
    this.minute = minute;
    this.second = second;
    this.microsecond = microsecond;
  }

  static fromOrdinal(n) {
    const [year, month, day] = ord2ymd(n);
    return new PyDateTime(year, month, day, 0, 0, 0, 0);
  }

  // py: datetime.date() — drop the time-of-day.
  date() {
    return new PyDate(this.year, this.month, this.day);
  }

  replace(fields = {}) {
    return new PyDateTime(
      fields.year ?? this.year,
      fields.month ?? this.month,
      fields.day ?? this.day,
      fields.hour ?? this.hour,
      fields.minute ?? this.minute,
      fields.second ?? this.second,
      fields.microsecond ?? this.microsecond,
    );
  }

  microsecondOfDay() {
    return ((this.hour * 60 + this.minute) * 60 + this.second) * 1000000 + this.microsecond;
  }

  equals(other) {
    return other instanceof PyDateTime && this.year === other.year && this.month === other.month
      && this.day === other.day && this.hour === other.hour && this.minute === other.minute
      && this.second === other.second && this.microsecond === other.microsecond;
  }

  get compareKey() {
    return this.toOrdinal() * 86400000000 + this.microsecondOfDay();
  }

  // py: `datetime.__str__` == `self.isoformat(sep=' ')` — a SPACE, not `.isoformat()`'s
  // default 'T'. `simplify.py`'s `date_literal` builds its literal text via
  // `exp.Literal.string(date)`, i.e. `str(date)` (core.py:1768), so this is the format
  // that actually reaches generated SQL, not the ISO-8601 'T' form its name might
  // suggest — named `toISODateTime` for symmetry with `toISODate` regardless.
  toISODateTime() {
    const pad = (n, w) => String(n).padStart(w, "0");
    let s = `${this.toISODate()} ${pad(this.hour, 2)}:${pad(this.minute, 2)}:${pad(this.second, 2)}`;
    if (this.microsecond) s += `.${pad(this.microsecond, 6)}`;
    return s;
  }
}

// py: math.copysign(1, x), truncated to int — used by relativedelta._fix()'s
// overflow cascade (sign of zero is treated as positive, matching CPython).
function sign(x) {
  return x < 0 ? -1 : 1;
}

// py: `divmod(a, b)` for the CASCADE calls in relativedelta._fix(), where the
// dividend `a * sign(a)` is always non-negative, so plain floor semantics suffice.
function divmodNonNeg(a, b) {
  return [Math.floor(a / b), a % b];
}

/**
 * py: `dateutil.relativedelta.relativedelta`, scoped to its RELATIVE fields only
 * (years/months/days/hours/minutes/seconds/microseconds) — `optimizer/simplify.py`'s
 * `interval()` (py:448) never constructs one with the absolute year=/month=/day=/
 * hour=/minute=/second=/microsecond=, weekday=, leapdays=, or yearday=/nlyearday=
 * keyword arguments, so those are not ported.
 */
export class PyRelativedelta {
  constructor({ years = 0, months = 0, days = 0, hours = 0, minutes = 0, seconds = 0, microseconds = 0 } = {}) {
    this.years = years;
    this.months = months;
    this.days = days;
    this.hours = hours;
    this.minutes = minutes;
    this.seconds = seconds;
    this.microseconds = microseconds;
    this._fix();
  }

  // py: relativedelta._fix() — cascades overflow (e.g. `months=15`) up into the next
  // coarser field, exactly like the real dateutil implementation.
  _fix() {
    if (Math.abs(this.microseconds) > 999999) {
      const s = sign(this.microseconds);
      const [div, mod] = divmodNonNeg(this.microseconds * s, 1000000);
      this.microseconds = mod * s;
      this.seconds += div * s;
    }
    if (Math.abs(this.seconds) > 59) {
      const s = sign(this.seconds);
      const [div, mod] = divmodNonNeg(this.seconds * s, 60);
      this.seconds = mod * s;
      this.minutes += div * s;
    }
    if (Math.abs(this.minutes) > 59) {
      const s = sign(this.minutes);
      const [div, mod] = divmodNonNeg(this.minutes * s, 60);
      this.minutes = mod * s;
      this.hours += div * s;
    }
    if (Math.abs(this.hours) > 23) {
      const s = sign(this.hours);
      const [div, mod] = divmodNonNeg(this.hours * s, 24);
      this.hours = mod * s;
      this.days += div * s;
    }
    if (Math.abs(this.months) > 11) {
      const s = sign(this.months);
      const [div, mod] = divmodNonNeg(this.months * s, 12);
      this.months = mod * s;
      this.years += div * s;
    }
  }

  // py: relativedelta.__bool__ (restricted to the relative fields this port keeps).
  toBool() {
    return !!(this.years || this.months || this.days || this.hours
      || this.minutes || this.seconds || this.microseconds);
  }

  // py: relativedelta.__neg__ (restricted to the relative fields this port keeps).
  neg() {
    return new PyRelativedelta({
      years: -this.years,
      months: -this.months,
      days: -this.days,
      hours: -this.hours,
      minutes: -this.minutes,
      seconds: -this.seconds,
      microseconds: -this.microseconds,
    });
  }

  // py: relativedelta.__add__ / __radd__, `other` a `date`/`datetime` — the branch
  // this file needs; the relativedelta-plus-relativedelta and plus-timedelta branches
  // are not ported (nothing in `simplify.py` builds either combination).
  addToDate(other) {
    let dt = other;
    if (this._hasTime() && !(other instanceof PyDateTime)) {
      dt = PyDateTime.fromOrdinal(other.toOrdinal());
    }

    let year = dt.year + this.years;
    let month = dt.month;
    if (this.months) {
      month += this.months;
      if (month > 12) {
        year += 1;
        month -= 12;
      } else if (month < 1) {
        year -= 1;
        month += 12;
      }
    }
    // The month-end clamp: Jan 31 + 1 month -> Feb 28 (or 29 in a leap year), not an
    // overflow into March.
    const day = Math.min(daysInMonth(year, month), dt.day);
    const base = dt.replace({ year, month, day });

    return this._addTimedelta(base);
  }

  // py: relativedelta.__rsub__ — `other - self` == `(-self) + other`.
  subFromDate(other) {
    return this.neg().addToDate(other);
  }

  _hasTime() {
    return !!(this.hours || this.minutes || this.seconds || this.microseconds);
  }

  // py: the `+ datetime.timedelta(days=..., hours=..., minutes=..., seconds=...,
  // microseconds=...)` tail of relativedelta.__add__.
  _addTimedelta(base) {
    if (!(base instanceof PyDateTime)) {
      // No time-of-day component was ever introduced (`_hasTime()` is false), so
      // `this.hours`/`minutes`/`seconds`/`microseconds` are all 0 here.
      return base.addDays(this.days);
    }

    const baseMicros = base.microsecondOfDay();
    const deltaMicros = ((this.hours * 60 + this.minutes) * 60 + this.seconds) * 1000000
      + this.microseconds;
    let totalMicros = baseMicros + deltaMicros;

    let dayCarry = Math.floor(totalMicros / 86400000000);
    let microOfDay = totalMicros - dayCarry * 86400000000;

    const ordinal = base.toOrdinal() + this.days + dayCarry;
    const [year, month, day] = ord2ymd(ordinal);

    const hour = Math.floor(microOfDay / 3600000000);
    microOfDay -= hour * 3600000000;
    const minute = Math.floor(microOfDay / 60000000);
    microOfDay -= minute * 60000000;
    const second = Math.floor(microOfDay / 1000000);
    microOfDay -= second * 1000000;

    return new PyDateTime(year, month, day, hour, minute, second, microOfDay);
  }
}

/** py: `dateutil.relativedelta.relativedelta` constructed from a single relative kwarg. */
export function pyRelativedelta(fields) {
  return new PyRelativedelta(fields);
}
