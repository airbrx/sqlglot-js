# P0 deny-lists — findings

**Scope:** PORT_PLAN.md §4.6 ("Deny-lists, all machine-generated, all CI-linted") and §7 P0 item 8.
**Upstream:** sqlglot @ `91119bc`, read-only clone at `/tmp/sqlglot-ref-regex`.
**Toolchain:** CPython 3.9.25 · Node v22.12.0.
**Scope of analysis:** `sqlglot/` only, never `tests/`. `sqlglot/executor/` is counted separately (permanently out of scope, §1).

Regenerate all three:

```
python3 tools/deny/gen_operators.py    --ref /tmp/sqlglot-ref-regex --out corpus/deny/operators.json
python3 tools/deny/gen_implicit_str.py --ref /tmp/sqlglot-ref-regex --out corpus/deny/implicit_str.json
python3 tools/deny/gen_py_builtins.py  --ref /tmp/sqlglot-ref-regex --out corpus/deny/py_builtins.json
node tools/lint_deny.mjs
```

---

## 1. Counts, against the plan's earlier estimates

| list | plan's estimate | measured (in scope) | verdict |
|---|---|---|---|
| `operators.json` | **68** | **115** | plan **under** by 1.7× |
| `implicit_str.json` | **26** | **58** rendering SQL (+2 `__repr__`) | plan **under** by 2.2× |
| `py_builtins.json` | no number; 3 examples cited | **17** | all 3 present; **14 more** |

The plan's own framing was that `py_builtins.json` exists because "the `_py/` API surface
was previously derived from recon briefs rather than from an exhaustive census, which is
how the three sites above were missed." That reasoning holds for the other two lists as
well: both were under-counted, and by similar factors.

`operators.json` breakdown — 33 high / 58 medium / 24 low confidence, across 20 files:

| dunder | sites | | dunder | sites |
|---|---|---|---|---|
| `__add__` | 38 | | `__lt__` | 7 |
| `__sub__` | 21 | | `__ge__` | 4 |
| `__getitem__` | 16 | | `__mod__` | 3 |
| `__mul__` | 14 | | `__floordiv__` | 2 |
| `__truediv__` | 7 | | `__neg__` / `__le__` / `__gt__` | 1 each |

`implicit_str.json` — 55 f-strings, 2 `str()`, 1 lazy `logger.warning`, across 23 files.

`py_builtins.json` — 17 sites in 10 files: 9 str-methods, 3 `chr()`, 3 format specs,
2 tuple-arg `startswith`. **`ord()` has zero call sites**, which is worth recording so
the shim is not written speculatively.

---

## 2. The plan's cited examples: two of three line numbers are stale

| plan says | actually at `91119bc` | status |
|---|---|---|
| `dialect.py:1778` — `exp.Length(...) - exp.paren(expression.expression - 1)` | **`dialect.py:1782`** | found, 4 lines off |
| `clickhouse.py:63` — `len(sep_value.encode("utf-8")) == 1` | `parsers/clickhouse.py:63` | exact |
| `singlestore.py:25` — `chr(int(m.group(1), 16))` | `generators/singlestore.py:25` | exact |
| `dremio.py:65` — `f"{int(year.this):04d}-..."` | `parsers/dremio.py:65` | exact |

The `dialect.py` drift is the useful one: it is the example the plan uses to argue the
whole mechanism, and it had already moved. That is the case for generating these lists
rather than maintaining them by hand, and for regenerating on every resync.

---

## 3. Method

Real AST analysis, not grep. The hard part is not finding operators — it is deciding
whether an operand is an `Expr` in a dynamically typed codebase. `tools/deny/common.py`
answers that from evidence in the source itself:

* every class under `sqlglot/expressions/` that transitively subclasses `Expr` (1,052 of them);
* every function/method/property whose **return annotation** is one of those, harvested,
  never hardcoded;
* parameter and variable annotations, propagated through local assignments.

Every verdict carries the reason it was reached, and the manifests emit that reason, so
the lists are auditable rather than oracular. `tools/deny/audit.py` prints them grouped.

### Four bugs the first runs had, each found by auditing rather than by assuming

The first operators run reported **440** sites. That number was wrong four different ways,
and the corrections are the substance of this work:

1. **Ten expression classes collide with `typing` names** — `Any`, `ByteString`, `Final`,
   `Generator`, `List`, `Literal`, `Match`, `Set`, `Tuple`, `Union`. A substring match on
   annotation text reads `t.Any` as `exp.Any`, so `MutableSequence[t.Any]` made every
   `args[i]` in the codebase look like `Expr.__getitem__`. Annotations are now parsed and
   resolved against each module's real imports. *(440 → 123)*

2. **A container of Exprs is not an Expr.** `t.List[Expr]` made `values[0]` look like a
   Bracket construction; it is ordinary list indexing that *yields* an Expr. The classifier
   is now three-valued: `expr` / `container` / other.

3. **`from sqlglot import exp` was unhandled** — the dominant idiom, used by **114 of
   sqlglot's 182 modules**. Only `from sqlglot import expressions as exp` was recognised,
   so `exp.Foo(...)` failed to resolve almost everywhere. Found by checking whether the
   plan's own cited example was in the output. It was not. *(56 → 101)*

4. **Flow-insensitivity.** sqlglot's generator methods rebind constantly:

   ```python
   start = expression.args.get("start")              # an Expr
   start = f"START WITH {start}" if start else ""    # __str__ fires HERE
   ...
   sequence_opts = f"{start}{increment}{minvalue}"   # now a plain str
   ```

   First-assignment-wins inference reports both f-strings; only the first is real. Each
   name now carries its assignment history keyed by line, and a lookup at line L uses the
   most recent binding at or before L. *(implicit_str 158 → 58, operators 123 → 115)*

Also corrected: `.this`/`.expression`/`.left`/`.right` are declared `-> t.Any` upstream
(`expressions/core.py:130,137,144`) because the concrete type comes from each class's
`arg_types`, so return-annotation harvesting can never learn them — they are reinstated as
a named set at medium confidence, with that reason recorded per site. And a slice
subscript is never `Expr.__getitem__`, because that method does
`convert(e) for e in ensure_list(other)` (`core.py:1409`) and cannot accept a slice.

### False-negative check

`tools/deny/recall_check.py` runs a deliberately over-broad pass (flag every
arithmetic/comparison BinOp whose source mentions an Expr-ish token) and prints what the
strict classifier rejected, so "did I miss anything?" is a review rather than an assertion.
PEP 604 spells unions with `|`, so `exp.Expr | None` parses as a `BinOp`; excluding
annotation subtrees took the delta from 1,041 to 78 — small enough to read.

Reviewing those 78 found one real miss class: `<expr>.args.get(k)` reads an argument
exactly like `<expr>.args[k]`, so `generators/singlestore.py:245,247`
(`e.args.get("start") - 1` and `e.args.get("start") + e.args.get("length")`) were being
dropped. The default argument discriminates — `.args.get("offset", 0)` is used as a number
(`generator.py:3593` and `dialect.py:1241` both feed `apply_index_offset`), a bare
`.args.get("start")` yields an Expr. *(101 → 115)*. The remaining 74 candidates were
reviewed by hand and are set, list and string operations.

### What is NOT verified: the runtime cross-check did not run

`tools/deny/instrument_operators.py` is written and committed. It monkeypatches all 26
node-building dunders on `exp.Expression`, runs upstream's own unittest suite (all 62 test
modules are pure `unittest`; there is no pytest dependency), and records the caller's
`file:line` on every hit. That would have turned the static verdicts into ground truth —
a recorded site is *certain*.

**It is blocked by this environment's permission gate and has never been executed.** The
`recall_check.py` review above is the substitute, and it is a weaker one: it establishes
that the strict pass is not obviously missing anything a broad pass would catch, not that
every listed site really fires. Running the instrumentation is the first thing to do when
these lists move to `tools/`, and the confidence labels (`high` / `medium` / `low`) should
be replaced by `confirmed` for every site it records. `gen_operators.py --runtime` already
accepts its output and merges it.

---

## 4. What the sites actually are

**operators.json** — the pattern the plan predicted, concentrated where date/array
arithmetic gets rewritten. `generators/duckdb.py` alone has 31 sites, e.g.:

```python
days_offset = exp.paren(target_dow - isodow_call + 6, copy=False) % 7 + 1     # duckdb.py:1112
slice_end_pos = arr_len + exp.Literal.number(pos_value)                       # duckdb.py:429
```

Every operator there builds a node. A JS transliteration that keeps `%` and `+` computes
numbers, and `optimizer/simplify.py`'s 8 sites (`left >= date_literal(...)`) would compute
booleans where Python built comparison nodes.

**implicit_str.json** — mostly `f"{expr}"` in generator methods and error messages:

```python
start = expression.args.get("start")
start = f"START WITH {start}" if start else ""              # generator.py:1239
self.unsupported(f"{hash_function.this} hash method is not supported...")  # singlestore.py:1565
```

Two things make this list matter more than the raw count suggests. First, in JS there is
no `__str__` at all, so a transliterated `${expr}` yields `[object Object]` — a visibly
broken output rather than a subtly wrong one. Second, several sites are inside
`unsupported()` messages, and §3.1(D) makes `unsupported_messages` a **hard P4 assertion**
against the generate oracle — so these are corpus-visible, not just theoretically wrong.

**py_builtins.json** — beyond the plan's three:

* **`time.py:77`** — `str(parsed.microsecond).zfill(6)` inside `subsecond_precision`, the
  function PORT_PLAN.md calls "the most serious finding in either review" (B1/R6). The
  argument is non-negative so `zfill`'s sign-awareness does not bite, but the site is on
  the P0 critical path and belongs in the list.
* **`tokenizer_core.py:9`** — `chr(i)` twice, on the P1 tokenizer path.
* **`dialects/dialect.py:1179`** — `path_text.lstrip().startswith(("lax", "strict"))`,
  tuple-arg form, in JSON-path parsing.
* `expressions/core.py:2623` `.splitlines()`; `generators/clickhouse.py:106` `.ljust(6,"0")`;
  `serde.py:115` `.rsplit(".", maxsplit=1)`; five sites in `anonymize.py` (P10 scope).

---

## 5. Sketch: what `lint_fidelity.mjs` has to assert

`tools/lint_deny.mjs` is a runnable sketch, not wired into CI (there is no ported JS yet,
so it currently reports the manifests' shape and the shims each future file will need).

The design problem is that **two of the three lists cannot be checked by pattern-matching
the JS**. `a - b` is not wrong in general; it is wrong only when `a` is an Expr — the same
type question the generator needed a whole inference pass to answer, which would have to be
answered again against JS that has no annotations. Same for `${x}`.

So the three lists need three different mechanisms:

1. **`py_builtins.json` → a real banned-construct scan.** The hazard *is* a specific JS
   spelling, so this one is self-contained and strong. `lint_deny.mjs` bans
   `String.fromCharCode`, `.charCodeAt(`, `.padStart(`, `.padEnd(`, `.toFixed(` outside
   `src/_py/`, and additionally asserts that each deny-listed site's ported file imports
   the named shim (`utf8Len`, `pyChr`, `pyZfill`, `pyPartition`, …). This matches the
   plan's existing instruction to "deny-list `String.fromCharCode` outright".

2. **`operators.json` and `implicit_str.json` → acknowledgement markers.** The port carries
   a comment at each deny-listed line:

   ```js
   // deny:operators sqlglot/generators/duckdb.py:1112
   const daysOffset = exp.add(exp.mod(exp.paren(...), lit(7)), lit(1));
   ```

   CI asserts both directions: every in-scope entry is acknowledged somewhere in `src/`,
   and every marker still corresponds to a live entry. The second half is what makes it
   survive upstream drift — when a line moves (as `dialect.py:1778`→`1782` already did),
   its marker goes stale and CI fails, which is the same discipline as §3.3 rule 5.

   **This should be described honestly as weaker than a real check.** A marker proves
   someone looked at the line, not that the result is correct. The strong guarantee for
   these two lists remains §8.5's human review gate; the marker just makes "was this line
   even considered?" machine-checkable, and stops a deny-listed line from being ported
   silently.

3. **Regeneration gate.** Same shape as the `_gen/` check in §8.1 rule 4:
   `make deny && git diff --exit-code corpus/deny` on every PR, so a manifest cannot drift
   from the pinned source. On resync this is what surfaces new sites as work items.

### One open question for a human

The confidence labels are load-bearing if CI ever fails on `medium`/`low` entries. 24 of
the 115 operator sites and 13 of the 58 implicit-str sites are `low`, mostly because
`.this` can hold a plain `str` for some node classes (`Identifier.this`, `Literal.this`)
and the static pass cannot tell which class it has. Two options:

* require markers only for `high` + `medium`, and treat `low` as advisory; or
* run the instrumentation first and require markers for every `confirmed` site, which is
  strictly better and is the reason to unblock `instrument_operators.py`.

Recommend the second. Until then, the first is the safe default — otherwise the lint's
first action on a real PR is to demand markers on entries that may not be hazards.
