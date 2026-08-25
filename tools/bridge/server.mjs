// Bridge server — CONTRACTS.md §5. PORT_PLAN.md §3.8.
//
// Reads one JSON request per line on stdin, writes one JSON response per line on stdout.
// Runs upstream's IMPERATIVE core tests against the JS library, for the ~1,419
// assertEquals that drive the Python API directly and have no declarative form.
//
//   node tools/bridge/server.mjs
//
// Deliberately kept dumb: it resolves a dotted target to an exported function and calls
// it. Anything that needs an object graph is where the proxy's ceiling lies, which is
// exactly what the two P0 proofs are meant to measure (§3.8) rather than assume.

import { createInterface } from "node:readline";

const MODULES = {
  errors: () => import("../../src/errors.js"),
  helper: () => import("../../src/helper.js"),
  time: () => import("../../src/time.js"),
  trie: () => import("../../src/trie.js"),
};

const loaded = new Map();
async function resolve(target) {
  const [modName, ...rest] = target.split(".");
  const loader = MODULES[modName];
  if (!loader) throw new Error(`unknown module '${modName}'`);
  if (!loaded.has(modName)) loaded.set(modName, await loader());
  let obj = loaded.get(modName);
  for (const part of rest) {
    if (obj == null) throw new Error(`cannot resolve '${target}'`);
    obj = obj[part];
  }
  if (obj === undefined) throw new Error(`'${target}' is not exported`);
  return obj;
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  if (!line.trim()) continue;
  let req;
  try {
    req = JSON.parse(line);
  } catch (e) {
    process.stdout.write(
      JSON.stringify({ id: null, ok: false, error: { type: "ProtocolError", message: String(e) } }) +
        "\n",
    );
    continue;
  }

  let res;
  try {
    if (req.op === "ping") {
      res = { id: req.id, ok: true, result: "pong" };
    } else if (req.op === "call") {
      const fn = await resolve(req.target);
      if (typeof fn !== "function") throw new Error(`'${req.target}' is not callable`);
      const out = fn(...(req.args ?? []));
      res = { id: req.id, ok: true, result: out };
    } else if (req.op === "get") {
      res = { id: req.id, ok: true, result: await resolve(req.target) };
    } else {
      throw new Error(`unknown op '${req.op}'`);
    }
  } catch (e) {
    res = {
      id: req.id,
      ok: false,
      error: {
        // Strip the Py prefix so the Python side compares against CPython's own names.
        type: (e?.name ?? "Error").replace(/^Py/, ""),
        message: e?.message ?? String(e),
        errors: e?.errors ?? undefined,
      },
    };
  }
  process.stdout.write(JSON.stringify(res) + "\n");
}
