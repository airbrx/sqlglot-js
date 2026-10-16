// py: sqlglot/parsers/tableau.py @ 91119bc — WHOLE FILE (16 LOC), AIR-2292 (epic
// AIR-2272, "12.7 Small dialects", batch B).
//
// `class TableauParser(parser.Parser)` — the READ-side Tableau SQL grammar. Lands
// in the same round as `dialects/tableau.py` (`src/dialects/tableau.js`) and
// `generators/tableau.py` (`src/generators/tableau.js`). Self-contained: extends
// the base `Parser` directly.

import { Parser } from "../parser.js";
import * as exp from "../expressions/index.js";
import { seqGet } from "../helper.js";

/** py: sqlglot/parsers/tableau.py:7 `class TableauParser(parser.Parser)`. */
export class TableauParser extends Parser {
  /** py:8 */
  static FUNCTIONS = new Map([
    ...Parser.FUNCTIONS,
    ["COUNTD", (args) => new exp.Count({ this: new exp.Distinct({ expressions: args }) })],
    ["FIND", exp.StrPosition.from_arg_list],
    ["FINDNTH", (args) => new exp.StrPosition({
      this: seqGet(args, 0),
      substr: seqGet(args, 1),
      occurrence: seqGet(args, 2),
    })],
  ]);

  /** py:14 */
  static NO_PAREN_IF_COMMANDS = false;
}
