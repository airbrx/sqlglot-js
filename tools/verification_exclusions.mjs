// Narrow, reviewed consumer extension from PR #62, not a moving baseline.
// Only CURRENT_ROLE's exact table entry is excluded from pinned-UPSTREAM table
// comparisons; its actual parser/consumer behavior remains natively tested.
import assert from 'node:assert/strict';
import { TokenType } from '../src/tokens.js';
export function upstreamKeywords(table) {
  assert.equal(table.get('CURRENT_ROLE'), TokenType.CURRENT_ROLE, 'CURRENT_ROLE exclusion must remain the exact documented extension');
  const copy = new Map(table);
  copy.delete('CURRENT_ROLE');
  return copy;
}
export function upstreamFuncTokens(table) {
  assert.ok(table.has(TokenType.CURRENT_ROLE), 'CURRENT_ROLE FUNC_TOKENS extension missing');
  const copy = new Set(table);
  copy.delete(TokenType.CURRENT_ROLE);
  return copy;
}
export const CURRENT_ROLE_EXCLUSION = 'EXCLUSION: CURRENT_ROLE consumer extension (PR #62): exact keyword/FUNC_TOKENS entries only; runtime behavior is tested, not upstream parity';
