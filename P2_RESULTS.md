# P2 — Expressions: results

**Verdict: GREEN. All corrected P2 exit criteria met.**

Upstream: `sqlglot @ 91119bc`; CPython 3.9.25; Node v22.12.0.

## Verified exits

- Probe #2: **1,048 classes / 5,240 metadata checks**, including ordered `argTypes`, `requiredArgs`, traits and the 24 resolved init hooks.
- Probe #3: **563/563 `ALL_FUNCTIONS`; 629/629 `FUNCTION_BY_NAME`.**
- AST oracle: **15,540/15,540** `astDump(astLoad(ast))` deep round-trips and **15,540/15,540** byte-exact reprs, including PR #3's inferred-type `t` field (2,344 typed rows).
- Native upstream scope (PORT_PLAN Q6, §7 P2 exit criterion 2): all **six** parser/generator-independent tests are hand-ported and green; the other **65** are listed by name at the top of the test file. `test_parse_identifier` was briefly reclassified as parser-dependent; that was re-derived by measurement and reverted, so the code again matches PORT_PLAN §3.6/§7 as written. Upstream `parse_one("a ' b", into=Identifier)` **raises `TokenError`**, so `parse_identifier` can only ever return through its `except (ParseError, TokenError)` arm, whose value is `to_identifier(name)` — pure expression-layer code. Confirmed on CPython @ `91119bc`: stubbing `maybe_parse` to raise `ParseError` leaves the assertion true, and the unstubbed parser never produces a value for this input at all. 6 + 65 = 71 = the whole upstream file, verified with no overlap and no strays.
- `DateAdd` kwargs construction normalizes the abbreviation `q` to `Q`; `astLoad` deliberately bypasses the init hook and preserves `q`.
- Equality reproduces Python's empty-list/absent, `None`/`False`, list-falsy and conditional case-folding projections; raw Identifier/Literal args remain case-sensitive.

## Additional coverage

Native tests also cover traversal, mutation, transforms, datatype/cast behavior, query/DDL/DML builders, focused class constants, collection projections, comments/meta, parent/index maintenance and Pivot output columns: **40/40 tests green**.

The post-review pass additionally verifies distinct hashes for all enum-backed data types, faithful `TimeUnit`/`DateTrunc` hooks, public builder exports, `Order`/`Having` wrapper construction, left-associative conjunctions with connector parentheses, and the keyword-options call-site sweep.

## Differential probe suite (third pass)

The third review pass replaced symptom-driven patching with a paired PY/JS probe harness: the same probe name is evaluated on CPython (`repr()`) and on the port (`toS()`) and diffed byte-for-byte. Five sets, **463 probes**, covering the whole relevant upstream surface rather than the reported examples — every `_apply_*_builder`, every `_combine` wrap condition, all 28 `name`/`output_name` overrides, all 34 `builders.py` functions, and an adversarial set of inputs deliberately *adjacent* to each fix.

| set | surface | before | after |
|---|---|---|---|
| `h` | core helpers (`and_`/`or_`/`xor`/`_combine`, `to_identifier`, `column`, `alias_`, `Dot.build`) | 36/64 | **0** |
| `n` | `name`/`output_name`/`text`/`is_star`/`named_selects`, `DataType.build` | 21/82 | **0** |
| `q` | `query.py`/`ddl.py`/`dml.py` builder methods | 14/114 | **0** |
| `b` | all 34 `builders.py` functions | 20/80 | **2** |
| `x` | adversarial + string-input sweep | 43/123 | **6** |
| | **total** | **134/463** | **8/463** |

**Zero newly-introduced divergences** — the 8 remaining are a strict subset of the 134, verified by replaying every probe against `git archive 93bfb2c`. All 8 require the P3 parser: `parse_one` on a string input (`s.from`, `s.limit`, `s.lateral`, `s.returning`, `x.order.string`, `to_interval`), the tokenizer's `quoted` flag (`parse_identifier(5)`), and the tokenizer's `BLOB → VARBINARY` keyword remap (`x.cast.blob_chain`). None is an expression-layer defect.

## Full regression gates

- `bash spike/run_all.sh`: **GREEN — ALL PROBES GREEN**
- `bash spike/run_regex.sh`: **GREEN — 19,363 pass, 4 documented known gaps, 0 unexpected**
- control-byte lint: green
- deny-list lint: green
- generated expression artifacts reproduce byte-for-byte via `node tools/gen_expr_meta.mjs`

## P4 tracked debt

The 65 parser/generator-dependent tests from upstream `tests/test_expressions.py` are explicitly listed at the top of `test/expressions/upstream_parser_independent.test.mjs`, per PORT_PLAN Q6. They are not dropped.

Also tracked for P3, found by the differential probes above and invisible to every current gate (the AST oracle reaches these nodes only through `astLoad`): `DataType.build("BLOB")` yields `DType.BLOB`, where upstream's tokenizer maps the `BLOB` keyword to `TokenType.VARBINARY` and so yields `DType.VARBINARY`. `DataType.fromStr` is a direct enum lookup standing in for `parse_one(dtype, into=DataType)`; it will be replaced wholesale when the parser lands, which also fixes `ARRAY<INT>`/`DECIMAL(10,2)` and the rest of the non-scalar type grammar.
