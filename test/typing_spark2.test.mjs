// Structural / error-handling tests for `src/typing/spark2.js`, runnable with no Python
// present. The behavioural differential signal (real `TypeAnnotator` end to end against
// CPython, dialect="spark2") lives in `spike/p7/fuzz_annotate_types_spark2.mjs` — see
// that file and `gen_annotate_types_spark2_ref.py`'s own header for scenario coverage.

import test from "node:test";
import assert from "node:assert/strict";
import * as exp from "../src/expressions/index.js";
// Side-effect import: registers the base dialect's PARSE hook before this table's
// inherited `RegexpSplit`/`StrToMap` entries (from `typing/hive.js`) get evaluated --
// see `typing_hive.test.mjs`'s own note.
import "../src/dialects/spark2.js";
import { EXPRESSION_METADATA as HIVE_EXPRESSION_METADATA } from "../src/typing/hive.js";
import { EXPRESSION_METADATA } from "../src/typing/spark2.js";

test("EXPRESSION_METADATA has exactly 330 entries, matching CPython's table size", () => {
  assert.equal(EXPRESSION_METADATA.size, 330);
});

test("9 keys are new (absent from Hive's table)", () => {
  let newKeys = 0;
  for (const k of EXPRESSION_METADATA.keys()) {
    if (!HIVE_EXPRESSION_METADATA.has(k)) newKeys++;
  }
  assert.equal(newKeys, 9);
});

test("5 keys override Hive's table with a different value", () => {
  let overridden = 0;
  for (const [k, v] of EXPRESSION_METADATA) {
    if (HIVE_EXPRESSION_METADATA.has(k) && HIVE_EXPRESSION_METADATA.get(k) !== v) overridden++;
  }
  assert.equal(overridden, 5);
});

test("NextDay and AddMonths: Hive returns VARCHAR, Spark2 overrides both to DATE", () => {
  assert.equal(HIVE_EXPRESSION_METADATA.get(exp.NextDay).returns, exp.DType.VARCHAR);
  assert.equal(EXPRESSION_METADATA.get(exp.NextDay).returns, exp.DType.DATE);
  assert.equal(HIVE_EXPRESSION_METADATA.get(exp.AddMonths).returns, exp.DType.VARCHAR);
  assert.equal(EXPRESSION_METADATA.get(exp.AddMonths).returns, exp.DType.DATE);
});

test("ArrayFilter, Shuffle, Substring share the same by-args(this) annotator", () => {
  const classes = [exp.ArrayFilter, exp.Shuffle, exp.Substring];
  const annotator = EXPRESSION_METADATA.get(exp.ArrayFilter).annotator;
  assert.equal(typeof annotator, "function");
  for (const c of classes) assert.equal(EXPRESSION_METADATA.get(c).annotator, annotator);
});

const fakeCol = (dtype) => ({
  type: exp.DataType.build(dtype),
  isType(...dtypes) { return dtypes.includes(this.type.this); },
});

function setTypeResult(expressions) {
  let captured;
  const fakeSelf = { _set_type: (_e, t) => { captured = t; } };
  EXPRESSION_METADATA.get(exp.Concat).annotator(fakeSelf, { args: { expressions } });
  return captured;
}

test("_annotate_by_similar_args (via Concat): all-BINARY args resolve to BINARY", () => {
  assert.equal(setTypeResult([fakeCol(exp.DType.BINARY), fakeCol(exp.DType.BINARY)]), exp.DType.BINARY);
});

test("_annotate_by_similar_args (via Concat): mixed known-scalar args resolve to TEXT", () => {
  assert.equal(setTypeResult([fakeCol(exp.DType.VARCHAR), fakeCol(exp.DType.INT)]), exp.DType.TEXT);
});

test("_annotate_by_similar_args (via Concat): all-UNKNOWN args resolve to UNKNOWN", () => {
  assert.equal(setTypeResult([fakeCol(exp.DType.UNKNOWN), fakeCol(exp.DType.UNKNOWN)]), exp.DType.UNKNOWN);
});

test("ApproxQuantile's array kwarg is computed per-call from the quantile arg's own type", () => {
  const entry = EXPRESSION_METADATA.get(exp.ApproxQuantile);
  const calls = [];
  const fakeSelf = { _annotate_by_args: (e, ...rest) => calls.push(rest) };
  entry.annotator(fakeSelf, { args: { quantile: { isType: () => true } } });
  entry.annotator(fakeSelf, { args: { quantile: { isType: () => false } } });
  assert.deepEqual(calls[0], ["this", { array: true }]);
  assert.deepEqual(calls[1], ["this", { array: false }]);
});
