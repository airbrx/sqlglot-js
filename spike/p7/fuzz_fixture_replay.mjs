// Differential: the ten remaining zero-oracle optimizer fixture files (AIR-2315 Part
// 3, the last part of "13.7 Replay the un-replayed optimizer fixture files") --
// `canonicalize_internal_names.sql` (65), `unnest_subqueries.sql` (41),
// `normalize_identifiers.sql` (30), `eliminate_subqueries.sql` (27),
// `optimize_joins.sql` (18), `quote_identifiers.sql` (10),
// `isolate_table_selects.sql` (8), `eliminate_ctes.sql` (6),
// `pushdown_cte_alias_columns.sql` (6) -- 211 pairs, replayed against their real
// `self.check_file(...)` call site -- plus `annotate_types.sql` (71), replayed in its
// own type-string compare mode against `test_annotate_types` directly (NOT
// `check_file`). 282 pairs total.
//
//   PYTHONHASHSEED=0 python3 spike/p7/gen_fixture_replay_ref.py > spike/out/fixture_replay.json
//   node spike/p7/fuzz_fixture_replay.mjs
//
// See `gen_fixture_replay_ref.py`'s own header for the full per-file driver rationale
// (verified against every real `check_file(...)` call site, not guessed) and for why
// `canonicalize_internal_names.sql` was the one real MODULE gap this round found:
// `src/optimizer/canonicalize_internal_names.js` did not exist at all before this
// round (it is not part of the default `optimize()` pipeline upstream either, so no
// prior closure/demand tracer ever reached it -- see that new file's own header).

import { readFileSync } from "node:fs";
import { parseOne } from "../../src/dialects/dialect.js";
import { Dialect } from "../../src/dialects/dialect.js";
// Side-effect imports: register every dialect this corpus's `# dialect:` meta names
// (verified against the pin, across all ten files: bigquery, databricks, duckdb,
// postgres, presto, redshift, snowflake, spark, sqlite).
import "../../src/dialects/bigquery.js";
import "../../src/dialects/databricks.js";
import "../../src/dialects/duckdb.js";
import "../../src/dialects/postgres.js";
import "../../src/dialects/presto.js";
import "../../src/dialects/redshift.js";
import "../../src/dialects/snowflake.js";
import "../../src/dialects/spark.js";
import "../../src/dialects/sqlite.js";

import { qualify } from "../../src/optimizer/qualify.js";
import { canonicalize_internal_names } from "../../src/optimizer/canonicalize_internal_names.js";
import { unnest_subqueries } from "../../src/optimizer/unnest_subqueries.js";
import { normalize_identifiers } from "../../src/optimizer/normalize_identifiers.js";
import { eliminate_subqueries } from "../../src/optimizer/eliminate_subqueries.js";
import { optimize_joins } from "../../src/optimizer/optimize_joins.js";
import { quote_identifiers, pushdown_cte_alias_columns } from "../../src/optimizer/qualify_columns.js";
import { isolate_table_selects } from "../../src/optimizer/isolate_table_selects.js";
import { eliminate_ctes } from "../../src/optimizer/eliminate_ctes.js";
import { buildScope } from "../../src/optimizer/scope.js";
import { annotate_types } from "../../src/optimizer/annotate_types.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = JSON.parse(readFileSync("spike/out/fixture_replay.json", "utf8"));

// py: `TestOptimizer.setUp`'s own `self.schema` literal.
const SELF_SCHEMA = {
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

// py: test_optimizer.py:33 `qualify_then_canonicalize(expression, **qualify_kwargs)`.
function qualifyThenCanonicalize(ast, kwargs) {
  return canonicalize_internal_names(qualify(ast, kwargs));
}

// py: test_optimizer.py:73 `pushdown_ctes(expression, **kwargs)`.
function pushdownCtes(ast) {
  pushdown_cte_alias_columns(buildScope(ast));
  return ast;
}

// Each entry mirrors ONE `self.check_file(...)` call site -- see
// `gen_fixture_replay_ref.py`'s own header for the exact line numbers and upstream
// reproduction. `run(ast, {dialect, validateQualifyColumns})` returns the optimized AST.
const FILES = {
  canonicalize_internal_names: {
    run: (ast, k) =>
      qualifyThenCanonicalize(ast, {
        schema: { ...SELF_SCHEMA, jtbl: { j: "JSON" }, pvt: { c: "TEXT", v: "INT" } },
        catalog: "c",
        db: "db",
        dialect: k.dialect || undefined,
        ...(k.validateQualifyColumns !== undefined
          ? { validateQualifyColumns: k.validateQualifyColumns }
          : {}),
      }),
    pretty: false,
  },
  unnest_subqueries: { run: (ast) => unnest_subqueries(ast), pretty: false },
  normalize_identifiers: {
    // `normalize_identifiers.js`'s own file header: `dialect` must already be a
    // RESOLVED Dialect instance (deliberate narrowing from upstream's accept-a-name-or-
    // None signature, to break an import cycle) -- resolve it the same way `qualify()`
    // does internally before calling.
    run: (ast, k) => normalize_identifiers(ast, Dialect.get_or_raise(k.dialect || null)),
    pretty: false,
  },
  eliminate_subqueries: { run: (ast) => eliminate_subqueries(ast), pretty: false },
  optimize_joins: { run: (ast) => optimize_joins(ast), pretty: false },
  quote_identifiers: {
    run: (ast, k) => quote_identifiers(ast, k.dialect || null),
    pretty: false,
  },
  isolate_table_selects: {
    run: (ast) => isolate_table_selects(ast, { schema: SELF_SCHEMA }),
    pretty: false,
  },
  eliminate_ctes: { run: (ast) => eliminate_ctes(ast), pretty: true },
  pushdown_cte_alias_columns: { run: (ast) => pushdownCtes(ast), pretty: false },
};

function runCheckFileRow(row) {
  const entry = FILES[row.file];
  const dialect = row.dialect || null;
  const ast = parseOne(row.sql, { read: dialect || undefined });
  const kwargs = { dialect };
  // py: `check_file`'s own `validate_qualify_columns` meta handling -- only
  // `canonicalize_internal_names.sql` carries this meta key at this pin (one row,
  // `# validate_qualify_columns: false`); the ref JSON carries the resolved boolean
  // per record so this side never needs to re-parse fixture meta itself.
  if (row.validate_qualify_columns !== null && row.validate_qualify_columns !== undefined) {
    kwargs.validateQualifyColumns = row.validate_qualify_columns;
  }
  const optimized = entry.run(ast, kwargs);
  return optimized.sql(dialect || null, { pretty: entry.pretty });
}

function runAnnotateTypesRow(row) {
  const dialect = row.dialect || null;
  const ast = parseOne(row.sql, { read: dialect || undefined });
  const result = annotate_types(ast, { dialect });
  return result.type.sql(dialect);
}

let exact = 0;
let mismatch = 0;
let error = 0;
const samples = [];
const perFile = new Map();

function bump(file, key) {
  if (!perFile.has(file)) perFile.set(file, { EXACT: 0, MISMATCH: 0, ERROR: 0 });
  perFile.get(file)[key]++;
}

for (const row of ref.records) {
  const name = `${row.file}#${row.i} (${row.dialect || "default"})`;

  let got;
  try {
    got = { ok: row.file === "annotate_types" ? runAnnotateTypesRow(row) : runCheckFileRow(row) };
  } catch (e) {
    got = { error: e.constructor.name, message: e.message };
  }

  if ("error" in got) {
    error++;
    bump(row.file, "ERROR");
    samples.push(`ERROR   ${name}: ${got.error}: ${got.message}\n  sql: ${row.sql}\n  title: ${row.title}`);
  } else if (got.ok === row.expected) {
    exact++;
    bump(row.file, "EXACT");
  } else {
    mismatch++;
    bump(row.file, "MISMATCH");
    samples.push(
      `MISMATCH ${name}\n  sql:      ${row.sql}\n  title:    ${row.title}\n  expected: ${row.expected}\n  got:      ${got.ok}`,
    );
  }
}

console.log();
console.log("  ten zero-oracle optimizer fixture files vs CPython (AIR-2315 Part 3 fixture replay)");
for (const [file, c] of perFile) {
  console.log(`      ${`${file}.sql`.padEnd(36)} EXACT ${c.EXACT}  MISMATCH ${c.MISMATCH}  ERROR ${c.ERROR}`);
}
console.log(`    EXACT ${exact}    MISMATCH ${mismatch}    ERROR ${error}`);
if (samples.length) {
  console.log();
  for (const s of samples) console.log(VERBOSE ? `  ${s}\n` : `  ${s.split("\n")[0]}`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
