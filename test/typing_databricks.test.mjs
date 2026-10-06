// Structural / error-handling tests for `src/typing/databricks.js`, runnable with no
// Python present. The behavioural differential signal (real `TypeAnnotator` end to end
// against CPython, dialect="databricks") lives in
// `spike/p7/fuzz_annotate_types_databricks.mjs` — see that file and
// `gen_annotate_types_databricks_ref.py`'s own header for scenario coverage.

import test from "node:test";
import assert from "node:assert/strict";
import * as exp from "../src/expressions/index.js";
// Side-effect import: registers the databricks dialect, which
// `RegexpExtractAll`'s annotator needs for its `exp.DataType.fromStr(..., {dialect:
// "databricks"})` call below.
import "../src/dialects/databricks.js";
import { EXPRESSION_METADATA as SPARK_EXPRESSION_METADATA } from "../src/typing/spark.js";
import { EXPRESSION_METADATA } from "../src/typing/databricks.js";

test("EXPRESSION_METADATA has exactly 364 entries, matching CPython's table size", () => {
  assert.equal(EXPRESSION_METADATA.size, 364);
});

test("16 keys are new (absent from Spark's table)", () => {
  let newKeys = 0;
  for (const k of EXPRESSION_METADATA.keys()) {
    if (!SPARK_EXPRESSION_METADATA.has(k)) newKeys++;
  }
  assert.equal(newKeys, 16);
});

test("0 keys override Spark's table — Databricks only adds new keys", () => {
  let overridden = 0;
  for (const [k, v] of EXPRESSION_METADATA) {
    if (SPARK_EXPRESSION_METADATA.has(k) && SPARK_EXPRESSION_METADATA.get(k) !== v) overridden++;
  }
  assert.equal(overridden, 0);
});

test("the 9 REGR_* / Rint entries share the same DOUBLE returns value", () => {
  const classes = [
    exp.RegrAvgx, exp.RegrAvgy, exp.RegrIntercept, exp.RegrR2, exp.RegrSlope,
    exp.RegrSxx, exp.RegrSxy, exp.RegrSyy, exp.Rint,
  ];
  for (const c of classes) assert.equal(EXPRESSION_METADATA.get(c).returns, exp.DType.DOUBLE);
});

test("RegexpExtractAll builds a literal ARRAY<STRING> DataType parsed with dialect=databricks", () => {
  let captured;
  const fakeSelf = { _set_type: (_e, t) => { captured = t; } };
  EXPRESSION_METADATA.get(exp.RegexpExtractAll).annotator(fakeSelf, {});
  assert.ok(captured instanceof exp.DataType);
  assert.equal(captured.this, exp.DType.ARRAY);
});
