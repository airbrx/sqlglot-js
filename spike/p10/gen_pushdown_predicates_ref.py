#!/usr/bin/env python3
"""CPython oracle for `sqlglot/optimizer/pushdown_predicates.py`.

Like `normalize.py` (`gen_normalize_ref.py`, R68) this is NOT greenfield: upstream
ships a real declarative corpus, `tests/fixtures/optimizer/pushdown_predicates.sql`
(56 SQL/expected pairs), consumed by `TestOptimizer.test_pushdown_predicates`
(`tests/test_optimizer.py:1391`):

    def test_pushdown_predicates(self):
        self.check_file("pushdown_predicates", optimizer.pushdown_predicates.pushdown_predicates)

Unlike `normalize.py`, `check_file` is handed `pushdown_predicates` DIRECTLY as `func`
with no wrapper -- `tests/test_optimizer.py`'s own module-level helpers (`normalize`,
`simplify`, `qualify_columns`, ...) have no `pushdown_predicates` entry, so
`parse_and_optimize` (test_optimizer.py:29-30) calls it exactly as
`pushdown_predicates(parse_one(sql, read=dialect), dialect=dialect)`, then
`.sql(dialect=dialect)`. This oracle reproduces that exact (and simpler-than-
normalize's) two-step pipeline.

Six of the 56 pairs are gated behind `# dialect: presto|trino|athena` (two pairs each)
and exercise `unnest_requires_cross_join` (py:41 `isinstance(dialect, (Athena,
Presto))`) -- the special case where Presto-family dialects can't push a predicate
into an UNNEST's CROSS JOIN. None of Presto, Trino or Athena are ported in this JS
codebase yet (no `src/dialects/{presto,trino,athena}.js`), so `parse_one(sql,
read="presto")` already fails at the FIRST step on the JS side, independently of
`pushdown_predicates.js` itself -- the same "real parser/generator can't yet reach
this scenario" situation R51's typing overlays document, not a `pushdown_predicates.js`
defect. Those 6 pairs are captured here (so the CPython-side expectation is on record)
but flagged `"dialect_unported": true"` so the JS fuzzer can skip them with a named
reason instead of counting them as ERROR.

    python3 spike/p10/gen_pushdown_predicates_ref.py > spike/out/pushdown_predicates.json
    node spike/p10/fuzz_pushdown_predicates.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-complete-pin")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot import parse_one  # noqa: E402
from sqlglot.optimizer.pushdown_predicates import pushdown_predicates  # noqa: E402

# Mirrors `tests/helpers._filter_comments`/`_extract_meta`/`load_sql_fixture_pairs`
# directly (see `gen_normalize_ref.py`'s identical note) rather than importing the
# `tests` package.


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


UNPORTED_DIALECTS = {"presto", "trino", "athena"}


def pushdown_pipeline(sql, dialect):
    expression = parse_one(sql, read=dialect)
    optimized = pushdown_predicates(expression, dialect=dialect)
    return optimized.sql(dialect=dialect)


results = {"fixtures": []}

fixture_path = os.path.join(REF, "tests/fixtures/optimizer/pushdown_predicates.sql")
for i, (meta, sql, expected) in enumerate(load_sql_fixture_pairs(fixture_path), start=1):
    dialect = meta.get("dialect")
    row = {"id": i, "sql": sql, "dialect": dialect, "expected": expected}
    if dialect in UNPORTED_DIALECTS:
        row["dialect_unported"] = True
    try:
        row["computed"] = pushdown_pipeline(sql, dialect)
    except Exception as e:  # noqa: BLE001 -- oracle: capture, don't crash the harness
        row["error"] = str(e)
    results["fixtures"].append(row)

print(json.dumps(results, indent=2))
