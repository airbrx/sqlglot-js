# P3 (blocking step) — Parser base: results

**Verdict: GREEN for the blocking step's scope.** The 364 `_parse_*` bodies are the next
round; this is the infrastructure they land on.

Upstream: `sqlglot @ 91119bc`; CPython 3.9.25; Node v22.12.0.

## What was built

| piece | where | verified by |
|---|---|---|
| `SENTINEL_NONE`, cursor primitives, semicolon chunking, `_try_parse` | `src/parser.js` | `fuzz_ast_coverage`, `fuzz_command_warning` |
| `ErrorLevel`, `ParseError.new`, `raise_error`, `check_errors`, `validate_expression`, `expression()` | `src/errors.js`, `src/parser.js` | `fuzz_raise_error` — 1,005/1,005 |
| optimizer **Tier A** (`walk_in_scope`, `find_all_in_scope`, `find_in_scope`, `_is_derived_table`) | `src/optimizer/scope.js` | `fuzz_walk_in_scope` — 15,540/15,540 trees, 62,160/62,160 finds |
| minimal generator kernel (13 classes) | `src/generator_kernel.js` | `fuzz_generator_kernel` — 73,107/73,127; `fuzz_parse_path_sql` — 20/20 |
| `logging` shim (the log line is an asserted output, not diagnostics) | `src/logging.js` | `fuzz_command_warning` — 131/131 |
| 405 method stubs + 128 class tables | `src/parser.js` (seeded) | `check_parser_tables` — 2,985 entries, 0 wrong |

## Exit criteria

| §7 P3 criterion | result |
|---|---|
| AST oracle exact match incl. `meta`, on what the subset parses | **38 EXACT / 0 MISMATCH / 0 ERROR**, 15,440 still `NotPorted`. Snowflake **3/3 of reached rows**. |
| The 18 `check_command_warning` log strings byte-exact via `error_message_context` | **131/131** across all dialects; the Snowflake gate is **18/18** |
| `ParseError.errors` structure | **1,005/1,005** — all seven keys, in order, values byte-exact |
| `fuzz_unicode` green over error-message column positions | **180/180** astral rows; mutation-tested (UTF-16 slice → 39/180) |

**Honest scope.** 38 of 15,478 oracle rows (0.25%) parse end-to-end today; every one is
byte-identical including `meta`. The rest stop at a single stub — `_parse_expression` —
which is the head of the precedence chain and therefore the stub queue's first task. The
criterion is "100% of what the implemented subset parses", and that is met with zero
mismatches; it is *not* "100% of Snowflake", which no blocking step could reach.

## Findings

**1. The plan named 2 mid-parse generator call sites; there are 7.** Instrumenting
`Expression.sql` over all 9,867 distinct corpus inputs found five more, because they are
implicit `f"{expr}"` coercions through `Expression.__str__` rather than literal `.sql()`
calls: `parser.py:3044`, `:3046`, `:3179`, `:9313`, `:9462`. `grep '\.sql('` shows only
`:5491` and `:8069`. The P0 implicit-`__str__` deny-list has **zero** `parser.py`
entries — its heuristics cannot see that `_parse_number()` returns an Expr.

**2. `parser.py:5491` can hand the generator a whole `SELECT`.** A pivot
`IN (SELECT DISTINCT q FROM z ORDER BY q NULLS LAST)` is generated mid-parse, so the
kernel had to be a real recursive generator, not a special-case renderer. Measured
scope: exactly 13 node classes, everything else throws `NotPorted`.

**3. P2 debt closed: `Func.from_arg_list` and the var-len metadata.** `focused_methods.js`
carried a hand-written list of var-len-args classes that had drifted to **46 of
upstream's 55** (missing `Anonymous`, `AnonymousAggFunc`, `CombinedAggFunc`, `ConcatWs`,
`HashAgg`, `Hll`, `Posexplode`, `PosexplodeOuter`, `_ExplodeOuter`). Those nine would
have been silently mis-shaped by `from_arg_list`, which `Parser.FUNCTIONS` binds for
hundreds of names. Both markers are now extracted and generated. Verified 2,832/2,832.

**4. `Cast.to` / `Expr.type` fidelity.** Upstream's `type` reads the `to` *property*
(`self.args["to"]`, a subscript), so a Cast missing its required `to` raises `KeyError`;
the port returned `undefined` and produced a repr Python cannot produce. Also,
`JSONCast`/`TryCast` inherit `Cast`'s members upstream but not in the port, so
`JSONCast.to` was undefined. A `/Cast$/` name regex stood in for `is_cast`; it matched
the right three by coincidence and is now explicit.

**5. Four committed AST-oracle rows are not reproducible by re-parsing at the pin.**
`86c3a2d070c3d663`, `a98e659da1d9c243`, `f18c0b39b6040bf0`, `ff0cd27e2cbf3239` — all
`UNION ... ORDER BY ... LIMIT` under the default dialect, where the corpus records
`limit` before `order` but `parse_one` produces `order` before `limit`. **No existing
gate can see this**: P2's AST gate only round-trips the corpus value
(`astDump(astLoad(ast)) == ast`) and never re-derives from SQL. Found because two P3
probes keyed nodes by walk position and misaligned on exactly these rows. Both probes
now emit the tree they walked, so they no longer depend on the assumption. **This is
unresolved and matters for P3+**, because the parser is supposed to *produce* these
ASTs — flagged for a human decision.

## Tooling changes

- **`tools/seed_static.py`** — resolves the mechanical symbolic forms it previously
  dropped as TODO comments (`TokenType.X`, `exp.Y`, sibling-table references, set
  algebra, `frozenset(...)`/`tuple()` wrappers, `dict.fromkeys`, keyset and trie views).
  Table entries seeded went from 0 to **637 of 1,022**; the remaining 385 are callables,
  still never guessed at. This matters for Rule 2′: you cannot CI-assert the ORDER of a
  table whose entries are all comments.
  - Bug found by the new checker: Python's `{*some_dict}` spreads a mapping's **keys**,
    JS's `[...someMap]` spreads `[k,v]` **pairs**. `ID_VAR_TOKENS` splats two dicts, so
    the literal transliteration produced a set of 2-element arrays that no
    `.has(TokenType.X)` would match — and `len()` still looked plausible.
- **`tools/parity/check_parser_tables.mjs`** (new) — asserts every class table's entries
  and, for dicts, their ORDER. Probe 6 compares `len()` only and cannot distinguish two
  same-sized tables. Found 252 seeding defects, now 0.
- **Probe 6** is now `PARTIAL` rather than `FAIL` when a table is short of upstream
  (the stub queue in progress); a table *longer* than upstream, or absent, still fails.
- **`tools/lint_deny.mjs`** — understands partially-ported files. At file granularity,
  every deny site in `parser.py` became a failure the moment the seeded skeleton landed.
  A site now counts as ported only if its enclosing method is not a `NotPorted` stub
  (derived from the port's own anchors), or if the file declares `@ported-ranges`.
  Negative-tested: widening the declared range re-fails.
- **`spike/run_all.sh`** — names the probes that failed. Previously the only signal was
  `SOME PROBES RED` at the bottom.

## Regression

- `bash spike/run_all.sh` — **ALL PROBES GREEN** (exit 0)
- `bash spike/run_regex.sh` — GREEN
- `node --test test/expressions/` — 40/40
- control-byte, unicode, license, deny lints — clean
- `node tools/gen_expr_meta.mjs` idempotent

## For the stub queue

`grep -c 'throw new NotPorted' src/parser.js` = **379** of 405 seeded methods; **27**
are implemented (the core infrastructure plus the statement/Command path). The first
task is `_parse_expression` (`parser.py:5996`): it alone blocks 15,440 of 15,478 oracle
rows.

`node spike/p3/fuzz_ast_coverage.mjs --verbose` prints the live burndown, and
`node tools/parity/check_parser_tables.mjs --todo` prints the per-table entry burndown.
