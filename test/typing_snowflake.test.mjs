// Structural / error-handling tests for `src/typing/snowflake.js`, runnable with no
// Python present. The behavioural differential signal (real `TypeAnnotator` end to end
// against CPython, dialect="snowflake") lives in
// `spike/p7/fuzz_annotate_types_snowflake.mjs` — see that file and
// `gen_annotate_types_snowflake_ref.py`'s own header for scenario coverage.

import test from "node:test";
import assert from "node:assert/strict";
import * as exp from "../src/expressions/index.js";
// Side-effect import: registers the snowflake dialect parser, which `exp.DataType.
// fromStr`'s parameterised-type branch (e.g. "NUMBER(38, 6)") needs.
import "../src/dialects/snowflake.js";
import { EXPRESSION_METADATA as BASE_EXPRESSION_METADATA } from "../src/typing/index.js";
import { EXPRESSION_METADATA } from "../src/typing/snowflake.js";

test("EXPRESSION_METADATA has exactly 457 entries, matching CPython's table size", () => {
  assert.equal(EXPRESSION_METADATA.size, 457);
});

test("163 keys are new (absent from the base table)", () => {
  let newKeys = 0;
  for (const k of EXPRESSION_METADATA.keys()) {
    if (!BASE_EXPRESSION_METADATA.has(k)) newKeys++;
  }
  assert.equal(newKeys, 163);
});

test("44 keys override a base-table entry with a different value", () => {
  let overridden = 0;
  for (const [k, v] of EXPRESSION_METADATA) {
    if (BASE_EXPRESSION_METADATA.has(k) && BASE_EXPRESSION_METADATA.get(k) !== v) overridden++;
  }
  assert.equal(overridden, 44);
});

test("DayOfWeek: Snowflake overrides the base's INT-returns entry to TINYINT", () => {
  assert.equal(BASE_EXPRESSION_METADATA.get(exp.DayOfWeek).returns, exp.DType.INT);
  assert.equal(EXPRESSION_METADATA.get(exp.DayOfWeek).returns, exp.DType.TINYINT);
});

test("ArrayAgg: Snowflake overrides the base's by-args-array annotator to a flat ARRAY return", () => {
  assert.equal(typeof BASE_EXPRESSION_METADATA.get(exp.ArrayAgg).annotator, "function");
  assert.equal(EXPRESSION_METADATA.get(exp.ArrayAgg).returns, exp.DType.ARRAY);
});

test("Variance and VariancePop share the same _annotate_variance annotator", () => {
  const variance = EXPRESSION_METADATA.get(exp.Variance);
  const variancePop = EXPRESSION_METADATA.get(exp.VariancePop);
  assert.equal(typeof variance.annotator, "function");
  assert.equal(variance.annotator, variancePop.annotator);
});

test("ArgMax and ArgMin share the same _annotate_arg_max_min annotator", () => {
  const argMax = EXPRESSION_METADATA.get(exp.ArgMax);
  const argMin = EXPRESSION_METADATA.get(exp.ArgMin);
  assert.equal(typeof argMax.annotator, "function");
  assert.equal(argMax.annotator, argMin.annotator);
});

test("DateAdd and TimeAdd share the same _annotate_date_or_time_add annotator", () => {
  const dateAdd = EXPRESSION_METADATA.get(exp.DateAdd);
  const timeAdd = EXPRESSION_METADATA.get(exp.TimeAdd);
  assert.equal(typeof dateAdd.annotator, "function");
  assert.equal(dateAdd.annotator, timeAdd.annotator);
});

test("28 math functions share the same _annotate_math_with_float_decfloat annotator", () => {
  const classes = [
    exp.Acos, exp.Asin, exp.Atan, exp.Atan2, exp.Cbrt, exp.Cos, exp.Cot, exp.Degrees,
    exp.Exp, exp.Ln, exp.Log, exp.Pow, exp.Radians, exp.RegrAvgx, exp.RegrAvgy,
    exp.RegrCount, exp.RegrIntercept, exp.RegrR2, exp.RegrSlope, exp.RegrSxx,
    exp.RegrSxy, exp.RegrSyy, exp.RegrValx, exp.RegrValy, exp.Sin, exp.Sqrt, exp.Tan,
    exp.Tanh,
  ];
  assert.equal(classes.length, 28);
  const annotator = EXPRESSION_METADATA.get(exp.Acos).annotator;
  assert.equal(typeof annotator, "function");
  for (const c of classes) assert.equal(EXPRESSION_METADATA.get(c).annotator, annotator);
});

test("HashAgg builds a fixed NUMBER(19, 0) DataType via an inline lambda", () => {
  const fakeSelf = { _set_type: (_e, t) => t };
  const result = EXPRESSION_METADATA.get(exp.HashAgg).annotator(fakeSelf, {});
  assert.ok(result instanceof exp.DataType);
  assert.equal(result.this, exp.DType.DECIMAL);
  assert.equal(result.expressions[0].this.toPy(), 19n);
  assert.equal(result.expressions[1].this.toPy(), 0n);
});
