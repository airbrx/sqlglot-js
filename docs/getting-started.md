# Getting started

> **Status:** this page describes the target public API — written ahead of the top-level
> package wrapper. `import { parseOne } from "sqlglot-js"` does not work yet: there is no
> package, no `index.js`, no dialect-by-name string lookup at this layer. But the machinery
> underneath — a real `Dialect` class parsing AND generating SQL, for four dialects
> (Databricks chain, Snowflake, DuckDB, Postgres) — **works today**, from a repo checkout,
> via `Dialect.get_or_raise(name)` rather than the string-based wrapper shown below. See the
> callouts throughout this page for exactly what that looks like. Check `PORT_PLAN.md` for
> the current, measured status of every dialect and every phase.

## Install

```sh
npm install sqlglot-js
```

## Parse a query

```js
import { parseOne } from "sqlglot-js";

const ast = parseOne("SELECT id, name FROM users WHERE active = TRUE", {
  read: "snowflake",
});

console.log(ast.constructor.name); // "Select"
```

> **This works today**, via the real entry point rather than the string-wrapper shown above:
> `Dialect.get_or_raise("snowflake").parse(sql)` returns an array of statements (see `parse`
> below); take the first element for the `parseOne` behavior. Try it from the repo root:
> `node -e 'import("./src/dialects/dialect.js").then(async ({Dialect}) => { await
> import("./src/dialects/snowflake.js"); console.log(Dialect.get_or_raise("snowflake")
> .parse("SELECT id, name FROM users WHERE active = TRUE")[0].constructor.name); })'` prints
> `Select`. Four dialects have a real class today: `snowflake`, `duckdb`, `postgres`, and the
> Databricks chain (`hive`, `spark2`, `spark`, `databricks`) — import the matching
> `src/dialects/<name>.js` file for its side effect before calling `get_or_raise`.

`parseOne` mirrors upstream sqlglot's `parse_one`: it parses the SQL string under the given
`read` dialect and returns a single expression tree — the root of the parsed statement, not a
string. Omit `read` to use the default (ANSI-ish) dialect. Pass an array of SQL statements
(semicolon-separated) and get one tree per statement back from `parse` instead:

```js
import { parse } from "sqlglot-js";

const [first, second] = parse("SELECT 1; SELECT 2;");
```

## Inspect the AST

Every parsed expression is a tree of typed nodes — `Select`, `Column`, `Where`, `Literal`, and
so on, one class per SQL construct (1,048 of them, generated from upstream's own class
hierarchy). Walk it, query it, or just look at one field:

```js
console.log(ast.args.expressions.map((e) => e.sql())); // ["id", "name"]
console.log(ast.args.from_.this.this.this);             // "users"

for (const node of ast.walk()) {
  console.log(node.constructor.name);
}
```

## Build a query programmatically

The same expression classes are constructible directly, without going through SQL text at
all — the `exp` namespace exposes the builder functions upstream does (`select`, `column`,
`and_`, `cast`, ...), following the same naming convention: a name that collides with a JS
reserved word gets a trailing underscore (`from_`, `case_`, `delete_`), everything else keeps
its name.

> **This part works today, including `.sql()`.** `import * as exp from "sqlglot-js"` isn't
> wired up as a package yet, but the underlying module (`src/expressions/index.js`) is real
> and checked against 5,240 metadata assertions plus a full corpus AST round-trip — and as of
> the base `Generator` and per-dialect `Generator`s landing, `.sql()` on a builder-constructed
> tree really works too, through the default dialect as soon as any dialect module has been
> imported for its side effect (see below), or through a specific dialect via `.sql({
> dialect })`-style options once that option is wired at this package layer. Try it from the
> repo root: `node -e 'import("./src/dialects/dialect.js").then(async () => { const exp =
> await import("./src/expressions/index.js"); console.log(exp.select("id",
> "name").from_("users").where(exp.column("active").eq(true)).sql()); })'` prints `SELECT id,
> name FROM users WHERE active = TRUE`.

```js
import * as exp from "sqlglot-js";

const query = exp
  .select("id", "name")
  .from_("users")
  .where(exp.column("active").eq(true));

console.log(query.sql()); // "SELECT id, name FROM users WHERE active = TRUE" — real today
```

## Transpile between dialects

```js
import { transpile } from "sqlglot-js";

const [sql] = transpile("SELECT `id` FROM t", {
  read: "databricks",
  write: "postgres",
});

console.log(sql); // 'SELECT "id" FROM t'
```

`transpile` parses under `read` and generates under `write` in one call — it's `parse` +
`.sql({ dialect: write })` per statement, returned as an array of strings (one per parsed
statement, same shape as `parse`'s return). Passing only `read` transpiles identity-style: SQL
back out in the same dialect it went in, useful as a normalizer/formatter even without a
target dialect.

> **The underlying mechanism works today** for the four dialects with a real `Dialect` class
> (Databricks chain, Snowflake, DuckDB, Postgres) — `transpile` itself is still the target
> top-level wrapper, but calling the two `Dialect` methods directly does the same thing. Try
> it: `node -e 'import("./src/dialects/dialect.js").then(async ({Dialect}) => { await
> import("./src/dialects/databricks.js"); await import("./src/dialects/postgres.js"); const
> [ast] = Dialect.get_or_raise("databricks").parse("SELECT \`id\` FROM t");
> console.log(Dialect.get_or_raise("postgres").generate(ast)); })'` prints `SELECT "id" FROM
> t` — Databricks' backtick-quoted identifier becomes Postgres' double-quoted one, a real
> cross-dialect difference, not just round-tripping the same string back out.

## Tokenize without parsing

For the rare case where you want the raw token stream rather than a tree (e.g. building your
own lightweight linter):

```js
import { tokenize } from "sqlglot-js";

for (const token of tokenize("SELECT 1", { read: "snowflake" })) {
  console.log(token.token_type, token.text);
}
```

> **The underlying `Dialect.get_or_raise(read).tokenize(sql)` works today** for the four real
> dialects — same real-vs-target split as everywhere else on this page. Note the real
> `Token` class (`src/tokens.js`) uses `token.token_type` (snake_case, a `TokenType` enum
> number), not a camelCased `tokenType` — see [api.md](api.md) for why.

## What's next

- [`api.md`](api.md) — the full reference for every function and class shown above, plus the
  ones this page didn't cover (`Schema`, `diff`, error handling, pretty-printing).
- `PORT_PLAN.md` — the real, current, measured status of every piece described here.
