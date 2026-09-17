// Differential: `src/optimizer/optimize_joins.js` vs CPython's
// `sqlglot.optimizer.optimize_joins`, at the pin.
//
//   PYTHONHASHSEED=0 python3 spike/p7/gen_optimize_joins_ref.py > spike/out/optimize_joins.json
//   node spike/p7/fuzz_optimize_joins.mjs
//
// See `gen_optimize_joins_ref.py`'s own header for why this file exists
// (`optimize_joins.js` is greenfield, has zero `corpus/atoms.jsonl` tie-in) and for
// what each scenario targets. The comparison is plain SQL-string equality on
// `optimizeJoins(parseOne(sql)).sql()` -- simpler than an AST-dump diff and just as
// strict, since this port's own parser+generator are independently verified elsewhere
// (PORT_PLAN.md P3-P5) and would turn any AST-shape divergence into visibly different
// SQL text.

import { readFileSync } from "node:fs";
import { parseOne } from "../../src/dialects/dialect.js";
import * as exp from "../../src/expressions/index.js";
import { optimize_joins } from "../../src/optimizer/optimize_joins.js";
// Side-effect import: registers the real base-Generator dispatch, which `.sql()`
// needs. Without it every scenario would fail with "No SQL generator registered".
import "../../src/generator.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = JSON.parse(readFileSync("spike/out/optimize_joins.json", "utf8"));

let exact = 0;
let mismatch = 0;
let error = 0;
const samples = [];

function runOne(sql) {
  try {
    const ast = parseOne(sql);
    const out = optimize_joins(ast);
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

// `_is_reorderable`'s own doctest, run directly against this port's parser+`findAll`
// (the private predicate itself is not exported -- see optimize_joins.js's header --
// so this recomputes the same True/False signal the doctest asserts via the join
// list's own `.side` values, which is exactly what the unexported function checks).
for (const { label, sql, result: expected } of ref.is_reorderable_direct) {
  const ast = parseOne(sql);
  const select = ast.find(exp.Select);
  const joins = select.args.joins || [];
  const got = !joins.some((j) => j.side);
  const name = `is_reorderable_direct:${label}`;
  if (got === expected) {
    exact++;
  } else {
    mismatch++;
    samples.push(`MISMATCH ${name}\n  sql: ${sql}\n  expected: ${expected}\n  got: ${got}`);
  }
}

console.log();
console.log("  src/optimizer/optimize_joins.js vs CPython sqlglot.optimizer.optimize_joins");
console.log(`    EXACT ${exact}    MISMATCH ${mismatch}    ERROR ${error}`);
if (samples.length) {
  console.log();
  for (const s of samples) console.log(VERBOSE ? `  ${s}\n` : `  ${s.split("\n")[0]}`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
