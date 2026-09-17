// py: sqlglot/typing/__init__.py @ 91119bc — WHOLE FILE (379 LOC).
//
// The base `EXPRESSION_METADATA` type-inference/validation table: a 294-entry map
// from expression CLASS to either `{returns: DType}` (a fixed result type) or
// `{annotator: fn}` (a `(self, e) => ...` that routes to a private method upstream's
// `TypeAnnotator` class defines). `TypeAnnotator` itself lives in
// `sqlglot/optimizer/annotate_types.py` (AIR-2097/2098, unported) — this file has NO
// consumer in this port yet, same "genuinely greenfield" shape `schema.js` and
// `transforms.js` established (PORT_PLAN.md). The `annotator` closures below are
// stored verbatim, calling `self._annotate_binary(e)` etc. by the exact upstream
// method name (this project's established convention: instance methods, including
// underscore-prefixed private ones, keep their Python spelling — `parser.js`/
// `generator.js` are full of `_parse_x`/`_x_sql` — so when `annotate_types.js` lands,
// zero renaming is needed here). Calling one of these lambdas today throws only
// because `self` has no such method yet; the TABLE itself is real data, fully usable
// as a registry independent of that future consumer.
//
// `py:7 ExprMetadataType = dict[Type[exp.Expr], dict[str, t.Any]]` is a type alias
// only, with no runtime behaviour — not ported, matching this project's convention of
// dropping type-only annotations.
//
// `helper.subclasses(module_name, classes)` (py:21/26) needs a runtime registry of
// candidate classes; `sqlglot/helper.py`'s version introspects the live `sqlglot.exp`
// module with `inspect.getmembers`, which JS has no equivalent of. `src/helper.js`'s
// ported `subclasses` already documents the DEVIATION: callers pass an explicit
// registry. `Object.values(exp.EXPR_CLASSES)` is that registry here — verified against
// CPython's own `subclasses(exp.__name__, exp.Binary)` (65) and
// `subclasses(exp.__name__, (exp.Unary, exp.Alias, exp.IgnoreNulls, exp.RespectNulls))`
// (9) by `spike/p7/gen_typing_ref.py`.
//
// `Dialect.EXPRESSION_METADATA` (`src/dialects/dialect.js`) stays an empty `Map` even
// though this file now exists: its own comment blames the unported
// `annotate_types.py`, and that blame is accurate for BEHAVIOUR (nothing can annotate
// a type without `TypeAnnotator`) even though this file — not `annotate_types.py` — is
// the literal source `Dialect.EXPRESSION_METADATA = EXPRESSION_METADATA.copy()` (py:34,
// py:957) would copy from. Wiring it here would touch ~11 dialect files with an inert
// `Map` no code reads yet, is out of this issue's stated scope, and is left for the
// `annotate_types.js` port (AIR-2097/2098) to do alongside its own real consumer.

import * as exp from "../expressions/index.js";
import { subclasses } from "../helper.js";

// py:9-16
export const TIMESTAMP_EXPRESSIONS = new Set([
  exp.CurrentTimestamp,
  exp.StrToTime,
  exp.TimeStrToTime,
  exp.TimestampAdd,
  exp.TimestampSub,
  exp.UnixToTime,
]);

const REGISTRY = Object.values(exp.EXPR_CLASSES);

function annotateBinary(self, e) {
  return self._annotate_binary(e);
}
function annotateUnary(self, e) {
  return self._annotate_unary(e);
}
function annotateByArgsThis(self, e) {
  return self._annotate_by_args(e, "this");
}
function annotateByArgsThisExpressions(self, e) {
  return self._annotate_by_args(e, "this", "expressions");
}
function annotateByArrayElement(self, e) {
  return self._annotate_by_array_element(e);
}
function annotateTimeunit(self, e) {
  return self._annotate_timeunit(e);
}
function annotateCastTo(self, e) {
  return self._set_type(e, e.args.to);
}
function annotateMap(self, e) {
  return self._annotate_map(e);
}

/**
 * py:18 `EXPRESSION_METADATA: ExprMetadataType = {...}` — a `Map`, matching this
 * project's convention for expr-class-keyed tables (`Dialect.COERCES_TO`,
 * `Dialect.EXPRESSION_METADATA`'s own stub declaration). Built in the SAME order as
 * upstream's `**`-merge chain; a later `.set()` for the same key overrides an earlier
 * one, matching Python dict-merge semantics for duplicate keys — there are none among
 * these 294 entries, cross-checked against CPython by `spike/p7/gen_typing_ref.py`.
 */
export const EXPRESSION_METADATA = new Map();

const setEach = (classesIter, value) => {
  for (const c of classesIter) EXPRESSION_METADATA.set(c, value);
};

// py:19-22
setEach(subclasses(REGISTRY, exp.Binary), { annotator: annotateBinary });
// py:23-28
setEach(subclasses(REGISTRY, [exp.Unary, exp.Alias, exp.IgnoreNulls, exp.RespectNulls]), {
  annotator: annotateUnary,
});

// py:29-44
setEach(
  [
    exp.ApproxDistinct,
    exp.ArraySize,
    exp.CountIf,
    exp.DenseRank,
    exp.Int64,
    exp.Ntile,
    exp.Rank,
    exp.RowNumber,
    exp.UnixSeconds,
    exp.UnixMicros,
    exp.UnixMillis,
  ],
  { returns: exp.DType.BIGINT },
);

// py:45-51
setEach([exp.FromBase32, exp.FromBase64], { returns: exp.DType.BINARY });

// py:52-69
setEach(
  [
    exp.All,
    exp.Any,
    exp.Between,
    exp.Boolean,
    exp.Contains,
    exp.EndsWith,
    exp.Exists,
    exp.In,
    exp.IsInf,
    exp.IsNan,
    exp.LogicalAnd,
    exp.LogicalOr,
    exp.StartsWith,
  ],
  { returns: exp.DType.BOOLEAN },
);

// py:70-83
setEach(
  [
    exp.CurrentDate,
    exp.Date,
    exp.DateFromParts,
    exp.DateStrToDate,
    exp.DiToDate,
    exp.LastDay,
    exp.StrToDate,
    exp.TimeStrToDate,
    exp.TsOrDsToDate,
  ],
  { returns: exp.DType.DATE },
);

// py:84-92
setEach([exp.CurrentDatetime, exp.Datetime, exp.DatetimeAdd, exp.DatetimeSub], {
  returns: exp.DType.DATETIME,
});

// py:93-138
setEach(
  [
    exp.Asin,
    exp.Asinh,
    exp.Acos,
    exp.CovarPop,
    exp.CovarSamp,
    exp.Acosh,
    exp.ApproxQuantile,
    exp.Atan,
    exp.Atanh,
    exp.Avg,
    exp.Cbrt,
    exp.Cos,
    exp.Cosh,
    exp.Cot,
    exp.Degrees,
    exp.Exp,
    exp.Kurtosis,
    exp.Ln,
    exp.Log,
    exp.Pi,
    exp.Pow,
    exp.PercentileCont,
    exp.Quantile,
    exp.Radians,
    exp.Round,
    exp.SafeDivide,
    exp.Sin,
    exp.Sinh,
    exp.Sqrt,
    exp.Stddev,
    exp.StddevPop,
    exp.StddevSamp,
    exp.Rand,
    exp.Tan,
    exp.Tanh,
    exp.ToDouble,
    exp.CumeDist,
    exp.PercentRank,
    exp.Variance,
    exp.VariancePop,
    exp.Skewness,
  ],
  { returns: exp.DType.DOUBLE },
);

// py:139-164
setEach(
  [
    exp.Ascii,
    exp.BitLength,
    exp.Ceil,
    exp.DatetimeDiff,
    exp.DayOfMonth,
    exp.DayOfWeek,
    exp.DayOfYear,
    exp.Floor,
    exp.Getbit,
    exp.Hour,
    exp.TimestampDiff,
    exp.TimeDiff,
    exp.Unicode,
    exp.DateToDi,
    exp.Levenshtein,
    exp.Length,
    exp.Sign,
    exp.StrPosition,
    exp.TsOrDiToDi,
    exp.Quarter,
    exp.UnixDate,
  ],
  { returns: exp.DType.INT },
);

// py:165-174
setEach([exp.Interval, exp.JustifyDays, exp.JustifyHours, exp.JustifyInterval, exp.MakeInterval], {
  returns: exp.DType.INTERVAL,
});

// py:175-180
setEach([exp.ParseJSON], { returns: exp.DType.JSON });

// py:181-190
setEach([exp.CurrentTime, exp.Localtime, exp.Time, exp.TimeAdd, exp.TimeSub], {
  returns: exp.DType.TIME,
});

// py:191-196
setEach([exp.TimestampLtzFromParts], { returns: exp.DType.TIMESTAMPLTZ });

// py:197-203
setEach([exp.CurrentTimestampLTZ, exp.TimestampTzFromParts], { returns: exp.DType.TIMESTAMPTZ });

// py:204
setEach(TIMESTAMP_EXPRESSIONS, { returns: exp.DType.TIMESTAMP });

// py:205-217
setEach(
  [
    exp.Day,
    exp.DayOfWeekIso,
    exp.Month,
    exp.Week,
    exp.WeekOfYear,
    exp.Year,
    exp.YearOfWeek,
    exp.YearOfWeekIso,
  ],
  { returns: exp.DType.TINYINT },
);

// py:218-258
setEach(
  [
    exp.ArrayToString,
    exp.Concat,
    exp.ConcatWs,
    exp.Chr,
    exp.CurrentCatalog,
    exp.CurrentRole,
    exp.CurrentSchema,
    exp.CurrentVersion,
    exp.CurrentUser,
    exp.Dayname,
    exp.DateToDateStr,
    exp.DPipe,
    exp.GroupConcat,
    exp.Initcap,
    exp.Lower,
    exp.MD5,
    exp.Monthname,
    exp.RawString,
    exp.Repeat,
    exp.SHA,
    exp.SHA2,
    exp.SessionUser,
    exp.Space,
    exp.String,
    exp.Substring,
    exp.TimeToStr,
    exp.TimeToTimeStr,
    exp.Trim,
    exp.ToBase32,
    exp.ToBase64,
    exp.Translate,
    exp.TsOrDsToDateStr,
    exp.Typeof,
    exp.UnixToStr,
    exp.UnixToTimeStr,
    exp.Upper,
  ],
  { returns: exp.DType.VARCHAR },
);

// py:259-277
setEach(
  [
    exp.Abs,
    exp.AnyValue,
    exp.ArrayConcatAgg,
    exp.ArrayReverse,
    exp.ArraySlice,
    exp.Filter,
    exp.FirstValue,
    exp.HavingMax,
    exp.LastValue,
    exp.Limit,
    exp.NthValue,
    exp.Order,
    exp.SortArray,
    exp.Window,
  ],
  { annotator: annotateByArgsThis },
);

// py:278-288
setEach([exp.ArrayConcat, exp.Coalesce, exp.Greatest, exp.Least, exp.Max, exp.Min], {
  annotator: annotateByArgsThisExpressions,
});

// py:289-295
setEach([exp.ArrayFirst, exp.ArrayLast], { annotator: annotateByArrayElement });

// py:296
EXPRESSION_METADATA.set(exp.Anonymous, {
  annotator: (self, e) => self._set_type(e, self.schema.get_udf_type(e)),
});

// py:297-304
setEach([exp.DateAdd, exp.DateSub, exp.DateTrunc], { annotator: annotateTimeunit });

// py:305-311
setEach([exp.Cast, exp.TryCast], { annotator: annotateCastTo });

// py:312-318
setEach([exp.Map, exp.VarMap], { annotator: annotateMap });

// py:319
EXPRESSION_METADATA.set(exp.Array, {
  annotator: (self, e) => self._annotate_by_args(e, "expressions", { array: true }),
});
// py:320
EXPRESSION_METADATA.set(exp.ArrayAgg, {
  annotator: (self, e) => self._annotate_by_args(e, "this", { array: true }),
});
// py:321
EXPRESSION_METADATA.set(exp.Bracket, { annotator: (self, e) => self._annotate_bracket(e) });
// py:322-326
EXPRESSION_METADATA.set(exp.Case, {
  annotator: (self, e) =>
    self._annotate_by_args(e, ...e.args.ifs.map((ifExpr) => ifExpr.args.true), "default"),
});
// py:327-331
EXPRESSION_METADATA.set(exp.Count, {
  annotator: (self, e) => self._set_type(e, e.args.big_int ? exp.DType.BIGINT : exp.DType.INT),
});
// py:332-336
EXPRESSION_METADATA.set(exp.DateDiff, {
  annotator: (self, e) => self._set_type(e, e.args.big_int ? exp.DType.BIGINT : exp.DType.INT),
});
// py:337
EXPRESSION_METADATA.set(exp.DataType, { annotator: (_self, e) => e });
// py:338
EXPRESSION_METADATA.set(exp.Div, { annotator: (self, e) => self._annotate_div(e) });
// py:339
EXPRESSION_METADATA.set(exp.Distinct, {
  annotator: (self, e) => self._annotate_by_args(e, "expressions"),
});
// py:340
EXPRESSION_METADATA.set(exp.Dot, { annotator: (self, e) => self._annotate_dot(e) });
// py:341
EXPRESSION_METADATA.set(exp.Explode, { annotator: (self, e) => self._annotate_explode(e) });
// py:342
EXPRESSION_METADATA.set(exp.Extract, { annotator: (self, e) => self._annotate_extract(e) });
// py:343-348
EXPRESSION_METADATA.set(exp.HexString, {
  annotator: (self, e) =>
    self._set_type(e, e.args.is_integer ? exp.DType.BIGINT : exp.DType.BINARY),
});
// py:349-351
EXPRESSION_METADATA.set(exp.GenerateSeries, {
  annotator: (self, e) => self._annotate_by_args(e, "start", "end", "step", { array: true }),
});
// py:352-354
EXPRESSION_METADATA.set(exp.GenerateDateArray, {
  annotator: (self, e) => self._set_type(e, exp.DataType.fromStr("ARRAY<DATE>")),
});
// py:355-357
EXPRESSION_METADATA.set(exp.GenerateTimestampArray, {
  annotator: (self, e) => self._set_type(e, exp.DataType.fromStr("ARRAY<TIMESTAMP>")),
});
// py:358
EXPRESSION_METADATA.set(exp.If, { annotator: (self, e) => self._annotate_by_args(e, "true", "false") });
// py:359
EXPRESSION_METADATA.set(exp.Lag, {
  annotator: (self, e) => self._annotate_by_args(e, "this", "default"),
});
// py:360
EXPRESSION_METADATA.set(exp.Lead, {
  annotator: (self, e) => self._annotate_by_args(e, "this", "default"),
});
// py:361
EXPRESSION_METADATA.set(exp.Literal, { annotator: (self, e) => self._annotate_literal(e) });
// py:362
EXPRESSION_METADATA.set(exp.Null, { returns: exp.DType.NULL });
// py:363
EXPRESSION_METADATA.set(exp.Nullif, {
  annotator: (self, e) => self._annotate_by_args(e, "this", "expression"),
});
// py:364
EXPRESSION_METADATA.set(exp.PropertyEQ, {
  annotator: (self, e) => self._annotate_by_args(e, "expression"),
});
// py:365
EXPRESSION_METADATA.set(exp.Struct, { annotator: (self, e) => self._annotate_struct(e) });
// py:366-368
EXPRESSION_METADATA.set(exp.Sum, {
  annotator: (self, e) => self._annotate_by_args(e, "this", "expressions", { promote: true }),
});
// py:369-374
EXPRESSION_METADATA.set(exp.Timestamp, {
  annotator: (self, e) =>
    self._set_type(e, e.args.with_tz ? exp.DType.TIMESTAMPTZ : exp.DType.TIMESTAMP),
});
// py:375
EXPRESSION_METADATA.set(exp.ToMap, { annotator: (self, e) => self._annotate_to_map(e) });
// py:376
EXPRESSION_METADATA.set(exp.Unnest, { annotator: (self, e) => self._annotate_unnest(e) });
// py:377
EXPRESSION_METADATA.set(exp.WithinGroup, {
  annotator: (self, e) => self._annotate_within_group(e),
});
// py:378
EXPRESSION_METADATA.set(exp.Subquery, { annotator: (self, e) => self._annotate_subquery(e) });
