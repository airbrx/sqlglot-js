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

import { Dialect, parseOne } from "./src/dialects/dialect.js";
import { ErrorLevel, ParseError, TokenError, UnsupportedError } from "./src/errors.js";
import * as exp from "./src/expressions/index.js";
// py: sqlglot/__init__.py:54 `from sqlglot.schema import MappingSchema as MappingSchema,
// Schema as Schema` -- upstream's top-level package re-exports exactly these two names
// (not the module's other helpers, e.g. `ensure_schema`/`normalize_name`), so this
// mirrors that surface rather than the whole of src/schema.js.
import { Schema, MappingSchema } from "./src/schema.js";

export { Dialect, ErrorLevel, ParseError, TokenError, UnsupportedError, exp, parseOne, Schema, MappingSchema };

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
