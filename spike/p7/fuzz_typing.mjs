// Differential: `src/typing/index.js`'s `EXPRESSION_METADATA` vs CPython's
// `sqlglot.typing.EXPRESSION_METADATA`, at the pin.
//
//   PYTHONHASHSEED=0 python3 spike/p7/gen_typing_ref.py > spike/out/typing.json
//   node spike/p7/fuzz_typing.mjs [--verbose]
//
// See `gen_typing_ref.py`'s own header for why this file exists (typing/index.js is
// greenfield, its consumer `TypeAnnotator` is unported) and for the call-recording
// scheme: a `fakeSelf` Proxy whose every property access returns a chainable
// recorder, and whose every call captures `{name, args, kwargs}` instead of running
// real logic, mirroring the Python side's `Recorder` class exactly. Running the real
// annotator lambda against `fakeSelf` reproduces the exact private-method name and
// argument list it would call on a real `TypeAnnotator`, so a wrong method name, a
// dropped `array=true`/`promote=true` kwarg, or a wrong arg ORDER shows up as a
// recorded-call diff — without `TypeAnnotator` needing to exist.

import { readFileSync } from "node:fs";
import * as exp from "../../src/expressions/index.js";
import { subclasses } from "../../src/helper.js";
import { EXPRESSION_METADATA, TIMESTAMP_EXPRESSIONS } from "../../src/typing/index.js";
// Side-effect import: registers the real default-dialect parser
// (`Dialect.get_or_raise("").parse`), which `exp.DataType.fromStr`'s parameterised-type
// branch (`ARRAY<DATE>`, exercised by the `GenerateDateArray`/`GenerateTimestampArray`
// entries below) needs via `maybeParse`. Without it, `fromStr` still returns a
// `DataType`, but with a degenerate `expressions: []` rather than the real nested
// `[DataType(this=DATE)]` — a silent wrong-shape result rather than a throw, exactly
// the hazard `spike/p6/gen_schema_ref.py`'s own header warns about for this same call.
import "../../src/dialects/dialect.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = JSON.parse(readFileSync("spike/out/typing.json", "utf8"));

let exact = 0;
let checks = 0;
const fails = [];

// The reference JSON is dumped with `sort_keys=True` on the Python side; a bare
// `JSON.stringify` on the JS side preserves insertion order instead, so two
// deep-equal objects with keys built in a different order would false-positive as a
// MISMATCH. Stringifying both sides through the same key-sorting encoder makes the
// comparison a real structural diff.
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  }
  return v;
}

function check(what, got, want) {
  checks += 1;
  const g = JSON.stringify(stable(got));
  const w = JSON.stringify(stable(want));
  if (g === w) {
    exact += 1;
  } else {
    fails.push(`${what}\n       got  ${g}\n       want ${w}`);
  }
}

// --- fakeSelf: a chainable call recorder, mirroring gen_typing_ref.py's `Recorder`. ---
function isPlainKwargsObject(v) {
  // A trailing options object (e.g. `{array: true}`), NOT a nested recorded call or a
  // frozen `DType` record — both are plain objects too (`{$call, args, kwargs}` /
  // `{__enum__, name, value}`), so exclude them explicitly. `self.schema.get_udf_type(e)`
  // nested inside `self._set_type(e, ...)` (the `Anonymous` entry) and
  // `self._set_type(e, exp.DType.BIGINT)` (`Count`/`DateDiff`/`HexString`/`Timestamp`)
  // are exactly the cases this guards: each one's LAST positional arg is a plain
  // object that must stay a positional arg, not get popped as kwargs.
  return (
    v &&
    typeof v === "object" &&
    v.constructor === Object &&
    !("$call" in v) &&
    !("__enum__" in v)
  );
}

function makeRecorder(path) {
  const fn = (...args) => {
    let kwargs = {};
    if (args.length && isPlainKwargsObject(args.at(-1))) kwargs = args.pop();
    return { $call: path, args, kwargs };
  };
  return new Proxy(fn, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      return makeRecorder(`${path}.${prop}`);
    },
  });
}
const fakeSelf = makeRecorder("self");

const PROBE_TRUE = new exp.Expr({
  this: "THIS_V",
  expression: "EXPRESSION_V",
  expressions: ["EXPR0", "EXPR1"],
  true: "TRUE_V",
  false: "FALSE_V",
  default: "DEFAULT_V",
  to: "TO_V",
  start: "START_V",
  end: "END_V",
  step: "STEP_V",
  big_int: true,
  is_integer: true,
  with_tz: true,
  ifs: [new exp.Expr({ true: "IF0_TRUE" }), new exp.Expr({ true: "IF1_TRUE" })],
});
const PROBE_FALSE = new exp.Expr({
  this: "THIS_V",
  expression: "EXPRESSION_V",
  expressions: ["EXPR0", "EXPR1"],
  true: "TRUE_V",
  false: "FALSE_V",
  default: "DEFAULT_V",
  to: "TO_V",
  start: "START_V",
  end: "END_V",
  step: "STEP_V",
  big_int: false,
  is_integer: false,
  with_tz: false,
  ifs: [new exp.Expr({ true: "IF0_TRUE" }), new exp.Expr({ true: "IF1_TRUE" })],
});

function datatypeShape(dt) {
  return {
    this: dt.this.name,
    expressions: dt.expressions.filter((e) => e instanceof exp.DataType).map(datatypeShape),
  };
}

function enc(v, probe) {
  if (v === probe) return { $e: true };
  if (v && typeof v === "object" && "$call" in v) {
    return {
      $call: v.$call,
      args: v.args.map((a) => enc(a, probe)),
      kwargs: Object.fromEntries(Object.entries(v.kwargs).map(([k, a]) => [k, enc(a, probe)])),
    };
  }
  if (v && v.__enum__ === "DType") return { $dtype: v.name };
  if (v instanceof exp.DataType) return { $datatype: datatypeShape(v) };
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") return v;
  throw new Error(`unencodable JS value: ${String(v)}`);
}

// ---------------------------------------------------------------------------
// 1. Top-level counts/sets.
// ---------------------------------------------------------------------------
check("EXPRESSION_METADATA.size", EXPRESSION_METADATA.size, ref.total_classes);
check(
  "TIMESTAMP_EXPRESSIONS",
  [...TIMESTAMP_EXPRESSIONS].map((c) => c.name).sort(),
  ref.timestamp_expressions,
);

const registry = Object.values(exp.EXPR_CLASSES);
check(
  "subclasses(Binary)",
  subclasses(registry, exp.Binary).map((c) => c.name).sort(),
  ref.binary_subclasses,
);
check(
  "subclasses(Unary,Alias,IgnoreNulls,RespectNulls)",
  subclasses(registry, [exp.Unary, exp.Alias, exp.IgnoreNulls, exp.RespectNulls])
    .map((c) => c.name)
    .sort(),
  ref.unary_family_subclasses,
);

// ---------------------------------------------------------------------------
// 2. Every one of the 294 classes: kind, returns dtype, or recorded annotator call.
// ---------------------------------------------------------------------------
const byName = new Map([...EXPRESSION_METADATA.keys()].map((c) => [c.name, c]));

for (const [name, want] of Object.entries(ref.classes)) {
  const cls = byName.get(name);
  if (!cls) {
    checks += 1;
    fails.push(`${name}\n       got  <ABSENT from the port>\n       want present`);
    continue;
  }
  const spec = EXPRESSION_METADATA.get(cls);
  if (want.kind === "returns") {
    const got = spec.returns ? { kind: "returns", dtype: spec.returns.name } : { kind: "annotator" };
    check(`${name}.kind/returns`, got, { kind: "returns", dtype: want.dtype });
  } else {
    if (!spec.annotator) {
      checks += 1;
      fails.push(`${name}.kind\n       got  {kind: "returns"}\n       want {kind: "annotator"}`);
      continue;
    }
    const gotTrue = enc(spec.annotator(fakeSelf, PROBE_TRUE), PROBE_TRUE);
    const gotFalse = enc(spec.annotator(fakeSelf, PROBE_FALSE), PROBE_FALSE);
    check(`${name}.annotator(true)`, gotTrue, want.true);
    check(`${name}.annotator(false)`, gotFalse, want.false);
  }
}

// Reverse direction: a class the port added that CPython does not have.
const upstreamNames = new Set(Object.keys(ref.classes));
for (const cls of EXPRESSION_METADATA.keys()) {
  checks += 1;
  if (upstreamNames.has(cls.name)) exact += 1;
  else fails.push(`${cls.name}: present in the port, absent upstream`);
}

console.log(`typing: ${exact}/${checks} exact, ${fails.length} MISMATCH`);
if (fails.length && VERBOSE) {
  for (const f of fails) console.log(`  ${f}`);
}
if (fails.length) process.exitCode = 1;
