// Computes atom closure per implemented dialect set — the source of every phase exit
// number in PORT_PLAN.md §7. Machine-computed, checked in, reproducible (§3.2).
//
//   node tools/closure.mjs                      # phase table from corpus/atoms.jsonl
//   node tools/closure.mjs --marginal           # greedy marginal value from the P8 base
//   node tools/closure.mjs --selftest           # verify the maths on a synthetic corpus
//
// An atom is CLOSED under dialect set S iff BOTH its read and write dialects are in S.
// Closure is a pairwise condition, so coverage grows roughly quadratically in the number
// of implemented dialects — the single most important fact about the schedule, and the
// reason this is published at P0 as a curve rather than discovered at P6 as a
// disappointment (§3.2, R3).

import { readFileSync, existsSync } from "node:fs";

// §7. The default dialect is "" (§3.2).
export const PHASES = [
  { name: "P4", add: ["snowflake"] },
  { name: "P5", add: [""] },
  { name: "P6", add: ["duckdb"] },
  { name: "P7", add: ["hive", "spark2", "spark", "databricks"] },
  { name: "P8 (v0)", add: ["postgres", "redshift"] },
];

export function loadAtoms(path) {
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line) out.push(JSON.parse(line));
  }
  return out;
}

/** Atoms closed under dialect set S. */
export function closed(atoms, S) {
  let n = 0;
  for (const a of atoms) {
    if (S.has(a.read) && S.has(a.write)) n++;
  }
  return n;
}

/** Per-phase cumulative closure table. */
export function phaseTable(atoms, phases = PHASES) {
  const S = new Set();
  const rows = [];
  let prev = 0;
  for (const p of phases) {
    for (const d of p.add) S.add(d);
    const n = closed(atoms, S);
    rows.push({
      phase: p.name,
      dialects: [...S],
      closed: n,
      pct: (100 * n) / atoms.length,
      marginal: n - prev,
    });
    prev = n;
  }
  return rows;
}

/** All dialect keys appearing as either a read or a write. */
export function allDialects(atoms) {
  const s = new Set();
  for (const a of atoms) {
    s.add(a.read);
    s.add(a.write);
  }
  return s;
}

/** Greedy marginal value: which single dialect adds the most atoms from a base set. */
export function marginal(atoms, base) {
  const S = new Set(base);
  const start = closed(atoms, S);
  const out = [];
  for (const d of allDialects(atoms)) {
    if (S.has(d)) continue;
    S.add(d);
    out.push({ dialect: d, marginal: closed(atoms, S) - start });
    S.delete(d);
  }
  out.sort((a, b) => b.marginal - a.marginal || (a.dialect < b.dialect ? -1 : 1));
  return out;
}

/** Per-test-class closure — the numbers A2 corrected (P6 = 2,086/2,437, not 100%). */
export function byClass(atoms, S) {
  const m = new Map();
  for (const a of atoms) {
    let e = m.get(a.cls);
    if (!e) {
      e = { total: 0, closed: 0 };
      m.set(a.cls, e);
    }
    e.total++;
    if (S.has(a.read) && S.has(a.write)) e.closed++;
  }
  return m;
}

/* --------------------------------------------------------------------------- *
 * self-test — the maths is verifiable without the harvested corpus              *
 * --------------------------------------------------------------------------- */

function selftest() {
  const A = (read, write, cls = "T") => ({ read, write, cls });
  const atoms = [
    A("snowflake", "snowflake"),
    A("snowflake", "duckdb"),
    A("duckdb", "snowflake"),
    A("duckdb", "duckdb"),
    A("snowflake", ""),
    A("", "snowflake"),
    A("bigquery", "snowflake"),
    A("snowflake", "bigquery"),
    A("hive", "spark"),
  ];

  const checks = [];
  const eq = (name, got, want) => checks.push({ name, ok: got === want, got, want });

  eq("closed under {} is 0", closed(atoms, new Set()), 0);
  eq("closed under {snowflake}", closed(atoms, new Set(["snowflake"])), 1);
  eq("closed under {snowflake,''}", closed(atoms, new Set(["snowflake", ""])), 3);
  eq(
    "closed under {snowflake,duckdb}",
    closed(atoms, new Set(["snowflake", "duckdb"])),
    4,
  );
  eq("closed under all", closed(atoms, allDialects(atoms)), atoms.length);

  // Pairwise growth: adding duckdb to {snowflake} adds BOTH directions, not one.
  const t = phaseTable(atoms, [
    { name: "a", add: ["snowflake"] },
    { name: "b", add: ["duckdb"] },
  ]);
  eq("marginal of duckdb after snowflake", t[1].marginal, 3);

  // Marginal ranking picks the biggest single win.
  const m = marginal(atoms, ["snowflake"]);
  eq("top marginal from {snowflake}", m[0].dialect, "duckdb");
  eq("top marginal value", m[0].marginal, 3);

  // A dialect pair unrelated to the base contributes nothing on its own.
  eq("hive alone from {snowflake}", m.find((x) => x.dialect === "hive").marginal, 0);

  // Per-class accounting sums to the whole.
  const bc = byClass(atoms, new Set(["snowflake", "duckdb"]));
  eq("byClass total", bc.get("T").total, atoms.length);
  eq("byClass closed", bc.get("T").closed, 4);

  let bad = 0;
  for (const c of checks) {
    if (!c.ok) bad++;
    console.log(
      `  ${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok ? "" : `  want ${c.want}, got ${c.got}`}`,
    );
  }
  console.log(bad === 0 ? "\n  CLOSURE SELFTEST: GREEN\n" : `\n  CLOSURE SELFTEST: RED (${bad})\n`);
  return bad === 0 ? 0 : 1;
}

/* --------------------------------------------------------------------------- */

const argv = process.argv.slice(2);
if (argv.includes("--selftest")) {
  process.exit(selftest());
}

const path = argv.find((a) => !a.startsWith("--")) ?? "corpus/atoms.jsonl";
if (!existsSync(path)) {
  console.error(`  ${path} not found — run tools/harvest/harvest.py first.`);
  console.error("  (node tools/closure.mjs --selftest verifies the maths without it)");
  process.exit(2);
}

const atoms = loadAtoms(path);
console.log(`\n  ${atoms.length.toLocaleString()} atoms from ${path}\n`);

if (argv.includes("--marginal")) {
  const base = new Set(PHASES.flatMap((p) => p.add));
  console.log("  greedy marginal value from the P8 base:\n");
  for (const { dialect, marginal: m } of marginal(atoms, base)) {
    if (m === 0) continue;
    console.log(`    ${(dialect || "<default>").padEnd(16)}+${String(m).padStart(6)}`);
  }
  process.exit(0);
}

console.log(
  "  " + "after".padEnd(10) + "atoms closed".padStart(14) + "% of total".padStart(12) + "marginal".padStart(11),
);
console.log("  " + "-".repeat(47));
for (const r of phaseTable(atoms)) {
  console.log(
    `  ${r.phase.padEnd(10)}${r.closed.toLocaleString().padStart(14)}${(r.pct.toFixed(1) + "%").padStart(12)}${("+" + r.marginal.toLocaleString()).padStart(11)}`,
  );
}
const all = allDialects(atoms);
console.log(
  `  ${"P9".padEnd(10)}${closed(atoms, all).toLocaleString().padStart(14)}${"100.0%".padStart(12)}${("+" + (closed(atoms, all) - closed(atoms, new Set(PHASES.flatMap((p) => p.add)))).toLocaleString()).padStart(11)}`,
);
console.log("  " + "-".repeat(47));
console.log(`\n  ${all.size} distinct dialect keys\n`);
