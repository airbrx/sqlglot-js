// Verifies the generated tables reproduce CPython EXACTLY over the full range.
// This is the step that decides probe 2: runtime \p{...} cannot match a different
// interpreter's Unicode version, but generated tables can — and this asserts it
// rather than assuming it.
//
//   node tools/gen_unicode_tables.mjs && node spike/verify_unicode_tables.mjs

import { readFileSync } from "node:fs";
import {
  isPrintable,
  isLowercase,
  isUppercase,
  isSpace,
  isTitlecase,
  PROVENANCE,
} from "../src/_gen/unicode.js";

const ref = JSON.parse(readFileSync("spike/out/unicode_ref.json", "utf8"));
const MAX = ref.maxunicode;

function expand(ranges) {
  const set = new Uint8Array(MAX + 1);
  for (const [a, b] of ranges) set.fill(1, a, b + 1);
  return set;
}

const truth = {
  isprintable: expand(ref.predicates.isprintable),
  islower: expand(ref.predicates.islower),
  isupper: expand(ref.predicates.isupper),
  isspace: expand(ref.predicates.isspace),
  istitlechar: expand(ref.predicates.istitlechar),
};

const impls = {
  isprintable: isPrintable,
  islower: isLowercase,
  isupper: isUppercase,
  isspace: isSpace,
  istitlechar: isTitlecase,
};

console.log(`  table provenance: CPython ${PROVENANCE.python_version}, `
  + `unicodedata ${PROVENANCE.unidata_version}`);
console.log(`  verifying 0..0x${MAX.toString(16).toUpperCase()} `
  + `(${(MAX + 1).toLocaleString()} code points) x ${Object.keys(impls).length} predicates`);
console.log(
  `  str.istitle() == ISUPPER|ISTITLE identity mismatches in CPython: ` +
    `${(ref.istitle_identity_mismatches ?? []).length}\n`,
);

let bad = 0;
for (const [name, fn] of Object.entries(impls)) {
  let diffs = 0;
  const samples = [];
  const t = truth[name];
  for (let cp = 0; cp <= MAX; cp++) {
    if ((fn(cp) ? 1 : 0) !== t[cp]) {
      diffs++;
      if (samples.length < 8) samples.push("U+" + cp.toString(16).toUpperCase().padStart(4, "0"));
    }
  }
  bad += diffs;
  console.log(
    `    ${name.padEnd(13)}${String(diffs).padStart(8)} divergences  ${diffs === 0 ? "exact" : samples.join(" ")}`,
  );
}

// Guard the provenance contract itself: if the harvesting interpreter's Unicode
// version moves, the tables are stale and must be regenerated (PORT_PLAN.md §5.2/R6).
const provOk = PROVENANCE.unidata_version === ref.unidata_version;
console.log(
  `\n    provenance match: ${provOk ? "ok" : `STALE (table ${PROVENANCE.unidata_version} vs ref ${ref.unidata_version})`}`,
);

console.log(
  bad === 0 && provOk
    ? "\n  GENERATED TABLES: EXACT over the full range\n"
    : `\n  GENERATED TABLES: FAILED (${bad} divergences)\n`,
);
process.exit(bad === 0 && provOk ? 0 : 1);
