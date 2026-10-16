// Differential: `src/optimizer/annotate_types.js` (`TypeAnnotator`/`annotate_types`) vs
// CPython's `sqlglot.optimizer.annotate_types`, replayed against the REAL
// `tests/fixtures/optimizer/annotate_functions.sql` corpus (AIR-2315 Part 1) --
// 1,932 pairs, 54% of the whole 3,589-pair optimizer corpus, the single largest
// zero-oracle gap `docs/verification/optimizer-fixture-rollup.md` (R95/AIR-2295) found.
//
//   PYTHONHASHSEED=0 python3 spike/p7/gen_annotate_functions_ref.py > spike/out/annotate_functions.json
//   node spike/p7/fuzz_annotate_functions.mjs
//
// See `gen_annotate_functions_ref.py`'s own header for the full rationale and for why
// the ref JSON's `expected` field is ALREADY normalized through CPython's own
// `exp.DataType.build(expected, dialect).sql(dialect)` -- this file only needs a
// byte-for-byte string compare against that, not a reimplementation of `DataType.build`.
//
// Each ref record is one (fixture pair index, dialect) tuple -- `# dialect: a, b` meta
// fans one pair out into N records; a pair with no `# dialect:` meta at all still
// produces exactly one record with `dialect === ""` (upstream's own `"".split(", ")`
// yields `[""]`, the default dialect, not zero iterations).

import { readFileSync } from "node:fs";
import { parseOne } from "../../src/dialects/dialect.js";
// Side-effect imports: register every dialect this fixture's `# dialect:` meta names.
import "../../src/dialects/bigquery.js";
import "../../src/dialects/clickhouse.js";
import "../../src/dialects/databricks.js";
import "../../src/dialects/duckdb.js";
import "../../src/dialects/hive.js";
import "../../src/dialects/mysql.js";
import "../../src/dialects/postgres.js";
import "../../src/dialects/presto.js";
import "../../src/dialects/redshift.js";
import "../../src/dialects/snowflake.js";
import "../../src/dialects/spark.js";
import "../../src/dialects/spark2.js";
import "../../src/dialects/trino.js";
import "../../src/dialects/tsql.js";
import { annotate_types } from "../../src/optimizer/annotate_types.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = JSON.parse(readFileSync("spike/out/annotate_functions.json", "utf8"));

// py: `test_annotate_funcs`'s own `test_schema` literal.
const TEST_SCHEMA = {
  tbl: {
    bin_col: "BINARY",
    str_col: "STRING",
    bignum_col: "BIGNUMERIC",
    date_col: "DATE",
    decfloat_col: "DECFLOAT",
    float_col: "FLOAT",
    timestamp_col: "TIMESTAMP",
    double_col: "DOUBLE",
    bigint_col: "BIGINT",
    obj_col: "OBJECT",
    int_col: "INT",
    bool_col: "BOOLEAN",
    bytes_col: "BYTES",
    interval_col: "INTERVAL",
    array_col: "ARRAY<STRING>",
  },
};

// Named, counted exclusions -- a row whose dialect/function combination is a known,
// already-recorded gap elsewhere in PORT_PLAN.md, not a defect this round owns fixing.
// Empty for now; kept as the established slot (see `fuzz_canonicalize.mjs`'s own
// `KNOWN_GENERATOR_GAPS`) for whatever a first real run surfaces.
const KNOWN_SKIPS = [];

function isKnownSkip(row) {
  return KNOWN_SKIPS.some((re) => re.test(`${row.dialect}:${row.sql}`));
}

function runOne(sql, dialect) {
  const ast = parseOne(sql, { read: dialect || undefined });
  const annotated = annotate_types(ast, { dialect: dialect || null, schema: TEST_SCHEMA });
  return annotated.expressions[0].type.sql(dialect || null);
}

let exact = 0;
let mismatch = 0;
let error = 0;
let skipped = 0;
const samples = [];

for (const row of ref.records) {
  const name = `#${row.i} (${row.dialect || "default"})`;

  if (isKnownSkip(row)) {
    skipped++;
    continue;
  }

  if (row.expected === null || row.expected === undefined) {
    // CPython itself couldn't normalize the expected string (see `expected_error`) --
    // nothing to compare against; not this port's defect to fix.
    skipped++;
    continue;
  }

  let got;
  try {
    got = { ok: runOne(row.sql, row.dialect) };
  } catch (e) {
    got = { error: e.constructor.name, message: e.message };
  }

  if ("error" in got) {
    error++;
    samples.push(
      `ERROR   ${name}: ${got.error}: ${got.message}\n  sql: ${row.sql}\n  title: ${row.title}`,
    );
  } else if (got.ok === row.expected) {
    exact++;
  } else {
    mismatch++;
    samples.push(
      `MISMATCH ${name}\n  sql:      ${row.sql}\n  title:    ${row.title}\n  expected: ${row.expected}\n  got:      ${got.ok}`,
    );
  }
}

console.log();
console.log("  src/optimizer/annotate_types.js vs tests/fixtures/optimizer/annotate_functions.sql");
console.log(`    EXACT ${exact}    MISMATCH ${mismatch}    ERROR ${error}    SKIPPED ${skipped}`);
if (samples.length) {
  console.log();
  for (const s of samples) console.log(VERBOSE ? `  ${s}\n` : `  ${s.split("\n")[0]}`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
