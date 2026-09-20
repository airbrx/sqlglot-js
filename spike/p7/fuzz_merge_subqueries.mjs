// Differential: `src/optimizer/merge_subqueries.js` vs CPython's
// `sqlglot.optimizer.merge_subqueries`, at the pin.
//
//   PYTHONHASHSEED=0 python3 spike/p7/gen_merge_subqueries_ref.py > spike/out/merge_subqueries.json
//   node spike/p7/fuzz_merge_subqueries.mjs
//
// See `gen_merge_subqueries_ref.py`'s own header for why this file exists, for the
// guard-by-guard scenario organization, for the adversarial
// `_outer_select_joins_on_inner_select_join` finding, and for why four scenarios use
// a structural "did a Subquery aliased X survive" check instead of a `.sql()` compare
// (this port's `window_sql`/`querytransform_sql` base-Generator methods are not ported
// yet — an unrelated pre-existing gap, out of this file's scope).

import { readFileSync } from "node:fs";
import { parseOne } from "../../src/dialects/dialect.js";
import * as exp from "../../src/expressions/index.js";
import { merge_subqueries } from "../../src/optimizer/merge_subqueries.js";
// Side-effect imports: register the real base-Generator dispatch and the Hive
// dialect (one structural scenario parses/renders TRANSFORM ... USING).
import "../../src/generator.js";
import "../../src/dialects/hive.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = JSON.parse(readFileSync("spike/out/merge_subqueries.json", "utf8"));

let exact = 0;
let mismatch = 0;
let error = 0;
const samples = [];

function record(name, ok, detail) {
  if (ok) {
    exact++;
  } else {
    mismatch++;
    samples.push(`MISMATCH ${name}\n  ${detail}`);
  }
}

function runSql(sql, leaveTablesIsolated, dialect) {
  try {
    const ast = parseOne(sql, { read: dialect ?? undefined });
    const out = merge_subqueries(ast, leaveTablesIsolated);
    return { ok: out.sql(dialect ?? undefined) };
  } catch (e) {
    return { error: e.constructor.name, message: e.message };
  }
}

function isMerged(ast, alias) {
  for (const sq of ast.findAll(exp.Subquery)) {
    if (sq.aliasOrName === alias) return false;
  }
  return true;
}

function runStructural(sql, alias, dialect) {
  try {
    const ast = parseOne(sql, { read: dialect ?? undefined });
    const out = merge_subqueries(ast);
    return { merged: isMerged(out, alias) };
  } catch (e) {
    return { error: e.constructor.name, message: e.message };
  }
}

for (const { name, sql, leave_tables_isolated, dialect, result: expected } of ref.sql_scenarios) {
  const got = runSql(sql, leave_tables_isolated, dialect);
  let ok;
  if ("ok" in expected) {
    ok = "ok" in got && got.ok === expected.ok;
  } else {
    ok = "error" in got && got.error === expected.error;
  }
  if (ok) {
    exact++;
  } else if ("error" in got && !("error" in expected)) {
    error++;
    samples.push(`ERROR   ${name}: ${got.error}: ${got.message}\n  sql: ${sql}`);
  } else {
    mismatch++;
    samples.push(
      `MISMATCH ${name}\n  sql:      ${sql}\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(got)}`,
    );
  }
}

for (const { name, sql, alias, dialect, result: expected } of ref.structural_scenarios) {
  const got = runStructural(sql, alias, dialect);
  const ok = "merged" in expected && "merged" in got && got.merged === expected.merged;
  if (ok) {
    exact++;
  } else {
    mismatch++;
    samples.push(
      `MISMATCH ${name}\n  sql:      ${sql}\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(got)}`,
    );
  }
}

console.log();
console.log("  src/optimizer/merge_subqueries.js vs CPython sqlglot.optimizer.merge_subqueries");
console.log(`    EXACT ${exact}    MISMATCH ${mismatch}    ERROR ${error}`);
if (samples.length) {
  console.log();
  for (const s of samples) console.log(VERBOSE ? `  ${s}\n` : `  ${s.split("\n")[0]}`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
