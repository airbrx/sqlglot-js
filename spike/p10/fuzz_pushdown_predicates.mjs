// Differential: `src/optimizer/pushdown_predicates.js` vs CPython's
// `sqlglot.optimizer.pushdown_predicates`, at the pin.
//
//   SQLGLOT_REF=/tmp/sqlglot-complete-pin python3 spike/p10/gen_pushdown_predicates_ref.py > spike/out/pushdown_predicates.json
//   node spike/p10/fuzz_pushdown_predicates.mjs
//
// See `gen_pushdown_predicates_ref.py`'s own header: this reproduces upstream's exact
// (unwrapped) two-step pipeline `pushdown_predicates(parse_one(sql, read=dialect),
// dialect=dialect).sql(dialect=dialect)` against
// `tests/fixtures/optimizer/pushdown_predicates.sql` (32 pairs). 6 pairs are gated
// behind `# dialect: presto|trino|athena` and are SKIPPED (not counted as ERROR):
// none of those three dialects are ported in this JS codebase yet, so
// `parseOne(sql, { read: "presto" })` already throws independently of
// `pushdown_predicates.js` -- see the module header of `src/optimizer/
// pushdown_predicates.js` for why `unnest_requires_cross_join` (the behavior those 6
// pairs exercise) is hardcoded `false` here.

import { readFileSync } from "node:fs";
import { parseOne } from "../../src/dialects/dialect.js";
import { pushdown_predicates } from "../../src/optimizer/pushdown_predicates.js";
// Side-effect import: registers the real base-Generator dispatch (`.sql()` needs it).
import "../../src/generator.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = JSON.parse(readFileSync("spike/out/pushdown_predicates.json", "utf8"));

let exact = 0;
let mismatch = 0;
let error = 0;
let skipped = 0;
const samples = [];

function pushdownPipeline(sql, dialect) {
  const expression = parseOne(sql, { read: dialect ?? undefined });
  const optimized = pushdown_predicates(expression, dialect);
  return optimized.sql(dialect);
}

for (const row of ref.fixtures) {
  const name = `fixture#${row.id}${row.dialect ? ` (${row.dialect})` : ""}`;

  if (row.dialect_unported) {
    skipped++;
    continue;
  }

  let got;
  try {
    got = { ok: pushdownPipeline(row.sql, row.dialect) };
  } catch (e) {
    got = { error: e.constructor.name, message: e.message };
  }

  if ("error" in row) {
    if ("error" in got) exact++;
    else {
      mismatch++;
      samples.push(`MISMATCH ${name} (expected CPython error, got ok)\n  sql: ${row.sql}\n  got: ${JSON.stringify(got)}`);
    }
    continue;
  }

  if ("error" in got) {
    error++;
    samples.push(`ERROR   ${name}: ${got.error}: ${got.message}\n  sql: ${row.sql}`);
  } else if (got.ok === row.expected) {
    exact++;
  } else {
    mismatch++;
    samples.push(`MISMATCH ${name}\n  sql:      ${row.sql}\n  expected: ${row.expected}\n  got:      ${got.ok}`);
  }
}

console.log();
console.log("  src/optimizer/pushdown_predicates.js vs CPython sqlglot.optimizer.pushdown_predicates");
console.log(`    EXACT ${exact}    MISMATCH ${mismatch}    ERROR ${error}    SKIPPED ${skipped} (presto/trino/athena, unported)`);
if (samples.length) {
  console.log();
  for (const s of samples) console.log(VERBOSE ? `  ${s}\n` : `  ${s.split("\n")[0]}`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
