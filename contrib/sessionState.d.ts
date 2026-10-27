// Type declarations for contrib/sessionState.js. See
// docs/proposals/session-state-module.md for the full design (Effect/State
// schemas, per-dialect tables, fallback readers) and contrib/README.md's
// sibling module gatewaySqlMetadata.js for the project's contrib/ conventions.

type Nullable<T> = T | null;

export type EffectScope = "session" | "local" | "global" | "transaction";

export type EffectKind =
  | "set"
  | "reset"
  | "use"
  | "role"
  | "auth"
  | "discard"
  | "transaction"
  | "variable"
  | "read"
  | "unknown"
  | "none";

export interface Effect {
  dialect: Nullable<string>;
  /** Raw text of just this statement, trimmed. */
  statementText: string;
  scope: EffectScope;
  kind: EffectKind;
  /** Canonical name (search_path/schema/catalog/role/session_authorization/
   * warehouse/timezone/all/isolation_level/begin/commit/rollback/...), the raw
   * variable name, or `null` when not applicable. */
  key: Nullable<string>;
  /** As written in the source (quotes intact), or `null`. */
  valueRaw: Nullable<string>;
  /** Parsed/unquoted value, or `null`. */
  value: Nullable<string>;
  /** Structured USE-namespace parts for a two-part `USE a.b`, populated by
   * `classify()`'s own `classifyUse`. `apply()` prefers these over splitting
   * `value`/`valueRaw` on "." so a part containing a literal dot (e.g.
   * `` USE `a.b`.c ``) is never mis-split. `null` for every other kind/form,
   * including a hand-built `use`/`namespace` Effect that never set it (e.g.
   * the gateway's own `translateChangeToEffect`) — `apply()` falls back to
   * splitting `value` on "." in that case, unchanged from before. */
  parts: Nullable<{ catalog: string; schema: string }>;
  affectsResolution: boolean;
  affectsResults: boolean;
  replayable: boolean;
  unknownReason: Nullable<string>;
}

export interface ClassifyOptions {
  dialect?: Nullable<string>;
}

export interface ReplayEntry {
  kind: "use_catalog" | "use_schema" | "use_namespace" | "use_warehouse" | "use_role" | "set";
  catalog?: string;
  schema?: string;
  warehouse?: string;
  role?: string;
  key?: string;
  value?: Nullable<string>;
  /** As written in the source (quotes intact); present only when `apply()`
   * actually recorded one for this key in the same call that set `value` —
   * absent (not `null`) for a key carried over without one, e.g. hydrated
   * from storage written before this field existed. Consumed verbatim by a
   * Databricks-family `render()` (never re-escaped); every other dialect's
   * `set` rendering still goes through the real generator and ignores it. */
  valueRaw?: Nullable<string>;
}

export interface State {
  dialect: Nullable<string>;
  searchPath: Nullable<string>;
  roleSwitched: boolean;
  authSwitched: boolean;
  role: Nullable<string>;
  catalog: Nullable<string>;
  schema: Nullable<string>;
  warehouse: Nullable<string>;
  variables: Record<string, Nullable<string>>;
  /** The source-quoted counterpart of `variables`, keyed the same way. Only
   * ever populated by `apply()` for a key it actively set in some call on
   * this State — a key present in `variables` through some other path (e.g.
   * a gateway session hydrated straight from persisted storage) may have no
   * entry here at all. See `ReplayEntry.valueRaw`. */
  variablesRaw: Record<string, Nullable<string>>;
  replayLog: ReplayEntry[];
}

export interface RenderOptions {
  dialect?: Nullable<string>;
}

/** Classifies a (possibly semicolon-batched) SQL string into one Effect per
 * statement, from a real parsed AST — never a regex over the raw text. */
export function classify(sql: string, options?: ClassifyOptions): Effect[];

/** A fresh State for a new connection/session on the given dialect. */
export function createState(dialect?: Nullable<string>): State;

/** Pure, immediate reducer — no transaction-rollback modeling (see the design
 * doc's "Reducer" section for why that stays gateway-side policy). */
export function apply(state: State, effect: Effect): State;

/** The Postgres cache-key LABEL to key a row-data cache on, or `null` when it
 * cannot be trusted right now (a generalization of postgresql.Session.js's own
 * `effectiveSearchPath()`). */
export function effectiveSearchPath(state: State): Nullable<string>;

/** Renders `state.replayLog` back to SQL through the real dialect generator. */
export function render(state: State, options?: RenderOptions): string[];
