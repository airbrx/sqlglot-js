// Tests for the top-level package API (index.js) — docs/api.md and
// docs/getting-started.md's target design, now real. These exercise the public
// surface a consumer would actually import; the deep differential signal for the
// underlying parse/generate machinery lives in spike/, not here.

import test from "node:test";
import assert from "node:assert/strict";
import {
  Dialect,
  ErrorLevel,
  ParseError,
  TokenError,
  UnsupportedError,
  exp,
  parse,
  parseOne,
  tokenize,
  transpile,
} from "../index.js";

test("parseOne parses under a named dialect and returns the tree directly", () => {
  const ast = parseOne("SELECT id, name FROM users WHERE active = TRUE", { read: "snowflake" });
  assert.equal(ast.constructor.name, "Select");
});

test("parseOne accepts `dialect` as an alias for `read`", () => {
  const ast = parseOne("SELECT 1", { dialect: "duckdb" });
  assert.equal(ast.constructor.name, "Select");
});

test("parseOne supports `into` to parse a fragment as a specific node type", () => {
  const col = parseOne("a + 1", { into: exp.Condition });
  assert.ok(col instanceof exp.Expr);
});

test("parseOne throws ParseError when nothing parses", () => {
  assert.throws(() => parseOne(""), ParseError);
});

test("parse returns one tree per semicolon-separated statement, in order", () => {
  const [first, second] = parse("SELECT 1; SELECT 2;");
  assert.equal(first.constructor.name, "Select");
  assert.equal(second.constructor.name, "Select");
  assert.equal(first.sql(), "SELECT 1");
  assert.equal(second.sql(), "SELECT 2");
});

test("parse returns null (not a throw) for a genuinely empty statement under errorLevel IGNORE", () => {
  const result = parse("SELECT 1;;SELECT 2", { read: "snowflake", errorLevel: ErrorLevel.IGNORE });
  assert.deepEqual(
    result.map((r) => r && r.constructor.name),
    ["Select", null, "Select"],
  );
});

test("parse defaults to the base dialect when read/dialect are omitted", () => {
  const [ast] = parse("SELECT 1");
  assert.equal(ast.constructor.name, "Select");
});

test("transpile round-trips identity-style when only `read` is given", () => {
  const [sql] = transpile("SELECT 1", { read: "postgres" });
  assert.equal(sql, "SELECT 1");
});

test("transpile renders a real cross-dialect identifier-quoting difference", () => {
  const [sql] = transpile("SELECT `id` FROM t", { read: "databricks", write: "postgres" });
  assert.equal(sql, 'SELECT "id" FROM t');
});

test("transpile returns one string per statement, empty string for a null slot", () => {
  const result = transpile("SELECT 1;;SELECT 2", { read: "snowflake", errorLevel: ErrorLevel.IGNORE });
  assert.deepEqual(result, ["SELECT 1", "", "SELECT 2"]);
});

test("tokenize returns the raw token stream without building a tree", () => {
  const tokens = tokenize("SELECT 1", { read: "snowflake" });
  assert.ok(tokens.length > 0);
  assert.equal(tokens[0].text, "SELECT");
  assert.equal(typeof tokens[0].token_type, "number");
});

test("tokenize accepts `dialect` as an alias for `read`", () => {
  const tokens = tokenize("SELECT 1", { dialect: "duckdb" });
  assert.ok(tokens.length > 0);
});

test("exp namespace and builders are re-exported and generate real SQL", () => {
  const query = exp.select("id", "name").from_("users").where(exp.column("active").eq(true));
  assert.equal(query.sql(), "SELECT id, name FROM users WHERE active = TRUE");
});

test("Dialect is re-exported and resolves the same registry parse/transpile use", () => {
  const [ast] = Dialect.get_or_raise("snowflake").parse("SELECT 1");
  assert.equal(ast.constructor.name, "Select");
});

test("Dialect.get_or_raise throws a clear error for an unregistered dialect name", () => {
  assert.throws(() => Dialect.get_or_raise("bigquery"), /Unknown dialect/);
});

test("error classes are re-exported and structured", () => {
  try {
    parseOne("SELECT FROM");
    assert.fail("expected parseOne to throw");
  } catch (e) {
    assert.ok(e instanceof ParseError);
    assert.ok(Array.isArray(e.errors));
    assert.ok(e.errors.length > 0);
  }

  assert.equal(typeof TokenError, "function");
  assert.equal(typeof UnsupportedError, "function");
  assert.deepEqual(Object.keys(ErrorLevel).sort(), ["IGNORE", "IMMEDIATE", "RAISE", "WARN"]);
});
