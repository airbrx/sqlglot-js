// Differential: the P3 generator kernel vs CPython's `Expression.sql()`.
//
//   python3 spike/p3/gen_generator_kernel_ref.py > spike/out/generator_kernel.jsonl
//   node spike/p3/fuzz_generator_kernel.mjs
//
// The kernel serves seven parse-path call sites that the corpus reaches ~30 times.
// Checking those 30 strings is exactly the narrow probe that let P2's bugs through
// three review rounds, so this walks EVERY node of EVERY AST-oracle tree and checks
// every node whose class the kernel claims to support — 83,227 of them.
//
// Also asserts that the kernel's declared coverage set and the oracle's are the SAME
// set, so the kernel cannot grow an unverified case and still report green.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { astLoad } from "../../src/expressions/index.js";
import { kernelSql, KERNEL_CLASSES } from "../../src/generator_kernel.js";

const ORACLE_CLASSES = [
  "Boolean", "Column", "Distinct", "EQ", "From", "Identifier", "Literal",
  "Order", "Ordered", "Select", "Table", "Var", "Where",
];
const a = [...KERNEL_CLASSES].sort().join(",");
const b = [...ORACLE_CLASSES].sort().join(",");
if (a !== b) {
  console.error(`  KERNEL_CLASSES and the oracle's set disagree:\n    kernel ${a}\n    oracle ${b}`);
  process.exit(2);
}

let pass = 0;
let refused = 0;
const refusedShapes = new Set();
let total = 0;
const fails = [];
const byClass = new Map();

const rl = createInterface({
  input: createReadStream("spike/out/generator_kernel.jsonl"),
  crlfDelay: Infinity,
});

for await (const line of rl) {
  if (!line) continue;
  const want = JSON.parse(line);
  total += 1;
  const stat = byClass.get(want.cls) || { pass: 0, total: 0 };
  stat.total += 1;

  const node = astLoad(want.ast);
  let got;
  let gotErr = null;
  if (node.constructor.name !== want.cls) {
    gotErr = `ClassMismatch(${node.constructor.name})`;
  } else {
    try {
      got = kernelSql(node);
    } catch (e) {
      gotErr = e.name === "NotPorted" ? "NotPorted" : (e.name || e.constructor.name);
    }
  }

  // The contract is "renders byte-exactly OR refuses loudly", never "renders something
  // plausible". A NotPorted on a node carrying an arg this kernel does not implement is
  // the DESIGNED outcome — the refusals are counted and pinned below so the set cannot
  // silently grow, but they are not defects.
  const ok = gotErr === null ? got === want.sql : gotErr === want.err;
  if (gotErr === "NotPorted" && want.err === null) {
    refused += 1;
    refusedShapes.add(`${want.cls}:${want.dialect}`);
    stat.refused = (stat.refused || 0) + 1;
  } else if (ok) {
    pass += 1;
    stat.pass += 1;
  } else {
    fails.push({
      atom: want.atom_id,
      dialect: want.dialect,
      cls: want.cls,
      got: gotErr ? `<${gotErr}>` : JSON.stringify(got),
      want: want.err ? `<${want.err}>` : JSON.stringify(want.sql),
      repr: want.repr,
    });
  }
  byClass.set(want.cls, stat);
}

console.log(`\n  generator kernel differential: ${pass}/${total} byte-exact, ` +
  `${refused} loudly refused (out-of-scope args), ${fails.length} WRONG`);
for (const cls of KERNEL_CLASSES) {
  const s = byClass.get(cls);
  if (!s) continue;
  const bad = s.total - s.pass - (s.refused || 0);
  const flag = bad === 0 ? "  " : "<-";
  console.log(`    ${flag} ${cls.padEnd(12)} ${String(s.pass).padStart(6)}/${String(s.total).padEnd(6)}` +
    (s.refused ? `  (+${s.refused} refused)` : ""));
}

// Group failures so the report shows DISTINCT defects, not 900 copies of one.
const groups = new Map();
for (const f of fails) {
  const key = `${f.cls}|${f.got}|${f.want}`;
  if (!groups.has(key)) groups.set(key, { ...f, n: 0 });
  groups.get(key).n += 1;
}
const sorted = [...groups.values()].sort((x, y) => y.n - x.n);
for (const g of sorted.slice(0, 12)) {
  console.log(`    FAIL x${g.n} ${g.cls} [${g.dialect}] ${g.atom}`);
  console.log(`         got  ${g.got}`);
  console.log(`         want ${g.want}`);
  console.log(`         node ${g.repr.split("\n").join(" ").slice(0, 150)}`);
}
if (sorted.length > 12) console.log(`    ... and ${sorted.length - 12} more distinct failure shapes`);

// Ratchet: the refusal set is allowed to SHRINK (P4 replaces this kernel) but never to
// grow, so a regression that starts refusing previously-rendered nodes fails here.
const REFUSAL_BUDGET = 20;
const overBudget = refused > REFUSAL_BUDGET;
if (overBudget) {
  console.log(`\n  refusals ${refused} exceed the pinned budget of ${REFUSAL_BUDGET}` +
    ` — shapes: ${[...refusedShapes].sort().join(", ")}`);
}
const bad = fails.length > 0 || overBudget;
console.log(bad ? "\n  GENERATOR KERNEL: FAIL" : "\n  GENERATOR KERNEL: OK");
process.exit(bad ? 1 : 0);
