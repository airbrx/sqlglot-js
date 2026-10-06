// Differential: `src/optimizer/qualify.js` (`qualify`, AIR-2108, epic AIR-2087 --
// the orchestrator wiring `normalize_identifiers`/`qualify_tables`/
// `isolate_table_selects`/`qualify_columns`/`quote_identifiers`/
// `validate_qualify_columns` together) vs CPython's real
// `sqlglot.optimizer.qualify.qualify`, at the pin.
//
//   PYTHONHASHSEED=0 python3 spike/p10/gen_qualify_ref.py > spike/out/qualify.json
//   node spike/p10/fuzz_qualify.mjs
//
// See `gen_qualify_ref.py`'s own header for the full scenario breakdown: five real
// upstream fixture files (`qualify_columns`/`qualify_columns_ddl`/
// `qualify_columns__with_invisible`/`qualify_tables`/`qualify_columns__invalid`, with
// unsupported-dialect rows skipped and counted) plus a hand-picked kwarg-surface
// battery and four Snowflake positional-column scenarios. Comparison is plain
// `.sql()` string equality (or exception class + message for error-path scenarios).
//
// `gen_qualify_ref.py`'s own `run_invalid_fixture` docstring records a genuine,
// CONFIRMED composition finding on `qualify_columns__invalid.sql` row 13: the
// fixture's own upstream test runs the narrow `qualify_columns()` + manual
// `validate_qualify_columns()` with NO prior table-qualification pass, under which
// this row raises "Ambiguous column 'a'" -- but `qualify()` ALWAYS runs
// `qualify_tables` first (unconditionally, matching upstream's own
// qualify.py:85-92), which gives the derived table a real alias before
// `qualify_columns` ever sees it, resolving the same column unambiguously. This
// oracle's row 13 therefore expects a real SQL string, not a raised error --
// faithful to what the real, full `qualify()` entry point actually does, which is
// this file's own scope.

import { readFileSync } from "node:fs";
import { parseOne } from "../../src/dialects/dialect.js";
import { qualify } from "../../src/optimizer/qualify.js";
import { MappingSchema } from "../../src/schema.js";
import "../../src/generator.js";
import "../../src/dialects/bigquery.js";
import "../../src/dialects/snowflake.js";
import "../../src/dialects/postgres.js";
import "../../src/dialects/duckdb.js";
import "../../src/dialects/redshift.js";
import "../../src/dialects/spark.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = JSON.parse(readFileSync("spike/out/qualify.json", "utf8"));

let exact = 0;
let mismatch = 0;
let error = 0;
let gap = 0;
const samples = [];
const gapSamples = [];

// Pre-existing, unrelated gaps this fixture replay reaches but `qualify.js` itself
// cannot fix: base-Generator `NotPorted` stubs for rendering (`dot_sql`/`pivot_sql`/
// `parameter_sql`/`tablesample_sql`/`pseudocolumn_sql`/`hint_sql`/`copy_sql`/
// `addconstraint_sql`/`userdefinedfunction_sql`), two rare unsupported expression
// types (`TableColumn`, `JSONPathKey`) the generator/parser layer doesn't handle yet,
// and one narrow `_qualify_columns`/scope-building gap for a multi-column `AS (a, b)`
// alias over a table-generating function (`STACK`) that this file's own composition
// does not touch. Same "named, counted exclusion" shape `gen_qualify_columns_ref.py`'s
// own `STRUCTURAL` set and `gen_pushdown_predicates_ref.py`'s dialect skip already
// established -- classified by the underlying stub/type name, not by row id, so a
// NEW unrelated gap of the same shape is still caught by name rather than silently
// matched.
const KNOWN_GAPS = [
  /^NotPorted: (dot_sql|pivot_sql|parameter_sql|tablesample_sql|pseudocolumn_sql|hint_sql|copy_sql|addconstraint_sql|userdefinedfunction_sql) is not ported yet/,
  /^PyValueError: Unsupported expression type (TableColumn|JSONPathKey)$/,
  /^OptimizeError: Column 'first' could not be resolved\. Line: 1, Col: 12$/,
];

function isKnownGap(got) {
  if (!("error" in got)) return false;
  const line = `${got.error}: ${got.message}`;
  return KNOWN_GAPS.some((re) => re.test(line));
}

// tests/test_optimizer.py:132's standard optimizer schema, reused for the
// qualify_columns/qualify_columns_ddl fixtures (same shape gen_qualify_ref.py's own
// SCHEMA constant mirrors).
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

const WITH_INVISIBLE_SCHEMA = new MappingSchema(SCHEMA, { x: new Set(["a"]), y: new Set(["b"]), z: new Set(["b"]) });

// snake_case (as emitted by the Python oracle's `kwargs` dicts) -> this port's
// camelCase `qualify()` options.
const KWARG_KEY_MAP = {
  db: "db",
  catalog: "catalog",
  dialect: "dialect",
  expand_alias_refs: "expandAliasRefs",
  expand_stars: "expandStars",
  infer_schema: "inferSchema",
  isolate_tables: "isolateTables",
  qualify_columns: "qualifyColumns",
  allow_partial_qualification: "allowPartialQualification",
  validate_qualify_columns: "validateQualifyColumns",
  quote_identifiers: "quoteIdentifiers",
  identify: "identify",
  canonicalize_table_aliases: "canonicalizeTableAliases",
  sql: "sql",
};

function toOptions(kwargs) {
  const options = {};
  for (const [key, value] of Object.entries(kwargs || {})) {
    const camel = KWARG_KEY_MAP[key];
    if (!camel) throw new Error(`fuzz_qualify.mjs: unmapped kwarg key ${key}`);
    options[camel] = value;
  }
  return options;
}

function runQualify(sql, dialect, options) {
  const ast = parseOne(sql, { dialect });
  const out = qualify(ast, dialect ? { ...options, dialect } : options);
  return { ok: out.sql(dialect) };
}

function compare(name, sql, expected, got, samplesOut) {
  let ok;
  if ("ok" in expected) {
    ok = "ok" in got && got.ok === expected.ok;
  } else {
    ok = "error" in got && got.error === expected.error && got.message === expected.message;
  }
  if (ok) {
    exact++;
  } else if ("error" in got && !("error" in expected) && isKnownGap(got)) {
    gap++;
    gapSamples.push(`GAP      ${name}: ${got.error}: ${got.message}\n  sql: ${sql}`);
  } else if ("error" in got && !("error" in expected)) {
    error++;
    samplesOut.push(`ERROR   ${name}: ${got.error}: ${got.message}\n  sql: ${sql}`);
  } else {
    mismatch++;
    samplesOut.push(
      `MISMATCH ${name}\n  sql:      ${sql}\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(got)}`,
    );
  }
}

// --- 1a/1b/1c: qualify_columns / qualify_columns_ddl / qualify_columns__with_invisible
// -- the `qualify_columns` local wrapper (tests/test_optimizer.py:37-45): infer_schema=
// True, identify=False always; validate_qualify_columns/dialect from fixture meta. ---
function runFixturePairs(rows, schema) {
  for (const record of rows) {
    const name = record.title || `#${record.id}`;
    const options = toOptions(record.kwargs);
    options.schema = schema;
    options.inferSchema = true;
    options.identify = false;
    if (!("validateQualifyColumns" in options)) options.validateQualifyColumns = true;
    if (record.dialect) options.dialect = record.dialect;
    let got;
    try {
      got = runQualify(record.sql, record.dialect, options);
    } catch (e) {
      got = { error: e.constructor.name, message: e.message };
    }
    compare(name, record.sql, record.result, got, samples);
  }
}

runFixturePairs(ref.qualify_columns, SCHEMA);
runFixturePairs(ref.qualify_columns_ddl, SCHEMA);
runFixturePairs(ref.qualify_columns__with_invisible, WITH_INVISIBLE_SCHEMA);

// --- 1d: qualify_tables -- db="db", catalog="c", qualifyColumns=false, quoteIdentifiers=false. ---
for (const record of ref.qualify_tables) {
  const name = record.title || `#${record.id}`;
  const options = toOptions(record.kwargs);
  if (record.dialect) options.dialect = record.dialect;
  let got;
  try {
    got = runQualify(record.sql, record.dialect, options);
  } catch (e) {
    got = { error: e.constructor.name, message: e.message };
  }
  compare(name, record.sql, record.result, got, samples);
}

// --- 1e: qualify_columns__invalid -- default kwargs, schema=SCHEMA; row 13 (see this
// file's own header) legitimately does NOT raise. ---
for (const record of ref.qualify_columns__invalid) {
  const name = `invalid#${record.id}`;
  let got;
  try {
    got = runQualify(record.sql, null, { schema: SCHEMA });
  } catch (e) {
    got = { error: e.constructor.name, message: e.message };
  }
  compare(name, record.sql, record.result, got, samples);
}

// --- 2: hand-picked kwarg-surface battery + Snowflake positional-column scenarios.
// `onQualifyProbe` scenarios also assert the `on_qualify` callback's own observed
// table names, a side channel invisible in `.sql()` alone. ---
for (const record of ref.kwargs) {
  const options = toOptions(record.kwargs);
  if (record.schema !== undefined && record.schema !== null) options.schema = record.schema;
  if (record.dialect) options.dialect = record.dialect;

  const qualifiedNames = [];
  if (record.onQualifyProbe) options.onQualify = (t) => qualifiedNames.push(t.name);

  let got;
  try {
    got = runQualify(record.sql, record.dialect, options);
    if (record.onQualifyProbe) got.qualified_names = qualifiedNames;
  } catch (e) {
    got = { error: e.constructor.name, message: e.message };
    if (record.onQualifyProbe) got.qualified_names = qualifiedNames;
  }

  if (record.onQualifyProbe) {
    const expectedNames = JSON.stringify(record.result.qualified_names ?? []);
    const gotNames = JSON.stringify(got.qualified_names ?? []);
    if (expectedNames !== gotNames) {
      mismatch++;
      samples.push(
        `MISMATCH ${record.name} (on_qualify names)\n  expected: ${expectedNames}\n  got:      ${gotNames}`,
      );
      continue;
    }
  }
  compare(record.name, record.sql, record.result, got, samples);
}

for (const record of ref.positional) {
  const options = toOptions(record.kwargs);
  if (record.visibleSchema) {
    const visible = {};
    for (const [table, cols] of Object.entries(record.visibleSchema.visible)) visible[table] = new Set(cols);
    options.schema = new MappingSchema(record.visibleSchema.mapping, visible, record.dialect);
  }
  let got;
  try {
    got = runQualify(record.sql, record.dialect, options);
  } catch (e) {
    got = { error: e.constructor.name, message: e.message };
  }
  compare(record.name, record.sql, record.result, got, samples);
}

console.log();
console.log("  src/optimizer/qualify.js vs CPython sqlglot.optimizer.qualify (end-to-end)");
console.log(`    skipped (unsupported dialects): qualify_columns=${ref.qualify_columns_skipped} `
  + `qualify_columns_ddl=${ref.qualify_columns_ddl_skipped} `
  + `qualify_columns__with_invisible=${ref.qualify_columns__with_invisible_skipped} `
  + `qualify_tables=${ref.qualify_tables_skipped}`);
console.log(`    EXACT ${exact}    MISMATCH ${mismatch}    ERROR ${error}    KNOWN_GAP ${gap}`);
if (samples.length) {
  console.log();
  for (const s of samples) console.log(VERBOSE ? `  ${s}\n` : `  ${s.split("\n")[0]}`);
}
if (gapSamples.length && VERBOSE) {
  console.log();
  for (const s of gapSamples) console.log(`  ${s}\n`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
