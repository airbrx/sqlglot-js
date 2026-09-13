# contrib/

`contrib/` holds airbrx-specific modules built ON TOP of the real sqlglot-js
port. Nothing here has an upstream Python equivalent — no `py:` anchors, no
transliteration contract, not tracked by `PORT_PLAN.md`'s closure numbers or
R-series findings. It exists because sqlglot-js is real enough now (real
`Dialect`/`Parser`/`Generator` classes, real top-level `index.js`) to build
application code against it, not just port more of upstream.

## `gatewaySqlMetadata.js`

`extractSqlMetadata(sql, { dialect, parameterValues })` extracts cache-key
metadata from a SQL string, in a shape compatible with what
`airbrx-gateway`'s `lib/utils/SqlParser.js` (a regex-based, dialect-agnostic
metadata extractor used by the Databricks/Snowflake/Postgres adapters for
cache-key generation and routing) already returns from `SqlParser.parse(sql)`.
Where the gateway parser guesses from raw text, this module reads a real
parsed AST — `Dialect.get_or_raise(dialect).parse(sql)` — and is, by
construction, immune to the classic regex-parser failure mode of a keyword or
placeholder-looking substring appearing inside a string literal.

This module is **not itself part of any cross-repo integration** — it does
not touch `airbrx-gateway`, and nothing here replaces `SqlParser.js` yet. It
is a self-contained building block a future integration session can wire in.

### Why a dialect option is required

`airbrx-gateway`'s `SqlParser` is dialect-agnostic (one regex parser reused
across three engines with different real grammars). A real AST parser cannot
be: `dialect` is a required-in-spirit option (`Dialect.get_or_raise(dialect)`
— omitting it falls back to the base `Dialect`, matching upstream's own
`Dialect.get_or_raise(None)` behavior, which is a legitimate use, not an
error). Verified real dialect support: `databricks`, `snowflake`, `postgres`
(the three the gateway actually targets). Other dialect names work to the
extent this port has a real `Dialect` class for them at all — see the root
README's "What doesn't exist yet."

### Error tolerance is the most important property here

The gateway's regex parser never throws — it degrades to an empty/default
result on unparseable input. A real parser does throw (`ParseError`,
`TokenError`; verified concretely: `RESTORE TABLE ... TO VERSION AS OF ...`
is a hard `ParseError` on Databricks in this port). `extractSqlMetadata`
never propagates an exception: on any parse or extraction failure it returns
a conservative, safe-default result — `isReadOnly: false`, `isDataChange:
true`, `isDDL: true` — erring toward **not** caching rather than risking a
cache hit on something it could not understand. The failure reason is always
in `extractionError` (`string | null`), never swallowed silently.

`standardizedSql` gets its own inner try/catch, separate from the rest of the
extraction: generator coverage gaps (see below) can make regeneration fail
for a query whose tables/session-state/parameters/etc. are all extracted
correctly. On failure — whether a generator gap or a total parse failure
(`safeDefaultResult`) — `standardizedSql` falls back to the raw original SQL
text rather than `null` (`extractionError` explains why). This field's whole
purpose is to feed a cache key: `null` would be a *worse* cache-key input
than the query's own text, since every currently-unsupported statement would
collide on the same `null` key instead of each keying on its own SQL. The
fallback only ever gets more precise as generator coverage grows; it never
regresses an existing cache key's stability once a given shape starts
regenerating for real.

### Verified deviations from the gateway's regex behavior

Each of these was checked directly against a real parse (and, where noted,
against the pinned CPython `sqlglot` too — some are genuine upstream grammar
facts, not JS-port artifacts) rather than assumed. Test cases for each live
in `test/gatewaySqlMetadata.test.mjs`, next to a comment explaining the
reasoning.

- **Non-deterministic function canonicalization.** The AST does not preserve
  whether `CURRENT_DATE` was written with or without parens — `CURRENT_DATE`
  and `CURRENT_DATE()` parse to an identical `CurrentDate` node. This module
  reports one fixed canonical spelling per function (always `CURRENT_DATE`,
  never `CURRENT_DATE()`), rather than preserving the source spelling the
  gateway regex captures. Similarly, `NOW()`/`GETDATE()` collapse to the same
  typed `CurrentTimestamp` node `CURRENT_TIMESTAMP` uses on dialects where
  they're mapped, so they report under the `CURRENT_TIMESTAMP` canonical name
  rather than their own alias (Snowflake's `SYSDATE()` is the one exception:
  its `CurrentTimestamp` node carries a `sysdate` flag, so it reports as
  `SYSDATE` — the AST happens to preserve that distinction).
- **Some non-deterministic names only exist as an `Anonymous`-call-name
  fallback, verified per dialect.** Snowflake has no built-in
  `CURDATE`/`TODAY`/`NOW`; Postgres has no `CURDATE`/`TODAY`/`GETDATE` —
  these parse as ordinary function calls (`exp.Anonymous`) on those dialects,
  not a typed class. Matched by uppercased call name against a small fixed
  list. This carries none of a raw-text regex's string-literal
  false-positive risk, since real parsing has already ruled that out by
  construction.
- **Bare `SYSDATE` / bare `CURRENT_ROLE` (no parens) are not flagged.**
  Verified against pinned CPython sqlglot directly: none of the three target
  dialects' real grammar recognizes a bare `SYSDATE` as a keyword (only
  `SYSDATE()`, and only on Snowflake); this port's tokenizer doesn't yet wire
  bare `CURRENT_ROLE` as a keyword for any of the three either. Both read
  back as a plain `Column`. We do not add a name-based fallback for a bare
  identifier the way we do for `Anonymous` calls, because that would flag a
  real column literally named `sysdate`/`current_role` as non-deterministic
  — a false positive a real parser should not manufacture.
- **`SET key value` (no `=`) and bare `SET key` (read-one) are a permanent
  `Command` fallback in this port** — verified against pinned CPython
  sqlglot too, so this is an upstream grammar gap, not a JS-port bug: only
  `SET key = value` and bare `SET` (list-all) produce a real `Set` AST node.
  We extract from the `Command` node's own captured raw remainder text —
  narrowly scoped to that node, never the full SQL string — the same
  technique used for OPTIMIZE/VACUUM below.
- **OPTIMIZE / VACUUM (Databricks Delta-specific) are a permanent `Command`
  fallback** — this port (matching upstream) does not model them as a
  structured statement class. Table name is pulled with a small regex
  scoped only to the `Command` node's own raw text, and the result is marked
  `isDeltaOperation: true`.
- **`RESTORE TABLE ... TO VERSION AS OF ...` throws a hard `ParseError`** on
  Databricks in this port. Handled entirely by the top-level error-tolerance
  wrapper — no special-casing needed, which is exactly the point of building
  that wrapper first.
- **`'o''brien'`-style doubled-quote escaping is not decoded on Databricks
  (Spark-family dialects).** Verified against pinned CPython sqlglot: their
  `STRING_ESCAPES` config does not declare `''` as an apostrophe escape, so
  `'o''brien'` tokenizes as two adjacent string literals that the parser
  folds into a `Concat` node, rather than one decoded `Literal`. (Snowflake
  and Postgres decode it correctly into a single `Literal` — verified.) We
  reconstruct the intended value by rejoining a Concat-of-only-Literals'
  parts with `'`, since there is no other way to reach that exact shape in a
  SET/ALTER SESSION value position.
- **Table extraction finds more tables than the gateway regex for `CREATE
  TABLE ... AS SELECT`.** The gateway's `_extractFromDDL` only ever matches
  one table via a single regex on the DDL keyword; it never scans the `AS
  SELECT` body. A real AST finds both the created table and every source
  table naturally — arguably more useful for cache-invalidation decisions,
  since the read table matters too.
- **CTE names are excluded from `tables[]` using a real `With`/`CTE` node's
  alias, not a regex over the raw `WITH` clause** — and, unlike the gateway
  (which only scans the first `WITH` occurrence in the SQL text via a
  non-global regex match), this collects CTE names from every `With` node
  anywhere in the tree, including nested subqueries.
- **`USE ...`'s target never appears in `tables[]`**, even though a `Use`
  node's target is structurally an `exp.Table` — matches the gateway (whose
  `_extractTables` switch has no `USE` case), and is enforced by an explicit
  statement-type allowlist rather than relying on `USE` never containing a
  `Table` node.

### A significant, currently-real gap: `standardizedSql` generator coverage

`standardizedSql` is produced by real AST regeneration
(`dialect.generate(root)`) rather than the gateway's keyword-regex — see the
top-level project memory's framing of this as cache-key normalization's "step
1." As of PORT_PLAN.md R35, `src/generator.js`'s base `delete_sql`/
`drop_sql`/`update_sql`/`insert_sql`/`alter_sql`/`create_sql` are real, so
plain `INSERT`/`UPDATE`/`DELETE`/`CREATE TABLE`/`DROP TABLE`/`ALTER TABLE`
statements now regenerate `standardizedSql` correctly on all three target
dialects (Databricks/Snowflake/Postgres), not just `SELECT`/`MERGE`.

Two narrower gaps remain, both deliberate and both still hit `NotPorted`
(not silently wrong output):

- **`CREATE ... WITH (...)` / `TBLPROPERTIES (...)` / any other CREATE that
  carries a `properties` clause.** `create_sql` only handles CREATE
  statements with no `properties` arg — the full properties subsystem
  (`locate_properties`/`properties`/`properties_sql`/`root_properties`/
  `with_properties`) is still `NotPorted`. A plain
  `CREATE TABLE t (a INT)` or `CREATE VIEW v AS SELECT ...` regenerates
  fine; `CREATE TABLE t (a INT) USING DELTA LOCATION '...'` or
  `CREATE TABLE t (a INT) WITH (format = 'parquet')` still throws.
- **Other statement types not covered by this round**: `SET`, `USE`,
  `TRUNCATE`, `Command` fallbacks (`OPTIMIZE`/`VACUUM`/etc.), and
  constructs that hit an unrelated still-`NotPorted` method reached from
  inside an otherwise-working statement (e.g. `CURRENT_DATE` hits
  `currentdate_sql`, unrelated to the DML/DDL methods above).

Postgres fares somewhat better still on the remaining gaps (its generator is
more complete — see the root README's per-dialect table). This is a real,
current limitation, not hidden behind a passing test: every affected case is
covered in `test/gatewaySqlMetadata.test.mjs`, asserting `extractionError` is
set and `standardizedSql` falls back to the raw original SQL (not the fully
canonical form a working generator would produce — see "Error tolerance"
above for why `null` would be a worse fallback). Closing the rest needs more
of `src/generators/{databricks,snowflake}.js` (Snowflake's generator is
otherwise fairly complete — see the root README — the specific gaps here are
scattered `*_sql` methods for statement types the corpus under-samples, not a
generator-file-level gap) and `src/generator.js`'s own remaining base
methods (including the CREATE properties subsystem), tracked as ordinary
port work, not by this module. `insert_sql`/`update_sql`/`delete_sql`/
`drop_sql`/`alter_sql`/`create_sql` specifically landed as of PORT_PLAN.md
R35 (branch `generator-dml-ddl-keystone`).

### Explicitly out of scope

- Cross-repo integration with `airbrx-gateway` itself — a future session's
  job, done separately and more cautiously (this is a live production
  caching proxy).
- `operationType`/`describeOnly`/session-catalog-enrichment — gateway request
  -routing fields `SqlParser.parse(sql, options)` also returns, layered on
  top of (not derived from) SQL metadata. Out of this module's shape; a
  future integration can add them alongside this module's output rather than
  inside it.
- Any dialect other than `databricks`/`snowflake`/`postgres` — untested,
  unclaimed.
- Hot-path parse performance versus the gateway's regex approach —
  unbenchmarked.
