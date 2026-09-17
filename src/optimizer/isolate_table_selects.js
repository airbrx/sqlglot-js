// py: sqlglot/optimizer/isolate_table_selects.py @ 91119bc — WHOLE FILE (50 LOC).
//
// Genuinely greenfield, the same shape `qualify_tables.js` (this issue's sibling file)
// and `schema.js` (R41) already established: nothing in this port calls
// `isolate_table_selects` yet (the `qualify()` orchestrator wiring both together is
// AIR-2108, a separate follow-up issue).
//
// Both named dependencies are real: `traverse_scope` (`./scope.js`, landed R44/R46) and
// `Schema`/`ensure_schema` (`../schema.js`, landed R41) — no new base-layer surface
// needed. `alias` is the public re-export of `expressions/core.js`'s `alias_` (upstream:
// `sqlglot/__init__.py`'s `from sqlglot.expressions import alias_ as alias`), already
// exported from this port's `exp` namespace as `alias_` (no separate `alias` binding
// exists here, matching how this repo's `optimize_joins.js` already imports `exp.and_`
// rather than a bare `and` it could never bind either).
//
// Python's bare `assert source.parent` is ported via the new `PyAssertionError`
// (`_py/errors.js`) rather than silently dropped or turned into a `throw new Error` --
// this is a genuine `AssertionError` upstream (Python only strips `assert` under `-O`,
// which this port's own CPython oracle never runs with), so a JS caller that somehow
// hits it should see the same exception CLASS, per this file's own §4.6 standing rule.

import * as exp from "../expressions/index.js";
import { OptimizeError } from "../errors.js";
import { PyAssertionError } from "../_py/errors.js";
import { traverseScope } from "./scope.js";
import { ensureSchema } from "../schema.js";

/**
 * py: isolate_table_selects.py:16 `isolate_table_selects(expression, schema=None,
 * dialect=None)`.
 *
 * @param {exp.Expr} expression
 * @param {{schema?: *, dialect?: *}} [options]
 * @returns {exp.Expr}
 */
export function isolate_table_selects(expression, options = {}) {
  const schema = ensureSchema(options.schema ?? null, { dialect: options.dialect ?? null });

  for (const scope of traverseScope(expression)) {
    if (scope.selectedSources.size === 1) continue;

    for (const [, source] of scope.selectedSources.values()) {
      if (!source.parent) throw new PyAssertionError("source.parent");

      if (
        !(source instanceof exp.Table)
        || !schema.columnNames(source).length
        || source.parent instanceof exp.Subquery
        || source.parent.parent instanceof exp.Table
      ) {
        continue;
      }

      if (!source.alias) {
        throw new OptimizeError("Tables require an alias. Run qualify_tables optimization.");
      }

      source.replace(
        exp.select("*")
          .from_(exp.alias_(source, source.aliasOrName, { table: true }), { copy: false })
          .subquery(source.alias, { copy: false }),
      );
    }
  }

  return expression;
}
