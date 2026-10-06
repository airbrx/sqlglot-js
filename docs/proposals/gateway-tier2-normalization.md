# Proposal: tier-2 semantic normalization for `gatewaySqlMetadata.js`

**Status:** draft, for Ben's review. Nothing in this proposal is implemented — this
file describes a design, not a change. AIR-2120 scopes it explicitly as a
proposal: no `airbrx-gateway` file is touched, and `contrib/gatewaySqlMetadata.js`
is not modified here.

## (a) What exists today: tier-1 "structural" normalization

`extractSqlMetadata(sql, options)` (`contrib/gatewaySqlMetadata.js:94`) computes
`standardizedSql`, the field `airbrx-gateway` would use as a cache key instead of
raw `sql`. Today this is **lexical/structural** normalization only — it never
changes what the SQL *means*, only how it's spelled. Three safety invariants, each
load-bearing and each landed as its own PORT_PLAN finding:

1. **Read-safety comes from whole-AST analysis, not from generation success**
   (R64, `PORT_PLAN.md:916`). `statementType`, `isDataChange`/`isDDL`/`isDCL`, and
   the `unsafe` flag are computed by walking every node in the parsed tree
   (`gatewaySqlMetadata.js:151-162`) — a mutation, DDL, DCL, `Command`, `Lock`, or
   session-state-change node *anywhere* in the tree marks the whole statement
   unsafe, independent of whether that tree can also be regenerated to text.
   `isReadOnly = READ_ONLY_TYPES.has(statementType) && !unsafe` (line 161) is set
   before `standardizedSql` is even attempted.
2. **Raw SQL is the fallback cache identity** (R65, `PORT_PLAN.md:920`). The
   regenerate step (`gatewaySqlMetadata.js:173-186`) wraps `d.generate(root, ...)`
   in its own try/catch; on any throw, or if the reparse-and-compare check below
   fails, `extractionError` is set and, only for an already-proven read,
   `standardizedSql` falls back to `fallbackSqlIdentity(sql, root, dialect)` — a
   conservative lexical normalization of the *original* text (comment stripping,
   whitespace collapse), never the regenerated text. An explicit belt-and-braces
   line (`gatewaySqlMetadata.js:189`) forces `standardizedSql = sql` outright if
   `unsafe` somehow coincides with a read-only `statementType`.
3. **Reparse-and-compare structural check** (`gatewaySqlMetadata.js:176-181`):
   `generated` is reparsed in the same dialect and compared against the original
   root with `sameSqlStructure(root, reparsed[0], d)` — a full-argument-tree
   comparison, not a text diff. A generator that silently drops a clause (rather
   than throwing) is caught here, not trusted. Any mismatch is treated the same
   as a generation error: fall back to raw/lexical identity.

None of this touches `sqlglot-js`'s own parser/generator/optimizer behavior —
`contrib/README.md`'s own framing (line ~1 of that file) is "no `py:` anchors, not
part of the port." It is airbrx-specific code built on top of the real port.

## (b) What `optimize()` (R78, `src/optimizer/optimizer.js`) would add

`optimize()` is now real (AIR-2118, landed on `main`) and re-exported from the
package root as of this PR (AIR-2120, part 1). It runs 14 rules in sequence
(`RULES`, `src/optimizer/optimizer.js:117-132`): `qualify`, `pushdown_projections`,
`normalize`, `unnest_subqueries`, `pushdown_predicates`, `optimize_joins`,
`eliminate_subqueries`, `merge_subqueries`, `eliminate_joins`, `eliminate_ctes`,
`quote_identifiers`, `annotate_types`, `canonicalize`, `simplify`.

Ben named exactly two things he wants from a semantic layer: **redundant-predicate
elimination** and **constant folding**. Both are achieved by exactly **one** of the
14 rules, `simplify` (`src/optimizer/simplify.js:89`), run **alone** — verified
directly against this branch's own built `optimize`/`simplify`:

```
simplify(parseOne("SELECT * FROM x WHERE 1 = 1 AND a = 1"))      -> SELECT * FROM x WHERE a = 1
simplify(parseOne("SELECT a FROM x WHERE a = 1 AND a = 1"))       -> SELECT a FROM x WHERE a = 1
simplify(parseOne("SELECT a FROM x WHERE a > 5 OR a > 5"))        -> SELECT a FROM x WHERE a > 5
simplify(parseOne("SELECT a FROM x WHERE 1 + 1 = 2"))             -> SELECT a FROM x
```

Critically, `simplify()` takes **no external schema** (`simplify.js:89-95`) — it
builds its own internal, schema-less `TypeAnnotator` for incremental re-annotation
of changed subtrees (`simplify.js:722`, `ensureSchema(null, {dialect})`) and never
requires the caller to supply column types. It also does not add table aliases or
identifier quoting the way the full `qualify`/`quote_identifiers` rules do — a
direct `simplify()`-only call changes *only* the predicate/expression shape, not
identifier spelling or table references:

```
optimize(sql)            -> SELECT * FROM "x" AS "x" WHERE "x"."a" = 1   (qualify + quote_identifiers ran too)
simplify(parseOne(sql))  -> SELECT * FROM x WHERE a = 1                  (simplify alone)
```

**Recommendation: tier 2 should call `simplify()` directly (or `optimize()` with
`rules: [simplify]`), not the full 14-rule default `RULES`.** The other 13 rules
either require a schema this module doesn't have (`qualify`'s star-expansion and
column resolution — `src/optimizer/qualify.js:93`, `pushdown_projections`,
`unnest_subqueries`, `pushdown_predicates`, `optimize_joins`, `merge_subqueries`,
`eliminate_joins` — all scope-tree rules that need real table/column metadata to be
safe) or change SQL shape in ways that risk cache-identity semantics even though
they're schema-independent (`quote_identifiers` changes identifier spelling;
`canonicalize` rewrites casts/date functions; `annotate_types` alone changes
nothing visible but is a prerequisite several of the above silently assume).
Running the full tuple schema-less (verified above, no `schema` option passed)
still *works* — `qualify`/`quote_identifiers` degrade gracefully rather than
erroring — but adds alias/quoting noise (`AS "x"`, `"x"."a"`) tier 2 doesn't need
and that duplicates work `standardizedSql`'s existing `d.generate()` step already
does more conservatively.

## (c) Risks

- **Cache-identity collisions.** Any normalization that maps two *semantically
  different* queries to the same text is unsafe by definition. `simplify`'s own
  transformations (constant folding, boolean simplification, dedup) are each
  individually sound (they preserve the expression's truth table under standard
  SQL three-valued logic — this is exactly what the upstream `simplify.py` oracle
  differentially verifies against CPython), but the *integration* with this
  module's existing reparse-and-compare check (point (a)3 above) has never been
  exercised with a semilify-rewritten tree as the input to `d.generate()`. The
  existing `sameSqlStructure` check compares the REGENERATED tree against the
  ORIGINAL parsed tree — it would need to compare the SEMANTICALLY NORMALIZED
  tree against the original, which is a structural difference, not a bug, that a
  tier-2 path must account for explicitly (see (d) below).
- **The schema-less constraint is real, not a technicality.** This module never
  calls anything in `src/schema.js`/`MappingSchema` today — it has no table/column
  metadata to pass to `qualify`/`annotate_types` even if it wanted to run them.
  Building that integration (where would a `Schema` instance come from — a new
  airbrx-gateway config surface? introspected from the warehouse?) is a
  substantially larger, separate proposal; this one assumes tier 2 stays
  schema-less and therefore stays `simplify`-only.
- **Generator coverage gaps.** R78's own end-to-end `optimizer.sql` fixture run
  (`PORT_PLAN.md:1010`) found 25 of 83 fixture rows (30%) still hit `NotPorted`
  base-`Generator` stubs after a full `optimize()` pass: `pivot_sql` (14 rows),
  `hint_sql` (3), `dot_sql` (3), `currentdate_sql`/`div_sql`/`querytransform_sql`/
  `kwarg_sql` (1 each) — see `spike/p10/fuzz_optimizer.mjs:70-78`'s
  `KNOWN_GENERATOR_GAPS` for the exact classification. `simplify` alone touches a
  narrower surface (predicates/expressions, not PIVOT/hints/dot-access) so is less
  exposed than the full tuple, but **any** gateway path through this module's
  generator-dependent `standardizedSql` step must keep the existing raw-SQL
  fallback (point (a)2) — a `simplify()`-normalized tree that then fails to
  regenerate is exactly the same class of failure R65 already handles, and the
  design in (d) routes through the *same* fallback rather than a new one.
- **Performance is unmeasured.** `contrib/README.md`'s own "Explicitly out of
  scope" section already flags this: "Hot-path parse performance versus the
  gateway's regex approach — unbenchmarked." `simplify()` additionally builds an
  internal `TypeAnnotator` per call (`simplify.js:722`) and walks the tree looking
  for `Condition`/`FINAL`-marked nodes (`simplify.js:730`) — a real, extra cost per
  query beyond parse+generate, with no existing number for how much. **This
  proposal does not claim a number** and recommends a benchmark harness (ideally
  reusing representative queries from `airbrx-gateway`'s own traffic, run through
  `extractSqlMetadata` with and without the tier-2 step, p50/p99 latency and
  allocation) be built and run *before* any rollout decision, not estimated.
- **Rollout/versioning.** AIR-2163 already established the precedent this needs:
  changing `standardizedSql`'s normalization requires a coordinated gateway
  cache-key engine-version bump so old poisoned keys are not left reachable
  (`contrib/README.md:64`; `PORT_PLAN.md:922`, the e1→e2 bump for the RESTORE
  correction). A tier-2 field is new rollout surface, not a change to the existing
  one — see (d) for why this proposal recommends an *additive* field rather than
  mutating `standardizedSql` directly, specifically to avoid forcing that bump on
  day one.

## (d) Interface sketch

Add an **optional**, feature-flagged `normalizedSql` field alongside the existing
`standardizedSql`, computed only when the caller opts in and only for an
already-proven read (reusing the exact `isReadOnly`/`unsafe` gate at
`gatewaySqlMetadata.js:161`, not a new one):

```js
// contrib/gatewaySqlMetadata.js (sketch — NOT implemented by this PR)
export function extractSqlMetadata(sql, options = {}) {
  const {
    dialect = null,
    parameterValues = null,
    normalize = false, // NEW, default OFF
  } = options;
  // ...unchanged through standardizedSql...

  let normalizedSql = null;
  let normalizationError = null;
  if (normalize && isReadOnly && standardizedSql !== null) {
    try {
      const simplified = simplify(parseOne(standardizedSql, { read: dialect }));
      const regenerated = d.generate(simplified, { pretty: false, comments: false, unsupported_level: ErrorLevel.RAISE });
      const reparsed = d.parse(regenerated).filter(/* same Semicolon filter as above */);
      if (reparsed.length === 1 && sameSqlStructure(root, reparsed[0], d) /* or a semantic-equivalence check, see below */) {
        normalizedSql = regenerated;
      } else {
        normalizationError = "normalizedSql generation failed: structural mismatch after simplify";
      }
    } catch (err) {
      normalizationError = `normalizedSql generation failed: ${describeError(err)}`;
    }
  }
  return { /* ...existing fields..., */ normalizedSql, normalizationError };
}
```

Key design choices, each a decision point in (e):

- **Additive, not a replacement.** `standardizedSql` keeps its current meaning and
  safety guarantees untouched; `normalizedSql` is `null` unless a caller explicitly
  asks for it. A consumer that doesn't opt in sees no behavior change at all —
  no new rollout risk for existing callers.
- **Gated on the existing `isReadOnly` check**, not a new one — tier 2 can only
  ever run on something already proven safe to cache by (a)'s existing analysis.
  It is strictly a refinement of the cache *key*, never a relaxation of the cache
  *eligibility* decision.
- **The reparse-and-compare check needs a real decision, not just reuse.**
  `sameSqlStructure` as it exists today asserts structural *equality* — exactly
  right for (a)'s generation step, where the generated tree is supposed to be
  identical to the parsed one. After `simplify()`, the trees are supposed to
  DIFFER (that's the point) but remain semantically equivalent. Either a new
  comparator is needed (re-run `simplify()` on the reparsed tree too and compare
  `.equals()` *that*, canceling out simplification as a source of divergence), or
  this check is dropped in favor of trusting `simplify`'s own oracle-verified
  soundness plus the regenerate-without-throwing signal alone. This proposal does
  not pick one — see decision point 4.

## (e) Decision points for Ben

1. **Scope the RULES subset to `simplify` only (not the full default `RULES`
   tuple) for this tier-2 path, given the schema-less constraint in (b)?**
   Yes / No.
2. **Require a benchmark harness (built and run, not estimated) showing
   acceptable p50/p99 latency overhead before any tier-2 code lands, rather than
   shipping it and measuring in production?** Yes / No.
3. **Ship `normalizedSql` as an additive, default-off field alongside
   `standardizedSql` (per the sketch in (d)), rather than changing
   `standardizedSql`'s own normalization in place?** Yes / No.
4. **For the post-simplify structural check, re-simplify the reparsed tree and
   compare THAT (canceling out simplification as a source of divergence), rather
   than dropping the structural check and trusting `simplify`'s own
   differential-test soundness alone?** Yes / No.
5. **Require a cache-key engine-version bump (same e1→e2 precedent as AIR-2163)
   before any tier-2-normalized key is allowed to reach a real cache, even in
   shadow mode?** Yes / No.
6. **Run tier 2 in shadow mode first (compute `normalizedSql`, log/compare, but
   never use it as an actual cache key) for some bake-in period before promoting
   it to a real key?** Yes / No.
7. **Authorize a follow-up session to build the benchmark harness and/or the
   shadow-mode wiring described above — still entirely within `contrib/` and
   `test/`, still not touching `airbrx-gateway` — once this proposal is
   approved?** Yes / No.
