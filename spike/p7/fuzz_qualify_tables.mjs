// Differential: `src/optimizer/qualify_tables.js` vs CPython's
// `sqlglot.optimizer.qualify_tables`, at the pin.
//
//   PYTHONHASHSEED=0 python3 spike/p7/gen_qualify_tables_ref.py > spike/out/qualify_tables.json
//   node spike/p7/fuzz_qualify_tables.mjs
//
// See `gen_qualify_tables_ref.py`'s own header for why this file exists
// (`qualify_tables.js` is greenfield, has zero `corpus/atoms.jsonl` tie-in, same shape
// `optimize_joins.js`/R45 and `schema.js`/R41 already established) and for what each
// scenario targets. The comparison is plain SQL-string equality on
// `qualify_tables(parseOne(sql), kwargs).sql()` -- simpler than an AST-dump diff and
// just as strict, since this port's own parser+generator are independently verified
// elsewhere (PORT_PLAN.md P3-P5) and would turn any AST-shape divergence into visibly
// different SQL text.

import { readFileSync } from "node:fs";
import { parseOne } from "../../src/dialects/dialect.js";
import { qualify_tables } from "../../src/optimizer/qualify_tables.js";
// Side-effect imports: registers the real base-Generator dispatch (needed by `.sql()`)
// and the Snowflake dialect (needed by the one `dialect: "snowflake"` scenario).
import "../../src/generator.js";
import "../../src/dialects/snowflake.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = JSON.parse(readFileSync("spike/out/qualify_tables.json", "utf8"));

let exact = 0;
let mismatch = 0;
let error = 0;
const samples = [];

// py kwargs -> this port's camelCase options object (qualify_tables.js's own header
// explains why: an options object avoids PORT_PLAN.md R18's
// keyword-only-arg-passed-positionally trap for a 5-keyword-arg function).
function toOptions(kwargs) {
  const opts = {};
  if ("db" in kwargs) opts.db = kwargs.db;
  if ("catalog" in kwargs) opts.catalog = kwargs.catalog;
  if ("dialect" in kwargs) opts.dialect = kwargs.dialect;
  if ("canonicalize_table_aliases" in kwargs) opts.canonicalizeTableAliases = kwargs.canonicalize_table_aliases;
  return opts;
}

function runOne(sql, kwargs) {
  try {
    const ast = parseOne(sql);
    const out = qualify_tables(ast, toOptions(kwargs));
    return { ok: out.sql() };
  } catch (e) {
    return { error: e.constructor.name, message: e.message };
  }
}

for (const { name, sql, kwargs, result: expected } of ref.scenarios) {
  const got = runOne(sql, kwargs);
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

console.log();
console.log("  src/optimizer/qualify_tables.js vs CPython sqlglot.optimizer.qualify_tables");
console.log(`    EXACT ${exact}    MISMATCH ${mismatch}    ERROR ${error}`);
if (samples.length) {
  console.log();
  for (const s of samples) console.log(VERBOSE ? `  ${s}\n` : `  ${s.split("\n")[0]}`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
