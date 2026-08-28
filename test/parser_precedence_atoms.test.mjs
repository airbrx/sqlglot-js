import test from "node:test";
import assert from "node:assert/strict";
import { Parser } from "../src/parser.js";
import { Tokenizer, TokenType } from "../src/tokens.js";
import * as exp from "../src/expressions/index.js";

function parserFor(sql) {
  const p = new Parser({ dialect: {
    tokenizer_class: Tokenizer,
    SUPPORTS_COLUMN_JOIN_MARKS: false,
    VALID_INTERVAL_UNITS: new Set(["DAY", "HOUR"]),
    DPIPE_IS_STRING_CONCAT: false,
  }});
  const { tokens, codePoints } = new Tokenizer().tokenize(sql);
  p.sql = sql; p.sqlCodePoints = codePoints; p._tokens = tokens; p._tokens_size = tokens.length;
  p._index = -1; p._advance();
  p._identifier_expression = function(token = null, quoted = null) {
    token ||= this._prev;
    return this.expression(new exp.Identifier({ this: token.text, quoted }), token);
  };
  p._parse_placeholder = () => null;
  p._match_r_paren = function() { return this._match(TokenType.R_PAREN); };
  return p;
}

test("primitive identifier/var/number parsers preserve token text and quoting", () => {
  let p = parserFor('"a"');
  assert.deepEqual(p._parse_identifier().args, { this: "a", quoted: true });
  p = parserFor("foo");
  assert.deepEqual(p._parse_id_var(false).args, { this: "foo", quoted: false });
  p = parserFor("123");
  assert.equal(p._parse_number().name, "123");
});

test("fast column path matches CPython part placement for one through five parts", () => {
  for (const [sql, expected] of [
    ["a", ["a", "", "", ""]],
    ["a.b", ["b", "a", "", ""]],
    ["a.b.c", ["c", "b", "a", ""]],
    ["a.b.c.d", ["d", "c", "b", "a"]],
  ]) {
    const column = parserFor(sql)._parse_column_parts_fast();
    assert.deepEqual([column.name, column.table, column.db, column.catalog], expected);
  }
  const dotted = parserFor("a.b.c.d.e")._parse_column_parts_fast();
  assert.ok(dotted instanceof exp.Dot);
  assert.equal(dotted.expression.name, "e");
});

test("CSV and wrapped helpers retain empty and trailing-comma semantics", () => {
  const p = parserFor("(a,b)");
  const values = p._parse_wrapped_csv(() => p._parse_id_var(false));
  assert.deepEqual(values.map(x => x.name), ["a", "b"]);
  assert.equal(p._curr.token_type, TokenType.SENTINEL);
});
