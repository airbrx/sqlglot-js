// sqlglot-js — top-level package entry point.
// py: sqlglot/__init__.py @ 91119bc
//
// This is the first public wrapper around the real, differentially-tested machinery
// that already lives under src/: `Dialect.get_or_raise(name)` (src/dialects/dialect.js)
// is the actual dialect-by-name registry; the functions below just give it the
// upstream-shaped names and defaults docs/api.md and docs/getting-started.md describe.
//
// Dialect registration is eager and static, not dynamic `import()` keyed on a runtime
// string: `Dialect.get_or_raise` is synchronous (it's called from `Tokenizer`'s
// constructor, which cannot await — see dialect.js's own note on this), so every
// dialect with a real class today is imported here, once, for its registration side
// effect. Anything else stays what it is upstream: `Dialect.get_or_raise("bigquery")`
// throws "Unknown dialect".
import "./src/dialects/hive.js";
import "./src/dialects/spark2.js";
import "./src/dialects/spark.js";
import "./src/dialects/databricks.js";
import "./src/dialects/snowflake.js";
import "./src/dialects/duckdb.js";
import "./src/dialects/postgres.js";
// `redshift.js` (PORT_PLAN.md R38) and `tsql.js` (PORT_PLAN.md, TSQL dialect+generator
// round) both landed with real classes before this file was updated for them — the
// same "wire it here or the public entry point never sees it" gap this header already
// warns about, just missed for both at merge time. Found while verifying TSQL's own
// wiring end to end through `contrib/gatewaySqlMetadata.js`, which imports `Dialect`
// from this file, not from `src/dialects/dialect.js` directly.
import "./src/dialects/redshift.js";
import "./src/dialects/tsql.js";

import { Dialect, parseOne } from "./src/dialects/dialect.js";
import { ErrorLevel, ParseError, TokenError, UnsupportedError } from "./src/errors.js";
import * as exp from "./src/expressions/index.js";

export { Dialect, ErrorLevel, ParseError, TokenError, UnsupportedError, exp, parseOne };

/**
 * py: sqlglot/__init__.py:83 `tokenize`.
 *
 * @param {string} sql
 * @param {{read?: string|null, dialect?: string|null}} [opts]
 * @returns {import("./src/tokens.js").Token[]}
 */
export function tokenize(sql, opts = {}) {
  const { read = null, dialect = null } = opts;
  // py: `read or dialect` — `dialect` is documented as an alias for `read`.
  return Dialect.get_or_raise(read || dialect).tokenize(sql);
}

/**
 * py: sqlglot/__init__.py:90 `parse`.
 *
 * @param {string} sql
 * @param {{read?: string|null, dialect?: string|null, errorLevel?: string|null}} [opts]
 * @returns {Array<import("./src/expressions/core.js").Expr|null>}
 */
export function parse(sql, opts = {}) {
  const { read = null, dialect = null, ...rest } = opts;
  return Dialect.get_or_raise(read || dialect).parse(sql, rest);
}

/**
 * py: sqlglot/__init__.py:168 `transpile`.
 *
 * Parses under `read` and generates under `write`, one output string per input
 * statement. A `null` slot from `parse` (e.g. an empty statement between two `;;`)
 * generates as `""`, matching upstream's `write.generate(...) if expression else ""`.
 *
 * @param {string} sql
 * @param {{read?: string|null, write?: string|null, identity?: boolean,
 *          errorLevel?: string|null}} [opts]
 * @returns {string[]}
 */
export function transpile(sql, opts = {}) {
  const { read = null, write = null, identity = true, errorLevel = null, ...rest } = opts;
  // py: `write = (read if write is None else write) if identity else write`
  const target = identity ? (write === null || write === undefined ? read : write) : write;
  const writeDialect = Dialect.get_or_raise(target);

  return parse(sql, { read, errorLevel }).map((expression) =>
    expression ? writeDialect.generate(expression, { copy: false, ...rest }) : "",
  );
}
