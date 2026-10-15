// py: sqlglot/typing/mysql.py @ 91119bc — WHOLE FILE (206 LOC), AIR-2099/AIR-2286.
//
// MySQL's per-dialect type-inference overlay: seeded from the base 294-entry
// `typing/index.js` table (py:6 `from sqlglot.typing import EXPRESSION_METADATA`),
// the same `{**EXPRESSION_METADATA, **{...}}` merge shape `typing/tsql.js`/
// `typing/snowflake.js` already established (R67's lesson: seed from the BASE table,
// not an empty stub, or the overlay silently shadows almost everything).
//
// Four custom `annotator` functions (py:39-92) are ported as plain functions with the
// same `(self, expression)` signature `typing/tsql.js`'s inline arrows use, since they
// have real bodies (branching on `is_type`) rather than a one-line `_annotate_by_args`
// delegate.

import * as exp from "../expressions/index.js";
import { EXPRESSION_METADATA as BASE_EXPRESSION_METADATA } from "./index.js";

// py:12-20
const COMPRESS_LONGBLOB_TYPES = new Set([
  exp.DType.TEXT,
  exp.DType.MEDIUMTEXT,
  exp.DType.LONGTEXT,
  exp.DType.BLOB,
  exp.DType.MEDIUMBLOB,
  exp.DType.LONGBLOB,
  exp.DType.JSON,
]);

// py:23-36
const COMPRESS_VARBINARY_TYPES = new Set([
  exp.DType.CHAR,
  exp.DType.VARCHAR,
  exp.DType.BINARY,
  exp.DType.VARBINARY,
  exp.DType.TINYBLOB,
  exp.DType.ENUM,
  exp.DType.INT,
  exp.DType.BIGINT,
  exp.DType.DECIMAL,
  exp.DType.DOUBLE,
  exp.DType.DATE,
  exp.DType.DATETIME,
]);

// py:39-45
function _annotate_reverse(self, expression) {
  if (expression.this.isType(exp.DType.BINARY, exp.DType.VARBINARY, exp.DType.UNKNOWN)) {
    self._annotate_by_args(expression, "this");
  } else {
    self._set_type(expression, exp.DType.VARCHAR);
  }
  return expression;
}

// py:48-52
function _annotate_truncate(self, expression) {
  if (expression.this.isType(...exp.DataType.TEXT_TYPES)) {
    return self._set_type(expression, exp.DType.DOUBLE);
  }
  return self._annotate_by_args(expression, "this");
}

// py:55-65
function _annotate_regexp_replace(self, expression) {
  const args = [expression.this, expression.expression, expression.args.replacement];

  let has_binary = false;
  for (const arg of args) {
    if (arg !== null && arg !== undefined) {
      if (arg.isType(exp.DType.UNKNOWN)) {
        return self._set_type(expression, exp.DType.UNKNOWN);
      }
      has_binary = has_binary || arg.isType(...exp.DataType.BINARY_TYPES);
    }
  }

  return self._set_type(expression, has_binary ? exp.DType.LONGBLOB : exp.DType.LONGTEXT);
}

// py:68-80
function _annotate_compress(self, expression) {
  const this_ = expression.this;

  if (this_.isType(...COMPRESS_VARBINARY_TYPES)) {
    return self._set_type(expression, exp.DType.VARBINARY);
  }

  if (this_.isType(...COMPRESS_LONGBLOB_TYPES)) {
    return self._set_type(expression, exp.DType.LONGBLOB);
  }

  if (this_.isType(exp.DType.TINYTEXT)) {
    return self._set_type(expression, exp.DType.BLOB);
  }

  return self._set_type(expression, exp.DType.UNKNOWN);
}

// py:83-92
function _annotate_bit_func(self, expression) {
  const this_ = expression.this;

  if (this_.isType(exp.DType.UNKNOWN)) {
    return self._set_type(expression, exp.DType.UNKNOWN);
  }

  if (this_.isType(...exp.DataType.BINARY_TYPES)) {
    return self._set_type(expression, exp.DType.VARBINARY);
  }

  return self._set_type(expression, exp.DType.UBIGINT);
}

/**
 * py:95-206 `EXPRESSION_METADATA = {**EXPRESSION_METADATA, **{...}}` — a `Map`, seeded
 * from the base table and then overlaid with MySQL's own keys, in upstream's own
 * top-to-bottom order.
 */
export const EXPRESSION_METADATA = new Map(BASE_EXPRESSION_METADATA);

const setEach = (classesIter, value) => {
  for (const c of classesIter) EXPRESSION_METADATA.set(c, value);
};

// py:98-104
setEach([exp.Atan2, exp.MatchAgainst, exp.StDistance], { returns: exp.DType.DOUBLE });

// py:105-114
setEach(
  [exp.CurrentTimestamp, exp.ConvertTimezone, exp.Localtime, exp.Localtimestamp, exp.UtcTimestamp],
  { returns: exp.DType.DATETIME },
);

// py:115-120
setEach([exp.UtcDate], { returns: exp.DType.DATE });

// py:121-135
setEach(
  [
    exp.Elt,
    exp.Hex,
    exp.NumberToStr, // format()
    exp.Replace,
    exp.Stuff, // insert function
    exp.SubstringIndex,
    exp.RegexpSubstr,
    exp.Collation,
    exp.JSONType,
    exp.Uuid,
  ],
  { returns: exp.DType.VARCHAR },
);

// py:136-144
setEach([exp.Month, exp.Second, exp.Week, exp.Minute], { returns: exp.DType.INT });

// py:145-151
setEach([exp.RegexpInstr, exp.Grouping], { returns: exp.DType.BIGINT });

// py:152-158
setEach([exp.TimeFromParts, exp.UtcTime], { returns: exp.DType.TIME });

// py:159-164
setEach([exp.Unhex], { returns: exp.DType.VARBINARY });

// py:165-177
setEach(
  [
    exp.JSONObjectAgg,
    exp.JSONObject,
    exp.JSONExtract,
    exp.JSONKeys,
    exp.JSONArrayAppend,
    exp.JSONArrayInsert,
    exp.JSONRemove,
    exp.JSONSet,
  ],
  { returns: exp.DType.JSON },
);

// py:178-183
setEach([exp.CurrentRole], { returns: exp.DType.LONGTEXT });

// py:184-193
setEach(
  [exp.Pad, exp.Left, exp.Right, exp.Lead, exp.Lag],
  { annotator: (self, e) => self._annotate_by_args(e, "this") },
);

// py:194-201
setEach(
  [exp.BitwiseAndAgg, exp.BitwiseXorAgg, exp.BitwiseOrAgg],
  { annotator: _annotate_bit_func },
);

// py:202-205
EXPRESSION_METADATA.set(exp.Reverse, { annotator: _annotate_reverse });
EXPRESSION_METADATA.set(exp.Trunc, { annotator: _annotate_truncate });
EXPRESSION_METADATA.set(exp.RegexpReplace, { annotator: _annotate_regexp_replace });
EXPRESSION_METADATA.set(exp.Compress, { annotator: _annotate_compress });
