// SKETCH — what lint_fidelity.mjs's deny-list check needs to assert.
//
// PORT_PLAN.md §8.5 lists "all three deny-lists" as CI check #3 on every PR, but
// does not say what "clean" means. This is a runnable sketch of that, written
// against the three generated manifests. It is NOT wired into CI: there is no
// ported JS yet, so every check below currently has nothing to inspect and the
// script reports the manifests' shape instead.
//
//   node tools/lint_deny.mjs --src src --deny corpus/deny
//
// The design problem this has to solve: two of the three lists cannot be checked
// by pattern-matching the JS.
//
//   py_builtins  CAN be. The hazard is a specific JS construct
//                (String.fromCharCode, padStart, charCodeAt, .length on a
//                string), so a banned-construct scan is exactly right, and the
//                manifest already names the required _py/ shim per site.
//
//   operators    CANNOT be. `a - b` in JS is not wrong in general; it is wrong
//                only when `a` is an Expr, which is the same type question the
//                generator needed a whole inference pass to answer, and it would
//                have to be answered again against JS with no annotations.
//
//   implicit_str CANNOT be, for the same reason: `${x}` is only wrong when x is
//                an Expr.
//
// So the two type-dependent lists use *acknowledgement markers* instead. The
// port must carry, at each deny-listed line, a comment naming the upstream site:
//
//     // deny:operators sqlglot/generators/duckdb.py:1112
//     const daysOffset = exp.add(exp.paren(...), exp.literalNumber(1));
//
// That converts an unanswerable question ("is this JS correct?") into two
// answerable ones: is every deny-listed site acknowledged somewhere in the port,
// and does every marker still correspond to a live entry? The second half is what
// makes the mechanism survive upstream drift — when a line moves, its marker goes
// stale and CI fails, which is the same ratchet discipline as §3.3 rule 5.
//
// Markers are a weaker guarantee than a real check and should be described that
// way: they prove a human or agent looked at the line, not that the result is
// right. The strong guarantee for these two lists is §8.5's human review gate.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i === -1 ? dflt : argv[i + 1];
};
const SRC = opt("src", "src");
const DENY = opt("deny", "corpus/deny");

/** JS constructs that are wrong wherever they appear in a ported file. */
const BANNED_CONSTRUCTS = [
  {
    pattern: /String\.fromCharCode\s*\(/,
    why: "truncates above U+FFFF; use pyChr (String.fromCodePoint semantics)",
    shim: "pyChr",
  },
  {
    pattern: /\.charCodeAt\s*\(/,
    why: "returns a UTF-16 unit, not a code point; use pyOrd",
    shim: "pyOrd",
  },
  {
    pattern: /\.padStart\s*\(/,
    why: "not sign-aware: '-1'.padStart(4,'0') is '00-1', Python's zfill gives '-001'; use pyZfill/pyFormat",
    shim: "pyZfill",
  },
  {
    pattern: /\.padEnd\s*\(/,
    why: "pads by UTF-16 unit, not code point; use pyLjust",
    shim: "pyLjust",
  },
  {
    pattern: /\.toFixed\s*\(/,
    why: "rounds half-away-from-zero; Python's format spec rounds half-to-even; use pyFormat",
    shim: "pyFormat",
  },
];

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function walkJs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJs(full));
    else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

/* ------------------------------------------------------------------ checks */

const failures = [];
const notes = [];

const jsFiles = walkJs(SRC);
const jsSources = new Map(jsFiles.map((f) => [f, fs.readFileSync(f, "utf8")]));

/**
 * CHECK 1 — banned constructs (py_builtins.json).
 * A real, self-contained check: these JS spellings are wrong regardless of type.
 * `_py/` itself is exempt, since that is where the correct implementations live.
 */
function checkBannedConstructs() {
  for (const [file, src] of jsSources) {
    if (file.includes(`${path.sep}_py${path.sep}`)) continue;
    src.split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return; // comments may name the hazard
      for (const banned of BANNED_CONSTRUCTS) {
        if (banned.pattern.test(line)) {
          failures.push({
            check: "banned-construct",
            where: `${file}:${i + 1}`,
            detail: `${banned.why} (route through ${banned.shim})`,
          });
        }
      }
    });
  }
}

/**
 * CHECK 2 — every py_builtins site routes through its named shim.
 * Once `// py:` anchors exist, resolve each upstream site to its ported file and
 * assert the shim is imported there.
 */
function checkShimRouting(manifest) {
  const needed = new Map(); // ported file -> set of shims
  for (const site of manifest.sites) {
    if (site.executor) continue;
    const ported = pyToJsPath(site.file);
    if (!ported) continue;
    if (!needed.has(ported)) needed.set(ported, new Set());
    needed.get(ported).add(site.shim);
  }
  for (const [ported, shims] of needed) {
    const src = jsSources.get(ported);
    if (src === undefined) {
      notes.push(`not ported yet: ${ported} (needs ${[...shims].join(", ")})`);
      continue;
    }
    for (const shim of shims) {
      if (!new RegExp(`\\b${shim}\\b`).test(src)) {
        failures.push({
          check: "shim-routing",
          where: ported,
          detail: `must route through ${shim}() — see corpus/deny/py_builtins.json`,
        });
      }
    }
  }
}

/**
 * CHECK 3 — acknowledgement markers (operators.json, implicit_str.json).
 * Both directions matter:
 *   missing marker  a deny-listed line was ported without anyone looking at it
 *   stale marker    upstream moved and the marker now points at nothing, which is
 *                   the §3.3-rule-5 failure mode: silence where there should be a
 *                   human decision
 */
function checkMarkers(manifest, kind) {
  const expected = new Set(
    manifest.sites.filter((s) => !s.executor).map((s) => s.py),
  );
  const seen = new Set();
  const markerRe = new RegExp(`//\\s*deny:${kind}\\s+(\\S+)`, "g");
  for (const [file, src] of jsSources) {
    for (const m of src.matchAll(markerRe)) {
      seen.add(m[1]);
      if (!expected.has(m[1])) {
        failures.push({
          check: "stale-marker",
          where: file,
          detail: `deny:${kind} ${m[1]} is not in the manifest — upstream moved, or the marker is wrong`,
        });
      }
    }
  }
  const missing = [...expected].filter((py) => !seen.has(py));
  if (missing.length) {
    // Only a failure once the owning file is ported; before that it is a to-do.
    const portedMissing = missing.filter((py) => jsSources.has(pyToJsPath(py.split(":")[0])));
    for (const py of portedMissing) {
      failures.push({
        check: "missing-marker",
        where: pyToJsPath(py.split(":")[0]),
        detail: `no "// deny:${kind} ${py}" marker at the ported site`,
      });
    }
    notes.push(`deny:${kind} — ${missing.length - portedMissing.length} sites in files not ported yet`);
  }
}

/** sqlglot/generators/duckdb.py -> src/generators/duckdb.js (PORT_PLAN.md §4.1) */
function pyToJsPath(pyPath) {
  if (!pyPath.startsWith("sqlglot/")) return null;
  return path.join(SRC, pyPath.slice("sqlglot/".length).replace(/\.py$/, ".js"));
}

/* -------------------------------------------------------------------- main */

const manifests = {
  operators: path.join(DENY, "operators.json"),
  implicit_str: path.join(DENY, "implicit_str.json"),
  py_builtins: path.join(DENY, "py_builtins.json"),
};

for (const [name, p] of Object.entries(manifests)) {
  if (!fs.existsSync(p)) {
    console.error(`error: missing ${p} — run tools/deny/gen_${name}.py`);
    process.exit(2);
  }
}

const operators = readJson(manifests.operators);
const implicitStr = readJson(manifests.implicit_str);
const pyBuiltins = readJson(manifests.py_builtins);

checkBannedConstructs();
checkShimRouting(pyBuiltins);
checkMarkers(operators, "operators");
checkMarkers(implicitStr, "implicit_str");

console.log("deny-list lint (sketch)\n");
console.log(`  ported JS files scanned      ${jsFiles.length}`);
console.log(`  operators sites              ${operators.counts.in_scope}`);
console.log(`  implicit_str sites           ${implicitStr.counts.sql_default_dialect}`);
console.log(`  py_builtins sites            ${pyBuiltins.counts.in_scope}`);
console.log(`  banned JS constructs         ${BANNED_CONSTRUCTS.length}`);

if (notes.length) {
  console.log("\nnot yet applicable:");
  for (const n of notes.slice(0, 10)) console.log(`  - ${n}`);
  if (notes.length > 10) console.log(`  ... ${notes.length - 10} more`);
}

if (failures.length) {
  console.log(`\n${failures.length} failures:`);
  for (const f of failures.slice(0, 40)) {
    console.log(`  [${f.check}] ${f.where}: ${f.detail}`);
  }
  process.exit(1);
}

console.log("\nclean");
