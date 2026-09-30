// py: sqlglot/typing/snowflake.py @ 91119bc — WHOLE FILE (564 LOC), AIR-2098.
//
// Snowflake's per-dialect type-inference overlay: 14 module-level `_annotate_*`
// helpers plus a 457-entry `EXPRESSION_METADATA` table that starts from the base
// 294-entry `typing/index.js` table (AIR-2096/R51) and layers 163 new keys on top —
// the exact `{**EXPRESSION_METADATA, **{...}}` merge order upstream uses, reproduced
// here with `new Map(BASE_EXPRESSION_METADATA)` seeded first and every `setEach`/
// `.set()` call below running in upstream's own top-to-bottom order, so a later
// `.set()` for a key the base table already has overrides it exactly the way a
// later `**` entry overrides an earlier one in Python dict-merge semantics.
//
// Unlike `typing/index.js` when IT was written (R51), this file's real consumer —
// `TypeAnnotator` (`src/optimizer/annotate_types.js`, AIR-2097/R54) — already exists,
// so every `_annotate_*` helper below is REAL, callable logic from the moment this
// file lands, not a closure with no `self` to call yet.
//
// Every private helper keeps its exact upstream spelling (module-level function here,
// not a class method — upstream's own `typing/snowflake.py` defines these as bare
// functions taking `self: TypeAnnotator` as their first parameter, unlike
// `annotate_types.py`'s own `_annotate_*` methods), per this project's established
// convention of zero renaming for ported callables.

import * as exp from "../expressions/index.js";
import { seqGet } from "../helper.js";
import { EXPRESSION_METADATA as BASE_EXPRESSION_METADATA } from "./index.js";

// py:12
const DATE_PARTS = new Set(["DAY", "WEEK", "MONTH", "QUARTER", "YEAR"]);

// py:14
const MAX_PRECISION = 38;

// py:16
const MAX_SCALE = 37;

// py:19-25
function _annotate_reverse(self, expression) {
  expression = self._annotate_by_args(expression, "this");
  if (expression.isType(exp.DType.NULL)) {
    // Snowflake treats REVERSE(NULL) as a VARCHAR
    self._set_type(expression, exp.DType.VARCHAR);
  }

  return expression;
}

/**
 * py:28-40 `_annotate_timestamp_from_parts`. Annotate TimestampFromParts with correct
 * type based on arguments.
 *   TIMESTAMP_FROM_PARTS with time_zone -> TIMESTAMPTZ
 *   TIMESTAMP_FROM_PARTS without time_zone -> TIMESTAMP (defaults to TIMESTAMP_NTZ)
 */
function _annotate_timestamp_from_parts(self, expression) {
  if (expression.args.zone) {
    self._set_type(expression, exp.DType.TIMESTAMPTZ);
  } else {
    self._set_type(expression, exp.DType.TIMESTAMP);
  }

  return expression;
}

// py:43-51
function _annotate_date_or_time_add(self, expression) {
  if (
    expression.this.isType(exp.DType.DATE)
    && !DATE_PARTS.has(expression.text("unit").toUpperCase())
  ) {
    self._set_type(expression, exp.DType.TIMESTAMPNTZ);
  } else {
    self._annotate_by_args(expression, "this");
  }
  return expression;
}

/**
 * py:54-80 `_annotate_decode_case`. Annotate DecodeCase with the type inferred from
 * return values only.
 *
 * DECODE uses the format: DECODE(expr, val1, ret1, val2, ret2, ..., default)
 * We only look at the return values (ret1, ret2, ..., default) to determine the type,
 * not the comparison values (val1, val2, ...) or the expression being compared.
 */
function _annotate_decode_case(self, expression) {
  const expressions = expression.expressions;

  // Return values are at indices 2, 4, 6, ... and the last element (if even length)
  // DECODE(expr, val1, ret1, val2, ret2, ..., default)
  const returnTypes = [];
  for (let i = 2; i < expressions.length; i += 2) returnTypes.push(expressions[i].type);

  // If the total number of expressions is even, the last one is the default
  // Example:
  //   DECODE(x, 1, 'a', 2, 'b')             -> len=5 (odd), no default
  //   DECODE(x, 1, 'a', 2, 'b', 'default')  -> len=6 (even), has default
  if (expressions.length % 2 === 0) returnTypes.push(expressions[expressions.length - 1].type);

  // Determine the common type from all return values
  let lastType = null;
  for (const retType of returnTypes) {
    lastType = self._maybe_coerce(lastType || retType, retType);
  }

  self._set_type(expression, lastType);
  return expression;
}

// py:83-88
function _annotate_arg_max_min(self, expression) {
  self._set_type(
    expression,
    expression.args.count ? exp.DType.ARRAY : expression.this.type,
  );
  return expression;
}

/**
 * py:91-108 `_annotate_within_group`. Annotate WithinGroup with correct type based on
 * the inner function.
 *
 * 1) Annotate args first
 * 2) Check if this is PercentileDisc/PercentileCont and if so, re-annotate its type to
 *    match the ordered expression's type
 */
function _annotate_within_group(self, expression) {
  const orderExpr = expression.expression;
  const orderedExpr = orderExpr instanceof exp.Order ? seqGet(orderExpr.expressions, 0) : null;

  if (
    (expression.this instanceof exp.PercentileDisc || expression.this instanceof exp.PercentileCont)
    && orderExpr instanceof exp.Order
    && orderExpr.expressions.length === 1
    && orderedExpr instanceof exp.Ordered
  ) {
    self._set_type(expression, orderedExpr.this.type);
  } else {
    self._set_type(expression, expression.this.type);
  }

  return expression;
}

/**
 * py:111-146 `_annotate_median`. Annotate MEDIAN function with correct return type.
 *
 * Based on Snowflake documentation:
 * - If the expr is FLOAT/DOUBLE -> annotate as DOUBLE (FLOAT is a synonym for DOUBLE)
 * - If the expr is NUMBER(p, s) -> annotate as NUMBER(min(p+3, 38), min(s+3, 37))
 */
function _annotate_median(self, expression) {
  // First annotate the argument to get its type
  expression = self._annotate_by_args(expression, "this");

  // Get the input type
  const inputType = expression.this.type;

  if (inputType.isType(exp.DType.DOUBLE)) {
    // If input is FLOAT/DOUBLE, return DOUBLE (FLOAT is normalized to DOUBLE in Snowflake)
    self._set_type(expression, exp.DType.DOUBLE);
  } else {
    // If input is NUMBER(p, s), return NUMBER(min(p+3, 38), min(s+3, 37))
    const exprs = inputType.expressions;

    const precisionExpr = seqGet(exprs, 0);
    const precision = precisionExpr ? precisionExpr.this.toPy() : MAX_PRECISION;

    const scaleExpr = seqGet(exprs, 1);
    const scale = scaleExpr ? scaleExpr.this.toPy() : 0;

    const newPrecision = Math.min(Number(precision) + 3, MAX_PRECISION);
    const newScale = Math.min(Number(scale) + 3, MAX_SCALE);

    // Build the new NUMBER type
    const newType = exp.DataType.fromStr(`NUMBER(${newPrecision}, ${newScale})`, { dialect: "snowflake" });
    self._set_type(expression, newType);
  }

  return expression;
}

/**
 * py:149-186 `_annotate_variance`. Annotate variance functions (VAR_POP, VAR_SAMP,
 * VARIANCE, VARIANCE_POP) with correct return type.
 *
 * Based on Snowflake behavior:
 * - DECFLOAT -> DECFLOAT(38)
 * - FLOAT/DOUBLE -> FLOAT
 * - INT, NUMBER(p, 0) -> NUMBER(38, 6)
 * - NUMBER(p, s) -> NUMBER(38, max(12, s))
 */
function _annotate_variance(self, expression) {
  // First annotate the argument to get its type
  expression = self._annotate_by_args(expression, "this");

  // Get the input type
  const inputType = expression.this.type;

  // Special case: DECFLOAT -> DECFLOAT(38)
  if (inputType.isType(exp.DType.DECFLOAT)) {
    self._set_type(expression, exp.DataType.fromStr("DECFLOAT", { dialect: "snowflake" }));
  } else if (inputType.isType(exp.DType.FLOAT, exp.DType.DOUBLE)) {
    // Special case: FLOAT/DOUBLE -> DOUBLE
    self._set_type(expression, exp.DType.DOUBLE);
  } else {
    // For NUMBER types: determine the scale
    const exprs = inputType.expressions;
    const scaleExpr = seqGet(exprs, 1);
    const scale = scaleExpr ? Number(scaleExpr.this.toPy()) : 0;

    // If scale is 0 (INT, BIGINT, NUMBER(p,0)): return NUMBER(38, 6)
    // Otherwise, Snowflake appears to assign scale through the formula MAX(12, s)
    const newScale = scale === 0 ? 6 : Math.max(12, scale);

    // Build the new NUMBER type
    const newType = exp.DataType.fromStr(`NUMBER(${MAX_PRECISION}, ${newScale})`, { dialect: "snowflake" });
    self._set_type(expression, newType);
  }

  return expression;
}

/**
 * py:189-209 `_annotate_kurtosis`. Annotate KURTOSIS with correct return type.
 *
 * Based on Snowflake behavior:
 * - DECFLOAT input -> DECFLOAT
 * - DOUBLE or FLOAT input -> DOUBLE
 * - Other numeric types (INT, NUMBER) -> NUMBER(38, 12)
 */
function _annotate_kurtosis(self, expression) {
  expression = self._annotate_by_args(expression, "this");
  const inputType = expression.this.type;

  if (inputType.isType(exp.DType.DECFLOAT)) {
    self._set_type(expression, exp.DataType.fromStr("DECFLOAT", { dialect: "snowflake" }));
  } else if (inputType.isType(exp.DType.FLOAT, exp.DType.DOUBLE)) {
    self._set_type(expression, exp.DType.DOUBLE);
  } else {
    self._set_type(
      expression,
      exp.DataType.fromStr(`NUMBER(${MAX_PRECISION}, 12)`, { dialect: "snowflake" }),
    );
  }

  return expression;
}

/**
 * py:212-229 `_annotate_math_with_float_decfloat`. Annotate math functions that
 * preserve DECFLOAT but return DOUBLE for others.
 *
 * In Snowflake, trigonometric and exponential math functions:
 * - If input is DECFLOAT -> return DECFLOAT
 * - For integer types (INT, BIGINT, etc.) -> return DOUBLE
 * - For other numeric types (NUMBER, DECIMAL, DOUBLE) -> return DOUBLE
 */
function _annotate_math_with_float_decfloat(self, expression) {
  expression = self._annotate_by_args(expression, "this");

  // If input is DECFLOAT, preserve
  if (expression.this.isType(exp.DType.DECFLOAT)) {
    self._set_type(expression, expression.this.type);
  } else {
    // For all other types (integers, decimals, etc.), return DOUBLE
    self._set_type(expression, exp.DType.DOUBLE);
  }

  return expression;
}

// py:232-239
function _annotate_str_to_time(self, expression) {
  // target_type is stored as a DataType instance
  const targetTypeArg = expression.args.target_type;
  const targetType = targetTypeArg instanceof exp.DataType ? targetTypeArg.this : exp.DType.TIMESTAMP;
  self._set_type(expression, targetType);
  return expression;
}

/**
 * py:242-564 `EXPRESSION_METADATA = {**EXPRESSION_METADATA, **{...}}` — a `Map`,
 * seeded from the base table (`typing/index.js`, AIR-2096) and then overlaid with
 * Snowflake's own 163 new keys / 44 overrides, in upstream's own top-to-bottom order
 * (cross-checked against CPython by `spike/p7/gen_typing_snowflake_ref.py`: 457 total,
 * 163 new, 44 overriding a base-table key).
 */
export const EXPRESSION_METADATA = new Map(BASE_EXPRESSION_METADATA);

const setEach = (classesIter, value) => {
  for (const c of classesIter) EXPRESSION_METADATA.set(c, value);
};

// py:244-261
setEach(
  [
    exp.AddMonths,
    exp.Ceil,
    exp.DateTrunc,
    exp.Floor,
    exp.Left,
    exp.Mode,
    exp.Pad,
    exp.Right,
    exp.Round,
    exp.Stuff,
    exp.Substring,
    exp.TimeSlice,
    exp.TimestampTrunc,
  ],
  { annotator: (self, e) => self._annotate_by_args(e, "this") },
);

// py:262-284
setEach(
  [
    exp.ApproxTopK,
    exp.ApproxTopKEstimate,
    exp.Array,
    exp.ArrayAgg,
    exp.ArrayAppend,
    exp.ArrayCompact,
    exp.ArrayConcat,
    exp.ArrayConstructCompact,
    exp.ArrayPrepend,
    exp.ArrayRemove,
    exp.ArraysZip,
    exp.ArrayUniqueAgg,
    exp.ArrayUnionAgg,
    exp.MapKeys,
    exp.RegexpExtractAll,
    exp.Split,
    exp.StringToArray,
    exp.StrtokToArray,
  ],
  { returns: exp.DType.ARRAY },
);

// py:285-299
setEach(
  [
    exp.BitmapBitPosition,
    exp.BitmapBucketNumber,
    exp.BitmapCount,
    exp.Factorial,
    exp.GroupingId,
    exp.MD5NumberLower64,
    exp.MD5NumberUpper64,
    exp.Rand,
    exp.Seq8,
    exp.Zipf,
  ],
  { returns: exp.DType.BIGINT },
);

// py:300-321
setEach(
  [
    exp.Base64DecodeBinary,
    exp.BitmapConstructAgg,
    exp.BitmapOrAgg,
    exp.Compress,
    exp.DecompressBinary,
    exp.Decrypt,
    exp.DecryptRaw,
    exp.Encrypt,
    exp.EncryptRaw,
    exp.HexString,
    exp.MD5Digest,
    exp.SHA1Digest,
    exp.SHA2Digest,
    exp.ToBinary,
    exp.TryBase64DecodeBinary,
    exp.TryHexDecodeBinary,
    exp.Unhex,
  ],
  { returns: exp.DType.BINARY },
);

// py:322-336
setEach(
  [
    exp.Booland,
    exp.Boolnot,
    exp.Boolor,
    exp.BoolxorAgg,
    exp.EqualNull,
    exp.IsNullValue,
    exp.MapContainsKey,
    exp.Search,
    exp.SearchIp,
    exp.ToBoolean,
  ],
  { returns: exp.DType.BOOLEAN },
);

// py:337-343
setEach([exp.NextDay, exp.PreviousDay], { returns: exp.DType.DATE });

// py:344-358
setEach(
  [
    exp.BitwiseAndAgg,
    exp.BitwiseOrAgg,
    exp.BitwiseXorAgg,
    exp.RegexpCount,
    exp.RegexpInstr,
    exp.ToNumber,
  ],
  { annotator: (self, e) => self._set_type(e, exp.DataType.fromStr("NUMBER", { dialect: "snowflake" })) },
);

// py:359-371
setEach(
  [
    exp.ApproxPercentileEstimate,
    exp.ApproximateSimilarity,
    exp.CosineDistance,
    exp.DotProduct,
    exp.EuclideanDistance,
    exp.ManhattanDistance,
    exp.MonthsBetween,
    exp.Normal,
  ],
  { returns: exp.DType.DOUBLE },
);

// py:372
EXPRESSION_METADATA.set(exp.Kurtosis, { annotator: _annotate_kurtosis });

// py:373-379
setEach([exp.ToDecfloat, exp.TryToDecfloat], { returns: exp.DType.DECFLOAT });

// py:380-412
setEach(
  [
    exp.Acos,
    exp.Asin,
    exp.Atan,
    exp.Atan2,
    exp.Cbrt,
    exp.Cos,
    exp.Cot,
    exp.Degrees,
    exp.Exp,
    exp.Ln,
    exp.Log,
    exp.Pow,
    exp.Radians,
    exp.RegrAvgx,
    exp.RegrAvgy,
    exp.RegrCount,
    exp.RegrIntercept,
    exp.RegrR2,
    exp.RegrSlope,
    exp.RegrSxx,
    exp.RegrSxy,
    exp.RegrSyy,
    exp.RegrValx,
    exp.RegrValy,
    exp.Sin,
    exp.Sqrt,
    exp.Tan,
    exp.Tanh,
  ],
  { annotator: _annotate_math_with_float_decfloat },
);

// py:413-432
setEach(
  [
    exp.ByteLength,
    exp.DenseRank,
    exp.Grouping,
    exp.JarowinklerSimilarity,
    exp.MapSize,
    exp.Minute,
    exp.Ntile,
    exp.Rank,
    exp.RowNumber,
    exp.RtrimmedLength,
    exp.Second,
    exp.Seq1,
    exp.Seq2,
    exp.Seq4,
    exp.WidthBucket,
  ],
  { returns: exp.DType.INT },
);

// py:433-445
setEach(
  [
    exp.ApproxPercentileAccumulate,
    exp.ApproxPercentileCombine,
    exp.ApproxTopKAccumulate,
    exp.ApproxTopKCombine,
    exp.ObjectAgg,
    exp.ParseIp,
    exp.ParseUrl,
    exp.XMLGet,
  ],
  { returns: exp.DType.OBJECT },
);

// py:446-454
setEach([exp.MapCat, exp.MapDelete, exp.MapInsert, exp.MapPick], { returns: exp.DType.MAP });

// py:455-460
setEach([exp.ToFile], { returns: exp.DType.FILE });

// py:461-467
setEach([exp.TimeFromParts, exp.TsOrDsToTime], { returns: exp.DType.TIME });

// py:468-474
setEach([exp.CurrentTimestamp, exp.Localtimestamp], { returns: exp.DType.TIMESTAMPLTZ });

// py:475-483
setEach([exp.DayOfMonth, exp.DayOfWeek, exp.DayOfYear, exp.Quarter], { returns: exp.DType.TINYINT });

// py:484-527
setEach(
  [
    exp.AIAgg,
    exp.AIClassify,
    exp.AISummarizeAgg,
    exp.Base64DecodeString,
    exp.Base64Encode,
    exp.CheckJson,
    exp.CheckXml,
    exp.Collate,
    exp.Collation,
    exp.CurrentAccount,
    exp.CurrentAccountName,
    exp.CurrentAvailableRoles,
    exp.CurrentClient,
    exp.CurrentDatabase,
    exp.CurrentIpAddress,
    exp.CurrentSchemas,
    exp.CurrentSecondaryRoles,
    exp.CurrentSession,
    exp.CurrentStatement,
    exp.CurrentTransaction,
    exp.CurrentWarehouse,
    exp.CurrentOrganizationUser,
    exp.CurrentRegion,
    exp.CurrentRoleType,
    exp.CurrentOrganizationName,
    exp.DecompressString,
    exp.HexDecodeString,
    exp.Hex,
    exp.Randstr,
    exp.RegexpExtract,
    exp.RegexpReplace,
    exp.Replace,
    exp.Soundex,
    exp.SoundexP123,
    exp.SplitPart,
    exp.Strtok,
    exp.TryBase64DecodeString,
    exp.TryHexDecodeString,
    exp.Uuid,
  ],
  { returns: exp.DType.VARCHAR },
);

// py:528-534
setEach([exp.Minhash, exp.MinhashCombine], { returns: exp.DType.VARIANT });

// py:535-541
setEach([exp.Variance, exp.VariancePop], { annotator: _annotate_variance });

// py:542
EXPRESSION_METADATA.set(exp.ArgMax, { annotator: _annotate_arg_max_min });
// py:543
EXPRESSION_METADATA.set(exp.ArgMin, { annotator: _annotate_arg_max_min });
// py:544
EXPRESSION_METADATA.set(exp.ConcatWs, { annotator: (self, e) => self._annotate_by_args(e, "expressions") });
// py:545-550
EXPRESSION_METADATA.set(exp.ConvertTimezone, {
  annotator: (self, e) => self._set_type(e, e.args.source_tz ? exp.DType.TIMESTAMPNTZ : exp.DType.TIMESTAMPTZ),
});
// py:551
EXPRESSION_METADATA.set(exp.DateAdd, { annotator: _annotate_date_or_time_add });
// py:552
EXPRESSION_METADATA.set(exp.DecodeCase, { annotator: _annotate_decode_case });
// py:553-557
EXPRESSION_METADATA.set(exp.HashAgg, {
  annotator: (self, e) => self._set_type(e, exp.DataType.fromStr("NUMBER(19, 0)", { dialect: "snowflake" })),
});
// py:558
EXPRESSION_METADATA.set(exp.Median, { annotator: _annotate_median });
// py:559
EXPRESSION_METADATA.set(exp.Reverse, { annotator: _annotate_reverse });
// py:560
EXPRESSION_METADATA.set(exp.StrToTime, { annotator: _annotate_str_to_time });
// py:561
EXPRESSION_METADATA.set(exp.TimeAdd, { annotator: _annotate_date_or_time_add });
// py:562
EXPRESSION_METADATA.set(exp.TimestampFromParts, { annotator: _annotate_timestamp_from_parts });
// py:563
EXPRESSION_METADATA.set(exp.WithinGroup, { annotator: _annotate_within_group });
