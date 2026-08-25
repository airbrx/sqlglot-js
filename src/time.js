// py: sqlglot/time.py @ 91119bc

// The generic time format is based on python time.strftime.
// https://docs.python.org/3/library/time.html#time.strftime
import { TrieResult, inTrie, newTrie } from "./trie.js";
import { pyDateTimeFromIsoFormat, PyValueError } from "./_py/datetime.js";
import { pyRstrip, pyZfill } from "./_py/str.js";

export { TIMEZONES } from "./_gen/timezones.js";

/**
 * py: time.format_time(string, mapping, trie=None)
 *
 * Converts a time string given a mapping.
 *
 * @param {string} string
 * @param {Map<string,string>|Record<string,string>} mapping time format -> target format
 * @param {Map<any,any>} [trie] optional trie, can be passed in for performance
 * @returns {string|null}
 */
export function formatTime(string, mapping, trie = null) {
  if (!string) {
    return null;
  }

  // Python indexes and slices `string` by CODE POINT. Operating on the JS string
  // directly would split astral characters across `start`/`end`, so we work on a
  // code-point array and join at the end (PORT_PLAN.md §4.2's cpLen rule for time.js).
  const cps = [...string];
  const get = (m, k) => (m instanceof Map ? m.get(k) : m[k]);

  let start = 0;
  let end = 1;
  const size = cps.length;
  trie = trie || newTrie(mappingKeys(mapping));
  let current = trie;
  const chunks = [];
  let sym = null;

  while (end <= size) {
    let chars = cps.slice(start, end);
    let result;
    [result, current] = inTrie(current, [chars[chars.length - 1]]);

    if (result === TrieResult.FAILED) {
      if (sym) {
        end -= 1;
        chars = sym;
        sym = null;
      } else {
        chars = chars.slice(0, 1);
        end = start + 1;
      }

      start += chars.length;
      chunks.push(chars);
      current = trie;
    } else if (result === TrieResult.EXISTS) {
      sym = chars;
    }

    end += 1;

    if (result !== TrieResult.FAILED && end > size) {
      chunks.push(chars);
    }
  }

  return chunks
    .map((chars) => {
      const key = chars.join("");
      const mapped = get(mapping, key);
      return mapped === undefined ? key : mapped;
    })
    .join("");
}

function mappingKeys(mapping) {
  return mapping instanceof Map ? [...mapping.keys()] : Object.keys(mapping);
}

/**
 * py: time.subsecond_precision(timestamp_literal)
 *
 * Given an ISO-8601 timestamp literal, eg '2023-01-01 12:13:14.123456+00:00',
 * figure out its subsecond precision so we can construct types like DATETIME(6).
 *
 * PORT_PLAN.md §4.6 / R6: the result is INTERPRETER-VERSION DEPENDENT. CPython
 * before 3.11 accepts only 0, 3 or 6 fractional digits, so e.g.
 * '2023-01-01 12:13:14.1234' raises and this returns 0, where 3.11+ returns 6.
 * `_py/datetime.js` is pinned to the 3.9 grammar to match the harvested corpus;
 * `corpus/PROVENANCE.json` records the exact interpreter.
 *
 * @param {string} timestampLiteral
 * @returns {number} 0, 3 or 6
 */
export function subsecondPrecision(timestampLiteral) {
  try {
    const parsed = pyDateTimeFromIsoFormat(timestampLiteral);
    // py: len(str(parsed.microsecond).zfill(6).rstrip("0"))
    const subsecondDigitCount = pyRstrip(pyZfill(String(parsed.microsecond), 6), "0").length;
    let precision = 0;
    if (subsecondDigitCount > 3) {
      precision = 6;
    } else if (subsecondDigitCount > 0) {
      precision = 3;
    }
    return precision;
  } catch (e) {
    // py: except ValueError: return 0
    if (e instanceof PyValueError) return 0;
    throw e;
  }
}
