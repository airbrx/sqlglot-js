// Structural / error-handling tests for `src/typing/index.js`, runnable with no Python
// present. The behavioural differential signal (this file's registry vs CPython's
// `sqlglot.typing.EXPRESSION_METADATA`, call-shape exact) lives in
// `spike/p7/fuzz_typing.mjs` — see that file and `src/typing/index.js`'s own header for
// why this table has no real consumer yet (`TypeAnnotator`/`annotate_types.py` is
// unported, AIR-2097/2098).

import test from "node:test";
import assert from "node:assert/strict";
import * as exp from "../src/expressions/index.js";
// Side-effect import: registers the default-dialect parser, which `exp.DataType.
// fromStr`'s parameterised-type branch (`ARRAY<DATE>`) needs — see fuzz_typing.mjs.
import "../src/dialects/dialect.js";
import { EXPRESSION_METADATA, TIMESTAMP_EXPRESSIONS } from "../src/typing/index.js";

test("EXPRESSION_METADATA has exactly 294 entries, matching CPython's table size", () => {
  assert.equal(EXPRESSION_METADATA.size, 294);
});

test("TIMESTAMP_EXPRESSIONS: the 6 classes it names all return DType.TIMESTAMP", () => {
  assert.equal(TIMESTAMP_EXPRESSIONS.size, 6);
  for (const cls of TIMESTAMP_EXPRESSIONS) {
    assert.equal(EXPRESSION_METADATA.get(cls).returns, exp.DType.TIMESTAMP);
  }
  assert.ok(TIMESTAMP_EXPRESSIONS.has(exp.CurrentTimestamp));
  assert.ok(TIMESTAMP_EXPRESSIONS.has(exp.UnixToTime));
});

test("Binary subclasses all route through the same _annotate_binary annotator", () => {
  const add = EXPRESSION_METADATA.get(exp.Add);
  const and_ = EXPRESSION_METADATA.get(exp.And);
  assert.equal(typeof add.annotator, "function");
  assert.equal(add.annotator, and_.annotator);
  // exp.Binary itself is included (Python's issubclass(Binary, Binary) is True).
  assert.ok(EXPRESSION_METADATA.get(exp.Binary));
});

test("Unary/Alias/IgnoreNulls/RespectNulls family shares the _annotate_unary annotator", () => {
  const alias = EXPRESSION_METADATA.get(exp.Alias);
  const not_ = EXPRESSION_METADATA.get(exp.Not);
  assert.equal(alias.annotator, not_.annotator);
});

test("fixed-DType classes carry the exact upstream return type", () => {
  assert.equal(EXPRESSION_METADATA.get(exp.Null).returns, exp.DType.NULL);
  assert.equal(EXPRESSION_METADATA.get(exp.ApproxDistinct).returns, exp.DType.BIGINT);
  assert.equal(EXPRESSION_METADATA.get(exp.ParseJSON).returns, exp.DType.JSON);
  assert.equal(EXPRESSION_METADATA.get(exp.Day).returns, exp.DType.TINYINT);
});

test("DataType's annotator is the identity function (py:337 `lambda _, e: e`)", () => {
  const e = new exp.Expr({ this: "x" });
  assert.equal(EXPRESSION_METADATA.get(exp.DataType).annotator(null, e), e);
});

test("Cast/TryCast route to e.args.to via _set_type", () => {
  const calls = [];
  const fakeSelf = { _set_type: (e, v) => calls.push(v) };
  const e = new exp.Expr({ this: "x", to: "SOME_TYPE" });
  EXPRESSION_METADATA.get(exp.Cast).annotator(fakeSelf, e);
  EXPRESSION_METADATA.get(exp.TryCast).annotator(fakeSelf, e);
  assert.deepEqual(calls, ["SOME_TYPE", "SOME_TYPE"]);
});

test("Sum promotes (py:366-368 `promote=True`), plain Max/Min do not", () => {
  const calls = [];
  const fakeSelf = { _annotate_by_args: (...args) => calls.push(args) };
  const e = new exp.Expr({});
  EXPRESSION_METADATA.get(exp.Sum).annotator(fakeSelf, e);
  EXPRESSION_METADATA.get(exp.Max).annotator(fakeSelf, e);
  assert.deepEqual(calls[0], [e, "this", "expressions", { promote: true }]);
  assert.deepEqual(calls[1], [e, "this", "expressions"]);
});

test("Count/DateDiff/HexString/Timestamp pick their DType from the right arg flag", () => {
  const seen = [];
  const fakeSelf = { _set_type: (_e, dtype) => seen.push(dtype) };
  EXPRESSION_METADATA.get(exp.Count).annotator(fakeSelf, new exp.Expr({ big_int: true }));
  EXPRESSION_METADATA.get(exp.Count).annotator(fakeSelf, new exp.Expr({}));
  EXPRESSION_METADATA.get(exp.HexString).annotator(fakeSelf, new exp.Expr({ is_integer: true }));
  EXPRESSION_METADATA.get(exp.HexString).annotator(fakeSelf, new exp.Expr({}));
  EXPRESSION_METADATA.get(exp.Timestamp).annotator(fakeSelf, new exp.Expr({ with_tz: true }));
  EXPRESSION_METADATA.get(exp.Timestamp).annotator(fakeSelf, new exp.Expr({}));
  assert.deepEqual(seen, [
    exp.DType.BIGINT,
    exp.DType.INT,
    exp.DType.BIGINT,
    exp.DType.BINARY,
    exp.DType.TIMESTAMPTZ,
    exp.DType.TIMESTAMP,
  ]);
});

test("Case builds its arg list from e.args.ifs[*].args.true, plus a trailing \"default\"", () => {
  const calls = [];
  const fakeSelf = { _annotate_by_args: (...args) => calls.push(args) };
  const e = new exp.Expr({
    ifs: [new exp.Expr({ true: "A" }), new exp.Expr({ true: "B" })],
  });
  EXPRESSION_METADATA.get(exp.Case).annotator(fakeSelf, e);
  assert.deepEqual(calls[0], [e, "A", "B", "default"]);
});

test("Anonymous nests self.schema.get_udf_type(e) inside self._set_type(e, ...)", () => {
  const calls = [];
  const fakeSelf = {
    schema: { get_udf_type: (e) => `udf-type-of-${e.this}` },
    _set_type: (e, v) => calls.push([e.this, v]),
  };
  EXPRESSION_METADATA.get(exp.Anonymous).annotator(fakeSelf, new exp.Expr({ this: "f" }));
  assert.deepEqual(calls, [["f", "udf-type-of-f"]]);
});

test("GenerateDateArray/GenerateTimestampArray set a real parsed ARRAY<...> DataType", () => {
  const calls = [];
  const fakeSelf = { _set_type: (_e, dtype) => calls.push(dtype) };
  EXPRESSION_METADATA.get(exp.GenerateDateArray).annotator(fakeSelf, new exp.Expr({}));
  EXPRESSION_METADATA.get(exp.GenerateTimestampArray).annotator(fakeSelf, new exp.Expr({}));
  assert.equal(calls[0].this, exp.DType.ARRAY);
  assert.equal(calls[0].expressions[0].this, exp.DType.DATE);
  assert.equal(calls[1].expressions[0].this, exp.DType.TIMESTAMP);
});

test("Array/ArrayAgg/GenerateSeries pass the array=true kwarg", () => {
  const calls = [];
  const fakeSelf = { _annotate_by_args: (...args) => calls.push(args) };
  const e = new exp.Expr({});
  EXPRESSION_METADATA.get(exp.Array).annotator(fakeSelf, e);
  EXPRESSION_METADATA.get(exp.ArrayAgg).annotator(fakeSelf, e);
  EXPRESSION_METADATA.get(exp.GenerateSeries).annotator(fakeSelf, e);
  assert.deepEqual(calls[0], [e, "expressions", { array: true }]);
  assert.deepEqual(calls[1], [e, "this", { array: true }]);
  assert.deepEqual(calls[2], [e, "start", "end", "step", { array: true }]);
});
