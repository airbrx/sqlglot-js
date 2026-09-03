// Behavioral methods from expressions/query.py, ddl.py and dml.py.
import { Expr, maybeCopy, maybeParse, toIdentifier, alias_, column, and_, trailingOptions } from "./core.js";
// Installed after the generated catalogue is registered: generated constructors do
// not form a JS inheritance hierarchy, so Python traits are applied explicitly.
function getter(C, name, fn) {
  if (C) Object.defineProperty(C.prototype, name, { get: fn, configurable: true });
}
function method(C, name, fn) { if (C) Object.defineProperty(C.prototype, name, { value: fn, configurable: true, writable: true }); }
function value(node, camel, snake = camel) { return node?.[camel] ?? node?.[snake] ?? ""; }
function has(C, trait) { return C.name === trait || C.traits?.includes(trait) || C.bases?.includes(trait); }
function query(C) { return has(C, "Query"); }

// py: the TokenType NAMES of Parser.JOIN_METHODS (parser.py:1012), JOIN_SIDES (:1018)
// and JOIN_KINDS (:1024). Duplicated here only because importing `src/parser.js` from
// the expression layer would close an import cycle (parser.js -> expressions/index.js
// -> query_methods.js); test/expressions/query_methods_join.test.mjs asserts these are
// the same three sets, so the copy is checked rather than trusted.
export const JOIN_METHODS = Object.freeze(new Set(["ASOF", "NATURAL", "POSITIONAL"]));
export const JOIN_SIDES = Object.freeze(new Set(["LEFT", "RIGHT", "FULL"]));
export const JOIN_KINDS = Object.freeze(new Set(
  ["ANTI", "CROSS", "INNER", "OUTER", "SEMI", "STRAIGHT_JOIN"],
));

export function installQueryMethods(classes) {
  const all = Object.values(classes);
  const C = (name) => classes[name];
  const get = (name, prop, fn, snake = null) => { getter(C(name), prop, fn); if (snake) getter(C(name), snake, fn); };
  const options = xs => trailingOptions(xs);
  const parsed = (x, o = {}) => maybeParse(x, o);

  // The four `_apply_*_builder` helpers below are ported from core.py verbatim
  // rather than approximated, because their differences are exactly what the node
  // shapes depend on: a *list* builder stores a plain array, a *child-list* builder
  // stores one wrapper node whose non-`expressions` args are hoisted onto it, and a
  // *conjunction* builder folds through and_() so that _combine's wrap rules apply.

  // py: core.py:2626 _is_wrong_expression
  const isWrongExpression = (expression, Into) => !!Into && expression instanceof Expr && !(expression instanceof Into);

  // py: core.py:2630 _apply_builder
  const applyBuilder = (expression, self, key, o = {}, Into = null, intoArg = "this") => {
    if (isWrongExpression(expression, Into)) expression = new Into({ [intoArg]: expression });
    const inst = maybeCopy(self, o.copy ?? true);
    inst.set(key, parsed(expression, { ...o, into: Into, copy: false }));
    return inst;
  };

  // py: core.py:2655 _apply_child_list_builder
  const applyChildListBuilder = (xs, self, key, o, Into) => {
    const inst = maybeCopy(self, o.copy ?? true);
    const flattened = [], properties = new Map(Object.entries(o.properties || {}));
    for (let x of xs) {
      if (x == null) continue;
      // Wrapping happens BEFORE parsing and only for Expr inputs, so a string is
      // handed to the parser with `into` rather than being wrapped as an operand.
      if (isWrongExpression(x, Into)) x = new Into({ expressions: [x] });
      x = parsed(x, { ...o, into: Into, copy: false });
      for (const [k, v] of Object.entries(x.args)) {
        if (k === "expressions") flattened.push(...(v || []));
        else properties.set(k, v);
      }
    }
    const existing = inst.args[key];
    const combined = (o.append ?? true) && existing ? [...existing.expressions, ...flattened] : flattened;
    const child = new Into({ expressions: combined });
    for (const [k, v] of properties) child.set(k, v);
    inst.set(key, child);
    return inst;
  };

  // py: core.py:2702 _apply_list_builder
  const applyListBuilder = (xs, self, key, o = {}, Into = null) => {
    const inst = maybeCopy(self, o.copy ?? true);
    const list = xs.filter(x => x != null).map(x => parsed(x, { ...o, into: Into, copy: false }));
    const existing = inst.args[key];
    inst.set(key, (o.append ?? true) && existing?.length ? [...existing, ...list] : list);
    return inst;
  };

  // py: core.py:2735 _apply_conjunction_builder.  The existing operand is prepended
  // to the *inputs* of and_(), not combined afterwards -- that is what lets _combine
  // decide whether it needs a Paren, instead of this helper guessing.
  const applyConjunctionBuilder = (xs, self, key, o = {}, Into = null) => {
    const filtered = xs.filter(x => x != null && x !== "");
    if (!filtered.length) return self;
    const inst = maybeCopy(self, o.copy ?? true);
    const existing = inst.args[key];
    const operands = (o.append ?? true) && existing != null
      ? [Into ? existing.this : existing, ...filtered]
      : filtered;
    const node = and_(...operands, { ...o, copy: o.copy ?? true });
    inst.set(key, Into ? new Into({ this: node }) : node);
    return inst;
  };

  // py: core.py:2796 _apply_set_operation
  const applySetOperation = (xs, o, Op) =>
    xs.map(x => parsed(x, { ...o, copy: o.copy ?? true }))
      .reduce((x, y) => new Op({ this: x, expression: y, distinct: o.distinct ?? true }));

  // py: query.py:47 _cte_helper.  `materialized` and `scalar` are always passed to the
  // CTE constructor, so both keys exist in args even when null (repr hides them, but
  // astDump and `"materialized" in args` do not).
  const cte = (self, alias, as_, o = {}) => {
    const aliasExpression = parsed(alias, { ...o, into: C("TableAlias"), copy: false });
    let asExpression = parsed(as_, { ...o, copy: o.copy ?? true });
    if (o.scalar && !(asExpression instanceof C("Subquery"))) asExpression = new (C("Subquery"))({ this: asExpression });
    const item = new (C("CTE"))({
      this: asExpression, alias: aliasExpression,
      materialized: o.materialized ?? null, scalar: o.scalar ?? null,
    });
    return applyChildListBuilder([item], self, "with_",
      { ...o, properties: o.recursive ? { recursive: o.recursive } : {} }, C("With"));
  };

  // Query / Selectable traits (query.py:80-435).
  for (const K of all) if (query(K)) {
    getter(K, "ctes", function () { return this.args.with_?.expressions || []; });
    if (!Object.getOwnPropertyDescriptor(K.prototype, "namedSelects")) getter(K, "namedSelects", function () { return this.selects.map(x => value(x, "outputName", "output_name")); });
    getter(K, "named_selects", function () { return this.namedSelects; });
    method(K, "subquery", function (alias = null, o = {}) { const x = maybeCopy(this, o.copy ?? true); return new (C("Subquery"))({ this: x, alias: alias instanceof Expr ? alias : (alias ? new (C("TableAlias"))({ this: toIdentifier(alias) }) : null) }); });
    method(K, "limit", function (x, o = {}) { return applyBuilder(x, this, "limit", o, C("Limit"), "expression"); });
    method(K, "offset", function (x, o = {}) { return applyBuilder(x, this, "offset", o, C("Offset"), "expression"); });
    method(K, "orderBy", function (...xs) { const o=options(xs); return applyChildListBuilder(xs,this,"order",o,C("Order")); });
    method(K, "order_by", K.prototype.orderBy);
    // py: query.py:264 -- `where` (and only `where`) unwraps Where operands before
    // handing them to the conjunction builder; having/qualify deliberately do not.
    method(K, "where", function (...xs) { const o=options(xs); return applyConjunctionBuilder(xs.map(x => x instanceof C("Where") ? x.this : x),this,"where",o,C("Where")); });
    method(K, "with_", function (alias, as_, o={}) { return cte(this,alias,as_,o); });
    for (const [mn, cn] of [["union","Union"],["intersect","Intersect"],["except_","Except"]]) method(K,mn,function(...xs){const o=options(xs); return applySetOperation([this,...xs],o,C(cn));});
  }
  for (const K of all) if (has(K, "DerivedTable")) {
    getter(K, "selects", function () { return query(this.this?.constructor) ? this.this.selects : []; });
  }
  for (const K of all) if (has(K, "UDTF")) {
    getter(K, "selects", function () { return this.args.alias?.columns || []; });
  }

  get("With", "recursive", function () { return !!this.args.recursive; });
  get("TableAlias", "columns", function () { return this.args.columns || []; });
  for (const part of ["table", "db", "catalog"]) get("Column", part, function () { return this.text(part); });
  get("Column", "outputName", function () { return this.name; }, "output_name");
  get("Column", "parts", function () { return ["catalog", "db", "table", "this"].map(k => this.args[k]).filter(Boolean); });
  // py: core.py:1736 Column.to_dot. `deepcopy(parts)` is `p.copy()` per element:
  // `Dot.build` re-parents what it is handed, so handing it the live children would
  // detach them from the Column the caller may still be holding.
  method(C("Column"), "to_dot", function (include_dots = true) {
    const parts = this.parts;
    let parent = this.parent;

    if (include_dots) {
      while (parent instanceof C("Dot")) {
        parts.push(parent.expression);
        parent = parent.parent;
      }
    }

    return parts.length > 1 ? C("Dot").build(parts.map(p => p.copy())) : parts[0];
  });
  // py: core.py:1816 `Identifier.quoted` is a PROPERTY returning `bool(args.get())`,
  // not the raw arg. Without it `identifier.quoted` reads back `undefined`, and
  // upstream's `isinstance(k, exp.Identifier) and k.quoted` -- which `and`s to Python
  // `False` -- became JS `undefined`, dumping `quoted: null` where the oracle has
  // `false`. Surfaced by _parse_colon_as_variant_extract over 155 Snowflake rows.
  get("Identifier", "quoted", function () { return !!this.args.quoted; });
  for (const name of ["Identifier", "Literal", "Star"]) get(name, "outputName", function () { return this.name; }, "output_name");
  get("Alias", "outputName", function () { return this.alias; }, "output_name");
  get("Star", "name", function () { return "*"; });
  // The remaining upstream `name` / `output_name` / `is_star` overrides in core.py.
  // These are the sibling cases of the three the review named: enumerated from
  // `grep "def (name|output_name|is_star)" sqlglot/expressions/`, not from symptoms.
  get("Placeholder", "name", function () { return this.text("this") || "?"; });            // py: core.py:1860
  get("Null", "name", function () { return "NULL"; });                                     // py: core.py:1868
  get("Dot", "name", function () { return value(this.expression, "name"); });               // py: core.py:1888
  get("Dot", "outputName", function () { return this.name; }, "output_name");               // py: core.py:1892
  get("Dot", "isStar", function () { return !!this.expression?.isStar; }, "is_star");        // py: core.py:1884
  get("Ordered", "name", function () { return value(this.this, "name"); });                 // py: core.py:2105
  get("Paren", "outputName", function () { return value(this.this, "name"); }, "output_name"); // py: core.py:2267
  // py: core.py:1960 -- a single-element Bracket forwards, otherwise super() ("").
  get("Bracket", "outputName", function () {
    const xs = this.expressions;
    return xs.length === 1 ? value(xs[0], "outputName", "output_name") : "";
  }, "output_name");
  get("ColumnDef", "constraints", function () { return this.args.constraints || []; });
  get("ColumnDef", "kind", function () { return this.args.kind ?? null; });
  get("From", "name", function () { return value(this.this, "name"); });
  get("From", "aliasOrName", function () { return value(this.this, "aliasOrName", "alias_or_name"); }, "alias_or_name");

  for (const p of ["method", "kind", "side", "hint"]) get("Join", p, function () { return this.text(p).toUpperCase(); });
  get("Join", "aliasOrName", function () { return value(this.this, "aliasOrName", "alias_or_name"); }, "alias_or_name");
  get("Join", "isSemiOrAntiJoin", function () { return this.kind === "SEMI" || this.kind === "ANTI"; }, "is_semi_or_anti_join");
  method(C("Join"), "on", function (...xs) { const o=options(xs), out=applyConjunctionBuilder(xs,this,"on",o); if(out.kind==="CROSS") out.set("kind",null); return out; });
  method(C("Join"), "using", function (...xs) { const o=options(xs), out=applyListBuilder(xs,this,"using",o); if(out.kind==="CROSS") out.set("kind",null); return out; });

  get("Table", "name", function () { return !this.this || this.this.constructor?.traits?.includes("Func") || this.this.constructor?.bases?.includes("Func") ? "" : value(this.this, "name"); });
  get("Table", "db", function () { return this.text("db"); });
  get("Table", "catalog", function () { return this.text("catalog"); });
  get("Table", "selects", function () { return []; });
  get("Table", "namedSelects", function () { return []; }, "named_selects");
  get("Table", "parts", function () { const out = []; for (const k of ["catalog", "db", "this"]) { const x = this.args[k]; if (!x) continue; if (x.constructor?.name === "Dot" && typeof x.flatten === "function") out.push(...x.flatten()); else if (x.args) out.push(x); } return out; });
  // py: query.py:1004.  Parts beyond the fourth become `fields` (a Dot chain), they
  // are not dropped; `copy` is threaded into column() so copy:false shares the parts.
  method(C("Table"), "toColumn", function (o={}) {
    const copy = o.copy ?? true, ps = this.parts, last = ps.at(-1);
    // Padded to four explicit positionals: spreading a shorter list would slide the
    // options object into `table`/`db`, which is the whole bug class this fixes.
    const head = ps.slice(0, 4).reverse();
    let out = last instanceof C("Identifier")
      ? column(head[0], head[1] ?? null, head[2] ?? null, head[3] ?? null, { fields: ps.slice(4), copy })
      : last;
    if (this.args.alias) out = alias_(out, this.args.alias.this, { copy });
    return out;
  });
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
  method(C("Select"), "select", function (...xs) { const o=options(xs); return applyListBuilder(xs,this,"expressions",o,Expr); });
  method(C("Select"), "lateral", function (...xs) { const o=options(xs); return applyListBuilder(xs,this,"laterals",o,C("Lateral")); });
  method(C("Select"), "window", function (...xs) { const o=options(xs); return applyListBuilder(xs,this,"windows",o,C("Window")); });
  method(C("Select"), "join", function (expression, o = {}) {
    // Parsing the source as a Join first is significant: registered parsers can
    // preserve a complete JOIN clause, while AST callers may pass its source.
    let parsedJoin = parsed(expression, { ...o, into: C("Join"), copy: o.copy ?? true });
    let join = parsedJoin instanceof C("Join") ? parsedJoin : new (C("Join"))({ this: parsedJoin });
    if (join.this instanceof C("Select")) join.set("this", join.this.subquery(null, { copy: false }));

    if (o.join_type) {
      // py: query.py:1421 `maybe_parse(f"FROM _ {join_type} JOIN _").find(Join)`, whose
      // method/side/kind come from `_parse_join_parts` (parser.py:4634): THREE ordered,
      // optional, single-token matches against Parser.JOIN_METHODS, JOIN_SIDES and
      // JOIN_KINDS, in that order.
      //
      // Reproduced here rather than parsed, because `_parse_join` is still a P3 stub.
      // The previous stand-in was a hand-written word list scanned in any order, and it
      // had drifted from the token tables in both directions: it carried GLOBAL (a
      // ClickHouse token, absent from the base JOIN_METHODS) and was missing
      // STRAIGHT_JOIN, so `join(..., join_type="straight_join")` set no kind at all and
      // rendered `SELECT * FROM tbl, tbl2` — a CROSS JOIN — where CPython gives
      // `STRAIGHT_JOIN`. Reachable from the public builder, silently.
      //
      // The word sets are now exactly the TokenType NAMES of those three tables, and
      // test/expressions/query_methods_join.test.mjs asserts that against `Parser` so
      // the duplicate cannot drift again. Matching is ordered and single-shot, which is
      // what makes `"straight_join left"` come out as kind=STRAIGHT_JOIN with NO side,
      // exactly as upstream.
      //
      // KNOWN REMAINING DIVERGENCES, and they need the real parser, not a bigger list.
      // Both come from upstream parsing the whole `FROM _ <join_type> JOIN _` string:
      //
      //   ALIAS SWALLOWING — a leading word that is not a join token becomes the FROM
      //   table's alias and the rest still parses. `"global left"` and `"bogus left"`
      //   are LEFT JOIN upstream, no-ops here; `"positional"` is a no-op upstream
      //   (POSITIONAL is in JOIN_METHODS but the FROM alias eats it) and sets method here.
      //
      //   INVALID INPUT — upstream RAISES ParseError on a string that cannot parse:
      //   "left left", "outer left", "anti semi", "asof natural" (each is two tokens
      //   competing for one slot). This block accepts them and takes the first match.
      //
      // Measured against CPython, not assumed; `test/expressions/identity_checks.test.mjs`
      // pins the cases that DO agree so the agreement cannot silently shrink. Replace
      // this whole block with `maybeParse` once `_parse_join` lands — that is the fix,
      // and it removes the divergences rather than narrowing them.
      const words = String(o.join_type).trim().toUpperCase().split(/\s+/).filter(Boolean);
      let i = 0;
      for (const [arg, set] of [["method", JOIN_METHODS], ["side", JOIN_SIDES], ["kind", JOIN_KINDS]]) {
        if (i < words.length && set.has(words[i])) join.set(arg, words[i++]);
      }
    }
    // py: query.py:1435 -- and_(), so a single Or operand stays bare and multiple
    // operands get _combine's Paren treatment. Hand-rolling the And chain skipped both.
    if (o.on) {
      const ons = Array.isArray(o.on) ? o.on : [o.on];
      join.set("on", and_(...ons, { ...o, copy: o.copy ?? true }));
    }
    // py: query.py:1441 -- a list builder that APPENDS to any pre-existing `using`.
    if (o.using) {
      const using = Array.isArray(o.using) ? o.using : [o.using];
      join = applyListBuilder(using, join, "using", o, C("Identifier"));
    }
    if (o.join_alias) join.set("this", alias_(join.this, o.join_alias, { table: true }));
    return applyListBuilder([join], this, "joins", o);
  });
  method(C("Select"), "ctas", function (table, o = {}) {
    const properties = o.properties && Object.keys(o.properties).length ? C("Properties").fromDict(o.properties) : null;
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
  // py: query.py:1543 -- `ons` is filtered before parsing, so distinct(None) yields an
  // empty Tuple rather than a Column named "null"; copy is threaded into maybe_parse.
  method(C("Select"), "distinct", function (...xs) {
    const o=options(xs), out=maybeCopy(this,o.copy??true), ons=xs.filter(Boolean);
    const on = xs.length ? new (C("Tuple"))({expressions:ons.map(x=>parsed(x,{...o,copy:o.copy??true}))}) : null;
    out.set("distinct", (o.distinct ?? true) ? new (C("Distinct"))({on}) : null);
    return out;
  });
  method(C("Select"), "lock", function (update=true,o={}) { const out=maybeCopy(this,o.copy??true); out.set("locks",[new (C("Lock"))({update})]); return out; });
  method(C("Select"), "from_", function (x, o = {}) { return applyBuilder(x, this, "from_", o, C("From")); });
  for (const [js, py, key, Into] of [["groupBy","group_by","group","Group"],["sortBy","sort_by","sort","Sort"],["clusterBy","cluster_by","cluster","Cluster"]]) {
    // py: query.py:1212 -- group_by (alone among the four) early-returns on no args,
    // so it never materialises an empty Group(); order_by/sort_by/cluster_by do.
    const earlyReturn = js === "groupBy";
    method(C("Select"), js, function (...xs) {
      const o=options(xs);
      if (earlyReturn && !xs.length) return maybeCopy(this, o.copy ?? true);
      return applyChildListBuilder(xs,this,key,o,C(Into));
    });
    method(C("Select"), py, C("Select").prototype[js]);
  }
  for (const [name, Into] of [["having","Having"],["qualify","Qualify"]]) method(C("Select"), name, function (...xs) { const o=options(xs); return applyConjunctionBuilder(xs,this,name,o,C(Into)); });

  method(C("Subquery"), "unnest", function () { let x = this; while (x instanceof C("Subquery")) x = x.this; return x; });
  method(C("Subquery"), "unwrap", function () { let x=this; while(x.sameParent && x.isWrapper) x=x.parent; return x; });
  method(C("Subquery"), "select", function (...xs) { const o=options(xs), out=maybeCopy(this,o.copy??true), inner=out.unnest(); if(typeof inner.select === "function") inner.select(...xs,{...o,copy:false}); return out; });
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
  // Delete.where / Update.where call the conjunction builder directly -- unlike
  // Query.where they do NOT unwrap a Where operand first (dml.py:146, :411).
  for (const K of all) if (has(K,"DML")) method(K,"returning",function(x,o={}){ return applyBuilder(x,this,"returning",o,C("Returning")); });
  method(C("Delete"),"delete",function(x,o={}){ return applyBuilder(x,this,"this",o,C("Table")); });
  method(C("Delete"),"where",function(...xs){const o=options(xs);return applyConjunctionBuilder(xs,this,"where",o,C("Where"));});
  method(C("Insert"),"with_",function(a,b,o={}){return cte(this,a,b,o);});
  method(C("Update"),"table",function(x,o={}){return applyBuilder(x,this,"this",o,C("Table"));});
  method(C("Update"),"set_",function(...xs){const o=options(xs);return applyListBuilder(xs,this,"expressions",o,Expr);});
  method(C("Update"),"where",function(...xs){const o=options(xs);return applyConjunctionBuilder(xs,this,"where",o,C("Where"));});
  method(C("Update"),"from_",function(x=null,o={}){return x ? applyBuilder(x,this,"from_",o,C("From")) : maybeCopy(this,o.copy??true);});
  method(C("Update"),"with_",function(a,b,o={}){return cte(this,a,b,o);});

  // Tuple.isin has no upstream override: Tuple is a Condition, so it inherits
  // Condition.isin (core.js), which now threads `copy` and handles `unnest`.
}
