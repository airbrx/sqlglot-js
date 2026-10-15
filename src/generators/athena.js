// py: sqlglot/generators/athena.py @ 91119bc — WHOLE FILE (181 LOC), AIR-2287 (epic
// AIR-2272, "12.2 Presto family"), part 2 of the chain. GENERATOR-side half of the
// Hive-vs-Trino composite `src/dialects/athena.js`'s own header describes;
// `AthenaGenerator` owns one real `_HiveGenerator` and one real `AthenaTrinoGenerator`
// and dispatches `.generate()` to whichever engine `_generate_as_hive` decides the
// expression would be routed to — a STRUCTURAL decision based on the expression kind
// (CREATE TABLE AS SELECT vs. plain CREATE TABLE, DROP VIEW vs. other DROP, etc.),
// independent of which sub-parser originally produced the AST.
//
// `_generator_kwargs` COLLAPSES TO A PLAIN OBJECT SPREAD
// -------------------------------------------------------------------------
// Upstream's own `_generator_kwargs` exists only to turn 10 separate `__init__`
// keyword arguments back into one dict it can forward via `**kwargs` to three
// different `Generator` subclass constructors. This port's `Generator.__init__`
// (`src/generator.js`) ALREADY takes one options object (CONTRACTS.md §8), so there
// is nothing to collapse — `_generator_kwargs` here is a direct destructure-and-
// rebuild of the same object, kept only to preserve upstream's one `if
// unsupported_level is not None` conditional-inclusion rule (an explicit `null` must
// NOT override each sub-generator's own `ErrorLevel.WARN` default).

import * as exp from "../expressions/index.js";
import { Generator, AFTER_HAVING_MODIFIER_TRANSFORMS } from "../generator.js";
import { HiveGenerator } from "./hive.js";
import { TrinoGenerator } from "./trino.js";
import { Hive } from "../dialects/hive.js";
import { Trino } from "../dialects/trino.js";
import { pyLower } from "../_py/str.js";

/** py: sqlglot/generators/athena.py:10 */
function _is_iceberg_table(properties) {
  for (const p of properties.expressions) {
    if (p instanceof exp.Property && p.name === "table_type") {
      return pyLower(p.text("value")) === "iceberg";
    }
  }

  return false;
}

/** py: sqlglot/generators/athena.py:18 */
function _location_property_sql(self, e) {
  // If table_type='iceberg', the LocationProperty is called 'location'
  // Otherwise, it's called 'external_location'
  // ref: https://docs.aws.amazon.com/athena/latest/ug/create-table-as.html
  let prop_name = "external_location";

  if (e.parent instanceof exp.Properties && _is_iceberg_table(e.parent)) {
    prop_name = "location";
  }

  return `${prop_name}=${self.sql(e, "this")}`;
}

/** py: sqlglot/generators/athena.py:32 */
function _partitioned_by_property_sql(self, e) {
  // If table_type='iceberg' then the table property for partitioning is called 'partitioning'
  // If table_type='hive' it's called 'partitioned_by'
  // ref: https://docs.aws.amazon.com/athena/latest/ug/create-table-as.html#ctas-table-properties
  let prop_name = "partitioned_by";

  if (e.parent instanceof exp.Properties && _is_iceberg_table(e.parent)) {
    prop_name = "partitioning";
  }

  return `${prop_name}=${self.sql(e, "this")}`;
}

/** py: sqlglot/generators/athena.py:46 */
function _generate_as_hive(expression) {
  if (expression instanceof exp.Create) {
    if (expression.args.kind === "TABLE") {
      const properties = expression.args.properties;

      // CREATE EXTERNAL TABLE is Hive
      if (properties && properties.find(exp.ExternalProperty)) {
        return true;
      }

      // Any CREATE TABLE other than CREATE TABLE ... As <query> is Hive
      if (!(expression.expression instanceof exp.Query)) {
        return true;
      }
    } else {
      // CREATE VIEW is Trino, but CREATE SCHEMA, CREATE DATABASE, etc, is Hive
      return expression.args.kind !== "VIEW";
    }
  } else if (
    expression instanceof exp.Alter ||
    expression instanceof exp.Drop ||
    expression instanceof exp.Describe ||
    expression instanceof exp.Show
  ) {
    if (expression instanceof exp.Drop && expression.args.kind === "VIEW") {
      // DROP VIEW is Trino, because CREATE VIEW is as well
      return false;
    }

    // Everything else, e.g., ALTER statements, is Hive
    return true;
  }

  return false;
}

/**
 * py: sqlglot/generators/athena.py:72 `_generator_kwargs`. See file header — a plain
 * rebuild of the options object, preserving upstream's `is not None` rule for
 * `unsupported_level` only.
 */
function _generator_kwargs(options) {
  const {
    pretty = null,
    identify = false,
    normalize = false,
    pad = 2,
    indent = 2,
    normalize_functions = null,
    unsupported_level = null,
    max_unsupported = 3,
    leading_comma = false,
    max_text_width = 80,
    comments = true,
  } = options;

  const kwargs = {
    pretty,
    identify,
    normalize,
    pad,
    indent,
    normalize_functions,
    max_unsupported,
    leading_comma,
    max_text_width,
    comments,
  };
  if (unsupported_level !== null && unsupported_level !== undefined) {
    kwargs.unsupported_level = unsupported_level;
  }
  return kwargs;
}

/** py: sqlglot/generators/athena.py:102 `class _HiveGenerator(HiveGenerator)`. */
class _HiveGenerator extends HiveGenerator {
  /** py:103 */
  alter_sql(expression) {
    if (expression instanceof exp.Alter && expression.args.kind === "TABLE") {
      const actions = expression.args.actions;
      if (actions && actions.length && actions[0] instanceof exp.ColumnDef) {
        const new_actions = new exp.Schema({ expressions: actions });
        expression.set("actions", [new_actions]);
      }
    }

    return super.alter_sql(expression);
  }
}

/** py: sqlglot/generators/athena.py:112 `class AthenaTrinoGenerator(TrinoGenerator)`. */
export class AthenaTrinoGenerator extends TrinoGenerator {
  static PROPERTIES_LOCATION = new Map([
    ...TrinoGenerator.PROPERTIES_LOCATION,
    [exp.LocationProperty, exp.Properties.Location.POST_WITH],
  ]);

  static TRANSFORMS = new Map([
    ...TrinoGenerator.TRANSFORMS,
    [exp.PartitionedByProperty, _partitioned_by_property_sql],
    [exp.LocationProperty, _location_property_sql],
  ]);
}

/**
 * py: sqlglot/generators/athena.py:125 `class AthenaGenerator(generator.Generator)`.
 *
 * `hive`/`trino` constructor options are already-resolved `Dialect` instances (or
 * `null`), the same contract `src/parsers/athena.js`'s `AthenaParser` already uses.
 */
export class AthenaGenerator extends Generator {
  static SELECT_KINDS = [];
  static SUPPORTS_DECODE_CASE = false;

  static AFTER_HAVING_MODIFIER_TRANSFORMS = AFTER_HAVING_MODIFIER_TRANSFORMS;

  /** py:133 `__init__`. */
  constructor(options = {}) {
    const { dialect = null, hive = null, trino = null, ...rest } = options;

    super({ dialect, ...rest });

    const kwargs = _generator_kwargs(rest);
    const hiveDialect = hive || new Hive();
    const trinoDialect = trino || new Trino();

    this._hive_generator = new _HiveGenerator({ dialect: hiveDialect, ...kwargs });
    this._trino_generator = new AthenaTrinoGenerator({ dialect: trinoDialect, ...kwargs });
  }

  /** py:176 */
  generate(expression, copy = true) {
    if (_generate_as_hive(expression)) {
      return this._hive_generator.generate(expression, copy);
    }

    return this._trino_generator.generate(expression, copy);
  }
}
