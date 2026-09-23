// AIR-2163: strict pinned AST/generation oracle, no success-on-nonzero-exact shortcut.
import { readFileSync } from 'node:fs';
import { Dialect, ErrorLevel, exp } from '../../index.js';
import { captureLogs } from '../../src/logging.js';
const rows = JSON.parse(readFileSync('spike/out/gateway_regressions.json', 'utf8'));
if (rows.length !== 263 || new Set(rows.map(r => r.id)).size !== 263) throw new Error('Missing/duplicate AIR-2163 oracle rows');
function dump(n) {
  if (n instanceof exp.Expr) return { c: n.constructor.name, a: Object.entries(n.args).map(([k,v]) => [k,dump(v)]), m: n._meta || null, cm: n.comments?.length ? n.comments : null };
  return Array.isArray(n) ? n.map(dump) : n;
}
let exact=0, mismatch=0, error=0;
for (const row of rows) {
  let got, generator;
  try {
    const d = Dialect.get_or_raise(row.dialect);
    if (row.kind === 'parse') got = { ast: dump(captureLogs(() => d.parse(row.input)[0]).result) };
    else {
      generator = d.generator({ pretty: row.pretty, identify: row.pretty, unsupported_level: ErrorLevel.IGNORE });
      got = { sql: captureLogs(() => generator.generate(exp.astLoad(row.ast))).result };
    }
  } catch (e) { got = { error: e.name.replace(/^Py/, ''), message: e.message }; }
  if (row.kind === 'generate') got.unsupported_messages = generator?.unsupported_messages || [];
  if (JSON.stringify(got) === JSON.stringify(row.expected)) exact++;
  else { if (got.error && !row.expected.error) error++; else mismatch++; console.error(JSON.stringify({id:row.id,got,want:row.expected})); }
}
console.log(`AIR-2163: TOTAL ${rows.length}, EXACT ${exact}, MISMATCH ${mismatch}, ERROR ${error}, EXCLUDED 0`);
process.exitCode = mismatch + error === 0 ? 0 : 1;
