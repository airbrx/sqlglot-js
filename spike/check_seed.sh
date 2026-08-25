#!/usr/bin/env bash
# Seed the two largest files and assert the output is valid JS.
#
# This guards a real failure found during P0: Python parameter names are not
# constrained by JS's grammar, and upstream uses some that ARE JS reserved words
# (`parser.py:3253` is `_parse_mergeblockratio(self, no, default)`). Emitting them
# verbatim produced a skeleton that did not parse — and a seeder whose output does not
# parse is worse than no seeder, because the failure lands on the first agent to pull
# the task rather than on the tool that caused it.
set -uo pipefail
cd "$(dirname "$0")/.."

REF="${SQLGLOT_REF:-/tmp/sqlglot-ref}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

seed_and_check() {
  local file="$1" cls="$2" out="$TMP/$3"
  python3 tools/seed_static.py --ref "$REF" --file "$file" --class "$cls" --out "$out" || {
    echo "  seed FAILED for $file::$cls"; fail=1; return
  }
  # node --check needs a module extension to treat `import` as valid.
  mv "$out" "${out%.js}.mjs"
  if node --check "${out%.js}.mjs"; then
    echo "  ok   $file::$cls -> valid JS"
  else
    echo "  FAIL $file::$cls -> seeded output does not parse"
    fail=1
  fi
}

seed_and_check sqlglot/parser.py    Parser    parser.js
seed_and_check sqlglot/generator.py Generator generator.js
seed_and_check sqlglot/tokens.py    Tokenizer tokenizer.js

exit "$fail"
