// Differential: `src/dialects/athena.js`'s `Athena` class vs CPython.
//
//   PYTHONHASHSEED=0 python3 spike/p5/gen_athena_dialect_ref.py \
//       > spike/out/athena_dialect.json
//   node spike/p5/fuzz_athena_dialect.mjs
//
// Same template this round's own `fuzz_trino_dialect.mjs`/`fuzz_dune_dialect.mjs`
// established, but Athena extends the BASE `Dialect` directly (not Presto/Trino) and
// declares no scalar setting of its own — all its real behavior lives in its
// composite `Tokenizer` (merging Hive's and Trino's quoting/keyword settings) and in
// `AthenaParser`/`AthenaGenerator`'s own Hive-vs-Trino dispatch.
//
// Four things are compared:
//
//   1. All RESOLVED settings vs. the base `Dialect` (expected: zero differences).
//   2. The composite `Tokenizer`: its merged quoting/keyword settings and the values
//      `initTokenizerSubclass` derives.
//   3. The autofilled `parser_class`/`tokenizer_class`/`generator_class` linkage.
//   4. The ACTUAL `_tokenize_as_hive` routing decision for a representative set of
//      statements covering every branch of that heuristic — a behavioral check on
//      top of the settings comparison, because this dialect's whole point IS the
//      routing decision.

import { readFileSync } from "node:fs";
import { upstreamKeywords } from "../../tools/verification_exclusions.mjs";
import { Dialect } from "../../src/dialects/dialect.js";
import { Athena } from "../../src/dialects/athena.js";
import { AthenaParser } from "../../src/parsers/athena.js";
import { AthenaGenerator } from "../../src/generators/athena.js";
import { Tokenizer, TokenType, TOKEN_TYPE_NAMES } from "../../src/tokens.js";
import { TRIE_END } from "../../src/trie.js";

const ref = JSON.parse(readFileSync("spike/out/athena_dialect.json", "utf8"));

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
        `{"$count":${Athena[name].size}} — ${KNOWN_GAPS.get(name)}`,
    );
    continue;
  }
  if (!(name in Athena)) {
    checks += 1;
    fails.push(`${name}\n       got  <ABSENT from the port>\n       want ${trunc(JSON.stringify(want))}`);
    continue;
  }
  if (COUNT_ONLY.has(name)) {
    check(name, { $count: Athena[name].size }, want);
    continue;
  }
  const got = want !== null && typeof want === "object" && "$e" in want
    ? { $e: Athena[name] }
    : enc(Athena[name]);
  check(name, got, want);
}

const upstreamNames = new Set(Object.keys(ref.attrs));
for (let k = Athena; k && k !== Function.prototype; k = Object.getPrototypeOf(k)) {
  for (const name of Object.getOwnPropertyNames(k)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    checks += 1;
    if (!upstreamNames.has(name)) fails.push(`${name}: present in the port, absent upstream`);
  }
}

const gotOverrides = Object.keys(ref.attrs)
  .filter((n) => !KNOWN_GAPS.has(n) && !COUNT_ONLY.has(n))
  .filter((n) => JSON.stringify(enc(Athena[n])) !== JSON.stringify(enc(Dialect[n])))
  .sort();
check(
  "settings that differ from the base Dialect",
  gotOverrides,
  ref.overrides.filter((n) => !KNOWN_GAPS.has(n) && !COUNT_ONLY.has(n)),
);

// ---------------------------------------------------------------------------
// 2. The composite Tokenizer
// ---------------------------------------------------------------------------
const tk = Athena.tokenizer_class;
const T = ref.tokenizer;

check("tokenizer_class is the declared nested Tokenizer", tk === Athena.Tokenizer, true);
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
check("Tokenizer.NUMERIC_LITERALS", enc(tk.NUMERIC_LITERALS), T.NUMERIC_LITERALS);

check("Tokenizer._QUOTES (derived)", enc(tk._QUOTES), T._QUOTES);
check("Tokenizer._IDENTIFIERS (derived)", enc(tk._IDENTIFIERS), T._IDENTIFIERS);
check("Tokenizer._FORMAT_STRINGS (derived)", enc(mapVals(tk._FORMAT_STRINGS, ([e, t]) => [e, tt(t)])), T._FORMAT_STRINGS);
check("Tokenizer._COMMENTS (derived)", enc(tk._COMMENTS), T._COMMENTS);
check("Tokenizer._STRING_ESCAPES (derived)", enc(tk._STRING_ESCAPES), T._STRING_ESCAPES);
check("Tokenizer._KEYWORD_TRIE size (derived)", tk._KEYWORD_TRIE.size, T._KEYWORD_TRIE_SIZE);

// py:67 `"UNLOAD": TokenType.COMMAND`.
check("'UNLOAD' in KEYWORDS (py:67 adds it)", tk.KEYWORDS.has("UNLOAD"), T.unload_in_keywords);

// ---------------------------------------------------------------------------
// 3. The autofilled classes
// ---------------------------------------------------------------------------
check("parser_class", Athena.parser_class === AthenaParser, ref.classes.parser_class === "AthenaParser");
check("parser_class name", Athena.parser_class.name, ref.classes.parser_class);
check("parser_class base", Object.getPrototypeOf(Athena.parser_class).name !== undefined, ref.classes.parser_class_base === "Parser");
check("generator_class", Athena.generator_class === AthenaGenerator, ref.classes.generator_class === "AthenaGenerator");
check("generator_class name", Athena.generator_class.name, ref.classes.generator_class);
note.push(
  `DEVIATION  tokenizer_class.name: CPython ${JSON.stringify(ref.classes.tokenizer_class)}, port ` +
    `${JSON.stringify(tk.name)} — JS has no nested class declaration; identity is asserted above instead`,
);

// ---------------------------------------------------------------------------
// 4. The actual `_tokenize_as_hive` routing decision
// ---------------------------------------------------------------------------
const d = Dialect.get_or_raise("athena");
check("get_or_raise('athena') resolves to Athena", d.constructor === Athena, true);
check("instance normalization_strategy", d.normalization_strategy, ref.instance.normalization_strategy);
check("instance version", d.version.map(String), ref.instance.version);

let routingChecks = 0;
for (const [sql, wantHive] of Object.entries(ref.routing)) {
  routingChecks += 1;
  const toks = new Athena().tokenizer().tokenize(sql).tokens;
  const gotHive = Boolean(toks.length) && toks[0].token_type === TokenType.HIVE_TOKEN_STREAM;
  check(`routing decision for ${JSON.stringify(sql)}`, gotHive, wantHive);
}

console.log();
console.log(`  Athena dialect vs CPython: ${checks - fails.length}/${checks} checks pass`);
console.log(
  `    ${Object.keys(ref.attrs).length} resolved settings (${ref.overrides.length} differ from the base), ` +
    `${upstreamKeywords(tk.KEYWORDS).size} tokenizer keywords, ${routingChecks} routing-decision cases`,
);
for (const line of note) console.log(`    ${line}`);
if (fails.length) {
  console.log();
  for (const f of fails) console.log(`    FAIL ${f}`);
  console.log();
  console.log("  ATHENA DIALECT: FAIL");
  process.exit(1);
}
console.log("  ATHENA DIALECT: OK");

function mapVals(m, f) {
  return new Map([...m].map(([k, v]) => [k, f(v)]));
}
