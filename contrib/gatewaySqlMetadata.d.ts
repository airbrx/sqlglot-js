// Type declarations for contrib/gatewaySqlMetadata.js — the one contrib module with a
// public, documented, consumed export (airbrx-gateway's lib/utils/SqlParser.js). See
// contrib/README.md for the full behavioral contract and docs/stability.md for why the
// other two contrib/*.js files have no declaration file of their own.

type Nullable<T> = T | null;

export interface TableInfo {
  catalog: Nullable<string>;
  schema: Nullable<string>;
  table: Nullable<string>;
  fullyQualifiedName: string;
  operation: string;
}

export interface MutationRecord {
  statementType: string;
  tables: TableInfo[];
}

export interface SessionStateChange {
  kind: "read" | "set" | "alter_session" | "use_catalog" | "use_schema" | "use_namespace";
  key?: string;
  value?: Nullable<string>;
  catalog?: Nullable<string>;
  schema?: Nullable<string>;
}

export interface NonDeterministicResult {
  hasNonDeterministicFunctions: boolean;
  types: string[];
  functions: string[];
}

export interface SqlMetadata {
  statementType: string;
  /** `null` after a parse failure (unknown), not zero statements. */
  statementCount: Nullable<number>;
  mutationTypes: string[];
  mutations: MutationRecord[];
  cacheable: boolean;
  isReadOnly: boolean;
  isSessionStateChange: boolean;
  sessionStateChange: Nullable<SessionStateChange>;
  isFullyQualified: boolean;
  cacheOverride: Nullable<"nocache" | "cache">;
  isDataChange: boolean;
  isDDL: boolean;
  isDCL: boolean;
  isDeltaOperation: boolean;
  tables: TableInfo[];
  tableCount: number;
  catalogs: string[];
  schemas: string[];
  standardizedSql: Nullable<string>;
  originalSql: Nullable<string>;
  hasParameters: boolean;
  parameterNames: string[];
  parameterStyle: Nullable<"named" | "positional" | "numbered">;
  parameterValues: Nullable<Record<string, unknown>>;
  nonDeterministic: NonDeterministicResult;
  extractionError: Nullable<string>;
}

export interface ExtractSqlMetadataOptions {
  /** 'databricks' | 'snowflake' | 'postgres' are the verified-real target dialects (see
   * contrib/README.md); any other sqlglot-js dialect name works to the extent that
   * dialect's own parser/generator is real. Omitting it falls back to the base dialect,
   * same as `Dialect.get_or_raise(null)`. */
  dialect?: Nullable<string>;
  parameterValues?: Nullable<Record<string, unknown>>;
}

/** Extracts cache-key metadata from a SQL string using a real parsed AST
 * (`Dialect.get_or_raise(dialect).parse(sql)`), in a shape compatible with
 * airbrx-gateway's regex-based `lib/utils/SqlParser.js`. Never throws — any parse or
 * extraction failure returns a conservative, non-cacheable safe-default result with
 * `extractionError` set. */
export function extractSqlMetadata(sql: string, options?: ExtractSqlMetadataOptions): SqlMetadata;
