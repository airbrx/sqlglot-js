// Tests for contrib/gatewaySqlMetadata.js.
//
// Translates a representative sample of airbrx-gateway's own SqlParser test
// suites (test/sql-parser-parameters.test.js, test/sql-parser-non-deterministic.test.js,
// test/session-state-replay.test.js — fetched 2026-09-11) into this project's
// `node --test` style. Where our AST-based result legitimately differs from
// the regex-based gateway parser, the test asserts our ACTUAL, AST-verified
// behavior and explains why in a comment, rather than forcing a fragile match.

import test from "node:test";
import assert from "node:assert/strict";
import { extractSqlMetadata } from "../contrib/gatewaySqlMetadata.js";

// ---------------------------------------------------------------------------
// Parameters — translated from sql-parser-parameters.test.js
// ---------------------------------------------------------------------------

test("parameters: detects named parameters with :name syntax", () => {
  const r = extractSqlMetadata("SELECT * FROM orders WHERE customer_id = :customer_id", { dialect: "databricks" });
  assert.equal(r.hasParameters, true);
  assert.equal(r.parameterStyle, "named");
  assert.deepEqual(r.parameterNames, ["customer_id"]);
});

test("parameters: detects multiple named parameters in encounter order", () => {
  const r = extractSqlMetadata("SELECT * FROM orders WHERE customer_id = :cust AND status = :status", {
    dialect: "databricks",
  });
  assert.equal(r.hasParameters, true);
  assert.equal(r.parameterStyle, "named");
  assert.deepEqual(r.parameterNames, ["cust", "status"]);
});

test("parameters: Databricks positional-looking named parameters :p0, :p1 are still 'named'", () => {
  const r = extractSqlMetadata("SELECT * FROM orders WHERE customer_id = :p0 AND amount > :p1", {
    dialect: "databricks",
  });
  assert.equal(r.hasParameters, true);
  assert.equal(r.parameterStyle, "named");
  assert.deepEqual(r.parameterNames, ["p0", "p1"]);
});

test("parameters: deduplicates repeated named parameters", () => {
  const r = extractSqlMetadata("SELECT * FROM orders WHERE start_date >= :date AND end_date <= :date", {
    dialect: "databricks",
  });
  assert.equal(r.hasParameters, true);
  assert.deepEqual(r.parameterNames, ["date"]);
});

test("parameters: detects positional parameters with ? syntax", () => {
  const r = extractSqlMetadata("SELECT * FROM orders WHERE customer_id = ?", { dialect: "postgres" });
  assert.equal(r.hasParameters, true);
  assert.equal(r.parameterStyle, "positional");
  assert.deepEqual(r.parameterNames, ["p0"]);
});

test("parameters: detects multiple positional parameters, synthetic p0..pN-1", () => {
  const r = extractSqlMetadata("SELECT * FROM orders WHERE customer_id = ? AND status = ? AND amount > ?", {
    dialect: "postgres",
  });
  assert.equal(r.hasParameters, true);
  assert.equal(r.parameterStyle, "positional");
  assert.deepEqual(r.parameterNames, ["p0", "p1", "p2"]);
});

test("parameters: detects numbered parameters with $N syntax", () => {
  const r = extractSqlMetadata("SELECT * FROM orders WHERE customer_id = $1", { dialect: "postgres" });
  assert.equal(r.hasParameters, true);
  assert.equal(r.parameterStyle, "numbered");
  assert.deepEqual(r.parameterNames, ["$1"]);
});

test("parameters: detects multiple numbered parameters", () => {
  const r = extractSqlMetadata("SELECT * FROM orders WHERE customer_id = $1 AND status = $2", { dialect: "postgres" });
  assert.equal(r.hasParameters, true);
  assert.equal(r.parameterStyle, "numbered");
  assert.deepEqual(r.parameterNames, ["$1", "$2"]);
});

test("parameters: hasParameters is false when no parameters present", () => {
  const r = extractSqlMetadata("SELECT * FROM orders WHERE customer_id = 'ABC123'", { dialect: "databricks" });
  assert.equal(r.hasParameters, false);
  assert.equal(r.parameterStyle, null);
  assert.deepEqual(r.parameterNames, []);
});

test("parameters: a real parser never mistakes string-literal text for a placeholder (single quotes)", () => {
  // The gateway regex needs a dedicated _stripStringLiterals pass for this.
  // A real tokenizer needs nothing extra: ':customer_id' inside a string
  // literal is just string content — it was never a Placeholder token.
  const r = extractSqlMetadata("SELECT * FROM orders WHERE note = 'Use :customer_id here'", { dialect: "databricks" });
  assert.equal(r.hasParameters, false);
});

test("parameters: a real parser never mistakes string-literal text for a placeholder (double-quoted identifier)", () => {
  const r = extractSqlMetadata('SELECT * FROM orders WHERE note = ":customer_id"', { dialect: "databricks" });
  assert.equal(r.hasParameters, false);
});

test("parameters: detects a real parameter outside a string while ignoring a look-alike inside one", () => {
  const r = extractSqlMetadata("SELECT * FROM orders WHERE customer_id = :cust AND note = 'Use :fake here'", {
    dialect: "databricks",
  });
  assert.equal(r.hasParameters, true);
  assert.deepEqual(r.parameterNames, ["cust"]);
});

test("parameters: parameterValues passed through when parameters are detected", () => {
  const r = extractSqlMetadata("SELECT * FROM orders WHERE customer_id = :cust", {
    dialect: "databricks",
    parameterValues: { cust: "VIP123" },
  });
  assert.equal(r.hasParameters, true);
  assert.deepEqual(r.parameterValues, { cust: "VIP123" });
});

test("parameters: parameterValues ignored (nulled) when no parameters in SQL", () => {
  const r = extractSqlMetadata("SELECT * FROM orders WHERE customer_id = 'ABC123'", {
    dialect: "databricks",
    parameterValues: { cust: "VIP123" },
  });
  assert.equal(r.hasParameters, false);
  assert.equal(r.parameterValues, null);
});

test("parameters: handles missing parameterValues option", () => {
  const r = extractSqlMetadata("SELECT * FROM orders WHERE customer_id = :cust", { dialect: "databricks" });
  assert.equal(r.hasParameters, true);
  assert.equal(r.parameterValues, null);
});

test("parameters: empty/null sql includes parameter fields with safe defaults", () => {
  const r = extractSqlMetadata(null, { dialect: "databricks" });
  assert.equal(r.hasParameters, false);
  assert.deepEqual(r.parameterNames, []);
  assert.equal(r.parameterStyle, null);
  assert.equal(r.parameterValues, null);
});

// ---------------------------------------------------------------------------
// Non-deterministic functions — translated from sql-parser-non-deterministic.test.js
// ---------------------------------------------------------------------------

test("non-deterministic: detects bare CURRENT_DATE (Databricks style, no parens)", () => {
  const r = extractSqlMetadata("SELECT * FROM orders WHERE order_date = CURRENT_DATE", { dialect: "databricks" });
  assert.equal(r.nonDeterministic.hasNonDeterministicFunctions, true);
  assert.deepEqual(r.nonDeterministic.types, ["date"]);
  // Deviation: the AST does not distinguish `CURRENT_DATE` from
  // `CURRENT_DATE()` — both parse to an identical CurrentDate node with no
  // paren-presence marker (verified: `new CurrentDate()` round-trips the
  // same either way). We report one fixed canonical spelling always,
  // instead of preserving whichever form appeared in the source. See
  // contrib/README.md "Non-deterministic function detection".
  assert.deepEqual(r.nonDeterministic.functions, ["CURRENT_DATE"]);
});

test("non-deterministic: detects CURRENT_DATE() (Snowflake style, with parens) — same canonical spelling", () => {
  const r = extractSqlMetadata("SELECT * FROM orders WHERE order_date = CURRENT_DATE()", { dialect: "snowflake" });
  assert.equal(r.nonDeterministic.hasNonDeterministicFunctions, true);
  assert.deepEqual(r.nonDeterministic.types, ["date"]);
  assert.deepEqual(r.nonDeterministic.functions, ["CURRENT_DATE"]);
});

test("non-deterministic: detects CURDATE() and TODAY() as date functions (Anonymous-name fallback)", () => {
  // Snowflake has no built-in CURDATE/TODAY, so these parse as ordinary
  // (real, non-string-literal) function calls — exp.Anonymous — rather than
  // a typed class. Matching by call name off Anonymous still carries none of
  // the false-positive risk a raw-text regex would, since real parsing has
  // already ruled out a string-literal look-alike by construction.
  const r1 = extractSqlMetadata("SELECT CURDATE()", { dialect: "snowflake" });
  assert.deepEqual(r1.nonDeterministic.types, ["date"]);
  assert.deepEqual(r1.nonDeterministic.functions, ["CURDATE()"]);

  const r2 = extractSqlMetadata("SELECT TODAY()", { dialect: "snowflake" });
  assert.deepEqual(r2.nonDeterministic.types, ["date"]);
  assert.deepEqual(r2.nonDeterministic.functions, ["TODAY()"]);
});

test("non-deterministic: detects NOW(), CURRENT_TIMESTAMP, GETDATE(), SYSDATE() as time functions", () => {
  assert.deepEqual(
    extractSqlMetadata("SELECT NOW()", { dialect: "databricks" }).nonDeterministic.types,
    ["time"],
  );
  assert.deepEqual(
    extractSqlMetadata("SELECT CURRENT_TIMESTAMP", { dialect: "databricks" }).nonDeterministic.types,
    ["time"],
  );
  assert.deepEqual(
    extractSqlMetadata("SELECT CURRENT_TIMESTAMP()", { dialect: "databricks" }).nonDeterministic.types,
    ["time"],
  );
  assert.deepEqual(
    extractSqlMetadata("SELECT GETDATE()", { dialect: "databricks" }).nonDeterministic.types,
    ["time"],
  );
  // Deviation: a BARE `SYSDATE` (no parens) is not a keyword in any of the
  // three target dialects' real grammar — verified directly against pinned
  // CPython sqlglot, not just this port (only `SYSDATE()` with parens is
  // recognized, by Snowflake). Real Databricks/Snowflake/Postgres SQL treats
  // bare `SYSDATE` as an ordinary column reference. We do not special-case
  // it, since a heuristic "SYSDATE-the-bare-identifier" match would flag a
  // real column literally named `sysdate` as non-deterministic. See
  // contrib/README.md.
  assert.deepEqual(
    extractSqlMetadata("SELECT SYSDATE", { dialect: "databricks" }).nonDeterministic.types,
    [],
  );
  assert.deepEqual(
    extractSqlMetadata("SELECT SYSDATE()", { dialect: "databricks" }).nonDeterministic.types,
    ["time"],
  );
});

test("non-deterministic: detects CURRENT_USER, CURRENT_ROLE(), SESSION_USER as user functions", () => {
  assert.deepEqual(
    extractSqlMetadata("SELECT CURRENT_USER", { dialect: "databricks" }).nonDeterministic.types,
    ["user"],
  );
  assert.deepEqual(
    extractSqlMetadata("SELECT CURRENT_ROLE()", { dialect: "databricks" }).nonDeterministic.types,
    ["user"],
  );
  assert.deepEqual(
    extractSqlMetadata("SELECT SESSION_USER", { dialect: "databricks" }).nonDeterministic.types,
    ["user"],
  );
});

test("non-deterministic: bare CURRENT_ROLE / SESSION_USER are dialect-specific keywords, verified per-dialect", () => {
  // CURRENT_ROLE (bare, no parens) is not wired as a keyword by this port's
  // tokenizer for any of the three target dialects yet — it reads back as a
  // plain Column, same shape (and same non-heuristic reasoning) as bare
  // SYSDATE above.
  assert.deepEqual(
    extractSqlMetadata("SELECT CURRENT_ROLE", { dialect: "databricks" }).nonDeterministic.types,
    [],
  );
  // SESSION_USER (bare) IS recognized by Databricks and Postgres (both
  // inherit/declare it as a NO_PAREN_FUNCTIONS keyword) but NOT by Snowflake
  // (verified: Snowflake's real parser has no SESSION_USER mapping at all,
  // matching upstream CPython sqlglot) — it reads back as a plain Column.
  assert.deepEqual(
    extractSqlMetadata("SELECT SESSION_USER", { dialect: "postgres" }).nonDeterministic.types,
    ["user"],
  );
  assert.deepEqual(
    extractSqlMetadata("SELECT SESSION_USER", { dialect: "snowflake" }).nonDeterministic.types,
    [],
  );
});

test("non-deterministic: detects multiple non-deterministic types in one query", () => {
  const r = extractSqlMetadata(
    "SELECT * FROM orders WHERE order_date = CURRENT_DATE AND created_by = CURRENT_USER AND updated_at > NOW()",
    { dialect: "databricks" },
  );
  assert.equal(r.nonDeterministic.hasNonDeterministicFunctions, true);
  assert.deepEqual([...r.nonDeterministic.types].sort(), ["date", "time", "user"]);
  assert.deepEqual([...r.nonDeterministic.functions].sort(), ["CURRENT_DATE", "CURRENT_TIMESTAMP", "CURRENT_USER"]);
  // Deviation from the gateway's expected ['CURRENT_DATE','CURRENT_USER','NOW()']:
  // NOW() is dialect-typed to the same CurrentTimestamp class as
  // CURRENT_TIMESTAMP under Databricks (verified: `NOW` is in Databricks'
  // FUNCTIONS map as `exp.CurrentTimestamp.from_arg_list`), so it reports
  // under the canonical CURRENT_TIMESTAMP spelling rather than preserving
  // the NOW() alias — see the CURRENT_DATE canonicalization note above.
});

test("non-deterministic: the inner CURRENT_DATE() of a wrapping function call is still found", () => {
  // DATEADD itself isn't a typed class this port models, but the walk finds
  // CurrentDate wherever it is nested, regardless of the wrapping call.
  const r = extractSqlMetadata("SELECT DATEADD(DAY, -7, CURRENT_DATE())", { dialect: "databricks" });
  assert.equal(r.nonDeterministic.hasNonDeterministicFunctions, true);
  assert.deepEqual(r.nonDeterministic.types, ["date"]);
});

test("non-deterministic: is case-insensitive", () => {
  const r = extractSqlMetadata("select * from orders where d = current_date", { dialect: "databricks" });
  assert.equal(r.nonDeterministic.hasNonDeterministicFunctions, true);
  assert.deepEqual(r.nonDeterministic.functions, ["CURRENT_DATE"]);
});

test("non-deterministic: does not flag a plain deterministic query", () => {
  const r = extractSqlMetadata("SELECT * FROM orders WHERE created_at > '2025-01-01'", { dialect: "databricks" });
  assert.deepEqual(r.nonDeterministic, { hasNonDeterministicFunctions: false, types: [], functions: [] });
});

test("non-deterministic: a function name that only appears inside a string literal is never matched", () => {
  const r = extractSqlMetadata("SELECT * FROM orders WHERE status = 'now'", { dialect: "databricks" });
  assert.equal(r.nonDeterministic.hasNonDeterministicFunctions, false);
});

test("non-deterministic: a column merely named similarly is never matched (real tokenization, not word-boundary regex)", () => {
  const r = extractSqlMetadata("SELECT current_date_backup FROM audit_log", { dialect: "databricks" });
  assert.equal(r.nonDeterministic.hasNonDeterministicFunctions, false);
});

test("non-deterministic: empty/null sql includes the nonDeterministic field with safe defaults", () => {
  const r = extractSqlMetadata("", { dialect: "databricks" });
  assert.deepEqual(r.nonDeterministic, { hasNonDeterministicFunctions: false, types: [], functions: [] });
});

// ---------------------------------------------------------------------------
// Session state (SET / USE / ALTER SESSION) — translated from session-state-replay.test.js
// ---------------------------------------------------------------------------

test("session state: extracts SET key = value, quoted value unquoted", () => {
  const r = extractSqlMetadata("SET timezone = 'America/New_York'", { dialect: "databricks" });
  assert.equal(r.isSessionStateChange, true);
  assert.deepEqual(r.sessionStateChange, { kind: "set", key: "timezone", value: "America/New_York" });
});

test("session state: extracts SET spark.sql.session.timeZone (dotted key)", () => {
  const r = extractSqlMetadata("SET spark.sql.session.timeZone = 'UTC'", { dialect: "databricks" });
  assert.deepEqual(r.sessionStateChange, { kind: "set", key: "spark.sql.session.timeZone", value: "UTC" });
});

test("session state: SET key value (no equals) is a permanent Command fallback in this port, handled from its raw text", () => {
  // Deviation: `SET timezone UTC` (Databricks-allowed space-separated form)
  // does not produce a real `Set` AST node in this port — verified against
  // pinned CPython sqlglot too, so this is an upstream grammar gap, not a
  // JS-port bug: only `SET key = value` and bare `SET` produce a real `Set`
  // node; `SET key value` and `SET key` (read-one) fall back to a generic
  // `Command`. We extract from the Command's own captured raw remainder
  // text — narrowly scoped to that node, never the full SQL string — same
  // technique as the OPTIMIZE/VACUUM Delta-op handling. See
  // contrib/README.md "SET fallback forms".
  const r = extractSqlMetadata("SET timezone UTC", { dialect: "databricks" });
  assert.equal(r.sessionStateChange?.kind, "set");
  assert.equal(r.sessionStateChange?.key, "timezone");
  assert.equal(r.sessionStateChange?.value, "UTC");
});

test("session state: extracts ALTER SESSION SET QUERY_TAG", () => {
  const r = extractSqlMetadata("ALTER SESSION SET QUERY_TAG = 'reporting'", { dialect: "snowflake" });
  assert.deepEqual(r.sessionStateChange, { kind: "alter_session", key: "QUERY_TAG", value: "reporting" });
});

test("session state: extracts all four USE variants", () => {
  const d = { dialect: "databricks" };
  assert.deepEqual(extractSqlMetadata("USE CATALOG main", d).sessionStateChange, {
    kind: "use_catalog",
    catalog: "main",
  });
  assert.deepEqual(extractSqlMetadata("USE SCHEMA sales", d).sessionStateChange, {
    kind: "use_schema",
    schema: "sales",
  });
  assert.deepEqual(extractSqlMetadata("USE DATABASE sales", d).sessionStateChange, {
    kind: "use_schema",
    schema: "sales",
  });
  assert.deepEqual(extractSqlMetadata("USE main.sales", d).sessionStateChange, {
    kind: "use_namespace",
    catalog: "main",
    schema: "sales",
  });
  assert.deepEqual(extractSqlMetadata("USE sales", d).sessionStateChange, {
    kind: "use_schema",
    schema: "sales",
  });
});

test("session state: tolerates mixed-case keywords, preserves key case", () => {
  const r = extractSqlMetadata("set Timezone = 'X'", { dialect: "databricks" });
  assert.equal(r.sessionStateChange?.key, "Timezone");
  assert.equal(r.sessionStateChange?.value, "X");
});

test("session state: sessionStateChange is null for non-session-state statements", () => {
  const r = extractSqlMetadata("SELECT 1", { dialect: "databricks" });
  assert.equal(r.isSessionStateChange, false);
  assert.equal(r.sessionStateChange, null);
});

test("session state: read-style SET / SET key yield sessionStateChange={kind:'read'}", () => {
  const listAll = extractSqlMetadata("SET", { dialect: "databricks" });
  assert.equal(listAll.isSessionStateChange, true);
  assert.deepEqual(listAll.sessionStateChange, { kind: "read" });

  // `SET timezone` (read-one) is also a Command fallback — see the
  // "SET key value" deviation note above.
  const readOne = extractSqlMetadata("SET timezone", { dialect: "databricks" });
  assert.equal(readOne.isSessionStateChange, true);
  assert.deepEqual(readOne.sessionStateChange, { kind: "read", key: "timezone" });
});

test("session state: SET tag = 'o''brien' round-trips with one apostrophe on Snowflake/Postgres", () => {
  for (const dialect of ["snowflake", "postgres"]) {
    const r = extractSqlMetadata("SET tag = 'o''brien'", { dialect });
    assert.equal(r.sessionStateChange?.kind, "set");
    assert.equal(r.sessionStateChange?.key, "tag");
    assert.equal(r.sessionStateChange?.value, "o'brien", `dialect=${dialect}`);
  }
});

test("session state: SET tag = 'o''brien' also round-trips on Databricks, via Concat-artifact reconstruction", () => {
  // Deviation, verified against pinned CPython sqlglot (not a JS-port bug):
  // Databricks/Spark-family STRING_ESCAPES config does not declare `''` as
  // an apostrophe escape, so `'o''brien'` tokenizes as two adjacent string
  // literals ('o', 'brien') that the parser folds into a Concat node rather
  // than a single decoded Literal. We special-case a Concat-of-only-Literal
  // value by rejoining its parts with `'`, which recovers the intended
  // value. See contrib/README.md.
  const r = extractSqlMetadata("SET tag = 'o''brien'", { dialect: "databricks" });
  assert.deepEqual(r.sessionStateChange, { kind: "set", key: "tag", value: "o'brien" });
});

test("session state: USE/SET statements never appear in tables[] even though USE's target is structurally an exp.Table", () => {
  const r = extractSqlMetadata("USE main.sales", { dialect: "databricks" });
  assert.deepEqual(r.tables, []);
  assert.equal(r.tableCount, 0);
});

// ---------------------------------------------------------------------------
// Table extraction — structural (findAll(exp.Table)), not per-statement regex
// ---------------------------------------------------------------------------

test("tables: extracts catalog.schema.table with alias", () => {
  const r = extractSqlMetadata("SELECT * FROM main.sales.orders o", { dialect: "databricks" });
  assert.deepEqual(r.tables, [
    { catalog: "main", schema: "sales", table: "orders", fullyQualifiedName: "main.sales.orders", operation: "SELECT" },
  ]);
  assert.equal(r.isFullyQualified, true);
  assert.deepEqual(r.catalogs, ["main"]);
  assert.deepEqual(r.schemas, ["sales"]);
});

test("tables: a CTE name is excluded from tables[], a same-clause real table is kept", () => {
  const r = extractSqlMetadata("WITH cte AS (SELECT 1 AS x) SELECT * FROM cte JOIN real_table ON 1=1", {
    dialect: "databricks",
  });
  assert.deepEqual(
    r.tables.map((t) => t.table),
    ["real_table"],
  );
});

test("tables: INSERT tags the target INSERT and any SELECT source separately", () => {
  const r = extractSqlMetadata("INSERT INTO t1 SELECT * FROM t2", { dialect: "databricks" });
  assert.deepEqual(r.tables, [
    { catalog: null, schema: null, table: "t1", fullyQualifiedName: "t1", operation: "INSERT" },
    { catalog: null, schema: null, table: "t2", fullyQualifiedName: "t2", operation: "SELECT" },
  ]);
});

test("tables: UPDATE tags the target UPDATE and a subquery source SELECT", () => {
  const r = extractSqlMetadata("UPDATE t1 SET x = 1 WHERE y IN (SELECT y FROM t2)", { dialect: "databricks" });
  assert.deepEqual(
    r.tables.map((t) => [t.table, t.operation]),
    [
      ["t1", "UPDATE"],
      ["t2", "SELECT"],
    ],
  );
});

test("tables: DELETE tags the target DELETE", () => {
  const r = extractSqlMetadata("DELETE FROM t1 WHERE x = 1", { dialect: "databricks" });
  assert.deepEqual(r.tables, [{ catalog: null, schema: null, table: "t1", fullyQualifiedName: "t1", operation: "DELETE" }]);
});

test("tables: MERGE tags MERGE_TARGET and MERGE_SOURCE", () => {
  const r = extractSqlMetadata("MERGE INTO t1 USING t2 ON t1.id = t2.id WHEN MATCHED THEN UPDATE SET x = 1", {
    dialect: "databricks",
  });
  assert.deepEqual(
    r.tables.map((t) => [t.table, t.operation]),
    [
      ["t1", "MERGE_TARGET"],
      ["t2", "MERGE_SOURCE"],
    ],
  );
});

test("tables: DROP tags every dropped table DROP", () => {
  const r = extractSqlMetadata("DROP TABLE t1, t2", { dialect: "databricks" });
  assert.deepEqual(
    r.tables.map((t) => [t.table, t.operation]),
    [
      ["t1", "DROP"],
      ["t2", "DROP"],
    ],
  );
});

test("tables: TRUNCATE tags TRUNCATE", () => {
  const r = extractSqlMetadata("TRUNCATE TABLE t1", { dialect: "databricks" });
  assert.deepEqual(r.tables, [{ catalog: null, schema: null, table: "t1", fullyQualifiedName: "t1", operation: "TRUNCATE" }]);
});

test("tables: ALTER TABLE tags ALTER", () => {
  const r = extractSqlMetadata("ALTER TABLE t1 ADD COLUMN y INT", { dialect: "databricks" });
  assert.deepEqual(r.tables, [{ catalog: null, schema: null, table: "t1", fullyQualifiedName: "t1", operation: "ALTER" }]);
});

test("tables: CREATE TABLE AS SELECT also captures the source table — an improvement over the gateway regex", () => {
  // Deviation: the gateway's `_extractFromDDL` only ever matches ONE table
  // via a single regex on the DDL keyword — it never scans a CREATE ... AS
  // SELECT for the source table(s). A real AST finds both naturally, which
  // is strictly more useful for cache-invalidation (the read table matters
  // for that decision too). See contrib/README.md.
  const r = extractSqlMetadata("CREATE TABLE t1 AS SELECT * FROM t2", { dialect: "databricks" });
  assert.deepEqual(
    r.tables.map((t) => [t.table, t.operation]),
    [
      ["t1", "CREATE"],
      ["t2", "SELECT"],
    ],
  );
});

test("tables: isFullyQualified is false unless EVERY table has both catalog and schema", () => {
  const r = extractSqlMetadata("SELECT * FROM main.sales.orders JOIN t2 ON 1=1", { dialect: "databricks" });
  assert.equal(r.isFullyQualified, false);
});

test("tables: isFullyQualified is false with no tables at all (matches gateway's 'include session state to be safe')", () => {
  const r = extractSqlMetadata("SELECT 1", { dialect: "databricks" });
  assert.deepEqual(r.tables, []);
  assert.equal(r.isFullyQualified, false);
});

// ---------------------------------------------------------------------------
// Delta-specific commands (OPTIMIZE/VACUUM) — verified Command fallback
// ---------------------------------------------------------------------------

test("delta ops: OPTIMIZE falls back to Command in this port; table extracted from its raw text", () => {
  // OPTIMIZE/VACUUM are Databricks Delta-specific syntax this port's real
  // grammar does not model as a structured statement class — verified,
  // upstream's own designed fallback (`Command`), not a JS-port bug. Table
  // name is pulled with a regex scoped ONLY to the Command node's own
  // captured remainder text.
  const r = extractSqlMetadata("OPTIMIZE main.sales.orders", { dialect: "databricks" });
  assert.equal(r.statementType, "OPTIMIZE");
  assert.equal(r.isDeltaOperation, true);
  assert.equal(r.isDDL, true);
  assert.deepEqual(r.tables, [
    { catalog: "main", schema: "sales", table: "orders", fullyQualifiedName: "main.sales.orders", operation: "OPTIMIZE" },
  ]);
});

test("delta ops: VACUUM falls back to Command in this port; table extracted from its raw text", () => {
  const r = extractSqlMetadata("VACUUM t1", { dialect: "databricks" });
  assert.equal(r.statementType, "VACUUM");
  assert.equal(r.isDeltaOperation, true);
  assert.deepEqual(r.tables, [{ catalog: null, schema: null, table: "t1", fullyQualifiedName: "t1", operation: "VACUUM" }]);
});

test("delta ops: OPTIMIZE with a backtick-quoted target still extracts the table (regression: the raw-text regex's first-char class used to exclude the opening backtick, silently returning tables: [])", () => {
  const r = extractSqlMetadata("OPTIMIZE `main`.`sales`.`orders`", { dialect: "databricks" });
  assert.deepEqual(r.tables, [
    { catalog: "main", schema: "sales", table: "orders", fullyQualifiedName: "main.sales.orders", operation: "OPTIMIZE" },
  ]);
});

test("delta ops: OPTIMIZE with a double-quoted target still extracts the table", () => {
  const r = extractSqlMetadata('OPTIMIZE "main"."sales"."orders"', { dialect: "databricks" });
  assert.deepEqual(r.tables, [
    { catalog: "main", schema: "sales", table: "orders", fullyQualifiedName: "main.sales.orders", operation: "OPTIMIZE" },
  ]);
});

test("delta ops: VACUUM with a backtick-quoted target still extracts the table", () => {
  const r = extractSqlMetadata("VACUUM `t1`", { dialect: "databricks" });
  assert.deepEqual(r.tables, [{ catalog: null, schema: null, table: "t1", fullyQualifiedName: "t1", operation: "VACUUM" }]);
});

test("delta ops: a plain MERGE is classified isDeltaOperation, matching the gateway's own list", () => {
  const r = extractSqlMetadata("MERGE INTO t1 USING t2 ON t1.id = t2.id WHEN MATCHED THEN UPDATE SET x = 1", {
    dialect: "databricks",
  });
  assert.equal(r.isDeltaOperation, true);
});

// ---------------------------------------------------------------------------
// Error tolerance — the module's most important property
// ---------------------------------------------------------------------------

test("error tolerance: RESTORE TABLE ... TO VERSION AS OF ... throws a real ParseError, caught into a safe default", () => {
  // Verified: this construct is a hard `ParseError` in this port, unlike the
  // gateway's regex parser, which never throws. This is exactly the shape
  // the error-tolerant wrapper exists for.
  const r = extractSqlMetadata("RESTORE TABLE t TO VERSION AS OF 5", { dialect: "databricks" });
  assert.equal(r.statementType, "UNKNOWN");
  assert.equal(r.isReadOnly, false);
  assert.equal(r.isDataChange, true, "errs toward non-cacheable");
  assert.equal(r.isDDL, true, "errs toward non-cacheable");
  assert.deepEqual(r.tables, []);
  assert.ok(typeof r.extractionError === "string" && r.extractionError.length > 0);
  assert.ok(!r.extractionError.includes(String.fromCharCode(27)), "ANSI escape codes are stripped from the error message");
});

test("error tolerance: garbage input never throws — degrades to a safe default with extractionError set", () => {
  assert.doesNotThrow(() => extractSqlMetadata("garbled ((( sql", { dialect: "databricks" }));
  const r = extractSqlMetadata("garbled ((( sql", { dialect: "databricks" });
  assert.equal(r.statementType, "UNKNOWN");
  assert.equal(r.isDataChange, true);
  assert.equal(r.isDDL, true);
  assert.ok(r.extractionError);
});

test("error tolerance: an omitted dialect falls back to the base Dialect (matches Dialect.get_or_raise(null)), no error", () => {
  const r = extractSqlMetadata("SELECT 1", {});
  assert.equal(r.extractionError, null);
  assert.equal(r.statementType, "SELECT");
});

test("error tolerance: an unrecognized dialect NAME throws — never propagates, degrades to a safe default", () => {
  assert.doesNotThrow(() => extractSqlMetadata("SELECT 1", { dialect: "made_up_dialect_xyz" }));
  const r = extractSqlMetadata("SELECT 1", { dialect: "made_up_dialect_xyz" });
  assert.ok(r.extractionError);
  assert.equal(r.isDataChange, true);
});

test("error tolerance: empty result for null/empty/non-string sql, no extractionError (not a failure)", () => {
  for (const sql of [null, undefined, "", 42]) {
    const r = extractSqlMetadata(sql, { dialect: "databricks" });
    assert.equal(r.statementType, "UNKNOWN");
    assert.equal(r.extractionError, null);
    assert.deepEqual(r.tables, []);
  }
});

// ---------------------------------------------------------------------------
// Cache override magic comments
// ---------------------------------------------------------------------------

test("cache override: __AIRBRX_NOCACHE__ in a leading comment", () => {
  const r = extractSqlMetadata("-- __AIRBRX_NOCACHE__\nSELECT 1", { dialect: "databricks" });
  assert.equal(r.cacheOverride, "nocache");
});

test("cache override: __AIRBRX_CACHE__ is case-insensitive", () => {
  const r = extractSqlMetadata("-- __airbrx_cache__\nSELECT 1", { dialect: "databricks" });
  assert.equal(r.cacheOverride, "cache");
});

test("cache override: absent when no magic comment present", () => {
  const r = extractSqlMetadata("SELECT 1", { dialect: "databricks" });
  assert.equal(r.cacheOverride, null);
});

test("cache override: still detected even when the statement fails to parse", () => {
  // Scanned over the raw SQL text before parsing is attempted — matches the
  // gateway's own ordering ("Check for cache override hint before
  // normalization") — so it survives a ParseError, unlike every other field.
  const r = extractSqlMetadata("-- __AIRBRX_NOCACHE__\nRESTORE TABLE t TO VERSION AS OF 5", { dialect: "databricks" });
  assert.equal(r.cacheOverride, "nocache");
  assert.ok(r.extractionError);
});

// ---------------------------------------------------------------------------
// standardizedSql — real AST regeneration
// ---------------------------------------------------------------------------

test("standardizedSql: whitespace-collapsing, keyword-normalizing regeneration for a plain SELECT", () => {
  const r = extractSqlMetadata("select   *   from orders o join customers c on o.cust_id = c.id", {
    dialect: "databricks",
  });
  assert.equal(r.standardizedSql, "SELECT * FROM orders AS o JOIN customers AS c ON o.cust_id = c.id");
  assert.equal(r.extractionError, null);
});

test("standardizedSql: falls back to the raw original SQL (not null) with extractionError set when the generator can't render this construct yet, other fields stay populated", () => {
  // Deviation / known gap: `currentdate_sql` is not yet ported in this
  // port's base Generator (verified — a real NotPorted throw, not silently
  // wrong output), so any query containing CURRENT_DATE cannot regenerate
  // standardizedSql on Databricks or Snowflake today. This degrades ONLY
  // standardizedSql; tables/nonDeterministic/etc. are computed before
  // generation is attempted and are unaffected. See contrib/README.md.
  //
  // standardizedSql falls back to the raw sql text rather than null: this
  // field feeds a cache key, and null is a WORSE cache-key input than the
  // query's own text — every currently-unfixable query would otherwise
  // collide on the same null key instead of keying on their own SQL.
  const r = extractSqlMetadata("SELECT * FROM orders WHERE order_date = CURRENT_DATE", { dialect: "databricks" });
  assert.equal(r.standardizedSql, "SELECT * FROM orders WHERE order_date = CURRENT_DATE");
  assert.match(r.extractionError, /standardizedSql generation failed/);
  assert.deepEqual(r.tables, [{ catalog: null, schema: null, table: "orders", fullyQualifiedName: "orders", operation: "SELECT" }]);
  assert.equal(r.nonDeterministic.hasNonDeterministicFunctions, true);
});

test("standardizedSql: falls back to the raw original SQL (not null) when the statement fails to parse at all", () => {
  // RESTORE TABLE ... TO VERSION AS OF ... throws a hard ParseError today
  // (verified, PORT_PLAN.md/contrib/README.md) — this is the total-failure
  // path (safeDefaultResult), one level more severe than a generator gap,
  // but the same cache-key-stability argument applies: fall back to the
  // statement's own text rather than null.
  const r = extractSqlMetadata("RESTORE TABLE my_table TO VERSION AS OF 5", { dialect: "databricks" });
  assert.equal(r.standardizedSql, "RESTORE TABLE my_table TO VERSION AS OF 5");
  assert.ok(r.extractionError);
  assert.equal(r.isDataChange, true);
  assert.equal(r.isDDL, true);
});

// ---------------------------------------------------------------------------
// Statement classification
// ---------------------------------------------------------------------------

test("statementType: WITH ... SELECT resolves to SELECT directly (no separate WITH unwrap step needed)", () => {
  const r = extractSqlMetadata("WITH cte AS (SELECT 1) SELECT * FROM cte", { dialect: "databricks" });
  assert.equal(r.statementType, "SELECT");
  assert.equal(r.isReadOnly, true);
});

test("statementType/isDDL/isDCL/isDataChange for a spread of statement types", () => {
  const cases = [
    ["SELECT 1", "SELECT", { isReadOnly: true, isDDL: false, isDCL: false, isDataChange: false }],
    ["INSERT INTO t VALUES (1)", "INSERT", { isReadOnly: false, isDDL: false, isDCL: false, isDataChange: true }],
    ["UPDATE t SET x = 1", "UPDATE", { isReadOnly: false, isDDL: false, isDCL: false, isDataChange: true }],
    ["DELETE FROM t WHERE x = 1", "DELETE", { isReadOnly: false, isDDL: false, isDCL: false, isDataChange: true }],
    ["CREATE TABLE t (x INT)", "CREATE", { isReadOnly: false, isDDL: true, isDCL: false, isDataChange: false }],
    ["DROP TABLE t", "DROP", { isReadOnly: false, isDDL: true, isDCL: false, isDataChange: false }],
    ["ALTER TABLE t ADD COLUMN y INT", "ALTER", { isReadOnly: false, isDDL: true, isDCL: false, isDataChange: false }],
    ["TRUNCATE TABLE t", "TRUNCATE", { isReadOnly: false, isDDL: true, isDCL: false, isDataChange: false }],
    ["GRANT SELECT ON t TO role1", "GRANT", { isReadOnly: false, isDDL: false, isDCL: true, isDataChange: false }],
    ["REVOKE SELECT ON t FROM role1", "REVOKE", { isReadOnly: false, isDDL: false, isDCL: true, isDataChange: false }],
  ];
  for (const [sql, statementType, expected] of cases) {
    const r = extractSqlMetadata(sql, { dialect: "databricks" });
    assert.equal(r.statementType, statementType, sql);
    assert.equal(r.isReadOnly, expected.isReadOnly, `${sql} isReadOnly`);
    assert.equal(r.isDDL, expected.isDDL, `${sql} isDDL`);
    assert.equal(r.isDCL, expected.isDCL, `${sql} isDCL`);
    assert.equal(r.isDataChange, expected.isDataChange, `${sql} isDataChange`);
  }
});
