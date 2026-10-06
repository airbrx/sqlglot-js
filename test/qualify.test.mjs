// Structural/behavioral tests for `src/optimizer/qualify.js` (AIR-2108, epic
// AIR-2087), runnable with no Python present.
//
// The deep differential signal (this file's output vs CPython's real
// `sqlglot.optimizer.qualify.qualify`, run end-to-end through
// `tests/fixtures/optimizer/{qualify_columns,qualify_columns_ddl,
// qualify_columns__with_invisible,qualify_columns__invalid,qualify_tables}.sql` plus a
// hand-picked kwarg-surface battery) lives in `spike/p10/fuzz_qualify.mjs` — see that
// file and `gen_qualify_ref.py`'s own header for the full scenario list. These tests
// assert the same composed-pipeline contract directly, with no CPython dependency, so
// `node --test` alone still catches a regression in how this file wires its five
// dependencies together.
//
// A few assertions below render a `t.$N` Snowflake positional-column reference that
// was left UNRESOLVED (either because the dialect doesn't support positional columns,
// or because `allowPartialQualification` suppressed the out-of-range raise) -- `.sql()`
// on that shape hits `parameter_sql`, a pre-existing `NotPorted` base-Generator stub
// unrelated to this file (same "structural repr instead of .sql()" treatment
// `gen_qualify_columns_ref.py`'s own `STRUCTURAL` set already established, precedent
// reused rather than invented here).

import test from "node:test";
import assert from "node:assert/strict";
import { parseOne } from "../src/dialects/dialect.js";
import { qualify } from "../src/optimizer/qualify.js";
import { MappingSchema } from "../src/schema.js";
import "../src/generator.js";
import "../src/dialects/bigquery.js";
import "../src/dialects/snowflake.js";
import "../src/dialects/postgres.js";

const q = (sql, options, dialect) => qualify(parseOne(sql, { dialect }), options).sql(dialect);

test("module docstring example: SELECT col FROM tbl against a one-table schema", () => {
  assert.equal(
    q("SELECT col FROM tbl", { schema: { tbl: { col: "INT" } } }),
    'SELECT "tbl"."col" AS "col" FROM "tbl" AS "tbl"',
  );
});

test("on_qualify threads through to qualify_tables unchanged, qualifyColumns=false skips column qualification", () => {
  const tables = [];
  qualify(parseOne("with foo AS (select * from bar) select * from foo join baz"), {
    qualifyColumns: false,
    onQualify: (t) => tables.push(t.name),
  });
  assert.deepEqual(tables, ["bar", "baz"]);
});

test("db/catalog/dialect/quoteIdentifiers=false compose correctly on a bigquery CTE", () => {
  const out = q(
    "WITH tesT AS (SELECT * FROM t1) SELECT * FROM test",
    { db: "db", catalog: "catalog", dialect: "bigquery", quoteIdentifiers: false },
    "bigquery",
  );
  assert.equal(out, "WITH test AS (SELECT * FROM catalog.db.t1 AS t1) SELECT * FROM test AS test");
});

test("full pipeline composition: bigquery join + GROUP BY 1 positional alias resolution", () => {
  const out = q(
    `SELECT Teams.Name, count(*)
     FROM raw.TeamMemberships as TeamMemberships
     join raw.Teams
         on Teams.Id = TeamMemberships.TeamId
     GROUP BY 1`,
    {
      schema: {
        raw: {
          TeamMemberships: { Id: "INTEGER", UserId: "INTEGER", TeamId: "INTEGER" },
          Teams: { Id: "INTEGER", Name: "STRING" },
        },
      },
      dialect: "bigquery",
    },
    "bigquery",
  );
  assert.equal(
    out,
    "SELECT `teams`.`name` AS `name`, count(*) AS `_col_1` FROM `raw`.`TeamMemberships` AS `teammemberships` "
      + "JOIN `raw`.`Teams` AS `teams` ON `teams`.`id` = `teammemberships`.`teamid` GROUP BY `teams`.`name`",
  );
});

test("validateQualifyColumns default true raises OptimizeError with sql= highlighting", () => {
  const sql = "SELECT nonexistent FROM x";
  assert.throws(
    () => qualify(parseOne(sql), { schema: { x: { a: "INT", b: "INT" } }, sql }),
    (e) => e.constructor.name === "OptimizeError" && e.message.includes("Column 'nonexistent' could not be resolved"),
  );
});

test("qualifyColumns=false + validateQualifyColumns=false skip both steps cleanly", () => {
  const out = q("SELECT a FROM t", { schema: { t: { a: "INT" } }, qualifyColumns: false, validateQualifyColumns: false, quoteIdentifiers: false });
  assert.equal(out, "SELECT a FROM t AS t");
});

test("expandStars=false leaves a bare star unexpanded", () => {
  const out = q("SELECT * FROM t", { schema: { t: { a: "INT", b: "INT" } }, expandStars: false });
  assert.equal(out, 'SELECT * FROM "t" AS "t"');
});

test("identify=false (with quoteIdentifiers default true) only quotes identifiers that need it", () => {
  const out = q("SELECT * FROM t", { schema: { t: { end: "text" } }, identify: false });
  assert.equal(out, "SELECT t.end AS end FROM t AS t");
});

test("isolateTables=true wraps a multi-source scope's tables in their own SELECT", () => {
  const out = q("SELECT a FROM x CROSS JOIN y", { schema: { x: { a: "INT" }, y: { b: "INT" } }, isolateTables: true });
  assert.equal(
    out,
    'SELECT "x"."a" AS "a" FROM (SELECT "x"."a" AS "a" FROM "x" AS "x") AS "x" CROSS JOIN (SELECT "y"."b" AS "b" FROM "y" AS "y") AS "y"',
  );
});

test("canonicalizeTableAliases=true renames every source to _0, _1, ...", () => {
  const out = q("SELECT 1 FROM tbl1, tbl2", { canonicalizeTableAliases: true, quoteIdentifiers: false });
  assert.equal(out, 'SELECT 1 AS "1" FROM tbl1 AS _0, tbl2 AS _1');
});

test("snowflake $N positional column resolves against a schema with a visible-columns restriction", () => {
  const visibleSchema = new MappingSchema({ t: { hidden: "INT", "HAS SPACE": "INT" } }, { T: new Set(["HAS SPACE"]) }, "snowflake");
  const out = q("SELECT t.$1 FROM t", { dialect: "snowflake", quoteIdentifiers: false, schema: visibleSchema }, "snowflake");
  assert.equal(out, 'SELECT T."HAS SPACE" AS "HAS SPACE" FROM T AS T');
});

test("positional columns are snowflake-only: postgres leaves t.$1 unresolved under allowPartialQualification", () => {
  const out = qualify(parseOne("WITH t AS (SELECT 1 AS a) SELECT t.$1 FROM t", { dialect: "postgres" }), {
    dialect: "postgres",
    allowPartialQualification: true,
    quoteIdentifiers: false,
  });
  assert.match(out.toString(), /this=Parameter\(\s*\n\s*this=Literal\(this=1, is_string=False\)\)/);
});

test("snowflake out-of-range $N raises by default, but is left unresolved under allowPartialQualification", () => {
  const sql = "WITH t AS (SELECT 1 AS a) SELECT t.$2 FROM t";

  assert.throws(
    () => qualify(parseOne(sql, { dialect: "snowflake" }), { dialect: "snowflake" }),
    (e) => e.constructor.name === "OptimizeError" && /Positional reference \$2 is out of range for source 'T'/.test(e.message),
  );

  const out = qualify(parseOne(sql, { dialect: "snowflake" }), {
    dialect: "snowflake",
    allowPartialQualification: true,
    quoteIdentifiers: false,
  });
  assert.match(out.toString(), /this=Parameter\(\s*\n\s*this=Literal\(this=2, is_string=False\)\)/);
});

test("a DDL CREATE TABLE AS SELECT with a CTE is qualified end to end", () => {
  const out = q(
    "WITH cte AS (SELECT b FROM y) CREATE TABLE s AS SELECT * FROM cte",
    { schema: { y: { b: "INT" } }, quoteIdentifiers: false, identify: false },
  );
  assert.equal(
    out,
    "WITH cte AS (SELECT y.b AS b FROM y AS y) CREATE TABLE s AS SELECT cte.b AS b FROM cte AS cte",
  );
});
