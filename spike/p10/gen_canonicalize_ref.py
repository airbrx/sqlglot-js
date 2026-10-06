#!/usr/bin/env python3
"""CPython oracle for `sqlglot/optimizer/canonicalize.py` (AIR-2117).

`canonicalize` is NOT reachable via a bare `canonicalize(parse_one(sql))` for most of
its own real fixture corpus (`tests/fixtures/optimizer/canonicalize.sql`, consumed by
`TestOptimizer.test_canonicalize`) -- most scenarios rely on `annotate_types` having
already run (to know, e.g., that `w.d`/`w.e` are TEXT columns) and on `qualify_columns`
having already resolved bare column refs to a real table (so `annotate_types` can look
their type up in the schema at all -- see `optimizer/annotate_types.py:475`, `if scope
and isinstance(expr, exp.Column) and expr.table`). Upstream's own pipeline is

    optimizer.optimize(sql, rules=[qualify, quote_identifiers, annotate_types, canonicalize], ...)

This oracle reproduces that EXACTLY (not a reduced substitute -- `optimizer/qualify.py`,
the `qualify()` orchestrator, and `quote_identifiers` both landed for real on `main`
after this round started -- AIR-2108/AIR-2107, R73/R75 -- so both are real ported
functions now, not gaps), and asserts the result against the real fixture file's own
quoted "expected" text directly, not just a JS-vs-CPython differential on a reduced
pipeline. The JS side (`fuzz_canonicalize.mjs`) runs the equivalent composition using
`qualify()`/`annotate_types()`/`canonicalize()` directly (there is no JS
`optimizer.optimize()` orchestrator yet -- out of scope here, same as every other P10
module's own oracle shape).

A real, pre-existing gap this oracle's own first fixture row immediately surfaced (not
previously known, not assumed): the BASE `Generator.concat_sql` (generator.py:3710) and
its own `convert_concat_args` helper (generator.py:3679) are `NotPorted` stubs in
`src/generator.js` -- nothing in this port before `canonicalize.js` ever constructed a
bare `exp.Concat` node and asked the base (non-dialect-overridden) Generator to render
it. This blocks `.sql()` on ANY `exp.Concat`-producing scenario, project-wide, not just
ones canonicalize.js itself creates. A second, same-shape gap surfaced immediately
after: base `Generator.dateadd_sql` (generator.py:5249), hit by any `DATE_ADD(...)`
fixture -- unrelated to canonicalize.js's own logic (`coerce_type` only casts an
*argument* of an already-existing `DateAdd` node, never the node that fails to render).
Per this round's own task brief ("record it in PORT_PLAN.md rather than working around
it"), scenarios hitting either gap are verified by a STRUCTURAL fingerprint (DFS
preorder class name + sorted scalar args) instead of `.sql()` text -- exactly as strict
a check of canonicalize.js's own logic, since both languages' `dfs()`/parsers have
already been independently verified elsewhere in this port, without depending on the
broken generator path at all.

Two of the real fixture's pairs are gated `# dialect: mysql`; `mysql.js` does not exist
in this port yet, so `parseOne(sql, { read: "mysql" })` already fails at the FIRST step
on the JS side, independently of `canonicalize.js` -- same shape
`gen_pushdown_predicates_ref.py` (R71) already documents for Presto/Trino/Athena.
Recorded here (dialect on record) so the JS fuzzer can skip them by name rather than
counting them as ERROR.

    python3 spike/p10/gen_canonicalize_ref.py > spike/out/canonicalize.json
    node spike/p10/fuzz_canonicalize.mjs
"""
import json
import os
import sys
from functools import partial

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-complete-pin")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import exp, optimizer, parse_one  # noqa: E402
from sqlglot.optimizer.annotate_types import annotate_types  # noqa: E402
from sqlglot.optimizer.canonicalize import canonicalize  # noqa: E402
from sqlglot.optimizer.qualify import qualify  # noqa: E402
from sqlglot.optimizer.qualify_columns import quote_identifiers  # noqa: E402

# Mirrors `tests/helpers.py`'s own `self.schema` (test_optimizer.py:132), trimmed to the
# tables this fixture file actually touches.
SCHEMA = {
    "x": {"a": "INT", "b": "INT"},
    "w": {"d": "TEXT", "e": "TEXT"},
    "temporal": {"d": "DATE", "t": "DATETIME"},
}

# test_optimizer.py:1849-1858 `test_canonicalize`'s own exact `optimize` partial.
optimize = partial(
    optimizer.optimize,
    rules=[qualify, quote_identifiers, annotate_types, canonicalize],
)


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


def scenario(name, sql, dialect=None, bare=False, expected=None, schema=SCHEMA):
    try:
        if bare:
            ast = canonicalize(parse_one(sql, read=dialect), dialect=dialect)
        else:
            ast = optimize(parse_one(sql, read=dialect), schema=schema, dialect=dialect)
    except Exception as e:  # noqa: BLE001 -- recorded, not raised, so JS can compare
        return {"name": name, "sql": sql, "dialect": dialect, "error": f"{type(e).__name__}: {e}"}

    output = ast.sql(dialect=dialect)
    if expected is not None:
        # Self-check: this oracle's own pipeline must reproduce the real fixture's
        # documented expectation byte for byte, or the oracle itself -- not
        # canonicalize.js -- is wrong.
        assert output == expected, f"{name}: oracle pipeline != fixture expected\n  got:      {output}\n  expected: {expected}"

    # Always record BOTH a structural fingerprint and the real rendered SQL. CPython's
    # generator always succeeds; the JS side falls back to the fingerprint on a
    # `NotPorted` base-Generator gap (see this file's own header -- `concat_sql` and
    # `dateadd_sql`) without that being treated as a real mismatch.
    return {
        "name": name,
        "sql": sql,
        "dialect": dialect,
        "bare": bare,
        "fingerprint": fingerprint(ast),
        "output": output,
    }


results = []

fixture_path = os.path.join(REF, "tests/fixtures/optimizer/canonicalize.sql")
for i, (meta, sql, expected) in enumerate(load_pairs(fixture_path), start=1):
    results.append(scenario(f"fixture-{i}", sql, meta.get("dialect"), expected=expected))

# test_optimizer.py:1849 test_canonicalize's own two inline (non-fixture-file)
# assertions. The first (TSQL CONCAT, transpiled to postgres `||`) is reproduced through
# the SAME `optimize()` pipeline, rendered for the `dialect="tsql"` READ side (this
# oracle's own `output`/`fingerprint` contract always renders with the scenario's own
# read dialect, matching every other row here -- the postgres TRANSPILE half of
# upstream's own assertion is a pure generation-side concern already covered elsewhere
# in this port's own dialect-generate ratchet, not specific to canonicalize.js).
# `schema=None` matches upstream's own call EXACTLY -- unlike every fixture-file row
# above, this inline assertion does NOT pass `schema=self.schema` (table "t" is not in
# it anyway), so `qualify_columns` infers an empty schema and does not require "a"/"b"
# to resolve against a known table (confirmed: passing SCHEMA here raises
# `OptimizeError: Column 'a' could not be resolved`, which upstream's own call does not).
results.append(scenario("tsql-concat", "SELECT CAST(a AS TEXT) + CAST(b AS TEXT) FROM t", "tsql", schema=None))

# This one upstream calls with NO qualify/annotate_types at all -- the robustness fix
# for `_coerce_datediff_args` crashing on a `None` type -- reproduced literally (`bare`),
# with its own literal expected string from the test asserted the same way as above.
results.append(scenario(
    "datediff-no-annotate", "SELECT DATEDIFF(a, b) FROM t", bare=True,
    expected="SELECT DATEDIFF(CAST(a AS DATETIME), CAST(b AS DATETIME)) FROM t",
))

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
