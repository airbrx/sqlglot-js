// Mismatch diagnostic instrument -- PORT_PLAN.md Epic 11 (AIR-2271).
//
// Runs the full corpus like test/runner.mjs, but for every SQL_MISMATCH row
// computes WHERE the generated SQL first diverges from the golden SQL (char
// position, a context window, and the nearest token on each side), then
// clusters the rows by that divergence signature so the clusters can be
// ranked and handed off to root-cause-fixing sessions one at a time.
//
//   node tools/mismatch_report.mjs                        # cluster every SQL_MISMATCH row
//   node tools/mismatch_report.mjs --write duckdb          # only rows whose (normalized) write dialect matches
//   node tools/mismatch_report.mjs --reason ERROR          # cluster ERROR rows instead (message-based)
//   node tools/mismatch_report.mjs --dump rows.jsonl       # also write the full per-row diagnostic detail
//
// "Ported dialect" here means a dialect with a real src/dialects/<name>.js file
// (not the base Dialect stub) -- test/runner.mjs has no such filter today, so a
// row whose read or write dialect round-trips through an unported stub is noise
// for generator-fidelity diagnosis and is excluded by default (--all keeps them).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { loadAtoms, runAtom, resolveTranspile } from "../test/runner.mjs";

const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1]; };
const WRITE_FILTER = option("--write", null);
const REASON_FILTER = option("--reason", "SQL_MISMATCH");
const DUMP_PATH = option("--dump", null);
const TOP_N = Number(option("--top", "40"));
const INCLUDE_ALL = argv.includes("--all");

// Matches src/dialects/*.js minus dialect.js (the base class), plus "" (default/no dialect).
export const PORTED_DIALECTS = new Set([
  "", "bigquery", "databricks", "duckdb", "hive", "mysql", "postgres", "presto",
  "redshift", "snowflake", "spark", "spark2", "tsql",
]);

/** "duckdb, version=1.1.0" -> "duckdb". Harvested atoms carry dialect kwargs inline. */
export function normalizeDialect(name) {
  return (name ?? "").split(",")[0].trim();
}

/**
 * Find the first index where two strings diverge, then return a small window
 * of context plus the nearest whitespace/punctuation-delimited "token" on
 * each side at that point. Token boundaries use SQL-ish word chars so
 * identifiers and function names survive intact; everything else is treated
 * as a separator and does not itself become a token.
 */
const WORD_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

export function firstDivergence(got, want) {
  let i = 0;
  const n = Math.min(got.length, want.length);
  while (i < n && got[i] === want[i]) i++;
  if (i === n && got.length === want.length) return null; // identical (should not happen for a MISMATCH row)

  const contextStart = Math.max(0, i - 15);
  const gotContext = got.slice(contextStart, i + 25);
  const wantContext = want.slice(contextStart, i + 25);

  const tokenAt = (s, pos) => {
    // Nearest word token touching or following the divergence point.
    WORD_RE.lastIndex = 0;
    let m, best = null;
    while ((m = WORD_RE.exec(s))) {
      if (m.index + m[0].length >= pos) { best = m[0]; break; }
    }
    return best ? best.toUpperCase() : null;
  };

  return {
    index: i,
    gotContext,
    wantContext,
    gotToken: tokenAt(got, i),
    wantToken: tokenAt(want, i),
  };
}

/** Collapse a divergence into a cluster key. Numeric/string literal tokens are
 * frequent and would each form a singleton cluster, so only alphabetic tokens
 * (function/keyword names) are kept as discriminating signal. */
function clusterKey(div) {
  const norm = (t) => (t && /^[A-Z_]+$/.test(t) ? t : "<other>");
  return `${norm(div.gotToken)} -> ${norm(div.wantToken)}`;
}

async function main() {
  if (!existsSync("corpus/atoms.jsonl")) throw new Error("corpus/atoms.jsonl not found");
  const atoms = loadAtoms();
  const transpile = await resolveTranspile();

  let selected = atoms;
  if (!INCLUDE_ALL) {
    selected = selected.filter(
      (a) => PORTED_DIALECTS.has(normalizeDialect(a.read)) && PORTED_DIALECTS.has(normalizeDialect(a.write)),
    );
  }
  if (WRITE_FILTER) selected = selected.filter((a) => normalizeDialect(a.write) === WRITE_FILTER);

  const rows = [];
  for (const atom of selected) {
    const r = runAtom(atom, transpile);
    if (r.ok || r.reason !== REASON_FILTER) continue;
    const row = { atom_id: atom.atom_id, read: normalizeDialect(atom.read), write: normalizeDialect(atom.write), sql: atom.sql };
    if (REASON_FILTER === "SQL_MISMATCH") {
      const div = firstDivergence(r.got, r.want);
      row.got = r.got;
      row.want = r.want;
      row.divergence = div;
      row.clusterKey = div ? clusterKey(div) : "<identical?>";
    } else {
      row.detail = r.detail;
      row.clusterKey = (r.detail ?? "").split("\n")[0].replace(/'[^']*'/g, "'…'").slice(0, 80);
    }
    rows.push(row);
  }

  const clusters = new Map();
  for (const row of rows) {
    if (!clusters.has(row.clusterKey)) clusters.set(row.clusterKey, []);
    clusters.get(row.clusterKey).push(row);
  }
  const ranked = [...clusters.entries()].sort((a, b) => b[1].length - a[1].length);

  console.log(`\n  ${rows.length} ${REASON_FILTER} rows${WRITE_FILTER ? ` (write=${WRITE_FILTER})` : ""}${INCLUDE_ALL ? "" : " [already-ported dialects only]"}`);
  console.log(`  ${ranked.length} clusters\n`);
  for (const [key, members] of ranked.slice(0, TOP_N)) {
    console.log(`  ${String(members.length).padStart(4)}  ${key}`);
    console.log(`         e.g. ${members[0].atom_id}  ${members[0].read}->${members[0].write}  ${JSON.stringify(members[0].sql).slice(0, 90)}`);
  }
  if (ranked.length > TOP_N) console.log(`  ... (${ranked.length - TOP_N} more clusters)`);

  if (DUMP_PATH) {
    writeFileSync(DUMP_PATH, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.log(`\n  wrote ${rows.length} detailed rows to ${DUMP_PATH}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith("mismatch_report.mjs")) {
  main().catch((error) => { console.error(error.stack); process.exitCode = 2; });
}
