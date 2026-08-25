# Closure — regenerated from the real harvested corpus

**Source: `corpus/atoms.jsonl`, 15,540 atoms, upstream `91119bc`, CPython 3.9.25 / unicodedata 13.0.0.**
Every number here is emitted by `tools/closure.mjs`, not asserted in prose (PORT_PLAN.md §3.2).
Regenerate with `node tools/closure.mjs --markdown` / `--classes <phase>` / `--greedy` / `--dialects`.

The plan was written against an estimate of ~15,642 atoms. The real count is **15,540**, a
102-atom / 0.65% delta. **Percentages are unchanged to within 0.1pp at every phase**, so the
plan's arithmetic and its P8-ships-v0 conclusion stand.

## §3.2 per-phase table (regenerated)

| after phase | dialect set | atoms closed | % of 15,540 | marginal | plan's estimate |
|---|---|---|---|---|---|
| P4 | `{snowflake}` | 1,595 | 10.3% | +1,595 | 1,606 (10.3%) |
| P5 | `+ default` | 2,000 | 12.9% | +405 | 2,022 (12.9%) |
| P6 | `+ duckdb` | 3,394 | 21.8% | +1,394 | 3,417 (21.8%) |
| P7 | `+ hive, spark2, spark, databricks` | 5,178 | 33.3% | +1,784 | 5,207 (33.3%) |
| **P8 (v0)** | `+ postgres, redshift` | **6,522** | **42.0%** | +1,344 | 6,552 (41.9%) |
| P9 | all 46 dialect keys | 15,540 | 100% | +9,018 | 15,642 (100%) |

## Per-test-class closure (the A2 correction, verified)

A2's whole point was that "test_snowflake 100% at P6" was arithmetically impossible. The real
corpus confirms the corrected figures to within ~0.1pp:

| class | phase | real | plan's corrected estimate |
|---|---|---|---|
| TestSnowflake | P6 | **2,075 / 2,426 (85.5%)** | 2,086 / 2,437 (85.6%) |
| TestSnowflake | P7 | **2,191 / 2,426 (90.3%)** | 2,202 (90.4%) |
| TestSnowflake | P8 | **2,245 / 2,426 (92.5%)** | — |
| TestDatabricks | P7 | **202 / 221 (91.4%)** | 203 / 222 |
| TestPostgres | P8 | **699 / 802 (87.2%)** | 700 / 803 |
| TestDuckDB | P6 | **722 / 1,008 (71.6%)** | — |
| TestDialect | P8 | **1,313 / 2,650 (49.5%)** | — |

`TestDialect` is the largest single class (2,650 atoms) and is only half-closed at v0, because
it fans out across every dialect. It is the main reason P8 sits at 42% rather than higher.

## P9 long tail — greedy order, recomputed after each pick

`tools/closure.mjs --greedy`. Note this is a true greedy sequence: marginals shift as dialects
land, so it is **not** the same as ranking once from the P8 base.

| # | dialect | marginal | cumulative |
|---|---|---:|---:|
| 1 | bigquery | +1,672 | 8,194 |
| 2 | tsql | +1,097 | 9,291 |
| 3 | presto | +997 | 10,288 |
| 4 | mysql | +1,017 | 11,305 |
| 5 | clickhouse | +788 | 12,093 |
| 6 | exasol | +581 | 12,674 |
| 7 | oracle | +573 | 13,247 |
| 8 | sqlite | +349 | 13,596 |
| 9 | trino | +338 | 13,934 |
| 10 | singlestore | +336 | 14,270 |
| 11 | starrocks | +276 | 14,546 |
| 12 | teradata | +202 | 14,748 |
| 13 | doris | +179 | 14,927 |
| 14 | drill | +111 | 15,038 |
| 15 | dremio | +98 | 15,136 |
| 16 | athena | +72 | 15,208 |
| 17 | materialize | +63 | 15,271 |
| 18 | fabric | +49 | 15,320 |
| 19 | dune | +44 | 15,364 |
| 20 | tableau | +44 | 15,408 |
| 21 | druid | +41 | 15,449 |
| 22 | prql | +30 | 15,479 |
| 23 | risingwave | +16 | 15,495 |
| 24 | dax | +13 | 15,508 |
| 25–29 | versioned keys + solr | +22 | 15,540 |

**Two deltas against §7 P9's published ordering:**

1. **`presto` and `mysql` swap.** The plan lists presto (+1,027) ahead of mysql (+1,000) from a
   single ranking off the P8 base. Under a true greedy sequence mysql's marginal *rises* to
   +1,017 once presto lands, so the recomputed order is presto → mysql by cumulative value but
   mysql is worth more at that point. Immaterial to the schedule; recorded so the two lists
   don't silently disagree.
2. **`solr` is missing from the plan's P9 list** (+4 atoms). Small, but it means the plan's
   enumeration is not exhaustive.

## Dialect key census

**46 distinct keys = 34 base dialects (including the default, stored as `""`) + 12 versioned keys.**

§7 P9 says "all 38 dialect keys" and "the 14 versioned keys (+28 total)". The real split is
**34 + 12 = 46**, and the versioned keys contribute **+22**, not +28. Not schedule-relevant, but
the counts in the plan should be corrected.

The 12 versioned keys are `clickhouse, version={23.8, 24.1}`, `duckdb, version={1.0, 1.1, 1.1.0, 1.2}`,
`postgres, version={13.9, 15, 16, 17.5}`, `spark, version={3.0.0, 4.0.0}`.

**Every versioned key appears only as a WRITE target — 0 occurrences as a read dialect.** That
is a useful narrowing for `compareVersion` (§7 P8): it is needed on the generate path only.

## Corpus provenance

```json
{"upstream_commit":"91119bc","python_version":"3.9.25","unidata_version":"13.0.0",
 "atom_count":15540,"tests_run":772,"test_failures":3,"test_errors":1}
```

The 3 failures + 1 error are a harness artifact of the harvester's second parse+generate pass
(it doubles some `logging`-message-count assertions in 3 tests), root-caused and documented in
PORT_PLAN.md §3.2 — not a corpus-quality problem. Baseline on a plain `unittest` run is
1 error / 0 failures.
