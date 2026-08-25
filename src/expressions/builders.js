// py: sqlglot/expressions/builders.py @ 91119bc
// Convenience constructors and tree-rewrite helpers.  Keyword-only Python
// arguments are represented by a final options object.

import {
  Alias, Anonymous, Array as ArrayExpr, Boolean, Case, Cast, Column, Condition, CTE, DataType,
  Delete, EQ, Expr, From, Identifier, Insert, Interval, Literal, Merge,
  Null, Placeholder, Query, RenameColumn, Schema, Select, Table, TableAlias,
  Tuple, Update, Values, Var, When, Whens, Where, With, Alter, AlterRename,
  TABLE_PARTS, SAFE_IDENTIFIER_RE, maybeParse, maybeCopy, toIdentifier, convert,
  alias_, column,
} from "./index.js";

const entries = (value) => value instanceof Map ? value : Object.entries(value || {});
const arg = (o, snake, camel = snake) => o?.[camel] ?? o?.[snake];
const construct = (C, args = {}) => new C(args);

export function select(...expressions) {
  let opts = {};
  if (expressions.length && isOptions(expressions.at(-1))) opts = expressions.pop();
  return new Select().select(...expressions, opts);
}

export function from_(expression, opts = {}) {
  return new Select().from_(expression, opts);
}

export function update(table, properties = null, options = {}) {
  // Also accept update(table, {properties, where, ...}).
  if (properties && isBuilderOptions(properties)) { options = properties; properties = options.properties; }
  const { dialect = null, copy = true, where = null, with_: withArg = null } = options;
  const fromArg = arg(options, "from_", "from");
  const opts = without(options, ["properties", "where", "from", "from_", "with_", "dialect", "copy"]);
  const result = construct(Update, { this: maybeParse(table, { into: Table, dialect, copy }) });
  if (properties) result.set("expressions", [...entries(properties)].map(([k, v]) => construct(EQ, {
    this: maybeParse(k, { dialect, copy, ...opts }), expression: convert(v),
  })));
  if (fromArg) result.set("from_", maybeParse(fromArg, { into: From, dialect, prefix: "FROM", copy, ...opts }));
  if (where) result.set("where", where instanceof Condition ? construct(Where, { this: where }) :
    maybeParse(where, { into: Where, dialect, prefix: "WHERE", copy, ...opts }));
  if (withArg) result.set("with_", construct(With, { expressions: [...entries(withArg)].map(([name, query]) =>
    alias_(construct(CTE, { this: maybeParse(query, { dialect, copy, ...opts }) }), name, { table: true })) }));
  return result;
}

export function delete_(table, options = {}) {
  const { where, returning, dialect = null, ...opts } = options;
  let result = new Delete().delete(table, { dialect, copy: false, ...opts });
  if (where) result = result.where(where, { dialect, copy: false, ...opts });
  if (returning) result = result.returning(returning, { dialect, copy: false, ...opts });
  return result;
}
export { delete_ as delete };

export function insert(expression, into, options = {}) {
  const { columns, overwrite = null, returning, dialect = null, copy = true, ...opts } = options;
  const expr = maybeParse(expression, { dialect, copy, ...opts });
  let target = maybeParse(into, { into: Table, dialect, copy, ...opts });
  if (columns) target = construct(Schema, { this: target, expressions: [...columns].map(c => toIdentifier(c, { copy })) });
  let result = construct(Insert, { this: target, expression: expr, overwrite });
  if (returning) result = result.returning(returning, { dialect, copy: false, ...opts });
  return result;
}

export function merge(...whenExprs) {
  const options = whenExprs.pop() || {};
  const { into, using, on, returning, dialect = null, copy = true, ...opts } = options;
  const expressions = [];
  for (const item of whenExprs) {
    const expression = maybeParse(item, { dialect, copy, into: Whens, ...opts });
    expressions.push(...(expression instanceof When ? [expression] : expression.expressions));
  }
  let result = construct(Merge, { this: maybeParse(into, { dialect, copy, ...opts }),
    using: maybeParse(using, { dialect, copy, ...opts }), on: maybeParse(on, { dialect, copy, ...opts }),
    whens: construct(Whens, { expressions }) });
  if (returning) result = result.returning(returning, { dialect, copy: false, ...opts });
  const usingClause = result.args.using;
  if (usingClause instanceof Alias) usingClause.replace(alias_(usingClause.this, usingClause.args.alias, { table: true }));
  return result;
}

export function parseIdentifier(name, dialect = null) {
  if (typeof name === "string" && SAFE_IDENTIFIER_RE.test(name)) return construct(Identifier, { this: name, quoted: false });
  try {
    const parsed = maybeParse(name, { dialect, into: Identifier });
    return parsed.this instanceof Identifier ? toIdentifier(name) : parsed;
  }
  catch { return toIdentifier(name); }
}

export const INTERVAL_STRING_RE = /^\s*(-?[0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z]+)\s*$/;
export const INTERVAL_DAY_TIME_RE = /^\s*-?\s*\d+(?:\.\d+)?\s+(?:-?(?:\d+:)?\d+:\d+(?:\.\d+)?|-?(?:\d+:){1,2}|:)\s*$/;

export function toInterval(interval) {
  if (interval instanceof Literal) {
    if (!interval.isString) throw new TypeError("Invalid interval string.");
    interval = interval.this;
  }
  const result = maybeParse(`INTERVAL ${interval}`);
  if (!(result instanceof Interval)) throw new TypeError("Expected Interval");
  return result;
}

export function toTable(sqlPath, options = {}) {
  const { dialect = null, copy = true, ...kwargs } = options;
  if (sqlPath instanceof Table) return maybeCopy(sqlPath, { copy });
  let table;
  try { table = maybeParse(sqlPath, { into: Table, dialect }); }
  catch (error) {
    const parts = String(sqlPath).split(".");
    if (!parts.length || parts.length > 3) throw error;
    const [catalog, db, name] = [null, null, ...parts].slice(-3);
    if (!name) throw error;
    table = table_(name, { db, catalog });
  }
  return table.setKwargs ? table.setKwargs(kwargs) : (Object.entries(kwargs).forEach(([k,v]) => table.set(k,v)), table);
}

export function toColumn(sqlPath, options = {}) {
  const { quoted = null, dialect = null, copy = true, ...kwargs } = options;
  if (sqlPath instanceof Column) return maybeCopy(sqlPath, { copy });
  let col;
  try { col = maybeParse(sqlPath, { into: Column, dialect }); }
  catch { return column(...String(sqlPath).split(".").reverse(), { quoted, ...kwargs }); }
  for (const [k,v] of Object.entries(kwargs)) col.set(k,v);
  if (quoted) for (const id of col.findAll(Identifier)) id.set("quoted", true);
  return col;
}

export function subquery(expression, alias = null, options = {}) {
  const { dialect = null, copy = true, ...opts } = options;
  const parsed = maybeParse(expression, { dialect, ...opts });
  const query = parsed.assertIs ? parsed.assertIs(Query) : parsed;
  return new Select().from_(query.subquery(alias, { copy }), { dialect, ...opts });
}

export function cast(expression, to, options = {}) {
  const { copy = true, dialect = null, ...opts } = options;
  const expr = maybeParse(expression, { copy, dialect, ...opts });
  const dataType = DataType.build(to, { copy, dialect, ...opts });
  // Full dialect TYPE_MAPPING equivalence is performed when a resolved dialect is supplied.
  if (expr instanceof Cast) {
    const mapping = dialect?.generatorClass?.TYPE_MAPPING || dialect?.generator_class?.TYPE_MAPPING;
    const oldType = expr.to?.this, newType = dataType.this;
    const equivalent = mapping && mappingValue(mapping, oldType) === mappingValue(mapping, newType);
    if (expr.isType(dataType) || equivalent) return expr;
  }
  const result = construct(Cast, { this: expr, to: dataType });
  result.type = dataType;
  return result;
}

export function table_(table, options = {}) {
  const { db = null, catalog = null, quoted = null, alias = null } = options;
  return construct(Table, { this: table ? toIdentifier(table, { quoted }) : null,
    db: db ? toIdentifier(db, { quoted }) : null, catalog: catalog ? toIdentifier(catalog, { quoted }) : null,
    alias: alias ? construct(TableAlias, { this: toIdentifier(alias) }) : null });
}

export function values(rows, options = {}) {
  const { alias = null, columns = null } = options;
  if (columns && !alias) throw new TypeError("Alias is required when providing columns");
  return construct(Values, { expressions: [...rows].map(convert), alias: columns ? construct(TableAlias,
    { this: toIdentifier(alias), columns: [...(columns instanceof Map ? columns.keys() : columns)].map(toIdentifier) }) :
    alias ? construct(TableAlias, { this: toIdentifier(alias) }) : null });
}

export function var_(name) {
  if (!name) throw new TypeError("Cannot convert empty name into var.");
  return construct(Var, { this: name instanceof Expr ? name.name : name });
}
export { var_ as var };

export function renameTable(oldName, newName, dialect = null) {
  return construct(Alter, { this: toTable(oldName, { dialect }), kind: "TABLE", actions:
    [construct(AlterRename, { this: toTable(newName, { dialect }) })] });
}
export function renameColumn(tableName, oldName, newName, options = {}) {
  const { exists = null, dialect = null } = options;
  return construct(Alter, { this: toTable(tableName, { dialect }), kind: "TABLE", actions: [construct(RenameColumn,
    { this: toColumn(oldName, { dialect }), to: toColumn(newName, { dialect }), exists })] });
}

export function replaceChildren(expression, fun, ...args) {
  for (const [key, value] of Object.entries(expression.args)) {
    const isList = Array.isArray(value), children = isList ? value : [value], next = [];
    for (const child of children) {
      if (child instanceof Expr) next.push(...ensureCollection(fun(child, ...args)));
      else next.push(child);
    }
    expression.set(key, isList ? next : next[0]);
  }
}

export function replaceTree(expression, fun, prune = null) {
  const stack = [...expression.dfs({ prune })];
  let newNode = expression;
  while (stack.length) {
    const node = stack.pop(); newNode = fun(node);
    if (newNode !== node) { node.replace(newNode); if (newNode instanceof Expr) stack.push(newNode); }
  }
  return newNode;
}

export function columnTableNames(expression, exclude = "") {
  const result = new Set();
  for (const col of expression.findAll(Column)) if (col.table && col.table !== exclude) result.add(col.table);
  return result;
}

export function tableName(table, options = {}) {
  const { dialect = null, identify = false } = options;
  const expr = maybeParse(table, { into: Table, dialect });
  // deny:implicit_str sqlglot/expressions/builders.py:778 -- Python f-string uses Expression.__str__.
  if (!expr) throw new TypeError(`Cannot parse ${table}`);
  return expr.parts.map(part => identify || !SAFE_IDENTIFIER_RE.test(part.name) ?
    part.sql({ dialect, identify: true, copy: false, comments: false }) : part.name).join(".");
}

export function replacePlaceholders(expression, ...args) {
  let kwargs = {};
  if (args.length && isOptions(args.at(-1))) kwargs = args.pop();
  let index = 0;
  return expression.transform(node => {
    if (!(node instanceof Placeholder)) return node;
    if (node.this) return Object.hasOwn(kwargs, node.this) && kwargs[node.this] != null ? convert(kwargs[node.this]) : node;
    return index < args.length ? convert(args[index++]) : node;
  });
}

export function expand(expression, sources, options = {}) {
  const { dialect = null, copy = true, normalize = x => tableName(toTable(x, { dialect })) } = options;
  const normalized = new Map([...entries(sources)].map(([k,v]) => [normalize(k), v]));
  const expandNode = node => {
    if (node instanceof Table) {
      const name = normalize(node), source = normalized.get(name);
      if (source) { const parsed = typeof source === "function" ? source() : source;
        const query = parsed.subquery(node.alias || name); query.comments = [`source: ${name}`];
        return query.transform(expandNode, { copy: false }); }
    }
    return node;
  };
  return expression.transform(expandNode, { copy });
}

export function func(name, ...args) {
  let options = {};
  if (args.length && isOptions(args.at(-1))) options = args.pop();
  const { copy = true, dialect = null, kwargs = null } = options;
  if (args.length && kwargs && Object.keys(kwargs).length) throw new TypeError("Can't use both args and kwargs to instantiate a function.");
  const converted = args.map(value => maybeParse(value, { dialect, copy }));
  const convertedKwargs = Object.fromEntries(Object.entries(kwargs || {}).map(([k,v]) => [k, maybeParse(v, { dialect, copy })]));
  const functions = dialect?.parserClass?.FUNCTIONS || dialect?.parser_class?.FUNCTIONS;
  let result, constructor = functions?.get?.(name.toUpperCase()) || functions?.[name.toUpperCase()];
  if (constructor) result = converted.length ? constructor(converted, dialect) : constructor(convertedKwargs);
  else result = construct(Anonymous, { this: name, ...(kwargs ? convertedKwargs : { expressions: converted }) });
  for (const message of result.errorMessages?.(converted) || []) throw new TypeError(message);
  return result;
}

export function case_(expression = null, options = {}) {
  return construct(Case, { this: expression == null ? null : maybeParse(expression, options), ifs: [] });
}
export { case_ as case };
export function array(...expressions) { let opts={}; if (expressions.length && isOptions(expressions.at(-1))) opts=expressions.pop(); return construct(ArrayExpr,{expressions:expressions.map(x=>maybeParse(x,opts))}); }
export function tuple_(...expressions) { let opts={}; if (expressions.length && isOptions(expressions.at(-1))) opts=expressions.pop(); return construct(Tuple,{expressions:expressions.map(x=>maybeParse(x,opts))}); }
export function true_() { return construct(Boolean, { this: true }); }
export function false_() { return construct(Boolean, { this: false }); }
export function null_() { return new Null(); }
export { true_ as true, false_ as false, null_ as null };

export function findTables(expression, traverseScope) {
  if (!traverseScope) throw new TypeError("findTables requires the optimizer traverseScope callback");
  const result = new Set();
  for (const scope of traverseScope(expression)) for (const table of scope.tables)
    if (table instanceof Table && table.name && !scope.cteSources.has(table.name)) result.add(table);
  return result;
}

export const NONNULL_CONSTANTS = Object.freeze([Literal, Boolean]);
export const CONSTANTS = Object.freeze([Literal, Boolean, Null]);

function isOptions(v) { return v != null && typeof v === "object" && !(v instanceof Expr) && !Array.isArray(v); }
function isBuilderOptions(v) { return isOptions(v) && ["properties","where","from","from_","with_","dialect","copy"].some(k=>Object.hasOwn(v,k)); }
function without(value, keys) { const out={...value}; for(const k of keys) delete out[k]; return out; }
function ensureCollection(value) { return value == null ? [] : Array.isArray(value) ? value : value instanceof Set ? [...value] : [value]; }
function mappingValue(mapping, key) { return mapping.get?.(key) ?? mapping[key] ?? key?.value ?? key; }

/** Case-normalize and unquote a table name. A normalizeIdentifiers callback may
 * be supplied until the optimizer module lands. */
export function normalizeTableName(table, options = {}) {
  const { dialect = null, copy = true, normalizeIdentifiers = x => x } = options;
  const normalized = normalizeIdentifiers(toTable(table, { dialect, copy }), { dialect });
  return normalized.parts.map(part => part.name).join(".");
}

export function replaceTables(expression, mapping, options = {}) {
  const { dialect = null, copy = true } = options;
  const normalized = new Map([...entries(mapping)].map(([k,v]) => [normalizeTableName(k, { dialect }), v]));
  return expression.transform(node => {
    if (node instanceof Table && node.metaGet?.("replace") !== false) {
      const original = normalizeTableName(node, { dialect });
      const newName = normalized.get(original);
      if (newName) {
        const extra = {};
        for (const [k,v] of Object.entries(node.args)) if (!(TABLE_PARTS?.includes?.(k) || TABLE_PARTS?.has?.(k))) extra[k] = v;
        const table = toTable(newName, { ...extra, dialect });
        table.addComments([original]);
        return table;
      }
    }
    return node;
  }, { copy });
}

export function applyIndexOffset(thisExpr, expressions, offset, options = {}) {
  if (!offset || expressions.length !== 1) return expressions;
  let expression = expressions[0];
  const { dialect = null, annotateTypes = null, simplify = null } = options;
  if (!thisExpr.type && annotateTypes) annotateTypes(thisExpr, { dialect });
  const ownerType = thisExpr.type?.this;
  if (ownerType != null && !(["UNKNOWN", "ARRAY"].includes(ownerType?.value ?? ownerType))) return expressions;
  if (!expression.type && annotateTypes) annotateTypes(expression, { dialect });
  const integerTypes = DataType.INTEGER_TYPES || DataType.integerTypes;
  if (integerTypes?.has(expression.type?.this)) {
    if (!simplify) throw new TypeError("applyIndexOffset requires simplify callback for integer indexes");
    expression = simplify(expression.add ? expression.add(offset) : construct(EQ, {}), { dialect });
    return [expression];
  }
  return expressions;
}
