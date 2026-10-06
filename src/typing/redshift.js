// py: sqlglot/typing/redshift.py @ 91119bc — WHOLE FILE (17 LOC), AIR-2099.
//
// Redshift's per-dialect type-inference overlay. UNLIKE every other dialect's typing
// module (which layers on the base `typing/index.js` table), upstream imports its seed
// `EXPRESSION_METADATA` `from sqlglot.typing.postgres` (py:4) — matching
// `dialects/redshift.py`'s own `class Redshift(Postgres)` inheritance (`src/dialects/
// redshift.js`'s `export class Redshift extends Postgres`) — so this file seeds from
// `typing/postgres.js` (R-this-round), not `typing/index.js` directly, and only 3 of
// its keys actually override a Postgres entry (`Ntile`; `StrToTime`/`Rank` are new).
//
// No `_annotate_*` helpers: every upstream entry is a plain `{"returns": DType}`.

import * as exp from "../expressions/index.js";
import { EXPRESSION_METADATA as POSTGRES_EXPRESSION_METADATA } from "./postgres.js";

/**
 * py:7-17 `EXPRESSION_METADATA = {**EXPRESSION_METADATA, **{...}}` — a `Map`, seeded
 * from `typing/postgres.js` (not the base table) and then overlaid with Redshift's own
 * 3 keys, in upstream's own top-to-bottom order.
 */
export const EXPRESSION_METADATA = new Map(POSTGRES_EXPRESSION_METADATA);

// py:9-10 Redshift's TO_TIMESTAMP returns TIMESTAMPTZ, not TIMESTAMP.
// https://docs.aws.amazon.com/redshift/latest/dg/r_TO_TIMESTAMP.html
EXPRESSION_METADATA.set(exp.StrToTime, { returns: exp.DType.TIMESTAMPTZ });

// py:11-12 Redshift's RANK returns INTEGER; DENSE_RANK/NTILE/ROW_NUMBER return BIGINT
// (base default).
// https://docs.aws.amazon.com/redshift/latest/dg/r_WF_RANK.html
EXPRESSION_METADATA.set(exp.Rank, { returns: exp.DType.INT });

// py:13-14 Postgres NTILE is INT, but Redshift's is BIGINT — restore the base default.
// https://docs.aws.amazon.com/redshift/latest/dg/r_WF_NTILE.html
EXPRESSION_METADATA.set(exp.Ntile, { returns: exp.DType.BIGINT });
