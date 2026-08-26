# P2 — Expressions: results

**Verdict: GREEN. All corrected P2 exit criteria met.**

Upstream: `sqlglot @ 91119bc`; CPython 3.9.25; Node v22.12.0.

## Verified exits

- Probe #2: **1,048 classes / 5,240 metadata checks**, including ordered `argTypes`, `requiredArgs`, traits and the 24 resolved init hooks.
- Probe #3: **563/563 `ALL_FUNCTIONS`; 629/629 `FUNCTION_BY_NAME`.**
- AST oracle: **15,540/15,540** `astDump(astLoad(ast))` deep round-trips and **15,540/15,540** byte-exact reprs, including PR #3's inferred-type `t` field (2,344 typed rows).
- Corrected native upstream scope (PORT_PLAN Q6): all five parser/generator-independent tests are hand-ported and green. `test_parse_identifier` needs the tokenizer and is included in the explicit list of all 66 P4-deferred names.
- `DateAdd` kwargs construction normalizes the abbreviation `q` to `Q`; `astLoad` deliberately bypasses the init hook and preserves `q`.
- Equality reproduces Python's empty-list/absent, `None`/`False`, list-falsy and conditional case-folding projections; raw Identifier/Literal args remain case-sensitive.

## Additional coverage

Native tests also cover traversal, mutation, transforms, datatype/cast behavior, query/DDL/DML builders, focused class constants, collection projections, comments/meta, parent/index maintenance and Pivot output columns: **23/23 tests green**.

The post-review pass additionally verifies distinct hashes for all enum-backed data types, faithful `TimeUnit`/`DateTrunc` hooks, public builder exports, `Order`/`Having` wrapper construction, left-associative conjunctions with connector parentheses, and the keyword-options call-site sweep.

## Full regression gates

- `bash spike/run_all.sh`: **GREEN — ALL PROBES GREEN**
- `bash spike/run_regex.sh`: **GREEN — 19,363 pass, 4 documented known gaps, 0 unexpected**
- control-byte lint: green
- deny-list lint: green
- generated expression artifacts reproduce byte-for-byte via `node tools/gen_expr_meta.mjs`

## P4 tracked debt

The 66 parser/generator-dependent tests from upstream `tests/test_expressions.py` are explicitly listed at the top of `test/expressions/upstream_parser_independent.test.mjs`, per PORT_PLAN Q6. They are not dropped.
