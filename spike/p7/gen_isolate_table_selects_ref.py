#!/usr/bin/env python3
"""CPython oracle for `sqlglot/optimizer/isolate_table_selects.py`.

`src/optimizer/isolate_table_selects.js` is greenfield (AIR-2104/AIR-2087), the sibling
of `qualify_tables.js` in the same issue -- see that file's own oracle header
(`gen_qualify_tables_ref.py`) for why a hand-curated `.sql()`-equality battery is the
right verification shape here (no `corpus/atoms.jsonl` tie-in exists for either module).

Every scenario is hand-picked to hit one specific branch:
  - a query where isolating IS needed: 2+ real table sources, each with a schema entry,
    each getting wrapped in its own `SELECT * FROM ... AS alias` subquery
  - the same shape via an explicit JOIN, not just a comma-join
  - a query where isolating is NOT needed because there is only ONE selected source
    (the `len(scope.selected_sources) == 1` early-continue, py:25-26) -- includes both a
    single bare table and a single table alongside an UNRELATED derived table (so the
    "only one real Table source" case doesn't accidentally read as "only one source of
    any kind")
  - a query where isolating is skipped because the schema has NO entry for either table
    (`not schema.column_names(source)`, py:31) -- the default `ensure_schema(None)`
    behaviour, and an explicit empty mapping
  - a derived table already in FROM position is skipped even with 2+ sources
    (`isinstance(source.parent, exp.Subquery)`, py:32) -- one real table alongside one
    already-a-subquery source
  - the `OptimizeError` raised when a real, multi-source, schema-known table has NO
    alias (py:38-39, "Tables require an alias. Run qualify_tables optimization.")
  - idempotency: running the transform TWICE produces the same output the second time
    (the freshly-isolated source is now a `Subquery`, not a `Table`, so the
    `not isinstance(source, exp.Table)` guard skips it on the second pass)

    PYTHONHASHSEED=0 python3 spike/p7/gen_isolate_table_selects_ref.py > spike/out/isolate_table_selects.json
    node spike/p7/fuzz_isolate_table_selects.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import parse_one  # noqa: E402
from sqlglot.optimizer.isolate_table_selects import isolate_table_selects  # noqa: E402

TWO_TABLE_SCHEMA = {"t1": {"x": "int"}, "t2": {"y": "int"}}

SCENARIOS = [
    ("comma-join-needs-isolating",
     "SELECT * FROM t1 AS a, t2 AS b", TWO_TABLE_SCHEMA),
    ("explicit-join-needs-isolating",
     "SELECT * FROM t1 AS a JOIN t2 AS b ON a.x = b.y", TWO_TABLE_SCHEMA),
    ("single-bare-table-no-isolating-needed",
     "SELECT * FROM t1", {"t1": {"x": "int"}}),
    ("single-aliased-table-no-isolating-needed",
     "SELECT * FROM t1 AS a", {"t1": {"x": "int"}}),
    ("one-real-table-plus-one-derived-table-single-real-source",
     "SELECT * FROM t1 AS a, (SELECT 1 AS x) AS d", {"t1": {"x": "int"}}),
    ("no-schema-at-all-skips-everything",
     "SELECT * FROM t1 AS a, t2 AS b", None),
    ("empty-schema-mapping-skips-everything",
     "SELECT * FROM t1 AS a, t2 AS b", {}),
    ("schema-missing-one-of-two-tables",
     "SELECT * FROM t1 AS a, t2 AS b", {"t1": {"x": "int"}}),
    ("derived-table-source-among-real-tables-is-skipped",
     "SELECT * FROM (SELECT * FROM t1) AS s, t2 AS b", TWO_TABLE_SCHEMA),
    ("missing-alias-on-multi-source-real-table-raises",
     "SELECT * FROM t1, t2", TWO_TABLE_SCHEMA),
    ("missing-alias-on-one-of-two-raises",
     "SELECT * FROM t1 AS a, t2", TWO_TABLE_SCHEMA),
]


def run_one(sql, schema):
    try:
        ast = parse_one(sql)
        out = isolate_table_selects(ast, schema=schema).sql()
        return {"ok": out}
    except Exception as e:  # noqa: BLE001
        return {"error": type(e).__name__, "message": str(e)}


records = [
    {"name": name, "sql": sql, "schema": schema, "result": run_one(sql, schema)}
    for name, sql, schema in SCENARIOS
]

# Idempotency: run the transform a second time over its own output and confirm nothing
# changes (see this file's own header for why that's the interesting second-pass case).
_idempotent = []
for label, sql, schema in [("comma-join", "SELECT * FROM t1 AS a, t2 AS b", TWO_TABLE_SCHEMA)]:
    once = isolate_table_selects(parse_one(sql), schema=schema)
    twice = isolate_table_selects(once, schema=schema)
    _idempotent.append({"label": label, "sql": sql, "schema": schema, "once": once.sql(), "twice": twice.sql()})

print(json.dumps({"scenarios": records, "idempotent": _idempotent}))
