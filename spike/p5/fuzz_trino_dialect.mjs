// Differential: `src/dialects/trino.js`'s `Trino` class vs CPython.
//
//   PYTHONHASHSEED=0 python3 spike/p5/gen_trino_dialect_ref.py \
//       > spike/out/trino_dialect.json
//   node spike/p5/fuzz_trino_dialect.mjs
//
// Same template R103's `fuzz_presto_dialect.mjs` established, one subclass level
// further (AIR-2287, "12.2 Presto family", part 2): `Trino extends Presto`, so the
// settings/overrides check additionally verifies Presto's own 11 settings/2 borrowed
// tables survive unshadowed through another level of JS static inheritance.
//
// Four things are compared:
//
//   1. All RESOLVED settings, value by value (`getattr`, not `vars`): catches a
//      missing override AND an invented one.
//   2. The nested `Tokenizer` subclass (`Presto.Tokenizer` merged with 2 added
//      keywords and one post-merge `KEYWORDS.delete("SQL SECURITY")`).
//   3. The autofilled `parser_class`/`tokenizer_class`/`generator_class` linkage,
//      including each one's own base (TrinoParser extends PrestoParser, etc).
//   4. The dialect instance's resolved `version`/`normalization_strategy`.
//
// Trino overrides no method on the `Dialect` class itself, so there is no section 5
// (`parsers/trino.js`/`generators/trino.js` have their own corpus-driven coverage).

import { readFileSync } from "node:fs";
import { upstreamKeywords } from "../../tools/verification_exclusions.mjs";
import { Dialect } from "../../src/dialects/dialect.js";
import { Presto } from "../../src/dialects/presto.js";
import { Trino } from "../../src/dialects/trino.js";
import { TrinoParser } from "../../src/parsers/trino.js";
import { PrestoParser } from "../../src/parsers/presto.js";
import { TrinoGenerator } from "../../src/generators/trino.js";
import { PrestoGenerator } from "../../src/generators/presto.js";
import { Tokenizer, TOKEN_TYPE_NAMES } from "../../src/tokens.js";
import { TRIE_END } from "../../src/trie.js";

const ref = JSON.parse(readFileSync("spike/out/trino_dialect.json", "utf8"));

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

// `EXPRESSION_METADATA` is inherited verbatim from `Presto` (no `typing/trino.js`
// exists); still a count-only comparison, same reason every sibling oracle uses one.
const COUNT_ONLY = new Set(["EXPRESSION_METADATA"]);

for (const [name, want] of Object.entries(ref.attrs)) {
  if (KNOWN_GAPS.has(name)) {
    note.push(
      `GAP  ${name}: CPython has ${JSON.stringify(want)}, port has ` +
        `{"$count":${Trino[name].size}} — ${KNOWN_GAPS.get(name)}`,
    );
    continue;
  }
  if (!(name in Trino)) {
    checks += 1;
    fails.push(`${name}\n       got  <ABSENT from the port>\n       want ${trunc(JSON.stringify(want))}`);
    continue;
  }
  if (COUNT_ONLY.has(name)) {
    check(name, { $count: Trino[name].size }, want);
    continue;
  }
  const got = want !== null && typeof want === "object" && "$e" in want
    ? { $e: Trino[name] }
    : enc(Trino[name]);
  check(name, got, want);
}

// The reverse direction: a setting the port invented on this class, or one upstream
// dropped.
const upstreamNames = new Set(Object.keys(ref.attrs));
for (let k = Trino; k && k !== Function.prototype; k = Object.getPrototypeOf(k)) {
  for (const name of Object.getOwnPropertyNames(k)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    checks += 1;
    if (!upstreamNames.has(name)) fails.push(`${name}: present in the port, absent upstream`);
  }
}

// Which settings actually DIFFER from the base, as a set.
const gotOverrides = Object.keys(ref.attrs)
  .filter((n) => !KNOWN_GAPS.has(n) && !COUNT_ONLY.has(n))
  .filter((n) => JSON.stringify(enc(Trino[n])) !== JSON.stringify(enc(Dialect[n])))
  .sort();
check(
  "settings that differ from the base Dialect",
  gotOverrides,
  ref.overrides.filter((n) => !KNOWN_GAPS.has(n) && !COUNT_ONLY.has(n)),
);

// ---------------------------------------------------------------------------
// 2. The nested Tokenizer subclass
// ---------------------------------------------------------------------------
const tk = Trino.tokenizer_class;
const T = ref.tokenizer;

check("tokenizer_class is the declared nested Tokenizer", tk === Trino.Tokenizer, true);
check("tokenizer_class base", Object.getPrototypeOf(tk) === Presto.tokenizer_class, T.base === "Tokenizer");

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

// py:20-22 `KEYWORDS.delete("SQL SECURITY")`.
check("'SQL SECURITY' in KEYWORDS (py:22 pops it)", tk.KEYWORDS.has("SQL SECURITY"), T.sql_security_in_keywords);
check("'SQL SECURITY' in the BASE Presto Tokenizer.KEYWORDS (i.e. it was really there to remove)", Presto.tokenizer_class.KEYWORDS.has("SQL SECURITY"), T.sql_security_in_base_presto_keywords);
check("'REFRESH' in KEYWORDS (py:17 adds it)", tk.KEYWORDS.has("REFRESH"), T.refresh_in_keywords);
check("'DECLARE' in KEYWORDS (py:18 adds it)", tk.KEYWORDS.has("DECLARE"), T.declare_in_keywords);

// ---------------------------------------------------------------------------
// 3. The autofilled classes
// ---------------------------------------------------------------------------
check("parser_class", Trino.parser_class === TrinoParser, ref.classes.parser_class === "TrinoParser");
check("parser_class name", Trino.parser_class.name, ref.classes.parser_class);
check("parser_class base", Object.getPrototypeOf(Trino.parser_class) === PrestoParser, ref.classes.parser_class_base === "PrestoParser");
check("generator_class", Trino.generator_class === TrinoGenerator, ref.classes.generator_class === "TrinoGenerator");
check("generator_class name", Trino.generator_class.name, ref.classes.generator_class);
check("generator_class base", Object.getPrototypeOf(Trino.generator_class) === PrestoGenerator, ref.classes.generator_class_base === "PrestoGenerator");
note.push(
  `DEVIATION  tokenizer_class.name: CPython ${JSON.stringify(ref.classes.tokenizer_class)}, port ` +
    `${JSON.stringify(tk.name)} — JS has no nested class declaration; identity is asserted above instead`,
);

// ---------------------------------------------------------------------------
// 4. The dialect instance
// ---------------------------------------------------------------------------
const d = Dialect.get_or_raise("trino");
check("get_or_raise('trino') resolves to Trino", d.constructor === Trino, true);
check("instance normalization_strategy", d.normalization_strategy, ref.instance.normalization_strategy);
check("instance version", d.version.map(String), ref.instance.version);

console.log();
console.log(`  Trino dialect vs CPython: ${checks - fails.length}/${checks} checks pass`);
console.log(
  `    ${Object.keys(ref.attrs).length} resolved settings (${ref.overrides.length} differ from the base), ` +
    `${upstreamKeywords(tk.KEYWORDS).size} tokenizer keywords`,
);
for (const line of note) console.log(`    ${line}`);
if (fails.length) {
  console.log();
  for (const f of fails) console.log(`    FAIL ${f}`);
  console.log();
  console.log("  TRINO DIALECT: FAIL");
  process.exit(1);
}
console.log("  TRINO DIALECT: OK");

/** A `Map` with each VALUE passed through `f`, preserving insertion order. */
function mapVals(m, f) {
  return new Map([...m].map(([k, v]) => [k, f(v)]));
}
