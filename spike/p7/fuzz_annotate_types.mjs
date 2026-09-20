// Differential: `src/optimizer/annotate_types.js` (`TypeAnnotator`/`annotate_types`) vs
// CPython's `sqlglot.optimizer.annotate_types`, at the pin.
//
//   PYTHONHASHSEED=0 python3 spike/p7/gen_annotate_types_ref.py > spike/out/annotate_types.json
//   node spike/p7/fuzz_annotate_types.mjs
//
// See `gen_annotate_types_ref.py`'s own header for why this file exists and for the
// "type fingerprint over `.walk(bfs=False)`" comparison scheme (annotation does not
// change `.sql()` output, so the SQL-string-equality trick every other greenfield P7
// oracle uses does not apply here).

import { readFileSync } from "node:fs";
import { parseOne } from "../../src/dialects/dialect.js";
import { annotate_types } from "../../src/optimizer/annotate_types.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = JSON.parse(readFileSync("spike/out/annotate_types.json", "utf8"));

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

function runOne(sql, schema) {
  try {
    const ast = parseOne(sql);
    const annotated = annotate_types(ast, { schema: schema ?? null });
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

for (const { name, sql, schema, result: expected } of ref.scenarios) {
  const got = runOne(sql, schema);
  let ok;
  if ("ok" in expected) {
    ok = "ok" in got && fingerprintsEqual(got.ok, expected.ok);
  } else {
    // A CPython-side exception is recorded by class name; this port's error hierarchy
    // is verified elsewhere (CONTRACTS.md §6/§8) to name-match upstream's, so an exact
    // class-name match is the right bar here too.
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
console.log("  src/optimizer/annotate_types.js vs CPython sqlglot.optimizer.annotate_types");
console.log(`    EXACT ${exact}    MISMATCH ${mismatch}    ERROR ${error}`);
if (samples.length) {
  console.log();
  for (const s of samples) console.log(VERBOSE ? `  ${s}\n` : `  ${s.split("\n")[0]}`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
