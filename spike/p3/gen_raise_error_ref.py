#!/usr/bin/env python3
"""CPython oracle for `Parser.raise_error` — message, ParseError.errors, and columns.

Covers two §7 P3 exit criteria at once, because they are the same code path:

  * "`ParseError.errors` structure matches `test_errors.py`" — the seven-key dict
    `ParseError.new` builds. (`test_errors.py` in this fork only exercises
    `highlight_sql` directly, which the P0 bridge proof already runs green; the dict
    itself is only reachable through `raise_error`.)

  * "`fuzz_unicode` green over error-message column positions" — so the inputs
    deliberately include astral characters, combining marks, RTL text and Unicode
    whitespace. A UTF-16 slice cuts a surrogate pair in half and shifts every column
    after it; a code-point slice does not. Any input where `sql[:n]` and the port's
    code-point slice disagree shows up as a differing `start_context`/`highlight`.

Every token of every input is raised on, at several `error_message_context` values.
"""
import json
import logging
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)
logging.disable(logging.CRITICAL)
import sqlglot  # noqa: E402
from sqlglot.errors import ErrorLevel, ParseError  # noqa: E402
from sqlglot.parser import Parser  # noqa: E402
from sqlglot.tokens import Tokenizer  # noqa: E402

SQLS = [
    "SELECT a FROM t",
    "SELECT a, b, c FROM table WHERE x = 1",
    "SELECT 1",
    "SELECT",
    # --- astral / non-BMP: each is ONE code point but TWO UTF-16 units ---
    "SELECT 😀 FROM t",
    "SELECT a FROM 😀😀😀",
    "SELECT '😀' AS x FROM t WHERE y = '😀'",
    "SELECT 𐌀𐌁𐌂 FROM t",
    "SELECT \"𝕏\" FROM \"𝕐\"",
    # --- combining marks: one grapheme, several code points ---
    "SELECT é FROM café",
    "SELECT à́̂ FROM t",
    # --- RTL and bidi ---
    "SELECT אבג FROM الجدول",
    # --- Unicode whitespace / format chars ---
    "SELECT a FROM t",
    "SELECT a​b FROM t",
    # --- long, to exercise the context window on both sides of the highlight ---
    "SELECT " + ", ".join(f"col{i}" for i in range(60)) + " FROM some_quite_long_table_name",
    "SELECT " + "😀" * 80 + " FROM t",
    # --- surrounding astral so the truncation boundary lands mid-pair if sliced wrong
    "SELECT " + "😀" * 49 + "X" + "😀" * 49 + " FROM t",
]

CONTEXTS = [100, 5, 1, 0, 3]

n = 0
for sql in SQLS:
    try:
        tokens = Tokenizer().tokenize(sql)
    except Exception:  # noqa: BLE001
        continue
    for ctx in CONTEXTS:
        for ti in range(len(tokens)):
            p = Parser(error_level=ErrorLevel.IMMEDIATE, error_message_context=ctx)
            p.reset()
            p.sql = sql
            p._tokens = tokens
            p._tokens_size = len(tokens)
            try:
                p.raise_error("Invalid expression / Unexpected token", tokens[ti])
                out = {"raised": False}
            except ParseError as e:
                out = {
                    "raised": True,
                    "message": str(e),
                    "errors": e.errors,
                }
            n += 1
            print(json.dumps({
                "sql": sql, "ctx": ctx, "ti": ti,
                "token": {
                    "t": tokens[ti].token_type.name, "x": tokens[ti].text,
                    "line": tokens[ti].line, "col": tokens[ti].col,
                    "start": tokens[ti].start, "end": tokens[ti].end,
                    "c": list(tokens[ti].comments),
                },
                "out": out,
            }, ensure_ascii=False))

# The no-token fallback chain: `token or self._curr or self._prev or Token.string("")`.
for sql in SQLS[:6]:
    for ctx in CONTEXTS:
        p = Parser(error_level=ErrorLevel.IMMEDIATE, error_message_context=ctx)
        p.reset()
        p.sql = sql
        try:
            p.raise_error("no tokens at all")
            out = {"raised": False}
        except ParseError as e:
            out = {"raised": True, "message": str(e), "errors": e.errors}
        n += 1
        print(json.dumps({"sql": sql, "ctx": ctx, "ti": None, "token": None, "out": out},
                         ensure_ascii=False))

print(f"  {n} raise_error cases over {len(SQLS)} SQLs x {len(CONTEXTS)} context lengths",
      file=sys.stderr)
