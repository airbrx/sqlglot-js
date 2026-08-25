// fuzz_depth — the sixth mandatory P0 fuzz target. PORT_PLAN.md §4.7 / R11 / C1.
//
//   node spike/fuzz_depth.mjs
//
// Python and JS differ here in KIND, not degree: `sys.setrecursionlimit` is tunable at
// runtime, V8's stack is not tunable from library code. `--stack-size` is rejected —
// unavailable to browser consumers, and raising it past the OS thread stack turns a
// clean RangeError into a segfault.
//
// Two jobs:
//   1. MEASURE the engine ceiling for realistic frame shapes. That number sets the
//      DepthLimitError thresholds and goes in CONTRACTS.md §9. Measured, never assumed.
//   2. GENERATE the linear-growth inputs (§4.7's dangerous class: depth ∝ INPUT SIZE,
//      not query nesting) so P4 can run them against parse/generate/generate-pretty.
//
// Until the JS library exists the generated inputs are emitted and their shape asserted;
// the per-path max-N columns stay `pending` in CONTRACTS.md rather than being guessed.

/* ---- 1. engine ceiling per frame shape ------------------------------------ */

// Each probe returns the depth at which it overflows. Binary search would be wrong:
// the ceiling depends on the live stack when the recursion starts, so we measure by
// actually recursing and catching RangeError, warm.
function measure(fn) {
  let depth = 0;
  function run(d) {
    depth = d;
    return fn(run, d);
  }
  try {
    run(1);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
  }
  return depth;
}

const SHAPES = {
  // A bare frame — the theoretical best case, and not representative of anything.
  trivial: (recur, d) => recur(d + 1),

  // Approximates a generator method: several args, several locals, string building.
  // §4.7 measured 4,225 for this shape on Node v22.12.0.
  "generator-like": (recur, d) => {
    const a = d;
    const b = "sep";
    const c = [d, d];
    const e = { k: d };
    let s = "";
    s += b;
    s += String(a);
    s += c.length;
    s += e.k;
    const out = recur(d + 1);
    return s.length + (out ?? 0);
  },

  // Approximates a parser method: backtracking state + a try/catch, which V8 frames
  // differently from a plain call.
  "parser-like": (recur, d) => {
    const index = d;
    const tokens = null;
    let result;
    try {
      result = recur(d + 1);
    } catch (err) {
      if (err instanceof RangeError) throw err;
      result = 0;
    }
    return (result ?? 0) + index + (tokens ? 1 : 0);
  },
};

console.log(`  Node ${process.version}\n`);
console.log("  " + "frame shape".padEnd(20) + "overflow depth".padStart(16));
console.log("  " + "-".repeat(36));
const measured = {};
for (const [name, fn] of Object.entries(SHAPES)) {
  // Take the worst of a few runs: the ceiling varies with the live stack, and a
  // threshold set from an optimistic sample is a threshold that fails in production.
  const runs = [measure(fn), measure(fn), measure(fn)];
  const worst = Math.min(...runs);
  measured[name] = { worst, runs };
  console.log(`  ${name.padEnd(20)}${worst.toLocaleString().padStart(16)}`);
}

/* ---- 2. linear-growth input generators ------------------------------------ */
//
// §4.7: the dangerous class is recursion that grows with INPUT SIZE, not with query
// nesting. Subquery/paren nesting is depth ∝ nesting-depth and is not the concern.

export const GENERATORS = {
  // a OR b OR c ... -> left-nested exp.Or, depth ∝ N
  orChain: (n) => "SELECT 1 WHERE " + Array.from({ length: n }, (_, i) => `c${i} = ${i}`).join(" OR "),

  // SELECT .. UNION ALL SELECT .. -> left-nested exp.Union, depth ∝ N
  unionChain: (n) => Array.from({ length: n }, (_, i) => `SELECT ${i} AS c`).join(" UNION ALL "),

  // VALUES with N rows. The NON-pretty generate path is an iterative join and is safe
  // at any width; only `pretty` builds the left-nested Union chain (generator.py:2742).
  // test_redshift.py:529 asserts the ITERATIVE path at N=10,000, which is exactly why
  // the corpus passes with the recursive path broken.
  wideValues: (n) =>
    "SELECT * FROM (VALUES " + Array.from({ length: n }, (_, i) => `(${i})`).join(", ") + ") AS t(x)",

  // IN list, which some dialects rewrite to an OR chain -> depth ∝ N after rewrite
  inList: (n) => "SELECT 1 WHERE x IN (" + Array.from({ length: n }, (_, i) => i).join(", ") + ")",

  // a + b + c ... -> left-nested exp.Add
  addChain: (n) => "SELECT " + Array.from({ length: n }, (_, i) => `c${i}`).join(" + "),
};

const N_LADDER = [10, 100, 1000, 5000, 10000];

console.log("\n  linear-growth generators (depth grows with N, not nesting):\n");
console.log(
  "  " + "generator".padEnd(14) + N_LADDER.map((n) => `N=${n}`.padStart(12)).join(""),
);
console.log("  " + "-".repeat(14 + 12 * N_LADDER.length));
let shapeBad = 0;
for (const [name, gen] of Object.entries(GENERATORS)) {
  const cells = [];
  for (const n of N_LADDER) {
    const sql = gen(n);
    cells.push(`${(sql.length / 1024).toFixed(0)}KB`.padStart(12));
    // Assert the generator actually scales linearly — a generator that silently
    // produces a constant-size string would make this whole target vacuous.
    if (n > 10 && sql.length < 2 * gen(10).length) shapeBad++;
  }
  console.log(`  ${name.padEnd(14)}${cells.join("")}`);
}

// upstream ships test_redshift.py:524 at N=10,000
const UPSTREAM_MAX_N = 10000;
const realistic = measured["generator-like"].worst;

console.log(`\n  upstream ships a test at N=${UPSTREAM_MAX_N.toLocaleString()} (test_redshift.py:524)`);
console.log(`  realistic JS generator frame overflows at depth ${realistic.toLocaleString()}`);
console.log(
  realistic < UPSTREAM_MAX_N
    ? `  => the recursive path CANNOT reach upstream's N without trampolines (§4.7 item 3)`
    : `  => headroom exists, but the threshold must still be enforced explicitly`,
);

// Threshold with margin, per §4.7 item 2. Deliberately conservative: DepthLimitError
// must fire BEFORE V8's RangeError, because unwinding mid-generate is not a supported
// recovery path.
const THRESHOLD = Math.floor(realistic * 0.6);
console.log(`\n  suggested DepthLimitError threshold: ${THRESHOLD.toLocaleString()} (0.6 x measured)`);

const summary = {
  node_version: process.version,
  measured,
  suggested_depth_limit: THRESHOLD,
  upstream_max_n: UPSTREAM_MAX_N,
  generators: Object.keys(GENERATORS),
  n_ladder: N_LADDER,
};
const { writeFileSync, mkdirSync } = await import("node:fs");
mkdirSync("spike/out", { recursive: true });
writeFileSync("spike/out/depth_summary.json", JSON.stringify(summary, null, 2));
console.log("  wrote spike/out/depth_summary.json");

console.log(
  shapeBad === 0
    ? "\n  FUZZ_DEPTH: measured (per-path max-N pending the JS generator at P4)\n"
    : `\n  FUZZ_DEPTH: RED — ${shapeBad} generators do not scale with N\n`,
);
process.exit(shapeBad === 0 ? 0 : 1);
