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
