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
    // Same partial-port allowance CHECK 3 already makes: a file carrying an explicit
    // `@ported-ranges` directive is measured against the lines it claims, not against
    // its whole upstream module. Without this, `src/dialects/dialect.js` -- which ports
    // ten builder functions out of ~2,600 lines -- is asked to import a shim for a
    // `startswith` in code it has not touched. A site with no line number, or in a file
    // that declares no ranges, is unaffected and still demands its shim.
    if (site.py && jsSources.has(ported) && !isPortedSite(site.py)
        && /@ported-ranges/.test(jsSources.get(ported))) continue;
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
    // Only a failure once the owning METHOD is ported; before that it is a to-do.
    //
    // File-level granularity was enough while files were ported all-or-nothing. P3
    // introduces the first partially-ported file — `src/parser.js` is 405 stubs with a
    // couple of dozen real bodies — and at file granularity every deny site in
    // `parser.py` became a failure the moment the seeded skeleton landed, demanding
    // markers on code that does not exist yet.
    const portedMissing = missing.filter((py) => isPortedSite(py));
    for (const py of portedMissing) {
      failures.push({
        check: "missing-marker",
        where: pyToJsPath(py.split(":")[0]),
        detail: `no "// deny:${kind} ${py}" marker at the ported site`,
      });
    }
    const stubbed = missing.filter((py) => !portedMissing.includes(py) && jsSources.has(pyToJsPath(py.split(":")[0])));
    notes.push(
      `deny:${kind} — ${missing.length - portedMissing.length} sites not ported yet` +
      (stubbed.length ? ` (${stubbed.length} of them inside NotPorted stubs)` : ""),
    );
  }
}

/**
 * CHECK 4 — required routing symbol (`route` on a deny site).
 *
 * A marker only proves someone looked. For the parse-path generate sites this is not
 * enough: the whole finding is that five of the seven are INVISIBLE `f"{expr}"`
 * coercions, so an agent implementing `_parse_pivot` reads `parser.py:5491`, sees
 * `fld.sql()`, and has no reason to know `kernelSql` exists — `src/parser.js` never
 * mentions it. That is how a discovery gets silently lost between PRs.
 *
 * So a site may name the symbol its port MUST go through. While the owning method is
 * still a `NotPorted` stub this is a note; the moment the method gets a real body the
 * ported file has to reference the symbol or this fails. Deliberately a
 * file-level reference check, not a line-level one — asserting the exact call shape
 * would be guessing at code that does not exist yet, and the marker plus the human
 * review gate (§8.5) cover the rest.
 */
function checkRouting(manifest, kind) {
  for (const site of manifest.sites) {
    if (site.executor || !site.route) continue;
    const ported = pyToJsPath(site.file);
    if (!ported) continue;
    const src = jsSources.get(ported);
    if (src === undefined || !isPortedSite(site.py)) {
      notes.push(
        `deny:${kind} ${site.py} — not ported yet; when it lands it must route through `
        + `${site.route}() (${site.why ?? ""})`.trimEnd(),
      );
      continue;
    }
    if (!new RegExp(`\\b${site.route}\\b`).test(src)) {
      failures.push({
        check: "missing-route",
        where: `${ported} (for ${site.py})`,
        detail:
          `${site.fn ?? "this method"} generates SQL mid-parse and the result is baked `
          + `into the AST — it must go through ${site.route}(), not a hand-written `
          + `renderer or a JS template literal. See corpus/deny/${kind}.json.`,
      });
    }
  }
}

/**
 * Is the upstream line `file:line` inside a method the port has actually IMPLEMENTED?
 *
 * Derived from the port's own source, so it needs no extra manifest and cannot drift:
 * `tools/seed_static.py` gives every method a `// py: <file>:<line>` anchor immediately
 * above it, in upstream order, and an unported one throws `NotPorted`. The method
 * owning a deny site is the one with the greatest anchor line <= the site's line; the
 * site counts as ported iff that method's body is not a `NotPorted` stub.
 */
function isPortedSite(py) {
  const [pyFile, lineStr] = py.split(":");
  const jsPath = pyToJsPath(pyFile);
  const src = jsSources.get(jsPath);
  if (src === undefined) return false;

  // An explicit `// @ported-ranges <pyfile> <a-b> <c-d> ...` directive wins: a file that
  // deliberately ports only part of an upstream module (e.g. optimizer Tier A) says so
  // once, instead of every deny site in the untouched half becoming a failure the
  // moment the file is created.
  const rangeRe = /@ported-ranges\s+(\S+)((?:\s+\d+-\d+)+)/g;
  let declared = null;
  for (const m of src.matchAll(rangeRe)) {
    if (m[1] !== pyFile) continue;
    declared ??= [];
    for (const r of m[2].trim().split(/\s+/)) {
      const [a, b] = r.split("-").map(Number);
      declared.push([a, b]);
    }
  }
  if (declared) {
    const line = Number(lineStr);
    return declared.some(([a, b]) => line >= a && line <= b);
  }

  const anchors = [];
  const re = /\/\/\s*py:\s*(\S+?):(\d+)\s*\n([\s\S]{0,400}?)(?=\n\s*\/\*\*|\n\s*\/\/\s*py:|$)/g;
  for (const m of src.matchAll(re)) {
    if (m[1] !== pyFile) continue;
    anchors.push({ line: Number(m[2]), stub: m[3].includes("new NotPorted(") });
  }
  if (!anchors.length) {
    // No anchors at all — a hand-written port with no seeded skeleton. Keep the old
    // file-level behaviour rather than silently excusing every site in it.
    return true;
  }
  anchors.sort((a, b) => a.line - b.line);

  const line = Number(lineStr);
  let owner = null;
  for (const a of anchors) {
    if (a.line <= line) owner = a;
    else break;
  }
  // Before the first anchor means module level, which is always hand-written.
  return owner === null ? true : !owner.stub;
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
checkRouting(operators, "operators");
checkRouting(implicitStr, "implicit_str");

console.log("deny-list lint (sketch)\n");
console.log(`  ported JS files scanned      ${jsFiles.length}`);
console.log(`  operators sites              ${operators.counts.in_scope}`);
console.log(`  implicit_str sites           ${implicitStr.counts.sql_default_dialect}`);
console.log(`  py_builtins sites            ${pyBuiltins.counts.in_scope}`);
console.log(`  banned JS constructs         ${BANNED_CONSTRUCTS.length}`);
const routed = [...operators.sites, ...implicitStr.sites].filter((s) => s.route && !s.executor);
console.log(
  `  routing-enforced sites       ${routed.length}`
  + (routed.length ? ` (${routed.filter((s) => isPortedSite(s.py)).length} live)` : ""),
);

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
