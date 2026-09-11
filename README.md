# sqlglot-js

A zero-dependency JavaScript port of [sqlglot](https://github.com/tobymao/sqlglot) — a no-dependency SQL parser, transpiler, and AST toolkit.

This is a derivative work of sqlglot (MIT License, Copyright (c) 2026 Toby Mao). See [NOTICE](NOTICE) and [LICENSE-sqlglot](LICENSE-sqlglot) for attribution, and [UPSTREAM.txt](UPSTREAM.txt) for the current upstream pin.

**Status:** in progress. There is now a real top-level package entry point (`index.js`, `package.json`) with `parse`/`parseOne`/`transpile`/`tokenize`, the `exp` namespace, `Dialect`, and the error classes — see [docs/getting-started.md](docs/getting-started.md) and [docs/api.md](docs/api.md). Not published to any registry yet; consume it as a git dependency (`github:airbrx/sqlglot-js#main`) until it is. Everything below is differentially tested against a pinned CPython `sqlglot` install. See [PORT_PLAN.md](PORT_PLAN.md) for the full implementation plan, phase breakdown, and every measured number this README summarizes. Tracked in Linear: [sqlglot-js Port](https://linear.app/airbrx/project/sqlglot-js-port-fde0e002e19d).

**What works today, measured against the real corpus** (15,478 AST-oracle rows harvested from upstream's own dialect test suite) through the REAL production entry point — `Dialect.get_or_raise(name)` resolving a real `Dialect` subclass with its own `Tokenizer`, `Parser`, and (for these four) `Generator`, not a test-harness shortcut. All four originally-prioritized dialects (Ben's priority order: Databricks > Snowflake > DuckDB > Postgres) now round-trip parse → AST → generate end to end:

| dialect | parse (real path) | generate (real path) |
|---|---|---|
| Databricks chain — Hive | 489 / 491 reached (99.6%) | 248 / 248 reached (**100%**) |
| Databricks chain — Spark2 | 41 / 41 reached (**100%**) | 38 / 38 reached (**100%**) |
| Databricks chain — Spark | 667 / 671 reached (99.4%) | 332 / 332 reached (**100%**) |
| Databricks chain — Databricks | 319 / 321 reached (99.4%) | 156 / 156 reached (**100%**) |
| Snowflake | 2,397 / 2,427 reached (98.8%) | 1,036 / 1,066 reached (97.2%) |
| DuckDB | 999 / 1,017 reached (98.2%) | 220 / 349 reached (63.0% — deliberately scoped subset, see PORT_PLAN.md R32) |
| Postgres | 919 / 930 reached (98.8%) | 233 / 234 reached (99.6%) |

— **10,879 of 15,478 rows exact across all 46 dialects** overall on the parse side (base-grammar coverage benefits every dialect, not just the seven above). Every number is machine-checked against a pinned CPython `sqlglot` install via `node spike/p3/fuzz_ast_coverage.mjs`, `spike/p5/fuzz_dialect_parse.mjs`, and `spike/p5/fuzz_dialect_generate.mjs` — not asserted by hand; `PORT_PLAN.md`'s 34 R-series findings are the record of what that checking has caught so far.

```js
import { parseOne, transpile } from "sqlglot-js"; // or "./index.js" from a repo checkout

const ast = parseOne("SELECT id FROM t WHERE active = TRUE", { read: "databricks" });
ast.constructor.name; // "Select"

const [sql] = transpile("SELECT `id` FROM t WHERE active = TRUE", {
  read: "databricks",
  write: "postgres",
});
sql; // 'SELECT "id" FROM t WHERE active = TRUE' — full round-trip, cross-dialect, today

// The exp builder API works too, through the default dialect:
import * as exp from "sqlglot-js";
exp.select("id", "name").from_("users").where(exp.column("active").eq(true)).sql();
// "SELECT id, name FROM users WHERE active = TRUE"
```

**What doesn't exist yet:**
- **Most dialects have no real `Dialect` class at all.** The base `Generator` (`src/generator.js`) and all four originally-prioritized dialects' own `Parser`/`Dialect`/`Generator` are real, but the other ~42 of the 46 harvested dialects aren't registered — `Dialect.get_or_raise("bigquery")` throws `Unknown dialect` before you'd even get to calling `.parse()` or `.generate()` on it.
- **DuckDB's generator is intentionally partial.** 70 of 147 `TRANSFORMS` entries and 33 settings are ported (the marginal-value subset a closure-tool analysis identified, not upstream line order) — the rest is a named follow-on, not a silent gap; see PORT_PLAN.md R32 for exactly what's in vs. out.
- **Not published to any registry.** `package.json` and `index.js` are real (`"name": "sqlglot-js"`, `"type": "module"`), but there's no npm publish yet — consume it as a git dependency (`github:airbrx/sqlglot-js#main`) from another project, or import `./index.js` directly from a repo checkout.
- **`Schema`/`MappingSchema` and `diff`** — no target doc, no code (see docs/api.md's "Not yet designed" section).

**Zero runtime dependencies** — enforced by CI. Node ≥ 20 and modern browsers, ESM. (Build-time verification tooling depends on a pinned Python `sqlglot` install; the runtime library will not.)

**Consuming from a CommonJS project:** see [docs/consuming-from-cjs.md](docs/consuming-from-cjs.md) — this package is ESM-only (`"type": "module"`), so a CJS consumer needs dynamic `import()`.

**Docs:** [`docs/`](docs/) describes the public API — see [getting-started.md](docs/getting-started.md) and [api.md](docs/api.md) for what's real today and what's still target design (mainly: dialect coverage beyond the seven listed above, and `Schema`/`diff`).
