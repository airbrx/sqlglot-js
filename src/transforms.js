// py: sqlglot/transforms.py @ 91119bc
//
// STATUS. Greenfield: this file did not exist before this branch. Ported here: the
// `preprocess` composer (the connective glue nearly every dialect-generator `Select`
// override wraps its transform list with) plus the three highest "blocks" functions
// from the P4-transforms brief — `eliminate_distinct_on`, `eliminate_qualify`,
// `eliminate_semi_and_anti_joins`. The rest of upstream's 1,083 LOC is untouched;
// import only what a future dialect generator needs and port it then.
//
// REACHABILITY, measured rather than assumed (tools/closure_generator.mjs --brief
// transforms.eliminate_distinct_on): upstream moved every dialect `Generator` override
// out of `dialects/*.py` into its own `sqlglot/generators/*.py` package (verified by
// grep — none of these three functions is referenced anywhere in `generator.py` or
// `dialects/*.py`; all 22 references are in `generators/*.py`, e.g.
// `generators/hive.py:337-338`, `generators/snowflake.py:550-552`). Base
// `Generator.TRANSFORMS` (src/generator.js `static TRANSFORMS`) does not map any class
// to these functions, upstream or in this port, and wiring them there anyway would be
// an invented behavior this port does not want. The only two transforms.py calls base
// `Generator` makes on its own — `ensure_bools` and `move_ctes_to_top_level`, from
// `preprocess()`/`_move_ctes_to_top_level()` in src/generator.js — are gated on
// `ENSURE_BOOLS`/`EXPRESSIONS_WITHOUT_NESTED_CTES`, both empty at the base-class level,
// so those two guarded `NotPorted` throws stay correctly unreachable and are not
// revisited here. Net effect, confirmed with `--brief` on all three: real marginal is
// 0 rows today, because every consuming corpus row also needs a dialect's own
// `Generator` subclass (`src/generators/` — absent) and/or `dialect:<name>` resolution
// for generation, neither of which this branch touches. See PORT_PLAN.md R26.
//
// This file deliberately ports only 4 of upstream's ~30 top-level functions (see
// tools/lint_deny.mjs's `isPortedSite`, which otherwise treats a hand-written file with
// no seeded `// py:` skeleton as fully ported and flags every deny-list site in the
// REST of transforms.py as an unacknowledged one):
// @ported-ranges sqlglot/transforms.py 19-71 144-200 201-264 615-631

import { findNewName } from "./helper.js";
import { UnsupportedError } from "./errors.js";
import * as exp from "./expressions/index.js";

/**
 * py: sqlglot/transforms.py:19 `preprocess(transforms, generator=None)`
 *
 * Creates a new transform by chaining a sequence of transformations and converting the
 * resulting expression to SQL, using either the `_sql` method corresponding to the
 * resulting expression, or the appropriate `Generator.TRANSFORMS` function.
 *
 * @param {Array<(expression: exp.Expr) => exp.Expr>} transforms
 * @param {((self: import("./generator.js").Generator, expression: exp.Expr) => string)|null} [generator]
 * @returns {(self: import("./generator.js").Generator, expression: exp.Expr) => string}
 */
export function preprocess(transforms, generator = null) {
  return (self, expression) => {
    const expressionType = expression.constructor;

    try {
      expression = transforms[0](expression);
      for (const transform of transforms.slice(1)) expression = transform(expression);
    } catch (unsupportedError) {
      if (!(unsupportedError instanceof UnsupportedError)) throw unsupportedError;
      self.unsupported(String(unsupportedError.message ?? unsupportedError));
    }

    if (generator) return generator(self, expression);

    const handlerName = `${expression.key}_sql`;
    const sqlHandler = typeof self[handlerName] === "function" ? self[handlerName] : null;
    if (sqlHandler) return sqlHandler.call(self, expression);

    const transformsHandler = self.constructor.TRANSFORMS.get(expression.constructor);
    if (transformsHandler) {
      if (expressionType === expression.constructor) {
        if (expression instanceof exp.Func) return self.function_fallback_sql(expression);

        // Ensures we don't enter an infinite loop. This can happen when the original
        // expression has the same type as the final expression and there's no `_sql`
        // method available for it, because then it'd re-enter this function.
        throw new Error(
          `Expr type ${expression.constructor.name} requires a _sql method in order to be transformed.`,
        );
      }

      return transformsHandler(self, expression);
    }

    throw new Error(`Unsupported expression type ${expression.constructor.name}.`);
  };
}

/**
 * py: sqlglot/transforms.py:144 `eliminate_distinct_on(expression)`
 *
 * Convert SELECT DISTINCT ON statements to a subquery with a window function.
 *
 * This is useful for dialects that don't support SELECT DISTINCT ON but support window
 * functions.
 *
 * @param {exp.Expr} expression
 * @returns {exp.Expr}
 */
export function eliminate_distinct_on(expression) {
  if (
    expression instanceof exp.Select &&
    expression.args.distinct &&
    expression.args.distinct.args.on instanceof exp.Tuple
  ) {
    const rowNumberWindowAlias = findNewName(expression.namedSelects, "_row_number");

    const distinctCols = expression.args.distinct.pop().args.on.expressions;
    const window = new exp.Window({ this: new exp.RowNumber({}), partition_by: distinctCols });

    const order = expression.args.order;
    if (order) {
      window.set("order", order.pop());
    } else {
      window.set("order", new exp.Order({ expressions: distinctCols.map((c) => c.copy()) }));
    }

    expression.select(exp.alias_(window, rowNumberWindowAlias), { copy: false });

    // We add aliases to the projections so that we can safely reference them in the
    // outer query.
    let newSelects = [];
    const takenNames = new Set([rowNumberWindowAlias]);
    for (let select of expression.selects.slice(0, -1)) {
      if (select.isStar) {
        newSelects = [new exp.Star({})];
        break;
      }

      if (!(select instanceof exp.Alias)) {
        const alias = findNewName(takenNames, select.outputName || "_col");
        const quoted = select instanceof exp.Column ? select.this.args.quoted : null;
        select = select.replace(exp.alias_(select, alias, { quoted }));
      }

      takenNames.add(select.outputName);
      newSelects.push(select.args.alias);
    }

    return exp
      .select(...newSelects, { copy: false })
      .from_(expression.subquery("_t", { copy: false }), { copy: false })
      .where(exp.column(rowNumberWindowAlias).eq(1), { copy: false });
  }

  return expression;
}

/**
 * py: sqlglot/transforms.py:201 `eliminate_qualify(expression)`
 *
 * Convert SELECT statements that contain the QUALIFY clause into subqueries, filtered
 * equivalently.
 *
 * The idea behind this transformation can be seen in Snowflake's documentation for
 * QUALIFY: https://docs.snowflake.com/en/sql-reference/constructs/qualify
 *
 * Some dialects don't support window functions in the WHERE clause, so we need to
 * include them as projections in the subquery, in order to refer to them in the outer
 * filter using aliases. Also, if a column is referenced in the QUALIFY clause but is
 * not selected, we need to include it too, otherwise we won't be able to refer to it
 * in the outer query's WHERE clause. Finally, if a newly aliased projection is
 * referenced in the QUALIFY clause, it will be replaced by the corresponding
 * expression to avoid creating invalid column references.
 *
 * @param {exp.Expr} expression
 * @returns {exp.Expr}
 */
export function eliminate_qualify(expression) {
  if (expression instanceof exp.Select && expression.args.qualify) {
    const taken = new Set(expression.namedSelects);
    for (const select of expression.selects) {
      if (!select.aliasOrName) {
        const alias = findNewName(taken, "_c");
        select.replace(exp.alias_(select, alias));
        taken.add(alias);
      }
    }

    const selectAliasOrName = (select) => {
      const aliasOrName = select.aliasOrName;
      const identifier = select.args.alias || select.this;
      if (identifier instanceof exp.Identifier) {
        return exp.column(aliasOrName, null, null, null, { quoted: identifier.args.quoted });
      }
      return aliasOrName;
    };

    const outerSelects = exp.select(...expression.selects.map(selectAliasOrName));
    let qualifyFilters = expression.args.qualify.pop().this;
    const expressionByAlias = new Map(
      expression.selects
        .filter((select) => select instanceof exp.Alias)
        .map((select) => [select.alias, select.this]),
    );

    const selectCandidates = expression.isStar ? [exp.Window] : [exp.Window, exp.Column];
    for (const selectCandidate of [...qualifyFilters.findAll(...selectCandidates)]) {
      if (selectCandidate instanceof exp.Window) {
        if (expressionByAlias.size) {
          for (const column of selectCandidate.findAll(exp.Column)) {
            const expr = expressionByAlias.get(column.name);
            if (expr) column.replace(expr);
          }
        }

        const alias = findNewName(expression.namedSelects, "_w");
        expression.select(exp.alias_(selectCandidate, alias), { copy: false });
        const column = exp.column(alias);

        if (selectCandidate.parent instanceof exp.Qualify) {
          qualifyFilters = column;
        } else {
          selectCandidate.replace(column);
        }
      } else if (!expression.namedSelects.includes(selectCandidate.name)) {
        expression.select(selectCandidate.copy(), { copy: false });
      }
    }

    return outerSelects
      .from_(expression.subquery("_t", { copy: false }), { copy: false })
      .where(qualifyFilters, { copy: false });
  }

  return expression;
}

/**
 * py: sqlglot/transforms.py:615 `eliminate_semi_and_anti_joins(expression)`
 *
 * Convert SEMI and ANTI joins into equivalent forms that use EXISTS instead.
 *
 * @param {exp.Expr} expression
 * @returns {exp.Expr}
 */
export function eliminate_semi_and_anti_joins(expression) {
  if (expression instanceof exp.Select) {
    for (const join of [...(expression.args.joins || [])]) {
      const on = join.args.on;
      if (on && (join.kind === "SEMI" || join.kind === "ANTI")) {
        const subquery = exp.select("1").from_(join.this).where(on);
        let exists = new exp.Exists({ this: subquery });
        if (join.kind === "ANTI") exists = exists.not_(false);

        join.pop();
        expression.where(exists, { copy: false });
      }
    }
  }

  return expression;
}
