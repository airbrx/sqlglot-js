// fuzz_unicode over TOKENIZATION — PORT_PLAN.md §3.4 target 3, §7 P1 exit.
//
//   python3 spike/py/gen_tokens_cases.py > spike/out/tokens_fuzz.jsonl
//   node spike/fuzz_unicode_tokens.mjs
//
// Three parts:
//
//   1. `_py` shims the tokenizer added at P1 — pyUpper, pyIsAlnum, pyIsIdentifierChar,
//      pyIsDigit, pyIsSpace, pyIntFromStrBase — against CPython, per code point.
//   2. Token streams over the Unicode-targeted SQL corpus, via the same checker the
//      harvested corpus uses (tools/tokens/check_streams.mjs), so there is exactly one
//      comparison implementation.
//   3. A VACUITY CHECK. Every P0 fuzzer carries one; this is P1's. It applies a matrix
//      of deliberately-wrong ports to a COPY of src/ and asserts each is caught. The
//      interesting output is not "all caught" — it is the split showing which
//      mutations the 23,389-row harvested corpus cannot see at all. Those are the
//      rows that justify this file's existence (§4.6, R4).

import { readFileSync, cpSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  pyUpper,
  pyIsAlnum,
  pyIsDigit,
  pyIsIdentifierChar,
  pyIsSpace,
} from "../src/_py/str.js";
import { pyIntFromStrBase } from "../src/_py/num.js";

const CASES = "spike/out/tokens_fuzz.jsonl";
const MUT_DIR = "spike/out/mut";
const MUT_SRC = join(MUT_DIR, "src");

let failures = 0;
const report = (name, bad, total, samples = []) => {
  failures += bad;
  console.log(
    `    ${name.padEnd(22)}${String(bad).padStart(7)} / ${String(total).padStart(7)} divergences` +
      (bad ? `  ${samples.slice(0, 4).join("  ")}` : "  exact"),
  );
};

/* ---- 1. _py shims, per code point ----------------------------------------- */

const rows = readFileSync(CASES, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

{
  const chars = rows.filter((r) => r.k === "$char");
  const bad = { upper: [], isalnum: [], isidentifier: [], isdigit: [], isspace: [] };
  for (const r of chars) {
    const ch = String.fromCodePoint(r.cp);
    const tag = () => "U+" + r.cp.toString(16).toUpperCase().padStart(4, "0");
    if (pyUpper(ch) !== r.upper) bad.upper.push(tag());
    if (pyIsAlnum(ch) !== r.isalnum) bad.isalnum.push(tag());
    if (pyIsIdentifierChar(ch) !== r.isidentifier) bad.isidentifier.push(tag());
    if (pyIsDigit(ch) !== r.isdigit) bad.isdigit.push(tag());
    if (pyIsSpace(ch) !== r.isspace) bad.isspace.push(tag());
  }
  console.log(`\n  1. _py shims over ${chars.length.toLocaleString()} code points\n`);
  for (const [name, list] of Object.entries(bad)) {
    report(`pyStr.${name}`, list.length, chars.length, list);
  }

  const ints = rows.filter((r) => r.k === "$int");
  const intBad = [];
  for (const r of ints) {
    const got = pyIntFromStrBase(r.s, r.base);
    const want = r.want === null ? null : BigInt(r.want);
    if (got !== want) intBad.push(`${JSON.stringify(r.s)}/${r.base}`);
  }
  report("pyIntFromStrBase", intBad.length, ints.length, intBad);
}

/* ---- 2. token streams over the Unicode corpus ------------------------------ */

function runChecker(streams, src = "src") {
  const r = spawnSync(
    process.execPath,
    ["tools/tokens/check_streams.mjs", "--streams", streams, "--src", src],
    { encoding: "utf8", env: { ...process.env, TOKENS_CHECK_JSON: "1" } },
  );
  if (r.status === null || !r.stdout) {
    return { ok: false, summary: `checker crashed: ${(r.stderr || "").split("\n")[0]}`, failureCount: 1 };
  }
  try {
    return JSON.parse(r.stdout.trim().split("\n").pop());
  } catch {
    return { ok: false, summary: `unparseable checker output`, failureCount: 1 };
  }
}

console.log("\n  2. token streams over the Unicode-targeted corpus\n");
{
  const res = runChecker(CASES);
  console.log(`    ${res.summary}`);
  if (!res.ok) {
    failures += res.failureCount;
    for (const f of res.failures) console.log(`    [${f.layer}] ${f.detail}`);
  }
}

/* ---- 3. vacuity: the mutation matrix --------------------------------------- */

/**
 * Each entry is a plausible wrong port — the JS a competent engineer writes when they
 * reach for the obvious builtin instead of the shim. `find` must match exactly once,
 * so a mutation that stops applying because the source moved is a hard error rather
 * than a silently-skipped row.
 *
 * `equivalent` marks a mutant that CANNOT be killed because, given today's tokenizer
 * tables, it computes the same answer. The assertion is then INVERTED: an equivalent
 * mutant that gets caught means the stated reasoning is wrong, and that is a failure
 * too. Every equivalence claim below rests on the same premise — that no tokenizer
 * table key in any of the 35 configurations contains a non-ASCII character — and that
 * premise is machine-checked against the settings snapshot before the matrix runs, so
 * the day upstream adds a non-ASCII keyword these claims retract themselves instead of
 * quietly becoming false.
 */
const MUTATIONS = [
  {
    name: "keyword text via toUpperCase",
    file: "tokenizer_core.js",
    find: "word = pyUpper(word);",
    with: "word = word.toUpperCase();",
    why: "str.upper() is version-pinned; Node 16.0 vs CPython 13.0 differ on 67 code points",
    equivalent:
      "`word` is a prefix of the trie walk, and the walk folds case with the ASCII-only " +
      "_CHAR_UPPER — so a non-ASCII source character only matches if it is itself a trie " +
      "key, and no trie key is non-ASCII. `word` is therefore always ASCII and the two " +
      "uppercasings agree. Becomes killable the moment a dialect adds a non-ASCII keyword.",
  },
  {
    name: "var lookup via toUpperCase",
    file: "tokenizer_core.js",
    find: ": this.keywords.get(pyUpper(this._slice(this._start, this._current))) ?? TokenType.VAR,",
    with: ": this.keywords.get(this._slice(this._start, this._current).toUpperCase()) ?? TokenType.VAR,",
    why: "same, on the path that decides VAR vs keyword",
    equivalent:
      "the input here IS arbitrary source text, but the result is only ever used as a " +
      "KEYWORDS lookup key. The 67 code points where Node and CPython disagree all map to " +
      "non-ASCII, and every KEYWORDS key is ASCII, so both spellings miss the table and " +
      "both yield VAR. Killable if Node ever gains a mapping onto an ASCII keyword.",
  },
  {
    name: "size via UTF-16 .length",
    file: "tokenizer_core.js",
    find: "this.size = this._cp.length;",
    with: "this.size = sql.length;",
    why: "every offset after the first astral character is wrong",
  },
  {
    name: "token end off-by-one",
    file: "tokenizer_core.js",
    find: "this._current - 1,\n        this._comments,",
    with: "this._current,\n        this._comments,",
    why: "control: a plain arithmetic slip the harvested corpus must catch",
  },
  {
    name: "isspace via JS regex",
    file: "tokenizer_core.js",
    find: "      if (!pyIsSpace(this._char)) {",
    with: "      if (!/^\\s+$/.test(this._char)) {",
    why: "Python isspace and JS \\s differ on U+001C-001F, U+0085, U+FEFF",
  },
  {
    name: "isalnum via ASCII regex",
    file: "tokenizer_core.js",
    find: "    if (alnum && pyIsAlnum(this._char)) {",
    with: "    if (alnum && /^[0-9A-Za-z]$/.test(this._char)) {",
    why: "decides where comment/var/value scans stop",
    equivalent:
      "`alnum` is a batching optimisation, not a decision: every caller re-checks its own " +
      "stop condition in a loop, and the fast path only ever skips characters that are " +
      "alphanumeric — which are never single tokens, never whitespace, and never the first " +
      "character of a comment delimiter. Skipping fewer of them costs iterations, not " +
      "answers. Argued, plus 28,040 inputs of evidence; not a proof.",
  },
  {
    name: "isidentifier via ASCII regex",
    file: "tokenizer_core.js",
    find: "      } else if (pyIsIdentifierChar(this._peek)) {",
    with: "      } else if (/^[A-Za-z_]$/.test(this._peek)) {",
    why: "XID_Start is far wider than [A-Za-z_]",
  },
  {
    name: "hex validity via regex",
    file: "tokenizer_core.js",
    find: "    if (pyIntFromStrBase(value, 16) !== null) {",
    with: "    if (/^0[xX][0-9a-fA-F]+$/.test(value)) {",
    why: "int(s, 16) folds Unicode decimal digits and allows underscores",
  },
  {
    name: "strip via JS trim",
    file: "tokenizer_core.js",
    find: "      const char = pyStrip(this._peek);",
    with: "      const char = this._peek.trim();",
    why: "JS trim strips U+FEFF, which Python's isspace does not",
  },
  {
    name: "delimiter width via .length",
    file: "tokenizer_core.js",
    find: "    const delim_size = cpLen(delimiter);",
    with: "    const delim_size = delimiter.length;",
    why: "a multi-code-point delimiter would be over-counted",
  },
  {
    name: "isdigit via ASCII regex",
    file: "tokenizer_core.js",
    find: "          (this._end || pyIsDigit(tag) || [...tag].some((c) => pyIsSpace(c)))",
    with: "          (this._end || /^[0-9]+$/.test(tag) || [...tag].some((c) => pyIsSpace(c)))",
    why: "str.isdigit() accepts superscripts and Unicode decimal digits",
  },
  {
    name: "trie folds via toUpperCase",
    file: "tokens.js",
    find: "      .map((key) => pyUpper(key)),",
    with: "      .map((key) => key.toUpperCase()),",
    why: "the keyword trie is built from key.upper()",
    equivalent:
      "the inputs are the tokenizer's own table keys, all ASCII, so the two uppercasings " +
      "produce identical tries. Killable as soon as a dialect adds a non-ASCII keyword.",
  },
];

console.log("\n  3. vacuity — deliberately wrong ports, and who notices\n");

// The premise every `equivalent` claim rests on. Checked, not assumed: if upstream
// ever ships a non-ASCII tokenizer table key, four equivalence claims below stop being
// true and this fires instead of them silently rotting.
{
  const snap = JSON.parse(readFileSync("corpus/tokens/settings.json", "utf8"));
  const offenders = [];
  for (const [name, spec] of Object.entries(snap.cores)) {
    for (const slot of ["keywords", "comments", "quotes", "format_strings", "single_tokens"]) {
      for (const [key] of spec.settings[slot].$d) {
        for (const ch of key) if (ch.codePointAt(0) > 127) offenders.push(`${name}.${slot}:${key}`);
      }
    }
  }
  if (offenders.length) {
    failures++;
    console.log(
      `    PREMISE BROKEN: ${offenders.length} non-ASCII tokenizer table keys ` +
        `(${offenders.slice(0, 3).join(", ")}). The equivalence claims below are no longer ` +
        "valid — those mutants are now killable and must be killed.",
    );
  } else {
    console.log(
      `    premise ok: 0 non-ASCII table keys across ${Object.keys(snap.cores).length} ` +
        "tokenizer configurations\n",
    );
  }
}

rmSync(MUT_DIR, { recursive: true, force: true });
mkdirSync(MUT_DIR, { recursive: true });

const originals = new Map();
for (const file of new Set(MUTATIONS.map((m) => m.file))) {
  originals.set(file, readFileSync(join("src", file), "utf8"));
}

let uncaught = 0;
let fuzzOnly = 0;
let corpusOnly = 0;
let equivalentOk = 0;

for (const mut of MUTATIONS) {
  const original = originals.get(mut.file);
  const occurrences = original.split(mut.find).length - 1;
  if (occurrences !== 1) {
    console.log(
      `    MUTATION STALE  ${mut.name}: anchor matches ${occurrences} times in src/${mut.file}`,
    );
    failures++;
    continue;
  }

  rmSync(MUT_SRC, { recursive: true, force: true });
  cpSync("src", MUT_SRC, { recursive: true });
  writeFileSync(join(MUT_SRC, mut.file), original.replace(mut.find, mut.with));

  const corpus = runChecker("corpus/tokens/streams.jsonl", MUT_SRC);
  const fuzz = runChecker(CASES, MUT_SRC);
  const byCorpus = !corpus.ok;
  const byFuzz = !fuzz.ok;

  let mark;
  if (mut.equivalent) {
    // Inverted assertion: an equivalent mutant MUST survive. If it dies, the stated
    // reasoning is wrong and the claim has to be re-derived, not deleted.
    if (byCorpus || byFuzz) {
      failures++;
      mark = "CLAIM WRONG";
    } else {
      equivalentOk++;
      mark = "equivalent";
    }
  } else if (!byCorpus && !byFuzz) {
    uncaught++;
    mark = "NOBODY";
  } else if (byFuzz && !byCorpus) {
    fuzzOnly++;
    mark = "FUZZ ONLY";
  } else if (byCorpus && !byFuzz) {
    corpusOnly++;
    mark = "corpus only";
  } else {
    mark = "both";
  }

  console.log(
    `    ${mut.name.padEnd(30)} corpus ${String(byCorpus ? corpus.failureCount : 0).padStart(6)}  ` +
      `fuzz ${String(byFuzz ? fuzz.failureCount : 0).padStart(5)}   ${mark}`,
  );
  if (mark === "NOBODY") console.log(`      ^ UNCAUGHT — ${mut.why}`);
  if (mark === "CLAIM WRONG") {
    console.log(`      ^ this mutant was declared equivalent but something killed it. Claim:`);
    console.log(`        ${mut.equivalent}`);
  }
  if (mark === "equivalent") console.log(`      (unkillable by construction — ${mut.equivalent})`);
}

rmSync(MUT_DIR, { recursive: true, force: true });

// Restoration guard: the mutations only ever touched a copy, but assert it, because
// "the test suite silently edited the source tree" is not a failure mode to discover
// later.
for (const [file, text] of originals) {
  if (readFileSync(join("src", file), "utf8") !== text) {
    console.log(`\n    FATAL: src/${file} was modified by the mutation harness`);
    failures++;
  }
}

console.log(
  `\n    ${MUTATIONS.length} mutations: ${fuzzOnly} caught ONLY by this fuzzer, ` +
    `${corpusOnly} caught only by the harvested corpus, ` +
    `${equivalentOk} equivalent-by-construction (correctly unkillable), ${uncaught} uncaught`,
);

if (uncaught) {
  failures += uncaught;
  console.log("    A mutation nobody catches means that behaviour has no oracle at all.");
}
if (fuzzOnly === 0) {
  // Not a failure — a warning that this file has stopped earning its keep. If the
  // harvested corpus ever grows enough non-ASCII coverage to catch everything here,
  // that is good news, and it should be noticed rather than assumed.
  console.log(
    "    NOTE: every mutation was also caught by the harvested corpus, so this fuzzer " +
      "is currently redundant. Verify that is really true before trusting it.",
  );
}

console.log(
  failures === 0
    ? "\n  FUZZ_UNICODE (tokenization): GREEN\n"
    : `\n  FUZZ_UNICODE (tokenization): FAILED (${failures})\n`,
);
process.exit(failures === 0 ? 0 : 1);
