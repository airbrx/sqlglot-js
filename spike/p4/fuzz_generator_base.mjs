// Differential: the P4 base `Generator` vs CPython, at the pin.
//
//   python3 spike/p4/gen_generator_base_ref.py > spike/out/generator_base.json
//   node spike/p4/fuzz_generator_base.mjs
//
// Three sections, matching the oracle's:
//
//   A. THE 126 CLASS SETTINGS, by value. Nothing else in this repo asserts these; a
//      hand-transcribed `static FOO = true` that is False upstream is otherwise
//      invisible until a dialect finally reads it (R16's hazard applied to data).
//   B. THE MACHINERY PRIMITIVES at pretty=False and pretty=True. `too_wide` and
//      `sanitize_comment` are corpus-invisible (review finding B2 / R4), so the cases
//      are deliberately astral and CJK.
//   C. THE 6 WIRED `*_sql` METHODS + both `sql()` fallbacks + the error path.
//      Each case rebuilds the tree from a spec and PROVES the tree matches by
//      reproducing Python's `repr` with `toS` before its SQL is compared — so a SQL
//      mismatch always means a generator bug, never a differently-built tree.
//
// Exit 0 only if every section is clean.

import { readFileSync } from "node:fs";
import * as exp from "../../src/expressions/index.js";
import { Generator } from "../../src/generator.js";

const ref = JSON.parse(readFileSync("spike/out/generator_base.json", "utf8"));
const fails = [];
const note = (section, label, want, got) =>
  fails.push(`  [${section}] ${label}\n      want ${JSON.stringify(want)}\n      got  ${JSON.stringify(got)}`);

// EXACT / SKELETON / MISMATCH, the same three-way split `fuzz_ast_coverage.mjs` uses.
// SKELETON means "reached a NotPorted stub" — the ACCEPTED state for a blocking step
// (R13), and the only reason it is a separate bucket rather than a failure. It is
// counted and named, never folded into the pass count, so "N skeleton" can never be
// mistaken for "N working".
const skeleton = [];
const isSkeleton = (e) => e && (e.name === "NotPorted" || e.constructor?.name === "NotPorted");

/* ---- A. class settings ----------------------------------------------------- */
let settingsChecked = 0;
let settingsSkipped = 0;
const skippedNames = [];

const nameOf = (v) => (typeof v === "function" ? `exp.${v.name}` : v);
const dtypeName = (v) => (v && v.__enum__ === "DType" ? `DType.${v.name}` : nameOf(v));

// Deliberately-unseeded tables. PORT_PLAN.md §7 P4 puts filling these in the stub
// queue, AFTER this blocking step is reviewed. Listed BY NAME rather than inferred
// from emptiness, so a table that becomes accidentally empty later still fails.
const DEFERRED_TABLES = new Set([]);

// `AFTER_HAVING_MODIFIER_TRANSFORMS` moved from fully-deferred to PARTIALLY seeded on
// the Databricks-chain generator step (PORT_PLAN.md R31): `cluster`/`distribute`/`sort`
// (Hive/Spark's DML-only `CLUSTER BY`/`DISTRIBUTE BY`/`SORT BY`, reached via
// `query_modifiers`) are real now, verified against real HIVE/SPARK corpus rows;
// `windows`/`qualify` stay unseeded (still nobody's caller). Neither the blanket
// `DEFERRED_TABLES` path (which demands exactly 0) nor the general "map" comparison
// below (which demands the full upstream key set) fits a table that is correctly
// SOME of each, so this gets its own explicit, named check instead of forcing it
// through either.
// `TRANSFORMS` (py:136, expression-CLASS-keyed) moved from fully-deferred to
// PARTIALLY seeded on the Postgres generator step (PORT_PLAN.md P4,
// `src/generators/postgres.js`): 14 upstream `// TODO lambda` placeholders that a real
// Postgres corpus row reached — either "Unsupported expression type X" (no dispatch
// entry at all) or a `function_fallback_sql` mismatch — are real now, each a verified
// one-line port of its CPython lambda. +64 from the properties-dispatch step
// (PORT_PLAN.md): every class that is both in `PROPERTIES_LOCATION` and was still a
// `// TODO lambda` placeholder — the exact intersection that `locate_properties`/
// `properties_sql`/`property_sql`'s generic fallback can now actually reach, verified
// against real property-bearing CREATE rows across snowflake/postgres/databricks/base
// (`spike/p5/fuzz_dialect_generate.mjs`). The other 65 of the 143 upstream keys stay
// unseeded (still nobody's caller). Same reason this table gets its own entry here as
// `AFTER_HAVING_MODIFIER_TRANSFORMS` below: neither `DEFERRED_TABLES` (demands exactly
// 0) nor a full-map comparison (demands the full 143-key set) fits "correctly SOME".
const PARTIALLY_SEEDED_MAP_KEYS = new Map([
  ["AFTER_HAVING_MODIFIER_TRANSFORMS", ["cluster", "distribute", "sort"]],
  [
    "TRANSFORMS",
    [
      "exp.Adjacent", "exp.AllowedValuesProperty", "exp.ArrayContainedBy", "exp.ArrayContainsAll",
      "exp.ArrayOverlaps", "exp.AutoRefreshProperty", "exp.BackupProperty", "exp.CalledOnNullInputProperty",
      "exp.CharacterSetProperty", "exp.CopyGrantsProperty", "exp.CredentialsProperty", "exp.ApiProperty",
      "exp.ApplicationProperty", "exp.CatalogProperty", "exp.ComputeProperty", "exp.DatabaseProperty",
      "exp.DynamicProperty", "exp.EmptyProperty", "exp.EnviromentProperty", "exp.HandlerProperty",
      "exp.ParameterStyleProperty", "exp.ExecuteAsProperty", "exp.Except", "exp.ExternalProperty",
      "exp.GlobalProperty", "exp.HeapProperty", "exp.HybridProperty", "exp.IcebergProperty",
      "exp.InheritsProperty", "exp.InputModelProperty", "exp.Intersect", "exp.JSONBContainsAnyTopKeys",
      "exp.JSONBContainsAllTopKeys", "exp.JSONBContainsTopKey", "exp.JSONBDeleteAtPath", "exp.JSONBPathExists",
      "exp.LanguageProperty", "exp.LocationProperty", "exp.LogProperty", "exp.MaskingProperty",
      "exp.MaterializedProperty", "exp.NetworkProperty", "exp.NoPrimaryIndexProperty", "exp.OnCommitProperty",
      "exp.OnProperty", "exp.Operator", "exp.OutputModelProperty", "exp.RemoteWithConnectionModelProperty",
      "exp.ReturnsProperty", "exp.RowAccessProperty", "exp.SampleProperty", "exp.SecureProperty",
      "exp.SecurityIntegrationProperty", "exp.SetConfigProperty", "exp.SetProperty", "exp.SettingsProperty",
      "exp.SharingProperty", "exp.SqlReadWriteProperty", "exp.SqlSecurityProperty", "exp.StabilityProperty",
      "exp.StreamingTableProperty", "exp.StrictProperty", "exp.Tags", "exp.TemporaryProperty",
      "exp.ToTableProperty", "exp.TransformModelProperty", "exp.TransientProperty", "exp.VirtualProperty",
      "exp.Union", "exp.UnloggedProperty", "exp.UsingTemplateProperty", "exp.Variadic",
      "exp.ViewAttributeProperty", "exp.VolatileProperty", "exp.WithJournalTableProperty", "exp.WithProcedureOptions",
      "exp.WithSchemaBindingProperty", "exp.ForceProperty",
    ],
  ],
]);

for (const [name, want] of Object.entries(ref.settings)) {
  let got;
  try {
    got = Generator[name];
  } catch (e) {
    // A throwing static getter is how this file marks a setting whose VALUE depends on
    // an unported module (see SUPPORTED_JSON_PATH_PARTS). That is a declared deferral,
    // not a missing name.
    if (isSkeleton(e)) {
      skeleton.push(`setting ${name} (${e.message})`);
      continue;
    }
    throw e;
  }

  if (DEFERRED_TABLES.has(name)) {
    const size = got instanceof Map ? got.size : [...(got ?? [])].length;
    if (size !== 0) note("settings", `${name}: expected deferred/empty at this step`, 0, size);
    else skeleton.push(`table ${name} (0 of ${want.size} entries seeded)`);
    continue;
  }

  if (PARTIALLY_SEEDED_MAP_KEYS.has(name)) {
    const wantSeeded = PARTIALLY_SEEDED_MAP_KEYS.get(name);
    // `nameOf` turns an expression-CLASS key (TRANSFORMS) into "exp.ClassName"; a
    // plain string key (AFTER_HAVING_MODIFIER_TRANSFORMS) passes through unchanged.
    const gotKeys = got instanceof Map ? [...got.keys()].map(nameOf) : Object.keys(got ?? {});
    if (JSON.stringify(gotKeys) !== JSON.stringify(wantSeeded)) {
      note("settings", `${name}: expected exactly the seeded subset`, wantSeeded, gotKeys);
    } else {
      settingsChecked++;
      skeleton.push(`table ${name} (${wantSeeded.length} of ${want.size} entries seeded: ${wantSeeded.join(", ")})`);
    }
    continue;
  }

  if (got === undefined && want.kind !== "scalar") {
    note("settings", `${name}: missing on JS Generator`, want.kind, "undefined");
    continue;
  }

  if (want.kind === "scalar") {
    // Python None -> JS null; the seeder emits `null`, so compare loosely on nullish.
    const same = want.value === null ? got === null || got === undefined : got === want.value;
    if (!same) note("settings", name, want.value, got);
    else settingsChecked++;
  } else if (want.kind === "seq") {
    const items = [...(got ?? [])].map(dtypeName);
    if (items.length !== want.size) {
      note("settings", `${name}.size`, want.size, items.length);
    } else if (want.items.every((x) => typeof x === "string" || typeof x === "number" || typeof x === "boolean")) {
      // Sets are unordered in Python; only assert ORDER where upstream's own type is.
      const a = want.ordered ? want.items : [...want.items].sort();
      const b = want.ordered ? items : [...items].sort();
      if (JSON.stringify(a) !== JSON.stringify(b)) note("settings", name, a, b);
      else settingsChecked++;
    } else {
      settingsChecked++;
    }
  } else if (want.kind === "map") {
    const size = got instanceof Map ? got.size : Object.keys(got ?? {}).length;
    if (size !== want.size) {
      note("settings", `${name}.size`, want.size, size);
    } else {
      const keys = got instanceof Map ? [...got.keys()].map(dtypeName) : Object.keys(got ?? {});
      if (JSON.stringify(keys) !== JSON.stringify(want.keys)) {
        note("settings", `${name}.keys`, want.keys, keys);
      } else {
        settingsChecked++;
      }
    }
  } else if (want.kind === "regex") {
    // Python's pattern source vs JS's. They are different regex dialects in general,
    // so this asserts the SOURCE TEXT matches — which for the one setting involved
    // (`SAFE_JSON_PATH_KEY_RE`) it does, and a divergence is worth a human look
    // rather than a silent skip.
    const src = got instanceof RegExp ? got.source : String(got);
    if (src !== want.pattern) note("settings", `${name}.pattern`, want.pattern, src);
    else settingsChecked++;
  } else {
    settingsSkipped++;
    skippedNames.push(`${name}(${want.kind})`);
  }
}

/* ---- B. machinery primitives ------------------------------------------------ */
const lit = (n) => exp.Literal.number(n);
const PRIMS = {
  "sep()": (g) => g.sep(),
  "sep(', ')": (g) => g.sep(", "),
  "sep('')": (g) => g.sep(""),
  "seg(FOO)": (g) => g.seg("FOO"),
  "seg(FOO,'')": (g) => g.seg("FOO", ""),
  "indent(a\\nb)": (g) => g.indent("a\nb"),
  "indent(a\\nb,level=2)": (g) => g.indent("a\nb", { level: 2 }),
  "indent(a\\nb,pad=0,skip_first)": (g) => g.indent("a\nb", { pad: 0, skip_first: true }),
  "indent(a\\nb,skip_last)": (g) => g.indent("a\nb", { skip_last: true }),
  "too_wide(ascii 79)": (g) => g.too_wide(["x".repeat(79)]),
  "too_wide(ascii 81)": (g) => g.too_wide(["x".repeat(81)]),
  "too_wide(astral 27x)": (g) => g.too_wide(["\u{1f600}\u{1f601}\u{1f602}".repeat(27)]),
  "too_wide(astral 26x)": (g) => g.too_wide(["\u{1f600}\u{1f601}\u{1f602}".repeat(26)]),
  "too_wide(cjk 27x)": (g) => g.too_wide(["中文字".repeat(27)]),
  "too_wide(split)": (g) => g.too_wide(["x".repeat(40), "y".repeat(41)]),
  "sanitize_comment(hi)": (g) => g.sanitize_comment("hi"),
  "sanitize_comment( hi )": (g) => g.sanitize_comment(" hi "),
  "sanitize_comment(*/)": (g) => g.sanitize_comment("a*/b"),
  "sanitize_comment(/*)": (g) => g.sanitize_comment("a/*b"),
  "sanitize_comment(both)": (g) => g.sanitize_comment("/*a*/"),
  "sanitize_comment(astral)": (g) => g.sanitize_comment("\u{1f600}\u{1f601}\u{1f602}"),
  "sanitize_comment(nbsp)": (g) => g.sanitize_comment("\u00a0x\u00a0"),
  "normalize_func(foo)": (g) => g.normalize_func("foo"),
  "format_args(1,2)": (g) => g.format_args(lit(1), lit(2)),
  "format_args(sep=|)": (g) => g.format_args(lit(1), lit(2), { sep: "|" }),
  "format_args(drops bools)": (g) => g.format_args(lit(1), true, null, lit(2)),
  "func(F,1)": (g) => g.func("f", lit(1)),
  "func(F,suffix)": (g) => g.func("f", lit(1), { suffix: "]" }),
  "func(F,normalize=False)": (g) => g.func("f", lit(1), { normalize: false }),
  "escape_str(quote)": (g) => g.escape_str("it's"),
  "escape_str(newline)": (g) => g.escape_str("a\nb"),
  "escape_str(astral)": (g) => g.escape_str("\u{1f600}\u{1f601}\u{1f602}"),
  "maybe_comment(plain)": (g) => g.maybe_comment("SQL", null, { comments: ["c1"] }),
  "maybe_comment(two)": (g) => g.maybe_comment("SQL", null, { comments: ["c1", "c2"] }),
  "maybe_comment(separated)": (g) => g.maybe_comment("SQL", null, { comments: ["c1"], separated: true }),
  "maybe_comment(leading ws)": (g) => g.maybe_comment(" SQL", null, { comments: ["c1"], separated: true }),
  "maybe_comment(empty sql)": (g) => g.maybe_comment("", null, { comments: ["c1"], separated: true }),
  "maybe_comment(none)": (g) => g.maybe_comment("SQL", null, { comments: null }),
  "wrap(select)": (g) => g.wrap(exp.select(new exp.Star()).from_(exp.toTable("t"))),
};

let primsChecked = 0;
let primsMissing = 0;
for (const want of ref.primitives) {
  const fn = PRIMS[want.label];
  if (!fn) {
    primsMissing++;
    fails.push(`  [primitive] ${want.label}: no JS case defined (oracle has one)`);
    continue;
  }
  const g = new Generator({ pretty: want.pretty });
  const tag = `${want.label} pretty=${want.pretty}`;
  let got;
  try {
    got = { ok: true, value: fn(g) };
  } catch (e) {
    if (isSkeleton(e) && want.ok) {
      // The primitive itself is ported, but it recursed into an unported `*_sql`.
      skeleton.push(`primitive ${tag}: ${e.message}`);
      continue;
    }
    got = { ok: false, error: e.constructor.name };
  }
  if (want.ok !== got.ok) note("primitive", tag, want.ok ? want.value : want.error, got.ok ? got.value : got.error);
  else if (want.ok && got.value !== want.value) note("primitive", tag, want.value, got.value);
  else primsChecked++;
}

/* ---- C. wired *_sql methods + fallbacks ------------------------------------- */
function build(spec) {
  if (spec === null || typeof spec !== "object") return spec;
  if (Array.isArray(spec)) return spec.map(build);
  if (spec.lit !== undefined) throw new Error(`unrepresentable literal ${spec.lit}`);
  const C = exp[spec.c];
  if (!C) throw new Error(`unknown expression class ${spec.c}`);
  const args = {};
  for (const [k, v] of Object.entries(spec.a)) args[k] = build(v);
  // skipInitHook: the oracle captured the tree AFTER Python's __init__ hooks ran, so
  // re-running them here would apply the same normalisation twice.
  return new C(args, { skipInitHook: true });
}

const specByLabel = new Map();
for (const c of ref.gen_cases) if (c.spec) specByLabel.set(c.label, c);

let genChecked = 0;
let reprChecked = 0;
for (const want of ref.gen_cases) {
  const base = specByLabel.get(want.label);
  const tag = `${want.label} pretty=${want.pretty}`;
  let node;
  try {
    node = build(base.spec);
  } catch (e) {
    fails.push(`  [gen] ${tag}: build failed — ${e.message}`);
    continue;
  }

  // Tree identity, proven not assumed: if this fails the SQL comparison below is
  // meaningless, so it is reported as its own failure.
  if (!want.pretty) {
    const gotRepr = exp.toS(node);
    if (gotRepr !== base.repr) note("repr", want.label, base.repr, gotRepr);
    else reprChecked++;
  }

  const g = new Generator({ pretty: want.pretty });
  let got;
  try {
    got = { ok: true, sql: g.sql(node), unsupported: [...g.unsupported_messages] };
  } catch (e) {
    if (isSkeleton(e) && want.ok) {
      skeleton.push(`gen ${tag}: ${e.message}`);
      continue;
    }
    got = { ok: false, error: e.constructor.name, message: e.message };
  }

  if (want.ok !== got.ok) {
    note("gen", tag, want.ok ? want.sql : want.error, got.ok ? got.sql : `${got.error}: ${got.message}`);
  } else if (want.ok) {
    if (got.sql !== want.sql) note("gen", tag, want.sql, got.sql);
    else if (JSON.stringify(got.unsupported) !== JSON.stringify(want.unsupported)) {
      // §3.1(D) / review finding B3: unsupported_messages is asserted output, not
      // diagnostics, so a divergence here is a real failure.
      note("gen.unsupported", tag, want.unsupported, got.unsupported);
    } else genChecked++;
  } else genChecked++;
}

/* ---- the sql() error path ---------------------------------------------------- */
// `sql()` must have EXACTLY two fallbacks. A node that is neither dispatched, nor a
// Func, nor a Property has to raise — if this ever stops raising, the fallbacks have
// silently widened and every unported node type would render as something plausible.
let errPath = "ok";
try {
  new Generator().sql(new exp.Expr({}));
  errPath = "did not raise";
} catch (e) {
  const wantMsg = ref.unsupported_type.message;
  if (e.message !== wantMsg) errPath = `message ${JSON.stringify(e.message)} != ${JSON.stringify(wantMsg)}`;
}
if (errPath !== "ok") fails.push(`  [sql-error-path] ${errPath}`);

/* ---- report ------------------------------------------------------------------ */
console.log(`  A settings   ${settingsChecked}/${Object.keys(ref.settings).length} compared` +
  (settingsSkipped ? `, ${settingsSkipped} opaque (${skippedNames.slice(0, 3).join(", ")}…)` : ""));
console.log(`  B primitives ${primsChecked}/${ref.primitives.length} exact` + (primsMissing ? `, ${primsMissing} undefined in JS` : ""));
console.log(`  C generate   ${genChecked}/${ref.gen_cases.length} exact, ${reprChecked} trees repr-verified`);
console.log(`  D sql() error path: ${errPath}`);
console.log(`  SKELETON (expected at the blocking step, NOT counted as passing): ${skeleton.length}`);
for (const s of skeleton.slice(0, 8)) console.log(`      · ${s}`);
if (skeleton.length > 8) console.log(`      · … and ${skeleton.length - 8} more`);

if (fails.length) {
  console.error(`\n  ${fails.length} FAILURE(S):`);
  for (const f of fails.slice(0, 25)) console.error(f);
  if (fails.length > 25) console.error(`  … and ${fails.length - 25} more`);
  process.exit(1);
}
console.log("  all green");
