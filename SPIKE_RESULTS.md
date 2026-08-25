# P0 Day 1–3 go/no-go spike — results

**Verdict: GREEN. Proceed to the Day 3–6 calibration spike.**

Scope: PORT_PLAN.md §7 P0 item 1 (and the hazard detail in §4.6). This spike answers one
question only — *is byte-exact SQL output achievable in zero-dependency JS at the budgeted
effort?* — via two independent probes. Nothing else in P0 was started.

| | toolchain |
|---|---|
| CPython | **3.9.25** (`unicodedata` **13.0.0**) — matches PORT_PLAN §4.6/§5.2/R6 |
| Node | **v22.12.0** (ICU 76.1, **Unicode 16.0**) |
| upstream | `sqlglot @ 91119bc`, read-only clone at `/tmp/sqlglot-ref` |

Reproduce end-to-end from a clean tree with `bash spike/run_all.sh` (exit 0 = all green).
Generated corpora are gitignored and regenerable; every number below came from that script.

---

## Probe 1 — Decimal / float round-tripping: **GREEN**

**621,245 differential cases against CPython, 0 divergences.**

| bucket | cases | fail |
|---|---:|---:|
| `str(float)` | 145,755 | 0 |
| float round-trip (`Number(ours) === original`) | 145,696 | 0 |
| `str(Decimal)` | 31,964 | 0 |
| `Decimal + - * /`, `cmp`, `neg`, `abs` | 437,500 | 0 |
| `Literal.number(float)` / `(int)` | 6,026 | 0 |

Corpus: all IEEE-754 doubles carried as exact bit patterns (no lossy JSON floats); uniform
random 64-bit patterns, subnormals, powers of ten across the full exponent range, values
straddling the fixed↔exponential thresholds, binary boundaries (2²⁴/2³¹/2³²/2⁵²/2⁵³/2⁶³/2⁶⁴),
trailing zeros, ±0, inf/nan; Decimal strings with preserved precision and scientific input.

### The named go/no-go case is reproduced byte-exactly

`tests/dialects/test_snowflake.py:367` asserts a **mixed-case** literal:

```
SELECT CAST(-9.223372036854776E+18 + RANDOM() * (9.223372036854776e+18 - -9.223372036854776E+18) AS BIGINT)
                                ^^^                              ^^^
```

That is not an upstream typo. `parsers/snowflake.py:573` builds `exp.Rand` with both bounds
via `Literal.number(<float>)`, and `expressions/core.py:1755` renders them through *different*
functions:

```python
lit = cls(this=str(number), is_string=False)   # str(float)  -> lowercase 'e', exponent padded to 2
to_py = lit.to_py()                            # int(...) fails -> Decimal(...)
if to_py < 0:
    lit.set("this", str(abs(to_py)))           # str(Decimal) -> uppercase 'E', exponent NOT padded
    return Neg(this=lit)                       # the '-' comes back from Neg
```

So the **positive** bound keeps Python's float repr and the **negative** one is re-rendered
through `str(Decimal)`. A single assertion pins both functions *and* pins that they disagree
on casing and exponent padding. `spike/gonogo_snowflake367.mjs` reproduces it exactly; the
naive port does not:

```
pyFloatToStr(-2**63) -> -9.223372036854776e+18   String(-2**63) -> -9223372036854776000
rendered literal     -> -9.223372036854776E+18   naive full SQL matches? false
```

### Why `Number.prototype.toString()` is not a substitute

Measured across the float corpus: **naive `String(x)` diverges from CPython on 10,684 of
145,755 cases (7.3%)**. Five distinct rules differ, all handled in `pyFloatToStr`:

1. exponential threshold — Python at `decpt > 16` / `decpt <= -4`; JS at `1e21` / `1e-7`
2. integral floats — Python appends `.0` (`1.0` vs JS `1`)
3. exponent padding — Python pads to 2 digits (`1e-05` vs JS `1e-7`)
4. negative zero — Python `-0.0`, JS `0`
5. non-finite — Python `inf`/`-inf`/`nan`, JS `Infinity`/`NaN`

Key implementation finding that keeps this cheap: **Python and JS agree on the shortest
round-tripping digits**, so `pyFloatToStr` takes JS's digits from `toExponential()` and only
re-formats them under Python's rules. No Grisu/Ryu reimplementation is needed. The
`float round-trip` row above independently confirms the digits are never lost.

`_py/num.js` is scoped exactly as §4.6/appendix B5 specify — `+ - * /`, unary neg, comparison
and `str()`, backed by BigInt — **not** a general CPython `decimal` clone. `_fix`'s
subnormal/overflow branches are deliberately omitted as unreachable (Emin/Emax are ±999999).

**Budget read:** the 40–70h in §10 looks sound; the working shim took well under a day.

---

## Probe 2 — Unicode classification sweep: **GREEN, with a required design constraint**

Full `sys.maxunicode` sweep — **all 1,114,112 code points**, not a sample.

### 2a. Runtime `\p{...}` escapes are NOT sufficient

| predicate | CPython true-count | best `\p{...}` candidate | diverging cps |
|---|---:|---|---:|
| `isprintable` | 143,680 | `!(\p{C}\|\p{Z})` + `0x20` | **11,130** |
| `islower` | 2,344 | `\p{Lowercase}` | **225** |
| `isupper` | 1,911 | `\p{Uppercase}` | **67** |
| `isspace` | 29 | `\p{White_Space}` | **4** |

Naive alternatives are worse, and **the plan's cited figures are confirmed exactly**:
`\p{Ll}` → **292**, `\p{Lu}` → **187** (§4.6). Other approximations measured: `toUpper/toLower`
round-trip → 953 / 616; `\s` → 6; ASCII-only printable → 143,585.

The dominant cause is **Unicode version skew, not bad definitions**: Node v22 ships Unicode
16.0 while the harvesting interpreter is on 13.0.0. Classifying each divergence by its
CPython-13.0 General_Category:

- `isprintable`: 11,130 diverging, **11,130 unassigned (Cn) in 13.0** → 0 genuine mismatches
- `isupper`: 67 diverging, **67 Cn** → 0 genuine
- `islower`: 225 diverging, 223 Cn → **2 genuine**: `U+10FC`, `U+AB69`
- `isspace`: 4 diverging, 0 Cn → **4 genuine**: `U+001C..U+001F`

The genuine ones are permanent semantic differences, fully enumerated:

- `U+10FC` (MODIFIER LETTER GEORGIAN NAR) and `U+AB69` (MODIFIER LETTER SMALL TURNED W) are
  category `Lm` with `Other_Lowercase=Yes`. Unicode's `Lowercase` property says yes; CPython
  `str.islower()` says **False**.
- `U+001C..U+001F` are `Cc` with bidi class `B`/`S`. CPython `isspace()` is **True**; Unicode's
  `White_Space` property is No.

**§4.6's isspace claim reproduces verbatim:** Python-only `{1c, 1d, 1e, 1f, 85}`, JS-only
`{feff}`. Confirmed, no corrections needed.

### 2b. Generated tables ARE exact — this is what makes the probe green

PORT_PLAN §4.3 item 3 already specifies `_gen/unicode.js` as generated full-range tables. That
mitigation was *verified*, not assumed:

```
verifying 0..0x10FFFF (1,114,112 code points) x 5 predicates
  isprintable  0 divergences  exact
  islower      0 divergences  exact
  isupper      0 divergences  exact
  isspace      0 divergences  exact
  istitlechar  0 divergences  exact
GENERATED TABLES: EXACT over the full range
```

`tools/gen_unicode_tables.mjs` emits **10,840 bytes** (delta-encoded base-36 ranges, binary
search) — 1,983 ranges total, zero runtime dependencies. Version skew disappears because the
tables are harvested from the same interpreter as the corpus.

> **Constraint this puts on the plan:** `_py/str.js` must consult the generated tables and must
> **never** use runtime `\p{...}` for these four predicates. Recommend adding `\p{` inside
> `src/_py/` and `src/tokenizer*.js` to `lint_fidelity.mjs`'s deny-list, and adding
> `unidata_version` to `corpus/PROVENANCE.json` alongside the CPython patch version (§5.2/R6) —
> the tables are only valid for the Unicode version that harvested them.

### 2c. String-level semantics — one real trap found

Per-code-point tables are necessary but not sufficient: `str.islower()`/`isupper()` require at
least one *cased* character and reject the opposite case. `src/_py/str.js` implements CPython's
`unicodeobject.c` algorithms over code points (`for..of`, never UTF-16 units).
**83,307 strings × 4 predicates, 0 failures** — including astral characters, lone surrogates,
and the empty string (`isprintable('')` is True, the others False).

The trap, worth recording because it is exactly the class of hazard §4.6 exists for: the first
implementation dumped `str.istitle()` and used it as a character property. **It is not one.**
`'A'.istitle()` is `True` (the *string* is titlecase-formatted) while `'A'` is not a titlecase
*character*. That made `str.isupper('A')` return `False` — **8,197 of 83,307 failures**. The
character property is `Py_UNICODE_ISTITLE` = General_Category `Lt` (**10 ranges, not 646**). The
dumper now asserts CPython's own identity `str.istitle(1char) == ISUPPER | ISTITLE`, which holds
with **0 mismatches** across the full range.

---

## Recommendation

**GREEN — proceed to the Day 3–6 calibration spike (PORT_PLAN §7 P0 item 2).**

Both probes pass with no unbounded divergence. Every difference found is either eliminated by
an approach already in the plan (generated tables) or is a fully enumerated set of ≤ 4 code
points. Nothing here challenges the byte-exactness premise, so **no re-plan is warranted** and
§10's "semantically correct, not byte-exact" fallback should stay unused.

Three findings the plan should absorb (all small, none architecture-changing):

1. **Elevate "no runtime `\p{...}`" from an implementation detail to a lint rule.** The naive
   choice is wrong on 11,130 code points and would pass every corpus test, since the corpus is
   0.024% non-ASCII (R4's exact thesis).
2. **Record `unidata_version` in `corpus/PROVENANCE.json`.** §5.2 currently pins the CPython
   patch version for float/Decimal reasons; the Unicode data version is a second, independent
   axis with an 11,130-code-point blast radius.
3. **`Py_UNICODE_ISTITLE` ≠ `str.istitle()` belongs in `CONTRACTS.md`'s `_py/` API surface**
   (§8.2 item 1), alongside the existing `utf8Len`/`pyChr`/`pyFormatInt` notes.

## Artifacts

| path | what |
|---|---|
| `src/_py/num.js` | `pyFloatToStr`, `PyDecimal` (+ `- * /`, neg, abs, cmp, `str`), `literalNumberText` |
| `src/_py/str.js` | Python string-level `isprintable`/`islower`/`isupper`/`isspace` |
| `src/_gen/unicode.js` | generated full-range tables (10,840 B) — **do not hand-edit** |
| `tools/gen_unicode_tables.mjs` | table generator (`_gen/` codegen, §4.3) |
| `spike/py/gen_num_cases.py` | CPython numeric oracle (seeded, reproducible) |
| `spike/py/gen_unicode_ref.py` | CPython full-range classification dump |
| `spike/py/gen_str_cases.py` | CPython string-level oracle |
| `spike/py/inspect_cps.py` | explains individual diverging code points |
| `spike/fuzz_num.mjs`, `spike/fuzz_unicode.mjs`, `spike/fuzz_str.mjs` | differential runners |
| `spike/gonogo_snowflake367.mjs` | the named `test_snowflake.py:367` assertion |
| `spike/verify_unicode_tables.mjs` | proves the generated tables are exact |
| `spike/run_all.sh` | reproduce everything from scratch |

`src/_py/num.js`, `src/_py/str.js`, `src/_gen/unicode.js` and `tools/gen_unicode_tables.mjs`
are written in their production locations per §4.1 and are intended to survive into P2+; the
`spike/` harnesses are the seed for `fuzz_decimal.py` / `fuzz_unicode.py` (§3.4 targets 1 and 3).

### Not done (deliberately — this session was scoped to §7 P0 item 1 only)

Calibration spike, licensing, `CONTRACTS.md`, harvester, `astdump.py`, closure calculator,
runner, ratchet, parity probes, the other four fuzzers (`fuzz_regex`, `fuzz_toowide`,
`fuzz_comments`, `fuzz_depth`), deny-lists, bridge proofs, and the rest of `_py/`
(`re.js`, `sort.js`, `collections.js`, `datetime.js::pyFromIsoFormat`).
