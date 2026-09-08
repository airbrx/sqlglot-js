// py: sqlglot/dialects/dialect.py @ 91119bc — MODULE-LEVEL BUILDERS ONLY.
//
// Scope, deliberately narrow
// --------------------------
// The `Dialect` class itself is P5. This file holds only the module-level *builder
// functions* that the ported `sqlglot/parsers/*.py` subclasses import at their top —
// the ones that appear as values inside a parser's `FUNCTIONS` / `TYPE_CONVERTERS` and
// are therefore hard dependencies of the parser subclass, not of the dialect settings
// class. Upstream keeps them in `dialects/dialect.py`, so this file mirrors that
// location rather than inventing a new home; when P5 ports the `Dialect` class it
// lands in this same file next to them.
//
// Members are added here strictly on demand, one per importing parser: `snowflake.js`
// established the first set; `hive.js` adds `build_regexp_extract`, `spark2.js` adds
// `pivot_column_names`, and `spark.js`/`databricks.js` add `build_date_delta`. A
// helper that is genuinely specific to ONE dialect belongs in that dialect's own file
// instead — all four of these are in upstream's shared `dialects/dialect.py`, imported
// by several dialects each, so they belong here.
//
// Nothing here resolves a dialect by NAME (CONTRACTS.md §8). Every function that needs
// dialect state takes an already-resolved dialect object, exactly as upstream's
// `_builder(args, dialect)` signature does. The single exception is `map_date_part`'s
// default argument, which upstream itself defines as the BASE `Dialect` class
// (`def map_date_part(part, dialect: DialectType = Dialect)`) — that is not a fallback
// for a missing dialect, it is the documented default, and it is reproduced by
// consulting the base `DATE_PART_MAPPING` literal below rather than by any lookup.
//
// @ported-ranges sqlglot/dialects/dialect.py 858-953 1610-1637 1654-1674 1700-1706 1892-1914 1916-1920 1925-1963 2167-2176 2384-2394 2462-2474 2477-2497 2604-2617 2620-2625
//
// One range per member ported, so `tools/lint_deny.mjs` measures this file against
// what it actually claims rather than against all 2,600 lines of `dialects/dialect.py`
// (the directive exists for exactly this: a file that deliberately ports part of an
// upstream module). Every deny-listed site in that file -- py_builtins:1179,
// operators:1375/1782, implicit_str:1815/2547 -- falls outside these ranges today; when
// P5 ports the surrounding code the range list grows and the lint starts demanding
// their markers.

import { seqGet, suggestClosestMatchAndFail, toBool } from "../helper.js";
import { NotPorted, ParseError } from "../errors.js";
import { cpSlice, pyIsLower, pyIsPrintable, pyIsUpper, pyUpper } from "../_py/str.js";
import { pyIntFromStr } from "../_py/num.js";
import { PyTypeError, PyValueError } from "../_py/errors.js";
import { pyTruthy } from "../_py/truthy.js";
import { formatTime } from "../time.js";
import { newTrie } from "../trie.js";
import { TokenType, Tokenizer, initTokenizerSubclass, setDialectResolver } from "../tokens.js";
import { BaseParser } from "../parsers/base.js";
import * as exp from "../expressions/index.js";
import { SAFE_IDENTIFIER_RE, registerAstDialects, registerGenerator, registerParser } from "../expressions/core.js";

/**
 * py: sqlglot/optimizer/annotate_types.py — NOT PORTED.
 *
 * `build_trunc` and `build_timetostr_or_tochar` call it to decide date-vs-numeric
 * truncation and TimeToStr-vs-ToChar from the ANNOTATED type of an argument. The type
 * annotator is a separate upstream module (P6+) with its own scope; there is no honest
 * partial answer here, so the two call sites announce themselves as stubs rather than
 * guessing a type and silently building the wrong node.
 */
function annotate_types(_expression, _dialect) {
  throw new NotPorted("annotate_types", "sqlglot/optimizer/annotate_types.py");
}

/** py: sqlglot/dialects/dialect.py:1916 */
export function binary_from_function(expr_type) {
  return (args) => new expr_type({ this: seqGet(args, 0), expression: seqGet(args, 1) });
}

/**
 * py: sqlglot/dialects/dialect.py:1610
 *
 * `dialect_override` is a dialect NAME upstream (`Dialect[dialect_override]`), which
 * §8 forbids resolving here. No caller in `parsers/snowflake.py` passes it, so the
 * parameter is accepted and rejected rather than silently ignored.
 */
export function build_formatted_time(exp_class, dialect_override = null, default_ = null) {
  return function _builder(args, dialect) {
    if (typeof dialect_override === "string") {
      throw new NotPorted(
        `build_formatted_time(dialect_override=${JSON.stringify(dialect_override)})`,
        "sqlglot/dialects/dialect.py:1624",
      );
    }
    const target_dialect = dialect;

    let fmt = seqGet(args, 1);
    if (!fmt) fmt = default_ === true ? target_dialect.TIME_FORMAT : default_ || null;

    return new exp_class({ this: seqGet(args, 0), format: target_dialect.format_time(fmt) });
  };
}

/** py: sqlglot/dialects/dialect.py:1654 */
export function build_date_delta(
  exp_class,
  unit_mapping = null,
  default_unit = "DAY",
  supports_timezone = false,
) {
  return function _builder(args) {
    const unit_based = args.length >= 3;
    const has_timezone = args.length === 4;
    const this_ = unit_based ? args[2] : seqGet(args, 0);
    let unit = null;
    if (unit_based || default_unit) {
      unit = unit_based ? args[0] : exp.Literal.string(default_unit);
      // py: `unit_mapping.get(unit.name.lower(), unit.name)` — dict.get with a default.
      if (unit_mapping) {
        const key = unit.name.toLowerCase();
        unit = exp.var_(unit_mapping.has(key) ? unit_mapping.get(key) : unit.name);
      }
    }
    const expression = new exp_class({ this: this_, expression: seqGet(args, 1), unit });
    if (supports_timezone && has_timezone) expression.set("zone", args[args.length - 1]);
    return expression;
  };
}

/**
 * py: sqlglot/dialects/dialect.py:1892
 *
 * The non-`Alias` branch renders each aggregation back to SQL (`agg.sql(dialect=...,
 * normalize_functions="lower")`), which needs the full `Generator` — a P7 component,
 * not the minimal kernel this phase has. `Spark2Parser._pivot_column_names` short-
 * circuits to `[]` for the single-aggregation case before ever reaching here, so the
 * reachable-today path is the `Alias` one; anything else announces itself rather than
 * approximating a rendered name.
 */
export function pivot_column_names(aggregations, dialect) {
  const names = [];
  for (const agg of aggregations) {
    if (agg instanceof exp.Alias) {
      names.push(agg.alias);
    } else {
      throw new NotPorted(
        "pivot_column_names(non-Alias aggregation)",
        "sqlglot/dialects/dialect.py:1912 Expr.sql",
      );
    }
  }

  return names;
}

/** py: sqlglot/dialects/dialect.py:2477 */
export function build_regexp_extract(expr_type) {
  return function _builder(args, dialect) {
    // The "position" argument specifies the index of the string character to start matching from.
    // `null_if_pos_overflow` reflects the dialect's behavior when position is greater than the string
    // length. If true, returns NULL. If false, returns an empty string. `null_if_pos_overflow` is
    // only needed for exp.RegexpExtract - exp.RegexpExtractAll always returns an empty array if
    // position overflows.
    const kwargs = {
      this: seqGet(args, 0),
      expression: seqGet(args, 1),
      group: seqGet(args, 2) || exp.Literal.number(dialect.REGEXP_EXTRACT_DEFAULT_GROUP),
      parameters: seqGet(args, 3),
    };
    if (expr_type === exp.RegexpExtract) {
      kwargs.null_if_pos_overflow = dialect.REGEXP_EXTRACT_POSITION_OVERFLOW_RETURNS_NULL;
    }
    return new expr_type(kwargs);
  };
}

/** py: sqlglot/dialects/dialect.py:1700 */
export function date_trunc_to_time(args) {
  const unit = seqGet(args, 0);
  const this_ = seqGet(args, 1);

  if (this_ instanceof exp.Cast && this_.isType("date")) {
    return new exp.DateTrunc({ unit, this: this_ });
  }
  return new exp.TimestampTrunc({ this: this_, unit });
}

/** py: sqlglot/dialects/dialect.py:1925 */
export function build_trunc(args, dialect, options = {}) {
  const {
    date_trunc_unabbreviate = true,
    default_date_trunc_unit = null,
    date_trunc_requires_part = true,
    fractions_supported = false,
  } = options;

  let this_ = seqGet(args, 0);
  let second = seqGet(args, 1);

  if (this_ && !this_.type) this_ = annotate_types(this_, dialect);
  if (second && !second.type) second = annotate_types(second, dialect);

  // Date truncation
  if (
    (this_ && this_.isType(...exp.DataType.TEMPORAL_TYPES) && (second || default_date_trunc_unit))
    || (second && second.isType(...exp.DataType.TEXT_TYPES))
  ) {
    const unit = second || exp.Literal.string(default_date_trunc_unit);
    return new exp.DateTrunc({ this: this_, unit, unabbreviate: date_trunc_unabbreviate });
  }

  // Numeric truncation
  if (
    (this_ && this_.isType(...exp.DataType.NUMERIC_TYPES))
    || (second && second.isType(...exp.DataType.NUMERIC_TYPES))
    || (!date_trunc_requires_part && !second)
  ) {
    return new exp.Trunc({ this: this_, decimals: second, fractions_supported });
  }

  return new exp.Anonymous({ this: "TRUNC", expressions: args });
}

/** py: sqlglot/dialects/dialect.py:2384 */
export function build_default_decimal_type(precision = null, scale = null) {
  return function _builder(dtype) {
    if (pyTruthy(dtype.expressions) || precision === null) return dtype;

    const params = `${precision}${scale !== null ? `, ${scale}` : ""}`;
    return exp.DataType.fromStr(`DECIMAL(${params})`);
  };
}

/** py: sqlglot/dialects/dialect.py:2462 */
export function build_like(expr_type, not_like = false) {
  return function _builder(args) {
    let like_expr = new expr_type({ this: seqGet(args, 0), expression: seqGet(args, 1) });

    const escape = seqGet(args, 2);
    if (escape) like_expr = new exp.Escape({ this: like_expr, expression: escape });

    if (not_like) like_expr = new exp.Not({ this: like_expr });

    return like_expr;
  };
}

/** py: sqlglot/dialects/dialect.py:2604 */
export function build_timetostr_or_tochar(args, dialect) {
  if (args.length === 2) {
    const this_ = args[0];
    if (!this_.type) annotate_types(this_, dialect);

    if (this_.isType(...exp.DataType.TEMPORAL_TYPES)) {
      return build_formatted_time(exp.TimeToStr, null, true)(args, dialect);
    }
  }

  return exp.ToChar.from_arg_list(args);
}

/** py: sqlglot/dialects/dialect.py:2620 */
export function build_replace_with_optional_replacement(args) {
  return new exp.Replace({
    this: seqGet(args, 0),
    expression: seqGet(args, 1),
    replacement: seqGet(args, 2) || exp.Literal.string(""),
  });
}

/**
 * py: sqlglot/dialects/dialect.py:858 `Dialect.DATE_PART_MAPPING`.
 *
 * A `Map`, not a plain object, for the reason CONTRACTS.md §8 records for every other
 * lookup table in this port: `mapping["constructor"]` on a plain object returns
 * `Object.prototype.constructor`. Iteration order is upstream's insertion order.
 */
export const DATE_PART_MAPPING = new Map([
    ["Y", "YEAR"],
    ["YY", "YEAR"],
    ["YYY", "YEAR"],
    ["YYYY", "YEAR"],
    ["YR", "YEAR"],
    ["YEARS", "YEAR"],
    ["YRS", "YEAR"],
    ["MM", "MONTH"],
    ["MON", "MONTH"],
    ["MONS", "MONTH"],
    ["MONTHS", "MONTH"],
    ["D", "DAY"],
    ["DD", "DAY"],
    ["DAYS", "DAY"],
    ["DAYOFMONTH", "DAY"],
    ["DAY OF WEEK", "DAYOFWEEK"],
    ["WEEKDAY", "DAYOFWEEK"],
    ["DOW", "DAYOFWEEK"],
    ["DW", "DAYOFWEEK"],
    ["WEEKDAY_ISO", "DAYOFWEEKISO"],
    ["DOW_ISO", "DAYOFWEEKISO"],
    ["DW_ISO", "DAYOFWEEKISO"],
    ["DAYOFWEEK_ISO", "DAYOFWEEKISO"],
    ["DAY OF YEAR", "DAYOFYEAR"],
    ["DOY", "DAYOFYEAR"],
    ["DY", "DAYOFYEAR"],
    ["W", "WEEK"],
    ["WK", "WEEK"],
    ["WEEKOFYEAR", "WEEK"],
    ["WOY", "WEEK"],
    ["WY", "WEEK"],
    ["WEEK_ISO", "WEEKISO"],
    ["WEEKOFYEARISO", "WEEKISO"],
    ["WEEKOFYEAR_ISO", "WEEKISO"],
    ["Q", "QUARTER"],
    ["QTR", "QUARTER"],
    ["QTRS", "QUARTER"],
    ["QUARTERS", "QUARTER"],
    ["H", "HOUR"],
    ["HH", "HOUR"],
    ["HR", "HOUR"],
    ["HOURS", "HOUR"],
    ["HRS", "HOUR"],
    ["M", "MINUTE"],
    ["MI", "MINUTE"],
    ["MIN", "MINUTE"],
    ["MINUTES", "MINUTE"],
    ["MINS", "MINUTE"],
    ["S", "SECOND"],
    ["SEC", "SECOND"],
    ["SECONDS", "SECOND"],
    ["SECS", "SECOND"],
    ["MS", "MILLISECOND"],
    ["MSEC", "MILLISECOND"],
    ["MSECS", "MILLISECOND"],
    ["MSECOND", "MILLISECOND"],
    ["MSECONDS", "MILLISECOND"],
    ["MILLISEC", "MILLISECOND"],
    ["MILLISECS", "MILLISECOND"],
    ["MILLISECON", "MILLISECOND"],
    ["MILLISECONDS", "MILLISECOND"],
    ["US", "MICROSECOND"],
    ["USEC", "MICROSECOND"],
    ["USECS", "MICROSECOND"],
    ["MICROSEC", "MICROSECOND"],
    ["MICROSECS", "MICROSECOND"],
    ["USECOND", "MICROSECOND"],
    ["USECONDS", "MICROSECOND"],
    ["MICROSECONDS", "MICROSECOND"],
    ["NS", "NANOSECOND"],
    ["NSEC", "NANOSECOND"],
    ["NANOSEC", "NANOSECOND"],
    ["NSECOND", "NANOSECOND"],
    ["NSECONDS", "NANOSECOND"],
    ["NANOSECS", "NANOSECOND"],
    ["EPOCH_SECOND", "EPOCH"],
    ["EPOCH_SECONDS", "EPOCH"],
    ["EPOCH_MILLISECONDS", "EPOCH_MILLISECOND"],
    ["EPOCH_MICROSECONDS", "EPOCH_MICROSECOND"],
    ["EPOCH_NANOSECONDS", "EPOCH_NANOSECOND"],
    ["TZH", "TIMEZONE_HOUR"],
    ["TZM", "TIMEZONE_MINUTE"],
    ["DEC", "DECADE"],
    ["DECS", "DECADE"],
    ["DECADES", "DECADE"],
    ["MIL", "MILLENNIUM"],
    ["MILS", "MILLENNIUM"],
    ["MILLENIA", "MILLENNIUM"],
    ["C", "CENTURY"],
    ["CENT", "CENTURY"],
    ["CENTS", "CENTURY"],
    ["CENTURIES", "CENTURY"],
]);

/**
 * py: sqlglot/dialects/dialect.py:2167
 *
 * `dialect` defaults to the base `Dialect` upstream; `null` here means the same thing
 * and reads `DATE_PART_MAPPING` above. Note that every `FUNCTIONS` entry in
 * `parsers/snowflake.py` calls this WITHOUT a dialect (so it gets the base mapping)
 * while `_parse_date_part` passes `self.dialect` (so it gets Snowflake's). That
 * asymmetry is upstream's, and it is observable — Snowflake's mapping differs from the
 * base one in three entries — so it is reproduced rather than normalised away.
 */
export function map_date_part(part, dialect = null) {
  const mapping = dialect === null ? DATE_PART_MAPPING : dialect.DATE_PART_MAPPING;
  const mapped = part && !(part instanceof exp.Column && part.parts.length !== 1)
    ? mapping.get(pyUpper(part.name))
    : null;
  if (mapped) return part.isString ? exp.Literal.string(mapped) : exp.var(mapped);

  return part;
}

// ===========================================================================
// The `Dialect` class, the registry, and `registerDialect`            — P5
// ===========================================================================
//
// @ported-ranges sqlglot/dialects/dialect.py 68-83 85-166 168-361 363-1229
//
// Everything below is `sqlglot/dialects/dialect.py`'s `_Dialect` metaclass and the
// `Dialect` class it builds. The module-level builders above kept their own narrow
// scope note; this section is the component PORT_PLAN.md §7 P5 opens with, and it is
// what closes the two CONTRACTS.md §8 rows that name it: `Tokenizer.__init__`'s
// injected `setDialectResolver`, and the P3 probes' `parserClassFor` stand-in for a
// real registry.

/** py: sqlglot/dialects/dialect.py:68 */
export const UNESCAPED_SEQUENCES = new Map([
  // Written as JS escapes, never as raw bytes: PORT_PLAN.md §4.2's control-byte lint
  // exists because one literal \x07 in committed source makes `file`/`grep` classify
  // the whole file as binary, which silently neuters every grep-based fidelity check.
  // JS has no `\a`; BEL is spelled with an explicit \u0007 escape.
  ["\\a", "\u0007"],
  ["\\b", "\b"],
  ["\\f", "\f"],
  ["\\n", "\n"],
  ["\\r", "\r"],
  ["\\t", "\t"],
  ["\\v", "\v"],
  ["\\\\", "\\"],
]);

/**
 * py: sqlglot/dialects/dialect.py:85 `class Dialects(str, Enum)`.
 *
 * Values, not names, are the registry keys. `DIALECT = ""` is the base dialect, which
 * is why `get_or_raise("")` and `get_or_raise(null)` are the same call.
 */
export const Dialects = Object.freeze({
  DIALECT: "",
  ATHENA: "athena",
  BIGQUERY: "bigquery",
  CLICKHOUSE: "clickhouse",
  DATABRICKS: "databricks",
  DAX: "dax",
  DORIS: "doris",
  DREMIO: "dremio",
  DRILL: "drill",
  DRUID: "druid",
  DUCKDB: "duckdb",
  DUNE: "dune",
  FABRIC: "fabric",
  HIVE: "hive",
  MATERIALIZE: "materialize",
  MYSQL: "mysql",
  ORACLE: "oracle",
  POSTGRES: "postgres",
  PRESTO: "presto",
  PRQL: "prql",
  REDSHIFT: "redshift",
  RISINGWAVE: "risingwave",
  SNOWFLAKE: "snowflake",
  SOLR: "solr",
  SPARK: "spark",
  SPARK2: "spark2",
  SQLITE: "sqlite",
  STARROCKS: "starrocks",
  TABLEAU: "tableau",
  TERADATA: "teradata",
  TRINO: "trino",
  TSQL: "tsql",
  EXASOL: "exasol",
});

/**
 * py: sqlglot/dialects/__init__.py:104 `DIALECT_MODULE_NAMES`.
 *
 * Deliberately NOT derived from `Dialects` above: the two are not the same set.
 * `singlestore` is a module with no `Dialects` member, and `""` is a `Dialects` member
 * with no module. `get_or_raise` unions this with the live registry to build the
 * "Did you mean ...?" candidate set (py:1016), so the difference is observable in an
 * error message and cannot be normalised away.
 */
export const DIALECT_MODULE_NAMES = Object.freeze([
  "athena", "bigquery", "clickhouse", "databricks", "dax", "doris", "dremio",
  "drill", "druid", "duckdb", "dune", "exasol", "fabric", "hive", "materialize",
  "mysql", "oracle", "postgres", "presto", "prql", "redshift", "risingwave",
  "singlestore", "snowflake", "solr", "spark", "spark2", "sqlite", "starrocks",
  "tableau", "teradata", "trino", "tsql",
]);

/** py: sqlglot/dialects/dialect.py:124 `class NormalizationStrategy(str, AutoName)`. */
export const NormalizationStrategy = Object.freeze({
  LOWERCASE: "LOWERCASE",
  UPPERCASE: "UPPERCASE",
  CASE_SENSITIVE: "CASE_SENSITIVE",
  CASE_INSENSITIVE: "CASE_INSENSITIVE",
  CASE_INSENSITIVE_UPPERCASE: "CASE_INSENSITIVE_UPPERCASE",
});

/** py: sqlglot/dialects/dialect.py:148 */
export const STRICT_TIME_FORMATS = new Map([
  ["%mstrict", "%m"],
  ["%dstrict", "%d"],
  ["%Hstrict", "%H"],
  ["%Istrict", "%I"],
  ["%Mstrict", "%M"],
  ["%Sstrict", "%S"],
]);

/**
 * py: sqlglot/dialects/dialect.py:156
 *
 * Mutates and returns its argument exactly as upstream does. Both call sites pass a
 * freshly-built Map so the aliasing is not observable, but keeping the shape means a
 * future upstream diff reads straight across.
 */
function _with_strict_time_inverse(inverse_mapping) {
  for (const [strict_format, lax_format] of STRICT_TIME_FORMATS) {
    // py: dict.setdefault — writes only when the key is ABSENT. `??=` would also
    // overwrite a key whose value is legitimately null/undefined.
    if (inverse_mapping.has(strict_format)) {
      if (!inverse_mapping.has(lax_format)) {
        inverse_mapping.set(lax_format, inverse_mapping.get(strict_format));
      }
    } else {
      inverse_mapping.set(strict_format, inverse_mapping.get(lax_format) ?? lax_format);
    }
  }
  return inverse_mapping;
}

/**
 * py: sqlglot/dialects/dialect.py:169 `_Dialect._classes`.
 *
 * Keyed by the `Dialects` VALUE ("snowflake", and "" for the base dialect), which is
 * what `get_or_raise` is handed and what `corpus/ast/<dialect>.jsonl` is named after.
 */
const DIALECT_CLASSES = new Map();

/**
 * The same classes keyed by CLASS NAME rather than by registry key, which is the
 * `__dialect__` wire format `tools/astdump.py:111` emits (`type(node).__name__`).
 *
 * Handed to `registerAstDialects` ONCE, below, as a live reference: that function
 * stores the Map it is given, so `registerDialect`'s writes are visible to
 * `astDump`/`astLoad` without re-registering. Before P5 nothing ever called
 * `registerAstDialects`, so the registry stayed empty and both directions silently
 * degraded — the `astDump` side to `[object Object]`, the `astLoad` side to a raw
 * `{__dialect__}` object (PORT_PLAN.md R19: an exported hook with no caller).
 */
const DIALECT_CLASSES_BY_NAME = new Map();

/** py: `sys.maxsize` on the 64-bit interpreter that harvested the corpus. */
const MAXSIZE = 2n ** 63n - 1n;

/**
 * py: `str(value)` for the three types that can reach `__init__`'s version parse —
 * `to_bool` returns a bool or a str, and the `k=v=w` path leaves None.
 *
 * `String(true)` is "true", but Python's is "True", and that string is quoted verbatim
 * into the ValueError message `int()` then raises. Verified against CPython:
 * `Dialect.get_or_raise("duckdb, version=1")` raises
 * "invalid literal for int() with base 10: 'True'" — because `to_bool("1")` is `True`,
 * so asking for version 1 is an error rather than version (1, 0, 0).
 */
function _pyStr(v) {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  return String(v);
}

/**
 * py: sqlglot/dialects/dialect.py:363 `class Dialect(metaclass=_Dialect)`.
 *
 * READ THIS BEFORE ADDING A METHOD
 * -------------------------------
 * Every setting below is a JS `static`, and JS statics are **not** on the prototype.
 * `this.SOME_SETTING` inside an instance method is `undefined`, silently — the exact
 * bug that bit `src/parser.js` and `src/tokens.js` (PORT_PLAN.md R-series). Instance
 * methods here read `this.constructor.X`, never `this.X`. Python's `self.X` resolves
 * through the MRO to the class attribute, so `this.constructor.X` is the faithful
 * spelling AND the one that keeps subclass overrides working.
 *
 * Twenty-four of these defaults are falsy, so a setting that is merely MISSING reads
 * back `undefined` and behaves like Python for those twenty-four while flipping the
 * branch for the truthy ones. `spike/p5/fuzz_dialect_defaults.mjs` therefore diffs all
 * 105 against CPython rather than trusting a read of the upstream file, and it covers
 * the six the metaclass DERIVES (`VALID_INTERVAL_UNITS` is 116 entries at the base
 * dialect, not the empty set the class body shows).
 *
 * Dicts and sets are `Map`/`Set`, never plain objects — CONTRACTS.md §8's tokenizer
 * rows, for the same reason: `CREATABLE_KIND_MAPPING["constructor"]` on a plain object
 * returns `Object.prototype.constructor`. `src/parser.js` already reads these with
 * `.get()`/`.has()`, so this is also what makes the class drop-in for the harness's
 * `standInDialect`.
 */
export class Dialect {
  static INDEX_OFFSET = 0;
  static WEEK_OFFSET = 0;
  static UNNEST_COLUMN_ONLY = false;
  static ALIAS_POST_TABLESAMPLE = false;
  static TABLESAMPLE_SIZE_IS_PERCENT = false;
  static NORMALIZATION_STRATEGY = NormalizationStrategy.LOWERCASE;
  static ASCII_ONLY_NORMALIZATION = false;
  static IDENTIFIERS_CAN_START_WITH_DIGIT = false;
  static DPIPE_IS_STRING_CONCAT = true;
  static STRICT_STRING_CONCAT = false;
  static SUPPORTS_USER_DEFINED_TYPES = true;
  static SUPPORTS_COLUMN_JOIN_MARKS = false;
  static COPY_PARAMS_ARE_CSV = true;
  static NORMALIZE_FUNCTIONS = "upper";
  static PRESERVE_ORIGINAL_NAMES = false;
  static LOG_BASE_FIRST = true;
  static NULL_ORDERING = "nulls_are_small";
  static TYPED_DIVISION = false;
  static SAFE_DIVISION = false;
  static CONCAT_COALESCE = false;
  static CONCAT_WS_COALESCE = false;
  static HEX_LOWERCASE = false;
  static DATE_FORMAT = "'%Y-%m-%d'";
  static DATEINT_FORMAT = "'%Y%m%d'";
  static TIME_FORMAT = "'%Y-%m-%d %H:%M:%S'";
  static TIME_MAPPING = new Map();
  static FORMAT_MAPPING = new Map();
  static UNESCAPED_SEQUENCES = new Map();
  static STRINGS_SUPPORT_ESCAPED_SEQUENCES = false;
  static BYTE_STRINGS_SUPPORT_ESCAPED_SEQUENCES = false;
  static INVERSE_VECTOR_TYPE_ALIASES = new Map();
  static PSEUDOCOLUMNS = new Set();
  static SUPPORTS_POSITIONAL_COLUMN_REFS = false;
  static PREFER_CTE_ALIAS_COLUMN = false;
  static FORCE_EARLY_ALIAS_REF_EXPANSION = false;
  static EXPAND_ONLY_GROUP_ALIAS_REF = false;
  static ANNOTATE_ALL_SCOPES = false;
  static DISABLES_ALIAS_REF_EXPANSION = false;
  static SUPPORTS_ALIAS_REFS_IN_JOIN_CONDITIONS = false;
  static SUPPORTS_ORDER_BY_ALL = false;
  static SUPPORTS_LIMIT_ALL = false;
  static PROJECTION_ALIASES_SHADOW_SOURCE_NAMES = false;
  static TABLES_REFERENCEABLE_AS_COLUMNS = false;
  static SUPPORTS_STRUCT_STAR_EXPANSION = false;
  static STAR_ILIKE_BACKSLASH_ESCAPE = false;
  static EXCLUDES_PSEUDOCOLUMNS_FROM_STAR = false;
  static QUERY_RESULTS_ARE_STRUCTS = false;
  static REQUIRES_PARENTHESIZED_STRUCT_ACCESS = false;
  static SUPPORTS_NULL_TYPE = false;
  static COALESCE_COMPARISON_NON_STANDARD = false;
  static HAS_DISTINCT_ARRAY_CONSTRUCTORS = false;
  static SUPPORTS_FIXED_SIZE_ARRAYS = false;
  static STRICT_JSON_PATH_SYNTAX = true;
  static JSON_PATH_SINGLE_DOT_IS_WILDCARD = false;
  static ON_CONDITION_EMPTY_BEFORE_ERROR = true;
  static ARRAY_AGG_INCLUDES_NULLS = true;
  static ARRAY_FUNCS_PROPAGATES_NULLS = false;
  static PROMOTE_TO_INFERRED_DATETIME_TYPE = false;
  static SUPPORTS_VALUES_DEFAULT = true;
  static NUMBERS_CAN_BE_UNDERSCORE_SEPARATED = false;
  static HEX_STRING_IS_INTEGER_TYPE = false;
  static REGEXP_EXTRACT_DEFAULT_GROUP = 0;
  static REGEXP_EXTRACT_POSITION_OVERFLOW_RETURNS_NULL = true;
  static SET_OP_DISTINCT_BY_DEFAULT = new Map([
    [exp.Except, true],
    [exp.Intersect, true],
    [exp.Union, true],
  ]);
  static CREATABLE_KIND_MAPPING = new Map();
  static ALTER_TABLE_SUPPORTS_CASCADE = false;
  static ALTER_TABLE_ADD_REQUIRED_FOR_EACH_COLUMN = true;
  static TRY_CAST_REQUIRES_STRING = null;
  static SAFE_TO_ELIMINATE_DOUBLE_NEGATION = true;
  static NORMALIZE_NOT_NULL = true;
  static INITCAP_SUPPORTS_CUSTOM_DELIMITERS = true;
  // py:773. `\\-` and `\\[`/`\\]` are literal backslash-plus-char in the Python source
  // (it is a plain string, not a regex), so the JS spelling doubles them the same way.
  static INITCAP_DEFAULT_DELIMITER_CHARS =
    " \t\n\r\f\v!\"#$%&'()*+,\\-./:;<=>?@\\[\\]^_`{|}~";
  static BYTE_STRING_IS_BYTES_TYPE = false;
  static UUID_IS_STRING_TYPE = false;
  static JSON_EXTRACT_SCALAR_SCALAR_ONLY = false;
  static DEFAULT_FUNCTIONS_COLUMN_NAMES = new Map();
  static DEFAULT_NULL_TYPE = exp.DType.UNKNOWN;
  static LEAST_GREATEST_IGNORES_NULLS = true;
  static PRIORITIZE_NON_LITERAL_TYPES = false;
  static ALIAS_POST_VERSION = true;

  // --- Autofilled --- (py:820)
  //
  // All four are overwritten by `registerDialect`, which is this port's spelling of
  // `_Dialect.__new__`. The declarations are kept because upstream keeps them and
  // because `parser_class` is the one the metaclass falls THROUGH to (py:298 reads
  // `klass.__dict__.get("parser_class", ...)`), so removing it would silently change
  // which parser the default dialect uses.
  static tokenizer_class = Tokenizer;
  /**
   * py:823 `jsonpath_tokenizer_class = JSONPathTokenizer`.
   *
   * `sqlglot/jsonpath.py` is unported (P4). Left null rather than aliased to the SQL
   * `Tokenizer`: the two have different `SINGLE_TOKENS`/`KEYWORDS`, so aliasing would
   * hand `to_json_path` a scanner that lexes JSON paths as SQL and produce wrong
   * output instead of an error. `jsonpath_tokenizer()` throws on it.
   */
  static jsonpath_tokenizer_class = null;
  /**
   * py:824 `parser_class = BaseParser`.
   *
   * NOT `parser.Parser`. Upstream has two: `sqlglot/parser.py`'s `Parser` (which every
   * `parsers/<dialect>.py` subclasses) and `sqlglot/parsers/base.py`'s `BaseParser`,
   * used by exactly one thing — the DEFAULT dialect. `BaseParser` adds four
   * `NO_PAREN_FUNCTIONS` entries and drops `STRAIGHT_JOIN` from two token sets, so
   * pointing this at `Parser` parses `SELECT LOCALTIME` as a `Column` where CPython
   * gives `Localtime()`. `spike/out/dialect_defaults.json` records which class upstream
   * picked precisely so this cannot be got wrong by reading the name.
   */
  static parser_class = BaseParser;
  /** py:825 `generator_class = Generator`. P4; see `generate()`. */
  static generator_class = null;

  // A trie of the time_mapping keys
  static TIME_TRIE = new Map();
  static FORMAT_TRIE = new Map();

  static INVERSE_TIME_MAPPING = new Map();
  static INVERSE_TIME_TRIE = new Map();
  static INVERSE_FORMAT_MAPPING = new Map();
  static INVERSE_FORMAT_TRIE = new Map();

  static INVERSE_CREATABLE_KIND_MAPPING = new Map();

  static ESCAPED_SEQUENCES = new Map();

  // Delimiters for string literals and identifiers
  static QUOTE_START = "'";
  static QUOTE_END = "'";
  static IDENTIFIER_START = '"';
  static IDENTIFIER_END = '"';

  static VALID_INTERVAL_UNITS = new Set();

  // Delimiters for bit, hex, byte and unicode literals
  static BIT_START = null;
  static BIT_END = null;
  static HEX_START = null;
  static HEX_END = null;
  static BYTE_START = null;
  static BYTE_END = null;
  static UNICODE_START = null;
  static UNICODE_END = null;

  /** py:858 — the same Map the module-level builders above already share. */
  static DATE_PART_MAPPING = DATE_PART_MAPPING;

  // Specifies what types a given type can be coerced into
  static COERCES_TO = new Map();

  /**
   * py:957 `EXPRESSION_METADATA = EXPRESSION_METADATA.copy()`.
   *
   * Upstream's is `sqlglot/optimizer/annotate_types.py`'s 294-entry type-inference and
   * validation table. That module is unported (P6+) — the same gap the
   * `annotate_types` stub at the top of this file announces. Empty here, and
   * `spike/p5/fuzz_dialect_defaults.mjs` asserts the CPython side is 294 and prints
   * the difference on every run, so the hole is a number in the probe output rather
   * than an attribute nobody remembers is missing (PORT_PLAN.md R19: a table with no
   * reader is invisible to every structural sweep).
   */
  static EXPRESSION_METADATA = new Map();

  // Determines the supported Dialect instance settings
  static SUPPORTED_SETTINGS = new Set(["normalization_strategy", "version"]);

  /**
   * py: sqlglot/dialects/dialect.py:254 `_Dialect.get`.
   *
   * Upstream's metaclass calls `_try_load(key)` first, which does
   * `importlib.import_module(f"sqlglot.dialects.{key}")` ON DEMAND. That is the one
   * construct in this file that cannot be ported at all: JS dynamic `import()` is
   * async and a synchronous method cannot await it — the same wall CONTRACTS.md §8
   * already records for `Tokenizer.__init__`. `registerDialect` replaces it (see that
   * function's own note), so this is a plain registry read.
   */
  static get(key, default_ = null) {
    return DIALECT_CLASSES.has(key) ? DIALECT_CLASSES.get(key) : default_;
  }

  /**
   * py: sqlglot/dialects/dialect.py:966
   *
   * Look up a dialect in the global dialect registry and return it if it exists.
   *
   * `dialect` may be a name, optionally followed by comma-separated `k = v` settings
   * pairs — `Dialect.get_or_raise("mysql, normalization_strategy = case_sensitive")`.
   *
   * @param {string|Dialect|typeof Dialect|null|undefined} dialect
   * @returns {Dialect}
   */
  static get_or_raise(dialect) {
    // py: `if not dialect` — the falsy inputs that reach here are None and "".
    if (dialect === null || dialect === undefined || dialect === "") return new this();
    // py: `isinstance(dialect, _Dialect)` — the argument is a Dialect *class*.
    if (typeof dialect === "function" && (dialect === Dialect || dialect.prototype instanceof Dialect)) {
      return new dialect();
    }
    if (dialect instanceof Dialect) return dialect;
    if (typeof dialect === "string") {
      let dialect_name;
      const kwargs = {};
      try {
        const parts = dialect.split(",");
        dialect_name = parts[0];
        const kv_strings = parts.slice(1);
        for (const kv of kv_strings) {
          const pair = kv.split("=");
          const key = pair[0].trim();
          let value = null;

          if (pair.length === 1) {
            // Default initialize standalone settings to True
            value = true;
          } else if (pair.length === 2) {
            value = pair[1].trim();
          }
          // py: `len(pair) > 2` leaves `value` at None, which `__init__` then feeds to
          // `str(None).split(".")` -> `int("None")`. Verified against CPython:
          // "duckdb, version=1=2" raises "invalid literal for int() with base 10:
          // 'None'", NOT the "Invalid dialect format" message below.
          kwargs[key] = toBool(value);
        }
      } catch (e) {
        if (!(e instanceof PyValueError)) throw e;
        throw new PyValueError(
          `Invalid dialect format: '${dialect}'. ` +
            "Please use the correct format: 'dialect [, k1 = v2 [, ...]]'.",
        );
      }

      const result = this.get(dialect_name.trim());
      if (!result) {
        // Include both built-in dialects and any loaded dialects for better error messages
        const all_dialects = new Set([...DIALECT_MODULE_NAMES, ...DIALECT_CLASSES.keys()]);
        // py: the message uses the UNSTRIPPED name even though the lookup strips it.
        suggestClosestMatchAndFail("dialect", dialect_name, all_dialects);
      }

      return new result(kwargs);
    }

    throw new PyValueError(
      `Invalid dialect type for '${dialect}': '${dialect?.constructor?.name ?? typeof dialect}'.`,
    );
  }

  /**
   * py: sqlglot/dialects/dialect.py:1025 — a `@classmethod`.
   *
   * Converts a time format in this dialect to its equivalent Python `strftime` format.
   *
   * Kept static to match upstream, but a Python classmethod is also reachable through
   * an INSTANCE (`self.format_time(...)`) and a JS static is not — `instance.format_time`
   * is plain `undefined`. `build_formatted_time` above calls it on an instance, so the
   * instance-side bridge below is not optional; see it for the rest of the note.
   */
  static format_time(expression) {
    if (typeof expression === "string") {
      return exp.Literal.string(
        // the time formats are quoted. Sliced by CODE POINT (PORT_PLAN.md §4.6).
        formatTime(cpSlice(expression, 1, -1), this.TIME_MAPPING, this.TIME_TRIE),
      );
    }

    if (expression && expression.isString) {
      return exp.Literal.string(formatTime(expression.this, this.TIME_MAPPING, this.TIME_TRIE));
    }

    return expression;
  }

  /**
   * DEVIATION (CONTRACTS.md §8): a Python `@classmethod` is callable on an instance;
   * a JS `static` is not. `build_formatted_time`'s `_builder` and every
   * `FUNCTIONS["TO_DATE"]`-style entry call `dialect.format_time(fmt)` where `dialect`
   * is the resolved INSTANCE, so without this bridge those call sites would read
   * `undefined` and throw "is not a function" — at runtime, on the parse path, only
   * for dialects with a non-empty `TIME_MAPPING`.
   */
  format_time(expression) {
    return this.constructor.format_time(expression);
  }

  /**
   * py: sqlglot/dialects/dialect.py:1038 `__init__`.
   *
   * DEVIATION: Python's `**kwargs` becomes one trailing options object, the same
   * precedent as `helper.csv` and `TokenizerCore.__init__` in CONTRACTS.md §8.
   */
  constructor(kwargs = {}) {
    // py: `kwargs.pop(...)` REMOVES the key, so neither `version` nor
    // `normalization_strategy` survives into `self.settings`.
    const opts = { ...kwargs };

    let parts;
    if ("version" in opts) {
      parts = _pyStr(opts.version).split(".");
      delete opts.version;
    } else {
      parts = [String(MAXSIZE)];
    }
    // py: `parts.extend(["0"] * (3 - len(parts)))` — a NEGATIVE count yields [], so a
    // four-part version keeps its first three rather than being rejected.
    for (let i = parts.length; i < 3; i++) parts.push("0");
    this.version = parts.slice(0, 3).map((p) => {
      // py: int(p) — BigInt, not Number: the default is 2**63-1, which is not
      // representable exactly as a JS Number. Keeping BigInt means `version` is exact
      // and P8's `compareVersion` does not need the "non-2^63 sentinel" §7 P8
      // anticipated having to invent.
      const n = pyIntFromStr(p);
      if (n === null) throw new PyValueError(`invalid literal for int() with base 10: '${p}'`);
      return n;
    });

    const normalization_strategy = "normalization_strategy" in opts ? opts.normalization_strategy : null;
    delete opts.normalization_strategy;
    if (normalization_strategy === null) {
      this.normalization_strategy = this.constructor.NORMALIZATION_STRATEGY;
    } else {
      // py: `NormalizationStrategy(normalization_strategy.upper())` — `.upper()` on a
      // non-string is an AttributeError upstream, and an unknown member is a
      // ValueError. Both are reproduced rather than coerced.
      if (typeof normalization_strategy !== "string") {
        throw new PyTypeError(
          `'${_pyStr(normalization_strategy)}' object has no attribute 'upper'`,
        );
      }
      const name = pyUpper(normalization_strategy);
      if (!Object.hasOwn(NormalizationStrategy, name)) {
        throw new PyValueError(`'${name}' is not a valid NormalizationStrategy`);
      }
      this.normalization_strategy = NormalizationStrategy[name];
    }

    this.settings = opts;

    for (const unsupported_setting of Object.keys(opts)) {
      if (this.constructor.SUPPORTED_SETTINGS.has(unsupported_setting)) continue;
      suggestClosestMatchAndFail("setting", unsupported_setting, this.constructor.SUPPORTED_SETTINGS);
    }
  }

  /**
   * py: sqlglot/dialects/dialect.py:1054 `__eq__` — "does not currently take dialect
   * state into account", i.e. `type(self) == other`.
   *
   * DEVIATION: JS has no operator overloading, so this is a named method. It is the
   * same treatment `Expr.eq`-style relations already get; nothing in `src/` compares
   * dialects yet, and `dialectEquals` (PORT_PLAN.md §7 P5) is the caller-facing form
   * that still has to land with the optimizer that needs it.
   */
  equals(other) {
    if (this.constructor === other) return true;
    // py: `_Dialect.__eq__` is the reflected side — a class compares equal to its own
    // registry NAME and to any instance of itself.
    if (typeof other === "string") return this.constructor === Dialect.get(other);
    if (other instanceof Dialect) return this.constructor === other.constructor;
    return false;
  }

  /** py: sqlglot/dialects/dialect.py:1058 `__hash__` — `hash(type(self))`. */
  hash() {
    return this.constructor;
  }

  /**
   * py: sqlglot/dialects/dialect.py:1062
   *
   * NOT PORTED, deliberately, and announced rather than approximated. The body needs
   * Python `str.lower()`, and `src/_py/str.js` has `pyUpper` but no `pyLower`:
   * `String.prototype.toLowerCase` is bound to the ENGINE's Unicode version, which
   * PORT_PLAN.md §4.6 measures at 67 code points of disagreement with the harvesting
   * interpreter, and identifier normalization is directly output-visible. Writing it
   * with `toLowerCase()` would pass every corpus row (0.024% non-ASCII) and be wrong —
   * the `too_wide`/R4 hazard class exactly. `pyLower` is a `_py/` addition with its own
   * differential gate, not something to slip in here.
   *
   * No caller exists in `src/` today (`grep normalize_identifier src/` is empty); it is
   * the optimizer's and the generator's entry point, so P4/P6 is when it must be real.
   */
  normalize_identifier(_expression) {
    throw new NotPorted("Dialect.normalize_identifier", "sqlglot/dialects/dialect.py:1062");
  }

  /**
   * py: sqlglot/dialects/dialect.py:1113
   *
   * Checks if text contains any case sensitive characters, based on the dialect's rules.
   */
  case_sensitive(text) {
    if (this.normalization_strategy === NormalizationStrategy.CASE_INSENSITIVE) return false;

    // py: `str.islower` / `str.isupper` applied PER CHARACTER, via the full-range
    // generated tables — not `ch !== ch.toUpperCase()`, which disagrees with CPython on
    // hundreds of code points (§4.6).
    const unsafe =
      this.normalization_strategy === NormalizationStrategy.UPPERCASE ? pyIsLower : pyIsUpper;
    for (const char of text) if (unsafe(char)) return true;
    return false;
  }

  /**
   * py: sqlglot/dialects/dialect.py:1125
   *
   * @param identifier the identifier to check.
   * @param identify `true`: always true except for certain cases; `"safe"`: only when
   *   the identifier is case-INsensitive; `"unsafe"`: only when it is case-sensitive.
   */
  can_quote(identifier, identify = "safe") {
    if (identifier.quoted) return true;
    if (!identify) return false;
    if (identifier.parent instanceof exp.Func) return false;
    if (identify === true) return true;

    const is_safe = !this.case_sensitive(identifier.this) && SAFE_IDENTIFIER_RE.test(identifier.this);

    if (identify === "safe") return is_safe;
    if (identify === "unsafe") return !is_safe;

    throw new PyValueError(`Unexpected argument for identify: '${identify}'`);
  }

  /**
   * py: sqlglot/dialects/dialect.py:1158
   *
   * Adds quotes to `expression` if it is an `Identifier`; a no-op otherwise.
   */
  quote_identifier(expression, identify = true) {
    if (expression instanceof exp.Identifier) {
      // py: `identify or "unsafe"` yields the FALSE operand when identify is False,
      // i.e. the string "unsafe" — not `false`. `||` reproduces that for `false`/`""`.
      expression.set("quoted", this.can_quote(expression, identify || "unsafe"));
    }
    return expression;
  }

  /**
   * py: sqlglot/dialects/dialect.py:1171
   *
   * The `Literal` branch calls `sqlglot.jsonpath.parse_json_path`, an unported module
   * (P4). It announces itself rather than handing back the raw Literal, which would
   * differ from the oracle silently instead of loudly — the same choice, for the same
   * reason, that `spike/p3/dialect_tokenizer.mjs`'s stand-in already makes.
   */
  to_json_path(path) {
    if (path instanceof exp.Literal) {
      throw new NotPorted("Dialect.to_json_path", "sqlglot/jsonpath.py:parse_json_path");
    }

    return path;
  }

  /** py: sqlglot/dialects/dialect.py:1186 */
  parse(sql, opts = {}) {
    return this.parser(opts).parse(this.tokenize(sql), sql);
  }

  /** py: sqlglot/dialects/dialect.py:1189 */
  parse_into(expression_type, sql, opts = {}) {
    return this.parser(opts).parse_into(expression_type, this.tokenize(sql), sql);
  }

  /**
   * py: sqlglot/dialects/dialect.py:1194
   *
   * DEVIATION: `copy` is a normal Python parameter but lands in the trailing options
   * object here, because `**opts` already has to. It defaults to `true` either way.
   */
  generate(expression, opts = {}) {
    const { copy = true, ...rest } = opts;
    return this.generator(rest).generate(expression, { copy });
  }

  /** py: sqlglot/dialects/dialect.py:1199 */
  transpile(sql, opts = {}) {
    return this.parse(sql).map((expression) =>
      expression ? this.generate(expression, { ...opts, copy: false }) : "",
    );
  }

  /**
   * py: sqlglot/dialects/dialect.py:1205 — returns `list[Token]`.
   *
   * DEVIATION: `TokenizerCore.tokenize` returns `{tokens, codePoints}` (CONTRACTS.md
   * §8) so that the code-point array stays reachable for error columns. This method is
   * upstream-shaped and hands back the list, which is what `Parser.parse(tokens, sql)`
   * takes and what the P3 probes already pass it.
   */
  tokenize(sql, dialect = null) {
    return this.tokenizer(dialect).tokenize(sql).tokens;
  }

  /** py: sqlglot/dialects/dialect.py:1208 */
  tokenizer(dialect = null) {
    return new (this.constructor.tokenizer_class)(dialect || this);
  }

  /** py: sqlglot/dialects/dialect.py:1211 */
  jsonpath_tokenizer(dialect = null) {
    if (!this.constructor.jsonpath_tokenizer_class) {
      throw new NotPorted("Dialect.jsonpath_tokenizer", "sqlglot/jsonpath.py");
    }
    return new (this.constructor.jsonpath_tokenizer_class)(dialect || this);
  }

  /** py: sqlglot/dialects/dialect.py:1214 */
  parser(opts = {}) {
    const args = { dialect: this, ...opts };
    // `this.constructor`, never `this`: JS statics are not on the prototype, so a bare
    // `this.parser_class` is `undefined` and `new undefined(...)` throws a TypeError
    // that names neither the dialect nor the setting.
    return new (this.constructor.parser_class)(args);
  }

  /** py: sqlglot/dialects/dialect.py:1218 */
  generator(opts = {}) {
    if (!this.constructor.generator_class) {
      // Same string, same shape as `Expr.prototype.sql`'s (expressions/core.js:284),
      // so the two P4 gaps read identically wherever a user hits them.
      throw new Error("No SQL generator registered (available in P4)");
    }
    const args = { dialect: this, ...opts };
    return new (this.constructor.generator_class)(args);
  }

  /** py: sqlglot/dialects/dialect.py:1222 */
  generate_values_aliases(expression) {
    return expression.expressions[0].expressions.map((_, i) => exp.toIdentifier(`_col_${i}`));
  }
}

/**
 * py: sqlglot/dialects/dialect.py:260 `_Dialect.__new__`.
 *
 * THE ONE DELIBERATE STRUCTURAL DEVIATION IN THIS FILE
 * ----------------------------------------------------
 * Upstream registration is implicit: `class Snowflake(Dialect)` runs the `_Dialect`
 * metaclass, which both writes `_classes[key] = klass` and performs ~20 derivations on
 * the new class. Lookup is lazy — `_Dialect._try_load` does
 * `importlib.import_module(f"sqlglot.dialects.{key}")` the first time a name is asked
 * for, so `Dialect.get_or_raise("duckdb")` imports duckdb on demand.
 *
 * That trick is not portable, and not for a style reason. JS dynamic `import()` returns
 * a Promise; `get_or_raise` is synchronous and is called from `Tokenizer`'s CONSTRUCTOR,
 * which cannot await. CONTRACTS.md §8 already records the same wall for
 * `Tokenizer.__init__`. So registration becomes EXPLICIT and eager, using this
 * codebase's own established shape for exactly this problem — `registerExprClasses`,
 * `registerInitHook`, `registerAstEnums`, `registerParser`, `registerGenerator`
 * (expressions/core.js), and `initTokenizerSubclass` (tokens.js, itself the stand-in
 * for `__init_subclass__` and already a §8 row). Each `src/dialects/<name>.js` calls
 * this once at module load, after its class body, and is loaded by importing it.
 *
 * The name is a PARAMETER rather than derived from `klass.name` the way upstream
 * derives it from `clsname`. `constructor.name` is not a contract in JS — a minifier
 * rewrites it, and `defineExpr`-style factories already produce classes whose `.name`
 * lies about their identity, which is why nothing else in this port keys off it.
 *
 * Everything else here is upstream's `__new__`, in upstream's order.
 *
 * @param {string} name registry key — the `Dialects` value, "" for the base dialect.
 * @param {typeof Dialect} klass
 * @returns {typeof Dialect} `klass`, so a call can wrap the class expression.
 */
export function registerDialect(name, klass) {
  if (typeof name !== "string") {
    throw new PyValueError(`registerDialect: name must be a string, got ${typeof name}`);
  }
  if (!(klass === Dialect || klass.prototype instanceof Dialect)) {
    throw new PyValueError(`registerDialect(${JSON.stringify(name)}): not a Dialect subclass`);
  }
  // py:262-263 `cls._classes[enum.value if enum is not None else clsname.lower()]`.
  DIALECT_CLASSES.set(name, klass);
  DIALECT_CLASSES_BY_NAME.set(klass.name, klass);

  klass.TIME_TRIE = newTrie(klass.TIME_MAPPING.keys());
  klass.FORMAT_TRIE = klass.FORMAT_MAPPING.size
    ? newTrie(klass.FORMAT_MAPPING.keys())
    : klass.TIME_TRIE;
  // Merge class-defined INVERSE_TIME_MAPPING with auto-generated mappings.
  // py:271 `{v: k for k, v in TIME_MAPPING.items()} | (klass.__dict__.get(...) or {})`
  // — `__dict__.get` is OWN-property only, so an INHERITED INVERSE_TIME_MAPPING is
  // deliberately not re-merged.
  klass.INVERSE_TIME_MAPPING = _with_strict_time_inverse(
    new Map([
      ...[...klass.TIME_MAPPING].map(([k, v]) => [v, k]),
      ...(Object.hasOwn(klass, "INVERSE_TIME_MAPPING") ? klass.INVERSE_TIME_MAPPING : new Map()),
    ]),
  );
  klass.INVERSE_TIME_TRIE = newTrie(klass.INVERSE_TIME_MAPPING.keys());
  klass.INVERSE_FORMAT_MAPPING = _with_strict_time_inverse(
    new Map([...klass.FORMAT_MAPPING].map(([k, v]) => [v, k])),
  );
  klass.INVERSE_FORMAT_TRIE = newTrie(klass.INVERSE_FORMAT_MAPPING.keys());

  klass.INVERSE_CREATABLE_KIND_MAPPING = new Map(
    [...klass.CREATABLE_KIND_MAPPING].map(([k, v]) => [v, k]),
  );

  // py:285 `base = seq_get(bases, 0)` — JS's single-inheritance superclass. For
  // `Dialect` itself that is `Function.prototype`, whose `.tokenizer_class` is
  // undefined, matching `getattr(base, ..., Tokenizer)`'s fallback.
  const base = Object.getPrototypeOf(klass);
  const base_tokenizer = base?.tokenizer_class ?? Tokenizer;
  const base_parser = base?.parser_class ?? BaseParser;
  const base_generator = base?.generator_class ?? null;

  // py:291 `klass.__dict__.get("Tokenizer", type("Tokenizer", base_tokenizer, {}))`.
  // A dialect declares its tokenizer as a nested class named `Tokenizer`; when it does
  // not, upstream still builds a FRESH empty subclass rather than aliasing the base
  // one, so per-dialect mutation cannot leak upward. Reproduced, including the
  // `initTokenizerSubclass` derivation `__init_subclass__` would have run on it.
  if (Object.hasOwn(klass, "Tokenizer")) {
    klass.tokenizer_class = klass.Tokenizer;
  } else {
    klass.tokenizer_class = class Tokenizer extends base_tokenizer {};
    initTokenizerSubclass(klass.tokenizer_class);
  }
  // py:294 — `sqlglot/jsonpath.py` is unported (P4); see the class field's note.
  klass.jsonpath_tokenizer_class = Object.hasOwn(klass, "JSONPathTokenizer")
    ? klass.JSONPathTokenizer
    : null;
  // py:297 — note the ASYMMETRY with `Tokenizer` above: no fresh subclass, and the
  // fallback consults the class's OWN `parser_class`/`generator_class` declaration
  // before the base's. That is what leaves the base `Dialect` on `BaseParser`.
  klass.parser_class = Object.hasOwn(klass, "Parser")
    ? klass.Parser
    : Object.hasOwn(klass, "parser_class")
      ? klass.parser_class
      : base_parser;
  klass.generator_class = Object.hasOwn(klass, "Generator")
    ? klass.Generator
    : Object.hasOwn(klass, "generator_class")
      ? klass.generator_class
      : base_generator;

  // py:304-309 — remove transforms that correspond to unsupported JSONPathPart
  // expressions. DEFERRED, and announced instead of skipped: `Generator` is P4 and
  // `ALL_JSON_PATH_PARTS` lives in the unported `sqlglot/jsonpath.py`. The guard fires
  // the moment a real generator class is registered, so this is a gap with a READER
  // rather than a comment nobody re-reads (PORT_PLAN.md R19).
  if (klass.generator_class) {
    throw new NotPorted(
      "registerDialect: SUPPORTED_JSON_PATH_PARTS pruning",
      "sqlglot/dialects/dialect.py:304",
    );
  }

  // py:311 `list(klass.tokenizer_class._QUOTES.items())[0]` — FIRST entry, so this
  // depends on the tokenizer's insertion order, which P1 already pins.
  [klass.QUOTE_START, klass.QUOTE_END] = [...klass.tokenizer_class._QUOTES][0];
  [klass.IDENTIFIER_START, klass.IDENTIFIER_END] = [...klass.tokenizer_class._IDENTIFIERS][0];

  // py:316
  const get_start_end = (token_type) => {
    for (const [s, [e, t]] of klass.tokenizer_class._FORMAT_STRINGS) {
      if (t === token_type) return [s, e];
    }
    return [null, null];
  };

  [klass.BIT_START, klass.BIT_END] = get_start_end(TokenType.BIT_STRING);
  [klass.HEX_START, klass.HEX_END] = get_start_end(TokenType.HEX_STRING);
  [klass.BYTE_START, klass.BYTE_END] = get_start_end(TokenType.BYTE_STRING);
  [klass.UNICODE_START, klass.UNICODE_END] = get_start_end(TokenType.UNICODE_STRING);

  klass.STRINGS_SUPPORT_ESCAPED_SEQUENCES = klass.tokenizer_class.STRING_ESCAPES.includes("\\");
  klass.BYTE_STRINGS_SUPPORT_ESCAPED_SEQUENCES =
    klass.tokenizer_class.BYTE_STRING_ESCAPES.includes("\\");

  if (klass.STRINGS_SUPPORT_ESCAPED_SEQUENCES || klass.BYTE_STRINGS_SUPPORT_ESCAPED_SEQUENCES) {
    klass.UNESCAPED_SEQUENCES = new Map([...UNESCAPED_SEQUENCES, ...klass.UNESCAPED_SEQUENCES]);
  }

  klass.ESCAPED_SEQUENCES = new Map(
    // The filter is necessary because of `\\a -> a` in Snowflake; we can't replace `a` with `\a`.
    [...klass.UNESCAPED_SEQUENCES]
      .filter(([, v]) => !pyIsPrintable(v) || v === "\\")
      .map(([k, v]) => [v, k]),
  );

  klass.SUPPORTS_COLUMN_JOIN_MARKS = klass.tokenizer_class.KEYWORDS.has("(+)");

  if (!["", "bigquery", "snowflake"].includes(name)) {
    klass.INITCAP_SUPPORTS_CUSTOM_DELIMITERS = false;
  }

  klass.VALID_INTERVAL_UNITS = new Set([
    ...klass.VALID_INTERVAL_UNITS,
    ...klass.DATE_PART_MAPPING.keys(),
    ...klass.DATE_PART_MAPPING.values(),
  ]);

  _mirrorSettingsOntoPrototype(klass);

  return klass;
}

/**
 * DEVIATION (CONTRACTS.md §8), and the one without which none of this file works.
 *
 * In Python, `self.NULL_ORDERING` on a `Dialect` INSTANCE resolves through the MRO to
 * the class attribute. In JS, `static` fields live on the constructor and are NOT on
 * the prototype, so `instance.NULL_ORDERING` is plain `undefined`.
 *
 * That matters because `src/parser.js` and every `src/parsers/*.js` subclass read
 * roughly forty settings as `this.dialect.X`, where `this.dialect` is the resolved
 * INSTANCE — `this.dialect.tokenizer_class.COMMANDS`, `this.dialect.VALID_INTERVAL_UNITS`,
 * `this.dialect.NULL_ORDERING`. Those call sites are faithful transliterations of
 * upstream and must not change. The harness's `standInDialect` happens to satisfy them
 * because it returns a plain object whose settings are OWN properties; a real class
 * does not, and the failure is `undefined` for the 24 falsy defaults (indistinguishable
 * from correct) and a flipped branch for the truthy ones.
 *
 * So after every derivation is final, the settings are mirrored onto the prototype,
 * which reproduces Python's lookup exactly: instance -> prototype (this class's
 * settings) -> parent prototype (inherited settings), with a subclass's own value
 * shadowing its parent's, and no per-instance copying.
 *
 * The mirrored set is stated as a pattern rather than "everything static": data
 * settings are SHOUT_CASE, plus the four lowercase autofilled class references. Methods
 * are deliberately excluded — `Dialect.format_time` is a static AND a prototype method
 * (see its note), and copying the static over the bridge would work only by accident.
 */
function _mirrorSettingsOntoPrototype(klass) {
  const CLASS_REFS = ["tokenizer_class", "jsonpath_tokenizer_class", "parser_class", "generator_class"];
  const names = new Set(CLASS_REFS);
  for (let k = klass; k && k !== Function.prototype; k = Object.getPrototypeOf(k)) {
    for (const name of Object.getOwnPropertyNames(k)) {
      if (/^[A-Z][A-Z0-9_]*$/.test(name)) names.add(name);
    }
  }
  for (const name of names) {
    // Non-enumerable so `{...dialectInstance}` and `Object.keys` stay the instance's
    // own state (`version`, `normalization_strategy`, `settings`), as in Python where
    // `vars(instance)` does not include class attributes.
    Object.defineProperty(klass.prototype, name, {
      value: klass[name],
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}

// ---------------------------------------------------------------------------
// Module init — the explicit stand-in for Python's import-time metaclass run
// ---------------------------------------------------------------------------
// Same placement and same argument as `initTokenizerSubclass(Tokenizer)` at the bottom
// of `src/tokens.js`, and as `installFocusedMethods()` / `installQueryMethods()` at the
// bottom of `src/expressions/index.js`: the derivation a Python metaclass performs at
// class-creation time is performed once here, in declaration order.
//
// Registering the BASE class is not a formality. Six of its settings are wrong until
// this runs — `VALID_INTERVAL_UNITS` is empty in the class body and 116 entries after
// (and `src/parser.js` reads it at three sites), `INVERSE_TIME_MAPPING` gains the six
// strict-format degradations, and `QUOTE_START`/`IDENTIFIER_START` come off the
// tokenizer rather than the literals above.
registerDialect(Dialects.DIALECT, Dialect);

// py: `tools/astdump.py:110`'s `isinstance(node, Dialect)` branch and `serde.load`'s
// inverse both need to recognise a Dialect from inside the expression layer, which
// cannot import this module. Same injected-callback shape as `helper.while_changing`'s
// `hash` and `helper.is_iterable`'s `isExpr` (both CONTRACTS.md §8 rows).
registerAstDialects(DIALECT_CLASSES_BY_NAME);

// py: `sqlglot/tokens.py`'s `Tokenizer.__init__` calls `Dialect.get_or_raise(dialect)`
// through a function-level import to break the same cycle. CONTRACTS.md §8's
// "`Tokenizer.__init__`'s `Dialect.get_or_raise`" row says the resolver is injected
// "once by `dialects/dialect.js` when it lands". This is that call; from here on
// `new Tokenizer("snowflake")` resolves a NAME instead of throwing.
setDialectResolver((dialect) => Dialect.get_or_raise(dialect));

/**
 * py: sqlglot/__init__.py:134 `parse_one`.
 *
 * DEVIATION (location): upstream puts this in the package root, and
 * `expressions/core.py:2566`'s `maybe_parse` reaches it with a FUNCTION-LEVEL
 * `import sqlglot` precisely to break the cycle root -> expressions -> root. JS has no
 * synchronous equivalent, so the function lives next to the registry it needs and a
 * future `src/index.js` should re-export it from here rather than redefine it.
 *
 * @param {string} sql
 * @param {{read?: any, dialect?: any, into?: any}} [opts]
 */
export function parseOne(sql, opts = {}) {
  const { read = null, dialect: dialectOpt = null, into = null, ...rest } = opts;
  // py: `read or dialect` — `dialect` is documented as an alias for `read`.
  const dialect = Dialect.get_or_raise(read || dialectOpt);

  const result = into ? dialect.parse_into(into, sql, rest) : dialect.parse(sql, rest);

  if (!result.length || result[0] === null || result[0] === undefined) {
    throw new ParseError(`No expression was parsed from '${sql}'`);
  }
  return result[0];
}

// py: expressions/core.py:2557 — the tail of `maybe_parse`, i.e. everything after the
// `isinstance(sql_or_expression, Expr)` early return that `maybeParse` already does
// itself (expressions/core.js:586).
//
// PORT_PLAN.md R17: `registerParser` was exported and called from NOWHERE, so `PARSE`
// stayed null and the "P2-safe leaf fallback" stayed permanently live —
// `exp.select("*")` produced `Column(Identifier('*', quoted=True))` where CPython
// produces `Star()`, and every pipe-syntax method plus every `/*+ hint */` funnels
// through it. This call is the whole fix; it needs `parse_one`, which needs a resolved
// base `Dialect`, which is why it could not land before this file.
registerParser((sqlOrExpression, options = {}) => {
  if (sqlOrExpression === null || sqlOrExpression === undefined) {
    throw new ParseError("SQL cannot be None");
  }

  const { into = null, dialect = null, prefix = null, copy: _copy, ...rest } = options;
  let sql = String(sqlOrExpression);
  if (prefix) sql = `${prefix} ${sql}`;

  return parseOne(sql, { read: dialect, into, ...rest });
});

// py: expressions/core.py `Expr.sql` — `Dialect.get_or_raise(dialect).generate(self, **opts)`.
//
// Installed here rather than by P4 so that the generator, when it lands, only has to
// set `generator_class` (which `registerDialect` already picks up from a dialect's
// nested `Generator`) and never has to edit this file. Until then `generator()` throws
// the same "No SQL generator registered (available in P4)" string `Expr.prototype.sql`
// threw directly, so the message a user sees is unchanged.
registerGenerator((expression, opts = {}) => {
  const { dialect = null, ...rest } = opts;
  return Dialect.get_or_raise(dialect).generate(expression, rest);
});
