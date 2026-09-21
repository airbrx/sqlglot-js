// Corpus runner — PORT_PLAN.md §3.3, §8.3.
//
//   node test/runner.mjs                       # run every atom, apply the ratchet
//   node test/runner.mjs --dialect snowflake    # only atoms closed under a dialect set
//   node test/runner.mjs --filter DATE_TRUNC    # only atoms whose SQL matches
//   node test/runner.mjs --selftest             # verify the runner with a fake library
//   node test/runner.mjs --baseline             # accept the current corpus into the ratchet
//
// Every selected atom runs against the production root API. Missing inputs/imports
// and empty populations are infrastructure failures. No automatic pass acceptance.

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCorpusAdapter } from "./corpus-adapter.mjs";
import { NotPorted } from "../src/errors.js";
import {
  loadRatchet,
  saveRatchet,
  check,
  resync,
  stateOf,
  inputKey,
  PASS,
} from "../tools/ratchet.mjs";
import { UnsupportedError } from "../src/errors.js";

const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1]; };
const RATCHET_PATH = option('--ratchet', 'test/ratchet.json');
const ATOMS_PATH = option('--atoms', 'corpus/atoms.jsonl');
const PROVENANCE_PATH = option('--provenance', 'corpus/PROVENANCE.json');
export const V0_DIALECTS = new Set(['', 'snowflake', 'duckdb', 'hive', 'spark2', 'spark', 'databricks', 'postgres', 'redshift']);

// PORT_PLAN.md §5.2/R6: golden expectations are interpreter-version-dependent
// (subsecond_precision, Unicode data). A corpus harvested under a different toolchain
// must not be silently accepted -- that is the exact failure mode R6 exists to name.
// Compares only the fields that are known to change output SQL (python_version,
// unidata_version); upstream_commit drift is what --resync is FOR, so it is not checked
// here.
function checkProvenance(ratchet) {
  if (!existsSync(PROVENANCE_PATH)) throw new Error(`Missing provenance: ${PROVENANCE_PATH}`);
  const current = JSON.parse(readFileSync(PROVENANCE_PATH, "utf8"));
  if (!ratchet.provenance) return { ok: true, current }; // first --baseline sets it
  const accepted = ratchet.provenance;
  const mismatch =
    accepted.python_version !== current.python_version ||
    accepted.unidata_version !== current.unidata_version;
  return { ok: !mismatch, current, accepted };
}

export function loadAtoms(path = ATOMS_PATH) {
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line) out.push(JSON.parse(line));
  }
  return out;
}

/** Loading errors are infrastructure failures, never NOT_PORTED atoms. */
export async function resolveTranspile(path = new URL('../index.js', import.meta.url)) {
  const library = await import(path);
  return createCorpusAdapter(library);
}

export function runAtom(atom, transpile) {
  if (typeof transpile !== 'function') throw new Error('Production corpus adapter is missing');
  let got;
  try {
    got = transpile(atom.sql, {
      read: atom.read, write: atom.write, pretty: atom.pretty,
      identify: atom.identify, raises: atom.raises ?? atom.expected === null,
    });
  } catch (error) { got = { error, unsupportedMessages: [] }; }
  const error = got?.error;
  const expectsError = atom.raises ?? atom.expected === null;
  if (error) {
    if (!(expectsError && error instanceof UnsupportedError)) {
      return { ok: false, reason: error instanceof NotPorted || /Unknown dialect/.test(error.message) ? 'STUB' : 'ERROR',
        detail: `${error.name}: ${error.message}` };
    }
  } else if (expectsError) {
    return { ok: false, reason: 'EXPECTED_ERROR_MISMATCH', got: got?.sql };
  } else if (typeof got?.sql !== 'string') {
    return { ok: false, reason: 'ERROR', detail: 'Adapter did not return SQL string' };
  } else if (got.sql !== atom.expected) {
    return { ok: false, reason: 'SQL_MISMATCH', got: got.sql, want: atom.expected };
  }
  const want = atom.unsupported ?? [];
  const actual = got.unsupportedMessages;
  if (!Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(want)) {
    return { ok: false, reason: 'WARNING_MISMATCH', got: actual, want };
  }
  return { ok: true, reason: expectsError ? 'PASS_EXPECTED_ERROR' : 'PASS' };
}

/* --------------------------------------------------------------------------- *
 * self-test — verifies the runner + ratchet wiring with a FAKE library          *
 * --------------------------------------------------------------------------- */

function selftest() {
  const checks = [];
  const t = (name, cond) => checks.push({ name, ok: !!cond });

  const atom = (over = {}) => ({
    atom_id: "a",
    sql: "SELECT 1",
    read: "snowflake",
    write: "duckdb",
    pretty: false,
    identify: false,
    expected: "SELECT 1",
    unsupported: [],
    ...over,
  });

  try { runAtom(atom(), null); t("missing library fails", false); } catch { t("missing library fails", true); }

  const good = () => ({ sql: "SELECT 1", unsupportedMessages: [] });
  t("exact match passes", runAtom(atom(), good).ok);

  const wrong = () => ({ sql: "SELECT 2", unsupportedMessages: [] });
  t("wrong SQL fails as SQL_MISMATCH", runAtom(atom(), wrong).reason === "SQL_MISMATCH");

  // §3.1(D): unsupported_messages are asserted, so a port that never calls
  // unsupported() must NOT be able to pass an atom that expects messages.
  const silent = () => ({ sql: "SELECT 1", unsupportedMessages: [] });
  const needsMsg = atom({ unsupported: ["x is not supported"] });
  t(
    "missing unsupported_messages fails",
    runAtom(needsMsg, silent).reason === "WARNING_MISMATCH",
  );
  const loud = () => ({ sql: "SELECT 1", unsupportedMessages: ["x is not supported"] });
  t("matching unsupported_messages passes", runAtom(needsMsg, loud).ok);

  // UnsupportedError sentinel: expected === null means the generate must throw the
  // library's OWN UnsupportedError -- not just throw something.
  const sentinel = atom({ expected: null });
  const throwsUnsupported = () => {
    throw new UnsupportedError("x is not supported");
  };
  t("sentinel passes when it throws UnsupportedError", runAtom(sentinel, throwsUnsupported).ok);
  t(
    "sentinel fails when it returns",
    runAtom(sentinel, good).reason === "EXPECTED_ERROR_MISMATCH",
  );
  // Codex review, PR #1: an unrelated crash on a sentinel atom must not be able to pass
  // by accident just because it happened to throw.
  const throwsUnrelated = () => {
    throw new TypeError("cannot read properties of undefined");
  };
  t(
    "sentinel fails when a non-UnsupportedError is thrown",
    runAtom(sentinel, throwsUnrelated).reason === "ERROR",
  );

  // Ratchet wiring: a pass-listed atom that fails must be reported as a regression.
  const R = { corpus_atoms: 1, pass: ["a"], wontfix: {}, quarantine: {}, baseline: {} };
  const res = check(R, new Map([["a", false]]));
  t("runner+ratchet reports regression", !res.ok && res.regressions.includes("a"));

  let bad = 0;
  for (const c of checks) {
    if (!c.ok) bad++;
    console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}`);
  }
  console.log(bad === 0 ? "\n  RUNNER SELFTEST: GREEN\n" : `\n  RUNNER SELFTEST: RED (${bad})\n`);
  return bad === 0 ? 0 : 1;
}

/* --------------------------------------------------------------------------- */

async function main() {
if (argv.includes("--selftest")) process.exit(selftest());

if (!existsSync(ATOMS_PATH)) {
  console.error(`  ${ATOMS_PATH} not found — run tools/harvest/harvest.py first.`);
  process.exit(2);
}

const atoms = loadAtoms();
if (!atoms.length) throw new Error('Empty corpus: no atoms evaluated');
if (new Set(atoms.map(a => a.atom_id)).size !== atoms.length) throw new Error('Duplicate atom IDs');
if (!existsSync(RATCHET_PATH)) throw new Error(`Missing ratchet: ${RATCHET_PATH}`);
const ratchet = loadRatchet(RATCHET_PATH);
const isBaselining = argv.includes("--baseline");

// R6/§5.2: enforce the recorded corpus provenance before doing anything else with the
// atoms. Skipped only when --baseline is the explicit human act of accepting a new one.
if (!isBaselining) {
  const prov = checkProvenance(ratchet);
  if (!prov.ok) {
    console.error(
      `\n  PROVENANCE MISMATCH -- corpus/PROVENANCE.json does not match the accepted toolchain.\n` +
        `    accepted: python ${prov.accepted.python_version}, unidata ${prov.accepted.unidata_version}\n` +
        `    current:  python ${prov.current.python_version}, unidata ${prov.current.unidata_version}\n` +
        `  Golden SQL is interpreter-version-dependent (subsecond_precision, Unicode data).\n` +
        `  Re-run with --baseline to explicitly accept this toolchain, or re-harvest under\n` +
        `  the accepted one.\n`,
    );
    process.exit(1);
  }
}

if (isBaselining) {
  // Accept the current corpus: record input_id -> expect_hash so rule 5 can detect a
  // changed expectation at the next resync, and snapshot the toolchain provenance this
  // baseline is valid for (R6/§5.2).
  const baseline = {};
  for (const a of atoms) baseline[inputKey(a)] = a.expect_hash;
  const prov = checkProvenance(ratchet);
  const provenance = prov.current ?? ratchet.provenance;
  saveRatchet(RATCHET_PATH, { ...ratchet, corpus_atoms: atoms.length, baseline, provenance });
  console.log(`  baselined ${atoms.length} atoms into ${RATCHET_PATH}`);
  if (provenance) {
    console.log(`  provenance: python ${provenance.python_version}, unidata ${provenance.unidata_version}`);
  }
  process.exit(0);
}

if (argv.includes("--resync")) {
  const rs = resync(ratchet, atoms);
  console.log(`\n  resync against baseline of ${Object.keys(ratchet.baseline).length} inputs\n`);
  console.log(`    unchanged            ${rs.unchanged.length}`);
  console.log(`    new inputs           ${rs.fresh.length}   (rule 4: quarantinable)`);
  console.log(`    CHANGED expectations ${rs.changed.length}   (rule 5: HARD FAIL)`);
  console.log(`    removed inputs       ${rs.removed.length}`);
  if (rs.changed.length) {
    console.log("\n  Rule 5 — these need an explicit human decision in UPSTREAM-NOTES.md:");
    for (const c of rs.changed.slice(0, 20)) {
      console.log(`    ${c.atom_id}  input ${c.input_id}  ${c.was} -> ${c.now}`);
    }
    process.exit(1);
  }
  if (rs.suspiciousTurnover) {
    console.log(
      `\n  TURNOVER GUARD — ${(rs.turnover * 100).toFixed(1)}% of the baseline disappeared.\n` +
        "  That is a provenance change (input_id formula, or a different upstream), not an\n" +
        "  upstream bump. Rule 4 would quarantine the whole corpus and report green.\n" +
        "  Re-baseline explicitly with `node test/runner.mjs --baseline` if this is intended.",
    );
    process.exit(1);
  }
  process.exit(0);
}

const dIdx = argv.indexOf("--dialect");
const dialects = argv.includes("--v0") ? V0_DIALECTS : dIdx >= 0 ? new Set(argv[dIdx + 1].split(",")) : null;
const fIdx = argv.indexOf("--filter");
const filter = fIdx >= 0 ? argv[fIdx + 1] : null;

let selected = atoms;
if (dialects) selected = selected.filter((a) => dialects.has(a.read) && dialects.has(a.write));
if (filter) selected = selected.filter((a) => a.sql.includes(filter));

if (!selected.length) throw new Error('Empty evaluated population: selection matched no atoms');
const rs = resync(ratchet, atoms);
if (rs.changed.length || rs.removed.length || rs.suspiciousTurnover) throw new Error('Corpus baseline drift: run --resync and obtain explicit review');
const atomIds = new Set(atoms.map(a => a.atom_id));
if (ratchet.pass.some(id => !atomIds.has(id))) throw new Error('Accepted pass IDs missing from corpus');
const transpile = await resolveTranspile(option('--library', null) ? pathToFileURL(resolve(option('--library'))) : undefined);
const report = [];
const results = new Map();
const reasons = new Map();
for (const a of selected) {
  const r = runAtom(a, transpile);
  report.push({ atom_id: a.atom_id, read: a.read, write: a.write, ...r });
  results.set(a.atom_id, r.ok);
  if (!r.ok) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
}

if (option('--report', null)) writeFileSync(option('--report'), report.map(r => JSON.stringify(r)).join('\n') + '\n');
if (option('--propose-passes', null)) {
  // A review artifact only: never edits the ratchet, never accepts regressions.
  writeFileSync(option('--propose-passes'), JSON.stringify(report.filter(r => r.ok).map(r => r.atom_id).sort(), null, 1) + '\n');
}
const verdict = check(ratchet, results);
if (!ratchet.pass.length) { verdict.ok = false; console.error('No accepted pass population; proposed IDs require review'); }
const passSet = new Set(ratchet.pass);
const nPass = selected.filter((a) => stateOf(ratchet, a.atom_id, passSet) === PASS).length;

console.log(`\n  ${selected.length.toLocaleString()} atoms selected of ${atoms.length.toLocaleString()}`);
console.log(`  library: production root index.js (parse/generator adapter)\n`);
console.log(`    PASS ${report.filter(r => r.ok).length}; evaluated ${report.length}; exclusions 0`);
console.log(`    pass-listed   ${nPass.toLocaleString()}`);
console.log(`    todo          ${verdict.counts.todo.toLocaleString()}`);
console.log(`    wontfix       ${verdict.counts.wontfix.toLocaleString()}`);
console.log(`    quarantine    ${verdict.counts.quarantine.toLocaleString()}`);
if (reasons.size) {
  console.log("\n  failure reasons:");
  for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${r.padEnd(30)}${n.toLocaleString().padStart(8)}`);
  }
}
if (!verdict.ok) {
  if (verdict.regressions.length) {
    console.log(`\n  RULE 1 — ${verdict.regressions.length} pass-listed atoms FAILED:`);
    for (const a of verdict.regressions.slice(0, 20)) console.log(`    ${a}`);
  }
  if (verdict.rot.length) {
    console.log(`\n  RULE 2 — ${verdict.rot.length} todo/wontfix atoms PASSED (rot):`);
    for (const a of verdict.rot.slice(0, 20)) console.log(`    ${a}`);
  }
}
console.log(verdict.ok ? "\n  RATCHET: OK\n" : "\n  RATCHET: FAILED\n");
process.exit(verdict.ok ? 0 : 1);

}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`CORPUS INFRASTRUCTURE ERROR: ${error.stack}`); process.exitCode = 2; });
}
