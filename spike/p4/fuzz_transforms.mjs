// Differential: `src/transforms.js` vs CPython's `sqlglot.transforms`, at the pin.
//
//   python3 spike/p4/gen_transforms_ref.py > spike/out/transforms.json
//   node spike/p4/fuzz_transforms.mjs
//
// WHY THIS PROBE EXISTS INSTEAD OF THE GENERATE ORACLE. `src/transforms.js`'s own file
// header and PORT_PLAN.md R26 explain that these functions are unreachable from
// `corpus/generate_demand.json` today: every consuming corpus row also needs a dialect's
// own `Generator` subclass (`src/generators/` — absent), so `closure_generator.mjs`
// measures a real marginal of 0 no matter which transforms.py function lands. That is a
// REACHABILITY fact, not a CORRECTNESS one, so it says nothing about whether this file's
// ports are right. This probe tests correctness directly: parse a curated SQL case with
// the port's own parser, apply the port's own transform function, and diff the resulting
// tree against CPython doing the same, via the same lossless `astDump`/`astLoad`
// round-trip `fuzz_ast_coverage.mjs` and `fuzz_dialect_parse.mjs` already use.
//
// `resql` in the oracle file is CPython's `result.sql()` and is printed for both sides
// as CONTEXT ONLY, never asserted: `eliminate_distinct_on`'s output contains a `Window`
// projection, and `window_sql` is explicitly out of scope for the P4 "basic SELECT"
// keystone group (PORT_PLAN.md R25) — a `NotPorted` there is an already-known,
// already-tracked gap in `src/generator.js`, not a defect in this file, and asserting it
// here would make an unrelated stub queue fail this probe.

import { readFileSync } from "node:fs";
import { astDump, astLoad, toS } from "../../src/expressions/index.js";
import { Dialect } from "../../src/dialects/dialect.js";
import { captureLogs } from "../../src/logging.js";
import * as transforms from "../../src/transforms.js";
// Side-effect import: registers the real `Generator`-backed `.sql()` hook (see
// src/generator.js's own header comment on `registerGenerator`), so `resql` below
// renders real output where the base Generator already supports it, rather than
// permanently reading the pre-P4 "No SQL generator registered" placeholder.
import "../../src/generator.js";

const VERBOSE = process.argv.includes("--verbose");

const cases = JSON.parse(readFileSync("spike/out/transforms.json", "utf8"));

let exact = 0;
let mismatch = 0;
let error = 0;
const samples = [];

for (const c of cases) {
  const fn = transforms[c.fn];
  if (typeof fn !== "function") {
    error += 1;
    samples.push(`ERROR    ${c.fn} is not exported by src/transforms.js`);
    continue;
  }

  let got;
  let resql = null;
  try {
    const { result } = captureLogs(() => Dialect.get_or_raise(null).parse(c.sql));
    const tree = result[0];
    got = fn(tree);
    try {
      resql = got.sql();
    } catch {
      resql = null; // informational only -- see file header.
    }
  } catch (e) {
    error += 1;
    samples.push(`ERROR    ${c.fn} ${JSON.stringify(c.sql)}\n       ${e.name}: ${String(e.message || e).split("\n")[0].slice(0, 140)}`);
    continue;
  }

  const want = astLoad(c.dump);
  if (JSON.stringify(astDump(got)) === JSON.stringify(astDump(want))) {
    exact += 1;
    if (VERBOSE) {
      console.log(`  EXACT ${c.fn} ${JSON.stringify(c.sql)}`);
      console.log(`    resql (JS)   ${resql}`);
      console.log(`    resql (py)   ${c.resql}`);
    }
  } else {
    mismatch += 1;
    samples.push(
      `MISMATCH ${c.fn} ${JSON.stringify(c.sql)}\n` +
        `       got  ${toS(got).split("\n").join(" ").slice(0, 200)}\n` +
        `       want ${toS(want).split("\n").join(" ").slice(0, 200)}`,
    );
  }
}

console.log();
console.log("  src/transforms.js vs CPython sqlglot.transforms (AST-level, per-function)");
console.log(`    EXACT ${exact} / ${cases.length}    MISMATCH ${mismatch}    ERROR ${error}`);
if (samples.length) {
  console.log();
  for (const s of samples) console.log(`  ${s}`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
