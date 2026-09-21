import { upstreamKeywords, upstreamFuncTokens, CURRENT_ROLE_EXCLUSION } from "../verification_exclusions.mjs";
console.log(CURRENT_ROLE_EXCLUSION);
// Parity probe #1, the load-bearing half: token streams byte-exact against CPython.
//
// PORT_PLAN.md §7 P1 exit. Called by tools/parity/check.mjs; runnable directly for
// diagnosis:
//
//   node tools/tokens/check_streams.mjs                    # everything
//   node tools/tokens/check_streams.mjs --dialect snowflake
//   node tools/tokens/check_streams.mjs --id 15147475dc3528fc --verbose
//
// Three layers, in dependency order, so a failure names the layer that broke:
//
//   A. derivations — tokens.js's port of `_TokenizerBase.__init_subclass__` against
//      the base Tokenizer's own `_QUOTES`/`_FORMAT_STRINGS`/`_COMMENTS`/`_KEYWORD_TRIE`.
//   B. tries       — the same derivation re-run for all 35 dialect configurations from
//      their snapshotted inputs. P1 does not port dialect classes (P5-P9 do), but the
//      derivation is shared code and this is the only place it gets 35-way coverage.
//   C. streams     — tokenizer_core.js over 23,457 (dialect, sql) pairs, comparing
//      token type, text, line, col, start, end and comments on every token, plus the
//      TokenError message where Python raised.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const arg = (name, dflt = null) =>
  argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt;
const VERBOSE = argv.includes("--verbose");
const ONLY_DIALECT = arg("--dialect");
const ONLY_ID = arg("--id");
const SETTINGS = arg("--settings", "corpus/tokens/settings.json");
const STREAMS = arg("--streams", "corpus/tokens/streams.jsonl");

// `--src` points the whole check at a different copy of the source tree. That is what
// lets spike/fuzz_unicode_tokens.mjs run this checker against deliberately mutated
// sources to prove the check is not vacuous, without ever mutating src/ in place.
const SRC = arg("--src", "src");
const mod = async (rel) => import(pathToFileURL(resolve(SRC, rel)).href);

const { TokenizerCore, TokenType, TOKEN_TYPE_NAMES } = await mod("tokenizer_core.js");
const { Tokenizer } = await mod("tokens.js");
const { newTrie, TRIE_END } = await mod("trie.js");
const { pyUpper } = await mod("_py/str.js");

/* ---- decode the snapshot -------------------------------------------------- */

function dec(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(dec);
  if ("$t" in v) {
    const t = TokenType[v.$t];
    if (t === undefined) throw new Error(`unknown TokenType in snapshot: ${v.$t}`);
    return t;
  }
  if ("$s" in v) return new Set(v.$s.map(dec));
  if ("$d" in v) return new Map(v.$d.map(([k, val]) => [k, dec(val)]));
  throw new Error(`unencodable snapshot node: ${JSON.stringify(v).slice(0, 80)}`);
}

function trieToJson(node) {
  const out = {};
  for (const [k, v] of node) {
    if (k === TRIE_END) out.$end = true;
    else out[k] = trieToJson(v);
  }
  return out;
}

/* ---- layer A: base-class derivations -------------------------------------- */

function jsonEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Normalize a decoded value to a comparable plain form. */
function plain(v) {
  if (v instanceof Map) return { $d: [...v].map(([k, x]) => [k, plain(x)]) };
  if (v instanceof Set) return { $s: [...v].map(plain).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)) };
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === "number" && TOKEN_TYPE_NAMES[v]) return { $t: TOKEN_TYPE_NAMES[v] };
  return v;
}

const failures = [];
function fail(layer, detail) {
  failures.push({ layer, detail });
}

const snapshot = JSON.parse(readFileSync(SETTINGS, "utf8"));

function checkDerivations() {
  const want = snapshot.classes.Tokenizer;
  let checks = 0;

  for (const [name, wantVal] of Object.entries(want.derived)) {
    checks++;
    const got = plain(Tokenizer[name]);
    if (!jsonEq(got, wantVal)) {
      fail("A derivations", `Tokenizer.${name}\n      want ${JSON.stringify(wantVal)}\n      got  ${JSON.stringify(got)}`);
    }
  }

  // The inputs too — a table transcribed wrong would otherwise only surface as a
  // stream diff a thousand rows later.
  for (const [name, wantVal] of Object.entries(want.inputs)) {
    checks++;
    const got = plain(Tokenizer[name]);
    if (!jsonEq(got, wantVal)) {
      fail("A derivations", `Tokenizer.${name}\n      want ${JSON.stringify(wantVal)}\n      got  ${JSON.stringify(got)}`);
    }
  }

  checks++;
  if (upstreamKeywords(Tokenizer.KEYWORDS).size !== want.keywords_count) {
    fail("A derivations", `Tokenizer.KEYWORDS ${Tokenizer.KEYWORDS.size} vs ${want.keywords_count}`);
  }
  checks++;
  if (Tokenizer.SINGLE_TOKENS.size !== want.single_tokens_count) {
    fail(
      "A derivations",
      `Tokenizer.SINGLE_TOKENS ${Tokenizer.SINGLE_TOKENS.size} vs ${want.single_tokens_count}`,
    );
  }
  checks++;
  if (!jsonEq(trieToJson(Tokenizer._KEYWORD_TRIE), want.keyword_trie)) {
    fail("A derivations", "Tokenizer._KEYWORD_TRIE differs from upstream");
  }

  return checks;
}

/* ---- layer B: per-dialect trie derivation --------------------------------- */

/**
 * Re-run `__init_subclass__`'s trie step from a dialect's snapshotted flat tables.
 *
 * This is the same filter as `initTokenizerSubclass`, but driven from the
 * TokenizerCore-level inputs (which is all the snapshot has for a dialect whose class
 * does not exist yet). Deliberately NOT calling the tokens.js function on a synthetic
 * class: that would test the same expression twice.
 */
function deriveTrie(settings) {
  const singles = [...settings.single_tokens.keys()];
  const keys = [
    ...settings.keywords.keys(),
    ...settings.comments.keys(),
    ...settings.quotes.keys(),
    ...settings.format_strings.keys(),
  ].filter((key) => key.includes(" ") || singles.some((single) => key.includes(single)));
  return newTrie(keys.map((key) => pyUpper(key)));
}

/* ---- build one core per dialect ------------------------------------------- */

const cores = new Map();

/**
 * Dialects whose Tokenizer overrides a method rather than only tables. Their streams
 * are not a function of the snapshotted settings, so P1 cannot reproduce them and
 * must say so. Read from the snapshot, never hardcoded: today it is `athena` alone
 * (its `tokenize` re-runs Hive's or Trino's tokenizer and prepends a
 * HIVE_TOKEN_STREAM sentinel), and the dialect lands with `dialects/athena.js` at P9.
 */
const methodOverriding = new Set(
  Object.entries(snapshot.cores)
    .filter(([, spec]) => (spec.overrides ?? []).length)
    .map(([name]) => name),
);

function checkCoresAndTries() {
  let checks = 0;
  for (const [name, spec] of Object.entries(snapshot.cores)) {
    const settings = {};
    for (const slot of snapshot.core_slots) {
      if (!(slot in spec.settings)) {
        fail("B settings", `${name}: snapshot is missing core slot ${slot}`);
        continue;
      }
      settings[slot] = dec(spec.settings[slot]);
    }

    const trie = deriveTrie(settings);
    checks++;
    if (!jsonEq(trieToJson(trie), spec.keyword_trie)) {
      fail("B tries", `${name || "(default)"}: derived _KEYWORD_TRIE differs from upstream`);
    }

    cores.set(name, new TokenizerCore({ ...settings, keyword_trie: trie }));
  }
  return checks;
}

/* ---- layer C: streams ------------------------------------------------------ */

function checkStreams() {
  const lines = readFileSync(STREAMS, "utf8").split("\n");
  let rows = 0;
  let tokens = 0;
  let errRows = 0;
  let skipped = 0;
  const seenDialects = new Set();

  for (const line of lines) {
    if (!line) continue;
    const row = JSON.parse(line);
    if (row.k && row.k.startsWith("$")) continue; // _py shim rows; the fuzzer checks those
    row.id = row.id ?? row.k ?? "?";
    if (ONLY_DIALECT !== null && row.d !== ONLY_DIALECT) continue;
    if (ONLY_ID !== null && row.id !== ONLY_ID) continue;

    if (methodOverriding.has(row.d)) {
      // Not a pass and not a failure: this dialect's Tokenizer overrides a *method*,
      // so its stream is not a function of its settings and P1 cannot reproduce it.
      // Counted and printed, never silently dropped (§ "no silent caps").
      skipped++;
      continue;
    }

    const core = cores.get(row.d);
    if (!core) {
      fail("C streams", `no snapshotted tokenizer for dialect ${JSON.stringify(row.d)}`);
      continue;
    }
    rows++;
    seenDialects.add(row.d);

    let got = null;
    let gotErr = null;
    try {
      got = core.tokenize(row.s);
    } catch (e) {
      gotErr = [e.constructor.name, e.message];
    }

    if (row.e) {
      errRows++;
      if (!gotErr) {
        fail("C streams", `${row.id} ${row.d}: expected ${row.e[0]} but tokenized ${got.tokens.length} tokens\n      sql ${JSON.stringify(row.s).slice(0, 160)}`);
      } else if (gotErr[0] !== row.e[0] || gotErr[1] !== row.e[1]) {
        fail("C streams", `${row.id} ${row.d}: error mismatch\n      want ${JSON.stringify(row.e)}\n      got  ${JSON.stringify(gotErr)}`);
      }
      continue;
    }

    if (gotErr) {
      fail("C streams", `${row.id} ${row.d}: unexpected ${gotErr[0]}: ${gotErr[1]}\n      sql ${JSON.stringify(row.s).slice(0, 160)}`);
      continue;
    }

    // CONTRACTS.md §2: the codePoints array must be the code-point decomposition of
    // the input, or every offset downstream is meaningless.
    if (got.codePoints.length !== [...row.s].length || got.codePoints.join("") !== row.s) {
      fail("C streams", `${row.id} ${row.d}: codePoints is not [...sql]`);
      continue;
    }
    const cps = got.codePoints;

    if (got.tokens.length !== row.t.length) {
      fail(
        "C streams",
        `${row.id} ${row.d}: ${got.tokens.length} tokens, want ${row.t.length}\n` +
          `      sql  ${JSON.stringify(row.s).slice(0, 160)}\n` +
          `      want ${row.t.slice(0, 12).map((t) => t[0]).join(" ")}\n` +
          `      got  ${got.tokens.slice(0, 12).map((t) => TOKEN_TYPE_NAMES[t.token_type]).join(" ")}`,
      );
      continue;
    }

    for (let i = 0; i < row.t.length; i++) {
      const [type, text, line, col, start, end, comments] = row.t[i];
      const t = got.tokens[i];
      tokens++;
      // `text: null` in the oracle means "equal to sql[start:end+1]"; reconstructed
      // from the oracle's own sql, and start/end are compared independently below, so
      // a slice bug cannot hide here.
      const wantText = text === null ? cps.slice(start, end + 1).join("") : text;
      const wantComments = comments ?? [];
      if (
        TOKEN_TYPE_NAMES[t.token_type] !== type ||
        t.text !== wantText ||
        t.line !== line ||
        t.col !== col ||
        t.start !== start ||
        t.end !== end ||
        !jsonEq(t.comments, wantComments)
      ) {
        fail(
          "C streams",
          `${row.id} ${row.d}: token ${i}\n` +
            `      sql  ${JSON.stringify(row.s).slice(0, 160)}\n` +
            `      want ${type} ${JSON.stringify(wantText)} line=${line} col=${col} ` +
            `start=${start} end=${end} comments=${JSON.stringify(wantComments)}\n` +
            `      got  ${TOKEN_TYPE_NAMES[t.token_type]} ${JSON.stringify(t.text)} line=${t.line} ` +
            `col=${t.col} start=${t.start} end=${t.end} comments=${JSON.stringify(t.comments)}`,
        );
        break;
      }
    }
  }

  return { rows, tokens, errRows, skipped, dialects: seenDialects.size };
}

/* --------------------------------------------------------------------------- */

const derivationChecks = checkDerivations();
const trieChecks = checkCoresAndTries();
const stats = checkStreams();

const skipNote = stats.skipped
  ? ` — ${stats.skipped} rows SKIPPED for ${[...methodOverriding].join(", ")} ` +
    "(Tokenizer overrides a method; lands with that dialect at P9)"
  : "";

const summary =
  `${derivationChecks} base-class derivation checks, ` +
  `${trieChecks} per-dialect keyword tries, ` +
  `${stats.rows} streams / ${stats.tokens} tokens over ${stats.dialects} dialects ` +
  `(${stats.errRows} expected TokenErrors)${skipNote}`;

if (process.env.TOKENS_CHECK_JSON) {
  console.log(JSON.stringify({ ok: failures.length === 0, summary, failures: failures.slice(0, 20), failureCount: failures.length }));
} else {
  console.log(`\n  ${summary}`);
  if (failures.length) {
    const show = VERBOSE ? failures : failures.slice(0, 10);
    console.log(`\n  ${failures.length} FAILURES:\n`);
    for (const f of show) console.log(`    [${f.layer}] ${f.detail}`);
    if (show.length < failures.length) {
      console.log(`\n    ... and ${failures.length - show.length} more (--verbose for all)`);
    }
    console.log();
  } else {
    console.log("  TOKEN STREAMS: BYTE-EXACT\n");
  }
}

process.exit(failures.length ? 1 : 0);
