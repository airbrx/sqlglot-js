// py: sqlglot/generators/exasol.py @ 91119bc — WHOLE FILE (963 LOC), AIR-2289 (epic
// AIR-2272, "12.4 Exasol").
//
// `class ExasolGenerator(generator.Generator)` — lands in the same round as
// `dialects/exasol.py` (`src/dialects/exasol.js`) and `parsers/exasol.py`
// (`src/parsers/exasol.js`), the same "full stack in one round" shape R38 (Redshift)
// and R103 (Presto) used. Self-contained: extends the base `Generator` directly
// rather than sitting in a subclass chain.
//
// SHARED HELPERS ALREADY AVAILABLE
// -------------------------------------------------------------------------
// `dialects/dialect.js` already carries every cross-dialect helper this file imports
// (`groupconcat_sql`, `no_last_day_sql`, `rename_func`, `strposition_sql`,
// `timestrtotime_sql`, `timestamptrunc_sql`). `generator.js` already carries
// `unsupported_args` (R27's own precedent). `optimizer/scope.js`'s `buildScope`/
// `findInScope` (Tier A, already real since R46) cover this file's `build_scope`/
// `find_in_scope` calls (`_qualify_unscoped_star`, `_group_by_all`). No new
// base-helper work was required for this round.
//
// `jsonextract_sql` and `regexplike_sql` (py:933, py:944) have no base-`Generator`
// counterpart at all upstream either — the per-class prototype walk `_buildDispatch`
// (`generator.js`) performs picks up any method named `<classname.toLowerCase()>_sql`
// with no base registration needed, same shape R104's own MySQL round found for ten
// of its own methods.

import * as exp from "../expressions/index.js";
import {
  Generator,
  unsupported_args,
  AFTER_HAVING_MODIFIER_TRANSFORMS as BASE_AFTER_HAVING_MODIFIER_TRANSFORMS,
} from "../generator.js";
import {
  groupconcat_sql,
  no_last_day_sql,
  rename_func,
  strposition_sql,
  timestrtotime_sql,
  timestamptrunc_sql,
} from "../dialects/dialect.js";
import { buildScope, findInScope } from "../optimizer/scope.js";
import { DATE_UNITS } from "../parsers/exasol.js";
import { UnsupportedError } from "../errors.js";

/** py: sqlglot/generators/exasol.py:22 `_sha2_sql(self, expression)`. */
function _sha2_sql(self, expression) {
  const length = expression.text("length");
  const func_name = length === "256" ? "HASH_SHA256" : "HASH_SHA512";
  return self.func(func_name, expression.this);
}

/** py: sqlglot/generators/exasol.py:28 `_date_diff_sql(self, expression)`. */
function _date_diff_sql(self, expression) {
  const unit = (expression.text("unit").toUpperCase()) || "DAY";

  if (!DATE_UNITS.has(unit)) {
    self.unsupported(`'${unit}' is not supported in Exasol.`);
    return self.function_fallback_sql(expression);
  }

  return self.func(`${unit}S_BETWEEN`, expression.this, expression.expression);
}

/**
 * py: sqlglot/generators/exasol.py:39 `_add_local_prefix_for_aliases(expression,
 * dialect)`.
 *
 * https://docs.exasol.com/db/latest/sql/select.htm#:~:text=If%20you%20have,local.x%3E10
 */
function _add_local_prefix_for_aliases(expression, dialect) {
  const _key = (ident) => dialect.normalize_identifier(ident.copy()).this;

  if (expression instanceof exp.Select) {
    const aliases = new Map();
    for (const sel of expression.selects) {
      if (sel instanceof exp.Alias) {
        const alias = sel.args.alias;
        if (alias) aliases.set(_key(alias), alias);
      }
    }

    const table = expression.find(exp.Table);
    const table_ident = table ? table.this : null;

    if (
      table_ident
      && table_ident.name.toUpperCase() === "LOCAL"
      && !table_ident.args.quoted
    ) {
      table_ident.replace(exp.toIdentifier(table_ident.name.toUpperCase(), true));
    }

    const prefix_local = (node, visible_aliases) => {
      if (node instanceof exp.Column && !node.table) {
        const alias = visible_aliases.get(_key(node.this));
        if (alias !== undefined && alias !== null) {
          return new exp.Column({ this: alias, table: exp.toIdentifier("LOCAL", false) });
        }
      }
      return node;
    };

    for (const key of ["where", "group", "having"]) {
      const arg = expression.args[key];
      if (arg) expression.set(key, arg.transform((node) => prefix_local(node, aliases)));
    }

    const seen_aliases = new Map();
    const new_selects = [];
    for (const sel of expression.selects) {
      if (sel instanceof exp.Alias) {
        const inner = sel.this.transform((node) => prefix_local(node, seen_aliases));
        sel.set("this", inner);

        const alias_node = sel.args.alias;
        if (alias_node) seen_aliases.set(_key(alias_node), alias_node);
        new_selects.push(sel);
      } else {
        new_selects.push(sel.transform((node) => prefix_local(node, seen_aliases)));
      }
    }
    expression.set("expressions", new_selects);
  }

  return expression;
}

/** py: sqlglot/generators/exasol.py:91 `_trunc_sql(self, kind, expression)`. */
function _trunc_sql(self, kind, expression) {
  const unit_expr = expression.args.unit;
  const unit = unit_expr instanceof exp.WeekStart
    ? self.weekstart_name(unit_expr)
    : expression.text("unit");
  const node = expression.this instanceof exp.Cast ? expression.this.this : expression.this;
  let expr_sql = self.sql(node);
  if (node instanceof exp.Literal && node.isString) {
    // deny:implicit_str sqlglot/generators/exasol.py:106 — static analysis flags
    // `node.this` conservatively (`.this` COULD be an Expr in general), but `node` is
    // already confirmed `instanceof exp.Literal` on the line above, and `Literal.this`
    // (expressions/core.py) is always the raw Python/JS string value, never a child
    // Expr; `.replace("T", " ")` on the TIMESTAMP branch above only type-checks at all
    // because this is a plain string, so no `.sql()` call belongs here either.
    expr_sql = kind === "TIMESTAMP"
      ? `${kind} '${node.this.replace("T", " ")}'`
      : `DATE '${node.this}'`;
  }
  return `DATE_TRUNC('${unit}', ${expr_sql})`;
}

/** py: sqlglot/generators/exasol.py:111 `_date_trunc_sql(self, expression)`. */
function _date_trunc_sql(self, expression) {
  return _trunc_sql(self, "DATE", expression);
}

/** py: sqlglot/generators/exasol.py:115 `_timestamp_trunc_sql(self, expression)`. */
function _timestamp_trunc_sql(self, expression) {
  return _trunc_sql(self, "TIMESTAMP", expression);
}

/** py: sqlglot/generators/exasol.py:121 `is_case_insensitive(node)`. */
function is_case_insensitive(node) {
  return node instanceof exp.Collate && node.text("expression").toUpperCase() === "UTF8_LCASE";
}

/** py: sqlglot/generators/exasol.py:125 `_substring_index_sql(self, expression)`. */
function _substring_index_sql(self, expression) {
  const this_ = expression.this;
  const delimiter = expression.args.delimiter;
  const count_node = expression.args.count;
  const count_sql = self.sql(expression, "count");
  const num = count_node.isNumber ? count_node.toPy() : 0;

  const haystack_sql = self.sql(this_);
  if (num === 0) {
    return self.func("SUBSTR", haystack_sql, "1", "0");
  }

  const from_right = num < 0;
  const direction = from_right ? "-1" : "1";
  const occur = from_right ? self.func("ABS", count_sql) : count_sql;

  const delimiter_sql = self.sql(delimiter);

  const position = self.func(
    "INSTR",
    is_case_insensitive(this_) ? self.func("LOWER", haystack_sql) : haystack_sql,
    is_case_insensitive(delimiter) ? self.func("LOWER", delimiter_sql) : delimiter_sql,
    direction,
    occur,
  );
  const nullable_pos = self.func("NULLIF", position, "0");

  if (from_right) {
    const start = self.func(
      "NVL", `${nullable_pos} + ${self.func("LENGTH", delimiter_sql)}`, direction,
    );
    return self.func("SUBSTR", haystack_sql, start);
  }

  const length = self.func("NVL", `${nullable_pos} - 1`, self.func("LENGTH", haystack_sql));
  return self.func("SUBSTR", haystack_sql, direction, length);
}

/**
 * py: sqlglot/generators/exasol.py:162 `_qualify_unscoped_star(expression)`.
 *
 * Exasol doesn't support a bare * alongside other select items, so we rewrite it
 * Rewrite: SELECT *, <other> FROM <Table>
 * Into: SELECT T.*, <other> FROM <Table> AS T
 *
 * https://docs.exasol.com/db/latest/sql/select.htm#:~:text=The%20select_list%20defines%20the%20columns%20of%20the%20result%20table.%20If%20*%20is%20used%2C%20all%20columns%20are%20listed.%20You%20can%20use%20an%20expression%20like%20t.*%20to%20list%20all%20columns%20of%20the%20table%20t%2C%20the%20view%20t%2C%20or%20the%20object%20with%20the%20table%20alias%20t.
 */
function _qualify_unscoped_star(expression) {
  if (!(expression instanceof exp.Select)) return expression;

  const select_expressions = expression.expressions || [];

  const is_bare_star = (expr) => expr instanceof exp.Star && (expr.this === null || expr.this === undefined);

  let has_other_expression = false;
  let bare_star_expr = null;
  for (const expr of select_expressions) {
    const has_bare_star = is_bare_star(expr);
    if (has_bare_star && bare_star_expr === null) {
      bare_star_expr = expr;
    } else if (!has_bare_star) {
      has_other_expression = true;
    }
    if (bare_star_expr && has_other_expression) break;
  }

  if (!(bare_star_expr && has_other_expression)) return expression;

  const scope = buildScope(expression);

  if (!scope || !scope.selectedSources.size) return expression;

  const table_identifiers = [];

  for (const [source_name, [source_expr]] of scope.selectedSources) {
    const ident = source_expr instanceof exp.Table && source_expr.this instanceof exp.Identifier
      ? source_expr.this.copy()
      : exp.toIdentifier(source_name);
    table_identifiers.push(ident);
  }

  const qualified_star_columns = table_identifiers.map((ident) =>
    new exp.Column({ this: bare_star_expr.copy(), table: ident }));

  const new_select_expressions = [];

  for (const select_expr of select_expressions) {
    if (is_bare_star(select_expr)) new_select_expressions.push(...qualified_star_columns);
    else new_select_expressions.push(select_expr);
  }

  expression.set("expressions", new_select_expressions);
  return expression;
}

/** py: sqlglot/generators/exasol.py:221 `_add_date_sql(self, expression)`. */
function _add_date_sql(self, expression) {
  const interval = expression.expression instanceof exp.Interval ? expression.expression : null;

  const unit = (interval !== null
    ? (interval.text("unit") || "DAY")
    : (expression.text("unit") || "DAY")).toUpperCase();

  if (!DATE_UNITS.has(unit)) {
    self.unsupported(`'${unit}' is not supported in Exasol.`);
    return self.function_fallback_sql(expression);
  }

  let offset_expr = expression.expression;
  if (interval !== null) {
    offset_expr = interval.this;
  }

  if (expression instanceof exp.DateSub) {
    offset_expr = new exp.Neg({ this: offset_expr });
  }

  return self.func(`ADD_${unit}S`, expression.this, offset_expr);
}

/** py: sqlglot/generators/exasol.py:244 `_group_by_all(expression)`. */
function _group_by_all(expression) {
  if (!(expression instanceof exp.Select)) return expression;

  const group = expression.args.group;
  if (!group || !group.args.all) return expression;

  if (expression.isStar) {
    if (expression.expressions.some((proj) => findInScope(proj, exp.AggFunc))) {
      throw new UnsupportedError(
        "GROUP BY ALL with star projection and aggregates is not supported by Exasol",
      );
    }
    expression.set("distinct", new exp.Distinct({}));
    expression.set("group", null);
    return expression;
  }

  const group_positions = [];
  expression.expressions.forEach((proj, i) => {
    if (!findInScope(proj, exp.AggFunc)) group_positions.push(exp.Literal.number(i + 1));
  });

  if (!group_positions.length) {
    expression.set("group", null);
    return expression;
  }

  group.set("expressions", group_positions);
  group.set("all", null);

  return expression;
}

/** py: sqlglot/generators/exasol.py:277 `class ExasolGenerator(generator.Generator)`. */
export class ExasolGenerator extends Generator {
  static SELECT_KINDS = [];
  static TRY_SUPPORTED = false;
  static SUPPORTS_UESCAPE = false;
  static SUPPORTS_DECODE_CASE = false;

  /**
   * py:283 `AFTER_HAVING_MODIFIER_TRANSFORMS = generator.AFTER_HAVING_MODIFIER_TRANSFORMS`
   * — the MODULE-level 2-entry dict (`windows`, `qualify`), not the base `Generator`
   * CLASS attribute (which is a superset adding `cluster`/`distribute`/`sort`). This
   * really does narrow what the base class supports; see this file's own PORT_PLAN
   * entry for a found-but-unfixed divergence in four OTHER dialects that read the
   * wrong one of these two.
   */
  static AFTER_HAVING_MODIFIER_TRANSFORMS = BASE_AFTER_HAVING_MODIFIER_TRANSFORMS;

  // https://docs.exasol.com/db/latest/sql_references/data_types/datatypedetails.htm#StringDataType
  static STRING_TYPE_MAPPING = new Map([
    [exp.DType.BLOB, "VARCHAR"],
    [exp.DType.LONGBLOB, "VARCHAR"],
    [exp.DType.LONGTEXT, "VARCHAR"],
    [exp.DType.MEDIUMBLOB, "VARCHAR"],
    [exp.DType.MEDIUMTEXT, "VARCHAR"],
    [exp.DType.TINYBLOB, "VARCHAR"],
    [exp.DType.TINYTEXT, "VARCHAR"],
    // https://docs.exasol.com/db/latest/sql_references/data_types/datatypealiases.htm
    [exp.DType.TEXT, "LONG VARCHAR"],
    [exp.DType.VARBINARY, "VARCHAR"],
  ]);

  // https://docs.exasol.com/db/latest/sql_references/data_types/datatypealiases.htm
  static TYPE_MAPPING = new Map([
    ...Generator.TYPE_MAPPING,
    ...ExasolGenerator.STRING_TYPE_MAPPING,
    [exp.DType.TINYINT, "SMALLINT"],
    [exp.DType.MEDIUMINT, "INT"],
    [exp.DType.DECIMAL32, "DECIMAL"],
    [exp.DType.DECIMAL64, "DECIMAL"],
    [exp.DType.DECIMAL128, "DECIMAL"],
    [exp.DType.DECIMAL256, "DECIMAL"],
    [exp.DType.DATETIME, "TIMESTAMP"],
    [exp.DType.TIMESTAMPTZ, "TIMESTAMP"],
    [exp.DType.TIMESTAMPLTZ, "TIMESTAMP"],
    [exp.DType.TIMESTAMPNTZ, "TIMESTAMP"],
  ]);

  /** py:315 */
  select_sql(expression) {
    let processed = _qualify_unscoped_star(expression);
    processed = _add_local_prefix_for_aliases(processed, this.dialect);
    processed = _group_by_all(processed);
    return super.select_sql(processed);
  }

  /** py:321 */
  datatype_sql(expression) {
    // Exasol supports a fixed default precision of 3 for TIMESTAMP WITH LOCAL TIME ZONE
    // and does not allow specifying a different custom precision
    if (expression.isType(exp.DType.TIMESTAMPLTZ)) {
      return "TIMESTAMP WITH LOCAL TIME ZONE";
    }

    return super.datatype_sql(expression);
  }

  static TRANSFORMS = new Map([
    ...Generator.TRANSFORMS,
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/every.htm
    [exp.All, rename_func("EVERY")],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/bit_and.htm
    [exp.BitwiseAnd, rename_func("BIT_AND")],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/bit_or.htm
    [exp.BitwiseOr, rename_func("BIT_OR")],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/bit_not.htm
    [exp.BitwiseNot, rename_func("BIT_NOT")],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/bit_lshift.htm
    [exp.BitwiseLeftShift, rename_func("BIT_LSHIFT")],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/bit_rshift.htm
    [exp.BitwiseRightShift, rename_func("BIT_RSHIFT")],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/bit_xor.htm
    [exp.BitwiseXor, rename_func("BIT_XOR")],
    [exp.CurrentSchema, () => "CURRENT_SCHEMA"],
    [exp.DateDiff, _date_diff_sql],
    [exp.DateAdd, _add_date_sql],
    [exp.TsOrDsAdd, _add_date_sql],
    [exp.DateSub, _add_date_sql],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/div.htm#DIV
    [exp.IntDiv, rename_func("DIV")],
    [exp.TsOrDsDiff, _date_diff_sql],
    [exp.DateTrunc, _date_trunc_sql],
    [exp.DayOfWeek, (self, e) => `CAST(TO_CHAR(${self.sql(e, "this")}, 'D') AS INTEGER)`],
    [exp.DatetimeTrunc, timestamptrunc_sql()],
    [exp.GroupConcat, (self, e) => groupconcat_sql(self, e, { on_overflow: true })],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/edit_distance.htm#EDIT_DISTANCE
    [exp.Levenshtein, unsupported_args("ins_cost", "del_cost", "sub_cost", "max_dist")(
      rename_func("EDIT_DISTANCE"),
    )],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/mod.htm
    [exp.Mod, rename_func("MOD")],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/from_posix_time.htm
    [exp.UnixToTime, (self, e) => self.func("FROM_POSIX_TIME", e.this)],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/rank.htm
    [exp.Rank, unsupported_args("expressions")(() => "RANK()")],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/dense_rank.htm
    [exp.DenseRank, unsupported_args("expressions")(() => "DENSE_RANK()")],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/regexp_substr.htm
    [exp.RegexpExtract, unsupported_args("parameters", "group")(rename_func("REGEXP_SUBSTR"))],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/regexp_replace.htm
    [exp.RegexpReplace, unsupported_args("modifiers")(rename_func("REGEXP_REPLACE"))],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/var_pop.htm
    [exp.VariancePop, rename_func("VAR_POP")],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/approximate_count_distinct.htm
    [exp.ApproxDistinct, unsupported_args("accuracy")(rename_func("APPROXIMATE_COUNT_DISTINCT"))],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/to_char%20(datetime).htm
    [exp.TimeToStr, (self, e) => self.func("TO_CHAR", e.this, self.format_time(e))],
    [exp.ToChar, (self, e) => self.func("TO_CHAR", e.this, self.format_time(e))],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/to_date.htm
    [exp.TsOrDsToDate, (self, e) => self.func("TO_DATE", e.this, self.format_time(e))],
    [exp.TimeStrToTime, timestrtotime_sql],
    [exp.TimestampTrunc, _timestamp_trunc_sql],
    [exp.StrToTime, (self, e) => self.func("TO_DATE", e.this, self.format_time(e))],
    [exp.CurrentUser, () => "CURRENT_USER"],
    [exp.AtTimeZone, (self, e) => self.func(
      "CONVERT_TZ",
      e.this,
      "'UTC'",
      e.args.zone,
    )],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/instr.htm
    [exp.StrPosition, (self, e) => strposition_sql(
      self, e, { func_name: "INSTR", supports_position: true, supports_occurrence: true },
    )],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/hash_sha%5B1%5D.htm#HASH_SHA%5B1%5D
    [exp.SHA, rename_func("HASH_SHA")],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/hash_sha256.htm
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/hash_sha512.htm
    [exp.SHA2, _sha2_sql],
    [exp.MD5, rename_func("HASH_MD5")],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/hashtype_md5.htm
    [exp.MD5Digest, rename_func("HASHTYPE_MD5")],
    // https://docs.exasol.com/db/latest/sql/create_view.htm
    [exp.CommentColumnConstraint, (self, e) => `COMMENT IS ${self.sql(e, "this")}`],
    [exp.SubstringIndex, _substring_index_sql],
    [exp.WeekOfYear, rename_func("WEEK")],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/to_date.htm
    [exp.Date, rename_func("TO_DATE")],
    // https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/to_timestamp.htm
    [exp.Timestamp, rename_func("TO_TIMESTAMP")],
    [exp.Quarter, (self, e) => `CEIL(MONTH(TO_DATE(${self.sql(e, "this")}))/3)`],
    [exp.LastDay, no_last_day_sql],
  ]);

  // https://docs.exasol.com/db/7.1/sql_references/system_tables/metadata/exa_sql_keywords.htm
  static RESERVED_KEYWORDS = new Set([
    "absolute", "action", "add", "after", "all", "allocate", "alter", "and", "any",
    "append", "are", "array", "as", "asc", "asensitive", "assertion", "at",
    "attribute", "authid", "authorization", "before", "begin", "between", "bigint",
    "binary", "bit", "blob", "blocked", "bool", "boolean", "both", "by", "byte",
    "call", "called", "cardinality", "cascade", "cascaded", "case", "casespecific",
    "cast", "catalog", "chain", "char", "character", "character_set_catalog",
    "character_set_name", "character_set_schema", "characteristics", "check",
    "checked", "clob", "close", "coalesce", "collate", "collation",
    "collation_catalog", "collation_name", "collation_schema", "column", "commit",
    "condition", "connect_by_iscycle", "connect_by_isleaf", "connect_by_root",
    "connection", "constant", "constraint", "constraint_state_default",
    "constraints", "constructor", "contains", "continue", "control", "convert",
    "corresponding", "create", "cs", "csv", "cube", "current", "current_cluster",
    "current_cluster_uid", "current_date", "current_path", "current_role",
    "current_schema", "current_session", "current_statement", "current_time",
    "current_timestamp", "current_user", "cursor", "cycle", "data", "datalink",
    "datetime_interval_code", "datetime_interval_precision", "day", "dbtimezone",
    "deallocate", "dec", "decimal", "declare", "default",
    "default_like_escape_character", "deferrable", "deferred", "defined",
    "definer", "delete", "deref", "derived", "desc", "describe", "descriptor",
    "deterministic", "disable", "disabled", "disconnect", "dispatch", "distinct",
    "dlurlcomplete", "dlurlpath", "dlurlpathonly", "dlurlscheme", "dlurlserver",
    "dlvalue", "do", "domain", "double", "drop", "dynamic", "dynamic_function",
    "dynamic_function_code", "each", "else", "elseif", "elsif", "emits", "enable",
    "enabled", "end", "end-exec", "endif", "enforce", "equals", "errors", "escape",
    "except", "exception", "exec", "execute", "exists", "exit", "export",
    "external", "extract", "false", "fbv", "fetch", "file", "final", "first",
    "float", "following", "for", "forall", "force", "format", "found", "free",
    "from", "fs", "full", "function", "general", "generated", "geometry", "get",
    "global", "go", "goto", "grant", "granted", "group", "group_concat",
    "grouping", "groups", "hashtype", "hashtype_format", "having", "high", "hold",
    "hour", "identity", "if", "ifnull", "immediate", "impersonate",
    "implementation", "import", "in", "index", "indicator", "inner", "inout",
    "input", "insensitive", "insert", "instance", "instantiable", "int",
    "integer", "integrity", "intersect", "interval", "into", "inverse", "invoker",
    "is", "iterate", "join", "key_member", "key_type", "large", "last", "lateral",
    "ldap", "leading", "leave", "left", "level", "like", "limit", "listagg",
    "localtime", "localtimestamp", "locator", "log", "longvarchar", "loop", "low",
    "map", "match", "matched", "merge", "method", "minus", "minute", "mod",
    "modifies", "modify", "module", "month", "names", "national", "natural",
    "nchar", "nclob", "new", "next", "nls_date_format", "nls_date_language",
    "nls_first_day_of_week", "nls_numeric_characters", "nls_timestamp_format",
    "no", "nocycle", "nologging", "none", "not", "null", "nullif", "number",
    "numeric", "nvarchar", "nvarchar2", "object", "of", "off", "old", "on",
    "only", "open", "option", "options", "or", "order", "ordering", "ordinality",
    "others", "out", "outer", "output", "over", "overlaps", "overlay",
    "overriding", "pad", "parallel_enable", "parameter",
    "parameter_specific_catalog", "parameter_specific_name",
    "parameter_specific_schema", "parquet", "partial", "path", "permission",
    "placing", "plus", "preceding", "preferring", "prepare", "preserve", "prior",
    "privileges", "procedure", "profile", "qualify", "random", "range", "read",
    "reads", "real", "recovery", "recursive", "ref", "references", "referencing",
    "refresh", "regexp_like", "relative", "release", "rename", "repeat",
    "replace", "restore", "restrict", "result", "return", "returned_length",
    "returned_octet_length", "returns", "revoke", "right", "rollback", "rollup",
    "routine", "row", "rows", "rowtype", "savepoint", "schema", "scope",
    "scope_user", "script", "scroll", "search", "second", "section", "security",
    "select", "selective", "self", "sensitive", "separator", "sequence",
    "session", "session_user", "sessiontimezone", "set", "sets", "shortint",
    "similar", "smallint", "some", "source", "space", "specific", "specifictype",
    "sql", "sql_bigint", "sql_bit", "sql_char", "sql_date", "sql_decimal",
    "sql_double", "sql_float", "sql_integer", "sql_longvarchar", "sql_numeric",
    "sql_preprocessor_script", "sql_real", "sql_smallint", "sql_timestamp",
    "sql_tinyint", "sql_type_date", "sql_type_timestamp", "sql_varchar",
    "sqlexception", "sqlstate", "sqlwarning", "start", "state", "statement",
    "static", "structure", "style", "substring", "subtype", "sysdate", "system",
    "system_user", "systimestamp", "table", "temporary", "text", "then", "time",
    "timestamp", "timezone_hour", "timezone_minute", "tinyint", "to", "trailing",
    "transaction", "transform", "transforms", "translation", "treat", "trigger",
    "trim", "true", "truncate", "under", "union", "unique", "unknown", "unlink",
    "unnest", "until", "update", "usage", "user", "using", "value", "values",
    "varchar", "varchar2", "varray", "verify", "view", "when", "whenever",
    "where", "while", "window", "with", "within", "without", "work", "year",
    "yes", "zone",
  ]);

  /** py:885 */
  converttimezone_sql(expression) {
    const from_tz = expression.args.source_tz;
    const to_tz = expression.args.target_tz;
    const datetime = expression.args.timestamp;
    const options = expression.args.options;

    return this.func("CONVERT_TZ", datetime, from_tz, to_tz, options);
  }

  /** py:893 */
  if_sql(expression) {
    const this_ = this.sql(expression, "this");
    const true_ = this.sql(expression, "true");
    const false_ = this.sql(expression, "false");
    return `IF ${this_} THEN ${true_} ELSE ${false_} ENDIF`;
  }

  // https://docs.exasol.com/db/latest/sql/open_schema.htm
  /** py:900 */
  use_sql(expression) {
    const kind = expression.args.kind;
    if (kind && this.sql(kind).toUpperCase() !== "SCHEMA") {
      this.unsupported(`'USE ${this.sql(kind)}' is not supported in Exasol`);
      return super.use_sql(expression);
    }
    const this_ = this.sql(expression, "this");
    return `OPEN SCHEMA ${this_}`;
  }

  // https://docs.exasol.com/db/latest/sql_references/metadata/metadata_system_tables.htm
  /** py:909 */
  show_sql(expression) {
    if (expression.name === "TABLES") {
      const db_name = expression.text("db");
      const schema_filter = db_name
        ? exp.Literal.string(db_name.toUpperCase())
        : new exp.CurrentSchema({});
      const select = exp.select(exp.column("TABLE_NAME"))
        .from_(exp.table_("EXA_ALL_TABLES", { db: "SYS" }))
        .where(exp.column("TABLE_SCHEMA").eq(schema_filter));
      return this.sql(select);
    }

    if (expression.name === "DATABASES") {
      const select = exp.select(exp.column("SCHEMA_NAME"))
        .from_(exp.table_("EXA_SCHEMAS", { db: "SYS" }));
      return this.sql(select);
    }

    return super.show_sql(expression);
  }

  /** py:930 */
  collate_sql(expression) {
    return this.sql(expression.this);
  }

  /** py:933 */
  jsonextract_sql(expression) {
    const sql = this.func(
      "JSON_EXTRACT", expression.this, expression.expression, ...expression.expressions,
    );

    const emits = this.sql(expression, "emits");
    if (emits) {
      return `${sql} EMITS ${emits}`;
    }

    return sql;
  }

  /** py:944 `@unsupported_args("flag") def regexplike_sql(self, expression)`. */
  regexplike_sql(expression) {
    return _regexplike_sql(this, expression);
  }
}

/** py:944 `@unsupported_args("flag") def regexplike_sql(self, expression)`. */
const _regexplike_sql = unsupported_args("flag")((self, expression) => {
  if (!expression.args.full_match) {
    const pattern = expression.expression;
    if (pattern.isString) {
      expression.set("expression", exp.Literal.string(`.*${pattern.name}.*`));
    } else {
      expression.set(
        "expression",
        new exp.Paren({
          this: new exp.Concat({
            expressions: [
              exp.Literal.string(".*"),
              pattern,
              exp.Literal.string(".*"),
            ],
          }),
        }),
      );
    }
  }
  return self.binary(expression, "REGEXP_LIKE");
});
