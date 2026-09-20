// py: sqlglot/optimizer/annotate_types.py @ 91119bc — CORE of the file (AIR-2097,
// epic AIR-2085). The `TypeAnnotator` class: constructor, `annotate`/`annotate_scope`,
// the stack-based `_annotate_expression` dispatcher (including its `Scope`-aware
// Column-type resolution branch), `_maybe_coerce`, every `_annotate_*`/`_get_*` helper
// the base engine needs to be genuinely callable end-to-end, and the module-level
// `annotate_types()` entry point + `_build_coerces_to`/`swap_args`/`swap_all` machinery
// that builds `TypeAnnotator.COERCES_TO`/`BINARY_COERCIONS`. Scoped to the BASE engine
// only, per the epic's own phasing: per-dialect `EXPRESSION_METADATA` overlays (Snowflake
// etc, AIR-2098/2099/2100) are NOT this issue — `this.dialect.EXPRESSION_METADATA` is
// read exactly the way upstream reads it, so a future overlay lands with zero changes
// here.
//
// `typing/index.js` (AIR-2096/R51) already ported the 294-entry `EXPRESSION_METADATA`
// table itself, storing every `annotator` closure verbatim, calling `self._annotate_x(e)`
// etc. by the EXACT method names this file defines — that file's own header states "when
// `annotate_types.js` lands, zero renaming is needed here", and this file is written to
// make that literally true: every method below keeps its upstream spelling (including
// underscore-prefixed private ones), the same convention `parser.js`/`generator.js`/
// `scope.js` already use.
//
// `Dialect.EXPRESSION_METADATA` (`src/dialects/dialect.js`) is wired in this same round
// to `new Map(EXPRESSION_METADATA)` (py:957 `EXPRESSION_METADATA = EXPRESSION_METADATA.copy()`)
// — deliberately left un-wired by R51 specifically for this file's own consumer to do.
//
// Circular-import check (done, not assumed — the task brief explicitly asks for this):
// this file imports both `../dialects/dialect.js` and `./scope.js` directly at module
// top level, the same choice `optimizer/resolver.js` (R48) and `schema.js` (R41) already
// make safely. `dialects/dialect.js`'s own transitive closure reaches `optimizer/scope.js`
// (`findAllInScope`) but NOT back into this new file, `optimizer/scope.js` does not import
// `dialects/dialect.js` at all, and nothing imports `optimizer/annotate_types.js` yet — so
// there is no live cycle, unlike R32/R42/R43's `generator.js`<->`dialect.js` and
// `tsql.js` parser/dialect/generator cases, which needed the
// `Dialect.get_or_raise("x")`-at-call-time workaround. Flagged in case a future file
// changes that closure.
//
// Recurring "Python empty container is falsy, JS empty array/Map is truthy" hazard
// (PORT_PLAN.md, hit by R37/R44/R48 already) shows up repeatedly in this file:
// `pivots`/`scope.pivots`/`setop.this.selects`/`order_expressions`/`alias_cols` are all
// checked via `.length`, and `alias_types`/`aliasTypes` via `.size`, never bare
// truthiness. `_maybe_coerce`'s own `type1.expressions` check is the same hazard one
// level down (a scalar `DataType` always carries an empty `expressions` array here, not
// `undefined`).

import * as exp from "../expressions/index.js";
import { Scope, traverseScope } from "./scope.js";
import { MappingSchema, ensureSchema } from "../schema.js";
import { Dialect } from "../dialects/dialect.js";
import { OptimizeError } from "../errors.js";
import { logger } from "../logging.js";
import { ensureList, isDateUnit, isIsoDate, isIsoDatetime, seqGet } from "../helper.js";

// py:37-43 `BIGINT_EXTRACT_DATE_PARTS` — EXTRACT/DATE_PART specifiers that return
// BIGINT instead of INT.
export const BIGINT_EXTRACT_DATE_PARTS = new Set([
  "EPOCH_SECOND",
  "EPOCH_MILLISECOND",
  "EPOCH_MICROSECOND",
  "EPOCH_NANOSECOND",
  "NANOSECOND",
]);

// --- local dict-like helpers (Map OR plain object), matching schema.js's own
// file-private convention (not exported there, so duplicated narrowly here rather
// than widening that file's public surface for two one-line helpers).
function isDictLike(v) {
  return v instanceof Map || (v !== null && typeof v === "object" && !Array.isArray(v) && v.constructor === Object);
}
function dictEntries(d) {
  if (d instanceof Map) return [...d.entries()];
  if (d && typeof d === "object") return Object.entries(d);
  return [];
}

function pyClassRepr(x) {
  if (x === null || x === undefined) return "<class 'NoneType'>";
  return `<class '${x.constructor ? x.constructor.name : typeof x}'>`;
}

// py:87-98 `_coerce_date_literal`.
function _coerce_date_literal(l, unit) {
  const dateText = l.name;
  const isIsoDate_ = isIsoDate(dateText);

  if (isIsoDate_ && isDateUnit(unit)) {
    return exp.DType.DATE;
  }

  // An ISO date is also an ISO datetime, but not vice versa.
  if (isIsoDate_ || isIsoDatetime(dateText)) {
    return exp.DType.DATETIME;
  }

  return exp.DType.UNKNOWN;
}

// py:101-104 `_coerce_date`.
function _coerce_date(l, unit) {
  if (!isDateUnit(unit)) {
    return exp.DType.DATETIME;
  }
  return l.type ? l.type.this : exp.DType.UNKNOWN;
}

// py:107-112 `swap_args`.
function swap_args(func) {
  return (l, r) => func(r, l);
}

// py:115-116 `swap_all` — nested `Map<DType, Map<DType, func>>` instead of a
// `dict[(DType, DType), func]`, since JS has no tuple keys; a `Map` keyed by the
// frozen singleton `DType` records themselves compares by reference, exactly like
// Python's Enum-identity dict keys.
function swap_all(coercions) {
  const result = new Map();
  for (const [a, inner] of coercions) {
    result.set(a, new Map(inner));
  }
  for (const [a, inner] of coercions) {
    for (const [b, fn] of inner) {
      if (!result.has(b)) result.set(b, new Map());
      result.get(b).set(a, swap_args(fn));
    }
  }
  return result;
}

function buildCoercionGroup(entries) {
  const m = new Map();
  for (const [[a, b], fn] of entries) {
    if (!m.has(a)) m.set(a, new Map());
    m.get(a).set(b, fn);
  }
  return m;
}

function mergeCoercionGroups(...groups) {
  const result = new Map();
  for (const g of groups) {
    for (const [a, inner] of g) {
      if (!result.has(a)) result.set(a, new Map());
      for (const [b, fn] of inner) result.get(a).set(b, fn);
    }
  }
  return result;
}

// py:119-154 `_build_coerces_to` — highest-to-lowest type precedence, as specified in
// Spark's docs (ANSI).
function _build_coerces_to() {
  const textPrecedence = [exp.DType.TEXT, exp.DType.NVARCHAR, exp.DType.VARCHAR, exp.DType.NCHAR, exp.DType.CHAR];
  const numericPrecedence = [
    exp.DType.DECFLOAT, exp.DType.DOUBLE, exp.DType.FLOAT, exp.DType.BIGDECIMAL, exp.DType.DECIMAL,
    exp.DType.BIGINT, exp.DType.INT, exp.DType.SMALLINT, exp.DType.TINYINT,
  ];
  const timelikePrecedence = [exp.DType.TIMESTAMPLTZ, exp.DType.TIMESTAMPTZ, exp.DType.TIMESTAMP, exp.DType.DATETIME, exp.DType.DATE];

  const result = new Map();
  for (const typePrecedence of [textPrecedence, numericPrecedence, timelikePrecedence]) {
    let coercesTo = new Set();
    for (const dataType of typePrecedence) {
      result.set(dataType, new Set(coercesTo));
      coercesTo = new Set([...coercesTo, dataType]);
    }
  }
  return result;
}

const _COERCES_TO = _build_coerces_to();

// py:170-194 `TypeAnnotator.BINARY_COERCIONS` — coercion functions for binary
// operations, keyed by the pair of operand DTypes.
const _TEXT_INTERVAL_GROUP = buildCoercionGroup(
  [...exp.DataType.TEXT_TYPES].map((t) => [
    [t, exp.DType.INTERVAL],
    (l, r) => _coerce_date_literal(l, r.args.unit),
  ]),
);

const _TEXT_NUMERIC_GROUP_ENTRIES = [];
for (const text of exp.DataType.TEXT_TYPES) {
  for (const numeric of exp.DataType.NUMERIC_TYPES) {
    _TEXT_NUMERIC_GROUP_ENTRIES.push([
      [text, numeric],
      // text + numeric will yield the numeric type to match most dialects' semantics.
      (l, r) => (exp.DataType.NUMERIC_TYPES.has(l.type) ? l.type : r.type),
    ]);
  }
}
const _TEXT_NUMERIC_GROUP = buildCoercionGroup(_TEXT_NUMERIC_GROUP_ENTRIES);

const _DATE_INTERVAL_GROUP = buildCoercionGroup([
  [[exp.DType.DATE, exp.DType.INTERVAL], (l, r) => _coerce_date(l, r.args.unit)],
]);

const BINARY_COERCIONS = mergeCoercionGroups(
  swap_all(_TEXT_INTERVAL_GROUP),
  swap_all(_TEXT_NUMERIC_GROUP),
  swap_all(_DATE_INTERVAL_GROUP),
);

/**
 * py: sqlglot/optimizer/annotate_types.py:160 `class TypeAnnotator`.
 *
 * Infers the types of an Expr tree, annotating its AST accordingly.
 */
export class TypeAnnotator {
  static NESTED_TYPES = new Set([exp.DType.ARRAY]);
  static COERCES_TO = _COERCES_TO;
  static BINARY_COERCIONS = BINARY_COERCIONS;

  // py:196-231 `__init__`.
  constructor(schema, options = {}) {
    const {
      expressionMetadata = null,
      coercesTo = null,
      binaryCoercions = null,
      overwriteTypes = true,
    } = options;

    this.schema = schema;
    const dialect = schema.dialect || new Dialect();
    this.dialect = dialect;
    this.expressionMetadata = expressionMetadata || dialect.EXPRESSION_METADATA;
    // py: `coerces_to or dialect.COERCES_TO or self.COERCES_TO` — an empty Python dict
    // is falsy, but an empty JS `Map` is truthy, so the middle fallback needs an
    // explicit `.size` check rather than bare truthiness.
    this.coercesTo = coercesTo || (dialect.COERCES_TO.size ? dialect.COERCES_TO : TypeAnnotator.COERCES_TO);
    this.binaryCoercions = binaryCoercions || TypeAnnotator.BINARY_COERCIONS;

    // Caches the annotated sub-Exprs, to ensure we only visit them once. A JS `Set`
    // already compares object values by reference, so this stores the expression
    // objects directly rather than reproducing Python's `set[int]` of `id(expr)`.
    this._visited = new Set();

    // Caches NULL-annotated expressions to set them to UNKNOWN after type inference is
    // completed. Same object-identity-as-key reasoning as `_visited` above.
    this._nullExpressions = new Set();

    // Databricks and Spark >=v3 actually support NULL (i.e., VOID) as a type.
    this._supportsNullType = dialect.SUPPORTS_NULL_TYPE;

    // Maps an exp.SetOperation to its projection types (object identity as the key,
    // same reasoning as above).
    this._setopColumnTypes = new Map();

    // When set to false, this enables partial annotation by skipping already-annotated
    // nodes.
    this._overwriteTypes = overwriteTypes;

    // Maps (Scope, source_name) to its column projections and types. A nested
    // `Map<Scope, Map<string, ...>>` stands in for Python's `dict[(Scope, str), ...]`
    // tuple-keyed cache, since JS has no tuple keys.
    this._scopeSourceSelects = new Map();
  }

  // py:233-237 `clear`.
  clear() {
    this._visited.clear();
    this._nullExpressions.clear();
    this._setopColumnTypes.clear();
    this._scopeSourceSelects.clear();
  }

  // py:239-251 `uncache` — evicts `expression` (or its subtree, if `deep`) from the
  // annotation caches.
  uncache(expression, deep = true) {
    const nodes = deep ? expression.walk() : [expression];
    for (const node of nodes) {
      this._visited.delete(node);
      this._nullExpressions.delete(node);
      this._setopColumnTypes.delete(node);
    }
  }

  // py:255-276 `_set_type`.
  _set_type(expression, targetType) {
    const prevType = expression.type;
    const dtype = targetType || exp.DType.UNKNOWN;
    expression._type = dtype instanceof exp.DataType ? dtype : dtype.into_expr();
    this._visited.add(expression);

    if (!this._supportsNullType && expression.type.this === exp.DType.NULL) {
      this._nullExpressions.add(expression);
    } else if (prevType && prevType.this === exp.DType.NULL) {
      this._nullExpressions.delete(expression);
    }

    return expression;
  }

  // py:278-295 `annotate`.
  annotate(expression, annotateScope = true) {
    // This flag is used to avoid costly scope traversals when we only care about
    // annotating non-column expressions (partial type inference), e.g., when
    // simplifying in the optimizer.
    if (annotateScope) {
      for (const scope of traverseScope(expression)) {
        this.annotate_scope(scope);
      }
    }

    // This takes care of non-traversable expressions.
    this._annotate_expression(expression);

    // Replace NULL type with the default type of the targeted dialect, since the
    // former is not an actual type; it is mostly used to aid type coercion, e.g. in
    // query set operations.
    for (const expr of [...this._nullExpressions]) {
      this._set_type(expr, this.dialect.DEFAULT_NULL_TYPE);
    }

    return expression;
  }

  // py:297-349 `_get_scope_source_selects`.
  _get_scope_source_selects(scope, sourceName) {
    let bySource = this._scopeSourceSelects.get(scope);
    if (bySource && bySource.has(sourceName)) {
      return bySource.get(sourceName);
    }

    let selects = new Map();
    const source = scope.sources.get(sourceName);

    if (source instanceof Scope) {
      selects = this._get_source_scope_selects(source);
    } else {
      const pivots = source instanceof exp.Table ? (source.args.pivots || []) : scope.pivots;

      // Only the last operator in a chain carries the alias that names the resulting
      // source, so match on it and fold the whole chain in order.
      // deny:operators sqlglot/optimizer/annotate_types.py:315 — Python `pivots[-1]`;
      // `pivots[pivots.length - 1]` is the explicit equivalent (`pivots` is a plain
      // list, not an Expr, so this is not `Expr.__getitem__`/Bracket-building).
      if (pivots.length && pivots[pivots.length - 1].aliasOrName === sourceName) {
        // deny:operators sqlglot/optimizer/annotate_types.py:316 — same `pivots[-1]`
        // shape as above.
        const lastPivot = pivots[pivots.length - 1];
        const parent = lastPivot.parent;
        let parentSource = parent ? scope.sources.get(parent.aliasOrName) : null;

        if (!(parentSource instanceof Scope) && parent instanceof exp.Table && !parent.db) {
          // A chain aliased like the CTE it reads from shadows it in `scope.sources`,
          // so reach for the CTE's scope directly.
          parentSource = scope.cteSources.get(parent.name);
        }

        let srcTypes;
        if (parentSource instanceof Scope) {
          srcTypes = this._get_source_scope_selects(parentSource);
        } else if (parent instanceof exp.Table && this.schema instanceof MappingSchema) {
          srcTypes = this.schema.find(parent, false, true) || new Map();
        } else {
          srcTypes = new Map();
        }

        for (const pivot of pivots) {
          srcTypes = pivot.unpivot
            ? this._get_unpivot_column_types(pivot, srcTypes)
            : this._get_pivot_column_types(pivot, srcTypes);
        }

        selects = srcTypes;
      }
    }

    if (!bySource) {
      bySource = new Map();
      this._scopeSourceSelects.set(scope, bySource);
    }
    bySource.set(sourceName, selects);

    return selects;
  }

  // py:351-397 `_get_source_scope_selects`.
  _get_source_scope_selects(source) {
    const expression = source.expression;

    if (expression instanceof exp.UDTF) {
      let values = [];

      if (expression instanceof exp.Lateral) {
        if (expression.this instanceof exp.Explode) {
          values = [expression.this.this];
        }
      } else if (expression instanceof exp.Unnest) {
        values = [expression];
      } else if (!(expression instanceof exp.TableFromRows)) {
        values = expression.expressions[0].expressions;
      }

      if (!values.length) return new Map();

      const aliasColumnNames = expression.aliasColumnNames;

      let expType;
      if (expression instanceof exp.Unnest) {
        expType = expression.type;
      } else if (expression instanceof exp.Lateral && expression.this instanceof exp.Explode) {
        expType = expression.this.type;
      } else {
        expType = null;
      }

      const structType = expType && expType.isType(exp.DType.STRUCT) ? expType : null;

      if (structType) {
        const result = new Map();
        for (const colDef of structType.expressions) {
          if (colDef instanceof exp.ColumnDef && colDef.kind) {
            result.set(colDef.name, colDef.kind);
          }
        }
        return result;
      }

      const result = new Map();
      const n = Math.min(aliasColumnNames.length, values.length);
      for (let i = 0; i < n; i++) result.set(aliasColumnNames[i], values[i].type);
      return result;
    }

    if (
      expression instanceof exp.SetOperation &&
      (expression.args.by_name || expression.this.selects.length === expression.expression.selects.length)
    ) {
      return this._get_setop_column_types(expression);
    }

    if (expression instanceof exp.Selectable) {
      const result = new Map();
      for (const s of expression.selects) {
        if (s.type) result.set(s.aliasOrName, s.type);
      }
      return result;
    }

    return new Map();
  }

  // py:399-452 `annotate_scope`.
  annotate_scope(scope) {
    if (this.schema instanceof MappingSchema) {
      for (const tableColumn of scope.tableColumns) {
        const source = scope.sources.get(tableColumn.name);

        if (source instanceof exp.Table) {
          const schema = this.schema.find(source, false, true);
          if (!isDictLike(schema)) continue;

          const structType = new exp.DataType({
            this: exp.DType.STRUCT,
            expressions: dictEntries(schema).map(
              ([c, kind]) => new exp.ColumnDef({ this: exp.toIdentifier(String(c)), kind }),
            ),
            nested: true,
          });
          this._set_type(tableColumn, structType);
        } else if (
          source instanceof Scope &&
          source.expression instanceof exp.Query &&
          (source.expression.metaGet("query_type") || exp.DType.UNKNOWN.into_expr()).isType(exp.DType.STRUCT)
        ) {
          this._set_type(tableColumn, source.expression.meta.query_type);
        }
      }
    }

    // Iterate through all the expressions of the current scope in post-order, and
    // annotate.
    this._annotate_expression(scope.expression, scope);
    this._fixup_order_by_aliases(scope);

    if (this.dialect.QUERY_RESULTS_ARE_STRUCTS && scope.expression instanceof exp.Query) {
      const structType = new exp.DataType({
        this: exp.DType.STRUCT,
        expressions: scope.expression.selects.map(
          (select) => new exp.ColumnDef({
            this: exp.toIdentifier(select.outputName),
            kind: select.type ? select.type.copy() : null,
          }),
        ),
        nested: true,
      });

      const anyUnknown = structType.expressions
        .filter((cd) => cd.kind)
        .some((cd) => cd.kind.isType(exp.DType.UNKNOWN));

      if (!anyUnknown) {
        // We don't use `_set_type` on purpose here. If we annotated the query
        // directly, then using it in other contexts (e.g., ARRAY(<query>)) could
        // result in incorrect type annotations, i.e., it shouldn't be interpreted as
        // a STRUCT value.
        scope.expression.meta.query_type = structType;
      }
    }
  }

  // py:454-536 `_annotate_expression`.
  _annotate_expression(expression, scope = null) {
    const stack = [[expression, false]];

    while (stack.length) {
      const [expr, childrenAnnotated] = stack.pop();

      if (
        this._visited.has(expr)
        || (!this._overwriteTypes && expr.type && !expr.isType(exp.DType.UNKNOWN))
      ) {
        continue; // We've already inferred the expression's type.
      }

      if (!childrenAnnotated) {
        stack.push([expr, true]);
        for (const childExpr of expr.iterExpressions()) {
          stack.push([childExpr, false]);
        }
        continue;
      }

      if (scope && expr instanceof exp.Column && expr.table) {
        let source = null;
        let sourceScope = scope;
        while (sourceScope && !source) {
          source = sourceScope.sources.get(expr.table);
          if (!source) sourceScope = sourceScope.parent;
        }

        if (source instanceof exp.Table) {
          let tableColType = this.schema.getColumnType(source, expr);
          if (
            tableColType instanceof exp.DataType
            && tableColType.isType(exp.DType.UNKNOWN)
            && source.args.pivots && source.args.pivots.length
          ) {
            tableColType = this._get_scope_source_selects(sourceScope || scope, expr.table).get(expr.name)
              || exp.DType.UNKNOWN;
          }
          this._set_type(expr, tableColType);
        } else if (source && sourceScope) {
          const colType = this._get_scope_source_selects(sourceScope, expr.table).get(expr.name);
          if (colType) {
            this._set_type(expr, colType);
          } else if (source.expression instanceof exp.Unnest) {
            this._set_type(expr, source.expression.type);
          } else {
            this._set_type(expr, exp.DType.UNKNOWN);
          }
        } else if (!source && scope.pivots.length) {
          const colType = this._get_scope_source_selects(scope, expr.table).get(expr.name);
          if (colType) {
            this._set_type(expr, colType);
          } else {
            this._set_type(expr, exp.DType.UNKNOWN);
          }
        } else {
          this._set_type(expr, exp.DType.UNKNOWN);
        }

        this._restore_dot_parts(expr);

        if (expr.type && expr.type.args.nullable === false) {
          expr.meta.nonnull = true;
        }
        continue;
      }

      const spec = this.expressionMetadata.get(expr.constructor);

      if (spec && spec.annotator) {
        spec.annotator(this, expr);
      } else if (spec && spec.returns) {
        this._set_type(expr, spec.returns);
      } else {
        this._set_type(expr, exp.DType.UNKNOWN);
      }

      this._restore_dot_parts(expr);
    }
  }

  // py:538-562 `_restore_dot_parts` — dot access into semi-structured values is a
  // case-sensitive data lookup, i.e. the engine doesn't resolve the keys as
  // identifiers, so we undo their normalization.
  _restore_dot_parts(expr) {
    const dotParts = expr.metaGet("dot_parts");
    const hasDotParts = !!(dotParts && dotParts.length);

    if (!hasDotParts || !expr.isType(exp.DType.JSON, exp.DType.MAP, exp.DType.VARIANT)) {
      if (hasDotParts) delete expr.meta.dot_parts;
      return;
    }

    let parent = expr.parent;
    for (const part of dotParts) {
      if (!(parent instanceof exp.Dot)) break;

      const identifier = parent.expression;
      if (identifier instanceof exp.Identifier) {
        // Rename in place to preserve the identifier's meta, e.g. token positions.
        identifier.set("this", part);
        identifier.set("quoted", true);
      } else {
        identifier.replace(exp.toIdentifier(part, true));
      }

      parent = parent.parent;
    }

    delete expr.meta.dot_parts;
  }

  // py:564-598 `_fixup_order_by_aliases`.
  _fixup_order_by_aliases(scope) {
    const query = scope.expression;
    if (!(query instanceof exp.Query)) return;

    const order = query.args.order;
    if (!order) return;

    // Build alias -> type map from fully-annotated projections (last match wins,
    // consistent with how `_expand_alias_refs` handles duplicate aliases).
    const aliasTypes = new Map();
    for (const sel of query.selects) {
      if (sel instanceof exp.Alias && sel.this.type && !sel.this.isType(exp.DType.UNKNOWN)) {
        aliasTypes.set(sel.alias, sel.this.type);
      }
    }

    if (!aliasTypes.size) return;

    for (const ordered of order.expressions) {
      const aliasCols = [...ordered.findAll(exp.Column)].filter((c) => !c.table && aliasTypes.has(c.name));
      for (const col of aliasCols) {
        this._set_type(col, aliasTypes.get(col.name));
      }

      if (aliasCols.length) {
        for (const node of ordered.walk(true, (n) => n instanceof exp.Subquery)) {
          if (!(node instanceof exp.Column || node instanceof exp.Literal)) {
            this._visited.delete(node);
          }
        }
        this._annotate_expression(ordered, scope);
      }
    }
  }

  // py:600-634 `_maybe_coerce` — returns type2 if type1 can be coerced into it,
  // otherwise type1. If either type is parameterized (e.g. DECIMAL(18, 2) contains two
  // parameters), we assume type1 does not coerce into type2, so we also return it in
  // this case.
  _maybe_coerce(type1, type2) {
    let type1Value;
    if (type1 instanceof exp.DataType) {
      if (type1.expressions.length || !(type1.this && type1.this.__enum__ === "DType")) return type1;
      type1Value = type1.this;
    } else {
      type1Value = type1;
    }

    let type2Value;
    if (type2 instanceof exp.DataType) {
      if (type2.expressions.length || !(type2.this && type2.this.__enum__ === "DType")) return type2;
      type2Value = type2.this;
    } else {
      type2Value = type2;
    }

    // We propagate the UNKNOWN type upwards if found.
    if (type1Value === exp.DType.UNKNOWN || type2Value === exp.DType.UNKNOWN) return exp.DType.UNKNOWN;

    if (type1Value === exp.DType.NULL) return type2Value;
    if (type2Value === exp.DType.NULL) return type1Value;

    const coercesSet = this.coercesTo.get(type1Value);
    return coercesSet && coercesSet.has(type2Value) ? type2Value : type1Value;
  }

  // py:636-705 `_get_setop_column_types` — computes and returns the coerced column
  // types for a SetOperation. This handles UNION, INTERSECT, EXCEPT, etc., coercing
  // types across left and right operands for all projections/columns.
  _get_setop_column_types(setop) {
    if (this._setopColumnTypes.has(setop)) {
      return this._setopColumnTypes.get(setop);
    }

    const colTypes = new Map();

    // Validate that left and right have same number of projections (BY NAME
    // operations match columns by name, so their counts are allowed to differ).
    if (
      !(
        setop instanceof exp.SetOperation
        && setop.this.selects.length
        && setop.expression.selects.length
        && (setop.args.by_name || setop.this.selects.length === setop.expression.selects.length)
      )
    ) {
      return colTypes;
    }

    // Process a chain / sub-tree of set operations.
    for (const setOp of setop.walk(true, (n) => !(n instanceof exp.SetOperation || n instanceof exp.Subquery))) {
      if (!(setOp instanceof exp.SetOperation)) continue;

      let setopCols = new Map();

      if (setOp.args.by_name) {
        // Columns missing from one side are filled with NULLs, so the other side's
        // type is preserved (NULL is the identity for `_maybe_coerce`).
        const rTypeBySelect = new Map();
        for (const s of setOp.expression.selects) rTypeBySelect.set(s.aliasOrName, s.type);

        for (const s of setOp.this.selects) {
          const name = s.aliasOrName;
          let popped;
          if (rTypeBySelect.has(name)) {
            popped = rTypeBySelect.get(name);
            rTypeBySelect.delete(name);
          } else {
            popped = exp.DType.NULL;
          }
          setopCols.set(name, this._maybe_coerce(s.type, popped || exp.DType.UNKNOWN));
        }
        for (const [name, rType] of rTypeBySelect) {
          setopCols.set(name, rType || exp.DType.UNKNOWN);
        }
      } else {
        const thisSelects = setOp.this.selects;
        const exprSelects = setOp.expression.selects;
        const n = Math.min(thisSelects.length, exprSelects.length);
        for (let i = 0; i < n; i++) {
          setopCols.set(thisSelects[i].aliasOrName, this._maybe_coerce(thisSelects[i].type, exprSelects[i].type));
        }
      }

      // Coerce intermediate results with the previously registered types, if they
      // exist.
      for (const [colName, colType] of setopCols) {
        const prev = colTypes.has(colName) ? colTypes.get(colName) : exp.DType.NULL;
        colTypes.set(colName, this._maybe_coerce(colType, prev));
      }
    }

    this._setopColumnTypes.set(setop, colTypes);
    return colTypes;
  }

  // py:707-738 `_get_unpivot_column_types`.
  _get_unpivot_column_types(pivot, srcTypes) {
    const newTypes = new Map();

    for (const field of pivot.fields) {
      const fieldCol = field.this;
      const first = seqGet(field.expressions, 0);

      let inSrc;
      if (first instanceof exp.PivotAlias && first.args.alias) {
        newTypes.set(fieldCol.name, first.args.alias.type);
        inSrc = first.this;
      } else {
        newTypes.set(fieldCol.name, exp.DType.VARCHAR.into_expr());
        inSrc = first;
      }

      const inCols = inSrc instanceof exp.Tuple ? inSrc.expressions : [inSrc];
      const valExpr = seqGet(pivot.expressions, 0);
      const valCols = valExpr instanceof exp.Tuple ? valExpr.expressions : [valExpr];

      // A chained operator's IN-list may name columns an earlier operator produced,
      // which carry no annotation of their own.
      const n = Math.min(valCols.length, inCols.length);
      for (let i = 0; i < n; i++) {
        const valCol = valCols[i];
        const inCol = inCols[i];
        let inType = inCol.type;
        if (!inType || inType.isType(exp.DType.UNKNOWN)) {
          inType = srcTypes.get(inCol.outputName) || inType;
        }
        newTypes.set(valCol.outputName, inType);
      }
    }

    const result = new Map();
    for (const name of pivot.outputColumns([...srcTypes.keys()])) {
      const type_ = newTypes.get(name) || srcTypes.get(name);
      if (type_) result.set(name, type_);
    }
    return result;
  }

  // py:740-774 `_get_pivot_column_types`.
  _get_pivot_column_types(pivot, srcTypes) {
    const firstField = seqGet(pivot.fields, 0);
    if (!(firstField instanceof exp.In)) {
      throw new OptimizeError(`Expected In expression for pivot field, got ${pyClassRepr(firstField)}`);
    }

    const pivotConstants = firstField.expressions;

    // The first agg_cols_offset entries are source columns that pass through the
    // PIVOT unchanged; the rest are the aggregated columns, one per combination of IN
    // value and aggregate function.
    const outputToSrc = pivot.outputColumns([...srcTypes.keys()]);
    const outputNames = [...outputToSrc.keys()];

    const aggTypes = pivot.expressions.map((agg) => (agg instanceof exp.Alias ? agg.this.type : agg.type));
    const aggColsOffset = outputNames.length - pivotConstants.length * aggTypes.length;
    if (aggColsOffset < 0) {
      throw new OptimizeError(`Negative pivot column offset: ${aggColsOffset}`);
    }

    const newTypes = new Map();

    for (let i = 0; i < aggColsOffset; i++) {
      const name = outputNames[i];
      const type_ = srcTypes.get(outputToSrc.get(name));
      if (type_) newTypes.set(name, type_);
    }

    const repeatedAggTypes = [];
    for (let c = 0; c < pivotConstants.length; c++) {
      for (const a of aggTypes) repeatedAggTypes.push(a);
    }

    for (let i = aggColsOffset; i < outputNames.length; i++) {
      const aggType = repeatedAggTypes[i - aggColsOffset];
      if (aggType) newTypes.set(outputNames[i], aggType);
    }

    return newTypes;
  }

  // py:776-802 `_annotate_binary`.
  _annotate_binary(expression) {
    const left = expression.left;
    const right = expression.right;
    if (!left || !right) {
      const expressionSql = expression.sql(this.dialect);
      logger.warning(`Failed to annotate badly formed binary expression: ${expressionSql}`);
      this._set_type(expression, null);
      return expression;
    }

    const leftType = left.type ? left.type.this : exp.DType.UNKNOWN;
    const rightType = right.type ? right.type.this : exp.DType.UNKNOWN;

    if (expression instanceof exp.Connector || expression instanceof exp.Predicate) {
      this._set_type(expression, exp.DType.BOOLEAN);
    } else {
      const coercion = this.binaryCoercions.get(leftType)?.get(rightType);
      if (coercion) {
        this._set_type(expression, coercion(left, right));
      } else {
        this._annotate_by_args(expression, left, right);
      }
    }

    if (
      expression instanceof exp.Is
      || (left.metaGet("nonnull") === true && right.metaGet("nonnull") === true)
    ) {
      expression.meta.nonnull = true;
    }

    return expression;
  }

  // py:804-813 `_annotate_unary`.
  _annotate_unary(expression) {
    if (expression instanceof exp.Not) {
      this._set_type(expression, exp.DType.BOOLEAN);
    } else {
      this._set_type(expression, expression.this.type);
    }

    if (expression.this.metaGet("nonnull") === true) {
      expression.meta.nonnull = true;
    }

    return expression;
  }

  // py:815-825 `_annotate_literal`.
  _annotate_literal(expression) {
    if (expression.isString) {
      this._set_type(expression, exp.DType.VARCHAR);
    } else if (expression.isInt) {
      this._set_type(expression, exp.DType.INT);
    } else {
      this._set_type(expression, exp.DType.DOUBLE);
    }

    expression.meta.nonnull = true;

    return expression;
  }

  // py:827-905 `_annotate_by_args`. The trailing `{promote, array}` options object
  // stands in for upstream's keyword-only `promote`/`array` parameters — every real
  // call site in `typing/index.js` passes either plain strings/Exprs or ends with a
  // plain-object literal, so a `constructor === Object` check on the last argument
  // unambiguously distinguishes the two shapes.
  _annotate_by_args(expression, ...rest) {
    let promote = false;
    let array = false;
    let args = rest;

    const last = rest.length ? rest[rest.length - 1] : undefined;
    if (last && last.constructor === Object) {
      promote = last.promote ?? false;
      array = last.array ?? false;
      args = rest.slice(0, -1);
    }

    let literalType = null;
    let nonLiteralType = null;
    let nestedType = null;

    for (const arg of args) {
      const expressions = typeof arg === "string" ? expression.args[arg] : arg;

      for (const expr of ensureList(expressions)) {
        const exprType = expr.type;

        if (exprType === null || exprType === undefined || exprType.isType(exp.DType.UNKNOWN)) {
          this._set_type(expression, exp.DType.UNKNOWN);
          return expression;
        }

        if (nestedType) continue;

        // Stop coercing at the first nested data type found.
        if (exprType.args.nested) {
          nestedType = exprType;
        } else if (expr instanceof exp.Literal) {
          literalType = this._maybe_coerce(literalType || exprType, exprType);
        } else {
          nonLiteralType = this._maybe_coerce(nonLiteralType || exprType, exprType);
        }
      }
    }

    let resultType = null;

    if (nestedType) {
      resultType = nestedType;
    } else if (literalType && nonLiteralType) {
      if (this.dialect.PRIORITIZE_NON_LITERAL_TYPES) {
        const literalThisType = literalType instanceof exp.DataType ? literalType.this : literalType;
        const nonLiteralThisType = nonLiteralType instanceof exp.DataType ? nonLiteralType.this : nonLiteralType;
        if (
          (exp.DataType.INTEGER_TYPES.has(literalThisType) && exp.DataType.INTEGER_TYPES.has(nonLiteralThisType))
          || (exp.DataType.REAL_TYPES.has(literalThisType) && exp.DataType.REAL_TYPES.has(nonLiteralThisType))
        ) {
          resultType = nonLiteralType;
        }
      }

      if (resultType === null) {
        resultType = this._maybe_coerce(nonLiteralType, literalType);
      }
    } else {
      resultType = literalType || nonLiteralType || exp.DType.UNKNOWN;
    }

    this._set_type(expression, resultType);

    if (promote) {
      const thisType = resultType instanceof exp.DataType ? resultType.this : resultType;
      if (exp.DataType.INTEGER_TYPES.has(thisType)) {
        this._set_type(expression, exp.DType.BIGINT);
      } else if (exp.DataType.FLOAT_TYPES.has(thisType)) {
        this._set_type(expression, exp.DType.DOUBLE);
      }
    }

    if (array) {
      this._set_type(
        expression,
        new exp.DataType({ this: exp.DType.ARRAY, expressions: [expression.type], nested: true }),
      );
    }

    return expression;
  }

  // py:907-918 `_annotate_timeunit`.
  _annotate_timeunit(expression) {
    let datatype;
    const thisTypeThis = expression.this.type.this;

    if (exp.DataType.TEXT_TYPES.has(thisTypeThis)) {
      datatype = _coerce_date_literal(expression.this, expression.args.unit);
    } else if (exp.DataType.TEMPORAL_TYPES.has(thisTypeThis)) {
      datatype = _coerce_date(expression.this, expression.args.unit);
    } else {
      datatype = exp.DType.UNKNOWN;
    }

    this._set_type(expression, datatype);
    return expression;
  }

  // py:920-935 `_annotate_bracket`.
  _annotate_bracket(expression) {
    const bracketArg = expression.expressions[0];
    const this_ = expression.this;

    let mapIndex = -1;
    const isMapLike = this_ instanceof exp.Map || this_ instanceof exp.VarMap;
    if (isMapLike) mapIndex = this_.keys.findIndex((k) => bracketArg.equals(k));

    if (bracketArg instanceof exp.Slice) {
      this._set_type(expression, this_.type);
    } else if (this_.type.isType(exp.DType.ARRAY)) {
      this._set_type(expression, seqGet(this_.type.expressions, 0));
    } else if (isMapLike && mapIndex !== -1) {
      const value = seqGet(this_.values, mapIndex);
      this._set_type(expression, value ? value.type : null);
    } else {
      this._set_type(expression, exp.DType.UNKNOWN);
    }

    return expression;
  }

  // py:937-953 `_annotate_div`.
  _annotate_div(expression) {
    const left = expression.left;
    const right = expression.right;
    const leftType = left.type ? left.type.this : exp.DType.UNKNOWN;
    const rightType = right.type ? right.type.this : exp.DType.UNKNOWN;

    if (
      expression.args.typed
      && exp.DataType.INTEGER_TYPES.has(leftType)
      && exp.DataType.INTEGER_TYPES.has(rightType)
    ) {
      this._set_type(expression, exp.DType.BIGINT);
    } else {
      this._set_type(expression, this._maybe_coerce(leftType, rightType));
      if (expression.type && !exp.DataType.REAL_TYPES.has(expression.type.this)) {
        this._set_type(expression, this._maybe_coerce(expression.type, exp.DType.DOUBLE));
      }
    }

    return expression;
  }

  // py:955-971 `_annotate_dot`.
  _annotate_dot(expression) {
    this._set_type(expression, null);

    // Propagate type from qualified UDF calls (e.g., db.my_udf(...)).
    if (expression.expression instanceof exp.Anonymous) {
      this._set_type(expression, expression.expression.type);
      return expression;
    }

    const thisType = expression.this.type;

    if (thisType && thisType.isType(exp.DType.STRUCT)) {
      for (const e of thisType.expressions) {
        if (e.name === expression.expression.name) {
          this._set_type(expression, e.kind);
          break;
        }
      }
    }

    return expression;
  }

  // py:973-979 `_annotate_explode`.
  _annotate_explode(expression) {
    const inputType = expression.this.type;
    if (inputType && inputType.isType(exp.DType.ARRAY)) {
      this._set_type(expression, seqGet(inputType.expressions, 0));
    } else {
      this._set_type(expression, null);
    }
    return expression;
  }

  // py:981-990 `_annotate_unnest`.
  _annotate_unnest(expression) {
    const child = seqGet(expression.expressions, 0);

    let exprType;
    if (child && child.isType(exp.DType.ARRAY)) {
      exprType = seqGet(child.type.expressions, 0);
    } else {
      exprType = null;
    }

    this._set_type(expression, exprType);
    return expression;
  }

  // py:992-1005 `_annotate_subquery` — for scalar subqueries (subqueries with a
  // single projection), infer the type from that single projection. This allows type
  // propagation in cases like: SELECT (SELECT 1 AS c) AS c.
  _annotate_subquery(expression) {
    const query = expression.unnest();

    if (query instanceof exp.Query) {
      const selects = query.selects;
      if (selects.length === 1) {
        this._set_type(expression, selects[0].type);
        return expression;
      }
    }

    this._set_type(expression, exp.DType.UNKNOWN);
    return expression;
  }

  // py:1007-1028 `_annotate_struct_value`.
  _annotate_struct_value(expression) {
    let this_ = null;
    let kind = expression.type;

    const alias = expression.args.alias;
    if (alias) {
      // Case: STRUCT(key AS value).
      this_ = alias.copy();
    } else if (expression.expression) {
      // Case: STRUCT(key = value) or STRUCT(key := value).
      this_ = expression.this.copy();
      kind = expression.expression.type;
    } else if (expression instanceof exp.Column) {
      // Case: STRUCT(c).
      this_ = expression.this.copy();
    }

    if (kind && kind.isType(exp.DType.UNKNOWN)) {
      return null;
    }

    if (this_) {
      return new exp.ColumnDef({ this: this_, kind });
    }

    return kind;
  }

  // py:1030-1044 `_annotate_struct`.
  _annotate_struct(expression) {
    const expressions = [];
    for (const expr of expression.expressions) {
      const structFieldType = this._annotate_struct_value(expr);
      if (structFieldType === null) {
        this._set_type(expression, null);
        return expression;
      }
      expressions.push(structFieldType);
    }

    this._set_type(expression, new exp.DataType({ this: exp.DType.STRUCT, expressions, nested: true }));
    return expression;
  }

  // py:1046-1066 `_annotate_map`.
  _annotate_map(expression) {
    const keys = expression.args.keys;
    const values = expression.args.values;

    const mapType = new exp.DataType({ this: exp.DType.MAP });
    if (keys instanceof exp.Array && values instanceof exp.Array) {
      const keyType = seqGet(keys.type.expressions, 0) || exp.DType.UNKNOWN;
      const valueType = seqGet(values.type.expressions, 0) || exp.DType.UNKNOWN;

      if (keyType !== exp.DType.UNKNOWN && valueType !== exp.DType.UNKNOWN) {
        mapType.set("expressions", [keyType, valueType]);
        mapType.set("nested", true);
      }
    }

    this._set_type(expression, mapType);
    return expression;
  }

  // py:1068-1080 `_annotate_to_map`.
  _annotate_to_map(expression) {
    const mapType = new exp.DataType({ this: exp.DType.MAP });
    const arg = expression.this;
    if (arg.isType(exp.DType.STRUCT)) {
      for (const coldef of arg.type.expressions) {
        const kind = coldef.kind;
        if (kind !== exp.DType.UNKNOWN) {
          mapType.set("expressions", [exp.DType.VARCHAR.into_expr(), kind]);
          mapType.set("nested", true);
          break;
        }
      }
    }

    this._set_type(expression, mapType);
    return expression;
  }

  // py:1082-1092 `_annotate_extract`.
  _annotate_extract(expression) {
    const part = expression.name;
    if (part === "TIME") {
      this._set_type(expression, exp.DType.TIME);
    } else if (part === "DATE") {
      this._set_type(expression, exp.DType.DATE);
    } else if (BIGINT_EXTRACT_DATE_PARTS.has(part)) {
      this._set_type(expression, exp.DType.BIGINT);
    } else {
      this._set_type(expression, exp.DType.INT);
    }
    return expression;
  }

  // py:1094-1102 `_annotate_within_group`.
  _annotate_within_group(expression) {
    if (expression.this instanceof exp.PercentileDisc) {
      const order = expression.args.expression;
      const orderExpressions = order ? order.expressions : null;
      // deny:operators sqlglot/optimizer/annotate_types.py:1098 — Python
      // `order_expressions[0]`; `order_expressions` is a plain list (the generic
      // `Expr.expressions` getter), so this is plain list indexing, not
      // `Expr.__getitem__`/Bracket-building.
      const sortType = orderExpressions && orderExpressions.length
        ? orderExpressions[0].this.type
        : exp.DType.UNKNOWN;
      this._set_type(expression, sortType);
      return expression;
    }

    return this._annotate_by_args(expression, "this");
  }

  // py:1104-1112 `_annotate_by_array_element`.
  _annotate_by_array_element(expression) {
    const arrayArg = expression.this;
    if (arrayArg.type.isType(exp.DType.ARRAY)) {
      const elementType = seqGet(arrayArg.type.expressions, 0) || exp.DType.UNKNOWN;
      this._set_type(expression, elementType);
    } else {
      this._set_type(expression, exp.DType.UNKNOWN);
    }

    return expression;
  }
}

/**
 * py: sqlglot/optimizer/annotate_types.py:46-84 `annotate_types`.
 *
 * Infers the types of an expression, annotating its AST accordingly.
 *
 * Example:
 *   const schema = { y: { cola: "SMALLINT" } };
 *   const sql = "SELECT x.cola + 2.5 AS cola FROM (SELECT y.cola AS cola FROM y AS y) AS x";
 *   const annotated = annotate_types(parseOne(sql), { schema });
 *   annotated.expressions[0].type.this; // exp.DType.DOUBLE
 *
 * @param {exp.Expr} expression Expr to annotate.
 * @param {{
 *   schema?: *,
 *   expressionMetadata?: Map|null,
 *   coercesTo?: Map|null,
 *   dialect?: *,
 *   overwriteTypes?: boolean,
 * }} [options]
 */
export function annotate_types(expression, options = {}) {
  const {
    schema = null,
    expressionMetadata = null,
    coercesTo = null,
    dialect = null,
    overwriteTypes = true,
  } = options;

  const resolvedSchema = ensureSchema(schema, { dialect });

  return new TypeAnnotator(resolvedSchema, {
    expressionMetadata,
    coercesTo,
    overwriteTypes,
  }).annotate(expression);
}
