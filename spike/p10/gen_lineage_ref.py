#!/usr/bin/env python3
"""CPython oracle for `sqlglot/lineage.py` (AIR-2121, epic AIR-2092, "9.1 lineage.js" --
stretch scope, outside the RULES optimizer pipeline).

Reproduces EVERY assertion-bearing `lineage(...)` call in the real upstream
`tests/test_lineage.py` (not a hand-invented scenario battery), driving the REAL
`sqlglot.lineage.lineage` entry point, which itself composes `qualify()` (R75),
`Scope`/`build_scope` (R44/R46), and `normalize_identifiers` (R42) -- all independently
oracle-verified already; this file's own job is the end-to-end `Node` DAG shape.

Comparison strategy: rather than hand-picking which `.name`/`.source.sql()`/etc fields
each test happens to assert (which would silently miss anything a test's own author
didn't think to check), every scenario dumps the COMPLETE reachable `Node` DAG via
`walk()`'s own real traversal order, memoized by node IDENTITY (`id(node)` here,
matching the Node object itself used as the memo key on the JS side -- no separate
id-allocator, `scope.js`'s own established idiom). This:
  - captures every field (`name`/`expression.sql()`/`source.sql()`/`source_name`/
    `reference_node_name`) on every node, not just the ones a given test asserted;
  - captures `downstream` ORDER exactly (never sorted -- the R80 fingerprint lesson:
    order is part of the contract);
  - captures node-identity SHARING (the whole point of `test_lineage_all_columns_
    shares_nodes_across_outputs`/`test_lineage_shared_cte_performance`'s memoization
    tests): two Node references that are the SAME object upstream get the SAME
    sequential id in the dump; a JS port that fails to cache would instead mint a
    second entry, both inflating `len(nodes)` and breaking downstream-id alignment,
    which surfaces as an ordinary structural MISMATCH with no bespoke identity-check
    needed on either side.

`to_html`/`GraphHTML` are NOT part of this cross-language diff: their output embeds a
process-local `id(node)` integer directly into a vis.js-bound HTML/JS string, which has
no cross-language-stable representation, and the upstream test itself only checks
`len(...) > 1000` and edge-dict shape, not exact content. Covered instead by a native
JS test in `test/lineage.test.mjs` asserting the same shape-only properties, after
confirming (by hand, see PORT_PLAN.md) that the real fixture sqlglot-js ships no
`lineage.html` template resource at this pin -- `GraphHTML.__str__` builds the whole
string itself; there is no external template file to diverge from.

    PYTHONHASHSEED=0 python3 spike/p10/gen_lineage_ref.py > spike/out/lineage.json
    node spike/p10/fuzz_lineage.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-complete-pin")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import parse_one  # noqa: E402
from sqlglot.lineage import lineage  # noqa: E402
from sqlglot.optimizer import qualify as qualify_mod  # noqa: E402
from sqlglot.optimizer.scope import build_scope  # noqa: E402


def dump_result(result):
    """Flatten the reachable Node DAG (or dict[str, Node]) into a list of records,
    memoized by node identity -- see this file's own module docstring."""
    node_ids = {}
    nodes = []

    def visit(node):
        key = id(node)
        if key in node_ids:
            return node_ids[key]
        nid = len(nodes)
        node_ids[key] = nid
        nodes.append(None)
        downstream_ids = [visit(d) for d in node.downstream]
        nodes[nid] = {
            "name": node.name,
            "expression_sql": node.expression.sql(),
            "source_sql": node.source.sql(),
            "source_name": node.source_name,
            "reference_node_name": node.reference_node_name,
            "downstream": downstream_ids,
        }
        return nid

    if isinstance(result, dict):
        columns = {k: visit(v) for k, v in result.items()}
    else:
        columns = {"__root__": visit(result)}
    return {"columns": columns, "nodes": nodes}


def run_lineage(column, sql, **kwargs):
    try:
        result = lineage(column, sql, **kwargs)
        return {"ok": dump_result(result)}
    except Exception as e:  # noqa: BLE001 -- oracle: capture, don't crash the harness
        return {"error": e.__class__.__name__, "message": str(e)}


# --- structural scenarios: one entry per `lineage(...)` call in test_lineage.py whose
# assertions are purely about the resulting Node DAG's shape. `kwargs` keys stay
# snake_case here; fuzz_lineage.mjs's own KWARG_KEY_MAP converts to this port's
# camelCase options surface, the same split gen_qualify_ref.py's `toOptions` uses. ---
SCENARIOS = [
    # test_lineage
    ("test_lineage", "a", "SELECT a FROM z",
     {"schema": {"x": {"a": "int"}}, "sources": {"y": "SELECT * FROM x", "z": "SELECT a FROM y"}}),

    # test_lineage_sql_with_cte
    ("test_lineage_sql_with_cte", "a", "WITH z AS (SELECT a FROM y) SELECT a FROM z",
     {"schema": {"x": {"a": "int"}}, "sources": {"y": "SELECT * FROM x"}}),

    # test_lineage_source_with_cte
    ("test_lineage_source_with_cte", "a", "SELECT a FROM z",
     {"schema": {"x": {"a": "int"}}, "sources": {"z": "WITH y AS (SELECT * FROM x) SELECT a FROM y"}}),

    # test_lineage_source_with_star
    ("test_lineage_source_with_star", "a", "WITH y AS (SELECT * FROM x) SELECT a FROM y", {}),

    # test_lineage_join_with_star
    ("test_lineage_join_with_star", "*", "SELECT * from x JOIN y USING (uid)", {}),

    # test_lineage_join_with_qualified_star
    ("test_lineage_join_with_qualified_star", "*", "SELECT x.* from x JOIN y USING (uid)", {}),

    # test_lineage_external_col
    ("test_lineage_external_col", "a",
     "WITH y AS (SELECT * FROM x) SELECT a FROM y JOIN z USING (uid)", {}),

    # test_lineage_values
    ("test_lineage_values", "a", "SELECT a FROM y",
     {"sources": {"y": "SELECT a FROM (VALUES (1), (2)) AS t (a)"}}),

    # test_lineage_cte_name_appears_in_schema
    ("test_lineage_cte_name_appears_in_schema", "c2",
     "WITH t1 AS (SELECT * FROM a.b.t2), inter AS (SELECT * FROM t1) SELECT * FROM inter",
     {"schema": {"a": {"b": {"t1": {"c1": "int"}, "t2": {"c2": "int"}}}}}),

    # test_lineage_union
    ("test_lineage_union_1", "x",
     "SELECT ax AS x FROM a UNION SELECT bx FROM b UNION SELECT cx FROM c", {}),
    ("test_lineage_union_2", "x",
     "SELECT x FROM (SELECT ax AS x FROM a UNION SELECT bx FROM b UNION SELECT cx FROM c)", {}),

    # test_lineage_lateral_flatten
    ("test_lineage_lateral_flatten_1", "VALUE",
     "SELECT FLATTENED.VALUE FROM TEST_TABLE, LATERAL FLATTEN(INPUT => RESULT, OUTER => TRUE) FLATTENED",
     {"dialect": "snowflake"}),
    ("test_lineage_lateral_flatten_2", "FIELD",
     "SELECT FLATTENED.VALUE:field::text AS FIELD FROM SNOWFLAKE.SCHEMA.MODEL AS MODEL_ALIAS, "
     "LATERAL FLATTEN(INPUT => MODEL_ALIAS.A) AS FLATTENED",
     {"schema": {"SNOWFLAKE": {"SCHEMA": {"TABLE": {"A": "integer"}}}},
      "sources": {"SNOWFLAKE.SCHEMA.MODEL": "SELECT A FROM SNOWFLAKE.SCHEMA.TABLE"},
      "dialect": "snowflake"}),

    # test_subquery
    ("test_subquery_1", "output",
     "SELECT (SELECT max(t3.my_column) my_column FROM foo t3) AS output FROM table3", {}),
    ("test_subquery_2", "y",
     "SELECT SUM((SELECT max(a) a from x) + (SELECT min(b) b from x) + c) AS y FROM x", {}),
    ("test_subquery_3", "x",
     "WITH cte AS (SELECT a, b FROM z) SELECT sum(SELECT a FROM cte) AS x, "
     "(SELECT b FROM cte) as y FROM cte", {}),
    ("test_subquery_4", "a", """
        WITH foo AS (
          SELECT
            1 AS a
        ), bar AS (
          (
            SELECT
              a + 1 AS a
            FROM foo
          )
        )
        (
          SELECT
            a + b AS a
          FROM bar
          CROSS JOIN (
            SELECT
              2 AS b
          ) AS baz
        )
        """, {}),
    ("test_subquery_5", "a", "SELECT a FROM (SELECT a FROM x) subquery", {}),
    ("test_subquery_6", "a", "SELECT a FROM (SELECT a FROM x)", {}),

    # test_lineage_cte_union
    ("test_lineage_cte_union", "x", """
        WITH dataset AS (
            SELECT *
            FROM catalog.db.table_a

            UNION

            SELECT *
            FROM catalog.db.table_b
        )

        SELECT x, created_at FROM dataset;
        """, {}),

    # test_lineage_no_self_loops_with_multi_aliased_union_cte
    ("test_lineage_no_self_loops_with_multi_aliased_union_cte", "a", """
        WITH three_way AS (
            SELECT a FROM t1
            UNION ALL
            SELECT a FROM t2
            UNION ALL
            SELECT a FROM t3
        ),
        attached AS (
            SELECT COALESCE(r1.a, r2.a) AS a
            FROM three_way AS r1
            LEFT JOIN three_way AS r2 ON r1.a = r2.a
        )
        SELECT a FROM attached
        """, {}),

    # test_lineage_source_union
    ("test_lineage_source_union", "x", "SELECT x, created_at FROM dataset;",
     {"sources": {"dataset": """
                SELECT *
                FROM catalog.db.table_a

                UNION

                SELECT *
                FROM catalog.db.table_b
                """}}),

    # test_select_star
    ("test_select_star", "x", "SELECT x from (SELECT * from table_a)", {}),

    # test_unnest
    ("test_unnest", "b",
     "with _data as (select [struct(1 as a, 2 as b)] as col) select b from _data "
     "cross join unnest(col)", {}),

    # test_lineage_normalize (structural half; error-raising half is in RAISE_SCENARIOS)
    ("test_lineage_normalize", "a", "WITH x AS (SELECT 1 a) SELECT a FROM x",
     {"dialect": "snowflake"}),

    # test_trim
    ("test_trim", "a", """
            SELECT a, b, c
            FROM (select a, b, c from y) z
        """, {"trim_selects": False}),

    # test_node_name_doesnt_contain_comment
    ("test_node_name_doesnt_contain_comment", "x",
     "SELECT * FROM (SELECT x /* c */ FROM t1) AS t2", {}),

    # test_pivot_without_alias
    ("test_pivot_without_alias", "other_a", """
        SELECT
            a as other_a
        FROM (select value,category from sample_data)
        PIVOT (
            sum(value)
            FOR category IN ('a', 'b')
        );
        """, {}),

    # test_pivot_with_alias
    ("test_pivot_with_alias", "other_as", """
            SELECT
                cat_a_s as other_as
            FROM sample_data
            PIVOT (
                sum(value) as s, max(price)
                FOR category IN ('a' as cat_a, 'b')
            )
        """, {}),

    # test_pivot_with_cte
    ("test_pivot_with_cte", "other_a", """
        WITH t as (
            SELECT
                a as other_a
            FROM sample_data
            PIVOT (
                sum(value)
                FOR category IN ('a', 'b')
            )
        )
        select other_a from t
        """, {}),

    # test_pivot_with_implicit_column_of_pivoted_source
    ("test_pivot_with_implicit_column_of_pivoted_source", "empid", """
        SELECT empid
        FROM quarterly_sales
            PIVOT(SUM(amount) FOR quarter IN (
            '2023_Q1',
            '2023_Q2',
            '2023_Q3'))
        ORDER BY empid;
        """, {}),

    # test_pivot_with_implicit_column_of_pivoted_source_and_cte
    ("test_pivot_with_implicit_column_of_pivoted_source_and_cte", "empid", """
        WITH t as (
            SELECT empid
            FROM quarterly_sales
            PIVOT(SUM(amount) FOR quarter IN (
                '2023_Q1',
                '2023_Q2',
                '2023_Q3'))
        )
        select empid from t
        """, {}),

    # test_unpivot
    ("test_unpivot_score", "score",
     "SELECT id, metric_name, score FROM sales UNPIVOT (score FOR metric_name IN (jan, feb))",
     {"schema": {"sales": {"id": "int", "jan": "int", "feb": "int"}}, "dialect": "snowflake"}),
    ("test_unpivot_metric_name", "metric_name",
     "SELECT id, metric_name, score FROM sales UNPIVOT (score FOR metric_name IN (jan, feb))",
     {"schema": {"sales": {"id": "int", "jan": "int", "feb": "int"}}, "dialect": "snowflake"}),
    ("test_unpivot_id", "id",
     "SELECT id, metric_name, score FROM sales UNPIVOT (score FOR metric_name IN (jan, feb))",
     {"schema": {"sales": {"id": "int", "jan": "int", "feb": "int"}}, "dialect": "snowflake"}),

    # test_unpivot_with_cte
    ("test_unpivot_with_cte_score", "score", """
        WITH src AS (
          SELECT id, jan, feb FROM sales
        )
        SELECT id, metric_name, score
        FROM src UNPIVOT (score FOR metric_name IN (jan, feb))
        """, {"schema": {"sales": {"id": "int", "jan": "int", "feb": "int"}}, "dialect": "snowflake"}),
    ("test_unpivot_with_cte_id", "id", """
        WITH src AS (
          SELECT id, jan, feb FROM sales
        )
        SELECT id, metric_name, score
        FROM src UNPIVOT (score FOR metric_name IN (jan, feb))
        """, {"schema": {"sales": {"id": "int", "jan": "int", "feb": "int"}}, "dialect": "snowflake"}),

    # test_unpivot_multi_column
    ("test_unpivot_multi_column_first_half", "first_half_sales", """
        SELECT product, semesters, first_half_sales, second_half_sales
        FROM produce
        UNPIVOT((first_half_sales, second_half_sales) FOR semesters IN ((q1, q2) AS 'semester_1', (q3, q4) AS 'semester_2'))
        """,
     {"schema": {"produce": {"product": "string", "q1": "int64", "q2": "int64", "q3": "int64", "q4": "int64"}},
      "dialect": "bigquery"}),
    ("test_unpivot_multi_column_second_half", "second_half_sales", """
        SELECT product, semesters, first_half_sales, second_half_sales
        FROM produce
        UNPIVOT((first_half_sales, second_half_sales) FOR semesters IN ((q1, q2) AS 'semester_1', (q3, q4) AS 'semester_2'))
        """,
     {"schema": {"produce": {"product": "string", "q1": "int64", "q2": "int64", "q3": "int64", "q4": "int64"}},
      "dialect": "bigquery"}),
    ("test_unpivot_multi_column_semesters", "semesters", """
        SELECT product, semesters, first_half_sales, second_half_sales
        FROM produce
        UNPIVOT((first_half_sales, second_half_sales) FOR semesters IN ((q1, q2) AS 'semester_1', (q3, q4) AS 'semester_2'))
        """,
     {"schema": {"produce": {"product": "string", "q1": "int64", "q2": "int64", "q3": "int64", "q4": "int64"}},
      "dialect": "bigquery"}),
    ("test_unpivot_multi_column_product", "product", """
        SELECT product, semesters, first_half_sales, second_half_sales
        FROM produce
        UNPIVOT((first_half_sales, second_half_sales) FOR semesters IN ((q1, q2) AS 'semester_1', (q3, q4) AS 'semester_2'))
        """,
     {"schema": {"produce": {"product": "string", "q1": "int64", "q2": "int64", "q3": "int64", "q4": "int64"}},
      "dialect": "bigquery"}),

    # test_unpivot_with_alias_columns (CTE-sourced form)
    ("test_unpivot_with_alias_columns_cte_s", "s", """
        WITH src AS (
          SELECT empid, dept, jan, feb FROM monthly_sales
        )
        SELECT m, s, e FROM src UNPIVOT(sales FOR month IN (jan, feb)) AS t(e, d, m, s)
        """, {"schema": {"monthly_sales": {"empid": "int", "dept": "text", "jan": "int", "feb": "int"}},
              "dialect": "snowflake"}),
    ("test_unpivot_with_alias_columns_cte_m", "m", """
        WITH src AS (
          SELECT empid, dept, jan, feb FROM monthly_sales
        )
        SELECT m, s, e FROM src UNPIVOT(sales FOR month IN (jan, feb)) AS t(e, d, m, s)
        """, {"schema": {"monthly_sales": {"empid": "int", "dept": "text", "jan": "int", "feb": "int"}},
              "dialect": "snowflake"}),
    ("test_unpivot_with_alias_columns_cte_e", "e", """
        WITH src AS (
          SELECT empid, dept, jan, feb FROM monthly_sales
        )
        SELECT m, s, e FROM src UNPIVOT(sales FOR month IN (jan, feb)) AS t(e, d, m, s)
        """, {"schema": {"monthly_sales": {"empid": "int", "dept": "text", "jan": "int", "feb": "int"}},
              "dialect": "snowflake"}),
    # physical-table form
    ("test_unpivot_with_alias_columns_phys_s", "s",
     "SELECT m, s, e FROM monthly_sales UNPIVOT(sales FOR month IN (jan, feb)) AS t(e, d, m, s)",
     {"schema": {"monthly_sales": {"empid": "int", "dept": "text", "jan": "int", "feb": "int"}},
      "dialect": "snowflake"}),
    ("test_unpivot_with_alias_columns_phys_m", "m",
     "SELECT m, s, e FROM monthly_sales UNPIVOT(sales FOR month IN (jan, feb)) AS t(e, d, m, s)",
     {"schema": {"monthly_sales": {"empid": "int", "dept": "text", "jan": "int", "feb": "int"}},
      "dialect": "snowflake"}),
    ("test_unpivot_with_alias_columns_phys_e", "e",
     "SELECT m, s, e FROM monthly_sales UNPIVOT(sales FOR month IN (jan, feb)) AS t(e, d, m, s)",
     {"schema": {"monthly_sales": {"empid": "int", "dept": "text", "jan": "int", "feb": "int"}},
      "dialect": "snowflake"}),
    # star-sourced CTE, no schema -- positional renames must NOT apply
    ("test_unpivot_with_alias_columns_star_d", "d", """
        WITH src AS (SELECT * FROM monthly_sales)
        SELECT d FROM src UNPIVOT(sales FOR month IN (jan, feb)) AS t(e, d, m, s)
        """, {"dialect": "snowflake"}),

    # test_chained_pivots
    ("test_chained_pivots_score", "score",
     "SELECT id, score, headcount FROM sales UNPIVOT(score FOR month IN (jan, feb)) "
     "UNPIVOT(headcount FOR region IN (north, south))",
     {"schema": {"sales": {"id": "int", "jan": "int", "feb": "int", "north": "int", "south": "int"}},
      "dialect": "snowflake"}),
    ("test_chained_pivots_headcount", "headcount",
     "SELECT id, score, headcount FROM sales UNPIVOT(score FOR month IN (jan, feb)) "
     "UNPIVOT(headcount FOR region IN (north, south))",
     {"schema": {"sales": {"id": "int", "jan": "int", "feb": "int", "north": "int", "south": "int"}},
      "dialect": "snowflake"}),
    ("test_chained_pivots_id", "id",
     "SELECT id, score, headcount FROM sales UNPIVOT(score FOR month IN (jan, feb)) "
     "UNPIVOT(headcount FOR region IN (north, south))",
     {"schema": {"sales": {"id": "int", "jan": "int", "feb": "int", "north": "int", "south": "int"}},
      "dialect": "snowflake"}),

    # test_chained_pivots_through_cte
    ("test_chained_pivots_through_cte", "score", """
        WITH src AS (SELECT id, jan, feb, north, south FROM sales)
        SELECT score FROM src
        UNPIVOT(score FOR month IN (jan, feb)) UNPIVOT(headcount FOR region IN (north, south))
        """, {"schema": {"sales": {"id": "int", "jan": "int", "feb": "int", "north": "int", "south": "int"}},
              "dialect": "snowflake"}),

    # test_chained_pivots_mixed
    ("test_chained_pivots_mixed_v", "v",
     "SELECT id, c, v FROM t PIVOT(SUM(val) FOR cat IN ('a' AS a, 'b' AS b)) UNPIVOT(v FOR c IN (a, b))",
     {"schema": {"t": {"id": "int", "cat": "text", "val": "int"}}, "dialect": "snowflake"}),
    ("test_chained_pivots_mixed_id", "id",
     "SELECT id, c, v FROM t PIVOT(SUM(val) FOR cat IN ('a' AS a, 'b' AS b)) UNPIVOT(v FOR c IN (a, b))",
     {"schema": {"t": {"id": "int", "cat": "text", "val": "int"}}, "dialect": "snowflake"}),

    # test_chained_pivots_with_alias_columns
    ("test_chained_pivots_with_alias_columns_a", "a",
     "SELECT a, b, c, d, e, f FROM m UNPIVOT(sales FOR mon IN (jan, feb)) "
     "UNPIVOT(hc FOR reg IN (n, s)) AS t(a, b, c, d, e, f)",
     {"schema": {"m": {"empid": "int", "dept": "text", "jan": "int", "feb": "int", "n": "int", "s": "int"}},
      "dialect": "snowflake"}),
    ("test_chained_pivots_with_alias_columns_b", "b",
     "SELECT a, b, c, d, e, f FROM m UNPIVOT(sales FOR mon IN (jan, feb)) "
     "UNPIVOT(hc FOR reg IN (n, s)) AS t(a, b, c, d, e, f)",
     {"schema": {"m": {"empid": "int", "dept": "text", "jan": "int", "feb": "int", "n": "int", "s": "int"}},
      "dialect": "snowflake"}),
    ("test_chained_pivots_with_alias_columns_c", "c",
     "SELECT a, b, c, d, e, f FROM m UNPIVOT(sales FOR mon IN (jan, feb)) "
     "UNPIVOT(hc FOR reg IN (n, s)) AS t(a, b, c, d, e, f)",
     {"schema": {"m": {"empid": "int", "dept": "text", "jan": "int", "feb": "int", "n": "int", "s": "int"}},
      "dialect": "snowflake"}),
    ("test_chained_pivots_with_alias_columns_d", "d",
     "SELECT a, b, c, d, e, f FROM m UNPIVOT(sales FOR mon IN (jan, feb)) "
     "UNPIVOT(hc FOR reg IN (n, s)) AS t(a, b, c, d, e, f)",
     {"schema": {"m": {"empid": "int", "dept": "text", "jan": "int", "feb": "int", "n": "int", "s": "int"}},
      "dialect": "snowflake"}),
    ("test_chained_pivots_with_alias_columns_e", "e",
     "SELECT a, b, c, d, e, f FROM m UNPIVOT(sales FOR mon IN (jan, feb)) "
     "UNPIVOT(hc FOR reg IN (n, s)) AS t(a, b, c, d, e, f)",
     {"schema": {"m": {"empid": "int", "dept": "text", "jan": "int", "feb": "int", "n": "int", "s": "int"}},
      "dialect": "snowflake"}),
    ("test_chained_pivots_with_alias_columns_f", "f",
     "SELECT a, b, c, d, e, f FROM m UNPIVOT(sales FOR mon IN (jan, feb)) "
     "UNPIVOT(hc FOR reg IN (n, s)) AS t(a, b, c, d, e, f)",
     {"schema": {"m": {"empid": "int", "dept": "text", "jan": "int", "feb": "int", "n": "int", "s": "int"}},
      "dialect": "snowflake"}),

    # test_chained_pivots_consuming_alias_columns
    ("test_chained_pivots_consuming_alias_columns_hc", "hc",
     "SELECT hc, region FROM sales UNPIVOT(score FOR month IN (jan, feb)) AS u1(a, b, c, d) "
     "UNPIVOT(hc FOR region IN (b, c))",
     {"schema": {"sales": {"id": "int", "jan": "int", "feb": "int", "north": "int", "south": "int"}},
      "dialect": "duckdb"}),
    ("test_chained_pivots_consuming_alias_columns_region", "region",
     "SELECT hc, region FROM sales UNPIVOT(score FOR month IN (jan, feb)) AS u1(a, b, c, d) "
     "UNPIVOT(hc FOR region IN (b, c))",
     {"schema": {"sales": {"id": "int", "jan": "int", "feb": "int", "north": "int", "south": "int"}},
      "dialect": "duckdb"}),
    ("test_chained_pivots_consuming_alias_columns_hi", "hi",
     "SELECT hi, lo FROM sales UNPIVOT(score FOR month IN (jan, feb)) AS u1(a, b, c, d) "
     "UNPIVOT((hi, lo) FOR region IN ((b, c)))",
     {"schema": {"sales": {"id": "int", "jan": "int", "feb": "int", "north": "int", "south": "int"}},
      "dialect": "duckdb"}),
    ("test_chained_pivots_consuming_alias_columns_lo", "lo",
     "SELECT hi, lo FROM sales UNPIVOT(score FOR month IN (jan, feb)) AS u1(a, b, c, d) "
     "UNPIVOT((hi, lo) FOR region IN ((b, c)))",
     {"schema": {"sales": {"id": "int", "jan": "int", "feb": "int", "north": "int", "south": "int"}},
      "dialect": "duckdb"}),

    # test_multiple_pivoted_sources
    ("test_multiple_pivoted_sources_hc", "hc", """
        SELECT s1.val, s2.hc
        FROM t1 UNPIVOT(val FOR m IN (jan, feb)) AS s1
        JOIN t2 UNPIVOT(hc FOR r IN (val, other)) AS s2 ON s1.id = s2.id
        """, {"schema": {"t1": {"id": "int", "jan": "int", "feb": "int"},
                          "t2": {"id": "int", "val": "int", "other": "int"}},
              "dialect": "snowflake"}),
    ("test_multiple_pivoted_sources_val", "val", """
        SELECT s1.val, s2.hc
        FROM t1 UNPIVOT(val FOR m IN (jan, feb)) AS s1
        JOIN t2 UNPIVOT(hc FOR r IN (val, other)) AS s2 ON s1.id = s2.id
        """, {"schema": {"t1": {"id": "int", "jan": "int", "feb": "int"},
                          "t2": {"id": "int", "val": "int", "other": "int"}},
              "dialect": "snowflake"}),

    # test_pivot_with_alias_columns
    ("test_pivot_with_alias_columns", "x", """
        SELECT x FROM (SELECT value, category FROM sample_data) AS sd
        PIVOT (SUM(value) FOR category IN ('a', 'b')) AS p(x, y)
        """, {}),

    # test_table_udtf_snowflake
    ("test_table_udtf_snowflake_lateral", "external_id", """
        SELECT f.value:external_id::string AS external_id
        FROM database_name.schema_name.table_name AS raw,
        LATERAL FLATTEN(events) AS f
        """, {"dialect": "snowflake"}),
    ("test_table_udtf_snowflake_table", "external_id", """
        SELECT f.value:external_id::string AS external_id
        FROM database_name.schema_name.table_name AS raw
        JOIN TABLE(FLATTEN(events)) AS f
        """, {"dialect": "snowflake"}),

    # test_pivot_with_subquery
    ("test_pivot_with_subquery_product_type", "product_type", """
        WITH cte AS (
            SELECT * FROM (
                SELECT product_type, month, loan_id
                FROM loan_ledger
            ) PIVOT (
                COUNT(loan_id) FOR month IN ('2024-10', '2024-11')
            )
        )
        SELECT
            cte.product_type AS product_type,
            cte."2024-10" AS "2024-10"
        FROM cte
        """, {"dialect": "duckdb",
              "schema": {"loan_ledger": {"product_type": "varchar", "month": "date", "loan_id": "int"}}}),
    ("test_pivot_with_subquery_2024_10", '"2024-10"', """
        WITH cte AS (
            SELECT * FROM (
                SELECT product_type, month, loan_id
                FROM loan_ledger
            ) PIVOT (
                COUNT(loan_id) FOR month IN ('2024-10', '2024-11')
            )
        )
        SELECT
            cte.product_type AS product_type,
            cte."2024-10" AS "2024-10"
        FROM cte
        """, {"dialect": "duckdb",
              "schema": {"loan_ledger": {"product_type": "varchar", "month": "date", "loan_id": "int"}}}),

    # test_lineage_shared_cte_performance
    *[("test_lineage_shared_cte_performance", "a",
       "WITH " + ",\n     ".join(
           ["cte_0 AS (SELECT a FROM base_table)"]
           + [f"cte_{k} AS (SELECT t1.a + t2.a AS a FROM cte_{k - 1} t1 JOIN cte_{k - 1} t2 ON t1.a = t2.a)"
              for k in range(1, 12)]
       ) + "\nSELECT a FROM cte_11",
       {"schema": {"base_table": {"a": "int"}}})],

    # test_lineage_cte_self_join_distinct_aliases
    ("test_lineage_cte_self_join_distinct_aliases", "combined",
     "WITH shared AS (SELECT a FROM x) SELECT s1.a + s2.a AS combined FROM shared s1, shared s2",
     {"schema": {"x": {"a": "int"}}}),
]

# --- column=None scenarios (dict[name, Node] results) -- test_lineage_all_columns,
# test_lineage_all_columns_shares_nodes_across_outputs,
# test_lineage_all_columns_set_operation. ---
ALL_COLUMNS_SCENARIOS = [
    ("test_lineage_all_columns", "SELECT a, b + 1 AS bp FROM x",
     {"schema": {"x": {"a": "int", "b": "int"}}}),
    ("test_lineage_all_columns_shares_nodes_across_outputs",
     "WITH t AS (SELECT a, b FROM x) SELECT a, a + b AS ab FROM t",
     {"schema": {"x": {"a": "int", "b": "int"}}}),
    ("test_lineage_all_columns_set_operation", """
        WITH u AS (SELECT a, b FROM x UNION ALL SELECT a, b FROM y)
        SELECT a, b FROM u
        """, {"schema": {"x": {"a": "int", "b": "int"}, "y": {"a": "int", "b": "int"}}}),
]

# --- test_lineage_all_columns_with_prebuilt_scope: the no-scope and prebuilt-scope
# paths must produce structurally identical dumps. Both legs are run here (not just
# compared against each other) so the cross-language diff below catches a port bug in
# EITHER path, not just a divergence between them. ---
PREBUILT_SCOPE_SQL = "SELECT a, b + 1 AS bp FROM x"
PREBUILT_SCOPE_SCHEMA = {"x": {"a": "int", "b": "int"}}
_qualified = qualify_mod.qualify(
    parse_one(PREBUILT_SCOPE_SQL), schema=PREBUILT_SCOPE_SCHEMA,
    validate_qualify_columns=False, identify=False,
)
_prebuilt_scope = build_scope(_qualified)

# --- RAISE scenarios: test_lineage_normalize's two assertRaises cases. ---
RAISE_SCENARIOS = [
    ("test_lineage_normalize_quoted_raises", '"a"',
     "WITH x AS (SELECT 1 a) SELECT a FROM x", {"dialect": "snowflake"}),
    ("test_lineage_normalize_union_by_name_raises", "b",
     "SELECT a,b FROM table1 UNION ALL BY NAME SELECT a FROM table2", {"dialect": "duckdb"}),
]

# --- test_ddl_lineage uses dialect="oracle", which this port does not implement
# (src/dialects/ has no oracle.js) -- named, counted exclusion, same shape every prior
# oracle's own unsupported-dialect skip uses, not a lineage.js-specific gap. ---
SKIPPED_UNSUPPORTED_DIALECT = ["test_ddl_lineage (dialect=oracle, not implemented by this port)"]

rows = [
    {"name": name, "column": column, "sql": sql, "kwargs": kwargs,
     "result": run_lineage(column, sql, **kwargs)}
    for name, column, sql, kwargs in SCENARIOS
]

all_columns_rows = [
    {"name": name, "sql": sql, "kwargs": kwargs, "result": run_lineage(None, sql, **kwargs)}
    for name, sql, kwargs in ALL_COLUMNS_SCENARIOS
]

prebuilt_scope_rows = [
    {"name": "test_lineage_all_columns_with_prebuilt_scope_noscope",
     "result": run_lineage(None, PREBUILT_SCOPE_SQL, schema=PREBUILT_SCOPE_SCHEMA)},
    {"name": "test_lineage_all_columns_with_prebuilt_scope_withscope",
     "result": run_lineage(None, _qualified, scope=_prebuilt_scope)},
]

raise_rows = [
    {"name": name, "column": column, "sql": sql, "kwargs": kwargs,
     "result": run_lineage(column, sql, **kwargs)}
    for name, column, sql, kwargs in RAISE_SCENARIOS
]


# --- test_copy_flag: needs real parsed AST objects (not JSON-transportable SQL
# strings) passed directly as `sql`/`sources` values, and asserts the ORIGINAL ast
# objects are/aren't mutated afterward depending on `copy`. Bespoke, not data-driven. ---
def run_copy_flag():
    out = []
    copy_schema = {"x": {"a": "int"}}

    query = parse_one("SELECT a FROM z")
    sources = {"y": parse_one("SELECT * FROM x"), "z": parse_one("SELECT * FROM y")}
    lineage(column="a", sql=query, schema=copy_schema, sources=sources, copy=False)
    out.append({
        "name": "copy_false_sources_y", "ok": sources["y"].sql(), "expected": "SELECT * FROM x",
    })
    out.append({
        "name": "copy_false_sources_z", "ok": sources["z"].sql(), "expected": "SELECT * FROM y",
    })
    out.append({
        "name": "copy_false_query_mutated", "ok": query.sql(),
        "expected": "SELECT z.a AS a FROM (SELECT y.a AS a FROM (SELECT x.a AS a FROM x AS x) "
                    "AS y /* source: y */) AS z /* source: z */",
    })

    query = parse_one("SELECT a FROM z")
    sources = {"y": parse_one("SELECT * FROM x"), "z": parse_one("SELECT * FROM y")}
    lineage(column="a", sql=query, schema=copy_schema, sources=sources, copy=True)
    out.append({"name": "copy_true_sources_y", "ok": sources["y"].sql(), "expected": "SELECT * FROM x"})
    out.append({"name": "copy_true_sources_z", "ok": sources["z"].sql(), "expected": "SELECT * FROM y"})
    out.append({"name": "copy_true_query_unmutated", "ok": query.sql(), "expected": "SELECT a FROM z"})

    query = parse_one("SELECT a FROM x")
    lineage(column="a", sql=query, schema=copy_schema, copy=False)
    out.append({
        "name": "copy_false_no_sources_query_mutated", "ok": query.sql(),
        "expected": "SELECT x.a AS a FROM x AS x",
    })

    query = parse_one("SELECT a FROM x")
    lineage(column="a", sql=query, schema=copy_schema, copy=True)
    out.append({
        "name": "copy_true_no_sources_query_unmutated", "ok": query.sql(), "expected": "SELECT a FROM x",
    })

    return out


copy_flag_rows = run_copy_flag()


# --- on_node side-channel scenarios: test_lineage_on_node_hook,
# test_lineage_on_node_orders_children_before_parents,
# test_lineage_on_node_fires_once_per_node. All three exercise the SAME callback
# mechanics, so one shared harness records every metric each test individually
# checks, run once per scenario. ---
def run_on_node_scenario(name, column, sql, kwargs):
    visited_order = []  # [id(node), ...] in call order
    visited_names = []
    call_counts = {}

    def hook(node):
        nid = id(node)
        visited_order.append(nid)
        visited_names.append(node.name)
        call_counts[nid] = call_counts.get(nid, 0) + 1
        node.payload["seen"] = True

    result = lineage(column, sql, on_node=hook, **kwargs)

    # Ground truth: walk every reachable node from every top-level result.
    roots = list(result.values()) if isinstance(result, dict) else [result]
    all_nodes = []
    seen_ids = set()
    for root in roots:
        for node in root.walk():
            if id(node) not in seen_ids:
                seen_ids.add(id(node))
                all_nodes.append(node)

    position = {nid: i for i, nid in enumerate(visited_order)}
    order_violations = 0
    for node in all_nodes:
        for child in node.downstream:
            if position.get(id(child), -1) >= position.get(id(node), -1):
                order_violations += 1

    return {
        "hook_call_count": len(visited_order),
        "unique_node_count": len(all_nodes),
        "fires_once_per_node": len(visited_order) == len(set(visited_order)),
        "all_payloads_seen": all(n.payload.get("seen") for n in all_nodes),
        "order_violations": order_violations,
        "visited_names": visited_names,
    }


ON_NODE_SCENARIOS = [
    ("test_lineage_on_node_hook", None,
     "WITH t AS (SELECT a + 1 AS v FROM x) SELECT v FROM t", {"schema": {"x": {"a": "int"}}}),
    ("test_lineage_on_node_orders_children_before_parents", None,
     "WITH t AS (SELECT a + 1 AS v FROM x) SELECT v FROM t", {"schema": {"x": {"a": "int"}}}),
    ("test_lineage_on_node_fires_once_per_node", None,
     "WITH t AS (SELECT a, b FROM x) SELECT a, a + b AS ab FROM t",
     {"schema": {"x": {"a": "int", "b": "int"}}}),
]

on_node_rows = [
    {"name": name, "result": run_on_node_scenario(name, column, sql, kwargs)}
    for name, column, sql, kwargs in ON_NODE_SCENARIOS
]

print(json.dumps({
    "rows": rows,
    "all_columns_rows": all_columns_rows,
    "prebuilt_scope_rows": prebuilt_scope_rows,
    "raise_rows": raise_rows,
    "copy_flag_rows": copy_flag_rows,
    "on_node_rows": on_node_rows,
    "skipped_unsupported_dialect": SKIPPED_UNSUPPORTED_DIALECT,
}))
