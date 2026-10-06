#!/usr/bin/env python3
"""CPython oracle for `sqlglot/typing/databricks.py`'s `EXPRESSION_METADATA` overlay
(AIR-2100), exercised through the real `TypeAnnotator` (AIR-2097/R54) it plugs into.

Link 4 of 4, the LEAF of the `Hive <- Spark2 <- Spark <- Databricks` typing-overlay
chain — see `gen_annotate_types_hive_ref.py`'s own header for the "type fingerprint over
`.walk(bfs=False)`" scheme this reuses unchanged. Every scenario parses with
`read="databricks"` and annotates with `dialect="databricks"`, so
`dialect.EXPRESSION_METADATA` resolves to the real `Databricks` class's 364-entry table
(seeded from `Spark`'s 348-entry table, `src/dialects/databricks.js`'s `static
EXPRESSION_METADATA`).

Coverage: every `setEach` group (DOUBLE — the REGR_* family plus RINT, INT, VARCHAR),
every individually listed fixed-type entry (`RegrCount`, `Search`), and
`RegexpExtractAll`'s inline-lambda builder — the one entry in this whole four-link chain
that calls `exp.DataType.fromStr` with an explicit `dialect="databricks"` kwarg rather
than the dialect-neutral default, so the scenario also proves that kwarg threads through
correctly (a `databricks`-dialect `ARRAY<STRING>` parse, not a base-dialect one).

    PYTHONHASHSEED=0 python3 spike/p7/gen_annotate_types_databricks_ref.py \
        > spike/out/annotate_types_databricks.json
    node spike/p7/fuzz_annotate_types_databricks.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import parse_one  # noqa: E402
from sqlglot.optimizer.annotate_types import annotate_types  # noqa: E402

SCENARIOS = [
    # --- returns: DOUBLE group (REGR_* family + Rint) ---
    ("returns-double-regr-avgx", "SELECT REGR_AVGX(s.x, s.y) FROM t AS s", {"t": {"x": "DOUBLE", "y": "DOUBLE"}}),
    ("returns-double-regr-slope", "SELECT REGR_SLOPE(s.x, s.y) FROM t AS s", {"t": {"x": "DOUBLE", "y": "DOUBLE"}}),
    ("returns-double-rint", "SELECT RINT(s.x) FROM t AS s", {"t": {"x": "DOUBLE"}}),

    # --- returns: INT group ---
    ("returns-int-regexp-count", 'SELECT REGEXP_COUNT(s.x, "a") FROM t AS s', {"t": {"x": "VARCHAR"}}),
    ("returns-int-regexp-instr", 'SELECT REGEXP_INSTR(s.x, "a") FROM t AS s', {"t": {"x": "VARCHAR"}}),

    # --- returns: VARCHAR group ---
    ("returns-varchar-regexp-substr", 'SELECT REGEXP_SUBSTR(s.x, "a") FROM t AS s', {"t": {"x": "VARCHAR"}}),
    ("returns-varchar-secret", 'SELECT SECRET("scope", "key")', None),

    # --- individually-listed entries ---
    ("regr-count-bigint", "SELECT REGR_COUNT(s.x, s.y) FROM t AS s", {"t": {"x": "DOUBLE", "y": "DOUBLE"}}),
    ("search-boolean", 'SELECT SEARCH(s.x, "a") FROM t AS s', {"t": {"x": "VARCHAR"}}),

    # --- RegexpExtractAll inline lambda: explicit dialect="databricks" kwarg ---
    (
        "regexp-extract-all-array-databricks-dialect",
        'SELECT REGEXP_EXTRACT_ALL(s.x, "a") FROM t AS s',
        {"t": {"x": "VARCHAR"}},
    ),
]


def dump_types(node):
    out = []
    for n in node.walk(bfs=False):
        t = n.type
        out.append([type(n).__name__, t.this.name if t is not None else None])
    return out


def run_one(sql, schema):
    try:
        ast = parse_one(sql, read="databricks")
        annotated = annotate_types(ast, schema=schema, dialect="databricks")
        return {"ok": dump_types(annotated)}
    except Exception as e:  # noqa: BLE001
        return {"error": type(e).__name__, "message": str(e)}


records = [
    {"name": name, "sql": sql, "schema": schema, "result": run_one(sql, schema)}
    for name, sql, schema in SCENARIOS
]

print(json.dumps({"scenarios": records}))
