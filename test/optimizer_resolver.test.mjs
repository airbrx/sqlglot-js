// Structural / error-handling / hand-built-AST tests for `src/optimizer/resolver.js`'s
// `Resolver` class (AIR-2105), runnable with no Python present.
//
// The deep differential signal (this file's behavior vs CPython's
// `sqlglot.optimizer.resolver.Resolver`, over 21 scenarios / 35 checks driven through
// the REAL `traverseScope` + `MappingSchema` on both sides) lives in
// `spike/p7/fuzz_resolver.mjs` — see that file and `gen_resolver_ref.py`'s own header
// for why and for what each scenario targets. These tests cover what a SQL-string
// scenario can't reach cleanly: constructor defaults, cache identity, a hand-built
// pivoted-CTE reference (this port's parser has no `PIVOT` support yet, so that branch
// cannot be reached through a real parse at all — see `gen_resolver_ref.py`'s own
// note), and the `getSourceColumnsFromSetOp` `side`/`kind` branches (same gap: BigQuery's
// `{INNER|LEFT|FULL} UNION ALL BY NAME` syntax isn't parseable by this port yet either).

import test from "node:test";
import assert from "node:assert/strict";
import * as exp from "../src/expressions/index.js";
import "../src/parser.js";
import "../src/generator.js";
import { Dialect, parseOne } from "../src/dialects/dialect.js";
import { OptimizeError } from "../src/errors.js";
import { Scope, traverseScope } from "../src/optimizer/scope.js";
import { Resolver } from "../src/optimizer/resolver.js";
import { MappingSchema, Schema } from "../src/schema.js";

function rootScope(sql) {
  const scopes = traverseScope(parseOne(sql));
  return scopes[scopes.length - 1];
}

test("constructor: lazy caches start empty/null, dialect falls back to a bare Dialect() when schema.dialect is null", () => {
  const scope = rootScope("SELECT a FROM t1");
  const schema = new Schema();
  assert.equal(schema.dialect, null);

  const resolver = new Resolver(scope, schema);
  assert.ok(resolver.dialect instanceof Dialect);
  assert.equal(resolver._sourceColumns, null);
  assert.equal(resolver._unambiguousColumns, null);
  assert.equal(resolver._allColumns, null);
  assert.equal(resolver._inferSchema, true);
  assert.equal(resolver._getSourceColumnsCache.size, 0);
  assert.equal(resolver._columnTypeFromScopeCache.size, 0);
});

test("constructor: infer_schema is threaded through, not defaulted a second time", () => {
  const scope = rootScope("SELECT a FROM t1");
  const resolver = new Resolver(scope, new MappingSchema({}), false);
  assert.equal(resolver._inferSchema, false);
});

test("getSourceColumns: caches by (name, onlyVisible) — schema.columnNames is called only once per key", () => {
  const scope = rootScope("SELECT id FROM t1");
  const schema = new MappingSchema({ t1: { id: "INT", secret: "TEXT" } }, { t1: ["id"] });
  let calls = 0;
  const origColumnNames = schema.columnNames.bind(schema);
  schema.columnNames = (...args) => {
    calls++;
    return origColumnNames(...args);
  };
  const resolver = new Resolver(scope, schema);

  const first = resolver.getSourceColumns("t1", false);
  const second = resolver.getSourceColumns("t1", false);
  assert.deepEqual(first, ["id", "secret"]);
  assert.equal(second, first, "same cache entry must be returned by reference, not recomputed");
  assert.equal(calls, 1);

  // A different onlyVisible is a DIFFERENT cache key.
  const visibleOnly = resolver.getSourceColumns("t1", true);
  assert.deepEqual(visibleOnly, ["id"]);
  assert.equal(calls, 2);
});

test("getSourceColumns: unknown table raises OptimizeError with the exact upstream message", () => {
  const scope = rootScope("SELECT id FROM t1");
  const resolver = new Resolver(scope, new MappingSchema({ t1: { id: "INT" } }));
  assert.throws(
    () => resolver.getSourceColumns("nope"),
    (e) => e instanceof OptimizeError && e.message === "Unknown table: nope",
  );
});

test("allColumns: memoizes after first read (identity, not just equal value)", () => {
  const scope = rootScope("SELECT * FROM t1");
  const resolver = new Resolver(scope, new MappingSchema({ t1: { id: "INT", name: "TEXT" } }));
  const first = resolver.allColumns;
  const second = resolver.allColumns;
  assert.ok(first instanceof Set);
  assert.deepEqual([...first].sort(), ["id", "name"]);
  assert.equal(second, first);
});

test("getTable: accepts a plain string column name, not just an exp.Column", () => {
  const scope = rootScope("SELECT id FROM t1");
  const resolver = new Resolver(scope, new MappingSchema({ t1: { id: "INT" } }));
  const ident = resolver.getTable("id");
  assert.ok(ident instanceof exp.Identifier);
  assert.equal(ident.name, "t1");
});

test("_getUnambiguousColumns: empty input returns an empty Map", () => {
  const scope = rootScope("SELECT a FROM t1");
  const resolver = new Resolver(scope, new MappingSchema({}));
  const result = resolver._getUnambiguousColumns(new Map());
  assert.equal(result.size, 0);
});

test("_getUnambiguousColumns: single source is a SingleValuedMapping (perf shortcut), not a copy", () => {
  const scope = rootScope("SELECT a FROM t1");
  const resolver = new Resolver(scope, new MappingSchema({}));
  const cols = ["a", "b"];
  const result = resolver._getUnambiguousColumns(new Map([["t1", cols]]));
  assert.equal(result.get("a"), "t1");
  assert.equal(result.get("b"), "t1");
  assert.equal(result.get("c"), undefined);
});

test("_getUnambiguousColumns: ambiguous column across 2+ sources is dropped, unique columns keep their source", () => {
  const scope = rootScope("SELECT a FROM t1");
  const resolver = new Resolver(scope, new MappingSchema({}));
  const sourceColumns = new Map([
    ["t1", ["a", "shared"]],
    ["t2", ["b", "shared"]],
  ]);
  const result = resolver._getUnambiguousColumns(sourceColumns);
  assert.equal(result.get("a"), "t1");
  assert.equal(result.get("b"), "t2");
  assert.equal(result.get("shared"), undefined);
});

test("_getUnambiguousColumns: UNNEST_COLUMN_ONLY resolves shadowing via the UNNEST alias's own source, not by dropping it", () => {
  // py: resolver.py:325-338. Hand-built because this needs a dialect with
  // UNNEST_COLUMN_ONLY=true (only BigQuery sets it) plus a real Unnest source wired
  // into scope.sources — cheaper to construct directly than through a full BigQuery
  // parse.
  const scope = rootScope("SELECT a FROM t1");
  const unnestAlias = new exp.TableAlias({
    this: new exp.Identifier({ this: "u" }),
    columns: [new exp.Identifier({ this: "shared" })],
  });
  const unnestExpr = new exp.Unnest({ expressions: [], alias: unnestAlias });
  scope.sources.set("u", { expression: unnestExpr });

  const resolver = new Resolver(scope, new MappingSchema({}));
  resolver.dialect = { UNNEST_COLUMN_ONLY: true };

  const sourceColumns = new Map([
    ["t1", ["a", "shared"]],
    ["u", ["shared"]],
  ]);
  const result = resolver._getUnambiguousColumns(sourceColumns);
  assert.equal(result.get("a"), "t1");
  // Without UNNEST_COLUMN_ONLY this would be dropped as ambiguous (previous test);
  // with it, "shared" resolves to the UNNEST's own source instead.
  assert.equal(result.get("shared"), "u");
});

test("getSourceColumns: a pivoted CTE reference resolves to the CTE's PRE-pivot columns (hand-built — no PIVOT parser yet)", () => {
  // py: resolver.py:141-150. `parser.js`'s `_parse_pivot` is unported (NotPorted,
  // `parser.py:5404`), so `PIVOT (...)` cannot reach this test through a real parse.
  // The expected shape (['amount', 'category']) was independently verified against
  // the pinned CPython interpreter while writing `gen_resolver_ref.py` (see that
  // file's header for the transcript), it just can't be wired into the automated
  // pipeline until PIVOT parsing lands.
  const scopes = traverseScope(parseOne("WITH cte AS (SELECT amount, category FROM t1) SELECT * FROM cte"));
  const outer = scopes[scopes.length - 1];
  assert.deepEqual([...outer.sources.keys()], ["cte"]);

  // Simulate what `_traverse_tables` would wire for `... FROM cte PIVOT (...) AS p`:
  // an exp.Table referencing the CTE by name, carrying a non-empty `pivots` arg, and
  // stored under the PIVOT's own alias rather than the table's.
  const pivot = new exp.Pivot({ alias: new exp.TableAlias({ this: new exp.Identifier({ this: "p" }) }) });
  const pivotedTable = new exp.Table({ this: new exp.Identifier({ this: "cte" }), pivots: [pivot] });
  outer.sources.set("p", pivotedTable);

  const resolver = new Resolver(outer, new MappingSchema({ t1: { amount: "INT", category: "TEXT" } }));
  assert.deepEqual(resolver.getSourceColumns("p"), ["amount", "category"]);
});

test("getSourceColumnsFromSetOp: side=LEFT keeps only the left operand's columns", () => {
  const left = parseOne("SELECT a, b FROM t1");
  const right = parseOne("SELECT b, c FROM t2");
  const union = new exp.Union({ this: left, expression: right, side: "LEFT" });
  const resolver = new Resolver(new Scope(left), new MappingSchema({}));
  assert.deepEqual(resolver.getSourceColumnsFromSetOp(union), ["a", "b"]);
});

test("getSourceColumnsFromSetOp: side=FULL is a dedup'd union preserving first-seen order", () => {
  const left = parseOne("SELECT a, b FROM t1");
  const right = parseOne("SELECT b, c FROM t2");
  const union = new exp.Union({ this: left, expression: right, side: "FULL" });
  const resolver = new Resolver(new Scope(left), new MappingSchema({}));
  assert.deepEqual(resolver.getSourceColumnsFromSetOp(union), ["a", "b", "c"]);
});

test("getSourceColumnsFromSetOp: kind=INNER is a set intersection (element membership asserted, not upstream's hash-bucket order — see resolver.js's own inline note)", () => {
  const left = parseOne("SELECT a, b, x FROM t1");
  const right = parseOne("SELECT b, x, c FROM t2");
  const union = new exp.Union({ this: left, expression: right, kind: "INNER" });
  const resolver = new Resolver(new Scope(left), new MappingSchema({}));
  const result = resolver.getSourceColumnsFromSetOp(union);
  assert.deepEqual(new Set(result), new Set(["b", "x"]));
});

test("getSourceColumnsFromSetOp: no side/kind/on falls back to the SetOperation's own named_selects", () => {
  const left = parseOne("SELECT a, b FROM t1");
  const right = parseOne("SELECT c, d FROM t2");
  const union = new exp.Union({ this: left, expression: right });
  const resolver = new Resolver(new Scope(left), new MappingSchema({}));
  assert.deepEqual(resolver.getSourceColumnsFromSetOp(union), union.namedSelects);
});

test("getSourceColumnsFromSetOp: unwraps a Subquery via .unnest() before dispatching", () => {
  const left = parseOne("SELECT a FROM t1");
  const right = parseOne("SELECT a FROM t2");
  const union = new exp.Union({ this: left, expression: right });
  const subquery = new exp.Subquery({ this: union });
  const resolver = new Resolver(new Scope(left), new MappingSchema({}));
  assert.deepEqual(resolver.getSourceColumnsFromSetOp(subquery), union.namedSelects);
});

test("getSourceColumnsFromSetOp: neither Select, Subquery, nor SetOperation raises OptimizeError with an explicit .sql() rendering", () => {
  const bareTable = parseOne("SELECT a FROM t1").args.from_.this;
  const resolver = new Resolver(new Scope(bareTable), new MappingSchema({}));
  assert.throws(
    () => resolver.getSourceColumnsFromSetOp(bareTable),
    (e) => e instanceof OptimizeError && e.message === `Unknown set operation: ${bareTable.sql()}`,
  );
});
