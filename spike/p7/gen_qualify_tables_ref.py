#!/usr/bin/env python3
"""CPython oracle for `sqlglot/optimizer/qualify_tables.py`.

`src/optimizer/qualify_tables.js` is greenfield (AIR-2104/AIR-2087) -- nothing in this
port calls it yet (the `qualify()` orchestrator wiring it and `isolate_table_selects.js`
together is AIR-2108, a separate follow-up issue), so unlike the AST-parsing/generation
corpus this module has no existing `corpus/atoms.jsonl` coverage at all. This follows
the same recipe `spike/p7/gen_optimize_joins_ref.py` established for the sibling
greenfield optimizer module: exercise the REAL CPython function with a curated battery
and dump `.sql()`, so a JS-side mismatch is provably a `qualify_tables.js` bug and not
a coincidence. The comparison is plain SQL-string equality, not an AST-dump diff --
just as strict, since this port's own parser+generator are independently verified
elsewhere (PORT_PLAN.md P3-P5) and would turn any AST-shape divergence into visibly
different SQL text.

Every scenario is hand-picked to hit one specific branch, matching the task brief's own
required coverage list plus the extra branches this file's more involved control flow
needs to prove correct:
  - the module's own two docstring examples (py:28-36)
  - an unaliased single table (gets a synthetic alias = its own name)
  - an already-aliased table (left untouched -- the `not alias.name` early return)
  - a CTE: the CTE's own definition gets no synthetic alias rewrite (it already has an
    alias, its name), and a reference to it in FROM is qualified as a source but the
    CTE's OWN name is excluded from db/catalog qualification (`cte_names` exclusion)
  - a derived table (subquery) in FROM, both unaliased (synthetic `_0`-style alias) and
    already aliased (left as-is)
  - multiple joins needing DISTINCT auto-generated aliases (three unaliased tables in
    a row, each must get its own name, not collide)
  - a self-join: the SAME base table joined to itself, each occurrence already
    disambiguated by the parser/scope layer with distinct aliases, confirming
    qualify_tables doesn't collapse or rename an already-distinct pair
  - `db=`/`catalog=` qualification, including the "catalog requires db already set"
    guard (py:66, catalog is skipped if db isn't set)
  - `db=` qualification is skipped for a CTE reference, but not for a real table
    alongside one (`cte_names` exclusion is scoped, not global)
  - `canonicalize_table_aliases=True`: every source gets a `_N` alias regardless of its
    original name, and a column reference (`t1.id`) is rewritten to follow
    (`canonical_aliases`'s column-rewrite path, py:235-242)
  - the join-construct-as-subquery expansion, `(t1 JOIN t2) AS t` -> a real `SELECT *`
    wrapping both joined tables (the module's own second docstring example, and the
    `unnested`/`joins` splice at py:139-145)
  - a bare (uncorrelated) subquery in WHERE, exercising the `queries`/`unwrapped.replace`
    splice at py:124-137 for a subquery that is NOT a derived table
  - a UNION (SetOperation), two independent FROM-clause scopes each qualified on their
    own
  - a table-valued function source without an alias (`my_func(1, 2)`), exercising the
    `isinstance(table_this, exp.Func)` branch inside the `exp.Table` source case
  - a `VALUES (...)` UDTF source, both unaliased (gets a synthetic alias AND synthetic
    `_col_N` column aliases via `dialect.generate_values_aliases`) and already aliased
    with explicit columns (left as-is, `not table_alias.columns` guard)
  - `dialect="snowflake"` for `db=`, exercising `normalize_identifiers`' real
    dialect-specific casing (Snowflake upper-cases unquoted identifiers) rather than the
    base dialect's no-op casing

    PYTHONHASHSEED=0 python3 spike/p7/gen_qualify_tables_ref.py > spike/out/qualify_tables.json
    node spike/p7/fuzz_qualify_tables.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import parse_one  # noqa: E402
from sqlglot.optimizer.qualify_tables import qualify_tables  # noqa: E402

SCENARIOS = [
    # --- qualify_tables's own module docstring (py:28-36), mirrored exactly. ---
    ("module-docstring-db", "SELECT 1 FROM tbl", {"db": "db"}),
    ("module-docstring-join-construct", "SELECT 1 FROM (t1 JOIN t2) AS t", {}),

    # --- Unaliased vs already-aliased single table. ---
    ("unaliased-table-gets-own-name", "SELECT 1 FROM tbl", {}),
    ("already-aliased-table-untouched", "SELECT 1 FROM tbl AS t", {}),

    # --- CTEs: the CTE definition itself, and a plain reference to it. ---
    ("cte-reference-and-definition", "WITH cte AS (SELECT 1 AS a) SELECT a FROM cte", {}),
    ("cte-reference-aliased", "WITH cte AS (SELECT 1 AS a) SELECT a FROM cte AS c", {}),
    ("nested-ctes-referencing-each-other",
     "WITH a AS (SELECT 1 AS x), b AS (SELECT x FROM a) SELECT x FROM b", {}),

    # --- Derived tables (subqueries in FROM), unaliased and aliased. ---
    ("derived-table-unaliased", "SELECT 1 FROM (SELECT * FROM x)", {}),
    ("derived-table-aliased", "SELECT 1 FROM (SELECT * FROM x) AS y", {}),

    # --- Multiple joins needing DISTINCT auto-generated aliases. ---
    ("three-unaliased-joins-distinct-names",
     "SELECT * FROM t1 JOIN t2 ON t1.a = t2.a JOIN t3 ON t2.a = t3.a", {}),
    ("mixed-aliased-and-unaliased-joins",
     "SELECT * FROM t1 AS a JOIN t2 ON a.id = t2.id JOIN t3 AS c ON t2.id = c.id", {}),

    # --- Self-join: parser/scope already disambiguates via distinct aliases. ---
    ("self-join-distinct-aliases",
     "SELECT * FROM t AS a JOIN t AS b ON a.id = b.parent_id", {}),

    # --- db=/catalog= qualification, including the "catalog needs db" guard. ---
    ("db-only", "SELECT 1 FROM tbl", {"db": "db"}),
    ("db-and-catalog", "SELECT 1 FROM tbl", {"db": "d", "catalog": "c"}),
    ("catalog-without-db-is-not-applied",
     "SELECT 1 FROM tbl", {"catalog": "c"}),
    ("db-already-set-not-overwritten",
     "SELECT 1 FROM d0.tbl", {"db": "db"}),
    ("db-qualify-skips-cte-name-but-not-real-table",
     "WITH cte AS (SELECT 1 AS a) SELECT a FROM cte, tbl", {"db": "db"}),

    # --- canonicalize_table_aliases=True, including the column-rewrite path. ---
    ("canonicalize-two-joined-tables-and-column-rewrite",
     "SELECT t1.id FROM t1 JOIN t2 ON t1.id = t2.id",
     {"canonicalize_table_aliases": True}),
    ("canonicalize-already-aliased-tables",
     "SELECT a.id FROM t1 AS a JOIN t2 AS b ON a.id = b.id",
     {"canonicalize_table_aliases": True}),

    # --- A bare subquery in WHERE (not a derived table) -- exercises the
    #     unwrap/replace splice for a Query in non-FROM/JOIN position. ---
    ("where-clause-subquery-unwrap",
     "SELECT * FROM x WHERE a IN (SELECT b FROM y)", {}),

    # --- UNION: two independent FROM-clause scopes, each qualified on its own. ---
    ("union-two-independent-scopes", "SELECT * FROM x UNION SELECT * FROM y", {}),

    # --- Table-valued function source (Func as a Table's `.this`), unaliased. ---
    ("table-valued-function-unaliased", "SELECT * FROM my_func(1, 2)", {}),
    ("table-valued-function-aliased", "SELECT * FROM my_func(1, 2) AS f", {}),

    # --- VALUES UDTF source: unaliased (synthetic alias + synthetic _col_N columns)
    #     vs already aliased with explicit columns (left as-is). ---
    ("values-udtf-unaliased-gets-synthetic-columns", "SELECT * FROM (VALUES (1, 2))", {}),
    ("values-udtf-aliased-with-columns-untouched",
     "SELECT * FROM (VALUES (1, 2)) AS v(a, b)", {}),

    # --- dialect="snowflake": real dialect-specific identifier casing on db=. ---
    ("snowflake-dialect-uppercases-db",
     "SELECT 1 FROM tbl", {"db": "db", "dialect": "snowflake"}),
]


def run_one(sql, kwargs):
    try:
        ast = parse_one(sql)
        out = qualify_tables(ast, **kwargs).sql()
        return {"ok": out}
    except Exception as e:  # noqa: BLE001
        return {"error": type(e).__name__, "message": str(e)}


records = [
    {"name": name, "sql": sql, "kwargs": kwargs, "result": run_one(sql, kwargs)}
    for name, sql, kwargs in SCENARIOS
]

print(json.dumps({"scenarios": records}))
