// Throwaway diagnostic: structurally diff ONE atom's JS AST against the oracle,
// reusing fuzz_ast_coverage.mjs's exact parser/tokenizer setup so the comparison is
// apples-to-apples.
//
//   node spike/p3/diff_atom.mjs <atom_id> [<atom_id> ...]
//   node spike/p3/diff_atom.mjs --sql "CAST(x AS INT)"

import { readFileSync, readdirSync } from "node:fs";
import { astDump } from "../../src/expressions/index.js";
import { Parser } from "../../src/parser.js";
import { tokenizerFor, METHOD_OVERRIDING } from "./dialect_tokenizer.mjs";
import { captureLogs } from "../../src/logging.js";

const argv = process.argv.slice(2);

const atoms = new Map();
for (const line of readFileSync("corpus/atoms.jsonl", "utf8").split("\n")) {
  if (!line) continue;
  const a = JSON.parse(line);
  atoms.set(a.atom_id, a);
}

function parseWith(dialect, sql) {
  const tk = tokenizerFor(dialect);
  const { tokens } = tk.core.tokenize(sql);
  const p = new Parser({
    dialect: { tokenizer_class: { COMMANDS: tk.commands }, VALID_INTERVAL_UNITS: new Set() },
  });
  const { result } = captureLogs(() => p.parse(tokens, sql));
  return result[0];
}

/** First few structural differences, as dotted paths. */
function diff(a, b, path = "", out = []) {
  if (out.length >= 12) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  const prim = (v) => v === null || typeof v !== "object";
  if (prim(a) || prim(b)) {
    out.push(`${path || "<root>"}\n      got  ${JSON.stringify(a)}\n      want ${JSON.stringify(b)}`);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(`${path}.length  got ${a.length} want ${b.length}`
        + `\n      got  ${JSON.stringify(a).slice(0, 160)}\n      want ${JSON.stringify(b).slice(0, 160)}`);
    }
    for (let i = 0; i < Math.max(a.length, b.length); i++) diff(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }
  const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])];
  for (const k of keys) diff(a?.[k], b?.[k], path ? `${path}.${k}` : k, out);
  return out;
}

if (argv[0] === "--sql") {
  const sql = argv[1];
  const got = parseWith("", sql);
  console.log(JSON.stringify(astDump(got), null, 1));
  process.exit(0);
}

const wanted = new Set(argv);
for (const name of readdirSync("corpus/ast")) {
  const dialect = name.slice(0, -6) === "_default" ? "" : name.slice(0, -6);
  if (METHOD_OVERRIDING.has(dialect)) continue;
  if (!tokenizerFor(dialect)) continue;
  for (const line of readFileSync(`corpus/ast/${name}`, "utf8").split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line);
    if (!wanted.has(row.atom_id)) continue;
    const atom = atoms.get(row.atom_id);
    console.log(`\n=== ${row.atom_id} [${dialect || "(default)"}] ${JSON.stringify(atom.sql)}`);
    let got;
    try {
      got = astDump(parseWith(dialect, atom.sql));
    } catch (e) {
      console.log(`  THREW ${e.name}: ${e.message}`);
      console.log(e.stack.split("\n").slice(0, 12).join("\n"));
      continue;
    }
    const d = diff(got, row.ast);
    if (!d.length) console.log("  EXACT");
    else for (const line2 of d) console.log("  DIFF " + line2);
  }
}
