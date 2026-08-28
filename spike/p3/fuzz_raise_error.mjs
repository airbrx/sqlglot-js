// PORT_PLAN.md §7 P3 exits: "`ParseError.errors` structure matches `test_errors.py`"
// and "`fuzz_unicode` green over error-message column positions".
//
//   python3 spike/p3/gen_raise_error_ref.py > spike/out/raise_error.jsonl
//   node spike/p3/fuzz_raise_error.mjs
//
// Both criteria are the same code path, so they are checked together: `raise_error`
// builds the seven-key `ParseError.errors[0]` dict AND slices the SQL for
// start_context / highlight / end_context.
//
// The unicode half is the load-bearing one. Every astral character is ONE Python code
// point and TWO JS UTF-16 units, so `String.prototype.slice` would cut a surrogate pair
// in half and shift every column after it. The inputs include emoji, Old Italic,
// mathematical alphanumerics, combining marks, RTL text, NBSP and a zero-width space,
// plus a case engineered so a 100-unit truncation lands mid-pair.

import { readFileSync } from "node:fs";
import { Parser } from "../../src/parser.js";
import { Token, TokenType } from "../../src/tokens.js";
import { ErrorLevel, ParseError } from "../../src/errors.js";

const rows = readFileSync("spike/out/raise_error.jsonl", "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

// The seven keys `ParseError.new` always sets, in order.
const KEYS = [
  "description", "line", "col", "start_context", "highlight", "end_context",
  "into_expression",
];

let pass = 0;
let astralPass = 0;
let astralTotal = 0;
const fails = [];

const isAstral = (s) => [...s].some((c) => c.codePointAt(0) > 0xffff);

for (const row of rows) {
  const p = new Parser({ errorLevel: ErrorLevel.IMMEDIATE, errorMessageContext: row.ctx });
  p.reset();
  p.sql = row.sql;
  p.sqlCodePoints = [...row.sql];

  let token;
  if (row.token) {
    token = new Token(
      TokenType[row.token.t], row.token.x, row.token.line, row.token.col,
      row.token.start, row.token.end, row.token.c,
    );
  }

  let got;
  try {
    if (token) p.raise_error("Invalid expression / Unexpected token", token);
    else p.raise_error("no tokens at all");
    got = { raised: false };
  } catch (e) {
    if (!(e instanceof ParseError)) {
      fails.push(`${JSON.stringify(row.sql.slice(0, 40))} ctx=${row.ctx} ti=${row.ti}: threw ${e.name}: ${e.message}`);
      continue;
    }
    got = { raised: true, message: e.message, errors: e.errors };
  }

  const want = row.out;
  const astral = isAstral(row.sql);
  if (astral) astralTotal += 1;

  const problems = [];
  if (got.raised !== want.raised) problems.push(`raised ${got.raised} vs ${want.raised}`);
  if (got.raised && want.raised) {
    if (got.message !== want.message) {
      problems.push(`message:\n       got  ${JSON.stringify(got.message)}\n       want ${JSON.stringify(want.message)}`);
    }
    if (got.errors.length !== want.errors.length) {
      problems.push(`errors length ${got.errors.length} vs ${want.errors.length}`);
    } else {
      const g = got.errors[0];
      const w = want.errors[0];
      // Structure: exactly the seven keys, in order, no extras and no omissions.
      const gk = Object.keys(g);
      if (gk.length !== KEYS.length || gk.some((k, i) => k !== KEYS[i])) {
        problems.push(`errors[0] keys ${JSON.stringify(gk)} != ${JSON.stringify(KEYS)}`);
      }
      for (const k of KEYS) {
        if (JSON.stringify(g[k] ?? null) !== JSON.stringify(w[k] ?? null)) {
          problems.push(`errors[0].${k}: ${JSON.stringify(g[k])} != ${JSON.stringify(w[k])}`);
        }
      }
    }
  }

  if (!problems.length) {
    pass += 1;
    if (astral) astralPass += 1;
  } else {
    fails.push(`${JSON.stringify(row.sql.slice(0, 40))} ctx=${row.ctx} ti=${row.ti}\n       ` + problems.join("\n       "));
  }
}

console.log(`\n  raise_error differential: ${pass}/${rows.length} byte-exact`);
console.log(`    of which astral-character inputs: ${astralPass}/${astralTotal}`);
for (const f of fails.slice(0, 10)) console.log(`    FAIL ${f}`);
if (fails.length > 10) console.log(`    ... and ${fails.length - 10} more`);

// A probe with no astral coverage would pass trivially on a UTF-16 implementation.
if (astralTotal === 0) {
  console.log("    NO astral inputs — the unicode half of this probe is vacuous");
}
const bad = fails.length > 0 || astralTotal === 0;
console.log(bad ? "\n  RAISE_ERROR: FAIL" : "\n  RAISE_ERROR: OK");
process.exit(bad ? 1 : 0);
