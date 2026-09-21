#!/usr/bin/env python3
"""CPython oracle for `sqlglot/optimizer/simplify.py`.

`src/optimizer/simplify.js` is a whole-file port (PORT_PLAN.md) of the single
`Simplifier` class that backs the module-level `simplify()` entry point
`normalize.js`/`pushdown_predicates.js`/`qualify_columns.js` will import later, and
that the plain generate path (`generator.py:5387` `_simplify_unless_literal`) already
needs. Unlike the AST-parsing/generation corpus this module transforms, there is no
existing `corpus/atoms.jsonl` coverage for it (it never touches `.sql()` OUTPUT text
via the corpus harvester), so this is the honest differential signal instead, following
the same recipe `spike/p7/gen_optimize_joins_ref.py` established for another greenfield
module: parse a SQL string with the REAL CPython parser, run `simplify()`, dump the
resulting `.sql()` text, and diff against this port doing the same. Any AST-shape
divergence turns into visibly different SQL text, since both sides' parsers/generators
are independently verified elsewhere (PORT_PLAN.md P3-P5).

Scenarios are grouped by the task brief's own required coverage list: boolean algebra
(NOT/AND/OR reduction, De Morgan, TRUE/FALSE absorption), comparison folding
(constant-vs-constant), arithmetic constant folding (INT/FLOAT), string concatenation
folding, COALESCE simplification, CASE/conditional simplification, BETWEEN rewriting,
date/interval arithmetic (including a month-end-clamping case), DATE_TRUNC-based range
rewrites, and a no-op round-trip case (an already-fully-simplified expression that
should come back unchanged).

    PYTHONHASHSEED=0 python3 spike/p7/gen_simplify_ref.py > spike/out/simplify.json
    node spike/p7/fuzz_simplify.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import parse_one  # noqa: E402
from sqlglot.optimizer.simplify import simplify  # noqa: E402

SCENARIOS = [
    # --- Boolean algebra: NOT/AND/OR reduction, De Morgan, TRUE/FALSE absorption ---
    ("not-demorgan-and", "SELECT NOT (a AND b)"),
    ("not-demorgan-or", "SELECT NOT (a OR b)"),
    ("not-not-boolean-type", "SELECT NOT NOT CAST(a AS BOOLEAN)"),
    ("and-true-true", "SELECT TRUE AND TRUE"),
    ("and-false-absorbs", "SELECT a AND FALSE"),
    ("or-true-absorbs", "SELECT a OR TRUE"),
    ("or-false-identity", "SELECT a OR FALSE"),
    ("and-null-and-true", "SELECT NULL AND TRUE"),
    ("or-null-or-false", "SELECT NULL OR FALSE"),
    ("not-null", "SELECT NOT NULL"),
    ("uniq-sort-dedup", "SELECT c AND a AND b AND a"),
    ("uniq-sort-connector-order", "SELECT c AND a AND b"),
    ("xor-no-dedup", "SELECT a XOR a"),
    ("absorb-a-and-a-or-b", "SELECT a AND (a OR b)"),
    ("absorb-a-or-a-and-b", "SELECT a OR (a AND b)"),
    ("eliminate-and-or", "SELECT (a AND b) OR (a AND NOT b)"),
    ("eliminate-or-and", "SELECT (a OR b) AND (a OR NOT b)"),

    # --- Comparison folding: constant-vs-constant ---
    ("eq-const-true", "SELECT 1 = 1"),
    ("eq-const-false", "SELECT 1 = 2"),
    ("neq-const", "SELECT 1 <> 2"),
    ("gt-const", "SELECT 5 > 3"),
    ("lt-const", "SELECT 3 < 5"),
    ("gte-const", "SELECT 5 >= 5"),
    ("lte-const", "SELECT 4 <= 5"),
    ("string-eq-const", "SELECT 'foo' = 'foo'"),
    ("string-lt-const", "SELECT 'abc' < 'abd'"),
    ("comparison-shared-column-lt", "SELECT x < 5 AND x < 10"),
    ("comparison-shared-column-gt-or", "SELECT x > 1 OR x > 2"),
    ("comparison-eq-vs-lt-false", "SELECT x = 5 AND x < 3"),
    ("comparison-eq-vs-neq", "SELECT x = 5 AND x <> 5"),
    ("sort-comparison-flip", "SELECT 5 > x"),

    # --- Arithmetic constant folding: INT/FLOAT ---
    ("add-int", "SELECT 1 + 2"),
    ("add-float", "SELECT 1.5 + 2.5"),
    ("add-int-float-mixed", "SELECT 1 + 2.5"),
    ("sub-int", "SELECT 10 - 3"),
    ("mul-int", "SELECT 4 * 5"),
    ("mul-float", "SELECT 2.5 * 4"),
    ("div-float", "SELECT 10.0 / 4"),
    # `div-int-not-folded` (a plain `SELECT 10 / 4`, verifying int/int Div stays
    # unfolded) is deliberately NOT a scenario here: rendering ANY surviving `exp.Div`
    # node needs the base Generator's `div_sql`, itself a pre-existing NotPorted stub
    # (`generator.py:4452`, real dialect-dependent branching -- not a one-line gap like
    # `gte_sql`/`lte_sql` above) unrelated to this file and out of scope for this PR.
    # `div-float` above already proves the FOLDING branch works (it never reaches
    # `div_sql`, since it renders as a plain literal); the not-folded branch is instead
    # covered by `test/optimizer_simplify.test.mjs`'s direct-AST unit test.
    ("neg-neg", "SELECT - -a"),
    ("tinyint-cast-removed", "SELECT CAST(1 AS TINYINT) = a"),
    ("simplify-equality-add", "SELECT x + 1 = 3"),
    ("simplify-equality-sub-inverted", "SELECT 5 - x = 2"),

    # --- String concatenation folding ---
    # `concat-literals-and-column` (`CONCAT('a', 'b', x, 'c', 'd')`, folding two
    # separate literal RUNS either side of a column) and `concat-ws-literals` are
    # deliberately NOT scenarios here: rendering a SURVIVING `exp.Concat`/`exp.ConcatWs`
    # node needs the base Generator's `concat_sql`/`concatws_sql`, both pre-existing
    # NotPorted stubs (`generator.py:3710`/`3727`, real dialect-dependent branching, not
    # one-line gaps) unrelated to this file. `concat-literals` below already proves the
    # ALL-LITERAL folding branch (it collapses to a plain string literal, never reaching
    # either stub); the mixed-literal-and-column and CONCAT_WS folding branches are
    # instead covered by `test/optimizer_simplify.test.mjs`'s direct-AST unit tests.
    ("concat-literals", "SELECT CONCAT('a', 'b', 'c')"),
    ("dpipe-literals", "SELECT 'a' || 'b' || x"),

    # --- COALESCE simplification ---
    ("coalesce-single-arg", "SELECT COALESCE(x)"),
    ("coalesce-nonnull-constant-first", "SELECT COALESCE(1, x)"),
    ("coalesce-comparison-both-constant", "SELECT COALESCE(x, 0) = 0"),

    # --- CASE/conditional simplification ---
    ("case-when-true", "SELECT CASE WHEN TRUE THEN 1 ELSE 2 END"),
    ("case-when-false-skip", "SELECT CASE WHEN FALSE THEN 1 WHEN TRUE THEN 2 ELSE 3 END"),
    ("case-all-false-default", "SELECT CASE WHEN FALSE THEN 1 ELSE 2 END"),
    ("case-all-false-no-default", "SELECT CASE WHEN FALSE THEN 1 END"),
    ("case-subject-rewrite", "SELECT CASE 1 WHEN 1 THEN 'a' WHEN 2 THEN 'b' END"),
    ("if-true", "SELECT IF(TRUE, 1, 2)"),
    ("if-false", "SELECT IF(FALSE, 1, 2)"),
    ("if-false-no-else", "SELECT IF(FALSE, 1)"),

    # --- BETWEEN rewriting ---
    ("between-basic", "SELECT x BETWEEN 1 AND 10"),
    ("between-negated", "SELECT x NOT BETWEEN 1 AND 10"),

    # --- STARTSWITH (statically known) ---
    ("startswith-true", "SELECT STARTSWITH('foobar', 'foo')"),
    ("startswith-false", "SELECT STARTSWITH('foobar', 'baz')"),

    # --- Date/interval arithmetic, including month-end clamping ---
    ("date-add-interval-month-end-clamp", "SELECT CAST('2021-01-31' AS DATE) + INTERVAL '1' MONTH"),
    ("date-add-interval-month-end-clamp-leap", "SELECT CAST('2020-01-31' AS DATE) + INTERVAL '1' MONTH"),
    ("date-sub-interval", "SELECT CAST('2021-03-31' AS DATE) - INTERVAL '1' MONTH"),
    ("date-add-interval-day", "SELECT CAST('2021-01-01' AS DATE) + INTERVAL '10' DAY"),
    ("date-add-interval-year", "SELECT CAST('2021-02-28' AS DATE) + INTERVAL '1' YEAR"),
    ("date-literal-eq-date-literal", "SELECT CAST('2021-01-01' AS DATE) = CAST('2021-01-01' AS DATE)"),
    ("date-literal-lt-date-literal", "SELECT CAST('2021-01-01' AS DATE) < CAST('2021-06-01' AS DATE)"),
    # A DATETIME literal's rendered text uses `str(datetime)`'s SPACE separator (py:
    # `datetime.__str__` == `isoformat(sep=' ')`), not `.isoformat()`'s default 'T' --
    # this scenario is what originally caught `PyDateTime.toISODateTime()` using 'T'.
    ("datetime-add-interval-minutes", "SELECT CAST('2021-01-01 10:30:00' AS DATETIME) + INTERVAL '90' MINUTE"),
    ("dateadd-function-month-end-clamp", "SELECT DATE_ADD(CAST('2021-01-31' AS DATE), 1, 'month')"),

    # --- DATE_TRUNC-based range rewrites ---
    ("datetrunc-eq-literal", "SELECT DATE_TRUNC('year', x) = CAST('2021-01-01' AS DATE)"),
    ("datetrunc-neq-literal", "SELECT DATE_TRUNC('month', x) <> CAST('2021-01-01' AS DATE)"),
    ("datetrunc-lt-literal", "SELECT DATE_TRUNC('year', x) < CAST('2021-01-01' AS DATE)"),
    ("datetrunc-gte-literal", "SELECT DATE_TRUNC('year', x) >= CAST('2021-01-01' AS DATE)"),
    ("datetrunc-in-literals", "SELECT DATE_TRUNC('month', x) IN (CAST('2021-01-01' AS DATE), CAST('2021-02-01' AS DATE))"),
    ("datetrunc-fold-literal", "SELECT DATE_TRUNC('month', CAST('2021-01-15' AS DATE))"),
    ("datetrunc-fold-quarter", "SELECT DATE_TRUNC('quarter', CAST('2021-08-15' AS DATE))"),

    # --- No-op round-trip: already-simplified expressions come back unchanged ---
    ("noop-plain-column", "SELECT x FROM t"),
    ("noop-simple-and", "SELECT a AND b"),
    ("noop-function-call", "SELECT UPPER(x)"),
    ("noop-already-minimal-comparison", "SELECT x = 1"),

    # --- WHERE/JOIN-level simplification (Simplifier.simplify's own extra passes) ---
    ("where-true-removed", "SELECT * FROM t WHERE TRUE"),
    ("where-true-and-true-removed", "SELECT * FROM t WHERE TRUE AND TRUE"),
    ("join-on-true-becomes-cross", "SELECT * FROM t1 JOIN t2 ON TRUE"),
    ("join-inner-on-true-becomes-cross", "SELECT * FROM t1 INNER JOIN t2 ON TRUE"),
]


def run_one(sql):
    try:
        ast = parse_one(sql)
        out = simplify(ast)
        return {"ok": out.sql()}
    except Exception as e:  # noqa: BLE001
        return {"error": type(e).__name__, "message": str(e)}


records = [{"name": name, "sql": sql, "result": run_one(sql)} for name, sql in SCENARIOS]

print(json.dumps({"scenarios": records}))
