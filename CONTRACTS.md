# CONTRACTS.md — frozen interface contracts

**Status: frozen at P0.** PORT_PLAN.md §8.2. Freezing these on day one is what decouples the
three serial lanes (tooling / runtime / port), so a port agent can call a helper the runtime
agent has not written yet.

Changing anything here requires an explicit PR that says so in its title and updates
`UPSTREAM-NOTES.md`. Additive changes (a new export, no signature change) are allowed under the
`foundation-additive` label per §8.1 Rule 3(c).

Contracts marked **[verified]** have a differential test against CPython in `spike/`; run
`bash spike/run_all.sh`. Contracts marked **[design]** are decisions, not measurements.

---

## 1. `_py/` API surface

Python-semantics shims. **Every one of these exists because the obvious JS equivalent is
measurably wrong**; the divergence is stated so nobody "simplifies" it back.

### 1.1 `_py/num.js` — numeric [verified]

| export | py | contract |
|---|---|---|
| `pyFloatToStr(x)` | `str(float)` / `repr(float)` | Shortest round-tripping digits (same as JS), reformatted under Python's rules. Diverges from `String(x)` on **10,684 / 145,755** measured cases: exponential threshold (`decpt > 16` / `<= -4` vs JS `1e21` / `1e-7`), `.0` on integral floats, exponent zero-padded to 2, `-0.0`, `inf`/`-inf`/`nan`. |
| `pyIntToStr(n)` | `str(int)` | BigInt; arbitrary precision. |
| `pyDecimal(v)` | `Decimal(str)` | Parses from **string** only — that is the only construction sqlglot performs (`Literal.to_py`). |
| `PyDecimal#toString()` | `str(Decimal)` | Uppercase `E`, exponent signed but **not** zero-padded — deliberately unlike `pyFloatToStr`. |
| `decAdd/decSub/decMul/decDiv/decNeg/decAbs/decCmp` | `+ - * / neg abs cmp` | prec 28, `ROUND_HALF_EVEN`. **Not** a general `decimal` clone (§4.6 / B5). `decNeg(0)` is `0`, not `-0`. |
| `pyIntFromStr(s)` / `pyFloatFromStr(s)` | `int(s)` / `float(s)` | Returns `null` where Python raises `ValueError`. Accepts surrounding Unicode whitespace, a sign, **Unicode decimal digits** (`int('٢٠٢٣') == 2023`), and underscores *between* digits only. |
| `pyIsInt` / `pyIsFloat` | `helper.is_int` / `is_float` | thin wrappers. |
| `literalNumberText(v)` | `expressions/core.py:1755` | Returns `{text, neg}`. The `E+18`/`e+18` asymmetry at `test_snowflake.py:367` lives here. |

### 1.2 `_py/str.js` — string predicates [verified]

| export | py | contract |
|---|---|---|
| `pyIsPrintable/pyIsLower/pyIsUpper/pyIsSpace(s)` | `str.isprintable/islower/isupper/isspace` | **String**-level, not per-code-point: `islower`/`isupper` require ≥1 cased char and reject the opposite case. Iterate **code points**. `isprintable('')` is `true`; the others are `false`. |
| `cpLen(s)` | `len(str)` | Code points, not UTF-16 units. **§4.2 requires this instead of `.length` in `generator.js` and `time.js`.** |
| `cpArray(s)` | `list(s)` | code-point array. |
| `pyStrip/pyLstrip/pyRstrip(s, chars?)` | `str.strip` family | No argument ⇒ strips `str.isspace()`, which is **not** JS `\s`. |
| `pyZfill(s, w)` | `str.zfill` | Moves a leading sign in front of the padding. |

> **Hard rule: never use runtime `\p{...}` for these four predicates.** Property escapes are
> bound to the *engine's* Unicode version. Measured Node v22 (Unicode 16.0) vs CPython 3.9.25
> (`unicodedata` 13.0.0): **11,130** diverging code points for `isprintable`, 225 `islower`,
> 67 `isupper`, 4 `isspace`. Use the generated tables. Lint: `\p{` is denied inside
> `src/_py/` and `src/tokenizer*.js`.

### 1.3 `_py/sort.js` — ordering [verified]

| export | py | contract |
|---|---|---|
| `pyStrCmp(a,b)` | `str <` | **Code-point** order. JS default sort is UTF-16 code-unit order and disagrees on astral chars: Python `sorted(['z','😀','�'])` → `['z','�','😀']`, JS → `['z','😀','�']`. |
| `pyCmp` / `pyTupleCmp` | default `<` | Tuples compare element-wise then by length. Raises `TypeError` on mismatched types rather than inventing an order. |
| `pySorted` / `pySortedTuples` / `pySortedBy` | `sorted()` | Stable. `pySortedTuples` is §4.5's requirement. |

### 1.4 `_py/datetime.js` — ISO parsing [verified]

| export | py | contract |
|---|---|---|
| `pyDateFromIsoFormat(s)` | `date.fromisoformat` | Exactly `YYYY-MM-DD`, length 10. |
| `pyDateTimeFromIsoFormat(s)` | `datetime.fromisoformat` | CPython **3.9** grammar. |
| `pyIsIsoDate` / `pyIsIsoDateTime` | `helper.is_iso_date` / `is_iso_datetime` | boolean wrappers. |

> **Ported from the C accelerator (`Modules/_datetimemodule.c` @ `v3.9.25`), NOT
> `Lib/datetime.py`.** `_datetime` is active by default and differs from the readable Python
> source in at least three observable ways: strict ASCII digits (the Python source would accept
> `' 023-01-01'` as year 23 and `'٢٠٢٣-01-01'` as year 2023); a forward scan for the first
> `+`/`-` rather than `-`-anywhere-then-`+`; and `char c = *(p++); if (p >= p_end) return c != '\0';`
> where `p_end` is a **slice** bound, so `'123'` is rejected while `'123+00:00'` parses as
> hour 12. **This is version-pinned behaviour (R6): 3.11+ accepts `Z` and 1/2/4/5-digit
> fractions.** `corpus/PROVENANCE.json` records the interpreter; the runner hard-fails on a
> mismatch without `--rebaseline`.

### 1.5 `_py/difflib.js` — fuzzy matching [verified]

`SequenceMatcher` (`ratio`, `quickRatio`, `realQuickRatio`, `getMatchingBlocks`,
`findLongestMatch`) and `getCloseMatches(word, possibilities, n=3, cutoff=0.6)`. Drives the
user-visible `Unknown dialect 'x'. Did you mean y?` message, so ranking is output-visible.
Ties on ratio break by the candidate string **descending** (`heapq.nlargest` over `(ratio, x)`).
Sequences compare as code points.

### 1.6 `_py/errors.js` — exception types [design]

`PyException` base; `PyValueError`, `PyTypeError`, `PyIndexError`, `PyKeyError`,
`PyStopIteration`, `PyOverflowError`. The **type** is observable: `helper.is_type` and
`time.subsecond_precision` catch `ValueError` specifically, so a generic `Error` swallows too
much. `err.name` is `PyValueError`; strip the `Py` prefix to compare against CPython.

### 1.7 Still to be written (P0 item 5)

| export | py | owner |
|---|---|---|
| `_py/re.js` | `re` module | **Being built independently on branch `p0-regex-corpus`.** Do not duplicate; reconcile before P1. See §7 below. |
| `_py/collections.js` | `ExprSet`, `ExprMap`, `frozensetKey` | needs `Expression.__hash__` (P2, §4.5) — 64-bit via two 32-bit lanes. |
| `utf8Len(s)` | `len(s.encode('utf-8'))` | `parsers/clickhouse.py:63`. |
| `pyChr(cp)` | `chr()` | must handle > `0xFFFF` and lone surrogates; `String.fromCharCode` is deny-listed. |
| `pyFormatInt(n, w)` | `f"{n:04d}"` | `padStart` diverges on negatives (`0-01` vs `-001`). |
| `pyRepr(v)` | `repr()` | list/tuple/set/dict rendering inside error messages. |

---

## 2. Tokenizer output shape [design]

```js
/** @returns {{tokens: Token[], codePoints: number[]}} */
tokenize(sql)
```

`codePoints` is the **code-point array** of the input. `errors.js` and `parser.js` slice *that*,
never the JS string, so error columns and `highlight_sql` are correct under astral characters
(§4.6 "Indexing"). Three components depend on this; it is frozen.

---

## 3. `_gen/` schema [design]

Generated, never hand-edited. CI gate: `make codegen && git diff --exit-code src/_gen`, plus a
committed `_gen/.manifest.sha256` (§8.1 Rule 4).

| file | generator | contents |
|---|---|---|
| `_gen/unicode.js` | `tools/gen_unicode_tables.mjs` | `isPrintable`, `isLowercase`, `isUppercase`, `isSpace`, `isTitlecase`, `decimalValue`, `PROVENANCE`. Delta-encoded base-36 ranges, **ends stored EXCLUSIVE**, binary search on parity. |
| `_gen/timezones.js` | `tools/gen_timezones.mjs` | `TIMEZONES` set, lowercased, mechanically extracted from `time.py`. |
| `_gen/expr_meta.js` | P2 | 1,048 classes: ordered `argTypes`, `requiredArgs`, traits, `initOwner`. |
| `_gen/dispatch/` | P4 | resolved dispatch table per generator class, used to **assert** the runtime builder. |

> `isTitlecase` is `Py_UNICODE_ISTITLE` — the **character property** (General_Category `Lt`,
> 10 ranges). It is *not* `str.istitle()`: `'A'.istitle()` is `true` because the string is
> titlecase-*formatted*, while `'A'` is not a titlecase character. Conflating them makes
> `str.isupper('A')` return `false`. Table order is CI-asserted; §4.6 establishes that
> insertion order is output-visible.

---

## 4. AST oracle JSON shape [design]

`tools/astdump.py` ↔ `astDump()` / `astLoad()`. Own dumper, **not** sqlglot's `serde`, which
drops 34% of arg entries (`None`, `[]`).

```json
{"atom_id":"a1f3c9d2",
 "ast":{"c":"Select","a":[["expressions",[...]],["from",null]],
        "m":{"line":1,"col":7,"start":0,"end":12},"cm":null},
 "repr":"Select(\n  expressions=[...])"}
```

- `a` is an **ordered array of `[key, value]` pairs including nulls and empty lists** — this
  pins `arg_types` insertion order, which is observable in output SQL.
- `repr` is Python's `Expression.__repr__`, byte-exact. Asserting it is what makes the AST gate
  non-tautological and human-readable.
- **`astLoad` must not run `INIT_HOOKS`.** It constructs with a no-arg constructor plus `set()`,
  bypassing `__init__`, exactly like `serde.load`. Concretely: kwargs-construction of `DateAdd`
  uppercases the unit; `astLoad` does not. Unit-tested at P2.

---

## 5. Bridge NDJSON protocol [design]

`tools/bridge/` runs upstream's imperative core tests against the JS library via a Python proxy.
One JSON object per line, both directions:

```json
{"id":1,"op":"call","target":"sqlglot.transpile","args":["SELECT 1"],"kwargs":{"write":"duckdb"}}
{"id":1,"ok":true,"result":["SELECT 1"]}
{"id":2,"ok":false,"error":{"type":"ParseError","message":"...","errors":[...]}}
```

Per-module proxy-satisfiability (§3.8) — filled in as the two P0 proofs land:

| module | satisfiable | note |
|---|---|---|
| `test_errors.py` | **P0 proof** | cheapest — 36 of 48 `assertEqual`s are string literals |
| `test_transpile.py` | **P0 proof** | most representative |
| `test_generator.py`, `test_time.py`, `test_schema.py`, `test_jsonpath.py`, `test_transforms.py`, `test_diff.py` | P5 | |
| `test_build.py` | **NO** | 228 lambdas, 38 applying Python operators to `exp` objects (`x + 1`, `x // 1`, `x & 1`, `~x`, `x[...]`). Hand-ported native suite at P5 instead. |

---

## 6. `NotPorted` contract and the stub template [design]

```js
/** @param {Token} token @returns {Expr|undefined} */
// py: sqlglot/parser.py:6302
_parse_bitwise(token) { throw new NotPorted("_parse_bitwise", "sqlglot/parser.py:6302"); }
```

`NotPorted extends Error`, fields `{ method, pyAnchor }`. `grep -c NotPorted src/parser.js` is
the burndown. One task replaces exactly one stub, so two agents produce non-adjacent hunks
(§8.1 Rule 2).

---

## 7. Corpus provenance schema [design]

`corpus/PROVENANCE.json`. The runner hard-fails on mismatch unless `--rebaseline`.

```json
{"upstream_commit":"91119bc",
 "python_version":"3.9.25",
 "unidata_version":"13.0.0",
 "harvested_at":"...",
 "atom_count":15642,
 "tool_versions":{"astdump":"1"}}
```

- `python_version` is the **patch** version: CPython patch releases have changed float `repr`
  and `Decimal` behaviour before, and this corpus is byte-exact.
- `unidata_version` is a **second, independent axis** (added at P0 from the go/no-go spike):
  the Unicode data version has an 11,130-code-point blast radius on `isprintable` alone, and it
  moves independently of the CPython patch version.

---

## 8. Recorded deviations from upstream

Places where a literal transliteration is impossible. Each is exempt from `lint_fidelity.mjs`
**by name**, never by an agent's judgement (§4.7).

| site | deviation | why |
|---|---|---|
| `trie.js` node type | `Map`, not a plain object | Python distinguishes dict keys `0` and `"0"`; JS object keys coerce to strings, so any keyword containing `'0'` would collide with the end-of-keyword marker `TRIE_END`. |
| `helper.subclasses` | takes an explicit class registry | no JS equivalent of `inspect.getmembers(sys.modules[name])`. Sorted by class name, because `getmembers` sorts by name and that order is observable in `ALL_FUNCTIONS` / `EXPR_CLASSES`. |
| `helper.seq_get` | supports negative indices | **not optional** — `parsers/bigquery.py:516-517` calls `seq_get(table_parts, -3)` and `-4`. |
| `helper.csv` | keyword-only `sep` as a trailing options object | JS has no keyword arguments. |
| `helper.while_changing` | injected `hash` callback | needs `Expression.__hash__` (P2); upstream late-imports to break the same cycle. |
| `helper.is_iterable` / `flatten` | injected `isExpr` callback | ditto. |
| `time.format_time` | operates on a code-point array | Python slices `string[start:end]` by code point. |
| `Generator.sql()` over left-nested binary chains | trampoline | §4.7 — depth ∝ N. |
| `VALUES`→`UNION` pretty reduction | trampoline | §4.7 — depth ∝ N. |

---

## 9. Depth limits [pending]

`fuzz_depth` (§4.7) fills this table; `DepthLimitError` thresholds are set from it **with
margin**, and are configurable via generator options — the closest honest analogue to
`sys.setrecursionlimit`.

| path | measured max safe N | threshold |
|---|---|---|
| parse — `OR` chain | *pending* | |
| parse — `UNION` chain | *pending* | |
| generate — binary chain | *pending* | |
| generate `pretty` — `VALUES`→`UNION` | *pending* | |

Reference points already measured: a trivial JS frame overflows at depth **9,160**, a
realistic generator frame at **4,225** (Node v22.12.0); upstream ships a test at N=**10,000**
(`test_redshift.py:524`). `node --stack-size` is **rejected** — unavailable to browser
consumers, and raising it past the OS thread stack turns a clean `RangeError` into a segfault.
