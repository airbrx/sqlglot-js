#!/usr/bin/env python3
"""CPython oracle for `sqlglot/optimizer/canonicalize.py` (AIR-2117).

Unlike `pushdown_predicates`/`eliminate_joins` (R71/R72), `canonicalize` is NOT
reachable via a bare `canonicalize(parse_one(sql))` for most of its own real fixture
corpus (`tests/fixtures/optimizer/canonicalize.sql`, consumed by
`TestOptimizer.test_canonicalize`) -- upstream's own pipeline is

    optimizer.optimize(sql, rules=[qualify, quote_identifiers, annotate_types, canonicalize], ...)

and most scenarios rely on `annotate_types` having already run (to know, e.g., that
`w.d`/`w.e` are TEXT columns) and on `qualify_columns` having already resolved bare
column refs to a real table (so `annotate_types` can look their type up in the schema
at all -- see `optimizer/annotate_types.py:475`, `if scope and isinstance(expr,
exp.Column) and expr.table`). Reproducing upstream's test wrapper EXACTLY is not
possible on the JS side, though: `optimizer/qualify.py` (the `qualify()` orchestrator)
and `quote_identifiers` (`optimizer/qualify_columns.py:1288`) are BOTH real, deliberate,
already-documented gaps in this port (`qualify_columns.js`'s own header: "deliberately
NOT ported here -- AIR-2107/AIR-2108, separate follow-up issues"), so there is no JS
`qualify()` to call.

This oracle therefore runs a REDUCED pipeline, calling each of qualify()'s own
constituent steps directly in its exact order (qualify.py:81-99), skipping only the
two unported ones (`quote_identifiers`, `validate_qualify_columns` -- both pure
generation/validation, no effect on canonicalize's own logic or AST shape):

    normalize_identifiers -> qualify_tables -> isolate_table_selects
        -> qualify_columns -> annotate_types -> canonicalize

run IDENTICALLY on both the CPython and JS sides (see `fuzz_canonicalize.mjs`), so this
is a pure JS-vs-CPython differential on the REAL functions, not a comparison against the
fixture file's own "expected" text (which bakes in `quote_identifiers`'s quoting and so
would spuriously mismatch on quoting alone, independent of any real canonicalize.js
defect).

A second, real, pre-existing gap this oracle's own first fixture row immediately
surfaced (not previously known, not assumed): the BASE `Generator.concat_sql`
(generator.py:3710) and its own `convert_concat_args` helper (generator.py:3679) are
`NotPorted` stubs in `src/generator.js` -- nothing in this port before `canonicalize.js`
ever constructed a bare `exp.Concat` node and asked the base (non-dialect-overridden)
Generator to render it. This blocks `.sql()` on ANY `exp.Concat`-producing scenario,
project-wide, not just ones canonicalize.js itself creates. Per this round's own task
brief ("record it in PORT_PLAN.md rather than working around it"), scenarios where
`add_text_to_concat` actually fires are verified by a STRUCTURAL fingerprint (DFS
preorder class-name list) instead of `.sql()` text -- exactly as strict a check of
canonicalize.js's own logic, Since both languages' `dfs()`/parsers have already been
independently verified elsewhere in this port, without depending on the broken
generator path at all.

Two of the real fixture's 35 pairs are gated `# dialect: mysql`; `mysql.js` does not
exist in this port yet, so `parse_one(sql, read="mysql")` already fails at the FIRST
step on the JS side, independently of `canonicalize.js` -- same shape
`gen_pushdown_predicates_ref.py` (R71) already documents for Presto/Trino/Athena.
Recorded here (dialect on record) so the JS fuzzer can skip them by name rather than
counting them as ERROR.

    python3 spike/p10/gen_canonicalize_ref.py > spike/out/canonicalize.json
    node spike/p10/fuzz_canonicalize.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-complete-pin")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import exp, parse_one  # noqa: E402
from sqlglot.optimizer.annotate_types import annotate_types  # noqa: E402
from sqlglot.optimizer.canonicalize import canonicalize  # noqa: E402
from sqlglot.optimizer.isolate_table_selects import isolate_table_selects  # noqa: E402
from sqlglot.optimizer.normalize_identifiers import normalize_identifiers  # noqa: E402
from sqlglot.optimizer.qualify_columns import qualify_columns  # noqa: E402
from sqlglot.optimizer.qualify_tables import qualify_tables  # noqa: E402

# Mirrors `tests/helpers.py`'s own `self.schema` (test_optimizer.py:132), trimmed to the
# tables this fixture file actually touches.
SCHEMA = {
    "x": {"a": "INT", "b": "INT"},
    "w": {"d": "TEXT", "e": "TEXT"},
    "temporal": {"d": "DATE", "t": "DATETIME"},
}


# Mirrors `tests/helpers.py`'s `_filter_comments`/`_extract_meta`/`load_sql_fixture_pairs`
# directly (same recipe `gen_pushdown_predicates_ref.py`/`gen_normalize_ref.py` already
# use), rather than importing the `tests` package.
def _filter_comments(s):
    return "\n".join(line for line in s.splitlines() if line and not line.startswith("--"))


def _extract_meta(sql):
    meta = {}
    lines = sql.split("\n")
    i = 0
    while lines[i].startswith("#"):
        key, val = lines[i].split(":", maxsplit=1)
        meta[key.lstrip("#").strip()] = val.strip()
        i += 1
    return "\n".join(lines[i:]), meta


def load_pairs(path):
    with open(path, encoding="utf-8") as f:
        statements = _filter_comments(f.read()).split(";")
    size = len(statements)
    for i in range(0, size, 2):
        if i + 1 < size:
            sql = statements[i].strip()
            sql, meta = _extract_meta(sql)
            expected = statements[i + 1].strip()
            yield meta, sql, expected


def fingerprint(ast):
    # (class name, sorted scalar-only args) per node, DFS preorder. Scalar-only
    # (str/int/float/bool/None) deliberately excludes child `Expr`/list-of-`Expr`
    # values -- those are already independently represented by the surrounding DFS
    # traversal itself -- but DOES catch a node's own flags (e.g. `Concat.coalesce`,
    # `Ordered.desc`), which a bare class-name list would silently miss. Caught by a
    # scoped-revert adversarial check before trusting this: flipping
    # `add_text_to_concat`'s `coalesce: False` to `True` was NOT detected by a
    # class-name-only fingerprint (same shape, different flag) and IS detected once
    # scalar args are included.
    out = []
    for n in ast.dfs():
        scalars = {
            k: v for k, v in n.args.items() if v is None or isinstance(v, (str, int, float, bool))
        }
        out.append([type(n).__name__, {k: scalars[k] for k in sorted(scalars)}])
    return out


def run_pipeline(sql, dialect):
    ast = parse_one(sql, read=dialect)
    ast = normalize_identifiers(ast, dialect=dialect, store_original_column_identifiers=True)
    ast = qualify_tables(ast, dialect=dialect)
    ast = isolate_table_selects(ast, schema=SCHEMA)
    ast = qualify_columns(ast, SCHEMA, dialect=dialect)
    ast = annotate_types(ast, schema=SCHEMA, dialect=dialect)
    ast = canonicalize(ast, dialect=dialect)
    return ast


def scenario(name, sql, dialect=None, bare=False):
    try:
        ast = parse_one(sql, read=dialect) if bare else run_pipeline(sql, dialect)
        if bare:
            ast = canonicalize(ast, dialect=dialect)
    except Exception as e:  # noqa: BLE001 -- recorded, not raised, so JS can compare
        return {"name": name, "sql": sql, "dialect": dialect, "error": f"{type(e).__name__}: {e}"}

    # Always record BOTH a structural fingerprint and the real rendered SQL. CPython's
    # generator always succeeds; the JS side falls back to the fingerprint on a
    # `NotPorted` base-Generator gap (see this file's own header -- `concat_sql` and, as
    # it turns out, `dateadd_sql` too) without that being treated as a real mismatch.
    return {
        "name": name,
        "sql": sql,
        "dialect": dialect,
        "bare": bare,
        "fingerprint": fingerprint(ast),
        "output": ast.sql(dialect=dialect),
    }


results = []

fixture_path = os.path.join(REF, "tests/fixtures/optimizer/canonicalize.sql")
for i, (meta, sql, _expected) in enumerate(load_pairs(fixture_path), start=1):
    results.append(scenario(f"fixture-{i}", sql, meta.get("dialect")))

# test_optimizer.py:1849 test_canonicalize's own two inline (non-fixture-file)
# assertions, reproduced directly rather than via the full optimize()/dialect-transpile
# wrapper the real test uses (same reduced-pipeline substitution as above):
results.append(scenario("tsql-concat", "SELECT CAST(a AS TEXT) + CAST(b AS TEXT) FROM t", "tsql"))

# This one upstream calls with NO qualify/annotate_types at all -- the robustness fix
# for `_coerce_datediff_args` crashing on a `None` type -- reproduced literally (`bare`).
results.append(scenario("datediff-no-annotate", "SELECT DATEDIFF(a, b) FROM t", bare=True))

# Own scenarios: `remove_ascending_order` has NO coverage anywhere in the real upstream
# test suite (confirmed by grep -- `remove_ascending_order` appears only inside
# `canonicalize.py` itself), so this project's established practice for untested units
# (R45's resolver oracle, R54's annotate_types battery) applies: hand-authored coverage
# for all three `ORDER BY` modifier shapes (ASC explicitly removed, DESC left alone,
# bare/unspecified left alone).
for name, sql in [
    ("order-asc", "SELECT a FROM x ORDER BY a ASC"),
    ("order-desc", "SELECT a FROM x ORDER BY a DESC"),
    ("order-bare", "SELECT a FROM x ORDER BY a"),
]:
    results.append(scenario(name, sql))

# Own scenarios covering COERCIBLE_DATE_OPS members the real fixture corpus never
# exercises at all (no BETWEEN, EQ/NEQ, GTE/LTE, or NullSafeEQ/NullSafeNEQ scenario
# anywhere in canonicalize.sql -- only Add/GT/LT are real-fixture-covered).
for name, sql in [
    ("between-date", "SELECT t.d BETWEEN '2023-01-01' AND '2023-01-02' FROM temporal AS t"),
    ("eq-date", "SELECT t.d = '2023-01-01' FROM temporal AS t"),
    ("neq-date", "SELECT t.d <> '2023-01-01' FROM temporal AS t"),
    ("gte-date", "SELECT t.d >= '2023-01-01' FROM temporal AS t"),
    ("lte-date", "SELECT t.d <= '2023-01-01' FROM temporal AS t"),
    ("nullsafe-eq-date", "SELECT t.d <=> '2023-01-01' FROM temporal AS t"),
]:
    results.append(scenario(name, sql))

print(json.dumps(results))
