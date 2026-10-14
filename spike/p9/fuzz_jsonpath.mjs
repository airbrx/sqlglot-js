// Differential: `src/jsonpath.js` (`parse()`) vs CPython's `sqlglot.jsonpath.parse`,
// over EVERY assertion in `tests/test_jsonpath.py` (`TestJsonpath`, 5 test methods,
// including the 526-row `tests/fixtures/jsonpath/cts.json` conformance replay).
// AIR-2274 (epic AIR-2270, "10.1 jsonpath.js").
//
//   PYTHONHASHSEED=0 python3 spike/p9/gen_jsonpath_ref.py > spike/out/jsonpath.json
//   node spike/p9/fuzz_jsonpath.mjs
//
// Each row records CPython's own `parse(selector)` outcome -- either "ok" (with
// `repr`/`sql`) or "error" (with the exception class name) -- and this probe
// requires the port to match it EXACTLY, including every `cts.json` row the
// generator's own header explains is marked `invalid_selector` by the external
// RFC 9535 conformance suite but is NOT actually required to raise by
// `test_cts_file`'s own (assertion-free) handling of that flag: if CPython parses
// one successfully under sqlglot's intentionally-partial grammar, this port must
// too, byte-for-byte, same as any other row.

import { readFileSync } from "node:fs";
import { parse } from "../../src/jsonpath.js";
import { ParseError, TokenError } from "../../src/errors.js";
// Side-effect import: installs the dialect registry `parse()` resolves against.
import "../../index.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = readFileSync("spike/out/jsonpath.json", "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

let exact = 0;
let mismatch = 0;
let error = 0;
const mismatches = [];
const errors = [];

for (const row of ref) {
  try {
    if (row.kind === "ast") {
      const path = parse(row.selector);
      const node = row.extract === "last_expr" ? path.expressions.at(-1) : path;
      const got = node.toString();
      if (got === row.repr) exact++;
      else {
        mismatch++;
        mismatches.push({ name: row.name, want: row.repr, got });
      }
      continue;
    }

    // kind === "parse"
    let outcome;
    let gotRepr;
    let gotSql;
    try {
      const path = parse(row.selector);
      outcome = "ok";
      gotRepr = path.toString();
      gotSql = path.sql();
    } catch (e) {
      if (!(e instanceof ParseError) && !(e instanceof TokenError)) throw e;
      outcome = "error";
      gotSql = null;
      gotRepr = e.constructor.name;
    }

    if (outcome !== row.outcome) {
      mismatch++;
      mismatches.push({ name: row.name, want: row, got: { outcome, error_type: gotRepr } });
    } else if (outcome === "error") {
      if (gotRepr === row.error_type) exact++;
      else {
        mismatch++;
        mismatches.push({ name: row.name, want: row.error_type, got: gotRepr });
      }
    } else if (gotRepr === row.repr && gotSql === row.sql) {
      exact++;
    } else {
      mismatch++;
      mismatches.push({ name: row.name, want: { repr: row.repr, sql: row.sql }, got: { repr: gotRepr, sql: gotSql } });
    }
  } catch (e) {
    error++;
    errors.push({ name: row.name, error: e.stack || e.message });
  }
}

console.log(`\n  ${ref.length} rows\n`);
console.log(`  EXACT      ${exact}`);
console.log(`  MISMATCH   ${mismatch}`);
console.log(`  ERROR      ${error}`);

if (mismatches.length) {
  console.log("\n  mismatches:");
  for (const m of mismatches.slice(0, 20)) console.log(`    ${m.name}: ${JSON.stringify(m)}`);
}
if (errors.length) {
  console.log("\n  errors:");
  for (const e of errors.slice(0, 20)) console.log(`    ${e.name}: ${e.error}`);
}

const bad = mismatch + error;
console.log(bad === 0 ? "\n  JSONPATH PROBE: GREEN\n" : `\n  JSONPATH PROBE: RED (${bad})\n`);
process.exit(bad === 0 ? 0 : 1);
