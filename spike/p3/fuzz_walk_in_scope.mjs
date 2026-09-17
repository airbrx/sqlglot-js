// Differential: optimizer Tier A (`walk_in_scope` / `find_in_scope`) vs CPython.
//
//   python3 spike/p3/gen_walk_in_scope_ref.py > spike/out/walk_in_scope.jsonl
//   node spike/p3/fuzz_walk_in_scope.mjs
//
// Both sides walk the SAME tree by construction: the CPython side emits the tree it
// walked, and the port rebuilds it with `astLoad`. The obvious alternative — key by
// atom_id and reload from corpus/ast — is wrong: 4 of the 15,540 committed AST rows are
// not reproduced by a fresh parse_one at the pinned commit, so those 4 would compare
// two different trees and report a Tier A defect that does not exist.
//
// Traversal ORDER is asserted, not just membership: `find_in_scope` returns the FIRST
// match, so a mis-ordered walk is a wrong answer.
//
// `PRUNE_PROBES` (AIR-2095) drives `walkInScope`'s `prune` callback the same way its two
// real upstream callers do (`qualify_columns.py`'s `node.is_star`, `simplify.py`'s
// `isinstance(node, exp.If)`) — the parameter existed since P3 but no oracle had ever
// exercised it until now.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { astLoad, toS } from "../../src/expressions/index.js";
import * as exp from "../../src/expressions/index.js";
import { findInScope, walkInScope } from "../../src/optimizer/scope.js";

const PROBES = {
  ignore_respect: [exp.IgnoreNulls, exp.RespectNulls],
  column: [exp.Column],
  select: [exp.Select],
  subquery: [exp.Subquery],
};

const PRUNE_PROBES = {
  prune_star: (node) => node.isStar,
  prune_if: (node) => node instanceof exp.If,
};

let checked = 0;
let orderPass = 0;
let findPass = 0;
let findTotal = 0;
let prunePass = 0;
let pruneTotal = 0;
const fails = [];

const rl = createInterface({
  input: createReadStream("spike/out/walk_in_scope.jsonl"),
  crlfDelay: Infinity,
});

for await (const line of rl) {
  if (!line) continue;
  const want = JSON.parse(line);
  const tree = astLoad(want.ast);
  checked += 1;

  const gotOrder = [...walkInScope(tree)].map((n) => n.constructor.name);
  if (gotOrder.length === want.order.length && gotOrder.every((c, i) => c === want.order[i])) {
    orderPass += 1;
  } else {
    const at = gotOrder.findIndex((c, i) => c !== want.order[i]);
    fails.push(
      `${want.atom_id} [${want.dialect}] walk order: len ${gotOrder.length} vs ${want.order.length}`
      + (at >= 0 ? `, first diff at ${at}: got ${gotOrder[at]}, want ${want.order[at]}` : ""),
    );
  }

  for (const [probe, types] of Object.entries(PROBES)) {
    findTotal += 1;
    const hit = findInScope(tree, ...types);
    const got = hit === null ? null : toS(hit);
    if (got === want.finds[probe]) findPass += 1;
    else {
      fails.push(
        `${want.atom_id} [${want.dialect}] find_in_scope(${probe}):\n     got  ${got}\n     want ${want.finds[probe]}`,
      );
    }
  }

  for (const [probe, prune] of Object.entries(PRUNE_PROBES)) {
    pruneTotal += 1;
    const gotPrune = [...walkInScope(tree, prune)].map((n) => n.constructor.name);
    const wantPrune = want.prune_orders[probe];
    if (gotPrune.length === wantPrune.length && gotPrune.every((c, i) => c === wantPrune[i])) {
      prunePass += 1;
    } else {
      const at = gotPrune.findIndex((c, i) => c !== wantPrune[i]);
      fails.push(
        `${want.atom_id} [${want.dialect}] walk_in_scope(${probe}): len ${gotPrune.length} vs ${wantPrune.length}`
        + (at >= 0 ? `, first diff at ${at}: got ${gotPrune[at]}, want ${wantPrune[at]}` : ""),
      );
    }
  }
}

console.log(`\n  walk_in_scope order : ${orderPass}/${checked} trees byte-exact`);
console.log(`  find_in_scope       : ${findPass}/${findTotal} probes byte-exact`);
console.log(`  walk_in_scope prune  : ${prunePass}/${pruneTotal} probes byte-exact`);
for (const f of fails.slice(0, 10)) console.log(`    FAIL ${f}`);
if (fails.length > 10) console.log(`    ... and ${fails.length - 10} more`);
console.log(fails.length ? "  TIER A SCOPE: FAIL" : "  TIER A SCOPE: OK");
process.exit(fails.length ? 1 : 0);
