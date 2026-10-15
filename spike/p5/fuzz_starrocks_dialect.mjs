import { upstreamKeywords } from "../../tools/verification_exclusions.mjs";
// Differential: `src/dialects/starrocks.js`'s `StarRocks` class vs CPython.
//
//   PYTHONHASHSEED=0 python3 spike/p5/gen_starrocks_dialect_ref.py \
//       > spike/out/starrocks_dialect.json
//   node spike/p5/fuzz_starrocks_dialect.mjs
//
// Same shape as `fuzz_mysql_dialect.mjs` (PORT_PLAN.md R42's template), but the base
// for the "which settings differ" comparison is `MySQL`, not `Dialect` — `StarRocks`
// extends `MySQL` (AIR-2286 part 2). StarRocks declares no method overrides (unlike
// DuckDB's `to_json_path`), so there is no section 3 here either.
//
// Two things are compared:
//
//   1. All RESOLVED settings, value by value. Resolved (`getattr`), not own (`vars`),
//      so it catches a missing override AND an invented one.
//   2. The nested `Tokenizer` subclass: its declared settings (KEYWORDS, COMMANDS)
//      and the values `initTokenizerSubclass` derives — plus the two keyword
//      additions (`LARGEINT`, `REFRESH`) py:14-17 layers on top of `MySQL.Tokenizer.
//      KEYWORDS`.

import { readFileSync } from "node:fs";
import { MySQL } from "../../src/dialects/mysql.js";
import { StarRocks } from "../../src/dialects/starrocks.js";
import { Dialect } from "../../src/dialects/dialect.js";
import { StarRocksParser } from "../../src/parsers/starrocks.js";
import { StarRocksGenerator } from "../../src/generators/starrocks.js";
import { Tokenizer, TokenType, TOKEN_TYPE_NAMES } from "../../src/tokens.js";
import { TRIE_END } from "../../src/trie.js";

const ref = JSON.parse(readFileSync("spike/out/starrocks_dialect.json", "utf8"));

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

function mapVals(m, f) {
  return new Map([...m].map(([k, v]) => [k, f(v)]));
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
        `{"$count":${StarRocks[name].size}} — ${KNOWN_GAPS.get(name)}`,
    );
    continue;
  }
  if (!(name in StarRocks)) {
    checks += 1;
    fails.push(`${name}\n       got  <ABSENT from the port>\n       want ${trunc(JSON.stringify(want))}`);
    continue;
  }
  if (COUNT_ONLY.has(name)) {
    check(name, { $count: StarRocks[name].size }, want);
    continue;
  }
  const got = want !== null && typeof want === "object" && "$e" in want
    ? { $e: StarRocks[name] }
    : enc(StarRocks[name]);
  check(name, got, want);
}

// The reverse direction: a setting the port invented on this class, or one upstream
// dropped.
const upstreamNames = new Set(Object.keys(ref.attrs));
for (let k = StarRocks; k && k !== Function.prototype; k = Object.getPrototypeOf(k)) {
  for (const name of Object.getOwnPropertyNames(k)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    checks += 1;
    if (!upstreamNames.has(name)) fails.push(`${name}: present in the port, absent upstream`);
  }
}

// Which settings actually DIFFER from MySQL (the real parent), as a set. Guards the
// failure mode a value-by-value pass cannot: if the port had silently mutated MYSQL
// instead of subclassing it, every value above would still match while `MySQL` itself
// was corrupted.
const gotOverrides = Object.keys(ref.attrs)
  .filter((n) => !KNOWN_GAPS.has(n) && !COUNT_ONLY.has(n))
  .filter((n) => JSON.stringify(enc(StarRocks[n])) !== JSON.stringify(enc(MySQL[n])))
  .sort();
check(
  "settings that differ from the base MySQL",
  gotOverrides,
  ref.overrides.filter((n) => !KNOWN_GAPS.has(n) && !COUNT_ONLY.has(n)),
);

// ---------------------------------------------------------------------------
// 2. The nested Tokenizer subclass
// ---------------------------------------------------------------------------
const tk = StarRocks.tokenizer_class;
const T = ref.tokenizer;

check("tokenizer_class is the declared nested Tokenizer", tk === StarRocks.Tokenizer, true);
check("tokenizer_class base", Object.getPrototypeOf(tk) === MySQL.tokenizer_class, T.base === "Tokenizer");

check("Tokenizer.KEYWORDS", enc(mapVals(upstreamKeywords(tk.KEYWORDS), tt)), T.KEYWORDS);
check("Tokenizer.COMMANDS", { $s: [...tk.COMMANDS].map(tt).sort(byJson) }, T.COMMANDS);

check("Tokenizer._QUOTES (derived)", enc(tk._QUOTES), T._QUOTES);
check("Tokenizer._IDENTIFIERS (derived)", enc(tk._IDENTIFIERS), T._IDENTIFIERS);
check("Tokenizer._FORMAT_STRINGS (derived)", enc(mapVals(tk._FORMAT_STRINGS, ([e, t]) => [e, tt(t)])), T._FORMAT_STRINGS);
check("Tokenizer._COMMENTS (derived)", enc(tk._COMMENTS), T._COMMENTS);
check("Tokenizer._STRING_ESCAPES (derived)", enc(tk._STRING_ESCAPES), T._STRING_ESCAPES);
check("Tokenizer._KEYWORD_TRIE size (derived)", tk._KEYWORD_TRIE.size, T._KEYWORD_TRIE_SIZE);

// py:14/17 `KEYWORDS = {**MySQL.Tokenizer.KEYWORDS, "LARGEINT": ..., "REFRESH": ...}`.
check("LARGEINT -> INT128 (py:16 adds it)", tk.KEYWORDS.get("LARGEINT") === TokenType.INT128, T.largeint_is_int128);
check("REFRESH -> REFRESH (py:17 adds it)", tk.KEYWORDS.get("REFRESH") === TokenType.REFRESH, T.refresh_is_refresh);
check("MySQL.Tokenizer.KEYWORDS has no LARGEINT (i.e. it was really added)", MySQL.Tokenizer.KEYWORDS.has("LARGEINT"), false);

// ---------------------------------------------------------------------------
// 3. The autofilled classes + instance
// ---------------------------------------------------------------------------
check("parser_class", StarRocks.parser_class === StarRocksParser, ref.classes.parser_class === "StarRocksParser");
check("parser_class name", StarRocks.parser_class.name, ref.classes.parser_class);
check("generator_class", StarRocks.generator_class === StarRocksGenerator, ref.classes.generator_class === "StarRocksGenerator");
check("generator_class name", StarRocks.generator_class.name, ref.classes.generator_class);
note.push(
  `DEVIATION  tokenizer_class.name: CPython ${JSON.stringify(ref.classes.tokenizer_class)}, port ` +
    `${JSON.stringify(tk.name)} — JS has no nested class declaration; identity is asserted above instead`,
);

const d = Dialect.get_or_raise("starrocks");
check("get_or_raise('starrocks') resolves to StarRocks", d.constructor === StarRocks, true);
check("instance normalization_strategy", d.normalization_strategy, ref.instance.normalization_strategy);
check("instance version", d.version.map(String), ref.instance.version);

console.log();
console.log(`  StarRocks dialect vs CPython: ${checks - fails.length}/${checks} checks pass`);
console.log(
  `    ${Object.keys(ref.attrs).length} resolved settings (${ref.overrides.length} differ from MySQL), ` +
    `${ref.tokenizer.KEYWORDS.$d.length} tokenizer keywords`,
);
for (const line of note) console.log(`    ${line}`);
if (fails.length) {
  console.log();
  for (const f of fails) console.log(`    FAIL ${f}`);
  console.log();
  console.log("  STARROCKS DIALECT: FAIL");
  process.exit(1);
}
console.log("  STARROCKS DIALECT: OK");
