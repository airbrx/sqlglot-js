// Structural/behavioral tests for `src/optimizer/eliminate_joins.js`, runnable with no
// Python present.
//
// The deep differential signal (this file's output vs CPython's
// `sqlglot.optimizer.eliminate_joins`, over the real upstream fixture corpus plus 7
// `join_condition` branch scenarios) lives in `spike/p10/fuzz_eliminate_joins.mjs` --
// see that file and `gen_eliminate_joins_ref.py`'s own header for why. These tests
// assert the same rendered-SQL contract directly, with no CPython dependency, so
// `node --test` alone still catches a regression. Scenarios below are drawn from
// `tests/fixtures/optimizer/eliminate_joins.sql` (compacted to single-line SQL; this
// port's own `.sql()` default is not pretty-printed).

import test from "node:test";
import assert from "node:assert/strict";
import { parseOne } from "../src/dialects/dialect.js";
import { eliminate_joins, join_condition } from "../src/optimizer/eliminate_joins.js";
import "../src/generator.js";

const run = (sql) => eliminate_joins(parseOne(sql)).sql();

test("module docstring example: LEFT JOIN on a DISTINCT derived table is removed", () => {
  assert.equal(
    run("SELECT x.a FROM x LEFT JOIN (SELECT DISTINCT y.b FROM y) AS y ON x.b = y.b"),
    "SELECT x.a FROM x",
  );
});

test("LEFT JOIN on a grouped derived table is removed", () => {
  assert.equal(
    run("SELECT x.a FROM x LEFT JOIN (SELECT y.b, SUM(y.c) FROM y GROUP BY y.b) AS y ON x.b = y.b"),
    "SELECT x.a FROM x",
  );
});

test("LEFT JOIN on an aggregate (single-output-row) derived table is removed", () => {
  assert.equal(
    run("SELECT x.a FROM x LEFT JOIN (SELECT SUM(y.b) AS b FROM y) AS y ON x.b = y.b"),
    "SELECT x.a FROM x",
  );
});

test("Noop: not all DISTINCT columns are in the join condition", () => {
  const sql = "SELECT x.a FROM x LEFT JOIN (SELECT DISTINCT y.b, y.c FROM y) AS y ON x.b = y.b";
  assert.equal(run(sql), parseOne(sql).sql());
});

test("Noop: not all grouped columns are in the join condition", () => {
  const sql = "SELECT x.a FROM x LEFT JOIN (SELECT y.b, y.c FROM y GROUP BY y.b, y.c) AS y ON x.b = y.b";
  assert.equal(run(sql), parseOne(sql).sql());
});

test("Noop: not a LEFT join", () => {
  const sql = "SELECT x.a FROM x JOIN (SELECT DISTINCT y.b FROM y) AS y ON x.b = y.b";
  assert.equal(run(sql), parseOne(sql).sql());
});

test("Noop: unqualified columns in the outer scope block the rule entirely", () => {
  const sql = "SELECT a FROM x LEFT JOIN (SELECT DISTINCT y.b FROM y) AS y ON x.b = y.b";
  assert.equal(run(sql), parseOne(sql).sql());
});

test("Noop: a plain CROSS JOIN (no ON, not a single-output-row source) is kept", () => {
  const sql = "SELECT a FROM x CROSS JOIN (SELECT DISTINCT y.b FROM y) AS y";
  assert.equal(run(sql), parseOne(sql).sql());
});

test("Noop: a column from the joined source is used outside the ON clause", () => {
  const sql = "SELECT x.a, y.b FROM x LEFT JOIN (SELECT DISTINCT y.b FROM y) AS y ON x.b = y.b";
  assert.equal(run(sql), parseOne(sql).sql());
});

test("multiple GROUP BY columns all present in the join condition: removed", () => {
  assert.equal(
    run(
      "SELECT x.a FROM x LEFT JOIN (SELECT y.b AS b, y.c + 1 AS d, COUNT(1) FROM y GROUP BY y.b, y.c + 1) "
      + "AS y ON x.b = y.b AND 1 = y.d",
    ),
    "SELECT x.a FROM x",
  );
});

test("a chain of LEFT JOINs is removed in a single reverse pass", () => {
  assert.equal(
    run(
      "SELECT x.a FROM x "
      + "LEFT JOIN (SELECT y.b AS b FROM y GROUP BY y.b) AS y ON x.b = y.b "
      + "LEFT JOIN (SELECT y.b AS c FROM y GROUP BY y.b) AS z ON y.b = z.c",
    ),
    "SELECT x.a FROM x",
  );
});

test("a LEFT JOIN on a CTE source is removed, but the now-unreferenced CTE itself is kept", () => {
  assert.equal(
    run("WITH z AS (SELECT DISTINCT y.b FROM y) SELECT x.a FROM x LEFT JOIN z ON x.b = z.b"),
    "WITH z AS (SELECT DISTINCT y.b FROM y) SELECT x.a FROM x",
  );
});

test("Noop: not every grouped expression is in the derived table's own outputs", () => {
  const sql = "SELECT x.a FROM x LEFT JOIN (SELECT y.b FROM y GROUP BY y.b, y.c) AS y ON x.b = y.b";
  assert.equal(run(sql), parseOne(sql).sql());
});

test("CROSS JOIN on an aggregate (single-output-row) derived table is removed", () => {
  assert.equal(
    run("SELECT x.a FROM x CROSS JOIN (SELECT SUM(y.b) AS b FROM y) AS y"),
    "SELECT x.a FROM x",
  );
});

test("CROSS JOIN on a derived table with LIMIT 1 is removed", () => {
  assert.equal(
    run("SELECT x.a FROM x CROSS JOIN (SELECT y.b AS b FROM y LIMIT 1) AS y"),
    "SELECT x.a FROM x",
  );
});

test("CROSS JOIN on a derived table with no FROM clause is removed", () => {
  assert.equal(
    run("SELECT x.a FROM x CROSS JOIN (SELECT 1 AS b, 2 AS c) AS y"),
    "SELECT x.a FROM x",
  );
});

test("Noop: CROSS JOIN on a non-aggregate, non-single-row subquery is kept", () => {
  const sql = "SELECT x.a FROM x CROSS JOIN (SELECT y.b FROM y) AS y";
  assert.equal(run(sql), parseOne(sql).sql());
});

test("a LEFT ANTI JOIN is never eliminated, even when its source is otherwise eligible", () => {
  const sql = "SELECT x.b FROM x LEFT ANTI JOIN (SELECT 1 AS b) AS sub ON x.b = sub.b";
  assert.equal(run(sql), parseOne(sql).sql());
});

test("a SEMI JOIN is never eliminated either", () => {
  const sql = "SELECT x.b FROM x LEFT SEMI JOIN (SELECT 1 AS b) AS sub ON x.b = sub.b";
  assert.equal(run(sql), parseOne(sql).sql());
});

test("join_condition: CNF branch extracts a single EQ key and replaces it with TRUE", () => {
  const join = parseOne("SELECT * FROM x JOIN y ON x.a = y.b").args.joins[0];
  const [sourceKey, joinKey, on] = join_condition(join);
  assert.deepEqual(sourceKey.map((e) => e.sql()), ["x.a"]);
  assert.deepEqual(joinKey.map((e) => e.sql()), ["y.b"]);
  assert.equal(on.sql(), "TRUE AND TRUE");
});

test("join_condition: CNF branch keeps a non-EQ conjunct untouched", () => {
  const join = parseOne("SELECT * FROM x JOIN y ON x.a = y.b AND y.b > 1").args.joins[0];
  const [sourceKey, joinKey, on] = join_condition(join);
  assert.deepEqual(sourceKey.map((e) => e.sql()), ["x.a"]);
  assert.deepEqual(joinKey.map((e) => e.sql()), ["y.b"]);
  assert.equal(on.sql(), "TRUE AND y.b > 1");
});

test("join_condition: DNF branch (OR of AND-of-EQ groups) finds the EQ shared by every branch", () => {
  const join = parseOne(
    "SELECT * FROM x JOIN y ON (x.a = y.a AND x.b = y.b) OR (x.a = y.a AND x.c = y.c)",
  ).args.joins[0];
  const [, joinKey] = join_condition(join);
  assert.deepEqual(joinKey.map((e) => e.sql()), ["y.a", "y.a"]);
});

test("join_condition: a bare OR with no AND inside is vacuously CNF and extracts nothing", () => {
  const join = parseOne("SELECT * FROM x JOIN y ON x.a > y.a OR x.b < y.b").args.joins[0];
  const [sourceKey, joinKey, on] = join_condition(join);
  assert.deepEqual(sourceKey, []);
  assert.deepEqual(joinKey, []);
  assert.equal(on.sql(), "(x.a > y.a OR x.b < y.b) AND TRUE");
});

test("join_condition: neither CNF nor DNF leaves `on` completely untouched", () => {
  const join = parseOne(
    "SELECT * FROM x JOIN y ON (x.a = y.a OR (x.b = y.b AND x.c = y.c)) AND x.d = y.d",
  ).args.joins[0];
  const [sourceKey, joinKey, on] = join_condition(join);
  assert.deepEqual(sourceKey, []);
  assert.deepEqual(joinKey, []);
  assert.equal(on.sql(), "(x.a = y.a OR (x.b = y.b AND x.c = y.c)) AND x.d = y.d");
});

test("join_condition: no ON clause at all defaults to TRUE AND TRUE with no keys", () => {
  const join = parseOne("SELECT * FROM x CROSS JOIN y").args.joins[0];
  const [sourceKey, joinKey, on] = join_condition(join);
  assert.deepEqual(sourceKey, []);
  assert.deepEqual(joinKey, []);
  assert.equal(on.sql(), "TRUE AND TRUE");
});
