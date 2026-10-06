// py: sqlglot/optimizer/pushdown_predicates.py @ 91119bc — WHOLE FILE (281 LOC).
//
// Rewrite sqlglot AST to pushdown predicates in FROMS and JOINS.
//
// Example:
//   pushdown_predicates(parseOne("SELECT y.a AS a FROM (SELECT x.a AS a FROM x AS x) AS y WHERE y.a = 1")).sql()
//   -> "SELECT y.a AS a FROM (SELECT x.a AS a FROM x AS x WHERE x.a = 1) AS y WHERE TRUE"
//
// Depends on `normalized` (`normalize.js`, R68), `simplify` (`simplify.js`, R59) and
// `Scope`/`buildScope`/`findInScope` (`scope.js`, R44/R46) — all already ported and
// used here exactly as upstream uses them; nothing in this module needed a workaround.
//
// `unnest_requires_cross_join` (py:41 `isinstance(dialect, (Athena, Presto))`) is a
// REAL, DOCUMENTED GAP, not a silent approximation: upstream's own top-level imports
// are `from sqlglot.dialects.athena import Athena` / `from sqlglot.dialects.presto
// import Presto`, and neither `src/dialects/athena.js` nor `src/dialects/presto.js`
// (nor `trino.js`, which upstream's Presto subclass covers via the same isinstance
// check) exists in this port yet -- `ls src/dialects/` only has the 10 dialects landed
// through R43. `Dialect.get_or_raise("presto"|"trino"|"athena")` already throws
// (`DIALECT_CLASSES` has no entry for them, only `DIALECT_MODULE_NAMES` lists the
// name), so `parse_one(sql, read="presto")` — the FIRST step of every fixture pair
// gated behind `# dialect: presto|trino|athena` in `tests/fixtures/optimizer/
// pushdown_predicates.sql` — already fails in this port independently of this file.
// The flag is therefore hardcoded `false` here (never true, since the only two
// `Dialect` subclasses that could set it don't exist) with this comment as the
// pointer, the same way R51's typing overlays note a scenario their own real
// parser/generator can't yet reach rather than faking a result for it. Revisit when
// Athena/Presto/Trino dialects land; see PORT_PLAN.md.

import * as exp from "../expressions/index.js";
import { PyValueError } from "../errors.js";
import { Dialect } from "../dialects/dialect.js";
import { normalized } from "./normalize.js";
import { findInScope, buildScope } from "./scope.js";
import { simplify } from "./simplify.js";

/** py: pushdown_predicates.py:19 `pushdown_predicates(expression, dialect=None)`. */
export function pushdown_predicates(expression, dialect = null) {
  const root = buildScope(expression);

  dialect = Dialect.get_or_raise(dialect);
  // See the module header: always false in this port (Athena/Presto are unported).
  const unnest_requires_cross_join = false;

  if (root) {
    const scope_ref_count = root.refCount();

    for (const scope of [...root.traverse()].reverse()) {
      const select = scope.expression;
      const where = select.args.where;
      const joins = select.args.joins || [];

      if (where) {
        let selected_sources = scope.selectedSources;
        const join_index = new Map(joins.map((join, i) => [join.aliasOrName, i]));

        // a right join can only push down to itself and not the source FROM table
        // presto, trino and athena don't support inner joins where the RHS is an
        // UNNEST expression
        let pushdown_allowed = true;
        for (const [k, [node, source]] of selected_sources) {
          const parent = node.findAncestor(exp.Join, exp.From);
          if (parent instanceof exp.Join) {
            if (parent.side === "RIGHT") {
              selected_sources = new Map([[k, [node, source]]]);
              break;
            }
            if (node instanceof exp.Unnest && unnest_requires_cross_join) {
              pushdown_allowed = false;
              break;
            }
          }
        }

        if (pushdown_allowed) {
          pushdown(where.this, selected_sources, scope_ref_count, dialect, join_index);
        }
      }

      // joins should only pushdown into itself, not to other joins
      // so we limit the selected sources to only itself
      for (const join of joins) {
        const name = join.aliasOrName;

        if (join.side === "RIGHT" || join.side === "FULL") continue;

        if (scope.selectedSources.has(name)) {
          pushdown(
            join.args.on,
            new Map([[name, scope.selectedSources.get(name)]]),
            scope_ref_count,
            dialect,
          );
        }
      }
    }
  }

  return expression;
}

/** py: pushdown_predicates.py:89 `pushdown(condition, sources, scope_ref_count, dialect, join_index=None)`. */
function pushdown(condition, sources, scope_ref_count, dialect, join_index = null) {
  if (!condition) return;

  condition = condition.replace(simplify(condition, { dialect }));
  const cnf_like = normalized(condition) || !normalized(condition, true);

  const predicates = condition instanceof (cnf_like ? exp.And : exp.Or)
    ? [...condition.flatten()]
    : [condition];

  if (cnf_like) {
    pushdown_cnf(predicates, sources, scope_ref_count, join_index);
  } else {
    pushdown_dnf(predicates, sources, scope_ref_count, join_index);
  }
}

/**
 * py: pushdown_predicates.py:114 `pushdown_cnf(predicates, sources, scope_ref_count,
 * join_index=None)`.
 *
 * If the predicates are in CNF like form, we can simply replace each block in the
 * parent.
 */
function pushdown_cnf(predicates, sources, scope_ref_count, join_index = null) {
  for (const predicate of predicates) {
    for (const node of nodes_for_predicate(predicate, sources, scope_ref_count).values()) {
      if (node instanceof exp.Join) {
        const name = node.aliasOrName;
        const predicate_tables = exp.columnTableNames(predicate, name);

        if (join_index) {
          // Don't push the predicate if it references tables that appear in later joins
          const this_index = join_index.get(name);
          if ([...predicate_tables].every((table) => (join_index.get(table) ?? -1) < this_index)) {
            predicate.replace(exp.true());
            node.on(predicate, { copy: false });
            break;
          }
        }
      }
      if (node instanceof exp.Select) {
        predicate.replace(exp.true());
        const inner_predicate = replace_aliases(node, predicate);
        if (findInScope(inner_predicate, exp.AggFunc)) {
          node.having(inner_predicate, { copy: false });
        } else {
          node.where(inner_predicate, { copy: false });
        }
      }
    }
  }
}

/**
 * py: pushdown_predicates.py:145 `pushdown_dnf(predicates, sources, scope_ref_count,
 * join_index=None)`.
 *
 * If the predicates are in DNF form, we can only push down conditions that are in all
 * blocks. Additionally, we can't remove predicates from their original form.
 */
function pushdown_dnf(predicates, sources, scope_ref_count, join_index = null) {
  // find all the tables that can be pushdown too
  // these are tables that are referenced in all blocks of a DNF
  // (a.x AND b.x) OR (a.y AND c.y)
  // only table a can be push down
  const pushdown_tables = new Set();

  for (const a of predicates) {
    let a_tables = exp.columnTableNames(a);

    for (const b of predicates) {
      const b_tables = exp.columnTableNames(b);
      a_tables = new Set([...a_tables].filter((t) => b_tables.has(t)));
    }

    for (const t of a_tables) pushdown_tables.add(t);
  }

  const conditions = new Map();

  // pushdown all predicates to their respective nodes
  for (const table of [...pushdown_tables].sort()) {
    // py: `for name, node in nodes.items():` just below reads `nodes` from the LAST
    // iteration of this loop over `predicates` — a Python for-loop variable leak
    // (same pattern as `scope.js`'s `_traverseUnion`'s `lastScope`), not an
    // accumulation across predicates. `nodes` is declared outside the loop here to
    // make that explicit.
    let nodes = new Map();

    for (const predicate of predicates) {
      nodes = nodes_for_predicate(predicate, sources, scope_ref_count);

      if (!nodes.has(table)) continue;

      conditions.set(
        table,
        conditions.has(table) ? exp.or_(conditions.get(table), predicate) : predicate,
      );
    }

    for (const [name, node] of nodes) {
      if (!conditions.has(name)) continue;

      const predicate = conditions.get(name);

      if (node instanceof exp.Join) {
        if (join_index) {
          const this_index = join_index.get(name);
          const predicate_tables = exp.columnTableNames(predicate, name);
          if (![...predicate_tables].every((t) => (join_index.get(t) ?? -1) < this_index)) continue;
        }
        node.on(predicate, { copy: false });
      } else if (node instanceof exp.Select) {
        const inner_predicate = replace_aliases(node, predicate);
        if (findInScope(inner_predicate, exp.AggFunc)) {
          node.having(inner_predicate, { copy: false });
        } else {
          node.where(inner_predicate, { copy: false });
        }
      }
    }
  }
}

/** py: pushdown_predicates.py:204 `nodes_for_predicate(predicate, sources, scope_ref_count)`. */
function nodes_for_predicate(predicate, sources, scope_ref_count) {
  const nodes = new Map();
  const tables = exp.columnTableNames(predicate);
  const where_condition = predicate.findAncestor(exp.Join, exp.Where) instanceof exp.Where;

  for (const table of [...tables].sort()) {
    let [node, source] = sources.get(table) || [null, null];

    // if the predicate is in a where statement we can try to push it down
    // we want to find the root join or from statement
    if (node && where_condition) {
      node = node.findAncestor(exp.Join, exp.From);
    }

    // a node can reference a CTE which should be pushed down

    if (node instanceof exp.From && !(source instanceof exp.Table) && source !== null) {
      const parent = source.parent;
      if (parent === null || parent === undefined) {
        throw new PyValueError("Source node has no parent");
      }
      const with_ = parent.expression.args.with_;
      if (with_ && with_.recursive) return new Map();
      node = source.expression;
    }

    if (node instanceof exp.Join) {
      if (node.side) {
        // A right join preserves its own source, so a WHERE predicate on it can only
        // be pushed into that source, never into the match-only ON clause.
        const pushable_source = node.side === "RIGHT" && !(source instanceof exp.Table) ? source : null;
        if (!pushable_source) return new Map();

        node = pushable_source.expression;
      } else {
        nodes.set(table, node);
      }
    }

    if (node instanceof exp.Select && tables.size === 1) {
      // We can't push down window expressions
      const has_window_expression = node.selects.some((select) => findInScope(select, exp.Window));
      // we can't push down predicates to select statements if they are referenced in
      // multiple places.
      if (
        !node.args.group
        && scope_ref_count.get(source) < 2
        && !has_window_expression
        // LIMIT/OFFSET and QUALIFY select rows before the outer predicate runs
        && !node.args.limit
        && !node.args.offset
        && !node.args.qualify
      ) {
        nodes.set(table, node);
      }
    }
  }
  return nodes;
}

/** py: pushdown_predicates.py:267 `replace_aliases(source, predicate)`. */
function replace_aliases(source, predicate) {
  const aliases = new Map();

  for (const select of source.selects) {
    if (select instanceof exp.Alias) {
      aliases.set(select.alias, select.this);
    } else {
      aliases.set(select.name, select);
    }
  }

  const _replace_alias = (column) => {
    if (column instanceof exp.Column && aliases.has(column.name)) {
      return aliases.get(column.name).copy();
    }
    return column;
  };

  return predicate.transform(_replace_alias);
}
