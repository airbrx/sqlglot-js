// py: sqlglot/generators/postgres.py — `class PostgresGenerator(generator.Generator)`.
//
// This is the last of Ben's corrected dialect priority (Databricks > Snowflake >
// DuckDB > Postgres, PORT_PLAN.md 2026-09-08) to get a real `Generator`: Snowflake
// (`generators/snowflake.js`), the Hive<-Spark2<-Spark<-Databricks chain, and a scoped
// DuckDB subset already landed. Unlike DuckDB (4,788 LOC, an outlier), this file is
// comparable in scale to Snowflake's 1,222-LOC generator and is ported whole, matching
// upstream's own module-level-helpers-then-class layout.
//
// `src/dialects/postgres.js` (settings + Tokenizer, already landed) declares
// `static Generator = PostgresGenerator` once this file exists, closing the two
// deliberate gaps its own header comment names.
//
// THREE BASE-`Generator`/`transforms.js` GAPS CLOSED ALONGSIDE THIS FILE (PORT_PLAN.md
// "Generator chain surfaces base-Generator gaps" precedent — this port reaches them,
// so they get finished here rather than staying `NotPorted` stubs with a new caller):
//   - `Generator.prototype.{when_sql,whens_sql,merge_sql}` — reached by
//     `TRANSFORMS[exp.Merge]` (`merge_without_target_sql` below).
//   - `Generator.prototype.unnest_sql` (the base fallback) — reached by this file's own
//     `unnest_sql` override for every UNNEST it does not special-case.
//   - `Generator.prototype.tochar_sql` — reached by `TRANSFORMS[exp.ToChar]`.
//   - `Generator.prototype._simplify_unless_literal`'s `isinstance(x, Literal)` guard
//     (only the guard — the `optimizer.simplify` branch it protects stays `NotPorted`,
//     same status as `sequence_sql`'s identical call in `dialects/dialect.js`) —
//     reached by this file's own `_date_add_sql`, which calls it unconditionally.
//   - `transforms.add_within_group_for_percentiles` — reached by
//     `TRANSFORMS[exp.PercentileCont]`/`[exp.PercentileDisc]`; this is the exact gap
//     `generators/snowflake.js`'s header comment already named as blocking its own two
//     equivalent (still-blocked) entries.
//   - `Dialect.prototype.normalize_identifier` — reached by `merge_without_target_sql`,
//     its first real caller (see the note on that method in `dialects/dialect.js`).
//
// TWO REMAINING GAPS, each a live `NotPorted` throw rather than an approximation,
// following this project's precedent of porting the function that CONTAINS a gap
// rather than declining to port it (`dialects/dialect.js`'s `sequence_sql` note is the
// precedent this quotes):
//   - `_round_sql` and this file's own `unnest_sql` both need
//     `sqlglot.optimizer.annotate_types.annotate_types` (P6+, unported) when an
//     expression's `.type` is not already set — which today it never is, so both
//     throw whenever that specific branch is reached. `generators/snowflake.js`'s
//     `trycast_sql`/`dot_sql` hit the identical wall and use the identical shape: throw
//     directly at the call site instead of importing `dialects/dialect.js`'s private
//     (and itself-`NotPorted`) `annotate_types` stub.
//   - `arraycontains_sql`, `columndef_sql`, `datatype_sql`, and everything else below
//     that does NOT mention `annotate_types` has no such gap and is fully real.

import * as exp from "../expressions/index.js";
import { PyValueError } from "../_py/errors.js";
import { NotPorted } from "../errors.js";
import { Generator, unsupported_args } from "../generator.js";
import * as transforms from "../transforms.js";
import {
  any_value_to_max_sql,
  array_append_sql,
  array_concat_sql,
  bool_xor_sql,
  count_if_to_sum,
  datestrtodate_sql,
  filter_array_using_unnest,
  generate_series_sql,
  getbit_sql,
  groupconcat_sql,
  inline_array_sql,
  json_extract_segments,
  json_path_key_only_name,
  max_or_greatest,
  merge_without_target_sql,
  min_or_least,
  no_last_day_sql,
  no_map_from_entries_sql,
  no_paren_current_date_sql,
  no_pivot_sql,
  no_trycast_sql,
  regexp_replace_global_modifier,
  rename_func,
  sha256_sql,
  sha2_digest_sql,
  strposition_sql,
  struct_extract_sql,
  timestamptrunc_sql,
  timestrtotime_sql,
  trim_sql,
  ts_or_ds_add_cast,
} from "../dialects/dialect.js";
import { ensureList, seqGet } from "../helper.js";

/** py: sqlglot/generators/postgres.py:45 */
const DATE_DIFF_FACTOR = new Map([
  ["MICROSECOND", " * 1000000"],
  ["MILLISECOND", " * 1000"],
  ["SECOND", ""],
  ["MINUTE", " / 60"],
  ["HOUR", " / 3600"],
  ["DAY", " / 86400"],
]);

/**
 * py: sqlglot/generators/postgres.py:55 `_date_add_sql(kind)`.
 *
 * Calls `self._simplify_unless_literal` UNCONDITIONALLY on the interval amount — see
 * the file header note on that method. When the amount is already a bare `Literal`
 * (the common case), that call is a no-op and this function runs to completion; it
 * only throws `NotPorted` when the amount needs real simplification.
 */
function _date_add_sql(kind) {
  return function _date_add(self, expression) {
    if (expression instanceof exp.TsOrDsAdd) {
      expression = ts_or_ds_add_cast(expression);
    }

    const this_ = self.sql(expression, "this");
    const unit = expression.args.unit;

    let e = self._simplify_unless_literal(expression.expression);
    if (e instanceof exp.Interval) {
      return `${this_} ${kind} ${self.sql(e)}`;
    } else if (e instanceof exp.Literal) {
      e.set("is_string", true);
    } else if (e.is_number) {
      e = exp.Literal.string(e.toPy());
    } else {
      const one = exp.Literal.number(1);
      // deny:operators sqlglot/generators/postgres.py:72 — Python `*` on an Expr
      // (`__mul__`) builds `exp.Mul`; `.mul()` is this port's `_binop` equivalent.
      const interval_times_value = new exp.Interval({ this: one, unit }).mul(e);
      return `${this_} ${kind} ${self.sql(interval_times_value)}`;
    }

    return `${this_} ${kind} ${self.sql(new exp.Interval({ this: e, unit }))}`;
  };
}

/** py: sqlglot/generators/postgres.py:80 `_day_month_year_sql(self, expression)` */
function _day_month_year_sql(self, expression) {
  let this_ = expression.this;
  const value = this_ instanceof exp.TsOrDsToDate ? this_.this : this_;

  const default_date = this_.args.default_date;
  if (value.isType(...exp.DataType.INTEGER_TYPES) && default_date) {
    // deny:operators sqlglot/generators/postgres.py:87 — Python `+` on an Expr
    // (`__add__`) builds `exp.Add`; `.add()` is this port's `_binop` equivalent.
    this_ = exp.cast(default_date, exp.DType.DATE).add(value);
  }

  return self.sql(new exp.Extract({ this: exp.var(expression.constructor.sqlName()), expression: this_ }));
}

/** py: sqlglot/generators/postgres.py:92 `_date_diff_sql(self, expression)` */
function _date_diff_sql(self, expression) {
  let unit = expression.text("unit").toUpperCase() || "DAY";

  // Dialects like MySQL count crossed day boundaries, which maps to DATE subtraction
  if (unit === "DAY" && expression.args.date_part_boundary) {
    const this_ = exp.cast(expression.this, exp.DType.DATE);
    const expr = exp.cast(expression.expression, exp.DType.DATE);
    // deny:operators sqlglot/generators/postgres.py:99 — Python `-` on an Expr
    // (`__sub__`) builds `exp.Sub`; `.sub()` is this port's `_binop` equivalent.
    return self.sql(exp.paren(this_.sub(expr)));
  }

  const factor = DATE_DIFF_FACTOR.get(unit);

  const end = `CAST(${self.sql(expression, "this")} AS TIMESTAMP)`;
  const start = `CAST(${self.sql(expression, "expression")} AS TIMESTAMP)`;

  if (factor !== undefined) {
    return `CAST(EXTRACT(epoch FROM ${end} - ${start})${factor} AS BIGINT)`;
  }

  const age = `AGE(${end}, ${start})`;

  if (unit === "WEEK") {
    unit = `EXTRACT(days FROM (${end} - ${start})) / 7`;
  } else if (unit === "MONTH") {
    unit = `EXTRACT(year FROM ${age}) * 12 + EXTRACT(month FROM ${age})`;
  } else if (unit === "QUARTER") {
    unit = `EXTRACT(year FROM ${age}) * 4 + EXTRACT(month FROM ${age}) / 3`;
  } else if (unit === "YEAR") {
    unit = `EXTRACT(year FROM ${age})`;
  } else {
    unit = age;
  }

  return `CAST(${unit} AS BIGINT)`;
}

/** py: sqlglot/generators/postgres.py:125 `_substring_sql(self, expression)` */
function _substring_sql(self, expression) {
  const this_ = self.sql(expression, "this");
  const start = self.sql(expression, "start");
  const length = self.sql(expression, "length");

  const from_part = start ? ` FROM ${start}` : "";
  const for_part = length ? ` FOR ${length}` : "";

  return `SUBSTRING(${this_}${from_part}${for_part})`;
}

/** py: sqlglot/generators/postgres.py:136 `_auto_increment_to_serial(expression)` */
function _auto_increment_to_serial(expression) {
  const auto = expression.find(exp.AutoIncrementColumnConstraint);

  if (auto) {
    const constraints = expression.args.constraints;
    const idx = constraints.findIndex((c) => c.equals(auto.parent));
    if (idx === -1) throw new PyValueError("list.remove(x): x not in list");
    constraints.splice(idx, 1);

    const kind = expression.args.kind;

    if (kind.this === exp.DType.INT) {
      kind.replace(exp.DType.SERIAL.intoExpr());
    } else if (kind.this === exp.DType.SMALLINT) {
      kind.replace(exp.DType.SMALLSERIAL.intoExpr());
    } else if (kind.this === exp.DType.BIGINT) {
      kind.replace(exp.DType.BIGSERIAL.intoExpr());
    }
  }

  return expression;
}

/** py: sqlglot/generators/postgres.py:153 `_serial_to_generated(expression)` */
function _serial_to_generated(expression) {
  if (!(expression instanceof exp.ColumnDef)) return expression;
  const kind = expression.kind;
  if (!kind) return expression;

  let data_type;
  if (kind.this === exp.DType.SERIAL) {
    data_type = exp.DType.INT.intoExpr();
  } else if (kind.this === exp.DType.SMALLSERIAL) {
    data_type = exp.DType.SMALLINT.intoExpr();
  } else if (kind.this === exp.DType.BIGSERIAL) {
    data_type = exp.DType.BIGINT.intoExpr();
  } else {
    data_type = null;
  }

  if (data_type) {
    expression.args.kind.replace(data_type);
    const constraints = expression.args.constraints;
    const generated = new exp.ColumnConstraint({
      kind: new exp.GeneratedAsIdentityColumnConstraint({ this: false }),
    });
    const notnull = new exp.ColumnConstraint({ kind: new exp.NotNullColumnConstraint() });

    if (!constraints.some((c) => c.equals(notnull))) constraints.unshift(notnull);
    if (!constraints.some((c) => c.equals(generated))) constraints.unshift(generated);
  }

  return expression;
}

/** py: sqlglot/generators/postgres.py:183 `_json_extract_sql(name, op)` */
function _json_extract_sql(name, op) {
  return function _generate(self, expression) {
    const path = expression.expression;
    // Single non-literal segment: render as infix, not JSON_EXTRACT_PATH[_TEXT] (jsonb-unsafe).
    if (
      !(path instanceof exp.JSONPath || path instanceof exp.Variadic)
      && !ensureList(expression.args.expressions).length
    ) {
      return self.binary(expression, op);
    }

    if (expression.args.only_json_types) {
      return json_extract_segments(name, { quoted_index: false, op })(self, expression);
    }
    return json_extract_segments(name)(self, expression);
  };
}

/** py: sqlglot/generators/postgres.py:201 `_unix_to_time_sql(self, expression)` */
function _unix_to_time_sql(self, expression) {
  const scale = expression.args.scale;
  const timestamp = expression.this;

  if (scale === null || scale === undefined || scale.equals(exp.UnixToTime.SECONDS)) {
    return self.func("TO_TIMESTAMP", timestamp, self.format_time(expression));
  }

  return self.func(
    "TO_TIMESTAMP",
    new exp.Div({ this: timestamp, expression: exp.func("POW", 10, scale) }),
    self.format_time(expression),
  );
}

/** py: sqlglot/generators/postgres.py:215 `_levenshtein_sql(self, expression)` */
function _levenshtein_sql(self, expression) {
  const name = expression.args.max_dist ? "LEVENSHTEIN_LESS_EQUAL" : "LEVENSHTEIN";
  return rename_func(name)(self, expression);
}

/**
 * py: sqlglot/generators/postgres.py:221 `_versioned_anyvalue_sql(self, expression)`.
 * https://www.postgresql.org/docs/16/functions-aggregate.html
 * https://www.postgresql.org/about/featurematrix/
 *
 * Python tuple `<` over `Dialect.version`, same local helper (no shared export exists
 * yet for this comparison) as `generators/spark.js`'s own `_versionLt`.
 */
function _versionLt(version, ...bound) {
  const n = Math.min(version.length, bound.length);
  for (let i = 0; i < n; i++) {
    const a = BigInt(version[i]);
    const b = BigInt(bound[i]);
    if (a !== b) return a < b;
  }
  return version.length < bound.length;
}

function _versioned_anyvalue_sql(self, expression) {
  if (_versionLt(self.dialect.version, 16n)) {
    return any_value_to_max_sql(self, expression);
  }

  return rename_func("ANY_VALUE")(self, expression);
}

/**
 * py: sqlglot/generators/postgres.py:230 `_round_sql(self, expression)`.
 *
 * See the file header note: throws `NotPorted` at the `annotate_types` call site
 * itself, the same shape `generators/snowflake.js`'s `trycast_sql`/`dot_sql` use for
 * the identical gap, rather than importing `dialects/dialect.js`'s private stub.
 */
function _round_sql(self, expression) {
  let this_ = self.sql(expression, "this");
  const decimals = self.sql(expression, "decimals");

  if (!decimals) return self.func("ROUND", this_);

  if (!expression.type) {
    throw new NotPorted("_round_sql (annotate_types)", "sqlglot/optimizer/annotate_types.py");
  }

  // ROUND(double precision, integer) is not permitted in Postgres
  // so it's necessary to cast to decimal before rounding.
  if (expression.this.isType(exp.DType.DOUBLE)) {
    const decimal_type = exp.DType.DECIMAL.intoExpr({ expressions: expression.expressions });
    this_ = self.sql(new exp.Cast({ this: this_, to: decimal_type }));
  }

  return self.func("ROUND", this_, decimals);
}

/** py: sqlglot/generators/postgres.py:251 `class PostgresGenerator(generator.Generator)`. */
export class PostgresGenerator extends Generator {
  static SELECT_KINDS = [];
  static TRY_SUPPORTED = false;
  static SUPPORTS_DECODE_CASE = false;

  /** py:256 `AFTER_HAVING_MODIFIER_TRANSFORMS = generator.AFTER_HAVING_MODIFIER_TRANSFORMS` */
  static AFTER_HAVING_MODIFIER_TRANSFORMS = Generator.AFTER_HAVING_MODIFIER_TRANSFORMS;

  static SINGLE_STRING_INTERVAL = true;
  static RENAME_TABLE_WITH_DB = false;
  static LOCKING_READS_SUPPORTED = true;
  static JOIN_HINTS = false;
  static TABLE_HINTS = false;
  static QUERY_HINTS = false;
  static NVL2_SUPPORTED = false;
  static PARAMETER_TOKEN = "$";
  static NAMED_PLACEHOLDER_TOKEN = "%";
  static TABLESAMPLE_SIZE_IS_ROWS = false;
  static TABLESAMPLE_SEED_KEYWORD = "REPEATABLE";
  static SUPPORTS_SELECT_INTO = true;
  static JSON_TYPE_REQUIRED_FOR_EXTRACTION = true;
  static SUPPORTS_UNLOGGED_TABLES = true;
  static LIKE_PROPERTY_INSIDE_SCHEMA = true;
  static MULTI_ARG_DISTINCT = false;
  static CAN_IMPLEMENT_ARRAY_ANY = true;
  static SUPPORTS_WINDOW_EXCLUDE = true;
  static COPY_HAS_INTO_KEYWORD = false;
  static ARRAY_CONCAT_IS_VAR_LEN = false;
  static SUPPORTS_MEDIAN = false;
  static ARRAY_SIZE_DIM_REQUIRED = true;
  static SUPPORTS_BETWEEN_FLAGS = true;
  // PostgreSQL uses "INOUT" (no space)
  static INOUT_SEPARATOR = "";

  static SUPPORTED_JSON_PATH_PARTS = new Set([exp.JSONPathKey, exp.JSONPathRoot, exp.JSONPathSubscript]);

  /** py:289 */
  lateral_sql(expression) {
    let sql = super.lateral_sql(expression);

    if (expression.args.cross_apply !== null && expression.args.cross_apply !== undefined) {
      sql = `${sql} ON TRUE`;
    }

    return sql;
  }

  /** py:297 */
  static TYPE_MAPPING = new Map([
    ...Generator.TYPE_MAPPING,
    [exp.DType.TINYINT, "SMALLINT"],
    [exp.DType.FLOAT, "REAL"],
    [exp.DType.DOUBLE, "DOUBLE PRECISION"],
    [exp.DType.BINARY, "BYTEA"],
    [exp.DType.VARBINARY, "BYTEA"],
    [exp.DType.ROWVERSION, "BYTEA"],
    [exp.DType.DATETIME, "TIMESTAMP"],
    [exp.DType.TIMESTAMPNTZ, "TIMESTAMP"],
    [exp.DType.BLOB, "BYTEA"],
  ]);

  /** py:310 */
  static TRANSFORMS = new Map([
    ...[...Generator.TRANSFORMS].filter(([k]) => k !== exp.CommentColumnConstraint),
    [exp.AnyValue, _versioned_anyvalue_sql],
    [exp.ArrayConcat, array_concat_sql("ARRAY_CAT")],
    [exp.ArrayFilter, filter_array_using_unnest],
    [exp.ArrayAppend, array_append_sql("ARRAY_APPEND")],
    [exp.ArrayPrepend, array_append_sql("ARRAY_PREPEND", true)],
    [exp.BitwiseAndAgg, rename_func("BIT_AND")],
    [exp.BitwiseOrAgg, rename_func("BIT_OR")],
    [exp.BitwiseXor, (self, e) => self.binary(e, "#")],
    [exp.BitwiseXorAgg, rename_func("BIT_XOR")],
    [exp.ColumnDef, transforms.preprocess([_auto_increment_to_serial, _serial_to_generated])],
    [exp.CurrentDate, no_paren_current_date_sql],
    [exp.CurrentTimestamp, () => "CURRENT_TIMESTAMP"],
    [exp.CurrentUser, () => "CURRENT_USER"],
    [exp.CurrentVersion, rename_func("VERSION")],
    [exp.DateAdd, _date_add_sql("+")],
    [exp.DateDiff, _date_diff_sql],
    [exp.DateStrToDate, datestrtodate_sql],
    [exp.DateSub, _date_add_sql("-")],
    [exp.Day, _day_month_year_sql],
    [exp.Explode, rename_func("UNNEST")],
    [exp.ExplodingGenerateSeries, rename_func("GENERATE_SERIES")],
    [exp.GenerateSeries, generate_series_sql("GENERATE_SERIES")],
    [exp.Getbit, getbit_sql],
    [exp.GroupConcat, (self, e) => groupconcat_sql(self, e, { func_name: "STRING_AGG", within_group: false })],
    [exp.IntDiv, rename_func("DIV")],
    [exp.JSONArrayAgg, (self, e) => self.func("JSON_AGG", self.sql(e, "this"), { suffix: `${self.sql(e, "order")})` })],
    [exp.JSONExtract, _json_extract_sql("JSON_EXTRACT_PATH", "->")],
    [exp.JSONExtractScalar, _json_extract_sql("JSON_EXTRACT_PATH_TEXT", "->>")],
    [exp.JSONBExtract, (self, e) => self.binary(e, "#>")],
    [exp.JSONBExtractScalar, (self, e) => self.binary(e, "#>>")],
    [exp.ParseJSON, (self, e) => self.sql(exp.cast(e.this, exp.DType.JSON))],
    [exp.JSONPathKey, json_path_key_only_name],
    [exp.JSONPathRoot, () => ""],
    [exp.JSONPathSubscript, (self, e) => self.json_path_part(e.this)],
    [exp.LastDay, no_last_day_sql],
    [exp.LogicalOr, rename_func("BOOL_OR")],
    [exp.LogicalAnd, rename_func("BOOL_AND")],
    [exp.Max, max_or_greatest],
    [exp.MapFromEntries, no_map_from_entries_sql],
    [exp.Min, min_or_least],
    [exp.Merge, merge_without_target_sql],
    [exp.Month, _day_month_year_sql],
    [exp.PartitionedByProperty, (self, e) => `PARTITION BY ${self.sql(e, "this")}`],
    [exp.PercentileCont, transforms.preprocess([transforms.add_within_group_for_percentiles])],
    [exp.PercentileDisc, transforms.preprocess([transforms.add_within_group_for_percentiles])],
    [exp.Pivot, no_pivot_sql],
    [exp.Rand, rename_func("RANDOM")],
    [exp.RegexpLike, (self, e) => self.binary(e, "~")],
    [exp.RegexpILike, (self, e) => self.binary(e, "~*")],
    [
      exp.RegexpReplace,
      (self, e) => self.func(
        "REGEXP_REPLACE",
        e.this,
        e.expression,
        e.args.replacement,
        e.args.position,
        e.args.occurrence,
        regexp_replace_global_modifier(e),
      ),
    ],
    [exp.Round, _round_sql],
    [
      exp.Select,
      transforms.preprocess([transforms.eliminate_semi_and_anti_joins, transforms.eliminate_qualify]),
    ],
    [exp.SHA2, sha256_sql],
    [exp.SHA2Digest, sha2_digest_sql],
    [exp.StrPosition, (self, e) => strposition_sql(self, e, { func_name: "POSITION" })],
    [exp.StrToDate, (self, e) => self.func("TO_DATE", e.this, self.format_time(e))],
    [exp.StrToTime, (self, e) => self.func("TO_TIMESTAMP", e.this, self.format_time(e))],
    [exp.StructExtract, struct_extract_sql],
    [exp.Substring, _substring_sql],
    [exp.TimeFromParts, rename_func("MAKE_TIME")],
    [exp.TimestampFromParts, rename_func("MAKE_TIMESTAMP")],
    [exp.TimestampTrunc, timestamptrunc_sql(undefined, true)],
    [exp.TimeStrToTime, timestrtotime_sql],
    [exp.TimeToStr, (self, e) => self.func("TO_CHAR", e.this, self.format_time(e))],
    [
      exp.ToChar,
      (self, e) => (e.args.format ? self.function_fallback_sql(e) : self.tochar_sql(e)),
    ],
    [exp.Trim, trim_sql],
    [exp.TryCast, no_trycast_sql],
    [exp.TsOrDsAdd, _date_add_sql("+")],
    [exp.TsOrDsDiff, _date_diff_sql],
    // py: `exp.UnixToTime` is assigned TWICE in the upstream dict literal (py:406 then
    // py:414); the second assignment overwrites the first, so only `_unix_to_time_sql`
    // is ever live. Both entries are kept, in order, so `new Map` reproduces that same
    // last-one-wins overwrite rather than silently dropping the dead first entry.
    [exp.UnixToTime, (self, e) => self.func("TO_TIMESTAMP", e.this)],
    [exp.Uuid, () => "GEN_RANDOM_UUID()"],
    [exp.TimeToUnix, (self, e) => self.func("DATE_PART", exp.Literal.string("epoch"), e.this)],
    [exp.VariancePop, rename_func("VAR_POP")],
    [exp.Variance, rename_func("VAR_SAMP")],
    [exp.Xor, bool_xor_sql],
    [exp.Year, _day_month_year_sql],
    [exp.Unicode, rename_func("ASCII")],
    [exp.UnixToTime, _unix_to_time_sql],
    [exp.Levenshtein, _levenshtein_sql],
    [exp.JSONObjectAgg, rename_func("JSON_OBJECT_AGG")],
    [exp.JSONBObjectAgg, rename_func("JSONB_OBJECT_AGG")],
    [exp.CountIf, count_if_to_sum],
  ]);

  /** py:421 */
  static PROPERTIES_LOCATION = new Map([
    ...Generator.PROPERTIES_LOCATION,
    [exp.PartitionedByProperty, exp.Properties.Location.POST_SCHEMA],
    [exp.TransientProperty, exp.Properties.Location.UNSUPPORTED],
    [exp.VolatileProperty, exp.Properties.Location.UNSUPPORTED],
  ]);

  /** py:428 */
  schemacommentproperty_sql(expression) {
    this.unsupported("Table comments are not supported in the CREATE statement");
    return "";
  }

  /** py:432 */
  commentcolumnconstraint_sql(expression) {
    this.unsupported("Column comments are not supported in the CREATE statement");
    return "";
  }

  /** py:436 */
  columndef_sql(expression, sep = " ") {
    // PostgreSQL places parameter modes BEFORE parameter name
    const param_constraint = expression.find(exp.InOutColumnConstraint);

    if (param_constraint) {
      const mode_sql = this.sql(param_constraint);
      param_constraint.pop(); // Remove to prevent double-rendering
      const base_sql = super.columndef_sql(expression, sep);
      return `${mode_sql} ${base_sql}`;
    }

    return super.columndef_sql(expression, sep);
  }

  /**
   * py:448 `unnest_sql(self, expression)`. See the file header note: the
   * `annotate_types` branch throws `NotPorted` directly at the call site rather than
   * approximating it, same shape as `generators/snowflake.js`'s `trycast_sql`/`dot_sql`.
   */
  unnest_sql(expression) {
    if (expression.expressions.length === 1) {
      const arg = expression.expressions[0];
      if (arg instanceof exp.GenerateDateArray) {
        let generate_series = new exp.GenerateSeries({ ...arg.args });
        if (expression.parent instanceof exp.From || expression.parent instanceof exp.Join) {
          generate_series = exp.select("value::date")
            .from_(new exp.Table({ this: generate_series }).as_("_t", { table: ["value"] }))
            .subquery(expression.args.alias || "_unnested_generate_series");
        }
        return this.sql(generate_series);
      }

      if (!arg.type) {
        throw new NotPorted("unnest_sql (annotate_types)", "sqlglot/optimizer/annotate_types.py");
      }

      const this_ = arg;
      if (this_.isType("array<json>")) {
        let json_this = this_;
        while (json_this instanceof exp.Cast) json_this = json_this.this;

        const arg_as_json = this.sql(exp.cast(json_this, exp.DType.JSON));
        let alias = this.sql(expression, "alias");
        alias = alias ? ` AS ${alias}` : "";

        if (expression.args.offset) {
          this.unsupported("Unsupported JSON_ARRAY_ELEMENTS with offset");
        }

        return `JSON_ARRAY_ELEMENTS(${arg_as_json})${alias}`;
      }
    }

    return super.unnest_sql(expression);
  }

  /** py:479 `bracket_sql(self, expression)`. Forms like ARRAY[1, 2, 3][3] aren't allowed; we need to wrap the ARRAY. */
  bracket_sql(expression) {
    if (expression.this instanceof exp.Array) {
      expression.set("this", exp.paren(expression.this, false));
    }

    return super.bracket_sql(expression);
  }

  /** py:486 */
  matchagainst_sql(expression) {
    const this_ = this.sql(expression, "this");
    const expressions = expression.expressions.map((e) => `${this.sql(e)} @@ ${this_}`);
    const sql = expressions.join(" OR ");
    return expressions.length > 1 ? `(${sql})` : sql;
  }

  /** py:492 */
  alterset_sql(expression) {
    let exprs = this.expressions(expression, null, { flat: true });
    exprs = exprs ? `(${exprs})` : "";

    let access_method = this.sql(expression, "access_method");
    access_method = access_method ? `ACCESS METHOD ${access_method}` : "";
    let tablespace = this.sql(expression, "tablespace");
    tablespace = tablespace ? `TABLESPACE ${tablespace}` : "";
    const option = this.sql(expression, "option");

    return `SET ${exprs}${access_method}${tablespace}${option}`;
  }

  /** py:504 */
  datatype_sql(expression) {
    if (expression.isType(exp.DType.ARRAY)) {
      if (expression.expressions.length) {
        const values = this.expressions(expression, "values", { flat: true });
        return `${this.expressions(expression, null, { flat: true })}[${values}]`;
      }
      return "ARRAY";
    }

    if (expression.isType(exp.DType.ENUM)) {
      return `ENUM (${this.expressions(expression, null, { flat: true })})`;
    }

    if (expression.isType(exp.DType.DOUBLE, exp.DType.FLOAT) && expression.expressions.length) {
      // Postgres doesn't support precision for REAL and DOUBLE PRECISION types
      return `FLOAT(${this.expressions(expression, null, { flat: true })})`;
    }

    return super.datatype_sql(expression);
  }

  /** py:520 */
  cast_sql(expression, safe_prefix = null) {
    const this_ = expression.this;

    // Postgres casts DIV() to decimal for transpilation but when roundtripping it's superfluous
    if (this_ instanceof exp.IntDiv && expression.to.equals(exp.DType.DECIMAL.intoExpr())) {
      return this.sql(this_);
    }

    return super.cast_sql(expression, safe_prefix);
  }

  /** py:529 */
  array_sql(expression) {
    const exprs = expression.expressions;
    const func_name = this.normalize_func("ARRAY");

    if (seqGet(exprs, 0) instanceof exp.Query) {
      return `${func_name}(${this.sql(exprs[0])})`;
    }

    return `${func_name}${inline_array_sql(this, expression)}`;
  }

  /** py:538 */
  computedcolumnconstraint_sql(expression) {
    return `GENERATED ALWAYS AS (${this.sql(expression, "this")}) STORED`;
  }

  /** py:541 */
  isascii_sql(expression) {
    return `(${this.sql(expression.this)} ~ '^[[:ascii:]]*$')`;
  }

  /** py:544. https://www.postgresql.org/docs/current/functions-window.html */
  ignorenulls_sql(expression) {
    this.unsupported("PostgreSQL does not support IGNORE NULLS.");
    return this.sql(expression.this);
  }

  /** py:549. https://www.postgresql.org/docs/current/functions-window.html */
  respectnulls_sql(expression) {
    this.unsupported("PostgreSQL does not support RESPECT NULLS.");
    return this.sql(expression.this);
  }

  /**
   * py:554 `@unsupported_args("this") def currentschema_sql(self, expression)` — the
   * `this`-forwarding shim onto `_currentschema_sql` below, same split as
   * `generators/hive.js`'s `trunc_sql`/`_trunc_sql` (R27).
   */
  currentschema_sql(expression) {
    return _currentschema_sql(this, expression);
  }

  /** py:558 */
  interval_sql(expression) {
    const unit = expression.text("unit").toLowerCase();

    const this_ = expression.this;
    if (unit.startsWith("quarter") && this_ instanceof exp.Literal) {
      const value = this_.toPy();
      const truncated = typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value)));
      this_.replace(exp.Literal.string(truncated * 3n));
      expression.args.unit.replace(exp.var("MONTH"));
    }

    return super.interval_sql(expression);
  }

  /** py:568 */
  placeholder_sql(expression) {
    if (expression.args.jdbc) {
      return "?";
    }

    const this_ = expression.this ? `(${expression.name})` : "";
    return `${this.constructor.NAMED_PLACEHOLDER_TOKEN}${this_}s`;
  }

  /**
   * py:575 `arraycontains_sql(self, expression)`. Convert DuckDB's
   * LIST_CONTAINS(array, value) to PostgreSQL.
   *
   * DuckDB behavior:
   *   - LIST_CONTAINS([1,2,3], 2) -> true
   *   - LIST_CONTAINS([1,2,3], 4) -> false
   *   - LIST_CONTAINS([1,2,NULL], 4) -> false (not NULL)
   *   - LIST_CONTAINS([1,2,3], NULL) -> NULL
   *
   * PostgreSQL equivalent: CASE WHEN value IS NULL THEN NULL
   *                            ELSE COALESCE(value = ANY(array), FALSE) END
   */
  arraycontains_sql(expression) {
    const value = expression.expression;
    const array = expression.this;

    const coalesce_expr = new exp.Coalesce({
      this: value.eq(new exp.Any({ this: exp.paren(array, false) })),
      expressions: [new exp.Boolean({ this: false })],
    });

    const case_expr = new exp.Case()
      .when(new exp.Is({ this: value, expression: new exp.Null() }), new exp.Null(), { copy: false })
      .else_(coalesce_expr, { copy: false });

    return this.sql(case_expr);
  }
}

/** py:554 `@unsupported_args("this") def currentschema_sql(self, expression)`. */
const _currentschema_sql = unsupported_args("this")(() => "CURRENT_SCHEMA");
