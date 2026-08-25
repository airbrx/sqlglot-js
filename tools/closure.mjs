// Computes atom closure per implemented dialect set — the source of every phase exit
// number in PORT_PLAN.md §7. Machine-computed, checked in, reproducible (§3.2).
//
//   node tools/closure.mjs                      # phase table from corpus/atoms.jsonl
//   node tools/closure.mjs --markdown           # same table, ready to paste into §3.2
//   node tools/closure.mjs --marginal           # greedy marginal value from the P8 base
//   node tools/closure.mjs --greedy             # full P9 ordering, recomputed greedily
//   node tools/closure.mjs --classes P6         # per-test-class closure at a phase (A2)
//   node tools/closure.mjs --dialects           # every dialect key, with atom counts
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

// `--classes P6` takes a value, so that value must not be mistaken for the corpus path.
const positional = argv.filter(
  (a, i) => !a.startsWith("--") && argv[i - 1] !== "--classes",
);
const path = positional[0] ?? "corpus/atoms.jsonl";
if (!existsSync(path)) {
  console.error(`  ${path} not found — run tools/harvest/harvest.py first.`);
  console.error("  (node tools/closure.mjs --selftest verifies the maths without it)");
  process.exit(2);
}

const atoms = loadAtoms(path);
const V0 = new Set(PHASES.flatMap((p) => p.add));

if (argv.includes("--dialects")) {
  const reads = new Map();
  const writes = new Map();
  for (const a of atoms) {
    reads.set(a.read, (reads.get(a.read) ?? 0) + 1);
    writes.set(a.write, (writes.get(a.write) ?? 0) + 1);
  }
  const keys = [...allDialects(atoms)].sort();
  console.log(`\n  ${keys.length} distinct dialect keys\n`);
  console.log("  " + "dialect".padEnd(30) + "as read".padStart(10) + "as write".padStart(10));
  console.log("  " + "-".repeat(50));
  for (const k of keys) {
    console.log(
      `  ${(k || "<default>").padEnd(30)}${String(reads.get(k) ?? 0).padStart(10)}${String(writes.get(k) ?? 0).padStart(10)}`,
    );
  }
  process.exit(0);
}

if (argv.includes("--marginal")) {
  console.log("\n  greedy marginal value from the P8 base:\n");
  for (const { dialect, marginal: m } of marginal(atoms, V0)) {
    if (m === 0) continue;
    console.log(`    ${(dialect || "<default>").padEnd(18)}+${String(m).padStart(6)}`);
  }
  process.exit(0);
}

if (argv.includes("--greedy")) {
  // §7 P9 orders the long tail by greedy marginal value. Recompute it: after each
  // pick the remaining marginals change, so a single ranking from the P8 base is
  // NOT the same as the greedy sequence.
  const S = new Set(V0);
  console.log("\n  P9 long tail, greedy order (recomputed after each pick):\n");
  let step = 0;
  for (;;) {
    const cands = marginal(atoms, S);
    if (!cands.length || cands[0].marginal === 0) break;
    const pick = cands[0];
    S.add(pick.dialect);
    step++;
    console.log(
      `    ${String(step).padStart(3)}. ${(pick.dialect || "<default>").padEnd(18)}+${String(pick.marginal).padStart(6)}   (cum ${closed(atoms, S).toLocaleString()})`,
    );
  }
  const rest = [...allDialects(atoms)].filter((d) => !S.has(d));
  if (rest.length) {
    console.log(`\n    ${rest.length} keys add 0 atoms on their own: ${rest.sort().join(", ")}`);
  }
  process.exit(0);
}

const classesFlag = argv.indexOf("--classes");
if (classesFlag >= 0) {
  const want = argv[classesFlag + 1] ?? "P8 (v0)";
  const S = new Set();
  for (const p of PHASES) {
    for (const d of p.add) S.add(d);
    if (p.name === want || p.name.startsWith(want)) break;
  }
  const bc = [...byClass(atoms, S)].sort((a, b) => b[1].total - a[1].total);
  console.log(`\n  per-test-class closure after ${want}  (${[...S].length} dialects)\n`);
  console.log("  " + "class".padEnd(26) + "closed".padStart(9) + "total".padStart(9) + "pct".padStart(9));
  console.log("  " + "-".repeat(53));
  for (const [cls, e] of bc) {
    const pct = e.total ? ((100 * e.closed) / e.total).toFixed(1) + "%" : "-";
    console.log(
      `  ${cls.padEnd(26)}${String(e.closed).padStart(9)}${String(e.total).padStart(9)}${pct.padStart(9)}`,
    );
  }
  process.exit(0);
}

if (argv.includes("--markdown")) {
  const rows = phaseTable(atoms);
  const all = allDialects(atoms);
  console.log(`\n| after phase | dialect set | atoms closed | % of ${atoms.length.toLocaleString()} | marginal |`);
  console.log("|---|---|---|---|---|");
  const labels = {
    P4: "`{snowflake}`",
    P5: "`+ default`",
    P6: "`+ duckdb`",
    P7: "`+ hive, spark2, spark, databricks`",
    "P8 (v0)": "`+ postgres, redshift`",
  };
  for (const r of rows) {
    const bold = r.phase.startsWith("P8") ? "**" : "";
    console.log(
      `| ${bold}${r.phase}${bold} | ${labels[r.phase]} | ${bold}${r.closed.toLocaleString()}${bold} | ${bold}${r.pct.toFixed(1)}%${bold} | +${r.marginal.toLocaleString()} |`,
    );
  }
  const last = rows[rows.length - 1].closed;
  console.log(
    `| P9 | all ${all.size} dialect keys | ${atoms.length.toLocaleString()} | 100% | +${(atoms.length - last).toLocaleString()} |`,
  );
  console.log();
  process.exit(0);
}

console.log(`\n  ${atoms.length.toLocaleString()} atoms from ${path}\n`);

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
