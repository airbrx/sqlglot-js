// Differential: `src/optimizer/optimizer.js` (`optimize()` + `RULES`) vs CPython's
// `sqlglot.optimizer.optimizer`, over EVERY `optimizer.optimize(...)`-based assertion
// in `tests/test_optimizer.py` NOT already covered by R78's own `fuzz_optimizer.mjs`
// (which replays `TestOptimizer.test_optimize`'s `optimizer.sql` fixture + its one
// inline assertion). AIR-2119 (epic AIR-2091, "8.2 End-to-end optimize() differential
// oracle") -- the issue's own framing: "the actual 'is Track 2 done' gate, not any
// individual module's own oracle passing in isolation."
//
//   PYTHONHASHSEED=0 python3 spike/p10/gen_optimize_e2e_ref.py > spike/out/optimize_e2e.json
//   node spike/p10/fuzz_optimize_e2e.mjs
//
// 278 rows total: 22 real TPC-H queries + 99 real TPC-DS queries (`test_tpch`/
// `test_tpcds` -- the issue's two named primary targets, full CTE/subquery-merge/
// predicate-pushdown combinatorics no per-module oracle has exercised), 86
// `merge_subqueries.sql` rows + 43 `canonicalize.sql` rows (both via a `rules=`
// override naming RAW rule functions rather than the default `RULES` tuple -- see
// `gen_optimize_e2e_ref.py`'s own header), and ~25 small hand-written ad-hoc
// assertions spanning error-highlighting, type-annotation-through-the-full-pipeline,
// schema shapes (plain dict / pre-quoted keys / `MappingSchema` instance /
// recursive-CTE schemas), an `on_qualify` callback, and dialect-specific JSON
// dot-access normalization.
//
// Each row carries three independent kinds (`row.kind`): "sql" (full `.sql()` text
// equality -- the dominant shape, 272 of 278 rows), "type" (a specific node's
// `.type.this.name`, for the two tests that check annotation THROUGH the full
// pipeline rather than output text, which doesn't depend on it), and "error" (an
// `OptimizeError` message/highlighting check, no output SQL at all).
//
// Same "known pre-existing generator/parser gap, named by regex, counted separately
// as GENERATOR_GAP rather than silently folded into EXACT or silently miscounted as
// MISMATCH" shape `fuzz_optimizer.mjs` (R78) established, extended here with a
// `blockedBy` tag per matched regex so the ranked blocker table in this round's
// PORT_PLAN.md entry is generated from the SAME counters this script prints, not
// hand-tallied separately.

import { readFileSync } from "node:fs";
// Side-effect import: registers every real dialect this fixture's `# dialect:` rows
// (and the hand-written ad-hoc rows) ask for by name -- bigquery/snowflake/postgres/
// tsql/databricks/duckdb/spark. `clickhouse` is asked for by one ad-hoc row
// (`test_case_sensitive_json_dot_access`) but `src/dialects/clickhouse.js` does not
// exist in this port at all -- a real, pre-existing, named gap (`KNOWN_PARSE_BLOCKERS`
// below), not an oversight in this import list. Same role `fuzz_optimizer.mjs`'s own
// top-level import serves.
import { parseOne, exp, MappingSchema } from "../../index.js";
import { optimize } from "../../src/optimizer/optimizer.js";
import { qualify } from "../../src/optimizer/qualify.js";
import { qualify_tables } from "../../src/optimizer/qualify_tables.js";
import { qualify_columns, quote_identifiers } from "../../src/optimizer/qualify_columns.js";
import { merge_subqueries } from "../../src/optimizer/merge_subqueries.js";
import { annotate_types } from "../../src/optimizer/annotate_types.js";
import { canonicalize } from "../../src/optimizer/canonicalize.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = JSON.parse(readFileSync("spike/out/optimize_e2e.json", "utf8"));

// A sort key that never calls `.sql()` -- mirrors `gen_optimize_e2e_ref.py`'s own
// `_structural_key` (a leaf being canonicalized below can itself contain an unported
// generator construct, and `.sql()` would raise for it exactly like it does for the
// row's own top-level gap).
function structuralKey(node) {
  return JSON.stringify([...node.dfs()].map((n) => {
    const scalars = {};
    for (const [k, v] of Object.entries(n.args)) {
      if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        scalars[k] = v === undefined ? null : v;
      }
    }
    const sorted = {};
    for (const k of Object.keys(scalars).sort()) sorted[k] = scalars[k];
    return [n.constructor.name, sorted];
  }));
}

// Mirrors `gen_optimize_e2e_ref.py`'s own `fingerprint` exactly -- same (class name,
// sorted scalar-only args) shape `fuzz_optimizer.mjs`/`fuzz_canonicalize.mjs`
// established, but walked by a custom recursive visitor rather than plain `.dfs()`:
// `Expr#iterExpressions` yields `this.args`' VALUES in object-key INSERTION order,
// not a fixed `argTypes`-declared order, so two equally-correct rule compositions
// that `.set()` two sibling args (e.g. "order" and "limit" on the same `Select`) in a
// different sequence produce a different `.dfs()` order even though
// `Generator#selectSql` always renders ORDER BY before LIMIT regardless of object key
// order -- found in this round's own full-RULES composition on a real TPC-DS query.
// AND/OR associativity is the same class of non-observable difference (`a AND (b AND
// c)` and `(a AND b) AND c` render identical text) -- found on a query with both a
// correlated subquery and a multi-term join condition. Both are neutralized here by
// NEVER relying on insertion/construction order: every node's own children are
// visited in arg-KEY-NAME order (not insertion order, and not by re-sorting a
// list-valued arg's own internal element order, which stays as-is since THAT order
// is real and observable), and an And/Or node's children are its OWN `.flatten()`
// leaves sorted by `structuralKey` rather than its raw `.this`/`.expression` pair.
function fingerprint(ast) {
  function visit(n) {
    const scalars = {};
    for (const [k, v] of Object.entries(n.args)) {
      if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        scalars[k] = v === undefined ? null : v;
      }
    }
    const sortedScalars = {};
    for (const k of Object.keys(scalars).sort()) sortedScalars[k] = scalars[k];
    const out = [[n.constructor.name, sortedScalars]];

    if (n instanceof exp.And || n instanceof exp.Or) {
      const leaves = [...n.flatten()].sort((a, b) => {
        const ka = structuralKey(a), kb = structuralKey(b);
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
      for (const leaf of leaves) out.push(...visit(leaf));
      return out;
    }

    for (const key of Object.keys(n.args).sort()) {
      const v = n.args[key];
      if (Array.isArray(v)) {
        for (const item of v) if (item instanceof exp.Expr) out.push(...visit(item));
      } else if (v instanceof exp.Expr) {
        out.push(...visit(v));
      }
    }
    return out;
  }
  return visit(ast);
}

// Named, pre-existing, unrelated-to-optimizer.js base-Generator gaps -- thrown DURING
// `ast.sql()`, i.e. AFTER a real, comparable AST already exists. Counted separately
// as GENERATOR_GAP (fingerprint-verified against the real CPython AST, never just
// assumed) rather than silently folded into EXACT or miscounted as MISMATCH/ERROR.
// `blockedBy` labels each for this round's own ranked-blocker reporting.
//
// AIR-2194 (PORT_PLAN.md) ported `div_sql`/`rollup_sql`/`hint_sql`/`dateadd_sql`/
// `dot_sql`/`extract_sql`/`concat_sql`/`pivot_sql`/`currentdate_sql`/
// `querytransform_sql` (plus `joinhint_sql`/`pivotalias_sql`, two render-side
// siblings those ten's own un-stubbing surfaced next) — removed from this list, all
// real now. `kwarg_sql` is the one base-Generator gap AIR-2194 explicitly left
// un-fixed (out of its own named scope); still real, still named here.
const KNOWN_GENERATOR_GAPS = [
  { re: /^NotPorted: kwarg_sql is not ported yet/, blockedBy: "kwarg_sql" },
  { re: /^PyValueError: Unsupported expression type JSONPathKey/, blockedBy: "JSONPathKey generator (colon-access)" },
];

function matchKnownGap(e) {
  const s = `${e.constructor.name}: ${e.message}`;
  for (const g of KNOWN_GENERATOR_GAPS) if (g.re.test(s)) return g.blockedBy;
  return null;
}

// Named, pre-existing, unrelated-to-optimizer.js blockers thrown BEFORE any
// comparable AST exists -- during `parseOne` (a parser-grammar gap, or a dialect
// this port doesn't have at all) or during `optimize()` itself (none observed this
// round, but checked at the same point for symmetry). No fingerprint check is
// possible here; these rows are SKIPPED by name, never ERROR.
const KNOWN_PARSE_BLOCKERS = [
  { re: /^PyValueError: Unknown dialect 'clickhouse'/, blockedBy: "dialects/clickhouse.js (unported)" },
  { re: /^NotPorted: _parse_grouping_set is not ported yet/, blockedBy: "parser.js _parse_grouping_set (GROUPING SETS)" },
  { re: /^NotPorted: Dialect\.to_json_path is not ported yet/, blockedBy: "jsonpath.js parse_json_path (colon-access parse)" },
];

function matchKnownBlocker(e) {
  const s = `${e.constructor.name}: ${e.message}`;
  for (const g of KNOWN_PARSE_BLOCKERS) if (g.re.test(s)) return g.blockedBy;
  return null;
}

let exact = 0;
let generatorGap = 0;
let mismatch = 0;
let error = 0;
let skipped = 0;
const samples = [];
const gapCounts = new Map();
const skipCounts = new Map();
const errorCounts = new Map();

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function resolveSchema(kwargs) {
  if (kwargs.schema === "SELF") return SELF_SCHEMA;
  if (kwargs.schema_kind === "mapping_bigquery") {
    return new MappingSchema(kwargs.schema, null, "bigquery");
  }
  // tpc-h/tpc-ds rows (and every plain-dict-schema row) carry the real schema
  // object inline already -- `schema_tag` ("TPCH"/"TPCDS") is log-only, not a
  // dispatch key, see `gen_optimize_e2e_ref.py`'s own comment at this row's origin.
  return kwargs.schema;
}

// Mirrors `gen_optimize_e2e_ref.py`'s own `SELF_SCHEMA` (test_optimizer.py:131-176
// `TestOptimizer.setUp`'s `self.schema`) verbatim.
const SELF_SCHEMA = {
  x: { a: "INT", b: "INT" },
  y: { b: "INT", c: "INT" },
  z: { b: "INT", c: "INT" },
  w: { d: "TEXT", e: "TEXT" },
  temporal: { d: "DATE", t: "DATETIME" },
  structs: {
    one: "STRUCT<a_1 INT, b_1 VARCHAR>",
    nested_0: "STRUCT<a_1 INT, nested_1 STRUCT<a_2 INT, nested_2 STRUCT<a_3 INT>>>",
    quoted: 'STRUCT<"foo bar" INT>',
  },
  t_bool: { a: "BOOLEAN", b: "BOOLEAN" },
  unpivotable: { id: "INT", jan: "INT", feb: "INT", north: "INT", south: "INT" },
  pivotable: { id: "INT", cat: "TEXT", val: "INT", kind: "TEXT", amt: "INT" },
};

const RULE_FNS = {
  qualify, qualify_tables, qualify_columns, quote_identifiers, merge_subqueries,
  annotate_types, canonicalize,
};

function resolveRules(tag) {
  if (!tag) return undefined;
  return tag.split("+").map((n) => {
    const fn = RULE_FNS[n];
    if (!fn) throw new Error(`resolveRules: unknown rule tag ${n}`);
    return fn;
  });
}

function buildOptions(row) {
  const k = row.kwargs || {};
  const options = {};
  if ("schema" in k) options.schema = resolveSchema(k);
  if ("dialect" in k) options.dialect = k.dialect;
  if ("rules" in k) options.rules = resolveRules(k.rules);
  if ("leave_tables_isolated" in k) options.leave_tables_isolated = k.leave_tables_isolated;
  if ("sql_kwarg" in k) options.sql = k.sql_kwarg ? row.sql : null;
  if (k.on_qualify === "replace_with_bar") {
    options.on_qualify = (table) => table.replace(exp.toTable("bar"));
  }
  return options;
}

for (const row of ref) {
  const name = row.name;

  if ((row.read_dialect || "").startsWith("mysql")) {
    skipped++;
    bump(skipCounts, "dialects/mysql.js (unported)");
    continue;
  }

  // Stage 1: parse. A throw here means no AST exists at all -- a known blocker
  // (unported dialect / parser-grammar gap) is SKIPPED, anything else is ERROR.
  let parsed;
  try {
    parsed = parseOne(row.sql, row.read_dialect ? { read: row.read_dialect } : undefined);
  } catch (e) {
    const blockedBy = matchKnownBlocker(e);
    if (blockedBy) {
      skipped++;
      bump(skipCounts, blockedBy);
    } else {
      error++;
      bump(errorCounts, `${e.constructor.name}: ${e.message.slice(0, 80)}`);
      samples.push(`ERROR    ${name}: ${e.constructor.name}: ${e.message} (at parse)\n  sql: ${row.sql}`);
    }
    continue;
  }

  // Stage 2: optimize(). For "error" rows this throw IS the expected outcome
  // (`OptimizeError` from `validate_qualify_columns`) and is checked against the
  // real CPython message, not treated as a failure.
  let outcome;
  try {
    const options = buildOptions(row);
    const ast = optimize(parsed, options);

    if (row.kind === "error") {
      outcome = { error: true, raised: false };
    } else if (row.kind === "type") {
      const node = row.path === "expressions0" ? ast.expressions[0] : ast.selects[0];
      outcome = { typeName: node.type.this.name };
    } else {
      // Stage 3: generate. A throw here still has a real, comparable AST behind
      // it -- a known generator gap falls back to the fingerprint comparison
      // instead of being silently counted as EXACT or blindly as ERROR.
      let output;
      let gapBy = null;
      try {
        output = ast.sql(row.render_dialect ?? undefined, { pretty: !!row.pretty });
      } catch (e) {
        gapBy = matchKnownGap(e);
        if (!gapBy) throw e;
      }
      outcome = gapBy ? { gap: gapBy, fingerprint: fingerprint(ast) } : { output };
    }
  } catch (e) {
    if (row.kind === "error") {
      let ok = true;
      for (const s of row.must_contain || []) if (!e.message.includes(s)) ok = false;
      for (const s of row.must_not_contain || []) if (e.message.includes(s)) ok = false;
      outcome = { error: true, raised: true, ok };
    } else {
      const blockedBy = matchKnownBlocker(e);
      outcome = blockedBy ? { skip: blockedBy } : { thrown: e };
    }
  }

  if (outcome.skip) {
    skipped++;
    bump(skipCounts, outcome.skip);
    continue;
  }

  if (outcome.thrown) {
    error++;
    bump(errorCounts, `${outcome.thrown.constructor.name}: ${outcome.thrown.message.slice(0, 80)}`);
    samples.push(`ERROR    ${name}: ${outcome.thrown.constructor.name}: ${outcome.thrown.message}\n  sql: ${row.sql}`);
    continue;
  }

  if (row.kind === "error") {
    if (outcome.raised && outcome.ok) exact++;
    else {
      mismatch++;
      samples.push(`MISMATCH ${name}: expected OptimizeError matching ${JSON.stringify(row.must_contain)}, raised=${outcome.raised}`);
    }
    continue;
  }

  if (row.kind === "type") {
    if (outcome.typeName === row.expected_type_name) exact++;
    else {
      mismatch++;
      samples.push(`MISMATCH ${name}: type ${outcome.typeName} != expected ${row.expected_type_name}`);
    }
    continue;
  }

  // kind === "sql"
  if (outcome.gap) {
    const want = JSON.stringify(row.fingerprint);
    const have = JSON.stringify(outcome.fingerprint);
    if (want === have) {
      generatorGap++;
      bump(gapCounts, outcome.gap);
    } else {
      mismatch++;
      samples.push(`MISMATCH ${name} (fingerprint, gap=${outcome.gap})\n  sql: ${row.sql}`);
    }
  } else if (outcome.output === row.output) {
    exact++;
  } else {
    mismatch++;
    samples.push(`MISMATCH ${name}\n  sql:      ${row.sql}\n  expected: ${row.output}\n  got:      ${outcome.output}`);
  }
}

console.log();
console.log("  AIR-2119: optimizer.optimize() end-to-end vs CPython sqlglot.optimizer.optimizer");
console.log(`    EXACT ${exact}    GENERATOR_GAP ${generatorGap}    MISMATCH ${mismatch}    ERROR ${error}    SKIPPED ${skipped}`);
console.log(`    total rows: ${ref.length}`);

if (gapCounts.size) {
  console.log();
  console.log("    GENERATOR_GAP by blocker (ranked):");
  for (const [k, v] of [...gapCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${String(v).padStart(4)}  ${k}`);
  }
}
if (skipCounts.size) {
  console.log();
  console.log("    SKIPPED by blocker (ranked):");
  for (const [k, v] of [...skipCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${String(v).padStart(4)}  ${k}`);
  }
}
if (errorCounts.size) {
  console.log();
  console.log("    ERROR by message (ranked):");
  for (const [k, v] of [...errorCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${String(v).padStart(4)}  ${k}`);
  }
}

if (samples.length) {
  console.log();
  for (const s of samples) console.log(VERBOSE ? `  ${s}\n` : `  ${s.split("\n")[0]}`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
