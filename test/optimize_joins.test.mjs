// Structural/behavioral tests for `src/optimizer/optimize_joins.js`, runnable with no
// Python present.
//
// The deep differential signal (this file's output vs CPython's
// `sqlglot.optimizer.optimize_joins`, over 26 scenarios plus both upstream doctests)
// lives in `spike/p7/fuzz_optimize_joins.mjs` — see that file and
// `gen_optimize_joins_ref.py`'s own header for why. These tests assert the same
// rendered-SQL contract directly, with no CPython dependency, so `node --test` alone
// still catches a regression.

import test from "node:test";
import assert from "node:assert/strict";
import { parseOne } from "../src/dialects/dialect.js";
import { optimize_joins, reorder_joins, normalize, other_table_names } from "../src/optimizer/optimize_joins.js";
import "../src/generator.js";

const optimize = (sql) => optimize_joins(parseOne(sql)).sql();

test("module docstring example: cross join promoted, predicate moved and replaced with TRUE", () => {
  assert.equal(
    optimize("SELECT * FROM x CROSS JOIN y JOIN z ON x.a = z.a AND y.a = z.a"),
    "SELECT * FROM x JOIN z ON x.a = z.a AND TRUE JOIN y ON y.a = z.a",
  );
});

test("_is_reorderable doctest: no side-bearing join -> joins may be reordered/optimized", () => {
  // No cross join present, so the observable signal is that nothing throws and the
  // query round-trips unchanged (join order is already topologically valid).
  assert.equal(
    optimize("SELECT * FROM x JOIN y ON x.id = y.id JOIN z ON y.id = z.id"),
    "SELECT * FROM x JOIN y ON x.id = y.id JOIN z ON y.id = z.id",
  );
});

test("_is_reorderable doctest: a LEFT join blocks reordering for the whole select", () => {
  assert.equal(
    optimize("SELECT * FROM x LEFT JOIN y ON x.id = y.id JOIN z ON y.id = z.id"),
    "SELECT * FROM x LEFT JOIN y ON x.id = y.id JOIN z ON y.id = z.id",
  );
});

test("ANTI join's ON clause is never extracted from, even though it stays reorderable", () => {
  assert.equal(
    optimize("SELECT * FROM x CROSS JOIN y ANTI JOIN z ON x.a = z.a AND y.a = z.a"),
    "SELECT * FROM x CROSS JOIN y ANTI JOIN z ON x.a = z.a AND y.a = z.a",
  );
});

test("SEMI join (no side) still has its conjuncts extracted, unlike ANTI", () => {
  assert.equal(
    optimize("SELECT * FROM x CROSS JOIN y SEMI JOIN z ON x.a = z.a AND y.a = z.a"),
    "SELECT * FROM x SEMI JOIN z ON x.a = z.a AND TRUE JOIN y ON y.a = z.a",
  );
});

test("a FULL join's side blocks the whole query's reordering and extraction", () => {
  assert.equal(
    optimize("SELECT * FROM x FULL JOIN y ON x.a = y.a CROSS JOIN z"),
    "SELECT * FROM x FULL JOIN y ON x.a = y.a CROSS JOIN z",
  );
});

test("comma joins become explicit CROSS JOIN via normalize()", () => {
  assert.equal(optimize("SELECT * FROM x, y, z"), "SELECT * FROM x CROSS JOIN y CROSS JOIN z");
});

test("INNER/OUTER keywords are stripped as optional", () => {
  assert.equal(optimize("SELECT * FROM x INNER JOIN y ON x.a = y.a"), "SELECT * FROM x JOIN y ON x.a = y.a");
  assert.equal(optimize("SELECT * FROM x OUTER JOIN y ON x.a = y.a"), "SELECT * FROM x JOIN y ON x.a = y.a");
});

test("JOIN...USING is neither promoted (no ON to reference) nor forced to CROSS", () => {
  assert.equal(
    optimize("SELECT * FROM x JOIN y USING (a) CROSS JOIN z"),
    "SELECT * FROM x JOIN y USING (a) CROSS JOIN z",
  );
});

test("only exp.And roots are inspected for extraction; an OR root is left alone", () => {
  assert.equal(
    optimize("SELECT * FROM x JOIN y ON x.a = y.a OR x.b = y.b CROSS JOIN z"),
    "SELECT * FROM x CROSS JOIN z JOIN y ON x.a = y.a OR x.b = y.b",
  );
});

test("a two-or-more-distinct-table AND extracts only the matching conjunct, per conjunct", () => {
  assert.equal(
    optimize("SELECT * FROM x CROSS JOIN y JOIN z ON x.a = z.a AND y.a = z.a AND z.b > 5"),
    "SELECT * FROM x JOIN z ON x.a = z.a AND TRUE AND z.b > 5 JOIN y ON y.a = z.a",
  );
});

test("an AND whose conjuncts only reference the join's own table skips extraction (<2 guard)", () => {
  assert.equal(
    optimize("SELECT * FROM x CROSS JOIN y JOIN z ON z.a = z.b AND z.c = z.d"),
    "SELECT * FROM x CROSS JOIN y JOIN z ON z.a = z.b AND z.c = z.d",
  );
});

test("normalize() sets CROSS on a join with no JOIN_ATTRS present", () => {
  const select = parseOne("SELECT * FROM x, y");
  const out = normalize(select);
  assert.equal(out.sql(), "SELECT * FROM x CROSS JOIN y");
});

test("other_table_names excludes the join's own alias and returns a Set", () => {
  const select = parseOne("SELECT * FROM x JOIN z ON x.a = z.a AND z.b = z.c");
  const join = select.args.joins[0];
  const names = other_table_names(join);
  assert.ok(names instanceof Set);
  assert.deepEqual([...names], ["x"]);
});

test("reorder_joins throws OptimizeError when a FROM clause has no parent", () => {
  const select = parseOne("SELECT * FROM x JOIN y ON x.a = y.a");
  const from_ = select.args.from_;
  from_.parent = null;
  assert.throws(() => reorder_joins(from_), /FROM clause without parent expression/);
});
