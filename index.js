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
// effect. Anything else stays what it is upstream: `Dialect.get_or_raise("clickhouse")`
// throws "Unknown dialect". This list must be updated every time a new dialect's real
// `Dialect` settings class lands — it is NOT auto-discovered from `src/dialects/`, so a
// dialect can be fully real (parser + settings + generator, verified against the real
// per-dialect oracles) and still be unreachable from this package's own top-level
// entry point if this list isn't updated in the same round. Found stale 2026-09-15:
// `redshift.js` (merged PR #56) and `bigquery.js`/`tsql.js` (landing alongside this
// fix) were all missing here despite being fully real.
import "./src/dialects/hive.js";
import "./src/dialects/spark2.js";
import "./src/dialects/spark.js";
import "./src/dialects/databricks.js";
import "./src/dialects/snowflake.js";
import "./src/dialects/duckdb.js";
import "./src/dialects/postgres.js";
import "./src/dialects/redshift.js";
import "./src/dialects/bigquery.js";
import "./src/dialects/tsql.js";

import { Dialect, parseOne } from "./src/dialects/dialect.js";
import { ErrorLevel, ParseError, TokenError, UnsupportedError } from "./src/errors.js";
import * as exp from "./src/expressions/index.js";
// py: sqlglot/__init__.py:54 `from sqlglot.schema import MappingSchema as MappingSchema,
// Schema as Schema` -- upstream's top-level package re-exports exactly these two names
// (not the module's other helpers, e.g. `ensure_schema`/`normalize_name`), so this
// mirrors that surface rather than the whole of src/schema.js.
import { Schema, MappingSchema } from "./src/schema.js";
// py: sqlglot/__init__.py:56 `from sqlglot.optimizer import optimize as optimize`
// (the package's own `optimizer/__init__.py` re-exports `optimize` from
// `optimizer.py`; `RULES` is not re-exported at upstream's package root, but is
// re-exported here anyway — see this file's own export line below for why).
import { optimize, RULES } from "./src/optimizer/optimizer.js";
// py: sqlglot/lineage.py @ 91119bc — upstream itself does NOT re-export `lineage`/
// `Node` from `sqlglot/__init__.py` (callers reach it as `from sqlglot.lineage import
// lineage` there); re-exported here anyway for the same reason `RULES` is just above:
// this port has no npm-published subpath-import story yet, so the package root is the
// only public entry point a caller outside this repo has.
import { lineage, Node } from "./src/lineage.js";
// `anonymize`/`render` are NOT re-exported from upstream's own `sqlglot/__init__.py`
// (callers reach them as `sqlglot.anonymize.anonymize`/`.render` there) -- re-exported
// here anyway for the same reason `RULES` is (see this file's own note on it above):
// this port has no npm-published subpath-import story yet, so the package root is the
// only import path a caller has.
import { anonymize, render } from "./src/anonymize.js";

export { Dialect, ErrorLevel, ParseError, TokenError, UnsupportedError, exp, parseOne, Schema, MappingSchema };
// `optimize` matches upstream's own root re-export name exactly (no snake_case to
// convert — it's already a single lowercase word). `RULES` is NOT part of upstream's
// `sqlglot/__init__.py` surface (callers reach it as `sqlglot.optimizer.optimizer.RULES`
// there), but is re-exported here anyway: it's the only way a caller can build a custom
// `rules` array for `optimize()`'s own `rules` option (e.g. `RULES.filter(...)`) without
// a second import path into `src/optimizer/`, and this port has no npm-published
// subpath-import story yet (see docs/api.md's Schema section on the same limitation for
// `ensureSchema` et al.).
export { optimize, RULES };
export { lineage, Node };
export { anonymize, render };

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
