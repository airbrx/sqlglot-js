// py: sqlglot/optimizer/canonicalize_internal_names.py @ 91119bc -- WHOLE FILE (331 LOC).
//
// AIR-2315 Part 3: this module had NEVER been ported. It is not part of the default
// `optimizer.optimize()` pipeline upstream either -- it is a standalone export, used
// here only by `tests/fixtures/optimizer/canonicalize_internal_names.sql`'s own
// `check_file` call (`qualify_then_canonicalize` = `canonicalize_internal_names(qualify(...))`),
// which is exactly why this gap survived every prior round: nothing in the port's own
// `optimize()` wiring ever reached it, so no closure/demand tracer flagged it as missing
// ([[demand-tracers-miss-preconditions]] -- a tracer records which units a caller
// reaches, and nothing reaches an export nobody calls).
//
// Rewrites a query to a canonical structural form: preserves data-contract names
// (base-table names/columns, top-level output aliases) and canonicalizes every
// INTERNAL name (table aliases, CTE/subquery names, internal column aliases) to
// sequential `_tN`/`_cN`. Object IDENTITY (Python's `id(x)`) is the cache key
// throughout upstream (`scope_table`, `scope_outputs`, `table_columns`,
// `udtf_columns`) -- JS `Map`/`Set` can key on the object reference directly, which is
// simpler than reproducing `id()` and behaviorally identical (same object => same key).
// Every `dict[str, str]` that could plausibly be indexed by an attacker-chosen SQL
// column/alias name (not a fixed internal literal) uses a real `Map`, not a plain
// object, so a column literally named `__proto__`/`constructor` can't collide with
// `Object.prototype`.

import * as exp from "../expressions/index.js";
import { nameSequence, seqGet } from "../helper.js";
import { Scope, traverseScope, findAllInScope } from "./scope.js";

/**
 * py: canonicalize_internal_names.py:13 `canonicalize_internal_names(expression)`.
 *
 * Assumes the expression has already been processed by `qualify` (or equivalent), so
 * that columns are bound to sources and aliases exist on every projection /
 * subquery / CTE.
 *
 * @param {exp.Expr} expression
 * @returns {exp.Expr}
 */
export function canonicalize_internal_names(expression) {
  // Skip non-queries for now (e.g., UPDATE ... SET x = s.x FROM (SELECT ...) AS s)
  if (!(expression instanceof exp.Query)) return expression;

  // Top-level output scopes: their aliases are the query's data contract. Regular UNION
  // takes names from the left branch; UNION BY NAME takes names from the union of all
  // branches, so both sides of a by_name SetOperation contribute.
  const outputScopeExprs = new Set();
  const stack = [expression];
  while (stack.length) {
    const node = stack.pop();
    if (node instanceof exp.SetOperation) {
      // Access the args directly instead of the left/right properties, because set
      // operation operands aren't guaranteed to be Query nodes, e.g. VALUES (1) UNION ALL SELECT 1
      stack.push(node.this.unnest());
      if (node.args.by_name) stack.push(node.expression.unnest());
    } else {
      outputScopeExprs.add(node);
    }
  }

  const nextTable = nameSequence("_t");
  const nextColumn = nameSequence("_c");

  function _canon(ident, name) {
    ident.set("this", name);
    ident.set("quoted", true);
  }

  const scopeTable = new Map();
  const scopeOutputs = new Map();

  // Shared across scopes so a Table referenced from multiple scopes (LATERAL/UNNEST)
  // gets consistent column names.
  const tableColumns = new Map();

  // Shared across UDTF sources so chained correlated UNNESTs get consistent names for
  // their alias columns.
  const udtfColumns = new Map();

  for (const scope of traverseScope(expression)) {
    const scopeExpr = scope.expression;
    const isOutputScope = outputScopeExprs.has(scopeExpr);

    const columnsBySource = new Map();
    const pushSource = (name, col) => {
      if (!columnsBySource.has(name)) columnsBySource.set(name, []);
      columnsBySource.get(name).push(col);
    };
    for (const col of scope.columns) pushSource(col.text("table"), col);
    for (const tableCol of scope.tableColumns) pushSource(tableCol.name, tableCol);

    // Include qualified stars (e.g. `t.*`)
    for (const star of scope.stars) {
      if (star instanceof exp.Column && star.text("table")) pushSource(star.text("table"), star);
    }

    // source_canon: source's canonical name (used in WITH "_tN" AS, and as the
    //   physical table name in `Table.this`). Shared across every reference to the
    //   same source within this scope.
    // ref_alias: per-reference canonical alias (used as the alias on each `Table`
    //   node and as the qualifier on its column refs). The first reference reuses
    //   source_canon for compactness; subsequent refs get fresh `_tN` names so a
    //   self-join like `cte AS x JOIN cte AS y` produces unique aliases.
    const tableMap = new Map();
    const refCanonTaken = new Set();

    for (const [sourceName, source] of scope.sources) {
      const sourceCols = columnsBySource.get(sourceName) || [];

      let aliasHolder = null;
      const isBaseSource = source instanceof exp.Table;

      let childOutput;
      let nameMap;
      let canonT;

      if (isBaseSource) {
        canonT = scopeTable.get(source) || "";
        if (!canonT) {
          canonT = nextTable();
          scopeTable.set(source, canonT);
        }
        childOutput = new Map();
        nameMap = tableColumns.get(source);
        if (!nameMap) {
          nameMap = new Map();
          tableColumns.set(source, nameMap);
        }
      } else if (source instanceof Scope) {
        // Key by the expression object so a recursive CTE's self-reference, i.e., a
        // separate Scope whose `expression` is the same object as the CTE's base
        // branch, shares the base branch's output mapping.
        const srcExpr = source.expression;
        childOutput = scopeOutputs.get(srcExpr) || new Map();

        const parent = srcExpr.parent;
        if (parent instanceof exp.CTE || parent instanceof exp.Subquery) {
          aliasHolder = parent;
        } else if (
          parent instanceof exp.SetOperation
          && parent.parent instanceof exp.CTE
          && parent.parent.parent instanceof exp.With
          && parent.parent.parent.recursive
        ) {
          aliasHolder = parent.parent;
        } else if (source.isUdtf) {
          aliasHolder = srcExpr;
        }

        // A UDTF (unlike a CTE/subquery) can be a source in multiple scopes, so keep
        // its alias_holder and share its column map across them.
        const isUdtfSource = aliasHolder === srcExpr;

        const tableKey = aliasHolder || source;
        canonT = scopeTable.get(tableKey) || "";

        if (!canonT) {
          canonT = nextTable();
          scopeTable.set(tableKey, canonT);
        } else if (!isUdtfSource) {
          aliasHolder = null; // already renamed on a previous encounter
        }

        if (isUdtfSource) {
          nameMap = udtfColumns.get(srcExpr);
          if (!nameMap) {
            nameMap = new Map();
            udtfColumns.set(srcExpr, nameMap);
          }
        } else {
          nameMap = new Map();
        }
      } else {
        continue;
      }

      let refAlias;
      if (refCanonTaken.has(canonT)) {
        refAlias = nextTable();
      } else {
        refAlias = canonT;
        refCanonTaken.add(canonT);
      }

      tableMap.set(sourceName, [canonT, refAlias]);

      // UNNEST struct fields are physical columns (preserve); the element alias is not.
      let structFieldNames = new Set();
      const src = source.expression;
      if (src instanceof exp.Unnest && src.expressions.length && src.expressions[0].type) {
        const elementType = seqGet(src.expressions[0].type.expressions, 0);
        if (elementType && elementType.isType(exp.DType.STRUCT)) {
          structFieldNames = new Set(elementType.expressions.map((cd) => cd.name));
        }
      }

      for (const srcCol of sourceCols) {
        // BigQuery whole-row struct ref (`SELECT t FROM t`): the identifier IS the
        // table alias, so rename it to this reference's alias.
        if (srcCol instanceof exp.TableColumn) {
          _canon(srcCol.this, refAlias);
          continue;
        }

        const oldName = srcCol.name;
        const preserveCol = isBaseSource || structFieldNames.has(oldName);
        let canonCol = nameMap.get(oldName);

        if (canonCol === undefined) {
          if (preserveCol) {
            canonCol = oldName;
          } else {
            canonCol = childOutput.get(oldName) || nextColumn();
          }
          nameMap.set(oldName, canonCol);
        }

        // Base-table and UNNEST struct-field column refs name physical columns =>
        // preserve verbatim (including quote state). Scope-sourced refs are internal
        // handles pointing at CTE/subquery aliases (injected unquoted via
        // `exp.toIdentifier`), so _canon them.
        if (!preserveCol) _canon(srcCol.this, canonCol);

        const tableId = srcCol.args.table;
        if (tableId) _canon(tableId, refAlias);
      }

      if (aliasHolder) {
        const alias = aliasHolder.args.alias;
        if (alias) {
          if (alias.this instanceof exp.Identifier) {
            // The CTE/Subquery name itself uses source_canon (canon_t), not
            // ref_alias -- it's the source's identity, not a reference.
            _canon(alias.this, canonT);
          }
          if (alias.columns.length) {
            alias.set(
              "columns",
              alias.columns.map((c) => exp.toIdentifier(nameMap.get(c.name) ?? c.name, c.quoted)),
            );
          }
        }

        // BigQuery UNNEST ... WITH OFFSET AS <id> declares a pseudo-column via the
        // offset arg (not the alias).
        if (aliasHolder instanceof exp.Unnest) {
          const offsetId = aliasHolder.args.offset;
          if (offsetId instanceof exp.Identifier && nameMap.has(offsetId.name)) {
            _canon(offsetId, nameMap.get(offsetId.name));
          }
        }
      }
    }

    // PIVOT output column names are bound to the IN-clause literals, so only the alias
    // (which qualifies column refs like `my_pivot.x`) is canonicalized.
    for (const pivot of scope.pivots) {
      const pivotAlias = pivot.args.alias;
      if (!(pivotAlias && pivotAlias.this instanceof exp.Identifier)) continue;
      const pivotCols = columnsBySource.get(pivotAlias.this.name);
      if (!pivotCols || !pivotCols.length) continue;

      const canonT = nextTable();
      _canon(pivotAlias.this, canonT);

      for (const pivotCol of pivotCols) {
        const tableId = pivotCol.args.table;
        if (tableId) _canon(tableId, canonT);
      }
    }

    for (const table of scope.tables) {
      const entry = tableMap.get(table.aliasOrName);
      if (!entry) continue;
      const [sourceCanon, refAlias] = entry;

      // Real tables (qualified with db/catalog) keep their physical name; CTE/subquery
      // references get the source's canonical `_tN`.
      if (table.this instanceof exp.Identifier && !table.args.db) {
        _canon(table.this, sourceCanon);
      }

      const alias = table.args.alias;
      if (alias) {
        // The reference alias uses ref_alias, which is unique per Table node so
        // multiple references to the same source can coexist.
        if (alias.this instanceof exp.Identifier) _canon(alias.this, refAlias);
        if (alias.columns.length) {
          const tc = tableColumns.get(table) || new Map();
          alias.set(
            "columns",
            alias.columns.map((c) => exp.toIdentifier(tc.get(c.name) ?? c.name, c.quoted)),
          );
        }
      }
    }

    let outputMap = new Map();
    if (scopeExpr instanceof exp.Select) {
      for (const sel of scopeExpr.selects) {
        // Sets default name for subquery projections, both aliased and unaliased.
        if ((sel instanceof exp.Alias || sel instanceof exp.Subquery) && sel.alias) {
          const oldAlias = sel.alias;
          let newName;
          if (isOutputScope) {
            newName = oldAlias;
          } else {
            newName = nextColumn();
            sel.set("alias", exp.toIdentifier(newName, true));
          }

          outputMap.set(oldAlias, newName);
        }
      }
    } else if (scopeExpr instanceof exp.SetOperation && scope.unionScopes.length) {
      // Regular UNION names come from the left branch. UNION BY NAME folds in
      // right-branch names too (any column unique to the right still appears in the
      // output).
      const leftOut = scopeOutputs.get(scope.unionScopes[0].expression) || new Map();
      outputMap = new Map(leftOut);
      if (scopeExpr.args.by_name) {
        const rightOut = scopeOutputs.get(scope.unionScopes[1].expression) || new Map();
        for (const [k, v] of rightOut) {
          if (!outputMap.has(k)) outputMap.set(k, v);
        }
      }
    } else if (scope.isUdtf && scope.subqueryScopes.length) {
      outputMap = new Map(scopeOutputs.get(scope.subqueryScopes[0].expression) || new Map());
    }

    scopeOutputs.set(scopeExpr, outputMap);

    // Unqualified alias references (ORDER BY a, HAVING a > 5, ...)
    for (const col of findAllInScope(scopeExpr, exp.Column)) {
      if (!col.text("table") && outputMap.has(col.name)) {
        _canon(col.this, outputMap.get(col.name));
      }
    }

    // UBN matches branches by original alias. When both branches are internal and
    // aliased to distinct _cN, matching originals land on different slots and UBN
    // splits them into disjoint output columns, dropping data. Align the right
    // branch's canonicals to the left's. No-op when both branches preserved their
    // aliases (top-level UBN).
    if (scopeExpr instanceof exp.SetOperation && scopeExpr.args.by_name) {
      const [leftScope, rightScope] = scope.unionScopes;
      const leftOut = scopeOutputs.get(leftScope.expression) || new Map();
      const rightOut = scopeOutputs.get(rightScope.expression) || new Map();

      const rename = new Map();
      for (const [origName, leftCanon] of leftOut) {
        const rightCanon = rightOut.get(origName);
        if (rightCanon && rightCanon !== leftCanon) rename.set(rightCanon, leftCanon);
      }

      if (rename.size) {
        const renameStack = [rightScope.expression];
        while (renameStack.length) {
          const node = renameStack.pop();
          if (node instanceof exp.SetOperation) {
            renameStack.push(node.this);
            renameStack.push(node.expression);
            continue;
          }
          if (!(node instanceof exp.Select)) continue;
          for (const sel of node.selects) {
            if (sel instanceof exp.Alias) {
              const aid = sel.args.alias;
              if (aid instanceof exp.Identifier && rename.has(aid.name)) {
                _canon(aid, rename.get(aid.name));
              }
            }
          }
          for (const col of findAllInScope(node, exp.Column)) {
            if (!col.text("table") && rename.has(col.name)) {
              _canon(col.this, rename.get(col.name));
            }
          }
        }

        const newRightOut = new Map();
        for (const [k, v] of rightOut) newRightOut.set(k, rename.get(v) ?? v);
        scopeOutputs.set(rightScope.expression, newRightOut);
      }
    }
  }

  return expression;
}
