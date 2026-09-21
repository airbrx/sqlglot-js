// Full-population v0 measurement, NOT a new baseline acceptance command.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadAtoms, runAtom, resolveTranspile, V0_DIALECTS } from '../test/runner.mjs';
import { captureLogs } from '../src/logging.js';
const reasons = ['PASS','PASS_EXPECTED_ERROR','STUB','ERROR','SQL_MISMATCH','WARNING_MISMATCH','EXPECTED_ERROR_MISMATCH'];
export function summarize(atoms,rows) {
  if (!atoms.length || !rows.length) throw new Error('Empty scorecard population');
  const expected=new Map(atoms.map(a=>[a.atom_id,a]));
  if(expected.size!==atoms.length) throw new Error('Duplicate atom IDs');
  const seen=new Set();
  const counts=selected=>Object.fromEntries(reasons.map(reason=>[reason,selected.filter(r=>r.reason===reason).length]));
  for(const row of rows) {
    const atom=expected.get(row.atom_id);
    if(!atom || seen.has(row.atom_id)) throw new Error('Unknown/duplicate outcome ID');
    if(row.read!==atom.read || row.write!==atom.write) throw new Error('Outcome dialect identity changed');
    if(!reasons.includes(row.reason)) throw new Error(`Unknown outcome: ${row.reason}`);
    seen.add(row.atom_id);
  }
  if(seen.size!==expected.size) throw new Error(`Missing ${expected.size-seen.size} outcomes`);
  const group=selected=>({eligible:selected.length,exact:selected.filter(r=>r.reason.startsWith('PASS')).length,...counts(selected)});
  const firstBlockers=new Map();
  for(const row of rows.filter(r=>r.reason==='STUB')) {
    const method=row.detail?.split(' is not')[0] || '(unknown stub)';
    const ids=firstBlockers.get(method) || [];ids.push(row.atom_id);firstBlockers.set(method,ids);
  }
  return {scope:'v0 dialect-pair eligibility, NOT customer-query coverage',
    dialects:[...V0_DIALECTS],exclusions:0,...group(rows),
    byWrite:[...V0_DIALECTS].map(write=>({write,...group(rows.filter(r=>r.write===write))})),
    pairs:[...V0_DIALECTS].flatMap(read=>[...V0_DIALECTS].map(write=>({read,write,...group(rows.filter(r=>r.read===read&&r.write===write))}))),
    firstBlockers:[...firstBlockers].map(([method,ids])=>({method,count:ids.length,ids})).sort((a,b)=>b.count-a.count)};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(!process.argv[2] || !process.argv[3]) throw new Error('Usage: node tools/v0_scorecard.mjs SUMMARY.json ALL_ROWS.jsonl');
  const all=loadAtoms();
  const atoms=all.filter(a=>V0_DIALECTS.has(a.read)&&V0_DIALECTS.has(a.write));
  const adapter=await resolveTranspile();
  const rows=captureLogs(()=>atoms.map(a=>({atom_id:a.atom_id,read:a.read,write:a.write,...runAtom(a,adapter)}))).result;
  const summary={corpusPopulation:all.length,notV0Eligible:all.length-atoms.length,...summarize(atoms,rows)};
  writeFileSync(process.argv[2],JSON.stringify(summary,null,2)+'\n');
  writeFileSync(process.argv[3],rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  console.log(JSON.stringify({total:summary.eligible,exact:summary.exact,exclusions:summary.exclusions,...Object.fromEntries(reasons.map(k=>[k,summary[k]]))}));
  console.log('MEASUREMENT ONLY: does not accept passes or assert full parity; inspect every mismatch/error category.');
}
