// Differential: `Func.from_arg_list` on the port vs CPython, over EVERY function class.
//
//   python3 spike/p3/gen_from_arg_list_ref.py > spike/out/from_arg_list.jsonl
//   node spike/p3/fuzz_from_arg_list.mjs
//
// P2 shipped without `from_arg_list` (tracked debt); P3's `Parser.FUNCTIONS` binds it
// for hundreds of names, so it is checked across all 563 `ALL_FUNCTIONS` at argument
// counts that straddle each class's arity — not on the three entries that surfaced it.

import { readFileSync } from "node:fs";
import * as exp from "../../src/expressions/index.js";
import { toS } from "../../src/expressions/core.js";

const rows = readFileSync("spike/out/from_arg_list.jsonl", "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const lit = (i) => new exp.Literal({ this: String(i), is_string: false });

let pass = 0;
const fails = [];
for (const row of rows) {
  const C = exp[row.cls];
  if (!C) {
    fails.push(`${row.cls}: class missing from the port`);
    continue;
  }
  const args = Array.from({ length: row.n }, (_, i) => lit(i));
  let got;
  try {
    got = toS(C.from_arg_list(args));
  } catch (e) {
    // CONTRACTS.md §1.6: the port's names carry a `Py` prefix; strip it to compare
    // against CPython's exception type name.
    got = `<${(e.name || e.constructor.name).replace(/^Py/, "")}>`;
  }
  if (got === row.repr) pass += 1;
  else fails.push(`${row.cls} n=${row.n}${row.is_var_len ? ` var:${row.var_key}` : ""}\n     got  ${got}\n     want ${row.repr}`);
}

console.log(`\n  from_arg_list differential: ${pass}/${rows.length} byte-exact`);
for (const f of fails.slice(0, 12)) console.log(`    FAIL ${f}`);
if (fails.length > 12) console.log(`    ... and ${fails.length - 12} more`);
console.log(fails.length ? "  FROM_ARG_LIST: FAIL" : "  FROM_ARG_LIST: OK");
process.exit(fails.length ? 1 : 0);
