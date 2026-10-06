// py: sqlglot/typing/spark2.py @ 91119bc — WHOLE FILE (88 LOC), AIR-2100, epic AIR-2085.
//
// Link 2 of 4 in the `Hive <- Spark2 <- Spark <- Databricks` typing-overlay chain — see
// `typing/hive.js`'s own header for the overlay-merge scheme and R66's precedent this
// reuses unchanged. Seeds its `Map` from `typing/hive.js`'s table (not the base
// `typing/index.js` table directly — matching upstream's own `from sqlglot.typing.hive
// import EXPRESSION_METADATA as HIVE_EXPRESSION_METADATA`) and layers Spark2's own new
// keys / overrides on top.
//
// `_annotate_by_similar_args` (py:16-40) is a module-level helper, not a `TypeAnnotator`
// method — matching upstream's own `self: TypeAnnotator` first-parameter convention,
// same as every `_annotate_*` helper in `typing/snowflake.js` (R66).

import * as exp from "../expressions/index.js";
import { ensureList } from "../helper.js";
import { EXPRESSION_METADATA as HIVE_EXPRESSION_METADATA } from "./hive.js";

/**
 * py:16-40 `_annotate_by_similar_args`. Type inference for CONCAT-family expressions
 * (CONCAT, LPAD, RPAD).
 *
 * - All-BINARY -> BINARY (the binary overload).
 * - Otherwise, if any arg has a known, non-array, non-binary type -> STRING. Spark
 *   coerces scalars (dates, ints, etc.) to string when mixed with a string-resolving
 *   arg. The binary exclusion preserves the binary+unknown case as UNKNOWN: Spark can't
 *   disambiguate the string vs. binary overload there.
 * - Else -> UNKNOWN. Covers all-unknown, binary+unknown, and anything involving arrays
 *   (array handling is intentionally out of scope here).
 */
function _annotate_by_similar_args(self, expression, ...argKeys) {
  const argExprs = [];
  for (const key of argKeys) {
    for (const e of ensureList(expression.args[key])) {
      if (e) argExprs.push(e);
    }
  }

  let result;
  if (argExprs.length && argExprs.every((e) => e.isType(exp.DType.BINARY))) {
    result = exp.DType.BINARY;
  } else if (
    argExprs.some(
      (e) => e.type !== null && e.type !== undefined
        && !e.isType(exp.DType.UNKNOWN, exp.DType.ARRAY, exp.DType.BINARY),
    )
  ) {
    result = exp.DType.TEXT;
  } else {
    result = exp.DType.UNKNOWN;
  }

  self._set_type(expression, result);
  return expression;
}

/**
 * py:43-88 `EXPRESSION_METADATA = {**HIVE_EXPRESSION_METADATA, **{...}}` — a `Map`,
 * seeded from `typing/hive.js`'s table (Link 1) and then overlaid with Spark2's own new
 * keys, in upstream's own top-to-bottom order.
 */
export const EXPRESSION_METADATA = new Map(HIVE_EXPRESSION_METADATA);

const setEach = (classesIter, value) => {
  for (const c of classesIter) EXPRESSION_METADATA.set(c, value);
};

// py:45-51
setEach([exp.Atan2, exp.Randn], { returns: exp.DType.DOUBLE });

// py:52-58
setEach([exp.Format, exp.Right], { returns: exp.DType.VARCHAR });

// py:59-66
setEach(
  [exp.ArrayFilter, exp.Shuffle, exp.Substring],
  { annotator: (self, e) => self._annotate_by_args(e, "this") },
);

// py:67-73
setEach([exp.Nanvl], { returns: exp.DType.DOUBLE });

// py:74
EXPRESSION_METADATA.set(exp.AddMonths, { returns: exp.DType.DATE });
// py:75-78
EXPRESSION_METADATA.set(exp.ApproxQuantile, {
  annotator: (self, e) => self._annotate_by_args(e, "this", { array: e.args.quantile.isType(exp.DType.ARRAY) }),
});
// py:79
EXPRESSION_METADATA.set(exp.AtTimeZone, { returns: exp.DType.TIMESTAMP });
// py:80
EXPRESSION_METADATA.set(exp.Concat, { annotator: (self, e) => _annotate_by_similar_args(self, e, "expressions") });
// py:81
EXPRESSION_METADATA.set(exp.NextDay, { returns: exp.DType.DATE });
// py:82-84
EXPRESSION_METADATA.set(exp.Pad, {
  annotator: (self, e) => _annotate_by_similar_args(self, e, "this", "fill_pattern"),
});
