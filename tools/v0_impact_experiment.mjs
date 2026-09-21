// DIAGNOSTIC ONLY: reversible in-memory candidates, NOT a port or accepted baseline.
// Source read directly at pinned 91119bc: generator.py:3513-3560,4013-4017;
// generators/duckdb.py:2652-2680. No source files, fixtures or ratchets are changed.
// Measured exact-atom gains are prioritization evidence, NOT production passes.
import { writeFileSync } from 'node:fs';
import { loadAtoms, runAtom, resolveTranspile, V0_DIALECTS } from '../test/runner.mjs';
import { Generator } from '../src/generator.js';
import { DuckDBGenerator } from '../src/generators/duckdb.js';
import { exp } from '../index.js';
import { captureLogs } from '../src/logging.js';
const atoms = loadAtoms().filter(a => V0_DIALECTS.has(a.read) && V0_DIALECTS.has(a.write));
if (atoms.length !== 6522) throw new Error('Review changed v0 population before interpreting experiment');
const adapter = await resolveTranspile();
const evaluate = () => captureLogs(() => atoms.map(a => ({atom_id:a.atom_id,...runAtom(a,adapter)}))).result;
const candidates = {
  neg: [[Generator.prototype, 'neg_sql', function(e) {
    const s = this.sql(e, 'this');
    if (!s.length) throw new Error('Diagnostic candidate does not accept empty neg operand');
    return `-${s[0] === '-' ? ' ' : ''}${s}`;
  }]],
  window_cluster: [
    [Generator.prototype, 'window_sql', function(e) {
      let s = this.sql(e,'this');
      const partition = this.partition_by_sql(e);
      const order = e.args.order ? this.order_sql(e.args.order,true) : '';
      const spec = this.sql(e,'spec'), alias = this.sql(e,'alias');
      const over = this.sql(e,'over') || 'OVER';
      s += ` ${e.argKey === 'windows' ? 'AS' : over}`;
      const first = e.args.first == null ? '' : e.args.first ? 'FIRST' : 'LAST';
      if (!partition && !order && !spec && alias) return `${s} ${alias}`;
      return `${s} (${this.format_args(...[alias,first,partition,order,spec].filter(Boolean),{sep:' '})})`;
    }],
    [Generator.prototype, 'partition_by_sql', function(e) {
      const s = this.expressions(e,'partition_by',{flat:true});
      return s ? `PARTITION BY ${s}` : '';
    }],
    [Generator.prototype, 'windowspec_sql', function(e) {
      const kind=this.sql(e,'kind');
      const start=[this.sql(e,'start'),this.sql(e,'start_side')].filter(Boolean).join(' ');
      const end=[this.sql(e,'end'),this.sql(e,'end_side')].filter(Boolean).join(' ') || 'CURRENT ROW';
      let s=`${kind} BETWEEN ${start} AND ${end}`;
      const exclude=this.sql(e,'exclude');
      if(exclude) {
        if(this.constructor.SUPPORTS_WINDOW_EXCLUDE) s+=` EXCLUDE ${exclude}`;
        else this.unsupported('EXCLUDE clause is not supported in the WINDOW clause');
      }
      return s;
    }],
  ],
  duckdb_list_sort: [[DuckDBGenerator.prototype,'sortarray_sql',function(e) {
    const arr=e.this,asc=e.args.asc,nulls=e.args.nulls_first;
    if(!(asc instanceof exp.Boolean) && !(nulls instanceof exp.Boolean)) return this.func('LIST_SORT',arr,asc,nulls);
    const nullsFirst=nulls instanceof exp.Boolean && nulls.this === true;
    const nullsSql=nullsFirst ? exp.Literal.string('NULLS FIRST') : null;
    if(!(asc instanceof exp.Boolean)) return this.func('LIST_SORT',arr,asc,nullsSql);
    const descending=asc.this === false;
    if(!descending && !nullsFirst) return this.func('LIST_SORT',arr);
    if(!nullsFirst) return this.func('ARRAY_REVERSE_SORT',arr);
    return this.func('LIST_SORT',arr,exp.Literal.string(descending?'DESC':'ASC'),exp.Literal.string('NULLS FIRST'));
  }], [DuckDBGenerator.prototype,'generate',function(...args) {
    // Dispatch was cached by the baseline BEFORE this new candidate method existed.
    // Use an instance-local copy; never mutate the runtime's class dispatch cache.
    this._dispatch = new Map(this._dispatch);
    this._dispatch.set(exp.SortArray,'sortarray_sql');
    return Generator.prototype.generate.apply(this,args);
  }]],
};
const baseline=evaluate();
const accepted=new Set(baseline.filter(r=>r.ok).map(r=>r.atom_id));
const report={diagnosticOnly:true,total:atoms.length,baselineExact:accepted.size,experiments:[]};
for(const names of [['neg'],['window_cluster'],['duckdb_list_sort'],['neg','window_cluster','duckdb_list_sort']]) {
  const changes=names.flatMap(n=>candidates[n]);
  const saved=changes.map(([p,k])=>[p,k,Object.getOwnPropertyDescriptor(p,k)]);
  try {
    for(const [p,k,f] of changes) Object.defineProperty(p,k,{value:f,writable:true,configurable:true});
    const rows=evaluate();
    const gained=rows.filter(r=>r.ok&&!accepted.has(r.atom_id)).map(r=>r.atom_id);
    const lost=rows.filter(r=>!r.ok&&accepted.has(r.atom_id)).map(r=>r.atom_id);
    report.experiments.push({candidates:names,exact:rows.filter(r=>r.ok).length,gained,lost});
    console.log(JSON.stringify({candidates:names,gained:gained.length,lost:lost.length,exact:rows.filter(r=>r.ok).length}));
  } finally {
    for(const [p,k,d] of saved) { if(d) Object.defineProperty(p,k,d); else delete p[k]; }
  }
}
const restored=evaluate();
if(JSON.stringify(restored)!==JSON.stringify(baseline)) throw new Error('Candidate restoration changed baseline');
writeFileSync(process.argv[2] || '/tmp/v0-impact.json',JSON.stringify(report,null,2)+'\n');
console.log(`RESTORED: ${accepted.size}/${atoms.length}, no production changes; candidate gains NOT accepted passes`);
