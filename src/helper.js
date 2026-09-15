// py: sqlglot/helper.py @ 91119bc

import { getCloseMatches } from "./_py/difflib.js";
import { pyIntFromStr, pyFloatFromStr } from "./_py/num.js";
import { pySorted, pyCmp, pyTupleCmp } from "./_py/sort.js";
import { pyIsIsoDate, pyIsIsoDateTime } from "./_py/datetime.js";
import { PyValueError, PyStopIteration } from "./_py/errors.js";

// py: CAMEL_CASE_PATTERN = re.compile("(?<!^)(?=[A-Z])")
// `[A-Z]` is ASCII-only in Python too, so this does NOT split on 'Æ'; the
// subsequent .upper() is however full-Unicode.
const CAMEL_CASE_PATTERN = /(?<!^)(?=[A-Z])/g;

/**
 * py: helper.suggest_closest_match_and_fail
 * @throws {Error} always — mirrors Python's `raise ValueError`.
 */
export function suggestClosestMatchAndFail(kind, word, possibilities) {
  const closeMatches = getCloseMatches(word, [...possibilities], 1);

  let similar = seqGet(closeMatches, 0) || "";
  if (similar) {
    similar = ` Did you mean ${similar}?`;
  }

  throw new PyValueError(`Unknown ${kind} '${word}'.${similar}`);
}

/**
 * py: helper.seq_get(seq, index)
 *
 * Returns the value in `seq` at position `index`, or `undefined` if out of bounds.
 *
 * NOTE: Python supports NEGATIVE indices here and sqlglot relies on it —
 * `parsers/bigquery.py:516-517` calls `seq_get(table_parts, -3)` and `-4`.
 * A naive `seq[index]` port returns undefined for those and silently drops the
 * catalog/db parts of a qualified BigQuery table name.
 */
export function seqGet(seq, index) {
  const i = index < 0 ? seq.length + index : index;
  if (i < 0 || i >= seq.length) return undefined;
  return seq[i];
}

/**
 * py: helper.ensure_list(value)
 * Ensures that a value is a list, otherwise casts or wraps it into one.
 */
export function ensureList(value) {
  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  return [value];
}

/**
 * py: helper.ensure_collection(value)
 * Ensures that a value is a collection (excluding `str`), otherwise wraps it in a list.
 */
export function ensureCollection(value) {
  if (value === null || value === undefined) {
    return [];
  }
  return isCollection(value) && typeof value !== "string" ? value : [value];
}

function isCollection(value) {
  return (
    Array.isArray(value) ||
    value instanceof Set ||
    value instanceof Map ||
    (typeof value === "object" && value !== null && typeof value[Symbol.iterator] === "function")
  );
}

/**
 * py: helper.csv(*args, sep=", ")
 * Formats any number of string arguments as CSV, skipping falsy ones.
 */
export function csv(...args) {
  let sep = ", ";
  // Emulate the keyword-only `sep` argument: callers pass {sep} as a trailing object.
  if (args.length && typeof args[args.length - 1] === "object" && args[args.length - 1] !== null) {
    const opts = args.pop();
    if (opts.sep !== undefined) sep = opts.sep;
  }
  return args.filter((arg) => arg).join(sep);
}

/**
 * py: helper.subclasses(module_name, classes, exclude=set())
 *
 * DEVIATION, recorded in CONTRACTS.md: upstream introspects a live module with
 * `inspect.getmembers`, which has no JS equivalent. JS passes an explicit registry.
 * `inspect.getmembers` returns members sorted by NAME, and that order is observable
 * (it determines ALL_FUNCTIONS / EXPR_CLASSES ordering), so we sort by name here.
 *
 * @param {Iterable<Function>} registry all candidate classes
 * @param {Function|Function[]} classes base class(es)
 * @param {Set<Function>} [exclude]
 */
export function subclasses(registry, classes, exclude = new Set()) {
  const bases = Array.isArray(classes) ? classes : [classes];
  const out = [];
  for (const obj of registry) {
    if (exclude.has(obj)) continue;
    if (bases.some((base) => obj === base || obj.prototype instanceof base)) {
      out.push(obj);
    }
  }
  return out.sort((a, b) => pyCmp(a.name, b.name));
}

/** py: helper.camel_to_snake_case(name) */
export function camelToSnakeCase(name) {
  return name.replace(CAMEL_CASE_PATTERN, "_").toUpperCase();
}

/**
 * py: helper.while_changing(expression, func)
 * Applies a transformation until a fix point is reached.
 *
 * `hash` is Expression.__hash__ (PORT_PLAN.md §4.5, true 64-bit via two 32-bit
 * lanes). A 32-bit hash truncates and silently changes this fixpoint.
 */
export function whileChanging(expression, func, hash = (e) => e.hash()) {
  for (;;) {
    const startHash = hash(expression);
    expression = func(expression);
    const endHash = hash(expression);

    if (startHash === endHash) {
      break;
    }
  }

  return expression;
}

/**
 * py: helper.tsort(dag)
 * Sorts a directed acyclic graph in topological order.
 *
 * Faithfully MUTATES `dag`, as upstream does (it pops nodes and shrinks dep sets).
 * @param {Map<any, Set<any>>} dag
 */
export function tsort(dag) {
  const result = [];

  for (const [, deps] of [...dag.entries()]) {
    for (const dep of deps) {
      if (!dag.has(dep)) {
        dag.set(dep, new Set());
      }
    }
  }

  while (dag.size) {
    const current = new Set();
    for (const [node, deps] of dag) {
      if (!deps.size) current.add(node);
    }

    if (!current.size) {
      throw new PyValueError("Cycle error");
    }

    for (const node of current) {
      dag.delete(node);
    }

    for (const deps of dag.values()) {
      for (const c of current) deps.delete(c);
    }

    // py: result.extend(sorted(current)) — Python code-point order, not JS's
    // default UTF-16 code-unit order.
    result.push(...pySorted(current));
  }

  return result;
}

/** py: helper.find_new_name(taken, base) */
export function findNewName(taken, base) {
  const has = (x) => (taken instanceof Set || taken instanceof Map ? taken.has(x) : taken.includes(x));

  if (!has(base)) {
    return base;
  }

  let i = 2;
  let newName = `${base}_${i}`;
  while (has(newName)) {
    i += 1;
    newName = `${base}_${i}`;
  }

  return newName;
}

/** py: helper.is_int(text) */
export function isInt(text) {
  return pyIntFromStr(text) !== null;
}

/** py: helper.is_float(text) */
export function isFloat(text) {
  return pyFloatFromStr(text) !== null;
}

/**
 * py: helper.name_sequence(prefix)
 * Returns a name generator given a prefix (e.g. a0, a1, a2, ...).
 */
export function nameSequence(prefix) {
  let sequence = 0;
  return () => `${prefix}${sequence++}`;
}

/**
 * py: helper.split_num_words(value, sep, min_num_words, fill_from_start=True)
 *
 * NOTE `[None] * n` is `[]` for negative n in Python, whereas `new Array(-1)`
 * THROWS in JS — hence the Math.max(0, ...).
 */
export function splitNumWords(value, sep, minNumWords, fillFromStart = true) {
  // py: str.split('') raises ValueError('empty separator'); JS silently returns
  // the characters instead, which would quietly produce wrong table parts.
  if (sep === "") throw new PyValueError("empty separator");
  const words = value.split(sep);
  const pad = new Array(Math.max(0, minNumWords - words.length)).fill(null);
  if (fillFromStart) {
    return [...pad, ...words];
  }
  return [...words, ...pad];
}

/**
 * py: helper.is_iterable(value)
 * Checks if the value is an iterable, excluding `str` and `Expr`.
 *
 * `isExpr` is injected because helper.py does a late import of `expressions`
 * to dodge the circular dependency; JS has the same cycle.
 */
export function isIterable(value, isExpr = () => false) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return false;
  if (isExpr(value)) return false;
  return typeof value[Symbol.iterator] === "function";
}

/**
 * py: helper.flatten(values)
 * Flattens an iterable containing both iterable and non-iterable elements.
 */
export function* flatten(values, isExpr = () => false) {
  for (const value of values) {
    if (isIterable(value, isExpr)) {
      yield* flatten(value, isExpr);
    } else {
      yield value;
    }
  }
}

/**
 * py: helper.dict_depth(d)
 * Get the nesting depth of a dictionary.
 */
export function dictDepth(d) {
  // py: try: return 1 + dict_depth(next(iter(d.values())))
  //     except AttributeError: return 0   (not a dict)
  //     except StopIteration: return 1    (empty dict)
  const values = dictValues(d);
  if (values === null) return 0;
  const first = values.next();
  if (first.done) return 1;
  return 1 + dictDepth(first.value);
}

function dictValues(d) {
  if (d instanceof Map) return d.values();
  // py: `d.values()` only exists for an actual `dict` -- anything else (including a
  // class instance such as `exp.Expr`) raises AttributeError, caught above to mean
  // "not a dict" (depth 0). `typeof d === "object"` alone is true for EVERY object,
  // so it wrongly recursed into e.g. a DataType leaf value's own internal fields
  // (args/parent/comments/...) and reported a bogus inflated depth -- found via
  // `src/schema.js`'s `getColumnType`, whose column-mapping values are legitimately
  // `exp.DataType` instances, not strings. `constructor === Object` is this
  // codebase's established plain-dict test (expressions/core.js, builders.js).
  if (d !== null && typeof d === "object" && d.constructor === Object) {
    return Object.values(d)[Symbol.iterator]();
  }
  return null;
}

/** py: helper.first(it) — returns the first element from an iterable. */
export function first(it) {
  for (const i of it) return i;
  throw new PyStopIteration("first() on an empty iterable");
}

/**
 * py: helper.to_bool(value)
 * Coerces "true"/"1"/"false"/"0" (case-insensitive); returns the value unchanged
 * otherwise, so the return type really is `string | boolean | null`.
 */
export function toBool(value) {
  if (typeof value === "boolean" || value === null || value === undefined) {
    return value;
  }

  const valueLower = value.toLowerCase();
  if (valueLower === "true" || valueLower === "1") {
    return true;
  }
  if (valueLower === "false" || valueLower === "0") {
    return false;
  }

  return value;
}

/**
 * py: helper.merge_ranges(ranges)
 * Merges a sequence of (low, high) tuples.
 */
export function mergeRanges(ranges) {
  if (!ranges.length) {
    return [];
  }

  // py: sorted(ranges) — tuple comparison, not JS string coercion.
  ranges = [...ranges].sort(pyTupleCmp);

  const merged = [ranges[0]];

  for (const [start, end] of ranges.slice(1)) {
    const [lastStart, lastEnd] = merged[merged.length - 1];

    if (pyCmp(start, lastEnd) <= 0) {
      merged[merged.length - 1] = [lastStart, pyCmp(lastEnd, end) >= 0 ? lastEnd : end];
    } else {
      merged.push([start, end]);
    }
  }

  return merged;
}

/** py: helper.is_iso_date(text) */
export function isIsoDate(text) {
  return pyIsIsoDate(text);
}

/** py: helper.is_iso_datetime(text) */
export function isIsoDatetime(text) {
  return pyIsIsoDateTime(text);
}

// py: helper.DATE_UNITS — interval units that operate on date components
export const DATE_UNITS = new Set(["day", "week", "month", "quarter", "year", "year_month"]);

/** py: helper.is_date_unit(expression) */
export function isDateUnit(expression) {
  return (
    expression !== null && expression !== undefined && DATE_UNITS.has(expression.name.toLowerCase())
  );
}

/**
 * py: helper.SingleValuedMapping
 * Mapping where all keys return the same value, avoiding a copy of the keys.
 */
export class SingleValuedMapping {
  constructor(keys, value) {
    this._keys = keys instanceof Set ? keys : new Set(keys);
    this._value = value;
  }

  get(key) {
    if (this._keys.has(key)) return this._value;
    return undefined;
  }

  has(key) {
    return this._keys.has(key);
  }

  get size() {
    return this._keys.size;
  }

  [Symbol.iterator]() {
    return this._keys[Symbol.iterator]();
  }

  keys() {
    return this._keys.values();
  }
}
