// Structural/behavioral tests for `src/optimizer/eliminate_subqueries.js`, runnable
// with no Python present.
//
// The deep differential signal (this file's output vs CPython's `sqlglot.optimizer.
// eliminate_subqueries`, over 15 scenarios) lives in `spike/p7/fuzz_eliminate_
// subqueries.mjs` -- see that file and `gen_eliminate_subqueries_ref.py`'s own header
// for why. These tests assert the same rendered-SQL contract directly, with no CPython
// dependency, so `node --test` alone still catches a regression.

import test from "node:test";
import assert from "node:assert/strict";
import { parseOne } from "../src/dialects/dialect.js";
import * as exp from "../src/expressions/index.js";
import { eliminate_subqueries } from "../src/optimizer/eliminate_subqueries.js";
import "../src/generator.js";

const run = (sql) => eliminate_subqueries(parseOne(sql)).sql();

test("module docstring example: a single derived table becomes a CTE", () => {
  assert.equal(
    run("SELECT a FROM (SELECT * FROM x) AS y"),
    "WITH y AS (SELECT * FROM x) SELECT a FROM y AS y",
  );
});

test("module docstring example: two structurally identical derived tables dedup to one CTE", () => {
  assert.equal(
    run("SELECT a FROM (SELECT * FROM x) AS y CROSS JOIN (SELECT * FROM x) AS z"),
    "WITH y AS (SELECT * FROM x) SELECT a FROM y AS y CROSS JOIN y AS z",
  );
});

test("a derived table whose inner query is a UNION becomes a CTE", () => {
  assert.equal(
    run("SELECT a FROM (SELECT * FROM x UNION ALL SELECT * FROM y) AS z"),
    "WITH z AS (SELECT * FROM x UNION ALL SELECT * FROM y) SELECT a FROM z AS z",
  );
});

test("a derived table duplicating an existing top-level CTE reuses its alias", () => {
  assert.equal(
    run("WITH w AS (SELECT * FROM x) SELECT a FROM w CROSS JOIN (SELECT * FROM x) AS y"),
    "WITH w AS (SELECT * FROM x) SELECT a FROM w CROSS JOIN w AS y",
  );
});

test("no derived tables or CTEs: the query passes through untouched", () => {
  assert.equal(run("SELECT a FROM x"), "SELECT a FROM x");
  assert.equal(run("SELECT * FROM x UNION SELECT * FROM y"), "SELECT * FROM x UNION SELECT * FROM y");
});

test("a derived table nested inside an existing CTE is hoisted BEFORE it (DAG order)", () => {
  assert.equal(
    run("WITH w AS (SELECT * FROM (SELECT * FROM x) AS inner_) SELECT * FROM w"),
    "WITH inner_ AS (SELECT * FROM x), w AS (SELECT * FROM inner_ AS inner_) SELECT * FROM w",
  );
});

test("a Subquery-rooted expression recurses into its own `this`, leaving the wrapper alone", () => {
  assert.equal(
    run("(SELECT a FROM (SELECT * FROM x) AS y) LIMIT 1"),
    "(WITH y AS (SELECT * FROM x) SELECT a FROM y AS y) LIMIT 1",
  );
});

test("a LATERAL correlated subquery is never eliminated", () => {
  assert.equal(
    run("SELECT * FROM x, LATERAL (SELECT * FROM y WHERE y.a = x.a) AS z"),
    "SELECT * FROM x, LATERAL (SELECT * FROM y WHERE y.a = x.a) AS z",
  );
});

test("a WHERE-clause (value-position) subquery is never eliminated", () => {
  assert.equal(
    run("SELECT a FROM x WHERE x.id IN (SELECT id FROM y)"),
    "SELECT a FROM x WHERE x.id IN (SELECT id FROM y)",
  );
});

test("WITH RECURSIVE: the recursive flag survives an otherwise-unchanged rebuild", () => {
  assert.equal(
    run("WITH RECURSIVE w AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM w WHERE n < 5) SELECT * FROM w"),
    "WITH RECURSIVE w AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM w WHERE n < 5) SELECT * FROM w",
  );
});

test("an aliased derived table colliding with a real table reference gets a bumped name", () => {
  assert.equal(
    run("SELECT a FROM (SELECT * FROM x) AS t CROSS JOIN t"),
    "WITH t_2 AS (SELECT * FROM x) SELECT a FROM t_2 AS t CROSS JOIN t",
  );
});

test("unaliased derived tables fall back to the synthetic cte/cte_2 base names", () => {
  assert.equal(
    run("SELECT a FROM (SELECT * FROM x)"),
    "WITH cte AS (SELECT * FROM x) SELECT a FROM cte AS cte",
  );
  assert.equal(
    run("SELECT a FROM (SELECT * FROM x) CROSS JOIN (SELECT * FROM y)"),
    "WITH cte AS (SELECT * FROM x), cte_2 AS (SELECT * FROM y) SELECT a FROM cte AS cte CROSS JOIN cte_2 AS cte_2",
  );
});

test("UPDATE ... FROM (subquery): a genuine upstream structural no-op, not a bug", () => {
  // `_traverse_scope`'s DML branch never links a FROM/USING-position Subquery into
  // `root.table_scopes`, so it is never visited by the elimination loop and stays
  // completely untouched -- see `gen_eliminate_subqueries_ref.py`'s header.
  assert.equal(
    run("UPDATE t SET a = 1 FROM (SELECT id FROM x) AS s WHERE t.id = s.id"),
    "UPDATE t SET a = 1 FROM (SELECT id FROM x) AS s WHERE t.id = s.id",
  );
});

test("a PIVOTed derived table is never eliminated (parent_scope.pivots guard)", () => {
  // `_parse_pivot` is not ported yet (parser.py:5404, unrelated to this issue), so no
  // SQL string can reach this branch through `parseOne` -- see `gen_eliminate_
  // subqueries_ref.py`'s header. Built by hand instead: a derived table whose PARENT
  // scope has a non-empty `pivots` list, which must short-circuit `_eliminate_derived_
  // table` before it ever touches the tree.
  // `pivot_sql` isn't ported yet either (generator.py:2600), so this asserts
  // structurally (no CTE was created, the derived table is untouched by identity)
  // rather than via `.sql()`.
  const innerSelect = exp.select("*").from_("x");
  const derivedTable = innerSelect.subquery("y", { copy: false });
  const pivot = new exp.Pivot({ expressions: [exp.column("a")] });
  derivedTable.set("pivots", [pivot]);
  const outerSelect = exp.select("*").from_(derivedTable, { copy: false });

  eliminate_subqueries(outerSelect);
  assert.equal(outerSelect.args.with_, undefined);
  assert.equal(outerSelect.args.from_.this, derivedTable);
});
