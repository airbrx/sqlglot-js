// PR-relative monotonicity. A PR cannot "fix" a regression by dropping its pass ID
// or editing an already accepted expectation. Initial additions require PR review.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
export function checkRatchetChange(before, after) {
  const next = new Set(after.pass);
  const removed = before.pass.filter(id => !next.has(id));
  const changed = Object.entries(before.baseline).filter(([key, value]) => after.baseline[key] !== value).map(([key]) => key);
  return { ok: !removed.length && !changed.length, removed, changed };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.argv[2];
  if (!base) throw new Error('Usage: node tools/check_ratchet_change.mjs <base-ref>');
  const before = JSON.parse(execFileSync('git', ['show', `${base}:test/ratchet.json`], {encoding:'utf8'}));
  const after = JSON.parse(readFileSync('test/ratchet.json', 'utf8'));
  const result = checkRatchetChange(before, after);
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
