# v0 readiness scorecard and next-work queue

> This milestone snapshot is tied to `5571dde`. The subsequent
> [negation follow-up](negation.md) measures **4,053/6,522 exact**, up32, with
> no accepted passes lost. Historical tables and candidate experiments below are
> retained as the milestone baseline, not advertised as the latest runtime counts.

**Measured 2026-09-21; not release-ready.** The original review reproduction used `b3ecdde`.
This integration refresh includes current main's simplify prerequisites (`cb4d6d2`)
and merged safety/corpus fixes. The six additional exact v0 rows come from already-
landed main, not from the CI/scorecard tooling. Upstream remains `91119bcaac977ede6f4a641bdda593b0015ef998`.

## End-to-end population (not customer-query coverage)

Both read and write must be exactly one of: default (`""`), Snowflake, DuckDB, Hive,
Spark2, Spark, Databricks, Postgres, Redshift. Version-qualified dialect keys are not
members of this set. **6,522 of 15,540 atoms are eligible; eligibility is not a pass.**
The other 9,018 are outside this scorecard's agreed v0 dialect-pair set but are still
executed by the full corpus ratchet. No eligible rows, crashes or references are
silently skipped. The machine-readable [scorecard](v0-scorecard.json) includes all
81 dialect pairs, even empty ones, their exact/eligible counts and every outcome
category. The measurement command writes one result for each of the 6,522 IDs.

| Outcome | Review | Integrated JS | Pinned Python control |
|---|---:|---:|---:|
| Exact SQL + warnings, or exact expected UnsupportedError | 4,015 | **4,021** | **6,522** |
| NotPorted / unavailable dialect | 1,858 | 1,848 | 0 |
| Other errors/crashes | 171 | 171 | 0 |
| SQL mismatch | 467 | 471 | 0 |
| Warning mismatch | 8 | 8 | 0 |
| Expected error not raised/mismatched | 3 | 3 | 0 |
| Explicit exclusions within v0 | 0 | 0 | 0 |
| **Total** | **6,522** | **6,522** | **6,522** |

The 4,021 exact results include 26 expected-error passes and 3,995 successful SQL
outputs. **61.7% is fixture conformance, not 61.7% of customer queries.** No customer
query sampling was performed. Full-corpus control also passes **15,540/15,540**, with
zero SQL/warning/exception mismatches and zero errors. JS has **nonzero mismatches and
errors**; the new pass-ID ratchet's success must not be called full parity.

### By write dialect, restricted to v0 read dialects

| Write | Exact | Eligible | Stub | Error | SQL mismatch | Warning mismatch | Expected-error mismatch |
|---|---:|---:|---:|---:|---:|---:|---:|
| default | 426 | 666 | 229 | 9 | 2 | 0 | 0 |
| snowflake | 1341 | 1849 | 418 | 72 | 18 | 0 | 0 |
| duckdb | 507 | 1452 | 467 | 33 | 441 | 1 | 3 |
| hive | 358 | 445 | 78 | 1 | 1 | 7 | 0 |
| spark2 | 48 | 62 | 14 | 0 | 0 | 0 | 0 |
| spark | 478 | 620 | 136 | 6 | 0 | 0 | 0 |
| databricks | 217 | 334 | 88 | 27 | 2 | 0 | 0 |
| postgres | 448 | 801 | 332 | 19 | 2 | 0 | 0 |
| redshift | 198 | 293 | 86 | 4 | 5 | 0 | 0 |

DuckDB's 441 SQL mismatches dominate the 471 v0 SQL mismatches. This is a strong
reason to finish required behavior there before expanding dialect breadth. It is
not evidence that every mismatch shares one cause.

## Next-work queue: product behavior first, measured gains second

No methods were ported in this scorecard PR. `tools/v0_impact_experiment.mjs` installs
reversible, process-local candidate bodies, evaluates **all** 6,522 atoms each time,
records gained/lost IDs, restores every descriptor, and reruns the original baseline.
Source was read directly from the pinned Python generator files, not inferred from
SQL examples. Results are in [v0-impact.json](v0-impact.json). These candidate bodies
are **not reviewed transliterations**, do not claim ported ranges, and are not loaded
by the library or accepted into any baseline. They need normal line-anchored ports,
native edge tests and full differential review before implementation credit.

| Priority | Required behavior / bounded work | First visible blocker count | Additional exact atoms in isolated experiment | Existing passes lost |
|---|---|---:|---:|---:|
| 1 | Core `neg_sql`: ordinary signed numeric expressions, including Postgres `SELECT -1`; preserve the space in `- -5` so it never becomes a comment | 49 | **32** | 0 |
| 2 | Core `window_sql` + `partition_by_sql` + `windowspec_sql`: ROW_NUMBER, partition/order/frame/EXCLUDE and named windows; required Snowflake analytic queries | 136 (`window_sql` first) | **93** | 0 |
| 3 | DuckDB `sortarray_sql` plus dispatch integration: emit LIST_SORT / ARRAY_REVERSE_SORT with direction/null ordering instead of generic SORT_ARRAY | SQL mismatches, not a stub | **17** | 0 |
| 4 | Core/DuckDB JSON-path generation and path conversion, including JSONPathKey/Root dispatch | 89 `Dialect.to_json_path` first blockers; separately 38 JSONPathKey + 28 JSONPathRoot errors | **Not measured**; do not sum these into promised gains | Not measured |
| 5 | Core ordinary date/string/aggregation generator clusters: `extract_sql`, `pad_sql`, then sampling and division as required by product queries | 65 / 61 / 44 `tablesample_sql` / 35 `div_sql` | **Not measured**; dependent blockers can remain | Not measured |
| 6 | DuckDB-specific remaining SQL and unsupported-warning/expected-error gaps | 424 SQL mismatches remain after the isolated LIST_SORT candidate; baseline 1 warning + 3 expected-error mismatches | **Not measured**; cluster by failing IDs/required query, not dialect count | Not measured |

Combined first three candidates: **+142 exact → 4,163/6,522**, zero accepted passes
lost, then restored to **4,021/6,522**. They do not fix the whole v0 gap. First-blocker
counts are **not unlocked-atom counts**: negation's 49 first failures yield only 32
exact rows; window's 136 yield only 93. Nested unported methods, dialect overrides
(e.g. DuckDB CORR/window handling), warning differences and parser failures remain.
The LIST_SORT experiment explicitly refreshes instance-local dispatch because the
baseline has already populated the class cache; adding a method without dispatch
integration misleadingly measures zero gain. Production porting must test this path.

Also keep visible, without prioritizing breadth by raw size: 88 pipe-set-parser,
75 MATCH_RECOGNIZE, 59 user-defined-function generation, 45 table-from-rows and other
first blockers (all IDs in the scorecard JSON). Product owners should choose which
are required before starting those clusters. This milestone does not authorize
long-tail dialect additions, broad optimizer work or the entire remaining port.

## Reconciled roadmap/status proposal (no scope change enacted)

Track three separate lanes rather than labeling registered dialects as complete:

1. **Gateway safety:** Merged PR #74 plus coordinated gateway PR #236 (still requires review). Both mutation
   reproductions fail closed, full SQL identity retained, actual gateway cache hint
   veto and mutation-rule invalidation exercised. New boundary tests: **0/8 before,
   8/8 after**; selected gateway cache/parser tests now **409/409**, boundary14/14 after review fixes. A fresh `npm ci
   --ignore-scripts` from the immutable dependency pin also passes the 8 boundary tests.
   The library safety fix is merged; the gateway changes are tested but **awaiting required review**, not deployed. Invalidations remain
   configured-rule-dependent; arbitrary side-effecting UDFs are not inferred.
2. **v0 transpiler conformance:** P4–P8 are **partial**, not 0% and not complete merely
   because classes are registered. Required nine-key scope and P8 release boundary
   remain unchanged. Merged PR #75 protects 5,688 full-corpus passing IDs; #76 adds
   enforceable incremental checks. Release review must consider all remaining v0
   failures/exclusions explicitly, not replace its bar with “ratchet green.”
3. **Broader SQLGlot parity:** landed optimizer prerequisites are useful, but do not
   imply P4–P9 completion. Link future optimizer tasks to required v0 atoms or a stated
   gateway/product behavior. The active simplify work is untouched. Existing BigQuery
   and TSQL work is retained; no more breadth is proposed here.

Propose reconciling Linear phase/task status to these lanes and attaching each
milestone's complete outcome table, accepted-pass IDs and remaining blocker IDs.
No live Linear updates were made; the coordination session should approve that
reconciliation. This is not an amendment of Ben's agreed release scope.

## Upstream pin/resync proposal — approval required

The project is **pinned**, not continuously tracking upstream. §5.1's post-P4 weekly
resync policy and actual activity have diverged. Do not silently change the pin or
pretend those weekly resyncs happened.

Propose an explicit, time-boxed freeze at 91119bc through this milestone's review,
with a checkpoint **2026-10-05 (14 days)**. This is a proposal, not an approved policy
change. After that checkpoint, resume a weekly **candidate resync branch**, not a
floating dependency: record old/new commit and interpreter, re-harvest without
accepting baselines, run pinned-Python controls first, classify upstream expectation
changes separately from JS regressions, review changed IDs/anchors/ranges, then
explicitly accept the new corpus and immutable pin in a focused PR. Never delete
passing IDs or weaken expectations to hide a regression; any true upstream removal
needs a separately approved migration rather than bypassing the ratchet. Consumer
pin updates need coordinated gateway boundary tests and their own reviewed PR.
No automatic merge, deployment or pin update is authorized by this proposal.

## Reproduction and artifact integrity

```sh
# Use the complete official pinned checkout and interpreter setup from correctness-gates.md.
export SQLGLOT_REF=/tmp/sqlglot-complete-pin PYTHONHASHSEED=0
python3 tools/corpus_control.py --v0 --report /tmp/python-v0.jsonl
python3 tools/corpus_control.py --report /tmp/python-full.jsonl
node test/runner.mjs --v0 --report /tmp/js-v0.jsonl
node tools/v0_scorecard.mjs /tmp/scorecard.json /tmp/scorecard-rows.jsonl
node tools/v0_impact_experiment.mjs /tmp/impact.json
node --test test/v0-scorecard.test.mjs
```

Scorecard tests reject missing/empty populations, duplicate IDs, unknown outcomes
and changed dialect identity. There is no SKIP category. Regeneration must compare
all outcome totals and mismatch/error categories, not just nonzero exact counts.
The experiment must restore the baseline; its 142 hypothetical new passes are **not**
added to `test/ratchet.json`. No source, optimizer, fixtures or runtime dependency
was changed by these tools. Review all JSON artifact changes rather than automatically
accepting regenerated numbers.

## Integration review delta

Relative to the original reproduction: exact+6, stub-10, SQL mismatch+4; errors,
warning mismatches and expected-error mismatches unchanged. These four newly reached
SQL mismatches remain visible (formerly unported), not accepted passes. No previously
accepted v0 pass regressed. Current corpus-ratchet workflow and the production row
ratchets preserve all accepted IDs; full parity remains red. Metadata review fixes
also preserve mutation occurrences and pre-deny ordering (R60), and the base-output
strict diagnostic now includes all foreign-reader ASTs (R62).
