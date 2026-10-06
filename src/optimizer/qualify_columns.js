// py: sqlglot/optimizer/qualify_columns.py @ 91119bc (AIR-2106/AIR-2107, epic
// AIR-2087) -- column qualification, star expansion, `validate_qualify_columns`
// (py:128-170, AIR-2107/4.4), and `quote_identifiers` (py:1288-1298, AIR-2107/4.4).
// `validate_qualify_columns` depends only on already-real surface this file's own
// R67 core already verified: `traverse_scope` and `Scope#externalColumns`/
// `#isCorrelatedSubquery`/`#pivots`/`#unqualifiedColumns` (`./scope.js`), plus
// `Expr#metaGet` and `highlightSql`/`OptimizeError` (`../errors.js`). `quote_identifiers`
// depends on `Dialect.get_or_raise` and the real `Dialect#quote_identifier`
// (`../dialects/dialect.js:2201`) plus `Expr#walk` -- both real, pre-existing ports
// checked against the current files rather than taken on faith. The `qualify()`
// end-to-end orchestrator that wires this file and `qualify_tables.js` together is
// `optimizer/qualify.py`, a DIFFERENT upstream file entirely (AIR-2108/4.5, still out
// of scope here).
//
// The CORE's own three named dependencies are real, verified ports, checked against
// the current files rather than taken on faith: `Resolver` (`./resolver.js`, R48, its
// own differential oracle EXACT 34/MISMATCH 0/ERROR 0), the real `Scope` class plus
// `traverse_scope`/`build_scope`/`walk_in_scope`/`find_all_in_scope`/`find_in_scope`
// (`./scope.js`, R44/R46), and `simplify_parens` (`./simplify.js`, part of R59's whole-
// file `optimizer/simplify.js` port, EXACT 83/MISMATCH 0/ERROR 0). `TypeAnnotator`
// (`./annotate_types.js`, R54) is also a real dependency this file's own `qualify_columns`
// entry point constructs and calls `annotate_scope`/`uncache` on.
//
// Greenfield in the sense that matters for verification: nothing in `src/` calls
// `qualify_columns` yet (the orchestrator is a separate future issue), so -- same shape
// `resolver.js`/`merge_subqueries.js`/`simplify.js` already established for this
// project's optimizer tier -- this file's only differential signal is its own new
// scenario-driven oracle (`spike/p10/gen_qualify_columns_ref.py` +
// `spike/p10/fuzz_qualify_columns.mjs`), not `corpus/atoms.jsonl`.
//
// Module-level function names stay snake_case verbatim, matching this project's
// established convention for optimizer top-level defs (`qualify_tables.js`,
// `merge_subqueries.js`, `resolver.py`'s own sibling files). Underscore-prefixed
// helpers stay module-private and unexported. `qualify_columns`, `validate_qualify_columns`,
// `qualify_outputs`, `quote_identifiers`, and `pushdown_cte_alias_columns` are the
// five public (upstream un-underscored) names this file itself defines; `Resolver` is
// additionally re-exported (not defined here) for `pushdown_projections.js`'s own
// `from sqlglot.optimizer.qualify_columns import Resolver` (AIR-2111, R74 — see the
// re-export at this file's end).
//
// Python-list/dict emptiness-vs-JS-truthiness (the recurring
// `sqlglot-js-empty-array-truthy-vs-python-empty-list-falsy` defect class,
// R37/R38/R48 precedent): every `if not some_list:` / `some_list or fallback` site
// below is ported with an explicit `.length` check, not bare truthiness, since a
// present-but-empty JS array is truthy.
//
// `id(table)`-keyed dicts (py:1198/1212/1226, `except_columns`/`rename_columns`/
// `replace_columns`, all `dict[int, ...]` keyed by `id(table_name_string)`): CPython
// string identity for a freshly-computed (non-interned) string is an implementation
// detail, not a documented contract -- the same hazard class this project's own
// `resolver.js`/R48 already named and deliberately diverged on for `set`
// intersection order (PORT_PLAN.md Appendix, "Accepted red-team findings"). JS has no
// per-string identity distinct from value equality, so this port keys these three maps
// by the table NAME STRING directly (value equality) rather than attempting to
// reproduce `id()`. This is observationally identical to upstream for every reachable
// case this file's own logic can produce -- within a single star expression's `tables`
// list, entries are always distinct values (either one table name for a `t.*` column
// star, or the deduplicated keys of a dict for a bare `*`) -- and only a contrived
// query with TWO SEPARATE star expressions over the exact same table name, each
// carrying DIFFERENT EXCEPT/REPLACE/RENAME clauses, could possibly observe a
// difference; that construction is not exercised by any upstream test at this pin.
//
// `re.fullmatch(ilike_pattern, name, re.IGNORECASE)` (py:1104) and `re.escape` (py:1176,
// 1182) route through `_py/re.js`, not JS `RegExp`, per this project's standing
// Python-regex-semantics rule (`python-regex-semantics-differ-in-js`).
//
// @ported-ranges sqlglot/optimizer/qualify_columns.py 28-1319

import * as exp from "../expressions/index.js";
import { Dialect } from "../dialects/dialect.js";
import { OptimizeError, highlightSql } from "../errors.js";
import { seqGet } from "../helper.js";
import { pyUpper } from "../_py/str.js";
import { fullmatch as pyReFullmatch, escape as pyReEscape, IGNORECASE } from "../_py/re.js";
import { TypeAnnotator } from "./annotate_types.js";
// py: `sqlglot.optimizer.qualify_columns` re-exports `Resolver` for
// `pushdown_projections.py`'s own `from sqlglot.optimizer.qualify_columns import
// Resolver` (AIR-2111, R74): re-exported below (near this file's other three public
// exports) rather than having that file reach into `./resolver.js` directly, matching
// upstream's own import path.
import { Resolver } from "./resolver.js";
import { Scope, buildScope, findAllInScope, findInScope, traverseScope, walkInScope } from "./scope.js";
import { simplify_parens } from "./simplify.js";
import { ensureSchema } from "../schema.js";

/**
 * py: qualify_columns.py:28 `qualify_columns(expression, schema, expand_alias_refs=True,
 * expand_stars=True, infer_schema=None, allow_partial_qualification=False, dialect=None)`.
 *
 * Rewrite sqlglot AST to have fully qualified columns.
 *
 * Example:
 *   qualify_columns(parseOne("SELECT col FROM tbl"), { tbl: { col: "INT" } }).sql()
 *   -> "SELECT tbl.col AS col FROM tbl"
 *
 * Notes:
 *   - A source may carry a chain of (UN)PIVOT operators; each one is resolved against
 *     the output of the one before it, and the last one's alias names the result.
 *
 * @param {exp.Expr} expression Expr to qualify.
 * @param {object} schema Database schema (a plain nested dict or a real `Schema`).
 * @param {{
 *   expandAliasRefs?: boolean,
 *   expandStars?: boolean,
 *   inferSchema?: boolean|null,
 *   allowPartialQualification?: boolean,
 *   dialect?: *,
 * }} [options]
 * @returns {exp.Expr} The qualified expression.
 */
export function qualify_columns(expression, schema, options = {}) {
  const {
    expandAliasRefs = true,
    expandStars = true,
    inferSchema: inferSchemaOption = null,
    allowPartialQualification = false,
    dialect: dialectOption = null,
  } = options;

  const resolvedSchema = ensureSchema(schema, { dialect: dialectOption });
  const annotator = new TypeAnnotator(resolvedSchema);
  const inferSchema = inferSchemaOption === null ? resolvedSchema.empty : inferSchemaOption;
  const dialect = resolvedSchema.dialect || new Dialect();
  const pseudocolumns = dialect.PSEUDOCOLUMNS;

  for (const scope of traverseScope(expression)) {
    if (dialect.PREFER_CTE_ALIAS_COLUMN) pushdown_cte_alias_columns(scope);

    const scope_expression = scope.expression;
    const is_select = scope_expression instanceof exp.Select;

    _separate_pseudocolumns(scope, pseudocolumns);

    const resolver = new Resolver(scope, resolvedSchema, inferSchema);
    _pop_table_column_aliases(scope.ctes);
    _pop_table_column_aliases(scope.derivedTables);
    const using_column_tables = _expand_using(scope, resolver);

    if ((resolvedSchema.empty || dialect.FORCE_EARLY_ALIAS_REF_EXPANSION) && expandAliasRefs) {
      _expand_alias_refs(scope, resolver, dialect, dialect.EXPAND_ONLY_GROUP_ALIAS_REF);
    }

    _convert_columns_to_dots(scope, resolver);
    _qualify_columns(scope, resolver, allowPartialQualification);

    // Refresh classification caches: a column just qualified in place may have been
    // cached as external
    scope.clearColumnCache();

    if (!resolvedSchema.empty && expandAliasRefs) {
      _expand_alias_refs(scope, resolver, dialect);
    }

    if (is_select) {
      if (expandStars) {
        _expand_stars(scope, resolver, using_column_tables, pseudocolumns, annotator);
      }
      qualify_outputs(scope, dialect);
    }

    _expand_group_by(scope, dialect);

    // DISTINCT ON and ORDER BY follow the same rules (tested in DuckDB, Postgres,
    // ClickHouse): https://www.postgresql.org/docs/current/sql-select.html#SQL-DISTINCT
    _expand_order_by_and_distinct_on(scope, resolver);

    if (dialect.ANNOTATE_ALL_SCOPES) annotator.annotate_scope(scope);
  }

  return expression;
}

/**
 * py: qualify_columns.py:128 `validate_qualify_columns(expression, sql=None)`.
 * Raise an `OptimizeError` if any columns aren't qualified.
 */
export function validate_qualify_columns(expression, sql = null) {
  const all_unqualified_columns = [];
  for (const scope of traverseScope(expression)) {
    if (scope.expression instanceof exp.Select) {
      const unqualified_columns = scope.unqualifiedColumns;

      if (scope.externalColumns.length && !scope.isCorrelatedSubquery && !scope.pivots.length) {
        const column = scope.externalColumns[0];
        const for_table = column.table ? ` for table: '${column.table}'` : "";
        const line = column.this.metaGet("line");
        const col = column.this.metaGet("col");
        const start = column.this.metaGet("start");
        const end = column.this.metaGet("end");

        let error_msg = `Column '${column.name}' could not be resolved${for_table}.`;
        if (line && col) error_msg += ` Line: ${line}, Col: ${col}`;
        if (sql && start !== null && end !== null) {
          const formatted_sql = highlightSql(sql, [[start, end]])[0];
          error_msg += `\n  ${formatted_sql}`;
        }

        throw new OptimizeError(error_msg);
      }

      all_unqualified_columns.push(...unqualified_columns);
    }
  }

  if (all_unqualified_columns.length) {
    const first_column = all_unqualified_columns[0];
    const line = first_column.this.metaGet("line");
    const col = first_column.this.metaGet("col");
    const start = first_column.this.metaGet("start");
    const end = first_column.this.metaGet("end");

    let error_msg = `Ambiguous column '${first_column.name}'`;
    if (line && col) error_msg += ` (Line: ${line}, Col: ${col})`;
    if (sql && start !== null && end !== null) {
      const formatted_sql = highlightSql(sql, [[start, end]])[0];
      error_msg += `\n  ${formatted_sql}`;
    }

    throw new OptimizeError(error_msg);
  }

  return expression;
}

// py: qualify_columns.py:173 `_separate_pseudocolumns(scope, pseudocolumns)`.
function _separate_pseudocolumns(scope, pseudocolumns) {
  if (!pseudocolumns.size) return;

  let has_pseudocolumns = false;
  const scope_expression = scope.expression;

  for (const column of scope.columns) {
    const name = pyUpper(column.name);
    if (!pseudocolumns.has(name)) continue;

    if (
      name !== "LEVEL"
      || (scope_expression instanceof exp.Select && scope_expression.args.connect)
    ) {
      column.replace(new exp.Pseudocolumn({ ...column.args }));
      has_pseudocolumns = true;
    }
  }

  if (has_pseudocolumns) scope.clearCache();
}

/**
 * py: qualify_columns.py:195 `_pop_table_column_aliases(derived_tables)`.
 *
 * Remove table column aliases.
 *
 * For example, `col1` and `col2` will be dropped in
 * `SELECT ... FROM (SELECT ...) AS foo(col1, col2)`.
 */
function _pop_table_column_aliases(derivedTables) {
  for (const derivedTable of derivedTables) {
    if (derivedTable.parent instanceof exp.With && derivedTable.parent.recursive) continue;
    const tableAlias = derivedTable.args.alias;
    if (tableAlias) tableAlias.set("columns", null);
  }
}

// py: qualify_columns.py:209 `_expand_using(scope, resolver)`.
function _expand_using(scope, resolver) {
  const columns = new Map();

  function _update_source_columns(source_name) {
    for (const column_name of resolver.getSourceColumns(source_name)) {
      if (!columns.has(column_name)) columns.set(column_name, source_name);
    }
  }

  const joins = [...scope.findAll(exp.Join)];
  if (!joins.length) return new Map();

  const names = new Set(joins.map((join) => join.aliasOrName));
  const ordered = [...scope.selectedSources.keys()].filter((key) => !names.has(key));

  if (names.size && !ordered.length) {
    // deny:implicit_str sqlglot/optimizer/qualify_columns.py:225 -- `{scope.expression}`
    // calls Python's `str(Expr)` (`__str__` -> `.sql()`); `.sql()` is the explicit
    // equivalent (R21). `{names}` reproduces a Python `set` repr; its iteration order
    // is CPython hash-bucket layout, not a documented contract (same "accepted
    // divergence" class as resolver.js/R48's set-intersection-order note) -- this port
    // uses `Set` insertion order instead. This is an unreachable-in-practice guard
    // (a JOIN with no FROM source at all), not exercised by any real SQL dialect.
    throw new OptimizeError(
      `Joins {${[...names].map((n) => `'${n}'`).join(", ")}} missing source table ${scope.expression.sql()}`,
    );
  }

  const column_tables = new Map();

  if (!joins.some((join) => (join.args.using && join.args.using.length) || join.method === "NATURAL")) {
    return column_tables;
  }

  for (const source_name of ordered) _update_source_columns(source_name);

  for (let i = 0; i < joins.length; i++) {
    const join = joins[i];
    const source_table = ordered[ordered.length - 1];
    if (source_table) _update_source_columns(source_table);

    const join_table = join.aliasOrName;
    ordered.push(join_table);

    const join_columns = resolver.getSourceColumns(join_table);

    let using = join.args.using;
    if ((using === null || using === undefined) && join.method === "NATURAL") {
      // A NATURAL JOIN is a USING join over the columns common to both sides; when
      // those can't be determined (unknown schema, no common columns), NATURAL stays
      if (columns.size && !columns.has("*") && join_columns.length && !join_columns.includes("*")) {
        using = [...columns.keys()]
          .filter((column_name) => join_columns.includes(column_name))
          .map((column_name) => exp.toIdentifier(column_name));
        if (using.length) join.set("method", null);
      }
    }
    if (!using || !using.length) continue;

    const conditions = [];
    const using_identifier_count = using.length;
    const is_semi_or_anti_join = join.isSemiOrAntiJoin;

    for (const identifierNode of using) {
      const identifier = identifierNode.name;
      let table = columns.get(identifier);

      if (!table || !join_columns.includes(identifier)) {
        if (columns.size && !columns.has("*") && join_columns.length) {
          throw new OptimizeError(`Cannot automatically join: ${identifier}`);
        }
      }

      table = table || source_table;

      let lhs;
      if (i === 0 || using_identifier_count === 1) {
        lhs = exp.column(identifier, table);
      } else {
        const coalesce_columns = ordered
          .slice(0, -1)
          .filter((t) => resolver.getSourceColumns(t).includes(identifier))
          .map((t) => exp.column(identifier, t));
        lhs = coalesce_columns.length > 1
          ? exp.func("coalesce", ...coalesce_columns)
          : exp.column(identifier, table);
      }

      conditions.push(lhs.eq(exp.column(identifier, join_table)));

      // Mapping of automatically joined column names to an ordered set of source
      // names (a `Map` with `null` values, because we only care about the key
      // ordering).
      if (!column_tables.has(identifier)) column_tables.set(identifier, new Map());
      const tables = column_tables.get(identifier);

      // Do not update the map if this was a SEMI/ANTI join in order to avoid
      // generating COALESCE columns for this join pair
      if (!is_semi_or_anti_join) {
        if (!tables.has(table)) tables.set(table, null);
        if (!tables.has(join_table)) tables.set(join_table, null);
      }
    }

    join.set("using", null);
    join.set("on", exp.and_(...conditions, { copy: false }));
  }

  if (column_tables.size) {
    for (const column of scope.columns) {
      if (!column.table && column_tables.has(column.name)) {
        const tables = column_tables.get(column.name);
        const coalesce_args = [...tables.keys()].map((table) => exp.column(column.name, table));
        let replacement = exp.func("coalesce", ...coalesce_args);

        if (column.parent instanceof exp.Select) {
          // Ensure the USING column keeps its name if it's projected
          replacement = exp.alias_(replacement, column.name, { copy: false });
        } else if (column.parent instanceof exp.Struct) {
          // Ensure the USING column keeps its name if it's an anonymous STRUCT field
          replacement = new exp.PropertyEQ({
            this: exp.toIdentifier(column.name),
            expression: replacement,
          });
        }

        scope.replace(column, replacement);
      }
    }
  }

  return column_tables;
}

/**
 * py: qualify_columns.py:325 `_expand_alias_refs(scope, resolver, dialect,
 * expand_only_groupby=False)`.
 *
 * Expand references to aliases.
 * Example:
 *   SELECT y.foo AS bar, bar * 2 AS baz FROM y
 * => SELECT y.foo AS bar, y.foo * 2 AS baz FROM y
 */
function _expand_alias_refs(scope, resolver, dialect, expand_only_groupby = false) {
  const expression = scope.expression;

  if (!(expression instanceof exp.Select) || dialect.DISABLES_ALIAS_REF_EXPANSION) return;

  const alias_to_expression = new Map();
  const projections = new Set(expression.selects.map((s) => s.aliasOrName));
  let replaced = false;

  function replace_columns(node, resolve_table = false, literal_index = false) {
    const is_group_by = node instanceof exp.Group;
    const is_having = node instanceof exp.Having;
    const is_qualify = node instanceof exp.Qualify;
    if (!node || (expand_only_groupby && !is_group_by)) return;

    for (const column of walkInScope(node, (n) => n.isStar)) {
      if (!(column instanceof exp.Column)) continue;

      // BigQuery's GROUP BY allows alias expansion only for standalone names, e.g:
      //   SELECT FUNC(col) AS col FROM t GROUP BY col --> Can be expanded
      //   SELECT FUNC(col) AS col FROM t GROUP BY FUNC(col) --> Shouldn't be expanded,
      //   will result to FUNC(FUNC(col))
      // This is not required for the HAVING clause as it can evaluate expressions
      // using both the alias & the table columns
      if (expand_only_groupby && is_group_by && column.parent !== node) continue;

      let skip_replace = false;
      const table = (resolve_table && !column.table) ? resolver.getTable(column.name) : null;
      const [alias_expr, aliasIndex] = alias_to_expression.get(column.name) || [null, 1];

      if (alias_expr) {
        // An aggregate alias must not be expanded into a GROUP BY or another
        // (non-window) aggregate.
        skip_replace = !!(
          findInScope(alias_expr, exp.AggFunc)
          && (
            is_group_by
            || (
              column.findAncestor(exp.AggFunc)
              && !(column.findAncestor(exp.Window, exp.Select) instanceof exp.Window)
            )
          )
        );

        // BigQuery's having clause gets confused if an alias matches a source.
        // SELECT x.a, max(x.b) as x FROM x GROUP BY 1 HAVING x > 1;
        // If "HAVING x" is expanded to "HAVING max(x.b)", BQ would blindly replace the
        // "x" reference with the projection MAX(x.b), i.e
        // HAVING MAX(MAX(x.b).b), resulting in the error:
        // "Aggregations of aggregations are not allowed"
        if ((is_having || is_qualify) && dialect.PROJECTION_ALIASES_SHADOW_SOURCE_NAMES) {
          skip_replace = skip_replace || [...alias_expr.findAll(exp.Column)].some(
            (n) => projections.has(n.parts[0].name),
          );
        }
      }
      if (table && (!alias_expr || skip_replace)) {
        column.set("table", table);
      } else if (!column.table && alias_expr && !skip_replace) {
        if (
          (alias_expr instanceof exp.Literal || alias_expr.isNumber)
          && (literal_index || resolve_table)
        ) {
          if (literal_index) {
            column.replace(exp.Literal.number(aliasIndex));
            replaced = true;
          }
        } else {
          replaced = true;
          let replacedColumn = column.replace(exp.paren(alias_expr));
          const simplified = simplify_parens(replacedColumn, dialect);
          if (simplified !== replacedColumn) {
            replacedColumn.replace(simplified);
            replacedColumn = simplified;
          }

          if (resolve_table && resolver.schema.empty) {
            // resolve alias spliced into QUALIFY/HAVING with unqualified columns
            for (const inner of walkInScope(replacedColumn)) {
              if (inner instanceof exp.Column && !inner.table) {
                const inner_table = resolver.getTable(inner);
                if (inner_table) inner.set("table", inner_table);
              }
            }
          }
        }
      }
    }
  }

  const selects = expression.selects;
  for (let i = 0; i < selects.length; i++) {
    const projection = selects[i];
    replace_columns(projection);
    if (projection instanceof exp.Alias) {
      alias_to_expression.set(projection.alias, [projection.this, i + 1]);
    }
  }

  let child_scope = scope;
  let parent_scope = scope;
  let on_right_sub_tree = false;
  while (parent_scope && !parent_scope.isCte) {
    child_scope = parent_scope;
    parent_scope = parent_scope.parent;
    if (parent_scope) {
      if (parent_scope.expression instanceof exp.Union) {
        // Access the arg directly instead of the right property, because set
        // operation operands aren't guaranteed to be Query nodes, e.g.
        // SELECT 1 UNION ALL VALUES (2). Unnest to see through parenthesized
        // operands, whose scope is the inner query
        on_right_sub_tree = parent_scope.expression.expression.unnest() === child_scope.expression;
      }
    }
  }

  // We shouldn't expand aliases if they match the recursive CTE's columns and we are
  // in the recursive part (right sub tree) of the CTE
  if (parent_scope && on_right_sub_tree) {
    const cte = parent_scope.expression.parent;
    if (cte) {
      const with_ = cte.findAncestor(exp.With);
      if (with_ && with_.recursive) {
        const recursiveCteColumns = (cte.args.alias.columns && cte.args.alias.columns.length)
          ? cte.args.alias.columns
          : cte.this.selects;
        for (const recursiveCteColumn of recursiveCteColumns) {
          alias_to_expression.delete(recursiveCteColumn.outputName);
        }
      }
    }
  }

  replace_columns(expression.args.where);
  replace_columns(expression.args.group, false, true);
  replace_columns(expression.args.having, true);
  replace_columns(expression.args.qualify, true);

  if (dialect.SUPPORTS_ALIAS_REFS_IN_JOIN_CONDITIONS) {
    for (const join of expression.args.joins || []) replace_columns(join);
  }

  if (dialect.PROJECTION_ALIASES_SHADOW_SOURCE_NAMES) {
    // In BigQuery's GROUP BY, HAVING and QUALIFY clauses, a qualifier that collides
    // with a projection alias resolves to the projection instead of the source. For
    // instance: SELECT id, ARRAY_AGG(col) AS custom_fields FROM custom_fields GROUP
    // BY custom_fields.id fails with "Column custom_fields contains an aggregation
    // function, which is not allowed in GROUP BY", so such references must be
    // rendered as bare names. We keep the columns qualified and mark them, deferring
    // to Generator.column_parts
    for (const clause of [expression.args.group, expression.args.having, expression.args.qualify]) {
      if (!clause) continue;

      for (const column of findAllInScope(clause, exp.Column)) {
        if (column.table && !column.db) {
          column.set("shadow", projections.has(column.table) || null);
        }
      }
    }
  }

  if (replaced) scope.clearCache();
}

// py: qualify_columns.py:479 `_expand_group_by(scope, dialect)`.
function _expand_group_by(scope, dialect) {
  const expression = scope.expression;
  const group = expression.args.group;
  if (!group) return;

  group.set("expressions", _expand_positional_references(scope, group.expressions, dialect));
  expression.set("group", group);
}

// py: qualify_columns.py:489 `_expand_order_by_and_distinct_on(scope, resolver)`.
function _expand_order_by_and_distinct_on(scope, resolver) {
  const expression = scope.expression;

  if (!(expression instanceof exp.Selectable)) return;

  const expr = expression;

  for (const modifier_key of ["order", "distinct"]) {
    let modifier = expr.args[modifier_key];
    if (modifier instanceof exp.Distinct) {
      modifier = modifier.args.on;
    }

    if (!(modifier instanceof exp.Expr)) continue;

    let modifier_expressions = modifier.expressions;
    if (modifier_key === "order") {
      modifier_expressions = modifier_expressions.map((ordered) => ordered.this);
    }

    const expanded = _expand_positional_references(scope, modifier_expressions, resolver.dialect, true);
    for (let i = 0; i < modifier_expressions.length; i++) {
      const original = modifier_expressions[i];
      const expandedNode = expanded[i];

      for (const agg of original.findAll(exp.AggFunc)) {
        for (const col of agg.findAll(exp.Column)) {
          if (!col.table) col.set("table", resolver.getTable(col.name));
        }
      }

      original.replace(expandedNode);
    }

    if (expr.args.group) {
      const selects = new Map(expression.selects.map((s) => [s.this, exp.column(s.aliasOrName)]));

      for (const node of modifier_expressions) {
        let replacement;
        if (node.isInt) {
          replacement = exp.toIdentifier(_select_by_pos(expression, node).alias);
        } else {
          replacement = selects.has(node) ? selects.get(node) : node;
        }
        node.replace(replacement);
      }
    }
  }
}

// py: qualify_columns.py:534 `_expand_positional_references(scope, expressions,
// dialect, alias=False)`.
function _expand_positional_references(scope, expressions, dialect, alias = false) {
  const new_nodes = [];
  let ambiguous_projections = null;

  const expression = scope.expression;

  if (!(expression instanceof exp.Selectable)) return new_nodes;

  for (const node of expressions) {
    if (node.isInt && node instanceof exp.Literal) {
      const select = _select_by_pos(expression, node);

      if (alias) {
        new_nodes.push(exp.column(select.args.alias.copy()));
      } else {
        const select_expr = select.this;

        let ambiguous;
        if (dialect.PROJECTION_ALIASES_SHADOW_SOURCE_NAMES) {
          if (ambiguous_projections === null) {
            // When a projection name is also a source name and it is referenced in
            // the GROUP BY clause, BQ can't understand what the identifier
            // corresponds to
            ambiguous_projections = new Set(
              expression.selects
                .filter((s) => scope.selectedSources.has(s.aliasOrName))
                .map((s) => s.aliasOrName),
            );
          }

          ambiguous = [...select_expr.findAll(exp.Column)].some(
            (column) => ambiguous_projections.has(column.parts[0].name),
          );
        } else {
          ambiguous = false;
        }

        if (
          exp.CONSTANTS.some((K) => select_expr instanceof K)
          || select_expr.isNumber
          || select_expr.find(exp.Explode, exp.Unnest)
          || ambiguous
        ) {
          new_nodes.push(node);
        } else {
          new_nodes.push(select_expr.copy());
        }
      }
    } else {
      new_nodes.push(node);
    }
  }

  return new_nodes;
}

// py: qualify_columns.py:587 `_select_by_pos(expression, node)`.
function _select_by_pos(expression, node) {
  const selection = seqGet(expression.selects, Number(node.this) - 1);
  if (selection === undefined) {
    throw new OptimizeError(`Unknown output column: ${node.name}`);
  }
  return selection.assertIs(exp.Alias);
}

/**
 * py: qualify_columns.py:594 `_convert_columns_to_dots(scope, resolver)`.
 *
 * Converts `Column` instances that represent STRUCT or JSON field lookup into
 * chained `Dots`.
 *
 * These lookups may be parsed as columns (e.g. "col"."field"."field2"), but they
 * need to be normalized to `Dot(Dot(...(<table>.<column>, field1), field2, ...))` to
 * be qualified properly.
 */
function _convert_columns_to_dots(scope, resolver) {
  let converted = false;
  for (const column of [...scope.columns, ...scope.stars]) {
    if (column instanceof exp.Dot) continue;

    let column_table = column.table;
    const dot_parts = column.metaGet("dot_parts", []);
    delete column.meta.dot_parts;

    if (
      column_table
      && !scope.selectedSources.has(column_table)
      && (
        !scope.parent
        || !scope.parent.sources.has(column_table)
        || !scope.isCorrelatedSubquery
      )
    ) {
      let [root, ...parts] = column.parts;
      let was_qualified;

      if (root instanceof exp.Identifier && scope.selectedSources.has(root.name)) {
        // The struct is already qualified, but we still need to change the AST
        column_table = root;
        [root, ...parts] = parts;
        was_qualified = true;
      } else {
        column_table = resolver.getTable(root.name);
        was_qualified = false;
      }

      if (column_table) {
        converted = true;
        const new_column = exp.column(root, column_table);

        if (dot_parts.length) {
          // Remove the actual column parts from the rest of dot parts
          new_column.meta.dot_parts = dot_parts.slice(was_qualified ? 2 : 1);
        }

        column.replace(exp.Dot.build([new_column, ...parts]));
      }
    }
  }

  if (converted) {
    // We want to re-aggregate the converted columns, otherwise they'd be skipped in
    // a `for column in scope.columns` iteration, even though they shouldn't be
    scope.clearCache();
  }
}

/**
 * py: qualify_columns.py:644 `_qualify_positional_column(scope, resolver, column,
 * column_table, column_source, source_columns, pivots, allow_partial_qualification)`.
 *
 * Resolve a positional column, returning whether to skip further qualification.
 */
function _qualify_positional_column(
  scope,
  resolver,
  column,
  column_table,
  column_source,
  source_columns,
  pivots,
  allow_partial_qualification,
) {
  if (
    !resolver.dialect.SUPPORTS_POSITIONAL_COLUMN_REFS
    || !(column.this instanceof exp.Parameter)
  ) {
    return false;
  }
  const position = column.this.this;
  if (!(position instanceof exp.Literal) || !position.isInt) {
    return false;
  }

  // Pivots from unrelated sources may share this scope, so prefer an exact
  // output-alias match. For an aliasless chain, fall back to the last operator on
  // the referenced source.
  let scope_pivot = scope.pivots.find((pivot) => pivot.alias === column_table) || null;
  if (!scope_pivot) {
    for (let i = scope.pivots.length - 1; i >= 0; i--) {
      const pivot = scope.pivots[i];
      if (pivot.parent && pivot.parent.aliasOrName === column_table) {
        scope_pivot = pivot;
        break;
      }
    }
  }
  if ((pivots && pivots.length) || scope_pivot || !source_columns.length || source_columns.includes("*")) {
    if (scope_pivot) column.set("table", exp.toIdentifier(scope_pivot.alias));
    return true;
  }

  const position_value = Number(position.toPy());
  let alias_columns;
  let source_columns_incomplete;
  if (column_source instanceof exp.Table) {
    alias_columns = column_source.aliasColumnNames;
    const source_columns_without_aliases = resolver.schema.columnNames(column_source, true);
    source_columns_incomplete = !source_columns_without_aliases.length
      || source_columns_without_aliases.includes("*");
  } else {
    alias_columns = [];
    source_columns_incomplete = false;
  }

  if (alias_columns.length && position_value > alias_columns.length && source_columns_incomplete) {
    return true;
  }

  const positional_columns = resolver.getSourceColumns(column_table, true);
  if (!(position_value >= 1 && position_value <= positional_columns.length)) {
    if (allow_partial_qualification) return true;
    throw new OptimizeError(
      `Positional reference $${position_value} is out of range for source '${column_table}'`,
    );
  }

  const positional_name = positional_columns[position_value - 1];
  if (positional_columns.filter((c) => c === positional_name).length > 1) {
    return true;
  }

  let positional_identifier;
  if (column_source instanceof Scope) {
    const source_expression = column_source.expression;
    if (!(source_expression instanceof exp.Query)) return true;

    const source_selects = source_expression.selects;
    const selection = position_value <= source_selects.length ? source_selects[position_value - 1] : null;
    const source_identifier = _output_identifier(selection);
    if (!source_identifier || source_identifier.name !== positional_name) return true;

    positional_identifier = source_identifier.copy();
  } else {
    positional_identifier = exp.toIdentifier(positional_name);
    resolver.dialect.quote_identifier(positional_identifier, false);
  }
  column.set("this", positional_identifier);

  return false;
}

// py: qualify_columns.py:731 `_qualify_columns(scope, resolver,
// allow_partial_qualification)`. Disambiguate columns, ensuring each column
// specifies a source.
function _qualify_columns(scope, resolver, allow_partial_qualification) {
  for (const column of scope.columns) {
    const column_table = column.table;
    let column_name = column.name;

    if (column_table && scope.sources.has(column_table)) {
      const column_source = scope.sources.get(column_table);
      let source_columns = resolver.getSourceColumns(column_table);
      // For pivoted sources, source_columns are pre-pivot; validate against the
      // post-pivot set.
      const pivots = column_source instanceof exp.Table ? (column_source.args.pivots || []) : [];
      if (pivots.length) {
        // Each operator's input is the previous one's output. `outputColumns`
        // returns a `Map` (post-rename name -> pre-rename name, py: `dict[str,str]`);
        // normalize back to a plain array of names (Python's `dict` keys, iterated in
        // insertion order) so downstream `.length`/`.includes()` reads keep working.
        for (const pivot of pivots) source_columns = [...pivot.outputColumns(source_columns).keys()];
      }

      if (_qualify_positional_column(
        scope, resolver, column, column_table, column_source, source_columns, pivots, allow_partial_qualification,
      )) {
        continue;
      }
      column_name = column.name;
      if (
        !allow_partial_qualification
        && source_columns.length
        && !source_columns.includes(column_name)
        && !source_columns.includes("*")
      ) {
        throw new OptimizeError(`Unknown column: ${column_name}`);
      }
    }

    if (!column_table) {
      if (scope.pivots.length && !column.findAncestor(exp.Pivot)) {
        // If the column is under the Pivot expression, we need to qualify it using
        // the name of the pivoted source instead of the pivot's alias
        column.set("table", exp.toIdentifier(scope.pivots[scope.pivots.length - 1].alias));
        continue;
      }

      // column_table can be a '' because bigquery unnest has no table alias
      const table = resolver.getTable(column);

      if (table) {
        const source = scope.sources.get(table.name);
        if (source instanceof Scope && source.columnIndex.has(column)) {
          continue;
        }
      }

      if (table) {
        column.set("table", table);
      } else if (
        resolver.dialect.TABLES_REFERENCEABLE_AS_COLUMNS
        && column.parts.length === 1
        && scope.selectedSources.has(column_name)
      ) {
        // BigQuery and Postgres allow tables to be referenced as columns, treating
        // them as structs/records
        scope.replace(column, new exp.TableColumn({ this: column.this }));
      }
    }
  }

  const pivots = scope.pivots;

  // A chained operator's IN-list may name columns produced by earlier operators,
  // which no source exposes; track the chain's accumulated output to resolve them.
  // Attribution is only unambiguous when all pivots share one parent, i.e. there's a
  // single pivoted source.
  const single_chain = !!pivots.length && pivots[0].parent === pivots[pivots.length - 1].parent;
  const produced = new Set();
  const pivoted_source = single_chain ? pivots[pivots.length - 1].alias : "";
  let available = scope.sources.has(pivoted_source) ? resolver.getSourceColumns(pivoted_source) : [];

  for (const pivot of pivots) {
    for (const column of pivot.findAll(exp.Column)) {
      if (column.table) continue;
      if (resolver.allColumns.has(column.name)) {
        const table = resolver.getTable(column.name);
        if (table) column.set("table", table);
      } else if (single_chain && produced.has(column.name)) {
        column.set("table", exp.toIdentifier(pivoted_source));
      }
    }

    if (single_chain) {
      // `outputColumns` returns a `Map` (py: `dict[str,str]`); `produced.update(...)`
      // on a Python dict adds its KEYS, and the next iteration's `output_columns`
      // call treats that dict as an iterable of names again -- normalize to a plain
      // array of names (insertion order) both to add to `produced` and to feed the
      // next pivot.
      available = [...pivot.outputColumns(available).keys()];
      for (const c of available) produced.add(c);
    }
  }
}

/**
 * py: qualify_columns.py:828 `_expand_struct_stars_no_parens(expression)`.
 * [BigQuery] Expand/Flatten foo.bar.* where bar is a struct column.
 */
function _expand_struct_stars_no_parens(expression) {
  let dot_column = expression.find(exp.Column);
  if (!(dot_column instanceof exp.Column) || !dot_column.isType(exp.DType.STRUCT)) return [];

  // All nested struct values are ColumnDefs, so normalize the first exp.Column in one
  dot_column = dot_column.copy();
  let starting_struct = new exp.ColumnDef({ this: dot_column.this, kind: dot_column.type });

  // First part is the table name and last part is the star so they can be dropped
  const dot_parts = expression.parts.slice(1, -1);

  // If we're expanding a nested struct eg. t.c.f1.f2.* find the last struct (f2 in
  // this case)
  for (const part of dot_parts.slice(1)) {
    let matched = false;
    for (const field of starting_struct.kind.expressions) {
      // Unable to expand star unless all fields are named
      if (!(field.this instanceof exp.Identifier)) return [];

      if (field.name === part.name && field.kind.isType(exp.DType.STRUCT)) {
        starting_struct = field;
        matched = true;
        break;
      }
    }
    if (!matched) {
      // There is no matching field in the struct
      return [];
    }
  }

  const taken_names = new Set();
  const new_selections = [];

  for (const field of starting_struct.kind.expressions) {
    const name = field.name;

    // Ambiguous or anonymous fields can't be expanded
    if (taken_names.has(name) || !(field.this instanceof exp.Identifier)) return [];

    taken_names.add(name);

    const this_ = field.this.copy();
    const [root, ...parts] = [...dot_parts, this_].map((part) => part.copy());
    const new_column = exp.column(root, dot_column.args.table, null, null, { fields: parts });
    new_selections.push(exp.alias_(new_column, this_, { copy: false }).assertIs(exp.Alias));
  }

  return new_selections;
}

/**
 * py: qualify_columns.py:882 `_expand_struct_stars_with_parens(expression)`.
 * [RisingWave] Expand/Flatten (<exp>.bar).*, where bar is a struct column.
 */
function _expand_struct_stars_with_parens(expression) {
  // it is not (<sub_exp>).* pattern, which means we can't expand
  if (!(expression.this instanceof exp.Paren)) return [];

  // find column definition to get data-type
  const dot_column = expression.find(exp.Column);
  if (!(dot_column instanceof exp.Column) || !dot_column.isType(exp.DType.STRUCT)) return [];

  let parent = dot_column.parent;
  let starting_struct = dot_column.type;

  // walk up AST and down into struct definition in sync
  while (parent !== null && parent !== undefined) {
    if (parent instanceof exp.Paren) {
      parent = parent.parent;
      continue;
    }

    // if parent is not a dot, then something is wrong
    if (!(parent instanceof exp.Dot)) return [];

    // if the rhs of the dot is star we are done
    const rhs = parent.right;
    if (rhs instanceof exp.Star) break;

    // if it is not identifier, then something is wrong
    if (!(rhs instanceof exp.Identifier)) return [];

    // Check if current rhs identifier is in struct
    let matched = false;
    for (const struct_field_def of starting_struct.expressions) {
      if (struct_field_def.name === rhs.name) {
        matched = true;
        starting_struct = struct_field_def.kind; // update struct
        break;
      }
    }

    if (!matched) return [];

    parent = parent.parent;
  }

  // build new aliases to expand star
  const new_selections = [];

  // fetch the outermost parentheses for new aliaes
  const outer_paren = expression.this;

  for (const struct_field_def of starting_struct.expressions) {
    const new_identifier = struct_field_def.this.copy();
    const new_dot = exp.Dot.build([outer_paren.copy(), new_identifier]);
    const new_alias = exp.alias_(new_dot, new_identifier, { copy: false }).assertIs(exp.Alias);
    new_selections.push(new_alias);
  }

  return new_selections;
}

// py: qualify_columns.py:944 `_expand_stars(scope, resolver, using_column_tables,
// pseudocolumns, annotator)`. Expand stars to lists of column selections.
function _expand_stars(scope, resolver, using_column_tables, pseudocolumns, annotator) {
  const new_selections = [];
  // `id(table)`-keyed upstream (py:954-956); this port keys by the table NAME STRING
  // directly -- see this file's own header for why that is a safe, deliberate
  // divergence.
  const except_columns = new Map();
  const replace_columns = new Map();
  const rename_columns = new Map();
  let ilike_pattern = null;

  const coalesced_columns = new Set();
  const dialect = resolver.dialect;

  const annotated_ahead = dialect.SUPPORTS_STRUCT_STAR_EXPANSION
    && scope.stars.some((col) => col instanceof exp.Dot);
  if (annotated_ahead) {
    // Found struct expansion, annotate scope ahead of time
    annotator.annotate_scope(scope);
  }

  const scope_expression = scope.expression;

  if (!(scope_expression instanceof exp.Selectable)) return;

  for (const expression of scope_expression.selects) {
    let tables = [];
    if (expression instanceof exp.Star) {
      // Only a string literal ILIKE pattern can filter the expansion at
      // optimization time
      const ilike = expression.args.ilike;
      if (ilike && !ilike.isString) {
        new_selections.push(expression);
        continue;
      }

      tables.push(...scope.selectedSources.keys());
      _add_except_columns(expression, tables, except_columns);
      _add_replace_columns(expression, tables, replace_columns);
      _add_rename_columns(expression, tables, rename_columns);
      ilike_pattern = _add_ilike_columns(expression, dialect);
    } else if (expression.isStar) {
      if (expression instanceof exp.Column) {
        const ilike = expression.this.args.ilike;
        if (ilike && !ilike.isString) {
          new_selections.push(expression);
          continue;
        }

        tables.push(expression.table);
        _add_except_columns(expression.this, tables, except_columns);
        _add_replace_columns(expression.this, tables, replace_columns);
        _add_rename_columns(expression.this, tables, rename_columns);
        ilike_pattern = _add_ilike_columns(expression.this, dialect);
      } else if (expression instanceof exp.Dot) {
        let struct_fields;
        if (dialect.REQUIRES_PARENTHESIZED_STRUCT_ACCESS) {
          struct_fields = _expand_struct_stars_with_parens(expression);
        } else if (dialect.SUPPORTS_STRUCT_STAR_EXPANSION) {
          struct_fields = _expand_struct_stars_no_parens(expression);
        } else {
          struct_fields = [];
        }

        if (struct_fields.length) {
          if (annotated_ahead) annotator.uncache(expression);

          new_selections.push(...struct_fields);
          continue;
        }
      }
    }

    if (!tables.length) {
      new_selections.push(expression);
      continue;
    }

    for (const table of tables) {
      let source = scope.sources.get(table);
      let pivots = null;
      let source_table = table;

      if (source === undefined) {
        // The chain's final alias names the resulting source, but only the
        // underlying source is registered in `scope.sources`, so resolve through
        // the chain's parent. Attribution is only unambiguous for a single chain
        // (all pivots share a parent)
        const chain = scope.pivots;
        const parent = (chain.length && chain[0].parent === chain[chain.length - 1].parent && chain[chain.length - 1].alias === table)
          ? chain[chain.length - 1].parent
          : null;
        if (parent) {
          pivots = chain;
          source_table = parent.aliasOrName;
          source = scope.sources.get(source_table);
        }

        if (source === undefined) {
          throw new OptimizeError(`Unknown table: ${table}`);
        }
      }

      let columns = resolver.getSourceColumns(source_table, true);
      columns = columns.length ? columns : scope.outerColumns;

      if (pseudocolumns.size && dialect.EXCLUDES_PSEUDOCOLUMNS_FROM_STAR) {
        columns = columns.filter((name) => !pseudocolumns.has(pyUpper(name)));
      }

      // If a source exposes duplicate output names (e.g. a derived table
      // re-exposing colliding star-expanded columns), expanding this star would
      // produce ambiguous projections, so we leave it unexpanded.
      if (!columns.length || columns.includes("*") || columns.length !== new Set(columns).size) {
        return;
      }

      const columns_to_exclude = except_columns.get(table) || new Set();
      const renamed_columns = rename_columns.get(table) || new Map();
      const replaced_columns = replace_columns.get(table) || new Map();

      // Preserve case-sensitivity of quoted source columns when expanding stars, so
      // the generated alias isn't folded by dialect normalization
      const source_expression = source instanceof Scope ? source.expression : null;
      const quoted_columns = source_expression instanceof exp.Query
        ? new Set(source_expression.selects.filter((s) => _is_output_identifier_quoted(s)).map((s) => s.outputName))
        : new Set();

      // The operators belong to a specific source, so a star over a source joined
      // alongside it must expand from that source's own columns
      if (pivots === null) {
        const selectedPair = scope.selectedSources.get(table);
        let selected_node = selectedPair ? selectedPair[0] : null;
        if (selected_node === null && source instanceof exp.Table) {
          // A pivoted CTE reference is registered under the pivot's alias, a name
          // `references` doesn't know, so it's absent from `selected_sources`
          selected_node = source;
        }

        pivots = selected_node instanceof exp.Expr ? (selected_node.args.pivots || null) : null;
      }

      if (pivots && pivots.length) {
        // Each operator consumes the previous one's output, so fold them in order.
        // `outputColumns` returns a `Map` (py: `dict[str,str]`); Python's
        // `pivot.output_columns(...) or pivot.alias_column_names` falls back for an
        // EMPTY dict, so the JS equivalent checks `.size`, and the surviving value is
        // normalized back to a plain array of names (dict keys, insertion order) for
        // `for name in pivot_columns`/the next pivot's own input.
        let pivot_columns = columns;
        for (const pivot of pivots) {
          const out = pivot.outputColumns(pivot_columns);
          pivot_columns = out.size ? [...out.keys()] : pivot.aliasColumnNames;
        }

        if (pivot_columns && pivot_columns.length) {
          for (const name of pivot_columns) {
            if (columns_to_exclude.has(name)) continue;
            // deny:operators sqlglot/optimizer/qualify_columns.py:1095 — `pivots[-1]`
            // is Python list negative indexing (last element), not `exp.Bracket`
            // subscript-node construction; `pivots[pivots.length - 1]` is the literal
            // JS equivalent.
            new_selections.push(
              exp.alias_(exp.column(name, pivots[pivots.length - 1].alias || null), name, { copy: false }),
            );
          }
          continue;
        }
      }

      for (const name of columns) {
        if (columns_to_exclude.has(name) || coalesced_columns.has(name)) continue;
        if (ilike_pattern && !pyReFullmatch(ilike_pattern, name, IGNORECASE)) continue;
        if (using_column_tables.has(name) && using_column_tables.get(name).has(table)) {
          coalesced_columns.add(name);
          const using_tables = using_column_tables.get(name);
          const coalesce_args = [...using_tables.keys()].map((ut) => exp.column(name, ut));

          new_selections.push(
            exp.alias_(exp.func("coalesce", ...coalesce_args), name, { copy: false }),
          );
        } else {
          const alias_ = renamed_columns.has(name) ? renamed_columns.get(name) : name;
          const quoted = quoted_columns.has(name)
            || (source instanceof exp.Table && dialect.case_sensitive(name));
          const selection_expr = replaced_columns.get(name)
            || exp.column(name, table, null, null, { quoted });
          new_selections.push(
            alias_ !== name ? exp.alias_(selection_expr, alias_, { copy: false }) : selection_expr,
          );
        }
      }
    }

    if (annotated_ahead) {
      // The star projection was replaced by the expansions above
      annotator.uncache(expression);
    }
  }

  // Ensures we don't overwrite the initial selections with an empty list
  if (new_selections.length && scope_expression instanceof exp.Select) {
    if (annotated_ahead) {
      // The mutation below would otherwise be skipped by the final annotation pass
      annotator.uncache(scope_expression, false);
    }

    scope_expression.set("expressions", new_selections);
  }
}

// py: qualify_columns.py:1143 `_output_identifier(selection)`.
function _output_identifier(selection) {
  let identifier;
  if (selection instanceof exp.Alias) {
    identifier = selection.args.alias;
  } else if (selection instanceof exp.Column) {
    identifier = selection.this;
  } else {
    identifier = null;
  }

  return identifier instanceof exp.Identifier ? identifier : null;
}

/**
 * py: qualify_columns.py:1154 `_is_output_identifier_quoted(selection)`.
 * Whether a projection's output column name is a quoted (case-sensitive) identifier.
 */
function _is_output_identifier_quoted(selection) {
  const identifier = _output_identifier(selection);
  return !!(identifier && identifier.quoted);
}

// py: qualify_columns.py:1160 `_add_ilike_columns(expression, dialect)`.
function _add_ilike_columns(expression, dialect) {
  const ilike = expression.args.ilike;

  if (!ilike) return null;

  const pattern = Array.from(ilike.name);
  const len_pattern = pattern.length;
  const chars = [];
  let i = 0;

  while (i < len_pattern) {
    const c = pattern[i];

    if (c === "\\" && dialect.STAR_ILIKE_BACKSLASH_ESCAPE && i + 1 < len_pattern) {
      i += 1;
      chars.push(pyReEscape(pattern[i]));
    } else if (c === "%") {
      chars.push(".*");
    } else if (c === "_") {
      chars.push(".");
    } else {
      chars.push(pyReEscape(c));
    }

    i += 1;
  }

  return chars.join("");
}

// py: qualify_columns.py:1189 `_add_except_columns(expression, tables, except_columns)`.
function _add_except_columns(expression, tables, except_columns) {
  const except_ = expression.args.except_;

  if (!except_ || !except_.length) return;

  const columns = new Set(except_.map((e) => e.name));

  for (const table of tables) except_columns.set(table, columns);
}

// py: qualify_columns.py:1201 `_add_rename_columns(expression, tables, rename_columns)`.
function _add_rename_columns(expression, tables, rename_columns) {
  const rename = expression.args.rename;

  if (!rename || !rename.length) return;

  const columns = new Map(rename.map((e) => [e.this.name, e.alias]));

  for (const table of tables) rename_columns.set(table, columns);
}

// py: qualify_columns.py:1215 `_add_replace_columns(expression, tables, replace_columns)`.
function _add_replace_columns(expression, tables, replace_columns) {
  const replace = expression.args.replace;

  if (!replace || !replace.length) return;

  const columns = new Map(replace.map((e) => [e.alias, e]));

  for (const table of tables) replace_columns.set(table, columns);
}

/**
 * py: qualify_columns.py:1229 `qualify_outputs(scope_or_expression, dialect)`.
 * Ensure all output columns are aliased.
 */
export function qualify_outputs(scope_or_expression, dialect) {
  let scope;
  if (scope_or_expression instanceof exp.Expr) {
    scope = buildScope(scope_or_expression);
    if (!(scope instanceof Scope)) return;
  } else {
    scope = scope_or_expression;
  }

  const expression = scope.expression;

  if (!(expression instanceof exp.Selectable)) return;

  const new_selections = [];

  const selects = expression.selects;
  const outerColumns = scope.outerColumns;
  const n = Math.max(selects.length, outerColumns.length);

  for (let i = 0; i < n; i++) {
    let selection = i < selects.length ? selects[i] : null;
    const aliased_column = i < outerColumns.length ? outerColumns[i] : null;

    if (selection === null || selection instanceof exp.QueryTransform) break;

    if (selection instanceof exp.Subquery) {
      if (!selection.outputName) {
        const alias_identifier = exp.toIdentifier(`_col_${i}`);
        dialect.normalize_identifier(alias_identifier);
        selection.set("alias", new exp.TableAlias({ this: alias_identifier }));
      }
    } else if (
      !(selection instanceof exp.Alias || selection instanceof exp.Aliases)
      && !selection.isStar
    ) {
      const unwrapped = selection.unnest();
      let source_identifier;
      if (unwrapped instanceof exp.Column) {
        source_identifier = unwrapped.this;
      } else if (unwrapped instanceof exp.Dot) {
        source_identifier = unwrapped.expression;
      } else {
        source_identifier = null;
      }

      selection = exp.alias_(selection, selection.outputName || `_col_${i}`, { copy: false });
      if (source_identifier instanceof exp.Identifier) {
        // The alias copies the exact spelling of an existing identifier, so folding
        // it here would desync it from other occurrences of that identifier; its
        // casing is `normalize_identifiers`' concern, which has already run (or was
        // skipped deliberately) by this point
        if (source_identifier.quoted) selection.args.alias.set("quoted", true);
      } else {
        dialect.normalize_identifier(selection.args.alias);
      }
    }
    if (aliased_column) {
      selection.set("alias", exp.toIdentifier(aliased_column));
    }

    new_selections.push(selection);
  }

  if (new_selections.length && expression instanceof exp.Select) {
    expression.set("expressions", new_selections);
  }
}

/**
 * py: qualify_columns.py:1288 `quote_identifiers(expression, dialect=None, identify=True)`.
 * Makes sure all identifiers that need to be quoted are quoted.
 */
export function quote_identifiers(expression, dialect = null, identify = true) {
  dialect = Dialect.get_or_raise(dialect);

  // `quote_identifier` only mutates identifiers in place, so we avoid `transform` here
  // because its node replacement machinery is wasteful for this case.
  for (const node of expression.walk()) {
    if (node instanceof exp.Identifier) {
      dialect.quote_identifier(node, identify);
    }
  }

  return expression;
}

/**
 * py: qualify_columns.py:1301 `pushdown_cte_alias_columns(scope)`.
 *
 * Pushes down the CTE alias columns into the projection.
 *
 * This step is useful in Snowflake where the CTE alias columns can be referenced in
 * the HAVING.
 */
export function pushdown_cte_alias_columns(scope) {
  for (const cte of scope.ctes) {
    if (cte.aliasColumnNames.length && cte.this instanceof exp.Select) {
      const new_expressions = [];
      const columns = cte.args.alias.columns;
      const projections = cte.this.expressions;
      const n = Math.min(columns.length, projections.length);
      for (let i = 0; i < n; i++) {
        const _alias = columns[i];
        let projection = projections[i];
        if (projection instanceof exp.Alias) {
          projection.set("alias", _alias.copy());
        } else {
          projection = exp.alias_(projection, _alias);
        }
        new_expressions.push(projection);
      }
      cte.this.set("expressions", new_expressions);
    }
  }
}

// py: `from sqlglot.optimizer.qualify_columns import Resolver` — the one re-export
// upstream's own module surface makes available from this file (AIR-2111, R74's
// `pushdown_projections.js` is the first and, as of this port, only consumer).
export { Resolver };
