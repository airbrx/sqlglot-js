import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRow, checkRows } from '../tools/differential_rows.mjs';
import { parse, Dialect } from '../index.js';
import { astDump } from '../src/expressions/index.js';
import { upstreamKeywords } from '../tools/verification_exclusions.mjs';
const atom = {atom_id:'test',sql:'SELECT 1',read:'',write:''};
const ast = {atom_id:'test',ast:astDump(parse(atom.sql)[0])};
const gen = {atom_id:'test',dialect:'',flags:{},sql:'SELECT 1',unsupported_messages:[]};
const baseline = {population:['test'],pass:['test']};
test('missing AST references remain ERROR rows and fail the gate', () => {
  const row = {atom_id:'test',...evaluateRow('generate',atom,null,gen)};
  assert.equal(row.reason,'ERROR');
  assert.equal(checkRows([row],baseline).ok,false);
});
test('missing rows and empty populations never pass', () => {
  assert.throws(()=>checkRows([],baseline), /Empty/);
  assert.equal(checkRows([{atom_id:'other',reason:'PASS'}],baseline).ok,false);
});
test('real generation compares SQL and warnings; injected regression loses its pass', () => {
  assert.equal(evaluateRow('generate',atom,ast,gen).reason,'PASS');
  assert.equal(evaluateRow('generate',atom,ast,{...gen,unsupported_messages:['required warning']}).kind,'WARNING');
  const original = Dialect.prototype.generator;
  try {
    Dialect.prototype.generator = function(...args) {
      const generator = original.apply(this,args);
      generator.generate = () => 'SELECT 2';
      return generator;
    };
    const row = {atom_id:'test',...evaluateRow('generate',atom,ast,gen)};
    assert.equal(row.kind,'SQL');
    assert.deepEqual(checkRows([row],baseline).regressions,['test']);
  } finally { Dialect.prototype.generator = original; }
});
test('CURRENT_ROLE exclusion refuses any different value rather than masking it', () => {
  assert.throws(()=>upstreamKeywords(new Map([['CURRENT_ROLE',-1]])));
});

test('base AST generation includes foreign read dialects in its denominator', async () => {
  const {spawnSync}=await import('node:child_process');
  const {readFileSync}=await import('node:fs');
  const atoms=readFileSync('corpus/atoms.jsonl','utf8').trim().split('\n').map(JSON.parse);
  const base=atoms.filter(a=>a.write==='');
  assert.ok(base.some(a=>a.read==='mysql')); // Unregistered reader is irrelevant to an AST-fed generator.
  const r=spawnSync(process.execPath,['spike/p4/fuzz_generate_oracle.mjs'],{encoding:'utf8'});
  assert.ok([0,1].includes(r.status),r.stderr);
  assert.match(r.stdout,new RegExp(`generate oracle over ${base.length} reachable rows`));
});
