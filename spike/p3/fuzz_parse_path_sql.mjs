// The DECISIVE generator-kernel check: is the kernel SUFFICIENT for the parse path?
//
//   python3 spike/p3/gen_parse_path_sql_ref.py > spike/out/parse_path_sql.jsonl
//   node spike/p3/fuzz_parse_path_sql.mjs
//
// `fuzz_generator_kernel.mjs` proves CORRECTNESS over 73k nodes and tolerates loud
// refusals for out-of-scope constructs. This one proves SUFFICIENCY and tolerates
// nothing: every sub-AST CPython's parser actually hands to the generator mid-parse
// must render byte-exactly. A `NotPorted` here is a real defect — the parser would
// produce a different AST than upstream.
//
// Covers all seven call sites, including the five implicit `f"{expr}"` coercions that
// `grep '\.sql('` does not show.

import { readFileSync } from "node:fs";
import { astLoad } from "../../src/expressions/index.js";
import { kernelSql } from "../../src/generator_kernel.js";

const rows = readFileSync("spike/out/parse_path_sql.jsonl", "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const bySite = new Map();
let pass = 0;
const fails = [];

for (const row of rows) {
  const stat = bySite.get(row.site) || { pass: 0, total: 0, classes: new Set() };
  stat.total += 1;
  stat.classes.add(row.cls);

  let got;
  let err = null;
  try {
    got = kernelSql(astLoad(row.ast));
  } catch (e) {
    err = e.name === "NotPorted" ? `NotPorted: ${e.message}` : `${e.name}: ${e.message}`;
  }

  if (err === null && got === row.sql) {
    pass += 1;
    stat.pass += 1;
  } else {
    fails.push(
      `${row.site} (${row.fn}) ${row.cls}\n       got  ${err ?? JSON.stringify(got)}`
      + `\n       want ${JSON.stringify(row.sql)}`,
    );
  }
  bySite.set(row.site, stat);
}

console.log(`\n  parse-path generate calls: ${pass}/${rows.length} byte-exact`);
for (const [site, s] of [...bySite].sort()) {
  const flag = s.pass === s.total ? "  " : "<-";
  console.log(`    ${flag} ${site.padEnd(16)} ${s.pass}/${s.total}  [${[...s.classes].sort().join(", ")}]`);
}
for (const f of fails) console.log(`    FAIL ${f}`);

// Every site upstream can reach must be represented, or the probe is measuring less
// than it claims. Seven were found by instrumenting CPython over the whole corpus.
const EXPECTED_SITES = [
  "parser.py:3044", "parser.py:3046", "parser.py:3179",
  "parser.py:5491", "parser.py:8069", "parser.py:9313", "parser.py:9462",
];
const missing = EXPECTED_SITES.filter((s) => !bySite.has(s));
if (missing.length) console.log(`    MISSING SITES: ${missing.join(", ")}`);

const bad = fails.length > 0 || missing.length > 0;
console.log(bad ? "\n  PARSE-PATH GENERATE: FAIL" : "\n  PARSE-PATH GENERATE: OK");
process.exit(bad ? 1 : 0);
