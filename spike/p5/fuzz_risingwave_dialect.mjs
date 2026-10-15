// Differential: `src/dialects/risingwave.js`'s `RisingWave` class vs CPython.
//
//   PYTHONHASHSEED=0 python3 spike/p5/gen_risingwave_dialect_ref.py \
//       > spike/out/risingwave_dialect.json
//   node spike/p5/fuzz_risingwave_dialect.mjs
//
// AIR-2292, epic AIR-2272, "12.7 Small dialects", batch A. Same template R38's
// `fuzz_redshift_dialect.mjs`/R105's `fuzz_trino_dialect.mjs` established, one
// subclass level further verified: Postgres's own ~14 settings/Tokenizer survive
// unshadowed through another level of JS static inheritance.
//
// Four things are compared:
//
//   1. All RESOLVED settings, value by value (`getattr`, not `vars`): catches a
//      missing override AND an invented one.
//   2. The nested `Tokenizer` subclass (`Postgres.Tokenizer` merged with 2 added
//      keywords, `SINK`/`SOURCE`).
//   3. The autofilled `parser_class`/`tokenizer_class`/`generator_class` linkage.
//   4. The dialect instance's resolved `version`/`normalization_strategy`.
//
// RisingWave overrides no method on the `Dialect` class itself, so there is no
// section 5 (`parsers/risingwave.js`/`generators/risingwave.js` have their own
// corpus-driven coverage).

import { readFileSync } from "node:fs";
import { upstreamKeywords } from "../../tools/verification_exclusions.mjs";
import { Dialect } from "../../src/dialects/dialect.js";
import { Postgres } from "../../src/dialects/postgres.js";
import { RisingWave } from "../../src/dialects/risingwave.js";
import { RisingWaveParser } from "../../src/parsers/risingwave.js";
import { PostgresParser } from "../../src/parsers/postgres.js";
import { RisingWaveGenerator } from "../../src/generators/risingwave.js";
import { PostgresGenerator } from "../../src/generators/postgres.js";
import { TOKEN_TYPE_NAMES } from "../../src/tokens.js";
import { TRIE_END } from "../../src/trie.js";

const ref = JSON.parse(readFileSync("spike/out/risingwave_dialect.json", "utf8"));

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

// `EXPRESSION_METADATA` is inherited verbatim from `Postgres` (no
// `typing/risingwave.js` exists); still a count-only comparison, same reason every
// sibling oracle uses one.
const COUNT_ONLY = new Set(["EXPRESSION_METADATA"]);

for (const [name, want] of Object.entries(ref.attrs)) {
  if (KNOWN_GAPS.has(name)) {
    note.push(
      `GAP  ${name}: CPython has ${JSON.stringify(want)}, port has ` +
        `{"$count":${RisingWave[name].size}} — ${KNOWN_GAPS.get(name)}`,
    );
    continue;
  }
  if (!(name in RisingWave)) {
    checks += 1;
    fails.push(`${name}\n       got  <ABSENT from the port>\n       want ${trunc(JSON.stringify(want))}`);
    continue;
  }
  if (COUNT_ONLY.has(name)) {
    check(name, { $count: RisingWave[name].size }, want);
    continue;
  }
  const got = want !== null && typeof want === "object" && "$e" in want
    ? { $e: RisingWave[name] }
    : enc(RisingWave[name]);
  check(name, got, want);
}

// The reverse direction: a setting the port invented on this class, or one upstream
// dropped.
const upstreamNames = new Set(Object.keys(ref.attrs));
for (let k = RisingWave; k && k !== Function.prototype; k = Object.getPrototypeOf(k)) {
  for (const name of Object.getOwnPropertyNames(k)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    checks += 1;
    if (!upstreamNames.has(name)) fails.push(`${name}: present in the port, absent upstream`);
  }
}

// Which settings actually DIFFER from the base, as a set.
const gotOverrides = Object.keys(ref.attrs)
  .filter((n) => !KNOWN_GAPS.has(n) && !COUNT_ONLY.has(n))
  .filter((n) => JSON.stringify(enc(RisingWave[n])) !== JSON.stringify(enc(Dialect[n])))
  .sort();
check(
  "settings that differ from the base Dialect",
  gotOverrides,
  ref.overrides.filter((n) => !KNOWN_GAPS.has(n) && !COUNT_ONLY.has(n)),
);

// ---------------------------------------------------------------------------
// 2. The nested Tokenizer subclass
// ---------------------------------------------------------------------------
const tk = RisingWave.tokenizer_class;
const T = ref.tokenizer;

check("tokenizer_class is the declared nested Tokenizer", tk === RisingWave.Tokenizer, true);
check("tokenizer_class base", Object.getPrototypeOf(tk) === Postgres.tokenizer_class, T.base === "Tokenizer");

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

check("Tokenizer.BYTE_STRING_ESCAPES (derived: copy of STRING_ESCAPES)", enc(tk.BYTE_STRING_ESCAPES), T.BYTE_STRING_ESCAPES);
check("Tokenizer._QUOTES (derived)", enc(tk._QUOTES), T._QUOTES);
check("Tokenizer._IDENTIFIERS (derived)", enc(tk._IDENTIFIERS), T._IDENTIFIERS);
check("Tokenizer._FORMAT_STRINGS (derived)", enc(mapVals(tk._FORMAT_STRINGS, ([e, t]) => [e, tt(t)])), T._FORMAT_STRINGS);
check("Tokenizer._COMMENTS (derived)", enc(tk._COMMENTS), T._COMMENTS);
check("Tokenizer._STRING_ESCAPES (derived)", enc(tk._STRING_ESCAPES), T._STRING_ESCAPES);
check("Tokenizer._KEYWORD_TRIE size (derived)", tk._KEYWORD_TRIE.size, T._KEYWORD_TRIE_SIZE);

// py:18-19 adds `SINK`/`SOURCE`.
check("'SINK' in KEYWORDS (py:18 adds it)", tk.KEYWORDS.has("SINK"), T.sink_in_keywords);
check("'SOURCE' in KEYWORDS (py:19 adds it)", tk.KEYWORDS.has("SOURCE"), T.source_in_keywords);
check("'SINK' absent from the BASE Postgres Tokenizer.KEYWORDS (i.e. it was really new)", Postgres.tokenizer_class.KEYWORDS.has("SINK"), T.sink_in_base_postgres_keywords);
check("'SOURCE' absent from the BASE Postgres Tokenizer.KEYWORDS (i.e. it was really new)", Postgres.tokenizer_class.KEYWORDS.has("SOURCE"), T.source_in_base_postgres_keywords);

// ---------------------------------------------------------------------------
// 3. The autofilled classes
// ---------------------------------------------------------------------------
check("parser_class", RisingWave.parser_class === RisingWaveParser, ref.classes.parser_class === "RisingWaveParser");
check("parser_class name", RisingWave.parser_class.name, ref.classes.parser_class);
check("parser_class base", Object.getPrototypeOf(RisingWave.parser_class) === PostgresParser, ref.classes.parser_class_base === "PostgresParser");
check("generator_class", RisingWave.generator_class === RisingWaveGenerator, ref.classes.generator_class === "RisingWaveGenerator");
check("generator_class name", RisingWave.generator_class.name, ref.classes.generator_class);
check("generator_class base", Object.getPrototypeOf(RisingWave.generator_class) === PostgresGenerator, ref.classes.generator_class_base === "PostgresGenerator");
note.push(
  `DEVIATION  tokenizer_class.name: CPython ${JSON.stringify(ref.classes.tokenizer_class)}, port ` +
    `${JSON.stringify(tk.name)} — JS has no nested class declaration; identity is asserted above instead`,
);

// ---------------------------------------------------------------------------
// 4. The dialect instance
// ---------------------------------------------------------------------------
const d = Dialect.get_or_raise("risingwave");
check("get_or_raise('risingwave') resolves to RisingWave", d.constructor === RisingWave, true);
check("instance normalization_strategy", d.normalization_strategy, ref.instance.normalization_strategy);
check("instance version", d.version.map(String), ref.instance.version);

console.log();
console.log(`  RisingWave dialect vs CPython: ${checks - fails.length}/${checks} checks pass`);
console.log(
  `    ${Object.keys(ref.attrs).length} resolved settings (${ref.overrides.length} differ from the base), ` +
    `${upstreamKeywords(tk.KEYWORDS).size} tokenizer keywords`,
);
for (const line of note) console.log(`    ${line}`);
if (fails.length) {
  console.log();
  for (const f of fails) console.log(`    FAIL ${f}`);
  console.log();
  console.log("  RISINGWAVE DIALECT: FAIL");
  process.exit(1);
}
console.log("  RISINGWAVE DIALECT: OK");

/** A `Map` with each VALUE passed through `f`, preserving insertion order. */
function mapVals(m, f) {
  return new Map([...m].map(([k, v]) => [k, f(v)]));
}
