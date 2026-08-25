// py: Lib/difflib.py (CPython 3.9) — SequenceMatcher + get_close_matches.
//
// Reached from helper.py:53 `suggest_closest_match_and_fail`, whose output is a
// user-visible error message ("Unknown dialect 'x'. Did you mean y?"). The ranking
// and the cutoff are therefore output-visible and must match exactly.
//
// Sequences are compared as CODE POINTS (Python iterates str by code point), so
// `a` and `b` are held as code-point arrays, not JS strings.

import { pyTupleCmp } from "./sort.js";

// py: difflib._calculate_ratio
function calculateRatio(matches, length) {
  if (length) return (2.0 * matches) / length;
  return 1.0;
}

// py: difflib.SequenceMatcher
export class SequenceMatcher {
  constructor(isjunk = null, a = "", b = "", autojunk = true) {
    this.isjunk = isjunk;
    this.a = null;
    this.b = null;
    this.autojunk = autojunk;
    this.setSeqs(a, b);
  }

  // py: set_seqs
  setSeqs(a, b) {
    this.setSeq1(a);
    this.setSeq2(b);
  }

  // py: set_seq1 — invalidates cached matching blocks/opcodes but NOT b2j.
  setSeq1(a) {
    const seq = typeof a === "string" ? [...a] : a;
    if (seq === this.a) return;
    this.a = seq;
    this.matchingBlocks = null;
    this.opcodes = null;
  }

  // py: set_seq2 — invalidates b2j and the cached full b counts.
  setSeq2(b) {
    const seq = typeof b === "string" ? [...b] : b;
    if (seq === this.b) return;
    this.b = seq;
    this.matchingBlocks = null;
    this.opcodes = null;
    this.fullbcount = null;
    this.chainB();
  }

  // py: __chain_b
  chainB() {
    const b = this.b;
    const b2j = new Map();
    this.b2j = b2j;

    for (let i = 0; i < b.length; i++) {
      const elt = b[i];
      let indices = b2j.get(elt);
      if (indices === undefined) {
        indices = [];
        b2j.set(elt, indices);
      }
      indices.push(i);
    }

    // Purge junk elements
    const junk = new Set();
    this.bjunk = junk;
    const isjunk = this.isjunk;
    if (isjunk) {
      for (const elt of b2j.keys()) {
        if (isjunk(elt)) junk.add(elt);
      }
      for (const elt of junk) b2j.delete(elt);
    }

    // Purge popular elements that are not junk
    const popular = new Set();
    this.bpopular = popular;
    const n = b.length;
    if (this.autojunk && n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      for (const [elt, idxs] of b2j) {
        if (idxs.length > ntest) popular.add(elt);
      }
      for (const elt of popular) b2j.delete(elt);
    }
  }

  // py: find_longest_match
  findLongestMatch(alo = 0, ahi = null, blo = 0, bhi = null) {
    const a = this.a;
    const b = this.b;
    const b2j = this.b2j;
    const isbjunk = (x) => this.bjunk.has(x);
    if (ahi === null) ahi = a.length;
    if (bhi === null) bhi = b.length;

    let besti = alo;
    let bestj = blo;
    let bestsize = 0;

    // j2len[j] = length of longest junk-free match ending with a[i-1] and b[j]
    let j2len = new Map();
    const nothing = [];

    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map();
      for (const j of b2j.get(a[i]) ?? nothing) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }

    // Extend the best by non-junk elements on each end.
    while (besti > alo && bestj > blo && !isbjunk(b[bestj - 1]) && a[besti - 1] === b[bestj - 1]) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      !isbjunk(b[bestj + bestsize]) &&
      a[besti + bestsize] === b[bestj + bestsize]
    ) {
      bestsize += 1;
    }

    // Suck up the matching junk on each side too.
    while (besti > alo && bestj > blo && isbjunk(b[bestj - 1]) && a[besti - 1] === b[bestj - 1]) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      isbjunk(b[bestj + bestsize]) &&
      a[besti + bestsize] === b[bestj + bestsize]
    ) {
      bestsize += 1;
    }

    return [besti, bestj, bestsize];
  }

  // py: get_matching_blocks
  getMatchingBlocks() {
    if (this.matchingBlocks !== null && this.matchingBlocks !== undefined) {
      return this.matchingBlocks;
    }
    const la = this.a.length;
    const lb = this.b.length;

    // Iterative (queue) rather than recursive, exactly as upstream — which also
    // sidesteps PORT_PLAN §4.7's JS recursion ceiling for free.
    const queue = [[0, la, 0, lb]];
    let matchingBlocks = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop();
      const x = this.findLongestMatch(alo, ahi, blo, bhi);
      const [i, j, k] = x;
      if (k) {
        matchingBlocks.push(x);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    matchingBlocks.sort(pyTupleCmp);

    // Collapse adjacent equal blocks.
    let i1 = 0;
    let j1 = 0;
    let k1 = 0;
    const nonAdjacent = [];
    for (const [i2, j2, k2] of matchingBlocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) {
        k1 += k2;
      } else {
        if (k1) nonAdjacent.push([i1, j1, k1]);
        i1 = i2;
        j1 = j2;
        k1 = k2;
      }
    }
    if (k1) nonAdjacent.push([i1, j1, k1]);

    nonAdjacent.push([la, lb, 0]);
    this.matchingBlocks = nonAdjacent;
    return this.matchingBlocks;
  }

  // py: ratio
  ratio() {
    let matches = 0;
    for (const triple of this.getMatchingBlocks()) matches += triple[triple.length - 1];
    return calculateRatio(matches, this.a.length + this.b.length);
  }

  // py: quick_ratio — upper bound on ratio() via multiset intersection.
  quickRatio() {
    if (this.fullbcount === null || this.fullbcount === undefined) {
      const fullbcount = new Map();
      for (const elt of this.b) fullbcount.set(elt, (fullbcount.get(elt) ?? 0) + 1);
      this.fullbcount = fullbcount;
    }
    const fullbcount = this.fullbcount;
    const avail = new Map();
    let matches = 0;
    for (const elt of this.a) {
      let numb;
      if (avail.has(elt)) numb = avail.get(elt);
      else numb = fullbcount.get(elt) ?? 0;
      avail.set(elt, numb - 1);
      if (numb > 0) matches += 1;
    }
    return calculateRatio(matches, this.a.length + this.b.length);
  }

  // py: real_quick_ratio
  realQuickRatio() {
    const la = this.a.length;
    const lb = this.b.length;
    return calculateRatio(Math.min(la, lb), la + lb);
  }
}

/**
 * py: difflib.get_close_matches(word, possibilities, n=3, cutoff=0.6)
 *
 * Ranking note: upstream uses `heapq.nlargest(n, result)` over `(ratio, x)` tuples,
 * so ties on ratio are broken by the candidate string DESCENDING. Verified on
 * CPython 3.9.25:
 *   get_close_matches('spark', ['spark2','spark','sparkx'], n=3)
 *     -> ['spark', 'sparkx', 'spark2']   (sparkx before spark2, both ratio 0.909091)
 */
export function getCloseMatches(word, possibilities, n = 3, cutoff = 0.6) {
  if (!(n > 0)) throw new Error(`n must be > 0: ${n}`);
  if (!(cutoff >= 0.0 && cutoff <= 1.0)) throw new Error(`cutoff must be in [0.0, 1.0]: ${cutoff}`);

  const result = [];
  const s = new SequenceMatcher();
  s.setSeq2(word);
  for (const x of possibilities) {
    s.setSeq1(x);
    if (s.realQuickRatio() >= cutoff && s.quickRatio() >= cutoff && s.ratio() >= cutoff) {
      result.push([s.ratio(), x]);
    }
  }

  // py: _nlargest(n, result) — descending by the full (ratio, x) tuple.
  result.sort((p, q) => -pyTupleCmp(p, q));
  return result.slice(0, n).map(([, x]) => x);
}
