// Differential: `src/parsers/dremio.js`/`src/generators/dremio.js`'s real
// grammar/generator logic vs CPython, replaying representative fixtures drawn
// from upstream's own `tests/dialects/test_dremio.py`.
//
//   PYTHONHASHSEED=0 python3 spike/p5/gen_dremio_grammar_ref.py \
//       > spike/out/dremio_grammar.json
//   node spike/p5/fuzz_dremio_grammar.mjs
//
// AIR-2292 (epic AIR-2272, "12.7 Small dialects", batch B). See
// `gen_dremio_grammar_ref.py`'s own header for why this file exists alongside
// `fuzz_dremio_dialect.mjs`: that oracle covers only Dremio's settings surface,
// never calling a single parser or generator METHOD, while this one exercises
// `DremioGenerator.version_sql`/`datatype_sql`/`cast_sql` and `DremioParser`'s
// `datetype_handler`/`to_char_is_numeric_handler`/
// `build_date_delta_with_cast_interval`/`_parse_current_date_utc`.

import { readFileSync } from "node:fs";
import { Dialect } from "../../src/dialects/dialect.js";
// Several fixtures below read/write cross-dialect (spark/trino/postgres/
// duckdb/presto/hive), not just Dremio, so the full public entry point is
// imported here rather than just `src/dialects/dremio.js`.
import "../../index.js";

const rows = JSON.parse(readFileSync("spike/out/dremio_grammar.json", "utf8"));

const fails = [];
let checks = 0;

for (const row of rows) {
  checks += 1;
  const label = `read=${row.read} write=${row.write} ${JSON.stringify(row.sql)}`;
  let got;
  try {
    const rd = Dialect.get_or_raise(row.read);
    got = rd.parse(row.sql)[0].sql(row.write);
  } catch (e) {
    got = { error: `${e.constructor.name}: ${e.message.split("\n")[0]}` };
  }
  if (row.error) {
    const wantFirstLine = row.error.split("\n")[0];
    const gotMsg = typeof got === "object" ? got.error : null;
    // Error CLASS must match; the message text may legitimately differ in
    // wording (CPython and the port don't promise identical prose), so only
    // the exception type name (before the first ":") is compared.
    const wantClass = wantFirstLine.split(":")[0];
    const gotClass = gotMsg ? gotMsg.split(":")[0] : null;
    if (gotClass !== wantClass) {
      fails.push(`${label}\n       got  ${JSON.stringify(got)}\n       want error class ${JSON.stringify(wantClass)} (${JSON.stringify(row.error)})`);
    }
  } else if (typeof got === "object") {
    fails.push(`${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(row.out)}`);
  } else if (got !== row.out) {
    fails.push(`${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(row.out)}`);
  }
}

console.log();
console.log(`  Dremio grammar vs CPython: ${checks - fails.length}/${checks} fixtures pass`);
if (fails.length) {
  console.log();
  for (const f of fails) console.log(`    FAIL ${f}`);
  console.log();
  console.log("  DREMIO GRAMMAR: FAIL");
  process.exit(1);
}
console.log("  DREMIO GRAMMAR: OK");
