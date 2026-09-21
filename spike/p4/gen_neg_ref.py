#!/usr/bin/env python3
"""Pinned production neg_sql oracle: real AST generation and parse/generate paths.
Source contract: sqlglot/generator.py:4013-4017 at 91119bc.
Includes empty operand IndexError; never infer Python string indexing from JS.
"""
import json
import os
import sys
sys.path.insert(0, os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref"))
import sqlglot
from sqlglot import exp, ErrorLevel


def dump(node):
    if isinstance(node, exp.Expr):
        return {"c": type(node).__name__, "a": [[k, dump(v)] for k, v in node.args.items()],
                "m": dict(node._meta) if node._meta else None,
                "cm": list(node.comments) if node.comments else None}
    if isinstance(node, list):
        return [dump(v) for v in node]
    return node


def trees():
    for value in ["0", "1", "-1", "-0", "1.25", "-1.25", "1e-12", "9223372036854775808", "-9223372036854775808", ""]:
        yield "literal:" + value, exp.Neg(this=exp.Literal.number(value))
    for depth in [2, 3, 4, 8]:
        node = exp.Literal.number("5")
        for _ in range(depth):
            node = exp.Neg(this=node)
        yield "depth:" + str(depth), node
    yield "missing", exp.Neg()
    yield "parenthesized", exp.Neg(this=exp.Paren(this=exp.Neg(this=exp.Literal.number(5))))
    yield "unicode-column", exp.Neg(this=exp.column("𝛂"))
    yield "string", exp.Neg(this=exp.Literal.string("-text"))
    literal = exp.Literal.number(-5)
    literal.add_comments(["negative operand"])
    yield "operand-comment", exp.Neg(this=literal)


DIALECTS = ["", "snowflake", "duckdb", "hive", "spark2", "spark", "databricks", "postgres", "redshift"]
SQLS = ["SELECT -1", "SELECT - -5", "SELECT -(-5)", "SELECT -0.25 AS x", "SELECT -x FROM t", "SELECT 2 * -3", "SELECT -(1 + 2)", "SELECT -9223372036854775808", "SELECT -5 /* keep */"]
rows = []
for dialect in DIALECTS:
    for pretty, identify in [(False, False), (True, True)]:
        cases = [("ast", name, None, node) for name, node in trees()]
        cases += [("roundtrip", sql, sql, sqlglot.parse_one(sql, read=dialect)) for sql in SQLS]
        for kind, name, sql, tree in cases:
            generator = sqlglot.Dialect.get_or_raise(dialect).generator(pretty=pretty, identify=identify, unsupported_level=ErrorLevel.IGNORE)
            row = {"id": f"{dialect}:{pretty}:{kind}:{name}", "kind": kind, "dialect": dialect,
                   "pretty": pretty, "identify": identify, "input": sql, "ast": dump(tree)}
            try:
                row["expected"] = {"sql": generator.generate(tree)}
            except Exception as error:
                row["expected"] = {"error": type(error).__name__, "message": str(error)}
            row["expected"]["unsupported_messages"] = generator.unsupported_messages
            rows.append(row)
assert len(rows) == 504
json.dump(rows, sys.stdout, ensure_ascii=False)
print()
