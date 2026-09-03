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
import { pyDecimal, pyIntFromStr, decNeg } from "../_py/num.js";
import { PyValueError } from "../_py/errors.js";

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
  if (v?.__enum__) return fnv(`enum:${v.__enum__}:${v.name}:${v.value}`);
  if (v?.__tuple__) { let h = fnv("tuple"); for (const x of v.__tuple__) h = fnv(hashValue(x), h); return h; }
  if (Array.isArray(v)) { let h = fnv("list"); for (const x of v) h = fnv(hashValue(x), h); return h; }
  if (v && v.constructor === Object) { let h = fnv("dict"); for (const k of Object.keys(v).sort()) h = fnv(`${k}:${hashValue(v[k])}`, h); return h; }
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
  // py: core.py:922 `isinstance(self, Literal) and self.args["is_string"]`
  get isString() { return this instanceof cls("Literal") && !!this.args.is_string; }
  get is_string() { return this.isString; }
  /**
   * py: core.py:926
   *   (isinstance(self, Literal) and not self.args["is_string"])
   *   or (isinstance(self, Neg) and self.this.is_number)
   *
   * LITERAL-OR-NEG, and nothing else — notably NOT Paren, so `(1)` is not a number.
   * There is no predicate on the TEXT: upstream never inspects it, so a non-string
   * `Literal` is a number even when its `this` is "abc" or "". A regex here (the port
   * used one, matching `\d+`/`inf`/`nan`/`binary_double_nan`) invents a rule upstream
   * does not have, and `binary_double_nan` appears nowhere in the sqlglot tree at all.
   */
  get isNumber() {
    return (this instanceof cls("Literal") && !this.args.is_string)
      || (this instanceof cls("Neg") && !!this.this?.isNumber);
  }
  get is_number() { return this.isNumber; }
  /**
   * py: core.py:935 `self.is_number and isinstance(self.to_py(), int)`
   *
   * Delegates, rather than re-deciding. Two consequences that a hand-written check got
   * wrong: `Paren(Literal('1'))` is NOT an int (Paren is not in `is_number`), and
   * `Literal('abc')` does not return false — `to_py()` RAISES, and upstream lets that
   * propagate. `int` is `bigint` on this side; `Decimal` is not an int, so `1.5`,
   * `1e5`, `inf` and `nan` are all false.
   */
  get isInt() { return this.isNumber && typeof this.toPy() === "bigint"; }
  get is_int() { return this.isInt; }
  // py: core.py:939.  Only a Star, or a Column wrapping one.  Select, SetOperation,
  // Subquery and Dot each override this (installed in query_methods.js); nothing else
  // does -- notably not Alias or Paren, and not "any node with a starred expression",
  // which would make Tuple([Star]) and Array([Star]) starred when upstream says no.
  get isStar() {
    return this instanceof cls("Star") || (this instanceof cls("Column") && this.this instanceof cls("Star"));
  }
  get alias() { const a = this.args.alias; return typeof a === "string" ? a : (a instanceof Expr ? a.name : ""); }
  get aliasColumnNames() { return (this.args.alias?.args?.columns || []).map(x => x.name); }
  get name() {
    return this.text("this");
  }
  get aliasOrName() { return this.alias || this.name; }
  get outputName() { return ""; }
  // py: core.py:969.  `self._type or self.to` reads the `to` PROPERTY, not args["to"] —
  // so a Cast missing its required `to` raises KeyError here, exactly as upstream.
  // py: core.py:970 `if self.is_data_type: return self` / `if self.is_cast: ...`.
  // Both flags are class vars derived from the generated MRO in focused_methods.js, so
  // the `=== "DataType"` name fallback that used to sit here (and hid the fact that
  // `is_data_type` was set on DataType alone) is gone.
  get type() { return this.constructor.isDataType ? this : (this.constructor.isCast ? (this._type || this.to) : this._type); }
  set type(v) {
    const DataType = CLASS_REGISTRY.get("DataType");
    this._type = v && DataType && !(v instanceof DataType) ? DataType.build(v) : v;
  }
  isType(...dtypes) { return this._type !== null && this._type !== undefined && !!this._type.isType?.(...dtypes); }
  get meta() { return this._meta || (this._meta = {}); }
  metaGet(k, d = null) { return this._meta && k in this._meta ? this._meta[k] : d; }
  // py: core.py:911.  The FIELD's type decides, never the owner's -- so
  // Ordered(this=Identifier(zz)).name is 'zz' on any owner class.  The Star/Null arm
  // is what keeps `t.*` projections in named_selects and Null.name as 'NULL'.
  text(k) {
    const v = this.args[k];
    if (typeof v === "string") return v;
    if (!(v instanceof Expr)) return "";
    if (["Identifier", "Literal", "Var"].includes(v.constructor.name)) return typeof v.this === "string" ? v.this : "";
    if (["Star", "Null"].includes(v.constructor.name)) return v.name;
    return "";
  }
  toPy() {
    const name = this.constructor.name;
    if (name === "Null") return null;
    if (name === "Boolean") return typeof this.this === "string" ? this.this.toLowerCase() === "true" : !!this.this;
    if (name === "Literal") {
      if (this.args.is_string) return this.this;
      const s = String(this.this);
      const integer = pyIntFromStr(s);
      if (integer !== null) return integer;
      try { return pyDecimal(s); } catch { throw new PyValueError(`Invalid numeric literal: ${s}`); }
    }
    // py: core.py:2272 Neg.to_py — `if self.is_number: ... ; return super().to_py()`.
    // The GUARD matters: `Neg(Literal('1', is_string=True))` is not a number, so upstream
    // falls through to `Expression.to_py` and RAISES. Negating unconditionally returned
    // -1 instead. Found by probing one step out from the reported cases.
    //
    // There is also NO `Paren.to_py` upstream — Paren inherits the raising base — so the
    // port's Paren arm, which unwrapped to the inner value, is gone rather than guarded.
    if (name === "Neg" && this.isNumber) {
      const value = this.this.toPy();
      return typeof value === "bigint" ? -value : decNeg(value);
    }
    // py: core.py:931 `raise ValueError(f"{self} cannot be converted to a Python object.")`
    // — a ValueError, not a bare exception, because callers catch it (`Literal.number`).
    throw new PyValueError(`${name} cannot be converted to a JavaScript value`);
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
        if (n.constructor.hashRawArgs) { if (v && !(Array.isArray(v) && !v.length)) h = fnv(`${k}:${hashValue(v)}`, h); continue; }
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
  // py: core.py:1218 `while type(expression) is Paren` — EXACT type, not isinstance, so
  // a name comparison is right here. The asymmetry with `unalias` just below is
  // upstream's and is preserved deliberately.
  unnest() { let x = this; while (x.constructor.name === "Paren") x = x.this; return x; }
  // py: core.py:1224 `if isinstance(self, Alias)` — ISINSTANCE, so `PivotAlias` (the one
  // Alias subclass, `expressions/query.py`) unwraps too. A `constructor.name === "Alias"`
  // test missed it, so `PIVOT (... a AS b)` never unwrapped. `instanceof` is the correct
  // spelling: `defineExpr` installs a `Symbol.hasInstance` that consults the generated
  // `bases` list (core.js:365), which is Python's real MRO.
  unalias() { return this instanceof cls("Alias") ? this.this : this; }
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
  and_(...expressions) { const o = trailingOptions(expressions); return combine([this, ...expressions], "And", o); }
  or_(...expressions) { const o = trailingOptions(expressions); return combine([this, ...expressions], "Or", o); }
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
  // py: core.py Condition.isin.  `query` and `unnest` are always passed to the In
  // constructor, so both keys exist in args even when null.
  isin(...expressions) {
    const options = trailingOptions(expressions);
    const copy = options.copy ?? true;
    let subquery = null;
    if (options.query) {
      subquery = maybeParse(options.query, { ...options, copy });
      if (subquery instanceof cls("Query")) subquery = subquery.subquery(null, { copy: false });
    }
    const unnestList = options.unnest == null ? [] : (Array.isArray(options.unnest) ? options.unnest : [options.unnest]);
    return new (cls("In"))({
      this: maybeCopy(this, copy),
      expressions: expressions.map(x => convert(x, copy)),
      query: subquery,
      unnest: options.unnest ? new (cls("Unnest"))({ expressions: unnestList.map(x => maybeParse(x, { ...options, copy })) }) : null,
    });
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
  C.isVarLenArgs = !!(meta.is_var_len_args ?? meta.isVarLenArgs);
  C.varLenArgKey = meta.var_len_arg_key ?? meta.varLenArgKey ?? "expressions";
  const names = Object.freeze([...(meta.sqlNames || [name.toUpperCase()])]);
  C.sqlNames = () => names;
  C.sqlName = () => names[0];
  // py: core.py:1663 Func.from_arg_list.
  //
  // An ARROW closed over `C`, not a `static` method, because `Parser.FUNCTIONS` stores
  // the bare reference (`exp.StrPosition.from_arg_list`) and calls it later with no
  // receiver. Python's bound classmethod survives that; a JS `static` would arrive with
  // `this === undefined` and throw. Closing over the class reproduces the binding.
  C.from_arg_list = (args) => {
    const argsDict = {};
    const allArgKeys = [...C.argTypes.keys()];
    // py: `zip(args, keys)` stops at the SHORTER of the two — extra args are dropped
    // here, not appended, and a short call simply leaves later keys unset.
    const fill = (keys) => {
      for (let i = 0; i < Math.min(args.length, keys.length); i++) argsDict[keys[i]] = args[i];
    };
    if (C.isVarLenArgs) {
      const varLenIndex = allArgKeys.indexOf(C.varLenArgKey);
      fill(allArgKeys.slice(0, varLenIndex));
      // py: `args[var_len_index:]` — the tail collects into ONE list argument. Keys
      // after it (dialect flags) are deliberately never populated.
      argsDict[C.varLenArgKey] = args.slice(varLenIndex);
    } else {
      fill(allArgKeys);
    }
    return new C(argsDict);
  };
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
    // py: core.py:2594 `if (node.type or verbose) and not node.is_data_type`
    if ((node.type || verbose) && !node.constructor.isDataType) args.push(["_type", node.type]);
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
    // py: tools/astdump.py:74 `list(node.comments) if node.comments else None` — an
    // EMPTY list is falsy in Python but truthy in JS, so `node.comments ? ... : null`
    // dumped a spurious `cm: []` for any node that had ever passed through
    // `addComments`/`_add_comments` with zero comments (i.e. nearly every node),
    // instead of upstream's `None`.
    return { c: node.constructor.name, a: Object.entries(node.args).map(([k,v]) => [k, astDump(v)]), m: node._meta ? {...node._meta} : null, cm: node.comments && node.comments.length ? [...node.comments] : null, t: type && type !== node ? astDump(type) : null };
  }
  if (Array.isArray(node)) return node.map(astDump);
  if (node && node.__tuple__) return { __tuple__: node.__tuple__.map(astDump) };
  // py: tools/astdump.py:99 `isinstance(node, (str, int, float))` -> written straight
  // into JSON. A Python int is a BigInt here (see `Literal.isInt`), and an arg CAN hold
  // one raw: `_parse_colon_as_variant_extract` stores `bracket_expr.to_py()` as
  // `JSONPathSubscript.this`. `JSON.stringify` throws on a BigInt rather than emitting
  // a number, so the conversion has to happen here. Number() is the matching precision:
  // the oracle side has already been through `JSON.parse`, which produced a double.
  if (typeof node === "bigint") return Number(node);
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
export const COLUMN_PARTS = Object.freeze(["this", "table", "db", "catalog"]);
export const SAFE_IDENTIFIER_RE = /^[_a-zA-Z][\w]*$/u;
export const DType = Object.freeze({});
let PARSE = null;
let GENERATE = null;
export function registerParser(fn) { PARSE = fn; }
/** Install the P4 generator without making the expression layer depend on it. */
export function registerGenerator(fn) { GENERATE = fn; }
export function maybeCopy(x, copy = true) { return copy && x instanceof Expr ? x.copy() : x; }
function cls(name) { const C = CLASS_REGISTRY.get(name) || CLASS_REGISTRY.get(name.toLowerCase()); if (!C) throw new Error(`Unknown expression class: ${name}`); return C; }
// py: core.py:2761 _combine, with core.py:2792 _wrap inlined as `wrapOne`.
//
// Two details that a reduce()-shaped port loses.  (1) The head operand is wrapped
// once, up front, and only when at least one further operand follows -- upstream's
// `if rest and wrap`.  Folding the wrap into the loop instead re-wraps the growing
// accumulator at every step, and wraps a lone operand that upstream leaves bare.
// (2) _wrap tests `Connector` -- the shared base of And/Or/Xor -- not the operator
// being built, so and_(or_(a, b), c) parenthesizes the Or.
function combine(expressions, name, options = {}) {
  const K = cls(name), Paren = cls("Paren"), Connector = cls("Connector");
  const wrap = options.wrap !== false;
  // py: condition() == maybe_parse(into=Condition).  `into` is deliberately not
  // threaded: Condition is a trait (never constructed), and until P3 registers a
  // parser the maybeParse fallback already yields the node the parser would.
  const conditions = expressions.filter(x => x !== null && x !== undefined)
    .map(x => maybeParse(x, { ...options, copy: options.copy ?? true }));
  // py: `this, *rest = conditions` on an empty list.
  if (!conditions.length) throw new PyValueError("not enough values to unpack (expected at least 1, got 0)");
  const wrapOne = (x) => (wrap && x instanceof Connector ? new Paren({ this: x }) : x);
  const [head, ...rest] = conditions;
  let node = rest.length ? wrapOne(head) : head;
  for (const x of rest) node = new K({ this: node, expression: wrapOne(x) });
  return node;
}
/** Python keyword arguments arrive as a trailing options object; an Expr is never one. */
export function trailingOptions(xs) {
  return xs.length && xs.at(-1) != null && xs.at(-1).constructor === Object ? xs.pop() : {};
}
export function and_(...expressions) { const o = trailingOptions(expressions); return combine(expressions, "And", o); }
export function or_(...expressions) { const o = trailingOptions(expressions); return combine(expressions, "Or", o); }
export function xor(...expressions) { const o = trailingOptions(expressions); return combine(expressions, "Xor", o); }
export function not_(expression, options = {}) { return new (cls("Not"))({ this: maybeParse(expression, { ...options, copy: options.copy ?? true }) }); }
/** py: core.py Dot.build */
export function dotBuild(expressions) {
  const xs = [...expressions];
  if (xs.length < 2) throw new PyValueError("Dot requires >= 2 expressions.");
  const Dot = cls("Dot");
  return xs.reduce((x, y) => new Dot({ this: x, expression: y }));
}
// py: core.py:2823 to_identifier.  None passes through as None, and anything that is
// neither a str nor an Identifier is a ValueError -- the `int` in the overload's type
// hint is not actually accepted by the body.  Coercing with String() instead would
// silently turn None into the identifier "null" and accept arbitrary expressions.
export function toIdentifier(name, quoted = null, copy = true) {
  if (name === null || name === undefined) return null;
  const Identifier = cls("Identifier");
  if (name instanceof Identifier) return maybeCopy(name, copy);
  if (typeof name !== "string") {
    throw new PyValueError(`Name needs to be a string or an Identifier, got: ${name?.constructor?.name ?? typeof name}`);
  }
  return new Identifier({ this: name, quoted: quoted ?? !SAFE_IDENTIFIER_RE.test(name) });
}
export function convert(value, copy = false) {
  if (value instanceof Expr) return maybeCopy(value, copy);
  if (value === null || value === undefined) return new (cls("Null"))();
  if (typeof value === "boolean") return new (cls("Boolean"))({ this: value });
  if (typeof value === "string") return new (cls("Literal"))({ this: value, is_string: true });
  if (typeof value === "number" || typeof value === "bigint") return new (cls("Literal"))({ this: String(value), is_string: false });
  if (value?.__tuple__) return new (cls("Tuple"))({ expressions: value.__tuple__.map(x => convert(x, copy)) });
  if (Array.isArray(value)) return new (cls("Array"))({ expressions: value.map(x => convert(x, copy)) });
  if (value && value.constructor === Object) return new (cls("Map"))({
    keys: new (cls("Array"))({ expressions: Object.keys(value).map(x => convert(x, copy)) }),
    values: new (cls("Array"))({ expressions: Object.values(value).map(x => convert(x, copy)) }),
  });
  if (value && typeof value === "object") return new (cls("Struct"))({ expressions: Object.entries(value).map(([k, v]) => new (cls("PropertyEQ"))({ this: toIdentifier(k), expression: convert(v, copy) })) });
  throw new PyValueError(`Cannot convert ${String(value)}`);
}
export function maybeParse(sqlOrExpression, options = {}) {
  if (sqlOrExpression instanceof Expr) return maybeCopy(sqlOrExpression, options.copy ?? false);
  if (PARSE) return PARSE(sqlOrExpression, options);
  // P2-safe leaf fallback; P3 replaces the whole branch through registerParser.
  // Built directly rather than through column(): the parser emits a Column carrying
  // only `this`, whereas exp.column() also materialises null table/db/catalog args.
  const identifier = toIdentifier(String(sqlOrExpression), null, false);
  if (!options.into) return new (cls("Column"))({ this: identifier });
  // `into: Identifier` must yield the Identifier itself.  Wrapping it the way every
  // other `into` is wrapped produced Identifier(this=Identifier(...)); parse_identifier
  // used to paper over that downstream, which hid the double wrap from every caller.
  if (options.into === cls("Identifier")) return identifier;
  // py: parse_one(sql, into=T) parses and then ASSERTS the type -- it does not
  // construct a T.  So when the leaf already satisfies `into` (Expr, Condition,
  // Column -- the type-constraint uses), return the leaf rather than wrapping it,
  // which otherwise fabricated a bare Expr() node for Select.select("a").
  const leaf = new (cls("Column"))({ this: identifier });
  if (leaf instanceof options.into) return leaf;
  // Remaining `into`s are genuine wrapper nodes (Table, From, Where, Limit, ...)
  // whose parsed form is T(this=<leaf>).  For wrappers the parser would fill
  // differently -- Order("a") really parses to Order(expressions=[Ordered(...)]) --
  // this shape is a documented P2 stopgap and is parser-dependent.
  return new options.into({ this: identifier });
}
// py: core.py:3086 column.  `fields`, `quoted` and `copy` are keyword-only upstream,
// so they travel in the trailing options object; table/db/catalog stay positional
// because they are positional there too.  All three are set unconditionally (as None
// when absent), which is observable in `args` and in astDump even though _to_s hides
// them.  A Star `col` bypasses to_identifier entirely.
export function column(col, table = null, db = null, catalog = null, options = {}) {
  const { fields = null, quoted = null, copy = true } = options;
  const node = new (cls("Column"))({
    this: col instanceof cls("Star") ? col : toIdentifier(col, quoted, copy),
    table: toIdentifier(table, quoted, copy),
    db: toIdentifier(db, quoted, copy),
    catalog: toIdentifier(catalog, quoted, copy),
  });
  if (!fields || !fields.length) return node;
  return dotBuild([node, ...fields.map((field) => toIdentifier(field, quoted, copy))]);
}
// py: core.py:2999 alias_.  Upstream attaches the alias to the expression itself
// whenever the node has an `alias` arg -- and always for table aliases -- and only
// wraps in an Alias node otherwise.  Window is excluded by name because its `alias`
// arg means "named window", not "aliased expression".
export function alias_(expression, alias, options = {}) {
  const { table = false, quoted = null, copy = true } = options;
  const expr = maybeParse(expression, { ...options, copy });
  const identifier = toIdentifier(alias, quoted);
  // py: `if table:` -- an EMPTY column list is falsy there, so alias_(t, "x", table=[])
  // takes the plain-alias branch, not the TableAlias one.
  if (table === true || (Array.isArray(table) && table.length) || (table && !Array.isArray(table))) {
    const tableAlias = new (cls("TableAlias"))({ this: identifier });
    expr.set("alias", tableAlias);
    if (Array.isArray(table)) for (const col of table) tableAlias.append("columns", toIdentifier(col, quoted));
    return expr;
  }
  if (expr.constructor.argTypes?.has("alias") && expr.constructor.name !== "Window") {
    expr.set("alias", identifier);
    return expr;
  }
  return new (cls("Alias"))({ this: expr, alias: identifier });
}
