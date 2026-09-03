import { readFileSync, readdirSync } from "node:fs";
import { astDump, toS } from "../../src/expressions/index.js";
import { tokenizerFor, standInDialect, parserClassFor } from "./dialect_tokenizer.mjs";
import { captureLogs } from "../../src/logging.js";
const D = process.argv[2] || "snowflake";
const atoms = new Map();
for (const line of readFileSync("corpus/atoms.jsonl","utf8").split("\n")) { if(!line) continue; const a=JSON.parse(line); atoms.set(a.atom_id,a); }
const tk = tokenizerFor(D); const PC = parserClassFor(D);
const out = { mismatch: [], error: [] };
for (const line of readFileSync(`corpus/ast/${D}.jsonl`,"utf8").split("\n")) {
  if (!line) continue;
  const row = JSON.parse(line); const atom = atoms.get(row.atom_id); if (!atom) continue;
  let got;
  try {
    const { tokens } = tk.core.tokenize(atom.sql);
    const p = new PC({ dialect: standInDialect(tk, D) });
    got = captureLogs(() => p.parse(tokens, atom.sql)).result[0];
  } catch (e) {
    if (e.name === "NotPorted") continue;
    out.error.push({ id: row.atom_id, sql: atom.sql, msg: `${e.name}: ${e.message.split("\n")[0]}` });
    continue;
  }
  const want = JSON.stringify(row.ast);
  const have = JSON.stringify(got == null ? null : astDump(got));
  if (have !== want) out.mismatch.push({ id: row.atom_id, sql: atom.sql, got: got?toS(got):"null", want: row.repr });
}
console.log(JSON.stringify(out));
