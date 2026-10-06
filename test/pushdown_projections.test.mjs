// Structural/behavioral tests for `src/optimizer/pushdown_projections.js`, runnable
// with no Python present.
//
// The deep differential signal (this file's output vs CPython's
// `sqlglot.optimizer.pushdown_projections`, over the real upstream fixture corpus of
// 74 SQL/expected pairs, run through the exact `TestOptimizer.test_pushdown_projection`
// pipeline) lives in `spike/p10/fuzz_pushdown_projections.mjs` -- see that file and
// `gen_pushdown_projections_ref.py`'s own header for why. These tests assert the same
// rendered-SQL contract directly, with no CPython dependency, so `node --test` alone
// still catches a regression. Scenarios below are a representative subset drawn from
// `tests/fixtures/optimizer/pushdown_projections.sql` (one per labeled section of that
// file), excluding the 3 pairs that hit pre-existing, unrelated `NotPorted`
// base-Generator stubs (`cube_sql`, `in_unnest_op`, `JSONPathKey` -- see that spike
// file's own `STRUCTURAL_IDS`).

import test from "node:test";
import assert from "node:assert/strict";
import { parseOne } from "../src/dialects/dialect.js";
import { qualify_tables } from "../src/optimizer/qualify_tables.js";
import { qualify_columns } from "../src/optimizer/qualify_columns.js";
import { pushdown_projections } from "../src/optimizer/pushdown_projections.js";
import "../src/generator.js";
import "../src/dialects/bigquery.js";
import "../src/dialects/snowflake.js";

// py: tests/test_optimizer.py:132-172 `self.schema`, the exact schema
// `test_pushdown_projection` runs `check_file("pushdown_projections", ...)` against.
const SCHEMA = {
  x: { a: "INT", b: "INT" },
  y: { b: "INT", c: "INT" },
  z: { b: "INT", c: "INT" },
  w: { d: "TEXT", e: "TEXT" },
};

// py: tests/test_optimizer.py:45-49 `pushdown_projections` test wrapper.
function run(sql, dialect = null) {
  const kwargs = dialect ? { dialect } : {};
  let expression = parseOne(sql, { dialect });
  expression = qualify_tables(expression);
  expression = qualify_columns(expression, SCHEMA, { inferSchema: true, ...kwargs });
  expression = pushdown_projections(expression, SCHEMA, kwargs);
  return expression.sql(dialect);
}

test("module docstring example: an unused projection inside a derived table is pruned", () => {
  assert.equal(
    run("SELECT a FROM (SELECT * FROM x)"),
    'SELECT _0.a AS a FROM (SELECT x.a AS a FROM x AS x) AS _0',
  );
});

test("an unreferenced non-star select is pruned to a single literal", () => {
  assert.equal(
    run("WITH y AS (SELECT a FROM x) SELECT 1 FROM y"),
    'WITH y AS (SELECT 1 AS _ FROM x AS x) SELECT 1 AS "1" FROM y AS y',
  );
});

test("GROUP BY/UNION pruning keeps the grouping column and drops the unused one", () => {
  assert.equal(
    run("SELECT b FROM (SELECT a, SUM(b) AS b FROM x GROUP BY a)"),
    "SELECT _0.b AS b FROM (SELECT SUM(x.b) AS b FROM x AS x GROUP BY x.a) AS _0",
  );
});

test("a bare GROUP BY ordinal is rewritten to its new position after pruning", () => {
  assert.equal(
    run("WITH x AS (SELECT z, 0 AS c, a, SUM(d) AS s FROM t GROUP BY z, 2, a) SELECT c, a, s FROM x"),
    "WITH x AS (SELECT 0 AS c, t.a AS a, SUM(t.d) AS s FROM t AS t GROUP BY t.z, 1, t.a) "
    + "SELECT x.c AS c, x.a AS a, x.s AS s FROM x AS x",
  );
});

test("CTE column aliases are preserved through pruning", () => {
  assert.equal(
    run("WITH cte(x, y, z) AS (SELECT 1, 2, 3) SELECT a, z FROM cte AS cte(a)"),
    "WITH cte AS (SELECT 1 AS x, 3 AS z) SELECT cte.a AS a, cte.z AS z FROM cte AS cte(a)",
  );
});

test("unknown star expansion still prunes correctly once resolved", () => {
  assert.equal(
    run("SELECT a FROM (SELECT * FROM zz) WHERE b = 1"),
    "SELECT _0.a AS a FROM (SELECT zz.a AS a, zz.b AS b FROM zz AS zz) AS _0 WHERE _0.b = 1",
  );
});

test("set-returning functions affect cardinality and are retained even when unused", () => {
  assert.equal(
    run("SELECT d FROM (SELECT EXPLODE(e) AS col, d FROM w)"),
    "SELECT _0.d AS d FROM (SELECT EXPLODE(w.e) AS col, w.d AS d FROM w AS w) AS _0",
  );
});

test("window functions do not affect cardinality and stay prunable", () => {
  assert.equal(
    run("SELECT d FROM (SELECT d, ROW_NUMBER() OVER (PARTITION BY e ORDER BY d) AS rn FROM w)"),
    "SELECT _0.d AS d FROM (SELECT w.d AS d FROM w AS w) AS _0",
  );
});

test("a set operation's own ORDER BY keeps referenced columns even if the outer query doesn't", () => {
  assert.equal(
    run("SELECT t.a FROM (SELECT a, b FROM x UNION ALL SELECT a, b FROM x ORDER BY b, a LIMIT 3) AS t"),
    "SELECT t.a AS a FROM (SELECT x.a AS a, x.b AS b FROM x AS x UNION ALL SELECT x.a AS a, x.b AS b "
    + "FROM x AS x ORDER BY b, a LIMIT 3) AS t",
  );
});

test("GROUP BY ALL implicitly groups by every non-aggregate projection, keeping it even when unreferenced", () => {
  assert.equal(
    run("SELECT t.a FROM (SELECT a, b, SUM(b) AS s FROM x GROUP BY ALL) t"),
    "SELECT t.a AS a FROM (SELECT x.a AS a, x.b AS b FROM x AS x GROUP BY ALL) AS t",
  );
});

test("unreferenced aggregate projections stay prunable under GROUP BY ALL", () => {
  assert.equal(
    run("SELECT t.a FROM (SELECT a, SUM(b) AS s1, MAX(b) AS s2 FROM x GROUP BY ALL) t"),
    "SELECT t.a AS a FROM (SELECT x.a AS a FROM x AS x GROUP BY ALL) AS t",
  );
});
