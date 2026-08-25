// py: sqlglot/expressions/__init__.py @ 91119bc
import * as classes from "./classes.js";
import { registerExprClasses, registerInitHook } from "./core.js";
import { installQueryMethods } from "./query_methods.js";
import { installFocusedMethods, DType, PropertiesLocation } from "./focused_methods.js";
import { EXPR_META, TRAITS, INIT_HOOKS } from "../_gen/expr_meta.js";
import { ALL_FUNCTION_NAMES, FUNCTION_ALIASES } from "../_gen/function_meta.js";
export * from "./core.js";
export * from "./classes.js";
export { EXPR_META, TRAITS, INIT_HOOKS, DType, PropertiesLocation };
export const EXPR_CLASSES = Object.freeze(Object.fromEntries(Object.entries(EXPR_META).map(([key, meta]) => [key, classes[meta.name]])));
registerExprClasses(Object.fromEntries(Object.values(EXPR_META).flatMap((meta) => [[meta.name, classes[meta.name]], [meta.key, classes[meta.name]]])));
installQueryMethods(classes);
installFocusedMethods();
const UNIT_NAMES = Object.freeze({D:"DAY",H:"HOUR",M:"MINUTE",MS:"MILLISECOND",NS:"NANOSECOND",Q:"QUARTER",S:"SECOND",US:"MICROSECOND",W:"WEEK",Y:"YEAR"});
for (const meta of Object.values(EXPR_META)) if (meta.initOwner) registerInitHook(meta.name, (node, args) => { const unit = node.args.unit; if (!unit || !["Column","Literal","Var"].includes(unit.constructor?.name)) return; const name = String(unit.args.this ?? "").toUpperCase(); const normalized = UNIT_NAMES[name] || name; node.set("unit", meta.initOwner === "DateTrunc" ? new classes.Literal({this: normalized, is_string: true}) : new classes.Var({this: normalized})); });
export const ALL_FUNCTIONS = Object.freeze(ALL_FUNCTION_NAMES.map((name) => classes[name]));
export const FUNCTION_BY_NAME = Object.freeze(Object.fromEntries(Object.entries(FUNCTION_ALIASES).map(([name, className]) => [name, classes[className]])));
