// py: sqlglot/optimizer/scope.py @ 91119bc — Tier A (walk/find helpers), the `Scope`
// class's own CORE surface (AIR-2093), and the module-level tree builders
// `traverse_scope`/`build_scope` (AIR-2094).
//
// PORT_PLAN.md §6 splits this file into "Tier A (P3, parser-path)" — the four walk/find
// helpers below, ported first because `parser.py:8675` reaches `find_in_scope` directly
// — and "Tier B (P5)", the ~1,100-LOC remainder: the `Scope` class and the module-level
// tree builders `traverse_scope`/`build_scope`.
//
// AIR-2093 ported the `Scope` class itself: its constructor, `branch`, `_collect` and
// every lazily-computed property/method that reads the class's OWN state. AIR-2094
// ports `traverse_scope`/`build_scope` and their seven module-private helpers
// (`_traverse_scope`, `_traverse_select`, `_traverse_union`, `_traverse_ctes`,
// `_traverse_tables`, `_traverse_subqueries`, `_traverse_udtfs`) — the algorithm that
// walks an expression tree and BUILDS the `Scope` tree, wiring `sources`/`parent`/every
// `*_scopes` list the class's own properties read.
//
// AIR-2095 (reconciliation, no new lines ported) re-verified the four Tier A helpers
// (`walk_in_scope`/`find_all_in_scope`/`find_in_scope`, `_is_derived_table`) and the
// class's `rename_source`/`add_source`/`remove_source`/`replace` against the real
// `scope.py:1008-1101`/class body now that the full `Scope` tree exists to compare
// against — everything already matched exactly. The one genuine gap found was
// verification, not code: `walk_in_scope`'s `prune` callback (used by two real, still-
// unported callers, `qualify_columns.py`'s `node.is_star` and `simplify.py`'s
// `isinstance(node, exp.If)`) had never been exercised by any oracle since P3. See
// `spike/p3/fuzz_walk_in_scope.mjs`'s `PRUNE_PROBES`.
//
// @ported-ranges sqlglot/optimizer/scope.py 39-46 101-644 647-846 849-857 860-870 873-1005 1008-1059 1062-1081 1084-1101 1104-1111

import * as exp from "../expressions/index.js";
import { OptimizeError } from "../errors.js";
import { findNewName, seqGet } from "../helper.js";
import { logger } from "../logging.js";

// py: expressions/query.py:2165 `UNWRAPPED_QUERIES = (Select, SetOperation)`
const UNWRAPPED_QUERIES = () => [exp.Select, exp.SetOperation];

// py: scope.py:22 `ROW_LEVEL_AGG_FUNCS = (exp.Count,)`
const ROW_LEVEL_AGG_FUNCS = [exp.Count];

// py: scope.py:26 `COLLECTIBLE_TYPES` — the node types `Scope._collect` classifies.
const COLLECTIBLE_TYPES = [
  exp.Column,
  exp.Dot,
  exp.Table,
  exp.Query,
  exp.UDTF,
  exp.CTE,
  exp.Star,
  exp.TableColumn,
  exp.JoinHint,
];

/**
 * py: scope.py:39 `class ScopeType(Enum)`, `auto()` members.
 *
 * Plain strings, not wrapped objects — the same choice `errors.js`'s `ErrorLevel` makes
 * for `AutoName` (a stricter version of the same `auto()` mechanism). Nothing here reads
 * the underlying Python `int` value, only identity/equality, which `===` on a string
 * already gives, and a string prints legibly in a JSON dump or a debugger.
 */
export const ScopeType = Object.freeze({
  ROOT: "ROOT",
  SUBQUERY: "SUBQUERY",
  DERIVED_TABLE: "DERIVED_TABLE",
  CTE: "CTE",
  UNION: "UNION",
  UDTF: "UDTF",
});

/**
 * py: scope.py:849 `_is_derived_table(expression)`
 *
 * `(tbl1 JOIN tbl2)` is represented as a Subquery but does not introduce a new scope.
 * An alias shadows every name underneath, which is the one exception.
 */
function isDerivedTable(expression) {
  return (
    expression instanceof exp.Subquery
    // py: `bool(expression.alias or isinstance(...))` — `alias` is a STRING here, so
    // the empty string is falsy. `!!expression.alias` reproduces that; a
    // `!== null` test would call an unaliased subquery derived.
    && !!(expression.alias || UNWRAPPED_QUERIES().some((C) => expression.this instanceof C))
  );
}

/**
 * py: scope.py:860 `_is_from_or_join(expression)`
 *
 * `type(parent) is exp.Subquery` / `type(parent) in (exp.From, exp.Join)` — exact-type
 * checks matching upstream's `type(...) is`/`type(...) in (...)`, not `isinstance`.
 * `From`/`Join`/`Subquery` have no subclasses upstream, so `.constructor ===` and
 * `instanceof` would agree here regardless — spelled as exact-type anyway to match the
 * source 1:1, the same idiom `expressions/index.js`'s own `isSimpleUnit` uses.
 */
function isFromOrJoin(expression) {
  let parent = expression.parent;
  while (parent?.constructor === exp.Subquery) parent = parent.parent;
  return parent?.constructor === exp.From || parent?.constructor === exp.Join;
}

/**
 * py: scope.py:1104 `_get_source_alias(expression)`
 */
function getSourceAlias(expression) {
  const aliasArg = expression.args.alias;
  let aliasName = expression.alias;
  if (!aliasName && aliasArg instanceof exp.TableAlias && aliasArg.columns.length === 1) {
    aliasName = aliasArg.columns[0].name;
  }
  return aliasName;
}

/**
 * py: scope.py:1008 `walk_in_scope(expression, prune=None)`
 *
 * Visits every node in the tree, stopping at nodes that start CHILD SCOPES. Upstream
 * notes it is a hand-rolled DFS rather than `expression.walk()` because nested
 * generators are not optimized by mypyc; the traversal ORDER is identical either way
 * and is preserved here exactly — pop from a stack, push args in REVERSE so siblings
 * come out in declaration order.
 *
 * @param {object} expression
 * @param {((node: object) => boolean)|null} [prune]
 */
export function* walkInScope(expression, prune = null) {
  const stack = [expression];

  while (stack.length) {
    const node = stack.pop();

    yield node;

    // py: only CTEs and Queries can start child scopes; checking that first lets every
    // other node skip the remaining boundary tests.
    if (
      node !== expression
      && (node instanceof exp.CTE || node instanceof exp.Query)
      && (
        node instanceof exp.CTE
        || ((node.parent instanceof exp.From || node.parent instanceof exp.Join)
          && isDerivedTable(node))
        || node.parent instanceof exp.UDTF
        || UNWRAPPED_QUERIES().some((C) => node instanceof C)
      )
    ) {
      if (node instanceof exp.Subquery || node instanceof exp.UDTF) {
        for (const key of ["joins", "laterals", "pivots"]) {
          for (const arg of node.args[key] || []) yield* walkInScope(arg);
        }
      }
      continue;
    }

    if (prune && prune(node)) continue;

    // py: `for vs in reversed(node.args.values())` then `for v in reversed(vs)` —
    // reversing twice so that popping the stack yields args, and list elements within
    // an arg, in their original declaration order.
    const values = Object.values(node.args);
    for (let i = values.length - 1; i >= 0; i--) {
      const vs = values[i];
      if (Array.isArray(vs)) {
        for (let j = vs.length - 1; j >= 0; j--) {
          if (vs[j] instanceof exp.Expr) stack.push(vs[j]);
        }
      } else if (vs instanceof exp.Expr) {
        stack.push(vs);
      }
    }
  }
}

/**
 * py: scope.py:1062 `find_all_in_scope(expression, *expression_types)`
 * Yields every node in this scope matching at least one type. Does NOT enter subscopes.
 */
export function* findAllInScope(expression, ...expressionTypes) {
  for (const node of walkInScope(expression)) {
    if (expressionTypes.some((C) => node instanceof C)) yield node;
  }
}

/**
 * py: scope.py:1084 `find_in_scope(expression, *expression_types)`
 * The first match, or null. py: `next(find_all_in_scope(...), None)`.
 */
export function findInScope(expression, ...expressionTypes) {
  for (const node of findAllInScope(expression, ...expressionTypes)) return node;
  return null;
}

/**
 * py: scope.py:49 `class Scope` — "Selection scope."
 *
 * `sources`/`lateral_sources`/`cte_sources` are `Map`, not plain objects — the same
 * choice `schema.js` makes and for the same reason (a source aliased to a
 * numeric-looking string like `"1"` must not be reordered ahead of other keys).
 *
 * `_column_index` (upstream: `set[int]` of `id(column)`) and `ref_count()`'s returned
 * mapping (upstream: `dict[int, int]` keyed by `id(source)`) both use Python's `id()`
 * purely as an IDENTITY key — no code ever reads the integer itself. A JS `Set`/`Map`
 * already compares object values by reference (`SameValueZero`), so both are ported
 * storing the node/source object itself as the key, with no separate id-allocator.
 */
export class Scope {
  // py: scope.py:101 `__init__`.
  constructor(
    expression,
    sources = null,
    outerColumns = null,
    parent = null,
    scopeType = ScopeType.ROOT,
    lateralSources = null,
    cteSources = null,
    canBeCorrelated = null,
  ) {
    this.expression = expression;
    // py: `sources or {}` — an empty/absent dict is replaced with a NEW dict; a
    // non-empty one is reused BY REFERENCE (not copied), so a caller's shared dict is
    // mutated by the two `.update()` calls below. `branch()` always copies before
    // passing, which is where the distinction actually matters.
    this.sources = sources && sources.size ? sources : new Map();
    this.lateralSources = lateralSources && lateralSources.size ? lateralSources : new Map();
    this.cteSources = cteSources && cteSources.size ? cteSources : new Map();
    for (const [k, v] of this.lateralSources) this.sources.set(k, v);
    for (const [k, v] of this.cteSources) this.sources.set(k, v);
    this.outerColumns = outerColumns && outerColumns.length ? outerColumns : [];
    this.parent = parent;
    this.scopeType = scopeType;
    this.subqueryScopes = [];
    this.derivedTableScopes = [];
    this.tableScopes = [];
    this.cteScopes = [];
    this.unionScopes = [];
    this.udtfScopes = [];
    this.canBeCorrelated = canBeCorrelated;
    this.clearCache();
  }

  /** py: scope.py:130 `clear_column_cache` — after columns are qualified in place. */
  clearColumnCache() {
    this._columns = null;
    this._externalColumns = null;
    this._localColumns = null;
  }

  // py: scope.py:136 `clear_cache`.
  clearCache() {
    this._collected = false;
    this._scansAllSubscopeColumns = false;
    this._rawColumns = [];
    this._tableColumns = [];
    this._stars = [];
    this._derivedTables = [];
    this._udtfs = [];
    this._tables = [];
    this._ctes = [];
    this._subqueries = [];
    this._joinHints = [];
    this._semiAntiJoinTables = new Set();
    this._columnIndex = new Set();
    this._selectedSources = null;
    this._columns = null;
    this._externalColumns = null;
    this._localColumns = null;
    this._pivots = null;
    this._references = null;
  }

  /** py: scope.py:157 `branch` — branch from the current scope to a new, inner scope. */
  branch(expression, scopeType, sources = null, cteSources = null, lateralSources = null, outerColumns = null) {
    const mergedCteSources = new Map(this.cteSources);
    if (cteSources) for (const [k, v] of cteSources) mergedCteSources.set(k, v);
    return new Scope(
      expression.unnest(),
      sources && sources.size ? new Map(sources) : null,
      outerColumns,
      this,
      scopeType,
      lateralSources && lateralSources.size ? new Map(lateralSources) : null,
      mergedCteSources,
      this.canBeCorrelated || scopeType === ScopeType.SUBQUERY || scopeType === ScopeType.UDTF,
    );
  }

  // py: scope.py:179 `_collect`.
  _collect() {
    this._tables = [];
    this._ctes = [];
    this._subqueries = [];
    this._derivedTables = [];
    this._udtfs = [];
    this._rawColumns = [];
    this._tableColumns = [];
    this._stars = [];
    this._joinHints = [];
    this._semiAntiJoinTables = new Set();
    this._columnIndex = new Set();

    // The inner query of a Subquery-rooted scope is scoped as a derived table by
    // `_traverse_tables`, so it must not also be collected as a subquery.
    const innerQuery = this.expression instanceof exp.Subquery ? this.expression.unnest() : null;

    for (const node of this.walk()) {
      // Most nodes (identifiers, literals, operators etc.) aren't collectible, so a
      // single instanceof gate lets them skip the classification chain below.
      if (node === this.expression || !COLLECTIBLE_TYPES.some((C) => node instanceof C)) continue;

      if (node instanceof exp.Dot && node.isStar) {
        this._stars.push(node);
      } else if (node.constructor === exp.Column) {
        this._columnIndex.add(node);

        if (node.this instanceof exp.Star) {
          this._stars.push(node);
        } else {
          this._rawColumns.push(node);
        }
      } else if (node instanceof exp.Table && !(node.parent instanceof exp.JoinHint)) {
        const parent = node.parent;
        if (parent instanceof exp.Join && parent.isSemiOrAntiJoin) {
          this._semiAntiJoinTables.add(node.aliasOrName);
        }

        this._tables.push(node);
      } else if (node instanceof exp.JoinHint) {
        this._joinHints.push(node);
      } else if (
        node.constructor === exp.Lateral
        || (node instanceof exp.UDTF && (node.parent instanceof exp.From || node.parent instanceof exp.Join))
      ) {
        this._udtfs.push(node);
      } else if (node instanceof exp.CTE) {
        this._ctes.push(node);
      } else if (isDerivedTable(node) && isFromOrJoin(node)) {
        this._derivedTables.push(node);
      } else if (
        UNWRAPPED_QUERIES().some((C) => node instanceof C)
        && !isFromOrJoin(node)
        && node !== innerQuery
      ) {
        this._subqueries.push(node);
      } else if (node instanceof exp.TableColumn) {
        this._tableColumns.push(node);
      } else if (
        node instanceof exp.Star
        && (node.args.except_ || !ROW_LEVEL_AGG_FUNCS.some((C) => node.parent instanceof C))
      ) {
        this._scansAllSubscopeColumns = true;
      }
    }

    this._collected = true;
  }

  // py: scope.py:244 `_ensure_collected`.
  _ensureCollected() {
    if (!this._collected) this._collect();
  }

  /** py: scope.py:248 `walk`. */
  walk(prune = null) {
    return walkInScope(this.expression, prune);
  }

  /** py: scope.py:251 `find`. */
  find(...expressionTypes) {
    return findInScope(this.expression, ...expressionTypes);
  }

  /** py: scope.py:254 `find_all`. */
  findAll(...expressionTypes) {
    return findAllInScope(this.expression, ...expressionTypes);
  }

  /**
   * py: scope.py:257 `replace` — replace `old` with `new`, keeping the `Scope` in sync
   * (use this instead of `Expr.replace` directly).
   */
  replace(oldNode, newNode) {
    oldNode.replace(newNode);
    this.clearCache();
  }

  /** py: scope.py:270 `tables`. */
  get tables() {
    this._ensureCollected();
    return this._tables;
  }

  /** py: scope.py:281 `ctes`. */
  get ctes() {
    this._ensureCollected();
    return this._ctes;
  }

  /** py: scope.py:292 `derived_tables` — e.g. `SELECT * FROM (SELECT ...)`. */
  get derivedTables() {
    this._ensureCollected();
    return this._derivedTables;
  }

  /** py: scope.py:306 `udtfs` — "User Defined Tabular Functions". */
  get udtfs() {
    this._ensureCollected();
    return this._udtfs;
  }

  /** py: scope.py:317 `subqueries` — e.g. `SELECT * FROM x WHERE a IN (SELECT ...)`. */
  get subqueries() {
    this._ensureCollected();
    return this._subqueries;
  }

  /** py: scope.py:331 `scans_all_subscope_columns`. */
  get scansAllSubscopeColumns() {
    this._ensureCollected();
    return this._scansAllSubscopeColumns;
  }

  /** py: scope.py:336 `stars` — star expressions (columns or dots) in this scope. */
  get stars() {
    this._ensureCollected();
    return this._stars;
  }

  /** py: scope.py:344 `column_index` — set of column nodes belonging to this scope. */
  get columnIndex() {
    this._ensureCollected();
    return this._columnIndex;
  }

  /**
   * py: scope.py:352 `columns` — Column instances in this scope, plus any Columns that
   * reference this scope from correlated subqueries.
   */
  get columns() {
    if (this._columns === null) {
      this._ensureCollected();
      const columns = this._rawColumns;

      const externalColumns = [];
      for (const scope of [
        ...this.subqueryScopes,
        ...this.udtfScopes,
        ...this.derivedTableScopes.filter((dts) => dts.canBeCorrelated),
      ]) {
        externalColumns.push(...scope.externalColumns);
      }

      const expr = this.expression;
      const namedSelects = expr instanceof exp.Query ? new Set(expr.namedSelects) : new Set();

      this._columns = [];
      for (const column of [...columns, ...externalColumns]) {
        const ancestor = column.findAncestor(
          exp.Select, exp.Qualify, exp.Order, exp.Having, exp.Hint, exp.Table, exp.Star, exp.Distinct,
        );
        if (
          !ancestor
          || column.text("table")
          || ancestor instanceof exp.Select
          || (ancestor instanceof exp.Table && !(ancestor.this instanceof exp.Func))
          || (
            (ancestor instanceof exp.Order || ancestor instanceof exp.Distinct)
            && (
              ancestor.parent instanceof exp.Window
              || ancestor.parent instanceof exp.WithinGroup
              || !(ancestor.parent instanceof exp.Select)
              || !namedSelects.has(column.name)
            )
          )
          || (ancestor instanceof exp.Star && column.argKey !== "except_")
        ) {
          this._columns.push(column);
        }
      }
    }

    return this._columns;
  }

  /** py: scope.py:409 `table_columns`. */
  get tableColumns() {
    this._ensureCollected();
    return this._tableColumns;
  }

  /**
   * py: scope.py:414 `selected_sources` — mapping of nodes and sources that are
   * actually selected from in this scope. That is, all tables in a schema are
   * selectable at any point, but a table only becomes a selected source if it's
   * included in a FROM or JOIN clause.
   */
  get selectedSources() {
    if (this._selectedSources === null) {
      const result = new Map();

      for (const [name, node] of this.references) {
        if (this._semiAntiJoinTables.has(name)) {
          // The RHS table of SEMI/ANTI joins shouldn't be collected as a selected
          // source.
          continue;
        }

        if (result.has(name)) throw new OptimizeError(`Alias already used: ${name}`);
        if (this.sources.has(name)) result.set(name, [node, this.sources.get(name)]);
      }

      this._selectedSources = result;
    }
    return this._selectedSources;
  }

  /** py: scope.py:442 `references`. */
  get references() {
    if (this._references === null) {
      this._references = [];

      for (const table of this.tables) this._references.push([table.aliasOrName, table]);
      for (const expression of [...this.derivedTables, ...this.udtfs]) {
        const node = expression.args.pivots ? expression : expression.unnest();
        this._references.push([getSourceAlias(expression), node.assertIs(exp.Selectable)]);
      }
    }

    return this._references;
  }

  /**
   * py: scope.py:463 `external_columns` — columns that appear to reference sources in
   * outer scopes.
   */
  get externalColumns() {
    if (this._externalColumns === null) {
      if (this.expression instanceof exp.SetOperation) {
        const [left, right] = this.unionScopes;
        this._externalColumns = [...left.externalColumns, ...right.externalColumns];
      } else {
        const localSourceNames = new Set(this.references.map(([name]) => name));
        this._externalColumns = this.columns.filter(
          (c) => !localSourceNames.has(c.text("table")) && !this.semiOrAntiJoinTables.has(c.text("table")),
        );
      }
    }

    return this._externalColumns;
  }

  /** py: scope.py:486 `local_columns` — columns in this scope that are not external. */
  get localColumns() {
    if (this._localColumns === null) {
      // Compare nodes by identity: structural equality would conflate distinct column
      // nodes that happen to look the same, and is much more expensive.
      const externalColumnIds = new Set(this.externalColumns);
      this._localColumns = this.columns.filter((c) => !externalColumnIds.has(c));
    }

    return this._localColumns;
  }

  /** py: scope.py:502 `unqualified_columns`. */
  get unqualifiedColumns() {
    return this.columns.filter((c) => !c.text("table"));
  }

  /** py: scope.py:512 `join_hints` — hints that exist in the scope that reference tables. */
  get joinHints() {
    this._ensureCollected();
    return this._joinHints;
  }

  /** py: scope.py:523 `pivots`. */
  get pivots() {
    if (this._pivots === null) {
      this._pivots = [];
      for (const [, node] of this.references) {
        for (const pivot of node.args.pivots || []) this._pivots.push(pivot);
      }
    }

    return this._pivots;
  }

  /** py: scope.py:532 `semi_or_anti_join_tables`. */
  get semiOrAntiJoinTables() {
    this._ensureCollected();
    return this._semiAntiJoinTables;
  }

  /**
   * py: scope.py:537 `source_columns` — all columns in the current scope for a
   * particular source.
   */
  sourceColumns(sourceName) {
    return this.columns.filter((column) => column.text("table") === sourceName);
  }

  /** py: scope.py:548 `is_subquery`. */
  get isSubquery() {
    return this.scopeType === ScopeType.SUBQUERY;
  }

  /** py: scope.py:553 `is_derived_table`. */
  get isDerivedTable() {
    return this.scopeType === ScopeType.DERIVED_TABLE;
  }

  /** py: scope.py:558 `is_union`. */
  get isUnion() {
    return this.scopeType === ScopeType.UNION;
  }

  /** py: scope.py:563 `is_cte`. */
  get isCte() {
    return this.scopeType === ScopeType.CTE;
  }

  /** py: scope.py:568 `is_root`. */
  get isRoot() {
    return this.scopeType === ScopeType.ROOT;
  }

  /** py: scope.py:573 `is_udtf`. */
  get isUdtf() {
    return this.scopeType === ScopeType.UDTF;
  }

  /** py: scope.py:578 `is_correlated_subquery`. */
  get isCorrelatedSubquery() {
    return !!(this.canBeCorrelated && this.externalColumns.length);
  }

  /** py: scope.py:583 `rename_source`. */
  renameSource(oldName, newName) {
    oldName = oldName || "";
    if (this.sources.has(oldName)) {
      const source = this.sources.get(oldName);
      this.sources.delete(oldName);
      this.sources.set(newName, source);
    }
  }

  /** py: scope.py:589 `add_source`. */
  addSource(name, source) {
    this.sources.set(name, source);
    this.clearCache();
  }

  /** py: scope.py:594 `remove_source`. */
  removeSource(name) {
    this.sources.delete(name);
    this.clearCache();
  }

  /** py: scope.py:599 `__repr__`. */
  toString() {
    return `Scope<${this.expression.sql()}>`;
  }

  /**
   * py: scope.py:602 `traverse` — traverse the scope tree from this node, yielding
   * scope instances in depth-first-search POST-order.
   */
  *traverse() {
    const stack = [this];
    const result = [];
    while (stack.length) {
      const scope = stack.pop();
      result.push(scope);
      stack.push(...scope.cteScopes, ...scope.unionScopes, ...scope.tableScopes, ...scope.subqueryScopes);
    }

    yield* result.reverse();
  }

  /**
   * py: scope.py:625 `ref_count` — count the number of times each scope in this tree is
   * referenced. Returns a `Map` of source object -> reference count (see the class
   * header for why the key is the object itself rather than a Python-style `id()`).
   */
  refCount() {
    const scopeRefCount = new Map();
    const inc = (key) => scopeRefCount.set(key, (scopeRefCount.get(key) || 0) + 1);

    for (const scope of this.traverse()) {
      for (const [, source] of scope.selectedSources.values()) inc(source);

      for (const name of scope._semiAntiJoinTables) {
        // semi/anti join sources are not actually selected but we still need to
        // increment their ref count to avoid them being optimized away
        if (scope.sources.has(name)) inc(scope.sources.get(name));
      }
    }

    return scopeRefCount;
  }
}

// py: scope.py:20 `TRAVERSABLES = (exp.Query, exp.DDL, exp.DML)`
const TRAVERSABLES = [exp.Query, exp.DDL, exp.DML];

/**
 * py: scope.py:647 `traverse_scope(expression)` — walks an expression tree and BUILDS
 * the `Scope` tree, wiring `sources`, `parent`, and every `*_scopes` list the class's
 * own properties read.
 */
export function traverseScope(expression) {
  if (TRAVERSABLES.some((C) => expression instanceof C)) {
    return [..._traverseScope(new Scope(expression))];
  }
  return [];
}

/** py: scope.py:678 `build_scope(expression)` — `seq_get(traverse_scope(expression), -1)`. */
export function buildScope(expression) {
  return seqGet(traverseScope(expression), -1);
}

// py: scope.py:691 `_traverse_scope(scope)`.
function* _traverseScope(scope) {
  const expression = scope.expression;

  if (expression instanceof exp.Select) {
    yield* _traverseSelect(scope);
  } else if (expression instanceof exp.SetOperation) {
    yield* _traverseCtes(scope);
    yield* _traverseUnion(scope);
    return;
  } else if (expression instanceof exp.Subquery) {
    if (scope.isRoot) {
      yield* _traverseSelect(scope);
    } else {
      yield* _traverseSubqueries(scope);
    }
  } else if (expression instanceof exp.Table) {
    yield* _traverseTables(scope);
  } else if (expression instanceof exp.UDTF) {
    yield* _traverseUdtfs(scope);
  } else if (expression instanceof exp.DDL) {
    // py: `ddl_expression = expression.args.get("expression")`
    const ddlExpression = expression.args.expression;
    if (ddlExpression instanceof exp.Query) {
      yield* _traverseCtes(scope);
      yield* _traverseScope(new Scope(ddlExpression, null, null, null, ScopeType.ROOT, null, scope.cteSources));
    }
    return;
  } else if (expression instanceof exp.DML) {
    yield* _traverseCtes(scope);

    // Bare tables in relation position (e.g. UPDATE ... FROM t, DELETE / MERGE ... USING
    // t) aren't part of any query, so they're scoped as standalone tables; `_traverseTables`
    // also picks up any joins hanging off of them
    const relations = [];
    const from_ = expression.args.from_;

    if (from_ instanceof exp.From) relations.push(from_.this);

    const using = expression.args.using;
    if (Array.isArray(using)) relations.push(...using);
    else if (using instanceof exp.Expr) relations.push(using);

    for (const relation of relations) {
      if (relation instanceof exp.Table) {
        yield* _traverseScope(new Scope(relation, null, null, null, ScopeType.ROOT, null, scope.cteSources));
      }
    }

    for (const query of findAllInScope(expression, exp.Query)) {
      // This check ensures we don't yield the CTE/nested queries twice
      if (query.parent instanceof exp.CTE || query.parent instanceof exp.Subquery) continue;

      if (isFromOrJoin(query)) {
        const parent = query.parent;
        if (parent instanceof exp.Join && (parent.parent instanceof exp.Subquery || parent.parent instanceof exp.Table)) {
          // Scoped by the FROM-position relation (wrapper or table) it's joined to
          continue;
        }

        // A query in FROM/JOIN position (e.g. UPDATE ... FROM (SELECT ...) AS s) acts
        // like a derived table, so its scope stays rooted at the Subquery wrapper to
        // pick up the wrapper's alias, column list and joins
        yield* _traverseScope(new Scope(query, null, null, null, ScopeType.ROOT, null, scope.cteSources));
      } else {
        // Queries in value position (SET, WHERE, USING, ...) are scoped as subqueries,
        // e.g. so their columns can be correlated to the DML's target table
        yield* _traverseScope(scope.branch(query, ScopeType.SUBQUERY));
      }
    }
    return;
  } else {
    // deny:implicit_str sqlglot/optimizer/scope.py:761 — `%s` on `expression` calls
    // Python's `str(Expr)` (`__str__` -> `.sql()`); `.sql()` is the explicit equivalent.
    logger.warning(`Cannot traverse scope ${scope.expression.sql()} with type '${expression?.constructor?.name}'`);
    return;
  }

  yield scope;
}

// py: scope.py:767 `_traverse_select(scope)`.
function* _traverseSelect(scope) {
  yield* _traverseCtes(scope);
  yield* _traverseTables(scope);
  yield* _traverseSubqueries(scope);
}

// py: scope.py:773 `_traverse_union(scope)`.
function* _traverseUnion(scope) {
  let prevScope = null;
  const unionScopeStack = [scope];

  const setOp = scope.expression;
  // Access the args directly instead of the left/right properties, because set operation
  // operands aren't guaranteed to be Query nodes, e.g. in VALUES (1) UNION ALL SELECT 1
  const expressionStack = [setOp.expression, setOp.this];

  while (expressionStack.length) {
    const expression = expressionStack.pop();
    const unionScope = unionScopeStack[unionScopeStack.length - 1];

    const newScope = unionScope.branch(expression, ScopeType.UNION, null, null, null, unionScope.outerColumns);

    if (expression instanceof exp.SetOperation) {
      yield* _traverseCtes(newScope);

      unionScopeStack.push(newScope);
      expressionStack.push(expression.expression, expression.this);
      continue;
    }

    // py: `for scope in _traverse_scope(new_scope): yield scope` — the Python `for`
    // variable leaks its last value past the loop, which `union_scope.union_scopes =
    // [prev_scope, scope]` below then reads; `lastScope` makes that explicit in JS.
    let lastScope = null;
    for (const s of _traverseScope(newScope)) {
      yield s;
      lastScope = s;
    }

    if (prevScope) {
      unionScopeStack.pop();
      unionScope.unionScopes = [prevScope, lastScope];
      prevScope = unionScope;

      yield unionScope;
    } else {
      prevScope = lastScope;
    }
  }
}

// py: scope.py:813 `_traverse_ctes(scope)`.
function* _traverseCtes(scope) {
  const sources = new Map();

  for (const cte of scope.ctes) {
    const cteName = cte.alias;

    // if the scope is a recursive cte, it must be in the form of base_case UNION
    // recursive. thus the recursive scope is the first section of the union.
    const with_ = scope.expression.args.with_;
    if (with_ && with_.recursive) {
      const union = cte.this;

      if (union instanceof exp.SetOperation) {
        sources.set(cteName, scope.branch(union.this, ScopeType.CTE));
      }
    }

    let childScope = null;

    for (const cs of _traverseScope(
      scope.branch(cte.this, ScopeType.CTE, null, sources, null, cte.aliasColumnNames),
    )) {
      yield cs;
      childScope = cs;
    }

    // append the final child_scope yielded
    if (childScope) {
      sources.set(cteName, childScope);
      scope.cteScopes.push(childScope);
    }
  }

  for (const [k, v] of sources) scope.sources.set(k, v);
  for (const [k, v] of sources) scope.cteSources.set(k, v);
}

// py: scope.py:873 `_traverse_tables(scope)`.
function* _traverseTables(scope) {
  const sources = new Map();

  // Traverse FROMs, JOINs, and LATERALs in the order they are defined
  const expressions = [];
  const from_ = scope.expression.args.from_;
  if (from_) expressions.push(from_.this);

  for (const join of scope.expression.args.joins || []) expressions.push(join.this);

  if (scope.expression instanceof exp.Table || scope.expression instanceof exp.Subquery) {
    // A Subquery-rooted scope, e.g., the FROM clause of a DML statement, a DDL source or
    // a parenthesized query like (SELECT ...) LIMIT 1, scopes its own inner query as a
    // derived table
    expressions.push(scope.expression);
  }

  expressions.push(...(scope.expression.args.laterals || []));

  for (let i = 0; i < expressions.length; i++) {
    let expression = expressions[i];
    if (expression instanceof exp.Final) expression = expression.this;

    if (expression instanceof exp.Table) {
      const tableName = expression.name;
      const sourceName = expression.aliasOrName;

      if (scope.sources.has(tableName) && !expression.db) {
        // This is a reference to a parent source (e.g. a CTE), not an actual table,
        // unless it is pivoted, because then we get back a new table and hence a new
        // source.
        const pivots = expression.args.pivots;
        if (pivots && pivots.length) {
          // deny:operators sqlglot/optimizer/scope.py:905 — Python `pivots[-1]`;
          // `pivots[pivots.length - 1]` is the explicit equivalent.
          sources.set(pivots[pivots.length - 1].alias, expression);
        } else {
          sources.set(sourceName, scope.sources.get(tableName));
        }
      } else if (sources.has(sourceName)) {
        sources.set(findNewName(sources, tableName), expression);
      } else {
        sources.set(sourceName, expression);
      }

      // Make sure to not include the joins twice
      if (expression !== scope.expression) {
        for (const join of expression.args.joins || []) expressions.push(join.this);
      }

      continue;
    }

    if (!(expression instanceof exp.DerivedTable)) continue;

    const node = expression;

    let lateralSources;
    let scopeType;
    let scopes;

    if (expression instanceof exp.UDTF) {
      lateralSources = sources;
      scopeType = ScopeType.UDTF;
      scopes = scope.udtfScopes;
    } else if (isDerivedTable(expression)) {
      lateralSources = null;
      scopeType = ScopeType.DERIVED_TABLE;
      scopes = scope.derivedTableScopes;
      if (node !== scope.expression) {
        // The scope expression's own joins were already added above
        for (const join of node.args.joins || []) expressions.push(join.this);
      }
    } else {
      // Makes sure we check for possible sources in nested table constructs
      expressions.push(node.this);
      if (node !== scope.expression) {
        for (const join of node.args.joins || []) expressions.push(join.this);
      }
      continue;
    }

    let childScope = null;

    for (const cs of _traverseScope(
      scope.branch(node, scopeType, null, null, lateralSources, node.aliasColumnNames),
    )) {
      yield cs;
      childScope = cs;

      // Tables without aliases will be set as ""
      // This shouldn't be a problem once qualify_columns runs, as it adds aliases on
      // everything. Until then, this means that only a single, unaliased derived table
      // is allowed (rather, the latest one wins.
      sources.set(getSourceAlias(node), cs);
    }

    // append the final child_scope yielded
    if (childScope) {
      scopes.push(childScope);
      scope.tableScopes.push(childScope);
    }
  }

  for (const [k, v] of sources) scope.sources.set(k, v);
}

// py: scope.py:969 `_traverse_subqueries(scope)`.
function* _traverseSubqueries(scope) {
  for (const subquery of scope.subqueries) {
    let top = null;
    for (const cs of _traverseScope(scope.branch(subquery, ScopeType.SUBQUERY))) {
      yield cs;
      top = cs;
    }
    if (top !== null) scope.subqueryScopes.push(top);
  }
}

// py: scope.py:979 `_traverse_udtfs(scope)`.
function* _traverseUdtfs(scope) {
  let udtfExpressions;
  if (scope.expression instanceof exp.Unnest) {
    udtfExpressions = scope.expression.expressions;
  } else if (scope.expression instanceof exp.Lateral) {
    udtfExpressions = [scope.expression.this];
  } else {
    udtfExpressions = [];
  }

  const sources = new Map();
  for (const expression of udtfExpressions) {
    if (expression instanceof exp.Subquery) {
      let top = null;
      for (const cs of _traverseScope(
        scope.branch(expression, ScopeType.SUBQUERY, null, null, null, expression.aliasColumnNames),
      )) {
        yield cs;
        top = cs;
        sources.set(getSourceAlias(expression), cs);
      }

      if (top !== null) scope.subqueryScopes.push(top);
    }
  }

  for (const [k, v] of sources) scope.sources.set(k, v);
}
