// Faithful native port of the six parser/generator-independent tests from
// upstream tests/test_expressions.py @ 91119bc (PORT_PLAN.md §3.6 / Q6).
//
// P4 DEBT — the remaining 65 upstream tests, explicitly deferred (not dropped):
// test_to_s, test_arg_key, test_depth, test_iter, test_eq,
// test_eq_on_same_instance_short_circuits, test_find, test_find_all,
// test_find_ancestor, test_to_dot, test_root, test_alias_or_name,
// test_table_name, test_table, test_replace_tables, test_expand,
// test_expand_with_lazy_source_provider, test_replace_placeholders,
// test_function_building, test_var_len_args_spill_into_var_len_arg_key,
// test_named_selects, test_selects, test_alias_column_names, test_cast,
// test_ctes, test_hash, test_hash_invalidated_on_append, test_sql,
// test_transform_with_arguments, test_transform_simple,
// test_transform_no_infinite_recursion, test_transform_with_parent_mutation,
// test_transform_multiple_children, test_transform_node_removal, test_replace,
// test_arg_deletion, test_walk, test_str_position_order, test_functions,
// test_column, test_text, test_alias, test_alias_with_placeholder, test_unit,
// test_function_normalizer, test_convert, test_convert_python39,
// test_comment_alias, test_to_interval, test_to_table, test_to_column,
// test_union, test_values, test_data_type_builder, test_rename_table,
// test_to_py, test_is_int, test_is_star, test_set_metadata, test_unnest,
// test_is_type, test_set_meta, test_assert_is, test_convert_datetime_time,
// test_hash_large_ast.

import test from "node:test";
import assert from "node:assert/strict";
import {
  Boolean, CollateProperty, Column, EngineProperty, FileFormatProperty, Identifier,
  Literal, Neg, Null, PartitionedByProperty, Properties, Property, Tuple,
  column, parseIdentifier, toIdentifier,
} from "../../src/expressions/index.js";
import { PyValueError } from "../../src/_py/errors.js";

test("test_identifier", () => {
  assert.equal(toIdentifier('"x"').args.quoted, true);
  assert.equal(toIdentifier("x").args.quoted, false);
  assert.equal(toIdentifier("foo ").args.quoted, true);
  assert.equal(toIdentifier("_x").args.quoted, false);
});

test("test_properties_from_dict", () => {
  assert(Properties.fromDict({
    FORMAT: "parquet",
    PARTITIONED_BY: { __tuple__: [toIdentifier("a"), toIdentifier("b")] },
    custom: 1,
    ENGINE: null,
    COLLATE: true,
  }).equals(new Properties({ expressions: [
    new FileFormatProperty({ this: Literal.string("parquet") }),
    new PartitionedByProperty({ this: new Tuple({ expressions: [toIdentifier("a"), toIdentifier("b")] }) }),
    new Property({ this: Literal.string("custom"), value: Literal.number(1) }),
    new EngineProperty({ this: new Null() }),
    new CollateProperty({ this: new Boolean({ this: true }) }),
  ] })));
  assert.throws(() => Properties.fromDict({ FORMAT: Object }), PyValueError);
});

test("test_literal_number", () => {
  for (const number of [1, -1.1, 1.1, 0, "-1", "1", "1.1", "-1.1", "1e6", "inf", "binary_double_nan"]) {
    const literal = Literal.number(number);
    assert.equal(literal.isNumber, true);
    const isNegative = typeof number === "string" ? number.startsWith("-") : number < 0;
    const expectedThis = typeof number === "string" ? number.replace(/^-/, "") : String(Math.abs(number));
    let actual;
    if (isNegative) {
      assert(literal instanceof Neg);
      assert(literal.this instanceof Literal);
      actual = literal.this.this;
    } else {
      assert(literal instanceof Literal);
      actual = literal.this;
    }
    assert.equal(actual, expectedThis);
  }
});

test("test_update_positions_empty_meta", () => {
  const expr1 = new Column({ this: "a" });
  const expr2 = new Column({ this: "b" });
  for (const key of Object.keys(expr2.meta)) delete expr2.meta[key];
  expr1.updatePositions(expr2);
  assert.deepEqual(expr1.meta, {});
});

test("test_pipe_and_apply", () => {
  // Python's `expr + n` operator maps to the explicit Expr.add method in JS.
  const addVal = (expr, val, { squared }) => expr.add(squared ? val ** 2 : val);
  const addValAlt = (val, squared, expr) => addVal(expr, val, { squared });
  const col = column("age");
  const added = addVal(col, 5, { squared: true });
  assert(col.equals(col.apply((x) => x)));
  assert(col.pipe(addVal, 5, { squared: true }).equals(added));
  assert(col.pipe((e) => addValAlt(5, true, e)).equals(added));
});

// Parser-independent, re-derived by measurement rather than by inspection.  The
// earlier reading was that this test reaches the tokenizer and so belongs to P4.  It
// does not: `parse_one("a ' b", into=Identifier)` RAISES TokenError upstream, so
// parse_identifier can only ever return through its `except (ParseError, TokenError)`
// arm, whose value is to_identifier(name) -- pure expression-layer code.  Verified on
// CPython @ 91119bc: stubbing maybe_parse to raise ParseError leaves the assertion
// true, and the unstubbed parser never produces a value here at all.
test("test_parse_identifier", () => {
  assert(parseIdentifier("a ' b").equals(toIdentifier("a ' b")));
});
