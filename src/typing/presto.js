// py: sqlglot/typing/presto.py @ 91119bc — WHOLE FILE (37 LOC), AIR-2287.
//
// Presto's per-dialect type-inference overlay: an 8-key `EXPRESSION_METADATA` table
// layered on the base 294-entry `typing/index.js` table (AIR-2096/R51), the same
// `{**EXPRESSION_METADATA, **{...}}` merge shape `typing/postgres.js` (R51) and
// `typing/snowflake.js` (R66) already established — reproduced here with
// `new Map(BASE_EXPRESSION_METADATA)` seeded first and every `.set()` call below
// running in upstream's own top-to-bottom order.

import * as exp from "../expressions/index.js";
import { EXPRESSION_METADATA as BASE_EXPRESSION_METADATA } from "./index.js";

/**
 * py:6-37 `EXPRESSION_METADATA = {**EXPRESSION_METADATA, **{...}}` — a `Map`, seeded
 * from the base table and then overlaid with Presto's own 8 keys, in upstream's own
 * top-to-bottom order.
 */
export const EXPRESSION_METADATA = new Map(BASE_EXPRESSION_METADATA);

const setEach = (classesIter, value) => {
  for (const c of classesIter) EXPRESSION_METADATA.set(c, value);
};

// py:9-19
setEach(
  [
    exp.BitwiseAnd,
    exp.BitwiseNot,
    exp.BitwiseOr,
    exp.BitwiseXor,
    exp.Length,
    exp.Levenshtein,
    exp.StrPosition,
    exp.WidthBucket,
  ],
  { returns: exp.DType.BIGINT },
);

// py:21-29
setEach([exp.Ceil, exp.Floor, exp.Round, exp.Sign], {
  annotator: (self, e) => self._annotate_by_args(e, "this"),
});

// py:30
EXPRESSION_METADATA.set(exp.Mod, {
  annotator: (self, e) => self._annotate_by_args(e, "this", "expression"),
});

// py:31-35
EXPRESSION_METADATA.set(exp.Rand, {
  annotator: (self, e) =>
    e.this ? self._annotate_by_args(e, "this") : self._set_type(e, exp.DType.DOUBLE),
});

// py:36
EXPRESSION_METADATA.set(exp.MD5Digest, { returns: exp.DType.VARBINARY });
