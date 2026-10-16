#!/usr/bin/env python3
"""CPython oracle for the ten remaining zero-oracle optimizer fixture files
(AIR-2315 Part 3, the last part of "13.7 Replay the un-replayed optimizer fixture
files"): `canonicalize_internal_names.sql` (65), `unnest_subqueries.sql` (41),
`normalize_identifiers.sql` (30), `eliminate_subqueries.sql` (27), `optimize_joins.sql`
(18), `quote_identifiers.sql` (10), `isolate_table_selects.sql` (8),
`eliminate_ctes.sql` (6), `pushdown_cte_alias_columns.sql` (6) -- 211 pairs across nine
files -- plus `annotate_types.sql` (71), in its own separate type-string compare mode
(it is NOT a `check_file` call upstream, see `ANNOTATE_TYPES` below). 282 pairs total,
closing `docs/verification/optimizer-fixture-rollup.md`'s remaining "no oracle"
population exactly (803 - 521 = 282, AIR-2315 Part 2's own closing note).

Unlike `gen_annotate_functions_ref.py`/`gen_simplify_fixture_ref.py` (one dedicated
oracle each), this is the ONE generic table-driven replay the issue asks for: a
`FILES` manifest below mirrors each file's own `self.check_file(...)` call site in
`tests/test_optimizer.py` (verified by reading every call site, not guessed), and a
single `check_file`-equivalent driver (`run_check_file_pair`) replays its real
per-pair meta handling:

    def check_file(self, file, func, pretty=False, execute=False, only=None, **kwargs):
        for i, (meta, sql, expected) in enumerate(load_sql_fixture_pairs(f"optimizer/{file}.sql"), start=1):
            dialect = meta.get("dialect")
            validate_qualify_columns = meta.get("validate_qualify_columns")
            func_kwargs = kwargs.copy()
            if validate_qualify_columns is not None:
                func_kwargs["validate_qualify_columns"] = string_to_bool(validate_qualify_columns)
            if dialect:
                func_kwargs["dialect"] = dialect
            optimized = func(parse_one(sql, read=dialect), **func_kwargs)
            actual = optimized.sql(pretty=pretty, dialect=dialect)
            assertEqual(expected, actual)

(`execute`/`leave_tables_isolated`/`canonicalize_table_aliases` meta keys exist on
`check_file` generically but are verified NOT present in any of these nine files'
fixture text at this pin -- grepped every `# ` meta line in each file -- so they are
omitted from this replica rather than silently mishandled.)

`annotate_types.sql` is driven by `test_annotate_types` directly (test_optimizer.py
~:2148), NOT `check_file`: no schema, dialect used as a single scalar (never
comma-split, unlike `annotate_functions.sql`'s own fan-out), the raw sql is NOT
wrapped in `SELECT ... FROM tbl`, and the comparison is `result.type.sql(dialect)` vs
`exp.DataType.build(expected, dialect=dialect).sql(dialect)` (type strings, like
`gen_annotate_functions_ref.py`, not full SQL like the other nine files here).

    PYTHONHASHSEED=0 python3 spike/p7/gen_fixture_replay_ref.py > spike/out/fixture_replay.json
    node spike/p7/fuzz_fixture_replay.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import exp, optimizer, parse_one  # noqa: E402
from sqlglot.optimizer.annotate_types import annotate_types  # noqa: E402
from sqlglot.optimizer.canonicalize_internal_names import canonicalize_internal_names  # noqa: E402
from sqlglot.optimizer.qualify import qualify  # noqa: E402
from sqlglot.optimizer.qualify_columns import quote_identifiers  # noqa: E402
from sqlglot.optimizer.scope import build_scope  # noqa: E402
from tests.helpers import load_sql_fixture_pairs, string_to_bool  # noqa: E402

# py: tests/test_optimizer.py `TestOptimizer.setUp`'s own `self.schema` literal.
SELF_SCHEMA = {
    "x": {"a": "INT", "b": "INT"},
    "y": {"b": "INT", "c": "INT"},
    "z": {"b": "INT", "c": "INT"},
    "w": {"d": "TEXT", "e": "TEXT"},
    "temporal": {"d": "DATE", "t": "DATETIME"},
    "structs": {
        "one": "STRUCT<a_1 INT, b_1 VARCHAR>",
        "nested_0": "STRUCT<a_1 INT, nested_1 STRUCT<a_2 INT, nested_2 STRUCT<a_3 INT>>>",
        "quoted": 'STRUCT<"foo bar" INT>',
    },
    "t_bool": {"a": "BOOLEAN", "b": "BOOLEAN"},
    "unpivotable": {"id": "INT", "jan": "INT", "feb": "INT", "north": "INT", "south": "INT"},
    "pivotable": {"id": "INT", "cat": "TEXT", "val": "INT", "kind": "TEXT", "amt": "INT"},
}

# py: test_optimizer.py:33 `qualify_then_canonicalize` -- the function actually passed
# to `check_file` for `canonicalize_internal_names.sql`, NOT `canonicalize_internal_names`
# directly.
def qualify_then_canonicalize(expression, **qualify_kwargs):
    return canonicalize_internal_names(qualify(expression, **qualify_kwargs))


# py: test_optimizer.py:73 `pushdown_ctes` -- the function actually passed to
# `check_file` for `pushdown_cte_alias_columns.sql`.
def pushdown_ctes(expression, **kwargs):
    optimizer.qualify_columns.pushdown_cte_alias_columns(build_scope(expression))
    return expression


# Each entry mirrors ONE `self.check_file(...)` call site in tests/test_optimizer.py,
# verified by reading it directly (line numbers as of the pin, for traceability):
#   canonicalize_internal_names  ~:1583  check_file("canonicalize_internal_names", qualify_then_canonicalize, schema=schema, catalog="c", db="db")
#   unnest_subqueries            ~:1389  check_file("unnest_subqueries", optimizer.unnest_subqueries.unnest_subqueries)
#   normalize_identifiers        ~:1233  check_file("normalize_identifiers", optimizer.normalize_identifiers.normalize_identifiers)
#   eliminate_subqueries         ~:1574  check_file("eliminate_subqueries", optimizer.eliminate_subqueries.eliminate_subqueries)
#   optimize_joins                ~:1456  check_file("optimize_joins", optimizer.optimize_joins.optimize_joins)
#   quote_identifiers             ~:1241  check_file("quote_identifiers", optimizer.qualify_columns.quote_identifiers)
#   isolate_table_selects          ~:262  check_file("isolate_table_selects", optimizer.isolate_table_selects.isolate_table_selects, schema=self.schema)
#   eliminate_ctes                ~:1469  check_file("eliminate_ctes", optimizer.eliminate_ctes.eliminate_ctes, pretty=True)
#   pushdown_cte_alias_columns     ~:1169  check_file("pushdown_cte_alias_columns", pushdown_ctes)
FILES = {
    "canonicalize_internal_names": {
        "func": qualify_then_canonicalize,
        "kwargs": {
            "schema": {**SELF_SCHEMA, "jtbl": {"j": "JSON"}, "pvt": {"c": "TEXT", "v": "INT"}},
            "catalog": "c",
            "db": "db",
        },
        "pretty": False,
    },
    "unnest_subqueries": {
        "func": optimizer.unnest_subqueries.unnest_subqueries,
        "kwargs": {},
        "pretty": False,
    },
    "normalize_identifiers": {
        "func": optimizer.normalize_identifiers.normalize_identifiers,
        "kwargs": {},
        "pretty": False,
    },
    "eliminate_subqueries": {
        "func": optimizer.eliminate_subqueries.eliminate_subqueries,
        "kwargs": {},
        "pretty": False,
    },
    "optimize_joins": {
        "func": optimizer.optimize_joins.optimize_joins,
        "kwargs": {},
        "pretty": False,
    },
    "quote_identifiers": {
        "func": quote_identifiers,
        "kwargs": {},
        "pretty": False,
    },
    "isolate_table_selects": {
        "func": optimizer.isolate_table_selects.isolate_table_selects,
        "kwargs": {"schema": SELF_SCHEMA},
        "pretty": False,
    },
    "eliminate_ctes": {
        "func": optimizer.eliminate_ctes.eliminate_ctes,
        "kwargs": {},
        "pretty": True,
    },
    "pushdown_cte_alias_columns": {
        "func": pushdown_ctes,
        "kwargs": {},
        "pretty": False,
    },
}


def run_check_file_pair(file, entry, i, title, meta, sql, expected):
    dialect = meta.get("dialect")
    validate_qualify_columns = meta.get("validate_qualify_columns")

    record = {
        "file": file,
        "i": i,
        "title": title,
        "dialect": dialect,
        "sql": sql,
        "expected": expected,
        "validate_qualify_columns": (
            string_to_bool(validate_qualify_columns) if validate_qualify_columns is not None else None
        ),
    }

    func_kwargs = dict(entry["kwargs"])
    if validate_qualify_columns is not None:
        func_kwargs["validate_qualify_columns"] = string_to_bool(validate_qualify_columns)
    if dialect:
        func_kwargs["dialect"] = dialect

    try:
        ast = parse_one(sql, read=dialect)
        optimized = entry["func"](ast, **func_kwargs)
        actual = optimized.sql(pretty=entry["pretty"], dialect=dialect)
        record["got"] = actual
        record["upstream_ok"] = actual == expected
    except Exception as e:  # noqa: BLE001
        record["got"] = None
        record["error"] = type(e).__name__
        record["message"] = str(e)
        record["upstream_ok"] = False

    return record


def run_annotate_types_pair(i, title, meta, sql, expected):
    # py: test_optimizer.py ~:2148 `test_annotate_types` -- NOT `check_file`. No
    # schema; `sql` is NOT wrapped in `SELECT ... FROM tbl`; dialect is a single
    # scalar, never comma-split.
    dialect = meta.get("dialect")
    record = {
        "file": "annotate_types",
        "i": i,
        "title": title,
        "dialect": dialect,
        "sql": sql,
    }

    try:
        expected_norm = exp.DataType.build(expected, dialect=dialect).sql(dialect)
    except Exception as e:  # noqa: BLE001
        record["expected_error"] = f"{type(e).__name__}: {e}"
        expected_norm = None
    record["expected"] = expected_norm

    try:
        ast = parse_one(sql, read=dialect)
        result = annotate_types(ast, dialect=dialect)
        got = result.type.sql(dialect)
        record["got"] = got
        record["upstream_ok"] = expected_norm is not None and got == expected_norm
    except Exception as e:  # noqa: BLE001
        record["got"] = None
        record["error"] = type(e).__name__
        record["message"] = str(e)
        record["upstream_ok"] = False

    return record


records = []
for file, entry in FILES.items():
    for i, (meta, sql, expected) in enumerate(
        load_sql_fixture_pairs(f"optimizer/{file}.sql"), start=1
    ):
        title = meta.get("title") or f"{i}, {sql}"
        records.append(run_check_file_pair(file, entry, i, title, meta, sql, expected))

for i, (meta, sql, expected) in enumerate(
    load_sql_fixture_pairs("optimizer/annotate_types.sql"), start=1
):
    title = meta.get("title") or f"{i}, {sql}"
    records.append(run_annotate_types_pair(i, title, meta, sql, expected))

inconsistent = [r for r in records if not r["upstream_ok"]]

print(
    json.dumps(
        {
            "records": records,
            "total": len(records),
            "upstream_inconsistent_count": len(inconsistent),
        }
    )
)

if inconsistent:
    sys.stderr.write(
        f"WARNING: {len(inconsistent)} record(s) are upstream-inconsistent at this "
        f"pin (CPython's own computed output != the fixture's expected string) -- see "
        f"'upstream_inconsistent_count' in the emitted JSON.\n"
    )
