// Structural/behavioral tests for `src/optimizer/pushdown_predicates.js`, runnable
// with no Python present.
//
// The deep differential signal (this file's output vs CPython's
// `sqlglot.optimizer.pushdown_predicates`, over the real upstream fixture corpus
// `tests/fixtures/optimizer/pushdown_predicates.sql`, 32 pairs) lives in
// `spike/p10/fuzz_pushdown_predicates.mjs` -- see that file and
// `gen_pushdown_predicates_ref.py`'s own header for why. These tests assert the same
// rendered-SQL contract directly, with no CPython dependency, so `node --test` alone
// still catches a regression.

import test from "node:test";
import assert from "node:assert/strict";
import { parseOne } from "../src/dialects/dialect.js";
import { pushdown_predicates } from "../src/optimizer/pushdown_predicates.js";
import "../src/generator.js";

const optimize = (sql) => pushdown_predicates(parseOne(sql)).sql();

test("module docstring example: predicate pushed into derived table, WHERE replaced with TRUE", () => {
  assert.equal(
    optimize("SELECT y.a AS a FROM (SELECT x.a AS a FROM x AS x) AS y WHERE y.a = 1"),
    "SELECT y.a AS a FROM (SELECT x.a AS a FROM x AS x WHERE x.a = 1) AS y WHERE TRUE",
  );
});

test("CTE predicate is pushed into the CTE body", () => {
  assert.equal(
    optimize("WITH x AS (SELECT y.a FROM y) SELECT * FROM x WHERE x.a = 1"),
    "WITH x AS (SELECT y.a FROM y WHERE y.a = 1) SELECT * FROM x WHERE TRUE",
  );
});

test("DNF: a conjunct present in every OR block is pushed, the original predicate is kept", () => {
  assert.equal(
    optimize("SELECT x.a FROM (SELECT * FROM x) AS x CROSS JOIN y WHERE y.a = 1 OR (x.a = 1 AND x.b = 1)"),
    "SELECT x.a FROM (SELECT * FROM x) AS x CROSS JOIN y WHERE (x.a = 1 AND x.b = 1) OR y.a = 1",
  );
});

test("CNF: predicate pushed into HAVING when it references an aggregate", () => {
  assert.equal(
    optimize("SELECT x.cnt AS cnt FROM (SELECT COUNT(1) AS cnt FROM x AS x) AS x WHERE x.cnt > 0"),
    "SELECT x.cnt AS cnt FROM (SELECT COUNT(1) AS cnt FROM x AS x HAVING COUNT(1) > 0) AS x WHERE TRUE",
  );
});

test("a single-table JOIN predicate is pushed into its own ON clause", () => {
  assert.equal(
    optimize("SELECT x.a FROM x AS x JOIN (SELECT y.a FROM y AS y) AS y ON y.a = 1 AND x.a = y.a"),
    "SELECT x.a FROM x AS x JOIN (SELECT y.a FROM y AS y WHERE y.a = 1) AS y ON x.a = y.a AND TRUE",
  );
});

test("the RHS of a RIGHT JOIN is preserved: a WHERE predicate on it stays a WHERE, not an ON", () => {
  assert.equal(
    optimize("SELECT x.a, y.b FROM x RIGHT JOIN y ON x.a = y.b WHERE y.b = 3"),
    "SELECT x.a, y.b FROM x RIGHT JOIN y ON x.a = y.b WHERE y.b = 3",
  );
});

test("a WHERE predicate on the preserved RHS of a RIGHT JOIN can still push into an isolated derived table", () => {
  assert.equal(
    optimize("SELECT x.a, y.b FROM x RIGHT JOIN (SELECT b FROM y) AS y ON x.a = y.b WHERE y.b = 3"),
    "SELECT x.a, y.b FROM x RIGHT JOIN (SELECT b FROM y WHERE b = 3) AS y ON x.a = y.b WHERE TRUE",
  );
});

test("a FULL JOIN preserves both sides: neither join's own ON nor a WHERE predicate on it is pushed", () => {
  assert.equal(
    optimize("SELECT x.a, y.b FROM x FULL JOIN y ON x.a = y.b WHERE y.b = 3"),
    "SELECT x.a, y.b FROM x FULL JOIN y ON x.a = y.b WHERE y.b = 3",
  );
});

test("LIMIT on a derived table blocks pushdown into it", () => {
  assert.equal(
    optimize("SELECT s.a FROM (SELECT a, b FROM x ORDER BY a LIMIT 10) AS s WHERE s.b = 1"),
    "SELECT s.a FROM (SELECT a, b FROM x ORDER BY a LIMIT 10) AS s WHERE s.b = 1",
  );
});

test("OFFSET on a derived table blocks pushdown into it", () => {
  assert.equal(
    optimize("SELECT s.a FROM (SELECT a, b FROM x ORDER BY a OFFSET 3) AS s WHERE s.b = 1"),
    "SELECT s.a FROM (SELECT a, b FROM x ORDER BY a OFFSET 3) AS s WHERE s.b = 1",
  );
});

test("QUALIFY on a derived table blocks pushdown into it", () => {
  assert.equal(
    optimize("SELECT s.a FROM (SELECT a, b FROM x QUALIFY ROW_NUMBER() OVER (ORDER BY a) <= 10) AS s WHERE s.b = 1"),
    "SELECT s.a FROM (SELECT a, b FROM x QUALIFY ROW_NUMBER() OVER (ORDER BY a) <= 10) AS s WHERE s.b = 1",
  );
});

test("a window-function selection blocks pushdown into the derived table", () => {
  assert.equal(
    optimize(
      "with t1 as (SELECT x.a, x.b, ROW_NUMBER() OVER (PARTITION BY x.a ORDER BY x.a) as row_num FROM x) SELECT t1.a, t1.b FROM t1 WHERE row_num = 1",
    ),
    "WITH t1 AS (SELECT x.a, x.b, ROW_NUMBER() OVER (PARTITION BY x.a ORDER BY x.a) AS row_num FROM x) SELECT t1.a, t1.b FROM t1 WHERE row_num = 1",
  );
});

test("a source referenced more than once (scope_ref_count >= 2) is not pushed into", () => {
  assert.equal(
    optimize(
      "WITH m AS (SELECT a, b FROM (VALUES (1, 2)) AS a1(a, b)), n AS (SELECT a, b FROM m WHERE m.a = 1), o AS (SELECT a, b FROM m WHERE m.a = 2) SELECT n.a, n.b, n.a, o.b FROM n FULL OUTER JOIN o ON n.a = o.a",
    ),
    "WITH m AS (SELECT a, b FROM (VALUES (1, 2)) AS a1(a, b)), n AS (SELECT a, b FROM m WHERE m.a = 1), o AS (SELECT a, b FROM m WHERE m.a = 2) SELECT n.a, n.b, n.a, o.b FROM n FULL OUTER JOIN o ON n.a = o.a",
  );
});

test("DNF cross-table predicate is pushed only to the last eligible JOIN", () => {
  assert.equal(
    optimize(
      "SELECT a.id, b.val, c.name FROM t_a AS a INNER JOIN t_b AS b ON b.a_id = a.id INNER JOIN t_c AS c ON c.b_id = b.id WHERE (b.flag = 1 AND c.active = 1) OR (b.flag = 2 AND c.active = 0)",
    ),
    "SELECT a.id, b.val, c.name FROM t_a AS a INNER JOIN t_b AS b ON a.id = b.a_id INNER JOIN t_c AS c ON ((b.flag = 1 AND c.active = 1) OR (b.flag = 2 AND c.active = 0)) AND b.id = c.b_id WHERE (b.flag = 1 AND c.active = 1) OR (b.flag = 2 AND c.active = 0)",
  );
});
