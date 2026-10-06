// Differential: `src/anonymize.js` (`anonymize()` + `render()`) vs CPython's
// `sqlglot.anonymize`, over EVERY assertion in `tests/test_anonymize.py`
// (`TestAnonymize`, 24 test methods) plus a handful of this round's own ad-hoc rows
// exercising the code-point-width hazard `anonymize.js`'s header note calls out
// (upstream's own test suite never puts an astral character inside a quoted
// literal). AIR-2123 (epic AIR-2092, "9.3 anonymize.js").
//
//   PYTHONHASHSEED=0 python3 spike/p10/gen_anonymize_ref.py > spike/out/anonymize.json
//   node spike/p10/fuzz_anonymize.mjs
//
// Known pre-existing gaps, excluded rather than counted as MISMATCH/ERROR:
//   - `test_functions_anonymized_2` (named by row): depends on `BaseParser
//     .FUNCTION_PARSERS` having a `JSON_OBJECT` entry, which this port does not yet
//     have (`_parse_json_object` is a `NotPorted` stub in `src/parser.js`) — a
//     pre-existing parser gap, not an `anonymize.js` defect.
//   - "Unknown dialect" (named by error regex, counted): six rows use the "mysql" or
//     "oracle" dialects (backtick/hash-comment quoting, `INSERT /*+ ... */` hints),
//     neither of which has a real `Dialect` subclass registered in this port's
//     `index.js` yet — a pre-existing missing-dialect gap, not an `anonymize.js`
//     defect. `anonymize`/`render` both resolve dialects via `Dialect.get_or_raise`
//     exactly like every other P-series oracle, so this surfaces the SAME way it
//     would for any other ported module exercising these two dialects.

import { readFileSync } from "node:fs";
import { anonymize, render } from "../../src/anonymize.js";
import { Tokenizer, TOKEN_TYPE_NAMES } from "../../src/tokens.js";
// Side-effect imports: registers every dialect this oracle's rows ask for by name.
import "../../index.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = readFileSync("spike/out/anonymize.json", "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

// Rows whose Python-side behavior depends on a NAMED pre-existing gap elsewhere in
// this port (not anonymize.js itself). Listed by row name, per this file's header.
const KNOWN_BLOCKED = new Set(["test_functions_anonymized_2"]);

// Pre-existing gap matched by ERROR MESSAGE rather than row name, since it can hit
// any row using one of these two unregistered dialects (see header note).
const KNOWN_BLOCKED_ERROR = /^Unknown dialect '(mysql|oracle)'/;

let exact = 0;
let knownGap = 0;
let mismatch = 0;
let error = 0;
const mismatches = [];
const errors = [];
const blockedByError = new Map();

function tokenTypeName(t) {
  return TOKEN_TYPE_NAMES[t] ?? String(t);
}

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function report(row, ok, detail) {
  if (ok) {
    exact++;
  } else if (KNOWN_BLOCKED.has(row.name)) {
    knownGap++;
    if (VERBOSE) console.log(`  [known-gap] ${row.name}: ${detail}`);
  } else {
    mismatch++;
    mismatches.push({ name: row.name, detail });
  }
}

for (const row of ref) {
  try {
    if (row.kind === "tokens") {
      const got = anonymize(row.sql, row.dialect).map((t) => [
        tokenTypeName(t.token_type),
        t.text,
        t.comments,
      ]);
      report(row, eq(got, row.want), { want: row.want, got });
    } else if (row.kind === "render") {
      const got = render(row.sql, anonymize(row.sql, row.dialect), row.dialect);
      let ok = got === row.want;
      if (ok && row.check_len) ok = [...got].length === [...row.sql].length;
      report(row, ok, { want: row.want, got });
    } else if (row.kind === "huge_numeric") {
      const tokens = anonymize(row.sql, row.dialect);
      const got = { token_type: tokenTypeName(tokens[1].token_type), text_len: tokens[1].text.length };
      report(row, eq(got, row.want), { want: row.want, got });
    } else if (row.kind === "tokens_input") {
      const { tokens } = new Tokenizer(row.dialect).tokenize(row.sql_for_tokenizing);
      const got = anonymize(tokens, row.dialect).map((t) => [tokenTypeName(t.token_type), t.text]);
      report(row, eq(got, row.want), { want: row.want, got });
    } else if (row.kind === "render_cross_dialect") {
      const tokens = anonymize(row.sql, row.anonymize_dialect);
      const got = render(row.sql, tokens, row.render_dialect);
      report(row, got === row.want, { want: row.want, got });
    } else {
      throw new Error(`unknown row kind ${row.kind}`);
    }
  } catch (e) {
    if (KNOWN_BLOCKED.has(row.name)) {
      knownGap++;
    } else if (KNOWN_BLOCKED_ERROR.test(e.message)) {
      knownGap++;
      blockedByError.set(e.message, (blockedByError.get(e.message) ?? 0) + 1);
    } else {
      error++;
      errors.push({ name: row.name, error: e.message });
    }
  }
}

console.log(`\n  ${ref.length} rows\n`);
console.log(`  EXACT      ${exact}`);
console.log(`  KNOWN_GAP  ${knownGap}`);
console.log(`  MISMATCH   ${mismatch}`);
console.log(`  ERROR      ${error}`);

if (blockedByError.size) {
  console.log("\n  known-gap errors (by message, counted, not row id):");
  for (const [msg, n] of blockedByError) console.log(`    ${n}x  ${msg}`);
}
if (mismatches.length) {
  console.log("\n  mismatches:");
  for (const m of mismatches.slice(0, 20)) console.log(`    ${m.name}: ${JSON.stringify(m.detail)}`);
}
if (errors.length) {
  console.log("\n  errors:");
  for (const e of errors.slice(0, 20)) console.log(`    ${e.name}: ${e.error}`);
}

const bad = mismatch + error;
console.log(bad === 0 ? "\n  ANONYMIZE PROBE: GREEN\n" : `\n  ANONYMIZE PROBE: RED (${bad})\n`);
process.exit(bad === 0 ? 0 : 1);
