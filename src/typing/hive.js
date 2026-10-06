// py: sqlglot/typing/hive.py @ 91119bc — WHOLE FILE (82 LOC), AIR-2100, epic AIR-2085.
//
// Root of the four-link `Hive <- Spark2 <- Spark <- Databricks` typing-overlay chain
// (`src/dialects/{hive,spark2,spark,databricks}.js` already establish this chain for
// dialect settings; `src/parsers/` and `src/generators/` already established it for
// grammar/generation — see those files' own headers). Same overlay shape R66
// (`src/typing/snowflake.js`) already established: seed a `Map` from the base
// `typing/index.js` table (AIR-2096/R51), then layer this dialect's own new keys /
// overrides on top in upstream's own top-to-bottom `{**EXPRESSION_METADATA, **{...}}`
// merge order, so a later `.set()` for a key the base table already has overrides it
// exactly the way a later `**` entry overrides an earlier one in Python dict-merge
// semantics. `TypeAnnotator` (`src/optimizer/annotate_types.js`, AIR-2097/R54) is
// already ported, so every entry below is real, callable logic from the moment this
// file lands, not a closure with no `self` to call yet.

import * as exp from "../expressions/index.js";
import { EXPRESSION_METADATA as BASE_EXPRESSION_METADATA } from "./index.js";

/**
 * py:242-564-equivalent for this file: `EXPRESSION_METADATA = {**EXPRESSION_METADATA,
 * **{...}}` (py:5-81) — a `Map`, seeded from the base table (`typing/index.js`) and
 * then overlaid with Hive's own new keys, in upstream's own top-to-bottom order.
 */
export const EXPRESSION_METADATA = new Map(BASE_EXPRESSION_METADATA);

const setEach = (classesIter, value) => {
  for (const c of classesIter) EXPRESSION_METADATA.set(c, value);
};

// py:7-13
setEach([exp.Encode, exp.Unhex], { returns: exp.DType.BINARY });

// py:14-21
setEach([exp.Corr, exp.MonthsBetween, exp.Sign], { returns: exp.DType.DOUBLE });

// py:22-35
setEach(
  [
    exp.AddMonths,
    exp.CurrentDatabase,
    exp.Hex,
    exp.JSONExtractScalar,
    exp.JSONFormat,
    exp.NextDay,
    exp.RegexpExtract,
    exp.RegexpReplace,
    exp.Replace,
    exp.Soundex,
  ],
  { returns: exp.DType.VARCHAR },
);

// py:36-42
setEach([exp.Factorial, exp.IntDiv, exp.StrToUnix], { returns: exp.DType.BIGINT });

// py:43-53
setEach(
  [
    exp.ArraySize,
    exp.DenseRank,
    exp.Month,
    exp.Ntile,
    exp.Rank,
    exp.RowNumber,
    exp.Second,
    exp.Minute,
  ],
  { returns: exp.DType.INT },
);

// py:54-63
setEach(
  [exp.ArrayDistinct, exp.ArrayExcept, exp.First, exp.Last, exp.Negative, exp.Reverse],
  { annotator: (self, e) => self._annotate_by_args(e, "this") },
);

// py:64
EXPRESSION_METADATA.set(exp.ArrayIntersect, { annotator: (self, e) => self._annotate_by_args(e, "expressions") });
// py:65
EXPRESSION_METADATA.set(exp.ApproxQuantile, { annotator: (self, e) => self._annotate_by_args(e, "quantile") });
// py:66-68
EXPRESSION_METADATA.set(exp.Coalesce, {
  annotator: (self, e) => self._annotate_by_args(e, "this", "expressions", { promote: true }),
});
// py:69
EXPRESSION_METADATA.set(exp.Grouping, { returns: exp.DType.BIGINT });
// py:70
EXPRESSION_METADATA.set(exp.If, {
  annotator: (self, e) => self._annotate_by_args(e, "true", "false", { promote: true }),
});
// py:71
EXPRESSION_METADATA.set(exp.PercentileDisc, { returns: exp.DType.DOUBLE });
// py:72
EXPRESSION_METADATA.set(exp.Quantile, { annotator: (self, e) => self._annotate_by_args(e, "quantile") });
// py:73
EXPRESSION_METADATA.set(exp.RegexpSplit, { returns: exp.DataType.fromStr("ARRAY<STRING>") });
// py:74
EXPRESSION_METADATA.set(exp.StrToMap, { returns: exp.DataType.fromStr("MAP<STRING, STRING>") });
// py:75
EXPRESSION_METADATA.set(exp.WithinGroup, { annotator: (self, e) => self._annotate_by_args(e, "this") });
