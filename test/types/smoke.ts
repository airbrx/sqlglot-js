// Type-level smoke test: imports every public symbol sqlglot-js exports and exercises
// its documented shape. Never run (no runtime assertions) — only `tsc --noEmit` matters
// here (`npm run check:types`). See docs/stability.md for what counts as "public."

import {
  Dialect,
  ErrorLevel,
  ParseError,
  TokenError,
  UnsupportedError,
  exp,
  parse,
  parseOne,
  transpile,
  tokenize,
  Schema,
  MappingSchema,
  optimize,
  RULES,
  lineage,
  Node,
  anonymize,
  render,
  diff,
  Insert,
  Remove,
  Move,
  Update,
  Keep,
} from "sqlglot-js";

import { extractSqlMetadata } from "sqlglot-js/contrib/gatewaySqlMetadata";

// --- parse / parseOne / transpile / tokenize --------------------------------------------

const trees: Array<import("sqlglot-js").Expr | null> = parse("SELECT 1; SELECT 2", {
  read: "snowflake",
  errorLevel: ErrorLevel.RAISE,
});

const single: import("sqlglot-js").Expr = parseOne("SELECT 1", { dialect: "postgres" });

const sqls: string[] = transpile("SELECT 1", { read: "databricks", write: "postgres" });

const tokens = tokenize("SELECT 1", { read: "snowflake" });
const firstTokenType: number = tokens[0].token_type;
const firstTokenText: string = tokens[0].text;

// --- Dialect -------------------------------------------------------------------------------

const dialect: Dialect = Dialect.get_or_raise("duckdb");
const generated: string = dialect.generate(single, { pretty: false });
void dialect.parse("SELECT 1");
void dialect.tokenize("SELECT 1");

// --- exp / Expr ----------------------------------------------------------------------------

const built: import("sqlglot-js").Expr = exp
  .select("id", "name")
  .from_("users")
  .where(exp.column("active").eq(true));
const builtSql: string = built.sql("postgres");
for (const node of built.walk()) {
  void node.args;
}
const copied = built.copy();
const equal: boolean = built.equals(copied);
const hashed: bigint = built.hash();

// --- errors --------------------------------------------------------------------------------

try {
  parseOne("SELECT FROM");
} catch (e) {
  if (e instanceof ParseError) {
    const detail = e.errors[0];
    void detail?.line;
  } else if (e instanceof TokenError) {
    void e.start;
  } else if (e instanceof UnsupportedError) {
    // unreachable from parse, but must still type-check as a catch target
  }
}

// --- Schema / MappingSchema ------------------------------------------------------------------

const schema: Schema = new MappingSchema({ users: { id: "INT", email: "VARCHAR" } });
const columnNames: string[] = schema.columnNames("users");
const hasCol: boolean = schema.hasColumn("users", "email");

// --- optimize ------------------------------------------------------------------------------

const optimized = optimize("SELECT * FROM users WHERE 1 = 1", { schema, identify: true });
void optimized.sql();
void RULES.length;

// --- lineage -------------------------------------------------------------------------------

const lineageNode = lineage("a", "SELECT a FROM z", {
  schema: { x: { a: "int" } },
  sources: { y: "SELECT * FROM x", z: "SELECT a FROM y" },
});
if (lineageNode instanceof Node) {
  void lineageNode.source.sql();
  for (const n of lineageNode.walk()) void n.name;
} else {
  void Object.keys(lineageNode);
}

// --- anonymize / render ----------------------------------------------------------------------

const anonTokens = anonymize("SELECT name FROM users", "snowflake");
const rendered: string = render("SELECT name FROM users", anonTokens, "snowflake");

// --- diff ----------------------------------------------------------------------------------

const edits: Array<Insert | Remove | Move | Update | Keep> = diff(
  parseOne("SELECT a + b"),
  parseOne("SELECT a - b"),
  { delta_only: true },
);
for (const edit of edits) {
  if (edit instanceof Insert || edit instanceof Remove) void edit.expression;
  else void edit.source;
}

// --- contrib/gatewaySqlMetadata --------------------------------------------------------------

const metadata = extractSqlMetadata("SELECT * FROM t", { dialect: "postgres" });
void metadata.isReadOnly;
void metadata.tables[0]?.fullyQualifiedName;

void [trees, sqls, firstTokenType, firstTokenText, generated, builtSql, equal, hashed, columnNames, hasCol, rendered];
