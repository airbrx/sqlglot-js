// py: sqlglot/typing/postgres.py @ 91119bc — WHOLE FILE (37 LOC), AIR-2099.
//
// Postgres's per-dialect type-inference overlay: a 14-key `EXPRESSION_METADATA` table
// layered on the base 294-entry `typing/index.js` table (AIR-2096/R51), the same
// `{**EXPRESSION_METADATA, **{...}}` merge shape `typing/snowflake.js` (R66) already
// established — reproduced here with `new Map(BASE_EXPRESSION_METADATA)` seeded first
// and every `.set()` call below running in upstream's own top-to-bottom order.
//
// No `_annotate_*` helpers: every upstream entry is a plain `{"returns": DType}`.

import * as exp from "../expressions/index.js";
import { EXPRESSION_METADATA as BASE_EXPRESSION_METADATA } from "./index.js";

/**
 * py:7-36 `EXPRESSION_METADATA = {**EXPRESSION_METADATA, **{...}}` — a `Map`, seeded
 * from the base table and then overlaid with Postgres's own 14 keys, in upstream's
 * own top-to-bottom order.
 */
export const EXPRESSION_METADATA = new Map(BASE_EXPRESSION_METADATA);

const setEach = (classesIter, value) => {
  for (const c of classesIter) EXPRESSION_METADATA.set(c, value);
};

// py:9-14
setEach([exp.Ntile, exp.WidthBucket], { returns: exp.DType.INT });

// py:15-27
setEach(
  [
    exp.Encode,
    exp.Left,
    exp.Right,
    exp.Overlay,
    exp.Reverse,
    exp.Pad,
    exp.Format,
    exp.Hex,
    exp.SplitPart,
    exp.Normalize,
  ],
  { returns: exp.DType.TEXT },
);

// py:28-33
setEach([exp.Decode], { returns: exp.DType.VARBINARY });

// py:34
EXPRESSION_METADATA.set(exp.ToNumber, { returns: exp.DType.DECIMAL });
