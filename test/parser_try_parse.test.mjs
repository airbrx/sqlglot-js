// Regression tests for `Parser._try_parse` and the Python truth-value protocol.
//
// WHY THIS FILE EXISTS: PR #6 review finding 2. `_try_parse` restores the cursor when
// `not this` (parser.py:2116) — PYTHON falsiness. The port used JS `!this`, which
// disagrees on every empty CONTAINER. `parser.py:10382` passes
// `lambda: self._parse_csv(self._parse_declareitem)`, and `_parse_csv`
// (`parser.py:8918`) returns `[]` when nothing parses: CPython retreats, the port did
// not, and `_parse_declare` then quoted the wrong span of SQL into a
// `check_command_warning` line this phase gates byte-exactly.
//
// The `retreated` column below is CPython's, produced by running the SAME harness
// against upstream @ 91119bc: install a token stream, `_advance()` to index 0, then
// `_try_parse(lambda: (self._advance(2), value)[1])` and read `_index`.
//
// The cases go past the reported `[]`: every kind of value Python calls falsy, plus
// `Expression()` with NO args — which is TRUTHY, because `Expr` defines neither
// `__bool__` nor `__len__`, so rule 3 of the protocol applies. A "retreat when the
// result looks empty" fix would get that one wrong.

import test from "node:test";
import assert from "node:assert/strict";
import { Parser, SENTINEL_NONE } from "../src/parser.js";
import { Tokenizer } from "../src/tokens.js";
import * as exp from "../src/expressions/index.js";
import { ExprSet } from "../src/_py/collections.js";
import { pyTruthy, pyFalsy } from "../src/_py/truthy.js";
import { PyTypeError } from "../src/_py/errors.js";

const SQL = "SELECT a, b, c FROM t";
const TOKENS = new Tokenizer().tokenize(SQL).tokens;

/** Advance two tokens inside a `_try_parse` branch that returns `value`; did it rewind? */
function retreats(value, retreat = false) {
  const p = new Parser();
  p.reset();
  p.sql = SQL;
  p._tokens = TOKENS;
  p._tokens_size = TOKENS.length;
  p._index = -1;
  p._advance();
  const start = p._index;
  p._try_parse(() => { p._advance(2); return value; }, retreat);
  return p._index === start;
}

// [label, value, CPython retreated?]
const CASES = [
  ["None", null, true],
  ["[] (empty list)", [], true], //                     <- the reported divergence
  ["[Expr] (non-empty list)", [new exp.Identifier({ this: "a" })], false],
  ['"" (empty str)', "", true],
  ['"x" (non-empty str)', "x", false],
  ["0", 0, true],
  ["1", 1, false],
  ["False", false, true],
  ["True", true, false],
  ["{} (empty dict)", {}, true],
  ["{'a': 1} (dict)", { a: 1 }, false],
  ["set() (empty set)", new Set(), true],
  ["{1} (non-empty set)", new Set([1]), false],
  ["Expr", new exp.Identifier({ this: "a" }), false],
  ["Expr with NO args", new exp.Identifier(), false], // truthy: no __bool__, no __len__
  ["0.0", 0.0, true],
  ["ExprSet() (empty)", new ExprSet(), true],
  ["Map() (empty)", new Map(), true],
  // Adjacent inputs, all confirmed against CPython with the same harness.
  ["[[]] (list holding an empty list)", [[]], false], // len 1 -> truthy, despite looking empty
  ["[None]", [null], false],
  ["NaN", NaN, false], //     py: bool(float('nan')) is True. JS `!NaN` is the opposite.
  ["SENTINEL token", SENTINEL_NONE, true], // py: Token.__bool__
];

test("_try_parse retreats on Python falsiness, not JS falsiness", () => {
  for (const [label, value, want] of CASES) {
    assert.equal(retreats(value), want, `_try_parse(-> ${label})`);
  }
});

test("_try_parse(retreat=true) always rewinds, whatever the branch returned", () => {
  for (const [label, value] of CASES) {
    assert.equal(retreats(value, true), true, `_try_parse(-> ${label}, retreat=True)`);
  }
});

test("_try_parse rewinds and restores error_level on ParseError, and rethrows others", () => {
  const p = new Parser();
  p.reset();
  p.sql = SQL;
  p._tokens = TOKENS;
  p._tokens_size = TOKENS.length;
  p._index = -1;
  p._advance();
  const level = p.error_level;

  // py: `except ParseError: this = None` -> falsy -> retreat.
  assert.equal(p._try_parse(() => { p._advance(2); p.raise_error("boom"); }), null);
  assert.equal(p._index, 0);
  assert.equal(p.error_level, level);

  // py: the `finally` also runs when a non-ParseError propagates.
  const boom = new RangeError("not a ParseError");
  assert.throws(() => p._try_parse(() => { p._advance(2); throw boom; }), RangeError);
  assert.equal(p._index, 0, "cursor restored on a non-ParseError");
  assert.equal(p.error_level, level, "error_level restored on a non-ParseError");
});

test("pyTruthy implements the truth-value protocol", () => {
  for (const [label, value, falsy] of CASES) {
    assert.equal(pyTruthy(value), !falsy, `pyTruthy(${label})`);
    assert.equal(pyFalsy(value), falsy, `pyFalsy(${label})`);
  }
  // py: bool(float("nan")) is True — NaN has no __bool__/__len__, so rule 3 applies.
  // JS `!NaN` is the opposite, which is why this cannot be left to coercion.
  assert.equal(pyTruthy(NaN), true);
  assert.equal(pyTruthy(-0), false);
  assert.equal(pyTruthy(0n), false);
  assert.equal(pyTruthy(1n), true);
  // py: Token.__bool__ (tokenizer_core.py:523) — a SENTINEL token is falsy.
  assert.equal(pyTruthy(TOKENS[0]), true);
  assert.equal(pyTruthy({ bool: () => false }), false);
  // Refuse rather than guess for anything unmodelled.
  assert.throws(() => pyTruthy(Symbol("x")), PyTypeError);
});
