#!/usr/bin/env python3
"""CPython oracle for the `check_command_warning` log strings (PORT_PLAN.md §7 P3 exit).

Extracted by INSTRUMENTING upstream's own `Validator.validate_identity`, not by
copying SQLs out of the test files by hand: the call sites include loops
(`for sql in [...]: self.validate_identity(sql, check_command_warning=True)`), so the
static count and the dynamic count differ, and only the dynamic one is the contract.

For each case this records:
  * the dialect and SQL,
  * the exact `logger.warning` message upstream emitted,
  * the substring `test_dialect.py:59` asserts (`f"'{sql[:100]}' contains unsupported syntax"`),
  * the token stream, so the JS side can drive `_warn_unsupported` with the same input
    without needing dialect resolution (which is P5).
"""
import json
import logging
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
# REF only — NOT REF/tests: `tests/sqlglot/` exists as a fixture package and shadows
# the real `sqlglot` if it comes first on the path.
sys.path.insert(0, REF)
os.chdir(REF)

import sqlglot  # noqa: E402

records = []


class Capture(logging.Handler):
    def emit(self, record):
        records.append(record.getMessage())


parser_logger = logging.getLogger("sqlglot")
parser_logger.addHandler(Capture())
parser_logger.setLevel(logging.WARNING)

import tests.dialects.test_dialect as td  # noqa: E402

cases = []
orig = td.Validator.validate_identity


def patched(self, sql, write_sql=None, pretty=False, check_command_warning=False, identify=False):
    if check_command_warning:
        records.clear()
        try:
            tokens = sqlglot.Dialect.get_or_raise(self.dialect).tokenize(sql)
            tok = [
                {
                    "t": t.token_type.name, "x": t.text, "line": t.line, "col": t.col,
                    "start": t.start, "end": t.end, "c": list(t.comments),
                }
                for t in tokens
            ]
        except Exception:  # noqa: BLE001
            tok = None
        try:
            sqlglot.parse_one(sql, read=self.dialect)
        except Exception:  # noqa: BLE001
            pass
        cases.append({
            "cls": type(self).__name__,
            "dialect": self.dialect,
            "sql": sql,
            "warning": records[0] if records else None,
            # py: tests/dialects/test_dialect.py:59
            "asserted_substring": f"'{sql[:100]}' contains unsupported syntax",
            "tokens": tok,
        })
    return orig(self, sql, write_sql=write_sql, pretty=pretty,
                check_command_warning=check_command_warning, identify=identify)


td.Validator.validate_identity = patched

import unittest  # noqa: E402

loader = unittest.TestLoader()
suite = loader.discover(os.path.join(REF, "tests", "dialects"), pattern="test_*.py",
                        top_level_dir=REF)
unittest.TextTestRunner(stream=open(os.devnull, "w"), verbosity=0).run(suite)

out = sys.stdout
for c in cases:
    out.write(json.dumps(c, ensure_ascii=False) + "\n")

by_dialect = {}
for c in cases:
    by_dialect[c["dialect"]] = by_dialect.get(c["dialect"], 0) + 1
print(f"  {len(cases)} check_command_warning calls: "
      + ", ".join(f"{k}={v}" for k, v in sorted(by_dialect.items())), file=sys.stderr)
missing = [c for c in cases if c["warning"] is None]
if missing:
    print(f"  {len(missing)} emitted NO warning", file=sys.stderr)
