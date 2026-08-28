// Build a `TokenizerCore` for any dialect from P1's snapshotted settings.
//
// `dialects/dialect.js` lands at P5 and CONTRACTS.md §8 forbids resolving a dialect by
// NAME before then — silently falling back to the default dialect would make every
// per-dialect parity row vacuously green. But P1 already harvested every dialect's
// tokenizer SETTINGS, and `Tokenizer` accepts an already-resolved settings object, so a
// real Snowflake token stream is available at P3 without breaking that rule.
//
// This is the same construction `tools/tokens/check_streams.mjs` performs (and proves
// byte-exact against CPython over 23,457 streams); it is factored out here so the P3
// probes can reuse it rather than re-deriving it slightly differently.

import { readFileSync } from "node:fs";
import { TokenizerCore, TokenType } from "../../src/tokenizer_core.js";
import { newTrie } from "../../src/trie.js";
import { pyUpper } from "../../src/_py/str.js";

const snapshot = JSON.parse(readFileSync("corpus/tokens/settings.json", "utf8"));

function dec(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(dec);
  if ("$t" in v) {
    const t = TokenType[v.$t];
    if (t === undefined) throw new Error(`unknown TokenType in snapshot: ${v.$t}`);
    return t;
  }
  if ("$s" in v) return new Set(v.$s.map(dec));
  if ("$d" in v) return new Map(v.$d.map(([k, val]) => [k, dec(val)]));
  throw new Error(`unencodable snapshot node: ${JSON.stringify(v).slice(0, 80)}`);
}

// py: _TokenizerBase.__init_subclass__'s trie derivation.
function deriveTrie(settings) {
  const singles = [...settings.single_tokens.keys()];
  const keys = [
    ...settings.keywords.keys(),
    ...settings.comments.keys(),
    ...settings.quotes.keys(),
    ...settings.format_strings.keys(),
  ].filter((key) => key.includes(" ") || singles.some((single) => key.includes(single)));
  return newTrie(keys.map((key) => pyUpper(key)));
}

/** Dialects whose Tokenizer overrides a METHOD, so settings alone cannot reproduce it. */
export const METHOD_OVERRIDING = new Set(
  Object.entries(snapshot.cores)
    .filter(([, spec]) => (spec.overrides ?? []).length)
    .map(([name]) => name),
);

const cache = new Map();

/** @returns {{core: TokenizerCore, commands: Set<number>}|null} */
export function tokenizerFor(dialect) {
  if (cache.has(dialect)) return cache.get(dialect);
  const spec = snapshot.cores[dialect];
  if (!spec || METHOD_OVERRIDING.has(dialect)) {
    cache.set(dialect, null);
    return null;
  }
  const settings = {};
  for (const slot of snapshot.core_slots) settings[slot] = dec(spec.settings[slot]);
  const core = new TokenizerCore({ ...settings, keyword_trie: deriveTrie(settings) });
  // `Parser._parse_statement` reads `self.dialect.tokenizer_class.COMMANDS`; the
  // snapshot carries it per dialect, so the Command fallback is dialect-correct.
  const out = { core, commands: settings.commands };
  cache.set(dialect, out);
  return out;
}

export const DIALECTS = Object.keys(snapshot.cores);
