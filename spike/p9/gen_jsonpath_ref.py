#!/usr/bin/env python3
"""CPython oracle for AIR-2274 ("10.1 jsonpath.js").

Reproduces EVERY assertion in `tests/test_jsonpath.py` (`TestJsonpath`, 5 test
methods, including the 526-row `tests/fixtures/jsonpath/cts.json` conformance
suite the last one replays) by calling the REAL upstream `sqlglot.jsonpath.parse`
rather than re-deriving expected output by hand.

One row per selector. Each row records what CPython's own `parse(selector)` DID,
not an assumption about what it should do — in particular, `cts.json`'s own
`invalid_selector` rows do NOT require an exception in the real test (its
`except (ParseError, TokenError): pass` has no `else: fail()`), so several of
them parse successfully under sqlglot's intentionally-partial JSONPath grammar
even though the external conformance suite marks them invalid against the full
RFC 9535 spec. Recording the actual outcome (ok-with-repr/sql, or
error-with-type) and requiring the port to match it EXACTLY is a strictly
stronger oracle than the loose test semantics, not a weaker one.

Two row kinds:
  "ast"   — compares `repr(parse(selector))` (or `repr(parse(selector)
            .expressions[-1])` for the falsey-member rows), reusing the already
            byte-verified `Expr.__repr__` <-> `Expr.prototype.toString()`
            equivalence (PORT_PLAN.md R21) instead of a bespoke AST dumper.
  "parse" — compares the parse/outcome: "ok" with `repr`+`sql`, or "error" with
            the exception class name.

    PYTHONHASHSEED=0 python3 spike/p9/gen_jsonpath_ref.py > spike/out/jsonpath.json
    node spike/p9/fuzz_jsonpath.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-complete-pin")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import exp  # noqa: E402
from sqlglot.errors import ParseError, TokenError  # noqa: E402
from sqlglot.jsonpath import parse  # noqa: E402

rows = []


def add_ast_row(name, selector, extract, node):
    """`extract` tells the JS side which sub-node of `parse(selector)` `node`'s
    repr was taken from: "full" for the whole `exp.JSONPath`, "last_expr" for
    `.expressions[-1]` (the falsey-member rows, which never call `.sql()`)."""
    rows.append({"name": name, "kind": "ast", "selector": selector, "extract": extract, "repr": repr(node)})


def add_parse_row(name, selector, expect_error=None, expect_sql=None):
    try:
        path = parse(selector)
    except (ParseError, TokenError) as e:
        error_type = type(e).__name__
        if expect_error is not None:
            assert error_type == expect_error, f"{name} ({selector!r}): raised {error_type}, want {expect_error}"
        rows.append({"name": name, "kind": "parse", "selector": selector, "outcome": "error", "error_type": error_type})
        return
    if expect_error is not None:
        raise AssertionError(f"{name} ({selector!r}): expected {expect_error}, parsed successfully instead")
    sql = path.sql()
    if expect_sql is not None:
        assert sql == expect_sql, f"{name} ({selector!r}): sql={sql!r} != {expect_sql!r}"
    rows.append({
        "name": name, "kind": "parse", "selector": selector, "outcome": "ok",
        "repr": repr(path), "sql": sql,
    })


# --------------------------------------------------------------------------- #
# test_jsonpath
# --------------------------------------------------------------------------- #
_big_selector = "$.*.a[0]['x'][*, 'y', 1].z[?(@.a == 'b'), 1:][1:5][1,?@.a][(@.x)]"
_expected_expressions = [
    exp.JSONPathRoot(),
    exp.JSONPathKey(this=exp.JSONPathWildcard()),
    exp.JSONPathKey(this="a"),
    exp.JSONPathSubscript(this=0),
    exp.JSONPathKey(this="x"),
    exp.JSONPathUnion(expressions=[exp.JSONPathWildcard(), "y", 1]),
    exp.JSONPathKey(this="z"),
    exp.JSONPathSelector(this=exp.JSONPathFilter(this="(@.a == 'b'), 1:")),
    exp.JSONPathSubscript(this=exp.JSONPathSlice(start=1, end=5, step=None)),
    exp.JSONPathUnion(expressions=[1, exp.JSONPathFilter(this="@.a")]),
    exp.JSONPathSelector(this=exp.JSONPathScript(this="@.x)")),
]
_got = parse(_big_selector)
_want = exp.JSONPath(expressions=_expected_expressions)
assert _got == _want, f"test_jsonpath: {_got!r} != {_want!r}"
add_ast_row("test_jsonpath", _big_selector, "full", _got)

# --------------------------------------------------------------------------- #
# test_unclosed_filter_raises_parse_error
# --------------------------------------------------------------------------- #
for selector in ("$[?(@.x", "$[(@.x", "$[?(1"):
    add_parse_row(f"test_unclosed_filter_raises_parse_error[{selector!r}]", selector, expect_error="ParseError")

# --------------------------------------------------------------------------- #
# test_identity
# --------------------------------------------------------------------------- #
for selector, expected in (
    ("$.select", "$.select"),
    ("$[(@.length-1)]", "$[(@.length-1)]"),
    ("$[((@.length-1))]", "$[((@.length-1))]"),
):
    add_parse_row(f"test_identity[{selector!r}]", selector, expect_sql=f"'{expected}'")

# --------------------------------------------------------------------------- #
# test_union_preserves_falsey_members
# --------------------------------------------------------------------------- #
for selector, expected in (
    ("$[1,0]", exp.JSONPathUnion(expressions=[1, 0])),
    ('$["a",""]', exp.JSONPathUnion(expressions=["a", ""])),
    ('$["",1]', exp.JSONPathUnion(expressions=["", 1])),
):
    last = parse(selector).expressions[-1]
    assert last == expected, f"test_union_preserves_falsey_members[{selector!r}]: {last!r} != {expected!r}"
    add_ast_row(f"test_union_preserves_falsey_members[{selector!r}]", selector, "last_expr", last)

_last = parse("$[0]").expressions[-1]
_want_subscript = exp.JSONPathSubscript(this=0)
assert _last == _want_subscript, f"test_union_preserves_falsey_members[$[0]]: {_last!r} != {_want_subscript!r}"
add_ast_row("test_union_preserves_falsey_members[$[0]]", "$[0]", "last_expr", _last)

# --------------------------------------------------------------------------- #
# test_cts_file
# --------------------------------------------------------------------------- #
# Copied verbatim from `TestJsonpath.test_cts_file`'s own local `overrides` dict
# (tests/test_jsonpath.py) -- sqlglot's JSON path generator rewrites these to a
# normal form, so the raw selector is not always what `.sql()` produces.
overrides = {
    "$.☺": '$["☺"]',
    """$['a',1]""": """$["a",1]""",
    """$[*,'a']""": """$[*,"a"]""",
    """$..['a','d']""": """$..["a","d"]""",
    """$[1, ?@.a=='b', 1:]""": """$[1,?@.a=='b', 1:]""",
    """$["a"]""": """$.a""",
    """$["c"]""": """$.c""",
    """$['a']""": """$.a""",
    """$['c']""": """$.c""",
    """$[' ']""": """$[" "]""",
    """$['\\'']""": """$["\'"]""",
    """$['\\\\']""": """$["\\\\"]""",
    """$['\\/']""": """$["\\/"]""",
    """$['\\b']""": """$["\\b"]""",
    """$['\\f']""": """$["\\f"]""",
    """$['\\n']""": """$["\\n"]""",
    """$['\\r']""": """$["\\r"]""",
    """$['\\t']""": """$["\\t"]""",
    """$['\\u263A']""": """$["\\u263A"]""",
    """$['\\u263a']""": """$["\\u263a"]""",
    """$['\\uD834\\uDD1E']""": """$["\\uD834\\uDD1E"]""",
    """$['\\uD83D\\uDE00']""": """$["\\uD83D\\uDE00"]""",
    """$['']""": """$[""]""",
    """$[? @.a]""": """$[?@.a]""",
    """$[?\n@.a]""": """$[?@.a]""",
    """$[?\t@.a]""": """$[?@.a]""",
    """$[?\r@.a]""": """$[?@.a]""",
    """$[? (@.a)]""": """$[?(@.a)]""",
    """$[?\n(@.a)]""": """$[?(@.a)]""",
    """$[?\t(@.a)]""": """$[?(@.a)]""",
    """$[?\r(@.a)]""": """$[?(@.a)]""",
    """$[ ?@.a]""": """$[?@.a]""",
    """$[\n?@.a]""": """$[?@.a]""",
    """$[\t?@.a]""": """$[?@.a]""",
    """$[\r?@.a]""": """$[?@.a]""",
    """$ ['a']""": """$.a""",
    """$\n['a']""": """$.a""",
    """$\t['a']""": """$.a""",
    """$\r['a']""": """$.a""",
    """$['a'] ['b']""": """$.a.b""",
    """$['a'] \n['b']""": """$.a.b""",
    """$['a'] \t['b']""": """$.a.b""",
    """$['a'] \r['b']""": """$.a.b""",
    """$ .a""": """$.a""",
    """$\n.a""": """$.a""",
    """$\t.a""": """$.a""",
    """$\r.a""": """$.a""",
    """$[ 'a']""": """$.a""",
    """$[\n'a']""": """$.a""",
    """$[\t'a']""": """$.a""",
    """$[\r'a']""": """$.a""",
    """$['a' ]""": """$.a""",
    """$['a'\n]""": """$.a""",
    """$['a'\t]""": """$.a""",
    """$['a'\r]""": """$.a""",
    """$['a' ,'b']""": """$["a","b"]""",
    """$['a'\n,'b']""": """$["a","b"]""",
    """$['a'\t,'b']""": """$["a","b"]""",
    """$['a'\r,'b']""": """$["a","b"]""",
    """$['a', 'b']""": """$["a","b"]""",
    """$['a',\n'b']""": """$["a","b"]""",
    """$['a',\t'b']""": """$["a","b"]""",
    """$['a',\r'b']""": """$["a","b"]""",
    """$[1 :5:2]""": """$[1:5:2]""",
    """$[1\n:5:2]""": """$[1:5:2]""",
    """$[1\t:5:2]""": """$[1:5:2]""",
    """$[1\r:5:2]""": """$[1:5:2]""",
    """$[1: 5:2]""": """$[1:5:2]""",
    """$[1:\n5:2]""": """$[1:5:2]""",
    """$[1:\t5:2]""": """$[1:5:2]""",
    """$[1:\r5:2]""": """$[1:5:2]""",
    """$[1:5 :2]""": """$[1:5:2]""",
    """$[1:5\n:2]""": """$[1:5:2]""",
    """$[1:5\t:2]""": """$[1:5:2]""",
    """$[1:5\r:2]""": """$[1:5:2]""",
    """$[1:5: 2]""": """$[1:5:2]""",
    """$[1:5:\n2]""": """$[1:5:2]""",
    """$[1:5:\t2]""": """$[1:5:2]""",
    """$[1:5:\r2]""": """$[1:5:2]""",
}

with open(os.path.join(REF, "tests", "fixtures", "jsonpath", "cts.json"), encoding="utf-8") as f:
    cts_tests = json.load(f)["tests"]

for i, t in enumerate(cts_tests):
    selector = t["selector"]
    name = f"test_cts_file[{i}][{selector.strip()!r}]"
    try:
        path = parse(selector)
    except (ParseError, TokenError) as e:
        rows.append({
            "name": name, "kind": "parse", "selector": selector, "outcome": "error",
            "error_type": type(e).__name__, "invalid_selector": bool(t.get("invalid_selector")),
        })
        continue
    sql = path.sql()
    if not t.get("invalid_selector"):
        want = "'" + overrides.get(selector, selector) + "'"
        assert sql == want, f"{name}: sql={sql!r} != {want!r}"
    rows.append({
        "name": name, "kind": "parse", "selector": selector, "outcome": "ok",
        "repr": repr(path), "sql": sql, "invalid_selector": bool(t.get("invalid_selector")),
    })

for r in rows:
    sys.stdout.write(json.dumps(r, ensure_ascii=False) + "\n")
