// py: sqlglot/dialects/dune.py @ 91119bc — WHOLE FILE, AIR-2287 (epic AIR-2272,
// "12.2 Presto family"), part 2 of the chain, last link ("Dune(Trino)" per the
// brief — Dune extends Trino directly, not Presto).
//
// SETTINGS ONLY, same split as Presto/Trino: `sqlglot/parsers/dune.py` (7 LOC) lands
// in `src/parsers/dune.js`, `sqlglot/generators/dune.py` (14 LOC) in
// `src/generators/dune.js`, both in this same round.
//
// `HEX_STRINGS = ["0x", ("X'", "'")]` (py:13) mixes a bare string with a pair, same
// shape `_convert_quotes` (`tokens.js`) already handles for every other dialect's
// `HEX_STRINGS`/`QUOTES`/`IDENTIFIERS`: a bare string becomes its own self-delimited
// pair. The actual `0x...` numeric hex-literal scan (`_scan_hex` in
// `tokenizer_core.js`) hardcodes the `0`+`x`/`X` prefix independent of this list's
// text; `HEX_STRINGS` here only toggles `has_hex_strings` true and additionally
// registers the quote-style `X'...'` form — ported verbatim, not re-derived.

import { initTokenizerSubclass } from "../tokens.js";
import { DuneParser } from "../parsers/dune.js";
import { DuneGenerator } from "../generators/dune.js";
import { Dialects, registerDialect } from "./dialect.js";
import { Trino } from "./trino.js";

/** py: sqlglot/dialects/dune.py:12 `class Tokenizer(Trino.Tokenizer)`. */
class DuneTokenizer extends Trino.Tokenizer {
  /** py:13 */
  static HEX_STRINGS = ["0x", ["X'", "'"]];
}
initTokenizerSubclass(DuneTokenizer);

/** py: sqlglot/dialects/dune.py:9 `class Dune(Trino)`. */
export class Dune extends Trino {
  /** py:10 `Parser = DuneParser`. */
  static Parser = DuneParser;

  /** py:12 `class Tokenizer(Trino.Tokenizer)`; see `DuneTokenizer` above. */
  static Tokenizer = DuneTokenizer;

  /** py:15 `Generator = DuneGenerator`. */
  static Generator = DuneGenerator;
}

// py: upstream registers implicitly, via the `_Dialect` metaclass running on the
// class body above.
registerDialect(Dialects.DUNE, Dune);
