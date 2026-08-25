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
run() { echo; echo "===== $1 ====="; shift; "$@" || fail=1; }

echo "toolchain:"
echo "  $(python3 --version 2>&1)"
echo "  node $(node --version)"

echo
echo "--- generating corpora (CPython is the oracle) ---"
python3 spike/py/gen_num_cases.py     > spike/out/num_cases.jsonl   || fail=1
python3 spike/py/gen_unicode_ref.py   > spike/out/unicode_ref.json  || fail=1
python3 spike/py/gen_str_cases.py     > spike/out/str_cases.jsonl   || fail=1
node tools/gen_unicode_tables.mjs                                   || fail=1

run "PROBE 1a: numeric differential"      node spike/fuzz_num.mjs
run "PROBE 1b: named go/no-go literal"    node spike/gonogo_snowflake367.mjs
run "PROBE 2a: unicode candidate sweep"   node spike/fuzz_unicode.mjs
run "PROBE 2b: generated table exactness" node spike/verify_unicode_tables.mjs
run "PROBE 2c: string-level predicates"   node spike/fuzz_str.mjs

echo
if [ "$fail" -eq 0 ]; then
  echo "  ALL PROBES GREEN"
else
  echo "  SOME PROBES RED"
fi
exit "$fail"
