# sqlglot-js docs

These docs describe the public API — `parse`, `parseOne`, `transpile`, `tokenize`, the `exp`
namespace, `Dialect`, `Schema`/`MappingSchema`, `optimize`, `lineage`, `anonymize`/`render`,
`diff`, and the error classes are all real today, importable from the package root
(`import { parseOne } from "sqlglot-js"`, or `./index.js` from a repo checkout). All 33 of
upstream's dialect modules at the pin have a real `Dialect` class — each page says plainly
what's measured and links to `api.md`'s **Known gaps** section for what's still open within
that surface (a named population of generate mismatches/stubs, not missing functions).

**How to read these pages.** Each one opens with a status line. Code marked "works today"
runs against this repo right now (checked, not aspirational) — every sample on every page was
re-run against this tree as part of each docs round, not assumed. When in doubt, `PORT_PLAN.md`
is the single source of truth for what's actually landed, phase by phase, with every claim
backed by a measured number.

- **[getting-started.md](getting-started.md)** — the walkthrough: parse a query, inspect it,
  build one programmatically, transpile between dialects.
- **[api.md](api.md)** — full reference for every top-level export (`parse`, `parseOne`,
  `transpile`, `tokenize`, `exp`, `Schema`, `optimize`, `lineage`, `anonymize`, `diff`, the
  error classes), per-dialect notes, and the Known gaps section.
- **[consuming-from-cjs.md](consuming-from-cjs.md)** — how a CommonJS project (this package
  is ESM-only) consumes it via dynamic `import()`.
- **[verification/](verification/)** — the gate history: ratchets, honest oracles, and the
  optimizer fixture-pair rollup (R95/AIR-1864).
- **[proposals/](proposals/)** — design proposals awaiting a decision (not implemented),
  currently the gateway tier-2 semantic-normalization proposal.

**Why write docs before the API exists.** A doc that has to describe a real function forces a
decision about that function's shape *before* someone is deep in a 1,500-line parser file and
picking a name under pressure. It also gives every future porting session (see `PORT_PLAN.md`
§8 on parallel dispatch) a stable contract to build against, independent of which phase lands
it. If a doc example turns out to be awkward to implement faithfully against upstream's own
behavior, that's a signal to revisit the doc, not to quietly diverge from it in code. Now that
every dialect module exists, this habit continues as "measure, don't recall" — every number on
these pages names the command that produced it.
