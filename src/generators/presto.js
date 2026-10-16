// py: sqlglot/generators/presto.py @ 91119bc — `class PrestoGenerator(generator.Generator)`,
// AIR-2287 (epic AIR-2272, "12.2 Presto family"). Third and last link of the Presto
// port landing in this round (parser: `src/parsers/presto.js`; dialect settings:
// `src/dialects/presto.js`), the same "full stack in one round" shape R38 (Redshift)
// used — `trino`/`athena`/`dune` extend THIS file in later rounds.
//
// ONE DELIBERATE GAP: `TRANSFORMS[exp.Select]` OMITS `explode_projection_to_unnest`
// -------------------------------------------------------------------------
// Upstream's own chain is `[eliminate_window_clause, eliminate_qualify,
// eliminate_distinct_on, explode_projection_to_unnest(1), eliminate_semi_and_anti_joins,
// amend_exploded_column_table]`. `transforms.explode_projection_to_unnest` (py:402,
// ~150 lines, needs the real `optimizer/scope.py` `Scope` class's `.references`) is
// NOT YET in this port's `src/transforms.js` — a concurrent session (AIR-2300, PR #119
// as of this writing, open but unmerged) is landing it right now for BigQuery/
// Snowflake's own equivalent gaps. Porting it a second time here would duplicate that
// work, so this file's `exp.Select` entry keeps every OTHER step real and the comment
// at that exact line documents the omission, the same "state the gap, do not invent
// it" precedent R42 used for BigQuery's identical wait on the same function. Whoever
// lands #119 next should wire this file's own commented-out step in, not re-port it.
//
// SHARED HELPERS ALREADY AVAILABLE
// -------------------------------------------------------------------------
// `dialects/dialect.js` already carries every cross-dialect helper this file imports
// except `encode_decode_sql` (py:1810, added alongside this file — a plain, self-
// contained `self.func(name, this, replace ? expr.args.replace : null)`, no further
// dependency). `transforms.js` already carries every helper this file imports except
// `add_recursive_cte_column_names` (py:584) and `epoch_cast_to_ts` (py:603), both added
// alongside this file for the same reason — self-contained, no unported dependency,
// and both genuinely new (neither is #119's own `explode_projection_to_unnest`).
// `optimizer/scope.js`'s `findAllInScope` (Tier A, already real) covers this file's
// one `find_all_in_scope` call (`amend_exploded_column_table`). `optimizer/
// annotate_types.js`'s `annotate_types` has been real since R54 (AIR-2281's own
// precedent for `generators/postgres.js`/`snowflake.js`), so every `jsonformat_sql`/
// `md5_sql`/`sha2_sql`/`struct_sql` call below uses the real function, not a stub.

import * as exp from "../expressions/index.js";
import { Generator, unsupported_args, AFTER_HAVING_MODIFIER_TRANSFORMS as BASE_AFTER_HAVING_MODIFIER_TRANSFORMS } from "../generator.js";
import * as transforms from "../transforms.js";
import {
  bool_xor_sql,
  bracket_to_element_at_sql,
  datestrtodate_sql,
  encode_decode_sql,
  if_sql,
  left_to_substring_sql,
  no_ilike_sql,
  no_pivot_sql,
  no_timestamp_sql,
  regexp_extract_sql,
  rename_func,
  right_to_substring_sql,
  strposition_sql,
  struct_extract_sql,
  timestamptrunc_sql,
  timestrtotime_sql,
  ts_or_ds_add_cast,
  unit_to_str,
  week_unit_to_dow,
  sequence_sql,
  explode_to_unnest_sql,
} from "../dialects/dialect.js";
import { Hive } from "../dialects/hive.js";
import { findAllInScope } from "../optimizer/scope.js";
import { annotate_types } from "../optimizer/annotate_types.js";
import { pyLower, pyUpper } from "../_py/str.js";

/** py: sqlglot/generators/presto.py:37 */
function _sha2_digest_sql(self, expression) {
  const length = expression.text("length") || "256";
  if (!["256", "512"].includes(length)) {
    self.unsupported(`SHA${length} is not supported in Presto`);
  }

  let this_ = expression.this;
  if (this_.isType(...exp.DataType.TEXT_TYPES)) {
    // the native digest takes VARBINARY, so a text-typed argument needs encoding
    this_ = new exp.Encode({ this: this_, charset: exp.Literal.string("utf-8") });
  }

  return self.func(`SHA${length}`, this_);
}

/** py: sqlglot/generators/presto.py:50 */
function _initcap_sql(self, expression) {
  const delimiters = expression.expression;
  if (
    delimiters &&
    !(delimiters.is_string && delimiters.this === self.dialect.INITCAP_DEFAULT_DELIMITER_CHARS)
  ) {
    self.unsupported("INITCAP does not support custom delimiters");
  }

  const regex = "(\\w)(\\w*)";
  return `REGEXP_REPLACE(${self.sql(expression, "this")}, '${regex}', x -> UPPER(x[1]) || LOWER(x[2]))`;
}

/** py: sqlglot/generators/presto.py:61 */
function _no_sort_array(self, expression) {
  let comparator = null;
  if (expression.args.asc?.equals?.(exp.false_())) {
    comparator = "(a, b) -> CASE WHEN a < b THEN 1 WHEN a > b THEN -1 ELSE 0 END";
  }
  return self.func("ARRAY_SORT", expression.this, comparator);
}

/** py: sqlglot/generators/presto.py:69 */
function _schema_sql(self, expression) {
  if (expression.parent instanceof exp.PartitionedByProperty) {
    // Any columns in the ARRAY[] string literals should not be quoted
    expression.transform((n) => (n instanceof exp.Identifier ? n.name : n), { copy: false });

    const partition_exprs = expression.expressions.map((c) =>
      c instanceof exp.Func || c instanceof exp.Property ? self.sql(c) : self.sql(c, "this"),
    );
    return self.sql(
      new exp.Array({ expressions: partition_exprs.map((c) => exp.Literal.string(c)) }),
    );
  }

  if (expression.parent) {
    for (const schema of expression.parent.findAll(exp.Schema)) {
      if (schema === expression) continue;

      const column_defs = [...schema.findAll(exp.ColumnDef)];
      if (column_defs.length && schema.parent instanceof exp.Property) {
        expression.expressions.push(...column_defs);
      }
    }
  }

  return self.schema_sql(expression);
}

/** py: sqlglot/generators/presto.py:92 */
function _quantile_sql(self, expression) {
  self.unsupported("Presto does not support exact quantiles");
  return self.func("APPROX_PERCENTILE", expression.this, expression.args.quantile);
}

/** py: sqlglot/generators/presto.py:97 */
function _str_to_time_sql(self, expression) {
  return self.func("DATE_PARSE", expression.this, self.format_time(expression));
}

/** py: sqlglot/generators/presto.py:103 */
function _ts_or_ds_to_date_sql(self, expression) {
  const time_format = self.format_time(expression);
  const dialect_class = self.dialect.constructor;
  if (
    time_format &&
    ![dialect_class.TIME_FORMAT, dialect_class.DATE_FORMAT].includes(time_format)
  ) {
    return self.sql(exp.cast(_str_to_time_sql(self, expression), exp.DType.DATE));
  }
  return self.sql(
    exp.cast(exp.cast(expression.this, exp.DType.TIMESTAMP), exp.DType.DATE),
  );
}

/** py: sqlglot/generators/presto.py:111 */
function _ts_or_ds_add_sql(self, expression) {
  expression = ts_or_ds_add_cast(expression);
  const unit = unit_to_str(expression);
  return self.func("DATE_ADD", unit, expression.expression, expression.this);
}

/** py: sqlglot/generators/presto.py:117 */
function _ts_or_ds_diff_sql(self, expression) {
  const this_ = exp.cast(expression.this, exp.DType.TIMESTAMP);
  const expr = exp.cast(expression.expression, exp.DType.TIMESTAMP);
  const unit = unit_to_str(expression);
  return self.func("DATE_DIFF", unit, expr, this_);
}

/**
 * py: sqlglot/generators/presto.py:124
 *
 * Trino doesn't support FIRST / LAST as functions, but they're valid in the context
 * of MATCH_RECOGNIZE, so we need to preserve them in that case. In all other cases
 * they're converted into an ARBITRARY call.
 *
 * Reference: https://trino.io/docs/current/sql/match-recognize.html#logical-navigation-functions
 */
function _first_last_sql(self, expression) {
  if (expression.findAncestor(exp.MatchRecognize, exp.Select) instanceof exp.MatchRecognize) {
    return self.function_fallback_sql(expression);
  }

  return rename_func("ARBITRARY")(self, expression);
}

/** py: sqlglot/generators/presto.py:138 */
function _unix_to_time_sql(self, expression) {
  const scale = expression.args.scale;
  const timestamp = self.sql(expression, "this");
  if (scale === null || scale === undefined || scale.equals(exp.UnixToTime.SECONDS)) {
    return rename_func("FROM_UNIXTIME")(self, expression);
  }

  // deny:implicit_str sqlglot/generators/presto.py:144 — upstream's f-string embeds
  // `scale` (an Expr) directly, which calls `Expression.__str__` (= `self.sql()`).
  // `self.sql(scale)` is the explicit equivalent here, not a naive `${scale}`
  // template-literal interpolation, which would call `Expr.prototype.toString()` (=
  // the port's `_to_s`/repr helper, a different upstream dunder) and render the
  // wrong text.
  return `FROM_UNIXTIME(CAST(${timestamp} AS DOUBLE) / POW(10, ${self.sql(scale)}))`;
}

/** py: sqlglot/generators/presto.py:147 */
function _to_int(self, expression) {
  if (!expression.type) {
    annotate_types(expression, { dialect: self.dialect });
  }
  if (expression.type && !exp.DataType.INTEGER_TYPES.has(expression.type.this)) {
    return exp.cast(expression, exp.DType.BIGINT);
  }
  return expression;
}

/** py: sqlglot/generators/presto.py:157 */
function _date_delta_sql(name, negate_interval = false) {
  return function _delta_sql(self, expression) {
    const interval = _to_int(self, expression.expression);
    // deny:operators sqlglot/generators/presto.py:165 — Python `interval * (-1)` on
    // an Expr (`__mul__`) builds `exp.Mul`; constructing it directly is this port's
    // equivalent.
    return self.func(
      name,
      unit_to_str(expression),
      negate_interval ? new exp.Mul({ this: interval, expression: exp.Literal.number(-1) }) : interval,
      expression.this,
    );
  };
}

/** py: sqlglot/generators/presto.py:172 */
function _date_diff_sql(self, expression) {
  // Presto/Trino only expose date_diff(unit, ts1, ts2); it returns ts2 - ts1, so the
  // operands are emitted as (expression, this) to preserve `this - expression` semantics.
  let this_ = expression.this;
  let expr = expression.expression;
  let unit = unit_to_str(expression);

  // DATE_DIFF counts complete units between its operands, whereas dialects that set
  // date_part_boundary count unit boundary crossings, so the operands are truncated
  // down to the unit to make the two coincide
  if (unit && expression.args.date_part_boundary) {
    const raw_unit = expression.args.unit;
    const dow = week_unit_to_dow(raw_unit);

    if (dow !== null) {
      unit = exp.Literal.string("WEEK");

      // DATE_TRUNC('WEEK', ...) is Monday-based; shifting both operands by the same
      // delta realigns it to the requested week start without changing the diff
      const shift_days = dow === 7 ? 1 : 1 - dow;
      if (shift_days) {
        const delta = new exp.Interval({
          this: exp.Literal.string(String(shift_days)),
          unit: exp.var("DAY"),
        });
        this_ = new exp.Add({ this: this_, expression: delta });
        expr = new exp.Add({ this: expr, expression: delta.copy() });
      }
    }

    if (!(raw_unit instanceof exp.WeekStart) || dow !== null) {
      this_ = new exp.DateTrunc({ unit: unit.copy(), this: this_ });
      expr = new exp.DateTrunc({ unit: unit.copy(), this: expr });
    }
  }

  return self.func("DATE_DIFF", unit, expr, this_);
}

/** py: sqlglot/generators/presto.py:206 */
function _explode_to_unnest_sql(self, expression) {
  const explode = expression.this;
  if (explode instanceof exp.Explode) {
    const exploded_type = explode.this.type;
    const alias = expression.args.alias;

    // This attempts a best-effort transpilation of LATERAL VIEW EXPLODE on a struct array
    if (
      alias instanceof exp.TableAlias &&
      exploded_type instanceof exp.DataType &&
      exploded_type.isType(exp.DType.ARRAY) &&
      exploded_type.expressions.length &&
      exploded_type.expressions[0].isType(exp.DType.STRUCT)
    ) {
      // When unnesting a ROW in Presto, it produces N columns, so we need to fix the alias
      alias.set(
        "columns",
        exploded_type.expressions[0].expressions.map((c) => c.this.copy()),
      );
    }
  } else if (explode instanceof exp.Inline) {
    explode.replace(new exp.Explode({ this: explode.this.copy() }));
  }

  return explode_to_unnest_sql(self, expression);
}

/**
 * py: sqlglot/generators/presto.py:228
 *
 * Exported (upstream's own public name, imported by `generators/trino.py` as
 * `from sqlglot.generators.presto import PrestoGenerator, amend_exploded_column_table`)
 * so `src/generators/trino.js` (PORT_PLAN.md R10x) can reuse it the same way.
 */
export function amend_exploded_column_table(expression) {
  // We check for expression.type because the columns can be amended only if types were inferred
  if (expression instanceof exp.Select && expression.type) {
    for (const lateral of expression.args.laterals || []) {
      const alias = lateral.args.alias;
      if (
        !(lateral.this instanceof exp.Explode) ||
        !(alias instanceof exp.TableAlias) ||
        alias.columns.length !== 1
      ) {
        continue;
      }

      const new_table = alias.this;
      const old_table = pyLower(alias.columns[0].name);

      // When transpiling a LATERAL VIEW EXPLODE Spark query, the exploded fields may be qualified
      // with the struct column, resulting in invalid Presto references that need to be amended
      for (const column of findAllInScope(expression, exp.Column)) {
        if (pyLower(column.db) === old_table) {
          column.set("table", column.args.db.pop());
        } else if (pyLower(column.table) === old_table) {
          column.set("table", new_table.copy());
        } else if (pyLower(column.name) === old_table && column.parent instanceof exp.Dot) {
          column.parent.replace(exp.column(column.parent.expression, new_table));
        }
      }
    }
  }

  return expression;
}

/** py: sqlglot/generators/presto.py:256 `class PrestoGenerator(generator.Generator)`. */
export class PrestoGenerator extends Generator {
  static SELECT_KINDS = [];
  static SUPPORTS_DECODE_CASE = false;

  /**
   * py:260 `AFTER_HAVING_MODIFIER_TRANSFORMS = generator.AFTER_HAVING_MODIFIER_TRANSFORMS`
   * — the MODULE-level 2-entry dict (`windows`, `qualify`), not the base `Generator`
   * CLASS attribute (which is a superset adding `cluster`/`distribute`/`sort`); see
   * `generators/exasol.js`'s own copy of this note (AIR-2310) and PORT_PLAN.md.
   */
  static AFTER_HAVING_MODIFIER_TRANSFORMS = BASE_AFTER_HAVING_MODIFIER_TRANSFORMS;

  static INTERVAL_ALLOWS_PLURAL_FORM = false;
  static JOIN_HINTS = false;
  static TABLE_HINTS = false;
  static QUERY_HINTS = false;
  static IS_BOOL_ALLOWED = false;
  static TZ_TO_WITH_TIME_ZONE = true;
  static NVL2_SUPPORTED = false;
  static STRUCT_DELIMITER = ["(", ")"];
  static LIMIT_ONLY_LITERALS = true;
  static SUPPORTS_SINGLE_ARG_CONCAT = false;
  static LIKE_PROPERTY_INSIDE_SCHEMA = true;
  static MULTI_ARG_DISTINCT = false;
  static SUPPORTS_TO_NUMBER = false;
  static HEX_FUNC = "TO_HEX";
  /** py:276 `PARSE_JSON_NAME: str | None = "JSON_PARSE"`. */
  static PARSE_JSON_NAME = "JSON_PARSE";
  static PAD_FILL_PATTERN_IS_REQUIRED = true;
  static EXCEPT_INTERSECT_SUPPORT_ALL_CLAUSE = false;
  static SUPPORTS_MEDIAN = false;
  static ARRAY_SIZE_NAME = "CARDINALITY";

  static PROPERTIES_LOCATION = new Map([
    ...Generator.PROPERTIES_LOCATION,
    [exp.LocationProperty, exp.Properties.Location.UNSUPPORTED],
    [exp.VolatileProperty, exp.Properties.Location.UNSUPPORTED],
  ]);

  static TYPE_MAPPING = new Map([
    ...Generator.TYPE_MAPPING,
    [exp.DType.BINARY, "VARBINARY"],
    [exp.DType.BIT, "BOOLEAN"],
    [exp.DType.DATETIME, "TIMESTAMP"],
    [exp.DType.DATETIME64, "TIMESTAMP"],
    [exp.DType.FLOAT, "REAL"],
    [exp.DType.HLLSKETCH, "HYPERLOGLOG"],
    [exp.DType.INT, "INTEGER"],
    [exp.DType.STRUCT, "ROW"],
    [exp.DType.TEXT, "VARCHAR"],
    [exp.DType.TIMESTAMPTZ, "TIMESTAMP"],
    [exp.DType.TIMESTAMPNTZ, "TIMESTAMP"],
    [exp.DType.TIMETZ, "TIME"],
  ]);

  static TRANSFORMS = new Map([
    ...Generator.TRANSFORMS,
    [exp.AnyValue, rename_func("ARBITRARY")],
    [exp.ApproxQuantile, (self, e) => self.func(
      "APPROX_PERCENTILE", e.this, e.args.weight, e.args.quantile, e.args.accuracy,
    )],
    [exp.ArgMax, rename_func("MAX_BY")],
    [exp.ArgMin, rename_func("MIN_BY")],
    [exp.Array, transforms.preprocess(
      [transforms.inherit_struct_field_names],
      (self, e) => `ARRAY[${self.expressions(e, null, { flat: true })}]`,
    )],
    [exp.ArrayAny, rename_func("ANY_MATCH")],
    [exp.ArrayConcat, rename_func("CONCAT")],
    [exp.ArrayContains, rename_func("CONTAINS")],
    [exp.ArrayToString, rename_func("ARRAY_JOIN")],
    [exp.ArrayUniqueAgg, rename_func("SET_AGG")],
    [exp.ArraySlice, rename_func("SLICE")],
    [exp.AtTimeZone, rename_func("AT_TIMEZONE")],
    [exp.BitwiseAnd, (self, e) => self.func("BITWISE_AND", e.this, e.expression)],
    [exp.BitwiseLeftShift, rename_func("BITWISE_LEFT_SHIFT")],
    [exp.BitwiseNot, (self, e) => self.func("BITWISE_NOT", e.this)],
    [exp.BitwiseOr, (self, e) => self.func("BITWISE_OR", e.this, e.expression)],
    [exp.BitwiseRightShift, rename_func("BITWISE_RIGHT_SHIFT")],
    [exp.BitwiseXor, (self, e) => self.func("BITWISE_XOR", e.this, e.expression)],
    [exp.Cast, transforms.preprocess([transforms.epoch_cast_to_ts])],
    [exp.CurrentTime, () => "CURRENT_TIME"],
    [exp.CurrentTimestamp, () => "CURRENT_TIMESTAMP"],
    [exp.CurrentUser, () => "CURRENT_USER"],
    [exp.DateAdd, _date_delta_sql("DATE_ADD")],
    [exp.DateDiff, _date_diff_sql],
    [exp.DatetimeDiff, _date_diff_sql],
    [exp.TimestampDiff, _date_diff_sql],
    [exp.DateStrToDate, datestrtodate_sql],
    [exp.DateToDi, (self, e) => (
      `CAST(DATE_FORMAT(${self.sql(e, "this")}, ${self.dialect.constructor.DATEINT_FORMAT}) AS INT)`
    )],
    [exp.DateSub, _date_delta_sql("DATE_ADD", true)],
    [exp.DayOfWeek, (self, e) => `((${self.func("DAY_OF_WEEK", e.this)} % 7) + 1)`],
    [exp.DayOfWeekIso, rename_func("DAY_OF_WEEK")],
    [exp.Decode, (self, e) => encode_decode_sql(self, e, "FROM_UTF8")],
    [exp.DiToDate, (self, e) => (
      `CAST(DATE_PARSE(CAST(${self.sql(e, "this")} AS VARCHAR), ${self.dialect.constructor.DATEINT_FORMAT}) AS DATE)`
    )],
    [exp.Encode, (self, e) => encode_decode_sql(self, e, "TO_UTF8")],
    [exp.FileFormatProperty, (self, e) => `format=${self.sql(exp.Literal.string(e.name))}`],
    [exp.First, _first_last_sql],
    [exp.FromISO8601Date, rename_func("FROM_ISO8601_DATE")],
    [exp.FromISO8601Timestamp, rename_func("FROM_ISO8601_TIMESTAMP")],
    [exp.FromTimeZone, (self, e) => (
      `WITH_TIMEZONE(${self.sql(e, "this")}, ${self.sql(e, "zone")}) AT TIME ZONE 'UTC'`
    )],
    [exp.GenerateSeries, sequence_sql],
    [exp.GenerateDateArray, sequence_sql],
    [exp.If, if_sql()],
    [exp.ILike, no_ilike_sql],
    [exp.Initcap, _initcap_sql],
    [exp.Last, _first_last_sql],
    [exp.LastDay, (self, e) => self.func("LAST_DAY_OF_MONTH", e.this)],
    [exp.Lateral, _explode_to_unnest_sql],
    [exp.Left, left_to_substring_sql],
    [exp.Levenshtein, unsupported_args("ins_cost", "del_cost", "sub_cost", "max_dist")(
      rename_func("LEVENSHTEIN_DISTANCE"),
    )],
    [exp.LogicalAnd, rename_func("BOOL_AND")],
    [exp.LogicalOr, rename_func("BOOL_OR")],
    [exp.Pivot, no_pivot_sql],
    [exp.Quantile, _quantile_sql],
    [exp.RegexpExtract, regexp_extract_sql],
    [exp.RegexpExtractAll, regexp_extract_sql],
    [exp.Right, right_to_substring_sql],
    [exp.Schema, _schema_sql],
    [exp.SchemaCommentProperty, (self, e) => self.naked_property(e)],
    [exp.Select, transforms.preprocess([
      transforms.eliminate_window_clause,
      transforms.eliminate_qualify,
      transforms.eliminate_distinct_on,
      // py:386 `transforms.explode_projection_to_unnest(1)` — NOT YET in this port's
      // `src/transforms.js`. See this file's header: AIR-2300/#119 is landing it right
      // now for BigQuery/Snowflake's own equivalent gap; wire it in here once it lands
      // rather than porting it a second time.
      transforms.eliminate_semi_and_anti_joins,
      amend_exploded_column_table,
    ])],
    [exp.SortArray, _no_sort_array],
    [exp.SqlSecurityProperty, (self, e) => `SECURITY ${self.sql(e.this)}`],
    [exp.StrPosition, (self, e) => strposition_sql(self, e, { supports_occurrence: true })],
    [exp.StrToDate, (self, e) => `CAST(${_str_to_time_sql(self, e)} AS DATE)`],
    [exp.StrToMap, rename_func("SPLIT_TO_MAP")],
    [exp.StrToTime, _str_to_time_sql],
    [exp.StructExtract, struct_extract_sql],
    [exp.Table, transforms.preprocess([transforms.unnest_generate_series])],
    [exp.Timestamp, no_timestamp_sql],
    [exp.TimestampAdd, _date_delta_sql("DATE_ADD")],
    [exp.TimestampTrunc, timestamptrunc_sql()],
    [exp.TimeStrToDate, timestrtotime_sql],
    [exp.TimeStrToTime, timestrtotime_sql],
    [exp.TimeStrToUnix, (self, e) => self.func(
      "TO_UNIXTIME", self.func("DATE_PARSE", e.this, self.dialect.constructor.TIME_FORMAT),
    )],
    [exp.TimeToStr, (self, e) => self.func("DATE_FORMAT", e.this, self.format_time(e))],
    [exp.TimeToUnix, rename_func("TO_UNIXTIME")],
    [exp.ToChar, (self, e) => self.func("DATE_FORMAT", e.this, self.format_time(e))],
    [exp.TryCast, transforms.preprocess([transforms.epoch_cast_to_ts])],
    [exp.TsOrDiToDi, (self, e) => (
      `CAST(SUBSTR(REPLACE(CAST(${self.sql(e, "this")} AS VARCHAR), '-', ''), 1, 8) AS INT)`
    )],
    [exp.TsOrDsAdd, _ts_or_ds_add_sql],
    [exp.TsOrDsDiff, _ts_or_ds_diff_sql],
    [exp.TsOrDsToDate, _ts_or_ds_to_date_sql],
    [exp.Unhex, rename_func("FROM_HEX")],
    [exp.UnixToStr, (self, e) => (
      `DATE_FORMAT(FROM_UNIXTIME(${self.sql(e, "this")}), ${self.format_time(e)})`
    )],
    [exp.UnixToTime, _unix_to_time_sql],
    [exp.UnixToTimeStr, (self, e) => `CAST(FROM_UNIXTIME(${self.sql(e, "this")}) AS VARCHAR)`],
    [exp.VariancePop, rename_func("VAR_POP")],
    [exp.With, transforms.preprocess([transforms.add_recursive_cte_column_names])],
    [exp.WithinGroup, transforms.preprocess([transforms.remove_within_group_for_percentiles])],
    // Note: Presto's TRUNCATE always returns DOUBLE, even with decimals=0, whereas
    // most dialects return INT (SQLite also returns REAL, see sqlite.py). This creates
    // a bidirectional transpilation gap: Presto→Other may change float division to int
    // division, and vice versa. Modeling precisely would require exp.FloatTrunc or
    // similar, deemed overengineering for this subtle semantic difference.
    [exp.Trunc, rename_func("TRUNCATE")],
    [exp.Xor, bool_xor_sql],
    [exp.MD5Digest, rename_func("MD5")],
    [exp.SHA, rename_func("SHA1")],
    [exp.SHA1Digest, rename_func("SHA1")],
    [exp.SHA2Digest, _sha2_digest_sql],
    [exp.Substring, rename_func("SUBSTR")],
  ]);

  static RESERVED_KEYWORDS = new Set([
    "alter", "and", "as", "between", "by", "case", "cast", "constraint", "create",
    "cross", "current_time", "current_timestamp", "deallocate", "delete", "describe",
    "distinct", "drop", "else", "end", "escape", "except", "execute", "exists",
    "extract", "false", "for", "from", "full", "group", "having", "in", "inner",
    "insert", "intersect", "into", "is", "join", "left", "like", "natural", "not",
    "null", "on", "or", "order", "outer", "prepare", "right", "select", "table",
    "then", "true", "union", "using", "values", "when", "where", "with",
  ]);

  /** py:501 */
  extract_sql(expression) {
    const date_part = expression.name;

    if (!date_part.startsWith("EPOCH")) {
      return super.extract_sql(expression);
    }

    let scale;
    if (date_part === "EPOCH_MILLISECOND") scale = 10 ** 3;
    else if (date_part === "EPOCH_MICROSECOND") scale = 10 ** 6;
    else if (date_part === "EPOCH_NANOSECOND") scale = 10 ** 9;
    else scale = null;

    const value = expression.expression;

    const ts = exp.cast(value, exp.DType.TIMESTAMP);
    let to_unix = new exp.TimeToUnix({ this: ts });

    if (scale) {
      to_unix = new exp.Mul({ this: to_unix, expression: exp.Literal.number(scale) });
    }

    return this.sql(to_unix);
  }

  /** py:526 */
  jsonformat_sql(expression) {
    let this_ = expression.this;
    const is_json = expression.args.is_json;

    if (this_ && !(is_json || this_.type)) {
      this_ = annotate_types(this_, { dialect: this.dialect });
    }

    if (!(is_json || this_.isType(exp.DType.JSON))) {
      this_.replace(exp.cast(this_, exp.DType.JSON));
    }

    return this.function_fallback_sql(expression);
  }

  /** py:540 */
  md5_sql(expression) {
    let this_ = expression.this;

    if (!this_.type) {
      this_ = annotate_types(this_, { dialect: this.dialect });
    }

    if (this_.isType(...exp.DataType.TEXT_TYPES)) {
      this_ = new exp.Encode({ this: this_, charset: exp.Literal.string("utf-8") });
    }

    return this.func("LOWER", this.func("TO_HEX", this.func("MD5", this.sql(this_))));
  }

  /** py:553 */
  sha2_sql(expression) {
    const length = expression.text("length") || "256";
    if (!["256", "512"].includes(length)) {
      this.unsupported(`SHA${length} is not supported in Presto`);
    }

    let this_ = expression.this;

    if (this_.isType(...exp.DataType.TEXT_TYPES)) {
      this_ = new exp.Encode({ this: this_, charset: exp.Literal.string("utf-8") });
    }

    return this.func(
      "LOWER", this.func("TO_HEX", this.func(`SHA${length}`, this.sql(this_))),
    );
  }

  /**
   * py:565
   *
   * Since `TO_UNIXTIME` requires a `TIMESTAMP`, we need to parse the argument into one.
   * To do this, we first try to `DATE_PARSE` it, but since this can fail when there's a
   * timezone involved, we wrap it in a `TRY` call and use `PARSE_DATETIME` as a fallback,
   * which seems to be using the same time mapping as Hive, as per:
   * https://joda-time.sourceforge.net/apidocs/org/joda/time/format/DateTimeFormat.html
   */
  strtounix_sql(expression) {
    const this_ = expression.this;
    const value_as_text = exp.cast(this_, exp.DType.TEXT);
    const value_as_timestamp = this_.is_string ? exp.cast(this_, exp.DType.TIMESTAMP) : this_;

    const parse_without_tz = this.func("DATE_PARSE", value_as_text, this.format_time(expression));

    const formatted_value = this.func("DATE_FORMAT", value_as_timestamp, this.format_time(expression));
    const parse_with_tz = this.func(
      "PARSE_DATETIME",
      formatted_value,
      this.format_time(expression, Hive.INVERSE_TIME_MAPPING, Hive.INVERSE_TIME_TRIE),
    );
    const coalesced = this.func("COALESCE", this.func("TRY", parse_without_tz), parse_with_tz);
    return this.func("TO_UNIXTIME", coalesced);
  }

  /** py:586 */
  bracket_sql(expression) {
    if (expression.args.safe) {
      return bracket_to_element_at_sql(this, expression);
    }
    return super.bracket_sql(expression);
  }

  /** py:591 */
  struct_sql(expression) {
    if (!expression.type) {
      annotate_types(expression, { dialect: this.dialect });
    }

    const values = [];
    const schema = [];
    let unknown_type = false;

    for (const e of expression.expressions) {
      if (e instanceof exp.PropertyEQ) {
        if (e.type && e.type.isType(exp.DType.UNKNOWN)) {
          unknown_type = true;
        } else {
          schema.push(`${this.sql(e, "this")} ${this.sql(e.type)}`);
        }
        values.push(this.sql(e, "expression"));
      } else {
        values.push(this.sql(e));
      }
    }

    const size = expression.expressions.length;

    if (!size || schema.length !== size) {
      if (unknown_type) {
        this.unsupported("Cannot convert untyped key-value definitions (try annotate_types).");
      }
      return this.func("ROW", ...values);
    }
    return `CAST(ROW(${values.join(", ")}) AS ROW(${schema.join(", ")}))`;
  }

  /** py:621 */
  interval_sql(expression) {
    if (expression.this && pyUpper(expression.text("unit")).startsWith("WEEK")) {
      return `(${expression.this.name} * INTERVAL '7' DAY)`;
    }
    return super.interval_sql(expression);
  }

  /** py:626 */
  transaction_sql(expression) {
    let modes = expression.args.modes;
    modes = modes && modes.length ? ` ${modes.join(", ")}` : "";
    return `START TRANSACTION${modes}`;
  }

  /** py:631 */
  offset_limit_modifiers(expression, fetch, limit) {
    return [this.sql(expression, "offset"), this.sql(limit)];
  }

  /**
   * py:639
   *
   * Presto doesn't support CREATE VIEW with expressions (ex: `CREATE VIEW x (cola)` then `(cola)` is the expression),
   * so we need to remove them
   */
  create_sql(expression) {
    const kind = expression.args.kind;
    const schema = expression.this;
    if (kind === "VIEW" && schema.expressions.length) {
      expression.this.set("expressions", null);
    }
    return super.create_sql(expression);
  }

  /**
   * py:650
   *
   * Presto only supports DELETE FROM for a single table without an alias, so we need
   * to remove the unnecessary parts. If the original DELETE statement contains more
   * than one table to be deleted, we can't safely map it 1-1 to a Presto statement.
   */
  delete_sql(expression) {
    const tables = expression.args.tables || [expression.this];
    if (tables.length > 1) {
      return super.delete_sql(expression);
    }

    // deny:operators sqlglot/generators/presto.py:660 — plain JS array indexing into
    // a list of table expressions, not an Expr operator; same false-positive shape
    // as `lineage.py:627` (PORT_PLAN.md R88).
    const table = tables[0];
    expression.set("this", table);
    expression.set("tables", null);

    if (table instanceof exp.Table) {
      const table_alias = table.args.alias;
      if (table_alias) {
        table_alias.pop();
        expression = expression.transform(transforms.unqualify_columns);
      }
    }

    return super.delete_sql(expression);
  }

  /** py:672 */
  jsonextract_sql(expression) {
    const is_json_extract = this.dialect.settings.variant_extract_is_json_extract ?? true;

    // Generate JSON_EXTRACT unless the user has configured that a Snowflake / Databricks
    // VARIANT extract (e.g. col:x.y) should map to dot notation (i.e ROW access) in Presto/Trino
    if (!expression.args.variant_extract || is_json_extract) {
      return this.func(
        "JSON_EXTRACT", expression.this, expression.expression, ...expression.expressions,
      );
    }

    const this_ = this.sql(expression, "this");

    // Convert the JSONPath extraction `JSON_EXTRACT(col, '$.x.y) to a ROW access col.x.y
    const segments = [];
    for (const path_key of expression.expression.expressions.slice(1)) {
      if (!(path_key instanceof exp.JSONPathKey)) {
        // Cannot transpile subscripts, wildcards etc to dot notation
        this.unsupported(`Cannot transpile JSONPath segment '${path_key}' to ROW access`);
        continue;
      }
      let key = path_key.this;
      if (!exp.SAFE_IDENTIFIER_RE.test(key)) key = `"${key}"`;
      segments.push(`.${key}`);
    }

    const expr = segments.join("");

    return `${this_}${expr}`;
  }

  /** py:700 */
  groupconcat_sql(expression) {
    return this.func(
      "ARRAY_JOIN",
      this.func("ARRAY_AGG", expression.this),
      expression.args.separator,
    );
  }
}
