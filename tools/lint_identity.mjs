// Ban `constructor.name === "X"` where X has SUBCLASSES upstream.
//
//   node tools/lint_identity.mjs [--src src]
//
// WHY: this bug class has now been found three times across two reviews, always the
// same shape — a hand-written identity check standing in where Python has `isinstance`:
//
//   /Cast$/ regex               matched Cast/JSONCast/TryCast by coincidence
//   is_cast on Cast only        JSONCast/TryCast inherit it in Python
//   is_data_type on DataType    IntervalSpan/ObjectIdentifier/PseudoType inherit it
//   unalias name === "Alias"    missed PivotAlias, so PIVOT (a AS b) never unwrapped
//
// The root cause is structural, not a series of typos: `defineExpr` builds all 1,048
// classes as direct subclasses of `Expr`, so JS static inheritance carries NOTHING from
// the Python base. `instanceof` still works — `defineExpr` installs a
// `Symbol.hasInstance` that consults the generated `bases` list, which is the real
// Python MRO — but a `constructor.name === "X"` comparison bypasses it and silently
// answers "no" for every subclass.
//
// So the check is mechanical: `bases` already knows which classes have descendants.
// Comparing names is only safe for a leaf, and it is only CORRECT when upstream wrote
// `type(x) is X` rather than `isinstance(x, X)`. For the deliberate exact-type cases
// (`Expression.unnest` is `while type(expression) is Paren`), acknowledge with
//
//     // exact-type: sqlglot/expressions/core.py:1218
//
// on the same line or the line above — the same acknowledgement-marker discipline the
// deny-lists use. That is a claim a reviewer can check against upstream in one grep.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { EXPR_META } from "../src/_gen/expr_meta.js";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i === -1 ? dflt : argv[i + 1];
};
const SRC = opt("src", "src");

// name -> subclasses, straight from the generated MRO.
const subclasses = new Map();
for (const meta of Object.values(EXPR_META)) {
  for (const base of meta.bases) {
    if (!subclasses.has(base)) subclasses.set(base, []);
    subclasses.get(base).push(meta.name);
  }
}
const classNames = new Set(Object.values(EXPR_META).map((m) => m.name));
// Only real catalogue classes: `Func`, `Binary`, `Condition` and friends are traits and
// are already spelled `instanceof`/`has(C, trait)` everywhere.
const subclassed = new Map(
  [...subclasses].filter(([base, kids]) => classNames.has(base) && kids.length),
);

function walkJs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJs(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

// `x.constructor.name === "Alias"`, `x.constructor?.name !== "Alias"`, and the
// `["Alias", "Cast"].includes(x.constructor.name)` list form.
const NAME_CMP = /constructor\s*\??\.\s*name\s*(?:===|!==|==|!=)\s*"([A-Za-z_][A-Za-z0-9_]*)"/g;
const NAME_IN_LIST = /\[([^\]]*)\]\s*\.includes\s*\(\s*[\w.?]*constructor\s*\??\.\s*name\s*\)/g;

const failures = [];
let scanned = 0;
let acknowledged = 0;

for (const file of walkJs(SRC)) {
  if (file.includes(`${path.sep}_gen${path.sep}`)) continue; // generated, no hand checks
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return; // prose may name the hazard
    const hit = new Set();
    for (const m of line.matchAll(NAME_CMP)) hit.add(m[1]);
    for (const m of line.matchAll(NAME_IN_LIST)) {
      for (const s of m[1].matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)) hit.add(s[1]);
    }
    for (const name of hit) {
      if (!subclassed.has(name)) continue;
      scanned += 1;
      const ack = /\/\/\s*exact-type:/.test(line) || /\/\/\s*exact-type:/.test(lines[i - 1] ?? "");
      if (ack) { acknowledged += 1; continue; }
      failures.push({
        where: `${file}:${i + 1}`,
        name,
        kids: subclassed.get(name),
      });
    }
  });
}

console.log("identity-check lint\n");
console.log(`  catalogue classes             ${classNames.size}`);
console.log(`  of those, have subclasses     ${subclassed.size}`);
console.log(`  name-comparisons against them ${scanned} (${acknowledged} acknowledged exact-type)`);

if (failures.length) {
  console.log(`\n${failures.length} failures:`);
  for (const f of failures) {
    console.log(
      `  [name-identity] ${f.where}: \`constructor.name === "${f.name}"\` misses `
      + `${f.kids.length} subclass(es): ${f.kids.slice(0, 6).join(", ")}`
      + `${f.kids.length > 6 ? ", …" : ""}`,
    );
    console.log(
      "                  Use `x instanceof cls(\"" + f.name + "\")` (defineExpr's "
      + "Symbol.hasInstance consults the generated MRO), or add "
      + "`// exact-type: <upstream anchor>` if upstream really wrote `type(x) is "
      + f.name + "`.",
    );
  }
  process.exit(1);
}

console.log("\nclean");
