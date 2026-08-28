// Regression tests for the hand-written-identity bug class (PR #6 review finding 9).
//
// Every expectation is CPython @ 91119bc, produced by instantiating the real classes.
// The shared root cause: `defineExpr` builds all 1,048 classes as direct subclasses of
// `Expr`, so a Python `t.ClassVar` on a base does not reach its subclasses and a
// `constructor.name === "X"` test answers "no" for every subclass of X. `instanceof`
// is safe (defineExpr installs a `Symbol.hasInstance` over the generated MRO); name
// comparison is not, and `tools/lint_identity.mjs` now fails on it.

import test from "node:test";
import assert from "node:assert/strict";
import * as e from "../../src/expressions/index.js";
import { EXPR_META } from "../../src/_gen/expr_meta.js";
import { PyValueError } from "../../src/_py/errors.js";
import {
  JOIN_METHODS, JOIN_SIDES, JOIN_KINDS,
} from "../../src/expressions/query_methods.js";
import { Parser } from "../../src/parser.js";
import { TOKEN_TYPE_NAMES } from "../../src/tokenizer_core.js";

const col = (n = "a") => new e.Column({ this: new e.Identifier({ this: n, quoted: false }) });
const L = (s, isStr = false) => new e.Literal({ this: s, is_string: isStr });

test("is_data_type is inherited by every DataType subclass", () => {
  // py: datatypes.py:190 `is_data_type: t.ClassVar[bool] = True` on DataType; PseudoType,
  // ObjectIdentifier and IntervalSpan subclass it and inherit. CPython: all four report
  // is_data_type True and `x.type is x`. The port set the flag on DataType alone, so
  // `IntervalSpan().type` was undefined.
  for (const name of ["DataType", "PseudoType", "ObjectIdentifier", "IntervalSpan"]) {
    const node = name === "DataType"
      ? new e.DataType({ this: e.DType.INT })
      : new e[name]({ this: new e.Var({ this: "x" }) });
    assert.equal(e[name].isDataType, true, `${name}.is_data_type`);
    assert.strictEqual(node.type, node, `${name}().type is self`);
  }
  // Negative: a class that is not in that hierarchy must not pick the flag up.
  assert.notEqual(e.Column.isDataType, true);
  assert.equal(col().type, null);
});

test("is_cast is inherited by every Cast subclass, and by nothing else", () => {
  // py: functions.py:35 on Cast -> Cast, JSONCast, TryCast.
  for (const name of ["Cast", "JSONCast", "TryCast"]) assert.equal(e[name].isCast, true, name);
  // The classes a `/Cast$/` regex would also have matched, if any existed, plus the
  // near-miss names. Derived from the catalogue so this cannot go stale.
  const flagged = Object.values(EXPR_META).filter((m) => e[m.name].isCast).map((m) => m.name);
  assert.deepEqual(flagged.sort(), ["Cast", "JSONCast", "TryCast"]);
});

test("the class-var flags are derived from the generated MRO, not a hand list", () => {
  // If upstream adds a DataType/Cast subclass, regenerating expr_meta must be enough.
  const kids = (base) => Object.values(EXPR_META)
    .filter((m) => m.name === base || m.bases.includes(base)).map((m) => m.name).sort();
  const flaggedBy = (prop) => Object.values(EXPR_META)
    .filter((m) => e[m.name][prop]).map((m) => m.name).sort();
  assert.deepEqual(flaggedBy("isDataType"), kids("DataType"));
  assert.deepEqual(flaggedBy("isCast"), kids("Cast"));
});

test("unalias unwraps PivotAlias, because upstream is isinstance(self, Alias)", () => {
  // py: core.py:1224. PivotAlias is the one Alias subclass; CPython unwraps both.
  const alias = new e.Alias({ this: col(), alias: new e.Identifier({ this: "b" }) });
  const pivotAlias = new e.PivotAlias({ this: col(), alias: new e.Identifier({ this: "b" }) });
  assert.equal(alias.unalias().constructor.name, "Column");
  assert.equal(pivotAlias.unalias().constructor.name, "Column");
  // Not an Alias: returns self, unchanged identity.
  const c = col();
  assert.strictEqual(c.unalias(), c);
});

test("unnest stays an EXACT type test, which is upstream's own asymmetry", () => {
  // py: core.py:1218 `while type(expression) is Paren` — NOT isinstance. Paren has no
  // subclasses so nothing is observable today; the point is that the two neighbouring
  // methods differ upstream and the port must not "tidy" them into agreement.
  const p = new e.Paren({ this: new e.Paren({ this: col() }) });
  assert.equal(p.unnest().constructor.name, "Column");
});

// [node, is_string, is_number, is_int, to_py] — CPython. "!ValueError" means it RAISES.
const NUMERIC = [
  ["Literal('1')", () => L("1"), false, true, true, "int:1"],
  ["Literal('1.5')", () => L("1.5"), false, true, false, "dec:1.5"],
  ["Literal('abc')", () => L("abc"), false, true, "!ValueError", "!ValueError"],
  ["Literal('inf')", () => L("inf"), false, true, false, "dec:Infinity"],
  ["Literal('nan')", () => L("nan"), false, true, false, "dec:NaN"],
  ["Literal('binary_double_nan')", () => L("binary_double_nan"), false, true, "!ValueError", "!ValueError"],
  ["Literal('1e5')", () => L("1e5"), false, true, false, "dec:1E+5"],
  ["Literal('0x1f')", () => L("0x1f"), false, true, "!ValueError", "!ValueError"],
  ["Literal('')", () => L(""), false, true, "!ValueError", "!ValueError"],
  ["Literal('1', string)", () => L("1", true), true, false, false, "str:1"],
  ["Neg(Literal('1'))", () => new e.Neg({ this: L("1") }), false, true, true, "int:-1"],
  ["Neg(Literal('abc'))", () => new e.Neg({ this: L("abc") }), false, true, "!ValueError", "!ValueError"],
  ["Neg(Neg(Literal('1')))", () => new e.Neg({ this: new e.Neg({ this: L("1") }) }), false, true, true, "int:1"],
  ["Paren(Literal('1'))", () => new e.Paren({ this: L("1") }), false, false, false, "!ValueError"],
  ["Paren(Neg(Literal('1')))", () => new e.Paren({ this: new e.Neg({ this: L("1") }) }), false, false, false, "!ValueError"],
  ["Column(a)", () => col(), false, false, false, "!ValueError"],
  ["Boolean(True)", () => new e.Boolean({ this: true }), false, false, false, "bool:true"],
  // Adjacent inputs probed one step out from the reported cases. The Neg row is a bug
  // this pass found on its own: `Neg.to_py` is guarded by `if self.is_number`
  // (core.py:2272) and falls through to the RAISING base otherwise — the port negated
  // unconditionally and returned -1 for `Neg(Literal('1', is_string=True))`.
  ["Neg(Paren(Literal('1')))", () => new e.Neg({ this: new e.Paren({ this: L("1") }) }), false, false, false, "!ValueError"],
  ["Neg(Column)", () => new e.Neg({ this: col() }), false, false, false, "!ValueError"],
  ["Neg(Literal('1', string))", () => new e.Neg({ this: L("1", true) }), false, false, false, "!ValueError"],
  // Python's int() accepts surrounding whitespace, a sign, underscore separators and
  // Unicode decimal digits — so all four are is_int, and none of it is a regex.
  ["Literal('  1 ')", () => L("  1 "), false, true, true, "int:1"],
  ["Literal('+1')", () => L("+1"), false, true, true, "int:1"],
  ["Literal('1_0')", () => L("1_0"), false, true, true, "int:10"],
  ["Literal('٣')", () => L("٣"), false, true, true, "int:3"],
];

test("is_number / is_int / to_py match CPython, with no invented predicates", () => {
  // Two fixes are pinned here.
  //
  // (1) `Literal.is_number` was a REGEX on the literal text
  //     (`\d+|inf|nan|binary_double_nan`). Upstream has no predicate at all: any
  //     non-string Literal is a number, so `Literal('abc')` and `Literal('')` are too.
  //     `binary_double_nan` appears nowhere in the sqlglot tree.
  // (2) `is_int` unwrapped Paren. Upstream is `self.is_number and
  //     isinstance(self.to_py(), int)`, and `is_number` knows only Literal and Neg —
  //     so `(1)` is is_int=False, is_number=False. The old code produced
  //     is_int=true/is_number=false, a state CPython cannot produce.
  const describe = (v) => (typeof v === "bigint" ? `int:${v}`
    : typeof v === "string" ? `str:${v}`
      : typeof v === "boolean" ? `bool:${v}`
        : `dec:${v}`);
  for (const [label, make, isString, isNumber, isInt, toPy] of NUMERIC) {
    assert.equal(make().isString, isString, `${label}.is_string`);
    assert.equal(make().is_string, isString, `${label}.is_string (snake)`);
    assert.equal(make().isNumber, isNumber, `${label}.is_number`);
    assert.equal(make().is_number, isNumber, `${label}.is_number (snake)`);
    if (isInt === "!ValueError") assert.throws(() => make().isInt, PyValueError, `${label}.is_int raises`);
    else assert.equal(make().isInt, isInt, `${label}.is_int`);
    if (toPy === "!ValueError") assert.throws(() => make().toPy(), PyValueError, `${label}.to_py raises`);
    else assert.equal(describe(make().toPy()), toPy, `${label}.to_py`);
  }
});

test("join_type word sets are exactly the parser's JOIN token tables", () => {
  // py: query.py:1421 parses `FROM _ {join_type} JOIN _` and reads method/side/kind off
  // the resulting Join; `_parse_join_parts` (parser.py:4634) matches JOIN_METHODS,
  // JOIN_SIDES, JOIN_KINDS in that order. The builder's stand-in had drifted BOTH ways —
  // it carried GLOBAL (ClickHouse-only) and lacked STRAIGHT_JOIN. This asserts the copy
  // against the seeded tables, which are themselves parity-checked against upstream.
  const names = (set) => new Set([...set].map((t) => TOKEN_TYPE_NAMES[t]));
  assert.deepEqual([...JOIN_METHODS].sort(), [...names(Parser.JOIN_METHODS)].sort());
  assert.deepEqual([...JOIN_SIDES].sort(), [...names(Parser.JOIN_SIDES)].sort());
  assert.deepEqual([...JOIN_KINDS].sort(), [...names(Parser.JOIN_KINDS)].sort());
});

// join_type -> [method, side, kind], from CPython
// `Select().select("*").from_("tbl").join("tbl2", join_type=...)`.
const JOIN_TYPES = [
  ["left outer", "", "LEFT", "OUTER"],
  ["straight_join", "", "", "STRAIGHT_JOIN"], // was "" -> rendered as a CROSS JOIN
  ["global", "", "", ""], //                     was method=GLOBAL
  ["natural", "NATURAL", "", ""],
  ["asof", "ASOF", "", ""],
  ["cross", "", "", "CROSS"],
  ["semi", "", "", "SEMI"],
  ["anti", "", "", "ANTI"],
  ["inner", "", "", "INNER"],
  ["outer", "", "", "OUTER"],
  ["full", "", "FULL", ""],
  ["right", "", "RIGHT", ""],
  ["natural left outer", "NATURAL", "LEFT", "OUTER"],
  // Ordered single-shot matching: STRAIGHT_JOIN is a KIND, so it consumes the first
  // slot that can take it and the trailing `left` is left unmatched — exactly as
  // upstream, which a scan-every-word loop would get wrong (side=LEFT).
  ["straight_join left", "", "", "STRAIGHT_JOIN"],
  // Adjacent inputs, all confirmed against CPython: case-insensitive, extra whitespace,
  // empty, and an unrecognised word alone.
  ["LEFT OUTER", "", "LEFT", "OUTER"],
  ["Left Outer", "", "LEFT", "OUTER"],
  ["left  outer", "", "LEFT", "OUTER"],
  ["", "", "", ""],
  ["   ", "", "", ""],
  ["bogus", "", "", ""],
];

test("Select.join(join_type=...) matches CPython's method/side/kind split", () => {
  for (const [joinType, method, side, kind] of JOIN_TYPES) {
    const join = new e.Select().select("*").from_("tbl").join("tbl2", { join_type: joinType })
      .args.joins[0];
    assert.equal(join.method ?? "", method, `join_type=${joinType} method`);
    assert.equal(join.side ?? "", side, `join_type=${joinType} side`);
    assert.equal(join.kind ?? "", kind, `join_type=${joinType} kind`);
  }
});
