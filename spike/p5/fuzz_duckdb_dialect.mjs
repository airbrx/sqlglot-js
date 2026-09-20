// Differential: `src/dialects/duckdb.js`'s `DuckDB` class vs CPython.
//
//   PYTHONHASHSEED=0 python3 spike/p5/gen_duckdb_dialect_ref.py \
//       > spike/out/duckdb_dialect.json
//   node spike/p5/fuzz_duckdb_dialect.mjs
//
// Same shape as `fuzz_snowflake_dialect.mjs`, one class down: `fuzz_dialect_parse.mjs`
// measures whether the class makes rows PARSE, which is a real signal but a coarse
// one — most of DuckDB's ~14 overridden settings have no reader on the parse path at
// all, and a wrong one would sit silent until the P4 generator or the P6 optimizer
// finally reads it (PORT_PLAN.md R21's hazard class: a hand-transcribed class-level
// VALUE that nothing anywhere compares against upstream).
//
// Three things are compared:
//
//   1. All 105 RESOLVED settings, value by value. Resolved (`getattr`), not own
//      (`vars`), so it catches a missing override AND an invented one.
//   2. The nested `Tokenizer` subclass: its declared settings (including the
//      heredoc/byte-string support DuckDB adds that Snowflake doesn't have) and,
//      separately, the values `__init_subclass__` DERIVES.
//   3. `to_json_path`, DuckDB's one method override — the JSON-pointer and
//      back-of-list fast paths, and the fall-through to the (unported, NotPorted)
//      base implementation for everything else.

import { readFileSync } from "node:fs";
import * as exp from "../../src/expressions/index.js";
import { Dialect } from "../../src/dialects/dialect.js";
import { DuckDB } from "../../src/dialects/duckdb.js";
import { DuckDBParser } from "../../src/parsers/duckdb.js";
import { Tokenizer, TokenType, TOKEN_TYPE_NAMES } from "../../src/tokens.js";
import { TRIE_END } from "../../src/trie.js";

const ref = JSON.parse(readFileSync("spike/out/duckdb_dialect.json", "utf8"));

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

// ---------------------------------------------------------------------------
// 1. The 105 resolved settings
// ---------------------------------------------------------------------------
const KNOWN_GAPS = new Map([
  [
    "EXPRESSION_METADATA",
    "sqlglot/typing/duckdb.py's own 16-entry overlay is unported (AIR-2098+); " +
      "the base 294-entry table (AIR-2096/AIR-2097) is real and inherited from Dialect",
  ],
]);

for (const [name, want] of Object.entries(ref.attrs)) {
  if (KNOWN_GAPS.has(name)) {
    note.push(
      `GAP  ${name}: CPython has ${JSON.stringify(want)}, port has ` +
        `{"$count":${DuckDB[name].size}} — ${KNOWN_GAPS.get(name)}`,
    );
    continue;
  }
  if (!(name in DuckDB)) {
    checks += 1;
    fails.push(`${name}\n       got  <ABSENT from the port>\n       want ${trunc(JSON.stringify(want))}`);
    continue;
  }
  const got = want !== null && typeof want === "object" && "$e" in want
    ? { $e: DuckDB[name] }
    : enc(DuckDB[name]);
  check(name, got, want);
}

// The reverse direction: a setting the port invented on this class, or one upstream
// dropped.
const upstreamNames = new Set(Object.keys(ref.attrs));
for (let k = DuckDB; k && k !== Function.prototype; k = Object.getPrototypeOf(k)) {
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
  .filter((n) => !KNOWN_GAPS.has(n))
  .filter((n) => JSON.stringify(enc(DuckDB[n])) !== JSON.stringify(enc(Dialect[n])))
  .sort();
check("settings that differ from the base Dialect", gotOverrides, ref.overrides.filter((n) => !KNOWN_GAPS.has(n)));

// ---------------------------------------------------------------------------
// 2. The nested Tokenizer subclass
// ---------------------------------------------------------------------------
const tk = DuckDB.tokenizer_class;
const T = ref.tokenizer;

check("tokenizer_class is the declared nested Tokenizer", tk === DuckDB.Tokenizer, true);
check("tokenizer_class base", Object.getPrototypeOf(tk) === Tokenizer, T.base === "Tokenizer");

check("Tokenizer.KEYWORDS", enc(mapVals(tk.KEYWORDS, tt)), T.KEYWORDS);
check("Tokenizer.SINGLE_TOKENS", enc(mapVals(tk.SINGLE_TOKENS, tt)), T.SINGLE_TOKENS);
check("Tokenizer.COMMANDS", { $s: [...tk.COMMANDS].map(tt).sort(byJson) }, T.COMMANDS);
check("Tokenizer.BYTE_STRINGS", enc(tk.BYTE_STRINGS), T.BYTE_STRINGS);
check("Tokenizer.BYTE_STRING_ESCAPES", enc(tk.BYTE_STRING_ESCAPES), T.BYTE_STRING_ESCAPES);
check("Tokenizer.HEREDOC_STRINGS", enc(tk.HEREDOC_STRINGS), T.HEREDOC_STRINGS);
check("Tokenizer.HEREDOC_TAG_IS_IDENTIFIER", tk.HEREDOC_TAG_IS_IDENTIFIER, T.HEREDOC_TAG_IS_IDENTIFIER);
check("Tokenizer.HEREDOC_STRING_ALTERNATIVE", tt(tk.HEREDOC_STRING_ALTERNATIVE), T.HEREDOC_STRING_ALTERNATIVE);
check("Tokenizer.VAR_SINGLE_TOKENS", enc(tk.VAR_SINGLE_TOKENS), T.VAR_SINGLE_TOKENS);

// Derived by `initTokenizerSubclass`. If that call were missing these would silently be
// the BASE tokenizer's.
check("Tokenizer._QUOTES (derived)", enc(tk._QUOTES), T._QUOTES);
check("Tokenizer._IDENTIFIERS (derived)", enc(tk._IDENTIFIERS), T._IDENTIFIERS);
check("Tokenizer._FORMAT_STRINGS (derived)", enc(mapVals(tk._FORMAT_STRINGS, ([e, t]) => [e, tt(t)])), T._FORMAT_STRINGS);
check("Tokenizer._COMMENTS (derived)", enc(tk._COMMENTS), T._COMMENTS);
check("Tokenizer._STRING_ESCAPES (derived)", enc(tk._STRING_ESCAPES), T._STRING_ESCAPES);
check("Tokenizer._KEYWORD_TRIE size (derived)", tk._KEYWORD_TRIE.size, T._KEYWORD_TRIE_SIZE);

// py:115 `KEYWORDS.pop("/*+")`, and its downstream consequence.
check("HINT_START in KEYWORDS (py:115 pops it)", tk.KEYWORDS.has(tk.HINT_START), T.hint_start_in_keywords);
check("HINT_START in _COMMENTS", tk._COMMENTS.has(tk.HINT_START), T.hint_start_in_comments);
check("SHOW in COMMANDS (py:124 removes it)", tk.COMMANDS.has(TokenType.SHOW), T.show_in_commands);
check("SHOW in the BASE Tokenizer.COMMANDS (i.e. it was really removed)", Tokenizer.COMMANDS.has(TokenType.SHOW), true);

// ---------------------------------------------------------------------------
// 3. The autofilled classes
// ---------------------------------------------------------------------------
check("parser_class", DuckDB.parser_class === DuckDBParser, ref.classes.parser_class === "DuckDBParser");
check("parser_class name", DuckDB.parser_class.name, ref.classes.parser_class);
// PORT_PLAN.md R32: `generators/duckdb.js` now exists and `DuckDB.Generator =
// DuckDBGenerator` is wired — this was a `GAP` note ("port has null") through R29-R31;
// a real `check` now that the class exists, matching `parser_class` just above.
check("generator_class name", DuckDB.generator_class.name, ref.classes.generator_class);
note.push(
  `DEVIATION  tokenizer_class.name: CPython ${JSON.stringify(ref.classes.tokenizer_class)}, port ` +
    `${JSON.stringify(tk.name)} — JS has no nested class declaration; identity is asserted above instead`,
);

// ---------------------------------------------------------------------------
// 4. `to_json_path` — the JSON-pointer / back-of-list fast paths
// ---------------------------------------------------------------------------
const d = Dialect.get_or_raise("duckdb");
check("get_or_raise('duckdb') resolves to DuckDB", d.constructor === DuckDB, true);
check("instance normalization_strategy", d.normalization_strategy, ref.instance.normalization_strategy);
check("instance version", d.version.map(String), ref.instance.version);

// Cases where the fast path does NOT fire fall through to `super().to_json_path`,
// which upstream implements via `sqlglot.jsonpath.parse_json_path` and this port has
// as a `NotPorted` stub (`sqlglot/jsonpath.py` is P4, same gap `snowflake.js`
// inherits). CPython's `want` for those is a real parsed `JSONPath(...)` repr rather
// than `SAME_LITERAL`/`SAME_NODE`/an error dict — recognised by that shape, logged as
// a GAP, and asserted to throw `NotPorted` rather than compared value-for-value.
const isRealParse = (want) => typeof want === "string" && want.startsWith("JSONPath(");

for (const row of ref.to_json_path) {
  const label = row.text === null
    ? "to_json_path(non-Literal Column)"
    : `to_json_path(Literal(${JSON.stringify(row.text)}))`;
  const node = row.text === null
    ? new exp.Column({ this: new exp.Identifier({ this: "x" }) })
    : exp.Literal.string(row.text);
  if (isRealParse(row.out)) {
    checks += 1;
    try {
      d.to_json_path(node);
      fails.push(`${label}\n       got  <no throw>\n       want NotPorted (sqlglot/jsonpath.py is unported)`);
    } catch (e) {
      if (e.name !== "NotPorted") {
        fails.push(`${label}\n       got  ${e.name}: ${e.message}\n       want NotPorted`);
      } else {
        note.push(`GAP  ${label}: CPython parses ${trunc(row.out.replace(/\s+/g, " "))}, port throws NotPorted — sqlglot/jsonpath.py is unported (P4)`);
      }
    }
    continue;
  }
  let got;
  try {
    const out = d.to_json_path(node);
    got = out === node ? (row.text === null ? "SAME_NODE" : "SAME_LITERAL") : String(out);
  } catch (e) {
    got = { error: `${e.name}: ${e.message}` };
  }
  check(label, got, row.out);
}

console.log();
console.log(`  DuckDB dialect vs CPython: ${checks - fails.length}/${checks} checks pass`);
console.log(
  `    ${Object.keys(ref.attrs).length} resolved settings (${ref.overrides.length} differ from the base), ` +
    `${ref.tokenizer.KEYWORDS.$d.length} tokenizer keywords, ${ref.to_json_path.length} to_json_path cases`,
);
for (const line of note) console.log(`    ${line}`);
if (fails.length) {
  console.log();
  for (const f of fails) console.log(`    FAIL ${f}`);
  console.log();
  console.log("  DUCKDB DIALECT: FAIL");
  process.exit(1);
}
console.log("  DUCKDB DIALECT: OK");

/** A `Map` with each VALUE passed through `f`, preserving insertion order. */
function mapVals(m, f) {
  return new Map([...m].map(([k, v]) => [k, f(v)]));
}
