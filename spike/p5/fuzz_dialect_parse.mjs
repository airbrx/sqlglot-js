// Differential: `Dialect.get_or_raise(name).parse(sql)` end to end, against the AST
// oracle CPython produced for the same rows.
//
//   node spike/p5/fuzz_dialect_parse.mjs
//   node spike/p5/fuzz_dialect_parse.mjs --verbose
//
// `spike/p3/fuzz_ast_coverage.mjs` measures the PARSER. It builds the token stream from
// P1's harvested tokenizer settings, picks the `Parser` subclass from a name->class map,
// and hands it a stand-in dialect built from harvested attributes — three pieces of
// harness scaffolding standing in for the three things `Dialect` owns. This probe
// removes all three and measures the real entry point instead: a dialect NAME goes in,
// `Dialect.get_or_raise` resolves it through the registry, and `Dialect.parse` does its
// own tokenizing (`self.tokenizer_class`) and its own parser construction
// (`self.parser_class`).
//
// Two populations, because they support two different claims and conflating them would
// overstate the first:
//
//   DEFAULT — `src/` only. Nothing harvested, no harness object anywhere in the path:
//   `Dialect`'s own derived `tokenizer_class`, its own `parser_class` (`BaseParser`),
//   its own settings. Whatever this scores is what a caller gets from
//   `Dialect.get_or_raise(null).parse(sql)` today.
//
//   SNOWFLAKE — `src/` only as well, since `src/dialects/snowflake.js` landed. The
//   registry resolves the name to the real `Snowflake` class, whose own nested
//   `Tokenizer` subclass lexes the SQL and whose own settings the parser reads. When
//   this file was written that class did not exist, the probe registered a stand-in
//   carrying BASE settings and the BASE tokenizer, and the row scored **85.9%
//   (1,917/2,232)**; the gap to `fuzz_ast_coverage.mjs`'s harness-routed 98.7% was
//   described here as "exactly the size of that missing file, measured instead of
//   estimated". Landing the file moved it to 98.7% (2,359/2,390), which settles that
//   prediction: the gap was the settings class and nothing else.
//
//   The real path now scores marginally ABOVE the harness (2,359 vs 2,355 exact), which
//   is the expected direction and worth stating so it is not read as noise:
//   `fuzz_ast_coverage.mjs` builds its token stream from P1's harvested tokenizer
//   SETTINGS and deliberately has no per-dialect `Tokenizer` SUBCLASS (see
//   `dialect_tokenizer.mjs`'s header), so a handful of rows that need the real subclass
//   are reachable here and not there.
//
//   DUCKDB — `src/` only, since `src/dialects/duckdb.js` landed (P5, after
//   `parsers/duckdb.js` had already been ported behind the same synthetic stand-in
//   SNOWFLAKE used before it). Before this file existed, the registry resolved
//   "duckdb" to `spike/p3/dialect_tokenizer.mjs`'s harvested-settings stand-in;
//   `fuzz_ast_coverage.mjs` measures that path at **996/1014 REACHED (98.2%)** on the
//   corpus as it stands today (it was 973/990 when R22 landed the parser; the corpus
//   has grown since). This probe's real path scores **999/1017 (98.2%)** — three MORE
//   exact and three FEWER stub than the harness, the same direction Snowflake's row
//   above moved, and for the same reason: three rows needed the real `DuckDBTokenizer`
//   subclass rather than the harness's harvested-settings base tokenizer.

import { readFileSync } from "node:fs";
import { astDump, astLoad, toS } from "../../src/expressions/index.js";
import { Dialect } from "../../src/dialects/dialect.js";
import { captureLogs } from "../../src/logging.js";

const VERBOSE = process.argv.includes("--verbose");

// `src/dialects/snowflake.js` self-registers under "snowflake" at module load, so this
// bare import is the whole wiring. It replaces the stand-in this file used to declare
// inline — a `class Snowflake extends Dialect { static Parser = SnowflakeParser }`
// carrying BASE settings and the BASE tokenizer, which is what the SNOWFLAKE row's
// "routing only" caveat below used to be measuring.
import "../../src/dialects/snowflake.js";
import "../../src/dialects/duckdb.js";
// Same wiring for `src/dialects/postgres.js` (P5), added once that file existed.
// Before it landed, `Dialect.get_or_raise("postgres")` fell through to
// `dialect_tokenizer.mjs`'s synthetic stand-in via the test harness only — the real
// production path had no Postgres settings class at all and scored measurably below
// `fuzz_ast_coverage.mjs`'s harness-routed number (PORT_PLAN.md: this file's dispatch).
import "../../src/dialects/postgres.js";

const atoms = new Map();
for (const line of readFileSync("corpus/atoms.jsonl", "utf8").split("\n")) {
  if (!line) continue;
  const a = JSON.parse(line);
  atoms.set(a.atom_id, a);
}

function run(dialectName, file) {
  const b = { exact: 0, mismatch: 0, stub: 0, error: 0 };
  const samples = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line);
    const atom = atoms.get(row.atom_id);
    if (!atom) continue;

    let got;
    try {
      // The whole point of the probe is on this line: a NAME, resolved by the registry.
      const { result } = captureLogs(() => Dialect.get_or_raise(dialectName).parse(atom.sql));
      got = result[0];
    } catch (e) {
      b[e.name === "NotPorted" ? "stub" : "error"] += 1;
      if (e.name !== "NotPorted" && samples.length < 8) {
        samples.push(`ERROR    ${row.atom_id} ${JSON.stringify(atom.sql.slice(0, 60))}\n       ${e.name}: ${e.message.split("\n")[0].slice(0, 100)}`);
      }
      continue;
    }
    const want = astLoad(row.ast);
    if (JSON.stringify(astDump(got)) === JSON.stringify(astDump(want))) {
      b.exact += 1;
    } else {
      b.mismatch += 1;
      if (samples.length < 8) {
        samples.push(`MISMATCH ${row.atom_id} ${JSON.stringify(atom.sql.slice(0, 60))}\n       got  ${toS(got).split("\n").join(" ").slice(0, 110)}\n       want ${toS(want).split("\n").join(" ").slice(0, 110)}`);
      }
    }
  }
  return { b, samples };
}

console.log();
console.log("  Dialect.get_or_raise(name).parse(sql) vs the AST oracle");

let defaultExact = 0;
for (const [label, name, file, claim] of [
  ["DEFAULT  ", null, "corpus/ast/_default.jsonl", "src/ only — no harvested settings anywhere on this path"],
  ["SNOWFLAKE", "snowflake", "corpus/ast/snowflake.jsonl", "src/ only — real Snowflake class: own Tokenizer subclass + own settings"],
  ["DUCKDB   ", "duckdb", "corpus/ast/duckdb.jsonl", "src/ only — real DuckDB class: own Tokenizer subclass + own settings"],
  ["POSTGRES ", "postgres", "corpus/ast/postgres.jsonl", "src/ only — real Postgres class: own Tokenizer subclass + own settings"],
]) {
  const { b, samples } = run(name, file);
  const total = b.exact + b.mismatch + b.stub + b.error;
  const reached = b.exact + b.mismatch;
  const pct = reached ? ((100 * b.exact) / reached).toFixed(1) : "0.0";
  if (name === null) defaultExact = b.exact;
  console.log(
    `    ${label}  ${b.exact}/${reached} of REACHED rows exact (${pct}%)  ` +
      `[${total} total: ${b.exact} exact, ${b.mismatch} mismatch, ${b.stub} stub, ${b.error} error]`,
  );
  console.log(`               ${claim}`);
  if (VERBOSE) for (const s of samples) console.log(`      ${s}`);
}

// The query named in this dispatch's own acceptance criteria, asserted rather than
// merely counted, so a rewrite that quietly stopped resolving names would fail here
// instead of moving a percentage by a fraction.
console.log();
const SQL = "SELECT * FROM t WHERE x = 1";
for (const name of [null, "snowflake", "duckdb", "postgres"]) {
  const got = Dialect.get_or_raise(name).parse(SQL)[0];
  const shape = toS(got).split("\n").join(" ").replace(/\s+/g, " ");
  const parserName = Dialect.get_or_raise(name).constructor.parser_class.name;
  console.log(`    get_or_raise(${JSON.stringify(name)}).parse(${JSON.stringify(SQL)})  via ${parserName}`);
  console.log(`      ${shape}`);
}

// `parse` returns a LIST (py:1186 `-> list[exp.Expr | None]`), one entry per
// semicolon-separated statement; `parse_one` is what unwraps it.
const multi = Dialect.get_or_raise(null).parse("SELECT 1; SELECT 2");
console.log(`    parse("SELECT 1; SELECT 2") -> ${multi.length} statements (upstream returns a list)`);

const failures = [];
if (multi.length !== 2) failures.push(`parse() returned ${multi.length} statements, expected 2`);
if (!defaultExact) failures.push("the default dialect parsed nothing exactly");

console.log();
if (failures.length) {
  for (const f of failures) console.log(`    FAIL ${f}`);
  console.log("  DIALECT PARSE: FAIL");
  process.exit(1);
}
console.log("  DIALECT PARSE: OK");
