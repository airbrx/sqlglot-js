// py: sqlglot/optimizer/eliminate_joins.py @ 91119bc — WHOLE FILE (196 LOC).
//
// Depends on two already-ported optimizer modules: `normalized` (`./normalize.js`,
// landed R68) and the real `Scope`/`traverseScope` (`./scope.js`, landed R44/R46 — the
// genuine tree builder, not a hand-wired stand-in). Both are read here exactly as they
// already export: `traverseScope`/`removeSource`/`sourceColumns`/`unqualifiedColumns`
// are camelCase methods/getters on `Scope` (upstream `traverse_scope`/`remove_source`/
// `source_columns`/`unqualified_columns`), matching the convention every other caller
// of `scope.js` in this repo already uses (`qualify_tables.js`, `merge_subqueries.js`,
// `isolate_table_selects.js`, ...). The upstream `_typing.E`/`typing.TYPE_CHECKING`
// import is a type-only annotation with no JS analogue and is dropped, matching every
// other ported file in this repo.
//
// `_unique_outputs`/`join_condition` (py:99 `set(group.expressions)`, py:186
// `p == c` over `list[exp.EQ]`) rely on Python's `Expression.__eq__`/`__hash__` being
// STRUCTURAL (content-hash, not identity) — `sqlglot/expressions/core.py:836-837`. A
// bare JS `Set`/`===` would key on object identity and silently miss every case where
// the GROUP BY expression and the matching SELECT output (or two independently-built
// EQ conditions) are distinct objects with the same shape, which is the common case.
// This port already has the exact container for that, built for the same hazard in
// `simplify.js`/`normalize.js`: `_py/collections.js`'s `ExprSet` (hashes/compares via
// `Expr#hash()`/`Expr#equals()`) for `grouped_expressions`/`grouped_outputs`, and plain
// `.equals()` calls for the `p == c` comparison inside `join_condition`.
//
// `_join_is_used`'s `on_clause_columns: set[int] = {id(column) for ...}` is the
// opposite case — Python tracks OBJECT IDENTITY there (`id()`), not structural
// equality, to tell "the same Column node" from "a different Column node that merely
// looks the same". A plain JS `Set` of the `exp.Column` object references is the
// correct, direct translation: JS `Set`/`has()` already compares object references by
// identity, which is exactly what `id()` membership testing does in Python.

import * as exp from "../expressions/index.js";
import { ExprSet } from "../_py/collections.js";
import { normalized } from "./normalize.js";
import { Scope, traverseScope } from "./scope.js";

/**
 * py: eliminate_joins.py:13 `eliminate_joins(expression)`.
 *
 * Remove unused joins from an expression.
 *
 * This only removes joins when we know that the join condition doesn't produce
 * duplicate rows.
 *
 * Example:
 *   eliminate_joins(parseOne(
 *     "SELECT x.a FROM x LEFT JOIN (SELECT DISTINCT y.b FROM y) AS y ON x.b = y.b",
 *   )).sql() -> 'SELECT x.a FROM x'
 *
 * @param {exp.Expr} expression expression to optimize
 * @returns {exp.Expr} The optimized expression
 */
export function eliminate_joins(expression) {
  for (const scope of traverseScope(expression)) {
    const joins = scope.expression.args.joins || [];
    if (!joins.length) continue;

    // If any columns in this scope aren't qualified, it's hard to determine if a join
    // isn't used. It's probably possible to infer this from the outputs of derived
    // tables. But for now, let's just skip this rule.
    if (scope.unqualifiedColumns.length) continue;

    // Reverse the joins so we can remove chains of unused joins
    for (const join of [...joins].reverse()) {
      if (join.isSemiOrAntiJoin) continue;

      const alias = join.aliasOrName;
      if (_should_eliminate_join(scope, join, alias)) {
        join.pop();
        scope.removeSource(alias);
      }
    }
  }

  return expression;
}

/** py: eliminate_joins.py:56 `_should_eliminate_join(scope, join, alias)`. */
function _should_eliminate_join(scope, join, alias) {
  const inner_source = scope.sources.get(alias);
  return (
    inner_source instanceof Scope
    && !_join_is_used(scope, join, alias)
    && ((join.side === "LEFT" && _is_joined_on_all_unique_outputs(inner_source, join))
      || (!join.args.on && _has_single_output_row(inner_source)))
  );
}

/** py: eliminate_joins.py:68 `_join_is_used(scope, join, alias)`. */
function _join_is_used(scope, join, alias) {
  // We need to find all columns that reference this join.
  // But columns in the ON clause shouldn't count.
  const on = join.args.on;
  const on_clause_columns = on != null ? new Set(on.findAll(exp.Column)) : new Set();
  return scope.sourceColumns(alias).some((column) => !on_clause_columns.has(column));
}

/** py: eliminate_joins.py:81 `_is_joined_on_all_unique_outputs(scope, join)`. */
function _is_joined_on_all_unique_outputs(scope, join) {
  const unique_outputs = _unique_outputs(scope);
  if (!unique_outputs.size) return false;

  const [, join_keys] = join_condition(join);
  const join_key_names = new Set(join_keys.map((c) => c.name));
  const remaining_unique_outputs = [...unique_outputs].filter((x) => !join_key_names.has(x));
  return !remaining_unique_outputs.length;
}

/**
 * py: eliminate_joins.py:91 `_unique_outputs(scope)` — Determine output columns of
 * `scope` that must have a unique combination per row.
 */
function _unique_outputs(scope) {
  const expr = scope.expression;
  if (expr.args.distinct != null) return new Set(expr.namedSelects);

  const group = expr.args.group;
  if (group != null) {
    const grouped_expressions = new ExprSet(group.expressions);
    const grouped_outputs = new ExprSet();

    const unique_outputs = new Set();
    for (const select of expr.selects) {
      const output = select.unalias();
      if (grouped_expressions.has(output)) {
        grouped_outputs.add(output);
        unique_outputs.add(select.aliasOrName);
      }
    }

    // All the grouped expressions must be in the output
    const remaining = [...grouped_expressions].filter((x) => !grouped_outputs.has(x));
    if (!remaining.length) return unique_outputs;
    return new Set();
  }

  if (_has_single_output_row(scope)) return new Set(expr.namedSelects);

  return new Set();
}

/** py: eliminate_joins.py:121 `_has_single_output_row(scope)`. */
function _has_single_output_row(scope) {
  return scope.expression instanceof exp.Select && (
    scope.expression.selects.every((e) => e.unalias() instanceof exp.AggFunc)
    || _is_limit_1(scope)
    || !scope.expression.args.from_
  );
}

/** py: eliminate_joins.py:129 `_is_limit_1(scope)`. */
function _is_limit_1(scope) {
  const limit = scope.expression.args.limit;
  return limit != null && limit.expression.this === "1";
}

/**
 * py: eliminate_joins.py:134 `join_condition(join)` — Extract the join condition from
 * a join expression.
 *
 * @param {exp.Join} join
 * @returns {[exp.Expr[], exp.Expr[], exp.Expr]} Tuple of (source key, join key,
 *   remaining predicate)
 */
export function join_condition(join) {
  const name = join.aliasOrName;
  let on = (join.args.on || exp.true()).copy();
  const source_key = [];
  const join_key = [];

  function extract_condition(condition) {
    const [left, right] = condition.unnestOperands();
    const left_tables = exp.columnTableNames(left);
    const right_tables = exp.columnTableNames(right);

    if (left_tables.has(name) && !right_tables.has(name)) {
      join_key.push(left);
      source_key.push(right);
      condition.replace(exp.true());
    } else if (right_tables.has(name) && !left_tables.has(name)) {
      join_key.push(right);
      source_key.push(left);
      condition.replace(exp.true());
    }
  }

  // find the join keys
  // SELECT
  // FROM x
  // JOIN y
  //   ON x.a = y.b AND y.b > 1
  //
  // should pull y.b as the join key and x.a as the source key
  if (normalized(on)) {
    if (!(on instanceof exp.And)) on = exp.and_(on, exp.true(), { copy: false });

    for (const condition of on.flatten()) {
      if (condition instanceof exp.EQ) extract_condition(condition);
    }
  } else if (normalized(on, true)) {
    let conditions = [];

    for (const condition of on.flatten()) {
      const parts = [...condition.flatten()].filter((part) => part instanceof exp.EQ);
      if (!conditions.length) {
        conditions = parts;
      } else {
        const temp = [];
        for (const p of parts) {
          const cs = conditions.filter((c) => p.equals(c));

          if (cs.length) {
            temp.push(p);
            temp.push(...cs);
          }
        }
        conditions = temp;
      }
    }

    for (const condition of conditions) extract_condition(condition);
  }

  return [source_key, join_key, on];
}
