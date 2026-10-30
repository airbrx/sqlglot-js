# API reference

> **Status:** the public surface described below is real (`index.js`, the package root) for
> all 33 of upstream's dialect modules at the pin — `parse`/`parseOne`/`transpile`/`tokenize`
> resolve any of them by name — plus `Schema`/`MappingSchema`, `optimize`, `lineage`,
> `anonymize`/`render`, and `diff`, all dialect-agnostic. Every section below says exactly
> what's measured and links to the **Known gaps** section for what's still open — as of R117,
> generate is at full parity with the pin (0 MISMATCH / 0 STUB / 0 ERROR) and parse has
> exactly one standing row, a deliberate accepted divergence (`docs/stability.md`), not
> missing surface. See the root [README](../README.md) for the measured whole-corpus numbers
> this page's claims are checked against.
> Function names and option shapes mirror upstream sqlglot's
> own `sqlglot/__init__.py` as closely as JS naming allows: a name that collides with a JS
> reserved word gets a trailing underscore (`from_`, `case_`), a multi-word `snake_case` name
> becomes `camelCase` (`parse_one` → `parseOne`, `to_identifier` → `toIdentifier`), everything
> else keeps its Python name unchanged. This is the same convention already used throughout
> `src/expressions/`, not a new one invented for this page.
>
> **JS-specific shapes worth knowing up front**, each a `CONTRACTS.md` §8-recorded deviation:
> Python's `None` is JS `null` everywhere (there is no separate "undefined means missing"
> convention in the public API); a Python keyword-argument call becomes a single trailing
> options object (no JS keyword arguments); a Python `dict`/`set` that needs insertion-order
> or non-string keys is a JS `Map`/`Set`, not a plain object (`Schema`'s nested mapping, the
> tokenizer's keyword tables); and `pyTruthy`/`pyFalsy` (empty array, empty string, `0`, `null`
> are falsy, matching Python's own truthiness, not JS's — an empty array is falsy in Python but
> truthy in bare JS `if (arr)`) show up in a few places where this port's own internals check
> an upstream-shaped condition, though the public functions on this page don't require a
> caller to know that.

## Top-level functions

**Real today** (`index.js`, the package root). The underlying parse AND generate machinery
is differentially tested against the full corpus (15,539/15,540 rows exact on the parse
side, 15,540/15,540 — full parity with the pin — on the generate side; see the root README's
status table for the one standing row, the deliberate `CURRENT_ROLE` divergence), and the
functions below are thin, faithfully-shaped wrappers
around it: `Dialect.get_or_raise(name)` (`src/dialects/dialect.js`) is still the actual
dialect-by-name registry underneath, and `index.js` eagerly imports all 33 dialects with a
real class so `read`/`write` just work by name without a separate import. A name that isn't
one of the 33 (`test/index.test.mjs` carries the exact list) throws `Unknown dialect`, the
same as calling `Dialect.get_or_raise` on that name directly.

### `parse(sql, options?)`

```ts
function parse(sql: string, options?: {
  read?: string;    // dialect to parse under, e.g. "snowflake" (default: base dialect)
  dialect?: string;  // alias for `read`
}): (Expr | null)[]
```

Parses `sql` (which may contain multiple `;`-separated statements) and returns one expression
tree per statement, in order. A genuinely empty statement (e.g. the middle one in
`"SELECT 1;;SELECT 2"`) comes back as `null` in its slot rather than as an error — this is
`Dialect.parse`'s own behavior, not something `errorLevel` changes; `errorLevel` (one of the
`ErrorLevel` values re-exported below — `IGNORE`, `WARN`, `RAISE`, `IMMEDIATE`) controls
whether a genuine parse *defect* throws immediately, accumulates and throws at the end, or is
swallowed.

> **Works today**, exactly as shown above (`import { parse } from "sqlglot-js"`). `read` may
> be any of the 33 dialect names (`test/index.test.mjs` carries the exact list, grouped by
> family in the root README) or omitted for the default dialect — no separate dialect import
> needed, `index.js` registers all 33 eagerly.

### `parseOne(sql, options?)`

```ts
function parseOne(sql: string, options?: {
  read?: string;
  dialect?: string;
  into?: typeof Expr;  // parse into a specific expression class rather than a full statement
}): Expr
```

Like `parse`, but for the common case of exactly one statement: returns the tree directly
(not wrapped in an array), and throws `ParseError` if nothing parsed. Pass `into` to parse a
SQL fragment as a specific node type — `parseOne("a + 1", { into: exp.Condition })` — rather
than a full `SELECT`. (Note: unlike upstream's `parse_one`, multiple statements are not
wrapped in a `Block` — this port's `parseOne` just returns the first tree, matching the
signature above.)

**Real today.**

### `transpile(sql, options?)`

```ts
function transpile(sql: string, options?: {
  read?: string;
  write?: string;      // target dialect (default: same as `read`, i.e. identity transpile)
  identity?: boolean;   // if false, `write` must be given explicitly (default: true)
  errorLevel?: string;
}): string[]
```

Parses under `read` and generates under `write`, one output string per input statement. This
is the round-trip entry point — `parse` + `.sql(write)` per statement. A `null` slot from
`parse` (a genuinely empty statement) generates as `""`, matching upstream.

> **Works today** for all 33 dialects, each with a real `Generator`. E.g. parsing
> `` SELECT `id` FROM t `` under `"databricks"` and generating under `"postgres"` produces
> `SELECT "id" FROM t` — a real cross-dialect identifier-quoting difference, not just
> round-tripping the input back out. "Works" here means "produces output," not "byte-exact
> with upstream for every input" — the root README's status table and
> [Known gaps](#known-gaps) below name the current generate MISMATCH/STUB population exactly.
> Generating under a name that isn't one of the 33 throws `Unknown dialect`, the same as
> calling `Dialect.get_or_raise` on that name directly.

### `tokenize(sql, options?)`

```ts
function tokenize(sql: string, options?: {
  read?: string;
  dialect?: string;
}): Token[]
```

Returns the raw token stream without building a tree. **Real today** — the
`Tokenizer`/`TokenizerCore` machinery underneath is fully ported and byte-exact-tested against
CPython over 23,457 streams (P1). Note the field is `token.token_type` (a number, the
`TokenType` enum value) on the real `Token` class, not a camelCase `tokenType` — `src/tokens.js`'s
`Token` keeps upstream's own snake_case field name unchanged rather than converting it.

## The `exp` namespace

**Real today**, importable as `import * as exp from "sqlglot-js"` (re-exported from
`src/expressions/index.js`). Every SQL construct is a class —
`Select`, `Column`, `Where`, `Literal`, `Join`, and more — 1,048 total, generated from
upstream's own class metadata (argument types, required args, traits) and checked against
5,240 assertions plus a full corpus AST round-trip (`astDump(astLoad(row.ast))` deep-equals
the original for every one of 15,540 harvested rows).

### Constructing nodes

Two ways to build a tree, matching upstream:

```js
import * as exp from "sqlglot-js";

// 1. Builder functions — the ergonomic path
const query = exp.select("id", "name").from_("users").where(exp.column("active").eq(true));

// 2. Direct construction — what the builders above call into
const col = new exp.Column({ this: new exp.Identifier({ this: "active", quoted: false }) });
```

Common builders (all real today): `select`, `from_`, `column`, `cast`, `table_`, `subquery`,
`values`, `insert`, `update`, `delete_`, `merge`, `and_`, `or_`, `not_`, `xor`, `alias_`,
`toIdentifier`, `toColumn`, `toTable`, `func`, `case_`, `array`, `tuple_`.

### Working with a tree

Every `Expr` (real today, `src/expressions/core.js`):

- **`.args`** — a plain object of the node's fields (e.g. a `Select`'s `expressions`, `from_`,
  `where`). This is the ground truth; convenience accessors below just read from it.
- **`.walk()`** — depth-first iterator over the node and every descendant.
- **`.copy()`** — deep copy (Python `deepcopy`-equivalent, including its recursion-depth
  semantics — `PORT_PLAN.md` R11 measured and documented the real ceiling).
- **`.equals(other)`** / **`.hash()`** — structural equality and a stable 64-bit hash, used
  internally for CTE/subquery deduplication in the optimizer (see `optimize()` below).
- **`.eq(x)`, `.neq(x)`, `.and_(x)`, `.or_(x)`**, and the rest of the comparison/boolean
  builder methods for fluently composing conditions on an existing node.
- **`.sql(dialect?, options?)`** — **real today**, through the default dialect as soon as any
  dialect module has been imported for its registration side effect (importing this package
  at all is enough — `index.js` registers all 33). Pass a dialect name as the first positional
  argument to generate under a specific one — `expr.sql("postgres")` — matching upstream's own
  `expr.sql(dialect="postgres")` shape exactly (not an options-object `{ dialect }`, despite
  what an earlier draft of this page predicted). Throws `"No SQL generator registered"` only if
  called before any dialect module has been imported at all.

### Errors

Real today (`src/errors.js`), matching upstream's exception hierarchy:

```js
import { ParseError, parseOne } from "sqlglot-js";

try {
  parseOne("SELECT FROM");
} catch (e) {
  if (e instanceof ParseError) console.log(e.errors); // structured, not just a message
}
```

`ErrorLevel` (`IGNORE | WARN | RAISE | IMMEDIATE` — uppercase string values, matching
upstream's own `AutoName` enum exactly; use the exported `ErrorLevel.IGNORE` etc. constants
rather than a bare lowercase string): `IGNORE` ignores all errors, `WARN` logs them, `RAISE`
collects all of a statement's errors and raises one exception for it, `IMMEDIATE` raises on
the first error found. The default when `errorLevel` is omitted is `IMMEDIATE` — same default
as upstream's `Parser.__init__`.

The full hierarchy (`src/errors.js`), all re-exported from the package root: `SqlglotError`
(the common base, not itself re-exported — catch it via `ParseError`/`TokenError`/
`UnsupportedError`, or `instanceof Error`) → `ParseError` (thrown by `parse`/`parseOne`/
`transpile`, carries structured `.errors`), `TokenError` (thrown by `tokenize` on a lexing
failure — unterminated string, invalid escape), and `UnsupportedError` (thrown when
`errorLevel` is `RAISE`/`IMMEDIATE` and the generator hits a construct a dialect's `Generator`
has no rendering for — e.g. calling `.sql("duckdb")` on an AST node DuckDB has no SQL for).

## `Schema` / `MappingSchema`

**Real today** (`src/schema.js`, whole-file port — nothing stubbed), re-exported from the
package root as `import { Schema, MappingSchema } from "sqlglot-js"` (matching upstream's own
`sqlglot/__init__.py`, which re-exports exactly these two names and none of the module's
other helpers). Differentially tested against CPython: 24 scenarios / 71 checks
(`spike/p6/fuzz_schema.mjs`, since — unlike the parse/generate corpus — nothing else in the
port depends on this file yet, so there is no existing corpus row to reuse) plus 29 structural
unit tests (`test/schema.test.mjs`).

Column-type-aware table/column metadata: a nested mapping of `{table: {column: type}}` (or
`{db: {table: {...}}}` / `{catalog: {db: {table: {...}}}}`), dialect-aware identifier
normalization, and a trie-based lookup that resolves a partially-qualified table name
(`"t1"`) against however many catalog/db/table levels the schema was actually built with —
raising `SchemaError` if that's ambiguous.

```js
import { MappingSchema } from "sqlglot-js";

const schema = new MappingSchema({ users: { id: "INT", email: "VARCHAR" } });
schema.columnNames("users");             // ["id", "email"]
schema.getColumnType("users", "id").sql(); // "INT"
schema.hasColumn("users", "email");      // true

// The string form splits on every comma (matching upstream exactly), so a parameterized
// type's own commas need the object form instead: "total:DECIMAL(10,2)" would misparse.
schema.addTable("orders", { id: "INT", user_id: "INT", total: "DECIMAL(10, 2)" });
```

Real methods: `addTable`, `columnNames`, `getColumnType`, `hasColumn`, `getUdfType`, `find`,
`copy`, `MappingSchema.fromMappingSchema`. Module-level helpers `ensureSchema`,
`ensureColumnMapping`, `normalizeName`, `flattenSchema`, `nestedGet`, `nestedSet` are real too
but not re-exported from the package root (matching upstream's own top-level surface) — reach
them with a **relative** import from a repo checkout, `import { ensureSchema } from
"./src/schema.js"`. Importing via the package name instead — `from "sqlglot-js/src/schema.js"`
— does NOT work even as a git dependency: `package.json`'s `exports` map has no `./src/*`
entry (only `./dialects/*`, `./expressions/*`, `./contrib/*` are exposed as subpaths), so Node
raises `ERR_PACKAGE_PATH_NOT_EXPORTED` for any other path under the package name — verified
directly, not assumed.

One JS-specific note worth knowing before hand-building a schema: the internal nested mapping
is stored as `Map`, not a plain object, specifically so a table or column literally named
`"123"` keeps its real insertion position instead of a JS object silently sorting
integer-looking keys first. Passing a schema via `normalize: true` (the default) is always
safe regardless of what you construct it from (plain object or `Map`) — the constructor
rebuilds the internal structure as `Map` either way. Passing `normalize: false` stores
whatever you hand it as-is (matching upstream's own aliasing, no copy), so a plain-object
literal with numeric-looking keys under `normalize: false` keeps whatever order the JS engine
already gave it by the time your code runs.

A real consumer now exists: `optimize()` below passes `schema` straight through to the
`qualify`/`annotate_types` rules it runs, which is what resolves `*` into real columns and
infers each expression's type.

## `optimize(expression, options?)`

**Real today** (`src/optimizer/optimizer.js`, port of `sqlglot/optimizer/optimizer.py`),
re-exported from the package root as `import { optimize, RULES } from "sqlglot-js"`. `RULES`
itself is not part of upstream's own top-level re-export surface (upstream reaches it as
`sqlglot.optimizer.optimizer.RULES`) but is re-exported here anyway since this port has no
npm-published subpath-import story yet — see `RULES`'s own use in the custom-`rules` note
below.

```ts
function optimize(expression: string | Expr, options?: {
  schema?: Schema | object | Map;  // table/column metadata; ensureSchema()-wrapped if omitted
  db?: string;
  catalog?: string;
  dialect?: string;
  rules?: Function[];               // defaults to RULES, run in this exact order
  sql?: string;
  // ...plus any rule-specific kwarg a RULES entry declares by name (e.g. `identify`,
  // `quote_identifiers`, `expand_stars`, `leave_tables_isolated`) — see
  // `src/optimizer/optimizer.js`'s own `KNOWN_RULE_KWARGS` for the full recognized set.
}): Expr
```

Rewrites `expression` into an optimized AST by running, in order: `qualify` (resolve `*` and
unqualified names against `schema`), `pushdown_projections`, `normalize`, `unnest_subqueries`,
`pushdown_predicates`, `optimize_joins`, `eliminate_subqueries`, `merge_subqueries`,
`eliminate_joins`, `eliminate_ctes`, `quote_identifiers`, `annotate_types`, `canonicalize`,
`simplify` (constant folding and boolean simplification) — upstream's exact default `RULES`
order. Every one of these 14 rules was independently differentially tested against CPython
before this file existed; this file's own job is the composition (see the file's header
comment for the one real design decision involved — a hand-written kwarg adapter per rule,
since JS has no `inspect.getfullargspec` equivalent).

**What it does NOT do:** there is no executor here — `optimize()` only rewrites the AST and
returns a new `Expr` (`.sql()` it yourself afterwards); it never runs a query, touches a
database, or estimates cost. It also does not generically support upstream's `rules=`
override — a caller-supplied rule that isn't one of the 14 default `RULES` entries runs with
*no* kwargs forwarded to it (a real, documented limitation, not a silent bug — see the file's
own header for why closing it would need either an unbounded set of hand-written adapters or
genuine runtime reflection, which JS doesn't have).

```js
import { optimize, MappingSchema } from "sqlglot-js";

const schema = new MappingSchema({ users: { id: "INT", email: "VARCHAR" } });
const optimized = optimize("SELECT * FROM users WHERE 1 = 1 AND id = 1", { schema });

optimized.sql();
// 'SELECT "users"."id" AS "id", "users"."email" AS "email" FROM "users" AS "users" WHERE "users"."id" = 1'
```

`*` expanded to the real columns from `schema`, and the always-true `1 = 1 AND` redundant
predicate folded away — both require a schema to do fully; without one, `qualify` still runs
but can't resolve `*` or an unqualified column against anything.

## `lineage(column, sql, options?)`

**Real today** (`src/lineage.js`, port of `sqlglot/lineage.py`), re-exported from the
package root as `import { lineage, Node } from "sqlglot-js"`. Like `RULES` above, upstream
itself does not re-export this from its own package root (`from sqlglot.lineage import
lineage` there) — re-exported here anyway for the same no-subpath-import-story reason.

```ts
function lineage(column: string | null, sql: string | Expr, options?: {
  schema?: Schema | object | Map;
  sources?: { [name: string]: string | Expr } | Map<string, string | Expr>;
  dialect?: string;
  scope?: Scope;                    // pre-built Scope; skips qualify()+buildScope() internally
  trimSelects?: boolean;            // default true
  copy?: boolean;                   // default true
  onNode?: (node: Node) => void;    // fires once per unique Node, after its downstream is set
  // ...plus any qualify() kwarg (e.g. `expandStars`, `isolateTables`)
}): Node | { [name: string]: Node }
```

Builds a column-level lineage DAG by qualifying `sql` (unless a pre-built `scope` is given)
and recursively tracing each output column back through every join/subquery/CTE/PIVOT it's
derived from. Pass a column name (or `exp.Column`) to get a single `Node`; pass `null` to get
every top-level output column as `{ name: Node }`, with a shared cache so columns that
reference the same upstream data (e.g. a CTE joined with itself) share the same `Node`
object rather than each re-deriving it.

```js
import { lineage } from "sqlglot-js";

const node = lineage("a", "SELECT a FROM z", {
  schema: { x: { a: "int" } },
  sources: { y: "SELECT * FROM x", z: "SELECT a FROM y" },
});

node.source.sql();
// 'SELECT z.a AS a FROM (SELECT y.a AS a FROM (SELECT x.a AS a FROM x AS x) AS y /* source: y */) AS z /* source: z */'

node.downstream[0].sourceName; // 'z'
```

`Node` (plain object, not frozen): `.name`, `.expression` (the traced `Expr`), `.source` (the
containing query/table `Expr`), `.downstream` (`Node[]`), `.sourceName`, `.referenceNodeName`,
`.payload` (caller-populated via `onNode`). `Node#walk()` is an iterable DFS pre-order
traversal over the reachable DAG, visiting each unique node once. `Node#toHtml(dialect?,
opts?)` returns a `GraphHTML` (`.toString()`/`._repr_html_()`) for a vis.js-rendered page —
real as of this PR (`src/generator.js`'s `tag_sql`, the one base-Generator method it needed,
was a `NotPorted` stub fixed alongside this file).

**Known gap:** `source_columns`'s iteration order inside `to_node` (which column of a
multi-column expression like `a + b` gets traced first) is, in upstream CPython, the order
of a `set` of `exp.Column` nodes — dependent on CPython's own content-based
`Expression.__hash__`, not reproducible from (and not a contract upstream's own test suite
relies on either — it explicitly sorts before asserting) a JS `Set`. In the rare case where
this affects relative `downstream` order, this port's own order is internally consistent but
not guaranteed to match CPython's. See `spike/p10/fuzz_lineage.mjs`'s own header.

## `anonymize(sqlOrTokens, dialect?)` / `render(sql, tokens, dialect?)`

**Real today** (`src/anonymize.js`, port of `sqlglot/anonymize.py`), re-exported from the
package root as `import { anonymize, render } from "sqlglot-js"`. Neither is part of
upstream's own top-level re-export surface (upstream reaches them as
`sqlglot.anonymize.anonymize`/`.render`) but both are re-exported here anyway, for the same
npm-published-subpath reason `RULES` is (see `optimize()` above).

```ts
function anonymize(sqlOrTokens: string | Token[], dialect?: string | Dialect | null): Token[]
function render(sql: string, tokens: Token[], dialect?: string | Dialect | null): string
```

`anonymize()` replaces sensitive tokens — identifiers, strings, numbers — with fixed-width,
length-preserving, consistent aliases (the same source text always gets the same alias within
one call), and blanks out comment and hint bodies. It mutates and returns its own token list: a
SQL string is tokenized first (any un-tokenized remainder, e.g. an unterminated string literal,
is appended as a blanked `UNKNOWN` token so the delimiter that broke tokenization stays
visible), or an already-tokenized `Token[]` is anonymized in place. `render()` then
reconstructs a full SQL string from the *original* `sql` and the anonymized tokens' positions,
so every token lines up with its own source span — a token that wasn't anonymized keeps its
original spelling (including whitespace the tokenizer would otherwise normalize away), and an
anonymized one has its alias fitted between the quotes of its span. The output is always
exactly as long as the input.

**Not a cryptographic hash** — there is no `hash()`/`hashlib` anywhere in `anonymize.py`. The
alias for a VAR/IDENTIFIER-shaped token is a base-26 counter rendered as letters (`a`, `b`, ...,
`z`, `aa`, ...); a NUMBER token's alias is a same-width, same-shape digit string derived from
the same counter (preserving a decimal point and/or exponent marker at their original
positions). A known function name immediately followed by `(` (looked up in the dialect's own
`FUNCTIONS`/`FUNCTION_PARSERS` tables) is left untouched, on the theory that `SUM(...)` is not
itself sensitive.

```js
import { anonymize, render } from "sqlglot-js";

const sql = "SELECT name, email FROM users WHERE id = 42 -- internal only";
render(sql, anonymize(sql));
// 'SELECT aaaa, aaaab FROM aaaac WHERE ad = 14 -- ........ ....'
```
## `diff(source, target, options?)`

**Real today** (`src/diff.js`, port of `sqlglot/diff.py`'s Chawathe et al./Change-Distiller
tree-edit-distance algorithm), re-exported from the package root as
`import { diff, Insert, Remove, Move, Update, Keep } from "sqlglot-js"`. The edit classes are
not part of upstream's own top-level re-export surface (upstream reaches them as
`sqlglot.diff.Insert` etc.) but are re-exported here anyway, for the same
no-subpath-import-yet reason `RULES` is under `optimize` above — a caller needs them for
`instanceof` checks on `diff()`'s own return value.

```ts
function diff(source: Expr, target: Expr, options?: {
  matchings?: [Expr, Expr][];  // pre-matched node pairs; must reference the SAME node
                                 // objects as in source/target, not copies
  delta_only?: boolean;         // excludes all Keep edits from the result
  f?: number;                   // dice-coefficient threshold (default 0.6)
  t?: number;                   // leaf-similarity threshold (default 0.6)
  dialect?: string | Dialect | null;  // used only to render nodes for bigram similarity
}): (Insert | Remove | Move | Update | Keep)[]
```

Returns the list of edits needed to turn `source` into `target`: `Insert`/`Remove` carry a
single `expression`; `Move`/`Update`/`Keep` carry `source`/`target`. Edit-script ORDER is not
part of the contract — upstream's own `tests/test_diff.py` asserts `set(actual) ==
set(expected)`, never list equality, because the algorithm's internal `Remove`/`Insert`/`Keep`
loops iterate Python `set`s/`dict`s built from `id()` (object-identity) keys, whose order
depends on CPython memory addresses and isn't stable across runs even with
`PYTHONHASHSEED` pinned. Compare diff results as a set (or multiset) of edits, not a list.

```js
import { diff, Remove, Insert } from "sqlglot-js";
import { parseOne } from "sqlglot-js"; // same package

const edits = diff(parseOne("SELECT a + b"), parseOne("SELECT a - b"), { delta_only: true });
// [Remove(a + b), Insert(a - b), Move(a, a), Move(b, b)] (as a set)
```

**What it does NOT do:** `ChangeDistiller`'s `dialect` option only affects how nodes are
rendered to SQL text for the dice-coefficient similarity score — it does not make `diff()`
aware of a dialect's own parsing quirks, and does not require `source`/`target` to have been
parsed under that same dialect.

## `addLogSink(sink)` / `removeLogSink(sink)`

The parser's Command-fallback warning (`'…' contains unsupported syntax. Falling back to
parsing as a 'Command'.`) is emitted through the port's `sqlglot` logger, which — like
Python's `logging.lastResort` — writes to `console.error` when nothing is listening.
An embedder with its own logger installs a sink once:

```js
import { addLogSink } from "sqlglot-js";
const remove = addLogSink((line) => myLogger.debug(line)); // line is "WARNING:sqlglot:…"
```

While any sink is installed nothing reaches stderr. `captureLogs` (used by the test
suite) is the scoped, synchronous form of the same mechanism.

## `sqlglot-js/contrib/sessionState`

No upstream Python equivalent — airbrx-specific, built on top of the real port (same status
as `contrib/gatewaySqlMetadata.js` below). Classifies, reduces, and replays session-affecting
SQL (`SET`/`RESET`/`USE`/`ALTER SESSION`/`DISCARD`/transaction control) across dialects, for
`airbrx-gateway`'s three session-state recognizers (Postgres' regex `SearchPathTracker`,
Databricks' ad-hoc extractors, Snowflake's none-at-all) to adopt one at a time. Full design —
Effect/State schemas, per-dialect tables, fallback-reader rationale, what stays gateway-side
policy — is in [docs/proposals/session-state-module.md](proposals/session-state-module.md);
this section is the quick API reference.

```ts
import { classify, createState, apply, effectiveSearchPath, render } from "sqlglot-js/contrib/sessionState";

function classify(sql: string, options?: { dialect?: string | null }): Effect[];
function createState(dialect?: string | null): State;
function apply(state: State, effect: Effect): State;
function effectiveSearchPath(state: State): string | null;
function render(state: State, options?: { dialect?: string | null }): string[];
```

`classify()` parses `sql` (optionally a semicolon-batched multi-statement input) under
`Dialect.get_or_raise(dialect)` and returns one `Effect` per statement, in source order — a
statement that isn't a session-state statement at all still gets one, `kind: "none"`, so a
caller can walk `Effect[]` index-for-index against the batch. A statement carrying several
items (`SET a = 1, b = 2`, `ALTER SESSION SET x = 1, y = 2`) is still one `Effect` — the first
item's — with every item on `items` (R128); `apply()` reduces them all. A statement that fails to parse
(including the two documented upstream-faithful throws, Postgres `START TRANSACTION ISOLATION
LEVEL ...` and TSQL `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED`) collapses the WHOLE
input to a single `kind: "unknown"` Effect, same fail-closed shape
`contrib/gatewaySqlMetadata.js`'s own catch-all uses.

```js
import { classify, createState, apply, effectiveSearchPath } from "sqlglot-js/contrib/sessionState";

let state = createState("postgres");
for (const sql of ["SET ROLE admin", "SET search_path = a, b"]) {
  const [effect] = classify(sql, { dialect: "postgres" });
  state = apply(state, effect);
}
effectiveSearchPath(state); // "path:a, b" — trusted even while a role is switched,
                             // because this path was set explicitly and names no $user
```

`apply()` is a pure, immediate reducer (no transaction-rollback modeling — a caller with
Postgres' "don't trust a change until the statement is confirmed outside an open transaction"
requirement gets it for free by simply not calling `apply()` until then, using `effect.scope`
to know which changes are transaction-local in the first place). `render()` emits
`state.replayLog` back to SQL — through the real dialect generator for every `use_*` kind on
every dialect, and for `set` on every family except Databricks (which stores a `SET k = v`
value's RHS text verbatim, with no string-literal syntax to decode or re-encode — see
[docs/proposals/session-state-module.md](proposals/session-state-module.md)'s "Databricks `set`
rendering is raw text, not the generator" section).

Three family-scoping fixes (AIR-2373, found by the gateway's own adoption of this module):
`search_path`/`role`/`session_authorization` are Postgres-only GUCs in `apply()` too, not just
`classify()`'s canonicalization table — a Databricks variable literally named `search_path` now
lands in `state.variables` like any other key, not in the Postgres-only `state.searchPath`
field; a two-part `USE a.b` Effect carries structured `parts: {catalog, schema}` that `apply()`
prefers over splitting `value` on `"."`, so a catalog/schema component containing a literal dot
is never mis-split; and `State` gains a `variablesRaw` sibling of `variables` (source-quoted,
same keys) that only a Databricks-family `render()` ever reads.

A transaction can end two ways: a plain `COMMIT`/`ROLLBACK`/`END`/`ABORT` leaves the session
idle, while the same statement with a trailing `AND CHAIN` immediately opens a new transaction
with the same characteristics (Postgres itself reports `ReadyForQuery('T')`, not `'I'`). Every
`kind: "transaction"` Effect with `key: "commit"`/`"rollback"` carries this as a `chain: boolean`
field (`true`/`false`, never `null`); every other Effect — including every other transaction key
— has `chain: null`. See
[docs/proposals/session-state-module.md](proposals/session-state-module.md)'s "Transaction
chain" section for the full per-spelling table (R130).

## Per-dialect notes

Most of the 33 dialects behave exactly like upstream with no caller-visible difference worth
calling out. A few don't:

- **`dax` and `prql` have no bare `SELECT` grammar at all**, faithfully — upstream itself
  raises a `ParseError` for `sqlglot.parse("SELECT 1", read="dax")` and `read="prql"`. DAX only
  parses `EVALUATE <table expr>` statements (Power BI's query language); PRQL is a pipeline
  language (`from x | derive y = 1`), not SQL syntax at all. `test/index.test.mjs` probes each
  with its own smoke string for this reason rather than the shared `SELECT 1`.
- **`athena` routes each statement to one of two different grammars underneath**, matching
  AWS's own behavior: Athena is not simply hosted Trino — it dispatches a query to either a
  Hive-flavored DDL engine or a Trino DML engine depending on statement shape, and
  `src/dialects/athena.js`/`src/parsers/athena.js`/`src/generators/athena.js` mirror that same
  Hive-vs-Trino composite one layer up rather than picking a single base class. Calling code
  doesn't need to know which half of Athena handled a given statement; the dialect does it
  transparently.
- **Family chains subclass each other**, the same way upstream does: `Spark` subclasses
  `Hive`, `Databricks` subclasses `Spark`; `SingleStore`/`StarRocks`/`Doris` subclass `MySQL`;
  `Trino`/`Dune` subclass `Presto`; `Materialize`/`RisingWave`/`Fabric` subclass `Postgres`. A
  fix to a shared base method affects every dialect in its chain, same as upstream.
- **`postgres` (and the base dialect) parse `CURRENT_ROLE` as a typed node, deliberately
  diverging from the pin.** `SELECT CURRENT_ROLE` parses to `exp.CurrentRole` (rendered
  `CURRENT_ROLE()`) here; the pin parses an untyped `Column`. See [Known gaps](#known-gaps)
  and [docs/stability.md](stability.md) — this is the one accepted, permanent divergence in
  the whole port, not a defect.

## Known gaps

Everything below is real, named, and measured. None of it is silent: every number here comes
from a command in the root README's status table, re-run on this tree at `65c9054` (R117).

- **The one standing row, on every whole-corpus and honest-oracle axis**: `postgres` (and the
  base dialect) parse `SELECT CURRENT_ROLE` to a typed `exp.CurrentRole` node (rendered
  `CURRENT_ROLE()`) where the pin parses an untyped `Column`. This is a **deliberate,
  permanent, accepted divergence**, not an open gap — decided by Ben, 2026-10-16 (Linear
  AIR-1864), because `contrib/gatewaySqlMetadata.js`'s non-determinism classifier depends on
  the typed node (airbrx-gateway PR #228). See
  [docs/stability.md](stability.md#the-one-accepted-divergence-current_role) for the full
  rationale. It is the single row behind whole-corpus parse (15,539 PASS / 1 MISMATCH / 0
  STUB / 0 ERROR of 15,540), the honest AST oracle (1 MISMATCH / 0 ERROR), and the v0
  scorecard (6,521/6,522). Whole-corpus generate is **0 MISMATCH / 0 STUB / 0 ERROR of
  15,540 — full parity with the pin** as of R116/R117 (`node
  tools/mismatch_report.mjs --all` likewise reports exactly this one row, categorized under
  its own instrument as a `SQL_MISMATCH`).
- **76% of the 3,589 optimizer fixture pairs have no replaying differential oracle in this
  repo** (`tools/fixture_rollup.mjs`, R95/AIR-1864) — most severely `annotate_functions.sql`
  (1,932 pairs, 54% of the whole fixture corpus), with zero replay coverage despite several
  `fuzz_annotate_types*`/`fuzz_typing*` oracles covering the same subject area independently.
  This does **not** mean `optimize()`'s rules are untested — every rule has its own
  differential oracle (§3 of `PORT_PLAN.md`) — it means this *specific* upstream fixture
  corpus, file-for-file, isn't replayed end-to-end. See
  `docs/verification/optimizer-fixture-rollup.md` for the full per-file table.
- **`fuzz_dialect_defaults.mjs` has two permanent, named GAP notes** (428/428 checks still
  pass around them): `generator_class` — the base `Dialect.generator_class` static reads as
  `null` where CPython's autofill resolves to the `Generator` class; and
  `Literal.string(null)` — `format_time("''")` reaches a code path where CPython's `str(None)`
  renders `"None"` and this port's `String(null)` renders `"null"` (a real, reachable, 1-value
  divergence, not a design choice — see the fuzzer's own comment for the exact two-line fix
  and why landing only one line regresses two BigQuery rows).
- **Not published to any registry, and no semver guarantee yet** — `package.json` is
  `"private": true` and there's no npm publish yet; consume via a git dependency (see the
  root [README](../README.md)) or import `./index.js` directly from a repo checkout. See
  [docs/stability.md](stability.md) for the full no-promise-areas list.

See `PORT_PLAN.md`'s R115–R117 entries for how every number above was produced, and
`PORT_PLAN.md`'s R100–R114 entries for the dialect-completion history that preceded it.
