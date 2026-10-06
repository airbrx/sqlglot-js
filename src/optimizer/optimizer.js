// py: sqlglot/optimizer/optimizer.py @ 91119bc — WHOLE FILE (114 LOC).
//
// AIR-2118 (epic AIR-2091, "8.1 optimizer.js — RULES tuple + optimize() entry
// point"). The end-to-end wiring: imports all fourteen already-ported optimizer rules
// and composes them in upstream's exact order through a single `optimize()` entry
// point. Every rule below was independently verified real (not a stub, not silently
// wrong) by its own prior differential oracle before this file was written — this
// file's own job, and its own oracle's job, is the COMPOSITION, run together for the
// first time under this exact kwarg surface, not any one rule's own logic.
//
// `OptimizerFn` (py:25-35, a `typing.Protocol`) is a type-only annotation with no JS
// analogue and is dropped, matching every other ported file's treatment of
// `TypeVar`/`Protocol`/`TYPE_CHECKING` imports.
//
// KWARG INJECTION — the one real design decision this file has to make, and the
// reason it isn't a 20-minute transliteration:
//
// Upstream's `optimize()` (py:88-96) builds one `possible_kwargs` dict, then for EACH
// rule asks `inspect.getfullargspec(rule).args` for that rule's OWN parameter names
// and forwards only the subset also present in `possible_kwargs`:
//
//     rule_params = inspect.getfullargspec(rule).args
//     rule_kwargs = {p: possible_kwargs[p] for p in rule_params if p in possible_kwargs}
//     optimized = rule(optimized, **rule_kwargs)
//
// JS has no runtime parameter-name introspection — a function's declared parameter
// names (let alone the keys destructured out of an `options = {}` object two levels
// in) are erased at the language level and cannot be recovered by reflection. So
// instead of trying to simulate `inspect.getfullargspec` generically, each of the 14
// rules below gets a HAND-WRITTEN adapter (`ADAPTERS`, keyed by the imported function
// reference itself) that reproduces upstream's own subset-selection in effect: each
// adapter reads exactly the possible_kwargs fields that rule's REAL upstream
// signature names (verified against the pinned CPython source via
// `ast.parse`+`FunctionDef.args`, not assumed), and forwards them to whatever calling
// convention this port's OWN version of that rule actually uses — which, unlike
// upstream's flat per-rule **kwargs, is split three ways across the 14 files:
//
//   - positional, upstream-matching (`pushdown_predicates`, `merge_subqueries`,
//     `eliminate_ctes`, `quote_identifiers`, `normalize`'s `dnf`/`max_distance`,
//     `pushdown_projections`'s own `schema` as its 2nd positional)
//   - an `{options}` object with CAMELCASE keys (`qualify`, `annotate_types`,
//     `canonicalize`, and `pushdown_projections`'s remaining options)
//   - an `{options}` object with SNAKE_CASE keys (`simplify` — an inconsistency
//     already present in that file, not introduced or "fixed" here)
//
// Passing `undefined` for a key `possibleKwargs` never set is equivalent to omitting
// that argument entirely, for BOTH a bare default parameter (`function f(a = x)`) and
// a default-destructured object field (`const {a = x} = opts`) — JS's default-value
// mechanism triggers on `undefined` regardless of position — so every adapter can
// read straight off `k.<python_name>` even for keys that were never present in
// `possibleKwargs`, with no extra "was this key provided" branching needed.
//
// A caller-supplied `rules` override containing a function OTHER than one of these 14
// (upstream itself does this in `test_merge_subqueries`/`test_canonicalize`, overriding
// with `qualify_tables`/`qualify_columns`/`quote_identifiers`/`annotate_types`/
// `canonicalize` directly) falls through `ADAPTERS.get(rule)` to a NO-KWARGS call,
// `rule(optimized)` — a real, documented limitation, not a silent bug: closing it
// would require either a second hand-written adapter per override (unbounded, since
// upstream lets ANY function through) or genuine reflection (which JS does not have).
// This round's own oracle never exercises a `rules` override — AIR-2118's brief scopes
// this file to the RULES tuple + optimize() entry point itself, not the broader
// tpc-h/tpc-ds corpus (AIR-2119) or package/gateway wiring (AIR-2120) — so closing the
// override case is left to whichever follow-up actually needs it.
//
// A second, deliberate deviation from upstream: an unrecognized top-level `**kwargs`
// entry (one that matches NO rule's real parameter name) is upstream's own silent
// no-op — `rule_kwargs` just never picks it up, for any rule, and the caller's typo
// vanishes without a trace. This port raises instead (`validateKwargs` below), so a
// typo is loud, not silent — an explicit improvement over upstream's own behavior
// here, not a faithfulness gap.
//
// IMPORT-CYCLE CHECK (this file's own stated hazard): this file imports
// `annotate_types.js` (which imports `dialects/dialect.js` directly) AND
// `canonicalize.js` (which deliberately does NOT import `dialect.js`/
// `annotate_types.js` directly, instead reaching both through `tokens.js`'s injected-
// resolver relay, because CANONICALIZE.JS ITSELF is reachable FROM `dialect.js` via
// `generator.js` -> `transforms.js` -> `ensure_bools`, R76). `optimizer.js` has no such
// incoming edge — nothing under `dialects/`, `generator.js`, `generator_kernel.js`,
// `transforms.js`, `parser.js`, or `tokens.js` imports anything under `optimizer/`
// named `optimizer.js`, so this file cannot be reached from any of its own
// dependencies and therefore cannot close a new cycle merely by importing all 14 rule
// modules directly — confirmed empirically below, not just argued: `node --check` on
// this file, plus `node -e "import('../../index.js')"` and
// `node -e "import('./optimizer.js')"` run as two independent standalone ESM entry
// points (see PORT_PLAN.md's own R-entry for this round for the literal commands and
// output).
//
// @ported-ranges sqlglot/optimizer/optimizer.py 1-114

import { maybeParse } from "../expressions/core.js";
import { ensureSchema } from "../schema.js";
import { PyValueError } from "../errors.js";

import { qualify } from "./qualify.js";
import { pushdown_projections } from "./pushdown_projections.js";
import { normalize } from "./normalize.js";
import { unnest_subqueries } from "./unnest_subqueries.js";
import { pushdown_predicates } from "./pushdown_predicates.js";
import { optimize_joins } from "./optimize_joins.js";
import { eliminate_subqueries } from "./eliminate_subqueries.js";
import { merge_subqueries } from "./merge_subqueries.js";
import { eliminate_joins } from "./eliminate_joins.js";
import { eliminate_ctes } from "./eliminate_ctes.js";
import { quote_identifiers } from "./qualify_columns.js";
import { annotate_types } from "./annotate_types.js";
import { canonicalize } from "./canonicalize.js";
import { simplify } from "./simplify.js";

/**
 * py: optimizer.py:38-52 `RULES: tuple[OptimizerFn, ...]`.
 *
 * The default rule sequence `optimize()` runs, in upstream's exact order. A plain
 * array, not a frozen/immutable tuple — nothing in this port mutates it, matching
 * every other upstream `tuple`-typed constant already ported as a bare JS array
 * (e.g. `COERCIBLE_DATE_OPS` in `canonicalize.js`).
 */
export const RULES = [
  qualify,
  pushdown_projections,
  normalize,
  unnest_subqueries,
  pushdown_predicates,
  optimize_joins,
  eliminate_subqueries,
  merge_subqueries,
  eliminate_joins,
  eliminate_ctes,
  quote_identifiers,
  annotate_types,
  canonicalize,
  simplify,
];

// See this file's own header ("KWARG INJECTION") for why this hand-written table
// exists instead of generic reflection, and exactly what each entry verifies against.
const ADAPTERS = new Map([
  // py: qualify.py:19 `qualify(expression, dialect, db, catalog, schema,
  // expand_alias_refs, expand_stars, infer_schema, isolate_tables, qualify_columns,
  // allow_partial_qualification, validate_qualify_columns, quote_identifiers,
  // identify, canonicalize_table_aliases, on_qualify, sql)`.
  [qualify, (expression, k) => qualify(expression, {
    dialect: k.dialect,
    db: k.db,
    catalog: k.catalog,
    schema: k.schema,
    expandAliasRefs: k.expand_alias_refs,
    expandStars: k.expand_stars,
    inferSchema: k.infer_schema,
    isolateTables: k.isolate_tables,
    qualifyColumns: k.qualify_columns,
    allowPartialQualification: k.allow_partial_qualification,
    validateQualifyColumns: k.validate_qualify_columns,
    quoteIdentifiers: k.quote_identifiers,
    identify: k.identify,
    canonicalizeTableAliases: k.canonicalize_table_aliases,
    onQualify: k.on_qualify,
    sql: k.sql,
  })],

  // py: pushdown_projections.py:15 `pushdown_projections(expression, schema,
  // remove_unused_selections, dialect, journal)`. `schema` is this port's own 2nd
  // POSITIONAL argument (not part of its `{options}`), matching upstream's own
  // parameter ORDER even though upstream's version is keyword-capable too.
  [pushdown_projections, (expression, k) => pushdown_projections(expression, k.schema, {
    removeUnusedSelections: k.remove_unused_selections,
    dialect: k.dialect,
    journal: k.journal,
  })],

  // py: normalize.py:14 `normalize(expression, dnf, max_distance)` — both positional.
  [normalize, (expression, k) => normalize(expression, k.dnf, k.max_distance)],

  // py: unnest_subqueries.py:8 `unnest_subqueries(expression)` — no extra params.
  [unnest_subqueries, (expression) => unnest_subqueries(expression)],

  // py: pushdown_predicates.py:19 `pushdown_predicates(expression, dialect)`.
  [pushdown_predicates, (expression, k) => pushdown_predicates(expression, k.dialect)],

  // py: optimize_joins.py:9 `optimize_joins(expression)` — no extra params.
  [optimize_joins, (expression) => optimize_joins(expression)],

  // py: eliminate_subqueries.py:16 `eliminate_subqueries(expression)` — no extra params.
  [eliminate_subqueries, (expression) => eliminate_subqueries(expression)],

  // py: merge_subqueries.py:15 `merge_subqueries(expression, leave_tables_isolated)`.
  [merge_subqueries, (expression, k) => merge_subqueries(expression, k.leave_tables_isolated)],

  // py: eliminate_joins.py:13 `eliminate_joins(expression)` — no extra params.
  [eliminate_joins, (expression) => eliminate_joins(expression)],

  // py: eliminate_ctes.py:10 `eliminate_ctes(expression, journal)`.
  [eliminate_ctes, (expression, k) => eliminate_ctes(expression, k.journal)],

  // py: qualify_columns.py:1288 `quote_identifiers(expression, dialect, identify)`.
  // NOT the same logical key as `possibleKwargs.quote_identifiers` (that key is only
  // ever consumed by `qualify`'s own same-named parameter, to suppress its internal
  // quoting since this standalone rule runs the step instead — see `qualify`'s own
  // adapter above and `possibleKwargs`'s own comment below).
  [quote_identifiers, (expression, k) => quote_identifiers(expression, k.dialect, k.identify)],

  // py: annotate_types.py:365 `annotate_types(expression, schema, expression_metadata,
  // coerces_to, dialect, overwrite_types)`.
  [annotate_types, (expression, k) => annotate_types(expression, {
    schema: k.schema,
    expressionMetadata: k.expression_metadata,
    coercesTo: k.coerces_to,
    dialect: k.dialect,
    overwriteTypes: k.overwrite_types,
  })],

  // py: canonicalize.py:20 `canonicalize(expression, dialect)`.
  [canonicalize, (expression, k) => canonicalize(expression, { dialect: k.dialect })],

  // py: simplify.py:44 `simplify(expression, constant_propagation,
  // coalesce_simplification, dialect)`. `simplify.js`'s own `{options}` keys are
  // snake_case (an existing inconsistency in that file, not introduced here).
  [simplify, (expression, k) => simplify(expression, {
    constant_propagation: k.constant_propagation,
    coalesce_simplification: k.coalesce_simplification,
    dialect: k.dialect,
  })],
]);

// Union of every logical (upstream Python) kwarg name any of the 14 `ADAPTERS` entries
// reads, PLUS the seven keys `optimize()` itself always seeds into `possibleKwargs`
// below. Used only by `validateKwargs` — see this file's own header ("a second,
// deliberate deviation from upstream") for why an unrecognized entry raises here
// instead of silently vanishing the way upstream's own per-rule subset-selection would.
const KNOWN_RULE_KWARGS = new Set([
  "dialect", "db", "catalog", "schema", "sql",
  "expand_alias_refs", "expand_stars", "infer_schema", "isolate_tables",
  "qualify_columns", "allow_partial_qualification", "validate_qualify_columns",
  "quote_identifiers", "identify", "canonicalize_table_aliases", "on_qualify",
  "remove_unused_selections", "journal",
  "dnf", "max_distance",
  "leave_tables_isolated",
  "expression_metadata", "coerces_to", "overwrite_types",
  "constant_propagation", "coalesce_simplification",
]);

function validateKwargs(kwargs) {
  for (const key of Object.keys(kwargs)) {
    if (!KNOWN_RULE_KWARGS.has(key)) {
      throw new PyValueError(
        `optimize(): unknown rule kwarg ${JSON.stringify(key)} -- no rule in RULES ` +
        "declares a parameter of this name, so it would never reach any rule. " +
        "(Upstream sqlglot silently drops an unrecognized **kwargs entry here; this " +
        "port raises instead, so a typo is loud rather than silently doing nothing.)",
      );
    }
  }
}

/**
 * py: optimizer.py:51 `optimize(expression, schema=None, db=None, catalog=None,
 * dialect=None, rules=RULES, sql=None, **kwargs)`.
 *
 * Rewrite a sqlglot AST into an optimized form.
 *
 * @param {string|import("../expressions/core.js").Expr} expression Expression to optimize.
 * @param {{
 *   schema?: *,
 *   db?: string|null,
 *   catalog?: string|null,
 *   dialect?: *,
 *   rules?: Function[],
 *   sql?: string|null,
 *   [kwarg: string]: *,
 * }} [options] `db`/`catalog`/`dialect`/`sql`, plus any OTHER kwarg a rule in `rules`
 *   declares by name (see `KNOWN_RULE_KWARGS` above for the full set this port
 *   recognizes), are threaded through to every rule whose own real parameter list
 *   names that same key — exactly matching upstream's own `**kwargs` fan-out.
 * @returns {import("../expressions/core.js").Expr} The optimized expression.
 */
export function optimize(expression, options = {}) {
  const {
    schema: schemaOption = null,
    db = null,
    catalog = null,
    dialect = null,
    rules = RULES,
    sql = null,
    ...kwargs
  } = options;

  validateKwargs(kwargs);

  // py:103 `schema = ensure_schema(schema, dialect=dialect)`.
  const schema = ensureSchema(schemaOption, { dialect });

  // py:104-112 `possible_kwargs`. `isolate_tables`/`quote_identifiers` are forced to
  // `true`/`false` here UNCONDITIONALLY, same as upstream's own dict literal --
  // `**kwargs` (spread last, below) can still override either, matching upstream's
  // own dict-literal-then-`**kwargs` precedence exactly.
  const possibleKwargs = {
    db,
    catalog,
    schema,
    dialect,
    sql,
    isolate_tables: true,
    quote_identifiers: false,
    ...kwargs,
  };

  // py:115 `optimized = exp.maybe_parse(expression, dialect=dialect, copy=True)`.
  let optimized = maybeParse(expression, { dialect, copy: true });

  // py:116-122 the rule loop. See this file's own header for `ADAPTERS`'s role in
  // place of `inspect.getfullargspec`, and the documented fallback for a rule that
  // isn't one of the 14 known entries.
  for (const rule of rules) {
    const adapter = ADAPTERS.get(rule);
    optimized = adapter ? adapter(optimized, possibleKwargs) : rule(optimized);
  }

  return optimized;
}
