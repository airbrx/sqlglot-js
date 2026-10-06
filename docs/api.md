# API reference

> **Status:** the public surface described below is real (`index.js`, the package root) for
> seven dialects, plus `Schema`/`MappingSchema` (dialect-agnostic — column-type-aware
> table/column metadata, no dependency on how many dialects have landed) and `diff` (also
> dialect-agnostic); each section also says exactly what's still missing (mainly: the other
> ~42 harvested dialects).
> Function names and option shapes mirror upstream sqlglot's
> own `sqlglot/__init__.py` as closely as JS naming allows: a name that collides with a JS
> reserved word gets a trailing underscore (`from_`, `case_`), a multi-word `snake_case` name
> becomes `camelCase` (`parse_one` → `parseOne`, `to_identifier` → `toIdentifier`), everything
> else keeps its Python name unchanged. This is the same convention already used throughout
> `src/expressions/`, not a new one invented for this page.

## Top-level functions

**Real today** (`index.js`, the package root). The underlying parse AND generate machinery
is differentially tested (10,879/15,478 corpus rows exact on the parse side; seven dialects
— Databricks chain, Snowflake, DuckDB, Postgres — also generate for real), and the functions
below are thin, faithfully-shaped wrappers around it: `Dialect.get_or_raise(name)`
(`src/dialects/dialect.js`) is still the actual dialect-by-name registry underneath, and
`index.js` eagerly imports the seven dialects with a real class so `read`/`write` just work
by name without a separate import. `CONTRACTS.md` §8's restriction on resolving a dialect
string still applies to the other ~42 harvested dialects, which have no real `Dialect`
subclass yet — `parse`/`parseOne`/`transpile`/`tokenize` all throw `Unknown dialect` for
those names, the same as `Dialect.get_or_raise` does directly.

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

> **Works today**, exactly as shown above (`import { parse } from "sqlglot-js"`). `read` must
> be one of `"snowflake"`, `"duckdb"`, `"postgres"`, `"hive"`, `"spark2"`, `"spark"`,
> `"databricks"`, or omitted for the default dialect — no separate dialect import needed,
> `index.js` registers all seven eagerly.

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

> **Works today** for the seven dialects with a real `Generator` (Databricks chain, Snowflake,
> DuckDB — partial, see PORT_PLAN.md R32 — and Postgres). E.g. parsing `` SELECT `id` FROM t ``
> under `"databricks"` and generating under `"postgres"` produces `SELECT "id" FROM t` — a real
> cross-dialect identifier-quoting difference, not just round-tripping the input back out.
> Generating under an unregistered dialect (any of the other ~42 harvested ones) throws
> `Unknown dialect`, the same as calling `Dialect.get_or_raise` on that name directly.

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
  at all is enough — `index.js` registers seven). Pass a dialect name as the first positional
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
them via `import { ensureSchema } from "sqlglot-js/src/schema.js"` from a repo checkout (no
npm publish yet, same caveat as everything else on this page).

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

## Not yet designed / documented here

- **Every dialect beyond the seven listed above** — no real `Parser`, `Dialect`, or
  `Generator`; `Dialect.get_or_raise("bigquery")` (for example), and therefore
  `parse`/`parseOne`/`transpile`/`tokenize` given `read`/`write: "bigquery"`, throws
  `Unknown dialect`.
- **Publishing to a registry** — `package.json`/`index.js` are real, but there's no npm
  publish yet; consume via a git dependency (see the root [README](../README.md)) or import
  `./index.js` directly from a repo checkout.

See `PORT_PLAN.md` for the phase (P4, P5, ...) each of these lands in, and the real, current,
measured status of everything on this page.
