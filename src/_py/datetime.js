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

export class PyValueError extends Error {
  constructor(message) {
    super(message);
    this.name = "PyValueError";
  }
}

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

// py: _parse_hh_mm_ss_ff — parses HH[:MM[:SS[.fff[fff]]]]
function parseHhMmSsFf(tstr) {
  const lenStr = tstr.length;
  const timeComps = [0, 0, 0, 0];
  let pos = 0;

  for (let comp = 0; comp < 3; comp++) {
    if (lenStr - pos < 2) throw new PyValueError("Incomplete time component");

    const v = parseDigits(tstr, pos, 2);
    if (v < 0) throw new PyValueError("Invalid time component");
    timeComps[comp] = v;

    pos += 2;
    const nextChar = tstr.slice(pos, pos + 1);

    if (!nextChar || comp >= 2) break;
    if (nextChar !== ":") throw new PyValueError(`Invalid time separator: ${nextChar}`);
    pos += 1;
  }

  if (pos < lenStr) {
    if (tstr[pos] !== ".") {
      throw new PyValueError("Invalid microsecond component");
    }
    pos += 1;
    const lenRemainder = lenStr - pos;
    if (lenRemainder !== 3 && lenRemainder !== 6) {
      throw new PyValueError("Invalid microsecond component");
    }
    const frac = parseDigits(tstr, pos, lenRemainder);
    if (frac < 0) throw new PyValueError("Invalid microsecond component");
    timeComps[3] = lenRemainder === 3 ? frac * 1000 : frac;
  }

  return timeComps;
}

// py: _parse_isoformat_time — HH[:MM[:SS[.fff[fff]]]][+HH:MM[:SS[.ffffff]]]
function parseIsoformatTime(tstr) {
  const lenStr = tstr.length;
  if (lenStr < 2) throw new PyValueError("Isoformat time too short");

  // py: tz_pos = (tstr.find('-') + 1 or tstr.find('+') + 1)
  // Note '-' is searched FIRST, so a '-' anywhere wins over a later '+'.
  const tzPos = tstr.indexOf("-") + 1 || tstr.indexOf("+") + 1;
  const timestr = tzPos > 0 ? tstr.slice(0, tzPos - 1) : tstr;

  const timeComps = parseHhMmSsFf(timestr);

  let tz = null;
  if (tzPos > 0) {
    const tzstr = tstr.slice(tzPos);
    // Valid tz strings are exactly: HH:MM (5), HH:MM:SS (8), HH:MM:SS.ffffff (15)
    if (tzstr.length !== 5 && tzstr.length !== 8 && tzstr.length !== 15) {
      throw new PyValueError("Malformed time zone string");
    }
    const tzComps = parseHhMmSsFf(tzstr);
    if (tzComps.every((x) => x === 0)) {
      tz = { offsetMicros: 0, utc: true };
    } else {
      const tzsign = tstr[tzPos - 1] === "-" ? -1 : 1;
      const micros =
        tzComps[0] * 3600000000 + tzComps[1] * 60000000 + tzComps[2] * 1000000 + tzComps[3];
      const total = tzsign * micros;
      // py: timezone(td) requires strictly between -24h and 24h
      if (Math.abs(total) >= 86400000000) {
        throw new PyValueError("offset must be a timedelta strictly between -24h and 24h");
      }
      tz = { offsetMicros: total, utc: false };
    }
  }

  return [...timeComps, tz];
}

/**
 * py: datetime.date.fromisoformat — accepts EXACTLY `YYYY-MM-DD` (length 10).
 * @returns {{year:number, month:number, day:number}}
 */
export function pyDateFromIsoFormat(dateString) {
  if (typeof dateString !== "string") {
    throw new TypeError("fromisoformat: argument must be str");
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
    throw new TypeError("fromisoformat: argument must be str");
  }
  const dstr = dateString.slice(0, 10);
  const tstr = dateString.slice(11);

  let dateComponents;
  try {
    if (dstr.length !== 10) throw new PyValueError("too short");
    dateComponents = parseIsoformatDate(dstr);
  } catch (e) {
    if (e instanceof PyValueError) {
      throw new PyValueError(`Invalid isoformat string: ${JSON.stringify(dateString)}`);
    }
    throw e;
  }

  let timeComponents;
  if (tstr) {
    try {
      timeComponents = parseIsoformatTime(tstr);
    } catch (e) {
      if (e instanceof PyValueError) {
        throw new PyValueError(`Invalid isoformat string: ${JSON.stringify(dateString)}`);
      }
      throw e;
    }
  } else {
    timeComponents = [0, 0, 0, 0, null];
  }

  const [year, month, day] = dateComponents;
  const [hour, minute, second, microsecond, tz] = timeComponents;
  // py: cls(*(date_components + time_components)) — constructor validates ranges,
  // and those ValueErrors are NOT wrapped as 'Invalid isoformat string'.
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
