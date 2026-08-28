// Negative tests for tools/claim_overlap.mjs.  `node tools/claim_overlap.mjs --selftest`
//
// A check nobody has broken on purpose is not a check. The load-bearing case here is
// FALSE POSITIVES, not false negatives: if this thing flags two PRs that replace two
// DIFFERENT one-line stubs in `src/parser.js`, it contradicts PORT_PLAN.md §8.1 Rule 2 —
// whose whole point is that such a pair merges cleanly — and it is worse than useless,
// because it would serialise the stub queue the seeding exists to parallelise. Case 4
// below is that test. Cases 5-6 are its mirror: the same stub, and the same table entry,
// must still be caught.
//
// No network, no gh, no git for cases 1-12; case 13 reads the real src/parser.js.

import fs from "node:fs";
import process from "node:process";

// A miniature of src/parser.js: 2-space members, one-line `NotPorted` stubs each with its
// own JSDoc + `// py:` anchor (Rule 2), and a class table one entry per line (Rule 2').
const PARSER = `import { NotPorted } from "./errors.js";
import { TokenType } from "./tokens.js";

export class Parser {
  static FUNCTIONS = new Map([
    // py:377  ["COALESCE", /* TODO build_coalesce */],
    // py:377  ["IFNULL", /* TODO build_coalesce */],
    ["ARRAY_AGG", buildArrayAgg],
    ["CONCAT", buildConcat],
  ]);

  static TYPE_TOKENS = new Set([
    TokenType.BIT,
    TokenType.BOOLEAN,
  ]);

  /** @returns {*} */
  // py: sqlglot/parser.py:2287
  _parse_comment(allow_exists) { throw new NotPorted("_parse_comment", "sqlglot/parser.py:2287"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:2319
  _parse_to_table() { throw new NotPorted("_parse_to_table", "sqlglot/parser.py:2319"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:2326
  _parse_ttl() { throw new NotPorted("_parse_ttl", "sqlglot/parser.py:2326"); }

  _parse_real(x) {
    const s = "{ not a brace }";
    if (x) {
      return s;
    }
    return null;
  }
}
`;

// Line numbers used by the fixtures below, resolved by name so edits to PARSER above
// cannot silently rot the tests into vacuity.
const L = (needle) => {
  const i = PARSER.split("\n").findIndex((l) => l.includes(needle));
  if (i === -1) throw new Error(`fixture line not found: ${needle}`);
  return i + 1;
};

/** Build a one-file unified diff replacing `count` lines at old line `start`. */
function patchAt(path, start, count, added) {
  const body = [`@@ -${start},${count} +${start},${added.length} @@`];
  const src = PARSER.split("\n");
  for (let k = 0; k < count; k++) body.push("-" + src[start - 1 + k]);
  for (const a of added) body.push("+" + a);
  return { filename: path, status: "modified", patch: body.join("\n") };
}
/** Pure insertion of `added` before old line `start`. */
function insertAt(path, start, added) {
  const src = PARSER.split("\n");
  const body = [`@@ -${start - 1},2 +${start - 1},${2 + added.length} @@`, " " + src[start - 2]];
  for (const a of added) body.push("+" + a);
  body.push(" " + src[start - 1]);
  return { filename: path, status: "modified", patch: body.join("\n") };
}

export function run(api) {
  const { indexUnits, hunkOldLines, splitGitDiff, unitsForFiles, compare, adjacency, globMatch } = api;
  const readBase = (p) => (p === "src/parser.js" ? PARSER : null);
  const claim = (id, files, base = "B0") => ({ id, base, ...unitsForFiles(files, readBase) });
  const fails = [];
  let n = 0;
  const t = (name, fn) => {
    n += 1;
    try { fn(); console.log(`  ok   ${name}`); }
    catch (e) { fails.push(`${name}: ${e.message}`); console.log(`  FAIL ${name}\n         ${e.message}`); }
  };
  const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

  console.log("claim_overlap selftest\n");

  // ---- 1-3: the primitives -------------------------------------------------
  t("1  indexUnits: methods own their JSDoc + `// py:` anchor block", () => {
    const idx = indexUnits(PARSER);
    eq(idx.unitAt(L("_parse_ttl()")), "Parser#_parse_ttl", "body line");
    eq(idx.unitAt(L("py: sqlglot/parser.py:2326")), "Parser#_parse_ttl", "anchor line");
    eq(idx.unitAt(L("py: sqlglot/parser.py:2326") - 1), "Parser#_parse_ttl", "jsdoc line");
  });

  t("2  indexUnits: table entries are per-entry, including commented seed lines", () => {
    const idx = indexUnits(PARSER);
    eq(idx.unitAt(L('["ARRAY_AGG"')), "Parser.FUNCTIONS[ARRAY_AGG]", "live entry");
    eq(idx.unitAt(L('["COALESCE"')), "Parser.FUNCTIONS[COALESCE]", "commented seed entry");
    eq(idx.unitAt(L("TokenType.BOOLEAN")), "Parser.TYPE_TOKENS[TokenType.BOOLEAN]", "set entry");
    eq(idx.unitAt(L("static FUNCTIONS")), "Parser.FUNCTIONS$decl", "decl line");
  });

  t("3  indexUnits: a `{` inside a string does not break region tracking", () => {
    // The reason this is indentation-driven and not brace-counting.
    const idx = indexUnits(PARSER);
    eq(idx.unitAt(L("not a brace")), "Parser#_parse_real", "string with braces");
    eq(idx.unitAt(L("return null;")), "Parser#_parse_real", "after the brace-y string");
  });

  t("3b hunkOldLines: a `-`/`+` pair is a REPLACEMENT, not an insertion", () => {
    const r = hunkOldLines(["@@ -10,4 +10,5 @@", " a", "-b", "+B1", "+B2", " c", " d"].join("\n"));
    eq(JSON.stringify(r.touched), "[11]", "removed line");
    eq(JSON.stringify(r.insertAt), "[]", "no insertion point — the `+`s replace line 11");
    // A `+` run bounded by context IS a true insertion, and lands before old line 12.
    const s = hunkOldLines(["@@ -10,3 +10,4 @@", " a", " b", "+NEW", " c"].join("\n"));
    eq(JSON.stringify(s.touched), "[]", "nothing removed");
    eq(JSON.stringify(s.insertAt), "[12]", "insertion point");
  });

  t("3c globMatch: decides method- vs file-granularity, so it is load-bearing", () => {
    eq(globMatch("src/parser.js", "src/parser.js"), true, "exact");
    eq(globMatch("src/parser.js", "src/parser.json"), false, "no partial match");
    eq(globMatch("src/generators/**.js", "src/generators/duckdb.js"), true, "** one level");
    eq(globMatch("src/generators/**.js", "src/generators/a/b.js"), true, "** many levels");
    eq(globMatch("src/generators/*.js", "src/generators/a/b.js"), false, "* stops at /");
    eq(globMatch("src/*.js", "src/parser.js"), true, "* one level");
    eq(globMatch("src/*.js", "src/expressions/core.js"), false, "* stops at /");
  });

  // ---- 4: THE FALSE-POSITIVE TEST -----------------------------------------
  t("4  TWO DIFFERENT STUBS in src/parser.js -> NOT flagged   (§8.1 Rule 2)", () => {
    const a = claim("A", [patchAt("src/parser.js", L("py: sqlglot/parser.py:2287") - 1, 3,
      ["  /** @returns {Expr} */", "  // py: sqlglot/parser.py:2287",
        "  _parse_comment(allow_exists) {", "    return this._real();", "  }"])]);
    const b = claim("B", [patchAt("src/parser.js", L("py: sqlglot/parser.py:2326") - 1, 3,
      ["  /** @returns {Expr} */", "  // py: sqlglot/parser.py:2326",
        "  _parse_ttl() {", "    return this._other();", "  }"])]);
    eq(a.units.has("src/parser.js:Parser#_parse_comment"), true, "A claims _parse_comment");
    eq(b.units.has("src/parser.js:Parser#_parse_ttl"), true, "B claims _parse_ttl");
    eq(compare([a, b]).length, 0, "MUST NOT flag — this pair merges cleanly by construction");
  });

  t("4b two different table entries -> NOT flagged           (§8.1 Rule 2')", () => {
    const a = claim("A", [patchAt("src/parser.js", L('["COALESCE"'), 1, ['    ["COALESCE", buildCoalesce],'])]);
    const b = claim("B", [patchAt("src/parser.js", L('["IFNULL"'), 1, ['    ["IFNULL", buildCoalesce],'])]);
    eq(compare([a, b]).length, 0, "adjacent-but-distinct entries must not be flagged");
  });

  t("4c a stub replacement and a table entry -> NOT flagged", () => {
    const a = claim("A", [patchAt("src/parser.js", L("py: sqlglot/parser.py:2319") - 1, 3, ["  _parse_to_table() { return 1; }"])]);
    const b = claim("B", [patchAt("src/parser.js", L("TokenType.BIT"), 1, ["    TokenType.BIT,", "    TokenType.BIGINT,"])]);
    eq(compare([a, b]).length, 0, "different kinds of unit, same file");
  });

  // ---- 5-8: it still catches real conflicts --------------------------------
  t("5  THE SAME STUB from two PRs -> flagged", () => {
    const mk = (body) => patchAt("src/parser.js", L("py: sqlglot/parser.py:2326") - 1, 3, [body]);
    const c = compare([claim("A", [mk("  _parse_ttl() { return 1; }")]), claim("B", [mk("  _parse_ttl() { return 2; }")])]);
    eq(c.length, 1, "one conflict");
    eq(c[0].shared.includes("src/parser.js:Parser#_parse_ttl"), true, "names the method");
  });

  t("6  THE SAME table entry from two PRs -> flagged", () => {
    const mk = (v) => patchAt("src/parser.js", L('["COALESCE"'), 1, [`    ["COALESCE", ${v}],`]);
    const c = compare([claim("A", [mk("x")]), claim("B", [mk("y")])]);
    eq(c.length, 1, "one conflict");
    eq(c[0].shared[0], "src/parser.js:Parser.FUNCTIONS[COALESCE]", "names the entry");
  });

  t("7  two insertions at the SAME point -> flagged (ORDER hazard, not textual)", () => {
    // Measured with `git merge-file`: this pair merges CLEANLY, but git picks an
    // arbitrary order for the two additions and §4.6 makes table insertion order visible
    // in output SQL. Flagged on purpose -- a hazard git will never report.
    const a = claim("A", [insertAt("src/parser.js", L('["ARRAY_AGG"'), ['    ["ABS", buildAbs],'])]);
    const b = claim("B", [insertAt("src/parser.js", L('["ARRAY_AGG"'), ['    ["ACOS", buildAcos],'])]);
    eq(compare([a, b]).length, 1, "same insertion point is a textual conflict");
  });

  t("8  file-granular paths: same file from two PRs -> flagged", () => {
    const f = [{ filename: "src/helper.js", status: "modified", patch: "@@ -1,1 +1,1 @@\n-a\n+b" }];
    const g = [{ filename: "src/helper.js", status: "modified", patch: "@@ -90,1 +90,1 @@\n-c\n+d" }];
    // Rule 3 keeps src/helper.js single-owner, so ANY co-edit is a claim collision.
    eq(compare([claim("A", f), claim("B", g)]).length, 1, "helper.js is not method-granular");
  });

  t("8b disjoint files -> NOT flagged", () => {
    eq(compare([
      claim("A", [{ filename: "src/expressions/core.js", status: "modified", patch: "@@ -1,1 +1,1 @@\n-a\n+b" }]),
      claim("B", [{ filename: "src/trie.js", status: "modified", patch: "@@ -1,1 +1,1 @@\n-a\n+b" }]),
    ]).length, 0, "different files");
  });

  t("7b ADJACENCY: different units, adjacent lines -> warn, but do NOT fail", () => {
    // Calibrated against `git merge-file` on the real src/parser.js: edits to lines
    // 131/132 (0 lines between) CONFLICT; 131/133 and wider are CLEAN.
    const a = claim("A", [patchAt("src/parser.js", L('["COALESCE"'), 1, ['    ["COALESCE", x],'])]);
    const b = claim("B", [patchAt("src/parser.js", L('["IFNULL"'), 1, ['    ["IFNULL", y],'])]);
    eq(compare([a, b]).length, 0, "different units: NOT an overlap");
    eq(adjacency([a, b]).length, 1, "but adjacent: warn");
    const c = claim("C", [patchAt("src/parser.js", L('["CONCAT"'), 1, ['    ["CONCAT", z],'])]);
    eq(adjacency([a, c]).length, 0, "two lines apart: no warn (git merges it cleanly)");
  });

  t("7c ADJACENCY is skipped across differing bases, and says so", () => {
    const a = claim("A", [patchAt("src/parser.js", L('["COALESCE"'), 1, ['    ["COALESCE", x],'])], "B0");
    const b = claim("B", [patchAt("src/parser.js", L('["IFNULL"'), 1, ['    ["IFNULL", y],'])], "B1");
    eq(adjacency([a, b]).length, 0, "line numbers are not comparable across bases");
  });

  t("7d STALE BASE: the same unit at different line numbers still collides", () => {
    // The whole point of comparing unit NAMES. `shifted` is the fixture with 800 lines
    // inserted above the stubs, exactly as a prior PR would do.
    const shifted = PARSER.replace("  /** @returns {*} */\n  // py: sqlglot/parser.py:2287",
      Array.from({ length: 40 }, (_, i) => `  _new_${i}() { return ${i}; }\n`).join("")
      + "  /** @returns {*} */\n  // py: sqlglot/parser.py:2287");
    const readShift = (p) => (p === "src/parser.js" ? shifted : null);
    const lo = L("py: sqlglot/parser.py:2326");
    const hi = shifted.split("\n").findIndex((l) => l.includes("py: sqlglot/parser.py:2326")) + 1;
    if (hi <= lo) throw new Error("fixture did not shift");
    const onOld = { id: "old", base: "B0", ...unitsForFiles([patchAt("src/parser.js", lo, 2, ["  x"])], readBase) };
    const src2 = shifted.split("\n");
    const body = [`@@ -${hi},2 +${hi},1 @@`, "-" + src2[hi - 1], "-" + src2[hi], "+  x"];
    const onNew = { id: "new", base: "B1", ...unitsForFiles([{ filename: "src/parser.js", status: "modified", patch: body.join("\n") }], readShift) };
    eq([...onOld.units][0], "src/parser.js:Parser#_parse_ttl", `old base -> line ${lo}`);
    eq([...onNew.units][0], "src/parser.js:Parser#_parse_ttl", `new base -> line ${hi}`);
    eq(compare([onOld, onNew]).length, 1, "same unit, different bases, different line numbers");
  });

  // ---- 9-12: the boring-but-real cases ------------------------------------
  t("9  missing `patch` (GitHub omits it on huge diffs) -> widens, loudly", () => {
    const a = claim("A", [{ filename: "src/parser.js", status: "modified" }]);
    eq(a.units.has("FILE src/parser.js"), true, "widened to whole file");
    eq(a.degraded.length, 1, "and said so");
    const b = claim("B", [patchAt("src/parser.js", L("py: sqlglot/parser.py:2326") - 1, 3, ["  x"])]);
    eq(compare([a, b]).length, 0, "widened claim is FILE-scoped; unit claims do not collide with it");
  });

  t("9b base blob unavailable -> widens, loudly", () => {
    const c = { id: "A", ...unitsForFiles([patchAt("src/parser.js", 20, 1, ["x"])], () => null) };
    eq(c.units.has("FILE src/parser.js"), true, "widened");
    eq(/base blob unavailable/.test(c.degraded[0]), true, "reason printed");
  });

  t("10 added / removed / renamed files are whole-file claims", () => {
    const a = claim("A", [{ filename: "src/parser.js", status: "added" }]);
    eq(a.units.has("FILE src/parser.js"), true, "new file");
    const r = claim("B", [{ filename: "src/z.js", previous_filename: "src/y.js", status: "renamed" }]);
    eq(r.units.has("FILE src/y.js") && r.units.has("FILE src/z.js"), true, "both sides of a rename");
  });

  t("11 splitGitDiff parses a real multi-file `git diff`", () => {
    const d = ["diff --git a/src/parser.js b/src/parser.js", "index 111..222 100644",
      "--- a/src/parser.js", "+++ b/src/parser.js", "@@ -1,1 +1,1 @@", "-a", "+b",
      "diff --git a/README.md b/README.md", "new file mode 100644",
      "--- /dev/null", "+++ b/README.md", "@@ -0,0 +1,1 @@", "+hi"].join("\n");
    const fs2 = splitGitDiff(d);
    eq(fs2.length, 2, "two files");
    eq(fs2[0].filename, "src/parser.js", "first name");
    eq(fs2[1].status, "added", "second is a new file");
    eq(fs2[0].patch.startsWith("@@"), true, "patch body starts at the hunk header");
  });

  t("12 empty PR (no files) claims nothing and collides with nothing", () => {
    eq(claim("A", []).units.size, 0, "no units");
    eq(compare([claim("A", []), claim("B", [patchAt("src/parser.js", 20, 1, ["x"])])]).length, 0, "no conflict");
  });

  // ---- 13-14: the real src/parser.js --------------------------------------
  const realSrc = fs.readFileSync(new URL("../src/parser.js", import.meta.url), "utf8");
  const realStubs = [];
  realSrc.split("\n").forEach((l, i) => {
    const m = /^  ([#\w$]+)\([^)]*\)\s*\{\s*throw new NotPorted\(/.exec(l);
    if (m) realStubs.push({ name: m[1], line: i + 1 });
  });

  t("13 real src/parser.js: every NotPorted stub resolves to its own unit", () => {
    const idx = indexUnits(realSrc);
    const seen = new Map();
    for (const s of realStubs) {
      const u = idx.unitAt(s.line);
      // `Parser#name`, or `Parser#name@sqlglot/parser.py:NNN` where the seeder emitted
      // Python `@t.overload` declarations as real JS methods (see indexUnits).
      if (u !== `Parser#${s.name}` && !u.startsWith(`Parser#${s.name}@`)) {
        throw new Error(`line ${s.line} ${s.name} -> ${u}`);
      }
      if (seen.has(u)) throw new Error(`duplicate unit ${u} (lines ${seen.get(u)}, ${s.line})`);
      seen.set(u, s.line);
    }
    // Sanity floor, not a progress gate: this count legitimately SHRINKS as the stub
    // queue empties (405 originally seeded -> 0 once P3 is done), so it must not assert
    // a specific baseline. 50 is generous headroom above "the regex silently broke and
    // found a handful" while staying well clear of real stub-queue burndown. Found
    // 2026-08-28 when merging the first parallel stub-queue batch (286 real stubs
    // remaining) tripped the old `< 300` floor as a false failure.
    if (realStubs.length < 50) throw new Error(`only found ${realStubs.length} stubs — drift?`);
    console.log(`         ${realStubs.length} stubs -> ${seen.size} distinct units, 0 mis-attributed`);
    const tableUnits = new Set(idx.units.filter((u) => /^Parser\.[A-Z_]+\[/.test(u)));
    if (tableUnits.size < 500) throw new Error(`only ${tableUnits.size} table-entry units`);
    console.log(`         ${tableUnits.size} distinct class-table entry units`);
  });

  t("14 real src/parser.js: ALL current stub-replacement pairs are conflict-free", () => {
    // The scaled-up version of case 4, on the real file rather than a fixture: build the
    // patch an agent would actually produce for EVERY stub, then check all ~72,000 pairs.
    // A single false positive here would serialise the whole stub queue.
    const readReal = (p) => (p === "src/parser.js" ? realSrc : null);
    const srcLines = realSrc.split("\n");
    const claims = realStubs.map((s) => {
      const from = /^\s*\/\//.test(srcLines[s.line - 2] ?? "") ? s.line - 1 : s.line;
      const body = [`@@ -${from},${s.line - from + 1} +${from},4 @@`];
      for (let k = from; k <= s.line; k++) body.push("-" + srcLines[k - 1]);
      body.push(`+  ${s.name}() {`, "+    return this._real();", "+  }");
      return { id: s.name, ...unitsForFiles([{ filename: "src/parser.js", status: "modified", patch: body.join("\n") }], readReal) };
    });
    for (const c of claims) {
      if (c.degraded.length) throw new Error(`${c.id} degraded: ${c.degraded[0]}`);
      if (c.units.size !== 1) throw new Error(`${c.id} claimed ${c.units.size} units: ${[...c.units]}`);
    }
    const conflicts = compare(claims);
    if (conflicts.length) {
      throw new Error(`${conflicts.length} FALSE POSITIVE(S), e.g. ${conflicts[0].a} <-> ${conflicts[0].b} on ${conflicts[0].shared}`);
    }
    const pairs = (claims.length * (claims.length - 1)) / 2;
    console.log(`         ${claims.length} stubs, ${pairs} pairs, 1 unit each, 0 conflicts`);
  });

  t("15 real src/parser.js: two agents on the SAME real stub -> flagged", () => {
    const readReal = (p) => (p === "src/parser.js" ? realSrc : null);
    const srcLines = realSrc.split("\n");
    const s = realStubs[Math.floor(realStubs.length / 2)];
    const mk = (ret) => {
      const body = [`@@ -${s.line},1 +${s.line},3 @@`, "-" + srcLines[s.line - 1],
        `+  ${s.name}() {`, `+    return ${ret};`, "+  }"];
      return { id: ret, ...unitsForFiles([{ filename: "src/parser.js", status: "modified", patch: body.join("\n") }], readReal) };
    };
    const c = compare([mk("a"), mk("b")]);
    eq(c.length, 1, `same stub ${s.name} must collide`);
    console.log(`         ${s.name} -> ${c[0].shared[0]}`);
  });

  console.log(`\n  ${n - fails.length}/${n} passed`);
  console.log(fails.length ? "\n  CLAIM OVERLAP SELFTEST: FAIL" : "\n  CLAIM OVERLAP SELFTEST: OK");
  process.exit(fails.length ? 1 : 0);
}
