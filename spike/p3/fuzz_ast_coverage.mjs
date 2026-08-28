// PORT_PLAN.md §7 P3 exit: "AST oracle exact match — including `meta` line/col/start/end
// — on 100% of Snowflake identity + read SQLs" *that the implemented subset can parse*.
//
//   node spike/p3/fuzz_ast_coverage.mjs
//   node spike/p3/fuzz_ast_coverage.mjs --dialect snowflake --verbose
//
// This is the HONEST-SCOPE probe. At P3's blocking step most `_parse_*` are still stubs,
// so the criterion cannot mean "every Snowflake SQL parses" — it means every SQL the
// implemented subset reaches must be byte-exact, INCLUDING `meta`, with no silent
// near-misses. Rows are therefore classified into four buckets and all four are
// printed:
//
//   EXACT      parsed, and astDump deep-equals the oracle (meta included)
//   MISMATCH   parsed, but differs  <- the only bucket that fails the build
//   STUB       hit a NotPorted stub — the next round's work, counted not hidden
//   ERROR      any other throw      <- also fails; a stub must announce itself
//
// A run where STUB is large and MISMATCH is zero is exactly the expected state of a
// blocking step, and the numbers say so out loud instead of being rounded to "green".

import { readFileSync, readdirSync } from "node:fs";
import { astDump, astLoad, toS } from "../../src/expressions/index.js";
import { Parser } from "../../src/parser.js";
import { tokenizerFor, METHOD_OVERRIDING } from "./dialect_tokenizer.mjs";
import { captureLogs } from "../../src/logging.js";

const argv = process.argv.slice(2);
const ONLY = argv.includes("--dialect") ? argv[argv.indexOf("--dialect") + 1] : null;
const VERBOSE = argv.includes("--verbose");

const atoms = new Map();
for (const line of readFileSync("corpus/atoms.jsonl", "utf8").split("\n")) {
  if (!line) continue;
  const a = JSON.parse(line);
  atoms.set(a.atom_id, a);
}

const buckets = new Map();
const mismatches = [];
const errors = [];
const stubCounts = new Map();

for (const name of readdirSync("corpus/ast")) {
  const dialect = name.slice(0, -6) === "_default" ? "" : name.slice(0, -6);
  if (ONLY !== null && dialect !== ONLY) continue;
  if (METHOD_OVERRIDING.has(dialect)) continue;

  const tk = tokenizerFor(dialect);
  if (!tk) continue;

  const b = { exact: 0, mismatch: 0, stub: 0, error: 0 };
  for (const line of readFileSync(`corpus/ast/${name}`, "utf8").split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line);
    const atom = atoms.get(row.atom_id);
    if (!atom) continue;

    let got;
    try {
      const { tokens } = tk.core.tokenize(atom.sql);
      // VALID_INTERVAL_UNITS: matches upstream's base Dialect default
      // (sqlglot/dialects/dialect.py:846, `set[str] = set()`) -- per-dialect unions
      // from DATE_PART_MAPPING land with the real dialects/dialect.js port (P5). Until
      // then this synthetic harness dialect must still be Dialect-shaped so
      // `_parse_interval`/`_parse_types` can call `.has()` on it without crashing.
      const p = new Parser({
        dialect: { tokenizer_class: { COMMANDS: tk.commands }, VALID_INTERVAL_UNITS: new Set() },
      });
      // The Command fallback logs a warning per row; capture it so the probe's own
      // output stays readable. `fuzz_command_warning.mjs` is what asserts those strings.
      const { result } = captureLogs(() => p.parse(tokens, atom.sql));
      got = result[0];
    } catch (e) {
      if (e.name === "NotPorted") {
        b.stub += 1;
        stubCounts.set(e.method, (stubCounts.get(e.method) || 0) + 1);
      } else {
        b.error += 1;
        errors.push(`${row.atom_id} [${dialect}] ${e.name}: ${e.message.split("\n")[0].slice(0, 120)}`);
      }
      continue;
    }

    // Deep-equal against the oracle, `meta` and all. `astDump` is the same serializer
    // the P2 gate uses, so this is the same standard, not a looser one.
    const want = JSON.stringify(row.ast);
    const have = JSON.stringify(got === null || got === undefined ? null : astDump(got));
    if (have === want) {
      b.exact += 1;
    } else {
      b.mismatch += 1;
      if (mismatches.length < 40) {
        mismatches.push({
          id: row.atom_id, dialect, sql: atom.sql,
          gotRepr: got ? toS(got) : "null",
          wantRepr: row.repr,
        });
      }
    }
  }
  buckets.set(dialect || "(default)", b);
}

const tot = { exact: 0, mismatch: 0, stub: 0, error: 0 };
for (const b of buckets.values()) for (const k of Object.keys(tot)) tot[k] += b[k];
const seen = tot.exact + tot.mismatch + tot.stub + tot.error;

console.log(`\n  AST oracle coverage over ${seen} rows`);
console.log(`    EXACT     ${String(tot.exact).padStart(6)}  (parsed and byte-identical, meta included)`);
console.log(`    MISMATCH  ${String(tot.mismatch).padStart(6)}  <- must be 0`);
console.log(`    STUB      ${String(tot.stub).padStart(6)}  (NotPorted — the stub queue's work)`);
console.log(`    ERROR     ${String(tot.error).padStart(6)}  <- must be 0`);

const snow = buckets.get("snowflake");
if (snow) {
  const reached = snow.exact + snow.mismatch;
  const pct = reached ? ((100 * snow.exact) / reached).toFixed(1) : "n/a";
  console.log(`\n    snowflake: ${snow.exact}/${reached} of REACHED rows exact (${pct}%), ` +
    `${snow.stub} still stubbed of ${snow.exact + snow.mismatch + snow.stub + snow.error} total`);
}

if (VERBOSE) {
  console.log("\n  top stubs blocking coverage:");
  for (const [m, n] of [...stubCounts].sort((a, b2) => b2[1] - a[1]).slice(0, 25)) {
    console.log(`    ${String(n).padStart(6)}  ${m}`);
  }
}

for (const m of mismatches.slice(0, 8)) {
  console.log(`    MISMATCH ${m.id} [${m.dialect}] ${JSON.stringify(m.sql.slice(0, 70))}`);
  console.log(`       got  ${m.gotRepr.split("\n").join(" ").slice(0, 140)}`);
  console.log(`       want ${m.wantRepr.split("\n").join(" ").slice(0, 140)}`);
}
for (const e of errors.slice(0, 8)) console.log(`    ERROR ${e}`);

const bad = tot.mismatch > 0 || tot.error > 0;
console.log(bad ? "\n  AST COVERAGE: FAIL" : "\n  AST COVERAGE: OK (no mismatches; remainder is stubbed)");
process.exit(bad ? 1 : 0);
