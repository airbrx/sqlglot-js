// Differential: `src/dialects/singlestore.js`'s `SingleStore` class vs CPython.
//
//   PYTHONHASHSEED=0 python3 spike/p5/gen_singlestore_dialect_ref.py \
//       > spike/out/singlestore_dialect.json
//   node spike/p5/fuzz_singlestore_dialect.mjs
//
// Same template R105's `fuzz_trino_dialect.mjs` established (itself one subclass
// level past R104's `fuzz_mysql_dialect.mjs`), AIR-2286, "12.1 MySQL family", part 3
// of the chain: `SingleStore extends MySQL`, so the settings/overrides check
// additionally verifies MySQL's own 9 settings survive unshadowed through another
// level of JS static inheritance.
//
// Five things are compared:
//
//   1. All RESOLVED settings, value by value (`getattr`, not `vars`): catches a
//      missing override AND an invented one. `CAST_TO_TIME6` (a plain function
//      reference, not a data setting) and `EXPRESSION_METADATA` (inherited verbatim
//      from MySQL, no `typing/singlestore.js` exists) are each asserted by shape
//      rather than by value, same two carve-outs the oracle itself documents.
//   2. The nested `Tokenizer` subclass (`MySQL.Tokenizer` merged with `BYTE_STRINGS`
//      and ~12 added/replaced keywords).
//   3. `VECTOR_TYPE_ALIASES`/`INVERSE_VECTOR_TYPE_ALIASES`, SingleStore's own two
//      extra tables with no base-Dialect counterpart.
//   4. The autofilled `parser_class`/`tokenizer_class`/`generator_class` linkage,
//      including each one's own base (SingleStoreParser extends MySQLParser, etc).
//   5. The dialect instance's resolved `version`/`normalization_strategy`.
//
// SingleStore overrides no method on the `Dialect` class itself, so there is no
// section 6 (`parsers/singlestore.js`/`generators/singlestore.js` have their own
// corpus-driven coverage).

import { readFileSync } from "node:fs";
import { upstreamKeywords } from "../../tools/verification_exclusions.mjs";
import { Dialect } from "../../src/dialects/dialect.js";
import { MySQL } from "../../src/dialects/mysql.js";
import { SingleStore } from "../../src/dialects/singlestore.js";
import { SingleStoreParser } from "../../src/parsers/singlestore.js";
import { MySQLParser } from "../../src/parsers/mysql.js";
import { SingleStoreGenerator } from "../../src/generators/singlestore.js";
import { MySQLGenerator } from "../../src/generators/mysql.js";
import { TOKEN_TYPE_NAMES } from "../../src/tokens.js";
import { TRIE_END } from "../../src/trie.js";

const ref = JSON.parse(readFileSync("spike/out/singlestore_dialect.json", "utf8"));

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

// `EXPRESSION_METADATA` is inherited verbatim from `MySQL` (no `typing/singlestore.js`
// exists); still a count-only comparison, same reason every sibling oracle uses one.
const COUNT_ONLY = new Set(["EXPRESSION_METADATA"]);
// `CAST_TO_TIME6` is a plain function reference (`py:12 staticmethod(cast_to_time6)`),
// not a comparable data setting -- asserted by NAME only.
const FUNC_ONLY = new Set(["CAST_TO_TIME6"]);

for (const [name, want] of Object.entries(ref.attrs)) {
  if (KNOWN_GAPS.has(name)) {
    note.push(
      `GAP  ${name}: CPython has ${JSON.stringify(want)}, port has ` +
        `{"$count":${SingleStore[name].size}} — ${KNOWN_GAPS.get(name)}`,
    );
    continue;
  }
  if (!(name in SingleStore)) {
    checks += 1;
    fails.push(`${name}\n       got  <ABSENT from the port>\n       want ${trunc(JSON.stringify(want))}`);
    continue;
  }
  if (FUNC_ONLY.has(name)) {
    check(name, { $func: SingleStore[name].name }, want);
    continue;
  }
  if (COUNT_ONLY.has(name)) {
    check(name, { $count: SingleStore[name].size }, want);
    continue;
  }
  const got = want !== null && typeof want === "object" && "$e" in want
    ? { $e: SingleStore[name] }
    : enc(SingleStore[name]);
  check(name, got, want);
}

// The reverse direction: a setting the port invented on this class, or one upstream
// dropped.
const upstreamNames = new Set(Object.keys(ref.attrs));
for (let k = SingleStore; k && k !== Function.prototype; k = Object.getPrototypeOf(k)) {
  for (const name of Object.getOwnPropertyNames(k)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    checks += 1;
    if (!upstreamNames.has(name)) fails.push(`${name}: present in the port, absent upstream`);
  }
}

// Which settings actually DIFFER from the base, as a set.
const gotOverrides = Object.keys(ref.attrs)
  .filter((n) => !KNOWN_GAPS.has(n) && !COUNT_ONLY.has(n) && !FUNC_ONLY.has(n))
  .filter((n) => JSON.stringify(enc(SingleStore[n])) !== JSON.stringify(enc(Dialect[n])))
  .sort();
check(
  "settings that differ from the base Dialect",
  gotOverrides,
  ref.overrides.filter((n) => !KNOWN_GAPS.has(n) && !COUNT_ONLY.has(n) && !FUNC_ONLY.has(n)),
);

// ---------------------------------------------------------------------------
// 2. The nested Tokenizer subclass
// ---------------------------------------------------------------------------
const tk = SingleStore.tokenizer_class;
const T = ref.tokenizer;

check("tokenizer_class is the declared nested Tokenizer", tk === SingleStore.Tokenizer, true);
check("tokenizer_class base", Object.getPrototypeOf(tk) === MySQL.tokenizer_class, T.base === "Tokenizer");

check("Tokenizer.QUOTES", enc(tk.QUOTES), T.QUOTES);
check("Tokenizer.COMMENTS", enc(tk.COMMENTS), T.COMMENTS);
check("Tokenizer.IDENTIFIERS", enc(tk.IDENTIFIERS), T.IDENTIFIERS);
check("Tokenizer.STRING_ESCAPES", enc(tk.STRING_ESCAPES), T.STRING_ESCAPES);
check("Tokenizer.BYTE_STRINGS", enc(tk.BYTE_STRINGS), T.BYTE_STRINGS);
check("Tokenizer.BIT_STRINGS", enc(tk.BIT_STRINGS), T.BIT_STRINGS);
check("Tokenizer.HEX_STRINGS", enc(tk.HEX_STRINGS), T.HEX_STRINGS);
check("Tokenizer.ESCAPE_FOLLOW_CHARS", enc(tk.ESCAPE_FOLLOW_CHARS), T.ESCAPE_FOLLOW_CHARS);
check("Tokenizer.NESTED_COMMENTS", tk.NESTED_COMMENTS, T.NESTED_COMMENTS);
check("Tokenizer.KEYWORDS", enc(mapVals(upstreamKeywords(tk.KEYWORDS), tt)), T.KEYWORDS);
check("Tokenizer.COMMANDS", { $s: [...tk.COMMANDS].map(tt).sort(byJson) }, T.COMMANDS);

check("Tokenizer._QUOTES (derived)", enc(tk._QUOTES), T._QUOTES);
check("Tokenizer._IDENTIFIERS (derived)", enc(tk._IDENTIFIERS), T._IDENTIFIERS);
check("Tokenizer._FORMAT_STRINGS (derived)", enc(mapVals(tk._FORMAT_STRINGS, ([e, t]) => [e, tt(t)])), T._FORMAT_STRINGS);
check("Tokenizer._COMMENTS (derived)", enc(tk._COMMENTS), T._COMMENTS);
check("Tokenizer._STRING_ESCAPES (derived)", enc(tk._STRING_ESCAPES), T._STRING_ESCAPES);
check("Tokenizer._KEYWORD_TRIE size (derived)", tk._KEYWORD_TRIE.size, T._KEYWORD_TRIE_SIZE);

// py:44 `BYTE_STRINGS = [("e'", "'"), ("E'", "'")]` -- SingleStore's own override.
check(
  "BYTE_STRINGS differs from base MySQL Tokenizer (py:44 overrides it)",
  JSON.stringify(enc(tk.BYTE_STRINGS)) !== JSON.stringify(enc(MySQL.tokenizer_class.BYTE_STRINGS)),
  T.byte_strings_differ_from_mysql,
);
check("'BSON' in KEYWORDS (py:48 adds it)", tk.KEYWORDS.has("BSON"), T.bson_in_keywords);
check("':>' in KEYWORDS (py:54 adds it)", tk.KEYWORDS.has(":>"), T.colon_gt_in_keywords);
check("'!:>' in KEYWORDS (py:55 adds it)", tk.KEYWORDS.has("!:>"), T.ncolon_gt_in_keywords);
check("'RECORD' in KEYWORDS (py:59 remaps it to STRUCT)", tk.KEYWORDS.has("RECORD"), T.record_in_keywords);
check(
  "'TIMESTAMP' token type (py:50 remaps it to TokenType.TIMESTAMP)",
  tt(tk.KEYWORDS.get("TIMESTAMP")),
  { $t: T.timestamp_token_type },
);
check(
  "'TIMESTAMP' token type in the BASE MySQL Tokenizer (i.e. it was really remapped)",
  tt(MySQL.tokenizer_class.KEYWORDS.get("TIMESTAMP")),
  { $t: T.timestamp_token_type_in_base_mysql },
);

// ---------------------------------------------------------------------------
// 3. VECTOR_TYPE_ALIASES / INVERSE_VECTOR_TYPE_ALIASES
// ---------------------------------------------------------------------------
check("VECTOR_TYPE_ALIASES", enc(SingleStore.VECTOR_TYPE_ALIASES), ref.vector_type_aliases);
check("INVERSE_VECTOR_TYPE_ALIASES", enc(SingleStore.INVERSE_VECTOR_TYPE_ALIASES), ref.inverse_vector_type_aliases);

// ---------------------------------------------------------------------------
// 4. The autofilled classes
// ---------------------------------------------------------------------------
check("parser_class", SingleStore.parser_class === SingleStoreParser, ref.classes.parser_class === "SingleStoreParser");
check("parser_class name", SingleStore.parser_class.name, ref.classes.parser_class);
check("parser_class base", Object.getPrototypeOf(SingleStore.parser_class) === MySQLParser, ref.classes.parser_class_base === "MySQLParser");
check("generator_class", SingleStore.generator_class === SingleStoreGenerator, ref.classes.generator_class === "SingleStoreGenerator");
check("generator_class name", SingleStore.generator_class.name, ref.classes.generator_class);
check("generator_class base", Object.getPrototypeOf(SingleStore.generator_class) === MySQLGenerator, ref.classes.generator_class_base === "MySQLGenerator");
note.push(
  `DEVIATION  tokenizer_class.name: CPython ${JSON.stringify(ref.classes.tokenizer_class)}, port ` +
    `${JSON.stringify(tk.name)} — JS has no nested class declaration; identity is asserted above instead`,
);

// ---------------------------------------------------------------------------
// 5. The dialect instance
// ---------------------------------------------------------------------------
const d = Dialect.get_or_raise("singlestore");
check("get_or_raise('singlestore') resolves to SingleStore", d.constructor === SingleStore, true);
check("instance normalization_strategy", d.normalization_strategy, ref.instance.normalization_strategy);
check("instance version", d.version.map(String), ref.instance.version);

console.log();
console.log(`  SingleStore dialect vs CPython: ${checks - fails.length}/${checks} checks pass`);
console.log(
  `    ${Object.keys(ref.attrs).length} resolved settings (${ref.overrides.length} differ from the base), ` +
    `${upstreamKeywords(tk.KEYWORDS).size} tokenizer keywords`,
);
for (const line of note) console.log(`    ${line}`);
if (fails.length) {
  console.log();
  for (const f of fails) console.log(`    FAIL ${f}`);
  console.log();
  console.log("  SINGLESTORE DIALECT: FAIL");
  process.exit(1);
}
console.log("  SINGLESTORE DIALECT: OK");

/** A `Map` with each VALUE passed through `f`, preserving insertion order. */
function mapVals(m, f) {
  return new Map([...m].map(([k, v]) => [k, f(v)]));
}
