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

import { readFileSync } from "node:fs";
import { astLoad } from "../../src/expressions/index.js";
import { Dialect } from "../../src/dialects/dialect.js";
import { captureLogs } from "../../src/logging.js";

// `src/dialects/snowflake.js` self-registers under "snowflake" at module load, so this
// bare import is the whole wiring -- same shape as `fuzz_dialect_parse.mjs`.
import "../../src/dialects/snowflake.js";

const VERBOSE = process.argv.includes("--verbose");

/** ast_ref/atom_id -> parsed row from corpus/ast/<dialect>.jsonl, loaded lazily per file. */
function loadAstFile(dialectFileStem) {
  const map = new Map();
  let text;
  try {
    text = readFileSync(`corpus/ast/${dialectFileStem}.jsonl`, "utf8");
  } catch {
    return map;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line);
    map.set(row.atom_id, row);
  }
  return map;
}

function run(dialectName, genFileStem, astFileStem) {
  const b = { exact: 0, mismatch: 0, stub: 0, error: 0 };
  const samples = [];
  const astRows = loadAstFile(astFileStem);

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

let snowflakeExact = 0;
for (const [label, name, genStem, astStem, claim] of [
  ["DEFAULT  ", null, "_default", "_default", "src/ only — base Generator, no dialect-specific settings on this path"],
  ["SNOWFLAKE", "snowflake", "snowflake", "snowflake", "src/ only — real SnowflakeGenerator: own TRANSFORMS + own settings + own *_sql overrides"],
]) {
  const { b, samples } = run(name, genStem, astStem);
  const total = b.exact + b.mismatch + b.stub + b.error;
  const reached = b.exact + b.mismatch;
  const pct = reached ? ((100 * b.exact) / reached).toFixed(1) : "0.0";
  if (name === "snowflake") snowflakeExact = b.exact;
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
for (const name of [null, "snowflake"]) {
  const got = Dialect.get_or_raise(name).generate(astLoad(AST));
  const generatorName = Dialect.get_or_raise(name).constructor.generator_class.name;
  console.log(`    get_or_raise(${JSON.stringify(name)}).generate(SELECT a)  via ${generatorName}  -> ${JSON.stringify(got)}`);
}

const failures = [];
if (!snowflakeExact) failures.push("the snowflake dialect generated nothing exactly");

console.log();
if (failures.length) {
  for (const f of failures) console.log(`    FAIL ${f}`);
  console.log("  DIALECT GENERATE: FAIL");
  process.exit(1);
}
console.log("  DIALECT GENERATE: OK");
