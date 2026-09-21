import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../tools/v0_scorecard.mjs';
const atoms=[{atom_id:'a',read:'',write:'duckdb'},{atom_id:'b',read:'duckdb',write:''}];
const rows=atoms.map((a,i)=>({...a,reason:i?'STUB':'PASS'}));
test('v0 eligibility is distinct from passes and missing rows fail',()=>{
  const result=summarize(atoms,rows);
  assert.equal(result.eligible,2);assert.equal(result.exact,1);assert.equal(result.STUB,1);
  assert.equal(result.pairs.reduce((n,r)=>n+r.eligible,0),2);
  assert.throws(()=>summarize(atoms,rows.slice(0,1)),/Missing/);
});
test('empty, duplicate, unknown outcomes and changed dialect identities fail closed',()=>{
  assert.throws(()=>summarize([],[]),/Empty/);
  assert.throws(()=>summarize(atoms,[rows[0],rows[0]]),/duplicate/);
  assert.throws(()=>summarize(atoms,[rows[0],{...rows[1],reason:'SKIP'}]),/Unknown outcome/);
  assert.throws(()=>summarize(atoms,[rows[0],{...rows[1],write:'snowflake'}]),/identity/);
});
