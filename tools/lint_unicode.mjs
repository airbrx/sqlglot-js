// Denies runtime \p{...} property escapes where the generated tables must be used.
//
// PORT_PLAN.md §4.6 / CONTRACTS.md §1.2, from the P0 go/no-go finding: \p{...} is bound to
// the ENGINE's Unicode version, not the harvesting interpreter's. Measured Node v22
// (Unicode 16.0) vs CPython 3.9.25 (unicodedata 13.0.0): 11,130 diverging code points for
// isprintable, 225 islower, 67 isupper, 4 isspace.
//
// This is exactly the R4 hazard class: a \p{...} port passes every corpus test, because the
// harvested corpus is 13 non-ASCII strings out of 54,980 (0.024%).
//
//   node tools/lint_unicode.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Directories where classification must go through src/_gen/unicode.js.
const GUARDED = ["src/_py", "src/tokenizer.js", "src/tokenizer_core.js", "src/generator.js", "src/time.js"];

// _gen/ is generated from the CPython dump, so it is the source of truth, not a violation.
//
// src/_py/re.js is exempt for a different, narrower reason (PORT_PLAN.md §4.6 "Regex",
// added 2026-08-25 after the regex differential corpus): \w/\d/\s translation is embedded
// inside dynamically-constructed, dynamically-compiled regex patterns (generator.py:1667,
// bigquery.py:127), so it cannot route through a precomputed static table the way the four
// _py/str.js predicates do -- it must build a real runtime \p{...} JS regex at match time.
// The residual Unicode-version-skew this leaves (harvest-time unidata_version vs the
// consuming runtime's process.versions.unicode) is accepted and tracked in
// corpus/PROVENANCE.json, not silently absorbed. This exemption covers exactly the four
// \p{...} character-class constants re.js needs for that translation (WORD_U, DIGIT_U,
// SPACE_U, PY_IDENT_RE) -- it is not a blanket license for the file to use \p{...} for the
// isprintable/islower/isupper/isspace predicates those still must come from _gen/unicode.js.
const EXEMPT_FILES = new Set(["src/_gen/unicode.js", "src/_py/re.js"]);

function walk(path, out = []) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return out; // not created yet; later phases add these
  }
  if (st.isDirectory()) {
    for (const e of readdirSync(path)) walk(join(path, e), out);
  } else if (path.endsWith(".js")) {
    out.push(path);
  }
  return out;
}

const files = [];
for (const g of GUARDED) walk(g, files);

const violations = [];
for (const file of files) {
  if (EXEMPT_FILES.has(file)) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    // Ignore comments — CONTRACTS.md and the shims discuss \p{...} in prose.
    const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
    if (/\\p\{/.test(code)) {
      violations.push(`${file}:${i + 1}: ${line.trim()}`);
    }
  });
}

if (violations.length) {
  console.error("  UNICODE LINT: FAIL — runtime \\p{...} in a guarded file");
  console.error("    Use src/_gen/unicode.js; \\p{...} tracks the engine's Unicode version,");
  console.error("    which is not the interpreter version that harvested the corpus.");
  for (const v of violations) console.error(`    - ${v}`);
  process.exit(1);
}
console.log(`  UNICODE LINT: ok (${files.length} files checked)`);
