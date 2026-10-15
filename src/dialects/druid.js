// py: sqlglot/dialects/druid.py @ 91119bc — `class Druid(Dialect)`, AIR-2292 (epic
// AIR-2272, "12.7 Small dialects", batch B).
//
// SETTINGS ONLY, same split as every other dialect: `sqlglot/parsers/druid.py` (10
// LOC) and `sqlglot/generators/druid.py` (30 LOC) are different upstream files,
// ported to `src/parsers/druid.js`/`src/generators/druid.js` in this same round.
// `Druid(Dialect)` is standalone, not part of a subclass chain, and declares no
// Tokenizer override and no scalar setting of its own — only the two class links.
//
// There is no `typing/druid.py` upstream — Druid inherits the base `Dialect`'s
// 294-entry `EXPRESSION_METADATA` table unmodified.

import { DruidParser } from "../parsers/druid.js";
import { DruidGenerator } from "../generators/druid.js";
import { Dialect, Dialects, registerDialect } from "./dialect.js";

/** py: sqlglot/dialects/druid.py:5 `class Druid(Dialect)`. */
export class Druid extends Dialect {
  /** py:6 `Parser = DruidParser`. */
  static Parser = DruidParser;

  /** py:8 `Generator = DruidGenerator`. */
  static Generator = DruidGenerator;
}

registerDialect(Dialects.DRUID, Druid);
