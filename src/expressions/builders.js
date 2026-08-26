// py: sqlglot/expressions/builders.py @ 91119bc
// Convenience constructors and tree-rewrite helpers.  Keyword-only Python
// arguments are represented by a final options object.

import {
  Alias, Anonymous, Array as ArrayExpr, Boolean, Case, Cast, Column, Condition, CTE, DataType,
  Delete, EQ, From, Identifier, Insert, Interval, Literal, Merge,
  Null, Placeholder, Query, RenameColumn, Schema, Select, Table, TableAlias,
  Tuple, Update, Values, Var, When, Whens, Where, With, Alter, AlterRename,
} from "./classes.js";
import {
  Expr, TABLE_PARTS, SAFE_IDENTIFIER_RE, maybeParse, maybeCopy, toIdentifier,
  convert, alias_, column, trailingOptions,
} from "./core.js";
import { PyValueError } from "../_py/errors.js";
import { ParseError, TokenError } from "../errors.js";

const entries = (value) => value instanceof Map ? value : Object.entries(value || {});
const arg = (o, snake, camel = snake) => o?.[camel] ?? o?.[snake];
const construct = (C, args = {}) => new C(args);
/** Python truthiness for the collection arguments: [] / {} / empty Map are falsy there. */
function truthy(value) {
  if (value === null || value === undefined || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  if (value.constructor === Object) return Object.keys(value).length > 0;
  return !!value;
}
/** Iterating a Python dict yields its keys; a Map or a plain object must do the same. */
function keysOf(value) {
  if (value instanceof Map) return [...value.keys()];
  if (Array.isArray(value)) return value;
  if (value && value.constructor === Object) return Object.keys(value);
  return [...value];
}
// py: helper.py:274 split_num_words(value, sep, min_num_words) with fill_from_start.
function splitNumWords(value, sep, minNumWords) {
  const words = String(value).split(sep);
  return [...Array(Math.max(0, minNumWords - words.length)).fill(null), ...words];
}

export function select(...expressions) {
  let opts = {};
  if (expressions.length && isOptions(expressions.at(-1))) opts = expressions.pop();
  return new Select().select(...expressions, opts);
}

export function from_(expression, opts = {}) {
  return new Select().from_(expression, opts);
}

export function update(table, properties = null, options = {}) {
  const { dialect = null, copy = true, where = null, with_: withArg = null } = options;
  const fromArg = arg(options, "from_", "from");
  const opts = without(options, ["properties", "where", "from", "from_", "with_", "dialect", "copy"]);
  const result = construct(Update, { this: maybeParse(table, { into: Table, dialect, copy }) });
  if (properties) result.set("expressions", [...entries(properties)].map(([k, v]) => construct(EQ, {
    this: maybeParse(k, { dialect, copy, ...opts }), expression: convert(v),
  })));
  if (fromArg) result.set("from_", maybeParse(fromArg, { into: From, dialect, prefix: "FROM", copy, ...opts }));
  // py: builders.py:160 -- the Condition is wrapped and then still handed to
  // maybe_parse, so with copy=True the caller's node is copied rather than aliased.
  if (where) {
    const wrapped = where instanceof Condition ? construct(Where, { this: where }) : where;
    result.set("where", maybeParse(wrapped, { into: Where, dialect, prefix: "WHERE", copy, ...opts }));
  }
  if (withArg) result.set("with_", construct(With, { expressions: [...entries(withArg)].map(([name, query]) =>
    alias_(construct(CTE, { this: maybeParse(query, { dialect, copy, ...opts }) }), name, { table: true })) }));
  return result;
}

export function delete_(table, options = {}) {
  // `copy` is destructured out and dropped: upstream hardcodes copy=False on all three
  // calls, and passing it through **opts there is a duplicate-keyword TypeError.
  const { where, returning, dialect = null, copy: _copy, ...opts } = options;
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
  if (columns) target = construct(Schema, { this: target, expressions: [...columns].map(c => toIdentifier(c, null, copy)) });
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
    return maybeParse(name, { dialect, into: Identifier });
  } catch (error) {
    // py: `except (ParseError, TokenError)` -- exactly those two.  A ValueError from
    // to_identifier is not caught upstream, so it must propagate here too.
    if (!(error instanceof ParseError || error instanceof TokenError)) throw error;
    return toIdentifier(name);
  }
}

export const INTERVAL_STRING_RE = /^\s*(-?[0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z]+)\s*$/;
export const INTERVAL_DAY_TIME_RE = /^\s*-?\s*\d+(?:\.\d+)?\s+(?:-?(?:\d+:)?\d+:\d+(?:\.\d+)?|-?(?:\d+:){1,2}|:)\s*$/;

export function toInterval(interval) {
  if (interval instanceof Literal) {
    if (!interval.isString) throw new PyValueError("Invalid interval string.");
    interval = interval.this;
  }
  // py: `maybe_parse(f"INTERVAL {interval}")` then `assert isinstance(..., Interval)`.
  // Parser-dependent: until P3 registers one this necessarily fails for every input.
  const result = maybeParse(`INTERVAL ${interval}`);
  if (!(result instanceof Interval)) throw new TypeError("Expected Interval");
  return result;
}

export function toTable(sqlPath, options = {}) {
  const { dialect = null, copy = true, ...kwargs } = options;
  if (sqlPath instanceof Table) return maybeCopy(sqlPath, copy);
  let table;
  try { table = maybeParse(sqlPath, { into: Table, dialect }); }
  catch (error) {
    // py: split_num_words(sql_path, ".", 3) then a 3-way unpack, so >3 parts is a
    // ValueError (not the original ParseError) and a falsy last part re-raises.
    const parts = splitNumWords(sqlPath, ".", 3);
    if (parts.length > 3) throw new PyValueError(`too many values to unpack (expected 3), got ${parts.length}`);
    const [catalog, db, name] = parts;
    if (!name) throw error;
    table = table_(name, { db, catalog });
  }
  return table.setKwargs(kwargs);
}

export function toColumn(sqlPath, options = {}) {
  const { quoted = null, dialect = null, copy = true, ...kwargs } = options;
  if (sqlPath instanceof Column) return maybeCopy(sqlPath, copy);
  let col;
  try { col = maybeParse(sqlPath, { into: Column, dialect }); }
  catch {
    // py: column(*reversed(sql_path.split(".")), quoted=quoted, **kwargs).  The four
    // positionals are spelled out: spreading a shorter list would slide the options
    // object into `table`, and Python rejects a 5th positional outright.
    const parts = String(sqlPath).split(".").reverse();
    if (parts.length > 4) throw new PyValueError(`column() takes from 1 to 4 positional arguments but ${parts.length} were given`);
    return column(parts[0], parts[1] ?? null, parts[2] ?? null, parts[3] ?? null, { quoted, ...kwargs });
  }
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
  // py: Dialect.get_or_raise(dialect).generator_class.TYPE_MAPPING.  With dialect=None
  // upstream still resolves the BASE Generator mapping, which is not empty -- it is what
  // collapses cast(cast(x, 'NCHAR'), 'CHAR') to the inner NCHAR cast.  Treating a missing
  // dialect as "no mapping" produced a double CAST instead.
  if (expr instanceof Cast) {
    const mapping = dialect?.generatorClass?.TYPE_MAPPING || dialect?.generator_class?.TYPE_MAPPING || BASE_TYPE_MAPPING;
    const oldType = expr.to?.this, newType = dataType.this;
    // `this` is a plain type enum only for simple types; complex ones nest an
    // expression there, so the equivalence check is skipped for those.
    const equivalent = oldType?.__enum__ === "DType" && newType?.__enum__ === "DType"
      && mappingValue(mapping, oldType) === mappingValue(mapping, newType);
    if (expr.isType(dataType) || equivalent) return expr;
  }
  const result = construct(Cast, { this: expr, to: dataType });
  result.type = dataType;
  return result;
}

export function table_(table, options = {}) {
  const { db = null, catalog = null, quoted = null, alias = null } = options;
  return construct(Table, { this: table ? toIdentifier(table, quoted) : null,
    db: db ? toIdentifier(db, quoted) : null, catalog: catalog ? toIdentifier(catalog, quoted) : null,
    alias: alias ? construct(TableAlias, { this: toIdentifier(alias) }) : null });
}

// py: builders.py:545.  Upstream is `[convert(tup) for tup in values]` -- one convert
// per ROW, so a scalar row stays a scalar.  Python's rows are tuples; JS's only
// sequence literal is Array, so an array row is the tuple spelling and is converted to
// a Tuple here (convert() alone would make it an Array).  `columns` may be a list or a
// dict, and iterating a dict yields its keys.  All the emptiness tests use Python
// truthiness, where [] and {} are falsy.
export function values(rows, options = {}) {
  const { alias = null, columns = null } = options;
  if (truthy(columns) && !alias) throw new PyValueError("Alias is required when providing columns");
  const expressions = [...rows].map(row =>
    Array.isArray(row) ? construct(Tuple, { expressions: row.map(v => convert(v)) }) : convert(row));
  let tableAlias = null;
  if (truthy(columns)) {
    tableAlias = construct(TableAlias, { this: toIdentifier(alias), columns: keysOf(columns).map(c => toIdentifier(c)) });
  } else if (alias) {
    tableAlias = construct(TableAlias, { this: toIdentifier(alias) });
  }
  return construct(Values, { expressions, alias: tableAlias });
}

export function var_(name) {
  if (!name) throw new PyValueError("Cannot convert empty name into var.");
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
  const stack = [...expression.dfs(prune)];
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
    part.sql(dialect, { identify: true, copy: false, comments: false }) : part.name).join(".");
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

// py: builders.py:888.  Upstream normalizes with normalize_table_name, NOT table_name:
// table_name renders each part through .sql(), which needs a generator that does not
// exist before P4 and so threw on any quoted table name.
export function expand(expression, sources, options = {}) {
  const { dialect = null, copy = true, normalize = x => normalizeTableName(x, { dialect }) } = options;
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
  const options = trailingOptions(args);
  const { copy = true, dialect = null, kwargs = null } = options;
  const hasKwargs = truthy(kwargs);
  if (args.length && hasKwargs) throw new PyValueError("Can't use both args and kwargs to instantiate a function.");
  const converted = args.map(value => maybeParse(value, { dialect, copy }));
  const convertedKwargs = Object.fromEntries(Object.entries(kwargs || {}).map(([k,v]) => [k, maybeParse(v, { dialect, copy })]));
  const functions = dialect?.parserClass?.FUNCTIONS || dialect?.parser_class?.FUNCTIONS;
  let result, constructor = functions?.get?.(name.toUpperCase()) || functions?.[name.toUpperCase()];
  // The three upstream constructor arms (positional retry with dialect, from_arg_list,
  // the FUNCTION_BY_NAME fallback and its terminal ValueError) are all reachable only
  // once a dialect exposes a parser class; before P3 `constructor` is always undefined.
  if (constructor) result = converted.length ? constructor(converted, dialect) : constructor(convertedKwargs);
  else {
    // py: `Anonymous(this=name, **kwargs)` -- a kwargs key of "this" is a duplicate
    // keyword argument there, not a silent override of the function name.
    if (hasKwargs && Object.hasOwn(convertedKwargs, "this")) {
      throw new TypeError("Anonymous() got multiple values for keyword argument 'this'");
    }
    result = construct(Anonymous, { this: name, ...(hasKwargs ? convertedKwargs : { expressions: converted }) });
  }
  for (const message of result.errorMessages?.(converted) || []) throw new PyValueError(message);
  return result;
}

// copy defaults to True in all three; forwarding the raw options object instead let
// maybeParse fall back to its own copy=false default and alias the caller's nodes.
export function case_(expression = null, options = {}) {
  return construct(Case, { this: expression == null ? null : maybeParse(expression, { ...options, copy: options.copy ?? true }), ifs: [] });
}
export { case_ as case };
export function array(...expressions) { const o=trailingOptions(expressions); return construct(ArrayExpr,{expressions:expressions.map(x=>maybeParse(x,{...o,copy:o.copy??true}))}); }
export function tuple_(...expressions) { const o=trailingOptions(expressions); return construct(Tuple,{expressions:expressions.map(x=>maybeParse(x,{...o,copy:o.copy??true}))}); }
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
function without(value, keys) { const out={...value}; for(const k of keys) delete out[k]; return out; }
function ensureCollection(value) { return value == null ? [] : Array.isArray(value) ? value : value instanceof Set ? [...value] : [value]; }
// py: TYPE_MAPPING.get(type, type.value).  Dialect mappings are keyed by the DType
// record itself; BASE_TYPE_MAPPING is a plain object keyed by the member name.
function mappingValue(mapping, key) {
  const name = key?.name ?? key;
  return mapping.get?.(key) ?? mapping.get?.(name) ?? mapping[name] ?? key?.value ?? key;
}
// py: generator.py:636 Generator.TYPE_MAPPING -- the BASE mapping, which
// Dialect.get_or_raise(None) resolves to.  Keyed by DType name to avoid importing the
// enum records into this module.
const BASE_TYPE_MAPPING = Object.freeze({
  DATETIME2: "TIMESTAMP", NCHAR: "CHAR", NVARCHAR: "VARCHAR", MEDIUMTEXT: "TEXT",
  LONGTEXT: "TEXT", TINYTEXT: "TEXT", BLOB: "VARBINARY", MEDIUMBLOB: "BLOB",
  LONGBLOB: "BLOB", TINYBLOB: "BLOB", INET: "INET", ROWVERSION: "VARBINARY",
  SMALLDATETIME: "TIMESTAMP",
});

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
  // py: `if this.type.this not in (UNKNOWN, ARRAY): return expressions`.  An owner with
  // no resolved type is not in that tuple either, so it takes the early return -- the
  // previous `ownerType != null &&` guard inverted exactly that case.
  const ownerType = thisExpr.type?.this;
  if (!["UNKNOWN", "ARRAY"].includes(ownerType?.name ?? ownerType?.value ?? ownerType)) return expressions;
  if (!expression.type && annotateTypes) annotateTypes(expression, { dialect });
  const integerTypes = DataType.INTEGER_TYPES || DataType.integerTypes;
  if (integerTypes?.has(expression.type?.this)) {
    if (!simplify) throw new TypeError("applyIndexOffset requires simplify callback for integer indexes");
    // py: simplify(expression + offset) -- Expr.__add__, i.e. _binop(Add, offset).
    expression = simplify(expression.add(offset), { dialect });
    return [expression];
  }
  return expressions;
}
