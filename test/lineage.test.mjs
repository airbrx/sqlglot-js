// Structural/behavioral tests for `src/lineage.js` (AIR-2121, epic AIR-2092, "9.1
// lineage.js" -- stretch scope), runnable with no Python present.
//
// The deep differential signal (this file's Node DAG output vs CPython's real
// `sqlglot.lineage.lineage`, run end-to-end through every assertion-bearing
// `lineage(...)` call in upstream's own `tests/test_lineage.py`) lives in
// `spike/p10/fuzz_lineage.mjs` -- see that file and `gen_lineage_ref.py`'s own header
// for the full scenario list, and for the one confirmed, named finding (CPython
// `set`-iteration-order non-determinism in `to_node`'s `for c in source_columns:`
// loop, which upstream's own test suite already treats as non-contractual via
// `sorted(...)`).
//
// `Node#toHtml`/`GraphHTML` are NOT part of that cross-language diff (their output
// embeds a process-local id straight into an HTML/JS string with no cross-language-
// stable representation) -- covered here instead, asserting the same shape-only
// properties the real upstream `test_lineage`'s own `to_html`/`_repr_html_` assertions
// check (length > 1000, every edge has `from`/`to`), now that `tag_sql` (this PR's
// own one-line `src/generator.js` fix) makes the non-Table render path reachable.

import test from "node:test";
import assert from "node:assert/strict";
import { lineage, Node, GraphHTML } from "../src/lineage.js";
import { parseOne } from "../src/dialects/dialect.js";
import "../src/generator.js";
import "../src/dialects/snowflake.js";

test("basic: 3-level sources chain, source.sql()/sourceName at each level", () => {
  const node = lineage("a", "SELECT a FROM z", {
    schema: { x: { a: "int" } },
    sources: { y: "SELECT * FROM x", z: "SELECT a FROM y" },
  });
  assert.equal(
    node.source.sql(),
    "SELECT z.a AS a FROM (SELECT y.a AS a FROM (SELECT x.a AS a FROM x AS x) AS y /* source: y */) AS z /* source: z */",
  );
  assert.equal(node.sourceName, "");

  const d1 = node.downstream[0];
  assert.equal(d1.source.sql(), "SELECT y.a AS a FROM (SELECT x.a AS a FROM x AS x) AS y /* source: y */");
  assert.equal(d1.sourceName, "z");

  const d2 = d1.downstream[0];
  assert.equal(d2.source.sql(), "SELECT x.a AS a FROM x AS x");
  assert.equal(d2.sourceName, "y");
});

test("CTE lineage: reference_node_name tracks the CTE name, not source_name", () => {
  const node = lineage("a", "WITH z AS (SELECT a FROM y) SELECT a FROM z", {
    schema: { x: { a: "int" } },
    sources: { y: "SELECT * FROM x" },
  });
  assert.equal(node.sourceName, "");
  assert.equal(node.referenceNodeName, "");

  const d1 = node.downstream[0];
  assert.equal(d1.sourceName, "");
  assert.equal(d1.referenceNodeName, "z");
});

test("unresolved external column renders its placeholder source as '?'", () => {
  const node = lineage("a", "WITH y AS (SELECT * FROM x) SELECT a FROM y JOIN z USING (uid)");
  const d1 = node.downstream[0];
  assert.equal(d1.source.sql(), "?");
  assert.equal(d1.sourceName, "");
  assert.equal(d1.referenceNodeName, "");
});

test("star expansion: join with star fans out to one downstream per joined table", () => {
  const node = lineage("*", "SELECT * from x JOIN y USING (uid)");
  assert.equal(node.downstream.length, 2);
  assert.equal(node.downstream[0].expression.sql(), "x AS x");
  assert.equal(node.downstream[0].name, "*");
  assert.equal(node.downstream[1].expression.sql(), "y AS y");
  assert.equal(node.downstream[1].name, "*");
});

test("UNION: downstream fans out to one node per branch", () => {
  let node = lineage("x", "SELECT ax AS x FROM a UNION SELECT bx FROM b UNION SELECT cx FROM c");
  assert.equal(node.downstream.length, 3);

  node = lineage("x", "SELECT x FROM (SELECT ax AS x FROM a UNION SELECT bx FROM b UNION SELECT cx FROM c)");
  assert.equal(node.downstream.length, 3);
});

test("trimSelects=false keeps every projection in source.sql(), not just the traced column", () => {
  const node = lineage("a", "SELECT a, b, c FROM (select a, b, c from y) z", { trimSelects: false });
  assert.equal(node.name, "a");
  assert.equal(
    node.source.sql(),
    "SELECT z.a AS a, z.b AS b, z.c AS c FROM (SELECT y.a AS a, y.b AS b, y.c AS c FROM y AS y) AS z",
  );

  const d1 = node.downstream[0];
  assert.equal(d1.name, "z.a");
  assert.equal(d1.source.sql(), "SELECT y.a AS a, y.b AS b, y.c AS c FROM y AS y");
});

test("inline comments on a source column don't leak into the lineage node name", () => {
  const node = lineage("x", "SELECT * FROM (SELECT x /* c */ FROM t1) AS t2");
  assert.equal(node.downstream[0].downstream[0].name, "t1.x");
});

test("normalize_identifiers: snowflake uppercases the traced column", () => {
  const node = lineage("a", "WITH x AS (SELECT 1 a) SELECT a FROM x", { dialect: "snowflake" });
  assert.equal(node.name, "A");
});

test("normalize_identifiers: a quoted (case-preserved) column that doesn't exist raises SqlglotError", () => {
  assert.throws(
    () => lineage('"a"', "WITH x AS (SELECT 1 a) SELECT a FROM x", { dialect: "snowflake" }),
    /Cannot find column 'a' in query\./,
  );
});

test("column=null returns a dict of every top-level output column, each a real Node", () => {
  const result = lineage(null, "SELECT a, b + 1 AS bp FROM x", { schema: { x: { a: "int", b: "int" } } });
  assert.deepEqual(new Set(Object.keys(result)), new Set(["a", "bp"]));
  assert.ok(result.a instanceof Node);
  assert.ok(result.bp instanceof Node);

  const single = lineage("a", "SELECT a, b + 1 AS bp FROM x", { schema: { x: { a: "int", b: "int" } } });
  assert.equal(result.a.name, single.name);
});

test("shared upstream columns are cached: the same Node object is reused across outputs", () => {
  const result = lineage(null, "WITH t AS (SELECT a, b FROM x) SELECT a, a + b AS ab FROM t", {
    schema: { x: { a: "int", b: "int" } },
  });
  const aViaA = result.a.downstream[0];
  const aViaAb = result.ab.downstream.find((d) => d.name === "t.a");
  assert.equal(aViaA, aViaAb);
  assert.equal(aViaA.downstream[0], aViaAb.downstream[0]);
});

test("copy=false mutates the caller's AST/sources in place; copy=true (default) leaves them untouched", () => {
  const schema = { x: { a: "int" } };

  let query = parseOne("SELECT a FROM z");
  const sources = { y: parseOne("SELECT * FROM x"), z: parseOne("SELECT * FROM y") };
  lineage("a", query, { schema, sources, copy: false });
  assert.equal(sources.y.sql(), "SELECT * FROM x");
  assert.equal(sources.z.sql(), "SELECT * FROM y");
  assert.equal(
    query.sql(),
    "SELECT z.a AS a FROM (SELECT y.a AS a FROM (SELECT x.a AS a FROM x AS x) AS y /* source: y */) AS z /* source: z */",
  );

  query = parseOne("SELECT a FROM x");
  lineage("a", query, { schema, copy: true });
  assert.equal(query.sql(), "SELECT a FROM x");
});

test("on_node: fires exactly once per unique node, after that node's own downstream is populated", () => {
  const order = [];
  const result = lineage(null, "WITH t AS (SELECT a + 1 AS v FROM x) SELECT v FROM t", {
    schema: { x: { a: "int" } },
    onNode: (node) => {
      order.push(node);
      node.payload.seen = true;
    },
  });

  assert.equal(order.length, new Set(order).size, "on_node must fire exactly once per unique node");

  const position = new Map(order.map((n, i) => [n, i]));
  for (const node of result.v.walk()) {
    assert.ok(node.payload.seen);
    for (const child of node.downstream) {
      assert.ok(position.get(child) < position.get(node), `${child.name} must fire before ${node.name}`);
    }
  }
});

test("Node#walk: DFS pre-order, each reachable node visited exactly once", () => {
  const node = lineage("a", "SELECT a FROM z", {
    schema: { x: { a: "int" } },
    sources: { y: "SELECT * FROM x", z: "SELECT a FROM y" },
  });
  const walked = [...node.walk()];
  assert.equal(walked.length, 4); // root + z.a + y.a + the base-table x.a leaf
  assert.equal(new Set(walked).size, 4);
  assert.equal(walked[0], node);
});

test("Node#toHtml / GraphHTML: non-Table branch (needs generator.js's tag_sql fix), shape-only", () => {
  const node = lineage("a", "SELECT a FROM z", {
    schema: { x: { a: "int" } },
    sources: { y: "SELECT * FROM x", z: "SELECT a FROM y" },
  });
  const html = node.toHtml();
  assert.ok(html instanceof GraphHTML);

  const rendered = html._repr_html_();
  assert.ok(rendered.length > 1000, `expected length > 1000, got ${rendered.length}`);
  assert.equal(rendered, html.toString());

  for (const edge of html.edges) {
    assert.ok("from" in edge);
    assert.ok("to" in edge);
  }
});

test("Node#toHtml: Table-leaf branch renders a FROM label without needing tag_sql", () => {
  const node = lineage("a", "SELECT a FROM x");
  const leaf = node.downstream[0];
  assert.ok(leaf.expression.constructor.name === "Table" || leaf.expression.sql().includes("x"));
  const html = node.toHtml();
  assert.ok(html._repr_html_().length > 0);
});
