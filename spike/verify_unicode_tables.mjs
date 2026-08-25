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
  isAlnum,
  isIdentifierStart,
  isDigit,
  upperCodePoint,
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
  isalnum: expand(ref.predicates.isalnum),
  isidentifier: expand(ref.predicates.isidentifier),
  isdigit: expand(ref.predicates.isdigit),
};

const impls = {
  isprintable: isPrintable,
  islower: isLowercase,
  isupper: isUppercase,
  isspace: isSpace,
  istitlechar: isTitlecase,
  isalnum: isAlnum,
  isidentifier: isIdentifierStart,
  isdigit: isDigit,
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

// str.upper(), full range. Also counts how far the engine's own toUpperCase() is from
// CPython's, which is the whole reason this table exists rather than a delegation.
{
  const want = new Map(ref.upper_map);
  let diffs = 0;
  let engineDiffs = 0;
  const samples = [];
  for (let cp = 0; cp <= MAX; cp++) {
    const self = String.fromCodePoint(cp);
    const expected = want.get(cp) ?? self;
    const got = upperCodePoint(cp) ?? self;
    if (got !== expected) {
      diffs++;
      if (samples.length < 8) samples.push("U+" + cp.toString(16).toUpperCase().padStart(4, "0"));
    }
    // Lone surrogates are excluded: String.fromCodePoint yields an unpaired UTF-16
    // unit and toUpperCase() on it is not meaningfully comparable.
    if ((cp < 0xd800 || cp > 0xdfff) && self.toUpperCase() !== expected) engineDiffs++;
  }
  bad += diffs;
  console.log(
    `    ${"upper".padEnd(13)}${String(diffs).padStart(8)} divergences  ` +
      `${diffs === 0 ? "exact" : samples.join(" ")}`,
  );
  console.log(
    `      (for comparison, Node's own toUpperCase() diverges from CPython ` +
      `${PROVENANCE.python_version} on ${engineDiffs} code points — that is why the table exists)`,
  );
  if (engineDiffs === 0) {
    console.log(
      "      WARNING: 0 engine divergences means this check proves nothing on this " +
        "Node build; the table is still correct but the vacuity guard is not armed.",
    );
  }
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
