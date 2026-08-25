#!/usr/bin/env python3
"""Snapshot every tokenizer's effective settings from upstream.

PORT_PLAN.md §7 P1 ("parity probe #1"), CONTRACTS.md §2.

  python3 tools/tokens/extract_settings.py        # writes corpus/tokens/settings.json

Why this file exists
--------------------
`corpus/parity/tokens.json` (P0) pins the 443 `TokenType` members and nothing else.
That is a necessary check and a *weak* one: a tokenizer that emits the right token
type names in the wrong order, at the wrong offsets, is byte-identical under it.

P1's exit is "token streams byte-exact across all corpus inputs". Producing a token
stream for dialect `d` requires `d`'s tokenizer settings, which live in
`sqlglot/dialects/<d>.py` — files that are P5-P9 scope, not P1's. Rather than block
P1's verification on P9, this snapshots the *resolved* `TokenizerCore.__init__`
kwargs per dialect. `src/tokenizer_core.js` is then driven from the snapshot and
checked against `corpus/tokens/streams.jsonl` for all 34 dialects, with zero dialect
files ported. When P5-P9 land the real dialect classes, the same snapshot becomes the
assertion that their derivations are right (§4.4, parity probe #4's model).

The base `Tokenizer`'s own derived attributes (`_QUOTES`, `_FORMAT_STRINGS`,
`_COMMENTS`, `_KEYWORD_TRIE`, ...) are snapshotted separately under `"Tokenizer"` so
`src/tokens.js`'s port of `_TokenizerBase.__init_subclass__` is checked directly
rather than only through its effect on a token stream.
"""

import json
import os
import sys

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)

OUT = "corpus/tokens/settings.json"

# The exact TokenizerCore.__init__ parameter list, in declaration order
# (tokenizer_core.py:579-607). Order is asserted on the JS side, so a parameter
# added upstream shows up as a diff rather than being silently ignored.
CORE_SLOTS = [
    "single_tokens",
    "keywords",
    "quotes",
    "format_strings",
    "identifiers",
    "comments",
    "string_escapes",
    "byte_string_escapes",
    "identifier_escapes",
    "escape_follow_chars",
    "commands",
    "command_prefix_tokens",
    "nested_comments",
    "hint_start",
    "tokens_preceding_hint",
    "has_bit_strings",
    "has_hex_strings",
    "numeric_literals",
    "var_single_tokens",
    "string_escapes_allowed_in_raw_strings",
    "heredoc_tag_is_identifier",
    "heredoc_string_alternative",
    "numbers_can_be_underscore_separated",
    "numbers_can_have_decimals",
    "identifiers_can_start_with_digit",
    "unescaped_sequences",
]

# _TokenizerBase's class-level inputs and the attributes __init_subclass__ derives
# from them (tokens.py:78-118). tokens.js ports that derivation; these pin it.
BASE_INPUTS = [
    "QUOTES",
    "IDENTIFIERS",
    "BIT_STRINGS",
    "BYTE_STRINGS",
    "HEX_STRINGS",
    "RAW_STRINGS",
    "HEREDOC_STRINGS",
    "UNICODE_STRINGS",
    "STRING_ESCAPES",
    "BYTE_STRING_ESCAPES",
    "ESCAPE_FOLLOW_CHARS",
    "IDENTIFIER_ESCAPES",
    "COMMENTS",
    "HINT_START",
]
BASE_DERIVED = [
    "_QUOTES",
    "_IDENTIFIERS",
    "_FORMAT_STRINGS",
    "_STRING_ESCAPES",
    "_BYTE_STRING_ESCAPES",
    "_ESCAPE_FOLLOW_CHARS",
    "_IDENTIFIER_ESCAPES",
    "_COMMENTS",
]


def enc(v):
    """JSON-encode a tokenizer setting without losing anything observable.

    Sets are emitted as SORTED lists. That is safe here and only here: every value in
    every one of these sets is a membership-test target (`self._char in escapes`),
    never iterated in a way that reaches output. Contrast §4.6 / probe #2, where
    `arg_types` order IS output-visible and must be preserved verbatim.
    """
    from sqlglot.tokens import TokenType

    if isinstance(v, TokenType):
        return {"$t": v.name}
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, (set, frozenset)):
        # Sorted by the rendered form so the snapshot is stable AND self-describing:
        # a set of TokenTypes keeps its `{"$t": ...}` tagging rather than collapsing to
        # bare name strings, which would be indistinguishable from a set of escape
        # characters on the JS side.
        return {"$s": sorted((enc(x) for x in v), key=lambda z: json.dumps(z, sort_keys=True))}
    if isinstance(v, (list, tuple)):
        return [enc(x) for x in v]
    if isinstance(v, dict):
        # Insertion order preserved — `_FORMAT_STRINGS` and `_COMMENTS` are built by
        # dict-merge and a later key overwrites an earlier one, so order is part of
        # the value's identity even though lookup is unordered.
        return {"$d": [[k, enc(val)] for k, val in v.items()]}
    raise TypeError(f"unencodable tokenizer setting: {type(v)!r}")


def trie_to_json(node):
    """new_trie's nested dicts -> nested JSON. The integer key 0 becomes "$end".

    See CONTRACTS.md §8: Python distinguishes dict keys `0` and `"0"`; JSON objects do
    not. Renaming the marker on the wire is what keeps a keyword containing '0' from
    colliding with it.
    """
    out = {}
    for k, v in node.items():
        if k == 0:
            out["$end"] = True
        else:
            out[k] = trie_to_json(v)
    return out


def main():
    from sqlglot.dialects.dialect import Dialect
    from sqlglot.jsonpath import JSONPathTokenizer
    from sqlglot.tokens import Tokenizer

    tokenizer_classes = {"Tokenizer": Tokenizer, "JSONPathTokenizer": JSONPathTokenizer}

    # Base-class derivations, checked directly against tokens.js.
    classes = {}
    for name, cls in tokenizer_classes.items():
        classes[name] = {
            "inputs": {k: enc(getattr(cls, k)) for k in BASE_INPUTS},
            "derived": {k: enc(getattr(cls, k)) for k in BASE_DERIVED},
            "keyword_trie": trie_to_json(cls._KEYWORD_TRIE),
            "keywords_count": len(cls.KEYWORDS),
            "single_tokens_count": len(cls.SINGLE_TOKENS),
        }

    # Resolved TokenizerCore kwargs, per dialect. Instantiating through
    # `Dialect.get_or_raise(name).tokenizer` is what makes this the *effective*
    # configuration — MRO-merged class attributes plus the three Dialect-level flags
    # (`NUMBERS_CAN_BE_UNDERSCORE_SEPARATED`, `IDENTIFIERS_CAN_START_WITH_DIGIT`,
    # `UNESCAPED_SEQUENCES`) that `_init_core` reads off `self.dialect`.
    cores = {}
    names = [""] + sorted(Dialect.classes)
    for name in names:
        dialect = Dialect.get_or_raise(name)
        tokenizer = dialect.tokenizer()
        core = tokenizer._core
        cores[name] = {
            "tokenizer_class": type(tokenizer).__name__,
            # A dialect whose Tokenizer overrides a METHOD cannot be reproduced from
            # settings alone, and the JS side must skip it loudly rather than report a
            # wrong stream. Detected mechanically, never by dialect name: today this
            # catches athena only (its `tokenize` re-tokenizes with Hive's or Trino's
            # tokenizer and prepends a HIVE_TOKEN_STREAM sentinel), and it will catch
            # the next one upstream adds without anybody remembering to look.
            "overrides": [
                m
                for m in ("tokenize", "_init_core", "__init__")
                if getattr(type(tokenizer), m, None) is not getattr(Tokenizer, m, None)
            ],
            "settings": {k: enc(getattr(core, k)) for k in CORE_SLOTS},
            "keyword_trie": trie_to_json(core.keyword_trie),
        }

    # The JSONPath tokenizer is not a registered dialect, but it is the only
    # tokenizer in the tree with `numbers_can_have_decimals=False` — the flag guarding
    # tokenizer_core.py:953. Without it that branch has no coverage at all.
    jp = JSONPathTokenizer()
    cores["$jsonpath"] = {
        "tokenizer_class": "JSONPathTokenizer",
        "overrides": [],
        "settings": {k: enc(getattr(jp._core, k)) for k in CORE_SLOTS},
        "keyword_trie": trie_to_json(jp._core.keyword_trie),
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf8") as f:
        json.dump(
            {
                "core_slots": CORE_SLOTS,
                "classes": classes,
                "count": len(cores),
                "cores": cores,
            },
            f,
            indent=1,
            ensure_ascii=False,
        )
        f.write("\n")

    overriding = [n for n, c in cores.items() if c["overrides"]]
    print(
        f"  {OUT}: {len(cores)} tokenizer configurations, {len(classes)} base classes; "
        f"{len(overriding)} override tokenizer methods and are not settings-reproducible: "
        f"{overriding or 'none'}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
