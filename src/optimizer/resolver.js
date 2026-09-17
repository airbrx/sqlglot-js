// py: sqlglot/optimizer/resolver.py @ 91119bc — WHOLE FILE (431 LOC), the `Resolver`
// class: schema-based column-to-table resolution.
//
// Greenfield, same shape as R41's `schema.js` and R45's `optimize_joins.js`: nothing in
// the port imports this file yet. `qualify_columns.js` (AIR-2106, a separate future
// issue) will later re-export it for `pushdown_projections.js`'s use, so every public
// method is ported, not just the ones an as-yet-unwritten caller obviously needs.
//
// `Dialect` is imported directly from `dialects/dialect.js` (the same top-level import
// `schema.js` already uses safely) rather than deferred/pre-resolved the way
// `parser.js`'s `_resolveDialect` or `normalize_identifiers.js`'s fix had to
// (`dispatch-tables-can-be-empty-behind-green-metrics`-era circular-import trap):
// checked here that `dialects/dialect.js`'s own transitive imports (-> `parsers/base.js`
// -> `parser.js` -> `optimizer/scope.js`, `optimizer/normalize_identifiers.js`) never
// reach back to this file, and nothing currently imports `optimizer/resolver.js` at
// all, so there is no live cycle to create. Worth re-checking the moment
// `qualify_columns.js` lands, since THAT file is a plausible future link back into
// `parser.js`'s own transitive closure.
//
// Every `dict`/`Mapping` upstream reads via `.items()`/`in` is a JS `Map` here, not a
// plain object — the same reasoning `scope.js`'s class header and `schema.js`'s file
// header both give: a source/column name that happens to look like an integer string
// must not be silently reordered ahead of other keys the way a plain object would.
//
// Python list-truthiness note (recurs several times below, greppable class per
// `sqlglot-js-empty-array-truthy-vs-python-empty-list-falsy`): `source.args.get("pivots")`,
// `args.get("laterals")`, `args.get("joins")` etc. are falsy in Python when the list is
// EMPTY, not just when it's absent — a bare `source.args.pivots` truthiness check in JS
// would treat a present-but-empty array as truthy and diverge. Every such site below
// checks `.length` explicitly.

import * as exp from "../expressions/index.js";
import { Dialect } from "../dialects/dialect.js";
import { OptimizeError } from "../errors.js";
import { seqGet, SingleValuedMapping } from "../helper.js";
import { Scope } from "./scope.js";

/**
 * py: resolver.py:17 `class Resolver` — "Helper for resolving columns."
 *
 * This is a class so we can lazily load some things and easily share them across
 * functions.
 */
export class Resolver {
  // py: resolver.py:24 `__init__`.
  constructor(scope, schema, inferSchema = true) {
    this.scope = scope;
    this.schema = schema;
    this.dialect = schema.dialect || new Dialect();
    this._sourceColumns = null;
    this._unambiguousColumns = null;
    this._allColumns = null;
    this._inferSchema = inferSchema;
    this._getSourceColumnsCache = new Map();
    // Keyed by `(source, column.name)`, matching upstream's `(id(source), column.name)`
    // — a JS `Map` already compares object keys by reference (`SameValueZero`), so
    // `source` itself is the outer key with no separate id-allocator (same idiom
    // `scope.js`'s class header already established for `ref_count`/`_column_index`).
    this._columnTypeFromScopeCache = new Map();
  }

  /**
   * py: resolver.py:35 `get_table(column)`.
   *
   * Get the table for a column name.
   *
   * @param {string|object} column The column expression (or column name) to find the
   *   table for.
   * @returns {object|null} The table identifier if it can be found/inferred.
   */
  getTable(column) {
    const columnName = typeof column === "string" ? column : column.name;

    let tableName = this._getTableNameFromSources(columnName);

    if (!tableName && column instanceof exp.Column) {
      // Fall-back case: If we couldn't find the `table_name` from ALL of the sources,
      // attempt to disambiguate the column based on other characteristics e.g if this
      // column is in a join condition, we may be able to disambiguate based on the
      // source order.
      const joinContext = this._getColumnJoinContext(column);
      if (joinContext) {
        // In this case, the return value will be the join that _may_ be able to
        // disambiguate the column and we can use the source columns available at that
        // join to get the table name catch OptimizeError if column is still
        // ambiguous and try to resolve with schema inference below
        try {
          tableName = this._getTableNameFromSources(
            columnName,
            this._getAvailableSourceColumns(joinContext),
          );
        } catch (e) {
          if (!(e instanceof OptimizeError)) throw e;
        }
      }
    }

    if (!tableName && this._inferSchema) {
      const sourcesWithoutSchema = [];
      for (const [source, columns] of this._getAllSourceColumns()) {
        if (!columns.length || columns.includes("*")) sourcesWithoutSchema.push(source);
      }
      if (sourcesWithoutSchema.length === 1) tableName = sourcesWithoutSchema[0];
    }

    if (!this.scope.selectedSources.has(tableName)) {
      return exp.toIdentifier(tableName);
    }

    let node = this.scope.selectedSources.get(tableName)[0];

    if (node instanceof exp.Query) {
      while (node && node.alias !== tableName && node.parent) node = node.parent;
    }

    const nodeAlias = node.args.alias;
    if (nodeAlias) {
      return exp.toIdentifier(nodeAlias.this);
    }

    return exp.toIdentifier(tableName);
  }

  /** py: resolver.py:87 `all_columns` property — all available columns of all sources in this scope. */
  get allColumns() {
    if (this._allColumns === null) {
      this._allColumns = new Set();
      for (const columns of this._getAllSourceColumns().values()) {
        for (const column of columns) this._allColumns.add(column);
      }
    }
    return this._allColumns;
  }

  // py: resolver.py:96 `get_source_columns_from_set_op(expression)`.
  getSourceColumnsFromSetOp(expression) {
    if (expression instanceof exp.Select) return expression.namedSelects;
    if (expression instanceof exp.Subquery) return this.getSourceColumnsFromSetOp(expression.unnest());
    if (!(expression instanceof exp.SetOperation)) {
      // deny:implicit_str sqlglot/optimizer/resolver.py:102 — `%s`/f-string on
      // `expression` calls Python's `str(Expr)` (`__str__` -> `.sql()`); `.sql()` is
      // the explicit equivalent, since this port's `Expr.toString()` is the verbose
      // repr instead (R21).
      throw new OptimizeError(`Unknown set operation: ${expression.sql()}`);
    }

    const setOp = expression;

    // BigQuery specific set operations modifiers, e.g INNER UNION ALL BY NAME
    const onColumnList = setOp.args.on;

    let columns;
    if (onColumnList) {
      // The resulting columns are the columns in the ON clause:
      // {INNER | LEFT | FULL} UNION ALL BY NAME ON (col1, col2, ...)
      columns = onColumnList.map((col) => col.name);
    } else if (setOp.side || setOp.kind) {
      const side = setOp.side;
      const kind = setOp.kind;

      // Visit the children UNIONs (if any) in a post-order traversal
      const left = this.getSourceColumnsFromSetOp(setOp.this);
      const right = this.getSourceColumnsFromSetOp(setOp.expression);

      // We deduplicate while preserving insertion order, matching Python's
      // `dict.fromkeys(...)` idiom.
      if (side === "LEFT") {
        columns = left;
      } else if (side === "FULL") {
        columns = [...new Set([...left, ...right])];
      } else if (kind === "INNER") {
        // KNOWN, ACCEPTED DIVERGENCE: upstream computes this as a real Python `set`
        // intersection (`dict.fromkeys(left).keys() & dict.fromkeys(right).keys()`),
        // whose iteration order depends on CPython's hash-bucket layout (confirmed
        // interactively: the SAME two inputs order differently under
        // PYTHONHASHSEED=0 vs =1) — i.e. upstream's own result order is not a
        // documented contract, just an artifact of `set.__and__`. Reproducing that
        // exact bucket order in JS is neither meaningful nor practical, so this
        // preserves LEFT's insertion order instead (a defensible, deterministic
        // choice for "set intersection"), matching this project's existing precedent
        // for other CPython-implementation-detail orderings (see `Expr.__lt__`
        // returning a node / Timsort-tie-permutation note, PORT_PLAN.md Appendix
        // "Accepted red-team findings"). This branch also requires BigQuery's
        // `{INNER|LEFT|FULL} UNION ALL BY NAME` syntax, which this port's parser
        // cannot parse yet (same gap as `PIVOT`), so it has no live caller today.
        const rightSet = new Set(right);
        columns = [...new Set(left)].filter((c) => rightSet.has(c));
      }
    } else {
      columns = setOp.namedSelects;
    }

    return columns;
  }

  /**
   * py: resolver.py:133 `get_source_columns(name, only_visible=False)`.
   * Resolve the source columns for a given source `name`.
   */
  getSourceColumns(name, onlyVisible = false) {
    const cacheKey = `${name} ${onlyVisible}`;

    if (!this._getSourceColumnsCache.has(cacheKey)) {
      if (!this.scope.sources.has(name)) {
        throw new OptimizeError(`Unknown table: ${name}`);
      }

      let source = this.scope.sources.get(name);

      // A pivoted CTE reference is stored as an exp.Table in the scope sources (see
      // _traverse_tables in scope.py), but the underlying CTE Scope still holds the
      // column information we need to resolve pre-pivot columns.
      if (
        source instanceof exp.Table
        && !source.db
        && source.args.pivots && source.args.pivots.length
        && this.scope.cteSources.has(source.name)
      ) {
        source = this.scope.cteSources.get(source.name);
      }

      let columns;

      if (source instanceof exp.Table) {
        columns = this.schema.columnNames(source, onlyVisible);
      } else if (
        source instanceof Scope
        && (source.expression instanceof exp.Values
          || source.expression instanceof exp.Unnest
          || source.expression instanceof exp.Lateral)
      ) {
        const sourceExpr = source.expression;
        columns = sourceExpr.namedSelects;

        // in bigquery, unnest structs are automatically scoped as tables, so you can
        // directly select a struct field in a query. This handles the case where the
        // unnest is statically defined.
        if (this.dialect.UNNEST_COLUMN_ONLY && sourceExpr instanceof exp.Unnest) {
          if (!sourceExpr.type || sourceExpr.type.isType(exp.DType.UNKNOWN)) {
            const unnestExpr = seqGet(sourceExpr.expressions, 0);
            if (unnestExpr instanceof exp.Column && this.scope.parent) {
              const colType = this._getUnnestColumnType(unnestExpr, this.scope.parent);
              if (colType && colType.isType(exp.DType.ARRAY)) {
                const elementTypes = colType.expressions;
                if (elementTypes.length) sourceExpr.type = elementTypes[0].copy();
              } else if (colType) {
                sourceExpr.type = colType.copy();
              }
            }
          }

          columns.push(...this._structFieldNames(sourceExpr.type));
        } else if (sourceExpr instanceof exp.Lateral && sourceExpr.this instanceof exp.Explode) {
          const explodeCol = sourceExpr.this.this;

          // If the column is unqualified at this point, it couldn't be resolved when
          // this scope's children were qualified; disambiguating it here would require
          // enumerating this very source's columns, i.e recurse without bound
          if (explodeCol instanceof exp.Column && explodeCol.table && source.parent) {
            const colType = this._getUnnestColumnType(explodeCol, source.parent);
            columns.push(...this._structFieldNames(colType));
          }
        } else if (sourceExpr instanceof exp.Lateral && sourceExpr.this instanceof exp.Query) {
          columns = sourceExpr.this.namedSelects;
        }
      } else if (source instanceof Scope && source.expression instanceof exp.SetOperation) {
        columns = this.getSourceColumnsFromSetOp(source.expression);
      } else {
        const selectable = source.expression.assertIs(exp.Selectable);
        const select = seqGet(selectable.selects, 0);

        if (select instanceof exp.QueryTransform) {
          // https://spark.apache.org/docs/3.5.1/sql-ref-syntax-qry-select-transform.html
          const schemaArg = select.args.schema;
          columns = schemaArg ? schemaArg.expressions.map((c) => c.name) : ["key", "value"];
        } else {
          columns = selectable.namedSelects;
        }
      }

      const selectedPair = this.scope.selectedSources.get(name);
      const node = selectedPair ? selectedPair[0] : null;
      let columnAliases;
      if (node instanceof Scope) {
        columnAliases = node.expression.aliasColumnNames;
      } else if (node instanceof exp.Expr) {
        columnAliases = node.aliasColumnNames;
      } else {
        columnAliases = [];
      }

      if (columnAliases.length) {
        // If the source's columns are aliased, their aliases shadow the corresponding
        // column names. This can be expensive if there are lots of columns, so only do
        // this if column_aliases exist.
        const zipped = [];
        const n = Math.max(columns.length, columnAliases.length);
        for (let i = 0; i < n; i++) zipped.push(columnAliases[i] || columns[i]);
        columns = zipped;
      }

      this._getSourceColumnsCache.set(cacheKey, columns);
    }

    return this._getSourceColumnsCache.get(cacheKey);
  }

  // py: resolver.py:223 `_get_all_source_columns()`.
  _getAllSourceColumns() {
    if (this._sourceColumns === null) {
      this._sourceColumns = new Map();
      for (const [sourceName] of this.scope.selectedSources) {
        this._sourceColumns.set(sourceName, this.getSourceColumns(sourceName));
      }
      for (const [sourceName] of this.scope.lateralSources) {
        this._sourceColumns.set(sourceName, this.getSourceColumns(sourceName));
      }
    }
    return this._sourceColumns;
  }

  // py: resolver.py:233 `_get_table_name_from_sources(column_name, source_columns=None)`.
  _getTableNameFromSources(columnName, sourceColumns = null) {
    let unambiguousColumns;
    if (!sourceColumns || sourceColumns.size === 0) {
      // If not supplied, get all sources to calculate unambiguous columns
      if (this._unambiguousColumns === null) {
        this._unambiguousColumns = this._getUnambiguousColumns(this._getAllSourceColumns());
      }
      unambiguousColumns = this._unambiguousColumns;
    } else {
      unambiguousColumns = this._getUnambiguousColumns(sourceColumns);
    }

    return unambiguousColumns.get(columnName);
  }

  /**
   * py: resolver.py:249 `_get_column_join_context(column)`.
   * Check if a column participating in a join can be qualified based on the source order.
   */
  _getColumnJoinContext(column) {
    const args = this.scope.expression.args;
    const joins = args.joins;

    if (
      !joins || !joins.length
      || (args.laterals && args.laterals.length)
      || (args.pivots && args.pivots.length)
    ) {
      // Feature gap: We currently don't try to disambiguate columns if other sources
      // (e.g laterals, pivots) exist alongside joins
      return null;
    }

    const joinAncestor = column.findAncestor(exp.Join, exp.Select);

    if (
      joinAncestor instanceof exp.Join
      && this.scope.selectedSources.has(joinAncestor.aliasOrName)
    ) {
      // Ensure that the found ancestor is a join that contains an actual source,
      // e.g in Clickhouse `b` is an array expression in `a ARRAY JOIN b`
      return joinAncestor;
    }

    return null;
  }

  /**
   * py: resolver.py:273 `_get_available_source_columns(join_ancestor)`.
   *
   * Get the source columns that are available at the point where a column is referenced.
   *
   * For columns in JOIN conditions, this only includes tables that have been joined
   * up to that point. Example:
   *
   * ```
   * SELECT * FROM t_1 INNER JOIN ... INNER JOIN t_n ON t_1.a = c INNER JOIN t_n+1 ON ...
   * ```                                                        ^
   *                                                            |
   *                                 +----------------------------------+
   *                                 |
   *                                 v
   * The unqualified column `c` is not ambiguous if no other sources up until that
   * join i.e t_1, ..., t_n, contain a column named `c`.
   */
  _getAvailableSourceColumns(joinAncestor) {
    const args = this.scope.expression.args;

    // Collect tables in order: FROM clause tables + joined tables up to current join
    const fromName = args.from_.aliasOrName;
    const availableSources = new Map();
    availableSources.set(fromName, this.getSourceColumns(fromName));

    for (const join of args.joins.slice(0, joinAncestor.index + 1)) {
      availableSources.set(join.aliasOrName, this.getSourceColumns(join.aliasOrName));
    }

    return availableSources;
  }

  /**
   * py: resolver.py:302 `_get_unambiguous_columns(source_columns)`.
   *
   * Find all the unambiguous columns in sources.
   *
   * @param {Map<string, Array<string>>} sourceColumns Mapping of names to source columns.
   * @returns {Map<string, string>|SingleValuedMapping} Mapping of column name to source name.
   */
  _getUnambiguousColumns(sourceColumns) {
    if (!sourceColumns || sourceColumns.size === 0) return new Map();

    const sourceColumnsPairs = [...sourceColumns];

    const [firstTable, firstColumns] = sourceColumnsPairs[0];

    if (sourceColumnsPairs.length === 1) {
      // Performance optimization - avoid copying first_columns if there is only one table.
      return new SingleValuedMapping(firstColumns, firstTable);
    }

    // For BigQuery UNNEST_COLUMN_ONLY, build a mapping of original UNNEST aliases
    // from alias.columns[0] to their source names. This is used to resolve shadowing
    // where an UNNEST alias shadows a column name from another table.
    const unnestOriginalAliases = new Map();
    if (this.dialect.UNNEST_COLUMN_ONLY) {
      for (const [sourceName, source] of this.scope.sources) {
        const sourceExpr = source.expression;
        const aliasArg = sourceExpr instanceof exp.Unnest ? sourceExpr.args.alias : null;
        if (sourceExpr instanceof exp.Unnest && aliasArg && aliasArg.columns.length) {
          unnestOriginalAliases.set(aliasArg.columns[0].name, sourceName);
        }
      }
    }

    const unambiguousColumns = new Map();
    for (const col of firstColumns) unambiguousColumns.set(col, firstTable);
    const allColumns = new Set(unambiguousColumns.keys());

    for (const [table, columns] of sourceColumnsPairs.slice(1)) {
      const unique = new Set(columns);
      const ambiguous = new Set([...allColumns].filter((c) => unique.has(c)));
      for (const c of columns) allColumns.add(c);

      for (const column of ambiguous) {
        if (unnestOriginalAliases.has(column)) {
          unambiguousColumns.set(column, unnestOriginalAliases.get(column));
          continue;
        }

        unambiguousColumns.delete(column);
      }
      for (const column of unique) {
        if (!ambiguous.has(column)) unambiguousColumns.set(column, table);
      }
    }

    return unambiguousColumns;
  }

  // py: resolver.py:359 `_struct_field_names(col_type)`.
  _structFieldNames(colType) {
    if (colType && colType.isType(exp.DType.ARRAY)) {
      colType = seqGet(colType.expressions, 0);
    }

    return colType && colType.isType(exp.DType.STRUCT)
      ? colType.expressions.map((k) => k.name)
      : [];
  }

  /**
   * py: resolver.py:369 `_get_unnest_column_type(column, scope)`.
   *
   * Get the type of a column being unnested/exploded, tracing through CTEs/subqueries
   * to find the base table.
   */
  _getUnnestColumnType(column, scope) {
    // if column is qualified, use that table, otherwise disambiguate using the resolver
    let tableName;
    if (column.table) {
      tableName = column.table;
    } else {
      // use the parent scope's resolver to disambiguate the column
      const parentResolver = new Resolver(scope, this.schema, this._inferSchema);
      const tableIdentifier = parentResolver.getTable(column);
      if (!tableIdentifier) return null;
      tableName = tableIdentifier.name;
    }

    const source = scope.sources.get(tableName);
    return source ? this._getColumnTypeFromScope(source, column) : null;
  }

  /**
   * py: resolver.py:394 `_get_column_type_from_scope(source, column)`.
   *
   * Get a column's type by tracing through scopes/tables to find the base table.
   */
  _getColumnTypeFromScope(source, column) {
    // A single source can be reachable through many paths of a scope DAG (e.g. a CTE
    // referenced by several other CTEs). The schema and scope are immutable during
    // qualification, so the type of `column` under `source` depends only on
    // `(source, column name)`; memoize it to walk each source once.
    let cached = this._columnTypeFromScopeCache.get(source);
    if (cached && cached.has(column.name)) {
      return cached.get(column.name);
    }

    // None is a valid result if DataType could not be determined!
    let result = null;
    if (source instanceof exp.Table) {
      // base table - get the column type from schema
      const colType = this.schema.getColumnType(source, column);
      if (colType && !colType.isType(exp.DType.UNKNOWN)) result = colType;
    } else if (source instanceof Scope) {
      // iterate over all sources in the scope
      for (const nestedSource of source.sources.values()) {
        const nestedType = this._getColumnTypeFromScope(nestedSource, column);
        if (nestedType && !nestedType.isType(exp.DType.UNKNOWN)) {
          result = nestedType;
          break;
        }
      }
    }

    if (!cached) {
      cached = new Map();
      this._columnTypeFromScopeCache.set(source, cached);
    }
    cached.set(column.name, result);
    return result;
  }
}
