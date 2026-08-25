import test from "node:test";
import assert from "node:assert/strict";
import {
  Array as ArrayExpr, Case, Cast, ColumnConstraint, DataType, DType, Identifier,
  JSONExtract, Literal, Map as MapExpr, Properties, VarMap,
  PropertiesLocation, UnixToTime,
} from "../../src/expressions/index.js";

test("focused datatype and cast behavior", () => {
  const int = DataType.build(DType.INT);
  assert.equal(int.isType(DType.INT), true);
  assert.equal(int.isType(DType.TEXT), false);
  assert.notEqual(DataType.build(int), int);
  assert.equal(DataType.build(int, { copy: false }), int);
  const cast = new Cast({ this: new Identifier({ this: "x" }), to: int });
  assert.equal(cast.name, "x");
  assert.equal(cast.outputName, "x");
  assert.equal(cast.isType(DType.INT), true);
});

test("focused class constants", () => {
  assert.equal(DType.INT.intoExpr().this, DType.INT);
  assert.equal(DataType.Type, DType);
  assert.equal(DataType.INTEGER_TYPES.has(DType.BIT), true);
  assert.equal(DataType.NUMERIC_TYPES.has(DType.DECIMAL), true);
  assert.equal(DataType.TEMPORAL_TYPES.has(DType.TIMESTAMPTZ), true);
  assert.equal(Properties.Location, PropertiesLocation);
  assert.equal(PropertiesLocation.POST_CREATE.value, "POST_CREATE");
  assert.equal(UnixToTime.SECONDS.this, "0");
  assert.equal(UnixToTime.NANOS.this, "9");
});

test("focused collection projections", () => {
  const keys = new ArrayExpr({ expressions: [new Literal({ this: "k", is_string: true })] });
  const values = new ArrayExpr({ expressions: [new Literal({ this: "v", is_string: true })] });
  assert.deepEqual(new MapExpr({ keys, values }).keys, keys.expressions);
  assert.deepEqual(new VarMap({ keys, values }).values, values.expressions);
  const kind = new Literal({ this: "kind", is_string: true });
  assert.equal(new ColumnConstraint({ kind }).kind, kind);
});

test("case mutation, json naming and properties fromDict", () => {
  const base = new Case({ ifs: [] });
  const changed = base.when("a", "b");
  assert.notEqual(changed, base);
  assert.equal(changed.args.ifs.length, 1);
  assert.equal(changed.else_("c", { copy: false }).args.default.constructor.name, "Column");
  const expression = new Identifier({ this: "payload" });
  assert.equal(new JSONExtract({ expression }).outputName, "payload");
  assert.deepEqual(Properties.fromDict({ engine: "x", custom: 1 }).expressions.map(x => x.constructor.name), ["EngineProperty", "Property"]);
});
