// py: sqlglot/parsers/drill.py @ 91119bc — WHOLE FILE (32 LOC), AIR-2292 (epic
// AIR-2272, "12.7 Small dialects", batch B).
//
// `class DrillParser(parser.Parser)` — the READ-side Drill (Apache Drill) SQL
// grammar. Lands in the same round as `dialects/drill.py`
// (`src/dialects/drill.js`) and `generators/drill.py` (`src/generators/
// drill.js`). Self-contained: extends the base `Parser` directly.
//
// `build_formatted_time` already exists in `src/dialects/dialect.js` from
// earlier dialect ports — no new base-helper work required here.

import { Parser } from "../parser.js";
import { TokenType } from "../tokens.js";
import { seqGet } from "../helper.js";
import * as exp from "../expressions/index.js";
import { build_formatted_time } from "../dialects/dialect.js";

/** py: sqlglot/parsers/drill.py:9 `_build_ilike(args)`. */
function _build_ilike(args) {
  const ilike = new exp.ILike({ this: seqGet(args, 0), expression: seqGet(args, 1) });
  const escape = seqGet(args, 2);
  return escape ? new exp.Escape({ this: ilike, expression: escape }) : ilike;
}

/** py: sqlglot/parsers/drill.py:15 `class DrillParser(parser.Parser)`. */
export class DrillParser extends Parser {
  /** py:16 */
  static STRICT_CAST = false;

  /** py:18 */
  static TABLE_ALIAS_TOKENS = new Set([
    ...Parser.TABLE_ALIAS_TOKENS,
    TokenType.ANTI,
    TokenType.SEMI,
  ]);

  /** py:23 */
  static FUNCTIONS = new Map([
    ...Parser.FUNCTIONS,
    ["ILIKE", _build_ilike],
    ["REPEATED_COUNT", exp.ArraySize.from_arg_list],
    ["TO_TIMESTAMP", exp.TimeStrToTime.from_arg_list],
    ["TO_CHAR", build_formatted_time(exp.TimeToStr)],
    ["LEVENSHTEIN_DISTANCE", exp.Levenshtein.from_arg_list],
  ]);

  /** py:31 */
  static LOG_DEFAULTS_TO_LN = true;
}
