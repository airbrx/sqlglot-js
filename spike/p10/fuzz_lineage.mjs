// Differential: `src/lineage.js` (`lineage`/`Node`/`to_node`, AIR-2121, epic
// AIR-2092, "9.1 lineage.js" -- stretch scope) vs CPython's real
// `sqlglot.lineage.lineage`, at the pin.
//
//   PYTHONHASHSEED=0 python3 spike/p10/gen_lineage_ref.py > spike/out/lineage.json
//   node spike/p10/fuzz_lineage.mjs
//
// See `gen_lineage_ref.py`'s own header for the full scenario breakdown and for why
// comparison is a full Node-DAG structural dump (memoized by node identity, same
// object-as-key idiom this port already uses elsewhere) rather than a few hand-picked
// field checks: it captures every field AND `downstream` order AND node-identity
// SHARING (the caching-correctness tests) in one mechanism, with no bespoke
// per-test assertion needed on either side.
//
// Six result groups, each compared the same structural way except where noted:
//   rows                 -- one per assertion-bearing lineage() call in test_lineage.py
//   all_columns_rows     -- column=None (dict[name, Node]) scenarios
//   prebuilt_scope_rows  -- scope= kwarg path, computed fresh on THIS side too (not
//                           JSON-transportable -- a real Scope object)
//   raise_rows           -- test_lineage_normalize's two assertRaises cases
//   copy_flag_rows        -- bespoke: real parsed AST objects, copy=True/False mutation
//   on_node_rows          -- bespoke: on_node callback side-channel metrics

import { readFileSync } from "node:fs";
import { lineage, Node } from "../../index.js";
import { parseOne } from "../../src/dialects/dialect.js";
import { qualify } from "../../src/optimizer/qualify.js";
import { buildScope } from "../../src/optimizer/scope.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = JSON.parse(readFileSync("spike/out/lineage.json", "utf8"));

let exact = 0;
let mismatch = 0;
let error = 0;
let gap = 0;
const samples = [];
const gapSamples = [];

// `to_node`'s `for c in source_columns:` loop (py:395) iterates a Python `set`, whose
// element order for `exp.Column` nodes depends on CPython's CONTENT-based
// `Expression.__hash__` (expressions/core.py:842 -- a structural hash of the whole
// subtree, not identity/memory-address-based) landing in particular hash-table
// buckets. Confirmed empirically against the pin at PYTHONHASHSEED 0/1/2 (stable
// per-seed but not alphabetical, not insertion-order, and not reproducible from a JS
// `Set`, which IS insertion-ordered): these are the only 3 rows (of 73 structural +
// 3 all-columns + 2 prebuilt-scope) where the real `.sql()`/name/count of every node
// matches exactly but a `downstream` list built from that set iterates in a different
// relative order than this port's own (also internally consistent, just differently
// ordered) `Set`. Upstream's OWN test suite already treats this order as
// non-contractual: `test_subquery`/line 395 and
// `test_lineage_cte_self_join_distinct_aliases`/line 1105 both explicitly `sorted(...)`
// the affected nodes before asserting, rather than asserting raw list equality -- the
// same awareness `test_lineage_all_columns_set_operation`/line 1183 shows for its own
// (here unaffected) leaf-sql comparison. Named by scenario, not by generic order-
// insensitivity for ALL rows: every other row's `downstream` order IS a reproduced,
// meaningful contract (pivot-chain order, UNION branch order, subquery order) and
// stays a hard MISMATCH if wrong.
const KNOWN_ORDER_NONDETERMINISM = new Set([
  "test_subquery_4",
  "test_lineage_shared_cte_performance",
  "test_lineage_all_columns_shares_nodes_across_outputs",
]);

// Pre-existing, unrelated base-Generator/base-Parser gaps this test suite's real
// PIVOT/UNPIVOT/LATERAL FLATTEN/TABLE() coverage happens to reach but `lineage.js`
// itself cannot fix (same "named, counted exclusion by stub/type name" shape every
// prior end-to-end oracle in this port already established, e.g.
// `fuzz_qualify.mjs`'s own `KNOWN_GAPS`): `pivot_sql`/`kwarg_sql`/`tablefromrows_sql`
// are `NotPorted` stubs in `src/generator.js` (base `Generator` rendering methods for
// PIVOT/UNPIVOT, the `=>` keyword-argument syntax `LATERAL FLATTEN(INPUT => ...)`
// uses, and Snowflake's `TABLE(FLATTEN(...))` row-set syntax, respectively); the
// `JSONPathRoot` case is an unsupported-expression-type gap in the same rendering
// layer, hit by `FLATTENED.VALUE:field::text`'s JSON-path colon syntax.
const KNOWN_GAPS = [
  /^NotPorted: (pivot_sql|kwarg_sql|tablefromrows_sql) is not ported yet/,
  /^PyValueError: Unsupported expression type (JSONPathRoot)$/,
];

function isKnownGap(got) {
  if (!("error" in got)) return false;
  const line = `${got.error}: ${got.message}`;
  return KNOWN_GAPS.some((re) => re.test(line));
}

const KWARG_KEY_MAP = {
  schema: "schema",
  sources: "sources",
  dialect: "dialect",
  trim_selects: "trimSelects",
};

function toOptions(kwargs) {
  const options = {};
  for (const [key, value] of Object.entries(kwargs || {})) {
    const camel = KWARG_KEY_MAP[key];
    if (!camel) throw new Error(`fuzz_lineage.mjs: unmapped kwarg key ${key}`);
    options[camel] = value;
  }
  return options;
}

// Mirrors `gen_lineage_ref.py`'s own `dump_result` exactly: memoize by node identity
// (the Node object itself, this port's established `id()`-replacement idiom), flatten
// via `walk()`-equivalent recursion so `downstream` order and identity-sharing both
// survive into the comparison.
function dumpResult(result) {
  const nodeIds = new Map();
  const nodes = [];

  function visit(node) {
    if (nodeIds.has(node)) return nodeIds.get(node);
    const nid = nodes.length;
    nodeIds.set(node, nid);
    nodes.push(null);
    const downstream = node.downstream.map(visit);
    nodes[nid] = {
      name: node.name,
      expression_sql: node.expression.sql(),
      source_sql: node.source.sql(),
      source_name: node.sourceName,
      reference_node_name: node.referenceNodeName,
      downstream,
    };
    return nid;
  }

  let columns;
  if (result instanceof Node) {
    columns = { __root__: visit(result) };
  } else {
    columns = {};
    for (const [k, v] of Object.entries(result)) columns[k] = visit(v);
  }
  return { columns, nodes };
}

function runLineage(column, sql, options) {
  try {
    const result = lineage(column, sql, options);
    return { ok: dumpResult(result) };
  } catch (e) {
    return { error: e.constructor.name, message: e.message };
  }
}

function compareDump(expected, got) {
  const expectedCols = Object.keys(expected.columns);
  const gotCols = Object.keys(got.columns);
  if (expectedCols.length !== gotCols.length) {
    return { ok: false, reason: `column count: expected ${expectedCols.length} got ${gotCols.length}` };
  }
  for (const k of expectedCols) {
    if (!(k in got.columns)) return { ok: false, reason: `missing column ${k}` };
  }
  if (expected.nodes.length !== got.nodes.length) {
    return { ok: false, reason: `node count: expected ${expected.nodes.length} got ${got.nodes.length}` };
  }
  for (let i = 0; i < expected.nodes.length; i++) {
    const e = expected.nodes[i];
    const g = got.nodes[i];
    for (const field of ["name", "expression_sql", "source_sql", "source_name", "reference_node_name"]) {
      if (e[field] !== g[field]) {
        return { ok: false, reason: `node[${i}].${field}: expected ${JSON.stringify(e[field])} got ${JSON.stringify(g[field])}` };
      }
    }
    if (JSON.stringify(e.downstream) !== JSON.stringify(g.downstream)) {
      return { ok: false, reason: `node[${i}].downstream: expected ${JSON.stringify(e.downstream)} got ${JSON.stringify(g.downstream)}` };
    }
  }
  for (const k of expectedCols) {
    if (expected.columns[k] !== got.columns[k]) {
      return { ok: false, reason: `columns.${k} root id: expected ${expected.columns[k]} got ${got.columns[k]}` };
    }
  }
  return { ok: true };
}

// Weaker check used ONLY for `KNOWN_ORDER_NONDETERMINISM` scenarios (see that
// constant's own comment): same node COUNT and same multiset of node CONTENT
// (name/expression_sql/source_sql/source_name/reference_node_name), ignoring both
// `downstream` order and id alignment, since those are exactly what a `set`-ordering
// difference scrambles without changing what's actually in the graph.
function compareDumpUnordered(expected, got) {
  if (expected.nodes.length !== got.nodes.length) {
    return { ok: false, reason: `node count: expected ${expected.nodes.length} got ${got.nodes.length}` };
  }
  const keyOf = (n) => JSON.stringify([n.name, n.expression_sql, n.source_sql, n.source_name, n.reference_node_name]);
  const expectedKeys = expected.nodes.map(keyOf).sort();
  const gotKeys = got.nodes.map(keyOf).sort();
  for (let i = 0; i < expectedKeys.length; i++) {
    if (expectedKeys[i] !== gotKeys[i]) {
      return { ok: false, reason: `node content (sorted) differs at ${i}: expected ${expectedKeys[i]} got ${gotKeys[i]}` };
    }
  }
  return { ok: true };
}

function compareStructural(name, sql, expected, got) {
  if ("ok" in expected) {
    if (!("ok" in got)) {
      if (isKnownGap(got)) {
        gap++;
        gapSamples.push(`GAP      ${name}: ${got.error}: ${got.message}\n  sql: ${sql}`);
      } else {
        error++;
        samples.push(`ERROR    ${name}: expected ok, got ${got.error}: ${got.message}\n  sql: ${sql}`);
      }
      return;
    }
    const diff = compareDump(expected.ok, got.ok);
    if (diff.ok) {
      exact++;
    } else if (KNOWN_ORDER_NONDETERMINISM.has(name) && compareDumpUnordered(expected.ok, got.ok).ok) {
      gap++;
      gapSamples.push(`GAP      ${name}: set-iteration-order non-determinism (content matches unordered): ${diff.reason}\n  sql: ${sql}`);
    } else {
      mismatch++;
      samples.push(`MISMATCH ${name}: ${diff.reason}\n  sql: ${sql}`);
    }
  } else if ("ok" in got) {
    mismatch++;
    samples.push(`MISMATCH ${name}: expected error ${expected.error}: ${expected.message}, got ok\n  sql: ${sql}`);
  } else if (got.error === expected.error && got.message === expected.message) {
    exact++;
  } else {
    mismatch++;
    samples.push(
      `MISMATCH ${name}: error expected ${expected.error}: ${expected.message}\n  got:      ${got.error}: ${got.message}\n  sql: ${sql}`,
    );
  }
}

// --- rows / all_columns_rows / raise_rows: fully data-driven from the JSON, same
// comparison path for all three. ---
for (const record of ref.rows) {
  const got = runLineage(record.column, record.sql, toOptions(record.kwargs));
  compareStructural(record.name, record.sql, record.result, got);
}

for (const record of ref.all_columns_rows) {
  const got = runLineage(null, record.sql, toOptions(record.kwargs));
  compareStructural(record.name, record.sql, record.result, got);
}

for (const record of ref.raise_rows) {
  const got = runLineage(record.column, record.sql, toOptions(record.kwargs));
  compareStructural(record.name, record.sql, record.result, got);
}

// --- prebuilt_scope_rows: the `scope=` kwarg path needs a real Scope object, built
// fresh on this side too (matching gen_lineage_ref.py's own _qualified/_prebuilt_scope
// computation exactly). ---
const PREBUILT_SCOPE_SQL = "SELECT a, b + 1 AS bp FROM x";
const PREBUILT_SCOPE_SCHEMA = { x: { a: "int", b: "int" } };
const prebuiltQualified = qualify(parseOne(PREBUILT_SCOPE_SQL), {
  schema: PREBUILT_SCOPE_SCHEMA,
  validateQualifyColumns: false,
  identify: false,
});
const prebuiltScope = buildScope(prebuiltQualified);

{
  const noScopeGot = runLineage(null, PREBUILT_SCOPE_SQL, { schema: PREBUILT_SCOPE_SCHEMA });
  const noScopeRecord = ref.prebuilt_scope_rows.find((r) => r.name.endsWith("_noscope"));
  compareStructural(noScopeRecord.name, PREBUILT_SCOPE_SQL, noScopeRecord.result, noScopeGot);

  const withScopeGot = runLineage(null, prebuiltQualified, { scope: prebuiltScope });
  const withScopeRecord = ref.prebuilt_scope_rows.find((r) => r.name.endsWith("_withscope"));
  compareStructural(withScopeRecord.name, PREBUILT_SCOPE_SQL, withScopeRecord.result, withScopeGot);
}

// --- copy_flag_rows: bespoke -- real parsed ASTs passed directly as `sql`/`sources`
// values, checking mutation (or lack thereof) depending on `copy`. ---
function checkCopyFlagRow(name, got, record) {
  const row = record.find((r) => r.name === name);
  if (got === row.expected) {
    exact++;
  } else {
    mismatch++;
    samples.push(`MISMATCH ${name}: expected ${JSON.stringify(row.expected)} got ${JSON.stringify(got)}`);
  }
}

{
  const copySchema = { x: { a: "int" } };

  let query = parseOne("SELECT a FROM z");
  let sources = { y: parseOne("SELECT * FROM x"), z: parseOne("SELECT * FROM y") };
  lineage("a", query, { schema: copySchema, sources, copy: false });
  checkCopyFlagRow("copy_false_sources_y", sources.y.sql(), ref.copy_flag_rows);
  checkCopyFlagRow("copy_false_sources_z", sources.z.sql(), ref.copy_flag_rows);
  checkCopyFlagRow("copy_false_query_mutated", query.sql(), ref.copy_flag_rows);

  query = parseOne("SELECT a FROM z");
  sources = { y: parseOne("SELECT * FROM x"), z: parseOne("SELECT * FROM y") };
  lineage("a", query, { schema: copySchema, sources, copy: true });
  checkCopyFlagRow("copy_true_sources_y", sources.y.sql(), ref.copy_flag_rows);
  checkCopyFlagRow("copy_true_sources_z", sources.z.sql(), ref.copy_flag_rows);
  checkCopyFlagRow("copy_true_query_unmutated", query.sql(), ref.copy_flag_rows);

  query = parseOne("SELECT a FROM x");
  lineage("a", query, { schema: copySchema, copy: false });
  checkCopyFlagRow("copy_false_no_sources_query_mutated", query.sql(), ref.copy_flag_rows);

  query = parseOne("SELECT a FROM x");
  lineage("a", query, { schema: copySchema, copy: true });
  checkCopyFlagRow("copy_true_no_sources_query_unmutated", query.sql(), ref.copy_flag_rows);
}

// --- on_node_rows: bespoke -- mirrors gen_lineage_ref.py's own run_on_node_scenario
// metric set exactly. ---
function runOnNodeScenario(column, sql, options) {
  const visitedOrder = [];
  const visitedNames = [];
  const callCounts = new Map();

  const hook = (node) => {
    visitedOrder.push(node);
    visitedNames.push(node.name);
    callCounts.set(node, (callCounts.get(node) || 0) + 1);
    node.payload.seen = true;
  };

  const result = lineage(column, sql, { ...options, onNode: hook });

  const roots = result instanceof Node ? [result] : Object.values(result);
  const allNodes = [];
  const seen = new Set();
  for (const root of roots) {
    for (const node of root.walk()) {
      if (!seen.has(node)) {
        seen.add(node);
        allNodes.push(node);
      }
    }
  }

  const position = new Map(visitedOrder.map((n, i) => [n, i]));
  let orderViolations = 0;
  for (const node of allNodes) {
    for (const child of node.downstream) {
      const childPos = position.has(child) ? position.get(child) : -1;
      const nodePos = position.has(node) ? position.get(node) : -1;
      if (childPos >= nodePos) orderViolations++;
    }
  }

  return {
    hook_call_count: visitedOrder.length,
    unique_node_count: allNodes.length,
    fires_once_per_node: visitedOrder.length === new Set(visitedOrder).size,
    all_payloads_seen: allNodes.every((n) => n.payload.seen === true),
    order_violations: orderViolations,
    visited_names: visitedNames,
  };
}

const ON_NODE_SCENARIOS = [
  ["test_lineage_on_node_hook", null, "WITH t AS (SELECT a + 1 AS v FROM x) SELECT v FROM t", { schema: { x: { a: "int" } } }],
  ["test_lineage_on_node_orders_children_before_parents", null, "WITH t AS (SELECT a + 1 AS v FROM x) SELECT v FROM t", { schema: { x: { a: "int" } } }],
  ["test_lineage_on_node_fires_once_per_node", null, "WITH t AS (SELECT a, b FROM x) SELECT a, a + b AS ab FROM t", { schema: { x: { a: "int", b: "int" } } }],
];

for (const [name, column, sql, options] of ON_NODE_SCENARIOS) {
  const got = runOnNodeScenario(column, sql, options);
  const expected = ref.on_node_rows.find((r) => r.name === name).result;
  const gotJson = JSON.stringify(got);
  const expectedJson = JSON.stringify(expected);
  if (gotJson === expectedJson) {
    exact++;
  } else {
    mismatch++;
    samples.push(`MISMATCH ${name}\n  expected: ${expectedJson}\n  got:      ${gotJson}`);
  }
}

console.log();
console.log("  src/lineage.js vs CPython sqlglot.lineage (end-to-end)");
console.log(`    skipped (unsupported dialect): ${ref.skipped_unsupported_dialect.join("; ")}`);
console.log(`    EXACT ${exact}    MISMATCH ${mismatch}    ERROR ${error}    KNOWN_GAP ${gap}`);
if (samples.length) {
  console.log();
  for (const s of samples) console.log(VERBOSE ? `  ${s}\n` : `  ${s.split("\n")[0]}`);
}
if (gapSamples.length && VERBOSE) {
  console.log();
  for (const s of gapSamples) console.log(`  ${s}\n`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
