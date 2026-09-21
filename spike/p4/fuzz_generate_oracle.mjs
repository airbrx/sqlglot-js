// Base generate oracle: load the pinned AST, generate with the PORT, and
// compare SQL plus warnings against CPython. End-to-end parsing is gated separately.
//
//   node spike/p4/fuzz_generate_oracle.mjs
//   node spike/p4/fuzz_generate_oracle.mjs --verbose
//   node spike/p4/fuzz_generate_oracle.mjs --predicted   # only the rows closure claims
//
// This is the generator's counterpart to spike/p3/fuzz_ast_coverage.mjs, and the first
// check in this project that actually compares generated SQL against the oracle. Rows go
// into the same four buckets, for the same reason:
//
//   EXACT      generated, and byte-identical to corpus/gen's `sql`
//   MISMATCH   generated SQL or warnings differ  <- fails the build
//   STUB       hit a NotPorted stub — the next round's work, counted not hidden
//   ERROR      any other throw      <- also fails; a stub must announce itself
//
// A run where STUB is large and MISMATCH is zero is the expected state of a blocking
// step, and the numbers say so out loud rather than being rounded to "green".
//
// ONE CLASSIFICATION THAT IS NOT OBVIOUS, and is the R14/R17/R19 family again. An
// unported `TRANSFORMS` entry does NOT surface as `NotPorted`: `sql()` finds no handler,
// falls through to its last `else`, and raises `PyValueError: Unsupported expression type
// Union` — which is byte-for-byte the error upstream raises when it genuinely has no
// handler. The two are indistinguishable from the exception alone, so a naive probe
// reports "5 ERROR, must be 0" for what is really "3 announced-but-unannounceable stubs".
// The demand trace disambiguates them exactly: if the row's own unit set contains
// `TRANSFORMS[Union]` then upstream DID have a handler and the port simply has not wired
// it, which is a STUB. This is decided from the oracle's recorded demand, never guessed.
//
// WHY IT ALSO CHECKS THE CLOSURE TOOL. `tools/closure_generator.mjs` predicts which rows
// are closeable from the demand trace. That prediction is a claim about DEMAND, not about
// correctness, and R13 is the standing lesson that a closure number and an honest probe
// can disagree completely — closure_parser.mjs once read 93.99% while the honest probe
// showed EXACT unchanged. So this probe cross-checks the two directly and FAILS if the
// tool over-claims: every row closure says is closed must actually come out EXACT. That
// check found its first defect before this file was committed (the tool ignored whether
// the port could resolve a row's dialect at all, and over-claimed 1,002 rows).
//
// LEGACY BASE-ONLY DEMAND DIAGNOSTIC, not the production dialect gate.
// This deliberately imports only the base registration. Its 15,315 excluded
// named-dialect rows are ALL evaluated by p5/fuzz_dialect_generate.mjs instead.
// The independent production corpus ratchet checks parse + generate + warnings.
// Demand is generation-only; use the recorded AST, not parser reachability.

import { readFileSync, readdirSync } from "node:fs";
import { Dialect } from "../../src/dialects/dialect.js";
import { Generator } from "../../src/generator.js";
import { astLoad } from "../../src/expressions/index.js";
import { ErrorLevel } from "../../src/errors.js";
import { captureLogs } from "../../src/logging.js";

const argv = process.argv.slice(2);
const VERBOSE = argv.includes("--verbose");
const PREDICTED_ONLY = argv.includes("--predicted");

const atoms = new Map();
for (const line of readFileSync("corpus/atoms.jsonl", "utf8").split("\n")) {
  if (!line) continue;
  const a = JSON.parse(line);
  atoms.set(a.atom_id, a);
}

const asts = new Map();
for (const file of readdirSync("corpus/ast").filter(f => f.endsWith(".jsonl"))) {
  for (const line of readFileSync(`corpus/ast/${file}`, "utf8").split("\n").filter(Boolean)) {
    const row = JSON.parse(line);
    if (asts.has(row.atom_id)) throw new Error(`Duplicate AST reference: ${row.atom_id}`);
    asts.set(row.atom_id, row.ast);
  }
}
if (!atoms.size || !asts.size) throw new Error("Empty oracle population");

const demand = JSON.parse(readFileSync("corpus/generate_demand.json", "utf8"));
const DEMAND_UNITS = demand.units;
/** The unit set the oracle recorded for a row, rehydrated on demand. */
function unitsFor(id) {
  const ix = demand.per_row[id];
  return ix ? ix.map((i) => DEMAND_UNITS[i]) : [];
}

/** Rows `tools/closure_generator.mjs` predicts are closeable, by the same rules. */
function predictedClosed() {
  const UNITS = demand.units;
  const lines = readFileSync("src/generator.js", "utf8").split("\n");
  const impl = new Set();
  const stubs = new Set();
  for (const line of lines) {
    const m = line.match(/^ {2}([A-Za-z_$][\w$]*)\s*\(/);
    if (!m) continue;
    (/throw new NotPorted/.test(line) ? stubs : impl).add(m[1]);
  }
  for (const name of impl) stubs.delete(name);

  const have = new Set();
  for (const u of UNITS) {
    // Mirrors haveSet() in the tool: only base methods are satisfiable today. Dialect
    // units, transforms.py units and dialect: preconditions are all unavailable, and
    // TRANSFORMS is an empty Map.
    if (!u.includes(".") && !u.startsWith("TRANSFORMS[") && !u.startsWith("dialect:")) {
      if (impl.has(u)) have.add(u);
    }
  }
  const closed = new Set();
  for (const [id, ix] of Object.entries(demand.per_row)) {
    if (ix.every((i) => have.has(UNITS[i]))) closed.add(id);
  }
  return closed;
}

const predicted = predictedClosed();

/** A resolved Dialect per name, or null when the port cannot resolve it. */
const dialectCache = new Map();
function dialectFor(name) {
  if (!dialectCache.has(name)) {
    let d = null;
    try {
      d = Dialect.get_or_raise(name || null);
    } catch {
      d = null;
    }
    dialectCache.set(name, d);
  }
  return dialectCache.get(name);
}

const tot = { exact: 0, mismatch: 0, stub: 0, error: 0, skipped: 0 };
const mismatches = [];
const errors = [];
const stubCounts = new Map();
/** Rows closure PREDICTED closed that did not come out EXACT — the over-claim. */
const overclaimed = [];

for (const name of readdirSync("corpus/gen")) {
  if (!name.endsWith(".jsonl")) continue;
  for (const line of readFileSync(`corpus/gen/${name}`, "utf8").split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line);
    const atom = atoms.get(row.ast_ref);
    if (!atom) throw new Error(`Missing atom reference: ${row.atom_id}`);
    if (PREDICTED_ONLY && !predicted.has(row.atom_id)) continue;

    const readDialect = dialectFor(atom.read);
    const writeDialect = dialectFor(atom.write);
    if (!readDialect || !writeDialect) {
      tot.skipped += 1;
      // A row closure predicted closed must not be unverifiable: that is the tool
      // claiming a row it cannot reach, which is exactly what this cross-check is for.
      if (predicted.has(row.atom_id)) {
        overclaimed.push({ id: row.atom_id, why: `dialect unavailable (${atom.read}->${atom.write})` });
      }
      continue;
    }

    // Demand was harvested from GENERATION. Feed the recorded AST instead of
    // accidentally testing parser reachability and calling that a closure defect.
    if (!asts.has(row.ast_ref)) throw new Error(`Missing AST reference: ${row.ast_ref}`);
    const ast = astLoad(asts.get(row.ast_ref));

    let got;
    let warnings;
    try {
      const { result } = captureLogs(() => {
        const generator = new Generator({
          dialect: writeDialect,
          unsupported_level: ErrorLevel.IGNORE,
          pretty: row.flags.pretty,
          identify: row.flags.identify,
        });
        const sql = generator.generate(ast);
        warnings = generator.unsupported_messages;
        return sql;
      });
      got = result;
    } catch (e) {
      // An unwired TRANSFORMS entry cannot throw NotPorted — see the header. Recover the
      // distinction from the row's recorded demand rather than from the message alone.
      const unsupported = /^Unsupported expression type (\w+)$/.exec(e.message || "");
      const asTransform = unsupported ? `TRANSFORMS[${unsupported[1]}]` : null;
      const isUnwiredEntry = asTransform !== null && unitsFor(row.atom_id).includes(asTransform);

      if (e.name === "NotPorted" || isUnwiredEntry) {
        const what = e.name === "NotPorted" ? e.method : asTransform;
        tot.stub += 1;
        stubCounts.set(what, (stubCounts.get(what) || 0) + 1);
        if (predicted.has(row.atom_id)) {
          overclaimed.push({ id: row.atom_id, why: `STUB ${what}` });
        }
      } else {
        tot.error += 1;
        if (errors.length < 40) {
          errors.push(`${row.atom_id} [${atom.write || "(default)"}] ${e.name}: ${e.message.split("\n")[0].slice(0, 120)}`);
        }
        if (predicted.has(row.atom_id)) {
          overclaimed.push({ id: row.atom_id, why: `${e.name}: ${e.message.slice(0, 60)}` });
        }
      }
      continue;
    }

    if (got === row.sql && JSON.stringify(warnings) === JSON.stringify(row.unsupported_messages)) {
      tot.exact += 1;
    } else {
      tot.mismatch += 1;
      if (mismatches.length < 40) {
        mismatches.push({ id: row.atom_id, dialect: atom.write, in: atom.sql, got, want: row.sql });
      }
      if (predicted.has(row.atom_id)) {
        overclaimed.push({ id: row.atom_id, why: `MISMATCH got ${JSON.stringify(got).slice(0, 60)}` });
      }
    }
  }
}

const seen = tot.exact + tot.mismatch + tot.stub + tot.error;
console.log(`\n  generate oracle over ${seen} reachable rows (${tot.skipped} skipped: dialect not registered)`);
console.log(`    EXACT     ${String(tot.exact).padStart(6)}  (generated and byte-identical)`);
console.log(`    MISMATCH  ${String(tot.mismatch).padStart(6)}  <- must be 0`);
console.log(`    STUB      ${String(tot.stub).padStart(6)}  (NotPorted, or an unwired TRANSFORMS entry)`);
console.log(`    ERROR     ${String(tot.error).padStart(6)}  <- must be 0`);

console.log(`\n  closure cross-check (R13: a closure number is not a probe)`);
console.log(`    rows tools/closure_generator.mjs predicts closed  ${predicted.size}`);
console.log(`    of those, NOT exact here                          ${overclaimed.length}  <- must be 0`);
if (overclaimed.length) {
  const why = new Map();
  for (const o of overclaimed) {
    const k = o.why.replace(/\(.*/, "").slice(0, 40);
    why.set(k, (why.get(k) || 0) + 1);
  }
  for (const [k, c] of [...why].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`      ${String(c).padStart(6)}  ${k}`);
  }
}

if (VERBOSE && stubCounts.size) {
  console.log(`\n  top stubs:`);
  for (const [m, c] of [...stubCounts].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`    ${String(c).padStart(6)}  ${m}`);
  }
}
if (VERBOSE) {
  for (const m of mismatches.slice(0, 12)) {
    console.log(`\n  MISMATCH ${m.id} [${m.dialect || "(default)"}]`);
    console.log(`    in   ${m.in}`);
    console.log(`    got  ${JSON.stringify(m.got)}`);
    console.log(`    want ${JSON.stringify(m.want)}`);
  }
  for (const e of errors.slice(0, 12)) console.log(`  ERROR ${e}`);
}

const bad = tot.mismatch + tot.error + overclaimed.length;
console.log(
  bad === 0
    ? `\n  GENERATE ORACLE: green (${tot.exact} exact, ${tot.stub} announced stubs)\n`
    : `\n  GENERATE ORACLE: RED (${tot.mismatch} mismatch, ${tot.error} error, ${overclaimed.length} over-claimed)\n`,
);
process.exit(bad === 0 ? 0 : 1);
