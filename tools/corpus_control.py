#!/usr/bin/env python3
"""Pinned CPython control of the SAME Validator contract as corpus-adapter.mjs.
Every selected atom gets a row, including parse/generate errors. No exclusions.
"""
import argparse
import json
import os
import sys
import unicodedata
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('--ref', default=os.environ.get('SQLGLOT_REF', '/tmp/sqlglot-ref'))
p.add_argument('--v0', action='store_true')
p.add_argument('--report', required=True)
args = p.parse_args()
sys.path.insert(0, args.ref)
from sqlglot import Dialect, ErrorLevel, parse_one, UnsupportedError

provenance = json.loads(Path('corpus/PROVENANCE.json').read_text())
assert sys.version.split()[0] == provenance['python_version'], 'CPython version mismatch'
assert unicodedata.unidata_version == provenance['unidata_version'], 'Unicode version mismatch'
assert Path(args.ref, '.git/HEAD').read_text().strip().startswith(provenance['upstream_commit']), 'Reference pin mismatch'
v0 = {'', 'snowflake', 'duckdb', 'hive', 'spark2', 'spark', 'databricks', 'postgres', 'redshift'}
atoms = [json.loads(line) for line in Path('corpus/atoms.jsonl').read_text().splitlines() if line]
if args.v0:
    atoms = [a for a in atoms if a['read'] in v0 and a['write'] in v0]
assert atoms, 'Empty control population'
rows = []
for a in atoms:
    gen, error, sql = None, None, None
    try:
        expr = parse_one(a['sql'], read=a['read'])
        gen = Dialect.get_or_raise(a['write']).generator(
            pretty=a['pretty'], identify=a['identify'],
            unsupported_level=ErrorLevel.RAISE if a['raises'] else ErrorLevel.IGNORE)
        sql = gen.generate(expr)
    except Exception as e:
        error = e
    messages = list(gen.unsupported_messages) if gen else []
    if error and not (a['raises'] and isinstance(error, UnsupportedError)):
        reason = 'ERROR'
    elif a['raises'] and error is None:
        reason = 'EXPECTED_ERROR_MISMATCH'
    elif not a['raises'] and sql != a['expected']:
        reason = 'SQL_MISMATCH'
    elif messages != a['unsupported']:
        reason = 'WARNING_MISMATCH'
    else:
        reason = 'PASS'
    rows.append(dict(atom_id=a['atom_id'], reason=reason, detail=str(error) if error else None))
Path(args.report).write_text(''.join(json.dumps(row) + '\n' for row in rows))
counts = {name: sum(r['reason'] == name for r in rows) for name in ['PASS', 'SQL_MISMATCH', 'WARNING_MISMATCH', 'EXPECTED_ERROR_MISMATCH', 'ERROR']}
print(json.dumps(dict(total=len(rows), exclusions=0, **counts)))
sys.exit(0 if counts['PASS'] == len(rows) else 1)
