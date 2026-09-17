// py: sqlglot/optimizer/qualify_tables.py @ 91119bc — WHOLE FILE (244 LOC).
//
// Genuinely greenfield: nothing in this port calls `qualify_tables` yet (the `qualify()`
// orchestrator that wires this and `isolate_table_selects.js` together is AIR-2108, a
// separate follow-up issue). Same shape `schema.js` (R41) and `optimize_joins.js` (R45)
// already established for this repo — its own new scenario-driven oracle is the only
// differential signal it has ever had.
//
// All three named dependencies are real: `Scope`/`traverse_scope` (`./scope.js`, landed
// R44/R46), `normalize_identifiers` (`./normalize_identifiers.js`, landed R42), and
// `helper.name_sequence`/`seq_get`/`ensure_list` (all three already ported in
// `../helper.js` as `nameSequence`/`seqGet`/`ensureList` — nothing new needed there).
//
// `Dialect` is imported directly from `../dialects/dialect.js`, the same way
// `../schema.js` already does: this file has no importer yet, and `dialect.js` does not
// (and, being the settings/registry root, structurally cannot) import this file back, so
// there is no cycle to route around the way `normalize_identifiers.js`'s own header
// documents for `parser.js`'s one real caller.
//
// Two Python-truthiness traps this file's own logic depends on getting right (both
// already named in PORT_PLAN.md as a recurring defect class — R37/R38's "JS array/Map
// truthy vs Python empty-collection falsy"):
//   1. `columns` (a JS array) in `_set_alias` -- `if columns:` is false for `[]`, so the
//      port checks `columns && columns.length`, not bare truthiness.
//   2. `canonical_aliases` (a JS `Map`, chosen over a plain object for the same
//      numeric-looking-alias-name hazard `schema.js`/`scope.js` already document) in the
//      final column-rewrite loop -- `if canonical_aliases and ...` is false for an EMPTY
//      Python dict, so the port checks `canonical_aliases.size > 0`, not bare truthiness
//      (a `Map` instance, like any JS object, is always truthy regardless of size).

import * as exp from "../expressions/index.js";
import { Dialect } from "../dialects/dialect.js";
import { nameSequence, seqGet, ensureList } from "../helper.js";
import { normalize_identifiers } from "./normalize_identifiers.js";
import { Scope, traverseScope } from "./scope.js";

/**
 * py: qualify_tables.py:16 `qualify_tables(expression, db=None, catalog=None,
 * on_qualify=None, dialect=None, canonicalize_table_aliases=False)`.
 *
 * Rewrite sqlglot AST to have fully qualified tables. Join constructs such as
 * (t1 JOIN t2) AS t will be expanded into (SELECT * FROM t1 AS t1, t2 AS t2) AS t.
 *
 * Example:
 *   qualify_tables(parse_one("SELECT 1 FROM tbl"), { db: "db" }).sql()
 *   -> "SELECT 1 FROM db.tbl AS tbl"
 *
 *   qualify_tables(parse_one("SELECT 1 FROM (t1 JOIN t2) AS t")).sql()
 *   -> "SELECT 1 FROM (SELECT * FROM t1 AS t1, t2 AS t2) AS t"
 *
 * @param {exp.Expr} expression Expr to qualify
 * @param {{
 *   db?: string|exp.Identifier|null,
 *   catalog?: string|exp.Identifier|null,
 *   onQualify?: ((table: exp.Table) => void)|null,
 *   dialect?: *,
 *   canonicalizeTableAliases?: boolean,
 * }} [options]
 * @returns {exp.Expr} The qualified expression.
 */
export function qualify_tables(expression, options = {}) {
  const onQualify = options.onQualify ?? null;
  const canonicalizeTableAliases = options.canonicalizeTableAliases ?? false;

  const dialect = Dialect.get_or_raise(options.dialect ?? null);
  const next_alias_name = nameSequence("_");

  // py: `if db := db or None:` -- reassigns AND checks truthiness, not `is not None`.
  let db = options.db || null;
  if (db) {
    db = exp.parseIdentifier(db, dialect);
    db.meta.is_table = true;
    db = normalize_identifiers(db, dialect);
  }
  let catalog = options.catalog || null;
  if (catalog) {
    catalog = exp.parseIdentifier(catalog, dialect);
    catalog.meta.is_table = true;
    catalog = normalize_identifiers(catalog, dialect);
  }

  // py: qualify_tables.py:62 `_qualify(table)`.
  function _qualify(table) {
    if (table.this instanceof exp.Identifier) {
      if (db && !table.args.db) table.set("db", db.copy());
      if (catalog && !table.args.catalog && table.args.db) table.set("catalog", catalog.copy());
    }
  }

  if ((db || catalog) && !(expression instanceof exp.Query)) {
    const with_ = expression.args.with_ || new exp.With();
    const cte_names = new Set(with_.expressions.map((cte) => cte.aliasOrName));

    for (const node of expression.walk(true, (n) => n instanceof exp.Query)) {
      if (node instanceof exp.Table && !cte_names.has(node.name)) {
        _qualify(node);
      }
    }
  }

  /**
   * py: qualify_tables.py:77 `_set_alias(expression, canonical_aliases, target_alias=None,
   * scope=None, normalize=False, columns=None)`.
   *
   * Every call site below uses keyword args upstream; ported as an options object here
   * (PORT_PLAN.md R18's "keyword-only-arg-passed-positionally" defect class) rather than
   * as five positional parameters a future edit could silently reorder.
   */
  function _set_alias(expression, canonical_aliases, opts = {}) {
    const { targetAlias = null, scope = null, normalize = false, columns = null } = opts;
    const alias = expression.args.alias || new exp.TableAlias();

    let new_alias_name;
    if (canonicalizeTableAliases) {
      new_alias_name = next_alias_name();
      canonical_aliases.set(alias.name || targetAlias || "", new_alias_name);
    } else if (!alias.name) {
      new_alias_name = targetAlias || next_alias_name();
      if (normalize && targetAlias) {
        new_alias_name = normalize_identifiers(new_alias_name, dialect).name;
      }
    } else {
      return;
    }

    alias.set("this", exp.toIdentifier(new_alias_name));

    if (columns && columns.length) {
      alias.set(
        "columns",
        columns.map((c) => (typeof c === "string" ? exp.toIdentifier(c) : c.copy())),
      );
    }

    expression.set("alias", alias);

    if (scope) {
      scope.renameSource(null, new_alias_name);
    }
  }

  for (const scope of traverseScope(expression)) {
    const parent = scope.parent;
    const local_columns = scope.localColumns;
    const canonical_aliases = new Map();

    const queries = [...scope.subqueries];

    // Subquery wrappers around a DML / DDL query fragment, e.g., a CREATE FUNCTION body or
    // an UPDATE's SET subquery, don't belong to any scope, so they aren't collected above
    if (scope.isRoot && scope.expression instanceof exp.Subquery) {
      queries.push(scope.expression.unnest());
    } else if (scope.isSubquery) {
      queries.push(scope.expression);
    }

    for (const query of queries) {
      const subquery = query.parent;
      if (subquery instanceof exp.Subquery) {
        const unwrapped = subquery.unwrap();
        if (unwrapped.parent instanceof exp.From || unwrapped.parent instanceof exp.Join) {
          // We can reach this from a wrapped derived table, which must keep its alias
          continue;
        }

        if (unwrapped.parent instanceof exp.Create && unwrapped !== subquery) {
          // Function bodies may require wrapping parentheses, e.g. in BigQuery
          // `... AS ((SELECT 1))` the outer parens delimit the body itself
          unwrapped.set("this", subquery);
        } else {
          unwrapped.replace(subquery);
        }
      }
    }

    for (const derived_table of scope.derivedTables) {
      const unnested = derived_table.unnest();
      if (unnested instanceof exp.Table) {
        const joins = unnested.args.joins;
        unnested.set("joins", null);
        derived_table.this.replace(exp.select("*").from_(unnested.copy(), { copy: false }));
        derived_table.this.set("joins", joins);
      }

      _set_alias(derived_table, canonical_aliases, { scope });
      const pivot0 = seqGet(derived_table.args.pivots || [], -1);
      if (pivot0) _set_alias(pivot0, canonical_aliases);
    }

    const table_aliases = new Map();

    for (const [origName, source] of scope.sources) {
      // A source can appear in many scopes, e.g. as a lateral source of a UDTF scope or as a CTE
      // propagated to inner scopes. Deferring to the parent scope when it contains the same source
      // ensures each source is processed once, in the outermost scope that contains it
      if (parent && parent.sources.get(origName) === source) continue;

      let name = origName;

      if (source instanceof exp.Table) {
        // When the name is empty, it means that we have a non-table source, e.g. a pivoted cte
        const is_real_table_source = !!name;

        const pivot = seqGet(source.args.pivots || [], -1);
        if (pivot) name = source.name;

        const table_this = source.this;
        const table_alias = source.args.alias;
        let function_columns = null;
        if (table_this instanceof exp.Func) {
          if (!table_alias) {
            function_columns = ensureList(dialect.DEFAULT_FUNCTIONS_COLUMN_NAMES.get(table_this.constructor));
          } else if (table_alias.columns.length) {
            function_columns = table_alias.columns;
          } else if (dialect.DEFAULT_FUNCTIONS_COLUMN_NAMES.has(table_this.constructor)) {
            function_columns = ensureList(source.aliasOrName);
            source.set("alias", null);
            name = "";
          }
        }

        _set_alias(source, canonical_aliases, {
          targetAlias: name || source.name || null,
          normalize: true,
          columns: function_columns,
        });

        const source_fqn = source.parts.map((p) => p.name).join(".");
        const had_explicit_alias = table_alias && table_alias.name;
        if (!had_explicit_alias || !table_aliases.has(source_fqn)) {
          table_aliases.set(source_fqn, source.args.alias.this.copy());
        }

        if (pivot) {
          const targetAlias = pivot.unpivot ? source.alias : null;
          _set_alias(pivot, canonical_aliases, { targetAlias, normalize: true });

          // This case corresponds to a pivoted CTE, we don't want to qualify that
          if (scope.sources.get(source.aliasOrName) instanceof Scope) {
            continue;
          }
        }

        if (is_real_table_source) {
          _qualify(source);

          if (onQualify) onQualify(source);
        }
      } else if (source instanceof Scope && source.isUdtf) {
        const udtf = source.expression;
        _set_alias(udtf, canonical_aliases);

        const table_alias = udtf.args.alias;

        if (udtf instanceof exp.Values && !table_alias.columns.length) {
          const column_aliases = dialect
            .generate_values_aliases(udtf)
            .map((i) => normalize_identifiers(i, dialect));
          table_alias.set("columns", column_aliases);
        }
      }
    }

    for (const table of scope.tables) {
      if (!table.alias && (table.parent instanceof exp.From || table.parent instanceof exp.Join)) {
        _set_alias(table, canonical_aliases, { targetAlias: table.name });
      }
    }

    for (const column of local_columns) {
      const column_table = column.table;

      if (column.db) {
        const table_alias = table_aliases.get(column.parts.slice(0, -1).map((p) => p.name).join("."));

        if (table_alias) {
          for (const p of exp.COLUMN_PARTS.slice(1)) {
            column.set(p, null);
          }

          column.set("table", table_alias.copy());
        }
      } else if (canonical_aliases.size > 0 && column_table) {
        // Amend existing aliases, e.g. t.c -> _0.c if t is aliased to _0
        const canonical_table = canonical_aliases.get(column_table);
        if (canonical_table && canonical_table !== column_table) {
          column.set("table", exp.toIdentifier(canonical_table));
        }
      }
    }
  }

  return expression;
}
