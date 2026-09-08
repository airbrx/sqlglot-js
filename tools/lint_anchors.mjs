#!/usr/bin/env node
// Every `// py: <path>:<line>` anchor must point at the line that actually DEFINES the
// member it sits above.
//
//   node tools/lint_anchors.mjs [--ref /tmp/sqlglot-ref]
//
// WHY THIS EXISTS. R18 found `_parse_row` (src/parser.js, anchored `py:3759`) carrying
// an entirely unrelated body — it built an `exp.Row` that upstream never constructs and
// that exists in neither tree. The paragraph recording it ends: "A method whose body has
// nothing to do with its own `// py:` anchor is not detectable by any counter here; only
// reading the two side by side finds it."
//
// This is the cheap half of that check, and the half a machine can do: it cannot tell
// whether a BODY is a faithful transliteration (that is §8.5's human gate, and R1 is
// explicit that no lint can close it), but it can tell whether the anchor even names the
// right upstream member. An anchor that points at the wrong line makes the human gate
// strictly worse than useless, because the reviewer diffs against the wrong source.
//
// It also catches the cheaper, likelier failure: anchors drifting wholesale when the pin
// moves. Upstream churns ~85 LOC/day (§10), so every resync shifts line numbers, and
// 484 silently-wrong anchors in one file would be indistinguishable from 484 right ones.

import { readFileSync, existsSync } from "node:fs";

const argv = process.argv.slice(2);
const refIdx = argv.indexOf("--ref");
const REF = refIdx >= 0 ? argv[refIdx + 1] : process.env.SQLGLOT_REF || "/tmp/sqlglot-ref";

// Ported files that carry per-member anchors. A file with a `// py:` HEADER but no
// per-member anchors (helper.js, trie.js, ...) has nothing for this to check.
const FILES = [
  "src/generator.js",
  "src/parser.js",
  "src/parsers/snowflake.js",
  "src/parsers/hive.js",
  "src/parsers/spark2.js",
  "src/parsers/spark.js",
  "src/parsers/databricks.js",
  "src/parsers/postgres.js",
];

const ANCHOR = /^\s*\/\/ py: (sqlglot\/[A-Za-z0-9_/]+\.py):(\d+)\s*$/;
// `static get X()`, `static X =`, `name(...)`, `async name(...)`.
const MEMBER = /^\s*(?:static\s+)?(?:get\s+|set\s+|async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[({=]/;

const upstreamCache = new Map();
function upstreamLines(rel) {
  if (!upstreamCache.has(rel)) {
    const p = `${REF}/${rel}`;
    upstreamCache.set(rel, existsSync(p) ? readFileSync(p, "utf8").split("\n") : null);
  }
  return upstreamCache.get(rel);
}

let checked = 0;
const problems = [];

for (const file of FILES) {
  if (!existsSync(file)) continue;
  const lines = readFileSync(file, "utf8").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const a = ANCHOR.exec(lines[i]);
    if (!a) continue;
    const [, rel, lnStr] = a;
    const ln = Number(lnStr);

    // The member this anchor belongs to: the next line that declares one, skipping the
    // interleaved `// note:` lines the seeder emits for reserved-word renames.
    let name = null;
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      if (/^\s*\/\//.test(lines[j])) continue;
      const m = MEMBER.exec(lines[j]);
      if (m) name = m[1];
      break;
    }
    if (!name) continue; // a file-level or block-level anchor, not a member anchor

    const up = upstreamLines(rel);
    if (!up) {
      problems.push(`${file}:${i + 1}  anchor names ${rel}, which is not under ${REF}`);
      continue;
    }
    if (ln < 1 || ln > up.length) {
      problems.push(`${file}:${i + 1}  ${name} -> ${rel}:${ln} is past end of file (${up.length} lines)`);
      continue;
    }

    checked++;
    // JS `constructor` is Python's `__init__`; the port keeps every other name verbatim.
    const pyName = name === "constructor" ? "__init__" : name;
    const target = up[ln - 1];
    // The anchored line must MENTION the member — as `def name(`, or as a class-level
    // assignment `NAME: t.ClassVar = ...` / `NAME = ...`.
    const ok = new RegExp(`(^|[^A-Za-z0-9_])${pyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`).test(target);
    if (!ok) {
      problems.push(
        `${file}:${i + 1}  ${name} -> ${rel}:${ln}\n      upstream line is: ${target.trim().slice(0, 90)}`,
      );
    }
  }
}

if (problems.length) {
  console.error(`  ANCHOR LINT: ${problems.length} bad anchor(s) of ${checked + problems.length} checked`);
  for (const p of problems.slice(0, 30)) console.error(`    ${p}`);
  if (problems.length > 30) console.error(`    … and ${problems.length - 30} more`);
  process.exit(1);
}
console.log(`  ANCHOR LINT: ok (${checked} member anchors verified against ${REF})`);
