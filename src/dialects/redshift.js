// py: sqlglot/dialects/redshift.py — `class Redshift(Postgres)`.
//
// SETTINGS ONLY, same split as `postgres.js`/`databricks.js`: `sqlglot/parsers/redshift.py`
// is a different upstream file, already ported to `src/parsers/redshift.js`. This file
// adds `class Redshift extends Postgres` — matching upstream's own `Redshift(Postgres)`
// class statement, the same DIALECT-settings inheritance shape `databricks.js` uses for
// `Databricks(Spark)` — with its ~13 overridden settings and the nested `Tokenizer`
// subclass, which extends `Postgres.Tokenizer` directly (again like `databricks.js`'s
// `DatabricksTokenizer(Spark.Tokenizer)`).
//
// `Generator = RedshiftGenerator` (py:62) IS now declared — `generators/redshift.js`
// exists (PORT_PLAN.md, the Redshift generator step), closing this file's own
// previously-deferred `generator_class` gap.
//
// ONE REMAINING DELIBERATE GAP, announced rather than faked, same reason as Postgres's:
//
//   `EXPRESSION_METADATA = EXPRESSION_METADATA.copy()` (py:17, from
//   `sqlglot/typing/redshift.py`) is declared as an empty `Map()` for the same reason
//   `Postgres.EXPRESSION_METADATA` is: `sqlglot/optimizer/annotate_types.py` and
//   `typing/` are P6+.
//
// Every setting below is diffed value-by-value against CPython by
// `spike/p5/fuzz_dialect_parse.mjs`'s REDSHIFT row.

import { TokenType, initTokenizerSubclass } from "../tokens.js";
import { RedshiftParser } from "../parsers/redshift.js";
import { RedshiftGenerator } from "../generators/redshift.js";
import { Dialects, registerDialect, NormalizationStrategy } from "./dialect.js";
import { Postgres } from "./postgres.js";

/**
 * py: sqlglot/dialects/redshift.py:38 `class Tokenizer(Postgres.Tokenizer)`.
 *
 * Extends `Postgres.Tokenizer` DIRECTLY, matching upstream's own class statement
 * exactly — same shape as `databricks.js`'s `DatabricksTokenizer(Spark.Tokenizer)`.
 */
class RedshiftTokenizer extends Postgres.Tokenizer {
  static BIT_STRINGS = [];
  static HEX_STRINGS = [];
  static STRING_ESCAPES = ["\\", "'"];

  static KEYWORDS = new Map([
    ...Postgres.Tokenizer.KEYWORDS,
    ["(+)", TokenType.JOIN_MARKER],
    ["BINARY VARYING", TokenType.VARBINARY],
    ["CURRENT_USER_ID", TokenType.CURRENT_USER_ID],
    ["HLLSKETCH", TokenType.HLLSKETCH],
    ["MINUS", TokenType.EXCEPT],
    ["SUPER", TokenType.SUPER],
    ["TOP", TokenType.TOP],
    ["UNLOAD", TokenType.COMMAND],
    ["USER", TokenType.CURRENT_USER],
    ["VARBYTE", TokenType.VARBINARY],
  ]);

  // Redshift allows # to appear as a table identifier prefix
  static SINGLE_TOKENS = new Map(Postgres.Tokenizer.SINGLE_TOKENS);
}
// py:56 `KEYWORDS.pop("VALUES")` / py:60 `SINGLE_TOKENS.pop("#")` — mutations of the
// merged tables AFTER construction, same `Map#delete` spelling as `postgres.js`'s
// `/*+`/`DIV` pops.
RedshiftTokenizer.KEYWORDS.delete("VALUES");
RedshiftTokenizer.SINGLE_TOKENS.delete("#");
initTokenizerSubclass(RedshiftTokenizer);

/** py: sqlglot/dialects/redshift.py:11 `class Redshift(Postgres)`. */
export class Redshift extends Postgres {
  /**
   * py:17 `EXPRESSION_METADATA = EXPRESSION_METADATA.copy()`, from
   * `sqlglot/typing/redshift.py`. Unported — see `postgres.js`'s class-level note.
   */
  static EXPRESSION_METADATA = new Map();

  // https://docs.aws.amazon.com/redshift/latest/dg/r_names.html
  static NORMALIZATION_STRATEGY = NormalizationStrategy.CASE_INSENSITIVE;

  static NORMALIZE_NOT_NULL = true;

  static SUPPORTS_USER_DEFINED_TYPES = false;
  static INDEX_OFFSET = 0;
  static COPY_PARAMS_ARE_CSV = false;
  static HEX_LOWERCASE = true;
  static HAS_DISTINCT_ARRAY_CONSTRUCTORS = true;
  static COALESCE_COMPARISON_NON_STANDARD = true;
  static REGEXP_EXTRACT_POSITION_OVERFLOW_RETURNS_NULL = false;
  static ARRAY_FUNCS_PROPAGATES_NULLS = true;

  // ref: https://docs.aws.amazon.com/redshift/latest/dg/r_FORMAT_strings.html
  static TIME_FORMAT = "'YYYY-MM-DD HH24:MI:SS'";

  static TIME_MAPPING = new Map([
    ...Postgres.TIME_MAPPING,
    ["MON", "%b"],
    ["MONTH", "%B"],
  ]);

  /** py:36 `Parser = RedshiftParser` — what `registerDialect` turns into `parser_class`. */
  static Parser = RedshiftParser;

  /** py:62 `Generator = RedshiftGenerator` — what `registerDialect` turns into `generator_class`. */
  static Generator = RedshiftGenerator;

  /** py:38 `class Tokenizer(Postgres.Tokenizer)`; see `RedshiftTokenizer` above. */
  static Tokenizer = RedshiftTokenizer;
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the class
// body above. Same placement and same argument as `registerDialect(Dialects.POSTGRES,
// Postgres)` at the bottom of `postgres.js`. Importing this module is what makes
// `Dialect.get_or_raise("redshift")` resolve.
registerDialect(Dialects.REDSHIFT, Redshift);
