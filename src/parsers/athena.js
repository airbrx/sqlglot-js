// py: sqlglot/parsers/athena.py @ 91119bc — WHOLE FILE (74 LOC), AIR-2287 (epic
// AIR-2272, "12.2 Presto family"), part 2 of the chain. Athena is not simply hosted
// Trino: AWS routes a query to either a Hive-flavored DDL engine or a Trino DML
// engine depending on statement shape (see `src/dialects/athena.js`'s own header for
// the full routing rationale and its `_tokenize_as_hive` heuristic). This file is the
// PARSE-side half of that composite: `AthenaParser` owns one real `Hive` sub-parser
// and one real `AthenaTrinoParser` (itself a thin `TrinoParser` subclass) and simply
// dispatches `.parse()`/`.parse_into()` to whichever one the dialect's own Tokenizer
// already decided on, signaled by a leading `TokenType.HIVE_TOKEN_STREAM` sentinel
// token the dialect's `tokenize()` prepends (see `src/dialects/athena.js`).
//
// No new Expression classes or base-Parser methods were needed for this file.

import { Parser } from "../parser.js";
import { TokenType } from "../tokens.js";
import { TrinoParser } from "./trino.js";
import { Hive } from "../dialects/hive.js";
import { Trino } from "../dialects/trino.js";

/** py: sqlglot/parsers/athena.py:17 `class AthenaTrinoParser(TrinoParser)`. */
export class AthenaTrinoParser extends TrinoParser {
  /** py:18 */
  static STATEMENT_PARSERS = new Map([
    ...TrinoParser.STATEMENT_PARSERS,
    [TokenType.USING, (self) => self._parse_as_command(self._prev)],
  ]);
}

/**
 * py: sqlglot/parsers/athena.py:24 `class AthenaParser(Parser)`.
 *
 * `hive`/`trino` constructor options are already-resolved `Dialect` instances (or
 * `null`, matching upstream's `hive: Hive | None = None` / `trino: Trino | None =
 * None`), the same contract `Dialect.parser(opts)` (`dialects/dialect.js`) already
 * documents for every other dialect's own composite-constructor shape.
 */
export class AthenaParser extends Parser {
  /** py:25 `__init__`. */
  constructor(options = {}) {
    const {
      errorLevel = null,
      errorMessageContext = 100,
      maxErrors = 3,
      dialect = null,
      hive = null,
      trino = null,
    } = options;

    super({ errorLevel, errorMessageContext, maxErrors, dialect });

    const hiveDialect = hive || new Hive();
    const trinoDialect = trino || new Trino();

    this._hive_parser = hiveDialect.parser({ errorLevel, errorMessageContext, maxErrors });
    this._trino_parser = new AthenaTrinoParser({
      errorLevel,
      errorMessageContext,
      maxErrors,
      dialect: trinoDialect,
    });
  }

  /** py:59 */
  parse(rawTokens, sql) {
    if (rawTokens.length && rawTokens[0].token_type === TokenType.HIVE_TOKEN_STREAM) {
      return this._hive_parser.parse(rawTokens.slice(1), sql);
    }

    return this._trino_parser.parse(rawTokens, sql);
  }

  /** py:65 */
  parse_into(expression_types, rawTokens, sql = null) {
    if (rawTokens.length && rawTokens[0].token_type === TokenType.HIVE_TOKEN_STREAM) {
      return this._hive_parser.parse_into(expression_types, rawTokens.slice(1), sql);
    }

    return this._trino_parser.parse_into(expression_types, rawTokens, sql);
  }
}
