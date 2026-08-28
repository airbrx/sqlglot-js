// Regression tests for the P3 generator kernel.
//
// Every expectation below is CPython @ 91119bc output, produced by instantiating the
// real `sqlglot.generator.Generator` and calling the same method — not reasoned about.
//
// WHY THIS FILE EXISTS: PR #6 review finding 1. `identifier_sql` decided quoting with
// `pyIsDigit(text[0])`, where upstream is `text[:1].isdigit()`. `text[0]` in JS is a
// UTF-16 code UNIT, so for an astral digit it is a lone high surrogate and the
// classifier answered about the surrogate. The identifier shipped unquoted where
// CPython quotes it — AST-visible at parser.py:5491 (pivot column name) and
// parser.py:3179 (DefinerProperty), with no thrown error and no failing probe.
//
// That is the silent-wrongness class this kernel's `NotPorted`-everything design
// exists to prevent, and it slipped through because the corpus has no astral
// identifiers. The cases below are chosen to break BOTH directions of the fix:
// astral-digit-first must quote, astral-letter-first must not, and `str.isdigit()`
// is NOT the Nd category (U+00B2 SUPERSCRIPT TWO is No and isdigit() is True;
// U+2160 ROMAN NUMERAL ONE is Nl and isdigit() is False).

import test from "node:test";
import assert from "node:assert/strict";
import * as e from "../src/expressions/index.js";
import { GeneratorKernel, kernelSql } from "../src/generator_kernel.js";
import { cpAt, cpSlice, cpLen } from "../src/_py/str.js";
import { PyIndexError } from "../src/_py/errors.js";

const ident = (text, quoted = false) => new e.Identifier({ this: text, quoted });

// text -> [unquoted render, quoted render]. CPython Generator().identifier_sql().
const IDENTIFIER_SQL = [
  ["\u{1D7CE}abc", '"\u{1D7CE}abc"', '"\u{1D7CE}abc"'], // MATH BOLD DIGIT ZERO (Nd), first
  ["ab\u{1D7CE}", "ab\u{1D7CE}", '"ab\u{1D7CE}"'], //      astral digit, NOT first
  ["\u{1D7CE}", '"\u{1D7CE}"', '"\u{1D7CE}"'], //          astral digit alone
  ["\u{1D7CE}\u{1D7CF}", '"\u{1D7CE}\u{1D7CF}"', '"\u{1D7CE}\u{1D7CF}"'],
  ["٣abc", '"٣abc"', '"٣abc"'], //          BMP ARABIC-INDIC THREE (Nd)
  ["0abc", '"0abc"', '"0abc"'], //                         ASCII
  ["abc", "abc", '"abc"'],
  ["", "", '""'],
  ["\u{1D400}abc", "\u{1D400}abc", '"\u{1D400}abc"'], //   MATH BOLD CAPITAL A (Lu) — no quote
  ["\u{1F600}abc", "\u{1F600}abc", '"\u{1F600}abc"'], //   emoji (So) — no quote
  ["Ⅰabc", "Ⅰabc", '"Ⅰabc"'], //            ROMAN NUMERAL ONE (Nl) — isdigit() False
  ["²abc", '"²abc"', '"²abc"'], //          SUPERSCRIPT TWO (No) — isdigit() True
  ["\u{1D7CE}\"x", '"\u{1D7CE}""x"', '"\u{1D7CE}""x"'], // quoting AND delimiter escaping
  // Adjacent inputs, all confirmed against CPython. The first two matter for ORDER:
  // upstream escapes the delimiter FIRST and then tests `text[:1]`, so a leading `"`
  // becomes `""` and the identifier is NOT quoted even though it started with one.
  ['"1', '""1', '"""1"'],
  ['\u{1D7CE}"', '"\u{1D7CE}"""', '"\u{1D7CE}"""'],
  ["́abc", "́abc", '"́abc"'], //          leading COMBINING ACUTE (Mn)
  ["\u{1D7CE}́", '"\u{1D7CE}́"', '"\u{1D7CE}́"'], // astral digit + mark
  ["\uD800", "\uD800", '"\uD800"'], //                   LONE SURROGATE: must not crash
  ["  1", "  1", '"  1"'], //                            leading space, so not a digit
  ["\u{104A0}abc", '"\u{104A0}abc"', '"\u{104A0}abc"'], // OSMANYA DIGIT ZERO
  ["\u{1E950}abc", '"\u{1E950}abc"', '"\u{1E950}abc"'], // ADLAM DIGIT ZERO
  ["۱abc", '"۱abc"', '"۱abc"'], //                       EXTENDED ARABIC-INDIC ONE
  ["ᵼE", "ᵼE", '"ᵼE"'], //                U+1D7C + 'E' — NOT U+1D7CE
];

test("identifier_sql quotes on the first CODE POINT, not the first UTF-16 unit", () => {
  const g = new GeneratorKernel();
  for (const [text, unquoted, quoted] of IDENTIFIER_SQL) {
    assert.equal(g.identifier_sql(ident(text, false)), unquoted,
      `identifier_sql(Identifier(this=${JSON.stringify(text)}, quoted=False))`);
    assert.equal(g.identifier_sql(ident(text, true)), quoted,
      `identifier_sql(Identifier(this=${JSON.stringify(text)}, quoted=True))`);
  }
});

test("astral identifiers reach the kernel through the parse-path entry point", () => {
  // The two call sites the bug was reachable from, as the sub-ASTs CPython hands over:
  //   parser.py:5491  pivot field name   Column
  //   parser.py:3179  DEFINER user/host  Identifier
  assert.equal(kernelSql(new e.Column({ this: ident("\u{1D7CE}abc") })), '"\u{1D7CE}abc"');
  assert.equal(
    kernelSql(new e.Column({ this: ident("\u{1D7CE}b"), table: ident("a") })),
    'a."\u{1D7CE}b"',
  );
  assert.equal(kernelSql(ident("\u{1D7CE}abc")), '"\u{1D7CE}abc"');
  // Negative side: an astral character that is not a digit must stay bare, so a fix
  // that quotes "anything with a surrogate in it" fails here.
  assert.equal(kernelSql(new e.Column({ this: ident("\u{1D400}abc") })), "\u{1D400}abc");
  assert.equal(kernelSql(new e.Column({ this: ident("ab\u{1D7CE}") })), "ab\u{1D7CE}");
});

// CPython Generator().sanitize_comment(). Exercises `comment[0]` and `comment[-1]`,
// the kernel's other two single-code-point string reads.
const SANITIZE_COMMENT = [
  ["\u{1D7CE}c\u{1D7CF}", " \u{1D7CE}c\u{1D7CF} "],
  [" x ", " x "],
  ["x", " x "],
  ["\u{1D400}", " \u{1D400} "],
  [" ", " "],
  ["*/x", " * /x "],
  ["a\u{1D7CE}", " a\u{1D7CE} "],
];

test("sanitize_comment pads on the first and last CODE POINT", () => {
  const g = new GeneratorKernel();
  for (const [comment, want] of SANITIZE_COMMENT) {
    assert.equal(g.sanitize_comment(comment), want, JSON.stringify(comment));
  }
});

// CPython Generator().maybe_comment(sql, From(...)) — From is in WITH_SEPARATED_COMMENTS,
// so this is the `sql[0].isspace()` arm.
const MAYBE_COMMENT = [
  [" FROM x", " /* c */ FROM x"],
  ["FROM x", "/* c */ FROM x"],
  ["\u{1D7CE}x", "/* c */ \u{1D7CE}x"], //  astral first: not space, comment goes before
  ["　x", " /* c */　x"], //        IDEOGRAPHIC SPACE: isspace() is True
  ["", " /* c */"],
];

test("maybe_comment tests the first CODE POINT for whitespace", () => {
  const g = new GeneratorKernel();
  for (const [sql, want] of MAYBE_COMMENT) {
    const node = new e.From({ this: new e.Table({ this: ident("t") }) });
    node.comments = ["c"];
    assert.equal(g.maybe_comment(sql, node), want, JSON.stringify(sql));
  }
});

test("cpSlice/cpAt reproduce Python str slicing and indexing", () => {
  const s = "a\u{1D7CE}b\u{1D400}"; // 4 code points, 6 UTF-16 units
  assert.equal(cpLen(s), 4);
  assert.equal(s.length, 6, "precondition: JS length disagrees, which is the whole point");
  assert.equal(cpSlice(s, 0, 1), "a");
  assert.equal(cpSlice(s, 1, 2), "\u{1D7CE}");
  assert.equal(cpSlice(s, -1), "\u{1D400}");
  assert.equal(cpSlice(s, 2), "b\u{1D400}");
  assert.equal(cpAt(s, 0), "a");
  assert.equal(cpAt(s, 1), "\u{1D7CE}");
  assert.equal(cpAt(s, -1), "\u{1D400}");
  assert.equal(cpAt(s, -2), "b");
  // py: out-of-range `s[i]` is IndexError, not undefined.
  assert.throws(() => cpAt(s, 4), PyIndexError);
  assert.throws(() => cpAt(s, -5), PyIndexError);
  assert.throws(() => cpAt("", 0), PyIndexError);
  // py: out-of-range slices clamp instead of raising.
  assert.equal(cpSlice(s, 10, 20), "");
  assert.equal(cpSlice("", 0, 1), "");
});
