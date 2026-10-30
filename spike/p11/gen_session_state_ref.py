#!/usr/bin/env python3
"""AIR-2361 (Epic AIR-2360): session-state statement AST oracle.

Full-tree AST-dump equality, same technique spike/p4/gen_gateway_regressions_ref.py
already uses for its own parse rows — not a hand-mirrored re-implementation of
contrib/sessionState.js's own classify() dispatch logic in Python. Full-tree
equality is a STRICT SUPERSET of "the JS module's extracted key/value agrees
with the same extraction run over CPython's AST": if the two trees are
byte-identical, any deterministic extraction function run over them (including
sessionState.js's own classify()) necessarily agrees too. It is also simpler
and more reliable than hand-porting the extraction dispatch into Python, which
would itself need its own correctness argument.

Covers every statement shape named in AIR-2360's 52-statement probe (real
nodes, Command fallbacks, and the two documented misparses) across every
dialect family the probe measured, plus enough per-family repetition to
comfortably clear the >=150-row floor AIR-2361 asks for.
"""
import enum
import json
import logging
import os
import re
import sys

sys.path.insert(0, os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref"))
import sqlglot
from sqlglot import exp

# Match every other gen_*_ref.py: the Command-fallback warnings are expected for the
# probe rows and only pollute stderr.
logging.disable(logging.CRITICAL)


def dump(node):
    if isinstance(node, exp.Expr):
        return {
            "c": type(node).__name__,
            "a": [[k, dump(v)] for k, v in node.args.items()],
            "m": dict(node._meta) if node._meta else None,
            "cm": list(node.comments) if node.comments else None,
        }
    if isinstance(node, list):
        return [dump(v) for v in node]
    if isinstance(node, enum.Enum):
        # exp.DType inside DataType nodes (the DECLARE rows). Mirrors the JS side,
        # where DType values JSON-serialise as {"__enum__","name","value"} natively,
        # and spike/p3/gen_walk_in_scope_ref.py's own enum branch.
        return {"__enum__": type(node).__name__, "name": node.name, "value": node.value}
    return node


def describe_error(e):
    return {
        "error": type(e).__name__,
        "message": re.sub(r"<class 'sqlglot\.expressions\.[^']*\.([^'.]+)'>", r"\1", str(e)),
    }


# ---------------------------------------------------------------------------
# Statement rows, grouped by the dialect family they are meaningful for (every
# dialect in a family shares the identical parser grammar for these
# constructs, per PORT_PLAN.md's family-chain convention: postgres inherits to
# redshift/materialize/risingwave; hive inherits down to spark2/spark/databricks).
# ---------------------------------------------------------------------------

POSTGRES_FAMILY = ["postgres", "redshift", "materialize", "risingwave"]
DATABRICKS_FAMILY = ["hive", "spark2", "spark", "databricks"]
MYSQL_FAMILY = ["mysql", "singlestore", "starrocks", "doris"]

POSTGRES_STATEMENTS = [
    "SET search_path = a",
    "SET search_path TO a, b",
    "SET SCHEMA 'other'",
    "SET SESSION SCHEMA 'other'",
    "SET SESSION search_path = x",
    "SET LOCAL search_path = x",
    "SET LOCAL SCHEMA 'other'",
    "SET search_path TO DEFAULT",
    "SET \"search_path\" = x",
    "SET search_path FROM CURRENT",
    "SET ROLE admin",
    "SET ROLE NONE",
    "SET role = 'none'",
    "SET role='admin'",
    "SET role TO admin",
    "SET LOCAL ROLE x",
    "SET \"role\" = admin",
    "SET SESSION AUTHORIZATION bob",
    "SET SESSION AUTHORIZATION DEFAULT",
    "SET session_authorization = 'bob'",
    "SET session_authorization TO DEFAULT",
    "SET LOCAL SESSION AUTHORIZATION bob",
    "SET \"session_authorization\" = bob",
    "RESET ROLE",
    "RESET ALL",
    "RESET SESSION AUTHORIZATION",
    "RESET search_path",
    "RESET my_custom_guc",
    "DISCARD ALL",
    "DISCARD PLANS",
    "DISCARD TEMP",
    "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
    "START TRANSACTION ISOLATION LEVEL READ COMMITTED",
    "SELECT set_config('search_path', 'x', false)",
    "SELECT pg_catalog.set_config('search_path','evil',false)",
    "SELECT \"set_config\"('search_path','evil',false)",
    "CALL p()",
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
    "ROLLBACK TO SAVEPOINT sp1",
    "SET TimeZone = 'UTC'",
]

# R130 (AIR-2379 prerequisite): sessionState.js's new `chain` field (true for a
# trailing AND CHAIN, false for AND NO CHAIN/no clause) is derived from several
# DIFFERENT AST shapes per contrib/sessionState.js's own "Transaction chain"
# doc section — a real exp.Commit's own `chain` arg; a real exp.Rollback (no
# such arg at all, read from trailing tokens instead); the EndStatement
# shortcut (always chainless by construction); and ABORT's/bare END's
# misparse shape, which the clause itself changes (Column -> And/Alias(And)).
# Pinned here against the real CPython checkout rather than trusted from only
# the JS-side unit tests added with the field itself, same full-tree-equality
# technique as every other row in this file. Shared across both families this
# applies to (postgres: real Commit via TokenType.END; databricks: END/ABORT
# both take the misparse path, since only postgres's own parser table maps
# TokenType.END to _parse_commit_or_rollback) — two DIFFERENT code paths are
# worth pinning twice, not redundant despite the identical SQL text.
SESSION_STATE_CHAIN_STATEMENTS = [
    "COMMIT AND CHAIN",
    "COMMIT WORK AND NO CHAIN",
    "COMMIT TRANSACTION AND CHAIN",
    "END AND CHAIN",
    "END AND NO CHAIN",
    "BEGIN; END AND CHAIN; SELECT 1",
    "BEGIN; SELECT 1; END",
    "ROLLBACK AND CHAIN",
    "ROLLBACK WORK AND NO CHAIN",
    "ABORT AND CHAIN",
    "ABORT AND NO CHAIN",
    "ROLLBACK TO SAVEPOINT a",
    "COMMIT /* and chain */ AND NO CHAIN",
    "commit and chain;",
    # Upstream-faithful parse errors (ABORT WORK, unlike bare ABORT, already
    # completes as its own top-level statement before "AND CHAIN" is reached;
    # PREPARED two-phase-commit forms are not parsed at all) — `add()`'s own
    # try/except already records these the same way as every other error row
    # in this file (e.g. "START TRANSACTION ISOLATION LEVEL READ COMMITTED"
    # above), no special-casing needed.
    "ABORT WORK AND CHAIN",
    "COMMIT PREPARED 'x'",
]

POSTGRES_STATEMENTS += SESSION_STATE_CHAIN_STATEMENTS

DATABRICKS_STATEMENTS = [
    "SET timezone = 'America/New_York'",
    "SET spark.sql.session.timeZone = 'UTC'",
    "SET role = admin",
    "USE CATALOG main",
    "USE SCHEMA sales",
    "USE DATABASE sales",
    "USE main.sales",
    "USE sales",
    "SET TIME ZONE 'UTC'",
    "RESET",
    "DECLARE VARIABLE x INT DEFAULT 1",
    "DECLARE OR REPLACE VARIABLE y STRING = 'hello'",
    "ALTER SESSION SET QUERY_TAG = 'reporting'",
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
] + SESSION_STATE_CHAIN_STATEMENTS

SNOWFLAKE_STATEMENTS = [
    "USE ROLE x",
    "USE WAREHOUSE wh",
    "USE DATABASE db1",
    "USE SCHEMA sch1",
    "USE db1.sch1",
    "ALTER SESSION SET QUERY_TAG = 'reporting'",
    "ALTER SESSION UNSET QUERY_TAG",
    "ALTER SESSION SET a = 1, b = 2",
]

MYSQL_STATEMENTS = [
    "SET NAMES utf8mb4",
    "SET NAMES utf8mb4 COLLATE utf8mb4_general_ci",
    "SET GLOBAL max_connections = 100",
    "SET @x = 1",
    "SET @@GLOBAL.max_connections = 100",
]

TSQL_STATEMENTS = [
    "SET NOCOUNT ON",
    "SET ANSI_NULLS ON",
    "SET XACT_ABORT ON",
    "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
    "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
    "SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED",
]

GENERIC_STATEMENTS = [
    "SET foo = 'bar'",
    "SET foo = 1",
    "USE mydb",
    "USE mydb.schema1",
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
]

rows = []


def add(dialect, sql):
    row_id = f"{dialect}:{sql}"
    row = {"id": row_id, "dialect": dialect, "input": sql}
    try:
        trees = sqlglot.parse(sql, read=dialect)
        trees = [t for t in trees if t is not None and type(t).__name__ != "Semicolon"]
        row["expected"] = {"ast": [dump(t) for t in trees]}
    except Exception as e:
        row["expected"] = describe_error(e)
    rows.append(row)


for dialect in POSTGRES_FAMILY:
    for sql in POSTGRES_STATEMENTS:
        add(dialect, sql)

for dialect in DATABRICKS_FAMILY:
    for sql in DATABRICKS_STATEMENTS:
        add(dialect, sql)

for sql in SNOWFLAKE_STATEMENTS:
    add("snowflake", sql)

for dialect in MYSQL_FAMILY:
    for sql in MYSQL_STATEMENTS:
        add(dialect, sql)

for sql in TSQL_STATEMENTS:
    add("tsql", sql)

for dialect in ["duckdb", "bigquery"]:
    for sql in GENERIC_STATEMENTS:
        add(dialect, sql)

ids = [r["id"] for r in rows]
assert len(ids) == len(set(ids)), "duplicate row id"
assert len(rows) >= 150, f"expected >= 150 rows, got {len(rows)}"

json.dump(rows, sys.stdout, ensure_ascii=False)
print()
