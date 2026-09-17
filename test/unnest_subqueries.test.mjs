// Structural/behavioral tests for `src/optimizer/unnest_subqueries.js`, runnable with
// no Python present.
//
// The deep differential signal (this file's output vs CPython's
// `sqlglot.optimizer.unnest_subqueries`, over 32 scenarios including the module's own
// docstring example) lives in `spike/p7/fuzz_unnest_subqueries.mjs` — see that file and
// `gen_unnest_subqueries_ref.py`'s own header for why (including the two non-obvious
// dispatch gates most scenarios below are named after). These tests assert the same
// rendered-SQL contract directly, with no CPython dependency, so `node --test` alone
// still catches a regression. Mirrors `test/optimize_joins.test.mjs`'s shape (R45).

import test from "node:test";
import assert from "node:assert/strict";
import { parseOne } from "../src/dialects/dialect.js";
import { unnest_subqueries } from "../src/optimizer/unnest_subqueries.js";
import "../src/generator.js";

const unnest = (sql) => unnest_subqueries(parseOne(sql)).sql();

test("module docstring example: correlated scalar subquery decorrelates into a LEFT JOIN + GROUP BY", () => {
  assert.equal(
    unnest("SELECT * FROM x AS x WHERE (SELECT y.a AS a FROM y AS y WHERE x.a = y.a) = 1"),
    "SELECT * FROM x AS x LEFT JOIN (SELECT y.a AS a FROM y AS y WHERE TRUE GROUP BY y.a) AS _u_0 ON x.a = _u_0.a WHERE _u_0.a = 1",
  );
});

test("uncorrelated parenthesized scalar subquery becomes a CROSS JOIN", () => {
  assert.equal(
    unnest("SELECT * FROM x WHERE (SELECT MAX(y.a) FROM y) = 5"),
    'SELECT * FROM x CROSS JOIN (SELECT MAX(y.a) FROM y) AS _u_0 WHERE _u_0."" = 5',
  );
});

test("EXISTS(...) never gets a Subquery wrapper, so uncorrelated EXISTS is left alone", () => {
  assert.equal(
    unnest("SELECT * FROM x WHERE EXISTS(SELECT 1 FROM y WHERE y.a = 1)"),
    "SELECT * FROM x WHERE EXISTS(SELECT 1 FROM y WHERE y.a = 1)",
  );
});

test("NOT IN is explicitly excluded (three-valued NULL semantics), even uncorrelated", () => {
  assert.equal(
    unnest("SELECT * FROM x WHERE x.a NOT IN (SELECT y.a FROM y)"),
    "SELECT * FROM x WHERE NOT x.a IN (SELECT y.a FROM y)",
  );
});

test("a bare SELECT-list scalar subquery with no Condition ancestor is left untouched", () => {
  assert.equal(
    unnest("SELECT (SELECT MAX(y.a) FROM y) FROM x"),
    "SELECT (SELECT MAX(y.a) FROM y) FROM x",
  );
});

test("uncorrelated IN rewrites to an ARRAY_AGG'd LEFT JOIN keyed on an empty alias", () => {
  assert.equal(
    unnest("SELECT * FROM x WHERE x.a IN (SELECT y.a FROM y)"),
    'SELECT * FROM x LEFT JOIN (SELECT y.a FROM y GROUP BY a) AS _u_0 ON x.a = _u_0."" WHERE NOT _u_0."" IS NULL',
  );
});

test("a UNION subquery gets rewrapped into a single-column derived-table Select before joining", () => {
  assert.equal(
    unnest("SELECT * FROM x WHERE x.a IN (SELECT y.a FROM y UNION SELECT z.a FROM z)"),
    "SELECT * FROM x LEFT JOIN (SELECT _u_0.a AS a FROM (SELECT y.a FROM y UNION SELECT z.a FROM z) AS _u_0 GROUP BY _u_0.a) AS _u_1 ON x.a = _u_1.a WHERE NOT _u_1.a IS NULL",
  );
});

test("table-valued-function guard: a subquery under a FROM/Table/Join-parented Func is untouched", () => {
  assert.equal(
    unnest("SELECT * FROM x, UNNEST((SELECT ARRAY_AGG(y.a) FROM y)) AS t"),
    "SELECT * FROM x, UNNEST((SELECT ARRAY_AGG(y.a) FROM y)) AS t",
  );
});

test("no FROM on the outer query blocks unnest() entirely", () => {
  assert.equal(unnest("SELECT (SELECT 1 FROM y)"), "SELECT (SELECT 1 FROM y)");
});

test("HAVING-clause scalar subquery takes the Max-wrap branch", () => {
  assert.equal(
    unnest("SELECT * FROM x HAVING (SELECT MAX(y.a) FROM y) = 5"),
    'SELECT * FROM x CROSS JOIN (SELECT MAX(y.a) FROM y) AS _u_0 HAVING MAX(_u_0."") = 5',
  );
});

test("correlated EXISTS decorrelates into a LEFT JOIN ON TRUE + IS NOT NULL check", () => {
  assert.equal(
    unnest("SELECT * FROM x WHERE EXISTS(SELECT 1 FROM y WHERE y.a = x.a)"),
    "SELECT * FROM x LEFT JOIN (SELECT y.a AS _u_1 FROM y WHERE TRUE GROUP BY y.a) AS _u_0 ON _u_0._u_1 = x.a WHERE NOT _u_0._u_1 IS NULL",
  );
});

test("correlated NOT EXISTS decorrelates the EXISTS node, leaving the outer NOT in place", () => {
  assert.equal(
    unnest("SELECT * FROM x WHERE NOT EXISTS(SELECT 1 FROM y WHERE y.a = x.a)"),
    "SELECT * FROM x LEFT JOIN (SELECT y.a AS _u_1 FROM y WHERE TRUE GROUP BY y.a) AS _u_0 ON _u_0._u_1 = x.a WHERE NOT NOT _u_0._u_1 IS NULL",
  );
});

test("correlated scalar projection with an explicit alias reuses that alias on the join column", () => {
  assert.equal(
    unnest("SELECT x.a, (SELECT MAX(y.b) FROM y WHERE y.a = x.a) AS m FROM x"),
    'SELECT x.a, _u_0."" AS m FROM x LEFT JOIN (SELECT MAX(y.b), y.a AS _u_1 FROM y WHERE TRUE GROUP BY y.a) AS _u_0 ON _u_0._u_1 = x.a',
  );
});

test("COUNT in a correlated SELECT-list projection is coalesced to 0 for empty groups", () => {
  assert.equal(
    unnest("SELECT x.a, (SELECT COUNT(*) FROM y WHERE y.a = x.a) FROM x"),
    'SELECT x.a, COALESCE(_u_0."", *) FROM x LEFT JOIN (SELECT COUNT(*), y.a AS _u_1 FROM y WHERE TRUE GROUP BY y.a) AS _u_0 ON _u_0._u_1 = x.a',
  );
});

test("correlated ANY rewrites into an ARRAY_ANY lambda over the aggregated join column", () => {
  assert.equal(
    unnest("SELECT * FROM x WHERE x.a = ANY(SELECT y.a FROM y WHERE y.b = x.b)"),
    'SELECT * FROM x LEFT JOIN (SELECT ARRAY_AGG(a), y.b AS _u_1 FROM y WHERE TRUE GROUP BY y.b) AS _u_0 ON _u_0._u_1 = x.b WHERE x.a = ARRAY_ANY(_u_0."", _x -> x.a = _x)',
  );
});

test("correlated key equal to the subquery's own value collapses the dedup (reuses value.alias)", () => {
  assert.equal(
    unnest("SELECT * FROM x WHERE x.a IN (SELECT y.a FROM y WHERE y.a = x.b)"),
    'SELECT * FROM x LEFT JOIN (SELECT ARRAY_AGG(a), y.a AS _u_1 FROM y WHERE TRUE GROUP BY y.a) AS _u_0 ON _u_0._u_1 = x.b WHERE ARRAY_ANY(_u_0."", _x -> _x = x.a)',
  );
});

test("an OR anywhere in the correlated subquery's WHERE blocks decorrelate() entirely", () => {
  assert.equal(
    unnest("SELECT * FROM x WHERE EXISTS(SELECT 1 FROM y WHERE y.a = x.a OR y.b = 1)"),
    "SELECT * FROM x WHERE EXISTS(SELECT 1 FROM y WHERE y.a = x.a OR y.b = 1)",
  );
});

test("LIMIT/OFFSET in the correlated subquery blocks decorrelate() entirely", () => {
  assert.equal(
    unnest("SELECT * FROM x WHERE EXISTS(SELECT 1 FROM y WHERE y.a = x.a LIMIT 1)"),
    "SELECT * FROM x WHERE EXISTS(SELECT 1 FROM y WHERE y.a = x.a LIMIT 1)",
  );
});

test("one EQ key plus one non-EQ key needs the ARRAY_AGG + ARRAY_ANY/Lambda rewrite for the non-EQ side", () => {
  assert.equal(
    unnest("SELECT * FROM x WHERE EXISTS(SELECT 1 FROM y WHERE y.a = x.a AND y.b > x.c)"),
    "SELECT * FROM x LEFT JOIN (SELECT y.a AS _u_1, ARRAY_AGG(y.b) AS _u_2 FROM y WHERE TRUE AND TRUE GROUP BY y.a) AS _u_0 ON _u_0._u_1 = x.a WHERE (NOT _u_0._u_1 IS NULL AND ARRAY_ANY(_u_0._u_2, _x -> _x > x.c))",
  );
});

test("decorrelate() reaches a correlated subquery nested inside a FROM-clause derived table", () => {
  assert.equal(
    unnest("SELECT * FROM (SELECT * FROM p WHERE EXISTS(SELECT 1 FROM q WHERE q.a = p.a)) AS sub"),
    "SELECT * FROM (SELECT * FROM p LEFT JOIN (SELECT q.a AS _u_1 FROM q WHERE TRUE GROUP BY q.a) AS _u_0 ON _u_0._u_1 = p.a WHERE NOT _u_0._u_1 IS NULL) AS sub",
  );
});

test("two independent correlated subqueries in one query share the same alias counter", () => {
  assert.equal(
    unnest(
      "SELECT t1.a, t1.b, (SELECT MAX(t2.c) FROM t2 WHERE t2.a = t1.a) AS m FROM t1 "
      + "WHERE t1.b IN (SELECT t3.b FROM t3 WHERE t3.c = t1.c)",
    ),
    'SELECT t1.a, t1.b, _u_0."" AS m FROM t1 LEFT JOIN (SELECT MAX(t2.c), t2.a AS _u_1 FROM t2 WHERE TRUE GROUP BY t2.a) AS _u_0 ON _u_0._u_1 = t1.a '
    + 'LEFT JOIN (SELECT ARRAY_AGG(b), t3.c AS _u_3 FROM t3 WHERE TRUE GROUP BY t3.c) AS _u_2 ON _u_2._u_3 = t1.c WHERE ARRAY_ANY(_u_2."", _x -> _x = t1.b)',
  );
});
