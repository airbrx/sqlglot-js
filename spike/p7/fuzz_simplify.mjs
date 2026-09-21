// Differential: `src/optimizer/simplify.js` vs CPython's `sqlglot.optimizer.simplify`,
// at the pin.
//
//   PYTHONHASHSEED=0 python3 spike/p7/gen_simplify_ref.py > spike/out/simplify.json
//   node spike/p7/fuzz_simplify.mjs
//
// See `gen_simplify_ref.py`'s own header for why this file exists and what each
// scenario group targets. The comparison is plain SQL-string equality on
// `simplify(parseOne(sql)).sql()` -- simpler than an AST-dump diff and just as strict,
// since this port's own parser+generator are independently verified elsewhere
// (PORT_PLAN.md P3-P5) and would turn any AST-shape divergence into visibly different
// SQL text.

import { readFileSync } from "node:fs";
import { parseOne } from "../../src/dialects/dialect.js";
import { simplify } from "../../src/optimizer/simplify.js";
// Side-effect import: registers the real base-Generator dispatch, which `.sql()`
// needs. Without it every scenario would fail with "No SQL generator registered".
import "../../src/generator.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = JSON.parse(readFileSync("spike/out/simplify.json", "utf8"));

let exact = 0;
let mismatch = 0;
let error = 0;
const samples = [];

function runOne(sql) {
  try {
    const ast = parseOne(sql);
    const out = simplify(ast);
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
    // A CPython-side exception is recorded by class name; this port's error hierarchy
    // is verified elsewhere (CONTRACTS.md §6/§8) to name-match upstream's, so an exact
    // class-name match is the right bar here too.
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
console.log("  src/optimizer/simplify.js vs CPython sqlglot.optimizer.simplify");
console.log(`    EXACT ${exact}    MISMATCH ${mismatch}    ERROR ${error}`);
if (samples.length) {
  console.log();
  for (const s of samples) console.log(VERBOSE ? `  ${s}\n` : `  ${s.split("\n")[0]}`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
