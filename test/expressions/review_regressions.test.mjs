import test from "node:test";
import assert from "node:assert/strict";
import * as e from "../../src/expressions/index.js";
import { PyValueError } from "../../src/_py/errors.js";

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

// ---------------------------------------------------------------------------
// Second review pass (PR #5 comment 5420319814) plus the sibling cases found by
// sweeping the upstream surface rather than the reported symptoms.  Every
// expectation below is `repr()` from CPython on /tmp/sqlglot-ref @ 91119bc.
// ---------------------------------------------------------------------------

const col = (n) => new e.Column({ this: id(n) });
const sel = () => new e.Select();

test("_combine wraps the head operand only when another operand follows", () => {
  // PY: Select().where(or_(a, b)) -> Where(this=Or(...)); NOT Paren(Or(...)).
  const single = sel().where(e.or_(col("a"), col("b")));
  assert(single.args.where.this instanceof e.Or, "single Or operand must not be parenthesized");
  // PY: and_(or_(a,b), c) -> And(this=Paren(Or), expression=c)
  const pair = e.and_(e.or_(col("a"), col("b")), col("c"));
  assert(pair.args.this instanceof e.Paren);
  assert(pair.args.expression instanceof e.Column);
  // _wrap tests Connector (the And/Or/Xor base), not the operator being built.
  assert(e.and_(e.and_(col("a"), col("b")), col("c")).args.this instanceof e.Paren);
  // Left-associative, and the accumulator is never re-wrapped.
  const four = e.and_(col("a"), col("b"), col("c"), col("d"));
  assert(four.args.this instanceof e.And && four.args.this.args.this instanceof e.And);
  assert(!(four.args.this.args.this.args.this instanceof e.Paren));
  // wrap:false disables both sites; Join.on shares the same path as where.
  assert(e.and_(e.or_(col("a"), col("b")), col("c"), { wrap: false }).args.this instanceof e.Or);
  assert(new e.Join({ this: new e.Table({ this: id("x") }) }).on(e.or_(col("a"), col("b"))).args.on instanceof e.Or);
});

test("only Query.where unwraps a wrapper operand; having/qualify do not", () => {
  // PY: Select().having(Having(this=a)) -> Having(this=Having(this=Column(a)))
  const having = sel().having(new e.Having({ this: col("a") }));
  assert(having.args.having.this instanceof e.Having);
  const qualify = sel().qualify(new e.Qualify({ this: col("a") }));
  assert(qualify.args.qualify.this instanceof e.Qualify);
  // PY: Select().where(Where(this=a)) -> Where(this=Column(a))
  assert(sel().where(new e.Where({ this: col("a") })).args.where.this instanceof e.Column);
});

test("group_by alone early-returns on no args", () => {
  assert.equal(sel().groupBy().args.group, undefined, "group_by() must not materialise Group()");
  assert(sel().orderBy().args.order instanceof e.Order, "order_by() does materialise Order()");
  const s = sel();
  assert.strictEqual(s.groupBy({ copy: false }), s);
});

test("alias_ attaches the alias instead of wrapping when the node accepts one", () => {
  const t = () => new e.Table({ this: id("t") });
  // PY: alias_(Table, "x", table=True) -> Table(alias=TableAlias(this=Identifier(x)))
  const tabled = e.alias_(t(), "x", { table: true });
  assert(tabled instanceof e.Table && tabled.args.alias instanceof e.TableAlias);
  // PY: Table has an `alias` arg, so even the plain form sets it in place.
  assert(e.alias_(t(), "x").args.alias instanceof e.Identifier);
  // PY: `if table:` -- an empty column list is falsy, so this is the plain branch.
  assert(e.alias_(t(), "x", { table: [] }).args.alias instanceof e.Identifier);
  assert.deepEqual(
    e.alias_(t(), "x", { table: ["c1", "c2"] }).args.alias.args.columns.map((c) => c.name), ["c1", "c2"]);
  // Column has no `alias` arg, so it is wrapped; Window is excluded by name.
  assert(e.alias_(col("c"), "a") instanceof e.Alias);
  assert(e.alias_(new e.Window({ this: col("a") }), "w") instanceof e.Alias);
});

test("column threads fields/quoted/copy and always materialises the parts", () => {
  assert.deepEqual(Object.keys(e.column("a").args).sort(), ["catalog", "db", "table", "this"]);
  const dotted = e.column("a", "t", null, null, { fields: ["f1", "f2"] });
  assert(dotted instanceof e.Dot && dotted.args.this instanceof e.Dot);
  assert(e.column("a", null, null, null, { fields: [] }) instanceof e.Column);
  const ident = id("a");
  assert.strictEqual(e.column(ident, null, null, null, { copy: false }).this, ident);
  assert.notStrictEqual(e.column(ident).this, ident);
  assert(e.column(new e.Star(), "t").this instanceof e.Star);
});

test("Table.to_column keeps parts beyond the fourth as Dot fields", () => {
  const parts = [...("abcde")].map(id);
  const out = new e.Table({ this: e.Dot.build(parts) }).toColumn();
  // PY: Dot(this=Column(this=d, table=c, db=b, catalog=a), expression=Identifier(e))
  assert(out instanceof e.Dot);
  assert.equal(out.args.expression.name, "e");
  assert.equal(out.args.this.this.name, "d");
  assert.equal(out.args.this.args.catalog.name, "a");
});

test("the remaining upstream name/output_name overrides", () => {
  assert.equal(new e.Placeholder().name, "?");
  assert.equal(new e.Placeholder({ this: "p" }).name, "p");
  assert.equal(new e.Null().name, "NULL");
  assert.equal(new e.Dot({ this: col("a"), expression: id("b") }).name, "b");
  assert.equal(new e.Dot({ this: col("a"), expression: id("b") }).outputName, "b");
  assert.equal(new e.Ordered({ this: col("cc") }).name, "cc");
  assert.equal(new e.Paren({ this: col("cc") }).outputName, "cc");
  assert.equal(new e.Bracket({ this: col("x"), expressions: [col("e")] }).outputName, "e");
  assert.equal(new e.Bracket({ this: col("x"), expressions: [col("e"), col("f")] }).outputName, "");
  // text()'s Star/Null arm: `t.*` must survive into namedSelects.
  assert.deepEqual(
    sel().select(new e.Star(), new e.Column({ this: new e.Star(), table: id("t") })).namedSelects,
    ["*", "*"]);
  assert.deepEqual(sel().select(new e.Null()).namedSelects, [""]);
});

test("is_star has no Alias/Paren/expressions arms", () => {
  const star = new e.Star();
  assert.equal(new e.Alias({ this: star }).isStar, false);
  assert.equal(new e.Paren({ this: star }).isStar, false);
  assert.equal(new e.Tuple({ expressions: [star] }).isStar, false);
  assert.equal(new e.Select({ expressions: [star] }).isStar, true);
  assert.equal(new e.Column({ this: star }).isStar, true);
  assert.equal(new e.Dot({ this: col("a"), expression: star }).isStar, true);
});

test("DataType.build carries the parser's nested flag for string input only", () => {
  assert.equal(e.DataType.build("INT").args.nested, false);
  // The string form goes through `parse_one(dtype, into=DataType)` upstream, so it
  // carries the PARSER's full arg set -- `expressions` (None for a scalar type) as well
  // as `nested`. This assertion previously expected ["this", "nested", "nullable"],
  // omitting `expressions`; that matched the port's own `fromStr` shortcut rather than
  // upstream. Ground truth from the pinned tree @ 91119bc:
  //   list(exp.DataType.build('INT', nullable=True).args) ==
  //       ['this', 'expressions', 'nested', 'nullable']
  // The order matters because `astDump` serialises args in INSERTION order, so a missing
  // key is a positional diff for every oracle row that reaches `from_str` -- which
  // `build_as_cast` (parsers/spark2.py:17) now does for BOOLEAN/DATE/DOUBLE/FLOAT/INT/
  // STRING/TIMESTAMP and Spark's TIMESTAMP_LTZ/NTZ.
  assert.deepEqual(
    Object.keys(e.DataType.build("INT", { nullable: true }).args),
    ["this", "expressions", "nested", "nullable"],
  );
  // The enum and into_expr forms bypass the parser, so they carry no `nested`.
  assert.equal("nested" in e.DataType.build(e.DataType.Type.INT).args, false);
  assert.equal("nested" in e.DataType.Type.INT.intoExpr().args, false);
  // UNKNOWN is short-circuited before parsing upstream.
  assert.equal("nested" in e.DataType.build("UNKNOWN").args, false);
  // nested=false is skipped by the hash, so equality is unaffected.
  assert(e.DataType.build("INT").equals(e.DataType.Type.INT.intoExpr()));
  assert(!e.DataType.build("INT").equals(e.DataType.build("TEXT")));
});

test("values converts one row at a time and honours Python truthiness", () => {
  // PY: `[convert(tup) for tup in values]` -- a scalar row stays scalar.
  assert(e.values([1]).expressions[0] instanceof e.Literal);
  assert(e.values([[1, 2]]).expressions[0] instanceof e.Tuple);
  // [] and {} are falsy in Python: no alias required, and no columns emitted.
  // PY: Values(expressions=[...], alias=None) -- the key is present and null.
  assert.equal(e.values([[1]], { columns: [] }).args.alias, null);
  assert.equal(e.values([[1]], { columns: {} }).args.alias, null);
  // Iterating a dict yields its keys.
  for (const columns of [{ a: "INT" }, new Map([["a", "INT"]]), ["a"]]) {
    assert.deepEqual(
      e.values([[1]], { alias: "t", columns }).args.alias.args.columns.map((c) => c.name), ["a"],
      `columns as ${columns?.constructor?.name}`);
  }
  assert.throws(() => e.values([[1]], { columns: ["a"] }), PyValueError);
});

test("cast collapses through the base TYPE_MAPPING with no dialect", () => {
  // PY: base Generator.TYPE_MAPPING maps NCHAR -> CHAR, so this is not a double cast.
  const collapsed = e.cast(e.cast(col("x"), "NCHAR"), "CHAR");
  assert(!(collapsed.this instanceof e.Cast));
  assert.equal(e.cast(e.cast(col("x"), "MEDIUMTEXT"), "TEXT").this instanceof e.Cast, false);
  // Genuinely different types still nest.
  assert(e.cast(e.cast(col("x"), "INT"), "TEXT").this instanceof e.Cast);
});

test("maybeParse does not double-wrap into:Identifier", () => {
  // This is the port bug that test_parse_identifier used to mask: the compensating
  // line in parse_identifier is gone, so the fallback itself must be right.
  const parsed = e.maybeParse("a b", { into: e.Identifier });
  assert(parsed instanceof e.Identifier);
  assert.equal(typeof parsed.this, "string", "Identifier(this=Identifier(...)) is the bug");
  assert.equal(parsed.this, "a b");
  // `into` used as a type constraint must return the leaf, not fabricate a node.
  assert(e.maybeParse("a", { into: e.Expr }) instanceof e.Column);
  assert(new e.Select().select("a").expressions[0] instanceof e.Column);
});

test("toIdentifier follows to_identifier's type contract", () => {
  assert.equal(e.toIdentifier(null), null);
  assert.throws(() => e.toIdentifier(5), PyValueError);
  assert.throws(() => e.toIdentifier(col("a")), PyValueError);
  const i = id("a");
  assert.strictEqual(e.toIdentifier(i, null, false), i);
  assert.notStrictEqual(e.toIdentifier(i, null, true), i);
});

test("Join.using and Select.join(using) append to existing columns", () => {
  const j = new e.Join({ this: new e.Table({ this: id("x") }), using: [id("z")] });
  assert.deepEqual(new e.Select().join(j, { using: [id("a")] })
    .args.joins[0].args.using.map((x) => x.name), ["z", "a"]);
  assert.deepEqual(new e.Join({ this: new e.Table({ this: id("x") }) })
    .using(id("a")).using(id("b")).args.using.map((x) => x.name), ["a", "b"]);
});

test("with_ always carries materialized/scalar keys", () => {
  const cte = new e.Select().with_("a", new e.Select()).args.with_.expressions[0];
  assert.deepEqual(Object.keys(cte.args).sort(), ["alias", "materialized", "scalar", "this"]);
  assert.equal(cte.args.materialized, null);
});

test("Select.distinct filters falsy `ons` before parsing", () => {
  // PY: `[maybe_parse(on) for on in ons if on]` -> Distinct(on=Tuple()) for (None,).
  const d = new e.Select().distinct(null);
  assert(d.args.distinct.args.on instanceof e.Tuple);
  assert.equal(d.args.distinct.args.on.expressions.length, 0);
});
