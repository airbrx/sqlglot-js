// py: sqlglot/diff.py @ 91119bc — WHOLE FILE (447 LOC). AIR-2122.
//
// The Chawathe et al. tree-edit-distance algorithm (as adapted by Fluri/Pinzger's
// "Change Distiller" paper), used to compute a structural diff between two ASTs.
//
// THE ONE DELIBERATE STRUCTURAL DEVIATION IN THIS FILE
// ------------------------------------------------------
// Every Python set/dict in this module is keyed on `id(node)` — a Python `int` that
// stands in for object identity, needed ONLY because Python dict/set keys normally go
// through `__hash__`/`__eq__`, and `Expression.__hash__`/`__eq__` are overridden to be
// STRUCTURAL (two distinct `Column(a)` objects hash equal). `id()` sidesteps that: it
// is the one thing CPython guarantees is both hashable and stable per-object.
//
// JS `Map`/`Set` do not have this problem: they always key on reference identity
// (SameValueZero), never on a custom `.equals()`/`.hash()`. So the direct, MORE
// faithful translation of "a set/dict keyed by node identity" is a `Set`/`Map` keyed
// on the node object itself — no synthetic id, no lookup-by-id indirection. Concretely:
//   - `_source_index`/`_target_index` (`dict[int, Expr]`) become `Set<Expr>` — the
//     only thing they're used for is "is this id known" and "what Expr does this id
//     resolve to", and the node already answers both.
//   - `_unmatched_source_nodes`/`_unmatched_target_nodes` (`set[int]`) become
//     `Set<Expr>` directly.
//   - `matching_set`/`matchings` (`set[tuple[int,int]]` / `dict[int,int]`) become a
//     single `Map<Expr,Expr>` (source node -> target node) throughout — Python builds
//     the set first and only converts it to a dict in `diff()` right before calling
//     `_generate_edit_script`; since every insertion site already guarantees unique
//     source keys (an unmatched node is removed from the unmatched set the moment it's
//     matched), a `Map` from the start is behaviorally identical and skips a
//     redundant data-structure change partway through.
//
// SECOND DEVIATION: `_compute_leaf_matching_set` pushes every candidate onto a
// `heapq` up front and only pops afterward — no `heappush` call happens inside the
// popping `while` loop. A heap that is fully built before anything is popped from it
// yields pops in exactly sorted order, so "heapify, then pop everything" and "sort,
// then iterate" are the same sequence. This port sorts the candidates once by the
// same `(-similarity_score, -parent_similarity_score, insertion_counter)` tuple
// `heapq` would have compared (the counter is strictly increasing and present in
// every candidate, so ties are never broken by comparing the trailing `Expr` operands
// — which Python's tuple comparison could not do anyway once it reached them).
//
// `_bigram_histo` calls `self._sql_generator.generate(expression)` and then slices
// the result — Python string slicing is by CODE POINT, not UTF-16 unit, so this uses
// `cpArray` (`_py/str.js`) rather than raw `.length`/`[i]`, matching every other
// ported string-slicing site in this codebase (§4.2).
//
// `_get_non_expression_leaves`/`_is_same_type` compare raw `args` values directly
// (`source.args.get("side") == target.args.get("side")`, and a dict-equality check
// over non-expression leaves) — these are generic Python `==`, which recurses
// structurally into Expr values, lists, and scalars. `_pyEq` below is this module's
// local stand-in (this module is the only caller; nothing upstream of it needs a
// shared `_py/` helper for this).

import * as exp from "./expressions/index.js";
import { Dialect } from "./dialects/dialect.js";
import { seqGet } from "./helper.js";
import { cpArray } from "./_py/str.js";

/** py: diff.py:24 `class Insert` — "Indicates that a new node has been inserted". */
export class Insert {
  constructor(expression) {
    this.expression = expression;
  }
}

/** py: diff.py:31 `class Remove` — "Indicates that an existing node has been removed". */
export class Remove {
  constructor(expression) {
    this.expression = expression;
  }
}

/** py: diff.py:38 `class Move` — "Indicates that an existing node's position within the tree has changed". */
export class Move {
  constructor(source, target) {
    this.source = source;
    this.target = target;
  }
}

/** py: diff.py:46 `class Update` — "Indicates that an existing node has been updated". */
export class Update {
  constructor(source, target) {
    this.source = source;
    this.target = target;
  }
}

/** py: diff.py:54 `class Keep` — "Indicates that an existing node hasn't been changed". */
export class Keep {
  constructor(source, target) {
    this.source = source;
    this.target = target;
  }
}

/**
 * py: diff.py:67 `diff(source, target, matchings=None, delta_only=False, **kwargs)`.
 *
 * Returns the list of changes between the source and the target expressions.
 *
 * @param {exp.Expr} source the source expression.
 * @param {exp.Expr} target the target expression against which the diff should be calculated.
 * @param {{matchings?: [exp.Expr, exp.Expr][], delta_only?: boolean, f?: number, t?: number,
 *          dialect?: string|import("./dialects/dialect.js").Dialect|null}} [options]
 *   `matchings`: pre-matched node pairs (same node OBJECTS referenced in the source /
 *   target trees) used to help the algorithm's heuristics on subtrees already known to
 *   match. `delta_only`: excludes all `Keep` edits from the result. `f`/`t`/`dialect`
 *   are forwarded to the `ChangeDistiller` constructor.
 * @returns {(Insert|Remove|Move|Update|Keep)[]}
 */
export function diff(source, target, options = {}) {
  const { matchings = [], delta_only: deltaOnly = false, ...kwargs } = options;

  // py: `compute_node_mappings` — only needed on the `copy and matchings` path below,
  // remapping a caller's pre-matched node references onto the freshly-copied trees.
  function computeNodeMappings(oldNodes, newNodes) {
    const nodeMapping = new Map();
    const n = Math.min(oldNodes.length, newNodes.length);
    for (let i = 0; i < n; i++) {
      const oldNode = oldNodes[oldNodes.length - 1 - i];
      const newNode = newNodes[newNodes.length - 1 - i];
      newNode.hash();
      nodeMapping.set(oldNode, newNode);
    }
    return nodeMapping;
  }

  // py: "if the source and target have any shared objects, that means there's an
  // issue with the ast; the algorithm won't work because the parent / hierarchies
  // will be inaccurate"
  const sourceNodes = [...source.walk()];
  const targetNodes = [...target.walk()];
  const sourceIds = new Set(sourceNodes);
  const targetIds = new Set(targetNodes);

  const needsCopy =
    sourceNodes.length !== sourceIds.size ||
    targetNodes.length !== targetIds.size ||
    [...sourceIds].some((n) => targetIds.has(n));

  const sourceCopy = needsCopy ? source.copy() : source;
  const targetCopy = needsCopy ? target.copy() : target;

  let resolvedMatchings = matchings;
  try {
    // py: "We cache the hash of each new node here to speed up equality comparisons.
    // If the input trees aren't copied, these hashes will be evicted before
    // returning the edit script."
    if (needsCopy && matchings.length) {
      const sourceMapping = computeNodeMappings(sourceNodes, [...sourceCopy.walk()]);
      const targetMapping = computeNodeMappings(targetNodes, [...targetCopy.walk()]);
      resolvedMatchings = matchings.map(([s, t]) => [sourceMapping.get(s), targetMapping.get(t)]);
    } else {
      for (const node of [...sourceNodes].reverse()) node.hash();
      for (const node of [...targetNodes].reverse()) node.hash();
    }

    return new ChangeDistiller(kwargs).diff(sourceCopy, targetCopy, {
      matchings: resolvedMatchings,
      delta_only: deltaOnly,
    });
  } finally {
    if (!needsCopy) {
      for (const node of sourceNodes) node._hash = null;
      for (const node of targetNodes) node._hash = null;
    }
  }
}

// py: diff.py:151 `UPDATABLE_EXPRESSION_TYPES` — the expression types for which
// Update edits are allowed.
const UPDATABLE_EXPRESSION_TYPES = [
  exp.Alias,
  exp.Boolean,
  exp.Column,
  exp.DataType,
  exp.Lambda,
  exp.Literal,
  exp.Table,
  exp.Window,
];

// py: diff.py:162 `IGNORED_LEAF_EXPRESSION_TYPES = (exp.Identifier,)`.
const IGNORED_LEAF_EXPRESSION_TYPES = [exp.Identifier];

function isIgnoredLeaf(node) {
  return IGNORED_LEAF_EXPRESSION_TYPES.some((T) => node instanceof T);
}

/**
 * py: diff.py:165 `class ChangeDistiller`.
 *
 * The implementation of the Change Distiller algorithm described by Beat Fluri and
 * Martin Pinzger in their paper https://ieeexplore.ieee.org/document/4339230, which in
 * turn is based on the algorithm by Chawathe et al. described in
 * http://ilpubs.stanford.edu:8090/115/1/1995-46.pdf.
 */
export class ChangeDistiller {
  // py: diff.py:172 `__init__(self, f=0.6, t=0.6, dialect=None)`.
  constructor(options = {}) {
    const { f = 0.6, t = 0.6, dialect = null } = options;
    this.f = f;
    this.t = t;
    this._sql_generator = Dialect.get_or_raise(dialect).generator({ comments: false });
  }

  /** py: diff.py:177 `diff(self, source, target, matchings=None, delta_only=False)`. */
  diff(source, target, options = {}) {
    const { matchings = [], delta_only: deltaOnly = false } = options;
    // py: `pre_matched_nodes = {id(s): id(t) for s, t in matchings}` — a later
    // duplicate `(s, t)` pair simply overwrites the earlier one, same as JS `Map`.
    const preMatchedNodes = new Map(matchings);

    this._source = source;
    this._target = target;
    this._source_index = new Set([...this._source.bfs()].filter((n) => !isIgnoredLeaf(n)));
    this._target_index = new Set([...this._target.bfs()].filter((n) => !isIgnoredLeaf(n)));
    this._unmatched_source_nodes = new Set(
      [...this._source_index].filter((n) => !preMatchedNodes.has(n)),
    );
    const preMatchedTargets = new Set(preMatchedNodes.values());
    this._unmatched_target_nodes = new Set(
      [...this._target_index].filter((n) => !preMatchedTargets.has(n)),
    );
    this._bigram_histo_cache = new Map();

    const matchingSet = this._compute_matching_set();
    for (const [s, t] of preMatchedNodes) matchingSet.set(s, t);

    return this._generate_edit_script(matchingSet, deltaOnly);
  }

  /** py: diff.py:202 `_generate_edit_script(self, matchings, delta_only)`. */
  _generate_edit_script(matchings, deltaOnly) {
    const editScript = [];
    for (const removedNode of this._unmatched_source_nodes) editScript.push(new Remove(removedNode));
    for (const insertedNode of this._unmatched_target_nodes) editScript.push(new Insert(insertedNode));

    for (const [sourceNode, targetNode] of matchings) {
      const identicalNodes = sourceNode.equals(targetNode);

      if (!UPDATABLE_EXPRESSION_TYPES.some((T) => sourceNode instanceof T) || identicalNodes) {
        if (identicalNodes) {
          const sourceParent = sourceNode.parent;
          const targetParent = targetNode.parent;

          if (
            (sourceParent && !targetParent) ||
            (!sourceParent && targetParent) ||
            (sourceParent && targetParent && matchings.get(sourceParent) !== targetParent)
          ) {
            editScript.push(new Move(sourceNode, targetNode));
          }
        } else {
          editScript.push(...this._generate_move_edits(sourceNode, targetNode, matchings));
        }

        const sourceNonExpressionLeaves = _getNonExpressionLeaves(sourceNode);
        const targetNonExpressionLeaves = _getNonExpressionLeaves(targetNode);

        if (!_dictEq(sourceNonExpressionLeaves, targetNonExpressionLeaves)) {
          editScript.push(new Update(sourceNode, targetNode));
        } else if (!deltaOnly) {
          editScript.push(new Keep(sourceNode, targetNode));
        }
      } else {
        editScript.push(new Update(sourceNode, targetNode));
      }
    }

    return editScript;
  }

  /** py: diff.py:246 `_generate_move_edits(self, source, target, matchings)`. */
  _generate_move_edits(source, target, matchings) {
    const sourceArgs = [..._expressionOnlyArgs(source)];
    const targetArgs = [..._expressionOnlyArgs(target)];

    const argsLcs = new Set(_lcs(sourceArgs, targetArgs, (l, r) => matchings.get(l) === r));

    const moveEdits = [];
    for (const a of sourceArgs) {
      if (!argsLcs.has(a) && !this._unmatched_source_nodes.has(a)) {
        moveEdits.push(new Move(a, matchings.get(a)));
      }
    }

    return moveEdits;
  }

  /** py: diff.py:265 `_compute_matching_set(self)`. */
  _compute_matching_set() {
    const leavesMatchingSet = this._compute_leaf_matching_set();
    const matchingSet = new Map(leavesMatchingSet);

    const orderedUnmatchedSourceNodes = [...this._source.bfs()].filter((n) =>
      this._unmatched_source_nodes.has(n),
    );
    const orderedUnmatchedTargetNodes = new Map(
      [...this._target.bfs()].filter((n) => this._unmatched_target_nodes.has(n)).map((n) => [n, null]),
    );

    for (const sourceNode of orderedUnmatchedSourceNodes) {
      for (const targetNode of orderedUnmatchedTargetNodes.keys()) {
        if (_isSameType(sourceNode, targetNode)) {
          const sourceLeafIds = new Set(_getExpressionLeaves(sourceNode));
          const targetLeafIds = new Set(_getExpressionLeaves(targetNode));

          const maxLeavesNum = Math.max(sourceLeafIds.size, targetLeafIds.size);
          let leafSimilarityScore;
          if (maxLeavesNum) {
            let commonLeavesNum = 0;
            for (const [s, t] of leavesMatchingSet) {
              if (sourceLeafIds.has(s) && targetLeafIds.has(t)) commonLeavesNum++;
            }
            leafSimilarityScore = commonLeavesNum / maxLeavesNum;
          } else {
            leafSimilarityScore = 0.0;
          }

          const adjustedT = Math.min(sourceLeafIds.size, targetLeafIds.size) > 4 ? this.t : 0.4;

          if (
            leafSimilarityScore >= 0.8 ||
            (leafSimilarityScore >= adjustedT && this._dice_coefficient(sourceNode, targetNode) >= this.f)
          ) {
            matchingSet.set(sourceNode, targetNode);
            this._unmatched_source_nodes.delete(sourceNode);
            this._unmatched_target_nodes.delete(targetNode);
            orderedUnmatchedTargetNodes.delete(targetNode);
            break;
          }
        }
      }
    }

    return matchingSet;
  }

  /**
   * py: diff.py:310 `_compute_leaf_matching_set(self)`.
   *
   * See this file's own header for why a one-shot sort stands in for `heapq` here.
   */
  _compute_leaf_matching_set() {
    const candidateMatchings = [];
    const sourceExpressionLeaves = [..._getExpressionLeaves(this._source)];
    const targetExpressionLeaves = [..._getExpressionLeaves(this._target)];
    for (const sourceLeaf of sourceExpressionLeaves) {
      for (const targetLeaf of targetExpressionLeaves) {
        if (_isSameType(sourceLeaf, targetLeaf)) {
          const similarityScore = this._dice_coefficient(sourceLeaf, targetLeaf);
          if (similarityScore >= this.f) {
            candidateMatchings.push({
              negScore: -similarityScore,
              negParentScore: -_parentSimilarityScore(sourceLeaf, targetLeaf),
              counter: candidateMatchings.length,
              sourceLeaf,
              targetLeaf,
            });
          }
        }
      }
    }
    candidateMatchings.sort(
      (a, b) => a.negScore - b.negScore || a.negParentScore - b.negParentScore || a.counter - b.counter,
    );

    const matchingSet = new Map();
    for (const { sourceLeaf, targetLeaf } of candidateMatchings) {
      if (this._unmatched_source_nodes.has(sourceLeaf) && this._unmatched_target_nodes.has(targetLeaf)) {
        matchingSet.set(sourceLeaf, targetLeaf);
        this._unmatched_source_nodes.delete(sourceLeaf);
        this._unmatched_target_nodes.delete(targetLeaf);
      }
    }

    return matchingSet;
  }

  /** py: diff.py:344 `_dice_coefficient(self, source, target)`. */
  _dice_coefficient(source, target) {
    const sourceHisto = this._bigram_histo(source);
    const targetHisto = this._bigram_histo(target);

    let totalGrams = 0;
    for (const v of sourceHisto.values()) totalGrams += v;
    for (const v of targetHisto.values()) totalGrams += v;
    if (!totalGrams) return source.equals(target) ? 1.0 : 0.0;

    let overlapLen = 0;
    for (const g of sourceHisto.keys()) {
      if (targetHisto.has(g)) overlapLen += Math.min(sourceHisto.get(g), targetHisto.get(g));
    }

    return (2 * overlapLen) / totalGrams;
  }

  /** py: diff.py:359 `_bigram_histo(self, expression)`. */
  _bigram_histo(expression) {
    const cached = this._bigram_histo_cache.get(expression);
    if (cached !== undefined) return cached;

    const expressionStr = cpArray(this._sql_generator.generate(expression));
    const count = Math.max(0, expressionStr.length - 1);
    const bigramHisto = new Map();
    for (let i = 0; i < count; i++) {
      const bigram = expressionStr[i] + expressionStr[i + 1];
      bigramHisto.set(bigram, (bigramHisto.get(bigram) || 0) + 1);
    }

    this._bigram_histo_cache.set(expression, bigramHisto);
    return bigramHisto;
  }
}

/** py: diff.py:373 `_get_expression_leaves(expression)`. */
function* _getExpressionLeaves(expression) {
  let hasChildExprs = false;

  for (const node of expression.iterExpressions()) {
    if (!isIgnoredLeaf(node)) {
      hasChildExprs = true;
      yield* _getExpressionLeaves(node);
    }
  }

  if (!hasChildExprs) yield expression;
}

/** py: diff.py:385 `_get_non_expression_leaves(expression)` — returned as a plain object. */
function _getNonExpressionLeaves(expression) {
  const leaves = {};
  for (const [arg, value] of Object.entries(expression.args)) {
    if (
      value === null ||
      value === undefined ||
      value instanceof exp.Expr ||
      (Array.isArray(value) && seqGet(value, 0) instanceof exp.Expr)
    ) {
      continue;
    }
    leaves[arg] = value;
  }
  return leaves;
}

/** py: diff.py:397 `_is_same_type(source, target)`. */
function _isSameType(source, target) {
  if (source.constructor === target.constructor) {
    if (source instanceof exp.Join) return _pyEq(source.args.side, target.args.side);
    if (source instanceof exp.Anonymous) return _pyEq(source.this, target.this);
    return true;
  }
  return false;
}

/** py: diff.py:410 `_parent_similarity_score(source, target)`. */
function _parentSimilarityScore(source, target) {
  if (source === null || source === undefined || target === null || target === undefined) return 0;
  if (source.constructor !== target.constructor) return 0;
  return 1 + _parentSimilarityScore(source.parent, target.parent);
}

/** py: diff.py:417 `_expression_only_args(expression)`. */
function* _expressionOnlyArgs(expression) {
  for (const arg of expression.iterExpressions()) {
    if (!isIgnoredLeaf(arg)) yield arg;
  }
}

/**
 * py: diff.py:425 `_lcs(seq_a, seq_b, equal)` — "Calculates the longest common
 * subsequence".
 */
function _lcs(seqA, seqB, equal) {
  const lenA = seqA.length;
  const lenB = seqB.length;
  const lcsResult = [];
  for (let i = 0; i <= lenA; i++) lcsResult.push(new Array(lenB + 1).fill(null));

  for (let i = 0; i <= lenA; i++) {
    for (let j = 0; j <= lenB; j++) {
      if (i === 0 || j === 0) {
        lcsResult[i][j] = [];
      } else if (equal(seqA[i - 1], seqB[j - 1])) {
        lcsResult[i][j] = [...lcsResult[i - 1][j - 1], seqA[i - 1]];
      } else {
        lcsResult[i][j] = lcsResult[i - 1][j].length > lcsResult[i][j - 1].length
          ? lcsResult[i - 1][j]
          : lcsResult[i][j - 1];
      }
    }
  }

  return lcsResult[lenA][lenB];
}

/**
 * Not an upstream symbol. Generic Python `==` for the raw `args` VALUES this module
 * compares directly (`_is_same_type`'s `side`/`this` checks, `_get_non_expression_
 * leaves`'s dict-equality) — these are never hashed/cached like `Expression.__eq__`,
 * they're a plain recursive structural comparison, so `Expr` values fall back to
 * `.equals()` and everything else (string/number/boolean/null/list) compares the way
 * Python's `==` would. This module is the only caller; it isn't a `_py/` shim because
 * nothing else in the port needs this exact generalization.
 */
function _pyEq(a, b) {
  if (a instanceof exp.Expr || b instanceof exp.Expr) {
    return a instanceof exp.Expr && b instanceof exp.Expr && a.equals(b);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => _pyEq(x, b[i]));
  }
  return a === b;
}

/** Not an upstream symbol — `dict == dict` for the plain objects `_getNonExpressionLeaves` returns. */
function _dictEq(a, b) {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => Object.hasOwn(b, k) && _pyEq(a[k], b[k]));
}
