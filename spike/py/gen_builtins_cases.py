#!/usr/bin/env python3
"""Differential corpus for the _py builtins shims added at P0 item 5:
utf8Len, pyChr, pyOrd, pyFormatInt, pyRepr/pyReprStr, and the ExprSet/ExprMap
value-keyed containers.

  python3 spike/py/gen_builtins_cases.py > spike/out/builtins.jsonl
"""

import json
import random
import sys

SEED = 20260825
rng = random.Random(SEED)


def emit(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":"), ensure_ascii=False) + "\n")


# --------------------------------------------------------------------------- #
# utf8Len — parsers/clickhouse.py:63
# --------------------------------------------------------------------------- #
UTF8_PROBES = ["", "a", "é", "€", "\U0001F600", "ab", "aé", "日本語", "ÿ",
               "ࠀ", "￿", "\U00010000", "\U0010FFFF", "a\U0001F600b"]
for _ in range(3000):
    n = rng.randint(0, 5)
    s = "".join(chr(rng.choice([rng.randint(1, 0x7F), rng.randint(0x80, 0x7FF),
                                rng.randint(0x800, 0xD7FF), rng.randint(0xE000, 0xFFFF),
                                rng.randint(0x10000, 0x10FFFF)]))
                for _ in range(n))
    UTF8_PROBES.append(s)
for s in UTF8_PROBES:
    try:
        want = len(s.encode("utf-8"))
    except UnicodeEncodeError:
        want = None
    emit({"k": "utf8len", "cps": [ord(c) for c in s], "want": want})

# surrogates must raise
for cp in (0xD800, 0xDBFF, 0xDC00, 0xDFFF):
    try:
        want = len(chr(cp).encode("utf-8"))
    except UnicodeEncodeError:
        want = None
    emit({"k": "utf8len", "cps": [cp], "want": want})


# --------------------------------------------------------------------------- #
# chr / ord — generators/singlestore.py:25
# --------------------------------------------------------------------------- #
CHR_PROBES = [0, 1, 0x41, 0x7F, 0x80, 0xFF, 0x100, 0xD7FF, 0xD800, 0xDFFF,
              0xE000, 0xFFFF, 0x10000, 0x1F600, 0x10FFFF]
for _ in range(2000):
    CHR_PROBES.append(rng.randint(0, 0x10FFFF))
for cp in CHR_PROBES:
    try:
        s = chr(cp)
        emit({"k": "chr", "cp": cp, "want_cps": [ord(c) for c in s]})
        emit({"k": "ord", "cps": [ord(c) for c in s], "want": ord(s)})
    except ValueError:
        emit({"k": "chr", "cp": cp, "want_cps": None})
# out of range
for cp in (-1, 0x110000, 0x200000):
    emit({"k": "chr", "cp": cp, "want_cps": None})


# --------------------------------------------------------------------------- #
# format spec :0Nd — parsers/dremio.py:65
# --------------------------------------------------------------------------- #
for n in [0, 1, -1, 12, -12, 123, -123, 1234, -1234, 99999, -99999, 7, -7]:
    for w in [0, 1, 2, 3, 4, 5, 8]:
        emit({"k": "formatint", "n": n, "w": w, "want": format(n, f"0{w}d")})
for _ in range(2000):
    n = rng.randint(-10**6, 10**6)
    w = rng.randint(0, 10)
    emit({"k": "formatint", "n": n, "w": w, "want": format(n, f"0{w}d")})


# --------------------------------------------------------------------------- #
# repr(str) — §4.6 "Strings"
# --------------------------------------------------------------------------- #
REPR_STRINGS = [
    "", "a", "abc", "it's", 'say "hi"', "both ' and \"", "tab\there",
    "nl\nhere", "cr\rhere", "back\\slash", "\x00", "\x1f", "\x7f", "\x80",
    "\xff", "é", " ", "​", "￿", "\U0001F600", "\U0010FFFF",
    "mixed \t'\"\\ ​\U0001F600", "\ud800", "café",
]
for _ in range(4000):
    n = rng.randint(0, 6)
    s = "".join(chr(rng.choice([
        rng.randint(0, 0x7F), rng.randint(0x80, 0x2FF), rng.randint(0x2000, 0x20FF),
        rng.randint(0xD800, 0xDFFF), rng.randint(0x10000, 0x10FFFF),
    ])) for _ in range(n))
    REPR_STRINGS.append(s)
for s in REPR_STRINGS:
    emit({"k": "reprstr", "cps": [ord(c) for c in s], "want": repr(s)})


# --------------------------------------------------------------------------- #
# repr(container)
# --------------------------------------------------------------------------- #
emit({"k": "repr_list", "items": [], "want": repr([])})
emit({"k": "repr_list", "items": [1, 2, 3], "want": repr([1, 2, 3])})
emit({"k": "repr_list", "items": ["a", "b"], "want": repr(["a", "b"])})
emit({"k": "repr_list", "items": [True, False, None], "want": repr([True, False, None])})
emit({"k": "repr_tuple", "items": [], "want": repr(())})
emit({"k": "repr_tuple", "items": [1], "want": repr((1,))})
emit({"k": "repr_tuple", "items": [1, 2], "want": repr((1, 2))})
emit({"k": "repr_tuple", "items": ["a"], "want": repr(("a",))})
emit({"k": "repr_set_empty", "want": repr(set())})
emit({"k": "repr_dict", "items": [], "want": repr({})})
emit({"k": "repr_dict", "items": [["a", 1]], "want": repr({"a": 1})})
emit({"k": "repr_dict", "items": [["a", 1], ["b", "x"]], "want": repr({"a": 1, "b": "x"})})
emit({"k": "repr_nested", "want": repr([1, ["a", None], {"k": True}])})


# --------------------------------------------------------------------------- #
# value-keyed containers — model Python set/dict semantics over (hash, eq) pairs
# --------------------------------------------------------------------------- #
class Item:
    """Hash/eq deliberately decoupled so collisions are exercised."""

    def __init__(self, h, v):
        self.h = h
        self.v = v

    def __hash__(self):
        return self.h

    def __eq__(self, other):
        return isinstance(other, Item) and self.v == other.v


for trial in range(600):
    n = rng.randint(0, 12)
    # Small hash space forces collisions between unequal items.
    ops = [(rng.randint(0, 3), rng.randint(0, 5)) for _ in range(n)]
    s = set()
    order = []
    for h, v in ops:
        it = Item(h, v)
        if it not in s:
            order.append(v)
        s.add(it)
    emit({"k": "exprset", "ops": ops, "size": len(s), "order": order})

    # dict: later assignments to an EQUAL key overwrite the value but keep the
    # original key object and its insertion position.
    d = {}
    dorder = []
    for i, (h, v) in enumerate(ops):
        it = Item(h, v)
        if it not in d:
            dorder.append(v)
        d[it] = i
    emit({"k": "exprmap", "ops": ops, "size": len(d), "order": dorder,
          "values": [d[k] for k in d]})

# frozenset key: order-independent, deduplicating
for trial in range(400):
    n = rng.randint(0, 6)
    a = [rng.randint(0, 4) for _ in range(n)]
    b = a[:]
    rng.shuffle(b)
    emit({"k": "frozenset", "a": a, "b": b, "same": frozenset(a) == frozenset(b),
          "size": len(frozenset(a))})
