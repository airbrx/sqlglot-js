// Differential: `src/optimizer/eliminate_joins.js` vs CPython's
// `sqlglot.optimizer.eliminate_joins`, at the pin.
//
//   SQLGLOT_REF=/tmp/sqlglot-complete-pin python3 spike/p10/gen_eliminate_joins_ref.py > spike/out/eliminate_joins.json
//   node spike/p10/fuzz_eliminate_joins.mjs
//
// See `gen_eliminate_joins_ref.py`'s own header for why this oracle's pipeline is a
// bare `eliminate_joins(parse_one(sql)).sql(pretty=True)` and not the
// `annotate_types`/`simplify`-dressed pipeline `normalize.js`'s own oracle (P10/R68)
// needs: `TestOptimizer.test_eliminate_joins` passes no `schema=` kwarg and the
// fixture carries no `# dialect:`/`# leave_tables_isolated:` meta.

import { readFileSync } from "node:fs";
import { parseOne } from "../../src/dialects/dialect.js";
import { eliminate_joins, join_condition } from "../../src/optimizer/eliminate_joins.js";
// Side-effect import: registers the real base-Generator dispatch (`.sql()` needs it).
import "../../src/generator.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = JSON.parse(readFileSync("spike/out/eliminate_joins.json", "utf8"));

let exact = 0;
let mismatch = 0;
let error = 0;
const samples = [];

for (const row of ref.fixtures) {
  const name = `fixture#${row.id} (${row.title})`;
  let got;
  try {
    got = { ok: eliminate_joins(parseOne(row.sql)).sql(null, { pretty: true }) };
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

for (const row of ref.join_condition) {
  const name = `join_condition:${row.name}`;
  let got;
  try {
    const join = parseOne(row.sql).args.joins[0];
    const [source_key, join_key, on] = join_condition(join);
    got = {
      ok: {
        source_key: source_key.map((e) => e.sql()),
        join_key: join_key.map((e) => e.sql()),
        on: on.sql(),
      },
    };
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
  } else if (
    got.ok.on === row.on
    && JSON.stringify(got.ok.source_key) === JSON.stringify(row.source_key)
    && JSON.stringify(got.ok.join_key) === JSON.stringify(row.join_key)
  ) {
    exact++;
  } else {
    mismatch++;
    samples.push(
      `MISMATCH ${name}\n  sql:      ${row.sql}\n`
      + `  expected: on=${row.on} join_key=${JSON.stringify(row.join_key)} source_key=${JSON.stringify(row.source_key)}\n`
      + `  got:      on=${got.ok.on} join_key=${JSON.stringify(got.ok.join_key)} source_key=${JSON.stringify(got.ok.source_key)}`,
    );
  }
}

console.log();
console.log("  src/optimizer/eliminate_joins.js vs CPython sqlglot.optimizer.eliminate_joins");
console.log(`    EXACT ${exact}    MISMATCH ${mismatch}    ERROR ${error}`);
if (samples.length) {
  console.log();
  for (const s of samples) console.log(VERBOSE ? `  ${s}\n` : `  ${s.split("\n")[0]}`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
