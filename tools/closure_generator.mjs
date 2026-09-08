// Marginal generate-oracle closure for a set of generator units.
//
//   node tools/closure_generator.mjs                        # state today + next-best work
//   node tools/closure_generator.mjs --add select_sql,cast_sql
//   node tools/closure_generator.mjs --curve                # achievable closure curve
//   node tools/closure_generator.mjs --brief select_sql     # honest per-unit task brief
//   node tools/closure_generator.mjs --selftest             # verify the maths, no corpus
//
// Reads corpus/generate_demand.json (see tools/harvest/trace_generate_demand.py) and
// src/generator.js. Zero dependencies.
//
// WHY: generate-oracle row closure is CONJUNCTIVE — a row is closed only when every
// unit its generation touches is ported. "Unit U blocks N rows" is therefore NOT
// "porting U opens N rows", and the two differ by orders of magnitude. Over this corpus
// the per-unit blocking counts sum to 1,090,846 against 15,540 real rows (70.2x
// over-count: each row is counted once per unit it touches), so ranking a stub queue by
// blocking count mis-sizes every brief. This tool reports the marginal — the rows that
// actually close — which is what a task brief should carry. That is `closure_parser.mjs`
// (PORT_PLAN.md R13/R21), applied to the generator.
//
// WHAT A "UNIT" IS, and why it is not just a method. `closure_parser.mjs` scores
// methods, because the parser's demand is methods. The generator's is not:
//
//   select_sql                     a base `Generator` method
//   TRANSFORMS[Ceil]               a base `Generator.TRANSFORMS` entry
//   SnowflakeGenerator.select_sql  a DIALECT generator's own method
//   transforms.eliminate_qualify   a `sqlglot/transforms.py` function
//
// The last two are whole components that do not exist in this port yet (`src/generators/`
// and `src/transforms.js` are both absent), so they are honestly unimplementable rather
// than merely unimplemented, and the default view says so instead of quietly counting
// their rows as one method away. R14/R17/R19 are three successive findings that a table,
// an entry, and a table's reader are each invisible to a counter that only knows about
// methods; scoring TRANSFORMS entries as units is the counter those findings asked for.

import { existsSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

/* --------------------------------------------------------------------------- *
 * unit taxonomy                                                                 *
 * --------------------------------------------------------------------------- */

const DIALECT_UNIT = /^([A-Za-z0-9_]+Generator)\.(.+)$/;
const TRANSFORMS_UNIT = /^TRANSFORMS\[([A-Za-z0-9_]+)\]$/;
const DIALECT_NEEDED = /^dialect:(.+)$/;

/** `base-method` | `base-transforms` | `dialect` | `transforms.py` | `dialect-name`. */
export function unitKind(name) {
  if (name.startsWith("transforms.")) return "transforms.py";
  if (DIALECT_NEEDED.test(name)) return "dialect-name";
  if (DIALECT_UNIT.test(name)) return "dialect";
  if (TRANSFORMS_UNIT.test(name)) return "base-transforms";
  return "base-method";
}

/* --------------------------------------------------------------------------- *
 * what src/generator.js actually implements today                               *
 * --------------------------------------------------------------------------- */

/**
 * Base `Generator` methods with a real body — i.e. not a `NotPorted` stub.
 *
 * Same rule and same regex as `closure_parser.mjs`: a stub is a single line whose body
 * is exactly `throw new NotPorted(...)`. Deliberately a grep and not an import, for the
 * reason that file gives — the check has to describe the SOURCE a porting task edits,
 * and `--selftest` cross-checks it against the loaded module so the two cannot drift.
 */
function implementedMethods(src = "src/generator.js") {
  const lines = readFileSync(src, "utf8").split("\n");
  const impl = new Set();
  const stubs = new Set();
  for (const line of lines) {
    const m = line.match(/^ {2}([A-Za-z_$][\w$]*)\s*\(/);
    if (!m) continue;
    (/throw new NotPorted/.test(line) ? stubs : impl).add(m[1]);
  }
  // A name that appears both ways is implemented (the seeder emitted `@t.overload`
  // declarations as duplicate methods; the last definition is the one JS keeps).
  for (const name of impl) stubs.delete(name);
  return { impl, stubs };
}

/**
 * Expression-class names present as keys in the port's `Generator.TRANSFORMS`.
 *
 * Imported rather than grepped, because a TRANSFORMS key is an expression CLASS and the
 * only faithful question is "does the resolved Map hold it" — the same question
 * `_buildDispatch` asks. Names come back through `exp.EXPR_CLASSES` (keyed by upstream's
 * lowercased class key, 1,048 entries, no case collisions) rather than through
 * `constructor.name`, because `defineExpr` flattens the MRO and class identity is the
 * only reliable handle on a generated class.
 */
async function implementedTransforms() {
  const gen = await import("../src/generator.js");
  const exp = await import("../src/expressions/index.js");
  const nameOf = new Map();
  for (const [key, cls] of Object.entries(exp.EXPR_CLASSES)) nameOf.set(cls, key);
  const names = new Set();
  for (const key of gen.Generator.TRANSFORMS.keys()) {
    const name = nameOf.get(key);
    if (name !== undefined) names.add(name);
  }
  return names;
}

/**
 * The set of units this port can satisfy today.
 *
 * `src/generators/` and `src/transforms.js` are checked for EXISTENCE rather than
 * hardcoded absent: R18's lesson is that "nothing reaches this yet" expires silently,
 * and a tool that hardcodes today's answer keeps reporting it after the component lands.
 */
async function haveSet() {
  const { impl, stubs } = implementedMethods();
  const transforms = await implementedTransforms();
  const hasDialectGenerators = existsSync("src/generators");
  const hasTransformsModule = existsSync("src/transforms.js");

  // Whether the port can resolve a dialect BY NAME. Asked of the real registry rather
  // than assumed, for the same reason as the two `existsSync` checks: P5 registers these
  // and this tool must start counting them the day it does, not the day someone notices.
  const { Dialect } = await import("../src/dialects/dialect.js");
  const resolvable = (name) => {
    try {
      Dialect.get_or_raise(name);
      return true;
    } catch {
      return false;
    }
  };
  const dialectCache = new Map();

  const have = new Set();
  const satisfied = (unit) => {
    switch (unitKind(unit)) {
      case "base-method":
        return impl.has(unit);
      case "base-transforms":
        return transforms.has(unit.match(TRANSFORMS_UNIT)[1].toLowerCase());
      case "dialect":
        return hasDialectGenerators;
      case "transforms.py":
        return hasTransformsModule;
      case "dialect-name": {
        const name = unit.match(DIALECT_NEEDED)[1];
        if (!dialectCache.has(name)) dialectCache.set(name, resolvable(name));
        return dialectCache.get(name);
      }
    }
    return false;
  };
  return {
    have, satisfied, impl, stubs, transforms,
    hasDialectGenerators, hasTransformsModule, dialectCache,
  };
}

/* --------------------------------------------------------------------------- *
 * closure maths — shared with the selftest, which is the point of exporting it   *
 * --------------------------------------------------------------------------- */

/** Rows all of whose units are in `have`. `rows` is an array of unit-name arrays. */
export function closedBy(rows, have) {
  let n = 0;
  for (const r of rows) if (r.every((u) => have.has(u))) n++;
  return n;
}

/**
 * Achievable-order closure curve.
 *
 * Repeatedly take the open row needing the fewest new units and add all of them. Cheap,
 * and it bounds the real curve from the practical side: every step is a group somebody
 * could actually sit down and port, so a jump in this curve is a schedulable task and
 * not an artefact of picking units in an order no one would work in.
 */
export function curve(rows, have) {
  const state = new Set(have);
  const steps = [];
  let guard = 0;
  while (guard++ < 8000) {
    const open = rows.filter((r) => r.some((u) => !state.has(u)));
    if (!open.length) break;
    let best = null;
    let bestMissing = Infinity;
    for (const r of open) {
      let missing = 0;
      for (const u of r) if (!state.has(u)) missing++;
      if (missing < bestMissing) {
        bestMissing = missing;
        best = r;
      }
    }
    const added = best.filter((u) => !state.has(u));
    for (const u of added) state.add(u);
    const closed = closedBy(rows, state);
    steps.push({ added, cumulative: state.size - have.size, closed });
    if (closed >= rows.length) break;
  }
  return steps;
}

/* --------------------------------------------------------------------------- *
 * self-test — the maths is verifiable without the harvested corpus              *
 * --------------------------------------------------------------------------- */

async function selftest() {
  const checks = [];
  const eq = (name, got, want) => checks.push({ name, ok: got === want, got, want });

  // A synthetic corpus with the shape the real one has: one row closed outright, a
  // two-unit row, and a row sharing one of those units with a third.
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
  const blocks = (u) => rows.filter((r) => r.includes(u)).length;
  const marginal = (u) => closedBy(rows, new Set([...have, u])) - closedBy(rows, have);
  eq("b blocks 2 rows", blocks("b"), 2);
  eq("b opens 1 row", marginal("b"), 1);
  eq("c blocks 1 row", blocks("c"), 1);
  eq("c opens 0 rows (b also missing)", marginal("c"), 0);
  eq("e blocks 1, opens 1", marginal("e"), 1);

  // The curve reaches full closure and never regresses.
  const steps = curve(rows, have);
  eq("curve reaches every row", steps[steps.length - 1].closed, rows.length);
  eq("curve is monotone", steps.every((s, i) => i === 0 || s.closed >= steps[i - 1].closed), true);
  // Achievable order takes the cheapest open row first: {e} or {b}, never {b,c} first.
  eq("curve's first step adds one unit", steps[0].added.length, 1);

  // Unit taxonomy — the classification the default view's honesty rests on.
  eq("base method", unitKind("select_sql"), "base-method");
  eq("base TRANSFORMS", unitKind("TRANSFORMS[Ceil]"), "base-transforms");
  eq("dialect method", unitKind("SnowflakeGenerator.select_sql"), "dialect");
  eq("dialect TRANSFORMS", unitKind("TSQLGenerator.TRANSFORMS[Select]"), "dialect");
  eq("transforms.py fn", unitKind("transforms.eliminate_qualify"), "transforms.py");
  eq("dialect precondition", unitKind("dialect:snowflake"), "dialect-name");
  // Version-suffixed dialect names really occur in this corpus ("postgres, version=15").
  eq("versioned dialect", unitKind("dialect:clickhouse, version=23.8"), "dialect-name");

  // The source-grep view of src/generator.js must agree with the loaded module, or a
  // porting task and this tool are reading two different files. This is the check
  // R13 would have wanted: the state reader is verified against reality, not trusted.
  //
  // The predicate on both sides is "the WHOLE body is one `throw new NotPorted`", not
  // "the body mentions NotPorted". Three real methods — `constructor`, `preprocess`
  // (py:981 `ENSURE_BOOLS`) and `_move_ctes_to_top_level` — are ported bodies carrying a
  // GUARDED throw for a branch the base class cannot reach, and the loose predicate
  // scores all three as stubs. That also means the file header's
  // `grep -c NotPorted src/generator.js` burndown over-counts by exactly these 3.
  const { impl, stubs } = implementedMethods();
  const gen = await import("../src/generator.js");
  const proto = gen.Generator.prototype;
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

  let bad = 0;
  for (const c of checks) {
    if (!c.ok) bad++;
    console.log(
      `  ${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok ? "" : `  want ${c.want}, got ${c.got}`}`,
    );
  }
  console.log(
    bad === 0
      ? "\n  CLOSURE_GENERATOR SELFTEST: GREEN\n"
      : `\n  CLOSURE_GENERATOR SELFTEST: RED (${bad})\n`,
  );
  return bad === 0 ? 0 : 1;
}

if (argv.includes("--selftest")) {
  process.exit(await selftest());
}

/* --------------------------------------------------------------------------- */

const demand = JSON.parse(readFileSync("corpus/generate_demand.json", "utf8"));
// `per_row` stores indices into `units` (see the harvester's docstring); rehydrate.
const UNITS = demand.units;
const perRow = Object.fromEntries(
  Object.entries(demand.per_row).map(([id, ix]) => [id, ix.map((i) => UNITS[i])]),
);
const freq = Object.fromEntries(UNITS.map((u, i) => [u, demand.freq[i]]));
const rowIds = Object.keys(perRow);
const rows = rowIds.map((id) => perRow[id]);

const state = await haveSet();
// Only units the corpus actually demands need scoring; `have` is the satisfied subset.
for (const u of UNITS) if (state.satisfied(u)) state.have.add(u);
const have = state.have;
const base = closedBy(rows, have);

if (argv.includes("--brief")) {
  const target = flag("--brief");
  const blocks = rows.filter((r) => r.includes(target)).length;
  const withIt = new Set([...have, target]);
  const marginal = closedBy(rows, withIt) - base;
  const stillBlocked = rows.filter(
    (r) => r.includes(target) && !r.every((u) => withIt.has(u)),
  );
  const next = new Map();
  for (const r of stillBlocked) {
    for (const u of r) if (!withIt.has(u)) next.set(u, (next.get(u) || 0) + 1);
  }
  console.log(`\n  ${target}   [${unitKind(target)}]`);
  if (!freq[target]) console.log(`    NOT DEMANDED by any corpus row.`);
  console.log(`    rows that CALL it (the "blocks" number)   ${blocks}`);
  console.log(`    rows it actually OPENS (the marginal)     ${marginal}`);
  console.log(`    rows still blocked after it lands         ${stillBlocked.length}`);
  console.log(`    distinct units still blocking those       ${next.size}`);
  console.log(`\n    next blockers:`);
  for (const [u, c] of [...next].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`      ${String(c).padStart(6)}  ${u}`);
  }
  process.exit(0);
}

if (argv.includes("--add")) {
  const added = flag("--add").split(",").map((s) => s.trim()).filter(Boolean);
  const after = new Set([...have, ...added]);
  const n = closedBy(rows, after);
  console.log(`\n  rows closed now            ${base} / ${rows.length}`);
  console.log(`  rows closed with +${added.length} units    ${n} / ${rows.length}`);
  console.log(`  MARGINAL                   +${n - base}`);
  process.exit(0);
}

if (argv.includes("--curve")) {
  const limit = Number(flag("--limit") || 120);
  const steps = curve(rows, have);
  console.log(`\n  ${"+units".padStart(8)} ${"rows".padStart(7)} ${"%".padStart(7)}   step`);
  let prev = base;
  for (const s of steps.slice(0, limit)) {
    const pct = (100 * s.closed) / rows.length;
    const jump = s.closed - prev;
    prev = s.closed;
    const label = s.added.length <= 4 ? s.added.join(", ") : `${s.added.length} units`;
    console.log(
      `  ${String(s.cumulative).padStart(8)} ${String(s.closed).padStart(7)} ` +
        `${pct.toFixed(1).padStart(6)}%   ${jump > 0 ? `+${jump}` : "  "}\t${label}`,
    );
  }
  if (steps.length > limit) console.log(`  ... ${steps.length - limit} further steps`);
  process.exit(0);
}

// Default view: where the port stands, and what is worth doing next.
const byKind = new Map();
for (const u of UNITS) {
  const k = unitKind(u);
  const e = byKind.get(k) || { total: 0, have: 0 };
  e.total++;
  if (have.has(u)) e.have++;
  byKind.set(k, e);
}

console.log(`\n  corpus rows                ${rows.length}`);
console.log(`  distinct units demanded    ${UNITS.length}`);
for (const [k, e] of byKind) {
  console.log(`    ${k.padEnd(16)} ${String(e.have).padStart(5)} / ${String(e.total).padEnd(5)} available`);
}
console.log(`  implemented in src/generator.js  ${state.impl.size}   (stubs remaining: ${state.stubs.size})`);
console.log(`  Generator.TRANSFORMS entries     ${state.transforms.size}`);
if (!state.hasDialectGenerators) {
  console.log(`  src/generators/  ABSENT — every dialect unit is unreachable, not merely unported.`);
}
if (!state.hasTransformsModule) {
  console.log(`  src/transforms.js ABSENT — every transforms.py unit is likewise unreachable.`);
}
{
  const named = [...state.dialectCache.entries()];
  const ok = named.filter(([, v]) => v).length;
  console.log(
    `  dialects resolvable by name      ${ok} / ${named.length}` +
      (ok === 0 ? "  — P5 registers these; until then a named-dialect row cannot be generated at all." : ""),
  );
}
console.log(`  generate-oracle rows closed  ${base} (${((100 * base) / rows.length).toFixed(2)}%)`);

const openRows = rows.filter((r) => !r.every((u) => have.has(u)));
const blockers = new Map();
for (const r of openRows) {
  for (const u of r) if (!have.has(u)) blockers.set(u, (blockers.get(u) || 0) + 1);
}
console.log(`\n  ${blockers.size} distinct units block the remaining ${openRows.length} rows.`);
console.log(`  Ranked by rows BLOCKED (note: this is NOT the marginal — see --brief):`);
for (const [u, c] of [...blockers].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`    ${String(c).padStart(6)}  ${u}   [${unitKind(u)}]`);
}

// How many rows are one single unit away? Those are the genuinely cheap wins.
const oneAway = new Map();
for (const r of openRows) {
  const missing = r.filter((u) => !have.has(u));
  if (missing.length === 1) oneAway.set(missing[0], (oneAway.get(missing[0]) || 0) + 1);
}
console.log(`\n  Units that are the LAST one missing for some row (real marginal > 0):`);
if (!oneAway.size) {
  console.log(`    none — every open row needs >= 2 more units.`);
  console.log(`    This is the conjunctive-closure wall: no single stub opens any row.`);
  console.log(`    Use --curve to find the smallest GROUP that does.`);
} else {
  for (const [u, c] of [...oneAway].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`    ${String(c).padStart(6)}  ${u}   [${unitKind(u)}]`);
  }
}
