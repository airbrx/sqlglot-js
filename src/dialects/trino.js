// py: sqlglot/dialects/trino.py @ 91119bc — WHOLE FILE, AIR-2287 (epic AIR-2272,
// "12.2 Presto family"), part 2 of the chain.
//
// SETTINGS ONLY, same split as Presto (PORT_PLAN.md R103): `sqlglot/parsers/trino.py`
// (267 LOC) lands in `src/parsers/trino.js`, `sqlglot/generators/trino.py` (145 LOC)
// in `src/generators/trino.js`, both in this same round. `Trino(Presto)` is the first
// dialect in THIS port to extend a sibling other than a base generator/parser — the
// same `redshift.js extends postgres.js` relationship PORT_PLAN.md R103 named in
// advance. `athena`/`dune` extend THIS file in the rest of this round.

import { TokenType, initTokenizerSubclass } from "../tokens.js";
import { TrinoParser } from "../parsers/trino.js";
import { TrinoGenerator } from "../generators/trino.js";
import { Dialects, registerDialect } from "./dialect.js";
import { Presto } from "./presto.js";

/**
 * py: sqlglot/dialects/trino.py:14 `class Tokenizer(Presto.Tokenizer)`.
 *
 * Declared at module level, same convention `presto.js`'s own `PrestoTokenizer`
 * uses; `Trino.Tokenizer` below points at it.
 */
class TrinoTokenizer extends Presto.Tokenizer {
  static KEYWORDS = new Map([
    ...Presto.Tokenizer.KEYWORDS,
    ["REFRESH", TokenType.REFRESH],
    ["DECLARE", TokenType.DECLARE],
  ]);
}
// py:20-22 `KEYWORDS.pop("SQL SECURITY")` — Trino has no `SQL SECURITY` clause, only
// bare `SECURITY DEFINER`/`INVOKER`; the merged base keyword otherwise eats the `SQL`
// in `LANGUAGE SQL SECURITY DEFINER`.
TrinoTokenizer.KEYWORDS.delete("SQL SECURITY");
initTokenizerSubclass(TrinoTokenizer);

/** py: sqlglot/dialects/trino.py:9 `class Trino(Presto)`. */
export class Trino extends Presto {
  static SUPPORTS_USER_DEFINED_TYPES = false;
  static LOG_BASE_FIRST = true;
  static CONCAT_WS_COALESCE = true;

  /** py:14 `class Tokenizer(Presto.Tokenizer)`; see `TrinoTokenizer` above. */
  static Tokenizer = TrinoTokenizer;

  /** py:24 `Parser = TrinoParser`. */
  static Parser = TrinoParser;

  /** py:26 `Generator = TrinoGenerator`. */
  static Generator = TrinoGenerator;
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the
// class body above.
registerDialect(Dialects.TRINO, Trino);
