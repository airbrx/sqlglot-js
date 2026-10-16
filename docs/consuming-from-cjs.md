# Consuming from a CommonJS project

sqlglot-js is ESM-only (`package.json` has `"type": "module"`, and `index.js` uses
`import`/`export`). A CommonJS project — no `"type": "module"`, `require()` rather than
`import` — cannot `require("sqlglot-js")` directly; Node throws `ERR_REQUIRE_ESM`.

It **can** load it with dynamic `import()`, which returns a Promise even from a plain
`.js`/`.cjs` CommonJS file. The catch: dynamic `import()` is async, and a CJS file has no
top-level `await` (that's an ESM-only feature), so the import has to happen inside an
`async` function — typically once, during startup, with the resolved module cached for
any synchronous code paths that need it afterward.

```js
// bootstrap.cjs — a CommonJS file (no "type": "module" in package.json)
let sqlglotPromise;

function getSqlglot() {
  if (!sqlglotPromise) {
    sqlglotPromise = import("sqlglot-js");
  }
  return sqlglotPromise;
}

async function main() {
  const { parseOne } = await getSqlglot();
  const ast = parseOne("SELECT 1", { read: "snowflake" });
  console.log(ast.constructor.name, ast.sql()); // "Select SELECT 1"
}

main();
```

Call `getSqlglot()` again on a later request/tick and it returns the same cached Promise
— the `import()` itself only runs once. If the surrounding code path is otherwise
synchronous (e.g. a request handler that can't itself be made `async` all the way up),
do the `await getSqlglot()` once during an async startup/bootstrap step, keep the
resolved module (not just the promise) in a module-level variable, and read from that
variable everywhere else instead of importing per call.

```js
// bootstrap.cjs
let sqlglot;

async function bootstrap() {
  sqlglot = await import("sqlglot-js");
}

function parseSql(sql, opts) {
  // synchronous call site — no async/await needed here once bootstrap() has resolved
  return sqlglot.parseOne(sql, opts);
}

module.exports = { bootstrap, parseSql };
```

**Correction (AIR-2297 docs round):** this page previously claimed the pattern above "is
verified against a real `.cjs` file in this repo" — no such file exists, or ever has (checked
against the full git history). The pattern was spot-checked for this docs round by running
both snippets above as scratch `.cjs` files against this repo's `index.js` via a relative
import path, and both produced exactly the output shown. There's no npm-published package yet,
so a real `.cjs` consumer resolves `sqlglot-js` to a relative or git-dependency path rather
than through `node_modules` the normal way; once installed as a git dependency — see the root
[README](../README.md) — `import("sqlglot-js")` resolves the normal way.
