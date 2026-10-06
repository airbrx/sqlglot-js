// py: sqlglot/typing/duckdb.py @ 91119bc — WHOLE FILE (64 LOC), AIR-2099.
//
// DuckDB's per-dialect type-inference overlay: a 24-key `EXPRESSION_METADATA` table
// layered on the base 294-entry `typing/index.js` table (AIR-2096/R51), the same
// `{**EXPRESSION_METADATA, **{...}}` merge shape `typing/snowflake.js` (R66) already
// established. Two `annotator` entries reuse the already-ported `TypeAnnotator.
// _annotate_by_args` (`src/optimizer/annotate_types.js`, R54) directly, no new
// module-level helper needed.

import * as exp from "../expressions/index.js";
import { EXPRESSION_METADATA as BASE_EXPRESSION_METADATA } from "./index.js";

/**
 * py:6-63 `EXPRESSION_METADATA = {**EXPRESSION_METADATA, **{...}}` — a `Map`, seeded
 * from the base table and then overlaid with DuckDB's own 24 keys, in upstream's own
 * top-to-bottom order.
 */
export const EXPRESSION_METADATA = new Map(BASE_EXPRESSION_METADATA);

const setEach = (classesIter, value) => {
  for (const c of classesIter) EXPRESSION_METADATA.set(c, value);
};

// py:8-26
setEach(
  [
    exp.BitLength,
    exp.DateDiff,
    exp.Day,
    exp.DayOfMonth,
    exp.DayOfWeek,
    exp.DayOfWeekIso,
    exp.DayOfYear,
    exp.Extract,
    exp.Hour,
    exp.Length,
    exp.Minute,
    exp.Month,
    exp.Quarter,
    exp.Second,
    exp.Week,
    exp.Year,
  ],
  { returns: exp.DType.BIGINT },
);

// py:27-34
setEach([exp.CountIf, exp.Factorial], { returns: exp.DType.INT128 });

// py:35-42
setEach([exp.Atan2, exp.JarowinklerSimilarity, exp.TimeToUnix], { returns: exp.DType.DOUBLE });

// py:43-49
setEach([exp.Format, exp.Reverse, exp.Decode], { returns: exp.DType.VARCHAR });

// py:50-56
setEach([exp.Encode, exp.Unhex], { returns: exp.DType.VARBINARY });

// py:57
EXPRESSION_METADATA.set(exp.DateBin, { annotator: (self, e) => self._annotate_by_args(e, "expression") });
// py:58
EXPRESSION_METADATA.set(exp.PercentileDisc, { annotator: (self, e) => self._annotate_by_args(e, "this") });
// py:59
EXPRESSION_METADATA.set(exp.Localtimestamp, { returns: exp.DType.TIMESTAMP });
// py:60
EXPRESSION_METADATA.set(exp.ToDays, { returns: exp.DType.INTERVAL });
// py:61
EXPRESSION_METADATA.set(exp.TimeFromParts, { returns: exp.DType.TIME });
