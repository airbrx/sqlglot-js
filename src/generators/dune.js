// py: sqlglot/generators/dune.py @ 91119bc — WHOLE FILE (14 LOC), AIR-2287 (epic
// AIR-2272, "12.2 Presto family"), part 2 of the chain, last link.
//
// `class DuneGenerator(TrinoGenerator)` — two settings (`TRY_SUPPORTED = False`,
// `SUPPORTS_UESCAPE = False`) and one `TRANSFORMS` entry rendering `exp.HexString` as
// Dune's own `0x...` literal syntax instead of the base `X'...'` form.

import * as exp from "../expressions/index.js";
import { TrinoGenerator } from "./trino.js";

/** py: sqlglot/generators/dune.py:7 `class DuneGenerator(TrinoGenerator)`. */
export class DuneGenerator extends TrinoGenerator {
  static TRY_SUPPORTED = false;
  static SUPPORTS_UESCAPE = false;

  static TRANSFORMS = new Map([
    ...TrinoGenerator.TRANSFORMS,
    // deny:implicit_str sqlglot/generators/dune.py:13 — py: `f"0x{e.this}"`. The
    // manifest flags this at "medium" confidence ("`.this` is an Expr arg"), but
    // `exp.HexString` is one of the `isPrimitive: true` leaf expression classes
    // (`src/_gen/expr_meta.js`'s `"hexstring"` entry): `.this` holds the raw hex-digit
    // STRING, not an Expr, the same contract `generators/duckdb.js`'s own
    // `arg.this` → `exp.Literal.string(arg.this)` usage already relies on. A bare
    // template literal is therefore safe here, not a missed `.sql()` call.
    [exp.HexString, (self, e) => `0x${e.this}`],
  ]);
}
