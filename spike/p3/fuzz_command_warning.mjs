// PORT_PLAN.md §7 P3 exit: "The 18 `check_command_warning` log strings byte-exact
// (via `error_message_context`, not a hardcoded 100)."
//
//   python3 spike/p3/gen_command_warning_ref.py > spike/out/command_warnings.jsonl
//   node spike/p3/fuzz_command_warning.mjs
//
// The "18" is measured, not assumed: instrumenting upstream's own `validate_identity`
// finds 131 `check_command_warning=True` calls across all dialect suites, of which
// exactly 18 are Snowflake's — P3's dialect. All 131 are checked here; the Snowflake 18
// are reported separately because they are the stated gate.
//
// Dialect resolution is P5, so this drives `_warn_unsupported` with the token stream
// CPython's own tokenizer produced. That is deliberate isolation, not a shortcut: it
// tests exactly the thing P3 built (the message, and the `error_message_context`
// code-point truncation) and nothing it did not.

import { readFileSync } from "node:fs";
import { Parser } from "../../src/parser.js";
import { Token, TokenType } from "../../src/tokens.js";
import { captureLogs } from "../../src/logging.js";

const rows = readFileSync("spike/out/command_warnings.jsonl", "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

let pass = 0;
let skipped = 0;
const fails = [];
const byDialect = new Map();

for (const row of rows) {
  const stat = byDialect.get(row.dialect) || { pass: 0, total: 0 };
  if (!row.tokens || row.warning === null) {
    // Counted and named, never silently dropped.
    skipped += 1;
    continue;
  }
  stat.total += 1;

  const tokens = row.tokens.map(
    (t) => new Token(TokenType[t.t], t.x, t.line, t.col, t.start, t.end, t.c),
  );

  // Drive `_warn_unsupported` exactly as `_parse_command` does: the chunk under
  // consideration is `_tokens`, and `self.sql` is the whole statement.
  const p = new Parser();
  p.reset();
  p.sql = row.sql;
  p.sqlCodePoints = [...row.sql];
  p._tokens = tokens;
  p._tokens_size = tokens.length;

  const { output } = captureLogs(() => p._warn_unsupported());
  const got = output.length ? output[0].replace(/^WARNING:sqlglot:/, "") : null;

  // Both the exact message AND the substring upstream's own assertion uses.
  const messageOk = got === row.warning;
  const assertionOk = got !== null && got.includes(row.asserted_substring);

  if (messageOk && assertionOk) {
    pass += 1;
    stat.pass += 1;
  } else {
    fails.push(
      `[${row.dialect}] ${JSON.stringify(row.sql.slice(0, 60))}`
      + `\n       got  ${JSON.stringify(got)}`
      + `\n       want ${JSON.stringify(row.warning)}`
      + (messageOk ? "" : "\n       (message differs)")
      + (assertionOk ? "" : `\n       (missing asserted substring ${JSON.stringify(row.asserted_substring)})`),
    );
  }
  byDialect.set(row.dialect, stat);
}

const snow = byDialect.get("snowflake") || { pass: 0, total: 0 };
console.log(`\n  check_command_warning log strings: ${pass}/${pass + fails.length} byte-exact`);
console.log(`    snowflake (the §7 P3 gate): ${snow.pass}/${snow.total}`);
for (const [d, s] of [...byDialect].sort()) {
  if (s.pass !== s.total) console.log(`    <- ${d.padEnd(12)} ${s.pass}/${s.total}`);
}
if (skipped) console.log(`    ${skipped} rows skipped (upstream emitted no warning or no token stream)`);
for (const f of fails.slice(0, 10)) console.log(`    FAIL ${f}`);
if (fails.length > 10) console.log(`    ... and ${fails.length - 10} more`);

// The gate is Snowflake's 18. Anything less means the criterion is not met, even if
// the aggregate looks healthy.
const gateOk = snow.total === 18 && snow.pass === 18;
if (!gateOk) console.log(`    GATE: expected 18/18 snowflake, got ${snow.pass}/${snow.total}`);

const bad = fails.length > 0 || !gateOk;
console.log(bad ? "\n  COMMAND WARNINGS: FAIL" : "\n  COMMAND WARNINGS: OK");
process.exit(bad ? 1 : 0);
