// py: sqlglot/dialects/risingwave.py — `class RisingWave(Postgres)`.
//
// SETTINGS ONLY, same split as `postgres.js`/`redshift.js`: `sqlglot/parsers/
// risingwave.py` is a different upstream file, already ported to
// `src/parsers/risingwave.js`. This file adds `class RisingWave extends Postgres`
// — matching upstream's own `RisingWave(Postgres)` class statement — with its three
// overridden settings and the nested `Tokenizer` subclass, which extends
// `Postgres.Tokenizer` directly (the same shape `redshift.js`'s
// `RedshiftTokenizer(Postgres.Tokenizer)` uses). AIR-2292, "12.7 Small dialects",
// batch A.
//
// No `sqlglot/typing/risingwave.py` exists upstream, so `EXPRESSION_METADATA` is
// inherited verbatim from `Postgres` via ordinary JS static-field inheritance — same
// shape R106's starrocks/doris and R108's singlestore used for their own
// inherited-from-parent table.
//
// Every setting below is diffed value-by-value against CPython by
// `spike/p5/fuzz_risingwave_dialect.mjs`.

import { TokenType, initTokenizerSubclass } from "../tokens.js";
import { RisingWaveParser } from "../parsers/risingwave.js";
import { RisingWaveGenerator } from "../generators/risingwave.js";
import { Dialects, registerDialect } from "./dialect.js";
import { Postgres } from "./postgres.js";

/**
 * py: sqlglot/dialects/risingwave.py:15 `class Tokenizer(Postgres.Tokenizer)`.
 *
 * Extends `Postgres.Tokenizer` DIRECTLY, matching upstream's own class statement
 * exactly — same shape as `redshift.js`'s `RedshiftTokenizer(Postgres.Tokenizer)`.
 */
class RisingWaveTokenizer extends Postgres.Tokenizer {
  static KEYWORDS = new Map([
    ...Postgres.Tokenizer.KEYWORDS,
    ["SINK", TokenType.SINK],
    ["SOURCE", TokenType.SOURCE],
  ]);
}
initTokenizerSubclass(RisingWaveTokenizer);

/** py: sqlglot/dialects/risingwave.py:9 `class RisingWave(Postgres)`. */
export class RisingWave extends Postgres {
  /* py:10 */ static NORMALIZE_NOT_NULL = true;

  /* py:12 */ static REQUIRES_PARENTHESIZED_STRUCT_ACCESS = true;
  /* py:13 */ static SUPPORTS_STRUCT_STAR_EXPANSION = true;

  /** py:36 `Parser = RisingWaveParser` — what `registerDialect` turns into `parser_class`. */
  static Parser = RisingWaveParser;

  /** py:24 `Generator = RisingWaveGenerator` — what `registerDialect` turns into `generator_class`. */
  static Generator = RisingWaveGenerator;

  /** py:15 `class Tokenizer(Postgres.Tokenizer)`; see `RisingWaveTokenizer` above. */
  static Tokenizer = RisingWaveTokenizer;
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the class
// body above. Same placement and same argument shape as `registerDialect(Dialects.
// REDSHIFT, Redshift)` at the bottom of `redshift.js`.
registerDialect(Dialects.RISINGWAVE, RisingWave);
