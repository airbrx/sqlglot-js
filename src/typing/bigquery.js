// py: sqlglot/typing/bigquery.py @ 91119bc — WHOLE FILE (395 LOC), AIR-2099.
//
// BigQuery's per-dialect type-inference overlay, the bulk of this issue: seven
// module-level `_annotate_*` helpers plus a ~100-key `EXPRESSION_METADATA` table
// layered on the base 294-entry `typing/index.js` table (AIR-2096/R51) — the same
// `{**EXPRESSION_METADATA, **{...}}` merge shape `typing/snowflake.js` (R66) already
// established, reproduced here with `new Map(BASE_EXPRESSION_METADATA)` seeded first
// and every `setEach`/`.set()` call below running in upstream's own top-to-bottom
// order.
//
// Every private helper keeps its exact upstream spelling (module-level function here,
// not a class method, matching upstream's own bare-function shape with an explicit
// `self: TypeAnnotator` first parameter), per this project's established convention.

import * as exp from "../expressions/index.js";
import { EXPRESSION_METADATA as BASE_EXPRESSION_METADATA, TIMESTAMP_EXPRESSIONS } from "./index.js";

// py:24-30 `_DATE_FUNC_LITERAL_TYPE` — DATE_ADD / DATE_SUB / *_TRUNC return the type of
// their first argument. BigQuery implicitly casts a string literal first arg to the
// function's own temporal type, so each class maps to that type (e.g.
// DATE_ADD('2020-01-01', ...) -> DATE, TIMESTAMP_TRUNC('...') -> TIMESTAMP). A `Map`
// keyed by CLASS (not a plain object), since JS object keys cannot be class references.
const _DATE_FUNC_LITERAL_TYPE = new Map([
  [exp.DateAdd, exp.DType.DATE],
  [exp.DateSub, exp.DType.DATE],
  [exp.DateTrunc, exp.DType.DATE],
  [exp.DatetimeTrunc, exp.DType.DATETIME],
  [exp.TimestampTrunc, exp.DType.TIMESTAMPTZ],
]);

/**
 * py:33-47 `_annotate_date_func`. Annotate DATE_ADD / DATE_SUB / *_TRUNC, which return
 * their first arg's type.
 *
 * A typed first argument keeps its exact type (e.g. DATE_ADD(DATETIME, ...) ->
 * DATETIME). For a string literal first argument, BigQuery implicitly casts it to the
 * function's own temporal type, so the result is that type (e.g.
 * DATE_ADD('2020-01-01', INTERVAL 1 DAY) -> DATE).
 */
function _annotate_date_func(self, expression) {
  const thisArg = expression.this;

  // BigQuery rejects expressions like DATE_ADD(c, ...); it requires the first argument
  // to be a literal.
  if (thisArg instanceof exp.Literal && thisArg.isString) {
    return self._set_type(expression, _DATE_FUNC_LITERAL_TYPE.get(expression.constructor));
  }

  return self._annotate_by_args(expression, "this");
}

/**
 * py:50-65 `_annotate_math_functions`. Many BigQuery math functions such as CEIL,
 * FLOOR etc follow this return type convention:
 *   INT64 -> FLOAT64, NUMERIC -> NUMERIC, BIGNUMERIC -> BIGNUMERIC, FLOAT64 -> FLOAT64
 */
function _annotate_math_functions(self, expression) {
  const thisArg = expression.this;

  self._set_type(
    expression,
    thisArg.isType(...exp.DataType.INTEGER_TYPES) ? exp.DType.DOUBLE : thisArg.type,
  );
  return expression;
}

/**
 * py:68-84 `_annotate_safe_divide`.
 *   INT64/INT64 -> FLOAT64, NUMERIC/NUMERIC -> NUMERIC, BIGNUMERIC/BIGNUMERIC ->
 *   BIGNUMERIC, anything with FLOAT64 -> FLOAT64.
 */
function _annotate_safe_divide(self, expression) {
  if (
    expression.this.isType(...exp.DataType.INTEGER_TYPES)
    && expression.expression.isType(...exp.DataType.INTEGER_TYPES)
  ) {
    return self._set_type(expression, exp.DType.DOUBLE);
  }

  return _annotate_by_args_with_coerce(self, expression);
}

// py:87-99 `_annotate_by_args_with_coerce`.
function _annotate_by_args_with_coerce(self, expression) {
  self._set_type(expression, self._maybe_coerce(expression.this.type, expression.expression.type));
  return expression;
}

// py:102-113 `_annotate_by_args_approx_top`.
function _annotate_by_args_approx_top(self, expression) {
  const structType = new exp.DataType({
    this: exp.DType.STRUCT,
    expressions: [expression.this.type, new exp.DataType({ this: exp.DType.BIGINT })],
    nested: true,
  });
  self._set_type(
    expression,
    new exp.DataType({ this: exp.DType.ARRAY, expressions: [structType], nested: true }),
  );

  return expression;
}

// py:116-124 `_annotate_concat`.
function _annotate_concat(self, expression) {
  const annotated = self._annotate_by_args(expression, "expressions");

  // Args must be BYTES or types that can be cast to STRING, return type is either
  // BYTES or STRING.
  // https://cloud.google.com/bigquery/docs/reference/standard-sql/string_functions#concat
  if (!annotated.isType(exp.DType.BINARY, exp.DType.UNKNOWN)) {
    self._set_type(annotated, exp.DType.VARCHAR);
  }

  return annotated;
}

/**
 * py:127-193 `_annotate_array`. BigQuery behaves as follows:
 *
 *   SELECT t, TYPEOF(t) FROM (SELECT 'foo') AS t            -- foo, STRUCT<STRING>
 *   SELECT ARRAY(SELECT 'foo'), TYPEOF(ARRAY(SELECT 'foo')) -- foo, ARRAY<STRING>
 *   ARRAY(SELECT ... UNION ALL SELECT ...)                  -- ARRAY<coerced type>
 *   ARRAY(SELECT AS STRUCT 1 AS a, 'b' AS b)                -- ARRAY<STRUCT<INT64, STRING>>
 */
function _annotate_array(self, expression) {
  const arrayArgs = expression.expressions;

  if (arrayArgs.length === 1) {
    const unnested = arrayArgs[0].unnest();
    let projectionType = null;

    // Handle ARRAY(SELECT ...) - single SELECT query.
    if (unnested instanceof exp.Select) {
      const queryType = unnested.metaGet("query_type");

      if (queryType && queryType.isType(exp.DType.STRUCT)) {
        const queryExprs = queryType.expressions;

        const colDefs = queryExprs.filter(
          (e) => e instanceof exp.ColumnDef && !(e.kind && e.kind.isType(exp.DType.UNKNOWN)),
        );

        if (colDefs.length === queryExprs.length) {
          if (unnested.args.kind === "STRUCT") {
            // ARRAY(SELECT AS STRUCT ...) -> ARRAY<STRUCT<col1, col2, ...>>
            projectionType = queryType;
          } else if (colDefs.length === 1 && colDefs[0].kind) {
            // ARRAY(SELECT col FROM ...) -> ARRAY<col_type>
            projectionType = colDefs[0].kind;
          }
        }
      }
    } else if (unnested instanceof exp.SetOperation) {
      // Handle ARRAY(SELECT ... UNION ALL SELECT ...) - set operations.
      const colTypes = self._get_setop_column_types(unnested);
      // For ARRAY constructor, there should only be one projection.
      // https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/array_functions#array
      if (colTypes.size && unnested.left.selects.length) {
        const firstColName = unnested.left.selects[0].aliasOrName;
        projectionType = colTypes.get(firstColName) ?? null;
      }
    }

    // If we successfully determine a projection type and it's not UNKNOWN, wrap it in
    // ARRAY.
    if (
      projectionType != null
      && !(
        (projectionType instanceof exp.DataType && projectionType.isType(exp.DType.UNKNOWN))
        || projectionType === exp.DType.UNKNOWN
      )
    ) {
      const elementType = projectionType instanceof exp.DataType
        ? projectionType.copy()
        : new exp.DataType({ this: projectionType });
      const arrayType = new exp.DataType({
        this: exp.DType.ARRAY,
        expressions: [elementType],
        nested: true,
      });
      self._set_type(expression, arrayType);
      return expression;
    }
  }

  return self._annotate_by_args(expression, "expressions", { array: true });
}

/**
 * py:196-395 `EXPRESSION_METADATA = {**EXPRESSION_METADATA, **{...}}` — a `Map`, seeded
 * from the base table and then overlaid with BigQuery's own keys, in upstream's own
 * top-to-bottom order.
 */
export const EXPRESSION_METADATA = new Map(BASE_EXPRESSION_METADATA);

const setEach = (classesIter, value) => {
  for (const c of classesIter) EXPRESSION_METADATA.set(c, value);
};

// py:198-210
setEach(
  [exp.Avg, exp.Ceil, exp.Exp, exp.Floor, exp.Ln, exp.Log, exp.Round, exp.Sqrt],
  { annotator: (self, e) => _annotate_math_functions(self, e) },
);

// py:211-239
setEach(
  [
    exp.ArgMax,
    exp.ArgMin,
    exp.GroupConcat,
    exp.IgnoreNulls,
    exp.JSONExtract,
    exp.Left,
    exp.Lower,
    exp.NetFunc,
    exp.Pad,
    exp.PercentileDisc,
    exp.RegexpExtract,
    exp.RegexpReplace,
    exp.Repeat,
    exp.Replace,
    exp.RespectNulls,
    exp.Reverse,
    exp.Right,
    exp.SafeFunc,
    exp.SafeNegate,
    exp.Sign,
    exp.Substring,
    exp.Translate,
    exp.Trim,
    exp.Upper,
  ],
  { annotator: (self, e) => self._annotate_by_args(e, "this") },
);

// py:240-243
setEach(_DATE_FUNC_LITERAL_TYPE.keys(), { annotator: (self, e) => _annotate_date_func(self, e) });

// py:244-260
setEach(
  [
    exp.BitwiseAndAgg,
    exp.BitwiseCount,
    exp.BitwiseOrAgg,
    exp.BitwiseXorAgg,
    exp.ByteLength,
    exp.FarmFingerprint,
    exp.Grouping,
    exp.LaxInt64,
    exp.Length,
    exp.RangeBucket,
    exp.RegexpInstr,
    exp.UnixDate,
  ],
  { returns: exp.DType.BIGINT },
);

// py:261-273
setEach(
  [
    exp.ByteString,
    exp.CodePointsToBytes,
    exp.MD5Digest,
    exp.SHA,
    exp.SHA2,
    exp.SHA1Digest,
    exp.SHA2Digest,
    exp.Unhex,
  ],
  { returns: exp.DType.BINARY },
);

// py:274-280
setEach([exp.JSONBool, exp.LaxBool], { returns: exp.DType.BOOLEAN });

// py:281-287
setEach([exp.ParseDatetime, exp.TimestampFromParts], { returns: exp.DType.DATETIME });

// py:288-303
setEach(
  [
    exp.Atan2,
    exp.Corr,
    exp.CosineDistance,
    exp.Coth,
    exp.Csc,
    exp.Csch,
    exp.EuclideanDistance,
    exp.Float64,
    exp.LaxFloat64,
    exp.Sec,
    exp.Sech,
  ],
  { returns: exp.DType.DOUBLE },
);

// py:304-315
setEach(
  [
    exp.JSONArray,
    exp.JSONArrayAppend,
    exp.JSONArrayInsert,
    exp.JSONObject,
    exp.JSONRemove,
    exp.JSONSet,
    exp.JSONStripNulls,
  ],
  { returns: exp.DType.JSON },
);

// py:316-324
setEach([exp.ParseTime, exp.TimeFromParts, exp.TimeTrunc, exp.TsOrDsToTime], { returns: exp.DType.TIME });

// py:325-341
setEach(
  [
    exp.CodePointsToString,
    exp.Format,
    exp.Host,
    exp.JSONExtractScalar,
    exp.JSONType,
    exp.LaxString,
    exp.LowerHex,
    exp.Normalize,
    exp.RegDomain,
    exp.SafeConvertBytesToString,
    exp.Soundex,
    exp.Uuid,
  ],
  { returns: exp.DType.VARCHAR },
);

// py:342-351
setEach(
  [exp.PercentileCont, exp.SafeAdd, exp.SafeDivide, exp.SafeMultiply, exp.SafeSubtract],
  { annotator: (self, e) => _annotate_by_args_with_coerce(self, e) },
);

// py:352-360
setEach(
  [exp.ApproxQuantiles, exp.JSONExtractArray, exp.RegexpExtractAll, exp.Split],
  { annotator: (self, e) => self._annotate_by_args(e, "this", { array: true }) },
);

// py:361
setEach(TIMESTAMP_EXPRESSIONS, { returns: exp.DType.TIMESTAMPTZ });

// py:362
EXPRESSION_METADATA.set(exp.ApproxTopK, { annotator: (self, e) => _annotate_by_args_approx_top(self, e) });
// py:363
EXPRESSION_METADATA.set(exp.ApproxTopSum, { annotator: (self, e) => _annotate_by_args_approx_top(self, e) });
// py:364
EXPRESSION_METADATA.set(exp.Array, { annotator: _annotate_array });
// py:365
EXPRESSION_METADATA.set(exp.Concat, { annotator: _annotate_concat });
// py:366
EXPRESSION_METADATA.set(exp.DateFromUnixDate, { returns: exp.DType.DATE });
// py:367-371
EXPRESSION_METADATA.set(exp.GenerateTimestampArray, {
  annotator: (self, e) => self._set_type(e, exp.DataType.fromStr("ARRAY<TIMESTAMP>", { dialect: "bigquery" })),
});
// py:372-376
EXPRESSION_METADATA.set(exp.JSONFormat, {
  annotator: (self, e) => self._set_type(e, e.args.to_json ? exp.DType.JSON : exp.DType.VARCHAR),
});
// py:377-381
EXPRESSION_METADATA.set(exp.JSONKeysAtDepth, {
  annotator: (self, e) => self._set_type(e, exp.DataType.fromStr("ARRAY<VARCHAR>", { dialect: "bigquery" })),
});
// py:382-386
EXPRESSION_METADATA.set(exp.JSONValueArray, {
  annotator: (self, e) => self._set_type(e, exp.DataType.fromStr("ARRAY<VARCHAR>", { dialect: "bigquery" })),
});
// py:387
EXPRESSION_METADATA.set(exp.ParseBignumeric, { returns: exp.DType.BIGDECIMAL });
// py:388
EXPRESSION_METADATA.set(exp.ParseNumeric, { returns: exp.DType.DECIMAL });
// py:389
EXPRESSION_METADATA.set(exp.SafeDivide, { annotator: (self, e) => _annotate_safe_divide(self, e) });
// py:390-394
EXPRESSION_METADATA.set(exp.ToCodePoints, {
  annotator: (self, e) => self._set_type(e, exp.DataType.fromStr("ARRAY<BIGINT>", { dialect: "bigquery" })),
});
