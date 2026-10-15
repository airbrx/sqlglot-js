// py: sqlglot/typing/clickhouse.py @ 91119bc — WHOLE FILE (24 LOC), AIR-2288.
//
// ClickHouse's per-dialect type-inference overlay: a 3-key `EXPRESSION_METADATA`
// table layered on the base 294-entry `typing/index.js` table (AIR-2096/R51), the
// same `{**EXPRESSION_METADATA, **{...}}` merge shape `typing/presto.js` (AIR-2287)
// already established — reproduced here with `new Map(BASE_EXPRESSION_METADATA)`
// seeded first and every `.set()` call below running in upstream's own top-to-bottom
// order.

import * as exp from "../expressions/index.js";
import { EXPRESSION_METADATA as BASE_EXPRESSION_METADATA } from "./index.js";

/**
 * py:6-24 `EXPRESSION_METADATA = {**EXPRESSION_METADATA, **{...}}` — a `Map`, seeded
 * from the base table and then overlaid with ClickHouse's own 3 keys, in upstream's
 * own top-to-bottom order.
 */
export const EXPRESSION_METADATA = new Map(BASE_EXPRESSION_METADATA);

// py:9-13 `{expr_type: {"returns": exp.DType.UBIGINT} for expr_type in {exp.CountIf}}`
EXPRESSION_METADATA.set(exp.CountIf, { returns: exp.DType.UBIGINT });

// py:14-18
EXPRESSION_METADATA.set(exp.MD5Digest, {
  annotator: (self, e) =>
    self._set_type(e, exp.DataType.build("FixedString(16)", { dialect: "clickhouse" })),
});

// py:19-23
EXPRESSION_METADATA.set(exp.Corr, {
  annotator: (self, e) =>
    self._set_type(e, exp.DataType.build("Float64", { dialect: "clickhouse" })),
});
