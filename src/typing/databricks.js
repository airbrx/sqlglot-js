// py: sqlglot/typing/databricks.py @ 91119bc — WHOLE FILE (43 LOC), AIR-2100, epic
// AIR-2085.
//
// Link 4 of 4, the LEAF of the `Hive <- Spark2 <- Spark <- Databricks` typing-overlay
// chain — see `typing/hive.js`'s own header for the overlay-merge scheme and R66's
// precedent this reuses unchanged. Seeds its `Map` from `typing/spark.js`'s table
// (Link 3) and layers Databricks's own new keys / overrides on top. No module-level
// helper this time — every entry is a plain `returns` group, a bare fixed-type entry,
// or one inline-lambda builder (`RegexpExtractAll`).

import * as exp from "../expressions/index.js";
import { EXPRESSION_METADATA as SPARK_EXPRESSION_METADATA } from "./spark.js";

/**
 * py:6-43 `EXPRESSION_METADATA = {**EXPRESSION_METADATA, **{...}}` — a `Map`, seeded
 * from `typing/spark.js`'s table (Link 3) and then overlaid with Databricks's own new
 * keys, in upstream's own top-to-bottom order.
 */
export const EXPRESSION_METADATA = new Map(SPARK_EXPRESSION_METADATA);

const setEach = (classesIter, value) => {
  for (const c of classesIter) EXPRESSION_METADATA.set(c, value);
};

// py:8-19
setEach(
  [
    exp.RegrAvgx,
    exp.RegrAvgy,
    exp.RegrIntercept,
    exp.RegrR2,
    exp.RegrSlope,
    exp.RegrSxx,
    exp.RegrSxy,
    exp.RegrSyy,
    exp.Rint,
  ],
  { returns: exp.DType.DOUBLE },
);

// py:20-25
setEach([exp.RegexpCount, exp.RegexpInstr], { returns: exp.DType.INT });

// py:26-31
setEach([exp.RegexpSubstr, exp.Secret], { returns: exp.DType.VARCHAR });

// py:32
EXPRESSION_METADATA.set(exp.RegrCount, { returns: exp.DType.BIGINT });
// py:33
EXPRESSION_METADATA.set(exp.Search, { returns: exp.DType.BOOLEAN });
// py:34-36
EXPRESSION_METADATA.set(exp.RegexpExtractAll, {
  annotator: (self, e) => self._set_type(e, exp.DataType.fromStr("ARRAY<STRING>", { dialect: "databricks" })),
});
