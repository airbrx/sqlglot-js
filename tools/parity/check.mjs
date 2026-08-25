// Parity probes — assert the JS runtime against the extracted upstream snapshots.
// PORT_PLAN.md §7 P0 item 6, §8.3 ("python3 tools/parity/check.py --probe argtypes").
//
//   node tools/parity/check.mjs                # every probe
//   node tools/parity/check.mjs --probe exprs  # one probe
//   node tools/parity/check.mjs --summary      # just the snapshot numbers
//
// Probes report NOT_BUILT until the JS side exists (P1/P2/P4). That is a reported
// state, never a silent pass — a probe that vacuously succeeds because the module it
// checks is missing is worse than no probe.

import { readFileSync, existsSync } from "node:fs";

const DIR = "corpus/parity";
const load = (n) => JSON.parse(readFileSync(`${DIR}/${n}.json`, "utf8"));

async function tryImport(spec) {
  try {
    return await import(spec);
  } catch {
    return null;
  }
}

const results = [];
function report(probe, status, detail) {
  results.push({ probe, status, detail });
}

/* ---- probe 1: tokens ------------------------------------------------------ *
 * Two halves. The membership half (443 TokenType names) has existed since P0 and is
 * cheap but weak — a tokenizer that emits the right type names at the wrong offsets
 * passes it. The stream half is P1's actual exit criterion: every token's type, text,
 * line, col, start, end and comments, byte-exact against CPython over the whole
 * corpus, plus the base-class table derivations. It lives in its own file because it
 * is 23,457 rows and wants its own `--dialect` / `--id` flags for diagnosis.
 */
async function probeTokens() {
  const want = load("tokens");
  const mod = await tryImport("../../src/tokens.js");
  if (!mod?.TokenType) return report("1 tokens", "NOT_BUILT", `${want.count} token types expected`);

  const got = Object.keys(mod.TokenType);
  const missing = want.token_types.filter((t) => !got.includes(t));
  const extra = got.filter((t) => !want.token_types.includes(t));
  // IntEnum ordering is observable: TokenType values are compared and used as Map keys
  // across the parser, so a member inserted in the wrong place is a real defect even
  // when the name set matches.
  const order = want.token_types.findIndex((t, i) => mod.TokenType[t] !== i + 1);

  if (missing.length || extra.length || order !== -1) {
    return report(
      "1 tokens",
      "FAIL",
      `${got.length}/${want.count}` +
        (missing.length ? ` missing ${missing.slice(0, 5).join(",")}` : "") +
        (extra.length ? ` extra ${extra.slice(0, 5).join(",")}` : "") +
        (order !== -1 ? ` value/order wrong at ${want.token_types[order]}` : ""),
    );
  }

  if (!existsSync("corpus/tokens/streams.jsonl")) {
    return report(
      "1 tokens",
      "FAIL",
      `${got.length}/${want.count} types ok, but corpus/tokens/streams.jsonl is missing — ` +
        "run tools/tokens/harvest_streams.py",
    );
  }

  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, ["tools/tokens/check_streams.mjs"], {
    encoding: "utf8",
    env: { ...process.env, TOKENS_CHECK_JSON: "1" },
  });
  let res;
  try {
    res = JSON.parse((r.stdout || "").trim().split("\n").pop());
  } catch {
    return report("1 tokens", "FAIL", `stream checker produced no result: ${(r.stderr || "").split("\n")[0]}`);
  }

  report(
    "1 tokens",
    res.ok ? "PASS" : "FAIL",
    `${got.length}/${want.count} types; ${res.summary}` +
      (res.ok ? "" : `\n    ${res.failureCount} failures — node tools/tokens/check_streams.mjs --verbose`),
  );
}

/* ---- probe 2: expression classes ------------------------------------------ */
async function probeExprs() {
  const want = load("exprs");
  const mod = await tryImport("../../src/_gen/expr_meta.js");
  if (!mod?.EXPR_META) {
    return report("2 exprs", "NOT_BUILT", `${want.count} classes, ordered argTypes expected`);
  }
  let checks = 0;
  const bad = [];
  for (const [key, spec] of Object.entries(want.classes)) {
    const got = mod.EXPR_META[key];
    checks++;
    if (!got) {
      bad.push(`${key}: missing`);
      continue;
    }
    // ORDER matters — §4.6 establishes arg_types insertion order is output-visible.
    const wantArgs = spec.arg_types.map(([k]) => k).join(",");
    const gotArgs = (got.argTypes ?? []).map((a) => (Array.isArray(a) ? a[0] : a)).join(",");
    checks++;
    if (wantArgs !== gotArgs) bad.push(`${key}: argTypes order\n      want ${wantArgs}\n      got  ${gotArgs}`);
    checks++;
    const wantReq = spec.required_args.join(",");
    const gotReq = [...(got.requiredArgs ?? [])].sort().join(",");
    if (wantReq !== gotReq) bad.push(`${key}: requiredArgs`);
  }
  report(
    "2 exprs",
    bad.length === 0 ? "PASS" : "FAIL",
    `${checks} checks over ${want.count} classes` +
      (bad.length ? `; ${bad.length} bad:\n    ${bad.slice(0, 5).join("\n    ")}` : ""),
  );
}

/* ---- probe 3: functions --------------------------------------------------- */
async function probeFunctions() {
  const want = load("functions");
  const mod = await tryImport("../../src/expressions/index.js");
  if (!mod?.ALL_FUNCTIONS) {
    return report(
      "3 functions",
      "NOT_BUILT",
      `${want.all_functions_count} ALL_FUNCTIONS, ${want.function_by_name_count} FUNCTION_BY_NAME expected`,
    );
  }
  const gotAll = mod.ALL_FUNCTIONS.map((c) => c.name ?? c);
  const gotByName = Object.keys(mod.FUNCTION_BY_NAME ?? {});
  const ok =
    gotAll.length === want.all_functions_count &&
    gotByName.length === want.function_by_name_count;
  report(
    "3 functions",
    ok ? "PASS" : "FAIL",
    `ALL_FUNCTIONS ${gotAll.length}/${want.all_functions_count}, ` +
      `FUNCTION_BY_NAME ${gotByName.length}/${want.function_by_name_count}`,
  );
}

/* ---- probe 4: generator dispatch ------------------------------------------ */
async function probeDispatch() {
  const want = load("dispatch");
  const mod = await tryImport("../../src/_gen/dispatch/index.js");
  const base = want.classes.Generator;
  const snow = want.classes.snowflake;
  if (!mod?.DISPATCH) {
    return report(
      "4 dispatch",
      "NOT_BUILT",
      `base ${base.resolved_count} resolved, snowflake ${snow?.resolved_count} expected`,
    );
  }
  const bad = [];
  for (const [cls, spec] of Object.entries(want.classes)) {
    const got = mod.DISPATCH[cls];
    if (!got) {
      bad.push(`${cls}: missing`);
      continue;
    }
    if (Object.keys(got).length !== spec.resolved_count) {
      bad.push(`${cls}: ${Object.keys(got).length} vs ${spec.resolved_count}`);
    }
  }
  report("4 dispatch", bad.length === 0 ? "PASS" : "FAIL", bad.slice(0, 5).join("; "));
}

/* ---- probe 5: dialect registry -------------------------------------------- */
async function probeDialects() {
  const want = load("dialects");
  const mod = await tryImport("../../src/dialects/dialect.js");
  if (!mod?.Dialect?.classes) {
    return report("5 dialects", "NOT_BUILT", `${want.count} dialects expected`);
  }
  const got = Object.keys(mod.Dialect.classes);
  const missing = Object.keys(want.dialects).filter((d) => !got.includes(d));
  report(
    "5 dialects",
    missing.length === 0 ? "PASS" : "FAIL",
    `${got.length}/${want.count}` + (missing.length ? ` missing ${missing.join(",")}` : ""),
  );
}

/* ---- probe 6: parser/tokenizer table shapes -------------------------------- */
async function probeParsers() {
  const want = load("parsers");
  const mod = await tryImport("../../src/parser.js");
  if (!mod?.Parser) {
    const base = want.parsers.Parser;
    return report(
      "6 parsers",
      "NOT_BUILT",
      `base FUNCTIONS ${base.FUNCTIONS}, TYPE_TOKENS ${base.TYPE_TOKENS} expected`,
    );
  }
  const bad = [];
  for (const [name, size] of Object.entries(want.parsers.Parser)) {
    const got = mod.Parser[name];
    const n = got == null ? null : got.size ?? got.length ?? Object.keys(got).length;
    if (n !== size) bad.push(`Parser.${name}: ${n} vs ${size}`);
  }
  report("6 parsers", bad.length === 0 ? "PASS" : "FAIL", bad.slice(0, 5).join("; "));
}

/* --------------------------------------------------------------------------- */

if (!existsSync(DIR)) {
  console.error(`  ${DIR} not found — run tools/parity/extract.py first.`);
  process.exit(2);
}

if (process.argv.includes("--summary")) {
  const e = load("exprs");
  const f = load("functions");
  const d = load("dispatch");
  const t = load("tokens");
  const dl = load("dialects");
  console.log("\n  upstream parity snapshots\n");
  console.log(`    TokenType members       ${t.count}`);
  console.log(`    EXPR_CLASSES            ${e.count}`);
  console.log(`    ALL_FUNCTIONS           ${f.all_functions_count}`);
  console.log(`    FUNCTION_BY_NAME        ${f.function_by_name_count}`);
  console.log(`    dispatch base (resolved)${String(d.classes.Generator.resolved_count).padStart(5)}`);
  console.log(`      of which TRANSFORMS   ${d.classes.Generator.from_transforms}`);
  console.log(`    dispatch snowflake      ${d.classes.snowflake.resolved_count}`);
  console.log(`    registered dialects     ${dl.count}\n`);
  process.exit(0);
}

const only = process.argv.includes("--probe") ? process.argv[process.argv.indexOf("--probe") + 1] : null;
const ALL = {
  tokens: probeTokens,
  exprs: probeExprs,
  functions: probeFunctions,
  dispatch: probeDispatch,
  dialects: probeDialects,
  parsers: probeParsers,
};
for (const [name, fn] of Object.entries(ALL)) {
  if (only && name !== only) continue;
  await fn();
}

console.log();
let failed = 0;
let notBuilt = 0;
for (const r of results) {
  if (r.status === "FAIL") failed++;
  if (r.status === "NOT_BUILT") notBuilt++;
  console.log(`  ${r.status.padEnd(10)} probe ${r.probe.padEnd(14)} ${r.detail ?? ""}`);
}
console.log(
  `\n  ${results.length - failed - notBuilt} pass, ${failed} fail, ${notBuilt} not built yet\n`,
);
process.exit(failed ? 1 : 0);
