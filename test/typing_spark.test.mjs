// Structural / error-handling tests for `src/typing/spark.js`, runnable with no Python
// present. The behavioural differential signal (real `TypeAnnotator` end to end against
// CPython, dialect="spark") lives in `spike/p7/fuzz_annotate_types_spark.mjs` — see that
// file and `gen_annotate_types_spark_ref.py`'s own header for scenario coverage.

import test from "node:test";
import assert from "node:assert/strict";
import * as exp from "../src/expressions/index.js";
// Side-effect import: registers the base dialect's PARSE hook before this table's
// inherited `RegexpSplit`/`StrToMap` entries (from `typing/hive.js`) get evaluated --
// see `typing_hive.test.mjs`'s own note.
import "../src/dialects/spark.js";
import { EXPRESSION_METADATA as SPARK2_EXPRESSION_METADATA } from "../src/typing/spark2.js";
import { EXPRESSION_METADATA } from "../src/typing/spark.js";

test("EXPRESSION_METADATA has exactly 348 entries, matching CPython's table size", () => {
  assert.equal(EXPRESSION_METADATA.size, 348);
});

test("18 keys are new (absent from Spark2's table)", () => {
  let newKeys = 0;
  for (const k of EXPRESSION_METADATA.keys()) {
    if (!SPARK2_EXPRESSION_METADATA.has(k)) newKeys++;
  }
  assert.equal(newKeys, 18);
});

test("1 key overrides Spark2's table with a different value", () => {
  let overridden = 0;
  for (const [k, v] of EXPRESSION_METADATA) {
    if (SPARK2_EXPRESSION_METADATA.has(k) && SPARK2_EXPRESSION_METADATA.get(k) !== v) overridden++;
  }
  assert.equal(overridden, 1);
});

test("Grouping: Hive/Spark2 return BIGINT, Spark overrides to TINYINT", () => {
  assert.equal(SPARK2_EXPRESSION_METADATA.get(exp.Grouping).returns, exp.DType.BIGINT);
  assert.equal(EXPRESSION_METADATA.get(exp.Grouping).returns, exp.DType.TINYINT);
});

test("TsOrDsAdd and DateFromUnixDate share the same DATE returns entry", () => {
  const tsOrDsAdd = EXPRESSION_METADATA.get(exp.TsOrDsAdd);
  const dateFromUnixDate = EXPRESSION_METADATA.get(exp.DateFromUnixDate);
  assert.equal(tsOrDsAdd.returns, exp.DType.DATE);
  assert.equal(tsOrDsAdd, dateFromUnixDate);
});

// `exp.Overlay` itself has no real-parse coverage in `fuzz_annotate_types_spark.mjs`:
// its `OVERLAY(x PLACING y FROM n)` special-form syntax needs grammar this port's
// `src/parser.js` doesn't have yet (no `Overlay` reference anywhere in that file) — a
// pre-existing, unrelated parser gap. Exercised here instead by calling the shared
// by-args(this) annotator directly, same treatment R51's own header gives entries its
// real parser/generator can't yet reach through `.sql()`.
test("ArrayCompact, ArrayInsert, BitwiseAndAgg, BitwiseOrAgg, BitwiseXorAgg, Left, Overlay share the same by-args(this) annotator", () => {
  const classes = [
    exp.ArrayCompact, exp.ArrayInsert, exp.BitwiseAndAgg, exp.BitwiseOrAgg,
    exp.BitwiseXorAgg, exp.Left, exp.Overlay,
  ];
  const annotator = EXPRESSION_METADATA.get(exp.Overlay).annotator;
  assert.equal(typeof annotator, "function");
  for (const c of classes) assert.equal(EXPRESSION_METADATA.get(c).annotator, annotator);
});

test("Overlay's by-args(this) annotator resolves its type from the `this` arg", () => {
  let captured;
  const fakeSelf = {
    _annotate_by_args(expression, ...rest) {
      assert.deepEqual(rest, ["this"]);
      captured = expression.args.this.type;
      return expression;
    },
  };
  const fakeThis = { type: exp.DataType.build(exp.DType.VARCHAR) };
  const expression = { args: { this: fakeThis } };
  EXPRESSION_METADATA.get(exp.Overlay).annotator(fakeSelf, expression);
  assert.equal(captured.this, exp.DType.VARCHAR);
});
