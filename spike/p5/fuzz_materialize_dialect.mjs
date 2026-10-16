// Differential: `src/dialects/materialize.js`'s `Materialize` class vs CPython.
//
//   PYTHONHASHSEED=0 python3 spike/p5/gen_materialize_dialect_ref.py \
//       > spike/out/materialize_dialect.json
//   node spike/p5/fuzz_materialize_dialect.mjs
//
// AIR-2292, epic AIR-2272, "12.7 Small dialects", batch A. Same template R105's
// `fuzz_trino_dialect.mjs`/R106's `fuzz_starrocks_dialect.mjs` established: the
// settings/overrides check verifies Postgres's own ~14 settings/Tokenizer survive
// unshadowed through another level of JS static inheritance.
//
// Three things are compared:
//
//   1. All RESOLVED settings, value by value (`getattr`, not `vars`): catches a
//      missing override AND an invented one.
//   2. The autofilled `parser_class`/`tokenizer_class`/`generator_class` linkage,
//      including the fresh-subclass `tokenizer_class` shape (no `Tokenizer` is
//      declared upstream).
//   3. The dialect instance's resolved `version`/`normalization_strategy`.
//
// Materialize declares no `Tokenizer` and overrides no method on the `Dialect` class
// itself, so there is no keyword-table section and no method-override section
// (`parsers/materialize.js`/`generators/materialize.js` have their own corpus-driven
// coverage).

import { readFileSync } from "node:fs";
import { Dialect } from "../../src/dialects/dialect.js";
import { Postgres } from "../../src/dialects/postgres.js";
import { Materialize } from "../../src/dialects/materialize.js";
import { MaterializeParser } from "../../src/parsers/materialize.js";
import { PostgresParser } from "../../src/parsers/postgres.js";
import { MaterializeGenerator } from "../../src/generators/materialize.js";
import { PostgresGenerator } from "../../src/generators/postgres.js";
import { TRIE_END } from "../../src/trie.js";

const ref = JSON.parse(readFileSync("spike/out/materialize_dialect.json", "utf8"));

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

// `EXPRESSION_METADATA` is inherited verbatim from `Postgres` (no
// `typing/materialize.js` exists); still a count-only comparison, same reason every
// sibling oracle uses one.
const COUNT_ONLY = new Set(["EXPRESSION_METADATA"]);

for (const [name, want] of Object.entries(ref.attrs)) {
  if (KNOWN_GAPS.has(name)) {
    note.push(
      `GAP  ${name}: CPython has ${JSON.stringify(want)}, port has ` +
        `{"$count":${Materialize[name].size}} — ${KNOWN_GAPS.get(name)}`,
    );
    continue;
  }
  if (!(name in Materialize)) {
    checks += 1;
    fails.push(`${name}\n       got  <ABSENT from the port>\n       want ${trunc(JSON.stringify(want))}`);
    continue;
  }
  if (COUNT_ONLY.has(name)) {
    check(name, { $count: Materialize[name].size }, want);
    continue;
  }
  const got = want !== null && typeof want === "object" && "$e" in want
    ? { $e: Materialize[name] }
    : enc(Materialize[name]);
  check(name, got, want);
}

// The reverse direction: a setting the port invented on this class, or one upstream
// dropped.
const upstreamNames = new Set(Object.keys(ref.attrs));
for (let k = Materialize; k && k !== Function.prototype; k = Object.getPrototypeOf(k)) {
  for (const name of Object.getOwnPropertyNames(k)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    checks += 1;
    if (!upstreamNames.has(name)) fails.push(`${name}: present in the port, absent upstream`);
  }
}

// Which settings actually DIFFER from the base, as a set.
const gotOverrides = Object.keys(ref.attrs)
  .filter((n) => !KNOWN_GAPS.has(n) && !COUNT_ONLY.has(n))
  .filter((n) => JSON.stringify(enc(Materialize[n])) !== JSON.stringify(enc(Dialect[n])))
  .sort();
check(
  "settings that differ from the base Dialect",
  gotOverrides,
  ref.overrides.filter((n) => !KNOWN_GAPS.has(n) && !COUNT_ONLY.has(n)),
);

// ---------------------------------------------------------------------------
// 2. The autofilled classes
// ---------------------------------------------------------------------------
check("parser_class", Materialize.parser_class === MaterializeParser, ref.classes.parser_class === "MaterializeParser");
check("parser_class name", Materialize.parser_class.name, ref.classes.parser_class);
check("parser_class base", Object.getPrototypeOf(Materialize.parser_class) === PostgresParser, ref.classes.parser_class_base === "PostgresParser");
check("generator_class", Materialize.generator_class === MaterializeGenerator, ref.classes.generator_class === "MaterializeGenerator");
check("generator_class name", Materialize.generator_class.name, ref.classes.generator_class);
check("generator_class base", Object.getPrototypeOf(Materialize.generator_class) === PostgresGenerator, ref.classes.generator_class_base === "PostgresGenerator");

// No `Tokenizer` is declared upstream, so `registerDialect` builds a FRESH empty
// subclass of `Postgres.tokenizer_class` rather than aliasing it.
const tk = Materialize.tokenizer_class;
check("tokenizer_class is a fresh subclass of Postgres.tokenizer_class", tk !== Postgres.tokenizer_class, ref.classes.tokenizer_class_is_fresh_subclass);
check("tokenizer_class base", Object.getPrototypeOf(tk) === Postgres.tokenizer_class, ref.classes.tokenizer_class_base === "Tokenizer");

// ---------------------------------------------------------------------------
// 3. The dialect instance
// ---------------------------------------------------------------------------
const d = Dialect.get_or_raise("materialize");
check("get_or_raise('materialize') resolves to Materialize", d.constructor === Materialize, true);
check("instance normalization_strategy", d.normalization_strategy, ref.instance.normalization_strategy);
check("instance version", d.version.map(String), ref.instance.version);

console.log();
console.log(`  Materialize dialect vs CPython: ${checks - fails.length}/${checks} checks pass`);
console.log(
  `    ${Object.keys(ref.attrs).length} resolved settings (${ref.overrides.length} differ from the base)`,
);
for (const line of note) console.log(`    ${line}`);
if (fails.length) {
  console.log();
  for (const f of fails) console.log(`    FAIL ${f}`);
  console.log();
  console.log("  MATERIALIZE DIALECT: FAIL");
  process.exit(1);
}
console.log("  MATERIALIZE DIALECT: OK");
