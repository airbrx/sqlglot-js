// Differential runner for the P0 item-5 builtins shims.
//   python3 spike/py/gen_builtins_cases.py > spike/out/builtins.jsonl
//   node spike/fuzz_builtins.mjs

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { utf8Len, pyChr, pyOrd, pyFormatInt, pyRepr, pyReprStr } from "../src/_py/str.js";
import { ExprSet, ExprMap, frozensetKey } from "../src/_py/collections.js";

const SHOW = 6;
const stats = new Map();

function record(bucket, ok, detail) {
  let s = stats.get(bucket);
  if (!s) {
    s = { n: 0, bad: 0, samples: [] };
    stats.set(bucket, s);
  }
  s.n++;
  if (!ok) {
    s.bad++;
    if (s.samples.length < SHOW) s.samples.push(detail);
  }
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fromCps = (cps) => cps.map((c) => String.fromCodePoint(c)).join("");

// Python-value marshalling: the generator emits JSON, so `null` means None.
const pyVal = (v) => (v === null ? null : v);

function run(rec) {
  switch (rec.k) {
    case "utf8len": {
      let got;
      try {
        got = utf8Len(fromCps(rec.cps));
      } catch {
        got = null;
      }
      record("utf8Len", got === rec.want, { cps: rec.cps, want: rec.want, got });
      break;
    }
    case "chr": {
      let got;
      try {
        got = [...pyChr(rec.cp)].map((c) => c.codePointAt(0));
      } catch {
        got = null;
      }
      record("pyChr", eq(got, rec.want_cps), { cp: rec.cp, want: rec.want_cps, got });
      break;
    }
    case "ord": {
      const got = pyOrd(fromCps(rec.cps));
      record("pyOrd", got === rec.want, { cps: rec.cps, want: rec.want, got });
      break;
    }
    case "formatint": {
      const got = pyFormatInt(rec.n, rec.w);
      record("pyFormatInt", got === rec.want, { n: rec.n, w: rec.w, want: rec.want, got });
      break;
    }
    case "reprstr": {
      const got = pyReprStr(fromCps(rec.cps));
      record("pyReprStr", got === rec.want, { cps: rec.cps, want: rec.want, got });
      break;
    }
    case "repr_list": {
      const got = pyRepr(rec.items.map(pyVal));
      record("pyRepr list", got === rec.want, { items: rec.items, want: rec.want, got });
      break;
    }
    case "repr_tuple": {
      const got = pyRepr({ __tuple__: rec.items.map(pyVal) });
      record("pyRepr tuple", got === rec.want, { items: rec.items, want: rec.want, got });
      break;
    }
    case "repr_set_empty": {
      const got = pyRepr(new Set());
      record("pyRepr set()", got === rec.want, { want: rec.want, got });
      break;
    }
    case "repr_dict": {
      const got = pyRepr(new Map(rec.items.map(([k, v]) => [k, pyVal(v)])));
      record("pyRepr dict", got === rec.want, { items: rec.items, want: rec.want, got });
      break;
    }
    case "repr_nested": {
      const got = pyRepr([1n, ["a", null], new Map([["k", true]])]);
      record("pyRepr nested", got === rec.want, { want: rec.want, got });
      break;
    }
    case "exprset": {
      // Item(h, v): hash is h, equality is on v — collisions between unequal items.
      const opts = { hash: (x) => x.h, eq: (a, b) => a.v === b.v };
      const s = new ExprSet([], opts);
      for (const [h, v] of rec.ops) s.add({ h, v });
      const order = [...s].map((x) => x.v);
      record("ExprSet size", s.size === rec.size, { ops: rec.ops, want: rec.size, got: s.size });
      record("ExprSet order", eq(order, rec.order), {
        ops: rec.ops,
        want: rec.order,
        got: order,
      });
      break;
    }
    case "exprmap": {
      const opts = { hash: (x) => x.h, eq: (a, b) => a.v === b.v };
      const m = new ExprMap([], opts);
      rec.ops.forEach(([h, v], i) => m.set({ h, v }, i));
      const order = [...m.keys()].map((x) => x.v);
      const values = [...m.values()];
      record("ExprMap size", m.size === rec.size, { ops: rec.ops, want: rec.size, got: m.size });
      record("ExprMap order", eq(order, rec.order), { ops: rec.ops, want: rec.order, got: order });
      record("ExprMap values", eq(values, rec.values), {
        ops: rec.ops,
        want: rec.values,
        got: values,
      });
      break;
    }
    case "frozenset": {
      const ka = frozensetKey(rec.a);
      const kb = frozensetKey(rec.b);
      record("frozensetKey same", (ka === kb) === rec.same, {
        a: rec.a,
        b: rec.b,
        want: rec.same,
        got: ka === kb,
      });
      const size = ka === "" ? 0 : ka.split(" ").length;
      record("frozensetKey size", size === rec.size, { a: rec.a, want: rec.size, got: size });
      break;
    }
    default:
      throw new Error(`unknown case kind ${rec.k}`);
  }
}

const path = process.argv[2] ?? "spike/out/builtins.jsonl";
const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });

let total = 0;
for await (const line of rl) {
  if (!line) continue;
  run(JSON.parse(line));
  total++;
}

let bad = 0;
console.log(`\n  ${total.toLocaleString()} cases\n`);
console.log("  " + "bucket".padEnd(24) + "cases".padStart(10) + "fail".padStart(9));
console.log("  " + "-".repeat(43));
for (const [bucket, s] of [...stats].sort()) {
  bad += s.bad;
  console.log(
    `  ${bucket.padEnd(24)}${s.n.toLocaleString().padStart(10)}${String(s.bad).padStart(9)}  ${s.bad ? "FAIL" : "ok"}`,
  );
}
console.log("  " + "-".repeat(43));
for (const [bucket, s] of stats) {
  if (!s.bad) continue;
  console.log(`\n  first divergences in ${bucket}:`);
  for (const d of s.samples) console.log("    " + JSON.stringify(d));
}
console.log(bad === 0 ? "\n  BUILTINS PROBE: GREEN\n" : `\n  BUILTINS PROBE: RED (${bad})\n`);
process.exit(bad === 0 ? 0 : 1);
