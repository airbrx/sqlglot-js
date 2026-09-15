// Differential: `Dialect.get_or_raise(name).generate(ast)` end to end, against the
// generate-oracle CPython produced for the same rows.
//
//   node spike/p5/fuzz_dialect_generate.mjs
//   node spike/p5/fuzz_dialect_generate.mjs --verbose
//
// `spike/p4/fuzz_generate_oracle.mjs` measures the GENERATOR. Its own header explains
// why it constructs `new Generator({dialect: writeDialect, ...})` directly rather than
// going through `Dialect.generate`: "`Dialect.generator_class` is unset, and wiring it
// is a change to a P5-owned file." That was true when it was written and is not true
// any more -- `src/generators/snowflake.js` exists and `Dialect.generator_class`
// (base) plus `Snowflake.generator_class` are both wired this round. This probe is the
// generator's counterpart to `fuzz_dialect_parse.mjs`: it removes the harness
// construction and measures the real entry point instead -- a dialect NAME goes in,
// `Dialect.get_or_raise` resolves it through the registry, and `Dialect.generate` does
// its own generator construction (`self.generator_class`) and its own settings lookup,
// exactly what a caller of `expression.sql(dialect="snowflake")` actually exercises.
//
// This file does NOT replace `fuzz_generate_oracle.mjs` -- that probe's claim ("the
// base Generator, wired directly, across every dialect's corpus rows") is broader and
// still worth keeping; this one's claim is narrower and different: "the REAL
// `Dialect.get_or_raise(name).generate()` production path, for the named dialects this
// port actually registers." Two populations, same reason `fuzz_dialect_parse.mjs` keeps
// two:
//
//   DEFAULT   — `src/` only. `Dialect.get_or_raise(null).generate(ast)`, the base
//   `Generator`, no dialect-specific settings or TRANSFORMS anywhere on the path.
//
//   SNOWFLAKE — `src/` only as well. The registry resolves to the real `Snowflake`
//   class, whose `generator_class` is the real `SnowflakeGenerator` — its own
//   `TRANSFORMS`, its own settings, its own `*_sql` overrides.
//
// HIVE/SPARK2/SPARK/DATABRICKS (PORT_PLAN.md, the Databricks-chain generator step) add
// a fourth population: the real four-link `Hive <- Spark2 <- Spark <- Databricks`
// inheritance chain, each resolving through the registry to its own
// `{Hive,Spark2,Spark,Databricks}Generator`.
//
// Their AST lookup pools MULTIPLE `corpus/ast/*.jsonl` stems rather than just the
// row's own dialect, which SNOWFLAKE/DEFAULT don't need to: `atom_id` is a
// content-addressed hash of the AST shape, harvested once per distinct SQL string
// across the WHOLE corpus, not scoped per dialect file. Measured directly: querying
// `corpus/gen/spark2.jsonl`'s 94 `ast_ref`s against `corpus/ast/spark2.jsonl` alone
// finds ZERO of them (spark2's own AST harvest happens to have no content overlap with
// its own generate corpus), while pooling `hive`/`spark2`/`spark`/`databricks`/
// `_default` finds all 94 — the four dialects share so much AST shape with each other
// and with the base corpus that a single-stem lookup silently starves whichever
// dialect's harvest was smallest. SNOWFLAKE/DEFAULT are left on single-stem lookup
// deliberately: changing an established row's behavior is out of this step's scope,
// and neither shows the zero-overlap failure mode.

import { readFileSync } from "node:fs";
import { astLoad } from "../../src/expressions/index.js";
import { Dialect } from "../../src/dialects/dialect.js";
import { captureLogs } from "../../src/logging.js";

// `src/dialects/snowflake.js` self-registers under "snowflake" at module load, so this
// bare import is the whole wiring -- same shape as `fuzz_dialect_parse.mjs`. Same for
// `databricks.js`, which transitively imports `spark.js` -> `spark2.js` -> `hive.js`,
// registering all four links in the chain.
import "../../src/dialects/snowflake.js";
import "../../src/dialects/databricks.js";
// `duckdb.js` registers a fifth, single-file population: the real `DuckDBGenerator`,
// but a DELIBERATELY SCOPED one (PORT_PLAN.md R32) — roughly 60 of 147 `TRANSFORMS`
// entries and none of the 140 `*_sql` overrides, so its % EXACT is not expected to
// approach SNOWFLAKE's.
import "../../src/dialects/duckdb.js";
// `postgres.js` registers a sixth, single-file population: the real
// `PostgresGenerator` (PORT_PLAN.md, the Postgres generator step — full TRANSFORMS +
// settings + *_sql overrides, ported whole like SNOWFLAKE, not scoped like DUCKDB).
import "../../src/dialects/postgres.js";
// `redshift.js` registers a seventh, single-file population: the real
// `RedshiftGenerator` (PORT_PLAN.md, the Redshift generator step — extends the already-
// real `PostgresGenerator` at a single link, full TRANSFORMS + settings + *_sql
// overrides, ported whole like POSTGRES/SNOWFLAKE, not scoped like DUCKDB).
import "../../src/dialects/redshift.js";
// `bigquery.js` registers an eighth, single-file population: the real
// `BigQueryGenerator` (PORT_PLAN.md, the BigQuery dialect+generator step — full
// TRANSFORMS + settings + *_sql overrides, ported whole like POSTGRES/SNOWFLAKE, not
// scoped like DUCKDB — with one narrow documented exception, see the file's own header:
// `explode_projection_to_unnest` is omitted from the `exp.Select` TRANSFORMS chain).
import "../../src/dialects/bigquery.js";
// `tsql.js` registers a ninth, single-file population: the real `TSQLGenerator`
// (PORT_PLAN.md, TSQL dialect+generator round — standalone, extends `Generator`
// directly, no chain). Full TRANSFORMS + settings + *_sql overrides ported, like
// SNOWFLAKE/POSTGRES/REDSHIFT, not scoped like DUCKDB, minus two upstream TRANSFORMS
// entries (`exp.CTE`/`exp.Subquery`) still blocked on the unported
// `optimizer/qualify_columns.py` — see that file's own header.
import "../../src/dialects/tsql.js";

const VERBOSE = process.argv.includes("--verbose");

/** ast_ref/atom_id -> parsed row, pooled from one or more corpus/ast/<stem>.jsonl files. */
function loadAstFiles(dialectFileStems) {
  const map = new Map();
  for (const stem of dialectFileStems) {
    let text;
    try {
      text = readFileSync(`corpus/ast/${stem}.jsonl`, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      const row = JSON.parse(line);
      if (!map.has(row.atom_id)) map.set(row.atom_id, row);
    }
  }
  return map;
}

function run(dialectName, genFileStem, astFileStems) {
  const b = { exact: 0, mismatch: 0, stub: 0, error: 0 };
  const samples = [];
  const astRows = loadAstFiles(Array.isArray(astFileStems) ? astFileStems : [astFileStems]);

  let genText;
  try {
    genText = readFileSync(`corpus/gen/${genFileStem}.jsonl`, "utf8");
  } catch {
    return { b, samples };
  }

  for (const line of genText.split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line);
    const astRow = astRows.get(row.ast_ref);
    if (!astRow) continue;

    let ast;
    try {
      ast = astLoad(astRow.ast);
    } catch (e) {
      b.error += 1;
      if (samples.length < 8) samples.push(`ERROR(astLoad) ${row.atom_id} ${e.name}: ${e.message.split("\n")[0].slice(0, 100)}`);
      continue;
    }

    let got;
    try {
      const { result } = captureLogs(() =>
        // The whole point of the probe is on this line: a NAME, resolved by the
        // registry, doing its own generator construction.
        Dialect.get_or_raise(dialectName).generate(ast, {
          pretty: row.flags.pretty,
          identify: row.flags.identify,
        }),
      );
      got = result;
    } catch (e) {
      b[e.name === "NotPorted" ? "stub" : "error"] += 1;
      if (e.name !== "NotPorted" && samples.length < 8) {
        samples.push(`ERROR    ${row.atom_id} ${JSON.stringify(row.sql.slice(0, 60))}\n       ${e.name}: ${e.message.split("\n")[0].slice(0, 100)}`);
      }
      continue;
    }

    if (got === row.sql) {
      b.exact += 1;
    } else {
      b.mismatch += 1;
      if (samples.length < 8) {
        samples.push(`MISMATCH ${row.atom_id}\n       got  ${JSON.stringify(got).slice(0, 110)}\n       want ${JSON.stringify(row.sql).slice(0, 110)}`);
      }
    }
  }
  return { b, samples };
}

console.log();
console.log("  Dialect.get_or_raise(name).generate(ast) vs the generate oracle");

const CHAIN_AST_POOL = ["hive", "spark2", "spark", "spark, version=3.0.0", "spark, version=4.0.0", "databricks", "_default"];

let snowflakeExact = 0;
let duckdbExact = 0;
let postgresExact = 0;
let redshiftExact = 0;
let bigqueryExact = 0;
let tsqlExact = 0;
const chainExact = {};
for (const [label, name, genStem, astStems, claim] of [
  ["DEFAULT   ", null, "_default", ["_default"], "src/ only — base Generator, no dialect-specific settings on this path"],
  ["SNOWFLAKE ", "snowflake", "snowflake", ["snowflake"], "src/ only — real SnowflakeGenerator: own TRANSFORMS + own settings + own *_sql overrides"],
  ["HIVE      ", "hive", "hive", CHAIN_AST_POOL, "src/ only — real HiveGenerator: own TRANSFORMS + own settings + own *_sql overrides"],
  ["SPARK2    ", "spark2", "spark2", CHAIN_AST_POOL, "src/ only — real Spark2Generator extends HiveGenerator"],
  ["SPARK     ", "spark", "spark", CHAIN_AST_POOL, "src/ only — real SparkGenerator extends Spark2Generator"],
  ["DATABRICKS", "databricks", "databricks", CHAIN_AST_POOL, "src/ only — real DatabricksGenerator extends SparkGenerator"],
  ["DUCKDB    ", "duckdb", "duckdb", ["duckdb"], "src/ only — real DuckDBGenerator, a SCOPED subset (PORT_PLAN.md R32), not full TRANSFORMS/*_sql coverage"],
  ["POSTGRES  ", "postgres", "postgres", ["postgres"], "src/ only — real PostgresGenerator: own TRANSFORMS + own settings + own *_sql overrides"],
  ["REDSHIFT  ", "redshift", "redshift", ["redshift"], "src/ only — real RedshiftGenerator extends PostgresGenerator: own TRANSFORMS + own settings + own *_sql overrides"],
  ["BIGQUERY  ", "bigquery", "bigquery", ["bigquery"], "src/ only — real BigQueryGenerator: own TRANSFORMS + own settings + own *_sql overrides"],
  ["TSQL      ", "tsql", "tsql", ["tsql"], "src/ only — real TSQLGenerator: own TRANSFORMS + own settings + own *_sql overrides (exp.CTE/exp.Subquery still blocked on unported optimizer/qualify_columns.py)"],
]) {
  const { b, samples } = run(name, genStem, astStems);
  const total = b.exact + b.mismatch + b.stub + b.error;
  const reached = b.exact + b.mismatch;
  const pct = reached ? ((100 * b.exact) / reached).toFixed(1) : "0.0";
  if (name === "snowflake") snowflakeExact = b.exact;
  if (name === "duckdb") duckdbExact = b.exact;
  if (name === "postgres") postgresExact = b.exact;
  if (name === "redshift") redshiftExact = b.exact;
  if (name === "bigquery") bigqueryExact = b.exact;
  if (name === "tsql") tsqlExact = b.exact;
  if (name && ["hive", "spark2", "spark", "databricks"].includes(name)) chainExact[name] = b.exact;
  console.log(
    `    ${label}  ${b.exact}/${reached} of REACHED rows exact (${pct}%)  ` +
      `[${total} total: ${b.exact} exact, ${b.mismatch} mismatch, ${b.stub} stub, ${b.error} error]`,
  );
  console.log(`               ${claim}`);
  if (VERBOSE) for (const s of samples) console.log(`      ${s}`);
}

// The query named in this dispatch's own acceptance criteria, asserted rather than
// merely counted, mirroring `fuzz_dialect_parse.mjs`'s closing check.
console.log();
const AST = { c: "Select", a: [["expressions", [{ c: "Column", a: [["this", { c: "Identifier", a: [["this", "a"], ["quoted", false]] }]] }]]] };
for (const name of [null, "snowflake", "hive", "spark2", "spark", "databricks", "duckdb", "postgres", "redshift", "bigquery", "tsql"]) {
  const got = Dialect.get_or_raise(name).generate(astLoad(AST));
  const generatorName = Dialect.get_or_raise(name).constructor.generator_class.name;
  console.log(`    get_or_raise(${JSON.stringify(name)}).generate(SELECT a)  via ${generatorName}  -> ${JSON.stringify(got)}`);
}

const failures = [];
if (!snowflakeExact) failures.push("the snowflake dialect generated nothing exactly");
if (!duckdbExact) failures.push("the duckdb dialect generated nothing exactly");
if (!postgresExact) failures.push("the postgres dialect generated nothing exactly");
if (!redshiftExact) failures.push("the redshift dialect generated nothing exactly");
if (!bigqueryExact) failures.push("the bigquery dialect generated nothing exactly");
if (!tsqlExact) failures.push("the tsql dialect generated nothing exactly");
for (const name of ["hive", "spark2", "spark", "databricks"]) {
  if (!chainExact[name]) failures.push(`the ${name} dialect generated nothing exactly`);
}

console.log();
if (failures.length) {
  for (const f of failures) console.log(`    FAIL ${f}`);
  console.log("  DIALECT GENERATE: FAIL");
  process.exit(1);
}
console.log("  DIALECT GENERATE: OK");
