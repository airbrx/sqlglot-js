// Corpus integrity checks. The atom model (§3.2) assumes `input_id` determines the
// expectation — that is what makes ratchet rule 5 (the F1 fix) sound. If one input_id
// carries two different expect_hashes, a baseline keyed by input_id is ambiguous and
// rule 5 fires spuriously.
//
//   node tools/check_corpus.mjs

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const atoms = readFileSync("corpus/atoms.jsonl", "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const byInput = new Map();
for (const a of atoms) {
  let e = byInput.get(a.input_id);
  if (!e) {
    e = new Map();
    byInput.set(a.input_id, e);
  }
  let list = e.get(a.expect_hash);
  if (!list) {
    list = [];
    e.set(a.expect_hash, list);
  }
  list.push(a);
}

const conflicting = [...byInput].filter(([, hashes]) => hashes.size > 1);

console.log(`\n  ${atoms.length.toLocaleString()} atoms`);
console.log(`  ${byInput.size.toLocaleString()} distinct input_ids`);
console.log(`  ${conflicting.length.toLocaleString()} input_ids with >1 expect_hash\n`);

// Duplicate atom_ids would be a different (worse) problem.
const ids = new Set(atoms.map((a) => a.atom_id));
console.log(`  ${ids.size.toLocaleString()} distinct atom_ids ` +
  `(${atoms.length === ids.size ? "no duplicates" : "DUPLICATES PRESENT"})\n`);

let sentinelVsValue = 0;
let other = 0;
if (conflicting.length) {
  // Classify: is the conflict the UnsupportedError sentinel (expected === null)?
  const samples = [];
  for (const [inputId, hashes] of conflicting) {
    const all = [...hashes.values()].flat();
    const hasNull = all.some((a) => a.expected === null);
    const hasValue = all.some((a) => a.expected !== null);
    if (hasNull && hasValue) sentinelVsValue++;
    else {
      other++;
      if (samples.length < 5) samples.push({ inputId, all });
    }
  }
  console.log(`    UnsupportedError-sentinel vs generated value : ${sentinelVsValue}`);
  console.log(`    other (genuinely differing expectations)     : ${other}\n`);

  for (const { inputId, all } of samples) {
    console.log(`  input_id ${inputId}:`);
    for (const a of all) {
      console.log(
        `    ${a.cls.padEnd(18)} ${a.read || "<default>"} -> ${a.write || "<default>"}  ` +
          `unsup=${JSON.stringify(a.unsupported).slice(0, 40)}`,
      );
      console.log(`      sql:      ${JSON.stringify(a.sql).slice(0, 90)}`);
      console.log(`      expected: ${JSON.stringify(a.expected).slice(0, 90)}`);
    }
    console.log();
  }
}

/* --------------------------------------------------------------------------- *
 * oracle staleness                                                             *
 *
 * corpus/ast/ and corpus/gen/ are keyed by atom_id, and atom_id derives from
 * input_id. Any change to the input_id formula (or a re-harvest) silently orphans
 * every oracle row: the runner would look them up, find nothing, and could report a
 * clean run against an oracle that describes a corpus which no longer exists.
 * --------------------------------------------------------------------------- */

let oracleStale = 0;
function checkOracle(dir, label) {
  if (!existsSync(dir)) {
    console.log(`  ${label}: not built`);
    return;
  }
  let rows = 0;
  let orphans = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line) continue;
      rows++;
      if (!ids.has(JSON.parse(line).atom_id)) orphans++;
    }
  }
  const pct = rows ? ((100 * orphans) / rows).toFixed(1) : "0.0";
  console.log(
    `  ${label}: ${rows.toLocaleString()} rows, ${orphans.toLocaleString()} orphaned (${pct}%)` +
      (orphans ? "  <- STALE, regenerate with tools/astdump.py" : ""),
  );
  if (orphans) oracleStale += orphans;
}

checkOracle("corpus/ast", "AST oracle");
checkOracle("corpus/gen", "generate oracle");
console.log();

// Sentinel-vs-value conflicts are EXPECTED and handled: `ratchet.inputKey()` folds the
// raises-ness into the key, and harvest.py now folds it into input_id itself (so a
// re-harvest drives this count to 0). Anything else means input_id is not a key for a
// reason we do not understand, which would make ratchet rule 5 unsound — hard fail.
if (other > 0) {
  console.log(`  CORPUS INTEGRITY: FAIL — ${other} unexplained input_id conflicts\n`);
  process.exit(1);
}
if (oracleStale > 0) {
  console.log(`  CORPUS INTEGRITY: FAIL — ${oracleStale.toLocaleString()} orphaned oracle rows\n`);
  process.exit(1);
}
console.log(
  sentinelVsValue > 0
    ? `  CORPUS INTEGRITY: ok (${sentinelVsValue} sentinel-vs-value conflicts, all keyed by inputKey)\n`
    : "  CORPUS INTEGRITY: ok\n",
);
process.exit(0);
