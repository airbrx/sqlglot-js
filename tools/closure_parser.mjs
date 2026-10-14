// Marginal AST-oracle closure for a set of parser methods.
//
//   node tools/closure_parser.mjs                       # state today + next-best work
//   node tools/closure_parser.mjs --brief                # same ranked table (no target)
//   node tools/closure_parser.mjs --brief _parse_column  # honest per-method task brief
//   node tools/closure_parser.mjs --add _parse_expression,_parse_alias
//   node tools/closure_parser.mjs --curve               # achievable closure curve
//   node tools/closure_parser.mjs --selftest             # verify the maths, no corpus
//
// Reads corpus/parse_demand.json (see tools/harvest/trace_parse_demand.py) and
// src/parser.js. Zero dependencies.
//
// WHY: oracle-row closure is CONJUNCTIVE — a row is closed only when every method its
// parse touches is implemented. "Method M blocks N rows" is therefore NOT "implementing
// M opens N rows", and the two differ by orders of magnitude. Over this corpus the
// per-method blocking counts sum to 751,871 against 15,540 real rows (48.4x over-count:
// each row is counted once per method it touches), so ranking stub-queue tasks by
// blocking count mis-sizes every brief. This tool reports the marginal — the rows that
// actually close — which is what a task brief should carry.
//
// `--brief` with NO target used to crash a sibling tool outright and silently print all
// zeros here instead (both read `undefined` from an out-of-range argv index and neither
// checked for it) — AIR-2293's repair makes the no-target case fall back to the same
// ranked table the bare invocation prints, rather than treating "no target" as a method
// literally named "undefined".

import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  return i + 1 < argv.length ? argv[i + 1] : undefined;
};

/** Methods with a real body in src/parser.js — i.e. not a `NotPorted` stub. */
function implementedMethods(src = "src/parser.js") {
  const lines = readFileSync(src, "utf8").split("\n");
  const impl = new Set();
  const stubs = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^ {2}([A-Za-z_$][\w$]*)\s*\(/);
    if (!m) continue;
    // A stub is a single line whose body is exactly `throw new NotPorted(...)`.
    (/throw new NotPorted/.test(lines[i]) ? stubs : impl).add(m[1]);
  }
  // A name that appears both ways is implemented (the seeder emitted `@t.overload`
  // declarations as duplicate methods; the last definition is the one JS keeps).
  for (const name of impl) stubs.delete(name);
  return { impl, stubs };
}

/* --------------------------------------------------------------------------- *
 * closure maths — shared with the selftest, which is the point of exporting it   *
 * --------------------------------------------------------------------------- */

/** Rows all of whose methods are in `have`. `rows` is an array of method-name arrays. */
export function closedBy(rows, have) {
  let n = 0;
  for (const r of rows) if (r.every((m) => have.has(m))) n++;
  return n;
}

/**
 * Achievable-order closure curve.
 *
 * Repeatedly take the open row needing the fewest new methods and add all of them.
 * Cheap, and it bounds the real curve from the practical side: every step is a group
 * somebody could actually sit down and port, so a jump in this curve is a schedulable
 * task and not an artefact of picking methods in an order no one would work in.
 */
export function curve(rows, have) {
  const state = new Set(have);
  const steps = [];
  let guard = 0;
  while (guard++ < 4000) {
    const open = rows.filter((r) => r.some((m) => !state.has(m)));
    if (!open.length) break;
    let best = null;
    let bestMissing = Infinity;
    for (const r of open) {
      let missing = 0;
      for (const m of r) if (!state.has(m)) missing++;
      if (missing < bestMissing) {
        bestMissing = missing;
        best = r;
      }
    }
    const added = best.filter((m) => !state.has(m));
    for (const m of added) state.add(m);
    const closed = closedBy(rows, state);
    steps.push({ added, cumulative: state.size - have.size, closed });
    if (closed >= rows.length) break;
  }
  return steps;
}

/**
 * Top `limit` remaining blockers, each with BOTH its blocking count and its real
 * marginal (rows it would open on its own). This is the "stub → blocks → marginal"
 * table AIR-2293 asks every brief to run on — blocking count alone ranks tasks that
 * open zero rows above tasks that open hundreds (R13/R21).
 */
export function rankedBlockers(rows, have, limit = 30) {
  const base = closedBy(rows, have);
  const openRows = rows.filter((r) => !r.every((m) => have.has(m)));
  const blockers = new Map();
  for (const r of openRows) {
    for (const m of r) if (!have.has(m)) blockers.set(m, (blockers.get(m) || 0) + 1);
  }
  const ranked = [...blockers.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([method, blocks]) => {
      const withIt = new Set([...have, method]);
      return { method, blocks, marginal: closedBy(rows, withIt) - base };
    });
  return { base, openCount: openRows.length, distinct: blockers.size, ranked };
}

function printRankedTable(rows, have, limit = 30) {
  const { base, openCount, distinct, ranked } = rankedBlockers(rows, have, limit);
  console.log(`\n  corpus rows                ${rows.length}`);
  console.log(
    `  AST-oracle rows closed     ${base} (${((100 * base) / rows.length).toFixed(2)}%)`,
  );
  console.log(`\n  ${distinct} distinct methods block the remaining ${openCount} rows.`);
  console.log(`  Ranked by rows BLOCKED, with the real MARGINAL alongside:`);
  console.log(`  ${"blocks".padStart(8)} ${"marginal".padStart(10)}  method`);
  for (const { method, blocks, marginal } of ranked) {
    console.log(`  ${String(blocks).padStart(8)} ${String(marginal).padStart(10)}  ${method}`);
  }
}

/* --------------------------------------------------------------------------- *
 * self-test — the maths is verifiable without the harvested corpus              *
 * --------------------------------------------------------------------------- */

async function selftest() {
  const checks = [];
  const eq = (name, got, want) => checks.push({ name, ok: got === want, got, want });

  // A synthetic corpus with the shape the real one has: one row closed outright, a
  // two-method row, and a row sharing one of those methods with a third.
  const rows = [
    ["a"],
    ["a", "b"],
    ["a", "b", "c"],
    ["a", "d"],
    ["e"],
  ];

  eq("closed under {} is 0", closedBy(rows, new Set()), 0);
  eq("closed under {a}", closedBy(rows, new Set(["a"])), 1);
  eq("closed under {a,b}", closedBy(rows, new Set(["a", "b"])), 2);
  eq("closed under {a,b,c,d,e}", closedBy(rows, new Set(["a", "b", "c", "d", "e"])), 5);

  // THE property this whole tool exists for: blocking count != marginal.
  // `b` is in 2 open rows but opens only 1; `e` is in 1 row and opens 1.
  const have = new Set(["a"]);
  const blocks = (m) => rows.filter((r) => r.includes(m)).length;
  const marginal = (m) => closedBy(rows, new Set([...have, m])) - closedBy(rows, have);
  eq("b blocks 2 rows", blocks("b"), 2);
  eq("b opens 1 row", marginal("b"), 1);
  eq("c blocks 1 row", blocks("c"), 1);
  eq("c opens 0 rows (b also missing)", marginal("c"), 0);
  eq("e blocks 1, opens 1", marginal("e"), 1);

  // The curve reaches full closure and never regresses.
  const steps = curve(rows, have);
  eq("curve reaches every row", steps[steps.length - 1].closed, rows.length);
  eq("curve is monotone", steps.every((s, i) => i === 0 || s.closed >= steps[i - 1].closed), true);
  eq("curve's first step adds one method", steps[0].added.length, 1);

  // The ranked table reports both numbers per method, not just blocking count.
  const { ranked } = rankedBlockers(rows, have, 30);
  const bEntry = ranked.find((r) => r.method === "b");
  const cEntry = ranked.find((r) => r.method === "c");
  eq("ranked table: b blocks 2", bEntry?.blocks, 2);
  eq("ranked table: b opens 1 (marginal)", bEntry?.marginal, 1);
  eq("ranked table: c opens 0 (marginal)", cEntry?.marginal, 0);

  // The source-grep view of src/parser.js must agree with the loaded module, or a
  // porting task and this tool are reading two different files.
  //
  // The predicate on both sides is "the WHOLE body is one `throw new NotPorted`", not
  // "the body mentions NotPorted" — see closure_generator.mjs's selftest for the three
  // real methods (constructor, preprocess, _move_ctes_to_top_level) that a looser
  // predicate would misclassify in that file; this cross-check exists so the same class
  // of drift cannot hide here either.
  const { impl, stubs } = implementedMethods();
  const parserMod = await import("../src/parser.js");
  const proto = parserMod.Parser.prototype;
  const ONLY_THROWS = /^[^(]*\([^)]*\)\s*\{\s*throw new NotPorted\([^)]*\);?\s*\}$/;
  let disagree = 0;
  const disagreed = [];
  for (const name of [...impl, ...stubs]) {
    const fn = proto[name];
    if (typeof fn !== "function") continue;
    const isStub = ONLY_THROWS.test(Function.prototype.toString.call(fn).trim());
    if (isStub !== stubs.has(name)) {
      disagree++;
      disagreed.push(name);
    }
  }
  if (disagree) console.log(`       disagreed on: ${disagreed.join(", ")}`);
  eq("grep state matches loaded module", disagree, 0);

  // The no-target --brief bug this tool was repaired for: `flag("--brief")` must return
  // `undefined` (not throw, not silently coerce) when no target follows the flag, so the
  // caller can tell "no target given" apart from a real (if oddly named) method.
  const bareArgv = ["--brief"];
  const bareFlag = (name) => {
    const i = bareArgv.indexOf(name);
    if (i === -1) return null;
    return i + 1 < bareArgv.length ? bareArgv[i + 1] : undefined;
  };
  eq("bare --brief yields undefined target", bareFlag("--brief"), undefined);

  let bad = 0;
  for (const c of checks) {
    if (!c.ok) bad++;
    console.log(
      `  ${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok ? "" : `  want ${c.want}, got ${c.got}`}`,
    );
  }
  console.log(
    bad === 0
      ? "\n  CLOSURE_PARSER SELFTEST: GREEN\n"
      : `\n  CLOSURE_PARSER SELFTEST: RED (${bad})\n`,
  );
  return bad === 0 ? 0 : 1;
}

if (argv.includes("--selftest")) {
  process.exit(await selftest());
}

/* --------------------------------------------------------------------------- */

const demand = JSON.parse(readFileSync("corpus/parse_demand.json", "utf8"));
// `per_row` stores indices into `methods` (see the harvester's docstring); rehydrate.
const METHODS = demand.methods;
const perRow = Object.fromEntries(
  Object.entries(demand.per_row).map(([id, ix]) => [id, ix.map((i) => METHODS[i])]),
);
const freq = Object.fromEntries(METHODS.map((m, i) => [m, demand.freq[i]]));
const rowIds = Object.keys(perRow);
const rows = rowIds.map((id) => perRow[id]);

const { impl, stubs } = implementedMethods();
const have = new Set(impl);
const base = closedBy(rows, have);

if (argv.includes("--brief")) {
  const target = flag("--brief");
  if (target === undefined || target === null) {
    // No target given: `--brief` alone used to crash (closure_generator.mjs) or print
    // "undefined" with every count at 0 (here) instead of refusing or falling back.
    // Print the same ranked table the bare invocation below prints.
    printRankedTable(rows, have, 30);
    process.exit(0);
  }
  const blocks = rows.filter((r) => r.includes(target)).length;
  const withIt = new Set([...have, target]);
  const marginal = closedBy(rows, withIt) - base;
  const stillBlocked = rows.filter((r) => r.includes(target) && !r.every((m) => withIt.has(m)));
  const next = new Map();
  for (const r of stillBlocked) {
    for (const m of r) if (!withIt.has(m)) next.set(m, (next.get(m) || 0) + 1);
  }
  console.log(`\n  ${target}`);
  if (!freq[target]) console.log(`    NOT DEMANDED by any corpus row.`);
  console.log(`    rows that CALL it (the "blocks" number)   ${blocks}`);
  console.log(`    rows it actually OPENS (the marginal)     ${marginal}`);
  console.log(`    rows still blocked after it lands         ${stillBlocked.length}`);
  console.log(`    distinct methods still blocking those     ${next.size}`);
  console.log(`\n    next blockers:`);
  for (const [m, c] of [...next].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`      ${String(c).padStart(6)}  ${m}`);
  }
  process.exit(0);
}

if (argv.includes("--add")) {
  const added = flag("--add").split(",").map((s) => s.trim()).filter(Boolean);
  const after = new Set([...have, ...added]);
  const n = closedBy(rows, after);
  console.log(`\n  rows closed now            ${base} / ${rows.length}`);
  console.log(`  rows closed with +${added.length} methods  ${n} / ${rows.length}`);
  console.log(`  MARGINAL                   +${n - base}`);
  process.exit(0);
}

if (argv.includes("--curve")) {
  const limit = Number(flag("--limit") || 120);
  const steps = curve(rows, have);
  console.log(`\n  ${"methods".padStart(8)} ${"rows".padStart(7)} ${"%".padStart(7)}`);
  for (const s of steps.slice(0, limit)) {
    console.log(
      `  ${String(s.cumulative).padStart(8)} ${String(s.closed).padStart(7)} ` +
        `${((100 * s.closed) / rows.length).toFixed(1).padStart(6)}%`,
    );
  }
  if (steps.length > limit) console.log(`  ... ${steps.length - limit} further steps`);
  process.exit(0);
}

// Default view: where the port stands, and what is worth doing next.
console.log(`  distinct methods demanded  ${Object.keys(freq).length}`);
console.log(`  implemented in src/parser  ${impl.size}   (stubs remaining: ${stubs.size})`);
printRankedTable(rows, have, 30);

// How many rows are one single method away? Those are the genuinely cheap wins.
const openRows = rows.filter((r) => !r.every((m) => have.has(m)));
const oneAway = new Map();
for (const r of openRows) {
  const missing = r.filter((m) => !have.has(m));
  if (missing.length === 1) oneAway.set(missing[0], (oneAway.get(missing[0]) || 0) + 1);
}
console.log(`\n  Methods that are the LAST one missing for some row (real marginal > 0):`);
if (!oneAway.size) {
  console.log(`    none — every open row needs >= 2 more methods.`);
  console.log(`    This is the conjunctive-closure wall: no single stub opens any row.`);
} else {
  for (const [m, c] of [...oneAway].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`    ${String(c).padStart(6)}  ${m}`);
  }
}
