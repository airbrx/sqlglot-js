// Behavioral surface defined by the focused expression modules (array,
// constraints, datatypes, functions, json, properties and temporal).  The
// catalogue is generated, but these few non-declarative class bodies cannot be.
// py: sqlglot/expressions/{array,constraints,datatypes,functions,json,properties,temporal}.py
import * as C from "./classes.js";
import { Expr, convert, maybeCopy, maybeParse, registerAstEnums, dotBuild, COLUMN_PARTS } from "./core.js";
import { PyValueError } from "../_py/errors.js";
import { literalNumberText } from "../_py/num.js";

function getter(Klass, name, get) {
  Object.defineProperty(Klass.prototype, name, { configurable: true, get });
}

// AutoName enums compare by identity in Python.  Frozen records retain that
// property while also carrying the representation fields consumed by toS.
const DTYPE_NAMES = [
  "ARRAY","AGGREGATEFUNCTION","SIMPLEAGGREGATEFUNCTION","BIGDECIMAL","BIGINT","BIGNUM","BIGSERIAL","BINARY","BIT","BLOB","BOOLEAN","BPCHAR","CHAR","CHARACTER_SET","DATE","DATE32","DATEMULTIRANGE","DATERANGE","DATETIME","DATETIME2","DATETIME64","DECIMAL","DECIMAL32","DECIMAL64","DECIMAL128","DECIMAL256","DECFLOAT","DOUBLE","DYNAMIC","ENUM","ENUM8","ENUM16","FILE","FIXEDSTRING","FLOAT","GEOGRAPHY","GEOGRAPHYPOINT","GEOMETRY","POINT","RING","LINESTRING","MULTILINESTRING","POLYGON","MULTIPOLYGON","HLLSKETCH","HSTORE","IMAGE","INET","INT","INT128","INT256","INT4MULTIRANGE","INT4RANGE","INT8MULTIRANGE","INT8RANGE","INTERVAL","IPADDRESS","IPPREFIX","IPV4","IPV6","JSON","JSONB","LIST","LONGBLOB","LONGTEXT","LOWCARDINALITY","MAP","MEDIUMBLOB","MEDIUMINT","MEDIUMTEXT","MONEY","NAME","NCHAR","NESTED","NOTHING","NULL","NUMMULTIRANGE","NUMRANGE","NVARCHAR","OBJECT","RANGE","ROWVERSION","SERIAL","SET","SMALLDATETIME","SMALLINT","SMALLMONEY","SMALLSERIAL","STRUCT","SUPER","TEXT","TINYBLOB","TINYTEXT","TIME","TIMETZ","TIME_NS","TIMESTAMP","TIMESTAMPNTZ","TIMESTAMPLTZ","TIMESTAMPTZ","TIMESTAMP_S","TIMESTAMP_MS","TIMESTAMP_NS","TINYINT","TSMULTIRANGE","TSRANGE","TSTZMULTIRANGE","TSTZRANGE","UBIGINT","UINT","UINT128","UINT256","UMEDIUMINT","UDECIMAL","UDOUBLE","UNION","UNKNOWN","USERDEFINED","USMALLINT","UTINYINT","UUID","VARBINARY","VARCHAR","VARIANT","VECTOR","XML","YEAR","TDIGEST",
];
export const DType = Object.freeze(Object.fromEntries(DTYPE_NAMES.map(name => {
  const value = { __enum__: "DType", name, value: name === "USERDEFINED" ? "USER-DEFINED" : name };
  // AutoName.into_expr.  Keep this on the enum value (rather than a helper on
  // DType) so the JS surface follows `DType.INT.intoExpr(...)`.
  const intoExpr = (kwargs = {}) => new C.DataType({ this: value, ...kwargs });
  // AST dumping spreads enum records, so methods must mirror Python methods:
  // available on the value but absent from its serialized state.
  Object.defineProperties(value, {
    intoExpr: { value: intoExpr },
    into_expr: { value: intoExpr },
  });
  return [name, Object.freeze(value)];
})));
const PROPERTY_LOCATION_NAMES = ["POST_CREATE", "POST_NAME", "POST_SCHEMA", "POST_WITH", "POST_ALIAS", "POST_EXPRESSION", "POST_INDEX", "UNSUPPORTED"];
export const PropertiesLocation = Object.freeze(Object.fromEntries(PROPERTY_LOCATION_NAMES.map(name =>
  [name, Object.freeze({ __enum__: "PropertiesLocation", name, value: name })])));
registerAstEnums({ DType, PropertiesLocation });

function nodeName(x) {
  if (x == null) return "";
  if (typeof x.name === "string") return x.name;
  if (typeof x.args?.this === "string") return x.args.this;
  return nodeName(x.args?.this);
}
function outputName(x) { return typeof x?.outputName === "string" ? x.outputName : nodeName(x); }

export function installFocusedMethods() {
  C.Literal.string = (value) => new C.Literal({ this: String(value), is_string: true });
  C.Literal.number = (value) => {
    const normalized = typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : value;
    const { text, neg } = literalNumberText(normalized);
    const literal = new C.Literal({ this: text, is_string: false });
    return neg ? new C.Neg({ this: literal }) : literal;
  };
  getter(C.Literal, "isNumber", function () { return !this.args.is_string && /^(?:[-+]?\d+(?:\.\d*)?(?:e[-+]?\d+)?|inf|nan|binary_double_nan)$/i.test(String(this.this)); });
  getter(C.Literal, "is_number", function () { return this.isNumber; });
  getter(C.Neg, "isNumber", function () { return !!this.this?.isNumber; });
  getter(C.Neg, "is_number", function () { return this.isNumber; });
  C.DataType.isDataType = true;
  C.DataType.Type = DType;
  const dtypeSet = (...names) => new Set(names.map(name => DType[name]));
  C.DataType.STRUCT_TYPES = dtypeSet("FILE", "NESTED", "OBJECT", "STRUCT", "UNION");
  C.DataType.ARRAY_TYPES = dtypeSet("ARRAY", "LIST");
  C.DataType.NESTED_TYPES = dtypeSet("FILE", "NESTED", "OBJECT", "STRUCT", "UNION", "ARRAY", "LIST", "MAP");
  C.DataType.TEXT_TYPES = dtypeSet("CHAR", "NCHAR", "NVARCHAR", "TEXT", "TINYTEXT", "MEDIUMTEXT", "LONGTEXT", "VARCHAR", "NAME");
  C.DataType.BINARY_TYPES = dtypeSet("BINARY", "VARBINARY", "TINYBLOB", "BLOB", "MEDIUMBLOB", "LONGBLOB");
  C.DataType.SIGNED_INTEGER_TYPES = dtypeSet("BIGINT", "INT", "INT128", "INT256", "MEDIUMINT", "SMALLINT", "TINYINT");
  C.DataType.UNSIGNED_INTEGER_TYPES = dtypeSet("UBIGINT", "UINT", "UINT128", "UINT256", "UMEDIUMINT", "USMALLINT", "UTINYINT");
  C.DataType.INTEGER_TYPES = new Set([...C.DataType.SIGNED_INTEGER_TYPES, ...C.DataType.UNSIGNED_INTEGER_TYPES, DType.BIT]);
  C.DataType.FLOAT_TYPES = dtypeSet("DOUBLE", "FLOAT");
  C.DataType.REAL_TYPES = dtypeSet("DOUBLE", "FLOAT", "BIGDECIMAL", "DECIMAL", "DECIMAL32", "DECIMAL64", "DECIMAL128", "DECIMAL256", "DECFLOAT", "MONEY", "SMALLMONEY", "UDECIMAL", "UDOUBLE");
  C.DataType.NUMERIC_TYPES = new Set([...C.DataType.INTEGER_TYPES, ...C.DataType.REAL_TYPES]);
  C.DataType.TEMPORAL_TYPES = dtypeSet("DATE", "DATE32", "DATETIME", "DATETIME2", "DATETIME64", "SMALLDATETIME", "TIME", "TIMESTAMP", "TIMESTAMPNTZ", "TIMESTAMPLTZ", "TIMESTAMPTZ", "TIMESTAMP_MS", "TIMESTAMP_NS", "TIMESTAMP_S", "TIMETZ");
  C.Cast.isCast = true;
  // These markers are consumed by Func.from_arg_list / error_messages. They
  // are class attributes upstream rather than part of arg_types.
  for (const name of [
    "Count","CumeDist","DenseRank","Grouping","GroupingId","Max","Min","Minhash","PercentRank","Rank",
    "Array","ArrayConstructCompact","List","ArrayConcat","ArrayIntersect","ArraysZip","Explode","MapDelete","MapPick","VarMap","Struct",
    "Coalesce","DecodeCase","Greatest","Least","AIEmbed","AISimilarity","AIGenerate","ReadCSV","ReadParquet",
    "JSONArray","JSONArrayAppend","JSONArrayInsert","JSONExtract","JSONExtractScalar","JSONKeys","JSONRemove","JSONSet",
    "Chr","Concat","Elt","Format","CityHash64","FarmFingerprint","MD5Digest","Date",
  ]) C[name].isVarLenArgs = true;
  C.VarMap.varLenArgKey = "values";
  getter(C.DataTypeParam, "name", function () { return nodeName(this.args.this); });

  // py: core.py Dot.build / Dot.parts.  build() is the constructor for the `fields`
  // form of column(); parts walks the flattened chain and prepends the head Column's
  // catalog/db/table in order.
  C.Dot.build = (expressions) => dotBuild(expressions);
  getter(C.Dot, "parts", function () {
    const [head, ...rest] = [...this.flatten()];
    const tail = rest.reverse();
    for (const key of COLUMN_PARTS) {
      const part = head.args?.[key];
      if (part instanceof Expr) tail.push(part);
    }
    return tail.reverse();
  });

  C.DataType.build = function (dtype, { udt = false, copy = true, ...kwargs } = {}) {
    if (typeof dtype === "string") return this.fromStr(dtype, { udt, ...kwargs });
    if (dtype && dtype.__enum__ === "DType") return new C.DataType({ this: DType[dtype.name] || dtype }).setKwargs(kwargs);
    if (udt && (dtype instanceof C.Identifier || dtype instanceof C.Dot)) return new C.DataType({ this: DType.USERDEFINED, kind: dtype, ...kwargs });
    if (dtype instanceof C.DataType) return maybeCopy(dtype, copy);
    throw new PyValueError(`Invalid data type: ${String(dtype)}. Expected str or DType`);
  };
  // py: datatypes.py:386 from_str.  The string form goes through the parser upstream,
  // and `nested` is set by the parser -- False for a scalar type, True for a nested
  // one.  So DataType.build("INT") carries nested=False while DataType.build(DType.INT)
  // and DType.INT.into_expr() do not, and "UNKNOWN" is short-circuited before parsing
  // and so carries no `nested` either.  Invisible to the AST oracle, which only ever
  // reaches DataType nodes through astLoad.
  C.DataType.fromStr = function (dtype, { udt = false, ...kwargs } = {}) {
    const upper = String(dtype).toUpperCase();
    if (upper === "UNKNOWN") return new C.DataType({ this: DType.UNKNOWN, ...kwargs });
    if (DType[upper]) return new C.DataType({ this: DType[upper], nested: false }).setKwargs(kwargs);
    if (udt) return new C.DataType({ this: DType.USERDEFINED, kind: dtype, ...kwargs });
    throw new TypeError(`Unknown data type: ${dtype}`);
  };
  C.DataType.prototype.isType = function (...dtypes) {
    let options = {};
    if (dtypes.at(-1) && dtypes.at(-1).checkNullable !== undefined) options = dtypes.pop();
    return dtypes.some(dtype => {
      const other = C.DataType.build(dtype, { copy: false, udt: true });
      const structural = other.expressions.length || (options.checkNullable && (this.args.nullable || other.args.nullable)) || this.this === DType.USERDEFINED || other.this === DType.USERDEFINED;
      return structural ? this.equals(other) : this.this === other.this;
    });
  };

  getter(C.Cast, "name", function () { return nodeName(this.this); });
  getter(C.Cast, "to", function () { return this.args.to; });
  getter(C.Cast, "outputName", function () { return this.name; });
  C.Cast.prototype.isType = function (...dtypes) { return this.to.isType(...dtypes); };

  C.Case.prototype.when = function (condition, then, options = {}) {
    const copy = options.copy ?? true, instance = maybeCopy(this, copy);
    return instance.append("ifs", new C.If({ this: maybeParse(condition, { ...options, copy }), true: maybeParse(then, { ...options, copy }) }));
  };
  C.Case.prototype.else_ = function (condition, options = {}) {
    const copy = options.copy ?? true, instance = maybeCopy(this, copy);
    return instance.set("default", maybeParse(condition, { ...options, copy }));
  };

  getter(C.ColumnConstraint, "kind", function () { return this.args.kind; });
  getter(C.Map, "keys", function () { return this.args.keys?.expressions || []; });
  getter(C.Map, "values", function () { return this.args.values?.expressions || []; });
  getter(C.VarMap, "keys", function () { return this.args.keys.expressions; });
  getter(C.VarMap, "values", function () { return this.args.values.expressions; });
  getter(C.Unnest, "selects", function () {
    const columns = [...(this.args.expressions || [])], offset = this.args.offset;
    if (offset) columns.push(offset === true ? new C.Identifier({ this: "offset", quoted: false }) : offset);
    return columns;
  });

  getter(C.JSONExtract, "outputName", function () { return this.expressions.length ? "" : outputName(this.expression); });
  getter(C.JSONExtractScalar, "outputName", function () { return outputName(this.expression); });
  getter(C.TsOrDsAdd, "returnType", function () { return C.DataType.build(this.args.return_type || DType.DATE); });
  getter(C.DateTrunc, "unit", function () { return this.args.unit; });

  const propertyNames = {
    ALGORITHM:C.AlgorithmProperty, AUTO_INCREMENT:C.AutoIncrementProperty, "CHARACTER SET":C.CharacterSetProperty,
    CLUSTERED_BY:C.ClusteredByProperty, COLLATE:C.CollateProperty, COMMENT:C.SchemaCommentProperty,
    CREDENTIALS:C.CredentialsProperty, DEFINER:C.DefinerProperty, DISTKEY:C.DistKeyProperty,
    DISTRIBUTED_BY:C.DistributedByProperty, DISTSTYLE:C.DistStyleProperty, ENGINE:C.EngineProperty,
    "EXECUTE AS":C.ExecuteAsProperty, FORMAT:C.FileFormatProperty, LANGUAGE:C.LanguageProperty,
    LOCATION:C.LocationProperty, LOCK:C.LockProperty, PARTITIONED_BY:C.PartitionedByProperty,
    RETURNS:C.ReturnsProperty, ROW_FORMAT:C.RowFormatProperty, SORTKEY:C.SortKeyProperty,
    ENCODE:C.EncodeProperty, INCLUDE:C.IncludeProperty,
  };
  C.Properties.NAME_TO_PROPERTY = Object.freeze(propertyNames);
  C.Properties.PROPERTY_TO_NAME = new Map(Object.entries(propertyNames).map(([k,v]) => [v,k]));
  C.Properties.Location = PropertiesLocation;
  C.Properties.fromDict = function (properties) {
    return new C.Properties({ expressions: Object.entries(properties).map(([key,value]) => {
      const P = propertyNames[key.toUpperCase()];
      const converted = convert(value);
      return P ? new P({ this: converted }) : new C.Property({ this: new C.Literal({ this: key, is_string: true }), value: converted });
    }) });
  };

  // Scale constants are expression singletons upstream, not plain numbers.
  for (const [name, scale] of Object.entries({SECONDS:0, DECIS:1, CENTIS:2, MILLIS:3, DECIMILLIS:4, CENTIMILLIS:5, MICROS:6, DECIMICROS:7, CENTIMICROS:8, NANOS:9})) {
    C.UnixToTime[name] = C.Literal.number(scale);
  }
}
