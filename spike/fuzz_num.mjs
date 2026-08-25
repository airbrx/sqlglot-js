// Differential runner for the numeric go/no-go probe (PORT_PLAN.md §7 P0 item 1).
//
//   python3 spike/py/gen_num_cases.py > spike/out/num_cases.jsonl
//   node spike/fuzz_num.mjs spike/out/num_cases.jsonl
//
// Exits non-zero on any divergence and prints the first N per bucket.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import {
  pyFloatToStr,
  pyIntToStr,
  pyDecimal,
  decAdd,
  decSub,
  decMul,
  decDiv,
  decNeg,
  decAbs,
  decCmp,
  literalNumberText,
} from "../src/_py/num.js";

const SHOW = 8;

const buf = new ArrayBuffer(8);
const dv = new DataView(buf);
function bitsToFloat(hex) {
  dv.setBigUint64(0, BigInt("0x" + hex));
  return dv.getFloat64(0);
}

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

// Extra safety net: JS `String(x)` is asserted *not* to be a valid substitute, so
// we also count how often the naive port would have been wrong. That number is
// what makes the "you cannot just use Number.prototype.toString()" claim concrete.
let naiveFloatBad = 0;

function run(rec) {
  switch (rec.k) {
    case "float": {
      const x = bitsToFloat(rec.bits);
      const got = pyFloatToStr(x);
      record("str(float)", got === rec.want, { bits: rec.bits, want: rec.want, got });
      const naive = Number.isFinite(x) ? String(x) : String(x);
      if (naive !== rec.want) naiveFloatBad++;
      // round-trip: our text must parse back to the identical double
      if (Number.isFinite(x)) {
        const back = Number(got);
        record("float round-trip", Object.is(back, x), { bits: rec.bits, got, back });
      }
      break;
    }
    case "dec_str": {
      const got = pyDecimal(rec.a).toString();
      record("str(Decimal)", got === rec.want, { a: rec.a, want: rec.want, got });
      break;
    }
    case "dec_op": {
      const a = pyDecimal(rec.a);
      const b = pyDecimal(rec.b);
      let got;
      try {
        const r =
          rec.op === "+"
            ? decAdd(a, b)
            : rec.op === "-"
              ? decSub(a, b)
              : rec.op === "*"
                ? decMul(a, b)
                : decDiv(a, b);
        got = r.toString();
      } catch {
        got = null;
      }
      record(`Decimal ${rec.op}`, got === rec.want, {
        a: rec.a,
        b: rec.b,
        op: rec.op,
        want: rec.want,
        got,
      });
      break;
    }
    case "dec_cmp": {
      let got;
      try {
        const c = decCmp(pyDecimal(rec.a), pyDecimal(rec.b));
        got = Number.isNaN(c) ? null : c;
      } catch {
        got = null;
      }
      record("Decimal cmp", got === rec.want, { a: rec.a, b: rec.b, want: rec.want, got });
      break;
    }
    case "dec_neg": {
      const got = decNeg(pyDecimal(rec.a)).toString();
      record("Decimal neg", got === rec.want, { a: rec.a, want: rec.want, got });
      break;
    }
    case "dec_abs": {
      const got = decAbs(pyDecimal(rec.a)).toString();
      record("Decimal abs", got === rec.want, { a: rec.a, want: rec.want, got });
      break;
    }
    case "litnum_f": {
      const x = bitsToFloat(rec.bits);
      const r = literalNumberText(x);
      record("Literal.number(float)", r.text === rec.want && r.neg === rec.neg, {
        bits: rec.bits,
        want: `${rec.neg ? "Neg " : ""}${rec.want}`,
        got: `${r.neg ? "Neg " : ""}${r.text}`,
      });
      break;
    }
    case "litnum_i": {
      const r = literalNumberText(BigInt(rec.a));
      record("Literal.number(int)", r.text === rec.want && r.neg === rec.neg, {
        a: rec.a,
        want: `${rec.neg ? "Neg " : ""}${rec.want}`,
        got: `${r.neg ? "Neg " : ""}${r.text}`,
      });
      break;
    }
    default:
      throw new Error(`unknown case kind ${rec.k}`);
  }
}

const path = process.argv[2] ?? "spike/out/num_cases.jsonl";
const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });

let total = 0;
for await (const line of rl) {
  if (!line) continue;
  run(JSON.parse(line));
  total++;
}

// Sanity: pyIntToStr is trivial but assert it anyway so the export is covered.
record("str(int)", pyIntToStr(-(2n ** 64n)) === "-18446744073709551616", {});

let bad = 0;
console.log(`\n  ${total.toLocaleString()} cases\n`);
console.log("  " + "bucket".padEnd(24) + "cases".padStart(10) + "fail".padStart(10));
console.log("  " + "-".repeat(44));
for (const [bucket, s] of stats) {
  bad += s.bad;
  const mark = s.bad === 0 ? "ok " : "FAIL";
  console.log(
    `  ${bucket.padEnd(24)}${s.n.toLocaleString().padStart(10)}${String(s.bad).padStart(10)}  ${mark}`,
  );
}
console.log("  " + "-".repeat(44));

for (const [bucket, s] of stats) {
  if (!s.bad) continue;
  console.log(`\n  first ${Math.min(SHOW, s.samples.length)} divergences in ${bucket}:`);
  for (const d of s.samples) console.log("    " + JSON.stringify(d));
}

console.log(
  `\n  [context] naive String(x) would have diverged on ${naiveFloatBad.toLocaleString()} float cases`,
);
console.log(bad === 0 ? "\n  NUMERIC PROBE: GREEN\n" : `\n  NUMERIC PROBE: RED (${bad} failures)\n`);
process.exit(bad === 0 ? 0 : 1);
