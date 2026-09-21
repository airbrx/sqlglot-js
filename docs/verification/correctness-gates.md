# Correctness gates and the remaining red diagnostics

Measured 2026-09-21 on `origin/main` `b3ecdde`, plus the corpus-runner PR
and this harness-only PR. Runtime: Node 22.12.0, CPython 3.9.25 / Unicode 13,
`PYTHONHASHSEED=0`, upstream `91119bcaac977ede6f4a641bdda593b0015ef998`.
No optimizer or dialect implementation changes. These are incremental **non-regression
checks**, not a declaration of v0 readiness.

## Enforced jobs (recommend making all four required)

| Status check | Contract |
|---|---|
| `native-tests` | All native tests, including production regression injection: 439 pass, 0 fail |
| `lints` | All seven Makefile lints, including anchors and ported-range deny gate |
| `corpus-ratchet` | Real parse/generate/warning/error adapter; protect 5,677 accepted atom IDs; no deletions or changed expectations |
| `differential-ratchets` | Strict applicable core/optimizer oracles, pinned Python corpus control, complete production AST and generation row ratchets |

`test/differential-{parse,generate}-baseline.json` contains explicit populations and
passing IDs submitted for review. Missing/new IDs, missing AST references, empty
populations, accepted-pass regressions and newly passing IDs not yet proposed for
review all fail. `tools/check_differential_change.mjs` rejects deleting accepted IDs
against the PR base. Proposals never silently accept themselves. Generation checks
**both SQL and unsupported messages**; the end-to-end corpus gate additionally checks
expected UnsupportedError and multi-statement Block semantics.

| Production population | PASS | MISMATCH | STUB | ERROR | Excluded | Total |
|---|---:|---:|---:|---:|---:|---:|
| Parse → raw pinned AST | 10,279 | 95 | 5,098 | 68 | 0 | 15,540 |
| Pinned AST → dialect SQL + warnings | 6,917 | 713 | 7,609 | 301 | 0 | 15,540 |

**MISMATCH and ERROR are not zero.** Only accepted-pass regressions and infrastructure
errors must be zero for these incremental gates. Use `--strict` to demand full parity;
it currently fails. Every ID gets a JSONL outcome, including unavailable dialects and
missing reference errors. Generation is now also invoked by `spike/run_all.sh`.
Native negative tests deliberately corrupt production generation to `SELECT 2`,
remove a reference and remove population rows: each must fail the row gate.

## Fresh full-suite triage: ten red groups → one strict full-parity diagnostic

The complete legacy suite remains a separate, **non-required, explicitly diagnostic**
CI job (`legacy-diagnostics-not-release-green`), with its nonzero result and logs
visible. It is not used as evidence of a passing release gate. The required production
row ratchets above do not exclude any of its corpus atoms.

| Initial red group(s) | Classification and action |
|---|---|
| Parity, Unicode tokenization, token streams, token transcription, parser class tables, Snowflake defaults, DuckDB defaults (7) | Intentional pinned-upstream divergence from already-landed PR #62: exact `CURRENT_ROLE` keyword/FUNC_TOKENS entries. Project those **specific entries only** out of upstream table comparisons, assert their exact values first, log EXCLUSION, and retain native consumer tests. Other table membership/order and actual stream comparisons are unchanged. Transcription also mistakenly compared comment lines as table entries; compare entries, preserving order. No runtime tokenizer change. |
| Command warnings (1) | Harness/environment defect: supplied reference has incomplete dialect tests, so harvest silently exercised zero cases. Use a complete official checkout at the same pin; fail empty/short populations. Upstream discovery's literal `python` subprocess also needed a temporary alias to the pinned `sys.executable` on this python3-only host. Now **772 Python tests executed, 0 failures/errors**, harvesting 131 warnings; JS **131/131 exact, including Snowflake 18/18**, no skipped cases. This is Python test execution plus a JS warning probe, not 772 JS tests. |
| AST coverage (1, still red) | Old stand-in harness: 12,281 exact + 1,774 mismatch + 640 stub + 783 error, with 62 Athena exclusions. Replaced dialect impersonation with real production parsing and raw AST comparison: **10,279 PASS / 95 MISMATCH / 5,098 STUB / 68 ERROR**, all 15,540 rows, zero exclusions. This strict diagnostic intentionally fails on every remaining gap; the separate incremental gate protects passing IDs. Remaining AST/type metadata and parser validation differences are implementation gaps, not harness exclusions. |
| Base generate/closure (1, repaired) | Harness defect: demand was harvested from generation, but the probe first reparsed SQL and called 66 parser failures generator closure overclaims. Feed the recorded AST instead, compare warnings as well as SQL, and reject missing references. Before: 94 exact, 39 stub, 92 parse failures. After: **176 exact, 49 stub, 0 mismatch, 0 error, 0 overclaims**; all 154 predicted rows pass. The 15,315 named-dialect rows remain explicitly outside this base-only diagnostic and are ALL evaluated by the production generation gate. This corrected cross-check is also required by run_correctness.sh. |

The original wrapper incorrectly printed `exit 0` for failures. It now captures the
actual status in the `else` branch and reports `exit 1` for the remaining strict AST diagnostic.
The registry parity probe now loads root `index.js`, reports 11/34 registrations and
23 explicit stubs, and protects all currently registered dialects. Registration is
never counted as successful conformance. Missing imports fail, not NOT_BUILT-green.
Other legacy exclusions remain named in full logs: Athena stream stand-ins (68 corpus
rows / 116 fuzz rows), six lone-surrogate-pair fuzz inputs (CONTRACTS §8), and explicit
unimplemented primitive/table cases. They are not additions to the production ratchet's
zero-exclusion populations. Do not sum generation-only, parse-only and round-trip
percentages as if they were one population.

`tools/bridge/proof.py` executes **13 test_errors tests**, 0 failures/errors. Its
`test_transpile.py` section executes **zero tests**: assertion-shape feasibility only.
The former “PROOF 2 GREEN” label has been removed. The full pinned corpus Python
control independently executes 15,540 atoms with **0 mismatch/error**.

## Reproduction

```sh
# Supplied /tmp/sqlglot-ref has matching source but incomplete tests/git objects.
# Keep it untouched; use a separate complete official pinned checkout.
git clone https://github.com/tobymao/sqlglot.git /tmp/sqlglot-complete-pin
git -C /tmp/sqlglot-complete-pin checkout 91119bcaac977ede6f4a641bdda593b0015ef998
python3 -m pip install --no-deps -e /tmp/sqlglot-complete-pin
export SQLGLOT_REF=/tmp/sqlglot-complete-pin PYTHONHASHSEED=0
npm test
make lint
node test/runner.mjs --report /tmp/corpus.jsonl
bash tools/run_correctness.sh        # required incremental checks: exit 0
bash spike/run_all.sh                # diagnostic: exit 1, strict AST full-parity gap
node spike/p5/fuzz_dialect_generate.mjs --strict # full parity: exit 1
```

The CI pins the interpreter versions above and fetches a complete reference. Locally
`make` was unavailable, so the seven commands in its lint target were run directly;
all seven passed. No dependency is added to the zero-dependency runtime.

## Repository controls (inspected, NOT changed)

`gh api repos/airbrx/sqlglot-js/branches/main/protection` returned **404, Branch not
protected**; `gh api repos/airbrx/sqlglot-js/rulesets` returned **[]**. Ask for approval
before requiring the four named checks above. Keep claim-overlap advisory; it is not
correctness evidence. Do not require the deliberately red legacy diagnostic as a
substitute for the production ratchets. No branch rules, settings, deployments or
merges were performed. The active simplify branch is untouched.
