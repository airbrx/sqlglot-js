// py: sqlglot/trie.py @ 91119bc

/**
 * py: trie.TrieResult
 * Values match upstream's `auto()` numbering (FAILED=1, PREFIX=2, EXISTS=3).
 */
export const TrieResult = Object.freeze({
  FAILED: 1,
  PREFIX: 2,
  EXISTS: 3,
});

// py: the trie marks a complete keyword with the INTEGER key 0.
//
// This is why the trie is built from `Map`, not a plain object. In Python, `0` and
// `"0"` are distinct dict keys; in a JS object, property keys are coerced to
// strings, so `trie[0]` and `trie["0"]` are the SAME slot. Any keyword containing
// the character '0' would then collide with the end-of-keyword marker — silently
// corrupting the trie for e.g. tokenizer keywords or time formats containing digits.
export const TRIE_END = 0;

/**
 * py: trie.new_trie(keywords, trie=None)
 *
 * Creates a new trie out of a collection of keywords. The trie is a nesting of
 * `Map`s keyed by single-character strings, plus the integer key 0 marking that a
 * keyword ends there.
 *
 * @param {Iterable<Iterable<string>>} keywords
 * @param {Map<any, any>} [trie] a trie to mutate instead of creating a new one
 * @returns {Map<any, any>}
 */
export function newTrie(keywords, trie = null) {
  trie = trie === null ? new Map() : trie;

  for (const key of keywords) {
    let current = trie;
    // Iterating a string with for..of yields CODE POINTS, matching Python's
    // `for char in key`. Indexing by UTF-16 unit would split astral characters.
    for (const char of key) {
      let next = current.get(char);
      if (next === undefined) {
        next = new Map();
        current.set(char, next);
      }
      current = next;
    }

    current.set(TRIE_END, true);
  }

  return trie;
}

/**
 * py: trie.in_trie(trie, key)
 *
 * @returns {[number, Map<any, any>]} `[result, subtrie]` where `subtrie` is where
 *   the search stopped and `result` is a TrieResult.
 */
export function inTrie(trie, key) {
  // py: `if not key` — an empty key (or empty iterable) fails.
  if (key === null || key === undefined || key.length === 0) {
    return [TrieResult.FAILED, trie];
  }

  let current = trie;
  for (const char of key) {
    const next = current.get(char);
    if (next === undefined) {
      return [TrieResult.FAILED, current];
    }
    current = next;
  }

  if (current.has(TRIE_END)) {
    return [TrieResult.EXISTS, current];
  }

  return [TrieResult.PREFIX, current];
}
