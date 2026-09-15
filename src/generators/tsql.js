// py: sqlglot/generators/tsql.py — `class TSQLGenerator(generator.Generator)`.
//
// The WRITE-side counterpart of `src/parsers/tsql.js` (grammar) and
// `src/dialects/tsql.js` (settings) — same three-file split every prior dialect port
// uses. This file mirrors upstream's full 656 LOC: every `TRANSFORMS` entry and every
// `*_sql` override is ported, with two exceptions, both blocked on a DIFFERENT
// unported component rather than anything TSQL-specific:
//
//   `exp.CTE`/`exp.Subquery` (py:202,234, both `transforms.preprocess([
//   qualify_derived_table_outputs])`) — `qualify_derived_table_outputs`'s own body
//   calls `sqlglot.optimizer.qualify_columns.qualify_outputs`, which is unported
//   (the whole `optimizer/qualify_columns.py` module, not just this one function).
//   Left commented out at its upstream anchor, matching `generators/snowflake.js`'s
//   own precedent for exactly this shape of gap (its header explains five such
//   entries, one of which is this same `optimizer/scope.py`-adjacent family).
//
// Everything else's dependencies are already real: `_string_agg_sql` (py:48, GroupConcat)
// needed `find_in_scope`, which is `src/optimizer/scope.js`'s ALREADY-PORTED Tier A
// `findInScope` (not the unported `Scope`/`build_scope` machinery); the rest route
// through `src/dialects/dialect.js` helpers, most of which already existed from
// earlier dialect rounds. `remove_ts_or_ds_to_date` (py:2015) did not — added to
// `dialect.js` alongside this file, its first caller (`exp.Day`/`exp.Month`/`exp.Year`).
//
// THE SAME CIRCULAR IMPORT `dialects/tsql.js` DOCUMENTS, ON THIS FILE'S SIDE
// -------------------------------------------------------------------------
// `_format_sql` (py:31) does `from sqlglot.dialects.tsql import TSQL` INSIDE its own
// body, to read `TSQL.INVERSE_TIME_MAPPING` — upstream's real circular-import
// workaround, since `dialects/tsql.py` imports `TSQLGenerator` FROM this file at
// module level. `Dialect.get_or_raise("tsql")` resolves it here too, exactly like
// `src/parsers/tsql.js`'s `_tsqlSettings()`: a runtime registry lookup rather than a
// module import, which stays correct no matter which of the two files a caller
// enters through first (see that function's comment for the full ES-module-cycle
// trace this sidesteps).

import { seqGet } from "../helper.js";
import * as exp from "../expressions/index.js";
import * as transforms from "../transforms.js";
import { findInScope } from "../optimizer/scope.js";
import { Generator, AFTER_HAVING_MODIFIER_TRANSFORMS, unsupported_args } from "../generator.js";
import {
  Dialect,
  any_value_to_max_sql,
  date_delta_sql,
  datestrtodate_sql,
  generatedasidentitycolumnconstraint_sql,
  max_or_greatest,
  min_or_least,
  remove_ts_or_ds_to_date,
  rename_func,
  strposition_sql,
  timestrtotime_sql,
  trim_sql,
} from "../dialects/dialect.js";
import { OPTIONS_THAT_REQUIRE_EQUAL } from "../parsers/tsql.js";
import { formatTime } from "../time.js";

/** py: sqlglot/generators/tsql.py:25 */
const DATE_PART_UNMAPPING = new Map([
  ["WEEKISO", "ISO_WEEK"],
  ["DAYOFWEEK", "WEEKDAY"],
  ["TIMEZONE_MINUTE", "TZOFFSET"],
]);

/** py: sqlglot/generators/tsql.py:29 */
const BIT_TYPES = new Set([exp.EQ, exp.NEQ, exp.Is, exp.In, exp.Select, exp.Alias]);

/**
 * py: sqlglot/generators/tsql.py:32 `_format_sql(self, expression)`.
 *
 * See the file header for why `TSQL` is resolved via `Dialect.get_or_raise("tsql")`
 * rather than a module-level import.
 */
function _format_sql(self, expression) {
  const fmt = expression.args.format;

  let fmt_sql;
  if (!(expression instanceof exp.NumberToStr)) {
    if (fmt.is_string) {
      const TSQL = Dialect.get_or_raise("tsql");
      const mapped_fmt = formatTime(fmt.name, TSQL.INVERSE_TIME_MAPPING);
      fmt_sql = self.sql(exp.Literal.string(mapped_fmt));
    } else {
      fmt_sql = self.format_time(expression) || self.sql(fmt);
    }
  } else {
    fmt_sql = self.sql(fmt);
  }

  return self.func("FORMAT", expression.this, fmt_sql, expression.args.culture);
}

/** py: sqlglot/generators/tsql.py:48 `_string_agg_sql(self, expression)` */
function _string_agg_sql(self, expression) {
  let this_ = expression.this;
  const distinct = findInScope(expression, exp.Distinct);
  if (distinct) {
    // exp.Distinct can appear below an exp.Order or an exp.GroupConcat expression
    self.unsupported("T-SQL STRING_AGG doesn't support DISTINCT.");
    this_ = distinct.pop().expressions[0];
  }

  let order = "";
  if (expression.this instanceof exp.Order) {
    if (expression.this.this) this_ = expression.this.this.pop();
    // Order has a leading space
    order = ` WITHIN GROUP (${self.sql(expression.this).slice(1)})`;
  }

  const separator = expression.args.separator || exp.Literal.string(",");
  return `STRING_AGG(${self.format_args(this_, separator)})${order}`;
}

// py:66 `qualify_derived_table_outputs(expression)` — blocked on
// `sqlglot.optimizer.qualify_columns.qualify_outputs`, unported. See file header. The
// only callers are the `exp.CTE`/`exp.Subquery` TRANSFORMS entries below, themselves
// commented out for the same reason.

/** py: sqlglot/generators/tsql.py:97 `_json_extract_sql(self, expression)` */
function _json_extract_sql(self, expression) {
  const json_query = self.func("JSON_QUERY", expression.this, expression.expression);
  const json_value = self.func("JSON_VALUE", expression.this, expression.expression);
  return self.func("ISNULL", json_query, json_value);
}

/** py: sqlglot/generators/tsql.py:106 `_timestrtotime_sql(self, expression)` */
function _timestrtotime_sql(self, expression) {
  const sql = timestrtotime_sql(self, expression);
  if (expression.args.zone) {
    // If there is a timezone, produce an expression like:
    // CAST('2020-01-01 12:13:14-08:00' AS DATETIMEOFFSET) AT TIME ZONE 'UTC'
    // If you dont have AT TIME ZONE 'UTC', wrapping that expression in another cast
    // back to DATETIME2 just drops the timezone information
    return self.sql(new exp.AtTimeZone({ this: sql, zone: exp.Literal.string("UTC") }));
  }
  return sql;
}

/** py: sqlglot/generators/tsql.py:121 `class TSQLGenerator(generator.Generator)`. */
export class TSQLGenerator extends Generator {
  static SELECT_KINDS = [];
  static TRY_SUPPORTED = false;
  static SUPPORTS_UESCAPE = false;
  static SUPPORTS_DECODE_CASE = false;

  // py:126 `AFTER_HAVING_MODIFIER_TRANSFORMS = generator.AFTER_HAVING_MODIFIER_TRANSFORMS`
  // — the bare MODULE-LEVEL constant, not the base class's own richer table (which
  // spreads this one and adds `cluster`/`distribute`/`sort`, T-SQL has none of).
  static AFTER_HAVING_MODIFIER_TRANSFORMS = AFTER_HAVING_MODIFIER_TRANSFORMS;

  static LIMIT_IS_TOP = true;
  static QUERY_HINTS = false;
  static RETURNING_END = false;
  static NVL2_SUPPORTED = false;
  static ALTER_TABLE_INCLUDE_COLUMN_KEYWORD = false;
  static LIMIT_FETCH = "FETCH";
  static COMPUTED_COLUMN_WITH_TYPE = false;
  static CTE_RECURSIVE_KEYWORD_REQUIRED = false;
  static ENSURE_BOOLS = true;
  static NULL_ORDERING_SUPPORTED = null;
  static SUPPORTS_SINGLE_ARG_CONCAT = false;
  static TABLESAMPLE_SEED_KEYWORD = "REPEATABLE";
  static SUPPORTS_SELECT_INTO = true;
  static JSON_PATH_BRACKETED_KEY_SUPPORTED = false;
  static SUPPORTS_TO_NUMBER = false;
  static SET_OP_MODIFIERS = false;
  static COPY_PARAMS_EQ_REQUIRED = true;
  static PARSE_JSON_NAME = null;
  static EXCEPT_INTERSECT_SUPPORT_ALL_CLAUSE = false;
  static ALTER_SET_WRAPPED = true;
  static ALTER_SET_TYPE = "";
  static SUPPORTS_ALTER_COLUMN_NULLABILITY = true;

  /** py:152 */
  static EXPRESSIONS_WITHOUT_NESTED_CTES = new Set([
    exp.Create,
    exp.Delete,
    exp.Insert,
    exp.Intersect,
    exp.Except,
    exp.Merge,
    exp.Select,
    exp.Subquery,
    exp.Union,
    exp.Update,
  ]);

  /** py:165 */
  static SUPPORTED_JSON_PATH_PARTS = new Set([exp.JSONPathKey, exp.JSONPathRoot, exp.JSONPathSubscript]);

  /** py:171 `{k: v for k, v in generator.Generator.TYPE_MAPPING.items() if k not in (...)}` */
  static TYPE_MAPPING = new Map([
    ...[...Generator.TYPE_MAPPING].filter(([k]) => k !== exp.DType.NCHAR && k !== exp.DType.NVARCHAR),
    [exp.DType.BOOLEAN, "BIT"],
    [exp.DType.DATETIME2, "DATETIME2"],
    [exp.DType.DECIMAL, "NUMERIC"],
    [exp.DType.DOUBLE, "FLOAT"],
    [exp.DType.INT, "INTEGER"],
    [exp.DType.ROWVERSION, "ROWVERSION"],
    [exp.DType.TEXT, "VARCHAR(MAX)"],
    [exp.DType.TIMESTAMP, "DATETIME2"],
    [exp.DType.TIMESTAMPNTZ, "DATETIME2"],
    [exp.DType.TIMESTAMPTZ, "DATETIMEOFFSET"],
    [exp.DType.SMALLDATETIME, "SMALLDATETIME"],
    [exp.DType.UTINYINT, "TINYINT"],
    [exp.DType.VARIANT, "SQL_VARIANT"],
    [exp.DType.UUID, "UNIQUEIDENTIFIER"],
  ]);

  /** py:193 `{**{k: v for k, v in generator.Generator.TRANSFORMS.items() if k != exp.ReturnsProperty}, ...}` */
  static TRANSFORMS = new Map([
    ...[...Generator.TRANSFORMS].filter(([k]) => k !== exp.ReturnsProperty),
    [exp.AnyValue, any_value_to_max_sql],
    [exp.Atan2, rename_func("ATN2")],
    [exp.ArrayToString, rename_func("STRING_AGG")],
    [exp.AutoIncrementColumnConstraint, () => "IDENTITY"],
    [exp.Ceil, rename_func("CEILING")],
    [exp.Chr, rename_func("CHAR")],
    [exp.DateAdd, date_delta_sql("DATEADD")],
    // py:202 `exp.CTE: transforms.preprocess([qualify_derived_table_outputs])` —
    // blocked, see file header.
    [exp.CurrentDate, rename_func("GETDATE")],
    [exp.CurrentTimestamp, rename_func("GETDATE")],
    [exp.CurrentTimestampLTZ, rename_func("SYSDATETIMEOFFSET")],
    [exp.DateStrToDate, datestrtodate_sql],
    [exp.Day, remove_ts_or_ds_to_date()],
    [exp.GeneratedAsIdentityColumnConstraint, generatedasidentitycolumnconstraint_sql],
    [exp.GroupConcat, _string_agg_sql],
    [exp.If, rename_func("IIF")],
    [exp.JSONExtract, _json_extract_sql],
    [exp.JSONExtractScalar, _json_extract_sql],
    [exp.LastDay, (self, e) => self.func("EOMONTH", e.this)],
    [exp.Ln, rename_func("LOG")],
    [exp.Max, max_or_greatest],
    [exp.MD5, (self, e) => self.func("HASHBYTES", exp.Literal.string("MD5"), e.this)],
    [exp.Min, min_or_least],
    [exp.Month, remove_ts_or_ds_to_date()],
    [exp.NumberToStr, _format_sql],
    [exp.Repeat, rename_func("REPLICATE")],
    [exp.CurrentSchema, rename_func("SCHEMA_NAME")],
    [
      exp.Select,
      transforms.preprocess([
        transforms.eliminate_distinct_on,
        transforms.eliminate_semi_and_anti_joins,
        transforms.eliminate_qualify,
        transforms.unnest_generate_date_array_using_recursive_cte,
      ]),
    ],
    [exp.Stddev, rename_func("STDEV")],
    [exp.StrPosition, (self, e) => strposition_sql(self, e, { func_name: "CHARINDEX", supports_position: true })],
    // py:234 `exp.Subquery: transforms.preprocess([qualify_derived_table_outputs])` —
    // blocked, see file header.
    [exp.SHA, (self, e) => self.func("HASHBYTES", exp.Literal.string("SHA1"), e.this)],
    [exp.SHA1Digest, (self, e) => self.func("HASHBYTES", exp.Literal.string("SHA1"), e.this)],
    // py:237 `exp.Literal.string(f"SHA2_{e.args.get('length', 256)}")` — an implicit
    // Python `str()` on whatever `args["length"]` holds, which is either an `exp.Expr`
    // (its rendered SQL text) or the bare default `256`. A JS template literal calling
    // `.toString()` on an `Expr` would print this codebase's debug repr instead
    // (`Literal(this=512, is_string=False)`, not `512`) — `self.sql(length)` is the
    // deny:implicit_str-safe equivalent (PORT_PLAN.md, "static analysis misses
    // implicit __str__").
    [exp.SHA2, (self, e) => {
      const length = e.args.length;
      const length_sql = length instanceof exp.Expr ? self.sql(length) : String(length ?? 256);
      return self.func("HASHBYTES", exp.Literal.string(`SHA2_${length_sql}`), e.this);
    }],
    [exp.TemporaryProperty, () => ""],
    [exp.TimeStrToTime, _timestrtotime_sql],
    [exp.TimeToStr, _format_sql],
    [exp.TimestampAdd, date_delta_sql("DATEADD")],
    [exp.Trim, trim_sql],
    [exp.TsOrDsAdd, date_delta_sql("DATEADD", true)],
    [exp.TsOrDsDiff, date_delta_sql("DATEDIFF")],
    [exp.TimestampTrunc, (self, e) => self.func("DATETRUNC", e.unit, e.this)],
    [exp.Trunc, (self, e) => self.func(
      "ROUND",
      e.this,
      e.args.decimals || exp.Literal.number(0),
      exp.Literal.number(1),
    )],
    [exp.Uuid, () => "NEWID()"],
    [exp.Year, remove_ts_or_ds_to_date()],
    [exp.DateFromParts, rename_func("DATEFROMPARTS")],
  ]);

  /** py:259 */
  static PROPERTIES_LOCATION = new Map([
    ...Generator.PROPERTIES_LOCATION,
    [exp.VolatileProperty, exp.Properties.Location.UNSUPPORTED],
  ]);

  /** py:264 */
  scope_resolution(rhs, scope_name) {
    return `${scope_name}::${rhs}`;
  }

  /** py:267 */
  select_sql(expression) {
    const limit = expression.args.limit;
    let offset = expression.args.offset;

    if (limit instanceof exp.Fetch && !offset) {
      // Dialects like Oracle can FETCH directly from a row set but
      // T-SQL requires an ORDER BY + OFFSET clause in order to FETCH
      offset = new exp.Offset({ expression: exp.Literal.number(0) });
      expression.set("offset", offset);
    }

    if (offset) {
      if (!expression.args.order) {
        // ORDER BY is required in order to use OFFSET in a query, so we use
        // a noop order by, since we don't really care about the order.
        // See: https://www.microsoftpressstore.com/articles/article.aspx?p=2314819
        expression.order_by(exp.select(exp.null_()).subquery(), { copy: false });
      }

      if (limit instanceof exp.Limit) {
        // TOP and OFFSET can't be combined, we need use FETCH instead of TOP
        // we replace here because otherwise TOP would be generated in select_sql
        limit.replace(new exp.Fetch({ direction: "FIRST", count: limit.expression }));
      }
    }

    return super.select_sql(expression);
  }

  /** py:291 */
  convert_sql(expression) {
    const name = expression.args.safe ? "TRY_CONVERT" : "CONVERT";
    return this.func(name, expression.this, expression.expression, expression.args.style);
  }

  /** py:295 */
  queryoption_sql(expression) {
    const option = this.sql(expression, "this");
    const value = this.sql(expression, "expression");
    if (value) {
      const optional_equal_sign = OPTIONS_THAT_REQUIRE_EQUAL.has(option) ? "= " : "";
      return `${option} ${optional_equal_sign}${value}`;
    }
    return option;
  }

  /** py:303 */
  lateral_op(expression) {
    const cross_apply = expression.args.cross_apply;
    if (cross_apply === true) return "CROSS APPLY";
    if (cross_apply === false) return "OUTER APPLY";

    // TODO: perhaps we can check if the parent is a Join and transpile it appropriately
    this.unsupported("LATERAL clause is not supported.");
    return "LATERAL";
  }

  /** py:314 */
  splitpart_sql(expression) {
    const this_ = expression.this;
    const split_count = this_.name.split(".").length;
    const delimiter = expression.args.delimiter;
    const part_index = expression.args.part_index;

    if (
      ![this_, delimiter, part_index].every((arg) => arg instanceof exp.Literal)
      || (delimiter && delimiter.name !== ".")
      || !part_index
      || split_count > 4
    ) {
      this.unsupported("SPLIT_PART can be transpiled to PARSENAME only for '.' delimiter and literal values");
      return "";
    }

    return this.func("PARSENAME", this_, exp.Literal.number(split_count + 1 - Number(part_index.toPy())));
  }

  /** py:335 */
  extract_sql(expression) {
    const part = expression.this;
    const name = DATE_PART_UNMAPPING.get(part.name.toUpperCase()) || part;

    return this.func("DATEPART", name, expression.expression);
  }

  /** py:341 */
  timefromparts_sql(expression) {
    const nano = expression.args.nano;
    if (nano !== null && nano !== undefined) {
      nano.pop();
      this.unsupported("Specifying nanoseconds is not supported in TIMEFROMPARTS.");
    }

    if (expression.args.fractions === null || expression.args.fractions === undefined) {
      expression.set("fractions", exp.Literal.number(0));
    }
    if (expression.args.precision === null || expression.args.precision === undefined) {
      expression.set("precision", exp.Literal.number(0));
    }

    return rename_func("TIMEFROMPARTS")(this, expression);
  }

  /** py:354 */
  timestampfromparts_sql(expression) {
    const zone = expression.args.zone;
    if (zone !== null && zone !== undefined) {
      zone.pop();
      this.unsupported("Time zone is not supported in DATETIMEFROMPARTS.");
    }

    const nano = expression.args.nano;
    if (nano !== null && nano !== undefined) {
      nano.pop();
      this.unsupported("Specifying nanoseconds is not supported in DATETIMEFROMPARTS.");
    }

    if (expression.args.milli === null || expression.args.milli === undefined) {
      expression.set("milli", exp.Literal.number(0));
    }

    return rename_func("DATETIMEFROMPARTS")(this, expression);
  }

  /** py:370 */
  setitem_sql(expression) {
    const this_ = expression.this;
    if (this_ instanceof exp.EQ && !(this_.left instanceof exp.Parameter)) {
      // T-SQL does not use '=' in SET command, except when the LHS is a variable.
      return `${this.sql(this_.left)} ${this.sql(this_.right)}`;
    }

    return super.setitem_sql(expression);
  }

  /** py:378 */
  boolean_sql(expression) {
    if (
      BIT_TYPES.has(expression.parent?.constructor)
      || expression.findAncestor(exp.Values, exp.Select) instanceof exp.Values
    ) {
      return expression.this ? "1" : "0";
    }

    return expression.this ? "(1 = 1)" : "(1 = 0)";
  }

  /** py:386 */
  is_sql(expression) {
    const negate = expression.args.negate;
    if (expression.expression instanceof exp.Boolean) {
      return this.binary(expression, negate ? "<>" : "=");
    }
    return this.binary(expression, negate ? "IS NOT" : "IS");
  }

  /** py:392 */
  createable_sql(expression, locations) {
    let sql = this.sql(expression, "this");
    const properties = expression.args.properties;

    const start = this._identifier_start;
    if (
      !sql.startsWith("#")
      && !sql.startsWith(`${start}#`)
      && (properties ? properties.expressions : []).some((prop) => prop instanceof exp.TemporaryProperty)
    ) {
      sql = sql.startsWith(start) ? `${start}#${sql.slice(start.length)}` : `#${sql}`;
    }

    return sql;
  }

  /** py:409 */
  create_sql(expression) {
    const kind = expression.kind;
    const exists = expression.args.exists;
    expression.set("exists", null);

    const like_property = expression.find(exp.LikeProperty);
    let ctas_expression = like_property ? like_property.this : expression.expression;

    if (kind === "VIEW") {
      expression.this.set("catalog", null);
      const with_ = expression.args.with_;
      if (ctas_expression && with_) {
        // We've already preprocessed the Create expression to bubble up any nested CTEs,
        // but CREATE VIEW actually requires the WITH clause to come after it so we need
        // to amend the AST by moving the CTEs to the CREATE VIEW statement's query.
        ctas_expression.set("with_", with_.pop());
      }
    } else if (
      kind === "FUNCTION"
      && ctas_expression instanceof exp.Return
      && ctas_expression.this.unnest() instanceof exp.Query
      && expression.args.with_
    ) {
      // Similar to the VIEW branch, the table-valued functions require the WITH clause
      // to stay inside the RETURN body, so we move back any CTEs that were bubbled up.
      const body = ctas_expression.this.unnest();
      const with_ = expression.args.with_;
      body.set("with_", with_.pop());
    }

    const table = expression.find(exp.Table);

    // Convert CTAS statement to SELECT .. INTO ..
    let sql;
    if (kind === "TABLE" && ctas_expression) {
      if (ctas_expression instanceof exp.Select || ctas_expression instanceof exp.SetOperation) {
        ctas_expression = ctas_expression.subquery();
      }

      const properties = expression.args.properties || new exp.Properties();
      const is_temp = properties.expressions.some((p) => p instanceof exp.TemporaryProperty);

      const select_into = exp.select("*").from_(exp.alias_(ctas_expression, "temp", { table: true }));
      select_into.set("into", new exp.Into({ this: table, temporary: is_temp }));

      if (like_property) select_into.limit(0, { copy: false });

      sql = this.sql(select_into);
    } else {
      sql = super.create_sql(expression);
    }

    if (exists) {
      const identifier = this.sql(exp.Literal.string(table ? exp.tableName(table) : ""));
      const sql_with_ctes = this.prepend_ctes(expression, sql);
      const sql_literal = this.sql(exp.Literal.string(sql_with_ctes));
      if (kind === "SCHEMA") {
        return `IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ${identifier}) EXEC(${sql_literal})`;
      } else if (kind === "TABLE") {
        const where = exp.and_(
          exp.column("TABLE_NAME").eq(table.name),
          table.db ? exp.column("TABLE_SCHEMA").eq(table.db) : null,
          table.catalog ? exp.column("TABLE_CATALOG").eq(table.catalog) : null,
        );
        // deny:implicit_str sqlglot/generators/tsql.py:471 — f-string on `where` (an
        // `exp.Expr`) calls Python's implicit `str(where)` == `where.sql()`; a bare JS
        // template literal would call `.toString()` (this port's debug repr), not
        // `.sql()`, so the call is explicit via `this.sql(where)` above.
        return `IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE ${this.sql(where)}) EXEC(${sql_literal})`;
      } else if (kind === "INDEX") {
        const index = this.sql(exp.Literal.string(expression.this.text("this")));
        return `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE object_id = object_id(${identifier}) AND name = ${index}) EXEC(${sql_literal})`;
      }
    } else if (expression.args.replace) {
      sql = sql.replace("CREATE OR REPLACE ", "CREATE OR ALTER ");
    }

    return this.prepend_ctes(expression, sql);
  }

  /** py:480 `@generator.unsupported_args("unlogged", "expressions")` */
  into_sql(expression) {
    return _into_sql(this, expression);
  }

  /** py:490 */
  count_sql(expression) {
    const func_name = expression.args.big_int ? "COUNT_BIG" : "COUNT";
    return rename_func(func_name)(this, expression);
  }

  /** py:494 */
  datediff_sql(expression) {
    const func_name = expression.args.big_int ? "DATEDIFF_BIG" : "DATEDIFF";
    return date_delta_sql(func_name)(this, expression);
  }

  /** py:498 */
  offset_sql(expression) {
    return `${super.offset_sql(expression)} ROWS`;
  }

  /** py:501 */
  version_sql(expression) {
    const name = expression.name === "TIMESTAMP" ? "SYSTEM_TIME" : expression.name;
    const this_ = `FOR ${name}`;
    const expr = expression.expression;
    const kind = expression.text("kind");
    let expr_sql;
    if (kind === "FROM" || kind === "BETWEEN") {
      const args = expr.expressions;
      const sep = kind === "FROM" ? "TO" : "AND";
      expr_sql = `${this.sql(seqGet(args, 0))} ${sep} ${this.sql(seqGet(args, 1))}`;
    } else {
      expr_sql = this.sql(expr);
    }

    expr_sql = expr_sql ? ` ${expr_sql}` : "";
    return `${this_} ${kind}${expr_sql}`;
  }

  /** py:516 */
  returnsproperty_sql(expression) {
    const table = expression.args.table;
    const table_ = table ? `${table} ` : "";
    return `RETURNS ${table_}${this.sql(expression, "this")}`;
  }

  /** py:521 */
  returning_sql(expression) {
    const into = this.sql(expression, "into");
    const into_ = into ? this.seg(`INTO ${into}`) : "";
    return `${this.seg("OUTPUT")} ${this.expressions(expression, null, { flat: true })}${into_}`;
  }

  /** py:526 */
  transaction_sql(expression) {
    let this_ = this.sql(expression, "this");
    this_ = this_ ? ` ${this_}` : "";
    let mark = this.sql(expression, "mark");
    mark = mark ? ` WITH MARK ${mark}` : "";
    return `BEGIN TRANSACTION${this_}${mark}`;
  }

  /** py:533 */
  commit_sql(expression) {
    let this_ = this.sql(expression, "this");
    this_ = this_ ? ` ${this_}` : "";
    const durability = expression.args.durability;
    const durability_ = durability !== null && durability !== undefined
      ? ` WITH (DELAYED_DURABILITY = ${durability ? "ON" : "OFF"})`
      : "";
    return `COMMIT TRANSACTION${this_}${durability_}`;
  }

  /** py:544 */
  rollback_sql(expression) {
    let this_ = this.sql(expression, "this");
    this_ = this_ ? ` ${this_}` : "";
    return `ROLLBACK TRANSACTION${this_}`;
  }

  /** py:549 */
  identifier_sql(expression) {
    const identifier = super.identifier_sql(expression);

    let prefix;
    if (expression.args.global_) prefix = "##";
    else if (expression.args.temporary) prefix = "#";
    else return identifier;

    const start = this._identifier_start;
    if (expression.quoted && identifier.startsWith(start)) {
      return `${start}${prefix}${identifier.slice(start.length)}`;
    }

    return `${prefix}${identifier}`;
  }

  /** py:565 */
  constraint_sql(expression) {
    const this_ = this.sql(expression, "this");
    const expressions = this.expressions(expression, null, { flat: true, sep: " " });
    return `CONSTRAINT ${this_} ${expressions}`;
  }

  /** py:570 */
  length_sql(expression) {
    return this._uncast_text(expression, "LEN");
  }

  /** py:573 */
  right_sql(expression) {
    return this._uncast_text(expression, "RIGHT");
  }

  /** py:576 */
  left_sql(expression) {
    return this._uncast_text(expression, "LEFT");
  }

  /** py:579 */
  _uncast_text(expression, name) {
    const this_ = expression.this;
    const this_sql = this_ instanceof exp.Cast && this_.isType(exp.DType.TEXT)
      ? this.sql(this_, "this")
      : this.sql(this_);
    const expression_sql = this.sql(expression, "expression");
    return this.func(name, this_sql, expression_sql || null);
  }

  /** py:588 */
  partition_sql(expression) {
    return `WITH (PARTITIONS(${this.expressions(expression, null, { flat: true })}))`;
  }

  /** py:591 */
  alter_sql(expression) {
    const action = seqGet(expression.args.actions || [], 0);
    if (action instanceof exp.AlterRename) {
      return `EXEC sp_rename '${this.sql(expression.this)}', '${action.this.name}'`;
    }
    return super.alter_sql(expression);
  }

  /** py:597 */
  drop_sql(expression) {
    if (expression.args.kind === "VIEW") {
      for (const table of expression.args.tables || []) table.set("catalog", null);
    }
    return super.drop_sql(expression);
  }

  /** py:603 */
  options_modifier(expression) {
    const options = this.expressions(expression, "options");
    return options ? ` OPTION${this.wrap(options)}` : "";
  }

  /** py:607 */
  dpipe_sql(expression) {
    return this.sql([...expression.flatten()].reduce((x, y) => new exp.Add({ this: x, expression: y })));
  }

  /** py:610 */
  isascii_sql(expression) {
    return "(PATINDEX(CONVERT(VARCHAR(MAX), 0x255b5e002d7f5d25) COLLATE Latin1_General_BIN, " +
      `${this.sql(expression.this)}) = 0)`;
  }

  /** py:613 */
  columndef_sql(expression, sep = " ") {
    const this_ = super.columndef_sql(expression, sep);
    let default_ = this.sql(expression, "default");
    default_ = default_ ? ` = ${default_}` : "";
    let output = this.sql(expression, "output");
    output = output ? ` ${output}` : "";
    return `${this_}${default_}${output}`;
  }

  /** py:621 */
  coalesce_sql(expression) {
    const func_name = expression.args.is_null ? "ISNULL" : "COALESCE";
    return rename_func(func_name)(this, expression);
  }

  /** py:625 */
  storedprocedure_sql(expression) {
    const this_ = this.sql(expression, "this");
    let expressions = this.expressions(expression);
    expressions = expression.args.wrapped ? this.wrap(expressions) : ` ${expressions}`;
    return expressions.trim() !== "" ? `${this_}${expressions}` : this_;
  }

  /** py:633 */
  ifblock_sql(expression) {
    const this_ = this.sql(expression, "this");
    let true_ = this.sql(expression, "true");
    true_ = true_ ? ` ${true_}` : " ";
    const false_sql = this.sql(expression, "false");
    const false_ = false_sql ? `; ELSE BEGIN ${false_sql}` : "";
    return `IF ${this_} BEGIN${true_}${false_}`;
  }

  /** py:641 */
  whileblock_sql(expression) {
    const this_ = this.sql(expression, "this");
    let body = this.sql(expression, "body");
    body = body ? ` ${body}` : " ";
    return `WHILE ${this_} BEGIN${body}`;
  }

  /** py:647 */
  execute_sql(expression) {
    const this_ = this.sql(expression, "this");
    let expressions = this.expressions(expression);
    expressions = expressions ? ` ${expressions}` : "";
    let return_status = this.sql(expression, "return_status");
    return_status = return_status ? `${return_status} = ` : "";
    return `EXECUTE ${return_status}${this_}${expressions}`;
  }

  /** py:655 */
  executesql_sql(expression) {
    return this.execute_sql(expression);
  }
}

/**
 * py:480 `@generator.unsupported_args("unlogged", "expressions") def into_sql(self, expression)`.
 *
 * A module-level standalone function rather than wrapping the bound method directly
 * — same shape `generators/snowflake.js`'s `_approxquantile_sql` and
 * `generators/postgres.js`'s `_currentschema_sql` use for a decorated class method
 * (`unsupported_args`'s returned wrapper expects a `(generator, expression)`-shaped
 * function, not a bound `this.method`).
 */
const _into_sql = unsupported_args("unlogged", "expressions")((self, expression) => {
  if (expression.args.temporary) {
    // If the Into expression has a temporary property, push this down to the Identifier
    const table = expression.find(exp.Table);
    if (table && table.this instanceof exp.Identifier) table.this.set("temporary", true);
  }

  return `${self.seg("INTO")} ${self.sql(expression, "this")}`;
});
