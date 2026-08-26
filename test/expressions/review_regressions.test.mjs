import test from "node:test";
import assert from "node:assert/strict";
import * as e from "../../src/expressions/index.js";

const id = name => new e.Identifier({ this: name });

test("builders are public and preserve positional dict properties", () => {
  assert.equal(typeof e.update, "function");
  const node = e.update(new e.Table({ this: id("t") }), { dialect: 5 }, { copy: false });
  assert.equal(node.expressions.length, 1);
  assert.equal(node.expressions[0].this.name, "dialect");
  assert.equal(node.expressions[0].expression.this, "5");
});

test("query child-list and conjunction builders create upstream wrapper shapes", () => {
  const a = id("a"), b = id("b"), c = id("c");
  const ordered = new e.Select().orderBy(a);
  assert(ordered.args.order instanceof e.Order);
  assert.deepEqual(ordered.args.order.expressions.map(x => x.name), ["a"]);
  const having = new e.Select().having(a, b);
  assert(having.args.having instanceof e.Having);
  assert(having.args.having.this instanceof e.And);
  const where = new e.Select().where(new e.And({ this: a, expression: b }), c);
  assert(where.args.where instanceof e.Where);
  assert(where.args.where.this.this instanceof e.Paren);
  const untouched = new e.Select();
  assert.strictEqual(untouched.where(), untouched);
});

test("columnTableNames uses the Column table projection", () => {
  const expression = new e.Select({ expressions: [new e.Column({ table: id("t"), this: id("x") })] });
  assert.deepEqual([...e.columnTableNames(expression)], ["t"]);
});
