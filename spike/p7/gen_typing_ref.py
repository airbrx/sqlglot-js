#!/usr/bin/env python3
"""CPython oracle for `sqlglot/typing/__init__.py`'s base `EXPRESSION_METADATA` table.

`src/typing/index.js` is greenfield: its consumer, `TypeAnnotator`
(`sqlglot/optimizer/annotate_types.py`), is unported (AIR-2097/2098), so unlike the
AST-parsing/generation corpus this table has no existing oracle coverage at all. This
follows the same recipe `spike/p6/gen_schema_ref.py` and `spike/p7/gen_optimize_joins_
ref.py` established for other greenfield modules: exercise the REAL CPython table with
a curated battery and dump the results, so a JS-side mismatch is provably a
`typing/index.js` bug and not a coincidence.

The table's 294 entries are either `{"returns": DType}` (trivial to diff directly) or
`{"annotator": lambda self, e: self._some_method(e, ...)}` -- a closure that ROUTES to
one of ~20 private `TypeAnnotator` methods this port cannot call yet (they live in the
unported `annotate_types.py`). Rather than skip the annotator entries, this oracle
records the CALL SHAPE each one produces: a `fake_self` stand-in whose every attribute
access returns a chainable recorder, and whose every call captures `(dotted_name, args,
kwargs)` as a `Call` marker instead of actually running any logic. Calling the real
upstream lambda against `fake_self` reproduces the exact method name, positional args
(including ones the lambda computes BEFORE calling out, like `Case`'s comprehension
over `e.args["ifs"]`), and keyword args (`array=True`, `promote=True`, ...) -- everything
observable about the lambda's BODY, without needing `TypeAnnotator` to exist. A port
that dispatches `exp.Sum` through `_annotate_by_args(e, "this")` instead of the real
`_annotate_by_args(e, "this", "expressions", promote=True)` shows up as a diff in the
recorded call, exactly as if the real method had been invoked and observed.

Two probe expressions (`PROBE_TRUE`/`PROBE_FALSE`) are run through every annotator
entry, so the boolean-flag ternaries (`exp.Count`/`exp.DateDiff`'s `big_int`,
`exp.HexString`'s `is_integer`, `exp.Timestamp`'s `with_tz`) are exercised on both
branches, not just the default-falsy one.

    python3 spike/p7/gen_typing_ref.py > spike/out/typing.json
    node spike/p7/fuzz_typing.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import exp  # noqa: E402
from sqlglot.helper import subclasses  # noqa: E402
from sqlglot.typing import EXPRESSION_METADATA, TIMESTAMP_EXPRESSIONS  # noqa: E402


class Call:
    __slots__ = ("name", "args", "kwargs")

    def __init__(self, name, args, kwargs):
        self.name = name
        self.args = args
        self.kwargs = kwargs


class Recorder:
    """Every attribute access chains; every call captures a `Call` marker."""

    def __init__(self, path):
        object.__setattr__(self, "_path", path)

    def __getattr__(self, name):
        return Recorder(f"{self._path}.{name}")

    def __call__(self, *args, **kwargs):
        return Call(self._path, args, kwargs)


FAKE_SELF = Recorder("self")

PROBE_TRUE = exp.Expression(
    this="THIS_V",
    expression="EXPRESSION_V",
    expressions=["EXPR0", "EXPR1"],
    true="TRUE_V",
    false="FALSE_V",
    default="DEFAULT_V",
    to="TO_V",
    start="START_V",
    end="END_V",
    step="STEP_V",
    big_int=True,
    is_integer=True,
    with_tz=True,
    ifs=[exp.Expression(true="IF0_TRUE"), exp.Expression(true="IF1_TRUE")],
)
PROBE_FALSE = exp.Expression(
    this="THIS_V",
    expression="EXPRESSION_V",
    expressions=["EXPR0", "EXPR1"],
    true="TRUE_V",
    false="FALSE_V",
    default="DEFAULT_V",
    to="TO_V",
    start="START_V",
    end="END_V",
    step="STEP_V",
    big_int=False,
    is_integer=False,
    with_tz=False,
    ifs=[exp.Expression(true="IF0_TRUE"), exp.Expression(true="IF1_TRUE")],
)


def enc(v, probe):
    if v is probe:
        return {"$e": True}
    if isinstance(v, Call):
        return {
            "$call": v.name,
            "args": [enc(a, probe) for a in v.args],
            "kwargs": {k: enc(a, probe) for k, a in v.kwargs.items()},
        }
    if isinstance(v, exp.DType):
        return {"$dtype": v.name}
    if isinstance(v, exp.DataType):
        return {"$datatype": datatype_shape(v)}
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    raise TypeError(f"unencodable {type(v)!r}: {v!r}")


def datatype_shape(dt):
    return {
        "this": dt.this.name,
        "expressions": [datatype_shape(e) for e in dt.expressions if isinstance(e, exp.DataType)],
    }


classes = {}
for cls, spec in EXPRESSION_METADATA.items():
    if "returns" in spec:
        classes[cls.__name__] = {"kind": "returns", "dtype": spec["returns"].name}
    else:
        fn = spec["annotator"]
        classes[cls.__name__] = {
            "kind": "annotator",
            "true": enc(fn(FAKE_SELF, PROBE_TRUE), PROBE_TRUE),
            "false": enc(fn(FAKE_SELF, PROBE_FALSE), PROBE_FALSE),
        }

out = {
    "total_classes": len(EXPRESSION_METADATA),
    "timestamp_expressions": sorted(c.__name__ for c in TIMESTAMP_EXPRESSIONS),
    "binary_subclasses": sorted(c.__name__ for c in subclasses(exp.__name__, exp.Binary)),
    "unary_family_subclasses": sorted(
        c.__name__
        for c in subclasses(exp.__name__, (exp.Unary, exp.Alias, exp.IgnoreNulls, exp.RespectNulls))
    ),
    "classes": classes,
}

print(json.dumps(out, sort_keys=True))
