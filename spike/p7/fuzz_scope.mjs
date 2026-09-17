// Differential: `src/optimizer/scope.js`'s `traverseScope`/`buildScope` (AIR-2094) and
// the `Scope` class CORE surface they build (AIR-2093) vs CPython's
// `sqlglot.optimizer.scope`, at the pin.
//
//   PYTHONHASHSEED=0 python3 spike/p7/gen_scope_ref.py > spike/out/scope.json
//   node spike/p7/fuzz_scope.mjs
//
// This file calls the REAL `traverseScope(parseOne(sql))` for every scenario -- no more
// hand-wiring `Scope` trees through the class's own constructor/`branch()`, matching
// `gen_scope_ref.py`'s own move to the real `traverse_scope`/`build_scope`.
//
// Nodes are compared by rendered SQL text (`.sql()`), matching `gen_scope_ref.py`'s own
// choice and `spike/p3/fuzz_walk_in_scope.mjs`'s established precedent for the same
// reason: `.sql()` is independently byte-exact-verified elsewhere in this port.

import { readFileSync } from "node:fs";
import { Dialect } from "../../src/dialects/dialect.js";
import { Scope, traverseScope, buildScope } from "../../src/optimizer/scope.js";

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
  let scopes;
  try {
    scopes = traverseScope(parseOne(want.sql));
  } catch (e) {
    error += 1;
    samples.push(`ERROR    scenario:${name} traverseScope\n       ${e.constructor.name}: ${String(e.message || e).split("\n")[0].slice(0, 200)}`);
    continue;
  }

  if (scopes.length !== want.scope_count) {
    error += 1;
    samples.push(`ERROR    scenario:${name} scope_count\n       got ${scopes.length}, want ${want.scope_count}`);
    continue;
  }

  for (let i = 0; i < scopes.length; i++) {
    const wantScope = want.scopes[i];
    let gotDump;
    try {
      gotDump = dumpScope(scopes[i], Object.keys(wantScope.source_columns || {}));
    } catch (e) {
      error += 1;
      samples.push(`ERROR    ${name}:${i} dump\n       ${e.constructor.name}: ${String(e.message || e).split("\n")[0].slice(0, 200)}`);
      continue;
    }
    report(`${name}:${i}`, gotDump, wantScope);
  }

  if (want.tree === null) continue;

  try {
    const root = buildScope(parseOne(want.sql));
    report(`${name}:tree`, dumpTree(root), want.tree);
  } catch (e) {
    error += 1;
    samples.push(`ERROR    ${name}:tree\n       ${e.constructor.name}: ${String(e.message || e).split("\n")[0].slice(0, 200)}`);
  }
}

console.log();
console.log("  src/optimizer/scope.js traverseScope/buildScope vs CPython sqlglot.optimizer.scope");
console.log(`    EXACT ${exact}    MISMATCH ${mismatch}    ERROR ${error}`);
if (samples.length) {
  console.log();
  for (const s of samples) console.log(`  ${s}`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
