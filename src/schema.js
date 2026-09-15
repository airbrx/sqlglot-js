// py: sqlglot/schema.py @ 91119bc
//
// Column-type-aware table/column metadata. Greenfield: nothing in the port depends on
// this file yet, but the (not-yet-started) optimizer's `qualify`/`annotate_types`
// passes will. See docs/api.md for what is real today vs. target design.
//
// `@trait` (py:12, `@trait class Schema(abc.ABC)` at py:24) is upstream's own
// `def trait(f): return f` (sqlglot/helper.py) -- a pure identity decorator kept only
// for a static type checker's benefit. It has no runtime effect, so there is nothing
// to port for it. Likewise `abc.ABC`/`@abc.abstractmethod`: nothing in this codebase
// enforces "cannot instantiate a class with unimplemented abstract methods" (no
// existing port does), so `Schema` below is a plain class whose abstract members throw
// if a hypothetical alternate implementation forgets to override them -- the pragmatic
// analogue, not a literal ABC metaclass port.
//
// MRO collapse: upstream's `class MappingSchema(AbstractMappingSchema, Schema)` is real
// multiple inheritance, but `MappingSchema` overrides every member `Schema` defines
// (directly or via `AbstractMappingSchema`), so nothing is actually INHERITED from
// `Schema` at runtime here -- only `isinstance(schema, Schema)` (schema.py:713,
// `ensure_schema`) needs `Schema` to recognize `MappingSchema` instances. `defineExpr`
// (expressions/core.js:417-420) already solved this exact problem for the *.exp*
// classes with a `Symbol.hasInstance` override reading a generated `bases` list; the
// same idiom is used below (`class MappingSchema extends AbstractMappingSchema`, single
// JS inheritance for the real shared machinery, plus `Schema[Symbol.hasInstance]`).
//
// Internal storage note (JS Map vs plain object): the nested schema mapping
// (`this.mapping`, `this.visible`, `this.udfMapping`, and everything `nestedSet`/
// `_normalize` build) is stored as `Map`, never a plain object -- the sibling
// `trie.js`'s TRIE_END lesson generalizes here: a plain JS object silently reorders
// integer-LOOKING string keys (a column or table literally named "123") ahead of every
// other key, in ascending numeric order, regardless of insertion order; a Python dict
// (what upstream actually uses) never does this. `Map` preserves true insertion order
// for any key shape, matching Python exactly. The public module-level `nestedGet`/
// `nestedSet`/`flattenSchema`/`ensureColumnMapping` accept EITHER `Map` or a plain
// object as input (ergonomic JS call sites), but `nestedSet` always MATERIALIZES new
// intermediate levels as `Map`, and `MappingSchema`'s own `_normalize`/`_normalizeUdfs`
// (which run by default, `normalize=true`) always rebuild the stored mapping through
// `nestedSet`, so the common path is safe regardless of what shape the caller passed
// in. The one caller-controlled gap is `normalize=false`: the raw input is stored
// as-is (matching upstream's own aliasing -- `self.mapping = schema`, no copy), so a
// plain-object literal with numeric-looking keys passed under `normalize=false` is
// already reordered by the time this file sees it, a fact about JS object-literal
// evaluation this port cannot undo.
import * as exp from "./expressions/index.js";
import { Dialect } from "./dialects/dialect.js";
import { SchemaError, PyValueError } from "./errors.js";
import { PyIndexError } from "./_py/errors.js";
import { dictDepth, first } from "./helper.js";
import { TrieResult, newTrie, inTrie } from "./trie.js";

// --- local dict-like helpers (Map OR plain object; see the file header) -----------

function isDict(v) {
  return v instanceof Map || (v !== null && typeof v === "object" && !Array.isArray(v) && v.constructor === Object);
}
function dictGet(d, key) {
  if (d instanceof Map) return d.has(key) ? d.get(key) : null;
  if (d && typeof d === "object" && Object.hasOwn(d, key)) return d[key];
  return null;
}
function dictHas(d, key) {
  if (d instanceof Map) return d.has(key);
  return !!(d && typeof d === "object" && Object.hasOwn(d, key));
}
function dictSet(d, key, value) {
  if (d instanceof Map) d.set(key, value);
  else d[key] = value;
}
function dictEntries(d) {
  if (d instanceof Map) return [...d.entries()];
  if (d && typeof d === "object") return Object.entries(d);
  return [];
}
function dictValues(d) {
  if (d instanceof Map) return d.values();
  if (d && typeof d === "object") return Object.values(d);
  return [];
}
function dictKeys(d) {
  if (d instanceof Map) return [...d.keys()];
  if (d && typeof d === "object") return Object.keys(d);
  return [];
}
/** py: Python truthiness for a dict/list/str/bool -- `not self.mapping` etc. */
function truthy(v) {
  if (v === null || v === undefined || v === false) return false;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "string") return v.length > 0;
  if (v && v.constructor === Object) return Object.keys(v).length > 0;
  return !!v;
}
/** py: `zip(a, b)` -- stops at the shorter sequence. */
function zip(a, b) {
  const out = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) out.push([a[i], b[i]]);
  return out;
}
function tableCacheKey(table, extra) {
  const h = table instanceof exp.Expr ? table.hash().toString() : String(table);
  return `${h} ${extra}`;
}

/**
 * py: schema.py:24 `class Schema(abc.ABC)` -- abstract base class for database schemas.
 *
 * Never actually inherited from at runtime in this port (see file header); kept as a
 * plain class documenting the interface, with a `Symbol.hasInstance` override so
 * `ensureSchema`'s `schema instanceof Schema` check recognizes real implementations
 * (today, only `MappingSchema`).
 */
export class Schema {
  /** py: schema.py:28 `dialect` property. Returns null unless a subclass overrides it. */
  get dialect() {
    return null;
  }

  // py: schema.py:37 `add_table` (abstractmethod).
  addTable(_table, _columnMapping = null, _dialect = null, _normalize = null, _matchDepth = true) {
    throw new PyValueError("Schema.addTable is abstract and must be overridden");
  }

  // py: schema.py:58 `column_names` (abstractmethod).
  columnNames(_table, _onlyVisible = false, _dialect = null, _normalize = null) {
    throw new PyValueError("Schema.columnNames is abstract and must be overridden");
  }

  // py: schema.py:79 `get_column_type` (abstractmethod).
  getColumnType(_table, _column, _dialect = null, _normalize = null) {
    throw new PyValueError("Schema.getColumnType is abstract and must be overridden");
  }

  // py: schema.py:99 `has_column` -- concrete, in terms of columnNames.
  hasColumn(table, column, dialect = null, normalize = null) {
    const name = typeof column === "string" ? column : column.name;
    return this.columnNames(table, false, dialect, normalize).includes(name);
  }

  // py: schema.py:121 `get_udf_type` -- concrete default: always UNKNOWN.
  getUdfType(_udf, _dialect = null, _normalize = null) {
    return exp.DType.UNKNOWN.into_expr();
  }

  // py: schema.py:140 `supported_table_args` property (abstractmethod).
  get supportedTableArgs() {
    throw new PyValueError("Schema.supportedTableArgs is abstract and must be overridden");
  }

  // py: schema.py:147 `empty` property.
  get empty() {
    return true;
  }
}

/** py: schema.py:153 `class AbstractMappingSchema` -- shared trie-based lookup logic. */
export class AbstractMappingSchema {
  // py: schema.py:154 `__init__`.
  constructor(mapping = null, udfMapping = null) {
    this.mapping = mapping || new Map();
    this.mappingTrie = newTrie(
      flattenSchema(this.mapping, this.depth()).map((t) => [...t].reverse()),
    );
    this.udfMapping = udfMapping || new Map();
    this.udfTrie = newTrie(
      flattenSchema(this.udfMapping, this.udfDepth()).map((t) => [...t].reverse()),
    );

    this._supportedTableArgs = [];
  }

  // py: schema.py:170 `empty` property.
  get empty() {
    return !truthy(this.mapping);
  }

  // py: schema.py:174 `depth`.
  depth() {
    return dictDepth(this.mapping);
  }

  // py: schema.py:177 `udf_depth`.
  udfDepth() {
    return dictDepth(this.udfMapping);
  }

  // py: schema.py:180 `supported_table_args` property.
  get supportedTableArgs() {
    if (!this._supportedTableArgs.length && truthy(this.mapping)) {
      const depth = this.depth();
      if (!depth) {
        this._supportedTableArgs = [];
      } else if (depth >= 1 && depth <= 3) {
        this._supportedTableArgs = exp.TABLE_PARTS.slice(0, depth);
      } else {
        throw new SchemaError(`Invalid mapping shape. Depth: ${depth}`);
      }
    }
    return this._supportedTableArgs;
  }

  // py: schema.py:194 `table_parts`.
  tableParts(table) {
    return [...table.parts].reverse().map((p) => p.name);
  }

  // py: schema.py:197 `udf_parts`.
  udfParts(udf) {
    // a.b.c(...) is represented as Dot(Dot(a, b), Anonymous(c, ...))
    const parent = udf.parent;
    const parts = parent instanceof exp.Dot ? [...parent.flatten()].map((p) => p.name) : [udf.name];
    return [...parts].reverse().slice(0, this.udfDepth());
  }

  // py: schema.py:203 `_find_in_trie`.
  _findInTrie(parts, trie, raiseOnMissing) {
    const [value, subtrie] = inTrie(trie, parts);

    if (value === TrieResult.FAILED) return null;

    if (value === TrieResult.PREFIX) {
      const possibilities = flattenSchema(subtrie);

      if (possibilities.length === 1) {
        parts.push(...possibilities[0]);
      } else {
        if (raiseOnMissing) {
          const joinedParts = parts.join(".");
          const message = possibilities.map((p) => p.join(".")).join(", ");
          throw new SchemaError(`Ambiguous mapping for ${joinedParts}: ${message}.`);
        }
        return null;
      }
    }

    return parts;
  }

  // py: schema.py:229 `find`.
  find(table, raiseOnMissing = true, ensureDataTypes = false) { // eslint-disable-line no-unused-vars
    const parts = this.tableParts(table).slice(0, this.supportedTableArgs.length);
    const resolvedParts = this._findInTrie(parts, this.mappingTrie, raiseOnMissing);

    if (resolvedParts === null) return null;

    return this.nestedGet(resolvedParts, null, raiseOnMissing);
  }

  // py: schema.py:251 `find_udf`.
  findUdf(udf, raiseOnMissing = false) {
    const parts = this.udfParts(udf);
    const resolvedParts = this._findInTrie(parts, this.udfTrie, raiseOnMissing);

    if (resolvedParts === null) return null;

    return nestedGet(
      this.udfMapping,
      ...zip(resolvedParts, [...resolvedParts].reverse()),
      { raiseOnMissing },
    );
  }

  // py: schema.py:274 `nested_get` (method).
  nestedGet(parts, d = null, raiseOnMissing = true) {
    return nestedGet(
      d || this.mapping,
      ...zip(this.supportedTableArgs, [...parts].reverse()),
      { raiseOnMissing },
    );
  }
}

// The `Symbol.hasInstance` override promised in `Schema`'s own class comment (file
// header, and the doc comment above `Schema`): only `AbstractMappingSchema` subclasses
// -- concretely just `MappingSchema` in this file -- implement the `Schema` contract,
// so `ensureSchema`'s `schema instanceof Schema` check is wired to that, mirroring
// upstream's real multiple inheritance without copying `Schema`'s prototype onto
// `MappingSchema`. Without this, `instanceof` falls back to the default prototype-chain
// check, which is false for every `MappingSchema` (it does not extend `Schema`) and
// would make `ensureSchema` re-wrap an already-constructed schema on every call.
Object.defineProperty(Schema, Symbol.hasInstance, {
  value(obj) {
    return obj instanceof AbstractMappingSchema;
  },
});

/**
 * py: schema.py:287 `class MappingSchema(AbstractMappingSchema, Schema)` -- schema
 * based on a nested mapping.
 *
 * schema: mapping in one of the following forms:
 *   1. {table: {col: type}}
 *   2. {db: {table: {col: type}}}
 *   3. {catalog: {db: {table: {col: type}}}}
 *   4. null - tables will be added later
 * visible: optional mapping of which columns in the schema are visible (same nesting
 * as schema, mapped to an iterable of visible column names). dialect: the dialect used
 * for custom type mappings & parsing string arguments. normalize: whether to normalize
 * identifier names according to the given dialect.
 */
export class MappingSchema extends AbstractMappingSchema {
  // py: schema.py:306 `__init__`.
  constructor(schema = null, visible = null, dialect = null, normalize = true, udfMapping = null) {
    const normalizeFlag = normalize;
    const resolvedDialect = Dialect.get_or_raise(dialect);
    const resolvedSchema = schema === null || schema === undefined ? new Map() : schema;
    const resolvedUdfMapping = udfMapping === null || udfMapping === undefined ? new Map() : udfMapping;

    // `_normalize{,Udfs}` read `this.normalize`/`this.dialect` -- both must be set
    // before `super()` runs. JS forbids touching `this` before `super()`, so the two
    // normalization calls are made as plain functions ahead of the call, using local
    // copies of the same state `this` will carry.
    const self = { normalize: normalizeFlag, dialect: resolvedDialect, _normalizedNameCache: new Map() };
    const normalizedSchema = normalizeFlag ? normalizeImpl(self, resolvedSchema) : resolvedSchema;
    const normalizedUdfMapping = normalizeFlag ? normalizeUdfsImpl(self, resolvedUdfMapping) : resolvedUdfMapping;

    super(normalizedSchema, normalizedUdfMapping);

    this.visible = visible === null || visible === undefined ? new Map() : visible;
    this.normalize = normalizeFlag;
    this._dialect = resolvedDialect;
    this._typeMappingCache = new Map();
    this._normalizedTableCache = new Map();
    this._normalizedNameCache = self._normalizedNameCache;
    this._findCache = new Map();
    this._depth = 0;
  }

  // py: schema.py:330 `dialect` property.
  get dialect() {
    return this._dialect;
  }

  // py: schema.py:335 `from_mapping_schema` classmethod.
  static fromMappingSchema(mappingSchema) {
    return new MappingSchema(
      mappingSchema.mapping,
      mappingSchema.visible,
      mappingSchema.dialect,
      mappingSchema.normalize,
      mappingSchema.udfMapping,
    );
  }

  // py: schema.py:345 `find` -- overrides AbstractMappingSchema.find with caching and
  // optional string->DataType coercion.
  find(table, raiseOnMissing = true, ensureDataTypes = false) {
    const cacheKey = tableCacheKey(table, ensureDataTypes);
    let schema = this._findCache.has(cacheKey) ? this._findCache.get(cacheKey) : null;

    if (schema === null) {
      schema = super.find(table, raiseOnMissing);
      if (ensureDataTypes && isDict(schema)) {
        const converted = new Map();
        for (const [col, dtype] of dictEntries(schema)) {
          converted.set(col, typeof dtype === "string" ? this._toDataType(dtype) : dtype);
        }
        schema = converted;
      }
      this._findCache.set(cacheKey, schema);
    }

    return schema;
  }

  // py: schema.py:362 `copy`. `**kwargs: Unpack[SchemaArgs]` is a real kwargs splat,
  // so it becomes a trailing options object; every other param stays positional.
  copy(schema = null, kwargs = {}) {
    const mappingKwargs = {
      visible: new Map(this.visible instanceof Map ? this.visible : Object.entries(this.visible)),
      dialect: this.dialect,
      normalize: this.normalize,
      udfMapping: new Map(this.udfMapping instanceof Map ? this.udfMapping : Object.entries(this.udfMapping)),
      ...kwargs,
    };
    const copiedMapping = schema === null
      ? new Map(this.mapping instanceof Map ? this.mapping : Object.entries(this.mapping))
      : schema;
    return new MappingSchema(
      copiedMapping,
      mappingKwargs.visible,
      mappingKwargs.dialect,
      mappingKwargs.normalize,
      mappingKwargs.udfMapping,
    );
  }

  // py: schema.py:374 `add_table`.
  addTable(table, columnMapping = null, dialect = null, normalize = null, matchDepth = true) {
    const normalizedTable = this._normalizeTable(table, dialect, normalize);

    if (matchDepth && !this.empty && normalizedTable.parts.length !== this.depth()) {
      throw new SchemaError(
        `Table ${normalizedTable.sql(this.dialect)} must match the ` +
          `schema's nesting level: ${this.depth()}.`,
      );
    }

    const normalizedColumnMapping = new Map();
    for (const [key, value] of dictEntries(ensureColumnMapping(columnMapping))) {
      normalizedColumnMapping.set(this._normalizeName(key, dialect, false, normalize), value);
    }

    const schema = this.find(normalizedTable, false);
    if (truthy(schema) && !truthy(normalizedColumnMapping)) return;

    const parts = this.tableParts(normalizedTable);

    nestedSet(this.mapping, [...parts].reverse(), normalizedColumnMapping);
    newTrie([parts], this.mappingTrie);
    this._findCache.delete(tableCacheKey(normalizedTable, true));
    this._findCache.delete(tableCacheKey(normalizedTable, false));
  }

  // py: schema.py:417 `column_names`.
  columnNames(table, onlyVisible = false, dialect = null, normalize = null) {
    const normalizedTable = this._normalizeTable(table, dialect, normalize);

    const schema = this.find(normalizedTable);
    if (schema === null) return [];

    if (!onlyVisible || !truthy(this.visible)) return dictKeys(schema);

    // py: `self.nested_get(..., self.visible)` -- `raise_on_missing` is NOT passed, so
    // it keeps the method's own default of True: a table missing from `self.visible`
    // RAISES here, same as an unset table would in `find`. The `or []` fallback below
    // only ever catches a present-but-EMPTY visible-columns entry, not a missing one.
    const visible = this.nestedGet(this.tableParts(normalizedTable), this.visible) || [];
    const visibleSet = visible instanceof Set ? visible : new Set(visible);
    return dictKeys(schema).filter((col) => visibleSet.has(col));
  }

  // py: schema.py:436 `get_column_type`.
  getColumnType(table, column, dialect = null, normalize = null) {
    const normalizedTable = this._normalizeTable(table, dialect, normalize);

    const normalizedColumnName = this._normalizeName(
      typeof column === "string" ? column : column.this,
      dialect,
      false,
      normalize,
    );

    const tableSchema = this.find(normalizedTable, false);
    if (truthy(tableSchema)) {
      const columnType = dictGet(tableSchema, normalizedColumnName);

      if (columnType instanceof exp.DataType) return columnType;
      if (typeof columnType === "string") return this._toDataType(columnType, dialect);
    }

    return exp.DType.UNKNOWN.into_expr();
  }

  // py: schema.py:460 `get_udf_type`.
  getUdfType(udf, dialect = null, normalize = null) {
    const parts = this._normalizeUdf(udf, dialect, normalize);
    const resolvedParts = this._findInTrie(parts, this.udfTrie, false);

    if (resolvedParts === null) return exp.DType.UNKNOWN.into_expr();

    const udfType = nestedGet(
      this.udfMapping,
      ...zip(resolvedParts, [...resolvedParts].reverse()),
      { raiseOnMissing: false },
    );

    if (udfType instanceof exp.DataType) return udfType;
    if (typeof udfType === "string") return this._toDataType(udfType, dialect);

    return exp.DType.UNKNOWN.into_expr();
  }

  // py: schema.py:496 `has_column`.
  hasColumn(table, column, dialect = null, normalize = null) {
    const normalizedTable = this._normalizeTable(table, dialect, normalize);

    const normalizedColumnName = this._normalizeName(
      typeof column === "string" ? column : column.this,
      dialect,
      false,
      normalize,
    );

    const tableSchema = this.find(normalizedTable, false);
    return truthy(tableSchema) ? dictHas(tableSchema, normalizedColumnName) : false;
  }

  // py: schema.py:512 `_normalize`.
  _normalize(schema) {
    return normalizeImpl(this, schema);
  }

  // py: schema.py:550 `_normalize_udfs`.
  _normalizeUdfs(udfs) {
    return normalizeUdfsImpl(this, udfs);
  }

  // py: schema.py:569 `_normalize_udf`.
  _normalizeUdf(udf, dialect = null, normalize = null) {
    const dlct = dialect || this.dialect;
    const norm = normalize === null || normalize === undefined ? this.normalize : normalize;

    if (typeof udf === "string") {
      const parsed = exp.maybeParse(udf, { dialect: dlct });

      if (parsed instanceof exp.Anonymous) {
        udf = parsed;
      } else if (parsed instanceof exp.Dot && parsed.expression instanceof exp.Anonymous) {
        udf = parsed.expression;
      } else {
        // deny:implicit_str sqlglot/schema.py:597
        throw new SchemaError(`Unable to parse UDF from: ${exp.toS(udf)}`);
      }
    }
    let parts = this.udfParts(udf);

    if (norm) {
      parts = parts.map((part) => this._normalizeName(part, dlct, true, undefined));
    }

    return parts;
  }

  // py: schema.py:605 `_normalize_table`.
  _normalizeTable(table, dialect = null, normalize = null) {
    const dlct = dialect || this.dialect;
    const norm = normalize === null || normalize === undefined ? this.normalize : normalize;

    if (table instanceof exp.Table) {
      const cacheKey = `${table.hash()} ${dlct.constructor.name} ${norm}`;
      const cached = this._normalizedTableCache.get(cacheKey);
      if (cached) return cached;
    }

    const normalizedTable = exp.maybeParse(table, { into: exp.Table, dialect: dlct, copy: norm });

    if (norm) {
      for (const part of normalizedTable.parts) {
        if (part instanceof exp.Identifier) {
          part.replace(normalizeName(part, dlct, true, norm));
        }
      }
    }

    const storeKey = `${normalizedTable.hash()} ${dlct.constructor.name} ${norm}`;
    this._normalizedTableCache.set(storeKey, normalizedTable);
    return normalizedTable;
  }

  // py: schema.py:633 `_normalize_name`.
  _normalizeName(name, dialect = null, isTable = false, normalize = null) {
    const norm = normalize === null || normalize === undefined ? this.normalize : normalize;
    const dlct = dialect || this.dialect;
    const nameStr = typeof name === "string" ? name : name.name;
    // py: `if cached := self._normalized_name_cache.get(cache_key): return cached` is a
    // walrus TRUTHINESS check, not an "is not None" one -- an empty-string cached
    // result (an empty identifier name) is a self-correcting cache miss in upstream
    // too, reproduced here with the same falsy check rather than `.has()`.
    //
    // Cache bucketed by `dlct.constructor` (the dialect CLASS), matching upstream's
    // `hash(type(self))`/class-only `Dialect.__eq__` (dialects/dialect.js:2001-2013,
    // this port's own `equals`/`hash`) -- two differently-configured instances of the
    // SAME dialect class collide onto the same cache entry in real CPython too.
    const cacheKey = `${nameStr} ${dlct.constructor.name} ${isTable} ${norm}`;
    const cached = this._normalizedNameCache.get(cacheKey);
    if (cached) return cached;

    const result = normalizeName(name, dlct, isTable, norm).name;

    this._normalizedNameCache.set(cacheKey, result);
    return result;
  }

  // py: schema.py:659 `depth`.
  depth() {
    if (!this.empty && !this._depth) {
      // The columns themselves are a mapping, but we don't want to include those
      this._depth = super.depth() - 1;
    }
    return this._depth;
  }

  // py: schema.py:665 `_to_data_type`.
  _toDataType(schemaType, dialect = null) {
    if (!this._typeMappingCache.has(schemaType)) {
      const dlct = dialect ? Dialect.get_or_raise(dialect) : this.dialect;
      const udt = dlct.constructor.SUPPORTS_USER_DEFINED_TYPES;

      try {
        const expression = exp.DataType.fromStr(schemaType, { dialect: dlct, udt });
        expression.transform((node) => dlct.normalize_identifier(node), { copy: false });
        this._typeMappingCache.set(schemaType, expression);
      } catch (e) {
        // py: `except AttributeError` -- the closest JS analogue of "the object
        // returned didn't have the method we expected" is a TypeError; anything else
        // (notably ParseError, which upstream's own `from_str` re-raises when
        // `udt=False` and the string doesn't parse) propagates, matching upstream.
        if (!(e instanceof TypeError)) throw e;
        const inDialect = dialect ? ` in dialect ${dialect}` : "";
        throw new SchemaError(`Failed to build type '${schemaType}'${inDialect}.`);
      }
    }

    return this._typeMappingCache.get(schemaType);
  }
}

// Shared by both the constructor (before `super()`, see its own comment) and the
// `_normalize`/`_normalizeUdfs` instance methods -- `self` is either `this` or the
// pre-`super()` stand-in built in the constructor; both expose `.normalize`,
// `.dialect`, `._normalizedNameCache`, and (for the instance case) `._normalizeName`.
function normalizeName_(self, name, dialect, isTable, normalize) {
  if (typeof self._normalizeName === "function") return self._normalizeName(name, dialect, isTable, normalize);
  const norm = normalize === null || normalize === undefined ? self.normalize : normalize;
  const dlct = dialect || self.dialect;
  const nameStr = typeof name === "string" ? name : name.name;
  const cacheKey = `${nameStr} ${dlct.constructor.name} ${isTable} ${norm}`;
  const cached = self._normalizedNameCache.get(cacheKey);
  if (cached) return cached;
  const result = normalizeName(name, dlct, isTable, norm).name;
  self._normalizedNameCache.set(cacheKey, result);
  return result;
}

// py: schema.py:512 `_normalize` body, factored out so the constructor can call it
// before `super()` (see MappingSchema's constructor comment).
function normalizeImpl(self, schema) {
  const normalizedMapping = new Map();
  const flattenedSchema = flattenSchema(schema);
  const fmt = (a, b) => `Table ${a} must match the schema's nesting level: ${b}.`;

  for (const keys of flattenedSchema) {
    const columns = nestedGet(schema, ...zip(keys, keys));

    if (!isDict(columns)) {
      throw new SchemaError(fmt(keys.slice(0, -1).join("."), flattenedSchema[0].length));
    }
    if (!truthy(columns)) {
      throw new SchemaError(`Table ${keys.slice(0, -1).join(".")} must have at least one column`);
    }
    if (isDict(first(dictValues(columns)))) {
      throw new SchemaError(
        fmt([...keys, ...flattenSchema(columns)[0]].join("."), flattenedSchema[0].length),
      );
    }

    const normalizedKeys = keys.map((key) => normalizeName_(self, key, null, true, null));
    for (const [columnName, columnType] of dictEntries(columns)) {
      nestedSet(normalizedMapping, [...normalizedKeys, normalizeName_(self, columnName, null, false, null)], columnType);
    }
  }

  return normalizedMapping;
}

// py: schema.py:550 `_normalize_udfs` body, factored out for the same before-`super()`
// reason as `normalizeImpl`.
function normalizeUdfsImpl(self, udfs) {
  const normalizedMapping = new Map();

  for (const keys of flattenSchema(udfs, dictDepth(udfs))) {
    const udfType = nestedGet(udfs, ...zip(keys, keys));
    const normalizedKeys = keys.map((key) => normalizeName_(self, key, null, true, null));
    nestedSet(normalizedMapping, normalizedKeys, udfType);
  }

  return normalizedMapping;
}

/**
 * py: schema.py:691 `normalize_name`.
 *
 * `identifier` may be a `str` or an `exp.Identifier`; `dialect`/`isTable`/`normalize`
 * are all positional-or-keyword upstream (no `*`), so they stay positional here too.
 */
export function normalizeName(identifier, dialect = null, isTable = false, normalize = true) {
  if (typeof identifier === "string") {
    identifier = exp.parseIdentifier(identifier, dialect);
  } else if (normalize) {
    identifier = identifier.copy();
  }

  if (!normalize) return identifier;

  // this is used for normalize_identifier, bigquery has special rules pertaining tables
  identifier.meta.is_table = isTable;
  return Dialect.get_or_raise(dialect).normalize_identifier(identifier);
}

/** py: schema.py:710 `ensure_schema`. `**kwargs` is a real splat -> options object. */
export function ensureSchema(schema, kwargs = {}) {
  if (schema instanceof Schema) return schema;

  return new MappingSchema(
    schema,
    kwargs.visible,
    kwargs.dialect,
    kwargs.normalize ?? true,
    kwargs.udfMapping,
  );
}

/** py: schema.py:719 `ensure_column_mapping`. */
export function ensureColumnMapping(mapping) {
  if (mapping === null || mapping === undefined) return new Map();
  if (mapping instanceof Map) return mapping;
  if (isDict(mapping)) return new Map(Object.entries(mapping));
  if (typeof mapping === "string") {
    const colNameTypeStrs = mapping.split(",").map((x) => x.trim());
    const result = new Map();
    for (const nameTypeStr of colNameTypeStrs) {
      const parts = nameTypeStr.split(":");
      // py: `name_type_str.split(":")[1]` -- IndexError if there is no second part.
      if (parts.length < 2) throw new PyIndexError("list index out of range");
      result.set(parts[0].trim(), parts[1].trim());
    }
    return result;
  }
  if (Array.isArray(mapping)) {
    const result = new Map();
    for (const x of mapping) result.set(x.trim(), null);
    return result;
  }

  throw new PyValueError(`Invalid mapping provided: ${typeof mapping}`);
}

/** py: schema.py:736 `flatten_schema`. `depth`/`keys` stay positional (no `*`). */
export function flattenSchema(schema, depth = null, keys = null) {
  const tables = [];
  keys = keys || [];
  depth = depth === null || depth === undefined ? dictDepth(schema) - 1 : depth;

  for (const [k, v] of dictEntries(schema)) {
    if (depth === 1 || !isDict(v)) {
      tables.push([...keys, k]);
    } else if (depth >= 2) {
      tables.push(...flattenSchema(v, depth - 1, [...keys, k]));
    }
  }

  return tables;
}

/**
 * py: schema.py:752 `nested_get`.
 *
 * `*path: tuple[str, str]` is variadic; each entry is a `[name, key]` pair. Params
 * after a bare `*args` are implicitly keyword-only in Python, so `raise_on_missing`
 * travels in a trailing options object here, matching this project's convention for
 * genuinely keyword-only parameters.
 */
export function nestedGet(d, ...rest) {
  let raiseOnMissing = true;
  let path = rest;
  const last = rest.at(-1);
  if (last && !Array.isArray(last) && typeof last === "object" && "raiseOnMissing" in last) {
    raiseOnMissing = last.raiseOnMissing;
    path = rest.slice(0, -1);
  }

  let result = d;
  for (const [name0, key] of path) {
    result = dictGet(result, key);
    if (result === null || result === undefined) {
      if (raiseOnMissing) {
        const name = name0 === "this" ? "table" : name0;
        throw new PyValueError(`Unknown ${name}: ${key}`);
      }
      return null;
    }
  }

  return result;
}

/**
 * py: schema.py:779 `nested_set`. In-place set a value for a nested dictionary.
 *
 * New intermediate levels are created as `Map` (see file header) even when `d` itself
 * is a plain object passed in by a caller.
 */
export function nestedSet(d, keys, value) {
  if (!keys.length) return d;

  if (keys.length === 1) {
    dictSet(d, keys[0], value);
    return d;
  }

  let subd = d;
  for (const key of keys.slice(0, -1)) {
    if (!dictHas(subd, key)) {
      const next = new Map();
      dictSet(subd, key, next);
      subd = next;
    } else {
      subd = dictGet(subd, key);
    }
  }

  dictSet(subd, keys.at(-1), value);
  return d;
}
