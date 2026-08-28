// Marginal AST-oracle closure for a set of parser methods.
//
//   node tools/closure_parser.mjs                       # state today + next-best work
//   node tools/closure_parser.mjs --add _parse_expression,_parse_alias
//   node tools/closure_parser.mjs --curve               # achievable closure curve
//   node tools/closure_parser.mjs --brief _parse_column # honest per-method task brief
//
// Reads corpus/parse_demand.json (see tools/harvest/trace_parse_demand.py) and
// src/parser.js. Zero dependencies.
//
// WHY: oracle-row closure is CONJUNCTIVE — a row is closed only when every method its
// parse touches is implemented. "Method M blocks N rows" is therefore NOT "implementing
// M opens N rows", and the two differ by orders of magnitude. Over this corpus the
// per-method blocking counts sum to 751,871 against 15,540 real rows (48.4x over-count:
// each row is counted once per method it touches), so ranking stub-queue tasks by
// blocking count mis-sizes every brief. This tool reports the marginal — the rows that
// actually close — which is what a task brief should carry.

import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

const demand = JSON.parse(readFileSync("corpus/parse_demand.json", "utf8"));
// `per_row` stores indices into `methods` (see the harvester's docstring); rehydrate.
const METHODS = demand.methods;
const perRow = Object.fromEntries(
  Object.entries(demand.per_row).map(([id, ix]) => [id, ix.map((i) => METHODS[i])]),
);
const freq = Object.fromEntries(METHODS.map((m, i) => [m, demand.freq[i]]));
const rowIds = Object.keys(perRow);

/** Methods with a real body in src/parser.js — i.e. not a `NotPorted` stub. */
function implementedMethods() {
  const lines = readFileSync("src/parser.js", "utf8").split("\n");
  const impl = new Set();
  const stubs = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^ {2}([A-Za-z_$][\w$]*)\s*\(/);
    if (!m) continue;
    // A stub is a single line whose body is exactly `throw new NotPorted(...)`.
    (/throw new NotPorted/.test(lines[i]) ? stubs : impl).add(m[1]);
  }
  // A name that appears both ways is implemented (the seeder emitted `@t.overload`
  // declarations as duplicate methods; the last definition is the one JS keeps).
  for (const name of impl) stubs.delete(name);
  return { impl, stubs };
}

const { impl, stubs } = implementedMethods();
const closedBy = (have) =>
  rowIds.filter((id) => perRow[id].every((m) => have.has(m))).length;

const have = new Set(impl);
const base = closedBy(have);

if (argv.includes("--brief")) {
  const target = flag("--brief");
  const blocks = rowIds.filter((id) => perRow[id].includes(target)).length;
  const withIt = new Set([...have, target]);
  const marginal = closedBy(withIt) - base;
  const stillBlocked = rowIds.filter(
    (id) => perRow[id].includes(target) && !perRow[id].every((m) => withIt.has(m)),
  );
  const next = new Map();
  for (const id of stillBlocked) {
    for (const m of perRow[id]) if (!withIt.has(m)) next.set(m, (next.get(m) || 0) + 1);
  }
  console.log(`\n  ${target}`);
  console.log(`    rows that CALL it (the "blocks" number)   ${blocks}`);
  console.log(`    rows it actually OPENS (the marginal)     ${marginal}`);
  console.log(`    rows still blocked after it lands         ${stillBlocked.length}`);
  console.log(`    distinct methods still blocking those     ${next.size}`);
  console.log(`\n    next blockers:`);
  for (const [m, c] of [...next].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`      ${String(c).padStart(6)}  ${m}`);
  }
  process.exit(0);
}

if (argv.includes("--add")) {
  const added = flag("--add").split(",").map((s) => s.trim()).filter(Boolean);
  const after = new Set([...have, ...added]);
  const n = closedBy(after);
  console.log(`\n  rows closed now            ${base} / ${rowIds.length}`);
  console.log(`  rows closed with +${added.length} methods  ${n} / ${rowIds.length}`);
  console.log(`  MARGINAL                   +${n - base}`);
  process.exit(0);
}

if (argv.includes("--curve")) {
  // Achievable ordering: repeatedly take the open row needing the fewest new methods
  // and add all of them. Cheap, and it bounds the real curve from the practical side.
  const state = new Set(have);
  const rows = rowIds.map((id) => perRow[id]);
  console.log(`\n  ${"methods".padStart(8)} ${"rows".padStart(7)} ${"%".padStart(7)}`);
  let guard = 0;
  while (guard++ < 4000) {
    const open = rows.filter((r) => r.some((m) => !state.has(m)));
    if (!open.length) break;
    let best = null;
    let bestMissing = Infinity;
    for (const r of open) {
      const missing = r.filter((m) => !state.has(m)).length;
      if (missing < bestMissing) {
        bestMissing = missing;
        best = r;
      }
    }
    for (const m of best) state.add(m);
    const c = rows.filter((r) => r.every((m) => state.has(m))).length;
    console.log(
      `  ${String(state.size - have.size).padStart(8)} ${String(c).padStart(7)} ` +
        `${((100 * c) / rows.length).toFixed(1).padStart(6)}%`,
    );
    if (c >= rows.length) break;
  }
  process.exit(0);
}

// Default view: where the port stands, and what is worth doing next.
console.log(`\n  corpus rows                ${rowIds.length}`);
console.log(`  distinct methods demanded  ${Object.keys(freq).length}`);
console.log(`  implemented in src/parser  ${impl.size}   (stubs remaining: ${stubs.size})`);
console.log(`  AST-oracle rows closed     ${base} (${((100 * base) / rowIds.length).toFixed(2)}%)`);

const openRows = rowIds.filter((id) => !perRow[id].every((m) => have.has(m)));
const blockers = new Map();
for (const id of openRows) {
  for (const m of perRow[id]) if (!have.has(m)) blockers.set(m, (blockers.get(m) || 0) + 1);
}
console.log(`\n  ${blockers.size} distinct methods block the remaining ${openRows.length} rows.`);
console.log(`  Ranked by rows BLOCKED (note: this is NOT the marginal — see --brief):`);
for (const [m, c] of [...blockers].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`    ${String(c).padStart(6)}  ${m}`);
}

// How many rows are one single method away? Those are the genuinely cheap wins.
const oneAway = new Map();
for (const id of openRows) {
  const missing = perRow[id].filter((m) => !have.has(m));
  if (missing.length === 1) oneAway.set(missing[0], (oneAway.get(missing[0]) || 0) + 1);
}
console.log(`\n  Methods that are the LAST one missing for some row (real marginal > 0):`);
if (!oneAway.size) {
  console.log(`    none — every open row needs >= 2 more methods.`);
  console.log(`    This is the conjunctive-closure wall: no single stub opens any row.`);
} else {
  for (const [m, c] of [...oneAway].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`    ${String(c).padStart(6)}  ${m}`);
  }
}
