# API reference

> **Status:** target design for the public surface, written ahead of implementation. Each
> section says what's real today. Function names and option shapes mirror upstream sqlglot's
> own `sqlglot/__init__.py` as closely as JS naming allows: a name that collides with a JS
> reserved word gets a trailing underscore (`from_`, `case_`), a multi-word `snake_case` name
> becomes `camelCase` (`parse_one` → `parseOne`, `to_identifier` → `toIdentifier`), everything
> else keeps its Python name unchanged. This is the same convention already used throughout
> `src/expressions/`, not a new one invented for this page.

## Top-level functions

**Target design — not implemented as a package yet.** The underlying parse machinery is real
and differentially tested (`PORT_PLAN.md` P3, currently 9,888/15,478 corpus rows exact); what
doesn't exist is the public wrapper below and dialect selection by name (`CONTRACTS.md` §8
forbids resolving a dialect string to a class until P5's `Dialect` registry lands).

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
is the round-trip entry point — `parse` + `.sql({ dialect })` per statement — and needs
`Generator` (P4) before it can do anything.

### `tokenize(sql, options?)`

```ts
function tokenize(sql: string, options?: {
  read?: string;
  dialect?: string;
}): Token[]
```

Returns the raw token stream without building a tree. **This one is closer to real** — the
`Tokenizer`/`TokenizerCore` machinery underneath is fully ported and byte-exact-tested against
CPython over 23,457 streams (P1); only the top-level convenience wrapper and dialect-by-name
selection are missing.

## The `exp` namespace

**Real today**, imported directly from the module rather than a package
(`src/expressions/index.js`) until a package exists. Every SQL construct is a class —
`Select`, `Column`, `Where`, `Literal`, `Join`, and 1,044 more, generated from upstream's own
class metadata (argument types, required args, traits) and checked against 5,240 assertions
plus a full corpus AST round-trip (`astDump(astLoad(row.ast))` deep-equals the original for
every one of 15,540 harvested rows).

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
- **`.sql(options?)`** — **not real yet.** Throws `"No SQL generator registered (available in
  P4)"`. Every other method above works without it.

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
- **Dialect selection by name** — until P5, every example above that takes `read`/`write` as a
  bare string like `"snowflake"` is describing the *intended* interface; today the equivalent
  internal mechanism (`spike/p3/dialect_tokenizer.mjs`'s `parserClassFor`) selects a `Parser`
  subclass by a literal, compile-time import — not a runtime string lookup — specifically
  because `CONTRACTS.md` §8 forbids the latter before a real `Dialect.get_or_raise` exists.

See `PORT_PLAN.md` for the phase (P4, P5, ...) each of these lands in, and the real, current,
measured status of everything on this page.
