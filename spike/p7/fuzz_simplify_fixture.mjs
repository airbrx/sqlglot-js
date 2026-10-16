// Differential: `src/optimizer/simplify.js` (`Simplifier`/`simplify`) vs CPython's
// `sqlglot.optimizer.simplify`, replayed against the REAL
// `tests/fixtures/optimizer/simplify.sql` corpus (AIR-2315 Part 2) -- 521 pairs, the
// largest full-SQL-pair fixture file in the whole optimizer corpus, with no oracle
// anywhere in spike/p7 replaying it (`fuzz_simplify.mjs` is a hand-built battery per
// its own docstring; it stays, this file is a sibling, not a replacement).
//
//   PYTHONHASHSEED=0 python3 spike/p7/gen_simplify_fixture_ref.py > spike/out/simplify_fixture.json
//   node spike/p7/fuzz_simplify_fixture.mjs
//
// See `gen_simplify_fixture_ref.py`'s own header for the full rationale, in particular
// that `test_simplify` passes `check_file` its own LOCAL `simplify()` wrapper --
// `annotate_types()` first, then the real `Simplifier` with
// `constant_propagation=True, coalesce_simplification=True` always on -- not the bare
// `simplify()` entry point directly. `expected` is the raw fixture text, compared
// byte-for-byte (unlike `annotate_functions.sql`'s oracle, nothing here needs a
// re-normalization pass).

import { readFileSync } from "node:fs";
import { parseOne } from "../../src/dialects/dialect.js";
import { simplify } from "../../src/optimizer/simplify.js";
import { annotate_types } from "../../src/optimizer/annotate_types.js";
// Side-effect imports: register every dialect this fixture's `# dialect:` meta names
// (verified against the pin: bigquery/clickhouse/duckdb/mysql/postgres/redshift/
// snowflake/spark/sqlite/tsql, no comma-separated multi-dialect metas).
import "../../src/dialects/bigquery.js";
import "../../src/dialects/clickhouse.js";
import "../../src/dialects/duckdb.js";
import "../../src/dialects/mysql.js";
import "../../src/dialects/postgres.js";
import "../../src/dialects/redshift.js";
import "../../src/dialects/snowflake.js";
import "../../src/dialects/spark.js";
import "../../src/dialects/sqlite.js";
import "../../src/dialects/tsql.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = JSON.parse(readFileSync("spike/out/simplify_fixture.json", "utf8"));

// py: `TestOptimizer.setUp`'s own `self.schema` literal.
const TEST_SCHEMA = {
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

// Named, counted exclusions -- a row whose dialect/shape is a known, already-recorded
// gap elsewhere in PORT_PLAN.md, not a defect this round owns fixing. Empty for now;
// kept as the established slot (see `fuzz_annotate_functions.mjs`'s own
// `KNOWN_SKIPS`) for whatever a first real run surfaces.
const KNOWN_SKIPS = [];

function isKnownSkip(row) {
  return KNOWN_SKIPS.some((re) => re.test(`${row.dialect || "default"}:${row.title}`));
}

function runOne(sql, dialect) {
  const ast = parseOne(sql, { read: dialect || undefined });
  // py: test_optimizer.py's own local `simplify(expression, **kwargs)` wrapper --
  // annotate types first, then the real Simplifier with both optional rules forced on.
  const annotated = annotate_types(ast, { schema: TEST_SCHEMA, dialect: dialect || null });
  const simplified = simplify(annotated, {
    constant_propagation: true,
    coalesce_simplification: true,
    dialect: dialect || null,
  });
  return simplified.sql(dialect || null);
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
console.log("  src/optimizer/simplify.js vs tests/fixtures/optimizer/simplify.sql (fixture replay)");
console.log(`    EXACT ${exact}    MISMATCH ${mismatch}    ERROR ${error}    SKIPPED ${skipped}`);
if (samples.length) {
  console.log();
  for (const s of samples) console.log(VERBOSE ? `  ${s}\n` : `  ${s.split("\n")[0]}`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
