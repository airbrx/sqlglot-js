// PORT_PLAN.md §5.3 / §8.5 CI gate 9: attribution must stay truthful as the pin moves.
//
// Checks:
//   1. LICENSE-sqlglot exists and carries upstream's MIT notice
//   2. NOTICE exists, names sqlglot, and states a pinned commit
//   3. the commit in NOTICE matches UPSTREAM.txt  <- the one that rots silently
//   4. README links the attribution files
//
//   node tools/lint_license.mjs

import { readFileSync, existsSync } from "node:fs";

const problems = [];
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);

const licenseSqlglot = read("LICENSE-sqlglot");
const notice = read("NOTICE");
const upstream = read("UPSTREAM.txt");
const readme = read("README.md");

if (!licenseSqlglot) {
  problems.push("LICENSE-sqlglot is missing (MIT requires the upstream notice in all copies)");
} else {
  if (!/MIT License/i.test(licenseSqlglot)) problems.push("LICENSE-sqlglot: no 'MIT License' header");
  if (!/Toby Mao/.test(licenseSqlglot)) {
    problems.push("LICENSE-sqlglot: missing upstream copyright holder");
  }
}

if (!upstream) problems.push("UPSTREAM.txt is missing");
if (!notice) problems.push("NOTICE is missing");

let upstreamCommit = null;
if (upstream) {
  const m = /^commit:\s*([0-9a-f]{7,40})\s*$/m.exec(upstream);
  if (!m) problems.push("UPSTREAM.txt: no `commit: <sha>` line");
  else upstreamCommit = m[1];
}

let noticeCommit = null;
if (notice) {
  if (!/sqlglot/i.test(notice)) problems.push("NOTICE: does not mention sqlglot");
  if (!/Toby Mao/.test(notice)) problems.push("NOTICE: missing upstream copyright holder");
  if (!/corpus/i.test(notice)) {
    problems.push("NOTICE: must state that the redistributed corpus is covered (§5.3)");
  }
  const m = /([0-9a-f]{7,40})/.exec(notice.split(/pinned at time of initial port:/i)[1] ?? "");
  if (!m) problems.push("NOTICE: no pinned upstream commit recorded");
  else noticeCommit = m[1];
}

if (upstreamCommit && noticeCommit) {
  const a = upstreamCommit.slice(0, Math.min(upstreamCommit.length, noticeCommit.length));
  const b = noticeCommit.slice(0, Math.min(upstreamCommit.length, noticeCommit.length));
  if (a !== b) {
    problems.push(
      `NOTICE commit (${noticeCommit}) does not match UPSTREAM.txt (${upstreamCommit})`,
    );
  }
}

if (readme) {
  for (const needle of ["NOTICE", "LICENSE-sqlglot", "sqlglot"]) {
    if (!readme.includes(needle)) problems.push(`README.md: missing reference to ${needle}`);
  }
} else {
  problems.push("README.md is missing");
}

if (problems.length) {
  console.error("  LICENSE LINT: FAIL");
  for (const p of problems) console.error(`    - ${p}`);
  process.exit(1);
}
console.log(`  LICENSE LINT: ok (upstream pin ${upstreamCommit})`);
