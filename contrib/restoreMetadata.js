// Gateway extension, NOT a port: RESTORE is unsupported by Python pin 91119bc.
// Bounded documented Databricks grammar: named table, literal version/timestamp.
// https://docs.databricks.com/aws/en/sql/language-manual/delta-restore
import { Dialect } from '../index.js';
import { TokenType } from '../src/tokens.js';

export function restoreTable(sql, dialect) {
  try {
    const d = Dialect.get_or_raise(dialect);
    if (d.constructor.name !== 'Databricks') return null;
    const tokens = d.tokenize(sql);
    if (tokens.at(-1)?.token_type === TokenType.SEMICOLON) tokens.pop();
    let i = 0;
    const word = (text) => {
      const t = tokens[i];
      if (t && t.token_type !== TokenType.IDENTIFIER && t.token_type !== TokenType.STRING && t.text.toUpperCase() === text) { i++; return true; }
      return false;
    };
    if (!word('RESTORE')) return null;
    word('TABLE');
    const names = [];
    do {
      const t = tokens[i++];
      if (!t || ![TokenType.VAR, TokenType.IDENTIFIER].includes(t.token_type)) return null;
      names.push(t.text);
      if (tokens[i]?.token_type !== TokenType.DOT) break;
      i++;
    } while (names.length < 3);
    word('TO');
    const version = word('VERSION');
    if (!version && !word('TIMESTAMP')) return null;
    if (!word('AS') || !word('OF')) return null;
    const value = tokens[i++];
    if (!value || i !== tokens.length) return null; // no tails, subqueries or batches
    if (version ? value.token_type !== TokenType.NUMBER || !/^\d+$/.test(value.text) : value.token_type !== TokenType.STRING) return null;
    const [table, schema = null, catalog = null] = names.reverse();
    return { catalog, schema, table, fullyQualifiedName: [catalog, schema, table].filter(Boolean).join('.'), operation: 'RESTORE' };
  } catch {
    return null;
  }
}
