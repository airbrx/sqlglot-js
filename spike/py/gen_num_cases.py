#!/usr/bin/env python3
"""Generate the numeric differential corpus for the P0 go/no-go spike.

PORT_PLAN.md §7 P0 item 1 / §4.6 "Numeric".

Emits JSONL to stdout. Floats are carried as their exact IEEE-754 big-endian bit
pattern (hex) so nothing is lost in transit; the JS side reconstructs them with
DataView.getFloat64. Decimals and ints are carried as strings, which is exact by
construction and is also literally how sqlglot handles them (Literal.to_py does
Decimal(self.this) on the literal's own text).

Deterministic: seeded RNG, so the corpus is reproducible.
"""

import json
import random
import struct
import sys
from decimal import Decimal, InvalidOperation, DivisionByZero, getcontext

SEED = 20260824
N_RANDOM_FLOATS = 120000
N_RANDOM_DEC_PAIRS = 60000


def f2bits(x: float) -> str:
    return struct.pack(">d", x).hex()


def emit(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")


# --------------------------------------------------------------------------- #
# float corpus
# --------------------------------------------------------------------------- #


def float_cases(rng):
    seen = set()

    def add(x):
        try:
            b = f2bits(x)
        except (OverflowError, TypeError):
            return
        if b in seen:
            return
        seen.add(b)
        emit({"k": "float", "bits": b, "want": str(x)})

    # --- specials and zeros
    for x in [0.0, -0.0, float("inf"), float("-inf"), float("nan")]:
        add(x)

    # --- the go/no-go values (test_snowflake.py:367)
    add(-9223372036854775808.0)
    add(9223372036854775807.0)

    # --- powers of ten across the whole exponent range (fixed<->exp thresholds)
    for e in range(-330, 309):
        try:
            add(float("1e%d" % e))
            add(float("-1e%d" % e))
            add(float("9.999999999999999e%d" % e))
            add(float("1.000000000000001e%d" % e))
        except (ValueError, OverflowError):
            pass

    # --- exact integers as floats, straddling the decpt>16 threshold
    for e in range(0, 23):
        for m in (1, 2, 3, 5, 9):
            add(float(m * 10**e))
            add(float(m * 10**e) + 1.0)
            add(float(m * 10**e) - 1.0)
    for n in range(0, 1200):
        add(float(n))
        add(-float(n))
    # Windows around the binary boundaries where float spacing changes (and where
    # shortest-repr digit counts jump). NOT a contiguous 2**52..2**53 sweep — that is
    # 4.5e15 iterations.
    for boundary in (2**24, 2**31, 2**32, 2**52, 2**53, 2**63, 2**64):
        for d in range(-6, 7):
            add(float(boundary + d))
            add(-float(boundary + d))

    # --- trailing-zero / short-digit values
    for s in [
        "1.0", "1.5", "0.1", "0.2", "0.3", "1.10", "100.0", "0.0001", "0.00001",
        "0.000001", "1e15", "1e16", "1e17", "1e21", "1e22", "-1e-5", "1e-4",
        "123456789012345678901234567890.0", "5e-324", "1.7976931348623157e308",
        "2.2250738585072014e-308", "0.5", "0.25", "0.125", "3.14159265358979",
    ]:
        add(float(s))

    # --- subnormals
    for i in range(0, 400):
        add(struct.unpack(">d", struct.pack(">Q", i))[0])
        add(struct.unpack(">d", struct.pack(">Q", (1 << 63) | i))[0])

    # --- uniform random bit patterns (widest coverage of shortest-repr)
    for _ in range(N_RANDOM_FLOATS):
        bits = rng.getrandbits(64)
        x = struct.unpack(">d", struct.pack(">Q", bits))[0]
        add(x)

    # --- random "human" decimals, which stress the fixed-notation branch
    for _ in range(20000):
        mant = rng.randint(-10**rng.randint(1, 18), 10**rng.randint(1, 18))
        e = rng.randint(-25, 25)
        try:
            add(float("%de%d" % (mant, e)))
        except (ValueError, OverflowError):
            pass


# --------------------------------------------------------------------------- #
# Decimal corpus
# --------------------------------------------------------------------------- #

DEC_SEEDS = [
    "0", "-0", "0.0", "-0.0", "0.00", "1", "-1", "1.0", "1.10", "1.100",
    "10", "100", "1000", "0.1", "0.01", "0.001", "0.0001", "0.00001",
    "0.000001", "0.0000001", "1E+5", "1E-5", "1e+5", "1e-5", "-1E+5",
    "9.223372036854776E+18", "-9.223372036854776e+18", "9223372036854775807",
    "-9223372036854775808", "1.7976931348623157E+308", "5E-324",
    "123456789012345678901234567890", "1.23456789012345678901234567890",
    "0.30000000000000004", "1E+999", "1E-999", "12345678901234567890.12345",
    "-0.000", "7", "-7", "2", "3", "6", "0.5", "-0.5", "1E+28", "1E+29",
    "99999999999999999999999999999", "1E-28", "1E-29",
]


def dec_cases(rng):
    getcontext().prec = 28

    # --- str(Decimal(s)) round-trip on the seed set
    for s in DEC_SEEDS:
        emit({"k": "dec_str", "a": s, "want": str(Decimal(s))})

    # --- str(Decimal) over generated triples: sign x coeff x exponent
    for coeff in ["0", "1", "5", "9", "10", "100", "110", "123",
                  "1000000000000000000000000000", "9999999999999999999999999999",
                  "123456789012345678901234567"]:
        for e in list(range(-40, 41)) + [-999, -100, 100, 999, 6000, -6000]:
            for sign in ["", "-"]:
                s = "%s%sE%d" % (sign, coeff, e)
                emit({"k": "dec_str", "a": s, "want": str(Decimal(s))})

    # --- random decimal strings
    for _ in range(30000):
        ndig = rng.randint(1, 34)
        digits = "".join(rng.choice("0123456789") for _ in range(ndig))
        e = rng.randint(-40, 40)
        sign = rng.choice(["", "-"])
        s = "%s%sE%d" % (sign, digits, e)
        emit({"k": "dec_str", "a": s, "want": str(Decimal(s))})

    # --- arithmetic: the reachable op set (+ - * / neg cmp)
    pool = [Decimal(s) for s in DEC_SEEDS]

    def rand_dec():
        if rng.random() < 0.35:
            return rng.choice(pool)
        ndig = rng.randint(1, 30)
        digits = "".join(rng.choice("0123456789") for _ in range(ndig))
        e = rng.randint(-30, 30)
        sign = rng.choice(["", "-"])
        return Decimal("%s%sE%d" % (sign, digits, e))

    def arith(a, b):
        for op, fn in (("+", lambda: a + b), ("-", lambda: a - b),
                       ("*", lambda: a * b), ("/", lambda: a / b)):
            try:
                want = str(fn())
            except (InvalidOperation, DivisionByZero, OverflowError, ValueError):
                want = None
            emit({"k": "dec_op", "op": op, "a": str(a), "b": str(b), "want": want})
        try:
            c = (a > b) - (a < b)
        except InvalidOperation:
            c = None
        emit({"k": "dec_cmp", "a": str(a), "b": str(b), "want": c})
        emit({"k": "dec_neg", "a": str(a), "want": str(-a)})
        emit({"k": "dec_abs", "a": str(a), "want": str(abs(a))})

    for a in pool:
        for b in pool:
            arith(a, b)
    for _ in range(N_RANDOM_DEC_PAIRS):
        arith(rand_dec(), rand_dec())


# --------------------------------------------------------------------------- #
# Literal.number — the composed go/no-go path
# --------------------------------------------------------------------------- #


def literal_number_cases(rng):
    """Mirror expressions/core.py:1755 without importing sqlglot.

    Returns the rendered literal text plus whether upstream wraps it in Neg.
    """

    def literal_number(number):
        text = str(number)
        try:
            try:
                to_py = int(text)
            except ValueError:
                to_py = Decimal(text)
            if not isinstance(to_py, str) and to_py < 0:
                return str(abs(to_py)), True
        except Exception:
            pass
        return text, False

    vals = [
        -9223372036854775808.0, 9223372036854775807.0,
        0.0, -0.0, 1.0, -1.0, 1e16, -1e16, 1e-5, -1e-5,
        1.5, -1.5, 123.456, -123.456, 1e300, -1e300, 5e-324, -5e-324,
    ]
    for _ in range(4000):
        bits = rng.getrandbits(64)
        x = struct.unpack(">d", struct.pack(">Q", bits))[0]
        if x != x or x in (float("inf"), float("-inf")):
            continue
        vals.append(x)

    for x in vals:
        text, neg = literal_number(x)
        emit({"k": "litnum_f", "bits": f2bits(x), "want": text, "neg": neg})

    ints = [0, 1, -1, 2**63 - 1, -(2**63), 10**40, -(10**40), 12345, -12345]
    for _ in range(2000):
        ints.append(rng.randint(-(10**30), 10**30))
    for n in ints:
        text, neg = literal_number(n)
        emit({"k": "litnum_i", "a": str(n), "want": text, "neg": neg})


def main():
    rng = random.Random(SEED)
    float_cases(rng)
    dec_cases(rng)
    literal_number_cases(rng)


if __name__ == "__main__":
    main()
