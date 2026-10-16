# Optimizer fixture-pair rollup (AIR-2295)

> AIR-1864's exit criterion reads "3,476 optimizer fixture pairs green (201
> `# execute: true` permanently wontfix)". No session ever produced that number — it
> was an early plan-time estimate, never measured against the real corpus or the real
> `check_file` semantics. **Both halves of it are wrong at this pin.** This document
> is the actual measurement, produced by `tools/fixture_rollup.mjs`, which anyone can
> re-run.

Measured 2026-10-15, branch based on `origin/main` `a5fceb1` and merged forward to
`2309ae7` (PRs #110/#111/#112 landed concurrently), against pinned upstream
`91119bcaac977ede6f4a641bdda593b0015ef998` (`/tmp/sqlglot-complete-pin`). Runtime: Node
22.12.0, CPython 3.9.25, `PYTHONHASHSEED=0`. No `src/` changes from this round itself —
this is a measurement-only round (epic AIR-2273, "finish-line hygiene"); the concurrent
merge did touch `src/` (R91-R93), which is why one table cell below (`qualify_tables.sql`)
differs from this round's own first measurement — see PORT_PLAN.md's R95 entry.

```
SQLGLOT_REF=/tmp/sqlglot-complete-pin node tools/fixture_rollup.mjs             # human-readable
SQLGLOT_REF=/tmp/sqlglot-complete-pin node tools/fixture_rollup.mjs --markdown  # this table
```

The script assumes `spike/out/*.json` is fresh (produced by `bash spike/run_all.sh`
or the individual `gen_*_ref.py` scripts) — it only re-runs the fast Node half of each
oracle and parses its printed counters, which is what keeps it well under a minute
instead of the multi-minute full suite. A missing/stale ref JSON is reported per-row
as `MISSING spike/out ref JSON`, not silently skipped.

## Why "3,476 / 201" is wrong

**The pair-counting rule.** A "pair" is **not** one `# title:` block. It is upstream's
own `tests/helpers.py:load_sql_fixture_pairs`: drop `--` comment lines and blank lines,
split the remaining text on `;`, then group the resulting statements two at a time
(`sql`, `expected`). Meta lines (`# title:`, `# dialect:`, `# execute:`, ...) are parsed
off the front of the **first** statement in each pair and do not, by themselves, start
or end a pair.

**The `execute` mechanism** (`tests/test_optimizer.py:224`, inside `check_file`):

```python
execute if meta.get("execute") is None else False
```

A pair's `execute` meta **value** is never read. The mere **presence** of an `execute`
key forces that pair's execution sub-check to `False`, regardless of what the key says
— the committed corpus has 200 lines reading `# execute: false` and exactly one reading
`# execute: true`, and neither spelling matters. And `execute` only does anything at
all in the three fixture files whose own `check_file(...)` call site passes
`execute=True`: `optimizer.sql` (`test_optimizer.py:267`), `qualify_columns.sql`
(`:777`), and `merge_subqueries.sql` (`:1571`). Every other file's `# execute:` lines
are inert decoration, since `execute=False` is already `check_file`'s own default.

The real wontfix population is therefore "pairs in those 3 files with no `execute` meta
key at all" — **259**, not 201. The real total pair count across every fixture file
`tests/test_optimizer.py` actually loads is **3,589**, not 3,476. (A 26th file,
`qualify_columns__invalid.sql`, is loaded with the line-based `load_sql_fixtures`, not
the pair-based loader — it holds 20 independent SQL statements, each asserted to raise
`OptimizeError`/`SchemaError`. It has no "expected output" half and is outside the pair
model entirely; its count is reported separately, not folded into the 3,589.)

Neither error is large relative to the plan's other since-corrected estimates (the
atom-closure figures in PORT_PLAN.md §3.2 were similarly revised after being measured
for real), but neither was ever revisited for the optimizer fixtures specifically until
now.

## The rollup

| fixture file | pairs | replayed by | result | wontfix (execute) | notes |
|---|---|---|---|---|---|
| `annotate_functions.sql` | 1932 | **none** | — | 0 | no oracle in spike/p7 or spike/p10 opens this file (verified: zero `fixtures/optimizer` or `load_sql_fixture` hits naming it). 1,932 pairs -- the single largest fixture file by pair count, one function-call/expected-type-string pair per line pair. |
| `annotate_types.sql` | 71 | **none** | — | 0 | no oracle opens this file. The 6 spike/p7 `fuzz_annotate_types*.mjs`/`gen_annotate_types*_ref.py` files are named after the same TypeAnnotator surface but ship their own independent, hand-written corpora -- none loads `annotate_types.sql`. |
| `canonicalize.sql` | 42 | `spike/p10/fuzz_canonicalize.mjs` | EXACT 51  GENERATOR_GAP 0  MISMATCH 0  ERROR 0  SKIPPED 2 | 0 | oracle adds 11 own hand-written scenarios beyond the 42 fixture pairs (tsql-concat, datediff-no-annotate, 3 ORDER BY shapes, 6 COERCIBLE_DATE_OPS shapes) -- EXACT/SKIPPED above cover all 53, not 42 alone |
| `canonicalize_internal_names.sql` | 65 | **none** | — | 0 | no oracle opens this file, despite being used for real by `test_canonicalize_internal_names`'s own `self.check_file(...)` call (test_optimizer.py:1583) |
| `eliminate_ctes.sql` | 6 | **none** | — | 0 | `spike/p7/fuzz_eliminate_ctes.mjs` is greenfield (own docstring) -- no corpus tie-in, does not load this file |
| `eliminate_joins.sql` | 18 | `spike/p10/fuzz_eliminate_joins.mjs` | EXACT 25  MISMATCH 0  ERROR 0 | 0 | oracle adds 7 own `join_condition` branch-coverage scenarios beyond the 18 fixture pairs -- EXACT above covers all 25, not 18 alone |
| `eliminate_subqueries.sql` | 27 | **none** | — | 0 | `spike/p7/fuzz_eliminate_subqueries.mjs` is greenfield -- does not load this file |
| `isolate_table_selects.sql` | 8 | **none** | — | 0 | `spike/p7/fuzz_isolate_table_selects.mjs` is greenfield -- does not load this file |
| `merge_subqueries.sql` | 86 | `spike/p10/fuzz_optimize_e2e.mjs` | EXACT 86  GENERATOR_GAP 0  MISMATCH 0  ERROR 0  SKIPPED 0 | 81 | replayed by the Track-2 end-to-end gate (AIR-2119), not by `spike/p7/fuzz_merge_subqueries.mjs` (hand-built, does not load this file) |
| `normalize.sql` | 17 | `spike/p10/fuzz_normalize.mjs` | EXACT 23  MISMATCH 0  ERROR 0 | 0 | oracle adds 3 inline `test_normalize` assertions + 3 `test_normalization_distance` scenarios beyond the 17 fixture pairs -- EXACT above covers all 23, not 17 alone |
| `normalize_identifiers.sql` | 30 | **none** | — | 0 | no oracle opens this file |
| `optimize_joins.sql` | 18 | **none** | — | 0 | `spike/p7/fuzz_optimize_joins.mjs` ships its own 28-row hand-written corpus (PORT_PLAN.md R45) -- does not load this 18-pair file |
| `optimizer.sql` | 82 | `spike/p10/fuzz_optimizer.mjs` | EXACT 80  GENERATOR_GAP 1  MISMATCH 0  ERROR 0  SKIPPED 2 | 30 | oracle adds 1 inline `test_optimize` assertion beyond the 82 fixture pairs -- EXACT/GAP/SKIPPED above cover all 83, not 82 alone |
| `pushdown_cte_alias_columns.sql` | 6 | **none** | — | 0 | no oracle opens this file |
| `pushdown_predicates.sql` | 32 | `spike/p10/fuzz_pushdown_predicates.mjs` | EXACT 26  MISMATCH 0  ERROR 0  SKIPPED 6 | 0 | |
| `pushdown_projections.sql` | 74 | `spike/p10/fuzz_pushdown_projections.mjs` | EXACT 74  MISMATCH 0  ERROR 0 | 0 | |
| `qualify_columns.sql` | 292 | `spike/p10/fuzz_qualify.mjs` | EXACT 265  KNOWN_GAP 12  MISMATCH 0  ERROR 0 | 148 | |
| `qualify_columns__invalid.sql` | 20 (lines, not pairs) | `spike/p10/fuzz_qualify.mjs` | EXACT 21  KNOWN_GAP 0  MISMATCH 0  ERROR 0 | 0 | oracle adds 1 own resolver-get-table-fallback scenario (test_optimizer.py:1184-1209) beyond the 20 fixture lines; outside the pair model (see above) |
| `qualify_columns__with_invisible.sql` | 9 | `spike/p10/fuzz_qualify.mjs` | EXACT 9  KNOWN_GAP 0  MISMATCH 0  ERROR 0 | 0 | |
| `qualify_columns_ddl.sql` | 10 | `spike/p10/fuzz_qualify.mjs` | EXACT 10  KNOWN_GAP 0  MISMATCH 0  ERROR 0 | 0 | |
| `qualify_tables.sql` | 71 | `spike/p10/fuzz_qualify.mjs` | EXACT 70  KNOWN_GAP 1  MISMATCH 0  ERROR 0 | 0 | replayed by `fuzz_qualify.mjs`'s own `run_qualify_tables_fixture`, not by `spike/p7/fuzz_qualify_tables.mjs` (hand-built, does not load this file) |
| `quote_identifiers.sql` | 10 | **none** | — | 0 | no oracle opens this file |
| `simplify.sql` | 521 | **none** | — | 0 | `spike/p7/fuzz_simplify.mjs` is a hand-built Simplifier battery (own docstring) -- does not load this 521-pair file, the largest full-SQL-pair fixture in the corpus |
| `tpc-h/tpc-h.sql` | 22 | `spike/p10/fuzz_optimize_e2e.mjs` | EXACT 22  GENERATOR_GAP 0  MISMATCH 0  ERROR 0  SKIPPED 0 | 0 | |
| `tpc-ds/tpc-ds.sql` | 99 | `spike/p10/fuzz_optimize_e2e.mjs` | EXACT 99  GENERATOR_GAP 0  MISMATCH 0  ERROR 0  SKIPPED 0 | 0 | |
| `unnest_subqueries.sql` | 41 | **none** | — | 0 | `spike/p7/fuzz_unnest_subqueries.mjs` is greenfield -- does not load this file |

`spike/p10/fuzz_optimize_e2e.mjs` additionally carries 28 "ad-hoc" rows with no named
fixture file at all (`EXACT 27  MISMATCH 0  ERROR 0  SKIPPED 1`) — part of the Track-2
end-to-end gate (AIR-2119), not part of the pair model above.

## Totals

| | |
|---|---:|
| Real pair-structured fixture files | 24 |
| **Total pairs** (upstream `load_sql_fixture_pairs`, summed) | **3,589** |
| Pairs replayed by some oracle in `spike/p7`/`spike/p10` | 854 |
| Pairs with **no oracle anywhere** that replays their real fixture file | **2,735** |
| Pairs permanently wontfix (execute, the 3 `execute=True` files, no `execute` meta key) | **259** |
| Sum of `EXACT` across every mapped oracle (includes each oracle's own extra non-fixture rows per the notes column) | 861 |
| `qualify_columns__invalid.sql` (line-based, not a pair file; separate population) | 20 lines, oracle EXACT 21/21 |

**The one honest sentence:** of the 3,589 real optimizer fixture pairs at this pin, 854
are replayed by an oracle today (and currently EXACT, modulo each oracle's own
documented extra non-fixture rows baked into that count); 259 are permanently wontfix
(execute); and **2,735 pairs — 76% of the corpus — have no oracle anywhere in this
repo that replays their real fixture file at all.** The single largest gap is
`annotate_functions.sql` (1,932 pairs, 54% of the whole corpus, zero oracle coverage of
the real fixture), followed by `simplify.sql` (521), `qualify_columns.sql`'s own 292
(which *is* replayed, just large), and `canonicalize_internal_names.sql` (65, used by a
real `check_file` call with no replaying oracle at all).

## What this changes and doesn't change

- **PORT_PLAN.md §7 P10's exit criterion is corrected** (see the entry for this round)
  to cite the real 3,589 / 259 figures instead of the never-measured 3,476 / 201.
- **No `src/` files changed.** This is a measurement round. The 2,735-pair gap is real
  and large, but closing it is follow-up work (new `gen_*_ref.py`/`fuzz_*.mjs` oracle
  pairs for `annotate_functions.sql`, `simplify.sql`, `canonicalize_internal_names.sql`,
  and the other eleven zero-oracle files), not something this round attempts.
- `spike/p7`'s hand-built oracles (`fuzz_simplify.mjs`, `fuzz_eliminate_ctes.mjs`,
  `fuzz_eliminate_subqueries.mjs`, `fuzz_isolate_table_selects.mjs`,
  `fuzz_unnest_subqueries.mjs`, `fuzz_optimize_joins.mjs`, `fuzz_qualify_tables.mjs`,
  the `fuzz_annotate_types*`/`fuzz_typing*` family) are **not worthless** — they verify
  the underlying module against independently-constructed scenarios — but none of them
  is a substitute for replaying the real upstream fixture file, and this rollup does not
  credit them as if they were.
- `tools/fixture_rollup.mjs` is **not** registered in `spike/run_all.sh`: its own
  slowest dependency, `node spike/p10/fuzz_optimize_e2e.mjs` (real TPC-H/TPC-DS queries
  through the full `optimize()` pipeline), alone takes ~28s, and the full rollup across
  all 8 distinct oracles measured ~45-50s — over the "< 30s informational line" budget.
  Run it by hand (invocation above) after `spike/run_all.sh` or the relevant
  `gen_*_ref.py` scripts have refreshed `spike/out/*.json`.

## Update (AIR-2315 Part 1): `annotate_functions.sql` is now replayed

`spike/p7/gen_annotate_functions_ref.py` + `spike/p7/fuzz_annotate_functions.mjs`
(registered in `spike/run_all.sh` and `tools/run_correctness.sh`'s P7 oracle loop) now
replay the real fixture file against the real `annotate_types()`, closing the single
largest gap this document found. One record per (pair, `# dialect:` meta entry) —
2,396 records over the file's 1,932 pairs — all **EXACT** at this pin.

Re-measured with `SQLGLOT_REF=/tmp/sqlglot-complete-pin node tools/fixture_rollup.mjs`:

| | before (R95) | after (AIR-2315 Part 1) |
|---|---:|---:|
| Pairs replayed by some oracle | 854 | 2,786 |
| Pairs with **no oracle anywhere** | **2,735** | **803** |
| Sum of `EXACT` across every mapped oracle | 861 | 3,277 |

The first real run surfaced 25 genuine port defects, all one root cause: `COERCES_TO`
on the `Hive`/`Databricks` dialect classes (`src/dialects/hive.js`,
`src/dialects/databricks.js`) was still the empty-`Map()` stub R20/R31 left behind
when `sqlglot/optimizer/annotate_types.py` was P6+/unported — a case of R22's "stub
outlives its blocker" (the blocker, `annotate_types.js` not existing, has been resolved
since R51/the optimizer epic landed, but nothing came back to un-stub these two call
sites). `IF`/`COALESCE` pick their result type via `TypeAnnotator._maybe_coerce`, which
reads `dialect.COERCES_TO`; with it empty, both dialects silently fell back to the
dialect-neutral base table, which resolves STRING-vs-DOUBLE/DATE/INTERVAL/BIGINT
precedence backwards from what Hive's (string wins over numeric/temporal/interval) and
Databricks's (numeric/temporal wins over string) real tables specify. Fixed with real
`// py:`-anchored ports of `sqlglot/dialects/hive.py:37-42` and
`sqlglot/dialects/databricks.py:18-26`; `bigquery.js`'s own identically-shaped
`COERCES_TO` stub (py:118-128) remains unfixed — it is not exercised by this fixture
file (390 BigQuery records were already EXACT before and after), so it is named here
as a likely-identical remainder rather than fixed speculatively.

Remaining "no oracle" population after this round: `simplify.sql` (521, AIR-2315 Part
2) and the eleven small files (`annotate_types.sql` 71, `canonicalize_internal_names.sql`
65, `unnest_subqueries.sql` 41, `normalize_identifiers.sql` 30, `eliminate_subqueries.sql`
27, `optimize_joins.sql` 18, `quote_identifiers.sql` 10, `isolate_table_selects.sql` 8,
`eliminate_ctes.sql` 6, `pushdown_cte_alias_columns.sql` 6; AIR-2315 Part 3) — 803 pairs
total, matching AIR-2315's own target arithmetic (2,735 − 1,932 = 803).

## Update (AIR-2315 Part 2): `simplify.sql` is now replayed

`spike/p7/gen_simplify_fixture_ref.py` + `spike/p7/fuzz_simplify_fixture.mjs`
(registered in `spike/run_all.sh` and `tools/run_correctness.sh`'s P7 oracle loop) now
replay the real `simplify.sql` fixture file against the real `test_simplify`-shaped
pipeline (`annotate_types()` then `simplify(..., constant_propagation=True,
coalesce_simplification=True)`, per that test's own local `simplify()` wrapper, NOT
the bare `simplify()` entry point `spike/p7/gen_simplify_ref.py`'s hand-built 81-row
battery already exercises) — 521 records over the file's 521 pairs (no dialect
fan-out, unlike `annotate_functions.sql`), closing the second-largest gap this
document found.

Re-measured with `SQLGLOT_REF=/tmp/sqlglot-complete-pin node tools/fixture_rollup.mjs`:

| | before (AIR-2315 Part 1) | after (AIR-2315 Part 2) |
|---|---:|---:|
| Pairs replayed by some oracle | 2,786 | 3,307 |
| Pairs with **no oracle anywhere** | **803** | **282** |
| Sum of `EXACT` across every mapped oracle | 3,277 | 3,798 |

The first real run surfaced 3 genuine port defects across 2 root causes, both outside
`src/optimizer/simplify.js` itself (in shared `src/expressions/core.js` and
`src/_py/datetime.js`): (1) `Expr.flatten()` never ported the `not node.is_subquery`
guard (`core.py:1235`) that stops a scalar-subquery operand of a connector
(`x = 5 AND (SELECT ...)`) from being unwrapped to its bare `Select`, which otherwise
renders as the `Select`'s own `WHERE` wrongly absorbing the sibling predicate; (2)
`extract_interval` didn't catch the `PyValueError` a non-literal interval amount (a
column, not a literal) raises, where upstream's own `except (..., ValueError)` treats
that as "not foldable", not an error; (3) `PyDate.addDays` was never overridden on
`PyDateTime`, so `datetime_floor`'s WEEK-unit branch silently degraded a `PyDateTime`
input to a bare `PyDate`, dropping its time-of-day and picking the wrong ISO-rendering
branch downstream. All three fixed; PORT_PLAN.md's R120 entry has the full detail.
Rerun: 521/521 EXACT.

Remaining "no oracle" population after this round: the same eleven small files named
above (AIR-2315 Part 3) — 282 pairs total, matching AIR-2315's own target arithmetic
(803 − 521 = 282).
