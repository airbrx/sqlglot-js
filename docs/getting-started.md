# Getting started

> **Status:** this page describes the target public API — written ahead of the
> implementation, like a test written before the code it tests. `import { parseOne } from
> "sqlglot-js"` does not work yet: there is no package, no `index.js`, and no `Generator`
> (`.sql()` output) until P4 lands. Building an AST with the `exp` builders, on the other
> hand, **works today** — see the callout partway down. Check `PORT_PLAN.md` for exactly
> what phase is current.

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

> **This part works today.** `import * as exp from "sqlglot-js"` isn't wired up as a package
> yet, but the underlying module (`src/expressions/index.js`) is real and checked against
> 5,240 metadata assertions plus a full corpus AST round-trip. Try it: `node -e`
> `'import("./src/expressions/index.js").then(exp => console.log(exp.select("id").from_("t")` `.constructor.name))'`
> from the repo root prints `Select`. The one thing that doesn't work yet is turning that
> tree back into a SQL string — `.sql()` throws `"No SQL generator registered (available in
> P4)"` until the generator lands.

```js
import * as exp from "sqlglot-js";

const query = exp
  .select("id", "name")
  .from_("users")
  .where(exp.column("active").eq(true));

console.log(query.sql()); // target: "SELECT id, name FROM users WHERE active = TRUE"
```

## Transpile between dialects

```js
import { transpile } from "sqlglot-js";

const [sql] = transpile("SELECT TOP 10 * FROM t", {
  read: "tsql",
  write: "postgres",
});

console.log(sql); // "SELECT * FROM t LIMIT 10"
```

`transpile` parses under `read` and generates under `write` in one call — it's `parse` +
`.sql({ dialect: write })` per statement, returned as an array of strings (one per parsed
statement, same shape as `parse`'s return). Passing only `read` transpiles identity-style: SQL
back out in the same dialect it went in, useful as a normalizer/formatter even without a
target dialect.

## Tokenize without parsing

For the rare case where you want the raw token stream rather than a tree (e.g. building your
own lightweight linter):

```js
import { tokenize } from "sqlglot-js";

for (const token of tokenize("SELECT 1", { read: "snowflake" })) {
  console.log(token.tokenType, token.text);
}
```

## What's next

- [`api.md`](api.md) — the full reference for every function and class shown above, plus the
  ones this page didn't cover (`Schema`, `diff`, error handling, pretty-printing).
- `PORT_PLAN.md` — the real, current, measured status of every piece described here.
