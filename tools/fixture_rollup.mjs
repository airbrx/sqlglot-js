#!/usr/bin/env node
// AIR-2295 ("13.3 Roll up the optimizer fixture-pair count", epic AIR-2273): produce
// the single honest number AIR-1864 promised and never measured -- "3,476 optimizer
// fixture pairs green (201 `# execute: true` permanently wontfix)" -- against every
// real fixture file under `tests/fixtures/optimizer/` at the pin.
//
//   node tools/fixture_rollup.mjs                # table + totals, human-readable
//   node tools/fixture_rollup.mjs --markdown      # same table, ready to paste into docs
//   SQLGLOT_REF=/tmp/sqlglot-complete-pin node tools/fixture_rollup.mjs
//
// WHAT THIS DOES NOT DO: regenerate `spike/out/*.json`. Those are produced by the slow
// (multi-minute, Python-driven) `gen_*_ref.py` half of each oracle; this script only
// re-runs the fast Node `fuzz_*.mjs` half and parses its printed counters, which is why
// it can stay under the run_all.sh informational-line budget (§ "registration" below).
// If a required `spike/out/*.json` is missing or stale, run `bash spike/run_all.sh`
// (or the individual `gen_*_ref.py`) first -- this script reports MISSING, it does not
// regenerate or fail the whole rollup for one absent file.
//
// THE TWO COUNTING SURPRISES THIS FILE EXISTS TO MAKE VISIBLE (both found by actually
// reading `tests/helpers.py` and `tests/test_optimizer.py` at the pin, not by trusting
// the PORT_PLAN.md prose that quoted "3,476" / "201"):
//
// 1. "Pairs" are plain positional (statement, statement) groups from `_filter_comments`
//    + `.split(";")` -- NOT one grouping per `# title:` meta block. A pair with no
//    meta at all is still one pair; several `# dialect:`/`# title:` lines can precede
//    a single pair without changing the count.
// 2. The "# execute: true" framing in PORT_PLAN.md does not match the fixtures: the
//    committed corpus has 200 "# execute: false" lines and exactly ONE literal
//    "# execute: true" (irrelevant -- see below). The REAL mechanism
//    (`tests/test_optimizer.py:224`, `check_file`): `execute if meta.get("execute")
//    is None else False`. A pair's own `execute` DATA VALUE is never read -- the mere
//    PRESENCE of an `execute` meta key forces execute=False for that one pair,
//    regardless of its value. And `execute` only does anything at all in the 3 files
//    whose `check_file(...)` call site itself passes `execute=True`
//    (`optimizer.sql`, `qualify_columns.sql`, `merge_subqueries.sql` --
//    `test_optimizer.py:267`/`777`/`1571`); every other file's per-pair "# execute:
//    false" annotations are inert, since `execute=False` is already `check_file`'s own
//    default. The real wontfix population is "pairs in those 3 files with NO `execute`
//    meta key at all" -- 259 pairs, not 201.

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REF = process.env.SQLGLOT_REF || "/tmp/sqlglot-ref";
const MARKDOWN = process.argv.includes("--markdown");

// --- A faithful JS port of tests/helpers.py's load_sql_fixture_pairs/load_sql_fixtures,
// so the pair count is computed the SAME way upstream's own test loader computes it,
// not re-derived by a different (and possibly subtly different) rule. ---

function filterComments(s) {
  return s
    .split("\n")
    .filter((line) => line && !line.startsWith("--"))
    .join("\n");
}

function extractMeta(sql) {
  const meta = {};
  const lines = sql.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].startsWith("#")) {
    const idx = lines[i].indexOf(":");
    const key = lines[i].slice(0, idx).replace(/^#+/, "").trim();
    const val = lines[i].slice(idx + 1).trim();
    meta[key] = val;
    i++;
  }
  return { sql: lines.slice(i).join("\n"), meta };
}

function loadSqlFixturePairs(path) {
  const statements = filterComments(readFileSync(path, "utf8")).split(";");
  const size = statements.length;
  const out = [];
  for (let i = 0; i < size; i += 2) {
    if (i + 1 < size) {
      const { sql, meta } = extractMeta(statements[i].trim());
      out.push({ meta, sql, expected: statements[i + 1].trim() });
    }
  }
  return out;
}

function loadSqlFixtureLines(path) {
  return filterComments(readFileSync(path, "utf8"))
    .split("\n")
    .filter((l) => l.length > 0);
}

// --- The manifest: every file tests/test_optimizer.py actually loads (verified by
// reading every `load_sql_fixture_pairs("optimizer/...")` / `load_sql_fixtures(...)`
// call site and every `self.check_file(...)` call site at the pin), mapped to whichever
// spike/p7 or spike/p10 oracle REPLAYS that literal fixture file (grepped for the exact
// `tests/fixtures/optimizer/<file>` path string, not a name substring -- a fuzz_*.mjs
// file NAMED after a fixture does not necessarily load it; see notes). `oracle: null`
// means no oracle anywhere in this repo opens that file.
//
// `group` is the exact label this script's own breakdown-line edits print in a
// multi-fixture oracle (fuzz_qualify.mjs, fuzz_optimize_e2e.mjs); `line` is the regex
// used against a single-fixture oracle's one aggregate line when no breakdown exists.
const MANIFEST = [
  {
    file: "annotate_functions.sql", kind: "pairs",
    oracle: "spike/p7/fuzz_annotate_functions.mjs", mode: "line",
    extra: 464, extraNote: "oracle's own record count (2,396) is pair x `# dialect:` meta fan-out, not pairs -- 464 more records than the 1,932 pairs themselves (AIR-2315 Part 1); EXACT below counts records, not pairs",
  },
  {
    file: "annotate_types.sql", kind: "pairs",
    oracle: "spike/p7/fuzz_fixture_replay.mjs", mode: "group", group: "annotate_types.sql",
    notes: "AIR-2315 Part 3. The 6 spike/p7 `fuzz_annotate_types*.mjs`/`gen_annotate_types*_ref.py` files are named after the same TypeAnnotator surface but ship their own independent, hand-written corpora; this is the sibling oracle that replays the real fixture file, via `test_annotate_types`'s own driver (type-string compare, no schema), not `check_file`.",
  },
  {
    file: "canonicalize.sql", kind: "pairs",
    oracle: "spike/p10/fuzz_canonicalize.mjs", mode: "line",
    extra: 11, extraNote: "oracle adds 11 own hand-written scenarios beyond the 42 fixture pairs (tsql-concat, datediff-no-annotate, 3 ORDER BY shapes, 6 COERCIBLE_DATE_OPS shapes) -- EXACT/SKIPPED below cover all 53, not 42 alone",
  },
  {
    file: "canonicalize_internal_names.sql", kind: "pairs",
    oracle: "spike/p7/fuzz_fixture_replay.mjs", mode: "group", group: "canonicalize_internal_names.sql",
    notes: "AIR-2315 Part 3. `src/optimizer/canonicalize_internal_names.js` did not exist at all before this round -- see that file's own header for why.",
  },
  {
    file: "eliminate_ctes.sql", kind: "pairs",
    oracle: "spike/p7/fuzz_fixture_replay.mjs", mode: "group", group: "eliminate_ctes.sql",
    notes: "AIR-2315 Part 3. `spike/p7/fuzz_eliminate_ctes.mjs` is still a greenfield hand-built battery (own docstring, stays as a sibling) -- this is the sibling oracle that replays the real fixture file via its own `self.check_file(\"eliminate_ctes\", ..., pretty=True)` call.",
  },
  {
    file: "eliminate_joins.sql", kind: "pairs",
    oracle: "spike/p10/fuzz_eliminate_joins.mjs", mode: "line",
    extra: 7, extraNote: "oracle adds 7 own `join_condition` branch-coverage scenarios beyond the 18 fixture pairs -- EXACT below covers all 25, not 18 alone",
  },
  {
    file: "eliminate_subqueries.sql", kind: "pairs",
    oracle: "spike/p7/fuzz_fixture_replay.mjs", mode: "group", group: "eliminate_subqueries.sql",
    notes: "AIR-2315 Part 3. `spike/p7/fuzz_eliminate_subqueries.mjs` is still a greenfield hand-built battery (own docstring, stays as a sibling) -- this is the sibling oracle that replays the real fixture file.",
  },
  {
    file: "isolate_table_selects.sql", kind: "pairs",
    oracle: "spike/p7/fuzz_fixture_replay.mjs", mode: "group", group: "isolate_table_selects.sql",
    notes: "AIR-2315 Part 3. `spike/p7/fuzz_isolate_table_selects.mjs` is still a greenfield hand-built battery (own docstring, stays as a sibling) -- this is the sibling oracle that replays the real fixture file.",
  },
  {
    file: "merge_subqueries.sql", kind: "pairs",
    oracle: "spike/p10/fuzz_optimize_e2e.mjs", mode: "group", group: "merge_subqueries.sql",
    executeDefaultTrue: true,
    notes: "replayed by the Track-2 end-to-end gate (AIR-2119), not by `spike/p7/fuzz_merge_subqueries.mjs` (hand-built, does not load this file).",
  },
  {
    file: "normalize.sql", kind: "pairs",
    oracle: "spike/p10/fuzz_normalize.mjs", mode: "line",
    extra: 6, extraNote: "oracle adds 3 inline `test_normalize` assertions + 3 `test_normalization_distance` scenarios beyond the 17 fixture pairs -- EXACT below covers all 23, not 17 alone",
  },
  {
    file: "normalize_identifiers.sql", kind: "pairs",
    oracle: "spike/p7/fuzz_fixture_replay.mjs", mode: "group", group: "normalize_identifiers.sql",
    notes: "AIR-2315 Part 3.",
  },
  {
    file: "optimize_joins.sql", kind: "pairs",
    oracle: "spike/p7/fuzz_fixture_replay.mjs", mode: "group", group: "optimize_joins.sql",
    notes: "AIR-2315 Part 3. `spike/p7/fuzz_optimize_joins.mjs` still ships its own 28-row hand-written corpus (per PORT_PLAN.md R45, stays as a sibling) -- this is the sibling oracle that replays the real 18-pair fixture file.",
  },
  {
    file: "optimizer.sql", kind: "pairs",
    oracle: "spike/p10/fuzz_optimizer.mjs", mode: "line",
    extra: 1, extraNote: "oracle adds 1 inline `test_optimize` assertion beyond the 82 fixture pairs -- EXACT/GAP/SKIPPED below cover all 83, not 82 alone",
    executeDefaultTrue: true,
  },
  {
    file: "pushdown_cte_alias_columns.sql", kind: "pairs",
    oracle: "spike/p7/fuzz_fixture_replay.mjs", mode: "group", group: "pushdown_cte_alias_columns.sql",
    notes: "AIR-2315 Part 3.",
  },
  {
    file: "pushdown_predicates.sql", kind: "pairs",
    oracle: "spike/p10/fuzz_pushdown_predicates.mjs", mode: "line",
  },
  {
    file: "pushdown_projections.sql", kind: "pairs",
    oracle: "spike/p10/fuzz_pushdown_projections.mjs", mode: "line",
  },
  {
    file: "qualify_columns.sql", kind: "pairs",
    oracle: "spike/p10/fuzz_qualify.mjs", mode: "group", group: "qualify_columns.sql",
    executeDefaultTrue: true,
  },
  {
    file: "qualify_columns__invalid.sql", kind: "lines",
    oracle: "spike/p10/fuzz_qualify.mjs", mode: "group", group: "qualify_columns__invalid.sql",
    extra: 1, extraNote: "oracle adds 1 own resolver-get-table-fallback scenario (test_optimizer.py:1184-1209) beyond the 20 fixture lines",
  },
  {
    file: "qualify_columns__with_invisible.sql", kind: "pairs",
    oracle: "spike/p10/fuzz_qualify.mjs", mode: "group", group: "qualify_columns__with_invisible.sql",
  },
  {
    file: "qualify_columns_ddl.sql", kind: "pairs",
    oracle: "spike/p10/fuzz_qualify.mjs", mode: "group", group: "qualify_columns_ddl.sql",
  },
  {
    file: "qualify_tables.sql", kind: "pairs",
    oracle: "spike/p10/fuzz_qualify.mjs", mode: "group", group: "qualify_tables.sql",
    notes: "replayed by `fuzz_qualify.mjs`'s own `run_qualify_tables_fixture`, not by `spike/p7/fuzz_qualify_tables.mjs` (hand-built, does not load this file).",
  },
  {
    file: "quote_identifiers.sql", kind: "pairs",
    oracle: "spike/p7/fuzz_fixture_replay.mjs", mode: "group", group: "quote_identifiers.sql",
    notes: "AIR-2315 Part 3.",
  },
  {
    file: "simplify.sql", kind: "pairs",
    oracle: "spike/p7/fuzz_simplify_fixture.mjs", mode: "line",
    notes: "AIR-2315 Part 2. `spike/p7/fuzz_simplify.mjs` is still a hand-built Simplifier battery (own docstring, 81 scenarios, stays as a sibling) -- this is the sibling oracle that replays the real 521-pair fixture file.",
  },
  {
    file: "tpc-h/tpc-h.sql", kind: "pairs",
    oracle: "spike/p10/fuzz_optimize_e2e.mjs", mode: "group", group: "tpc-h/tpc-h.sql",
  },
  {
    file: "tpc-ds/tpc-ds.sql", kind: "pairs",
    oracle: "spike/p10/fuzz_optimize_e2e.mjs", mode: "group", group: "tpc-ds/tpc-ds.sql",
  },
  {
    file: "unnest_subqueries.sql", kind: "pairs",
    oracle: "spike/p7/fuzz_fixture_replay.mjs", mode: "group", group: "unnest_subqueries.sql",
    notes: "AIR-2315 Part 3. `spike/p7/fuzz_unnest_subqueries.mjs` is still greenfield (own docstring, stays as a sibling) -- this is the sibling oracle that replays the real fixture file.",
  },
];

// File-level `check_file(..., execute=True, ...)` call sites (test_optimizer.py:267,
// 777, 1571) -- the ONLY 3 files where a pair's `execute` meta key does anything.
const EXECUTE_TRUE_FILES = new Set(["optimizer.sql", "qualify_columns.sql", "merge_subqueries.sql"]);

function fixturePairStats(file) {
  const path = join(REF, "tests/fixtures/optimizer", file);
  if (!existsSync(path)) return { missing: true };
  const pairs = loadSqlFixturePairs(path);
  let wontfix = 0;
  if (EXECUTE_TRUE_FILES.has(file)) {
    for (const p of pairs) if (p.meta.execute === undefined) wontfix++;
  }
  return { count: pairs.length, wontfix };
}

function fixtureLineStats(file) {
  const path = join(REF, "tests/fixtures/optimizer", file);
  if (!existsSync(path)) return { missing: true };
  return { count: loadSqlFixtureLines(path).length, wontfix: 0 };
}

const oracleOutputCache = new Map();
function runOracle(relPath) {
  if (oracleOutputCache.has(relPath)) return oracleOutputCache.get(relPath);
  let out;
  try {
    out = execFileSync("node", [relPath], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    // fuzz_*.mjs exits non-zero on any MISMATCH/ERROR -- stdout is still the report.
    out = (e.stdout || "") + (e.stderr || "");
    if (!existsSync(join(ROOT, "spike/out", inferRefJson(relPath)))) {
      out = null; // genuinely missing ref JSON, not just a red probe
    }
  }
  oracleOutputCache.set(relPath, out);
  return out;
}

function inferRefJson(relPath) {
  // spike/p10/fuzz_qualify.mjs -> qualify.json, spike/p10/fuzz_optimize_e2e.mjs -> optimize_e2e.json, etc.
  const base = relPath.split("/").pop().replace(/^fuzz_/, "").replace(/\.mjs$/, "");
  return `${base}.json`;
}

function parseCounters(line) {
  const out = {};
  for (const m of line.matchAll(/([A-Z_]+)\s+(-?\d+)/g)) out[m[1]] = Number(m[2]);
  return out;
}

function aggregateFromLine(out) {
  if (out === null) return { missing: true };
  const line = out.split("\n").find((l) => /EXACT\s+\d+/.test(l));
  if (!line) return { missing: true };
  return { counters: parseCounters(line) };
}

function aggregateFromGroup(out, group) {
  if (out === null) return { missing: true };
  const needle = `      ${group}`;
  const line = out.split("\n").find((l) => l.startsWith(needle) && /EXACT\s+\d+/.test(l));
  if (!line) return { missing: true };
  return { counters: parseCounters(line) };
}

function fmtCounters(c) {
  const order = ["EXACT", "GENERATOR_GAP", "KNOWN_GAP", "MISMATCH", "ERROR", "SKIPPED"];
  return order.filter((k) => k in c).map((k) => `${k} ${c[k]}`).join("  ");
}

const rows = [];
let totalPairs = 0;
let totalWontfix = 0;
let totalNoOracle = 0;
let totalExact = 0;

for (const m of MANIFEST) {
  const stats = m.kind === "pairs" ? fixturePairStats(m.file) : fixtureLineStats(m.file);
  if (stats.missing) {
    rows.push({ ...m, count: "MISSING", wontfix: 0, oracleResult: null });
    continue;
  }
  totalPairs += m.kind === "pairs" ? stats.count : 0; // lines (qualify_columns__invalid) are NOT part of the pair model
  totalWontfix += stats.wontfix;

  let oracleResult = null;
  if (m.oracle) {
    const out = runOracle(m.oracle);
    oracleResult = m.mode === "group" ? aggregateFromGroup(out, m.group) : aggregateFromLine(out);
  } else {
    totalNoOracle += m.kind === "pairs" ? stats.count : 0;
  }
  if (oracleResult && oracleResult.counters) totalExact += oracleResult.counters.EXACT || 0;

  rows.push({ ...m, count: stats.count, wontfix: stats.wontfix, oracleResult });
}

// --- Track 2 / fuzz_optimizer.mjs rollups the task also asks for: both are already
// fully represented above (optimizer.sql IS fuzz_optimizer.mjs's own fixture; the 4
// fixture groups + ad-hoc rows of fuzz_optimize_e2e.mjs ARE the Track-2 gate), so no
// separate table section is needed -- just surface the e2e oracle's own "ad-hoc" rows
// (no named fixture file; part of the Track-2 gate, not the pair model) for completeness.
let adHocE2e = null;
{
  const out = runOracle("spike/p10/fuzz_optimize_e2e.mjs");
  adHocE2e = aggregateFromGroup(out, "ad-hoc (no named fixture file)");
}

function printTable() {
  const lines = [];
  if (MARKDOWN) {
    lines.push("| fixture file | pairs | replayed by | result | wontfix (execute) | notes |");
    lines.push("|---|---|---|---|---|---|");
  }
  for (const r of rows) {
    const replay = r.oracle ? r.oracle : MARKDOWN ? "**none**" : "none";
    let result = "—";
    if (r.oracle) {
      if (!r.oracleResult || r.oracleResult.missing) result = "MISSING spike/out ref JSON";
      else result = fmtCounters(r.oracleResult.counters);
    }
    const extraNote = r.extra ? r.extraNote : "";
    const note = [r.notes, extraNote].filter(Boolean).join(" ");
    if (MARKDOWN) {
      lines.push(`| \`${r.file}\` | ${r.count} | ${replay} | ${result} | ${r.wontfix || 0} | ${note.replace(/\|/g, "\\|")} |`);
    } else {
      lines.push(`  ${r.file.padEnd(36)} pairs=${String(r.count).padEnd(6)} wontfix=${String(r.wontfix).padEnd(4)} replayed_by=${replay}`);
      if (result !== "—") lines.push(`    ${result}`);
      if (note) lines.push(`    note: ${note}`);
    }
  }
  return lines.join("\n");
}

const totalReplayed = totalPairs - totalNoOracle;

console.log(printTable());
console.log();
console.log(`total upstream pairs enumerated (24 pair files; qualify_columns__invalid.sql's 20 lines counted separately, not here): ${totalPairs}`);
console.log(`of which are replayed by SOME oracle in spike/p7 or spike/p10: ${totalReplayed}`);
console.log(`of which have NO oracle anywhere in this repo that replays the real fixture file: ${totalNoOracle}`);
console.log(`of which are permanently wontfix (execute, the 3 file-level execute=True files, no "execute" meta key present): ${totalWontfix}`);
console.log(`sum of EXACT across every mapped oracle's own breakdown/aggregate (each oracle's own extra non-fixture rows are included where the oracle does not separate them -- see per-file notes above): ${totalExact}`);
if (adHocE2e && adHocE2e.counters) {
  console.log(`spike/p10/fuzz_optimize_e2e.mjs "ad-hoc" rows (Track-2 gate, no named fixture file): ${fmtCounters(adHocE2e.counters)}`);
}
console.log();
console.log(
  `${totalReplayed} of ${totalPairs} optimizer fixture pairs at this pin are replayed by an oracle ` +
  `today (EXACT count above, some inflated by each oracle's own documented extra non-fixture rows); ` +
  `${totalWontfix} are permanently wontfix (execute); ${totalNoOracle} have no oracle at all. ` +
  `PORT_PLAN.md/AIR-1864's own figure -- "3,476 optimizer fixture pairs ... the 201 ` +
  `\`# execute: true\` execution assertions are wontfix" -- is WRONG on both numbers at this pin: ` +
  `the real total is ${totalPairs} pairs (not 3,476), and the real wontfix population is ` +
  `${totalWontfix} (not 201), because PORT_PLAN.md's "# execute: true" framing does not match how ` +
  `tests/test_optimizer.py:check_file actually reads the \`execute\` meta key (see this file's own ` +
  `header for the mechanism).`,
);
