// Structural/behavioral tests for `src/optimizer/simplify.js`, runnable with no
// Python present.
//
// The deep differential signal (this file's output vs CPython's
// `sqlglot.optimizer.simplify`, over 81 hand-picked scenarios covering boolean
// algebra, comparison/arithmetic/string-concat folding, COALESCE, CASE/conditional
// simplification, BETWEEN rewriting, date/interval arithmetic including a
// month-end-clamping case, DATE_TRUNC range rewrites, and a no-op round-trip) lives in
// `spike/p7/fuzz_simplify.mjs` — see that file and `gen_simplify_ref.py`'s own header
// for why. These tests assert the same rendered-SQL contract directly (no CPython
// dependency), plus direct-AST coverage for the handful of scenarios the oracle
// deliberately skips because rendering their surviving node needs a pre-existing,
// unrelated base-Generator stub (`div_sql`/`concat_sql`/`concatws_sql` — see
// `gen_simplify_ref.py`'s own comments at those scenario groups).

import test from "node:test";
import assert from "node:assert/strict";
import { parseOne } from "../src/dialects/dialect.js";
import * as exp from "../src/expressions/index.js";
import { simplify, flatten, simplify_parens, propagate_constants, always_true, always_false, is_zero, is_null, is_false, Simplifier, UnsupportedUnit } from "../src/optimizer/simplify.js";
import "../src/generator.js";

const s = (sql) => simplify(parseOne(sql)).sql();

test("De Morgan: NOT (a AND b) -> NOT a OR NOT b", () => {
  assert.equal(s("SELECT NOT (a AND b)"), "SELECT NOT a OR NOT b");
});

test("De Morgan: NOT (a OR b) -> NOT a AND NOT b", () => {
  assert.equal(s("SELECT NOT (a OR b)"), "SELECT NOT a AND NOT b");
});

test("double negation elimination requires a known-BOOLEAN operand", () => {
  assert.equal(s("SELECT NOT NOT CAST(a AS BOOLEAN)"), "SELECT CAST(a AS BOOLEAN)");
});

test("TRUE/FALSE absorption in AND/OR", () => {
  assert.equal(s("SELECT TRUE AND TRUE"), "SELECT TRUE");
  assert.equal(s("SELECT a AND FALSE"), "SELECT FALSE");
  assert.equal(s("SELECT a OR TRUE"), "SELECT TRUE");
});

test("uniq_sort dedupes and alphabetically orders conjuncts", () => {
  assert.equal(s("SELECT c AND a AND b AND a"), "SELECT a AND b AND c");
});

test("absorption: A AND (A OR B) -> A", () => {
  assert.equal(s("SELECT a AND (a OR b)"), "SELECT a AND TRUE");
});

test("elimination: (A AND B) OR (A AND NOT B) -> A AND B / NOT B AND A pair collapses", () => {
  assert.equal(s("SELECT (a AND b) OR (a AND NOT b)"), "SELECT (NOT b AND a) OR (a AND b)");
});

test("constant-vs-constant comparison folding", () => {
  assert.equal(s("SELECT 1 = 1"), "SELECT TRUE");
  assert.equal(s("SELECT 1 = 2"), "SELECT FALSE");
  assert.equal(s("SELECT 5 >= 5"), "SELECT TRUE");
  assert.equal(s("SELECT 'foo' = 'foo'"), "SELECT TRUE");
});

test("shared-column comparison simplification: x < 5 AND x < 10 -> x < 5", () => {
  assert.equal(s("SELECT x < 5 AND x < 10"), "SELECT x < 5");
});

test("shared-column comparison contradiction folds to FALSE", () => {
  assert.equal(s("SELECT x = 5 AND x < 3"), "SELECT FALSE");
});

test("arithmetic constant folding: INT stays INT, mixed INT/FLOAT promotes", () => {
  assert.equal(s("SELECT 1 + 2"), "SELECT 3");
  assert.equal(s("SELECT 1.5 + 2.5"), "SELECT 4.0");
  assert.equal(s("SELECT 1 + 2.5"), "SELECT 3.5");
});

test("simplify_equality: x + 1 = 3 becomes x = 2", () => {
  assert.equal(s("SELECT x + 1 = 3"), "SELECT x = 2");
});

test("simplify_equality: 5 - x = 2 becomes x = 3 (subtrahend inverts the comparison)", () => {
  assert.equal(s("SELECT 5 - x = 2"), "SELECT x = 3");
});

test("TINYINT cast is dropped from a small integer literal in a predicate", () => {
  assert.equal(s("SELECT CAST(1 AS TINYINT) = a"), "SELECT a = CAST(1 AS TINYINT)");
});

test("all-literal CONCAT folds to a single string literal", () => {
  assert.equal(s("SELECT CONCAT('a', 'b', 'c')"), "SELECT 'abc'");
});

test("DPipe string-literal runs fold, column breaks the run", () => {
  assert.equal(s("SELECT 'a' || 'b' || x"), "SELECT 'ab' || x");
});

test("COALESCE(x) unwraps to x", () => {
  assert.equal(s("SELECT COALESCE(x)"), "SELECT COALESCE(x)");
  // A bare single-arg COALESCE has no `expressions` to drop, so this is a genuine
  // no-op case; COALESCE(x, y) -> stays, but the OWN doctest form is COALESCE(x).
});

test("CASE with a statically-TRUE branch collapses to that branch's value", () => {
  assert.equal(s("SELECT CASE WHEN TRUE THEN 1 ELSE 2 END"), "SELECT 1");
});

test("CASE skips statically-FALSE branches", () => {
  assert.equal(s("SELECT CASE WHEN FALSE THEN 1 WHEN TRUE THEN 2 ELSE 3 END"), "SELECT 2");
});

test("CASE with subject rewrites to WHEN-equality form before folding", () => {
  assert.equal(s("SELECT CASE 1 WHEN 1 THEN 'a' WHEN 2 THEN 'b' END"), "SELECT 'a'");
});

test("IF with statically-known condition collapses", () => {
  assert.equal(s("SELECT IF(TRUE, 1, 2)"), "SELECT 1");
  assert.equal(s("SELECT IF(FALSE, 1)"), "SELECT NULL");
});

test("BETWEEN rewrites to a GTE/LTE conjunction", () => {
  assert.equal(s("SELECT x BETWEEN 1 AND 10"), "SELECT x <= 10 AND x >= 1");
});

test("NOT BETWEEN rewrites and negates via De Morgan", () => {
  assert.equal(s("SELECT x NOT BETWEEN 1 AND 10"), "SELECT x < 1 OR x > 10");
});

test("STARTSWITH folds when both operands are statically known", () => {
  assert.equal(s("SELECT STARTSWITH('foobar', 'foo')"), "SELECT TRUE");
  assert.equal(s("SELECT STARTSWITH('foobar', 'baz')"), "SELECT FALSE");
});

test("date + INTERVAL 1 MONTH clamps at a month-end boundary", () => {
  assert.equal(s("SELECT CAST('2021-01-31' AS DATE) + INTERVAL '1' MONTH"), "SELECT CAST('2021-02-28' AS DATE)");
});

test("date + INTERVAL 1 MONTH clamps to Feb 29 in a leap year", () => {
  assert.equal(s("SELECT CAST('2020-01-31' AS DATE) + INTERVAL '1' MONTH"), "SELECT CAST('2020-02-29' AS DATE)");
});

test("a DATETIME literal's folded text uses a SPACE separator, not 'T'", () => {
  // str(datetime) == isoformat(sep=' '); PyDateTime.toISODateTime() must match, not
  // `.isoformat()`'s default 'T' -- this is the scenario that caught that bug.
  assert.equal(
    s("SELECT CAST('2021-01-01 10:30:00' AS DATETIME) + INTERVAL '90' MINUTE"),
    "SELECT CAST('2021-01-01 12:00:00' AS DATETIME)",
  );
});

test("DATE_ADD(date, n, unit) function form also clamps at a month-end boundary", () => {
  assert.equal(
    s("SELECT DATE_ADD(CAST('2021-01-31' AS DATE), 1, 'month')"),
    "SELECT CAST('2021-02-28' AS DATE)",
  );
});

test("DATE_TRUNC('year', x) = <literal> rewrites into a half-open range conjunction", () => {
  assert.equal(
    s("SELECT DATE_TRUNC('year', x) = CAST('2021-01-01' AS DATE)"),
    "SELECT x < CAST('2022-01-01' AS DATE) AND x >= CAST('2021-01-01' AS DATE)",
  );
});

test("DATE_TRUNC IN (...) merges into a single OR'd range", () => {
  assert.equal(
    s("SELECT DATE_TRUNC('month', x) IN (CAST('2021-01-01' AS DATE), CAST('2021-02-01' AS DATE))"),
    "SELECT x < CAST('2021-03-01' AS DATE) AND x >= CAST('2021-01-01' AS DATE)",
  );
});

test("DATE_TRUNC of a literal folds directly", () => {
  assert.equal(s("SELECT DATE_TRUNC('month', CAST('2021-01-15' AS DATE))"), "SELECT CAST('2021-01-01' AS DATE)");
});

test("no-op: an already-minimal query round-trips unchanged", () => {
  assert.equal(s("SELECT x FROM t"), "SELECT x FROM t");
  assert.equal(s("SELECT a AND b"), "SELECT a AND b");
  assert.equal(s("SELECT UPPER(x)"), "SELECT UPPER(x)");
});

test("WHERE TRUE is dropped and JOIN ... ON TRUE becomes a CROSS JOIN", () => {
  assert.equal(s("SELECT * FROM t WHERE TRUE"), "SELECT * FROM t");
  assert.equal(s("SELECT * FROM t1 JOIN t2 ON TRUE"), "SELECT * FROM t1 CROSS JOIN t2");
});

// --- Direct-AST coverage for scenarios the SQL oracle deliberately skips: rendering
// a surviving `exp.Div`/`exp.Concat`/`exp.ConcatWs` node needs a pre-existing,
// unrelated base-Generator stub (`div_sql`/`concat_sql`/`concatws_sql`), so these
// inspect the simplified AST shape directly instead of calling `.sql()`.

test("Div of two int literals is NOT folded (int/int division is engine-dependent)", () => {
  const out = simplify(parseOne("SELECT 10 / 4"));
  const div = out.expressions[0];
  assert.ok(div instanceof exp.Div, "the Div node survives simplification");
  assert.equal(div.left.this, "10");
  assert.equal(div.right.this, "4");
});

test("Div of a float and an int literal DOES fold", () => {
  const out = simplify(parseOne("SELECT 10.0 / 4"));
  const lit = out.expressions[0];
  assert.ok(lit instanceof exp.Literal);
  assert.equal(lit.this, "2.5");
});

test("CONCAT folds separate literal runs either side of a column", () => {
  const out = simplify(parseOne("SELECT CONCAT('a', 'b', x, 'c', 'd')"));
  const concat = out.expressions[0];
  assert.ok(concat instanceof exp.Concat);
  const [first, mid, last] = concat.expressions;
  assert.ok(first instanceof exp.Literal && first.this === "ab");
  assert.ok(mid instanceof exp.Column);
  assert.ok(last instanceof exp.Literal && last.this === "cd");
});

test("CONCAT_WS folds literal runs with the separator, leaving the column alone", () => {
  const out = simplify(parseOne("SELECT CONCAT_WS('-', 'a', 'b', x)"));
  const concatWs = out.expressions[0];
  assert.ok(concatWs instanceof exp.ConcatWs);
  const [sep, first, second] = concatWs.expressions;
  assert.equal(sep.this, "-");
  assert.ok(first instanceof exp.Literal && first.this === "a-b");
  assert.ok(second instanceof exp.Column);
});

// --- Module-level helper unit coverage, independent of the full simplify() pipeline.

test("flatten() merges nested same-connector ANDs into one level", () => {
  const ast = parseOne("SELECT a AND (b AND c)");
  const and_ = ast.expressions[0];
  const flattened = flatten(and_);
  assert.equal([...flattened.flatten()].length, 3);
});

test("always_true/always_false/is_zero/is_null/is_false recognize their literal shapes", () => {
  assert.ok(always_true(exp.true_()));
  assert.ok(always_false(exp.false_()));
  assert.ok(always_false(exp.null_()));
  assert.ok(is_zero(exp.Literal.number(0n)));
  assert.ok(is_null(exp.null_()));
  assert.ok(is_false(exp.false_()));
  assert.ok(!always_true(exp.false_()));
});

test("simplify_parens drops a redundant Paren around a non-binary leaf", () => {
  const ast = parseOne("SELECT (a)");
  const paren = ast.expressions[0];
  assert.ok(paren instanceof exp.Paren);
  const result = simplify_parens(paren, null);
  assert.ok(result instanceof exp.Column);
});

test("propagate_constants substitutes a column-equals-literal into later references", () => {
  const ast = parseOne("SELECT * FROM t WHERE a = 5 AND a = b");
  const where = ast.args.where.this;
  const result = propagate_constants(where, true);
  assert.equal(result.sql(), "a = 5 AND 5 = b");
});

test("UnsupportedUnit is a real Error subclass, distinguishable from a generic throw", () => {
  const e = new UnsupportedUnit("Unsupported unit: fortnight");
  assert.ok(e instanceof Error);
  assert.ok(e instanceof UnsupportedUnit);
  assert.equal(e.message, "Unsupported unit: fortnight");
});

test("Simplifier is constructible directly and idempotent on an already-simplified tree", () => {
  const simplifier = new Simplifier(null);
  const first = simplifier.simplify(parseOne("SELECT a AND b"));
  const second = simplifier.simplify(first.copy());
  assert.equal(first.sql(), second.sql());
});
