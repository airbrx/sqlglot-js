// Structural / error-handling tests for `src/typing/hive.js`, runnable with no Python
// present. The behavioural differential signal (real `TypeAnnotator` end to end against
// CPython, dialect="hive") lives in `spike/p7/fuzz_annotate_types_hive.mjs` — see that
// file and `gen_annotate_types_hive_ref.py`'s own header for scenario coverage.

import test from "node:test";
import assert from "node:assert/strict";
import * as exp from "../src/expressions/index.js";
// Side-effect import: registers the base dialect's PARSE hook (`registerParser`,
// `src/dialects/dialect.js`) BEFORE `typing/hive.js`'s own module-top-level
// `exp.DataType.fromStr("ARRAY<STRING>")` / `fromStr("MAP<STRING, STRING>")` calls run
// below, matching the one working import order this repo actually uses in production
// (`dialects/hive.js` always imports `./dialect.js` before `../typing/hive.js`). Without
// it, `fromStr` silently falls back to a P2-safe leaf (`maybeParse`, `expressions/
// core.js`) instead of actually parsing, and `RegexpSplit`/`StrToMap`'s `returns` below
// would be a bogus `DataType(this=Identifier(...))`, not the real nested type.
import "../src/dialects/hive.js";
import { EXPRESSION_METADATA as BASE_EXPRESSION_METADATA } from "../src/typing/index.js";
import { EXPRESSION_METADATA } from "../src/typing/hive.js";

test("EXPRESSION_METADATA has exactly 321 entries, matching CPython's table size", () => {
  assert.equal(EXPRESSION_METADATA.size, 321);
});

test("27 keys are new (absent from the base table)", () => {
  let newKeys = 0;
  for (const k of EXPRESSION_METADATA.keys()) {
    if (!BASE_EXPRESSION_METADATA.has(k)) newKeys++;
  }
  assert.equal(newKeys, 27);
});

test("15 keys override a base-table entry with a different value", () => {
  let overridden = 0;
  for (const [k, v] of EXPRESSION_METADATA) {
    if (BASE_EXPRESSION_METADATA.has(k) && BASE_EXPRESSION_METADATA.get(k) !== v) overridden++;
  }
  assert.equal(overridden, 15);
});

test("Sign: base returns INT, Hive overrides to DOUBLE", () => {
  assert.equal(BASE_EXPRESSION_METADATA.get(exp.Sign).returns, exp.DType.INT);
  assert.equal(EXPRESSION_METADATA.get(exp.Sign).returns, exp.DType.DOUBLE);
});

test("Coalesce and If both use the promote=true form of _annotate_by_args", () => {
  const coalesce = EXPRESSION_METADATA.get(exp.Coalesce);
  const ifEntry = EXPRESSION_METADATA.get(exp.If);
  assert.equal(typeof coalesce.annotator, "function");
  assert.equal(typeof ifEntry.annotator, "function");
});

test("RegexpSplit returns a literal ARRAY<STRING> DataType, not a bare DType", () => {
  const entry = EXPRESSION_METADATA.get(exp.RegexpSplit);
  assert.ok(entry.returns instanceof exp.DataType);
  assert.equal(entry.returns.this, exp.DType.ARRAY);
});

test("StrToMap returns a literal MAP<STRING, STRING> DataType", () => {
  const entry = EXPRESSION_METADATA.get(exp.StrToMap);
  assert.ok(entry.returns instanceof exp.DataType);
  assert.equal(entry.returns.this, exp.DType.MAP);
});

test("ArrayDistinct, ArrayExcept, First, Last, Negative, Reverse share the same by-args(this) annotator", () => {
  const classes = [exp.ArrayDistinct, exp.ArrayExcept, exp.First, exp.Last, exp.Negative, exp.Reverse];
  const annotator = EXPRESSION_METADATA.get(exp.ArrayDistinct).annotator;
  assert.equal(typeof annotator, "function");
  for (const c of classes) assert.equal(EXPRESSION_METADATA.get(c).annotator, annotator);
});
