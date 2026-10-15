// py: sqlglot/parsers/dune.py @ 91119bc — WHOLE FILE (7 LOC), AIR-2287 (epic
// AIR-2272, "12.2 Presto family"), part 2 of the chain, last link ("Dune(Trino)" per
// the brief). `class DuneParser(TrinoParser): pass` — a pure passthrough subclass,
// no grammar of its own; `src/dialects/dune.js`/`src/generators/dune.js` are the two
// files that actually carry Dune-specific behavior (hex-string literal syntax, a
// couple of generator settings/transforms).

import { TrinoParser } from "./trino.js";

/** py: sqlglot/parsers/dune.py:6 `class DuneParser(TrinoParser): pass`. */
export class DuneParser extends TrinoParser {}
