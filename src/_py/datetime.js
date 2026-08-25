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
