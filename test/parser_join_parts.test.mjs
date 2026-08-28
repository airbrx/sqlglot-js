import test from "node:test";
import assert from "node:assert/strict";
import { Parser } from "../src/parser.js";
import { Tokenizer } from "../src/tokens.js";

// Differential cases against Parser._parse_join_parts at sqlglot 91119bc.  The
// Python oracle returns (method, side, kind) token texts and leaves the first
// non-part token current.  These cover the prefixes exercised by ordinary,
// comma/lateral, and speculative no-JOIN parsing.
const cases = [
  ["JOIN", [null, null, null], "JOIN"],
  ["INNER JOIN", [null, null, "INNER"], "JOIN"],
  ["LEFT OUTER JOIN", [null, "LEFT", "OUTER"], "JOIN"],
  ["RIGHT JOIN", [null, "RIGHT", null], "JOIN"],
  ["FULL OUTER JOIN", [null, "FULL", "OUTER"], "JOIN"],
  ["CROSS JOIN", [null, null, "CROSS"], "JOIN"],
  ["NATURAL LEFT JOIN", ["NATURAL", "LEFT", null], "JOIN"],
  ["NATURAL INNER JOIN", ["NATURAL", null, "INNER"], "JOIN"],
  ["ASOF LEFT JOIN", ["ASOF", "LEFT", null], "JOIN"],
  ["POSITIONAL JOIN", [null, null, null], "POSITIONAL"],
  [", lateral", [null, null, null], ","],
  ["LATERAL x", [null, null, null], "LATERAL"],
  ["ON x", [null, null, null], "ON"],
  ["USING (x)", [null, null, null], "USING"],
  ["WHERE x", [null, null, null], "WHERE"],
];

function parserAt(sql) {
  const { tokens } = new Tokenizer().tokenize(sql);
  const parser = new Parser();
  parser._tokens = tokens;
  parser._tokens_size = tokens.length;
  parser._index = 0;
  parser._curr = tokens[0];
  parser._next = tokens[1] ?? parser._next;
  return parser;
}

test("_parse_join_parts matches the pinned CPython oracle across join prefixes", () => {
  for (const [sql, expected, remaining] of cases) {
    const parser = parserAt(sql);
    const actual = parser._parse_join_parts().map(token => token?.text.toUpperCase() ?? null);
    assert.deepEqual(actual, expected, sql);
    assert.equal(parser._curr.text.toUpperCase(), remaining, `${sql} cursor`);
  }
});
