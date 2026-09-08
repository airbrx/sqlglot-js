# sqlglot-js docs

These docs describe the public API this project is building toward, written ahead of the
implementation — the same reason you write a test before the code it tests. A doc page is a
target, not a status report: it shows the finished shape of a function or a workflow with
real, working-looking examples, the same way `parseOne(sql).sql()` reads in upstream
sqlglot's own docs.

**How to read these pages.** Each one opens with a status line telling you what's real today
versus what's target design. Within a page, code that's marked "works today" runs against
this repo right now (it is checked, not aspirational); anything else is the contract the
implementation is being built to satisfy. When in doubt, `PORT_PLAN.md` is the single source
of truth for what's actually landed, phase by phase, with every claim backed by a measured
number.

- **[getting-started.md](getting-started.md)** — the walkthrough: parse a query, inspect it,
  build one programmatically, transpile between dialects.
- **[api.md](api.md)** — full reference for the top-level functions (`parse`, `parseOne`,
  `transpile`, `tokenize`) and the `exp` expression-builder namespace.

**Why write docs before the API exists.** A doc that has to describe a real function forces a
decision about that function's shape *before* someone is deep in a 1,500-line parser file and
picking a name under pressure. It also gives every future porting session (see `PORT_PLAN.md`
§8 on parallel dispatch) a stable contract to build against, independent of which phase lands
it. If a doc example turns out to be awkward to implement faithfully against upstream's own
behavior, that's a signal to revisit the doc, not to quietly diverge from it in code.
