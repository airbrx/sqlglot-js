// py: sqlglot/expressions/core.py @ pinned ref (see corpus/PROVENANCE.json)
// Core tree semantics.  The class catalogue is generated separately; this module is
// intentionally ignorant of it and receives the catalogue through registerExprClasses.

const MASK64 = (1n << 64n) - 1n;
const SIGN64 = 1n << 63n;
const POSITION_META_KEYS = ["line", "col", "start", "end"];
const SQLGLOT_META = "sqlglot.meta";
// Fidelity census anchors for methods whose JS spellings are implemented explicitly below.
// deny:operators sqlglot/expressions/core.py:1105
// deny:operators sqlglot/expressions/core.py:2729
// deny:implicit_str sqlglot/expressions/core.py:1782
// deny:implicit_str sqlglot/expressions/core.py:2567

// py: str.splitlines (the JS newline regexes omit several CPython boundaries).
function pySplitlines(s) { return String(s).split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/); }
function dedent(s) {
  const lines = pySplitlines(s); let margin = Infinity;
  for (const line of lines) if (line.trim()) margin = Math.min(margin, line.match(/^[ \t]*/)[0].length);
  return lines.map(x => x.slice(Number.isFinite(margin) ? margin : 0)).join("\n");
}

let CLASS_REGISTRY = new Map();
let ENUM_REGISTRY = new Map();
let TYPE_REGISTRY = new Map();
let DIALECT_REGISTRY = new Map();
const INIT_HOOKS = new Map();

export function registerExprClasses(classes) {
  CLASS_REGISTRY = classes instanceof Map ? classes : new Map(Object.entries(classes));
}
export function registerAstEnums(enums) { ENUM_REGISTRY = enums instanceof Map ? enums : new Map(Object.entries(enums)); }
export function registerAstTypes(types) { TYPE_REGISTRY = types instanceof Map ? types : new Map(Object.entries(types)); }
export function registerAstDialects(dialects) { DIALECT_REGISTRY = dialects instanceof Map ? dialects : new Map(Object.entries(dialects)); }
export function registerInitHook(name, hook) { INIT_HOOKS.set(name, hook); }
export { INIT_HOOKS };

function invalidate(node) {
  while (node && node._hash !== null) { node._hash = null; node = node.parent; }
}

function boolValue(s) {
  const v = String(s).toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return s;
}

function fnv(s, h = 0xcbf29ce484222325n) {
  for (const c of String(s)) { h ^= BigInt(c.codePointAt(0)); h = (h * 0x100000001b3n) & MASK64; }
  return h;
}
function signed(h) { return h & SIGN64 ? h - (1n << 64n) : h; }
function hashValue(v) {
  if (v instanceof Expr) return BigInt.asUintN(64, v.hash());
  if (typeof v === "string") return fnv(`s:${v}`);
  if (typeof v === "boolean") return fnv(v ? "b:1" : "b:0");
  if (typeof v === "bigint") return fnv(`i:${v}`);
  if (typeof v === "number") return fnv(`n:${Object.is(v, -0) ? 0 : v}`);
  if (v === null) return fnv("null");
  if (Array.isArray(v)) { let h = fnv("list"); for (const x of v) h = fnv(hashValue(x), h); return h; }
  return fnv(`o:${String(v)}`);
}

export class Expr {
  static argTypes = new Map([["this", true]]);
  static requiredArgs = new Set(["this"]);
  static key = "expr";
  static isPrimitive = false;
  static hashRawArgs = false;

  constructor(args = {}, options = undefined) {
    this.args = {};
    this.parent = null; this.argKey = null; this.index = null;
    this.comments = null; this._type = null; this._meta = null; this._hash = null;
    for (const [k, v] of Object.entries(args || {})) { this.args[k] = v; this._setParent(k, v); }
    if (!options?.skipInitHook) INIT_HOOKS.get(this.constructor.name)?.(this, args || {});
  }
  get key() { return this.constructor.key || this.constructor.name.toLowerCase(); }
  get this() { return this.args.this; }
  get expression() { return this.args.expression; }
  get expressions() { return this.args.expressions || []; }
  get isString() { return this.constructor.name === "Literal" && !!this.args.is_string; }
  get isNumber() { return this.constructor.name === "Literal" && !this.args.is_string; }
  get isInt() {
    let node = this;
    while (node?.constructor?.name === "Paren" || node?.constructor?.name === "Neg") node = node.this;
    return node?.constructor?.name === "Literal" && !node.args.is_string && /^\d+$/.test(String(node.this));
  }
  get isStar() {
    if (this.constructor.name === "Star") return true;
    if (this.constructor.name === "Column") return this.this?.constructor?.name === "Star";
    if (["Alias", "Paren", "Subquery"].includes(this.constructor.name)) return !!this.this?.isStar;
    const selections = this.args.expressions;
    return Array.isArray(selections) && selections.some(x => x instanceof Expr && x.isStar);
  }
  get alias() { const a = this.args.alias; return typeof a === "string" ? a : (a instanceof Expr ? a.name : ""); }
  get aliasColumnNames() { return (this.args.alias?.args?.columns || []).map(x => x.name); }
  get name() {
    if (typeof this.this === "string") return this.this;
    if (this.this instanceof Expr && ["Column", "Table", "Var", "Dot"].includes(this.constructor.name)) return this.this.name;
    return "";
  }
  get aliasOrName() { return this.alias || this.name; }
  get outputName() { return this.aliasOrName; }
  get type() { return (this.constructor.isDataType || this.constructor.name === "DataType") ? this : (this._type || ((this.constructor.isCast || /Cast$/.test(this.constructor.name)) ? this.args.to : null)); }
  set type(v) {
    const DataType = CLASS_REGISTRY.get("DataType");
    this._type = v && DataType && !(v instanceof DataType) ? DataType.build(v) : v;
  }
  isType(...dtypes) { return this._type !== null && this._type !== undefined && !!this._type.isType?.(...dtypes); }
  get meta() { return this._meta || (this._meta = {}); }
  metaGet(k, d = null) { return this._meta && k in this._meta ? this._meta[k] : d; }
  text(k) { const v = this.args[k]; return typeof v === "string" ? v : (v instanceof Expr && typeof v.this === "string" ? v.this : ""); }
  toPy() {
    const name = this.constructor.name;
    if (name === "Null") return null;
    if (name === "Boolean") return typeof this.this === "string" ? this.this.toLowerCase() === "true" : !!this.this;
    if (name === "Literal") {
      if (this.args.is_string) return this.this;
      const s = String(this.this);
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) throw new Error(`Invalid numeric literal: ${s}`);
      return s.includes(".") || /e/i.test(s) ? Number(s) : Number.parseInt(s, 10);
    }
    if (name === "Paren") return this.this.toPy();
    if (name === "Neg") return -this.this.toPy();
    throw new Error(`${name} cannot be converted to a JavaScript value`);
  }
  isLeaf() { return !Object.values(this.args).some(v => (v instanceof Expr || Array.isArray(v)) && (Array.isArray(v) ? v.length : true)); }
  get depth() { let depth = 0, node = this; while (node.parent) { depth++; node = node.parent; } return depth; }
  equals(other) { return this === other || (other?.constructor === this.constructor && this.hash() === other.hash()); }
  hash() {
    if (this._hash !== null) return this._hash;
    const nodes = [], stack = [this];
    while (stack.length) {
      const n = stack.pop(); nodes.push(n);
      for (const v of Object.values(n.args)) if (v instanceof Expr) { if (v._hash === null) stack.push(v); }
      else if (Array.isArray(v)) for (const x of v) if (x instanceof Expr && x._hash === null) stack.push(x);
    }
    for (let ni = nodes.length - 1; ni >= 0; ni--) {
      const n = nodes[ni]; let h = fnv(n.key);
      for (const k of Object.keys(n.args).sort()) {
        const v = n.args[k];
        if (n.constructor.hashRawArgs) { if (v) h = fnv(`${k}:${hashValue(v)}`, h); continue; }
        if (Array.isArray(v)) for (const x of v) h = fnv(x !== null && x !== false ? `${k}:${hashValue(typeof x === "string" ? x.toLowerCase() : x)}` : k, h);
        else if (v !== null && v !== false && v !== undefined) h = fnv(`${k}:${hashValue(typeof v === "string" ? v.toLowerCase() : v)}`, h);
      }
      n._hash = signed(h);
    }
    return this._hash;
  }
  copy() {
    const root = new this.constructor({}, { skipInitHook: true }), stack = [[this, root]];
    while (stack.length) {
      const [src, dst] = stack.pop();
      dst.comments = src.comments && [...src.comments]; dst._meta = src._meta && { ...src._meta };
      dst._hash = src._hash;
      if (src._type instanceof Expr) { const c = new src._type.constructor({}, { skipInitHook: true }); dst._type = c; stack.push([src._type, c]); } else dst._type = src._type;
      for (const [k, v] of Object.entries(src.args)) {
        if (v instanceof Expr) { const c = new v.constructor({}, { skipInitHook: true }); dst.set(k, c); stack.push([v, c]); }
        else if (Array.isArray(v)) { dst.args[k] = []; for (const x of v) { if (x instanceof Expr) { const c = new x.constructor({}, { skipInitHook: true }); dst.append(k, c); stack.push([x, c]); } else dst.append(k, x); } }
        else dst.args[k] = v; // Python deepcopy implementation deliberately shares scalars.
      }
    } return root;
  }
  _setParent(k, v, index = null) { if (v instanceof Expr) { v.parent = this; v.argKey = k; v.index = index; } else if (Array.isArray(v)) v.forEach((x, i) => this._setParent(k, x, i)); }
  append(k, v) { invalidate(this); if (!Array.isArray(this.args[k])) this.args[k] = []; this._setParent(k, v, this.args[k].length); this.args[k].push(v); return this; }
  set(k, v, index = null, overwrite = true) {
    invalidate(this);
    if (index !== null) { const xs = this.args[k] || []; if (index < 0 || index >= xs.length) return this; if (v === null) { xs.splice(index, 1); xs.slice(index).forEach((x, i) => { if (x instanceof Expr) x.index = index + i; }); return this; } if (Array.isArray(v)) xs.splice(index, 1, ...v); else if (overwrite) xs[index] = v; else xs.splice(index, 0, v); v = xs; }
    else if (v === null || v === undefined) { delete this.args[k]; return this; }
    this.args[k] = v; this._setParent(k, v, index); return this;
  }
  setKwargs(kwargs) { if (kwargs) for (const [k, v] of Object.entries(kwargs)) this.set(k, v); return this; }
  *iterExpressions(reverse = false) { const vs = Object.values(this.args); if (reverse) vs.reverse(); for (const v of vs) { if (Array.isArray(v)) { const xs = reverse ? [...v].reverse() : v; for (const x of xs) if (x instanceof Expr) yield x; } else if (v instanceof Expr) yield v; } }
  *dfs(prune = null) { const s = [this]; while (s.length) { const n = s.pop(); yield n; if (!prune?.(n)) for (const x of n.iterExpressions(true)) s.push(x); } }
  *bfs(prune = null) { const q = [this]; for (let i = 0; i < q.length; i++) { const n = q[i]; yield n; if (!prune?.(n)) q.push(...n.iterExpressions()); } }
  walk(bfs = true, prune = null) { return bfs ? this.bfs(prune) : this.dfs(prune); }
  find(...types) { let bfs = true; if (typeof types.at(-1) === "boolean") bfs = types.pop(); for (const x of this.walk(bfs)) if (types.some(t => x instanceof t)) return x; return null; }
  *findAll(...types) { let bfs = true; if (typeof types.at(-1) === "boolean") bfs = types.pop(); for (const x of this.walk(bfs)) if (types.some(t => x instanceof t)) yield x; }
  findAncestor(...types) { let x = this.parent; while (x && !types.some(t => x instanceof t)) x = x.parent; return x; }
  get parentSelect() { let x = this.parent; while (x && x.constructor.name !== "Select") x = x.parent; return x; }
  get sameParent() { return !!this.parent && this.parent.constructor === this.constructor; }
  root() { let x = this; while (x.parent) x = x.parent; return x; }
  unnest() { let x = this; while (x.constructor.name === "Paren") x = x.this; return x; }
  unalias() { return this.constructor.name === "Alias" ? this.this : this; }
  unnestOperands() { return [...this.iterExpressions()].map(x => x.unnest()); }
  *flatten(unnest = true) {
    const stack = [this];
    while (stack.length) {
      let node = stack.pop(); if (unnest) node = node.unnest();
      if (node !== this && node.constructor !== this.constructor) yield node;
      else { const operands = [node.args.expression, node.args.this].filter(x => x instanceof Expr); if (!operands.length) yield node; else stack.push(...operands); }
    }
  }
  transform(fun, ...rest) {
    let options = {}; if (rest.length && rest.at(-1) && rest.at(-1).constructor === Object) options = rest.pop();
    const root = options.copy === false ? this : this.copy(), stack = [root];
    let result = root;
    while (stack.length) {
      const node = stack.pop(), replacement = fun(node, ...rest);
      if (replacement !== node) { if (node === result) result = replacement; else node.replace(replacement); continue; }
      for (const child of node.iterExpressions(true)) stack.push(child);
    }
    return result;
  }
  replace(v) {
    const p = this.parent;
    if (!p || p === v) return v;
    if (this.argKey) {
      const current = p.args[this.argKey];
      // Python treats replacing a scalar child by a list as replacement of the
      // containing expression (the common transform callback splice idiom).
      if (Array.isArray(v) && current instanceof Expr && current.parent) current.parent.replace(v);
      else p.set(this.argKey, v, this.index);
    }
    if (v !== this) { this.parent = this.argKey = this.index = null; }
    return v;
  }
  pop() { this.replace(null); return this; }
  sql(dialect = null, options = {}) {
    if (!GENERATE) throw new Error("No SQL generator registered (available in P4)");
    return GENERATE(this, { dialect, copy: options.copy ?? true, ...options });
  }
  dump() { return astDump(this); }
  static load(obj) { return astLoad(obj); }
  and_(...expressions) { return combine(this, expressions, "And"); }
  or_(...expressions) { return combine(this, expressions, "Or"); }
  not_(copy = true) { return new (cls("Not"))({ this: maybeCopy(this, copy) }); }
  as_(alias, options = {}) { return alias_(this, alias, options); }
  _binop(klass, other, reverse = false) {
    let left = this.copy(), right = convert(other, true);
    const Binary = cls("Binary"), Paren = cls("Paren");
    if (!(left instanceof klass) && !(right instanceof klass)) {
      if (left instanceof Binary) left = new Paren({ this: left });
      if (right instanceof Binary) right = new Paren({ this: right });
    }
    return new klass(reverse ? { this: right, expression: left } : { this: left, expression: right });
  }
  bracket(...expressions) { return new (cls("Bracket"))({ this: this.copy(), expressions: expressions.flat().map(x => convert(x, true)) }); }
  [Symbol.iterator]() {
    if (!this.constructor.argTypes?.has("expressions")) throw new TypeError(`'${this.constructor.name}' object is not iterable`);
    return this.expressions[Symbol.iterator]();
  }
  isin(...expressions) {
    let options = {};
    if (expressions.at(-1)?.constructor === Object) options = expressions.pop();
    return new (cls("In"))({ this: maybeCopy(this, options.copy ?? true), expressions: expressions.map(x => convert(x, options.copy ?? true)), query: options.query ? maybeParse(options.query, options) : null });
  }
  between(low, high, options = {}) { const n = new (cls("Between"))({ this: maybeCopy(this, options.copy ?? true), low: convert(low, options.copy ?? true), high: convert(high, options.copy ?? true) }); if (options.symmetric !== undefined) n.set("symmetric", options.symmetric); return n; }
  is_(x) { return this._binop(cls("Is"), x); }
  like(x) { return this._binop(cls("Like"), x); }
  ilike(x) { return this._binop(cls("ILike"), x); }
  eq(x) { return this._binop(cls("EQ"), x); }
  neq(x) { return this._binop(cls("NEQ"), x); }
  rlike(x) { return this._binop(cls("RegexpLike"), x); }
  div(x, typed = false, safe = false) { const n = this._binop(cls("Div"), x); n.set("typed", typed); n.set("safe", safe); return n; }
  asc(nullsFirst = true) { return new (cls("Ordered"))({ this: this.copy(), nulls_first: nullsFirst }); }
  desc(nullsFirst = false) { return new (cls("Ordered"))({ this: this.copy(), desc: true, nulls_first: nullsFirst }); }
  lt(x) { return this._binop(cls("LT"), x); } lte(x) { return this._binop(cls("LTE"), x); }
  gt(x) { return this._binop(cls("GT"), x); } gte(x) { return this._binop(cls("GTE"), x); }
  add(x) { return this._binop(cls("Add"), x); } radd(x) { return this._binop(cls("Add"), x, true); }
  sub(x) { return this._binop(cls("Sub"), x); } rsub(x) { return this._binop(cls("Sub"), x, true); }
  mul(x) { return this._binop(cls("Mul"), x); } rmul(x) { return this._binop(cls("Mul"), x, true); }
  truediv(x) { return this._binop(cls("Div"), x); } rtruediv(x) { return this._binop(cls("Div"), x, true); }
  floordiv(x) { return this._binop(cls("IntDiv"), x); } rfloordiv(x) { return this._binop(cls("IntDiv"), x, true); }
  mod(x) { return this._binop(cls("Mod"), x); } rmod(x) { return this._binop(cls("Mod"), x, true); }
  pow(x) { return this._binop(cls("Pow"), x); } rpow(x) { return this._binop(cls("Pow"), x, true); }
  and(x) { return this._binop(cls("And"), x); } rand(x) { return this._binop(cls("And"), x, true); }
  or(x) { return this._binop(cls("Or"), x); } ror(x) { return this._binop(cls("Or"), x, true); }
  neg() { const value = this.copy(), Binary = cls("Binary"); return new (cls("Neg"))({ this: value instanceof Binary ? new (cls("Paren"))({ this: value }) : value }); }
  invert() { return this.not_(true); }
  pipe(func, ...args) { return func(this, ...args); }
  apply(func, ...args) { func(this, ...args); return this; }
  assertIs(type) { if (!(this instanceof type)) throw new Error(`${this} is not ${type.name}.`); return this; }
  errorMessages(args = null) {
    const errors = [];
    for (const key of this.constructor.requiredArgs || []) if (this.args[key] === null || this.args[key] === undefined || (Array.isArray(this.args[key]) && !this.args[key].length)) errors.push(`Required keyword: '${key}' missing for ${this.constructor.name}`);
    if (args && !this.constructor.isVarLenArgs && args.length > this.constructor.argTypes.size) errors.push(`The number of provided arguments (${args.length}) is greater than the maximum number of supported arguments (${this.constructor.argTypes.size})`);
    return errors;
  }
  addComments(comments = null, prepend = false) { this.comments ||= []; for (const c of comments || []) { const parts = c.split(SQLGLOT_META); if (parts.length > 1) for (const kv of parts.slice(1).join("").split(",")) { const [k, ...v] = kv.split("="); this.meta[k.trim()] = boolValue(v.length ? v[0].trim() : true); } if (!prepend) this.comments.push(c); } if (prepend && comments) this.comments = [...comments, ...this.comments]; return this; }
  popComments() { const c = this.comments || []; this.comments = null; return c; }
  updatePositions(other = null, line = null, col = null, start = null, end = null) {
    if (other && !(other instanceof Expr) && "line" in other && "col" in other) {
      Object.assign(this.meta, { line: other.line, col: other.col, start: other.start, end: other.end });
    } else if (other instanceof Expr) {
      if (other._meta) for (const k of POSITION_META_KEYS) if (k in other._meta) this.meta[k] = other._meta[k];
    } else {
      Object.assign(this.meta, { line, col, start, end });
    }
    return this;
  }
  toString() { return toS(this); }
}

export function defineExpr(meta, Base = Expr) {
  const name = meta.name;
  const C = { [name]: class extends Base {} }[name];
  C.key = meta.key || name.toLowerCase();
  C.argTypes = new Map(meta.arg_types || meta.argTypes || []);
  C.requiredArgs = new Set(meta.required_args || meta.requiredArgs || [...C.argTypes].filter(([, v]) => v).map(([k]) => k));
  C.isPrimitive = !!(meta.is_primitive ?? meta.isPrimitive); C.hashRawArgs = !!(meta.hash_raw_args ?? meta.hashRawArgs);
  C.traits = Object.freeze([...(meta.traits || [])]);
  C.bases = Object.freeze([...(meta.bases || [])]); C.initOwner = meta.init_owner ?? meta.initOwner ?? null;
  const names = Object.freeze([...(meta.sqlNames || [name.toUpperCase()])]);
  C.sqlNames = () => names;
  C.sqlName = () => names[0];
  // Python's multiple inheritance is represented by the generated `bases` closure.
  // This preserves the useful `instanceof Trait` spelling without attempting to copy
  // trait prototypes onto 1,048 constructors.
  Object.defineProperty(C, Symbol.hasInstance, { value(obj) {
    return !!obj && (obj.constructor === C || obj.constructor?.bases?.includes(name) || obj.constructor?.traits?.includes(name));
  }});
  return C;
}

function pyScalar(v, reprStr = false) {
  if (v === null || v === undefined) return "None"; if (v === true) return "True"; if (v === false) return "False";
  if (typeof v === "string" && reprStr) {
    const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
    let escaped = "";
    for (const ch of v) {
      const cp = ch.codePointAt(0);
      if (ch === "\\") escaped += "\\\\";
      else if (ch === "\n") escaped += "\\n";
      else if (ch === "\r") escaped += "\\r";
      else if (ch === "\t") escaped += "\\t";
      else if (ch === quote) escaped += `\\${quote}`;
      else if (cp < 0x20 || cp === 0x7f) escaped += `\\x${(`0${cp.toString(16)}`).slice(-2)}`;
      else escaped += ch;
    }
    return `${quote}${escaped}${quote}`;
  }
  if (typeof v === "string") {
    // py: expressions/core.py:2622 — dedent/strip-newlines/splitlines. This is
    // observable for ByteString containing only indentation whitespace.
    const stripped = v.replace(/^\n+|\n+$/g, "");
    const lines = stripped.split(/\r\n|\r|\n|\v|\f|\x1c|\x1d|\x1e|\x85|\u2028|\u2029/);
    const nonblank = lines.filter((line) => line.trim()).map((line) => line.match(/^[ \t]*/)[0].length);
    const margin = nonblank.length ? Math.min(...nonblank) : (lines[0]?.length ?? 0);
    return lines.map((line) => line.slice(margin)).join("\n");
  }
  if (v && v.__dialect__) {
    const module = v.__dialect__.toLowerCase();
    return `<sqlglot.dialects.${module}.${v.__dialect__} object at 0x0>`;
  }
  if (v && v.__enum__) return `${v.__enum__}.${v.name}`; return String(v);
}
export function toS(node, verbose = false, level = 0, reprStr = false) {
  let indent = `\n${"  ".repeat(level + 1)}`, delim = `,${indent}`;
  if (node instanceof Expr) {
    const args = Object.entries(node.args).filter(([,v]) => verbose || (v !== null && !(Array.isArray(v) && !v.length)));
    if ((node.type || verbose) && !(node.constructor.isDataType || node.constructor.name === "DataType")) args.push(["_type", node.type]);
    if (node.comments || verbose) args.push(["_comments", node.comments]);
    if (node.isLeaf()) { indent = ""; delim = ", "; }
    const quote = !!node.args.is_string || (node.constructor.name === "Identifier" && !!node.args.quoted);
    return `${node.constructor.name}(${indent}${args.map(([k,v]) => `${k}=${toS(v, verbose, level + 1, quote)}`).join(delim)})`;
  }
  if (Array.isArray(node)) { const items = node.map(x => toS(x, verbose, level + 1)).join(delim); return `[${items ? indent + items : ""}]`; }
  if (node && node.__tuple__) return `(${node.__tuple__.map(x => toS(x, verbose, level + 1)).join(", ")})`;
  const scalar = pyScalar(node, reprStr);
  return pySplitlines(dedent(scalar.replace(/^\n+|\n+$/g, ""))).join(indent);
}

export function astDump(node) {
  if (node && node.__enum__) return { __enum__: node.__enum__, name: node.name, value: node.value };
  if (node instanceof Expr) {
    const type = node.type;
    return { c: node.constructor.name, a: Object.entries(node.args).map(([k,v]) => [k, astDump(v)]), m: node._meta ? {...node._meta} : null, cm: node.comments ? [...node.comments] : null, t: type && type !== node ? astDump(type) : null };
  }
  if (Array.isArray(node)) return node.map(astDump);
  if (node && node.__tuple__) return { __tuple__: node.__tuple__.map(astDump) };
  return node;
}
export function astLoad(obj) {
  if (Array.isArray(obj)) return obj.map(astLoad);
  if (!obj || typeof obj !== "object") return obj;
  if (obj.c) { const C = CLASS_REGISTRY.get(obj.c) || CLASS_REGISTRY.get(obj.c.toLowerCase()); if (!C) throw new Error(`Unknown expression class: ${obj.c}`); const n = new C({}, { skipInitHook: true }); for (const [k,v] of obj.a || []) { const loaded = astLoad(v); n.args[k] = loaded; n._setParent(k, loaded); } n._meta = obj.m ? {...obj.m} : null; n.comments = obj.cm ? [...obj.cm] : null; n._type = obj.t ? astLoad(obj.t) : null; return n; }
  if (obj.__enum__) { const E = ENUM_REGISTRY.get(obj.__enum__); return E ? (E[obj.name] ?? E.get?.(obj.name)) : {...obj}; }
  if (obj.__tuple__) return { __tuple__: obj.__tuple__.map(astLoad) };
  if (obj.__type__) return TYPE_REGISTRY.get(obj.__type__) || obj;
  if (obj.__dialect__) { const D = DIALECT_REGISTRY.get(obj.__dialect__); return D ? new D() : obj; }
  return {...obj};
}

// Builder primitives (core.py). Parsing strings is intentionally injectable until P3.
export const TABLE_PARTS = Object.freeze(["this", "db", "catalog"]);
export const SAFE_IDENTIFIER_RE = /^[_a-zA-Z][\w]*$/u;
export const DType = Object.freeze({});
let PARSE = null;
let GENERATE = null;
export function registerParser(fn) { PARSE = fn; }
/** Install the P4 generator without making the expression layer depend on it. */
export function registerGenerator(fn) { GENERATE = fn; }
export function maybeCopy(x, copy = true) { return copy && x instanceof Expr ? x.copy() : x; }
function cls(name) { const C = CLASS_REGISTRY.get(name) || CLASS_REGISTRY.get(name.toLowerCase()); if (!C) throw new Error(`Unknown expression class: ${name}`); return C; }
function combine(first, rest, name, options = {}) {
  const values = [first, ...rest].filter(x => x !== null && x !== undefined).map(x => maybeParse(x, { ...options, copy: options.copy ?? true }));
  if (!values.length) return null;
  const K = cls(name), Paren = cls("Paren");
  return values.slice(1).reduce((left, right) => new K({
    this: options.wrap === false || !(left instanceof K) ? left : new Paren({ this: left }),
    expression: options.wrap === false || !(right instanceof K) ? right : new Paren({ this: right }),
  }), values[0]);
}
export function and_(...expressions) { return combine(expressions.shift(), expressions, "And"); }
export function or_(...expressions) { return combine(expressions.shift(), expressions, "Or"); }
export function not_(expression, options = {}) { return new (cls("Not"))({ this: maybeParse(expression, { ...options, copy: options.copy ?? true }) }); }
export function toIdentifier(name, quoted = null, copy = true) {
  if (name instanceof Expr) return maybeCopy(name, copy);
  return new (cls("Identifier"))({ this: String(name), quoted: quoted ?? !SAFE_IDENTIFIER_RE.test(String(name)) });
}
export function convert(value, copy = false) {
  if (value instanceof Expr) return maybeCopy(value, copy);
  if (value === null || value === undefined) return new (cls("Null"))();
  if (typeof value === "boolean") return new (cls("Boolean"))({ this: value });
  if (typeof value === "string") return new (cls("Literal"))({ this: value, is_string: true });
  if (typeof value === "number" || typeof value === "bigint") return new (cls("Literal"))({ this: String(value), is_string: false });
  if (Array.isArray(value)) return new (cls("Array"))({ expressions: value.map(x => convert(x, copy)) });
  throw new TypeError(`Cannot convert ${String(value)}`);
}
export function maybeParse(sqlOrExpression, options = {}) {
  if (sqlOrExpression instanceof Expr) return maybeCopy(sqlOrExpression, options.copy ?? false);
  if (PARSE) return PARSE(sqlOrExpression, options);
  if (options.into) return new options.into({ this: toIdentifier(sqlOrExpression, null, false) });
  // P2-safe leaf fallback; P3 replaces this through registerParser.
  return column(String(sqlOrExpression));
}
export function column(col, table = null, db = null, catalog = null, quoted = null) {
  const args = { this: toIdentifier(col, quoted, false) };
  if (table !== null) args.table = toIdentifier(table, quoted, false);
  if (db !== null) args.db = toIdentifier(db, quoted, false);
  if (catalog !== null) args.catalog = toIdentifier(catalog, quoted, false);
  return new (cls("Column"))(args);
}
export function alias_(expression, alias, options = {}) {
  const A = cls(options.table ? "TableAlias" : "Alias");
  return new A({ this: maybeCopy(expression, options.copy ?? true), alias: toIdentifier(alias, options.quoted, false) });
}
