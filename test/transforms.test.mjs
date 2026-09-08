// Structural tests for `src/transforms.js`, runnable with no Python present.
//
// The deep differential signal (this file's output vs CPython's `sqlglot.transforms`,
// AST-exact) lives in `spike/p4/fuzz_transforms.mjs` — see that file and
// `src/transforms.js`'s own header for why the generate-oracle corpus cannot reach this
// module yet (PORT_PLAN.md R26). These tests assert AST SHAPE directly rather than
// rendered SQL, because a full render of `eliminate_distinct_on`/`eliminate_qualify`'s
// output needs `window_sql` and `eliminate_semi_and_anti_joins`'s needs `exists_sql`,
// both still `NotPorted` in `src/generator.js` (out of scope for this branch — see
// PORT_PLAN.md R25's explicit "deliberately OUT" list).

import test from "node:test";
import assert from "node:assert/strict";
import * as exp from "../src/expressions/index.js";
import { Dialect } from "../src/dialects/dialect.js";
import { preprocess, eliminate_distinct_on, eliminate_qualify, eliminate_semi_and_anti_joins } from "../src/transforms.js";

const parse = (sql) => Dialect.get_or_raise(null).parse(sql)[0];

test("eliminate_distinct_on rewrites DISTINCT ON into a windowed subquery", () => {
  const select = parse("SELECT DISTINCT ON (a) a, b FROM t");
  const out = eliminate_distinct_on(select);

  assert.ok(out instanceof exp.Select);
  assert.equal(out.expressions.length, 2);
  assert.ok(out.args.from_.this instanceof exp.Subquery);
  assert.equal(out.args.from_.this.args.alias.this.this, "_t");

  const inner = out.args.from_.this.this;
  assert.ok(inner instanceof exp.Select);
  assert.equal(inner.expressions.length, 3);
  const windowAlias = inner.expressions.at(-1);
  assert.ok(windowAlias instanceof exp.Alias);
  assert.ok(windowAlias.this instanceof exp.Window);
  assert.ok(windowAlias.this.this instanceof exp.RowNumber);
  assert.equal(windowAlias.alias, "_row_number");
  // No ORDER BY on the original query -> falls back to the DISTINCT ON columns.
  assert.equal(windowAlias.this.args.order.expressions.length, 1);

  assert.ok(out.args.where.this instanceof exp.EQ);
  assert.equal(out.args.where.this.this.name, "_row_number");
});

test("eliminate_distinct_on prefers an existing ORDER BY over the DISTINCT ON columns", () => {
  const select = parse("SELECT DISTINCT ON (a) a, b FROM t ORDER BY b DESC");
  const out = eliminate_distinct_on(select);
  const window = out.args.from_.this.this.expressions.at(-1).this;
  assert.equal(window.args.order.expressions.length, 1);
  assert.equal(window.args.order.expressions[0].this.this.this, "b");
  assert.equal(window.args.order.expressions[0].args.desc, true);
});

test("eliminate_distinct_on is a no-op without a DISTINCT ON tuple", () => {
  const plain = parse("SELECT a, b FROM t");
  assert.equal(eliminate_distinct_on(plain), plain);

  const distinct = parse("SELECT DISTINCT a, b FROM t");
  assert.equal(eliminate_distinct_on(distinct), distinct);
});

test("eliminate_qualify moves an aliased window reference into a subquery filter", () => {
  const select = parse(
    "SELECT a, ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) AS rn FROM t QUALIFY rn = 1",
  );
  const out = eliminate_qualify(select);

  assert.ok(out instanceof exp.Select);
  assert.equal(out.expressions.length, 2);
  assert.ok(out.args.from_.this instanceof exp.Subquery);
  assert.ok(out.args.where.this instanceof exp.EQ);
  assert.equal(out.args.where.this.this.name, "rn");

  const inner = out.args.from_.this.this;
  assert.equal(inner.args.qualify, undefined);
});

test("eliminate_qualify lifts an anonymous window predicate into the projection list", () => {
  const select = parse(
    "SELECT a, b FROM t QUALIFY ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) = 1",
  );
  const out = eliminate_qualify(select);
  const inner = out.args.from_.this.this;

  assert.equal(inner.expressions.length, 3);
  const lifted = inner.expressions.at(-1);
  assert.ok(lifted instanceof exp.Alias);
  assert.ok(lifted.this instanceof exp.Window);
  assert.equal(out.args.where.this.this.name, lifted.alias);
});

test("eliminate_qualify pulls in a filter column that was not selected", () => {
  const select = parse("SELECT a FROM t QUALIFY b > 1");
  const out = eliminate_qualify(select);
  const inner = out.args.from_.this.this;
  assert.equal(inner.expressions.length, 2);
  assert.equal(inner.expressions[1].name, "b");
});

test("eliminate_qualify is a no-op without a QUALIFY clause", () => {
  const select = parse("SELECT a FROM t WHERE a > 1");
  assert.equal(eliminate_qualify(select), select);
});

test("eliminate_semi_and_anti_joins converts a SEMI join into an EXISTS filter", () => {
  const select = parse("SELECT * FROM a LEFT SEMI JOIN b ON a.id = b.id");
  const out = eliminate_semi_and_anti_joins(select);

  assert.ok(!out.args.joins || out.args.joins.length === 0);
  assert.ok(out.args.where.this instanceof exp.Exists);
  const subquery = out.args.where.this.this;
  assert.ok(subquery instanceof exp.Select);
  assert.equal(subquery.args.from_.this.this.this, "b");
});

test("eliminate_semi_and_anti_joins converts an ANTI join into a NOT EXISTS filter", () => {
  const select = parse("SELECT * FROM a LEFT ANTI JOIN b ON a.id = b.id");
  const out = eliminate_semi_and_anti_joins(select);

  assert.ok(!out.args.joins || out.args.joins.length === 0);
  assert.ok(out.args.where.this instanceof exp.Not);
  assert.ok(out.args.where.this.this instanceof exp.Exists);
});

test("eliminate_semi_and_anti_joins is a no-op for a regular JOIN", () => {
  const select = parse("SELECT * FROM a JOIN b ON a.id = b.id");
  const out = eliminate_semi_and_anti_joins(select);
  assert.equal(out, select);
  assert.equal(out.args.joins.length, 1);
});

test("preprocess chains transforms and dispatches through TRANSFORMS on type change", () => {
  let calls = 0;
  const bumpAlias = (e) => {
    calls += 1;
    return e;
  };
  const fakeSelf = {
    unsupported() {},
    select_sql(e) {
      return `SELECT-STUB(${e.expressions.length})`;
    },
    constructor: { TRANSFORMS: new Map() },
  };
  const handler = preprocess([bumpAlias, bumpAlias]);
  const select = parse("SELECT a FROM t");
  const result = handler(fakeSelf, select);
  assert.equal(calls, 2);
  assert.equal(result, "SELECT-STUB(1)");
});
