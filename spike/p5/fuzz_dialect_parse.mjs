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
//   SNOWFLAKE — registry ROUTING only. It proves `get_or_raise("snowflake")` reaches
//   `SnowflakeParser`, which is the piece P5 adds. It does NOT prove a complete
//   Snowflake pipeline, and the number is deliberately printed rather than hidden:
//   `src/dialects/snowflake.js` (the ~192-LOC settings class) and a Snowflake
//   `Tokenizer` subclass do not exist yet, so this run uses the BASE tokenizer and the
//   BASE settings. The gap between it and `fuzz_ast_coverage.mjs`'s snowflake figure is
//   exactly the size of that missing file, measured instead of estimated.

import { readFileSync } from "node:fs";
import { astDump, astLoad, toS } from "../../src/expressions/index.js";
import { Dialect, registerDialect } from "../../src/dialects/dialect.js";
import { SnowflakeParser } from "../../src/parsers/snowflake.js";
import { captureLogs } from "../../src/logging.js";

const VERBOSE = process.argv.includes("--verbose");

// The next P5 dispatch replaces this with `src/dialects/snowflake.js`, whose class body
// is the ~40 settings overrides `dialects/snowflake.py` declares. Registered here with
// only its `Parser` so the ROUTING is under test and the settings gap stays visible.
class Snowflake extends Dialect {
  static Parser = SnowflakeParser;
}
registerDialect("snowflake", Snowflake);

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
  ["SNOWFLAKE", "snowflake", "corpus/ast/snowflake.jsonl", "routing only — base tokenizer + base settings, see header"],
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
for (const name of [null, "snowflake"]) {
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
