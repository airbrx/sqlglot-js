// Differential: `src/dialects/druid.js`'s `Druid` class vs CPython.
//
//   PYTHONHASHSEED=0 python3 spike/p5/gen_druid_dialect_ref.py \
//       > spike/out/druid_dialect.json
//   node spike/p5/fuzz_druid_dialect.mjs
//
// Same template R21/R42/R103/R109's `fuzz_snowflake_dialect.mjs`/
// `fuzz_exasol_dialect.mjs` established (AIR-2292, "12.7 Small dialects", batch B).
//
// Druid is the first ported dialect that declares NO nested `Tokenizer` subclass at
// all (`registerDialect`'s `Object.hasOwn(klass, "Tokenizer")` branch is false for
// it), so its `tokenizer_class` is a FRESH anonymous subclass — reproduced in
// `registerDialect` itself. The base it chains onto is `Dialect.tokenizer_class`,
// NOT the raw `tokens.Tokenizer` export: `Dialect` itself goes through
// `registerDialect(Dialects.DIALECT, Dialect)` (dialect.js's own last line, mirroring
// upstream's base `Dialect` class running through the SAME `_Dialect.__new__`
// metaclass hook every subclass does), so `Dialect.tokenizer_class` is ALREADY a
// synthetic subclass of the real `Tokenizer`, one level in. Every dialect that
// declares an EXPLICIT nested `Tokenizer(tokens.Tokenizer)` subclasses the raw base
// directly (matching upstream's own literal `tokens.Tokenizer` superclass reference,
// independent of its parent dialect's resolved `tokenizer_class`); only the
// IMPLICIT no-override path chains through the parent's resolved value. Druid is the
// first port-side exercise of that implicit path, so the identity check below is
// against `Dialect.tokenizer_class`, not `Tokenizer`. No `tokenizer_class.name`
// DEVIATION note either: upstream's own synthetic `type("Tokenizer",
// (base_tokenizer,), {})` is also named "Tokenizer", and so is the port's `class
// Tokenizer extends base_tokenizer {}` — the two names genuinely match here.
//
// Druid overrides no method on the `Dialect` class itself, so there is no section 4
// here, the same shape Presto's/Exasol's/Solr's own oracle used.

import { readFileSync } from "node:fs";
import { upstreamKeywords } from "../../tools/verification_exclusions.mjs";
import { Dialect } from "../../src/dialects/dialect.js";
import { Druid } from "../../src/dialects/druid.js";
import { DruidParser } from "../../src/parsers/druid.js";
import { DruidGenerator } from "../../src/generators/druid.js";
import { Tokenizer, TOKEN_TYPE_NAMES } from "../../src/tokens.js";
import { TRIE_END } from "../../src/trie.js";

const ref = JSON.parse(readFileSync("spike/out/druid_dialect.json", "utf8"));

const fails = [];
const note = [];
let checks = 0;

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
const COUNT_ONLY = new Set(["EXPRESSION_METADATA"]);

for (const [name, want] of Object.entries(ref.attrs)) {
  if (KNOWN_GAPS.has(name)) {
    note.push(
      `GAP  ${name}: CPython has ${JSON.stringify(want)}, port has ` +
        `{"$count":${Druid[name].size}} — ${KNOWN_GAPS.get(name)}`,
    );
    continue;
  }
  if (!(name in Druid)) {
    checks += 1;
    fails.push(`${name}\n       got  <ABSENT from the port>\n       want ${trunc(JSON.stringify(want))}`);
    continue;
  }
  if (COUNT_ONLY.has(name)) {
    check(name, { $count: Druid[name].size }, want);
    continue;
  }
  const got = want !== null && typeof want === "object" && "$e" in want
    ? { $e: Druid[name] }
    : enc(Druid[name]);
  check(name, got, want);
}

const upstreamNames = new Set(Object.keys(ref.attrs));
for (let k = Druid; k && k !== Function.prototype; k = Object.getPrototypeOf(k)) {
  for (const name of Object.getOwnPropertyNames(k)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    checks += 1;
    if (!upstreamNames.has(name)) fails.push(`${name}: present in the port, absent upstream`);
  }
}

const gotOverrides = Object.keys(ref.attrs)
  .filter((n) => !KNOWN_GAPS.has(n) && !COUNT_ONLY.has(n))
  .filter((n) => JSON.stringify(enc(Druid[n])) !== JSON.stringify(enc(Dialect[n])))
  .sort();
check(
  "settings that differ from the base Dialect",
  gotOverrides,
  ref.overrides.filter((n) => !KNOWN_GAPS.has(n) && !COUNT_ONLY.has(n)),
);

// ---------------------------------------------------------------------------
// 2. The nested Tokenizer subclass (synthetic: Druid declares no own Tokenizer)
// ---------------------------------------------------------------------------
const tk = Druid.tokenizer_class;
const T = ref.tokenizer;

check("Druid declares no own Tokenizer (sanity)", Object.hasOwn(Druid, "Tokenizer"), false);
check(
  "tokenizer_class base is Dialect.tokenizer_class (itself a synthetic subclass of the real Tokenizer)",
  Object.getPrototypeOf(tk) === Dialect.tokenizer_class,
  T.base === "Tokenizer",
);
check("Dialect.tokenizer_class is itself a subclass of the real Tokenizer (sanity)", Object.getPrototypeOf(Dialect.tokenizer_class) === Tokenizer, true);
check("tokenizer_class name", tk.name, T.name);

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
check("Tokenizer.IDENTIFIERS", enc(tk.IDENTIFIERS), T.IDENTIFIERS);

check("Tokenizer.BYTE_STRING_ESCAPES (derived: copy of STRING_ESCAPES)", enc(tk.BYTE_STRING_ESCAPES), T.BYTE_STRING_ESCAPES);
check("Tokenizer._QUOTES (derived)", enc(tk._QUOTES), T._QUOTES);
check("Tokenizer._IDENTIFIERS (derived)", enc(tk._IDENTIFIERS), T._IDENTIFIERS);
check("Tokenizer._FORMAT_STRINGS (derived)", enc(mapVals(tk._FORMAT_STRINGS, ([e, t]) => [e, tt(t)])), T._FORMAT_STRINGS);
check("Tokenizer._COMMENTS (derived)", enc(tk._COMMENTS), T._COMMENTS);
check("Tokenizer._STRING_ESCAPES (derived)", enc(tk._STRING_ESCAPES), T._STRING_ESCAPES);
check("Tokenizer._KEYWORD_TRIE size (derived)", tk._KEYWORD_TRIE.size, T._KEYWORD_TRIE_SIZE);

// ---------------------------------------------------------------------------
// 3. The autofilled classes
// ---------------------------------------------------------------------------
check("parser_class", Druid.parser_class === DruidParser, ref.classes.parser_class === "DruidParser");
check("parser_class name", Druid.parser_class.name, ref.classes.parser_class);
check("generator_class", Druid.generator_class === DruidGenerator, ref.classes.generator_class === "DruidGenerator");
check("generator_class name", Druid.generator_class.name, ref.classes.generator_class);
check("tokenizer_class name matches upstream synthetic subclass", tk.name, ref.classes.tokenizer_class);

const d = Dialect.get_or_raise("druid");
check("get_or_raise('druid') resolves to Druid", d.constructor === Druid, true);
check("instance normalization_strategy", d.normalization_strategy, ref.instance.normalization_strategy);
check("instance version", d.version.map(String), ref.instance.version);

console.log();
console.log(`  Druid dialect vs CPython: ${checks - fails.length}/${checks} checks pass`);
console.log(
  `    ${Object.keys(ref.attrs).length} resolved settings (${ref.overrides.length} differ from the base), ` +
    `${upstreamKeywords(tk.KEYWORDS).size} tokenizer keywords`,
);
for (const line of note) console.log(`    ${line}`);
if (fails.length) {
  console.log();
  for (const f of fails) console.log(`    FAIL ${f}`);
  console.log();
  console.log("  DRUID DIALECT: FAIL");
  process.exit(1);
}
console.log("  DRUID DIALECT: OK");

/** A `Map` with each VALUE passed through `f`, preserving insertion order. */
function mapVals(m, f) {
  return new Map([...m].map(([k, v]) => [k, f(v)]));
}
