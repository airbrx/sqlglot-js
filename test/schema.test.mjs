// Structural / error-handling tests for `src/schema.js`, runnable with no Python
// present. The AST/value-level differential signal (this file's behavior vs CPython's
// `sqlglot.schema.MappingSchema`, byte-exact) lives in `spike/p6/fuzz_schema.mjs` — see
// that file and `src/schema.js`'s own header for the Map-vs-plain-object rationale this
// file's numeric-key-ordering tests exist to guard.

import test from "node:test";
import assert from "node:assert/strict";
import * as exp from "../src/expressions/index.js";
import "../src/parser.js";
import { SchemaError, PyValueError } from "../src/errors.js";
import {
  Schema,
  AbstractMappingSchema,
  MappingSchema,
  normalizeName,
  ensureSchema,
  ensureColumnMapping,
  flattenSchema,
  nestedGet,
  nestedSet,
} from "../src/schema.js";

test("MappingSchema: basic single-level lookups", () => {
  const s = new MappingSchema({ t: { a: "INT", b: "VARCHAR" } });
  assert.deepEqual(s.columnNames("t"), ["a", "b"]);
  assert.equal(s.getColumnType("t", "a").sql(), "INT");
  assert.equal(s.hasColumn("t", "a"), true);
  assert.equal(s.hasColumn("t", "z"), false);
  assert.equal(s.depth(), 1);
  assert.deepEqual(s.supportedTableArgs, ["this"]);
});

test("MappingSchema: unknown table returns empty columns / UNKNOWN type, not a throw", () => {
  const s = new MappingSchema({ t: { a: "INT" } });
  assert.deepEqual(s.columnNames("nope"), []);
  assert.equal(s.getColumnType("nope", "a").this, exp.DType.UNKNOWN);
  assert.equal(s.hasColumn("nope", "a"), false);
});

test("MappingSchema: find returns null (not a throw) for a table absent from the trie entirely", () => {
  // py: `_find_in_trie` returns None on TrieResult.FAILED unconditionally --
  // `raiseOnMissing` only ever affects the AMBIGUOUS-PREFIX case, never "not present at
  // all". Verified directly against CPython: `MappingSchema({"t": {"a": "INT"}}).find(
  // exp.to_table("nope"), raise_on_missing=True)` also returns `None`.
  const s = new MappingSchema({ t: { a: "INT" } });
  assert.equal(s.find(exp.toTable("nope")), null);
});

test("MappingSchema: 2-level and 3-level nesting resolve dotted table paths", () => {
  const s2 = new MappingSchema({ db1: { t1: { a: "INT" } }, db2: { t1: { b: "TEXT" } } });
  assert.equal(s2.depth(), 2);
  assert.deepEqual(s2.columnNames("db1.t1"), ["a"]);
  assert.deepEqual(s2.columnNames("db2.t1"), ["b"]);

  const s3 = new MappingSchema({
    cat1: { db1: { t1: { a: "INT" } }, db2: { t1: { b: "TEXT" } } },
  });
  assert.equal(s3.depth(), 3);
  assert.deepEqual(s3.columnNames("cat1.db1.t1"), ["a"]);
});

test("MappingSchema: ambiguous unqualified lookup raises SchemaError naming every possibility", () => {
  const s = new MappingSchema({
    cat1: { db1: { t1: { a: "INT" } }, db2: { t1: { b: "TEXT" } } },
  });
  assert.throws(
    () => s.columnNames("t1"),
    (e) => e instanceof SchemaError && /Ambiguous mapping for t1: db1\.cat1, db2\.cat1\./.test(e.message),
  );
});

test("MappingSchema: addTable enforces the schema's nesting depth once non-empty", () => {
  const s = new MappingSchema({ t: { a: "INT" } });
  assert.throws(
    () => s.addTable("db.t2", "b:INT"),
    (e) => e instanceof SchemaError && /must match the schema's nesting level: 1\./.test(e.message),
  );
});

test("MappingSchema: addTable accepts string / list / plain-object / Map column mappings", () => {
  const s = new MappingSchema();
  s.addTable("t1", "a:INT, b:VARCHAR");
  s.addTable("t2", ["c", "d"]);
  s.addTable("t3", { e: "INT" });
  s.addTable("t4", new Map([["f", "INT"]]));
  assert.deepEqual(s.columnNames("t1"), ["a", "b"]);
  assert.deepEqual(s.columnNames("t2"), ["c", "d"]);
  assert.deepEqual(s.columnNames("t3"), ["e"]);
  assert.deepEqual(s.columnNames("t4"), ["f"]);
});

test("MappingSchema: addTable is a no-op when re-adding an existing table with no new columns", () => {
  const s = new MappingSchema({ t: { a: "INT" } });
  s.addTable("t");
  assert.deepEqual(s.columnNames("t"), ["a"]);
});

test("MappingSchema: numeric-looking column/table names keep insertion order (Map, not plain object)", () => {
  const s = new MappingSchema();
  s.addTable("t", "2:INT, 1:INT, a:INT");
  assert.deepEqual(s.columnNames("t"), ["2", "1", "a"]);

  // A plain JS *object literal* with numeric-looking keys is already reordered by V8
  // before this file ever sees it (`{2: ..., 1: ..., 10: ...}` would print as
  // 1/2/10) -- the one caveat the file header documents. A `Map` literal is the
  // correct way to construct an order-sensitive nested schema by hand.
  const s2 = new MappingSchema(
    new Map([["2", new Map([["a", "INT"]])], ["1", new Map([["b", "INT"]])], ["10", new Map([["c", "INT"]])]]),
  );
  assert.deepEqual([...s2.mapping.keys()], ["2", "1", "10"]);
});

test("MappingSchema: only_visible filters column_names by the visible mapping", () => {
  const s = new MappingSchema({ t: { a: "INT", b: "INT", c: "INT" } }, { t: ["a", "b"] });
  assert.deepEqual(s.columnNames("t", true), ["a", "b"]);
  assert.deepEqual(s.columnNames("t", false), ["a", "b", "c"]);
});

test("MappingSchema: only_visible raises if the table is missing from an otherwise-populated visible map", () => {
  const s = new MappingSchema({ t: { a: "INT" }, u: { b: "INT" } }, { t: ["a"] });
  assert.throws(() => s.columnNames("u", true), (e) => e instanceof PyValueError);
});

test("MappingSchema: identifier normalization lower-cases by default and preserves case with normalize=false", () => {
  const normalized = new MappingSchema({ Foo: { Bar: "INT" } });
  assert.deepEqual(normalized.columnNames("foo"), ["bar"]);

  const raw = new MappingSchema({ Foo: { Bar: "INT" } }, null, null, false);
  assert.deepEqual(raw.columnNames("Foo"), ["Bar"]);
});

test("MappingSchema: getColumnType passes through an existing DataType value unchanged", () => {
  const dt = exp.DataType.build("INT");
  const s = new MappingSchema(new Map([["t", new Map([["a", dt]])]]), null, null, false);
  assert.equal(s.getColumnType("t", "a"), dt);
});

test("MappingSchema: UDF mapping resolves by name and reports UNKNOWN for unknown UDFs", () => {
  const s = new MappingSchema(null, null, null, true, { myudf: "INT" });
  assert.equal(s.getUdfType("myudf()").sql(), "INT");
  assert.equal(s.getUdfType("othername()").this, exp.DType.UNKNOWN);
});

test("MappingSchema: copy() produces an independent, equally-populated schema", () => {
  const s = new MappingSchema({ t: { a: "INT" } });
  const c = s.copy();
  assert.notEqual(c, s);
  assert.deepEqual(c.columnNames("t"), ["a"]);
  c.addTable("t2", "b:INT");
  assert.deepEqual(s.columnNames("t2"), []);
});

test("MappingSchema.fromMappingSchema round-trips an existing instance", () => {
  const s = new MappingSchema({ t: { a: "INT" } }, { t: ["a"] }, null, true, { u: "INT" });
  const s2 = MappingSchema.fromMappingSchema(s);
  assert.deepEqual(s2.columnNames("t"), ["a"]);
  assert.equal(s2.getUdfType("u()").sql(), "INT");
});

test("ensureSchema returns an existing Schema instance unchanged and wraps a plain dict", () => {
  const s = new MappingSchema({ t: { a: "INT" } });
  assert.equal(ensureSchema(s), s);
  assert.equal(s instanceof Schema, true);
  assert.equal({} instanceof Schema, false);

  const wrapped = ensureSchema({ u: { b: "INT" } });
  assert.ok(wrapped instanceof MappingSchema);
  assert.deepEqual(wrapped.columnNames("u"), ["b"]);
});

test("Schema: abstract methods throw when not overridden", () => {
  const s = new Schema();
  assert.throws(() => s.addTable("t"), (e) => e instanceof PyValueError);
  assert.throws(() => s.columnNames("t"), (e) => e instanceof PyValueError);
  assert.throws(() => s.getColumnType("t", "a"), (e) => e instanceof PyValueError);
  assert.throws(() => s.supportedTableArgs, (e) => e instanceof PyValueError);
  assert.equal(s.dialect, null);
  assert.equal(s.empty, true);
  assert.equal(s.getUdfType("f()").this, exp.DType.UNKNOWN);
});

test("AbstractMappingSchema: empty reflects whether the mapping has any tables", () => {
  const empty = new AbstractMappingSchema();
  assert.equal(empty.empty, true);
  const nonEmpty = new AbstractMappingSchema(new Map([["t", new Map([["a", "INT"]])]]));
  assert.equal(nonEmpty.empty, false);
});

test("ensureColumnMapping: string / list / dict / Map / null forms", () => {
  assert.deepEqual([...ensureColumnMapping(null).entries()], []);
  assert.deepEqual([...ensureColumnMapping("a:INT, b:VARCHAR").entries()], [["a", "INT"], ["b", "VARCHAR"]]);
  assert.deepEqual([...ensureColumnMapping(["a", "b"]).entries()], [["a", null], ["b", null]]);
  assert.deepEqual([...ensureColumnMapping({ a: "INT" }).entries()], [["a", "INT"]]);
  const m = new Map([["a", "INT"]]);
  assert.equal(ensureColumnMapping(m), m);
});

test("ensureColumnMapping: invalid types raise", () => {
  assert.throws(() => ensureColumnMapping(42), (e) => e instanceof PyValueError);
});

test("flattenSchema: keeps insertion order for numeric-looking keys, at every depth", () => {
  // Map input, not a plain-object literal -- see this file's other numeric-key test
  // for why a `{2: ..., 1: ..., 10: ...}` literal cannot demonstrate this.
  assert.deepEqual(flattenSchema(new Map([["2", 1], ["1", 1], ["10", 1]])), [["2"], ["1"], ["10"]]);
  assert.deepEqual(
    flattenSchema({ b: { x: 1 }, a: { y: 1 } }),
    [["b"], ["a"]],
  );
});

test("nestedSet / nestedGet round-trip through a fresh Map-based structure", () => {
  const d = new Map();
  nestedSet(d, ["top", "second"], "value");
  assert.equal(nestedGet(d, ["top", "top"], ["second", "second"]), "value");

  nestedSet(d, ["top", "third"], "third_value");
  assert.equal(nestedGet(d, ["top", "top"], ["third", "third"]), "third_value");
  assert.equal(nestedGet(d, ["top", "top"], ["second", "second"]), "value");
});

test("nestedGet: missing key raises by default and returns null when raiseOnMissing=false", () => {
  const d = new Map([["this", new Map([["a", 1]])]]);
  assert.throws(() => nestedGet(d, ["this", "this"], ["b", "b"]), (e) => e instanceof PyValueError);
  assert.equal(nestedGet(d, ["this", "this"], ["b", "b"], { raiseOnMissing: false }), null);
});

test("nestedGet: renames the 'this' path segment to 'table' in its error message", () => {
  assert.throws(
    () => nestedGet(new Map(), ["this", "missing_table"]),
    (e) => e instanceof PyValueError && /Unknown table: missing_table/.test(e.message),
  );
});

test("nestedSet: a single key sets directly without descending", () => {
  const d = new Map();
  nestedSet(d, ["k"], "v");
  assert.equal(d.get("k"), "v");
});

test("normalizeName: string input parses to a lower-cased Identifier by default", () => {
  const id = normalizeName("Foo");
  assert.ok(id instanceof exp.Identifier);
  assert.equal(id.name, "foo");
});

test("normalizeName: normalize=false returns the identifier unchanged", () => {
  const id = normalizeName("Foo", null, false, false);
  assert.equal(id.name, "Foo");
});

test("normalizeName: an existing Identifier is copied, not mutated in place", () => {
  const original = exp.parseIdentifier("Foo");
  const normalized = normalizeName(original);
  assert.equal(original.name, "Foo");
  assert.equal(normalized.name, "foo");
});
