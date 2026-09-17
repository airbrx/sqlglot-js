// py: sqlglot/optimizer/unnest_subqueries.py @ 91119bc — WHOLE FILE (345 LOC).
//
// Greenfield module (no existing consumer in this port), same shape as
// `optimize_joins.js` (R45) and `schema.js` (R41): verified by its own new
// differential oracle rather than by `corpus/atoms.jsonl`, which has no rows for it.
//
// Imports `ScopeType`/`findInScope`/`traverseScope` from the real `optimizer/scope.js`
// (R44/R46, `Scope` class + the recursive `traverseScope`/`buildScope` builder) — no
// hand-wiring needed here, unlike R44's own oracle before R46 landed. The upstream
// `_typing.E` import is a type-only annotation with no JS analogue and is dropped,
// matching every other ported file's treatment of `TypeVar`/`Iterable` type imports.
//
// `exp.condition` did not exist anywhere in this port before this file needed it as
// `_replace`'s public entry point (py:327-328) — added as a strictly-additive builder
// in `src/expressions/core.js` (PORT_PLAN.md §8.1 Rule 3(c)), a thin `maybeParse(...,
// {into: Condition})` wrapper matching upstream `core.py:2850` exactly.
//
// Module-level function names (`unnest_subqueries`, `unnest`, `decorrelate`,
// `_replace`, `_other_operand`) stay snake_case verbatim, matching this project's
// established convention for optimizer/`transforms.js` top-level defs (R45's own
// header cites `normalize_identifiers.js`/`canonicalize.js`/`transforms.js`).
// `_replace`/`_other_operand` stay module-private and unexported, the same treatment
// `optimize_joins.js`'s `_is_reorderable` gets for an underscore-prefixed helper used
// only within its own file.
//
// SIX deny:implicit_str acknowledgement sites (py:241, 251, 256, 265, 268, 272) — every
// one of them an f-string embedding an `Expr` operand. Python's `Expr.__str__` returns
// `self.sql()` (core.py:1237-1238); this port's `Expr.toString()` instead returns the
// VERBOSE repr (matching `__repr__`/`to_s`, per R21/R46), so every site below calls
// `.sql()` explicitly inside the template literal rather than interpolating the node
// directly — corpus/deny/implicit_str.json's census for this file, confirmed against
// the six real line numbers before writing a single one of these.

import * as exp from "../expressions/index.js";
import { nameSequence } from "../helper.js";
import { ScopeType, findInScope, traverseScope } from "./scope.js";
import { ExprMap, ExprSet } from "../_py/collections.js";

/**
 * py: unnest_subqueries.py:8 `unnest_subqueries(expression)`.
 *
 * Rewrite sqlglot AST to convert some predicates with subqueries into joins.
 *
 * Convert scalar subqueries into cross joins.
 * Convert correlated or vectorized subqueries into a group by so it is not a many to
 * many left join.
 *
 * Example:
 *   unnest_subqueries(parseOne(
 *     "SELECT * FROM x AS x WHERE (SELECT y.a AS a FROM y AS y WHERE x.a = y.a) = 1"
 *   )).sql()
 *   -> 'SELECT * FROM x AS x LEFT JOIN (SELECT y.a AS a FROM y AS y WHERE TRUE GROUP BY y.a) AS _u_0 ON x.a = _u_0.a WHERE _u_0.a = 1'
 */
export function unnest_subqueries(expression) {
  const next_alias_name = nameSequence("_u_");

  for (const scope of traverseScope(expression)) {
    const select = scope.expression;
    const parent = select.parentSelect;
    if (!parent) continue;
    if (scope.externalColumns.length) {
      decorrelate(select, parent, scope.externalColumns, next_alias_name);
    } else if (scope.scopeType === ScopeType.SUBQUERY) {
      unnest(select, parent, next_alias_name);
    }
  }

  return expression;
}

/** py: unnest_subqueries.py:41 `unnest(select, parent_select, next_alias_name)`. */
export function unnest(select, parent_select, next_alias_name) {
  if (select.selects.length > 1) return;

  let predicate = select.findAncestor(exp.Condition);
  if (
    !predicate
    // Do not unnest subqueries inside table-valued functions such as
    // FROM GENERATE_SERIES(...), FROM UNNEST(...) etc in order to preserve join order
    || (
      predicate instanceof exp.Func
      && (predicate.parent instanceof exp.Table || predicate.parent instanceof exp.From || predicate.parent instanceof exp.Join)
    )
    || parent_select !== predicate.parentSelect
    || !parent_select.args.from_
    // NOT IN has three-valued semantics that the LEFT-JOIN-anti rewrite doesn't preserve:
    // a NULL in the subquery makes NOT IN evaluate to NULL for every outer row.
    || (predicate instanceof exp.In && predicate.parent instanceof exp.Not)
  ) {
    return;
  }

  if (select instanceof exp.SetOperation) {
    const inner_alias = next_alias_name();
    select = exp.select(
      ...select.selects.map((s) => exp.alias_(exp.column(s.aliasOrName, inner_alias), s.aliasOrName)),
    ).from_(select.subquery(inner_alias));
  }

  const alias = next_alias_name();
  const clause = predicate.findAncestor(exp.Having, exp.Where, exp.Join);

  // This subquery returns a scalar and can just be converted to a cross join
  if (!(predicate instanceof exp.In) && !(predicate instanceof exp.Any)) {
    let column = exp.column(select.selects[0].aliasOrName, alias);

    const clause_parent_select = clause ? clause.parentSelect : null;

    if (
      (clause instanceof exp.Having && clause_parent_select === parent_select)
      || (
        (!clause || clause_parent_select !== parent_select)
        && (
          parent_select.args.group
          || parent_select.selects.some((s) => findInScope(s, exp.AggFunc))
        )
      )
    ) {
      column = new exp.Max({ this: column });
    } else if (!(select.parent instanceof exp.Subquery)) {
      return;
    }

    let join_type = "CROSS";
    let on_clause = null;
    if (predicate instanceof exp.Exists) {
      // If a subquery returns no rows, cross-joining against it incorrectly eliminates
      // all rows from the parent query. Therefore, we use a LEFT JOIN that always
      // matches (ON TRUE), then check for non-NULL column values to determine whether
      // the subquery contained rows.
      column = column.is_(exp.null()).not_();
      join_type = "LEFT";
      on_clause = exp.true();
    }

    _replace(select.parent, column);
    parent_select.join(select, { on: on_clause, join_type, join_alias: alias, copy: false });

    return;
  }

  if (findInScope(select, exp.Limit, exp.Offset)) return;

  if (predicate instanceof exp.Any) {
    predicate = predicate.findAncestor(exp.EQ);

    if (!predicate || parent_select !== predicate.parentSelect) return;
  }

  const column = _other_operand(predicate);
  const value = select.selects[0];

  const join_key = exp.column(value.alias, alias);
  const join_key_not_null = join_key.is_(exp.null()).not_();

  if (clause instanceof exp.Join) {
    _replace(predicate, exp.true());
    parent_select.where(join_key_not_null, { copy: false });
  } else {
    _replace(predicate, join_key_not_null);
  }

  const group = select.args.group;

  if (group) {
    // py: `{value.this} != set(group.expressions)` — a one-element Python set built
    // from `value.this`, compared against the (deduplicated, `Expr.__eq__`-keyed) set
    // of `group.expressions`. `ExprSet` reproduces the same value-keyed dedup §4.5
    // requires elsewhere in this port.
    const groupSet = new ExprSet(group.expressions);
    if (!(groupSet.size === 1 && groupSet.has(value.this))) {
      select = exp.select(exp.alias_(exp.column(value.alias, "_q"), value.alias))
        .from_(select.subquery("_q", { copy: false }), { copy: false })
        .groupBy(exp.column(value.alias, "_q"), { copy: false });
    }
  } else if (!findInScope(value.this, exp.AggFunc)) {
    select = select.groupBy(value.this, { copy: false });
  }

  parent_select.join(select, {
    on: column.eq(join_key),
    join_type: "LEFT",
    join_alias: alias,
    copy: false,
  });
}

/** py: unnest_subqueries.py:148 `decorrelate(select, parent_select, external_columns, next_alias_name)`. */
export function decorrelate(select, parent_select, external_columns, next_alias_name) {
  const where = select.args.where;

  if (!where || where.find(exp.Or) || select.find(exp.Limit, exp.Offset)) return;

  const table_alias = next_alias_name();
  const keys = [];

  // for all external columns in the where statement, find the relevant predicate
  // keys to convert it into a join
  for (const column of external_columns) {
    if (column.findAncestor(exp.Where) !== where) return;

    // The predicate is replaced with TRUE below, which is only sound if its result
    // flows into the WHERE through conjunctions; wrappers like NOT would invert that
    // TRUE.
    const predicate = column.findAncestor(exp.Predicate);
    let ancestor = predicate ? predicate.parent : null;
    while (ancestor instanceof exp.And || ancestor instanceof exp.Paren) {
      ancestor = ancestor.parent;
    }

    if (ancestor !== where) return;

    let key;
    if (predicate instanceof exp.Binary) {
      key = [...predicate.left.walk()].some((node) => node === column)
        ? predicate.right
        : predicate.left;
    } else {
      return;
    }

    keys.push([key, column, predicate]);
  }

  if (!keys.some(([, , predicate]) => predicate instanceof exp.EQ)) return;

  const is_subquery_projection = parent_select.selects
    .map((s) => s.unalias())
    .some((node) => node instanceof exp.Subquery && node === select.parent);

  const value = select.selects[0];
  const key_aliases = new ExprMap();
  const group_by = [];

  for (const [key, , predicate] of keys) {
    // if we filter on the value of the subquery, it needs to be unique
    if (key.equals(value.this)) {
      key_aliases.set(key, value.alias);
      group_by.push(key);
    } else {
      if (!key_aliases.has(key)) {
        key_aliases.set(key, next_alias_name());
      }
      // all predicates that are equalities must also be in the unique
      // so that we don't do a many to many join
      if (predicate instanceof exp.EQ && !group_by.some((g) => g.equals(key))) {
        group_by.push(key);
      }
    }
  }

  let parent_predicate = select.findAncestor(exp.Predicate);

  // When the subquery is embedded inside a function (e.g. COALESCE, TRIM) in the
  // SELECT list, the ancestor chain contains no Predicate node AND the subquery is
  // not a direct projection.
  if (!parent_predicate && !is_subquery_projection) return;

  // if the value of the subquery is not an agg or a key, we need to collect it into
  // an array so that it can be grouped. For subquery projections, we use a MAX
  // aggregation instead.
  const agg_func = is_subquery_projection ? exp.Max : exp.ArrayAgg;
  if (
    !(value instanceof exp.Subquery)
    && !findInScope(value, exp.AggFunc)
    && !group_by.some((g) => g.equals(value.this))
  ) {
    select.select(
      exp.alias_(new agg_func({ this: value.this }), value.alias, { quoted: false }),
      { append: false, copy: false },
    );
  }

  // exists queries should not have any selects as it only checks if there are any rows
  // all selects will be added by the optimizer and only used for join keys
  if (parent_predicate instanceof exp.Exists) {
    select.set("expressions", []);
  }

  for (const [key, alias] of key_aliases) {
    if (group_by.some((g) => g.equals(key))) {
      // add all keys to the projections of the subquery
      // so that we can use it as a join key
      if (parent_predicate instanceof exp.Exists || !key.equals(value.this)) {
        // deny:implicit_str sqlglot/optimizer/unnest_subqueries.py:241 — `key` is an
        // `Expr`; `.toString()` would render `to_s`'s verbose repr, not SQL.
        select.select(`${key.sql()} AS ${alias}`, { copy: false });
      }
    } else {
      select.select(exp.alias_(new agg_func({ this: key.copy() }), alias, { quoted: false }), { copy: false });
    }
  }

  let alias = exp.column(value.alias, table_alias);
  const other = _other_operand(parent_predicate);
  const op_type = parent_predicate ? parent_predicate.parent.constructor : null;

  // py:253/259 `assert issubclass(op_type, exp.Binary)` — a pure debug assertion with
  // no `_py/` equivalent shimmed in this port yet; dropped like every other bare
  // Python `assert` this port drops, since it has no effect on control flow or
  // output when it holds (and both call sites are unreachable with it violated: the
  // `All`/`Any` branches below only run when `parent_predicate.parent` is itself a
  // comparison operator, by construction of how `ALL(...)`/`ANY(...)` parse).
  if (parent_predicate instanceof exp.Exists) {
    alias = exp.column([...key_aliases.values()][0], table_alias);
    // deny:implicit_str sqlglot/optimizer/unnest_subqueries.py:251 — `alias` is an
    // `Expr` (`exp.column(...)`).
    parent_predicate = _replace(parent_predicate, `NOT ${alias.sql()} IS NULL`);
  } else if (parent_predicate instanceof exp.All) {
    const predicate = new op_type({ this: other, expression: exp.column("_x") });
    // deny:implicit_str sqlglot/optimizer/unnest_subqueries.py:256 — both `alias` and
    // `predicate` are `Expr` nodes.
    parent_predicate = _replace(
      parent_predicate.parent,
      `ARRAY_ALL(${alias.sql()}, _x -> ${predicate.sql()})`,
    );
  } else if (parent_predicate instanceof exp.Any) {
    if (group_by.some((g) => g.equals(value.this))) {
      const predicate = new op_type({ this: other, expression: alias });
      parent_predicate = _replace(parent_predicate.parent, predicate);
    } else {
      const predicate = new op_type({ this: other, expression: exp.column("_x") });
      // deny:implicit_str sqlglot/optimizer/unnest_subqueries.py:265 — both `alias`
      // and `predicate` are `Expr` nodes.
      parent_predicate = _replace(
        parent_predicate,
        `ARRAY_ANY(${alias.sql()}, _x -> ${predicate.sql()})`,
      );
    }
  } else if (parent_predicate instanceof exp.In) {
    if (group_by.some((g) => g.equals(value.this))) {
      // deny:implicit_str sqlglot/optimizer/unnest_subqueries.py:268 — both `other`
      // and `alias` are `Expr` nodes.
      parent_predicate = _replace(parent_predicate, `${other.sql()} = ${alias.sql()}`);
    } else {
      // deny:implicit_str sqlglot/optimizer/unnest_subqueries.py:272 — `alias` and
      // `parent_predicate.this` are `Expr` nodes.
      parent_predicate = _replace(
        parent_predicate,
        `ARRAY_ANY(${alias.sql()}, _x -> _x = ${parent_predicate.this.sql()})`,
      );
    }
  } else {
    if (is_subquery_projection && select.parent.alias) {
      alias = exp.alias_(alias, select.parent.alias);
    }

    // COUNT always returns 0 on empty datasets, so we need take that into
    // consideration here by transforming all counts into 0 and using that as the
    // coalesced value
    if (findInScope(value, exp.Count)) {
      const remove_aggs = (node) => {
        if (node instanceof exp.Count) return exp.Literal.number(0);
        if (node instanceof exp.AggFunc) return exp.null();
        return node;
      };

      alias = new exp.Coalesce({ this: alias, expressions: [value.this.transform(remove_aggs)] });
    }

    select.parent.replace(alias);
  }

  for (const [key, column, predicate] of keys) {
    predicate.replace(exp.true());
    const nested = exp.column(key_aliases.get(key), table_alias);

    if (is_subquery_projection) {
      key.replace(nested);
      if (!(predicate instanceof exp.EQ)) {
        parent_select.where(predicate, { copy: false });
      }
      continue;
    }

    if (group_by.some((g) => g.equals(key))) {
      key.replace(nested);
    } else {
      // Built as AST rather than a SQL string, because dialect-specific operators
      // such as Postgres' `@>` can't be round-tripped through the default dialect's
      // parser.
      key.replace(exp.toIdentifier("_x"));
      const right = new exp.ArrayAny({
        this: nested,
        expression: new exp.Lambda({ this: predicate.copy(), expressions: [exp.toIdentifier("_x")] }),
      });
      parent_predicate = _replace(
        parent_predicate,
        exp.paren(exp.and_(parent_predicate.copy(), right, { copy: false })),
      );
    }
  }

  parent_select.join(
    select.groupBy(...group_by, { copy: false }),
    {
      on: keys.filter(([, , predicate]) => predicate instanceof exp.EQ).map(([, , predicate]) => predicate),
      join_type: "LEFT",
      join_alias: table_alias,
      copy: false,
    },
  );
}

/** py: unnest_subqueries.py:327 `_replace(expression, condition)`. */
function _replace(expression, condition) {
  return expression.replace(exp.condition(condition));
}

/** py: unnest_subqueries.py:331 `_other_operand(expression)`. */
function _other_operand(expression) {
  if (expression instanceof exp.In) {
    return expression.this;
  }

  if (expression instanceof exp.Any || expression instanceof exp.All) {
    return _other_operand(expression.parent);
  }

  if (expression instanceof exp.Binary) {
    return expression.left instanceof exp.Subquery
      || expression.left instanceof exp.Any
      || expression.left instanceof exp.Exists
      || expression.left instanceof exp.All
      ? expression.right
      : expression.left;
  }

  return null;
}
