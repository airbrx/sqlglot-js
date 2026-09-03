import { readFileSync } from "node:fs";
import { astDump } from "../../src/expressions/index.js";
import { tokenizerFor, standInDialect, parserClassFor } from "./dialect_tokenizer.mjs";
import { captureLogs } from "../../src/logging.js";
const D = "snowflake";
const atoms = new Map();
for (const l of readFileSync("corpus/atoms.jsonl","utf8").split("\n")) { if(!l) continue; const a=JSON.parse(l); atoms.set(a.atom_id,a); }
const tk = tokenizerFor(D), PC = parserClassFor(D);
function firstDiff(a, b, path="") {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && a.c && b.c) {
    if (a.c !== b.c) return `${path}: class ${a.c} vs ${b.c}`;
    const ka = (a.a||[]).map(x=>x[0]), kb = (b.a||[]).map(x=>x[0]);
    if (JSON.stringify(ka) !== JSON.stringify(kb)) return `${path}/${a.c}: argkeys [${ka}] vs [${kb}]`;
    for (let i=0;i<ka.length;i++){ const d=firstDiff(a.a[i][1], b.a[i][1], `${path}/${a.c}.${ka[i]}`); if(d) return d; }
    if (JSON.stringify(a.m)!==JSON.stringify(b.m)) return `${path}/${a.c}: meta ${JSON.stringify(a.m)} vs ${JSON.stringify(b.m)}`;
    if (JSON.stringify(a.cm)!==JSON.stringify(b.cm)) return `${path}/${a.c}: comments`;
    if (JSON.stringify(a.t)!==JSON.stringify(b.t)) return `${path}/${a.c}: _type ${JSON.stringify(a.t)} vs ${JSON.stringify(b.t)}`;
    return `${path}/${a.c}: ???`;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: len ${a.length} vs ${b.length}`;
    for (let i=0;i<a.length;i++){ const d=firstDiff(a[i],b[i],`${path}[${i}]`); if(d) return d; }
  }
  return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}
const groups = new Map();
for (const l of readFileSync(`corpus/ast/${D}.jsonl`,"utf8").split("\n")) {
  if (!l) continue; const row=JSON.parse(l); const atom=atoms.get(row.atom_id); if(!atom) continue;
  let got; try { const p=new PC({dialect:standInDialect(tk,D)}); got=captureLogs(()=>p.parse(tk.core.tokenize(atom.sql).tokens,atom.sql)).result[0]; } catch { continue; }
  const have = got==null?null:astDump(got);
  if (JSON.stringify(have)===JSON.stringify(row.ast)) continue;
  const key = firstDiff(have, row.ast) || "?";
  groups.set(key, (groups.get(key)||[]).concat([atom.sql]));
}
for (const [k,v] of [...groups].sort((a,b)=>b[1].length-a[1].length).slice(0,25))
  console.log(String(v.length).padStart(4), k.slice(0,150), "|", JSON.stringify(v[0].replace(/\n/g," ").slice(0,50)));
