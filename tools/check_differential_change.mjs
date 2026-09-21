import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
const base = process.argv[2];
if (!base) throw new Error('Base ref is required');
for (const mode of ['parse','generate']) {
  const path = `test/differential-${mode}-baseline.json`;
  const next = JSON.parse(readFileSync(path,'utf8'));
  // Initial baseline addition only. Invalid/missing base refs must NOT count as absence.
  execFileSync('git',['rev-parse','--verify',`${base}^{commit}`]);
  const exists = spawnSync('git',['cat-file','-e',`${base}:${path}`]);
  if (exists.status !== 0) { console.log(`INITIAL ${mode} baseline: review ${next.pass.length} passing IDs`); continue; }
  const before = JSON.parse(execFileSync('git',['show',`${base}:${path}`],{encoding:'utf8'}));
  for (const key of ['pass','population']) {
    const set = new Set(next[key]);
    const removed = before[key].filter(id=>!set.has(id));
    if (removed.length) throw new Error(`${mode}: cannot delete ${removed.length} accepted ${key} IDs`);
  }
}
