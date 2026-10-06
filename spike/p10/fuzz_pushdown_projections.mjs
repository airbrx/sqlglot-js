// Differential: `src/optimizer/pushdown_projections.js` (AIR-2111) vs CPython's
// `sqlglot.optimizer.pushdown_projections`, at the pin. Reproduces the exact
// `TestOptimizer.test_pushdown_projection` pipeline (`qualify_tables()` with no
// kwargs -> `qualify_columns(infer_schema=True, **kwargs)` ->
// `pushdown_projections(**kwargs)`) over the real 74-pair
// `tests/fixtures/optimizer/pushdown_projections.sql` corpus, not a hand-invented
// scenario battery -- see `gen_pushdown_projections_ref.py`'s own header.
//
//   PYTHONHASHSEED=0 python3 spike/p10/gen_pushdown_projections_ref.py > spike/out/pushdown_projections.json
//   node spike/p10/fuzz_pushdown_projections.mjs
//
// Comparison is plain `.sql(dialect)` string equality against CPython's OWN computed
// output for each case (not the fixture's static "expected" text, though the two are
// identical at this pin -- confirmed by the generator script itself), or exception
// class + message for the error-path cases, matching this project's established
// convention (`fuzz_qualify_columns.mjs`, `fuzz_normalize.mjs`).

import { readFileSync } from "node:fs";
import { parseOne } from "../../src/dialects/dialect.js";
import { qualify_tables } from "../../src/optimizer/qualify_tables.js";
import { qualify_columns } from "../../src/optimizer/qualify_columns.js";
import { pushdown_projections } from "../../src/optimizer/pushdown_projections.js";
// Side-effect imports: register the real base-Generator dispatch (needed by `.sql()`)
// and every dialect a fixture case names.
import "../../src/generator.js";
import "../../src/dialects/bigquery.js";
import "../../src/dialects/snowflake.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = JSON.parse(readFileSync("spike/out/pushdown_projections.json", "utf8"));

// Mirrors `gen_pushdown_projections_ref.py`'s own `STRUCTURAL_IDS` -- these 3 hit
// pre-existing `NotPorted` base-Generator stubs (`cube_sql`, `in_unnest_op`,
// `JSONPathKey`'s missing TRANSFORMS entry) unrelated to this file, so they compare a
// pure structural `.toString()` dump instead of `.sql()`.
const STRUCTURAL_IDS = new Set([35, 50, 73]);

// Same pre-existing, unrelated parser/repr quirk `fuzz_qualify_columns.mjs` already
// documents and strips: this port's `Expr`/parser construction sets `comments` to `[]`
// by default (Python: `None`, omitted by `to_s`), which `toS` then prints since it's
// non-null.
function normalizeRepr(repr) {
  return repr.replace(/,\n\s*_comments=\[\]/g, "");
}

// py: tests/test_optimizer.py:132-172 `self.schema`, the exact schema
// `test_pushdown_projection` runs `check_file("pushdown_projections", ...)` against.
const SCHEMA = {
  x: { a: "INT", b: "INT" },
  y: { b: "INT", c: "INT" },
  z: { b: "INT", c: "INT" },
  w: { d: "TEXT", e: "TEXT" },
  temporal: { d: "DATE", t: "DATETIME" },
  structs: {
    one: "STRUCT<a_1 INT, b_1 VARCHAR>",
    nested_0: "STRUCT<a_1 INT, nested_1 STRUCT<a_2 INT, nested_2 STRUCT<a_3 INT>>>",
    quoted: 'STRUCT<"foo bar" INT>',
  },
  t_bool: { a: "BOOLEAN", b: "BOOLEAN" },
  unpivotable: { id: "INT", jan: "INT", feb: "INT", north: "INT", south: "INT" },
  pivotable: { id: "INT", cat: "TEXT", val: "INT", kind: "TEXT", amt: "INT" },
};

// py: tests/test_optimizer.py:45-49 `pushdown_projections` test wrapper.
function runOne(id, sql, dialect) {
  const kwargs = dialect ? { dialect } : {};
  let expression = parseOne(sql, { dialect });
  expression = qualify_tables(expression);
  expression = qualify_columns(expression, SCHEMA, { inferSchema: true, ...kwargs });
  expression = pushdown_projections(expression, SCHEMA, kwargs);
  return STRUCTURAL_IDS.has(id) ? { repr: normalizeRepr(expression.toString()) } : { ok: expression.sql(dialect) };
}

let exact = 0;
let mismatch = 0;
let error = 0;
const samples = [];

for (const fx of ref.fixtures) {
  const { id, title, sql, dialect } = fx;
  let got;
  try {
    got = runOne(id, sql, dialect);
  } catch (e) {
    got = { error: e.constructor.name, message: e.message };
  }

  let ok;
  if ("computed" in fx) {
    ok = "ok" in got && got.ok === fx.computed;
  } else if ("computed_repr" in fx) {
    ok = "repr" in got && got.repr === fx.computed_repr;
  } else {
    ok = "error" in got && got.error === fx.error && got.message === fx.message;
  }

  if (ok) {
    exact++;
  } else if ("error" in got && !("error" in fx)) {
    error++;
    samples.push(`ERROR   #${id} ${title}: ${got.error}: ${got.message}\n  sql: ${sql}`);
  } else {
    mismatch++;
    const expected = "computed" in fx ? fx.computed : "computed_repr" in fx ? fx.computed_repr : `${fx.error}: ${fx.message}`;
    const gotStr = "ok" in got ? got.ok : "repr" in got ? got.repr : `${got.error}: ${got.message}`;
    samples.push(
      `MISMATCH #${id} ${title}\n  sql:      ${sql}\n  expected: ${expected}\n  got:      ${gotStr}`,
    );
  }
}

console.log();
console.log("  src/optimizer/pushdown_projections.js vs CPython sqlglot.optimizer.pushdown_projections");
console.log(`    EXACT ${exact}    MISMATCH ${mismatch}    ERROR ${error}`);
if (samples.length) {
  console.log();
  for (const s of samples) console.log(VERBOSE ? `  ${s}\n` : `  ${s.split("\n")[0]}`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
