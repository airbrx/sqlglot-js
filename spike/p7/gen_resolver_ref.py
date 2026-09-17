#!/usr/bin/env python3
"""CPython oracle for `sqlglot/optimizer/resolver.py` (AIR-2105).

`src/optimizer/resolver.js` is greenfield -- same shape as `spike/p6/gen_schema_ref.py`
and `spike/p7/gen_optimize_joins_ref.py`: nothing in the port imports it yet
(`qualify_columns.js`, AIR-2106, will later re-export it), so unlike the AST-parsing/
generation corpus this module has no `corpus/atoms.jsonl` coverage at all. There is also
no upstream `tests/optimizer/test_resolver.py` -- upstream only exercises `Resolver`
indirectly through `qualify_columns.py`'s own tests -- so this is a from-scratch
scenario battery, not a transcription of an existing suite.

Unlike `optimize_joins.py` (pure `Expr -> Expr`, compared via rendered `.sql()`),
`Resolver` needs a real `Scope` (built by the real `traverse_scope`, itself already
verified byte-for-byte in R46/AIR-2094) and a real `Schema` (`MappingSchema`, already
verified in R41/AIR-... schema.js), so a scenario is (sql, schema dict, visible dict,
infer_schema, scope index into `traverse_scope(parse_one(sql))`) plus a list of method
calls against the `Resolver` built from that scope. Every call result is either
JSON-serializable directly (`list[str]`, `bool`) or is normalized here first:
`get_table` returns an `exp.Identifier | None` -> serialized as `{"name": ...}` or
`null`; a raised `OptimizeError` -> `{"error": "OptimizeError", "message": str(e)}`.

Every scenario below was run interactively against the pinned checkout FIRST and its
actual output read before being written down here (the R45 lesson: a hand-authored
scenario's comment is only trustworthy once the real CPython answer has been seen, not
guessed). Several scenarios that looked plausible on paper turned out to exercise a
different branch than intended once actually run, and were rewritten to match what they
actually test rather than what they were meant to test -- see inline notes below,
particularly `table-alias-with-columns-shadow` (the FIRST attempt, a derived table with
`AS s(x, y)`, does NOT reach `get_source_columns`'s `column_aliases` shadowing branch at
all -- `Subquery.unnest()` drops the alias before `references` ever sees it; a plain
table with `AS t(x, y)` does reach it, since the Table node itself carries the alias).

    PYTHONHASHSEED=0 python3 spike/p7/gen_resolver_ref.py > spike/out/resolver.json
    node spike/p7/fuzz_resolver.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import parse_one, exp  # noqa: E402
from sqlglot.errors import OptimizeError  # noqa: E402
from sqlglot.optimizer.scope import traverse_scope  # noqa: E402
from sqlglot.optimizer.resolver import Resolver  # noqa: E402
from sqlglot.schema import MappingSchema  # noqa: E402


def identifier_result(ident):
    if ident is None:
        return None
    return {"name": ident.name}


def call_get_table(resolver, arg):
    if arg["kind"] == "name":
        column = arg["value"]
    else:
        cols = list(resolver.scope.find_all(exp.Column))
        if arg["kind"] == "column_index":
            column = cols[arg["value"]]
        else:
            # "column_by_predicate": the first unqualified column with this name --
            # avoids depending on parser column-enumeration ORDER for scenarios where
            # more than one candidate exists, only on which columns exist at all
            # (already independently verified, PORT_PLAN.md P3).
            matches = [c for c in cols if c.name == arg["value"] and not c.table]
            column = matches[0]
    try:
        return {"ok": identifier_result(resolver.get_table(column))}
    except Exception as e:  # noqa: BLE001
        return {"error": type(e).__name__, "message": str(e)}


def call_get_source_columns(resolver, arg):
    name = arg["name"]
    only_visible = arg.get("only_visible", False)
    try:
        return {"ok": list(resolver.get_source_columns(name, only_visible))}
    except Exception as e:  # noqa: BLE001
        return {"error": type(e).__name__, "message": str(e)}


def call_all_columns(resolver, _arg):
    return {"ok": sorted(resolver.all_columns)}


def call_get_source_columns_from_set_op(resolver, _arg):
    try:
        return {"ok": list(resolver.get_source_columns_from_set_op(resolver.scope.expression))}
    except Exception as e:  # noqa: BLE001
        return {"error": type(e).__name__, "message": str(e)}


CALL_DISPATCH = {
    "get_table": call_get_table,
    "get_source_columns": call_get_source_columns,
    "all_columns": call_all_columns,
    "get_source_columns_from_set_op": call_get_source_columns_from_set_op,
}


def run_scenario(scenario):
    schema = MappingSchema(scenario["schema"], visible=scenario.get("visible"))
    ast = parse_one(scenario["sql"])
    scopes = traverse_scope(ast)
    scope = scopes[scenario.get("scope_index", -1)]
    resolver = Resolver(scope, schema, infer_schema=scenario.get("infer_schema", True))

    results = []
    for call in scenario["calls"]:
        fn = CALL_DISPATCH[call["op"]]
        results.append({"op": call["op"], "arg": call.get("arg"), "result": fn(resolver, call.get("arg"))})

    return {
        "num_scopes": len(scopes),
        "scope_types": [s.scope_type.name for s in scopes],
        "results": results,
    }


SCENARIOS = [
    # --- Category: single-table unambiguous resolution. ---
    {
        "name": "single-table-unambiguous",
        "sql": "SELECT id, name FROM t1",
        "schema": {"t1": {"id": "INT", "name": "TEXT"}},
        "calls": [
            {"op": "get_table", "arg": {"kind": "name", "value": "id"}},
            {"op": "get_table", "arg": {"kind": "name", "value": "name"}},
            {"op": "get_table", "arg": {"kind": "column_index", "value": 0}},
            {"op": "get_table", "arg": {"kind": "column_index", "value": 1}},
            {"op": "all_columns"},
            {"op": "get_source_columns", "arg": {"name": "t1"}},
        ],
    },
    # --- Category: multi-table with explicit qualification. `get_table` resolves by
    #     COLUMN NAME only -- the AST's own `.table` qualifier is never consulted -- so
    #     this checks a column written as `t1.id` still resolves to `t1` (matches what
    #     the schema says, not what the SQL wrote) alongside an unqualified `name` that
    #     is unambiguous because only `t2` has it. ---
    {
        "name": "multi-table-explicit-qualification",
        "sql": "SELECT t1.id, name FROM t1 JOIN t2 ON t1.id = t2.fk",
        "schema": {"t1": {"id": "INT"}, "t2": {"fk": "INT", "name": "TEXT"}},
        "calls": [
            {"op": "get_table", "arg": {"kind": "column_index", "value": 0}},  # t1.id (SELECT)
            {"op": "get_table", "arg": {"kind": "column_index", "value": 1}},  # name
            {"op": "get_table", "arg": {"kind": "column_index", "value": 2}},  # t1.id (ON)
            {"op": "get_table", "arg": {"kind": "column_index", "value": 3}},  # t2.fk
            {"op": "all_columns"},
            {"op": "get_source_columns", "arg": {"name": "t1"}},
            {"op": "get_source_columns", "arg": {"name": "t2"}},
        ],
    },
    # --- Category: multi-table ambiguous-column detection. ---
    {
        "name": "ambiguous-comma-join",
        "sql": "SELECT id FROM t1, t2",
        "schema": {"t1": {"id": "INT"}, "t2": {"id": "INT"}},
        "calls": [
            {"op": "get_table", "arg": {"kind": "name", "value": "id"}},
            {"op": "get_table", "arg": {"kind": "column_index", "value": 0}},
        ],
    },
    {
        "name": "ambiguous-explicit-join",
        "sql": "SELECT id FROM t1 JOIN t2 ON t1.x = t2.x",
        "schema": {"t1": {"id": "INT", "x": "INT"}, "t2": {"id": "INT", "x": "INT"}},
        "calls": [
            {"op": "get_table", "arg": {"kind": "name", "value": "id"}},
        ],
    },
    # --- Join-order disambiguation: `id` is unqualified inside the SECOND join's ON
    #     clause; only `t2` (already joined by that point) has a column named `id`, so
    #     `_get_column_join_context`/`_get_available_source_columns` resolve it even
    #     though `id` is never in `self._unambiguous_columns` globally (t3 also has an
    #     `id`, joined LATER). ---
    {
        "name": "join-context-disambiguates",
        "sql": "SELECT * FROM t1 JOIN t2 ON t1.a = id JOIN t3 ON t2.b = t3.b",
        "schema": {"t1": {"a": "INT"}, "t2": {"id": "INT"}, "t3": {"id": "INT", "b": "INT"}},
        "calls": [
            {"op": "get_table", "arg": {"kind": "column_by_predicate", "value": "id"}},
        ],
    },
    # --- Join-order disambiguation that STILL fails: by the time the ambiguous `id`
    #     reference is seen (the t3 join), BOTH t1 and t2 are already joined and BOTH
    #     have `id` -- narrows nothing, falls through to schema inference, which also
    #     can't help (3 known sources, not exactly 1 without-schema) -> None. ---
    {
        "name": "join-context-still-ambiguous",
        "sql": "SELECT * FROM t1 JOIN t2 ON t1.a = t2.a JOIN t3 ON id = t3.c",
        "schema": {"t1": {"id": "INT", "a": "INT"}, "t2": {"id": "INT", "a": "INT"}, "t3": {"c": "INT"}},
        "calls": [
            {"op": "get_table", "arg": {"kind": "column_by_predicate", "value": "id"}},
        ],
    },
    # --- Schema inference fallback: exactly one source has no schema entry at all. ---
    {
        "name": "infer-schema-single-unknown-source",
        "sql": "SELECT foo FROM unknown_table",
        "schema": {},
        "infer_schema": True,
        "calls": [{"op": "get_table", "arg": {"kind": "name", "value": "foo"}}],
    },
    {
        "name": "infer-schema-disabled",
        "sql": "SELECT foo FROM unknown_table",
        "schema": {},
        "infer_schema": False,
        "calls": [{"op": "get_table", "arg": {"kind": "name", "value": "foo"}}],
    },
    {
        "name": "infer-schema-multiple-unknown-sources",
        "sql": "SELECT foo FROM t1, t2",
        "schema": {},
        "infer_schema": True,
        "calls": [{"op": "get_table", "arg": {"kind": "name", "value": "foo"}}],
    },
    # --- Category: CTEs. ---
    {
        "name": "cte-basic",
        "sql": "WITH cte AS (SELECT id, name FROM t1) SELECT id FROM cte",
        "schema": {"t1": {"id": "INT", "name": "TEXT"}},
        "calls": [
            {"op": "get_table", "arg": {"kind": "name", "value": "id"}},
            {"op": "get_source_columns", "arg": {"name": "cte"}},
        ],
    },
    {
        "name": "cte-nested-chain",
        "sql": "WITH a AS (SELECT id FROM t1), b AS (SELECT id FROM a) SELECT id FROM b",
        "schema": {"t1": {"id": "INT"}},
        "calls": [
            {"op": "get_table", "arg": {"kind": "name", "value": "id"}},
            {"op": "get_source_columns", "arg": {"name": "b"}},
        ],
    },
    # NOTE: a pivoted-CTE-reference scenario (resolver.py:141-150's own dedicated
    # branch -- the source stored under the pivot's own alias is an `exp.Table`
    # referencing the CTE by name, and `get_source_columns` has to walk BACK to the
    # CTE's pre-pivot scope to answer) was attempted here and dropped: this port's
    # `parser.js` `_parse_pivot` is not ported yet (`NotPorted`, `parser.py:5404`), so
    # `PIVOT (...)` cannot be parsed on the JS side at all -- a pre-existing gap, not
    # something AIR-2105 introduced or should fix. Confirmed independently correct
    # against the pinned CPython (['amount', 'category']) while designing this
    # scenario; that verified value is asserted directly, without a parse, in
    # `test/optimizer_resolver.test.mjs`'s hand-built-AST structural test instead.

    # --- Category: SELECT * source resolution. ---
    {
        "name": "select-star-single-table",
        "sql": "SELECT * FROM t1",
        "schema": {"t1": {"id": "INT", "name": "TEXT"}},
        "calls": [{"op": "all_columns"}],
    },
    {
        "name": "select-star-multi-table",
        "sql": "SELECT * FROM t1 JOIN t2 ON t1.id = t2.fk",
        "schema": {"t1": {"id": "INT"}, "t2": {"fk": "INT", "name": "TEXT"}},
        "calls": [{"op": "all_columns"}],
    },
    # --- A UNION as a derived-table source: `get_source_columns` routes through
    #     `get_source_columns_from_set_op` internally (resolver.py:190-191). ---
    {
        "name": "union-derived-source",
        "sql": "SELECT u.a FROM (SELECT a FROM t1 UNION SELECT a FROM t2) AS u",
        "schema": {"t1": {"a": "INT"}, "t2": {"a": "INT"}},
        "calls": [{"op": "get_source_columns", "arg": {"name": "u"}}],
    },
    # --- `get_source_columns_from_set_op` called DIRECTLY (it is a public method in its
    #     own right, not just an internal helper) against a top-level UNION's own scope,
    #     whose `.expression` IS the `exp.SetOperation` node -- the "else" branch
    #     (`columns = set_op.named_selects`, no `side`/`kind` modifiers present). ---
    {
        "name": "union-direct-set-op-call",
        "sql": "SELECT a FROM t1 UNION SELECT a FROM t2",
        "schema": {"t1": {"a": "INT"}, "t2": {"a": "INT"}},
        "scope_index": -1,
        "calls": [{"op": "get_source_columns_from_set_op"}],
    },
    # --- A subquery source whose OWN select aliases a column: `named_selects` alone
    #     picks up the rename, no `alias_column_names` shadowing involved. ---
    {
        "name": "subquery-source-with-own-alias",
        "sql": "SELECT s.x FROM (SELECT a AS x FROM t1) AS s",
        "schema": {"t1": {"a": "INT"}},
        "calls": [{"op": "get_source_columns", "arg": {"name": "s"}}],
    },
    # --- `column_aliases` shadowing (resolver.py:211-217): a PLAIN table (not a derived
    #     table -- see this file's own module docstring for why a derived table's
    #     `AS s(x, y)` does NOT reach this branch) whose alias carries an explicit
    #     column list renames the schema's own columns. ---
    {
        "name": "table-alias-with-columns-shadow",
        "sql": "SELECT t.x FROM t1 AS t(x, y)",
        "schema": {"t1": {"a": "INT", "b": "INT"}},
        "calls": [{"op": "get_source_columns", "arg": {"name": "t"}}],
    },
    # --- `only_visible` filtering via `MappingSchema`'s own `visible` mapping. ---
    {
        "name": "only-visible-columns",
        "sql": "SELECT id FROM t1",
        "schema": {"t1": {"id": "INT", "secret": "TEXT"}},
        "visible": {"t1": ["id"]},
        "calls": [
            {"op": "get_source_columns", "arg": {"name": "t1", "only_visible": False}},
            {"op": "get_source_columns", "arg": {"name": "t1", "only_visible": True}},
        ],
    },
    # --- Unknown table name -> OptimizeError, not a silent empty list. ---
    {
        "name": "unknown-table-raises",
        "sql": "SELECT id FROM t1",
        "schema": {"t1": {"id": "INT"}},
        "calls": [{"op": "get_source_columns", "arg": {"name": "nope"}}],
    },
]

records = [
    {
        "name": s["name"],
        "sql": s["sql"],
        "schema": s["schema"],
        "visible": s.get("visible"),
        "infer_schema": s.get("infer_schema", True),
        "scope_index": s.get("scope_index", -1),
        "result": run_scenario(s),
    }
    for s in SCENARIOS
]
print(json.dumps({"scenarios": records}))
