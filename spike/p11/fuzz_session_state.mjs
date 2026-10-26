// AIR-2361 (Epic AIR-2360): session-state statement AST oracle vs pinned CPython.
//
// Full-tree AST-dump equality — see spike/p11/gen_session_state_ref.py's docstring for
// why this is the right (and strictly stronger) check for "the JS AST-derived effect
// agrees with the same extraction run over CPython's AST": if contrib/sessionState.js's
// classify() is a deterministic function of the parsed tree (it is — no I/O, no
// randomness), byte-identical trees guarantee byte-identical classify() output too,
// without needing a second hand-mirrored extraction routine in this file.
import { readFileSync } from "node:fs";
import { Dialect, exp } from "../../index.js";
import { captureLogs } from "../../src/logging.js";

const MIN_ROWS = 150;
const rows = JSON.parse(readFileSync("spike/out/session_state_ref.json", "utf8"));
if (rows.length < MIN_ROWS) throw new Error(`Expected >= ${MIN_ROWS} AIR-2361 oracle rows, got ${rows.length}`);
if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error("Duplicate AIR-2361 oracle row id");

function dump(n) {
  if (n instanceof exp.Expr) {
    return {
      c: n.constructor.name,
      a: Object.entries(n.args).map(([k, v]) => [k, dump(v)]),
      m: n._meta || null,
      cm: n.comments?.length ? n.comments : null,
    };
  }
  return Array.isArray(n) ? n.map(dump) : n;
}

function describeError(e) {
  return { error: e.name.replace(/^Py/, ""), message: e.message };
}

let exact = 0;
let mismatch = 0;
let error = 0;

for (const row of rows) {
  let got;
  try {
    const d = Dialect.get_or_raise(row.dialect);
    const trees = captureLogs(() => d.parse(row.input)).result.filter(
      (t) => t && !(t instanceof exp.Semicolon),
    );
    got = { ast: trees.map(dump) };
  } catch (e) {
    got = describeError(e);
  }

  if (JSON.stringify(got) === JSON.stringify(row.expected)) {
    exact += 1;
  } else {
    if (got.error && !row.expected.error) error += 1;
    else mismatch += 1;
    console.error(JSON.stringify({ id: row.id, got, want: row.expected }));
  }
}

console.log(`AIR-2361: TOTAL ${rows.length}, EXACT ${exact}, MISMATCH ${mismatch}, ERROR ${error}`);
process.exitCode = mismatch + error === 0 ? 0 : 1;
