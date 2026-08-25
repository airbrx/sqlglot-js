// String-level differential runner for _py/str.js.
//   python3 spike/py/gen_str_cases.py > spike/out/str_cases.jsonl
//   node spike/fuzz_str.mjs

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { pyIsPrintable, pyIsLower, pyIsUpper, pyIsSpace } from "../src/_py/str.js";

const IMPLS = {
  isprintable: pyIsPrintable,
  islower: pyIsLower,
  isupper: pyIsUpper,
  isspace: pyIsSpace,
};

const stats = {};
for (const k of Object.keys(IMPLS)) stats[k] = { n: 0, bad: 0, samples: [] };

const path = process.argv[2] ?? "spike/out/str_cases.jsonl";
const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });

let total = 0;
for await (const line of rl) {
  if (!line) continue;
  const rec = JSON.parse(line);
  // Build the string from code points; String.fromCodePoint handles astral and
  // lone surrogates identically to CPython's chr().
  const s = rec.cps.map((cp) => String.fromCodePoint(cp)).join("");
  for (const [name, fn] of Object.entries(IMPLS)) {
    const got = fn(s);
    const st = stats[name];
    st.n++;
    if (got !== rec[name]) {
      st.bad++;
      if (st.samples.length < 8) {
        st.samples.push({
          cps: rec.cps.map((c) => "U+" + c.toString(16).toUpperCase()),
          want: rec[name],
          got,
        });
      }
    }
  }
  total++;
}

let bad = 0;
console.log(`\n  ${total.toLocaleString()} strings\n`);
console.log("  " + "predicate".padEnd(16) + "cases".padStart(12) + "fail".padStart(10));
console.log("  " + "-".repeat(38));
for (const [name, st] of Object.entries(stats)) {
  bad += st.bad;
  console.log(
    `  ${name.padEnd(16)}${st.n.toLocaleString().padStart(12)}${String(st.bad).padStart(10)}  ${st.bad ? "FAIL" : "ok"}`,
  );
}
console.log("  " + "-".repeat(38));
for (const [name, st] of Object.entries(stats)) {
  if (!st.bad) continue;
  console.log(`\n  first divergences in ${name}:`);
  for (const d of st.samples) console.log("    " + JSON.stringify(d));
}
console.log(bad === 0 ? "\n  STRING-LEVEL PROBE: GREEN\n" : `\n  STRING-LEVEL PROBE: RED (${bad})\n`);
process.exit(bad === 0 ? 0 : 1);
