// Differential: `src/optimizer/qualify_columns.js` (core -- column qualification +
// star expansion, AIR-2106) vs CPython's `sqlglot.optimizer.qualify_columns`, at the
// pin. `validate_qualify_columns`/`quote_identifiers` are NOT ported here (AIR-2107)
// and are not exercised by this harness.
//
//   PYTHONHASHSEED=0 python3 spike/p7/gen_qualify_columns_ref.py > spike/out/qualify_columns.json
//   node spike/p7/fuzz_qualify_columns.mjs
//
// See `gen_qualify_columns_ref.py`'s own header for what each scenario targets.
// Comparison is plain `.sql()` string equality for most scenarios (or exception class
// + message for the error-path scenario) -- simpler than an AST-dump diff and just as
// strict, since this port's own parser+generator are independently verified elsewhere
// (PORT_PLAN.md P1-P5) and any AST-shape divergence here would show up as different
// SQL text. 7 scenarios that hit unrelated pre-existing `NotPorted` base-Generator
// stubs compare a structural `repr()`/`.toString()` dump instead -- see
// `gen_qualify_columns_ref.py`'s own `STRUCTURAL` set for which and why.

import { readFileSync } from "node:fs";
import { parseOne } from "../../src/dialects/dialect.js";
import { qualify_columns } from "../../src/optimizer/qualify_columns.js";
// Side-effect imports: register the real base-Generator dispatch (needed by `.sql()`)
// and every dialect a scenario names.
import "../../src/generator.js";
import "../../src/dialects/bigquery.js";
import "../../src/dialects/snowflake.js";
import "../../src/dialects/spark.js";
import "../../src/dialects/postgres.js";
import "../../src/dialects/duckdb.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = JSON.parse(readFileSync("spike/out/qualify_columns.json", "utf8"));

let exact = 0;
let mismatch = 0;
let error = 0;
const samples = [];

// Mirrors `gen_qualify_columns_ref.py`'s own `STRUCTURAL` set -- these 7 hit
// pre-existing `NotPorted` base-Generator stubs (`pseudocolumn_sql`, `dot_sql`,
// `pivot_sql`, `TableColumn`'s missing TRANSFORMS entry) unrelated to this file, so
// they compare a pure structural repr instead of `.sql()`.
const STRUCTURAL = new Set([
  "snowflake-level-pseudocolumn-with-connect-by",
  "struct-field-column-converted-to-dot",
  "table-referenceable-as-column-postgres",
  "pivot-columns-resolve-against-pivot-output",
  "struct-star-expansion-bigquery",
  "struct-star-expansion-one-level-bigquery",
  "pivot-star-resolves-against-pivot-output",
]);

// A pre-existing, unrelated parser/repr quirk, not introduced by this file and not
// specific to it: `parseOne("SELECT 1 FROM t").toString()` alone already shows a
// trailing `_comments=[]` on the top-level Select that CPython's own `repr()` never
// shows (Python's `comments` slot defaults to `None`, omitted by `to_s`; this port's
// parser/`Expr` construction path sets it to `[]` instead, which `toS` then prints
// since it is non-null). Confirmed reproducible on a bare `parseOne` with no
// `qualify_columns.js` involvement at all. Stripped here so these 7 structural
// comparisons aren't blocked by an unrelated cosmetic diff.
function normalizeRepr(repr) {
  return repr.replace(/,\n\s*_comments=\[\]/g, "");
}

function runOne(name, sql, schema, kwargs, dialect) {
  try {
    const ast = parseOne(sql, { dialect });
    const out = qualify_columns(ast, schema, {
      allowPartialQualification: kwargs.allow_partial_qualification ?? false,
      dialect,
    });
    if (STRUCTURAL.has(name)) return { repr: normalizeRepr(out.toString()) };
    return { ok: out.sql(dialect) };
  } catch (e) {
    return { error: e.constructor.name, message: e.message };
  }
}

for (const { name, sql, schema, kwargs, dialect, result: expected } of ref.scenarios) {
  const got = runOne(name, sql, schema, kwargs, dialect);
  let ok;
  if ("ok" in expected) {
    ok = "ok" in got && got.ok === expected.ok;
  } else if ("repr" in expected) {
    ok = "repr" in got && got.repr === expected.repr;
  } else {
    ok = "error" in got && got.error === expected.error && got.message === expected.message;
  }
  if (ok) {
    exact++;
  } else if ("error" in got && !("error" in expected)) {
    error++;
    samples.push(`ERROR   ${name}: ${got.error}: ${got.message}\n  sql: ${sql}`);
  } else {
    mismatch++;
    samples.push(
      `MISMATCH ${name}\n  sql:      ${sql}\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(got)}`,
    );
  }
}

console.log();
console.log("  src/optimizer/qualify_columns.js vs CPython sqlglot.optimizer.qualify_columns");
console.log(`    EXACT ${exact}    MISMATCH ${mismatch}    ERROR ${error}`);
if (samples.length) {
  console.log();
  for (const s of samples) console.log(VERBOSE ? `  ${s}\n` : `  ${s.split("\n")[0]}`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
