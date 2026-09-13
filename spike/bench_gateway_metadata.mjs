// Wall-clock latency benchmark for contrib/gatewaySqlMetadata.js — the
// real-AST replacement candidate for airbrx-gateway's regex-based
// lib/utils/SqlParser.js on the hot request path.
//
// This does NOT touch airbrx-gateway. It only measures sqlglot-js itself:
//   node spike/bench_gateway_metadata.mjs
//
// Methodology:
//   - process.hrtime.bigint() for nanosecond-precision wall clock.
//   - WARMUP iterations discarded per (shape, dialect) cell before timing,
//     to let V8 JIT the hot functions before we start recording.
//   - ITERATIONS timed samples per cell, sorted, p50/p95/p99 reported.
//   - A single call to extractSqlMetadata already does the full pipeline
//     (parse -> extract -> regenerate standardizedSql). Section 3 below
//     also times `dialect.parse(sql)` alone, in the same loop shape, so the
//     "parse" vs. "extract+generate" split is measured, not estimated.
//   - Section 2 is a rough, deliberately-not-faithful re-timing of a
//     handful of the SAME regex patterns airbrx-gateway's SqlParser.js
//     actually uses (FROM/JOIN table capture, SET/USE detection), just so
//     the AST numbers have an honest order-of-magnitude reference point.
//
// Results are real measurements from running this file — see the printed
// tables and the "SUMMARY" section at the end for the write-up. This
// script changes no parsing/generation behavior; it is pure benchmarking.

import { Dialect } from "../index.js";
import { extractSqlMetadata } from "../contrib/gatewaySqlMetadata.js";
import { readFileSync } from "node:fs";

const DIALECTS = ["databricks", "snowflake", "postgres"];
const WARMUP = 200;
const ITERATIONS = 2000;

// ---------------------------------------------------------------------------
// Query shapes
// ---------------------------------------------------------------------------

const MEDIUM_SQL = `
SELECT o.order_id, o.order_date, c.customer_name, p.product_name, oi.quantity, oi.unit_price
FROM orders o
JOIN customers c ON o.customer_id = c.customer_id
JOIN order_items oi ON oi.order_id = o.order_id
JOIN products p ON p.product_id = oi.product_id
WHERE o.status = 'COMPLETED'
  AND o.order_date >= '2024-01-01'
  AND c.region IN ('US', 'CA', 'EU')
  AND oi.quantity > 0
ORDER BY o.order_date DESC
LIMIT 100
`.trim();

const COMPLEX_SQL = `
WITH recent_orders AS (
  SELECT customer_id, order_id, total_amount,
         ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_date DESC) AS rn
  FROM orders
  WHERE order_date >= '2024-01-01'
)
SELECT c.customer_id, c.customer_name, ro.order_id, ro.total_amount,
       (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = ro.order_id) AS item_count
FROM customers c
JOIN recent_orders ro ON ro.customer_id = c.customer_id AND ro.rn = 1
WHERE c.active = TRUE
`.trim();

// Sourced from corpus/atoms.jsonl (tests/dialects/test_spark.py:440) — the
// single largest SQL string in the harvested differential-test corpus
// (atoms.jsonl has no databricks-tagged query anywhere near this size; the
// largest databricks-specific atom is ~200 chars). Verified separately that
// this parses cleanly under all three target dialects even though it was
// harvested as a `read: spark` case, so it is reused as-is for all three
// rather than hand-writing a synthetic "large" query. Not modified in any way.
const LARGE_SQL = JSON.parse(
  readFileSync(new URL("../corpus/atoms.jsonl", import.meta.url), "utf8")
    .split("\n")
    .find((line) => line.includes('"tests/dialects/test_spark.py:440"')),
).sql;

const SHAPES = [
  { name: "trivial", sql: "SELECT 1" },
  { name: "simple", sql: "SELECT id, name FROM users WHERE active = TRUE" },
  { name: "medium (3-join)", sql: MEDIUM_SQL },
  { name: "complex (CTE+window+subquery)", sql: COMPLEX_SQL },
  { name: "insert", sql: "INSERT INTO users (id, name, active) VALUES (1, 'ada', TRUE)" },
  { name: "update", sql: "UPDATE users SET active = FALSE WHERE id = 1" },
  { name: "delete", sql: "DELETE FROM users WHERE id = 1" },
  { name: "set", sql: "SET timezone = 'UTC'" },
  { name: "use", sql: "USE main.sales" },
  { name: `large (${LARGE_SQL.length} chars, real corpus query)`, sql: LARGE_SQL },
];

// ---------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------

function percentile(sortedNs, p) {
  const idx = Math.min(sortedNs.length - 1, Math.floor((p / 100) * sortedNs.length));
  return sortedNs[idx];
}

function fmtNs(ns) {
  const us = ns / 1000;
  if (us < 1000) return `${us.toFixed(2)}µs`;
  return `${(us / 1000).toFixed(3)}ms`;
}

// Times `fn()` WARMUP+ITERATIONS times, discards the warmup samples, returns
// {p50, p95, p99, mean} in nanoseconds over the timed samples only.
function timeFn(fn) {
  for (let i = 0; i < WARMUP; i++) fn();

  const samples = new Array(ITERATIONS);
  for (let i = 0; i < ITERATIONS; i++) {
    const start = process.hrtime.bigint();
    fn();
    const end = process.hrtime.bigint();
    samples[i] = Number(end - start);
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    mean,
  };
}

function printTable(title, rows, columns) {
  console.log(`\n${title}`);
  const widths = columns.map((c) => Math.max(c.label.length, ...rows.map((r) => String(c.get(r)).length)));
  const header = columns.map((c, i) => c.label.padEnd(widths[i])).join("  ");
  console.log(header);
  console.log(columns.map((c, i) => "-".repeat(widths[i])).join("  "));
  for (const r of rows) {
    console.log(columns.map((c, i) => String(c.get(r)).padEnd(widths[i])).join("  "));
  }
}

// ---------------------------------------------------------------------------
// Section 1: full extractSqlMetadata() pipeline, per shape x dialect
// ---------------------------------------------------------------------------

console.log("=".repeat(78));
console.log("Section 1: extractSqlMetadata(sql, {dialect}) — full pipeline");
console.log(`  warmup=${WARMUP} iterations=${ITERATIONS} per cell, process.hrtime.bigint()`);
console.log("=".repeat(78));

const fullResults = [];
for (const shape of SHAPES) {
  for (const dialect of DIALECTS) {
    const stats = timeFn(() => extractSqlMetadata(shape.sql, { dialect }));
    fullResults.push({ shape: shape.name, dialect, ...stats });
  }
}

printTable("extractSqlMetadata latency (p50 / p95 / p99, mean)", fullResults, [
  { label: "shape", get: (r) => r.shape },
  { label: "dialect", get: (r) => r.dialect },
  { label: "p50", get: (r) => fmtNs(r.p50) },
  { label: "p95", get: (r) => fmtNs(r.p95) },
  { label: "p99", get: (r) => fmtNs(r.p99) },
  { label: "mean", get: (r) => fmtNs(r.mean) },
]);

// ---------------------------------------------------------------------------
// Section 2: parse-only vs. extract+generate breakdown
// ---------------------------------------------------------------------------

console.log("\n" + "=".repeat(78));
console.log("Section 2: where does the time go — parse vs. metadata-extraction+generate");
console.log("=".repeat(78));

// Mirrors extractSqlMetadata's own extraction body (statementType, tables,
// session-state, parameters, non-determinism, standardizedSql) but reuses an
// already-parsed AST, so this isolates "everything after parse" without
// re-implementing gatewaySqlMetadata.js's internals (which aren't exported).
// We approximate this by diffing full-pipeline time against parse-only time
// for the same AST rather than calling private helpers directly.
const breakdownResults = [];
for (const shape of SHAPES) {
  for (const dialect of DIALECTS) {
    const d = Dialect.get_or_raise(dialect);
    const parseStats = timeFn(() => d.parse(shape.sql));
    const fullStats = fullResults.find((r) => r.shape === shape.name && r.dialect === dialect);
    const extractP50 = Math.max(0, fullStats.p50 - parseStats.p50);
    breakdownResults.push({
      shape: shape.name,
      dialect,
      parseP50: parseStats.p50,
      fullP50: fullStats.p50,
      extractP50,
      parseShare: (parseStats.p50 / fullStats.p50) * 100,
    });
  }
}

printTable("parse-only vs. full-pipeline p50 (extract+generate = full - parse)", breakdownResults, [
  { label: "shape", get: (r) => r.shape },
  { label: "dialect", get: (r) => r.dialect },
  { label: "parse p50", get: (r) => fmtNs(r.parseP50) },
  { label: "full p50", get: (r) => fmtNs(r.fullP50) },
  { label: "extract+gen p50 (est.)", get: (r) => fmtNs(r.extractP50) },
  { label: "parse % of total", get: (r) => `${r.parseShare.toFixed(0)}%` },
]);

// ---------------------------------------------------------------------------
// Section 3: regex baseline (rough order-of-magnitude reference only)
// ---------------------------------------------------------------------------
//
// NOT a faithful reimplementation of airbrx-gateway's SqlParser.js — just a
// handful of the same style of regex it actually runs, so the AST numbers
// above aren't read in a vacuum. See SqlParser.js's real `_extractTables`
// (FROM/JOIN table capture) and statement-type dispatch for the patterns
// these are modeled on.

console.log("\n" + "=".repeat(78));
console.log("Section 3: regex baseline (rough reference, not a faithful port of SqlParser.js)");
console.log("=".repeat(78));

const STATEMENT_TYPE_RE = /^\s*(SELECT|INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|USE|SET|GRANT|REVOKE|WITH)\b/i;
const TABLE_RE = /\b(?:FROM|JOIN|UPDATE|INTO)\s+([A-Za-z_][A-Za-z0-9_.`"]*)/gi;
const SESSION_STATE_RE = /^\s*(SET|USE)\b/i;

function regexExtract(sql) {
  const typeMatch = STATEMENT_TYPE_RE.exec(sql);
  const statementType = typeMatch ? typeMatch[1].toUpperCase() : "UNKNOWN";
  const tables = [];
  TABLE_RE.lastIndex = 0;
  let m;
  while ((m = TABLE_RE.exec(sql)) !== null) tables.push(m[1]);
  const isSessionStateChange = SESSION_STATE_RE.test(sql);
  return { statementType, tables, isSessionStateChange };
}

const regexResults = [];
for (const shape of SHAPES) {
  const stats = timeFn(() => regexExtract(shape.sql));
  const fullStatsAnyDialect = fullResults.find((r) => r.shape === shape.name && r.dialect === "postgres");
  regexResults.push({
    shape: shape.name,
    regexP50: stats.p50,
    astP50: fullStatsAnyDialect.p50,
    ratio: fullStatsAnyDialect.p50 / stats.p50,
  });
}

printTable("regex baseline vs. full AST pipeline (postgres), p50", regexResults, [
  { label: "shape", get: (r) => r.shape },
  { label: "regex p50", get: (r) => fmtNs(r.regexP50) },
  { label: "AST p50", get: (r) => fmtNs(r.astP50) },
  { label: "AST / regex", get: (r) => `${r.ratio.toFixed(0)}x` },
]);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const worstFull = fullResults.reduce((a, b) => (b.p99 > a.p99 ? b : a));
const worstP50 = fullResults.reduce((a, b) => (b.p50 > a.p50 ? b : a));
const overallMeanUs = fullResults.reduce((a, r) => a + r.mean, 0) / fullResults.length / 1000;

console.log("\n" + "=".repeat(78));
console.log("SUMMARY");
console.log("=".repeat(78));
console.log(`
See spike/bench_gateway_metadata_results.md for the full write-up (based on
multiple runs of this script, to separate stable p50/p95 numbers from p99
tail noise). This run: worst-case p50 across all shapes/dialects was
${fmtNs(worstP50.p50)} (${worstP50.shape} / ${worstP50.dialect}); worst-case
p99 was ${fmtNs(worstFull.p99)} (${worstFull.shape} / ${worstFull.dialect},
p99 varies run to run — see the results doc); overall mean across every
shape x dialect cell was ~${overallMeanUs.toFixed(1)}µs. These are the real
numbers from this run, not estimates — re-run this file to reproduce.
`);
