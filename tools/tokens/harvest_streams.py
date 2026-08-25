#!/usr/bin/env python3
"""Harvest Python's token stream for every tokenizable string in the corpus.

PORT_PLAN.md §7 P1 exit ("token streams byte-exact across all corpus inputs").

  python3 tools/tokens/harvest_streams.py     # writes corpus/tokens/streams.jsonl

Inputs, three sources, deduplicated on (dialect, sql):

  1. (atom.read, atom.sql)        — the real tokenization workload
  2. ("",        atom.sql)        — every input under the DEFAULT tokenizer, which is
                                    the only tokenizer P1 actually ports; this is what
                                    makes the base `Tokenizer` tables load-bearing
                                    rather than incidentally exercised
  3. (atom.write, atom.expected)  — generated SQL is also valid tokenizer input, and it
                                    is the half of the corpus that carries the dialects'
                                    own quoting styles

Versioned dialect keys ("postgres, version=17.5") resolve to the same tokenizer as
their base, so they collapse into the base key at dedup time rather than emitting a
duplicate stream.

Every row is either a full token stream or the TokenError the tokenizer raised.
Errors are part of the contract, not omissions: only 17 of the 23,457 rows raise, and
a port that turns any of them into a successful parse — or vice versa — has diverged.

Row shape, one JSON object per line:

    {"id": <sha256(dialect \\x1f sql)[:16]>, "d": <dialect>, "s": <sql>,
     "t": [[type, text, line, col, start, end, comments?], ...]}
    {"id": ..., "d": ..., "s": ..., "e": ["TokenError", <message>]}

`text` is `null` whenever it equals `sql[start:end+1]` (276,230 of 291,955 tokens,
94.6%). This is not just a size trick: a non-null `text` marks precisely the places
where the tokenizer *synthesizes* text rather than echoing the source — uppercased
keywords, extracted string bodies, `100_000` -> `100000`, the `::` it injects after a
numeric literal. Those 15,725 tokens are the interesting ones, and they are now the
ones that stand out when reading the file. The checker reconstructs the null case from
this row's own `s`, so `token.text` is still compared against the true value on every
token; `start`/`end` are compared independently, so a slice bug cannot hide inside the
reconstruction. Trailing empty `comments` are omitted for the same reason.
"""

import hashlib
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)

ATOMS = "corpus/atoms.jsonl"
OUT = "corpus/tokens/streams.jsonl"


def main():
    from sqlglot.dialects.dialect import Dialect
    from sqlglot.errors import SqlglotError

    # dialect key -> tokenizer instance. Keyed by the NORMALIZED name so
    # "postgres, version=17.5" and "postgres" share one entry.
    tokenizers = {}

    def normalize(name):
        base = (name or "").split(",", 1)[0].strip()
        return base

    def tokenizer_for(name):
        if name not in tokenizers:
            tokenizers[name] = Dialect.get_or_raise(name).tokenizer()
        return tokenizers[name]

    seen = set()
    work = []

    def add(dialect, sql):
        if not isinstance(sql, str):
            return
        d = normalize(dialect)
        key = (d, sql)
        if key in seen:
            return
        seen.add(key)
        work.append(key)

    with open(ATOMS, encoding="utf8") as f:
        for line in f:
            if not line.strip():
                continue
            atom = json.loads(line)
            add(atom.get("read"), atom.get("sql"))
            add("", atom.get("sql"))
            add(atom.get("write"), atom.get("expected"))

    # Stable order: the harvest must be byte-reproducible across runs (PROVENANCE).
    work.sort()

    n_ok = n_err = n_tokens = n_synth = 0
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf8") as out:
        for dialect, sql in work:
            row = {
                "id": hashlib.sha256(
                    f"{dialect}\x1f{sql}".encode("utf8")
                ).hexdigest()[:16],
                "d": dialect,
                "s": sql,
            }
            try:
                tokens = tokenizer_for(dialect).tokenize(sql)
            except SqlglotError as e:
                row["e"] = [type(e).__name__, str(e)]
                n_err += 1
            else:
                stream = []
                for t in tokens:
                    # `sql[a:b]` slices CODE POINTS in Python; the JS checker slices the
                    # code-point array, never the UTF-16 string (CONTRACTS.md §2).
                    echoed = sql[t.start : t.end + 1] == t.text
                    entry = [
                        t.token_type.name,
                        None if echoed else t.text,
                        t.line,
                        t.col,
                        t.start,
                        t.end,
                    ]
                    if t.comments:
                        entry.append(t.comments)
                    stream.append(entry)
                    n_synth += 0 if echoed else 1
                row["t"] = stream
                n_tokens += len(tokens)
                n_ok += 1
            out.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
            out.write("\n")

    print(
        f"  {OUT}: {len(work)} rows over {len(tokenizers)} dialects — "
        f"{n_ok} streams ({n_tokens} tokens, {n_synth} with synthesized text), "
        f"{n_err} TokenErrors",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
