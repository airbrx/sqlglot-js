# `contrib/sessionState.js` — generalizing session-state tracking across dialects

AIR-2361 (epic AIR-2360). No upstream Python equivalent — this is airbrx-specific
business logic built on the real sqlglot-js port, same status as
`contrib/gatewaySqlMetadata.js` (no `py:` anchors, not subject to PORT_PLAN.md's
transliteration contract). No `src/` parser/generator/tokenizer behaviour changes:
upstream parity is a hard rule for this project, so this module handles — in its
own fallback layer — everything upstream leaves as an opaque `Command` or
misparses, exactly as measured by AIR-2360's 52-statement probe.

## Why

Three gateway adapters each reinvented session-state tracking:

| adapter | recognition | state | replay |
| -- | -- | -- | -- |
| Postgres | 256 LOC of regex over a hand-rolled quote/comment scanner (`SearchPathTracker.classify`) | `searchPath` raw-text label + `roleSwitched`/`authSwitched` flags, pending/commit around transactions | none |
| Databricks | sqlglot-js `contrib/gatewaySqlMetadata`'s `sessionStateChange` (3 ad-hoc extractors + a regex over `Command` text) | `{catalog, schema, variables}` + replay log | hand-rendered `SET`/`USE`/`ALTER SESSION` |
| Snowflake | none — reads role/warehouse/database/schema back from backend responses | 4 names | n/a |

This module replaces all three recognizers with one AST-driven classifier, backed
by data tables per dialect family, plus a reducer and a renderer. It does **not**
replace `contrib/gatewaySqlMetadata.js` (see "Relationship to `gatewaySqlMetadata.js`"
below) and it does not touch the gateway itself — gateway adoption is epics
14.2–14.4, separate PRs, each needing Ben's merge.

## Effect schema

`classify(sql, { dialect }) → Effect[]`, one `Effect` per statement in the input
(semicolon-separated batch), in source order:

```ts
interface Effect {
  dialect: string | null;        // the dialect name passed in (or null for the base dialect)
  statementText: string;         // raw text of just this statement, trimmed — lets a caller
                                  // preserve the Postgres cache-key LABEL convention (raw text,
                                  // quotes intact) without re-deriving it from the whole batch
  scope: "session" | "local" | "global" | "transaction";
  kind: "set" | "reset" | "use" | "role" | "auth" | "discard"
      | "transaction" | "variable" | "read" | "unknown" | "none";
  key: string | null;             // canonical name (see below), or the raw variable name,
                                   // or null when not applicable (kind: "none"/"read"-list-all/"transaction")
  valueRaw: string | null;        // as written in the source (quotes intact), or null
  value: string | null;           // parsed/unquoted value, or null
  parts: { catalog: string, schema: string } | null;  // structured USE-namespace parts for a
                                   // two-part USE (AIR-2373.3); apply() prefers these over
                                   // splitting value/valueRaw on "." — see "USE namespace parts" below
  affectsResolution: boolean;     // could change how an unqualified name resolves
                                   // (search_path, role, session_authorization, catalog, schema)
  affectsResults: boolean;        // could change query results even when resolution is untouched
                                   // (timezone, session variables, NOCOUNT, warehouse, ...)
  replayable: boolean;            // this module knows enough to re-emit an equivalent statement
                                   // via render() (false for anything kind: "unknown")
  unknownReason: string | null;   // set only when kind: "unknown"
}
```

`kind: "none"` is this module's one addition beyond the four-tuple AIR-2361 names
explicitly: a statement that is not a session-state statement at all (`SELECT 1`
inside a batch that also contains a `SET`) still needs *an* Effect so a caller can
walk `Effect[]` index-for-index against the batch's own statements — "none" is
that neutral marker. Every other kind matches the issue text exactly.

### Why canonical keys, and what they are

`search_path`, `schema`, `catalog`, `role`, `session_authorization`, `warehouse`,
`timezone` are the fixed vocabulary (plus the raw variable name for anything
dialect-specific, e.g. `spark.sql.session.timeZone` or `QUERY_TAG`). Two
dialect-specific identities fold into one canonical name on purpose:

- **`catalog`** is "whatever this dialect calls its top-level container above
  schema": Databricks' Unity Catalog `CATALOG`, and Snowflake's `DATABASE` (which
  has no separate catalog concept — a Snowflake "database" sits directly above
  "schema", the same slot a Databricks catalog occupies). Databricks' OWN
  `DATABASE` keyword is a legacy synonym for `SCHEMA` in that dialect, not for
  `CATALOG` — this port's `src/parser.js` surfaces that structurally as
  `Use.args.kind === "DATABASE"`, and `contrib/gatewaySqlMetadata.js`'s
  `extractUseChange` already treats Databricks `DATABASE` as `schema`, confirmed
  by its own test (`USE DATABASE sales` → `{kind: 'use_schema', schema: 'sales'}`).
  This module's Databricks table makes the identical choice for the identical
  reason; its Snowflake table maps `DATABASE` to `catalog` instead, because on
  Snowflake that keyword really does name the top-level container.
- **`schema`** also covers Postgres' `SET SCHEMA 'x'`, a documented alias for
  `SET search_path TO 'x'` (one schema, as a single-entry search path) — so on
  Postgres the canonical key for both forms is `search_path`, matching
  `SearchPathTracker`'s own `'SET SCHEMA alias'`/`'SET SESSION SCHEMA alias'`
  corpus rows, which assert the identical label as the equivalent `search_path`
  form.

**`search_path`/`role`/`session_authorization` are Postgres-family GUCs, not a
universal vocabulary (AIR-2373 finding 1).** The canonicalization table lookup
in `classify()` already only runs for `familyOf(dialect) === "postgres"` (every
other family has no such table, so `key` stays the raw name as written). Before
this fix, `apply()` did not repeat that gate: it matched `effect.key ===
"search_path"` by string alone in both its `reset` and `set`/`variable`
branches, so a Databricks client sending an ordinary variable literally named
`search_path` (`SET search_path = x` — a real, if unusual, Spark config key,
no relation to Postgres' GUC) got silently diverted into `state.searchPath` —
a Postgres-only field Databricks' own code never reads — instead of
`state.variables`. The gateway's own Databricks adoption found this directly:
`Session.applySessionStateChange` reported `true` (mutated) while persisting
nothing a replay could use. `apply()` now re-checks `familyOf(state.dialect)
=== "postgres"` itself before treating any of these three keys as special, so
the same key on a non-Postgres dialect falls straight through to the generic
`variables`/`replayLog` path like any other `SET`.

### `scope`

`session` (ordinary `SET`), `local` (`SET LOCAL ...` — lasts only to the end of
the current transaction), `global` (MySQL `SET GLOBAL ...`), `transaction`
(`BEGIN`/`COMMIT`/`ROLLBACK`, and `SET [SESSION|LOCAL] TRANSACTION ...`). A
`scope: "local"` effect is marked `affectsResolution`/`affectsResults` exactly as
its non-local counterpart would be (the fact doesn't change), but `apply()` never
mutates persisted state for it — see "Reducer" below — matching the Postgres
tracker's own call: "a transaction is never cached from, so [`SET LOCAL`] is
ignored."

### `parts` (USE namespace, AIR-2373 finding 3)

A two-part `USE a.b` sets `key: "namespace"` with `value`/`valueRaw` joined as
`"a.b"` (unchanged, for any caller that only looks at those) AND `parts:
{catalog: "a", schema: "b"}` — the already-split pair `classifyUse` read
straight off the real `Table` node's own `this`/`db` args, quoting intact per
part. `apply()` prefers `parts` whenever it's present, falling back to
splitting `value` on `"."` only when it's `null` (every Effect this module
itself never built with `parts` — i.e. every pre-AIR-2373 caller, such as
airbrx-gateway's own `Session.js`'s `translateChangeToEffect`, which builds a
`use_namespace` Effect by hand and has never set this field). Splitting on
`"."` silently mis-splits a part that itself contains a literal dot — e.g.
`` USE `a.b`.c `` (`a.b` is one quoted catalog name) used to become
`catalog: "a", schema: "b.c"` wrong instead of `catalog: "a.b", schema: "c"`
right. A hand-built Effect has no real source text to split *correctly*
either way, so that fallback's pre-existing imprecision for a dotted part is
unchanged — only the real, parser-driven path through `classify()` gets the
fix.

## State schema

`createState(dialect) → State`, one shape reused by every dialect (fields a given
dialect never touches just stay at their initial value):

```ts
interface State {
  dialect: string | null;
  searchPath: string | null;      // Postgres cache-key LABEL ('default' | 'path:<raw text>' | null)
  roleSwitched: boolean;          // Postgres: SET ROLE moved away from the session user
  authSwitched: boolean;          // Postgres: SET SESSION AUTHORIZATION moved the session user
  role: string | null;            // Snowflake: USE ROLE / Postgres: last non-reset SET ROLE value
  catalog: string | null;         // Databricks catalog / Snowflake database
  schema: string | null;          // Databricks/Snowflake schema
  warehouse: string | null;       // Snowflake
  variables: Record<string, string | null>;  // generic SET-family key/value store
  variablesRaw: Record<string, string | null>;  // AIR-2373.2: source-quoted counterpart of
                                   // `variables`, same keys. Only ever written by apply() for a
                                   // key it is actively setting in THAT call, from the Effect's
                                   // own `valueRaw` — a key already present in `variables` through
                                   // some other path (e.g. a gateway session hydrated straight
                                   // from pre-this-round persisted storage) has no entry here at
                                   // all, which render()'s Databricks renderer (below) treats
                                   // exactly like an Effect that never had a valueRaw to begin with
  replayLog: ReplayEntry[];       // minimum sequence to recreate the above on a fresh session —
                                   // a SIBLING of the rest of State, never read back into it,
                                   // for the identical cache-key-stability reason
                                   // Session.applySessionStateChange's own comment gives
                                   // (`sessionStateReplayLog` next to, not inside, `sessionState`)
}
```

### `effectiveSearchPath(state) → string | null`

A direct generalization of `postgresql.Session.js`'s own `effectiveSearchPath()`:
`state.searchPath` itself is never masked at mutation time by a role/auth
switch (see `apply()`'s `"role"`/`"auth"` cases below, which only set
`roleSwitched`/`authSwitched`); masking is applied here, at read time —
while either flag is set, `'default'` and any label naming `$user` are
untrustworthy and this returns `null`; any other label is returned as-is
(e.g. an explicit non-`$user` `search_path` set while a role is switched stays
trusted, matching `SearchPathTracker`'s own corpus: `trusted('SET ROLE x',
'SET search_path = a, b')` is `'path:a, b'`, not `null`).

## Reducer: `apply(state, effect) → State`

Pure, immediate, no rollback modeling — deliberately matching what Databricks'
`Session.applySessionStateChange` already does today (apply once the gateway has
decided the statement actually ran), **not** Postgres' two-phase
`beginSessionStateChange`/`confirmSessionStateChange` dance. That dance is about
*when* a gateway's own `Session` object may trust a change (not yet, if the
statement is inside an open transaction that could still roll back) — a
transaction-state and failure-handling policy that belongs to the caller, per the
epic's hard rule ("Policy stays out: the module reports facts ... never decides
cacheability"). `apply()` gives the gateway everything it needs to keep running
that exact dance unchanged: `effect.scope` says whether a change is transaction-
local, and the gateway's own session already knows whether it is inside a
transaction and whether the statement succeeded. See "Gateway adoption" below for
precisely how Postgres' existing `beginSessionStateChange`/`confirmSessionStateChange`
would be rebuilt on top of this module's `Effect`s without losing that behaviour.

Rules:

- `effect.scope === "local"` → no-op; `state` is returned unchanged.
- `kind: "use"` → sets `catalog`/`schema`/`warehouse` depending on `key`
  (`"namespace"`: prefers `effect.parts.catalog`/`.schema` when present,
  falling back to splitting `value` on `"."` only when `parts` is `null` —
  AIR-2373.3), then rebuilds `replayLog` (namespace-collapse rule below).
- `kind: "role"` → sets `role` (`Postgres`: also sets `roleSwitched = true`, unless
  `value` is a reset sentinel, in which case `role = null` and
  `roleSwitched = false`).
- `kind: "auth"` (Postgres only) → sets `authSwitched`, and — matching
  `SearchPathTracker`'s verified-on-Postgres-16 comment — moving the session user
  also clears an active `SET ROLE` (`roleSwitched` stays whatever it already was;
  only a session-user RESET clears it, see below), so this also sets `role = null`
  when switching to a NEW session user (not on reset).
- `kind: "reset"` — the `"search_path"`/`"role"`/`"session_authorization"`
  special cases below only fire when `familyOf(state.dialect) === "postgres"`
  (AIR-2373.1 — they are Postgres GUCs, not a universal vocabulary); on any
  other family all three fall through to the generic raw-variable-name case.
  On Postgres: `"search_path"` → `searchPath = 'default'`; `"role"` → `role =
  null, roleSwitched = false` (NOT `authSwitched` — `RESET ROLE` only returns
  to the SESSION user, never below it); `"session_authorization"` →
  `authSwitched = false` AND `roleSwitched = false` (`RESET SESSION
  AUTHORIZATION` clears an active role too, verified on Postgres 16 per
  `SearchPathTracker`). A raw variable name (any family, including the three
  above when not Postgres) → deletes that key from `variables`/`variablesRaw`.
- `kind: "discard"` (Postgres `DISCARD ALL`) → resets `searchPath`, `roleSwitched`,
  `authSwitched`, `role` all at once (does **not** touch Databricks/Snowflake
  fields — Postgres-only kind).
- `kind: "set"` / `kind: "variable"` → same Postgres-only gate as `reset`
  above for `"search_path"`; otherwise `variables[key] = value`,
  `variablesRaw[key] = effect.valueRaw ?? null` (AIR-2373.2 — feeds a
  Databricks-family `render()`, see below), rebuild `replayLog`.
- `kind: "transaction"` → no state mutation (the gateway's own
  `transactionStatus` tracks this; see "Gateway adoption").
- `kind: "read"` / `"none"` / `"unknown"` → no-op.

`replayLog` rebuild (generalizes `Session._rebuildSessionStateReplayLog`, which
this reproduces byte-for-byte for the Databricks shape — collapse order verified
against `session-state-replay.test.js`'s `testNamespaceCollapseRebuild`): if both
`catalog` and `schema` are set, emit one `use_namespace` entry; otherwise emit
`use_catalog`/`use_schema` individually for whichever is set. Then one `set`
entry per key in `variables`, insertion order, with `valueRaw` attached
whenever `variablesRaw` has one for that key (AIR-2373.2) — never a bare
`null` manufactured for a key `apply()` never recorded raw text for.
Last-write-wins per key (a second `SET timezone = ...` replaces, not appends,
matching `testDedupeReplayLog`).

## `render(state, { dialect }) → string[]`

Builds real `exp.Use`/`exp.Set`/`exp.AlterSession` nodes from `state.replayLog`
and emits each through `Dialect.get_or_raise(dialect).generate(...)` — for
every `use_*` kind, on every dialect, and for `set` on every family EXCEPT
Databricks. Using the real generator here means quoting, identifier escaping,
and dialect SQL spelling all come from the same code path that already
produces correct SQL everywhere else in this project. A `replayLog` entry
whose kind the target dialect's table doesn't know how to render (not
expected in practice, since entries only ever come from this module's own
`apply()`) is skipped with `null` filtered out, mirroring
`renderReplayStatement`'s own "malformed → null, caller warns and skips"
contract.

### Databricks `set` rendering is raw text, not the generator (AIR-2373 finding 2)

This module originally rendered EVERY `set` entry — Databricks included —
through the real generator (a quoted string `exp.Literal`), billed above as
*replacing* `OperationCreatingHandler.renderReplayStatement`'s hand-rolled
`quoteSetValue`. That was wrong specifically for the Databricks family
(`hive`/`spark2`/`spark`/`databricks`), found by that very gateway adoption
(gateway PR #256) while trying to delete `quoteSetValue` in favor of this
module's `render()`:

Spark's own grammar has no string-literal syntax on the `SET k = v` path at
all. `SqlBaseParser.g4`'s `SET .*?` rule hands the whole remainder to
`SparkSqlParser.visitSetConfiguration`, whose `configKeyValueDef` regex
(`"""([a-zA-Z_\d\.:]+)\s*=([^;]*);*"""`) captures and stores `value.trim`
VERBATIM — any quotes present are part of the stored string, never decoded.
So `SET spark.sql.session.timeZone = UTC`, replayed through a generator that
adds quotes, becomes `SET spark.sql.session.timeZone = 'UTC'` — which sets
the session's timezone config to the five-character string `"'UTC'"`,
failing Spark's own timezone validity check and aborting session bring-up on
the resulting non-200. (A dotted key through `exp.column(key)` has the same
problem one level up: the generator backtick-quotes it as a qualified column
reference, `` `spark`.`sql`.`session`.`timeZone` ``, which is not how this
grammar rule reads a config key either.)

`render()` therefore renders a `set` entry on a Databricks-family dialect as
plain text — `SET <key, always bare, never backtick-quoted> = <raw>` — where
`raw` is `entry.valueRaw` when present, emitted **completely unprocessed** (it
is already the exact source span `apply()` copied byte-for-byte from the
original statement: bare `UTC` stays bare, `'o''brien'` stays `'o''brien'`
doubled quote and all — re-running any quoting logic over it would corrupt
already-valid text). Only when `valueRaw` is absent — the decoded-only shape
every pre-this-round caller still constructs by hand, e.g. the gateway's own
`Session.js`'s `translateChangeToEffect` — does it fall back to
`quoteDatabricksSetValue`, a verbatim reproduction of the gateway's own
pre-AIR-2365 `quoteSetValue`: bare unless the text contains whitespace, a
quote, a `;`, or is empty, in which case it's wrapped in single quotes with
any embedded quote doubled. Every other dialect's `set` rendering is
unaffected — still the real generator, still ignoring `valueRaw` entirely.

## Per-dialect tables

Each is DATA (a plain object the classifier reads), inherited down a family chain
exactly like every other dialect setting in this project (`postgres` → `redshift`/
`materialize`/`risingwave`; `hive` → `spark2` → `spark` → `databricks`; `mysql` →
`singlestore`/`starrocks`/`doris`; `presto` → `trino`/`dune`/`athena`). A dialect
with no table at all gets the **generic** behaviour: any `exp.Use`/`exp.Set`/
`exp.AlterSession`/transaction node is classified from its AST shape alone (no
key-specific canonicalization, no reset/discard semantics, no unknowable
triggers) — this is what covers `mysql`/`tsql`/`duckdb`/`bigquery`'s few
real-node rows from the AIR-2360 probe without a dedicated table.

### `postgres` (shared by `redshift`, `materialize`, `risingwave`)

| raw key (case-insensitive) | canonical `key` | `kind` | `affectsResolution` | `affectsResults` | `replayable` |
| -- | -- | -- | -- | -- | -- |
| `search_path`, `schema` (alias) | `search_path` | `set` | true | true | true |
| `role` | `role` | `role` | true | true | true |
| `session_authorization`/`session authorization` | `session_authorization` | `auth` | true | true | true |
| `timezone` | `timezone` | `set` | false | true | true |
| any other name | raw name | `set` | false | true | true |

Reset targets: `RESET search_path` / `RESET ALL` → `kind: "reset", key: "search_path"`
(`RESET ALL` does **not** reset role or session_authorization — both exempt, per
`SearchPathTracker`'s own corpus row); `RESET ROLE` / `SET ROLE NONE` / `SET ROLE
DEFAULT` → `kind: "reset", key: "role"`; `RESET SESSION AUTHORIZATION` / `SET
SESSION AUTHORIZATION DEFAULT` → `kind: "reset", key: "session_authorization"`
(clears role too, applied in the reducer); `DISCARD ALL` → `kind: "discard", key:
"all"` (resets path, role, and session user all at once).

`SET LOCAL ...` of any of the above → `scope: "local"` (ignored by `apply()`).

Unknowable triggers (→ `kind: "unknown"`, `affectsResolution: true`,
`affectsResults: true`, `replayable: false`): a `set_config(...)` call found
anywhere in the statement's AST (any qualification — `set_config`,
`pg_catalog.set_config`, a quoted `"set_config"` — found by walking for an
`exp.Anonymous`/function-call node whose resolved name, case-insensitively,
ends in `set_config`, not a regex over raw text); a bare `DO`/`CALL` as the
statement's first token (found via the real tokenizer, not a text regex — same
conclusion `SearchPathTracker`'s own masked-text check reaches, reached a
different way); and any statement this module's own parse attempt throws on
(`ParseError`/`TokenError`) — this includes the two documented upstream-faithful
throw cases from the AIR-2360 probe, `SET TRANSACTION ISOLATION LEVEL ...` and
`START TRANSACTION ISOLATION LEVEL ...`, which the issue explicitly calls
upstream PR candidates rather than something this fallback layer should paper
over with a hand-rolled parse of its own.

**Fallback readers** (Command-fallback and the one documented misparse): see
"Fallback readers" below.

### `databricks` (table shared by, i.e. inherited down, `hive` → `spark2` → `spark` → `databricks`)

| raw key | canonical `key` | `kind` | `affectsResolution` | `affectsResults` | `replayable` |
| -- | -- | -- | -- | -- | -- |
| `Use.kind === "CATALOG"` | `catalog` | `use` | true | true | true |
| `Use.kind === "SCHEMA"` or `"DATABASE"` | `schema` | `use` | true | true | true |
| `Use.kind === null`, two-part name | `catalog` + `schema` (namespace) | `use` | true | true | true |
| `Use.kind === null`, one-part name | `schema` | `use` | true | true | true |
| `AlterSession` (not reached under `dialect: 'databricks'` — Snowflake-only grammar, see below) | — | — | — | — | — |
| any `SET key = value` / `SET key value` | raw key | `set` | false | true | true |
| bare `SET` (list-all) | `null` | `read` | false | false | false |
| `SET key` (read-one) | raw key | `read` | false | false | false |
| `DECLARE VARIABLE ...` | raw name | `variable` | false | true | true |

`ALTER SESSION SET ...` is Snowflake syntax; this port's parser correctly does
**not** recognize it under `dialect: 'databricks'` (verified directly, matching
`session-state-replay.test.js`'s own `testParserExtractsAlterSession` comment) —
it falls back to a `Command` whose keyword is `ALTER`, which this module reports
as `kind: "none"` (not a session-state effect this module can safely reduce; no
real Databricks client sends this statement).

**Fallback readers**: `SET TIME ZONE 'x'` (Databricks-specific `Command`
fallback — not modeled as a real statement class, same class of gap as
`OPTIMIZE`/`VACUUM` noted in `contrib/README.md`) → `kind: "set", key:
"timezone"`; bare `RESET` (misparses to a `Column` node under this dialect,
documented below) → `kind: "reset", key: "all"`.

### `snowflake`

| source | canonical `key` | `kind` |
| -- | -- | -- |
| `USE ROLE x` | `role` | `role` |
| `USE WAREHOUSE x` | `warehouse` | `use` |
| `USE DATABASE x` | `catalog` | `use` |
| `USE SCHEMA x` | `schema` | `use` |
| `USE <db>.<schema>` (two-part) | `catalog` + `schema` | `use` |
| `ALTER SESSION SET k = v` | raw key | `set` |
| `ALTER SESSION UNSET k` | raw key | `reset` |

Snowflake has no `search_path`/`role-vs-auth` split, no `LOCAL`/`GLOBAL` scope
concept for these statements, and no documented `Command`-fallback or misparse
case from the AIR-2360 probe — every statement in its row of the probe already
produces a real node, so this table has no fallback-reader section.

### `mysql` (shared by `singlestore`, `starrocks`, `doris`) — generic-table rows only

Only the probe's own real-node row: `SET NAMES charset [COLLATE c]` → `kind:
"set", key: "names"`, `value` = the charset name, `scope: "global"` when
`SetItem.kind === "GLOBAL"`, else `"session"`; a bare `SET @v = x` (user
variable) or `SET GLOBAL k = v` → generic `kind: "set"`, raw key, `scope`
derived from `SetItem.kind`. No reset/discard/use semantics (MySQL's `SET` has
no Postgres-style `RESET`/`DISCARD` grammar in this probe, and `USE db` is a
plain schema switch with no catalog concept — handled by the **generic**
fallback, not a dedicated table row).

### `tsql` — generic-table rows only

`SET NOCOUNT ON/OFF` and friends (`SET ANSI_NULLS`, `SET XACT_ABORT`, ...) parse
through the exact same `SetItem{this: EQ(Column(NAME), Var(ON|OFF))}` shape as a
generic key/value `SET` (verified: TSQL's `SET_REQUIRES_ASSIGNMENT_DELIMITER =
false` just makes the `=`/`TO` optional, same AST either way) — reported as
generic `kind: "set"`, raw key, `affectsResolution: false, affectsResults:
true` (these are all result-shape/behavior toggles, never identity/catalog
switches). `SET TRANSACTION ISOLATION LEVEL ...` throws at parse (verified
against the AIR-2360 probe) — same "throws → `kind: 'unknown'`,
`unknownReason: 'parse-error'`" handling as Postgres' analogous throw, not a
fallback reader (an upstream grammar gap, not something to paper over here).

### `duckdb` / `bigquery` — generic-table rows only

Plain `SET key = value` / bare `SET` list-all / `USE db[.schema]` parse to real
nodes on both (no dialect-specific grammar beyond the base parser for either, so
nothing beyond the **generic** table is needed — no dedicated row).

## Fallback readers (Command-fallback and misparses)

Token-level, via `Dialect.get_or_raise(dialect).tokenize(text)` — never a regex
over `Command.args.expression`'s raw text. Each reader is only reached when the
statement's AST root is an `exp.Command` (or one of the two documented
misparses below), detected by exact node shape + raw text, never by re-scanning
the full original SQL.

- **Postgres `RESET <target>`** (tokenizes `RESET` straight to a `COMMAND`
  token, so every `RESET ...` form is a `Command` with `args.this === "RESET"`):
  tokenize `args.expression`; first token text, uppercased —
  `ALL` → `kind: "reset", key: "search_path"`; `ROLE` → `kind: "reset", key:
  "role"`; `SESSION` followed by `AUTHORIZATION` → `kind: "reset", key:
  "session_authorization"`; anything else → a plain identifier/variable name →
  `kind: "reset", key: <that name>` (a session GUC reset to its default,
  generic).
- **Postgres `SET [SESSION|LOCAL] SCHEMA 'x'` / `SET [SESSION|LOCAL]
  search_path TO a, b` (list form)**: both are real `exp.Command`s (the base
  parser's own `_parse_set` retreats to `_parse_as_command` the moment a `SET`
  statement has unconsumed trailing tokens — a comma-separated list is exactly
  that case). Tokenize `args.expression`: `SCHEMA` → `kind: "set", key:
  "search_path"`, `value` = the following string literal's decoded text;
  `search_path (TO|=) <csv>` → `kind: "set", key: "search_path"`, `value` =
  the raw joined list text (matching `SearchPathTracker`'s own
  `path:<raw text>` label convention — the *label* is the point, not a
  decoded list).
- **Postgres `DISCARD ALL` (misparse → `exp.Alias`)**: `DISCARD` is not a
  keyword in this port's tokenizer at all (confirmed: absent from
  `src/tokens.js`'s `KEYWORDS`), so it tokenizes as a plain identifier and
  `DISCARD ALL` parses as a column aliased by the next identifier — the
  documented upstream-faithful misparse. Detected by exact shape: root is
  `exp.Alias` whose `this` is an unqualified `exp.Column`/`exp.Var` named
  `discard` (case-insensitive) and whose `alias` is a plain identifier.
  Extracts the alias text; only `ALL` is a recognized session-state effect
  (`kind: "discard", key: "all"`) — any other target (`PLANS`, `SEQUENCES`,
  `TEMP`, `TEMPORARY`) is a real Postgres statement this module doesn't track
  session-state for, reported as `kind: "none"`.
- **Databricks `SET TIME ZONE 'x'`** (a documented permanent `Command`
  fallback, `contrib/README.md`'s own list): tokenize `args.expression`,
  expect `ZONE` then a string literal → `kind: "set", key: "timezone"`.
- **Databricks `SET -v`**: tokenize `args.expression`; a single `-v` fallback 
  → `kind: "read"` (lists all variables with descriptions, same family as bare 
  `SET`).
- **Databricks bare `RESET` (misparse → `exp.Column`)**: `RESET` is not a
  keyword this port's tokenizer special-cases for any dialect except Postgres
  (confirmed — `postgres.js` is the only `KEYWORDS` override containing
  `RESET`), so on Databricks it tokenizes as a plain identifier and a bare
  `RESET` statement parses as a single unqualified column reference. Detected
  by exact shape: root is `exp.Column` with no table/db/catalog qualification
  whose name, case-insensitively, is exactly `reset` (and nothing else follows
  — `statementText.trim().toUpperCase() === "RESET"`, the narrowest possible
  check, so a real column named `reset` used anywhere else — in a `SELECT
  reset FROM t`, say — is never affected, since that never reaches the
  top-level statement dispatch this module runs on at all). → `kind: "reset",
  key: "all"`.

Two throws remain **unhandled by any fallback reader**, by design: TSQL `SET
TRANSACTION ISOLATION LEVEL ...` and Postgres `START TRANSACTION ISOLATION
LEVEL ...`. Both are documented upstream-faithful grammar gaps (AIR-2360's own
probe, and the AIR-1864 upstream contribution path) — this module reports them
as `kind: "unknown", unknownReason: "parse-error"`, same as any other parse
failure, rather than hand-rolling a bypass parser for syntax the real grammar
should eventually support upstream.

## What stays in the gateway (policy)

- Cache-key construction, TTLs, fail-closed BYPASS decisions, and the
  cache-override magic-comment convention — this module only supplies facts
  (`affectsResolution`, `affectsResults`, `replayable`, `unknownReason`).
- Transaction-state tracking itself (`transactionStatus`) and the two-phase
  "don't trust a change until the statement that made it is confirmed outside
  an open transaction" dance — `apply()` is a pure, immediate reducer; a
  caller that needs Postgres' rollback-aware semantics keeps that logic in its
  own `Session` class, now driven by this module's `Effect`s instead of
  `SearchPathTracker.classify`'s regex output (see "Gateway adoption").
- `cacheOverride` magic-comment scanning, parameter extraction, non-deterministic
  function detection, table extraction — all orthogonal, all already covered by
  `contrib/gatewaySqlMetadata.js`, untouched by this module.

## Gateway adoption (illustrative, not implemented in this PR)

Each adapter's eventual call shape (epics 14.2–14.4, separate PRs):

- **Postgres**: replace `SearchPathTracker.classify(sql)` with
  `sessionState.classify(sql, { dialect: 'postgres' })`, one `Effect` per
  statement. `Session.beginSessionStateChange`/`confirmSessionStateChange` keep
  their existing shape and existing transaction-awareness, but read `effect.kind`/
  `effect.key`/`effect.scope` instead of `change.effect`/`change.role`/`change.auth`
  — e.g. `effect.kind === "discard"` takes the place of today's `effect ===
  'default', role: 'reset', auth: 'reset'` triple-check. The raw-text label
  convention (`'path:' + value`) is preserved by using `effect.valueRaw`/
  `effect.statementText` rather than re-deriving it.
- **Databricks**: replace `applySessionStateChange`'s `switch (change.kind)`
  with `sessionState.apply(state, effect)` (landed, AIR-2365). `
  OperationCreatingHandler.renderReplayStatement` delegates its three `use_*`
  forms to `sessionState.render(state, { dialect: 'databricks' })` but
  deliberately keeps its own local `quoteSetValue` for `set`/`alter_session`
  (landed, AIR-2365 Part 4) — see "Databricks `set` rendering is raw text,
  not the generator" above for why a shared `render()` was wrong for that
  one case specifically before this round's fix, and note that even after
  the fix the gateway's own copy stays put: duplicating a six-line pure
  function locally is cheaper than a second cross-repo pin bump for this one
  spot.
- **Snowflake**: today reads context back from response `final*` fields with no
  SQL recognition at all; this module's Snowflake table is new tracking capability,
  not a replacement — a future PR can use `classify()`/`apply()` to predict
  context *before* a response arrives, cross-checked against the response's own
  `final*` fields rather than trusting either exclusively.

## Relationship to `gatewaySqlMetadata.js`

`contrib/gatewaySqlMetadata.js`'s own `getIsSessionStateChange`/
`extractSessionStateChange`/`extractUseChange`/`extractSetItem`/
`extractSetFromCommandText` stay exactly as they are — untouched, byte-compatible,
`test/gatewaySqlMetadata.test.mjs` passes unchanged. The two modules are not
layered (this one does not call the other, or vice versa): `gatewaySqlMetadata.js`
answers "is this one cacheable, and what table/mutation/parameter metadata does it
carry" for a single non-batch statement, with a `{kind, key, value}` shape sized
for exactly Databricks' three adapters' existing needs; `sessionState.js` answers
the broader, batch-aware, multi-dialect, replay-and-reduce question this epic was
opened for. A future gateway-adoption PR may have `gatewaySqlMetadata.js`
delegate its session-state fields to this module internally — left to that PR,
since it touches a surface with its own frozen test corpus (R118) and is better
done once an adapter actually needs both answers to agree byte-for-byte.
