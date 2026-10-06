// py: sqlglot/lineage.py @ 91119bc — WHOLE FILE (711 LOC).
//
// AIR-2121 (epic AIR-2092, "9.1 lineage.js") — stretch scope, outside the RULES
// optimizer pipeline. Builds a column-level lineage DAG (`Node`/`lineage()`/`to_node()`)
// plus an HTML/vis.js renderer (`GraphHTML`/`Node#toHtml`). All four named dependencies
// are real and load-bearing as used here: `qualify()` (`./optimizer/qualify.js`, R75),
// `Scope`/`buildScope`/`findAllInScope` (`./optimizer/scope.js`, R44/R46),
// `normalize_identifiers` (`./optimizer/normalize_identifiers.js`, R42), and
// `ensureSchema` (`./schema.js`, R41).
//
// `t.overload`/`TYPE_CHECKING` imports (`DialectType`, `GraphHTMLArgs`, `Unpack`,
// `Iterator`, `Mapping`, `Sequence`) are type-only and dropped, matching every other
// ported file's treatment of `Protocol`/`TypeVar`/`TYPE_CHECKING`.
//
// DIALECT RESOLUTION: unlike `qualify()` (which resolves `dialect` to an INSTANCE once
// up front — its own header explains why), this file keeps `dialect` as the raw,
// possibly-unresolved `DialectType` everywhere EXCEPT the one call into
// `normalize_identifiers`, which this port's own version requires an
// already-resolved `Dialect` instance for (see `normalize_identifiers.js`'s header on
// the import-cycle that forced that signature). `Dialect.get_or_raise` is called at
// that single site; every other call (`maybeParse`, `ensureSchema`, `qualify.qualify`,
// `.sql(dialect)`) accepts the raw type and resolves it internally, exactly as
// upstream's own `lineage()` passes `dialect` through unresolved.
//
// `id(x)`-KEYED DICTS: upstream's `cache`/`scope_meta` are keyed by `id(scope)` (plus,
// for `cache`, a composite tuple). This port's established idiom (`scope.js`,
// `annotate_types.js`, `eliminate_ctes.js`, `pushdown_projections.js`, `resolver.js`'s
// own class header) is to use the OBJECT ITSELF as a `Map` key — no separate
// id-allocator needed, since JS `Map` already compares keys by reference. `_scopeMeta`
// is `Map<Scope, [isStar, Map<name, select>]>` directly. `_cache`'s key is the TUPLE
// `(column, id(scope), scope_name, source_name, reference_node_name)`; `scope` becomes
// the outer `Map` key (object reference) and the remaining four fields are folded into
// one composite string for the inner `Map`, tagged by `column`'s JS type (`number` vs
// `string`) so a numeric `SetOperation` index and a same-spelled column NAME never
// collide, which a plain string-cast of `column` alone would risk.
//
// `Pivot#outputColumns` (`output_columns` upstream) returns a JS `Map`, not a plain
// object — confirmed from the real `src/expressions/query_methods.js` source, the same
// finding `qualify_columns.js`'s own header (R67) already made for three other call
// sites. `_pivot_chain_mapping`/`_pivot_column_mapping` below use `Map` throughout to
// match, including their own return values (upstream returns plain `dict`s, but this
// port's established practice — same file's own `_scope_meta`, `qualify_columns.js`'s
// `Resolver` caches — is `Map` wherever `.get`/`.has`/insertion-order iteration matter,
// which every one of these dicts' call sites does).
//
// PYTHON FOR-LOOP VARIABLE LEAK (same hazard class as `scope.js`'s `lastScope` and
// `pushdown_predicates.js`'s `nodes`, both already documented in PORT_PLAN.md):
// `to_node`'s `reference_node_name` parameter is reassigned INSIDE the `for c of
// sourceColumns` loop, but only by the `Scope`-source branch — the pivot-elif and leaf-
// else branches read whatever value is CURRENTLY held, which can be a value a PRIOR
// iteration's Scope-branch left behind (rather than the value the caller originally
// passed to this `to_node` call). Reproduced exactly with a single `let
// referenceNodeName` mutated in place across loop iterations, not re-destructured
// per-iteration, matching upstream's real (if easy-to-miss) data flow.
//
// `tag_sql` (generator.py:4794) was a `NotPorted` stub in `src/generator.js` — the SOLE
// blocker for `Node#toHtml`'s non-`Table` branch, which wraps `node.expression` in an
// `exp.Tag` to bold it in the rendered source. Fixed in this PR (one-line, additive,
// no dispatch-table change needed — `_buildDispatch`'s name-convention reflection
// already wires `Tag -> tag_sql` once the method exists).
//
// IMPLICIT `str(expr)` (corpus/deny/implicit_str.json, §4.6): upstream's `lineage.py:53`,
// `:54`, and `:287` each interpolate an `exp.Expr` into an f-string, which Python
// resolves via `Expression.__str__` -> `.sql()` with the DEFAULT dialect. This port's
// `Expr.prototype.toString()` is wired to the DEBUG REPR (`toS`/`__repr__`), not `.sql()`
// (see `src/_py/str.js`'s `pyStr`, which deliberately THROWS on an `Expr` for this exact
// reason), so each site below calls `.sql()` explicitly and carries a `// deny:
// implicit_str` acknowledgement marker rather than relying on template-literal coercion.
//
// @ported-ranges sqlglot/lineage.py 1-711

import * as exp from "./expressions/index.js";
import { maybeParse } from "./expressions/core.js";
import { SqlglotError } from "./errors.js";
import { PyValueError } from "./_py/errors.js";
import { Dialect } from "./dialects/dialect.js";
import { ensureSchema } from "./schema.js";
import { qualify } from "./optimizer/qualify.js";
import { normalize_identifiers } from "./optimizer/normalize_identifiers.js";
import { Scope, ScopeType, buildScope, findAllInScope } from "./optimizer/scope.js";
import { logger } from "./logging.js";

// py: expressions/query.py:2165 `UNWRAPPED_QUERIES = (Select, SetOperation)` — not
// exported from `scope.js` (it's a private module constant there, built lazily as a
// function for the same import-order-safety reason `scope.js`'s own copy is: avoid
// reading `exp.Select`/`exp.SetOperation` before `expressions/index.js` has finished
// installing them). Mirrors that exact idiom rather than importing a private binding.
const UNWRAPPED_QUERIES = () => [exp.Select, exp.SetOperation];

// A plain object or a `Map` both occur as caller-supplied `sources`; normalize to
// entries once, matching `expressions/builders.js`'s own private `entries()` helper
// (not exported, so this is a local copy of the same one-liner, not a new import).
const entries = (value) => (value instanceof Map ? value : Object.entries(value || {}));

/**
 * py: lineage.py:24 `class Node` — `@dataclass(frozen=True)`.
 *
 * A node in a DAG representing the lineage of a column.
 *
 * `frozen=True` prevents FIELD reassignment after construction; it does not make
 * `downstream`/`payload` immutable containers, and both are mutated in place
 * (`.downstream.append(...)`, `.payload[...] = ...`) by `to_node()` and caller `on_node`
 * hooks below. Nothing in this file ever reassigns a `Node`'s own fields post-
 * construction, so a plain mutable class (no `Object.freeze`) is observationally
 * identical and is what every other options-object-constructed node type in this port
 * already uses.
 *
 * @property {string} name
 * @property {exp.Expr} expression
 * @property {exp.Expr} source
 * @property {Node[]} downstream
 * @property {string} sourceName
 * @property {string} referenceNodeName
 * @property {object} payload Caller-injected per-node data, populated via the
 *   `onNode` hook on `lineage()`.
 */
export class Node {
  constructor(options = {}) {
    const {
      name,
      expression,
      source,
      downstream = [],
      sourceName = "",
      referenceNodeName = "",
      payload = {},
    } = options;
    this.name = name;
    this.expression = expression;
    this.source = source;
    this.downstream = downstream;
    this.sourceName = sourceName;
    this.referenceNodeName = referenceNodeName;
    this.payload = payload;
  }

  /**
   * py: lineage.py:35 `walk`. Iterative pre-order DAG walk (stack-based DFS): children
   * are pushed in REVERSED order so popping the stack visits them left-to-right, and
   * `visited` dedupes by Node identity (upstream: `id(node)`; a JS `Set` of the Node
   * objects themselves is the direct equivalent, no id-allocator needed).
   *
   * @returns {IterableIterator<Node>}
   */
  *walk() {
    const visited = new Set();
    const queue = [this];
    while (queue.length) {
      const node = queue.pop();
      if (visited.has(node)) continue;
      visited.add(node);
      yield node;
      queue.push(...[...node.downstream].reverse());
    }
  }

  /**
   * py: lineage.py:47 `to_html`.
   *
   * @param {*} [dialect]
   * @param {{imports?: boolean, options?: object}} [opts]
   * @returns {GraphHTML}
   */
  toHtml(dialect = null, opts = {}) {
    const nodes = {};
    const edges = [];

    // `id(node)` (upstream) must survive a JSON round-trip for vis.js, so a plain
    // object reference cannot stand in for it here the way this file's other
    // `id()`-replacements do; a sequential integer allocator scoped to this one call is
    // the direct, JSON-serializable equivalent (unique and stable for the lifetime of
    // this walk, which is all `id()` ever guaranteed upstream too).
    const nodeIds = new Map();
    let nextId = 0;
    const idOf = (n) => {
      if (!nodeIds.has(n)) nodeIds.set(n, nextId++);
      return nodeIds.get(n);
    };

    for (const node of this.walk()) {
      let label;
      let title;
      let group;

      if (node.expression instanceof exp.Table) {
        // deny:implicit_str sqlglot/lineage.py:53
        label = `FROM ${node.expression.this.sql()}`;
        // deny:implicit_str sqlglot/lineage.py:54
        title = `<pre>SELECT ${node.name} FROM ${node.expression.this.sql()}</pre>`;
        group = 1;
      } else {
        label = node.expression.sql(dialect, { pretty: true });
        const source = node.source
          .transform(
            (n) => (n === node.expression ? new exp.Tag({ this: n, prefix: "<b>", postfix: "</b>" }) : n),
            { copy: false },
          )
          .sql(dialect, { pretty: true });
        title = `<pre>${source}</pre>`;
        group = 0;
      }

      const nodeId = idOf(node);
      nodes[nodeId] = { id: nodeId, label, title, group };

      for (const d of node.downstream) {
        edges.push({ from: nodeId, to: idOf(d) });
      }
    }
    return new GraphHTML(nodes, edges, opts);
  }
}

/**
 * py: lineage.py:89 `lineage`. The two `@t.overload` declarations (py:81-86) are
 * type-only and dropped.
 *
 * Build the lineage graph for a SQL query.
 *
 * If `column` is given, returns the lineage Node for that single output column.
 * If `column` is `null`, returns an object mapping every top-level output column name
 * to its lineage Node (with a shared cache so cross-column work is deduplicated).
 *
 * @param {string|exp.Column|null} column The column to build the lineage for. Pass
 *   `null` to get all output columns.
 * @param {string|exp.Expr} sql The SQL string or expression.
 * @param {{
 *   schema?: *,
 *   sources?: Object<string, string|exp.Expr>|Map<string, string|exp.Expr>,
 *   dialect?: *,
 *   scope?: Scope|null,
 *   trimSelects?: boolean,
 *   copy?: boolean,
 *   onNode?: ((node: Node) => void)|null,
 * }} [options] `**kwargs` beyond the named options above are forwarded to the
 *   qualification optimizer (`qualify()`'s own options surface).
 * @returns {Node|Object<string, Node>} A `Node` when `column` is provided, or an
 *   object mapping name -> `Node` when `column` is `null`.
 */
export function lineage(column, sql, options = {}) {
  const {
    schema: schemaOption = null,
    sources = null,
    dialect = null,
    scope: scopeOption = null,
    trimSelects = true,
    copy = true,
    onNode = null,
    ...kwargs
  } = options;

  let expression = maybeParse(sql, { copy, dialect });

  if (sources) {
    const sourcesMap = new Map(
      [...entries(sources)].map(([k, v]) => [k, maybeParse(v, { copy, dialect })]),
    );
    expression = exp.expand(expression, sourcesMap, { dialect, copy });
  }

  const schema = ensureSchema(schemaOption, { dialect });

  let scope = scopeOption;
  if (!scope) {
    expression = qualify(expression, {
      dialect,
      schema,
      // py: `**{"validate_qualify_columns": False, "identify": False, **kwargs}` —
      // `kwargs` is spread AFTER these two defaults, so a caller explicitly passing
      // either camelCase option through `**kwargs` overrides this function's own
      // default, exactly as the Python dict-merge order does.
      validateQualifyColumns: false,
      identify: false,
      ...kwargs,
    });
    scope = buildScope(expression);
  }

  if (!scope) {
    throw new SqlglotError("Cannot build lineage, sql must be SELECT");
  }

  const selectable = scope.expression;
  if (!(selectable instanceof exp.Selectable)) {
    throw new SqlglotError("Cannot build lineage, sql must be a query");
  }

  const cache = new Map();
  const scopeMeta = new Map();

  if (column !== null && column !== undefined) {
    const columnName = normalize_identifiers(column, Dialect.get_or_raise(dialect)).name;
    if (!selectable.selects.some((select) => select.aliasOrName === columnName)) {
      throw new SqlglotError(`Cannot find column '${columnName}' in query.`);
    }

    return to_node(columnName, scope, dialect, {
      trimSelects,
      schema,
      _cache: cache,
      _scopeMeta: scopeMeta,
      onNode,
    });
  }

  const result = {};
  for (const sel of selectable.selects) {
    const name = sel.aliasOrName;
    if (!name) {
      throw new SqlglotError(`Cannot fetch lineage for unnamed projection: ${sel.sql(dialect)}.`);
    }

    result[name] = to_node(name, scope, dialect, {
      trimSelects,
      schema,
      _cache: cache,
      _scopeMeta: scopeMeta,
      onNode,
    });
  }

  return result;
}

/**
 * py: lineage.py:196 `to_node`.
 *
 * @param {string|number} column
 * @param {Scope} scope
 * @param {*} dialect
 * @param {{
 *   scopeName?: string|null,
 *   upstream?: Node|null,
 *   sourceName?: string|null,
 *   referenceNodeName?: string|null,
 *   trimSelects?: boolean,
 *   schema?: *,
 *   _cache?: Map<Scope, Map<string, Node>>|null,
 *   _scopeMeta?: Map<Scope, [boolean, Map<string, exp.Expr>]>|null,
 *   onNode?: ((node: Node) => void)|null,
 * }} [options]
 * @returns {Node}
 */
export function to_node(column, scope, dialect, options = {}) {
  const {
    scopeName = null,
    sourceName = null,
    trimSelects = true,
    schema = null,
    _cache = null,
    _scopeMeta = null,
    onNode = null,
  } = options;
  // `upstream` and `referenceNodeName` are reassigned below (SetOperation branch;
  // Scope-source branch inside the `for c of sourceColumns` loop, respectively) --
  // see this file's header on the `referenceNodeName` for-loop-variable-leak hazard.
  let upstream = options.upstream ?? null;
  let referenceNodeName = options.referenceNodeName ?? null;

  const cacheKey = JSON.stringify([typeof column, column, scopeName, sourceName, referenceNodeName]);

  if (_cache !== null) {
    const scopeCache = _cache.get(scope);
    const cachedNode = scopeCache && scopeCache.get(cacheKey);
    if (cachedNode) {
      if (upstream) upstream.downstream.push(cachedNode);
      return cachedNode;
    }
  }

  const setCache = (node) => {
    if (_cache === null) return;
    let scopeCache = _cache.get(scope);
    if (!scopeCache) {
      scopeCache = new Map();
      _cache.set(scope, scopeCache);
    }
    scopeCache.set(cacheKey, node);
  };

  // Find the specific select clause that is the source of the column we want.
  // This can either be a specific, named select or a generic `*` clause.
  const selectable = scope.expression;
  let select;
  if (typeof column === "number") {
    if (column >= selectable.selects.length) {
      throw new SqlglotError(
        `Cannot find column's source with index ${column} in query: ${selectable.sql(dialect)}`,
      );
    }
    select = selectable.selects[column];
  } else if (_scopeMeta === null) {
    select = selectable.selects.find((s) => s.aliasOrName === column)
      ?? (selectable.isStar ? new exp.Star() : scope.expression);
  } else {
    let meta = _scopeMeta.get(scope);
    if (!meta) {
      const selectByName = new Map();
      for (const sel of selectable.selects) {
        if (!selectByName.has(sel.aliasOrName)) selectByName.set(sel.aliasOrName, sel);
      }
      meta = [selectable.isStar, selectByName];
      _scopeMeta.set(scope, meta);
    }
    const [isStar, selectByName] = meta;
    select = selectByName.get(column) ?? (isStar ? new exp.Star() : scope.expression);
  }

  if (scope.expression instanceof exp.Subquery) {
    for (const innerScope of scope.subqueryScopes) {
      const result = to_node(column, innerScope, dialect, {
        upstream, sourceName, referenceNodeName, trimSelects, schema, _cache, _scopeMeta, onNode,
      });
      // Skip caching a passed-in upstream returned by an inner SetOp: a sibling call
      // at the same key with that node as its upstream would otherwise self-loop on
      // the cache hit.
      if (result !== upstream) setCache(result);
      return result;
    }
  }

  if (scope.expression instanceof exp.SetOperation) {
    const name = scope.expression.constructor.name.toUpperCase();
    const createdSetop = upstream === null;
    upstream = upstream || new Node({ name, source: scope.expression, expression: select });

    let index;
    if (typeof column === "number") {
      index = column;
    } else {
      index = selectable.selects.findIndex((s) => s.aliasOrName === column || s.isStar);
    }

    if (index === -1) {
      // deny:implicit_str sqlglot/lineage.py:287
      throw new PyValueError(`Could not find ${column} in ${scope.expression.sql()}`);
    }

    for (const s of scope.unionScopes) {
      to_node(index, s, dialect, {
        upstream, sourceName, referenceNodeName, trimSelects, schema, _cache, _scopeMeta, onNode,
      });
    }

    if (createdSetop) setCache(upstream);
    if (createdSetop && onNode) onNode(upstream);
    return upstream;
  }

  // For better ergonomics in our node labels, replace the full select with a version
  // that has only the column we care about.
  //   "x", SELECT x, y FROM foo  =>  "x", SELECT x FROM foo
  const source = trimSelects && scope.expression instanceof exp.Select
    ? scope.expression.select(select, { append: false })
    : scope.expression;

  // Create the node for this step in the lineage chain, and attach it to the previous one.
  const node = new Node({
    name: scopeName ? `${scopeName}.${column}` : String(column),
    source,
    expression: select,
    sourceName: sourceName || "",
    referenceNodeName: referenceNodeName || "",
  });

  if (upstream) upstream.downstream.push(node);

  const subqueryScopes = new Map(scope.subqueryScopes.map((sq) => [sq.expression, sq]));

  for (const subquery of findAllInScope(select, ...UNWRAPPED_QUERIES())) {
    const subqueryScope = subqueryScopes.get(subquery);
    if (!subqueryScope) {
      logger.warning(`Unknown subquery scope: ${subquery.sql(dialect)}`);
      continue;
    }

    for (const name of subquery.namedSelects) {
      to_node(name, subqueryScope, dialect, {
        upstream: node, trimSelects, schema, _cache, _scopeMeta, onNode,
      });
    }
  }

  // if the select is a star add all scope sources as downstreams
  if (select instanceof exp.Star) {
    for (const src of scope.sources.values()) {
      const srcExpr = src instanceof Scope ? src.expression : src;
      const starNode = new Node({ name: select.sql(null, { comments: false }), source: srcExpr, expression: srcExpr });
      node.downstream.push(starNode);
      if (onNode) onNode(starNode);
    }
  }

  // Find all columns that went into creating this one to list their lineage nodes.
  const sourceColumns = new Set(findAllInScope(select, exp.Column));

  // If the source is a UDTF find columns used in the UDTF to generate the table
  let derivedTables;
  if (source instanceof exp.UDTF) {
    for (const c of source.findAll(exp.Column)) sourceColumns.add(c);
    derivedTables = [...scope.sources.values()]
      .filter((src) => src instanceof Scope && src.isDerivedTable && src.expression.parent)
      .map((src) => src.expression.parent);
  } else {
    derivedTables = scope.derivedTables;
  }

  const sourceNames = new Map();
  for (const dt of derivedTables) {
    if (dt.comments && dt.comments.length && dt.comments[0].startsWith("source: ")) {
      sourceNames.set(dt.alias, dt.comments[0].trim().split(/\s+/)[1]);
    }
  }

  let pivots = scope.pivots;
  if (pivots.length && pivots[0].parent !== pivots[pivots.length - 1].parent) {
    // The scope's pivots only form a chain when they all hang off of the same source;
    // otherwise they can't be folded, so their columns degrade to unresolved leaves
    pivots = [];
  }

  let pivotRenames = new Map();
  let pivotColumnMapping = new Map();

  if (pivots.length) {
    [pivotRenames, pivotColumnMapping] = _pivot_chain_mapping(pivots, scope, schema);
  }

  for (const c of sourceColumns) {
    const table = c.table;
    const colSource = scope.sources.get(table);

    if (colSource instanceof Scope) {
      referenceNodeName = null;
      if (colSource.scopeType === ScopeType.DERIVED_TABLE && !sourceNames.has(table)) {
        referenceNodeName = table;
      } else if (colSource.scopeType === ScopeType.CTE) {
        const [selectedNode] = scope.selectedSources.get(table) || [null, null];
        referenceNodeName = selectedNode ? selectedNode.name : null;
      }

      // The table itself came from a more specific scope. Recurse into that one using
      // the unaliased column name.
      to_node(c.name, colSource, dialect, {
        scopeName: table,
        upstream: node,
        sourceName: sourceNames.get(table) || sourceName,
        referenceNodeName,
        trimSelects, schema, _cache, _scopeMeta, onNode,
      });
    } else if (pivots.length && pivots[pivots.length - 1].aliasOrName === c.table) {
      // Only the last operator in a chain names the resulting source
      const pivotParent = pivots[pivots.length - 1].parent;
      const downstreamColumns = [];

      const columnName = c.name;
      if (pivotColumnMapping.has(columnName)) {
        downstreamColumns.push(...pivotColumnMapping.get(columnName));
      } else {
        // The column is not in the pivot, so it must be an implicit column of the
        // pivoted source -- adapt column to be from the implicit pivoted source.
        downstreamColumns.push(
          exp.column(
            pivotRenames.get(c.name) ?? c.this,
            pivotParent ? pivotParent.aliasOrName : null,
          ),
        );
      }

      for (let downstreamColumn of downstreamColumns) {
        if (!downstreamColumn.table) {
          // Some dialects (e.g. bigquery) don't qualify the IN-list columns, but they
          // can only come from the pivoted source
          downstreamColumn = exp.column(
            downstreamColumn.this,
            pivotParent ? pivotParent.aliasOrName : null,
          );
        }

        const downstreamTable = downstreamColumn.table;
        let downstreamColSource = scope.sources.get(downstreamTable);
        if (downstreamColSource instanceof exp.Table && !downstreamColSource.db) {
          // A pivoted CTE reference maps to the raw table in `scope.sources`, so
          // recover the CTE's scope to keep tracing through it
          downstreamColSource = scope.cteSources.get(downstreamColSource.name) ?? downstreamColSource;
        }
        if (downstreamColSource instanceof Scope) {
          to_node(downstreamColumn.name, downstreamColSource, dialect, {
            scopeName: downstreamTable,
            upstream: node,
            sourceName: sourceNames.get(downstreamTable) || sourceName,
            referenceNodeName,
            trimSelects, schema, _cache, _scopeMeta, onNode,
          });
        } else {
          const colExpr = downstreamColSource || new exp.Placeholder();
          const pivotLeaf = new Node({
            name: downstreamColumn.sql(null, { comments: false }),
            source: colExpr,
            expression: colExpr,
          });
          node.downstream.push(pivotLeaf);
          if (onNode) onNode(pivotLeaf);
        }
      }
    } else {
      // The source is not a scope and the column is not in any pivot - we've reached
      // the end of the line. At this point, if a source is not found it means this
      // column's lineage is unknown. This can happen if the definition of a source
      // used in a query is not passed into the `sources` map.
      const colExpr = colSource || new exp.Placeholder();
      const leaf = new Node({ name: c.sql(null, { comments: false }), source: colExpr, expression: colExpr });
      node.downstream.push(leaf);
      if (onNode) onNode(leaf);
    }
  }

  setCache(node);

  if (onNode) onNode(node);

  return node;
}

/**
 * py: lineage.py:500 `_pre_pivot_columns`.
 *
 * The columns the first operator of a chain sees, taken from the projections of a
 * derived table or CTE source, or from the schema for a physical table. Returns an
 * empty list when they can't be determined (e.g. an unexpanded star), since anything
 * positional over them would silently shift.
 *
 * @param {exp.Pivot} pivot
 * @param {Scope} scope
 * @param {*} [schema]
 * @returns {string[]}
 */
function _pre_pivot_columns(pivot, scope, schema = null) {
  const parent = pivot.parent;
  let columns = [];
  if (parent instanceof exp.DerivedTable && parent.this instanceof exp.Query) {
    columns = parent.this.namedSelects;
  } else if (parent instanceof exp.Table) {
    const cteSource = !parent.db ? scope.cteSources.get(parent.name) : null;
    if (cteSource instanceof Scope && cteSource.expression instanceof exp.Query) {
      columns = cteSource.expression.namedSelects;
    } else if (schema !== null) {
      columns = [...schema.columnNames(parent, true)];
    }
  }

  return columns.includes("*") ? [] : columns;
}

/**
 * py: lineage.py:521 `_pivot_chain_mapping`.
 *
 * Fold a chain of (UN)PIVOT operators into a single view of its output, since each one
 * consumes the previous one's columns rather than the pivoted source's.
 *
 * Returns the composed output-name -> pre-chain-name renames (from alias column
 * lists), and the composed output-name -> source columns it derives from.
 *
 * @param {exp.Pivot[]} pivots
 * @param {Scope} scope
 * @param {*} [schema]
 * @returns {[Map<string, string>, Map<string, exp.Column[]>]}
 */
function _pivot_chain_mapping(pivots, scope, schema = null) {
  let available = _pre_pivot_columns(pivots[0], scope, schema);
  let renames = new Map();
  let mapping = new Map();

  for (const pivot of pivots) {
    // Renames are positional over the operator's full output, so they can only be
    // applied when the columns going into it are known
    const stepRenames = pivot.aliasColumnNames.length && available.length
      ? pivot.outputColumns(available)
      : new Map();
    let stepMapping = _pivot_column_mapping(pivot);
    if (stepRenames.size) {
      const filtered = new Map();
      for (const [post, pre] of stepRenames) {
        if (stepMapping.has(pre)) filtered.set(post, stepMapping.get(pre));
      }
      stepMapping = filtered;
    }

    // Columns this operator consumed may have been produced by an earlier one, or be
    // alias-list renames of passthroughs; resolve through what we've folded so far
    const resolve = (col) => {
      if (mapping.has(col.name)) return mapping.get(col.name);
      if (renames.has(col.name)) return [exp.column(renames.get(col.name))];
      return [col];
    };

    const composed = new Map();
    for (const [out, cols] of stepMapping) {
      composed.set(out, cols.flatMap(resolve));
    }

    // Whatever an earlier operator produced and this one didn't consume passes
    // through, under whatever name this operator's alias column list gives it
    const consumed = new Set();
    for (const cols of stepMapping.values()) for (const col of cols) consumed.add(col.name);

    const preToPost = new Map();
    for (const [post, pre] of stepRenames) preToPost.set(pre, post);

    for (const [out, cols] of mapping) {
      if (!consumed.has(out)) {
        const key = preToPost.has(out) ? preToPost.get(out) : out;
        if (!composed.has(key)) composed.set(key, cols);
      }
    }

    if (stepRenames.size) {
      const newRenames = new Map();
      for (const [post, pre] of stepRenames) {
        newRenames.set(post, renames.has(pre) ? renames.get(pre) : pre);
      }
      renames = newRenames;
    }
    mapping = composed;
    available = available.length ? [...pivot.outputColumns(available).keys()] : [];
  }

  return [renames, mapping];
}

/**
 * py: lineage.py:580 `_pivot_column_mapping`.
 *
 * Map each (UN)PIVOT output column name to the source columns it's derived from.
 *
 * @param {exp.Pivot} pivot
 * @returns {Map<string, exp.Column[]>}
 */
function _pivot_column_mapping(pivot) {
  const mapping = new Map();

  if (pivot.unpivot) {
    // UNPIVOT((v1, v2) FOR name IN ((a1, a2), (b1, b2))): each value column is derived
    // positionally from the IN-list entries, and the name column from all of them
    const valueColumns = [];
    for (const e of pivot.expressions) for (const identifier of e.findAll(exp.Identifier)) valueColumns.push(identifier);
    for (const valueColumn of valueColumns) mapping.set(valueColumn.name, []);

    for (const field of pivot.fields) {
      if (!(field instanceof exp.In)) continue;

      if (!mapping.has(field.this.name)) mapping.set(field.this.name, []);
      const nameColumns = mapping.get(field.this.name);
      for (const entry of field.expressions) {
        const entryColumns = [...entry.findAll(exp.Column)];
        nameColumns.push(...entryColumns);

        if (entryColumns.length === valueColumns.length) {
          for (let i = 0; i < valueColumns.length; i++) {
            mapping.get(valueColumns[i].name).push(entryColumns[i]);
          }
        } else {
          for (const valueColumn of valueColumns) {
            mapping.get(valueColumn.name).push(...entryColumns);
          }
        }
      }
    }

    return mapping;
  }

  // For each aggregation function, the pivot creates a new column for each field in
  // category combined with the aggfunc. So the columns parsed have this order:
  // cat_a_value_sum, cat_a, b_value_sum, b. Because of this step wise manner the
  // aggfunc 'sum(value) as value_sum' belongs to the column indices 0, 2, and the
  // aggfunc 'max(price)' without an alias belongs to the column indices 1, 3. Here,
  // only the columns used in the aggregations are of interest in the lineage, so
  // lookup the pivot column name by index and map that with the columns used in the
  // aggregation.
  //
  // Example: PIVOT (SUM(value) AS value_sum, MAX(price)) FOR category IN ('a' AS cat_a, 'b')
  const pivotColumns = pivot.args.columns;
  const pivotAggsCount = pivot.expressions.length;

  for (let i = 0; i < pivot.expressions.length; i++) {
    const agg = pivot.expressions[i];
    const aggCols = [...agg.findAll(exp.Column)];
    for (let colIndex = i; colIndex < pivotColumns.length; colIndex += pivotAggsCount) {
      // deny:operators sqlglot/lineage.py:627 -- plain Python LIST indexing (pivot's
      // own `columns` arg, a JS array here too via `pivot.args.columns`), not
      // `exp.Bracket` construction; the static scanner flags `[]` generically since
      // `.args` values CAN be Exprs, but `pivot_columns`/`pivotColumns` here is a
      // list of `exp.Identifier`, and `pivotColumns[colIndex]` reads one by position.
      mapping.set(pivotColumns[colIndex].name, aggCols);
    }
  }
  return mapping;
}

/**
 * py: lineage.py:631 `class GraphHTML`.
 *
 * Node to HTML generator using vis.js.
 *
 * https://visjs.github.io/vis-network/docs/network/
 *
 * @param {object} nodes
 * @param {object[]} edges
 * @param {{imports?: boolean, options?: object|null}} [opts]
 */
export class GraphHTML {
  constructor(nodes, edges, opts = {}) {
    const { imports = true, options = null } = opts;
    this.imports = imports;

    this.options = {
      height: "500px",
      width: "100%",
      layout: {
        hierarchical: {
          enabled: true,
          nodeSpacing: 200,
          sortMethod: "directed",
        },
      },
      interaction: {
        dragNodes: false,
        selectable: false,
      },
      physics: {
        enabled: false,
      },
      edges: {
        arrows: "to",
      },
      nodes: {
        font: "20px monaco",
        shape: "box",
        widthConstraint: {
          maximum: 300,
        },
      },
      ...(options || {}),
    };

    this.nodes = nodes;
    this.edges = edges;
  }

  toString() {
    const nodes = JSON.stringify(Object.values(this.nodes));
    const edges = JSON.stringify(this.edges);
    const options = JSON.stringify(this.options);
    const imports = this.imports
      ? `<script type="text/javascript" src="https://unpkg.com/vis-data@latest/peer/umd/vis-data.min.js"></script>
  <script type="text/javascript" src="https://unpkg.com/vis-network@latest/peer/umd/vis-network.min.js"></script>
  <link rel="stylesheet" type="text/css" href="https://unpkg.com/vis-network/styles/vis-network.min.css" />`
      : "";

    return `<div>
  <div id="sqlglot-lineage"></div>
  ${imports}
  <script type="text/javascript">
    var nodes = new vis.DataSet(${nodes})
    nodes.forEach(row => row["title"] = new DOMParser().parseFromString(row["title"], "text/html").body.childNodes[0])

    new vis.Network(
        document.getElementById("sqlglot-lineage"),
        {
            nodes: nodes,
            edges: new vis.DataSet(${edges})
        },
        ${options},
    )
  </script>
</div>`;
  }

  _repr_html_() {
    return this.toString();
  }
}
