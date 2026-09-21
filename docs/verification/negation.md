# Core negation: first bounded v0 follow-up

Base: `5571dde` (all four SQLGlot safety/gate milestone PRs merged).
Upstream: `91119bcaac977ede6f4a641bdda593b0015ef998`.
No dialect or optimizer changes. Gateway PR #236 remains separately review-gated;
this work neither merges it nor deploys anything.

## Transliteration

`src/generator.js::neg_sql` directly follows upstream generator.py4013–4017:
render `this`, inspect its first character, insert a space only if it starts with
`-`, then prefix the minus. This protects `- -5` from becoming the comment `--5`.
Use the existing `cpAt` shim, not JS indexing or startsWith: upstream indexing an
empty rendered operand raises IndexError, and the port preserves its type/message.
The existing method anchor determines this method's ported range for lint_deny;
no global range directive is narrowed to evade checks.

The strict body-count test deliberately moves114→115 (stand-in callable113→114),
without changing dispatch membership or weakening its equality assertion.

## Verification (Node22.12.0 / CPython3.9.25, PYTHONHASHSEED=0)

| Population | Before | After |
|---|---:|---:|
| Dedicated pinned oracle, all nine v0 dialects | 0/504 exact | **504/504 exact** |
| Full end-to-end corpus | 5,688/15,540 exact | **5,727/15,540 exact** |
| Nine-key v0 end-to-end | 4,021/6,522 exact | **4,053/6,522 exact** |
| Full AST-fed generation | 6,929/15,540 exact | **6,969/15,540 exact** |
| Full parsing | 10,279/15,540 exact | **10,279/15,540 exact** |

Dedicated oracle: **MISMATCH0, ERROR0, exclusions0**, including36 expected
IndexError rows. Before the port it reports36 error-type mismatches and468 unexpected
NotPorted errors, not merely “nonzero exact.” Cases cover ordinary/large/decimal
negatives, negative zero, nested minus, parentheses, quoted strings, Unicode columns,
comments, missing/empty operands and real parse/generate paths, with both pretty and
identify flag states. The oracle runs in required correctness CI and run_all.sh.

Native tests: **518/518, failure0**. Seven lints pass. Required correctness script
passes, including83/83 simplify checks and504/504 negation checks; pinned Python
full control remains15,540/15,540, mismatch/error0. Baseline-diff checks reject
removal or rewriting of accepted passes. Reviewable changes add **39 end-to-end IDs
and40 generation-only IDs**, remove none, and do not alter any corpus expectations.
Every new pass previously stopped specifically at `neg_sql`; identities and newly
reached failures are in [negation-impact.json](negation-impact.json).

## Remaining failures are visible, not credited as success

Full corpus after: 5,727 exact,8,972 STUB,626 SQL_MISMATCH,201 ERROR,
8 WARNING_MISMATCH,6 EXPECTED_ERROR_MISMATCH; total15,540, exclusions0.
Full generation:6,969 PASS,734 MISMATCH,7,535 STUB,302 ERROR; total15,540.
V0 after:4,053 exact,1,799 STUB,487 SQL_MISMATCH,172 ERROR,
8 WARNING_MISMATCH,3 EXPECTED_ERROR_MISMATCH; total6,522, exclusions0.
These mismatch/error counts are **not zero**. Incremental ratchets pass because
accepted-pass regressions and infrastructure errors are zero, not because all rows pass.

Removing the negation stub reaches **16 existing DuckDB SQL mismatches and one
unwired Number-expression error**. These are preserved as failures, not excluded or
accepted: date arithmetic/ADD_MONTHS/DATE_FROM_PARTS, negative-scale CEIL/FLOOR,
array insertion/removal, STR_POSITION, bitmap buckets and GENERATE_SERIES→RANGE need
DuckDB-specific generation. The dedicated negation oracle is exact on those operand
shapes; no previously passing SQL, warning or expected-error atom regressed. This
small core port does not pretend to implement those missing dialect behaviors.

Next bounded queue item remains the window/partition/frame cluster (93 measured
candidate gains), then DuckDB LIST_SORT (17). Those are not implemented by this PR.

## Reproduce

```sh
export SQLGLOT_REF=/tmp/sqlglot-complete-pin PYTHONHASHSEED=0
python3 -m pip install --no-deps -r tools/requirements-oracle.txt
python3 spike/p4/gen_neg_ref.py > spike/out/neg.json
node spike/p4/fuzz_neg.mjs
npm test
node test/runner.mjs --report /tmp/neg-corpus.jsonl
node tools/v0_scorecard.mjs /tmp/neg-v0-summary.json /tmp/neg-v0-rows.jsonl
node spike/p5/fuzz_dialect_generate.mjs --report /tmp/neg-generation.jsonl
bash tools/run_correctness.sh
bash spike/run_all.sh # Full parity remains a red diagnostic, not a release claim.
```
