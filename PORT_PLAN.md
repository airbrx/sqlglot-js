# sqlglot-js — Port Plan (final, revision 4 — v0 redefined per Ben's decisions)

**Repo:** `airbrx/sqlglot-js` · **Upstream pin:** `sqlglot @ 91119bc` · **Reference clone (read-only):** `/tmp/sqlglot-ref`

This revision incorporates two independent adversarial reviews, a post-review addition (recursion depth, C1/R11) found by the orchestrator after both reviews had signed off, and **Ben's answers to Q1–Q5 (2026-08-24)** — see §9. The consequential answer is Q2: **v0 now ships at P8, not P6.** Product requires Snowflake, Databricks, DuckDB, and Postgres at launch, so every place the old P6 boundary was load-bearing (§1, §7 P6/P8, §9, §10) has been updated. §2–§6 and §8 are unaffected and stand as written. Every objection from the two adversarial reviews is dispositioned in the Appendix; four are deliberately rejected or narrowed, with rationale stated inline. All closure numbers in this document are recomputed from `/tmp/recon/runtime_calls.json` by the checked-in calculator (§3.2), not asserted in prose.

---

## 1. Objective, constraints, and the definition of done

Port `sqlglot` — SQL parser, transpiler, and optimizer — from Python to JavaScript.

**Hard constraints (Ben):**

1. **Zero runtime dependencies.** `dependencies` and `devDependencies` both empty, enforced by CI lint. No bundler, no polyfill, no transitive anything. Node ≥ 20 and modern browsers, ESM, `.js` only (JSDoc types, `tsc --checkJs` advisory).
2. **Tested against upstream's own tests, in situ**, so the port tracks upstream as it moves. This is the core design constraint. A plan that produces a one-time snapshot and then diverges is a failing plan.
3. **Dialect priority: Snowflake > Databricks > Postgres > everything else.** Confirmed by the data (§9 Q1) — the draft's contrary recommendation was based on an arithmetic error and is withdrawn. Ben's own framing, confirming both the order and DuckDB's inclusion: *"Our product requires Snowflake, Databricks, DuckDB and Postgres. Those go first."* DuckDB was already a forced v0 dependency regardless of priority (§7 P6 — 449 of TestSnowflake's `validate_all` calls write to it), so this confirms rather than changes the existing phase order.
4. The output must be executable by a fleet of parallel implementation sub-sessions (§8).

**v0 boundary — decided by Ben (2026-08-24, §9 Q2):** v0 ships at **P8** (Snowflake + Databricks chain + DuckDB + Postgres/Redshift + default; 42.0% atom closure), not at P6 (21.8%). *"We will ship at P8."* No interim release at P5 or P6 (§9 Q3: *"We don't need an interim release"*). This is the only decision that changes the architecture's shape — see §7 P6/P8 and §10 for the restated milestones and effort.

**Definition of done, stated as a number.** Upstream's dialect suite decomposes into **15,540 atoms** — the real, harvested count (§3.2), superseding the 15,642 estimate the plan was originally written against. "Done" for a phase means *every atom whose read dialect and write dialect are both in scope is green*, machine-verified. 100% of the corpus is the terminal state (P9/P10), reached only with a documented `wontfix` list.

**Explicitly out of scope, permanently:** `tests/test_executor.py` and the 201 `# execute: true` execution assertions in the optimizer fixtures. sqlglot's Python executor is not being ported. The SQL-comparison half of those fixtures is kept.

**Byte-exactness claim, stated honestly.** Output SQL is byte-identical to Python sqlglot **for the surface the corpus covers**. Outside that surface — Unicode paths, `unsupported()` messages, the 19 generator methods the dialect suite never exercises — correctness rests on differential fuzzers (§3.4), machine-generated deny-lists (§4.6), and human review (§8.5), not on tests. That distinction is real and is not papered over anywhere in this document.

---

## 2. Strategy: hand-porting, and why the transpiler was rejected

A source-to-source Python→JS transpiler was prototyped and **rejected**. It reached 99.03% syntactic coverage, which sounds decisive and is not: `visit_ClassDef` was `pass`, and sqlglot *is* its class hierarchy — 1,048 expression classes and ~20 dialect derivations built by class-attribute inheritance and metaclass merging. Worse, 2,674 method calls are ambiguous between a Python builtin and a sqlglot method of the same name (`.pop()`, `.copy()`, `.find()`, `.replace()`, `.sql()`); a transpiler must resolve those with types it does not have, whereas a human resolves them by reading two lines of context.

We hand-port, under a **transliteration contract**: same file layout, same class names, same method names, same method order, same control flow, `// py: sqlglot/parser.py:6302` anchors on every method. The goal is that a future upstream diff can be *read* against the JS file. Idiomatic JS rewrites are a lint failure and a review rejection (§4.2, §8.5).

The corresponding cost is that fidelity is enforced by discipline plus lint, not by a compiler. That is R1, the plan's weakest joint, and §8.5/§10 now budget the mitigation explicitly.

---

## 3. Verification architecture

### 3.1 What is harvested from upstream, and where

Harvesting happens at the **`Validator` seam** — `validate_identity` / `validate_all` / `Validator.transpile` — at *call* granularity, not by instrumenting `parse_one` (which sees 52 internal calls and pollutes counts).

Four artifacts, all under `corpus/`, all committed, all regenerable by `make corpus` inside the pinned toolchain container (§5.2):

**(A) Declarative corpus — `corpus/atoms.jsonl`.** 8,415 harvested calls (5,398 identity, 3,005 validate_all, 12 transpile) expanded into an estimated 15,642 atoms; the real harvested count is **15,540** (§1, §3.2 below). Row schema:

```json
{"atom_id":"a1f3c9d2","input_id":"7c02...","expect_hash":"91ab...",
 "cls":"TestSnowflake","read":"snowflake","write":"duckdb",
 "sql":"...","expected":"...","pretty":false,"identify":false,
 "unsupported":[], "py":"tests/dialects/test_snowflake.py:412"}
```

`input_id = H(sql, read, write, pretty, identify)`; `expect_hash = H(expected, unsupported)`. The split is what makes the ratchet safe (§3.3).

**(B) AST oracle — `corpus/ast/<dialect>.jsonl`.** Own lossless dumper (`tools/astdump.py`), **not** sqlglot's `serde`, which drops 34% of arg entries (`None` and `[]`) and would let a wrong AST satisfy the gate. Schema:

```json
{"atom_id":"a1f3c9d2","ast":{"c":"Select","a":[["expressions",[...]],["from",null]],
 "m":{"line":1,"col":7,"start":0,"end":12},"cm":null},
 "repr":"Select(\n  expressions=[...])"}
```

`a` is an **ordered array of `[key, value]` pairs including nulls and empty lists** — this pins `arg_types` insertion order, which is observable in output SQL (§4.6). `repr` is Python's `Expression.__repr__`, byte-exact; asserting it is what makes the AST gate non-tautological and human-readable.

**(C) `astLoad` contract.** `astLoad` constructs with a no-arg constructor and `set()`, bypassing `__init__` — exactly like Python's `serde.load`. It **must not** run `INIT_HOOKS`. Concretely: kwargs-construction of `DateAdd` uppercases the unit; `astLoad` does not. This is frozen in `CONTRACTS.md` and unit-tested at P2.

**(D) Generate oracle — `corpus/gen/<dialect>.jsonl`.** Row = `{atom_id, ast_ref, dialect, flags, sql, unsupported_messages}`.

> **New (fixes review-B O3).** `tests/dialects/test_dialect.py` hardcodes `unsupported_level=ErrorLevel.IGNORE`, and `generator.py:965` returns early — so **497 `unsupported()` calls across the dialect suite are silently discarded** and a port that never calls `unsupported()` is byte-identical under the corpus. But `gen.unsupported_messages` *survives* the IGNORE path. Capturing it is a two-line harvester change that converts 497 invisible calls into hard assertions. It is now part of the row schema and part of P4's exit.

### 3.2 The atom model and the closure calculator

An **atom** is one `(read_dialect, write_dialect, sql, expected, flags)` tuple. `validate_identity(sql)` on dialect `d` yields one atom `(d, d)`. `validate_all(sql, read={r: s}, write={w: t})` on dialect `d` yields one atom per read entry `(r, d)` and one per write entry `(d, w)`. The default dialect is normalized to `""` (upstream stores it as both `None` and `""`). Versioned dialect strings — `"clickhouse, version=23.8"`, `"postgres, version=17.5"` — are distinct dialects and require `compareVersion`.

An atom is **closed** under an implemented dialect set `S` iff both its read and write dialects are in `S`. Because closure is a *pairwise* condition, coverage grows roughly quadratically in the number of implemented dialects; this is the single most important fact about the schedule and it is published at P0 as a curve, not discovered at P6 as a disappointment.

`tools/closure.mjs` computes this from `corpus/atoms.jsonl` and is the source of every phase exit number in §7. Machine-computed, checked in, reproducible:

**Regenerated from the real harvested corpus, 2026-08-25.** The table below is now emitted by `node tools/closure.mjs --markdown` against `corpus/atoms.jsonl`, not estimated. The estimate this plan was written against was ~15,642 atoms; the real count is **15,540**, a 102-atom / 0.65% delta — the same order as the pre-existing 3,417-vs-3,421 footnote below. **Percentages are unchanged to within 0.1pp at every phase**, so the arithmetic and the P8-ships-v0 conclusion stand unaltered. Per-test-class closure and the recomputed P9 greedy ordering are in `CLOSURE.md`.

| after phase | dialect set | atoms closed | % of 15,540 | marginal |
|---|---|---|---|---|
| P4 | `{snowflake}` | 1,595 | 10.3% | +1,595 |
| P5 | `+ default` | 2,000 | 12.9% | +405 |
| P6 | `+ duckdb` | 3,394 | 21.8% | +1,394 |
| P7 | `+ hive, spark2, spark, databricks` | 5,178 | 33.3% | +1,784 |
| **P8 (v0)** | `+ postgres, redshift` | **6,522** | **42.0%** | +1,344 |
| P9 | all 46 dialect keys | 15,540 | 100% | +9,018 |

*(Superseded estimates, for comparison: P4 1,606 · P5 2,022 · P6 3,417 · P7 5,207 · P8 6,552 · P9 15,642.)*

*(v0 boundary per Ben's decision, §9 Q2, 2026-08-24: "We will ship at P8." Bolded row updated accordingly from the original P6.)*

**Two census corrections the real corpus forces**, neither schedule-relevant: the dialect key count is **34 base + 12 versioned = 46**, not "38 + 14"; and the versioned keys contribute **+22**, not +28. Every versioned key appears **only as a write target** (0 occurrences as a read dialect), which narrows `compareVersion` (§7 P8) to the generate path.

*(The independent derivation that produced 3,421 rather than 3,417 at P6 is now moot: the calculator run against the real corpus gives **3,394**, resolving the 12 `Validator.transpile` rows in `TestDAX` as `(dax → write_dialect)`. Settled by running it, as intended.)*

> **Not yet regenerated:** the per-phase **Exit** criteria in §7 still quote the old estimates (e.g. "1,606 atoms closed under `{snowflake}`" at P4). Substitute the table above; `CLOSURE.md` carries the per-class figures those exits also cite.

### 3.3 The ratchet

Three states per atom: `pass`, `todo`, `wontfix`, plus a fourth, `quarantine`.

- **Rule 1.** An atom listed `pass` that fails → build failure.
- **Rule 2.** An atom listed `todo`/`wontfix` that passes → build failure (prevents rot).
- **Rule 3.** `todo` may only shrink for in-scope dialects.
- **Rule 4.** On resync, atoms whose `input_id` is *new* may enter `quarantine` (neither pass nor regression) pending triage. This is what stops the ratchet from deadlocking on the ~1,100 new atoms a large upstream bump brings.
- **Rule 5 (the F1 fix).** An atom whose `input_id` is **known** but whose `expect_hash` **changed** may *never* be quarantined. It hard-fails and requires an explicit human decision recorded in `UPSTREAM-NOTES.md`. Without this split, quarantine silently absorbs changed expectations and the dashboard goes vacuously green — the single most dangerous failure mode available to this design.

### 3.4 Differential fuzzers

Generic fuzzing does not find the hazards that matter here, because **the harvested corpus is 13 non-ASCII strings out of 54,980 — 0.024%**. Five named fuzz targets, each with its own generator, each an explicit phase exit criterion:

1. **`fuzz_decimal.py`** — generative (not sampled) over the *reachable* Decimal operation set (§4.6, B5): `+ - * /` on `Decimal`/`int`, unary neg, `str(Decimal)`, `str(float)`, comparison against `DataTypeParam` bounds.
2. **`fuzz_regex.py`** — validates `_py/re.js` against CPython `re`: group counting, named groups, `\A`/`\Z`, `re.VERBOSE`, `re.sub` template semantics (`\1` vs `$1`), `re.escape` output validity under `/u`.
3. **`fuzz_unicode.py`** — `isprintable`/`islower`/`isupper`/`isspace`/`strip` over the full `sys.maxunicode` range; identifier-quoting decisions (`\w`); error-message column positions with astral characters.
4. **`fuzz_toowide.py` — new, mandatory (fixes review-B O2).** `Generator.too_wide` (`generator.py:4711`) uses Python `len()` (code points); a port writing `.length` (UTF-16 units) passes **15,642/15,642 atoms and is wrong**. Instrumentation shows 118 `too_wide` calls in the dialect suite, 12 returning `True`, **0 with any non-ASCII argument**. The generator must synthesize `SELECT` lists of N multi-byte identifiers whose summed rendered code-point width straddles 80, under `pretty=True` **and** `dynamic=True`. A generic Unicode fuzzer will not construct that.
5. **`fuzz_comments.py` — new, mandatory.** `sanitize_comment` (45 calls, all ASCII in corpus) with `*/`, `/*`, non-ASCII, and astral characters; plus `indent`/`_replace_line_breaks` with astral characters inside string literals.

Targets 4 and 5 exist because M4 and M5 were previously "solved by a lint that no test can confirm." A lint that no test confirms is a comment.

### 3.5 Why the corpus is the gate, and the bridge is not

The dialect suite is ~91% declarative: 4,467 `validate_identity` + 2,755 `validate_all` versus 683 imperative asserts. Those calls are pure data — (input SQL, read dialect, expected output SQL, flags) — so they transfer to a JS runner losslessly and run with zero Python at test time.

Independent instrumentation confirms the corpus is a strong oracle for the generator surface: **405 of 424** base `Generator` `*_sql` methods are exercised by the dialect suite. The 19 misses are `add_column_sql`, `booland_sql`, `boolor_sql`, `characterset_sql`, `check_sql`, `connector_sql`, `createable_sql`, `generatedouble_sql`, `generateint_sql`, `get_put_sql`, `jsoncast_sql`, `kill_sql`, `partition_by_sql`, `schema_columns_sql`, `semicolon_sql`, `tag_sql`, `token_sql`, `uncache_sql`. These get **hand-written native tests** at the phase that ports them — not `wontfix`, because they are reachable from user code even though upstream's suite misses them.

### 3.6 Native hand-ported suites

The corpus tests *transpilation*. It does not test the JS **data model** — `copy`, `eq`, `hash`, `parent`/`depth`, `meta`, mutation APIs. Those are tested by hand-porting `tests/test_expressions.py` into `test/expressions/` as real JS tests.

**Corrected 2026-08-25, verified directly against the pinned `tests/test_expressions.py`** (found by P2, which correctly refused to force a match rather than silently under- or over-counting): the "81 deep `assertEqual`s + 185 `assertIsInstance`es" figure above was never measured against real source and does not correspond to any natural counting of the file — the true totals are **283 `assertEqual`s + 120 `assertIsInstance`es across 71 tests**, and of those, only **6 tests (6 `assertEqual`s + 3 `assertIsInstance`es)** — `test_identifier`, `test_properties_from_dict`, `test_parse_identifier`, `test_literal_number`, `test_update_positions_empty_meta`, `test_pipe_and_apply` — have zero dependency on `parse_one`/`.sql()`. The remaining 65 tests build their fixtures via `parse_one` and/or assert on `.sql()` output, which do not exist until P3 (parser) and P4 (generator) land; almost all use the **default dialect** (2 of 65 explicitly need `bigquery`/`spark`).

**Ben's decision (2026-08-25, §9 Q6):** hand-port only the 6 parser-independent tests at P2 — that is P2's hard gate, not deferrable. The remaining 65 are tracked as an explicit P4 exit-criterion addition (§7 P4), not silently dropped: P4 is the earliest phase where both the base parser and base generator exist to run them for real. **This is a genuine, documented scope reduction from the original (wrong) 81/185 figure, not a quiet skip** — the whole point of §8.5's human-review gate and this section's original "not deferrable" framing was to prevent exactly that failure mode, which is why the deferral is written down here with the real numbers rather than absorbed into a rounder-sounding but fabricated count.

### 3.7 The structure channel: `sync_report.py`

Detecting breakage is not the same as propagating change. `tools/sync_report.py` emits, per upstream bump, a **method manifest diff**: for every ported file, methods added / renamed / deleted / body-changed, with line anchors on both sides. That is the work item generator for maintenance. Corpus diffs tell us *that* something broke; the manifest diff tells us *what to port*.

### 3.8 The bridge — scope, and its proven limits

`tools/bridge/` runs upstream's **imperative core tests** against the JS library via an NDJSON protocol and a Python proxy object. It is a *supplementary* gate for the ~1,419 `assertEqual`s that drive the Python API directly and have no declarative form.

Two corrections from review:

- **`test_build.py` is removed from the bridge list.** It is 228 lambdas, **38 of which apply Python operators to `exp` objects** (`x + 1`, `x // 1 → CAST(x / 1 AS INT)`, `x & 1`, `~x`, `x[...]`). Running these through a proxy would require reimplementing `__add__`/`__floordiv__`/`__and__`/`__invert__`/`__getitem__` inside the bridge — i.e. rebuilding the operator layer we already decided to hand-port. `test_build.py` becomes a hand-ported native suite in P5.
- **Proxy-satisfiability is proven at P0, not assumed at P5.** The bridge was narrowed (M15/M16) to exactly the tests that compare *object graphs* — the workload it is least able to serve. So P0 ships **two end-to-end bridge proofs**: `test_errors.py` (cheapest — 36 of 48 `assertEqual`s are string literals) and `test_transpile.py` (most representative). `CONTRACTS.md` records, per remaining module, whether it is proxy-satisfiable and why. Discovering the proxy's object-model ceiling at P5 would be a four-month-late surprise.

Bridge modules at P5: `test_transpile.py`, `test_errors.py`, `test_generator.py`, `test_time.py`, `test_schema.py`, `test_jsonpath.py`, `test_transforms.py`, `test_diff.py`. An **allowlist** (checked in, size stated in `UPSTREAM-NOTES.md`, one entry per PR justified) records the assertions the proxy cannot serve. 229 of 772 dialect methods are AST-introspecting today, growing ~6.5/month — the bridge is not the dialect gate, so this decay does not threaten conformance, but the count is printed in the weekly sync issue.

---

## 4. Runtime design and code layout

### 4.1 Layout

Mirrors upstream one-to-one:

```
src/
  _py/        num.js str.js re.js sort.js collections.js datetime.js  (Python semantics shims)
  _gen/       expr_meta.js dispatch/ unicode.js  (generated; never hand-edited)
  expressions/  parsers/  generators/  dialects/  optimizer/  typing/
  tokenizer.js tokens.js parser.js generator.js transforms.js schema.js time.js
  helper.js errors.js trie.js jsonpath.js
tools/        harvest/ astdump.py bridge/ closure.mjs ast_diff.mjs lint_*.mjs fuzz_*.py Dockerfile
corpus/       atoms.jsonl ast/ gen/ deny/ PROVENANCE.json
test/         runner.mjs expressions/ build/ ratchet.json
```

### 4.2 Fidelity rules, machine-checked

`tools/lint_fidelity.mjs` enforces: every ported file carries a `// py:` header naming its upstream path and the pinned commit; the exported method-name set equals upstream's; method **order** equals upstream's source order; `cpLen()` is used instead of `.length` inside `generator.js` and `time.js`; and both deny-lists (§4.6) are clean. It cannot check that a *body* is a transliteration — that is §8.5's human gate.

**New rule, added 2026-08-25: no raw control bytes (`\x00`–`\x1F` excluding tab/newline/CR) in committed source.** This recurred **four separate times** during P0 across two independently-developed branches, always via the same mistake — using a literal control byte as a string separator to avoid collision ambiguity (a NUL-separated `frozensetKey`, literal ESC bytes in ANSI color constants, a NUL-separated key in the ratchet's `gapKeyOf`, a NUL-separated cache key in `_py/re.js`). The damage is worse than a wrong value: `file`/`grep` silently classify the whole source file as binary the moment one lands, which neuters every grep-based check in this document (`lint_fidelity.mjs`'s own header/order checks included) without any error — exactly the vacuous-green failure mode §3.3 exists to prevent, just entering through source hygiene instead of test logic. The fix is always the same and always available: `JSON.stringify([...parts])` for a composite key, never raw-byte concatenation. A new standalone `tools/lint_control_bytes.mjs` (P0, wired into `spike/run_all.sh`) scans every source file under `src/`, `tools/`, `spike/` for bytes in that range and hard-fails — the fifth occurrence is a lint failure, not a fifth independent discovery. `lint_fidelity.mjs` (§4.2, a P2+ deliverable once ported files exist to check header/order fidelity against) should absorb this same check when it's built, rather than running two separate lints in parallel.

**Confirmed by the P0 go/no-go spike (2026-08-25):** `\p{...}` runtime regex escapes are banned outright inside `src/_py/` and `src/tokenizer*.js` — not a style preference, a correctness requirement. Measured: the best `\p{...}` candidate for `isprintable` diverges from CPython on 11,130 of 1,114,112 code points, and the corpus is 0.024% non-ASCII, so this would pass every corpus test and ship silently wrong (same hazard class as `too_wide`/R4). `isprintable`/`islower`/`isupper`/`isspace`/`istitlechar` must route through the generated tables in `_gen/unicode.js` (§4.3 item 3), which were verified exact over the full range. `lint_fidelity.mjs` denies any `\p{` literal in those paths.

### 4.3 Code generation, correctly scoped

An earlier draft claimed 12–18 kLOC of codegen savings. Measured: **~4.3 kLOC**, because 76% of dialect dict entries (and 94% in `generators/`) are *callables*, not literals. Codegen is therefore scoped to exactly four things:

1. `_gen/expr_meta.js` — the 1,048 expression classes: ordered `argTypes`, `requiredArgs`, traits, `initOwner`.
2. `_gen/dispatch/` — the resolved method-dispatch table per generator class (prototype walk, sorted, TRANSFORMS-beats-`*_sql`), used to *assert* the runtime builder, not to replace it.
3. `_gen/unicode.js` — full-range `isPrintable` / `isLowercase` / `isUppercase` / `isSpace` tables.
4. Derived lookup tables that are pure literals.

Behaviour tables are hand-written. `tools/seed_static.py` drafts the literal portion of each so the human starts from a filled skeleton.

### 4.4 The class-attribute inheritance model

sqlglot dialects override class-level dicts and sets (`TOKENIZER` settings, `FUNCTIONS`, `TRANSFORMS`, `PROPERTY_PARSERS`), merged by Python's MRO and by metaclass `__init_subclass__` logic. JS reproduces this with an explicit `registerDialect` / `initTokenizerSubclass` derivation performed once at module init, in upstream's declaration order, with the final state asserted against a generated snapshot (parity probe #4). Import-time mutation of `TRANSFORMS` in `dialect.py:304-309` is reproduced including its aliasing behaviour (R7).

### 4.5 Equality, hashing, and value-keyed containers

`Expression.__eq__`/`__hash__` are not structural equality: Python skips falsy args and conditionally lowercases. The relation is **consumed by `.index()` inside `_move_ctes_to_top_level`, which runs on every generate**, so getting it wrong is not academic. We reproduce Python's exact projection (falsy-skip + conditional lowercase), at **true 64 bits via two 32-bit lanes** — a 32-bit hash truncates and silently changes `while_changing()`'s fixpoint in `simplify`.

`_py/collections.js` provides `ExprSet`, `ExprMap`, and `frozensetKey` for the value-keyed containers upstream relies on. A dedicated differential harness harvests every `(a, b, a == b)` triple the Python dialect suite produces and asserts the JS relation matches.

`_py/sort.js` provides `pySortedTuples`, reproducing Python's tuple comparison including the `exp.Xor` branch where `Expr.__lt__` returns a *node* rather than a bool. The exact permutation on a tie is a CPython Timsort artifact; if it diverges, that surfaces as a corpus failure and goes to `wontfix` with a citation.

### 4.6 The hazard census and the deny-lists

Every hazard below was found by targeted probing, never by the test suite. Each is either shimmed in `_py/` or machine-listed in `corpus/deny/` with a CI lint requiring the site to route through the shim.

**Numeric.** `_py/num.js` provides `pyInt`/`pyFloat`/`pyDecimal` tagging, BigInt for arbitrary precision, `pyFloatToStr` (4 known divergences from `String(x)`), and `Decimal`. Scope (per review-B O5, verified): numeric literals are **echoed verbatim as strings** and never reformatted — `'SELECT 1.10' → 'SELECT 1.10'`, `'SELECT 1e300' → 'SELECT 1e300'` — so `Decimal` is required only where arithmetic happens: `optimizer/simplify.py:1254-1270`, reached on the v0 path via `generator.py:5387` (`_simplify_unless_literal`, gated on `LIMIT_ONLY_LITERALS`), plus `dialect.py:2457`, `generators/postgres.py:63`, `generators/teradata.py:22`. Measured: **63** such invocations across the whole dialect suite, not the 11,921 previously cited. `_py/num.js` is therefore scoped to `+ - * /`, unary neg, comparison, and `str()` — **not** a general CPython `decimal` clone. It stays in P0 and stays a go/no-go gate (the mixed-case `E+18`/`e+18` literal asserted at `test_snowflake.py:367` is real), but the budget drops from 60–100h to 40–70h. BigInt sites: `clickhouse:491`, `postgres:563`, `hive:131/508`, `dialect:2242`, `parser:10211`.

**Strings.** `pyStrip`/`pyLstrip`/`pyRstrip` and `isSpace` from full-range tables — Python `isspace()` and JS `\s` differ on exactly 6 code points (Python-only `{1c,1d,1e,1f,85}`, JS-only `{feff}`), and `generator.js` has 23 strip sites reaching `sanitize_comment` and `generate()`. `cpLen()` for `too_wide`. `pyRepr` for list/tuple/set/dict rendering inside error and warning messages. `islower`/`isupper` via `\p{Lowercase}`/`\p{Uppercase}` full-range tables (naive approximations are wrong on 292/187/984 code points depending on the approximation chosen). `isPrintable` gates `ESCAPED_SEQUENCES`.

**Three sites added by review B, all on the v0-or-near path, all corpus-invisible:**

- **UTF-8 byte length.** `parsers/clickhouse.py:63` — `len(sep_value.encode("utf-8")) == 1`. Corpus coverage is `splitByChar('', x)` only. `splitByChar('é', x)` must produce `Anonymous`, not `Split`; a `.length` port produces `Split`. Fix: `utf8Len()`; deny-list `.length` on strings inside `parsers/`.
- **`chr()` beyond the BMP.** `generators/singlestore.py:25` — `chr(int(m.group(1), 16))`. `String.fromCharCode` truncates above `0xFFFF`, and Python `chr()` also accepts lone surrogates. Fix: `pyChr()`; deny-list `String.fromCharCode` outright.
- **Format-spec mini-language.** `parsers/dremio.py:65` — `f"{int(year.this):04d}-..."`. `padStart` diverges from `:04d` on negatives (`0-01` vs `-001`). Only 3 sites repo-wide. Fix: `pyFormatInt(n, width)`.

**Regex.** `_py/re.js` with a hand-written Python-regex group counter and validity oracle (needed because `generator.py:1667` and `bigquery.py:127` build regexes at *runtime*, so build-time rewriting is impossible), `pyReEscape` producing `/u`-valid output, and `re.sub` template translation. `\w` maps to `[\p{L}\p{Nd}\p{Nl}\p{No}_]` — this gates identifier quoting, so it is directly output-visible.

**Verified by a dedicated differential corpus (2026-08-25, `p0-regex-corpus`): 2,867/2,867 on every pattern sqlglot actually reaches, 0 fail, 0 skip.** `[\p{L}\p{Nd}\p{Nl}\p{No}_]` is confirmed the correct `\w` mapping — 0 CPython-only code points on a full-range sweep, where the more obvious `\p{Alphabetic}` and `[\p{L}\p{M}\p{Nd}\p{Pc}]` both fail — and it is genuinely output-visible: `exp.select(exp.column('café')).from_('t').sql()` is `SELECT café FROM t`; a naive `\w` port quotes it (`SELECT "café" FROM t`). Two residuals, both accepted:
- **Unlike the four `_py/str.js` predicates, `\w`/`\d` genuinely cannot route through a static generated table** — they're embedded inside dynamically-constructed, dynamically-compiled regexes (`generator.py:1667`, `bigquery.py:127`), so they must use a real runtime `\p{...}` JS regex at match time. The residual divergence measured is 100% attributable to Unicode-DB version skew (Node's ICU 16.0 vs the harvesting interpreter's `unicodedata` 13.0.0) — the same axis as R6/§5.2's Unicode finding, but for a construct that can't be worked around the way the static predicates were. `corpus/PROVENANCE.json` records both `unidata_version` (harvesting interpreter) and the consuming runtime's `process.versions.unicode`, so the gap is measured and visible, not silently absorbed.
- **`\N{NAME}` (Unicode character-name escapes) is accepted as an unsupported gap, not built.** Exact validity requires shipping a full Unicode character-name table for a construct sqlglot's real patterns don't reach (BigQuery, the one dialect with runtime-constructed patterns using this feature space, uses RE2 semantics regardless). Recorded in `CONTRACTS.md`'s `_py/` surface notes rather than implemented.

Four other divergences were found and closed, each worth naming because a competent port gets them wrong silently: `re.escape` output that doesn't compile under `/u`; a lone `]` (valid Python regex syntax, a JS `SyntaxError` — reachable via `UESCAPE ']'`); CPython's `must_advance` empty-match scan protocol (reachable via `UESCAPE '|'`); and match offsets being code points, not UTF-16 units — that last one is corpus-invisible upstream, the same hazard class as `too_wide`.

**Datetime — promoted to P0 (fixes review-B O1, the most serious finding in either review).** `sqlglot/time.py:65-85`:

```python
parsed = datetime.datetime.fromisoformat(timestamp_literal)
subsecond_digit_count = len(str(parsed.microsecond).zfill(6).rstrip("0"))
```

The docstring says it: *"Python prior to 3.11 only supports 0, 3 or 6 digits in a timestamp literal."* The `except ValueError: return 0` swallows the difference. Measured on this box (CPython 3.9.25):

```
'2023-01-01 12:13:14.1234'   -> 0     # 3.11+ returns 6
'2023-01-01 12:13:14.123456' -> 6
'2023-01-01 12:13:14Z'       -> 0     # 'Z' rejected pre-3.11
```

This reaches output SQL through `dialect.py:1796` (`timestrtotime_sql(..., include_precision=True)`) → `CAST(x AS TIMESTAMP(6))` vs `CAST(x AS TIMESTAMP)`, consumed by `generators/trino.py:45`, `mysql.py:203`, `tsql.py:111`, `postgres.py:397`, and it is live in the corpus at `test_dialect.py:848,856`.

**So the golden expectations encode the interpreter version that harvested them.** Q5 previously framed the 3.9 floor as a tooling-lifetime problem; it is a *corpus-provenance* problem, and when upstream bumps its floor, re-harvesting silently changes expected SQL and the ratchet either reports a false regression or absorbs it — the exact F1 mode we claim to have closed. Three-part fix: (a) `corpus/PROVENANCE.json` records the exact CPython **patch** version, and the runner hard-fails on mismatch without `--rebaseline`; (b) `pyFromIsoFormat` in `_py/datetime.js` implemented against a *named, pinned* CPython grammar — 3.9's restricted subset, not ISO-8601, and emphatically not `new Date()` — moved from P10 to **P0**; (c) a targeted differential test over fractional-digit counts 0–9 × {`Z`, `+00:00`, none} × {`T`, space}.

**Deny-lists, all machine-generated, all CI-linted:**

- `corpus/deny/operators.json` — **115 operator-overload sites inside `sqlglot/` itself** (corrected 2026-08-25 from an earlier estimate of 68 — see below), e.g. `dialect.py:1782` (not `:1778` as earlier cited — the one example used to justify this mechanism had already drifted from upstream) builds AST with `exp.Length(...) - exp.paren(expression.expression - 1)`; `((value - 1) // 32768) + 1` on an `exp.Expr` builds nodes, not numbers. The agent contract ("transliterate; never use `Number` for SQL literals") *actively produces wrong code* at these exact lines, which is why they must be listed rather than reasoned about.
- `corpus/deny/implicit_str.json` — **58 SQL-rendering implicit `__str__` sites** (+2 `__repr__`) that render with the default dialect (corrected 2026-08-25 from an earlier estimate of 26).

**Deny-list census corrected 2026-08-25** (`p0-regex-corpus`, a real Python-AST walk over `sqlglot/`, not tests): `operators.json` **115** (not 68, 1.7×), `implicit_str.json` **58 + 2** (not 26, 2.2×), `py_builtins.json` **17 confirmed sites** (the plan previously cited 3 illustrative examples, not a full count — all 3 present, 14 more found). The plan's own stated justification for `py_builtins.json` — that the `_py/` surface was derived from recon briefs rather than an exhaustive census — turned out to apply to the other two lists as well. **Confidence is stratified, not uniform:** 24/115 operator sites and 13/58 implicit-str sites are labeled `low` confidence, because `.this` holds a plain `str` on some node classes and static analysis alone can't always distinguish an `Expr` operand from a scalar one. A companion `instrument_operators.py` (patches all 26 node-building dunders and runs upstream's suite to turn static verdicts into ground truth) is written and committed but **has not yet been run** — it hits the same auto-mode permission gate the harvester did, and needs the same kind of explicit authorization before it can upgrade `low`→`confirmed`. Until then, `low`-confidence sites get an acknowledgement marker in the lint (proves a human/agent looked at the line) rather than a hard guarantee.
- **`corpus/deny/py_builtins.json` — new (fixes review-B O4).** The `_py/` API surface was previously derived from recon briefs rather than from an exhaustive census, which is how the three sites above were missed. This file is a *generated* enumeration of every call to `encode`, `chr`, `ord`, `zfill`, `rjust`/`ljust`, `partition`, `splitlines`, `rsplit`, `startswith`/`endswith` with tuple args, and every f-string format spec, with a lint requiring each site to route through `_py/`. Same mechanism as the operator and implicit-`__str__` lists; it just needed to cover builtins too. Regenerated on every upstream bump.

**Indexing.** The tokenizer returns `{tokens, codePoints}`; `errors.js` and `parser.js` slice the **code-point array**, never the JS string, so error columns and `highlight_sql` are correct under astral characters. Frozen in `CONTRACTS.md` at P0 because three components depend on it.

**Determinism.** Verified: `name_sequence` (`helper.py:260`) is per-`Generator`-instance (`generator.py:928`) and a fresh generator is constructed per call, so output is intra-process deterministic — confirmed by three identical repeat transpiles across three dialects. No hidden global counter.

### 4.7 Recursion depth — a structural gap, not a shim

*Added after the adversarial reviews; missed by all four architects and both reviewers.*

sqlglot is a recursive-descent parser with a recursive generator, and **Python and JS differ here in kind, not degree**:

| | Python | JS |
|---|---|---|
| limit | `sys.setrecursionlimit`, tunable at runtime | fixed per engine, **not tunable from library code** |
| failure | `RecursionError` — a normal, catchable exception | `RangeError` — catchable, but unwinding mid-generate is not a supported recovery path |
| headroom | commonly raised to 10k–100k | measured below |

**Measured on this box (Node v22.12.0):** a trivial frame overflows at depth **9,160** (single self-call, one real stack frame per recursion level); a frame resembling a real generator method (5 args, several locals, string building) overflows at **4,225**.

**Re-measured 2026-08-25 via `spike/fuzz_depth.mjs` (P0 item 7's actual fuzzer, worst-of-three trials): trivial 4,125, generator-like 3,350, parser-like 3,575.** These are lower than the figures above, and the gap is fully reconciled, not a discrepancy left open: `fuzz_depth.mjs`'s `measure()` driver calls each frame shape as `fn(run, d)` — a separate closure invocation that itself calls `run` again — so every logical recursion level costs **two** real V8 stack frames (`run` → `fn` → `run`) instead of one. Replicating that exact structure against the original trivial shape reproduces the lower number almost exactly (4,228 vs 4,125, the residual being ordinary run-to-run JIT/stack variance, consistent with worst-of-three sampling). **This does not change the conclusion — it strengthens it.** The harness's extra indirection frame makes its numbers an *underestimate* of the bare engine ceiling, which is the conservative direction for setting `DepthLimitError` thresholds: the gap to upstream's N=10,000 test is larger than the original single-shot measurement suggested, so the trampolines in item 3 below remain non-optional either way. `CONTRACTS.md` §9.1 records both figures rather than overwriting one, and the suggested `DepthLimitError` threshold (0.6× the harness-measured generator-like ceiling) is deliberately built on the more conservative number.

**Upstream has a live test that exceeds this.** `tests/dialects/test_redshift.py:524` builds a 10,000-element `VALUES` clause — comment: *"to ensure we don't get RecursionError"*. And `generator.py:2742-2746` documents the hazard explicitly:

```python
if self.pretty:
    # This may result in poor performance for large-cardinality `VALUES` tables, due to
    # the deep nesting of the resulting exp.Unions. If this is a problem, either increase
    # `sys.setrecursionlimit` to avoid RecursionErrors, or don't set `pretty`.
    query = reduce(lambda x, y: exp.union(x, y, distinct=False, copy=False), selects)
```

Note the asymmetry that makes this tractable: the **non-pretty** path (`generator.py:2750`) is an iterative `" UNION ALL ".join(...)` and is safe at any width; only the **pretty** path builds the left-nested `Union` chain. `test_redshift.py:529` asserts the non-pretty path at N=10,000, so **the corpus passes without ever touching the recursive path** — the same corpus-invisibility pattern as `too_wide` (§4.6, R4).

**The dangerous class is recursion that grows linearly with input size, not with query nesting:** left-associative binary chains (`a OR b OR c …` → nested `Or`), `UNION` chains, and the `VALUES`→`UNION` pretty conversion. Depth ∝ N, so a 5,000-term `IN`-to-`OR` rewrite overflows a realistic JS frame. Subquery/paren nesting is depth ∝ *nesting depth*, and is not the concern.

**Mitigation, in order:**

1. **`fuzz_depth` — a sixth mandatory P0 fuzz target.** Generates linear-growth inputs (`OR` chains, `UNION` chains, wide `VALUES`, `IN` lists) at increasing N against parse, generate, and generate-`pretty`, and reports the empirical max safe N per path per dialect. That number goes in `CONTRACTS.md`; it is measured, never assumed.
2. **An explicit depth counter in `Parser` and `Generator` raising a structured `DepthLimitError` before the engine's `RangeError`.** This restores Python's contract — a catchable, typed error at a known threshold — instead of an engine artifact at an unknown one. Threshold set from (1) with margin, configurable via generator options, which is the closest honest analogue to `setrecursionlimit`.
3. **Trampoline the two paths where depth ∝ N, and only those:** `Generator.sql()` dispatch over left-nested binary chains, and the `VALUES`→`UNION` pretty reduction. An explicit work-stack there is a *local* deviation from transliteration, so it is listed in `CONTRACTS.md` with its Python anchor and exempted from `lint_fidelity.mjs` **by name** — not by an agent's judgement.

**Explicitly rejected:** `node --stack-size`. It is a V8 flag unavailable to browser consumers and to anyone importing this as a library, and raising it past the OS thread stack converts a clean `RangeError` into a **segfault**. A zero-dependency library cannot require a runtime flag to be correct.

**Residual:** the pretty/`VALUES` path may retain a lower max-N than CPython at default settings. If so it is documented in the README with the measured number rather than papered over — matching upstream, which also documents rather than solves it.

---

## 5. Upstream tracking

### 5.1 Pinning policy

Pin `91119bc` through **P4**; **continuous resync from P5**. Upstream ships every ~7.3 days, ~33% of commits carry a breaking-change marker, and net drift is ~85 LOC/day, ~98% additive. Pinning through the whole of v0 accumulates ~10,000 lines of drift into one catch-up cliff; resyncing from day one costs ~20% of an agent while the base layer is still churning under us. Splitting at P5 — where the base layer stabilizes and upstream hunks start applying meaningfully — halves the cliff at modest cost. Needs Ben's sign-off (Q4).

Weekly: `make resync` produces (a) corpus diff → ratchet quarantine per §3.3 rule 4/5, (b) manifest diff → work items per §3.7, (c) regenerated deny-lists, (d) an issue with counts, allowlist size, and `NEEDS_BASE` queue depth.

### 5.2 Toolchain container — built from upstream, not pinned against it

The runtime artifact has zero dependencies. The **verification** toolchain needs python3 and a readable upstream clone. This box runs CPython **3.9.25**; upstream declares `requires-python = ">=3.9"` — zero headroom — and has already landed 3.9 deprecation (`1a10806`, `9bd7e7c8`).

The earlier mitigation ("containerize with a pinned CPython") solved the wrong direction: the container's job is to *run upstream's suite*, so the moment upstream's floor moves past the pin, the container can no longer do its job. Pinning would protect today's corpus and destroy upstream tracking — the thing Ben actually asked for.

Corrected: `tools/Dockerfile` builds CPython from **the pinned upstream tag's own declared `requires-python`**, is rebuilt as part of every resync, and the resync job fails loudly with `toolchain Python floor moved 3.9 → 3.10` rather than silently emitting a stale corpus. `corpus/PROVENANCE.json` records the exact patch version (CPython patch releases have changed float `repr` and `Decimal` behaviour before, and this corpus is byte-exact) **and the `unicodedata` version** — the P0 go/no-go spike (2026-08-25) found the generated Unicode tables (§4.3 item 3) are only exact for the interpreter that harvested them; Node 22's ICU ships Unicode 16.0 against this box's CPython 3.9.25 / `unicodedata` 13.0.0, an independent version axis from the CPython patch with an 11,130-code-point blast radius on `isprintable` alone if conflated or ignored. The regex differential corpus (also 2026-08-25) hit the same axis from the runtime side — `\w`/`\d` inside dynamically-compiled patterns must use a live JS `\p{...}` regex rather than a generated table (§4.6 Regex), so `PROVENANCE.json` also records the *consuming* runtime's `process.versions.unicode` alongside the harvesting interpreter's `unidata_version`, so both ends of that gap stay measured.

### 5.3 Licensing and attribution — before the first ported line

This is unambiguously a derivative work: line-by-line transliteration with `// py:` anchors, plus a corpus harvested verbatim from upstream's test files. The target repo's `LICENSE` currently reads `MIT License / Copyright (c) 2026 Airbrx` with no mention of sqlglot; upstream is `MIT License / Copyright (c) 2026 Toby Mao`. MIT requires the upstream copyright and permission notice in all copies and substantial portions.

**Required before any port PR merges:** `LICENSE-sqlglot` (verbatim upstream MIT); `NOTICE` stating derivation from sqlglot at commit `91119bc`; README attribution; a CI check that the commit in `NOTICE` matches `UPSTREAM.txt`; and explicit confirmation in `NOTICE` that the redistributed corpus is covered. This is a P0 blocker, not a launch-day task.

---

## 6. Optimizer scope: three tiers

Not all of `optimizer/` is optional, and the previous plan's tiering was wrong in one place.

- **Tier A (P3, parser-path).** The small helpers the parser itself calls.
- **Tier A′ (P4, generate-path, mandatory).** `optimizer/simplify.js` (1,880 LOC). Previously deferred; it runs on the **plain generate path** via `generator.py:5387` (`_simplify_unless_literal`, `LIMIT_ONLY_LITERALS`). v0 cannot ship without it.
- **Tier B (P5).** `scope.js` (1,111), `annotate_types.js` (1,112), `schema.js` (813), `typing/index.js` (379), `typing/snowflake.js` (564). Required for the last ~18% of `test_snowflake.py`.
- **Tier C (P10).** `qualify_columns` (1,319), `merge_subqueries` (557), `pushdown_*` (568), `unnest_subqueries` (345), `canonicalize*` (589), `normalize*` (329), `optimize_joins`, `eliminate_*`, `optimizer.js`, plus `lineage.js`, `diff.js`, `anonymize.js`, and the full `_py/datetime.js` (`relativedelta` with month-end clamping).

---

## 7. Phase plan

Every exit criterion below is a number emitted by `tools/closure.mjs` and the test runner, not a claim in prose. This is the direct fix for the two arithmetically unachievable exits the review found.

### P0 — Foundation, tooling, and the go/no-go. *1 agent, serial. ~150–225 agent-hours.*

**Ordered, because the first three items decide whether the project is the right shape:**

1. **Day 1–3: the byte-exactness spike.** `Decimal` `+ - * /` + `str(Decimal)` + `str(float)`, fuzzed against CPython; and a full `sys.maxunicode` sweep comparing `isprintable`/`islower`/`isupper`/`isspace` against candidate `\p{...}` classes. Green → proceed. **Red → re-plan on day 3, not on day 40.** Previously this signal sat at the *end* of a 4–6 week serial phase; that was the worst scheduling decision in the plan.
2. **Day 3–6: the calibration spike.** Port one real file to green and publish measured LOC/agent-hour before committing to §10's numbers. Target: `sqlglot/time.py` (688) + `helper.py` — chosen over the reviewer's suggestion of `tokens.py` because these are pure functions that can be differential-tested directly at P0, whereas `tokens.py` has no oracle until P1. Re-baseline after P1 and again after P3.
3. **Day 6: licensing** (§5.3). Blocks all port PRs.
4. `CONTRACTS.md` frozen (§8.2).
5. `_py/num.js` (scoped per §4.6), `_py/str.js`, `_py/re.js`, `_py/sort.js`, `_py/collections.js`, **`_py/datetime.js::pyFromIsoFormat`**.
6. Harvester (Validator seam), `astdump.py`, generate oracle **including `unsupported_messages`**, `closure.mjs`, runner, ratchet, 6 parity probes, `seed_static.py`, `sync_report.py`, toolchain container.
7. **Six** fuzzers (§3.4) including the two new targeted ones and **`fuzz_depth`** (§4.7).
8. Generated deny-lists: operators, implicit-`__str__`, **py_builtins**.
9. **Two end-to-end bridge proofs**: `test_errors.py` and `test_transpile.py` (§3.8).

**Exit:** all **six** fuzzers green; **`fuzz_depth`'s measured max-N per path recorded in `CONTRACTS.md` and `DepthLimitError` thresholds set from it** (§4.7); calibration LOC/hour published; closure curve and the full §3.2 per-phase table published; both bridge proofs green; deny-lists generated; container reproducible; licensing landed.

### P1 — Tokenizer. *2 agents. 1,809 LOC.*
`tokenizer_core.js` (1,217) + `tokens.js` (592) + `trie.js`, with code-point threading per the frozen contract. **Exit:** parity probe #1 (token streams byte-exact across all corpus inputs); `fuzz_unicode` green over tokenization.

### P2 — Expressions. *2 agents. 11,882 LOC.*
The 1,048 expression classes: trait mixins + `TRAITS`, `_gen/expr_meta.js` wiring, `defineExpr`, the 24-entry `INIT_HOOKS` table, `equals`/64-bit `hash`/`ExprSet`/`ExprMap`/`frozensetKey`, `copy()` (carrying `_hash` per `core.py:1015`, sharing non-Expr scalars by reference), `_to_s`/`repr`, `update_positions`, `add_comments` + `sqlglot.meta` directive extraction, `astLoad`. `builders.js` (1,148) is the third-largest piece; give it a strong agent.

**Exit:** (1) probes #2/#3 green — 1,048 `EXPR_CLASSES`, 629 `FUNCTION_BY_NAME`, 563 `ALL_FUNCTIONS`, ordered `argTypes` + `requiredArgs` + `traits` + `initOwner` for every class (5,240 checks). (2) **Hand-ported `test/expressions/` native suite green — hard gate, scope corrected 2026-08-25 (§3.6): the 6 tests with no `parse_one`/`.sql()` dependency (`test_identifier`, `test_properties_from_dict`, `test_parse_identifier`, `test_literal_number`, `test_update_positions_empty_meta`, `test_pipe_and_apply`), not the originally-cited 81/185, which was never a real measurement. The other 65 tests are P4's problem (below), tracked explicitly, not dropped.** (3) For all AST-oracle rows, `astDump(astLoad(row.ast))` deep-equals `row.ast` **and** `_to_s(astLoad(row.ast))` byte-matches `row.repr`. (4) `DATE_ADD` unit-normalization test (kwargs uppercases; `astLoad` does not). (5) `equals` reproduces Python's relation on the four falsy/case-insensitivity cases.

### P3 — Parser base + Snowflake parser. *1 blocking agent, then 6–8 through the stub queue. 11,920 LOC.*

Blocking step (~500 LOC + seeding): `SENTINEL_NONE` falsy token, cursor primitives, semicolon chunking, `ErrorLevel`/`raise_error`/`highlight_sql` (byte-exact ANSI over the code-point array), `_try_parse` backtracking, the 20+ dispatch table shapes, optimizer Tier A, **plus a ~200-LOC minimal generator kernel** — non-negotiable because `parser.py:5491` (`fld.sql()`) and `parser.py:8069` (`default.this.sql().upper() == "END"`) call the generator on the parse path. Then seed **364 `_parse_*` stubs** (7,567 LOC) **and the class-level tables** (§8.1 Rule 2′).

**Exit:** AST oracle exact match — including `meta` line/col/start/end — on 100% of Snowflake identity + read SQLs, with no full generator in existence. The 18 `check_command_warning` log strings byte-exact (via `error_message_context`, not a hardcoded 100). `ParseError.errors` structure matches `test_errors.py`. `fuzz_unicode` green over error-message column positions.

### P4 — Generator base + Snowflake generator. *1 blocking agent, then 6–8. 10,573 LOC.*

Blocking step: `_buildDispatch` (prototype walk, sorted, TRANSFORMS-beats-`*_sql`, asserted against `_gen/dispatch/`), module-level dispatch cache, `sql()` exact-class dispatch with only `Func`/`Property` fallbacks, `sep`/`seg`/`indent`/`expressions`/`maybe_comment`/`sanitize_comment` (using `pyStrip`), `unsupported()`/`ErrorLevel`, `SENTINEL_LINE_BREAK` pretty machinery, `function_fallback_sql` iterating `argTypes` in declaration order, `too_wide` using `cpLen`. Then seed 432 `*_sql` stubs (4,107 LOC) + `TRANSFORMS` (143 entries) + 126 settings. Then `generators/snowflake.js` (1,222) + `transforms.js` (1,083) + `jsonpath.js` (238) + **`optimizer/simplify.js` (1,880, mandatory)**.

**Exit:** **1,606 atoms closed under `{snowflake}`**, including all 82 `pretty=True` calls, the 5 `UnsupportedError` sentinels, and `identify=True`. **`unsupported_messages` matches the oracle on every generate-oracle row** (the 497-call fix). Probe #4 green (base 560, Snowflake 656). `RANDOM()` emits the exact mixed-case `E+18`/`e+18` literal asserted at `test_snowflake.py:367`. `fuzz_toowide`, `fuzz_comments`, **and `fuzz_depth`** green. **Trampolines landed on the two depth-∝-N generator paths and recorded in `CONTRACTS.md`; `test_redshift.py:524`'s N=10,000 `VALUES` case green on both the iterative *and* the `pretty` path** (§4.7). Deny-list lints green. **The 65 `test_expressions.py` tests deferred from P2 (§3.6) go green here — this is the earliest phase where both a base parser (P3) and base generator (this phase) exist to run them; 63 of 65 use the default dialect, 2 need bigquery/spark and may need to wait for those P9 dialects instead.**

### P5 — Slice complete: Snowflake + default + optimizer Tier B + bridge. *3–4 agents. 6,754 LOC.*

`dialects/dialect.js` (2,685: registry, `registerDialect` with all ~20 derivations, `get_or_raise` with the `"name, k=v"` grammar, `compareVersion` with a non-2⁶³ sentinel, `dialectEquals`, ~90 shared generator helpers). Optimizer Tier B. `tools/bridge/` full + `allowlist.json`. Hand-ported `test/build/` native suite (replacing `test_build.py` on the bridge).

**Exit:** **2,022 atoms closed under `{snowflake, default}`.** `identity.sql` 980/980; `pretty.sql` 29/29; `partial.sql` 7/7; `jsonpath/cts.json` 526/526. Bridge green on the eight modules in §3.8 with the allowlist checked in and its size stated. `test/build/` native suite green.

*No interim release here — Ben confirmed (§9 Q3, 2026-08-24): "We don't need an interim release." v0 ships at P8.*

### P6 — DuckDB. *8 agents (shard count). 5,394 LOC.*

`generators/duckdb.js` alone is 4,788 LOC — the largest file in the repo, 28% of all `generators/`; budget it as 4 sub-shards. **Not** a priority reshuffle: 449 of TestSnowflake's 572 `validate_all` calls write to DuckDB, and TestSnowflake cannot progress without it.

**Exit:** **3,417 atoms (21.8%).** `test_snowflake.py` closes **2,086 of 2,437 atoms (85.6%)** — *not* 100%, which was arithmetically impossible; the 351 open atoms need spark (55), bigquery (40), postgres (35), presto (23), hive (22), databricks (16), mysql (14), sqlite (10), redshift (9), trino (8), tsql (8), plus 84 read-entries from unimplemented dialects. `APPROX_QUANTILES(x, 3)` emits the 28-significant-digit array. `fuzz_decimal` green over `generators/duckdb.js`.

**Does not ship as v0.** Ben confirmed (§9 Q2, 2026-08-24): *"We will ship at P8."* DuckDB is still built here regardless — 449 of TestSnowflake's `validate_all` calls require it as an intermediate write target, so Snowflake conformance cannot progress past P4's 1,606 atoms without it. Building continues straight through to P8; there is no pause or release event at P6.

### P7 — Databricks chain. *4 sequential sub-phases (hive → spark2 → spark → databricks), 3 agents each. 2,357 LOC.*

Ben's priority #2, **confirmed as the correct #2 by the corrected data** (§9 Q1). Cannot start before P5: `dialects/hive.py:14` and `dialects/databricks.py:11` import `TypeAnnotator` at module level. Databricks' own churn is *majority typing* (14 of 39 touches).

**Exit:** **5,207 atoms (33.3%), +1,790.** TestDatabricks closes **203 of 222** (the remaining 19 need tsql/clickhouse/mysql/teradata — again, *not* 222). `test_hive.py`, `test_spark.py`, `test_spark2.py` atoms closed to their in-scope maximum. TestSnowflake rises to 2,202 (90.4%).

### P8 — Postgres + Redshift. *3 agents. ~1,742 LOC.*

Self-contained; no dialect-to-dialect inheritance. Reproduce `generators/postgres.py:311`'s explicit parent-`TRANSFORMS` filter rather than "fixing" it. Requires `compareVersion` for the four `postgres, version=…` keys.

**Exit:** **6,552 atoms (41.9%), +1,345.** TestPostgres closes 700 of 803.

**v0 SHIPS HERE.** Ben confirmed (§9 Q2, 2026-08-24): *"We will ship at P8."* v0 is Snowflake + Databricks chain (Hive/Spark2/Spark/Databricks) + DuckDB + Postgres/Redshift + default — the set the product requires at launch (§9 Q1: *"Our product requires Snowflake, Databricks, DuckDB and Postgres. Those go first."*). See §10 for the restated v0 effort table (P0–P8).

### P9 — Long tail. *1–2 agents per dialect. 17,680 LOC — 59% of the dialect layer, ~58% of remaining atoms.*

Ordered by **greedy marginal value** from the P8 base (machine-computed, not guessed): bigquery (+1,677), tsql (+1,101), presto (+1,027), mysql (+1,000), clickhouse (+792), exasol (+618), oracle (+573), sqlite (+356), trino (+338), singlestore (+336), starrocks (+276), teradata (+202), doris (+179), drill (+111), dremio (+100), athena (+72), materialize (+63), fabric (+49), dune (+44), tableau (+44), druid (+41), prql (+30), risingwave (+16), dax (+13), **solr (added 2026-08-25 — missing from this list in earlier revisions; found by direct enumeration of the real corpus, not the plan's prose)**, then the **12** versioned keys (**+22 total**, not the originally-cited 14/+28 — see the corrected census below). Each dialect also fills stubs in the shared base files (v0 leaves ~148 parser + ~252 generator methods unimplemented); §8.1 handles the contention.

**Dialect census corrected 2026-08-25, verified directly against the real corpus** (`corpus/atoms.jsonl`, computed by enumerating every distinct `read`/`write` value): **46 total dialect keys = 34 base** (33 named dialects + the `""` default) **+ 12 versioned** (`clickhouse` ×2, `duckdb` ×4, `postgres` ×4, `spark` ×2 — version strings that normalize to the same `compareVersion` bucket collapse, e.g. `duckdb, version=1.1` and `duckdb, version=1.1.0`), not the 38 base / 14 versioned cited earlier in this document. Also confirmed directly: **every versioned key appears only as a write target in the corpus, never as a read target** — so `compareVersion` is exercised exclusively on the generate path, never the parse path, which narrows where it needs to be correct.

**Exit:** 15,540/15,540 (§1's real harvested atom count, superseding the 15,642 estimate this line originally cited) minus a documented `wontfix` list. Quarantine empty. Native tests written for the 19 never-exercised generator methods (§3.5).

### P10 — Optimizer Tier C + remainder. *~9,000 LOC.*

**Exit:** 3,476 optimizer fixture pairs green (the 201 `# execute: true` *execution* assertions are `wontfix`; the SQL-comparison half is kept). Bridge green on `test_optimizer.py`, `test_lineage.py`, `test_anonymize.py`.

---

## 8. Parallel execution

**Assumed concurrency: 2.** `nproc = 2`, so agent-count ≈ wall-clock. Every mechanism below is correct at 1, at 2, and unchanged at 40. Phase agent-counts are *shard counts* (how work divides), not simultaneity claims; at concurrency 2 they drain as a queue.

### 8.1 Ownership

**Rule 1 — one file, one owner, one branch, one PR — enforced in CI, not by a hook.** The previous design (a local pre-push hook plus `.claims/*.json` committed to `main`) was not an enforcement mechanism: hooks are not distributed by clone, are not installed by default, and are bypassed by `--no-verify`. Worse, committing a claim per file meant every claim was a push to `main` — a serialization point generating exactly the rebases Rule 6 exists to avoid. **Corrected:** claim checking is a **required CI check** that computes changed-file overlap against the changed-file lists of currently-open PRs via the GitHub API. Zero repo writes, actually enforced. The pre-push hook survives only as fast local feedback, installed by `make setup`.

**Rule 2 — stub-seeding makes intra-file method conflict structurally impossible.** For `parser.js` (10,480), `generator.js` (6,370), `generators/duckdb.js` (4,788), the phase's blocking step emits **every method as a stub in upstream source order**:

```js
/** @param {Token} token @returns {Expr|undefined} */
// py: sqlglot/parser.py:6302
_parse_bitwise(token) { throw new NotPorted("_parse_bitwise", "sqlglot/parser.py:6302"); }
```

One task replaces exactly one stub; two agents produce non-adjacent hunks that git merges cleanly. These files become **method-owned**: claims are `.claims/parser.js#_parse_bitwise`. `grep -c NotPorted src/parser.js` is a free burndown.

**Rule 2′ — seed the class-level tables the same way (new).** Rule 2 as written covered method bodies and claimed intra-file conflict was "structurally impossible." It isn't, for the part that matters most. Measured: `parser.py` is 405 methods / 8,143 LOC, leaving **2,337 LOC of class body** — `FUNCTIONS` (648 entries), `STATEMENT_PARSERS`, `EXPRESSION_PARSERS`, `PROPERTY_PARSERS`, `ALTER_PARSERS`, `RANGE_PARSERS`, eight precedence maps, ~162 class attributes. `generator.py` is 484 methods / 4,996 LOC, leaving **1,374 LOC** of `TRANSFORMS` (143 entries) + 126 settings. The DDL shard adds to `PROPERTY_PARSERS`; the types shard adds to `TYPE_TOKENS`; the functions shard adds to `FUNCTIONS` — all single contiguous literals, and in P9 all 24 remaining dialect efforts touch them.

**Corrected:** seed these tables **one entry per line in upstream declaration order, each with its own `// py:<file>:<line>` anchor**, so an addition is a single non-adjacent line. Table **order** is CI-asserted against a `_gen/` snapshot, because §4.6 establishes that insertion order is observable in output SQL.

**Rule 3 — shared foundation frozen after each phase's blocking step, with a named owner.** `src/_py/*`, `helper.js`, `errors.js`, `trie.js`, and the registration helpers are edited only by a serialized foundation task. **Corrected (the queue previously had no owner and no latency bound, and P9 is exactly where its arrival rate spikes):** (a) a **named foundation owner per phase**; (b) the `NEEDS_BASE` queue **must be drained at the start of every work session** before any port task is pulled; (c) **strictly-additive** changes — a new exported function, no signature change to an existing one — may be made in place by the requesting agent under a `foundation-additive` label that forces human review; (d) queue depth is measured and published in the weekly report.

**Rule 4 — generated files: regenerate, never merge.** The previous mechanism (`.gitattributes merge=ours`) was a **no-op**: `ours` is not a built-in merge driver (git ships `text`, `binary`, `union`), it requires `[merge "ours"] driver = true` in each clone's local config, and config is not cloned — verified unset on this box (git 2.50.1). Worse, under Rule 6's rebase-only policy, "ours" is the *upstream* side, so even when configured it would keep the incoming file.

**Corrected:** delete the merge-driver line. The real mechanism is the CI gate that already exists — `make codegen && git diff --exit-code src/_gen` — plus a committed `_gen/.manifest.sha256` that CI verifies. `corpus/**` uses `merge=union` (a genuine built-in) since the JSONL files are append-ordered.

> **Deliberately rejected:** the reviewer's primary remedy — make `src/_gen/**` and `corpus/**` untracked build outputs. That would mean a JS-only contributor cannot run `node --test` without Python and an upstream clone, which contradicts Q5's stated goal. We keep them committed and rely on the regeneration gate for freshness.

**Rule 5 — shard on upstream's seams, never invented ones.** (a) One dialect = 4 files (`dialects/X`, `parsers/X`, `generators/X`, `typing/X`) = 1–2 agents, independent except along an inheritance chain (hive→spark2→spark→databricks is strictly sequential); (b) one `expressions/` file = 1 agent; (c) one grammar area within `parser.js`/`generator.js` = 1 agent, where areas are query/modifiers, DDL, DML, types, functions, properties, joins/set-ops — chosen because upstream's methods already cluster that way in source order, so an area is a **contiguous stub range**.

**Rule 6 — rebase, never merge.** Stub-seeded files rebase cleanly by construction.

### 8.2 Interface contracts, frozen at P0 in `CONTRACTS.md`

Freezing these on day one decouples the three serial lanes (tooling / runtime / port):

1. **`_py/` API surface** — every helper's name, arity, and Python-semantics reference, written *before* implementation, so port agents can call functions the runtime agent hasn't written. Now includes `utf8Len`, `pyChr`, `pyFormatInt`, `pyFromIsoFormat`.
2. **Tokenizer output shape** — `{tokens, codePoints}`.
3. **`_gen/` schema**, including the table-order manifest.
4. **AST oracle JSON shape** (`astdump.py` ↔ `astDump()`/`astLoad()`), including the `astLoad` no-`INIT_HOOKS` rule.
5. **Bridge NDJSON protocol**, plus the per-module proxy-satisfiability table.
6. **`NotPorted` error contract** and the stub JSDoc template.
7. **Corpus provenance schema**, including `python_version`, `unidata_version`, and the consuming runtime's `process.versions.unicode` (added 2026-08-25 per the P0 go/no-go spike and the regex differential corpus — see §5.2, §4.6). **Also record: `\N{NAME}` regex escapes are an accepted unsupported gap** — no faithful JS encoding without shipping a full Unicode character-name table, and unreached by any real sqlglot pattern (2026-08-25, `p0-regex-corpus`).

### 8.3 Task briefs carry their own oracle

Every task is a triple: (i) the Python `file:line-range`, (ii) the JS stub(s) to fill, (iii) **the exact command that proves it**:

```
node --test --test-name-pattern='^(a1f3c9d2|b2e4f001|...)$'
node tools/ast_diff.mjs --dialect snowflake --filter 'DATE_TRUNC'
python3 tools/parity/check.py --probe argtypes
```

An agent that cannot turn its command green does not open a PR. Because the AST oracle and the generate oracle both exist from P3/P4, parser agents and generator agents never block each other and never argue about whose bug it is — `ast_diff.mjs` prints a side-by-side `repr` diff and the runner labels the failure `PARSE MISMATCH` or `GENERATE MISMATCH`.

### 8.4 The failure queue *is* the scheduler

`node --test --json` groups failures by signature (error class + top JS frame + the `// py:` anchor on that line). `make triage` buckets them into `runtime-fixable` / `stub-missing` / `body-wrong` / `unknown` and emits one work item per bucket-file pair. At concurrency 2 the queue drains slower; no step assumes fan-out that doesn't exist.

### 8.5 Review gates

**CI, every PR:** (1) `node --test` — no unlisted atom fails, no `todo`/`wontfix` atom passes; (2) ratchet monotonicity + quarantine rules 4/5; (3) `lint_fidelity.mjs` — headers, method-name set, method order, table order, `cpLen`, all three deny-lists; (4) `lint_nodeps.mjs`; (5) `make codegen && git diff --exit-code src/_gen` + `_gen/.manifest.sha256`; (6) claim-overlap check via GitHub API; (7) parity probes for the touched area; (8) corpus provenance match; (9) NOTICE/UPSTREAM.txt commit match; (10) advisory `tsc --checkJs --noEmit`.

**Human review gate — the only thing CI cannot do.** Every PR touching `parser.js`, `generator.js`, or a dialect file is reviewed **against the Python source side-by-side**, and the reviewer's sole question is "is this a transliteration?" — not "is this good JS."

**Corrected sizing.** The previous claim ("median `_parse_*` is 11 LOC, so 60 seconds per method") used a statistic that hides the cost. Measured on `parser.py`: 364 `_parse_*` methods, median 11, **mean 20.8, p90 42, max 285**, and the **72 methods larger than 30 LOC hold 4,240 LOC — 56% of all parser method LOC**. Generators genuinely are small (432 `*_sql`, median 5, mean 9.5, only 20 methods >30 LOC holding 1,001 LOC).

So review is budgeted **by LOC, not by method count**: ~250 LOC/human-hour for the small tail, ~100 LOC/hour for methods >30 LOC. The 72 large parser methods are named explicitly in the task briefs as **two-reviewer items**. §10 now carries a human-hours row.

If Ben's answer is that an agent performs this review, say so plainly: R1's mitigation is then an LLM checking an LLM, the residual rises materially, and the honest statement is that transliteration fidelity is defended by lint plus the resync signal — with divergence discovered at the first resync rather than at review time.

### 8.6 Practical sequencing at concurrency 2

P0 is one agent alone (~4–5 weeks; unavoidable serial bottleneck, budgeted as such). The second agent is **not** idle: it writes `_py/` differential-test case tables, which require no JS to exist — that is exactly why P0's contracts are frozen first. P1–P2 run two agents on disjoint files. P3/P4/P6 each begin with one blocking agent (~2–4 days: primitives + stub-and-table seed) after which two agents cycle the stub queue. P7's sequential chain runs one agent deep while the second works P8/P9 dialects — after P5 there is always independent long-tail work, so the second slot is never idle.

---

## 9. Risks and questions for Ben

### Decisions — answered by Ben, 2026-08-24

All five resolved. Q2 changes the architecture (v0's boundary moves from P6 to P8); Q1/Q3/Q4/Q5 confirm the plan as written.

**Q1 — Priority order: confirmed, including DuckDB.** Ben's exact words: *"Our product requires Snowflake, Databricks, DuckDB and Postgres. Those go first."* This settles the one narrow open question (whether BigQuery should lead over Postgres at position #3 — see the marginal-atom table below): **Postgres stays at P8 as written; no swap.** It also confirms DuckDB's place in the build order, which was already forced by test dependency regardless of priority (§7 P6 — 449 of TestSnowflake's `validate_all` calls write to DuckDB) — Ben's answer independently corroborates the existing design rather than changing it.

*Supporting data (unchanged from the draft):* the previous plan draft had argued against Ben's stated order using a number that was 5.4× too small — `databricks +333 atoms`, the marginal for adding `databricks` alone, when Databricks cannot be added without Hive/Spark and P7 delivers the *chain* as its unit of work. Recomputed correctly from the P6 base `{snowflake, default, duckdb}`:

| addition | marginal atoms | LOC (4 trees) | atoms/kLOC |
|---|---|---|---|
| **`{hive, spark2, spark, databricks}`** | **+1,790** | 2,357 | **760** |
| `{bigquery}` | +1,403 | 2,139 | 656 |
| `{postgres, redshift}` | +1,259 | ~1,742 | 723 |
| `{tsql}` | +833 | 1,706 | 488 |
| `{databricks}` alone | +333 | 288 | — |

Databricks-chain is #1 by marginal atoms and best-in-class per kLOC — Ben's priority #2 was already the data-confirmed correct choice before he answered.

**Q2 — v0 ships at P8, not P6.** Ben's exact words: *"We will ship at P8."* v0 is now Snowflake + Databricks chain + DuckDB + Postgres/Redshift + default — **42.0% atom closure (6,522/15,540)**, not the 21.8% at P6. This adds P7 (Databricks chain, 80–130 agent-hours) and P8 (Postgres+Redshift, 50–80 agent-hours) to the v0 critical path — see the restated effort table in §10. Calendar impact: v0 moves later by the 2–4 months this question flagged; the restated wall-clock estimate is in §10.

**Q3 — No interim release.** Ben's exact words: *"We don't need an interim release."* No release event at P5 or P6; the optimizer Tier B work at P5 (~3,400 LOC) still happens exactly as scheduled — it was never optional, only the question of shipping an intermediate build around it was open. Moot in practice now that v0 already extends to P8 regardless.

**Q4 — Pin through P4, continuous resync from P5. Confirmed.** Ben's exact words: *"Sounds good. Pin first."* Plan proceeds exactly as written in §5.1 — no change.

**Q5 — Build-time Python dependency for verification tooling: confirmed acceptable.** Ben's exact words: *"This is acceptable (and needed)."* Plan proceeds exactly as written in §5.2 — no change. Runtime remains zero-dependency, guaranteed.

### Decisions made during execution

**Q6 — P2's `test/expressions/` native-suite scope, 2026-08-25.** The originally-cited "81 deep `assertEqual`s + 185 `assertIsInstance`es" (§3.6) was found by P2 to not match any real measurement of the pinned `tests/test_expressions.py` (true totals: 283/120 across 71 tests; only 6 tests have zero `parse_one`/`.sql()` dependency). Options presented: (1) hand-port only the 6 parser-independent tests now, deferring the rest as a tracked P4 exit criterion; (2) triage all 71 and hand-port whichever can be faithfully rewritten via direct construction; (3) full hand-port including parser-dependent fixtures. **Ben chose (1).** §3.6 and §7 P2/P4 updated with the real numbers and the explicit P4 tracking addition.

### Risks, ordered by expected damage

**R1 — Transliteration fidelity is enforced by discipline, not by machine.** Lint checks names, order, headers, tables; it cannot check that a body is a transliteration rather than an idiomatic rewrite. One agent "cleaning up" a 40-line if/elif into a lookup table produces a file that no longer diffs against upstream, invisible until the first resync. *Mitigation:* §8.5's human gate, now correctly sized and budgeted. *Residual:* real, and larger than previously stated because 56% of parser method LOC sits in a 72-method tail that the median-based estimate hid. This is the price of hand-porting and the plan's weakest joint.

**R2 — Effort. ~1,850 agent-hours + ~230 human review-hours for v0 (P0–P8) at the midpoint** (revised from ~1,310/~200 for the old P0–P6 boundary, now that Q2 extends v0 through P7 and P8 — see §10). At concurrency 2 that is roughly ~5 months at 24/7, ~13 months at an 8-hour day (linear extrapolation from the P0–P6 wall-clock table pending recalibration — see §10). **This estimate rests on an LOC/hour constant that is now measured on day 3–6 of P0 rather than asserted** — a 2× miss is the difference between roughly 6.5 and 13 months at 24/7, so the calibration spike gates the schedule, not just the plan's credibility.

**R3 — the "morale cliff" risk is substantially reduced by Q2, but a smaller internal one remains.** The original concern was that v0 shipping at 21.8% (P6) would read as a letdown relative to "sqlglot in JS." Ben's Q2 answer (v0 ships at P8, 41.9%) resolves the *public-facing* version of this risk — the released v0 is a materially more complete transpiler (Snowflake, Databricks, DuckDB, Postgres). The residual: P6 (21.8%) still exists as an *internal* milestone en route to P8, and TestSnowflake only reaches 85.6% there — teams watching progress mid-build should not mistake P6 for a release. *Mitigation:* publish the quadratic closure curve **and the full §3.2 per-phase table** at P0, and be explicit in status updates that P6 is a checkpoint, not a ship. The previous secondary metric — "% of `test_snowflake.py` closed, which hits 100% at P6" — **was false** (it is 85.6% at P6, 90.4% at P7, 100% only at the end of P9) and is replaced by two honest ones: **"% of in-scope atoms closed" (100% by construction at every phase)** and **"atoms closed / total," reported against the published curve**.

**R4 — Unicode and numeric hazards are a long tail of silent wrong answers.** Every one found so far was found by targeted probing, not by tests, because the corpus is 0.024% non-ASCII. Two of them — `too_wide` and `sanitize_comment` — are provably *unreachable* by the corpus: a `.length` port passes 15,642/15,642 and is wrong. *Mitigation:* **six** named fuzz targets with purpose-built generators (§3.4, §4.7), each a phase exit criterion. *Residual:* the fuzzers cover what we thought to fuzz. Assume more exist — **R11 was found after both adversarial reviews had signed off, which is the concrete demonstration of this residual, not a hypothetical one.** **Byte-exactness outside the corpus-covered surface rests on fuzzers, deny-lists, and review — stated plainly, not implied.**

**R5 — 115 operator-overload sites and 58+2 implicit-`__str__` sites inside `sqlglot/` itself** (corrected 2026-08-25 from earlier estimates of 68/26 — see §4.6). The agent contract actively produces wrong code at those exact lines. *Mitigation:* machine-generated deny-lists + CI lint, now extended to Python builtins (`corpus/deny/py_builtins.json`, 17 confirmed sites vs 3 illustrative examples originally cited). *Residual:* 24/115 operator and 13/58 implicit-str sites are `low`-confidence pending a runtime instrumentation pass (`instrument_operators.py`, written, blocked on the same permission gate as the harvester) that would upgrade them to ground truth; the census also derives from `tests/dialects` coverage, so a site reachable only from an unported dialect could be missed, and re-runs on every bump.

**R6 — Corpus provenance is interpreter-version-dependent.** `subsecond_precision` returns different values on CPython 3.9 vs 3.11 for the same literal, and that difference reaches output SQL through four generators. *Mitigation:* `PROVENANCE.json` + hard-fail on version mismatch + `pyFromIsoFormat` against a pinned CPython grammar. *Residual:* other version-dependent surfaces may exist; float `repr` and `Decimal` have changed across CPython patch releases before, which is why the **patch** version is recorded.

**R7 — P9 contention on the shared base files and tables.** 24 remaining dialect efforts filling stubs in `parser.js`/`generator.js` (~3,801 method-LOC after v0) plus the shared class-level tables. *Mitigation:* method-level claims + Rule 2′ per-line table seeding + CI-enforced claims. *Residual:* at concurrency 2 this is a throughput ceiling, not a correctness problem.

**R8 — `dialect.py`'s import-time `TRANSFORMS` mutation is import-order dependent** (`dialect.py:304-309`). Today all 10 generators with `SUPPORTED_JSON_PATH_PARTS` also redeclare `TRANSFORMS`, so the mutation is local; we reproduce the aliasing. A future upstream dialect setting one without the other diverges, and probe #4 compares *final state*, not order. Documented; accepted.

**R9 — Bridge allowlist growth.** 229 of 772 dialect methods are AST-introspecting, growing ~6.5/month. Not the dialect gate, so it does not threaten conformance, but it is the mechanism most likely to quietly grow. CI requires an `UPSTREAM-NOTES.md` entry per addition; the count is printed weekly.

**R10 — `Expression.equals` subtleties.** If §4.5's projection is wrong anywhere, the failure is a wrong `.index()` inside `_move_ctes_to_top_level`, which runs on *every* generate. *Mitigation:* a differential harness over every `(a, b, a == b)` triple the Python dialect suite produces.

**R11 — Recursion depth is a hard JS ceiling where Python has a tunable one (§4.7).** Measured: a realistic generator frame overflows at depth **4,225** on Node v22 (single-shot), **3,350 via the P0 item 7 fuzzer's worst-of-three harness** (lower because that harness adds one extra real stack frame of indirection per level — reconciled in §4.7, not a discrepancy); upstream ships a test at N=**10,000** (`test_redshift.py:524`) and documents the hazard in `generator.py:2742-2746`. Either figure lands well short of 10,000, so the conclusion is unaffected by which one is used. Recursion depth grows **linearly with input size** on binary/`UNION` chains, so this is reachable by ordinary machine-generated SQL, not just pathological input. *Mitigation:* `fuzz_depth` as a sixth mandatory P0 target to measure the real ceiling per path; a structured `DepthLimitError` raised before V8's `RangeError`; trampolines on the two depth-∝-N paths, named in `CONTRACTS.md` and lint-exempted by name. `--stack-size` rejected (unavailable in browsers; converts a clean error into a segfault). *Residual:* max-N on the pretty/`VALUES` path may stay below CPython's, and gets documented with its measured number. **Corpus-invisible** — `test_redshift.py:529` asserts the *iterative* path, so 15,642/15,642 can pass with the recursive path broken. Found after both adversarial reviews, which is itself evidence for R4's thesis that the corpus does not defend this class of hazard.

### Accepted red-team findings, not fixed

- **"The corpus is a snapshot; upstream moves."** Accepted; Q4 is the trade.
- **"Golden corpora are unreviewable."** Accepted *in part*: the AST oracle carries `repr` (human-readable), and the hand-ported `test/expressions/` and `test/build/` suites are real specifications. But 15,642 atoms remain a regression net; the fix is §8.5's human gate, not automation.
- **`Expr.__lt__` returning a node** — reproduced faithfully in `pySortedTuples`, accepting that the exact permutation on a tie is a CPython Timsort artifact. Divergence surfaces as a corpus failure and goes to `wontfix` with a citation.
- **`test_executor.py` and the 201 `# execute: true` executions** — permanently out, stated in the README.

---

## 10. Effort

### Model

Throughput: **150–250 LOC/agent-hour** of *conformance-verified* transliteration — written, run against an oracle, debugged to green. Midpoint 200. Deliberately below raw generation rates because the binding constraint is the debug loop. **This constant is now measured by the P0 calibration spike (day 3–6) and re-baselined after P1 and P3.** Integration/rework multiplier: **+35%** on code written before its oracle exists (all of P0–P2).

### v0 (P0–P8) — revised 2026-08-24 per Ben's Q2 decision ("We will ship at P8")

**A note on this recomputation.** The previous P0–P6 table's stated total ("1,130–2,025, mid ~1,310") did not actually match the sum of its own rows — summing the printed low-end figures gives 1,330h, not 1,130h, an inherited ~200h arithmetic slip from the original synthesis pass that nobody had caught. Extending the table through P7/P8 was the occasion to fix it properly rather than propagate the error further. The table below is a clean row-by-row sum; treat it as superseding the old total, not adjusting it.

| Phase | LOC | Agent-hours | Notes |
|---|---|---|---|
| P0 Foundation & tooling | ~3,000 | 150–225 | 2 spikes, harvester, 3 oracles + `unsupported_messages`, runner, ratchet, 6 probes, 6 fuzzers, 3 deny-lists, seeder, sync report, container, 2 bridge proofs, licensing. `_py/num.js` 40–70h; Python-regex group counter ~40h; `pyFromIsoFormat` ~10h; `fuzz_depth` + `DepthLimitError` threading ~10–15h (§4.7). Serial, one agent. |
| P1 Tokenizer | 1,809 | 60–100 | + code-point threading |
| P2 Expressions | 11,882 | 280–420 | includes +35% (written blind) and the hand-ported `test/expressions/` suite |
| P3 Parser base + Snowflake parser | 11,920 | 220–330 | ~253/401 base methods reachable (~9,000 effective) + 1,440 dialect + table seeding |
| P4 Generator base + Snowflake gen + transforms + simplify | 10,573 | 200–300 | ~230/484 base methods reachable |
| P5 dialect.js + optimizer Tier B + bridge + `test/build/` | 6,754 | 150–220 | bridge ~40h. No interim release (§9 Q3) |
| P6 DuckDB | 5,394 | 120–180 | mostly `generators/duckdb.js`. Does not ship as v0 (§9 Q2) |
| P7 Databricks chain | 2,357 | 80–130 | now part of v0 per Q2 |
| P8 Postgres + Redshift | ~1,742 | 50–80 | now part of v0 per Q2 — **v0 ships here** |
| Cross-cutting triage, fuzzer burndown | — | 150–250 | |
| **v0 agent-hours (P0–P8)** | **~55,400** | **1,460–2,235** (mid **~1,850**) | up from 1,310 mid at the old P0–P6 boundary — the +540h mid is P7+P8's own effort, not a correction |
| **v0 human review-hours** | ~34,100 LOC reviewed | **~170–285** (mid **~230**) | §8.5; separate budget. P7+P8 add ~20–35h to the old P0–P6 figure of 150–250h, at the same blended LOC/review-hour rate. If agents review instead, this row goes to ~0 and R1's residual rises correspondingly. |

### Wall clock (agent-hours only, midpoint ~1,850)

**Approximate — linearly extrapolated from the P0–P6-boundary wall-clock figures using the same implied throughput, not a fresh model run.** The original wall-clock figures were derived from phase-blocking-step reasoning (P0/P3/P4/P6 serial bottlenecks), not pure hours-divided-by-concurrency arithmetic, so extending them precisely requires rerunning that reasoning through P7/P8. P7's internal structure is itself partly serial (4 sequential sub-phases: hive→spark2→spark→databricks) but doesn't introduce a *new* project-wide bottleneck beyond what P0/P3/P4/P6 already impose, and P8 has no inheritance chain at all — so linear scaling by the ~1.41× effort increase (1,850/1,310) is a reasonable first-order estimate. **Treat these as placeholders; the P0 calibration spike (§7 P0, day 3–6) is what actually re-grounds this table.**

| Concurrency | 8h/day | 24/7 |
|---|---|---|
| **2** | **~58 weeks** (~13.4 months) | **~20 weeks** (~4.6 months) |
| 4 | ~28 weeks | ~10 weeks |
| 8 | ~17 weeks | ~6 weeks |

Sublinear above 4 — P0 is serial (~4–5 weeks of one agent regardless) and P3/P4/P6 each open with a blocking step. Realistic ceiling ~6 effective agents before the critical path dominates.

### Post-v0 (P9–P10 — everything after v0 ships at P8)

| Phase | LOC | Agent-hours |
|---|---|---|
| P9 Long tail (24 dialects + 14 versioned keys) | 17,680 | 900–1,500 |
| P10 Optimizer Tier C + lineage/diff/anonymize + full `_py/datetime.js` | ~9,000 | 400–700 |
| **On top of v0** | **~26,700** | **1,300–2,200** (mid **~1,750**) + ~165–320 human review-hours |

**Grand total (P0–P10, unchanged by where the v0 line is drawn): ~2,760–4,435 agent-hours** (mid ~3,600) **+ ~335–605 human review-hours.** At concurrency 2, 8h/day, extrapolated the same way as above: **~15–17 months from P0 to 100% closure.**

### Ongoing maintenance (separate budget, starts at P5 per Q4)

Measured steady state: ~85 LOC/day of upstream churn across `sqlglot/`, ~7.4% corpus growth per 4 months, ~98% additive. Re-transliterating changed hunks plus burning down quarantine: **~8 agent-hours/week** — one agent at ~20% capacity. Concentrated in `parsers/` + `generators/` (386 of 600 commit-touches), `parser.py`/`generator.py` (147), and `typing/` (144). Note that two of those three are *dialect* files for dialects that land in P9, so maintenance load runs ahead of build order.

### The two largest estimation risks

1. **P0 is serial and it is 150–225 hours.** If P0 slips, everything slips 1:1. It is also where the go/no-go lives — and that signal now arrives on **day 3**, not day 40. If the numeric and Unicode spikes cannot be made green, byte-exactness is not achievable at this budget, the corpus strategy is invalid, and the project should be rescoped to "semantically correct, not byte-exact" via a full re-plan rather than a schedule slip.
2. **The LOC/hour constant.** Every number above is linear in it. It is measured on day 3–6 and re-measured twice. Publish the measurement; if it lands below 150, bring Q2 back to the table before starting P3.

---

## Appendix — objection disposition

### Review A (execution/architecture)

| # | Objection | Disposition |
|---|---|---|
| A1 | Q1's Databricks marginal (+333) is the single-dialect figure, not the chain; conclusion reverses | **Fixed.** Recomputed: chain **+1,790**, #1 by marginal and by atoms/kLOC. Swap-and-insert-BigQuery recommendation withdrawn; churn line deleted. Q1 narrowed to the BigQuery-vs-Postgres question only — *partial reject of "delete Q1," because a real #3 question remains.* §9 Q1 |
| A2 | P6 "test_snowflake 100%" and P7 "222 TestDatabricks" are arithmetically impossible; R3's mitigation is false | **Fixed.** All exits restated as machine-computed closure. P6 = 2,086/2,437 (85.6%); P7 = 203/222. R3's secondary metric replaced with "% of in-scope atoms" (100% by construction). Full per-phase table published at P0. §3.2, §7, R3 |
| A3 | `.gitattributes merge=ours` is a no-op and inverts under rebase | **Fixed** (driver line deleted; `_gen/.manifest.sha256` + regeneration gate; `merge=union` for JSONL). **Primary remedy rejected:** making `corpus/**` untracked breaks the JS-only contributor path in Q5. §8.1 R4 |
| A4 | Pre-push hook + claims-on-`main` is not enforcement, and serializes pushes | **Fixed.** Claim overlap is a required CI check via GitHub API; hook is local convenience only. §8.1 R1 |
| A5 | Stub-seeding misses the class-level dispatch tables — where grammar shards actually collide | **Fixed.** Rule 2′: per-line table seeding with anchors + CI-asserted order. Re-measured (parser class body 2,337 LOC, generator 1,374). §8.1 R2′ |
| A6 | Review gate mis-sized by median and uncosted | **Fixed.** Measured distribution (p90 42, max 285, 72 methods >30 LOC = 56% of parser method LOC); budgeted by LOC; two-reviewer items named; human-hours row added; LLM-reviews-LLM alternative stated plainly. §8.5, §10 |
| A7 | `test_build.py` cannot run through the bridge (38 operator lambdas); bridge narrowed to its worst workload | **Fixed.** Removed from bridge, hand-ported at P5. Two end-to-end bridge proofs (`test_errors.py`, `test_transpile.py`) moved to P0; per-module satisfiability in `CONTRACTS.md`. §3.8 |
| A8 | LOC/hour constant is uncalibrated | **Fixed.** Calibration spike is P0 day 3–6; re-baselined after P1 and P3. **Target changed** from the suggested `tokens.py` to `time.py` + `helper.py`, which are differential-testable at P0 with no oracle infrastructure. §7 P0, §10 |
| A9 | Go/no-go sits at the end of a 4–6 week serial phase | **Fixed.** Numeric + Unicode spike is P0 day 1–3. §7 P0 |
| A10 | Pinning CPython protects today's corpus and destroys upstream tracking | **Fixed.** Container built from the pinned tag's own `requires-python`, rebuilt each resync, fails loudly on floor moves; patch version in `PROVENANCE.json`. §5.2 |
| A11 | No license/attribution plan for a derivative work | **Fixed.** `LICENSE-sqlglot`, `NOTICE`, README attribution, CI commit-match check, corpus coverage — a P0 blocker. §5.3 |
| A12 | `NEEDS_BASE` queue on the critical path with no owner or latency bound | **Fixed.** Named owner per phase, drain-first rule, `foundation-additive` in-place escape, published queue depth. §8.1 R3 |
| — | "§1–§6 not supplied; not approving on the appendix" | **Fixed.** This document is complete. |

### Review B (semantics/verification)

| # | Objection | Disposition |
|---|---|---|
| B1 | `subsecond_precision` is CPython-version-dependent and reaches output SQL; corpus encodes the harvester's interpreter | **Fixed — the most serious finding in either review.** `PROVENANCE.json` + hard-fail, `pyFromIsoFormat` promoted to P0 against a pinned CPython grammar, targeted differential test. New risk R6. §4.6, §5.2 |
| B2 | `too_wide` / `sanitize_comment` are corpus-invisible; a `.length` port passes 15,642/15,642 | **Fixed.** `fuzz_toowide.py` and `fuzz_comments.py` as named mandatory P0 targets with purpose-built generators; P4 exit criteria. §3.4, R4 |
| B3 | 497 `unsupported()` calls are discarded under `ErrorLevel.IGNORE`, yet P4 asserts on them with no oracle | **Fixed.** Generate-oracle row schema captures `gen.unsupported_messages` (two-line harvester change); P4 exit asserts it. §3.1(D) |
| B4 | Three concrete Python-semantics sites missing (`encode` UTF-8 length, `chr` beyond BMP, `:04d` format spec); `_py/` surface derived from briefs, not a census | **Fixed.** All three shimmed (`utf8Len`, `pyChr`, `pyFormatInt`); `corpus/deny/py_builtins.json` generated census + lint, regenerated on every bump. §4.6 |
| B5 | Decimal blast radius is 63 invocations, not 11,921; 60–100h sized for a general `decimal` clone | **Accepted with a floor.** `_py/num.js` scoped to the reachable op set; budget 60–100h → **40–70h**. **Rejected:** any move of the Decimal gate off P0 — `str(Decimal)`/`str(float)` round-tripping is the hard part regardless of op count, and it is the go/no-go signal. §4.6, §10 |
| B6 | 19 base `*_sql` methods never exercised by the dialect suite | **Accepted with modification.** Hand-written native tests at the porting phase rather than `wontfix` — they are reachable from user code even though upstream's suite misses them. §3.5, P9 exit |
| — | Corpus adequacy (405/424 dispatch), whitespace analysis, determinism, operator census, `.title()`/`casefold` absence, §8 stub-seeding | **Confirmed; not re-litigated.** |

### Post-review addition

| # | Finding | Disposition |
|---|---|---|
| C1 | **Recursion depth**: JS has a fixed, non-tunable stack where Python has `setrecursionlimit`; a realistic generator frame overflows at **4,225** on Node v22 while upstream ships a test at N=**10,000**, and depth grows **linearly with input size** on binary/`UNION` chains | **Fixed.** New §4.7 + risk R11; `fuzz_depth` added as a sixth mandatory P0 target with its measured max-N in `CONTRACTS.md`; `DepthLimitError` before V8's `RangeError`; trampolines on the two depth-∝-N paths, lint-exempted by name; `--stack-size` rejected with rationale. P0 +10–15h. **Found by the orchestrator after both reviews signed off** — missed by all four architects and both adversarial reviewers because it is corpus-invisible (`test_redshift.py:529` asserts the iterative path). Logged here as evidence for R4's residual. §4.7, R11, P0/P4 exits |

### Ben's decisions (2026-08-24)

| # | Question | Answer | Disposition |
|---|---|---|---|
| Q1 | Priority #3: Postgres or BigQuery? | *"Our product requires Snowflake, Databricks, DuckDB and Postgres. Those go first."* | **No change.** Postgres stays at P8 as written; confirms (does not alter) DuckDB's existing forced-dependency placement at P6. §1, §9 Q1 |
| Q2 | v0 acceptance bar: ship at P6 (21.8%) or hold? | *"We will ship at P8"* | **Architecture-changing.** v0 boundary moves from P6 to P8 (41.9% atom closure). §1, §7 P6/P8, §9, §10 all restated. |
| Q3 | Interim release at P5? | *"We don't need an interim release"* | **No change to build order** — Tier B at P5 was never optional. Removes the "v0-minus" release option, moot now that v0 already extends to P8. §7 P5 |
| Q4 | Pin-and-catch-up vs continuous tracking? | *"Sounds good. Pin first"* | **No change.** Plan proceeds exactly as written (§5.1): pin through P4, continuous resync from P5. |
| Q5 | Build-time Python dependency acceptable? | *"This is acceptable (and needed)"* | **No change.** Plan proceeds exactly as written (§5.2). |

**Recommendation: approve, with answers to Q1–Q5.** Only Q2 changes the architecture; the rest change sequencing or calendar. The go/no-go is now **P0 day 3** — if the numeric and Unicode spikes are not green, come back and re-plan rather than proceed.