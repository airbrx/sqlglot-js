// Differential: five per-dialect `EXPRESSION_METADATA` overlays (AIR-2099) —
// `src/typing/postgres.js`, `redshift.js`, `duckdb.js`, `bigquery.js`, `tsql.js` — vs
// CPython's `sqlglot.typing.{postgres,redshift,duckdb,bigquery,tsql}`, exercised
// through the real `TypeAnnotator` (`src/optimizer/annotate_types.js`, AIR-2097/R54)
// each one plugs into.
//
//   PYTHONHASHSEED=0 python3 spike/p7/gen_typing_overlay_family_ref.py \
//       > spike/out/typing_overlay_family.json
//   node spike/p7/fuzz_typing_overlay_family.mjs
//
// See `gen_typing_overlay_family_ref.py`'s own header for scenario coverage and for
// the "type fingerprint over `.walk(bfs=False)`" comparison scheme `fuzz_annotate_types.mjs`
// (R54) and `fuzz_annotate_types_snowflake.mjs` (R66) already established. The one
// structural difference from the Snowflake oracle: each scenario carries its own
// `dialect` field (rather than a single fixed one), since this oracle spans five
// dialects in one file.

import { readFileSync } from "node:fs";
import { parseOne } from "../../src/dialects/dialect.js";
import "../../src/dialects/postgres.js";
import "../../src/dialects/redshift.js";
import "../../src/dialects/duckdb.js";
import "../../src/dialects/bigquery.js";
import "../../src/dialects/tsql.js";
import { annotate_types } from "../../src/optimizer/annotate_types.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = JSON.parse(readFileSync("spike/out/typing_overlay_family.json", "utf8"));

let exact = 0;
let mismatch = 0;
let error = 0;
const samples = [];

function dumpTypes(node) {
  const out = [];
  for (const n of node.walk(false)) {
    const t = n.type;
    out.push([n.constructor.name, t ? t.this.name : null]);
  }
  return out;
}

function runOne(sql, dialect, schema) {
  try {
    const ast = parseOne(sql, { read: dialect });
    const annotated = annotate_types(ast, { schema: schema ?? null, dialect });
    return { ok: dumpTypes(annotated) };
  } catch (e) {
    return { error: e.constructor.name, message: e.message };
  }
}

function fingerprintsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  }
  return true;
}

for (const { name, dialect, sql, schema, result: expected } of ref.scenarios) {
  const got = runOne(sql, dialect, schema);
  let ok;
  if ("ok" in expected) {
    ok = "ok" in got && fingerprintsEqual(got.ok, expected.ok);
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
    let diff = "";
    if ("ok" in expected && "ok" in got) {
      const len = Math.max(expected.ok.length, got.ok.length);
      for (let i = 0; i < len; i++) {
        const e = expected.ok[i];
        const g = got.ok[i];
        if (!e || !g || e[0] !== g[0] || e[1] !== g[1]) {
          diff += `\n  [${i}] expected=${JSON.stringify(e)} got=${JSON.stringify(g)}`;
        }
      }
    } else {
      diff = `\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(got)}`;
    }
    samples.push(`MISMATCH ${name}\n  sql: ${sql}${diff}`);
  }
}

console.log();
console.log("  src/typing/{postgres,redshift,duckdb,bigquery,tsql}.js vs CPython sqlglot.typing.*");
console.log(`    EXACT ${exact}    MISMATCH ${mismatch}    ERROR ${error}`);
if (samples.length) {
  console.log();
  for (const s of samples) console.log(VERBOSE ? `  ${s}\n` : `  ${s.split("\n")[0]}`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
