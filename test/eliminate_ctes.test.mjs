// Structural/behavioral tests for `src/optimizer/eliminate_ctes.js` and its dependency
// `src/optimizer/journal.js`, runnable with no Python present.
//
// The deep differential signal for `eliminate_ctes.js` (this file's output vs
// CPython's `sqlglot.optimizer.eliminate_ctes`, over 9 scenarios) lives in
// `spike/p7/fuzz_eliminate_ctes.mjs` -- see that file and `gen_eliminate_ctes_ref.py`'s
// own header for why. These tests assert the same rendered-SQL contract directly, with
// no CPython dependency, so `node --test` alone still catches a regression.
//
// `journal.js` has no independent observable SQL-level behavior of its own (it's a
// generic mutation-rollback list, not a transform), so it has no CPython oracle -- it
// is covered here directly: a `record` then `revert` round-trip must restore the exact
// original value, exercised both in isolation and through `eliminate_ctes`'s own
// `journal` parameter.

import test from "node:test";
import assert from "node:assert/strict";
import { parseOne } from "../src/dialects/dialect.js";
import { eliminate_ctes } from "../src/optimizer/eliminate_ctes.js";
import { record, revert } from "../src/optimizer/journal.js";
import "../src/generator.js";

const run = (sql) => eliminate_ctes(parseOne(sql)).sql();

test("module docstring example: an unused CTE is removed along with the WITH clause", () => {
  assert.equal(run("WITH y AS (SELECT a FROM x) SELECT a FROM z"), "SELECT a FROM z");
});

test("a CTE referenced exactly once is kept, not inlined", () => {
  assert.equal(
    run("WITH y AS (SELECT a FROM x) SELECT a FROM y"),
    "WITH y AS (SELECT a FROM x) SELECT a FROM y",
  );
});

test("multiple CTEs where only some are unused: the used one and the WITH clause survive", () => {
  assert.equal(
    run("WITH a AS (SELECT 1), b AS (SELECT 2), c AS (SELECT 3) SELECT * FROM b"),
    "WITH b AS (SELECT 2) SELECT * FROM b",
  );
});

test("a chain of unused CTEs is removed in a single reverse pass", () => {
  assert.equal(
    run("WITH a AS (SELECT * FROM x), b AS (SELECT * FROM a), c AS (SELECT * FROM b) SELECT 1"),
    "SELECT 1",
  );
});

test("a CTE that references another used CTE: both are kept", () => {
  assert.equal(
    run("WITH a AS (SELECT * FROM x), b AS (SELECT * FROM a) SELECT * FROM b"),
    "WITH a AS (SELECT * FROM x), b AS (SELECT * FROM a) SELECT * FROM b",
  );
});

test("no WITH clause at all: passes through untouched", () => {
  assert.equal(run("SELECT a FROM x"), "SELECT a FROM x");
});

test("a CTE referenced only via a SEMI or ANTI join is kept", () => {
  assert.equal(
    run("WITH a AS (SELECT id FROM x) SELECT * FROM y SEMI JOIN a ON y.id = a.id"),
    "WITH a AS (SELECT id FROM x) SELECT * FROM y SEMI JOIN a ON y.id = a.id",
  );
  assert.equal(
    run("WITH a AS (SELECT id FROM x) SELECT * FROM y ANTI JOIN a ON y.id = a.id"),
    "WITH a AS (SELECT id FROM x) SELECT * FROM y ANTI JOIN a ON y.id = a.id",
  );
});

test("a CTE referenced only from a correlated WHERE-clause subquery is kept", () => {
  assert.equal(
    run("WITH a AS (SELECT id FROM x) SELECT * FROM y WHERE y.id IN (SELECT id FROM a)"),
    "WITH a AS (SELECT id FROM x) SELECT * FROM y WHERE y.id IN (SELECT id FROM a)",
  );
});

test("journal: record then revert restores the original argument value", () => {
  const ast = parseOne("SELECT a, b FROM x");
  const select = ast;
  const journal = [];
  const original = select.args.expressions;

  record(journal, select, "expressions");
  select.set("expressions", []);
  assert.equal(select.args.expressions.length, 0);

  revert(journal);
  assert.equal(journal.length, 0);
  assert.deepEqual(select.args.expressions.map((e) => e.sql()), original.map((e) => e.sql()));
});

test("journal: record shallow-copies list values so later mutation doesn't corrupt it", () => {
  const ast = parseOne("SELECT a, b FROM x");
  const journal = [];
  record(journal, ast, "expressions");

  // Mutate the live list AFTER recording; the journal's own copy must be unaffected.
  ast.args.expressions.push(ast.args.expressions[0]);
  assert.equal(journal[0][2].length, 2);

  revert(journal);
  assert.equal(ast.args.expressions.length, 2);
});

test("eliminate_ctes with a journal records exactly the mutations needed to revert it", () => {
  const sql = "WITH y AS (SELECT a FROM x) SELECT a FROM z";
  const ast = parseOne(sql);
  const journal = [];

  const out = eliminate_ctes(ast, journal);
  assert.equal(out.sql(), "SELECT a FROM z");
  assert.ok(journal.length > 0);

  revert(journal);
  assert.equal(ast.sql(), sql);
  assert.equal(journal.length, 0);
});

test("eliminate_ctes with a journal on a query with nothing to remove leaves it empty", () => {
  const ast = parseOne("WITH y AS (SELECT a FROM x) SELECT a FROM y");
  const journal = [];
  eliminate_ctes(ast, journal);
  assert.equal(journal.length, 0);
});
