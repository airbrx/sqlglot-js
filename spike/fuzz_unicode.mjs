// Unicode classification sweep — probe 2 of the P0 go/no-go.
// PORT_PLAN.md §7 P0 item 1, §3.4 target 3, §4.6 "Strings".
//
//   python3 spike/py/gen_unicode_ref.py > spike/out/unicode_ref.json
//   node spike/fuzz_unicode.mjs
//
// Compares candidate JS implementations of Python's str.isprintable / islower /
// isupper / isspace against CPython over the FULL 0..sys.maxunicode range.
//
// Two families of candidate are measured, because they fail for different reasons:
//   (a) runtime \p{...} property escapes — semantically right, but bound to the
//       *engine's* Unicode version, which is not the harvesting interpreter's.
//   (b) generated full-range tables      — exact by construction (§4.3 item 3);
//       verified separately by spike/verify_unicode_tables.mjs.

import { readFileSync, writeFileSync } from "node:fs";

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
};

// General_Category per code point, so a divergence can be *explained* rather than
// merely counted: "unassigned in 13.0" means Node's newer Unicode assigned it.
const catOf = new Array(MAX + 1);
for (const [name, ranges] of Object.entries(ref.categories)) {
  for (const [a, b] of ranges) for (let cp = a; cp <= b; cp++) catOf[cp] = name;
}

const RX = {
  CZ: /[\p{C}\p{Z}]/u,
  CZexplicit: /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u,
  Lowercase: /\p{Lowercase}/u,
  Ll: /\p{Ll}/u,
  Uppercase: /\p{Uppercase}/u,
  Lu: /\p{Lu}/u,
  WhiteSpace: /\p{White_Space}/u,
  s: /\s/u,
};

const CANDIDATES = {
  isprintable: {
    "\\p{C}|\\p{Z} + 0x20": (ch, cp) => cp === 0x20 || !RX.CZ.test(ch),
    "explicit Cc..Zs + 0x20": (ch, cp) => cp === 0x20 || !RX.CZexplicit.test(ch),
    "naive: ASCII 0x20..0x7e": (ch, cp) => cp >= 0x20 && cp < 0x7f,
  },
  islower: {
    "\\p{Lowercase}": (ch) => RX.Lowercase.test(ch),
    "naive: \\p{Ll}": (ch) => RX.Ll.test(ch),
    "naive: toUpper/toLower": (ch) => ch !== ch.toUpperCase() && ch === ch.toLowerCase(),
  },
  isupper: {
    "\\p{Uppercase}": (ch) => RX.Uppercase.test(ch),
    "naive: \\p{Lu}": (ch) => RX.Lu.test(ch),
    "naive: toUpper/toLower": (ch) => ch !== ch.toLowerCase() && ch === ch.toUpperCase(),
  },
  isspace: {
    "\\p{White_Space}": (ch) => RX.WhiteSpace.test(ch),
    "naive: \\s": (ch) => RX.s.test(ch),
    "naive: [ \\t\\n\\r\\f\\v]": (ch) => /[ \t\n\r\f\v]/.test(ch),
  },
};

const BEST = {
  isprintable: "\\p{C}|\\p{Z} + 0x20",
  islower: "\\p{Lowercase}",
  isupper: "\\p{Uppercase}",
  isspace: "\\p{White_Space}",
};

const hex = (cp) => "U+" + cp.toString(16).toUpperCase().padStart(4, "0");

function fmtRanges(cps, limit = 8) {
  const out = [];
  let i = 0;
  while (i < cps.length) {
    let j = i;
    while (j + 1 < cps.length && cps[j + 1] === cps[j] + 1) j++;
    out.push(cps[i] === cps[j] ? hex(cps[i]) : `${hex(cps[i])}..${hex(cps[j])}`);
    i = j + 1;
    if (out.length >= limit) {
      out.push(`… (${cps.length} cps total)`);
      break;
    }
  }
  return out.join(", ");
}

/* ----------------------------- sweep ----------------------------------- */

console.log(`  CPython ${ref.python_version}  (unicodedata ${ref.unidata_version})`);
console.log(
  `  Node    ${process.version}  (ICU ${process.versions.icu ?? "n/a"}, ` +
    `Unicode ${process.versions.unicode ?? "n/a"})`,
);
console.log(
  `  range   0..0x${MAX.toString(16).toUpperCase()} (${(MAX + 1).toLocaleString()} code points)\n`,
);

const results = {};
for (const [pred, impls] of Object.entries(CANDIDATES)) {
  results[pred] = {};
  for (const name of Object.keys(impls)) results[pred][name] = [];
}

// Single pass over the range; build each char once and test every candidate.
for (let cp = 0; cp <= MAX; cp++) {
  const ch = String.fromCodePoint(cp);
  for (const [pred, impls] of Object.entries(CANDIDATES)) {
    const t = truth[pred][cp];
    for (const [name, fn] of Object.entries(impls)) {
      if ((fn(ch, cp) ? 1 : 0) !== t) results[pred][name].push(cp);
    }
  }
}

console.log("  " + "predicate / candidate".padEnd(44) + "diverging cps".padStart(16));
console.log("  " + "-".repeat(60));
for (const [pred, impls] of Object.entries(results)) {
  console.log(`  ${pred}  (CPython true-count: ${ref.counts[pred].toLocaleString()})`);
  for (const [name, diffs] of Object.entries(impls)) {
    const mark = diffs.length === 0 ? "   exact" : "";
    console.log(`    ${name.padEnd(40)}${String(diffs.length).padStart(16)}${mark}`);
  }
}
console.log("  " + "-".repeat(60));

/* -------------------- anatomy of the best candidates -------------------- */

console.log("\n  Anatomy of divergences for the semantically-correct candidates:\n");
let versionSkewOnly = true;
const summary = {};
for (const [pred, name] of Object.entries(BEST)) {
  const diffs = results[pred][name];
  const nonCn = diffs.filter((cp) => (catOf[cp] ?? "??") !== "Cn");
  if (nonCn.length > 0) versionSkewOnly = false;
  summary[pred] = { total: diffs.length, cn: diffs.length - nonCn.length, nonCn, diffs };

  console.log(`  ${pred} via ${name}`);
  console.log(`    total diverging       : ${diffs.length}`);
  console.log(`    unassigned in 13.0 (Cn): ${diffs.length - nonCn.length}   <- Unicode-version skew`);
  console.log(`    assigned in 13.0       : ${nonCn.length}   <- genuine semantic mismatch`);
  if (diffs.length) console.log(`    cps      : ${fmtRanges(diffs)}`);
  if (nonCn.length) console.log(`    non-Cn   : ${fmtRanges(nonCn, 16)}`);
  console.log();
}

/* ------------------ the specific PORT_PLAN §4.6 claim ------------------- */

console.log("  PORT_PLAN §4.6 claim — isspace: Python-only {1c,1d,1e,1f,85}, JS-only {feff}\n");
const pyOnly = [];
const jsOnly = [];
for (let cp = 0; cp <= MAX; cp++) {
  const ch = String.fromCodePoint(cp);
  const py = truth.isspace[cp] === 1;
  const js = RX.s.test(ch);
  if (py && !js) pyOnly.push(cp);
  if (js && !py) jsOnly.push(cp);
}
console.log(`    Python isspace, not JS \\s : ${pyOnly.length}  [${pyOnly.map(hex).join(", ")}]`);
console.log(`    JS \\s, not Python isspace : ${jsOnly.length}  [${jsOnly.map(hex).join(", ")}]`);

writeFileSync(
  "spike/out/unicode_summary.json",
  JSON.stringify(
    {
      python_version: ref.python_version,
      unidata_version: ref.unidata_version,
      node_version: process.version,
      node_icu: process.versions.icu ?? null,
      node_unicode: process.versions.unicode ?? null,
      maxunicode: MAX,
      counts: ref.counts,
      candidates: Object.fromEntries(
        Object.entries(results).map(([p, impls]) => [
          p,
          Object.fromEntries(Object.entries(impls).map(([n, d]) => [n, d.length])),
        ]),
      ),
      best: Object.fromEntries(
        Object.entries(summary).map(([p, s]) => [
          p,
          {
            candidate: BEST[p],
            total: s.total,
            unassigned_in_13: s.cn,
            assigned_in_13: s.nonCn.length,
            assigned_cps: s.nonCn,
          },
        ]),
      ),
      isspace_python_only: pyOnly,
      isspace_js_only: jsOnly,
    },
    null,
    2,
  ),
);
console.log("\n  wrote spike/out/unicode_summary.json");

console.log(
  versionSkewOnly
    ? "\n  All divergences in the correct candidates are Unicode-version skew.\n"
    : "\n  NOTE: some divergences are NOT version skew — see 'assigned in 13.0' above.\n",
);
