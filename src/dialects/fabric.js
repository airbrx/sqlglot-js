// py: sqlglot/dialects/fabric.py — `class Fabric(TSQL)`.
//
// Microsoft Fabric Data Warehouse dialect that inherits from T-SQL.
//
// Microsoft Fabric is a cloud-based analytics platform that provides a unified data
// warehouse experience. While it shares much of T-SQL's syntax, it has specific
// differences and limitations that this dialect addresses.
//
// Key differences from T-SQL:
// - Case-sensitive identifiers (unlike T-SQL which is case-insensitive)
// - Limited data type support with mappings to supported alternatives
// - Temporal types (DATETIME2, DATETIMEOFFSET, TIME) limited to 6 digits precision
// - Certain legacy types (MONEY, SMALLMONEY, etc.) are not supported
// - Unicode types (NCHAR, NVARCHAR) are mapped to non-unicode equivalents
//
// References:
// - Data Types: https://learn.microsoft.com/en-us/fabric/data-warehouse/data-types
// - T-SQL Surface Area: https://learn.microsoft.com/en-us/fabric/data-warehouse/tsql-surface-area
//
// SETTINGS ONLY, same split as `tsql.js`/`redshift.js`: `sqlglot/parsers/fabric.py` is
// a different upstream file, already ported to `src/parsers/fabric.js`. This file adds
// `class Fabric extends TSQL` — matching upstream's own `Fabric(TSQL)` class statement
// — with its one overridden setting and the nested `Tokenizer` subclass, which extends
// `TSQL.Tokenizer` directly (the same shape `redshift.js`'s
// `RedshiftTokenizer(Postgres.Tokenizer)` uses). AIR-2292, "12.7 Small dialects",
// batch A.
//
// No `sqlglot/typing/fabric.py` exists upstream, so `EXPRESSION_METADATA` is inherited
// verbatim from `TSQL` via ordinary JS static-field inheritance — same shape R106's
// starrocks/doris and R108's singlestore used for their own inherited-from-parent
// table.
//
// Every setting below is diffed value-by-value against CPython by
// `spike/p5/fuzz_fabric_dialect.mjs`.

import { TokenType, initTokenizerSubclass } from "../tokens.js";
import { FabricParser } from "../parsers/fabric.js";
import { FabricGenerator } from "../generators/fabric.js";
import { Dialects, registerDialect, NormalizationStrategy } from "./dialect.js";
import { TSQL } from "./tsql.js";

/**
 * py: sqlglot/dialects/fabric.py:34 `class Tokenizer(TSQL.Tokenizer)`.
 *
 * Extends `TSQL.Tokenizer` DIRECTLY, matching upstream's own class statement exactly
 * — same shape as `redshift.js`'s `RedshiftTokenizer(Postgres.Tokenizer)`.
 *
 * Override T-SQL tokenizer to handle TIMESTAMP differently: in T-SQL, TIMESTAMP is a
 * synonym for ROWVERSION, but in Fabric we want it to be a datetime type. Also add
 * UTINYINT keyword mapping since T-SQL doesn't have it.
 */
class FabricTokenizer extends TSQL.Tokenizer {
  static KEYWORDS = new Map([
    ...TSQL.Tokenizer.KEYWORDS,
    ["TIMESTAMP", TokenType.TIMESTAMP],
    ["UTINYINT", TokenType.UTINYINT],
  ]);
}
initTokenizerSubclass(FabricTokenizer);

/** py: sqlglot/dialects/fabric.py:11 `class Fabric(TSQL)`. */
export class Fabric extends TSQL {
  // Fabric is case-sensitive unlike T-SQL which is case-insensitive
  /* py:32 */ static NORMALIZATION_STRATEGY = NormalizationStrategy.CASE_SENSITIVE;

  /** py:44 `Parser = FabricParser` — what `registerDialect` turns into `parser_class`. */
  static Parser = FabricParser;

  /** py:46 `Generator = FabricGenerator` — what `registerDialect` turns into `generator_class`. */
  static Generator = FabricGenerator;

  /** py:34 `class Tokenizer(TSQL.Tokenizer)`; see `FabricTokenizer` above. */
  static Tokenizer = FabricTokenizer;
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the class
// body above. Same placement and same argument shape as `registerDialect(Dialects.
// REDSHIFT, Redshift)` at the bottom of `redshift.js`.
registerDialect(Dialects.FABRIC, Fabric);
