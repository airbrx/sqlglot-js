// Tests for contrib/sessionState.js.
//
// Ports the gateway's own session-state test corpora (fetched 2026-10-26,
// commit named in /tmp/gw-session-ref/SOURCE_COMMIT.txt — see
// docs/proposals/session-state-module.md for the full design this implements):
//   - postgresql-search-path-tracker.test.js's CORPUS array (SearchPathTracker.classify)
//     and its Session group (effectiveSearchPath/beginSessionStateChange/confirmSessionStateChange)
//   - session-state-replay.test.js's Session.applySessionStateChange / renderReplayStatement /
//     dedupe / namespace-collapse / round-trip behavior
//
// Where this module is deliberately MORE precise than the regex it generalizes
// (real per-statement batch attribution instead of pessimism; a quoted 'none'
// recognized as a true role reset; Databricks' own backslash string-escape
// convention honored by render() where the gateway's hand-rolled quoting
// assumes SQL-standard doubled-quote escaping universally), the test shows
// both answers and explains why the new one is safe — never a silent swap.

import test from "node:test";
import assert from "node:assert/strict";
import { classify, createState, apply, effectiveSearchPath, render } from "../contrib/sessionState.js";

function one(sql, dialect = "postgres") {
  const effects = classify(sql, { dialect });
  assert.equal(effects.length, 1, `expected exactly one statement in ${JSON.stringify(sql)}`);
  return effects[0];
}

// ---------------------------------------------------------------------------
// classify(): Postgres search_path / role / session_authorization corpus —
// ported from SearchPathTracker's own CORPUS array. Each row there asserted a
// SUBSET of {effect, label, role, auth} on SearchPathTracker.classify(sql);
// here the equivalent subset is asserted on this module's Effect shape
// (kind/key/value/scope), which carries strictly more information (e.g. WHICH
// statement in a batch did something, not just that the batch as a whole did).
// ---------------------------------------------------------------------------

test("classify: SET search_path = list form is a Command fallback, label is the raw text", () => {
  const e = one("SET search_path = a, b");
  assert.equal(e.kind, "set");
  assert.equal(e.key, "search_path");
  assert.equal(e.value, "a, b");
});

test("classify: SET TO with quoted names preserves raw quoting in the value", () => {
  const e = one('SET search_path TO "My Schema", public');
  assert.equal(e.kind, "set");
  assert.equal(e.key, "search_path");
  assert.equal(e.value, '"My Schema", public');
});

test("classify: SET SESSION search_path = x (single value) is a real Set node", () => {
  const e = one("SET SESSION search_path = x");
  assert.equal(e.kind, "set");
  assert.equal(e.key, "search_path");
  assert.equal(e.value, "x");
  assert.equal(e.scope, "session");
});

test("classify: SET SCHEMA is the same canonical key as search_path (documented alias)", () => {
  const schema = one("SET SCHEMA 'other'");
  const searchPath = one("SET search_path TO 'other'");
  assert.equal(schema.key, "search_path");
  assert.equal(schema.key, searchPath.key);
  assert.equal(schema.value, "'other'");
});

test("classify: SET LOCAL SCHEMA / SET LOCAL search_path are scoped local, never applied by apply()", () => {
  const schema = one("SET LOCAL SCHEMA 'other'");
  const path = one("SET LOCAL search_path = x");
  assert.equal(schema.scope, "local");
  assert.equal(path.scope, "local");
  let state = createState("postgres");
  state = apply(state, path);
  assert.equal(state.searchPath, "default", "a local SET must never mutate persisted state");
});

test("classify: TO DEFAULT / RESET search_path / RESET ALL are all a search_path reset", () => {
  for (const sql of ["SET search_path TO DEFAULT", "RESET search_path", "RESET ALL"]) {
    const e = one(sql);
    assert.equal(e.kind, "reset", sql);
    assert.equal(e.key, "search_path", sql);
  }
});

test("classify: RESET ALL does not reset role or session_authorization (both exempt)", () => {
  // SearchPathTracker's own row: {effect:'default', label:D, role:'none', auth:'none'}.
  // This module reports a single Effect per statement; "RESET ALL doesn't touch
  // role/auth" is proven by apply() leaving roleSwitched/authSwitched untouched,
  // asserted in the Session-equivalent group below.
  const e = one("RESET ALL");
  assert.equal(e.key, "search_path");
});

test("classify: DISCARD ALL resets everything (role and session user included)", () => {
  const e = one("DISCARD ALL");
  assert.equal(e.kind, "discard");
  assert.equal(e.key, "all");
});

test("classify: a quoted \"search_path\" is a real identifier read correctly — MORE precise than the regex", () => {
  // SearchPathTracker's own corpus: 'a quoted "search_path" is not readable' →
  // {effect: 'unknown'} (its regex only matches the unquoted spelling). A real
  // AST has no such blind spot: the Column node's name is "search_path"
  // whether quoted or not, so this module classifies it exactly like the
  // unquoted form — strictly more information, not a safety regression (it
  // recognizes MORE of what Postgres is really doing, never less).
  const e = one('SET "search_path" = x');
  assert.equal(e.kind, "set");
  assert.equal(e.key, "search_path");
  assert.equal(e.value, "x");
});

test("classify: FROM CURRENT has no recognizable value — unknown, matching SearchPathTracker's own corpus row", () => {
  const e = one("SET search_path FROM CURRENT");
  assert.equal(e.kind, "unknown");
  assert.equal(e.unknownReason, "unrecognized-search-path-form");
});

// ---- quoted names and comments: the real tokenizer is quote/comment-aware by
// construction, so these all behave correctly without any special handling ----

test("classify: a '--' inside a quoted value is part of the value, not a comment", () => {
  // This single-value form parses to a real Set node (an explicit `=`
  // delimiter is present), so the value comes from a real, already-decoded
  // Literal — quotes stripped, same as every other real Set value this module
  // reports. (The list-form Command-fallback reader below preserves raw
  // quoting instead, since there is no decoded Literal to read there — see
  // the next test and the design doc's "fallback readers" section.)
  const e = one("SET search_path = 'a--b'");
  assert.equal(e.value, "a--b");
});

test("classify: the list-form Command fallback preserves raw quoting in its value (no decoded Literal to read)", () => {
  const e = one(`SET search_path = "x/*1*/y", public`);
  assert.equal(e.kind, "set");
  assert.equal(e.key, "search_path");
  assert.equal(e.value, '"x/*1*/y", public');
});

test("classify: a trailing line comment is stripped like any other comment", () => {
  const e = one("SET search_path = a -- note");
  assert.equal(e.value, "a");
});

// ---- roles ----

test("classify: SET ROLE switches the role", () => {
  const e = one("SET ROLE admin");
  assert.equal(e.kind, "role");
  assert.equal(e.key, "role");
  assert.equal(e.value, "admin");
});

test("classify: SET role='x' (plain-setting form) is the identical statement", () => {
  const e = one("SET role='admin'");
  assert.equal(e.kind, "role");
  assert.equal(e.value, "admin");
});

test("classify: SET LOCAL ROLE is scoped local, ignored by apply()", () => {
  const e = one("SET LOCAL role = 'x'");
  assert.equal(e.scope, "local");
});

test("classify: SET ROLE NONE / RESET ROLE both reset the role", () => {
  for (const sql of ["SET ROLE NONE", "SET role = none", "SET role TO DEFAULT", "RESET ROLE"]) {
    const e = one(sql);
    assert.equal(e.kind, "reset", sql);
    assert.equal(e.key, "role", sql);
  }
});

test("classify: a QUOTED 'none' value ALSO resets the role — MORE precise than the regex", () => {
  // SearchPathTracker's own comment: "a quoted 'none' also resets in Postgres
  // (the string is compared to \"none\"), but it is treated as a switch here --
  // failing closed costs nothing." A real AST distinguishes a bare Var('NONE')
  // from a quoted Literal('none') perfectly well, so this module can safely
  // report the TRUE Postgres behavior (a real reset) instead of failing
  // closed — recognizing a real reset as a reset is strictly more accurate,
  // never a safety regression (it never reports a switch as a reset, only
  // the reverse).
  const e = one("SET role = 'none'");
  assert.equal(e.kind, "reset");
  assert.equal(e.key, "role");
});

test("classify: a quoted \"role\" setting name is read exactly like the unquoted spelling", () => {
  // SearchPathTracker: 'a quoted "role" setting name' → treated as a switch by
  // failing-closed guesswork. This module reads the real identifier, so it is
  // simply correct, same as the quoted-search_path case above.
  const e = one('SET "role" = admin');
  assert.equal(e.kind, "role");
  assert.equal(e.key, "role");
});

// ---- session_authorization ----

test("classify: SET SESSION AUTHORIZATION switches the session user (role untouched)", () => {
  const e = one("SET SESSION AUTHORIZATION bob");
  assert.equal(e.kind, "auth");
  assert.equal(e.key, "session_authorization");
  assert.equal(e.value, "bob");
});

test("classify: both spellings (two words / underscored) name the identical GUC", () => {
  const twoWord = one("SET session_authorization = 'bob'");
  const underscored = one("SET SESSION AUTHORIZATION bob");
  assert.equal(twoWord.key, underscored.key);
});

test("classify: SET LOCAL SESSION AUTHORIZATION is scoped local", () => {
  const e = one("SET LOCAL SESSION AUTHORIZATION bob");
  assert.equal(e.scope, "local");
});

test("classify: SESSION AUTHORIZATION DEFAULT / RESET SESSION AUTHORIZATION reset role AND session user", () => {
  for (const sql of ["SET SESSION AUTHORIZATION DEFAULT", "SET session_authorization TO DEFAULT", "RESET SESSION AUTHORIZATION", "RESET session_authorization"]) {
    const e = one(sql);
    assert.equal(e.kind, "reset", sql);
    assert.equal(e.key, "session_authorization", sql);
  }
});

// ---- unreadable side effects ----

test("classify: set_config(...) is unknown regardless of schema-qualification or quoting", () => {
  for (const sql of [
    "SELECT set_config('search_path', 'x', false)",
    "SELECT pg_catalog.set_config('search_path','evil',false)",
    `SELECT "set_config"('search_path','evil',false)`,
  ]) {
    const e = one(sql);
    assert.equal(e.kind, "unknown", sql);
    assert.equal(e.unknownReason, "set_config-call", sql);
    assert.equal(e.replayable, false, sql);
  }
});

test("classify: a bare CALL is an opaque procedural statement", () => {
  const e = one("CALL p()");
  assert.equal(e.kind, "unknown");
  assert.equal(e.unknownReason, "opaque-procedural-call");
});

// ---- batches: deliberately MORE precise than the pessimistic regex tracker ----

test("classify: a batch gets one Effect per statement, each exactly attributed — not one pessimistic answer for the whole batch", () => {
  // SearchPathTracker's own corpus: 'a role switch in a batch' →
  // {role: 'switched'} for the WHOLE 2-statement batch (it cannot say WHICH
  // statement did it). This module knows exactly which one did, because each
  // statement gets its own real AST.
  const effects = classify("SET ROLE admin; SELECT 1", { dialect: "postgres" });
  assert.equal(effects.length, 2);
  assert.equal(effects[0].kind, "role");
  assert.equal(effects[1].kind, "none", "the SELECT itself has no session effect");
});

test("classify: an unparseable statement anywhere in a batch reports one unknown Effect for the whole input", () => {
  // This module cannot attribute a parse failure to one statement the way it
  // attributes per-statement semantics on a successfully parsed batch — a
  // ParseError aborts the whole parse, same as contrib/gatewaySqlMetadata.js's
  // own catch-all. Still strictly safer than the regex (which never throws at
  // all): the caller gets kind: "unknown", not a false "none".
  const effects = classify("SELECT 1; SELECT (1", { dialect: "postgres" });
  assert.equal(effects.length, 1);
  assert.equal(effects[0].kind, "unknown");
});

// ---- documented upstream-faithful throws: AIR-1864 contribution-path candidates ----

test("classify: Postgres START TRANSACTION ISOLATION LEVEL throws at parse (upstream grammar gap) — reported unknown, not papered over", () => {
  const e = one("START TRANSACTION ISOLATION LEVEL READ COMMITTED");
  assert.equal(e.kind, "unknown");
  assert.equal(e.unknownReason.startsWith("parse-error"), true);
});

test("classify: TSQL SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED throws (the other three phrasings parse to a real Set node, upstream-faithful either way)", () => {
  const unco = classify("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED", { dialect: "tsql" })[0];
  assert.equal(unco.kind, "unknown");
  for (const sql of [
    "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
    "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
  ]) {
    const e = classify(sql, { dialect: "tsql" })[0];
    assert.equal(e.kind, "transaction", sql);
    assert.equal(e.key, "isolation_level", sql);
  }
});

// ---------------------------------------------------------------------------
// Postgres Session-equivalent group — ported from postgresql-search-path-
// tracker.test.js's `sessionAfter`/`trusted` helper tests, reproduced here via
// createState + classify + apply + effectiveSearchPath.
// ---------------------------------------------------------------------------

function trusted(...statements) {
  let state = createState("postgres");
  for (const sql of statements) {
    const [effect] = classify(sql, { dialect: "postgres" });
    state = apply(state, effect);
  }
  return effectiveSearchPath(state);
}

test("Session: default until a path is set, then that path", () => {
  assert.equal(trusted(), "default");
  assert.equal(trusted("SET search_path = a"), "path:a");
  assert.equal(trusted("SET SCHEMA 'a'", "SET search_path TO DEFAULT"), "default");
});

test("Session: while a role is switched, default/$user paths are unknown; explicit non-$user paths are fine", () => {
  assert.equal(trusted("SET ROLE x"), null);
  assert.equal(trusted("SET ROLE x", "RESET ALL"), null, "RESET ALL does not undo the role");
  assert.equal(trusted("SET ROLE x", 'SET search_path = "$user", public'), null);
  assert.equal(trusted("SET ROLE x", "SET search_path = a, b"), "path:a, b");
  assert.equal(trusted("SET role='x'"), null);
});

test("Session: RESET ROLE and DISCARD ALL restore trust", () => {
  assert.equal(trusted("SET ROLE x", "RESET ROLE", "RESET ALL"), "default");
  assert.equal(trusted("SET ROLE x", "DISCARD ALL"), "default");
});

test("Session: returning the ROLE to the session user does not restore trust while the SESSION user is switched", () => {
  assert.equal(trusted("SET SESSION AUTHORIZATION bob"), null);
  assert.equal(trusted("SET SESSION AUTHORIZATION bob", "SET ROLE NONE"), null, "current_user is still bob");
  assert.equal(trusted("SET SESSION AUTHORIZATION bob", "RESET ROLE", "RESET ALL"), null);
  assert.equal(trusted("SET SESSION AUTHORIZATION bob", "RESET SESSION AUTHORIZATION"), "default");
  assert.equal(trusted("SET SESSION AUTHORIZATION bob", "SET SESSION AUTHORIZATION DEFAULT"), "default");
  assert.equal(trusted("SET SESSION AUTHORIZATION bob", "DISCARD ALL"), "default");
});

test("Session: RESET SESSION AUTHORIZATION also clears an active SET ROLE", () => {
  assert.equal(trusted("SET ROLE x", "SET SESSION AUTHORIZATION bob", "RESET SESSION AUTHORIZATION"), "default");
  assert.equal(trusted("SET ROLE x", "SET SESSION AUTHORIZATION bob"), null);
});

test("Session: a caller only applies a confirmed, outside-a-transaction change (transaction-rollback-awareness stays gateway-side policy)", () => {
  // apply() is a pure, immediate reducer by design (see the design doc's
  // Reducer section) — it has no notion of "this statement might still roll
  // back." A caller that needs SearchPathTracker's own "a SET inside an open
  // transaction, or one that fails, leaves the path unknown" behavior gets it
  // for free from the Effect facts alone: just don't call apply() until the
  // statement is confirmed to have succeeded outside a transaction. This is
  // exactly what postgresql.Session.js's beginSessionStateChange/
  // confirmSessionStateChange pair already does today, now driven by
  // effect.kind/effect.scope instead of change.effect/change.role/change.auth.
  let state = createState("postgres");
  const effect = classify("SET search_path = a", { dialect: "postgres" })[0];
  // The statement "failed" — never confirmed, so apply() is never called.
  assert.equal(effectiveSearchPath(state), "default");

  // The statement ran inside an open transaction that could still roll back —
  // same rule: don't call apply() until COMMIT confirms it.
  const insideTransaction = true;
  if (!insideTransaction) state = apply(state, effect);
  assert.equal(effectiveSearchPath(state), "default", "ROLLBACK would undo it");
});

// ---------------------------------------------------------------------------
// Databricks replay group — ported from session-state-replay.test.js's
// Session.applySessionStateChange / renderReplayStatement / dedupe /
// namespace-collapse / round-trip behavior, reproduced via classify + apply +
// render.
// ---------------------------------------------------------------------------

function applyAll(dialect, ...statements) {
  let state = createState(dialect);
  for (const sql of statements) {
    const [effect] = classify(sql, { dialect });
    state = apply(state, effect);
  }
  return state;
}

test("Databricks: SET records into variables + replayLog", () => {
  const state = applyAll("databricks", "SET timezone = 'EST'");
  assert.equal(state.variables.timezone, "EST");
  // R2373.2: the replay entry now also carries valueRaw (source quoting
  // intact) alongside the decoded value — see the Databricks raw-text SET
  // replay group below for why render() needs it.
  assert.deepEqual(state.replayLog, [{ kind: "set", key: "timezone", value: "EST", valueRaw: "'EST'" }]);
});

test("Databricks: USE namespace records catalog + schema and a single use_namespace replay entry", () => {
  const state = applyAll("databricks", "USE main.sales");
  assert.equal(state.catalog, "main");
  assert.equal(state.schema, "sales");
  assert.deepEqual(state.replayLog, [{ kind: "use_namespace", catalog: "main", schema: "sales" }]);
});

test("Databricks: replayLog dedupes repeated SET on the same key (rebuild-from-state, last-write-wins)", () => {
  const state = applyAll(
    "databricks",
    "SET timezone = 'UTC'",
    "SET timezone = 'EST'",
    "SET role = 'admin'",
    "SET timezone = 'PST'",
  );
  assert.equal(state.variables.timezone, "PST");
  assert.equal(state.variables.role, "admin");
  assert.equal(state.replayLog.length, 2, "one entry per key, not one per SET statement");
  const tzEntry = state.replayLog.find((e) => e.key === "timezone");
  assert.deepEqual(tzEntry, { kind: "set", key: "timezone", value: "PST", valueRaw: "'PST'" });
});

test("Databricks: namespace collapse preserves the other half on a partial USE (bissellator review case)", () => {
  let state = createState("databricks");
  state = apply(state, classify("USE CATALOG main", { dialect: "databricks" })[0]);
  assert.deepEqual(state.replayLog, [{ kind: "use_catalog", catalog: "main" }]);

  state = apply(state, classify("USE SCHEMA sales", { dialect: "databricks" })[0]);
  assert.deepEqual(state.replayLog, [{ kind: "use_namespace", catalog: "main", schema: "sales" }]);

  // A second USE SCHEMA must not drop the catalog that's still in effect.
  state = apply(state, classify("USE SCHEMA staging", { dialect: "databricks" })[0]);
  assert.equal(state.catalog, "main");
  assert.equal(state.schema, "staging");
  assert.deepEqual(state.replayLog, [{ kind: "use_namespace", catalog: "main", schema: "staging" }]);
});

test("Databricks: render() produces correct SQL for every replay-log entry kind (USE forms via the real generator, SET via raw text)", () => {
  // R2373.2: USE forms still go through the real generator (an identifier
  // position, no raw-text concern); SET now emits the client's original
  // text verbatim instead of a generator-quoted string Literal — see the
  // "Databricks raw-text SET replay (AIR-2373 finding 2)" group below for
  // why that generator path was wrong for this specific dialect family.
  const state = applyAll("databricks", "SET tag = 'reporting team'", "USE main.sales");
  const rendered = render(state, { dialect: "databricks" });
  assert.deepEqual(rendered.sort(), ["SET tag = 'reporting team'", "USE main.sales"].sort());
});

test("Databricks: render() round-trips an embedded apostrophe byte-for-byte via raw text, not generator escaping", () => {
  // contrib/README.md: Databricks' STRING_ESCAPES does not declare '' as an
  // apostrophe escape (unlike Postgres/Snowflake), so 'o''brien' tokenizes
  // as two adjacent Literals folded into a Concat — there is no single
  // decoded Literal node here for a generator to re-quote correctly even in
  // principle. render() instead re-emits apply()'s own `valueRaw` (the exact
  // source span, doubled quote intact) verbatim — simpler AND more correct
  // than asking any generator (this module's own old approach, or the
  // gateway's pre-AIR-2365 hand-rolled doubled-quote convention) to re-derive
  // valid syntax from the decoded value "o'brien" alone.
  const state = applyAll("databricks", "SET note = 'o''brien'");
  assert.equal(state.variables.note, "o'brien");
  const [rendered] = render(state, { dialect: "databricks" });
  assert.equal(rendered, "SET note = 'o''brien'", "re-emitted byte-for-byte from valueRaw");
  const [reparsed] = classify(rendered, { dialect: "databricks" });
  assert.equal(reparsed.value, "o'brien", "the value must survive classify -> apply -> render -> classify intact");
});

test("Databricks: round trip stays inside the session-state grammar for every statement shape", () => {
  const state = applyAll(
    "databricks",
    "SET timezone = 'America/New_York'",
    "SET role = admin",
    "USE main.sales",
  );
  const rendered = render(state, { dialect: "databricks" });
  assert.equal(rendered.length, 3);
  for (const sql of rendered) {
    const [effect] = classify(sql, { dialect: "databricks" });
    assert.notEqual(effect.kind, "none", `rendered statement must still be a session-state change: ${sql}`);
    assert.notEqual(effect.kind, "unknown", sql);
  }
});

test("Databricks: applying a null/no-op-shaped effect from a non-session statement never mutates state", () => {
  const state = createState("databricks");
  const [selectEffect] = classify("SELECT 1", { dialect: "databricks" });
  const next = apply(state, selectEffect);
  assert.deepEqual(next.variables, {});
  assert.deepEqual(next.replayLog, []);
});

// ---------------------------------------------------------------------------
// Databricks / Snowflake Command-fallback and misparse readers
// ---------------------------------------------------------------------------

test("Databricks: SET TIME ZONE is a Command fallback, read token-level (not regex)", () => {
  const e = one("SET TIME ZONE 'UTC'", "databricks");
  assert.equal(e.kind, "set");
  assert.equal(e.key, "timezone");
  assert.equal(e.value, "UTC");
});

test("Databricks: bare RESET misparses to a Column — detected by exact shape, routed to reset-all", () => {
  const e = one("RESET", "databricks");
  assert.equal(e.kind, "reset");
  assert.equal(e.key, "all");
});

test("Databricks: a real column literally named reset, used anywhere but as the sole top-level statement, is never affected", () => {
  const e = one("SELECT reset FROM t", "databricks");
  assert.notEqual(e.kind, "reset");
});

test("Databricks: ALTER SESSION SET is Snowflake-only grammar — not recognized under dialect: databricks", () => {
  const e = one("ALTER SESSION SET QUERY_TAG = 'reporting'", "databricks");
  assert.equal(e.kind, "none");
});

test("Snowflake: ALTER SESSION SET / UNSET are real nodes", () => {
  const set = one("ALTER SESSION SET QUERY_TAG = 'reporting'", "snowflake");
  assert.equal(set.kind, "set");
  assert.equal(set.key, "QUERY_TAG");
  assert.equal(set.value, "reporting");

  const unset = one("ALTER SESSION UNSET QUERY_TAG", "snowflake");
  assert.equal(unset.kind, "reset");
  assert.equal(unset.key, "QUERY_TAG");
});

test("Snowflake: USE ROLE/WAREHOUSE/DATABASE/SCHEMA canonicalize database to catalog (no separate catalog concept)", () => {
  assert.deepEqual([one("USE ROLE x", "snowflake").kind, one("USE ROLE x", "snowflake").key], ["role", "role"]);
  assert.equal(one("USE WAREHOUSE wh", "snowflake").key, "warehouse");
  assert.equal(one("USE DATABASE db1", "snowflake").key, "catalog");
  assert.equal(one("USE SCHEMA sch1", "snowflake").key, "schema");
});

test("Databricks: USE DATABASE canonicalizes to schema (legacy synonym, not catalog) — matches gatewaySqlMetadata.js's own verified behavior", () => {
  const e = one("USE DATABASE sales", "databricks");
  assert.equal(e.key, "schema");
  assert.equal(e.value, "sales");
});

// ---------------------------------------------------------------------------
// DISCARD misparse (Postgres-only)
// ---------------------------------------------------------------------------

test("Postgres: DISCARD ALL misparses to an Alias — detected by exact shape, not by keyword", () => {
  const e = one("DISCARD ALL");
  assert.equal(e.kind, "discard");
  assert.equal(e.key, "all");
});

test("Postgres: DISCARD PLANS/SEQUENCES/TEMP are real Postgres statements this module does not track session-state for", () => {
  for (const target of ["PLANS", "SEQUENCES", "TEMP", "TEMPORARY"]) {
    const e = one(`DISCARD ${target}`);
    assert.equal(e.kind, "none", target);
  }
});

// ---------------------------------------------------------------------------
// MySQL / TSQL generic-table coverage
// ---------------------------------------------------------------------------

test("MySQL: SET NAMES / SET GLOBAL / SET @user-variable all classify generically", () => {
  const names = one("SET NAMES utf8mb4", "mysql");
  assert.equal(names.kind, "set");
  assert.equal(names.key, "names");
  assert.equal(names.value, "utf8mb4");

  const global_ = one("SET GLOBAL max_connections = 100", "mysql");
  assert.equal(global_.scope, "global");
  assert.equal(global_.key, "max_connections");

  const userVar = one("SET @x = 1", "mysql");
  assert.equal(userVar.kind, "set");
  assert.equal(userVar.key, "x");
});

test("TSQL: SET NOCOUNT ON parses through the identical generic key/value SetItem shape as any other dialect", () => {
  const e = one("SET NOCOUNT ON", "tsql");
  assert.equal(e.kind, "set");
  assert.equal(e.key, "NOCOUNT");
  assert.equal(e.value, "ON");
  assert.equal(e.affectsResolution, false);
  assert.equal(e.affectsResults, true);
});

// ---------------------------------------------------------------------------
// Empty / malformed input
// ---------------------------------------------------------------------------

test("classify: empty input returns an empty Effect array", () => {
  assert.deepEqual(classify(""), []);
  assert.deepEqual(classify(null), []);
});

test("apply: a kind: none/read/unknown effect never mutates the running state", () => {
  const state = createState("postgres");
  const readEffect = one("SHOW search_path");
  const next = apply(state, readEffect);
  assert.deepEqual(next.variables, state.variables);
  assert.equal(next.searchPath, state.searchPath);
});

// ---------------------------------------------------------------------------
// R123: Effect.statementText is THIS statement's text and Effect.valueRaw keeps
// the source quoting on the natural `Set`-node grammar path too (both were
// already true on the Command-fallback path; found by the gateway's Postgres
// adoption, AIR-2364, which had to work around both with its own tokenizer).
// ---------------------------------------------------------------------------

test("R123 statementText: every statement in a batch reports only its own text, not the whole batch", () => {
  const effects = classify("SET search_path = a; SELECT 1; SET ROLE admin", { dialect: "postgres" });
  assert.deepEqual(
    effects.map((e) => e.statementText),
    ["SET search_path = a", "SELECT 1", "SET ROLE admin"]
  );
  // A `;` inside a string literal is text, not a statement boundary; offsets
  // are code points, so an astral character before the SET does not shift it.
  const [, set] = classify("SELECT '\u{1F600};x'; SET x = 'y'", { dialect: "postgres" });
  assert.equal(set.statementText, "SET x = 'y'");
  assert.equal(set.valueRaw, "'y'");
  assert.equal(set.value, "y");
  // Empty statements are skipped on both sides, so alignment survives `;;`.
  assert.deepEqual(
    classify("SELECT 1;; SET x = 1", { dialect: "postgres" }).map((e) => e.statementText),
    ["SELECT 1", "SET x = 1"]
  );
});

test("R123 valueRaw: a quoted single-value search_path keeps its quotes (the LABEL must tell `= A` from `= \"A\"`)", () => {
  const quoted = classify('SET search_path = "A"', { dialect: "postgres" })[0];
  const bare = classify("SET search_path = A", { dialect: "postgres" })[0];
  assert.equal(quoted.valueRaw, '"A"');
  assert.equal(quoted.value, "A");
  assert.equal(bare.valueRaw, "A");
  assert.notEqual(
    effectiveSearchPath(apply(createState("postgres"), quoted)),
    effectiveSearchPath(apply(createState("postgres"), bare)),
    "two different Postgres schemas must never share a cache-key label"
  );
  assert.equal(effectiveSearchPath(apply(createState("postgres"), quoted)), 'path:"A"');
  assert.equal(classify("SET search_path = 'x'", { dialect: "postgres" })[0].valueRaw, "'x'");
  assert.equal(classify("SET search_path TO x", { dialect: "postgres" })[0].valueRaw, "x");
});

test("R123 valueRaw: the reset sentinel is judged on the DECODED value, so a quoted 'none' still resets", () => {
  const e = classify("SET role = 'none'", { dialect: "postgres" })[0];
  assert.equal(e.kind, "reset");
  assert.equal(e.valueRaw, "'none'");
  assert.equal(e.value, "none");
});

test("R123 valueRaw: a multi-item SET reports only the first item's raw value; parentheses do not end it early", () => {
  assert.equal(classify("SET a = 1, b = 2", { dialect: "postgres" })[0].valueRaw, "1");
  assert.equal(classify("SET search_path = f(a, b), c", { dialect: "postgres" })[0].valueRaw, "f(a, b), c");
});

test("R123 valueRaw: Databricks and Snowflake natural-path values keep their quotes while `value` stays decoded", () => {
  const db = classify("SET spark.sql.x = 'o''brien'", { dialect: "databricks" })[0];
  assert.equal(db.valueRaw, "'o''brien'");
  assert.equal(db.value, "o'brien");
  const sf = classify("ALTER SESSION SET QUERY_TAG = 't'", { dialect: "snowflake" })[0];
  assert.equal(sf.valueRaw, "'t'");
  assert.equal(sf.value, "t");
  // `variables` still stores the decoded value regardless of valueRaw — see
  // the "Databricks raw-text SET replay" group below for where valueRaw ends
  // up (variablesRaw / the replay log / render()'s Databricks-only path).
  let state = createState("databricks");
  state = apply(state, db);
  assert.deepEqual(state.variables, { "spark.sql.x": "o'brien" });
});

// ---------------------------------------------------------------------------
// AIR-2373 finding 1: `search_path` is the Postgres cache-key LABEL only on
// Postgres-family dialects. Before this fix, apply()'s `set`/`variable` and
// `reset` branches checked `effect.key === "search_path"` unconditionally,
// so a Databricks `SET search_path = x` silently vanished into
// `state.searchPath` (a field Databricks never reads) instead of
// `state.variables` — no entry in `variables`, no replay entry, and the
// warehouse's own `search_path` config drifted from the gateway's view of
// it forever. Found by the Databricks gateway adoption, AIR-2364/AIR-2365
// (gateway PR #256): `applySessionStateChange` returned `true` (mutated)
// but stored nothing.
// ---------------------------------------------------------------------------

test("AIR-2373.1: Databricks SET search_path = x is an ordinary variable, not the Postgres LABEL", () => {
  const effect = classify("SET search_path = x", { dialect: "databricks" })[0];
  assert.equal(effect.kind, "set");
  assert.equal(effect.key, "search_path");

  const state = apply(createState("databricks"), effect);
  assert.equal(state.variables.search_path, "x", "must land in variables, not be swallowed");
  assert.deepEqual(
    state.replayLog,
    [{ kind: "set", key: "search_path", value: "x", valueRaw: "x" }],
    "must produce a replay entry so a fresh warehouse session gets SET search_path = x too"
  );
  assert.equal(state.searchPath, "default", "the Postgres-only LABEL field is untouched on Databricks");
});

test("AIR-2373.1: a Databricks RESET of a variable literally named search_path deletes the variable, not the Postgres LABEL", () => {
  let state = apply(createState("databricks"), classify("SET search_path = x", { dialect: "databricks" })[0]);
  assert.equal(state.variables.search_path, "x");
  // Hand-built, since Databricks has no RESET grammar of its own — this
  // exercises apply()'s `reset` branch directly, the other half of the leak.
  const resetEffect = {
    dialect: "databricks", statementText: "", scope: "session", kind: "reset", key: "search_path",
    valueRaw: null, value: null, parts: null,
    affectsResolution: false, affectsResults: true, replayable: true, unknownReason: null,
  };
  state = apply(state, resetEffect);
  assert.equal(state.variables.search_path, undefined, "the variable is gone");
  assert.equal(state.searchPath, "default", "still untouched — it was never the Postgres LABEL to begin with");
});

test("AIR-2373.1: Postgres search_path/role/session_authorization behavior is unchanged by the family gate", () => {
  const state = apply(createState("postgres"), classify("SET search_path = a", { dialect: "postgres" })[0]);
  assert.equal(effectiveSearchPath(state), "path:a");
  assert.deepEqual(state.variables, {}, "the Postgres LABEL path never touches `variables`");

  const resetState = apply(createState("postgres"), classify("RESET search_path", { dialect: "postgres" })[0]);
  assert.equal(resetState.searchPath, "default");

  const roleState = apply(createState("postgres"), classify("RESET ROLE", { dialect: "postgres" })[0]);
  assert.equal(roleState.role, null);
  assert.equal(roleState.roleSwitched, false);
});

// ---------------------------------------------------------------------------
// AIR-2373 finding 2: Databricks (hive/spark2/spark/databricks family) `SET
// k = v` stores the RHS of `=` VERBATIM — Spark's own grammar
// (`SqlBaseParser.g4`'s `SET .*?` -> `SparkSqlParser.visitSetConfiguration`,
// `configKeyValueDef = """([a-zA-Z_\d\\.:]+)\s*=([^;]*);*"""`) has no
// string-literal syntax on this path at all, so quotes the client wrote are
// part of the STORED VALUE, not syntax to decode. render()'s old `set`
// renderer went through the real generator, which emits a quoted string
// Literal (`UTC` -> `'UTC'`) and backtick-quotes a dotted key as a qualified
// column — both wrong for this grammar rule specifically. Found by the
// Databricks gateway adoption (gateway PR #256's `quoteSetValue`/
// `renderReplayStatement`, which deliberately does NOT delegate to this
// module's render() for exactly this reason).
// ---------------------------------------------------------------------------

test("AIR-2373.2: a bare SET value replays byte-identically (no original quoting to lose)", () => {
  const state = apply(createState("databricks"), classify("SET spark.sql.session.timeZone = UTC", { dialect: "databricks" })[0]);
  const [rendered] = render(state, { dialect: "databricks" });
  assert.equal(rendered, "SET spark.sql.session.timeZone = UTC");
});

test("AIR-2373.2: SET x = 'o''brien' replays exactly as written (verbatim valueRaw, not re-escaped)", () => {
  const state = apply(createState("databricks"), classify("SET x = 'o''brien'", { dialect: "databricks" })[0]);
  const [rendered] = render(state, { dialect: "databricks" });
  assert.equal(rendered, "SET x = 'o''brien'");
});

test("AIR-2373.2: a decoded-only entry (no valueRaw) renders exactly like the gateway's own legacy quoteSetValue", () => {
  // Inlines OperationCreatingHandler.quoteSetValue verbatim (airbrx-gateway,
  // AIR-2365 Part 4's own regression oracle) so a future change to either
  // side is caught by a literal text mismatch, not an assumption that they
  // still agree.
  function oldHandRolledSetRender(key, value) {
    const text = value == null ? "" : String(value);
    const needsQuote = /[\s'";]/.test(text) || text === "";
    const quoted = needsQuote ? `'${text.replace(/'/g, "''")}'` : text;
    return `SET ${key} = ${quoted}`;
  }

  const cases = [
    { key: "timezone", value: "EST" }, // bare
    { key: "tag", value: "reporting team" }, // whitespace
    { key: "tag", value: "" }, // empty
    { key: "tag", value: "o'brien" }, // embedded apostrophe
    { key: "tag", value: "a;b" }, // embedded semicolon
    { key: "tag", value: 'a"b' }, // embedded double quote
    { key: "spark.sql.session.timeZone", value: "UTC" }, // dotted key
    { key: "count", value: 5 }, // numeric
    { key: "note", value: null }, // null
  ];

  for (const { key, value } of cases) {
    const state = { ...createState("databricks"), replayLog: [{ kind: "set", key, value }] };
    const [rendered] = render(state, { dialect: "databricks" });
    assert.equal(rendered, oldHandRolledSetRender(key, value), `SET ${key} = ${value}`);
  }
});

test("AIR-2373.2: other dialects still render `set` entries through the real generator — valueRaw only matters for Databricks", () => {
  const state = apply(createState("postgres"), classify("SET note = 'o''brien'", { dialect: "postgres" })[0]);
  const [rendered] = render(state, { dialect: "postgres" });
  // Postgres decodes "''" as a real apostrophe escape (unlike Databricks), so
  // the generator reproduces the same escaping from the decoded value alone.
  assert.equal(rendered, "SET note = 'o''brien'");
});

// ---------------------------------------------------------------------------
// AIR-2373 finding 3: a two-part `USE a.b` carried only a joined
// `"a.b"` string on `Effect.value`/`valueRaw`, so `apply()` had to re-split
// it on "." — mis-splitting a part that itself contains a literal dot (e.g.
// `` USE `a.b`.c ``, a real quoted-identifier-with-dot catalog name).
// `classifyUse` now also reports the already-split `parts`, which `apply()`
// prefers whenever present.
// ---------------------------------------------------------------------------

test("AIR-2373.3: classify() reports structured parts for a two-part USE, not just the joined value", () => {
  const effect = classify("USE main.sales", { dialect: "databricks" })[0];
  assert.deepEqual(effect.parts, { catalog: "main", schema: "sales" });
  assert.equal(effect.value, "main.sales", "value/valueRaw stay joined, for callers that only look at those");
});

test("AIR-2373.3: a catalog name containing a literal dot is never mis-split", () => {
  const effect = classify("USE `a.b`.c", { dialect: "databricks" })[0];
  assert.deepEqual(effect.parts, { catalog: "a.b", schema: "c" });

  const state = apply(createState("databricks"), effect);
  assert.equal(state.catalog, "a.b");
  assert.equal(state.schema, "c");
});

test("AIR-2373.3: a hand-built namespace Effect without `parts` still falls back to splitting value on \".\" — unchanged for existing callers", () => {
  // Exactly the shape airbrx-gateway's Session.js translateChangeToEffect
  // has always built for a `use_namespace` change — it never set `parts`,
  // and must keep working without it.
  const handBuilt = {
    dialect: "databricks", statementText: "", scope: "session", kind: "use", key: "namespace",
    valueRaw: "main.sales", value: "main.sales", parts: null,
    affectsResolution: true, affectsResults: true, replayable: true, unknownReason: null,
  };
  const state = apply(createState("databricks"), handBuilt);
  assert.equal(state.catalog, "main");
  assert.equal(state.schema, "sales");
});
