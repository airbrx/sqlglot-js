// `Generator.identifier_sql` against CPython over the whole flag space.
//
//   PYTHONHASHSEED=0 python3 spike/p4/gen_identifier_sql_ref.py > spike/out/identifier_sql_ref.json
//   node spike/p4/fuzz_identifier_sql.mjs
//
// See the ref generator for why this exists rather than leaning on the generate corpus:
// `identifier_sql` is demanded by 10,870 of 15,540 corpus rows and those rows reach
// almost none of its branches — 0.024% non-ASCII, no empty identifier, and only one of
// the eight (normalize x identify) combinations. Both defects in the method's first port
// were invisible to every one of them.
//
// Cases are EXACT, GAP, or MISMATCH. There are exactly TWO named, attributed gaps, each
// defined narrowly enough that it cannot absorb a new defect — a case qualifies only if
// it matches the gap's own mechanical signature, and anything else that differs fails the
// build:
//
//   safe-identifier-re  the port's `SAFE_IDENTIFIER_RE` verdict for that NAME differs
//                       from CPython's (shared P2 code, reported not patched)
//   final-sigma         the port raised `NotPorted` from `pyLower` and the name really
//                       does contain U+03A3 (this branch's own announced refusal)

import { readFileSync } from "node:fs";
import { Generator } from "../../src/generator.js";
import * as exp from "../../src/expressions/index.js";
import { SAFE_IDENTIFIER_RE } from "../../src/expressions/core.js";
import { Dialect } from "../../src/dialects/dialect.js";

const ref = JSON.parse(readFileSync("spike/out/identifier_sql_ref.json", "utf8"));
const dialect = Dialect.get_or_raise(null);

// Per NAME: does the port's regex agree with CPython's? Python's `\w` on a str pattern is
// Unicode-aware; JS's `\w` is ASCII-only even under /u, so `café` matches upstream and
// not here.
const regexDisagrees = ref.names.map(
  (name, i) => SAFE_IDENTIFIER_RE.test(name) !== ref.safe_identifier_re[i],
);

const CAPITAL_SIGMA = "Σ";

let exact = 0;
const gaps = [];
const sigmaGaps = [];
const mismatches = [];

for (const [i, normalize, identify, quoted, pretty, want] of ref.cases) {
  const name = ref.names[i];
  const generator = new Generator({ normalize, identify, pretty, dialect });
  let got;
  let refusedSigma = false;
  try {
    got = generator.identifier_sql(new exp.Identifier({ this: name, quoted }));
  } catch (e) {
    // Narrow on purpose: only `pyLower`'s own refusal, and only for a name that really
    // contains the one context-sensitive code point. A NotPorted from anywhere else, or
    // on a name without U+03A3, is a MISMATCH.
    refusedSigma =
      e.name === "NotPorted" &&
      /pyLower\(U\+03A3\)/.test(e.message || "") &&
      name.includes(CAPITAL_SIGMA);
    got = `ERR:${e.name === "PyValueError" ? "ValueError" : e.name}`;
  }
  if (got === want) {
    exact += 1;
  } else if (refusedSigma) {
    sigmaGaps.push({ name, identify, got, want });
  } else if (regexDisagrees[i]) {
    gaps.push({ name, identify, got, want });
  } else {
    mismatches.push({ name, normalize, identify, quoted, pretty, got, want });
  }
}

console.log(`\n  identifier_sql vs CPython over ${ref.cases.length} cases`);
console.log(`    EXACT     ${String(exact).padStart(6)}`);
console.log(`    GAP       ${String(gaps.length).padStart(6)}  safe-identifier-re (expressions/core.js — attributed below)`);
console.log(`    GAP       ${String(sigmaGaps.length).padStart(6)}  final-sigma (pyLower's announced refusal on U+03A3)`);
console.log(`    MISMATCH  ${String(mismatches.length).padStart(6)}  <- must be 0`);

if (sigmaGaps.length) {
  const names = [...new Set(sigmaGaps.map((g) => g.name))];
  console.log(`\n  GAP final-sigma — this branch's own, announced rather than approximated:`);
  console.log(`    src/_py/str.js pyLower refuses U+03A3, the ONE code point where str.lower()`);
  console.log(`    is context-sensitive (CPython handle_capital_sigma emits final sigma U+03C2`);
  console.log(`    at end of word). Finishing it needs Cased + Case_Ignorable range tables.`);
  console.log(`    Affects ${names.length} probe name(s): ${names.map((n) => JSON.stringify(n)).join(", ")}`);
  console.log(`    identifier_sql computes lower() unconditionally, as upstream does, so an`);
  console.log(`    identifier containing a capital sigma currently raises instead of rendering.`);
}

if (gaps.length) {
  const names = [...new Set(gaps.map((g) => g.name))];
  console.log(
    `\n  GAP, reported for the foundation owner rather than patched here (PORT_PLAN §8.1 Rule 3):`,
  );
  console.log(`    src/expressions/core.js:525  SAFE_IDENTIFIER_RE = /^[_a-zA-Z][\\w]*$/u`);
  console.log(`    upstream core.py:2810        re.compile(r"^[_a-zA-Z][\\w]*$")`);
  console.log(`    Python's \\w on a str pattern is UNICODE; JS's is ASCII-only even under /u.`);
  console.log(`    Affects ${names.length} of ${ref.names.length} probe names: ${names.map((n) => JSON.stringify(n)).join(", ")}`);
  console.log(`    Two readers, so this is NOT generator-only:`);
  console.log(`      core.js:584 toIdentifier  -> toIdentifier("café").args.quoted is true here, False upstream`);
  console.log(`      dialects/dialect.js can_quote -> identify="safe"/"unsafe" invert`);
}

for (const m of mismatches.slice(0, 20)) {
  console.log(
    `\n  MISMATCH ${JSON.stringify(m.name)} normalize=${m.normalize} identify=${m.identify} ` +
      `quoted=${m.quoted} pretty=${m.pretty}\n    got  ${JSON.stringify(m.got)}\n    want ${JSON.stringify(m.want)}`,
  );
}

console.log(
  mismatches.length === 0
    ? `\n  IDENTIFIER_SQL: green (${exact} exact, ${gaps.length + sigmaGaps.length} in two attributed gaps)\n`
    : `\n  IDENTIFIER_SQL: RED (${mismatches.length} unexplained)\n`,
);
process.exit(mismatches.length === 0 ? 0 : 1);
