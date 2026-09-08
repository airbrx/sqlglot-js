// Differential: `src/dialects/snowflake.js`'s `Snowflake` class vs CPython.
//
//   PYTHONHASHSEED=0 python3 spike/p5/gen_snowflake_dialect_ref.py \
//       > spike/out/snowflake_dialect.json
//   node spike/p5/fuzz_snowflake_dialect.mjs
//
// `fuzz_dialect_defaults.mjs` does this for the BASE `Dialect`. This is the same check
// one class down, and PORT_PLAN.md R21 is the reason it exists: the defect class that
// round found is **a hand-transcribed class-level VALUE that nothing anywhere compares
// against upstream**, and `dialects/snowflake.py` is almost nothing but such values.
// `fuzz_dialect_parse.mjs` measures whether the class makes rows PARSE, which is a real
// signal but a coarse one — 31 of Snowflake's ~105 resolved settings differ from the
// base, most have no reader on the parse path at all, and a wrong one would sit silent
// until the P4 generator or the P6 optimizer finally read it.
//
// Four things are compared, and the last two are the ones a reading of the upstream file
// cannot give you:
//
//   1. All 105 RESOLVED settings, value by value. Resolved (`getattr`), not own
//      (`vars`), so it catches a missing override AND an invented one — the port
//      declaring a setting upstream leaves inherited is just as wrong, and no
//      "did we transcribe every line of the class body?" review can see it.
//   2. The nested `Tokenizer` subclass: its declared settings and, separately, the six
//      values `__init_subclass__` DERIVES. The port must call `initTokenizerSubclass`
//      by hand (JS has no such hook); skipping that call leaves every derived value
//      inherited from the base tokenizer, which is a total failure of the Snowflake
//      lexer that nonetheless still parses most SQL.
//   3. The twelve settings `registerDialect` derives rather than reads. Reading the
//      upstream class body gives the wrong answer for all twelve.
//   4. `can_quote`'s DUAL exception, the class's one method override, over 168 cases.

import { readFileSync } from "node:fs";
import * as exp from "../../src/expressions/index.js";
import { Dialect } from "../../src/dialects/dialect.js";
import { Snowflake } from "../../src/dialects/snowflake.js";
import { SnowflakeParser } from "../../src/parsers/snowflake.js";
import { Tokenizer, TokenType, TOKEN_TYPE_NAMES } from "../../src/tokens.js";
import { TRIE_END } from "../../src/trie.js";

const ref = JSON.parse(readFileSync("spike/out/snowflake_dialect.json", "utf8"));

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
  // Already encoded by `tt` before being handed back to `enc` — `_FORMAT_STRINGS`'s
  // values are `[end, TokenType]` pairs, so the TokenType is wrapped on the way in.
  if (typeof v === "object" && "$t" in v) return v;
  throw new Error(`unencodable JS value: ${String(v)}`);
}

/**
 * A `TokenType` is a plain integer on this side and an `IntEnum` upstream, and the two
 * numberings are not asserted to agree anywhere — so both sides encode it by NAME, the
 * same `$t` wire format `corpus/tokens/settings.json` uses. Applied only where a
 * TokenType is expected, because a genuine integer setting (`INDEX_OFFSET`,
 * `REGEXP_EXTRACT_DEFAULT_GROUP`) must stay a bare number.
 */
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
// 1. The 105 resolved settings
// ---------------------------------------------------------------------------
// `NORMALIZATION_STRATEGY` needs no special casing: upstream's enum derives from `str`,
// so `{"$e": "UPPERCASE"}` on the oracle side is compared against the port's frozen
// string map by unwrapping `$e` here rather than wrapping there.
const KNOWN_GAPS = new Map([
  [
    "EXPRESSION_METADATA",
    "sqlglot/typing/snowflake.py + optimizer/annotate_types.py are unported (P6+); the port carries an empty Map",
  ],
]);

for (const [name, want] of Object.entries(ref.attrs)) {
  if (KNOWN_GAPS.has(name)) {
    note.push(
      `GAP  ${name}: CPython has ${JSON.stringify(want)}, port has ` +
        `{"$count":${Snowflake[name].size}} — ${KNOWN_GAPS.get(name)}`,
    );
    continue;
  }
  if (!(name in Snowflake)) {
    checks += 1;
    fails.push(`${name}\n       got  <ABSENT from the port>\n       want ${trunc(JSON.stringify(want))}`);
    continue;
  }
  const got = want !== null && typeof want === "object" && "$e" in want
    ? { $e: Snowflake[name] }
    : enc(Snowflake[name]);
  check(name, got, want);
}

// The reverse direction: a setting the port invented on this class, or one upstream
// dropped. `Object.getOwnPropertyNames` walks the whole chain here because the oracle's
// name list is itself the union of Snowflake's own and the base's.
const upstreamNames = new Set(Object.keys(ref.attrs));
for (let k = Snowflake; k && k !== Function.prototype; k = Object.getPrototypeOf(k)) {
  for (const name of Object.getOwnPropertyNames(k)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    checks += 1;
    if (!upstreamNames.has(name)) fails.push(`${name}: present in the port, absent upstream`);
  }
}

// Which settings actually DIFFER from the base, as a set. Guards the failure mode a
// value-by-value pass cannot: if the port had silently mutated the BASE class instead of
// subclassing it, every value above would still match while `Dialect` was corrupted.
const gotOverrides = Object.keys(ref.attrs)
  .filter((n) => !KNOWN_GAPS.has(n))
  .filter((n) => JSON.stringify(enc(Snowflake[n])) !== JSON.stringify(enc(Dialect[n])))
  .sort();
check("settings that differ from the base Dialect", gotOverrides, ref.overrides.filter((n) => !KNOWN_GAPS.has(n)));

// ---------------------------------------------------------------------------
// 2. The nested Tokenizer subclass
// ---------------------------------------------------------------------------
const tk = Snowflake.tokenizer_class;
const T = ref.tokenizer;

// `klass.Tokenizer` is what py:291 looks for; that it is ALSO what `tokenizer_class`
// ends up pointing at is `registerDialect`'s job, asserted rather than assumed.
check("tokenizer_class is the declared nested Tokenizer", tk === Snowflake.Tokenizer, true);
check("tokenizer_class base", Object.getPrototypeOf(tk) === Tokenizer, T.base === "Tokenizer");

// Declared settings.
check("Tokenizer.KEYWORDS", enc(mapVals(tk.KEYWORDS, tt)), T.KEYWORDS);
check("Tokenizer.SINGLE_TOKENS", enc(mapVals(tk.SINGLE_TOKENS, tt)), T.SINGLE_TOKENS);
check("Tokenizer.COMMANDS", { $s: [...tk.COMMANDS].map(tt).sort(byJson) }, T.COMMANDS);
check("Tokenizer.COMMENTS", enc(tk.COMMENTS), T.COMMENTS);
check("Tokenizer.STRING_ESCAPES", enc(tk.STRING_ESCAPES), T.STRING_ESCAPES);
check("Tokenizer.HEX_STRINGS", enc(tk.HEX_STRINGS), T.HEX_STRINGS);
check("Tokenizer.RAW_STRINGS", enc(tk.RAW_STRINGS), T.RAW_STRINGS);
check("Tokenizer.VAR_SINGLE_TOKENS", enc(tk.VAR_SINGLE_TOKENS), T.VAR_SINGLE_TOKENS);
check("Tokenizer.NESTED_COMMENTS", tk.NESTED_COMMENTS, T.NESTED_COMMENTS);

// Derived by `initTokenizerSubclass`. If that call were missing these would silently be
// the BASE tokenizer's, which is the single most consequential thing this probe checks.
check("Tokenizer.BYTE_STRING_ESCAPES (derived: copy of STRING_ESCAPES)", enc(tk.BYTE_STRING_ESCAPES), T.BYTE_STRING_ESCAPES);
check("Tokenizer._QUOTES (derived)", enc(tk._QUOTES), T._QUOTES);
check("Tokenizer._IDENTIFIERS (derived)", enc(tk._IDENTIFIERS), T._IDENTIFIERS);
check("Tokenizer._FORMAT_STRINGS (derived)", enc(mapVals(tk._FORMAT_STRINGS, ([e, t]) => [e, tt(t)])), T._FORMAT_STRINGS);
check("Tokenizer._COMMENTS (derived)", enc(tk._COMMENTS), T._COMMENTS);
check("Tokenizer._STRING_ESCAPES (derived)", enc(tk._STRING_ESCAPES), T._STRING_ESCAPES);
check("Tokenizer._KEYWORD_TRIE size (derived)", tk._KEYWORD_TRIE.size, T._KEYWORD_TRIE_SIZE);

// py:154 `KEYWORDS.pop("/*+")`, and its downstream consequence. Asserted separately from
// the KEYWORDS dump because the consequence is what matters and it lives elsewhere.
check("HINT_START in KEYWORDS (py:154 pops it)", tk.KEYWORDS.has(tk.HINT_START), T.hint_start_in_keywords);
check("HINT_START in _COMMENTS", tk._COMMENTS.has(tk.HINT_START), T.hint_start_in_comments);
check("SHOW in COMMANDS (py:187 removes it)", tk.COMMANDS.has(TokenType.SHOW), T.show_in_commands);
// The inherited half of the same line: removing SHOW must not have removed anything
// else, and `COMMANDS` above already pins the survivors by name.
check("SHOW in the BASE Tokenizer.COMMANDS (i.e. it was really removed)", Tokenizer.COMMANDS.has(TokenType.SHOW), true);

// ---------------------------------------------------------------------------
// 3. The autofilled classes
// ---------------------------------------------------------------------------
check("parser_class", Snowflake.parser_class === SnowflakeParser, ref.classes.parser_class === "SnowflakeParser");
check("parser_class name", Snowflake.parser_class.name, ref.classes.parser_class);
note.push(
  `GAP  generator_class: CPython has ${JSON.stringify(ref.classes.generator_class)}, port has null — ` +
    "generators/snowflake.js is P4 (the base Generator landed; per-dialect ones deferred, R21)",
);
note.push(
  `GAP  jsonpath_tokenizer_class: CPython has ${JSON.stringify(ref.classes.jsonpath_tokenizer_class)}, ` +
    "port has null — sqlglot/jsonpath.py is P4, same as the base Dialect's",
);
// Upstream's nested class is literally named `Tokenizer`; JS has no nested class
// declaration, so the port names it `SnowflakeTokenizer` at module level. Recorded as a
// deviation with both names printed rather than asserted away, because `.name` is not a
// contract in this port (see `registerDialect`'s own note on why the registry key is a
// parameter and not `klass.name`).
note.push(
  `DEVIATION  tokenizer_class.name: CPython ${JSON.stringify(ref.classes.tokenizer_class)}, port ` +
    `${JSON.stringify(tk.name)} — JS has no nested class declaration; identity is asserted above instead`,
);

// ---------------------------------------------------------------------------
// 4. `can_quote` — the DUAL exception
// ---------------------------------------------------------------------------
const d = Dialect.get_or_raise("snowflake");
check("get_or_raise('snowflake') resolves to Snowflake", d.constructor === Snowflake, true);
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
    // Constructing the parent is what sets `ident.parent`, which is what py:126 tests.
    if (row.parent === "table") new exp.Table({ this: ident });
    else if (row.parent === "func") new exp.Anonymous({ this: ident, expressions: [] });
    got = d.can_quote(ident, row.identify);
  } catch (e) {
    got = { error: e.message };
  }
  if (row.parent === "table" && row.text.toLowerCase() === "dual") dualCases += 1;
  check(label, got, row.out);
}

console.log();
console.log(`  Snowflake dialect vs CPython: ${checks - fails.length}/${checks} checks pass`);
console.log(
  `    ${Object.keys(ref.attrs).length} resolved settings (${ref.overrides.length} differ from the base), ` +
    `${ref.tokenizer.KEYWORDS.$d.length} tokenizer keywords, ${ref.can_quote.length} can_quote cases ` +
    `(${dualCases} of them the DUAL exception)`,
);
for (const line of note) console.log(`    ${line}`);
if (fails.length) {
  console.log();
  for (const f of fails) console.log(`    FAIL ${f}`);
  console.log();
  console.log("  SNOWFLAKE DIALECT: FAIL");
  process.exit(1);
}
console.log("  SNOWFLAKE DIALECT: OK");

/** A `Map` with each VALUE passed through `f`, preserving insertion order. */
function mapVals(m, f) {
  return new Map([...m].map(([k, v]) => [k, f(v)]));
}
