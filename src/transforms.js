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
// This file deliberately ports only a subset of upstream's ~30 top-level functions
// (see tools/lint_deny.mjs's `isPortedSite`, which otherwise treats a hand-written file
// with no seeded `// py:` skeleton as fully ported and flags every deny-list site in
// the REST of transforms.py as an unacknowledged one):
// @ported-ranges sqlglot/transforms.py 19-71 72-128 144-200 201-264 278-294 555-567 570-579 615-631 131-141 297-399 732-738 741-1084
//
// The added ranges (Databricks-chain generator step, PORT_PLAN.md) cover
// `unnest_generate_series`, `unnest_to_explode`, `unqualify_columns`,
// `unqualify_pivot_fields`, `remove_unique_constraints`,
// `ctas_with_tmp_tables_to_create_tmp_view`, `move_schema_columns_to_partitioned_by`,
// `move_partitioned_by_to_schema_columns`, `any_to_exists`, and
// `inherit_struct_field_names` — every `transforms.py` function
// `generators/{hive,spark2,spark,databricks}.py` import, in upstream source order.
// `struct_kv_to_alias` (839) and `eliminate_join_marks` (853) stay unported — the
// range still ends at 1084 because `lint_deny.mjs`'s ranges gate deny-listed SITES,
// not "every function must exist"; an unported function has no site to flag.
//
// Redshift generator step (PORT_PLAN.md) added three more, in upstream source order:
// `unnest_generate_date_array_using_recursive_cte` (72, new range above),
// `unqualify_unnest` (278, new range above — its `find_all_in_scope` call is now real,
// via `optimizer/scope.js`'s Tier A `findAllInScope`, not a `NotPorted` stub), and
// `eliminate_window_clause` (1001, no new range needed — already inside 741-1084, whose
// own note above already covers "a function landing later just needs the range to
// already include its lines," which it did).

import { findNewName, seqGet } from "./helper.js";
import { UnsupportedError } from "./errors.js";
import * as exp from "./expressions/index.js";
import { findAllInScope } from "./optimizer/scope.js";

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
 * py: sqlglot/transforms.py:72 `unnest_generate_date_array_using_recursive_cte(expression)`
 *
 * Added for `generators/redshift.js`'s `TRANSFORMS[exp.Select]` (Redshift port).
 *
 * @param {exp.Expr} expression
 * @returns {exp.Expr}
 */
export function unnest_generate_date_array_using_recursive_cte(expression) {
  if (expression instanceof exp.Select) {
    let count = 0;
    const recursive_ctes = [];

    for (const unnest of [...expression.findAll(exp.Unnest)]) {
      if (
        !(unnest.parent instanceof exp.From || unnest.parent instanceof exp.Join)
        || unnest.expressions.length !== 1
        || !(unnest.expressions[0] instanceof exp.GenerateDateArray)
      ) {
        continue;
      }

      const generate_date_array = unnest.expressions[0];
      let start = generate_date_array.args.start;
      const end = generate_date_array.args.end;
      const step = generate_date_array.args.step;

      if (!start || !end || !(step instanceof exp.Interval)) continue;

      const alias = unnest.args.alias;
      const column_name = alias instanceof exp.TableAlias ? alias.columns[0] : "date_value";

      start = exp.cast(start, "date");
      const date_add = exp.func("date_add", column_name, exp.Literal.number(step.name), step.args.unit);
      const cast_date_add = exp.cast(date_add, "date");

      const cte_name = "_generated_dates" + (count ? `_${count}` : "");

      const base_query = exp.select(start.as_(column_name));
      const recursive_query = exp
        .select(cast_date_add)
        .from_(cte_name)
        // deny:operators sqlglot/transforms.py:110 — Python `<=` on an Expr
        // (`__le__`) builds `exp.LTE`; `.lte()` is this port's `_binop` equivalent.
        .where(cast_date_add.lte(exp.cast(end, "date")));
      const cte_query = base_query.union(recursive_query, { distinct: false });

      const generate_dates_query = exp.select(column_name).from_(cte_name);
      unnest.replace(generate_dates_query.subquery(cte_name));

      recursive_ctes.push(
        exp.alias_(new exp.CTE({ this: cte_query }), cte_name, { table: [column_name] }),
      );
      count += 1;
    }

    if (recursive_ctes.length) {
      const with_expression = expression.args.with_ || new exp.With({});
      with_expression.set("recursive", true);
      with_expression.set("expressions", [...recursive_ctes, ...(with_expression.expressions || [])]);
      expression.set("with_", with_expression);
    }
  }

  return expression;
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
 * py: sqlglot/transforms.py:278 `unqualify_unnest(expression)`
 *
 * Remove references to unnest table aliases, added by the optimizer's qualify_columns
 * step. Added for `generators/redshift.js`'s `TRANSFORMS[exp.Select]` (Redshift port).
 *
 * @param {exp.Expr} expression
 * @returns {exp.Expr}
 */
export function unqualify_unnest(expression) {
  if (expression instanceof exp.Select) {
    const unnest_aliases = new Set();
    for (const unnest of findAllInScope(expression, exp.Unnest)) {
      if (unnest.parent instanceof exp.From || unnest.parent instanceof exp.Join) {
        unnest_aliases.add(unnest.alias);
      }
    }

    if (unnest_aliases.size) {
      for (const column of [...expression.findAll(exp.Column)]) {
        const leftmost_part = column.parts[0];
        if (leftmost_part.argKey !== "this" && unnest_aliases.has(leftmost_part.this)) {
          leftmost_part.pop();
        }
      }
    }
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

// ---------------------------------------------------------------------------
// Added for the Databricks-chain generator step (PORT_PLAN.md): every
// `transforms.py` function `generators/{hive,spark2,spark,databricks}.py` import that
// this file did not already carry, ported in upstream source order.
// ---------------------------------------------------------------------------

/**
 * py: sqlglot/transforms.py:131 `unnest_generate_series(expression)`
 *
 * Unnests GENERATE_SERIES or SEQUENCE table references.
 *
 * @param {exp.Expr} expression
 * @returns {exp.Expr}
 */
export function unnest_generate_series(expression) {
  const this_ = expression.this;
  if (expression instanceof exp.Table && this_ instanceof exp.GenerateSeries) {
    const unnest = new exp.Unnest({ expressions: [this_] });
    if (expression.alias) {
      return exp.alias_(unnest, expression.alias, { table: [expression.alias], copy: false });
    }
    return unnest;
  }

  return expression;
}

/**
 * py: sqlglot/transforms.py:297 `unnest_to_explode(expression, unnest_using_arrays_zip=True)`
 *
 * Convert cross join unnest into lateral view explode.
 *
 * @param {exp.Expr} expression
 * @param {boolean} [unnest_using_arrays_zip]
 * @returns {exp.Expr}
 */
export function unnest_to_explode(expression, unnest_using_arrays_zip = true) {
  function _unnest_zip_exprs(u, unnest_exprs, has_multi_expr) {
    if (has_multi_expr) {
      if (!unnest_using_arrays_zip) {
        throw new UnsupportedError("Cannot transpile UNNEST with multiple input arrays");
      }

      // Use INLINE(ARRAYS_ZIP(...)) for multiple expressions
      const zip_exprs = [new exp.Anonymous({ this: "ARRAYS_ZIP", expressions: unnest_exprs })];
      u.set("expressions", zip_exprs);
      return zip_exprs;
    }
    return unnest_exprs;
  }

  function _udtf_type(u, has_multi_expr) {
    if (u.args.offset) return exp.Posexplode;
    return has_multi_expr ? exp.Inline : exp.Explode;
  }

  if (expression instanceof exp.Select) {
    const from_ = expression.args.from_;

    if (from_ && from_.this instanceof exp.Unnest) {
      const unnest = from_.this;
      const alias = unnest.args.alias;
      const exprs = unnest.expressions;
      const has_multi_expr = exprs.length > 1;
      const [this_] = _unnest_zip_exprs(unnest, exprs, has_multi_expr);

      const columns = alias ? alias.columns : [];
      const offset = unnest.args.offset;
      if (offset) {
        columns.unshift(offset instanceof exp.Identifier ? offset : exp.toIdentifier("pos"));
      }

      unnest.replace(
        new exp.Table({
          this: new (_udtf_type(unnest, has_multi_expr))({ this: this_ }),
          alias: alias ? new exp.TableAlias({ this: alias.this, columns }) : null,
        }),
      );
    }

    const joins = expression.args.joins || [];
    for (const join of [...joins]) {
      const join_expr = join.this;

      const is_lateral = join_expr instanceof exp.Lateral;

      const unnest = is_lateral ? join_expr.this : join_expr;

      if (unnest instanceof exp.Unnest) {
        const alias = is_lateral ? join_expr.args.alias : unnest.args.alias;

        if (alias == null) {
          throw new UnsupportedError(
            "CROSS JOIN UNNEST to LATERAL VIEW EXPLODE transformation requires an alias",
          );
        }

        let exprs = unnest.expressions;
        // The number of unnest.expressions will be changed by _unnest_zip_exprs, we
        // need to record it here
        const has_multi_expr = exprs.length > 1;
        exprs = _unnest_zip_exprs(unnest, exprs, has_multi_expr);

        const idx = joins.indexOf(join);
        if (idx !== -1) joins.splice(idx, 1);

        const alias_cols = alias.columns;

        // Handle UNNEST to LATERAL VIEW EXPLODE: Exception is raised when there are 0
        // or > 2 aliases. Spark LATERAL VIEW EXPLODE requires single alias for
        // array/struct and two for Map type column unlike unnest in trino/presto
        // which can take an arbitrary amount.
        if (!has_multi_expr && ![1, 2].includes(alias_cols.length)) {
          throw new UnsupportedError(
            "CROSS JOIN UNNEST to LATERAL VIEW EXPLODE transformation requires explicit column aliases",
          );
        }

        const offset = unnest.args.offset;
        if (offset) {
          alias_cols.unshift(offset instanceof exp.Identifier ? offset : exp.toIdentifier("pos"));
        }

        for (let i = 0; i < Math.min(exprs.length, alias_cols.length); i++) {
          expression.append(
            "laterals",
            new exp.Lateral({
              this: new (_udtf_type(unnest, has_multi_expr))({ this: exprs[i] }),
              view: true,
              alias: new exp.TableAlias({ this: alias.this, columns: alias_cols }),
            }),
          );
        }
      }
    }
  }

  return expression;
}

/**
 * py: sqlglot/transforms.py:555 `add_within_group_for_percentiles(expression)`
 *
 * Transforms percentiles by adding a WITHIN GROUP clause to them. Added for
 * `generators/postgres.js`'s `TRANSFORMS[exp.PercentileCont]`/`[exp.PercentileDisc]`
 * (PORT_PLAN.md P4) — the same gap `generators/snowflake.js`'s header comment already
 * named as blocking its own two equivalent entries.
 *
 * @param {exp.Expr} expression
 * @returns {exp.Expr}
 */
export function add_within_group_for_percentiles(expression) {
  if (
    PERCENTILES.some((cls) => expression instanceof cls) &&
    !(expression.parent instanceof exp.WithinGroup) &&
    expression.expression
  ) {
    const column = expression.this.pop();
    expression.set("this", expression.expression.pop());
    const order = new exp.Order({ expressions: [new exp.Ordered({ this: column })] });
    expression = new exp.WithinGroup({ this: expression, expression: order });
  }

  return expression;
}

/**
 * py: sqlglot/transforms.py:570 `remove_within_group_for_percentiles(expression)`
 *
 * Transforms percentiles by getting rid of their corresponding WITHIN GROUP clause.
 *
 * @param {exp.Expr} expression
 * @returns {exp.Expr}
 */
export function remove_within_group_for_percentiles(expression) {
  if (
    expression instanceof exp.WithinGroup &&
    PERCENTILES.some((cls) => expression.this instanceof cls) &&
    expression.expression instanceof exp.Order
  ) {
    const quantile = expression.this.this;
    const input_value = expression.find(exp.Ordered).this;
    return expression.replace(new exp.ApproxQuantile({ this: input_value, quantile }));
  }

  return expression;
}

/**
 * py: sqlglot/transforms.py:732 `unqualify_columns(expression)`
 *
 * @param {exp.Expr} expression
 * @returns {exp.Expr}
 */
export function unqualify_columns(expression) {
  for (const column of [...expression.findAll(exp.Column)]) {
    // We only wanna pop off the table, db, catalog args
    for (const part of column.parts.slice(0, -1)) part.pop();
  }

  return expression;
}

/**
 * py: sqlglot/transforms.py:741 `unqualify_pivot_fields(expression)`
 *
 * Some dialects only accept simple column names in a (UN)PIVOT's FOR clause and
 * IN-list (Oracle raises ORA-01748), even though the aggregate itself may stay
 * qualified.
 *
 * @param {exp.Expr} expression
 * @returns {exp.Expr}
 */
export function unqualify_pivot_fields(expression) {
  if (expression instanceof exp.Pivot) {
    expression.set("fields", expression.fields.map((field) => unqualify_columns(field)));
  }

  return expression;
}

/**
 * py: sqlglot/transforms.py:758 `remove_unique_constraints(expression)`
 *
 * @param {exp.Create} expression
 * @returns {exp.Expr}
 */
export function remove_unique_constraints(expression) {
  for (const constraint of [...expression.findAll(exp.UniqueColumnConstraint)]) {
    if (constraint.parent) constraint.parent.pop();
  }

  return expression;
}

/**
 * py: sqlglot/transforms.py:767
 * `ctas_with_tmp_tables_to_create_tmp_view(expression, tmp_storage_provider=lambda e: e)`
 *
 * @param {exp.Create} expression
 * @param {(e: exp.Expr) => exp.Expr} [tmp_storage_provider]
 * @returns {exp.Expr}
 */
export function ctas_with_tmp_tables_to_create_tmp_view(expression, tmp_storage_provider = (e) => e) {
  const properties = expression.args.properties;
  const temporary = (properties ? properties.expressions : []).some(
    (prop) => prop instanceof exp.TemporaryProperty,
  );

  // CTAS with temp tables map to CREATE TEMPORARY VIEW
  if (expression.kind === "TABLE" && temporary) {
    if (expression.expression) {
      return new exp.Create({
        kind: "TEMPORARY VIEW",
        this: expression.this,
        expression: expression.expression,
      });
    }
    return tmp_storage_provider(expression);
  }

  return expression;
}

/**
 * py: sqlglot/transforms.py:791 `move_schema_columns_to_partitioned_by(expression)`
 *
 * In Hive, the PARTITIONED BY property acts as an extension of a table's schema. When
 * the PARTITIONED BY value is an array of column names, they are transformed into a
 * schema. The corresponding columns are removed from the create statement.
 *
 * @param {exp.Create} expression
 * @returns {exp.Expr}
 */
export function move_schema_columns_to_partitioned_by(expression) {
  const schema = expression.this;
  const is_partitionable = ["TABLE", "VIEW"].includes(expression.kind);

  if (schema instanceof exp.Schema && is_partitionable) {
    const prop = expression.find(exp.PartitionedByProperty);
    if (prop && prop.this && !(prop.this instanceof exp.Schema)) {
      const columns = new Set(prop.this.expressions.map((v) => v.name.toUpperCase()));
      const schema_exprs = schema.expressions;
      const partitions = schema_exprs.filter((col) => columns.has(col.name.toUpperCase()));
      schema.set(
        "expressions",
        schema_exprs.filter((e) => !partitions.includes(e)),
      );
      prop.replace(new exp.PartitionedByProperty({ this: new exp.Schema({ expressions: partitions }) }));
      expression.set("this", schema);
    }
  }

  return expression;
}

/**
 * py: sqlglot/transforms.py:814 `move_partitioned_by_to_schema_columns(expression)`
 *
 * Spark 3 supports both "HIVEFORMAT" and "DATASOURCE" formats for CREATE TABLE.
 * Currently, SQLGlot uses the DATASOURCE format for Spark 3.
 *
 * @param {exp.Create} expression
 * @returns {exp.Expr}
 */
export function move_partitioned_by_to_schema_columns(expression) {
  const prop = expression.find(exp.PartitionedByProperty);
  if (
    prop &&
    prop.this &&
    prop.this instanceof exp.Schema &&
    prop.this.expressions.every((e) => e instanceof exp.ColumnDef && e.kind)
  ) {
    const prop_this = new exp.Tuple({
      expressions: prop.this.expressions.map((e) => exp.toIdentifier(e.this)),
    });
    const schema = expression.this;
    for (const e of prop.this.expressions) schema.append("expressions", e);
    prop.set("this", prop_this);
  }

  return expression;
}

/**
 * py: sqlglot/transforms.py:974 `any_to_exists(expression)`
 *
 * Transform ANY operator to Spark's EXISTS. Both ANY and EXISTS accept queries but
 * currently only array expressions are supported for this transformation.
 *
 * @param {exp.Expr} expression
 * @returns {exp.Expr}
 */
export function any_to_exists(expression) {
  if (expression instanceof exp.Select) {
    for (const any_expr of [...expression.findAll(exp.Any)]) {
      const this_ = any_expr.this;
      if (this_ instanceof exp.Query || any_expr.parent instanceof exp.Like || any_expr.parent instanceof exp.ILike) {
        continue;
      }

      const binop = any_expr.parent;
      if (binop instanceof exp.Binary) {
        const lambda_arg = exp.toIdentifier("x");
        any_expr.replace(lambda_arg);
        const lambda_expr = new exp.Lambda({ this: binop.copy(), expressions: [lambda_arg] });
        binop.replace(new exp.Exists({ this: this_.unnest(), expression: lambda_expr }));
      }
    }
  }

  return expression;
}

/**
 * py: sqlglot/expressions/aggregate.py:223 `PERCENTILES = (PercentileCont, PercentileDisc)`.
 * A different upstream file's module constant, needed only for
 * `remove_within_group_for_percentiles`'s `isinstance` checks above; scoped locally
 * rather than standing up the whole of `aggregate.py` for a 2-element tuple, same
 * precedent as `generators/snowflake.js`'s own local copy.
 */
const PERCENTILES = [exp.PercentileCont, exp.PercentileDisc];

/**
 * py: sqlglot/transforms.py:1001 `eliminate_window_clause(expression)`
 *
 * Eliminates the `WINDOW` query clause by inlining each named window. Added for
 * `generators/redshift.js`'s `TRANSFORMS[exp.Select]` (Redshift port) — already inside
 * this file's declared `741-1084` range (see the header note on why that range's own
 * "stays unported" callout for this function does not need updating: an unported
 * function has no site, but a now-ported one is simply covered by the same range).
 *
 * @param {exp.Expr} expression
 * @returns {exp.Expr}
 */
export function eliminate_window_clause(expression) {
  const windows = expression.args.windows;
  if (expression instanceof exp.Select && windows !== null && windows !== undefined) {
    expression.set("windows", null);

    const window_expression = new Map();

    const _inline_inherited_window = (window) => {
      const inherited_window = window_expression.get(window.alias.toLowerCase());
      if (!inherited_window) return;

      window.set("alias", null);
      for (const key of ["partition_by", "order", "spec"]) {
        const arg = inherited_window.args[key];
        if (arg !== null && arg !== undefined) window.set(key, arg.copy());
      }
    };

    for (const window of windows) {
      _inline_inherited_window(window);
      window_expression.set(window.name.toLowerCase(), window);
    }

    for (const window of findAllInScope(expression, exp.Window)) {
      _inline_inherited_window(window);
    }
  }

  return expression;
}

/**
 * py: sqlglot/transforms.py:1032 `inherit_struct_field_names(expression)`
 *
 * Inherit field names from the first struct in an array. This transformation makes
 * the field names explicit on all structs by adding PropertyEQ nodes, in order to
 * facilitate transpilation to other dialects.
 *
 * @param {exp.Expr} expression
 * @returns {exp.Expr}
 */
export function inherit_struct_field_names(expression) {
  const first_item = seqGet(expression.expressions, 0);
  if (
    expression instanceof exp.Array &&
    expression.args.struct_name_inheritance &&
    first_item instanceof exp.Struct &&
    first_item.expressions.every((fld) => fld instanceof exp.PropertyEQ)
  ) {
    const field_names = first_item.expressions.map((fld) => fld.this);

    // Apply field names to subsequent structs that don't have them
    for (const struct of expression.expressions.slice(1)) {
      if (!(struct instanceof exp.Struct) || struct.expressions.length !== field_names.length) continue;

      // Convert unnamed expressions to PropertyEQ with inherited names
      const new_expressions = [];
      struct.expressions.forEach((expr, i) => {
        if (!(expr instanceof exp.PropertyEQ)) {
          // Create PropertyEQ: field_name := value, preserving the type from the
          // inner expression
          const property_eq = new exp.PropertyEQ({ this: field_names[i].copy(), expression: expr });
          property_eq.type = expr.type;
          new_expressions.push(property_eq);
        } else {
          new_expressions.push(expr);
        }
      });

      struct.set("expressions", new_expressions);
    }
  }

  return expression;
}
