#!/usr/bin/env bash
# Reproduce the whole P0 go/no-go spike from scratch.
# PORT_PLAN.md §7 P0 item 1.
#
#   bash spike/run_all.sh
#
# Exits non-zero if any probe diverges from CPython.
set -uo pipefail
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
  fi
  local rc=$?
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
run "P5: DuckDB dialect vs CPython"        node spike/p5/fuzz_duckdb_dialect.mjs
run "P6: schema.js MappingSchema vs CPython" node spike/p6/fuzz_schema.mjs
run "P7: optimizer/scope.js traverseScope/Scope vs CPython" node spike/p7/fuzz_scope.mjs
run "P7: optimize_joins.js vs CPython"       node spike/p7/fuzz_optimize_joins.mjs
run "P7: optimizer/resolver.js Resolver vs CPython" node spike/p7/fuzz_resolver.mjs
run "P7: unnest_subqueries.js vs CPython"    node spike/p7/fuzz_unnest_subqueries.mjs
run "P7: qualify_tables.js vs CPython"       node spike/p7/fuzz_qualify_tables.mjs
run "P7: isolate_table_selects.js vs CPython" node spike/p7/fuzz_isolate_table_selects.mjs
run "P7: typing/index.js EXPRESSION_METADATA vs CPython" node spike/p7/fuzz_typing.mjs
run "P7: eliminate_subqueries.js vs CPython"  node spike/p7/fuzz_eliminate_subqueries.mjs
run "P7: eliminate_ctes.js vs CPython"        node spike/p7/fuzz_eliminate_ctes.mjs
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
