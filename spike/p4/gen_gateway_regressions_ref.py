#!/usr/bin/env python3
"""AIR-2163: pinned parse ASTs and WINDOW/QUALIFY generation, all rows counted."""
import json
import os
import re
import sys
sys.path.insert(0, os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref"))
import sqlglot
from sqlglot import exp, ErrorLevel


# Known runtime naming difference only: JS error messages print CopyParameter,
# Python prints its qualified class repr. All other error bytes are compared.
def dump(node):
    if isinstance(node, exp.Expr):
        return {"c": type(node).__name__, "a": [[k, dump(v)] for k, v in node.args.items()],
                "m": dict(node._meta) if node._meta else None, "cm": list(node.comments) if node.comments else None}
    if isinstance(node, list):
        return [dump(v) for v in node]
    return node


WINDOW = [
    "SELECT id, ts FROM t QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY ts DESC) = 1",
    "SELECT id, ts FROM t QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY ts DESC) = 2",
    "SELECT id, ts FROM t",
    "SELECT ROW_NUMBER() OVER () FROM t",
    "SELECT SUM(x) OVER (PARTITION BY y ORDER BY z ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) FROM t",
    "SELECT SUM(x) OVER (ORDER BY z RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) FROM t",
    "SELECT SUM(x) OVER w FROM t WINDOW w AS (PARTITION BY y ORDER BY z)",
    "SELECT SUM(x) OVER (ORDER BY z ROWS CURRENT ROW EXCLUDE TIES) FROM t",
    "SELECT SUM(x) OVER (ORDER BY z ROWS 1 PRECEDING) FROM t",
    "SELECT SUM(x) OVER (PARTITION BY \"𝛂\" ORDER BY z) FROM t",
]
PARSE = [
    "COPY INTO t FROM 's3://b/p' FILEFORMAT = CSV",
    "COPY INTO t FROM 's3://b/p' FILEFORMAT = CSV FORMAT_OPTIONS ('header' = 'true') COPY_OPTIONS ('mergeSchema' = 'true')",
    "COPY INTO t FROM @stage FILE_FORMAT = (TYPE = CSV SKIP_HEADER = 1)",
    "COPY INTO t FROM 's3://bucket' CREDENTIALS = (AWS_KEY_ID = 'x' AWS_SECRET_KEY = 'y') ENCRYPTION = (TYPE = 'AWS_SSE_S3')",
    "COPY t FROM 'file' WITH (FORMAT CSV, HEADER TRUE)",
    "COPY t TO 'file'",
    "COPY (SELECT * FROM t) TO 'file'",
    "COPY t FROM 's3://bucket' IAM_ROLE DEFAULT REGION 'us-east-1' FORMAT AS JSON 'auto'",
    "SELECT * FROM t PIVOT (SUM(v) FOR k IN ('a','b'))",
    "SELECT * FROM t PIVOT (SUM(v) AS s, MAX(v) AS m FOR k IN (1 AS a, 2 AS b)) p",
    "SELECT * FROM t PIVOT (SUM(v) FOR k IN ('a') FOR j IN ('b'))",
    "SELECT * FROM t PIVOT (SUM(v) FOR k IN (ANY ORDER BY k))",
    "SELECT * FROM t PIVOT (SUM(v) FOR k IN ('a') DEFAULT ON NULL (0))",
    "SELECT * FROM t UNPIVOT (v FOR k IN (a, b))",
    "SELECT * FROM t UNPIVOT INCLUDE NULLS ((v1,v2) FOR k IN ((a,b) AS 'x', (c,d) AS 'y'))",
    "SELECT * FROM t UNPIVOT EXCLUDE NULLS (v FOR k IN (a, b))",
    "SELECT * FROM t PIVOT (SUM(v) FOR k IN ('a')) PIVOT (SUM(v) FOR k IN ('b'))",
]
rows = []
for dialect in ["", "snowflake", "duckdb", "hive", "spark2", "spark", "databricks", "postgres", "redshift"]:
    for sql in PARSE + WINDOW:
        row = {"id": f"{dialect}:parse:{sql}", "kind": "parse", "dialect": dialect, "input": sql}
        try:
            tree = sqlglot.parse_one(sql, read=dialect)
            row["expected"] = {"ast": dump(tree)}
        except Exception as e:
            row["expected"] = {"error": type(e).__name__, "message": re.sub(r"<class 'sqlglot\.expressions\.[^']*\.([^'.]+)'>", r"\1", str(e))}
        rows.append(row)
    if dialect:
        continue
    # AST-fed base generation avoids dialect rewrites unrelated to these methods.
    for sql in WINDOW:
        for pretty in [False, True]:
            tree = sqlglot.parse_one(sql, read=dialect)
            gen = sqlglot.Dialect.get_or_raise("").generator(pretty=pretty, identify=pretty, unsupported_level=ErrorLevel.IGNORE)
            row = {"id": f"{dialect}:generate:{pretty}:{sql}", "kind": "generate", "dialect": "", "ast": dump(tree), "pretty": pretty}
            try:
                row["expected"] = {"sql": gen.generate(tree)}
            except Exception as e:
                row["expected"] = {"error": type(e).__name__, "message": re.sub(r"<class 'sqlglot\.expressions\.[^']*\.([^'.]+)'>", r"\1", str(e))}
            row["expected"]["unsupported_messages"] = gen.unsupported_messages
            rows.append(row)
assert len(rows) == 263
json.dump(rows, sys.stdout, ensure_ascii=False)
print()
