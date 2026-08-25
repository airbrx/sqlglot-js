// Behavioral methods from expressions/query.py, ddl.py and dml.py.
import { maybeCopy, maybeParse, toIdentifier, convert, alias_, column } from "./core.js";
// Installed after the generated catalogue is registered: generated constructors do
// not form a JS inheritance hierarchy, so Python traits are applied explicitly.
function getter(C, name, fn) {
  if (C) Object.defineProperty(C.prototype, name, { get: fn, configurable: true });
}
function method(C, name, fn) { if (C) Object.defineProperty(C.prototype, name, { value: fn, configurable: true, writable: true }); }
function value(node, camel, snake = camel) { return node?.[camel] ?? node?.[snake] ?? ""; }
function has(C, trait) { return C.name === trait || C.traits?.includes(trait) || C.bases?.includes(trait); }
function query(C) { return has(C, "Query"); }

export function installQueryMethods(classes) {
  const all = Object.values(classes);
  const C = (name) => classes[name];
  const get = (name, prop, fn, snake = null) => { getter(C(name), prop, fn); if (snake) getter(C(name), snake, fn); };
  const options = xs => xs.length && xs.at(-1) && xs.at(-1).constructor === Object ? xs.pop() : {};
  const parsed = (x, o = {}) => maybeParse(x, o);
  const setOne = (self, key, x, Into, o = {}, intoArg = "this") => {
    const out = maybeCopy(self, o.copy ?? true);
    let v = parsed(x, { ...o, into: Into, copy: false });
    if (Into && !(v instanceof Into)) v = new Into({ [intoArg]: v });
    out.set(key, v); return out;
  };
  const setList = (self, key, xs, o = {}, Into = null) => {
    const out = maybeCopy(self, o.copy ?? true), old = o.append === false ? [] : (out.args[key] || []);
    const vals = xs.filter(x => x != null).map(x => parsed(x, { ...o, into: Into, copy: false }));
    out.set(key, [...old, ...vals]); return out;
  };
  const conjunction = (self, key, xs, o = {}, Wrapper = null) => {
    const vals = xs.filter(x => x != null).map(x => parsed(x, { ...o, copy: false }));
    let expr = vals.shift() || null;
    for (const v of vals) expr = new (C("And"))({ this: expr, expression: v });
    const old = o.append === false ? null : outArg(self, key)?.this;
    if (old && expr) expr = new (C("And"))({ this: old, expression: expr }); else expr ||= old;
    return setOne(self, key, expr, Wrapper, o);
  };
  const outArg = (x, k) => x.args[k];
  const cte = (self, alias, as_, o = {}) => {
    let body = parsed(as_, { ...o, copy: o.copy ?? true });
    if (o.scalar && !(body instanceof C("Subquery"))) body = new (C("Subquery"))({ this: body });
    const item = new (C("CTE"))({ this: body, alias: parsed(alias, { into: C("TableAlias") }), materialized: o.materialized, scalar: o.scalar });
    const out = maybeCopy(self, o.copy ?? true), old = o.append === false ? [] : (out.args.with_?.expressions || []);
    out.set("with_", new (C("With"))({ expressions: [...old, item], ...(o.recursive ? { recursive: o.recursive } : {}) })); return out;
  };

  // Query / Selectable traits (query.py:80-435).
  for (const K of all) if (query(K)) {
    getter(K, "ctes", function () { return this.args.with_?.expressions || []; });
    if (!Object.getOwnPropertyDescriptor(K.prototype, "namedSelects")) getter(K, "namedSelects", function () { return this.selects.map(x => value(x, "outputName", "output_name")); });
    getter(K, "named_selects", function () { return this.namedSelects; });
    method(K, "subquery", function (alias = null, o = {}) { const x = maybeCopy(this, o.copy ?? true); return new (C("Subquery"))({ this: x, alias: alias ? (alias.args ? alias : new (C("TableAlias"))({ this: toIdentifier(alias) })) : null }); });
    method(K, "limit", function (x, o = {}) { return setOne(this, "limit", x, C("Limit"), o, "expression"); });
    method(K, "offset", function (x, o = {}) { return setOne(this, "offset", x, C("Offset"), o, "expression"); });
    method(K, "orderBy", function (...xs) { const o=options(xs); return setList(this,"order",xs,o,C("Order")); });
    method(K, "order_by", K.prototype.orderBy);
    method(K, "where", function (...xs) { const o=options(xs); return conjunction(this,"where",xs,o,C("Where")); });
    method(K, "with_", function (alias, as_, o={}) { return cte(this,alias,as_,o); });
    for (const [mn, cn] of [["union","Union"],["intersect","Intersect"],["except_","Except"]]) method(K,mn,function(...xs){const o=options(xs); let out=maybeCopy(this,o.copy??true); for(const x of xs) out=new (C(cn))({this:out,expression:parsed(x,{...o,copy:true}),distinct:o.distinct??true}); return out;});
  }
  for (const K of all) if (has(K, "DerivedTable")) {
    getter(K, "selects", function () { return query(this.this?.constructor) ? this.this.selects : []; });
  }
  for (const K of all) if (has(K, "UDTF")) {
    getter(K, "selects", function () { return this.args.alias?.columns || []; });
  }

  get("With", "recursive", function () { return !!this.args.recursive; });
  get("TableAlias", "columns", function () { return this.args.columns || []; });
  get("ColumnDef", "constraints", function () { return this.args.constraints || []; });
  get("ColumnDef", "kind", function () { return this.args.kind ?? null; });
  get("From", "name", function () { return value(this.this, "name"); });
  get("From", "aliasOrName", function () { return value(this.this, "aliasOrName", "alias_or_name"); }, "alias_or_name");

  for (const p of ["method", "kind", "side", "hint"]) get("Join", p, function () { return this.text(p).toUpperCase(); });
  get("Join", "aliasOrName", function () { return value(this.this, "aliasOrName", "alias_or_name"); }, "alias_or_name");
  get("Join", "isSemiOrAntiJoin", function () { return this.kind === "SEMI" || this.kind === "ANTI"; }, "is_semi_or_anti_join");
  method(C("Join"), "on", function (...xs) { const o=options(xs), out=conjunction(this,"on",xs,o); if(out.kind==="CROSS") out.set("kind",null); return out; });
  method(C("Join"), "using", function (...xs) { const o=options(xs), out=setList(this,"using",xs,o); if(out.kind==="CROSS") out.set("kind",null); return out; });

  get("Table", "name", function () { return !this.this || this.this.constructor?.traits?.includes("Func") || this.this.constructor?.bases?.includes("Func") ? "" : value(this.this, "name"); });
  get("Table", "db", function () { return this.text("db"); });
  get("Table", "catalog", function () { return this.text("catalog"); });
  get("Table", "selects", function () { return []; });
  get("Table", "namedSelects", function () { return []; }, "named_selects");
  get("Table", "parts", function () { const out = []; for (const k of ["catalog", "db", "this"]) { const x = this.args[k]; if (!x) continue; if (x.constructor?.name === "Dot" && typeof x.flatten === "function") out.push(...x.flatten()); else if (x.args) out.push(x); } return out; });
  method(C("Table"), "toColumn", function (o={}) { const ps=this.parts, last=ps.at(-1); let out=last instanceof C("Identifier") ? column(...ps.slice(0,4).reverse()) : last; if(this.args.alias) out=alias_(out,this.args.alias.this,{copy:o.copy??true}); return out; });
  method(C("Table"), "to_column", C("Table").prototype.toColumn);

  const setOps = ["SetOperation", "Union", "Except", "Intersect"];
  for (const name of setOps) {
    get(name, "selects", function () { let x = this; while (x instanceof C("SetOperation")) x = typeof x.this?.unnest === "function" ? x.this.unnest() : x.this; return x?.selects || []; });
    get(name, "namedSelects", function () { let x = this; while (x instanceof C("SetOperation")) { if (x.args.by_name) return [...new Set([...((x.this?.unnest?.() || x.this)?.namedSelects || []), ...((x.expression?.unnest?.() || x.expression)?.namedSelects || [])])]; x = x.this?.unnest?.() || x.this; } return (x?.selects || []).map(e => value(e, "outputName", "output_name")); }, "named_selects");
    get(name, "isStar", function () { return !!(value(this.this, "isStar", "is_star") || value(this.expression, "isStar", "is_star")); }, "is_star");
    get(name, "left", function () { return this.this; }); get(name, "right", function () { return this.expression; });
    get(name, "kind", function () { return this.text("kind").toUpperCase(); }); get(name, "side", function () { return this.text("side").toUpperCase(); });
    method(C(name), "select", function (...xs) { const o=options(xs), out=maybeCopy(this,o.copy??true); out.this.unnest().select(...xs,{...o,copy:false}); out.expression.unnest().select(...xs,{...o,copy:false}); return out; });
  }

  get("Select", "selects", function () { return this.expressions; });
  get("Select", "namedSelects", function () { const out = []; for (const e of this.expressions) { if (value(e, "aliasOrName", "alias_or_name")) out.push(value(e, "outputName", "output_name")); else if (e.constructor?.name === "Aliases") for (const a of e.args.aliases || []) out.push(value(a, "name")); } return out; }, "named_selects");
  get("Select", "isStar", function () { return this.expressions.some(e => !!value(e, "isStar", "is_star")); }, "is_star");
  method(C("Select"), "select", function (...xs) { const o=options(xs); return setList(this,"expressions",xs,o); });
  method(C("Select"), "lateral", function (...xs) { const o=options(xs); return setList(this,"laterals",xs,o,C("Lateral")); });
  method(C("Select"), "window", function (...xs) { const o=options(xs); return setList(this,"windows",xs,o,C("Window")); });
  method(C("Select"), "join", function (expression, o = {}) {
    // Parsing the source as a Join first is significant: registered parsers can
    // preserve a complete JOIN clause, while AST callers may pass its source.
    let parsedJoin = parsed(expression, { ...o, into: C("Join"), copy: o.copy ?? true });
    const join = parsedJoin instanceof C("Join") ? parsedJoin : new (C("Join"))({ this: parsedJoin });
    if (join.this instanceof C("Select")) join.set("this", join.this.subquery(null, { copy: false }));

    if (o.join_type) {
      // This is the same three-part split produced by parsing
      // `FROM _ <join_type> JOIN _`; it also keeps the method/side/kind fields
      // independent, as Join's public properties require.
      const words = String(o.join_type).trim().toUpperCase().split(/\s+/);
      const methods = new Set(["GLOBAL", "NATURAL", "POSITIONAL", "ASOF"]);
      const sides = new Set(["LEFT", "RIGHT", "FULL"]);
      const kinds = new Set(["INNER", "OUTER", "CROSS", "SEMI", "ANTI"]);
      for (const word of words) {
        if (methods.has(word)) join.set("method", word);
        else if (sides.has(word)) join.set("side", word);
        else if (kinds.has(word)) join.set("kind", word);
      }
    }
    if (o.on) {
      const ons = Array.isArray(o.on) ? o.on : [o.on];
      let condition = null;
      for (const x of ons) {
        const v = parsed(x, { ...o, copy: o.copy ?? true });
        condition = condition ? new (C("And"))({ this: condition, expression: v }) : v;
      }
      join.set("on", condition);
    }
    if (o.using) {
      const using = Array.isArray(o.using) ? o.using : [o.using];
      join.set("using", using.map(x => x instanceof C("Identifier") ? maybeCopy(x, o.copy ?? true) : toIdentifier(x)));
    }
    if (o.join_alias) join.set("this", alias_(join.this, o.join_alias, { table: true, copy: false }));
    return setList(this, "joins", [join], o);
  });
  method(C("Select"), "ctas", function (table, o = {}) {
    const properties = o.properties ? C("Properties").fromDict(o.properties) : null;
    return new (C("Create"))({
      this: parsed(table, { ...o, into: C("Table"), copy: false }),
      kind: "TABLE", expression: maybeCopy(this, o.copy ?? true), properties,
    });
  });
  method(C("Select"), "hint", function (...xs) {
    const o=options(xs), out=maybeCopy(this,o.copy??true);
    out.set("hint",new (C("Hint"))({expressions:xs.map(x=>parsed(x,{...o,copy:o.copy??true}))}));
    return out;
  });
  method(C("Select"), "distinct", function (...xs) { const o=options(xs); const out=maybeCopy(this,o.copy??true); out.set("distinct",o.distinct===false?null:new (C("Distinct"))({on:xs.length?new (C("Tuple"))({expressions:xs.map(x=>parsed(x,o))}):null})); return out; });
  method(C("Select"), "lock", function (update=true,o={}) { const out=maybeCopy(this,o.copy??true); out.set("locks",[...(out.args.locks||[]),new (C("Lock"))({update})]); return out; });
  for (const [js, py, key, Into] of [["from_","from_","from_","From"],["groupBy","group_by","group","Group"],["sortBy","sort_by","sort","Sort"],["clusterBy","cluster_by","cluster","Cluster"],["having","having","having","Having"],["qualify","qualify","qualify","Qualify"]]) {
    method(C("Select"), js, function (...xs) { const o=options(xs); return xs.length===1 && ["from_"].includes(key) ? setOne(this,key,xs[0],C(Into),o) : setList(this,key,xs,o,C(Into)); });
    if(py!==js) method(C("Select"),py,C("Select").prototype[js]);
  }

  method(C("Subquery"), "unnest", function () { let x = this; while (x instanceof C("Subquery")) x = x.this; return x; });
  method(C("Subquery"), "unwrap", function () { let x=this; while(x.this instanceof C("Subquery")) x=x.this; return x; });
  method(C("Subquery"), "select", function (...xs) { const o=options(xs), out=maybeCopy(this,o.copy??true); out.this.select(...xs,{...o,copy:false}); return out; });
  get("Subquery", "isWrapper", function () { return Object.entries(this.args).every(([k,v]) => k === "this" || v == null); }, "is_wrapper");
  get("Subquery", "isStar", function () { return !!value(this.this, "isStar", "is_star"); }, "is_star");
  get("Subquery", "outputName", function () { return value(this, "alias"); }, "output_name");

  get("Pivot", "unpivot", function () { return !!this.args.unpivot; });
  get("Pivot", "fields", function () { return this.args.fields || []; });
  method(C("Pivot"), "outputColumns", function (prePivotColumns) {
    let excluded = new Set(), outputs = [];
    if (this.unpivot) {
      const names = [];
      for (const field of this.fields) {
        if (!(field instanceof C("In"))) continue;
        if (field.this instanceof C("Identifier")) names.push(field.this);
        for (const item of field.expressions) for (const col of item.findAll(C("Column"))) excluded.add(col.outputName);
      }
      const values = [];
      for (const expression of this.expressions) {
        const candidates = expression instanceof C("Tuple") ? expression.expressions : [expression];
        for (const ident of candidates) if (ident instanceof C("Identifier")) values.push(ident);
      }
      outputs = (this.args.value_columns_first ? [...values, ...names] : [...names, ...values]).map(x => x.name);
    } else {
      for (const col of this.findAll(C("Column"))) excluded.add(col.outputName);
      outputs = (this.args.columns || []).map(x => x.outputName);
      if (!outputs.length) outputs = this.expressions.map(x => x.aliasOrName);
    }
    if (!excluded.size || !outputs.length) return new Map();
    const before = [...prePivotColumns].filter(x => !excluded.has(x)).concat(outputs);
    const renames = this.args.alias?.args?.columns;
    const after = renames?.length ? renames.map(x => x.name).concat(before.slice(renames.length)) : before;
    return new Map(after.map((name, i) => [name, before[i]]));
  });
  method(C("Pivot"), "output_columns", C("Pivot").prototype.outputColumns);
  get("JSONPath", "outputName", function () { const x=this.expressions.at(-1)?.this; return typeof x === "string" ? x : ""; }, "output_name");
  get("TableColumn", "outputName", function () { return this.name; }, "output_name");

  // DDL trait and the concrete uppercase-normalizing properties (ddl.py).
  for (const K of all) if (has(K, "DDL")) {
    getter(K, "ctes", function () { return this.args.with_?.expressions || []; });
    getter(K, "selects", function () { return query(this.expression?.constructor) ? this.expression.selects : []; });
    getter(K, "namedSelects", function () { return query(this.expression?.constructor) ? this.expression.namedSelects : []; });
    getter(K, "named_selects", function () { return this.namedSelects; });
  }
  for (const name of ["Create", "Drop", "Alter", "AlterColumn"]) get(name, "kind", function () { const x = this.args.kind; return x == null ? null : String(x).toUpperCase(); });
  get("Alter", "actions", function () { return this.args.actions || []; });
  get("Execute", "name", function () { return value(this.this, "name"); });

  // DML methods (dml.py). Kept here to avoid a circular builders dependency.
  for (const K of all) if (has(K,"DML")) method(K,"returning",function(x,o={}){ return setOne(this,"returning",x,C("Returning"),o); });
  method(C("Delete"),"delete",function(x,o={}){ return setOne(this,"this",x,C("Table"),o); });
  method(C("Delete"),"where",function(...xs){const o=options(xs);return conjunction(this,"where",xs,o,C("Where"));});
  method(C("Insert"),"with_",function(a,b,o={}){return cte(this,a,b,o);});
  method(C("Update"),"table",function(x,o={}){return setOne(this,"this",x,C("Table"),o);});
  method(C("Update"),"set_",function(...xs){const o=options(xs);return setList(this,"expressions",xs,o);});
  method(C("Update"),"where",function(...xs){const o=options(xs);return conjunction(this,"where",xs,o,C("Where"));});
  method(C("Update"),"from_",function(x=null,o={}){return x ? setOne(this,"from_",x,C("From"),o) : maybeCopy(this,o.copy??true);});
  method(C("Update"),"with_",function(a,b,o={}){return cte(this,a,b,o);});

  method(C("Tuple"),"isin",function(...xs){const o=options(xs);return new (C("In"))({this:maybeCopy(this,o.copy??true),expressions:xs.map(x=>convert(x,o.copy??true)),query:o.query?parsed(o.query,o):null,unnest:o.unnest?new (C("Unnest"))({expressions:(Array.isArray(o.unnest)?o.unnest:[o.unnest]).map(x=>parsed(x,o))}):null});});
}
