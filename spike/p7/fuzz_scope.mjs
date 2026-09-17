// Differential: `src/optimizer/scope.js`'s `Scope` class CORE surface (AIR-2093) vs
// CPython's `sqlglot.optimizer.scope.Scope`, at the pin.
//
//   PYTHONHASHSEED=0 python3 spike/p7/gen_scope_ref.py > spike/out/scope.json
//   node spike/p7/fuzz_scope.mjs
//
// See `gen_scope_ref.py`'s own header for why this oracle hand-wires five `Scope` trees
// directly through the class's own `constructor`/`branch()` rather than calling
// `traverse_scope` (deferred to AIR-2094, not ported). This file wires the SAME five
// trees by hand, scenario for scenario, against the JS `Scope` class — verified against
// `_traverse_select`/`_traverse_ctes`/`_traverse_tables`/`_traverse_union`/
// `_traverse_subqueries`'s real bodies in `/tmp/sqlglot-ref` while writing both files, so
// the wiring is faithful to what the real (unported) tree builder would produce for
// these five fixed inputs.
//
// Nodes are compared by rendered SQL text (`.sql()`), matching `gen_scope_ref.py`'s own
// choice and `spike/p3/fuzz_walk_in_scope.mjs`'s established precedent for the same
// reason: `.sql()` is independently byte-exact-verified elsewhere in this port.

import { readFileSync } from "node:fs";
import * as exp from "../../src/expressions/index.js";
import { Dialect } from "../../src/dialects/dialect.js";
import { Scope, ScopeType } from "../../src/optimizer/scope.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = JSON.parse(readFileSync("spike/out/scope.json", "utf8"));

let exact = 0;
let mismatch = 0;
let error = 0;
const samples = [];

function parseOne(sql) {
  return Dialect.get_or_raise(null).parse(sql)[0];
}

function sqls(nodes) {
  return nodes.map((n) => n.sql());
}

/** Mirrors `gen_scope_ref.py`'s `label_of` — a `Scope.sources`/`refCount()` VALUE
 * (a Table `Expr` or a `Scope`) rendered to one comparable string. */
function labelOf(source) {
  return source instanceof Scope ? source.expression.sql() : source.sql();
}

function dumpScope(scope, sourceProbes = []) {
  const columnIndex = [...scope.columnIndex].map((c) => c.sql()).sort();

  const sourceColumns = {};
  for (const name of sourceProbes) sourceColumns[name] = sqls(scope.sourceColumns(name));

  const selectedSources = {};
  for (const [name, [node, source]] of scope.selectedSources) {
    selectedSources[name] = [node.sql(), labelOf(source)];
  }

  return {
    scope_type: scope.scopeType,
    expression_sql: scope.expression.sql(),
    outer_columns: scope.outerColumns,
    can_be_correlated: scope.canBeCorrelated ?? null,
    sources_keys: [...scope.sources.keys()].sort(),
    tables: sqls(scope.tables),
    ctes: sqls(scope.ctes),
    derived_tables: sqls(scope.derivedTables),
    udtfs: sqls(scope.udtfs),
    subqueries: sqls(scope.subqueries),
    scans_all_subscope_columns: scope.scansAllSubscopeColumns,
    stars: sqls(scope.stars),
    column_index: columnIndex,
    columns: sqls(scope.columns),
    table_columns: sqls(scope.tableColumns),
    selected_sources: selectedSources,
    references: scope.references.map(([name, node]) => [name, node.sql()]),
    external_columns: sqls(scope.externalColumns),
    local_columns: sqls(scope.localColumns),
    unqualified_columns: sqls(scope.unqualifiedColumns),
    join_hints: sqls(scope.joinHints),
    pivots: sqls(scope.pivots),
    semi_or_anti_join_tables: [...scope.semiOrAntiJoinTables].sort(),
    source_columns: sourceColumns,
    is_subquery: scope.isSubquery,
    is_derived_table: scope.isDerivedTable,
    is_union: scope.isUnion,
    is_cte: scope.isCte,
    is_root: scope.isRoot,
    is_udtf: scope.isUdtf,
    is_correlated_subquery: scope.isCorrelatedSubquery,
    repr: scope.toString(),
  };
}

function dumpTree(root) {
  const traverseOrder = [...root.traverse()].map((s) => s.expression.sql());
  const labelByRef = new Map();
  for (const s of root.traverse()) {
    for (const [, source] of s.sources) labelByRef.set(source, labelOf(source));
  }
  const refCount = {};
  for (const [source, count] of root.refCount()) {
    refCount[labelByRef.get(source) ?? "<unknown>"] = count;
  }
  return { traverse_order: traverseOrder, ref_count: refCount };
}

// ---- five hand-wired scenarios, mirroring gen_scope_ref.py's build_* functions ------

function buildPlain(sql) {
  const expr = parseOne(sql);
  const root = new Scope(expr, null, null, null, ScopeType.ROOT);
  root.sources.set("x", expr.args.from_.this);
  return { scopes: { root }, root, probes: { root: ["x"] } };
}

function buildSubqueryInFrom(sql) {
  const expr = parseOne(sql);
  const root = new Scope(expr, null, null, null, ScopeType.ROOT);
  const subqueryNode = expr.args.from_.this;
  const inner = root.branch(subqueryNode, ScopeType.DERIVED_TABLE, null, null, null, subqueryNode.aliasColumnNames);
  inner.sources.set("x", inner.expression.args.from_.this);

  root.tableScopes.push(inner);
  root.derivedTableScopes.push(inner);
  root.sources.set("y", inner);

  return { scopes: { root, inner }, root, probes: { root: ["y"], inner: ["x"] } };
}

function buildCte(sql) {
  const expr = parseOne(sql);
  const root = new Scope(expr, null, null, null, ScopeType.ROOT);
  const cteNode = expr.args.with_.expressions[0];
  const cte = root.branch(cteNode.this, ScopeType.CTE, null, null, null, cteNode.aliasColumnNames);
  cte.sources.set("x", cte.expression.args.from_.this);

  const cteName = cteNode.alias;
  root.cteScopes.push(cte);
  root.sources.set(cteName, cte);
  root.cteSources.set(cteName, cte);

  return { scopes: { root, cte }, root, probes: { root: ["y"], cte: ["x"] } };
}

function buildUnion(sql) {
  const expr = parseOne(sql);
  const root = new Scope(expr, null, null, null, ScopeType.ROOT);
  const leftExpr = expr.this;
  const rightExpr = expr.args.expression;

  const left = root.branch(leftExpr, ScopeType.UNION, null, null, null, root.outerColumns);
  const right = root.branch(rightExpr, ScopeType.UNION, null, null, null, root.outerColumns);

  left.sources.set("x", left.expression.args.from_.this);
  right.sources.set("y", right.expression.args.from_.this);

  root.unionScopes = [left, right];

  return { scopes: { root, left, right }, root, probes: { left: ["x"], right: ["y"] } };
}

function buildCorrelatedSubquery(sql) {
  const expr = parseOne(sql);
  const root = new Scope(expr, null, null, null, ScopeType.ROOT);
  root.sources.set("x", expr.args.from_.this);

  let subquerySelect = null;
  for (const node of expr.args.where.walk()) {
    if (node instanceof exp.Select) { subquerySelect = node; break; }
  }
  if (!subquerySelect) throw new Error("fuzz_scope.mjs: no nested Select found under WHERE");

  const subquery = root.branch(subquerySelect, ScopeType.SUBQUERY);
  subquery.sources.set("y", subquery.expression.args.from_.this);
  root.subqueryScopes.push(subquery);

  return { scopes: { root, subquery }, root, probes: { root: ["x"], subquery: ["y", "x"] } };
}

const BUILDERS = {
  plain_select: buildPlain,
  subquery_in_from: buildSubqueryInFrom,
  cte: buildCte,
  union: buildUnion,
  correlated_subquery: buildCorrelatedSubquery,
};

function report(label, got, want) {
  const gotJson = JSON.stringify(got);
  const wantJson = JSON.stringify(want);
  if (gotJson === wantJson) {
    exact += 1;
    if (VERBOSE) console.log(`  EXACT ${label}`);
  } else {
    mismatch += 1;
    samples.push(`MISMATCH ${label}\n       got  ${gotJson.slice(0, 400)}\n       want ${wantJson.slice(0, 400)}`);
  }
}

for (const [name, want] of Object.entries(ref)) {
  const builder = BUILDERS[name];
  if (!builder) {
    error += 1;
    samples.push(`ERROR    scenario:${name}\n       no JS builder for this scenario`);
    continue;
  }

  let built;
  try {
    built = builder(want.sql);
  } catch (e) {
    error += 1;
    samples.push(`ERROR    scenario:${name} construction\n       ${e.constructor.name}: ${String(e.message || e).split("\n")[0].slice(0, 200)}`);
    continue;
  }

  for (const [label, scope] of Object.entries(built.scopes)) {
    const wantScope = want.scopes[label];
    if (!wantScope) {
      error += 1;
      samples.push(`ERROR    ${name}:${label}\n       no CPython scope dumped under this label`);
      continue;
    }
    let gotDump;
    try {
      gotDump = dumpScope(scope, built.probes[label] || []);
    } catch (e) {
      error += 1;
      samples.push(`ERROR    ${name}:${label} dump\n       ${e.constructor.name}: ${String(e.message || e).split("\n")[0].slice(0, 200)}`);
      continue;
    }
    report(`${name}:${label}`, gotDump, wantScope);
  }

  try {
    report(`${name}:tree`, dumpTree(built.root), want.tree);
  } catch (e) {
    error += 1;
    samples.push(`ERROR    ${name}:tree\n       ${e.constructor.name}: ${String(e.message || e).split("\n")[0].slice(0, 200)}`);
  }
}

console.log();
console.log("  src/optimizer/scope.js Scope class vs CPython sqlglot.optimizer.scope.Scope (hand-wired scenarios)");
console.log(`    EXACT ${exact}    MISMATCH ${mismatch}    ERROR ${error}`);
if (samples.length) {
  console.log();
  for (const s of samples) console.log(`  ${s}`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
