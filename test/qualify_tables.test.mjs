// Structural/behavioral tests for `src/optimizer/qualify_tables.js`, runnable with no
// Python present.
//
// The deep differential signal (this file's output vs CPython's
// `sqlglot.optimizer.qualify_tables`, over 26 scenarios) lives in
// `spike/p7/fuzz_qualify_tables.mjs` — see that file and `gen_qualify_tables_ref.py`'s
// own header for why. These tests assert the same rendered-SQL contract directly, with
// no CPython dependency, so `node --test` alone still catches a regression.

import test from "node:test";
import assert from "node:assert/strict";
import { parseOne } from "../src/dialects/dialect.js";
import { qualify_tables } from "../src/optimizer/qualify_tables.js";
import "../src/generator.js";
import "../src/dialects/snowflake.js";

const qualify = (sql, options) => qualify_tables(parseOne(sql), options).sql();

test("module docstring example: db= qualifies a bare table and gives it its own alias", () => {
  assert.equal(qualify("SELECT 1 FROM tbl", { db: "db" }), "SELECT 1 FROM db.tbl AS tbl");
});

test("module docstring example: a join construct as a subquery expands to a real SELECT", () => {
  assert.equal(
    qualify("SELECT 1 FROM (t1 JOIN t2) AS t"),
    "SELECT 1 FROM (SELECT * FROM t1 AS t1, t2 AS t2) AS t",
  );
});

test("an unaliased table gets a synthetic alias equal to its own name", () => {
  assert.equal(qualify("SELECT 1 FROM tbl"), "SELECT 1 FROM tbl AS tbl");
});

test("an already-aliased table is left untouched", () => {
  assert.equal(qualify("SELECT 1 FROM tbl AS t"), "SELECT 1 FROM tbl AS t");
});

test("a CTE reference is qualified as a source, but the CTE's own name is excluded from db=", () => {
  assert.equal(
    qualify("WITH cte AS (SELECT 1 AS a) SELECT a FROM cte, tbl", { db: "db" }),
    "WITH cte AS (SELECT 1 AS a) SELECT a FROM cte AS cte, db.tbl AS tbl",
  );
});

test("nested CTEs referencing each other each get their own reference alias", () => {
  assert.equal(
    qualify("WITH a AS (SELECT 1 AS x), b AS (SELECT x FROM a) SELECT x FROM b"),
    "WITH a AS (SELECT 1 AS x), b AS (SELECT x FROM a AS a) SELECT x FROM b AS b",
  );
});

test("an unaliased derived table gets a synthetic `_N` alias", () => {
  assert.equal(qualify("SELECT 1 FROM (SELECT * FROM x)"), "SELECT 1 FROM (SELECT * FROM x AS x) AS _0");
});

test("an already-aliased derived table is left untouched", () => {
  assert.equal(
    qualify("SELECT 1 FROM (SELECT * FROM x) AS y"),
    "SELECT 1 FROM (SELECT * FROM x AS x) AS y",
  );
});

test("three unaliased joined tables each get distinct, non-colliding aliases", () => {
  assert.equal(
    qualify("SELECT * FROM t1 JOIN t2 ON t1.a = t2.a JOIN t3 ON t2.a = t3.a"),
    "SELECT * FROM t1 AS t1 JOIN t2 AS t2 ON t1.a = t2.a JOIN t3 AS t3 ON t2.a = t3.a",
  );
});

test("catalog= is dropped without db= (the catalog-requires-db guard)", () => {
  assert.equal(qualify("SELECT 1 FROM tbl", { catalog: "c" }), "SELECT 1 FROM tbl AS tbl");
});

test("db= does not overwrite a db already present on the table", () => {
  assert.equal(qualify("SELECT 1 FROM d0.tbl", { db: "db" }), "SELECT 1 FROM d0.tbl AS tbl");
});

test("db=/catalog= together qualify a bare table", () => {
  assert.equal(qualify("SELECT 1 FROM tbl", { db: "d", catalog: "c" }), "SELECT 1 FROM c.d.tbl AS tbl");
});

test("canonicalizeTableAliases rewrites both sources and column references", () => {
  assert.equal(
    qualify("SELECT t1.id FROM t1 JOIN t2 ON t1.id = t2.id", { canonicalizeTableAliases: true }),
    "SELECT _0.id FROM t1 AS _0 JOIN t2 AS _1 ON _0.id = _1.id",
  );
});

test("canonicalizeTableAliases numbering resets on every call (own closure per invocation)", () => {
  const first = qualify("SELECT * FROM t1", { canonicalizeTableAliases: true });
  const second = qualify("SELECT * FROM t2", { canonicalizeTableAliases: true });
  assert.equal(first, "SELECT * FROM t1 AS _0");
  assert.equal(second, "SELECT * FROM t2 AS _0");
});

test("a bare subquery in WHERE is qualified independently of the outer FROM", () => {
  assert.equal(
    qualify("SELECT * FROM x WHERE a IN (SELECT b FROM y)"),
    "SELECT * FROM x AS x WHERE a IN (SELECT b FROM y AS y)",
  );
});

test("a UNION qualifies each side's FROM clause independently", () => {
  assert.equal(
    qualify("SELECT * FROM x UNION SELECT * FROM y"),
    "SELECT * FROM x AS x UNION SELECT * FROM y AS y",
  );
});

test("an unaliased table-valued function source gets a synthetic alias", () => {
  assert.equal(qualify("SELECT * FROM my_func(1, 2)"), "SELECT * FROM MY_FUNC(1, 2) AS _0");
});

test("an unaliased VALUES source gets a synthetic alias and synthetic column names", () => {
  assert.equal(
    qualify("SELECT * FROM (VALUES (1, 2))"),
    "SELECT * FROM (VALUES (1, 2)) AS _0(_col_0, _col_1)",
  );
});

test("a VALUES source with explicit columns is left untouched", () => {
  assert.equal(
    qualify("SELECT * FROM (VALUES (1, 2)) AS v(a, b)"),
    "SELECT * FROM (VALUES (1, 2)) AS v(a, b)",
  );
});

test("dialect: 'snowflake' normalizes db= and the synthetic alias to upper case", () => {
  assert.equal(
    qualify("SELECT 1 FROM tbl", { db: "db", dialect: "snowflake" }),
    "SELECT 1 FROM DB.tbl AS TBL",
  );
});

test("qualify_tables returns the same expression instance it was given", () => {
  const ast = parseOne("SELECT 1 FROM tbl");
  const out = qualify_tables(ast);
  assert.equal(out, ast);
});
