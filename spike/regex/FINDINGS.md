# P0 regex spike — findings

**Scope:** PORT_PLAN.md §4.6 ("Regex") and §3.4 item 2 (`fuzz_regex.py`). Builds
`src/_py/re.js` and a differential corpus against CPython.
**Upstream:** sqlglot @ `91119bc`, read-only clone at `/tmp/sqlglot-ref-regex`.
**Toolchain:** CPython 3.9.25 (Unicode 13.0) · Node v22.12.0 (ICU 76.1, Unicode 16.0).

This is the regex sub-task of AIR-1854. It is **not** the Day 1–3 go/no-go spike
(Decimal/float + Unicode classification), which runs separately on `p0-foundation`.

---

## 1. Result

`fuzz_regex` is PORT_PLAN.md §3.4 target 2, a mandatory P0 exit criterion. Run it with:

```
bash spike/run_regex.sh                  # regenerate corpus + differential + spec test
node spike/fuzz_regex.mjs                # differential only (uses committed corpus)
node spike/fuzz_regex.mjs --selftest     # the ratchet's own logic
```

```
fuzz_regex — _py/re.js vs CPython, 19,597 cases

surface             pass    fail    skip
oracle               496       2       0
match              17916       2     230
sub                   41       0       0
escape               902       0       0
escape_build           8       0       0
TOTAL              19363       4     230

ALL sqlglot-reachable patterns   2867 pass    0 fail    0 skip

  FUZZ_REGEX: GREEN — 19,363 pass, 4 known gaps, 0 unexpected
```

Three things make this a fuzz target rather than a regression net.

**A ratchet, not a threshold.** `KNOWN_GAPS` in `spike/fuzz_regex.mjs` names the four
cases that cannot pass, each with a reason and a reachability note. Three ways to go RED:
a new failure, a listed gap that *starts* passing, or a listed gap whose case has left the
corpus. That is §3.3 rules 1 and 2 applied locally — the list cannot rot.

**A vacuity check.** A differential that both the correct and the naive implementation
pass is not testing anything; `fuzz_toowide` makes the same argument about `.length` vs
`cpLen`. So the target asserts a naive port *fails*, and by how much:

| naive approach | cases it gets wrong |
|---|---|
| `new RegExp(p, 'u')` rejects a CPython-valid pattern | 72 |
| `new RegExp(p, 'u')` accepts a CPython-**invalid** pattern | 7 |
| group count = `(` not followed by `?` | 18 |
| CPython-byte-identical `re.escape` output, used under `/u` | 256 |
| `\1` → `$1` by string replace | 22 |

Any of these reaching zero is RED: the corpus has stopped exercising that divergence.

**A coverage assertion.** Every surface §3.4 item 2 names by hand must be non-empty —
group counting (498), named groups (717), `\A`/`\Z` (189), `re.VERBOSE` (1,228),
`re.sub` templates (41), `re.escape` under `/u` (910), runtime-constructed patterns (428).

The four remaining failures and 230 skips are all on adversarial patterns from the
structural sweep, not on anything sqlglot reaches (§5), and all four are *in the corpus*
so they are measured every run rather than described in prose.

---

## 2. Why a runtime layer is needed at all (the census)

17 direct `re.*` calls in `sqlglot/`: 13 `re.compile`, 3 `re.escape`, 2
`re.fullmatch`. 11 of the 13 `re.compile` calls take a string literal and could
in principle be rewritten to JS regex literals at build time. **Two cannot**, and
they are the reason this module exists:

| site | construction | why build-time rewriting fails |
|---|---|---|
| `sqlglot/generator.py:1667` | `re.compile(rf"{escape.name}(\d+)")` | `escape.name` is the `UESCAPE` character from user SQL |
| `sqlglot/parsers/bigquery.py:127` | `re.compile(args[1].name).groups == 1` | `args[1].name` is the entire user regex literal from `REGEXP_EXTRACT(x, '…')` |

`bigquery.py:127` is the sharpest requirement in the whole file — it needs
CPython's **group count** and CPython's **validity verdict** for an arbitrary
string, and it is output-visible:

```python
try:
    group = re.compile(args[1].name).groups == 1
except re.error:
    group = False
```

`group` decides whether the built expression carries `group=1` or the dialect
default, which changes the emitted SQL. So `pyReGroups` must agree with CPython
on both "does this compile?" and "how many groups?" **even for patterns JS cannot
execute** — which is why the oracle and the translator are one pass with two
independent outputs, and why an untranslatable pattern still returns a group
count instead of throwing.

Two further sites take non-constant patterns and so were not harvested
automatically: `sqlglot/optimizer/qualify_columns.py:1104` (`re.fullmatch(ilike_pattern, …)`,
whose pattern is built by the `re.escape` loop at `:1176`/`:1182` — covered by the
`escape_build` cases) and `sqlglot/executor/env.py:195` (the executor, permanently
out of scope per PORT_PLAN.md §1).

---

## 3. Verified: `\w` → `[\p{L}\p{Nd}\p{Nl}\p{No}_]`, and it is output-visible

PORT_PLAN.md §4.6 asserts this mapping "for identifier quoting specifically" and
says findings should be evidenced rather than taken on trust. Both halves check out.

**The call site is real.** `sqlglot/expressions/core.py:2810` defines
`SAFE_IDENTIFIER_RE = re.compile(r"^[_a-zA-Z][\w]*$")`, and `:2843` reads
`quoted=not SAFE_IDENTIFIER_RE.match(name) if quoted is None else quoted`. It is
consumed at `builders.py:322`, `builders.py:783`, `parsers/mysql.py:551`,
`dialects/dialect.py:1148`, `generators/presto.py:692`, and — as the default
`SAFE_JSON_PATH_KEY_RE` — at `generator.py:854`/`:5366`. Two dialects override it
with their own `\w` patterns: `generators/hive.py:237` (`^[_\-a-zA-Z][\-\w]*$`)
and `generators/bigquery.py:279` (`^[\-\w]*$`).

**The divergence changes SQL.** Against the real library:

```
exp.select(exp.column('café')).from_('t').sql()   ->  SELECT café FROM t
```

A port spelling Python's `\w` as JavaScript's `\w` (`[A-Za-z0-9_]`) computes
`SAFE_IDENTIFIER_RE.match('café') is None`, sets `quoted=True`, and emits
`SELECT "café" FROM t`. Same for `aÊß`, `aЖ`, `naïve_col`, `aⅣ` (Nl), `a½` (No),
`a٠` (Nd). Asserted in `spike/regex/test_identifier_quoting.mjs`.

**The mapping is exact.** A full `0..0x10FFFF` sweep of CPython 3.9.25
(`gen_regex_cases.py --sweep`, output committed at
`spike/regex/corpus/py_unicode_classes.json`) compared against candidate JS classes:

| CPython class | candidate | CPython-only | JS-only |
|---|---|---|---|
| `\w` (133,023 cp) | `[\p{L}\p{Nd}\p{Nl}\p{No}_]` | **0** | 9,917 |
| `\w` | `[\p{Alphabetic}\p{Nd}\p{Nl}\p{No}_]` | 0 | 11,412 |
| `\w` | `[\p{L}\p{M}\p{Nd}\p{Pc}]` | 1,131 | 12,407 |
| `\d` (650 cp) | `\p{Nd}` | **0** | 110 |
| `\s` (29 cp) | `[\t\n\x0b\f\r\x20\x1c-\x1f\x85\p{Zs}  ]` | **0** | **0** |
| `\s` | JS `\s` | 5 (`1c 1d 1e 1f 85`) | 1 (`feff`) |

The `\s` row independently confirms §4.6's "differ on exactly 6 code points".
Note that the two *tempting* alternatives for `\w` are both wrong: `\p{Alphabetic}`
over-matches, and `[\p{L}\p{M}\p{Nd}\p{Pc}]` is wrong in both directions —
CPython's `\w` excludes combining marks, which is why NFD `café` is not a safe
identifier while NFC `café` is.

### 3a. The residual is a Unicode-database version skew, and it is a real hazard

The 9,917 `\w` and 110 `\d` "JS-only" code points are **100% unassigned in
CPython 3.9's database** (`unicodedata.category(chr(c)) == 'Cn'` for every one of
them) and assigned in Node 22's ICU. So the mapping is semantically exact; the
divergence is entirely CPython 13.0 vs ICU 16.0.

That is not harmless. `SAFE_IDENTIFIER_RE` gates identifier quoting, so an
identifier containing a character assigned in Unicode 14/15/16 is quoted by
CPython 3.9 and unquoted by Node 22 — a genuine output-SQL difference that
depends on *two* library versions, neither of which is the pinned sqlglot commit.

This is structurally R6 (PORT_PLAN.md §9), which already records the CPython patch
version in `corpus/PROVENANCE.json`, but R6 is written about the *interpreter*.
**Recommendation:** extend `PROVENANCE.json` to record
`unicodedata.unidata_version` on the harvest side and `process.versions.unicode`
on the runner side, and treat a mismatch the same way §5.2 treats a Python floor
move — fail loudly rather than emit a stale corpus. `gen_regex_cases.py` already
writes both into `meta.json` and into the sweep file.

This overlaps the `_py/unicode.js` work owned by the `p0-foundation` session; it
is flagged here rather than acted on, since that file is not this branch's to touch.

---

## 4. Divergences found and closed

Each was found by the corpus, not by reading code. Ordered by how badly a
plausible port gets them wrong.

**4.1 `re.escape` output is not valid JS regex source.** CPython ≥3.7 escapes
exactly `()[]{}?*+-|^$\.&~#` plus literal ` \t\n\r\v\f`, with a bare backslash.
Under a JS `u` flag, `IdentityEscape` is restricted to syntax characters, so
`\-`, `\&`, `\~`, `\#`, `\<space>` and `\<TAB>` are all **SyntaxErrors**. A port
that transliterates `re.escape` literally produces patterns that fail to compile
at `qualify_columns.py:1176`. `pyReEscape` emits numeric escapes for that subset;
`pyReEscapeExact` keeps the byte-identical form for differential testing.

**4.2 Patterns valid in CPython, SyntaxError in JS `/u`.** A lone `]`, `}` or `{`
is a literal in CPython and a SyntaxError under `/u`; so is `a{,3}`. This is
directly reachable at `generator.py:1667`: `UESCAPE ']'` yields the pattern
`](\d+)`, which CPython compiles and `new RegExp('](\\d+)', 'u')` rejects. The
translator emits `\x5d` etc. so every CPython-valid pattern that JS can express
at all compiles.

**4.3 `must_advance`.** CPython's scanner (`_sre.c`) sets
`must_advance = (state.ptr == state.start)` after each match, and `must_advance`
makes the engine **reject a zero-length match at the start position and backtrack
into the remaining alternatives** before moving on. JS has no equivalent; a
"match then bump `lastIndex` by one" loop diverges:

```
re.findall(r'|(\d+)', '\\0041')  ==  ['', '', '0041', '']     CPython
                                     ['', '', '', '', '', '']  naive JS loop
```

Reachable: `UESCAPE '|'` at `generator.py:1667` builds exactly `|(\d+)`, and
`generator.py:1674` then calls `.sub()` on it. Implemented as an explicit scan
protocol; all of `findall`/`finditer`/`sub`/`subn`/`split` route through it.

**4.4 Code-point vs UTF-16 offsets.** `Match.start`/`end`/`span` were reporting
UTF-16 code units; CPython reports code points, so `re.search(r'\Z', '😀')` is
`(1, 1)` in CPython and `(2, 2)` from a raw JS RegExp. V8 will also report a
zero-width match at an index *between* a surrogate pair, which CPython's
code-point engine cannot produce. Both fixed. This is the same hazard class as
PORT_PLAN.md §4.6 "Indexing" and §3.4's `fuzz_toowide`, and it is
**corpus-invisible upstream**: no sqlglot call site reads a match offset today
(every one is either a boolean test or reads match *content*), so the dialect
suite cannot catch it. It is a live trap for P9 dialect work.

**4.5 Anchors and newlines.**
- CPython `$` (no MULTILINE) also matches just before a trailing newline; JS `$`
  without `m` does not. Emitted as `(?=\n?$)`.
- CPython MULTILINE splits on `\n` only; JS `m` also splits on `\r`, U+2028,
  U+2029. Emitted as `(?:^|(?<=\n))` / `(?=\n|$)`, never the JS `m` flag.
- CPython `.` excludes only `\n`; JS `.` also excludes `\r`, U+2028, U+2029.
  Emitted as `[^\n]`, with the `s` flag used only for DOTALL where the two agree.
- CPython `\b`/`\B` are Unicode-aware for `str` patterns; JS `\b` is always
  ASCII. Rewritten as explicit lookaround over the Unicode word class.
- `\B` fails outright on an empty subject (`sre_lib.h` opens
  `if (state->beginning == state->end) return 0;`) even though position 0 is not
  a boundary.

**4.6 Validity rules JS does not share.** CPython rejects a quantifier on
`^ $ \A \Z \b \B` ("nothing to repeat") but *accepts* one on `(?=a)`, and
requires lookbehind to be fixed-width (`(?<=a*)` and `(?<=a|bb)` are errors,
`(?<=a|b)` is fine). Both had to be reproduced in the oracle, because
`bigquery.py:127` reads `.groups` only when `re.compile` did not raise. Width
tracking mirrors `sre_parse.SubPattern.getwidth`, including its treatment of a
backreference as `(0, MAXWIDTH)`.

**4.7 `re.sub` template translation.** `\1` → `$1`, `\g<name>` → `$<name>`,
`\g<0>` → `$&` (JS `$0` is a literal). A literal `$` in a CPython template must
become `$$`. Inside a template `\b` is a backspace, not a word boundary; `\q` is
an error; `\-` keeps its backslash. The trap worth naming: **JS reads `$nn`
greedily**, so a CPython template of `\1` followed by a literal `2` silently
becomes group 12 once the pattern has ≥12 groups. `pyReTemplate` detects that,
returns `js === null` with a reason, and `sub()` uses a replacer function, which
has no `$` ambiguity at all. The two live templates —
`generator.py:1660` `r"\\\1"` and `:1663` `r"\\u\1"` — both round-trip exactly.

**4.8 `IGNORECASE` — two divergences, both found only once flag variants existed.**
The harvested corpus carries `flags=0` everywhere (sqlglot passes flags at exactly one
site, `qualify_columns.py:1104`'s `re.IGNORECASE`), so until the fuzz target added
pattern × flag cases neither of these was reachable by the differential at all.

- **`re.ASCII | re.IGNORECASE` folds only the 52 ASCII letters.** JS's `i` flag under `u`
  applies full Unicode simple case folding, so `/[A-Za-z0-9_]/ui` matches U+017F LONG S
  where CPython does not. `spike/py/probe_ignorecase.py` measures the whole table: under
  `I|A` even `é`/`É` and `ж`/`Ж` stop matching. Fixed by not emitting JS's `i` flag in
  that mode at all and spelling both cases out per literal and per range.
- **CPython's Unicode `IGNORECASE` matches `i` against U+0130 and U+0131**, which JS
  simple case folding does not — those fold to themselves. All four of the letters
  CPython's docs name (U+0130, U+0131, U+017F, U+212A) are now emitted rather than only
  the two this engine misses: which of them the engine covers depends on its ICU version,
  and §3a already establishes that Unicode-version skew is a live hazard here.

**4.9 CPython version sensitivity.** Global inline flags not at the start of a
pattern (`a(?i)b`) are a `DeprecationWarning` on CPython ≤3.10 and a hard
`re.error` on 3.11+. The parser follows 3.9 (the pinned floor) and surfaces the
construct through `parsePattern().versionNotes` so a toolchain bump does not
change behaviour silently. Related: CPython applies such a flag to the *whole*
pattern, including text already scanned, and re-parses when VERBOSE is switched
on mid-pattern — reproduced, since a single forward pass mis-handles `a(?x)b c`.

---

## 5. Known gaps — not reachable from sqlglot, and measured

Both remaining failures and all 230 skips are on structural-sweep patterns.

| gap | cases | reachable from sqlglot? |
|---|---|---|
| `\N{NAME}` validity needs the Unicode character-name database | 2 fail, 94 skip | Only via a user regex literal in `REGEXP_EXTRACT`. BigQuery's own engine is RE2, which has no `\N{}`, so such SQL is already invalid upstream of sqlglot. |
| scoped inline flags `(?i:…)` — ES2025 modifier groups, absent in Node 22 | 94 skip | Same. Global `(?i)` (which the test corpus *does* contain) works. |
| conditional groups `(?(1)yes\|no)` | 47 skip | Same; no JS equivalent exists. |
| `must_advance` backtracking into a **nested** alternation (`(?:\|ab\|a)`) | 2 fail | No. The reachable form (`generator.py:1667` with `UESCAPE '\|'`) is top-level alternation, which is handled exactly. |

`\N{NAME}` is the only one that needs a human decision: making the oracle exact
means shipping a Unicode character-name table, which is weight a zero-dependency
runtime should not carry for a construct that is unreachable in practice. The
recommendation is to accept the gap and record it in `CONTRACTS.md`; the corpus
keeps it visible if that judgement ever needs revisiting.

---

## 6. Outstanding, for P0 exit

The target itself is built and GREEN. What remains is integration:

0. **Fold into `spike/run_all.sh`.** `spike/run_regex.sh` is deliberately shaped to drop
   in as two lines:
   ```
   python3 spike/py/gen_regex_cases.py --stdout > spike/out/regex_cases.jsonl
   run "FUZZ: regex (§3.4 target 2)"  node spike/fuzz_regex.mjs
   ```
   plus `run "SELFTEST: fuzz_regex ratchet" node spike/fuzz_regex.mjs --selftest`
   alongside the other `--selftest` entries.
1. Fold the corpus into the `make corpus` target and `corpus/PROVENANCE.json`,
   adding `unidata_version` / `process.versions.unicode` per §3a.
2. Re-run the harvest on every upstream resync — `harvest_patterns()` AST-walks
   for `re.*` calls, so a new pattern shows up as a new corpus row automatically,
   and a new *runtime-constructed* pattern shows up as a `re.compile` call whose
   first argument is not a constant and which the harvester therefore skips.
   That skip should become a loud warning at P0 exit, so a third dynamic site
   cannot be added upstream without someone noticing.
3. `CONTRACTS.md` (§8.2 item 1) should carry the `_py/re.js` surface:
   `pyReParse` / `pyReGroups` / `pyReIsValid` / `pyReEscape` / `pyReEscapeExact` /
   `pyReTemplate` / `compile` / `PyPattern` / `PyMatch`, plus the two frozen
   promises that the divergences above turn on — **match offsets are code
   points**, and **`pyReEscape` output is `/u`-valid, not byte-identical to
   CPython** (`pyReEscapeExact` is, and is not regex-safe).
