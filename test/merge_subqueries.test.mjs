// Structural/behavioral tests for `src/optimizer/merge_subqueries.js`, runnable with
// no Python present.
//
// The deep differential signal (this file's output vs CPython's
// `sqlglot.optimizer.merge_subqueries`, over 32 guard-by-guard scenarios) lives in
// `spike/p7/fuzz_merge_subqueries.mjs` — see that file and
// `gen_merge_subqueries_ref.py`'s own header for why. This module is flagged as the
// highest correctness-risk port in its batch (a wrong guard silently changes result
// cardinality, not just SQL shape), so — per the task brief — these tests assert the
// SHOULD-NOT-merge cases directly and explicitly, not just the happy path.

import test from "node:test";
import assert from "node:assert/strict";
import { parseOne } from "../src/dialects/dialect.js";
import * as exp from "../src/expressions/index.js";
import { merge_subqueries, merge_ctes, merge_derived_tables } from "../src/optimizer/merge_subqueries.js";
import "../src/generator.js";
import "../src/dialects/hive.js";

const merge = (sql, leaveTablesIsolated) => merge_subqueries(parseOne(sql), leaveTablesIsolated).sql();

test("module docstring: a plain derived table merges into the outer query", () => {
  assert.equal(
    merge("SELECT a FROM (SELECT x.a FROM x) CROSS JOIN y"),
    "SELECT x.a FROM x CROSS JOIN y",
  );
});

test("module docstring: leave_tables_isolated blocks the same merge when it would leave >1 source", () => {
  assert.equal(
    merge("SELECT a FROM (SELECT x.a FROM x) CROSS JOIN y", true),
    "SELECT a FROM (SELECT x.a FROM x) CROSS JOIN y",
  );
});

test("leave_tables_isolated does not block a merge that leaves exactly one source", () => {
  assert.equal(merge("SELECT a FROM (SELECT x.a FROM x) sub", true), "SELECT a FROM x");
});

test("SHOULD NOT merge: GROUP BY in the subquery blocks the merge outright", () => {
  const sql = "SELECT a FROM (SELECT x.a AS a FROM x GROUP BY x.a) sub";
  assert.equal(merge(sql), "SELECT a FROM (SELECT x.a AS a FROM x GROUP BY x.a) AS sub");
});

test("SHOULD NOT merge: LIMIT in the subquery blocks the merge outright", () => {
  const sql = "SELECT a FROM (SELECT x.a AS a FROM x LIMIT 5) sub";
  assert.equal(merge(sql), "SELECT a FROM (SELECT x.a AS a FROM x LIMIT 5) AS sub");
});

test("SHOULD NOT merge: DISTINCT in the subquery blocks the merge outright", () => {
  const sql = "SELECT a FROM (SELECT DISTINCT x.a AS a FROM x) sub";
  assert.equal(merge(sql), "SELECT a FROM (SELECT DISTINCT x.a AS a FROM x) AS sub");
});

test("SHOULD NOT merge: LEFT JOIN to a subquery that itself has a WHERE", () => {
  const sql = "SELECT x.id, sub.a FROM x LEFT JOIN (SELECT b.id, b.a FROM b WHERE b.a > 1) sub ON x.id = sub.id";
  assert.equal(merge(sql), sql.replace("sub ON", "AS sub ON"));
});

test("merges: LEFT JOIN to a subquery with no WHERE is safe", () => {
  assert.equal(
    merge("SELECT x.id, sub.a FROM x LEFT JOIN (SELECT b.id, b.a FROM b) sub ON x.id = sub.id"),
    "SELECT x.id, b.a FROM x LEFT JOIN b ON x.id = b.id",
  );
});

test("SHOULD NOT merge: RIGHT JOIN to a subquery that itself has a WHERE", () => {
  const sql = "SELECT x.id, sub.a FROM x RIGHT JOIN (SELECT b.id, b.a FROM b WHERE b.a > 1) sub ON x.id = sub.id";
  assert.equal(merge(sql), sql.replace("sub ON", "AS sub ON"));
});

test("SHOULD NOT merge: FULL JOIN to a subquery that itself has a WHERE", () => {
  const sql = "SELECT x.id, sub.a FROM x FULL JOIN (SELECT b.id, b.a FROM b WHERE b.a > 1) sub ON x.id = sub.id";
  assert.equal(merge(sql), sql.replace("sub ON", "AS sub ON"));
});

test("SHOULD NOT merge: a FULL/RIGHT join elsewhere blocks a WHERE-bearing FROM-position subquery too", () => {
  assert.equal(
    merge("SELECT sub.a FROM (SELECT b.a FROM b WHERE b.a > 1) sub FULL JOIN c ON sub.a = c.a"),
    "SELECT sub.a FROM (SELECT b.a FROM b WHERE b.a > 1) AS sub FULL JOIN c ON sub.a = c.a",
  );
});

test("merges: a FULL/RIGHT join elsewhere does not block a WHERE-less FROM-position subquery", () => {
  assert.equal(
    merge("SELECT sub.a FROM (SELECT b.a FROM b) sub FULL JOIN c ON sub.a = c.a"),
    "SELECT b.a FROM b FULL JOIN c ON b.a = c.a",
  );
});

test("SHOULD NOT merge: a correlated EXISTS predicate is not a derived table and is left untouched", () => {
  const sql = "SELECT * FROM x WHERE EXISTS (SELECT 1 FROM y WHERE y.id = x.id)";
  assert.equal(merge(sql), "SELECT * FROM x WHERE EXISTS(SELECT 1 FROM y WHERE y.id = x.id)");
});

test("merges: a CTE selected from exactly once", () => {
  assert.equal(merge("WITH cte AS (SELECT x.a FROM x) SELECT a FROM cte"), "SELECT a FROM x");
});

test("SHOULD NOT merge: a CTE selected from more than once", () => {
  const sql = "WITH cte AS (SELECT x.a AS a FROM x) SELECT c1.a FROM cte c1 JOIN cte c2 ON c1.a = c2.a";
  assert.equal(merge(sql), "WITH cte AS (SELECT x.a AS a FROM x) SELECT c1.a FROM cte AS c1 JOIN cte AS c2 ON c1.a = c2.a");
});

test("SHOULD NOT merge: a recursive CTE referenced both internally and externally (multi-use guard)", () => {
  const sql = "WITH RECURSIVE cte AS (SELECT 1 AS n FROM x UNION ALL SELECT cte.n + 1 AS n FROM cte WHERE cte.n < 5) "
    + "SELECT cte.n FROM cte";
  assert.equal(merge(sql), sql);
});

test("SHOULD NOT merge: a recursive CTE's self-reference (_is_recursive guard, isolated)", () => {
  const sql = "WITH RECURSIVE cte AS (SELECT 1 AS n FROM x UNION ALL SELECT cte.n + 1 AS n FROM cte WHERE cte.n < 5) "
    + "SELECT 1 AS z";
  assert.equal(merge(sql), sql);
});

test("merges: outer column references to the subquery alias are rewritten to the inner expression", () => {
  assert.equal(
    merge("SELECT sub.a + 1 AS total FROM (SELECT x.col AS a FROM x) sub"),
    "SELECT x.col + 1 AS total FROM x",
  );
});

test("merges: the outer projection's own alias is preserved when the inlined expression's name differs", () => {
  assert.equal(
    merge("SELECT sub.b FROM (SELECT x.a + 1 AS b FROM x) sub"),
    "SELECT x.a + 1 AS b FROM x",
  );
});

test("SHOULD NOT merge: outer SELECT * blocks the merge unconditionally", () => {
  assert.equal(merge("SELECT * FROM (SELECT x.a FROM x) sub"), "SELECT * FROM (SELECT x.a FROM x) AS sub");
});

test("SHOULD NOT merge: the inner query is a UNION, not a plain SELECT", () => {
  const sql = "SELECT a FROM (SELECT x.a FROM x UNION SELECT y.a FROM y) sub";
  assert.equal(merge(sql), "SELECT a FROM (SELECT x.a FROM x UNION SELECT y.a FROM y) AS sub");
});

test("SHOULD NOT merge: the inner query has no FROM clause", () => {
  assert.equal(
    merge("SELECT a FROM (SELECT 1 AS a) sub CROSS JOIN y"),
    "SELECT a FROM (SELECT 1 AS a) AS sub CROSS JOIN y",
  );
});

test("adversarial: a JOIN-position subquery that itself has a JOIN never merges, regardless of which table the ON references", () => {
  // `_outer_select_joins_on_inner_select_join`'s own upstream doctest-style comment
  // claims the first of these CAN merge and the second CANNOT -- verified directly
  // against CPython that NEITHER merges: the earlier, unconditional
  // `from_or_join instanceof Join && inner_select has joins` guard blocks both before
  // that later, more selective check ever runs. See gen_merge_subqueries_ref.py's
  // header for the full adversarial write-up.
  const first = "SELECT q.a FROM x JOIN (SELECT y.a AS a FROM y JOIN z ON y.id = z.id) AS q ON x.a = q.a";
  const second = "SELECT q.a FROM x JOIN (SELECT z.a AS a FROM y JOIN z ON y.id = z.id) AS q ON x.a = q.a";
  assert.equal(merge(first), first);
  assert.equal(merge(second), second);
});

test("adversarial: the identical subquery attached via bare FROM (no JOIN) DOES merge, pulling its inner JOIN up", () => {
  assert.equal(
    merge("SELECT a FROM (SELECT y.a AS a FROM y JOIN z ON y.id = z.id) AS q"),
    "SELECT a FROM y JOIN z ON y.id = z.id",
  );
});

test("merges: a numeric-literal projection referenced as a top-level GROUP BY item canonicalizes to its ordinal", () => {
  assert.equal(
    merge("SELECT sub.n FROM (SELECT 1 AS n FROM x) sub GROUP BY sub.n"),
    "SELECT 1 AS n FROM x GROUP BY 1",
  );
});

test("SHOULD NOT merge: the same numeric-literal alias nested inside a GROUP BY expression", () => {
  const sql = "SELECT sub.n FROM (SELECT 1 AS n FROM x) sub GROUP BY sub.n + 1";
  assert.equal(merge(sql), "SELECT sub.n FROM (SELECT 1 AS n FROM x) AS sub GROUP BY sub.n + 1");
});

test("SHOULD NOT merge: a numeric-literal alias referenced from ORDER BY", () => {
  const sql = "SELECT sub.n FROM (SELECT 1 AS n FROM x) sub ORDER BY sub.n";
  assert.equal(merge(sql), "SELECT sub.n FROM (SELECT 1 AS n FROM x) AS sub ORDER BY sub.n");
});

// The next four assert AST shape rather than `.sql()` text: this port's
// `window_sql`/`querytransform_sql` base-Generator methods are not ported yet (an
// unrelated pre-existing gap — see gen_merge_subqueries_ref.py's header), so a
// `.sql()` round-trip on a tree containing either construct throws `NotPorted`. The
// merge/no-merge DECISION itself is exercised without needing to render either node,
// by checking whether a `Subquery` aliased `sub` still exists in the tree.
function stillHasSubqueryAliased(root, alias) {
  for (const sq of root.findAll(exp.Subquery)) {
    if (sq.aliasOrName === alias) return true;
  }
  return false;
}

test("merges: a window-function projection with no conflicting outer usage", () => {
  const out = merge_subqueries(parseOne("SELECT sub.rn FROM (SELECT ROW_NUMBER() OVER (ORDER BY x.a) AS rn FROM x) sub"));
  assert.equal(stillHasSubqueryAliased(out, "sub"), false);
});

test("SHOULD NOT merge: a window-function projection when the outer query adds a WHERE", () => {
  const out = merge_subqueries(
    parseOne("SELECT sub.rn FROM (SELECT ROW_NUMBER() OVER (ORDER BY x.a) AS rn FROM x) sub WHERE sub.rn > 1"),
  );
  assert.equal(stillHasSubqueryAliased(out, "sub"), true);
});

test("SHOULD NOT merge: a window-function projection referenced from the outer GROUP BY", () => {
  const out = merge_subqueries(
    parseOne("SELECT sub.rn FROM (SELECT ROW_NUMBER() OVER (ORDER BY x.a) AS rn FROM x) sub GROUP BY sub.rn"),
  );
  assert.equal(stillHasSubqueryAliased(out, "sub"), true);
});

test("SHOULD NOT merge: a QueryTransform (Hive TRANSFORM ... USING) as the subquery's first projection", () => {
  const ast = parseOne(
    "SELECT sub.a FROM x JOIN (SELECT TRANSFORM(a) USING 'cat' FROM y) sub ON x.id = sub.id",
    { read: "hive" },
  );
  const out = merge_subqueries(ast);
  assert.equal(stillHasSubqueryAliased(out, "sub"), true);
});

test("merge_ctes and merge_derived_tables are independently exported and composable", () => {
  const [afterCtes, mergedAny] = merge_ctes(parseOne("WITH cte AS (SELECT x.a FROM x) SELECT a FROM cte"));
  assert.equal(mergedAny, true);
  assert.equal(afterCtes.sql(), "SELECT a FROM x");

  const out = merge_derived_tables(parseOne("SELECT a FROM (SELECT x.a FROM x) sub"));
  assert.equal(out.sql(), "SELECT a FROM x");
});

test("merge_ctes reports merged=false when nothing was mergeable", () => {
  const sql = "WITH cte AS (SELECT x.a AS a FROM x GROUP BY x.a) SELECT a FROM cte";
  const [afterCtes, mergedAny] = merge_ctes(parseOne(sql));
  assert.equal(mergedAny, false);
  assert.equal(afterCtes.sql(), sql);
});
