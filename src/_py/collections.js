// py: Python's value-keyed containers (set/dict/frozenset over Expressions).
// PORT_PLAN.md §4.5.
//
// JS `Set`/`Map` key on IDENTITY. Python keys on `__hash__` + `__eq__`. sqlglot relies
// on the value-keyed behaviour in load-bearing places — most sharply `.index()` inside
// `_move_ctes_to_top_level`, which runs on EVERY generate — so identity containers are
// not a substitute.
//
// The hash/eq relation itself lives on `Expression` (P2) and is deliberately NOT
// reimplemented here: `Expression.__eq__`/`__hash__` are not structural equality (Python
// skips falsy args and conditionally lowercases), and the hash must be a true 64 bits via
// two 32-bit lanes — a 32-bit hash truncates and silently changes `while_changing()`'s
// fixpoint in `simplify`. These containers take `hash` and `eq` as constructor options so
// they can be written and tested before P2 lands the relation.

/**
 * Insertion-ordered, value-keyed hash container.
 *
 * Two properties matter and are differentially tested:
 *  1. **Insertion order on iteration.** Python dicts guarantee it, and re-assigning an
 *     existing key updates the value while keeping the original position. Bucket-order
 *     iteration silently reorders and would surface as nondeterministic SQL.
 *  2. **Collision handling.** Unequal keys may share a hash, so a bucket hit still has to
 *     be confirmed with `eq` — the same thing CPython's open addressing does.
 */
class OrderedHash {
  constructor({ hash, eq }) {
    if (typeof hash !== "function" || typeof eq !== "function") {
      throw new TypeError("OrderedHash requires { hash, eq }");
    }
    this._hash = hash;
    this._eq = eq;
    this._entries = []; // insertion-ordered; holes are null after delete
    this._buckets = new Map(); // hashKey -> entry[]
    this._size = 0;
    this._holes = 0;
  }

  // Hashes may be BigInt (the two 32-bit lanes of §4.5); Map keys compare with ===,
  // and 1n !== 1, so normalize to a string.
  _key(k) {
    return String(this._hash(k));
  }

  _findEntry(k) {
    const bucket = this._buckets.get(this._key(k));
    if (bucket === undefined) return undefined;
    for (const e of bucket) {
      if (this._eq(e.k, k)) return e;
    }
    return undefined;
  }

  get size() {
    return this._size;
  }

  hasKey(k) {
    return this._findEntry(k) !== undefined;
  }

  getEntry(k) {
    return this._findEntry(k);
  }

  /** Returns true if a new entry was inserted, false if an existing one was updated. */
  setEntry(k, v) {
    const existing = this._findEntry(k);
    if (existing !== undefined) {
      // py: d[k] = v on an equal key keeps the ORIGINAL key object and position.
      existing.v = v;
      return false;
    }
    const hk = this._key(k);
    let bucket = this._buckets.get(hk);
    if (bucket === undefined) {
      bucket = [];
      this._buckets.set(hk, bucket);
    }
    const entry = { k, v, index: this._entries.length };
    bucket.push(entry);
    this._entries.push(entry);
    this._size += 1;
    return true;
  }

  deleteKey(k) {
    const entry = this._findEntry(k);
    if (entry === undefined) return false;
    const hk = this._key(k);
    const bucket = this._buckets.get(hk);
    bucket.splice(bucket.indexOf(entry), 1);
    if (bucket.length === 0) this._buckets.delete(hk);
    this._entries[entry.index] = null;
    this._size -= 1;
    this._holes += 1;
    if (this._holes > 32 && this._holes > this._size) this._compact();
    return true;
  }

  _compact() {
    const live = this._entries.filter((e) => e !== null);
    live.forEach((e, i) => {
      e.index = i;
    });
    this._entries = live;
    this._holes = 0;
  }

  *entries() {
    for (const e of this._entries) {
      if (e !== null) yield e;
    }
  }
}

/**
 * py: `set()` of Expressions.
 *
 * Iteration is INSERTION order. Python's real set iteration order is unspecified and
 * hash-dependent, so anywhere sqlglot's output depends on ordering we must sort
 * explicitly (`_py/sort.js`) rather than rely on either language's incidental order.
 */
export class ExprSet {
  constructor(iterable = [], opts = {
    hash: (x) => x && typeof x.hash === "function" ? x.hash() : x,
    eq: (a, b) => a && typeof a.equals === "function" ? a.equals(b) : Object.is(a, b),
  }) {
    this._h = new OrderedHash(opts);
    for (const v of iterable) this.add(v);
  }

  get size() {
    return this._h.size;
  }

  add(v) {
    this._h.setEntry(v, v);
    return this;
  }

  has(v) {
    return this._h.hasKey(v);
  }

  delete(v) {
    return this._h.deleteKey(v);
  }

  *values() {
    for (const e of this._h.entries()) yield e.k;
  }

  [Symbol.iterator]() {
    return this.values();
  }

  /** py: list(s).index(x) — the `_move_ctes_to_top_level` call site. */
  indexOf(v) {
    let i = 0;
    for (const k of this) {
      if (this._h._eq(k, v)) return i;
      i++;
    }
    return -1;
  }
}

/** py: `dict` keyed by Expression. */
export class ExprMap {
  constructor(entries = [], opts = {
    hash: (x) => x && typeof x.hash === "function" ? x.hash() : x,
    eq: (a, b) => a && typeof a.equals === "function" ? a.equals(b) : Object.is(a, b),
  }) {
    this._h = new OrderedHash(opts);
    for (const [k, v] of entries) this.set(k, v);
  }

  get size() {
    return this._h.size;
  }

  set(k, v) {
    this._h.setEntry(k, v);
    return this;
  }

  get(k) {
    const e = this._h.getEntry(k);
    return e === undefined ? undefined : e.v;
  }

  has(k) {
    return this._h.hasKey(k);
  }

  delete(k) {
    return this._h.deleteKey(k);
  }

  *entries() {
    for (const e of this._h.entries()) yield [e.k, e.v];
  }

  *keys() {
    for (const e of this._h.entries()) yield e.k;
  }

  *values() {
    for (const e of this._h.entries()) yield e.v;
  }

  [Symbol.iterator]() {
    return this.entries();
  }
}

// Separator for canonical frozenset keys. Must not appear in `String(hash(x))`, which
// for the numeric/BigInt hashes of §4.5 it cannot. Deliberately NOT "\0": a NUL byte in
// a source file makes grep treat it as binary, which silently breaks the grep-based
// fidelity lints.
const FROZENSET_SEP = ",";

/**
 * py: `frozenset(items)` used as a dict key.
 *
 * Order-independent and de-duplicating: hash every item, sort, dedupe, join. Sorting is
 * what makes `frozenset([a, b])` and `frozenset([b, a])` collide, which is the point.
 */
export function frozensetKey(items, hash = (x) => x) {
  const hashes = [...items].map((x) => String(hash(x)));
  hashes.sort();
  const out = [];
  for (const h of hashes) {
    if (out.length === 0 || out[out.length - 1] !== h) out.push(h);
  }
  return out.join(FROZENSET_SEP);
}

/** Cardinality of the frozenset a key was built from. py: len(frozenset(items)) */
export function frozensetSize(key) {
  return key === "" ? 0 : key.split(FROZENSET_SEP).length;
}
