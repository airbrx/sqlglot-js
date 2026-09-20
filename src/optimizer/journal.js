// py: sqlglot/optimizer/journal.py @ 91119bc — WHOLE FILE (32 LOC).
//
// A tiny mutation-rollback utility: a `Journal` is a list of `(node, arg_key,
// old_value)` tuples recording an argument's value BEFORE it is mutated, so a caller
// (`eliminate_ctes.js`, this issue's sibling file) can restore the tree exactly. The
// upstream `JournalEntry`/`Journal`/`ExistingCTEsMapping`-style type aliases and the
// `exp.Expr` import that backs them are type-only and have no JS analogue, matching how
// every other ported file in this repo drops upstream's type-only imports
// (`optimize_joins.js`'s header makes the same call for `_typing.E`).
//
// Genuinely greenfield, the same shape `schema.js`/`optimize_joins.js` already
// established: nothing in this port calls `record`/`revert` yet outside this issue's own
// `eliminate_ctes.js`.

/**
 * py: journal.py:12 `record(journal, node, arg_key)`.
 *
 * Records the current value of `node.args[arg_key]` so `revert` can restore it. Must be
 * called BEFORE the argument is mutated. List values are copied shallowly, so the
 * caller may freely mutate or replace the list afterwards.
 */
export function record(journal, node, argKey) {
  const value = node.args[argKey];
  journal.push([node, argKey, Array.isArray(value) ? [...value] : value]);
}

/**
 * py: journal.py:22 `revert(journal)`.
 *
 * Restores every recorded argument, newest first, and empties the journal. `set`
 * reattaches the restored expressions (their `parent`, `arg_key` and `index`), so rules
 * that only detach or reorder nodes leave the tree exactly as it was before they ran.
 * Rules that replace nodes with new ones can't be reverted this way.
 */
export function revert(journal) {
  for (let i = journal.length - 1; i >= 0; i--) {
    const [node, argKey, value] = journal[i];
    node.set(argKey, value);
  }
  journal.length = 0;
}
