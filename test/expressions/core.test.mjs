import test from "node:test";
import assert from "node:assert/strict";
import { Column, DataType, DateAdd, DateTrunc, DType, Identifier, Literal, Table, Var, Week, astLoad } from "../../src/expressions/index.js";
import { ExprMap, ExprSet } from "../../src/_py/collections.js";
import { SAFE_IDENTIFIER_RE, toIdentifier } from "../../src/expressions/core.js";

test("DateAdd kwargs normalize unit but astLoad bypasses INIT_HOOKS", () => {
  const kwargs = new DateAdd({ this: new Var({ this: "x" }), unit: new Var({ this: "q" }) });
  assert.strictEqual(kwargs.args.unit.args.this, "Q");
  const loaded = astLoad({c:"DateAdd",a:[["this",{c:"Var",a:[["this","x"]],m:null,cm:null,t:null}],["unit",{c:"Var",a:[["this","q"]],m:null,cm:null,t:null}]],m:null,cm:null,t:null});
  assert.strictEqual(loaded.args.unit.args.this, "q");
});

test("TimeUnit init hook follows upstream name, abbreviation, parts and Week rules", () => {
  assert.equal(new DateAdd({ unit: new Var({ this: "Q" }) }).args.unit.name, "QUARTER");
  assert.equal(new DateAdd({ unit: new Var({ this: "ms" }) }).args.unit.name, "MS");
  assert.equal(new DateAdd({ unit: new Column({ this: new Identifier({ this: "q" }) }) }).args.unit.name, "Q");
  const multipart = new Column({ table: new Identifier({ this: "t" }), this: new Identifier({ this: "x" }) });
  assert.strictEqual(new DateAdd({ unit: multipart }).args.unit, multipart);
  assert.equal(new DateAdd({ unit: new Week({ this: new Var({ this: "mon" }) }) }).args.unit.this.name, "MON");
  const trunc = new DateTrunc({ unit: new Var({ this: "Q" }), unabbreviate: false });
  assert.equal(trunc.args.unit.this, "Q");
  assert.equal(Object.hasOwn(trunc.args, "unabbreviate"), false);
});

test("DType enum members contribute their identity to expression hashes", () => {
  const int = DataType.build("INT"), text = DataType.build("TEXT");
  assert.equal(int.equals(text), false);
  assert.notEqual(int.hash(), text.hash());
  assert.equal(new ExprSet([int, text]).size, 2);
  assert.equal(new ExprMap([[int, 1], [text, 2]]).size, 2);
});

test("equality matches Python falsy and case projections", () => {
  assert(new Table({}).equals(new Table({ pivots: [] })));
  assert(new Table({ pivots: [null] }).equals(new Table({ pivots: [false] })));
  assert(new Table({ temporary: null }).equals(new Table({ temporary: false })));
  assert(new Var({ this: "x" }).equals(new Var({ this: "X" })));
  // Identifier and Literal opt into _hash_raw_args, so their string payloads
  // remain case-sensitive despite the default projection above.
  assert(!new Identifier({ this: "a" }).equals(new Identifier({ this: "A" })));
});

import { Add, Alias, Boolean as BooleanExpr, Null as NullExpr, Paren, Select, Star } from "../../src/expressions/index.js";

const id = name => new Identifier({ this: name, quoted: false });
const col = name => new Column({ this: id(name) });

test("tree navigation, depth, traversal and pruning", () => {
  const left = col("a"), right = col("b");
  const add = new Add({ this: left, expression: right });
  const select = new Select({ expressions: [add] });
  assert.equal(right.depth, 2);
  assert.equal(right.root(), select);
  assert.equal(right.parentSelect, select);
  assert.deepEqual([...select.bfs()].map(x => x.constructor.name), ["Select", "Add", "Column", "Column", "Identifier", "Identifier"]);
  assert.deepEqual([...select.dfs(x => x === add)].map(x => x.constructor.name), ["Select", "Add"]);
  assert.equal(select.find(Identifier).this, "a");
  assert.deepEqual([...select.findAll(Column)], [left, right]);
  assert.equal(right.findAncestor(Add), add);
});

test("unnest, unalias and associative flatten", () => {
  const a = col("a"), b = col("b"), c = col("c");
  assert.equal(new Paren({ this: new Paren({ this: a }) }).unnest(), a);
  assert.equal(new Alias({ this: a, alias: id("x") }).unalias(), a);
  const tree = new Add({ this: new Add({ this: a, expression: b }), expression: new Paren({ this: c }) });
  assert.deepEqual([...tree.flatten()], [a, b, c]);
});

test("transform does not visit newly returned subtrees and supports removal", () => {
  const tree = new Add({ this: col("a"), expression: col("b") });
  const changed = tree.transform(node => node instanceof Column && node.name === "a" ? new Paren({ this: col("z") }) : node);
  assert.equal(changed.args.this.constructor.name, "Paren");
  assert.equal(changed.args.this.this.name, "z");
  assert.equal(tree.args.this.name, "a");
  const removed = tree.transform(node => node instanceof Column && node.name === "b" ? null : node, { copy: false });
  assert.equal(removed.args.expression, undefined);
});

test("scalar projections and expression naming", () => {
  assert.equal(new Literal({ this: "42", is_string: false }).toPy(), 42n);
  assert.equal(String(new Literal({ this: "4.2", is_string: false }).toPy()), "4.2");
  assert.equal(new Literal({ this: "42", is_string: true }).toPy(), "42");
  assert.equal(new BooleanExpr({ this: true }).toPy(), true);
  assert.equal(new NullExpr().toPy(), null);
  assert.equal(new Literal({ this: "42", is_string: false }).isInt, true);
  assert.equal(new Column({ this: new Star() }).isStar, true);
  const aliased = new Alias({ this: col("a"), alias: id("answer") });
  assert.equal(aliased.alias, "answer");
  assert.equal(aliased.aliasOrName, "answer");
});

test("set maintains list parent/index relationships", () => {
  const nodes = [col("a"), col("b"), col("c")], select = new Select({ expressions: nodes });
  select.set("expressions", null, 1);
  assert.deepEqual(select.expressions.map(x => [x.name, x.index]), [["a", 0], ["c", 1]]);
  const replacement = [col("x"), col("y")];
  select.set("expressions", replacement, 1);
  assert.deepEqual(select.expressions.map(x => [x.name, x.index]), [["a", 0], ["x", 1], ["y", 2]]);
});

// `SAFE_IDENTIFIER_RE` — Python's `\w` is Unicode-aware and JS's is not.
//
// This lives in the unit suite rather than only in a spike probe because the AST corpus
// does not reach it: every identifier in `corpus/ast/` is either fully ASCII or has a
// non-ASCII FIRST character (which both languages reject via `^[_a-zA-Z]`). The
// divergence needs an ASCII first char followed by a non-ASCII word character, and
// nothing in 15,540 atoms has one. So the corpus stayed at EXACT 10,242 across the fix
// in both directions — this test is the only thing standing between the correct
// behaviour and a silent revert to `/^[_a-zA-Z][\w]*$/u`.
//
// Expectations are CPython's, taken from
// `re.compile(r"^[_a-zA-Z][\w]*$").match(s)` at the pin, not re-derived here.
test("SAFE_IDENTIFIER_RE matches Python's Unicode-aware \\w and newline-tolerant $", () => {
  for (const [text, want] of [
    ["abc", true],
    ["_a", true],
    ["a1_", true],
    // `\w` is Unicode-aware upstream: these were false under a JS `\w`, which is
    // always [A-Za-z0-9_] even with the `u` flag.
    ["Straße", true],
    ["DUAＬ", true],
    ["aé", true],
    // ...but `^[_a-zA-Z]` is ASCII-only in BOTH languages, so a non-ASCII FIRST
    // character still fails. This is the pair that makes the rule non-obvious.
    ["ａbc", false],
    ["á", false],
    ["ÄÖÜ", false],
    // Python's `$` matches before exactly ONE trailing newline.
    ["abc\n", true],
    ["abc\n\n", false],
    ["ab\nc", false],
    ["", false],
    ["a b", false],
  ]) {
    assert.equal(SAFE_IDENTIFIER_RE.test(text), want, `SAFE_IDENTIFIER_RE.test(${JSON.stringify(text)})`);
  }
});

// The consequence, at the call site that is live on the parse/build path today.
// `toIdentifier`'s `quoted` default is `not SAFE_IDENTIFIER_RE.match(name)`, so an
// under-matching regex quotes identifiers CPython leaves bare.
test("toIdentifier does not quote a Unicode-alphanumeric identifier", () => {
  assert.equal(toIdentifier("Straße").args.quoted, false);
  assert.equal(toIdentifier("abc").args.quoted, false);
  assert.equal(toIdentifier("ÄÖÜ").args.quoted, true);
  assert.equal(toIdentifier("a b").args.quoted, true);
});
