// Differential: `src/dialects/fabric.js`'s `Fabric` class vs CPython.
//
//   PYTHONHASHSEED=0 python3 spike/p5/gen_fabric_dialect_ref.py \
//       > spike/out/fabric_dialect.json
//   node spike/p5/fuzz_fabric_dialect.mjs
//
// AIR-2292, epic AIR-2272, "12.7 Small dialects", batch A. Same template R38's
// `fuzz_redshift_dialect.mjs`/R105's `fuzz_trino_dialect.mjs` established, applied to
// the T-SQL chain rather than Postgres: the settings/overrides check verifies TSQL's
// own ~10 settings/Tokenizer survive unshadowed through another level of JS static
// inheritance.
//
// Four things are compared:
//
//   1. All RESOLVED settings, value by value (`getattr`, not `vars`): catches a
//      missing override AND an invented one.
//   2. The nested `Tokenizer` subclass (`TSQL.Tokenizer` with `TIMESTAMP` remapped
//      and `UTINYINT` added).
//   3. The autofilled `parser_class`/`tokenizer_class`/`generator_class` linkage.
//   4. The dialect instance's resolved `version`/`normalization_strategy`.
//
// Fabric overrides no method on the `Dialect` class itself, so there is no section 5
// (`parsers/fabric.js`/`generators/fabric.js` have their own corpus-driven coverage).

import { readFileSync } from "node:fs";
import { upstreamKeywords } from "../../tools/verification_exclusions.mjs";
import { Dialect } from "../../src/dialects/dialect.js";
import { TSQL } from "../../src/dialects/tsql.js";
import { Fabric } from "../../src/dialects/fabric.js";
import { FabricParser } from "../../src/parsers/fabric.js";
import { TSQLParser } from "../../src/parsers/tsql.js";
import { FabricGenerator } from "../../src/generators/fabric.js";
import { TSQLGenerator } from "../../src/generators/tsql.js";
import { TOKEN_TYPE_NAMES } from "../../src/tokens.js";
import { TRIE_END } from "../../src/trie.js";

const ref = JSON.parse(readFileSync("spike/out/fabric_dialect.json", "utf8"));

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

// `EXPRESSION_METADATA` is inherited verbatim from `TSQL` (no `typing/fabric.js`
// exists); still a count-only comparison, same reason every sibling oracle uses one.
const COUNT_ONLY = new Set(["EXPRESSION_METADATA"]);

for (const [name, want] of Object.entries(ref.attrs)) {
  if (KNOWN_GAPS.has(name)) {
    note.push(
      `GAP  ${name}: CPython has ${JSON.stringify(want)}, port has ` +
        `{"$count":${Fabric[name].size}} — ${KNOWN_GAPS.get(name)}`,
    );
    continue;
  }
  if (!(name in Fabric)) {
    checks += 1;
    fails.push(`${name}\n       got  <ABSENT from the port>\n       want ${trunc(JSON.stringify(want))}`);
    continue;
  }
  if (COUNT_ONLY.has(name)) {
    check(name, { $count: Fabric[name].size }, want);
    continue;
  }
  const got = want !== null && typeof want === "object" && "$e" in want
    ? { $e: Fabric[name] }
    : enc(Fabric[name]);
  check(name, got, want);
}

// The reverse direction: a setting the port invented on this class, or one upstream
// dropped.
const upstreamNames = new Set(Object.keys(ref.attrs));
for (let k = Fabric; k && k !== Function.prototype; k = Object.getPrototypeOf(k)) {
  for (const name of Object.getOwnPropertyNames(k)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    checks += 1;
    if (!upstreamNames.has(name)) fails.push(`${name}: present in the port, absent upstream`);
  }
}

// Which settings actually DIFFER from the base, as a set.
const gotOverrides = Object.keys(ref.attrs)
  .filter((n) => !KNOWN_GAPS.has(n) && !COUNT_ONLY.has(n))
  .filter((n) => JSON.stringify(enc(Fabric[n])) !== JSON.stringify(enc(Dialect[n])))
  .sort();
check(
  "settings that differ from the base Dialect",
  gotOverrides,
  ref.overrides.filter((n) => !KNOWN_GAPS.has(n) && !COUNT_ONLY.has(n)),
);

// ---------------------------------------------------------------------------
// 2. The nested Tokenizer subclass
// ---------------------------------------------------------------------------
const tk = Fabric.tokenizer_class;
const T = ref.tokenizer;

check("tokenizer_class is the declared nested Tokenizer", tk === Fabric.Tokenizer, true);
check("tokenizer_class base", Object.getPrototypeOf(tk) === TSQL.tokenizer_class, T.base === "Tokenizer");

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

// py:40 remaps TIMESTAMP; py:41 adds UTINYINT.
check("TIMESTAMP token (py:40 remaps it from T-SQL's own ROWVERSION)", tt(tk.KEYWORDS.get("TIMESTAMP")), { $t: T.timestamp_token });
check("UTINYINT in KEYWORDS (py:41 adds it)", tk.KEYWORDS.has("UTINYINT"), T.utinyint_in_keywords);
check("TIMESTAMP token in the BASE TSQL Tokenizer.KEYWORDS (i.e. what was really remapped)", tt(TSQL.tokenizer_class.KEYWORDS.get("TIMESTAMP")), { $t: T.timestamp_token_in_base_tsql_keywords });
check("UTINYINT absent from the BASE TSQL Tokenizer.KEYWORDS (i.e. it was really new)", TSQL.tokenizer_class.KEYWORDS.has("UTINYINT"), T.utinyint_in_base_tsql_keywords);

// ---------------------------------------------------------------------------
// 3. The autofilled classes
// ---------------------------------------------------------------------------
check("parser_class", Fabric.parser_class === FabricParser, ref.classes.parser_class === "FabricParser");
check("parser_class name", Fabric.parser_class.name, ref.classes.parser_class);
check("parser_class base", Object.getPrototypeOf(Fabric.parser_class) === TSQLParser, ref.classes.parser_class_base === "TSQLParser");
check("generator_class", Fabric.generator_class === FabricGenerator, ref.classes.generator_class === "FabricGenerator");
check("generator_class name", Fabric.generator_class.name, ref.classes.generator_class);
check("generator_class base", Object.getPrototypeOf(Fabric.generator_class) === TSQLGenerator, ref.classes.generator_class_base === "TSQLGenerator");
note.push(
  `DEVIATION  tokenizer_class.name: CPython ${JSON.stringify(ref.classes.tokenizer_class)}, port ` +
    `${JSON.stringify(tk.name)} — JS has no nested class declaration; identity is asserted above instead`,
);

// ---------------------------------------------------------------------------
// 4. The dialect instance
// ---------------------------------------------------------------------------
const d = Dialect.get_or_raise("fabric");
check("get_or_raise('fabric') resolves to Fabric", d.constructor === Fabric, true);
check("instance normalization_strategy", d.normalization_strategy, ref.instance.normalization_strategy);
check("instance version", d.version.map(String), ref.instance.version);

console.log();
console.log(`  Fabric dialect vs CPython: ${checks - fails.length}/${checks} checks pass`);
console.log(
  `    ${Object.keys(ref.attrs).length} resolved settings (${ref.overrides.length} differ from the base), ` +
    `${upstreamKeywords(tk.KEYWORDS).size} tokenizer keywords`,
);
for (const line of note) console.log(`    ${line}`);
if (fails.length) {
  console.log();
  for (const f of fails) console.log(`    FAIL ${f}`);
  console.log();
  console.log("  FABRIC DIALECT: FAIL");
  process.exit(1);
}
console.log("  FABRIC DIALECT: OK");

/** A `Map` with each VALUE passed through `f`, preserving insertion order. */
function mapVals(m, f) {
  return new Map([...m].map(([k, v]) => [k, f(v)]));
}
