// Structural / error-handling tests for `src/optimizer/scope.js`'s `Scope` class CORE
// surface (AIR-2093), runnable with no Python present. The differential signal (this
// class's behavior vs CPython's `sqlglot.optimizer.scope.Scope`, byte-exact over five
// hand-wired scenarios) lives in `spike/p7/fuzz_scope.mjs` — see that file and
// `src/optimizer/scope.js`'s own header for why `traverse_scope`/`build_scope` are
// deferred (AIR-2094) and not exercised here.

import test from "node:test";
import assert from "node:assert/strict";
import * as exp from "../src/expressions/index.js";
import "../src/parser.js";
import { Dialect } from "../src/dialects/dialect.js";
import { OptimizeError, NotPorted } from "../src/errors.js";
import {
  Scope,
  ScopeType,
  walkInScope,
  findAllInScope,
  findInScope,
  traverseScope,
  buildScope,
} from "../src/optimizer/scope.js";

function parseOne(sql) {
  return Dialect.get_or_raise(null).parse(sql)[0];
}

test("Tier A exports are unaffected by the Scope class addition", () => {
  const tree = parseOne("SELECT a FROM x");
  assert.equal([...walkInScope(tree)].length > 0, true);
  assert.equal([...findAllInScope(tree, exp.Column)].length, 1);
  assert.ok(findInScope(tree, exp.Table) instanceof exp.Table);
});

test("constructor: defaults, ScopeType.ROOT, and the empty-dict clearCache reset", () => {
  const expr = parseOne("SELECT a FROM x");
  const scope = new Scope(expr);
  assert.equal(scope.scopeType, ScopeType.ROOT);
  assert.equal(scope.isRoot, true);
  assert.equal(scope.parent, null);
  assert.equal(scope.canBeCorrelated, null);
  assert.deepEqual([...scope.sources.entries()], []);
  assert.deepEqual(scope.outerColumns, []);
  assert.deepEqual(scope.subqueryScopes, []);
  assert.deepEqual(scope.derivedTableScopes, []);
  assert.deepEqual(scope.tableScopes, []);
  assert.deepEqual(scope.cteScopes, []);
  assert.deepEqual(scope.unionScopes, []);
  assert.deepEqual(scope.udtfScopes, []);
});

test("constructor: a non-empty sources Map is reused by reference, not copied", () => {
  // py: `self.sources = sources or {}` — a non-empty dict is REUSED, not copied; only
  // an empty/absent one is replaced with a new dict.
  const expr = parseOne("SELECT a FROM x");
  const table = expr.args.from_.this;
  const sources = new Map([["x", table]]);
  const scope = new Scope(expr, sources);
  assert.equal(scope.sources, sources);

  const emptySources = new Map();
  const scope2 = new Scope(expr, emptySources);
  assert.notEqual(scope2.sources, emptySources);
});

test("constructor: lateralSources/cteSources are merged into sources, cteSources winning on conflict", () => {
  const expr = parseOne("SELECT a FROM x");
  const lateral = new Map([["y", "lateral-table"]]);
  const cte = new Map([["y", "cte-scope"], ["z", "cte-only"]]);
  const scope = new Scope(expr, null, null, null, ScopeType.ROOT, lateral, cte);
  assert.equal(scope.sources.get("y"), "cte-scope");
  assert.equal(scope.sources.get("z"), "cte-only");
});

test("branch: unnests the expression, sets parent, and propagates canBeCorrelated", () => {
  const expr = parseOne("SELECT a FROM x WHERE a IN (SELECT b FROM y)");
  const root = new Scope(expr, null, null, null, ScopeType.ROOT);
  assert.equal(root.canBeCorrelated, null);

  const subquerySelect = [...findAllInScope(expr, exp.Select)].find((s) => s !== expr);
  const child = root.branch(subquerySelect, ScopeType.SUBQUERY);
  assert.equal(child.parent, root);
  assert.equal(child.scopeType, ScopeType.SUBQUERY);
  // py: `can_be_correlated=self.can_be_correlated or scope_type in (SUBQUERY, UDTF)`
  assert.equal(child.canBeCorrelated, true);

  const derivedChild = root.branch(subquerySelect, ScopeType.DERIVED_TABLE);
  assert.equal(derivedChild.canBeCorrelated, false);
});

test("branch: a Paren-wrapped expression is unnested before becoming Scope.expression", () => {
  const expr = parseOne("SELECT a FROM ((SELECT a FROM x)) AS y");
  const root = new Scope(expr, null, null, null, ScopeType.ROOT);
  const subqueryNode = expr.args.from_.this;
  const child = root.branch(subqueryNode, ScopeType.DERIVED_TABLE);
  assert.equal(child.expression.sql(), "SELECT a FROM x");
});

test("_collect via properties: tables/columns/scansAllSubscopeColumns", () => {
  // py: a bare `*` parses as `exp.Star` directly (not `Column(this=Star())`), so it
  // sets `scans_all_subscope_columns` rather than landing in `_stars` (scope.py:237).
  const expr = parseOne("SELECT a, * FROM x WHERE a > 1");
  const scope = new Scope(expr, null, null, null, ScopeType.ROOT);
  scope.sources.set("x", expr.args.from_.this);

  assert.equal(scope.tables.length, 1);
  assert.equal(scope.tables[0].sql(), "x");
  assert.equal(scope.columns.length, 2); // `a` (select) + `a` (where)
  assert.equal(scope.stars.length, 0);
  assert.equal(scope.scansAllSubscopeColumns, true);
  assert.equal(scope.unqualifiedColumns.length, 2);
});

test("_collect via properties: a qualified star (`x.*`) lands in `stars` AND sets scansAllSubscopeColumns", () => {
  // Verified directly against CPython: the enclosing `Column(this=Star())` classifies
  // as a star via the Column branch, but the walk ALSO visits the nested bare `Star`
  // node independently (it's in `COLLECTIBLE_TYPES` too), which hits the separate
  // `elif isinstance(node, exp.Star)` branch — both effects fire for one `x.*`.
  const expr = parseOne("SELECT x.* FROM x");
  const scope = new Scope(expr, null, null, null, ScopeType.ROOT);
  scope.sources.set("x", expr.args.from_.this);

  assert.equal(scope.stars.length, 1);
  assert.equal(scope.scansAllSubscopeColumns, true);
});

test("_collect does not descend into child scopes (walkInScope's own boundary)", () => {
  const expr = parseOne("SELECT a FROM (SELECT b FROM y) AS z");
  const root = new Scope(expr, null, null, null, ScopeType.ROOT);
  // The inner `b` column belongs to the child scope, not the root's own `_raw_columns`.
  assert.equal(root.columns.length, 1);
  assert.equal(root.columns[0].sql(), "a");
  assert.equal(root.derivedTables.length, 1);
});

test("clearCache / clearColumnCache reset lazily-computed caches", () => {
  const expr = parseOne("SELECT a FROM x");
  const scope = new Scope(expr, null, null, null, ScopeType.ROOT);
  scope.sources.set("x", expr.args.from_.this);

  const firstColumns = scope.columns;
  assert.equal(scope.columns, firstColumns); // cached, same array reference

  scope.clearColumnCache();
  assert.notEqual(scope.columns, firstColumns);

  scope._ensureCollected();
  assert.equal(scope._collected, true);
  scope.clearCache();
  assert.equal(scope._collected, false);
});

test("addSource / removeSource / renameSource mutate sources and clear the cache", () => {
  const expr = parseOne("SELECT a FROM x");
  const scope = new Scope(expr, null, null, null, ScopeType.ROOT);
  const table = expr.args.from_.this;

  scope.addSource("x", table);
  assert.equal(scope.sources.get("x"), table);
  assert.equal(scope._collected, false);

  scope._ensureCollected();
  scope.renameSource("x", "z");
  assert.equal(scope.sources.has("x"), false);
  assert.equal(scope.sources.get("z"), table);
  // py: `rename_source` has no `clear_cache()` call, unlike `add_source`/`remove_source`.
  assert.equal(scope._collected, true);

  scope.removeSource("z");
  assert.equal(scope.sources.has("z"), false);
});

test("selectedSources throws OptimizeError on a duplicate alias", () => {
  // py: scope.py:435 `raise OptimizeError(f"Alias already used: {name}")`
  const expr = parseOne("SELECT a FROM x, x AS y");
  const scope = new Scope(expr, null, null, null, ScopeType.ROOT);
  // Two Table refs alias to "x" (no AS on the first) once collected as references --
  // force the collision directly against `references` rather than depending on parsing.
  const table = expr.args.from_.this;
  scope._references = [["x", table], ["x", table]];
  scope.sources.set("x", table);
  assert.throws(() => scope.selectedSources, OptimizeError);
});

test("traverse: depth-first post-order over cte/union/table/subquery scopes", () => {
  const expr = parseOne("SELECT a FROM (SELECT a FROM x) AS y");
  const root = new Scope(expr, null, null, null, ScopeType.ROOT);
  const subqueryNode = expr.args.from_.this;
  const inner = root.branch(subqueryNode, ScopeType.DERIVED_TABLE);
  inner.sources.set("x", inner.expression.args.from_.this);
  root.tableScopes.push(inner);
  root.derivedTableScopes.push(inner);
  root.sources.set("y", inner);

  const order = [...root.traverse()];
  assert.deepEqual(order, [inner, root]);
});

test("refCount: counts each distinct selected source once per reference", () => {
  const expr = parseOne("SELECT a FROM x");
  const root = new Scope(expr, null, null, null, ScopeType.ROOT);
  const table = expr.args.from_.this;
  root.sources.set("x", table);

  const counts = root.refCount();
  assert.equal(counts.get(table), 1);
});

test("traverseScope / buildScope are explicit NotPorted stubs (AIR-2094)", () => {
  assert.throws(() => traverseScope(parseOne("SELECT 1")), NotPorted);
  assert.throws(() => buildScope(parseOne("SELECT 1")), NotPorted);
});

test("toString matches upstream's __repr__ shape", () => {
  const expr = parseOne("SELECT a FROM x");
  const scope = new Scope(expr, null, null, null, ScopeType.ROOT);
  assert.equal(scope.toString(), "Scope<SELECT a FROM x>");
});
