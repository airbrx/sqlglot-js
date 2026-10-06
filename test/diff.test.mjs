// Structural/behavioral tests for `src/diff.js`, runnable with no Python present.
//
// The deep differential signal (this file's output vs CPython's `sqlglot.diff`, over
// every `tests/test_diff.py` scenario) lives in `spike/p10/fuzz_diff.mjs` — see that
// file and `gen_diff_ref.py`'s own header for the full design, including why edit-script
// order is deliberately not asserted. These tests port `tests/test_diff.py`'s own
// assertions directly, mirroring its `_validate_delta_only`'s `set(actual) ==
// set(expected)` semantics (never list equality — see `src/diff.js`'s own file header).

import test from "node:test";
import assert from "node:assert/strict";
import { parseOne } from "../src/dialects/dialect.js";
import * as exp from "../src/expressions/index.js";
import { diff, Insert, Remove, Move, Update, Keep } from "../src/diff.js";
import "../src/generator.js";
import "../src/dialects/postgres.js";

function canon(e) {
  if (e instanceof Insert) return `Insert(${e.expression.sql()})`;
  if (e instanceof Remove) return `Remove(${e.expression.sql()})`;
  if (e instanceof Move) return `Move(${e.source.sql()} -> ${e.target.sql()})`;
  if (e instanceof Update) return `Update(${e.source.sql()} -> ${e.target.sql()})`;
  if (e instanceof Keep) return `Keep(${e.source.sql()} -> ${e.target.sql()})`;
  throw new TypeError(String(e));
}

// py: tests/test_diff.py `_validate_delta_only` — `assertEqual(set(actual), set(expected))`.
function assertDeltaSet(actual, expected) {
  assert.deepEqual(new Set(actual.map(canon)), new Set(expected.map(canon)));
}

function diffDeltaOnly(source, target, options = {}) {
  return diff(source, target, { delta_only: true, ...options });
}

test("test_simple", () => {
  assertDeltaSet(diffDeltaOnly(parseOne("SELECT a + b"), parseOne("SELECT a - b")), [
    new Remove(parseOne("a + b")),
    new Insert(parseOne("a - b")),
    new Move(parseOne("a"), parseOne("a")),
    new Move(parseOne("b"), parseOne("b")),
  ]);

  assertDeltaSet(diffDeltaOnly(parseOne("SELECT a, b, c"), parseOne("SELECT a, c")), [
    new Remove(parseOne("b")),
  ]);

  assertDeltaSet(diffDeltaOnly(parseOne("SELECT a, b"), parseOne("SELECT a, b, c")), [
    new Insert(parseOne("c")),
  ]);

  assertDeltaSet(
    diffDeltaOnly(parseOne("SELECT a FROM table_one"), parseOne("SELECT a FROM table_two")),
    [new Update(exp.toTable("table_one", { quoted: false }), exp.toTable("table_two", { quoted: false }))],
  );
});

test("test_lambda", () => {
  assertDeltaSet(
    diffDeltaOnly(
      parseOne("SELECT a, b, c, x(a -> a)"),
      parseOne("SELECT a, b, c, x(b -> b)"),
    ),
    [
      new Update(
        new exp.Lambda({ this: exp.toIdentifier("a"), expressions: [exp.toIdentifier("a")] }),
        new exp.Lambda({ this: exp.toIdentifier("b"), expressions: [exp.toIdentifier("b")] }),
      ),
    ],
  );
});

test("test_udf", () => {
  assertDeltaSet(
    diffDeltaOnly(parseOne('SELECT a, b, "my.udf1"()'), parseOne('SELECT a, b, "my.udf2"()')),
    [new Insert(parseOne('"my.udf2"()')), new Remove(parseOne('"my.udf1"()'))],
  );
  assertDeltaSet(
    diffDeltaOnly(
      parseOne('SELECT a, b, "my.udf"(x, y, z)'),
      parseOne('SELECT a, b, "my.udf"(x, y, w)'),
    ),
    [new Insert(exp.column("w")), new Remove(exp.column("z"))],
  );
});

test("test_node_position_changed", () => {
  let exprSrc = parseOne("SELECT a, b, c");
  let exprTgt = parseOne("SELECT c, a, b");
  assertDeltaSet(diffDeltaOnly(exprSrc, exprTgt), [new Move(exprSrc.selects[2], exprTgt.selects[0])]);

  exprSrc = parseOne("SELECT a + b");
  exprTgt = parseOne("SELECT b + a");
  assertDeltaSet(diffDeltaOnly(exprSrc, exprTgt), [
    new Move(exprSrc.selects[0].left, exprTgt.selects[0].right),
  ]);

  exprSrc = parseOne("SELECT aaaa AND bbbb");
  exprTgt = parseOne("SELECT bbbb AND aaaa");
  assertDeltaSet(diffDeltaOnly(exprSrc, exprTgt), [
    new Move(exprSrc.selects[0].left, exprTgt.selects[0].right),
  ]);

  exprSrc = parseOne("SELECT aaaa OR bbbb OR cccc");
  exprTgt = parseOne("SELECT cccc OR bbbb OR aaaa");
  assertDeltaSet(diffDeltaOnly(exprSrc, exprTgt), [
    new Move(exprSrc.selects[0].left.left, exprTgt.selects[0].right),
    new Move(exprSrc.selects[0].right, exprTgt.selects[0].left.left),
  ]);

  // py:130-151 (the CONCAT(...) sub-cases) are covered separately below -- rendering
  // CONCAT hits a pre-existing, unrelated base-Generator gap (`concat_sql`), not a
  // `diff.js` bug. See that test's own comment.
});

test("test_node_position_changed — CONCAT sub-cases (named pre-existing generator gap)", () => {
  // `ChangeDistiller._bigram_histo` renders every candidate node with the real
  // Generator for its dice-coefficient similarity score (see src/diff.js), and
  // `Generator.prototype.concat_sql` is `NotPorted` (`src/generator.js:4062`,
  // `sqlglot/generator.py:3710`) — a pre-existing, unrelated gap also named in
  // `spike/p10/fuzz_diff.mjs`'s `NAMED_GENERATOR_GAPS`. These two upstream scenarios
  // can't run end to end in this port yet; asserting the exact failure keeps this
  // gap visible instead of silently vanishing if something about it changes.
  const exprSrc = parseOne("SELECT a, b FROM t WHERE CONCAT('a', 'b') = 'ab'");
  const exprTgt = parseOne("SELECT a FROM t WHERE CONCAT('a', 'b', b) = 'ab'");
  assert.throws(() => diffDeltaOnly(exprSrc, exprTgt), { name: "NotPorted", message: /concat_sql/ });

  const exprSrc2 = parseOne("SELECT a as a, b as b FROM t WHERE CONCAT('a', 'b') = 'ab'");
  const exprTgt2 = parseOne("SELECT a as a FROM t WHERE CONCAT('a', 'b', b) = 'ab'");
  assert.throws(() => diffDeltaOnly(exprSrc2, exprTgt2), { name: "NotPorted", message: /concat_sql/ });
});

test("test_cte", () => {
  const exprSrc = `
    WITH
        cte1 AS (SELECT a, b, LOWER(c) AS c FROM table_one WHERE d = 'filter'),
        cte2 AS (SELECT d, e, f FROM table_two)
    SELECT a, b, d, e FROM cte1 JOIN cte2 ON f = c
  `;
  const exprTgt = `
    WITH
        cte1 AS (SELECT a, b, c FROM table_one WHERE d = 'different_filter'),
        cte2 AS (SELECT d, e, f FROM table_two)
    SELECT a, b, d, e FROM cte1 JOIN cte2 ON f = c
  `;

  assertDeltaSet(diffDeltaOnly(parseOne(exprSrc), parseOne(exprTgt)), [
    new Remove(parseOne("LOWER(c) AS c")),
    new Remove(parseOne("LOWER(c)")),
    new Remove(parseOne("'filter'")),
    new Insert(parseOne("'different_filter'")),
    new Move(parseOne("c"), parseOne("c")),
  ]);
});

test("test_join", () => {
  let exprSrc = parseOne("SELECT a, b FROM t1 LEFT JOIN t2 ON t1.key = t2.key");
  let exprTgt = parseOne("SELECT a, b FROM t1 RIGHT JOIN t2 ON t1.key = t2.key");

  const srcJoin = exprSrc.find(exp.Join);
  const tgtJoin = exprTgt.find(exp.Join);

  assertDeltaSet(diffDeltaOnly(exprSrc, exprTgt), [
    new Remove(srcJoin),
    new Insert(tgtJoin),
    new Move(exp.toTable("t2"), exp.toTable("t2")),
    new Move(srcJoin.args.on, tgtJoin.args.on),
  ]);

  exprSrc = parseOne("SELECT a.x FROM a INNER JOIN b ON a.x = b.y LEFT JOIN c ON a.p = c.q");
  exprTgt = parseOne("SELECT a.x FROM a inner JOIN b ON a.x = b.y left JOIN c ON a.p = c.q");

  assertDeltaSet(diffDeltaOnly(exprSrc, exprTgt), []);
});

test("test_window_functions", () => {
  let exprSrc = parseOne("SELECT ROW_NUMBER() OVER (PARTITION BY a ORDER BY b)");
  let exprTgt = parseOne("SELECT RANK() OVER (PARTITION BY a ORDER BY b)");

  assertDeltaSet(diffDeltaOnly(exprSrc, exprSrc.copy()), []);

  assertDeltaSet(diffDeltaOnly(exprSrc, exprTgt), [
    new Remove(parseOne("ROW_NUMBER()")),
    new Insert(parseOne("RANK()")),
    new Update(exprSrc.selects[0], exprTgt.selects[0]),
  ]);

  // py: upstream's third case parses under dialect="oracle", which this port has no
  // real `Parser`/`Dialect` for (no `src/dialects/oracle.js`) — see `src/diff.js`'s
  // PR and PORT_PLAN.md's AIR-2122 entry for the named exclusion. Substituted here
  // with a real, ported dialect (postgres) to still exercise `ChangeDistiller`'s
  // `dialect` option end to end.
  exprSrc = parseOne("SELECT DISTINCT ON (a) a, b FROM t", { read: "postgres" });
  assertDeltaSet(diffDeltaOnly(exprSrc, exprSrc.copy(), { dialect: "postgres" }), []);
});

test("test_pre_matchings", () => {
  const exprSrc = parseOne("SELECT 1");
  const exprTgt = parseOne("SELECT 1, 2, 3, 4");

  assertDeltaSet(diffDeltaOnly(exprSrc, exprTgt), [
    new Remove(exprSrc),
    new Insert(exprTgt),
    new Insert(exp.Literal.number(2)),
    new Insert(exp.Literal.number(3)),
    new Insert(exp.Literal.number(4)),
    new Move(exp.Literal.number(1), exp.Literal.number(1)),
  ]);

  assertDeltaSet(diffDeltaOnly(exprSrc, exprTgt, { matchings: [[exprSrc, exprTgt]] }), [
    new Insert(exp.Literal.number(2)),
    new Insert(exp.Literal.number(3)),
    new Insert(exp.Literal.number(4)),
  ]);

  assertDeltaSet(
    diffDeltaOnly(exprSrc, exprTgt, {
      matchings: [
        [exprSrc, exprTgt],
        [exprSrc, exprTgt],
      ],
    }),
    [new Insert(exp.Literal.number(2)), new Insert(exp.Literal.number(3)), new Insert(exp.Literal.number(4))],
  );

  exprTgt.selects[0].replace(exprSrc.selects[0]);

  assertDeltaSet(diffDeltaOnly(exprSrc, exprTgt, { matchings: [[exprSrc, exprTgt]] }), [
    new Insert(exp.Literal.number(2)),
    new Insert(exp.Literal.number(3)),
    new Insert(exp.Literal.number(4)),
  ]);
});

test("test_identifier", () => {
  let exprSrc = parseOne("SELECT a FROM tbl");
  let exprTgt = parseOne("SELECT a, tbl.b from tbl");

  assertDeltaSet(diffDeltaOnly(exprSrc, exprTgt), [new Insert(exp.toColumn("tbl.b"))]);

  exprSrc = parseOne("SELECT 1 AS c1, 2 AS c2");
  exprTgt = parseOne("SELECT 2 AS c1, 3 AS c2");

  assertDeltaSet(diffDeltaOnly(exprSrc, exprTgt), [
    new Remove(exp.alias_(exp.Literal.number(1), "c1")),
    new Remove(exp.Literal.number(1)),
    new Insert(exp.alias_(exp.Literal.number(3), "c2")),
    new Insert(exp.Literal.number(3)),
    new Update(exp.alias_(exp.Literal.number(2), "c2"), exp.alias_(exp.Literal.number(2), "c1")),
  ]);
});

test("test_non_expression_leaf_delta", () => {
  let exprSrc = parseOne("SELECT a UNION SELECT b");
  let exprTgt = parseOne("SELECT a UNION ALL SELECT b");
  assertDeltaSet(diffDeltaOnly(exprSrc, exprTgt), [new Update(exprSrc, exprTgt)]);

  exprSrc = parseOne("SELECT a FROM t ORDER BY b ASC");
  exprTgt = parseOne("SELECT a FROM t ORDER BY b DESC");
  assertDeltaSet(diffDeltaOnly(exprSrc, exprTgt), [
    new Update(exprSrc.find(exp.Order).expressions[0], exprTgt.find(exp.Order).expressions[0]),
  ]);

  exprSrc = parseOne("SELECT a, b FROM t ORDER BY c ASC");
  exprTgt = parseOne("SELECT b, a FROM t ORDER BY c DESC");
  assertDeltaSet(diffDeltaOnly(exprSrc, exprTgt), [
    new Update(exprSrc.find(exp.Order).expressions[0], exprTgt.find(exp.Order).expressions[0]),
    new Move(exprSrc.selects[0], exprTgt.selects[1]),
  ]);
});

test("test_none_args_are_not_treated_as_leaves", () => {
  const exprSrc = new exp.Column({
    this: exp.toIdentifier("b"),
    table: exp.toIdentifier("a"),
    db: null,
    catalog: null,
  });
  const exprTgt = new exp.Column({ this: exp.toIdentifier("b"), table: exp.toIdentifier("a") });

  assert.deepEqual(new Set(Object.keys(exprSrc.args)), new Set(["this", "table", "db", "catalog"]));
  assert.deepEqual(new Set(Object.keys(exprTgt.args)), new Set(["this", "table"]));

  assertDeltaSet(diffDeltaOnly(exprSrc, exprTgt), []);
});

test("test_comments_do_not_affect_diff", () => {
  const exprSrc = parseOne("select a from tbl");
  const exprTgt = parseOne("select a from tbl -- this is comment");

  assert.deepEqual(exprTgt.args.from_.this.comments, [" this is comment"]);
  assertDeltaSet(diffDeltaOnly(exprSrc, exprTgt), []);
});
