# API reference

> **Status:** target design for the public surface, written ahead of implementation. Each
> section says what's real today. Function names and option shapes mirror upstream sqlglot's
> own `sqlglot/__init__.py` as closely as JS naming allows: a name that collides with a JS
> reserved word gets a trailing underscore (`from_`, `case_`), a multi-word `snake_case` name
> becomes `camelCase` (`parse_one` → `parseOne`, `to_identifier` → `toIdentifier`), everything
> else keeps its Python name unchanged. This is the same convention already used throughout
> `src/expressions/`, not a new one invented for this page.

## Top-level functions

**Target design — not implemented as a package yet.** The underlying parse AND generate
machinery is real and differentially tested (10,879/15,478 corpus rows exact on the parse
side; four dialects — Databricks chain, Snowflake, DuckDB, Postgres — also generate for
real); what doesn't exist at this specific layer is the public wrapper functions below. Their
real equivalent already exists and is real, just not under these names: P5's `Dialect`
registry (`src/dialects/dialect.js`) landed for all four originally-prioritized dialects, so
`Dialect.get_or_raise(name)` — not the string-taking functions below — is today's actual
dialect-by-name entry point. `CONTRACTS.md` §8's restriction on resolving a dialect string
before P5 existed no longer applies to those four names; it still applies to the other ~42
harvested dialects, which have no real `Dialect` subclass yet and would need one invented
(the thing that restriction was written to prevent).

### `parse(sql, options?)`

```ts
function parse(sql: string, options?: {
  read?: string;    // dialect to parse under, e.g. "snowflake" (default: base dialect)
  dialect?: string;  // alias for `read`
}): (Expr | null)[]
```

Parses `sql` (which may contain multiple `;`-separated statements) and returns one expression
tree per statement, in order. A statement that fails to parse under `errorLevel: "ignore"`
comes back as `null` in its slot rather than throwing.

> **The real equivalent works today** for four dialects: `Dialect.get_or_raise(read).parse(sql)`
> (`src/dialects/dialect.js`) does exactly this, already returning an array. `read` must be
> one of `"snowflake"`, `"duckdb"`, `"postgres"`, `"hive"`, `"spark2"`, `"spark"`,
> `"databricks"`, or omitted for the default dialect — after importing the matching
> `src/dialects/<name>.js` for its registration side effect.

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
SQL fragment as a specific node type — `parseOne("a + 1", { into: Column })` — rather than a
full `SELECT`.

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
is the round-trip entry point — `parse` + `.sql({ dialect })` per statement.

> **The underlying round-trip works today** for the four dialects with a real `Generator`
> (Databricks chain, Snowflake, DuckDB — partial, see PORT_PLAN.md R32 — and Postgres):
> `Dialect.get_or_raise(write).generate(Dialect.get_or_raise(read).parse(sql)[0])` does what
> `transpile` will do, for one statement. E.g. parsing `` SELECT `id` FROM t `` under
> `"databricks"` and generating under `"postgres"` produces `SELECT "id" FROM t` — a real
> cross-dialect identifier-quoting difference, not just round-tripping the input back out.

### `tokenize(sql, options?)`

```ts
function tokenize(sql: string, options?: {
  read?: string;
  dialect?: string;
}): Token[]
```

Returns the raw token stream without building a tree. **This one is closer to real** — the
`Tokenizer`/`TokenizerCore` machinery underneath is fully ported and byte-exact-tested against
CPython over 23,457 streams (P1), and `Dialect.get_or_raise(read).tokenize(sql)` is a real,
working dialect-by-name entry point for the four dialects with a real `Dialect` class; only
the top-level convenience wrapper name is missing. Note the field is `token.token_type`
(a number, the `TokenType` enum value) on the real `Token` class today, not the camelCase
`tokenType` this target signature might suggest — `src/tokens.js`'s `Token` keeps upstream's
own snake_case field name unchanged rather than converting it.

## The `exp` namespace

**Real today**, imported directly from the module rather than a package
(`src/expressions/index.js`) until a package exists. Every SQL construct is a class —
`Select`, `Column`, `Where`, `Literal`, `Join`, and more — 1,048 total, generated from
upstream's own class metadata (argument types, required args, traits) and checked against
5,240 assertions plus a full corpus AST round-trip (`astDump(astLoad(row.ast))` deep-equals
the original for every one of 15,540 harvested rows).

### Constructing nodes

Two ways to build a tree, matching upstream:

```js
import * as exp from "sqlglot-js"; // eventually; today: "./src/expressions/index.js"

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
  internally for CTE/subquery deduplication in the (not yet ported) optimizer.
- **`.eq(x)`, `.neq(x)`, `.and_(x)`, `.or_(x)`**, and the rest of the comparison/boolean
  builder methods for fluently composing conditions on an existing node.
- **`.sql(options?)`** — **real today**, through the default dialect, as soon as any dialect
  module has been imported for its registration side effect (`import
  "./src/dialects/dialect.js"` alone is enough — it wires the base `Generator`). Still only
  throws `"No SQL generator registered"` if called before that import happens at all. What's
  still target design here is the `options.dialect` string shorthand shown in the signature
  above — the equivalent real call today is `Dialect.get_or_raise(name).generate(expr)`
  rather than `expr.sql({ dialect: name })`, since the option-string-to-`Dialect` lookup is
  itself the top-level wrapper this whole page is written ahead of.

### Errors

Real today (`src/errors.js`), matching upstream's exception hierarchy:

```js
import { ParseError, TokenError, UnsupportedError, ErrorLevel } from "sqlglot-js";

try {
  parseOne("SELECT FROM"); // target example — parseOne itself isn't wired yet
} catch (e) {
  if (e instanceof ParseError) console.log(e.errors); // structured, not just a message
}
```

`ErrorLevel` (`"ignore" | "warn" | "raise" | "immediate"`) controls whether a parse defect
throws immediately, accumulates and throws at the end, or is swallowed — same four levels as
upstream, same default (`raise`).

## Not yet designed / documented here

- **`Schema` / `MappingSchema`** — column-type-aware parsing and the optimizer's `qualify`
  pass depend on these; no target doc yet, no code yet (`src/schema.js` doesn't exist).
- **`diff`** — structural AST diffing; same status, no target doc yet.
- **Dialect selection by name, at THIS package layer** — every example above that takes
  `read`/`write` as a bare string like `"snowflake"` is still describing the *intended*
  top-level interface, which doesn't exist as a package yet. The underlying mechanism it
  will wrap, however, is real: `Dialect.get_or_raise(name)` (`src/dialects/dialect.js`) is a
  genuine runtime string-to-class registry today, for four names (`snowflake`, `duckdb`,
  `postgres`, `hive`/`spark2`/`spark`/`databricks`). `CONTRACTS.md` §8's restriction was
  about resolving a dialect string *before* any real `Dialect.get_or_raise` existed — the
  test harness's own `dialectClassFor` (`spike/p3/dialect_tokenizer.mjs`) now checks that
  registry first and only falls back to its old compile-time-import shortcut for dialects
  that still have no real `Dialect` subclass (~42 of the 46 harvested ones).
- **Every dialect beyond the four above** — no real `Parser`, `Dialect`, or `Generator`;
  `Dialect.get_or_raise("bigquery")` (for example) still throws `Unknown dialect`.

See `PORT_PLAN.md` for the phase (P4, P5, ...) each of these lands in, and the real, current,
measured status of everything on this page.
