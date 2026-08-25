// PORT_PLAN.md §4.6 claims `\w` maps to `[\p{L}\p{Nd}\p{Nl}\p{No}_]` "for identifier
// quoting specifically", and that this is "directly output-visible". This asserts
// both halves against the real call site rather than restating the plan.
//
//   sqlglot/expressions/core.py:2810  SAFE_IDENTIFIER_RE = re.compile(r"^[_a-zA-Z][\w]*$")
//   sqlglot/expressions/core.py:2843  quoted=not SAFE_IDENTIFIER_RE.match(name) if quoted is None else quoted
//
// The `expected` column below is CPython 3.9.25's answer, captured by running the
// real library (spike/py/demo_identifier_quoting.py).
//
// Run: node --test spike/regex/test_identifier_quoting.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { PyPattern } from "../../src/_py/re.js";

// py: sqlglot/expressions/core.py:2810, verbatim
const SAFE_IDENTIFIER_RE = new PyPattern("^[_a-zA-Z][\\w]*$", 0);
// What a port that spells Python's `\w` as JavaScript's `\w` would compute.
const NAIVE = /^[_a-zA-Z][A-Za-z0-9_]*$/u;

/** name -> CPython's SAFE_IDENTIFIER_RE.match(name) is not None */
const CASES = [
  ["abc", true],
  ["a1", true],
  ["_x", true],
  ["1abc", false],
  ["", false],
  ["a b", false],
  ["café", true], // NFC: é is \p{Ll}
  ["café", false], // NFD: combining acute is \p{Mn}, which is NOT \w
  ["aÊß", true],
  ["aЖ", true],
  ["naïve_col", true],
  ["aⅣ", true], // \p{Nl}
  ["a½", true], // \p{No}
  ["a٠", true], // \p{Nd}
  ["a☺", false], // \p{So}
  ["a\u{1F600}", false], // astral \p{So}
  ["a　b", false], // ideographic space
];

test("_py/re.js reproduces CPython for SAFE_IDENTIFIER_RE", () => {
  for (const [name, expected] of CASES) {
    assert.equal(
      SAFE_IDENTIFIER_RE.match(name) !== null,
      expected,
      `SAFE_IDENTIFIER_RE.match(${JSON.stringify(name)})`,
    );
  }
});

test("a naive JS `\\w` port would change generated SQL", () => {
  const divergent = CASES.filter(([name, expected]) => NAIVE.test(name) !== expected);
  // These are the names where identifier quoting flips, i.e. where the port
  // would emit SELECT "café" FROM t against CPython's SELECT café FROM t.
  assert.deepEqual(
    divergent.map(([n]) => n),
    ["café", "aÊß", "aЖ", "naïve_col", "aⅣ", "a½", "a٠"],
  );
  for (const [name] of divergent) {
    assert.equal(NAIVE.test(name), false, `naive \\w accepts ${name}?`);
    assert.notEqual(SAFE_IDENTIFIER_RE.match(name), null);
  }
});

test("astral and combining marks are NOT word characters in CPython", () => {
  // Guards the mapping against the tempting-but-wrong `\p{Alphabetic}` and
  // `[\p{L}\p{M}\p{Nd}\p{Pc}]` alternatives, both of which the full-range sweep
  // rejected (spike/regex/FINDINGS.md).
  assert.equal(SAFE_IDENTIFIER_RE.match("café"), null);
  assert.equal(SAFE_IDENTIFIER_RE.match("a\u{1F600}"), null);
});
