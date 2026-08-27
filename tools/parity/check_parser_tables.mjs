// Assert `src/parser.js`'s class tables against the full upstream snapshot.
// PORT_PLAN.md §8.1 Rule 2' — one entry per line, upstream declaration order, and the
// ORDER is CI-asserted because §4.6 establishes that insertion order is output-visible.
//
//   node tools/parity/check_parser_tables.mjs
//   node tools/parity/check_parser_tables.mjs --table TYPE_TOKENS   # one table
//   node tools/parity/check_parser_tables.mjs --todo                # burndown only
//
// This is the strong form of parity probe 6, which compares `len()` only and therefore
// cannot distinguish two same-sized tables with different members, nor see order at all.
//
// Three outcomes per entry, kept distinct on purpose:
//   MATCH    seeded and equal to upstream
//   TODO     a callable-valued entry the stub queue has not reached yet. Counted and
//            ratcheted (it may never GROW), never silently tolerated.
//   WRONG    present but not equal, or out of order, or present-but-unexpected.
// Only WRONG fails the build; a TODO that turns into a MATCH is the burndown.

import { readFileSync } from "node:fs";

const SNAP = JSON.parse(readFileSync("corpus/parity/parser_tables.json", "utf8"));

// Some tables are VIEWS over another table rather than literals of their own:
//   QUERY_MODIFIER_TOKENS = set(QUERY_MODIFIER_PARSERS)
//   SHOW_TRIE             = new_trie(k.split(" ") for k in SHOW_PARSERS)
// They are exactly as complete as their source, so their shortfall belongs to the
// SOURCE table's burndown, not to this table's error count. Read the derivation out of
// the seeded source so this stays true as the seeder changes — no hardcoded list.
const PARSER_SRC = readFileSync("src/parser.js", "utf8");
const DERIVED = new Map(
  [...PARSER_SRC.matchAll(/static (\w+) = (?:new Set\(this\.(\w+)\.keys\(\)\)|newTrie\(\[\.\.\.this\.(\w+)\.keys\(\)\])/g)]
    .map((m) => [m[1], m[2] ?? m[3]]),
);
const argv = process.argv.slice(2);
const only = argv.includes("--table") ? argv[argv.indexOf("--table") + 1] : null;
const todoOnly = argv.includes("--todo");

const { Parser } = await import("../../src/parser.js");
const exp = await import("../../src/expressions/index.js");
const { TokenType } = await import("../../src/tokens.js");

// Reverse maps so a runtime value can be rendered in the snapshot's symbolic form.
const TT_NAME = new Map(Object.entries(TokenType).map(([k, v]) => [v, `TokenType.${k}`]));
const EXP_NAME = new Map(
  Object.entries(exp)
    .filter(([, v]) => typeof v === "function")
    .map(([k, v]) => [v, `exp.${k}`]),
);

/** Render a JS table entry in the same symbolic vocabulary the snapshot uses. */
function render(v) {
  if (typeof v === "number" && TT_NAME.has(v)) return TT_NAME.get(v);
  if (v === null || v === undefined) return v === undefined ? null : null;
  if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") return v;
  if (EXP_NAME.has(v)) return EXP_NAME.get(v);
  if (typeof v === "function") return { __callable__: v.name || "<lambda>" };
  if (Array.isArray(v)) return v.map(render);
  if (v instanceof Set) return { __set__: [...v].map((x) => String(render(x))).sort() };
  if (v instanceof Map) {
    return { __dict__: [...v].map(([k, x]) => [renderKey(k), render(x)]) };
  }
  return { __repr__: String(v) };
}

/** Must match `render_key` in extract_parser_tables.py — see its docstring. */
function renderKey(k) {
  const r = render(k);
  return typeof r === "string" ? r : JSON.stringify(r);
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isCallable = (x) => x && typeof x === "object" && "__callable__" in x;

let nMatch = 0;
let nTodo = 0;
const wrong = [];
const missingTables = [];
const perTable = [];

for (const [name, want] of Object.entries(SNAP.tables)) {
  if (only && name !== only) continue;
  const got = Parser[name];
  if (got === undefined) {
    missingTables.push(name);
    continue;
  }

  let match = 0;
  let todo = 0;
  const bad = [];
  const derivedFrom = DERIVED.get(name);

  if (want.kind === "dict") {
    const wantEntries = want.entries.__dict__;
    const gotRendered = render(got);
    const gotEntries = gotRendered.__dict__ ?? [];
    const gotByKey = new Map(gotEntries.map(([k, v]) => [k, v]));

    // Values first...
    for (const [k, v] of wantEntries) {
      if (!gotByKey.has(k)) {
        // A key the port has not seeded. Only a callable-valued one — or one in a table
        // derived from a still-incomplete source — is legitimately pending; a missing
        // literal/symbolic entry is a real defect.
        if (isCallable(v) || derivedFrom) todo += 1;
        else bad.push(`missing key ${k} (value ${JSON.stringify(v)} is not a callable)`);
        continue;
      }
      const g = gotByKey.get(k);
      if (isCallable(v)) {
        // Never compare a lambda's identity — only that the port supplies a callable.
        if (isCallable(g)) match += 1;
        else bad.push(`${k}: expected a callable, got ${JSON.stringify(g)}`);
      } else if (eq(g, v)) {
        match += 1;
      } else {
        bad.push(`${k}: ${JSON.stringify(g)} != ${JSON.stringify(v)}`);
      }
    }
    for (const [k] of gotEntries) {
      if (!wantEntries.some(([wk]) => wk === k)) bad.push(`unexpected key ${k}`);
    }

    // ...then ORDER, over the subset actually present on both sides. Rule 2'.
    const wantOrder = wantEntries.map(([k]) => k).filter((k) => gotByKey.has(k));
    const gotOrder = gotEntries.map(([k]) => k);
    if (!eq(wantOrder, gotOrder)) {
      const at = gotOrder.findIndex((k, i) => k !== wantOrder[i]);
      bad.push(`ORDER diverges at index ${at}: got ${gotOrder[at]}, want ${wantOrder[at]}`);
    }
  } else if (want.kind === "set") {
    // Membership only — a Python set has no insertion order to assert (see the
    // extractor's header). Source order is asserted separately from the source text.
    const g = render(got).__set__ ?? [];
    const w = want.entries.__set__;
    const gs = new Set(g);
    const ws = new Set(w);
    for (const x of w) {
      if (gs.has(x)) match += 1;
      else if (derivedFrom || x.startsWith("<") || x.includes("__callable__")) todo += 1;
      else bad.push(`missing member ${x}`);
    }
    for (const x of g) if (!ws.has(x)) bad.push(`unexpected member ${x}`);
  } else {
    const g = render(got);
    if (eq(g, want.entries)) match += want.size;
    else bad.push(`sequence differs: ${JSON.stringify(g)} != ${JSON.stringify(want.entries)}`);
  }

  nMatch += match;
  nTodo += todo;
  perTable.push({ name, match, todo, bad: bad.length });
  for (const b of bad) wrong.push(`${name}: ${b}`);
}

if (todoOnly) {
  for (const t of perTable.filter((t) => t.todo).sort((a, b) => b.todo - a.todo)) {
    console.log(`  ${String(t.todo).padStart(4)}  ${t.name}`);
  }
  console.log(`\n  ${nTodo} table entries awaiting the stub queue`);
  process.exit(0);
}

console.log(`\n  parser class tables — ${Object.keys(SNAP.tables).length} upstream, ` +
  `${perTable.length} present in src/parser.js`);
console.log(`    entries matched            ${nMatch}`);
console.log(`    entries awaiting stubs     ${nTodo}  (callable-valued)`);
console.log(`    entries WRONG              ${wrong.length}`);
if (missingTables.length) {
  console.log(`    tables absent from port    ${missingTables.length}: ` +
    `${missingTables.slice(0, 8).join(", ")}${missingTables.length > 8 ? ", ..." : ""}`);
}
for (const w of wrong.slice(0, 25)) console.log(`      WRONG  ${w}`);
if (wrong.length > 25) console.log(`      ... and ${wrong.length - 25} more`);

// A table upstream has and the port does not is a seeding bug, not a burndown item:
// the seeder emits every class-level container, so absence means it was dropped.
const fail = wrong.length > 0 || missingTables.length > 0;
console.log(fail ? "\n  PARSER TABLES: FAIL" : "\n  PARSER TABLES: OK");
process.exit(fail ? 1 : 0);
