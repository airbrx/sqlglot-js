#!/usr/bin/env python3
"""The two P0 end-to-end bridge proofs.

PORT_PLAN.md §3.8: "Proxy-satisfiability is proven at P0, not assumed at P5." The bridge
was narrowed (M15/M16) to exactly the tests that compare OBJECT GRAPHS — the workload it
is least able to serve — so discovering its ceiling at P5 would be a four-month-late
surprise.

  python3 tools/bridge/proof.py

Runs UPSTREAM'S OWN tests/test_errors.py against the JS library through the NDJSON
proxy, by substituting `sqlglot.errors.highlight_sql` with a proxy that forwards to
Node. That is the real proof: upstream's assertions, unmodified, against our code.

test_transpile.py is the second proof and needs `transpile`, which does not exist until
P4. Its satisfiability is measured here (how many of its assertions the proxy COULD
serve) rather than asserted, and recorded in CONTRACTS.md §5.
"""

import ast
import json
import os
import subprocess
import sys
import unittest

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)


class Bridge:
    """Python-side proxy over the NDJSON protocol (CONTRACTS.md §5)."""

    def __init__(self):
        self.proc = subprocess.Popen(
            ["node", "tools/bridge/server.mjs"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self._id = 0

    def _rpc(self, **req):
        self._id += 1
        req["id"] = self._id
        self.proc.stdin.write(json.dumps(req) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("bridge died")
        res = json.loads(line)
        if not res.get("ok"):
            err = res.get("error", {})
            raise _remote_error(err)
        return res["result"]

    def call(self, target, *args):
        return self._rpc(op="call", target=target, args=list(args))

    def get(self, target):
        return self._rpc(op="get", target=target)

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=5)
        except Exception:  # noqa: BLE001
            self.proc.kill()


def _remote_error(err):
    """Map a JS error back to the Python exception type the test expects."""
    t = err.get("type", "Error")
    msg = err.get("message", "")
    cls = {"ValueError": ValueError, "TypeError": TypeError, "KeyError": KeyError}.get(t)
    if cls is not None:
        return cls(msg)
    return RuntimeError(f"{t}: {msg}")


def count_assertions(path):
    """How many assertEqual/assertRaises calls a test module contains."""
    with open(path, encoding="utf8") as f:
        tree = ast.parse(f.read())
    n = 0
    literals = 0
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if node.func.attr.startswith("assert"):
                n += 1
                if any(isinstance(a, ast.Constant) and isinstance(a.value, str)
                       for a in node.args):
                    literals += 1
    return n, literals


def main():
    bridge = Bridge()
    failures = []

    # ---- protocol smoke ------------------------------------------------------
    assert bridge.call("errors.concatMessages", ["a", "b", "c"], 2) == "a\n\nb\n\n... and 1 more"
    print("  ok   NDJSON protocol round-trips")

    # ---- PROOF 1: upstream's tests/test_errors.py, unmodified ---------------
    import sqlglot.errors as pyerrors

    original = pyerrors.highlight_sql

    def proxied_highlight_sql(sql, positions, context_length=100):
        # Tuples become arrays over JSON; the JS side returns an array we tuple-ise.
        out = bridge.call(
            "errors.highlightSql", sql, [list(p) for p in positions], context_length
        )
        return tuple(out)

    pyerrors.highlight_sql = proxied_highlight_sql

    # test_errors.py imports the symbol directly, so patch the module it landed in too.
    import tests.test_errors as te

    if hasattr(te, "highlight_sql"):
        te.highlight_sql = proxied_highlight_sql

    suite = unittest.TestLoader().loadTestsFromModule(te)
    n_assert, n_lit = count_assertions(os.path.join(REF, "tests/test_errors.py"))
    result = unittest.TextTestRunner(stream=open(os.devnull, "w"), verbosity=0).run(suite)
    pyerrors.highlight_sql = original

    ok1 = result.wasSuccessful()
    print(
        f"  {'ok  ' if ok1 else 'FAIL'} PROOF 1  tests/test_errors.py through the bridge: "
        f"{result.testsRun} tests, {len(result.failures)} failed, {len(result.errors)} errored "
        f"({n_assert} assertions, {n_lit} with string literals)"
    )
    if not ok1:
        for t, tb in (result.failures + result.errors)[:3]:
            print(f"      {t}\n{tb.splitlines()[-1] if tb else ''}")
        failures.append("proof1")

    # ---- PROOF 2: test_transpile.py satisfiability --------------------------
    # `transpile` lands at P4, so what is provable NOW is whether the proxy COULD serve
    # this module: its assertions must be over strings, not object graphs.
    tp = os.path.join(REF, "tests/test_transpile.py")
    n2, lit2 = count_assertions(tp)
    with open(tp, encoding="utf8") as f:
        tree = ast.parse(f.read())
    # Any assertion whose argument is an `exp.` attribute access is comparing an object
    # graph and is NOT proxy-satisfiable without a real remote object model.
    graphy = 0
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if node.func.attr.startswith("assert"):
                src = ast.dump(node)
                if "'exp'" in src or "parse_one" in src:
                    graphy += 1
    pct = 100 * (n2 - graphy) / n2 if n2 else 0
    print(
        f"  ok   PROOF 2  tests/test_transpile.py satisfiability: {n2} assertions, "
        f"{graphy} touch object graphs, {pct:.0f}% string-only "
        f"(needs `transpile`, lands P4)"
    )

    bridge.close()

    print(
        "\n  BRIDGE PROOFS: GREEN\n" if not failures else f"\n  BRIDGE PROOFS: RED ({failures})\n"
    )
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
