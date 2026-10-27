// contrib/sessionState.js — airbrx-gateway session-state generalization (AIR-2360/AIR-2361).
//
// No upstream Python equivalent — airbrx-specific business logic built ON TOP of
// the real sqlglot-js port, same status as contrib/gatewaySqlMetadata.js: no
// `py:` anchors, not subject to the transliteration contract in PORT_PLAN.md §2.
//
// Classifies SET/RESET/USE/ALTER SESSION/DISCARD/transaction-control statements
// across dialects into a dialect-independent Effect shape, reduces a sequence of
// Effects into a State, and renders a State's replay log back to SQL through the
// real generator. See docs/proposals/session-state-module.md for the full design
// (Effect/State schemas, the per-dialect tables below, and why each decision was
// made) — this file is the implementation of that design, not a second copy of it.
//
// HARD RULE: no changes to src/parser.js, src/generator.js, src/tokens.js, or any
// dialect parser/generator. Everything upstream leaves as a Command (or
// misparses) is handled here, by exact AST shape + raw text, never by changing
// what upstream itself parses.

import { Dialect, exp } from "../index.js";
import { TokenType } from "../src/tokens.js";

// ---------------------------------------------------------------------------
// Dialect family resolution
// ---------------------------------------------------------------------------

const DIALECT_FAMILY = new Map([
  ["postgres", "postgres"], ["redshift", "postgres"], ["materialize", "postgres"], ["risingwave", "postgres"],
  ["hive", "databricks"], ["spark2", "databricks"], ["spark", "databricks"], ["databricks", "databricks"],
  ["snowflake", "snowflake"],
  ["mysql", "mysql"], ["singlestore", "mysql"], ["starrocks", "mysql"], ["doris", "mysql"],
  ["tsql", "tsql"],
]);

function familyOf(dialectName) {
  return DIALECT_FAMILY.get(String(dialectName ?? "").toLowerCase()) ?? "generic";
}

// ---------------------------------------------------------------------------
// AST text-extraction helpers (same semantics as contrib/gatewaySqlMetadata.js's
// identText/qualifiedColumnKey/valueText, reimplemented standalone here — the two
// modules deliberately do not depend on each other, see the design doc's
// "Relationship to gatewaySqlMetadata.js").
// ---------------------------------------------------------------------------

// Unwraps nested Expr layers (Identifier, Parameter{this: Identifier}, a plain
// Var, ...) down to the raw string/number underneath, or returns a non-Expr
// value (already a string) unchanged.
function identText(node) {
  if (node == null) return null;
  if (!(node instanceof exp.Expr)) return node;
  const inner = node.args.this;
  return inner instanceof exp.Expr ? identText(inner) : (inner ?? null);
}

// Dotted-key join for a (possibly qualified) Column node — "spark.sql.session.timeZone"
// stays intact rather than collapsing to just "timeZone", matching
// gatewaySqlMetadata.test.mjs's verified dotted-key expectation.
function qualifiedKey(node) {
  if (node instanceof exp.Column) {
    const parts = [identText(node.args.catalog), identText(node.args.db), identText(node.args.table), identText(node.args.this)];
    return parts.filter((p) => p !== null && p !== undefined).join(".");
  }
  return identText(node);
}

// Decodes a SET/ALTER SESSION value node to its plain text. Handles the
// Spark-family `'o''brien'` → Concat-of-two-Literals tokenizer artifact
// documented in contrib/README.md ("'o''brien'-style doubled-quote escaping is
// not decoded on Databricks") by rejoining with a single `'`.
function valueText(node) {
  if (node == null) return null;
  if (node instanceof exp.Concat) {
    const parts = node.args.expressions ?? [];
    if (parts.length && parts.every((p) => p instanceof exp.Literal && p.args.is_string)) {
      return parts.map((p) => String(p.args.this)).join("'");
    }
    return null;
  }
  const text = node instanceof exp.Column ? qualifiedKey(node) : identText(node);
  return text === null || text === undefined ? null : String(text);
}

// A Command node's remainder is either a plain string (`_parse_as_command`) or
// an Expr wrapping the raw text, e.g. a Literal (the generic unsupported-syntax
// fallback path, confirmed directly: `RESET ALL`'s expression is a Literal, not
// a string, while `_parse_set`'s own `_parse_as_command(this._prev)` call for a
// malformed `SET` statement produces a plain string) — normalize both to a
// trimmed string.
function commandRawText(root) {
  const e = root.args.expression;
  const text = typeof e === "string" ? e : identText(e);
  return text === null || text === undefined ? "" : String(text).trim();
}

function isResetSentinel(valueRaw) {
  return valueRaw != null && /^(?:none|default)$/i.test(String(valueRaw).trim());
}

// Character-offset span extraction (same technique as contrib/sqlIdentity.js's
// fallbackSqlIdentity): node.meta.start/end are code-point offsets attached by
// the parser's `this.expression(...)` wrapper. Falls back to the whole input
// when a node has no position metadata (synthetic/unparented nodes).
function spanText(sql, node) {
  const start = node?.meta?.start;
  const end = node?.meta?.end;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return sql.trim();
  return Array.from(sql).slice(start, end + 1).join("").trim();
}

function sliceChars(sql, start, end) {
  return Array.from(sql).slice(start, end + 1).join("");
}

// R123: statement roots (`Set`, `Select`, ...) carry no `meta.start/end` of
// their own, so `spanText` used to fall back to the WHOLE input for every
// non-Command root the moment a batch held more than one statement — i.e.
// `Effect.statementText` for `SET search_path = a; SELECT 1` was the full
// batch, twice. The tokenizer already knows every statement boundary: a
// top-level `;` is always its own SEMICOLON token (a `;` inside a string,
// quoted identifier or dollar-quote never is), and token `start`/`end` are
// code-point offsets like `meta.start/end`. One tokenize pass per `classify()`
// yields one span per statement, aligned 1:1 and in order with the parsed
// roots (both skip empty statements); when the counts disagree for any reason
// the spans are simply not used and the old fallback applies.
function statementSpans(sql, d) {
  let tokens;
  try {
    tokens = d.tokenize(sql);
  } catch {
    return null;
  }
  const spans = [];
  let current = [];
  for (const token of tokens) {
    if (token.token_type === TokenType.SEMICOLON) {
      if (current.length) spans.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length) spans.push(current);
  return spans.map((ts) => ({ tokens: ts, start: ts[0].start, end: ts[ts.length - 1].end }));
}

function statementTextOf(sql, root, span) {
  if (root instanceof exp.Command) {
    const kw = typeof root.args.this === "string" ? root.args.this : identText(root.args.this) ?? "";
    const rest = commandRawText(root);
    return `${kw} ${rest}`.trim();
  }
  if (span && !Number.isInteger(root?.meta?.start)) return sliceChars(sql, span.start, span.end).trim();
  return spanText(sql, root);
}

// R123: the source text of a `SET key = value` / `SET key TO value` value,
// quotes intact, for the natural `Set`-node grammar path. The parser decodes
// the value node (`"A"` and `A` both become Var("A"); `'x'` becomes
// Literal("x")), which is right for `Effect.value` but wrong for
// `Effect.valueRaw`, whose contract is "as written" — and whose quoting is
// load-bearing for Postgres' search_path LABEL (`= A` and `= "A"` resolve to
// different schemas, see apply()). Reads from the statement's own token span:
// everything after the first `=`/`TO` up to the first depth-0 comma (a `Set`
// may carry several items; this module reports the first) or the span's end.
function rawSetValue(sql, span, valueNode) {
  if (Number.isInteger(valueNode?.meta?.start) && Number.isInteger(valueNode?.meta?.end)) {
    return sliceChars(sql, valueNode.meta.start, valueNode.meta.end).trim();
  }
  if (!span) return null;
  const tokens = span.tokens;
  const sep = tokens.findIndex(
    (t, i) => i > 0 && (t.token_type === TokenType.EQ || String(t.text).toUpperCase() === "TO")
  );
  if (sep === -1 || sep === tokens.length - 1) return null;
  let depth = 0;
  let last = tokens.length - 1;
  for (let i = sep + 1; i < tokens.length; i++) {
    const tt = tokens[i].token_type;
    if (tt === TokenType.L_PAREN) depth++;
    else if (tt === TokenType.R_PAREN) depth--;
    else if (tt === TokenType.COMMA && depth === 0) {
      last = i - 1;
      break;
    }
  }
  return sliceChars(sql, tokens[sep + 1].start, tokens[last].end).trim();
}

// ---------------------------------------------------------------------------
// Effect construction
// ---------------------------------------------------------------------------

function makeEffect(dialectName, statementText, partial) {
  return {
    dialect: dialectName,
    statementText,
    scope: "session",
    kind: "none",
    key: null,
    valueRaw: null,
    value: null,
    parts: null,
    affectsResolution: false,
    affectsResults: false,
    replayable: false,
    unknownReason: null,
    ...partial,
  };
}

function unknownEffect(dialectName, statementText, reason) {
  return makeEffect(dialectName, statementText, {
    kind: "unknown",
    affectsResolution: true,
    affectsResults: true,
    replayable: false,
    unknownReason: reason,
  });
}

function noneEffect(dialectName, statementText) {
  return makeEffect(dialectName, statementText, {});
}

// ---------------------------------------------------------------------------
// Per-dialect key tables (DATA — see docs/proposals/session-state-module.md
// "Per-dialect tables" for the full rationale behind every row).
// ---------------------------------------------------------------------------

function row(canonical, kind, affectsResolution, affectsResults, replayable = true) {
  return { canonical, kind, affectsResolution, affectsResults, replayable };
}

const POSTGRES_KEYS = new Map([
  ["search_path", row("search_path", "set", true, true)],
  ["schema", row("search_path", "set", true, true)], // SET SCHEMA 'x' is an alias for SET search_path TO 'x'
  ["role", row("role", "role", true, true)],
  ["session_authorization", row("session_authorization", "auth", true, true)],
  ["session authorization", row("session_authorization", "auth", true, true)],
  ["timezone", row("timezone", "set", false, true)],
]);

const GENERIC_USE_KIND_MAP = new Map([
  ["CATALOG", "catalog"],
  ["DATABASE", "schema"], // Databricks: DATABASE is a legacy synonym for SCHEMA, not CATALOG
  ["SCHEMA", "schema"],
  ["ROLE", "role"],
  ["WAREHOUSE", "warehouse"],
]);

const SNOWFLAKE_USE_KIND_MAP = new Map([
  ["CATALOG", "catalog"],
  ["DATABASE", "catalog"], // Snowflake: DATABASE is the top-level container (no separate catalog concept)
  ["SCHEMA", "schema"],
  ["ROLE", "role"],
  ["WAREHOUSE", "warehouse"],
]);

const USE_KEY_METADATA = new Map([
  ["catalog", { affectsResolution: true, affectsResults: true }],
  ["schema", { affectsResolution: true, affectsResults: true }],
  ["role", { affectsResolution: true, affectsResults: true }],
  ["warehouse", { affectsResolution: false, affectsResults: true }],
]);

// ---------------------------------------------------------------------------
// SetItem classification — shared across every dialect: SetItem's shape only
// varies in a few well-understood ways (plain EQ key=value; MySQL's NAMES form;
// Snowflake ALTER SESSION UNSET's bare-identifier form), never per dialect
// beyond which key TABLE looks up canonical names.
// ---------------------------------------------------------------------------

function scopeFromSetItemKind(kind) {
  if (kind === "LOCAL") return "local";
  if (kind === "GLOBAL") return "global";
  return "session";
}

function classifySetItem(item, family, dialectName, statementText, sql = null, span = null) {
  const itemKind = item.args.kind ?? null;

  if (itemKind === "TRANSACTION") {
    const value = (item.args.expressions ?? []).map((e) => identText(e) ?? e).join(" ");
    return makeEffect(dialectName, statementText, {
      scope: "transaction",
      kind: "transaction",
      key: "isolation_level",
      valueRaw: value,
      value,
      affectsResolution: false,
      affectsResults: true,
      replayable: false,
    });
  }

  if (itemKind === "NAMES") {
    const value = valueText(item.args.this);
    return makeEffect(dialectName, statementText, {
      scope: scopeFromSetItemKind(null),
      kind: "set",
      key: "names",
      valueRaw: value,
      value,
      affectsResolution: false,
      affectsResults: true,
      replayable: true,
    });
  }

  const eq = item.args.this;
  const scope = scopeFromSetItemKind(itemKind);

  if (!(eq instanceof exp.EQ)) {
    // Snowflake `ALTER SESSION UNSET <name>` shape: SetItem{this: Identifier}.
    const rawKey = qualifiedKey(eq);
    if (!rawKey) return null;
    return resolveKeyEffect(family, dialectName, statementText, rawKey, null, scope, "reset");
  }

  const rawKey = qualifiedKey(eq.args.this);
  if (!rawKey) return null;
  const value = valueText(eq.args.expression);
  const valueRaw = (sql !== null ? rawSetValue(sql, span, eq.args.expression) : null) ?? value;
  return resolveKeyEffect(family, dialectName, statementText, rawKey, valueRaw, scope, "set", value);
}

function resolveKeyEffect(family, dialectName, statementText, rawKey, valueRaw, scope, defaultKind, value = valueRaw) {
  const table = family === "postgres" ? POSTGRES_KEYS : null;
  const meta = table?.get(rawKey.toLowerCase());
  const canonical = meta?.canonical ?? rawKey;
  const resetTarget = meta?.canonical === "search_path" || meta?.canonical === "role" || meta?.canonical === "session_authorization";
  const isReset = defaultKind === "reset" || (resetTarget && isResetSentinel(value));
  const kind = isReset ? "reset" : (meta?.kind ?? defaultKind);

  return makeEffect(dialectName, statementText, {
    scope,
    kind: isReset ? "reset" : kind,
    key: canonical,
    valueRaw,
    value,
    affectsResolution: meta?.affectsResolution ?? false,
    affectsResults: meta?.affectsResults ?? true,
    replayable: scope !== "local",
  });
}

function classifySet(root, family, dialectName, statementText, sql = null, span = null) {
  const items = root.args.expressions ?? [];
  if (items.length === 0) {
    return makeEffect(dialectName, statementText, { kind: "read" });
  }
  // A real `Set` node can carry several comma-separated items (`SET a = 1, b = 2`);
  // this module reports the first one, same scoping gatewaySqlMetadata.js's own
  // extractSessionStateChange already uses for its single-Effect `sessionStateChange`
  // shape — a caller needing every item can walk `root.args.expressions` itself.
  return classifySetItem(items[0], family, dialectName, statementText, sql, span) ?? noneEffect(dialectName, statementText);
}

function classifyAlterSession(alterSessionNode, family, dialectName, statementText, sql = null, span = null) {
  const items = alterSessionNode.args.expressions ?? [];
  if (items.length === 0) return noneEffect(dialectName, statementText);
  if (alterSessionNode.args.unset) {
    const rawKey = qualifiedKey(items[0].args.this);
    if (!rawKey) return noneEffect(dialectName, statementText);
    return makeEffect(dialectName, statementText, {
      kind: "reset",
      key: rawKey,
      affectsResolution: false,
      affectsResults: true,
      replayable: true,
    });
  }
  return classifySetItem(items[0], family, dialectName, statementText, sql, span) ?? noneEffect(dialectName, statementText);
}

function classifyUse(root, family, dialectName, statementText) {
  const kindText = identText(root.args.kind)?.toUpperCase?.() ?? null;
  const table = root.args.this;
  const primary = identText(table?.args?.this);
  const secondary = identText(table?.args?.db);
  const kindMap = family === "snowflake" ? SNOWFLAKE_USE_KIND_MAP : GENERIC_USE_KIND_MAP;

  if (kindText && kindMap.has(kindText)) {
    const key = kindMap.get(kindText);
    const meta = USE_KEY_METADATA.get(key) ?? { affectsResolution: false, affectsResults: true };
    return makeEffect(dialectName, statementText, {
      kind: key === "role" ? "role" : "use",
      key,
      valueRaw: primary,
      value: primary,
      affectsResolution: meta.affectsResolution,
      affectsResults: meta.affectsResults,
      replayable: true,
    });
  }

  // Unqualified USE (no USABLES keyword): one-part switches schema, two-part
  // switches catalog+schema together (Databricks `USE main.sales`).
  if (secondary) {
    const joined = `${secondary}.${primary}`;
    // R2373.3: `parts` carries catalog/schema already split by the real
    // parser (quoting intact per-part — `` USE `a.b`.c `` yields
    // catalog="a.b", schema="c"), so apply() never has to re-split
    // `value`/`valueRaw` on "." itself, which would mis-split a part that
    // legitimately contains a literal dot. `value`/`valueRaw` stay the
    // joined `catalog.schema` text for callers that only look at those
    // (e.g. the gateway's own hand-built namespace Effects, which have
    // never set `parts` and must keep splitting on "." — see apply()).
    return makeEffect(dialectName, statementText, {
      kind: "use",
      key: "namespace",
      value: joined,
      valueRaw: joined,
      parts: { catalog: secondary, schema: primary },
      affectsResolution: true,
      affectsResults: true,
      replayable: true,
    });
  }
  return makeEffect(dialectName, statementText, {
    kind: "use",
    key: "schema",
    value: primary,
    valueRaw: primary,
    affectsResolution: true,
    affectsResults: true,
    replayable: true,
  });
}

function classifyDeclare(root, dialectName, statementText) {
  const items = root.args.expressions ?? [];
  if (items.length === 0) return noneEffect(dialectName, statementText);
  const item = items[0];
  const key = identText(item.args.this);
  if (!key) return noneEffect(dialectName, statementText);
  const value = item.args.default ? valueText(item.args.default) : null;
  return makeEffect(dialectName, statementText, {
    kind: "variable",
    key,
    valueRaw: value,
    value,
    affectsResolution: false,
    affectsResults: true,
    replayable: true,
  });
}

function classifyTransaction(root, dialectName, statementText) {
  return makeEffect(dialectName, statementText, {
    scope: "transaction",
    kind: "transaction",
    key: "begin",
    affectsResolution: false,
    affectsResults: false,
    replayable: false,
  });
}

function classifyCommit(root, dialectName, statementText) {
  return makeEffect(dialectName, statementText, {
    scope: "transaction",
    kind: "transaction",
    key: "commit",
    affectsResolution: false,
    affectsResults: false,
    replayable: false,
  });
}

function classifyRollback(root, dialectName, statementText) {
  const savepoint = identText(root.args.savepoint);
  return makeEffect(dialectName, statementText, {
    scope: "transaction",
    kind: "transaction",
    key: savepoint ? "rollback_to_savepoint" : "rollback",
    value: savepoint,
    valueRaw: savepoint,
    affectsResolution: false,
    affectsResults: false,
    replayable: false,
  });
}

// ---------------------------------------------------------------------------
// Command-fallback readers — token-level via the dialect's own tokenizer, never
// a regex over `Command.args.expression`'s raw text. See the design doc's
// "Fallback readers" section for the per-form rationale.
// ---------------------------------------------------------------------------

function tokenizeRemainder(d, text) {
  try {
    return d.tokenize(text);
  } catch {
    return [];
  }
}

function postgresResetReader(root, d, dialectName, statementText) {
  const remainder = commandRawText(root);
  const tokens = tokenizeRemainder(d, remainder).filter((t) => t.token_type !== TokenType.SEMICOLON);
  const first = tokens[0]?.text?.toUpperCase?.() ?? "";

  if (first === "ALL") {
    return makeEffect(dialectName, statementText, {
      kind: "reset", key: "search_path",
      affectsResolution: true, affectsResults: true, replayable: true,
    });
  }
  if (first === "ROLE") {
    return makeEffect(dialectName, statementText, {
      kind: "reset", key: "role",
      affectsResolution: true, affectsResults: true, replayable: true,
    });
  }
  if (first === "SESSION" && tokens[1]?.text?.toUpperCase?.() === "AUTHORIZATION") {
    return makeEffect(dialectName, statementText, {
      kind: "reset", key: "session_authorization",
      affectsResolution: true, affectsResults: true, replayable: true,
    });
  }
  if (first === "SEARCH_PATH") {
    return makeEffect(dialectName, statementText, {
      kind: "reset", key: "search_path",
      affectsResolution: true, affectsResults: true, replayable: true,
    });
  }
  if (!first) return noneEffect(dialectName, statementText);
  // Any other bare name: RESET <guc> returns one session config to its default.
  return makeEffect(dialectName, statementText, {
    kind: "reset", key: tokens[0].text,
    affectsResolution: false, affectsResults: true, replayable: true,
  });
}

function postgresSetCommandReader(root, d, dialectName, statementText) {
  const remainder = commandRawText(root);
  const tokens = tokenizeRemainder(d, remainder).filter((t) => t.token_type !== TokenType.SEMICOLON);
  if (tokens.length === 0) return noneEffect(dialectName, statementText);

  let i = 0;
  // Optional SESSION|LOCAL prefix — SET LOCAL is never cached from, so it's
  // scoped "local" and ignored by apply() regardless of the key underneath.
  let scope = "session";
  const head = tokens[i]?.text?.toUpperCase?.();
  // A leading "SESSION" is only the SESSION-scope prefix (`SET SESSION name =
  // val`) when it is NOT the start of the two-word "SESSION AUTHORIZATION" GUC
  // name itself — `SET SESSION AUTHORIZATION bob` has no separate scope prefix.
  if (head === "SESSION" && tokens[i + 1]?.text?.toUpperCase?.() !== "AUTHORIZATION") { i += 1; }
  else if (head === "LOCAL") { scope = "local"; i += 1; }

  const kw = tokens[i]?.text?.toUpperCase?.();

  if (kw === "SCHEMA") {
    const valueToken = tokens[i + 1];
    const valueRaw = valueToken ? remainder.slice(valueToken.start).trim() : null;
    return makeEffect(dialectName, statementText, {
      scope, kind: "set", key: "search_path", valueRaw, value: valueRaw,
      affectsResolution: true, affectsResults: true, replayable: scope !== "local",
    });
  }
  if (kw === "SEARCH_PATH") {
    // The list form: `search_path (TO|=) a, b, ...`. The Postgres cache-key
    // LABEL convention is the statement's own raw text after the keyword
    // (SearchPathTracker's own "the label comes from the raw statement text,
    // never the parser's value" rule) — not a decoded/re-joined list. A
    // delimiter is REQUIRED here: `SET search_path FROM CURRENT` is a real,
    // distinct Postgres form this reader does not understand (matching
    // SearchPathTracker's own "FROM CURRENT is not readable" → unknown), not
    // a value to report as-is.
    const delimiterToken = tokens[i + 1];
    const isDelimiter = delimiterToken?.text?.toUpperCase?.() === "TO" || delimiterToken?.token_type === TokenType.EQ;
    if (!isDelimiter) return unknownEffect(dialectName, statementText, "unrecognized-search-path-form");
    const valueToken = tokens[i + 2];
    const valueRaw = valueToken ? remainder.slice(valueToken.start).trim() : null;
    return makeEffect(dialectName, statementText, {
      scope, kind: "set", key: "search_path", valueRaw, value: valueRaw,
      affectsResolution: true, affectsResults: true, replayable: scope !== "local",
    });
  }
  // `SET [SESSION|LOCAL] ROLE role_name` — real Postgres grammar for this form
  // takes NO `=`/`TO` delimiter at all, so it always misses the base parser's
  // SET_REQUIRES_ASSIGNMENT_DELIMITER and falls back to this Command, even
  // outside any list/batch shape (verified directly, matches the AIR-2360
  // probe's "Command fallback: ... SET ROLE" row).
  if (kw === "ROLE") {
    const valueToken = tokens[i + 1];
    const valueRaw = valueToken ? remainder.slice(valueToken.start).trim() : null;
    const isReset = isResetSentinel(valueRaw);
    return makeEffect(dialectName, statementText, {
      scope, kind: isReset ? "reset" : "role", key: "role", valueRaw, value: valueRaw,
      affectsResolution: true, affectsResults: true, replayable: scope !== "local",
    });
  }
  // `SET [SESSION|LOCAL] SESSION AUTHORIZATION user` / `... session_authorization user`
  // — same no-delimiter grammar as ROLE above. Both spellings are real Postgres
  // syntax for the identical GUC (SearchPathTracker's own regex matches both
  // `session\s+authorization` and `session_authorization`).
  if (kw === "SESSION" && tokens[i + 1]?.text?.toUpperCase?.() === "AUTHORIZATION") {
    const valueToken = tokens[i + 2];
    const valueRaw = valueToken ? remainder.slice(valueToken.start).trim() : null;
    const isReset = isResetSentinel(valueRaw);
    return makeEffect(dialectName, statementText, {
      scope, kind: isReset ? "reset" : "auth", key: "session_authorization", valueRaw, value: valueRaw,
      affectsResolution: true, affectsResults: true, replayable: scope !== "local",
    });
  }
  if (kw === "SESSION_AUTHORIZATION") {
    const valueToken = tokens[i + 1];
    const valueRaw = valueToken ? remainder.slice(valueToken.start).trim() : null;
    const isReset = isResetSentinel(valueRaw);
    return makeEffect(dialectName, statementText, {
      scope, kind: isReset ? "reset" : "auth", key: "session_authorization", valueRaw, value: valueRaw,
      affectsResolution: true, affectsResults: true, replayable: scope !== "local",
    });
  }
  return noneEffect(dialectName, statementText);
}

function postgresDiscardMisparseTarget(root) {
  // `DISCARD ALL` (and DISCARD PLANS/SEQUENCES/TEMP/TEMPORARY) misparse as
  // `exp.Alias{this: exp.Column{this: Identifier("DISCARD")}, alias: Identifier(target)}`
  // — DISCARD is not a keyword in this port's tokenizer (confirmed absent from
  // src/tokens.js KEYWORDS), so it reads as a plain identifier aliased by the
  // next word. Upstream-faithful; verified directly against pinned CPython too.
  if (!(root instanceof exp.Alias)) return null;
  const base = root.args.this;
  const name = base instanceof exp.Column ? identText(base.args.this) : identText(base);
  if (typeof name !== "string" || name.toLowerCase() !== "discard") return null;
  const target = identText(root.args.alias);
  return typeof target === "string" ? target.toUpperCase() : null;
}

function databricksSetCommandReader(root, d, dialectName, statementText) {
  const remainder = commandRawText(root);
  const tokens = tokenizeRemainder(d, remainder).filter((t) => t.token_type !== TokenType.SEMICOLON);
  if (tokens.length === 0) return noneEffect(dialectName, statementText);

  if (tokens[0]?.text?.toUpperCase?.() === "TIME" && tokens[1]?.text?.toUpperCase?.() === "ZONE") {
    const valueToken = tokens[2];
    const valueRaw = valueToken ? identText_fromLiteralToken(valueToken) : null;
    return makeEffect(dialectName, statementText, {
      kind: "set", key: "timezone", valueRaw, value: valueRaw,
      affectsResolution: false, affectsResults: true, replayable: true,
    });
  }
  if (tokens[0]?.text === "-v" || (tokens[0]?.text === "-" && tokens[1]?.text === "v")) {
    return makeEffect(dialectName, statementText, { kind: "read" });
  }
  return noneEffect(dialectName, statementText);
}

// A raw token doesn't decode string-literal quoting the way a parsed Literal
// node does; reusing the dialect's own tokenizer is still token-level (not a
// text regex), it just means stripping the one layer of quoting the tokenizer
// itself already identified as a STRING token.
function identText_fromLiteralToken(token) {
  if (token.token_type !== TokenType.STRING && token.token_type !== TokenType.VAR) return token.text;
  return token.text;
}

function classifyCommand(root, family, dialectName, statementText, d) {
  const keyword = (typeof root.args.this === "string" ? root.args.this : identText(root.args.this)) ?? "";
  const kw = keyword.toUpperCase();

  if (family === "postgres") {
    if (kw === "DO" || kw === "CALL") {
      return unknownEffect(dialectName, statementText, "opaque-procedural-call");
    }
    if (kw === "RESET") return postgresResetReader(root, d, dialectName, statementText);
    if (kw === "SET") return postgresSetCommandReader(root, d, dialectName, statementText);
  }
  if (family === "databricks" && kw === "SET") {
    return databricksSetCommandReader(root, d, dialectName, statementText);
  }
  if (kw === "DO" || kw === "CALL") {
    return unknownEffect(dialectName, statementText, "opaque-procedural-call");
  }
  return noneEffect(dialectName, statementText);
}

function postgresSetConfigCall(root) {
  for (const node of root.findAll(exp.Anonymous, false)) {
    const name = typeof node.args.this === "string" ? node.args.this : identText(node.args.this);
    if (typeof name === "string" && name.toLowerCase() === "set_config") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Single-statement classification
// ---------------------------------------------------------------------------

function classifyStatement(root, family, dialectName, sql, d, span = null) {
  const statementText = statementTextOf(sql, root, span);

  if (family === "postgres" && postgresSetConfigCall(root)) {
    return unknownEffect(dialectName, statementText, "set_config-call");
  }

  if (root instanceof exp.Use) return classifyUse(root, family, dialectName, statementText);

  if (root instanceof exp.Set) return classifySet(root, family, dialectName, statementText, sql, span);

  if (root instanceof exp.Alter && String(root.args.kind ?? "").toUpperCase() === "SESSION") {
    const action = root.args.actions?.[0];
    if (action instanceof exp.AlterSession) return classifyAlterSession(action, family, dialectName, statementText, sql, span);
    return noneEffect(dialectName, statementText);
  }

  if (root instanceof exp.Transaction) return classifyTransaction(root, dialectName, statementText);
  if (root instanceof exp.Commit) return classifyCommit(root, dialectName, statementText);
  if (root instanceof exp.Rollback) return classifyRollback(root, dialectName, statementText);
  if (root instanceof exp.Declare) return classifyDeclare(root, dialectName, statementText);

  if (root instanceof exp.Command) return classifyCommand(root, family, dialectName, statementText, d);

  if (family === "postgres") {
    const target = postgresDiscardMisparseTarget(root);
    if (target === "ALL") {
      return makeEffect(dialectName, statementText, {
        kind: "discard", key: "all",
        affectsResolution: true, affectsResults: true, replayable: false,
      });
    }
    if (target) return noneEffect(dialectName, statementText);
  }

  if (family === "databricks" && root instanceof exp.Column && !root.args.table && !root.args.db && !root.args.catalog) {
    const name = identText(root.args.this);
    if (typeof name === "string" && name.toUpperCase() === "RESET" && statementText.trim().toUpperCase() === "RESET") {
      return makeEffect(dialectName, statementText, {
        kind: "reset", key: "all",
        affectsResolution: false, affectsResults: true, replayable: false,
      });
    }
  }

  return noneEffect(dialectName, statementText);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {string} sql
 * @param {{dialect?: string|null}} [options]
 * @returns {object[]} one Effect per statement in the (semicolon-separated) batch
 */
export function classify(sql, options = {}) {
  const dialectName = options.dialect ?? null;
  if (typeof sql !== "string" || !sql.trim()) return [];

  const family = familyOf(dialectName);
  const d = Dialect.get_or_raise(dialectName);

  let roots;
  try {
    roots = d.parse(sql).filter((node) => node && !(node instanceof exp.Semicolon));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [unknownEffect(dialectName, sql.trim(), `parse-error: ${msg.split("\n")[0]}`)];
  }

  if (roots.length === 0) return [];
  // Each root is classified independently from its own real AST — unlike the
  // regex tracker this generalizes, batch order never needs to be collapsed
  // into one pessimistic answer (see the design doc's "deliberately more
  // precise" note): statement N's Effect is exactly what statement N did,
  // nothing more conservative.
  const spans = statementSpans(sql, d);
  const aligned = spans && spans.length === roots.length ? spans : null;
  return roots.map((root, i) => classifyStatement(root, family, dialectName, sql, d, aligned?.[i] ?? null));
}

/**
 * The Postgres cache-key LABEL to key a row-data cache on, or `null` when it
 * cannot be trusted right now — a direct generalization of
 * `postgresql.Session.js`'s `effectiveSearchPath()`. `state.searchPath` itself
 * is never masked by a role/auth switch at mutation time (see `apply()`'s
 * "role"/"auth" cases) — only this read-time derivation applies the "while a
 * role or the session user has moved, 'default' and any `$user`-naming path
 * cannot be trusted" rule, exactly like the original.
 * @param {object} state
 * @returns {string|null}
 */
export function effectiveSearchPath(state) {
  if (state.searchPath === null) return null;
  const userMoved = state.roleSwitched || state.authSwitched;
  if (userMoved && (state.searchPath === "default" || /\$user/i.test(state.searchPath))) {
    return null;
  }
  return state.searchPath;
}

/** @param {string|null} [dialect] @returns {object} */
export function createState(dialect = null) {
  return {
    dialect: dialect ?? null,
    searchPath: "default",
    roleSwitched: false,
    authSwitched: false,
    role: null,
    catalog: null,
    schema: null,
    warehouse: null,
    variables: {},
    // R2373.2: the source-quoted counterpart of `variables`, keyed the same
    // way. Only ever populated by apply() for a key it is actively setting
    // in THIS call (from `effect.valueRaw`) — a key carried over from a
    // pre-existing `variables` object built some other way (e.g. a gateway
    // session hydrated straight from persisted storage, see
    // docs/proposals/session-state-module.md) simply has no entry here,
    // which is intentional: render()'s Databricks raw-text renderer treats
    // a missing entry exactly like an absent `valueRaw`, falling back to
    // the legacy quoting rule for that key.
    variablesRaw: {},
    replayLog: [],
  };
}

function rebuildReplayLog(state) {
  const log = [];
  if (state.catalog && state.schema) {
    log.push({ kind: "use_namespace", catalog: state.catalog, schema: state.schema });
  } else {
    if (state.catalog) log.push({ kind: "use_catalog", catalog: state.catalog });
    if (state.schema) log.push({ kind: "use_schema", schema: state.schema });
  }
  if (state.warehouse) log.push({ kind: "use_warehouse", warehouse: state.warehouse });
  if (state.role) log.push({ kind: "use_role", role: state.role });
  for (const key of Object.keys(state.variables)) {
    const entry = { kind: "set", key, value: state.variables[key] };
    // R2373.2: only attach `valueRaw` when this key actually has raw text on
    // file — never a bare `null` manufactured for a key apply() never saw a
    // raw span for (a pre-existing/carried-over variable, see createState).
    // A missing field, not a null one, is what tells render()'s Databricks
    // renderer and the gateway's own legacy-shape readers "fall back".
    if (state.variablesRaw && state.variablesRaw[key] !== undefined) {
      entry.valueRaw = state.variablesRaw[key];
    }
    log.push(entry);
  }
  state.replayLog = log;
}

/**
 * Pure, immediate reducer — see the design doc's "Reducer" section for why
 * this does not model transaction rollback (that stays gateway-side policy).
 * @param {object} state
 * @param {object} effect
 * @returns {object} a new State
 */
export function apply(state, effect) {
  const next = {
    ...state,
    variables: { ...state.variables },
    variablesRaw: { ...state.variablesRaw },
    replayLog: state.replayLog,
  };

  if (effect.scope === "local") return next;

  switch (effect.kind) {
    case "use": {
      if (effect.key === "catalog") next.catalog = effect.value;
      else if (effect.key === "schema") next.schema = effect.value;
      else if (effect.key === "warehouse") next.warehouse = effect.value;
      else if (effect.key === "namespace") {
        // R2373.3: prefer the structured parts classifyUse already split out
        // (quoting intact per-part), falling back to splitting `value` on
        // "." only when a caller built this Effect by hand without them —
        // the gateway's own translateChangeToEffect never sets `parts`, so
        // its existing use_namespace Effects keep working unchanged.
        if (effect.parts) {
          next.catalog = effect.parts.catalog || null;
          next.schema = effect.parts.schema || null;
        } else {
          const [catalog, schema] = String(effect.value ?? ".").split(".");
          next.catalog = catalog || null;
          next.schema = schema || null;
        }
      }
      rebuildReplayLog(next);
      return next;
    }
    case "role": {
      next.role = effect.value;
      next.roleSwitched = true;
      return next;
    }
    case "auth": {
      next.authSwitched = true;
      next.role = null;
      return next;
    }
    case "reset": {
      // R2373.1: the Postgres LABEL/role/auth special cases below are only
      // Postgres GUCs — gate every one of them on family, not just the key
      // name, so a Databricks/Snowflake/etc. variable that happens to be
      // named "search_path" (or "role"/"session_authorization") still goes
      // through the generic delete-the-variable branch like any other key.
      const family = familyOf(state.dialect);
      if (effect.key === "search_path" && family === "postgres") next.searchPath = "default";
      else if (effect.key === "role" && family === "postgres") { next.role = null; next.roleSwitched = false; }
      else if (effect.key === "session_authorization" && family === "postgres") { next.authSwitched = false; next.roleSwitched = false; next.role = null; }
      else if (effect.key === "all") { delete next.variables[effect.key]; delete next.variablesRaw[effect.key]; }
      else if (effect.key) { delete next.variables[effect.key]; delete next.variablesRaw[effect.key]; }
      rebuildReplayLog(next);
      return next;
    }
    case "discard": {
      next.searchPath = "default";
      next.roleSwitched = false;
      next.authSwitched = false;
      next.role = null;
      return next;
    }
    case "set":
    case "variable": {
      // R2373.1: same family gate as the reset branch above — `search_path`
      // is the Postgres cache-key LABEL only on Postgres-family dialects;
      // elsewhere (Databricks, etc.) it is an ordinary session variable and
      // must land in `variables`/`replayLog` like any other key.
      if (effect.key === "search_path" && familyOf(state.dialect) === "postgres") {
        next.searchPath = effect.valueRaw != null ? `path:${effect.valueRaw}` : next.searchPath;
        return next;
      }
      next.variables[effect.key] = effect.value;
      // R2373.2: record the source-quoted form alongside the decoded one so
      // a Databricks-family render() can later emit the client's raw text
      // verbatim instead of re-encoding through a generated string Literal.
      next.variablesRaw[effect.key] = effect.valueRaw ?? null;
      rebuildReplayLog(next);
      return next;
    }
    default:
      return next;
  }
}

// R124 coordinator addendum: identifiers are built with `exp.toIdentifier`,
// which (like upstream `to_identifier`) marks a name that is not a plain
// `[_a-zA-Z]\w*` identifier as quoted — so the structured parts R2373.3
// preserves through apply() survive render() too (`` USE `a.b`.c `` renders
// back as `` USE `a.b`.c ``, not the lossy `USE a.b.c`). Plain names are
// unchanged (`USE CATALOG main`, `USE main.sales`).
const REPLAY_RENDERERS = {
  use_catalog: (entry) => new exp.Use({ kind: exp.var("CATALOG"), this: new exp.Table({ this: exp.toIdentifier(entry.catalog) }) }),
  use_schema: (entry) => new exp.Use({ kind: exp.var("SCHEMA"), this: new exp.Table({ this: exp.toIdentifier(entry.schema) }) }),
  use_namespace: (entry) => new exp.Use({ this: new exp.Table({ this: exp.toIdentifier(entry.schema), db: exp.toIdentifier(entry.catalog) }) }),
  use_warehouse: (entry) => new exp.Use({ kind: exp.var("WAREHOUSE"), this: new exp.Table({ this: exp.toIdentifier(entry.warehouse) }) }),
  use_role: (entry) => new exp.Use({ kind: exp.var("ROLE"), this: new exp.Table({ this: exp.toIdentifier(entry.role) }) }),
  // A real string Literal, not a bare Var — the generator then owns all
  // quoting/escaping for whatever the value actually contains (spaces, quotes,
  // ...), the same real code path every other emitted statement in this
  // project uses, rather than a second hand-rolled quoting routine. NOT used
  // for the Databricks family's own `set` entries — see renderDatabricksSet
  // and R2373.2 below for why that family needs a different renderer.
  set: (entry) => new exp.Set({
    expressions: [new exp.SetItem({ this: new exp.EQ({ this: exp.column(entry.key), expression: new exp.Literal({ this: String(entry.value ?? ""), is_string: true }) }) })],
  }),
};

// R2373.2: the gateway's own pre-AIR-2365 quoting rule
// (OperationCreatingHandler.quoteSetValue), reproduced verbatim as the
// fallback for a `set` entry with no `valueRaw` on file (a key carried over
// from before this field existed, or one a caller built by hand — see
// createState's own doc comment). Bare unless the value contains whitespace,
// a quote, a `;`, or is empty, in which case it is wrapped in single quotes
// with any embedded quote doubled — exactly the shape Spark's own
// `configKeyValueDef` regex (`SqlBaseParser.g4` -> `SparkSqlParser.scala`'s
// `visitSetConfiguration`) needs to read back the same string, since that
// grammar rule has no string-literal syntax of its own to decode.
function quoteDatabricksSetValue(value) {
  const text = value == null ? "" : String(value);
  const needsQuote = /[\s'";]/.test(text) || text === "";
  return needsQuote ? `'${text.replace(/'/g, "''")}'` : text;
}

// R2373.2: Databricks-family `SET k = v` stores the RHS of `=` VERBATIM —
// surrounding quotes are part of the stored value, not literal syntax (see
// this file's header comment and docs/proposals/session-state-module.md's
// "Spark raw-text SET semantics" section for the full grammar citation).
// `entry.valueRaw`, when present, is already exactly that stored text (the
// source span `apply()` copied byte-for-byte from the original statement —
// bare `UTC` stays bare, `'o''brien'` stays `'o''brien'`), so it is emitted
// completely unprocessed: re-running any quoting/escaping logic over an
// already-valid raw value would corrupt it (doubling an apostrophe that was
// already doubled, etc.). Only a `set` entry with NO `valueRaw` at all — the
// decoded-only shape every pre-this-round caller still constructs by hand,
// e.g. the gateway's own translateChangeToEffect — falls back to
// `quoteDatabricksSetValue`, synthesizing valid syntax from the bare decoded
// string the same way the gateway's own quoteSetValue always did. The key
// itself is always emitted bare (never backtick-quoted, unlike a real
// identifier position): `exp.column(key)` here would backtick-quote a
// dotted key like `spark.sql.session.timeZone` as a qualified column
// reference, which is not how this grammar rule reads a config key at all.
function renderDatabricksSet(entry) {
  if (!entry.key) return null;
  const raw = entry.valueRaw != null ? entry.valueRaw : quoteDatabricksSetValue(entry.value);
  return `SET ${entry.key} = ${raw}`;
}

/**
 * @param {object} state
 * @param {{dialect?: string|null}} [options]
 * @returns {string[]}
 */
export function render(state, options = {}) {
  const dialectName = options.dialect ?? state.dialect ?? null;
  const d = Dialect.get_or_raise(dialectName);
  const family = familyOf(dialectName);
  const out = [];
  for (const entry of state.replayLog) {
    if (entry.kind === "set" && family === "databricks") {
      const rendered = renderDatabricksSet(entry);
      if (rendered !== null) out.push(rendered);
      continue;
    }
    const build = REPLAY_RENDERERS[entry.kind];
    if (!build) continue;
    try {
      out.push(d.generate(build(entry), { pretty: false }));
    } catch {
      // A replay entry this module itself produced that the target dialect's
      // generator cannot yet render — skip, mirroring renderReplayStatement's
      // own "malformed → null, caller warns and skips" contract.
    }
  }
  return out;
}
