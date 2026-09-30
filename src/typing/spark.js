// py: sqlglot/typing/spark.py @ 91119bc — WHOLE FILE (56 LOC), AIR-2100, epic AIR-2085.
//
// Link 3 of 4 in the `Hive <- Spark2 <- Spark <- Databricks` typing-overlay chain — see
// `typing/hive.js`'s own header for the overlay-merge scheme and R66's precedent this
// reuses unchanged. Seeds its `Map` from `typing/spark2.js`'s table (Link 2) and layers
// Spark's own new keys / overrides on top. No module-level helper this time — every
// entry is a plain `returns` group or a bare `_annotate_by_args(e, "this")` closure.

import * as exp from "../expressions/index.js";
import { EXPRESSION_METADATA as SPARK2_EXPRESSION_METADATA } from "./spark2.js";

/**
 * py:8-56 `EXPRESSION_METADATA = {**EXPRESSION_METADATA, **{...}}` — a `Map`, seeded
 * from `typing/spark2.js`'s table (Link 2) and then overlaid with Spark's own new keys,
 * in upstream's own top-to-bottom order.
 */
export const EXPRESSION_METADATA = new Map(SPARK2_EXPRESSION_METADATA);

const setEach = (classesIter, value) => {
  for (const c of classesIter) EXPRESSION_METADATA.set(c, value);
};

// py:10-16
setEach([exp.BitmapConstructAgg, exp.ToBinary], { returns: exp.DType.BINARY });

// py:17-25. 2-arg `date_add(startDate, numDays)` / `date_sub` are routed to `TsOrDsAdd`
// by Hive/Spark parsers; both return DATE per the Spark and Databricks contracts.
setEach([exp.DateFromUnixDate, exp.TsOrDsAdd], { returns: exp.DType.DATE });

// py:26-30
setEach([exp.Sec], { returns: exp.DType.DOUBLE });

// py:31-38
setEach(
  [exp.Collation, exp.CurrentTimezone, exp.Randstr, exp.ToChar],
  { returns: exp.DType.VARCHAR },
);

// py:39-48
setEach(
  [
    exp.ArrayCompact,
    exp.ArrayInsert,
    exp.BitwiseAndAgg,
    exp.BitwiseOrAgg,
    exp.BitwiseXorAgg,
    exp.Left,
    exp.Overlay,
  ],
  { annotator: (self, e) => self._annotate_by_args(e, "this") },
);

// py:49
EXPRESSION_METADATA.set(exp.BitmapCount, { returns: exp.DType.BIGINT });
// py:50
EXPRESSION_METADATA.set(exp.Grouping, { returns: exp.DType.TINYINT });
// py:51
EXPRESSION_METADATA.set(exp.Localtimestamp, { returns: exp.DType.TIMESTAMPNTZ });
