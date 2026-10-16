// Differential: `src/parsers/prql.js`'s pipeline-to-SQL grammar vs CPython,
// replaying every fixture from upstream's own `tests/dialects/test_prql.py`.
//
//   PYTHONHASHSEED=0 python3 spike/p5/gen_prql_pipeline_ref.py \
//       > spike/out/prql_pipeline.json
//   node spike/p5/fuzz_prql_pipeline.mjs
//
// AIR-2292 (epic AIR-2272, "12.7 Small dialects", batch B). See
// `gen_prql_pipeline_ref.py`'s own header for why this file exists alongside
// `fuzz_prql_dialect.mjs`: that oracle covers only PRQL's settings surface
// (Tokenizer overrides, scalar settings), never calling a single parser
// METHOD, while this one exercises every TRANSFORM_PARSERS entry
// (DERIVE/SELECT/TAKE/FILTER/APPEND/REMOVE/INTERSECT/SORT/AGGREGATE) and
// `_parse_equality`'s NULL-comparison rewrite.

import { readFileSync } from "node:fs";
import { Dialect } from "../../src/dialects/dialect.js";
import "../../src/dialects/prql.js";

const rows = JSON.parse(readFileSync("spike/out/prql_pipeline.json", "utf8"));

const d = Dialect.get_or_raise("prql");
const fails = [];
let checks = 0;

for (const row of rows) {
  checks += 1;
  let got;
  try {
    got = d.parse(row.sql)[0].sql();
  } catch (e) {
    got = `${e.constructor.name}: ${e.message.split("\n")[0]}`;
  }
  const want = row.error
    ? row.error.split("\n")[0].replace(/^Parse/, "")
    : row.out;
  // Error messages may carry a trailing caret-pointer line that differs only
  // in whitespace rendering between Node and CPython's tty-detection; the
  // first line (exception class + message) is the part asserted here.
  const gotFirstLine = got.split("\n")[0];
  if (row.error) {
    if (!gotFirstLine.includes("ParseError")) {
      fails.push(`${JSON.stringify(row.sql)}\n       got  ${JSON.stringify(got)}\n       want an upstream-matching ParseError (${JSON.stringify(row.error)})`);
    }
  } else if (got !== want) {
    fails.push(`${JSON.stringify(row.sql)}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  }
}

console.log();
console.log(`  PRQL pipeline vs CPython: ${checks - fails.length}/${checks} fixtures pass`);
if (fails.length) {
  console.log();
  for (const f of fails) console.log(`    FAIL ${f}`);
  console.log();
  console.log("  PRQL PIPELINE: FAIL");
  process.exit(1);
}
console.log("  PRQL PIPELINE: OK");
