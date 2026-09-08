# sqlglot-js

A zero-dependency JavaScript port of [sqlglot](https://github.com/tobymao/sqlglot) — a no-dependency SQL parser, transpiler, and AST toolkit.

This is a derivative work of sqlglot (MIT License, Copyright (c) 2026 Toby Mao). See [NOTICE](NOTICE) and [LICENSE-sqlglot](LICENSE-sqlglot) for attribution, and [UPSTREAM.txt](UPSTREAM.txt) for the current upstream pin.

**Status:** in progress, no public API yet. There is no npm package and no stable entry point to import — everything below is internal, differentially tested against a pinned CPython `sqlglot` install rather than exposed for use. See [PORT_PLAN.md](PORT_PLAN.md) for the full implementation plan, phase breakdown, and every measured number this README summarizes. Tracked in Linear: [sqlglot-js Port](https://linear.app/airbrx/project/sqlglot-js-port-fde0e002e19d).

**What works today, measured against the real corpus** (`node spike/p3/fuzz_ast_coverage.mjs`, 15,478 rows harvested from upstream's own dialect test suite): parsing SQL into an AST, through a real `Dialect` registry, for the base grammar plus all four originally-prioritized dialects' own parser overrides —

| dialect | exact AST match |
|---|---|
| Snowflake | 2,374 / 2,404 reached (98.8%) — real `Dialect` settings class too, not just the parser |
| Databricks chain (Hive, Spark2, Spark, Databricks) | spark2 100%, hive/spark/databricks 90%+ |
| Postgres | 883 / 901 reached (98.0%) |
| DuckDB | 973 / 990 reached (98.3%) |

— **10,677 of 15,478 rows exact across all 46 dialects** overall (base-grammar coverage benefits every dialect, not just the four above). Every number is machine-checked against a pinned CPython `sqlglot` install, not asserted by hand; `PORT_PLAN.md`'s 24 R-series findings are the record of what that checking has caught so far.

```js
import { Dialect } from "./src/dialects/dialect.js";
import "./src/dialects/snowflake.js"; // registers itself on import

const [ast] = Dialect.get_or_raise("snowflake").parse("SELECT id FROM t WHERE active = TRUE");
ast.constructor.name; // "Select" — a real AST, today, no package needed yet
```

**What doesn't exist yet:**
- **No SQL generation for most dialects.** A base `Generator` exists (`src/generator.js`) with a working dispatch mechanism, verified against a real generate-oracle — but only a handful of methods are ported so far (identifier/column rendering; the rest are `NotPorted` stubs), and no dialect has its own `generators/<dialect>.js` overrides yet. `Dialect.generate()` throws until a generator is registered.
- **Most dialects have no real settings class yet.** Snowflake is the only one with a real `dialects/<name>.js` — the other three (Databricks chain, Postgres, DuckDB) still resolve through a synthetic stand-in with harvested-but-not-real settings; their `Dialect.get_or_raise(name).parse()` accuracy is measurably lower than what the test harness achieves internally until their settings classes land.
- **No package.** No `package.json`, no `index.js`, nothing published or importable from outside this repo — the snippet above works from a repo checkout, not from `npm install`.

**Zero runtime dependencies** — enforced by CI. Node ≥ 20 and modern browsers, ESM. (Build-time verification tooling depends on a pinned Python `sqlglot` install; the runtime library will not.)

**Docs:** [`docs/`](docs/) describes the public API this project is building toward — written ahead of the implementation, the way you'd write a test before the code it tests. Treat those docs as a spec to build against, not a description of current capability; each one says plainly which parts already work.
