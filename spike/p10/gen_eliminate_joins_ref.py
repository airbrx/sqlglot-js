#!/usr/bin/env python3
"""CPython oracle for `sqlglot/optimizer/eliminate_joins.py`.

Unlike the P7 "greenfield, no fixture" optimizer modules (`optimize_joins.js`,
`resolver.js`, `unnest_subqueries.js`), `eliminate_joins.py` has a real upstream
fixture corpus — `tests/fixtures/optimizer/eliminate_joins.sql` (18 SQL/expected
pairs) — consumed by `TestOptimizer.test_eliminate_joins` via `check_file`
(`tests/test_optimizer.py:1461-1466`):

    def test_eliminate_joins(self):
        self.check_file("eliminate_joins", optimizer.eliminate_joins.eliminate_joins, pretty=True)

Unlike `normalize.py`'s own `check_file` call (P10/R68's oracle), this one passes NO
`schema=` kwarg and the fixture file carries no `# dialect:`/`# leave_tables_isolated:`
meta lines (checked directly against the fixture — every pair has only `# title:`), so
`check_file`'s wrapper (`tests/test_optimizer.py:178-236`, `parse_and_optimize` at
line 29-30) reduces to exactly `eliminate_joins(parse_one(sql)).sql(pretty=True)`, with
no `annotate_types`/`simplify`/`qualify` dressing the way `normalize.py`'s test needs.
This oracle reproduces that bare pipeline.

Also captures, directly against `optimizer.eliminate_joins.join_condition` — the one
other PUBLIC symbol this module exports (upstream `planner.py` is its only other
caller, out of this port's scope) — three scenarios exercising its CNF branch (plain
AND of EQs), its DNF branch (`normalized(on, dnf=True)`, OR of AND-of-EQ groups), and
the default fallthrough (neither CNF nor DNF, e.g. a bare OR of non-EQ predicates)
that upstream's own `_should_eliminate_join`/`_is_joined_on_all_unique_outputs` never
exercises through the fixture corpus alone.

Like `gen_normalize_ref.py`, this script's DEFAULT `SQLGLOT_REF` is the COMPLETE
checkout, not the lean one: `/tmp/sqlglot-ref`'s `tests/fixtures/optimizer/` only
carries `tpc-ds`/`tpc-h`, no `eliminate_joins.sql`.

    python3 spike/p10/gen_eliminate_joins_ref.py > spike/out/eliminate_joins.json
    node spike/p10/fuzz_eliminate_joins.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-complete-pin")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import parse_one  # noqa: E402
from sqlglot.optimizer.eliminate_joins import eliminate_joins, join_condition  # noqa: E402

# Mirrors `tests/helpers._filter_comments`/`_extract_meta`/`load_sql_fixture_pairs`
# directly rather than importing the `tests` package, so this script has no
# import-path dependency on how the pinned checkout's own test suite is laid out.


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


def load_sql_fixture_pairs(path):
    with open(path, encoding="utf-8") as f:
        statements = _filter_comments(f.read()).split(";")
    size = len(statements)
    for i in range(0, size, 2):
        if i + 1 < size:
            sql = statements[i].strip()
            sql, meta = _extract_meta(sql)
            expected = statements[i + 1].strip()
            yield meta, sql, expected


results = {"fixtures": [], "join_condition": []}

fixture_path = os.path.join(REF, "tests/fixtures/optimizer/eliminate_joins.sql")
for i, (meta, sql, expected) in enumerate(load_sql_fixture_pairs(fixture_path), start=1):
    assert not meta or set(meta) == {"title"}, f"unexpected fixture meta: {meta}"
    try:
        computed = eliminate_joins(parse_one(sql)).sql(pretty=True)
        results["fixtures"].append(
            {"id": i, "title": meta.get("title"), "sql": sql, "expected": expected, "computed": computed}
        )
    except Exception as e:  # noqa: BLE001 -- oracle: capture, don't crash the harness
        results["fixtures"].append(
            {"id": i, "title": meta.get("title"), "sql": sql, "expected": expected, "error": str(e)}
        )

# `join_condition` scenarios covering its three branches: CNF (plain AND of EQs), DNF
# (OR of AND-of-EQ groups), and the fallthrough where `on` is neither CNF nor DNF --
# verified directly against `normalize.normalized` that each case lands in the branch
# its name claims (e.g. "cnf-or-vacuous" is a bare OR with no AND inside it, which is
# vacuously CNF per `normalized`'s own definition: no And node has an Or ancestor
# because there is no And node at all). The fixture corpus above never reaches any of
# this because every eliminable join there is either a plain `a.x = b.y [AND ...]` or
# absent.
JOIN_CONDITION_CASES = [
    ("cnf-single-eq", "SELECT * FROM x JOIN y ON x.a = y.b"),
    ("cnf-eq-and-extra", "SELECT * FROM x JOIN y ON x.a = y.b AND y.b > 1"),
    ("cnf-multi-eq", "SELECT * FROM x JOIN y ON x.a = y.a AND x.b = y.b"),
    ("dnf-or-of-and-eq", "SELECT * FROM x JOIN y ON (x.a = y.a AND x.b = y.b) OR (x.a = y.a AND x.c = y.c)"),
    ("cnf-or-vacuous", "SELECT * FROM x JOIN y ON x.a > y.a OR x.b < y.b"),
    ("fallthrough-neither", "SELECT * FROM x JOIN y ON (x.a = y.a OR (x.b = y.b AND x.c = y.c)) AND x.d = y.d"),
    ("no-on-clause", "SELECT * FROM x CROSS JOIN y"),
]
for name, sql in JOIN_CONDITION_CASES:
    join = parse_one(sql).args["joins"][0]
    try:
        source_key, join_key, on = join_condition(join)
        results["join_condition"].append(
            {
                "name": name,
                "sql": sql,
                "source_key": [e.sql() for e in source_key],
                "join_key": [e.sql() for e in join_key],
                "on": on.sql(),
            }
        )
    except Exception as e:  # noqa: BLE001
        results["join_condition"].append({"name": name, "sql": sql, "error": str(e)})

print(json.dumps(results, indent=2))
