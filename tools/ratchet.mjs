// The ratchet — PORT_PLAN.md §3.3.
//
// Four states per atom: pass, todo, wontfix, quarantine. Five rules:
//
//   1. An atom listed `pass` that FAILS            -> build failure.
//   2. An atom listed `todo`/`wontfix` that PASSES -> build failure (prevents rot).
//   3. `todo` may only shrink for in-scope dialects.
//   4. On resync, atoms whose `input_id` is NEW may enter `quarantine`.
//   5. An atom whose `input_id` is KNOWN but whose `expect_hash` CHANGED may never be
//      quarantined. It hard-fails and needs a human decision in UPSTREAM-NOTES.md.
//
// Rule 5 is the F1 fix and the reason this file exists as its own module with its own
// tests. Without the known-input/changed-expectation split, quarantine silently absorbs
// changed expectations and the dashboard goes vacuously green — the single most
// dangerous failure mode available to this design.
//
//   node tools/ratchet.mjs --selftest

import { readFileSync, existsSync, writeFileSync } from "node:fs";

/**
 * The key rule 5 compares on.
 *
 * §3.2 defines `input_id = H(sql, read, write, pretty, identify)` and assumes it
 * determines the expectation. Measured on the real corpus it does not, for exactly 10
 * inputs: `validate_all` asserts the SAME (sql, read, write, flags) both as an
 * `UnsupportedError` sentinel (generated under `ErrorLevel.RAISE`) and as a concrete
 * string (generated under `IGNORE`). `unsupported_level` is therefore part of the
 * INPUT, not the expectation, and `input_id` alone is not a key.
 *
 * `expected === null` is the sentinel marker already carried in the corpus, so the
 * effective key can be recovered without re-harvesting. `tools/check_corpus.mjs`
 * asserts there are no other conflicts.
 */
export function inputKey(atom) {
  return atom.expected === null ? `${atom.input_id}!raises` : atom.input_id;
}

export const PASS = "pass";
export const TODO = "todo";
export const WONTFIX = "wontfix";
export const QUARANTINE = "quarantine";

/** Load ratchet state. Anything not listed is implicitly `todo`. */
export function loadRatchet(path) {
  if (!existsSync(path)) {
    return { corpus_atoms: 0, pass: [], wontfix: {}, quarantine: {}, baseline: {} };
  }
  const r = JSON.parse(readFileSync(path, "utf8"));
  return {
    corpus_atoms: r.corpus_atoms ?? 0,
    pass: r.pass ?? [],
    wontfix: r.wontfix ?? {},
    quarantine: r.quarantine ?? {},
    // input_id -> expect_hash from the last ACCEPTED harvest. Rule 5 compares against it.
    baseline: r.baseline ?? {},
  };
}

export function saveRatchet(path, state) {
  const out = {
    corpus_atoms: state.corpus_atoms,
    pass: [...state.pass].sort(),
    wontfix: state.wontfix,
    quarantine: state.quarantine,
    baseline: state.baseline,
  };
  writeFileSync(path, JSON.stringify(out, null, 1) + "\n");
}

/** State of one atom under the ratchet. */
export function stateOf(ratchet, atomId, passSet) {
  if ((passSet ?? new Set(ratchet.pass)).has(atomId)) return PASS;
  if (atomId in ratchet.wontfix) return WONTFIX;
  if (atomId in ratchet.quarantine) return QUARANTINE;
  return TODO;
}

/**
 * Rules 1 and 2. `results` maps atom_id -> boolean (did it pass this run).
 * Atoms absent from `results` were not executed and are ignored.
 *
 * @returns {{ok: boolean, regressions: string[], rot: string[], counts: object}}
 */
export function check(ratchet, results) {
  const passSet = new Set(ratchet.pass);
  const regressions = [];
  const rot = [];
  const counts = { pass: 0, todo: 0, wontfix: 0, quarantine: 0 };

  for (const [atomId, didPass] of results) {
    const st = stateOf(ratchet, atomId, passSet);
    counts[st] += 1;
    if (st === PASS && !didPass) regressions.push(atomId); // rule 1
    // rule 2 — quarantine is explicitly exempt: it means "not yet triaged", so an
    // atom passing there is expected, not rot.
    if ((st === TODO || st === WONTFIX) && didPass) rot.push(atomId);
  }

  return {
    ok: regressions.length === 0 && rot.length === 0,
    regressions,
    rot,
    counts,
  };
}

/**
 * Rules 4 and 5 — classify a NEW corpus against the accepted baseline.
 *
 * @param {object} ratchet
 * @param {Array<{atom_id:string, input_id:string, expect_hash:string}>} atoms
 * @returns {{fresh: string[], changed: object[], unchanged: string[], removed: string[]}}
 */
export function resync(ratchet, atoms) {
  const baseline = ratchet.baseline;
  const fresh = [];
  const changed = [];
  const unchanged = [];
  const seenInputs = new Set();

  for (const a of atoms) {
    const key = inputKey(a);
    seenInputs.add(key);
    const known = baseline[key];
    if (known === undefined) {
      fresh.push(a.atom_id); // rule 4: may enter quarantine
    } else if (known !== a.expect_hash) {
      // rule 5: KNOWN input, CHANGED expectation. Never quarantinable.
      changed.push({ atom_id: a.atom_id, input_id: key, was: known, now: a.expect_hash });
    } else {
      unchanged.push(a.atom_id);
    }
  }

  const removed = Object.keys(baseline).filter((i) => !seenInputs.has(i));
  return { fresh, changed, unchanged, removed };
}

/**
 * Rule 3 — `todo` may only shrink for in-scope dialects.
 * @returns {{ok: boolean, grew: string[]}}
 */
export function checkTodoMonotonic(prevTodoInScope, nextTodoInScope) {
  const prev = new Set(prevTodoInScope);
  const grew = [...nextTodoInScope].filter((a) => !prev.has(a));
  return { ok: grew.length === 0, grew };
}

/* --------------------------------------------------------------------------- *
 * self-test — the rules are verifiable without the JS library existing          *
 * --------------------------------------------------------------------------- */

function selftest() {
  const checks = [];
  const t = (name, cond) => checks.push({ name, ok: !!cond });

  const R = {
    corpus_atoms: 4,
    pass: ["a1"],
    wontfix: { a3: "upstream bug" },
    quarantine: { a4: "new at resync" },
    baseline: { i1: "h1", i2: "h2", a3i: "h3" },
  };

  // ---- states
  t("listed pass is pass", stateOf(R, "a1") === PASS);
  t("listed wontfix is wontfix", stateOf(R, "a3") === WONTFIX);
  t("listed quarantine is quarantine", stateOf(R, "a4") === QUARANTINE);
  t("unlisted is todo", stateOf(R, "a2") === TODO);

  // ---- rule 1: a passing atom that fails is a regression
  let r = check(R, new Map([["a1", false]]));
  t("rule 1 catches regression", !r.ok && r.regressions.includes("a1"));
  r = check(R, new Map([["a1", true]]));
  t("rule 1 clean when pass stays passing", r.ok);

  // ---- rule 2: a todo/wontfix atom that passes is rot
  r = check(R, new Map([["a2", true]]));
  t("rule 2 catches todo->passing rot", !r.ok && r.rot.includes("a2"));
  r = check(R, new Map([["a3", true]]));
  t("rule 2 catches wontfix->passing rot", !r.ok && r.rot.includes("a3"));
  r = check(R, new Map([["a2", false]]));
  t("rule 2 clean when todo still fails", r.ok);

  // quarantine is exempt from rule 2 — it means "not yet triaged"
  r = check(R, new Map([["a4", true]]));
  t("quarantine passing is not rot", r.ok);

  // ---- rule 3: todo may only shrink
  t("rule 3 ok when todo shrinks", checkTodoMonotonic(["x", "y"], ["x"]).ok);
  const grew = checkTodoMonotonic(["x"], ["x", "y"]);
  t("rule 3 catches todo growth", !grew.ok && grew.grew.includes("y"));

  // ---- rules 4 and 5 — THE F1 FIX
  const atoms = [
    { atom_id: "n1", input_id: "iNEW", expect_hash: "hN" }, // new input  -> quarantinable
    { atom_id: "c1", input_id: "i1", expect_hash: "hCHANGED" }, // known input, changed -> HARD FAIL
    { atom_id: "u1", input_id: "i2", expect_hash: "h2" }, // unchanged
  ];
  const rs = resync(R, atoms);
  t("rule 4 marks new input fresh", rs.fresh.length === 1 && rs.fresh[0] === "n1");
  t("rule 5 marks known-input/changed-expectation", rs.changed.length === 1);
  t("rule 5 records both hashes", rs.changed[0].was === "h1" && rs.changed[0].now === "hCHANGED");
  t("unchanged detected", rs.unchanged.length === 1 && rs.unchanged[0] === "u1");
  t("removed input detected", rs.removed.includes("a3i"));

  // The single most important negative assertion in this file: a changed expectation
  // must NOT be reachable through the quarantine path.
  t(
    "rule 5: changed expectations are disjoint from fresh",
    rs.changed.every((c) => !rs.fresh.includes(c.atom_id)),
  );

  let bad = 0;
  for (const c of checks) {
    if (!c.ok) bad++;
    console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}`);
  }
  console.log(bad === 0 ? "\n  RATCHET SELFTEST: GREEN\n" : `\n  RATCHET SELFTEST: RED (${bad})\n`);
  return bad === 0 ? 0 : 1;
}

// Guard on being the MAIN module, not just on argv: test/runner.mjs imports this file
// and also takes --selftest, and an argv-only check would run (and exit) on import.
import { pathToFileURL } from "node:url";

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain && process.argv.includes("--selftest")) {
  process.exit(selftest());
}
