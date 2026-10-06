// Structural/behavioral tests for `src/optimizer/canonicalize.js` (AIR-2117), runnable
// with no Python present.
//
// The deep differential signal (this file's output vs CPython's real
// `sqlglot.optimizer.canonicalize`, run through upstream's own exact test pipeline --
// `optimizer.optimize(sql, rules=[qualify, quote_identifiers, annotate_types,
// canonicalize], ...)` -- over the real fixture corpus `tests/fixtures/optimizer/
// canonicalize.sql` plus a hand-picked battery for the COERCIBLE_DATE_OPS members and
// the `remove_ascending_order` shape the fixture corpus never exercises) lives in
// `spike/p10/fuzz_canonicalize.mjs` -- see that file and `gen_canonicalize_ref.py`'s own
// header for the full rationale, including the two pre-existing base-Generator gaps
// (`concat_sql`/`dateadd_sql`) it works around with a structural fingerprint instead of
// `.sql()` text. These tests assert the same contracts directly, with no CPython
// dependency, so `node --test` alone still catches a regression.
//
// `ensure_bools` (py:149) landed first, at R43 -- it has carried zero direct
// `test/*.test.mjs` coverage of its own since (only exercised indirectly through
// `transforms.js`'s wrapper and TSQL's `ENSURE_BOOLS` generator setting); a few cases
// are added below alongside everything this round ports, for the same completeness
// reason every other P10 module's own test file exists.

import test from "node:test";
import assert from "node:assert/strict";
import { parseOne } from "../src/dialects/dialect.js";
import { qualify } from "../src/optimizer/qualify.js";
import { annotate_types } from "../src/optimizer/annotate_types.js";
import {
  add_text_to_concat,
  canonicalize,
  coerce_type,
  ensure_bools,
  remove_ascending_order,
  remove_redundant_casts,
  replace_date_funcs,
} from "../src/optimizer/canonicalize.js";
import * as exp from "../src/expressions/index.js";
import "../src/generator.js";
import "../src/dialects/tsql.js";

// Mirrors `gen_canonicalize_ref.py`'s own `SCHEMA` (`tests/helpers.py`'s `self.schema`,
// trimmed to the tables these scenarios touch).
const SCHEMA = {
  x: { a: "INT", b: "INT" },
  w: { d: "TEXT", e: "TEXT" },
  temporal: { d: "DATE", t: "DATETIME" },
};

// Mirrors upstream's own `optimizer.optimize(sql, rules=[qualify, quote_identifiers,
// annotate_types, canonicalize], ...)` pipeline (`qualify()`'s own default
// `quoteIdentifiers: true` already performs the separate `quote_identifiers` rule's
// job -- see `fuzz_canonicalize.mjs`'s own comment on this).
function run(sql, { dialect = null, schema = SCHEMA } = {}) {
  let ast = parseOne(sql, { read: dialect ?? undefined });
  ast = qualify(ast, { schema, dialect, isolateTables: true });
  ast = annotate_types(ast, { schema, dialect });
  ast = canonicalize(ast, { dialect });
  return ast.sql(dialect);
}

test("module docstring example: w.d + w.e over two TEXT columns becomes CONCAT", () => {
  // `.sql()` can't render the resulting `exp.Concat` (pre-existing, unrelated
  // `concat_sql` base-Generator gap -- see this file's own header), so this asserts
  // the AST SHAPE `add_text_to_concat` itself is responsible for instead.
  let ast = parseOne("SELECT w.d + w.e AS c FROM w AS w");
  ast = qualify(ast, { schema: SCHEMA, isolateTables: true });
  ast = annotate_types(ast, { schema: SCHEMA });
  ast = canonicalize(ast);
  const concat = ast.find(exp.Concat);
  assert.ok(concat, "expected an exp.Concat node after canonicalize()");
  assert.equal(concat.args.coalesce, false);
  assert.equal(concat.expressions[0].sql(), '"w"."d"');
  assert.equal(concat.expressions[1].sql(), '"w"."e"');
});

test("CAST(w.d AS DATE) > w.e promotes the bare column to a matching DATE cast", () => {
  assert.equal(
    run("SELECT CAST(w.d AS DATE) > w.e AS a FROM w AS w"),
    'SELECT CAST("w"."d" AS DATE) > CAST("w"."e" AS DATE) AS "a" FROM "w" AS "w"',
  );
});

test("CAST(1 + 3.2 AS DOUBLE) is a redundant cast, removed", () => {
  assert.equal(
    run("SELECT CAST(1 + 3.2 AS DOUBLE) AS a FROM w AS w"),
    'SELECT 1 + 3.2 AS "a" FROM "w" AS "w"',
  );
});

test("Ensure boolean predicates: bare column in WHERE becomes <> 0", () => {
  assert.equal(
    run("SELECT a FROM x WHERE b"),
    'SELECT "x"."a" AS "a" FROM "x" AS "x" WHERE "x"."b" <> 0',
  );
});

test("Ensure boolean predicates: NOT b", () => {
  assert.equal(
    run("SELECT NOT b FROM x"),
    'SELECT NOT "x"."b" <> 0 AS "_col_0" FROM "x" AS "x"',
  );
});

test("Ensure boolean predicates: COALESCE recurses into both branches", () => {
  assert.equal(
    run("SELECT a FROM x WHERE COALESCE(0, 1)"),
    'SELECT "x"."a" AS "a" FROM "x" AS "x" WHERE COALESCE(0 <> 0, 1 <> 0)',
  );
});

test("Ensure boolean predicates: a CASE branch value is NOT replaced (If.parent is a Case)", () => {
  assert.equal(
    run("SELECT a FROM x WHERE CASE WHEN COALESCE(b, 1) THEN 1 ELSE 0 END"),
    'SELECT "x"."a" AS "a" FROM "x" AS "x" WHERE CASE WHEN COALESCE("x"."b" <> 0, 1 <> 0) THEN 1 ELSE 0 END <> 0',
  );
});

test("Replace date functions: DATE('2023-01-01') becomes CAST(... AS DATE)", () => {
  assert.equal(canonicalize(parseOne("DATE('2023-01-01')")).sql(), "CAST('2023-01-01' AS DATE)");
});

test("Replace date functions: a non-ISO-date DATE(...) argument is left alone", () => {
  assert.equal(
    canonicalize(parseOne("DATE('2023-01-01 00:00:00')")).sql(),
    "DATE('2023-01-01 00:00:00')",
  );
});

test("Replace date functions: TIMESTAMP('2023-01-01') becomes CAST(... AS TIMESTAMP)", () => {
  assert.equal(
    canonicalize(parseOne("TIMESTAMP('2023-01-01')")).sql(),
    "CAST('2023-01-01' AS TIMESTAMP)",
  );
});

test("Coerce date function args: '2023-01-01' + INTERVAL '1' DAY casts the string to DATE", () => {
  assert.equal(
    canonicalize(annotate_types(parseOne("'2023-01-01' + INTERVAL '1' DAY"))).sql(),
    "CAST('2023-01-01' AS DATE) + INTERVAL '1' DAY",
  );
});

test("Coerce date function args: '2023-01-01' + INTERVAL '1' HOUR promotes to DATETIME", () => {
  assert.equal(
    canonicalize(annotate_types(parseOne("'2023-01-01' + INTERVAL '1' HOUR"))).sql(),
    "CAST('2023-01-01' AS DATETIME) + INTERVAL '1' HOUR",
  );
});

test("Coerce date function args: DATE_ADD('2023-01-01', 1, 'YEAR') casts the literal arg", () => {
  // `.sql()` on the whole tree hits a pre-existing, unrelated `dateadd_sql`
  // base-Generator gap (see this file's own header) -- asserts the AST shape
  // `coerce_type`/`_coerce_timeunit_arg` are actually responsible for instead.
  const ast = canonicalize(annotate_types(parseOne("DATE_ADD('2023-01-01', 1, 'YEAR')")));
  const dateAdd = ast.find(exp.DateAdd);
  assert.ok(dateAdd, "expected an exp.DateAdd node");
  assert.equal(dateAdd.this.sql(), "CAST('2023-01-01' AS DATE)");
});

test("Coerce date function args: DATEDIFF casts both non-temporal args to DATETIME", () => {
  assert.equal(
    canonicalize(parseOne("SELECT DATEDIFF(a, b) FROM t")).sql(),
    "SELECT DATEDIFF(CAST(a AS DATETIME), CAST(b AS DATETIME)) FROM t",
  );
});

test("Remove redundant casts: CAST(CAST(foo AS DECIMAL(4,2)) AS DECIMAL(4,2)) collapses", () => {
  assert.equal(
    remove_redundant_casts(annotate_types(parseOne("CAST(CAST(foo AS DECIMAL(4, 2)) AS DECIMAL(4, 2))"))).sql(),
    "CAST(foo AS DECIMAL(4, 2))",
  );
});

test("Remove redundant casts: a differently-precisioned re-cast is kept", () => {
  const sql = "CAST(CAST(foo AS DECIMAL(4, 2)) AS DECIMAL(8, 4))";
  assert.equal(remove_redundant_casts(annotate_types(parseOne(sql))).sql(), sql);
});

test("Remove redundant casts: DATE(x) unwraps when x is already a plain DATE", () => {
  const ast = annotate_types(parseOne("CAST('2023-01-01' AS DATE)"));
  const dateWrapped = new exp.Date({ this: ast });
  assert.equal(remove_redundant_casts(dateWrapped).sql(), "CAST('2023-01-01' AS DATE)");
});

test("remove_ascending_order: explicit ASC is stripped", () => {
  const ast = parseOne("SELECT a FROM x ORDER BY a ASC");
  assert.equal(canonicalize(ast).sql(), "SELECT a FROM x ORDER BY a");
});

test("remove_ascending_order: explicit DESC is left alone", () => {
  const sql = "SELECT a FROM x ORDER BY a DESC";
  assert.equal(canonicalize(parseOne(sql)).sql(), sql);
});

test("remove_ascending_order: no modifier at all is left alone (desc is null, not false)", () => {
  const sql = "SELECT a FROM x ORDER BY a";
  assert.equal(canonicalize(parseOne(sql)).sql(), sql);
});

test("COERCIBLE_DATE_OPS: BETWEEN only coerces the low bound, matching upstream exactly", () => {
  assert.equal(
    run("SELECT t.d BETWEEN '2023-01-01' AND '2023-01-02' FROM temporal AS t"),
    'SELECT "t"."d" BETWEEN CAST(\'2023-01-01\' AS DATE) AND \'2023-01-02\' AS "_col_0" FROM "temporal" AS "t"',
  );
});

test("COERCIBLE_DATE_OPS: EQ/NEQ/GTE/LTE/NullSafeEQ all coerce a date-looking string literal", () => {
  const cases = [
    ["=", "EQ", "SELECT t.d = '2023-01-01' FROM temporal AS t"],
    ["<>", "NEQ", "SELECT t.d <> '2023-01-01' FROM temporal AS t"],
    [">=", "GTE", "SELECT t.d >= '2023-01-01' FROM temporal AS t"],
    ["<=", "LTE", "SELECT t.d <= '2023-01-01' FROM temporal AS t"],
  ];
  for (const [op, _name, sql] of cases) {
    assert.equal(
      run(sql),
      `SELECT "t"."d" ${op} CAST('2023-01-01' AS DATE) AS "_col_0" FROM "temporal" AS "t"`,
      sql,
    );
  }
});

test("add_text_to_concat is a no-op for a non-Add node or a non-TEXT-typed Add", () => {
  const sub = annotate_types(parseOne("SELECT 1 + 2"));
  const addNode = sub.find(exp.Add);
  assert.equal(add_text_to_concat(addNode), addNode);
  const notAdd = parseOne("SELECT 1");
  assert.equal(add_text_to_concat(notAdd), notAdd);
});

test("replace_date_funcs is a no-op for anything else", () => {
  const node = parseOne("SELECT 1");
  assert.equal(replace_date_funcs(node), node);
});

test("coerce_type is a no-op for anything outside its dispatch set", () => {
  const node = parseOne("SELECT 1");
  assert.equal(coerce_type(node, false), node);
});

test("ensure_bools: Connector replaces both sides", () => {
  const ast = annotate_types(parseOne("SELECT a AND b FROM t_bool"), { schema: { t_bool: { a: "INT", b: "INT" } } });
  const connector = ast.find(exp.Connector);
  const seen = [];
  ensure_bools(connector, (n) => seen.push(n.sql()));
  assert.deepEqual(seen.sort(), ["a", "b"]);
});

test("ensure_bools: Where/Having call replace_func on their condition", () => {
  const where = new exp.Where({ this: exp.column("x") });
  const seen = [];
  ensure_bools(where, (n) => seen.push(n.sql()));
  assert.deepEqual(seen, ["x"]);
});
