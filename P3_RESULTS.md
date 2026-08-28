# P3 (blocking step) — Parser base: results

**Verdict: GREEN for the blocking step's scope.** The 364 `_parse_*` bodies are the next
round; this is the infrastructure they land on.

Upstream: `sqlglot @ 91119bc`; CPython 3.9.25; Node v22.12.0.

## What was built

| piece | where | verified by |
|---|---|---|
| `SENTINEL_NONE`, cursor primitives, semicolon chunking, `_try_parse` | `src/parser.js` | `fuzz_ast_coverage`, `fuzz_command_warning` |
| `ErrorLevel`, `ParseError.new`, `raise_error`, `check_errors`, `validate_expression`, `expression()` | `src/errors.js`, `src/parser.js` | `fuzz_raise_error` — 1,005/1,005 |
| optimizer **Tier A** (`walk_in_scope`, `find_all_in_scope`, `find_in_scope`, `_is_derived_table`) | `src/optimizer/scope.js` | `fuzz_walk_in_scope` — 15,540/15,540 trees, 62,160/62,160 finds |
| minimal generator kernel (13 classes) | `src/generator_kernel.js` | `fuzz_generator_kernel` — 73,107/73,127; `fuzz_parse_path_sql` — 29/29 (**replay**, not integration — see below) |
| `logging` shim (the log line is an asserted output, not diagnostics) | `src/logging.js` | `fuzz_command_warning` — 131/131 |
| 405 method stubs + 128 class tables | `src/parser.js` (seeded) | `check_parser_tables` — **2,991 of 4,000** entries compared, 0 wrong ([caveats](#what-check_parser_tables-does-and-does-not-cover)) |

## Exit criteria

| §7 P3 criterion | result |
|---|---|
| AST oracle exact match incl. `meta`, on what the subset parses | **38 EXACT / 0 MISMATCH / 0 ERROR**, 15,440 still `NotPorted`. Snowflake **3/3 of reached rows**. |
| The 18 `check_command_warning` log strings byte-exact via `error_message_context` | **131/131** across all dialects; the Snowflake gate is **18/18** |
| `ParseError.errors` structure | **1,005/1,005** — all seven keys, in order, values byte-exact |
| `fuzz_unicode` green over error-message column positions | **180/180** astral rows; mutation-tested (UTF-16 slice → 39/180) |

**Honest scope.** 38 of 15,478 oracle rows (0.25%) parse end-to-end today; every one is
byte-identical including `meta`. The rest stop at a single stub — `_parse_expression` —
which is the head of the precedence chain and therefore the stub queue's first task. The
criterion is "100% of what the implemented subset parses", and that is met with zero
mismatches; it is *not* "100% of Snowflake", which no blocking step could reach.

## Findings

**1. The plan named 2 mid-parse generator call sites; there are 7.** Instrumenting
`Expression.sql` over all 9,867 distinct corpus inputs found five more, because they are
implicit `f"{expr}"` coercions through `Expression.__str__` rather than literal `.sql()`
calls: `parser.py:3044`, `:3046`, `:3179`, `:9313`, `:9462`. `grep '\.sql('` shows only
`:5491` and `:8069`. The P0 implicit-`__str__` deny-list has **zero** `parser.py`
entries — its heuristics cannot see that `_parse_number()` returns an Expr.

**2. `parser.py:5491` can hand the generator a whole `SELECT`.** A pivot
`IN (SELECT DISTINCT q FROM z ORDER BY q NULLS LAST)` is generated mid-parse, so the
kernel had to be a real recursive generator, not a special-case renderer. Measured
scope: exactly 13 node classes, everything else throws `NotPorted`.

**3. P2 debt closed: `Func.from_arg_list` and the var-len metadata.** `focused_methods.js`
carried a hand-written list of var-len-args classes that had drifted to **46 of
upstream's 55** (missing `Anonymous`, `AnonymousAggFunc`, `CombinedAggFunc`, `ConcatWs`,
`HashAgg`, `Hll`, `Posexplode`, `PosexplodeOuter`, `_ExplodeOuter`). Those nine would
have been silently mis-shaped by `from_arg_list`, which `Parser.FUNCTIONS` binds for
hundreds of names. Both markers are now extracted and generated. Verified 2,832/2,832.

**4. `Cast.to` / `Expr.type` fidelity.** Upstream's `type` reads the `to` *property*
(`self.args["to"]`, a subscript), so a Cast missing its required `to` raises `KeyError`;
the port returned `undefined` and produced a repr Python cannot produce. Also,
`JSONCast`/`TryCast` inherit `Cast`'s members upstream but not in the port, so
`JSONCast.to` was undefined. A `/Cast$/` name regex stood in for `is_cast`; it matched
the right three by coincidence and is now explicit.

**5. Four committed AST-oracle rows are not reproducible by re-parsing at the pin.**
`86c3a2d070c3d663`, `a98e659da1d9c243`, `f18c0b39b6040bf0`, `ff0cd27e2cbf3239` — all
`UNION ... ORDER BY ... LIMIT` under the default dialect, where the corpus records
`limit` before `order` but `parse_one` produces `order` before `limit`. **No existing
gate can see this**: P2's AST gate only round-trips the corpus value
(`astDump(astLoad(ast)) == ast`) and never re-derives from SQL. Found because two P3
probes keyed nodes by walk position and misaligned on exactly these rows. Both probes
now emit the tree they walked, so they no longer depend on the assumption. **This is
unresolved and matters for P3+**, because the parser is supposed to *produce* these
ASTs — flagged for a human decision.

## Tooling changes

- **`tools/seed_static.py`** — resolves the mechanical symbolic forms it previously
  dropped as TODO comments (`TokenType.X`, `exp.Y`, sibling-table references, set
  algebra, `frozenset(...)`/`tuple()` wrappers, `dict.fromkeys`, keyset and trie views).
  Table entries seeded went from 0 to **637 of 1,022**; the remaining 385 are callables,
  still never guessed at. This matters for Rule 2′: you cannot CI-assert the ORDER of a
  table whose entries are all comments.
  - Bug found by the new checker: Python's `{*some_dict}` spreads a mapping's **keys**,
    JS's `[...someMap]` spreads `[k,v]` **pairs**. `ID_VAR_TOKENS` splats two dicts, so
    the literal transliteration produced a set of 2-element arrays that no
    `.has(TokenType.X)` would match — and `len()` still looked plausible.
- **`tools/parity/check_parser_tables.mjs`** (new) — asserts every class table's entries
  and, for dicts, their ORDER. Probe 6 compares `len()` only and cannot distinguish two
  same-sized tables. Found 252 seeding defects, now 0.

### What `check_parser_tables` does and does not cover

The first version of this document said "2,985 entries, 0 wrong". The number was wrong —
the tool prints **2,991** — and "0 wrong" was quoted without its denominator, which reads
as full coverage. Both are corrected here, and the tool now prints the reach itself so the
two cannot drift apart again:

```
    entries matched            2991  (75% of 4000)
    entries awaiting stubs     1009  (callable-valued — NOT checked, only that the
                                      port supplies some callable)
    entries WRONG              0  (of the 2991 comparable)
    tables still 100% EMPTY   21: PROPERTY_PARSERS 0/92, CONSTRAINT_PARSERS 0/33,
                                  EXPRESSION_PARSERS 0/33, FUNCTION_PARSERS 0/32,
                                  STATEMENT_PARSERS 0/30, RANGE_PARSERS 0/21, ...
```

Stated plainly:

- **1,009 entries (25%) are callable-valued and are not compared.** For those the check
  is only "the port supplies *a* callable" — never which one. They are the parser method
  bindings, so they land with the stub queue.
- **21 of the 128 tables are still entirely empty**, including every dispatch table that
  maps a keyword to a parse method. The checker counts an empty Map as *present*; it is a
  seeding gate, not a completeness gate.
- **ORDER is asserted only over keys present on both sides.** That is the right rule while
  a table is filling up, but it means order is unverified for the empty ones.
- **34 scalar `Parser` class attributes** (`STRICT_CAST`, `LOG_DEFAULTS_TO_LN`,
  `TABLESAMPLE_CSV`, …) are outside the snapshot entirely. All are currently correct, but
  flipping one passes every gate — and these are exactly what dialects override. Follow-up.

So "this is what makes Rule 2′ enforceable" is true of the *direction* and overstated for
the current *coverage*: the mechanism is in place and 0 of the 2,991 comparable entries
are wrong; three quarters of the surface is enforced and a quarter is deferred.
- **Probe 6** is now `PARTIAL` rather than `FAIL` when a table is short of upstream
  (the stub queue in progress); a table *longer* than upstream, or absent, still fails.
- **`tools/lint_deny.mjs`** — understands partially-ported files. At file granularity,
  every deny site in `parser.py` became a failure the moment the seeded skeleton landed.
  A site now counts as ported only if its enclosing method is not a `NotPorted` stub
  (derived from the port's own anchors), or if the file declares `@ported-ranges`.
  Negative-tested: widening the declared range re-fails.
- **`spike/run_all.sh`** — names the probes that failed. Previously the only signal was
  `SOME PROBES RED` at the bottom.

## Review response (PR #6, two independent adversarial reviews)

Five findings were fixed at the root cause; each one is now covered by a gate that fails
if it comes back. `git log` has the per-fix detail; the summary is:

**1. `identifier_sql` indexed a string by UTF-16 unit (silently wrong AST).**
`text[0]` where upstream is `text[:1].isdigit()` — a CODE POINT. For an astral digit
(U+1D7CE, category Nd) `text[0]` is a lone high surrogate, `pyIsDigit` says false, and the
identifier ships UNQUOTED where CPython quotes it. AST-visible at `parser.py:5491` (pivot
column name) and `:3179` (`DefinerProperty`), with no error raised. The highest-severity
shape in the project: silent, not loud.

Fixed with `cpSlice`/`cpAt` (new, in `_py/str.js`), applied to *all three* string index
reads in the kernel — the two in `sanitize_comment`/`maybe_comment` were correct only by
accident (no Unicode whitespace is astral). Astral inputs added to the CPython parse-path
oracle: `fuzz_parse_path_sql` went 20/20 → **29/29**, and reverting the one-line fix makes
it fail 4. Plus `test/generator_kernel.test.mjs`, which pins the negative side too —
astral *letters* must stay unquoted, and `str.isdigit()` is not the Nd category (U+00B2 is
No and isdigit() is **True**; U+2160 is Nl and isdigit() is **False**).

**2. `_try_parse` did not retreat on `[]`.** Upstream `if not this or retreat` is PYTHON
falsiness; `!self` in JS is not, for containers. The comment claiming `_parse_*` callables
"never return `[]`" was false — `parser.py:10382` passes a `_parse_csv` lambda, and
`_parse_csv` is `-> list[T]`. The cursor stayed advanced, so `_parse_as_command` quoted a
different span of SQL than CPython, into a byte-exact gated log line.

Fixed at the semantics with a new `_py/truthy.js` (`pyTruthy`/`pyFalsy`) implementing the
whole protocol — `__bool__` first (so `Token.__bool__` still governs), then `__len__`,
then "true". Differentialed against CPython with the same harness on both sides over 16
return kinds; all 16 now agree, including `Expression()` with no args, which is **truthy**
(no `__bool__`, no `__len__`). All 14 upstream `_try_parse` call sites enumerated rather
than assumed.

**3. The 7-call-site discovery was not enforceable by anything.** `kernelSql` had zero
call sites in `src/`, and `implicit_str.json` had zero `parser.py` entries, so a
stub-queue agent implementing `_parse_pivot` would read `fld.sql()` and have nothing
telling them the kernel exists.

The 7 sites (plus the 8th, below) are now `MEASURED_SITES` in
`tools/deny/gen_implicit_str.py`, carrying `route: "kernelSql"`. `lint_deny.mjs` gained a
routing check: while the owning method is a `NotPorted` stub these are notes; the moment
it gets a real body, the lint FAILS unless `src/parser.js` references `kernelSql`.
Verified by temporarily un-stubbing `_parse_pivot` — 2 failures, naming `kernelSql` — and
restoring. The static AST pass cannot find these sites (it cannot prove
`self._parse_number()` returns an Expr), so each seed is verified against the pinned ref
on every regeneration and fails loudly if upstream moves the line.

**4. Four more hand-written-identity checks — plus two the reviews did not name.** Same
root cause every time: `defineExpr` builds all 1,048 classes as direct subclasses of
`Expr`, so a Python `t.ClassVar` on a base does not reach subclasses and
`constructor.name === "X"` answers "no" for every subclass of X.

| where | upstream | was | now |
|---|---|---|---|
| `is_data_type` | ClassVar on `DataType` | `DataType` only | derived from the MRO → + `IntervalSpan`, `ObjectIdentifier`, `PseudoType` |
| `unalias()` | `isinstance(self, Alias)` | `name === "Alias"` | `instanceof` → `PivotAlias` unwraps |
| `join_type` | parses `FROM _ <jt> JOIN _` | word list with `GLOBAL`, without `STRAIGHT_JOIN` | the real JOIN token sets, matched in upstream's order |
| `is_int` | `is_number and isinstance(to_py(), int)` | unwrapped `Paren`, `\d+` regex | delegates; `(1)` is no longer an int |
| `Literal.is_number` *(not reported)* | no predicate at all | a regex incl. `binary_double_nan` | deleted — any non-string Literal is a number |
| `Paren.to_py` *(not reported)* | does not exist; base raises | unwrapped to the inner value | raises `PyValueError`, as upstream |

`join(..., join_type="straight_join")` rendered `SELECT * FROM tbl, tbl2` — a CROSS JOIN —
where CPython gives `STRAIGHT_JOIN`. Reachable from the public builder.

`tools/lint_identity.mjs` (new) now closes the class: it derives from `EXPR_META.bases`
which classes have subclasses and fails on any `constructor.name === "X"` against one of
them, unless annotated `// exact-type: <anchor>` for the cases where upstream really wrote
`type(x) is X` (`unnest` is the one). Currently **0 violations across 37 subclassed
classes**; negative-tested by reintroducing the `unalias` bug.

**5. Numbers and framing** — see [above](#what-check_parser_tables-does-and-does-not-cover).

### Also found while fixing the above

- **The `node:test` suite was run by nothing.** Not `spike/run_all.sh`, not `make check`,
  not `make probes`. It is now a probe in both. (And `node --test test/expressions/`, the
  form this document quoted, does not work on Node 22 — a directory argument is resolved
  as a module. The suites are enumerated with `find` so a new `test/<dir>/` cannot be
  silently skipped.)
- **`check_parser_tables` and `lint_deny` were not in the Makefile.** Added.

### Known limitations, carried forward deliberately

- **`fuzz_parse_path_sql` is REPLAY, not integration.** It loads sub-ASTs recorded from
  CPython and renders them through `kernelSql`. It proves the kernel renders what the
  parse path produces; it cannot prove the *JS parser* reaches the kernel, because all
  seven owning methods are still stubs. That check belongs to the stub-queue PRs — and is
  now what the `route: "kernelSql"` lint forces.
- **The kernel's 13-class scope is corpus-shaped.** Ordinary SQL such as
  `PIVOT(... IN (NULL))`, `IN (1, -2, 3.5)` or `IN (SELECT * FROM z)` throws `NotPorted`
  between the day `_parse_pivot` lands and the day P4's real Generator does. Loud, not
  silent — but it is a real sequencing risk for the stub queue, and it is called out at
  the top of `src/parser.js`. The pivot-subquery clause gap (`LIMIT`/`GROUP BY`/`HAVING`/
  `Alias` inside a pivot `IN (SELECT ...)`) is R12, already queued in `PORT_PLAN.md`.
- **An 8th mid-parse call site exists: `sqlglot/parsers/bigquery.py:712`**
  (`raise_error(f"... got {arg}")`). It is on an error path, so neither the corpus nor
  upstream's `tests/` reaches it and instrumentation cannot see it; it takes arbitrary
  expression types (`Add` confirmed), so the 13-class kernel cannot satisfy it. Recorded
  in `MEASURED_SITES` so it fires as a lint the day the BigQuery dialect lands (P9), not
  chased now.
- **Latent kernel fidelity bugs, in code P4 replaces wholesale**, reported by the second
  review and written down rather than fixed here: `sql(expression, key)` treats `false` as
  present (emits `WHERE FALSE` for `Where(this=False)`); `expressions()` keeps empty
  renders and puts element comments before instead of after; `order_sql` emits a leading
  space when `Order.this` is set; `parse_into`'s error messages interpolate a JS class
  (source text) where upstream prints `[<class '...'>]`, which `tests/test_parser.py`
  asserts verbatim. None is reachable on today's parse path.

## Regression

- `bash spike/run_all.sh` — **ALL PROBES GREEN** (exit 0)
- `bash spike/run_regex.sh` — GREEN
- `node --test $(find test -name '*.test.mjs')` — **57/57** (was 40; now wired into
  `run_all.sh` and `make check`)
- control-byte, unicode, license, deny, **identity** lints — clean
- `node tools/gen_expr_meta.mjs` idempotent

## For the stub queue

`grep -c 'throw new NotPorted' src/parser.js` = **379** of 405 seeded methods; **27**
are implemented (the core infrastructure plus the statement/Command path). The first
task is `_parse_expression` (`parser.py:5996`): it alone blocks 15,440 of 15,478 oracle
rows.

`node spike/p3/fuzz_ast_coverage.mjs --verbose` prints the live burndown, and
`node tools/parity/check_parser_tables.mjs --todo` prints the per-table entry burndown.

---

# P3 stub queue — round 1: scope correction + Rule 1 enforcement

**Verdict: the headline task was mis-scoped, and the measurement that shows it is the
main deliverable.** `_parse_expression` is not implemented. The reason is not that the
chain was too long — it is 50 methods / 955 LOC, entirely tractable — but that
implementing it would have bought **31 oracle rows**, not the 15,440 the brief
projected, and shipping it under that headline would have propagated a wrong number
into every remaining stub-queue brief.

## 1. The number in the last round's "For the stub queue" section does not mean what it reads as

`P3_RESULTS.md` above says, and PR #6 repeated:

> The first task is `_parse_expression` (`parser.py:5996`): it alone blocks 15,440 of
> 15,478 oracle rows.

That is true as a *blocking* statement and false as a *sizing* statement, because
**oracle-row closure is conjunctive**: a row is closed only when **every** `_parse_*`
its parse touches is implemented. The rows a method blocks are therefore almost never
the rows implementing it opens.

Machine-checked, at the pin (`node tools/closure_parser.mjs --brief _parse_expression`):

```
  _parse_expression
    rows that CALL it (the "blocks" number)   13573
    rows it actually OPENS (the marginal)         0
    rows still blocked after it lands         13573
    distinct methods still blocking those       278
```

**Zero.** Not 15,440. And the full precedence chain the brief asked for — the operator
ladder plus every leaf down to primary/literal, 50 methods, 955 LOC — closes **72 of
15,540 rows (0.46%)**, up from the 41 closed today. A marginal of **+31 rows for 955
LOC**.

The blocking counts do not compose: summed over methods they come to **751,871**
against 15,540 real rows — each row is counted once per method it touches, so the
totals over-count by **48.4x**. Ranking stub-queue tasks by "blocks N rows" is not a
scheduling signal.

### Where the rows actually are

Frequency-ordered closure over the 352 methods the corpus demands:

| methods implemented | rows closed | % of 15,540 |
|---|---|---|
| today (29) | 41 | 0.26% |
| + full precedence chain (50) | 72 | 0.46% |
| + 45 | 2,196 | 14.1% |
| + 65 | 6,899 | 44.4% |
| + 100 | 10,276 | 66.1% |
| + 305 | 15,440 | 99.4% |

**15,440 rows — the number attributed to one method — is reached at ~305 methods**,
i.e. essentially all of P3's remaining parser work. There is no small subset that
unlocks a large fraction; the wall is structural, not a missing keystone.

### Why the chain cannot be cut below `primary`

The brief's premise was "a partial chain won't let anything through", implying a full
one will. It does not, because the chain does not bottom out in literals — it bottoms
out in the query layer:

- `_parse_primary` → `_parse_paren` → `_parse_select` / `_parse_subquery` /
  `_parse_query_modifiers` / `_parse_set_operations`
- `_parse_field` → `_parse_function` → `_parse_function_call` (116 LOC) → `FUNCTIONS`
- `_parse_type` → `_parse_types` (254 LOC), `_parse_column_ops` → `_parse_bracket`

The direct-call closure of `_parse_expression` (excluding dispatch-table fan-out) is
**176 methods / 4,117 LOC**; including it, **383 of 405 methods / 7,877 LOC** — the
whole parser. So "implement `_parse_expression` and its full precedence chain" is
either 955 LOC that opens 31 rows, or it is all of P3.

### What this changes for the stub queue

The right unit is **not** "the method that blocks the most rows". Two signals replace it:

1. **Marginal closure** — `--brief <method>` prints rows-opened, not rows-blocked.
   Today only six methods have a non-zero marginal at all (`_parse_transaction` +30,
   `_parse_as_command` +8, `_parse_commit_or_rollback` +4, `_parse_show` +2,
   `_parse_analyze` +1, `_parse_refresh` +1). Everything else is 0 until its
   co-dependents land.
2. **Co-requisite groups** — `--curve` emits the achievable ordering (the open row
   needing the fewest new methods, repeatedly). Rows close in *clusters*, and the
   clusters are the real task units.

This is good news for parallelisation and bad news for burndown optics: because nearly
every method has marginal 0 in isolation, agents must be scheduled on **co-requisite
groups**, and no individual PR in such a group will move the EXACT count. A ratchet
that requires every PR to increase closed rows would block the entire queue.

## 2. Delivered: Rule 1 claim-overlap check

`tools/claim_overlap.mjs` — dependency-free, `node tools/claim_overlap.mjs --all`
(also `make claims`; `--pr N`, `--branch`, `--selftest`).

**Built as a script, not (only) as CI, and here is the honest reason.** §8.1 calls
claim-checking "a required CI check, actually enforced" and §8.5 lists it as gate (6).
Measured 2026-08-28: `actions/workflows` → `total_count: 0`;
`branches/main/protection` → **404, not protected**; `gh pr checks 6` → *no checks
reported*. **All ten of §8.5's gates are currently aspirational** — this repo has never
run CI. A workflow file alone changes nothing without a branch-protection rule naming
it, which is a repo-settings change an admin must make. `.github/workflows/claim-overlap.yml`
is included and says **ADVISORY — THIS DOES NOT BLOCK ANY MERGE** in its own header.

**Semantics.** File-granularity would flag two agents on two different `parser.js`
stubs — defeating Rule 2 outright — so the check is **unit-granular** for `parser.js` /
`generator.js`: `Class#method` (with its JSDoc + `// py:` anchor), `Class.TABLE[key]`
per entry, `Class::header`; file-granular elsewhere. Overlap = unit-set intersection.
Line numbers are never compared across PRs: each PR's hunks resolve to unit *names*
against its own merge base (from `compare(base...head).merge_base_commit.sha`, since
`/pulls/N/files` is a three-dot diff), so a stale base cannot produce a phantom overlap.

**Negative-tested, 24/24**, including the two that matter:

```
ok  ALL 382 stub-replacement pairs are conflict-free   (378 stubs, 71253 pairs, 0 conflicts)
ok  two agents on the SAME real stub -> flagged
```

Verdicts were validated against `git merge-file` ground truth, not just the tool's own
model. Real API: PR #6 vs #5 → 9 shared files, exit 1. No network → exit **2** with a
"THIS IS NOT A PASS" banner. With 0 open PRs it prints `OK (vacuous)` rather than a
bare OK.

## 3. Three defects found, none previously visible to any gate

**(a) `src/parser.js` has duplicate method names — 4 stubs are dead code.** The seeder
emitted Python `@t.overload` type-only declarations as real JS methods:
`_parse_query_modifiers` ×3 (L2671/2676/2681) and `_parse_json_object` ×3. In JS the
last definition silently wins. This also breaks Rule 2's proposed claim key
`parser.js#_parse_bitwise` — the name is not unique. **Needs a fix in
`tools/seed_static.py`.** (`claim_overlap.mjs` disambiguates by `// py:` anchor.)

**(b) `AMBIGUOUS_ALIAS_TOKENS` is seeded as an Array but consumed by `_match_set`.**
Upstream it is a tuple (`parser.py:1828`); Python `in` works on tuples, but the port's
`_match_set` calls `types.has(...)`, which arrays do not have. The first call —
`_can_parse_limit_or_offset`, reached from `_parse_alias`, i.e. the very first thing
`_parse_expression` does — throws `TypeError: types.has is not a function`, not
`NotPorted`. Audited all class tables: exactly 3 are Array-seeded, and this is the only
one of the 40 `_match_set` consumers among them, so the blast radius is one table.
Whoever lands `_parse_alias` hits this immediately.

**(c) Rule 2′'s adjacency assumption is off by one line.** Measured with `git merge-file`
on the real file: edits to lines 131/132 (zero separating lines) **conflict**; 131/133
and wider merge clean. The threshold is *zero* separating lines, not the 3 lines of
diff context one would guess. Two agents replacing consecutive `FUNCTIONS` seed lines
will hit a rebase conflict. Reported as a warning (exit 0; `--strict` to fail) — failing
would re-serialise the queue Rule 2′ exists to parallelise. Separately: two *insertions*
at the same point merge cleanly but in arbitrary order, and §4.6 makes table order
output-visible — a semantic hazard git will never report.

## 4. Tooling added

- **`tools/harvest/trace_parse_demand.py`** → `corpus/parse_demand.json` (2.4 MB,
  method names interned). Wraps every `Parser._parse_*` at the pin and records the
  method set per oracle row. Demand-driven, not static: the static closure
  over-approximates by ~10x because dispatch tables fan out to everything. Refuses to
  run without `PYTHONHASHSEED=0`.
- **`tools/closure_parser.mjs`** — `--brief` (marginal for one method), `--add`,
  `--curve`, default burndown.
- `tools/claim_overlap.mjs`, `tools/claim_overlap_selftest.mjs`,
  `.github/workflows/claim-overlap.yml` (advisory), `Makefile`, `spike/run_all.sh`.

## 5. Regression

- `bash spike/run_all.sh` — **ALL PROBES GREEN** (exit 0)
- `bash spike/run_regex.sh` — GREEN
- `node --test $(find test -name '*.test.mjs')` — **57/57**
- control-byte, unicode, license, deny, identity lints — clean
- `node tools/claim_overlap.mjs --selftest` — **24/24**
- `src/parser.js` **unmodified** this round; `grep -c 'throw new NotPorted'` = 379

## 6. Recommended next step

Not `_parse_expression` alone. Either:

- **(A) Ship the chain anyway as infrastructure**, on the honest label "+31 rows, converts
  1 serialized blocker into 304 parallelizable ones" — it is 955 LOC and it is genuinely
  the spine; or
- **(B) Schedule by co-requisite group** using `--curve`, starting with the cluster that
  reaches 14.1% at ~45 methods.

**(B) is the better use of 6–8 agents**, and either way fix defects (a) and (b) first —
they are both one-line fixes that will otherwise burn the first agent into `_parse_alias`.

### Stub queue group D — functions and windows (2026-08-28)

Implemented the 20 assigned function-call, lambda, limit/group, heredoc, and window parsing methods from `parser.py` at `91119bc`. Closure remains **41/15,540** as expected for the conjunctive six-group landing; implemented parser methods increased from 29 to 49. Native tests remain 57/57. `spike/run_all.sh` currently stops during corpus generation with the baseline environment error `Unable to set __version__, run pip install -e .`, before running probes.

## Stub queue group A — DDL/DML/transactions (2026-08-28)

Implemented the 54 assigned DDL, DML, transaction, grant/revoke, analyze, alter, and set-operation parser methods. `parse_set_operation` is a real upstream method at `parser.py:5901`, not a trace artifact.

Closure after this branch: 59 / 15,540 rows closed (the conjunctive closure remains dominated by co-requisite methods on sibling branches); parser stubs reduced from 379 to 321.
