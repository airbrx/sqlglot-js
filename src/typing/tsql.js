// py: sqlglot/typing/tsql.py @ 91119bc — WHOLE FILE (37 LOC), AIR-2099.
//
// TSQL's per-dialect type-inference overlay: a 14-key `EXPRESSION_METADATA` table
// layered on the base 294-entry `typing/index.js` table (AIR-2096/R51), the same
// `{**EXPRESSION_METADATA, **{...}}` merge shape `typing/snowflake.js` (R66) already
// established. Two `annotator` entries reuse the already-ported `TypeAnnotator.
// _annotate_by_args` (`src/optimizer/annotate_types.js`, R54) directly.

import * as exp from "../expressions/index.js";
import { EXPRESSION_METADATA as BASE_EXPRESSION_METADATA } from "./index.js";

/**
 * py:6-36 `EXPRESSION_METADATA = {**EXPRESSION_METADATA, **{...}}` — a `Map`, seeded
 * from the base table and then overlaid with TSQL's own 14 keys, in upstream's own
 * top-to-bottom order.
 */
export const EXPRESSION_METADATA = new Map(BASE_EXPRESSION_METADATA);

const setEach = (classesIter, value) => {
  for (const c of classesIter) EXPRESSION_METADATA.set(c, value);
};

// py:8-18
setEach(
  [exp.Acos, exp.Asin, exp.Atan, exp.Atan2, exp.Cos, exp.Cot, exp.Sin, exp.Tan],
  { returns: exp.DType.FLOAT },
);

// py:19-25
setEach([exp.Soundex, exp.Stuff], { returns: exp.DType.VARCHAR });

// py:26-32
setEach(
  [exp.Degrees, exp.Radians],
  { annotator: (self, e) => self._annotate_by_args(e, "this") },
);

// py:33
EXPRESSION_METADATA.set(exp.CurrentTimezone, { returns: exp.DType.NVARCHAR });
// py:34
EXPRESSION_METADATA.set(exp.CurrentTimestamp, { returns: exp.DType.DATETIME });
