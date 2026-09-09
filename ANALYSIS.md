# Build-vs-Buy Analysis: Replacing the Gateway's Regex SQL Parser with tobilg/polyglot (WASM)

**Date:** 2026-09-09
**Question (Ben):** "Can we look at migrating from our lightweight regex SQL parsing engine to leveraging the WASM in github.com/tobilg/polyglot?"
**Scope:** Decision document only. No migration code. Compares three paths: keep the regex parser (`airbrx-gateway lib/utils/SqlParser.js`), adopt `@polyglot-sql/sdk` (Rust/WASM), or finish the in-house `airbrx/sqlglot-js` port for this role.

All facts below were independently verified on 2026-09-09 against: `airbrx/airbrx-gateway@b471559`, `airbrx/airbrx-advisor@08bd91d`, `airbrx/signal@0cc3fb7`, `tobilg/polyglot@44ab8f9` (+ npm registry for `@polyglot-sql/sdk`), this repo's results files, and Linear AIR-93.

---

## TL;DR recommendation

**Conditional go — but shadow-first, and narrower than "migrate the parser."**

1. **Polyglot replaces the parsing layer only, not the caching-policy layer.** Roughly 6 of SqlParser.js's 9 jobs are airbrx business logic that must be hand-built on top of *any* parser's AST (§2). What polyglot genuinely wins is dialect-correct table/CTE extraction, where the regex parser has at least nine structural blind spots (§1.2), one of which is a **stale-cache correctness vector** via missed invalidation, not just lost savings (§1.3).
2. **Do not flip the hot path now.** Polyglot publishes **zero** WASM latency/cold-start numbers (§4.2), the WASM binary is 21.4 MiB, the SDK requires Node ≥ 22, and the project is 8 months old with a bus factor of ~1 (§3.3). Run a shadow-mode differential (polyglot vs SqlParser.js on mirrored production traffic) to measure disagreement rate and p99 parse latency before any cutover.
3. **The advisor/gateway divergence risk is not fixed by this migration** and does not need it either — advisor's `tablesFrom()` needs *agreement with the gateway*, not full SQL parsing. Fix it now, cheaply, with a shared golden corpus test (§5).
4. **For this specific job, polyglot has far less remaining work than sqlglot-js** (§6). sqlglot-js is a strategic upstream-tracking transpiler port at ~42% of its own v0 closure target; it is not a near-term candidate for the SqlParser.js slot and should not be re-scoped into one. This analysis does not recommend retiring it — that is a separate decision about the transpiler roadmap, not the parser slot.

The three things most likely to flip this call are in §7.

---

## 1. What SqlParser.js actually is (verified inventory)

`airbrx-gateway lib/utils/SqlParser.js` is **919 lines**, one class (L31–917), zero external dependencies (sole require is the internal logger, L1). Entry point `parse(sql, options)` (L48–152) runs an 11-step pipeline. The design is documented as deliberate: *"There is no SQL grammar and no parser library. It is a regex and string pipeline, by design ('simple regex beats a transformation chain')"* — `airbrx/signal website/product-deepdive/docs/00-lifecycle-of-a-query.md` L151–156; same framing with named consequences in `04-rules-engine.md` L56–90.

### 1.1 The nine jobs it does

| # | Job | Where | Nature |
|---|-----|-------|--------|
| 1 | Statement-type classification (first word, uppercased; `WITH` look-ahead) | L352–361; category keyword lists L368–552 | Parsing-adjacent |
| 2 | Table + CTE extraction (`catalog.schema.table`, quote handling, CTE subtraction) | L560–746 | **Parsing** |
| 3 | Session-state-change parsing (`SET`/`USE`/`ALTER SESSION` → structured `{kind, key, value}`; null = safe-default mutation) | L378–487 | Parsing shape, **airbrx semantics** |
| 4 | Cache-override sentinels (`__AIRBRX_NOCACHE__` wins over `__AIRBRX_CACHE__`, scanned on **raw** SQL before comment stripping) | L160–172, called L80 | **Airbrx policy** |
| 5 | Parameter-placeholder detection (named `:x` > positional `?` > numbered `$1`, first style wins; literals stripped first) | L181–222 | Parsing |
| 6 | Non-deterministic function detection, grouped into TTL classes `date`/`time`/`user` | L12–29, L231–275 | **Airbrx TTL policy** |
| 7 | SQL standardization for cache keys (strip comments, collapse whitespace, uppercase ~70 keywords, lowercase qualified table names, `DESC`→`DESCRIBE`; **no literal templating**) | L293–304, L748–854 | **Airbrx cache-key contract** |
| 8 | Thrift metadata-operation short-circuit (10 op types bypass parsing) | L60–73, L890–916 | Airbrx plumbing |
| 9 | Session catalog/schema enrichment of unqualified tables + fully-qualified check | L92–101, L494–502 | Airbrx policy |

Callers: `adapters/databricks/handlers/ExecuteStatementHandler.js` L43–44, `adapters/databricks/JsonRequestProcessor.js` L204–205, `adapters/snowflake/Adapter.js` L54/L474/L795/L1114, `adapters/postgresql/PostgresqlAdapter.js` L2368. Consumers of the result: `lib/cache/RuleEvaluator.buildCacheKey` (standardizedSql → cache key), `lib/cache/RuleConditionMatcher.js` (tables, nonDeterministic.types), `lib/cache/TtlStrategyCalculator.js`, `adapters/databricks/Session.js` (session-state replay), `adapters/postgresql/SchemaCache.js` (tables → DDL invalidation markers).

Test coverage: ~51 direct cases across `test/sql-parser-parameters.test.js` (18), `test/sql-parser-non-deterministic.test.js` (13), `test/session-state-replay.test.js` (~20, ~7 hitting SqlParser directly), plus integration tests. **Table/CTE extraction — the hardest part — has no dedicated unit test file.**

### 1.2 Verified blind spots in table/CTE extraction

From direct inspection of the regexes (gateway `lib/utils/SqlParser.js`):

1. **Multi-CTE leak:** `_extractCteNames` (L563–566) captures the WITH clause only up to the *first* `SELECT` — which is inside the first CTE's body. In `WITH a AS (SELECT…), b AS (SELECT…) SELECT … FROM b`, only `a` is registered; `b` is reported as a real table. (The CTE bug AIR-93 calls "fixed" is only fixed for the single-CTE case.)
2. Comma-separated FROM lists (`FROM a, b`) capture only the first table (L649).
3. No paren balancing anywhere; nested subqueries work only incidentally.
4. String literals are **not** stripped before table extraction (only before parameter/non-deterministic detection), so `'… FROM x …'` inside a literal false-positives.
5. Quoted identifiers containing a `.` are wrongly split by the unconditional `split('.')` (L724).
6. Double-quoted (Snowflake-style) identifiers are supported **only on the SELECT path**; the INSERT/UPDATE/DELETE/MERGE/DDL regexes use `` [\w.`]+ `` and miss them (L657–719).
7. `CREATE MATERIALIZED VIEW mv` captures `MATERIALIZED` as the table name (L711–714).
8. Comment stripping is itself regex-based, so `--` or `/*` inside a string literal corrupts the statement before extraction (L293–304).
9. Table-valued functions after FROM are captured as tables; `?` in Postgres jsonb operators and `::int` casts false-positive as parameters (L200–214).

The signal docs are honest about the class of limitation (`04-rules-engine.md` L120–124: literals not templated; L310: the `columns` rule condition is "dead — the parser never extracts columns").

### 1.3 Blast radius of those blind spots — mostly fail-safe, one exception

- Parse *failure* degrades to passthrough, not a bad cache decision (`test/cache/deny-rules.test.js` injects a throwing parser to prove it).
- A *missed table on a read* means a `tables` rule condition doesn't match → falls through to defaults → typically **not cached** (lost savings, fail-closed per advisor's `docs/gateway-cache-rules.md` L22).
- **The exception:** `adapters/postgresql/SchemaCache.js` uses extracted `tables` + `isDDL` for invalidation markers, and advisor-generated invalidation rules match on extracted write-statement tables. A **missed table on a write path** (e.g. a double-quoted identifier in an UPDATE, blind spot #6) means an invalidation that never fires → **stale cached results served**. This is the one place where extraction bugs are a correctness problem, and it is the strongest argument for a real parser.

---

## 2. Fit: where the polyglot/hand-built line falls

Polyglot replaces the **parsing** layer. The **policy** layer must be rebuilt on top of any parser, polyglot or otherwise. Precisely:

### 2.1 Clean wins (polyglot's AST/analyzeQuery covers it directly)

- **Table + CTE extraction (job #2):** `analyzeQuery` returns `baseTables` — "deduplicated physical dependencies across nested CTEs, derived tables, subqueries, and set-operation branches," each with parsed `catalog`/`schema`/`table` parts — plus `cteFacts` (top-level CTE definitions) and `setOperations[].branches[]` (`packages/sdk/README.md`, "Compact Query Analysis"). This structurally eliminates all nine blind spots in §1.2, in both Databricks and Snowflake dialects (both listed in the 34-dialect table, root `README.md`, "Supported Dialects"). There is also a lower-level `getSourceTables` and full lineage API.
- **Statement-type classification (job #1):** the typed AST root node type is strictly more reliable than first-word-plus-`WITH`-lookahead.
- **Parameter detection (job #5):** first-class AST node `Parameter { name, index, style, … }` with `ParameterStyle = "Question" | "Dollar" | "Colon" | "At" | …` (`dist/index.d.ts` L10919–10954) — covers named/positional/numbered and more, without the literal-stripping heuristics.
- **Comment access (needed for job #4 if ever moved off raw-regex):** `tokenize()` returns per-token `comments[]`/`trailingComments[]` with byte-offset spans; AST nodes carry `leading_comments`/`trailing_comments` (`dist/index.d.ts` L669, L2944). Note the current sentinel scan is two regexes on raw SQL (L160–172) and **doesn't need a parser at all** — keep it as-is.

### 2.2 Hand-built on top of ANY parser (airbrx business logic)

- **Session-state-change semantics (job #3):** polyglot can parse `SET`/`USE`, but the `{kind: 'set'|'read'|'use_catalog'|'use_schema'|'use_namespace'|'alter_session', key, value}` shape, the `SET k v` no-equals Databricks form, the null-means-forced-non-cacheable-mutation contract (SqlParser.js JSDoc L407–413), and the replay integration in `adapters/databricks/Session.js` are all airbrx semantics. Mapping AST → this shape is new code either way.
- **Non-deterministic TTL classes (job #6):** the `date`/`time`/`user` grouping and its TTL-strategy meaning (SqlParser.js L2–21) is pure airbrx policy. A parser makes *finding* function calls more reliable (no string-literal heuristics), but the classification table is ours.
- **Cache-key standardization (job #7):** this is a **compatibility contract, not a parsing problem**. `RuleEvaluator.buildCacheKey` consumes `standardizedSql`; any change to the normalization output **churns every existing cache key fleet-wide on deploy**. Rendering SQL through polyglot's generator would produce differently-formatted text and invalidate all caches. Any migration must keep `_standardizeSql` byte-identical initially, which means polyglot's first production role is jobs #1/#2/#5 only.
- **Sentinels (job #4), metadata short-circuit (#8), session enrichment (#9):** trivially retained as-is; none touch parsing.

**The line:** polyglot = tokenize/parse/extract-facts. Airbrx keeps = classify-for-policy, session semantics, TTL classes, sentinels, cache-key format, enrichment. That policy layer is roughly 500 of SqlParser.js's 919 lines and survives any vendor choice.

### 2.3 Fit caveats

- **Error behavior is good for a proxy:** no exceptions — `success: false` result objects with line/column/byte offsets (`packages/sdk/README.md`, "Error Reporting"). Maps cleanly onto the existing degrade-to-passthrough contract.
- **Dialect fidelity is self-attested:** the "**143,610** strict Rust/FFI test cases … **100%**" claim (root `README.md`, "Testing") is real but self-judged — 121,020 of it is one ClickHouse round-trip corpus, and the 11,333 "SQLGlot fixture cases" are sqlglot's fixture *inputs* re-judged by polyglot's own comparison harness (`tools/sqlglot-compare/`), not sqlglot's assertions run verbatim. Treat as a strong signal, not proof; the shadow diff in §7 is the real test for *our* traffic.

---

## 3. Polyglot maturity signals

- **Real and shipping:** `@polyglot-sql/sdk` v0.9.2 on npm (published 2026-08-18), 64 versions since 0.1.0 (2026-02-12), MIT license, zero runtime dependencies. Repo created 2026-01-15; 947 stars; 56 GitHub releases at a ~3-day cadence for 6 months. Explicitly inspired by sqlglot; features include typed AST, transpile, `analyzeQuery`, column lineage, validation, guard limits.
- **Requirements:** `engines: node >= 22` (`packages/sdk/package.json`). Verify against the gateway's current Node version before anything else.
- **Bus factor ≈ 1:** tobilg has 167 commits; every other contributor ≤ 3 (~92% single-author). Sole npm publisher. No release in the ~3 weeks before 2026-09-09 (previously ~3-day cadence). An 8-month-old single-maintainer project on the hot path of a caching proxy is the largest structural risk. Mitigations if adopted: pin exact version, vendor the tarball, and note MIT allows a hard fork.

---

## 4. Operational cost on the hot path

### 4.1 What is known

- **WASM artifact: 22,393,910 bytes (~21.4 MiB)** — measured from the published 0.9.2 tarball (`package/dist/polyglot_sql.wasm`, 92% of the 24.2 MB unpacked package; 5.46 MB compressed tarball). One all-dialects build; "per-dialect subpath packages … are not published" (`packages/sdk/README.md`, "Installation"). For a long-lived Node proxy this is a one-time disk/RSS cost (expect tens of MB of resident memory for the compiled module + instance), not a per-request cost — but it is a real container-image and cold-start consideration.
- **Init is async:** Node ESM auto-inits from disk; CJS requires explicit `await init()` before any call (`packages/sdk/README.md`, "CommonJS Usage"). One-time at process start; must be sequenced before the proxy accepts traffic.
- **Native benchmarks exist and are good:** TPC-H parse 83–104 µs, short queries ~9 µs, geometric mean 3.4–3.5x faster than mypyc-compiled sqlglot (`docs/benchmark.md`; `docs/current-benchmarks.md`, 0.6.0, 2026-07-14). All author-run on Apple M2.

### 4.2 What is NOT known — and must be measured

- **No WASM latency, cold-start, or memory numbers are published anywhere in the repo.** `docs/current-benchmarks.md` explicitly excludes WASM builds. Every published number is native Rust or Python bindings. WASM will be slower (typically 1.5–5x native, plus wasm-bindgen JSON serialization of a large AST per call) — but "slower than 100 µs native" plausibly still lands well under 1 ms, versus the regex parser's rough tens-of-µs of regex passes. **Plausibly fine; entirely unmeasured. This is the single most important pre-adoption measurement.**
- **Stack safety differs in WASM:** the native build uses `stacker` for stack growth; "WASM does **not** use `stacker`" (root `README.md`, "Features"). Deeply nested adversarial SQL on a proxy is exactly where that bites. Mitigant: `complexityGuard` limits with `E_GUARD_*` error codes exist and must be configured, with guard-trips wired to the existing passthrough degrade path.

Comparison baseline: SqlParser.js is near-zero overhead (a few dozen regex passes, no init, no memory footprint, zero deps) and its failure mode is already production-proven fail-open.

### 4.3 Addendum (2026-09-09): first-order measurements — all four engines, same box

Since no WASM numbers exist upstream, we measured directly: Node v22.12.0, 2-core aarch64 (the Agor box — slower than gateway hardware, so treat ratios as the signal, not absolutes). Four representative gateway-shaped queries (short SELECT, CTE+join, INSERT…SELECT, windowed analytic), Databricks dialect, min-of-5 reps. Harness: `/tmp/parserbench` (throwaway; regex parser exercised via a read-only copy of `SqlParser.js` with the logger stubbed).

| Engine | Cold init | Steady-state RSS¹ | short | cte_join | insert_sel | analytic |
|---|---|---|---|---|---|---|
| regex SqlParser (full `parse()`) | ~0 ms | ~63 MB | 43 µs | 77 µs | 49 µs | 75 µs |
| polyglot 0.9.2 WASM `parse` | 190 ms | **~510 MB** | 34–103 µs² | 213 µs | 80 µs | 244 µs |
| polyglot `analyzeQuery` | — | — | 54–73 µs | 649 µs | 54 µs | 828 µs |
| sqlingo.js 0.6.1 (`parseOne`) | 111 ms | ~102 MB | 84 µs | 441 µs | 133 µs | 451 µs |
| sqlglot-js (this repo, today³) | 168 ms | ~184 MB | 37 µs | 209 µs | 77 µs | 237 µs |

¹ RSS after 80k–160k sustained calls with forced GC; Node baseline alone is ~43 MB. ² 103 µs first-measured, 34 µs later in the same process (JIT warm-up); true warm cost is the low end. ³ Parse-only via the spike harness (`tokenizerFor`/`parserClassFor` + `Parser.parse`); all four queries parsed exact in both Databricks and Snowflake with zero NotPorted hits. A "completed" sqlglot-js wouldn't be slower on these — completion adds coverage, not per-call cost — but it lacks an `analyzeQuery` equivalent, so add a (cheap, boundary-free) JS AST walk for table extraction.

**Findings:**

1. **Latency is a non-issue for all three candidates.** The regex parser's own full pipeline costs 43–77 µs — it is *not* orders of magnitude faster than real parsers. Worst case measured anywhere is polyglot `analyzeQuery` at 828 µs on the windowed-analytic query. Sub-millisecond parse overhead in front of warehouse queries that take seconds is noise. The §4.2 latency concern is resolved at first order (production-traffic shapes still deserve the shadow run).
2. **Memory is polyglot's real cost, not latency.** WASM linear memory grows to peak workload and never shrinks: ~510 MB steady-state RSS under sustained `analyzeQuery` load, stable over 160k calls (no leak — verified flat from call 20k to 160k) but ~8x the regex baseline and ~3–5x the pure-JS engines (~100–185 MB). Per-container memory budgeting, not p99 latency, is the polyglot line-item.
3. **Correctness spot-check:** polyglot's `analyzeQuery.baseTables` on the CTE query returned exactly `prod.sales.orders` + `prod.crm.customers` with catalog/schema/table parts split and CTE names excluded — the precise output shape SqlParser.js's `_extractTables` blind spots fail on.
4. **sqlglot-js already matches polyglot's WASM parse speed** (37–240 µs vs 34–244 µs) — a transliterated-Python JS parser under V8 is not slow, and has no serialization boundary. sqlingo.js is ~2x slower on complex queries (consistent with its stated performance non-goal) but still sub-millisecond.
5. Caveats: 4 queries is a smoke test, not a distribution; the 510 MB plateau depends on peak query complexity; polyglot's `analyzeQuery` does strictly more work than bare `parse` (transitive analysis + JSON boundary); no measurement of pathological/adversarial inputs (where WASM's missing `stacker` matters — guard configuration still required).

---

## 5. The advisor divergence risk — explicitly not fixed by this migration

`airbrx-advisor` has its own extractor, `tablesFrom()` — **now at `src/core.js:1155–1176`** (the `597–618` cite in `docs/gateway-cache-rules.md:113` is stale; the file has grown to 1,186 lines). It is 22 lines: two regexes (bare + dialect-quoted identifiers after FROM/JOIN), lowercase, 6-word denylist, cap at 8. Called from `classify()` (`src/core.js:279`, display) and `buildRules()` (`src/core.js:1008`), where it feeds generated `tables.includesAny` cache-rule conditions and per-table **invalidation rules** (`src/core.js:1026`, 1052–1069).

The documented risk (`docs/gateway-cache-rules.md:113`): *"`tables.includesAny` correctness depends on two independent SQL parsers agreeing … A table name advisor's regex misses … produces a generated rule that silently fails to match traffic … falling through to `defaults`."* And `:107`: a pattern with no extractable table gets **no invalidation rule at all**.

Three consequences for this decision:

1. **Migrating the gateway alone makes divergence *worse*, not better.** Advisor's regex would then need to agree with polyglot's AST extraction — a bigger behavioral gap than agreeing with the gateway's sibling regex. If the gateway adopts polyglot, advisor's extraction must be migrated in the same release train (or advisor must consume gateway-produced names).
2. **Advisor does not need full SQL parsing.** It runs **in the browser** over warehouse query-history samples (`src/core.js:1–4`), one representative statement per pattern, top-15, capped at 8 tables, with a `statement.contains` fallback when extraction fails. Its real requirement is *string-equality agreement with whatever the gateway emits* (its own comment: "Matching the cache is the goal, not matching a correct parser," `src/dialects/snowflake.js:35–36`). Shipping a 21.4 MiB WASM to a browser tool for this is overkill; if the gateway migrates, the cheaper fix is a shared extraction spec + golden corpus, or advisor calling a gateway/API-side extractor.
3. **This is fixable today for near-zero cost, independent of any parser decision:** a shared golden corpus of (statement → expected table names) vendored into both repos' test suites. Today **no test anywhere asserts advisor/gateway agreement**, and advisor's `tablesFrom` has no test for comma-joins, CTE-name capture, or mixed quoting — exactly the cases its own doc flags. Recommend doing this first regardless of the polyglot outcome.

---

## 6. Build vs buy: sqlglot-js vs polyglot for the SqlParser.js slot

### 6.1 Where sqlglot-js actually is (this repo, measured)

Substantial and rigorous — 229 commits since 2026-08-21, **31,845 LOC** under `src/`, plus 5,952 LOC of spike/fuzz infra and ~4,500 LOC of tooling, all differentially verified against a pinned CPython sqlglot (`91119bc`, `UPSTREAM.txt:2`) over a 15,540-atom corpus harvested from upstream's own tests:

- **Tokenizer:** complete — 23,389 token streams / 291,162 tokens across 33 dialects, 0 divergences (`P1_RESULTS.md:22`).
- **Expressions:** complete — 1,048 classes, 15,540/15,540 byte-exact AST round-trips (`P2_RESULTS.md:9–11`).
- **Parser:** 93.99% closure — 14,606/15,540 oracle rows; 38 EXACT / 0 MISMATCH on reached endpoints (`P3_RESULTS.md`, §"Parser closure"); 342/405 methods implemented. Per-dialect exact-parse: Snowflake 2,374/2,404 reached (98.8%), Databricks chain 90%+, Postgres 98.0%, DuckDB 98.3%; 10,677/15,478 exact across all 46 dialects (`README.md:11–16`).
- **Generator:** the gap — only base + Snowflake generators exist (~409 NotPorted stubs in `src/generator.js`); 1,595/15,540 atoms closed (10.3%) (`CLOSURE.md`, per-phase table). The v0 target (P8: +Databricks chain, DuckDB, Postgres, Redshift) is **6,522/15,540 = 42%**, with P9 (all 46 dialects) the 100% line.
- **Status:** explicitly "in progress, no public API yet … no npm package and no stable entry point" (`README.md:7`).

### 6.2 Remaining work to a production-safe SqlParser.js replacement, per path

**Via sqlglot-js:** the read path (parse → AST) for Databricks + Snowflake is genuinely close (98%+ exact on reached rows), and it is zero-dependency, which matches the gateway's ethos. But: (a) it has no stable API surface, packaging, or production hardening posture yet; (b) a table/CTE-extraction + analysis layer (the equivalent of `analyzeQuery`) does not exist and would be new code; (c) the remaining 6% parse closure and the 63 base-parser stubs sit exactly in the long tail where production traffic lives; (d) the project's charter is an upstream-tracking full transpiler port (parser + generator + eventually optimizer), and bending it into a near-term gateway dependency both rushes it and distorts its roadmap. Realistic remaining work: months, mostly work that polyglot has already shipped.

**Via polyglot:** (a) an adapter module implementing SqlParser.js's result-object contract on top of `parse`/`analyzeQuery`/`tokenize` — order of a few hundred lines, since the policy layer (§2.2) is retained verbatim; (b) a shadow-mode differential harness against production traffic; (c) WASM perf/memory measurement and guard configuration; (d) ops work: Node ≥ 22, version pinning/vendoring, image size. Realistic remaining work: weeks, dominated by validation rather than construction.

**Verdict on remaining work: polyglot, clearly** — for this slot. Note the irony that both candidates are sqlglot lineages: polyglot is a Rust reimplementation *inspired by* sqlglot claiming its fixture suite; sqlglot-js is a literal port *verified against* it. Polyglot is effectively the "buy" version of the thing being built here, ~7 months further along on the generator/dialect surface, at the cost of a WASM boundary, a 21 MiB artifact, and a single external maintainer versus zero dependencies and full control.

### 6.3 Addendum (2026-09-09): huydo862003/sqlingo.js — a third candidate, evaluated on request

Ben asked about [github.com/huydo862003/sqlingo.js](https://github.com/huydo862003/sqlingo.js). It is **not another polyglot** — it is a **pure-TypeScript hand-port of sqlglot**, i.e. an independent external version of exactly what this repo is building, from the same philosophy ("sqlingo.js should be a close mirror to SQLGlot. This way, it can quickly catch up with SQLGlot bug fixes and new releases" — root `README.md`, "Goals").

**Verified facts** (repo at `a03b117`, npm registry, 2026-09-09):

- Pure TS, no WASM. Pinned to upstream sqlglot **v29.0.0** (commit `4a38462`, declared in `packages/sqlingo.js/package.json` `"sqlglot"` field; upstream vendored as a git submodule). MIT. Published as `@hdnax/sqlingo.js` **v0.6.1** (2026-09-02), 26 versions since first publish 2026-03-18; repo created 2026-02-06. **~7 months old, 9 stars, 1 fork, 3 open issues, single maintainer** (Huy-DNA; the only other contributor account shares his email root).
- 32 dialects including **Databricks, Snowflake, Spark2** via tree-shakeable per-dialect subpath exports (`./databricks`, `./snowflake`, …; `sideEffects: false`). npm unpacked 14.2 MB / 283 files, but that's untree-shaken JS+d.ts, not a binary blob. Browser-capable (that was the author's whole motivation). Runtime deps: none except a **`luxon` ^3.7.2 peer dependency** — so not literally zero-dep.
- **Self-labeled alpha:** "WARNING: This package is still in alpha… finding contrived failures may require me to use this package extensively myself" (README). Explicit **non-goals: "Optimized performance. Optimized bundle size."** (README, "Goals (& Non-goals)"). **Zero published benchmarks of any kind.**
- **Verification methodology is ported-tests-pass, not differential.** The test suite is TS translations of upstream's test files (30 dialect test files under `packages/sqlingo.js/tests/upstream/dialects/`) plus fixtures. The CHANGELOG is candid about what that misses: v0.4.0 "Add missing snowflake, presto, clickhouse tests … (undiscovered before) … not 100% tests are passing yet"; v0.6.0 (2026-09-02, one week ago) "Resolve all 44 failing dialect tests ported from sqlglot v29.0.0" plus fixes for missing `register()` calls, Python-`None`-vs-JS-`undefined` semantics, `@cache` inheritance bugs, and "test porting issues." Also started AI-generated and was hand-rewritten (v0.1.4 "Migrating from AI slops", v0.2.0 "Complete AI migration. Most code are human-generated now").

**Assessment for the SqlParser.js slot:** ranks **third**. Same in-principle parsing wins as polyglot (dialect-correct AST for Databricks + Snowflake), and the pure-TS/no-WASM/browser-capable shape is genuinely attractive (no Node ≥ 22, no binary artifact, could serve advisor too). But: alpha by its own label; performance an explicit non-goal on a hot path where polyglot at least has native benchmarks; no `analyzeQuery` equivalent (table/CTE extraction = hand-written AST walking); a week ago 44 of its dialect tests were failing; and 9 stars / bus factor 1 versus polyglot's 947 / bus factor 1. Its ported-tests-pass verification is strictly weaker than both polyglot's fixture-judging harness and sqlglot-js's byte-exact differential oracle — and its own changelog independently reproduces the exact defect classes this repo's R-series findings documented (mis-ported tests, missing registrations, None/undefined semantics), which is empirical confirmation that hand-porting sqlglot *without* a CPython differential harness ships silent divergences.

**Assessment for the sqlglot-js roadmap (the bigger implication):** sqlingo.js is proof that a solo hand-port of sqlglot to TS reaches all-ported-tests-green alpha in ~7 months — it is prior art against building from scratch, and worth considering as a collaboration target, cross-check oracle (three-way differential: CPython vs sqlglot-js vs sqlingo.js on the 15,540-atom corpus would be cheap and mutually revealing), or fork base. It does not currently meet sqlglot-js's stated bar (zero-dep — luxon; differential verification — none), but the overlap in goals is near-total. That conversation belongs to the transpiler roadmap, not this parser decision.

### 6.4 Prior art: AIR-93

Linear AIR-93 ("Consider replacing regex-based SQL parser with node-sql-parser", created 2025-10-18 by Ben, Low priority) proposed the same *shape* of change with a different library, motivated by the same CTE-extraction bug class, and proposed the same architecture this analysis endorses: AST parse with **regex fallback on failure**. It was **Canceled on 2026-05-14 with no recorded rationale** (no comments on the ticket; status history Backlog → Canceled). The cancellation predates the sqlglot-js port kickoff (2026-08-21). Relevant differences from node-sql-parser: polyglot's dialect coverage (explicit Databricks + Snowflake), the sqlglot fixture lineage, and the analysis API are all materially stronger than what AIR-93 evaluated.

---

## 7. Recommendation and decision triggers

### Recommended sequence

1. **Now, regardless of parser choice:** create the shared advisor↔gateway golden extraction corpus (§5.3). It converts the documented silent-divergence risk into a red test, costs hours, and also becomes the acceptance suite for any future parser swap. Also add table-extraction unit tests to the gateway (there are none today) covering §1.2's nine cases — this quantifies the regex parser's *actual* bug exposure on real traffic patterns, which is currently anecdotal.
2. **Shadow evaluation of polyglot (no production dependency yet):** run `@polyglot-sql/sdk` beside SqlParser.js on mirrored/replayed gateway traffic. Measure: (a) disagreement rate on tables/statement-type/parameters, triaged into "regex wrong" vs "polyglot wrong" vs "both defensible"; (b) p50/p99 WASM parse latency and RSS on gateway hardware; (c) guard-trip rate on real query shapes. This fills the two evidence gaps polyglot's own docs leave open (WASM perf, fidelity on *our* traffic).
3. **If shadow results are clean:** adopt polyglot for jobs #1/#2/#5 (classification, table/CTE extraction, parameters) behind the existing fail-open contract — parse failure or guard trip falls back to the current regex path, exactly the AIR-93 architecture. Keep sentinels, session-state semantics, TTL classes, and `_standardizeSql` **byte-identical** (cache-key stability, §2.2). Migrate advisor's `tablesFrom` in the same release train. Pin and vendor the polyglot version.
4. **sqlglot-js continues on its own charter** (upstream-tracking transpiler). If step 3 ships, the *parser-for-caching* pressure on it disappears, which is an argument for letting it proceed at strategic pace — or for an explicit priorities conversation, but that is a roadmap decision outside this document's scope.

### The three things that would most change this recommendation

1. **WASM hot-path cost measures badly** — e.g. p99 parse > ~1–2 ms on gateway hardware, RSS growth, or meaningful guard-trip rates on real traffic. Then: no-go on polyglot for the hot path; options become async/out-of-band parsing for invalidation only, or waiting on sqlglot-js.
2. **The regex parser's measured bug rate on production traffic is ~zero.** If the step-1/step-2 corpus shows the §1.2 blind spots almost never fire on actual customer SQL (highly templated BI traffic may simply not hit them), the honest answer is "neither" — the switch doesn't pay for its risk, and the advisor golden corpus alone closes the real documented gap. The stale-cache invalidation vector (§1.3) is the one finding that argues against complacency here.
3. **Polyglot's health changes materially** — maintainer abandonment (watch the release cadence; last release 2026-08-18), or the shadow diff reveals the self-judged 100% claim doesn't hold on Databricks/Snowflake traffic. Conversely, if sqlglot-js reaches its P8/v0 closure (42%) with a stable API faster than expected, the zero-dependency in-house path becomes competitive again for this slot and eliminates the bus-factor concern entirely.

---

## Appendix: source-of-truth citations

| Claim area | Source |
|---|---|
| SqlParser.js structure, pipeline, blind spots | `airbrx/airbrx-gateway` `lib/utils/SqlParser.js` (919 lines, blob `80aac25`): parse L48–152, sentinels L160–172, params L181–222, non-det L12–29/L231–275, normalize L293–304, statement type L352–361, session-state L378–487, tables/CTE L560–746, standardize L748–854, metadata L890–916 |
| Design rationale, honest limitations | `airbrx/signal` `website/product-deepdive/docs/00-lifecycle-of-a-query.md` L151–156, L173–175; `04-rules-engine.md` L56–90, L120–124, L310 |
| Gateway call sites / consumers | `adapters/databricks/handlers/ExecuteStatementHandler.js` L43–44; `adapters/snowflake/Adapter.js` L54, L474, L795, L1114; `adapters/postgresql/PostgresqlAdapter.js` L2368; `lib/cache/RuleEvaluator.js`, `RuleConditionMatcher.js`, `TtlStrategyCalculator.js`; `adapters/postgresql/SchemaCache.js` |
| Fail-open proof | `airbrx-gateway` `test/cache/deny-rules.test.js` (throwing parser → passthrough) |
| Advisor extractor + divergence risk | `airbrx/airbrx-advisor` `src/core.js:1149–1176` (tablesFrom), `:279`, `:1008–1069` (call sites); `docs/gateway-cache-rules.md:22, :107, :113`; `docs/cacheability-model.md:229`; browser/log-sample context `src/core.js:1–4`, `src/dialects/snowflake.js:35–36, :565` |
| Polyglot claims | `tobilg/polyglot@44ab8f9` root `README.md` ("Supported Dialects" — 34 incl. Databricks + Snowflake; "Testing" — 143,610 @ 100%, self-judged via `tools/sqlglot-compare/`; "Features" — WASM lacks `stacker`); `packages/sdk/README.md` (analyzeQuery shape, init modes, error objects, no per-dialect builds); `packages/sdk/package.json` (v0.9.2, node ≥ 22, zero deps); `dist/index.d.ts` L669, L2944, L10919–10954 (comments, Parameter/ParameterStyle) |
| Polyglot benchmarks (native only) | `docs/benchmark.md`, `docs/current-benchmarks.md` (explicitly no WASM), `docs/performance-benchmarks.md` |
| Polyglot size / registry / bus factor | npm `@polyglot-sql/sdk` 0.9.2: unpacked 24,247,556 B, `dist/polyglot_sql.wasm` 22,393,910 B, first publish 2026-02-12; GitHub contributors: tobilg 167 commits, next ≤ 3; 947 stars, repo created 2026-01-15 |
| sqlglot-js status | This repo: `README.md:7, :11–16`; `P1_RESULTS.md:22`; `P2_RESULTS.md:9–11`; `P3_RESULTS.md` §"Parser closure" (14,606/15,540 = 93.99%; 38 EXACT/0 MISMATCH); `CLOSURE.md` per-phase table (P4 1,595 = 10.3% … P8 6,522 = 42.0%, P9 = 100%); `UPSTREAM.txt:2`; measured LOC: `src/` 31,845, `spike/` 5,952; 229 commits |
| Prior art | Linear AIR-93 (created 2025-10-18, Low priority, **Canceled 2026-05-14**, no comments/rationale recorded) |
| sqlingo.js (addendum) | `huydo862003/sqlingo.js@a03b117`: root `README.md` (alpha warning, goals/non-goals, luxon peer dep, backstory); `packages/sqlingo.js/package.json` (sqlglot pin v29.0.0/`4a38462`, per-dialect exports); `packages/sqlingo.js/CHANGELOG.md` (v0.6.0 "44 failing dialect tests" 2026-09-02, v0.4.0 "undiscovered" tests, AI-rewrite history); `tests/upstream/dialects/` (30 ported dialect test files); npm `@hdnax/sqlingo.js`: v0.6.1, 26 versions since 2026-03-18, unpacked 14,155,483 B, sole maintainer; GitHub: created 2026-02-06, 9 stars |
