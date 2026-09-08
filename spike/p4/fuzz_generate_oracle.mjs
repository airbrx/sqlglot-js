// The generate oracle, run for real: parse a corpus row, generate it back out with the
// PORT's generator, and diff byte-for-byte against CPython's recorded output.
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
//   MISMATCH   generated, but differs  <- the only bucket that fails the build
//   STUB       hit a NotPorted stub — the next round's work, counted not hidden
//   ERROR      any other throw      <- also fails; a stub must announce itself
//   PARSE      the PORT's parser could not read the row at all (not a generator defect)
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
// SCOPE, stated rather than left implicit. The port registers no dialect but the base
// one — `src/dialects/` holds `dialect.js` alone, and named registration is P5 — so
// `Dialect.get_or_raise("snowflake")` throws. Rows naming a dialect are counted as
// SKIPPED (dialect unavailable), never silently generated with base settings, which
// would compare the wrong thing and could only produce noise. That is also why the
// generator is constructed directly here rather than through `Dialect.generate`:
// `Dialect.generator_class` is unset, and wiring it is a change to a P5-owned file.

import { readFileSync, readdirSync } from "node:fs";
import { Dialect } from "../../src/dialects/dialect.js";
import { Generator } from "../../src/generator.js";
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

const tot = { exact: 0, mismatch: 0, stub: 0, error: 0, parse: 0, skipped: 0 };
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
    if (!atom) continue;
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

    // Parse and generate are separated so a PARSER gap cannot be reported as a generator
    // defect. The generator's own buckets have to mean what they say.
    let ast;
    try {
      const { result } = captureLogs(() => readDialect.parse(atom.sql));
      // py: `Dialect.generate` joins multiple statements with "; ". Asserted rather than
      // assumed: a multi-statement row would silently compare only the first.
      if (result.length !== 1) throw new Error(`multi-statement row (${result.length})`);
      ast = result[0];
    } catch (e) {
      tot.parse += 1;
      if (errors.length < 40) {
        errors.push(`PARSE ${row.atom_id} [${atom.read || "(default)"}] ${e.name}: ${e.message.split("\n")[0].slice(0, 100)}`);
      }
      if (predicted.has(row.atom_id)) {
        overclaimed.push({ id: row.atom_id, why: `PARSE ${e.name}` });
      }
      continue;
    }

    let got;
    try {
      const { result } = captureLogs(() => {
        const generator = new Generator({
          dialect: writeDialect,
          pretty: row.flags.pretty,
          identify: row.flags.identify,
        });
        return generator.generate(ast);
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

    if (got === row.sql) {
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

const seen = tot.exact + tot.mismatch + tot.stub + tot.error + tot.parse;
console.log(`\n  generate oracle over ${seen} reachable rows (${tot.skipped} skipped: dialect not registered)`);
console.log(`    EXACT     ${String(tot.exact).padStart(6)}  (generated and byte-identical)`);
console.log(`    MISMATCH  ${String(tot.mismatch).padStart(6)}  <- must be 0`);
console.log(`    STUB      ${String(tot.stub).padStart(6)}  (NotPorted, or an unwired TRANSFORMS entry)`);
console.log(`    ERROR     ${String(tot.error).padStart(6)}  <- must be 0`);
console.log(`    PARSE     ${String(tot.parse).padStart(6)}  (the port's PARSER could not read the row; not a generator defect)`);

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
