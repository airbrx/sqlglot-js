// Differential: `src/optimizer/optimizer.js` (`optimize()` + `RULES`) vs CPython's
// `sqlglot.optimizer.optimizer`, at the pin.
//
//   PYTHONHASHSEED=0 python3 spike/p10/gen_optimizer_ref.py > spike/out/optimizer.json
//   node spike/p10/fuzz_optimizer.mjs
//
// See `gen_optimizer_ref.py`'s own header for the full rationale. Summary: both sides
// run the real, full-default-`RULES` `optimizer.optimize(sql, schema=..., infer_schema=
// True, dialect=...)` pipeline over the real `tests/fixtures/optimizer/optimizer.sql`
// fixture (`TestOptimizer.test_optimize`'s own fixture file) plus its one inline
// assertion, and the CPython side's own `output` is asserted against the fixture's
// real quoted "expected" text (see that file's `scenario()`), so a match here is a
// match against upstream's actual documented behavior, not just internal
// self-consistency between the two oracle scripts.
//
// `# dialect: mysql` / `# dialect: mysql, normalization_strategy = lowercase` fixture
// rows are SKIPPED (not ERROR): `src/dialects/mysql.js` does not exist in this port
// yet, so `parseOne(sql, { read: "mysql" })` already throws independently of
// `optimizer.js` itself -- same shape `gen_canonicalize_ref.py` (R76) already
// documents for its own two mysql rows.
//
// Every row always carries BOTH the real rendered SQL and a structural DFS-preorder
// class-name+scalar-args fingerprint (CPython's generator always succeeds, so
// computing both costs nothing there). On the JS side, `.sql()` is tried first; a
// `NotPorted` error falls back to comparing the fingerprint instead, counted
// separately as a GENERATOR_GAP hit rather than silently folded into EXACT. Any OTHER
// `.sql()` error, or any error during optimize() itself, is a real ERROR.

import { readFileSync } from "node:fs";
// Side-effect import: registers every real dialect (incl. spark/snowflake/bigquery/
// postgres, which this fixture's own `# dialect:` rows ask for by name) plus the real
// base-Generator dispatch `.sql()` needs -- same role `fuzz_canonicalize.mjs`'s own
// per-file dialect imports serve, done here through the one top-level entry point
// since this fixture spans four registered dialects rather than just one.
import { parseOne } from "../../index.js";
import { optimize } from "../../src/optimizer/optimizer.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = JSON.parse(readFileSync("spike/out/optimizer.json", "utf8"));

// Mirrors `gen_optimizer_ref.py`'s own `SCHEMA` (test_optimizer.py:255-260's LOCAL
// `test_optimize` schema, NOT the bigger `self.schema` other tests in that file use).
const SCHEMA = {
  x: { a: "INT", b: "INT" },
  y: { b: "INT", c: "INT" },
  z: { a: "INT", c: "INT" },
  u: { f: "INT", g: "INT", h: "TEXT" },
};

// Mirrors `gen_optimizer_ref.py`'s own `fingerprint` exactly (itself copied verbatim
// from `gen_canonicalize_ref.py` -- see that file's comment for why scalar-only args,
// not full `Expr`/array-of-`Expr` children, are included).
function fingerprint(ast) {
  return [...ast.dfs()].map((n) => {
    const scalars = {};
    for (const [k, v] of Object.entries(n.args)) {
      if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        scalars[k] = v === undefined ? null : v;
      }
    }
    const sorted = {};
    for (const k of Object.keys(scalars).sort()) sorted[k] = scalars[k];
    return [n.constructor.name, sorted];
  });
}

// Known, pre-existing, unrelated-to-optimizer.js base-Generator/parser gaps this
// round's own first full run surfaced -- named, counted exclusions by regex, same
// "structural/excluded, not silently ignored" shape `fuzz_canonicalize.mjs`'s own
// `KNOWN_GENERATOR_GAPS` established. Filled in from this round's real findings (see
// PORT_PLAN.md's own entry for the row-by-row detail); a `.sql()`/optimize() error
// NOT matching one of these is a real ERROR, not a gap.
const KNOWN_GENERATOR_GAPS = [
  /^NotPorted: (hint_sql|dot_sql|pivot_sql|currentdate_sql|div_sql|querytransform_sql|kwarg_sql) is not ported yet/,
];

function isKnownGeneratorGap(e) {
  return KNOWN_GENERATOR_GAPS.some((re) => re.test(`${e.constructor.name}: ${e.message}`));
}

let exact = 0;
let generatorGap = 0;
let mismatch = 0;
let error = 0;
let skipped = 0;
const samples = [];

for (const row of ref) {
  const name = `${row.name}${row.dialect ? ` (${row.dialect})` : ""}`;

  if (row.dialect && row.dialect.startsWith("mysql")) {
    skipped++;
    continue;
  }

  let got;
  try {
    const parsed = parseOne(row.sql, { read: row.dialect ?? undefined });
    const options = row.identify_false
      ? { identify: false }
      : { schema: SCHEMA, infer_schema: true, dialect: row.dialect };
    const ast = optimize(parsed, options);

    let output;
    let gap = false;
    try {
      output = row.identify_false ? ast.sql() : ast.sql(row.dialect, { pretty: true });
    } catch (e) {
      if (isKnownGeneratorGap(e)) {
        gap = true;
      } else {
        throw e;
      }
    }
    got = gap ? { gap: true, fingerprint: fingerprint(ast) } : { output };
  } catch (e) {
    got = { error: e.constructor.name, message: e.message };
  }

  if ("error" in got) {
    error++;
    samples.push(`ERROR   ${name}: ${got.error}: ${got.message}\n  sql: ${row.sql}`);
    continue;
  }

  if (got.gap) {
    const want = JSON.stringify(row.fingerprint);
    const have = JSON.stringify(got.fingerprint);
    if (want === have) generatorGap++;
    else {
      mismatch++;
      samples.push(`MISMATCH ${name}\n  sql:      ${row.sql}\n  expected fp: ${want}\n  got fp:      ${have}`);
    }
  } else if (got.output === row.output) {
    exact++;
  } else {
    mismatch++;
    samples.push(`MISMATCH ${name}\n  sql:      ${row.sql}\n  expected: ${row.output}\n  got:      ${got.output}`);
  }
}

console.log();
console.log("  src/optimizer/optimizer.js vs CPython sqlglot.optimizer.optimizer");
console.log(`    EXACT ${exact}    GENERATOR_GAP ${generatorGap}    MISMATCH ${mismatch}    ERROR ${error}    SKIPPED ${skipped} (mysql, unported)`);
if (samples.length) {
  console.log();
  for (const s of samples) console.log(VERBOSE ? `  ${s}\n` : `  ${s.split("\n")[0]}`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
