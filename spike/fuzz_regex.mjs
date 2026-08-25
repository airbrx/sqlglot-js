// Differential runner for src/_py/re.js against the CPython oracle.
//
// This is the P0 prep for `tools/fuzz_regex.py` (PORT_PLAN.md §3.4 item 2). It reads
// the JSONL written by spike/py/gen_regex_cases.py and diffs four surfaces:
//
//   oracle        re.compile(p).groups / groupindex / validity  -- the contract
//                 sqlglot/parsers/bigquery.py:127 depends on
//   match         search / match / fullmatch / findall spans and groups
//   sub           re.sub template semantics and replacement output
//   escape        re.escape byte-fidelity, plus /u-validity and match round-trip
//
// Usage:
//   node spike/fuzz_regex.mjs [--cases spike/regex/corpus/cases.jsonl]
//                             [--max-failures 25] [--kind oracle] [--verbose]
//
// Exit code 0 iff every case in scope passed.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  PyReError,
  PyReUntranslatable,
  PyPattern,
  pyReEscape,
  pyReEscapeExact,
  pyReParse,
  pyReTemplate,
} from "../src/_py/re.js";

/* -------------------------------------------------------------------- args */

const argv = process.argv.slice(2);
/** @param {string} name @param {string} dflt */
function opt(name, dflt) {
  const i = argv.indexOf("--" + name);
  return i === -1 ? dflt : argv[i + 1];
}
const CASES = opt("cases", "spike/regex/corpus/cases.jsonl");
const MAX_FAILURES = Number(opt("max-failures", "25"));
const ONLY_KIND = opt("kind", "");
const VERBOSE = argv.includes("--verbose");

/* ------------------------------------------------------------------ report */

/** @type {Record<string, {pass:number, fail:number, skip:number, failures:any[]}>} */
const stats = {};
/** @param {string} kind */
function bucket(kind) {
  if (!stats[kind]) stats[kind] = { pass: 0, fail: 0, skip: 0, failures: [] };
  return stats[kind];
}
/** @type {string} */
let currentSite = "";
/** @param {string} kind @param {string} why @param {object} detail */
function fail(kind, why, detail) {
  const b = bucket(kind);
  b.fail += 1;
  tallySite(currentSite, "fail");
  if (b.failures.length < MAX_FAILURES) b.failures.push({ why, ...detail });
}
/** @param {string} kind */
function pass(kind) {
  bucket(kind).pass += 1;
  tallySite(currentSite, "pass");
}
/** @param {string} kind @param {string} why @param {object} [detail] */
function skip(kind, why, detail) {
  const b = bucket(kind);
  b.skip += 1;
  tallySite(currentSite, "skip");
  if (VERBOSE && b.failures.length < MAX_FAILURES) b.failures.push({ why: "SKIP " + why, ...detail });
}

// Per-call-site tally. The headline number for this spike is not the total but
// "every pattern sqlglot actually reaches", so results are also bucketed by the
// `file:line` the pattern was harvested from.
/** @type {Map<string, {pass:number, fail:number, skip:number}>} */
const bySite = new Map();
/** @param {string} py @param {'pass'|'fail'|'skip'} outcome */
function tallySite(py, outcome) {
  if (!py) return;
  let s = bySite.get(py);
  if (!s) {
    s = { pass: 0, fail: 0, skip: 0 };
    bySite.set(py, s);
  }
  s[outcome] += 1;
}

/** Structural equality good enough for the JSON shapes the oracle emits. */
function eq(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => eq(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return eq(ka, kb) && ka.every((k) => eq(a[k], b[k]));
  }
  return false;
}

/* ---------------------------------------------------- untranslatable census */

/** @type {Map<string, {count:number, example:string, py:string}>} */
const untranslatable = new Map();
/** @param {string} reason @param {string} pattern @param {string} py */
function noteUntranslatable(reason, pattern, py) {
  const cur = untranslatable.get(reason);
  if (cur) cur.count += 1;
  else untranslatable.set(reason, { count: 1, example: pattern, py });
}

/* ---------------------------------------------------------------- handlers */

/**
 * `re.compile(p).groups` and validity -- the oracle sqlglot/parsers/bigquery.py:127
 * reads directly. Must agree even for patterns JS cannot execute.
 */
function runOracle(rec) {
  const kind = "oracle";
  let info = null;
  let error = null;
  try {
    info = pyReParse(rec.pattern, rec.flags);
  } catch (e) {
    if (!(e instanceof PyReError)) {
      fail(kind, "unexpected exception class", {
        pattern: rec.pattern,
        py: rec.py,
        js: `${/** @type {Error} */ (e).name}: ${/** @type {Error} */ (e).message}`,
      });
      return;
    }
    error = e;
  }

  if (rec.valid !== (error === null)) {
    fail(kind, rec.valid ? "JS rejected a pattern CPython accepts" : "JS accepted a pattern CPython rejects", {
      pattern: rec.pattern,
      flags: rec.flags,
      py: rec.py,
      cpython: rec.valid ? `valid, groups=${rec.groups}` : `re.error: ${rec.error}`,
      js: error ? `PyReError: ${error.msg}` : `valid, groups=${info.groups}`,
    });
    return;
  }
  if (!rec.valid) {
    pass(kind);
    return;
  }
  if (info.groups !== rec.groups) {
    fail(kind, "group count mismatch", {
      pattern: rec.pattern,
      py: rec.py,
      cpython: rec.groups,
      js: info.groups,
    });
    return;
  }
  if (!eq(info.groupIndex, rec.groupindex)) {
    fail(kind, "groupindex mismatch", {
      pattern: rec.pattern,
      py: rec.py,
      cpython: rec.groupindex,
      js: info.groupIndex,
    });
    return;
  }
  if (info.untranslatable) noteUntranslatable(info.untranslatable, rec.pattern, rec.py);
  pass(kind);
}

/** search / match / fullmatch / findall behaviour on real subject strings. */
function runMatch(rec) {
  const kind = "match";
  if (rec.runtime_error) {
    skip(kind, "CPython runtime error on this case", { pattern: rec.pattern });
    return;
  }
  let p;
  try {
    p = new PyPattern(rec.pattern, rec.flags);
  } catch (e) {
    if (e instanceof PyReUntranslatable) {
      noteUntranslatable(e.reason, rec.pattern, rec.py);
      skip(kind, "untranslatable: " + e.reason, { pattern: rec.pattern, py: rec.py });
      return;
    }
    fail(kind, "compile failed for a CPython-valid pattern", {
      pattern: rec.pattern,
      py: rec.py,
      js: `${/** @type {Error} */ (e).name}: ${/** @type {Error} */ (e).message}`,
    });
    return;
  }

  const s = rec.subject;
  /** @param {import('../src/_py/re.js').PyMatch|null} m */
  const shape = (m) => (m === null ? null : [m.start(), m.end(), m.groups("")]);

  for (const op of ["search", "match", "fullmatch"]) {
    const got = shape(p[op](s));
    // CPython reports unmatched groups as None; the oracle JSON encodes that as null.
    const want = rec[op] === null ? null : [rec[op][0], rec[op][1], rec[op][2].map((v) => (v === null ? "" : v))];
    if (!eq(got, want)) {
      fail(kind, `${op} mismatch`, {
        pattern: rec.pattern,
        subject: s,
        py: rec.py,
        cpython: want,
        js: got,
        jsSource: p._src,
      });
      return;
    }
  }
  const gotFind = p.findall(s);
  if (!eq(gotFind, rec.findall)) {
    fail(kind, "findall mismatch", {
      pattern: rec.pattern,
      subject: s,
      py: rec.py,
      cpython: rec.findall,
      js: gotFind,
      jsSource: p._src,
    });
    return;
  }
  pass(kind);
}

/** `re.sub` template translation and replacement output. */
function runSub(rec) {
  const kind = "sub";
  let p;
  try {
    p = new PyPattern(rec.pattern, rec.flags);
  } catch (e) {
    if (e instanceof PyReUntranslatable) {
      noteUntranslatable(e.reason, rec.pattern, "sub");
      skip(kind, "untranslatable", { pattern: rec.pattern });
      return;
    }
    fail(kind, "compile failed", { pattern: rec.pattern, js: String(e) });
    return;
  }

  let got = null;
  let err = null;
  try {
    got = p.subn(rec.repl, rec.subject, rec.count);
  } catch (e) {
    err = e;
  }

  if ("error" in rec) {
    // CPython raised. It raises re.error for a bad escape and IndexError for an
    // unknown group; we only require that JS also refuses, not that the class
    // matches -- nothing in sqlglot/ catches a template error.
    if (err === null) {
      fail(kind, "JS accepted a template CPython rejects", {
        pattern: rec.pattern,
        repl: rec.repl,
        cpython: `${rec.error_type}: ${rec.error}`,
        js: got,
      });
    } else {
      pass(kind);
    }
    return;
  }
  if (err !== null) {
    fail(kind, "JS rejected a template CPython accepts", {
      pattern: rec.pattern,
      repl: rec.repl,
      cpython: rec.result,
      js: `${/** @type {Error} */ (err).name}: ${/** @type {Error} */ (err).message}`,
    });
    return;
  }
  if (got[0] !== rec.result || got[1] !== rec.n) {
    fail(kind, "sub output mismatch", {
      pattern: rec.pattern,
      repl: rec.repl,
      subject: rec.subject,
      count: rec.count,
      cpython: [rec.result, rec.n],
      js: got,
    });
    return;
  }

  // Additionally check the *string* template form where it is unambiguous, since
  // that is what a hand-written port is most likely to reach for.
  const tmpl = pyReTemplate(rec.repl, p.groups, p.groupindex);
  if (tmpl.js !== null && p._src !== null) {
    const re = new RegExp(p._src, p._flags + "g");
    const viaString = rec.count === 0
      ? rec.subject.replace(re, tmpl.js)
      : null;
    if (viaString !== null && viaString !== rec.result) {
      fail(kind, "string-form template diverges from CPython", {
        pattern: rec.pattern,
        repl: rec.repl,
        jsTemplate: tmpl.js,
        cpython: rec.result,
        js: viaString,
      });
      return;
    }
  }
  pass(kind);
}

/**
 * `re.escape`. Two separate claims:
 *   (a) pyReEscapeExact reproduces CPython's output byte for byte;
 *   (b) pyReEscape output is accepted under a JS `u` flag AND matches exactly the
 *       input string -- which is the property every call site actually relies on.
 */
function runEscape(rec) {
  const kind = "escape";
  const exact = pyReEscapeExact(rec.input);
  if (exact !== rec.output) {
    fail(kind, "pyReEscapeExact differs from CPython re.escape", {
      input: rec.input,
      cpython: rec.output,
      js: exact,
    });
    return;
  }
  const safe = pyReEscape(rec.input);
  let re;
  try {
    re = new RegExp("^(?:" + safe + ")$", "u");
  } catch (e) {
    fail(kind, "pyReEscape output is not valid under /u", {
      input: rec.input,
      js: safe,
      error: /** @type {Error} */ (e).message,
    });
    return;
  }
  if (re.test(rec.input) !== rec.roundtrip) {
    fail(kind, "pyReEscape round-trip disagrees with CPython", {
      input: rec.input,
      escaped: safe,
      cpython: rec.roundtrip,
      js: re.test(rec.input),
    });
    return;
  }
  // The escaped form must also survive being re-parsed as Python regex source,
  // because qualify_columns.py:1176 concatenates escape() output into a new pattern.
  try {
    pyReParse(safe);
  } catch (e) {
    fail(kind, "pyReEscape output does not re-parse as a Python pattern", {
      input: rec.input,
      escaped: safe,
      error: /** @type {Error} */ (e).message,
    });
    return;
  }
  pass(kind);
}

/** The real ILIKE-pattern construction at qualify_columns.py:1176. */
function runEscapeBuild(rec) {
  const kind = "escape_build";
  let built = "";
  for (const ch of rec.input) {
    if (ch === "_") built += ".";
    else if (ch === "%") built += ".*";
    else built += pyReEscape(ch);
  }
  let p;
  try {
    p = new PyPattern(built, 2 /* IGNORECASE */);
  } catch (e) {
    fail(kind, "built pattern failed to compile", {
      input: rec.input,
      built,
      error: /** @type {Error} */ (e).message,
    });
    return;
  }
  for (const [subject, want] of Object.entries(rec.matches)) {
    const got = p.fullmatch(subject) !== null;
    if (got !== want) {
      fail(kind, "ILIKE fullmatch mismatch", {
        ilike: rec.input,
        pythonBuilt: rec.built,
        jsBuilt: built,
        subject,
        cpython: want,
        js: got,
      });
      return;
    }
  }
  pass(kind);
}

/* -------------------------------------------------------------------- main */

const casesPath = path.resolve(CASES);
if (!fs.existsSync(casesPath)) {
  console.error(`error: ${casesPath} not found -- run spike/py/gen_regex_cases.py first`);
  process.exit(2);
}

const started = Date.now();
let n = 0;
for (const line of fs.readFileSync(casesPath, "utf8").split("\n")) {
  if (line === "") continue;
  const rec = JSON.parse(line);
  if (ONLY_KIND && rec.kind !== ONLY_KIND) continue;
  n += 1;
  currentSite = rec.py || (rec.kind === "sub" || rec.kind === "escape" ? "spike:api" : "");
  switch (rec.kind) {
    case "oracle": runOracle(rec); break;
    case "match": runMatch(rec); break;
    case "sub": runSub(rec); break;
    case "escape": runEscape(rec); break;
    case "escape_build": runEscapeBuild(rec); break;
    default: skip(rec.kind, "unknown case kind"); break;
  }
}

let totalFail = 0;
console.log(`\n_py/re.js differential vs CPython — ${n} cases in ${Date.now() - started}ms\n`);
console.log(`${"surface".padEnd(16)}${"pass".padStart(8)}${"fail".padStart(8)}${"skip".padStart(8)}`);
console.log("-".repeat(40));
for (const [kind, b] of Object.entries(stats)) {
  totalFail += b.fail;
  console.log(`${kind.padEnd(16)}${String(b.pass).padStart(8)}${String(b.fail).padStart(8)}${String(b.skip).padStart(8)}`);
}
const totals = Object.values(stats).reduce(
  (acc, b) => ({ pass: acc.pass + b.pass, fail: acc.fail + b.fail, skip: acc.skip + b.skip }),
  { pass: 0, fail: 0, skip: 0 },
);
console.log("-".repeat(40));
console.log(`${"TOTAL".padEnd(16)}${String(totals.pass).padStart(8)}${String(totals.fail).padStart(8)}${String(totals.skip).padStart(8)}`);

console.log("\nBy sqlglot call site (patterns the library actually reaches):");
const sites = [...bySite].filter(([py]) => py.startsWith("sqlglot/")).sort();
for (const [py, s] of sites) {
  const flagStr = s.fail > 0 ? "  <-- FAIL" : "";
  console.log(
    `  ${py.padEnd(46)}${String(s.pass).padStart(6)} pass${String(s.fail).padStart(5)} fail${String(s.skip).padStart(5)} skip${flagStr}`,
  );
}
const siteFail = sites.reduce((a, [, s]) => a + s.fail, 0);
const siteSkip = sites.reduce((a, [, s]) => a + s.skip, 0);
const sitePass = sites.reduce((a, [, s]) => a + s.pass, 0);
console.log(`  ${"".padEnd(46)}${"-".repeat(30)}`);
console.log(
  `  ${"ALL sqlglot-reachable patterns".padEnd(46)}${String(sitePass).padStart(6)} pass${String(siteFail).padStart(5)} fail${String(siteSkip).padStart(5)} skip`,
);

if (untranslatable.size > 0) {
  console.log("\nPatterns valid in CPython with no faithful JS encoding:");
  for (const [reason, info] of [...untranslatable].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${String(info.count).padStart(4)}x  ${reason}`);
    console.log(`        e.g. ${JSON.stringify(info.example)}  (${info.py})`);
  }
}

for (const [kind, b] of Object.entries(stats)) {
  if (b.failures.length === 0) continue;
  console.log(`\n--- ${kind}: first ${b.failures.length} of ${b.fail} failures ---`);
  for (const f of b.failures) console.log("  " + JSON.stringify(f));
}

process.exit(totalFail === 0 ? 0 : 1);
