import assert from "node:assert/strict";
import * as e from "../../src/expressions/index.js";
const id = (name) => new e.Identifier({ this: name });

// Hand ports of the AST-only assertions in upstream test_expressions.py's
// test_named_selects, test_selects, test_ctes and test_alias_or_name surface.
{
  const select = new e.Select({ expressions: [id("a"), new e.Alias({ this: id("b"), alias: id("B") })] });
  assert.deepEqual(select.selects, select.expressions);
  assert.deepEqual(select.namedSelects, ["a", "B"]);
  assert.deepEqual(select.named_selects, ["a", "B"]);
  assert.deepEqual(select.ctes, []);
  const cte = new e.CTE({ this: new e.Select({ expressions: [id("x")] }), alias: new e.TableAlias({ this: id("q") }) });
  select.set("with_", new e.With({ expressions: [cte] }));
  assert.deepEqual(select.ctes, [cte]);
}
{
  const base = new e.Select({ expressions: [id("x")] });
  const lateral = new e.Lateral({ this: id("items") });
  const win = new e.Window({ this: id("w") });
  const built = base.lateral(lateral).window(win).join(new e.Table({ this: id("t") }), {
    join_type: "left outer", on: [id("a"), id("b")], using: ["x", id("y")], join_alias: "j",
  });
  assert.ok(built.args.laterals[0] instanceof e.Lateral);
  assert.ok(built.args.windows[0] instanceof e.Window);
  assert.equal(built.args.joins[0].side, "LEFT");
  assert.equal(built.args.joins[0].kind, "OUTER");
  assert.ok(built.args.joins[0].args.on instanceof e.And);
  assert.deepEqual(built.args.joins[0].args.using.map(x => x.name), ["x", "y"]);
  // py: alias_(join.this, join_alias, table=True) sets a TableAlias ON the joined
  // source; it does not wrap the source in one.  Verified against upstream:
  //   Join(this=Table(this=Identifier(t), alias=TableAlias(this=Identifier(j))))
  assert.ok(built.args.joins[0].this instanceof e.Table);
  assert.ok(built.args.joins[0].this.args.alias instanceof e.TableAlias);
  assert.equal(built.args.joins[0].this.args.alias.this.name, "j");
  const hinted = base.hint(id("broadcast"));
  assert.ok(hinted.args.hint instanceof e.Hint);
  assert.equal(hinted.args.hint.expressions[0].name, "broadcast");
  const create = base.ctas(new e.Table({ this: id("dst") }), { properties: { ENGINE: "x" } });
  assert.ok(create instanceof e.Create); assert.equal(create.kind, "TABLE");
  assert.notEqual(create.expression, base); assert.ok(create.args.properties instanceof e.Properties);
}
{
  const unpivot = new e.Pivot({
    unpivot: true,
    expressions: [id("val")],
    fields: [new e.In({ this: id("name"), expressions: [new e.Column({ this: id("a") }), new e.Column({ this: id("b") })] })],
  });
  assert.deepEqual([...unpivot.outputColumns(["a", "b", "c"])], [["c", "c"], ["name", "name"], ["val", "val"]]);
  const pivot = new e.Pivot({
    expressions: [new e.Alias({ this: new e.Column({ this: id("v") }), alias: id("sum_v") })],
    columns: [id("p")], alias: new e.TableAlias({ this: id("q"), columns: [id("renamed")] }),
  });
  assert.deepEqual([...pivot.output_columns(["k", "v"])], [["renamed", "k"], ["p", "p"]]);
}
{
  const a = new e.Select({ expressions: [id("a")] });
  const b = new e.Select({ expressions: [id("b")] });
  const union = new e.Union({ this: a, expression: b });
  assert.deepEqual(union.selects, [a.expressions[0]]);
  assert.deepEqual(union.namedSelects, ["a"]);
  union.set("by_name", true);
  assert.deepEqual(union.namedSelects, ["a", "b"]);
  assert.equal(union.left, a); assert.equal(union.right, b);
}
{
  const alias = new e.TableAlias({ this: id("t"), columns: [id("a"), id("b")] });
  assert.deepEqual(alias.columns.map(x => x.name), ["a", "b"]);
  const table = new e.Table({ catalog: id("c"), db: id("d"), this: id("t") });
  assert.equal(table.name, "t"); assert.equal(table.db, "d"); assert.equal(table.catalog, "c");
  assert.deepEqual(table.parts, [table.args.catalog, table.args.db, table.this]);
}
{
  const join = new e.Join({ this: new e.Table({ this: id("x") }), side: "left", kind: "semi", method: "hash" });
  assert.equal(join.side, "LEFT"); assert.equal(join.kind, "SEMI"); assert.equal(join.method, "HASH");
  assert.equal(join.isSemiOrAntiJoin, true);
  const sub = new e.Subquery({ this: new e.Subquery({ this: new e.Select({ expressions: [] }) }) });
  assert.ok(sub.unnest() instanceof e.Select); assert.equal(sub.isWrapper, true);
}
{
  const q = new e.Select({ expressions: [id("a")] });
  const create = new e.Create({ kind: "table", expression: q });
  assert.equal(create.kind, "TABLE"); assert.deepEqual(create.selects, q.selects); assert.deepEqual(create.namedSelects, ["a"]);
  const alter = new e.Alter({ kind: "table", actions: [id("x")] });
  assert.equal(alter.kind, "TABLE"); assert.deepEqual(alter.actions, alter.args.actions);
}
