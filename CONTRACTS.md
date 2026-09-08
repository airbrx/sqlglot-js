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
| `pyIntFromStrBase(s, base)` | `int(s, base)`, bases 2 and 16 | **P1.** Returns `null` where Python raises. Accepts a base-specific prefix (`0b` is a prefix in base 2 and two DIGITS in base 16, so `int('0b', 16) === 11`), one underscore immediately after that prefix, and Unicode decimal digits (`int('١٠', 16) === 16`). `tokenizer_core` observes only success/failure, but the value is returned so it can be fuzzed against CPython's. |
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
| `pyIsAlnum` / `pyIsDigit` | `str.isalnum` / `str.isdigit` | **P1.** String-level; empty is `false`. `isalnum` gates `_advance(alnum=True)`; `isdigit` gates the heredoc-tag fallback. |
| `pyIsIdentifierChar(s)` | `str.isidentifier` | **P1.** SINGLE code point only (XID_Start plus `_`) — `tokenizer_core.py:970`'s only caller passes `self._peek`. Throws on a longer string rather than implementing an unused multi-character branch. |
| `pyUpper(s)` | `str.upper()` | **P1.** NOT `toUpperCase()`, which is bound to the engine's Unicode version: Node v22 (16.0) vs CPython 3.9.25 (13.0) diverge on **67** code points. One-to-MANY (`'ß'`→`'SS'`, `'ﬆ'`→`'ST'`, so `'ﬆRUCT'` tokenizes as `STRUCT`). Output-visible at `tokenizer_core.py:853`. |

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

**Implemented at P1 [verified].** `codePoints` is `[...sql]` — an array of one-code-point
**strings**, matching `cpArray()` and what `errors.js::highlightSql` already slices; not an array
of numbers. `TokenizerCore.tokenize` returns the same shape as `Tokenizer.tokenize` rather than
upstream's bare `list[Token]`, so there is no layer where the raw string is the only handle.
`Token.start` / `Token.end` / `Token.col` and the tokenizer's internal `_current` / `_start` are
all code-point offsets, exactly as in Python. Asserted per row by
`tools/tokens/check_streams.mjs`: `codePoints.join("") === sql` and `codePoints.length` equals the
code-point count.

---

## 3. `_gen/` schema [design]

Generated, never hand-edited. CI gate: `make codegen && git diff --exit-code src/_gen`, plus a
committed `_gen/.manifest.sha256` (§8.1 Rule 4).

| file | generator | contents |
|---|---|---|
| `_gen/unicode.js` | `tools/gen_unicode_tables.mjs` | `isPrintable`, `isLowercase`, `isUppercase`, `isSpace`, `isTitlecase`, `decimalValue`, `PROVENANCE`, and **added at P1** `isAlnum`, `isIdentifierStart`, `isDigit`, `upperCodePoint`. Delta-encoded base-36 ranges, **ends stored EXCLUSIVE**, binary search on parity. `upperCodePoint` is a code-point→**string** map (1,485 entries) because `str.upper()` is one-to-many. |
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
        "m":{"line":1,"col":7,"start":0,"end":12},"cm":null,"t":null},
 "repr":"Select(\n  expressions=[...])"}
```

- `a` is an **ordered array of `[key, value]` pairs including nulls and empty lists** — this
  pins `arg_types` insertion order, which is observable in output SQL.
- `repr` is Python's `Expression.__repr__`, byte-exact. Asserting it is what makes the AST gate
  non-tautological and human-readable.
- **`astLoad` must not run `INIT_HOOKS`.** It constructs with a no-arg constructor plus `set()`,
  bypassing `__init__`, exactly like `serde.load`. Concretely: kwargs-construction of `DateAdd`
  uppercases the unit; `astLoad` does not. Unit-tested at P2.
- **`t` carries `node.type`** (the property, not the raw `_type` attribute — for `Cast` nodes the
  property falls back to `.to` when `_type` is unset, and `repr()` reflects that resolved value)
  when it is truthy and the node is not itself a `DataType` (self-reference guard, matching
  `core.py:2594-2595`). Otherwise `null`. This is not vestigial: parse-time type inference is a
  real, dialect-dependent upstream behavior, not an optimizer-only concern — e.g. `TO_CHAR` under
  Snowflake calls `annotate_types()` at parse time to disambiguate `ToChar` vs `TimeToStr`
  (`dialect.py`'s `build_timetostr_or_tochar`), mutating `_type` on an arg as a side effect; the
  same SQL under the default dialect parses without it. 2,344 of 15,540 AST-oracle rows (~15%)
  carry a non-null `t` this way. Before this field existed, byte-identical `ast` payloads existed
  for atoms with different `repr` (found via P2's `astLoad` round-trip gate going NO-GO on
  atom `1cae856d22aaba04` vs `1a5105cd5965e49e`) — an unsatisfiable contract, not a P2 bug.
  `bigquery.py`, `databricks.py`, and `hive.py` all import `TypeAnnotator` for the same reason;
  P3+ must call the equivalent type-disambiguation hook wherever upstream does, not just at
  `astLoad`/optimizer time.

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
| `test_errors.py` | **PROVEN [verified]** | 13 tests / 49 assertions (36 with string literals) run **green through the bridge against the JS `highlightSql`**. Upstream's own assertions, unmodified. |
| `test_transpile.py` | **95% measured** | 43 assertions, only **2** touch object graphs. Needs `transpile`, so the run lands at P4; the satisfiability is measured now rather than assumed. |
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
| `_py/collections.js` `frozensetKey` separator | `","`, explicitly not `"\0"` | a NUL byte makes `grep` treat a source file as binary, which silently breaks the grep-based fidelity lints. Found the hard way. |
| `TokenizerCore.__init__` | 26 kwargs become one options object | JS has no keyword arguments. Same precedent as `helper.csv`. Field order is upstream's parameter order and is asserted against `corpus/tokens/settings.json`. |
| `TokenizerCore.tokenize` | returns `{tokens, codePoints}`, not `list[Token]` | §2's frozen contract. Returning the bare list at this layer would leave the raw JS string as the only handle on the input. |
| tokenizer dicts/sets | `Map` / `Set`, never plain objects | Same reason as `trie.js`. `keywords["constructor"]` on a plain object returns `Object.prototype.constructor`, handing the scanner a function where it expects a TokenType. |
| `_TokenizerBase.__init_subclass__` | explicit `initTokenizerSubclass(cls)` call after each class body | JS has no `__init_subclass__` hook. §4.4's "explicit derivation performed once at module init". Static inheritance reproduces the MRO read path unchanged. |
| `Tokenizer.__init__`'s `Dialect.get_or_raise` | injected via `setDialectResolver()` — **installed at P5** by `dialects/dialect.js` | `dialects/dialect.js` lands at P5 and a JS constructor cannot `await import(...)`. Until then only an already-resolved settings object (or `null` for the base `Dialect` defaults) is accepted; resolving a dialect *name* **throws** rather than silently falling back to the default dialect, which would make every per-dialect parity row vacuously green. |
| dialect `Parser` SUBCLASS selection in the P3 probes (**superseded at P5**: `standInDialect` now instantiates a registered `Dialect` subclass whose `static Parser` comes from this same map, so `PARSER_CLASSES` is its single declaration rather than a parallel one) | `parserClassFor(dialect)`, a literal name -> class `Map` in `spike/p3/dialect_tokenizer.mjs` | `src/parsers/snowflake.js` overrides 17 class tables and 38 methods, so parsing a Snowflake row with the base `Parser` is a different grammar, not a subset — but §8's row above forbids resolving a dialect by NAME at runtime and `Parser._resolveDialect` throws to enforce it. That rule is about the PARSER resolving a name it was handed; the probe resolves nothing, because each corpus row already carries its dialect as metadata (the `corpus/ast/<dialect>.jsonl` filename). Test-harness code only; `src/` gains no registry, and `_resolveDialect` is unchanged. |
| `_Dialect` metaclass registration | explicit `registerDialect(name, DialectClass)` | upstream's `_Dialect._try_load` does `importlib.import_module(f"sqlglot.dialects.{key}")` ON DEMAND when a name is first looked up. JS dynamic `import()` is async and `get_or_raise` is called from `Tokenizer`'s constructor, which cannot await — the same wall as the row above. Registration is therefore eager and explicit, in the shape `registerExprClasses` / `registerInitHook` / `initTokenizerSubclass` already established. The key is a PARAMETER, not `klass.name`: `constructor.name` is not a contract in JS (a minifier rewrites it) and nothing else in this port keys off it. |
| `Dialect` settings read as `self.X` from an instance | mirrored onto `klass.prototype` by `registerDialect` | Python resolves `self.NULL_ORDERING` through the MRO to the class attribute; JS `static` fields are on the constructor and NOT on the prototype, so `instance.NULL_ORDERING` is `undefined`. `src/parser.js` and every `src/parsers/*.js` read ~40 settings as `this.dialect.X` and those call sites are faithful transliterations that must not change. The prototype mirror reproduces the Python lookup exactly, including subclass shadowing, with no per-instance copying. Mirrored set is `/^[A-Z][A-Z0-9_]*$/` plus the four autofilled `*_class` names — methods are excluded, because `format_time` is both a static and a prototype method. |
| `Dialect.format_time` | a `static` AND an identically-named prototype method | a Python `@classmethod` is callable on an instance; a JS `static` is not. `build_formatted_time`'s `_builder` calls `dialect.format_time(fmt)` on the resolved INSTANCE, so without the bridge every `TO_DATE`/`TO_TIMESTAMP(str, fmt)` on a dialect with a non-empty `TIME_MAPPING` throws "is not a function". |
| `Dialect.__eq__` / `__hash__` | named `equals()` / `hash()` methods | JS has no operator overloading. Same treatment the `Expr` relations already get. |
| `parse_one` | lives in `dialects/dialect.js`, not a package root | upstream is `sqlglot/__init__.py:134`, and `expressions/core.py:2566`'s `maybe_parse` reaches it with a function-level `import sqlglot` precisely to break the cycle root -> expressions -> root. JS has no synchronous equivalent, so it sits next to the registry it needs; a future `src/index.js` should re-export rather than redefine it. |
| `Dialect.tokenize` | returns the token list, unwrapping `{tokens, codePoints}` | `TokenizerCore.tokenize`'s row above returns both; this method is upstream-shaped (`-> list[Token]`) and hands back what `Parser.parse(tokens, sql)` takes. |
| `Dialect().version` | an array of **BigInt** | the default is `sys.maxsize` = 2^63-1, which is not representable exactly as a JS Number (`JSON.parse` alone rounds it to 9223372036854776000). BigInt keeps it exact, so P8's `compareVersion` does not need the "non-2^63 sentinel" §7 P8 anticipated inventing. |
| `registerDialect`'s `SUPPORTED_JSON_PATH_PARTS` pruning (py:304-309) | `NotPorted`, thrown when a `generator_class` is present | needs `Generator` (P4) and `ALL_JSON_PATH_PARTS` from the unported `sqlglot/jsonpath.py`. Written as a guard rather than a comment so the gap has a READER and fires the moment a real generator is registered (PORT_PLAN.md R19). |
| adjacent lone surrogates in a string | **unrepresentable; excluded from tests** | a Python `str` can hold a high surrogate followed by a low surrogate as **two** code points; a JS string is UTF-16, so that same pair **is** one astral character. Isolated lone surrogates round-trip fine and are tested; 77 generated repr cases are excluded on this basis and the count is printed, never silently dropped. |

---

## 9. Depth limits [pending]

`fuzz_depth` (§4.7) fills this table; `DepthLimitError` thresholds are set from it **with
margin**, and are configurable via generator options — the closest honest analogue to
`sys.setrecursionlimit`.

### 9.1 Engine ceiling — measured [verified]

`node spike/fuzz_depth.mjs`, Node v22.12.0, worst of three runs each:

| frame shape | overflow depth | §4.7's figure |
|---|---:|---:|
| trivial | **4,125** | 9,160 |
| generator-like (5 args, locals, string building) | **3,350** | 4,225 |
| parser-like (backtracking state + try/catch) | **3,575** | — |

**The measured numbers are lower than §4.7's and I have not reconciled the difference.**
Likely causes: my probe runs from an ESM module top level under a top-level `await`, so it
starts with more live stack than a bare call would; and "worst of three" is deliberately
pessimistic because the ceiling moves with whatever is already on the stack.

Either way the conclusion **strengthens**: the gap to upstream's N=10,000
(`test_redshift.py:524`) is larger than the plan assumed, so the trampolines in §4.7 item 3
are not optional. Thresholds must be set from the worst observed value, never the best.

**Suggested `DepthLimitError` threshold: 2,010** (0.6 × the realistic frame). Conservative
on purpose — it must fire *before* V8's `RangeError`, because unwinding mid-generate is not
a supported recovery path.

`node --stack-size` remains **rejected**: unavailable to browser consumers, and raising it
past the OS thread stack turns a clean `RangeError` into a segfault.

### 9.2 Per-path max N [pending P4]

The linear-growth input generators exist and are shape-asserted (`orChain`, `unionChain`,
`wideValues`, `inList`, `addChain`, over N ∈ {10, 100, 1000, 5000, 10000}). The per-path
numbers need the JS parser/generator, so they land at P4 rather than being guessed here.

| path | measured max safe N | threshold |
|---|---|---|
| **tokenize — `BEGIN SHOW` chain** | **1,734** (CPython at its default limit: **248**) | *see below* |
| **tokenize — `; SHOW` chain** | **no recursion** (65,536+ both sides) | — |
| parse — `OR` chain | *pending P4* | |
| parse — `UNION` chain | *pending P4* | |
| generate — binary chain | *pending P4* | |
| generate `pretty` — `VALUES`→`UNION` | *pending P4* | |

**Tokenizer rows added at P1 [verified]** — `node spike/fuzz_depth.mjs`, baseline from
`python3 spike/py/gen_depth_ref.py`. §4.7 enumerated the depth-∝-N paths in the *generator*;
there is one in the **tokenizer** too, and it was missed there. `TokenizerCore._add` recurses
into `_scan`, which can recurse back into `_add`, whenever a COMMAND token follows `;` or
`BEGIN` (`tokenizer_core.py:789-800`). Depth grows with input size, not with query nesting.

Three things make this benign rather than a second R11:

1. Both sides funnel the overflow through `tokenize`'s catch-all into a `TokenError`, so the
   failure **mode** is identical — unlike the generator, where JS raises a bare `RangeError`.
2. The JS threshold is **7.0× higher** than CPython's at its default `recursionlimit` of 1,000,
   which sqlglot never raises. This is the one place where the fixed JS stack is the *more*
   permissive of the two.
3. It is corpus-invisible in both directions, so `fuzz_depth` now measures it on both sides
   every run and fails if the JS number ever drops below CPython's.

No `DepthLimitError` threshold is set for the tokenizer: with 7× headroom and a matching
failure mode, adding one would make the port strictly *less* capable than upstream.

Note the asymmetry that makes this tractable: the **non-pretty** `VALUES` path
(`generator.py:2750`) is an iterative `" UNION ALL ".join(...)` and is safe at any width.
Only the **pretty** path builds the left-nested `Union` chain. `test_redshift.py:529`
asserts the *iterative* path at N=10,000 — which is precisely why 15,540/15,540 atoms can
pass with the recursive path broken.
