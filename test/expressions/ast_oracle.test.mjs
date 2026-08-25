// Hand-written P2 oracle gate. CONTRACTS.md §4.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { astDump, astLoad, toS } from "../../src/expressions/index.js";

test("all AST oracle rows round-trip including inferred type and repr", () => {
  let count = 0;
  for (const file of readdirSync("corpus/ast").filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(`corpus/ast/${file}`, "utf8").split("\n")) {
      if (!line) continue;
      const row = JSON.parse(line);
      const expression = astLoad(row.ast);
      assert.deepStrictEqual(astDump(expression), row.ast, `${file}:${row.atom_id} AST`);
      assert.strictEqual(toS(expression), row.repr, `${file}:${row.atom_id} repr`);
      count++;
    }
  }
  assert.strictEqual(count, 15_540);
});
