import test from 'node:test';
import assert from 'node:assert/strict';
import { Dialect, exp, transpile, parse } from '../index.js';
import { PyIndexError } from '../src/_py/errors.js';
const dialects=['','snowflake','duckdb','hive','spark2','spark','databricks','postgres','redshift'];
test('ordinary negative numbers generate through every v0 public dialect path',()=>{
  for(const read of dialects) {
    assert.deepEqual(transpile('SELECT -1',{read}),['SELECT -1']);
    assert.deepEqual(transpile('SELECT -9223372036854775808',{read}),['SELECT -9223372036854775808']);
  }
});
test('nested unary minus never becomes a line comment',()=>{
  for(const read of dialects) {
    const [sql]=transpile('SELECT - -5',{read});
    assert.equal(sql,'SELECT - -5');
    assert.equal(parse(sql,{read})[0].expressions.length,1);
    assert.deepEqual(transpile('SELECT -(-5)',{read}),['SELECT -(-5)']);
  }
});
test('empty and missing operands preserve Python string-index errors',()=>{
  for(const dialect of dialects) {
    for(const tree of [new exp.Neg(),new exp.Neg({this:exp.Literal.number('')})]) {
      assert.throws(()=>Dialect.get_or_raise(dialect).generate(tree),error=>
        error instanceof PyIndexError && error.message==='string index out of range');
    }
  }
});
test('negation is dispatched, not folded into a replacement literal',()=>{
  const tree=new exp.Neg({this:new exp.Neg({this:exp.Literal.number('5')})});
  assert.equal(Dialect.get_or_raise('').generate(tree),'- -5');
  assert.ok(tree.this instanceof exp.Neg);
});
