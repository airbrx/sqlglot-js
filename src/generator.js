// py: sqlglot/generator.py @ 91119bc
// @seeded by tools/seed_static.py — method stubs and class-table skeletons.
//
// Each stub and each table entry carries its own upstream anchor so that one task
// replaces exactly one line/method and two agents never touch adjacent hunks
// (PORT_PLAN.md §8.1 Rules 2 and 2'). Table ORDER is CI-asserted against a _gen/
// snapshot, because §4.6 establishes that insertion order is observable in output SQL.
//
// ---------------------------------------------------------------------------------
// READ THIS BEFORE PORTING A STUB IN THIS FILE.
//
// STATUS (P4 blocking step). This file is FOUNDATION + SKELETON, not a working
// generator. Stated in the terms R13 asks for, because "seeded" reads as "done":
//
//   * REAL and verified: the dispatch machinery (`_buildDispatch`, `_DISPATCH_CACHE`,
//     `sql()`), the pretty/comment/indent primitives, `unsupported()`, the 126
//     class-level settings, and 8 `*_sql` methods — 6 proof-of-concept from the blocking
//     step, plus `column_sql` and `identifier_sql` (with the helper `column_parts`),
//     which `tools/closure_generator.mjs --curve` measured as the smallest group that
//     opens ANY generate-oracle row: individually all three are worth zero.
//   * SKELETON: the other 424 `*_sql` methods throw `NotPorted`, as do the 30
//     non-`*_sql` methods not listed above. (That second count read "46" from the
//     blocking step until it was actually counted here; the true figure was 31 then and
//     is 30 now. These numbers are the burndown of record, so a wrong one is a defect —
//     `grep -oP '^  \K[\w$]+(?=\s*\(.*throw new NotPorted)' src/generator.js | grep -v
//     _sql$ | sort -u | wc -l` is the check.) `TRANSFORMS` is an EMPTY Map: 133 of its
//     entries are commented-out anchored lines and the remaining 10 sit behind the
//     one `**JSON_PATH_PART_TRANSFORMS` spread line (133 + 10 = upstream's 143).
//     `AFTER_HAVING_MODIFIER_TRANSFORMS` is likewise empty (0 of 5).
//     This is deliberate at this step and is exactly the R14 state that must not be
//     mistaken for wired. `grep -c NotPorted src/generator.js` OVER-counts the method
//     burndown by exactly 3 — `constructor`, `preprocess` (py:981 ENSURE_BOOLS) and
//     `_move_ctes_to_top_level` are ported bodies carrying a GUARDED throw for a branch
//     the base class cannot reach. The predicate that means what it says is "the whole
//     body is one `throw new NotPorted`", which is what `closure_generator.mjs --selftest`
//     asserts the source grep and the loaded module agree on;
//     `TRANSFORMS.size === 0` is the table burndown; both are asserted with their
//     current numbers in test/generator_dispatch.test.mjs, so porting work has to
//     update them on purpose.
//
// FIVE RULES, each of which has already cost this project a defect class elsewhere:
//
//  1. CLASS FIELDS ARE READ THROUGH `this.constructor`, NEVER BARE `this`.
//     Upstream writes `self.PRETTY`, `self.EXCLUDE_COMMENTS`, `self.TRANSFORMS`; a JS
//     `static` field is NOT visible as `this.FIELD` from an instance method — it reads
//     back `undefined` with no error. This silently broke `src/parser.js` until it was
//     swept. Every ClassVar read below goes through `this.constructor.X` so a dialect
//     subclass overriding the field is still honoured.
//
//  2. KEYWORD-ONLY PARAMS AFTER `*args` ARE A TRAILING OPTIONS OBJECT, NEVER
//     POSITIONAL. `func()` and `format_args()` are `(*args, kw=...)` upstream, so they
//     take `{prefix, suffix, normalize}` / `{sep}` as a final object. Passing a bare
//     value positionally would silently make it another ARGUMENT to render — R18's
//     defect class, which cost five wrong `_match_text_seq` call sites in parser.js.
//     `expressions()`, `indent()` and `maybe_comment()` also take an options object:
//     they are ordinary Python defaults, but measured over upstream's own 169/14/7 call
//     sites NOT ONE passes beyond the 2nd parameter positionally, so an options object
//     is both safer and closer to how the code is actually written.
//     The grep that catches a regression: `func\(|format_args\(` followed by a bare
//     boolean/string literal in the options slot.
//
//  3. STRING LENGTH AND INDEXING ARE BY CODE POINT (`cpLen`, `cpAt`), NEVER `.length`
//     / `[i]`. §4.2 requires this in this file specifically. `too_wide()` is the known
//     trap: a `.length` port passes all 15,642 corpus rows and is still wrong (review
//     finding B2 / R4), because the corpus is 0.024% non-ASCII.
//
//  4. ARG KEYS THAT COLLIDE WITH RESERVED WORDS CARRY A TRAILING UNDERSCORE — and this
//     is UPSTREAM's spelling, not a port rename: `expression.args.from_`, `.with_`,
//     `.except_` (verified: `"from"` appears 0 times in upstream generator.py, `"from_"`
//     5 times). Same for `else_ for_ global_ input_ not_ set_`. Writing `args.from`
//     yields `undefined`, not an error.
//
//  5. `TRANSFORMS` BEATS A SAME-NAMED `*_sql` METHOD. See `_buildDispatch` below. It
//     never bites in the base class (measured: 0 of 143 base TRANSFORMS keys shadow a
//     base `*_sql`), so it is only observable once a dialect generator lands — which is
//     precisely why it must be right now rather than discovered later.
// ---------------------------------------------------------------------------------

import { ErrorLevel, NotPorted, UnsupportedError, concatMessages } from "./errors.js";
import { PyValueError, PyKeyError } from "./_py/errors.js";
import { PyDecimal, pyIntFromStrBase } from "./_py/num.js";
import { csv, nameSequence, seqGet } from "./helper.js";
import { logger } from "./logging.js";
import { cpAt, cpLen, cpSlice, pyIsDigit, pyIsSpace, pyLower, pyLstrip, pyStrip, pyRstrip, pyUpper } from "./_py/str.js";
import * as exp from "./expressions/index.js";
import { registerGenerator } from "./expressions/core.js";
import { formatTime } from "./time.js";
import { pyTruthy } from "./_py/truthy.js";
import { ensure_bools, move_ctes_to_top_level } from "./transforms.js";
import { JSON_PATH_PART_TRANSFORMS } from "./jsonpath.js";
import { getAnnotateTypesRef, getDialectHelpersRef, getDialectResolver, getSimplifyRef, TOKEN_TYPE_NAMES, TokenType } from "./tokens.js";
import { kernelSql } from "./generator_kernel.js";

/**
 * `tokens.js`'s `getDialectHelpersRef()` relay (see its own header) carries
 * `dialects/dialect.py`'s module-level `unit_to_str`/`map_date_part`/
 * `concat_to_dpipe_sql`/`WEEK_START_DAY_TO_DOW`/`week_offset_to_dow` — this file
 * cannot import `dialects/dialect.js` directly (R32: that module already imports
 * `Generator` FROM here). Used by `dateadd_sql` (unconditionally), by
 * `extract_sql`/`concat_sql` only on the branch that needs them (so a standalone
 * `generator.js` import never has to populate this relay for any call these two make
 * with their default (false) class settings), and unconditionally by `weekstart_name`
 * (ported independently by both AIR-2276 and AIR-2278; this branch's version won the
 * merge, functionally identical).
 * @returns {{ unit_to_str: Function, map_date_part: Function, concat_to_dpipe_sql: Function, WEEK_START_DAY_TO_DOW: Map, week_offset_to_dow: Function }}
 */
function _getDialectHelpers() {
  const ref = getDialectHelpersRef();
  if (!ref) {
    throw new Error("generator.js: dialect helpers not loaded yet — import dialects/dialect.js first.");
  }
  return ref;
}

/**
 * Same relay shape, for `optimizer/annotate_types.js`'s `annotate_types` (R76) —
 * needed by `convert_concat_args`'s `_wrap_with_coalesce` (py:3697) only on the
 * branch reached when an un-typed arg needs annotating.
 * @returns {{ annotate_types: Function, TypeAnnotator: Function }}
 */
function _getAnnotateTypesModule() {
  const ref = getAnnotateTypesRef();
  if (!ref) {
    throw new Error("generator.js: annotate_types not loaded yet — import optimizer/annotate_types.js first.");
  }
  return ref;
}

/**
 * Same relay shape, for `optimizer/simplify.js`'s `simplify` (py:
 * `apply_index_offset`'s `simplify(expression + offset)`) — needed by
 * `bracket_offset_expressions` only on the branch reached when a literal array index
 * actually needs re-basing between two dialects' `INDEX_OFFSET`s.
 * @returns {Function}
 */
function _getSimplifyFn() {
  const ref = getSimplifyRef();
  if (!ref) {
    throw new Error("generator.js: simplify not loaded yet — import optimizer/simplify.js first.");
  }
  return ref;
}

// py: sqlglot/generator.py:28 `ESCAPED_UNICODE_RE = re.compile(r"\\(\d+)")`
const ESCAPED_UNICODE_RE = /\\(\d+)/g;

/**
 * py: expressions/core.py:2792 `_wrap(expression, kind)`.
 *
 * Module-private upstream and not re-exported by `expressions/index.js`; inlined here
 * (same reasoning `parsers/snowflake.js` already used for its own copy) for
 * `safedivide_sql`'s only caller of it in this file.
 */
function _wrap(expression, kind) {
  return expression instanceof kind ? new exp.Paren({ this: expression }) : expression;
}

/**
 * py: sqlglot/generator.py:65 `AFTER_HAVING_MODIFIER_TRANSFORMS`
 *
 * Module-level, and deliberately kept module-level: the class-level table of the same
 * name at py:671 spreads this one and adds three more keys, so they are two distinct
 * objects upstream and collapsing them would change `Generator`'s own table.
 */
export const AFTER_HAVING_MODIFIER_TRANSFORMS = new Map([
  // py:66-71
  ["windows", (self, e) => pyTruthy(e.args.windows) ? self.seg("WINDOW ") + self.expressions(e, "windows", { flat: true }) : ""],
  ["qualify", (self, e) => self.sql(e, "qualify")],
]);

/**
 * py: sqlglot/generator.py:32 `unsupported_args(*args)` — a Python decorator.
 *
 * Upstream's decorator body is `def _func(generator, expression): ...; return
 * func(generator, expression)` — TWO EXPLICIT positional parameters, always, never an
 * implicit `self`. That is deliberate on upstream's part: it is what lets the same
 * decorator wrap both a class method (`approxquantile_sql`, where Python's bound-call
 * convention passes `self` as that first positional arg for free) and a bare
 * `(generator, expression)`-shaped function used directly as a `TRANSFORMS` value
 * (`arg_max_or_min_no_count`, `dialects/dialect.py`; Snowflake's own `exp.Levenshtein:
 * unsupported_args(...)(rename_func("EDITDISTANCE"))`).
 *
 * JS does not unify those two calling conventions the way Python does: a `TRANSFORMS`
 * value is invoked as a plain 2-arg call (`handler(this, expression)`, `generator.js`'s
 * `sql()`), while a class method is invoked via `this`-binding
 * (`instance.method(expression)`, one explicit arg). Reproducing upstream's single
 * `_func(generator, expression)` shape and calling `func(generator, expression)` — a
 * PLAIN call, matching the TRANSFORMS convention exactly — makes this correct for the
 * `rename_func`/TRANSFORMS-value case. For a class method (`approxquantile_sql` below),
 * the class body routes through a same-shaped standalone `(self, expression)` function
 * instead of wrapping the bound method directly — see that call site's own note, which
 * is the same shape this file already uses for every `TRANSFORMS` lambda.
 *
 * Truthiness of `expression.args[arg_name]` routes through `pyTruthy` (PORT_PLAN.md
 * R37's named defect class: a present-but-empty JS array is truthy, an empty Python
 * list is falsy). Originally plain JS truthiness, documented safe because no call
 * site passed an empty-list-valued arg (`count`, `weight`, `accuracy`, `ins_cost`,
 * `del_cost`, `sub_cost`) — AIR-2286's `generators/singlestore.js` broke that
 * invariant (`unsupported_args("zone", "expressions")` on `exp.Date`, where
 * `expressions` defaults to `[]`, not `None`, when a bare `DATE(x)` carries no extra
 * args), surfacing as a spurious "Argument 'expressions' is not supported" warning on
 * every such call — fixed here, in the base, since every earlier dialect's own args
 * happen to never take this shape either way.
 *
 * @param {...(string|[string,string])} args argument names, or `[name, diagnostic]` pairs
 * @returns {(func: Function) => Function}
 */
export function unsupported_args(...args) {
  const diagnostic_by_arg = new Map();
  for (const arg of args) {
    if (typeof arg === "string") diagnostic_by_arg.set(arg, null);
    else diagnostic_by_arg.set(arg[0], arg[1]);
  }

  return function decorator(func) {
    return function _func(generator, expression) {
      const expression_name = expression.constructor.name;
      const dialect_name = generator.dialect.constructor.name;

      for (const [arg_name, diag0] of diagnostic_by_arg) {
        if (pyTruthy(expression.args[arg_name])) {
          const diagnostic =
            diag0 ||
            `Argument '${arg_name}' is not supported for expression '${expression_name}' when targeting ${dialect_name}.`;
          generator.unsupported(diagnostic);
        }
      }

      return func(generator, expression);
    };
  };
}

/**
 * py: sqlglot/jsonpath.py:238 `ALL_JSON_PATH_PARTS = set(JSON_PATH_PART_TRANSFORMS)`.
 *
 * `sqlglot/jsonpath.py` itself (the tokenizer and recursive-descent `parse()`) is
 * still unported, but this one module-level constant does not need it: it is exactly
 * the ten expression classes tagged `traits: ["JSONPathPart"]` in `_gen/expr_meta.js`
 * (mechanically generated from the real class hierarchy, matching the
 * `JSONPath{Filter,Key,Recursive,Root,Script,Selector,Slice,Subscript,Union,Wildcard}`
 * list already verified against the pin in this file's `TRANSFORMS`/
 * `JSON_PATH_PART_TRANSFORMS` note above). Deriving it from the trait rather than
 * hand-listing the ten classes is what keeps "would not notice an 11th" true — see
 * `SUPPORTED_JSON_PATH_PARTS` below, and `registerDialect`'s py:304-309 pruning
 * (dialects/dialect.js), which imports this same constant.
 */
export const ALL_JSON_PATH_PARTS = new Set(
  Object.values(exp.EXPR_META)
    .filter((meta) => meta.traits.includes("JSONPathPart"))
    .map((meta) => exp.EXPR_CLASSES[meta.key]),
);

/**
 * py: sqlglot/generator.py:76 `_DISPATCH_CACHE`
 *
 * Keyed by the generator CLASS, so every instance of a dialect generator shares one
 * resolved table. A `Map` rather than an object because the key is a class, not a
 * string — and because `WeakMap` would let the table be collected and silently rebuilt,
 * making a builder bug intermittent rather than reproducible.
 */
const _DISPATCH_CACHE = new Map();

/**
 * py: `isinstance(x, TUPLE_OF_CLASSES)`.
 *
 * Upstream passes tuples of classes to `isinstance` in several places
 * (`EXCLUDE_COMMENTS`, `WITH_SEPARATED_COMMENTS`, `UNWRAPPED_INTERVAL_VALUES`,
 * `UNWRAPPED_QUERIES`). This is an `instanceof` walk — genuinely subclass-aware —
 * which is NOT the same relation as `sql()`'s exact-class dispatch. Keeping the two
 * distinct matters: making comments subclass-aware and dispatch exact is upstream's
 * actual behaviour, and conflating them would change output SQL.
 *
 * @param {any} x
 * @param {Iterable<Function>} classes
 * @returns {boolean}
 */
function _isinstance(x, classes) {
  if (x === null || x === undefined) return false;
  for (const C of classes) if (x instanceof C) return true;
  return false;
}

/**
 * Pops a trailing options object off a var-args list.
 *
 * Rule 2's mechanism: `func(name, *args, prefix="(", ...)` is keyword-only after
 * var-args, so the options arrive last. Kept local rather than imported because this
 * file's callers pass rest-arrays, not `arguments`.
 *
 * An `Expr` is never a plain object, so it cannot be mistaken for options — but
 * "not an Expr" is NOT the same as "not a plain object", and the obvious
 * `constructor === Object` test alone is wrong here: `exp.DType.VARCHAR` and the
 * `Properties.Location` members are plain frozen objects too, so a genuine trailing
 * enum ARGUMENT would be silently swallowed as options and dropped from the output.
 * No upstream call site passes a bare `DType` as the last positional today (checked),
 * and `function_fallback_sql` cannot forward one because a `DataType` is not a `Func` —
 * but R18 records that "a correctness argument that rests on 'nothing reaches this yet'
 * expires silently the moment something does", and 426 stubs are still to be written
 * against this signature. Hence the explicit `__enum__` exclusion.
 *
 * NOTE for the foundation owner: `expressions/core.js:541 trailingOptions` has the same
 * gap and is shared P2 code, so it is reported rather than changed here (§8.1 Rule 3).
 *
 * @param {any[]} args mutated in place — the options object is REMOVED
 * @returns {object}
 */
function _trailingOptions(args) {
  const last = args.length ? args.at(-1) : undefined;
  const isOptions =
    last != null && last.constructor === Object && last.__enum__ === undefined;
  return isOptions ? args.pop() : {};
}

/**
 * py: expressions/query.py:2165 `UNWRAPPED_QUERIES = (Select, SetOperation)`.
 *
 * A function, not a constant, for the same reason `optimizer/scope.js:22` makes it one:
 * evaluating it at module scope would capture the classes before `expressions/index.js`
 * has finished installing them.
 * @returns {Function[]}
 */
const UNWRAPPED_QUERIES = () => [exp.Select, exp.SetOperation];

/**
 * py: generator.py:897 `Dialect.get_or_raise(dialect)`.
 *
 * DEVIATION (CONTRACTS.md §8), identical to `Tokenizer.__init__` and
 * `Parser._resolveDialect`: `dialects/dialect.js`'s registry is P5. An already-resolved
 * settings object is accepted, `null` yields the base `Dialect` defaults, and a dialect
 * NAME throws rather than silently generating as the default dialect — which would make
 * every per-dialect generate-oracle row vacuously green.
 */
function _resolveDialect(dialect) {
  if (dialect === null || dialect === undefined) return BASE_DIALECT_GENERATOR_SETTINGS;
  if (typeof dialect === "string") {
    throw new NotPorted(
      `Dialect.get_or_raise(${JSON.stringify(dialect)}) — dialects/dialect.js is P5`,
      "sqlglot/generator.py:897",
    );
  }
  return dialect;
}

/**
 * The base `Dialect`'s generator-visible settings, read out of CPython at the pin
 * rather than assumed:
 *
 *   python3 -c "from sqlglot.dialects.dialect import Dialect; d=Dialect(); \
 *     print(d.NORMALIZE_FUNCTIONS, d.QUOTE_END, d.BYTE_END, d.IDENTIFIER_START, \
 *           d.IDENTIFIER_END, d.PRESERVE_ORIGINAL_NAMES, d.tokenizer_class.STRING_ESCAPES)"
 *
 * Only the fields the ported machinery actually reads are listed. A field a stub needs
 * later must be ADDED here and re-read from CPython, never guessed — `generator_kernel.js`
 * sets the same precedent, and R18(d) records a row that is wrong precisely because a
 * stand-in dialect silently supplied no value.
 */
export const BASE_DIALECT_GENERATOR_SETTINGS = Object.freeze({
  NORMALIZE_FUNCTIONS: "upper",
  QUOTE_START: "'",
  QUOTE_END: "'",
  BYTE_END: null,
  IDENTIFIER_START: '"',
  IDENTIFIER_END: '"',
  PRESERVE_ORIGINAL_NAMES: false,
  STRINGS_SUPPORT_ESCAPED_SEQUENCES: false,
  BYTE_STRINGS_SUPPORT_ESCAPED_SEQUENCES: false,
  // A `Map`, never a plain object: `ESCAPED_SEQUENCES.get(ch)` is keyed by an arbitrary
  // character, and on a plain object `["constructor"]` would return a function.
  // CONTRACTS.md §8 records the same rule for every tokenizer dict.
  ESCAPED_SEQUENCES: new Map(),
  tokenizer_class: Object.freeze({ STRING_ESCAPES: Object.freeze(["'"]) }),

  // Added for `identifier_sql`/`column_parts`/`column_sql`, re-read from CPython by the
  // command above rather than guessed — which is what this object's docstring requires
  // and what R18(d) is about. All three are False at the base `Dialect`, so leaving them
  // out would have read `undefined` and taken the SAME branch: correct by accident on the
  // base and silently wrong for the first dialect that flips one. That is exactly R20's
  // "24 of the base defaults are falsy, so two thirds behave correctly by accident".
  IDENTIFIERS_CAN_START_WITH_DIGIT: false,
  SUPPORTS_COLUMN_JOIN_MARKS: false,
  PROJECTION_ALIASES_SHADOW_SOURCE_NAMES: false,

  // Added for `table_sql`/`subquery_sql`/`tablealias_sql`/`ordered_sql`/`dpipe_sql`
  // (P4 keystone-group step), same command as above:
  //
  //   python3 -c "from sqlglot.dialects.dialect import Dialect; d=Dialect(); \
  //     print(d.ALIAS_POST_TABLESAMPLE, d.ALIAS_POST_VERSION, d.NULL_ORDERING, \
  //           d.STRICT_STRING_CONCAT, d.UNNEST_COLUMN_ONLY)"
  //
  // -> False True nulls_are_small False False
  ALIAS_POST_TABLESAMPLE: false,
  ALIAS_POST_VERSION: true,
  NULL_ORDERING: "nulls_are_small",
  STRICT_STRING_CONCAT: false,
  UNNEST_COLUMN_ONLY: false,

  // Added for `bracket_offset_expressions`/`bracket_sql` (Databricks-chain generator
  // step, PORT_PLAN.md). `python3 -c "from sqlglot.dialects.dialect import Dialect; \
  // print(Dialect().INDEX_OFFSET)"` -> 0.
  INDEX_OFFSET: 0,

  /**
   * py: `Dialect.can_quote` (dialects/dialect.py:1125).
   *
   * The first METHOD any generator path has needed off `self.dialect`, and this object
   * cannot host one honestly: `can_quote` is real behaviour — `case_sensitive` over the
   * dialect's normalization strategy, plus `SAFE_IDENTIFIER_RE` — and a second copy here
   * would be a stand-in that DIVERGES from the thing it stands in for, which is the
   * R18(d) failure with extra steps. So it announces instead.
   *
   * Not solved by importing `dialects/dialect.js` here either: that file is architected
   * NOT to import this one (it reaches the generator through `registerGenerator`), and
   * `new Generator().dialect === BASE_DIALECT_GENERATOR_SETTINGS` is an asserted contract
   * (test/generator_dispatch.test.mjs:163). Wiring `Dialect.generator_class` is the
   * documented P5 line that closes this properly; until then every real path passes a
   * resolved `Dialect` and only a bare `new Generator()` reaches this throw.
   */
  can_quote() {
    throw new NotPorted(
      "BASE_DIALECT_GENERATOR_SETTINGS.can_quote — the stand-in cannot host Dialect " +
        "METHODS; pass a resolved Dialect (Dialect.get_or_raise(...))",
      "sqlglot/dialects/dialect.py:1125",
    );
  },
});

/**
 * py: sqlglot/generator.py:79 `_build_dispatch(cls)`
 *
 * Upstream:
 *
 *     dispatch = dict(cls.TRANSFORMS)              # seeded first, so TRANSFORMS wins
 *     for attr_name in dir(cls):                   # dir() is SORTED, and spans the MRO
 *         if not attr_name.endswith("_sql") or attr_name.startswith("_"): continue
 *         expr_cls = exp.EXPR_CLASSES.get(attr_name[:-4])
 *         if expr_cls and expr_cls not in dispatch:
 *             dispatch[expr_cls] = getattr(cls, attr_name)
 *
 * Four properties this reproduces, each load-bearing:
 *
 *   * TRANSFORMS SEEDS THE TABLE, and the `not in dispatch` guard means a `*_sql`
 *     method can never displace a TRANSFORMS entry for the same class. That is the
 *     whole precedence rule.
 *   * `dir(cls)` walks the full MRO and returns names SORTED. The sort is only
 *     observable when two distinct `*_sql` names resolve to the SAME expression class,
 *     in which case the alphabetically-first wins. Measured at the pin: that never
 *     happens in base `Generator`. Reproduced anyway — a dialect is free to create the
 *     collision, and this is the kind of "correct because nothing reaches it yet"
 *     argument R18 records as expiring silently.
 *   * `getattr(cls, name)` resolves through the MRO, so a subclass override wins over
 *     the base method of the same name. The JS prototype chain gives this directly.
 *   * A `*_sql` name whose stripped key is NOT an expression class is skipped, which is
 *     what keeps helpers like `function_fallback_sql` and `add_column_sql` out of the
 *     table. Measured: 7 such helpers, and 424 - 7 = 417 = the snapshot's `from_method`.
 *
 * JS HAS NO METACLASS HOOK, and needs none here: upstream does not build the table at
 * class-creation time either — it builds it lazily in `__init__` and memoises it in
 * `_DISPATCH_CACHE`. So this is a plain function called from the constructor, the same
 * shape as `initTokenizerSubclass(cls)` (CONTRACTS.md §8) but without even needing an
 * explicit registration call.
 *
 * @param {typeof Generator} cls
 * @returns {Map<Function, string|Function>} expression class -> handler
 */
export function _buildDispatch(cls) {
  /** @type {Map<Function, string|Function>} */
  const dispatch = new Map(cls.TRANSFORMS);

  // py: `dir(cls)` — every attribute name across the MRO, sorted. Walking the prototype
  // chain collects the same set; `Object.getOwnPropertyNames` on each link is the
  // equivalent of each class's `__dict__`, and the explicit sort supplies `dir()`'s
  // ordering, which JS property order does not otherwise guarantee.
  const names = new Set();
  for (let proto = cls.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) names.add(name);
  }

  for (const attr_name of [...names].sort()) {
    if (!attr_name.endsWith("_sql") || attr_name.startsWith("_")) continue;

    const expr_key = attr_name.slice(0, -4);
    const expr_cls = exp.EXPR_CLASSES[expr_key];

    if (expr_cls && !dispatch.has(expr_cls)) {
      // Store the NAME, not the resolved function. `getattr(cls, name)` is an unbound
      // function that upstream then calls as `handler(self, expression)`; looking the
      // name up on the instance at call time is the same resolution and keeps the
      // cached table comparable against the `_gen/dispatch` snapshot, which also
      // records names.
      dispatch.set(expr_cls, attr_name);
    }
  }

  return dispatch;
}

export class Generator {
  /** py: sqlglot/generator.py:136 */
  static TRANSFORMS = new Map([
    // py:137  SPREAD `**JSON_PATH_PART_TRANSFORMS` — TEN entries, not one:
    //         JSONPath{Filter,Key,Recursive,Root,Script,Selector,Slice,Subscript,Union,
    //         Wildcard} (jsonpath.py:219, verified against the pin). 133 explicit
    //         entries below + these 10 = the 143 that `Generator.TRANSFORMS` resolves
    //         to upstream. Filled from `src/jsonpath.js`'s own table, never by hand.
    ...JSON_PATH_PART_TRANSFORMS,
    // py:138 — ported alongside `generators/postgres.js` (PORT_PLAN.md P4): reached by
    // corpus rows like `NUMRANGE(...) -|- NUMRANGE(...)`, which previously threw
    // "Unsupported expression type Adjacent" (no dispatch entry at all).
    [exp.Adjacent, (self, e) => self.binary(e, "-|-")],
    [exp.AllowedValuesProperty, (self, e) => `ALLOWED_VALUES ${self.expressions(e, null, { flat: true })}`], // py:139
    [exp.AnalyzeColumns, (self, e) => self.sql(e, "this")], // py:142
    [exp.AnalyzeWith, (self, e) => self.expressions(e, null, { prefix: "WITH ", sep: " " })], // py:143
    // py:144-146 — ported alongside `generators/postgres.js` (PORT_PLAN.md P4), whose
    // `TRANSFORMS` inherits these three straight from the base map (`{**Generator.
    // TRANSFORMS, ...}`, no Postgres-specific override) and is the first dialect
    // generator in this port to reach any of them, per real-corpus mismatches
    // (`ARRAY_CONTAINS_ALL(a, b)`/`ARRAY_OVERLAPS(...)` function-fallback rendering
    // where CPython emits the bare infix operator).
    [exp.ArrayContainedBy, (self, e) => self.binary(e, "<@")],
    [exp.ArrayContainsAll, (self, e) => self.binary(e, "@>")],
    [exp.ArrayOverlaps, (self, e) => self.binary(e, "&&")],
    [exp.AssumeColumnConstraint, (self, e) => `ASSUME (${self.sql(e, "this")})`], // py:147
    [exp.AutoRefreshProperty, (self, e) => `AUTO REFRESH ${self.sql(e, "this")}`], // py:148
    [exp.BackupProperty, (self, e) => `BACKUP ${self.sql(e, "this")}`], // py:149
    [exp.CaseSpecificColumnConstraint, (_, e) => `${pyTruthy(e.args.not_) ? "NOT " : ""}CASESPECIFIC`], // py:150
    [exp.CalledOnNullInputProperty, () => "CALLED ON NULL INPUT"], // py:153
    // py:154 — re-wired by AIR-2279 (10.6 generator stubs cluster D2), which ported
    // `ceil_floor` for real. The 6 ratchet-pass atoms AIR-2284's own note names
    // (`FLOOR(x)`, `CEIL(3.14, 1)`, ...) do not regress: with no `to` clause,
    // `ceil_floor` itself falls through to the same `function_fallback_sql` call the
    // accidental class-name fallback was already making, so plain `CEIL`/`FLOOR` renders
    // byte-identical; the `CEIL(x TO y)`/`FLOOR(x TO y)` form `ceil_floor` also now
    // handles was unreachable through the old fallback at all.
    [exp.Ceil, (self, e) => self.ceil_floor(e)],
    [exp.CharacterSetColumnConstraint, (self, e) => `CHARACTER SET ${self.sql(e, "this")}`], // py:155
    [exp.CharacterSetProperty, (self, e) => `${e.args.default ? "DEFAULT " : ""}CHARACTER SET=${self.sql(e, "this")}`], // py:156
    [exp.ClusteredColumnConstraint, (self, e) => `CLUSTERED (${self.expressions(e, "this", { indent: false })})`], // py:159
    [exp.CollateColumnConstraint, (self, e) => `COLLATE ${self.sql(e, "this")}`], // py:162
    [exp.CommentColumnConstraint, (self, e) => `COMMENT ${self.sql(e, "this")}`], // py:163
    [exp.ConnectByRoot, (self, e) => `CONNECT_BY_ROOT ${self.sql(e, "this")}`], // py:164
    [exp.ConvertToCharset, (self, e) => self.func("CONVERT", e.this, e.args.dest, e.args.source)], // py:165
    [exp.CopyGrantsProperty, () => "COPY GRANTS"], // py:168
    [exp.CredentialsProperty, (self, e) => `CREDENTIALS=(${self.expressions(e, "expressions", { sep: " " })})`], // py:169
    [exp.CurrentCatalog, () => "CURRENT_CATALOG"], // py:172
    [exp.SessionUser, () => "SESSION_USER"], // py:173
    // exp.CurrentRole deliberately has NO entry here. tokens.js's CURRENT_ROLE keyword
    // (airbrx-gateway PR #228) makes BOTH `CURRENT_ROLE` and `CURRENT_ROLE()` parse to
    // the same exp.CurrentRole node, with no stored signal distinguishing which form the
    // source used -- upstream CPython never has this ambiguity, since it never tokenizes
    // "CURRENT_ROLE" as a keyword at all (bare -> Column, parens -> Func via the generic
    // by-name path). Either a bare-rendering or a parens-rendering TRANSFORMS entry here
    // fixes one corpus row's round trip while breaking the other's -- a net-zero swap,
    // not a fix -- so this is left on the generic Func fallback (parens), matching what
    // every OTHER un-mapped Func already does and what this class did before AIR-2284
    // looked at it.
    [exp.DateFormatColumnConstraint, (self, e) => `FORMAT ${self.sql(e, "this")}`], // py:174
    [exp.DefaultColumnConstraint, (self, e) => `DEFAULT ${self.sql(e, "this")}`], // py:175
    [exp.ApiProperty, () => "API"], // py:176
    [exp.ApplicationProperty, () => "APPLICATION"], // py:177
    [exp.CatalogProperty, () => "CATALOG"], // py:178
    [exp.ComputeProperty, () => "COMPUTE"], // py:179
    [exp.DatabaseProperty, () => "DATABASE"], // py:180
    [exp.DynamicProperty, () => "DYNAMIC"], // py:181
    [exp.EmptyProperty, () => "EMPTY"], // py:182
    [exp.EncodeColumnConstraint, (self, e) => `ENCODE ${self.sql(e, "this")}`], // py:183
    [exp.EndStatement, () => "END"], // py:184
    [exp.EnviromentProperty, (self, e) => `ENVIRONMENT (${self.expressions(e, null, { flat: true })})`], // py:185
    [exp.HandlerProperty, (self, e) => `HANDLER ${self.sql(e, "this")}`], // py:186
    [exp.ParameterStyleProperty, (self, e) => `PARAMETER STYLE ${self.sql(e, "this")}`], // py:187
    [exp.EphemeralColumnConstraint, (self, e) => `EPHEMERAL${e.this ? " " + self.sql(e, "this") : ""}`], // py:188
    [exp.ExcludeColumnConstraint, (self, e) => `EXCLUDE ${pyLstrip(self.sql(e, "this"))}`], // py:191
    [exp.ExecuteAsProperty, (self, e) => self.naked_property(e)], // py:192
    // py:193 — ported alongside `generators/postgres.js` (PORT_PLAN.md P4), same
    // `set_operations` wiring as `exp.Intersect`/`exp.Union` below.
    [exp.Except, (self, e) => self.set_operations(e)],
    [exp.ExternalProperty, () => "EXTERNAL"], // py:194
    // py:195 — re-wired, same reason as `exp.Ceil` above (py:154).
    [exp.Floor, (self, e) => self.ceil_floor(e)],
    [exp.Get, (self, e) => self.get_put_sql(e)], // py:196
    [exp.GlobalProperty, () => "GLOBAL"], // py:197
    [exp.HeapProperty, () => "HEAP"], // py:198
    [exp.HybridProperty, () => "HYBRID"], // py:199
    [exp.IcebergProperty, () => "ICEBERG"], // py:200
    [exp.InheritsProperty, (self, e) => `INHERITS (${self.expressions(e, null, { flat: true })})`], // py:201
    [exp.InlineLengthColumnConstraint, (self, e) => `INLINE LENGTH ${self.sql(e, "this")}`], // py:202
    [exp.InputModelProperty, (self, e) => `INPUT${self.sql(e, "this")}`], // py:203
    // py:204 — ported alongside `generators/postgres.js` (PORT_PLAN.md P4), same
    // `set_operations` wiring as `exp.Except`/`exp.Union`.
    [exp.Intersect, (self, e) => self.set_operations(e)],
    [exp.IntervalSpan, (self, e) => `${self.sql(e, "this")} TO ${self.sql(e, "expression")}`], // py:205
    [exp.Int64, (self, e) => self.sql(exp.cast(e.this, exp.DType.BIGINT))], // py:206
    // py:207 — ported alongside `generators/postgres.js` (PORT_PLAN.md P4), same
    // reason as `JSONBContainsTopKey` below: a real corpus mismatch
    // (`J_S_O_N_B_CONTAINS_ANY_TOP_KEYS(...)` fallback vs CPython's `?|`).
    [exp.JSONBContainsAnyTopKeys, (self, e) => self.binary(e, "?|")],
    // py:208 — ported alongside its two siblings immediately above/below (same `?`-family
    // operator shape), not itself a measured corpus mismatch.
    [exp.JSONBContainsAllTopKeys, (self, e) => self.binary(e, "?&")],
    // py:209 — ported alongside `generators/postgres.js` (PORT_PLAN.md P4), same
    // reason as `ArrayContainedBy`/`ArrayContainsAll`/`ArrayOverlaps` above: inherited
    // as-is into `PostgresGenerator.TRANSFORMS`, and its function-fallback rendering
    // (`J_S_O_N_B_CONTAINS_TOP_KEY(...)`, the class-name-to-SNAKE_CASE fallback
    // mis-splitting the `JSONB` run) was a real corpus mismatch against CPython's `?`.
    [exp.JSONBContainsTopKey, (self, e) => self.binary(e, "?")],
    // py:210 — ported alongside `generators/postgres.js` (PORT_PLAN.md P4): a real
    // corpus mismatch (`J_S_O_N_B_DELETE_AT_PATH(...)` fallback vs CPython's `#-`).
    [exp.JSONBDeleteAtPath, (self, e) => self.binary(e, "#-")],
    // py:211 — ported alongside `generators/postgres.js` (PORT_PLAN.md P4): a real
    // corpus mismatch (`J_S_O_N_B_PATH_EXISTS(...)` fallback vs CPython's `@?`).
    [exp.JSONBPathExists, (self, e) => self.binary(e, "@?")],
    // py:212/213 — without these, the base Func fallback derives the SQL name from the
    // class name via a per-capital-letter split (the same "J_S_O_N_B_..." shape as the
    // two Postgres entries just above), producing "J_S_O_N_OBJECT(...)" instead of
    // "JSON_OBJECT(...)"; AIR-2280 wired `_parse_json_object` into FUNCTION_PARSERS,
    // which is what first let a real corpus row construct one of these nodes.
    [exp.JSONObject, (self, e) => self._jsonobject_sql(e)],
    [exp.JSONObjectAgg, (self, e) => self._jsonobject_sql(e)],
    [exp.LanguageProperty, (self, e) => self.naked_property(e)], // py:214
    [exp.LocationProperty, (self, e) => self.naked_property(e)], // py:215
    [exp.LogProperty, (_, e) => `${e.args.no ? "NO " : ""}LOG`], // py:216
    [exp.MaskingProperty, () => "MASKING"], // py:217
    [exp.MaterializedProperty, () => "MATERIALIZED"], // py:218
    [exp.NetFunc, (self, e) => `NET.${self.sql(e, "this")}`], // py:219
    [exp.NetworkProperty, () => "NETWORK"], // py:220
    [exp.NonClusteredColumnConstraint, (self, e) => `NONCLUSTERED (${self.expressions(e, "this", { indent: false })})`], // py:221
    [exp.NoPrimaryIndexProperty, () => "NO PRIMARY INDEX"], // py:224
    [exp.NotForReplicationColumnConstraint, () => "NOT FOR REPLICATION"], // py:225
    [exp.OnCommitProperty, (_, e) => `ON COMMIT ${e.args.delete ? "DELETE" : "PRESERVE"} ROWS`], // py:226
    [exp.OnProperty, (self, e) => `ON ${self.sql(e, "this")}`], // py:229
    [exp.OnUpdateColumnConstraint, (self, e) => `ON UPDATE ${self.sql(e, "this")}`], // py:230
    // py:231 — ported alongside `generators/postgres.js` (PORT_PLAN.md P4): reached by
    // `pg_catalog`-style custom-operator corpus rows, which previously threw
    // "Unsupported expression type Operator". `self.binary`'s own `node.args.operator`
    // branch (already ported) is what actually renders `OPERATOR(...)` — the empty
    // string here is upstream's own comment: "The operator is produced in `binary`".
    [exp.Operator, (self, e) => self.binary(e, "")],
    [exp.OutputModelProperty, (self, e) => `OUTPUT${self.sql(e, "this")}`], // py:232
    [exp.ExtendsLeft, (self, e) => self.binary(e, "&<")], // py:233
    [exp.ExtendsRight, (self, e) => self.binary(e, "&>")], // py:234
    [exp.PathColumnConstraint, (self, e) => `PATH ${self.sql(e, "this")}`], // py:235
    [exp.PartitionedByBucket, (self, e) => self.func("BUCKET", e.this, e.expression)], // py:236
    [exp.PartitionByTruncate, (self, e) => self.func("TRUNCATE", e.this, e.expression)], // py:237
    [exp.PivotAny, (self, e) => `ANY${self.sql(e, "this")}`], // py:238
    [exp.PositionalColumn, (self, e) => `#${self.sql(e, "this")}`], // py:239
    [exp.ProjectionPolicyColumnConstraint, (self, e) => `PROJECTION POLICY ${self.sql(e, "this")}`], // py:240
    [exp.InvisibleColumnConstraint, () => "INVISIBLE"], // py:243
    [exp.ZeroFillColumnConstraint, () => "ZEROFILL"], // py:244
    [exp.Put, (self, e) => self.get_put_sql(e)], // py:245
    [exp.RemoteWithConnectionModelProperty, (self, e) => `REMOTE WITH CONNECTION ${self.sql(e, "this")}`], // py:246
    [exp.ReturnsProperty, (self, e) => (e.args.null ? "RETURNS NULL ON NULL INPUT" : self.naked_property(e))], // py:249
    [exp.RowAccessProperty, () => "ROW ACCESS"], // py:252
    [exp.SafeFunc, (self, e) => `SAFE.${self.sql(e, "this")}`], // py:253
    [exp.SampleProperty, (self, e) => `SAMPLE BY ${self.sql(e, "this")}`], // py:254
    [exp.SecureProperty, () => "SECURE"], // py:255
    [exp.SecurityIntegrationProperty, () => "SECURITY"], // py:256
    [exp.SetConfigProperty, (self, e) => self.sql(e, "this")], // py:257
    [exp.SetProperty, (_, e) => `${e.args.multi ? "MULTI" : ""}SET`], // py:258
    [exp.SettingsProperty, (self, e) => `SETTINGS${self.seg("")}${self.expressions(e)}`], // py:259
    [exp.SharingProperty, (self, e) => `SHARING=${self.sql(e, "this")}`], // py:260
    [exp.SqlReadWriteProperty, (_, e) => e.name], // py:261
    [exp.SqlSecurityProperty, (self, e) => `SQL SECURITY ${self.sql(e, "this")}`], // py:262
    [exp.StabilityProperty, (_, e) => e.name], // py:263
    [exp.Stream, (self, e) => `STREAM ${self.sql(e, "this")}`], // py:264
    [exp.StreamingTableProperty, () => "STREAMING"], // py:265
    [exp.StrictProperty, () => "STRICT"], // py:266
    [exp.SwapTable, (self, e) => `SWAP WITH ${self.sql(e, "this")}`], // py:267
    [exp.TableColumn, (self, e) => self.sql(e.this)], // py:268
    [exp.Tags, (self, e) => `TAG (${self.expressions(e, null, { flat: true })})`], // py:269
    [exp.TemporaryProperty, () => "TEMPORARY"], // py:270
    [exp.TitleColumnConstraint, (self, e) => `TITLE ${self.sql(e, "this")}`], // py:271
    [exp.ToMap, (self, e) => `MAP ${self.sql(e, "this")}`], // py:272
    [exp.ToTableProperty, (self, e) => `TO ${self.sql(e.this)}`], // py:273
    [exp.TransformModelProperty, (self, e) => self.func("TRANSFORM", ...e.expressions)], // py:274
    [exp.TransientProperty, () => "TRANSIENT"], // py:275
    [exp.VirtualProperty, () => "VIRTUAL"], // py:276
    [exp.TriggerExecute, (self, e) => `EXECUTE FUNCTION ${self.sql(e, "this")}`], // py:277
    // py:278 — ported alongside `generators/postgres.js` (PORT_PLAN.md P4): a plain
    // `WITH RECURSIVE ... UNION ...` corpus row reached `set_operations`/
    // `set_operation` above, both real bodies now rather than `NotPorted` stubs.
    [exp.Union, (self, e) => self.set_operations(e)],
    [exp.UnloggedProperty, () => "UNLOGGED"], // py:279
    [exp.UsingTemplateProperty, (self, e) => `USING TEMPLATE ${self.sql(e, "this")}`], // py:280
    [exp.UsingData, (self, e) => `USING DATA ${self.sql(e, "this")}`], // py:281
    [exp.UppercaseColumnConstraint, () => "UPPERCASE"], // py:282
    [exp.UtcDate, (self) => self.sql(new exp.CurrentDate({ this: exp.Literal.string("UTC") }))], // py:283
    [exp.UtcTime, (self) => self.sql(new exp.CurrentTime({ this: exp.Literal.string("UTC") }))], // py:284
    [exp.UtcTimestamp, (self) => self.sql(new exp.CurrentTimestamp({ this: exp.Literal.string("UTC") }))], // py:285
    // py:288 — ported alongside `generators/postgres.js` (PORT_PLAN.md P4): reached by
    // corpus rows like `MLEAST(VARIADIC ...)`, which previously threw "Unsupported
    // expression type Variadic" (no dispatch entry at all, not even a wrong string).
    [exp.Variadic, (self, e) => `VARIADIC ${self.sql(e, "this")}`],
    [exp.VarMap, (self, e) => self.func("MAP", e.args.keys, e.args.values)], // py:289
    [exp.ViewAttributeProperty, (self, e) => `WITH ${self.sql(e, "this")}`], // py:290
    [exp.VolatileProperty, () => "VOLATILE"], // py:291
    [exp.WithJournalTableProperty, (self, e) => `WITH JOURNAL TABLE=${self.sql(e, "this")}`], // py:292
    [exp.WithProcedureOptions, (self, e) => `WITH ${self.expressions(e, null, { flat: true })}`], // py:293
    [exp.WithSchemaBindingProperty, (self, e) => `WITH SCHEMA ${self.sql(e, "this")}`], // py:294
    [exp.WithOperator, (self, e) => `${self.sql(e, "this")} WITH ${self.sql(e, "op")}`], // py:295
    [exp.ForceProperty, () => "FORCE"], // py:296
  ]);

  /** py: sqlglot/generator.py:302 */
  static NULL_ORDERING_SUPPORTED = true;

  /** py: sqlglot/generator.py:305 */
  static WINDOW_FUNCS_WITH_NULL_ORDERING = [
  ];

  /** py: sqlglot/generator.py:309 */
  static IGNORE_NULLS_IN_FUNC = false;

  /** py: sqlglot/generator.py:313 */
  static IGNORE_NULLS_BEFORE_ORDER = true;

  /** py: sqlglot/generator.py:316 */
  static LOCKING_READS_SUPPORTED = false;

  /** py: sqlglot/generator.py:319 */
  static EXCEPT_INTERSECT_SUPPORT_ALL_CLAUSE = true;

  /** py: sqlglot/generator.py:322 */
  static WRAP_DERIVED_VALUES = true;

  /** py: sqlglot/generator.py:325 */
  static CREATE_FUNCTION_RETURN_AS = true;

  /** py: sqlglot/generator.py:328 */
  static MATCHED_BY_SOURCE = true;

  /** py: sqlglot/generator.py:331 */
  static SUPPORTS_MERGE_WHERE = false;

  /** py: sqlglot/generator.py:334 */
  static SINGLE_STRING_INTERVAL = false;

  /** py: sqlglot/generator.py:337 */
  static INTERVAL_ALLOWS_PLURAL_FORM = true;

  /** py: sqlglot/generator.py:341 */
  static AUTO_REFRESH_BARE_INTERVALS = false;

  /** py: sqlglot/generator.py:344 */
  static LIMIT_FETCH = "ALL";

  /** py: sqlglot/generator.py:347 */
  static LIMIT_ONLY_LITERALS = false;

  /** py: sqlglot/generator.py:350 */
  static RENAME_TABLE_WITH_DB = true;

  /** py: sqlglot/generator.py:353 */
  static GROUPINGS_SEP = ",";

  /** py: sqlglot/generator.py:356 */
  static INDEX_ON = "ON";

  /** py: sqlglot/generator.py:359 */
  static INOUT_SEPARATOR = " ";

  /** py: sqlglot/generator.py:362 */
  static JOIN_HINTS = true;

  /** py: sqlglot/generator.py:365 */
  static DIRECTED_JOINS = false;

  /** py: sqlglot/generator.py:368 */
  static TABLE_HINTS = true;

  /** py: sqlglot/generator.py:371 */
  static QUERY_HINTS = true;

  /** py: sqlglot/generator.py:374 */
  static QUERY_HINT_SEP = ", ";

  /** py: sqlglot/generator.py:377 */
  static IS_BOOL_ALLOWED = true;

  /** py: sqlglot/generator.py:380 */
  static DUPLICATE_KEY_UPDATE_WITH_SET = true;

  /** py: sqlglot/generator.py:383 */
  static LIMIT_IS_TOP = false;

  /** py: sqlglot/generator.py:386 */
  static RETURNING_END = true;

  /** py: sqlglot/generator.py:389 */
  static EXTRACT_ALLOWS_QUOTES = true;

  /** py: sqlglot/generator.py:392 */
  static TZ_TO_WITH_TIME_ZONE = false;

  /** py: sqlglot/generator.py:395 */
  static NVL2_SUPPORTED = true;

  /** py: sqlglot/generator.py:398 */
  static SELECT_KINDS = [
    /* py:398 */ "STRUCT",
    /* py:398 */ "VALUE",
  ];

  /** py: sqlglot/generator.py:403 */
  static VALUES_AS_TABLE = true;

  /** py: sqlglot/generator.py:406 */
  static ALTER_TABLE_INCLUDE_COLUMN_KEYWORD = true;

  /** py: sqlglot/generator.py:409 */
  static UNNEST_WITH_ORDINALITY = true;

  /** py: sqlglot/generator.py:412 */
  static SEMI_ANTI_JOIN_WITH_SIDE = true;

  /** py: sqlglot/generator.py:415 */
  static COMPUTED_COLUMN_WITH_TYPE = true;

  /** py: sqlglot/generator.py:418 */
  static SUPPORTS_TABLE_COPY = true;

  /** py: sqlglot/generator.py:421 */
  static TABLESAMPLE_REQUIRES_PARENS = true;

  /** py: sqlglot/generator.py:424 */
  static TABLESAMPLE_SIZE_IS_ROWS = true;

  /** py: sqlglot/generator.py:427 */
  static TABLESAMPLE_KEYWORDS = "TABLESAMPLE";

  /** py: sqlglot/generator.py:430 */
  static TABLESAMPLE_WITH_METHOD = true;

  /** py: sqlglot/generator.py:433 */
  static TABLESAMPLE_SEED_KEYWORD = "SEED";

  /** py: sqlglot/generator.py:436 */
  static HISTORICAL_DATA_POST_ALIAS = false;

  /** py: sqlglot/generator.py:439 */
  static COLLATE_IS_FUNC = false;

  /** py: sqlglot/generator.py:442 */
  static DATA_TYPE_SPECIFIERS_ALLOWED = false;

  /** py: sqlglot/generator.py:445 */
  static ENSURE_BOOLS = false;

  /** py: sqlglot/generator.py:448 */
  static CTE_RECURSIVE_KEYWORD_REQUIRED = true;

  /** py: sqlglot/generator.py:451 */
  static SUPPORTS_SINGLE_ARG_CONCAT = true;

  /** py: sqlglot/generator.py:454 */
  static LAST_DAY_SUPPORTS_DATE_PART = true;

  /** py: sqlglot/generator.py:457 */
  static SUPPORTS_TABLE_ALIAS_COLUMNS = true;

  /** py: sqlglot/generator.py:460 */
  static SUPPORTS_NAMED_CTE_COLUMNS = true;

  /** py: sqlglot/generator.py:463 */
  static UNPIVOT_ALIASES_ARE_IDENTIFIERS = true;

  /** py: sqlglot/generator.py:466 */
  static PIVOT_ALIAS_WITH_AS = true;

  /** py: sqlglot/generator.py:469 */
  static JSON_KEY_VALUE_PAIR_SEP = ":";

  /** py: sqlglot/generator.py:472 */
  static INSERT_OVERWRITE = " OVERWRITE TABLE";

  /** py: sqlglot/generator.py:475 */
  static SUPPORTS_SELECT_INTO = false;

  /** py: sqlglot/generator.py:478 */
  static SUPPORTS_UNLOGGED_TABLES = false;

  /** py: sqlglot/generator.py:481 */
  static SUPPORTS_CREATE_TABLE_LIKE = true;

  /** py: sqlglot/generator.py:484 */
  static SUPPORTS_MODIFY_COLUMN = false;

  /** py: sqlglot/generator.py:487 */
  static SUPPORTS_CHANGE_COLUMN = false;

  /** py: sqlglot/generator.py:490 */
  static SUPPORTS_ALTER_COLUMN_NULLABILITY = false;

  /** py: sqlglot/generator.py:493 */
  static SUPPORTS_ALTER_COLUMN_IF_EXISTS = false;

  /** py: sqlglot/generator.py:496 */
  static LIKE_PROPERTY_INSIDE_SCHEMA = false;

  /** py: sqlglot/generator.py:500 */
  static MULTI_ARG_DISTINCT = true;

  /** py: sqlglot/generator.py:503 */
  static JSON_TYPE_REQUIRED_FOR_EXTRACTION = false;

  /** py: sqlglot/generator.py:506 */
  static JSON_PATH_BRACKETED_KEY_SUPPORTED = true;

  /** py: sqlglot/generator.py:509 */
  static JSON_PATH_SINGLE_QUOTE_ESCAPE = false;

  /** py: sqlglot/generator.py:515 */
  static JSON_PATH_KEY_QUOTED_FORCES_BRACKETS = false;

  /**
   * py: sqlglot/generator.py:518 `SUPPORTED_JSON_PATH_PARTS = ALL_JSON_PATH_PARTS.copy()`
   *
   * The ONLY one of the 126 settings the seeder could not fill, because its value is a
   * call rather than a literal: `ALL_JSON_PATH_PARTS = set(JSON_PATH_PART_TRANSFORMS)`
   * (jsonpath.py:238), i.e. the 10 keys of a table in `sqlglot/jsonpath.py` — a module
   * this phase deliberately defers.
   *
   * Was a THROWING GETTER before `ALL_JSON_PATH_PARTS` above got its trait-derived
   * definition (this file's own note there records why hand-listing the ten classes
   * was rejected as the fix). Now a real getter, matching `ALL_JSON_PATH_PARTS.copy()`
   * — a fresh `Set` per read, so a caller mutating its result (as `registerDialect`'s
   * pruning does to a DIALECT's copy, never this one) cannot corrupt the shared
   * constant. A dialect subclass may still shadow it with a plain `static` field, same
   * as upstream's `SnowflakeGenerator.SUPPORTED_JSON_PATH_PARTS = {...}` override.
   */
  // py: sqlglot/generator.py:518
  static get SUPPORTED_JSON_PATH_PARTS() {
    return new Set(ALL_JSON_PATH_PARTS);
  }

  /** py: sqlglot/generator.py:521 */
  static CAN_IMPLEMENT_ARRAY_ANY = false;

  /** py: sqlglot/generator.py:524 */
  static SUPPORTS_TO_NUMBER = true;

  /** py: sqlglot/generator.py:527 */
  static SUPPORTS_WINDOW_EXCLUDE = false;

  /** py: sqlglot/generator.py:532 */
  static SET_OP_MODIFIERS = true;

  /** py: sqlglot/generator.py:535 */
  static COPY_PARAMS_ARE_WRAPPED = true;

  /** py: sqlglot/generator.py:538 */
  static COPY_PARAMS_EQ_REQUIRED = false;

  /** py: sqlglot/generator.py:541 */
  static COPY_HAS_INTO_KEYWORD = true;

  /** py: sqlglot/generator.py:544 */
  static TRY_SUPPORTED = true;

  /** py: sqlglot/generator.py:547 */
  static SUPPORTS_UESCAPE = true;

  /** py: sqlglot/generator.py:550 */
  static UNICODE_SUBSTITUTE = null;

  /** py: sqlglot/generator.py:553 */
  static STAR_EXCEPT = "EXCEPT";

  /** py: sqlglot/generator.py:556 */
  static HEX_FUNC = "HEX";

  /** py: sqlglot/generator.py:559 */
  static WITH_PROPERTIES_PREFIX = "WITH";

  /** py: sqlglot/generator.py:562 */
  static QUOTE_JSON_PATH = true;

  /** py: sqlglot/generator.py:565 */
  static PAD_FILL_PATTERN_IS_REQUIRED = false;

  /** py: sqlglot/generator.py:568 */
  static SUPPORTS_EXPLODING_PROJECTIONS = true;

  /** py: sqlglot/generator.py:571 */
  static ARRAY_CONCAT_IS_VAR_LEN = true;

  /** py: sqlglot/generator.py:574 */
  static SUPPORTS_CONVERT_TIMEZONE = false;

  /** py: sqlglot/generator.py:577 */
  static SUPPORTS_MEDIAN = true;

  /** py: sqlglot/generator.py:580 */
  static SUPPORTS_UNIX_SECONDS = false;

  /** py: sqlglot/generator.py:583 */
  static ALTER_SET_WRAPPED = false;

  /** py: sqlglot/generator.py:588 */
  static NORMALIZE_EXTRACT_DATE_PARTS = false;

  /** py: sqlglot/generator.py:591 */
  static PARSE_JSON_NAME = "PARSE_JSON";

  /** py: sqlglot/generator.py:594 */
  static ARRAY_SIZE_NAME = "ARRAY_LENGTH";

  /** py: sqlglot/generator.py:597 */
  static ALTER_SET_TYPE = "SET DATA TYPE";

  /** py: sqlglot/generator.py:603 */
  static ARRAY_SIZE_DIM_REQUIRED = null;

  /** py: sqlglot/generator.py:606 */
  static SUPPORTS_DECODE_CASE = true;

  /** py: sqlglot/generator.py:609 */
  static SUPPORTS_BETWEEN_FLAGS = false;

  /** py: sqlglot/generator.py:612 */
  static SUPPORTS_LIKE_QUANTIFIERS = true;

  /** py: sqlglot/generator.py:615 */
  static MATCH_AGAINST_TABLE_PREFIX = null;

  /** py: sqlglot/generator.py:618 */
  static SET_ASSIGNMENT_REQUIRES_VARIABLE_KEYWORD = false;

  /** py: sqlglot/generator.py:621 */
  static DECLARE_DEFAULT_ASSIGNMENT = "=";

  /** py: sqlglot/generator.py:626 */
  static UPDATE_STATEMENT_SUPPORTS_FROM = true;

  /** py: sqlglot/generator.py:629 */
  static STAR_EXCLUDE_REQUIRES_DERIVED_TABLE = true;

  /** py: sqlglot/generator.py:634 */
  static SUPPORTS_DROP_ALTER_ICEBERG_PROPERTY = true;

  /** py: sqlglot/generator.py:636 */
  static TYPE_MAPPING = new Map([
    /* py:637 */ [exp.DType.DATETIME2, "TIMESTAMP"],
    /* py:638 */ [exp.DType.NCHAR, "CHAR"],
    /* py:639 */ [exp.DType.NVARCHAR, "VARCHAR"],
    /* py:640 */ [exp.DType.MEDIUMTEXT, "TEXT"],
    /* py:641 */ [exp.DType.LONGTEXT, "TEXT"],
    /* py:642 */ [exp.DType.TINYTEXT, "TEXT"],
    /* py:643 */ [exp.DType.BLOB, "VARBINARY"],
    /* py:644 */ [exp.DType.MEDIUMBLOB, "BLOB"],
    /* py:645 */ [exp.DType.LONGBLOB, "BLOB"],
    /* py:646 */ [exp.DType.TINYBLOB, "BLOB"],
    /* py:647 */ [exp.DType.INET, "INET"],
    /* py:648 */ [exp.DType.ROWVERSION, "VARBINARY"],
    /* py:649 */ [exp.DType.SMALLDATETIME, "TIMESTAMP"],
  ]);

  /** py: sqlglot/generator.py:652 */
  static UNSUPPORTED_TYPES = new Set([
  ]);

  /** py: sqlglot/generator.py:657 */
  static TYPE_PARAM_SETTINGS = new Map([
  ]);

  /** py: sqlglot/generator.py:659 */
  static TIME_PART_SINGULARS = new Map([
    /* py:660 */ ["MICROSECONDS", "MICROSECOND"],
    /* py:661 */ ["SECONDS", "SECOND"],
    /* py:662 */ ["MINUTES", "MINUTE"],
    /* py:663 */ ["HOURS", "HOUR"],
    /* py:664 */ ["DAYS", "DAY"],
    /* py:665 */ ["WEEKS", "WEEK"],
    /* py:666 */ ["MONTHS", "MONTH"],
    /* py:667 */ ["QUARTERS", "QUARTER"],
    /* py:668 */ ["YEARS", "YEAR"],
  ]);

  /** py: sqlglot/generator.py:671 — all five modifiers, including WINDOW/QUALIFY. */
  static AFTER_HAVING_MODIFIER_TRANSFORMS = new Map([
    ["cluster", (self, e) => self.sql(e, "cluster")],
    ["distribute", (self, e) => self.sql(e, "distribute")],
    ["sort", (self, e) => self.sql(e, "sort")],
    ...AFTER_HAVING_MODIFIER_TRANSFORMS,
  ]);

  /** py: sqlglot/generator.py:678 */
  static TOKEN_MAPPING = new Map([
  ]);

  /** py: sqlglot/generator.py:680 */
  static STRUCT_DELIMITER = [
    /* py:680 */ "<",
    /* py:680 */ ">",
  ];

  /** py: sqlglot/generator.py:682 */
  static PARAMETER_TOKEN = "@";

  /** py: sqlglot/generator.py:683 */
  static NAMED_PLACEHOLDER_TOKEN = ":";

  /** py: sqlglot/generator.py:685 */
  static EXPRESSION_PRECEDES_PROPERTIES_CREATABLES = new Set([
  ]);

  /** py: sqlglot/generator.py:687 */
  static PROPERTIES_LOCATION = new Map([
    /* py:688 */ [exp.AllowedValuesProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:689 */ [exp.AlgorithmProperty, exp.Properties.Location.POST_CREATE],
    /* py:690 */ [exp.ApiProperty, exp.Properties.Location.POST_CREATE],
    /* py:691 */ [exp.ApplicationProperty, exp.Properties.Location.POST_CREATE],
    /* py:692 */ [exp.AutoIncrementProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:693 */ [exp.AutoRefreshProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:694 */ [exp.BackupProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:695 */ [exp.BlockCompressionProperty, exp.Properties.Location.POST_NAME],
    /* py:696 */ [exp.CalledOnNullInputProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:697 */ [exp.CatalogProperty, exp.Properties.Location.POST_CREATE],
    /* py:698 */ [exp.CharacterSetProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:699 */ [exp.ChecksumProperty, exp.Properties.Location.POST_NAME],
    /* py:700 */ [exp.CollateProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:701 */ [exp.ComputeProperty, exp.Properties.Location.POST_CREATE],
    /* py:702 */ [exp.CopyGrantsProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:703 */ [exp.Cluster, exp.Properties.Location.POST_SCHEMA],
    /* py:704 */ [exp.ClusteredByProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:705 */ [exp.ClusterProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:706 */ [exp.DistributedByProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:707 */ [exp.DuplicateKeyProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:708 */ [exp.DataBlocksizeProperty, exp.Properties.Location.POST_NAME],
    /* py:709 */ [exp.DatabaseProperty, exp.Properties.Location.POST_CREATE],
    /* py:710 */ [exp.DataDeletionProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:711 */ [exp.DefinerProperty, exp.Properties.Location.POST_CREATE],
    /* py:712 */ [exp.DictRange, exp.Properties.Location.POST_SCHEMA],
    /* py:713 */ [exp.DictProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:714 */ [exp.DynamicProperty, exp.Properties.Location.POST_CREATE],
    /* py:715 */ [exp.DistKeyProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:716 */ [exp.DistStyleProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:717 */ [exp.EmptyProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:718 */ [exp.EncodeProperty, exp.Properties.Location.POST_EXPRESSION],
    /* py:719 */ [exp.EngineProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:720 */ [exp.EnviromentProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:721 */ [exp.HandlerProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:722 */ [exp.ParameterStyleProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:723 */ [exp.ExecuteAsProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:724 */ [exp.ExternalProperty, exp.Properties.Location.POST_CREATE],
    /* py:725 */ [exp.FallbackProperty, exp.Properties.Location.POST_NAME],
    /* py:726 */ [exp.FileFormatProperty, exp.Properties.Location.POST_WITH],
    /* py:727 */ [exp.FreespaceProperty, exp.Properties.Location.POST_NAME],
    /* py:728 */ [exp.GlobalProperty, exp.Properties.Location.POST_CREATE],
    /* py:729 */ [exp.HeapProperty, exp.Properties.Location.POST_WITH],
    /* py:730 */ [exp.HybridProperty, exp.Properties.Location.POST_CREATE],
    /* py:731 */ [exp.InheritsProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:732 */ [exp.IcebergProperty, exp.Properties.Location.POST_CREATE],
    /* py:733 */ [exp.IncludeProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:734 */ [exp.InputModelProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:735 */ [exp.IsolatedLoadingProperty, exp.Properties.Location.POST_NAME],
    /* py:736 */ [exp.JournalProperty, exp.Properties.Location.POST_NAME],
    /* py:737 */ [exp.LanguageProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:738 */ [exp.LikeProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:739 */ [exp.LocationProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:740 */ [exp.LockProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:741 */ [exp.LockingProperty, exp.Properties.Location.POST_ALIAS],
    /* py:742 */ [exp.LogProperty, exp.Properties.Location.POST_NAME],
    /* py:743 */ [exp.MaskingProperty, exp.Properties.Location.POST_CREATE],
    /* py:744 */ [exp.MaterializedProperty, exp.Properties.Location.POST_CREATE],
    /* py:745 */ [exp.MergeBlockRatioProperty, exp.Properties.Location.POST_NAME],
    /* py:746 */ [exp.ModuleProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:747 */ [exp.NetworkProperty, exp.Properties.Location.POST_CREATE],
    /* py:748 */ [exp.NoPrimaryIndexProperty, exp.Properties.Location.POST_EXPRESSION],
    /* py:749 */ [exp.OnProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:750 */ [exp.OnCommitProperty, exp.Properties.Location.POST_EXPRESSION],
    /* py:751 */ [exp.Order, exp.Properties.Location.POST_SCHEMA],
    /* py:752 */ [exp.OutputModelProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:753 */ [exp.PartitionedByProperty, exp.Properties.Location.POST_WITH],
    /* py:754 */ [exp.PartitionedOfProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:755 */ [exp.PrimaryKey, exp.Properties.Location.POST_SCHEMA],
    /* py:756 */ [exp.Property, exp.Properties.Location.POST_WITH],
    /* py:757 */ [exp.RefreshTriggerProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:758 */ [exp.RemoteWithConnectionModelProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:759 */ [exp.ReturnsProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:760 */ [exp.RollupProperty, exp.Properties.Location.UNSUPPORTED],
    /* py:761 */ [exp.RowAccessProperty, exp.Properties.Location.UNSUPPORTED],
    /* py:762 */ [exp.RowFormatProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:763 */ [exp.RowFormatDelimitedProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:764 */ [exp.RowFormatSerdeProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:765 */ [exp.SampleProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:766 */ [exp.SchemaCommentProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:767 */ [exp.SecureProperty, exp.Properties.Location.POST_CREATE],
    /* py:768 */ [exp.SecurityIntegrationProperty, exp.Properties.Location.POST_CREATE],
    /* py:769 */ [exp.SerdeProperties, exp.Properties.Location.POST_SCHEMA],
    /* py:770 */ [exp.Set, exp.Properties.Location.POST_SCHEMA],
    /* py:771 */ [exp.SettingsProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:772 */ [exp.SetProperty, exp.Properties.Location.POST_CREATE],
    /* py:773 */ [exp.SetConfigProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:774 */ [exp.SharingProperty, exp.Properties.Location.POST_EXPRESSION],
    /* py:775 */ [exp.SequenceProperties, exp.Properties.Location.POST_EXPRESSION],
    /* py:776 */ [exp.TriggerProperties, exp.Properties.Location.POST_EXPRESSION],
    /* py:777 */ [exp.SortKeyProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:778 */ [exp.SqlReadWriteProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:779 */ [exp.SqlSecurityProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:780 */ [exp.StabilityProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:781 */ [exp.StorageHandlerProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:782 */ [exp.StreamingTableProperty, exp.Properties.Location.POST_CREATE],
    /* py:783 */ [exp.StrictProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:784 */ [exp.Tags, exp.Properties.Location.POST_WITH],
    /* py:785 */ [exp.TemporaryProperty, exp.Properties.Location.POST_CREATE],
    /* py:786 */ [exp.ToTableProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:787 */ [exp.TransientProperty, exp.Properties.Location.POST_CREATE],
    /* py:788 */ [exp.TransformModelProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:789 */ [exp.MergeTreeTTL, exp.Properties.Location.POST_SCHEMA],
    /* py:790 */ [exp.UnloggedProperty, exp.Properties.Location.POST_CREATE],
    /* py:791 */ [exp.UsingProperty, exp.Properties.Location.POST_EXPRESSION],
    /* py:792 */ [exp.UsingTemplateProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:793 */ [exp.ViewAttributeProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:794 */ [exp.VirtualProperty, exp.Properties.Location.POST_CREATE],
    /* py:795 */ [exp.VolatileProperty, exp.Properties.Location.POST_CREATE],
    /* py:796 */ [exp.WithDataProperty, exp.Properties.Location.POST_EXPRESSION],
    /* py:797 */ [exp.WithJournalTableProperty, exp.Properties.Location.POST_NAME],
    /* py:798 */ [exp.WithProcedureOptions, exp.Properties.Location.POST_SCHEMA],
    /* py:799 */ [exp.WithSchemaBindingProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:800 */ [exp.WithSystemVersioningProperty, exp.Properties.Location.POST_SCHEMA],
    /* py:801 */ [exp.ForceProperty, exp.Properties.Location.POST_CREATE],
  ]);

  /** py: sqlglot/generator.py:805 */
  static RESERVED_KEYWORDS = new Set([
  ]);

  /** py: sqlglot/generator.py:808 */
  static WITH_SEPARATED_COMMENTS = [
    /* py:809 */ exp.Command,
    /* py:810 */ exp.Create,
    /* py:811 */ exp.Describe,
    /* py:812 */ exp.Delete,
    /* py:813 */ exp.Drop,
    /* py:814 */ exp.From,
    /* py:815 */ exp.Insert,
    /* py:816 */ exp.Join,
    /* py:817 */ exp.MultitableInserts,
    /* py:818 */ exp.Order,
    /* py:819 */ exp.Group,
    /* py:820 */ exp.Having,
    /* py:821 */ exp.Select,
    /* py:822 */ exp.SetOperation,
    /* py:823 */ exp.Update,
    /* py:824 */ exp.Where,
    /* py:825 */ exp.With,
  ];

  /** py: sqlglot/generator.py:829 */
  static EXCLUDE_COMMENTS = [
    /* py:830 */ exp.Binary,
    /* py:831 */ exp.SetOperation,
  ];

  /** py: sqlglot/generator.py:835 */
  static UNWRAPPED_INTERVAL_VALUES = [
    /* py:836 */ exp.Column,
    /* py:837 */ exp.Literal,
    /* py:838 */ exp.Neg,
    /* py:839 */ exp.Paren,
  ];

  /** py: sqlglot/generator.py:842 */
  static PARAMETERIZABLE_TEXT_TYPES = new Set([
    /* py:843 */ exp.DType.NVARCHAR,
    /* py:844 */ exp.DType.VARCHAR,
    /* py:845 */ exp.DType.CHAR,
    /* py:846 */ exp.DType.NCHAR,
  ]);

  /** py: sqlglot/generator.py:850 */
  static EXPRESSIONS_WITHOUT_NESTED_CTES = new Set([
  ]);

  /** py: sqlglot/generator.py:852 */
  static RESPECT_IGNORE_NULLS_UNSUPPORTED_EXPRESSIONS = [
  ];

  /** py: sqlglot/generator.py:854 */
  static SAFE_JSON_PATH_KEY_RE = exp.SAFE_IDENTIFIER_RE;

  /** py: sqlglot/generator.py:856 */
  static SENTINEL_LINE_BREAK = "__SQLGLOT__LB__";

  /**
   * py: sqlglot/generator.py:882 `Generator.__init__`
   *
   * DEVIATION (CONTRACTS.md §8): upstream's 12 keyword arguments become ONE options
   * object, the precedent already set by `TokenizerCore.__init__`'s 26. Field order is
   * upstream's parameter order.
   *
   * The `dialect` argument follows the rule `Tokenizer.__init__` and
   * `Parser._resolveDialect` already enforce: `dialects/dialect.js`'s registry is P5,
   * so an already-resolved settings object (or null, meaning the base `Dialect`
   * defaults) is accepted and a dialect NAME throws. Silently falling back to the
   * default dialect would make every per-dialect generate-oracle row vacuously green.
   *
   * @param {object} [options]
   */
  // py: sqlglot/generator.py:882
  constructor(options = {}) {
    const {
      pretty = null,
      identify = false,
      normalize = false,
      pad = 2,
      indent = 2,
      normalize_functions = null,
      unsupported_level = ErrorLevel.WARN,
      max_unsupported = 3,
      leading_comma = false,
      max_text_width = 80,
      comments = true,
      dialect = null,
    } = options;

    // py: `pretty if pretty is not None else sqlglot.pretty`. The module-level
    // `sqlglot.pretty` global defaults to False and is only settable from user code,
    // which this port has no equivalent of yet.
    this.pretty = pretty !== null && pretty !== undefined ? pretty : false;
    this.identify = identify;
    this.normalize = normalize;
    this.pad = pad;
    this._indent = indent;
    this.unsupported_level = unsupported_level;
    this.max_unsupported = max_unsupported;
    this.leading_comma = leading_comma;
    this.max_text_width = max_text_width;
    this.comments = comments;
    this.dialect = _resolveDialect(dialect);

    // py: "This is both a Dialect property and a Generator argument, so we prioritize
    // the latter" — `is None`, so an explicit `false` must survive.
    this.normalize_functions =
      normalize_functions === null || normalize_functions === undefined
        ? this.dialect.NORMALIZE_FUNCTIONS
        : normalize_functions;

    /** @type {string[]} */
    this.unsupported_messages = [];
    this._escaped_quote_end = this.dialect.tokenizer_class.STRING_ESCAPES[0] + this.dialect.QUOTE_END;
    this._escaped_byte_quote_end = this.dialect.BYTE_END
      ? this.dialect.tokenizer_class.STRING_ESCAPES[0] + this.dialect.BYTE_END
      : "";
    // py: `self.dialect.IDENTIFIER_END * 2` — Python string repetition, not arithmetic.
    this._escaped_identifier_end = this.dialect.IDENTIFIER_END.repeat(2);

    this._next_name = nameSequence("_t");

    this._identifier_start = this.dialect.IDENTIFIER_START;
    this._identifier_end = this.dialect.IDENTIFIER_END;

    this._quote_json_path_key_using_brackets = true;

    // py:936-940 — memoised per CLASS, so every instance of a dialect generator shares
    // one resolved table and the prototype walk runs once.
    const cls = this.constructor;
    let dispatch = _DISPATCH_CACHE.get(cls);
    if (dispatch === undefined) {
      dispatch = _buildDispatch(cls);
      _DISPATCH_CACHE.set(cls, dispatch);
    }
    this._dispatch = dispatch;
  }

  /**
   * py: sqlglot/generator.py:942 — generates the SQL string for a syntax tree.
   * @param {exp.Expr} expression
   * @param {boolean} [copy] the generator mutates, so copying is the safe default
   * @returns {string}
   */
  // py: sqlglot/generator.py:942
  generate(expression, copy = true) {
    if (copy) expression = expression.copy();

    expression = this.preprocess(expression);

    this.unsupported_messages = [];
    const sql0 = pyStrip(this.sql(expression));

    // py: `sql.replace(self.SENTINEL_LINE_BREAK, "\n")` — Python's str.replace is
    // replace-ALL, so this is `replaceAll`, not `replace`.
    let sql = this.pretty
      ? sql0.replaceAll(this.constructor.SENTINEL_LINE_BREAK, "\n")
      : sql0;

    if (this.unsupported_level === ErrorLevel.IGNORE) return sql;

    if (this.unsupported_level === ErrorLevel.WARN) {
      for (const msg of this.unsupported_messages) logger.warning(msg);
    } else if (this.unsupported_level === ErrorLevel.RAISE && this.unsupported_messages.length) {
      throw new UnsupportedError(concatMessages(this.unsupported_messages, this.max_unsupported));
    }

    return sql;
  }

  /**
   * py: sqlglot/generator.py:976 — generic preprocessing applied before generation.
   * @param {exp.Expr} expression
   * @returns {exp.Expr}
   */
  // py: sqlglot/generator.py:976
  preprocess(expression) {
    expression = this._move_ctes_to_top_level(expression);

    if (this.constructor.ENSURE_BOOLS) {
      // py: `import sqlglot.transforms; expression = ensure_bools(expression)`.
      // `transforms.js`'s own `ensure_bools` (PORT_PLAN.md, TSQL generator round —
      // the first generator in this port to set `ENSURE_BOOLS = true`).
      expression = ensure_bools(expression);
    }

    return expression;
  }

  /**
   * py: sqlglot/generator.py:987
   * @param {exp.Expr} expression
   * @returns {exp.Expr}
   */
  // py: sqlglot/generator.py:987
  _move_ctes_to_top_level(expression) {
    if (
      !expression.parent &&
      this.constructor.EXPRESSIONS_WITHOUT_NESTED_CTES.has(expression.constructor) &&
      [...expression.findAll(exp.With)].some((node) => node.parent !== expression)
    ) {
      // py: `import sqlglot.transforms; expression = sqlglot.transforms.move_ctes_to_top_level(expression)`.
      // `transforms.js`'s own `move_ctes_to_top_level` (PORT_PLAN.md, TSQL generator
      // round — the first generator in this port to populate
      // `EXPRESSIONS_WITHOUT_NESTED_CTES`).
      expression = move_ctes_to_top_level(expression);
    }
    return expression;
  }

  /**
   * py: sqlglot/generator.py:998
   *
   * Records an unsupported-construct message, or raises immediately at
   * `ErrorLevel.IMMEDIATE`. `unsupported_messages` is asserted against the
   * generate-oracle on every row (§3.1(D) / review finding B3), so appending here is
   * observable behaviour, not diagnostics.
   * @param {string} message
   */
  // py: sqlglot/generator.py:998
  unsupported(message) {
    if (this.unsupported_level === ErrorLevel.IMMEDIATE) throw new UnsupportedError(message);
    this.unsupported_messages.push(message);
  }

  /**
   * py: sqlglot/generator.py:1003 `sep(sep=" ")`
   * @param {string} [sep]
   * @returns {string}
   */
  // py: sqlglot/generator.py:1003
  sep(sep = " ") {
    return this.pretty ? `${pyStrip(sep)}\n` : sep;
  }

  /**
   * py: sqlglot/generator.py:1006 `seg(sql, sep=" ")`
   * @param {string} sql
   * @param {string} [sep]
   * @returns {string}
   */
  // py: sqlglot/generator.py:1006
  seg(sql, sep = " ") {
    return `${this.sep(sep)}${sql}`;
  }

  /**
   * py: sqlglot/generator.py:1009
   *
   * `comment[0]` / `comment[-1]` index by CODE POINT (rule 3), and `.strip()` is
   * `pyStrip` — truthiness of the stripped single character is the actual test, i.e.
   * "is this character non-whitespace".
   * @param {string} comment
   * @returns {string}
   */
  // py: sqlglot/generator.py:1009
  sanitize_comment(comment) {
    if (pyStrip(cpAt(comment, 0))) comment = " " + comment;
    if (pyStrip(cpAt(comment, -1))) comment = comment + " ";

    // Escape block comment markers to prevent premature closure or unintended nesting.
    // This is necessary because single-line comments (--) are converted to block comments
    // (/* */) on output, and any */ in the original text would close the comment early.
    comment = comment.replaceAll("*/", "* /").replaceAll("/*", "/ *");

    return comment;
  }

  /**
   * py: sqlglot/generator.py:1020 `maybe_comment(sql, expression=None, comments=None, separated=False)`
   *
   * `comments` and `separated` arrive in a trailing options object (rule 2): measured
   * over upstream's 7 call sites, both are always passed by keyword and never
   * positionally past `expression`.
   * @param {string} sql
   * @param {exp.Expr|null} [expression]
   * @param {{comments?: string[]|null, separated?: boolean}} [options]
   * @returns {string}
   */
  // py: sqlglot/generator.py:1020
  maybe_comment(sql, expression = null, options = {}) {
    const { comments: commentsArg = null, separated = false } = options;
    const cls = this.constructor;

    const comments = this.comments
      ? commentsArg === null || commentsArg === undefined
        ? expression && expression.comments
        : commentsArg
      : null;

    if (!comments || !comments.length || _isinstance(expression, cls.EXCLUDE_COMMENTS)) return sql;

    const comments_list = comments
      .filter((comment) => comment)
      .map((comment) => `/*${this._replace_line_breaks(this.sanitize_comment(comment))}*/`);

    if (!comments_list.length) return sql;

    if (separated || _isinstance(expression, cls.WITH_SEPARATED_COMMENTS)) {
      const comments_sql = comments_list.join(this.sep());
      // py: `not sql or sql[0].isspace()` — code-point 0, Python's isspace.
      return !sql || pyIsSpace(cpAt(sql, 0))
        ? `${this.sep()}${comments_sql}${sql}`
        : `${comments_sql}${this.sep()}${sql}`;
    }

    return `${sql} ${comments_list.join(" ")}`;
  }

  /**
   * py: sqlglot/generator.py:1055
   * @param {exp.Expr|string} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:1055
  wrap(expression) {
    let this_sql = _isinstance(expression, UNWRAPPED_QUERIES())
      ? this.sql(expression)
      : this.sql(expression, "this");
    if (!this_sql) return "()";

    this_sql = this.indent(this_sql, { level: 1, pad: 0 });
    // py: f"({self.sep('')}{this_sql}{self.seg(')', sep='')}" — the closing paren comes
    // from `seg(")")`, so there is deliberately no literal `)` at the end here.
    return `(${this.sep("")}${this_sql}${this.seg(")", "")}`;
  }

  /**
   * py: sqlglot/generator.py:1067 `no_identify(func, *args, **kwargs)`
   *
   * Var-args (rule 2): everything after `func` is forwarded untouched, including the
   * trailing options object that upstream would have received as `**kwargs`.
   * @param {(...a: any[]) => string} func
   * @returns {string}
   */
  // py: sqlglot/generator.py:1067
  no_identify(func, ...args) {
    const original = this.identify;
    this.identify = false;
    const result = func(...args);
    this.identify = original;
    return result;
  }

  /**
   * py: sqlglot/generator.py:1074
   * @param {string} name
   * @returns {string}
   */
  // py: sqlglot/generator.py:1074
  normalize_func(name) {
    // py: `== "upper" or self.normalize_functions is True` — a literal `True`, so a
    // truthy non-True value must NOT take this branch.
    if (this.normalize_functions === "upper" || this.normalize_functions === true) {
      return name.toUpperCase();
    }
    if (this.normalize_functions === "lower") return name.toLowerCase();
    return name;
  }

  /**
   * py: sqlglot/generator.py:1081 `indent(sql, level=0, pad=None, skip_first=False, skip_last=False)`
   *
   * Options object (rule 2): measured over upstream's 14 call sites, `sql` is always
   * the only positional argument.
   * @param {string} sql
   * @param {{level?: number, pad?: number|null, skip_first?: boolean, skip_last?: boolean}} [options]
   * @returns {string}
   */
  // py: sqlglot/generator.py:1081
  indent(sql, options = {}) {
    const { level = 0, pad: padArg = null, skip_first = false, skip_last = false } = options;

    if (!this.pretty || !sql) return sql;

    const pad = padArg === null || padArg === undefined ? this.pad : padArg;
    const lines = sql.split("\n");

    return lines
      .map((line, i) =>
        (skip_first && i === 0) || (skip_last && i === lines.length - 1)
          ? line
          : `${" ".repeat(level * this._indent + pad)}${line}`,
      )
      .join("\n");
  }

  /**
   * py: sqlglot/generator.py:1104 `sql(expression, key=None, comment=True)`
   *
   * EXACT-CLASS dispatch: `self._dispatch.get(expression.__class__)` is a dict lookup
   * keyed by the concrete class, NOT an isinstance walk — a subclass with no entry of
   * its own does NOT inherit its parent's handler. Only two fallbacks exist, and only
   * after the exact lookup misses: `Func` -> `function_fallback_sql`, then `Property`
   * -> `property_sql`. Anything else is a hard error, deliberately.
   *
   * Kept positional (unlike its neighbours): 579 of upstream's 708 call sites pass
   * `(expression, key)` positionally, so an options object here would be the deviation.
   * @param {exp.Expr|string|null|undefined} expression
   * @param {string|null} [key]
   * @param {boolean} [comment]
   * @returns {string}
   */
  // py: sqlglot/generator.py:1104
  sql(expression, key = null, comment = true) {
    // py: `if not expression` — Python falsiness. An Expr is always truthy; this guards
    // None and the empty string.
    if (!expression) return "";

    if (typeof expression === "string") return expression;

    if (key) {
      const value = expression.args[key];
      if (value) return this.sql(value);
      return "";
    }

    const handler = this._dispatch.get(expression.constructor);

    let sql;
    if (handler) {
      // A dispatch value is either a `*_sql` METHOD NAME (looked up on the instance, so
      // a subclass override wins) or a TRANSFORMS callable taking `(self, expression)`.
      sql = typeof handler === "string" ? this[handler](expression) : handler(this, expression);
    } else if (expression instanceof exp.Func) {
      sql = this.function_fallback_sql(expression);
    } else if (expression instanceof exp.Property) {
      sql = this.property_sql(expression);
    } else {
      // py: `raise ValueError(...)`. `PyValueError`, not a JS `TypeError`: the port's
      // convention for a Python `ValueError` is the `_py/errors.js` class (15 existing
      // sites), and a bare `TypeError` is neither upstream's type nor a `PyException`,
      // so it would be invisible to any `instanceof PyValueError` handler.
      throw new PyValueError(`Unsupported expression type ${expression.constructor.name}`);
    }

    return this.comments && comment ? this.maybe_comment(sql, expression) : sql;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1135
  uncache_sql(expression) {
    const table = this.sql(expression, "this");
    const exists_sql = expression.args.exists ? " IF EXISTS" : "";
    return `UNCACHE TABLE${exists_sql} ${table}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1140
  cache_sql(expression) {
    const lazy = expression.args.lazy ? " LAZY" : "";
    const table = this.sql(expression, "this");
    const options = expression.args.options;
    const options_sql = options ? ` OPTIONS(${this.sql(options[0])} = ${this.sql(options[1])})` : "";
    let sql = this.sql(expression, "expression");
    sql = sql ? ` AS${this.sep()}${sql}` : "";
    sql = `CACHE${lazy} TABLE ${table}${options_sql}${sql}`;
    return this.prepend_ctes(expression, sql);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1150
  characterset_sql(expression) {
    const default_ = expression.args.default ? "DEFAULT " : "";
    return `${default_}CHARACTER SET=${this.sql(expression, "this")}`;
  }

  /**
   * py: sqlglot/generator.py:1154
   * @param {exp.Column} expression
   * @returns {string}
   */
  column_parts(expression) {
    if (expression.args.shadow && this.dialect.PROJECTION_ALIASES_SHADOW_SOURCE_NAMES) {
      // py comment: "The qualifier would be captured by a colliding projection alias
      // (see qualify_columns)".
      return this.sql(expression, "this");
    }

    // py: `".".join(self.sql(part) for part in (...) if part)`. The `if part` is Python
    // falsiness over an arg value: an Expr is always truthy, so this drops only the
    // absent parts. Rendering them instead would emit the string "undefined" between
    // dots — the JS-template-literal counterpart of Python's "None", which P4's blocking
    // step already had to fix once in `property_sql`.
    const parts = [
      expression.args.catalog,
      expression.args.db,
      expression.args.table,
      expression.args.this,
    ];
    return parts.filter((part) => Boolean(part)).map((part) => this.sql(part)).join(".");
  }

  /**
   * py: sqlglot/generator.py:1170
   * @param {exp.Column} expression
   * @returns {string}
   */
  column_sql(expression) {
    let join_mark = expression.args.join_mark ? " (+)" : "";

    if (join_mark && !this.dialect.SUPPORTS_COLUMN_JOIN_MARKS) {
      join_mark = "";
      this.unsupported("Outer join syntax using the (+) operator is not supported.");
    }

    return `${this.column_parts(expression)}${join_mark}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1179
  pseudocolumn_sql(expression) {
    return this.column_sql(expression);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1182
  columnposition_sql(expression) {
    let this_ = this.sql(expression, "this");
    this_ = this_ ? ` ${this_}` : "";
    const position = this.sql(expression, "position");
    return `${position}${this_}`;
  }

  /**
   * py: sqlglot/generator.py:1188 `columndef_sql(self, expression, sep=" ")`
   * @param {exp.ColumnDef} expression
   * @param {string} [sep]
   * @returns {string}
   */
  // py: sqlglot/generator.py:1188
  columndef_sql(expression, sep = " ") {
    const column = this.sql(expression, "this");
    let kind = this.sql(expression, "kind");
    const constraints = this.expressions(expression, "constraints", { sep: " ", flat: true });
    const exists = expression.args.exists ? "IF NOT EXISTS " : "";
    kind = kind ? `${sep}${kind}` : "";
    const constraints_ = constraints ? ` ${constraints}` : "";
    let position = this.sql(expression, "position");
    position = position ? ` ${position}` : "";

    if (expression.find(exp.ComputedColumnConstraint) && !this.constructor.COMPUTED_COLUMN_WITH_TYPE) {
      kind = "";
    }

    return `${exists}${column}${kind}${constraints_}${position}`;
  }

  /**
   * py: sqlglot/generator.py:1203
   * @param {exp.ColumnConstraint} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:1203
  columnconstraint_sql(expression) {
    const this_ = this.sql(expression, "this");
    const kind_sql = pyStrip(this.sql(expression, "kind"));
    return this_ ? `CONSTRAINT ${this_} ${kind_sql}` : kind_sql;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1208
  // py: sqlglot/generator.py:1208
  computedcolumnconstraint_sql(expression) {
    const this_ = this.sql(expression, "this");
    let persisted;
    if (expression.args.not_null) {
      persisted = " PERSISTED NOT NULL";
    } else if (expression.args.persisted) {
      persisted = " PERSISTED";
    } else {
      persisted = "";
    }

    return `AS ${this_}${persisted}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1219
  autoincrementcolumnconstraint_sql(_) {
    return this.token_sql(TokenType.AUTO_INCREMENT);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1222
  compresscolumnconstraint_sql(expression) {
    let this_;
    if (Array.isArray(expression.this)) {
      this_ = this.wrap(this.expressions(expression, "this", { flat: true }));
    } else {
      this_ = this.sql(expression, "this");
    }
    return `COMPRESS ${this_}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1230
  generatedasidentitycolumnconstraint_sql(expression) {
    let this_ = "";
    if (expression.this !== null && expression.this !== undefined) {
      const on_null = expression.args.on_null ? " ON NULL" : "";
      this_ = expression.this ? " ALWAYS" : ` BY DEFAULT${on_null}`;
    }

    let start = expression.args.start;
    start = start ? `START WITH ${start}` : "";
    let increment = expression.args.increment;
    increment = increment ? ` INCREMENT BY ${increment}` : "";
    let minvalue = expression.args.minvalue;
    minvalue = minvalue ? ` MINVALUE ${minvalue}` : "";
    let maxvalue = expression.args.maxvalue;
    maxvalue = maxvalue ? ` MAXVALUE ${maxvalue}` : "";
    const cycle = expression.args.cycle;
    let cycle_sql = "";

    if (cycle !== null && cycle !== undefined) {
      cycle_sql = `${!cycle ? " NO" : ""} CYCLE`;
      cycle_sql = !start && !increment ? pyStrip(cycle_sql) : cycle_sql;
    }

    let sequence_opts = "";
    if (start || increment || cycle_sql) {
      sequence_opts = `${start}${increment}${minvalue}${maxvalue}${cycle_sql}`;
      sequence_opts = ` (${pyStrip(sequence_opts)})`;
    }

    let expr = this.sql(expression, "expression");
    expr = expr ? `(${expr})` : "IDENTITY";

    return `GENERATED${this_} AS ${expr}${sequence_opts}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1263
  generatedasrowcolumnconstraint_sql(expression) {
    const start = expression.args.start ? "START" : "END";
    const hidden = expression.args.hidden ? " HIDDEN" : "";
    return `GENERATED ALWAYS AS ROW ${start}${hidden}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1270
  periodforsystemtimeconstraint_sql(expression) {
    return `PERIOD FOR SYSTEM_TIME (${this.sql(expression, "this")}, ${this.sql(expression, "expression")})`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1275
  notnullcolumnconstraint_sql(expression) {
    return `${expression.args.allow_null ? "" : "NOT "}NULL`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1278
  primarykeycolumnconstraint_sql(expression) {
    const desc = expression.args.desc;
    if (desc !== null && desc !== undefined) {
      return `PRIMARY KEY${desc ? " DESC" : " ASC"}`;
    }
    let options = this.expressions(expression, "options", { flat: true });
    options = options ? ` ${options}` : "";
    return `PRIMARY KEY${options}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1286
  uniquecolumnconstraint_sql(expression) {
    let this_ = this.sql(expression, "this");
    this_ = this_ ? ` ${this_}` : "";
    const index_type = expression.args.index_type;
    const index_type_sql = index_type ? ` USING ${index_type}` : "";
    let on_conflict = this.sql(expression, "on_conflict");
    on_conflict = on_conflict ? ` ${on_conflict}` : "";
    const nulls_sql = expression.args.nulls ? " NULLS NOT DISTINCT" : "";
    let options = this.expressions(expression, "options", { flat: true, sep: " " });
    options = options ? ` ${options}` : "";
    return `UNIQUE${nulls_sql}${this_}${index_type_sql}${on_conflict}${options}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1298
  inoutcolumnconstraint_sql(expression) {
    const input_ = expression.args.input_;
    const output = expression.args.output;
    const variadic = expression.args.variadic;

    if (variadic) return "VARIADIC";

    if (input_ && output) return `IN${this.constructor.INOUT_SEPARATOR}OUT`;
    if (input_) return "IN";
    if (output) return "OUT";

    return "";
  }

  /**
   * py: sqlglot/generator.py:1316
   * @param {exp.Create} expression
   * @param {Map} locations
   * @returns {string}
   */
  // py: sqlglot/generator.py:1316
  createable_sql(expression, locations) { return this.sql(expression, "this"); }

  /**
   * py: sqlglot/generator.py:1319
   * @param {exp.Create} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:1319
  create_sql(expression) {
    let kind = this.sql(expression, "kind");
    kind = this.dialect.INVERSE_CREATABLE_KIND_MAPPING.get(kind) || kind;

    const properties = expression.args.properties;

    if (
      kind === "TRIGGER" &&
      properties &&
      properties.expressions &&
      properties.expressions[0] instanceof exp.TriggerProperties &&
      properties.expressions[0].args.constraint
    ) {
      kind = `CONSTRAINT ${kind}`;
    }

    const properties_locs = properties ? this.locate_properties(properties) : new Map();
    // py: `properties_locs.get(loc)` — a Python `list`, where EMPTY is falsy. A dialect
    // override (e.g. `SnowflakeGenerator.createable_sql`'s in-place `.splice()` of a
    // matched property out of its location bucket) can leave a present-but-empty array
    // in the Map; a bare JS truthiness check on that array would misfire (arrays are
    // always truthy), so every one of this function's location checks goes through
    // this helper instead.
    const locHas = (loc) => (properties_locs.get(loc) || []).length > 0;

    const this_ = this.createable_sql(expression, properties_locs);

    let properties_sql = "";
    if (locHas(exp.Properties.Location.POST_SCHEMA) || locHas(exp.Properties.Location.POST_WITH)) {
      const props_ast = new exp.Properties({
        expressions: [
          ...(properties_locs.get(exp.Properties.Location.POST_SCHEMA) || []),
          ...(properties_locs.get(exp.Properties.Location.POST_WITH) || []),
        ],
      });
      props_ast.parent = expression;
      properties_sql = this.sql(props_ast);

      if (locHas(exp.Properties.Location.POST_SCHEMA)) {
        properties_sql = this.sep() + properties_sql;
      } else if (!this.pretty) {
        properties_sql = ` ${properties_sql}`;
      }
    }

    const begin = expression.args.begin ? " BEGIN" : "";

    let expression_sql = this.sql(expression, "expression");
    if (expression_sql) {
      expression_sql = `${begin}${this.sep()}${expression_sql}`;

      if (
        !(expression.expression instanceof exp.MacroOverloads) &&
        (this.constructor.CREATE_FUNCTION_RETURN_AS || !(expression.expression instanceof exp.Return))
      ) {
        let postalias_props_sql = "";
        if (locHas(exp.Properties.Location.POST_ALIAS)) {
          postalias_props_sql = this.properties(
            new exp.Properties({ expressions: properties_locs.get(exp.Properties.Location.POST_ALIAS) }),
            "",
            ", ",
            "",
            false,
          );
        }
        postalias_props_sql = postalias_props_sql ? ` ${postalias_props_sql}` : "";
        expression_sql = ` AS${postalias_props_sql}${expression_sql}`;
      }
    }

    let postindex_props_sql = "";
    if (locHas(exp.Properties.Location.POST_INDEX)) {
      postindex_props_sql = this.properties(
        new exp.Properties({ expressions: properties_locs.get(exp.Properties.Location.POST_INDEX) }),
        " ",
        ", ",
        "",
        false,
      );
    }

    let indexes = this.expressions(expression, "indexes", { indent: false, sep: " " });
    indexes = indexes ? ` ${indexes}` : "";
    const index_sql = indexes + postindex_props_sql;

    const replace = expression.args.replace ? " OR REPLACE" : "";
    const refresh = expression.args.refresh ? " OR REFRESH" : "";
    const unique = expression.args.unique ? " UNIQUE" : "";

    const clustered = expression.args.clustered;
    let clustered_sql;
    if (clustered === null || clustered === undefined) {
      clustered_sql = "";
    } else if (clustered) {
      clustered_sql = " CLUSTERED COLUMNSTORE";
    } else {
      clustered_sql = " NONCLUSTERED COLUMNSTORE";
    }

    let postcreate_props_sql = "";
    if (locHas(exp.Properties.Location.POST_CREATE)) {
      postcreate_props_sql = this.properties(
        new exp.Properties({ expressions: properties_locs.get(exp.Properties.Location.POST_CREATE) }),
        " ",
        " ",
        "",
        false,
      );
    }

    const modifiers = [clustered_sql, replace, refresh, unique, postcreate_props_sql].join("");

    let postexpression_props_sql = "";
    if (locHas(exp.Properties.Location.POST_EXPRESSION)) {
      postexpression_props_sql = this.properties(
        new exp.Properties({ expressions: properties_locs.get(exp.Properties.Location.POST_EXPRESSION) }),
        " ",
        " ",
        "",
        false,
      );
    }

    const concurrently = expression.args.concurrently ? " CONCURRENTLY" : "";
    const exists_sql = expression.args.exists ? " IF NOT EXISTS" : "";
    const no_schema_binding = expression.args.no_schema_binding ? " WITH NO SCHEMA BINDING" : "";

    let clone = this.sql(expression, "clone");
    clone = clone ? ` ${clone}` : "";

    let properties_expression;
    if (this.constructor.EXPRESSION_PRECEDES_PROPERTIES_CREATABLES.has(kind)) {
      properties_expression = `${expression_sql}${properties_sql}`;
    } else {
      properties_expression = `${properties_sql}${expression_sql}`;
    }

    expression_sql = `CREATE${modifiers} ${kind}${concurrently}${exists_sql} ${this_}${properties_expression}${postexpression_props_sql}${index_sql}${no_schema_binding}${clone}`;
    return this.prepend_ctes(expression, expression_sql);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1440
  sequenceproperties_sql(expression) {
    let start = this.sql(expression, "start");
    start = start ? `START WITH ${start}` : "";
    let increment = this.sql(expression, "increment");
    increment = increment ? ` INCREMENT BY ${increment}` : "";
    let minvalue = this.sql(expression, "minvalue");
    minvalue = minvalue ? ` MINVALUE ${minvalue}` : "";
    let maxvalue = this.sql(expression, "maxvalue");
    maxvalue = maxvalue ? ` MAXVALUE ${maxvalue}` : "";
    let owned = this.sql(expression, "owned");
    owned = owned ? ` OWNED BY ${owned}` : "";

    const cache = expression.args.cache;
    let cache_str;
    if (cache === null || cache === undefined) cache_str = "";
    else if (cache === true) cache_str = " CACHE";
    // deny:implicit_str sqlglot/generator.py:1458 — `cache` here is a real `exp.Literal`
    // (`_parse_number() or True`), and Python's `f" CACHE {cache}"` invokes
    // `Expression.__str__` -> `self.sql()` with the DEFAULT dialect, not this
    // generator's own `this.dialect`; `kernelSql()` is that same base-dialect render.
    else cache_str = ` CACHE ${kernelSql(cache)}`;

    let options = this.expressions(expression, "options", { flat: true, sep: " " });
    options = options ? ` ${options}` : "";

    return `${start}${increment}${minvalue}${maxvalue}${cache_str}${options}${owned}`.trimStart();
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1465
  triggerproperties_sql(expression) {
    const timing = expression.args.timing || "";
    const events = (expression.args.events || []).map((event) => this.sql(event)).join(" OR ");
    const timing_events = timing || events ? `${timing} ${events}`.trim() : "";

    const parts = [timing_events, "ON", this.sql(expression, "table")];

    const referenced_table = expression.args.referenced_table;
    if (referenced_table) parts.push("FROM", this.sql(referenced_table));

    const deferrable = expression.args.deferrable;
    if (deferrable) parts.push(deferrable);

    const initially = expression.args.initially;
    if (initially) parts.push(`INITIALLY ${initially}`);

    const referencing = expression.args.referencing;
    if (referencing) parts.push(this.sql(referencing));

    const for_each = expression.args.for_each;
    if (for_each) parts.push(`FOR EACH ${for_each}`);

    const when = expression.args.when;
    if (when) parts.push(`WHEN (${this.sql(when)})`);

    parts.push(this.sql(expression, "execute"));

    return parts.join(this.sep());
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1494
  triggerreferencing_sql(expression) {
    const parts = [];

    const old_alias = expression.args.old;
    if (old_alias) parts.push(`OLD TABLE AS ${this.sql(old_alias)}`);

    const new_alias = expression.args.new;
    if (new_alias) parts.push(`NEW TABLE AS ${this.sql(new_alias)}`);

    return `REFERENCING ${parts.join(" ")}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1505
  triggerevent_sql(expression) {
    // deny:implicit_str sqlglot/generator.py:1508 -- `expression.this` is interpolated
    // raw, exactly as upstream does, not routed through `this.sql(...)`. The deny
    // scanner flags it generically as "could be an Expr arg", but `TriggerEvent.this`
    // is always a plain event-keyword string (`"INSERT"`/`"UPDATE"`/`"DELETE"`) set by
    // the parser, never an `Expr` node, so no `.sql()` call is needed here.
    const columns = expression.args.columns;
    if (columns) {
      return `${expression.this} OF ${this.expressions(expression, "columns", { flat: true })}`;
    }

    return this.sql(expression, "this");
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1512
  clone_sql(expression) {
    const this_ = this.sql(expression, "this");
    const shallow = expression.args.shallow ? "SHALLOW " : "";
    const keyword = expression.args.copy && this.constructor.SUPPORTS_TABLE_COPY ? "COPY" : "CLONE";
    return `${shallow}${keyword} ${this_}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1518
  describe_sql(expression) {
    let style = expression.args.style;
    style = style ? ` ${style}` : "";
    let partition = this.sql(expression, "partition");
    partition = partition ? ` ${partition}` : "";
    let format = this.sql(expression, "format");
    format = format ? ` ${format}` : "";
    const as_json = expression.args.as_json ? " AS JSON" : "";
    return `DESCRIBE${style}${format} ${this.sql(expression, "this")}${partition}${as_json}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1529
  heredoc_sql(expression) {
    const tag = this.sql(expression, "tag");
    return `$${tag}$${this.sql(expression, "this")}$${tag}$`;
  }

  /**
   * py: sqlglot/generator.py:1533
   * @param {exp.Expr} expression
   * @param {string} sql
   * @returns {string}
   */
  // py: sqlglot/generator.py:1533
  prepend_ctes(expression, sql) {
    const with_ = this.sql(expression, "with_");
    if (with_) sql = `${with_}${this.sep()}${sql}`;
    return sql;
  }

  /**
   * py: sqlglot/generator.py:1539
   * @param {exp.With} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:1539
  with_sql(expression) {
    let udfs = this.expressions(expression, "udfs", { flat: true });
    udfs = udfs ? `WITH ${udfs}` : "";

    let sql = this.expressions(expression, null, { flat: true });

    const recursive =
      this.constructor.CTE_RECURSIVE_KEYWORD_REQUIRED && expression.args.recursive
        ? "RECURSIVE "
        : "";
    let search = this.sql(expression, "search");
    search = search ? ` ${search}` : "";

    sql = sql ? `WITH ${recursive}${sql}${search}` : "";
    return udfs && sql ? `${udfs} ${sql}` : `${udfs}${sql}`;
  }

  /**
   * py: sqlglot/generator.py:1556
   * @param {exp.CTE} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:1556
  cte_sql(expression) {
    const alias = expression.args.alias;
    if (alias) alias.addComments(expression.popComments());

    const aliasSql = this.sql(expression, "alias");

    let materialized = expression.args.materialized;
    if (materialized === false) {
      materialized = "NOT MATERIALIZED ";
    } else if (materialized) {
      materialized = "MATERIALIZED ";
    }

    let key_expressions = this.expressions(expression, "key_expressions", { flat: true });
    key_expressions = key_expressions ? ` USING KEY (${key_expressions})` : "";

    return `${aliasSql}${key_expressions} AS ${materialized || ""}${this.wrap(expression)}`;
  }

  /**
   * py: sqlglot/generator.py:1574
   * @param {exp.TableAlias} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:1574
  tablealias_sql(expression) {
    let alias = this.sql(expression, "this");
    let columns = this.expressions(expression, "columns", { flat: true });
    columns = columns ? `(${columns})` : "";

    if (
      columns &&
      !this.constructor.SUPPORTS_TABLE_ALIAS_COLUMNS &&
      !(this.constructor.SUPPORTS_NAMED_CTE_COLUMNS && expression.parent instanceof exp.CTE)
    ) {
      columns = "";
      this.unsupported("Named columns are not supported in table alias.");
    }

    if (!alias && !this.dialect.UNNEST_COLUMN_ONLY) {
      alias = this._next_name();
    }

    return `${alias}${columns}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1592
  bitstring_sql(expression) {
    const this_ = this.sql(expression, "this");
    if (this.dialect.BIT_START) {
      return `${this.dialect.BIT_START}${this_}${this.dialect.BIT_END}`;
    }
    return `${parseInt(this_, 2)}`;
  }

  /**
   * `hexstring_sql(expression, binary_function_repr=None)`.
   *
   * First real caller is `generators/bigquery.js`'s `TRANSFORMS[exp.HexString]`
   * (`self.hexstring_sql(e, binary_function_repr="FROM_HEX")`), which is why this was a
   * stub until P5's BigQuery generator round.
   */
  // py: sqlglot/generator.py:1598
  hexstring_sql(expression, binary_function_repr = null) {
    const this_ = this.sql(expression, "this");
    const is_integer_type = expression.args.is_integer;

    if (
      (is_integer_type && !this.dialect.HEX_STRING_IS_INTEGER_TYPE)
      || (!this.dialect.HEX_START && !binary_function_repr)
    ) {
      return String(pyIntFromStrBase(this_, 16));
    }

    if (!is_integer_type) {
      if (binary_function_repr) {
        return this.func(binary_function_repr, exp.Literal.string(this_));
      }
      if (this.dialect.HEX_STRING_IS_INTEGER_TYPE) {
        this.unsupported("Unsupported transpilation from BINARY/BLOB hex string");
      }
    }

    return `${this.dialect.HEX_START}${this_}${this.dialect.HEX_END}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1623
  bytestring_sql(expression) {
    const this_ = this.sql(expression, "this");
    if (this.dialect.BYTE_START) {
      const escaped_byte_string = this.escape_str(this_, {
        escape_backslash: false,
        delimiter: this.dialect.BYTE_END,
        escaped_delimiter: this._escaped_byte_quote_end,
        is_byte_string: true,
      });
      const is_bytes = expression.args.is_bytes || false;
      const delimited_byte_string = `${this.dialect.BYTE_START}${escaped_byte_string}${this.dialect.BYTE_END}`;
      if (is_bytes && !this.dialect.BYTE_STRING_IS_BYTES_TYPE) {
        return this.sql(exp.cast(delimited_byte_string, exp.DType.BINARY, { dialect: this.dialect }));
      }
      if (!is_bytes && this.dialect.BYTE_STRING_IS_BYTES_TYPE) {
        return this.sql(exp.cast(delimited_byte_string, exp.DType.VARCHAR, { dialect: this.dialect }));
      }
      return delimited_byte_string;
    }

    if (this.dialect.tokenizer_class.STRING_ESCAPES.includes("\\")) {
      return this.sql(exp.Literal.string(this_));
    }

    this.unsupported(`Byte strings are not supported for ${this.dialect.constructor.name}`);
    return "";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1654
  unicodestring_sql(expression) {
    let this_ = this.sql(expression, "this");
    const escape = expression.args.escape;
    const unicode_start = this.dialect.UNICODE_START;

    let escape_substitute, left_quote, right_quote;
    if (unicode_start) {
      escape_substitute = "\\$1";
      left_quote = unicode_start;
      right_quote = this.dialect.UNICODE_END || "";
    } else {
      escape_substitute = "\\u$1";
      left_quote = this.dialect.QUOTE_START;
      right_quote = this.dialect.QUOTE_END;
    }

    let escape_pattern, escape_sql;
    if (escape) {
      escape_pattern = new RegExp(`${escape.name}(\\d+)`, "g");
      escape_sql = this.constructor.SUPPORTS_UESCAPE ? ` UESCAPE ${this.sql(escape)}` : "";
    } else {
      escape_pattern = ESCAPED_UNICODE_RE;
      escape_sql = "";
    }

    if (!unicode_start || (escape && !this.constructor.SUPPORTS_UESCAPE)) {
      this_ = this_.replace(escape_pattern, this.constructor.UNICODE_SUBSTITUTE || escape_substitute);
    }

    if (unicode_start) {
      // py: a Unicode literal only escapes its delimiter by doubling it; the escape
      // character introduces a code point, so the dialect's ordinary string escapes
      // don't apply here
      this_ = this._replace_line_breaks(this_).replaceAll(right_quote, right_quote.repeat(2));
    } else {
      this_ = this.escape_str(this_, { escape_backslash: false });
    }

    return `${left_quote}${this_}${right_quote}${escape_sql}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1685
  rawstring_sql(expression) {
    let string = expression.this;
    if (this.dialect.tokenizer_class.STRING_ESCAPES.includes("\\")) {
      string = string.replaceAll("\\", "\\\\");
    }

    string = this.escape_str(string, { escape_backslash: false });
    return `${this.dialect.QUOTE_START}${string}${this.dialect.QUOTE_END}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1693
  datatypeparam_sql(expression) {
    const this_ = this.sql(expression, "this");
    let specifier = this.sql(expression, "expression");
    specifier = specifier && this.constructor.DATA_TYPE_SPECIFIERS_ALLOWED ? ` ${specifier}` : "";
    return `${this_}${specifier}`;
  }

  /**
   * py: sqlglot/generator.py:1699
   * @param {exp.DataType} expression
   * @param {*} type_value
   * @param {number[]} defaults
   * @param {(number|null)[]} bounds
   * @returns {exp.DataType}
   */
  // py: sqlglot/generator.py:1699
  datatype_param_bound_limiter(expression, type_value, defaults, bounds) {
    const params = expression.expressions;

    if (!params.length) {
      if (defaults.length) {
        expression.set(
          "expressions",
          defaults.map((d) => new exp.DataTypeParam({ this: exp.Literal.number(d) })),
        );
      }
      return expression;
    }

    if (!bounds.length) return expression;

    for (let i = 0; i < params.length; i++) {
      const param = params[i];
      const bound = i < bounds.length ? bounds[i] : null;
      if (bound === null || bound === undefined) continue;

      const param_value = param instanceof exp.DataTypeParam ? param.this : param;
      let value = null;
      if (param_value instanceof exp.Literal && param_value.is_number) {
        const py = param_value.toPy();
        // py: `isinstance(value, (int, Decimal))`. `toPy()` returns a BigInt for an
        // int literal (this port's convention) or a `PyDecimal` for a float one; both
        // are compared against `bound` (a plain JS number) by converting to Number —
        // realistic type-param bounds (precision/scale) are always small, so this loses
        // no precision that would change the comparison outcome.
        if (typeof py === "bigint") value = Number(py);
        else if (py instanceof PyDecimal) value = Number(py.toString());
      }

      if (value !== null && value > bound) {
        this.unsupported(
          `${type_value.value} parameter ${param_value.name} exceeds ${this.dialect.constructor?.name}'s maximum of ${bound}; capping`,
        );
        params[i] = new exp.DataTypeParam({ this: exp.Literal.number(bound) });
      }
    }

    return expression;
  }

  /**
   * py: sqlglot/generator.py:1739
   *
   * `isinstance(type_value, exp.DType)` is `type_value?.__enum__ === "DType"`: `DType`
   * members are frozen plain objects (`expressions/focused_methods.js`), not class
   * instances, and `expression.this === exp.DType.CHAR`-style reference equality is
   * the port's established idiom for `==` between them (`src/parser.js` and
   * `expressions/builders.js:192` both do this).
   * @param {exp.DataType} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:1739
  datatype_sql(expression) {
    let nested = "";
    let values = "";

    const expr_nested = expression.args.nested;
    let type_value = expression.this;
    const cls = this.constructor;
    const is_dtype = type_value != null && type_value.__enum__ === "DType";

    if (!expr_nested && is_dtype) {
      const settings = cls.TYPE_PARAM_SETTINGS.get(type_value);
      if (settings) {
        expression = this.datatype_param_bound_limiter(expression, type_value, ...settings);
      }
    }

    const interior =
      expr_nested && this.pretty
        ? this.expressions(expression, null, { dynamic: true, new_line: true, skip_first: true, skip_last: true })
        : this.expressions(expression, null, { flat: true });

    if (cls.UNSUPPORTED_TYPES.has(type_value)) {
      this.unsupported(
        `Data type ${type_value.value} is not supported when targeting ${this.dialect.constructor?.name}`,
      );
    }

    let type_sql = "";
    if (type_value === exp.DType.USERDEFINED && expression.args.kind) {
      type_sql = this.sql(expression, "kind");
    } else if (type_value === exp.DType.CHARACTER_SET) {
      return `CHAR CHARACTER SET ${this.sql(expression, "kind")}`;
    } else {
      // py: `else: type_sql = type_value` — `type_value` here is an actual Expr (e.g.
      // an `exp.Interval` DataType.this, for `INTERVAL DAY`), not a `DType` enum
      // member. Upstream's later `f"{type_sql}{nested}{values}"` implicitly calls
      // `Expression.__str__`, which is `self.sql()` (core.py:1237) — a bare JS
      // template literal calls `.toString()` instead (this port's verbose debug repr),
      // so this must be `this.sql(type_value)`, not the raw object. Found via a real
      // Postgres `CAST('45 days' AS INTERVAL DAY)` corpus mismatch
      // (PORT_PLAN.md, the Postgres generator step).
      type_sql = is_dtype ? (cls.TYPE_MAPPING.get(type_value) ?? type_value.value) : this.sql(type_value);
    }

    if (interior) {
      if (expr_nested) {
        nested = `${cls.STRUCT_DELIMITER[0]}${interior}${cls.STRUCT_DELIMITER[1]}`;
        if (expression.args.values !== null && expression.args.values !== undefined) {
          const delimiters = type_value === exp.DType.ARRAY ? ["[", "]"] : ["(", ")"];
          values = this.expressions(expression, "values", { flat: true });
          values = `${delimiters[0]}${values}${delimiters[1]}`;
        }
      } else if (type_value === exp.DType.INTERVAL) {
        nested = ` ${interior}`;
      } else {
        nested = `(${interior})`;
      }
    }

    type_sql = `${type_sql}${nested}${values}`;
    if (
      cls.TZ_TO_WITH_TIME_ZONE &&
      (type_value === exp.DType.TIMETZ || type_value === exp.DType.TIMESTAMPTZ)
    ) {
      type_sql = `${type_sql} WITH TIME ZONE`;
    }

    const collate = this.sql(expression, "collate");
    if (collate) type_sql = `${type_sql} COLLATE ${collate}`;

    return type_sql;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1803
  directory_sql(expression) {
    const local = expression.args.local ? "LOCAL " : "";
    let row_format = this.sql(expression, "row_format");
    row_format = row_format ? ` ${row_format}` : "";
    return `${local}DIRECTORY ${this.sql(expression, "this")}${row_format}`;
  }

  /**
   * py: sqlglot/generator.py:1809
   * @param {exp.Delete} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:1809
  delete_sql(expression) {
    const hint = this.sql(expression, "hint");
    let this_ = this.sql(expression, "this");
    this_ = this_ ? ` FROM ${this_}` : "";
    let using = this.expressions(expression, "using");
    using = using ? ` USING ${using}` : "";
    let cluster = this.sql(expression, "cluster");
    cluster = cluster ? ` ${cluster}` : "";
    const where = this.sql(expression, "where");
    const returning = this.sql(expression, "returning");
    const order = this.sql(expression, "order");
    const limit = this.sql(expression, "limit");
    let tables = this.expressions(expression, "tables");
    tables = tables ? ` ${tables}` : "";
    let expression_sql;
    if (this.constructor.RETURNING_END) {
      expression_sql = `${this_}${using}${cluster}${where}${returning}${order}${limit}`;
    } else {
      expression_sql = `${returning}${this_}${using}${cluster}${where}${order}${limit}`;
    }
    return this.prepend_ctes(expression, `DELETE${hint}${tables}${expression_sql}`);
  }

  /**
   * py: sqlglot/generator.py:1829
   * @param {exp.Drop} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:1829
  drop_sql(expression) {
    // deny:implicit_str sqlglot/generator.py:1852 -- `kind` is interpolated raw,
    // exactly as upstream does, not routed through `this.sql(...)`. The deny scanner
    // flags it generically as "could be an Expr arg" (every name the final f-string
    // substitutes), but `kind` specifically is mapped through
    // `this.dialect.INVERSE_CREATABLE_KIND_MAPPING` two lines below, which only ever
    // holds/returns keyword strings (e.g. `"TABLE"`/`"VIEW"`), never an `Expr` node;
    // every other name in that f-string (`temporary`/`materialized`/`iceberg`/.../
    // `force`) is a literal JS string built from a boolean check below, not an
    // `.args.get(...)` passthrough, so none of them is a candidate either.
    const tables = this.expressions(expression, "tables", { flat: true });
    let expressions = this.expressions(expression, null, { flat: true });
    expressions = expressions ? ` (${expressions})` : "";
    let kind = expression.args.kind;
    kind = this.dialect.INVERSE_CREATABLE_KIND_MAPPING.get(kind) || kind;
    const iceberg =
      expression.args.iceberg && this.constructor.SUPPORTS_DROP_ALTER_ICEBERG_PROPERTY
        ? " ICEBERG"
        : "";
    const exists_sql = expression.args.exists ? " IF EXISTS " : " ";
    const concurrently_sql = expression.args.concurrently ? " CONCURRENTLY" : "";
    let on_cluster = this.sql(expression, "cluster");
    on_cluster = on_cluster ? ` ${on_cluster}` : "";
    const temporary = expression.args.temporary ? " TEMPORARY" : "";
    const materialized = expression.args.materialized ? " MATERIALIZED" : "";
    const cascade = expression.args.cascade ? " CASCADE" : "";
    const restrict = expression.args.restrict ? " RESTRICT" : "";
    const constraints = expression.args.constraints ? " CONSTRAINTS" : "";
    const purge = expression.args.purge ? " PURGE" : "";
    const sync = expression.args.sync ? " SYNC" : "";
    const force = expression.args.force ? " FORCE" : "";
    return `DROP${temporary}${materialized}${iceberg} ${kind}${concurrently_sql}${exists_sql}${tables}${on_cluster}${expressions}${cascade}${restrict}${constraints}${purge}${sync}${force}`;
  }

  // py: sqlglot/generator.py:1854 — ported alongside `generators/postgres.js`
  // (PORT_PLAN.md P4): `TRANSFORMS[exp.Union]` was a `TODO lambda` placeholder (no
  // dispatch entry at all — `Unsupported expression type Union`, not merely wrong
  // output), and a plain `WITH RECURSIVE ... UNION ...` corpus row reached it, so
  // `set_operations` below needed this too.
  set_operation(expression) {
    const op_type = expression.constructor;
    const op_name = op_type.key.toUpperCase();

    let distinct = expression.args.distinct;
    if (
      distinct === false
      && (op_type === exp.Except || op_type === exp.Intersect)
      && !this.constructor.EXCEPT_INTERSECT_SUPPORT_ALL_CLAUSE
    ) {
      this.unsupported(`${op_name} ALL is not supported`);
    }

    const default_distinct = this.dialect.SET_OP_DISTINCT_BY_DEFAULT.get(op_type);

    if (distinct === null || distinct === undefined) {
      distinct = default_distinct;
      if (distinct === null || distinct === undefined) {
        this.unsupported(`${op_name} requires DISTINCT or ALL to be specified`);
      }
    }

    const distinct_or_all = distinct === default_distinct ? "" : (distinct ? " DISTINCT" : " ALL");

    let side_kind = [expression.side, expression.kind].filter(Boolean).join(" ");
    side_kind = side_kind ? `${side_kind} ` : "";

    const by_name = expression.args.by_name ? " BY NAME" : "";
    let on = this.expressions(expression, "on", { flat: true });
    on = on ? ` ON (${on})` : "";

    return `${side_kind}${op_name}${distinct_or_all}${by_name}${on}`;
  }

  // py: sqlglot/generator.py:1887 — same caller as `set_operation` above.
  set_operations(expression) {
    if (!this.constructor.SET_OP_MODIFIERS) {
      const limit = expression.args.limit;
      const order = expression.args.order;

      if (limit || order) {
        let select = this._move_ctes_to_top_level(
          exp.subquery(expression, "_l_0", { copy: false }).select("*", { copy: false }),
        );

        if (limit) select = select.limit(limit.pop(), { copy: false });
        if (order) select = select.order_by(order.pop(), { copy: false });
        return this.sql(select);
      }
    }

    const sqls = [];
    const stack = [expression];

    while (stack.length) {
      const node = stack.pop();

      if (node instanceof exp.SetOperation) {
        stack.push(node.expression);
        stack.push(this.maybe_comment(this.set_operation(node), null, { comments: node.comments, separated: true }));
        stack.push(node.this);
      } else {
        sqls.push(this.sql(node));
      }
    }

    let this_ = sqls.join(this.sep());
    this_ = this.query_modifiers(expression, this_);
    return this.prepend_ctes(expression, this_);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1924
  // py: sqlglot/generator.py:1924
  fetch_sql(expression) {
    let direction = expression.args.direction;
    direction = direction ? ` ${direction}` : "";
    let count = this.sql(expression, "count");
    count = count ? ` ${count}` : "";
    let limit_options = this.sql(expression, "limit_options");
    limit_options = limit_options ? `${limit_options}` : " ROWS ONLY";
    return `${this.seg("FETCH")}${direction}${count}${limit_options}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1933
  // py: sqlglot/generator.py:1933
  limitoptions_sql(expression) {
    const percent = expression.args.percent ? " PERCENT" : "";
    const rows = expression.args.rows ? " ROWS" : "";
    let with_ties = expression.args.with_ties ? " WITH TIES" : "";
    if (!with_ties && rows) {
      with_ties = " ONLY";
    }
    return `${percent}${rows}${with_ties}`;
  }

  /**
   * py: sqlglot/generator.py:1941
   * @param {exp.Filter} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:1941
  filter_sql(expression) {
    const this_ = this.sql(expression, "this");
    const where = pyStrip(this.sql(expression, "expression"));
    return `${this_} FILTER(${where})`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1946
  hint_sql(expression) {
    if (!this.constructor.QUERY_HINTS) {
      this.unsupported("Hints are not supported");
      return "";
    }
    return ` /*+ ${pyStrip(this.expressions(expression, null, { sep: this.constructor.QUERY_HINT_SEP }))} */`;
  }

  /**
   * py: sqlglot/generator.py:1953
   * @param {exp.IndexParameters} expression
   * @returns {string}
   */
  indexparameters_sql(expression) {
    let using = this.sql(expression, "using");
    using = using ? ` USING ${using}` : "";
    let columns = this.expressions(expression, "columns", { flat: true });
    columns = columns ? `(${columns})` : "";
    let partition_by = this.expressions(expression, "partition_by", { flat: true });
    partition_by = partition_by ? ` PARTITION BY ${partition_by}` : "";
    const where = this.sql(expression, "where");
    let include = this.expressions(expression, "include", { flat: true });
    if (include) {
      include = ` INCLUDE (${include})`;
    }
    let with_storage = this.expressions(expression, "with_storage", { flat: true });
    with_storage = with_storage ? ` WITH (${with_storage})` : "";
    let tablespace = this.sql(expression, "tablespace");
    tablespace = tablespace ? ` USING INDEX TABLESPACE ${tablespace}` : "";
    let on = this.sql(expression, "on");
    on = on ? ` ON ${on}` : "";

    return `${using}${columns}${include}${with_storage}${tablespace}${partition_by}${where}${on}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1973
  index_sql(expression) {
    const unique = expression.args.unique ? "UNIQUE " : "";
    const primary = expression.args.primary ? "PRIMARY " : "";
    const amp = expression.args.amp ? "AMP " : "";
    let name = this.sql(expression, "this");
    name = name ? `${name} ` : "";
    let table = this.sql(expression, "table");
    table = table ? `${this.constructor.INDEX_ON} ${table}` : "";

    const index = table ? "" : "INDEX ";

    const params = this.sql(expression, "params");
    return `${unique}${primary}${amp}${index}${name}${table}${params}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:1987
  dynamicidentifier_sql(expression) {
    const this_ = expression.this;
    if (this_ && this_.is_string) {
      const resolved = exp.maybeParse(this_.name).sql(this.dialect);
      if (Object.hasOwn(expression.args, "expressions")) {
        this.unsupported(
          "Transpiling dynamically-invoked IDENTIFIER() functions is unsupported",
        );
      }
      return resolved;
    }
    this.unsupported("IDENTIFIER() with non-literal arguments is not supported");
    return this.func("IDENTIFIER", this_);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2001
  identifier_sql(expression) {
    let text = expression.name;
    // py: `text.lower()` — `pyLower`, NOT `toLowerCase()`. Node's own lowercasing maps 67
    // code points CPython 3.9.25 does not, and BOTH uses below are output-visible: `text`
    // when `normalize` is set, and the `RESERVED_KEYWORDS` membership test that decides
    // whether to quote. This is the caller R20 named when it deferred `pyLower` to P4.
    const lower = pyLower(text);
    const quoted = expression.quoted;
    text = this.normalize && !quoted ? lower : text;
    // py: `str.replace` is replace-ALL. `split`/`join` rather than `replaceAll` because
    // `replaceAll`'s replacement string honours `$&`/`$1`/`$$` patterns and Python's does
    // not; `_escaped_identifier_end` is dialect-supplied, so a `$` in it would silently
    // corrupt the output rather than being inserted literally.
    text = text.split(this._identifier_end).join(this._escaped_identifier_end);
    if (
      quoted ||
      this.dialect.can_quote(expression, this.identify) ||
      // Rule 1: a `static` field is NOT visible as `this.X` from an instance method — it
      // reads back `undefined`, so `this.RESERVED_KEYWORDS.has(...)` would throw. Going
      // through `this.constructor` also keeps a dialect subclass's override honoured.
      this.constructor.RESERVED_KEYWORDS.has(lower) ||
      // py: `text[:1].isdigit()`. Rule 3: by CODE POINT, so not `text[0]`, which would
      // hand a lone surrogate half to the predicate. `cpSlice` and NOT `cpAt`, because
      // `text[:1]` is a SLICE: Python slices clamp and yield "" for an empty string,
      // whereas an INDEX raises — and `cpAt` faithfully reproduces the raising kind, so
      // `cpAt(text, 0)` threw `PyIndexError` on `Identifier(this="")`. `pyIsDigit("")` is
      // false, matching `"".isdigit()`, so "" then needs no separate guard.
      (!this.dialect.IDENTIFIERS_CAN_START_WITH_DIGIT && pyIsDigit(cpSlice(text, 0, 1)))
    ) {
      text = `${this._identifier_start}${this._replace_line_breaks(text)}${this._identifier_end}`;
    }
    return text;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2018
  hex_sql(expression) {
    let text = this.func(this.constructor.HEX_FUNC, this.sql(expression, "this"));
    if (this.dialect.HEX_LOWERCASE) {
      text = this.func("LOWER", text);
    }
    return text;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2025
  lowerhex_sql(expression) {
    let text = this.func(this.constructor.HEX_FUNC, this.sql(expression, "this"));
    if (!this.dialect.HEX_LOWERCASE) text = this.func("LOWER", text);
    return text;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2031
  inputoutputformat_sql(expression) {
    let input_format = this.sql(expression, "input_format");
    input_format = input_format ? `INPUTFORMAT ${input_format}` : "";
    let output_format = this.sql(expression, "output_format");
    output_format = output_format ? `OUTPUTFORMAT ${output_format}` : "";
    return [input_format, output_format].join(this.sep());
  }

  /**
   * py: sqlglot/generator.py:2038 `national_sql(self, expression, prefix="N")`
   * @param {exp.National} expression
   * @param {string} [prefix]
   * @returns {string}
   */
  // py: sqlglot/generator.py:2038
  national_sql(expression, prefix = "N") {
    const string = this.sql(exp.Literal.string(expression.name));
    return `${prefix}${string}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2042
  partition_sql(expression) {
    const partition_keyword = expression.args.subpartition ? "SUBPARTITION" : "PARTITION";
    return `${partition_keyword}(${this.expressions(expression, null, { flat: true })})`;
  }

  /**
   * py: sqlglot/generator.py:2046
   * @param {exp.Properties} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:2046
  properties_sql(expression) {
    const root_properties = [];
    const with_properties = [];

    for (const p of expression.expressions) {
      const p_loc = this.constructor.PROPERTIES_LOCATION.get(p.constructor);
      if (p_loc === undefined) throw new PyKeyError(p.constructor.name);
      if (p_loc === exp.Properties.Location.POST_WITH) {
        with_properties.push(p);
      } else if (p_loc === exp.Properties.Location.POST_SCHEMA) {
        root_properties.push(p);
      }
    }

    const root_props_ast = new exp.Properties({ expressions: root_properties });
    root_props_ast.parent = expression.parent;

    const with_props_ast = new exp.Properties({ expressions: with_properties });
    with_props_ast.parent = expression.parent;

    const root_props = this.root_properties(root_props_ast);
    let with_props = this.with_properties(with_props_ast);

    if (root_props && with_props && !this.pretty) with_props = " " + with_props;

    return root_props + with_props;
  }

  /**
   * py: sqlglot/generator.py:2071
   * @param {exp.Properties} properties
   * @returns {string}
   */
  // py: sqlglot/generator.py:2071
  root_properties(properties) {
    if (properties.expressions.length) {
      return this.expressions(properties, null, { indent: false, sep: " " });
    }
    return "";
  }

  /**
   * py: sqlglot/generator.py:2076 `properties(properties, prefix="", sep=", ", suffix="", wrapped=True)`
   * @param {exp.Properties} properties
   * @param {string} [prefix]
   * @param {string} [sep]
   * @param {string} [suffix]
   * @param {boolean} [wrapped]
   * @returns {string}
   */
  // py: sqlglot/generator.py:2076
  properties(properties, prefix = "", sep = ", ", suffix = "", wrapped = true) {
    if (properties.expressions.length) {
      let expressions = this.expressions(properties, null, { sep, indent: false });
      if (expressions) {
        expressions = wrapped ? this.wrap(expressions) : expressions;
        return `${prefix}${pyStrip(prefix) ? " " : ""}${expressions}${suffix}`;
      }
    }
    return "";
  }

  /**
   * py: sqlglot/generator.py:2091
   * @param {exp.Properties} properties
   * @returns {string}
   */
  // py: sqlglot/generator.py:2091
  with_properties(properties) {
    return this.properties(properties, this.seg(this.constructor.WITH_PROPERTIES_PREFIX, ""));
  }

  /**
   * py: sqlglot/generator.py:2094
   * @param {exp.Properties} properties
   * @returns {Map}
   */
  // py: sqlglot/generator.py:2094
  locate_properties(properties) {
    const properties_locs = new Map();
    for (const p of properties.expressions) {
      const p_loc = this.constructor.PROPERTIES_LOCATION.get(p.constructor);
      if (p_loc === undefined) throw new PyKeyError(p.constructor.name);
      if (p_loc !== exp.Properties.Location.UNSUPPORTED) {
        if (!properties_locs.has(p_loc)) properties_locs.set(p_loc, []);
        properties_locs.get(p_loc).push(p);
      } else {
        this.unsupported(`Unsupported property ${p.key}`);
      }
    }
    return properties_locs;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2105
  property_name(expression, string_key = false) {
    if (expression.this instanceof exp.Dot) return this.sql(expression, "this");
    return string_key ? `'${expression.name}'` : expression.name;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2110
  property_sql(expression) {
    // One of `sql()`'s only two fallbacks, so it is machinery rather than stub-queue
    // scope even though it is a `*_sql` method.
    const property_cls = expression.constructor;
    if (property_cls === exp.Property) {
      return `${this.property_name(expression)}=${this.sql(expression, "value")}`;
    }

    const property_name = exp.Properties.PROPERTY_TO_NAME.get(property_cls);
    if (!property_name) this.unsupported(`Unsupported property ${expression.constructor.key}`);

    // py: `f"{property_name}=..."` where a missed `dict.get` gave `None`, and an
    // f-string renders that as the four characters "None". JS would interpolate
    // "undefined", so the fallback is spelled out. NOT a defensive default — it is a
    // reachable path with observable output: `StorageHandlerProperty`,
    // `SerdeProperties`, `PartitionByListProperty` and `RowFormatSerdeProperty` are all
    // absent from PROPERTY_TO_NAME and have no `*_sql`, so they land here and CPython
    // really does emit `None='x'`.
    return `${property_name ?? "None"}=${this.sql(expression, "this")}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2121
  uuidproperty_sql(expression) {
    return `UUID ${this.sql(expression, "this")}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2124
  likeproperty_sql(expression) {
    if (this.constructor.SUPPORTS_CREATE_TABLE_LIKE) {
      let options = expression.expressions.map((e) => `${e.name} ${this.sql(e, "value")}`).join(" ");
      options = options ? ` ${options}` : "";

      let like = `LIKE ${this.sql(expression, "this")}${options}`;
      if (this.constructor.LIKE_PROPERTY_INSIDE_SCHEMA && !(expression.parent instanceof exp.Schema)) {
        like = `(${like})`;
      }

      return like;
    }

    if (expression.expressions.length) {
      this.unsupported("Transpilation of LIKE property options is unsupported");
    }

    const select = exp.select("*").from_(expression.this).limit(0);
    return `AS ${this.sql(select)}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2141
  fallbackproperty_sql(expression) {
    const no = expression.args.no ? "NO " : "";
    const protection = expression.args.protection ? " PROTECTION" : "";
    return `${no}FALLBACK${protection}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2146
  journalproperty_sql(expression) {
    const no = expression.args.no ? "NO " : "";
    let local = expression.args.local;
    local = local ? `${local} ` : "";
    const dual = expression.args.dual ? "DUAL " : "";
    const before = expression.args.before ? "BEFORE " : "";
    const after = expression.args.after ? "AFTER " : "";
    return `${no}${local}${dual}${before}${after}JOURNAL`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2155
  freespaceproperty_sql(expression) {
    const freespace = this.sql(expression, "this");
    const percent = expression.args.percent ? " PERCENT" : "";
    return `FREESPACE=${freespace}${percent}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2160
  checksumproperty_sql(expression) {
    let property;
    if (expression.args.default) {
      property = "DEFAULT";
    } else if (expression.args.on) {
      property = "ON";
    } else {
      property = "OFF";
    }
    return `CHECKSUM=${property}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2169
  mergeblockratioproperty_sql(expression) {
    if (expression.args.no) return "NO MERGEBLOCKRATIO";
    if (expression.args.default) return "DEFAULT MERGEBLOCKRATIO";

    const percent = expression.args.percent ? " PERCENT" : "";
    return `MERGEBLOCKRATIO=${this.sql(expression, "this")}${percent}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2178
  moduleproperty_sql(expression) {
    let expressions = this.expressions(expression, null, { flat: true });
    expressions = expressions ? `(${expressions})` : "";
    return `USING ${this.sql(expression, "this")}${expressions}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2183
  datablocksizeproperty_sql(expression) {
    const default_ = expression.args.default;
    const minimum = expression.args.minimum;
    const maximum = expression.args.maximum;
    if (default_ || minimum || maximum) {
      let prop;
      if (default_) {
        prop = "DEFAULT";
      } else if (minimum) {
        prop = "MINIMUM";
      } else {
        prop = "MAXIMUM";
      }
      return `${prop} DATABLOCKSIZE`;
    }
    let units = expression.args.units;
    units = units ? ` ${units}` : "";
    return `DATABLOCKSIZE=${this.sql(expression, "size")}${units}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2199
  blockcompressionproperty_sql(expression) {
    const autotemp = expression.args.autotemp;
    const always = expression.args.always;
    const default_ = expression.args.default;
    const manual = expression.args.manual;
    const never = expression.args.never;

    let prop;
    if (autotemp !== null && autotemp !== undefined) {
      prop = `AUTOTEMP(${this.expressions(autotemp)})`;
    } else if (always) {
      prop = "ALWAYS";
    } else if (default_) {
      prop = "DEFAULT";
    } else if (manual) {
      prop = "MANUAL";
    } else if (never) {
      prop = "NEVER";
    }
    return `BLOCKCOMPRESSION=${prop}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2218
  isolatedloadingproperty_sql(expression) {
    let no = expression.args.no;
    no = no ? " NO" : "";
    let concurrent = expression.args.concurrent;
    concurrent = concurrent ? " CONCURRENT" : "";
    let target = this.sql(expression, "target");
    target = target ? ` ${target}` : "";
    return `WITH${no}${concurrent} ISOLATED LOADING${target}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2227
  partitionboundspec_sql(expression) {
    if (Array.isArray(expression.this)) {
      return `IN (${this.expressions(expression, "this", { flat: true })})`;
    }
    if (expression.this) {
      const modulus = this.sql(expression, "this");
      const remainder = this.sql(expression, "expression");
      return `WITH (MODULUS ${modulus}, REMAINDER ${remainder})`;
    }

    const from_expressions = this.expressions(expression, "from_expressions", { flat: true });
    const to_expressions = this.expressions(expression, "to_expressions", { flat: true });
    return `FROM (${from_expressions}) TO (${to_expressions})`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2239
  // py: sqlglot/generator.py:2239
  partitionedofproperty_sql(expression) {
    const this_ = this.sql(expression, "this");

    let for_values_or_default = expression.expression;
    if (for_values_or_default instanceof exp.PartitionBoundSpec) {
      for_values_or_default = ` FOR VALUES ${this.sql(for_values_or_default)}`;
    } else {
      for_values_or_default = " DEFAULT";
    }

    return `PARTITION OF ${this_}${for_values_or_default}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2250
  lockingproperty_sql(expression) {
    // deny:implicit_str sqlglot/generator.py:2257 -- `kind`, `for_or_in`, and
    // `lock_type` are interpolated raw, exactly as upstream does, not routed through
    // `this.sql(...)`. The deny scanner flags them generically as "could be Expr args",
    // but `LockingProperty`'s `kind`/`for_or_in`/`lock_type` are always parser-set
    // keyword strings (e.g. `"ROW"`/`"FOR"`/`"SHARE"`), never `Expr` nodes.
    const kind = expression.args.kind;
    const this_ = expression.this ? ` ${this.sql(expression, "this")}` : "";
    let for_or_in = expression.args.for_or_in;
    for_or_in = for_or_in ? ` ${for_or_in}` : "";
    const lock_type = expression.args.lock_type;
    const override = expression.args.override ? " OVERRIDE" : "";
    return `LOCKING ${kind}${this_}${for_or_in} ${lock_type}${override}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2259
  withdataproperty_sql(expression) {
    const data_sql = `WITH ${expression.args.no ? "NO " : ""}DATA`;
    const statistics = expression.args.statistics;
    let statistics_sql = "";
    if (statistics !== null && statistics !== undefined) {
      statistics_sql = ` AND ${!statistics ? "NO " : ""}STATISTICS`;
    }
    return `${data_sql}${statistics_sql}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2267
  withsystemversioningproperty_sql(expression) {
    let this_ = this.sql(expression, "this");
    this_ = this_ ? `HISTORY_TABLE=${this_}` : "";
    let data_consistency = this.sql(expression, "data_consistency");
    data_consistency = data_consistency ? `DATA_CONSISTENCY_CHECK=${data_consistency}` : null;
    let retention_period = this.sql(expression, "retention_period");
    retention_period = retention_period ? `HISTORY_RETENTION_PERIOD=${retention_period}` : null;

    let on_sql;
    if (this_) {
      on_sql = this.func("ON", this_, data_consistency, retention_period);
    } else {
      on_sql = expression.args.on ? "ON" : "OFF";
    }

    const sql = `SYSTEM_VERSIONING=${on_sql}`;

    return expression.args.with_ ? `WITH(${sql})` : sql;
  }

  /**
   * py: sqlglot/generator.py:2288
   * @param {exp.Insert} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:2288
  insert_sql(expression) {
    const hint = this.sql(expression, "hint");
    const overwrite = expression.args.overwrite;

    let this_;
    if (expression.this instanceof exp.Directory) {
      this_ = overwrite ? " OVERWRITE" : " INTO";
    } else {
      this_ = overwrite ? this.constructor.INSERT_OVERWRITE : " INTO";
    }

    let stored = this.sql(expression, "stored");
    stored = stored ? ` ${stored}` : "";
    let alternative = expression.args.alternative;
    alternative = alternative ? ` OR ${alternative}` : "";
    const ignore = expression.args.ignore ? " IGNORE" : "";
    const is_function = expression.args.is_function;
    if (is_function) this_ = `${this_} FUNCTION`;
    this_ = `${this_} ${this.sql(expression, "this")}`;

    const exists = expression.args.exists ? " IF EXISTS" : "";
    let where = this.sql(expression, "where");
    where = where ? `${this.sep()}REPLACE WHERE ${where}` : "";
    let using = this.expressions(expression, "using", { flat: true });
    using = using ? `${this.sep()}REPLACE USING (${using})` : "";
    let expression_sql = `${this.sep()}${this.sql(expression, "expression")}`;
    let on_conflict = this.sql(expression, "conflict");
    on_conflict = on_conflict ? ` ${on_conflict}` : "";
    const by_name = expression.args.by_name ? " BY NAME" : "";
    const default_values = expression.args.default ? "DEFAULT VALUES" : "";
    const returning = this.sql(expression, "returning");

    if (this.constructor.RETURNING_END) {
      expression_sql = `${expression_sql}${on_conflict}${default_values}${returning}`;
    } else {
      expression_sql = `${returning}${expression_sql}${on_conflict}`;
    }

    let partition_by = this.sql(expression, "partition");
    partition_by = partition_by ? ` ${partition_by}` : "";
    let settings = this.sql(expression, "settings");
    settings = settings ? ` ${settings}` : "";

    let source = this.sql(expression, "source");
    source = source ? `TABLE ${source}` : "";

    const sql = `INSERT${hint}${alternative}${ignore}${this_}${stored}${by_name}${exists}${partition_by}${settings}${where}${using}${expression_sql}${source}`;
    return this.prepend_ctes(expression, sql);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2335
  introducer_sql(expression) {
    return `${this.sql(expression, "this")} ${this.sql(expression, "expression")}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2338
  kill_sql(expression) {
    let kind = this.sql(expression, "kind");
    kind = kind ? ` ${kind}` : "";
    let this_ = this.sql(expression, "this");
    this_ = this_ ? ` ${this_}` : "";
    return `KILL${kind}${this_}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2345
  pseudotype_sql(expression) {
    return expression.name;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2348
  objectidentifier_sql(expression) { return expression.name; }

  /** @returns {*} */
  // py: sqlglot/generator.py:2351
  // py: sqlglot/generator.py:2351
  onconflict_sql(expression) {
    const conflict = expression.args.duplicate ? "ON DUPLICATE KEY" : "ON CONFLICT";

    let constraint = this.sql(expression, "constraint");
    constraint = constraint ? ` ON CONSTRAINT ${constraint}` : "";

    let conflict_keys = this.expressions(expression, "conflict_keys", { flat: true });
    if (conflict_keys) {
      conflict_keys = `(${conflict_keys})`;
    }

    const index_predicate = this.sql(expression, "index_predicate");
    conflict_keys = `${conflict_keys}${index_predicate} `;

    const action = this.sql(expression, "action");

    let expressions = this.expressions(expression, null, { flat: true });
    if (expressions) {
      const set_keyword = this.constructor.DUPLICATE_KEY_UPDATE_WITH_SET ? "SET " : "";
      expressions = ` ${set_keyword}${expressions}`;
    }

    const where = this.sql(expression, "where");
    return `${conflict}${constraint}${conflict_keys}${action}${expressions}${where}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2374
  // py: sqlglot/generator.py:2374
  returning_sql(expression) {
    return `${this.seg("RETURNING")} ${this.expressions(expression, null, { flat: true })}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2377
  rowformatdelimitedproperty_sql(expression) {
    let fields = this.sql(expression, "fields");
    fields = fields ? ` FIELDS TERMINATED BY ${fields}` : "";
    let escaped = this.sql(expression, "escaped");
    escaped = escaped ? ` ESCAPED BY ${escaped}` : "";
    let items = this.sql(expression, "collection_items");
    items = items ? ` COLLECTION ITEMS TERMINATED BY ${items}` : "";
    let keys = this.sql(expression, "map_keys");
    keys = keys ? ` MAP KEYS TERMINATED BY ${keys}` : "";
    let lines = this.sql(expression, "lines");
    lines = lines ? ` LINES TERMINATED BY ${lines}` : "";
    let null_ = this.sql(expression, "null");
    null_ = null_ ? ` NULL DEFINED AS ${null_}` : "";
    return `ROW FORMAT DELIMITED${fields}${escaped}${items}${keys}${lines}${null_}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2392
  // py: sqlglot/generator.py:2392
  withtablehint_sql(expression) {
    return `WITH (${this.expressions(expression, null, { flat: true })})`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2395
  indextablehint_sql(expression) {
    const this_ = `${this.sql(expression, "this")} INDEX`;
    let target = this.sql(expression, "target");
    target = target ? ` FOR ${target}` : "";
    return `${this_}${target} (${this.expressions(expression, null, { flat: true })})`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2401
  historicaldata_sql(expression) {
    const this_ = this.sql(expression, "this");
    const kind = this.sql(expression, "kind");
    const expr = this.sql(expression, "expression");
    return `${this_} (${kind} => ${expr})`;
  }

  /**
   * py: sqlglot/generator.py:2407
   * @param {exp.Table} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:2407
  table_parts(expression) {
    const parts = [expression.args.catalog, expression.args.db, expression.args.this];
    return parts.filter((part) => part !== null && part !== undefined).map((part) => this.sql(part)).join(".");
  }

  /**
   * py: sqlglot/generator.py:2418 `table_sql(expression, sep=" AS ")`
   * @param {exp.Table} expression
   * @param {string} [sep]
   * @returns {string}
   */
  // py: sqlglot/generator.py:2418
  table_sql(expression, sep = " AS ") {
    let table = this.table_parts(expression);
    const only = expression.args.only ? "ONLY " : "";
    let partition = this.sql(expression, "partition");
    partition = partition ? ` ${partition}` : "";
    let version = this.sql(expression, "version");
    version = version ? ` ${version}` : "";
    let alias = this.sql(expression, "alias");
    alias = alias ? `${sep}${alias}` : "";

    const sample = this.sql(expression, "sample");
    let post_alias = "";
    let pre_alias = "";

    if (this.dialect.ALIAS_POST_TABLESAMPLE) {
      pre_alias = sample;
    } else {
      post_alias = sample;
    }

    if (this.dialect.ALIAS_POST_VERSION) {
      pre_alias = `${pre_alias}${version}`;
    } else {
      post_alias = `${post_alias}${version}`;
    }

    let hints = this.expressions(expression, "hints", { sep: " " });
    hints = hints && this.constructor.TABLE_HINTS ? ` ${hints}` : "";
    const pivots = this.expressions(expression, "pivots", { sep: "", flat: true });
    const joins = this.indent(this.expressions(expression, "joins", { sep: "", flat: true }), {
      skip_first: true,
    });
    const laterals = this.expressions(expression, "laterals", { sep: "" });

    let file_format = this.sql(expression, "format");
    let pattern = this.sql(expression, "pattern");
    if (file_format) {
      pattern = pattern ? `, PATTERN => ${pattern}` : "";
      file_format = ` (FILE_FORMAT => ${file_format}${pattern})`;
    } else if (pattern) {
      file_format = ` (PATTERN => ${pattern})`;
    }

    let ordinality = expression.args.ordinality || "";
    if (ordinality) {
      ordinality = ` WITH ORDINALITY${alias}`;
      alias = "";
    }

    const when = this.sql(expression, "when");
    if (when) {
      if (this.constructor.HISTORICAL_DATA_POST_ALIAS) {
        alias = `${alias} ${when}`;
      } else {
        table = `${table} ${when}`;
      }
    }

    let changes = this.sql(expression, "changes");
    changes = changes ? ` ${changes}` : "";

    const rows_from = this.expressions(expression, "rows_from");
    if (rows_from) table = `ROWS FROM ${this.wrap(rows_from)}`;

    let indexed = expression.args.indexed;
    if (indexed !== null && indexed !== undefined) {
      indexed = indexed ? ` INDEXED BY ${this.sql(indexed)}` : " NOT INDEXED";
    } else {
      indexed = "";
    }

    return `${only}${table}${changes}${partition}${file_format}${pre_alias}${alias}${indexed}${hints}${pivots}${post_alias}${joins}${laterals}${ordinality}`;
  }

  /**
   * py: sqlglot/generator.py:2485
   * @param {exp.TableFromRows} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:2485
  tablefromrows_sql(expression) {
    const table = this.func("TABLE", expression.this);
    let alias = this.sql(expression, "alias");
    alias = alias ? ` AS ${alias}` : "";
    const sample = this.sql(expression, "sample");
    const pivots = this.expressions(expression, "pivots", { sep: "", flat: true });
    const joins = this.indent(
      this.expressions(expression, "joins", { sep: "", flat: true }),
      { skip_first: true },
    );
    return `${table}${alias}${pivots}${sample}${joins}`;
  }

  /**
   * py: sqlglot/generator.py:2496
   * @param {exp.TableSample} expression
   * @param {string|null} [tablesample_keyword]
   * @returns {string}
   */
  // py: sqlglot/generator.py:2496
  tablesample_sql(expression, tablesample_keyword = null) {
    let method = this.sql(expression, "method");
    method = method && this.constructor.TABLESAMPLE_WITH_METHOD ? `${method} ` : "";
    const numerator = this.sql(expression, "bucket_numerator");
    const denominator = this.sql(expression, "bucket_denominator");
    let field = this.sql(expression, "bucket_field");
    field = field ? ` ON ${field}` : "";
    const bucket = numerator ? `BUCKET ${numerator} OUT OF ${denominator}${field}` : "";
    let seed = this.sql(expression, "seed");
    seed = seed ? ` ${this.constructor.TABLESAMPLE_SEED_KEYWORD} (${seed})` : "";

    let size = this.sql(expression, "size");
    if (size && this.constructor.TABLESAMPLE_SIZE_IS_ROWS) size = `${size} ROWS`;

    let percent = this.sql(expression, "percent");
    if (percent && !this.dialect.TABLESAMPLE_SIZE_IS_PERCENT) percent = `${percent} PERCENT`;

    let expr = `${bucket}${percent}${size}`;
    if (this.constructor.TABLESAMPLE_REQUIRES_PARENS) expr = `(${expr})`;

    return ` ${tablesample_keyword || this.constructor.TABLESAMPLE_KEYWORDS} ${method}${expr}${seed}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2525
  _pivot_in_value_aliases(expression) {
    const columns = expression.args.columns;
    if (!columns || !columns.length || expression.fields.length !== 1) return null;

    const args = expression.args;
    const parser_cls = this.dialect.parser_class;

    const tgt_identify_pivot_strings = parser_cls.IDENTIFY_PIVOT_STRINGS;
    const tgt_prefixed_pivot_columns = parser_cls.PREFIXED_PIVOT_COLUMNS;
    const tgt_pivot_column_naming = parser_cls.PIVOT_COLUMN_NAMING;

    const src_identify_pivot_strings = args.identify_pivot_strings ?? tgt_identify_pivot_strings;
    const src_prefixed_pivot_columns = args.prefixed_pivot_columns ?? tgt_prefixed_pivot_columns;
    const src_pivot_column_naming = args.pivot_column_naming ?? tgt_pivot_column_naming;

    if (
      src_identify_pivot_strings === tgt_identify_pivot_strings
      && src_prefixed_pivot_columns === tgt_prefixed_pivot_columns
      && src_pivot_column_naming === tgt_pivot_column_naming
    ) {
      return null;
    }

    const in_exprs = expression.fields[0].expressions;
    const step = Math.floor(columns.length / in_exprs.length);

    // Derive the per-value suffix from the first stored column vs the first IN-list value.
    // This correctly handles dialects (e.g. Spark single-agg) that ignore agg aliases.
    const first_base = src_identify_pivot_strings ? in_exprs[0].sql() : in_exprs[0].aliasOrName;
    // deny:operators sqlglot/generator.py:2556 — low-confidence false positive, same
    // shape as lineage.py:627: plain JS array indexing into the `columns` list, not
    // `exp.Bracket` construction over an `Expr`.
    const first_stored = columns[0].name;

    // exit if only suffix matches, not prefix. (e.g. BigQuery, which cannot be fixed)
    if (!first_stored.startsWith(first_base)) return null;

    const suffix = first_stored.slice(first_base.length);

    // Whether the target dialect would append an agg-name suffix for this pivot.
    // Spark single-agg uniquely drops the agg alias entirely.
    const target_has_suffix = (expression.expressions.length > 1 || tgt_pivot_column_naming !== "agg_name_if_multiple")
      && expression.expressions.some((a) => a.alias);
    const source_has_suffix = suffix !== "";

    const new_exprs = [];
    let modified = false;
    for (let val_idx = 0; val_idx < in_exprs.length; val_idx++) {
      const e = in_exprs[val_idx];
      if (e instanceof exp.PivotAlias) {
        new_exprs.push(e);
        continue;
      }

      const i = val_idx * step;
      // deny:operators sqlglot/generator.py:2579 — same false positive as :2556 above:
      // plain JS array indexing into `columns`, not `exp.Bracket` construction.
      const stored_full = columns[i].name;
      const stored_value = suffix ? stored_full.slice(0, stored_full.length - suffix.length) : stored_full;
      const target_value = tgt_identify_pivot_strings ? e.sql() : e.aliasOrName;

      // Source had a suffix, but target won't apply one
      if (source_has_suffix && !target_has_suffix) {
        new_exprs.push(new exp.PivotAlias({ this: e, alias: exp.toIdentifier(stored_full, true) }));
        modified = true;
        // Value-part mismatch (e.g. Snowflake's literal-style values vs others).
      } else if (stored_value !== target_value) {
        new_exprs.push(new exp.PivotAlias({ this: e, alias: exp.toIdentifier(stored_value, true) }));
        modified = true;
      } else {
        new_exprs.push(e);
      }
    }

    return modified ? new_exprs : null;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2600
  pivot_sql(expression) {
    const expressions = this.expressions(expression, null, { flat: true });
    const direction = expression.unpivot ? "UNPIVOT" : "PIVOT";

    const group = this.sql(expression, "group");

    if (expression.this) {
      const this_ = this.sql(expression, "this");
      let sql;
      if (!expressions) {
        sql = `UNPIVOT ${this_}`;
      } else {
        const on = `${this.seg("ON")} ${expressions}`;
        let into = this.sql(expression, "into");
        into = into ? `${this.seg("INTO")} ${into}` : "";
        let using = this.expressions(expression, "using", { flat: true });
        using = using ? `${this.seg("USING")} ${using}` : "";
        sql = `${direction} ${this_}${on}${into}${using}${group}`;
      }
      return this.prepend_ctes(expression, sql);
    }

    if (!expression.unpivot) {
      // Wrap IN-list values with explicit aliases where the target dialect would differ
      const new_field_exprs = this._pivot_in_value_aliases(expression);
      if (new_field_exprs !== null) {
        expression.fields[0].set("expressions", new_field_exprs);
      }
    }

    let alias = this.sql(expression, "alias");
    if (alias) {
      alias = this.constructor.PIVOT_ALIAS_WITH_AS ? ` AS ${alias}` : ` ${alias}`;
    }

    const fields = this.expressions(expression, "fields", {
      sep: " ",
      dynamic: true,
      new_line: true,
      skip_first: true,
      skip_last: true,
    });

    const include_nulls = expression.args.include_nulls;
    const nulls = include_nulls !== null && include_nulls !== undefined
      ? (include_nulls ? " INCLUDE NULLS " : " EXCLUDE NULLS ")
      : "";

    let default_on_null = this.sql(expression, "default_on_null");
    default_on_null = default_on_null ? ` DEFAULT ON NULL (${default_on_null})` : "";
    const sql = `${this.seg(direction)}${nulls}(${expressions} FOR ${fields}${default_on_null}${group})${alias}`;
    return this.prepend_ctes(expression, sql);
  }

  /**
   * py: sqlglot/generator.py:2650
   * @param {exp.Version} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:2650
  version_sql(expression) {
    const this_ = `FOR ${expression.name}`;
    const kind = expression.text("kind");
    const expr = this.sql(expression, "expression");
    return `${this_} ${kind} ${expr}`;
  }

  /**
   * py: sqlglot/generator.py:2656
   * @param {exp.Tuple} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:2656
  tuple_sql(expression) {
    return `(${this.expressions(expression, null, { dynamic: true, new_line: true, skip_first: true, skip_last: true })})`;
  }

  /**
   * py: sqlglot/generator.py:2659
   *
   * Returns [join_sql, from_sql] for UPDATE statements.
   * - join_sql: placed after UPDATE table, before SET
   * - from_sql: placed after SET clause (standard position)
   * Dialects like MySQL need to convert FROM to JOIN syntax.
   * @param {exp.Update} expression
   * @returns {[string, string]}
   */
  // py: sqlglot/generator.py:2659
  _update_from_joins_sql(expression) {
    const from_expr = expression.args.from_;
    if (this.constructor.UPDATE_STATEMENT_SUPPORTS_FROM || !from_expr) {
      return ["", this.sql(expression, "from_")];
    }

    const target_table = expression.this;
    if (target_table instanceof exp.Table) {
      const target_name = exp.toIdentifier(target_table.aliasOrName);
      for (const eq of expression.expressions) {
        const col = eq.this;
        if (col instanceof exp.Column && !col.table) {
          col.set("table", target_name);
        }
      }
    }

    const table = from_expr.this;
    const nested_joins = table.args.joins || [];
    if (nested_joins.length) table.set("joins", null);

    let join_sql = this.sql(new exp.Join({ this: table, on: exp.true() }));
    for (const nested of nested_joins) {
      if (!nested.args.on && !nested.args.using) nested.set("on", exp.true());
      join_sql += this.sql(nested);
    }

    return [join_sql, ""];
  }

  /**
   * py: sqlglot/generator.py:2691
   * @param {exp.Update} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:2691
  update_sql(expression) {
    const hint = this.sql(expression, "hint");
    const this_ = this.sql(expression, "this");
    const [join_sql, from_sql] = this._update_from_joins_sql(expression);
    const set_sql = this.expressions(expression, null, { flat: true });
    const where_sql = this.sql(expression, "where");
    const returning = this.sql(expression, "returning");
    const order = this.sql(expression, "order");
    const limit = this.sql(expression, "limit");
    let expression_sql;
    if (this.constructor.RETURNING_END) {
      expression_sql = `${from_sql}${where_sql}${returning}`;
    } else {
      expression_sql = `${returning}${from_sql}${where_sql}`;
    }
    let options = this.expressions(expression, "options");
    options = options ? ` OPTION(${options})` : "";
    const sql = `UPDATE${hint} ${this_}${join_sql} SET ${set_sql}${expression_sql}${order}${limit}${options}`;
    return this.prepend_ctes(expression, sql);
  }

  /**
   * py: sqlglot/generator.py:2709
   * @param {exp.Values} expression
   * @param {boolean} [values_as_table]
   * @returns {string}
   */
  // py: sqlglot/generator.py:2709
  values_sql(expression, values_as_table = true) {
    values_as_table = values_as_table && this.constructor.VALUES_AS_TABLE;

    if (values_as_table || !expression.findAncestor(exp.From, exp.Join)) {
      const args = this.expressions(expression);
      const alias = this.sql(expression, "alias");
      let values = `VALUES${this.seg("")}${args}`;
      values =
        this.constructor.WRAP_DERIVED_VALUES &&
        (alias || expression.parent instanceof exp.From || expression.parent instanceof exp.Table)
          ? `(${values})`
          : values;
      values = this.query_modifiers(expression, values);
      return alias ? `${values} AS ${alias}` : values;
    }

    const alias_node = expression.args.alias;
    const column_names = alias_node && alias_node.columns;

    const selects = [];
    for (let i = 0; i < expression.expressions.length; i++) {
      const tup = expression.expressions[i];
      let row = tup.expressions;
      if (i === 0 && column_names) {
        row = row.map((value, j) => exp.alias_(value, column_names[j]));
      }
      selects.push(new exp.Select({ expressions: row }));
    }

    if (this.pretty) {
      const query = selects.reduce((x, y) => x.union(y, { distinct: false, copy: false }));
      return this.subquery_sql(query.subquery(alias_node && alias_node.this, { copy: false }));
    }

    const alias = alias_node ? ` AS ${this.sql(alias_node, "this")}` : "";
    const unions = selects.map((select) => this.sql(select)).join(" UNION ALL ");
    return `(${unions})${alias}`;
  }

  /**
   * py: sqlglot/generator.py:2753
   * @param {exp.Var} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:2753
  var_sql(expression) { return this.sql(expression, "this"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2757
  // py: sqlglot/generator.py:2757 `@unsupported_args("expressions") def into_sql(self, expression)`
  // — the `this`-forwarding shim onto `_into_sql` below (module scope), same split as
  // `tochar_sql`/`_tochar_sql`.
  into_sql(expression) { return _into_sql(this, expression); }

  /**
   * py: sqlglot/generator.py:2762
   * @param {exp.From} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:2762
  from_sql(expression) {
    return `${this.seg("FROM")} ${this.sql(expression, "this")}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2765
  groupingsets_sql(expression) {
    const grouping_sets = this.expressions(expression, null, { indent: false });
    return `GROUPING SETS ${this.wrap(grouping_sets)}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2769
  rollup_sql(expression) {
    const expressions = this.expressions(expression, null, { indent: false });
    return expressions ? `ROLLUP ${this.wrap(expressions)}` : "WITH ROLLUP";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2773
  rollupindex_sql(expression) {
    const this_ = this.sql(expression, "this");

    const columns = this.expressions(expression, null, { flat: true });

    let from_sql = this.sql(expression, "from_index");
    from_sql = from_sql ? ` FROM ${from_sql}` : "";

    const properties = expression.args.properties;
    const properties_sql = properties ? ` ${this.properties(properties, "PROPERTIES")}` : "";

    return `${this_}(${columns})${from_sql}${properties_sql}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2788
  rollupproperty_sql(expression) {
    return `ROLLUP (${this.expressions(expression, null, { flat: true })})`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2791
  cube_sql(expression) {
    const expressions = this.expressions(expression, null, { indent: false });
    return expressions ? `CUBE ${this.wrap(expressions)}` : "WITH CUBE";
  }

  /**
   * py: sqlglot/generator.py:2795
   * @param {exp.Group} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:2795
  group_sql(expression) {
    const group_by_all = expression.args.all;
    let modifier;
    if (group_by_all === true) {
      modifier = " ALL";
    } else if (group_by_all === false) {
      modifier = " DISTINCT";
    } else {
      modifier = "";
    }

    let group_by = this.op_expressions(`GROUP BY${modifier}`, expression);

    const grouping_sets = this.expressions(expression, "grouping_sets");
    const cube = this.expressions(expression, "cube");
    const rollup = this.expressions(expression, "rollup");

    const groupings = csv(
      grouping_sets ? this.seg(grouping_sets) : "",
      cube ? this.seg(cube) : "",
      rollup ? this.seg(rollup) : "",
      expression.args.totals ? this.seg("WITH TOTALS") : "",
      { sep: this.constructor.GROUPINGS_SEP },
    );

    if (
      expression.expressions.length &&
      groupings &&
      !["WITH CUBE", "WITH ROLLUP"].includes(pyStrip(groupings))
    ) {
      group_by = `${group_by}${this.constructor.GROUPINGS_SEP}`;
    }

    return `${group_by}${groupings}`;
  }

  /** @returns {string} */
  // py: sqlglot/generator.py:2827. Ported off the back of `unnest_subqueries.js`
  // (optimizer/unnest_subqueries.py, AIR-2115): its own HAVING-clause oracle scenario
  // needed a real `.sql()` render, and this base-Generator method was a stub blocking
  // it — same "generator chain surfaces base-Generator gaps" pattern as R31/R38.
  having_sql(expression) {
    const this_ = this.indent(this.sql(expression, "this"));
    return `${this.seg("HAVING")}${this.sep()}${this_}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2831
  connect_sql(expression) {
    let start = this.sql(expression, "start");
    start = start ? this.seg(`START WITH ${start}`) : "";
    const nocycle = expression.args.nocycle ? " NOCYCLE" : "";
    let connect = this.sql(expression, "connect");
    connect = this.seg(`CONNECT BY${nocycle} ${connect}`);
    return start + connect;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2839
  prior_sql(expression) {
    return `PRIOR ${this.sql(expression, "this")}`;
  }

  /**
   * py: sqlglot/generator.py:2842
   *
   * `expression.method`/`.kind`/`.side`/`.hint` are the `Join`-specific getters
   * installed in `expressions/query_methods.js` (`this.text(p).toUpperCase()`), not
   * `self.sql(expression, key)` — a different resolution path from the rest of this
   * method's `self.sql(expression, "on")`-style reads.
   * @param {exp.Join} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:2842
  join_sql(expression) {
    let side;
    if (!this.constructor.SEMI_ANTI_JOIN_WITH_SIDE && ["SEMI", "ANTI"].includes(expression.kind)) {
      side = null;
    } else {
      side = expression.side;
    }

    let op_sql = [
      expression.method,
      expression.args.global_ ? "GLOBAL" : null,
      side,
      expression.kind,
      this.constructor.JOIN_HINTS ? expression.hint : null,
      expression.args.directed && this.constructor.DIRECTED_JOINS ? "DIRECTED" : null,
    ]
      .filter((op) => op)
      .join(" ");

    let match_cond = this.sql(expression, "match_condition");
    match_cond = match_cond ? ` MATCH_CONDITION (${match_cond})` : "";
    let on_sql = this.sql(expression, "on");
    const using = expression.args.using;

    if (!on_sql && using) {
      on_sql = csv(...using.map((column) => this.sql(column)));
    }

    const this_ = expression.this;
    let this_sql = this.sql(this_);

    const exprs = this.expressions(expression);
    if (exprs) this_sql = `${this_sql},${this.seg(exprs)}`;

    if (on_sql) {
      on_sql = this.indent(on_sql, { skip_first: true });
      const space = this.pretty ? this.seg(" ".repeat(this.pad)) : " ";
      on_sql = using ? `${space}USING (${on_sql})` : `${space}ON ${on_sql}`;
    } else if (!op_sql) {
      if (this_ instanceof exp.Lateral && this_.args.cross_apply !== null && this_.args.cross_apply !== undefined) {
        return ` ${this_sql}`;
      }
      return `, ${this_sql}`;
    }

    if (op_sql !== "STRAIGHT_JOIN") {
      op_sql = op_sql ? `${op_sql} JOIN` : "JOIN";
    }

    const pivots = this.expressions(expression, "pivots", { sep: "", flat: true });
    return `${this.seg(op_sql)} ${this_sql}${match_cond}${on_sql}${pivots}`;
  }

  /**
   * py: sqlglot/generator.py:2894 `lambda_sql(self, expression, arrow_sep="->", wrap=True)`
   * @param {exp.Lambda} expression
   * @param {string} [arrow_sep]
   * @param {boolean} [wrap]
   * @returns {string}
   */
  // py: sqlglot/generator.py:2894
  lambda_sql(expression, arrow_sep = "->", wrap = true) {
    let args = this.expressions(expression, null, { flat: true });
    args = wrap && args.split(",").length > 1 ? `(${args})` : args;
    return `${args} ${arrow_sep} ${this.sql(expression, "this")}`;
  }

  /**
   * py: sqlglot/generator.py:2899
   * @param {exp.Lateral} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:2899
  lateral_op(expression) {
    const cross_apply = expression.args.cross_apply;

    // https://www.mssqltips.com/sqlservertip/1958/sql-server-cross-apply-and-outer-apply/
    let op;
    if (cross_apply === true) op = "INNER JOIN ";
    else if (cross_apply === false) op = "LEFT JOIN ";
    else op = "";

    return `${op}LATERAL`;
  }

  /**
   * py: sqlglot/generator.py:2912
   * @param {exp.Lateral} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:2912
  lateral_sql(expression) {
    const this_ = this.sql(expression, "this");

    if (expression.args.view) {
      const alias = expression.args.alias;
      const columns_ = this.expressions(alias, "columns", { flat: true });
      const table = alias.name ? ` ${alias.name}` : "";
      const columns = columns_ ? ` AS ${columns_}` : "";
      const op_sql = this.seg(`LATERAL VIEW${expression.args.outer ? " OUTER" : ""}`);
      return `${op_sql}${this.sep()}${this_}${table}${columns}`;
    }

    let alias = this.sql(expression, "alias");
    alias = alias ? ` AS ${alias}` : "";

    let ordinality = expression.args.ordinality || "";
    if (ordinality) {
      ordinality = ` WITH ORDINALITY${alias}`;
      alias = "";
    }

    return `${this.lateral_op(expression)} ${this_}${alias}${ordinality}`;
  }

  /**
   * py: sqlglot/generator.py:2933 `limit_sql(expression, top=False)`
   *
   * `LIMIT_ONLY_LITERALS` is `false` at the base `Generator`, so `_simplify_unless_literal`
   * (still `NotPorted`) is never reached here — faithfully called anyway per the file's
   * standing rule for dead-at-base branches.
   * @param {exp.Limit} expression
   * @param {boolean} [top]
   * @returns {string}
   */
  // py: sqlglot/generator.py:2933
  limit_sql(expression, top = false) {
    const this_ = this.sql(expression, "this");

    const args = ["offset", "expression"]
      .map((k) => expression.args[k])
      .filter((e) => e)
      .map((e) => (this.constructor.LIMIT_ONLY_LITERALS ? this._simplify_unless_literal(e) : e));

    let args_sql = args.map((e) => this.sql(e)).join(", ");
    args_sql = top && args.some((e) => !e.is_number) ? `(${args_sql})` : args_sql;
    let expressions = this.expressions(expression, null, { flat: true });
    const limit_options = this.sql(expression, "limit_options");
    expressions = expressions ? ` BY ${expressions}` : "";

    return `${this_}${this.seg(top ? "TOP" : "LIMIT")} ${args_sql}${limit_options}${expressions}`;
  }

  /**
   * py: sqlglot/generator.py:2950
   * @param {exp.Offset} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:2950
  offset_sql(expression) {
    const this_ = this.sql(expression, "this");
    let value = expression.expression;
    value = this.constructor.LIMIT_ONLY_LITERALS ? this._simplify_unless_literal(value) : value;
    let expressions = this.expressions(expression, null, { flat: true });
    expressions = expressions ? ` BY ${expressions}` : "";
    return `${this_}${this.seg("OFFSET")} ${this.sql(value)}${expressions}`;
  }

  /**
   * py: sqlglot/generator.py:2958
   * @param {exp.SetItem} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:2958
  setitem_sql(expression) {
    let kind = this.sql(expression, "kind");
    if (!this.constructor.SET_ASSIGNMENT_REQUIRES_VARIABLE_KEYWORD && kind === "VARIABLE") {
      kind = "";
    } else {
      kind = kind ? `${kind} ` : "";
    }
    const this_ = this.sql(expression, "this");
    const expressions = this.expressions(expression);
    let collate = this.sql(expression, "collate");
    collate = collate ? ` COLLATE ${collate}` : "";
    const global_ = expression.args["global_"] ? "GLOBAL " : "";
    return `${global_}${kind}${this_}${expressions}${collate}`;
  }

  /**
   * py: sqlglot/generator.py:2971
   * @param {exp.Set} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:2971
  set_sql(expression) {
    const expressions = ` ${this.expressions(expression, null, { flat: true })}`;
    const tag = expression.args["tag"] ? " TAG" : "";
    return `${expression.args["unset"] ? "UNSET" : "SET"}${tag}${expressions}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2976
  queryband_sql(expression) {
    const this_ = this.sql(expression, "this");
    const update = expression.args.update ? " UPDATE" : "";
    let scope = this.sql(expression, "scope");
    scope = scope ? ` FOR ${scope}` : "";

    return `QUERY_BAND = ${this_}${update}${scope}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2984
  pragma_sql(expression) {
    return `PRAGMA ${this.sql(expression, "this")}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:2987
  lock_sql(expression) {
    if (!this.constructor.LOCKING_READS_SUPPORTED) {
      this.unsupported("Locking reads using 'FOR UPDATE/SHARE' are not supported");
      return "";
    }

    const update = expression.args.update;
    const key = expression.args.key;
    let lock_type;
    if (update) {
      lock_type = key ? "FOR NO KEY UPDATE" : "FOR UPDATE";
    } else {
      lock_type = key ? "FOR KEY SHARE" : "FOR SHARE";
    }
    let expressions = this.expressions(expression, null, { flat: true });
    expressions = expressions ? ` OF ${expressions}` : "";
    let wait = expression.args.wait;

    if (wait !== null && wait !== undefined) {
      if (wait instanceof exp.Literal) {
        wait = ` WAIT ${this.sql(wait)}`;
      } else {
        wait = wait ? " NOWAIT" : " SKIP LOCKED";
      }
    }

    return `${lock_type}${expressions}${wait || ""}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3010
  literal_sql(expression) {
    // PROOF-OF-CONCEPT (see the file header): one of 6 `*_sql` methods wired at the
    // blocking step to prove the dispatch mechanism end-to-end. Verified line-by-line
    // against the pinned ref and byte-compared against CPython's own output.
    let text = expression.this || "";
    if (expression.isString) {
      text = `${this.dialect.QUOTE_START}${this.escape_str(text)}${this.dialect.QUOTE_END}`;
    }
    return text;
  }

  /**
   * py: sqlglot/generator.py:3016 `escape_str(text, escape_backslash=True, delimiter=None,
   * escaped_delimiter=None, is_byte_string=False)`
   *
   * Options object (rule 2). Iteration is over CODE POINTS (`[...text]`), not UTF-16
   * units: `ESCAPED_SEQUENCES` is keyed by character, and splitting an astral character
   * into surrogates would both miss the lookup and corrupt the output.
   * @param {string} text
   * @param {{escape_backslash?: boolean, delimiter?: string|null, escaped_delimiter?: string|null, is_byte_string?: boolean}} [options]
   * @returns {string}
   */
  // py: sqlglot/generator.py:3016
  escape_str(text, options = {}) {
    const {
      escape_backslash = true,
      delimiter: delimiterArg = null,
      escaped_delimiter: escapedDelimiterArg = null,
      is_byte_string = false,
    } = options;

    const supports_escape_sequences = is_byte_string
      ? this.dialect.BYTE_STRINGS_SUPPORT_ESCAPED_SEQUENCES
      : this.dialect.STRINGS_SUPPORT_ESCAPED_SEQUENCES;

    if (supports_escape_sequences) {
      text = [...text]
        .map((ch) =>
          escape_backslash || ch !== "\\" ? this.dialect.ESCAPED_SEQUENCES.get(ch) ?? ch : ch,
        )
        .join("");
    }

    // py: `delimiter or self.dialect.QUOTE_END` — Python `or`, so an empty-string
    // delimiter falls through to the dialect's, which is the intended behaviour.
    const delimiter = delimiterArg || this.dialect.QUOTE_END;
    const escaped_delimiter = escapedDelimiterArg || this._escaped_quote_end;

    return this._replace_line_breaks(text).replaceAll(delimiter, escaped_delimiter);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3040
  loaddata_sql(expression) {
    const is_overwrite = expression.args.overwrite;
    const overwrite = is_overwrite ? " OVERWRITE" : "";
    let this_ = this.sql(expression, "this");

    const files = expression.args.files;
    if (files) {
      let files_sql = this.expressions(files, null, { flat: true });
      files_sql = `FILES${this.wrap(files_sql)}`;
      if (is_overwrite) {
        this_ = ` ${this_}`;
      } else if (expression.args.temp) {
        this_ = ` INTO TEMP TABLE ${this_}`;
      } else {
        this_ = ` INTO TABLE ${this_}`;
      }
      return `LOAD DATA${overwrite}${this_} FROM ${files_sql}`;
    }

    const local = expression.args.local ? " LOCAL" : "";
    const inpath = ` INPATH ${this.sql(expression, "inpath")}`;
    this_ = ` INTO TABLE ${this_}`;
    let partition = this.sql(expression, "partition");
    partition = partition ? ` ${partition}` : "";
    let input_format = this.sql(expression, "input_format");
    input_format = input_format ? ` INPUTFORMAT ${input_format}` : "";
    let serde = this.sql(expression, "serde");
    serde = serde ? ` SERDE ${serde}` : "";
    return `LOAD DATA${local}${inpath}${overwrite}${this_}${partition}${input_format}${serde}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3068
  // PROOF-OF-CONCEPT. py: `def null_sql(self, *_)` — the var-args are named `_` and
  // never read, so the JS signature takes none. `sql()` still calls it with the
  // expression; JS discards extra arguments exactly as Python's `*_` does.
  null_sql() { return "NULL"; }

  /** @returns {*} */
  // py: sqlglot/generator.py:3071
  // PROOF-OF-CONCEPT. py: `"TRUE" if expression.this else "FALSE"`.
  boolean_sql(expression) { return expression.this ? "TRUE" : "FALSE"; }

  /** @returns {*} */
  // py: sqlglot/generator.py:3074
  booland_sql(expression) {
    return `((${this.sql(expression, "this")}) AND (${this.sql(expression, "expression")}))`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3077
  boolor_sql(expression) {
    return `((${this.sql(expression, "this")}) OR (${this.sql(expression, "expression")}))`;
  }

  /**
   * py: sqlglot/generator.py:3080 `order_sql(expression, flat=False)`
   * @param {exp.Order} expression
   * @param {boolean} [flat]
   * @returns {string}
   */
  // py: sqlglot/generator.py:3080
  order_sql(expression, flat = false) {
    let this_ = this.sql(expression, "this");
    this_ = this_ ? `${this_} ` : this_;
    const siblings = expression.args.siblings ? "SIBLINGS " : "";
    return this.op_expressions(`${this_}ORDER ${siblings}BY`, expression, Boolean(this_) || flat);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3086
  withfill_sql(expression) {
    let from_sql = this.sql(expression, "from_");
    from_sql = from_sql ? ` FROM ${from_sql}` : "";
    let to_sql = this.sql(expression, "to");
    to_sql = to_sql ? ` TO ${to_sql}` : "";
    let step_sql = this.sql(expression, "step");
    step_sql = step_sql ? ` STEP ${step_sql}` : "";
    const interpolated_values = (expression.args.interpolate || []).map((e) =>
      e instanceof exp.Alias
        ? `${this.sql(e, "alias")} AS ${this.sql(e, "this")}`
        : this.sql(e, "this"),
    );
    const interpolate = interpolated_values.length
      ? ` INTERPOLATE (${interpolated_values.join(", ")})`
      : "";
    return `WITH FILL${from_sql}${to_sql}${step_sql}${interpolate}`;
  }

  /**
   * py: sqlglot/generator.py:3104
   * @param {exp.Cluster} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:3104
  cluster_sql(expression) { return this.op_expressions("CLUSTER BY", expression); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3107
  clusterproperty_sql(expression) {
    if (expression.this) {
      this.unsupported(`Unsupported CLUSTER BY ${this.sql(expression, "this")}`);
      return "";
    }
    const expressions = this.expressions(expression, null, { flat: true });
    return `CLUSTER BY (${expressions})`;
  }

  /**
   * py: sqlglot/generator.py:3114
   * @param {exp.Distribute} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:3114
  distribute_sql(expression) { return this.op_expressions("DISTRIBUTE BY", expression); }

  /**
   * py: sqlglot/generator.py:3117
   * @param {exp.Sort} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:3117
  sort_sql(expression) { return this.op_expressions("SORT BY", expression); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3120
  _resolve_ordered_for_null_ordering_simulation(expression) {
    const this_ = expression.this;
    if (!(this_ instanceof exp.Column && !this_.table)) return null;

    const ancestor = expression.findAncestor(exp.Select, exp.Window);
    if (!(ancestor instanceof exp.Select)) return null;

    const column_name = this_.name;
    const matched = ancestor.selects
      .filter((p) => p.outputName === column_name)
      .map((p) => (p instanceof exp.Alias ? p.this : p));
    const match = matched.length === 1 ? matched[0] : null;

    if (match instanceof exp.Column && !match.table && match.name === column_name) {
      return null;
    }

    return match;
  }

  /**
   * py: sqlglot/generator.py:3154
   *
   * `NULL_ORDERING_SUPPORTED` is `true` at the base `Generator`, so the entire
   * "simulate NULLS FIRST/LAST" block below is UNREACHABLE for base-dialect rows
   * (`nulls_sort_change and not self.NULL_ORDERING_SUPPORTED` is always false) — ported
   * faithfully anyway, since a dialect that overrides the tri-state field to `false` or
   * `null` reaches it. `self.WINDOW_FUNCS_WITH_NULL_ORDERING` is an empty array at the
   * base, so `isinstance(window_this, self.WINDOW_FUNCS_WITH_NULL_ORDERING)` — an empty
   * `isinstance` tuple in Python is always `False` — is `[].some(...)` here.
   * @param {exp.Ordered} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:3154
  ordered_sql(expression) {
    const desc = expression.args.desc;
    const asc = !desc;

    const nulls_first = expression.args.nulls_first;
    const nulls_last = !nulls_first;
    const nulls_are_large = this.dialect.NULL_ORDERING === "nulls_are_large";
    const nulls_are_small = this.dialect.NULL_ORDERING === "nulls_are_small";
    const nulls_are_last = this.dialect.NULL_ORDERING === "nulls_are_last";

    let this_ = this.sql(expression, "this");

    const sort_order = desc ? " DESC" : desc === false ? " ASC" : "";
    let nulls_sort_change = "";
    if (nulls_first && ((asc && nulls_are_large) || (desc && nulls_are_small) || nulls_are_last)) {
      nulls_sort_change = " NULLS FIRST";
    } else if (
      nulls_last &&
      ((asc && nulls_are_small) || (desc && nulls_are_large)) &&
      !nulls_are_last
    ) {
      nulls_sort_change = " NULLS LAST";
    }

    // If the NULLS FIRST/LAST clause is unsupported, we add another sort key to simulate it
    if (nulls_sort_change && !this.constructor.NULL_ORDERING_SUPPORTED) {
      const window = expression.findAncestor(exp.Window, exp.Select);

      let window_this;
      let spec;
      if (window instanceof exp.Window) {
        window_this = window.this;
        if (window_this instanceof exp.IgnoreNulls || window_this instanceof exp.RespectNulls) {
          window_this = window_this.this;
        }
        spec = window.args.spec;
      } else {
        window_this = null;
        spec = null;
      }

      // Some window functions (e.g. LAST_VALUE, RANK) support NULLS FIRST/LAST
      // without a spec or with a ROWS spec, but not with RANGE
      const window_this_matches = this.constructor.WINDOW_FUNCS_WITH_NULL_ORDERING.some(
        (cls) => window_this instanceof cls,
      );
      if (!(window_this_matches && (!spec || pyUpper(spec.text("kind")) === "ROWS"))) {
        if (window_this && spec) {
          this.unsupported(
            `'${pyStrip(nulls_sort_change)}' translation not supported in window function ${window_this.constructor.sqlName()}`,
          );
          nulls_sort_change = "";
        } else if (
          this.constructor.NULL_ORDERING_SUPPORTED === false &&
          ((asc && nulls_sort_change === " NULLS LAST") ||
            (desc && nulls_sort_change === " NULLS FIRST"))
        ) {
          // BigQuery does not allow these ordering/nulls combinations when used under
          // an aggregation func or under a window containing one
          let ancestor = expression.findAncestor(exp.AggFunc, exp.Window, exp.Select);

          if (ancestor instanceof exp.Window) ancestor = ancestor.this;
          if (ancestor instanceof exp.AggFunc) {
            this.unsupported(
              `'${pyStrip(nulls_sort_change)}' translation not supported for aggregate function ${ancestor.constructor.sqlName()} with ${sort_order} sort order`,
            );
            nulls_sort_change = "";
          }
        } else if (this.constructor.NULL_ORDERING_SUPPORTED === null) {
          if (expression.this.is_int) {
            this.unsupported(
              `'${pyStrip(nulls_sort_change)}' translation not supported with positional ordering`,
            );
          } else if (!(expression.this instanceof exp.Rand)) {
            const resolved = this._resolve_ordered_for_null_ordering_simulation(expression);
            const target = resolved !== null && resolved !== undefined ? this.sql(resolved) : this_;
            const null_sort_order = nulls_sort_change === " NULLS FIRST" ? " DESC" : "";
            this_ = `CASE WHEN ${target} IS NULL THEN 1 ELSE 0 END${null_sort_order}, ${target}`;
          }
          nulls_sort_change = "";
        }
      }
    }

    let with_fill = this.sql(expression, "with_fill");
    with_fill = with_fill ? ` ${with_fill}` : "";

    return `${this_}${sort_order}${nulls_sort_change}${with_fill}`;
  }

  /**
   * py: sqlglot/generator.py:3235
   * @param {exp.MatchRecognizeMeasure} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:3235
  matchrecognizemeasure_sql(expression) {
    let window_frame = this.sql(expression, "window_frame");
    window_frame = window_frame ? `${window_frame} ` : "";
    const this_ = this.sql(expression, "this");
    return `${window_frame}${this_}`;
  }

  /**
   * py: sqlglot/generator.py:3243
   * @param {exp.MatchRecognize} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:3243
  matchrecognize_sql(expression) {
    const partition = this.partition_by_sql(expression);
    const order = this.sql(expression, "order");
    let measures = this.expressions(expression, "measures");
    measures = measures ? this.seg(`MEASURES${this.seg(measures)}`) : "";
    let rows = this.sql(expression, "rows");
    rows = rows ? this.seg(rows) : "";
    let after = this.sql(expression, "after");
    after = after ? this.seg(after) : "";
    let pattern = this.sql(expression, "pattern");
    pattern = pattern ? this.seg(`PATTERN (${pattern})`) : "";

    const definition_sqls = (expression.args.define || []).map(
      (definition) => `${this.sql(definition, "alias")} AS ${this.sql(definition, "this")}`,
    );
    const definitions = this.expressions(null, null, { sqls: definition_sqls });
    const define = definitions ? this.seg(`DEFINE${this.seg(definitions)}`) : "";

    const body = [partition, order, measures, rows, after, pattern, define].join("");
    let alias = this.sql(expression, "alias");
    alias = alias ? ` ${alias}` : "";
    return `${this.seg("MATCH_RECOGNIZE")} ${this.wrap(body)}${alias}`;
  }

  /**
   * py: sqlglot/generator.py:3275 `query_modifiers(expression, *sqls)`
   *
   * `LIMIT_FETCH` is `"ALL"` at the base `Generator` (neither `"LIMIT"` nor `"FETCH"`),
   * so both branches that reassign `limit` are unreachable for base-dialect rows —
   * ported faithfully anyway.
   * @param {exp.Expr} expression
   * @param {...string} sqls
   * @returns {string}
   */
  // py: sqlglot/generator.py:3275
  query_modifiers(expression, ...sqls) {
    let limit = expression.args.limit;
    const cls = this.constructor;

    if (cls.LIMIT_FETCH === "LIMIT" && limit instanceof exp.Fetch) {
      const count = limit.args.count;
      limit = new exp.Limit({
        expression: count !== null && count !== undefined ? exp.maybeCopy(count) : exp.Literal.number(1),
      });
    } else if (cls.LIMIT_FETCH === "FETCH" && limit instanceof exp.Limit) {
      limit = new exp.Fetch({ direction: "FIRST", count: exp.maybeCopy(limit.expression) });
    }

    return csv(
      ...sqls,
      ...(expression.args.joins || []).map((join) => this.sql(join)),
      this.sql(expression, "match"),
      ...(expression.args.laterals || []).map((lateral) => this.sql(lateral)),
      this.sql(expression, "prewhere"),
      this.sql(expression, "where"),
      this.sql(expression, "connect"),
      this.sql(expression, "group"),
      this.sql(expression, "having"),
      ...[...cls.AFTER_HAVING_MODIFIER_TRANSFORMS.values()].map((gen) => gen(this, expression)),
      this.sql(expression, "order"),
      ...this.offset_limit_modifiers(expression, limit instanceof exp.Fetch, limit),
      ...this.after_limit_modifiers(expression),
      this.options_modifier(expression),
      this.sql(expression, "for_"),
      { sep: "" },
    );
  }

  /**
   * py: sqlglot/generator.py:3307
   * @param {exp.Expr} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:3307
  options_modifier(expression) {
    const options = this.expressions(expression, "options");
    return options ? ` ${options}` : "";
  }

  /**
   * py: sqlglot/generator.py:3311
   * @param {exp.ForClause} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:3311
  forclause_sql(expression) {
    const kind = expression.args.kind;
    if (kind === "BROWSE") return `${this.sep()}FOR BROWSE`;

    // FOR XML/JSON always carry at least AUTO/PATH. An empty rendering means
    // the target dialect doesn't support QueryOption, so we drop the clause.
    const options = this.expressions(expression, "expressions");
    if (!options) return "";
    // deny:implicit_str sqlglot/generator.py:3320 — `kind` is a bare Python string
    // literal ("XML"/"JSON"/"BROWSE") at every `exp.ForClause` construction site
    // (`parsers/tsql.py:_parse_for`), never an `Expr`; a plain template-literal
    // interpolation is correct.
    return `${this.sep()}FOR ${kind}${this.seg(options)}`;
  }

  /**
   * py: sqlglot/generator.py:3322
   * @param {exp.QueryOption} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:3322
  queryoption_sql(expression) {
    this.unsupported("Unsupported query option.");
    return "";
  }

  /**
   * py: sqlglot/generator.py:3326
   * @param {exp.Expr} expression
   * @param {boolean} fetch
   * @param {exp.Fetch|exp.Limit|null} limit
   * @returns {string[]}
   */
  // py: sqlglot/generator.py:3326
  offset_limit_modifiers(expression, fetch, limit) {
    return [
      fetch ? this.sql(expression, "offset") : this.sql(limit),
      fetch ? this.sql(limit) : this.sql(expression, "offset"),
    ];
  }

  /**
   * py: sqlglot/generator.py:3334
   * @param {exp.Expr} expression
   * @returns {string[]}
   */
  // py: sqlglot/generator.py:3334
  after_limit_modifiers(expression) {
    let locks = this.expressions(expression, "locks", { sep: " " });
    locks = locks ? ` ${locks}` : "";
    return [locks, this.sql(expression, "sample")];
  }

  /**
   * py: sqlglot/generator.py:3339
   *
   * The keystone method: every `Select` node dispatches here. `SUPPORTS_SELECT_INTO`,
   * `LIMIT_IS_TOP`, `STAR_EXCLUDE_REQUIRES_DERIVED_TABLE` and `SUPPORTS_UNLOGGED_TABLES`
   * are all real base-`Generator` settings (`false`/`false`/`true`/`false`), so the
   * `INTO`/`TOP`/`EXCLUDE`-derived-subquery branches ARE live at the base — unlike most
   * of this keystone group's dead-at-base branches, these are exercised by ordinary
   * base-dialect rows and are not just faithfully-ported-but-unreachable code.
   * @param {exp.Select} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:3339
  select_sql(expression) {
    const cls = this.constructor;
    const into = expression.args.into;
    if (!cls.SUPPORTS_SELECT_INTO && into) into.pop();

    const hint = this.sql(expression, "hint");
    let distinct = this.sql(expression, "distinct");
    distinct = distinct ? ` ${distinct}` : "";
    let kind = this.sql(expression, "kind");

    const limit = expression.args.limit;
    let top;
    if (limit instanceof exp.Limit && cls.LIMIT_IS_TOP) {
      top = this.limit_sql(limit, true);
      limit.pop();
    } else {
      top = "";
    }

    let expressions = this.expressions(expression);

    if (kind) {
      if (cls.SELECT_KINDS.includes(kind)) {
        kind = ` AS ${kind}`;
      } else {
        if (kind === "STRUCT") {
          expressions = this.expressions(null, null, {
            sqls: [
              this.sql(
                new exp.Struct({
                  expressions: expression.expressions.map((e) =>
                    e instanceof exp.Alias
                      ? new exp.PropertyEQ({ this: e.args.alias, expression: e.this })
                      : e,
                  ),
                }),
              ),
            ],
          });
        }
        kind = "";
      }
    }

    let operation_modifiers = this.expressions(expression, "operation_modifiers", { sep: " " });
    operation_modifiers = operation_modifiers ? `${this.sep()}${operation_modifiers}` : "";

    // py:3382 `if not self.STAR_EXCLUDE_REQUIRES_DERIVED_TABLE and exclude:` — `exclude`
    // is a plain list (`RedshiftParser._parse_projections` sets it to `[]`, not `None`,
    // when there is no EXCLUDE clause), and an EMPTY Python list is falsy where JS's
    // `[]` is not; `pyTruthy` closes that gap rather than emitting a spurious
    // `EXCLUDE ()` for every SELECT.
    const exclude = expression.args.exclude;

    if (!cls.STAR_EXCLUDE_REQUIRES_DERIVED_TABLE && pyTruthy(exclude)) {
      const exclude_sql = this.expressions(null, null, { sqls: exclude, flat: true });
      expressions = `${expressions}${this.seg("EXCLUDE")} (${exclude_sql})`;
    }

    // We use LIMIT_IS_TOP as a proxy for whether DISTINCT should go first because tsql and Teradata
    // are the only dialects that use LIMIT_IS_TOP and both place DISTINCT first.
    const top_distinct = cls.LIMIT_IS_TOP
      ? `${distinct}${hint}${top}`
      : `${top}${hint}${distinct}`;
    expressions = expressions ? `${this.sep()}${expressions}` : expressions;
    let sql = this.query_modifiers(
      expression,
      `SELECT${top_distinct}${operation_modifiers}${kind}${expressions}`,
      this.sql(expression, "into", false),
      this.sql(expression, "from_", false),
    );

    // If both the CTE and SELECT clauses have comments, generate the latter earlier
    if (expression.args.with_) {
      sql = this.maybe_comment(sql, expression);
      expression.popComments();
    }

    sql = this.prepend_ctes(expression, sql);

    if (cls.STAR_EXCLUDE_REQUIRES_DERIVED_TABLE && pyTruthy(exclude)) {
      expression.set("exclude", null);
      const subquery = expression.subquery(null, { copy: false });
      const star = new exp.Star({ except_: exclude });
      sql = this.sql(exp.select(star).from_(subquery, { copy: false }));
    }

    if (!cls.SUPPORTS_SELECT_INTO && into) {
      let table_kind;
      if (into.args.temporary) {
        table_kind = " TEMPORARY";
      } else if (cls.SUPPORTS_UNLOGGED_TABLES && into.args.unlogged) {
        table_kind = " UNLOGGED";
      } else {
        table_kind = "";
      }
      sql = `CREATE${table_kind} TABLE ${this.sql(into.this)} AS ${sql}`;
    }

    return sql;
  }

  /**
   * py: sqlglot/generator.py:3423
   * @param {exp.Schema} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:3423
  schema_sql(expression) {
    const this_ = this.sql(expression, "this");
    const sql = this.schema_columns_sql(expression);
    return this_ && sql ? `${this_} ${sql}` : this_ || sql;
  }

  /**
   * py: sqlglot/generator.py:3428
   * @param {exp.Expr} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:3428
  schema_columns_sql(expression) {
    if (expression.expressions.length) {
      return `(${this.sep("")}${this.expressions(expression)}${this.seg(")", "")}`;
    }
    return "";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3433
  star_sql(expression) {
    // PROOF-OF-CONCEPT, and the most load-bearing of the six: it is the only wired
    // method that exercises rule 1 (`this.constructor.STAR_EXCEPT`, not `this.STAR_EXCEPT`),
    // rule 4 (the `except_` arg key — `args.except` would read `undefined`), and
    // `expressions()`'s options object all at once.
    let except_ = this.expressions(expression, "except_", { flat: true });
    except_ = except_ ? `${this.seg(this.constructor.STAR_EXCEPT)} (${except_})` : "";
    let replace = this.expressions(expression, "replace", { flat: true });
    replace = replace ? `${this.seg("REPLACE")} (${replace})` : "";
    let rename = this.expressions(expression, "rename", { flat: true });
    rename = rename ? `${this.seg("RENAME")} (${rename})` : "";
    let ilike = this.sql(expression, "ilike");
    ilike = ilike ? `${this.seg("ILIKE")} ${ilike}` : "";
    return `*${ilike}${except_}${replace}${rename}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3444
  parameter_sql(expression) {
    const this_ = this.sql(expression, "this");
    return `${this.constructor.PARAMETER_TOKEN}${this_}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3448
  sessionparameter_sql(expression) {
    const this_ = this.sql(expression, "this");
    let kind = expression.text("kind");
    if (kind) kind = `${kind}.`;
    return `@@${kind}${this_}`;
  }

  /**
   * py: sqlglot/generator.py:3455
   * @param {exp.Placeholder} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:3455
  placeholder_sql(expression) {
    return expression.this ? `${this.constructor.NAMED_PLACEHOLDER_TOKEN}${expression.name}` : "?";
  }

  /**
   * py: sqlglot/generator.py:3458 `subquery_sql(expression, sep=" AS ")`
   * @param {exp.Subquery} expression
   * @param {string} [sep]
   * @returns {string}
   */
  // py: sqlglot/generator.py:3458
  subquery_sql(expression, sep = " AS ") {
    let alias = this.sql(expression, "alias");
    alias = alias ? `${sep}${alias}` : "";
    const sample = this.sql(expression, "sample");
    if (this.dialect.ALIAS_POST_TABLESAMPLE && sample) {
      alias = `${sample}${alias}`;

      // Set to None so it's not generated again by self.query_modifiers()
      expression.set("sample", null);
    }

    const pivots = this.expressions(expression, "pivots", { sep: "", flat: true });
    const sql = this.query_modifiers(expression, this.wrap(expression), alias, pivots);
    return this.prepend_ctes(expression, sql);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3472
  qualify_sql(expression) {
    const this_ = this.indent(this.sql(expression, "this"));
    return `${this.seg("QUALIFY")}${this.sep()}${this_}`;
  }

  // py: sqlglot/generator.py:3476 — ported alongside `generators/postgres.js`'s own
  // `unnest_sql` override (PORT_PLAN.md P4), which falls back to `super().unnest_sql()`
  // for every UNNEST it does not special-case (multi-arg, non-array-of-json).
  unnest_sql(expression) {
    const args = this.expressions(expression, null, { flat: true });

    let alias = expression.args.alias;
    const offset = expression.args.offset;

    if (this.constructor.UNNEST_WITH_ORDINALITY) {
      if (alias && offset instanceof exp.Expr) {
        alias.append("columns", offset);
        expression.set("offset", null);
      }
    }

    let alias_sql;
    if (alias && this.dialect.UNNEST_COLUMN_ONLY) {
      const columns = alias.columns;
      alias_sql = columns.length ? this.sql(columns[0]) : "";
    } else {
      alias_sql = this.sql(alias);
    }

    alias_sql = alias_sql ? ` AS ${alias_sql}` : alias_sql;

    let suffix;
    if (this.constructor.UNNEST_WITH_ORDINALITY) {
      suffix = offset ? ` WITH ORDINALITY${alias_sql}` : alias_sql;
    } else if (offset instanceof exp.Expr) {
      suffix = `${alias_sql} WITH OFFSET AS ${this.sql(offset)}`;
    } else if (offset) {
      suffix = `${alias_sql} WITH OFFSET`;
    } else {
      suffix = alias_sql;
    }

    return `UNNEST(${args})${suffix}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3506
  prewhere_sql(expression) {
    return "";
  }

  /**
   * py: sqlglot/generator.py:3509
   * @param {exp.Where} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:3509
  where_sql(expression) {
    const this_ = this.indent(this.sql(expression, "this"));
    return `${this.seg("WHERE")}${this.sep()}${this_}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3513
  window_sql(expression) {
    let this_ = this.sql(expression, "this");
    const partition = this.partition_by_sql(expression);
    let order = expression.args.order;
    order = order ? this.order_sql(order, true) : "";
    const spec = this.sql(expression, "spec");
    const alias = this.sql(expression, "alias");
    const over = this.sql(expression, "over") || "OVER";
    this_ = `${this_} ${expression.argKey === "windows" ? "AS" : over}`;
    const firstValue = expression.args.first;
    const first = firstValue == null ? "" : firstValue ? "FIRST" : "LAST";
    if (!partition && !order && !spec && alias) return `${this_} ${alias}`;
    const args = this.format_args(...[alias, first, partition, order, spec].filter(Boolean), { sep: " " });
    return `${this_} (${args})`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3538
  partition_by_sql(expression) {
    const partition = this.expressions(expression, "partition_by", { flat: true });
    return partition ? `PARTITION BY ${partition}` : "";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3542
  windowspec_sql(expression) {
    const kind = this.sql(expression, "kind");
    const start = csv(this.sql(expression, "start"), this.sql(expression, "start_side"), { sep: " " });
    const end = csv(this.sql(expression, "end"), this.sql(expression, "end_side"), { sep: " " }) || "CURRENT ROW";
    let windowSpec = `${kind} BETWEEN ${start} AND ${end}`;
    const exclude = this.sql(expression, "exclude");
    if (exclude) {
      if (this.constructor.SUPPORTS_WINDOW_EXCLUDE) windowSpec += ` EXCLUDE ${exclude}`;
      else this.unsupported("EXCLUDE clause is not supported in the WINDOW clause");
    }
    return windowSpec;
  }

  // py: sqlglot/generator.py:3561 — ported alongside `generators/postgres.js`'s
  // `TRANSFORMS[exp.PercentileCont]`/`[exp.PercentileDisc]` (via
  // `transforms.add_within_group_for_percentiles`, PORT_PLAN.md P4), the first caller
  // in this port to reach a plain (non-`super()`-guarded) `WithinGroup` node.
  // `generators/snowflake.js`'s own `withingroup_sql` override already falls back to
  // `super.withingroup_sql()` for everything but its MEDIAN special case, so this was
  // reachable — just never reached — before this file existed.
  withingroup_sql(expression) {
    const this_ = this.sql(expression, "this");
    const expression_sql = this.sql(expression, "expression").slice(1); // order has a leading space
    return `${this_} WITHIN GROUP (${expression_sql})`;
  }

  /**
   * py: sqlglot/generator.py:3566
   * @param {exp.Between} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:3566
  between_sql(expression) {
    const this_ = this.sql(expression, "this");
    const low = this.sql(expression, "low");
    const high = this.sql(expression, "high");
    const symmetric = expression.args.symmetric;

    if (symmetric && !this.constructor.SUPPORTS_BETWEEN_FLAGS) {
      return `(${this_} BETWEEN ${low} AND ${high} OR ${this_} BETWEEN ${high} AND ${low})`;
    }

    // silently drop ASYMMETRIC – semantics identical
    const flag = symmetric
      ? " SYMMETRIC"
      : symmetric === false && this.constructor.SUPPORTS_BETWEEN_FLAGS
        ? " ASYMMETRIC"
        : "";
    return `${this_} BETWEEN${flag} ${low} AND ${high}`;
  }

  /**
   * py: sqlglot/generator.py:3584
   * @param {exp.Bracket} expression
   * @param {number|null} [index_offset]
   * @returns {exp.Expr[]}
   */
  // py: sqlglot/generator.py:3584
  bracket_offset_expressions(expression, index_offset = null) {
    if (expression.args.json_access) return expression.expressions;

    const { annotate_types } = _getAnnotateTypesModule();
    return exp.applyIndexOffset(
      expression.this,
      expression.expressions,
      (index_offset ?? this.dialect.INDEX_OFFSET) - (expression.args.offset ?? 0),
      { dialect: this.dialect, annotateTypes: annotate_types, simplify: _getSimplifyFn() },
    );
  }

  /**
   * py: sqlglot/generator.py:3597
   * @param {exp.Bracket} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:3597
  bracket_sql(expression) {
    const expressions = this.bracket_offset_expressions(expression);
    const expressions_sql = expressions.map((e) => this.sql(e)).join(", ");
    return `${this.sql(expression, "this")}[${expressions_sql}]`;
  }

  /**
   * py: sqlglot/generator.py:3602
   * @param {exp.All} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:3602
  all_sql(expression) {
    let this_ = this.sql(expression, "this");
    if (!(expression.this instanceof exp.Tuple || expression.this instanceof exp.Paren)) {
      this_ = this.wrap(this_);
    }
    return `ALL ${this_}`;
  }

  /**
   * py: sqlglot/generator.py:3608 `any_sql(expression)`, using module-level
   * `exp.UNWRAPPED_QUERIES = (Select, SetOperation)` — the local `UNWRAPPED_QUERIES()`
   * helper above (used by `wrap()`) is the same pair.
   * @param {exp.Any} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:3608
  any_sql(expression) {
    let this_ = this.sql(expression, "this");
    const unwrapped = UNWRAPPED_QUERIES();
    const is_unwrapped_query = unwrapped.some((cls) => expression.this instanceof cls);
    if (is_unwrapped_query || expression.this instanceof exp.Paren) {
      if (is_unwrapped_query) this_ = this.wrap(this_);
      return `ANY${this_}`;
    }
    return `ANY ${this_}`;
  }

  /**
   * py: sqlglot/generator.py:3616
   * @param {exp.Exists} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:3616
  exists_sql(expression) { return `EXISTS${this.wrap(expression)}`; }

  /** py: sqlglot/generator.py:3619 — ported for PORT_PLAN.md R32. */
  case_sql(expression) {
    const this_ = this.sql(expression, "this");
    const statements = [this_ ? `CASE ${this_}` : "CASE"];

    for (const e of expression.args.ifs) {
      statements.push(`WHEN ${this.sql(e, "this")}`);
      statements.push(`THEN ${this.sql(e, "true")}`);
    }

    const default_ = this.sql(expression, "default");
    if (default_) statements.push(`ELSE ${default_}`);
    statements.push("END");

    if (this.pretty && this.too_wide(statements)) {
      return this.indent(statements.join("\n"), { skip_first: true, skip_last: true });
    }

    return statements.join(" ");
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3639
  constraint_sql(expression) {
    const this_ = this.sql(expression, "this");
    const expressions = this.expressions(expression, null, { flat: true });
    return `CONSTRAINT ${this_} ${expressions}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3644
  nextvaluefor_sql(expression) {
    const order = expression.args.order;
    const order_sql = order ? ` OVER (${this.order_sql(order, true)})` : "";
    return `NEXT VALUE FOR ${this.sql(expression, "this")}${order_sql}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3649
  extract_sql(expression) {
    const this_ = this.constructor.NORMALIZE_EXTRACT_DATE_PARTS
      ? _getDialectHelpers().map_date_part(expression.this, this.dialect)
      : expression.this;
    let this_sql;
    if (this.constructor.EXTRACT_ALLOWS_QUOTES) {
      this_sql = this.sql(this_);
    } else if (this_ instanceof exp.WeekStart) {
      this_sql = this.weekstart_name(this_);
    } else {
      this_sql = this_.name;
    }
    const expression_sql = this.sql(expression, "expression");

    return `EXTRACT(${this_sql} FROM ${expression_sql})`;
  }

  /**
   * py: sqlglot/generator.py:3667
   * @param {exp.Trim} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:3667
  trim_sql(expression) {
    const trim_type = this.sql(expression, "position");

    let func_name;
    if (trim_type === "LEADING") func_name = "LTRIM";
    else if (trim_type === "TRAILING") func_name = "RTRIM";
    else func_name = "TRIM";

    return this.func(func_name, expression.this, expression.expression);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3679
  convert_concat_args(expression) {
    let args = expression.expressions;
    if (expression instanceof exp.ConcatWs) {
      args = args.slice(1); // Skip the delimiter
    }

    if (this.dialect.STRICT_STRING_CONCAT && expression.args.safe) {
      args = args.map((e) => exp.cast(e, exp.DType.TEXT));
    }

    const concat_coalesce = expression instanceof exp.ConcatWs
      ? this.dialect.CONCAT_WS_COALESCE
      : this.dialect.CONCAT_COALESCE;

    if (!concat_coalesce && expression.args.coalesce) {
      const _wrap_with_coalesce = (e) => {
        if (!e.type) {
          e = _getAnnotateTypesModule().annotate_types(e, { dialect: this.dialect });
        }

        if (e.isString || e.isType(exp.DType.ARRAY)) return e;

        return exp.func("coalesce", e, exp.Literal.string(""));
      };

      args = args.map(_wrap_with_coalesce);
    }

    return args;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3710
  concat_sql(expression) {
    if (this.dialect.CONCAT_COALESCE && !expression.args.coalesce) {
      // Dialect's CONCAT function coalesces NULLs to empty strings, but the expression does not.
      // Transpile to double pipe operators, which typically returns NULL if any args are NULL
      // instead of coalescing them to empty string.
      return _getDialectHelpers().concat_to_dpipe_sql(this, expression);
    }

    const expressions = this.convert_concat_args(expression);

    // Some dialects don't allow a single-argument CONCAT call
    if (!this.constructor.SUPPORTS_SINGLE_ARG_CONCAT && expressions.length === 1) {
      return this.sql(expressions[0]);
    }

    return this.func("CONCAT", ...expressions);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3727
  // py: sqlglot/generator.py:3727
  concatws_sql(expression) {
    if (this.dialect.CONCAT_WS_COALESCE && !expression.args.coalesce) {
      // Dialect's CONCAT_WS function skips NULL args, but the expression does not.
      // Wrap the entire call in a CASE expression that returns NULL if any input IS NULL.
      const all_args = expression.expressions;
      expression.set("coalesce", true);
      return this.sql(
        exp.case_()
          .when(exp.or_(...all_args.map((arg) => arg.is_(exp.null_()))), exp.null_())
          .else_(expression)
      );
    }

    return this.func(
      "CONCAT_WS", expression.expressions[0], ...this.convert_concat_args(expression)
    );
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3743
  check_sql(expression) {
    const this_ = this.sql(expression, "this");
    return `CHECK (${this_})`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3747
  foreignkey_sql(expression) {
    let expressions = this.expressions(expression, null, { flat: true });
    expressions = expressions ? ` (${expressions})` : "";
    let reference = this.sql(expression, "reference");
    reference = reference ? ` ${reference}` : "";
    let delete_ = this.sql(expression, "delete");
    delete_ = delete_ ? ` ON DELETE ${delete_}` : "";
    let update = this.sql(expression, "update");
    update = update ? ` ON UPDATE ${update}` : "";
    let options = this.expressions(expression, "options", { flat: true, sep: " " });
    options = options ? ` ${options}` : "";
    return `FOREIGN KEY${expressions}${reference}${delete_}${update}${options}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3760
  // py: sqlglot/generator.py:3760
  primarykey_sql(expression) {
    let this_ = this.sql(expression, "this");
    this_ = this_ ? ` ${this_}` : "";
    const expressions = this.expressions(expression, null, { flat: true });
    const include = this.sql(expression, "include");
    let options = this.expressions(expression, "options", { flat: true, sep: " " });
    options = options ? ` ${options}` : "";
    return `PRIMARY KEY${this_} (${expressions})${include}${options}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3769
  timeserieskey_sql(expression) {
    this.unsupported("TIMESERIES primary key columns are not supported");
    return this.sql(expression, "this");
  }

  /** py: sqlglot/generator.py:3773 — ported for PORT_PLAN.md R32. */
  if_sql(expression) {
    return this.case_sql(new exp.Case({ ifs: [expression], default: expression.args.false }));
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3776
  matchagainst_sql(expression) {
    let expressions;
    if (this.constructor.MATCH_AGAINST_TABLE_PREFIX) {
      expressions = expression.expressions.map((expr) =>
        expr instanceof exp.Table ? `TABLE ${this.sql(expr)}` : expr,
      );
    } else {
      expressions = expression.expressions;
    }

    let modifier = expression.args.modifier;
    modifier = modifier ? ` ${modifier}` : "";
    return `${this.func("MATCH", ...expressions)} AGAINST(${this.sql(expression, "this")}${modifier})`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3793
  jsonkeyvalue_sql(expression) {
    return `${this.sql(expression, "this")}${this.constructor.JSON_KEY_VALUE_PAIR_SEP} ${this.sql(expression, "expression")}`;
  }

  /**
   * py: sqlglot/generator.py:3796
   * @param {exp.JSONPath} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:3796
  jsonpath_sql(expression) {
    let path = pyLstrip(this.expressions(expression, null, { sep: "", flat: true }), ".");

    if (this.constructor.QUOTE_JSON_PATH) {
      path = `${this.dialect.QUOTE_START}${path}${this.dialect.QUOTE_END}`;
    }

    return path;
  }

  /**
   * py: sqlglot/generator.py:3804
   * @param {number|string|exp.Expr} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:3804
  json_path_part(expression) {
    if (expression instanceof exp.JSONPathPart) {
      const transform = this.constructor.TRANSFORMS.get(expression.constructor);
      if (typeof transform !== "function") {
        this.unsupported(`Unsupported JSONPathPart type ${expression.constructor.name}`);
        return "";
      }
      return transform(this, expression);
    }

    // deny:implicit_str sqlglot/generator.py:3814 — `str(expression)` on the `int`
    // branch of `expression: int | str | exp.JSONPathPart`; the `exp.JSONPathPart` case
    // already returned above, so only `int`/`bigint` reach here — `String(...)` is a
    // plain number-to-string conversion, not an implicit `.sql()`.
    if (typeof expression === "number" || typeof expression === "bigint") return String(expression);

    // deny:implicit_str sqlglot/generator.py:3818 — f-string on `expression`, but by
    // this point the `exp.JSONPathPart` and `int` branches above have already returned,
    // so only the `str` case of `int | str | exp.JSONPathPart` reaches here; a bare
    // template literal is correct.
    let escaped;
    if (this._quote_json_path_key_using_brackets && this.constructor.JSON_PATH_SINGLE_QUOTE_ESCAPE) {
      escaped = `\\'${expression}\\'`;
    } else {
      escaped = expression.replaceAll('"', '\\"');
      escaped = `"${escaped}"`;
    }

    return escaped;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3825
  formatjson_sql(expression) { return `${this.sql(expression, "this")} FORMAT JSON`; }

  /** @returns {*} */
  // py: sqlglot/generator.py:3828
  formatphrase_sql(expression) {
    const this_ = this.sql(expression, "this");
    const fmt = this.sql(expression, "format");
    return `${this_} (FORMAT ${fmt})`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3835
  _jsonobject_sql(expression, name = "") {
    let null_handling = expression.args.null_handling;
    null_handling = null_handling ? ` ${null_handling}` : "";
    const unique_keys_raw = expression.args.unique_keys;
    const unique_keys = unique_keys_raw !== undefined && unique_keys_raw !== null
      ? ` ${unique_keys_raw ? "WITH" : "WITHOUT"} UNIQUE KEYS`
      : "";
    let return_type = this.sql(expression, "return_type");
    return_type = return_type ? ` RETURNING ${return_type}` : "";
    let encoding = this.sql(expression, "encoding");
    encoding = encoding ? ` ENCODING ${encoding}` : "";
    if (!name) name = expression instanceof exp.JSONObject ? "JSON_OBJECT" : "JSON_OBJECTAGG";
    return this.func(name, ...expression.expressions, { suffix: `${null_handling}${unique_keys}${return_type}${encoding})` });
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3861
  // py: sqlglot/generator.py:3861
  jsonarray_sql(expression) {
    let null_handling = expression.args.null_handling;
    null_handling = null_handling ? ` ${null_handling}` : "";
    let return_type = this.sql(expression, "return_type");
    return_type = return_type ? ` RETURNING ${return_type}` : "";
    const strict = expression.args.strict ? " STRICT" : "";
    return this.func(
      "JSON_ARRAY", ...expression.expressions, { suffix: `${null_handling}${return_type}${strict})` }
    );
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3871
  // py: sqlglot/generator.py:3871
  jsonarrayagg_sql(expression) {
    const this_ = this.sql(expression, "this");
    const order = this.sql(expression, "order");
    let null_handling = expression.args.null_handling;
    null_handling = null_handling ? ` ${null_handling}` : "";
    let return_type = this.sql(expression, "return_type");
    return_type = return_type ? ` RETURNING ${return_type}` : "";
    const strict = expression.args.strict ? " STRICT" : "";
    return this.func(
      "JSON_ARRAYAGG",
      this_,
      { suffix: `${order}${null_handling}${return_type}${strict})` }
    );
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3885
  jsoncolumndef_sql(expression) {
    let path = this.sql(expression, "path");
    path = path ? ` PATH ${path}` : "";
    const nested_schema = this.sql(expression, "nested_schema");

    if (nested_schema) {
      return `NESTED${path} ${nested_schema}`;
    }

    const this_ = this.sql(expression, "this");
    let kind = this.sql(expression, "kind");
    kind = kind ? ` ${kind}` : "";
    const format_json = expression.args.format_json ? " FORMAT JSON" : "";

    const ordinality = expression.args.ordinality ? " FOR ORDINALITY" : "";
    return `${this_}${kind}${format_json}${path}${ordinality}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3901
  jsonschema_sql(expression) {
    return this.func("COLUMNS", ...expression.expressions);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3904
  jsontable_sql(expression) {
    const this_ = this.sql(expression, "this");
    let path = this.sql(expression, "path");
    path = path ? `, ${path}` : "";
    let error_handling = expression.args.error_handling;
    error_handling = error_handling ? ` ${error_handling}` : "";
    let empty_handling = expression.args.empty_handling;
    empty_handling = empty_handling ? ` ${empty_handling}` : "";
    const schema = this.sql(expression, "schema");
    return this.func(
      "JSON_TABLE", this_, { suffix: `${path}${error_handling}${empty_handling} ${schema})` },
    );
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3917
  openjsoncolumndef_sql(expression) {
    const this_ = this.sql(expression, "this");
    const kind = this.sql(expression, "kind");
    let path = this.sql(expression, "path");
    path = path ? ` ${path}` : "";
    const as_json = expression.args.as_json ? " AS JSON" : "";
    return `${this_} ${kind}${path}${as_json}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3925
  openjson_sql(expression) {
    const this_ = this.sql(expression, "this");
    let path = this.sql(expression, "path");
    path = path ? `, ${path}` : "";
    const expressions = this.expressions(expression);
    const with_ = expressions
      ? ` WITH (${this.seg(this.indent(expressions), "")}${this.seg(")", "")}`
      : "";
    return `OPENJSON(${this_}${path})${with_}`;
  }

  /**
   * py: sqlglot/generator.py:3937
   * @param {exp.In} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:3937
  in_sql(expression) {
    const query = expression.args.query;
    const unnest = expression.args.unnest;
    const field = expression.args.field;
    const is_global = expression.args.is_global ? " GLOBAL" : "";

    let in_sql;
    if (query) {
      in_sql = this.sql(query);
    } else if (unnest) {
      in_sql = this.in_unnest_op(unnest);
    } else if (field) {
      in_sql = this.sql(field);
    } else {
      in_sql = `(${this.expressions(expression, null, { dynamic: true, new_line: true, skip_first: true, skip_last: true })})`;
    }

    return `${this.sql(expression, "this")}${is_global} IN ${in_sql}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3954
  // py: sqlglot/generator.py:3954
  in_unnest_op(unnest) {
    return `(SELECT ${this.sql(unnest)})`;
  }

  /**
   * py: sqlglot/generator.py:3957
   * @param {exp.Interval} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:3957
  interval_sql(expression) {
    const include_keyword =
      !this.constructor.AUTO_REFRESH_BARE_INTERVALS ||
      !(expression.findAncestor(exp.AutoRefreshProperty, exp.Select) instanceof exp.AutoRefreshProperty);
    let interval_keyword = include_keyword ? "INTERVAL" : "";
    const unit_expression = expression.args.unit;
    let unit = unit_expression ? this.sql(unit_expression) : "";
    if (!this.constructor.INTERVAL_ALLOWS_PLURAL_FORM) {
      unit = this.constructor.TIME_PART_SINGULARS.get(unit) ?? unit;
    }
    unit = unit ? ` ${unit}` : "";

    if (this.constructor.SINGLE_STRING_INTERVAL) {
      const this_ = expression.this ? expression.this.name : "";
      if (this_) {
        interval_keyword = interval_keyword ? `${interval_keyword} ` : "";
        if (unit_expression && unit_expression instanceof exp.IntervalSpan) {
          return `${interval_keyword}'${this_}'${unit}`;
        }
        return `${interval_keyword}'${this_}${unit}'`;
      }
      return `${interval_keyword}${unit}`;
    }

    let this_ = this.sql(expression, "this");
    if (this_) {
      if (!include_keyword && expression.this.is_string) this_ = expression.this.name;
      if (!this.constructor.UNWRAPPED_INTERVAL_VALUES.some((cls) => expression.this instanceof cls)) {
        this_ = `(${this_})`;
      }
      if (include_keyword) this_ = ` ${this_}`;
    }

    return `${interval_keyword}${this_}${unit}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3989
  return_sql(expression) {
    return `RETURN ${this.sql(expression, "this")}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3992
  reference_sql(expression) {
    const this_ = this.sql(expression, "this");
    let expressions = this.expressions(expression, null, { flat: true });
    expressions = expressions ? `(${expressions})` : "";
    let options = this.expressions(expression, "options", { flat: true, sep: " " });
    options = options ? ` ${options}` : "";
    return `REFERENCES ${this_}${expressions}${options}`;
  }

  /**
   * py: sqlglot/generator.py:4000
   *
   * Ported for PORT_PLAN.md R32 (DuckDB generator scoping): several `TRANSFORMS`
   * lambdas build a function-call SQL STRING via `self.func(...)` and then feed that
   * string back into `exp.cast`/`maybe_parse`, which round-trips it through the
   * DEFAULT parser. A function name that parser does not recognize (e.g. `EPOCH`)
   * comes back as `exp.Anonymous`, so anything downstream that renders it needs this
   * method — not a DuckDB-specific gap, a base-Generator one any dialect can hit.
   */
  anonymous_sql(expression) {
    const parent = expression.parent;
    const is_qualified = parent instanceof exp.Dot && expression === parent.expression;
    return this.func(this.sql(expression, "this"), ...expression.expressions, { normalize: !is_qualified });
  }

  /**
   * py: sqlglot/generator.py:4009
   * @param {exp.Paren} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:4009
  paren_sql(expression) {
    const sql = this.seg(this.indent(this.sql(expression, "this")), "");
    return `(${sql}${this.seg(")", "")}`;
  }

  /** @returns {string} */
  // py: sqlglot/generator.py:4013
  neg_sql(expression) {
    // Keep adjacent minus signs from turning the operand into a SQL comment.
    const this_sql = this.sql(expression, "this");
    const sep = cpAt(this_sql, 0) === "-" ? " " : "";
    return `-${sep}${this_sql}`;
  }

  /** @returns {string} */
  // py: sqlglot/generator.py:4019
  not_sql(expression) { return `NOT ${this.sql(expression, "this")}`; }

  /**
   * py: sqlglot/generator.py:4022
   * @param {exp.Alias} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:4022
  alias_sql(expression) {
    let alias = this.sql(expression, "alias");
    alias = alias ? ` AS ${alias}` : "";
    return `${this.sql(expression, "this")}${alias}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4027
  pivotalias_sql(expression) {
    const alias = expression.args.alias;

    const parent = expression.parent;
    const pivot = parent && parent.parent;

    if (pivot instanceof exp.Pivot && pivot.unpivot) {
      const identifier_alias = alias instanceof exp.Identifier;
      const literal_alias = alias instanceof exp.Literal;

      if (identifier_alias && !this.constructor.UNPIVOT_ALIASES_ARE_IDENTIFIERS) {
        alias.replace(exp.Literal.string(alias.outputName));
      } else if (!identifier_alias && literal_alias && this.constructor.UNPIVOT_ALIASES_ARE_IDENTIFIERS) {
        alias.replace(exp.toIdentifier(alias.outputName));
      }
    }

    return this.alias_sql(expression);
  }

  /**
   * py: sqlglot/generator.py:4044
   * @param {exp.Aliases} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:4044
  aliases_sql(expression) { return `${this.sql(expression, "this")} AS (${this.expressions(expression, null, { flat: true })})`; }

  /** @returns {*} */
  // py: sqlglot/generator.py:4047
  atindex_sql(expression) {
    const this_ = this.sql(expression, "this");
    const index = this.sql(expression, "expression");
    return `${this_} AT ${index}`;
  }

  /**
   * py: sqlglot/generator.py:4052
   * @param {exp.AtTimeZone} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:4052
  attimezone_sql(expression) {
    const this_ = this.sql(expression, "this");
    const zone = this.sql(expression, "zone");
    return `${this_} AT TIME ZONE ${zone}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4057
  fromtimezone_sql(expression) {
    const this_ = this.sql(expression, "this");
    const zone = this.sql(expression, "zone");
    return `${this_} AT TIME ZONE ${zone} AT TIME ZONE 'UTC'`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4062
  fromiso8601date_sql(expression) {
    return this.sql(exp.cast(expression.this, exp.DType.DATE));
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4065
  fromiso8601timestamp_sql(expression) {
    return this.sql(exp.cast(expression.this, exp.DType.TIMESTAMPTZ));
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4068
  fromiso8601timestampnanos_sql(expression) {
    return this.sql(exp.cast(expression.this, exp.DType.TIMESTAMPTZ));
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4071
  add_sql(expression) { return this.binary(expression, "+"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4074
  and_sql(expression, stack = null) { return this.connector_sql(expression, "AND", stack); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4077
  or_sql(expression, stack = null) { return this.connector_sql(expression, "OR", stack); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4080
  xor_sql(expression, stack = null) {
    return this.connector_sql(expression, "XOR", stack);
  }

  /**
   * py: sqlglot/generator.py:4083 `connector_sql(expression, op, stack=None)`
   *
   * Iterative (mirrors `binary` above): `stack !== null` is the RECURSIVE-CALL branch —
   * `and_sql`/`or_sql` reach it via `getattr(self, f"{node.key}_sql")(node, stack)`
   * below — and the top-level call (stack omitted) drives the loop. `ops` is a `Set` of
   * already-rendered operator STRINGS (not nodes): when the same operator string
   * appears twice in a row in `sqls`, the later occurrence is merged onto the prior
   * entry rather than appended as a new one — this is what keeps `a AND b AND c` from
   * rendering as three separate joins.
   * @param {exp.Connector} expression
   * @param {string} op
   * @param {(string|exp.Expr)[]|null} [stack]
   * @returns {string}
   */
  // py: sqlglot/generator.py:4083
  connector_sql(expression, op, stack = null) {
    if (stack !== null && stack !== undefined) {
      stack.push(expression.right);
      if (expression.comments && expression.comments.length && this.comments) {
        op = this.maybe_comment(op, null, { comments: expression.comments });
      }

      stack.push(op, expression.left);
      return op;
    }

    stack = [expression];
    const sqls = [];
    const ops = new Set();

    while (stack.length) {
      const node = stack.pop();
      if (node instanceof exp.Connector) {
        ops.add(this[`${node.key}_sql`](node, stack));
      } else {
        const sql = this.sql(node);
        if (sqls.length && ops.has(sqls[sqls.length - 1])) {
          sqls[sqls.length - 1] += ` ${sql}`;
        } else {
          sqls.push(sql);
        }
      }
    }

    const sep = this.pretty && this.too_wide(sqls) ? "\n" : " ";
    return sqls.join(sep);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4115
  bitwiseand_sql(expression) { return this.binary(expression, "&"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4118
  // py: sqlglot/generator.py:4118
  bitwiseleftshift_sql(expression) {
    return this.binary(expression, "<<");
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4121
  // py: sqlglot/generator.py:4121
  bitwisenot_sql(expression) {
    return `~${this.sql(expression, "this")}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4124
  // py: sqlglot/generator.py:4124
  bitwiseor_sql(expression) {
    return this.binary(expression, "|");
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4127
  // py: sqlglot/generator.py:4127
  bitwiserightshift_sql(expression) {
    return this.binary(expression, ">>");
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4130
  // py: sqlglot/generator.py:4130
  bitwisexor_sql(expression) {
    return this.binary(expression, "^");
  }

  /**
   * py: sqlglot/generator.py:4133 `cast_sql(expression, safe_prefix=None)`
   * @param {exp.Cast} expression
   * @param {string|null} [safe_prefix]
   * @returns {string}
   */
  // py: sqlglot/generator.py:4133
  cast_sql(expression, safe_prefix = null) {
    let format_sql = this.sql(expression, "format");
    format_sql = format_sql ? ` FORMAT ${format_sql}` : "";
    let to_sql = this.sql(expression, "to");
    to_sql = to_sql ? ` ${to_sql}` : "";
    let action = this.sql(expression, "action");
    action = action ? ` ${action}` : "";
    let default_ = this.sql(expression, "default");
    default_ = default_ ? ` DEFAULT ${default_} ON CONVERSION ERROR` : "";
    return `${safe_prefix || ""}CAST(${this.sql(expression, "this")} AS${to_sql}${default_}${format_sql}${action})`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4145
  strtotime_sql(expression) {
    return this.func("STR_TO_TIME", expression.this, expression.args.format);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4149
  // py: sqlglot/generator.py:4149
  strtodate_sql(expression) {
    return this.func("STR_TO_DATE", expression.this, expression.args.format);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4152
  // py: sqlglot/generator.py:4152
  parsedatetime_sql(expression) {
    return this.func(
      "PARSE_DATETIME",
      expression.this,
      expression.args.format,
      expression.args.zone
    );
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4160
  currentdate_sql(expression) {
    const zone = this.sql(expression, "this");
    return zone ? `CURRENT_DATE(${zone})` : "CURRENT_DATE";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4164
  collate_sql(expression) {
    if (this.constructor.COLLATE_IS_FUNC) {
      return this.function_fallback_sql(expression);
    }
    return this.binary(expression, "COLLATE");
  }

  /**
   * py: sqlglot/generator.py:4169
   * @param {exp.Command} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:4169
  command_sql(expression) {
    return `${this.sql(expression, "this")} ${pyStrip(expression.text("expression"))}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4172
  // py: sqlglot/generator.py:4172
  comment_sql(expression) {
    const this_ = this.sql(expression, "this");
    const kind = expression.args.kind;
    const materialized = expression.args.materialized ? " MATERIALIZED" : "";
    const exists_sql = expression.args.exists ? " IF EXISTS " : " ";
    const expression_sql = this.sql(expression, "expression");
    // deny:implicit_str sqlglot/generator.py:4178 — `kind` is a bare Python string
    // (`kind.text`, a Token's `.text`) at `exp.Comment`'s only construction site
    // (`parser.py:_parse_comment`), never an `Expr`; a plain template-literal
    // interpolation is correct.
    return `COMMENT${exists_sql}ON${materialized} ${kind} ${this_} IS ${expression_sql}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4180
  mergetreettlaction_sql(expression) {
    const this_ = this.sql(expression, "this");
    const delete_ = expression.args.delete ? " DELETE" : "";
    let recompress = this.sql(expression, "recompress");
    recompress = recompress ? ` RECOMPRESS ${recompress}` : "";
    let to_disk = this.sql(expression, "to_disk");
    to_disk = to_disk ? ` TO DISK ${to_disk}` : "";
    let to_volume = this.sql(expression, "to_volume");
    to_volume = to_volume ? ` TO VOLUME ${to_volume}` : "";
    return `${this_}${delete_}${recompress}${to_disk}${to_volume}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4191
  mergetreettl_sql(expression) {
    const where = this.sql(expression, "where");
    const group = this.sql(expression, "group");
    let aggregates = this.expressions(expression, "aggregates");
    aggregates = aggregates ? this.seg("SET") + this.seg(aggregates) : "";

    if (!(where || group || aggregates) && expression.expressions.length === 1) {
      return `TTL ${this.expressions(expression, null, { flat: true })}`;
    }

    return `TTL${this.seg(this.expressions(expression))}${where}${group}${aggregates}`;
  }

  /**
   * py: sqlglot/generator.py:4202
   * @param {exp.Transaction} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:4202
  transaction_sql(expression) {
    let modes = this.expressions(expression, "modes");
    modes = modes ? ` ${modes}` : "";
    return `BEGIN${modes}`;
  }

  /**
   * py: sqlglot/generator.py:4207
   * @param {exp.Commit} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:4207
  commit_sql(expression) {
    let chain = expression.args.chain;
    if (chain !== null && chain !== undefined) chain = chain ? " AND CHAIN" : " AND NO CHAIN";
    return `COMMIT${chain || ""}`;
  }

  /**
   * py: sqlglot/generator.py:4214
   * @param {exp.Rollback} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:4214
  rollback_sql(expression) {
    // py: `savepoint = f" TO {savepoint}"` implicitly calls `Expression.__str__` (self.sql()).
    // This port's `toString()` is a debug repr, not `sql()` — must go through `this.sql()`.
    const savepoint = expression.args.savepoint;
    return `ROLLBACK${savepoint ? ` TO ${this.sql(savepoint)}` : ""}`;
  }

  /**
   * py: sqlglot/generator.py:4219
   * @param {exp.AlterColumn} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:4219
  altercolumn_sql(expression) {
    const this_ = this.sql(expression, "this");

    let exists = "";
    if (expression.args.exists) {
      if (this.constructor.SUPPORTS_ALTER_COLUMN_IF_EXISTS) {
        exists = " IF EXISTS";
      } else {
        this.unsupported("ALTER COLUMN IF EXISTS is not supported by this dialect");
      }
    }

    const dtype = this.sql(expression, "dtype");
    if (dtype) {
      const collate_ = this.sql(expression, "collate");
      const collate = collate_ ? ` COLLATE ${collate_}` : "";
      const using_ = this.sql(expression, "using");
      const using = using_ ? ` USING ${using_}` : "";
      const alter_set_type = this.constructor.ALTER_SET_TYPE ? `${this.constructor.ALTER_SET_TYPE} ` : "";
      const null_constraint = this._alter_column_null_constraint_sql(expression);

      return `ALTER COLUMN${exists} ${this_} ${alter_set_type}${dtype}${collate}${using}${null_constraint}`;
    }

    const default_ = this.sql(expression, "default");
    if (default_) {
      return `ALTER COLUMN${exists} ${this_} SET DEFAULT ${default_}`;
    }

    const comment = this.sql(expression, "comment");
    if (comment) {
      return `ALTER COLUMN${exists} ${this_} COMMENT ${comment}`;
    }

    // deny:implicit_str sqlglot/generator.py:4253 -- the deny scanner flags `visible` as
    // "could be an Expr arg" from its `.args.get(...)` shape alone, but the only two
    // sites that ever set it (parser.py:9137/9141) assign the plain string literal
    // "VISIBLE"/"INVISIBLE", never an `exp.Expr` -- a bare template literal is correct.
    const visible = expression.args.visible;
    if (visible) {
      return `ALTER COLUMN${exists} ${this_} SET ${visible}`;
    }

    const allow_null = expression.args.allow_null;
    const drop = expression.args.drop;

    if (!drop && !allow_null) {
      this.unsupported("Unsupported ALTER COLUMN syntax");
    }

    if (allow_null !== null && allow_null !== undefined) {
      const keyword = drop ? "DROP" : "SET";
      return `ALTER COLUMN${exists} ${this_} ${keyword} NOT NULL`;
    }

    return `ALTER COLUMN${exists} ${this_} DROP DEFAULT`;
  }

  /**
   * py: sqlglot/generator.py:4267
   * @param {exp.AlterColumn} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:4267
  _alter_column_null_constraint_sql(expression) {
    const allow_null = expression.args.allow_null;
    if (allow_null === null || allow_null === undefined) return "";

    if (!this.constructor.SUPPORTS_ALTER_COLUMN_NULLABILITY) {
      this.unsupported("ALTER COLUMN cannot set nullability along with a type");
      return "";
    }

    return allow_null ? " NULL" : " NOT NULL";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4278
  modifycolumn_sql(expression) {
    const this_ = this.sql(expression, "this");
    const rename_from = this.sql(expression, "rename_from");
    if (rename_from) {
      if (!this.constructor.SUPPORTS_CHANGE_COLUMN) {
        this.unsupported("CHANGE COLUMN is not supported in this dialect");
      }
      return `CHANGE COLUMN ${rename_from} ${this_}`;
    }
    if (!this.constructor.SUPPORTS_MODIFY_COLUMN) {
      this.unsupported("MODIFY COLUMN is not supported in this dialect");
    }
    return `MODIFY COLUMN ${this_}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4289
  alterindex_sql(expression) {
    const this_ = this.sql(expression, "this");

    const visible = expression.args.visible;
    const visible_sql = visible ? "VISIBLE" : "INVISIBLE";

    return `ALTER INDEX ${this_} ${visible_sql}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4297
  // py: sqlglot/generator.py:4297
  alterdiststyle_sql(expression) {
    let this_ = this.sql(expression, "this");
    if (!(expression.this instanceof exp.Var)) {
      this_ = `KEY DISTKEY ${this_}`;
    }
    return `ALTER DISTSTYLE ${this_}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4303
  // py: sqlglot/generator.py:4303
  altersortkey_sql(expression) {
    const compound = expression.args.compound ? " COMPOUND" : "";
    const this_ = this.sql(expression, "this");
    let expressions = this.expressions(expression, null, { flat: true });
    expressions = expressions ? `(${expressions})` : "";
    return `ALTER${compound} SORTKEY ${this_ || expressions}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4310
  alterrename_sql(expression, include_to = true) {
    if (!this.constructor.RENAME_TABLE_WITH_DB) {
      // Remove db from tables
      expression = expression
        .transform((n) => (n instanceof exp.Table ? exp.table_(n.this) : n))
        .assertIs(exp.AlterRename);
    }
    const this_ = this.sql(expression, "this");
    const to_kw = include_to ? " TO" : "";
    return `RENAME${to_kw} ${this_}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4320
  renamecolumn_sql(expression) {
    const exists = expression.args.exists ? " IF EXISTS" : "";
    const old_column = this.sql(expression, "this");
    const new_column = this.sql(expression, "to");
    return `RENAME COLUMN${exists} ${old_column} TO ${new_column}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4326
  // py: sqlglot/generator.py:4326
  alterset_sql(expression) {
    let exprs = this.expressions(expression, null, { flat: true });
    if (this.constructor.ALTER_SET_WRAPPED) {
      exprs = `(${exprs})`;
    }

    return `SET ${exprs}`;
  }

  /**
   * py: sqlglot/generator.py:4333
   * @param {exp.Alter} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:4333
  alter_sql(expression) {
    const actions = expression.args.actions;

    let actions_sql;
    // deny:operators sqlglot/generator.py:4337 — plain JS array indexing into the `actions`
    // list (`actions[0]`), not `exp.Bracket` construction; same false-positive shape as :2556.
    // Surfaced only now: the scanner's window attributed this site to the adjacent
    // `alterset_sql` stub until AIR-2278 ported it (R86/R91-class window misattribution).
    if (!this.dialect.ALTER_TABLE_ADD_REQUIRED_FOR_EACH_COLUMN && actions[0] instanceof exp.ColumnDef) {
      actions_sql = `ADD ${this.expressions(expression, "actions", { flat: true })}`;
    } else {
      const actions_list = [];
      for (const action of actions) {
        let action_sql;
        if (action instanceof exp.ColumnDef || action instanceof exp.Schema) {
          action_sql = this.add_column_sql(action);
        } else {
          action_sql = this.sql(action);
          if (action instanceof exp.Query) action_sql = `AS ${action_sql}`;
        }
        actions_list.push(action_sql);
      }
      actions_sql = pyLstrip(this.format_args(...actions_list), "\n");
    }

    const iceberg =
      expression.args.iceberg && this.constructor.SUPPORTS_DROP_ALTER_ICEBERG_PROPERTY
        ? "ICEBERG "
        : "";
    const exists = expression.args.exists ? " IF EXISTS" : "";
    let on_cluster = this.sql(expression, "cluster");
    on_cluster = on_cluster ? ` ${on_cluster}` : "";
    const only = expression.args.only ? " ONLY" : "";
    let options = this.expressions(expression, "options");
    options = options ? `, ${options}` : "";
    const kind = this.sql(expression, "kind");
    const not_valid = expression.args.not_valid ? " NOT VALID" : "";
    const check = expression.args.check ? " WITH CHECK" : "";
    const cascade =
      expression.args.cascade && this.dialect.ALTER_TABLE_SUPPORTS_CASCADE ? " CASCADE" : "";
    let this_ = this.sql(expression, "this");
    this_ = this_ ? ` ${this_}` : "";

    return `ALTER ${iceberg}${kind}${exists}${only}${this_}${on_cluster}${check}${this.sep()}${actions_sql}${not_valid}${options}${cascade}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4379
  altersession_sql(expression) {
    const items_sql = this.expressions(expression, null, { flat: true });
    const keyword = expression.args.unset ? "UNSET" : "SET";
    return `${keyword} ${items_sql}`;
  }

  /**
   * py: sqlglot/generator.py:4384
   * @param {exp.Expr} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:4384
  add_column_sql(expression) {
    const sql = this.sql(expression);
    let column_text;
    if (expression instanceof exp.Schema) {
      column_text = " COLUMNS";
    } else if (expression instanceof exp.ColumnDef && this.constructor.ALTER_TABLE_INCLUDE_COLUMN_KEYWORD) {
      column_text = " COLUMN";
    } else {
      column_text = "";
    }
    return `ADD${column_text} ${sql}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4395
  droppartition_sql(expression) {
    const expressions = this.expressions(expression);
    const exists = expression.args.exists ? " IF EXISTS " : " ";
    return `DROP${exists}${expressions}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4400
  dropprimarykey_sql(expression) {
    return "DROP PRIMARY KEY";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4403
  // py: sqlglot/generator.py:4403
  addconstraint_sql(expression) {
    return `ADD ${this.expressions(expression, null, { indent: false })}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4406
  // py: sqlglot/generator.py:4406
  addpartition_sql(expression) {
    const exists = expression.args.exists ? "IF NOT EXISTS " : "";
    let location = this.sql(expression, "location");
    location = location ? ` ${location}` : "";
    return `ADD ${exists}${this.sql(expression.this)}${location}`;
  }

  /**
   * py: sqlglot/generator.py:4412
   * @param {exp.Distinct} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:4412
  distinct_sql(expression) {
    let this_ = this.expressions(expression, null, { flat: true });

    if (!this.constructor.MULTI_ARG_DISTINCT && expression.expressions.length > 1) {
      let case_ = exp.case_();
      for (const arg of expression.expressions) {
        case_ = case_.when(arg.is_(exp.null_()), exp.null_());
      }
      this_ = this.sql(case_.else_(`(${this_})`));
    }

    this_ = this_ ? ` ${this_}` : "";

    let on = this.sql(expression, "on");
    on = on ? ` ON ${on}` : "";
    return `DISTINCT${this_}${on}`;
  }

  /**
   * py: sqlglot/generator.py:4427
   * @param {exp.IgnoreNulls} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:4427
  ignorenulls_sql(expression) { return this._embed_ignore_nulls(expression, "IGNORE NULLS"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4430
  respectnulls_sql(expression) { return this._embed_ignore_nulls(expression, "RESPECT NULLS"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4433
  havingmax_sql(expression) {
    const this_sql = this.sql(expression, "this");
    const expression_sql = this.sql(expression, "expression");
    const kind = expression.args.max ? "MAX" : "MIN";
    return `${this_sql} HAVING ${kind} ${expression_sql}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4439
  intdiv_sql(expression) {
    return this.sql(
      new exp.Cast({
        this: new exp.Div({ this: expression.this, expression: expression.expression }),
        to: new exp.DataType({ this: exp.DType.INT }),
      }),
    );
  }

  /**
   * py: sqlglot/generator.py:4447
   * @param {exp.DPipe} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:4447
  dpipe_sql(expression) {
    if (this.dialect.STRICT_STRING_CONCAT && expression.args.safe) {
      return this.func("CONCAT", ...[...expression.flatten()].map((e) => exp.cast(e, exp.DType.TEXT)));
    }
    return this.binary(expression, "||");
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4452
  div_sql(expression) {
    const l = expression.left, r = expression.right;

    if (!this.dialect.SAFE_DIVISION && expression.args.safe) {
      r.replace(new exp.Nullif({ this: r.copy(), expression: exp.Literal.number(0) }));
    }

    if (this.dialect.TYPED_DIVISION && !expression.args.typed) {
      if (!l.isType(...exp.DataType.REAL_TYPES) && !r.isType(...exp.DataType.REAL_TYPES)) {
        l.replace(exp.cast(l.copy(), exp.DType.DOUBLE));
      }
    } else if (!this.dialect.TYPED_DIVISION && expression.args.typed) {
      if (l.isType(...exp.DataType.INTEGER_TYPES) && r.isType(...exp.DataType.INTEGER_TYPES)) {
        return this.sql(exp.cast(l.div(r), exp.DType.BIGINT));
      }
    }

    return this.binary(expression, "/");
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4473
  safedivide_sql(expression) {
    const n = _wrap(expression.this, exp.Binary);
    const d = _wrap(expression.expression, exp.Binary);
    // deny:operators sqlglot/generator.py:4476 — `n / d` is `Expr.__truediv__`,
    // which builds `exp.Div`; `.div()` is that same constructor.
    return this.sql(new exp.If({ this: d.neq(0), true: n.div(d), false: new exp.Null() }));
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4478
  overlaps_sql(expression) {
    return this.binary(expression, "OVERLAPS");
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4481
  distance_sql(expression) {
    return this.binary(expression, "<->");
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4484
  distancend_sql(expression) {
    return this.binary(expression, "<<->>");
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4487
  dot_sql(expression) {
    return `${this.sql(expression, "this")}.${this.sql(expression, "expression")}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4490
  eq_sql(expression) { return this.binary(expression, "="); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4493
  propertyeq_sql(expression) {
    return this.binary(expression, ":=");
  }

  /**
   * py: sqlglot/generator.py:4496
   * @param {exp.Escape} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:4496
  escape_sql(expression) {
    const this_ = expression.this;
    if (
      (this_ instanceof exp.Like || this_ instanceof exp.ILike) &&
      (this_.expression instanceof exp.All || this_.expression instanceof exp.Any) &&
      !this.constructor.SUPPORTS_LIKE_QUANTIFIERS
    ) {
      return this._like_sql(this_, expression);
    }
    return this.binary(expression, "ESCAPE");
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4506
  glob_sql(expression) {
    return this.binary(expression, "GLOB");
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4509
  gt_sql(expression) { return this.binary(expression, ">"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4512
  gte_sql(expression) { return this.binary(expression, ">="); }

  /**
   * py: sqlglot/generator.py:4515
   * @param {exp.Is} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:4515
  is_sql(expression) {
    const negate = expression.args.negate;
    if (!this.constructor.IS_BOOL_ALLOWED && expression.expression instanceof exp.Boolean) {
      const positive = Boolean(expression.expression.this) !== Boolean(negate);
      return this.sql(positive ? expression.this : exp.not_(expression.this));
    }
    return this.binary(expression, negate ? "IS NOT" : "IS");
  }

  /**
   * py: sqlglot/generator.py:4522
   * @param {exp.Like|exp.ILike} expression
   * @param {exp.Escape|null} [escape]
   * @returns {string}
   */
  // py: sqlglot/generator.py:4522
  _like_sql(expression, escape = null) {
    const this_ = expression.this;
    const rhs = expression.expression;

    let exp_class, op;
    if (expression instanceof exp.Like) {
      exp_class = exp.Like;
      op = "LIKE";
    } else {
      exp_class = exp.ILike;
      op = "ILIKE";
    }

    if (expression.args.negate) op = `NOT ${op}`;

    if ((rhs instanceof exp.All || rhs instanceof exp.Any) && !this.constructor.SUPPORTS_LIKE_QUANTIFIERS) {
      let exprs = rhs.this.unnest();
      exprs = exprs instanceof exp.Tuple ? exprs.expressions : [exprs];

      const connective = rhs instanceof exp.Any ? exp.or_ : exp.and_;

      const _make_like = (expr) => {
        let like = new exp_class({ this: this_, expression: expr, negate: expression.args.negate });
        if (escape) like = new exp.Escape({ this: like, expression: escape.expression.copy() });
        return like;
      };

      let like_expr = _make_like(exprs[0]);
      for (const expr of exprs.slice(1)) {
        like_expr = connective(like_expr, _make_like(expr), { copy: false });
      }

      const parent = escape ? escape.parent : expression.parent;
      if (!(parent instanceof like_expr.constructor || parent instanceof exp.Paren) && parent instanceof exp.Condition) {
        like_expr = new exp.Paren({ this: like_expr });
      }

      return this.sql(like_expr);
    }

    return this.binary(expression, op);
  }

  /**
   * py: sqlglot/generator.py:4572
   * @param {exp.Like} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:4572
  like_sql(expression) { return this._like_sql(expression); }

  /**
   * py: sqlglot/generator.py:4575
   * @param {exp.ILike} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:4575
  ilike_sql(expression) { return this._like_sql(expression); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4578
  match_sql(expression) {
    return this.binary(expression, "MATCH");
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4581
  similarto_sql(expression) {
    return this.binary(expression, "SIMILAR TO");
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4584
  lt_sql(expression) { return this.binary(expression, "<"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4587
  lte_sql(expression) { return this.binary(expression, "<="); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4590
  mod_sql(expression) { return this.binary(expression, "%"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4593
  mul_sql(expression) { return this.binary(expression, "*"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4596
  neq_sql(expression) { return this.binary(expression, "<>"); }

  /** py: sqlglot/generator.py:4599 — ported for PORT_PLAN.md R32 (DuckDB's `EqualNull` TRANSFORMS entry builds a `NullSafeEQ` node and renders it through this method). */
  nullsafeeq_sql(expression) { return this.binary(expression, "IS NOT DISTINCT FROM"); }

  /** py: sqlglot/generator.py:4602 */
  nullsafeneq_sql(expression) { return this.binary(expression, "IS DISTINCT FROM"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4605
  sub_sql(expression) { return this.binary(expression, "-"); }

  /**
   * py: sqlglot/generator.py:4608
   * @param {exp.TryCast} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:4608
  trycast_sql(expression) { return this.cast_sql(expression, "TRY_"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4611
  jsoncast_sql(expression) {
    return this.cast_sql(expression);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4614
  try_sql(expression) {
    if (!this.constructor.TRY_SUPPORTED) {
      this.unsupported("Unsupported TRY function");
      return this.sql(expression, "this");
    }

    return this.func("TRY", expression.this);
  }

  /**
   * py: sqlglot/generator.py:4621
   * @param {exp.Log} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:4621
  log_sql(expression) {
    let this_ = expression.this;
    let expr = expression.expression;

    if (this.dialect.LOG_BASE_FIRST === false) {
      [this_, expr] = [expr, this_];
    } else if (this.dialect.LOG_BASE_FIRST === null && expr) {
      if (this_.name === "2" || this_.name === "10") {
        return this.func(`LOG${this_.name}`, expr);
      }

      this.unsupported(`Unsupported logarithm with base ${this.sql(this_)}`);
    }

    return this.func("LOG", this_, expr);
  }

  /**
   * py: sqlglot/generator.py:4635
   * @param {exp.Use} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:4635
  use_sql(expression) {
    let kind = this.sql(expression, "kind");
    kind = kind ? ` ${kind}` : "";
    let this_ = this.sql(expression, "this") || this.expressions(expression, null, { flat: true });
    this_ = this_ ? ` ${this_}` : "";
    return `USE${kind}${this_}`;
  }

  /**
   * py: sqlglot/generator.py:4642
   *
   * Iterative, not recursive (rule mirrored from `connector_sql` below): a `stack` of
   * pending nodes/strings, popped LIFO. `type(node) is binary_type` is EXACT-class
   * comparison (not `instanceof`), matching upstream's `type(node) is binary_type` —
   * a `Cast` nested under an `Add` must not be mistaken for another `Add` layer.
   * @param {exp.Binary} expression
   * @param {string} op
   * @returns {string}
   */
  // py: sqlglot/generator.py:4642
  binary(expression, op) {
    const sqls = [];
    const stack = [expression];
    const binary_type = expression.constructor;

    while (stack.length) {
      const node = stack.pop();

      if (node !== null && typeof node === "object" && node.constructor === binary_type) {
        const op_func = node.args.operator;
        let node_op = op;
        if (op_func) node_op = `OPERATOR(${this.sql(op_func)})`;

        stack.push(node.args.expression);
        stack.push(` ${this.maybe_comment(node_op, null, { comments: node.comments })} `);
        stack.push(node.args.this);
      } else {
        sqls.push(this.sql(node));
      }
    }

    return sqls.join("");
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4663
  ceil_floor(expression) {
    const to_clause = this.sql(expression, "to");
    if (to_clause) {
      return `${expression.constructor.sqlName()}(${this.sql(expression, "this")} TO ${to_clause})`;
    }

    return this.function_fallback_sql(expression);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4670
  function_fallback_sql(expression) {
    const args = [];

    // py: `for key in expression.arg_types` — DECLARATION ORDER, which is what makes
    // the rendered argument order right. `argTypes` is a Map, so its iteration order is
    // insertion order, and `_gen/expr_meta.js` records upstream's own `arg_types` order.
    for (const key of expression.constructor.argTypes.keys()) {
      const arg_value = expression.args[key];

      if (Array.isArray(arg_value)) {
        for (const value of arg_value) args.push(value);
      } else if (arg_value !== null && arg_value !== undefined) {
        // py: `elif arg_value is not None` — an explicit `False` or `0` IS appended.
        args.push(arg_value);
      }
    }

    const name = this.dialect.PRESERVE_ORIGINAL_NAMES
      ? expression.metaGet("name") || expression.constructor.sqlName()
      : expression.constructor.sqlName();

    return this.func(name, ...args);
  }

  /**
   * py: sqlglot/generator.py:4689 `func(name, *args, prefix="(", suffix=")", normalize=True)`
   *
   * `prefix`/`suffix`/`normalize` are KEYWORD-ONLY after a var-args list, so they arrive
   * as a trailing options object (rule 2). Passing one positionally would silently make
   * it another ARGUMENT to render — R18's defect class exactly.
   * @param {string} name
   * @returns {string}
   */
  // py: sqlglot/generator.py:4689
  func(name, ...args) {
    const { prefix = "(", suffix = ")", normalize = true } = _trailingOptions(args);
    name = normalize ? this.normalize_func(name) : name;
    return `${name}${prefix}${this.format_args(...args)}${suffix}`;
  }

  /**
   * py: sqlglot/generator.py:4700 `format_args(*args, sep=", ")`
   *
   * `sep` is keyword-only after var-args — trailing options object (rule 2).
   * @returns {string}
   */
  // py: sqlglot/generator.py:4700
  format_args(...args) {
    const { sep = ", " } = _trailingOptions(args);

    // py: `if arg is not None and not isinstance(arg, bool)` — booleans are dropped
    // outright, which is NOT the same as a falsy check: `0` and `""` survive.
    const arg_sqls = args
      .filter((arg) => arg !== null && arg !== undefined && typeof arg !== "boolean")
      .map((arg) => this.sql(arg));

    if (this.pretty && this.too_wide(arg_sqls)) {
      return this.indent("\n" + arg_sqls.join(`${pyStrip(sep)}\n`) + "\n", {
        skip_first: true,
        skip_last: true,
      });
    }
    return arg_sqls.join(sep);
  }

  /**
   * py: sqlglot/generator.py:4710 `sum(len(arg) for arg in args) > self.max_text_width`
   *
   * `len()` on a Python `str` counts CODE POINTS, so this is `cpLen`, never `.length`
   * (rule 3). This is the exact site review finding B2 / R4 names: a `.length` port
   * passes all 15,642 corpus rows and is still wrong, because the corpus is 0.024%
   * non-ASCII and every astral character makes JS count one too many.
   * @param {Iterable<string>} args
   * @returns {boolean}
   */
  // py: sqlglot/generator.py:4710
  too_wide(args) {
    let total = 0;
    for (const arg of args) total += cpLen(arg);
    return total > this.max_text_width;
  }

  /**
   * py: sqlglot/generator.py:4713
   * @param {exp.Expr} expression
   * @param {Map<string,string>|null} [inverse_time_mapping]
   * @param {*} [inverse_time_trie]
   * @returns {string|null}
   */
  // py: sqlglot/generator.py:4713
  format_time(expression, inverse_time_mapping = null, inverse_time_trie = null) {
    return formatTime(
      this.sql(expression, "format"),
      inverse_time_mapping || this.dialect.INVERSE_TIME_MAPPING,
      inverse_time_trie || this.dialect.INVERSE_TIME_TRIE,
    );
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4725
  expressions(expression = null, key = null, options = {}) {
    const {
      sqls = null,
      flat = false,
      indent = true,
      skip_first = false,
      skip_last = false,
      sep = ", ",
      prefix = "",
      dynamic = false,
      new_line = false,
    } = options;

    const expressions = expression ? expression.args[key || "expressions"] : sqls;

    if (!expressions || !expressions.length) return "";

    if (flat) {
      return expressions
        .map((e) => this.sql(e))
        .filter((sql) => sql)
        .join(sep);
    }

    const num_sqls = expressions.length;
    const result_sqls = [];

    for (let i = 0; i < expressions.length; i++) {
      const e = expressions[i];
      const sql = this.sql(e, null, false);
      if (!sql) continue;

      const comments = e instanceof exp.Expr ? this.maybe_comment("", e) : "";

      if (this.pretty) {
        if (this.leading_comma) {
          result_sqls.push(`${i > 0 ? sep : ""}${prefix}${sql}${comments}`);
        } else {
          const tail = i + 1 < num_sqls ? (comments ? pyRstrip(sep) : sep) : "";
          result_sqls.push(`${prefix}${sql}${tail}${comments}`);
        }
      } else {
        result_sqls.push(`${prefix}${sql}${comments}${i + 1 < num_sqls ? sep : ""}`);
      }
    }

    let result_sql;
    if (this.pretty && (!dynamic || this.too_wide(result_sqls))) {
      if (new_line) {
        result_sqls.unshift("");
        result_sqls.push("");
      }
      result_sql = result_sqls.map((s) => pyRstrip(s)).join("\n");
    } else {
      result_sql = result_sqls.join("");
    }

    return indent ? this.indent(result_sql, { skip_first, skip_last }) : result_sql;
  }

  /**
   * py: sqlglot/generator.py:4781 `op_expressions(op, expression, flat=False)`
   * @param {string} op
   * @param {exp.Expr} expression
   * @param {boolean} [flat]
   * @returns {string}
   */
  // py: sqlglot/generator.py:4781
  op_expressions(op, expression, flat = false) {
    flat = flat || expression.parent instanceof exp.Properties;
    const expressions_sql = this.expressions(expression, null, { flat });
    if (flat) return `${op} ${expressions_sql}`;
    return `${this.seg(op)}${expressions_sql ? this.sep() : ""}${expressions_sql}`;
  }

  /**
   * py: sqlglot/generator.py:4788
   * @param {exp.Property} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:4788
  naked_property(expression) {
    const property_name = exp.Properties.PROPERTY_TO_NAME.get(expression.constructor);
    if (!property_name) this.unsupported(`Unsupported property ${expression.constructor.name}`);
    return `${property_name} ${this.sql(expression, "this")}`;
  }

  // py: sqlglot/generator.py:4794 `tag_sql`. Found during AIR-2121 (lineage.js):
  // `Node.to_html`'s non-Table branch wraps the node's own expression in an `exp.Tag`
  // to bold it within the rendered source, so this was the sole blocker for that path.
  //
  // deny:implicit_str sqlglot/generator.py:4795 -- `expression.this` IS routed through
  // an explicit `this.sql(...)` call (genuinely an Expr arg). `prefix`/`postfix` are
  // the other two `.args.get(...)` the deny scanner flagged, generically, as "could be
  // an Expr arg" -- but the only constructor of an `exp.Tag` anywhere this port
  // reaches (`src/lineage.js`'s `toHtml`) always passes plain JS strings
  // (`"<b>"`/`"</b>"`) for both, never an `Expr`, so no `.sql()` call is needed there.
  tag_sql(expression) {
    return `${expression.args.prefix ?? ""}${this.sql(expression.this)}${expression.args.postfix ?? ""}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4797
  token_sql(token_type) {
    return this.constructor.TOKEN_MAPPING.get(token_type) ?? TOKEN_TYPE_NAMES[token_type];
  }

  /**
   * py: sqlglot/generator.py:4800
   * @param {exp.UserDefinedFunction} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:4800
  userdefinedfunction_sql(expression) {
    const this_ = this.sql(expression, "this");
    let expressions = this.no_identify(this.expressions.bind(this), expression);
    expressions = expression.args.wrapped ? this.wrap(expressions) : ` ${expressions}`;
    return pyStrip(expressions) !== "" ? `${this_}${expressions}` : this_;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4808
  macrooverloads_sql(expression) {
    return this.expressions(expression, null, { flat: true });
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4811
  macrooverload_sql(expression) {
    const params = this.no_identify(this.expressions.bind(this), expression, null, { flat: true });
    const body = this.sql(expression, "this");
    const prefix = expression.args.is_table ? "TABLE " : "";
    return `(${params}) AS ${prefix}${body}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4817
  joinhint_sql(expression) {
    const this_ = this.sql(expression, "this");
    const expressions = this.expressions(expression, null, { flat: true });
    return `${this_}(${expressions})`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4822
  kwarg_sql(expression) { return this.binary(expression, "=>"); }

  // py: sqlglot/generator.py:4825 — ported alongside `generators/postgres.js`'s
  // `TRANSFORMS[exp.Merge]` (`merge_without_target_sql`), the first TRANSFORMS entry
  // in this port to reach `merge_sql` and, transitively, this and `whens_sql` below
  // (PORT_PLAN.md "Generator chain surfaces base-Generator gaps" precedent).
  when_sql(expression) {
    const matched = expression.args.matched ? "MATCHED" : "NOT MATCHED";
    const source = this.constructor.MATCHED_BY_SOURCE && expression.args.source ? " BY SOURCE" : "";
    let condition = this.sql(expression, "condition");
    condition = condition ? ` AND ${condition}` : "";

    const then_expression = expression.args.then;
    let then;
    if (then_expression instanceof exp.Insert) {
      let this_ = this.sql(then_expression, "this");
      this_ = this_ ? `INSERT ${this_}` : "INSERT";
      const then_sql = this.sql(then_expression, "expression");
      then = then_sql ? `${this_} VALUES ${then_sql}` : this_;
    } else if (then_expression instanceof exp.Update) {
      if (then_expression.args.expressions instanceof exp.Star) {
        then = `UPDATE ${this.sql(then_expression, "expressions")}`;
      } else {
        const expressions_sql = this.expressions(then_expression);
        then = expressions_sql ? `UPDATE SET${this.sep()}${expressions_sql}` : "UPDATE";
      }
    } else {
      then = this.sql(then_expression);
    }

    if (then_expression instanceof exp.Insert || then_expression instanceof exp.Update) {
      let where = this.sql(then_expression, "where");
      if (where && !this.constructor.SUPPORTS_MERGE_WHERE) {
        const kind = then_expression instanceof exp.Insert ? "INSERT" : "UPDATE";
        this.unsupported(`WHERE clause in MERGE ${kind} is not supported`);
        where = "";
      }
      then = `${then}${where}`;
    }

    return `WHEN ${matched}${source}${condition} THEN ${then}`;
  }

  /** py: sqlglot/generator.py:4855 */
  whens_sql(expression) {
    return this.expressions(expression, null, { sep: " ", indent: false });
  }

  /** py: sqlglot/generator.py:4858 */
  merge_sql(expression) {
    const table = expression.this;
    let table_alias = "";

    const hints = table.args.hints;
    // deny:operators sqlglot/generator.py:4863 — `hints` is a plain list of Expr, so
    // `hints[0]` is ordinary list indexing (`list.__getitem__`), not
    // `Expression.__getitem__` (which only builds `exp.Bracket` when `self` is an
    // Expr) — same false-positive shape as `lineage.py:627`/`generator.py:2556,2579`.
    // (Surfaced only because this lint's anchor regex doesn't recognize the
    // `/** py: ... */` single-line style `when_sql`/`whens_sql`/`merge_sql` use, so
    // deny-site ownership through 4863 fell to the nearest real `// py:`-style
    // anchor, `kwarg_sql`'s, once that stub went real — not a `merge_sql` defect.)
    if (hints && table.alias && hints[0] instanceof exp.WithTableHint) {
      // T-SQL syntax is MERGE ... <target_table> [WITH (<merge_hint>)] [[AS] table_alias]
      table_alias = ` AS ${this.sql(table.args.alias.pop())}`;
    }

    const this_ = this.sql(table);
    const using = `USING ${this.sql(expression, "using")}`;
    let whens = this.sql(expression, "whens");

    let on = this.sql(expression, "on");
    on = on ? `ON ${on}` : "";

    if (!on) {
      on = this.expressions(expression, "using_cond");
      on = on ? `USING (${on})` : "";
    }

    const returning = this.sql(expression, "returning");
    if (returning) {
      whens = `${whens}${returning}`;
    }

    const sep = this.sep();

    return this.prepend_ctes(
      expression,
      `MERGE INTO ${this_}${table_alias}${sep}${using}${sep}${on}${sep}${whens}`,
    );
  }

  // py: sqlglot/generator.py:4889 `@unsupported_args("format") def tochar_sql(self, expression)`
  // — the `this`-forwarding shim onto `_tochar_sql` below (module scope, after this
  // class, same split as `generators/hive.js`'s `trunc_sql`/`_trunc_sql`, R27). Ported
  // alongside `generators/postgres.js`'s `TRANSFORMS[exp.ToChar]` (PORT_PLAN.md P4),
  // which calls this whenever the expression has no `format` arg.
  tochar_sql(expression) { return _tochar_sql(this, expression); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4894
  // py: sqlglot/generator.py:4894 `@unsupported_args("default") def tonumber_sql(self, expression)`
  // — the `this`-forwarding shim onto `_tonumber_sql` below (module scope), same split
  // as `tochar_sql`/`_tochar_sql`.
  tonumber_sql(expression) { return _tonumber_sql(this, expression); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4906
  dictproperty_sql(expression) {
    const this_ = this.sql(expression, "this");
    const kind = this.sql(expression, "kind");
    const settings_sql = this.expressions(expression, "settings", { sep: " " });
    const args = settings_sql ? `(${this.sep("")}${settings_sql}${this.seg(")", "")}` : "()";
    return `${this_}(${kind}${args})`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4913
  dictrange_sql(expression) {
    const this_ = this.sql(expression, "this");
    const max = this.sql(expression, "max");
    const min = this.sql(expression, "min");
    return `${this_}(MIN ${min} MAX ${max})`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4919
  dictsubproperty_sql(expression) {
    return `${this.sql(expression, "this")} ${this.sql(expression, "value")}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4922
  duplicatekeyproperty_sql(expression) {
    return `DUPLICATE KEY (${this.expressions(expression, null, { flat: true })})`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4926
  uniquekeyproperty_sql(expression, prefix = "UNIQUE KEY") {
    return `${prefix} (${this.expressions(expression, null, { flat: true })})`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4932
  distributedbyproperty_sql(expression) {
    let expressions = this.expressions(expression, null, { flat: true });
    expressions = expressions ? ` ${this.wrap(expressions)}` : "";
    const buckets_sql = this.sql(expression, "buckets");
    const kind = this.sql(expression, "kind");
    const buckets = buckets_sql ? ` BUCKETS ${buckets_sql}` : "";
    const order = this.sql(expression, "order");
    return `DISTRIBUTED BY ${kind}${expressions}${buckets}${order}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4941
  oncluster_sql(expression) {
    return "";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4944
  clusteredbyproperty_sql(expression) {
    const expressions = this.expressions(expression, "expressions", { flat: true });
    let sorted_by = this.expressions(expression, "sorted_by", { flat: true });
    sorted_by = sorted_by ? ` SORTED BY (${sorted_by})` : "";
    const buckets = this.sql(expression, "buckets");
    return `CLUSTERED BY (${expressions})${sorted_by} INTO ${buckets} BUCKETS`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4951
  // py: sqlglot/generator.py:4951
  anyvalue_sql(expression) {
    let this_ = this.sql(expression, "this");
    const having = this.sql(expression, "having");

    if (having) {
      this_ = `${this_} HAVING ${expression.args.max ? "MAX" : "MIN"} ${having}`;
    }

    return this.func("ANY_VALUE", this_);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4960
  querytransform_sql(expression) {
    const transform = this.func("TRANSFORM", ...expression.expressions);
    let row_format_before = this.sql(expression, "row_format_before");
    row_format_before = row_format_before ? ` ${row_format_before}` : "";
    let record_writer = this.sql(expression, "record_writer");
    record_writer = record_writer ? ` RECORDWRITER ${record_writer}` : "";
    const using = ` USING ${this.sql(expression, "command_script")}`;
    let schema = this.sql(expression, "schema");
    schema = schema ? ` AS ${schema}` : "";
    let row_format_after = this.sql(expression, "row_format_after");
    row_format_after = row_format_after ? ` ${row_format_after}` : "";
    let record_reader = this.sql(expression, "record_reader");
    record_reader = record_reader ? ` RECORDREADER ${record_reader}` : "";
    return `${transform}${row_format_before}${record_writer}${using}${schema}${row_format_after}${record_reader}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:4975
  indexconstraintoption_sql(expression) {
    const key_block_size = this.sql(expression, "key_block_size");
    if (key_block_size) return `KEY_BLOCK_SIZE = ${key_block_size}`;

    const using = this.sql(expression, "using");
    if (using) return `USING ${using}`;

    const parser = this.sql(expression, "parser");
    if (parser) return `WITH PARSER ${parser}`;

    const comment = this.sql(expression, "comment");
    if (comment) return `COMMENT ${comment}`;

    const visible = expression.args.visible;
    if (visible !== null && visible !== undefined) {
      return visible ? "VISIBLE" : "INVISIBLE";
    }

    const engine_attr = this.sql(expression, "engine_attr");
    if (engine_attr) return `ENGINE_ATTRIBUTE = ${engine_attr}`;

    const secondary_engine_attr = this.sql(expression, "secondary_engine_attr");
    if (secondary_engine_attr) return `SECONDARY_ENGINE_ATTRIBUTE = ${secondary_engine_attr}`;

    this.unsupported("Unsupported index constraint option.");
    return "";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5007
  checkcolumnconstraint_sql(expression) {
    const enforced = expression.args.enforced ? " ENFORCED" : "";
    return `CHECK (${this.sql(expression, "this")})${enforced}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5011
  indexcolumnconstraint_sql(expression) {
    let kind = this.sql(expression, "kind");
    kind = kind ? `${kind} INDEX` : "INDEX";
    let this_ = this.sql(expression, "this");
    this_ = this_ ? ` ${this_}` : "";
    let index_type = this.sql(expression, "index_type");
    index_type = index_type ? ` USING ${index_type}` : "";
    let expressions = this.expressions(expression, null, { flat: true });
    expressions = expressions ? ` (${expressions})` : "";
    let options = this.expressions(expression, "options", { sep: " " });
    options = options ? ` ${options}` : "";
    return `${kind}${this_}${index_type}${expressions}${options}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5024
  nvl2_sql(expression) {
    if (this.constructor.NVL2_SUPPORTED) return this.function_fallback_sql(expression);

    const case_ = new exp.Case().when(
      expression.this.is_(exp.null()).not_(false),
      expression.args.true,
      { copy: false },
    );
    const else_cond = expression.args.false;
    if (else_cond) case_.else_(else_cond, { copy: false });

    return this.sql(case_);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5039
  // py: sqlglot/generator.py:5039
  nthvalue_sql(expression) {
    if (expression.args.from_first === false) {
      this.unsupported("NTH_VALUE FROM LAST is not supported");
    }

    return this.function_fallback_sql(expression);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5045
  comprehension_sql(expression) {
    const this_ = this.sql(expression, "this");
    const expr = this.sql(expression, "expression");
    let position = this.sql(expression, "position");
    position = position ? `, ${position}` : "";
    const iterator = this.sql(expression, "iterator");
    let condition = this.sql(expression, "condition");
    condition = condition ? ` IF ${condition}` : "";
    return `${this_} FOR ${expr}${position} IN ${iterator}${condition}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5055
  columnprefix_sql(expression) {
    return `${this.sql(expression, "this")}(${this.sql(expression, "expression")})`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5058
  opclass_sql(expression) {
    return `${this.sql(expression, "this")} ${this.sql(expression, "expression")}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5061
  // py: sqlglot/generator.py:5061
  _ml_sql(expression, name) {
    let model = this.sql(expression, "this");
    model = `MODEL ${model}`;
    const expr = expression.expression;
    let expr_sql;
    if (expr) {
      expr_sql = this.sql(expression, "expression");
      expr_sql = expr instanceof exp.Table ? `TABLE ${expr_sql}` : expr_sql;
    } else {
      expr_sql = null;
    }

    const parameters = this.sql(expression, "params_struct") || null;

    return this.func(name, model, expr_sql, parameters);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5075
  // py: sqlglot/generator.py:5075
  predict_sql(expression) {
    return this._ml_sql(expression, "PREDICT");
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5078
  generateembedding_sql(expression) {
    const name = expression.args.is_text ? "GENERATE_TEXT_EMBEDDING" : "GENERATE_EMBEDDING";
    return this._ml_sql(expression, name);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5082
  generatetext_sql(expression) {
    return this._ml_sql(expression, "GENERATE_TEXT");
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5085
  generatetable_sql(expression) {
    return this._ml_sql(expression, "GENERATE_TABLE");
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5088
  generatebool_sql(expression) {
    return this._ml_sql(expression, "GENERATE_BOOL");
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5091
  generateint_sql(expression) {
    return this._ml_sql(expression, "GENERATE_INT");
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5094
  generatedouble_sql(expression) {
    return this._ml_sql(expression, "GENERATE_DOUBLE");
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5097
  mltranslate_sql(expression) {
    return this._ml_sql(expression, "TRANSLATE");
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5100
  mlforecast_sql(expression) {
    return this._ml_sql(expression, "FORECAST");
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5103
  aiforecast_sql(expression) {
    let this_sql = this.sql(expression, "this");
    if (expression.this instanceof exp.Table) {
      this_sql = `TABLE ${this_sql}`;
    }

    return this.func(
      "FORECAST",
      this_sql,
      expression.args.data_col,
      expression.args.timestamp_col,
      expression.args.model,
      expression.args.id_cols,
      expression.args.horizon,
      expression.args.forecast_end_timestamp,
      expression.args.confidence_level,
      expression.args.output_historical_time_series,
      expression.args.context_window,
    );
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5122
  featuresattime_sql(expression) {
    let this_sql = this.sql(expression, "this");
    if (expression.this instanceof exp.Table) {
      this_sql = `TABLE ${this_sql}`;
    }

    return this.func(
      "FEATURES_AT_TIME",
      this_sql,
      expression.args.time,
      expression.args.num_rows,
      expression.args.ignore_feature_nulls,
    );
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5135
  vectorsearch_sql(expression) {
    let this_sql = this.sql(expression, "this");
    if (expression.this instanceof exp.Table) {
      this_sql = `TABLE ${this_sql}`;
    }

    let query_table = this.sql(expression, "query_table");
    if (expression.args.query_table instanceof exp.Table) {
      query_table = `TABLE ${query_table}`;
    }

    return this.func(
      "VECTOR_SEARCH",
      this_sql,
      expression.args.column_to_search,
      query_table,
      expression.args.query_column_to_search,
      expression.args.top_k,
      expression.args.distance_type,
      expression.args.options,
    );
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5155
  forin_sql(expression) {
    const this_ = this.sql(expression, "this");
    const expression_sql = this.sql(expression, "expression");
    return `FOR ${this_} DO ${expression_sql}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5160
  refresh_sql(expression) {
    const this_ = this.sql(expression, "this");
    const kind = expression.this instanceof exp.Literal ? "" : `${expression.text("kind")} `;
    return `REFRESH ${kind}${this_}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5165
  // py: sqlglot/generator.py:5165
  toarray_sql(expression) {
    let arg = expression.this;
    if (!arg.type) {
      const { annotate_types } = _getAnnotateTypesModule();
      arg = annotate_types(arg, { dialect: this.dialect });
    }

    if (arg.isType(exp.DType.ARRAY)) {
      return this.sql(arg);
    }

    const cond_for_null = arg.is_(exp.null_());
    return this.sql(exp.func("IF", cond_for_null, exp.null_(), exp.array(arg, { copy: false })));
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5178
  tsordstotime_sql(expression) {
    const this_ = expression.this;
    const time_format = this.format_time(expression);

    if (time_format) {
      return this.sql(
        exp.cast(new exp.StrToTime({ this: this_, format: expression.args.format }), exp.DType.TIME),
      );
    }

    if (this_ instanceof exp.TsOrDsToTime || this_.isType(exp.DType.TIME)) return this.sql(this_);

    return this.sql(exp.cast(this_, exp.DType.TIME));
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5195
  tsordstotimestamp_sql(expression) {
    const this_ = expression.this;
    if (this_ instanceof exp.TsOrDsToTimestamp || this_.isType(exp.DType.TIMESTAMP)) {
      return this.sql(this_);
    }

    return this.sql(exp.cast(this_, exp.DType.TIMESTAMP, { dialect: this.dialect }));
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5202
  // py: sqlglot/generator.py:5202
  tsordstodatetime_sql(expression) {
    const this_ = expression.this;
    if (this_ instanceof exp.TsOrDsToDatetime || this_.isType(exp.DType.DATETIME)) {
      return this.sql(this_);
    }

    return this.sql(exp.cast(this_, exp.DType.DATETIME, { dialect: this.dialect }));
  }

  /**
   * py: sqlglot/generator.py:5209
   * @param {exp.TsOrDsToDate} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:5209
  tsordstodate_sql(expression) {
    const this_ = expression.this;
    const time_format = this.format_time(expression);
    const safe = expression.args.safe;

    if (
      time_format
      && time_format !== this.dialect.TIME_FORMAT
      && time_format !== this.dialect.DATE_FORMAT
    ) {
      return this.sql(
        exp.cast(
          new exp.StrToTime({ this: this_, format: expression.args.format, safe }),
          exp.DType.DATE,
        ),
      );
    }

    if (this_ instanceof exp.TsOrDsToDate || this_.isType(exp.DType.DATE)) return this.sql(this_);

    if (safe) {
      return this.sql(new exp.TryCast({ this: this_, to: new exp.DataType({ this: exp.DType.DATE }) }));
    }

    return this.sql(exp.cast(this_, exp.DType.DATE));
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5229
  unixdate_sql(expression) {
    return this.sql(
      exp.func(
        "DATEDIFF",
        expression.this,
        exp.cast(exp.Literal.string("1970-01-01"), exp.DType.DATE),
        "day",
      ),
    );
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5239
  lastday_sql(expression) {
    if (this.constructor.LAST_DAY_SUPPORTS_DATE_PART) {
      return this.function_fallback_sql(expression);
    }

    const unit = expression.args.unit;
    if (unit && pyUpper(unit.name) !== "MONTH") {
      this.unsupported("Date parts are not supported in LAST_DAY.");
    }

    return this.func("LAST_DAY", expression.this);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5249
  dateadd_sql(expression) {
    return this.func("DATE_ADD", expression.this, expression.expression, _getDialectHelpers().unit_to_str(expression));
  }

  /** @returns {string} */
  // py: sqlglot/generator.py:5259. See `having_sql`'s comment for why this landed now.
  //
  // `import sqlglot.dialects.dialect` (py:5266) plus `self.dialect.__class__ !=
  // sqlglot.dialects.dialect.Dialect` only exists to avoid warning for the base
  // (un-dialected) SQLGlot dialect itself — `generator.js` cannot import `dialect.js`
  // (a real circular import, not a style choice: `dialect.js` already imports FROM
  // `generator.js`), so this reads the base class's own name, matching the identity
  // check exactly the same way `this.dialect.constructor.name` is already used
  // elsewhere in this file for dialect-identifying messages (`RESPECT/IGNORE NULLS`,
  // a few lines below `arrayany_sql`'s own call site here).
  arrayany_sql(expression) {
    if (this.constructor.CAN_IMPLEMENT_ARRAY_ANY) {
      const filtered = new exp.ArrayFilter({ this: expression.this, expression: expression.expression });
      const filtered_not_empty = new exp.ArraySize({ this: filtered }).neq(0);
      const original_is_empty = new exp.ArraySize({ this: expression.this }).eq(0);
      return this.sql(exp.paren(original_is_empty.or_(filtered_not_empty)));
    }

    if (this.dialect.constructor.name !== "Dialect") {
      this.unsupported("ARRAY_ANY is unsupported");
    }

    return this.function_fallback_sql(expression);
  }

  /**
   * py: sqlglot/generator.py:5274
   * @param {exp.Struct} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:5274
  struct_sql(expression) {
    expression.set(
      "expressions",
      expression.expressions.map((e) =>
        e instanceof exp.PropertyEQ ? exp.alias_(e.expression, e.this.is_string ? e.name : e.this) : e,
      ),
    );

    return this.function_fallback_sql(expression);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5287
  partitionrange_sql(expression) {
    const low = this.sql(expression, "this");
    const high = this.sql(expression, "expression");

    return `${low} TO ${high}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5293
  truncatetable_sql(expression) {
    const target = expression.args.is_database ? "DATABASE" : "TABLE";
    const tables = ` ${this.expressions(expression)}`;

    const exists = expression.args.exists ? " IF EXISTS" : "";

    let on_cluster = this.sql(expression, "cluster");
    on_cluster = on_cluster ? ` ${on_cluster}` : "";

    let identity = this.sql(expression, "identity");
    identity = identity ? ` ${identity} IDENTITY` : "";

    let option = this.sql(expression, "option");
    option = option ? ` ${option}` : "";

    let partition = this.sql(expression, "partition");
    partition = partition ? ` ${partition}` : "";

    return `TRUNCATE ${target}${exists}${tables}${on_cluster}${identity}${option}${partition}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5315
  convert_sql(expression) {
    let to = expression.this;
    const value = expression.expression;
    const style = expression.args.style;
    const safe = expression.args.safe;
    const strict = expression.args.strict;

    if (!to || !value) return "";

    // Retrieve length of datatype and override to default if not specified
    if (!seqGet(to.expressions, 0) && this.constructor.PARAMETERIZABLE_TEXT_TYPES.has(to.this)) {
      to = exp.DataType.build(to.this, { expressions: [exp.Literal.number(30)], nested: false });
    }

    let transformed = null;
    const Cast_ = strict ? exp.Cast : exp.TryCast;

    // Check whether a conversion with format (T-SQL calls this 'style') is applicable
    if (style instanceof exp.Literal && style.is_int) {
      const resolveDialect = getDialectResolver();
      if (!resolveDialect) {
        throw new Error(
          "generator.js: convert_sql needs the TSQL dialect's CONVERT_FORMAT_MAPPING — " +
            "import dialects/tsql.js (or dialects/dialect.js, which index.js pulls it in through) first.",
        );
      }
      const tsql = resolveDialect("tsql");

      const style_value = style.name;
      const converted_style = tsql.CONVERT_FORMAT_MAPPING.get(style_value);
      if (!converted_style) {
        this.unsupported(`Unsupported T-SQL 'style' value: ${style_value}`);
      }

      const fmt = exp.Literal.string(converted_style);

      if (to.this === exp.DType.DATE) {
        transformed = new exp.StrToDate({ this: value, format: fmt });
      } else if (to.this === exp.DType.DATETIME || to.this === exp.DType.DATETIME2) {
        transformed = new exp.StrToTime({ this: value, format: fmt });
      } else if (this.constructor.PARAMETERIZABLE_TEXT_TYPES.has(to.this)) {
        transformed = new Cast_({ this: new exp.TimeToStr({ this: value, format: fmt }), to, safe });
      } else if (to.this === exp.DType.TEXT) {
        transformed = new exp.TimeToStr({ this: value, format: fmt });
      }
    }

    if (!transformed) {
      transformed = new Cast_({ this: value, to, safe });
    }

    return this.sql(transformed);
  }

  /**
   * py: sqlglot/generator.py:5357
   *
   * `self.SAFE_JSON_PATH_KEY_RE.match(this)` (py) uses `.test(...)` here: the base
   * `SAFE_JSON_PATH_KEY_RE` is `exp.SAFE_IDENTIFIER_RE` (generator.js's own copy of
   * that alias), which — per its own doc comment — only exposes `.test()`, never a raw
   * `RegExp`, because Python's `\w`/`$` semantics need `pyIsAlnum` rather than a JS
   * regex (R24). `HiveGenerator`'s own override below carries the same shape.
   * @param {exp.JSONPathKey} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:5357
  _jsonpathkey_sql(expression) {
    let this_ = expression.this;
    if (this_ instanceof exp.JSONPathWildcard) {
      this_ = this.json_path_part(this_);
      return this_ ? `.${this_}` : "";
    }

    const quoted = expression.args.quoted;
    if (
      !(quoted && this.constructor.JSON_PATH_KEY_QUOTED_FORCES_BRACKETS) &&
      this.constructor.SAFE_JSON_PATH_KEY_RE.test(this_)
    ) {
      return `.${this_}`;
    }

    this_ = this.json_path_part(this_);

    if (quoted && this.constructor.QUOTE_JSON_PATH) {
      this_ = this.escape_str(this_);
    }

    return this._quote_json_path_key_using_brackets && this.constructor.JSON_PATH_BRACKETED_KEY_SUPPORTED
      ? `[${this_}]`
      : `.${this_}`;
  }

  /**
   * py: sqlglot/generator.py:5383
   * @param {exp.JSONPathSubscript} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:5383
  _jsonpathsubscript_sql(expression) {
    const this_ = this.json_path_part(expression.this);
    return this_ ? `[${this_}]` : "";
  }

  // py: sqlglot/generator.py:5387 — the `isinstance(expression, exp.Literal)` guard is
  // ported for real; the `sqlglot.optimizer.simplify.simplify` branch it guards stays a
  // `NotPorted` throw for anything that could actually need folding (P6+, unported
  // optimizer module — same status as `sequence_sql`'s identical call in
  // `src/dialects/dialect.js`), EXCEPT one additional exact, provable no-op: an
  // `exp.Interval` whose amount is already a bare `Literal`. `simplify()` only ever
  // folds arithmetic *inside* a node; `Interval.arg_types` is `{this, unit}` and `unit`
  // is never touched, so if `this` is already a `Literal` there is nothing left for
  // `simplify()` to fold and it is a verified identity — checked directly against the
  // pinned CPython (`simplify(parse_one("INTERVAL '1' day")) == parse_one("INTERVAL '1' day")`).
  // A `Paren`/`Add`/etc. amount (e.g. `INTERVAL (1+2) day`) does NOT take this branch
  // and still throws, because CPython's `simplify()` DOES fold that one (verified: it
  // becomes `Literal(3)`) — approximating that case would be a silent-wrong risk, not
  // an identity.
  //
  // Ported alongside `generators/postgres.js`'s `_date_add_sql`, which calls this
  // UNCONDITIONALLY on every `DATE_ADD`/`DATE_SUB`/`TS_OR_DS_ADD` interval amount —
  // before this fix the stub threw even for `DATE_ADD(x, INTERVAL '1' day)`, the most
  // common shape there is.
  _simplify_unless_literal(expression) {
    if (
      !(expression instanceof exp.Literal)
      && !(expression instanceof exp.Interval && expression.this instanceof exp.Literal)
    ) {
      throw new NotPorted(
        "_simplify_unless_literal (sqlglot.optimizer.simplify.simplify)",
        "sqlglot/generator.py:5387",
      );
    }
    return expression;
  }

  /**
   * py: sqlglot/generator.py:5395
   * @param {exp.IgnoreNulls|exp.RespectNulls} expression
   * @param {string} text
   * @returns {string}
   */
  // py: sqlglot/generator.py:5395
  _embed_ignore_nulls(expression, text) {
    const this_ = expression.this;
    if (this.constructor.RESPECT_IGNORE_NULLS_UNSUPPORTED_EXPRESSIONS.some((cls) => this_ instanceof cls)) {
      this.unsupported(
        `RESPECT/IGNORE NULLS is not supported for ${this_.constructor.key} in ${this.dialect.constructor.name}`,
      );
      return this.sql(this_);
    }

    if (this.constructor.IGNORE_NULLS_IN_FUNC && !expression.metaGet("inline")) {
      if (this.constructor.IGNORE_NULLS_BEFORE_ORDER) {
        throw new NotPorted(
          "_embed_ignore_nulls (IGNORE_NULLS_BEFORE_ORDER branch)",
          "sqlglot/optimizer/scope.py — find_all_in_scope",
        );
      }

      const agg_func = expression.find(exp.AggFunc);

      if (agg_func) {
        const agg_func_sql = this.sql(agg_func, null, false).slice(0, -1) + ` ${text})`;
        return this.maybe_comment(agg_func_sql, null, { comments: agg_func.comments });
      }
    }

    return `${this.sql(expression, "this")} ${text}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5432
  _replace_line_breaks(string) {
    // py: "We don't want to extra indent line breaks so we temporarily replace them
    // with sentinels." `generate()` swaps them back after `indent()` has run.
    if (this.pretty) return string.replaceAll("\n", this.constructor.SENTINEL_LINE_BREAK);
    return string;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5438
  copyparameter_sql(expression) {
    const option = this.sql(expression, "this");

    if (expression.expressions.length) {
      const upper = pyUpper(option);

      // Snowflake FILE_FORMAT options are separated by whitespace
      const sep = upper === "FILE_FORMAT" ? " " : ", ";

      // Databricks copy/format options do not set their list of values with EQ
      const op = ["COPY_OPTIONS", "FORMAT_OPTIONS"].includes(upper) ? " " : " = ";
      const values = this.expressions(expression, null, { flat: true, sep });
      return `${option}${op}(${values})`;
    }

    const value = this.sql(expression, "expression");

    if (!value) return option;

    const op = this.constructor.COPY_PARAMS_EQ_REQUIRED ? " = " : " ";

    return `${option}${op}${value}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5461
  credentials_sql(expression) {
    const cred_expr = expression.args.credentials;
    let credentials;
    if (cred_expr instanceof exp.Literal) {
      // Redshift case: CREDENTIALS <string>
      credentials = this.sql(expression, "credentials");
      credentials = credentials ? `CREDENTIALS ${credentials}` : "";
    } else {
      // Snowflake case: CREDENTIALS = (...)
      credentials = this.expressions(expression, "credentials", { flat: true, sep: " " });
      credentials = cred_expr !== null && cred_expr !== undefined ? `CREDENTIALS = (${credentials})` : "";
    }

    let storage = this.sql(expression, "storage");
    storage = storage ? `STORAGE_INTEGRATION = ${storage}` : "";

    let encryption = this.expressions(expression, "encryption", { flat: true, sep: " " });
    encryption = encryption ? ` ENCRYPTION = (${encryption})` : "";

    let iam_role = this.sql(expression, "iam_role");
    iam_role = iam_role ? `IAM_ROLE ${iam_role}` : "";

    let region = this.sql(expression, "region");
    region = region ? ` REGION ${region}` : "";

    return `${credentials}${storage}${encryption}${iam_role}${region}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5486
  copy_sql(expression) {
    let this_ = this.sql(expression, "this");
    this_ = this.constructor.COPY_HAS_INTO_KEYWORD ? ` INTO ${this_}` : ` ${this_}`;

    let credentials = this.sql(expression, "credentials");
    credentials = credentials ? this.seg(credentials) : "";
    const files = this.expressions(expression, "files", { flat: true });
    const kind = files ? this.seg(expression.args.kind ? "FROM" : "TO") : "";

    const sep = this.dialect.COPY_PARAMS_ARE_CSV ? ", " : " ";
    let params = this.expressions(expression, "params", {
      sep,
      new_line: true,
      skip_last: true,
      skip_first: true,
      indent: this.constructor.COPY_PARAMS_ARE_WRAPPED,
    });

    if (params) {
      if (this.constructor.COPY_PARAMS_ARE_WRAPPED) {
        params = ` WITH (${params})`;
      } else if (!this.pretty && (files || credentials)) {
        params = ` ${params}`;
      }
    }

    return `COPY${this_}${kind} ${files}${credentials}${params}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5514
  semicolon_sql(expression) {
    return "";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5517
  datadeletionproperty_sql(expression) {
    let on_sql = expression.args.on ? "ON" : "OFF";
    let filter_col = this.sql(expression, "filter_column");
    filter_col = filter_col ? `FILTER_COLUMN=${filter_col}` : null;
    let retention_period = this.sql(expression, "retention_period");
    retention_period = retention_period ? `RETENTION_PERIOD=${retention_period}` : null;

    if (filter_col || retention_period) {
      on_sql = this.func("ON", filter_col, retention_period);
    }

    return `DATA_DELETION=${on_sql}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5529
  maskingpolicycolumnconstraint_sql(expression) {
    const this_ = this.sql(expression, "this");
    let expressions = this.expressions(expression, null, { flat: true });
    expressions = expressions ? ` USING (${expressions})` : "";
    return `MASKING POLICY ${this_}${expressions}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5537
  gapfill_sql(expression) {
    const this_ = `TABLE ${this.sql(expression, "this")}`;
    const rest = Object.entries(expression.args)
      .filter(([k]) => k !== "this")
      .map(([, v]) => v);
    return this.func("GAP_FILL", this_, ...rest);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5542
  // py: sqlglot/generator.py:5542
  scope_resolution(rhs, scope_name) {
    return this.func("SCOPE_RESOLUTION", scope_name || null, rhs);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5545
  // py: sqlglot/generator.py:5545
  scoperesolution_sql(expression) {
    const this_ = this.sql(expression, "this");
    const expr = expression.expression;

    let expr_sql;
    if (expr instanceof exp.Func) {
      // T-SQL's CLR functions are case sensitive
      expr_sql = `${this.sql(expr, "this")}(${this.format_args(...expr.expressions)})`;
    } else {
      expr_sql = this.sql(expression, "expression");
    }

    return this.scope_resolution(expr_sql, this_);
  }

  /**
   * py: sqlglot/generator.py:5557
   * @param {exp.ParseJSON} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:5557
  parsejson_sql(expression) {
    if (this.constructor.PARSE_JSON_NAME === null) return this.sql(expression.this);
    return this.func(this.constructor.PARSE_JSON_NAME, expression.this, expression.expression);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5563
  rand_sql(expression) {
    const lower = this.sql(expression, "lower");
    const upper = this.sql(expression, "upper");

    if (lower && upper) {
      return `(${upper} - ${lower}) * ${this.func("RAND", expression.this)} + ${lower}`;
    }
    return this.func("RAND", expression.this);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5571
  changes_sql(expression) {
    let information = this.sql(expression, "information");
    information = `INFORMATION => ${information}`;
    let at_before = this.sql(expression, "at_before");
    at_before = at_before ? `${this.seg("")}${at_before}` : "";
    let end = this.sql(expression, "end");
    end = end ? `${this.seg("")}${end}` : "";

    return `CHANGES (${information})${at_before}${end}`;
  }

  /**
   * py: sqlglot/generator.py:5581
   * @param {exp.Pad} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:5581
  pad_sql(expression) {
    const prefix = expression.args.is_left ? "L" : "R";

    let fill_pattern = this.sql(expression, "fill_pattern") || null;
    if (!fill_pattern && this.constructor.PAD_FILL_PATTERN_IS_REQUIRED) fill_pattern = "' '";

    return this.func(`${prefix}PAD`, expression.this, expression.expression, fill_pattern);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5590
  summarize_sql(expression) {
    const table = expression.args.table ? " TABLE" : "";
    return `SUMMARIZE${table} ${this.sql(expression.this)}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5594
  explodinggenerateseries_sql(expression) {
    const generate_series = new exp.GenerateSeries({ ...expression.args });

    let parent = expression.parent;
    if (parent instanceof exp.Alias || parent instanceof exp.TableAlias) parent = parent.parent;

    if (
      this.constructor.SUPPORTS_EXPLODING_PROJECTIONS
      && !(parent instanceof exp.Table || parent instanceof exp.Unnest)
    ) {
      return this.sql(new exp.Unnest({ expressions: [generate_series] }));
    }

    if (parent instanceof exp.Select) {
      this.unsupported("GenerateSeries projection unnesting is not supported.");
    }

    return this.sql(generate_series);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5609
  converttimezone_sql(expression) {
    if (this.constructor.SUPPORTS_CONVERT_TIMEZONE) return this.function_fallback_sql(expression);

    const source_tz = expression.args.source_tz;
    const target_tz = expression.args.target_tz;
    let timestamp = expression.args.timestamp;

    if (source_tz && timestamp) {
      timestamp = new exp.AtTimeZone({
        this: exp.cast(timestamp, exp.DType.TIMESTAMPNTZ),
        zone: source_tz,
      });
    }

    const expr = new exp.AtTimeZone({ this: timestamp, zone: target_tz });

    return this.sql(expr);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5626
  json_sql(expression) {
    let this_ = this.sql(expression, "this");
    this_ = this_ ? ` ${this_}` : "";

    const _with = expression.args.with_;

    let with_sql;
    if (_with === null || _with === undefined) {
      with_sql = "";
    } else if (!_with) {
      with_sql = " WITHOUT";
    } else {
      with_sql = " WITH";
    }

    const unique_sql = expression.args.unique ? " UNIQUE KEYS" : "";

    return `JSON${this_}${with_sql}${unique_sql}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5643
  jsonvalue_sql(expression) {
    const path = this.sql(expression, "path");
    let returning = this.sql(expression, "returning");
    returning = returning ? ` RETURNING ${returning}` : "";

    let on_condition = this.sql(expression, "on_condition");
    on_condition = on_condition ? ` ${on_condition}` : "";

    return this.func("JSON_VALUE", expression.this, `${path}${returning}${on_condition}`);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5653
  skipjsoncolumn_sql(expression) {
    const regexp = expression.args.regexp ? " REGEXP" : "";
    return `SKIP${regexp} ${this.sql(expression.expression)}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5657
  conditionalinsert_sql(expression) {
    const else_ = expression.args.else_ ? "ELSE " : "";
    let condition = this.sql(expression, "expression");
    condition = condition ? `WHEN ${condition} THEN ` : else_;
    const insert = pyStrip(this.sql(expression, "this").slice("INSERT".length));
    return `${condition}${insert}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5664
  multitableinserts_sql(expression) {
    const kind = this.sql(expression, "kind");
    const expressions = this.seg(this.expressions(expression, null, { sep: " " }));
    return `INSERT ${kind}${expressions}${this.seg(this.sql(expression, "source"))}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5670
  oncondition_sql(expression) {
    // py:5674,5681 upstream's f"...{empty}..." calls `Expr.__str__` (-> `self.sql()`),
    // not `__repr__`; `this.sql(empty)` below is the safe equivalent (JS's
    // `Expr.prototype.toString` mirrors `__repr__`, not `__str__`, so a template
    // literal would print the debug repr instead — PORT_PLAN.md, "static analysis
    // misses implicit __str__").
    let empty = expression.args.empty;
    empty =
      empty instanceof exp.Expr
        ? `DEFAULT ${this.sql(empty)} ON EMPTY`
        : this.sql(expression, "empty");

    let error = expression.args.error;
    error =
      error instanceof exp.Expr
        ? `DEFAULT ${this.sql(error)} ON ERROR`
        : this.sql(expression, "error");

    if (error && empty) {
      error = this.dialect.ON_CONDITION_EMPTY_BEFORE_ERROR
        ? `${empty} ${error}`
        : `${error} ${empty}`;
      empty = "";
    }

    const null_ = this.sql(expression, "null");

    return `${empty}${error}${null_}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5698
  jsonextractquote_sql(expression) {
    const scalar = expression.args.scalar ? " ON SCALAR STRING" : "";
    return `${this.sql(expression, "option")} QUOTES${scalar}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5702
  jsonexists_sql(expression) {
    const this_ = this.sql(expression, "this");
    let path = this.sql(expression, "path");

    let passing = this.expressions(expression, "passing");
    passing = passing ? ` PASSING ${passing}` : "";

    let on_condition = this.sql(expression, "on_condition");
    on_condition = on_condition ? ` ${on_condition}` : "";

    path = `${path}${passing}${on_condition}`;

    return this.func("JSON_EXISTS", this_, path);
  }

  /**
   * py: sqlglot/generator.py:5716 `_add_arrayagg_null_filter(array_agg_sql,
   * array_agg_expr, column_expr)` — add a NULL FILTER to ARRAY_AGG if the dialect
   * requires it, to mimic a null-excluding dialect (e.g. Spark) from one that isn't
   * (e.g. DuckDB). Ported alongside `arrayagg_sql`/`having_sql` off the back of
   * `unnest_subqueries.js`'s own oracle (AIR-2115) — see `having_sql`'s comment.
   * @returns {string}
   */
  _add_arrayagg_null_filter(array_agg_sql, array_agg_expr, column_expr) {
    if (!(this.dialect.ARRAY_AGG_INCLUDES_NULLS && array_agg_expr.args.nulls_excluded)) {
      return array_agg_sql;
    }

    const parent = array_agg_expr.parent;
    if (parent instanceof exp.Filter) {
      const parent_cond = parent.expression.this;
      parent_cond.replace(parent_cond.and_(column_expr.is_(exp.null()).not_()));
    } else if (column_expr.find(exp.Column)) {
      // Do not add the filter if the input is not a column (e.g. literal, struct etc)
      // DISTINCT is already present in the agg function, do not propagate it to FILTER as well
      const this_sql = column_expr instanceof exp.Distinct
        ? this.expressions(column_expr)
        : this.sql(column_expr);
      array_agg_sql = `${array_agg_sql} FILTER(WHERE ${this_sql} IS NOT NULL)`;
    }

    return array_agg_sql;
  }

  /** @returns {string} */
  // py: sqlglot/generator.py:5756. See `having_sql`'s comment for why this landed now.
  arrayagg_sql(expression) {
    const array_agg = this.function_fallback_sql(expression);
    let column_expr = expression.this;
    if (column_expr instanceof exp.Order) {
      column_expr = column_expr.this;
    }

    return this._add_arrayagg_null_filter(array_agg, expression, column_expr);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5764
  // py: sqlglot/generator.py:5764
  slice_sql(expression) {
    const step = this.sql(expression, "step");
    const end = this.sql(expression.expression);
    const begin = this.sql(expression.this);

    const sql = step ? `${end}:${step}` : end;
    return sql ? `${begin}:${sql}` : `${begin}:`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5772
  apply_sql(expression) {
    const this_ = this.sql(expression, "this");
    const expr = this.sql(expression, "expression");

    return `${this_} APPLY(${expr})`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5778
  _grant_or_revoke_sql(expression, keyword, preposition, grant_option_prefix = "", grant_option_suffix = "") {
    const privileges_sql = this.expressions(expression, "privileges", { flat: true });

    let kind = this.sql(expression, "kind");
    kind = kind ? ` ${kind}` : "";

    let securable = this.sql(expression, "securable");
    securable = securable ? ` ${securable}` : "";

    const principals = this.expressions(expression, "principals", { flat: true });

    if (!expression.args.grant_option) {
      grant_option_prefix = grant_option_suffix = "";
    }

    let cascade = this.sql(expression, "cascade");
    cascade = cascade ? ` ${cascade}` : "";

    return `${keyword} ${grant_option_prefix}${privileges_sql} ON${kind}${securable} ${preposition} ${principals}${grant_option_suffix}${cascade}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5805
  grant_sql(expression) {
    return this._grant_or_revoke_sql(expression, "GRANT", "TO", "", " WITH GRANT OPTION");
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5813
  revoke_sql(expression) {
    return this._grant_or_revoke_sql(expression, "REVOKE", "FROM", "GRANT OPTION FOR ");
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5821
  grantprivilege_sql(expression) {
    const this_ = this.sql(expression, "this");
    let columns = this.expressions(expression, null, { flat: true });
    columns = columns ? `(${columns})` : "";
    return `${this_}${columns}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5828
  grantprincipal_sql(expression) {
    const this_ = this.sql(expression, "this");

    let kind = this.sql(expression, "kind");
    kind = kind ? `${kind} ` : "";

    return `${kind}${this_}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5836
  columns_sql(expression) {
    let func = this.function_fallback_sql(expression);
    if (expression.args.unpack) func = `*${func}`;

    return func;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5843
  overlay_sql(expression) {
    const this_ = this.sql(expression, "this");
    const expr = this.sql(expression, "expression");
    const from_sql = this.sql(expression, "from_");
    let for_sql = this.sql(expression, "for_");
    for_sql = for_sql ? ` FOR ${for_sql}` : "";

    return `OVERLAY(${this_} PLACING ${expr} FROM ${from_sql}${for_sql})`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5853
  // py: sqlglot/generator.py:5853 `@unsupported_args("format") def todouble_sql(self, expression)`
  // — the `this`-forwarding shim onto `_todouble_sql` below (module scope), same split
  // as `tochar_sql`/`_tochar_sql`.
  todouble_sql(expression) { return _todouble_sql(this, expression); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5857
  string_sql(expression) {
    let this_ = expression.this;
    const zone = expression.args.zone;

    if (zone) {
      this_ = new exp.ConvertTimezone({
        source_tz: exp.Literal.string("UTC"),
        target_tz: zone,
        timestamp: this_,
      });
    }

    return this.sql(exp.cast(this_, exp.DType.VARCHAR));
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5871
  median_sql(expression) {
    if (!this.constructor.SUPPORTS_MEDIAN) {
      return this.sql(
        new exp.PercentileCont({ this: expression.this, expression: exp.Literal.number(0.5) }),
      );
    }

    return this.function_fallback_sql(expression);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5879
  overflowtruncatebehavior_sql(expression) {
    let filler = this.sql(expression, "this");
    filler = filler ? ` ${filler}` : "";
    const with_count = expression.args.with_count ? "WITH COUNT" : "WITHOUT COUNT";
    return `TRUNCATE${filler} ${with_count}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5885
  // py: sqlglot/generator.py:5885
  unixseconds_sql(expression) {
    if (this.constructor.SUPPORTS_UNIX_SECONDS) {
      return this.function_fallback_sql(expression);
    }

    const start_ts = exp.cast(exp.Literal.string("1970-01-01 00:00:00+00"), exp.DType.TIMESTAMPTZ);

    return this.sql(
      new exp.TimestampDiff({ this: expression.this, expression: start_ts, unit: exp.var_("SECONDS") })
    );
  }

  // py: sqlglot/generator.py:5895 — ported for PORT_PLAN.md R32.
  arraysize_sql(expression) {
    let dim = expression.expression;

    if (dim && this.constructor.ARRAY_SIZE_DIM_REQUIRED === null) {
      if (!(dim.is_int && dim.name === "1")) {
        this.unsupported("Cannot transpile dimension argument for ARRAY_LENGTH");
      }
      dim = null;
    }

    if (this.constructor.ARRAY_SIZE_DIM_REQUIRED && !dim) dim = exp.Literal.number(1);

    return this.func(this.constructor.ARRAY_SIZE_NAME, expression.this, dim);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5910
  // py: sqlglot/generator.py:5910
  attach_sql(expression) {
    const this_ = this.sql(expression, "this");
    const exists_sql = expression.args.exists ? " IF NOT EXISTS" : "";
    let expressions = this.expressions(expression);
    expressions = expressions ? ` (${expressions})` : "";

    return `ATTACH${exists_sql} ${this_}${expressions}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5918
  detach_sql(expression) {
    let kind = this.sql(expression, "kind");
    kind = kind ? ` ${kind}` : "";
    const exists = expression.args.exists ? " IF EXISTS" : "";
    if (exists) {
      kind = kind || " DATABASE";
    }

    let this_ = this.sql(expression, "this");
    this_ = this_ ? ` ${this_}` : "";
    let cluster = this.sql(expression, "cluster");
    cluster = cluster ? ` ${cluster}` : "";
    const permanent = expression.args.permanent ? " PERMANENTLY" : "";
    const sync = expression.args.sync ? " SYNC" : "";
    return `DETACH${kind}${exists}${this_}${cluster}${permanent}${sync}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5935
  attachoption_sql(expression) {
    const this_ = this.sql(expression, "this");
    let value = this.sql(expression, "expression");
    value = value ? ` ${value}` : "";
    return `${this_}${value}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5941
  watermarkcolumnconstraint_sql(expression) {
    return `WATERMARK FOR ${this.sql(expression, "this")} AS ${this.sql(expression, "expression")}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5946
  encodeproperty_sql(expression) {
    let encode = expression.args.key ? "KEY ENCODE" : "ENCODE";
    encode = `${encode} ${this.sql(expression, "this")}`;

    const properties = expression.args.properties;
    if (properties) {
      encode = `${encode} ${this.properties(properties)}`;
    }

    return encode;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5956
  includeproperty_sql(expression) {
    const this_ = this.sql(expression, "this");
    let include = `INCLUDE ${this_}`;

    const column_def = this.sql(expression, "column_def");
    if (column_def) {
      include = `${include} ${column_def}`;
    }

    const alias = this.sql(expression, "alias");
    if (alias) {
      include = `${include} AS ${alias}`;
    }

    return include;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5970
  // py: sqlglot/generator.py:5970
  xmlelement_sql(expression) {
    const prefix = expression.args.evalname ? "EVALNAME" : "NAME";
    const name = `${prefix} ${this.sql(expression, "this")}`;
    return this.func("XMLELEMENT", name, ...expression.expressions);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5975
  xmlkeyvalueoption_sql(expression) {
    const this_ = this.sql(expression, "this");
    let expr = this.sql(expression, "expression");
    expr = expr ? `(${expr})` : "";
    return `${this_}${expr}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5981
  partitionbyrangeproperty_sql(expression) {
    const partitions = this.expressions(expression, "partition_expressions");
    const create = this.expressions(expression, "create_expressions");
    return `PARTITION BY RANGE ${this.wrap(partitions)} ${this.wrap(create)}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5986
  partitionbyrangepropertydynamic_sql(expression) {
    const start = this.sql(expression, "start");
    const end = this.sql(expression, "end");

    const every = expression.args.every;
    if (every instanceof exp.Interval && every.this.is_string) {
      every.this.replace(exp.Literal.number(every.name));
    }

    return `START ${this.wrap(start)} END ${this.wrap(end)} EVERY ${this.wrap(this.sql(every))}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:5998
  unpivotcolumns_sql(expression) {
    const name = this.sql(expression, "this");
    const values = this.expressions(expression, null, { flat: true });

    return `NAME ${name} VALUE ${values}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6004
  analyzesample_sql(expression) {
    const kind = this.sql(expression, "kind");
    const sample = this.sql(expression, "sample");
    return `SAMPLE ${sample} ${kind}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6009
  analyzestatistics_sql(expression) {
    const kind = this.sql(expression, "kind");
    let option = this.sql(expression, "option");
    option = option ? ` ${option}` : "";
    let this_ = this.sql(expression, "this");
    this_ = this_ ? ` ${this_}` : "";
    let columns = this.expressions(expression);
    columns = columns ? ` ${columns}` : "";
    return `${kind}${option} STATISTICS${this_}${columns}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6019
  analyzehistogram_sql(expression) {
    const this_ = this.sql(expression, "this");
    const columns = this.expressions(expression);
    let inner_expression = this.sql(expression, "expression");
    inner_expression = inner_expression ? ` ${inner_expression}` : "";
    let update_options = this.sql(expression, "update_options");
    update_options = update_options ? ` ${update_options} UPDATE` : "";
    return `${this_} HISTOGRAM ON ${columns}${inner_expression}${update_options}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6028
  analyzedelete_sql(expression) {
    let kind = this.sql(expression, "kind");
    kind = kind ? ` ${kind}` : "";
    return `DELETE${kind} STATISTICS`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6033
  analyzelistchainedrows_sql(expression) {
    const inner_expression = this.sql(expression, "expression");
    return `LIST CHAINED ROWS${inner_expression}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6037
  analyzevalidate_sql(expression) {
    const kind = this.sql(expression, "kind");
    let this_ = this.sql(expression, "this");
    this_ = this_ ? ` ${this_}` : "";
    const inner_expression = this.sql(expression, "expression");
    return `VALIDATE ${kind}${this_}${inner_expression}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6044
  analyze_sql(expression) {
    let options = this.expressions(expression, "options", { sep: " " });
    options = options ? ` ${options}` : "";
    let kind = this.sql(expression, "kind");
    kind = kind ? ` ${kind}` : "";
    let tables = this.expressions(expression, "tables", { flat: true });
    tables = tables ? ` ${tables}` : "";
    let mode = this.sql(expression, "mode");
    mode = mode ? ` ${mode}` : "";
    let properties = this.sql(expression, "properties");
    properties = properties ? ` ${properties}` : "";
    let partition = this.sql(expression, "partition");
    partition = partition ? ` ${partition}` : "";
    let inner_expression = this.sql(expression, "expression");
    inner_expression = inner_expression ? ` ${inner_expression}` : "";
    return `ANALYZE${options}${kind}${tables}${partition}${mode}${inner_expression}${properties}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6061
  xmltable_sql(expression) {
    const this_ = this.sql(expression, "this");
    let namespaces = this.expressions(expression, "namespaces");
    namespaces = namespaces ? `XMLNAMESPACES(${namespaces}), ` : "";
    let passing = this.expressions(expression, "passing");
    passing = passing ? `${this.sep()}PASSING${this.seg(passing)}` : "";
    let columns = this.expressions(expression, "columns");
    columns = columns ? `${this.sep()}COLUMNS${this.seg(columns)}` : "";
    const by_ref = expression.args.by_ref ? `${this.sep()}RETURNING SEQUENCE BY REF` : "";
    return `XMLTABLE(${this.sep("")}${this.indent(namespaces + this_ + passing + by_ref + columns)}${this.seg(")", "")}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6072
  xmlnamespace_sql(expression) {
    const this_ = this.sql(expression, "this");
    return expression.this instanceof exp.Alias ? this_ : `DEFAULT ${this_}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6076
  export_sql(expression) {
    const this_ = this.sql(expression, "this");
    let connection = this.sql(expression, "connection");
    connection = connection ? `WITH CONNECTION ${connection} ` : "";
    const options = this.sql(expression, "options");
    return `EXPORT DATA ${connection}${options} AS ${this_}`;
  }

  /**
   * py: sqlglot/generator.py:6083
   * @param {exp.Declare} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:6083
  declare_sql(expression) {
    const replace = expression.args.replace ? "OR REPLACE " : "";
    return `DECLARE ${replace}${this.expressions(expression, null, { flat: true })}`;
  }

  /**
   * py: sqlglot/generator.py:6087
   * @param {exp.DeclareItem} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:6087
  declareitem_sql(expression) {
    const variables = this.expressions(expression, "this");
    let default_ = this.sql(expression, "default");
    default_ = default_ ? ` ${this.constructor.DECLARE_DEFAULT_ASSIGNMENT} ${default_}` : "";

    let kind = this.sql(expression, "kind");
    if (expression.args.kind instanceof exp.Schema) kind = `TABLE ${kind}`;
    kind = kind ? ` ${kind}` : "";

    return `${variables}${kind}${default_}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6100
  recursivewithsearch_sql(expression) {
    const kind = this.sql(expression, "kind");
    const this_ = this.sql(expression, "this");
    const set_ = this.sql(expression, "expression");
    let using = this.sql(expression, "using");
    using = using ? ` USING ${using}` : "";

    const kind_sql = kind === "CYCLE" ? kind : `SEARCH ${kind} FIRST BY`;

    return `${kind_sql} ${this_} SET ${set_}${using}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6111
  parameterizedagg_sql(expression) {
    const params = this.expressions(expression, "params", { flat: true });
    return this.func(expression.name, ...expression.expressions) + `(${params})`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6115
  anonymousaggfunc_sql(expression) {
    return this.func(expression.name, ...expression.expressions);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6118
  combinedaggfunc_sql(expression) {
    return this.anonymousaggfunc_sql(expression);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6121
  combinedparameterizedagg_sql(expression) {
    return this.parameterizedagg_sql(expression);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6124
  // py: sqlglot/generator.py:6124
  show_sql(expression) {
    this.unsupported("Unsupported SHOW statement");
    return "";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6128
  // py: sqlglot/generator.py:6128
  install_sql(expression) {
    this.unsupported("Unsupported INSTALL statement");
    return "";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6132
  get_put_sql(expression) {
    const props = expression.args.properties;
    const props_sql = props ? this.properties(props, " ", " ", "", false) : "";
    const this_ = this.sql(expression, "this");
    const target = this.sql(expression, "target");

    if (expression instanceof exp.Put) {
      return `PUT ${this_} ${target}${props_sql}`;
    } else {
      return `GET ${target} ${this_}${props_sql}`;
    }
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6146
  translatecharacters_sql(expression) {
    const this_ = this.sql(expression, "this");
    const expr = this.sql(expression, "expression");
    const with_error = expression.args.with_error ? " WITH ERROR" : "";
    return `TRANSLATE(${this_} USING ${expr}${with_error})`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6152
  decodecase_sql(expression) {
    if (this.constructor.SUPPORTS_DECODE_CASE) {
      return this.func("DECODE", ...expression.expressions);
    }

    const [decode_expr, ...expressions] = expression.expressions;

    const ifs = [];
    for (let i = 0; i + 1 < expressions.length; i += 2) {
      const search = expressions[i];
      const result = expressions[i + 1];

      if (search instanceof exp.Literal) {
        ifs.push(new exp.If({ this: decode_expr.eq(search), true: result }));
      } else if (search instanceof exp.Null) {
        ifs.push(new exp.If({ this: decode_expr.is_(new exp.Null()), true: result }));
      } else {
        const search_ = search instanceof exp.Binary ? exp.paren(search) : search;

        const cond = exp.or_(
          decode_expr.eq(search_),
          exp.and_(decode_expr.is_(new exp.Null()), search_.is_(new exp.Null()), { copy: false }),
          { copy: false },
        );
        ifs.push(new exp.If({ this: cond, true: result }));
      }
    }

    const case_ = new exp.Case({ ifs, default: expressions.length % 2 === 1 ? expressions.at(-1) : null });
    return this.sql(case_);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6178
  semanticview_sql(expression) {
    let this_ = this.sql(expression, "this");
    this_ = this.seg(this_, "");
    let dimensions = this.expressions(expression, "dimensions", {
      dynamic: true,
      skip_first: true,
      skip_last: true,
    });
    dimensions = dimensions ? this.seg(`DIMENSIONS ${dimensions}`) : "";
    let metrics = this.expressions(expression, "metrics", {
      dynamic: true,
      skip_first: true,
      skip_last: true,
    });
    metrics = metrics ? this.seg(`METRICS ${metrics}`) : "";
    let facts = this.expressions(expression, "facts", {
      dynamic: true,
      skip_first: true,
      skip_last: true,
    });
    facts = facts ? this.seg(`FACTS ${facts}`) : "";
    let where = this.sql(expression, "where");
    where = where ? this.seg(`WHERE ${where}`) : "";
    const body = this.indent(this_ + metrics + dimensions + facts + where, { skip_first: true });
    return `SEMANTIC_VIEW(${body}${this.seg(")", "")}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6196
  getextract_sql(expression) {
    let this_ = expression.this;
    const expr = expression.expression;

    if (!this_.type || !expression.type) {
      this_ = _getAnnotateTypesModule().annotate_types(this_, { dialect: this.dialect });
    }

    if (this_.isType(exp.DType.ARRAY, exp.DType.MAP)) {
      return this.sql(new exp.Bracket({ this: this_, expressions: [expr] }));
    }

    return this.sql(new exp.JSONExtract({ this: this_, expression: this.dialect.to_json_path(expr) }));
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6210
  datefromunixdate_sql(expression) {
    return this.sql(
      new exp.DateAdd({
        this: exp.cast(exp.Literal.string("1970-01-01"), exp.DType.DATE),
        expression: expression.this,
        unit: exp.var("DAY"),
      }),
    );
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6219
  // py: sqlglot/generator.py:6219
  space_sql(expression) {
    return this.sql(new exp.Repeat({ this: exp.Literal.string(" "), times: expression.this }));
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6222
  buildproperty_sql(expression) {
    return `BUILD ${this.sql(expression, "this")}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6225
  refreshtriggerproperty_sql(expression) {
    // deny:implicit_str sqlglot/generator.py:6237 -- `kind` is interpolated raw,
    // exactly as upstream does, not routed through `this.sql(...)`. The deny scanner
    // flags it generically as "could be an Expr arg", but `RefreshTriggerProperty`'s
    // `kind` is always a parser-set keyword string (e.g. `"SCHEDULE"`/`"DEMAND"`),
    // never an `Expr` node.
    const method = this.sql(expression, "method");
    const kind = expression.args.kind;
    if (!kind) {
      return `REFRESH ${method}`;
    }

    let every = this.sql(expression, "every");
    const unit = this.sql(expression, "unit");
    every = every ? ` EVERY ${every} ${unit}` : "";
    let starts = this.sql(expression, "starts");
    starts = starts ? ` STARTS ${starts}` : "";

    return `REFRESH ${method} ON ${kind}${every}${starts}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6239
  modelattribute_sql(expression) {
    this.unsupported("The model!attribute syntax is not supported");
    return "";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6243
  directorystage_sql(expression) {
    return this.func("DIRECTORY", expression.this);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6246
  uuid_sql(expression) {
    const is_string = expression.args.is_string ?? false;
    const uuid_func_sql = this.func("UUID");

    if (is_string && !this.dialect.UUID_IS_STRING_TYPE) {
      return this.sql(exp.cast(uuid_func_sql, exp.DType.VARCHAR, { dialect: this.dialect }));
    }

    return uuid_func_sql;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6255
  initcap_sql(expression) {
    let delimiters = expression.expression;

    if (delimiters) {
      if (
        delimiters.is_string &&
        delimiters.this === this.dialect.INITCAP_DEFAULT_DELIMITER_CHARS
      ) {
        delimiters = null;
      } else if (!this.dialect.INITCAP_SUPPORTS_CUSTOM_DELIMITERS) {
        this.unsupported("INITCAP does not support custom delimiters");
        delimiters = null;
      }
    }

    return this.func("INITCAP", expression.this, delimiters);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6271
  localtime_sql(expression) {
    const this_ = expression.this;
    return this_ ? this.func("LOCALTIME", this_) : "LOCALTIME";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6275
  localtimestamp_sql(expression) {
    const this_ = expression.this;
    return this_ ? this.func("LOCALTIMESTAMP", this_) : "LOCALTIMESTAMP";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6279
  weekstart_name(expression) {
    const { WEEK_START_DAY_TO_DOW, week_offset_to_dow } = _getDialectHelpers();

    // WEEK(<day>) is BigQuery-only syntax, so it degrades to the plain WEEK unit
    const this_ = pyUpper(expression.this.name);

    const dow_from_week_start_day = WEEK_START_DAY_TO_DOW.get(this_);
    const dow_from_week_offset = week_offset_to_dow(this.dialect.WEEK_OFFSET);

    if (dow_from_week_start_day !== dow_from_week_offset) {
      this.unsupported(`WEEK(${this_}) is not supported; falling back to the default week start day`);
    }

    return "WEEK";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6295
  weekstart_sql(expression) {
    const name = this.weekstart_name(expression);

    // DateTrunc stores string literal units, whereas TimeUnit expressions store keywords
    if (expression.parent instanceof exp.DateTrunc) {
      return this.sql(exp.Literal.string(name));
    }

    return name;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6304
  chr_sql(expression, name = "CHR") {
    const this_ = this.expressions(expression);
    const charset = this.sql(expression, "charset");
    const using = charset ? ` USING ${charset}` : "";
    return this.func(name, this_ + using);
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6310
  // py: sqlglot/generator.py:6310
  block_sql(expression) {
    const expressions = this.expressions(expression, null, { sep: "; ", flat: true });
    const begin = expression.args.begin ? "BEGIN " : "";
    return expressions ? `${begin}${expressions}` : "";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6315
  functionspecification_sql(expression) {
    this.unsupported("Unsupported Inline UDFs syntax");
    return "";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6319
  storedprocedure_sql(expression) {
    this.unsupported("Unsupported Stored Procedure syntax");
    return "";
  }

  /**
   * py: sqlglot/generator.py:6323
   * @param {exp.IfBlock} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:6323
  ifblock_sql(expression) {
    this.unsupported("Unsupported If block syntax");
    return "";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6327
  casestatement_sql(expression) {
    this.unsupported("Unsupported Case statement syntax");
    return "";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6331
  whileblock_sql(expression) {
    this.unsupported("Unsupported While block syntax");
    return "";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6335
  loopblock_sql(expression) {
    this.unsupported("Unsupported Loop block syntax");
    return "";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6339
  repeatblock_sql(expression) {
    this.unsupported("Unsupported Repeat block syntax");
    return "";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6343
  leave_sql(expression) {
    this.unsupported("Unsupported Leave syntax");
    return "";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6347
  iterate_sql(expression) {
    this.unsupported("Unsupported Iterate syntax");
    return "";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6351
  execute_sql(expression) {
    this.unsupported("Unsupported Execute syntax");
    return "";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6355
  executesql_sql(expression) {
    this.unsupported("Unsupported Execute syntax");
    return "";
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6359
  altermodifysqlsecurity_sql(expression) {
    const props = this.expressions(expression, null, { sep: " " });
    return `MODIFY ${props}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6363
  usingproperty_sql(expression) {
    // deny:implicit_str sqlglot/generator.py:6365 -- `kind` is interpolated raw,
    // exactly as upstream does, not routed through `this.sql(...)`. The deny scanner
    // flags it generically as "could be an Expr arg", but `UsingProperty`'s `kind` is
    // always a parser-set keyword string (e.g. `"HEAP"`/`"BTREE"`), never an `Expr`
    // node.
    const kind = expression.args.kind;
    return `USING ${kind} ${this.sql(expression, "this")}`;
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:6367
  renameindex_sql(expression) {
    const this_ = this.sql(expression, "this");
    const to = this.sql(expression, "to");
    return `RENAME INDEX ${this_} TO ${to}`;
  }

}

/** py: sqlglot/generator.py:4889 `@unsupported_args("format") def tochar_sql(self, expression)` */
const _tochar_sql = unsupported_args("format")(
  (self, expression) => self.sql(exp.cast(expression.this, exp.DType.TEXT)),
);

/** py: sqlglot/generator.py:2757 `@unsupported_args("expressions") def into_sql(self, expression)` */
const _into_sql = unsupported_args("expressions")((self, expression) => {
  const temporary = expression.args.temporary ? " TEMPORARY" : "";
  const unlogged = expression.args.unlogged ? " UNLOGGED" : "";
  return `${self.seg("INTO")}${temporary || unlogged} ${self.sql(expression, "this")}`;
});

/** py: sqlglot/generator.py:4894 `@unsupported_args("default") def tonumber_sql(self, expression)` */
const _tonumber_sql = unsupported_args("default")((self, expression) => {
  if (!self.constructor.SUPPORTS_TO_NUMBER) {
    self.unsupported("Unsupported TO_NUMBER function");
    return self.sql(exp.cast(expression.this, exp.DType.DOUBLE));
  }

  const fmt = expression.args.format;
  if (!fmt) {
    self.unsupported("Conversion format is required for TO_NUMBER");
    return self.sql(exp.cast(expression.this, exp.DType.DOUBLE));
  }

  return self.func("TO_NUMBER", expression.this, fmt);
});

/** py: sqlglot/generator.py:5853 `@unsupported_args("format") def todouble_sql(self, expression)` */
const _todouble_sql = unsupported_args("format")((self, expression) => {
  const Cast = expression.args.safe ? exp.TryCast : exp.Cast;
  return self.sql(new Cast({ this: expression.this, to: exp.DType.DOUBLE.intoExpr() }));
});

/**
 * py: `Expression.sql()` -> `Dialect.get_or_raise(dialect).generate(self, **opts)`
 * -> `self.generator(**opts).generate(expression, copy=copy)`.
 *
 * `expressions/core.js:515` has exported `registerGenerator` since P2 and, until now,
 * NOTHING CALLED IT — so `Expr.sql()` was permanently the "No SQL generator registered
 * (available in P4)" throw. That is R19's shape exactly (a hook with a reader and no
 * caller), and R17 records the twin `registerParser` still sitting in that state. This
 * is P4, so the hook gets its caller here.
 *
 * Wiring it is safe to do now rather than at the end of the stub queue, verified rather
 * than assumed: nothing asserts the old message (`grep "No SQL generator"` finds only
 * the throw itself), and the parse path reaches the generator through `kernelSql`
 * directly, not through `Expr.sql()`. So the only behaviour change is that
 * `expr.sql()` now returns real SQL where the node's `*_sql` is ported, and throws
 * `NotPorted` naming the exact upstream line where it is not — strictly more
 * informative than the blanket message it replaces.
 *
 * A module-level side effect, deliberately: it mirrors upstream, where importing
 * `sqlglot` is what makes `.sql()` work, and it avoids a circular import
 * (`expressions/index.js` cannot import this file, but this file already imports it).
 */
registerGenerator((expression, options = {}) => {
  // py: `copy` belongs to `Dialect.generate`, everything else to the Generator ctor.
  const { copy = true, ...generatorOptions } = options;
  return new Generator(generatorOptions).generate(expression, copy);
});
