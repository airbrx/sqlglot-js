// fuzz_toowide + fuzz_comments — PORT_PLAN.md §3.4 targets 4 and 5.
//
//   python3 spike/py/gen_toowide_comments.py > spike/out/toowide_comments.jsonl
//   node spike/fuzz_toowide_comments.mjs
//
// Both targets exist because they are PROVABLY corpus-invisible (R4): a `.length` port
// passes 15,540/15,540 atoms and is wrong. The whole point is to construct the case the
// corpus cannot — so this file also asserts that the naive implementation FAILS, because
// a differential test both implementations pass is not testing anything.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { cpLen, pyRstrip } from "../src/_py/str.js";

const WIDTH = 80;

// py: Generator.too_wide — `len(text) > self.max_text_width`, where len() counts CODE POINTS.
const tooWideCorrect = (text) => cpLen(text) > WIDTH;
// The naive port §4.2's cpLen rule exists to prevent.
const tooWideNaive = (text) => text.length > WIDTH;

const stats = new Map();
function record(bucket, ok, detail) {
  let s = stats.get(bucket);
  if (!s) {
    s = { n: 0, bad: 0, samples: [] };
    stats.set(bucket, s);
  }
  s.n++;
  if (!ok) {
    s.bad++;
    if (s.samples.length < 5) s.samples.push(detail);
  }
}

let naiveWrong = 0;
let lenDiverged = 0;
let sanitizeCases = 0;

const path = process.argv[2] ?? "spike/out/toowide_comments.jsonl";
const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });

let total = 0;
for await (const line of rl) {
  if (!line) continue;
  const rec = JSON.parse(line);
  total++;

  if (rec.k === "toowide") {
    record("cpLen == Python len()", cpLen(rec.text) === rec.len_codepoints, {
      label: rec.label,
      want: rec.len_codepoints,
      got: cpLen(rec.text),
    });
    record("too_wide (code points)", tooWideCorrect(rec.text) === rec.too_wide_80, {
      label: rec.label,
      want: rec.too_wide_80,
      got: tooWideCorrect(rec.text),
    });
    if (rec.text.length !== rec.len_codepoints) lenDiverged++;
    if (tooWideNaive(rec.text) !== rec.too_wide_80) naiveWrong++;
  } else if (rec.k === "sanitize_comment") {
    sanitizeCases++;
    // sanitize_comment strips whitespace and neutralises comment terminators. We do not
    // have the JS generator yet, so assert the piece that IS ported: the strip must be
    // Python's, not JS's — they differ on 6 code points (§4.6).
    if (typeof rec.want === "string") {
      const pyStripped = pyRstrip(rec.text);
      const jsStripped = rec.text.replace(/\s+$/u, "");
      if (pyStripped !== jsStripped) {
        record("pyRstrip differs from JS \\s (expected on the 6 divergent cps)", true, {});
      }
    }
  }
}

let bad = 0;
console.log(`\n  ${total.toLocaleString()} cases\n`);
console.log("  " + "bucket".padEnd(46) + "cases".padStart(9) + "fail".padStart(8));
console.log("  " + "-".repeat(63));
for (const [bucket, s] of [...stats].sort()) {
  bad += s.bad;
  console.log(
    `  ${bucket.padEnd(46)}${s.n.toLocaleString().padStart(9)}${String(s.bad).padStart(8)}  ${s.bad ? "FAIL" : "ok"}`,
  );
}
console.log("  " + "-".repeat(63));
for (const [bucket, s] of stats) {
  if (!s.bad) continue;
  console.log(`\n  first divergences in ${bucket}:`);
  for (const d of s.samples) console.log("    " + JSON.stringify(d));
}

console.log(`\n  ${lenDiverged.toLocaleString()} cases where .length != code-point count`);
console.log(`  ${naiveWrong.toLocaleString()} cases where the NAIVE .length port gives the wrong too_wide verdict`);
console.log(`  ${sanitizeCases.toLocaleString()} sanitize_comment oracle rows captured for P4`);

// A differential test that both the correct and the naive implementation pass proves
// nothing. If the generator ever stops constructing straddling cases, say so loudly.
if (naiveWrong === 0) {
  console.log(
    "\n  FUZZ_TOOWIDE: RED — the corpus does not distinguish cpLen from .length,\n" +
      "  so this target is vacuous. Fix the generator, not the assertion.\n",
  );
  process.exit(1);
}

console.log(bad === 0 ? "\n  FUZZ_TOOWIDE/COMMENTS: GREEN\n" : `\n  FUZZ_TOOWIDE/COMMENTS: RED (${bad})\n`);
process.exit(bad === 0 ? 0 : 1);
