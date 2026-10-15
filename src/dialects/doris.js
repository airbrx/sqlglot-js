// py: sqlglot/dialects/doris.py — `class Doris(MySQL)`.
//
// SETTINGS ONLY, same split as `redshift.js`/`databricks.js`: `sqlglot/parsers/
// doris.py` and `sqlglot/generators/doris.py` are different upstream files, already
// ported to `src/parsers/doris.js`/`src/generators/doris.js` (PORT_PLAN.md, AIR-2286
// part 2). This file adds `class Doris extends MySQL` — matching upstream's own
// `Doris(MySQL)` class statement, the same DIALECT-settings inheritance shape
// `databricks.js` uses for `Databricks(Spark)` — with its three overridden settings.
//
// NO nested `Tokenizer`: unlike `starrocks.py`, upstream `doris.py` declares no
// `Tokenizer` subclass at all, so `registerDialect` builds a FRESH empty subclass of
// `MySQL.tokenizer_class` for it (the `Object.hasOwn(klass, "Tokenizer")` branch's
// `else` — "upstream still builds a FRESH empty subclass rather than aliasing the base
// one", per that function's own comment) — NOT declaring `static Tokenizer` here is
// what reproduces that.
//
// NO `src/typing/doris.js` either: `sqlglot/typing/doris.py` does not exist upstream
// (checked against the pin), so `Doris.EXPRESSION_METADATA` is left undeclared and
// resolves through ordinary JS static-field inheritance to `MySQL.EXPRESSION_METADATA`
// — same reasoning as `starrocks.js`'s own header.

import { DorisParser } from "../parsers/doris.js";
import { DorisGenerator } from "../generators/doris.js";
import { Dialects, registerDialect } from "./dialect.js";
import { MySQL } from "./mysql.js";

/** py: sqlglot/dialects/doris.py:8 `class Doris(MySQL)`. */
export class Doris extends MySQL {
  static DATE_FORMAT = "'yyyy-MM-dd'";
  static DATEINT_FORMAT = "'yyyyMMdd'";
  static TIME_FORMAT = "'yyyy-MM-dd HH:mm:ss'";

  /** py:13 `Parser = DorisParser` — what `registerDialect` turns into `parser_class`. */
  static Parser = DorisParser;

  /** py:15 `Generator = DorisGenerator` — what `registerDialect` turns into `generator_class`. */
  static Generator = DorisGenerator;
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the class
// body above. Same placement and same argument as every other dialect's own call at
// the bottom of its file. Importing this module is what makes
// `Dialect.get_or_raise("doris")` resolve.
registerDialect(Dialects.DORIS, Doris);
