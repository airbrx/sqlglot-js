// The named go/no-go case: tests/dialects/test_snowflake.py:367.
//
//   self.validate_all("SELECT RANDOM()", write={"duckdb":
//     "SELECT CAST(-9.223372036854776E+18 + RANDOM() * "
//     "(9.223372036854776e+18 - -9.223372036854776E+18) AS BIGINT)"})
//
// The mixed casing is not a typo upstream. parsers/snowflake.py:573 builds
//   exp.Rand(lower=Literal.number(-9223372036854775808.0),
//            upper=Literal.number( 9223372036854775807.0))
// and expressions/core.py:1755 Literal.number renders the two bounds through
// *different* functions:
//
//   upper >= 0 -> keeps str(float)            -> '9.223372036854776e+18'  (lowercase, padded exp)
//   lower <  0 -> str(abs(Decimal(str(f))))   -> '9.223372036854776E+18'  (uppercase, unpadded exp)
//                 and is wrapped in Neg, which is what re-adds the '-'.
//
// So a single literal in a single test pins BOTH pyFloatToStr and str(Decimal),
// and pins that they disagree on casing. That is why this is the go/no-go.

import { literalNumberText, pyFloatToStr } from "../src/_py/num.js";

const LOWER = -9223372036854775808.0; // -2**63 as float
const UPPER = 9223372036854775807.0; //  2**63-1 as float

function render(v) {
  const { text, neg } = literalNumberText(v);
  return (neg ? "-" : "") + text; // Neg(this=Literal) renders as '-' + literal
}

const lower = render(LOWER);
const upper = render(UPPER);

// duckdb rand_sql (generators/duckdb.py:3726):
//   scaled = lower + random() * paren(upper - lower); cast to BIGINT
const got = `SELECT CAST(${lower} + RANDOM() * (${upper} - ${lower}) AS BIGINT)`;
const want =
  "SELECT CAST(-9.223372036854776E+18 + RANDOM() * " +
  "(9.223372036854776e+18 - -9.223372036854776E+18) AS BIGINT)";

const checks = [
  ["lower literal", lower, "-9.223372036854776E+18"],
  ["upper literal", upper, "9.223372036854776e+18"],
  ["full SQL", got, want],
];

let bad = 0;
for (const [name, g, w] of checks) {
  const ok = g === w;
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) console.log(`         want ${w}\n         got  ${g}`);
}

// Demonstrate that the naive port is wrong here, so the gate is not vacuous.
console.log("\n  naive-JS comparison (what a port using String(x) would emit):");
console.log(`    String(${LOWER})            -> ${String(LOWER)}`);
console.log(`    String(${UPPER})            -> ${String(UPPER)}`);
console.log(`    pyFloatToStr(lower)         -> ${pyFloatToStr(LOWER)}`);
console.log(`    pyFloatToStr(upper)         -> ${pyFloatToStr(UPPER)}`);
console.log(
  `    naive full SQL matches?     -> ${
    `SELECT CAST(${String(LOWER)} + RANDOM() * (${String(UPPER)} - ${String(LOWER)}) AS BIGINT)` ===
    want
  }`,
);

console.log(bad === 0 ? "\n  GO/NO-GO LITERAL: GREEN\n" : `\n  GO/NO-GO LITERAL: RED (${bad})\n`);
process.exit(bad === 0 ? 0 : 1);
