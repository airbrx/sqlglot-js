#!/usr/bin/env python3
"""CPython oracle for `sqlglot/optimizer/annotate_types.py`'s `TypeAnnotator` (AIR-2097).

`src/optimizer/annotate_types.js` is the real CONSUMER `typing/index.js` (AIR-2096/R51)
was waiting for -- unlike that table, this module has a `.type` result that is directly
observable and comparable, so this oracle runs the REAL `annotate_types()` end to end
(parse -> annotate -> walk) rather than recording call shapes.

`annotate_types()` does not change `.sql()` output (type is metadata, not syntax, save
for the rare `_restore_dot_parts` JSON/MAP/VARIANT dot-identifier rewrite this battery
does not reach), so the SQL-text-comparison trick every other greenfield P7 oracle uses
(`optimize_joins.js`, `qualify_tables.js`, ...) does not apply here. Instead, each
scenario dumps a TYPE FINGERPRINT of the whole annotated tree: `ast.walk(bfs=False)`
in the same DFS order both languages' already-independently-verified `Expr.walk` share,
recording `(class name, DType name or null)` per node. Comparing the two langs'
fingerprints INDEX-FOR-INDEX is exactly as strict as an AST-shape diff, because both
sides parse the identical SQL string with independently-verified parsers (PORT_PLAN.md
P1-P5) that are already known to produce identically-shaped trees.

Every non-value node (Select, From, Table, Identifier, Where, Order, ...) is expected
to fingerprint as `null` (DType.UNKNOWN) on BOTH sides -- `EXPRESSION_METADATA` simply
has no entry for those classes, on both languages, so this is not a gap in the battery,
it is the real, correct behaviour reproduced faithfully.

Scenario coverage, per the task brief: integer/string/date literals, arithmetic type
promotion (INT+INT, INT+FLOAT, TEXT+NUMERIC both orderings), string concatenation,
comparison operators (always BOOLEAN), CAST/TRY_CAST, column type lookup via a real
`MappingSchema` (bare table, aliased table, a two-table JOIN, a derived table, a CTE),
a handful of functions whose return type the base `EXPRESSION_METADATA` table defines
outright (LENGTH/UPPER/SQRT/MD5), an `ARRAY`/`ARRAY_AGG` nested-type path, `EXTRACT`'s
part-name dispatch (including the `BIGINT_EXTRACT_DATE_PARTS` branch), and NULL
propagation through a binary operator plus `annotate()`'s own NULL -> dialect-default
cleanup pass.

    PYTHONHASHSEED=0 python3 spike/p7/gen_annotate_types_ref.py > spike/out/annotate_types.json
    node spike/p7/fuzz_annotate_types.mjs
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
    # --- literals ---
    ("int-literal", "SELECT 1", None),
    ("negative-int-literal", "SELECT -1", None),
    ("string-literal", "SELECT 'hello'", None),
    ("float-literal", "SELECT 1.5", None),
    ("date-string-literal-via-cast", "SELECT CAST('2024-01-01' AS DATE)", None),

    # --- NULL propagation ---
    ("null-literal", "SELECT NULL", None),
    ("add-int-null", "SELECT 1 + NULL", None),
    ("null-in-case", "SELECT CASE WHEN 1 = 1 THEN NULL ELSE 2 END", None),

    # --- arithmetic type promotion ---
    ("add-int-int", "SELECT 1 + 2", None),
    ("add-int-float", "SELECT 1 + 2.5", None),
    ("mul-int-int", "SELECT 3 * 4", None),
    ("sub-float-int", "SELECT 2.5 - 1", None),
    ("div-int-int", "SELECT 5 / 2", None),
    ("text-plus-numeric", "SELECT '5' + 3", None),
    ("numeric-plus-text", "SELECT 3 + '5'", None),

    # --- string concatenation ---
    ("concat-operator", "SELECT 'a' || 'b'", None),
    ("concat-func", "SELECT CONCAT('a', 'b')", None),

    # --- comparison operators (always BOOLEAN) ---
    ("gt-comparison", "SELECT 1 > 2", None),
    ("eq-comparison", "SELECT 'a' = 'b'", None),
    ("between", "SELECT 1 BETWEEN 0 AND 5", None),
    ("is-null", "SELECT 1 IS NULL", None),
    ("and-or", "SELECT (1 = 1) AND (2 = 2) OR (3 = 3)", None),

    # --- CAST / TRY_CAST ---
    ("cast-str-to-int", "SELECT CAST('1' AS INT)", None),
    ("cast-int-to-varchar", "SELECT CAST(1 AS VARCHAR)", None),
    ("try-cast", "SELECT TRY_CAST(1 AS FLOAT)", None),

    # --- column type lookup via a real Schema ---
    ("column-lookup-simple", "SELECT c FROM t", {"t": {"c": "VARCHAR"}}),
    ("column-lookup-alias", "SELECT x.c FROM t AS x", {"t": {"c": "BIGINT"}}),
    (
        "column-lookup-join",
        "SELECT a.x, b.y FROM ta AS a JOIN tb AS b ON a.id = b.id",
        {"ta": {"id": "INT", "x": "VARCHAR"}, "tb": {"id": "INT", "y": "DOUBLE"}},
    ),
    ("column-plus-literal-promotion", "SELECT c + 1 FROM t", {"t": {"c": "BIGINT"}}),
    ("subquery-column", "SELECT x.c FROM (SELECT c FROM t) AS x", {"t": {"c": "INT"}}),
    ("cte-column", "WITH w AS (SELECT c FROM t) SELECT c FROM w", {"t": {"c": "INT"}}),
    ("unknown-column-no-schema", "SELECT c FROM t", None),

    # --- functions whose return type the base EXPRESSION_METADATA table defines ---
    ("func-length", "SELECT LENGTH('abc')", None),
    ("func-upper", "SELECT UPPER('a')", None),
    ("func-sqrt", "SELECT SQRT(4)", None),
    ("func-md5", "SELECT MD5('x')", None),
    ("func-abs", "SELECT ABS(-1)", None),

    # --- nested/array types ---
    ("array-literal", "SELECT ARRAY(1, 2, 3)", None),
    ("array-agg", "SELECT ARRAY_AGG(x) FROM t", {"t": {"x": "INT"}}),

    # --- EXTRACT part-name dispatch ---
    ("extract-day", "SELECT EXTRACT(DAY FROM x) FROM t", {"t": {"x": "DATE"}}),
    ("extract-epoch-second", "SELECT EXTRACT(EPOCH_SECOND FROM x) FROM t", {"t": {"x": "TIMESTAMP"}}),

    # --- COUNT big_int dispatch ---
    ("count-star", "SELECT COUNT(*) FROM t", {"t": {"x": "INT"}}),
]


def dump_types(node):
    out = []
    for n in node.walk(bfs=False):
        t = n.type
        out.append([type(n).__name__, t.this.name if t is not None else None])
    return out


def run_one(sql, schema):
    try:
        ast = parse_one(sql)
        annotated = annotate_types(ast, schema=schema)
        return {"ok": dump_types(annotated)}
    except Exception as e:  # noqa: BLE001
        return {"error": type(e).__name__, "message": str(e)}


records = [
    {"name": name, "sql": sql, "schema": schema, "result": run_one(sql, schema)}
    for name, sql, schema in SCENARIOS
]

print(json.dumps({"scenarios": records}))
