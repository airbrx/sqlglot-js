// Differential: `src/dialects/teradata.js`'s `Teradata` class vs CPython.
//
//   PYTHONHASHSEED=0 python3 spike/p5/gen_teradata_dialect_ref.py \
//       > spike/out/teradata_dialect.json
//   node spike/p5/fuzz_teradata_dialect.mjs
//
// Same template R21/R42/R103's `fuzz_presto_dialect.mjs` established (AIR-2291,
// "12.6 SQLite + Teradata"): the defect class this guards is a hand-transcribed
// class-level VALUE that nothing anywhere else compares against upstream — most
// notably the 26-entry `TIME_MAPPING` table and the nested `Tokenizer`'s ~20 added
// keywords plus its two post-merge mutations (`KEYWORDS.pop("/*+")`,
// `SINGLE_TOKENS.pop("%")`).
//
// Three things are compared:
//
//   1. All RESOLVED settings, value by value (`getattr`, not `vars`): catches a
//      missing override AND an invented one.
//   2. The nested `Tokenizer` subclass: its declared settings and, separately, the
//      values `__init_subclass__` DERIVES (the port must call `initTokenizerSubclass`
//      by hand — JS has no such hook).
//   3. The autofilled `parser_class`/`tokenizer_class`/`generator_class` linkage.
//
// Teradata overrides no method on the `Dialect` class itself, so there is no
// section 4 here.

import { readFileSync } from "node:fs";
import { upstreamKeywords } from "../../tools/verification_exclusions.mjs";
import { Dialect } from "../../src/dialects/dialect.js";
import { Teradata } from "../../src/dialects/teradata.js";
import { TeradataParser } from "../../src/parsers/teradata.js";
import { TeradataGenerator } from "../../src/generators/teradata.js";
import { Tokenizer, TOKEN_TYPE_NAMES } from "../../src/tokens.js";
import { TRIE_END } from "../../src/trie.js";

const ref = JSON.parse(readFileSync("spike/out/teradata_dialect.json", "utf8"));

const fails = [];
const note = [];
let checks = 0;

/** Render a JS value in the oracle's own encoding, so a diff is a string diff. */
function enc(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" || typeof v === "boolean" || typeof v === "number") return v;
  if (v instanceof Set) return { $s: [...v].map(enc).sort(byJson) };
  if (v instanceof Map) {
    return { $d: [...v].map(([k, val]) => [k === TRIE_END ? "$end" : enc(k), enc(val)]) };
  }
  if (Array.isArray(v)) return v.map(enc);
  if (v.__enum__ === "DType") return { $dtype: v.name };
  if (typeof v === "function") return { $c: v.name };
  if (typeof v === "object" && "$t" in v) return v;
  throw new Error(`unencodable JS value: ${String(v)}`);
}

const tt = (v) => ({ $t: TOKEN_TYPE_NAMES[v] });

/** Matches the oracle's `_sort_key`: canonical JSON, with `JSON.stringify`'s spelling. */
const byJson = (a, b) => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

const trunc = (s) => (s.length > 240 ? `${s.slice(0, 240)}…` : s);

function check(what, got, want) {
  checks += 1;
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) fails.push(`${what}\n       got  ${trunc(g)}\n       want ${trunc(w)}`);
}

// ---------------------------------------------------------------------------
// 1. The resolved settings
// ---------------------------------------------------------------------------
const KNOWN_GAPS = new Map([]);

// `EXPRESSION_METADATA` has no `typing/teradata.js` — `Teradata` inherits the base
// `Dialect.EXPRESSION_METADATA` (294 entries) verbatim via ordinary JS static-field
// inheritance. Still a real count comparison (294 vs 294), same unencodable-lambda
// problem the oracle's own `COUNT_ONLY` set solves on the CPython side.
const COUNT_ONLY = new Set(["EXPRESSION_METADATA"]);

for (const [name, want] of Object.entries(ref.attrs)) {
  if (KNOWN_GAPS.has(name)) {
    note.push(
      `GAP  ${name}: CPython has ${JSON.stringify(want)}, port has ` +
        `{"$count":${Teradata[name].size}} — ${KNOWN_GAPS.get(name)}`,
    );
    continue;
  }
  if (!(name in Teradata)) {
    checks += 1;
    fails.push(`${name}\n       got  <ABSENT from the port>\n       want ${trunc(JSON.stringify(want))}`);
    continue;
  }
  if (COUNT_ONLY.has(name)) {
    check(name, { $count: Teradata[name].size }, want);
    continue;
  }
  const got = want !== null && typeof want === "object" && "$e" in want
    ? { $e: Teradata[name] }
    : enc(Teradata[name]);
  check(name, got, want);
}

// The reverse direction: a setting the port invented on this class, or one upstream
// dropped.
const upstreamNames = new Set(Object.keys(ref.attrs));
for (let k = Teradata; k && k !== Function.prototype; k = Object.getPrototypeOf(k)) {
  for (const name of Object.getOwnPropertyNames(k)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    checks += 1;
    if (!upstreamNames.has(name)) fails.push(`${name}: present in the port, absent upstream`);
  }
}

// Which settings actually DIFFER from the base, as a set. Guards the failure mode a
// value-by-value pass cannot: if the port had silently mutated the BASE class instead
// of subclassing it, every value above would still match while `Dialect` was corrupted.
const gotOverrides = Object.keys(ref.attrs)
  .filter((n) => !KNOWN_GAPS.has(n) && !COUNT_ONLY.has(n))
  .filter((n) => JSON.stringify(enc(Teradata[n])) !== JSON.stringify(enc(Dialect[n])))
  .sort();
check(
  "settings that differ from the base Dialect",
  gotOverrides,
  ref.overrides.filter((n) => !KNOWN_GAPS.has(n) && !COUNT_ONLY.has(n)),
);

// ---------------------------------------------------------------------------
// 2. The nested Tokenizer subclass
// ---------------------------------------------------------------------------
const tk = Teradata.tokenizer_class;
const T = ref.tokenizer;

check("tokenizer_class is the declared nested Tokenizer", tk === Teradata.Tokenizer, true);
check("tokenizer_class base", Object.getPrototypeOf(tk) === Tokenizer, T.base === "Tokenizer");

check("Tokenizer.KEYWORDS", enc(mapVals(upstreamKeywords(tk.KEYWORDS), tt)), T.KEYWORDS);
check("Tokenizer.SINGLE_TOKENS", enc(mapVals(tk.SINGLE_TOKENS, tt)), T.SINGLE_TOKENS);
check("Tokenizer.COMMANDS", { $s: [...tk.COMMANDS].map(tt).sort(byJson) }, T.COMMANDS);
check("Tokenizer.COMMENTS", enc(tk.COMMENTS), T.COMMENTS);
check("Tokenizer.STRING_ESCAPES", enc(tk.STRING_ESCAPES), T.STRING_ESCAPES);
check("Tokenizer.HEX_STRINGS", enc(tk.HEX_STRINGS), T.HEX_STRINGS);
check("Tokenizer.UNICODE_STRINGS", enc(tk.UNICODE_STRINGS), T.UNICODE_STRINGS);
check("Tokenizer.RAW_STRINGS", enc(tk.RAW_STRINGS), T.RAW_STRINGS);
check("Tokenizer.VAR_SINGLE_TOKENS", enc(tk.VAR_SINGLE_TOKENS), T.VAR_SINGLE_TOKENS);
check("Tokenizer.NESTED_COMMENTS", tk.NESTED_COMMENTS, T.NESTED_COMMENTS);

// Derived by `initTokenizerSubclass`. If that call were missing these would silently
// be the BASE tokenizer's.
check("Tokenizer.BYTE_STRING_ESCAPES (derived: copy of STRING_ESCAPES)", enc(tk.BYTE_STRING_ESCAPES), T.BYTE_STRING_ESCAPES);
check("Tokenizer._QUOTES (derived)", enc(tk._QUOTES), T._QUOTES);
check("Tokenizer._IDENTIFIERS (derived)", enc(tk._IDENTIFIERS), T._IDENTIFIERS);
check("Tokenizer._FORMAT_STRINGS (derived)", enc(mapVals(tk._FORMAT_STRINGS, ([e, t]) => [e, tt(t)])), T._FORMAT_STRINGS);
check("Tokenizer._COMMENTS (derived)", enc(tk._COMMENTS), T._COMMENTS);
check("Tokenizer._STRING_ESCAPES (derived)", enc(tk._STRING_ESCAPES), T._STRING_ESCAPES);
check("Tokenizer._KEYWORD_TRIE size (derived)", tk._KEYWORD_TRIE.size, T._KEYWORD_TRIE_SIZE);

// py:73 `KEYWORDS.pop("/*+")`, and the downstream consequence (HINT_START reaching
// `_COMMENTS` only when present in KEYWORDS).
check("HINT_START in KEYWORDS (py:73 pops it)", tk.KEYWORDS.has(tk.HINT_START), T.hint_start_in_keywords);
check("HINT_START in _COMMENTS", tk._COMMENTS.has(tk.HINT_START), T.hint_start_in_comments);
// py:75-77 `SINGLE_TOKENS.pop("%")` -- Teradata does not support % as a modulo
// operator. This must land BEFORE `initTokenizerSubclass` runs, since its own
// `_KEYWORD_TRIE` derivation reads `SINGLE_TOKENS` (src/dialects/teradata.js's own
// header comment on this ordering).
check("'%' in SINGLE_TOKENS (py:77 pops it)", tk.SINGLE_TOKENS.has("%"), T.percent_in_single_tokens);
// The inherited half of the same line: removing '%' must not have removed it from
// the BASE Tokenizer's own table (i.e. it was really popped here, not absent upstream).
check("'%' in the BASE Tokenizer.SINGLE_TOKENS (i.e. it was really there to remove)", Tokenizer.SINGLE_TOKENS.has("%"), true);

// ---------------------------------------------------------------------------
// 3. The autofilled classes
// ---------------------------------------------------------------------------
check("parser_class", Teradata.parser_class === TeradataParser, ref.classes.parser_class === "TeradataParser");
check("parser_class name", Teradata.parser_class.name, ref.classes.parser_class);
check("generator_class", Teradata.generator_class === TeradataGenerator, ref.classes.generator_class === "TeradataGenerator");
check("generator_class name", Teradata.generator_class.name, ref.classes.generator_class);
// Upstream's nested class is literally named `Tokenizer`, same as every other
// dialect's own nested class; JS has no nested class declaration, so the port names
// it `TeradataTokenizer` at module level. Recorded as a deviation with both names
// printed rather than asserted away, same precedent `fuzz_snowflake_dialect.mjs` set.
note.push(
  `DEVIATION  tokenizer_class.name: CPython ${JSON.stringify(ref.classes.tokenizer_class)}, port ` +
    `${JSON.stringify(tk.name)} — JS has no nested class declaration; identity is asserted above instead`,
);

const d = Dialect.get_or_raise("teradata");
check("get_or_raise('teradata') resolves to Teradata", d.constructor === Teradata, true);
check("instance normalization_strategy", d.normalization_strategy, ref.instance.normalization_strategy);
check("instance version", d.version.map(String), ref.instance.version);

console.log();
console.log(`  Teradata dialect vs CPython: ${checks - fails.length}/${checks} checks pass`);
console.log(
  `    ${Object.keys(ref.attrs).length} resolved settings (${ref.overrides.length} differ from the base), ` +
    `${upstreamKeywords(tk.KEYWORDS).size} tokenizer keywords`,
);
for (const line of note) console.log(`    ${line}`);
if (fails.length) {
  console.log();
  for (const f of fails) console.log(`    FAIL ${f}`);
  console.log();
  console.log("  TERADATA DIALECT: FAIL");
  process.exit(1);
}
console.log("  TERADATA DIALECT: OK");

/** A `Map` with each VALUE passed through `f`, preserving insertion order. */
function mapVals(m, f) {
  return new Map([...m].map(([k, v]) => [k, f(v)]));
}
