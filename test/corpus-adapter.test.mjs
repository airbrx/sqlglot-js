import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as library from '../index.js';
import { createCorpusAdapter } from './corpus-adapter.mjs';
import { runAtom, loadAtoms } from './runner.mjs';
const adapter = createCorpusAdapter(library);
const atoms = loadAtoms();

test('adapter respects omitted versus explicit default write dialect', () => {
  const sql = 'SELECT IF(x, 1, 2)';
  assert.deepEqual(library.transpile(sql, { read: 'snowflake' }), ['SELECT IFF(x, 1, 2)']);
  assert.equal(adapter(sql, { read: 'snowflake' }).sql, 'SELECT IFF(x, 1, 2)');
  assert.equal(adapter(sql, { read: 'snowflake', write: '' }).sql, 'SELECT CASE WHEN x THEN 1 ELSE 2 END');
});
test('corpus multiple statements are a Block, never silently first-only or an array', () => {
  const result = adapter('SELECT 1; SELECT 2');
  assert.equal(result.error?.method, 'block_sql'); // real remaining port gap
  assert.deepEqual(library.transpile('SELECT 1; SELECT 2'), ['SELECT 1', 'SELECT 2']);
  assert.equal(runAtom({sql:'SELECT 1; SELECT 2', expected:'SELECT 1', read:'', write:''}, adapter).ok, false);
});
test('pretty and identify flow through the real generator', () => {
  const options = { read: 'postgres', write: 'snowflake', pretty: true, identify: true };
  assert.equal(adapter('SELECT x FROM t', options).sql, library.transpile('SELECT x FROM t', options)[0]);
});
for (const id of ['023429360802b69a', '07e9fc8f61a770e4']) {
  test(`real warnings and expected exception are both checked: ${id}`, () => {
    const atom = atoms.find(a => a.atom_id === id);
    assert.equal(runAtom(atom, adapter).ok, true);
    assert.equal(runAtom({...atom, unsupported:[]}, adapter).reason, 'WARNING_MISMATCH');
  });
}
test('unrelated exceptions cannot satisfy UnsupportedError', () => {
  const atom = atoms.find(a => a.raises);
  assert.equal(runAtom(atom, () => { throw new TypeError('broken'); }).reason, 'ERROR');
  assert.equal(runAtom(atom, () => ({sql:'', unsupportedMessages:[]})).reason, 'EXPECTED_ERROR_MISMATCH');
});
test('missing production exports/imports fail, not STUB', () => {
  assert.throws(() => createCorpusAdapter({}), /missing export/);
});

// Spawn the real CLI with a temporary, explicit one-atom ratchet. Deliberately
// mutate the PRODUCTION parse result in an injected module, not a fake assertion.
test('CLI fails on real-library regression, missing files/imports and empty populations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-gate-'));
  try {
    const atom = {atom_id:'temporary-regression', input_id:'temporary-input', expect_hash:'temporary-expectation', sql:'SELECT 1', expected:'SELECT 1', read:'', write:'', pretty:false, identify:false, unsupported:[], raises:false};
    assert.ok(atom);
    const fixture = join(dir, 'atoms.jsonl');
    const ratchet = join(dir, 'ratchet.json');
    writeFileSync(fixture, JSON.stringify(atom) + '\n');
    writeFileSync(ratchet, JSON.stringify({ corpus_atoms:1, pass:[atom.atom_id], baseline:{[atom.input_id]:atom.expect_hash} }));
    const run = (...args) => spawnSync(process.execPath, ['test/runner.mjs', ...args, '--atoms', fixture, '--ratchet', ratchet], { encoding:'utf8' });
    assert.equal(run().status, 0);
    const mutated = join(dir, 'regressed.mjs');
    const url = new URL('../index.js', import.meta.url).href;
    writeFileSync(mutated, `export * from ${JSON.stringify(url)}; import * as real from ${JSON.stringify(url)}; export function parse(sql, opts) { const nodes = real.parse(sql, opts); for (const n of nodes) for (const lit of n.findAll(real.exp.Literal)) lit.set('this','2'); return nodes; }`);
    const regression = run('--library', mutated);
    assert.equal(regression.status, 1);
    assert.match(regression.stdout, /RULE 1/);
    assert.match(regression.stdout, /SQL_MISMATCH/);
    for (const args of [ ['--library', join(dir,'missing.mjs')], ['--atoms',join(dir,'missing.jsonl')], ['--filter','NO_SUCH_SQL'], ['--provenance',join(dir,'missing.json')] ]) {
      const failure = run(...args);
      assert.equal(failure.status, 2, failure.stdout + failure.stderr);
    }
    writeFileSync(fixture, '');
    assert.equal(run().status, 2);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

import { checkRatchetChange } from '../tools/check_ratchet_change.mjs';
test('PR gate rejects pass removal and known expectation changes', () => {
  const before = {pass:['a'],baseline:{i:'h'}};
  assert.equal(checkRatchetChange(before,{pass:[],baseline:{i:'h'}}).ok,false);
  assert.equal(checkRatchetChange(before,{pass:['a'],baseline:{i:'changed'}}).ok,false);
  assert.equal(checkRatchetChange(before,{pass:['a','b'],baseline:{i:'h',j:'x'}}).ok,true);
});
