// py: sqlglot/generators/sqlite.py @ 91119bc — WHOLE FILE (379 LOC, 21 methods), AIR-2291.
//
// `class SQLiteGenerator(generator.Generator)` — the WRITE-side SQLite grammar,
// landing alongside `parsers/sqlite.py` (read side) and `dialects/sqlite.py`
// (settings) in this same round, PORT_PLAN.md R38's "full stack in one round"
// shape. SQLite is standalone (`extends Generator` directly), same as
// Presto/MySQL/ClickHouse — no subclass chain. No `typing/sqlite.py` exists
// upstream, so `EXPRESSION_METADATA` is left undeclared on `SQLite` (the dialect
// class) and resolves through ordinary JS static-field inheritance to the base
// `Dialect.EXPRESSION_METADATA`, same shape `dialects/doris.js`'s own header
// documents for its `MySQL`-derived case.

import * as exp from "../expressions/index.js";
import { Generator, unsupported_args } from "../generator.js";
import {
  any_value_to_max_sql,
  arrow_json_extract_sql,
  concat_to_dpipe_sql,
  count_if_to_sum,
  no_ilike_sql,
  no_pivot_sql,
  no_tablesample_sql,
  no_trycast_sql,
  rename_func,
  strposition_sql,
} from "../dialects/dialect.js";
import * as transforms from "../transforms.js";
import { findInScope } from "../optimizer/scope.js";
import { TokenType } from "../tokens.js";

/** py: sqlglot/generators/sqlite.py:23. "Move primary key to a column and enforce auto_increment on primary keys." */
function _transform_create(expression) {
  const schema = expression.this;

  if (expression instanceof exp.Create && schema instanceof exp.Schema) {
    const defs = {};
    let primary_key = null;

    for (const e of schema.expressions) {
      if (e instanceof exp.ColumnDef) defs[e.name] = e;
      else if (e instanceof exp.PrimaryKey) primary_key = e;
    }

    if (primary_key && primary_key.expressions.length === 1) {
      const column = defs[primary_key.expressions[0].name];
      column.append("constraints", new exp.ColumnConstraint({ kind: new exp.PrimaryKeyColumnConstraint() }));
      const idx = schema.args.expressions.findIndex((x) => x.equals(primary_key));
      schema.args.expressions.splice(idx, 1);
    }

    for (const column of Object.values(defs)) {
      let primary_key_index = -1;
      let auto_increment = null;
      let auto_increment_index = -1;

      const constraints = column.constraints;
      for (let i = 0; i < constraints.length; i++) {
        const constraint = constraints[i];
        if (constraint.kind instanceof exp.PrimaryKeyColumnConstraint) primary_key_index = i;
        else if (constraint.kind instanceof exp.AutoIncrementColumnConstraint) {
          auto_increment = constraint;
          auto_increment_index = i;
        }
      }

      if (auto_increment !== null && (primary_key_index === -1 || auto_increment_index < primary_key_index)) {
        constraints.splice(auto_increment_index, 1);
        if (primary_key_index !== -1) constraints.splice(primary_key_index, 0, auto_increment);
      }
    }
  }

  return expression;
}

/** py: sqlglot/generators/sqlite.py:66 */
function _generated_to_auto_increment(expression) {
  if (!(expression instanceof exp.ColumnDef)) return expression;

  const generated = expression.find(exp.GeneratedAsIdentityColumnConstraint);

  // Only rewrite true identity columns. Expression-bearing forms are computed
  // columns (GENERATED ALWAYS AS (expr)) and must keep their expression.
  //
  // py: `generated.expression is None` — when the field was never set, this port's
  // `Expr.expression` getter reads `undefined` (a plain JS object property), not
  // `null`, so the check below is deliberately `== null` (loose), not `=== null`.
  if (generated && generated.expression == null) {
    generated.parent.pop();

    const not_null = expression.find(exp.NotNullColumnConstraint);
    if (not_null) not_null.parent.pop();

    expression.append("constraints", new exp.ColumnConstraint({ kind: new exp.AutoIncrementColumnConstraint() }));
  }

  return expression;
}

/** py: sqlglot/generators/sqlite.py:88 */
function _offset_to_limit(expression) {
  if (!(expression instanceof exp.Select)) return expression;

  const offset = expression.args.offset;

  if (offset && !expression.args.limit) expression.limit(-1, { copy: false });

  return expression;
}

/** py: sqlglot/generators/sqlite.py:100 */
export class SQLiteGenerator extends Generator {
  static SELECT_KINDS = [];
  static TRY_SUPPORTED = false;
  static SUPPORTS_UESCAPE = false;
  static SUPPORTS_DECODE_CASE = false;

  static AFTER_HAVING_MODIFIER_TRANSFORMS = Generator.AFTER_HAVING_MODIFIER_TRANSFORMS;

  static JOIN_HINTS = false;
  static TABLE_HINTS = false;
  static QUERY_HINTS = false;
  static NVL2_SUPPORTED = false;
  static JSON_PATH_BRACKETED_KEY_SUPPORTED = false;
  static SUPPORTS_CREATE_TABLE_LIKE = false;
  static SUPPORTS_TABLE_ALIAS_COLUMNS = false;
  static SUPPORTS_TO_NUMBER = false;
  static SUPPORTS_WINDOW_EXCLUDE = true;
  static EXCEPT_INTERSECT_SUPPORT_ALL_CLAUSE = false;
  static SUPPORTS_MEDIAN = false;
  static JSON_KEY_VALUE_PAIR_SEP = ",";
  static PARSE_JSON_NAME = null;

  static SUPPORTED_JSON_PATH_PARTS = new Set([exp.JSONPathKey, exp.JSONPathRoot, exp.JSONPathSubscript]);

  /** py:128-144 */
  static TYPE_MAPPING = new Map([
    ...[...Generator.TYPE_MAPPING].filter(([k]) => k !== exp.DType.BLOB),
    [exp.DType.BOOLEAN, "INTEGER"],
    [exp.DType.TINYINT, "INTEGER"],
    [exp.DType.SMALLINT, "INTEGER"],
    [exp.DType.INT, "INTEGER"],
    [exp.DType.BIGINT, "INTEGER"],
    [exp.DType.FLOAT, "REAL"],
    [exp.DType.DOUBLE, "REAL"],
    [exp.DType.DECIMAL, "REAL"],
    [exp.DType.CHAR, "TEXT"],
    [exp.DType.NCHAR, "TEXT"],
    [exp.DType.VARCHAR, "TEXT"],
    [exp.DType.NVARCHAR, "TEXT"],
    [exp.DType.BINARY, "BLOB"],
    [exp.DType.VARBINARY, "BLOB"],
  ]);

  /** py:146-148 */
  static TOKEN_MAPPING = new Map([[TokenType.AUTO_INCREMENT, "AUTOINCREMENT"]]);

  /** py:150-191 */
  static TRANSFORMS = new Map([
    ...Generator.TRANSFORMS,
    [exp.AnyValue, any_value_to_max_sql],
    [exp.Chr, rename_func("CHAR")],
    [exp.Concat, concat_to_dpipe_sql],
    [exp.CountIf, count_if_to_sum],
    [exp.Create, transforms.preprocess([_transform_create])],
    [exp.CurrentDate, () => "CURRENT_DATE"],
    [exp.CurrentTime, () => "CURRENT_TIME"],
    [exp.CurrentTimestamp, () => "CURRENT_TIMESTAMP"],
    [exp.CurrentVersion, () => "SQLITE_VERSION()"],
    [exp.ColumnDef, transforms.preprocess([_generated_to_auto_increment])],
    [exp.DateStrToDate, (self, e) => self.sql(e, "this")],
    [exp.If, rename_func("IIF")],
    [exp.ILike, no_ilike_sql],
    [
      exp.JSONArrayAgg,
      unsupported_args("order", "null_handling", "return_type", "strict")(rename_func("JSON_GROUP_ARRAY")),
    ],
    [exp.JSONObjectAgg, (self, e) => self._jsonobject_sql(e, "JSON_GROUP_OBJECT")],
    [exp.Levenshtein, unsupported_args("ins_cost", "del_cost", "sub_cost", "max_dist")(rename_func("EDITDIST3"))],
    [exp.LogicalOr, rename_func("MAX")],
    [exp.LogicalAnd, rename_func("MIN")],
    [exp.Pivot, no_pivot_sql],
    [exp.Rand, rename_func("RANDOM")],
    [exp.RegexpLike, (self, e) => self.binary(e, "REGEXP")],
    [
      exp.Select,
      transforms.preprocess([
        _offset_to_limit,
        transforms.eliminate_distinct_on,
        transforms.eliminate_qualify,
        transforms.eliminate_semi_and_anti_joins,
      ]),
    ],
    [exp.StrPosition, (self, e) => strposition_sql(self, e, { func_name: "INSTR" })],
    [exp.TableSample, no_tablesample_sql],
    [exp.TimeStrToTime, (self, e) => self.sql(e, "this")],
    [exp.TimeToStr, (self, e) => self.func("STRFTIME", e.args.format, e.this)],
    [exp.TryCast, no_trycast_sql],
    [exp.TsOrDsToTimestamp, (self, e) => self.sql(e, "this")],
  ]);

  // SQLite doesn't generally support CREATE TABLE .. properties
  // https://www.sqlite.org/lang_createtable.html
  /** py:195-206 */
  static PROPERTIES_LOCATION = new Map([
    ...[...Generator.PROPERTIES_LOCATION].map(([k]) => [k, exp.Properties.Location.UNSUPPORTED]),
    // There are a few exceptions (e.g. temporary tables) which are supported or
    // can be transpiled to SQLite, so we explicitly override them accordingly
    [exp.LikeProperty, exp.Properties.Location.POST_SCHEMA],
    [exp.ModuleProperty, exp.Properties.Location.POST_SCHEMA],
    [exp.TemporaryProperty, exp.Properties.Location.POST_CREATE],
    [exp.VirtualProperty, exp.Properties.Location.POST_CREATE],
  ]);

  static LIMIT_FETCH = "LIMIT";

  /** py:210-215 */
  insert_sql(expression) {
    if (expression.args.ignore) {
      expression.set("ignore", false);
      expression.set("alternative", "IGNORE");
    }

    return super.insert_sql(expression);
  }

  /** py:217-219 */
  bitwiseandagg_sql(expression) {
    this.unsupported("BITWISE_AND aggregation is not supported in SQLite");
    return this.function_fallback_sql(expression);
  }

  /** py:221-223 */
  bitwiseoragg_sql(expression) {
    this.unsupported("BITWISE_OR aggregation is not supported in SQLite");
    return this.function_fallback_sql(expression);
  }

  /** py:225-227 */
  bitwisexoragg_sql(expression) {
    this.unsupported("BITWISE_XOR aggregation is not supported in SQLite");
    return this.function_fallback_sql(expression);
  }

  /** py:229-232 */
  jsonextract_sql(expression) {
    if (expression.expressions.length) return this.function_fallback_sql(expression);
    return arrow_json_extract_sql(this, expression);
  }

  /** py:234-239 */
  jsonextractscalar_sql(expression) {
    if (expression.args.json_subtype) {
      // json_extract() keeps the JSON subtype on object/array results;
      // ->> strips it, observable when the result feeds another JSON function
      return this.func("JSON_EXTRACT", expression.this, expression.expression);
    }
    return arrow_json_extract_sql(this, expression);
  }

  /** py:241-251 */
  dateadd_sql(expression) {
    let modifier = expression.expression;
    let unit = expression.args.unit;
    // An INTERVAL amount carries its own unit, e.g. DATE_ADD(d, INTERVAL 1 DAY);
    // unwrap it so the unit is not left inside the quoted modifier string.
    if (modifier instanceof exp.Interval) {
      unit = unit || modifier.unit;
      modifier = modifier.this;
    }
    modifier = modifier.is_string ? modifier.name : this.sql(modifier);
    modifier = unit ? `'${modifier} ${unit.name}'` : `'${modifier}'`;
    return this.func("DATE", expression.this, modifier);
  }

  /** py:253-257 */
  cast_sql(expression, safe_prefix = null) {
    if (expression.isType("date")) return this.func("DATE", expression.this);

    return super.cast_sql(expression, safe_prefix);
  }

  /**
   * py:259-270. https://www.sqlite.org/gencol.html
   *
   * Inline unsupported check: mypyc cannot compile @unsupported_args on an
   * override of an undecorated base-class method.
   */
  computedcolumnconstraint_sql(expression) {
    if (expression.args.data_type) this.unsupported("SQLite generated columns do not support a data type");

    const this_ = expression.this;
    const this_sql = this_ instanceof exp.Paren ? this.sql(this_) : `(${this.sql(this_)})`;
    const storage = expression.args.persisted ? " STORED" : "";
    const not_null = expression.args.not_null ? " NOT NULL" : "";
    return `AS ${this_sql}${storage}${not_null}`;
  }

  /**
   * py:272-278
   *
   * Note: SQLite's TRUNC always returns REAL (e.g., trunc(10.99) -> 10.0), not INTEGER.
   * This creates a transpilation gap affecting division semantics, similar to Presto.
   * Unlike Presto where this only affects decimals=0, SQLite has no decimals parameter
   * so every use of TRUNC is affected. Modeling precisely would require exp.FloatTrunc.
   */
  trunc_sql(expression) {
    return _trunc_sql(this, expression);
  }

  /** py:280-293 */
  generateseries_sql(expression) {
    const parent = expression.parent;
    const alias = parent && parent.args.alias;

    let sql;
    if (alias instanceof exp.TableAlias && alias.columns.length) {
      const column_alias = alias.columns[0];
      alias.set("columns", null);
      sql = this.sql(
        exp.select(exp.alias_("value", column_alias)).from_(expression).subquery(),
      );
    } else {
      sql = this.function_fallback_sql(expression);
    }

    return sql;
  }

  /** py:295-320 */
  datediff_sql(expression) {
    const unitExpr = expression.args.unit;
    const unit = unitExpr ? unitExpr.name.toUpperCase() : "DAY";

    let sql = `(JULIANDAY(${this.sql(expression, "this")}) - JULIANDAY(${this.sql(expression, "expression")}))`;

    if (unit === "MONTH") sql = `${sql} / 30.0`;
    else if (unit === "YEAR") sql = `${sql} / 365.0`;
    else if (unit === "HOUR") sql = `${sql} * 24.0`;
    else if (unit === "MINUTE") sql = `${sql} * 1440.0`;
    else if (unit === "SECOND") sql = `${sql} * 86400.0`;
    else if (unit === "MILLISECOND") sql = `${sql} * 86400000.0`;
    else if (unit === "MICROSECOND") sql = `${sql} * 86400000000.0`;
    else if (unit === "NANOSECOND") sql = `${sql} * 8640000000000.0`;
    else this.unsupported(`DATEDIFF unsupported for '${unit}'.`);

    return `CAST(${sql} AS INTEGER)`;
  }

  /** py:322-339. https://www.sqlite.org/lang_aggfunc.html#group_concat */
  groupconcat_sql(expression) {
    let this_ = expression.this;
    const distinct = findInScope(expression, exp.Distinct);

    let distinct_sql;
    if (distinct) {
      this_ = distinct.expressions[0];
      distinct_sql = "DISTINCT ";
    } else {
      distinct_sql = "";
    }

    if (expression.this instanceof exp.Order) {
      this.unsupported("SQLite GROUP_CONCAT doesn't support ORDER BY.");
      if (expression.this.this && !distinct) this_ = expression.this.this;
    }

    const separator = expression.args.separator;
    return `GROUP_CONCAT(${distinct_sql}${this.format_args(this_, separator)})`;
  }

  /** py:341-345 */
  least_sql(expression) {
    if (expression.expressions.length) return rename_func("MIN")(this, expression);

    return this.sql(expression, "this");
  }

  /** py:347-351 */
  greatest_sql(expression) {
    if (expression.expressions.length) return rename_func("MAX")(this, expression);

    return this.sql(expression, "this");
  }

  /** py:353-356 */
  transaction_sql(expression) {
    let this_ = expression.this;
    this_ = this_ ? ` ${this_}` : "";
    return `BEGIN${this_} TRANSACTION`;
  }

  /** py:358-359 */
  isascii_sql(expression) {
    return `(NOT ${this.sql(expression.this)} GLOB CAST(x'2a5b5e012d7f5d2a' AS TEXT))`;
  }

  /** py:361-363 */
  currentschema_sql(expression) {
    return _currentschema_sql(this, expression);
  }

  /** py:365-367 */
  ignorenulls_sql(expression) {
    this.unsupported("SQLite does not support IGNORE NULLS.");
    return this.sql(expression.this);
  }

  /** py:369-370 */
  respectnulls_sql(expression) {
    return this.sql(expression.this);
  }

  /** py:372-379 */
  windowspec_sql(expression) {
    if (expression.text("kind").toUpperCase() === "RANGE" && expression.text("start").toUpperCase() === "CURRENT ROW") {
      return "RANGE CURRENT ROW";
    }

    return super.windowspec_sql(expression);
  }
}

/** py:276-278 `@unsupported_args("decimals") def trunc_sql(self, expression)`. */
const _trunc_sql = unsupported_args("decimals")((self, expression) => self.func("TRUNC", expression.this));

/** py:361-363 `@unsupported_args("this") def currentschema_sql(self, expression)`. */
const _currentschema_sql = unsupported_args("this")(() => "'main'");
