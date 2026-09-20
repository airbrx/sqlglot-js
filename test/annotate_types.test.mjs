// Structural/behavioral tests for `src/optimizer/annotate_types.js`'s `TypeAnnotator`
// (AIR-2097), runnable with no Python present.
//
// The deep differential signal (this file's `.type` results vs CPython's
// `sqlglot.optimizer.annotate_types`, over 42 scenarios covering literals, arithmetic
// promotion, TEXT+NUMERIC coercion, string concat, comparisons, CAST/TRY_CAST, real-
// Schema column lookup, fixed-return-type functions, ARRAY nesting, EXTRACT, and NULL
// propagation) lives in `spike/p7/fuzz_annotate_types.mjs` — see that file and
// `gen_annotate_types_ref.py`'s own header for why. These tests assert the same
// `.type` contract directly, with no CPython dependency, so `node --test` alone still
// catches a regression.
//
// A column reference must be TABLE-QUALIFIED for the real Scope-based resolution
// branch to run at all (`_annotate_expression` only enters it when `expr.table` is
// truthy, matching upstream exactly, verified against CPython) — an unqualified
// `SELECT c FROM t` leaves `c` UNKNOWN even with a matching schema, since resolving
// unqualified names is `qualify_columns.py`'s job (AIR-2106, a separate future issue),
// not `annotate_types`'s. Every schema-based scenario below uses a qualified column.

import test from "node:test";
import assert from "node:assert/strict";
import { parseOne } from "../src/dialects/dialect.js";
import { annotate_types, TypeAnnotator, BIGINT_EXTRACT_DATE_PARTS } from "../src/optimizer/annotate_types.js";
import { DType } from "../src/expressions/index.js";
import { ensureSchema } from "../src/schema.js";

function topType(sql, schema = null) {
  const annotated = annotate_types(parseOne(sql), { schema });
  const t = annotated.expressions[0].type;
  return t ? t.this.name : null;
}

test("integer literal annotates as INT", () => {
  assert.equal(topType("SELECT 1"), "INT");
});

test("negative integer literal annotates as INT", () => {
  assert.equal(topType("SELECT -1"), "INT");
});

test("string literal annotates as VARCHAR", () => {
  assert.equal(topType("SELECT 'hello'"), "VARCHAR");
});

test("float literal annotates as DOUBLE", () => {
  assert.equal(topType("SELECT 1.5"), "DOUBLE");
});

test("bare NULL annotates as the dialect's DEFAULT_NULL_TYPE (UNKNOWN for base dialect)", () => {
  assert.equal(topType("SELECT NULL"), "UNKNOWN");
});

test("NULL propagation through a binary operator: NULL is the coercion identity", () => {
  assert.equal(topType("SELECT 1 + NULL"), "INT");
});

test("arithmetic type promotion: INT + INT stays INT", () => {
  assert.equal(topType("SELECT 1 + 2"), "INT");
});

test("arithmetic type promotion: INT + DOUBLE promotes to DOUBLE", () => {
  assert.equal(topType("SELECT 1 + 2.5"), "DOUBLE");
});

test("TEXT + NUMERIC coercion yields the numeric type, either operand order", () => {
  assert.equal(topType("SELECT '5' + 3"), "INT");
  assert.equal(topType("SELECT 3 + '5'"), "INT");
});

test("string concatenation via || annotates as VARCHAR", () => {
  assert.equal(topType("SELECT 'a' || 'b'"), "VARCHAR");
});

test("CONCAT() function annotates as VARCHAR (base EXPRESSION_METADATA fixed return type)", () => {
  assert.equal(topType("SELECT CONCAT('a', 'b')"), "VARCHAR");
});

test("comparison operators always annotate as BOOLEAN", () => {
  assert.equal(topType("SELECT 1 > 2"), "BOOLEAN");
  assert.equal(topType("SELECT 'a' = 'b'"), "BOOLEAN");
  assert.equal(topType("SELECT 1 BETWEEN 0 AND 5"), "BOOLEAN");
  assert.equal(topType("SELECT 1 IS NULL"), "BOOLEAN");
});

test("CAST annotates with the target type", () => {
  assert.equal(topType("SELECT CAST('1' AS INT)"), "INT");
  assert.equal(topType("SELECT CAST(1 AS VARCHAR)"), "VARCHAR");
});

test("TRY_CAST annotates with the target type", () => {
  assert.equal(topType("SELECT TRY_CAST(1 AS FLOAT)"), "FLOAT");
});

test("qualified column type lookup via a real MappingSchema", () => {
  assert.equal(topType("SELECT x.c FROM t AS x", { t: { c: "BIGINT" } }), "BIGINT");
});

test("qualified column type lookup across a two-table JOIN", () => {
  const schema = { ta: { id: "INT", x: "VARCHAR" }, tb: { id: "INT", y: "DOUBLE" } };
  const annotated = annotate_types(
    parseOne("SELECT a.x, b.y FROM ta AS a JOIN tb AS b ON a.id = b.id"),
    { schema },
  );
  assert.equal(annotated.expressions[0].type.this.name, "VARCHAR");
  assert.equal(annotated.expressions[1].type.this.name, "DOUBLE");
});

test("an unqualified column stays UNKNOWN even with a matching schema (qualify_columns's job)", () => {
  assert.equal(topType("SELECT c FROM t", { t: { c: "VARCHAR" } }), "UNKNOWN");
});

test("column type lookup through a derived table's own projection", () => {
  assert.equal(topType("SELECT x.c FROM (SELECT c FROM t) AS x", { t: { c: "INT" } }), "UNKNOWN");
});

test("fixed-return-type functions read the base EXPRESSION_METADATA table", () => {
  assert.equal(topType("SELECT LENGTH('abc')"), "INT");
  assert.equal(topType("SELECT UPPER('a')"), "VARCHAR");
  assert.equal(topType("SELECT SQRT(4)"), "DOUBLE");
  assert.equal(topType("SELECT MD5('x')"), "VARCHAR");
});

test("ARRAY(...) annotates as a nested ARRAY<INT> type", () => {
  const annotated = annotate_types(parseOne("SELECT ARRAY(1, 2, 3)"));
  const t = annotated.expressions[0].type;
  assert.equal(t.this.name, "ARRAY");
  assert.equal(t.args.nested, true);
  assert.equal(t.expressions[0].this.name, "INT");
});

test("EXTRACT dispatches on the part name, including the BIGINT_EXTRACT_DATE_PARTS set", () => {
  assert.equal(topType("SELECT EXTRACT(DAY FROM x) FROM t", { t: { x: "DATE" } }), "INT");
  assert.equal(
    topType("SELECT EXTRACT(EPOCH_SECOND FROM x) FROM t", { t: { x: "TIMESTAMP" } }),
    "BIGINT",
  );
  assert.ok(BIGINT_EXTRACT_DATE_PARTS.has("EPOCH_SECOND"));
  assert.ok(!BIGINT_EXTRACT_DATE_PARTS.has("DAY"));
});

test("TypeAnnotator is directly constructible against a real MappingSchema and dialect-defaults its EXPRESSION_METADATA", () => {
  const schema = ensureSchema({ t: { c: "VARCHAR" } });
  const annotator = new TypeAnnotator(schema);
  assert.equal(annotator.expressionMetadata.size, 294);
  const ast = annotator.annotate(parseOne("SELECT x.c FROM t AS x"));
  assert.equal(ast.expressions[0].type.this.name, "VARCHAR");
});

test("TypeAnnotator.COERCES_TO orders numeric precedence highest-to-lowest", () => {
  assert.ok(TypeAnnotator.COERCES_TO.get(DType.INT).has(DType.BIGINT));
  assert.ok(!TypeAnnotator.COERCES_TO.get(DType.BIGINT).has(DType.INT));
});

test("annotate_types is idempotent on an already-annotated tree", () => {
  const schema = { t: { c: "BIGINT" } };
  const first = annotate_types(parseOne("SELECT x.c FROM t AS x"), { schema });
  const second = annotate_types(first, { schema });
  assert.equal(second.expressions[0].type.this.name, "BIGINT");
});
