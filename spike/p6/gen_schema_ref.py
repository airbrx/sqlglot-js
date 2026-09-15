#!/usr/bin/env python3
"""CPython oracle for `sqlglot/schema.py`'s `MappingSchema` and module-level helpers.

`src/schema.js` is greenfield -- nothing else in this port depends on it yet, so unlike
the AST-parsing/generation corpus this file has no existing oracle coverage. This is the
honest differential signal instead, following the same recipe `spike/p4/gen_transforms_
ref.py` (a standalone-module oracle) and `spike/p5/gen_snowflake_dialect_ref.py` (a
hand-written-class oracle) already established: exercise the REAL CPython class with a
curated battery and dump the results losslessly, so a JS-side mismatch is provably a
`schema.js` bug and not a dump-format coincidence.

Output shape: a list of SCENARIOS, not flat records. Each scenario carries everything
needed to reconstruct the exact same `MappingSchema` on the JS side (`schema`/`visible`/
`udf_mapping` in the `{"__map__": [[k, v], ...]}` wire encoding, plus a `setup` list of
mutating calls to replay after construction) and a list of `checks` -- read-only calls
made against that one constructed instance, each with its recorded CPython result. This
avoids hand-duplicating schema literals in both Python and JS (a drift risk in itself)
and, for the mutating cases (`add_table` sequences), makes the JS side replay the exact
same sequence rather than trying to precompute an equivalent end state by hand.

The `{"__map__": ...}` wire encoding is used uniformly for every dict-shaped schema
value, everywhere -- even though a Python `dict` never needs it (insertion order is
preserved regardless of key shape). The point is the JS-side DECODER: it only ever needs
to build a `Map`, never a plain object, which is what closes the hazard `src/schema.js`'s
own file header documents -- a JS object literal reorders integer-LOOKING string keys
ahead of insertion order. Several scenarios below use column/table names that look like
integers specifically to exercise that.

    PYTHONHASHSEED=0 python3 spike/p6/gen_schema_ref.py > spike/out/schema.json
    node spike/p6/fuzz_schema.mjs
"""
import json
import os
import re
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)
os.chdir(REF)

import sqlglot  # noqa: E402
from sqlglot import exp  # noqa: E402
from sqlglot.schema import (  # noqa: E402
    MappingSchema,
    ensure_schema,
    ensure_column_mapping,
    flatten_schema,
    nested_get,
    nested_set,
    normalize_name,
)
from sqlglot.errors import SchemaError  # noqa: E402

_OBJ_ADDR_RE = re.compile(r" object at 0x[0-9a-fA-F]+")


def dump(node):
    """Same lossless shape `tools/astdump.py`/`gen_transforms_ref.py` use for an Expr.

    `DataType` args carry a raw `exp.DType` enum member (e.g. `this=DType.INT`), which
    `json.dumps` cannot serialize -- encoded exactly as `expressions/core.js`'s own
    `astDump`/`astLoad` encode a JS enum value (`{"__enum__": "DType", name, value}"),
    so `fuzz_schema.mjs` can feed this dump straight through the port's own `astLoad`
    (the identical recipe `spike/p4/fuzz_transforms.mjs` uses) rather than needing a
    second, bespoke enum decoder.
    """
    if isinstance(node, exp.Expr):
        return {
            "c": type(node).__name__,
            "a": [[k, dump(v)] for k, v in node.args.items()],
            "m": dict(node._meta) if node._meta else None,
            "cm": list(node.comments) if node.comments else None,
        }
    if isinstance(node, exp.DType):
        return {"__enum__": "DType", "name": node.name, "value": node.value}
    if isinstance(node, list):
        return [dump(v) for v in node]
    if isinstance(node, tuple):
        return {"__tuple__": [dump(v) for v in node]}
    return node


def dump_dict(d):
    """A `find()`/`ensure_column_mapping()` result: dict -> ordered [[k, v_or_dump], ...]."""
    if d is None:
        return None
    return [[k, dump(v) if isinstance(v, exp.Expr) else v] for k, v in d.items()]


def mp(pairs):
    """Build the `{"__map__": [...]}` wire encoding from a list of (k, v) pairs."""
    return {"__map__": [[k, v] for k, v in pairs]}


def decode(node):
    """Inverse of `mp` -- turns the wire encoding back into a real (ordered) dict."""
    if isinstance(node, dict) and "__map__" in node:
        return {k: decode(v) for k, v in node["__map__"]}
    return node


def run(fn, *args, **kwargs):
    try:
        return {"ok": fn(*args, **kwargs)}
    except Exception as e:  # noqa: BLE001
        return {"error": type(e).__name__, "message": str(e)}


scenarios = []


class Scenario:
    """Builds one real `MappingSchema`, replays `setup`, records `checks` against it."""

    def __init__(self, name, schema=None, visible=None, dialect=None, normalize=True,
                 udf_mapping=None, setup=None):
        self.record = {
            "scenario": name,
            "schema": schema, "visible": visible, "dialect": dialect,
            "normalize": normalize, "udf_mapping": udf_mapping,
            "setup": setup or [],
            "checks": [],
        }
        self.schema = MappingSchema(
            decode(schema) if schema is not None else None,
            decode(visible) if visible is not None else None,
            dialect, normalize,
            decode(udf_mapping) if udf_mapping is not None else None,
        )
        for step in (setup or []):
            getattr(self.schema, step["method"])(*step.get("args", []))
        scenarios.append(self.record)

    def check(self, op, args, fn):
        self.record["checks"].append({"op": op, "args": args, "result": run(fn)})
        return self

    def check_raw(self, op, args, value):
        self.record["checks"].append({"op": op, "args": args, "result": {"ok": value}})
        return self


# ---------------------------------------------------------------------------------
# A. Basic single/2/3-level nesting: column_names, get_column_type, has_column, find.
# ---------------------------------------------------------------------------------

DEPTH1 = mp([("t", mp([("a", "INT"), ("b", "VARCHAR")]))])
DEPTH2 = mp([
    ("db1", mp([("t1", mp([("a", "INT")]))])),
    ("db2", mp([("t1", mp([("b", "TEXT")]))])),
])
DEPTH3 = mp([
    ("cat1", mp([
        ("db1", mp([("t1", mp([("a", "INT")]))])),
        ("db2", mp([("t1", mp([("b", "TEXT")]))])),
    ])),
])

for name, schema, table_sql in [
    ("depth1", DEPTH1, "t"),
    ("depth2", DEPTH2, "db1.t1"),
    ("depth3", DEPTH3, "cat1.db1.t1"),
]:
    sc = Scenario(name, schema=schema)
    sc.check_raw("depth", [], sc.schema.depth())
    sc.check_raw("supported_table_args", [], list(sc.schema.supported_table_args))
    sc.check("column_names", [table_sql], lambda t=table_sql: sc.schema.column_names(t))
    sc.check("get_column_type", [table_sql, "a"],
             lambda t=table_sql: dump(sc.schema.get_column_type(t, "a")))
    sc.check("has_column", [table_sql, "zzz"], lambda t=table_sql: sc.schema.has_column(t, "zzz"))
    tbl = exp.to_table(table_sql)
    sc.check("find", [table_sql], lambda tb=tbl: dump_dict(sc.schema.find(tb)))

# Ambiguous unqualified lookup across the 2- and 3-level schemas.
for name, schema in [("depth2-ambiguous", DEPTH2), ("depth3-ambiguous", DEPTH3)]:
    sc = Scenario(name, schema=schema)
    sc.check("column_names", ["t1"], lambda: sc.schema.column_names("t1"))

sc = Scenario("not-found", schema=DEPTH1)
sc.check("find", ["nope", True],
         lambda: dump_dict(sc.schema.find(exp.to_table("nope"), raise_on_missing=True)))
sc.check("find", ["nope", False],
         lambda: dump_dict(sc.schema.find(exp.to_table("nope"), raise_on_missing=False)))

# ---------------------------------------------------------------------------------
# B. add_table: string / list / dict column mappings, depth enforcement, no-op re-add.
# ---------------------------------------------------------------------------------

sc = Scenario("add_table-forms", setup=[
    {"method": "add_table", "args": ["t1", "a:INT, b:VARCHAR"]},
    {"method": "add_table", "args": ["t2", ["c", "d"]]},
    {"method": "add_table", "args": ["t3", {"e": "INT"}]},
])
for t in ("t1", "t2", "t3"):
    sc.check("column_names", [t], lambda tt=t: sc.schema.column_names(tt))

sc = Scenario("depth-mismatch", schema=DEPTH1)
sc.check("add_table", ["db.t2", "b:INT"], lambda: sc.schema.add_table("db.t2", "b:INT"))

sc = Scenario("add_table-noop-readd", schema=DEPTH1, setup=[{"method": "add_table", "args": ["t"]}])
sc.check("column_names", ["t"], lambda: sc.schema.column_names("t"))

# Numeric-looking table/column names -- the hazard this whole oracle exists to catch.
sc = Scenario("numeric-order", setup=[{"method": "add_table", "args": ["t", "2:INT, 1:INT, a:INT"]}])
sc.check("column_names", ["t"], lambda: sc.schema.column_names("t"))

sc = Scenario("numeric-table-order", schema=mp([
    ("2", mp([("a", "INT")])), ("1", mp([("b", "INT")])), ("10", mp([("c", "INT")])),
]))
sc.check_raw("mapping_keys", [], list(sc.schema.mapping.keys()))

# ---------------------------------------------------------------------------------
# C. only_visible / visible mapping.
# ---------------------------------------------------------------------------------

sc = Scenario(
    "visible", schema=mp([("t", mp([("a", "INT"), ("b", "INT"), ("c", "INT")]))]),
    visible=mp([("t", ["a", "b"])]),
)
sc.check("column_names", ["t", True], lambda: sc.schema.column_names("t", True))
sc.check("column_names", ["t", False], lambda: sc.schema.column_names("t", False))

sc = Scenario(
    "visible-missing-table",
    schema=mp([("t", mp([("a", "INT")])), ("u", mp([("b", "INT")]))]),
    visible=mp([("t", ["a"])]),
)
sc.check("column_names", ["u", True], lambda: sc.schema.column_names("u", True))

# ---------------------------------------------------------------------------------
# D. Dialect-aware normalization: mixed case, quoting, normalize on/off, across dialects.
# ---------------------------------------------------------------------------------

MIXED_CASE = mp([("Foo", mp([("Bar", "INT")]))])

for dialect in (None, "snowflake", "duckdb"):
    for normalize in (True, False):
        lookup = "foo" if normalize and dialect != "snowflake" else ("FOO" if normalize else "Foo")
        sc = Scenario(f"case-{dialect}-{normalize}", schema=MIXED_CASE, dialect=dialect, normalize=normalize)
        sc.check("column_names", [lookup], lambda t=lookup: sc.schema.column_names(t))
        sc.check_raw("mapping_keys", [], list(sc.schema.mapping.keys()))

# normalize_name direct battery.
sc = Scenario("normalize_name-battery")
for name_in, dialect, is_table, normalize in [
    ("Foo", None, False, True),
    ("Foo", None, False, False),
    ("Foo", "snowflake", False, True),
    ('"Foo"', None, False, True),
    ("Foo", "duckdb", True, True),
]:
    label = f"{name_in}-{dialect}-{is_table}-{normalize}"
    sc.check(
        "normalize_name", [name_in, dialect, is_table, normalize],
        lambda n=name_in, d=dialect, it=is_table, nz=normalize:
            normalize_name(n, dialect=d, is_table=it, normalize=nz).name,
    )

# ---------------------------------------------------------------------------------
# E. UDF mapping.
# ---------------------------------------------------------------------------------

sc = Scenario("udf", udf_mapping=mp([("myudf", "INT")]))
sc.check("get_udf_type", ["myudf()"], lambda: dump(sc.schema.get_udf_type("myudf()")))
sc.check("get_udf_type", ["othername()"], lambda: dump(sc.schema.get_udf_type("othername()")))

sc = Scenario("udf-qualified", udf_mapping=mp([("db1", mp([("myudf", "VARCHAR")]))]))
sc.check("get_udf_type", ["db1.myudf()"], lambda: dump(sc.schema.get_udf_type("db1.myudf()")))

# ---------------------------------------------------------------------------------
# F. ensure_column_mapping / ensure_schema.
# ---------------------------------------------------------------------------------

extra = []

for name, mapping in [
    ("none", None),
    ("string", "a:INT, b:VARCHAR"),
    ("list", ["a", "b"]),
    ("dict", {"a": "INT"}),
]:
    extra.append({
        "kind": "ensure_column_mapping", "label": name,
        "result": run(lambda m=mapping: dump_dict(ensure_column_mapping(m))),
    })
extra.append({"kind": "ensure_column_mapping", "label": "invalid",
              "result": run(ensure_column_mapping, 42)})
extra.append({"kind": "ensure_column_mapping", "label": "malformed-string",
              "result": run(ensure_column_mapping, "a")})

_es_schema = MappingSchema(decode(DEPTH1))
extra.append({"kind": "ensure_schema-passthrough", "result": ensure_schema(_es_schema) is _es_schema})

# ---------------------------------------------------------------------------------
# G. flatten_schema / nested_get / nested_set direct probes.
# ---------------------------------------------------------------------------------

extra.append({"kind": "flatten_schema", "label": "numeric",
              "result": flatten_schema({"2": 1, "1": 1, "10": 1})})
extra.append({"kind": "flatten_schema", "label": "nested",
              "result": flatten_schema({"b": {"x": 1}, "a": {"y": 1}})})

_d = {}
nested_set(_d, ["top", "second"], "value")
nested_set(_d, ["top", "third"], "third_value")
extra.append({"kind": "nested_get", "label": "round-trip-second",
              "result": nested_get(_d, ("top", "top"), ("second", "second"))})
extra.append({"kind": "nested_get", "label": "round-trip-third",
              "result": nested_get(_d, ("top", "top"), ("third", "third"))})
extra.append({
    "kind": "nested_get", "label": "missing-raises",
    "result": run(nested_get, {"this": {"a": 1}}, ("this", "this"), ("b", "b")),
})
extra.append({
    "kind": "nested_get", "label": "missing-no-raise",
    "result": nested_get({"this": {"a": 1}}, ("this", "this"), ("b", "b"), raise_on_missing=False),
})
extra.append({
    "kind": "nested_get", "label": "this-renamed-to-table",
    "result": run(nested_get, {}, ("this", "missing_table")),
})

# ---------------------------------------------------------------------------------
# H. copy() / from_mapping_schema round trip.
# ---------------------------------------------------------------------------------

sc = Scenario("copy-independence", schema=DEPTH1)
_copied = sc.schema.copy()
_copied.add_table("t2", "b:INT")
sc.check("column_names", ["t2", "original"], lambda: sc.schema.column_names("t2"))
extra.append({
    "kind": "copy-independence-copy",
    "result": run(_copied.column_names, "t2"),
})

sc = Scenario(
    "from_mapping_schema",
    schema=mp([("t", mp([("a", "INT")]))]),
    visible=mp([("t", ["a"])]),
    udf_mapping=mp([("u", "INT")]),
)
_fms = MappingSchema.from_mapping_schema(sc.schema)
extra.append({"kind": "from_mapping_schema-columns", "result": run(_fms.column_names, "t")})
extra.append({"kind": "from_mapping_schema-udf", "result": run(lambda: dump(_fms.get_udf_type("u()")))})

# ---------------------------------------------------------------------------------
# I. get_column_type with a DataType value stored directly (not a string).
#
# Can't round-trip a live exp.DataType through the JSON wire encoding -- add it via
# add_table instead, which passes column-mapping VALUES through unchanged (only keys are
# name-normalized), and keeps the trie in sync (unlike hand-mutating `.mapping` would).
# The JS side independently builds its own native `DataType.build("INT")` the same way;
# both sides assert the SAME resulting dump, which `DataType.build("INT")` is already
# oracled elsewhere to produce identically on both sides.
# ---------------------------------------------------------------------------------

_dt_schema = MappingSchema()
_dt_schema.add_table("t", {"a": exp.DataType.build("INT")})
extra.append({
    "kind": "datatype-value-passthrough",
    "result": run(lambda: dump(_dt_schema.get_column_type("t", "a"))),
})

print(json.dumps({"scenarios": scenarios, "extra": extra}))
