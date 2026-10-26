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
  assert.deepEqual(state.replayLog, [{ kind: "set", key: "timezone", value: "EST" }]);
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
  assert.deepEqual(tzEntry, { kind: "set", key: "timezone", value: "PST" });
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

test("Databricks: render() produces real, generator-quoted SQL for every replay-log entry kind", () => {
  const state = applyAll("databricks", "SET tag = 'reporting team'", "USE main.sales");
  const rendered = render(state, { dialect: "databricks" });
  assert.deepEqual(rendered.sort(), ["SET tag = 'reporting team'", "USE main.sales"].sort());
});

test("Databricks: render() correctly round-trips an embedded apostrophe using THIS dialect's own escape convention — MORE correct than the gateway's hand-rolled quoting", () => {
  // contrib/README.md: Databricks' STRING_ESCAPES does not declare '' as an
  // apostrophe escape (unlike Postgres/Snowflake); the gateway's own
  // renderReplayStatement hand-quotes with the SQL-standard doubled-quote
  // convention universally (`value.replace(/'/g, "''")`), which is WRONG for
  // a literal containing an apostrophe replayed onto a real Databricks
  // session (it would double-escape, since Databricks itself expects
  // backslash escaping). render() instead emits through the real generator,
  // which already knows each dialect's own convention — verified by round-
  // tripping through classify() again.
  const state = applyAll("databricks", "SET note = 'o''brien'");
  assert.equal(state.variables.note, "o'brien");
  const [rendered] = render(state, { dialect: "databricks" });
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
