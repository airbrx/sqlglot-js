#!/usr/bin/env bash
# fuzz_regex — PORT_PLAN.md §3.4 target 2, a mandatory P0 exit criterion.
#
#   bash spike/run_regex.sh [/path/to/sqlglot-ref]
#
# Regenerates the corpus with CPython as the oracle, runs the differential
# against src/_py/re.js, and runs the identifier-quoting spec test. Exits
# non-zero if anything is RED.
#
# Shaped to fold into spike/run_all.sh on merge as:
#   python3 spike/py/gen_regex_cases.py --stdout > spike/out/regex_cases.jsonl
#   run "FUZZ: regex (§3.4 target 2)"  node spike/fuzz_regex.mjs
set -uo pipefail
cd "$(dirname "$0")/.."

REF="${1:-/tmp/sqlglot-ref-regex}"
fail=0

echo "toolchain:"
echo "  $(python3 --version 2>&1)"
echo "  node $(node --version)"
echo "  ref  $REF"

if [ ! -d "$REF/sqlglot" ]; then
  echo
  echo "  $REF is not a sqlglot checkout; clone it with:"
  echo "    git clone https://github.com/tobymao/sqlglot.git $REF"
  echo "    git -C $REF checkout 91119bc"
  echo
  echo "  falling back to the committed corpus (spike/regex/corpus/cases.jsonl)"
else
  mkdir -p spike/out
  echo
  echo "--- generating corpus (CPython is the oracle) ---"
  python3 spike/py/gen_regex_cases.py --ref "$REF" --stdout > spike/out/regex_cases.jsonl || fail=1
fi

echo
echo "===== FUZZ: regex differential ====="
node spike/fuzz_regex.mjs || fail=1

echo
echo "===== SPEC: identifier quoting (\\w is output-visible) ====="
node --test spike/regex/test_identifier_quoting.mjs || fail=1

echo
if [ "$fail" -eq 0 ]; then
  echo "  FUZZ_REGEX SUITE: GREEN"
else
  echo "  FUZZ_REGEX SUITE: RED"
fi
exit "$fail"
