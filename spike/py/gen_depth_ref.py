#!/usr/bin/env python3
"""CPython's own max-N per tokenizer path, so §4.7's JS numbers have a baseline.

  python3 spike/py/gen_depth_ref.py > spike/out/depth_py.json

Added at P1. `TokenizerCore._add` recurses into `_scan`, which can recurse back into
`_add`, whenever a COMMAND token follows a `;` or `BEGIN` (tokenizer_core.py:789-800).
Depth therefore grows with INPUT SIZE, not with query nesting — the §4.7 / R11 class,
found in the tokenizer rather than the generator.

The recursion limit is left at CPython's DEFAULT. sqlglot does not call
`sys.setrecursionlimit`, so the default is what an unmodified caller actually gets, and
it is the only honest thing to compare a fixed JS stack against.
"""

import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)

# Same shape as spike/fuzz_depth.mjs's GENERATORS entry of the same name.
PATHS = {
    "commandChain": lambda n: "BEGIN SHOW " * n,
    "semicolonCommandChain": lambda n: "; SHOW x " * n,
}


def main():
    from sqlglot.dialects.dialect import Dialect

    tokenizer = Dialect.get_or_raise("").tokenizer()
    out = {
        "python_version": sys.version.split()[0],
        "recursionlimit": sys.getrecursionlimit(),
        "paths": {},
    }

    for name, gen in PATHS.items():
        # Largest N that tokenizes without the recursion collapsing. `tokenize` catches
        # RecursionError and re-raises it as TokenError, so success is the signal, not
        # the exception type.
        lo, hi = 0, 1
        while hi <= 100_000:
            try:
                tokenizer.tokenize(gen(hi))
            except Exception:  # noqa: BLE001
                break
            lo = hi
            hi *= 2
        else:
            out["paths"][name] = {"max_n": lo, "saturated": True}
            continue

        while lo + 1 < hi:
            mid = (lo + hi) // 2
            try:
                tokenizer.tokenize(gen(mid))
                lo = mid
            except Exception:  # noqa: BLE001
                hi = mid
        out["paths"][name] = {"max_n": lo, "saturated": False}

    json.dump(out, sys.stdout, indent=1)
    sys.stdout.write("\n")
    print(
        "  depth_py: "
        + ", ".join(f"{k}={v['max_n']}" for k, v in out["paths"].items())
        + f" (CPython {out['python_version']}, recursionlimit {out['recursionlimit']})",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
