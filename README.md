# sqlglot-js

A zero-dependency JavaScript port of [sqlglot](https://github.com/tobymao/sqlglot) — a no-dependency SQL parser, transpiler, and AST toolkit.

This is a derivative work of sqlglot (MIT License, Copyright (c) 2026 Toby Mao). See [NOTICE](NOTICE) and [LICENSE-sqlglot](LICENSE-sqlglot) for attribution, and [UPSTREAM.txt](UPSTREAM.txt) for the current upstream pin.

**Status:** in progress, no public API yet. There is no npm package and no stable entry point to import — everything below is internal, differentially tested against a pinned CPython `sqlglot` install rather than exposed for use. See [PORT_PLAN.md](PORT_PLAN.md) for the full implementation plan, phase breakdown, and every measured number this README summarizes. Tracked in Linear: [sqlglot-js Port](https://linear.app/airbrx/project/sqlglot-js-port-fde0e002e19d).

**What works today, measured against the real corpus** (`node spike/p3/fuzz_ast_coverage.mjs`, 15,478 rows harvested from upstream's own dialect test suite): parsing SQL into an AST is implemented for the base grammar plus three dialects' own parser overrides —

| dialect | exact AST match |
|---|---|
| Snowflake | 2,355 / 2,464 reached (98.7%) |
| Databricks chain (Hive, Spark2, Spark, Databricks) | spark2 100%, hive/spark/databricks 90%+ |
| Postgres | in progress |

— **9,888 of 15,478 rows exact across all 46 dialects** overall (base-grammar coverage benefits every dialect, not just the three above). Every number is machine-checked against a pinned CPython `sqlglot` install, not asserted by hand; `PORT_PLAN.md`'s R13–R18 findings are the record of what that checking has caught so far.

**What doesn't exist yet:**
- **No SQL generation.** There is no `Generator` (P4) — you can build or parse an AST, but not turn it back into a SQL string, except for a deliberately narrow ~200-LOC internal kernel used at two mid-parse call sites. No transpiling between dialects.
- **No dialect registry.** Dialects are not selectable by name (`"snowflake"`) anywhere in `src/` — `CONTRACTS.md` §8 forbids that until a real `Dialect` class exists (P5), specifically because a silent fallback to the default dialect would make every per-dialect test vacuously pass. The differential tests select a dialect's `Parser` subclass directly, as a plain import.
- **No package.** No `package.json`, no `index.js`, nothing published or importable from outside this repo.

**Zero runtime dependencies** — enforced by CI. Node ≥ 20 and modern browsers, ESM. (Build-time verification tooling depends on a pinned Python `sqlglot` install; the runtime library will not.)

**Docs:** [`docs/`](docs/) describes the public API this project is building toward — written ahead of the implementation, the way you'd write a test before the code it tests. Treat those docs as a spec to build against, not a description of current capability; each one says plainly which parts already work.
