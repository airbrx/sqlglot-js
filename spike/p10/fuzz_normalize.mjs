// Differential: `src/optimizer/normalize.js` vs CPython's `sqlglot.optimizer.normalize`,
// at the pin.
//
//   SQLGLOT_REF=/tmp/sqlglot-complete-pin python3 spike/p10/gen_normalize_ref.py > spike/out/normalize.json
//   node spike/p10/fuzz_normalize.mjs
//
// See `gen_normalize_ref.py`'s own header for why this oracle is shaped differently
// from the P7 optimizer modules: `normalize.py` has a real upstream fixture corpus
// (`tests/fixtures/optimizer/normalize.sql`, 17 pairs) run through
// `TestOptimizer.test_normalize`'s own small pipeline
// (`normalize() -> annotate_types() -> simplify()`), reproduced here verbatim with
// this port's own already-verified `annotateTypes`/`simplify` (P7), so a mismatch is
// attributable to `normalize.js` and not its dependencies. Also covers the three
// direct `test_normalize` assertions (plain CNF, DNF, and the Snowflake BOOLXOR/Xor
// scenario) and the three `test_normalization_distance` depth scenarios.

import { readFileSync } from "node:fs";
import { parseOne } from "../../src/dialects/dialect.js";
import { annotate_types } from "../../src/optimizer/annotate_types.js";
import { normalize, normalization_distance } from "../../src/optimizer/normalize.js";
import { simplify } from "../../src/optimizer/simplify.js";
// Side-effect imports: registers the real base-Generator dispatch (`.sql()` needs it)
// and the Snowflake dialect (the BOOLXOR assertion scenario).
import "../../src/generator.js";
import "../../src/dialects/snowflake.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = JSON.parse(readFileSync("spike/out/normalize.json", "utf8"));

let exact = 0;
let mismatch = 0;
let error = 0;
const samples = [];

// py: tests/test_optimizer.py:55-59 `normalize(expression, **kwargs)`, the exact
// wrapper `check_file("normalize", normalize, schema=self.schema)` runs.
const SCHEMA = {
  x: { a: "INT", b: "INT" },
  y: { b: "INT", c: "INT" },
  z: { b: "INT", c: "INT" },
  w: { d: "TEXT", e: "TEXT" },
  temporal: { d: "DATE", t: "DATETIME" },
  structs: {
    one: "STRUCT<a_1 INT, b_1 VARCHAR>",
    nested_0: "STRUCT<a_1 INT, nested_1 STRUCT<a_2 INT, nested_2 STRUCT<a_3 INT>>>",
    quoted: 'STRUCT<"foo bar" INT>',
  },
  t_bool: { a: "BOOLEAN", b: "BOOLEAN" },
  unpivotable: { id: "INT", jan: "INT", feb: "INT", north: "INT", south: "INT" },
  pivotable: { id: "INT", cat: "TEXT", val: "INT", kind: "TEXT", amt: "INT" },
};

function normalizePipeline(sql, dialect) {
  let expression = parseOne(sql, { read: dialect ?? undefined });
  expression = normalize(expression, false);
  expression = annotate_types(expression, { schema: SCHEMA });
  return simplify(expression).sql();
}

for (const row of ref.fixtures) {
  const name = `fixture#${row.id}`;
  let got;
  try {
    got = { ok: normalizePipeline(row.sql, row.dialect) };
  } catch (e) {
    got = { error: e.constructor.name, message: e.message };
  }

  if ("error" in row) {
    if ("error" in got) exact++;
    else {
      mismatch++;
      samples.push(`MISMATCH ${name} (expected CPython error, got ok)\n  sql: ${row.sql}\n  got: ${JSON.stringify(got)}`);
    }
    continue;
  }

  if ("error" in got) {
    error++;
    samples.push(`ERROR   ${name}: ${got.error}: ${got.message}\n  sql: ${row.sql}`);
  } else if (got.ok === row.expected) {
    exact++;
  } else {
    mismatch++;
    samples.push(`MISMATCH ${name}\n  sql:      ${row.sql}\n  expected: ${row.expected}\n  got:      ${got.ok}`);
  }
}

for (const a of ref.assertions) {
  const name = `assertion:${a.name}`;
  try {
    const out = normalize(parseOne(a.sql, { read: a.dialect ?? undefined }), a.dnf).sql(a.dialect);
    if (out === a.sql_out) {
      exact++;
    } else {
      mismatch++;
      samples.push(`MISMATCH ${name}\n  sql:      ${a.sql}\n  expected: ${a.sql_out}\n  got:      ${out}`);
    }
  } catch (e) {
    error++;
    samples.push(`ERROR   ${name}: ${e.constructor.name}: ${e.message}\n  sql: ${a.sql}`);
  }
}

for (const d of ref.distances) {
  const name = `distance:depth=${d.depth}`;
  const expr = parseOne(Array(d.depth).fill("a AND b").join(" OR "));
  const got = normalization_distance(expr, false, 100);
  if (got === d.distance) {
    exact++;
  } else {
    mismatch++;
    samples.push(`MISMATCH ${name}\n  expected: ${d.distance}\n  got:      ${got}`);
  }
}

console.log();
console.log("  src/optimizer/normalize.js vs CPython sqlglot.optimizer.normalize");
console.log(`    EXACT ${exact}    MISMATCH ${mismatch}    ERROR ${error}`);
if (samples.length) {
  console.log();
  for (const s of samples) console.log(VERBOSE ? `  ${s}\n` : `  ${s.split("\n")[0]}`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
