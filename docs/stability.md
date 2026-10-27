# Stability contract

This page states what sqlglot-js promises a consumer today, pre-1.0. It is the single
place that answers "is this safe to depend on" — read it before building on anything in
this repo that isn't already named in [README](../README.md) or [docs/api.md](api.md).

## Pin and what "parity" means

This port is a line-by-line transliteration of
[sqlglot](https://github.com/tobymao/sqlglot) pinned at upstream commit
`91119bcaac977ede6f4a641bdda593b0015ef998` (see [UPSTREAM.txt](../UPSTREAM.txt)). "Parity"
means: given the same SQL, the same `read`/`write` dialect names, and the same options, this
port's `parse`/`generate`/`optimize`/... produce output verified byte-identical (or
AST-structurally-identical, for parse) to pinned CPython sqlglot's own output on that input —
checked by a differential oracle that runs both and diffs, not by eyeballing. It does **not**
mean "behaves like whatever the current upstream `main` does" — upstream has moved on since
the pin, and this port tracks the pin, not upstream HEAD, until a deliberate re-pin. See
`PORT_PLAN.md` for the full, measured history of every round (`R1`–present), and
[CHANGELOG.md](../CHANGELOG.md) for a one-line-per-round summary.

## What's public (semver-governed) vs internal

**Public — stable, covered by [index.d.ts](../index.d.ts), changes here follow semver once
this package is versioned past `0.0.x`:**

- Everything re-exported from the package root, `import { ... } from "sqlglot-js"` — see the
  table in [README](../README.md#the-exported-surface-at-a-glance) and the full reference in
  [docs/api.md](api.md). Enumerated mechanically: `node -e
  "import('sqlglot-js').then(m=>console.log(Object.keys(m).sort().join(' ')))"` prints 24
  names today (`Dialect`, `ErrorLevel`, `Insert`, `Keep`, `MappingSchema`, `Move`, `Node`,
  `ParseError`, `RULES`, `Remove`, `Schema`, `TokenError`, `UnsupportedError`, `Update`,
  `anonymize`, `diff`, `exp`, `lineage`, `optimize`, `parse`, `parseOne`, `render`, `tokenize`,
  `transpile`).
- `sqlglot-js/contrib/gatewaySqlMetadata` (and the explicit `.js` form) — `extractSqlMetadata`,
  with its own documentation (`contrib/README.md`) and a real, named consumer
  (`airbrx-gateway`'s `lib/utils/SqlParser.js`, via `require()` — see
  [docs/consuming-from-cjs.md](consuming-from-cjs.md) for why a CJS `require()` of an ESM
  package works there).
- `sqlglot-js/contrib/sessionState` (and the explicit `.js` form) — `classify`/`createState`/
  `apply`/`effectiveSearchPath`/`render`, added this round (AIR-2361). Design documented in
  [docs/proposals/session-state-module.md](proposals/session-state-module.md); no named
  consumer yet (gateway adoption is epics 14.2–14.4, separate PRs) — added here, not held back
  until adoption, on the same basis `gatewaySqlMetadata.js` was: real enough to build
  application code against, covered by its own hand-written `.d.ts` and `test/types/smoke.ts`
  entries, exactly like every other Tier-1 public export.
- `addLogSink`/`removeLogSink` (R125, additive) — route the parser's "unsupported syntax,
  falling back to Command" warnings (and any other `sqlglot` logger line) to an embedder-owned
  sink instead of `console.error`.


**Public, Tier 2 — reachable by design, not individually hand-typed, lower stability
guarantee than the root export:**

- `sqlglot-js/dialects/<name>` / `<name>.js` (e.g. `sqlglot-js/dialects/snowflake.js`) — one
  dialect's module, importable directly rather than through the package root. Importing it
  triggers the same `registerDialect(...)` side effect `index.js`'s eager import list triggers
  for all 33 dialects, so `import "sqlglot-js/dialects/snowflake.js"` then
  `Dialect.get_or_raise("snowflake")` works without loading the other 32 — the lazy-load
  escape hatch for a consumer who only needs one dialect. Mirrors upstream's own
  `sqlglot.dialects.snowflake` module layout. Not covered by `index.d.ts`: a dialect module's
  exported class (e.g. `Snowflake`) has no hand-written declaration file of its own today: TS
  will see it as `any` once imported this way, since there is no first party `.d.ts`
  describing per-dialect classes (the `Dialect` base type covers what `Dialect.get_or_raise`
  returns, which is the normal path). The dialect file set itself (which 33 names exist) is
  stable; a given dialect file's internal class shape is not promised stable at the
  method/field level the way the root export's signatures are.
- `sqlglot-js/expressions/index` / `index.js` — the same module `exp` at the package root is
  built from (`src/expressions/index.js`), importable on its own to get the full expression
  class set and builders without the side effect of loading all 33 dialect parser/generator
  files that importing the package root triggers. Narrowed to exactly this one file in this
  round (see "What changed this round" below) — the file's own internal split
  (`core.js`/`classes.js`/`builders.js`/`focused_methods.js`/`query_methods.js`) is purely an
  organizational detail of how `src/expressions/` is laid out and was never meant to be
  imported independently.

**Internal — no stability promise at all, may change or move without notice:**

- Everything under `src/*` not reachable through one of the paths above (there is no
  `./src/*` entry in `package.json`'s `exports` map at all — `sqlglot-js/src/schema.js`
  throws `ERR_PACKAGE_PATH_NOT_EXPORTED`, verified directly, same for every other `src/`
  path). A caller inside a repo checkout can still reach it with a **relative** import
  (`./src/schema.js`), which bypasses `exports` entirely — that's a checkout-only escape
  hatch, not a package-name contract.
- `_py/*` (Python-standard-library shims — `num.js`, `str.js`, `sort.js`, `datetime.js`,
  `difflib.js`, `errors.js`, `collections.js` — see `CONTRACTS.md` §1), `spike/*` (differential
  oracle harnesses), `tools/*` (lints, closure/mismatch instruments, the changelog
  generator), `corpus/*` (harvested test fixtures), `test/*` (the native test suite itself).
  None of these are importable by package name at all; they exist for this repo's own
  verification machinery.
- `contrib/restoreMetadata.js` and `contrib/sqlIdentity.js` — internal helpers
  `contrib/gatewaySqlMetadata.js` imports by relative path. Narrowed out of the `./contrib/*`
  export glob in this round (see below) because nothing — not `airbrx-gateway`, not this
  repo's own tests, not any other consumer checked — ever imported them independently; they
  were reachable only as an accident of the glob pattern `gatewaySqlMetadata.js` was added
  under.

## The one accepted divergence: `CURRENT_ROLE`

`postgres` (and the base dialect) parse a bare `SELECT CURRENT_ROLE` to a typed
`exp.CurrentRole` node and render it back as `CURRENT_ROLE()`. Pinned upstream CPython
sqlglot parses the same input to an untyped `exp.Column` — it has no `CURRENT_ROLE` keyword
entry at all. This is **not** a bug this port is tracking down; it is a deliberate,
permanent divergence from the pin, added so `contrib/gatewaySqlMetadata.js`'s
non-determinism classifier can detect `CURRENT_ROLE` the same way it already detects
`CURRENT_USER`/`CURRENT_DATE`/etc. (airbrx-gateway PR #228, AIR-2066). **Decided by Ben,
2026-10-16** (Linear AIR-1864): "the `CURRENT_ROLE` divergence is correct — keep it.
upstream's untyped-`Column` behaviour is the inconsistency." It is the single remaining row
on every whole-corpus/honest-oracle axis this project measures (see below) and should be
read as the documented baseline, never reported as a defect or a gap to close.

## How dialect/corpus numbers may move between versions

The README's "Status, measured" table and docs/api.md's "Known gaps" section are **measured
snapshots of this tree at a given commit**, not a frozen promise. Between versions:

- A dialect's own `TRANSFORMS`/method coverage can grow (more SQL constructs render
  correctly) without any public API shape changing — this is the normal, expected direction
  of travel, not a breaking change.
- The whole-corpus PASS/MISMATCH/STUB/ERROR counts in the README move as the differential
  oracles' own corpus (harvested from upstream's test suite at the pin) is re-run against a
  newer tree; they do not move because the pin itself changes (the pin only moves on a
  deliberate re-pin round, named as such in `PORT_PLAN.md`).
- A name that throws `Unknown dialect` or `"... is not ported yet"` today (`NotPorted`) may
  start working in a later version — that is a strict widening, never a narrowing a consumer
  needs to defend against. The reverse (something that worked starts throwing) would be a
  real regression; the two independent ratchets described in the README's "How verification
  works" section exist specifically to make that impossible to land silently.

## No-promise areas before 1.0

- **Not published to any registry.** `package.json` is `"private": true`; there is no npm
  package, no version range a consumer can pin against other than a specific git commit SHA
  (see the root README's install instructions). `AIR-2296` (open, Ben's decision) covers
  whether/when that changes.
- **No semver yet.** The package version (`0.0.1`) does not currently encode a compatibility
  promise between any two commits — a consumer on a git dependency should pin by commit SHA,
  not by version string, until a real release policy exists.
- **The optimizer fixture-pair rollup.** 76% of the 3,589 upstream optimizer fixture pairs
  have no replaying differential oracle in this repo today (measured,
  `tools/fixture_rollup.mjs`, `docs/verification/optimizer-fixture-rollup.md`) — every
  individual optimizer rule has its own independent oracle, but that specific upstream
  fixture corpus, file-for-file, isn't replayed end-to-end. Not a silent gap (named, measured,
  tracked under Linear AIR-1864), but also not yet closed.
- **TypeScript declarations are new, hand-written, and not yet battle-tested against a real
  external consumer's `tsc` run.** `index.d.ts` covers every public export's documented shape
  (see `test/types/smoke.ts` for the exact set checked) but was authored by reading the
  implementation and `docs/api.md`, not generated from JSDoc or verified by a second,
  independent consumer project yet.
- **Everything already named in [docs/api.md#known-gaps](api.md#known-gaps)** — a specific,
  measured, currently-open population of generate mismatches/stubs within the 33 ported
  dialects, re-measured every docs round.

## What changed this round (AIR-2314)

Exports audit findings, applied to `package.json`'s `exports` map (no `src/` behaviour
changed):

- `./contrib/*` narrowed to exactly `./contrib/gatewaySqlMetadata` (+ `.js`) — dropped
  `contrib/restoreMetadata.js` and `contrib/sqlIdentity.js` from being independently
  importable by package name; verified nothing imports them that way today (this repo, every
  `airbrx-gateway` checkout found on this host).
- `./expressions/*` narrowed to exactly `./expressions/index` (+ `.js`) — dropped the five
  other `src/expressions/*.js` files (`builders.js`, `classes.js`, `core.js`,
  `focused_methods.js`, `query_methods.js`) from being independently importable; `index.js`
  already re-exports everything they have, so there was no reachable capability behind those
  paths that isn't reachable through `index.js` already.
- `./dialects/*` kept unchanged — a real, useful lazy-load path (see Tier 2 above), used by
  nothing today but deliberately shaped, not an accident of a glob.
- `./package.json` and the package root (`.`) kept unchanged.
- Added `"types": "./index.d.ts"` and a hand-written `index.d.ts` (+
  `contrib/gatewaySqlMetadata.d.ts`) — see `test/types/smoke.ts` and `npm run check:types`.

## What changed this round (AIR-2361, R122)

A new public contrib module, no `src/` behaviour changed:

- `./contrib/sessionState` (+ `.js`) added to `package.json`'s `exports` map, with its own
  `contrib/sessionState.d.ts` and `test/types/smoke.ts` entries. `./contrib/*` stays narrowed to
  exactly these two named modules (`gatewaySqlMetadata`, `sessionState`) — still not a glob; a
  third contrib file would need the identical deliberate addition, not an accidental one.
