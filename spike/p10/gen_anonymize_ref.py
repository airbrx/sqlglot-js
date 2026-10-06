#!/usr/bin/env python3
"""CPython oracle for AIR-2123 ("9.3 anonymize.js").

Reproduces EVERY assertion in `tests/test_anonymize.py` (`TestAnonymize`, 24 test
methods) as one row per assertion, calling the REAL upstream `sqlglot.anonymize`
module (`anonymize`/`render`) rather than re-deriving expected output by hand. No
`PYTHONHASHSEED`-sensitive randomization is involved anywhere in this module: there
is no `hash()`/`hashlib` call in `sqlglot/anonymize.py` at all, so `PYTHONHASHSEED=0`
here is belt-and-suspenders consistency with every other P-series generator, not a
load-bearing requirement for this particular oracle.

Two row kinds:
  "tokens"  `anonymize(sql, dialect)`'s own token stream, compared as a list of
            [token_type_name, text, comments].
  "render"  `render(sql, anonymize(sql, dialect), dialect)`, compared as a string,
            optionally asserting `len(rendered) == len(sql)` (upstream's own
            length-preservation invariant, checked by most of its `render` cases).

    PYTHONHASHSEED=0 python3 spike/p10/gen_anonymize_ref.py > spike/out/anonymize.json
    node spike/p10/fuzz_anonymize.mjs
"""
import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-complete-pin")
sys.path.insert(0, REF)
os.chdir(REF)

from sqlglot.anonymize import anonymize, render  # noqa: E402
from sqlglot.tokens import Tokenizer, TokenType  # noqa: E402

rows = []


def add_tokens_row(name, sql, dialect=None, expect_tokens=None):
    """Mirrors `TestAnonymize.assert_anonymized` — compares the FULL anonymized
    token stream (type, text, comments) for a string input."""
    tokens = anonymize(sql, dialect)
    got = [[t.token_type.name, t.text, t.comments] for t in tokens]
    rows.append({
        "name": name,
        "kind": "tokens",
        "sql": sql,
        "dialect": dialect,
        "want": got,  # the pin IS the oracle; "want" is what CPython itself produced
    })
    if expect_tokens is not None:
        # Extra assertion the generator itself makes against the test file's inline
        # comments, so a typo in this script's own transcription is caught here
        # rather than silently producing a wrong "want".
        simple = [[t.token_type.name, t.text] for t in tokens]
        assert simple == expect_tokens, f"{name}: {simple} != {expect_tokens}"


def add_render_row(name, sql, dialect=None, expect=None, check_len=True):
    """Mirrors every `render(sql, anonymize(sql, dialect), dialect)` assertion."""
    rendered = render(sql, anonymize(sql, dialect), dialect)
    rows.append({
        "name": name,
        "kind": "render",
        "sql": sql,
        "dialect": dialect,
        "want": rendered,
        "check_len": check_len,
    })
    if expect is not None:
        assert rendered == expect, f"{name}: {rendered!r} != {expect!r}"
    if check_len:
        assert len(rendered) == len(sql), f"{name}: len mismatch"


# --------------------------------------------------------------------------- #
# test_identifiers_rewritten
# --------------------------------------------------------------------------- #
add_tokens_row(
    "test_identifiers_rewritten", "SELECT foo FROM bar",
    expect_tokens=[["SELECT", "SELECT"], ["VAR", "aaa"], ["FROM", "FROM"], ["VAR", "aab"]],
)

# test_consistent_within_call
add_tokens_row(
    "test_consistent_within_call", "SELECT a, a, b FROM t",
    expect_tokens=[
        ["SELECT", "SELECT"], ["VAR", "a"], ["COMMA", ","], ["VAR", "a"],
        ["COMMA", ","], ["VAR", "b"], ["FROM", "FROM"], ["VAR", "c"],
    ],
)

# test_quoted_identifier_shares_alias
add_tokens_row(
    "test_quoted_identifier_shares_alias", 'SELECT foo, "foo"',
    expect_tokens=[["SELECT", "SELECT"], ["VAR", "aaa"], ["COMMA", ","], ["IDENTIFIER", "aaa"]],
)

# test_strings_rewritten
add_tokens_row(
    "test_strings_rewritten", "SELECT 'hello', 'world' FROM t",
    expect_tokens=[
        ["SELECT", "SELECT"], ["STRING", "aaaaa"], ["COMMA", ","], ["STRING", "aaaab"],
        ["FROM", "FROM"], ["VAR", "c"],
    ],
)

# test_whitespace
add_tokens_row(
    "test_whitespace",
    "SELECT 'line1\nline2', 'spam  eggs', 'a\tb', \"my table\" FROM t",
    expect_tokens=[
        ["SELECT", "SELECT"], ["STRING", "aaaaa\naaaaa"], ["COMMA", ","],
        ["STRING", "aaaa  aaab"], ["COMMA", ","], ["STRING", "a\tc"], ["COMMA", ","],
        ["IDENTIFIER", "aa aaaad"], ["FROM", "FROM"], ["VAR", "e"],
    ],
)

# test_reserved_keywords_not_rewritten
add_tokens_row(
    "test_reserved_keywords_not_rewritten", "SELECT * FROM window, OUT, apple",
    expect_tokens=[
        ["SELECT", "SELECT"], ["STAR", "*"], ["FROM", "FROM"], ["WINDOW", "window"],
        ["COMMA", ","], ["OUT", "OUT"], ["COMMA", ","], ["VAR", "aaaaa"],
    ],
)

# test_tokenize_error_tail_blanked
add_tokens_row(
    "test_tokenize_error_tail_blanked", "SELECT foo, 'secret tail",
    expect_tokens=[
        ["SELECT", "SELECT"], ["VAR", "aaa"], ["COMMA", ","], ["UNKNOWN", "'s.........."],
    ],
)

# test_comments_redacted — this one also checks `comments`, so go through the full
# [type, text, comments] row rather than the `expect_tokens` [type, text] shortcut.
_toks = anonymize("SELECT a -- secret comment\nFROM t")
assert [[t.token_type.name, t.text, t.comments] for t in _toks] == [
    ["SELECT", "SELECT", []], ["VAR", "a", [" ...... ......."]], ["FROM", "FROM", []],
    ["VAR", "b", []],
], _toks
add_tokens_row("test_comments_redacted", "SELECT a -- secret comment\nFROM t")

# test_tpcds_query_reserialized
_TPCDS_SQL = """WITH inv
     AS (SELECT w_warehouse_name,
                w_warehouse_sk,
                i_item_sk,
                d_moy,
                stdev,
                mean,
                CASE mean
                  WHEN 0 THEN NULL
                  ELSE stdev / mean
                END cov
         FROM  (SELECT w_warehouse_name,
                       w_warehouse_sk,
                       i_item_sk,
                       d_moy,
                       Stddev_samp(inv_quantity_on_hand) stdev,
                       Avg(inv_quantity_on_hand)         mean
                FROM   inventory,
                       item,
                       warehouse,
                       date_dim
                WHERE  inv_item_sk = i_item_sk
                       AND inv_warehouse_sk = w_warehouse_sk
                       AND inv_date_sk = d_date_sk
                       AND d_year = 2002
                GROUP  BY w_warehouse_name,
                          w_warehouse_sk,
                          i_item_sk,
                          d_moy) foo
         WHERE  CASE mean
                  WHEN 0 THEN 0
                  ELSE stdev / mean
                END > 1)
SELECT inv1.w_warehouse_sk,
       inv1.i_item_sk,
       inv1.d_moy,
       inv1.mean,
       inv1.cov,
       inv2.w_warehouse_sk,
       inv2.i_item_sk,
       inv2.d_moy,
       inv2.mean,
       inv2.cov
FROM   inv inv1,
       inv inv2
WHERE  inv1.i_item_sk = inv2.i_item_sk
       AND inv1.w_warehouse_sk = inv2.w_warehouse_sk
       AND inv1.d_moy = 1
       AND inv2.d_moy = 1 + 1
ORDER  BY inv1.w_warehouse_sk,
          inv1.i_item_sk,
          inv1.d_moy,
          inv1.mean,
          inv1.cov,
          inv2.d_moy,
          inv2.mean,
          inv2.cov;"""
_TPCDS_EXPECTED = """WITH aaa
     AS (SELECT aaaaaaaaaaaaaaab,
                aaaaaaaaaaaaac,
                aaaaaaaad,
                aaaae,
                aaaaf,
                aaag,
                CASE aaag
                  WHEN 8 THEN NULL
                  ELSE aaaaf / aaag
                END aai
         FROM  (SELECT aaaaaaaaaaaaaaab,
                       aaaaaaaaaaaaac,
                       aaaaaaaad,
                       aaaae,
                       Stddev_samp(aaaaaaaaaaaaaaaaaaaj) aaaaf,
                       Avg(aaaaaaaaaaaaaaaaaaaj)         aaag
                FROM   aaaaaaaak,
                       aaal,
                       aaaaaaaam,
                       aaaaaaan
                WHERE  aaaaaaaaaao = aaaaaaaad
                       AND aaaaaaaaaaaaaaap = aaaaaaaaaaaaac
                       AND aaaaaaaaaaq = aaaaaaaar
                       AND aaaaas = 1019
                GROUP  BY aaaaaaaaaaaaaaab,
                          aaaaaaaaaaaaac,
                          aaaaaaaad,
                          aaaae) aau
         WHERE  CASE aaag
                  WHEN 8 THEN 8
                  ELSE aaaaf / aaag
                END > 4)
SELECT aaaw.aaaaaaaaaaaaac,
       aaaw.aaaaaaaad,
       aaaw.aaaae,
       aaaw.aaag,
       aaaw.aai,
       aaax.aaaaaaaaaaaaac,
       aaax.aaaaaaaad,
       aaax.aaaae,
       aaax.aaag,
       aaax.aai
FROM   aaa aaaw,
       aaa aaax
WHERE  aaaw.aaaaaaaad = aaax.aaaaaaaad
       AND aaaw.aaaaaaaaaaaaac = aaax.aaaaaaaaaaaaac
       AND aaaw.aaaae = 4
       AND aaax.aaaae = 4 + 4
ORDER  BY aaaw.aaaaaaaaaaaaac,
          aaaw.aaaaaaaad,
          aaaw.aaaae,
          aaaw.aaag,
          aaaw.aai,
          aaax.aaaae,
          aaax.aaag,
          aaax.aai;"""
add_render_row("test_tpcds_query_reserialized", _TPCDS_SQL, expect=_TPCDS_EXPECTED)

# test_functions_anonymized
add_tokens_row(
    "test_functions_anonymized_1",
    "SELECT SUM(x), my_udf(...), CURRENT_DATE, CASE WHEN 1 THEN 2 ELSE 3 END",
    expect_tokens=[
        ["SELECT", "SELECT"], ["VAR", "SUM"], ["L_PAREN", "("], ["VAR", "a"],
        ["R_PAREN", ")"], ["COMMA", ","], ["VAR", "aaaaab"], ["L_PAREN", "("],
        ["DOT", "."], ["DOT", "."], ["DOT", "."], ["R_PAREN", ")"], ["COMMA", ","],
        ["CURRENT_DATE", "CURRENT_DATE"], ["COMMA", ","], ["CASE", "CASE"],
        ["WHEN", "WHEN"], ["NUMBER", "3"], ["THEN", "THEN"], ["NUMBER", "4"],
        ["ELSE", "ELSE"], ["NUMBER", "5"], ["END", "END"],
    ],
)
# JSON_OBJECT is registered in FUNCTION_PARSERS rather than FUNCTIONS
add_tokens_row(
    "test_functions_anonymized_2", "SELECT JSON_OBJECT('k', v)",
    expect_tokens=[
        ["SELECT", "SELECT"], ["VAR", "JSON_OBJECT"], ["L_PAREN", "("],
        ["STRING", "a"], ["COMMA", ","], ["VAR", "b"], ["R_PAREN", ")"],
    ],
)

# test_string_family_forms_anonymized
add_tokens_row(
    "test_string_family_forms_anonymized", "SELECT N'nat', $$her$$, x'4141'",
    dialect="snowflake",
    expect_tokens=[
        ["SELECT", "SELECT"], ["NATIONAL_STRING", "aaa"], ["COMMA", ","],
        ["RAW_STRING", "aab"], ["COMMA", ","], ["HEX_STRING", "aaac"],
    ],
)

# test_empty_input
rows.append({"name": "test_empty_input_1", "kind": "tokens", "sql": "", "dialect": None, "want": []})
rows.append({"name": "test_empty_input_2", "kind": "tokens", "sql": "   ", "dialect": None, "want": []})
assert anonymize("") == []
assert anonymize("   ") == []

# test_identifiers_with_spaces_stay_distinct
add_tokens_row(
    "test_identifiers_with_spaces_stay_distinct", 'SELECT "a b", "a c"',
    expect_tokens=[
        ["SELECT", "SELECT"], ["IDENTIFIER", "a a"], ["COMMA", ","], ["IDENTIFIER", "a b"],
    ],
)

# test_number_and_string_same_text_stay_distinct
add_tokens_row(
    "test_number_and_string_same_text_stay_distinct", "SELECT 123, '123'",
    expect_tokens=[["SELECT", "SELECT"], ["NUMBER", "100"], ["COMMA", ","], ["STRING", "aab"]],
)

# test_comments_blanked_in_reserialization
add_render_row(
    "test_comments_blanked_in_reserialization", "SELECT a -- secret comment\nFROM t",
    expect="SELECT a -- ...... .......\nFROM b",
)

# test_huge_numeric_literal_no_crash
_huge_sql = "SELECT " + "1" * 4500
_huge_tokens = anonymize(_huge_sql)
assert _huge_tokens[1].token_type == TokenType.NUMBER
assert len(_huge_tokens[1].text) == 4500
rows.append({
    "name": "test_huge_numeric_literal_no_crash",
    "kind": "huge_numeric",
    "sql": _huge_sql,
    "dialect": None,
    "want": {"token_type": _huge_tokens[1].token_type.name, "text_len": len(_huge_tokens[1].text)},
})

# test_known_function_kept_when_passing_tokens — anonymize() called on a TOKEN LIST,
# not a SQL string (the `sql_or_tokens` str-vs-list branch).
_known_fn_tokens = Tokenizer(dialect="snowflake").tokenize("SELECT TO_VARIANT(x) FROM t")
_known_fn_result = anonymize(_known_fn_tokens, "snowflake")
rows.append({
    "name": "test_known_function_kept_when_passing_tokens",
    "kind": "tokens_input",
    "sql_for_tokenizing": "SELECT TO_VARIANT(x) FROM t",
    "dialect": "snowflake",
    "want": [[t.token_type.name, t.text] for t in _known_fn_result],
})
assert [[t.token_type.name, t.text] for t in _known_fn_result] == [
    ["SELECT", "SELECT"], ["VAR", "TO_VARIANT"], ["L_PAREN", "("], ["VAR", "a"],
    ["R_PAREN", ")"], ["FROM", "FROM"], ["VAR", "b"],
]

# test_known_function_comment_still_blanked
add_tokens_row(
    "test_known_function_comment_still_blanked", "SELECT sum/* secretpassword */(x)",
)
_sum_toks = anonymize("SELECT sum/* secretpassword */(x)")
assert [[t.token_type.name, t.text, t.comments] for t in _sum_toks] == [
    ["SELECT", "SELECT", []], ["VAR", "sum", [" .............. "]], ["L_PAREN", "(", []],
    ["VAR", "a", []], ["R_PAREN", ")", []],
], _sum_toks

# test_quotes_preserved
for sql, expect, dialect in [
    ("SELECT 'hello' AS x", "SELECT 'aaaaa' AS b", None),
    ("SELECT 'a''b'", "SELECT 'aaaa'", None),
    ("SELECT ''", "SELECT ''", None),
    ("SELECT N'nat', x'4141'", "SELECT N'aaa', x'aaab'", "snowflake"),
    ('SELECT "my table"', 'SELECT "aa aaaaa"', None),
    ("SELECT `back tick`", "SELECT `aaaa aaaa`", "mysql"),
    ("SELECT [brack et]", "SELECT [aaaaa aa]", "tsql"),
    ("SELECT $$her$$, $tag$body$tag$", "SELECT $$aaa$$, $tag$aaab$tag$", "postgres"),
]:
    add_render_row(f"test_quotes_preserved[{sql!r}]", sql, dialect=dialect, expect=expect)

# test_source_spelling_preserved
for sql, expect in [
    ("SELECT a FROM t GROUP  BY a", "SELECT a FROM b GROUP  BY a"),
    ("SELECT a ORDER   BY a", "SELECT a ORDER   BY a"),
    ("select * from window, OUT", "select * from window, OUT"),
]:
    add_render_row(f"test_source_spelling_preserved[{sql!r}]", sql, expect=expect)

# test_numbers_keep_their_shape
add_render_row(
    "test_numbers_keep_their_shape", "SELECT 1e, 1.e, 1e10, .5, 2002, 1e-5, 1E+2",
    expect="SELECT 1e, 2.e, 3e10, .4, 1004, 6e-1, 7E+1",
)

# test_hints_anonymized
for sql, expect, dialect in [
    ("SELECT /*+ INDEX(customers ssn_idx) */ a FROM t",
     "SELECT /*+ ............... ........ */ a FROM b", None),
    ("SELECT /*+ BROADCAST(`y`) */ x FROM y",
     "SELECT /*+ .............. */ a FROM b", "spark"),
    ("INSERT /*+ APPEND */ INTO t VALUES (1)",
     "INSERT /*+ ...... */ INTO a VALUES (2)", "oracle"),
    ("SELECT a /*+ INDEX(secret) */ b", "SELECT a /*+ ............. */ b", None),
    ("SELECT /*+ INDEX(customers)\n           MORE(ssn) */ a FROM t",
     "SELECT /*+ ................\n           ......... */ a FROM b", None),
]:
    add_render_row(f"test_hints_anonymized[{sql!r}]", sql, dialect=dialect, expect=expect)

# test_hint_does_not_desync_following_comments
add_render_row(
    "test_hint_does_not_desync_following_comments",
    "SELECT /*+ x */ a -- password is hunter2\nFROM t",
    expect="SELECT /*+ . */ a -- ........ .. .......\nFROM b",
)

# test_comments_without_tokens
for sql, expect in [
    ("-- top secret", "-- ... ......"),
    ("/* COMMENT */", "/* ....... */"),
    ("/*", "/*"),
]:
    add_render_row(f"test_comments_without_tokens[{sql!r}]", sql, expect=expect)

# test_tokenize_error_keeps_delimiter
for sql, expect, dialect in [
    ("SELECT a, 'unterminated string", "SELECT a, 'u..................", None),
    ("SELECT a, /* unterminated comment", "SELECT a, /*.....................", None),
    ('SELECT a, "unterminated ident', 'SELECT a, "u.................', None),
    ("SELECT a, $$unterminated heredoc", "SELECT a, $$....................", "postgres"),
    ("SELECT a, `unterminated backtick", "SELECT a, `u....................", "mysql"),
    ("'unterminated secret", "'u..................", None),
    ("SELECT a, '", "SELECT a, '", None),
]:
    add_render_row(f"test_tokenize_error_keeps_delimiter[{sql!r}]", sql, dialect=dialect, expect=expect)

# test_comment_bodies_fully_blanked
for sql, expect in [
    ("SELECT a /* x /* nested */ y */ b", "SELECT a /* . .. ...... .. . */ b"),
    ("SELECT a -- /* not a real block\nFROM t", "SELECT a -- .. ... . .... .....\nFROM b"),
]:
    add_render_row(f"test_comment_bodies_fully_blanked[{sql!r}]", sql, expect=expect)

# test_render_without_dialect_still_redacts
_sql_mysql_hash = "SELECT a # secret"
add_render_row(
    "test_render_without_dialect_still_redacts_1", _sql_mysql_hash, dialect="mysql",
    expect="SELECT a # ......",
)
# Second half renders the SAME anonymized tokens (produced WITH the "mysql" dialect)
# but via render() WITHOUT a dialect — not reproducible by add_render_row, which
# anonymizes and renders with the same dialect throughout.
_toks_mysql = anonymize(_sql_mysql_hash, "mysql")
_rendered_no_dialect = render(_sql_mysql_hash, _toks_mysql)
assert _rendered_no_dialect == "SELECT a . ......", _rendered_no_dialect
rows.append({
    "name": "test_render_without_dialect_still_redacts_2",
    "kind": "render_cross_dialect",
    "sql": _sql_mysql_hash,
    "anonymize_dialect": "mysql",
    "render_dialect": None,
    "want": _rendered_no_dialect,
})

# test_render
for sql, expect, dialect in [
    ("", "", None),
    (" \t\n", " \t\n", None),
    ("-- leading secret\nSELECT foo", "-- ....... ......\nSELECT aaa", None),
    ("SELECT /* hidden value */ foo -- trailing secret",
     "SELECT /* ...... ..... */ aaa -- ........ ......", None),
    ("SELECT foo /* first */ /* second */ FROM bar",
     "SELECT aaa /* ..... */ /* ...... */ FROM aab", None),
    ("SELECT foo, 'secret tail", "SELECT aaa, 's..........", None),
    ("SELECT foo // secret", "SELECT aaa // ......", "snowflake"),
    ("SELECT foo # secret", "SELECT aaa # ......", "mysql"),
]:
    add_render_row(f"test_render[{sql!r}]", sql, dialect=dialect, expect=expect)


# --------------------------------------------------------------------------- #
# A handful of ad-hoc rows beyond the named test file, exercising the
# code-point-width hazard this port's own helper functions are built to avoid
# (see anonymize.js's header note) -- upstream's own test suite never puts an
# astral character inside a quoted literal, so this is this round's OWN
# correctness check, not a reproduction of an upstream assertion.
# --------------------------------------------------------------------------- #
for sql, dialect in [
    ("SELECT '\U0001F600abc'", None),           # astral char inside a STRING literal
    ("SELECT \"caf\U0001F600\"", None),          # astral char inside an IDENTIFIER
    ("SELECT a -- \U0001F600 secret\nFROM t", None),  # astral char inside a comment body
    ("SELECT 'a\U0001F600' , 'b\U0001F600c'", None),  # two distinct astral-bearing strings
]:
    add_render_row(f"astral[{sql!r}]", sql, dialect=dialect, check_len=True)


for r in rows:
    sys.stdout.write(json.dumps(r, ensure_ascii=False) + "\n")
