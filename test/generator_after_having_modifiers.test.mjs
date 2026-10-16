// AIR-2310 (epic AIR-2271): regression guard for `Generator.AFTER_HAVING_MODIFIER_
// TRANSFORMS`'s TWO distinct upstream objects (`generator.js:159`'s own comment
// already names them): a module-level 2-entry dict (`windows`, `qualify`) and a
// class-level `Generator.AFTER_HAVING_MODIFIER_TRANSFORMS` ClassVar that spreads it
// and adds `cluster`/`distribute`/`sort` for the Hive-family CLUSTER/DISTRIBUTE/SORT
// BY clauses. Upstream's `dialects/{duckdb,presto,postgres,snowflake}.py` all read
// `generator.AFTER_HAVING_MODIFIER_TRANSFORMS` (the MODULE-level, narrower one) to
// drop those three clauses on dialects that do not support them; the port's four
// generators instead read `Generator.AFTER_HAVING_MODIFIER_TRANSFORMS` (the CLASS
// one), so a `CLUSTER BY`/`DISTRIBUTE BY`/`SORT BY`-bearing AST (only reachable by
// parsing it on a Hive-family dialect first, since none of these four dialects'
// OWN grammars produce that AST node) silently rendered the clause back out instead
// of being dropped. `generators/exasol.js` already got this right (R109) and ported
// the divergence note this file's expectations were verified against — every output
// below is CPython @ 91119bc's own, via `PYTHONHASHSEED=0 python3 -c
// "import sqlglot; print(sqlglot.parse_one(sql, read='hive').sql(dialect=d))"`.
import test from "node:test";
import assert from "node:assert/strict";
import { Dialect, parseOne } from "../index.js";

const DROPS = ["duckdb", "presto", "postgres", "snowflake"];
const KEEPS = ["hive", "spark"];

const CASES = [
  ["SELECT a FROM t CLUSTER BY a", "SELECT a FROM t CLUSTER BY a"],
  ["SELECT a FROM t DISTRIBUTE BY a", "SELECT a FROM t DISTRIBUTE BY a"],
  ["SELECT a FROM t SORT BY a", "SELECT a FROM t SORT BY a"],
];

for (const [sql, keptSql] of CASES) {
  test(`${JSON.stringify(sql)}: dropped on duckdb/presto/postgres/snowflake, kept on hive/spark`, () => {
    const ast = parseOne(sql, { read: "hive" });
    for (const dialect of DROPS) {
      assert.equal(Dialect.get_or_raise(dialect).generate(ast), "SELECT a FROM t");
    }
    for (const dialect of KEEPS) {
      assert.equal(Dialect.get_or_raise(dialect).generate(ast), keptSql);
    }
  });
}
