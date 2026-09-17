// Differential: `src/optimizer/isolate_table_selects.js` vs CPython's
// `sqlglot.optimizer.isolate_table_selects`, at the pin.
//
//   PYTHONHASHSEED=0 python3 spike/p7/gen_isolate_table_selects_ref.py > spike/out/isolate_table_selects.json
//   node spike/p7/fuzz_isolate_table_selects.mjs
//
// See `gen_isolate_table_selects_ref.py`'s own header (and `qualify_tables.js`'s sibling
// oracle header) for why this file exists and what each scenario targets.

import { readFileSync } from "node:fs";
import { parseOne } from "../../src/dialects/dialect.js";
import { isolate_table_selects } from "../../src/optimizer/isolate_table_selects.js";
// Side-effect import: registers the real base-Generator dispatch, which `.sql()`
// needs. Without it every scenario would fail with "No SQL generator registered".
import "../../src/generator.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = JSON.parse(readFileSync("spike/out/isolate_table_selects.json", "utf8"));

let exact = 0;
let mismatch = 0;
let error = 0;
const samples = [];

function runOne(sql, schema) {
  try {
    const ast = parseOne(sql);
    const out = isolate_table_selects(ast, { schema });
    return { ok: out.sql() };
  } catch (e) {
    return { error: e.constructor.name, message: e.message };
  }
}

for (const { name, sql, schema, result: expected } of ref.scenarios) {
  const got = runOne(sql, schema);
  let ok;
  if ("ok" in expected) {
    ok = "ok" in got && got.ok === expected.ok;
  } else {
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

for (const { label, sql, schema, once: expectedOnce, twice: expectedTwice } of ref.idempotent) {
  const onceAst = isolate_table_selects(parseOne(sql), { schema });
  const once = onceAst.sql();
  const twice = isolate_table_selects(onceAst, { schema }).sql();
  const name = `idempotent:${label}`;
  if (once === expectedOnce && twice === expectedTwice) {
    exact++;
  } else {
    mismatch++;
    samples.push(
      `MISMATCH ${name}\n  once:   expected=${JSON.stringify(expectedOnce)} got=${JSON.stringify(once)}\n  twice:  expected=${JSON.stringify(expectedTwice)} got=${JSON.stringify(twice)}`,
    );
  }
}

console.log();
console.log("  src/optimizer/isolate_table_selects.js vs CPython sqlglot.optimizer.isolate_table_selects");
console.log(`    EXACT ${exact}    MISMATCH ${mismatch}    ERROR ${error}`);
if (samples.length) {
  console.log();
  for (const s of samples) console.log(VERBOSE ? `  ${s}\n` : `  ${s.split("\n")[0]}`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
