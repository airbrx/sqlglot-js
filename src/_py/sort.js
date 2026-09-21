// py: CPython comparison + sorted() semantics.
// PORT_PLAN.md §4.5 (`_py/sort.js` provides `pySortedTuples`) and §8.2 item 1.
//
// Two divergences from JS make this necessary:
//
//  1. `Array.prototype.sort()` with no comparator sorts by UTF-16 CODE UNIT order.
//     Python compares strings by CODE POINT. These disagree for astral characters:
//     Python  sorted(['z', '\u{1F600}', '�']) -> ['z', '�', '\u{1F600}']
//     JS      ['z','\u{1F600}','�'].sort()    -> ['z', '\u{1F600}', '�']
//     because '\u{1F600}' starts with the surrogate \uD83D, which is < �.
//
//  2. `Array.prototype.sort()` is not specified to be stable across all engines for
//     large arrays historically, and coerces elements to strings by default.
//     Python's sort is stable (Timsort). V8's is stable, and we rely on that.

/**
 * py: `a < b` for str — code-point lexicographic order.
 * Returns -1, 0 or 1.
 */
export function pyStrCmp(a, b) {
  if (a === b) return 0;
  // Iterating with for..of yields code points, so this is code-point order.
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done && y.done) return 0;
    if (x.done) return -1;
    if (y.done) return 1;
    const xc = x.value.codePointAt(0);
    const yc = y.value.codePointAt(0);
    if (xc !== yc) return xc < yc ? -1 : 1;
  }
}

/** py: numeric comparison, handling BigInt/Number mixtures. */
export function pyNumCmp(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : a > b ? 1 : 0;
}

// `optimizer/simplify.py`'s `merge_ranges(ranges)` call (py:helper.merge_ranges,
// already ported as `mergeRanges`) sorts `(date, date)`/`(datetime, datetime)` tuples
// — the one caller in this codebase that needs `pyCmp` to compare something other
// than str/int/float/bool. Rather than duplicating `merge_ranges`'s algorithm inside
// `optimizer/simplify.js` for one new comparable kind, `pyCmp` grows a same-kind
// case for it, guarded by a `compareKey` getter so this file does not need to import
// `_py/num.js`'s `PyDecimal` or `_py/datetime.js`'s `PyDate`/`PyDateTime` by name —
// any future comparable value kind can opt in the same way.
function hasCompareKey(x) {
  return x !== null && typeof x === "object" && typeof x.compareKey !== "undefined"
    && (typeof x.compareKey === "number" || typeof x.compareKey === "bigint");
}

/**
 * py: default `<` for the value kinds sqlglot actually sorts — str, int/float,
 * bool, and tuples/lists thereof (compared element-wise, then by length).
 *
 * Python raises TypeError for mismatched types; we do the same rather than
 * silently ordering them, because a silent order would be an invented behaviour.
 */
export function pyCmp(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return pyTupleCmp(a, b);
  const ta = typeof a;
  const tb = typeof b;
  if (ta === "string" && tb === "string") return pyStrCmp(a, b);
  if ((ta === "number" || ta === "bigint") && (tb === "number" || tb === "bigint")) {
    return pyNumCmp(a, b);
  }
  if (ta === "boolean" && tb === "boolean") return pyNumCmp(a ? 1 : 0, b ? 1 : 0);
  // Python treats bool as a subclass of int.
  if (ta === "boolean" && (tb === "number" || tb === "bigint")) return pyNumCmp(a ? 1 : 0, b);
  if ((ta === "number" || ta === "bigint") && tb === "boolean") return pyNumCmp(a, b ? 1 : 0);
  if (hasCompareKey(a) && hasCompareKey(b)) {
    // Python raises TypeError comparing e.g. a `date` to a `datetime`; mirror that by
    // requiring the exact same constructor rather than just "both have a compareKey".
    if (a.constructor !== b.constructor) {
      throw new TypeError(`'<' not supported between instances of '${a.constructor?.name}' and '${b.constructor?.name}'`);
    }
    return pyNumCmp(a.compareKey, b.compareKey);
  }
  throw new TypeError(`'<' not supported between instances of '${ta}' and '${tb}'`);
}

/** py: tuple comparison — element-wise, first difference wins, then by length. */
export function pyTupleCmp(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = pyCmp(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** py: sorted(iterable) — stable, ascending, Python comparison semantics. */
export function pySorted(iterable, cmp = pyCmp) {
  return [...iterable].sort(cmp);
}

/** py: sorted(iterable_of_tuples) — §4.5's `pySortedTuples`. */
export function pySortedTuples(iterable) {
  return [...iterable].sort(pyTupleCmp);
}

/** py: sorted(iterable, key=fn) — decorate/sort/undecorate to keep it stable. */
export function pySortedBy(iterable, keyFn, cmp = pyCmp) {
  return [...iterable]
    .map((v, i) => [keyFn(v), i, v])
    .sort((x, y) => cmp(x[0], y[0]) || x[1] - y[1])
    .map((x) => x[2]);
}
