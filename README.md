# sqlglot-js

A zero-dependency JavaScript port of [sqlglot](https://github.com/tobymao/sqlglot) — a
no-dependency SQL parser, transpiler, and AST toolkit.

This is a derivative work of sqlglot (MIT License, Copyright (c) 2026 Toby Mao). See
[NOTICE](NOTICE) and [LICENSE-sqlglot](LICENSE-sqlglot) for attribution, and
[UPSTREAM.txt](UPSTREAM.txt) for the current upstream pin
(`91119bcaac977ede6f4a641bdda593b0015ef998`).

**What this is, concretely.** Every file under `src/` is a line-by-line transliteration of
the matching upstream Python file — same layout, same class/method names and order, same
control flow — with a `// py: sqlglot/<file>.py:<line>` anchor on every ported method. The
goal is that a future upstream diff can be read directly against the JS file. The test corpus
(`corpus/`) is harvested verbatim from upstream's own `tests/dialects/*.py` suite, so the port
is checked against the tests sqlglot already trusts, not a hand-written approximation of
them. `PORT_PLAN.md` is the full plan, phase history, and every measured number this README
summarizes; `CONTRACTS.md` records every place a literal transliteration was impossible and
why.

**Status:** every one of upstream's 33 dialect modules at the pin now exists in the port
(`src/dialects/*.js`), each with its own `Tokenizer`/`Parser`/`Generator` and differentially
tested settings. Not published to any registry yet — consume it as a git dependency.

## Install

```sh
npm install github:airbrx/sqlglot-js#main
```

Or, from a checkout of this repo, import `./index.js` directly. This package is ESM-only
(`"type": "module"`); see [docs/consuming-from-cjs.md](docs/consuming-from-cjs.md) for using it
from a CommonJS project via dynamic `import()`.

## Quick start

```js
import { parseOne, transpile, optimize, MappingSchema, exp } from "sqlglot-js";

// Parse
const ast = parseOne("SELECT id, name FROM users WHERE active = TRUE", { read: "snowflake" });
ast.constructor.name; // "Select"

// Transpile across dialects
const [sql] = transpile("SELECT `id` FROM t WHERE active = TRUE", {
  read: "databricks",
  write: "postgres",
});
sql; // 'SELECT "id" FROM t WHERE active = TRUE'

// Optimize (qualifies columns, expands `*`, folds constants — against a schema)
const schema = new MappingSchema({ users: { id: "INT", email: "VARCHAR" } });
optimize("SELECT * FROM users WHERE 1 = 1 AND id = 1", { schema }).sql();
// 'SELECT "users"."id" AS "id", "users"."email" AS "email" FROM "users" AS "users" WHERE "users"."id" = 1'

// Build a tree directly, without SQL text
exp.select("id", "name").from_("users").where(exp.column("active").eq(true)).sql();
// "SELECT id, name FROM users WHERE active = TRUE"
```

All four outputs above are copy-pasted from a real run of this tree (`node -e '...'` at the
repo root). See [docs/getting-started.md](docs/getting-started.md) for a walkthrough and
[docs/api.md](docs/api.md) for the full reference.

## Dialects (33 of 33 upstream modules)

| Family | Dialects |
|---|---|
| Databricks chain | `hive`, `spark2`, `spark`, `databricks` |
| Snowflake | `snowflake` |
| DuckDB | `duckdb` |
| Postgres family | `postgres`, `redshift` |
| BigQuery | `bigquery` |
| TSQL | `tsql` |
| MySQL family | `mysql`, `singlestore`, `starrocks`, `doris` |
| Presto family | `presto`, `trino`, `athena`, `dune` |
| ClickHouse | `clickhouse` |
| Exasol | `exasol` |
| Oracle | `oracle` |
| SQLite / Teradata | `sqlite`, `teradata` |
| Small / standalone | `materialize`, `risingwave`, `fabric`, `solr`, `druid`, `dax`, `tableau`, `drill`, `prql`, `dremio` |

A family's later members subclass an earlier one the same way upstream does (e.g. `Spark`
subclasses `Hive`, `SingleStore`/`StarRocks`/`Doris` subclass `MySQL`) — see `PORT_PLAN.md`'s
Epic 12 entries (R101–R114) for the landing order and per-dialect notes. Two dialects have no
bare `SELECT` grammar at all, faithfully (upstream raises the same error): `dax` only parses
`EVALUATE ...`, and `prql` is a pipeline language (`from x | ...`), not SQL.

## The exported surface, at a glance

Everything below is importable from the package root (`import { ... } from "sqlglot-js"`).
Full detail, including JS-specific shape notes, is in [docs/api.md](docs/api.md).

| Group | Exports |
|---|---|
| Parsing / transpiling | `parse`, `parseOne`, `transpile`, `tokenize`, `Dialect` |
| Expression tree | `exp` (the namespace — 1,048 classes plus builders like `select`, `column`, `cast`) |
| Errors | `ParseError`, `TokenError`, `UnsupportedError`, `ErrorLevel` |
| Schema | `Schema`, `MappingSchema` |
| Optimizer | `optimize`, `RULES` |
| Lineage | `lineage`, `Node` |
| Anonymize | `anonymize`, `render` |
| Diff | `diff`, `Insert`, `Remove`, `Move`, `Update`, `Keep` |

## Status, measured

Every number below comes from a command run on this tree at `8ee312d` (R114) — see
`PORT_PLAN.md`'s R100–R114 entries for how each was produced, and
[docs/api.md](docs/api.md#known-gaps) for the honest list of what's still open. A concurrent
round (AIR-2311) is actively closing some of the generate mismatches below, so treat these as
"as of R114," not a permanent ceiling.

| Check | Command | Result |
|---|---|---|
| Whole-corpus parse | `node spike/p3/fuzz_ast_coverage.mjs` | 15,516 PASS / 16 MISMATCH / 2 STUB / 6 ERROR of 15,540 |
| Whole-corpus generate | `node spike/p5/fuzz_dialect_generate.mjs` | 15,463 PASS / 48 MISMATCH / 29 STUB / 0 ERROR of 15,540 |
| End-to-end ratchet | `node test/runner.mjs` | 15,450 pass-listed |
| Honest generate oracle | `node spike/p4/fuzz_generate_oracle.mjs` | 0 MISMATCH / 0 STUB / 0 ERROR (green) |
| Honest AST oracle | `node spike/p3/fuzz_ast_coverage.mjs --strict` | 16 MISMATCH / 6 ERROR (the one standing red, see below) |
| Dialect-defaults settings | `node spike/p5/fuzz_dialect_defaults.mjs` | 428/428, with 2 named GAP notes (see api.md) |
| Native test suite | `npm test` | 768/768 |
| Lints (6) | `node tools/lint_*.mjs` | all clean |

**The one standing red diagnostic** is `spike/run_all.sh`'s "P3: AST oracle coverage (honest)"
— `spike/p4`'s equivalent generate probe has been green since R100. This is a strict,
full-population diagnostic (every one of the 15,540 corpus rows, no exclusions); the
production ratchets above (what a real `read`/`write` call actually does today) are the
release-relevant numbers, and both hold zero regressions on every merge.

## Known gaps

Specific, current, and linked from [docs/api.md#known-gaps](docs/api.md#known-gaps):

- 29 generate STUB atoms: BigQuery's `IGNORE_NULLS_BEFORE_ORDER` window-function branch.
- 2 parse STUB atoms: Exasol's ODBC datetime literal (`{d'2024-01-01'}`).
- 48 generate MISMATCH atoms across 19 clusters (e.g. Spark→Presto `EXPLODE`/`POSEXPLODE`
  rewriting, BigQuery `HAVING MIN`/`MAX` direction) — AIR-2311 is actively closing these.
- 16 parse MISMATCH / 6 ERROR atoms (mostly TSQL grammar not yet ported: table-valued
  function aliasing, `OPENJSON ... WITH (...)`, XML `.value()` method syntax).
- 76% of the 3,589 optimizer fixture pairs have no replaying differential oracle in this repo
  (measured by `tools/fixture_rollup.mjs`, R95/AIR-1864) — the optimizer's rule-level logic is
  independently tested, but that specific fixture corpus isn't replayed end-to-end.
- Not published to any registry — `package.json` is `"private": true`; consume via a git
  dependency or `./index.js` from a repo checkout.

## How verification works

Two independent ratchets protect every merge: a **row ratchet** (per-atom parse/generate
pass IDs, `test/differential-{parse,generate}-baseline.json`) and an **end-to-end ratchet**
(`test/ratchet.json`, driven by `test/runner.mjs`) — a PR cannot delete an accepted pass ID or
change an accepted expectation from either (`tools/check_ratchet_change.mjs`,
`tools/check_differential_change.mjs`). On top of the corpus ratchets, a set of **honest
oracles** (`spike/p3`–`spike/p10`) test the real production entry points against the full,
unfiltered corpus with no exclusions — these are allowed to be red (and one still is, see
above) precisely because they can't be gamed by narrowing scope. See
[docs/verification/](docs/verification/) for the detailed gate history and
[PORT_PLAN.md §3](PORT_PLAN.md) for the verification architecture.

## `contrib/`

Airbrx-specific application code built on top of the port, not part of it (no `py:` anchors,
not tracked by `PORT_PLAN.md`'s closure numbers). See [contrib/README.md](contrib/README.md)
— currently `gatewaySqlMetadata.js`, a `Dialect.get_or_raise(...).parse(sql)`-based cache-key
metadata extractor for `airbrx-gateway`'s regex-based `SqlParser.js`. See
[docs/proposals/gateway-tier2-normalization.md](docs/proposals/gateway-tier2-normalization.md)
for the (undecided, awaiting Ben) tier-2 semantic-normalization proposal built on top of it.

## Zero runtime dependencies

Enforced by CI lint (`tools/lint_license.mjs` and the empty `dependencies`/`devDependencies`
in `package.json`). Node ≥ 20 and modern browsers, ESM only. Build-time verification tooling
(the differential oracles) depends on a pinned Python `sqlglot` install; the runtime library
itself does not.

## License

MIT, same as upstream sqlglot. See [LICENSE](LICENSE), [LICENSE-sqlglot](LICENSE-sqlglot), and
[NOTICE](NOTICE) for full attribution.
