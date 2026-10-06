// Differential: `src/diff.js` vs CPython's `sqlglot.diff`, at the pin.
//
//   PYTHONHASHSEED=0 python3 spike/p10/gen_diff_ref.py > spike/out/diff.json
//   node spike/p10/fuzz_diff.mjs
//
// See `gen_diff_ref.py`'s own header for the full design: why this reproduces every
// `tests/test_diff.py` CALL rather than its hand-written `expected` values, why the
// comparison is a canonicalized SET (not a list) of `(type, a, b)` triples keyed on
// `.sql()`, and why the two `dialect="oracle"` rows are named-excluded (no Oracle
// `Parser`/`Dialect` in this port at all) with a real-dialect (postgres) substitute
// in their place.

import { readFileSync } from "node:fs";
import { parseOne } from "../../src/dialects/dialect.js";
import * as exp from "../../src/expressions/index.js";
import { diff, Insert, Remove, Move, Update, Keep } from "../../src/diff.js";
// Side-effect import: registers the real base-Generator dispatch, which `.sql()`
// needs. Without it every scenario would fail with "No SQL generator registered".
import "../../src/generator.js";
import "../../src/dialects/postgres.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = JSON.parse(readFileSync("spike/out/diff.json", "utf8"));

let exact = 0;
let mismatch = 0;
let error = 0;
let skipped = 0;
const samples = [];

function canon(e) {
  if (e instanceof Insert) return ["Insert", e.expression.sql(), null];
  if (e instanceof Remove) return ["Remove", e.expression.sql(), null];
  if (e instanceof Move) return ["Move", e.source.sql(), e.target.sql()];
  if (e instanceof Update) return ["Update", e.source.sql(), e.target.sql()];
  if (e instanceof Keep) return ["Keep", e.source.sql(), e.target.sql()];
  throw new TypeError(String(e));
}

// Tuple-wise comparison, matching Python's `sorted()` over `(type, a, b)` tuples --
// NOT a concatenate-then-compare-strings shortcut, which silently misorders whenever
// one field is a prefix of another (e.g. "LOWER(c)" vs "LOWER(c) AS c").
function compareTuples(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] === null) return -1;
    if (b[i] === null) return 1;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function runDiff(source, target, options) {
  try {
    const edits = diff(source, target, { delta_only: true, ...options });
    const canonical = [...new Set(edits.map((e) => JSON.stringify(canon(e))))]
      .map((s) => JSON.parse(s))
      .sort(compareTuples);
    return { ok: canonical };
  } catch (e) {
    return { error: e.constructor.name, message: e.message };
  }
}

// Pre-existing, unrelated base-Generator stubs (`src/generator.js`'s own `NotPorted`)
// that block rendering a node needed for the bigram-similarity step on these specific
// upstream scenarios — not a `diff.js` bug. Named by scenario, not by row id, and the
// exact error message is still checked so a future real fix here is caught as a
// (happy) MISMATCH rather than silently staying excluded.
const NAMED_GENERATOR_GAPS = new Map([
  ["position-concat-move", /NotPorted: concat_sql is not ported yet/],
  ["position-alias-remove-and-move", /NotPorted: concat_sql is not ported yet/],
]);

function check(name, got, expected) {
  const gapPattern = NAMED_GENERATOR_GAPS.get(name);
  if (gapPattern) {
    if ("error" in got && gapPattern.test(`${got.error}: ${got.message}`)) {
      skipped++;
      return;
    }
    // The named gap didn't reproduce as expected -- either it's been fixed (good:
    // update NAMED_GENERATOR_GAPS and let this scenario be asserted for real) or
    // something else about this row changed. Either way it must not count as silently
    // skipped.
  }
  let ok;
  if ("ok" in expected) {
    ok = "ok" in got && JSON.stringify(got.ok) === JSON.stringify(expected.ok);
  } else {
    ok = "error" in got && got.error === expected.error;
  }
  if (ok) {
    exact++;
  } else if ("error" in got && !("error" in expected)) {
    error++;
    samples.push(`ERROR   ${name}: ${got.error}: ${got.message}`);
  } else {
    mismatch++;
    samples.push(
      `MISMATCH ${name}\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(got)}`,
    );
  }
}

const byName = new Map(ref.scenarios.map((s) => [s.name, s]));

function simple(name) {
  const s = byName.get(name);
  const got = runDiff(parseOne(s.source_sql), parseOne(s.target_sql));
  check(name, got, s.result);
}

for (const s of ref.scenarios) {
  if (s.skip) {
    skipped++;
    continue;
  }
}

// --- straightforward parse+diff scenarios (everything except the hand-built /
// object-identity ones handled explicitly below) ---
const SIMPLE_NAMES = [
  "simple-add-sub",
  "simple-remove-column",
  "simple-insert-column",
  "simple-update-table",
  "lambda-rename",
  "udf-rename",
  "udf-arg-swap",
  "position-select-list",
  "position-add-operands",
  "position-and-operands",
  "position-or-chain",
  "position-concat-move",
  "position-alias-remove-and-move",
  "cte",
  "join-side-change",
  "join-case-insensitive-noop",
  "window-func-change",
  "identifier-insert-qualified-column",
  "identifier-alias-update",
  "non-expr-leaf-union-all",
  "non-expr-leaf-order-direction",
  "non-expr-leaf-order-direction-and-move",
  "comments-ignored",
];
for (const name of SIMPLE_NAMES) simple(name);

// --- window-self-noop: diff(expr, expr.copy()) ---
{
  const s = byName.get("window-self-noop");
  const src = parseOne(s.source_sql);
  const got = runDiff(src, src.copy());
  check("window-self-noop", got, s.result);
}

// --- dialect-aware-postgres-noop-substitute: dialect kwarg plumbing ---
{
  const s = byName.get("dialect-aware-postgres-noop-substitute");
  const src = parseOne(s.source_sql, { read: "postgres" });
  const got = runDiff(src, src.copy(), { dialect: "postgres" });
  check("dialect-aware-postgres-noop-substitute", got, s.result);
}

// --- pre-matchings: ONE shared (source, target) tree pair reused across calls,
// culminating in a `.replace()` that gives them a literally-shared node. ---
{
  const pmSrc = parseOne("SELECT 1");
  const pmTgt = parseOne("SELECT 1, 2, 3, 4");

  check(
    "pre-matchings-none",
    runDiff(pmSrc, pmTgt, { matchings: [] }),
    byName.get("pre-matchings-none").result,
  );
  check(
    "pre-matchings-one",
    runDiff(pmSrc, pmTgt, { matchings: [[pmSrc, pmTgt]] }),
    byName.get("pre-matchings-one").result,
  );
  check(
    "pre-matchings-duplicate-pair",
    runDiff(pmSrc, pmTgt, {
      matchings: [
        [pmSrc, pmTgt],
        [pmSrc, pmTgt],
      ],
    }),
    byName.get("pre-matchings-duplicate-pair").result,
  );

  // py:259 `expr_tgt.selects[0].replace(expr_src.selects[0])`.
  pmTgt.selects[0].replace(pmSrc.selects[0]);
  check(
    "pre-matchings-after-shared-node",
    runDiff(pmSrc, pmTgt, { matchings: [[pmSrc, pmTgt]] }),
    byName.get("pre-matchings-after-shared-node").result,
  );
}

// --- none-args-not-leaves: hand-built exp.Column, not parsed ---
{
  const noneSrc = new exp.Column({
    this: exp.toIdentifier("b"),
    table: exp.toIdentifier("a"),
    db: null,
    catalog: null,
  });
  const noneTgt = new exp.Column({ this: exp.toIdentifier("b"), table: exp.toIdentifier("a") });
  check("none-args-not-leaves", runDiff(noneSrc, noneTgt), byName.get("none-args-not-leaves").result);
}

console.log();
console.log("  src/diff.js vs CPython sqlglot.diff");
console.log(
  `    EXACT ${exact}    MISMATCH ${mismatch}    ERROR ${error}    SKIPPED ${skipped}` +
    " (2 oracle-dialect-not-ported + 2 concat_sql-not-ported, both named pre-existing gaps)",
);
if (samples.length) {
  console.log();
  for (const s of samples) console.log(VERBOSE ? `  ${s}\n` : `  ${s.split("\n")[0]}`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
