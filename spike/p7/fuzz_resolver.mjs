// Differential: `src/optimizer/resolver.js` (`Resolver`) vs CPython's
// `sqlglot.optimizer.resolver.Resolver`, at the pin.
//
//   PYTHONHASHSEED=0 python3 spike/p7/gen_resolver_ref.py > spike/out/resolver.json
//   node spike/p7/fuzz_resolver.mjs
//
// See `gen_resolver_ref.py`'s own header for why this file exists (`resolver.js` is
// greenfield, has zero `corpus/atoms.jsonl` tie-in, and there is no upstream
// `tests/optimizer/test_resolver.py` to transcribe) and for what each scenario
// targets. Each scenario builds a real `Scope` via `traverseScope` (already verified
// byte-for-byte, PORT_PLAN.md R46/AIR-2094) over a parsed query, a real `MappingSchema`
// (PORT_PLAN.md R41), constructs a `Resolver` from them, and replays the same method
// calls the Python side made — comparing the returned value/error shape, not `.sql()`
// text, since `Resolver`'s own return types (identifiers, string lists, sets) are not
// themselves further-rendered SQL.

import { readFileSync } from "node:fs";
import { parseOne } from "../../src/dialects/dialect.js";
import * as exp from "../../src/expressions/index.js";
import { traverseScope } from "../../src/optimizer/scope.js";
import { Resolver } from "../../src/optimizer/resolver.js";
import { MappingSchema } from "../../src/schema.js";
// Side-effect import: registers the real base-Generator dispatch, which `.sql()`
// needs (not used directly here, but `parseOne`'s own error paths and `Table.sql()`
// inside error messages route through it).
import "../../src/generator.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = JSON.parse(readFileSync("spike/out/resolver.json", "utf8"));

let exact = 0;
let mismatch = 0;
let error = 0;
const samples = [];

function identifierResult(ident) {
  if (ident === null || ident === undefined) return null;
  return { name: ident.name };
}

function callGetTable(resolver, arg) {
  let column;
  if (arg.kind === "name") {
    column = arg.value;
  } else {
    const cols = [...resolver.scope.findAll(exp.Column)];
    if (arg.kind === "column_index") {
      column = cols[arg.value];
    } else {
      column = cols.find((c) => c.name === arg.value && !c.table);
    }
  }
  try {
    return { ok: identifierResult(resolver.getTable(column)) };
  } catch (e) {
    return { error: e.constructor.name, message: e.message };
  }
}

function callGetSourceColumns(resolver, arg) {
  try {
    return { ok: resolver.getSourceColumns(arg.name, arg.only_visible ?? false) };
  } catch (e) {
    return { error: e.constructor.name, message: e.message };
  }
}

function callAllColumns(resolver) {
  return { ok: [...resolver.allColumns].sort() };
}

function callGetSourceColumnsFromSetOp(resolver) {
  try {
    return { ok: resolver.getSourceColumnsFromSetOp(resolver.scope.expression) };
  } catch (e) {
    return { error: e.constructor.name, message: e.message };
  }
}

const CALL_DISPATCH = {
  get_table: callGetTable,
  get_source_columns: callGetSourceColumns,
  all_columns: callAllColumns,
  get_source_columns_from_set_op: callGetSourceColumnsFromSetOp,
};

function resultsEqual(got, expected) {
  if ("error" in expected) {
    return "error" in got && got.error === expected.error;
  }
  if (!("ok" in got)) return false;
  return JSON.stringify(got.ok) === JSON.stringify(expected.ok);
}

for (const scenario of ref.scenarios) {
  const { name, sql, result: expected } = scenario;
  let scopes;
  let scope;
  let caught = null;
  try {
    const ast = parseOne(sql);
    scopes = traverseScope(ast);
    scope = scopes.at(scenario.scope_index);
  } catch (e) {
    caught = e;
  }

  if (caught || !scope) {
    error++;
    samples.push(`ERROR   ${name}: could not build scope: ${caught?.message ?? "no scope"}\n  sql: ${sql}`);
    continue;
  }

  if (scopes.length !== expected.num_scopes) {
    mismatch++;
    samples.push(
      `MISMATCH ${name} (scope count)\n  sql: ${sql}\n  expected: ${expected.num_scopes}\n  got: ${scopes.length}`,
    );
    continue;
  }

  const schema = new MappingSchema(scenario.schema, scenario.visible ?? null);
  const resolver = new Resolver(scope, schema, scenario.infer_schema ?? true);

  let allOk = true;
  for (const { op, arg, result: expectedResult } of expected.results) {
    const fn = CALL_DISPATCH[op];
    const got = fn(resolver, arg);
    const ok = resultsEqual(got, expectedResult);
    if (!ok) {
      allOk = false;
      mismatch++;
      samples.push(
        `MISMATCH ${name}:${op}\n  sql: ${sql}\n  arg: ${JSON.stringify(arg)}\n  expected: ${JSON.stringify(expectedResult)}\n  got: ${JSON.stringify(got)}`,
      );
    } else {
      exact++;
    }
  }
  void allOk;
}

console.log();
console.log("  src/optimizer/resolver.js Resolver vs CPython sqlglot.optimizer.resolver.Resolver");
console.log(`    EXACT ${exact}    MISMATCH ${mismatch}    ERROR ${error}`);
if (samples.length) {
  console.log();
  for (const s of samples) console.log(VERBOSE ? `  ${s}\n` : `  ${s.split("\n")[0]}`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
