// Structural/behavioral tests for `_py/datetime.js`'s `PyDate`/`PyDateTime`/
// `PyRelativedelta` — the `date`/`datetime`/`dateutil.relativedelta.relativedelta`
// stand-ins added for `optimizer/simplify.js`'s `interval()`/`extract_interval()`/
// `_datetrunc_*` (PORT_PLAN.md). Verified scenario-by-scenario against the pinned
// CPython's real `dateutil.relativedelta.relativedelta` while writing this file (see
// PORT_PLAN.md's R-entry for this round); this file re-asserts the same contracts with
// no Python dependency, so `node --test` alone still catches a regression.

import test from "node:test";
import assert from "node:assert/strict";
import { PyDate, PyDateTime, PyRelativedelta } from "../src/_py/datetime.js";

test("PyDate.toOrdinal/fromOrdinal round-trip matches CPython's proleptic Gregorian ordinal", () => {
  // python: date(1, 1, 1).toordinal() == 1; date(9999, 12, 31).toordinal() == 3652059
  assert.equal(new PyDate(1, 1, 1).toOrdinal(), 1);
  assert.equal(new PyDate(9999, 12, 31).toOrdinal(), 3652059);
  // python: date(2001, 1, 1).toordinal() == 730486
  assert.equal(new PyDate(2001, 1, 1).toOrdinal(), 730486);
  assert.deepEqual(
    (() => { const d = PyDate.fromOrdinal(730486); return [d.year, d.month, d.day]; })(),
    [2001, 1, 1],
  );
});

test("PyDate.weekday() matches CPython's Monday=0..Sunday=6", () => {
  // python: date(2001, 1, 1).weekday() == 0 (a real Monday)
  assert.equal(new PyDate(2001, 1, 1).weekday(), 0);
  assert.equal(new PyDate(2001, 1, 7).weekday(), 6);
  assert.equal(new PyDate(2001, 1, 8).weekday(), 0);
});

test("month-end clamping: Jan 31 + 1 month -> Feb 28 in a non-leap year", () => {
  const rd = new PyRelativedelta({ months: 1 });
  const result = rd.addToDate(new PyDate(2021, 1, 31));
  assert.equal(result.toISODate(), "2021-02-28");
});

test("month-end clamping: Jan 31 + 1 month -> Feb 29 in a leap year", () => {
  const rd = new PyRelativedelta({ months: 1 });
  const result = rd.addToDate(new PyDate(2020, 1, 31));
  assert.equal(result.toISODate(), "2020-02-29");
});

test("month-end clamping: Feb 29 + 1 year -> Feb 28 (target year not a leap year)", () => {
  const rd = new PyRelativedelta({ years: 1 });
  const result = rd.addToDate(new PyDate(2020, 2, 29));
  assert.equal(result.toISODate(), "2021-02-28");
});

test("month overflow cascades into a year: +3 months (a quarter) past October rolls to next year", () => {
  const rd = new PyRelativedelta({ months: 3 });
  const result = rd.addToDate(new PyDate(2021, 10, 31));
  // 2021-10 + 3 = 2022-01, clamped to Jan's own 31 days (no clamp needed)
  assert.equal(result.toISODate(), "2022-01-31");
});

test("negative months subtract and still clamp to month length", () => {
  const rd = new PyRelativedelta({ months: -1 });
  const result = rd.addToDate(new PyDate(2021, 3, 31));
  assert.equal(result.toISODate(), "2021-02-28");
});

test("week unit folds into days (7*n), matching dateutil's weeks->days constructor fold", () => {
  const rd = new PyRelativedelta({ days: 7 });
  const result = rd.addToDate(new PyDate(2021, 1, 1));
  assert.equal(result.toISODate(), "2021-01-08");
});

test("sub-day fields promote a bare PyDate to PyDateTime and carry across a day boundary", () => {
  const rd = new PyRelativedelta({ microseconds: 1 });
  const result = rd.addToDate(new PyDateTime(2021, 12, 31, 23, 59, 59, 999999));
  assert.ok(result instanceof PyDateTime);
  assert.equal(result.toISODateTime(), "2022-01-01 00:00:00");
});

test("hour overflow cascades into days", () => {
  const rd = new PyRelativedelta({ hours: 25 });
  const result = rd.addToDate(new PyDateTime(2021, 1, 1, 0, 0, 0, 0));
  assert.equal(result.toISODateTime(), "2021-01-02 01:00:00");
});

test("_fix() cascades an out-of-range months field (e.g. 15) into years, like dateutil's constructor", () => {
  const rd = new PyRelativedelta({ months: 15 });
  assert.equal(rd.years, 1);
  assert.equal(rd.months, 3);
});

test("subFromDate negates before adding, matching date - relativedelta", () => {
  const rd = new PyRelativedelta({ months: 1 });
  const result = rd.subFromDate(new PyDate(2021, 3, 31));
  assert.equal(result.toISODate(), "2021-02-28");
});

test("PyDate/PyDateTime equals() is field-wise, not reference", () => {
  assert.ok(new PyDate(2021, 1, 1).equals(new PyDate(2021, 1, 1)));
  assert.ok(!new PyDate(2021, 1, 1).equals(new PyDate(2021, 1, 2)));
  assert.ok(new PyDateTime(2021, 1, 1, 1, 2, 3, 4).equals(new PyDateTime(2021, 1, 1, 1, 2, 3, 4)));
});

test("PyDate range checks reject an invalid day, matching date.__new__", () => {
  assert.throws(() => new PyDate(2021, 2, 30));
  assert.throws(() => new PyDate(2021, 13, 1));
});

test("compareKey orders a PyDate list the same way CPython's sorted(list-of-date) would", () => {
  const dates = [new PyDate(2021, 3, 1), new PyDate(2021, 1, 15), new PyDate(2021, 2, 1)];
  const sorted = [...dates].sort((a, b) => a.compareKey - b.compareKey);
  assert.deepEqual(sorted.map((d) => d.toISODate()), ["2021-01-15", "2021-02-01", "2021-03-01"]);
});
