import { upstreamKeywords } from "../../tools/verification_exclusions.mjs";
// Differential: `src/dialects/mysql.js`'s `MySQL` class vs CPython.
//
//   PYTHONHASHSEED=0 python3 spike/p5/gen_mysql_dialect_ref.py \
//       > spike/out/mysql_dialect.json
//   node spike/p5/fuzz_mysql_dialect.mjs
//
// Same shape as `fuzz_duckdb_dialect.mjs`/`fuzz_snowflake_dialect.mjs` (PORT_PLAN.md
// R42's template): `fuzz_dialect_parse.mjs` measures whether the class makes rows
// PARSE, which is a real signal but a coarse one — most of MySQL's ~9 overridden
// settings have no reader on the parse path at all, and a wrong one would sit silent
// until the P4 generator finally reads it (R21's hazard class: a hand-transcribed
// class-level VALUE that nothing anywhere compares against upstream).
//
// Two things are compared (MySQL declares no method overrides, unlike DuckDB's
// `to_json_path` or Snowflake's `can_quote`, so there is no section 3 here):
//
//   1. All RESOLVED settings, value by value. Resolved (`getattr`), not own (`vars`),
//      so it catches a missing override AND an invented one.
//   2. The nested `Tokenizer` subclass: its declared settings (QUOTES, COMMENTS,
//      IDENTIFIERS, STRING_ESCAPES, BIT_STRINGS, HEX_STRINGS, ESCAPE_FOLLOW_CHARS,
//      NESTED_COMMENTS, KEYWORDS, COMMANDS) and, separately, the values
//      `__init_subclass__`/`initTokenizerSubclass` DERIVE — including `BIT_START`/
//      `BIT_END` on the `Dialect` class itself (py:849, `_Dialect.__new__` derives
//      these from `Tokenizer.BIT_STRINGS` at class-creation time; `registerDialect`'s
//      settings-mirroring is this port's JS equivalent, PORT_PLAN.md R20).

import { readFileSync } from "node:fs";
import { Dialect } from "../../src/dialects/dialect.js";
import { MySQL } from "../../src/dialects/mysql.js";
import { MySQLParser } from "../../src/parsers/mysql.js";
import { MySQLGenerator } from "../../src/generators/mysql.js";
import { Tokenizer, TokenType, TOKEN_TYPE_NAMES } from "../../src/tokens.js";
import { TRIE_END } from "../../src/trie.js";

const ref = JSON.parse(readFileSync("spike/out/mysql_dialect.json", "utf8"));

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

/**
 * A `TokenType` is a plain integer on this side and an `IntEnum` upstream, and the two
 * numberings are not asserted to agree anywhere — so both sides encode it by NAME.
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

/** A `Map` with each VALUE passed through `f`, preserving insertion order. */
function mapVals(m, f) {
  return new Map([...m].map(([k, v]) => [k, f(v)]));
}

// ---------------------------------------------------------------------------
// 1. The resolved settings
// ---------------------------------------------------------------------------
const KNOWN_GAPS = new Map([]);

// `EXPRESSION_METADATA`'s values are closures (`{annotator: fn}`)/plain option records
// (`{returns: DType}`), neither of which `enc()` can encode — same unencodable-lambda
// problem `gen_mysql_dialect_ref.py`'s own `COUNT_ONLY` set solves on the CPython
// side. `src/typing/mysql.js` is a real 335-entry table (294 base + MySQL's own
// overlay), so this is a real count comparison (335 vs 335), not a placeholder.
const COUNT_ONLY = new Set(["EXPRESSION_METADATA"]);

for (const [name, want] of Object.entries(ref.attrs)) {
  if (KNOWN_GAPS.has(name)) {
    note.push(
      `GAP  ${name}: CPython has ${JSON.stringify(want)}, port has ` +
        `{"$count":${MySQL[name].size}} — ${KNOWN_GAPS.get(name)}`,
    );
    continue;
  }
  if (!(name in MySQL)) {
    checks += 1;
    fails.push(`${name}\n       got  <ABSENT from the port>\n       want ${trunc(JSON.stringify(want))}`);
    continue;
  }
  if (COUNT_ONLY.has(name)) {
    check(name, { $count: MySQL[name].size }, want);
    continue;
  }
  const got = want !== null && typeof want === "object" && "$e" in want
    ? { $e: MySQL[name] }
    : enc(MySQL[name]);
  check(name, got, want);
}

// The reverse direction: a setting the port invented on this class, or one upstream
// dropped.
const upstreamNames = new Set(Object.keys(ref.attrs));
for (let k = MySQL; k && k !== Function.prototype; k = Object.getPrototypeOf(k)) {
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
  .filter((n) => JSON.stringify(enc(MySQL[n])) !== JSON.stringify(enc(Dialect[n])))
  .sort();
check(
  "settings that differ from the base Dialect",
  gotOverrides,
  ref.overrides.filter((n) => !KNOWN_GAPS.has(n) && !COUNT_ONLY.has(n)),
);

// ---------------------------------------------------------------------------
// 2. The nested Tokenizer subclass
// ---------------------------------------------------------------------------
const tk = MySQL.tokenizer_class;
const T = ref.tokenizer;

check("tokenizer_class is the declared nested Tokenizer", tk === MySQL.Tokenizer, true);
check("tokenizer_class base", Object.getPrototypeOf(tk) === Tokenizer, T.base === "Tokenizer");

check("Tokenizer.QUOTES", enc(tk.QUOTES), T.QUOTES);
check("Tokenizer.COMMENTS", enc(tk.COMMENTS), T.COMMENTS);
check("Tokenizer.IDENTIFIERS", enc(tk.IDENTIFIERS), T.IDENTIFIERS);
check("Tokenizer.STRING_ESCAPES", enc(tk.STRING_ESCAPES), T.STRING_ESCAPES);
check("Tokenizer.BIT_STRINGS", enc(tk.BIT_STRINGS), T.BIT_STRINGS);
check("Tokenizer.HEX_STRINGS", enc(tk.HEX_STRINGS), T.HEX_STRINGS);
check("Tokenizer.ESCAPE_FOLLOW_CHARS", enc(tk.ESCAPE_FOLLOW_CHARS), T.ESCAPE_FOLLOW_CHARS);
check("Tokenizer.NESTED_COMMENTS", tk.NESTED_COMMENTS, T.NESTED_COMMENTS);
check("Tokenizer.KEYWORDS", enc(mapVals(upstreamKeywords(tk.KEYWORDS), tt)), T.KEYWORDS);
check("Tokenizer.COMMANDS", { $s: [...tk.COMMANDS].map(tt).sort(byJson) }, T.COMMANDS);

// Derived by `initTokenizerSubclass`. If that call were missing these would silently be
// the BASE tokenizer's.
check("Tokenizer._QUOTES (derived)", enc(tk._QUOTES), T._QUOTES);
check("Tokenizer._IDENTIFIERS (derived)", enc(tk._IDENTIFIERS), T._IDENTIFIERS);
check("Tokenizer._FORMAT_STRINGS (derived)", enc(mapVals(tk._FORMAT_STRINGS, ([e, t]) => [e, tt(t)])), T._FORMAT_STRINGS);
check("Tokenizer._COMMENTS (derived)", enc(tk._COMMENTS), T._COMMENTS);
check("Tokenizer._STRING_ESCAPES (derived)", enc(tk._STRING_ESCAPES), T._STRING_ESCAPES);
check("Tokenizer._KEYWORD_TRIE size (derived)", tk._KEYWORD_TRIE.size, T._KEYWORD_TRIE_SIZE);

check("HINT_START in KEYWORDS", tk.KEYWORDS.has(tk.HINT_START), T.hint_start_in_keywords);
check("HINT_START in _COMMENTS", tk._COMMENTS.has(tk.HINT_START), T.hint_start_in_comments);
// py:156 `COMMANDS = {*tokens.Tokenizer.COMMANDS, TokenType.REPLACE} - {TokenType.SHOW}`.
check("SHOW in COMMANDS (py:156 removes it)", tk.COMMANDS.has(TokenType.SHOW), T.show_in_commands);
check("SHOW in the BASE Tokenizer.COMMANDS (i.e. it was really removed)", Tokenizer.COMMANDS.has(TokenType.SHOW), true);
check("REPLACE in COMMANDS (py:156 adds it)", tk.COMMANDS.has(TokenType.REPLACE), T.replace_in_commands);
check("REPLACE NOT in the BASE Tokenizer.COMMANDS (i.e. it was really added)", Tokenizer.COMMANDS.has(TokenType.REPLACE), false);

// ---------------------------------------------------------------------------
// 3. The autofilled classes + instance
// ---------------------------------------------------------------------------
check("parser_class", MySQL.parser_class === MySQLParser, ref.classes.parser_class === "MySQLParser");
check("parser_class name", MySQL.parser_class.name, ref.classes.parser_class);
check("generator_class", MySQL.generator_class === MySQLGenerator, ref.classes.generator_class === "MySQLGenerator");
check("generator_class name", MySQL.generator_class.name, ref.classes.generator_class);
note.push(
  `DEVIATION  tokenizer_class.name: CPython ${JSON.stringify(ref.classes.tokenizer_class)}, port ` +
    `${JSON.stringify(tk.name)} — JS has no nested class declaration; identity is asserted above instead`,
);

const d = Dialect.get_or_raise("mysql");
check("get_or_raise('mysql') resolves to MySQL", d.constructor === MySQL, true);
check("instance normalization_strategy", d.normalization_strategy, ref.instance.normalization_strategy);
check("instance version", d.version.map(String), ref.instance.version);

console.log();
console.log(`  MySQL dialect vs CPython: ${checks - fails.length}/${checks} checks pass`);
console.log(
  `    ${Object.keys(ref.attrs).length} resolved settings (${ref.overrides.length} differ from the base), ` +
    `${ref.tokenizer.KEYWORDS.$d.length} tokenizer keywords`,
);
for (const line of note) console.log(`    ${line}`);
if (fails.length) {
  console.log();
  for (const f of fails) console.log(`    FAIL ${f}`);
  console.log();
  console.log("  MYSQL DIALECT: FAIL");
  process.exit(1);
}
console.log("  MYSQL DIALECT: OK");
