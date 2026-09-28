// contrib/gatewaySqlMetadata.js — airbrx-gateway cache-key metadata adapter.
//
// No upstream Python equivalent. This is airbrx-specific business logic built
// ON TOP of the real sqlglot-js port (via `Dialect.get_or_raise(dialect).parse`),
// not part of the port itself — no `py:` anchors, not subject to the
// transliteration contract in PORT_PLAN.md §2.
//
// It reimplements, using a real parsed AST instead of regexes, the metadata
// airbrx-gateway's `lib/utils/SqlParser.js` extracts from a SQL string for
// cache-key generation and routing. See contrib/README.md for the full list
// of verified behaviors and intentional deviations from that regex parser.

import { restoreTable } from "./restoreMetadata.js";
import { fallbackSqlIdentity, sameSqlStructure } from "./sqlIdentity.js";
import { Dialect, ErrorLevel, exp } from "../index.js";

// UNION/INTERSECT/EXCEPT (set operations): these are read-only compositions
// of two SELECTs, same as a bare SELECT -- found via airbrx-gateway PR #228's
// review. Before this fix, getStatementType()'s STATEMENT_TYPE_BY_CLASS
// fallback (name.toUpperCase()) already produced the right string
// ("UNION"/"INTERSECT"/"EXCEPT"), but that string wasn't in READ_ONLY_TYPES,
// so isReadOnly came back false for a plain read -- a real, in-production
// consumer (airbrx-gateway's Postgres adapter) treats isReadOnly=false as
// "this is a mutation", routing a `SELECT ... UNION ALL ...` through
// cache-invalidation logic meant for actual writes.
const READ_ONLY_TYPES = new Set(["SELECT", "EXPLAIN", "WITH", "LIST", "SHOW", "DESCRIBE", "DESC", "UNION", "INTERSECT", "EXCEPT"]);
const DATA_CHANGE_TYPES = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "COPY", "RESTORE"]);
const DDL_TYPES = new Set([
  "CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME", "VACUUM", "OPTIMIZE",
  "ANALYZE", "REFRESH", "MSCK", "CACHE", "UNCACHE", "CLEAR",
]);
const DCL_TYPES = new Set(["GRANT", "REVOKE", "DENY"]);
const DELTA_OP_TYPES = new Set(["OPTIMIZE", "VACUUM", "MERGE", "RESTORE", "CONVERT"]);

// Matches the statement types airbrx-gateway's own `_extractTables` switch
// handles (OPTIMIZE/VACUUM go through `extractCommandTables` instead — see
// below). Statement types outside this set (USE, SET, GRANT, REVOKE,
// DESCRIBE, SHOW...) are walked for `exp.Table` too, structurally — e.g. a
// `USE main.sales` statement's target is itself an `exp.Table` node — but
// that is session-context plumbing, not a "this statement reads/writes a
// table" signal, so it must not appear in `tables[]`.
// UNION/INTERSECT/EXCEPT included alongside SELECT: extractTables() walks
// the whole subtree via root.findAll(exp.Table, false) regardless of the
// root node's own type, so a set operation's root correctly surfaces
// exp.Table nodes from BOTH branches once its statementType is in this set
// -- verified directly (a two-branch UNION query returns both tables, not
// just one). Before this fix a set operation fell through to the `else`
// branch below and returned tables: [] unconditionally, losing all table
// metadata (and therefore any table-scoped cache-invalidation rule match)
// for a statement shape that is common in BI-tool-generated SQL.
const TABLE_BEARING_TYPES = new Set([
  "SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "COPY", "CREATE", "DROP", "ALTER", "TRUNCATE",
  "UNION", "INTERSECT", "EXCEPT",
]);

// Real AST class name -> gateway-shaped statementType string. Anything not
// listed here (including every `Command` fallback node — see
// contrib/README.md's "Command fallback" section) is classified from its own
// text instead; see `getStatementType` below.
const STATEMENT_TYPE_BY_CLASS = {
  Select: "SELECT",
  Insert: "INSERT",
  Update: "UPDATE",
  Delete: "DELETE",
  Merge: "MERGE",
  Create: "CREATE",
  Drop: "DROP",
  Alter: "ALTER",
  TruncateTable: "TRUNCATE",
  Use: "USE",
  Set: "SET",
  Describe: "DESCRIBE",
  Grant: "GRANT",
  Revoke: "REVOKE",
};

const NON_DETERMINISTIC_ANONYMOUS_NAMES = new Map([
  ["CURDATE", "date"],
  ["TODAY", "date"],
  ["NOW", "time"],
  ["GETDATE", "time"],
  ["SYSDATE", "time"],
]);

function emptyNonDeterministicResult() {
  return { hasNonDeterministicFunctions: false, types: [], functions: [] };
}

/**
 * @param {string} sql
 * @param {{dialect?: string, parameterValues?: object|null}} [options]
 * @returns {object}
 */
export function extractSqlMetadata(sql, options = {}) {
  const { dialect = null, parameterValues = null } = options;

  // Matches gateway ordering: cache-override is a magic-string convention
  // scanned over the raw SQL text, not a real SQL construct, so it is
  // computed before (and independently of) parsing — it must survive a
  // ParseError. See contrib/README.md "Cache-override comment scanning".
  const cacheOverride = extractCacheOverride(sql);

  if (!sql || typeof sql !== "string") {
    return emptyResult(sql ?? null, cacheOverride);
  }

  let root;
  let roots;
  try {
    const d = Dialect.get_or_raise(dialect);
    // AIR-2135: pinned parser.py:2254-2256 emits Semicolon nodes solely
    // to retain terminator comments. They carry no executable statement.
    // Filter AST nodes, never SQL text: comments/literals cannot hide a write.
    roots = d.parse(sql).filter((node) => node && !(node instanceof exp.Semicolon));
    [root] = roots;
  } catch (err) {
    const table = restoreTable(sql, dialect);
    if (table) {
      return {
        ...safeDefaultResult(sql, cacheOverride, null),
        statementType: "RESTORE", statementCount: 1,
        mutationTypes: ["RESTORE"], mutations: [{ statementType: "RESTORE", tables: [table] }],
        isDDL: false, isDeltaOperation: true,
        isFullyQualified: Boolean(table.catalog && table.schema),
        tables: [table], tableCount: 1,
        catalogs: table.catalog ? [table.catalog] : [], schemas: table.schema ? [table.schema] : [],
      };
    }
    return safeDefaultResult(sql, cacheOverride, describeError(err));
  }

  if (!root) {
    return emptyResult(sql, cacheOverride);
  }

  try {
    // Multi-statement requests are unsupported for caching, including all-SELECT
    // batches. Retain every parsed table for invalidation and the full raw identity.
    if (roots.length !== 1) {
      const result = safeDefaultResult(sql, cacheOverride, "Multi-statement SQL is not cacheable");
      result.statementCount = roots.length;
      result.mutationTypes = [...new Set(roots.flatMap(mutationTypes))];
      result.mutations = roots.flatMap(mutationRecords);
      result.tables = roots.flatMap((node) => extractRootTables(node));
      result.tableCount = result.tables.length;
      result.catalogs = [...new Set(result.tables.map((t) => t.catalog).filter(Boolean))];
      result.schemas = [...new Set(result.tables.map((t) => t.schema).filter(Boolean))];
      return result;
    }

    const statementType = getStatementType(root);
    // Safety is a whole-input property, never a property of just the root.
    // Command bodies are opaque (EXPLAIN ANALYZE can execute a mutation).
    const nodes = [...root.walk(false)];
    const types = nodes.map(getStatementType);
    const isDataChange = types.some((type) => DATA_CHANGE_TYPES.has(type)) || nodes.some((n) => n instanceof exp.Into);
    const isDDL = types.some((type) => DDL_TYPES.has(type));
    const isDCL = types.some((type) => DCL_TYPES.has(type));
    const unsafe = isDataChange || isDDL || isDCL || nodes.some((n) =>
      n instanceof exp.Command || n instanceof exp.Lock || getIsSessionStateChange(n, getStatementType(n)));
    const isReadOnly = READ_ONLY_TYPES.has(statementType) && !unsafe;
    const isSessionStateChange = getIsSessionStateChange(root, statementType);
    const sessionStateChange = isSessionStateChange ? extractSessionStateChange(root, statementType) : null;
    const tables = extractRootTables(root);
    const isFullyQualified = tables.length > 0 && tables.every((t) => t.catalog && t.schema);
    const parameterInfo = extractParameters(root);
    const nonDeterministic = detectNonDeterministic(root);

    // Generation is not a proof of completeness: missing transforms can silently
    // drop clauses. Reparse in the same dialect and compare the WHOLE argument tree.
    // On an error, warning, or structural change, retain full-input identity with
    // SQL-aware lexical normalization for proven reads only.
    let standardizedSql = sql;
    let extractionError = null;
    try {
      const d = Dialect.get_or_raise(dialect);
      const generated = d.generate(root, { pretty: false, comments: false, unsupported_level: ErrorLevel.RAISE });
      const reparsed = d.parse(generated).filter((node) => node && !(node instanceof exp.Semicolon));
      if (reparsed.length !== 1 || !sameSqlStructure(root, reparsed[0], d)) {
        throw new Error("generated SQL changes parsed structure");
      }
      standardizedSql = generated;
    } catch (err) {
      extractionError = `standardizedSql generation failed: ${describeError(err)}`;
      if (isReadOnly) standardizedSql = fallbackSqlIdentity(sql, root, Dialect.get_or_raise(dialect));
    }

    // A mutation-containing SELECT must never acquire a normalized read identity.
    if (unsafe && READ_ONLY_TYPES.has(statementType)) standardizedSql = sql;
    return {
      statementCount: 1,
      mutationTypes: mutationTypes(root),
      mutations: mutationRecords(root),
      // AIR-2135: read safety was established from the full AST above.
      // Generation coverage only affects normalization; raw SQL is a full key.
      cacheable: isReadOnly,
      statementType,
      isReadOnly,
      isSessionStateChange,
      sessionStateChange,
      isFullyQualified,
      cacheOverride,
      isDataChange,
      isDDL,
      isDCL,
      isDeltaOperation: DELTA_OP_TYPES.has(statementType),
      tables,
      tableCount: tables.length,
      catalogs: [...new Set(tables.map((t) => t.catalog).filter(Boolean))],
      schemas: [...new Set(tables.map((t) => t.schema).filter(Boolean))],
      standardizedSql,
      originalSql: sql,
      hasParameters: parameterInfo.hasParameters,
      parameterNames: parameterInfo.names,
      parameterStyle: parameterInfo.style,
      parameterValues: parameterInfo.hasParameters ? parameterValues : null,
      nonDeterministic,
      extractionError,
    };
  } catch (err) {
    return safeDefaultResult(sql, cacheOverride, describeError(err));
  }
}

// Strips the ANSI underline/reset codes `errors.js::highlightSql` embeds in
// `ParseError`/`TokenError` messages — harmless in a terminal, but this
// field can end up in a JSON payload or a log line, where raw escape codes
// are just noise.
const ANSI_ESCAPE_RE = /\u001b\[[0-9;]*m/g;

function describeError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(ANSI_ESCAPE_RE, "");
}

function extractCacheOverride(sql) {
  if (typeof sql !== "string") return null;
  if (/__AIRBRX_NOCACHE__/i.test(sql)) return "nocache";
  if (/__AIRBRX_CACHE__/i.test(sql)) return "cache";
  return null;
}

function emptyResult(originalSql, cacheOverride) {
  return {
    statementType: "UNKNOWN",
    statementCount: 0,
    mutationTypes: [],
    mutations: [],
    cacheable: false,
    isReadOnly: false,
    isSessionStateChange: false,
    sessionStateChange: null,
    isFullyQualified: false,
    cacheOverride,
    isDataChange: false,
    isDDL: false,
    isDCL: false,
    isDeltaOperation: false,
    tables: [],
    tableCount: 0,
    catalogs: [],
    schemas: [],
    standardizedSql: null,
    originalSql,
    hasParameters: false,
    parameterNames: [],
    parameterStyle: null,
    parameterValues: null,
    nonDeterministic: emptyNonDeterministicResult(),
    extractionError: null,
  };
}

// Error tolerance is the whole point of this module (see contrib/README.md):
// a real parser throws where the gateway's regex parser degrades silently.
// On any parse/extraction failure we err toward NOT caching — non-read-only,
// DDL-shaped, data-changing — rather than risk caching something we could
// not understand. `standardizedSql` still falls back to the raw `sql` (not
// `null`) for the same cache-key-stability reason as the generator-gap path
// above: a statement sqlglot-js can't parse AT ALL today (e.g. Databricks'
// `RESTORE TABLE ... TO VERSION AS OF ...`) still has a stable string a
// cache key can be built from, and `sql` is guaranteed non-empty here since
// this path only runs after `emptyResult`'s own empty/absent-SQL check.
function safeDefaultResult(sql, cacheOverride, extractionError) {
  return {
    statementType: "UNKNOWN",
    statementCount: null, // Unknown after a parse failure, not zero statements.
    mutationTypes: [],
    mutations: [],
    cacheable: false,
    isReadOnly: false,
    isSessionStateChange: false,
    sessionStateChange: null,
    isFullyQualified: false,
    cacheOverride,
    isDataChange: true,
    isDDL: true,
    isDCL: false,
    isDeltaOperation: false,
    tables: [],
    tableCount: 0,
    catalogs: [],
    schemas: [],
    standardizedSql: sql,
    originalSql: sql,
    hasParameters: false,
    parameterNames: [],
    parameterStyle: null,
    parameterValues: null,
    nonDeterministic: emptyNonDeterministicResult(),
    extractionError,
  };
}

// Preserve occurrences and local table scope: two DELETEs may match two rules.
function isMutation(node) {
  const type = getStatementType(node);
  return DATA_CHANGE_TYPES.has(type) || DDL_TYPES.has(type) || DCL_TYPES.has(type);
}

function mutationRecords(root) {
  return [...root.walk(false)].filter(isMutation).map((node) => ({
    statementType: getStatementType(node),
    tables: extractRootTables(node, node),
  }));
}

function mutationTypes(root) {
  return [...new Set([...root.walk(false)].filter(isMutation).map(getStatementType))];
}

function extractRootTables(root, mutationOwner = null) {
  const type = getStatementType(root);
  if (root instanceof exp.Command) return extractCommandTables(root, type);
  return TABLE_BEARING_TYPES.has(type) ? extractTables(root, type, mutationOwner) : [];
}

function getStatementType(root) {
  if (root instanceof exp.Into) return "CREATE"; // SELECT INTO creates its destination.
  if (root instanceof exp.Command) {
    const kw = typeof root.args.this === "string" ? root.args.this.toUpperCase() : "";
    // An opaque COPY fallback has no trustworthy target: preserve deny refusal.
    if (kw === "COPY") return "UNKNOWN";
    return kw || "UNKNOWN";
  }
  const name = root.constructor.name;
  return STATEMENT_TYPE_BY_CLASS[name] ?? name.toUpperCase();
}

function getIsSessionStateChange(root, statementType) {
  if (statementType === "USE" || statementType === "SET") return true;
  if (root instanceof exp.Alter && String(root.args.kind ?? "").toUpperCase() === "SESSION") return true;
  return false;
}

function identText(node) {
  if (node == null) return null;
  return node instanceof exp.Expr ? (node.args.this ?? null) : node;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function tableInfo(t, operation) {
  const table = identText(t.args.this);
  const schema = identText(t.args.db);
  const catalog = identText(t.args.catalog);
  const fullyQualifiedName = [catalog, schema, table].filter(Boolean).join(".");
  return { catalog, schema, table, fullyQualifiedName, operation };
}

function tagAll(node, op, opByTable) {
  if (!node) return;
  for (const t of node.findAll(exp.Table, false)) opByTable.set(t, op);
}

// Real AST classes distinguish which clause a table came from far more
// reliably than the gateway's per-statement-type regex switch, at the cost
// of needing a small map of "where does the target table live" per class —
// see contrib/README.md's "Table operation tagging" section, including the
// documented CREATE-TABLE-AS-SELECT source-table improvement.
function tagOperations(root, statementType) {
  const opByTable = new Map();
  switch (statementType) {
    case "COPY":
      // COPY FROM loads the target. COPY TO exports it; retain conservative
      // mutation classification but do not label source tables as writes.
      if (root.args.kind) tagAll(root.args.this, "COPY", opByTable);
      break;
    case "INSERT":
      tagAll(root.args.this, "INSERT", opByTable);
      break;
    case "UPDATE":
      tagAll(root.args.this, "UPDATE", opByTable);
      break;
    case "DELETE":
      tagAll(root.args.this, "DELETE", opByTable);
      break;
    case "CREATE":
      tagAll(root.args.this, "CREATE", opByTable);
      break;
    case "ALTER":
      tagAll(root.args.this, "ALTER", opByTable);
      break;
    case "MERGE":
      tagAll(root.args.this, "MERGE_TARGET", opByTable);
      tagAll(root.args.using, "MERGE_SOURCE", opByTable);
      break;
    case "DROP":
      for (const t of root.args.tables ?? []) opByTable.set(t, "DROP");
      break;
    case "TRUNCATE":
      for (const t of root.args.expressions ?? []) {
        if (t instanceof exp.Table) opByTable.set(t, "TRUNCATE");
      }
      break;
  }
  return opByTable;
}

function collectCteNames(root) {
  const names = new Set();
  for (const withNode of root.findAll(exp.With, false)) {
    for (const cte of withNode.args.expressions ?? []) {
      const name = identText(cte.args.alias?.args?.this);
      if (name) names.add(String(name).toLowerCase());
    }
  }
  return names;
}

function extractTables(root, statementType, mutationOwner = null) {
  const opByTable = new Map();
  for (const node of root.walk(false)) {
    for (const [table, operation] of tagOperations(node, getStatementType(node))) opByTable.set(table, operation);
  }
  const cteNames = collectCteNames(root);
  const out = [];
  for (const t of root.findAll(exp.Table, false)) {
    if (mutationOwner) {
      let owner = t.parent;
      while (owner && owner !== mutationOwner && !isMutation(owner)) owner = owner.parent;
      if (owner !== mutationOwner) continue; // Belongs to a nested mutation occurrence.
    }
    if (t.this instanceof exp.Literal) continue;
    const info = tableInfo(t, opByTable.get(t) ?? "SELECT");
    // A real AST does not itself mark a FROM-clause reference as
    // "this name resolves to a CTE" (that needs schema-aware qualification,
    // i.e. the optimizer) — same underlying limitation the gateway's regex
    // has, just resolved here from a real `With`/`CTE` node's alias instead
    // of a fragile regex over the raw WITH clause. See contrib/README.md.
    if (!opByTable.has(t) && !info.catalog && !info.schema && info.table && cteNames.has(info.table.toLowerCase())) continue;
    out.push(info);
  }
  return out;
}

// Databricks Delta-specific OPTIMIZE/VACUUM are a verified, permanent
// `Command` fallback in this port (upstream's own designed fallback for
// syntax it does not model as a real statement class) — see
// contrib/README.md. The regex here is scoped to ONLY the Command node's own
// captured remainder text, never the full SQL string.
function extractCommandTables(root, statementType) {
  if (statementType !== "OPTIMIZE" && statementType !== "VACUUM") return [];
  const rawExpression = root.args.expression;
  const raw = typeof rawExpression === "string" ? rawExpression : identText(rawExpression);
  if (!raw) return [];
  // The first character must also allow a backtick/double-quote: a
  // backtick- or double-quoted target (`OPTIMIZE \`main\`.\`sales\`.\`orders\``)
  // starts with the quote character itself, not a letter/underscore, so a
  // first-char class of only `[A-Za-z_]` never matched a quoted identifier
  // at all -- the regex returned no match and this function silently
  // returned `[]`, breaking table-scoped cache invalidation for any quoted
  // OPTIMIZE/VACUUM target. Verified: `OPTIMIZE \`main\`.\`sales\`.\`orders\``
  // returned `tables: []` before this fix.
  const m = String(raw).trim().match(/^([A-Za-z_`"][A-Za-z0-9_.`"]*)/);
  if (!m) return [];
  const parts = m[1].replace(/[`"]/g, "").split(".");
  let catalog = null;
  let schema = null;
  let table = null;
  if (parts.length === 3) [catalog, schema, table] = parts;
  else if (parts.length === 2) [schema, table] = parts;
  else [table] = parts;
  const fullyQualifiedName = [catalog, schema, table].filter(Boolean).join(".");
  return [{ catalog, schema, table, fullyQualifiedName, operation: statementType }];
}

// ---------------------------------------------------------------------------
// Session state (SET / USE / ALTER SESSION)
// ---------------------------------------------------------------------------

function qualifiedColumnKey(col) {
  const parts = [identText(col.args.catalog), identText(col.args.db), identText(col.args.table), identText(col.args.this)];
  return parts.filter((p) => p !== null && p !== undefined).join(".");
}

function valueText(node) {
  if (node == null) return null;
  if (node instanceof exp.Literal) return String(node.args.this);
  if (node instanceof exp.Var) return String(node.args.this);
  if (node instanceof exp.Identifier) return String(node.args.this);
  if (node instanceof exp.Column) return qualifiedColumnKey(node);
  if (node instanceof exp.Concat) {
    // Databricks/Spark-family dialects' STRING_ESCAPES config does not
    // declare `''` as an apostrophe escape inside single-quoted strings —
    // verified against pinned CPython sqlglot directly, not a JS-port bug.
    // `'o''brien'` tokenizes as two adjacent string literals, which the
    // parser folds into a Concat. Any Concat reaching a SET/ALTER SESSION
    // value position is that artifact (there is no other way to get one
    // here), so rejoining the literal parts with `'` undoes it and recovers
    // the SQL-standard doubled-quote value. See contrib/README.md.
    const parts = node.args.expressions ?? [];
    if (parts.length && parts.every((p) => p instanceof exp.Literal && p.args.is_string)) {
      return parts.map((p) => String(p.args.this)).join("'");
    }
    return null;
  }
  return null;
}

function extractSetItem(setItem) {
  const eq = setItem.args.this;
  if (!(eq instanceof exp.EQ)) return null;
  const keyNode = eq.args.this;
  const key = keyNode instanceof exp.Column ? qualifiedColumnKey(keyNode) : identText(keyNode);
  if (!key) return null;
  const value = valueText(eq.args.expression);
  return { key, value };
}

// `SET key value` (no `=`) and bare `SET key` (read-one) are a verified
// permanent `Command` fallback in this port, same class of gap as
// OPTIMIZE/VACUUM above — only `SET key = value` and bare `SET` (list-all)
// produce a real `Set` node. See contrib/README.md "SET fallback forms".
function extractSetFromCommandText(root) {
  const rawExpression = root.args.expression;
  const raw = typeof rawExpression === "string" ? rawExpression : identText(rawExpression);
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return { kind: "read" };
  const setForm = trimmed.match(/^([A-Za-z_][A-Za-z0-9_.]*)\s*(?:=\s*|\s+)(.+)$/);
  if (setForm) return { kind: "set", key: setForm[1], value: unquote(setForm[2]) };
  const readOne = trimmed.match(/^([A-Za-z_][A-Za-z0-9_.]*)$/);
  if (readOne) return { kind: "read", key: readOne[1] };
  return null;
}

// Mirrors airbrx-gateway's `_unquoteValue`: strips one layer of matching
// surrounding quotes and decodes the doubled-quote escape. Only needed for
// the raw-text Command-fallback path above — the real `Set`/`AlterSession`
// path gets already-decoded `Literal` values from the tokenizer (Concat
// artifact aside, handled in `valueText`).
function unquote(value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed.length >= 2) {
    const first = trimmed.charAt(0);
    const last = trimmed.charAt(trimmed.length - 1);
    if ((first === "'" && last === "'") || (first === '"' && last === '"') || (first === "`" && last === "`")) {
      const inner = trimmed.slice(1, -1);
      return inner.split(first + first).join(first);
    }
  }
  return trimmed;
}

function extractUseChange(root) {
  const kind = identText(root.args.kind)?.toUpperCase() ?? null;
  const table = root.args.this;
  const primary = identText(table?.args?.this);
  const secondary = identText(table?.args?.db);
  if (kind === "CATALOG") return { kind: "use_catalog", catalog: primary };
  if (kind === "SCHEMA" || kind === "DATABASE") return { kind: "use_schema", schema: primary };
  if (secondary) return { kind: "use_namespace", catalog: secondary, schema: primary };
  return { kind: "use_schema", schema: primary };
}

function extractSessionStateChange(root, statementType) {
  if (root instanceof exp.Use) return extractUseChange(root);

  if (statementType === "SET" && !(root instanceof exp.Command)) {
    // Real `Set` node: bare `SET` (list-all) or `SET key = value`.
    const items = root.args.expressions ?? [];
    if (items.length === 0) return { kind: "read" };
    const item = extractSetItem(items[0]);
    return item ? { kind: "set", key: item.key, value: item.value } : null;
  }

  if (statementType === "SET" && root instanceof exp.Command) {
    return extractSetFromCommandText(root);
  }

  if (root instanceof exp.Alter && String(root.args.kind ?? "").toUpperCase() === "SESSION") {
    const action = root.args.actions?.[0];
    if (action instanceof exp.AlterSession && action.args.expressions?.length) {
      const item = extractSetItem(action.args.expressions[0]);
      return item ? { kind: "alter_session", key: item.key, value: item.value } : null;
    }
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

function extractParameters(root) {
  const namedOrder = [];
  const namedSeen = new Set();
  let positionalCount = 0;
  const numberedOrder = [];
  const numberedSeen = new Set();

  for (const node of root.findAll(exp.Placeholder, exp.Parameter, false)) {
    if (node instanceof exp.Placeholder) {
      const name = node.args.this;
      if (name) {
        if (!namedSeen.has(name)) {
          namedSeen.add(name);
          namedOrder.push(name);
        }
      } else {
        positionalCount += 1;
      }
    } else {
      const lit = node.args.this;
      const num = lit instanceof exp.Literal ? String(lit.args.this) : null;
      if (num) {
        const label = `$${num}`;
        if (!numberedSeen.has(label)) {
          numberedSeen.add(label);
          numberedOrder.push(label);
        }
      }
    }
  }

  // Priority mirrors the gateway: named > positional > numbered. Real SQL
  // never mixes styles in practice, so this only matters as a tie-break.
  if (namedOrder.length) return { hasParameters: true, names: namedOrder, style: "named" };
  if (positionalCount) {
    return {
      hasParameters: true,
      names: Array.from({ length: positionalCount }, (_, i) => `p${i}`),
      style: "positional",
    };
  }
  if (numberedOrder.length) return { hasParameters: true, names: numberedOrder, style: "numbered" };
  return { hasParameters: false, names: [], style: null };
}

// ---------------------------------------------------------------------------
// Non-deterministic function detection
// ---------------------------------------------------------------------------

function classifyNonDeterministic(node) {
  if (node instanceof exp.CurrentTimestamp) {
    return node.args.sysdate ? { type: "time", name: "SYSDATE" } : { type: "time", name: "CURRENT_TIMESTAMP" };
  }
  if (node instanceof exp.CurrentDate) return { type: "date", name: "CURRENT_DATE" };
  if (node instanceof exp.CurrentTime) return { type: "time", name: "CURRENT_TIME" };
  if (node instanceof exp.CurrentRole) return { type: "user", name: "CURRENT_ROLE" };
  if (node instanceof exp.CurrentUser) return { type: "user", name: "CURRENT_USER" };
  if (node instanceof exp.SessionUser) return { type: "user", name: "SESSION_USER" };
  if (node instanceof exp.Anonymous) {
    // Fallback for names some dialects don't type (e.g. Snowflake has no
    // built-in CURDATE/TODAY/NOW, so they parse as plain function calls) —
    // see contrib/README.md "Non-deterministic function detection". A real
    // Anonymous call node carries no false-positive risk analogous to
    // matching inside a string literal, since parsing already excludes
    // string literals from this shape entirely.
    const name = typeof node.args.this === "string" ? node.args.this.toUpperCase() : null;
    const type = name ? NON_DETERMINISTIC_ANONYMOUS_NAMES.get(name) : null;
    if (type) return { type, name: `${name}()` };
  }
  return null;
}

function detectNonDeterministic(root) {
  const types = new Set();
  const functions = new Set();
  for (const node of root.findAll(
    exp.CurrentDate,
    exp.CurrentTime,
    exp.CurrentTimestamp,
    exp.CurrentUser,
    exp.CurrentRole,
    exp.SessionUser,
    exp.Anonymous,
    false,
  )) {
    const hit = classifyNonDeterministic(node);
    if (hit) {
      types.add(hit.type);
      functions.add(hit.name);
    }
  }
  if (!types.size) return emptyNonDeterministicResult();
  return { hasNonDeterministicFunctions: true, types: [...types], functions: [...functions] };
}
