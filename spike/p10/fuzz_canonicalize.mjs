// Differential: `src/optimizer/canonicalize.js` vs CPython's `sqlglot.optimizer.canonicalize`,
// at the pin.
//
//   PYTHONHASHSEED=0 python3 spike/p10/gen_canonicalize_ref.py > spike/out/canonicalize.json
//   node spike/p10/fuzz_canonicalize.mjs
//
// See `gen_canonicalize_ref.py`'s own header for the full rationale. Summary: both
// sides now run upstream's REAL `optimizer.optimize(sql, rules=[qualify,
// quote_identifiers, annotate_types, canonicalize], ...)` wrapper, not a reduced
// substitute -- `qualify()` (`src/optimizer/qualify.js`, AIR-2108/R75) and
// `quote_identifiers` (`src/optimizer/qualify_columns.js`, AIR-2107/R73) both landed
// for real on `main` after this round started, closing the two gaps an earlier version
// of this file had to work around. The CPython side's `output` is asserted against the
// real fixture file's own quoted "expected" text (see that file's `scenario()`), so a
// match here is a match against upstream's actual documented behavior, not just
// internal self-consistency.
//
// `# dialect: mysql` fixture rows are SKIPPED (not ERROR): `src/dialects/mysql.js` does
// not exist in this port yet, so `parseOne(sql, { read: "mysql" })` already throws
// independently of `canonicalize.js` itself.
//
// Every row always carries BOTH the real rendered SQL and a structural DFS-preorder
// class-name fingerprint (CPython's generator always succeeds, so computing both costs
// nothing there). On the JS side, `.sql()` is tried first; a `NotPorted` error falls
// back to comparing the fingerprint instead, counted separately as a GENERATOR_GAP hit
// rather than silently folded into EXACT. AIR-2194 (PORT_PLAN.md) ported base
// `Generator.concat_sql`/`convert_concat_args` and `Generator.dateadd_sql` — the two
// gaps this battery used to name here — so this probe's own GENERATOR_GAP count is 0
// now; the regex is kept (empty) as the established slot for the next one, rather than
// dropped, so a future real gap has an obvious place to land. Any OTHER `.sql()` error
// is a real ERROR, not a gap.

import { readFileSync } from "node:fs";
import { parseOne } from "../../src/dialects/dialect.js";
// Side-effect imports: register dialects this battery's fixtures ask for by name, and
// the real base-Generator dispatch (`.sql()` needs it).
import "../../src/dialects/tsql.js";
import "../../src/generator.js";
import { qualify } from "../../src/optimizer/qualify.js";
import { annotate_types } from "../../src/optimizer/annotate_types.js";
import { canonicalize } from "../../src/optimizer/canonicalize.js";

const VERBOSE = process.argv.includes("--verbose");
const ref = JSON.parse(readFileSync("spike/out/canonicalize.json", "utf8"));

// Mirrors `gen_canonicalize_ref.py`'s own `SCHEMA`.
const SCHEMA = {
  x: { a: "INT", b: "INT" },
  w: { d: "TEXT", e: "TEXT" },
  temporal: { d: "DATE", t: "DATETIME" },
};

// Mirrors `gen_canonicalize_ref.py`'s own `fingerprint` exactly -- see its comment for
// why scalar-only args (not full `Expr`/array-of-`Expr` children) are included.
function fingerprint(ast) {
  return [...ast.dfs()].map((n) => {
    const scalars = {};
    for (const [k, v] of Object.entries(n.args)) {
      if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        scalars[k] = v === undefined ? null : v;
      }
    }
    const sorted = {};
    for (const k of Object.keys(scalars).sort()) sorted[k] = scalars[k];
    return [n.constructor.name, sorted];
  });
}

// Mirrors `gen_canonicalize_ref.py`'s own `optimize = partial(optimizer.optimize,
// rules=[qualify, quote_identifiers, annotate_types, canonicalize])`: `qualify()`'s own
// default `quoteIdentifiers: true` already performs the separate `quote_identifiers`
// rule's job (see that file's header for why upstream's own `optimize()` suppressing
// qualify()'s INTERNAL quoting and running it as a separate rule afterward is
// behaviorally identical to just leaving qualify()'s own default on).
function runPipeline(sql, dialect, bare, schema) {
  if (bare) return canonicalize(parseOne(sql, { read: dialect ?? undefined }), { dialect });

  let ast = parseOne(sql, { read: dialect ?? undefined });
  ast = qualify(ast, { schema, dialect, isolateTables: true });
  ast = annotate_types(ast, { schema, dialect });
  ast = canonicalize(ast, { dialect });
  return ast;
}

// Base-Generator gaps this battery's own first run surfaced (pre-existing, unrelated to
// `canonicalize.js`, recorded in PORT_PLAN.md rather than fixed here) -- a `.sql()`
// `NotPorted` for any OTHER method is a real ERROR, not a gap. Same "named, counted
// exclusion, classified by the underlying stub name rather than by row id" shape
// `fuzz_qualify.mjs`'s own `KNOWN_GAPS` regex list already established, reused here
// rather than a bespoke mechanism.
const KNOWN_GENERATOR_GAPS = [];

function isKnownGeneratorGap(e) {
  return KNOWN_GENERATOR_GAPS.some((re) => re.test(`${e.constructor.name}: ${e.message}`));
}

let exact = 0;
let generatorGap = 0;
let mismatch = 0;
let error = 0;
let skipped = 0;
const samples = [];

for (const row of ref) {
  const name = `${row.name}${row.dialect ? ` (${row.dialect})` : ""}`;

  if (row.dialect === "mysql") {
    skipped++;
    continue;
  }

  // `gen_canonicalize_ref.py`'s own "tsql-concat" scenario deliberately passes
  // `schema=None` (matching upstream's real, schema-less `optimize(...)` call there) --
  // every other row uses the shared `SCHEMA`.
  const schema = row.name === "tsql-concat" ? null : SCHEMA;

  let got;
  try {
    const ast = runPipeline(row.sql, row.dialect, row.bare, schema);
    let output;
    let gap = false;
    try {
      output = ast.sql(row.dialect);
    } catch (e) {
      if (isKnownGeneratorGap(e)) {
        gap = true;
      } else {
        throw e;
      }
    }
    got = gap ? { gap: true, fingerprint: fingerprint(ast) } : { output };
  } catch (e) {
    got = { error: e.constructor.name, message: e.message };
  }

  if ("error" in got) {
    error++;
    samples.push(`ERROR   ${name}: ${got.error}: ${got.message}\n  sql: ${row.sql}`);
    continue;
  }

  if (got.gap) {
    const want = JSON.stringify(row.fingerprint);
    const have = JSON.stringify(got.fingerprint);
    if (want === have) generatorGap++;
    else {
      mismatch++;
      samples.push(`MISMATCH ${name}\n  sql:      ${row.sql}\n  expected fp: ${want}\n  got fp:      ${have}`);
    }
  } else if (got.output === row.output) {
    exact++;
  } else {
    mismatch++;
    samples.push(`MISMATCH ${name}\n  sql:      ${row.sql}\n  expected: ${row.output}\n  got:      ${got.output}`);
  }
}

console.log();
console.log("  src/optimizer/canonicalize.js vs CPython sqlglot.optimizer.canonicalize");
console.log(`    EXACT ${exact}    GENERATOR_GAP ${generatorGap}    MISMATCH ${mismatch}    ERROR ${error}    SKIPPED ${skipped} (mysql, unported)`);
if (samples.length) {
  console.log();
  for (const s of samples) console.log(VERBOSE ? `  ${s}\n` : `  ${s.split("\n")[0]}`);
}

process.exit(mismatch === 0 && error === 0 ? 0 : 1);
