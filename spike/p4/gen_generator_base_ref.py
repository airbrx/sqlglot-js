#!/usr/bin/env python3
"""CPython oracle for the P4 base-`Generator` blocking step.

  python3 spike/p4/gen_generator_base_ref.py > spike/out/generator_base.json
  node spike/p4/fuzz_generator_base.mjs

Covers three things the blocking step must get right, none of which any existing
corpus row can check — the generate-oracle corpus asserts whole-statement SQL, and
there is no whole statement this skeleton can render yet:

  A. THE 126 CLASS-LEVEL SETTINGS, by value.  PORT_PLAN.md §8.1 Rule 2' seeds these
     one per line, but nothing anywhere asserts the VALUES against upstream, so a
     transcribed `static FOO = true` that is False upstream is invisible until some
     dialect finally reads it.  That is R16's hazard class ("non-stub is not evidence
     of ported") applied to data rather than code.  Booleans/strings/ints/None are
     compared directly; containers are compared by size and, where the elements are
     expression classes or plain scalars, by content.

  B. THE MACHINERY PRIMITIVES, driven directly: sep/seg/indent/too_wide/
     sanitize_comment/maybe_comment/format_args/func/normalize_func/escape_str, at
     both pretty=False and pretty=True.  `too_wide` and `sanitize_comment` are
     corpus-invisible by construction (review finding B2 / R4): a `.length` port of
     `too_wide` passes every corpus row and is still wrong, so the cases below are
     deliberately non-ASCII and astral.

  C. THE 6 WIRED `*_sql` METHODS plus both `sql()` fallbacks (Func ->
     function_fallback_sql, Property -> property_sql) and the "unsupported expression
     type" error path.  Each case ships its AST via the same lossless astdump format
     the P3 oracle uses, so the JS side rebuilds an identical tree with `astLoad`
     rather than re-parsing — this measures the generator, not the parser.
"""
import json
import os
import re
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
# REF only — NOT REF/tests: `tests/sqlglot/` exists as a fixture package and shadows
# the real `sqlglot` if it comes first on the path.
sys.path.insert(0, REF)
os.chdir(REF)

import sqlglot.expressions as exp  # noqa: E402
from sqlglot.generator import Generator  # noqa: E402


def spec(node):
    """Minimal recursive build-spec: enough for the JS side to rebuild the same tree.

    Deliberately NOT `tools/astdump.py`'s `dump` — that one is a closure inside
    `main()` and not importable, and copying its body here would be a second
    serialiser free to drift from the first.  Tree identity is not ASSUMED from this
    spec either: every case also carries Python's `repr(node)`, and the JS side must
    reproduce it with `toS` before its SQL is compared.  If the two trees differ, the
    repr check fails first and names the case.
    """
    if isinstance(node, exp.Expr):
        return {"c": type(node).__name__, "a": {k: spec(v) for k, v in node.args.items()}}
    if isinstance(node, list):
        return [spec(v) for v in node]
    if isinstance(node, (str, int, float, bool)) or node is None:
        return node
    return {"lit": repr(node)}


# ---- A. class-level settings ------------------------------------------------------
def encode_setting(v):
    """Encode a ClassVar so the JS side can compare without guessing at the shape."""
    if v is None or isinstance(v, (bool, int, float, str)):
        return {"kind": "scalar", "value": v}
    if isinstance(v, type):
        return {"kind": "class", "value": v.__name__}
    if isinstance(v, (set, frozenset, tuple, list)):
        items = []
        for x in v:
            if isinstance(x, type):
                items.append(f"exp.{x.__name__}")
            elif isinstance(x, exp.DataType.Type):
                items.append(f"DType.{x.name}")
            elif isinstance(x, (str, int, float, bool)) or x is None:
                items.append(x)
            else:
                items.append(f"<{type(x).__name__}>")
        return {
            "kind": "seq",
            "ordered": isinstance(v, (tuple, list)),
            "size": len(v),
            "items": items,
        }
    if isinstance(v, dict):
        keys, vals = [], []
        for k, val in v.items():
            keys.append(
                f"exp.{k.__name__}"
                if isinstance(k, type)
                else (f"DType.{k.name}" if isinstance(k, exp.DataType.Type) else k)
            )
            if isinstance(val, type):
                vals.append(f"exp.{val.__name__}")
            elif isinstance(val, exp.DataType.Type):
                vals.append(f"DType.{val.name}")
            elif callable(val):
                vals.append("<callable>")
            elif isinstance(val, (str, int, float, bool)) or val is None:
                vals.append(val)
            else:
                vals.append(f"<{type(val).__name__}>")
        return {"kind": "map", "size": len(v), "keys": keys, "values": vals}
    if isinstance(v, re.Pattern):
        # Compared by PATTERN SOURCE, not by object: a regex setting that silently
        # differs is exactly as damaging as a wrong boolean, and "opaque" would have
        # hidden it.
        return {"kind": "regex", "pattern": v.pattern}
    if callable(v):
        return {"kind": "callable"}
    return {"kind": "other", "repr": repr(v)}


SLOT_DESCRIPTOR = type(Generator.pretty)  # `member_descriptor`, from __slots__

settings = {}
for name in sorted(vars(Generator)):
    if name.startswith("__"):
        continue
    v = vars(Generator)[name]
    if isinstance(v, SLOT_DESCRIPTOR):
        continue  # an INSTANCE attribute declared in __slots__, not a class setting
    if callable(v) and not isinstance(v, (type, set, frozenset, dict, tuple, list)):
        continue  # a method, not a setting
    settings[name] = encode_setting(v)

# PORT_PLAN.md §8.1 Rule 2' measures generator.py's class body as "TRANSFORMS (143
# entries) + 126 settings".  Assert that here rather than trusting it: if upstream
# gains or loses a ClassVar at the next pin, this fails loudly instead of silently
# shrinking the surface the JS side is checked against.
assert len(settings) == 126, f"expected 126 class settings, found {len(settings)}"
assert len(Generator.TRANSFORMS) == 143, f"expected 143 TRANSFORMS, found {len(Generator.TRANSFORMS)}"


# ---- B. machinery primitives ------------------------------------------------------
# Deliberately astral/non-ASCII: `too_wide` sums `len()` over CODE POINTS, and a
# `.length` port over-counts every character outside the BMP.  The corpus is 0.024%
# non-ASCII, so nothing else in this repo would catch it.
ASTRAL = "\U0001f600\U0001f601\U0001f602"  # 3 code points, 6 UTF-16 units
CJK = "中文字"

prims = []


def prim(label, fn):
    for pretty in (False, True):
        g = Generator(pretty=pretty)
        try:
            out = {"ok": True, "value": fn(g)}
        except Exception as e:  # noqa: BLE001 — the error itself is the contract
            out = {"ok": False, "error": type(e).__name__}
        prims.append({"label": label, "pretty": pretty, **out})


prim("sep()", lambda g: g.sep())
prim("sep(', ')", lambda g: g.sep(", "))
prim("sep('')", lambda g: g.sep(""))
prim("seg(FOO)", lambda g: g.seg("FOO"))
prim("seg(FOO,'')", lambda g: g.seg("FOO", sep=""))
prim("indent(a\\nb)", lambda g: g.indent("a\nb"))
prim("indent(a\\nb,level=2)", lambda g: g.indent("a\nb", level=2))
prim("indent(a\\nb,pad=0,skip_first)", lambda g: g.indent("a\nb", pad=0, skip_first=True))
prim("indent(a\\nb,skip_last)", lambda g: g.indent("a\nb", skip_last=True))
prim("too_wide(ascii 79)", lambda g: g.too_wide(["x" * 79]))
prim("too_wide(ascii 81)", lambda g: g.too_wide(["x" * 81]))
prim("too_wide(astral 27x)", lambda g: g.too_wide([ASTRAL * 27]))  # 81 code points
prim("too_wide(astral 26x)", lambda g: g.too_wide([ASTRAL * 26]))  # 78 code points
prim("too_wide(cjk 27x)", lambda g: g.too_wide([CJK * 27]))
prim("too_wide(split)", lambda g: g.too_wide(["x" * 40, "y" * 41]))
prim("sanitize_comment(hi)", lambda g: g.sanitize_comment("hi"))
prim("sanitize_comment( hi )", lambda g: g.sanitize_comment(" hi "))
prim("sanitize_comment(*/)", lambda g: g.sanitize_comment("a*/b"))
prim("sanitize_comment(/*)", lambda g: g.sanitize_comment("a/*b"))
prim("sanitize_comment(both)", lambda g: g.sanitize_comment("/*a*/"))
prim("sanitize_comment(astral)", lambda g: g.sanitize_comment(ASTRAL))
# NBSP is `str.isspace()`-true in Python, so `.strip()` removes it and no padding
# space is added. Written as an escape, never a literal: an invisible U+00A0 in source
# is unreviewable, and it silently differed from the JS side's plain space first time.
prim("sanitize_comment(nbsp)", lambda g: g.sanitize_comment("\u00a0x\u00a0"))
prim("normalize_func(foo)", lambda g: g.normalize_func("foo"))
prim("format_args(1,2)", lambda g: g.format_args(exp.Literal.number(1), exp.Literal.number(2)))
prim("format_args(sep=|)", lambda g: g.format_args(exp.Literal.number(1), exp.Literal.number(2), sep="|"))
prim("format_args(drops bools)", lambda g: g.format_args(exp.Literal.number(1), True, None, exp.Literal.number(2)))
prim("func(F,1)", lambda g: g.func("f", exp.Literal.number(1)))
prim("func(F,suffix)", lambda g: g.func("f", exp.Literal.number(1), suffix="]"))
prim("func(F,normalize=False)", lambda g: g.func("f", exp.Literal.number(1), normalize=False))
prim("escape_str(quote)", lambda g: g.escape_str("it's"))
prim("escape_str(newline)", lambda g: g.escape_str("a\nb"))
prim("escape_str(astral)", lambda g: g.escape_str(ASTRAL))
prim("maybe_comment(plain)", lambda g: g.maybe_comment("SQL", comments=["c1"]))
prim("maybe_comment(two)", lambda g: g.maybe_comment("SQL", comments=["c1", "c2"]))
prim("maybe_comment(separated)", lambda g: g.maybe_comment("SQL", comments=["c1"], separated=True))
prim("maybe_comment(leading ws)", lambda g: g.maybe_comment(" SQL", comments=["c1"], separated=True))
prim("maybe_comment(empty sql)", lambda g: g.maybe_comment("", comments=["c1"], separated=True))
prim("maybe_comment(none)", lambda g: g.maybe_comment("SQL", comments=None))
prim("wrap(select)", lambda g: g.wrap(exp.select(exp.Star()).from_(exp.to_table("t"))))


# ---- C. the wired *_sql methods + both fallbacks ----------------------------------
def lit_s(v):
    return exp.Literal.string(v)


cases = [
    ("Null", exp.Null()),
    ("Boolean true", exp.Boolean(this=True)),
    ("Boolean false", exp.Boolean(this=False)),
    ("Literal number", exp.Literal.number(42)),
    ("Literal number neg", exp.Literal.number(-1.5)),
    ("Literal string", lit_s("abc")),
    ("Literal string quote", lit_s("it's")),
    ("Literal string empty", lit_s("")),
    ("Literal string astral", lit_s(ASTRAL)),
    ("Literal string cjk", lit_s(CJK)),
    ("Literal string newline", lit_s("a\nb")),
    ("Literal string backslash", lit_s("a\\b")),
    ("Star", exp.Star()),
    # The list members are LITERALS, not Columns, on purpose. `column_sql` is still a
    # stub at this step, so a Column here would make every one of these cases stop at
    # the stub and leave `star_sql`'s three list branches — and with them the only test
    # of the `except_` reserved-word arg key (rule 4) and of the
    # `this.constructor.STAR_EXCEPT` class read (rule 1) — completely unexercised.
    # `expressions()` only ever calls `self.sql(e)` on each member, so what the member
    # IS does not change the path under test; the SQL is odd but it is CPython's own
    # odd SQL, which is the whole point of a differential.
    ("Star except", exp.Star(**{"except_": [lit_s("a"), lit_s("b")]})),
    ("Star replace", exp.Star(replace=[lit_s("a")])),
    ("Star rename", exp.Star(rename=[lit_s("a")])),
    ("Star ilike", exp.Star(ilike=lit_s("x%"))),
    ("Star except+replace", exp.Star(**{"except_": [lit_s("a")], "replace": [lit_s("b")]})),
    ("Star all four", exp.Star(**{"except_": [lit_s("a")], "replace": [lit_s("b")], "rename": [lit_s("c")], "ilike": lit_s("d")})),
    # `sql()` fallback 1: a Func with no `*_sql` method of its own reaches
    # `function_fallback_sql`, which iterates `arg_types` in DECLARATION order.
    ("Func fallback Abs", exp.Abs(this=exp.Literal.number(1))),
    ("Func fallback nested", exp.Abs(this=exp.Abs(this=exp.Literal.number(2)))),
    # `sql()` fallback 2: a bare Property reaches `property_sql`.
    ("Property bare", exp.Property(this=lit_s("k"), value=lit_s("v"))),
]

gen_cases = []
for label, node in cases:
    for pretty in (False, True):
        g = Generator(pretty=pretty)
        try:
            sql = g.sql(node.copy())
            rec = {"ok": True, "sql": sql, "unsupported": list(g.unsupported_messages)}
        except Exception as e:  # noqa: BLE001
            rec = {"ok": False, "error": type(e).__name__, "message": str(e)}
        if pretty is False:
            rec["spec"] = spec(node)
            rec["repr"] = repr(node)
        gen_cases.append({"label": label, "pretty": pretty, **rec})

# The error path: `sql()` raises for a node that is neither dispatched, nor a Func,
# nor a Property.  Asserting this keeps the two fallbacks from silently widening.
try:
    Generator().sql(exp.Expr())
    unsupported_type = {"raised": False}
except Exception as e:  # noqa: BLE001
    unsupported_type = {"raised": True, "error": type(e).__name__, "message": str(e)}

json.dump(
    {
        "pin": "91119bc",
        "settings": settings,
        "primitives": prims,
        "gen_cases": gen_cases,
        "unsupported_type": unsupported_type,
    },
    sys.stdout,
    indent=1,
)
sys.stdout.write("\n")
