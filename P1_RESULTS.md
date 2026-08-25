# P1 — Tokenizer: results

**Verdict: GREEN. Both exit criteria met.**

Scope: PORT_PLAN.md §7 P1 / Linear AIR-1855 — `tokenizer_core.js` (1,217 upstream LOC) +
`tokens.js` (592) + `trie.js`. `trie.js` was already delivered by the P0 calibration spike, so
the remaining scope was the other two files. Reconciled: the plan and AIR-1855 state identical
scope and identical exits; no conflict.

| | toolchain |
|---|---|
| CPython | **3.9.25** (`unicodedata` **13.0.0**) |
| Node | **v22.12.0** (ICU 76.1, Unicode 16.0) |
| upstream | `sqlglot @ 91119bc`, read-only clone at `/tmp/sqlglot-ref` |

Reproduce from a clean tree: `bash spike/run_all.sh` and `bash spike/run_regex.sh`, both exit 0.

---

## Exit 1 — parity probe #1: token streams byte-exact

**23,389 token streams / 291,162 tokens across 33 dialects, 0 divergences.**

Probe #1 as shipped at P0 asserted one thing: that the 443 `TokenType` member names exist. That
is necessary and weak — a tokenizer emitting the right type names at the wrong offsets passes
it. P1's exit needs *streams*, which needs an oracle that did not exist. Two were built:

| artifact | contents |
|---|---|
| `corpus/tokens/settings.json` | the resolved `TokenizerCore.__init__` kwargs for all 34 registered dialects + the JSONPath tokenizer, plus the base `Tokenizer`'s own `__init_subclass__` derivations |
| `corpus/tokens/streams.jsonl` | CPython's token stream for every distinct `(dialect, sql)` pair in the corpus — 23,457 rows |

The stream rows come from three sources, deduplicated: `(atom.read, atom.sql)`, `("", atom.sql)`
— every input under the default tokenizer, the only one P1 actually ports — and
`(atom.write, atom.expected)`, since generated SQL is also tokenizer input and is the half of the
corpus carrying each dialect's own quoting style.

**Why a settings snapshot.** Tokenizing dialect `d` needs `d`'s tokenizer tables, which live in
`sqlglot/dialects/<d>.py` — P5–P9 scope, not P1's. Snapshotting the *resolved* constructor kwargs
gets `tokenizer_core.js` verified against all 34 dialects with zero dialect files ported, and
when the real dialect classes land the same snapshot becomes the assertion that their derivations
are right. Every value in `TokenizerCore.__init__` is plain data, which is what makes this work.

Three layers are checked, in dependency order, so a failure names the layer that broke:

| layer | checks |
|---|---|
| A derivations | 25 — `tokens.js`'s port of `_TokenizerBase.__init_subclass__` against the base `Tokenizer`'s `_QUOTES` / `_FORMAT_STRINGS` / `_COMMENTS` / `_KEYWORD_TRIE` / … and its 14 table inputs |
| B tries | 35 — the same derivation re-run for every dialect configuration from its snapshotted tables |
| C streams | 23,389 rows / 291,162 tokens — token type, text, line, col, start, end and comments on every token, plus the exact `TokenError` message on the 17 rows where Python raises |

`node tools/tokens/check_streams.mjs` runs it standalone with `--dialect` / `--id` / `--verbose`
for diagnosis; `node tools/parity/check.mjs` runs it as probe #1.

### The 68 rows that are skipped, and why

`athena`'s `Tokenizer` overrides `tokenize()` — it re-tokenizes with Hive's or Trino's tokenizer
and prepends a `HIVE_TOKEN_STREAM` sentinel. That is dialect-class logic, not settings, so it is
not reproducible from the snapshot and lands with `dialects/athena.js` at P9. Its 68 rows are
**skipped, counted, and printed on every run** rather than dropped. The exclusion is detected
mechanically (`type(tokenizer).tokenize is not Tokenizer.tokenize`), never by dialect name, so the
next dialect upstream gives a method override is caught without anyone remembering to look.
Athena's underlying streams are Hive's and Trino's, both of which are separately covered.

## Exit 2 — `fuzz_unicode` over tokenization

**GREEN.** `node spike/fuzz_unicode_tokens.mjs`, three parts:

1. **`_py` shims, per code point** — 6,055 code points × `pyUpper` / `pyIsAlnum` /
   `pyIsIdentifierChar` / `pyIsDigit` / `pyIsSpace`, plus 8,034 `pyIntFromStrBase` probes. 0
   divergences. The full-range tables themselves are verified separately over all 1,114,112 code
   points by `spike/verify_unicode_tables.mjs`.
2. **Token streams over a Unicode-targeted SQL corpus** — 4,651 cases, 12,125 tokens, 10
   dialects, 0 divergences. Generators are purpose-built per scanner decision, not random bytes:
   `case_fold`, `astral`, `py_space`, `alnum_edge`, `ident_edge`, `uni_digits`, `heredoc`,
   `surrogate`, plus `soup` as a background. Runs through the *same* checker as the harvested
   corpus, so there is one comparison implementation.
3. **A vacuity check** — see below.

Six lone-surrogate-pair cases are generated and then excluded, per CONTRACTS.md §8: a Python
`str` holds a high+low surrogate as two code points while the same pair in a JS string *is* one
astral character. Counted and printed, not silently dropped.

---

## The measurement that matters: what the harvested corpus cannot see

The vacuity check applies 12 deliberately-wrong ports to a *copy* of `src/` and records who
notices. The interesting output is not "all caught" — it is the split.

| mutation | corpus | fuzz | verdict |
|---|---:|---:|---|
| token end off-by-one *(control)* | 23,372 | 3,494 | both |
| size via UTF-16 `.length` | **2** | 1,247 | both |
| delimiter width via `.length` | 1 | 5 | both |
| `isspace` via JS regex | **0** | 638 | **fuzz only** |
| `isidentifier` via ASCII regex | **0** | 16 | **fuzz only** |
| `isdigit` via ASCII regex | **0** | 20 | **fuzz only** |
| hex validity via regex | **0** | 1 | **fuzz only** |
| `strip` via JS `trim` | **0** | 6 | **fuzz only** |
| keyword text via `toUpperCase` | 0 | 0 | equivalent |
| var lookup via `toUpperCase` | 0 | 0 | equivalent |
| `isalnum` via ASCII regex | 0 | 0 | equivalent |
| trie folds via `toUpperCase` | 0 | 0 | equivalent |

**5 of 8 killable mutations are invisible to the 23,389-row harvested corpus; 0 are visible only
to it.** The corpus is 4 non-ASCII SQL strings out of 8,454 (0.05%), so this is R4 / §4.6's
`too_wide` pattern, measured, inside the tokenizer. `.length` instead of code-point length is
caught by *two* corpus rows out of 23,389 — a near miss, not a safety margin.

**Equivalent mutants are asserted in the opposite direction.** Four mutations cannot be killed
because, given today's tables, they compute the same answer. Each carries a written reason, and
the assertion is inverted: if an equivalent mutant *dies*, the reasoning was wrong and that is a
failure too. All four rest on one premise — that no tokenizer table key in any of the 35
configurations is non-ASCII — which is machine-checked against the settings snapshot before the
matrix runs. The day upstream adds a non-ASCII keyword, those claims retract themselves instead
of quietly becoming false.

---

## Additions to `_py/` and `_gen/`

Four Python predicates and one parser the tokenizer reaches, none of which had a shim:

| export | why the obvious JS is wrong |
|---|---|
| `pyUpper` | `toUpperCase()` is bound to the *engine's* Unicode version — Node 16.0 vs CPython 13.0 diverge on **67** code points. One-to-many (`'ß'`→`'SS'`), and output-visible: `tokenizer_core.py:853` emits `text=word.upper()`. |
| `pyIsAlnum` | gates `_advance(alnum=True)` on every comment / var / value scan |
| `pyIsIdentifierChar` | `str.isidentifier()` on one code point is XID_Start ∪ `_`, far wider than `[A-Za-z_]` |
| `pyIsDigit` | `str.isdigit()` accepts superscripts and Unicode decimal digits |
| `pyIntFromStrBase` | `int(s, 2/16)` folds Unicode decimal digits to ASCII (`int('١٠', 16) === 16`), allows underscores, and treats `0b` as a *prefix* in base 2 but as two *digits* in base 16 |

`_gen/unicode.js` gains `isAlnum` / `isIdentifierStart` / `isDigit` (delta-encoded ranges) and
`upperCodePoint` (a 1,485-entry code-point → **string** map, because `str.upper()` is one-to-many).
All are verified exact over the full 1,114,112-code-point range, and the verifier now also prints
how far Node's own `toUpperCase()` is from CPython's — 67 — so the table's justification is a
number the suite recomputes rather than a claim in a comment.

`str.upper()` is asserted to be context-free (unlike `str.lower()`'s final-sigma rule) at table
generation time, since a per-code-point table cannot model a context-sensitive mapping.

---

## Second finding: a depth-∝-N recursion in the tokenizer

§4.7 / R11 enumerated the paths where recursion depth grows with *input size* rather than query
nesting, and found them in the generator. There is one in the **tokenizer** too, and it was
missed there: `TokenizerCore._add` recurses into `_scan`, which can recurse back into `_add`,
whenever a COMMAND token follows `;` or `BEGIN` (`tokenizer_core.py:789-800`).

Measured on both sides, and now measured on every `fuzz_depth` run:

| path | JS max N | CPython max N (default `recursionlimit` 1000) |
|---|---:|---:|
| `BEGIN SHOW` chain | **1,734** | **248** |
| `; SHOW` chain | 65,536+ | 65,536+ (neither side recurses) |

Unlike the generator case this is benign, for three reasons: both sides funnel the overflow
through `tokenize`'s catch-all into a `TokenError`, so the failure *mode* is identical; the JS
threshold is **7.0×** CPython's at the default limit, which sqlglot never raises — the one place
the fixed JS stack is the more permissive of the two; and `fuzz_depth` now fails if the JS number
ever drops below CPython's. No `DepthLimitError` threshold is set for the tokenizer, because with
7× headroom and a matching failure mode one would make the port strictly *less* capable than
upstream. Recorded in CONTRACTS.md §9.2, which previously had no non-pending rows.

---

## Calibration re-baseline (PORT_PLAN.md appendix A8)

A8 requires re-baselining the LOC/agent-hour constant after P1. Reported honestly:

| | raw | code |
|---|---:|---:|
| upstream ported (`tokenizer_core.py` + `tokens.py`) | **1,811** | **1,603** |
| JS production written (`src/tokenizer_core.js` + `src/tokens.js`) | 2,117 | 1,666 |
| oracle + checker + fuzzer + generators (`tools/tokens/`, `spike/`) | 1,452 | — |

Unlike the P0 calibration, **this sample is mostly real code**: 1,603 of 1,811 upstream lines are
non-comment, non-docstring, versus 292 of 1,251 for `time.py`/`helper.py`. The code-LOC figure is
therefore 5.5× P0's on a similar amount of elapsed time.

**The recommendation is unchanged: do not rescale §10 on this.** P1 is still not representative of
the phases that dominate the budget. `tokens.py` is **58% data literal** (the 318-entry `KEYWORDS`
map and the 30-entry `SINGLE_TOKENS` map, both transcribed mechanically from upstream *source
text* rather than by hand — see the note on transcription below), and `tokenizer_core.py` is a
single class with no expression model, no dispatch table, no dialect inheritance and no
`arg_types` ordering. The oracle and fuzzer together cost roughly as much as the port itself, and
that cost does not amortise the way P0's harness did — every phase needs its own oracle.

P3 is the measurement that matters: it is the first phase dominated by the >30-LOC method tail
that §8.5 measured at 56% of all parser method LOC. R2's stated risk is unchanged until then.

**On mechanical transcription.** The two big literals were emitted by
`tools/tokens/transcribe_tables.py`, which reads upstream's *source text* and rewrites each
`"KEY": TokenType.X,` line as `["KEY", TokenType.X],`, preserving line order and inline comments.
The output is committed as ordinary hand-ported source, not `_gen/`. Transcribing 343 entries by
hand is a transcription-error generator, and §4.3 already scopes codegen to literal tables for
exactly this reason.

The script also has a `--check` mode, wired into `spike/run_all.sh`, which re-derives both
literals and diffs them against `src/tokens.js`. That is deliberately a *different* assertion from
the settings snapshot: a snapshot of a Python dict cannot distinguish "transcribed in upstream's
declaration order" from "sorted", and §4.6 establishes that table order is observable. So the
values are checked against the snapshot and the **order** is checked against upstream's source —
which is what §8.1 Rule 2′ asks for, by a different mechanism than per-line anchors.

---

## Recorded deviations (CONTRACTS.md §8)

Five, all mandated or forced, none discretionary:

| deviation | why |
|---|---|
| `TokenizerCore.__init__`'s 26 kwargs → one options object | JS has no keyword arguments; same precedent as `helper.csv` |
| `TokenizerCore.tokenize` returns `{tokens, codePoints}` | CONTRACTS.md §2's frozen contract; a bare list here would leave the raw JS string as the only handle |
| tokenizer dicts/sets are `Map`/`Set` | `keywords["constructor"]` on a plain object returns `Object.prototype.constructor` — the `trie.js` hazard again |
| `__init_subclass__` → explicit `initTokenizerSubclass(cls)` | JS has no such hook; §4.4's "explicit derivation performed once at module init" |
| `Dialect.get_or_raise` → injected `setDialectResolver()` | the registry lands at P5 and a JS constructor cannot `await import(...)`. Resolving a dialect *name* **throws** rather than falling back to the default dialect — a silent fallback would make every per-dialect parity row vacuously green |

Method **order** in both files matches upstream exactly. The five Python-indexing helpers
(`_at`, `_slice`, `_find`, `_count`, `_rfind`) are inserted as one contiguous block after
`reset()`; every other method is in upstream's source order.

`Tokenizer.KEYWORDS` is seeded one entry per line in upstream declaration order (§8.1 Rule 2′)
but **without** per-entry `// py:` anchors, unlike `parser.js`/`generator.js`. Rule 2′ exists
because P9's 24 dialect efforts all append to those files' shared tables; a dialect's tokenizer
keywords live in its own `dialects/<x>.js` subclass and never touch this literal. Order is
CI-asserted against the settings snapshot either way. Flagged rather than done silently.

---

## Artifacts

| path | |
|---|---|
| `src/tokenizer_core.js` | 1,442 lines — `TokenType` (443), `Token`, `TokenizerCore` |
| `src/tokens.js` | 673 lines — derivation + `Tokenizer` tables |
| `tools/tokens/extract_settings.py` | settings snapshot, 35 configurations |
| `tools/tokens/harvest_streams.py` | 23,457 stream rows |
| `tools/tokens/check_streams.mjs` | the three-layer checker; probe #1's engine |
| `spike/py/gen_tokens_cases.py` | Unicode case generator |
| `spike/fuzz_unicode_tokens.mjs` | shims + streams + the mutation matrix |
| `spike/py/gen_depth_ref.py` | CPython tokenizer depth baseline |
