// Structural/behavioral tests for `src/optimizer/qualify_columns.js` -- CORE only
// (AIR-2106: column qualification + star expansion). `validate_qualify_columns` and
// `quote_identifiers` are NOT ported (AIR-2107), so no test here exercises them.
//
// The deep differential signal (this file's output vs CPython's
// `sqlglot.optimizer.qualify_columns.qualify_columns`, over 41 hand-picked scenarios
// covering basic/ambiguous/join qualification, USING joins, alias-ref expansion,
// positional references, struct-star expansion, PIVOT, and `qualify_outputs`) lives in
// `spike/p7/fuzz_qualify_columns.mjs` -- see that file and `gen_qualify_columns_ref.py`'s
// own header for why and for what each scenario targets. These tests cover what a
// SQL-string oracle scenario can't assert cleanly: exact `OptimizeError` messages,
// the three PUBLIC exports' own option/default handling, `Map`-typed return/threading
// behavior (`qualify_columns`'s internal `_expand_using`/`_expand_stars` pivot-output
// plumbing is exercised only indirectly by the oracle's SQL-text comparison), and
// `qualify_outputs`/`pushdown_cte_alias_columns` called directly rather than only via
// the `qualify_columns` orchestration.

import test from "node:test";
import assert from "node:assert/strict";
import { Dialect, parseOne } from "../src/dialects/dialect.js";
import * as exp from "../src/expressions/index.js";
import "../src/generator.js";
import "../src/dialects/bigquery.js";
import "../src/dialects/snowflake.js";
import { qualify_columns, qualify_outputs, pushdown_cte_alias_columns } from "../src/optimizer/qualify_columns.js";
import { OptimizeError } from "../src/errors.js";
import { buildScope, traverseScope } from "../src/optimizer/scope.js";

function q(sql, schema, options, dialect) {
  const ast = parseOne(sql, { dialect });
  return qualify_columns(ast, schema ?? {}, { ...options, dialect }).sql(dialect);
}

test("basic: unqualified column resolves against the one real source", () => {
  assert.equal(q("SELECT a FROM t", { t: { a: "INT" } }), "SELECT t.a AS a FROM t");
});

test("ambiguous column across two sources is left unqualified (no OptimizeError from this file)", () => {
  assert.equal(
    q("SELECT a FROM t1, t2", { t1: { a: "INT" }, t2: { a: "INT" } }),
    "SELECT a AS a FROM t1, t2",
  );
});

test("unknown real column under a known table raises OptimizeError with the exact upstream message", () => {
  assert.throws(
    () => q("SELECT t.z FROM t", { t: { a: "INT" } }),
    (err) => err instanceof OptimizeError && err.message === "Unknown column: z",
  );
});

test("allow_partial_qualification suppresses the Unknown column raise", () => {
  assert.equal(
    q("SELECT unknown_col FROM t", { t: { a: "INT" } }, { allowPartialQualification: true }),
    "SELECT unknown_col AS unknown_col FROM t",
  );
});

test("a column qualified against an unresolvable table name is left completely untouched", () => {
  assert.equal(q("SELECT x.a FROM t", { t: { a: "INT" } }), "SELECT x.a AS a FROM t");
});

test("infer_schema defaults to schema.empty: an empty schema still resolves the sole source", () => {
  assert.equal(q("SELECT a FROM t", {}), "SELECT t.a AS a FROM t");
});

test("infer_schema=false with an empty schema leaves an unqualified column unresolved", () => {
  assert.equal(q("SELECT a FROM t", {}, { inferSchema: false }), "SELECT a AS a FROM t");
});

test("USING join qualifies to a COALESCE over both sides, in FROM/JOIN order", () => {
  assert.equal(
    q(
      "SELECT id FROM t1 JOIN t2 USING (id)",
      { t1: { id: "INT", a: "INT" }, t2: { id: "INT", b: "INT" } },
    ),
    "SELECT COALESCE(t1.id, t2.id) AS id FROM t1 JOIN t2 ON t1.id = t2.id",
  );
});

test("star expansion errors with an OptimizeError message naming the real unresolvable table", () => {
  // `t2` has no schema entry at all, so `_expand_stars` can't resolve it as a source.
  assert.throws(
    () => q("SELECT missing_tbl.* FROM t", { t: { a: "INT" } }),
    (err) => err instanceof OptimizeError,
  );
});

test("qualify_outputs: unnamed arithmetic expression gets a synthetic _col_N alias", () => {
  const ast = parseOne("SELECT a + 1, b FROM t");
  const scope = traverseScope(ast).at(-1);
  qualify_outputs(scope, new Dialect());
  assert.equal(ast.sql(), "SELECT a + 1 AS _col_0, b AS b FROM t");
});

test("qualify_outputs: accepts a bare expression (not a Scope), builds its own scope internally", () => {
  // Exercise the `exp.Expr` branch directly (`qualify_columns` always passes a Scope;
  // this is the OTHER public entry the function itself supports, py:1231-1234).
  const ast = parseOne("SELECT a + 1 FROM t");
  qualify_outputs(ast, new Dialect());
  assert.equal(ast.sql(), "SELECT a + 1 AS _col_0 FROM t");
});

test("qualify_outputs: a non-Selectable expression is a silent no-op", () => {
  const ast = parseOne("SELECT 1");
  const before = ast.sql();
  qualify_outputs(ast.expressions[0], new Dialect());
  assert.equal(ast.sql(), before);
});

test("pushdown_cte_alias_columns: pushes CTE alias-column names into the CTE's own projections and pops them from the WITH clause", () => {
  const ast = parseOne("WITH cte(x, y) AS (SELECT a, b FROM t) SELECT x FROM cte");
  const scopes = traverseScope(ast);
  const outerScope = scopes.at(-1);
  pushdown_cte_alias_columns(outerScope);
  assert.equal(ast.sql(), "WITH cte(x, y) AS (SELECT a AS x, b AS y FROM t) SELECT x FROM cte");
});

test("pushdown_cte_alias_columns: a CTE with no alias columns is left untouched", () => {
  const ast = parseOne("WITH cte AS (SELECT a FROM t) SELECT a FROM cte");
  const before = ast.sql();
  const scopes = traverseScope(ast);
  pushdown_cte_alias_columns(scopes.at(-1));
  assert.equal(ast.sql(), before);
});

test("dialect option threads through to schema.dialect: BigQuery's TABLES_REFERENCEABLE_AS_COLUMNS activates", () => {
  // `TableColumn` has no base-Generator TRANSFORMS entry yet (pre-existing, unrelated
  // gap -- see `gen_qualify_columns_ref.py`'s own `STRUCTURAL` set), so this asserts
  // the AST shape directly rather than calling `.sql()`.
  const ast = parseOne("SELECT t FROM t", { dialect: "bigquery" });
  const out = qualify_columns(ast, { t: { a: "INT" } }, { dialect: "bigquery" });
  const selection = out.expressions[0];
  assert.ok(selection.this instanceof exp.TableColumn);
  assert.equal(selection.this.name, "t");
  assert.equal(selection.alias, "t");
});

test("default dialect leaves a bare table-name column unqualified rather than converting it (no TABLES_REFERENCEABLE_AS_COLUMNS)", () => {
  assert.equal(q("SELECT t FROM t", { t: { a: "INT" } }), "SELECT t AS t FROM t");
});

test("qualify_columns returns the SAME expression object it was given (in-place mutation, not a copy)", () => {
  const ast = parseOne("SELECT a FROM t");
  const out = qualify_columns(ast, { t: { a: "INT" } });
  assert.equal(out, ast);
});

test("Snowflake positional column ref ($1) resolves against the real schema column order", () => {
  assert.equal(
    q("SELECT t.$1 FROM t", { t: { a: "INT", b: "INT" } }, {}, "snowflake"),
    "SELECT t.A AS A FROM t",
  );
});

test("GROUP BY positional reference (1) rewrites to the real projection expression", () => {
  assert.equal(
    q("SELECT a, COUNT(*) FROM t GROUP BY 1", { t: { a: "INT" } }),
    "SELECT t.a AS a, COUNT(*) AS _col_1 FROM t GROUP BY t.a",
  );
});

test("alias reference in WHERE expands to the real underlying qualified column", () => {
  assert.equal(
    q("SELECT a AS b FROM t WHERE b > 1", { t: { a: "INT" } }),
    "SELECT t.a AS b FROM t WHERE t.a > 1",
  );
});
