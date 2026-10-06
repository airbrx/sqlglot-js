// Structural/behavioral tests for `src/optimizer/optimizer.js` (`RULES` + `optimize()`),
// runnable with no Python present.
//
// The deep differential signal (both sides running the real, full default-`RULES`
// `optimizer.optimize()` pipeline over the real `tests/fixtures/optimizer/optimizer.sql`
// fixture) lives in `spike/p10/fuzz_optimizer.mjs` -- see that file and
// `gen_optimizer_ref.py`'s own header. CPython never needs to exercise the one real
// BEHAVIORAL DEVIATION this file introduces on purpose -- an unrecognized top-level
// kwarg raises here instead of upstream's own silent no-op (see `optimizer.js`'s own
// header, "a second, deliberate deviation from upstream") -- so there is no reference
// value to diff against for it; it is covered here instead.

import test from "node:test";
import assert from "node:assert/strict";
import { parseOne } from "../src/dialects/dialect.js";
import "../src/generator.js";
import { RULES, optimize } from "../src/optimizer/optimizer.js";
import { qualify } from "../src/optimizer/qualify.js";
import { pushdown_projections } from "../src/optimizer/pushdown_projections.js";
import { normalize } from "../src/optimizer/normalize.js";
import { unnest_subqueries } from "../src/optimizer/unnest_subqueries.js";
import { pushdown_predicates } from "../src/optimizer/pushdown_predicates.js";
import { optimize_joins } from "../src/optimizer/optimize_joins.js";
import { eliminate_subqueries } from "../src/optimizer/eliminate_subqueries.js";
import { merge_subqueries } from "../src/optimizer/merge_subqueries.js";
import { eliminate_joins } from "../src/optimizer/eliminate_joins.js";
import { eliminate_ctes } from "../src/optimizer/eliminate_ctes.js";
import { quote_identifiers } from "../src/optimizer/qualify_columns.js";
import { annotate_types } from "../src/optimizer/annotate_types.js";
import { canonicalize } from "../src/optimizer/canonicalize.js";
import { simplify } from "../src/optimizer/simplify.js";

test("RULES is upstream's exact 14-rule sequence, in upstream's exact order", () => {
  assert.deepEqual(RULES, [
    qualify,
    pushdown_projections,
    normalize,
    unnest_subqueries,
    pushdown_predicates,
    optimize_joins,
    eliminate_subqueries,
    merge_subqueries,
    eliminate_joins,
    eliminate_ctes,
    quote_identifiers,
    annotate_types,
    canonicalize,
    simplify,
  ]);
});

test("optimize() runs the default RULES end to end and simplifies a bare expression", () => {
  // py: test_optimizer.py:253 `self.assertEqual(optimizer.optimize("x = 1 + 1",
  // identify=False).sql(), "x = 2")`.
  assert.equal(optimize("x = 1 + 1", { identify: false }).sql(), "x = 2");
});

test("optimize() qualifies and quotes columns/tables against a schema by default", () => {
  const schema = { x: { a: "INT", b: "INT" }, y: { b: "INT", c: "INT" } };
  const result = optimize("SELECT a FROM x JOIN y ON x.b = y.b WHERE a = 1", { schema });
  assert.equal(
    result.sql(),
    'SELECT "x"."a" AS "a" FROM "x" AS "x" JOIN "y" AS "y" ON "x"."b" = "y"."b" WHERE "x"."a" = 1',
  );
});

test("optimize() raises on an unrecognized top-level kwarg instead of upstream's silent no-op", () => {
  assert.throws(
    () => optimize("SELECT 1", { schema: {}, nonexistent_kwarg: true }),
    (e) => e.constructor.name === "PyValueError" && /nonexistent_kwarg/.test(e.message),
  );
});

test("optimize() forwards a shared-name kwarg to every rule declaring it (qualify AND quote_identifiers both read `identify`)", () => {
  // `identify: false` must suppress quoting from BOTH qualify()'s own internal step
  // (suppressed anyway via the forced `quote_identifiers: false` possibleKwargs entry)
  // and the separate standalone `quote_identifiers` RULE later in the pipeline.
  const schema = { x: { a: "INT" } };
  const result = optimize("SELECT a FROM x", { schema, identify: false });
  assert.equal(result.sql(), "SELECT x.a AS a FROM x AS x");
});

test("optimize() copies the input expression rather than mutating it in place", () => {
  const original = parseOne("SELECT a FROM x");
  optimize(original, { schema: { x: { a: "INT" } } });
  assert.equal(original.sql(), "SELECT a FROM x");
});

test("optimize() accepts a pre-parsed Expr the same way it accepts a raw SQL string", () => {
  const schema = { x: { a: "INT" } };
  const fromString = optimize("SELECT a FROM x", { schema }).sql();
  const fromExpr = optimize(parseOne("SELECT a FROM x"), { schema }).sql();
  assert.equal(fromString, fromExpr);
});

test("a rules= override containing a function outside the known 14 receives expression only (documented limitation)", () => {
  let calledWith;
  function spy(...args) {
    calledWith = args.length;
    return args[0];
  }
  const result = optimize("SELECT 1", { rules: [spy] });
  assert.equal(calledWith, 1);
  assert.equal(result.sql(), "SELECT 1");
});
