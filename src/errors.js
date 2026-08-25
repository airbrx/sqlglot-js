// py: sqlglot/errors.py @ 91119bc — plus the port's own NotPorted contract.

import { PyValueError } from "./_py/errors.js";
import { pySortedBy } from "./_py/sort.js";

// py: errors.py:10-12
export const ANSI_UNDERLINE = "\u001b[4m";
export const ANSI_RESET = "\u001b[0m";
export const ERROR_MESSAGE_CONTEXT_DEFAULT = 100;

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

/**
 * py: errors.TokenError
 *
 * `start` and `end`, when set, are CODE-POINT offsets into the source SQL delimiting
 * the context snippet quoted in the message — i.e. the snippet is `sql[start:end]`
 * sliced by code point, never by UTF-16 unit (§4.6 "Indexing", CONTRACTS.md §2).
 */
export class TokenError extends SqlglotError {
  constructor(message, start = null, end = null) {
    super(message);
    this.start = start;
    this.end = end;
  }
}

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

/**
 * py: errors.highlight_sql(sql, positions, context_length=100)
 *
 * All indexing is by CODE POINT, per §4.6's indexing contract: `errors.js` and
 * `parser.js` slice the code-point array, never the JS string, so error columns and
 * highlight ranges stay correct under astral characters. Python's `sql[a:b]` is a
 * code-point slice; `String.prototype.slice` is a UTF-16 slice and would cut a
 * surrogate pair in half.
 *
 * @param {string} sql
 * @param {Array<[number, number]>} positions inclusive 0-based (start, end) pairs
 * @param {number} [contextLength]
 * @returns {[string, string, string, string]} [formatted, startCtx, highlight, endCtx]
 */
export function highlightSql(sql, positions, contextLength = ERROR_MESSAGE_CONTEXT_DEFAULT) {
  if (!positions || positions.length === 0) {
    throw new PyValueError("positions must contain at least one (start, end) tuple");
  }

  const cps = [...sql];
  const slice = (a, b) => cps.slice(a, b).join("");

  let startContext = "";
  let endContext = "";
  let firstHighlightStart = 0;
  const formattedParts = [];
  let previousPartEnd = 0;

  // py: sorted(positions, key=lambda pos: pos[0]) — stable, so equal starts keep
  // their original relative order.
  const sortedPositions = pySortedBy(positions, (pos) => pos[0]);

  if (sortedPositions[0][0] > 0) {
    firstHighlightStart = sortedPositions[0][0];
    startContext = slice(Math.max(0, firstHighlightStart - contextLength), firstHighlightStart);
    formattedParts.push(startContext);
    previousPartEnd = firstHighlightStart;
  }

  for (const [start, end] of sortedPositions) {
    const highlightStart = Math.max(start, previousPartEnd);
    const highlightEnd = end + 1;

    if (highlightStart >= highlightEnd) continue; // skip invalid or overlapping
    if (highlightStart > previousPartEnd) {
      formattedParts.push(slice(previousPartEnd, highlightStart));
    }
    formattedParts.push(`${ANSI_UNDERLINE}${slice(highlightStart, highlightEnd)}${ANSI_RESET}`);
    previousPartEnd = highlightEnd;
  }

  if (previousPartEnd < cps.length) {
    endContext = slice(previousPartEnd, previousPartEnd + contextLength);
    formattedParts.push(endContext);
  }

  const formattedSql = formattedParts.join("");
  const highlight = slice(firstHighlightStart, previousPartEnd);

  return [formattedSql, startContext, highlight, endContext];
}

/** py: errors.concat_messages(errors, maximum) */
export function concatMessages(errors, maximum) {
  const msg = errors.slice(0, maximum).map((e) => String(e));
  const remaining = errors.length - maximum;
  if (remaining > 0) msg.push(`... and ${remaining} more`);
  return msg.join("\n\n");
}

/** py: errors.merge_errors(errors) */
export function mergeErrors(errors) {
  return errors.flatMap((error) => error.errors ?? []);
}

export { PyValueError };
