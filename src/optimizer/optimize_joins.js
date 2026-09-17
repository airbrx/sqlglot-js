// py: sqlglot/optimizer/optimize_joins.py @ 91119bc — WHOLE FILE (134 LOC).
//
// Zero dependency on any other unported optimizer module: the only imports beyond
// `exp` are `errors.OptimizeError` (already ported, `src/errors.js`) and
// `helper.tsort` (already ported, `src/helper.js`). The upstream `_typing.E` import is
// a type-only annotation with no JS analogue and is dropped, matching how every other
// ported file in this repo drops upstream's `TypeVar`/`Iterable` type-only imports.
//
// `exp._combine` (core.py:2761, the private helper `and_`/`or_` wrap) is not exported
// from `src/expressions/core.js` — only its public callers `and_`/`or_`/`xor` are.
// `exp.and_(a, b, {copy: false})` is observationally identical to
// `exp._combine([a, b], exp.And, copy=False)` here: `and_` is a direct
// pass-through to `_combine` with `operator=exp.And` and the same default `wrap=True`
// (verified against `expressions/builders.py`'s `and_`), and the call site below never
// needs `dialect`/extra `**opts`. Using the public entry point avoids exporting a
// private symbol from shared P2 code for a single P10 caller (§8.1 Rule 3).
//
// `_is_reorderable` stays module-private and unexported, matching this port's existing
// convention for underscore-prefixed module-level helpers used only within their own
// file (`dialects/dialect.js`'s `_with_strict_time_inverse`). Its upstream doctest
// (py:124-134) is mirrored as a differential-oracle SQL scenario — comparing the full
// `optimize_joins()` output, not gray-box-testing the private predicate — rather than
// exported for direct unit access, consistent with how this project's oracle-driven
// verification favors end-to-end comparison over poking at private internals.

import * as exp from "../expressions/index.js";
import { OptimizeError } from "../errors.js";
import { tsort } from "../helper.js";

// py: optimize_joins.py:9 `JOIN_ATTRS = ("on", "side", "kind", "using", "method")`
const JOIN_ATTRS = ["on", "side", "kind", "using", "method"];

/**
 * py: optimize_joins.py:12 `optimize_joins(expression)`.
 *
 * Removes cross joins if possible and reorders joins based on predicate dependencies.
 *
 * Example:
 *   optimize_joins(parse_one("SELECT * FROM x CROSS JOIN y JOIN z ON x.a = z.a AND y.a = z.a")).sql()
 *   -> 'SELECT * FROM x JOIN z ON x.a = z.a AND TRUE JOIN y ON y.a = z.a'
 */
export function optimize_joins(expression) {
  for (const select of expression.findAll(exp.Select)) {
    const joins = select.args.joins || [];

    if (!_is_reorderable(joins)) continue;

    const references = new Map();
    const cross_joins = [];

    for (const join of joins) {
      const tables = other_table_names(join);

      if (tables.size) {
        for (const table of tables) {
          references.set(table, [...(references.get(table) || []), join]);
        }
      } else {
        cross_joins.push([join.aliasOrName, join]);
      }
    }

    for (const [name, join] of cross_joins) {
      for (const dep of references.get(name) || []) {
        // An ANTI join's ON clause is negated, i.e. NOT EXISTS(a AND b) is not
        // equivalent to b AND NOT EXISTS(a), so its conjuncts can't be extracted
        if (dep.kind === "ANTI") continue;

        const on = dep.args.on;

        // Only conjuncts can be extracted, i.e. `a OR b` is not `b AND (a OR TRUE)`
        if (on instanceof exp.And) {
          if (other_table_names(dep).size < 2) continue;

          for (let predicate of on.flatten()) {
            if (exp.columnTableNames(predicate).has(name)) {
              predicate.replace(exp.true());
              predicate = exp.and_(join.args.on, predicate, { copy: false });
              join.on(predicate, { append: false, copy: false });
            }
          }
        }
      }
    }
  }

  expression = reorder_joins(expression);
  expression = normalize(expression);
  return expression;
}

/**
 * py: optimize_joins.py:67 `reorder_joins(expression)`.
 *
 * Reorder joins by topological sort order based on predicate references.
 */
export function reorder_joins(expression) {
  for (const from_ of expression.findAll(exp.From)) {
    const parent = from_.parent;
    if (parent === null || parent === undefined) {
      throw new OptimizeError("FROM clause without parent expression");
    }
    const joins = parent.args.joins || [];

    if (!_is_reorderable(joins)) continue;

    const joins_by_name = new Map();
    for (const join of joins) joins_by_name.set(join.aliasOrName, join);

    const dag = new Map();
    for (const [name, join] of joins_by_name) dag.set(name, other_table_names(join));

    parent.set(
      "joins",
      tsort(dag)
        .filter((name) => name !== from_.aliasOrName && joins_by_name.has(name))
        .map((name) => joins_by_name.get(name)),
    );
  }
  return expression;
}

/**
 * py: optimize_joins.py:93 `normalize(expression)`.
 *
 * Remove INNER and OUTER from joins as they are optional.
 */
export function normalize(expression) {
  for (const join of expression.findAll(exp.Join)) {
    if (!JOIN_ATTRS.some((k) => join.args[k])) {
      join.set("kind", "CROSS");
    }

    if (join.kind === "CROSS") {
      join.set("on", null);
    } else {
      if (join.kind === "INNER" || join.kind === "OUTER") {
        join.set("kind", null);
      }

      if (!join.args.on && !join.args.using) {
        join.set("on", exp.true());
      }
    }
  }
  return expression;
}

/** py: optimize_joins.py:112 `other_table_names(join)`. */
export function other_table_names(join) {
  const on = join.args.on;
  return on ? exp.columnTableNames(on, join.aliasOrName) : new Set();
}

/**
 * py: optimize_joins.py:117 `_is_reorderable(joins)`.
 *
 * Checks if joins can be reordered without changing query semantics.
 *
 * Joins with a side (LEFT, RIGHT, FULL) cannot be reordered easily, the order affects
 * which rows are included in the result.
 *
 * Doctest (mirrored as a differential-oracle scenario, not a direct unit test — see
 * the file header):
 *   ast = parse_one("SELECT * FROM x JOIN y ON x.id = y.id JOIN z ON y.id = z.id")
 *   _is_reorderable(ast.find(exp.Select).args.get("joins", [])) -> True
 *   ast = parse_one("SELECT * FROM x LEFT JOIN y ON x.id = y.id JOIN z ON y.id = z.id")
 *   _is_reorderable(ast.find(exp.Select).args.get("joins", [])) -> False
 */
function _is_reorderable(joins) {
  return !joins.some((join) => join.side);
}
