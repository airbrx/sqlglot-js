// Structural/behavioral tests for `src/optimizer/normalize.js`, runnable with no
// Python present.
//
// The deep differential signal (this file's output vs CPython's
// `sqlglot.optimizer.normalize`, over the real upstream fixture corpus plus the
// module's own doctests and `test_normalize`/`test_normalization_distance` inline
// assertions) lives in `spike/p10/fuzz_normalize.mjs` -- see that file and
// `gen_normalize_ref.py`'s own header. These tests assert the same contract directly,
// with no CPython dependency, plus branches the fixture corpus doesn't reach (the
// `max_distance` skip path and the `OptimizeError` recovery path, both found via
// direct CPython experimentation -- see the PR description for how each threshold
// was chosen).

import test from "node:test";
import assert from "node:assert/strict";
import { parseOne } from "../src/dialects/dialect.js";
import { captureLogs } from "../src/logging.js";
import {
  normalize,
  normalized,
  normalization_distance,
  distributive_law,
} from "../src/optimizer/normalize.js";
import "../src/generator.js";
import "../src/dialects/snowflake.js";

const norm = (sql, dnf = false, maxDistance = 128) => normalize(parseOne(sql), dnf, maxDistance).sql();

test("module docstring example: CNF is the default", () => {
  assert.equal(norm("(x AND y) OR z"), "(x OR z) AND (y OR z)");
});

test("dnf=true rewrites into disjunctive normal form instead", () => {
  assert.equal(norm("x AND (y OR z)", true), "(x AND y) OR (x AND z)");
});

test("dnf=false (default) leaves an already-CNF expression alone", () => {
  assert.equal(norm("x AND (y OR z)"), "x AND (y OR z)");
});

test("a Connector with a 3rd arg (Snowflake BOOLXOR/round_input) forces _predicate_lengths to recurse into it", () => {
  const out = normalize(parseOne("(a AND b) OR BOOLXOR(x, y)", { read: "snowflake" })).sql("snowflake");
  assert.equal(out, "((BOOLXOR(x, y)) OR a) AND ((BOOLXOR(x, y)) OR b)");
});

test("normalized: dnf=true checks DNF, not CNF", () => {
  assert.equal(normalized(parseOne("(a AND b) OR c OR (d AND e)"), true), true);
});

test("normalized: CNF is the default check", () => {
  assert.equal(normalized(parseOne("(a OR b) AND c")), true);
});

test("normalized: a CNF-shaped expression is not DNF", () => {
  assert.equal(normalized(parseOne("a AND (b OR c)"), true), false);
});

test("normalization_distance module docstring example", () => {
  assert.equal(normalization_distance(parseOne("(a AND b) OR (c AND d)")), 4);
});

test("normalization_distance grows with predicate-tree depth (test_normalization_distance scenarios)", () => {
  const genExpr = (depth) => parseOne(Array(depth).fill("a AND b").join(" OR "));
  assert.equal(normalization_distance(genExpr(2), false, 100), 4);
  assert.equal(normalization_distance(genExpr(3), false, 100), 18);
  assert.equal(normalization_distance(genExpr(10), false, 100), 110);
});

test("normalization_distance truncates _predicate_lengths early when max_ is small (matches CPython's own approximation, not a bug)", () => {
  // Verified directly against CPython: normalization_distance(..., max_=0) == -2,
  // NOT the true distance (4) -- the depth-based early cutoff changes the returned
  // value, by design (it is an estimate of conversion cost, not an exact count).
  assert.equal(normalization_distance(parseOne("(a AND b) OR (c AND d)"), false, 0), -2);
});

test("max_distance skip path: distance exceeds max, expression returned unchanged, INFO logged", () => {
  const sql = "(a AND b) OR (c AND d)";
  const { output, result } = captureLogs(() => normalize(parseOne(sql), false, 3));
  assert.equal(result.sql(), sql);
  assert.equal(output.length, 1);
  assert.match(output[0], /^INFO:sqlglot:Skipping normalization because distance 4 exceeds max 3$/);
});

test("OptimizeError recovery path: distributive_law's own internal distance check throws past the top-level gate, original is restored", () => {
  // Found by brute-force search against CPython: at max_distance=1, the ROOT's own
  // gate in `normalize()` computes distance=4 (via the same truncated-max_ formula
  // above) which is > 1, so in principle this looks identical to the plain skip
  // path -- except CPython actually takes the `except OptimizeError` branch here
  // (confirmed via the distinct log message below), not the plain `if distance >
  // max_distance` skip. Both are externally `.sql()`-indistinguishable at the root
  // (both return the untouched original), so the log message is the only fingerprint.
  const sql = "((a AND b) OR (c AND d)) AND ((e AND f) OR (g AND h))";
  const { output, result } = captureLogs(() => normalize(parseOne(sql), false, 1));
  assert.equal(result.sql(), sql);
  assert.equal(output.length, 1);
  assert.match(output[0], /^INFO:sqlglot:Normalization distance 4 exceeds max 1$/);
});

test("distributive_law throws OptimizeError directly when its own distance exceeds max_distance", () => {
  assert.throws(
    () => distributive_law(parseOne("(a AND b) OR (c AND d)"), false, 3),
    /Normalization distance 4 exceeds max 3/,
  );
});

test("distributive_law is a no-op when the expression is already normalized", () => {
  const already = parseOne("(a OR b) AND c");
  assert.equal(distributive_law(already, false, 128).sql(), "(a OR b) AND c");
});

test("normalize leaves a non-Connector expression (e.g. a bare SELECT) alone", () => {
  assert.equal(norm("SELECT * FROM t WHERE a = 1"), "SELECT * FROM t WHERE a = 1");
});
