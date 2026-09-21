// Strict negation differential: every row counts, all mismatches/errors fail.
import { readFileSync } from 'node:fs';
import { Dialect, parse, ErrorLevel } from '../../index.js';
import { astLoad } from '../../src/expressions/index.js';
import { captureLogs } from '../../src/logging.js';
const rows=JSON.parse(readFileSync('spike/out/neg.json','utf8'));
if(rows.length!==504 || new Set(rows.map(r=>r.id)).size!==504) throw new Error('Missing/duplicate negation oracle population');
let exact=0,mismatch=0,error=0;
for(const row of rows) {
  let generator;
  let got;
  try {
    const tree=row.kind==='roundtrip' ? parse(row.input,{read:row.dialect})[0] : astLoad(row.ast);
    generator=Dialect.get_or_raise(row.dialect).generator({pretty:row.pretty,identify:row.identify,unsupported_level:ErrorLevel.IGNORE});
    got={sql:captureLogs(()=>generator.generate(tree)).result};
  } catch(e) {
    got={error:e.name.replace(/^Py/,''),message:e.message};
  }
  got.unsupported_messages=generator?.unsupported_messages || [];
  if(JSON.stringify(got)===JSON.stringify(row.expected)) exact++;
  else {
    if(got.error && !row.expected.error) error++; else mismatch++;
    console.error(JSON.stringify({id:row.id,got,want:row.expected}));
  }
}
console.log(`NEGATION: total ${rows.length}, EXACT ${exact}, MISMATCH ${mismatch}, ERROR ${error}, EXCLUDED 0`);
process.exitCode=mismatch+error===0 ? 0 : 1;
