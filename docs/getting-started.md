# Getting started

> **Status:** the top-level package wrapper described on this page is real —
> `import { parseOne } from "sqlglot-js"` works, backed by the same `Dialect.get_or_raise(name)`
> registry (`src/dialects/dialect.js`) this page used to describe as the only working entry
> point. Not published to any registry yet: install it as a git dependency
> (`github:airbrx/sqlglot-js#main`), or import `./index.js` directly from a repo checkout. Seven
> dialect names resolve to a real `Dialect` class today — `snowflake`, `duckdb`, `postgres`,
> and the Databricks chain (`hive`, `spark2`, `spark`, `databricks`) — everything else still
> throws `Unknown dialect`. Check `PORT_PLAN.md` for the current, measured status of every
> dialect and every phase.

## Install

```sh
npm install github:airbrx/sqlglot-js#main
```

Or, from a checkout of this repo, import `./index.js` directly (see the root
[README](../README.md) for that form).

## Parse a query

```js
import { parseOne } from "sqlglot-js";

const ast = parseOne("SELECT id, name FROM users WHERE active = TRUE", {
  read: "snowflake",
});

console.log(ast.constructor.name); // "Select"
```

**This works today.** Try it from the repo root: `node -e 'import("./index.js").then(({
parseOne }) => { console.log(parseOne("SELECT id, name FROM users WHERE active = TRUE", {
read: "snowflake" }).constructor.name); })'` prints `Select`. Seven dialect names have a real
class today: `snowflake`, `duckdb`, `postgres`, and the Databricks chain (`hive`, `spark2`,
`spark`, `databricks`) — `index.js` imports all seven eagerly for their registration side
effect, so no separate import is needed to use any of them by name.

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

> **This part works today, including `.sql()`.** `import * as exp from "sqlglot-js"` is real
> (the underlying module, `src/expressions/index.js`, is checked against 5,240 metadata
> assertions plus a full corpus AST round-trip). `.sql()` on a builder-constructed tree
> generates through the default dialect as soon as any dialect module has been imported for
> its side effect — `index.js` does that eagerly for seven dialects — or through a specific
> dialect by passing its name as the first argument, `.sql("postgres")`, matching upstream's
> own `expr.sql(dialect="postgres")` shape. Try it from the repo root: `node -e
> 'import("./index.js").then(({ exp }) => { console.log(exp.select("id",
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
`.sql(write)` per statement, returned as an array of strings (one per parsed
statement, same shape as `parse`'s return). Passing only `read` transpiles identity-style: SQL
back out in the same dialect it went in, useful as a normalizer/formatter even without a
target dialect.

> **This works today** for the seven dialects with a real `Dialect` class (Databricks chain,
> Snowflake, DuckDB, Postgres). Try it: `node -e 'import("./index.js").then(({ transpile }) =>
> { console.log(transpile("SELECT \`id\` FROM t", { read: "databricks", write: "postgres"
> })[0]); })'` prints `SELECT "id" FROM t` — Databricks' backtick-quoted identifier becomes
> Postgres' double-quoted one, a real cross-dialect difference, not just round-tripping the
> same string back out.

## Tokenize without parsing

For the rare case where you want the raw token stream rather than a tree (e.g. building your
own lightweight linter):

```js
import { tokenize } from "sqlglot-js";

for (const token of tokenize("SELECT 1", { read: "snowflake" })) {
  console.log(token.token_type, token.text);
}
```

> **This works today** for the seven real dialects. Note the real `Token` class
> (`src/tokens.js`) uses `token.token_type` (snake_case, a `TokenType` enum number), not a
> camelCased `tokenType` — see [api.md](api.md) for why.

## What's next

- [`api.md`](api.md) — the full reference for every function and class shown above, plus the
  ones this page didn't cover (`Schema`, `diff`, error handling, pretty-printing).
- [`consuming-from-cjs.md`](consuming-from-cjs.md) — using this package from a CommonJS
  project via dynamic `import()`.
- `PORT_PLAN.md` — the real, current, measured status of every piece described here.
