#!/usr/bin/env bash
# Reproduce the whole P0 go/no-go spike from scratch.
# PORT_PLAN.md §7 P0 item 1.
#
#   bash spike/run_all.sh
#
# Exits non-zero if any probe diverges from CPython.
set -uo pipefail
export PYTHONHASHSEED=0
cd "$(dirname "$0")/.."

mkdir -p spike/out
fail=0
# Prints an explicit marker on failure. Without it a red probe is invisible in the
# transcript unless it happens to print the word FAIL itself, and the only signal is the
# summary line at the very bottom — which says SOMETHING failed, not what.
failed_probes=()
run() {
  local name="$1"
  echo
  echo "===== $name ====="
  shift
  if "$@"; then
    return 0
  else
    local rc=$?
  fi
  echo "  >>> PROBE FAILED (exit $rc): $name"
  failed_probes+=("$name")
  fail=1
}

echo "toolchain:"
echo "  $(python3 --version 2>&1)"
echo "  node $(node --version)"

echo
echo "--- generating corpora (CPython is the oracle) ---"
python3 spike/py/gen_num_cases.py     > spike/out/num_cases.jsonl   || fail=1
python3 spike/py/gen_unicode_ref.py   > spike/out/unicode_ref.json  || fail=1
python3 spike/py/gen_str_cases.py     > spike/out/str_cases.jsonl   || fail=1
node tools/gen_unicode_tables.mjs                                   || fail=1
node tools/gen_timezones.mjs /tmp/sqlglot-ref                       || fail=1
python3 spike/py/gen_calib_cases.py   > spike/out/calib.jsonl       || fail=1
python3 spike/py/gen_builtins_cases.py > spike/out/builtins.jsonl   || fail=1
python3 spike/py/gen_toowide_comments.py > spike/out/toowide_comments.jsonl || fail=1
python3 spike/py/gen_tokens_cases.py   > spike/out/tokens_fuzz.jsonl || fail=1
python3 spike/py/gen_depth_ref.py      > spike/out/depth_py.json   || fail=1
# P3 oracles. Each is CPython evaluating the same probe the JS side runs, so a
# divergence is a byte diff rather than an argument (PORT_PLAN.md §8.3).
python3 spike/p3/gen_from_arg_list_ref.py    > spike/out/from_arg_list.jsonl    || fail=1
python3 spike/p3/gen_walk_in_scope_ref.py    > spike/out/walk_in_scope.jsonl    || fail=1
python3 spike/p3/gen_generator_kernel_ref.py > spike/out/generator_kernel.jsonl || fail=1
python3 spike/p3/gen_parse_path_sql_ref.py   > spike/out/parse_path_sql.jsonl   || fail=1
python3 spike/p3/gen_raise_error_ref.py      > spike/out/raise_error.jsonl      || fail=1
python3 spike/p3/gen_command_warning_ref.py  > spike/out/command_warnings.jsonl || fail=1
python3 spike/p4/gen_gateway_regressions_ref.py > spike/out/gateway_regressions.json || fail=1
run "AIR-2163: parser and key regression oracle" node spike/p4/fuzz_gateway_regressions.mjs
python3 spike/p4/gen_neg_ref.py > spike/out/neg.json || fail=1
python3 spike/p4/gen_generator_base_ref.py   > spike/out/generator_base.json    || fail=1
python3 spike/p4/gen_transforms_ref.py       > spike/out/transforms.json        || fail=1
# P4 oracle. identifier_sql over the full (name x normalize x identify x quoted x pretty)
# space -- PYTHONHASHSEED pinned like every other oracle here, since the reference reads
# Generator settings whose iteration order is observable.
PYTHONHASHSEED=0 python3 spike/p4/gen_identifier_sql_ref.py > spike/out/identifier_sql_ref.json || fail=1
# P5 oracle. The base `Dialect` class's 105 settings, the four classes the metaclass
# autofills, 17 `get_or_raise` grammar cases and 187 method cases, straight out of
# CPython -- six of the settings are DERIVED by the metaclass, so reading the upstream
# class body gives the wrong answer for all six.
PYTHONHASHSEED=0 python3 spike/p5/gen_dialect_ref.py > spike/out/dialect_defaults.json || fail=1
# P5 oracle, one class down. `dialects/snowflake.py` is almost entirely hand-transcribed
# class-level VALUES -- R21's hazard class exactly -- so its 105 resolved settings, its
# nested Tokenizer (declared AND `__init_subclass__`-derived), and `can_quote`'s DUAL
# exception are diffed against CPython rather than eyeballed against the upstream file.
PYTHONHASHSEED=0 python3 spike/p5/gen_snowflake_dialect_ref.py > spike/out/snowflake_dialect.json || fail=1
# P5 oracle, same shape one dialect over. `dialects/duckdb.py` is 105 resolved settings,
# a nested Tokenizer with heredoc/byte-string support Snowflake's doesn't have, and one
# method override (`to_json_path`) that is genuinely PARTIAL -- real logic for its
# JSON-pointer/back-of-list fast paths, an honest NotPorted fallthrough for everything
# else (gated on the unported `sqlglot/jsonpath.py`) -- so the oracle asserts the split
# explicitly rather than treating either half as the whole answer.
PYTHONHASHSEED=0 python3 spike/p5/gen_duckdb_dialect_ref.py > spike/out/duckdb_dialect.json || fail=1
# P6 oracle. `schema.py`'s `MappingSchema` is greenfield -- nothing in the port depends
# on it yet, so unlike every oracle above it has no corpus/atoms.jsonl tie-in at all.
# 24 scenarios / 53 checks of column/type lookups, add_table, dialect-aware identifier
# normalization (base/snowflake/duckdb), UDF resolution, and the trie's ambiguous-prefix
# path, straight out of CPython.
PYTHONHASHSEED=0 python3 spike/p6/gen_schema_ref.py > spike/out/schema.json || fail=1
# P7 oracle. `scope.py`'s `Scope` class CORE surface (AIR-2093) -- constructor, `branch`,
# `_collect`, every lazily-computed property/method -- plus the module-level scope-TREE
# builders `traverse_scope`/`build_scope` (AIR-2094). Both this oracle and
# `spike/p7/fuzz_scope.mjs` call the REAL builder on their own side now, over an 11-scenario
# corpus (nested CTEs, a derived table with its own CTE, a 3-way UNION, a 2-level
# correlated subquery, a recursive CTE, and both UNNEST/LATERAL UDTF-join shapes) -- see
# `gen_scope_ref.py`'s own header, and for the `.sql()`-text node-comparison choice it
# shares with `spike/p3/gen_walk_in_scope_ref.py`.
PYTHONHASHSEED=0 python3 spike/p7/gen_scope_ref.py > spike/out/scope.json || fail=1
# P7 oracle. `optimizer/optimize_joins.py` is greenfield and has zero dependency on any
# other unported optimizer module -- same "no corpus/atoms.jsonl tie-in" shape as
# schema.js and transforms.py, so this is the only differential signal on it: parse +
# optimize_joins + dump `.sql()`, against CPython doing the same, over 26 hand-picked
# scenarios (cross-join promotion, the ANTI-join skip, side-bearing joins blocking
# reordering, comma joins, JOIN...USING) plus the module's own two doctests mirrored
# exactly.
PYTHONHASHSEED=0 python3 spike/p7/gen_optimize_joins_ref.py > spike/out/optimize_joins.json || fail=1
# P7 oracle. `optimizer/resolver.py`'s `Resolver` class (AIR-2105) is greenfield --
# same "no corpus/atoms.jsonl tie-in" shape as schema.js/optimize_joins.js, and there is
# no upstream `tests/optimizer/test_resolver.py` either. Builds a real Scope (the R46
# `traverseScope`) + real `MappingSchema` (R41) on both sides and replays 21 scenarios /
# 35 method calls (single/multi-table resolution, join-order disambiguation, schema
# inference, CTEs, SELECT *, UNION-as-source) against `Resolver`'s own return
# values/errors, not `.sql()` text.
PYTHONHASHSEED=0 python3 spike/p7/gen_resolver_ref.py > spike/out/resolver.json || fail=1
# P7 oracle. `optimizer/unnest_subqueries.py` (AIR-2115) is also greenfield -- same
# "no corpus/atoms.jsonl tie-in" shape as schema.js/optimize_joins.py above: parse +
# unnest_subqueries + dump `.sql()`, against CPython doing the same, over 32 hand-picked
# scenarios (the module's own docstring, uncorrelated scalar/IN/ANY/EXISTS subqueries
# and where each is or is not reachable, and correlated EXISTS/IN/ANY/ALL/scalar
# rewrites into LEFT JOINs via `decorrelate()`) -- see `gen_unnest_subqueries_ref.py`'s
# own header for the two non-obvious dispatch gates most scenarios are named after.
PYTHONHASHSEED=0 python3 spike/p7/gen_unnest_subqueries_ref.py > spike/out/unnest_subqueries.json || fail=1
# AIR-2104. `optimizer/qualify_tables.py` and `optimizer/isolate_table_selects.py` are
# both greenfield the same way -- the `qualify()` orchestrator that would wire them (and
# optimize_joins.js above) together is AIR-2108, a separate follow-up issue, so each has
# its own hand-picked scenario battery: 26 for qualify_tables (unaliased/aliased tables,
# CTEs, derived tables, join-construct-as-subquery expansion, canonicalize_table_aliases,
# db=/catalog=, a table-valued-function source, a VALUES UDTF source, dialect-specific
# identifier casing) and 11 (+1 idempotency check) for isolate_table_selects (needs
# isolating vs a single selected source vs a schema-unknown table vs an
# already-a-derived-table source vs the no-alias OptimizeError).
PYTHONHASHSEED=0 python3 spike/p7/gen_qualify_tables_ref.py > spike/out/qualify_tables.json || fail=1
PYTHONHASHSEED=0 python3 spike/p7/gen_isolate_table_selects_ref.py > spike/out/isolate_table_selects.json || fail=1
# P7 oracle. `typing/__init__.py`'s base `EXPRESSION_METADATA` table (294 entries) is
# greenfield too -- its real consumer, `TypeAnnotator` (`optimizer/annotate_types.py`),
# is unported (AIR-2097/2098) -- so the oracle records the exact CALL SHAPE each
# `annotator` closure would produce against a `fakeSelf` recorder, rather than skipping
# entries it cannot invoke a real method through. See `gen_typing_ref.py`'s own header.
PYTHONHASHSEED=0 python3 spike/p7/gen_typing_ref.py > spike/out/typing.json || fail=1
# AIR-2097. `optimizer/annotate_types.py`'s `TypeAnnotator` is the real consumer
# `typing/index.js` (R51, above) was waiting for. Unlike every other greenfield P7
# oracle, annotation does not change `.sql()` output, so this dumps a TYPE FINGERPRINT
# of the whole annotated tree (`(class name, DType name or null)` per node in
# `.walk(bfs=False)` order) over 42 scenarios: literals, arithmetic promotion,
# TEXT+NUMERIC coercion both orderings, string concat, comparisons, CAST/TRY_CAST,
# real-Schema column lookup (bare/aliased/joined/derived-table/CTE), fixed-return-type
# functions, ARRAY/ARRAY_AGG nesting, EXTRACT's BIGINT_EXTRACT_DATE_PARTS branch, and
# NULL propagation through a binary operator plus `annotate()`'s own NULL-cleanup pass.
PYTHONHASHSEED=0 python3 spike/p7/gen_annotate_types_ref.py > spike/out/annotate_types.json || fail=1
# P7 oracle (AIR-2098). `typing/snowflake.py`'s per-dialect overlay -- 14 module-level
# `_annotate_*` helpers plus 163 new / 44 overriding `EXPRESSION_METADATA` keys layered
# on the base table -- exercised through the SAME real `TypeAnnotator` the base oracle
# above uses, with every scenario parsed `read="snowflake"` and annotated
# `dialect="snowflake"` so `dialect.EXPRESSION_METADATA` resolves to the real `Snowflake`
# class's table. 39 scenarios cover every one of the 14 helpers (including each of their
# internal branches) plus a representative sample of the plain `returns`/inline-lambda
# entries, including two override-precedence proofs (DayOfWeek's base INT vs Snowflake's
# TINYINT, ArrayAgg's base by-args-array annotator vs Snowflake's flat ARRAY return).
PYTHONHASHSEED=0 python3 spike/p7/gen_annotate_types_snowflake_ref.py > spike/out/annotate_types_snowflake.json || fail=1
# P7 oracles (AIR-2100). The four-link `Hive <- Spark2 <- Spark <- Databricks`
# typing-overlay chain -- each link seeds its `Map` from the PREVIOUS link's table
# (matching this repo's existing generator/parser chain for the same four dialects) and
# layers its own new keys / overrides on top, exercised through the SAME real
# `TypeAnnotator` the base/Snowflake oracles above use, with every scenario parsed and
# annotated with that link's own dialect so `dialect.EXPRESSION_METADATA` resolves to the
# real class's table, not an earlier link's or the base's.
PYTHONHASHSEED=0 python3 spike/p7/gen_annotate_types_hive_ref.py > spike/out/annotate_types_hive.json || fail=1
PYTHONHASHSEED=0 python3 spike/p7/gen_annotate_types_spark2_ref.py > spike/out/annotate_types_spark2.json || fail=1
PYTHONHASHSEED=0 python3 spike/p7/gen_annotate_types_spark_ref.py > spike/out/annotate_types_spark.json || fail=1
PYTHONHASHSEED=0 python3 spike/p7/gen_annotate_types_databricks_ref.py > spike/out/annotate_types_databricks.json || fail=1
# P7 oracle (AIR-2116). `optimizer/merge_subqueries.py` is the highest correctness-risk
# module in this batch -- a wrong mergeability guard silently changes result
# cardinality, not just SQL shape -- so this oracle is organized guard-by-guard rather
# than feature-by-feature over 32 hand-picked scenarios, several as explicit
# should-merge/should-NOT-merge pairs. Same "no corpus/atoms.jsonl tie-in" shape as
# schema.js/optimize_joins.js/resolver.js/unnest_subqueries.js above. See
# `gen_merge_subqueries_ref.py`'s own header for the adversarial
# `_outer_select_joins_on_inner_select_join` dead-code finding and for why 4 of the 32
# scenarios compare a structural "did the Subquery survive" signal instead of `.sql()`
# text (this port's window_sql/querytransform_sql base-Generator methods aren't ported
# yet -- out of this file's scope).
PYTHONHASHSEED=0 python3 spike/p7/gen_merge_subqueries_ref.py > spike/out/merge_subqueries.json || fail=1
# P7 oracles for `eliminate_subqueries.js`/`eliminate_ctes.js` (AIR-2114), both
# greenfield with no consumer yet, the same shape `optimize_joins.js`/R45 already
# established: 15 hand-picked scenarios for eliminate_subqueries (dedup of two
# identical derived tables, a UNION subquery, existing-CTE dedup reuse, DAG-order
# hoisting out of a nested CTE, a Subquery-rooted root, LATERAL/WHERE-clause-subquery
# preservation, WITH RECURSIVE, alias-collision bumping, and the UPDATE...FROM
# structural no-op) and 9 for eliminate_ctes (unused-CTE removal, a chain removed in
# one reverse pass, SEMI/ANTI-join and correlated-subquery reference-count keep-alive).
PYTHONHASHSEED=0 python3 spike/p7/gen_eliminate_subqueries_ref.py > spike/out/eliminate_subqueries.json || fail=1
PYTHONHASHSEED=0 python3 spike/p7/gen_eliminate_ctes_ref.py > spike/out/eliminate_ctes.json || fail=1
# P7 oracle. `optimizer/simplify.py`'s `Simplifier` (the whole 1,880-LOC file, whole-file
# port per PORT_PLAN.md -- originally scoped as three separate issues, but the real
# `_simplify` dispatcher chains almost every method in sequence, so a partial port
# would leave it calling NotPorted stubs mid-pipeline). Same "no corpus/atoms.jsonl
# tie-in" shape as optimize_joins.js/resolver.js above: parse + simplify + dump
# `.sql()`, against CPython doing the same, over 81 hand-picked scenarios covering
# boolean algebra (NOT/AND/OR reduction, De Morgan, TRUE/FALSE absorption), constant
# comparison/arithmetic/string-concat folding, COALESCE, CASE/IF, BETWEEN rewriting,
# date/interval arithmetic (including a month-end-clamping case exercising the new
# `PyRelativedelta` port in `_py/datetime.js`), DATE_TRUNC range rewrites, and a no-op
# round-trip. See `gen_simplify_ref.py`'s own header for the 3 scenarios deliberately
# left out because rendering their surviving node needs a pre-existing, unrelated
# base-Generator stub (`div_sql`/`concat_sql`/`concatws_sql`).
PYTHONHASHSEED=0 python3 spike/p7/gen_simplify_ref.py > spike/out/simplify.json || fail=1
# P7 oracle (AIR-2106). `optimizer/qualify_columns.py` CORE (column qualification +
# star expansion) -- `validate_qualify_columns`/`quote_identifiers` are AIR-2107, a
# separate follow-up issue, and are not ported or exercised here. Same "no
# corpus/atoms.jsonl tie-in" shape as resolver.js/merge_subqueries.js/simplify.js
# above: 41 hand-picked scenarios covering basic/ambiguous/join-disambiguated
# qualification, USING joins (2-way/3-way/NATURAL/SEMI), alias-ref expansion (WHERE/
# HAVING/QUALIFY/GROUP BY, BigQuery's shadow-marking), GROUP BY/ORDER BY/DISTINCT ON
# positional references, struct-field-to-Dot conversion, Snowflake positional column
# refs, PIVOT column qualification, BigQuery struct-star expansion, star EXCEPT/
# REPLACE/RENAME/ILIKE, and qualify_outputs/pushdown_cte_alias_columns. Comparison is
# `.sql()` text for most scenarios; 7 that hit pre-existing, unrelated `NotPorted`
# base-Generator stubs (`pseudocolumn_sql`/`dot_sql`/`pivot_sql`, `TableColumn`'s
# missing TRANSFORMS entry) compare a structural `repr()`/`.toString()` dump instead
# -- see `gen_qualify_columns_ref.py`'s own `STRUCTURAL` set.
PYTHONHASHSEED=0 python3 spike/p7/gen_qualify_columns_ref.py > spike/out/qualify_columns.json || fail=1
# P10 oracle. `optimizer/normalize.py` (AIR-2110) is NOT greenfield -- upstream ships a
# real fixture corpus for it, `tests/fixtures/optimizer/normalize.sql` (17 pairs),
# reproduced here through the exact small pipeline `TestOptimizer.test_normalize` runs
# it through (`normalize() -> annotate_types() -> simplify()`, both already ported),
# plus the three direct `test_normalize` assertions (plain CNF, DNF, and a Snowflake
# BOOLXOR/Xor-arity scenario) and the three `test_normalization_distance` depth
# scenarios. Unlike every other gen_*_ref.py above, its default `SQLGLOT_REF` is the
# COMPLETE checkout, not the lean one -- see `gen_normalize_ref.py`'s own header for
# why (the lean ref's `tests/fixtures/optimizer/` has no `normalize.sql` at all).
PYTHONHASHSEED=0 python3 spike/p10/gen_normalize_ref.py > spike/out/normalize.json || fail=1
# P10 oracle (AIR-2111, epic AIR-2088). `optimizer/pushdown_projections.py` is also NOT
# greenfield -- upstream ships a real fixture corpus, `tests/fixtures/optimizer/
# pushdown_projections.sql` (74 pairs), reproduced through the exact
# `TestOptimizer.test_pushdown_projection` pipeline (`qualify_tables()` with no kwargs
# -> `qualify_columns(infer_schema=True, **kwargs)` -> `pushdown_projections(**kwargs)`),
# same "fixture-driven, not hand-invented" call `gen_normalize_ref.py`/R68 made above.
# Also default `SQLGLOT_REF`-is-the-complete-checkout, for the same reason.
PYTHONHASHSEED=0 python3 spike/p10/gen_pushdown_projections_ref.py > spike/out/pushdown_projections.json || fail=1
# P10 oracle. `optimizer/eliminate_joins.py` (AIR-2113) is NOT greenfield either --
# upstream ships a real fixture corpus, `tests/fixtures/optimizer/eliminate_joins.sql`
# (18 pairs), reproduced here through `TestOptimizer.test_eliminate_joins`'s own
# (bare, un-dressed) pipeline: `eliminate_joins(parse_one(sql)).sql(pretty=True)`, plus
# 7 direct `join_condition()` scenarios covering its CNF/DNF/neither branches that the
# fixture corpus alone never reaches. Like `normalize.js` above, its default
# `SQLGLOT_REF` is the COMPLETE checkout -- see `gen_eliminate_joins_ref.py`'s own
# header.
PYTHONHASHSEED=0 python3 spike/p10/gen_eliminate_joins_ref.py > spike/out/eliminate_joins.json || fail=1
# P10 oracle (AIR-2112). `optimizer/pushdown_predicates.py` is also NOT greenfield --
# upstream ships a real fixture corpus, `tests/fixtures/optimizer/
# pushdown_predicates.sql` (32 pairs), consumed by `TestOptimizer.
# test_pushdown_predicates` with NO wrapper pipeline (unlike normalize.sql): just
# `pushdown_predicates(parse_one(sql, read=dialect), dialect=dialect).sql(dialect=
# dialect)`, reproduced verbatim here. 6 of the 32 pairs are gated behind `# dialect:
# presto|trino|athena` and are skipped by the JS fuzzer with a named reason (none of
# those three dialects are ported in this codebase, so `parseOne` already throws on
# them independently of this module) -- see `gen_pushdown_predicates_ref.py`'s and
# `src/optimizer/pushdown_predicates.js`'s own headers.
PYTHONHASHSEED=0 python3 spike/p10/gen_pushdown_predicates_ref.py > spike/out/pushdown_predicates.json || fail=1
# P10 oracle (AIR-2108, epic AIR-2087's LAST issue). `optimizer/qualify.py`'s single
# `qualify()` function wires five already-ported steps together end to end --
# `normalize_identifiers`/`qualify_tables`/`isolate_table_selects`/`qualify_columns`/
# `quote_identifiers`/`validate_qualify_columns` -- under its real kwarg surface, never
# exercised in composition before this file. Replays the real upstream fixtures
# `tests/fixtures/optimizer/{qualify_columns,qualify_columns_ddl,
# qualify_columns__with_invisible,qualify_tables,qualify_columns__invalid}.sql` through
# the actual `optimizer.qualify.qualify` entry point (never the narrower functions
# directly), skipping dialect rows this port doesn't implement (clickhouse/mysql/
# oracle/presto/risingwave/starrocks) with a named, counted skip, plus a hand-picked
# kwarg-surface battery and four Snowflake positional-column scenarios. See
# `gen_qualify_ref.py`'s own header for a genuine, CONFIRMED composition finding (row
# 13 of `qualify_columns__invalid.sql` legitimately does NOT raise under the full
# `qualify()` pipeline, unlike the narrower two-step call its own upstream test uses)
# and for the two real, FIXED port bugs this oracle surfaced along the way:
# `Selectable.named_selects`'s base-class fallback (query.py:85-87) was installed only
# for `Query`-trait classes, leaving `Values`/`Unnest`/`Lateral` with no
# `namedSelects` getter at all (`src/expressions/query_methods.js`); and
# `Unnest.selects` (`src/expressions/focused_methods.js`) read its own array
# arguments instead of `super().selects` (`alias?.columns || []`), a literal mis-port.
# A third, pre-existing "stub outlived its stated blocker" (`src/parsers/bigquery.js`'s
# `_parse_unnest`) called a LOCAL `annotate_types` stub instead of the real whole-file
# `optimizer/annotate_types.js` port that landed at R54, breaking BigQuery UNNEST
# parsing entirely whenever the unnested expression was non-null. 49 rows this
# fixture replay reaches are pre-existing, UNRELATED base-Generator/parser gaps
# (`dot_sql`/`pivot_sql`/`parameter_sql`/etc. `NotPorted` stubs, `TableColumn`/
# `JSONPathKey` unsupported types, one narrow STACK-function multi-alias scope gap) --
# named and counted by the JS fuzzer as `KNOWN_GAP`, not `ERROR`, the same
# "structural/excluded, not silently ignored" treatment `gen_qualify_columns_ref.py`'s
# own `STRUCTURAL` set already established.
PYTHONHASHSEED=0 python3 spike/p10/gen_qualify_ref.py > spike/out/qualify.json || fail=1
# P10 oracle (AIR-2117). `optimizer/canonicalize.py`'s remainder (canonicalize() itself,
# add_text_to_concat, replace_date_funcs, coerce_type + its _coerce_*/_replace_* helpers,
# remove_redundant_casts, remove_ascending_order, _replace_int_predicate -- ensure_bools
# alone landed R43). Now that the real `qualify()` orchestrator + `quote_identifiers`
# have landed (R73/R75, merged into this branch), this oracle runs upstream's EXACT
# `optimizer.optimize(sql, rules=[qualify, quote_identifiers, annotate_types,
# canonicalize], ...)` wrapper (`qualify(ast, {schema, dialect, isolateTables: true})`
# followed by `annotate_types`/`canonicalize`, `quoteIdentifiers`'s default `true`
# already covering the separate `quote_identifiers` rule entry -- see
# `gen_canonicalize_ref.py`'s own header), comparing against the real fixture file's
# own quoted "expected" text directly, not just JS-vs-CPython on a reduced pipeline.
# See that same header for the base-Generator `concat_sql`/`dateadd_sql` gaps this
# round's own battery surfaced (pre-existing, unrelated to canonicalize.js, recorded
# not fixed).
PYTHONHASHSEED=0 python3 spike/p10/gen_canonicalize_ref.py > spike/out/canonicalize.json || fail=1
# P10 oracle (AIR-2118). `optimizer/optimizer.js` -- the `RULES` tuple (all fourteen
# already-ported rules, upstream's exact order) plus the `optimize()` entry point that
# composes them. Runs the real `TestOptimizer.test_optimize` pipeline (the one place
# upstream itself runs the full default `RULES` sequence together) against the real
# `tests/fixtures/optimizer/optimizer.sql` fixture, comparing against that fixture's
# own quoted "expected" text directly. 25 of 83 rows hit pre-existing, unrelated base-
# Generator `NotPorted` stubs this round's own battery surfaced for the first time
# (`hint_sql`/`dot_sql`/`pivot_sql`/`currentdate_sql`/`div_sql`/`querytransform_sql`/
# `kwarg_sql` -- `pivot_sql` alone covers 14 PIVOT/UNPIVOT rows), named and verified by
# structural fingerprint rather than fixed here (recorded, not worked around, per this
# round's own task brief); 2 more are `# dialect: mysql` rows, skipped by name since
# `src/dialects/mysql.js` does not exist in this port. See `gen_optimizer_ref.py`'s own
# header for the full rationale.
PYTHONHASHSEED=0 python3 spike/p10/gen_optimizer_ref.py > spike/out/optimizer.json || fail=1
# AIR-2119 (epic AIR-2091, "8.2 End-to-end optimize() differential oracle") -- the
# issue's own framing: "the actual 'is Track 2 done' gate, not any individual
# module's own oracle passing in isolation." Extends R78's own optimizer.sql replay
# to EVERY OTHER real `optimizer.optimize(...)`-based assertion in
# tests/test_optimizer.py: real TPC-H (22 queries) + TPC-DS (99 queries) fixtures
# (the two issue-named primary targets), `test_merge_subqueries`/`test_canonicalize`'s
# own `rules=` overrides naming raw rule functions, and ~25 small ad-hoc assertions
# (error-highlighting, type-annotation-through-the-full-pipeline, schema shapes,
# an `on_qualify` callback, dialect-specific JSON dot-access). Found and fixed two
# real bugs along the way (see this round's PORT_PLAN entry): a plain-`Map`-instead-
# of-`ExprMap` lookup in `qualify_columns.js`'s `_expand_order_by_and_distinct_on`
# (silently left ORDER BY fully qualified instead of collapsed to its GROUP-BY-query
# alias), and `optimizer.js`'s `ADAPTERS` missing entries for `qualify_tables`/
# `qualify_columns` when named directly in a `rules=` override (upstream's own
# `test_merge_subqueries` does this) -- the fallback no-kwargs call silently ran
# column qualification with NO schema at all. 278 rows: EXACT 206, GENERATOR_GAP 65
# (named, pre-existing, unrelated base-Generator/parser stubs -- div_sql/rollup_sql/
# hint_sql/dateadd_sql/dot_sql/extract_sql/concat_sql/JSONPathKey), SKIPPED 7 (mysql/
# clickhouse unported, GROUPING SETS parser gap, colon-access JSON path parse gap),
# MISMATCH 0, ERROR 0. See `gen_optimize_e2e_ref.py`'s own header for the full row
# inventory and `fuzz_optimize_e2e.mjs`'s own header for the fingerprint fallback's
# own associativity/insertion-order canonicalization (non-observable in rendered SQL).
PYTHONHASHSEED=0 python3 spike/p10/gen_optimize_e2e_ref.py > spike/out/optimize_e2e.json || fail=1
# AIR-2123 oracle. `anonymize.py` is NOT greenfield either -- own new oracle,
# reproducing every assertion in tests/test_anonymize.py.
PYTHONHASHSEED=0 python3 spike/p10/gen_anonymize_ref.py > spike/out/anonymize.json || fail=1
# AIR-2122: `diff.js`, greenfield, zero optimizer dependency. Reproduces every
# `tests/test_diff.py` CALL (not its hand-written `expected` values -- see
# `gen_diff_ref.py`'s own header), comparing a canonicalized SET of
# `(type, a.sql(), b.sql())` edits per scenario, since edit-script order/duplication is
# not part of upstream's own contract (its test asserts `set(actual) == set(expected)`).
# EXACT 28/28 of applicable rows, SKIPPED 4 (2 unported Oracle dialect, 2 pre-existing
# unrelated `concat_sql` base-Generator stub -- both named, not by row id), MISMATCH 0,
# ERROR 0.
PYTHONHASHSEED=0 python3 spike/p10/gen_diff_ref.py > spike/out/diff.json || fail=1
# P7 oracle (AIR-2099). Five per-dialect type-inference overlays -- `typing/
# {postgres,redshift,duckdb,bigquery,tsql}.py` -- exercised through the same real
# `TypeAnnotator` every other typing/*.js overlay above uses. One combined oracle
# covers all five (four are tiny: 13/3/24/14 keys; BigQuery's 83 keys / 7 custom
# `_annotate_*` helpers is the only one needing real branch coverage on its own). See
# `gen_typing_overlay_family_ref.py`'s own header for the full scenario breakdown,
# including Redshift's override-of-Postgres's-override precedence proof (Ntile) and
# BigQuery's four `_annotate_array` paths (ARRAY(SELECT col)/ARRAY(SELECT AS STRUCT
# ...)/ARRAY(SELECT ... UNION ALL ...)/literal-array fallback).
PYTHONHASHSEED=0 python3 spike/p7/gen_typing_overlay_family_ref.py > spike/out/typing_overlay_family.json || fail=1

run "PROBE 1a: numeric differential"      node spike/fuzz_num.mjs
run "PROBE 1b: named go/no-go literal"    node spike/gonogo_snowflake367.mjs
run "PROBE 2a: unicode candidate sweep"   node spike/fuzz_unicode.mjs
run "PROBE 2b: generated table exactness" node spike/verify_unicode_tables.mjs
run "PROBE 2c: string-level predicates"   node spike/fuzz_str.mjs
run "CALIBRATION: trie/time/helper"       node spike/fuzz_calib.mjs
run "BUILTINS: _py shims + containers"    node spike/fuzz_builtins.mjs
run "LINT: license attribution"           node tools/lint_license.mjs
run "LINT: no runtime \\p{...}"            node tools/lint_unicode.mjs
run "LINT: no raw control bytes"          node tools/lint_control_bytes.mjs
# §4.6 / §8.5 gate 3. It caught a real String.fromCharCode in src/tokenizer_core.js at
# P1, which is the argument for running it here rather than only in CI: a deny-list
# nobody runs is a comment.
run "LINT: deny-lists routed through _py" node tools/lint_deny.mjs
# §4.1 identity. Added for PR #6 review finding 9: the same hand-written-identity bug
# had been found three times across two reviews (`/Cast$/`, `is_cast`, `is_data_type`,
# `unalias`). `bases` already knows which classes have subclasses, so the check is
# mechanical rather than another list someone has to remember to update.
run "LINT: isinstance vs name identity"   node tools/lint_identity.mjs
run "LINT: py: anchors point at defs"     node tools/lint_anchors.mjs
# §8.1 Rule 1. Offline half only -- the live check needs gh + network, and this script is
# meant to be reproducible from a clean tree. The load-bearing case is the FALSE positive:
# two agents replacing two different one-line stubs in src/parser.js must NOT be flagged,
# or the stub-seeding design that makes P3+ parallel is defeated.
run "SELFTEST: claim-overlap units"       node tools/claim_overlap.mjs --selftest
run "SELFTEST: closure calculator"        node tools/closure.mjs --selftest
run "SELFTEST: ratchet rules 1-5"         node tools/ratchet.mjs --selftest
run "SELFTEST: corpus runner"             node test/runner.mjs --selftest
run "CORPUS: integrity"                   node tools/check_corpus.mjs
run "CORPUS: resync vs baseline"          node test/runner.mjs --resync
run "PARITY: 6 probes"                    node tools/parity/check.mjs
run "FUZZ: depth (R11/C1)"                node spike/fuzz_depth.mjs
run "FUZZ: toowide + comments"            node spike/fuzz_toowide_comments.mjs
run "FUZZ: unicode over tokenization"    node spike/fuzz_unicode_tokens.mjs
run "TOKENS: streams byte-exact"         node tools/tokens/check_streams.mjs
run "TOKENS: table transcription"        python3 tools/tokens/transcribe_tables.py --check
run "SELFTEST: sync_report"               python3 tools/sync_report.py --selftest
run "SEED: stub+table skeletons parse"    bash spike/check_seed.sh
run "PARSER: class tables vs upstream"    node tools/parity/check_parser_tables.mjs
run "P3: from_arg_list (all 563 funcs)"   node spike/p3/fuzz_from_arg_list.mjs
run "P3: optimizer Tier A walk/find"      node spike/p3/fuzz_walk_in_scope.mjs
run "P3: generator kernel (73k nodes)"    node spike/p3/fuzz_generator_kernel.mjs
run "P3: parse-path generate call sites"  node spike/p3/fuzz_parse_path_sql.mjs
run "P3: raise_error + unicode columns"   node spike/p3/fuzz_raise_error.mjs
run "P3: check_command_warning strings"   node spike/p3/fuzz_command_warning.mjs
run "P3: AST oracle coverage (honest)"    node spike/p3/fuzz_ast_coverage.mjs
run "P4: negation full v0 oracle" node spike/p4/fuzz_neg.mjs
run "P4: base Generator (settings/prims/gen)" node spike/p4/fuzz_generator_base.mjs
# The generator's counterpart to "P3: AST oracle coverage (honest)", and wired in for the
# same reason: without it, `tools/closure_generator.mjs`'s percentage is the only number
# anyone would quote, and R13 is the standing proof that a closure percentage and a real
# probe can disagree completely. It also cross-checks the two against each other and fails
# if closure over-claims — which it caught doing on its very first run.
run "P4: generate oracle (honest)"        node spike/p4/fuzz_generate_oracle.mjs
# src/transforms.js is unreachable from the generate-oracle corpus (PORT_PLAN.md R26:
# every consuming row also needs a dialect's own Generator subclass, which does not
# exist yet), so this is the only differential signal on it: parse + transform + dump,
# against CPython's sqlglot.transforms doing the same.
run "P4: transforms.py functions vs CPython" node spike/p4/fuzz_transforms.mjs
# The corpus reaches identifier_sql on 10,870 of 15,540 rows and still exercises almost
# none of its branches (0.024% non-ASCII, no empty name, one of eight flag combinations).
# Both defects in its first port were invisible to all of them. R4's lesson generalised:
# for a method whose job is a decision over arbitrary text, corpus coverage is not method
# coverage.
run "P4: identifier_sql flag space"       node spike/p4/fuzz_identifier_sql.mjs
run "SELFTEST: generator closure maths"   node tools/closure_generator.mjs --selftest
run "P5: Dialect defaults vs CPython"      node spike/p5/fuzz_dialect_defaults.mjs
run "P5: Dialect.get_or_raise().parse()"   node spike/p5/fuzz_dialect_parse.mjs
run "P5: Snowflake dialect vs CPython"     node spike/p5/fuzz_snowflake_dialect.mjs
run "P5: real dialect generation row ratchet" node spike/p5/fuzz_dialect_generate.mjs

run "P5: DuckDB dialect vs CPython"        node spike/p5/fuzz_duckdb_dialect.mjs
run "P6: schema.js MappingSchema vs CPython" node spike/p6/fuzz_schema.mjs
run "P7: optimizer/scope.js traverseScope/Scope vs CPython" node spike/p7/fuzz_scope.mjs
run "P7: optimize_joins.js vs CPython"       node spike/p7/fuzz_optimize_joins.mjs
run "P7: optimizer/resolver.js Resolver vs CPython" node spike/p7/fuzz_resolver.mjs
run "P7: unnest_subqueries.js vs CPython"    node spike/p7/fuzz_unnest_subqueries.mjs
run "P7: qualify_tables.js vs CPython"       node spike/p7/fuzz_qualify_tables.mjs
run "P7: isolate_table_selects.js vs CPython" node spike/p7/fuzz_isolate_table_selects.mjs
run "P7: typing/index.js EXPRESSION_METADATA vs CPython" node spike/p7/fuzz_typing.mjs
run "P7: annotate_types.js TypeAnnotator vs CPython" node spike/p7/fuzz_annotate_types.mjs
run "P7: typing/snowflake.js EXPRESSION_METADATA vs CPython" node spike/p7/fuzz_annotate_types_snowflake.mjs
run "P7: typing/hive.js EXPRESSION_METADATA vs CPython" node spike/p7/fuzz_annotate_types_hive.mjs
run "P7: typing/spark2.js EXPRESSION_METADATA vs CPython" node spike/p7/fuzz_annotate_types_spark2.mjs
run "P7: typing/spark.js EXPRESSION_METADATA vs CPython" node spike/p7/fuzz_annotate_types_spark.mjs
run "P7: typing/databricks.js EXPRESSION_METADATA vs CPython" node spike/p7/fuzz_annotate_types_databricks.mjs
run "P7: merge_subqueries.js vs CPython"                  node spike/p7/fuzz_merge_subqueries.mjs
run "P7: eliminate_subqueries.js vs CPython"  node spike/p7/fuzz_eliminate_subqueries.mjs
run "P7: eliminate_ctes.js vs CPython"        node spike/p7/fuzz_eliminate_ctes.mjs
run "P7: optimizer/simplify.js Simplifier vs CPython" node spike/p7/fuzz_simplify.mjs
run "P7: optimizer/qualify_columns.js (core) vs CPython" node spike/p7/fuzz_qualify_columns.mjs
run "P10: optimizer/normalize.js vs CPython"          node spike/p10/fuzz_normalize.mjs
run "P10: optimizer/pushdown_projections.js vs CPython" node spike/p10/fuzz_pushdown_projections.mjs
run "P10: optimizer/eliminate_joins.js vs CPython"    node spike/p10/fuzz_eliminate_joins.mjs
run "P10: optimizer/pushdown_predicates.js vs CPython" node spike/p10/fuzz_pushdown_predicates.mjs
run "P10: optimizer/qualify.js vs CPython (end-to-end)" node spike/p10/fuzz_qualify.mjs
run "P10: optimizer/canonicalize.js vs CPython"        node spike/p10/fuzz_canonicalize.mjs
run "P10: optimizer/optimizer.js vs CPython (RULES + optimize())" node spike/p10/fuzz_optimizer.mjs
run "AIR-2119: optimize() end-to-end (tpc-h/tpc-ds + more) vs CPython" node spike/p10/fuzz_optimize_e2e.mjs
run "AIR-2123: anonymize.js vs CPython (tests/test_anonymize.py)" node spike/p10/fuzz_anonymize.mjs
run "AIR-2122: diff.js vs CPython sqlglot.diff"       node spike/p10/fuzz_diff.mjs
run "P7: typing/{postgres,redshift,duckdb,bigquery,tsql}.js vs CPython" node spike/p7/fuzz_typing_overlay_family.mjs
# The node:test suite was documented in P3_RESULTS.md but run by NOTHING — not this
# script, not `make check`, not `make probes`. Found while fixing the PR #6 review: an
# unrun test is a comment, which is the same argument this repo makes for the deny-list
# lint. `find` rather than a fixed list of directories, so a new test/<dir>/ cannot be
# silently skipped. (`node --test test/expressions/` — the form P3_RESULTS.md quoted —
# does not even work on Node 22: a directory argument is resolved as a module.)
run "NATIVE: node:test suite"             bash -c 'node --test $(find test -name "*.test.mjs" | sort)'
run "BRIDGE: 2 end-to-end proofs"         python3 tools/bridge/proof.py

echo
if [ "$fail" -eq 0 ]; then
  echo "  ALL PROBES GREEN"
else
  echo "  SOME PROBES RED:"
  for p in "${failed_probes[@]:-}"; do
    [ -n "$p" ] && echo "    - $p"
  done
  # The corpus generators above are not run() calls, so a red one sets `fail` without
  # naming itself here. Say so rather than letting the list look complete.
  if [ "${#failed_probes[@]}" -eq 0 ]; then
    echo "    (no named probe failed — a corpus generator above returned non-zero)"
  fi
fi
exit "$fail"
