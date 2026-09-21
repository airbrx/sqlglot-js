# Corpus baseline proposed for review

Source: sqlglot-js `b3ecdde`, upstream `91119bc`, CPython 3.9.25 / Unicode 13 / hash seed 0, Node 22.12.0.
The 5,677 sorted IDs in `test/ratchet.json` are the **initial accepted-pass proposal in this PR**. Merging after review accepts it; no runtime command automatically refreshes it.

| Population | Pass | Stub | SQL mismatch | Error | Warning mismatch | Expected-error mismatch | Excluded |
|---|---:|---:|---:|---:|---:|---:|---:|
| All 15,540 | 5,677 | 9,044 | 605 | 200 | 8 | 6 | 0 |
| v0 6,522 | 4,015 | 1,858 | 467 | 171 | 8 | 3 | 0 |
| Python all 15,540 | 15,540 | 0 | 0 | 0 | 0 | 0 | 0 |
| Python v0 6,522 | 6,522 | 0 | 0 | 0 | 0 | 0 | 0 |

```
node --test test/corpus-adapter.test.mjs
node test/runner.mjs --report /tmp/all-outcomes.jsonl
node test/runner.mjs --v0 --report /tmp/v0-outcomes.jsonl
PYTHONHASHSEED=0 python3 tools/corpus_control.py --report /tmp/control.jsonl
node tools/check_ratchet_change.mjs origin/main
```

Each report contains every selected atom ID and its outcome, including error detail.
The gate protects **individual IDs**, never just the number passing. A new pass also
fails until explicitly promoted in a reviewed change (PORT_PLAN §3.3 rule 2).
`--propose-passes PATH` only writes a candidate list; it never edits accepted state.
`--baseline` accepts input/provenance metadata, not pass outcomes. The PR-relative
check prohibits deleting accepted IDs or changing known expectations; an upstream
resync needs a dedicated reviewed policy/change, not a blanket rebaseline.

Multiple statements follow the pinned Validator's Block contract. `block_sql` is
still a stub, and public `parseOne` still returns only the first tree: neither is
hidden by this adapter. Public `transpile`'s string[] shape is tested separately;
warnings require the same production generator instance, not an invented array
property. Versioned/long-tail keys stay in the full denominator as visible gaps.

## Authorized merge integration against main cb4d6d2

Main simplify prerequisites unlock 11 additional exact atoms; no previously accepted
pass regressed. Reviewed each new SQL/target dialect against the unchanged fixture
and a fresh pinned Python full control (15,540 exact, mismatch/error zero).
The baseline only adds these IDs, never removes IDs or changes expectations:

- `06f15ee8a05a457d`
- `2d19223c0a8b29c7`
- `386b722f6ba0b9d1`
- `510b3ee2cfd3ff25`
- `7c086ae7d3ffbaaa`
- `7df324053d167144`
- `9ab43e3f16749699`
- `af404fe374beac49`
- `c5cfb8e48892d0a4`
- `c642b7405424f7ad`
- `f918bf7c23328aa6`

Current full result: 5,688 exact, 9,028 stub, 200 error, 610 SQL mismatch,
8 warning mismatch, 6 expected-error mismatch; total15,540, exclusions0.
These are not all green: only accepted-pass regressions are zero.
The PR-relative monotonic check now runs in its own corpus-ratchet workflow,
so it is enforced immediately when this PR merges, not deferred to the CI PR.
