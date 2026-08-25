# P0 Day 3–6 calibration spike — measured LOC/agent-hour

**Headline: ~2,150 raw upstream LOC/agent-hour, ~500 upstream *code* LOC/agent-hour.**
**Recommendation: do NOT rescale PORT_PLAN §10 on this measurement.** Re-baseline after
P1 and P3, as §7 P0 / appendix A8 already require. See "Why this sample is unrepresentative".

Scope: PORT_PLAN.md §7 P0 item 2. Ported `sqlglot/time.py` (688), `sqlglot/helper.py` (481)
and their dependency `sqlglot/trie.py` (82) to green, differentially tested against the real
upstream modules under CPython 3.9.25. These are production files per §4.1, not throwaways.

## Result: GREEN — 23,621 cases, 0 divergences

| bucket | cases | fail |
|---|---:|---:|
| `time: format_time` | 6,168 | 0 |
| `time: subsecond_precision` | 569 | 0 |
| `time: TIMEZONES` (size + contents) | 2 | 0 |
| `trie: new_trie` / `in_trie` | 128 | 0 |
| `helper: is_iso_date` / `is_iso_datetime` | 9,150 | 0 |
| `helper: is_int` / `is_float` | 8,084 | 0 |
| `helper: merge_ranges` | 2,008 | 0 |
| `difflib: ratio` / `quick_ratio` / `real_quick_ratio` / `matching_blocks` | 24,080¹ | 0 |
| `difflib: get_close_matches` | 40 | 0 |
| `helper:` camel_to_snake_case, csv, dict_depth, find_new_name, seq_get, split_num_words, to_bool, tsort | 67 | 0 |

¹ four assertions per fuzz record, hence more assertions than the 23,621 record count.

The oracle imports the **real** `sqlglot.time`, `sqlglot.trie` and `sqlglot.helper` from the
pinned clone, so this is upstream's own behaviour, not a reimplementation of it.
Reproduce: `bash spike/run_all.sh`.

## LOC accounting

`wc -l` badly overstates this task: `time.py` is 688 lines of which ~635 are the `TIMEZONES`
data literal, extracted mechanically by a 36-line script. Code lines below exclude blanks,
comments and docstrings (`spike/py/count_loc.py`).

| | raw | code |
|---|---:|---:|
| **Upstream ported** — time.py + helper.py + trie.py | **1,251** | **292** |
| ‣ time.py | 688 | 53 |
| ‣ helper.py | 481 | 212 |
| ‣ trie.py | 82 | 27 |
| **JS production written** (calibration-attributable) | ~1,420 | ~955 |
| JS codegen tools | 218 | 138 |
| Differential harness + recon probes | 830 | 583 |

`src/_py/num.js` and `src/_py/str.js` are excluded above except for the portions added by this
task (~120 code lines); the bulk of those files belongs to the day 1–3 go/no-go spike.

## Elapsed time

Measured from git commit timestamps, single serial agent, no parallelism:

```
ef57208  00:07  go/no-go complete  (calibration starts)
4e53282  00:23  trie/time/helper ported
67d220d  00:34  differential harness
69de213  00:42  calibration GREEN
```

**35 minutes wall clock = 0.58 agent-hours.** Includes recon, porting, harness construction,
two debug cycles, and fetching CPython's C source. It does not include this write-up.

## Measured rate

| metric | measured | §10 assumption | ratio |
|---|---:|---:|---:|
| upstream **raw** LOC / agent-hour | **~2,150** | 150–250 | **8.6× the upper bound** |
| upstream **code** LOC / agent-hour | **~500** | — | 2.0× the upper bound |
| JS production code LOC / agent-hour | ~1,650 | — | — |

§10's phase table quotes raw file line counts (P1 = 1,809 = tokenizer_core 1,217 + tokens 592),
so **raw LOC is the definition that matches the plan's arithmetic** — that is the 8.6× row.

## Why this sample is unrepresentative — in both directions

**Optimistic (inflates the rate):**

1. **87% of `time.py` is data.** 635 of 688 lines are the `TIMEZONES` tuple, converted by
   `tools/gen_timezones.mjs`. Any phase whose LOC is similarly literal-heavy will transfer;
   any phase that is dense logic will not. §4.3 already measured that only ~4.3 kLOC of the
   codebase is codegen-able, because 76% of dialect dict entries are callables.
2. **These are the easiest files in the repo, by construction.** §7 P0 item 2 chose them over
   the reviewer's suggested `tokens.py` precisely because they are pure functions that can be
   differential-tested with no oracle infrastructure. There is no expression model, no
   dispatch table, no dialect inheritance, no `arg_types` ordering, no generator recursion.
3. **No integration cost.** §10 applies a +35% multiplier to code written before its oracle
   exists (all of P0–P2). Nothing here had to integrate with anything unwritten.

**Pessimistic (deflates the rate):**

4. **583 lines of harness were built from zero.** From P3 the AST oracle and runner exist, so
   later phases amortise this. Roughly 40% of the elapsed time went to the oracle, not the port.

**The single most informative datum — and the reason not to bank the 8.6×:**

`pyFromIsoFormat` alone (~195 code lines) consumed roughly **a third of the total elapsed
time**, because the obvious source of truth was wrong. `Lib/datetime.py` is readable and
public, and porting from it produces a subtly incorrect parser — the C accelerator `_datetime`
is what actually runs, and it differs in at least three ways (strict ASCII digits; forward
scan for the first `+`/`-` rather than `-`-anywhere-then-`+`; and a NUL-vs-slice-boundary read
that makes `'123'` invalid but `'123+00:00'` parse as hour 12). Getting it right required
fetching `Modules/_datetimemodule.c` at tag `v3.9.25` and transliterating the C.

That profile — one function costing 10× the mean because the semantics are hidden — is exactly
what §8.5 measured for `parser.py`: **72 methods larger than 30 LOC hold 4,240 LOC, 56% of all
parser method LOC**. If the hard tail behaves like `fromisoformat`, its effective rate is
~200–400 raw LOC/hour, i.e. squarely inside §10's original 150–250 band.

## Recommendation

1. **Leave §10's 150–250 band in place for now.** This measurement says the estimate is not
   *too low*; it does not license an 8× schedule compression off a 292-code-line sample whose
   easiest 635 lines were machine-generated.
2. **Re-baseline after P1 and again after P3**, per A8. P3 is the one that matters: it is the
   first phase dominated by the >30-LOC method tail.
3. If a single number is needed for planning today, use **~400–600 raw LOC/agent-hour** for
   pure-function, no-oracle-dependency files, and keep 150–250 for parser/generator work.
   Do not blend them into one constant.
4. **R2's stated risk is unchanged.** The plan says a 2× miss moves v0 between ~6.5 and ~13
   months. Nothing here resolves that; it defers it to P3.

## Bugs the harness caught (both would have shipped silently)

1. **`is_iso_datetime`, 11/4,575 cases.** The C accelerator's `parse_hh_mm_ss_ff` does
   `char c = *(p++); if (p >= p_end) return c != '\0';`. `p_end` is a *slice* bound (the
   timezone position), not the string end, so reading past it yields the `+`/`-` and returns
   `rv = 1` ("trailing content") — which `parse_isoformat_time` treats as fatal **only when no
   timezone follows**. Hence `'123'` is rejected while `'123+00:00'` parses as hour 12.
   Neither the docstring nor `Lib/datetime.py` predicts this.
2. **`split_num_words` with an empty separator.** Python raises `ValueError('empty separator')`;
   JS `String.split('')` silently returns the characters. Wrong table parts, no error.

Both are corpus-invisible in the §4.6/R4 sense: realistic SQL timestamp literals and table
names never hit them, so 15,642/15,642 atoms could pass with either bug present.

## Deviations recorded for CONTRACTS.md

| item | deviation | why |
|---|---|---|
| `helper.subclasses` | takes an explicit class registry instead of `inspect.getmembers(sys.modules[name])` | no JS module introspection. Sorted by class name because `getmembers` sorts by name and that order is observable in `ALL_FUNCTIONS` / `EXPR_CLASSES`. |
| `trie` node type | `Map`, not a plain object | Python distinguishes dict keys `0` and `"0"`; JS object keys coerce to strings, so any keyword containing `'0'` would collide with the end-of-keyword marker. |
| `helper.seq_get` | supports negative indices | not optional — `parsers/bigquery.py:516-517` calls `seq_get(table_parts, -3)` and `-4`. |
| `helper.csv` | keyword-only `sep` passed as a trailing options object | JS has no keyword arguments. |
| `while_changing`, `is_iterable`/`flatten` | take injected `hash` / `isExpr` callbacks | upstream late-imports `expressions` to break a circular dependency; JS has the same cycle. |
| `_py/errors.js` | new module | the exception *type* is observable: `helper.is_type` and `time.subsecond_precision` catch `ValueError` specifically, so a generic `Error` swallows too much. |
