// Differential runner for the P0 calibration spike: trie.js / time.js / helper.js
// against the REAL sqlglot modules running under CPython 3.9.25.
//
//   PYTHONPATH=/tmp/sqlglot-ref python3 spike/py/gen_calib_cases.py > spike/out/calib.jsonl
//   node spike/fuzz_calib.mjs

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { TrieResult, newTrie, inTrie, TRIE_END } from "../src/trie.js";
import { formatTime, subsecondPrecision, TIMEZONES } from "../src/time.js";
import * as H from "../src/helper.js";
import { SequenceMatcher, getCloseMatches } from "../src/_py/difflib.js";

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

// Serialize a JS trie the same way the Python side does.
function dumpTrie(t) {
  const out = { end: false, children: {} };
  for (const [k, v] of t) {
    if (k === TRIE_END) out.end = true;
    else out.children[k] = dumpTrie(v);
  }
  return out;
}

function run(rec) {
  switch (rec.k) {
    case "trie_build": {
      const got = dumpTrie(newTrie(rec.words));
      record("trie: new_trie", eq(got, rec.want), { words: rec.words, want: rec.want, got });
      break;
    }
    case "trie_in": {
      const [res, sub] = inTrie(newTrie(rec.words), rec.probe);
      const ok = res === rec.want && eq(dumpTrie(sub), rec.sub);
      record("trie: in_trie", ok, {
        words: rec.words,
        probe: rec.probe,
        want: rec.want,
        got: res,
        subOk: eq(dumpTrie(sub), rec.sub),
      });
      break;
    }
    case "format_time": {
      let got;
      try {
        got = formatTime(rec.s, rec.mapping);
      } catch (e) {
        got = { __error__: e.constructor.name };
      }
      record("time: format_time", eq(got, rec.want), {
        s: rec.s,
        mapping: rec.mapping,
        want: rec.want,
        got,
      });
      break;
    }
    case "subsecond": {
      const got = subsecondPrecision(rec.s);
      record("time: subsecond_precision", got === rec.want, {
        s: rec.s,
        want: rec.want,
        got,
      });
      break;
    }
    case "iso": {
      const d = H.isIsoDate(rec.s);
      const dt = H.isIsoDatetime(rec.s);
      record("helper: is_iso_date", d === rec.date, { s: rec.s, want: rec.date, got: d });
      record("helper: is_iso_datetime", dt === rec.dt, { s: rec.s, want: rec.dt, got: dt });
      break;
    }
    case "isnum": {
      const i = H.isInt(rec.s);
      const f = H.isFloat(rec.s);
      record("helper: is_int", i === rec.is_int, { s: rec.s, want: rec.is_int, got: i });
      record("helper: is_float", f === rec.is_float, { s: rec.s, want: rec.is_float, got: f });
      break;
    }
    case "close_matches": {
      const got = getCloseMatches(rec.word, rec.poss, rec.n);
      record("difflib: get_close_matches", eq(got, rec.want), {
        word: rec.word,
        n: rec.n,
        want: rec.want,
        got,
      });
      break;
    }
    case "ratios": {
      const got = rec.poss.map((x) => new SequenceMatcher(null, x, rec.word).ratio());
      const q = rec.poss.map((x) => new SequenceMatcher(null, x, rec.word).quickRatio());
      const rq = rec.poss.map((x) => new SequenceMatcher(null, x, rec.word).realQuickRatio());
      record("difflib: ratio", eq(got, rec.want), { word: rec.word, want: rec.want, got });
      record("difflib: quick_ratio", eq(q, rec.quick), { word: rec.word, want: rec.quick, got: q });
      record("difflib: real_quick_ratio", eq(rq, rec.realquick), {
        word: rec.word,
        want: rec.realquick,
        got: rq,
      });
      break;
    }
    case "ratio1": {
      const sm = new SequenceMatcher(null, rec.a, rec.b);
      record("difflib: ratio (fuzz)", sm.ratio() === rec.ratio, {
        a: rec.a,
        b: rec.b,
        want: rec.ratio,
        got: sm.ratio(),
      });
      record("difflib: quick_ratio (fuzz)", sm.quickRatio() === rec.quick, {
        a: rec.a,
        b: rec.b,
        want: rec.quick,
        got: sm.quickRatio(),
      });
      record("difflib: real_quick_ratio (fuzz)", sm.realQuickRatio() === rec.realquick, {
        a: rec.a,
        b: rec.b,
        want: rec.realquick,
        got: sm.realQuickRatio(),
      });
      record("difflib: matching_blocks", eq(sm.getMatchingBlocks(), rec.blocks), {
        a: rec.a,
        b: rec.b,
        want: rec.blocks,
        got: sm.getMatchingBlocks(),
      });
      break;
    }
    case "camel": {
      const got = H.camelToSnakeCase(rec.s);
      record("helper: camel_to_snake_case", got === rec.want, {
        s: rec.s,
        want: rec.want,
        got,
      });
      break;
    }
    case "split_num_words": {
      let got;
      try {
        got = H.splitNumWords(rec.value, rec.sep, rec.n, rec.fill_from_start);
      } catch (e) {
        got = { __error__: e.constructor.name };
      }
      record("helper: split_num_words", eq(got, rec.want), {
        value: rec.value,
        sep: rec.sep,
        n: rec.n,
        want: rec.want,
        got,
      });
      break;
    }
    case "find_new_name": {
      const got = H.findNewName(new Set(rec.taken), rec.base);
      record("helper: find_new_name", got === rec.want, {
        taken: rec.taken,
        base: rec.base,
        want: rec.want,
        got,
      });
      break;
    }
    case "to_bool": {
      const got = H.toBool(rec.v);
      record("helper: to_bool", got === rec.want, { v: rec.v, want: rec.want, got });
      break;
    }
    case "merge_ranges": {
      const got = H.mergeRanges(rec.ranges);
      record("helper: merge_ranges", eq(got, rec.want), { ranges: rec.ranges, want: rec.want, got });
      break;
    }
    case "tsort": {
      let got;
      try {
        const dag = new Map(Object.entries(rec.dag).map(([k, v]) => [k, new Set(v)]));
        got = H.tsort(dag);
      } catch (e) {
        got = { __error__: e.message === "Cycle error" ? "ValueError" : e.constructor.name };
      }
      record("helper: tsort", eq(got, rec.want), { dag: rec.dag, want: rec.want, got });
      break;
    }
    case "dict_depth": {
      const got = H.dictDepth(rec.d);
      record("helper: dict_depth", got === rec.want, { d: rec.d, want: rec.want, got });
      break;
    }
    case "csv": {
      const got = H.csv(...rec.args, { sep: rec.sep });
      record("helper: csv", got === rec.want, { args: rec.args, want: rec.want, got });
      break;
    }
    case "seq_get": {
      const got = H.seqGet(rec.seq, rec.index);
      const want = rec.want === null || rec.want === undefined ? undefined : rec.want;
      record("helper: seq_get", got === want, {
        seq: rec.seq,
        index: rec.index,
        want,
        got,
      });
      break;
    }
    case "timezones_count": {
      record("time: TIMEZONES size", TIMEZONES.size === rec.want, {
        want: rec.want,
        got: TIMEZONES.size,
      });
      break;
    }
    case "timezones_sorted": {
      const got = [...TIMEZONES].sort();
      record("time: TIMEZONES contents", eq(got, rec.want), {
        want: rec.want.length,
        got: got.length,
        firstDiff: rec.want.find((x, i) => got[i] !== x),
      });
      break;
    }
    case "timezones_sample":
    case "timezones_all_hash":
      break;
    default:
      throw new Error(`unknown case kind ${rec.k}`);
  }
}

const path = process.argv[2] ?? "spike/out/calib.jsonl";
const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });

let total = 0;
for await (const line of rl) {
  if (!line) continue;
  run(JSON.parse(line));
  total++;
}

let bad = 0;
console.log(`\n  ${total.toLocaleString()} cases\n`);
console.log("  " + "bucket".padEnd(34) + "cases".padStart(10) + "fail".padStart(9));
console.log("  " + "-".repeat(53));
for (const [bucket, s] of [...stats].sort()) {
  bad += s.bad;
  console.log(
    `  ${bucket.padEnd(34)}${s.n.toLocaleString().padStart(10)}${String(s.bad).padStart(9)}  ${s.bad ? "FAIL" : "ok"}`,
  );
}
console.log("  " + "-".repeat(53));
for (const [bucket, s] of stats) {
  if (!s.bad) continue;
  console.log(`\n  first ${Math.min(SHOW, s.samples.length)} divergences in ${bucket}:`);
  for (const d of s.samples) console.log("    " + JSON.stringify(d));
}
console.log(bad === 0 ? "\n  CALIBRATION PROBE: GREEN\n" : `\n  CALIBRATION PROBE: RED (${bad})\n`);
process.exit(bad === 0 ? 0 : 1);
