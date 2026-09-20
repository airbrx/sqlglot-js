// Differential: `src/optimizer/eliminate_ctes.js` vs CPython's
// `sqlglot.optimizer.eliminate_ctes`, at the pin.
//
//   PYTHONHASHSEED=0 python3 spike/p7/gen_eliminate_ctes_ref.py > spike/out/eliminate_ctes.json
//   node spike/p7/fuzz_eliminate_ctes.mjs
//
// See `gen_eliminate_ctes_ref.py`'s own header for why this file exists
// (`eliminate_ctes.js` is greenfield, has zero `corpus/atoms.jsonl` tie-in) and for
// what each scenario targets. The comparison is plain SQL-string equality on
// `eliminate_ctes(parseOne(sql)).sql()` -- simpler than an AST-dump diff and just as
// strict, since this port's own parser+generator are independently verified elsewhere
// (PORT_PLAN.md P3-P5) and would turn any AST-shape divergence into visibly different
// SQL text. The `journal`-recording path (this module's second parameter) is not
// exercised here -- upstream's own default call site never passes one either -- and is
// instead covered by `test/eliminate_ctes.test.mjs`'s own record/revert round-trip
// assertions, which don't need a CPython oracle since `record`/`revert` (`journal.js`)
// have no independent observable SQL-level behavior of their own.

import { readFileSync } from "node:fs";
import { parseOne } from "../../src/dialects/dialect.js";
import { eliminate_ctes } from "../../src/optimizer/eliminate_ctes.js";
// Side-effect import: registers the real base-Generator dispatch, which `.sql()`
// needs. Without it every scenario would fail with "No SQL generator registered".
import "../../src/generator.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = JSON.parse(readFileSync("spike/out/eliminate_ctes.json", "utf8"));

let exact = 0;
let mismatch = 0;
let error = 0;
const samples = [];

function runOne(sql) {
  try {
    const ast = parseOne(sql);
    const out = eliminate_ctes(ast);
    return { ok: out.sql() };
  } catch (e) {
    return { error: e.constructor.name, message: e.message };
  }
}

for (const { name, sql, result: expected } of ref.scenarios) {
  const got = runOne(sql);
  let ok;
  if ("ok" in expected) {
    ok = "ok" in got && got.ok === expected.ok;
  } else {
    // A CPython-side exception is recorded by class name; this port's error
    // hierarchy is verified elsewhere (CONTRACTS.md §6/§8) to name-match upstream's,
    // so an exact class-name match is the right bar here too.
    ok = "error" in got && got.error === expected.error;
  }
  if (ok) {
    exact++;
  } else if ("error" in got && !("error" in expected)) {
    error++;
    samples.push(`ERROR   ${name}: ${got.error}: ${got.message}\n  sql: ${sql}`);
  } else {
    mismatch++;
    samples.push(
      `MISMATCH ${name}\n  sql:      ${sql}\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(got)}`,
    );
  }
}

console.log();
console.log("  src/optimizer/eliminate_ctes.js vs CPython sqlglot.optimizer.eliminate_ctes");
console.log(`    EXACT ${exact}    MISMATCH ${mismatch}    ERROR ${error}`);
if (samples.length) {
  console.log();
  for (const s of samples) console.log(VERBOSE ? `  ${s}\n` : `  ${s.split("\n")[0]}`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
