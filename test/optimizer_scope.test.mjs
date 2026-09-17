// Structural / error-handling tests for `src/optimizer/scope.js`'s `Scope` class CORE
// surface (AIR-2093) and the module-level tree builders `traverseScope`/`buildScope`
// (AIR-2094), runnable with no Python present. The differential signal (this file's
// behavior vs CPython's `sqlglot.optimizer.scope`, byte-exact over a scenario corpus
// driven through the REAL builder on both sides) lives in `spike/p7/fuzz_scope.mjs`.

import test from "node:test";
import assert from "node:assert/strict";
import * as exp from "../src/expressions/index.js";
import "../src/parser.js";
import { Dialect } from "../src/dialects/dialect.js";
import { OptimizeError } from "../src/errors.js";
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

// AIR-2095: `prune` is real, load-bearing surface for two future Track 2 callers
// (`qualify_columns.py`'s `prune=lambda node: node.is_star`, `simplify.py`'s
// `prune=lambda node: isinstance(node, exp.If)`) — see
// `spike/p3/fuzz_walk_in_scope.mjs` for the CPython differential over the full corpus.
// py: `yield node` happens BEFORE the `prune` check, so a pruned node is yielded ITSELF;
// only its own descendants are skipped.
test("walkInScope: prune yields the pruned node itself but skips its descendants", () => {
  const tree = parseOne("SELECT a FROM x WHERE b IN (1, 2)");
  const inExpr = findInScope(tree, exp.In);
  const pruned = [...walkInScope(tree, (node) => node === inExpr)];
  assert.ok(pruned.includes(inExpr));
  // The IN's own literal args (1, 2) are descendants of the pruned node and must not
  // appear.
  const literals = [...findAllInScope(inExpr, exp.Literal)];
  for (const lit of literals) assert.equal(pruned.includes(lit), false);
});

test("walkInScope: prune=null (the default) descends everywhere, same as calling with no prune at all", () => {
  const tree = parseOne("SELECT a FROM x WHERE b IN (1, 2)");
  const withDefault = [...walkInScope(tree)].length;
  const withExplicitNull = [...walkInScope(tree, null)].length;
  assert.equal(withDefault, withExplicitNull);
});

test("Scope.walk threads its prune argument through to walkInScope, same as scope.py:248", () => {
  const expr = parseOne("SELECT a FROM x WHERE b IN (1, 2)");
  const scope = new Scope(expr, null, null, null, ScopeType.ROOT);
  const inExpr = findInScope(expr, exp.In);
  const pruned = [...scope.walk((node) => node === inExpr)];
  assert.ok(pruned.includes(inExpr));
  assert.equal([...findAllInScope(inExpr, exp.Literal)].every((l) => !pruned.includes(l)), true);
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

test("renameSource: a null/undefined oldName defaults to \"\" (py: `old_name = old_name or \"\"`)", () => {
  const expr = parseOne("SELECT a FROM x");
  const scope = new Scope(expr, null, null, null, ScopeType.ROOT);
  scope.sources.set("", "anonymous-source");
  scope.renameSource(null, "named");
  assert.equal(scope.sources.has(""), false);
  assert.equal(scope.sources.get("named"), "anonymous-source");
});

test("renameSource: a no-op when oldName is not present in sources", () => {
  const expr = parseOne("SELECT a FROM x");
  const scope = new Scope(expr, null, null, null, ScopeType.ROOT);
  scope.renameSource("missing", "z");
  assert.equal(scope.sources.has("z"), false);
});

test("removeSource: a no-op (no throw) when name is not present, py: `sources.pop(name, None)`", () => {
  const expr = parseOne("SELECT a FROM x");
  const scope = new Scope(expr, null, null, null, ScopeType.ROOT);
  assert.doesNotThrow(() => scope.removeSource("missing"));
});

test("Scope.replace: replaces the node in the tree and clears the cache, py: scope.py:257", () => {
  const expr = parseOne("SELECT a FROM x");
  const scope = new Scope(expr, null, null, null, ScopeType.ROOT);
  scope.sources.set("x", expr.args.from_.this);
  scope._ensureCollected();
  assert.equal(scope._collected, true);

  const aColumn = findInScope(expr, exp.Column);
  const bColumn = parseOne("SELECT b").expressions[0];
  scope.replace(aColumn, bColumn);

  assert.equal(scope._collected, false);
  assert.equal(expr.sql(), "SELECT b FROM x");
  assert.equal(bColumn.parent, expr);
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

test("traverseScope: non-TRAVERSABLES expression returns []", () => {
  // py: scope.py:673 `if isinstance(expression, TRAVERSABLES): ... return []`
  const column = parseOne("SELECT a FROM x").args.expressions[0];
  assert.deepEqual(traverseScope(column), []);
  // py: `seq_get([], -1)` returns `None` — this port's `seqGet` returns `undefined`.
  assert.equal(buildScope(column), undefined);
});

test("traverseScope: plain SELECT yields exactly one ROOT scope with its table wired in", () => {
  const expr = parseOne("SELECT a, b FROM x WHERE a > 1");
  const scopes = traverseScope(expr);
  assert.equal(scopes.length, 1);
  const [root] = scopes;
  assert.equal(root.isRoot, true);
  assert.equal(root.parent, null);
  assert.deepEqual([...root.sources.keys()], ["x"]);
  // `buildScope` re-runs `traverseScope` from scratch (matching upstream's own
  // `seq_get(traverse_scope(expression), -1)`), so it's a fresh, structurally-equal
  // Scope, not the same object reference as `root` above.
  assert.equal(buildScope(expr).expression.sql(), root.expression.sql());
  assert.equal(buildScope(expr).isRoot, true);
});

test("traverseScope: subquery-in-FROM becomes a DERIVED_TABLE child wired to the root", () => {
  const expr = parseOne("SELECT a FROM (SELECT a, c FROM x WHERE c > 0) AS y");
  const [inner, root] = traverseScope(expr);
  assert.equal(inner.scopeType, ScopeType.DERIVED_TABLE);
  assert.equal(inner.parent, root);
  assert.deepEqual([...inner.sources.keys()], ["x"]);
  assert.equal(root.isRoot, true);
  assert.deepEqual([...root.sources.keys()], ["y"]);
  assert.equal(root.sources.get("y"), inner);
  assert.deepEqual(root.derivedTableScopes, [inner]);
  assert.deepEqual(root.tableScopes, [inner]);
});

test("traverseScope: nested CTEs — a later CTE sees an earlier one as a source", () => {
  const expr = parseOne("WITH a AS (SELECT 1 AS x), b AS (SELECT x FROM a) SELECT x FROM b");
  const [cteA, cteB, root] = traverseScope(expr);
  assert.equal(cteA.scopeType, ScopeType.CTE);
  assert.deepEqual([...cteA.sources.keys()], []);
  assert.equal(cteB.scopeType, ScopeType.CTE);
  assert.deepEqual([...cteB.sources.keys()], ["a"]);
  assert.equal(cteB.sources.get("a"), cteA);
  assert.deepEqual([...root.sources.keys()].sort(), ["a", "b"]);
  assert.equal(root.sources.get("b"), cteB);
  assert.deepEqual(root.cteScopes, [cteA, cteB]);
});

test("traverseScope: a derived table containing its own CTE nests correctly", () => {
  const expr = parseOne("SELECT a FROM (WITH c AS (SELECT a FROM x) SELECT a FROM c) AS y");
  const [cte, derived, root] = traverseScope(expr);
  assert.equal(cte.scopeType, ScopeType.CTE);
  assert.deepEqual([...cte.sources.keys()], ["x"]);
  assert.equal(derived.scopeType, ScopeType.DERIVED_TABLE);
  assert.equal(derived.parent, root);
  assert.deepEqual([...derived.sources.keys()], ["c"]);
  assert.equal(derived.sources.get("c"), cte);
  assert.equal(cte.parent, derived);
  assert.deepEqual([...root.sources.keys()], ["y"]);
});

test("traverseScope: a 3-way UNION chains union_scopes across two ROOT-adjacent UNION nodes", () => {
  const expr = parseOne("SELECT a FROM x UNION SELECT a FROM y UNION SELECT a FROM z");
  const scopes = traverseScope(expr);
  assert.equal(scopes.length, 5);
  const [leftmost, second, firstUnion, third, root] = scopes;

  assert.equal(leftmost.scopeType, ScopeType.UNION);
  assert.deepEqual([...leftmost.sources.keys()], ["x"]);
  assert.equal(second.scopeType, ScopeType.UNION);
  assert.deepEqual([...second.sources.keys()], ["y"]);
  assert.equal(firstUnion.scopeType, ScopeType.UNION);
  assert.deepEqual(firstUnion.unionScopes, [leftmost, second]);

  assert.equal(third.scopeType, ScopeType.UNION);
  assert.deepEqual([...third.sources.keys()], ["z"]);
  assert.equal(root.isRoot, true);
  assert.deepEqual(root.unionScopes, [firstUnion, third]);
});

test("traverseScope: recursive CTE branches the base case into a placeholder self-source", () => {
  // py: scope.py:819-826 — `with_.recursive` and the CTE's own body being a
  // `SetOperation` (base UNION recursive) is the only path that hits that branch.
  const expr = parseOne(
    "WITH RECURSIVE cte AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM cte WHERE n < 5) SELECT n FROM cte",
  );
  const scopes = traverseScope(expr);
  const cteScope = scopes.find((s) => s.isCte);
  assert.ok(cteScope);
  assert.deepEqual([...cteScope.sources.keys()], ["cte"]);
  const root = scopes[scopes.length - 1];
  assert.equal(root.sources.get("cte"), cteScope);
});

test("traverseScope: a WHERE-clause correlated subquery two levels deep is fully correlated", () => {
  const expr = parseOne(
    "SELECT a FROM x WHERE a IN (SELECT b FROM y WHERE b IN (SELECT c FROM z WHERE z.c = x.a))",
  );
  const [innermost, middle, root] = traverseScope(expr);

  assert.equal(innermost.scopeType, ScopeType.SUBQUERY);
  assert.equal(innermost.parent, middle);
  assert.deepEqual([...innermost.sources.keys()], ["z"]);
  // `x.a` isn't a local source of the innermost scope, so it's external; the bare `c` in
  // `SELECT c` is ALSO external — `external_columns` only excludes columns whose table
  // text is a LOCAL source name, and an unqualified column's table text is "", which
  // "z" (the only local source here) doesn't match either. Verified directly against
  // CPython: both land in `external_columns`, not just `x.a`.
  assert.deepEqual(innermost.externalColumns.map((c) => c.sql()).sort(), ["c", "x.a"]);
  // canBeCorrelated propagates through every SUBQUERY branch() call, so this is correlated.
  assert.equal(innermost.isCorrelatedSubquery, true);

  assert.equal(middle.scopeType, ScopeType.SUBQUERY);
  assert.equal(middle.parent, root);
  assert.deepEqual(middle.subqueryScopes, [innermost]);
  assert.deepEqual(root.subqueryScopes, [middle]);
});

test("traverseScope: a LATERAL subquery join is a UDTF scope wired via the FROM-clause's own source map", () => {
  const expr = parseOne("SELECT a, b FROM x CROSS JOIN LATERAL (SELECT y.b FROM y WHERE y.a = x.a) AS t");
  const [inner, udtf, root] = traverseScope(expr);

  assert.equal(inner.scopeType, ScopeType.SUBQUERY);
  assert.equal(inner.parent, udtf);
  assert.deepEqual([...inner.sources.keys()], ["y"]);

  assert.equal(udtf.scopeType, ScopeType.UDTF);
  assert.equal(udtf.parent, root);
  // py: scope.py:926 `lateral_sources = sources` — the enclosing scope's own
  // in-progress FROM-clause source map ("x") is threaded into the UDTF scope.
  assert.deepEqual([...udtf.sources.keys()].sort(), ["", "x"]);

  assert.equal(root.isRoot, true);
  assert.deepEqual([...root.sources.keys()].sort(), ["t", "x"]);
  assert.equal(root.sources.get("t"), udtf);
  assert.deepEqual(root.udtfScopes, [udtf]);
});

test("traverseScope: an UNNEST table function is a UDTF scope, no SUBQUERY children of its own", () => {
  const expr = parseOne("SELECT a, b FROM x CROSS JOIN UNNEST(x.arr) AS t(b)");
  const [udtf, root] = traverseScope(expr);
  assert.equal(udtf.scopeType, ScopeType.UDTF);
  // py: scope.py:926 `lateral_sources = sources` — same FROM-clause source-map
  // threading as the LATERAL-subquery case above, just with nothing further to
  // recurse into since UNNEST's own argument isn't a Subquery.
  assert.deepEqual([...udtf.sources.keys()], ["x"]);
  assert.deepEqual([...root.sources.keys()].sort(), ["t", "x"]);
  assert.equal(root.sources.get("t"), udtf);
});

test("buildScope: returns a scope structurally equal to traverseScope's last element", () => {
  const expr = parseOne("WITH y AS (SELECT a FROM x) SELECT a FROM y");
  const scopes = traverseScope(expr);
  const last = scopes[scopes.length - 1];
  const built = buildScope(expr);
  assert.equal(built.expression.sql(), last.expression.sql());
  assert.equal(built.scopeType, last.scopeType);
  assert.equal(built.isRoot, true);
});

test("toString matches upstream's __repr__ shape", () => {
  const expr = parseOne("SELECT a FROM x");
  const scope = new Scope(expr, null, null, null, ScopeType.ROOT);
  assert.equal(scope.toString(), "Scope<SELECT a FROM x>");
});
