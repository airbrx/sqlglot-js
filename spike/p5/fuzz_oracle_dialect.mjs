// Differential: `src/dialects/oracle.js`'s `Oracle` class vs CPython.
//
//   PYTHONHASHSEED=0 python3 spike/p5/gen_oracle_dialect_ref.py \
//       > spike/out/oracle_dialect.json
//   node spike/p5/fuzz_oracle_dialect.mjs
//
// Same template R21/R42's `fuzz_snowflake_dialect.mjs` established (AIR-2290, "12.5
// Oracle"): the defect class this guards is a hand-transcribed class-level VALUE
// that nothing anywhere else compares against upstream.
//
// Four things are compared:
//
//   1. All RESOLVED settings, value by value (`getattr`, not `vars`): catches a
//      missing override AND an invented one.
//   2. The nested `Tokenizer` subclass: its declared settings and, separately, the
//      values `__init_subclass__` DERIVES (the port must call `initTokenizerSubclass`
//      by hand — JS has no such hook).
//   3. The autofilled `parser_class`/`tokenizer_class`/`generator_class` linkage.
//   4. `can_quote` — Oracle's one method override, a Pseudocolumn-parent DUAL
//      exception (same shape Snowflake's own `can_quote` oracle exercises with a
//      Table-parent "dual" case instead).

import { readFileSync } from "node:fs";
import { upstreamKeywords } from "../../tools/verification_exclusions.mjs";
import { Dialect } from "../../src/dialects/dialect.js";
import { Oracle } from "../../src/dialects/oracle.js";
import { OracleParser } from "../../src/parsers/oracle.js";
import { OracleGenerator } from "../../src/generators/oracle.js";
import { Tokenizer, TOKEN_TYPE_NAMES } from "../../src/tokens.js";
import { TRIE_END } from "../../src/trie.js";
import * as exp from "../../src/expressions/index.js";

const ref = JSON.parse(readFileSync("spike/out/oracle_dialect.json", "utf8"));

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

// `EXPRESSION_METADATA` is the bare base 294-entry table (no `typing/oracle.py`
// upstream) — still a real count comparison (294 vs 294), just unchanged from the
// base `Dialect`'s own.
const COUNT_ONLY = new Set(["EXPRESSION_METADATA"]);

for (const [name, want] of Object.entries(ref.attrs)) {
  if (KNOWN_GAPS.has(name)) {
    note.push(
      `GAP  ${name}: CPython has ${JSON.stringify(want)}, port has ` +
        `{"$count":${Oracle[name].size}} — ${KNOWN_GAPS.get(name)}`,
    );
    continue;
  }
  if (!(name in Oracle)) {
    checks += 1;
    fails.push(`${name}\n       got  <ABSENT from the port>\n       want ${trunc(JSON.stringify(want))}`);
    continue;
  }
  if (COUNT_ONLY.has(name)) {
    check(name, { $count: Oracle[name].size }, want);
    continue;
  }
  const got = want !== null && typeof want === "object" && "$e" in want
    ? { $e: Oracle[name] }
    : enc(Oracle[name]);
  check(name, got, want);
}

// The reverse direction: a setting the port invented on this class, or one upstream
// dropped.
const upstreamNames = new Set(Object.keys(ref.attrs));
for (let k = Oracle; k && k !== Function.prototype; k = Object.getPrototypeOf(k)) {
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
  .filter((n) => JSON.stringify(enc(Oracle[n])) !== JSON.stringify(enc(Dialect[n])))
  .sort();
check(
  "settings that differ from the base Dialect",
  gotOverrides,
  ref.overrides.filter((n) => !KNOWN_GAPS.has(n) && !COUNT_ONLY.has(n)),
);

// ---------------------------------------------------------------------------
// 2. The nested Tokenizer subclass
// ---------------------------------------------------------------------------
const tk = Oracle.tokenizer_class;
const T = ref.tokenizer;

check("tokenizer_class is the declared nested Tokenizer", tk === Oracle.Tokenizer, true);
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

// py:72 `"(+)": TokenType.JOIN_MARKER` — Oracle's own outer-join marker keyword.
check('"(+)" in KEYWORDS', tk.KEYWORDS.has("(+)"), T.join_marker_in_keywords);

// ---------------------------------------------------------------------------
// 3. The autofilled classes
// ---------------------------------------------------------------------------
check("parser_class", Oracle.parser_class === OracleParser, ref.classes.parser_class === "OracleParser");
check("parser_class name", Oracle.parser_class.name, ref.classes.parser_class);
check("generator_class", Oracle.generator_class === OracleGenerator, ref.classes.generator_class === "OracleGenerator");
check("generator_class name", Oracle.generator_class.name, ref.classes.generator_class);
// Upstream's nested class is literally named `Tokenizer`, same as every other
// dialect's own nested class; JS has no nested class declaration, so the port names
// it `OracleTokenizer` at module level. Recorded as a deviation with both names
// printed rather than asserted away, same precedent `fuzz_snowflake_dialect.mjs` set.
note.push(
  `DEVIATION  tokenizer_class.name: CPython ${JSON.stringify(ref.classes.tokenizer_class)}, port ` +
    `${JSON.stringify(tk.name)} — JS has no nested class declaration; identity is asserted above instead`,
);

// ---------------------------------------------------------------------------
// 4. `can_quote` — the Pseudocolumn-parent DUAL exception
// ---------------------------------------------------------------------------
const d = Dialect.get_or_raise("oracle");
check("get_or_raise('oracle') resolves to Oracle", d.constructor === Oracle, true);
check("instance normalization_strategy", d.normalization_strategy, ref.instance.normalization_strategy);
check("instance version", d.version.map(String), ref.instance.version);

let dualCases = 0;
for (const row of ref.can_quote) {
  const label =
    `can_quote(Identifier(${JSON.stringify(row.text)}, quoted=${row.quoted})` +
    `${row.parent ? ` in ${row.parent}` : ""}, identify=${JSON.stringify(row.identify)})`;
  let got;
  try {
    const ident = new exp.Identifier({ this: row.text, quoted: row.quoted });
    // Constructing the parent is what sets `ident.parent`, which is what py:56 tests.
    if (row.parent === "pseudocolumn") new exp.Pseudocolumn({ this: ident });
    else if (row.parent === "table") new exp.Table({ this: ident });
    got = d.can_quote(ident, row.identify);
  } catch (e) {
    got = { error: e.message };
  }
  if (row.parent === "pseudocolumn" && !row.quoted) dualCases += 1;
  check(label, got, row.out);
}

console.log();
console.log(`  Oracle dialect vs CPython: ${checks - fails.length}/${checks} checks pass`);
console.log(
  `    ${Object.keys(ref.attrs).length} resolved settings (${ref.overrides.length} differ from the base), ` +
    `${upstreamKeywords(tk.KEYWORDS).size} tokenizer keywords, ${ref.can_quote.length} can_quote cases ` +
    `(${dualCases} of them the Pseudocolumn-parent DUAL exception)`,
);
for (const line of note) console.log(`    ${line}`);
if (fails.length) {
  console.log();
  for (const f of fails) console.log(`    FAIL ${f}`);
  console.log();
  console.log("  ORACLE DIALECT: FAIL");
  process.exit(1);
}
console.log("  ORACLE DIALECT: OK");

/** A `Map` with each VALUE passed through `f`, preserving insertion order. */
function mapVals(m, f) {
  return new Map([...m].map(([k, v]) => [k, f(v)]));
}
