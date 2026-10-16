// py: sqlglot/dialects/materialize.py — `class Materialize(Postgres)`.
//
// SETTINGS ONLY, same split as `postgres.js`/`redshift.js`: `sqlglot/parsers/
// materialize.py` is a different upstream file, already ported to
// `src/parsers/materialize.js`. This file adds `class Materialize extends Postgres`
// — matching upstream's own `Materialize(Postgres)` class statement — with its one
// overridden setting (`NORMALIZE_NOT_NULL`). AIR-2292, "12.7 Small dialects", batch A.
//
// No `Tokenizer` is declared upstream (`dialects/materialize.py` has no nested
// `Tokenizer`), so `registerDialect` builds a fresh empty subclass of
// `Postgres.tokenizer_class` for it, the same shape `starrocks.js`/`doris.js`
// (R106) already established for a dialect with no tokenizer overrides of its own.
//
// No `sqlglot/typing/materialize.py` exists upstream either, so `EXPRESSION_METADATA`
// is inherited verbatim from `Postgres` via ordinary JS static-field inheritance —
// same shape R106's starrocks/doris and R108's singlestore used for their own
// inherited-from-parent table.
//
// Every setting below is diffed value-by-value against CPython by
// `spike/p5/fuzz_materialize_dialect.mjs`.

import { MaterializeParser } from "../parsers/materialize.js";
import { MaterializeGenerator } from "../generators/materialize.js";
import { Dialects, registerDialect } from "./dialect.js";
import { Postgres } from "./postgres.js";

/** py: sqlglot/dialects/materialize.py:8 `class Materialize(Postgres)`. */
export class Materialize extends Postgres {
  /* py:9 */ static NORMALIZE_NOT_NULL = true;

  /** py:11 `Parser = MaterializeParser` — what `registerDialect` turns into `parser_class`. */
  static Parser = MaterializeParser;

  /** py:13 `Generator = MaterializeGenerator` — what `registerDialect` turns into `generator_class`. */
  static Generator = MaterializeGenerator;
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the class
// body above. Same placement and same argument shape as `registerDialect(Dialects.
// REDSHIFT, Redshift)` at the bottom of `redshift.js`.
registerDialect(Dialects.MATERIALIZE, Materialize);
