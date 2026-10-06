// py: sqlglot/optimizer/qualify.py @ 91119bc — WHOLE FILE (113 LOC, one function).
//
// AIR-2108 (epic AIR-2087, "4.5 qualify.js orchestrator + end-to-end qualify()
// oracle") — the LAST issue in the epic. Wires together, in upstream's exact order
// and with upstream's exact keyword-argument surface, every optimizer step this port
// has already landed: `normalize_identifiers` (`./normalize_identifiers.js`, R42),
// `qualify_tables` + `isolate_table_selects` (`./qualify_tables.js` /
// `./isolate_table_selects.js`, R47), `qualify_columns` (`./qualify_columns.js`,
// R67), and `quote_identifiers` + `validate_qualify_columns` (same file, R73). Every
// one of those five functions already has its own passing differential oracle in
// ISOLATION, but nothing in this port had ever run their COMPOSITION under this
// exact kwarg surface before this file existed — that composition, not any one
// step's own correctness, is this file's whole reason to exist.
//
// All five dependencies verified real against the CURRENT source, not assumed:
//   - `normalize_identifiers(expression, dialect, store_original_column_identifiers)`
//     requires an ALREADY-RESOLVED `Dialect` INSTANCE as its second (positional, not
//     options-object) argument — its own header documents why (a `parser.js` import
//     cycle this file does not have). `Dialect.get_or_raise` is therefore called
//     exactly once here, matching upstream's own qualify.py:78
//     `dialect = Dialect.get_or_raise(dialect)`, and the resolved instance is reused
//     for every downstream call.
//   - `qualify_tables(expression, {db, catalog, onQualify, dialect,
//     canonicalizeTableAliases})` and `isolate_table_selects(expression, {schema,
//     dialect})` each take a plain options object.
//   - `qualify_columns(expression, schema, {expandAliasRefs, expandStars,
//     inferSchema, allowPartialQualification})` — note upstream's own qualify.py:97-105
//     call site does NOT pass a `dialect=` kwarg here; `qualify_columns` derives its
//     dialect from the SCHEMA object instead (`resolvedSchema.dialect || new
//     Dialect()`), which is already correct because `schema` was built via
//     `ensure_schema(schema, dialect=dialect)` (py:77) before `dialect` itself was
//     reassigned to the resolved instance on the very next line — ported verbatim
//     below, in that exact order, not "simplified" by passing the resolved dialect
//     into both calls.
//   - `quote_identifiers(expression, dialect, identify)` and
//     `validate_qualify_columns(expression, sql)` are positional, matching upstream's
//     own two-and-one-positional-argument shape.
//
// `on_qualify` is NOT invoked by this file directly — it threads straight through to
// `qualify_tables`'s own `onQualify` option (its only call site,
// `qualify_tables.js:247`), exactly as upstream's qualify.py:90 passes it through
// unchanged to `qualify_tables`'s own `on_qualify` parameter.
//
// @ported-ranges sqlglot/optimizer/qualify.py 19-113

import { Dialect } from "../dialects/dialect.js";
import { ensureSchema } from "../schema.js";
import { normalize_identifiers } from "./normalize_identifiers.js";
import { qualify_tables } from "./qualify_tables.js";
import { isolate_table_selects } from "./isolate_table_selects.js";
import {
  qualify_columns as qualify_columns_func,
  quote_identifiers as quote_identifiers_func,
  validate_qualify_columns as validate_qualify_columns_func,
} from "./qualify_columns.js";

/**
 * py: qualify.py:19 `qualify(expression, dialect=None, db=None, catalog=None,
 * schema=None, expand_alias_refs=True, expand_stars=True, infer_schema=None,
 * isolate_tables=False, qualify_columns=True, allow_partial_qualification=False,
 * validate_qualify_columns=True, quote_identifiers=True, identify=True,
 * canonicalize_table_aliases=False, on_qualify=None, sql=None)`.
 *
 * Rewrite sqlglot AST to have normalized and qualified tables and columns.
 *
 * This step is necessary for all further SQLGlot optimizations.
 *
 * Example:
 *   qualify(parseOne("SELECT col FROM tbl"), { schema: { tbl: { col: "INT" } } }).sql()
 *   -> `SELECT "tbl"."col" AS "col" FROM "tbl" AS "tbl"`
 *
 * @param {exp.Expr} expression Expr to qualify.
 * @param {{
 *   dialect?: *,
 *   db?: string|null,
 *   catalog?: string|null,
 *   schema?: *,
 *   expandAliasRefs?: boolean,
 *   expandStars?: boolean,
 *   inferSchema?: boolean|null,
 *   isolateTables?: boolean,
 *   qualifyColumns?: boolean,
 *   allowPartialQualification?: boolean,
 *   validateQualifyColumns?: boolean,
 *   quoteIdentifiers?: boolean,
 *   identify?: boolean,
 *   canonicalizeTableAliases?: boolean,
 *   onQualify?: ((table: exp.Table) => void)|null,
 *   sql?: string|null,
 * }} [options]
 * @returns {exp.Expr} The qualified expression.
 */
export function qualify(expression, options = {}) {
  const {
    dialect: dialectOption = null,
    db = null,
    catalog = null,
    schema: schemaOption = null,
    expandAliasRefs = true,
    expandStars = true,
    inferSchema = null,
    isolateTables = false,
    qualifyColumns = true,
    allowPartialQualification = false,
    validateQualifyColumns = true,
    quoteIdentifiers = true,
    identify = true,
    canonicalizeTableAliases = false,
    onQualify = null,
    sql = null,
  } = options;

  const schema = ensureSchema(schemaOption, { dialect: dialectOption });
  const dialect = Dialect.get_or_raise(dialectOption);

  let result = normalize_identifiers(expression, dialect, true);
  result = qualify_tables(result, {
    db,
    catalog,
    dialect,
    onQualify,
    canonicalizeTableAliases,
  });

  if (isolateTables) {
    result = isolate_table_selects(result, { schema });
  }

  if (qualifyColumns) {
    result = qualify_columns_func(result, schema, {
      expandAliasRefs,
      expandStars,
      inferSchema,
      allowPartialQualification,
    });
  }

  if (quoteIdentifiers) {
    result = quote_identifiers_func(result, dialect, identify);
  }

  if (validateQualifyColumns) {
    validate_qualify_columns_func(result, sql);
  }

  return result;
}
