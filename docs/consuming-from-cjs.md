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

This pattern is verified against a real `.cjs` file in this repo (there's no npm-published
package yet, so the example above resolves `sqlglot-js` to a relative path during
verification; once installed as a git dependency — see the root [README](../README.md) —
`import("sqlglot-js")` resolves the normal way through `node_modules`).
