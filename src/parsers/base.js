// py: sqlglot/parsers/base.py @ 91119bc
//
// `class BaseParser(parser.Parser)` — 17 lines upstream, and easy to mistake for a
// no-op alias of `parser.Parser`. It is not, and the difference is load-bearing for
// this port's most common code path.
//
// `sqlglot/dialects/dialect.py:824` sets `Dialect.parser_class = BaseParser`, and
// `_Dialect.__new__` (py:297) falls THROUGH to that declaration for any dialect that
// does not name its own `Parser`. Every `parsers/<dialect>.py` subclasses
// `parser.Parser` directly, so `BaseParser` is used by exactly one thing — the DEFAULT
// dialect — which is also the dialect `exp.select(...)`, `maybe_parse`, and every
// unqualified `parse_one` reach. Pointing `parser_class` at `parser.Parser` instead
// parses `SELECT LOCALTIME` as a `Column`, where CPython gives `Localtime()`; those
// rows are visible in `spike/p3/fuzz_ast_coverage.mjs` as `_default` MISMATCHes.
//
// The four additions and two subtractions below are the whole file. Verified against
// the pinned tree rather than inferred: `spike/out/dialect_defaults.json` records
// `parser_class: "BaseParser"` / `parser_class_module: "sqlglot.parsers.base"` from a
// live CPython read, so which class upstream picked is measured, not read off a name.

import { Parser, setDiff } from "../parser.js";
import { TokenType } from "../tokens.js";
import * as exp from "../expressions/index.js";

/** py: sqlglot/parsers/base.py:7 */
export class BaseParser extends Parser {
  static NO_PAREN_FUNCTIONS = new Map([
    ...Parser.NO_PAREN_FUNCTIONS,
    [TokenType.LOCALTIME, exp.Localtime],
    [TokenType.LOCALTIMESTAMP, exp.Localtimestamp],
    [TokenType.CURRENT_CATALOG, exp.CurrentCatalog],
    [TokenType.SESSION_USER, exp.SessionUser],
  ]);

  static ID_VAR_TOKENS = setDiff(Parser.ID_VAR_TOKENS, new Set([TokenType.STRAIGHT_JOIN]));
  static TABLE_ALIAS_TOKENS = setDiff(
    Parser.TABLE_ALIAS_TOKENS,
    new Set([TokenType.STRAIGHT_JOIN]),
  );
}
