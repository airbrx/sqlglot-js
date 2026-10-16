#!/usr/bin/env python3
"""CPython oracle replaying every PRQL fixture from upstream's own
`tests/dialects/test_prql.py` through `sqlglot.parse(sql, read="prql")` +
`.sql()`.

AIR-2292 (epic AIR-2272, "12.7 Small dialects", batch B). PRQL is the one
dialect in this batch with REAL grammar logic (`src/parsers/prql.js`'s pipeline-
to-SQL transform: DERIVE/SELECT/TAKE/FILTER/APPEND/REMOVE/INTERSECT/SORT/
AGGREGATE), and `gen_prql_dialect_ref.py`/`fuzz_prql_dialect.mjs` cover only the
settings surface (Tokenizer overrides, scalar settings) -- neither exercises a
single line of the parser's own methods. This file and its JS counterpart
(`fuzz_prql_pipeline.mjs`) close that gap by replaying the EXACT 29 SQL/expected
pairs upstream's `test_prql` method asserts, so a port-side defect in the
pipeline logic (the `_resolve_projection`/`aliasOrName` bug this round's own
`_parse_selection` port hit before the fix landed) would fail here even though
the differential corpus barely reaches PRQL (29 parse / 1 generate atoms per
the port brief).

    PYTHONHASHSEED=0 python3 spike/p5/gen_prql_pipeline_ref.py \
        > spike/out/prql_pipeline.json
    node spike/p5/fuzz_prql_pipeline.mjs
"""

import json
import os
import sys

sys.path.insert(0, os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref"))

import sqlglot  # noqa: E402

# Verbatim from tests/dialects/test_prql.py's `test_prql` (the only test method
# in that file) -- every `validate_all(sql, write={"": expected})` call, in
# source order.
CASES = [
    "from x",
    "from x derive a + 1",
    "from x derive x = a + 1",
    "from x derive {a + 1}",
    "from x derive {x = a + 1, b}",
    "from x derive {x = a + 1, b} select {y = x, 2}",
    "from x take 10",
    "from x take 10 take 5",
    "from x filter age > 25",
    "from x derive {x = a + 1, b} filter age > 25",
    "from x filter dept != 'IT'",
    "from x filter p == 'product' select { a, b }",
    "from x filter age > 25 filter age < 27",
    "from x filter (age > 25 && age < 27)",
    "from x filter (age > 25 || age < 27)",
    "from x filter (age > 25 || age < 22) filter age > 26 filter age < 27",
    "from x sort age",
    "from x sort {-age}",
    "from x sort {age, name}",
    "from x sort {-age, +name}",
    "from x append y",
    "from x remove y",
    "from x intersect y",
    "from x filter a == null filter null != b",
    "from x filter (a > 1 || null != b || c != null)",
    "from a aggregate { average x }",
    "from a aggregate { average x, min y, ct = sum z }",
    "from a aggregate { average x, min y, sum z }",
    "from a aggregate { min y, b = stddev x, max z }",
]

rows = []
for sql in CASES:
    try:
        parsed = sqlglot.parse(sql, read="prql")
        out = parsed[0].sql()
        rows.append({"sql": sql, "out": out})
    except Exception as e:  # noqa: BLE001
        rows.append({"sql": sql, "error": f"{type(e).__name__}: {e}"})

print(json.dumps(rows, indent=1))
