// Differential: the base `Dialect` class's settings, on the port vs CPython.
//
//   python3 spike/p5/gen_dialect_ref.py > spike/out/dialect_defaults.json
//   node spike/p5/fuzz_dialect_defaults.mjs
//
// Three things are checked, and the third is the one a reading of the upstream file
// cannot give you:
//
//   1. All 105 UPPER_CASE class settings, value by value.
//   2. Which classes `_Dialect.__new__` autofilled — in particular that `parser_class`
//      is `BaseParser` (sqlglot/parsers/base.py) and NOT `parser.Parser`.
//   3. `get_or_raise`'s `"name [, k [= v]]"` grammar, including the five inputs that
//      RAISE, whose messages are part of the contract.
//
// Why value-by-value rather than spot checks: twenty-four of these defaults are FALSY,
// so an attribute the port simply forgot reads back `undefined` and behaves exactly
// like Python for those twenty-four — while the truthy ones silently flip a parser
// branch. That asymmetry is what `spike/p3/dialect_tokenizer.mjs`'s header records
// having been bitten by, and it is invisible to any probe that only asserts the
// settings someone remembered to assert.

import { readFileSync } from "node:fs";
import * as exp from "../../src/expressions/index.js";
import {
  Dialect,
  DIALECT_MODULE_NAMES,
  NormalizationStrategy,
  registerDialect,
} from "../../src/dialects/dialect.js";
import { BaseParser } from "../../src/parsers/base.js";
import { Tokenizer } from "../../src/tokens.js";
import { TRIE_END } from "../../src/trie.js";

const ref = JSON.parse(readFileSync("spike/out/dialect_defaults.json", "utf8"));

const fails = [];
let checks = 0;
const note = [];

/** Render a JS value in the oracle's own encoding, so a diff is a string diff. */
function enc(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Set) return { $s: [...v].map(enc).sort(cmp) };
  if (v instanceof Map) {
    return { $d: [...v].map(([k, val]) => [k === TRIE_END ? "$end" : enc(k), enc(val)]) };
  }
  if (Array.isArray(v)) return v.map(enc);
  // `exp.DType.X` — a frozen `{__enum__, name, value}` record.
  if (v.__enum__ === "DType") return { $dtype: v.name };
  // An expression CLASS, which is how SET_OP_DISTINCT_BY_DEFAULT is keyed.
  if (typeof v === "function") return { $c: v.name };
  throw new Error(`unencodable JS value: ${String(v)}`);
}

/**
 * Matches Python's `sorted()` on the set members these settings actually hold, which
 * are all plain strings. It compares the RAW value, never `JSON.stringify(value)`:
 * quoting shifts the terminator, so "DAY" vs "DAY OF WEEK" sorts one way bare and the
 * other way quoted (`"` is 0x22, above the space at 0x20), and `VALID_INTERVAL_UNITS`
 * would report a diff of 116 identical strings in a different order.
 *
 * `<` on JS strings is UTF-16 code-unit order and Python's is code-point order; those
 * disagree only for astral characters, and none of these sets contains one.
 */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function check(what, got, want) {
  checks += 1;
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) fails.push(`${what}\n       got  ${trunc(g)}\n       want ${trunc(w)}`);
}

const trunc = (s) => (s.length > 200 ? `${s.slice(0, 200)}…` : s);

// ---------------------------------------------------------------------------
// 1. Class settings
// ---------------------------------------------------------------------------
// `NORMALIZATION_STRATEGY` needs no special casing on either side, and that is worth a
// line: upstream's `NormalizationStrategy` derives from `str`, so the oracle's `enc`
// serialises the member as the bare string "LOWERCASE", and the port's frozen string
// map yields the same. The `str, AutoName` base is exactly why the port can model the
// enum as strings without a wrapper.

// Ported partially or not at all, each with the reason. Every one still gets a printed
// line below — PORT_PLAN.md's standing rule is that a skip states its count out loud
// rather than being dropped from the denominator.
const KNOWN_GAPS = new Map([
  [
    "EXPRESSION_METADATA",
    "sqlglot/optimizer/annotate_types.py is unported (P6+); the port carries an empty Map",
  ],
]);

for (const [name, want] of Object.entries(ref.attrs)) {
  if (KNOWN_GAPS.has(name)) {
    note.push(`GAP  ${name}: CPython has ${JSON.stringify(want)}, port has ` +
      `${JSON.stringify(enc(Dialect[name]))} — ${KNOWN_GAPS.get(name)}`);
    continue;
  }
  if (!(name in Dialect)) {
    fails.push(`${name}\n       got  <ABSENT from the port>\n       want ${trunc(JSON.stringify(want))}`);
    checks += 1;
    continue;
  }
  check(name, enc(Dialect[name]), want);
}

// The reverse direction: a setting the port invented, or one upstream dropped.
const upstreamNames = new Set(Object.keys(ref.attrs));
for (const name of Object.getOwnPropertyNames(Dialect)) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
  checks += 1;
  if (!upstreamNames.has(name)) fails.push(`${name}: present in the port, absent upstream`);
}

// ---------------------------------------------------------------------------
// 2. The autofilled classes
// ---------------------------------------------------------------------------
check("parser_class", Dialect.parser_class === BaseParser, ref.classes.parser_class === "BaseParser");
check("parser_class name", Dialect.parser_class.name, ref.classes.parser_class);
// py:291 builds a FRESH empty subclass rather than aliasing `Tokenizer` itself.
check("tokenizer_class is a fresh subclass", Dialect.tokenizer_class !== Tokenizer, true);
check(
  "tokenizer_class base",
  Object.getPrototypeOf(Dialect.tokenizer_class).name,
  ref.classes.tokenizer_class_base,
);
note.push(
  `GAP  generator_class: CPython has ${JSON.stringify(ref.classes.generator_class)}, port has null — ` +
    "sqlglot/generator.py is P4",
);
note.push(
  `GAP  jsonpath_tokenizer_class: CPython has ${JSON.stringify(ref.classes.jsonpath_tokenizer_class)}, ` +
    "port has null — sqlglot/jsonpath.py is P4",
);

// ---------------------------------------------------------------------------
// 3. `__init__` state and the `get_or_raise` grammar
// ---------------------------------------------------------------------------
const base = Dialect.get_or_raise(null);
check("Dialect().version", base.version.map(String), ref.instance.version);
check("Dialect().normalization_strategy", base.normalization_strategy, ref.instance.normalization_strategy);
check("Dialect().settings", enc(new Map(Object.entries(base.settings))), ref.instance.settings);

// The oracle exercises "duckdb" because it is a real upstream dialect. `src/dialects/`
// has no per-dialect settings classes yet (they are the next P5 dispatch), so the probe
// registers a stand-in under the same key. That is deliberate and it is what makes this
// a test of the GRAMMAR rather than of duckdb: every field compared below —
// `version`, `normalization_strategy`, `settings`, and the five error messages — is
// produced by `get_or_raise`/`__init__` alone and is identical for any registered class.
//
// The one duckdb-specific value the grammar cases DO observe is
// `normalization_strategy`, because `__init__` falls back to the class's
// `NORMALIZATION_STRATEGY` when the setting is absent. Declared here so the fallback
// path is compared against a real value rather than trivially matching the base
// default; the rest of duckdb's ~40 settings are the next dispatch's work, not this
// probe's, and nothing below reads them.
class DuckDB extends Dialect {
  static NORMALIZATION_STRATEGY = NormalizationStrategy.CASE_INSENSITIVE;
}
registerDialect("duckdb", DuckDB);

for (const row of ref.get_or_raise) {
  const label = `get_or_raise(${JSON.stringify(row.input)})`;
  let got;
  try {
    const d = Dialect.get_or_raise(row.input);
    got = {
      version: d.version.map(String),
      normalization_strategy: d.normalization_strategy,
      dialect: d.constructor === Dialect ? "dialect" : d.constructor.name.toLowerCase(),
      settings: enc(new Map(Object.entries(d.settings))),
    };
  } catch (e) {
    got = { error: e.message };
  }
  if (row.error) {
    check(label, got.error ?? `<no error, got ${JSON.stringify(got)}>`, row.error.message);
  } else {
    check(label, got, {
      version: row.version,
      normalization_strategy: row.normalization_strategy,
      dialect: row.dialect,
      settings: row.settings,
    });
  }
}

// `DIALECT_MODULE_NAMES` is what feeds the "Did you mean ...?" candidate set, and it is
// NOT the `Dialects` enum: `singlestore` is a module with no enum member. The suggestion
// for "duckdbb" above already depends on it; this pins the whole list.
check("DIALECT_MODULE_NAMES", [...DIALECT_MODULE_NAMES], [
  "athena", "bigquery", "clickhouse", "databricks", "dax", "doris", "dremio",
  "drill", "druid", "duckdb", "dune", "exasol", "fabric", "hive", "materialize",
  "mysql", "oracle", "postgres", "presto", "prql", "redshift", "risingwave",
  "singlestore", "snowflake", "solr", "spark", "spark2", "sqlite", "starrocks",
  "tableau", "teradata", "trino", "tsql",
]);
check("NormalizationStrategy members", Object.keys(NormalizationStrategy), [
  "LOWERCASE", "UPPERCASE", "CASE_SENSITIVE", "CASE_INSENSITIVE", "CASE_INSENSITIVE_UPPERCASE",
]);
// Registering a subclass must not mutate the base class's own settings.
check("base INITCAP_SUPPORTS_CUSTOM_DELIMITERS after subclass registration", Dialect.INITCAP_SUPPORTS_CUSTOM_DELIMITERS, true);
check("subclass INITCAP_SUPPORTS_CUSTOM_DELIMITERS (py:352 turns it off for non-'' dialects)", DuckDB.INITCAP_SUPPORTS_CUSTOM_DELIMITERS, false);
check("subclass inherits base VALID_INTERVAL_UNITS size", DuckDB.VALID_INTERVAL_UNITS.size, Dialect.VALID_INTERVAL_UNITS.size);
check("exp is loadable alongside (sanity)", typeof exp.Select, "function");

// ---------------------------------------------------------------------------
// 4. The five methods with no caller in `src/`
// ---------------------------------------------------------------------------
// PORT_PLAN.md R16 turned on this port's own new code. `case_sensitive`, `can_quote`,
// `quote_identifier`, `generate_values_aliases` and `format_time` are consumed by the
// P4 generator and the P6 optimizer, neither of which exists, so no other probe in this
// repo would notice if any of them were quietly wrong. `normalize_identifier` is
// excluded because the port announces it as a NotPorted stub.
for (const row of ref.methods) {
  const label = `${row.m}(${JSON.stringify(row.text ?? row.value ?? row.width)}` +
    `${row.strategy ? `, ${row.strategy}` : ""}${row.identify !== undefined ? `, identify=${JSON.stringify(row.identify)}` : ""}` +
    `${row.quoted !== undefined ? `, quoted=${row.quoted}` : ""}${row.in_func ? ", in Func" : ""})`;
  let got;
  try {
    if (row.m === "case_sensitive") {
      got = new Dialect({ normalization_strategy: row.strategy }).case_sensitive(row.text);
    } else if (row.m === "can_quote" || row.m === "quote_identifier") {
      const ident = new exp.Identifier({ this: row.text, quoted: row.quoted ?? false });
      // Constructing the Func sets `ident.parent`, which is what py:1142 tests.
      if (row.in_func) new exp.Anonymous({ this: ident, expressions: [] });
      const d = new Dialect();
      got = row.m === "can_quote"
        ? d.can_quote(ident, row.identify)
        : d.quote_identifier(ident, row.identify).args.quoted;
    } else if (row.m === "generate_values_aliases") {
      const values = new exp.Values({
        expressions: [new exp.Tuple({ expressions: Array.from({ length: row.width }, (_, i) => exp.Literal.number(i)) })],
      });
      got = new Dialect().generate_values_aliases(values).map((i) => i.name);
    } else if (row.m === "format_time") {
      got = Dialect.format_time(row.value).name;
      // `format_time("''")` reaches `Literal.string(null)`, where upstream's `str(None)`
      // gives "None" and the port's `String(null)` gives "null". That is a KNOWN,
      // reachable divergence in `Literal.string`, not in `Dialect.format_time` — see
      // the long note at its definition in `expressions/focused_methods.js` for why the
      // fix is two edits and why landing half of it regresses two bigquery rows.
      // Recorded as a GAP with its expected value printed, never silently equalised.
      if (got === "null" && row.out === "None") {
        note.push(
          `GAP  Literal.string(null): CPython "None", port "null" — reached here via ` +
            `format_time(${JSON.stringify(row.value)}); fix is pyStr + src/parser.js:370 \`1\` -> \`1n\``,
        );
        continue;
      }
    } else {
      throw new Error(`unhandled oracle method ${row.m}`);
    }
  } catch (e) {
    got = { error: e.message };
  }
  check(label, got, row.out);
}

console.log();
console.log(`  Dialect defaults vs CPython: ${checks - fails.length}/${checks} checks pass`);
for (const line of note) console.log(`    ${line}`);
if (fails.length) {
  console.log();
  for (const f of fails) console.log(`    FAIL ${f}`);
  console.log();
  console.log("  DIALECT DEFAULTS: FAIL");
  process.exit(1);
}
console.log("  DIALECT DEFAULTS: OK");
