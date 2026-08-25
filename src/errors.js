// py: sqlglot/errors.py @ 91119bc — plus the port's own NotPorted contract.

import { PyValueError } from "./_py/errors.js";

/**
 * CONTRACTS.md §6 — the stub sentinel.
 *
 * `tools/seed_static.py` emits one of these per unported method, in upstream source
 * order. One task replaces exactly one stub, so two agents produce non-adjacent hunks
 * that git merges cleanly (§8.1 Rule 2), and `grep -c NotPorted src/parser.js` is a
 * free burndown.
 */
export class NotPorted extends Error {
  /**
   * @param {string} method   the method name, e.g. "_parse_bitwise"
   * @param {string} pyAnchor upstream anchor, e.g. "sqlglot/parser.py:6302"
   */
  constructor(method, pyAnchor) {
    super(`${method} is not ported yet (${pyAnchor})`);
    this.name = "NotPorted";
    this.method = method;
    this.pyAnchor = pyAnchor;
  }
}

// py: errors.SqlglotError
export class SqlglotError extends Error {
  constructor(message) {
    super(message);
    this.name = new.target.name;
  }
}

// py: errors.UnsupportedError
export class UnsupportedError extends SqlglotError {}

// py: errors.ParseError
export class ParseError extends SqlglotError {
  constructor(message, errors = []) {
    super(message);
    this.errors = errors;
  }
}

// py: errors.TokenError
export class TokenError extends SqlglotError {}

// py: errors.OptimizeError
export class OptimizeError extends SqlglotError {}

// py: errors.SchemaError
export class SchemaError extends SqlglotError {}

// py: errors.ExecuteError
export class ExecuteError extends SqlglotError {}

/**
 * §4.7 item 2 — a structured, catchable error raised BEFORE V8's RangeError.
 *
 * This restores Python's contract (a typed exception at a known threshold) instead of
 * an engine artifact at an unknown one. The threshold is measured by `fuzz_depth`, not
 * assumed, and is configurable — the closest honest analogue to `sys.setrecursionlimit`,
 * since `--stack-size` is rejected (unavailable in browsers, and raising it past the OS
 * thread stack turns a clean RangeError into a segfault).
 */
export class DepthLimitError extends SqlglotError {
  constructor(depth, limit, path) {
    super(`maximum ${path} depth exceeded: ${depth} > ${limit}`);
    this.depth = depth;
    this.limit = limit;
    this.path = path;
  }
}

// Measured by spike/fuzz_depth.mjs on Node v22.12.0 (CONTRACTS.md §9.1): the realistic
// generator frame overflows at 3,350; 0.6x leaves margin for the live stack at entry.
export const DEFAULT_DEPTH_LIMIT = 2010;

export { PyValueError };
