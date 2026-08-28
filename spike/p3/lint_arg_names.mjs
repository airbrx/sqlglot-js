// Throwaway diagnostic: static check that every `new exp.X({ key: ... })` in
// src/parser.js uses arg names X actually declares.
//
// Motivated by a real bug: `_parse_star_ops` built `exp.Star({except: ...})` but the
// upstream arg is `except_` (the trailing underscore dodges Python's `except`
// keyword). `except` is not reserved in JS, so the underscore looked droppable -- but
// arg NAMES are observable in the AST dump, so it silently mismatched 405 oracle rows.
// Any other trailing-underscore arg (`with_`, `for_`, `default_`, ...) can go the same
// way, so scan for the whole class rather than fixing one.
//
//   node spike/p3/lint_arg_names.mjs

import { readFileSync } from "node:fs";
import { EXPR_META } from "../../src/_gen/expr_meta.js";

const src = readFileSync("src/parser.js", "utf8");

// class name -> Set(valid arg names)
const validByName = new Map();
for (const meta of Object.values(EXPR_META)) {
  validByName.set(meta.name, new Set(meta.argTypes.map(([k]) => k)));
}

/** Extract the balanced `{...}` starting at `open`, respecting strings/comments. */
function balanced(s, open) {
  let depth = 0, i = open, inStr = null, inLine = false, inBlock = false;
  for (; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (inLine) { if (c === "\n") inLine = false; continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i++; } continue; }
    if (inStr) {
      if (c === "\\") i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === "/" && n === "/") { inLine = true; i++; continue; }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") { depth--; if (depth === 0) return s.slice(open, i + 1); }
  }
  return null;
}

/** Top-level `key:` names of an object literal body. */
function topLevelKeys(body) {
  const keys = [];
  let depth = 0, inStr = null, tok = "";
  for (let i = 1; i < body.length - 1; i++) {
    const c = body[i];
    if (inStr) { if (c === "\\") i++; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if ("{([".includes(c)) { depth++; continue; }
    if ("})]".includes(c)) { depth--; continue; }
    if (depth !== 0) continue;
    if (c === ",") { tok = ""; continue; }
    // Full match, not a suffix match: a ternary's `:` is preceded by an expression
    // like `this._parse_value()` or `exp.DType.TIMETZ`, which is not a bare identifier
    // and must not be mistaken for a key.
    if (c === ":") { const m = tok.trim().match(/^[A-Za-z_$][\w$]*$/); if (m) keys.push(m[0]); tok = ""; continue; }
    tok += c;
  }
  return keys;
}

const re = /new exp\.([A-Za-z_][\w]*)\s*\(\s*\{/g;
let m, problems = 0, checked = 0;
while ((m = re.exec(src)) !== null) {
  const cls = m[1];
  const valid = validByName.get(cls);
  if (!valid) continue; // class not in generated meta (alias//helper) — skip
  const body = balanced(src, src.indexOf("{", m.index + m[0].length - 1));
  if (!body) continue;
  checked++;
  const line = src.slice(0, m.index).split("\n").length;
  for (const k of topLevelKeys(body)) {
    if (k === "this") continue; // `this:` is universal and always declared
    if (!valid.has(k)) {
      problems++;
      const near = [...valid].find((v) => v.replace(/_$/, "") === k || v === k + "_" || k === v + "_");
      console.log(`  parser.js:${line}  exp.${cls}  unknown arg "${k}"`
        + (near ? `  -- did you mean "${near}"?` : `  (valid: ${[...valid].slice(0, 8).join(", ")}…)`));
    }
  }
}
console.log(`\n${checked} \`new exp.X({...})\` sites checked, ${problems} unknown arg name(s).`);
process.exit(problems ? 1 : 0);
