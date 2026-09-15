// py: sqlglot/optimizer/normalize_identifiers.py @ 91119bc — ONE FUNCTION.
//
// Ported for `src/parser.js`'s own `_implicit_unnests_to_explicit` (py:4317, base
// `Parser`), the first real caller: `parsers/bigquery.js`'s `SUPPORTS_IMPLICIT_UNNEST =
// true` (BigQuery-specific) makes `_parse_query_modifiers` call it for every query with
// a FROM clause, so it was the hard blocker keeping the REAL `BigQuery.parse()` path
// from handling anything past a FROM-less SELECT (PORT_PLAN.md, P5 BigQuery
// dialect+generator round). Nothing else in this port's reach imports this module, so
// only `normalize_identifiers` itself is ported — the rest of the file (there is no
// rest; it is a single function) needs no `@ported-ranges` carve-out.
//
// `store_original_column_identifiers` support is ported in full even though
// `_implicit_unnests_to_explicit` always calls with the default `false`: PORT_PLAN.md's
// established precedent (`normalize_identifier` in `dialects/dialect.js`, R-series) is
// to port the whole function body rather than only the reached branch.
//
// `dialect` MUST already be a resolved `Dialect` INSTANCE — `Dialect.get_or_raise` is
// NOT called here, deliberately. `dialects/dialect.js` transitively imports `parser.js`
// (`parsers/base.js`'s `class BaseParser extends Parser`), so a static import of
// `Dialect` from THIS file would cycle back: `parser.js -> normalize_identifiers.js ->
// dialect.js -> parsers/base.js -> parser.js`. Confirmed live (a `ReferenceError:
// Cannot access 'Parser' before initialization` at `parsers/base.js`'s class
// declaration) before this file settled on the same fix `parser.js`'s own
// `_resolveDialect` (py:277) already uses for the identical shape of problem: require
// an already-resolved object rather than resolving by name. The one real caller,
// `Parser._implicit_unnests_to_explicit`, always passes `this.dialect`, which
// `_resolveDialect` guarantees is an object by the time any dialect-aware parsing runs
// — and `Dialect.get_or_raise` on an already-resolved instance is a pure passthrough
// (`dialect.js:1879` `if (dialect instanceof Dialect) return dialect;`), so this is
// observationally identical to the full upstream signature for that call site.

import * as exp from "../expressions/index.js";
import { parseIdentifier } from "../expressions/builders.js";

/**
 * py: sqlglot/optimizer/normalize_identifiers.py:24 `normalize_identifiers(expression,
 * dialect=None, store_original_column_identifiers=False)`.
 *
 * Normalize identifiers by converting them to either lower or upper case, ensuring the
 * semantics are preserved in each case (e.g. by respecting case-sensitivity).
 *
 * @param {exp.Expr|string} expression
 * @param {{normalize_identifier: Function}} dialect an ALREADY-RESOLVED Dialect instance
 * @param {boolean} [store_original_column_identifiers]
 * @returns {exp.Expr}
 */
export function normalize_identifiers(expression, dialect, store_original_column_identifiers = false) {
  if (!dialect || typeof dialect.normalize_identifier !== "function") {
    throw new TypeError(
      "normalize_identifiers: dialect must already be a resolved Dialect instance — see the file header",
    );
  }

  if (typeof expression === "string") {
    expression = parseIdentifier(expression, dialect);
  }

  // py: `expression.walk(prune=lambda n: bool(n.meta_get("case_sensitive")))` — `walk`'s
  // first positional is `bfs` (default `True`), so the prune callback must be passed in
  // the SECOND slot explicitly here, not the first.
  for (const node of expression.walk(true, (n) => !!n.metaGet("case_sensitive"))) {
    if (node.metaGet("case_sensitive")) continue;

    // A dot chain is recorded once, at its outermost Dot. Ancestors are visited before
    // their descendants, so none of the names it wraps have been normalized yet
    if (
      store_original_column_identifiers
      && (node instanceof exp.Column || node instanceof exp.Dot)
      && !(node.parent instanceof exp.Dot)
    ) {
      if (node instanceof exp.Column) {
        node.meta.dot_parts = node.parts.map((p) => p.name);
      } else if (!node.isStar) {
        let root = node;
        const dot_parts = [];
        while (root instanceof exp.Dot) {
          dot_parts.push(root.expression.name);
          root = root.this;
        }

        dot_parts.reverse();

        // The chain may be rooted at a column (j.k), or at an arbitrary expression (f().k)
        if (root instanceof exp.Column) {
          dot_parts.unshift(...root.parts.map((p) => p.name));
        }

        root.meta.dot_parts = dot_parts;
      }
    }

    if (node instanceof exp.Identifier) {
      dialect.normalize_identifier(node);
    }
  }

  return expression;
}
