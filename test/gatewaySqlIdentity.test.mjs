import test from 'node:test';
import assert from 'node:assert/strict';
import { Dialect } from '../index.js';
import { extractSqlMetadata as metadata } from '../contrib/gatewaySqlMetadata.js';

const qualify = (n) => `SELECT id, ts FROM t QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY ts DESC) = ${n}`;
for (const dialect of ['snowflake', 'databricks']) {
  test(`AIR-2163: QUALIFY identity includes predicate (${dialect})`, () => {
    const inputs = [qualify(1), qualify(2), 'SELECT id, ts FROM t'];
    const results = inputs.map(sql => metadata(sql, {dialect}));
    assert.equal(new Set(results.map(r => r.standardizedSql)).size, 3);
    for (const r of results) { assert.equal(r.cacheable, true); assert.equal(r.extractionError, null); }
    assert.equal(metadata(`/* request=1 */ ${qualify(1)} -- request=2`, {dialect}).standardizedSql, results[0].standardizedSql);
  });
  test(`AIR-2163: generator success cannot hide a lost clause (${dialect})`, (t) => {
    t.mock.method(Dialect.prototype, 'generate', () => 'SELECT id, ts FROM t');
    for (const sql of [qualify(1), qualify(2)]) {
      const r = metadata(sql, {dialect});
      assert.match(r.extractionError, /changes parsed structure/);
      assert.match(r.standardizedSql, /QUALIFY/);
      assert.notEqual(r.standardizedSql, 'SELECT id, ts FROM t');
      assert.equal(r.cacheable, true);
    }
    assert.notEqual(metadata(qualify(1), {dialect}).standardizedSql, metadata(qualify(2), {dialect}).standardizedSql);
  });
  for (const [a,b] of [
    ['select CURRENT_DATE from T /* request=1 */', 'SELECT current_date FROM t -- request=2'],
    ['SELECT A FROM T GROUP BY ROLLUP(A)', 'select a from t group by rollup ( a ) /* __AIRBRX_CACHE__ */'],
    ["SELECT * FROM t PIVOT (SUM(v) FOR k IN ('a','b'))", "select * from T pivot (sum(V) for K in ('a', 'b')) -- request"],
  ]) test(`AIR-2163: fallback convergence (${dialect}): ${a}`, () => {
    const first = metadata(a, {dialect}), second = metadata(b, {dialect});
    assert.equal(first.statementType, 'SELECT');
    assert.match(first.extractionError, /standardizedSql generation failed/);
    assert.equal(first.standardizedSql, second.standardizedSql);
    assert.equal(first.originalSql, a); assert.equal(second.originalSql, b);
    if (b.includes('__AIRBRX_CACHE__')) assert.equal(second.cacheOverride, 'cache');
  });
}
for (const dialect of ['postgres', 'snowflake', 'databricks']) {
  test(`AIR-2163: fallback retains literals, quoted identifiers, Unicode, binds (${dialect})`, (t) => {
    t.mock.method(Dialect.prototype, 'generate', () => { throw new Error('forced fallback'); });
    const quote = dialect === 'databricks' ? '`' : '"';
    const inputs = [
      "SELECT 'a /* not a comment */ b' FROM t", "SELECT 'a b' FROM t",
      "SELECT '𝛂; -- X  Y' FROM t", "SELECT '𝛂; -- X Y' FROM t",
      `SELECT ${quote}A${quote} FROM t`, `SELECT ${quote}a${quote} FROM t`,
      'SELECT :Name FROM t', 'SELECT :name FROM t',
      'SELECT CURRENT_DATE FROM x', 'SELECT CURRENT_DATE FROM y',
    ];
    const results = inputs.map(sql => metadata(sql, {dialect}));
    assert.equal(new Set(results.map(r => r.standardizedSql)).size, inputs.length);
    for (const r of results) assert.equal(r.cacheable, true);
  });
}
test('AIR-2163: structural fallback protects other parsed SELECT modifiers', (t) => {
  t.mock.method(Dialect.prototype, 'generate', () => 'SELECT * FROM t');
  for (const sql of [
    'SELECT * FROM t WINDOW w AS (PARTITION BY a)',
    'SELECT * FROM t TABLESAMPLE (10 PERCENT)',
    'SELECT * FROM t CONNECT BY PRIOR id = parent',
    "SELECT * FROM t PIVOT (SUM(v) FOR k IN ('a'))",
    'SELECT * FROM t UNPIVOT (v FOR k IN (a,b))',
  ]) {
    const r = metadata(sql, {dialect:'databricks'});
    assert.equal(r.statementType, 'SELECT', r.extractionError);
    assert.match(r.extractionError, /changes parsed structure/);
    assert.notEqual(r.standardizedSql, 'SELECT * FROM t');
  }
});
for (const sql of [
  'RESTORE TABLE cat.sch.t TO VERSION AS OF 3',
  "RESTORE cat.sch.t TIMESTAMP AS OF '2020-01-01'",
  'RESTORE TABLE `cat`.`sch`.`t` TO VERSION AS OF 3; -- trailing',
]) test(`AIR-2163: RESTORE extension: ${sql}`, () => {
  const r = metadata(sql, {dialect:'databricks'});
  assert.equal(r.statementType, 'RESTORE');
  assert.equal(r.isDataChange, true); assert.equal(r.cacheable, false);
  assert.equal(r.standardizedSql, sql);
  assert.deepEqual(r.tables, [{catalog:'cat',schema:'sch',table:'t',fullyQualifiedName:'cat.sch.t',operation:'RESTORE'}]);
});
for (const sql of [
  'RESTORE TABLE t TO VERSION AS OF 3; DELETE FROM x',
  'RESTORE TABLE t TO VERSION AS OF (SELECT 3)',
  'RESTORE TABLE t TO VERSION AS OF 3 garbage',
  'RESTORE TABLE t TO VERSION AS OF :version',
  'RESTORE TABLE t TO TIMESTAMP AS OF CURRENT_TIMESTAMP()',
  'RESTORE TABLE t TO VERSION AS OF 3.1',
  'RESTORE TABLE t TO VERSION AS OF -1',
]) test(`AIR-2163: unsupported RESTORE stays fail-closed: ${sql}`, () => {
  const r = metadata(sql, {dialect:'databricks'});
  assert.equal(r.statementType, 'UNKNOWN'); assert.equal(r.cacheable, false);
  assert.equal(r.standardizedSql, sql); assert.ok(r.extractionError);
});
test('AIR-2163: RESTORE extension is not enabled for other dialects', () => {
  assert.equal(metadata('RESTORE TABLE t TO VERSION AS OF 3', {dialect:'snowflake'}).statementType, 'UNKNOWN');
});
test('AIR-2163: COPY carries mutation target, never a read-only classification', () => {
  for (const dialect of ['databricks', 'snowflake']) {
    const r = metadata("COPY INTO cat.sch.t FROM 's3://bucket/path' FILEFORMAT = CSV", {dialect});
    assert.equal(r.statementType, 'COPY'); assert.equal(r.isDataChange, true); assert.equal(r.cacheable, false);
    assert.deepEqual(r.tables, [{catalog:'cat',schema:'sch',table:'t',fullyQualifiedName:'cat.sch.t',operation:'COPY'}]);
    assert.deepEqual(r.mutations, [{statementType:'COPY',tables:r.tables}]);
  }
});

test('AIR-2163: unported MATCH_RECOGNIZE is explicit UNKNOWN, never silently a plain read', () => {
  const sql = 'SELECT * FROM t MATCH_RECOGNIZE (PARTITION BY id ORDER BY ts MEASURES A.ts AS start_ts PATTERN (A) DEFINE A AS x > 0)';
  const r = metadata(sql, {dialect:'databricks'});
  assert.equal(r.statementType, 'UNKNOWN'); assert.equal(r.cacheable, false);
  assert.equal(r.standardizedSql, sql); assert.ok(r.extractionError);
});
