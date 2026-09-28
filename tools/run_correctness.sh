#!/usr/bin/env bash
# Required applicable DIFFERENTIAL checks; every listed check must return success.
# Full legacy diagnostics remain `bash spike/run_all.sh`, with named gaps in docs.
set -euo pipefail
cd "$(dirname "$0")/.."
export PYTHONHASHSEED=0
: "${SQLGLOT_REF:?Complete pinned upstream checkout is required}"
mkdir -p spike/out
# Preconditions: never pretend that incomplete test fixtures are a green control.
test -f "$SQLGLOT_REF/tests/dialects/__init__.py"
test "$(git -C "$SQLGLOT_REF" rev-parse HEAD)" = 91119bcaac977ede6f4a641bdda593b0015ef998
python3 -c 'import dateutil, pytz, six; assert dateutil.__version__=="2.9.0.post0"; assert pytz.__version__=="2022.7.1"; assert six.__version__=="1.15.0"'
python3 -c 'import sys,unicodedata; assert sys.version.split()[0]=="3.9.25"; assert unicodedata.unidata_version=="13.0.0"'
node tools/parity/check.mjs
node tools/parity/check_parser_tables.mjs
node tools/tokens/check_streams.mjs
python3 tools/tokens/transcribe_tables.py --check
python3 spike/py/gen_tokens_cases.py > spike/out/tokens_fuzz.jsonl
node spike/fuzz_unicode_tokens.mjs
python3 spike/p3/gen_command_warning_ref.py > spike/out/command_warnings.jsonl
node spike/p3/fuzz_command_warning.mjs
# Settings/overrides and independently strict core/optimizer oracles.
for name in dialect snowflake_dialect duckdb_dialect; do
  target="$name"
  [ "$name" != dialect ] || target=dialect_defaults
  python3 "spike/p5/gen_${name}_ref.py" > "spike/out/${target}.json"
  node "spike/p5/fuzz_${target}.mjs"
done
python3 spike/p4/gen_gateway_regressions_ref.py > spike/out/gateway_regressions.json
node spike/p4/fuzz_gateway_regressions.mjs
python3 spike/p4/gen_neg_ref.py > spike/out/neg.json
node spike/p4/fuzz_neg.mjs
python3 spike/p4/gen_generator_base_ref.py > spike/out/generator_base.json
node spike/p4/fuzz_generator_base.mjs
python3 spike/p4/gen_transforms_ref.py > spike/out/transforms.json
node spike/p4/fuzz_transforms.mjs
# Strict base-only diagnostic is in run_all.sh; all of its IDs are protected
# by the full production-generation ratchet below (including foreign read dialects).
python3 spike/p6/gen_schema_ref.py > spike/out/schema.json
node spike/p6/fuzz_schema.mjs
for name in scope optimize_joins resolver unnest_subqueries qualify_tables isolate_table_selects typing annotate_types merge_subqueries eliminate_subqueries eliminate_ctes simplify; do
  python3 "spike/p7/gen_${name}_ref.py" > "spike/out/${name}.json"
  node "spike/p7/fuzz_${name}.mjs"
done
python3 tools/bridge/proof.py
python3 tools/corpus_control.py --report spike/out/python-control.jsonl
node spike/p5/fuzz_dialect_parse.mjs --report spike/out/production-parse.jsonl
node spike/p5/fuzz_dialect_generate.mjs --report spike/out/production-generate.jsonl
