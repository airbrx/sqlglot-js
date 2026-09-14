// Build a `TokenizerCore` for any dialect from P1's snapshotted settings.
//
// `dialects/dialect.js` lands at P5 and CONTRACTS.md §8 forbids resolving a dialect by
// NAME before then — silently falling back to the default dialect would make every
// per-dialect parity row vacuously green. But P1 already harvested every dialect's
// tokenizer SETTINGS, and `Tokenizer` accepts an already-resolved settings object, so a
// real Snowflake token stream is available at P3 without breaking that rule.
//
// This is the same construction `tools/tokens/check_streams.mjs` performs (and proves
// byte-exact against CPython over 23,457 streams); it is factored out here so the P3
// probes can reuse it rather than re-deriving it slightly differently.

import { readFileSync } from "node:fs";
import { TokenizerCore, TokenType } from "../../src/tokenizer_core.js";
import { newTrie, TRIE_END } from "../../src/trie.js";
import * as exp from "../../src/expressions/index.js";
import { pyUpper } from "../../src/_py/str.js";
import { formatTime } from "../../src/time.js";
import { NotPorted } from "../../src/errors.js";
import { Parser } from "../../src/parser.js";
import { BaseParser } from "../../src/parsers/base.js";
import { Dialect, registerDialect } from "../../src/dialects/dialect.js";
import { SnowflakeParser } from "../../src/parsers/snowflake.js";
import { HiveParser } from "../../src/parsers/hive.js";
import { Spark2Parser } from "../../src/parsers/spark2.js";
import { SparkParser } from "../../src/parsers/spark.js";
import { DatabricksParser } from "../../src/parsers/databricks.js";
import { PostgresParser } from "../../src/parsers/postgres.js";
import { DuckDBParser } from "../../src/parsers/duckdb.js";
import { TSQLParser } from "../../src/parsers/tsql.js";
import { RedshiftParser } from "../../src/parsers/redshift.js";

const snapshot = JSON.parse(readFileSync("corpus/tokens/settings.json", "utf8"));

function dec(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(dec);
  if ("$t" in v) {
    const t = TokenType[v.$t];
    if (t === undefined) throw new Error(`unknown TokenType in snapshot: ${v.$t}`);
    return t;
  }
  if ("$s" in v) return new Set(v.$s.map(dec));
  // Keys are decoded too: `SET_OP_DISTINCT_BY_DEFAULT` is keyed by expression CLASS,
  // not string. A plain string key decodes to itself, so the tokenizer settings that
  // have always used `$d` are unaffected.
  if ("$d" in v) return new Map(v.$d.map(([k, val]) => [dec(k), dec(val)]));
  if ("$c" in v) {
    const cls = exp[v.$c];
    if (cls === undefined) throw new Error(`unknown expression class in snapshot: ${v.$c}`);
    return cls;
  }
  throw new Error(`unencodable snapshot node: ${JSON.stringify(v).slice(0, 80)}`);
}

// py: _TokenizerBase.__init_subclass__'s trie derivation.
function deriveTrie(settings) {
  const singles = [...settings.single_tokens.keys()];
  const keys = [
    ...settings.keywords.keys(),
    ...settings.comments.keys(),
    ...settings.quotes.keys(),
    ...settings.format_strings.keys(),
  ].filter((key) => key.includes(" ") || singles.some((single) => key.includes(single)));
  return newTrie(keys.map((key) => pyUpper(key)));
}

/** Dialects whose Tokenizer overrides a METHOD, so settings alone cannot reproduce it. */
export const METHOD_OVERRIDING = new Set(
  Object.entries(snapshot.cores)
    .filter(([, spec]) => (spec.overrides ?? []).length)
    .map(([name]) => name),
);

const cache = new Map();

/** @returns {{core: TokenizerCore, commands: Set<number>}|null} */
export function tokenizerFor(dialect) {
  if (cache.has(dialect)) return cache.get(dialect);
  const spec = snapshot.cores[dialect];
  if (!spec || METHOD_OVERRIDING.has(dialect)) {
    cache.set(dialect, null);
    return null;
  }
  const settings = {};
  for (const slot of snapshot.core_slots) settings[slot] = dec(spec.settings[slot]);
  const core = new TokenizerCore({ ...settings, keyword_trie: deriveTrie(settings) });
  // `Parser._parse_statement` reads `self.dialect.tokenizer_class.COMMANDS`; the
  // snapshot carries it per dialect, so the Command fallback is dialect-correct.
  const out = { core, commands: settings.commands };
  cache.set(dialect, out);
  return out;
}

export const DIALECTS = Object.keys(snapshot.cores);

// ---------------------------------------------------------------------------
// Stand-in Dialect
// ---------------------------------------------------------------------------
// `dialects/dialect.js` is P5, but `Parser` reads 36 attributes off `self.dialect`
// today. The probes were each hand-rolling a partial stand-in and growing it one crash
// at a time (VALID_INTERVAL_UNITS, then CREATABLE_KIND_MAPPING, then
// SET_OP_DISTINCT_BY_DEFAULT, then tokenize...), which only ever catches the attributes
// that throw.
//
// The silent half is worse. A missing attribute reads back `undefined`; for the 24 whose
// base default is falsy that happens to behave like Python, but eight base defaults are
// TRUTHY, so the parser quietly took the opposite branch from CPython on every row.
// `NULL_ORDERING` is the sharpest -- the parser compares it against the string literals
// "nulls_are_small"/"nulls_are_last", so `undefined` fails a test CPython passes. Those
// surface as MISMATCH, not ERROR, which is why the crash-driven approach never saw them.
//
// Base defaults alone still would not do, because `corpus/ast/` was generated by CPython
// with each row's REAL dialect: Snowflake overrides three of the eight. So this reads the
// same kind of harvested snapshot P1 used for tokenizer settings --
// `tools/parser/extract_dialect_attrs.py`, resolved per dialect, decoded with the `dec`
// above. Same argument, same shape, one layer up; see that file's header.
const attrSnapshot = JSON.parse(readFileSync("corpus/parser/dialect_attrs.json", "utf8"));

// py: the trie's integer 0 end-marker, renamed on the wire (CONTRACTS.md §8) because a
// JSON object cannot distinguish the key `0` from `"0"`. The JS trie is a Map keyed by
// the INTEGER 0, so this rebuilds Maps rather than plain objects.
function trieFromJson(node) {
  const out = new Map();
  for (const [k, v] of Object.entries(node)) {
    if (k === "$end") out.set(TRIE_END, true);
    else out.set(k, trieFromJson(v));
  }
  return out;
}

const TRIE_ATTRS = new Set(["TIME_TRIE", "FORMAT_TRIE"]);
const attrCache = new Map();

function attrsFor(dialect) {
  if (attrCache.has(dialect)) return attrCache.get(dialect);
  const raw = attrSnapshot.dialects[dialect];
  if (raw === undefined) throw new Error(`no harvested Dialect attrs for ${JSON.stringify(dialect)}`);
  const out = {};
  for (const name of attrSnapshot.attrs) {
    out[name] = TRIE_ATTRS.has(name) ? trieFromJson(raw[name]) : dec(raw[name]);
  }
  // `build_logarithm` (parser.py:90) reads `dialect.parser_class.LOG_DEFAULTS_TO_LN`,
  // an attribute of the PARSER class rather than of the Dialect. Rebuilt as a nested
  // object so the ported builder keeps upstream's exact spelling — the same shape, and
  // the same argument, as `tokenizer_class.COMMANDS` below.
  out.parser_class = {};
  for (const name of attrSnapshot.parser_class_attrs) out.parser_class[name] = dec(raw.parser_class[name]);
  attrCache.set(dialect, out);
  return out;
}

/**
 * A `Dialect`-shaped object carrying `dialect`'s real, harvested attribute values.
 *
 * The three function-valued members are `Dialect` METHODS rather than settings, so no
 * snapshot can carry them; each is reproduced from data this file already has.
 *
 * `tokenize` is the base Dialect method (`self.tokenizer.tokenize(sql)`);
 * `_parse_types` calls it at py:6503 to re-lex a bare identifier and decide whether it
 * names a type, which is the path `CAST(x AS some_udt)` takes into the
 * user-defined-type branch. It delegates to the same tokenizer this dialect already
 * uses rather than hard-coding an answer.
 *
 * `format_time` (dialect.py:1552) is what `build_formatted_time` calls, so every
 * `TO_DATE`/`TO_TIMESTAMP(str, fmt)` in the Snowflake corpus goes through it. It is a
 * pure function of `TIME_MAPPING` + `TIME_TRIE`, both harvested, plus `src/time.js`.
 *
 * `to_json_path` (dialect.py:1487) is NOT reproducible: its Literal branch calls
 * `sqlglot.jsonpath.parse_json_path`, an unported module (P4). The non-Literal branch
 * is upstream's own identity path and is reproduced; the Literal branch announces
 * itself as a `NotPorted` stub rather than handing back the raw Literal, which would
 * differ from the oracle silently instead of loudly.
 *
 * @param {{core: TokenizerCore, commands: Set<number>}} tk from `tokenizerFor(dialect)`
 * @param {string} dialect the dialect name ("" for the base dialect)
 */
export function standInDialect(tk, dialect = "") {
  const attrs = attrsFor(dialect);
  // Since P5 this is a REAL `Dialect` instance carrying the harvested values as OWN
  // properties, rather than a bare object literal. Two reasons, one required and one
  // free:
  //
  //   Required. `parser.py:4437`'s `_parse_hint` calls
  //   `exp.maybe_parse(comment, into=Hint, dialect=self.dialect)`, and with
  //   `registerParser` finally wired that reaches `Dialect.get_or_raise`, whose
  //   `isinstance(dialect, Dialect)` check is upstream's own. A plain object failed it
  //   with "Invalid dialect type for '[object Object]'" on 42 rows (spark 20, oracle
  //   17, mysql 5) that had previously been silent MISMATCHes.
  //
  //   Free. Own properties shadow the prototype, so every harvested value still wins.
  //   That matters: `registerDialect`'s derivations read `tokenizer_class._QUOTES`,
  //   `KEYWORDS.has("(+)")` and `STRING_ESCAPES` off a real per-dialect `Tokenizer`
  //   SUBCLASS, and this harness deliberately has none — P1 snapshotted tokenizer
  //   SETTINGS into `TokenizerCore` instead. Registering these through
  //   `registerDialect` would therefore recompute `SUPPORTS_COLUMN_JOIN_MARKS`,
  //   `ESCAPED_SEQUENCES` and friends from the BASE tokenizer and overwrite measured
  //   values with wrong ones. Assigning over an instance keeps the harvest
  //   authoritative and gains only the type identity.
  const Klass = dialectClassFor(dialect);
  return Object.assign(new Klass(), {
    ...attrs,
    tokenizer_class: { COMMANDS: tk.commands },
    tokenize: (sql) => tk.core.tokenize(sql).tokens,
    // py: dialects/dialect.py:1552 Dialect.format_time
    format_time: (expression) => {
      if (typeof expression === "string") {
        // py: `expression[1:-1]` — the time formats are quoted. Sliced by CODE POINT.
        const cps = [...expression];
        return exp.Literal.string(
          formatTime(cps.slice(1, -1).join(""), attrs.TIME_MAPPING, attrs.TIME_TRIE),
        );
      }
      if (expression && expression.isString) {
        return exp.Literal.string(formatTime(expression.this, attrs.TIME_MAPPING, attrs.TIME_TRIE));
      }
      return expression;
    },
    // py: dialects/dialect.py:1487 Dialect.to_json_path
    to_json_path: (path) => {
      if (path instanceof exp.Literal) {
        throw new NotPorted("Dialect.to_json_path", "sqlglot/jsonpath.py:parse_json_path");
      }
      return path;
    },
  });
}

// ---------------------------------------------------------------------------
// Per-dialect Parser subclass
// ---------------------------------------------------------------------------
// Same argument as `tokenizerFor`, one layer up again. `sqlglot/parsers/snowflake.py`'s
// `SnowflakeParser(parser.Parser)` overrides 17 class tables and 38 methods, so parsing
// a Snowflake row with the base `Parser` is not "Snowflake minus some features" — it is
// a different grammar. But CONTRACTS.md §8 forbids resolving a dialect by NAME before
// P5, and `Parser._resolveDialect` enforces it by throwing.
//
// That rule is about RUNTIME resolution: the parser must not be handed the string
// "snowflake" and go looking for a dialect. It does not apply here, because the probe
// is not resolving anything — each corpus row already CARRIES its dialect as metadata
// (it is the `corpus/ast/<dialect>.jsonl` filename), so the harness can name the class
// it wants directly, as an ordinary ESM import, with no registry in between. The
// dialect object handed to the constructor is still the harvested `standInDialect`.
//
// New entries here are the only thing a future `src/parsers/<d>.js` needs in order to
// start being measured; a dialect with no entry keeps using the base `Parser`, which is
// what every non-Snowflake row does today.
const PARSER_CLASSES = new Map([
  // The DEFAULT dialect is not the base `Parser`. `dialects/dialect.py:824` sets
  // `Dialect.parser_class = BaseParser` (sqlglot/parsers/base.py), which adds LOCALTIME,
  // LOCALTIMESTAMP, CURRENT_CATALOG and SESSION_USER to `NO_PAREN_FUNCTIONS` and drops
  // STRAIGHT_JOIN from two token sets. Every OTHER dialect subclasses `parser.Parser`
  // directly, so the fallback below stays `Parser` and only this key changes.
  ["", BaseParser],
  ["snowflake", SnowflakeParser],
  ["hive", HiveParser],
  ["spark2", Spark2Parser],
  ["spark", SparkParser],
  ["databricks", DatabricksParser],
  ["postgres", PostgresParser],
  ["duckdb", DuckDBParser],
  ["tsql", TSQLParser],
  ["redshift", RedshiftParser],
]);

/** The `Parser` subclass that owns `dialect`'s grammar, or the base `Parser`. */
export function parserClassFor(dialect) {
  return PARSER_CLASSES.get(dialect) || Parser;
}

// ---------------------------------------------------------------------------
// Per-dialect Dialect subclass
// ---------------------------------------------------------------------------
// `src/dialects/` has no per-dialect settings classes yet -- those are the next P5
// dispatch, one file each, the same shape the `parsers/<dialect>.js` ports took. The
// harness needs a class anyway, for two things an instance carrying harvested values
// cannot supply:
//
//   `parser_class`. `Dialect.parser()` reads `this.constructor.parser_class`, so the
//   dialect a SUB-parse resolves to decides its grammar. `parser.py:4437`'s
//   `_parse_hint` re-parses a `/*+ ... */` comment through
//   `maybe_parse(..., dialect=self.dialect)`; with the base class that reached
//   `BaseParser` and produced `Anonymous(this=MERGE)` where CPython, going through
//   `SparkParser`, produces `JoinHint`.
//
//   The class NAME. `tools/astdump.py:111` dumps a Dialect held on an arg as
//   `{"__dialect__": type(node).__name__}`, so an arg carrying one (via
//   `DataType.from_str(..., dialect=...)`) compares by that name.
//
// Names are upstream's, harvested rather than title-cased: `DuckDB`, `MySQL`, `TSQL`,
// `PRQL`, `SQLite`, `StarRocks`, `RisingWave`, `SingleStore` and `DAX` are none of them
// what a `key[0].toUpperCase()` rule produces, and a wrong name is a silent MISMATCH on
// the `__dialect__` wire format rather than an error.
const DIALECT_CLASS_NAMES = {
  "": "Dialect", athena: "Athena", bigquery: "BigQuery", clickhouse: "ClickHouse",
  databricks: "Databricks", dax: "DAX", doris: "Doris", dremio: "Dremio",
  drill: "Drill", druid: "Druid", duckdb: "DuckDB", dune: "Dune", exasol: "Exasol",
  fabric: "Fabric", hive: "Hive", materialize: "Materialize", mysql: "MySQL",
  oracle: "Oracle", postgres: "Postgres", presto: "Presto", prql: "PRQL",
  redshift: "Redshift", risingwave: "RisingWave", singlestore: "SingleStore",
  snowflake: "Snowflake", solr: "Solr", spark: "Spark", spark2: "Spark2",
  sqlite: "SQLite", starrocks: "StarRocks", tableau: "Tableau", teradata: "Teradata",
  trino: "Trino", tsql: "TSQL",
};

const dialectClassCache = new Map();

/**
 * A registered `Dialect` subclass for `dialect`, carrying only its `Parser`.
 *
 * Its class-level SETTINGS are deliberately left at the base defaults and then shadowed
 * per-instance by `standInDialect`'s harvested values. Letting `registerDialect` derive
 * them would be worse, not better: several (`SUPPORTS_COLUMN_JOIN_MARKS`,
 * `ESCAPED_SEQUENCES`, `QUOTE_START`, ...) come off a real per-dialect `Tokenizer`
 * SUBCLASS, which this harness has none of by design -- P1 snapshotted tokenizer
 * settings into `TokenizerCore` instead -- so they would be computed from the BASE
 * tokenizer and overwrite measured values with wrong ones.
 */
function dialectClassFor(dialect) {
  if (dialectClassCache.has(dialect)) return dialectClassCache.get(dialect);
  if (dialect === "") {
    dialectClassCache.set(dialect, Dialect);
    return Dialect;
  }
  // If a REAL `src/dialects/<name>.js` has already registered itself, use it and
  // synthesize nothing. `src/dialects/snowflake.js` is the first (P5); duckdb, postgres
  // and the rest follow one file at a time.
  //
  // This is not merely a tidiness preference — without it the synthesis below is a
  // silent DOWNGRADE. `registerDialect(dialect, klass)` at the bottom of this function
  // OVERWRITES the registry entry, so any module that imported a real dialect class and
  // then touched this harness would find `Dialect.get_or_raise("snowflake")` handing
  // back the stand-in — base settings, base tokenizer — with no error anywhere. That is
  // PORT_PLAN.md R19/R20's shape once more: a correct value replaced by a plausible one,
  // through a path nothing asserts on.
  //
  // It deliberately does NOT import any real dialect class. This file's own header
  // explains why the harness wants harvested settings rather than derived ones (it has
  // no per-dialect `Tokenizer` SUBCLASS by design), and `standInDialect` shadows the
  // class's settings per-instance either way. So for `fuzz_ast_coverage.mjs` this branch
  // is inert until some other module does the importing, which is the point.
  const registered = Dialect.get(dialect);
  if (registered) {
    dialectClassCache.set(dialect, registered);
    return registered;
  }
  const name = DIALECT_CLASS_NAMES[dialect];
  if (!name) throw new Error(`no upstream class name recorded for dialect ${JSON.stringify(dialect)}`);
  const ParserClass = parserClassFor(dialect);
  // Named via a computed key so `klass.name` is upstream's, which is what the
  // `__dialect__` wire format compares against.
  const klass = { [name]: class extends Dialect { static Parser = ParserClass; } }[name];
  registerDialect(dialect, klass);
  dialectClassCache.set(dialect, klass);
  return klass;
}
