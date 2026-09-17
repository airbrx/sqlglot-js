// Structural/behavioral tests for `src/optimizer/isolate_table_selects.js`, runnable
// with no Python present.
//
// The deep differential signal (this file's output vs CPython's
// `sqlglot.optimizer.isolate_table_selects`, over 11 scenarios plus an idempotency
// check) lives in `spike/p7/fuzz_isolate_table_selects.mjs` — see that file and
// `gen_isolate_table_selects_ref.py`'s own header for why. These tests assert the same
// rendered-SQL contract directly, with no CPython dependency, so `node --test` alone
// still catches a regression.

import test from "node:test";
import assert from "node:assert/strict";
import { parseOne } from "../src/dialects/dialect.js";
import { isolate_table_selects } from "../src/optimizer/isolate_table_selects.js";
import { OptimizeError } from "../src/errors.js";
import "../src/generator.js";

const TWO_TABLE_SCHEMA = { t1: { x: "int" }, t2: { y: "int" } };

const isolate = (sql, schema) => isolate_table_selects(parseOne(sql), { schema }).sql();

test("a comma-joined multi-source query gets each table wrapped in its own subquery", () => {
  assert.equal(
    isolate("SELECT * FROM t1 AS a, t2 AS b", TWO_TABLE_SCHEMA),
    "SELECT * FROM (SELECT * FROM t1 AS a) AS a, (SELECT * FROM t2 AS b) AS b",
  );
});

test("an explicit JOIN is isolated the same way as a comma-join", () => {
  assert.equal(
    isolate("SELECT * FROM t1 AS a JOIN t2 AS b ON a.x = b.y", TWO_TABLE_SCHEMA),
    "SELECT * FROM (SELECT * FROM t1 AS a) AS a JOIN (SELECT * FROM t2 AS b) AS b ON a.x = b.y",
  );
});

test("a single bare table is left untouched (only one selected source)", () => {
  assert.equal(isolate("SELECT * FROM t1", { t1: { x: "int" } }), "SELECT * FROM t1");
});

test("a single aliased table is left untouched", () => {
  assert.equal(isolate("SELECT * FROM t1 AS a", { t1: { x: "int" } }), "SELECT * FROM t1 AS a");
});

test("a real table alongside an unrelated derived table is still a single real source", () => {
  assert.equal(
    isolate("SELECT * FROM t1 AS a, (SELECT 1 AS x) AS d", { t1: { x: "int" } }),
    "SELECT * FROM (SELECT * FROM t1 AS a) AS a, (SELECT 1 AS x) AS d",
  );
});

test("no schema at all (default) skips isolating entirely", () => {
  assert.equal(isolate("SELECT * FROM t1 AS a, t2 AS b", undefined), "SELECT * FROM t1 AS a, t2 AS b");
});

test("an empty schema mapping skips isolating entirely", () => {
  assert.equal(isolate("SELECT * FROM t1 AS a, t2 AS b", {}), "SELECT * FROM t1 AS a, t2 AS b");
});

test("a table missing from the schema is left untouched; a known one is still isolated", () => {
  assert.equal(
    isolate("SELECT * FROM t1 AS a, t2 AS b", { t1: { x: "int" } }),
    "SELECT * FROM (SELECT * FROM t1 AS a) AS a, t2 AS b",
  );
});

test("a source that is already a derived table (Subquery) is skipped", () => {
  assert.equal(
    isolate("SELECT * FROM (SELECT * FROM t1) AS s, t2 AS b", TWO_TABLE_SCHEMA),
    "SELECT * FROM (SELECT * FROM t1) AS s, (SELECT * FROM t2 AS b) AS b",
  );
});

test("a multi-source, schema-known table with no alias raises OptimizeError", () => {
  assert.throws(
    () => isolate("SELECT * FROM t1, t2", TWO_TABLE_SCHEMA),
    (err) => err instanceof OptimizeError && err.message === "Tables require an alias. Run qualify_tables optimization.",
  );
});

test("running the transform twice is idempotent (second pass sees a Subquery, not a Table)", () => {
  const schema = TWO_TABLE_SCHEMA;
  const once = isolate_table_selects(parseOne("SELECT * FROM t1 AS a, t2 AS b"), { schema });
  const onceSql = once.sql();
  const twiceSql = isolate_table_selects(once, { schema }).sql();
  assert.equal(onceSql, "SELECT * FROM (SELECT * FROM t1 AS a) AS a, (SELECT * FROM t2 AS b) AS b");
  assert.equal(twiceSql, onceSql);
});
