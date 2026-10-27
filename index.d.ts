// Type declarations for sqlglot-js's public surface (the package root, `import { ... }
// from "sqlglot-js"`). Hand-written against the real implementation and docs/api.md, not
// generated — see docs/stability.md for what's public vs internal, and
// test/types/smoke.ts for the exact set of symbols this file is checked against.
//
// sqlglot-js is zero-dependency at runtime; this file (and the `typescript` devDependency
// used only to check it, via `npm run check:types`) adds no runtime dependency.

/** `null`-for-`None` is the port's own convention throughout (docs/api.md's header note). */
type Nullable<T> = T | null;

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

/** `errors.SqlglotError` — the common base. Not itself re-exported; catch via a subclass
 * or `instanceof Error`. */
declare class SqlglotError extends Error {}

/** One structured error detail, as built by `ParseError.new` / consumed by `.errors`. */
export interface ParseErrorDetail {
  description: Nullable<string>;
  line: Nullable<number>;
  col: Nullable<number>;
  start_context: Nullable<string>;
  highlight: Nullable<string>;
  end_context: Nullable<string>;
  into_expression: unknown;
}

/** Thrown by `parse`/`parseOne`/`transpile` on a parse defect (when `errorLevel` allows
 * raising at all). */
export class ParseError extends SqlglotError {
  errors: ParseErrorDetail[];
}

/** Thrown by `tokenize` on a lexing failure (unterminated string, invalid escape). */
export class TokenError extends SqlglotError {
  start: Nullable<number>;
  end: Nullable<number>;
}

/** Thrown when `errorLevel` is `RAISE`/`IMMEDIATE` and a `Generator` has no rendering for
 * a construct on the target dialect. */
export class UnsupportedError extends SqlglotError {}

/** `IGNORE | WARN | RAISE | IMMEDIATE` — uppercase string values, matching upstream's
 * `AutoName` enum. Use these constants rather than a bare lowercase string. */
export const ErrorLevel: {
  readonly IGNORE: "IGNORE";
  readonly WARN: "WARN";
  readonly RAISE: "RAISE";
  readonly IMMEDIATE: "IMMEDIATE";
};
export type ErrorLevelValue = (typeof ErrorLevel)[keyof typeof ErrorLevel];

// ---------------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------------

/** One lexer token, as returned by `tokenize()`. Field names are upstream's own
 * snake_case (`token_type`, not `tokenType`) — see docs/api.md's `tokenize` section for
 * why. Not itself re-exported as a class from the package root; this is the structural
 * shape `tokenize()`'s return array elements have. */
export interface Token {
  /** A `TokenType` enum member (a number) — not itself re-exported today. */
  token_type: number;
  text: string;
  line: number;
  col: number;
  /** Code-point offset into the source SQL, inclusive. */
  start: number;
  /** Code-point offset into the source SQL, inclusive. */
  end: number;
  comments: string[];
}

// ---------------------------------------------------------------------------------------
// The `exp` namespace — the expression tree
// ---------------------------------------------------------------------------------------

/**
 * Base class for every one of the 1,048 generated expression-tree node classes
 * (`Select`, `Column`, `Where`, `Literal`, `Join`, ...). Declared here as a single,
 * deliberately opaque shape covering the methods and properties documented in
 * docs/api.md — a specific subclass (`exp.Select`, `exp.Column`, ...) is NOT individually
 * declared; narrow with `instanceof` as in real code, or cast, same as working with the
 * untyped class today.
 */
export class Expr {
  /** The node's own fields — e.g. a `Select`'s `expressions`/`from_`/`where`. The ground
   * truth; every convenience accessor/method just reads from this. */
  args: Record<string, unknown>;
  /** The parent node, or `undefined` at the tree root. */
  parent?: Expr;
  /** The arg key this node is stored under on its parent (e.g. `"this"`, `"expressions"`). */
  argKey?: string;
  /** Index into the parent's array-valued arg, when the parent stores this node in a list. */
  index?: Nullable<number>;
  comments: Nullable<string[]>;

  /** `this.args.this`, upstream's own `Expression.this` shorthand. */
  readonly this: unknown;
  /** The node's own dispatch key, e.g. `"select"` for a `Select`. */
  readonly key: string;
  /** Distance from the tree root (0 at the root). */
  readonly depth: number;

  constructor(args?: Record<string, unknown>, options?: unknown);

  /** Depth-first or breadth-first iterator over this node and every descendant. */
  walk(bfs?: boolean, prune?: (node: Expr) => boolean): IterableIterator<Expr>;
  /** First descendant (including self) that is an instance of any of `types`. The last
   * argument may be a boolean to select BFS (default) vs DFS. */
  find<T extends Expr>(...types: Array<(new (...args: any[]) => T) | boolean>): Nullable<T>;
  /** Every descendant (including self) that is an instance of any of `types`. */
  findAll<T extends Expr>(
    ...types: Array<(new (...args: any[]) => T) | boolean>
  ): IterableIterator<T>;
  /** Nearest ancestor that is an instance of any of `types`. */
  findAncestor<T extends Expr>(...types: Array<new (...args: any[]) => T>): Nullable<T>;
  /** The tree root (walks up through every `parent`). */
  root(): Expr;
  /** Structural equality (same class, same hash). */
  equals(other: unknown): boolean;
  /** A stable 64-bit structural hash (used internally for CTE/subquery dedup). */
  hash(): bigint;
  /** Deep copy, Python `deepcopy`-equivalent. */
  copy(): this;
  /** Replaces this node in its parent with `v` (or removes it if `v` is `null`). */
  replace(v: Nullable<Expr>): Nullable<Expr>;
  /** Equivalent to `replace(null)`. */
  pop(): this;
  /** Serializes to SQL. Pass a dialect name as the first positional argument to generate
   * under a specific one, matching upstream's own `expr.sql(dialect="postgres")` shape. */
  sql(dialect?: Nullable<string | Dialect>, options?: Record<string, unknown>): string;
  /** A plain-object/array dump of this node's AST shape (round-trippable). */
  dump(): unknown;

  and_(...expressions: Array<Expr | string>): Expr;
  or_(...expressions: Array<Expr | string>): Expr;
  not_(copy?: boolean): Expr;
  as_(alias: string | Expr, options?: Record<string, unknown>): Expr;
  eq(x: unknown): Expr;
  neq(x: unknown): Expr;
  is_(x: unknown): Expr;
  like(x: unknown): Expr;
  ilike(x: unknown): Expr;
  rlike(x: unknown): Expr;
  lt(x: unknown): Expr;
  lte(x: unknown): Expr;
  gt(x: unknown): Expr;
  gte(x: unknown): Expr;
  add(x: unknown): Expr;
  sub(x: unknown): Expr;
  mul(x: unknown): Expr;
  div(x: unknown, typed?: boolean, safe?: boolean): Expr;
  mod(x: unknown): Expr;
  pow(x: unknown): Expr;
  and(x: unknown): Expr;
  or(x: unknown): Expr;
  neg(): Expr;
  asc(nullsFirst?: boolean): Expr;
  desc(nullsFirst?: boolean): Expr;
  isin(...expressions: unknown[]): Expr;
  between(low: unknown, high: unknown, options?: { copy?: boolean; symmetric?: boolean }): Expr;
  bracket(...expressions: unknown[]): Expr;

  /** Fallback for every other method/property on a concrete subclass this base
   * declaration does not name individually (e.g. `exp.Select`'s own `.from_()`,
   * `.where()`, `.group_by()` fluent builders). */
  [key: string]: any;
}

/** Edit-script node from `diff()`. */
export class Insert {
  expression: Expr;
  constructor(expression: Expr);
}
export class Remove {
  expression: Expr;
  constructor(expression: Expr);
}
export class Move {
  source: Expr;
  target: Expr;
  constructor(source: Expr, target: Expr);
}
export class Update {
  source: Expr;
  target: Expr;
  constructor(source: Expr, target: Expr);
}
export class Keep {
  source: Expr;
  target: Expr;
  constructor(source: Expr, target: Expr);
}

interface ExpNamespace {
  Expr: typeof Expr;

  // Builder functions documented in docs/api.md and docs/getting-started.md — the
  // ergonomic path for constructing a tree without SQL text. Each returns (or operates
  // over) `Expr`; the exact subclass is intentionally untyped here, same rationale as
  // `Expr`'s own index-signature escape hatch above.
  select(...expressions: Array<string | Expr>): Expr;
  from_(expression: string | Expr, options?: Record<string, unknown>): Expr;
  column(
    col: string | Expr,
    table?: Nullable<string | Expr>,
    db?: Nullable<string | Expr>,
    catalog?: Nullable<string | Expr>,
    options?: Record<string, unknown>,
  ): Expr;
  cast(expression: string | Expr, to: string | Expr, options?: Record<string, unknown>): Expr;
  table_(table: string | Expr, options?: Record<string, unknown>): Expr;
  subquery(
    expression: string | Expr,
    alias?: Nullable<string | Expr>,
    options?: Record<string, unknown>,
  ): Expr;
  values(rows: unknown[][], options?: Record<string, unknown>): Expr;
  insert(expression: string | Expr, into: string | Expr, options?: Record<string, unknown>): Expr;
  update(table: string | Expr, properties?: Nullable<Record<string, unknown>>, options?: Record<string, unknown>): Expr;
  delete_(table: string | Expr, options?: Record<string, unknown>): Expr;
  merge(...whenExprs: Array<string | Expr>): Expr;
  and_(...expressions: Array<string | Expr>): Expr;
  or_(...expressions: Array<string | Expr>): Expr;
  not_(expression: string | Expr, options?: Record<string, unknown>): Expr;
  xor(...expressions: Array<string | Expr>): Expr;
  alias_(expression: string | Expr, alias: string | Expr, options?: Record<string, unknown>): Expr;
  toIdentifier(name: Nullable<string>, quoted?: Nullable<boolean>, copy?: boolean): Expr;
  toColumn(sqlPath: string, options?: Record<string, unknown>): Expr;
  toTable(sqlPath: string, options?: Record<string, unknown>): Expr;
  func(name: string, ...args: unknown[]): Expr;
  case_(expression?: Nullable<string | Expr>, options?: Record<string, unknown>): Expr;
  array(...expressions: Array<string | Expr>): Expr;
  tuple_(...expressions: Array<string | Expr>): Expr;

  /** Every one of the 1,048 generated node classes (`exp.Select`, `exp.Column`, ...), plus
   * module-level constants (`EXPR_META`, `TRAITS`, `EXPR_CLASSES`, `ALL_FUNCTIONS`, ...) —
   * not individually declared; see docs/stability.md's Tier-2 note on
   * `sqlglot-js/expressions/index`. */
  [name: string]: any;
}

export const exp: ExpNamespace;

// ---------------------------------------------------------------------------------------
// Dialect / parse / parseOne / transpile / tokenize
// ---------------------------------------------------------------------------------------

/** A dialect's settings + the `Tokenizer`/`Parser`/`Generator` classes it resolves to.
 * `Dialect.get_or_raise(name)` is the actual by-name registry every top-level function
 * below wraps. Per-dialect settings (`NULL_ORDERING`, `TIME_MAPPING`, ...) are not
 * individually declared — see docs/stability.md's Tier-2 note on `sqlglot-js/dialects/*`. */
export class Dialect {
  /** Resolves a dialect by name (any of the 33 ported dialects), by instance (returned
   * as-is), by `Dialect` subclass (instantiated), or `null`/`undefined`/`""` (the base
   * dialect). Throws for an unrecognized name. */
  static get_or_raise(dialect?: Nullable<string | Dialect | (new () => Dialect)>): Dialect;

  parse(sql: string, options?: { into?: unknown; errorLevel?: ErrorLevelValue | null }): Array<Nullable<Expr>>;
  parse_into(expressionType: unknown, sql: string, options?: Record<string, unknown>): unknown;
  generate(expression: Expr, options?: { copy?: boolean } & Record<string, unknown>): string;
  transpile(sql: string, options?: Record<string, unknown>): string[];
  tokenize(sql: string, dialect?: Nullable<Dialect>): Token[];
  format_time(expression: unknown): Nullable<string>;
  equals(other: unknown): boolean;
  hash(): unknown;

  [key: string]: any;
}

export function parse(
  sql: string,
  options?: { read?: Nullable<string>; dialect?: Nullable<string>; errorLevel?: Nullable<ErrorLevelValue> },
): Array<Nullable<Expr>>;

export function parseOne(
  sql: string,
  options?: {
    read?: Nullable<string>;
    dialect?: Nullable<string>;
    into?: unknown;
    errorLevel?: Nullable<ErrorLevelValue>;
  },
): Expr;

export function transpile(
  sql: string,
  options?: {
    read?: Nullable<string>;
    write?: Nullable<string>;
    identity?: boolean;
    errorLevel?: Nullable<ErrorLevelValue>;
  },
): string[];

export function tokenize(
  sql: string,
  options?: { read?: Nullable<string>; dialect?: Nullable<string> },
): Token[];

// ---------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------

/** `sqlglot.schema.Schema` — the abstract interface `MappingSchema` implements. */
export class Schema {
  addTable(
    table: unknown,
    columnMapping?: unknown,
    dialect?: Nullable<string | Dialect>,
    normalize?: Nullable<boolean>,
    matchDepth?: boolean,
  ): unknown;
  columnNames(table: unknown, onlyVisible?: boolean, dialect?: Nullable<string | Dialect>, normalize?: Nullable<boolean>): string[];
  getColumnType(table: unknown, column: unknown, dialect?: Nullable<string | Dialect>, normalize?: Nullable<boolean>): unknown;
  hasColumn(table: unknown, column: unknown, dialect?: Nullable<string | Dialect>, normalize?: Nullable<boolean>): boolean;
  getUdfType(udf: unknown, dialect?: Nullable<string | Dialect>, normalize?: Nullable<boolean>): unknown;
}

/** A nested `{table: {column: type}}` (or `{db: {...}}` / `{catalog: {db: {...}}}`)
 * mapping, keyed as either plain objects/arrays or `Map`s — see docs/api.md's `Schema`
 * section for the `normalize`/`Map`-vs-plain-object note. */
export type SchemaMapping = Record<string, unknown> | Map<string, unknown>;

export class MappingSchema extends Schema {
  constructor(
    schema?: Nullable<SchemaMapping>,
    visible?: Nullable<SchemaMapping>,
    dialect?: Nullable<string | Dialect>,
    normalize?: boolean,
    udfMapping?: Nullable<SchemaMapping>,
  );
  find(table: unknown, raiseOnMissing?: boolean, ensureDataTypes?: boolean): unknown;
  copy(schema?: Nullable<SchemaMapping>, kwargs?: Record<string, unknown>): MappingSchema;
  depth(): number;

  static fromMappingSchema(schema: MappingSchema): MappingSchema;

  [key: string]: any;
}

// ---------------------------------------------------------------------------------------
// optimize()
// ---------------------------------------------------------------------------------------

export interface OptimizeOptions {
  schema?: Schema | SchemaMapping;
  db?: Nullable<string>;
  catalog?: Nullable<string>;
  dialect?: Nullable<string | Dialect>;
  /** Defaults to `RULES`, run in this exact order. A caller-supplied rule outside the 14
   * default `RULES` entries runs with NO kwargs forwarded — see docs/api.md's "What it
   * does NOT do". */
  rules?: Array<(expression: Expr, options: Record<string, unknown>) => Expr>;
  sql?: string;
  /** Plus any rule-specific kwarg a `RULES` entry declares by name (`identify`,
   * `quote_identifiers`, `expand_stars`, `leave_tables_isolated`, ...). */
  [ruleKwarg: string]: unknown;
}

export function optimize(expression: string | Expr, options?: OptimizeOptions): Expr;

/** The 14 default optimizer rules, in the exact order `optimize()` runs them. Not part of
 * upstream's own top-level re-export surface — re-exported here so a caller can build a
 * custom `rules` array (e.g. `RULES.filter(...)`). */
export const RULES: Array<(expression: Expr, options: Record<string, unknown>) => Expr>;

// ---------------------------------------------------------------------------------------
// lineage()
// ---------------------------------------------------------------------------------------

export class GraphHTML {
  toString(): string;
  _repr_html_(): string;
}

export class Node {
  name: string;
  expression: Expr;
  source: Expr;
  downstream: Node[];
  sourceName: string;
  referenceNodeName: string;
  payload: Record<string, unknown>;

  constructor(options?: {
    name?: string;
    expression?: Expr;
    source?: Expr;
    downstream?: Node[];
    sourceName?: string;
    referenceNodeName?: string;
    payload?: Record<string, unknown>;
  });

  /** Iterable pre-order DFS over the reachable DAG, visiting each unique node once. */
  walk(): IterableIterator<Node>;
  toHtml(dialect?: Nullable<string | Dialect>, options?: { imports?: boolean; options?: Record<string, unknown> }): GraphHTML;
}

export function lineage(
  column: Nullable<string | Expr>,
  sql: string | Expr,
  options?: {
    schema?: Schema | SchemaMapping;
    sources?: Record<string, string | Expr> | Map<string, string | Expr>;
    dialect?: Nullable<string | Dialect>;
    scope?: unknown;
    trimSelects?: boolean;
    copy?: boolean;
    onNode?: (node: Node) => void;
    [qualifyKwarg: string]: unknown;
  },
): Node | Record<string, Node>;

// ---------------------------------------------------------------------------------------
// anonymize() / render()
// ---------------------------------------------------------------------------------------

export function anonymize(
  sqlOrTokens: string | Token[],
  dialect?: Nullable<string | Dialect>,
): Token[];

export function render(sql: string, tokens: Token[], dialect?: Nullable<string | Dialect>): string;

// ---------------------------------------------------------------------------------------
// diff()
// ---------------------------------------------------------------------------------------

export function diff(
  source: Expr,
  target: Expr,
  options?: {
    matchings?: Array<[Expr, Expr]>;
    delta_only?: boolean;
    f?: number;
    t?: number;
    dialect?: Nullable<string | Dialect>;
  },
): Array<Insert | Remove | Move | Update | Keep>;

/** Route the parser's log lines (`LEVEL:name:message`, e.g. the "contains
 * unsupported syntax. Falling back to parsing as a 'Command'" warning) to an
 * embedder-owned sink instead of `console.error`. While any sink is installed
 * nothing is written to stderr. Returns a function that removes the sink. */
export function addLogSink(sink: (line: string) => void): () => void;
export function removeLogSink(sink: (line: string) => void): void;
