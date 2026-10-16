// Structural/behavioral tests for `src/optimizer/canonicalize_internal_names.js`,
// runnable with no Python present.
//
// The deep differential signal (this file's output vs CPython's
// `sqlglot.optimizer.canonicalize_internal_names`, over all 65 real pairs in
// `tests/fixtures/optimizer/canonicalize_internal_names.sql`) lives in
// `spike/p7/fuzz_fixture_replay.mjs` (AIR-2315 Part 3) -- see that file and
// `gen_fixture_replay_ref.py`'s own header for the full driver. These tests assert
// the same rendered-SQL contract directly, with no CPython dependency, so
// `node --test` alone still catches a regression. Scenarios below are a representative
// subset of the real fixture's own titles (same SQL and expected output), not
// independently invented.

import test from "node:test";
import assert from "node:assert/strict";
import { parseOne } from "../src/dialects/dialect.js";
import { qualify } from "../src/optimizer/qualify.js";
import { canonicalize_internal_names } from "../src/optimizer/canonicalize_internal_names.js";
import "../src/dialects/bigquery.js";
import "../src/dialects/duckdb.js";
import "../src/generator.js";

const SCHEMA = {
  x: { a: "INT", b: "INT" },
  y: { b: "INT", c: "INT" },
  z: { b: "INT", c: "INT" },
  pvt: { c: "TEXT", v: "INT" },
};

function run(sql, options = {}) {
  const ast = parseOne(sql, { read: options.dialect });
  const qualified = qualify(ast, { schema: SCHEMA, catalog: "c", db: "db", dialect: options.dialect });
  return canonicalize_internal_names(qualified).sql(options.dialect);
}

test("module docstring example: a CTE is renamed and its columns get sequential handles", () => {
  const ast = parseOne("WITH t AS (SELECT c1, c2 FROM c.db.src) SELECT * FROM t");
  const qualified = qualify(ast, { schema: { src: { c1: "INT", c2: "INT" } } });
  assert.equal(
    canonicalize_internal_names(qualified).sql(),
    'WITH "_t1" AS (SELECT "_t0"."c1" AS "_c0", "_t0"."c2" AS "_c1" FROM "c"."db"."src" AS "_t0") ' +
      'SELECT "_t1"."_c0" AS "c1", "_t1"."_c1" AS "c2" FROM "_t1" AS "_t1"',
  );
});

test("simple select: base-table columns and top-level alias are preserved", () => {
  assert.equal(run("SELECT a FROM x"), 'SELECT "_t0"."a" AS "a" FROM "c"."db"."x" AS "_t0"');
});

test("single cte: internal column aliases become sequential, outer alias stays a data contract", () => {
  assert.equal(
    run("WITH t AS (SELECT a, b FROM x) SELECT * FROM t"),
    'WITH "_t1" AS (SELECT "_t0"."a" AS "_c0", "_t0"."b" AS "_c1" FROM "c"."db"."x" AS "_t0") ' +
      'SELECT "_t1"."_c0" AS "a", "_t1"."_c1" AS "b" FROM "_t1" AS "_t1"',
  );
});

test("self join: each reference to the same base table gets a distinct canonical alias", () => {
  assert.equal(
    run("SELECT a.a, b.b FROM x AS a JOIN x AS b ON a.a = b.b"),
    'SELECT "_t0"."a" AS "a", "_t1"."b" AS "b" FROM "c"."db"."x" AS "_t0" ' +
      'JOIN "c"."db"."x" AS "_t1" ON "_t0"."a" = "_t1"."b"',
  );
});

test("union: output names come from the left branch only", () => {
  assert.equal(
    run("SELECT a FROM x UNION SELECT b FROM y"),
    'SELECT "_t0"."a" AS "a" FROM "c"."db"."x" AS "_t0" UNION SELECT "_t1"."b" AS "_c0" FROM "c"."db"."y" AS "_t1"',
  );
});

test("union by name: matching column names across branches unify to one canonical name", () => {
  assert.equal(
    run("SELECT a, b FROM x UNION BY NAME SELECT b, c FROM z", { dialect: "duckdb" }),
    'SELECT "_t0"."a" AS "a", "_t0"."b" AS "b" FROM "c"."db"."x" AS "_t0" UNION BY NAME ' +
      'SELECT "_t1"."b" AS "b", "_t1"."c" AS "c" FROM "c"."db"."z" AS "_t1"',
  );
});

test("bigquery unnest with offset: both the primary and offset pseudo-columns are canonicalized", () => {
  assert.equal(
    run("SELECT n, off FROM UNNEST([10, 20, 30]) AS n WITH OFFSET AS off", { dialect: "bigquery" }),
    "SELECT `_c0` AS `n`, `_c1` AS `off` FROM UNNEST([10, 20, 30]) AS `_c0` WITH OFFSET AS `_c1`",
  );
});

test("pivot with a user alias: the alias is canonicalized but IN-literal output names are preserved", () => {
  assert.equal(
    run("SELECT my_pivot.x FROM pvt PIVOT(SUM(v) FOR c IN ('x')) AS my_pivot", { dialect: "bigquery" }),
    "SELECT `_t1`.`x` AS `x` FROM `c`.`db`.`pvt` AS `_t0` PIVOT(SUM(`_t0`.`v`) FOR `_t0`.`c` IN ('x')) AS `_t1`",
  );
});

test("recursive cte: the self-reference and the base definition share the same canonical name", () => {
  assert.equal(
    run("WITH RECURSIVE cte AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM cte WHERE n < 5) SELECT * FROM cte"),
    'WITH RECURSIVE "_t0" AS (SELECT 1 AS "_c0" UNION ALL SELECT "_t0"."_c0" + 1 AS "_c1" FROM "_t0" AS "_t0" ' +
      'WHERE "_t0"."_c0" < 5) SELECT "_t0"."_c0" AS "n" FROM "_t0" AS "_t0"',
  );
});

test("non-Query input (e.g. a bare expression) passes through untouched", () => {
  const ast = parseOne("a + 1");
  assert.equal(canonicalize_internal_names(ast), ast);
});
