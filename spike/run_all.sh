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
