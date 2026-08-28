// PORT_PLAN.md §8.1 Rule 1 — claim-overlap check. §8.5 CI gate (6).
//
//   node tools/claim_overlap.mjs --all                 # every open PR, pairwise (batch preflight)
//   node tools/claim_overlap.mjs --pr 12               # PR 12 vs every other open PR
//   node tools/claim_overlap.mjs --branch              # current branch's diff vs every open PR
//   node tools/claim_overlap.mjs --patch a.diff --patch b.diff --base main   # offline
//   node tools/claim_overlap.mjs --selftest            # no network, no git; the negative tests
//   ... --json --verbose --strict --repo owner/name --skip-drafts --fail-open
//
// ENFORCEMENT STATUS, stated up front because the plan's wording invites the opposite
// reading: this script is ADVISORY. §8.1 calls claim checking "a required CI check";
// as of this commit `airbrx/sqlglot-js` has no workflows at all
// (`gh api repos/airbrx/sqlglot-js/actions/workflows` -> total_count 0) and `main` has no
// branch protection (`.../branches/main/protection` -> 404 Branch not protected). Nothing
// here can block a merge. `.github/workflows/claim-overlap.yml` runs it on PR open/sync,
// but until a repo admin adds a required-status-check rule that workflow is a red X
// somebody has to choose to look at. Treat this as a preflight you run before spawning a
// parallel batch, not as a gate.
//
// WHY NOT A CHANGED-FILE CHECK. Rule 1 says "changed-file overlap". Taken literally that
// is useless here and would actively defeat Rule 2: `src/parser.js` (3,847 lines, 382
// `NotPorted` stubs) and `src/generator_kernel.js` are DELIBERATELY multi-owner. Rule 2
// seeds every method as a one-line stub with its own `// py:` anchor and Rule 2' seeds
// every class table one entry per line, precisely so that two agents touching two
// different stubs produce non-adjacent hunks that git merges cleanly. A file-granular
// check flags that pair. So: this check is UNIT-granular for the method-owned files
// listed in `METHOD_GRANULAR` and file-granular everywhere else.
//
// A "unit" is one ownable region of a file:
//   Class#method          a method, including the JSDoc + `// py:` anchor block above it
//                         (a stub replacement rewrites those too, so they are one unit)
//   Class.TABLE[key]      one entry line of a class-level Map/Set literal (Rule 2'),
//                         keyed by the entry's own key so two additions to FUNCTIONS are
//                         two units -- including entries still commented out as
//                         `// py:377  ["COALESCE", ...]`, which is what an agent replaces
//   Class.TABLE$decl      the table's own `static X = new Map([` / closing `]);` lines
//   Class::header         the `class X extends Y {` line
//   <module>              everything outside the class body: imports, module constants
//   FILE <path>           the whole file (file-granular paths; new/deleted/renamed files;
//                         and any file we could not resolve -- see DEGRADED below)
//
// OVERLAP = the two PRs' unit sets intersect. Nothing else. Two PRs both touching
// `src/parser.js` do not overlap; two PRs both touching `Parser#_parse_ttl` do.
//
// HOW LINE NUMBERS ARE MADE COMPARABLE ACROSS PRs (the stale-base problem). They aren't,
// and the check never tries. Raw line numbers are meaningless across branches: if PR A
// replaces a 3-line stub at 2252 with a 30-line body, every unit below it shifts by 27 on
// A's head but not on B's. So each PR's hunks are resolved to unit NAMES against that
// PR's OWN merge-base blob, and only the names are compared. Names are base-independent.
// Concretely we resolve on the OLD side of the diff and fetch the blob at
// `compare(base...head).merge_base_commit.sha` -- not `pull.base.sha`, because GitHub's
// `/pulls/N/files` returns the three-dot diff, whose old-side line numbers are relative to
// the merge base. A PR on a stale base is therefore handled exactly like a fresh one; the
// only thing lost is the ADJACENCY warning below, which needs a shared base to mean
// anything.
//
// PURE INSERTIONS (a `+`-only hunk, e.g. adding one FUNCTIONS entry) have no old-side line
// of their own. They are attributed to the units on BOTH sides of the insertion point.
// Measured justification: `git merge-file` CONFLICTS for insert-before-L vs modify-L and
// for insert-before-L vs modify-L-1, and is CLEAN one line further out either way -- so
// "both neighbours" is exactly git's own rule here. Two insertions at the SAME point do
// merge cleanly, but git picks an arbitrary ORDER, and §4.6 establishes that table
// insertion order is visible in output SQL; that pair is reported as an overlap on
// purpose, and it is a semantic hazard git will never report, not a textual one.
//
// ADJACENCY is a separate, weaker signal -- see `adjacency()`. Two DIFFERENT units with
// nothing between them still conflict textually; that is a warning, not a failure.
//
// DEGRADED resolution widens to whole-file and is always printed, never silent: GitHub
// omits `patch` for very large file diffs, and added/deleted/renamed files have no
// meaningful base blob. Widening can only produce false POSITIVES, never false negatives.
//
// DRAFT PRs ARE INCLUDED by default. A draft is an agent actively working in a branch,
// which is precisely the claim this check exists to see; excluding them would make the
// check blind during the window it matters most. `--skip-drafts` opts out.
//
// The PR being checked is dropped from the open-PR list before comparison, or it would
// collide with itself on every unit. Same for `--branch` when the current branch already
// has an open PR.
//
// PAGINATION: `/pulls/N/files` defaults to 30 per page, and this repo's own PR #6 changed
// 43 files; every list call uses `--paginate` with `per_page=100`. GitHub still hard-caps
// that endpoint at 3000 files, which no PR here approaches — but if one ever does, the
// missing files are silently absent from the claim, so `nFiles` is printed for every PR.
//
// EXIT CODES  0 no overlap   1 overlap found   2 indeterminate (network/auth/API)
//             3 usage error
// Exit 2 is NOT a pass. `--fail-open` turns it into 0 while still printing the banner,
// for the case where you would rather not wedge a batch on a GitHub outage.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

// ---------------------------------------------------------------------------- args

const argv = process.argv.slice(2);
const has = (n) => argv.includes("--" + n);
const opt = (n, d) => {
  const i = argv.indexOf("--" + n);
  return i === -1 ? d : argv[i + 1];
};
const all = (n) =>
  argv.reduce((acc, a, i) => (a === "--" + n ? (acc.push(argv[i + 1]), acc) : acc), []);

const JSON_OUT = has("json");
const VERBOSE = has("verbose");
const FAIL_OPEN = has("fail-open");
const SKIP_DRAFTS = has("skip-drafts");
const STRICT = has("strict");
const REPO = opt("repo", "airbrx/sqlglot-js");

// Paths whose units are methods/table-entries rather than the whole file. Everything not
// matched here is file-granular, which is the safe default: a file nobody deliberately
// made multi-owner has exactly one owner (Rule 1 as literally written).
// `**` matches across `/`, `*` does not.
const METHOD_GRANULAR = (opt("method-granular", "") || [
  "src/parser.js",
  "src/generator.js",
  "src/generator_kernel.js",
  "src/parsers/**.js",
  "src/generators/**.js",
].join(",")).split(",").filter(Boolean);

// Single pass, no sentinel character. The first draft did `**` -> a placeholder byte ->
// `.*`, which `tools/lint_control_bytes.mjs` correctly rejected, and which would have
// mis-compiled any glob that happened to contain the placeholder anyway.
export function globMatch(glob, s) {
  let rx = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { rx += ".*"; i += 1; } else rx += "[^/]*";
    } else if (".+^${}()|[]\\?/".includes(c)) {
      rx += "\\" + c;
    } else {
      rx += c;
    }
  }
  return new RegExp("^" + rx + "$").test(s);
}
const isMethodGranular = (p) => METHOD_GRANULAR.some((g) => globMatch(g, p));

// ---------------------------------------------------------------------- unit indexer

const indentOf = (l) => l.length - l.replace(/^ +/, "").length;
const CTRL_KW = /^(if|for|while|switch|catch|do|else|return|function|try|finally)\b/;

/**
 * Map every 1-based line of a JS source file to the name of the unit that owns it.
 * Indentation-driven on purpose: brace counting needs a real lexer to survive `"{"` in a
 * string or a regex literal, and this codebase is machine-seeded at a rigid 2-space
 * indent (members at 2, bodies at >=4), so indentation is both simpler and more robust.
 * @param {string} text
 * @returns {{unitAt:(line:number)=>string, units:string[]}}
 */
export function indexUnits(text) {
  const lines = text.split("\n");
  const owner = new Array(lines.length + 2).fill("<module>");
  const methods = []; // for the duplicate-name pass below
  let cls = null;
  let i = 0;

  const claim = (from, to, name) => {
    for (let k = from; k <= to && k <= lines.length; k++) owner[k] = name; // 1-based
  };
  // A stub replacement rewrites the `/** */` + `// py:` block above the method too, so
  // that block belongs to the method, not to whatever precedes it.
  const backExtend = (start) => {
    let s = start;
    while (s - 1 >= 1) {
      const p = lines[s - 2];
      if (/^\s*(\/\*\*|\*|\*\/|\/\/)/.test(p) && p.trim() !== "") s -= 1;
      else break;
    }
    return s;
  };
  // End of a 2-space member: consume body lines (indent >= 4 or blank) plus a final
  // closing line back at indent 2. `pad` additionally swallows the blank line(s) that
  // separate this member from the next, so the gap belongs to the member above rather
  // than to a global bucket every member's neighbours would then share.
  const memberEnd = (start) => {
    let j = start; // 1-based
    let lastReal = start;
    while (j < lines.length) {
      const nxt = lines[j]; // line j+1
      if (nxt.trim() === "") { j += 1; continue; }
      const ind = indentOf(nxt);
      if (ind >= 4) { j += 1; lastReal = j; continue; }
      if (ind === 2 && /^\s*[}\])]+\s*[);,]*\s*;?\s*$/.test(nxt)) { j += 1; lastReal = j; }
      break;
    }
    let pad = lastReal;
    while (pad < lines.length && lines[pad].trim() === "") pad += 1;
    return { end: lastReal, pad };
  };

  while (i < lines.length) {
    const n = i + 1; // 1-based line number
    const line = lines[i];
    const trimmed = line.trim();
    const ind = indentOf(line);

    let m;
    if (ind === 0 && (m = /^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(trimmed))) {
      cls = m[1];
      owner[n] = `${cls}::header`;
      i += 1;
      continue;
    }
    if (ind === 0 && trimmed === "}" && cls) { owner[n] = `${cls}::header`; cls = null; i += 1; continue; }

    if (cls && ind === 2) {
      // class-level table: `static NAME = new Map([` / `new Set([` / `setDiff(` / `[`
      if ((m = /^static\s+([A-Za-z_$][\w$]*)\s*=/.exec(trimmed))) {
        const name = m[1];
        const { end, pad } = memberEnd(n);
        if (end > n) {
          // Multi-line literal: each interior line is its own ownable entry (Rule 2').
          claim(n, pad, `${cls}.${name}$decl`);
          for (let k = n + 1; k < end; k++) {
            const t = (lines[k - 1] ?? "").trim();
            if (t === "") continue;
            owner[k] = `${cls}.${name}[${tableKey(t)}]`;
          }
          owner[end] = `${cls}.${name}$decl`;
        } else {
          claim(backExtend(n), pad, `${cls}.${name}`);
        }
        i = pad;
        continue;
      }
      // method: `name(args) {`, `static name(`, `async name(`, `get name(`, `#name(`
      if (!CTRL_KW.test(trimmed)
        && (m = /^(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(\*?\s*[#A-Za-z_$][\w$]*)\s*\(/.exec(trimmed))) {
        const name = m[1].replace(/^\*\s*/, "");
        const { end, pad } = memberEnd(n);
        const from = backExtend(n);
        claim(from, pad, `${cls}#${name}`);
        methods.push({ key: `${cls}#${name}`, from, to: pad, sig: n });
        i = pad;
        continue;
      }
    }
    i += 1;
  }

  // Method NAMES are not unique. PORT_PLAN.md §8.1 Rule 2 proposes `parser.js#_parse_x`
  // as the claim key, but the seeder emitted Python `@t.overload` type-only declarations
  // as real JS methods, so `src/parser.js` currently defines `_parse_query_modifiers`
  // three times (2671/2676/2681) and `_parse_json_object` three times. Collapsing them to
  // one unit would make two agents editing two different regions look like a collision.
  // Disambiguate with the region's own `// py:` anchor, which is unique and — unlike an
  // ordinal — does not shift when a neighbour is added.
  const byName = new Map();
  for (const mm of methods) byName.set(mm.key, (byName.get(mm.key) ?? 0) + 1);
  for (const mm of methods) {
    if (byName.get(mm.key) < 2) continue;
    let anchor = null;
    for (let k = mm.from; k <= mm.to && !anchor; k++) {
      const a = /\/\/\s*py:\s*(\S+)/.exec(lines[k - 1] ?? "");
      if (a) anchor = a[1];
    }
    claim(mm.from, mm.to, `${mm.key}@${anchor ?? `L${mm.sig}`}`);
  }

  return {
    unitAt: (l) => owner[Math.max(1, Math.min(l, lines.length))] ?? "<module>",
    units: [...new Set(owner.slice(1))],
  };
}

/** Key for one entry line of a class table -- including still-commented seed lines. */
function tableKey(t) {
  let s = t;
  const c = /^\/\/\s*py:\d+\s+(.*)$/.exec(s); // `// py:377  ["COALESCE", ...],`
  if (c) s = c[1];
  let m;
  if ((m = /^\[\s*(["'`])((?:\\.|(?!\1).)*)\1/.exec(s))) return m[2];      // ["KEY", v]
  if ((m = /^(["'`])((?:\\.|(?!\1).)*)\1\s*:/.exec(s))) return m[2];        // "KEY": v
  if ((m = /^(TokenType\.[A-Z0-9_]+|exp\.[A-Za-z0-9_]+)/.exec(s))) return m[1];
  if ((m = /^([A-Za-z_$][\w$.]*)\s*[,:]/.exec(s))) return m[1];
  // Fall back to the line's own text: base-independent, so it still compares correctly
  // between two PRs sitting on different bases. Ordinals would not.
  return "~" + s.replace(/\s+/g, " ").slice(0, 60);
}

// --------------------------------------------------------------------- patch parsing

/**
 * Old-side line numbers touched by a unified-diff body, plus insertion points.
 * @returns {{touched:number[], insertAt:number[]}} 1-based old-side lines; insertion
 *   points are the old-side line a `+`-run lands before.
 */
export function hunkOldLines(patch) {
  const touched = [];
  const insertAt = [];
  let oldLine = 0;
  let pendingPlus = false;
  // A `+` run directly after a `-` run is the second half of a REPLACEMENT: those old
  // lines are already in `touched`, and recording an insertion point as well would
  // wrongly attribute the change to whatever unit follows the replaced block. That bug
  // made every stub replacement also claim its next-door neighbour — i.e. it flagged
  // exactly the pair §8.1 Rule 2 exists to keep safe. Only a `+` run bounded by context
  // is a true insertion.
  let afterMinus = false;
  for (const raw of patch.split("\n")) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (h) { oldLine = Number(h[1]); pendingPlus = false; afterMinus = false; continue; }
    if (oldLine === 0) continue;              // preamble before the first hunk
    if (raw.startsWith("\\")) continue;       // "\ No newline at end of file"
    const c = raw[0];
    if (c === "+") {
      if (!pendingPlus && !afterMinus) insertAt.push(oldLine);
      pendingPlus = true;
    } else if (c === "-") {
      touched.push(oldLine);
      oldLine += 1;
      pendingPlus = false;
      afterMinus = true;
    } else if (c === " " || raw === "") {
      oldLine += 1;
      pendingPlus = false;
      afterMinus = false;
    }
  }
  return { touched, insertAt };
}

/** Split a full `git diff` / `gh pr diff` into per-file patch bodies. */
export function splitGitDiff(text) {
  const out = [];
  let cur = null;
  for (const line of text.split("\n")) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { filename: m[2], previous_filename: m[1] !== m[2] ? m[1] : undefined, patch: "", status: "modified" };
      continue;
    }
    if (!cur) continue;
    if (/^new file mode/.test(line)) cur.status = "added";
    else if (/^deleted file mode/.test(line)) cur.status = "removed";
    else if (/^rename from /.test(line)) cur.status = "renamed";
    else if (/^Binary files /.test(line)) cur.binary = true;
    else if (/^(index |--- |\+\+\+ |similarity |rename to |old mode|new mode)/.test(line)) continue;
    else if (line.startsWith("@@") || cur.patch) cur.patch += (cur.patch ? "\n" : "") + line;
  }
  if (cur) out.push(cur);
  return out;
}

// --------------------------------------------------------------------- unit extraction

/**
 * @param {{filename:string,status:string,patch?:string,previous_filename?:string}[]} files
 * @param {(path:string)=>string|null} readBase  base-side blob, or null if unavailable
 * @returns {{units:Set<string>, degraded:string[]}}
 */
export function unitsForFiles(files, readBase) {
  const units = new Set();
  const degraded = [];
  const pos = new Map(); // filename -> doubled old-side positions, for adjacency()
  const widen = (f, why) => { units.add(`FILE ${f.filename}`); degraded.push(`${f.filename}: ${why}`); };

  for (const f of files) {
    if (f.previous_filename) units.add(`FILE ${f.previous_filename}`);
    if (!isMethodGranular(f.filename)) { units.add(`FILE ${f.filename}`); continue; }
    if (f.status !== "modified" && f.status !== "changed") { widen(f, `status=${f.status}`); continue; }
    if (!f.patch) { widen(f, "no patch (GitHub omits it for very large diffs)"); continue; }
    let base;
    try { base = readBase(f.filename); } catch { base = null; }
    if (base == null) { widen(f, "base blob unavailable"); continue; }

    const idx = indexUnits(base);
    const { touched, insertAt } = hunkOldLines(f.patch);
    const p = pos.get(f.filename) ?? (pos.set(f.filename, []), pos.get(f.filename));
    for (const l of touched) { units.add(`${f.filename}:${idx.unitAt(l)}`); p.push(2 * l); }
    for (const l of insertAt) {
      // Both neighbours -- see the PURE INSERTIONS note in the header.
      units.add(`${f.filename}:${idx.unitAt(l - 1)}`);
      units.add(`${f.filename}:${idx.unitAt(l)}`);
      p.push(2 * l - 1); // an insertion sits BETWEEN old lines l-1 and l
    }
    if (!touched.length && !insertAt.length) widen(f, "patch had no hunks");
  }
  return { units, degraded, pos };
}

// Two changes in DIFFERENT units can still be a textual conflict when nothing separates
// them. Measured on this repo's own src/parser.js with `git merge-file` (git 2.50.1),
// which is the same xdiff merge `git rebase` uses:
//
//   edits to lines 131 and 132 (0 unchanged lines between)  -> CONFLICT
//   edits to lines 131 and 133 (1 unchanged line  between)  -> CLEAN
//   ... 134, 135, 136, 137                                  -> CLEAN
//
// So the real threshold is ZERO separating lines, not the 3 lines of diff CONTEXT one
// would guess. On the doubled axis (line l -> 2l, insertion-before-l -> 2l-1) that is a
// distance of <= 2. This is reported as a WARNING, not a failure: the two agents own
// different units, the merge conflict is a one-line rebase fixup, and failing here would
// re-serialise exactly the queue Rule 2' exists to parallelise. `--strict` makes it fail.
//
// Known imprecision, in the safe direction: two INSERTIONS one line apart warn but
// actually merge cleanly. Left in deliberately -- for the order-observable tables of
// Rule 2' (§4.6: insertion order is visible in output SQL) git merging both additions in
// an unspecified order is a hazard it will never report, so a warning there is wanted.
export function adjacency(claims) {
  const out = [];
  for (let a = 0; a < claims.length; a++) {
    for (let b = a + 1; b < claims.length; b++) {
      const A = claims[a], B = claims[b];
      // Line numbers are only comparable when both claims resolved against the SAME
      // blob. On differing bases we compare unit NAMES only and say so.
      if (!A.base || !B.base || A.base !== B.base) continue;
      const hits = [];
      for (const [file, pa] of A.pos ?? []) {
        const pb = B.pos?.get(file);
        if (!pb) continue;
        for (const x of pa) for (const y of pb) {
          if (Math.abs(x - y) <= 2 && x !== y) hits.push(`${file} old lines ~${Math.ceil(x / 2)} / ~${Math.ceil(y / 2)}`);
        }
      }
      if (hits.length) out.push({ a: A.id, b: B.id, hits: [...new Set(hits)].sort() });
    }
  }
  return out;
}

// ------------------------------------------------------------------------ gh plumbing

class Indeterminate extends Error {}

function gh(args) {
  try {
    return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    const msg = (e.stderr || e.message || "").toString().trim().split("\n").slice(0, 4).join("\n  ");
    throw new Indeterminate(`gh ${args.slice(0, 3).join(" ")} failed: ${msg}`);
  }
}

function ghJson(args) {
  const raw = gh(args);
  try { return JSON.parse(raw); } catch { throw new Indeterminate(`gh returned non-JSON for: gh ${args.join(" ")}`); }
}

const blobCache = new Map();
function ghBlob(sha, path) {
  const key = `${sha}:${path}`;
  if (blobCache.has(key)) return blobCache.get(key);
  let v = null;
  try {
    v = gh(["api", "-H", "Accept: application/vnd.github.raw",
      `repos/${REPO}/contents/${encodeURI(path)}?ref=${sha}`]);
  } catch { v = null; } // 404 for a file that did not exist at the merge base
  blobCache.set(key, v);
  return v;
}

/** One open/named PR -> its unit set. */
function loadPr(num) {
  const pr = ghJson(["api", `repos/${REPO}/pulls/${num}`]);
  // `/pulls/N/files` is the THREE-DOT diff: old-side lines are relative to the merge base,
  // not to pull.base.sha. Resolving against the wrong blob silently mis-attributes units.
  let mergeBase = pr.base.sha;
  try {
    mergeBase = ghJson(["api", `repos/${REPO}/compare/${pr.base.sha}...${pr.head.sha}`])
      .merge_base_commit.sha;
  } catch { /* fall back to base.sha; recorded below */ }
  // --paginate: the default page size is 30, and P3's own PR #6 changed more than that.
  const files = ghJson(["api", "--paginate", `repos/${REPO}/pulls/${num}/files?per_page=100`]);
  if (!Array.isArray(files)) throw new Indeterminate(`unexpected /files payload for PR ${num}`);
  const { units, degraded, pos } = unitsForFiles(files, (p) => ghBlob(mergeBase, p));
  return {
    id: `PR #${num}`, num, title: pr.title, draft: !!pr.draft, head: pr.head.ref,
    base: mergeBase, nFiles: files.length, units, degraded, pos,
  };
}

// ------------------------------------------------------------------------- comparison

function compare(claims) {
  const conflicts = [];
  for (let a = 0; a < claims.length; a++) {
    for (let b = a + 1; b < claims.length; b++) {
      const shared = [...claims[a].units].filter((u) => claims[b].units.has(u));
      if (shared.length) conflicts.push({ a: claims[a].id, b: claims[b].id, shared: shared.sort() });
    }
  }
  return conflicts;
}

// ------------------------------------------------------------------------------ main

function usage(msg) {
  console.error(msg ? `claim_overlap: ${msg}\n` : "");
  console.error(fs.readFileSync(new URL(import.meta.url), "utf8")
    .split("\n").filter((l) => l.startsWith("//")).slice(0, 9).join("\n"));
  process.exit(3);
}

function report(claims, conflicts) {
  const adj = adjacency(claims);
  const bases = new Set(claims.map((c) => c.base).filter(Boolean));
  const mixedBase = bases.size > 1;
  if (JSON_OUT) {
    console.log(JSON.stringify({
      repo: REPO, advisory: true, strict: STRICT, mixedBase,
      claims: claims.map((c) => ({ ...c, units: [...c.units].sort(), pos: undefined })),
      conflicts, adjacent: adj,
    }, null, 2));
  } else {
    console.log("claim-overlap check (PORT_PLAN.md §8.1 Rule 1)  —  ADVISORY, not an enforced gate\n");
    for (const c of claims) {
      console.log(`  ${c.id.padEnd(12)} ${c.units.size} unit(s)`
        + (c.nFiles != null ? ` across ${c.nFiles} file(s)` : "")
        + (c.draft ? "  [draft]" : "")
        + (c.title ? `  ${c.title.slice(0, 60)}` : ""));
      if (c.degraded?.length) {
        for (const d of c.degraded) console.log(`      DEGRADED to whole-file — ${d}`);
      }
      if (VERBOSE) for (const u of [...c.units].sort()) console.log(`        ${u}`);
    }
    if (conflicts.length) {
      console.log(`\n  ${conflicts.length} OVERLAP(S) — same unit claimed twice:`);
      for (const k of conflicts) {
        console.log(`    ${k.a}  <->  ${k.b}   ${k.shared.length} shared unit(s)`);
        for (const u of k.shared.slice(0, 12)) console.log(`        ${u}`);
        if (k.shared.length > 12) console.log(`        ... and ${k.shared.length - 12} more`);
      }
    }
    if (adj.length) {
      console.log(`\n  ${adj.length} ADJACENCY WARNING(S) — different units, but nothing`
        + `\n  separates the edits, so git will raise a (one-line) rebase conflict:`);
      for (const k of adj) {
        console.log(`    ${k.a}  <->  ${k.b}`);
        for (const h of k.hits.slice(0, 8)) console.log(`        ${h}`);
        if (k.hits.length > 8) console.log(`        ... and ${k.hits.length - 8} more`);
      }
      if (!STRICT) console.log("    (warning only — pass --strict to fail on these)");
    }
    if (mixedBase) {
      console.log("\n  NOTE: claims resolved against different merge bases. Unit names are"
        + "\n  base-independent and were compared; line adjacency was NOT checked for pairs"
        + "\n  on differing bases, so an adjacency warning may be missing.");
    }
    if (!conflicts.length && !adj.length) console.log("\n  no shared units");
    console.log(conflicts.length || (STRICT && adj.length) ? "\n  CLAIM OVERLAP: FAIL" : "\n  CLAIM OVERLAP: OK");
  }
  process.exit(conflicts.length || (STRICT && adj.length) ? 1 : 0);
}

function indeterminate(err) {
  const banner = [
    "",
    "  ############################################################",
    "  #  CLAIM OVERLAP: INDETERMINATE — THIS IS NOT A PASS       #",
    "  ############################################################",
    `  ${err.message}`,
    "  Nothing was checked. Two agents may be about to edit the same method.",
  ].join("\n");
  if (JSON_OUT) console.log(JSON.stringify({ repo: REPO, advisory: true, indeterminate: err.message, failOpen: FAIL_OPEN }, null, 2));
  else console.log(banner + (FAIL_OPEN ? "\n  --fail-open given: exiting 0 anyway.\n" : "\n"));
  process.exit(FAIL_OPEN ? 0 : 2);
}

async function main() {
  if (has("selftest")) {
    return (await import("./claim_overlap_selftest.mjs"))
      .run({ indexUnits, hunkOldLines, splitGitDiff, unitsForFiles, compare, adjacency, globMatch });
  }
  if (has("help") || has("h")) usage("");

  const patches = all("patch");
  const claims = [];

  try {
    if (patches.length) {
      // Offline mode: local patch files resolved against local git revs. No network.
      // `--base` may be repeated and is paired with `--patch` by position, so a patch cut
      // against a stale base still resolves against ITS OWN base — the same per-PR
      // merge-base rule the gh path uses. Unpaired patches fall back to the last --base.
      const bases = all("base");
      const readAt = (rev) => (p) => {
        try { return execFileSync("git", ["show", `${rev}:${p}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); }
        catch { return null; }
      };
      patches.forEach((p, k) => {
        const rev = bases[k] ?? bases[bases.length - 1] ?? "HEAD";
        const files = splitGitDiff(fs.readFileSync(p, "utf8"));
        let sha = null;
        try { sha = execFileSync("git", ["rev-parse", rev], { encoding: "utf8" }).trim(); } catch { /* not a git rev */ }
        const { units, degraded, pos } = unitsForFiles(files, readAt(rev));
        claims.push({ id: p, base: sha, baseRev: rev, nFiles: files.length, units, degraded, pos });
      });
    } else {
      const explicit = all("pr").map(Number);
      let open = ghJson(["api", "--paginate", `repos/${REPO}/pulls?state=open&per_page=100`]);
      if (!Array.isArray(open)) throw new Indeterminate("unexpected /pulls payload");
      if (SKIP_DRAFTS) open = open.filter((p) => !p.draft);
      let nums = open.map((p) => p.number);

      if (has("branch")) {
        const head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
        const baseRev = opt("base", "origin/main");
        // The current branch may already HAVE an open PR; that PR is this same work, so
        // drop it or every run self-conflicts.
        const selfPr = open.find((p) => p.head.ref === head);
        if (selfPr) nums = nums.filter((n) => n !== selfPr.number);
        let diff = "";
        try { diff = execFileSync("git", ["diff", `${baseRev}...HEAD`], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }); }
        catch (e) { throw new Indeterminate(`git diff ${baseRev}...HEAD failed: ${e.message}`); }
        const files = splitGitDiff(diff);
        const mb = execFileSync("git", ["merge-base", baseRev, "HEAD"], { encoding: "utf8" }).trim();
        const { units, degraded, pos } = unitsForFiles(files, (p) => {
          try { return execFileSync("git", ["show", `${mb}:${p}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); }
          catch { return null; }
        });
        claims.push({ id: `local ${head}`, base: mb, nFiles: files.length, units, degraded, pos });
      } else if (explicit.length) {
        // The PR under test appears in the open list too; comparing it with itself is a
        // guaranteed self-overlap. Drop it, then compare against the rest.
        nums = nums.filter((n) => !explicit.includes(n));
        for (const n of explicit) claims.push(loadPr(n));
      } else if (!has("all")) {
        usage("give one of --all, --pr N, --branch, or --patch FILE");
      }
      for (const n of nums) claims.push(loadPr(n));
    }
  } catch (e) {
    if (e instanceof Indeterminate) return indeterminate(e);
    throw e;
  }

  if (claims.length < 2) {
    // Say this out loud. "0 open PRs, therefore no conflicts" is true and useless, and
    // reading it as a green gate is exactly the overclaim this file is trying to avoid.
    const msg = `only ${claims.length} claim(s) to compare — nothing to overlap with`;
    if (JSON_OUT) console.log(JSON.stringify({ repo: REPO, advisory: true, claims: claims.map((c) => ({ ...c, units: [...c.units].sort() })), conflicts: [], note: msg }, null, 2));
    else {
      console.log("claim-overlap check (PORT_PLAN.md §8.1 Rule 1)  —  ADVISORY, not an enforced gate\n");
      for (const c of claims) console.log(`  ${c.id.padEnd(12)} ${c.units.size} unit(s)`);
      console.log(`\n  ${msg}\n  CLAIM OVERLAP: OK (vacuous)`);
    }
    process.exit(0);
  }
  report(claims, compare(claims));
}

await main();
