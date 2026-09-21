// Production-path AST and generation probes with COMPLETE row accounting.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { Dialect, parse, exp, ErrorLevel } from '../index.js';
import { astDump, astLoad } from '../src/expressions/index.js';
import { captureLogs } from '../src/logging.js';
export function jsonl(path) {
  const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  if (!rows.length) throw new Error(`Empty fixture: ${path}`);
  return rows;
}
export function indexRows(rows) {
  const index = new Map();
  for (const row of rows) {
    if (!row.atom_id || index.has(row.atom_id)) throw new Error(`Missing/duplicate atom ID: ${row.atom_id}`);
    index.set(row.atom_id, row);
  }
  return index;
}
function pool(dir) {
  const files = readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();
  if (!files.length) throw new Error(`Missing fixtures: ${dir}`);
  // Empty individual dialect files are legal; empty TOTAL population is not.
  const rows = files.flatMap(f => readFileSync(`${dir}/${f}`, 'utf8').split('\n').filter(Boolean).map(JSON.parse));
  if (!rows.length) throw new Error(`Empty fixture population: ${dir}`);
  return indexRows(rows);
}
export function evaluateRow(mode, atom, astRow, genRow) {
  if (!astRow || (mode === 'generate' && !genRow)) return {reason:'ERROR', infrastructure:true, detail:'Missing AST/generate reference'};
  try {
    if (mode === 'parse') {
      const {result: nodes} = captureLogs(() => parse(atom.sql, {read: atom.read}));
      const tree = nodes.length > 1 ? new exp.Block({expressions:nodes}) : nodes[0];
      const got = astDump(tree);
      const want = astRow.ast;
      return JSON.stringify(got) === JSON.stringify(want) ? {reason:'PASS'} : {reason:'MISMATCH', kind:'AST'};
    }
    const tree = astLoad(astRow.ast);
    const generator = Dialect.get_or_raise(genRow.dialect).generator({...genRow.flags, unsupported_level:ErrorLevel.IGNORE});
    const {result: sql} = captureLogs(() => generator.generate(tree));
    if (sql !== genRow.sql) return {reason:'MISMATCH', kind:'SQL', got:sql, want:genRow.sql};
    if (JSON.stringify(generator.unsupported_messages) !== JSON.stringify(genRow.unsupported_messages)) {
      return {reason:'MISMATCH', kind:'WARNING', got:generator.unsupported_messages, want:genRow.unsupported_messages};
    }
    return {reason:'PASS'};
  } catch (error) {
    return {reason:error.name === 'NotPorted' || /Unknown dialect/.test(error.message) ? 'STUB' : 'ERROR', detail:`${error.name}: ${error.message}`};
  }
}
export function checkRows(rows, baseline) {
  if (!rows.length || !baseline.pass.length) throw new Error('Empty evaluated/accepted differential population');
  const byId = indexRows(rows);
  const missing = baseline.population.filter(id => !byId.has(id));
  const population = new Set(baseline.population);
  const newIds = rows.filter(r => !population.has(r.atom_id)).map(r => r.atom_id);
  const regressions = baseline.pass.filter(id => byId.get(id)?.reason !== 'PASS');
  const accepted = new Set(baseline.pass);
  const newPasses = rows.filter(r => r.reason === 'PASS' && !accepted.has(r.atom_id)).map(r => r.atom_id);
  const infrastructure = rows.filter(r => r.infrastructure).map(r => r.atom_id);
  return {ok: !missing.length && !newIds.length && !regressions.length && !infrastructure.length && !newPasses.length, missing, newIds, newPasses, regressions, infrastructure};
}
export function main(mode) {
  const argv = process.argv.slice(2);
  const opt = name => { const i = argv.indexOf(name); return i < 0 ? null : argv[i+1]; };
  const atoms = indexRows(jsonl('corpus/atoms.jsonl'));
  const asts = pool('corpus/ast');
  const gens = pool('corpus/gen');
  // Orphans AND missing references are errors; neither can leave denominators.
  const orphans = [...asts.keys(), ...gens.keys()].filter(id => !atoms.has(id));
  if (orphans.length) throw new Error(`Orphaned references: ${orphans.length}`);
  const rows = [...atoms.values()].map(atom => ({atom_id:atom.atom_id,
    dialect:mode === 'parse' ? atom.read : atom.write,
    ...evaluateRow(mode, atom, asts.get(mode === 'generate' ? gens.get(atom.atom_id)?.ast_ref : atom.atom_id), gens.get(atom.atom_id))}));
  if (opt('--report')) writeFileSync(opt('--report'), rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  for (const dialect of new Set(rows.map(r=>r.dialect))) {
    const selected = rows.filter(r=>r.dialect===dialect);
    const counts = Object.fromEntries(['PASS','MISMATCH','STUB','ERROR'].map(k=>[k,selected.filter(r=>r.reason===k).length]));
    console.log(JSON.stringify({mode,dialect,total:selected.length,...counts,exclusions:0}));
  }
  const counts = Object.fromEntries(['PASS','MISMATCH','STUB','ERROR'].map(k=>[k,rows.filter(r=>r.reason===k).length]));
  console.log(JSON.stringify({mode,total:rows.length,...counts,exclusions:0}));
  if (opt('--propose-baseline')) {
    writeFileSync(opt('--propose-baseline'), JSON.stringify({population:rows.map(r=>r.atom_id).sort(),pass:rows.filter(r=>r.reason==='PASS').map(r=>r.atom_id).sort()},null,1)+'\n');
    console.error('PROPOSAL ONLY: requires review; no gate acceptance');
    process.exitCode = 2;
    return;
  }
  const baseline = JSON.parse(readFileSync(`test/differential-${mode}-baseline.json`, 'utf8'));
  const verdict = checkRows(rows,baseline);
  console.log(`${mode} ROW RATCHET: ${verdict.ok ? 'OK (remaining gaps above; NOT full parity)' : 'FAILED'}`, JSON.stringify(verdict));
  process.exitCode = verdict.ok && (!argv.includes('--strict') || counts.MISMATCH + counts.ERROR + counts.STUB === 0) ? 0 : 1;
}
