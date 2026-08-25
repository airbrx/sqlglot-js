#!/usr/bin/env python3
"""Harvest the declarative dialect corpus at the `Validator` seam.

PORT_PLAN.md §3.1(A) and §3.2. Harvesting happens at *call* granularity on
`Validator.validate_identity` / `validate_all` / `validate_transpile` — NOT by
instrumenting `parse_one`, which sees 52 internal calls and pollutes counts.

  python3 tools/harvest/harvest.py --ref /tmp/sqlglot-ref --out corpus/atoms.jsonl

Atom model (§3.2):
  validate_identity(sql)                    on dialect d -> one atom (d, d)
  validate_all(sql, read={r: s})            on dialect d -> one atom (r, d) per entry
  validate_all(sql, write={w: t})           on dialect d -> one atom (d, w) per entry
  validate_transpile(sql, out, write=w)     on dialect d -> one atom (d, w)

The default dialect is normalised to "" (upstream stores it as both None and "").

Also captures `Generator.unsupported_messages` (§3.1(D)). `test_dialect.py` hardcodes
`unsupported_level=ErrorLevel.IGNORE` and `generator.py:965` returns early, so 497
`unsupported()` calls across the suite are otherwise silently discarded — a port that
never calls `unsupported()` would be byte-identical under the corpus.
"""

import argparse
import hashlib
import json
import os
import sys
import unittest


def h(*parts):
    m = hashlib.sha256()
    for p in parts:
        m.update(repr(p).encode("utf-8"))
        m.update(b"\x1f")
    return m.hexdigest()[:16]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default="/tmp/sqlglot-ref")
    ap.add_argument("--out", default="corpus/atoms.jsonl")
    ap.add_argument("--provenance", default="corpus/PROVENANCE.json")
    args = ap.parse_args()

    sys.path.insert(0, args.ref)

    import sqlglot
    from sqlglot import exp, parse_one, ErrorLevel, UnsupportedError
    from sqlglot.generator import Generator
    import unicodedata

    sys.path.insert(0, os.path.join(args.ref, "tests"))

    atoms = []
    seen = set()

    # ---- capture unsupported_messages (§3.1 D) --------------------------------
    # generate() resets the list then returns early under IGNORE, so we snapshot it
    # on the instance right after the base implementation runs.
    last = {"messages": []}
    orig_generate = Generator.generate

    def generate_capture(self, expression, copy=True):
        out = orig_generate(self, expression, copy=copy)
        last["messages"] = list(self.unsupported_messages)
        return out

    Generator.generate = generate_capture

    def sql_of(expression, dialect, **kw):
        """Generate and return (sql, unsupported_messages)."""
        last["messages"] = []
        out = expression.sql(dialect, **kw)
        return out, list(last["messages"])

    def norm(d):
        # §3.2: the default dialect is stored as both None and "" upstream.
        if d is None:
            return ""
        return str(d)

    def add(cls, py, read, write, sql, expected, pretty, identify, unsupported):
        read = norm(read)
        write = norm(write)
        input_id = h(sql, read, write, pretty, identify)
        expect_hash = h(expected, unsupported)
        atom_id = h(input_id, expect_hash, cls, py)
        key = (input_id, expect_hash, cls, py)
        if key in seen:
            return
        seen.add(key)
        atoms.append(
            {
                "atom_id": atom_id,
                "input_id": input_id,
                "expect_hash": expect_hash,
                "cls": cls,
                "read": read,
                "write": write,
                "sql": sql,
                "expected": expected,
                "pretty": bool(pretty),
                "identify": bool(identify),
                "unsupported": unsupported,
                "py": py,
            }
        )

    # ---- patch the Validator seam --------------------------------------------
    import tests.dialects.test_dialect as td

    V = td.Validator

    def caller_site():
        """`file:line` of the test method that issued the call."""
        f = sys._getframe(2)
        while f is not None:
            name = f.f_code.co_filename
            if "tests/dialects" in name and "test_dialect.py" not in name.rsplit("/", 1)[0]:
                rel = name.split("sqlglot-ref/")[-1]
                return f"{rel}:{f.f_lineno}"
            if "/tests/" in name:
                rel = name.split("sqlglot-ref/")[-1]
                return f"{rel}:{f.f_lineno}"
            f = f.f_back
        return "?"

    orig_identity = V.validate_identity
    orig_all = V.validate_all
    orig_transpile = V.validate_transpile

    def validate_identity(self, sql, write_sql=None, pretty=False,
                          check_command_warning=False, identify=False):
        result = orig_identity(self, sql, write_sql=write_sql, pretty=pretty,
                               check_command_warning=check_command_warning,
                               identify=identify)
        try:
            expr = parse_one(sql, read=self.dialect)
            out, msgs = sql_of(expr, self.dialect, pretty=pretty, identify=identify)
            add(type(self).__name__, caller_site(), self.dialect, self.dialect,
                sql, out, pretty, identify, msgs)
        except Exception:
            pass
        return result

    def validate_all(self, sql, read=None, write=None, pretty=False, identify=False):
        result = orig_all(self, sql, read=read, write=write, pretty=pretty, identify=identify)
        cls = type(self).__name__
        site = caller_site()
        for read_dialect, read_sql in (read or {}).items():
            try:
                expr = parse_one(read_sql, read_dialect)
                out, msgs = sql_of(expr, self.dialect, unsupported_level=ErrorLevel.IGNORE,
                                   pretty=pretty, identify=identify)
                add(cls, site, read_dialect, self.dialect, read_sql, out, pretty, identify, msgs)
            except Exception:
                pass
        for write_dialect, write_sql in (write or {}).items():
            try:
                expr = parse_one(sql, read=self.dialect)
                if write_sql is UnsupportedError:
                    # §7 P4: the 5 UnsupportedError sentinels. Record the messages that
                    # RAISE would have produced, with expected=None as the sentinel.
                    _, msgs = sql_of(expr, write_dialect,
                                     unsupported_level=ErrorLevel.IGNORE,
                                     pretty=pretty, identify=identify)
                    add(cls, site, self.dialect, write_dialect, sql, None,
                        pretty, identify, msgs)
                else:
                    out, msgs = sql_of(expr, write_dialect,
                                       unsupported_level=ErrorLevel.IGNORE,
                                       pretty=pretty, identify=identify)
                    add(cls, site, self.dialect, write_dialect, sql, out,
                        pretty, identify, msgs)
            except Exception:
                pass
        return result

    def validate_transpile(self, sql, write_sql, write_dialect=None):
        result = orig_transpile(self, sql, write_sql, write_dialect=write_dialect)
        try:
            expr = parse_one(sql, read=self.dialect)
            out, msgs = sql_of(expr, write_dialect)
            # §3.2: resolved as (self.dialect -> write_dialect), which is the 4-atom
            # delta against the independent derivation noted in the plan.
            add(type(self).__name__, caller_site(), self.dialect, write_dialect,
                sql, out, False, False, msgs)
        except Exception:
            pass
        return result

    V.validate_identity = validate_identity
    V.validate_all = validate_all
    V.validate_transpile = validate_transpile

    # ---- run the dialect suite ------------------------------------------------
    loader = unittest.TestLoader()
    suite = loader.discover(
        os.path.join(args.ref, "tests", "dialects"),
        pattern="test_*.py",
        top_level_dir=args.ref,
    )
    runner = unittest.TextTestRunner(stream=open(os.devnull, "w"), verbosity=0)
    res = runner.run(suite)

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf8") as f:
        for a in atoms:
            f.write(json.dumps(a, separators=(",", ":"), ensure_ascii=False) + "\n")

    # ---- provenance (§8.2 item 7, CONTRACTS.md §7) ----------------------------
    import subprocess

    commit = subprocess.run(
        ["git", "-C", args.ref, "rev-parse", "--short", "HEAD"],
        capture_output=True, text=True,
    ).stdout.strip()
    prov = {
        "upstream_commit": commit,
        "python_version": sys.version.split()[0],
        "unidata_version": unicodedata.unidata_version,
        "atom_count": len(atoms),
        "tests_run": res.testsRun,
        "test_failures": len(res.failures),
        "test_errors": len(res.errors),
        "tool_versions": {"harvest": "1"},
    }
    os.makedirs(os.path.dirname(args.provenance) or ".", exist_ok=True)
    with open(args.provenance, "w", encoding="utf8") as f:
        json.dump(prov, f, indent=2)
        f.write("\n")

    n_unsup = sum(1 for a in atoms if a["unsupported"])
    print(f"  atoms:            {len(atoms)}", file=sys.stderr)
    print(f"  with unsupported: {n_unsup}", file=sys.stderr)
    print(f"  upstream tests:   {res.testsRun} run, "
          f"{len(res.failures)} failed, {len(res.errors)} errored", file=sys.stderr)
    print(f"  provenance:       {prov['python_version']} / unidata "
          f"{prov['unidata_version']} / {commit}", file=sys.stderr)


if __name__ == "__main__":
    main()
