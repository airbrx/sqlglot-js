// Gateway-only identity helpers; not an upstream SQLGlot port.
import { exp } from '../index.js';
import { TokenType } from '../src/tokens.js';

// Compare complete argument trees, not a list of clauses we happened to remember.
// Ignore source positions/comments and insertion order only. Keep false flags,
// literals, quoted identifiers and all semantic arguments. Equivalent rewrites may
// fail this deliberately conservative check and take the full-input fallback.
export function sqlStructure(node, dialect) {
  if (node instanceof exp.Expr) {
    if (node instanceof exp.Identifier && !node.quoted) node = dialect.normalize_identifier(node.copy());
    return [node.constructor.name, Object.entries(node.args)
      .filter(([, v]) => v != null && !(Array.isArray(v) && v.length === 0))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sqlStructure(v, dialect)])];
  }
  if (Array.isArray(node)) return node.map((v) => sqlStructure(v, dialect));
  return node;
}

export function sameSqlStructure(a, b, dialect) {
  return JSON.stringify(sqlStructure(a, dialect)) === JSON.stringify(sqlStructure(b, dialect));
}

// SQL-aware fallback: source spans, never a regex comment stripper. Token offsets
// are code points. Preserve literal/quoted-identifier bytes and parameter names.
// Fold only AST-confirmed unquoted identifiers and tokenizer-confirmed keywords.
// Finally reparse and compare the entire tree: normalization cannot remove a clause
// or change lexical adjacency (e.g. dollar parameters or prefixed literals).
export function fallbackSqlIdentity(sql, root, dialect) {
  try {
    const chars = Array.from(sql);
    const tokens = dialect.tokenize(sql);
    // Some dialects recognize executable/hint comments. Keep the original when
    // comments are not represented by a token; ordinary BI comments are removable.
    if (tokens.some((t) => t.comments?.some((c) => /^\s*[!+]/.test(c)))) return sql;
    const identifiers = new Map();
    for (const node of root.findAll(exp.Identifier)) {
      const { start, end } = node.meta;
      if (!node.quoted && Number.isInteger(start) && Number.isInteger(end)
        && chars.slice(start, end + 1).join('') === node.name) {
        identifiers.set(`${start}:${end}`, dialect.normalize_identifier(node.copy()).name);
      }
    }
    const functions = new Set([...root.findAll(exp.Func)].filter((n) => !(n instanceof exp.Anonymous)).map((n) => `${n.meta.start}:${n.meta.end}`));
    const keywords = dialect.tokenizer().constructor.KEYWORDS;
    const parts = tokens.map((token) => {
      const raw = chars.slice(token.start, token.end + 1).join('');
      const identifier = identifiers.get(`${token.start}:${token.end}`);
      if (identifier !== undefined) return identifier;
      if (token.token_type === TokenType.VAR && functions.has(`${token.start}:${token.end}`) && /^[a-z_][a-z_0-9]*$/i.test(raw)) return raw.toUpperCase();
      const keyword = raw.replace(/\s+/g, ' ').toUpperCase();
      return keywords.get(keyword) === token.token_type ? keyword : raw;
    });
    // A terminal semicolon is syntax, not another executable statement.
    if (tokens.at(-1)?.token_type === TokenType.SEMICOLON) parts.pop();
    // Keep parameter prefixes adjacent; spaces here are not portable SQL.
    const candidate = parts.map((part, i) => i && ![TokenType.PARAMETER, TokenType.COLON].includes(tokens[i - 1].token_type) ? ` ${part}` : part).join('');
    const reparsed = dialect.parse(candidate).filter((n) => n && !(n instanceof exp.Semicolon));
    return reparsed.length === 1 && sameSqlStructure(root, reparsed[0], dialect) ? candidate : sql;
  } catch {
    return sql;
  }
}
