// Throwaway diagnostic: aggregate EVERY failing row from the AST oracle by signature,
// so work can be prioritised by blast radius instead of by the first 8 rows printed.
// Same parser/tokenizer setup as fuzz_ast_coverage.mjs.
//
//   node spike/p3/profile_failures.mjs            # top error + mismatch signatures
//   node spike/p3/profile_failures.mjs --sig "a.to.a.this"   # sample rows for one sig

import { readFileSync, readdirSync } from "node:fs";
import { astDump } from "../../src/expressions/index.js";
import { Parser } from "../../src/parser.js";
import { tokenizerFor, METHOD_OVERRIDING } from "./dialect_tokenizer.mjs";
import { captureLogs } from "../../src/logging.js";

const argv = process.argv.slice(2);
const SIG = argv.includes("--sig") ? argv[argv.indexOf("--sig") + 1] : null;

const atoms = new Map();
for (const line of readFileSync("corpus/atoms.jsonl", "utf8").split("\n")) {
  if (!line) continue;
  const a = JSON.parse(line);
  atoms.set(a.atom_id, a);
}

/** First differing dotted path, with array indices collapsed so paths aggregate. */
function firstDiff(a, b, path = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  const prim = (v) => v === null || typeof v !== "object";
  if (prim(a) || prim(b)) return { path, a, b };
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = firstDiff(a[i], b[i], `${path}[]`);
      if (d) return d;
    }
    return { path: path + ".<len>", a: a.length, b: b.length };
  }
  for (const k of [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])]) {
    const d = firstDiff(a?.[k], b?.[k], path ? `${path}.${k}` : k);
    if (d) return d;
  }
  return null;
}

const errSig = new Map();
const misSig = new Map();
const samples = new Map();

function bump(map, key, row) {
  map.set(key, (map.get(key) || 0) + 1);
  if (!samples.has(key)) samples.set(key, []);
  const s = samples.get(key);
  if (s.length < 6) s.push(row);
}

for (const name of readdirSync("corpus/ast")) {
  const dialect = name.slice(0, -6) === "_default" ? "" : name.slice(0, -6);
  if (METHOD_OVERRIDING.has(dialect)) continue;
  const tk = tokenizerFor(dialect);
  if (!tk) continue;

  for (const line of readFileSync(`corpus/ast/${name}`, "utf8").split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line);
    const atom = atoms.get(row.atom_id);
    if (!atom) continue;

    let got;
    try {
      const { tokens } = tk.core.tokenize(atom.sql);
      const p = new Parser({
        dialect: { tokenizer_class: { COMMANDS: tk.commands }, VALID_INTERVAL_UNITS: new Set() },
      });
      const { result } = captureLogs(() => p.parse(tokens, atom.sql));
      got = result[0];
    } catch (e) {
      if (e.name === "NotPorted") continue;
      const key = "ERR " + `${e.name}: ${e.message.split("\n")[0].replace(/Line \d+, Col: \d+\./, "").trim()}`;
      bump(errSig, key, { id: row.atom_id, dialect, sql: atom.sql, stack: e.stack });
      continue;
    }

    const have = got === null || got === undefined ? null : astDump(got);
    if (JSON.stringify(have) === JSON.stringify(row.ast)) continue;
    const d = firstDiff(have, row.ast) || { path: "?", a: null, b: null };
    const brief = (v) => {
      const s = JSON.stringify(v);
      return s === undefined ? "undefined" : s.length > 40 ? s.slice(0, 40) + "…" : s;
    };
    bump(misSig, `${d.path}  got=${brief(d.a)} want=${brief(d.b)}`,
      { id: row.atom_id, dialect, sql: atom.sql });
  }
}

if (SIG) {
  for (const [k, rows] of samples) {
    if (!k.includes(SIG)) continue;
    console.log(`\n### ${k}  (${errSig.get(k) ?? misSig.get(k)} rows)`);
    for (const r of rows) {
      console.log(`  ${r.id} [${r.dialect || "default"}] ${JSON.stringify(r.sql.slice(0, 90))}`);
      if (r.stack) console.log(r.stack.split("\n").slice(0, 8).map((l) => "      " + l.trim()).join("\n"));
    }
  }
  process.exit(0);
}

const show = (title, map, n) => {
  const total = [...map.values()].reduce((x, y) => x + y, 0);
  console.log(`\n=== ${title} — ${total} rows, ${map.size} distinct signatures`);
  for (const [k, c] of [...map].sort((a, b) => b[1] - a[1]).slice(0, n)) {
    console.log(`  ${String(c).padStart(5)}  ${k}`);
  }
};
show("ERRORS", errSig, 20);
show("MISMATCHES (first differing path)", misSig, 30);
