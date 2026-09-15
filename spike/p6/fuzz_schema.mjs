// Differential: `src/schema.js`'s `MappingSchema` (+ module-level helpers) vs CPython's
// `sqlglot.schema`, at the pin.
//
//   PYTHONHASHSEED=0 python3 spike/p6/gen_schema_ref.py > spike/out/schema.json
//   node spike/p6/fuzz_schema.mjs
//
// See `gen_schema_ref.py`'s own header for why this file exists (schema.js is
// greenfield, unreachable from the AST corpus) and for the SCENARIO shape: each
// scenario carries everything needed to reconstruct one `MappingSchema` here
// (`schema`/`visible`/`udfMapping` in a `{"__map__": [[k, v], ...]}` wire encoding,
// decoded into a `Map` — never a plain object, for the same reason `src/schema.js`'s own
// file header gives) plus a `setup` list of mutating calls to replay, then a list of
// read-only `checks` against that one instance.
//
// `get_column_type`/`get_udf_type` results are `exp.DataType` nodes. Rather than
// hand-rolling a second AST-dump comparator, this follows `spike/p4/fuzz_transforms.mjs`'s
// own precedent exactly: `astLoad` the Python side's dump into a real JS Expr tree, then
// diff `astDump` of BOTH sides through the same JS function, so a difference in dump
// SHAPE (e.g. the `t`/type field, which the Python side's simpler `dump()` omits and
// `astLoad` already treats as absent-ok) can never register as a false mismatch.

import { readFileSync } from "node:fs";
import * as exp from "../../src/expressions/index.js";
import { Dialect } from "../../src/dialects/dialect.js";
import { captureLogs } from "../../src/logging.js";
import { SchemaError, PyValueError } from "../../src/errors.js";
import { PyIndexError } from "../../src/_py/errors.js";
import {
  MappingSchema,
  ensureSchema,
  ensureColumnMapping,
  flattenSchema,
  nestedGet,
  nestedSet,
  normalizeName,
} from "../../src/schema.js";
// Side-effect import: registers the real parser (Dialect.get_or_raise(...).parse), which
// `exp.maybeParse`/`exp.toTable`/`_normalizeTable` all need.
import "../../src/parser.js";
// Side-effect imports: registerDialect("snowflake", ...) / registerDialect("duckdb", ...)
// -- the scenario battery exercises both (UPPERCASE and CASE_INSENSITIVE normalization
// strategies, vs the base dialect's LOWERCASE) and Dialect.get_or_raise throws Unknown
// dialect for either name until its module has been imported at least once.
import "../../src/dialects/snowflake.js";
import "../../src/dialects/duckdb.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = JSON.parse(readFileSync("spike/out/schema.json", "utf8"));

let exact = 0;
let mismatch = 0;
let error = 0;
const samples = [];

function decode(node) {
  if (node && typeof node === "object" && !Array.isArray(node) && "__map__" in node) {
    const m = new Map();
    for (const [k, v] of node.__map__) m.set(k, decode(v));
    return m;
  }
  return node;
}

/** exp dump round-tripped through astLoad, matching fuzz_transforms.mjs's own recipe. */
function exprDump(x) {
  return JSON.stringify(exp.astDump(x));
}
function pyExprDump(pyDump) {
  return JSON.stringify(exp.astDump(exp.astLoad(pyDump)));
}

function report(label, got, want, extra = "") {
  const gotJson = JSON.stringify(got);
  const wantJson = JSON.stringify(want);
  if (gotJson === wantJson) {
    exact += 1;
    if (VERBOSE) console.log(`  EXACT ${label}`);
  } else {
    mismatch += 1;
    samples.push(`MISMATCH ${label}${extra}\n       got  ${gotJson.slice(0, 300)}\n       want ${wantJson.slice(0, 300)}`);
  }
}
function reportError(label, err) {
  error += 1;
  samples.push(`ERROR    ${label}\n       ${err.constructor.name}: ${String(err.message || err).split("\n")[0].slice(0, 200)}`);
}

// `_py/errors.js`'s own naming convention: `PyValueError`/`PyIndexError`/... are named
// "Py" + the exact Python builtin name they stand in for (`_py/errors.js`'s own header
// comment). `SchemaError`/`ParseError`/etc. already share CPython's name outright.
function pyErrorName(name) {
  return name.startsWith("Py") ? name.slice(2) : name;
}

/** Run `fn`, matching Python's `run()` in the generator: {ok} | {error, message}. */
function runOk(fn) {
  try {
    return { ok: fn() };
  } catch (e) {
    return { error: pyErrorName(e.constructor.name), message: e.message };
  }
}

const SNAKE_TO_METHOD = { add_table: "addTable" };

function buildScenario(sc) {
  const schema = new MappingSchema(
    sc.schema != null ? decode(sc.schema) : null,
    sc.visible != null ? decode(sc.visible) : null,
    sc.dialect,
    sc.normalize,
    sc.udf_mapping != null ? decode(sc.udf_mapping) : null,
  );
  for (const step of sc.setup || []) {
    const method = SNAKE_TO_METHOD[step.method];
    if (!method) throw new Error(`fuzz_schema.mjs: no JS mapping for setup method ${step.method}`);
    schema[method](...step.args);
  }
  return schema;
}

function runCheck(schema, check) {
  const [a0, a1, a2, a3] = check.args || [];
  switch (check.op) {
    case "depth":
      return { kind: "value", got: schema.depth() };
    case "supported_table_args":
      return { kind: "value", got: schema.supportedTableArgs };
    case "mapping_keys":
      return { kind: "value", got: [...schema.mapping.keys()] };
    case "column_names":
      return { kind: "result", got: runOk(() => schema.columnNames(a0, a1 ?? false)) };
    case "has_column":
      return { kind: "result", got: runOk(() => schema.hasColumn(a0, a1)) };
    case "get_column_type":
      return { kind: "expr-result", got: runOk(() => schema.getColumnType(a0, a1)) };
    case "get_udf_type":
      return { kind: "expr-result", got: runOk(() => schema.getUdfType(a0)) };
    case "find": {
      const raiseOnMissing = a1 ?? true;
      return {
        kind: "result",
        got: runOk(() => {
          const tbl = exp.toTable(a0);
          const found = schema.find(tbl, raiseOnMissing);
          return found === null ? null : [...found.entries()];
        }),
      };
    }
    case "add_table":
      return { kind: "result", got: runOk(() => { schema.addTable(...check.args); return null; }) };
    case "normalize_name": {
      const [name, dialect, isTable, normalize] = check.args;
      return { kind: "result", got: runOk(() => normalizeName(name, dialect, isTable, normalize).name) };
    }
    default:
      throw new Error(`fuzz_schema.mjs: unhandled op ${check.op}`);
  }
}

/** Compare a `{ok|error}` result that MAY carry an Expr under `.ok` (get_column_type /
 * get_udf_type) against the Python side's own `{ok: pyDump}` / `{error, message}`. */
function compareResult(label, got, want, isExpr) {
  if ("error" in want) {
    if ("error" in got) {
      report(`${label} (error class)`, got.error, want.error, ` -- got msg: ${got.message}`);
    } else {
      mismatch += 1;
      samples.push(`MISMATCH ${label}\n       got  ok:${JSON.stringify(got.ok)}\n       want error:${want.error} ${want.message}`);
    }
    return;
  }
  if ("error" in got) {
    mismatch += 1;
    samples.push(`MISMATCH ${label}\n       got  error:${got.error} ${got.message}\n       want ok:${JSON.stringify(want.ok)}`);
    return;
  }
  if (isExpr) {
    report(label, exprDump(got.ok), pyExprDump(want.ok));
  } else {
    report(label, got.ok, want.ok);
  }
}

for (const sc of ref.scenarios) {
  let schema;
  try {
    schema = buildScenario(sc);
  } catch (e) {
    reportError(`scenario:${sc.scenario} construction`, e);
    continue;
  }
  for (const check of sc.checks) {
    const label = `${sc.scenario}:${check.op}(${JSON.stringify(check.args || [])})`;
    let outcome;
    try {
      outcome = runCheck(schema, check);
    } catch (e) {
      reportError(label, e);
      continue;
    }
    if (outcome.kind === "value") {
      report(label, outcome.got, check.result.ok ?? check.result);
    } else {
      compareResult(label, outcome.got, check.result, outcome.kind === "expr-result");
    }
  }
}

// ---- extra: bespoke one-off checks, mirroring gen_schema_ref.py's `extra` list -----

for (const e of ref.extra) {
  if (e.kind === "ensure_column_mapping") {
    const inputs = {
      none: null,
      string: "a:INT, b:VARCHAR",
      list: ["a", "b"],
      dict: { a: "INT" },
      invalid: 42,
      "malformed-string": "a",
    };
    const label = `extra:ensure_column_mapping:${e.label}`;
    const got = runOk(() => {
      const m = ensureColumnMapping(inputs[e.label]);
      return [...m.entries()];
    });
    if ("error" in e.result) {
      compareResult(label, got, e.result, false);
    } else {
      compareResult(label, got, e.result, false);
    }
  } else if (e.kind === "ensure_schema-passthrough") {
    const s = new MappingSchema(decode({ __map__: [["t", { __map__: [["a", "INT"], ["b", "VARCHAR"]] }]] }));
    report("extra:ensure_schema-passthrough", ensureSchema(s) === s, e.result);
  } else if (e.kind === "flatten_schema") {
    const inputs = {
      numeric: new Map([["2", 1], ["1", 1], ["10", 1]]),
      nested: { b: { x: 1 }, a: { y: 1 } },
    };
    report(`extra:flatten_schema:${e.label}`, flattenSchema(inputs[e.label]), e.result);
  } else if (e.kind === "nested_get") {
    const d = new Map();
    nestedSet(d, ["top", "second"], "value");
    nestedSet(d, ["top", "third"], "third_value");
    if (e.label === "round-trip-second") {
      report("extra:nested_get:round-trip-second", nestedGet(d, ["top", "top"], ["second", "second"]), e.result);
    } else if (e.label === "round-trip-third") {
      report("extra:nested_get:round-trip-third", nestedGet(d, ["top", "top"], ["third", "third"]), e.result);
    } else if (e.label === "missing-raises") {
      const got = runOk(() => nestedGet(new Map([["this", new Map([["a", 1]])]]), ["this", "this"], ["b", "b"]));
      compareResult("extra:nested_get:missing-raises", got, e.result, false);
    } else if (e.label === "missing-no-raise") {
      report(
        "extra:nested_get:missing-no-raise",
        nestedGet(new Map([["this", new Map([["a", 1]])]]), ["this", "this"], ["b", "b"], { raiseOnMissing: false }),
        e.result,
      );
    } else if (e.label === "this-renamed-to-table") {
      const got = runOk(() => nestedGet(new Map(), ["this", "missing_table"]));
      compareResult("extra:nested_get:this-renamed-to-table", got, e.result, false);
    }
  } else if (e.kind === "copy-independence-copy") {
    const depth1 = new Map([["t", new Map([["a", "INT"], ["b", "VARCHAR"]])]]);
    const original = new MappingSchema(depth1);
    const copied = original.copy();
    copied.addTable("t2", "b:INT");
    const got = runOk(() => copied.columnNames("t2"));
    compareResult("extra:copy-independence-copy", got, e.result, false);
  } else if (e.kind === "from_mapping_schema-columns" || e.kind === "from_mapping_schema-udf") {
    const s = new MappingSchema(
      new Map([["t", new Map([["a", "INT"]])]]),
      new Map([["t", ["a"]]]),
      null,
      true,
      new Map([["u", "INT"]]),
    );
    const fms = MappingSchema.fromMappingSchema(s);
    if (e.kind === "from_mapping_schema-columns") {
      compareResult("extra:from_mapping_schema-columns", runOk(() => fms.columnNames("t")), e.result, false);
    } else {
      compareResult("extra:from_mapping_schema-udf", runOk(() => fms.getUdfType("u()")), e.result, true);
    }
  } else if (e.kind === "datatype-value-passthrough") {
    const dtSchema = new MappingSchema();
    dtSchema.addTable("t", { a: exp.DataType.build("INT") });
    compareResult("extra:datatype-value-passthrough", runOk(() => dtSchema.getColumnType("t", "a")), e.result, true);
  } else {
    reportError(`extra:${e.kind}:${e.label ?? ""}`, new Error("unhandled extra kind"));
  }
}

console.log();
console.log("  src/schema.js vs CPython sqlglot.schema (MappingSchema, scenario-driven)");
console.log(`    EXACT ${exact}    MISMATCH ${mismatch}    ERROR ${error}`);
if (samples.length) {
  console.log();
  for (const s of samples) console.log(`  ${s}`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
