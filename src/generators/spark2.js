// py: sqlglot/generators/spark2.py — `class Spark2Generator(HiveGenerator)`.
//
// Second link in the four-link chain `Hive <- Spark2 <- Spark <- Databricks`
// (PORT_PLAN.md, Databricks-chain generator step). See `hive.js`'s own header for the
// shared context (the settings-side split, the base-`Generator` methods this chain
// needed for real for the first time, and the `transforms.js`/`dialects/dialect.js`
// growth this whole chain shares).
//
// TWO base `Generator` methods needed porting for real here, both reached only via
// `super(HiveGenerator, self).X(...)` — Python's EXPLICIT-parent syntax for skipping
// `HiveGenerator`'s own override and calling the grandparent directly, reproduced with
// `Generator.prototype.X.call(this, ...)` rather than `super.X(...)` (which would
// resolve to `HiveGenerator.prototype.X`, the wrong one): `altercolumn_sql` and
// `renamecolumn_sql`. `struct_sql` needed the same base-`Generator` method for real for
// a different reason — `Generator.struct_sql(self, expression)` in upstream is an
// EXPLICIT unbound-method call on the base class by name, not `super()` at all (there
// is no MRO ambiguity to resolve; it just wants the base behavior specifically),
// reproduced the same way.

import * as exp from "../expressions/index.js";
import { Generator } from "../generator.js";
import { bracket_to_element_at_sql, is_parse_json, rename_func, timestamptrunc_sql, weekstart_unit_to_str } from "../dialects/dialect.js";
import { HIVE_DATE_FORMAT, HIVE_TS_OR_DS_EXPRESSIONS, HiveGenerator } from "./hive.js";
import {
  any_to_exists,
  ctas_with_tmp_tables_to_create_tmp_view,
  eliminate_distinct_on,
  eliminate_qualify,
  move_schema_columns_to_partitioned_by,
  preprocess,
  remove_unique_constraints,
  remove_within_group_for_percentiles,
  unnest_to_explode,
  unqualify_pivot_fields,
} from "../transforms.js";

/** py:22 `_json_format_sql(self, expression: exp.JSONFormat)`. */
function _json_format_sql(self, expression) {
  const this_ = expression.this;

  if (is_parse_json(this_)) {
    if (this_.this.is_string) {
      // Since FROM_JSON requires a nested type, we always wrap the json string with
      // an array to ensure that "naked" strings like "'a'" will be handled correctly
      const wrapped_json = exp.Literal.string(`[${this_.this.name}]`);

      const from_json = self.func("FROM_JSON", wrapped_json, self.func("SCHEMA_OF_JSON", wrapped_json));
      const to_json = self.func("TO_JSON", from_json);

      // This strips the [, ] delimiters of the dummy array printed by TO_JSON
      return self.func("REGEXP_EXTRACT", to_json, "'^.(.*).$'", "1");
    }
    return self.sql(this_);
  }

  return self.func("TO_JSON", this_, expression.args.options);
}

/** py:43 `_map_sql(self, expression: exp.Map)`. */
function _map_sql(self, expression) {
  const keys = expression.args.keys;
  const values = expression.args.values;

  if (!keys || !values) return self.func("MAP");

  return self.func("MAP_FROM_ARRAYS", keys, values);
}

/** py:53 `_str_to_date(self, expression: exp.StrToDate)`. */
function _str_to_date(self, expression) {
  const time_format_ = self.format_time(expression);
  if (time_format_ === HIVE_DATE_FORMAT) return self.func("TO_DATE", expression.this);
  return self.func("TO_DATE", expression.this, time_format_);
}

/** py:60 `_unix_to_time_sql(self, expression: exp.UnixToTime)`. */
function _unix_to_time_sql(self, expression) {
  const scale = expression.args.scale;
  const timestamp = expression.this;

  if (scale == null) {
    return self.sql(exp.cast(exp.func("from_unixtime", timestamp), exp.DType.TIMESTAMP));
  }
  if (scale.equals(exp.UnixToTime.SECONDS)) return self.func("TIMESTAMP_SECONDS", timestamp);
  if (scale.equals(exp.UnixToTime.MILLIS)) return self.func("TIMESTAMP_MILLIS", timestamp);
  if (scale.equals(exp.UnixToTime.MICROS)) return self.func("TIMESTAMP_MICROS", timestamp);

  const unix_seconds = new exp.Div({ this: timestamp, expression: exp.func("POW", 10, scale) });
  return self.func("TIMESTAMP_SECONDS", unix_seconds);
}

/**
 * py:77 `_unalias_pivot(expression: exp.Expr)`.
 *
 * Spark doesn't allow PIVOT aliases, so we need to remove them and possibly wrap a
 * pivoted source in a subquery with the same alias to preserve the query's semantics.
 *
 * Example:
 *   `SELECT piv.x FROM tbl PIVOT (SUM(a) FOR b IN ('x')) piv` ->
 *   `SELECT piv.x FROM (SELECT * FROM tbl PIVOT(SUM(a) FOR b IN ('x'))) AS piv`
 */
function _unalias_pivot(expression) {
  if (expression instanceof exp.From && expression.this.args.pivots) {
    // deny:operators sqlglot/generators/spark2.py:89 — `expression.this.args["pivots"][0]`
    // (`__getitem__`) is a plain LIST index into `args["pivots"]`, a Python dict lookup
    // followed by list indexing — not `Expr.__getitem__` (bracket-access AST building);
    // `args.pivots[0]` is a faithful array index, not an operator overload site.
    const pivot = expression.this.args.pivots[0];
    if (pivot.alias) {
      const alias = pivot.args.alias.pop();
      return new exp.From({
        this: expression.this.replace(
          exp.select("*").from_(expression.this.copy(), { copy: false }).subquery(alias, { copy: false }),
        ),
      });
    }
  }

  return expression;
}

/** py:103 `temporary_storage_provider(expression: exp.Expr)` — spark2, spark, Databricks require a storage provider for temporary tables. */
export function temporary_storage_provider(expression) {
  const provider = new exp.FileFormatProperty({ this: exp.Literal.string("parquet") });
  expression.args.properties.append("expressions", provider);
  return expression;
}

/** py:110 `class Spark2Generator(HiveGenerator)`. */
export class Spark2Generator extends HiveGenerator {
  static QUERY_HINTS = true;
  static NVL2_SUPPORTED = true;
  static CAN_IMPLEMENT_ARRAY_ANY = true;
  static ALTER_SET_TYPE = "TYPE";
  static PARSE_JSON_NAME = null;

  static PROPERTIES_LOCATION = new Map([
    ...HiveGenerator.PROPERTIES_LOCATION,
    [exp.EngineProperty, exp.Properties.Location.UNSUPPORTED],
    [exp.AutoIncrementProperty, exp.Properties.Location.UNSUPPORTED],
    [exp.CharacterSetProperty, exp.Properties.Location.UNSUPPORTED],
    [exp.CollateProperty, exp.Properties.Location.UNSUPPORTED],
  ]);

  /** py:125 `TS_OR_DS_EXPRESSIONS: t.ClassVar = (*HIVE_TS_OR_DS_EXPRESSIONS, ...)`. */
  static TS_OR_DS_EXPRESSIONS = [...HIVE_TS_OR_DS_EXPRESSIONS, exp.DayOfMonth, exp.DayOfWeek, exp.DayOfYear, exp.WeekOfYear];

  /**
   * py:133 `TRANSFORMS = {k: v for k, v in {**HiveGenerator.TRANSFORMS, ...}.items() if v is not None}`.
   *
   * Built as a full merge, then `.delete()`d for the five keys upstream's dict
   * comprehension filters out via `exp.ArraySort: None` etc. — `_buildDispatch`
   * (generator.js) seeds strictly from `cls.TRANSFORMS` (this class's OWN static, which
   * JS field lookup already shadows `HiveGenerator.TRANSFORMS` with entirely, the same
   * way a Python class attribute reassignment does), so removing a key here is enough:
   * dispatch then falls through to method-name scanning across the MRO, and since
   * neither `HiveGenerator` nor `Spark2Generator` defines an `arraysort_sql`/`ilike_sql`/
   * `left_sql`/`monthsbetween_sql`/`right_sql` METHOD, those five fall all the way
   * through to base `Generator`'s own method (real, for `ilike_sql`) or the generic
   * `exp.Func` fallback (`function_fallback_sql`, for the other four) — which is exactly
   * the semantic upstream's removal encodes: Spark natively supports LEFT/RIGHT/
   * MONTHS_BETWEEN/ILIKE, so it drops Hive's rewrite and lets the plain function name
   * (or, for ILIKE, the base ILIKE-as-LIKE(LOWER(...)) rewrite) render instead.
   */
  static TRANSFORMS = (() => {
    const t = new Map([
      ...HiveGenerator.TRANSFORMS,
      [exp.ApproxDistinct, rename_func("APPROX_COUNT_DISTINCT")],
      [
        exp.ArraySum,
        (self, e) => `AGGREGATE(${self.sql(e, "this")}, 0, (acc, x) -> acc + x, acc -> acc)`,
      ],
      [exp.ArrayToString, rename_func("ARRAY_JOIN")],
      [exp.ArraySlice, rename_func("SLICE")],
      [exp.AtTimeZone, (self, e) => self.func("FROM_UTC_TIMESTAMP", e.this, e.args.zone)],
      [exp.BitwiseLeftShift, rename_func("SHIFTLEFT")],
      [exp.BitwiseRightShift, rename_func("SHIFTRIGHT")],
      [
        exp.Create,
        preprocess([
          remove_unique_constraints,
          (e) => ctas_with_tmp_tables_to_create_tmp_view(e, temporary_storage_provider),
          move_schema_columns_to_partitioned_by,
        ]),
      ],
      [exp.DateFromParts, rename_func("MAKE_DATE")],
      [exp.DateTrunc, (self, e) => self.func("TRUNC", e.this, weekstart_unit_to_str(self, e))],
      [exp.DayOfMonth, rename_func("DAYOFMONTH")],
      [exp.DayOfWeek, rename_func("DAYOFWEEK")],
      // (DAY_OF_WEEK(datetime) % 7) + 1 is equivalent to DAYOFWEEK_ISO(datetime)
      [exp.DayOfWeekIso, (self, e) => `((${self.func("DAYOFWEEK", e.this)} % 7) + 1)`],
      [exp.DayOfYear, rename_func("DAYOFYEAR")],
      [exp.Format, rename_func("FORMAT_STRING")],
      [exp.From, preprocess([_unalias_pivot])],
      [exp.FromTimeZone, (self, e) => self.func("TO_UTC_TIMESTAMP", e.this, e.args.zone)],
      [exp.JSONFormat, _json_format_sql],
      [exp.LogicalAnd, rename_func("BOOL_AND")],
      [exp.LogicalOr, rename_func("BOOL_OR")],
      [exp.Map, _map_sql],
      [exp.Pivot, preprocess([unqualify_pivot_fields])],
      [exp.Reduce, rename_func("AGGREGATE")],
      [
        exp.RegexpReplace,
        (self, e) => self.func("REGEXP_REPLACE", e.this, e.expression, e.args.replacement, e.args.position),
      ],
      [
        exp.Select,
        preprocess([eliminate_qualify, eliminate_distinct_on, unnest_to_explode, any_to_exists]),
      ],
      [
        exp.SHA2Digest,
        (self, e) => self.func("SHA2", e.this, e.args.length || exp.Literal.number(256)),
      ],
      [exp.StrToDate, _str_to_date],
      [exp.StrToTime, (self, e) => self.func("TO_TIMESTAMP", e.this, self.format_time(e))],
      [exp.TimestampTrunc, timestamptrunc_sql()],
      [exp.UnixToTime, _unix_to_time_sql],
      [exp.VariancePop, rename_func("VAR_POP")],
      [exp.WeekOfYear, rename_func("WEEKOFYEAR")],
      [exp.WithinGroup, preprocess([remove_within_group_for_percentiles])],
    ]);

    t.delete(exp.ArraySort);
    t.delete(exp.ILike);
    t.delete(exp.Left);
    t.delete(exp.MonthsBetween);
    t.delete(exp.Right);

    return t;
  })();

  static WRAP_DERIVED_VALUES = false;
  static CREATE_FUNCTION_RETURN_AS = false;

  /**
   * py:216 `struct_sql(self, expression)` — `from sqlglot.generator import Generator;
   * return Generator.struct_sql(self, expression)`. An EXPLICIT unbound-method call on
   * the base class BY NAME, not `super()` — there is no MRO ambiguity to resolve here,
   * it deliberately wants base `Generator`'s struct rendering rather than
   * `HiveGenerator`'s "Hive does not support named structs" rewrite.
   * @param {exp.Struct} expression
   * @returns {string}
   */
  struct_sql(expression) {
    return Generator.prototype.struct_sql.call(this, expression);
  }

  /**
   * py:221
   * @param {exp.Cast} expression
   * @param {string|null} [safe_prefix]
   * @returns {string}
   */
  cast_sql(expression, safe_prefix = null) {
    const arg = expression.this;
    const is_json_extract =
      (arg instanceof exp.JSONExtract || arg instanceof exp.JSONExtractScalar) && !arg.args.variant_extract;

    // We can't use a non-nested type (eg. STRING) as a schema
    if (expression.to.args.nested && (is_parse_json(arg) || is_json_extract)) {
      const schema = `'${this.sql(expression, "to")}'`;
      return this.func("FROM_JSON", is_json_extract ? arg : arg.this, schema);
    }

    if (is_parse_json(expression)) {
      return this.func("TO_JSON", arg);
    }

    return Generator.prototype.cast_sql.call(this, expression, safe_prefix);
  }

  /**
   * py:237
   * @param {exp.FileFormatProperty} expression
   * @returns {string}
   */
  fileformatproperty_sql(expression) {
    if (expression.args.hive_format) return super.fileformatproperty_sql(expression);

    return `USING ${expression.name.toUpperCase()}`;
  }

  /**
   * py:243. `super(HiveGenerator, self)` (Python's explicit-parent syntax) skips
   * `HiveGenerator.altercolumn_sql` and calls base `Generator.altercolumn_sql`
   * directly — reproduced with `Generator.prototype.altercolumn_sql.call(this, ...)`
   * rather than `super.altercolumn_sql(...)`, which would resolve to
   * `HiveGenerator.prototype.altercolumn_sql` (the wrong one) via the JS prototype
   * chain.
   * @param {exp.AlterColumn} expression
   * @returns {string}
   */
  altercolumn_sql(expression) {
    if (expression.args.exists) {
      this.unsupported("ALTER COLUMN IF EXISTS is not supported by this dialect");
    }

    const this_ = this.sql(expression, "this");
    const new_name = this.sql(expression, "rename_to") || this_;
    const comment = this.sql(expression, "comment");
    if (new_name === this_) {
      if (comment) return `ALTER COLUMN ${this_} COMMENT ${comment}`;
      return Generator.prototype.altercolumn_sql.call(this, expression);
    }
    return `RENAME COLUMN ${this_} TO ${new_name}`;
  }

  /**
   * py:256. Same `super(HiveGenerator, self)` grandparent-skip shape as
   * `altercolumn_sql` above.
   * @param {exp.RenameColumn} expression
   * @returns {string}
   */
  renamecolumn_sql(expression) {
    return Generator.prototype.renamecolumn_sql.call(this, expression);
  }

  /**
   * py:259
   * @param {exp.Bracket} expression
   * @returns {string}
   */
  bracket_sql(expression) {
    if (expression.args.safe === false) {
      return bracket_to_element_at_sql(this, expression);
    }

    return super.bracket_sql(expression);
  }
}
