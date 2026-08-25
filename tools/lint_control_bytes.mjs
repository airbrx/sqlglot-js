// Denies raw control bytes (\x00-\x1F excluding tab/newline/CR) in committed source.
//
// PORT_PLAN.md S4.2, added 2026-08-25. This recurred FOUR separate times during P0 across
// two independently-developed branches, always via the same mistake: using a literal
// control byte as a string separator to avoid collision ambiguity (a NUL-separated
// frozensetKey, literal ESC bytes in ANSI color constants, a NUL-separated key in the
// ratchet's gapKeyOf, a NUL-separated cache key in _py/re.js).
//
// The damage is worse than a wrong value: `file`/`grep` silently classify the whole source
// file as binary the moment one control byte lands, which neuters every grep-based check
// in this repo without any error -- the vacuous-green failure mode S3.3 exists to prevent,
// entering through source hygiene instead of test logic.
//
// Fix is always the same: JSON.stringify([...parts]) for a composite key, never raw-byte
// concatenation.
//
//   node tools/lint_control_bytes.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOTS = ["src", "tools", "spike"];
const EXTS = new Set([".js", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", "out", "corpus"]);

function walk(path, out = []) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return out;
  }
  if (st.isDirectory()) {
    const base = path.split("/").pop();
    if (SKIP_DIRS.has(base)) return out;
    for (const e of readdirSync(path)) walk(join(path, e), out);
  } else if (EXTS.has(extname(path))) {
    out.push(path);
  }
  return out;
}

const files = [];
for (const r of ROOTS) walk(r, files);

const violations = [];
for (const file of files) {
  const data = readFileSync(file);
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    // Allow tab (9), newline (10), CR (13). Everything else in 0x00-0x1F is a violation.
    if (b < 0x20 && b !== 9 && b !== 10 && b !== 13) {
      const before = data.subarray(0, i);
      const line = before.filter((c) => c === 10).length + 1;
      violations.push(`${file}:${line}: control byte 0x${b.toString(16).padStart(2, "0")}`);
      break; // one hit per file is enough to flag it; fix, re-run
    }
  }
}

if (violations.length) {
  console.error("  CONTROL-BYTE LINT: FAIL — raw control byte(s) in source");
  console.error("    Use JSON.stringify([...parts]) for composite keys, never raw-byte concat.");
  for (const v of violations) console.error(`    - ${v}`);
  process.exit(1);
}
console.log(`  CONTROL-BYTE LINT: ok (${files.length} files checked)`);
