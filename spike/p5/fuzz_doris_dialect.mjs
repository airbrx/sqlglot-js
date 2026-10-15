// Differential: `src/dialects/doris.js`'s `Doris` class vs CPython.
//
//   PYTHONHASHSEED=0 python3 spike/p5/gen_doris_dialect_ref.py \
//       > spike/out/doris_dialect.json
//   node spike/p5/fuzz_doris_dialect.mjs
//
// Same shape as `fuzz_starrocks_dialect.mjs` (base for "which settings differ" is
// `MySQL`, not `Dialect`), but `doris.js` declares no `static Tokenizer` at all, so
// `registerDialect` must have built a FRESH subclass of `MySQL.tokenizer_class` for
// it rather than aliasing it — checked explicitly below, not assumed.

import { readFileSync } from "node:fs";
import { MySQL } from "../../src/dialects/mysql.js";
import { Doris } from "../../src/dialects/doris.js";
import { Dialect } from "../../src/dialects/dialect.js";
import { DorisParser } from "../../src/parsers/doris.js";
import { DorisGenerator } from "../../src/generators/doris.js";
import { TOKEN_TYPE_NAMES } from "../../src/tokens.js";
import { TRIE_END } from "../../src/trie.js";
import { upstreamKeywords } from "../../tools/verification_exclusions.mjs";

const ref = JSON.parse(readFileSync("spike/out/doris_dialect.json", "utf8"));

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
        `{"$count":${Doris[name].size}} — ${KNOWN_GAPS.get(name)}`,
    );
    continue;
  }
  if (!(name in Doris)) {
    checks += 1;
    fails.push(`${name}\n       got  <ABSENT from the port>\n       want ${trunc(JSON.stringify(want))}`);
    continue;
  }
  if (COUNT_ONLY.has(name)) {
    check(name, { $count: Doris[name].size }, want);
    continue;
  }
  const got = want !== null && typeof want === "object" && "$e" in want
    ? { $e: Doris[name] }
    : enc(Doris[name]);
  check(name, got, want);
}

const upstreamNames = new Set(Object.keys(ref.attrs));
for (let k = Doris; k && k !== Function.prototype; k = Object.getPrototypeOf(k)) {
  for (const name of Object.getOwnPropertyNames(k)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    checks += 1;
    if (!upstreamNames.has(name)) fails.push(`${name}: present in the port, absent upstream`);
  }
}

const gotOverrides = Object.keys(ref.attrs)
  .filter((n) => !KNOWN_GAPS.has(n) && !COUNT_ONLY.has(n))
  .filter((n) => JSON.stringify(enc(Doris[n])) !== JSON.stringify(enc(MySQL[n])))
  .sort();
check(
  "settings that differ from the base MySQL",
  gotOverrides,
  ref.overrides.filter((n) => !KNOWN_GAPS.has(n) && !COUNT_ONLY.has(n)),
);

// ---------------------------------------------------------------------------
// 2. The (undeclared) Tokenizer — a fresh subclass, not an alias
// ---------------------------------------------------------------------------
const tk = Doris.tokenizer_class;
const T = ref.tokenizer;

check("tokenizer_class is a FRESH subclass, not MySQL's own", tk !== MySQL.tokenizer_class, true);
check("tokenizer_class extends MySQL.tokenizer_class", Object.getPrototypeOf(tk) === MySQL.tokenizer_class, T.is_fresh_subclass);
check("Doris did not declare its own Tokenizer", Object.hasOwn(Doris, "Tokenizer"), false);

check("Tokenizer.KEYWORDS (identical to MySQL's)", enc(mapVals(upstreamKeywords(tk.KEYWORDS), tt)), T.KEYWORDS);
check("Tokenizer.COMMANDS (identical to MySQL's)", { $s: [...tk.COMMANDS].map(tt).sort(byJson) }, T.COMMANDS);

check("Tokenizer._QUOTES (derived)", enc(tk._QUOTES), T._QUOTES);
check("Tokenizer._IDENTIFIERS (derived)", enc(tk._IDENTIFIERS), T._IDENTIFIERS);
check("Tokenizer._FORMAT_STRINGS (derived)", enc(mapVals(tk._FORMAT_STRINGS, ([e, t]) => [e, tt(t)])), T._FORMAT_STRINGS);
check("Tokenizer._COMMENTS (derived)", enc(tk._COMMENTS), T._COMMENTS);
check("Tokenizer._STRING_ESCAPES (derived)", enc(tk._STRING_ESCAPES), T._STRING_ESCAPES);
check("Tokenizer._KEYWORD_TRIE size (derived)", tk._KEYWORD_TRIE.size, T._KEYWORD_TRIE_SIZE);

// ---------------------------------------------------------------------------
// 3. The autofilled classes + instance
// ---------------------------------------------------------------------------
check("parser_class", Doris.parser_class === DorisParser, ref.classes.parser_class === "DorisParser");
check("parser_class name", Doris.parser_class.name, ref.classes.parser_class);
check("generator_class", Doris.generator_class === DorisGenerator, ref.classes.generator_class === "DorisGenerator");
check("generator_class name", Doris.generator_class.name, ref.classes.generator_class);
note.push(
  `DEVIATION  tokenizer_class.name: CPython ${JSON.stringify(ref.classes.tokenizer_class)}, port ` +
    `${JSON.stringify(tk.name)} — JS has no nested class declaration; identity is asserted above instead`,
);

const d = Dialect.get_or_raise("doris");
check("get_or_raise('doris') resolves to Doris", d.constructor === Doris, true);
check("instance normalization_strategy", d.normalization_strategy, ref.instance.normalization_strategy);
check("instance version", d.version.map(String), ref.instance.version);

console.log();
console.log(`  Doris dialect vs CPython: ${checks - fails.length}/${checks} checks pass`);
console.log(
  `    ${Object.keys(ref.attrs).length} resolved settings (${ref.overrides.length} differ from MySQL), ` +
    `${ref.tokenizer.KEYWORDS.$d.length} tokenizer keywords (inherited)`,
);
for (const line of note) console.log(`    ${line}`);
if (fails.length) {
  console.log();
  for (const f of fails) console.log(`    FAIL ${f}`);
  console.log();
  console.log("  DORIS DIALECT: FAIL");
  process.exit(1);
}
console.log("  DORIS DIALECT: OK");
