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
import { PyValueError } from "./_py/errors.js";
import { PyDecimal } from "./_py/num.js";
import { csv, nameSequence } from "./helper.js";
import { logger } from "./logging.js";
import { cpAt, cpLen, cpSlice, pyIsDigit, pyIsSpace, pyLower, pyLstrip, pyStrip, pyRstrip, pyUpper } from "./_py/str.js";
import * as exp from "./expressions/index.js";
import { registerGenerator } from "./expressions/core.js";
import { formatTime } from "./time.js";

/**
 * py: sqlglot/generator.py:65 `AFTER_HAVING_MODIFIER_TRANSFORMS`
 *
 * Module-level, and deliberately kept module-level: the class-level table of the same
 * name at py:671 spreads this one and adds three more keys, so they are two distinct
 * objects upstream and collapsing them would change `Generator`'s own table.
 */
export const AFTER_HAVING_MODIFIER_TRANSFORMS = new Map([
  // py:66  ["windows", ...]  — needs `expressions()` on the `windows` key; stub-queue scope
  // py:70  ["qualify", ...]  — trivial, but paired with the above; stub-queue scope
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
 * Truthiness of `expression.args[arg_name]` uses plain JS truthiness, matching every
 * other `expression.args[key]` read already in this file (none route through
 * `pyTruthy`) — a real divergence only for an empty-list-valued arg, which none of the
 * call sites that exist today (`count`, `weight`, `accuracy`, `ins_cost`, `del_cost`,
 * `sub_cost`) can take.
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
        if (expression.args[arg_name]) {
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
    //         Wildcard} (jsonpath.py:219, verified against the pin). Spelled out because
    //         a lone "SPREAD" line reads as ONE seeded item while standing for ten
    //         unseeded ones — R14's shape. 133 explicit entries below + these 10 = the
    //         143 that `Generator.TRANSFORMS` resolves to upstream. Fill from
    //         `src/jsonpath.js`'s own table when it lands, never by hand.
    // py:138 — ported alongside `generators/postgres.js` (PORT_PLAN.md P4): reached by
    // corpus rows like `NUMRANGE(...) -|- NUMRANGE(...)`, which previously threw
    // "Unsupported expression type Adjacent" (no dispatch entry at all).
    [exp.Adjacent, (self, e) => self.binary(e, "-|-")],
    // py:139  [exp.AllowedValuesProperty, /* TODO lambda */],
    // py:142  [exp.AnalyzeColumns, /* TODO lambda */],
    // py:143  [exp.AnalyzeWith, /* TODO lambda */],
    // py:144-146 — ported alongside `generators/postgres.js` (PORT_PLAN.md P4), whose
    // `TRANSFORMS` inherits these three straight from the base map (`{**Generator.
    // TRANSFORMS, ...}`, no Postgres-specific override) and is the first dialect
    // generator in this port to reach any of them, per real-corpus mismatches
    // (`ARRAY_CONTAINS_ALL(a, b)`/`ARRAY_OVERLAPS(...)` function-fallback rendering
    // where CPython emits the bare infix operator).
    [exp.ArrayContainedBy, (self, e) => self.binary(e, "<@")],
    [exp.ArrayContainsAll, (self, e) => self.binary(e, "@>")],
    [exp.ArrayOverlaps, (self, e) => self.binary(e, "&&")],
    // py:147  [exp.AssumeColumnConstraint, /* TODO lambda */],
    // py:148  [exp.AutoRefreshProperty, /* TODO lambda */],
    // py:149  [exp.BackupProperty, /* TODO lambda */],
    // py:150  [exp.CaseSpecificColumnConstraint, /* TODO lambda */],
    // py:153  [exp.CalledOnNullInputProperty, /* TODO lambda */],
    // py:154  [exp.Ceil, /* TODO lambda */],
    // py:155  [exp.CharacterSetColumnConstraint, /* TODO lambda */],
    // py:156  [exp.CharacterSetProperty, /* TODO lambda */],
    // py:159  [exp.ClusteredColumnConstraint, /* TODO lambda */],
    // py:162  [exp.CollateColumnConstraint, /* TODO lambda */],
    // py:163  [exp.CommentColumnConstraint, /* TODO lambda */],
    // py:164  [exp.ConnectByRoot, /* TODO lambda */],
    // py:165  [exp.ConvertToCharset, /* TODO lambda */],
    // py:168  [exp.CopyGrantsProperty, /* TODO lambda */],
    // py:169  [exp.CredentialsProperty, /* TODO lambda */],
    // py:172  [exp.CurrentCatalog, /* TODO lambda */],
    // py:173  [exp.SessionUser, /* TODO lambda */],
    // py:174  [exp.DateFormatColumnConstraint, /* TODO lambda */],
    // py:175  [exp.DefaultColumnConstraint, /* TODO lambda */],
    // py:176  [exp.ApiProperty, /* TODO lambda */],
    // py:177  [exp.ApplicationProperty, /* TODO lambda */],
    // py:178  [exp.CatalogProperty, /* TODO lambda */],
    // py:179  [exp.ComputeProperty, /* TODO lambda */],
    // py:180  [exp.DatabaseProperty, /* TODO lambda */],
    // py:181  [exp.DynamicProperty, /* TODO lambda */],
    // py:182  [exp.EmptyProperty, /* TODO lambda */],
    // py:183  [exp.EncodeColumnConstraint, /* TODO lambda */],
    // py:184  [exp.EndStatement, /* TODO lambda */],
    // py:185  [exp.EnviromentProperty, /* TODO lambda */],
    // py:186  [exp.HandlerProperty, /* TODO lambda */],
    // py:187  [exp.ParameterStyleProperty, /* TODO lambda */],
    // py:188  [exp.EphemeralColumnConstraint, /* TODO lambda */],
    // py:191  [exp.ExcludeColumnConstraint, /* TODO lambda */],
    // py:192  [exp.ExecuteAsProperty, /* TODO lambda */],
    // py:193 — ported alongside `generators/postgres.js` (PORT_PLAN.md P4), same
    // `set_operations` wiring as `exp.Intersect`/`exp.Union` below.
    [exp.Except, (self, e) => self.set_operations(e)],
    // py:194  [exp.ExternalProperty, /* TODO lambda */],
    // py:195  [exp.Floor, /* TODO lambda */],
    // py:196  [exp.Get, /* TODO lambda */],
    // py:197  [exp.GlobalProperty, /* TODO lambda */],
    // py:198  [exp.HeapProperty, /* TODO lambda */],
    // py:199  [exp.HybridProperty, /* TODO lambda */],
    // py:200  [exp.IcebergProperty, /* TODO lambda */],
    // py:201  [exp.InheritsProperty, /* TODO lambda */],
    // py:202  [exp.InlineLengthColumnConstraint, /* TODO lambda */],
    // py:203  [exp.InputModelProperty, /* TODO lambda */],
    // py:204 — ported alongside `generators/postgres.js` (PORT_PLAN.md P4), same
    // `set_operations` wiring as `exp.Except`/`exp.Union`.
    [exp.Intersect, (self, e) => self.set_operations(e)],
    // py:205  [exp.IntervalSpan, /* TODO lambda */],
    // py:206  [exp.Int64, /* TODO lambda */],
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
    // py:212  [exp.JSONObject, /* TODO lambda */],
    // py:213  [exp.JSONObjectAgg, /* TODO lambda */],
    // py:214  [exp.LanguageProperty, /* TODO lambda */],
    // py:215  [exp.LocationProperty, /* TODO lambda */],
    // py:216  [exp.LogProperty, /* TODO lambda */],
    // py:217  [exp.MaskingProperty, /* TODO lambda */],
    // py:218  [exp.MaterializedProperty, /* TODO lambda */],
    // py:219  [exp.NetFunc, /* TODO lambda */],
    // py:220  [exp.NetworkProperty, /* TODO lambda */],
    // py:221  [exp.NonClusteredColumnConstraint, /* TODO lambda */],
    // py:224  [exp.NoPrimaryIndexProperty, /* TODO lambda */],
    // py:225  [exp.NotForReplicationColumnConstraint, /* TODO lambda */],
    // py:226  [exp.OnCommitProperty, /* TODO lambda */],
    // py:229  [exp.OnProperty, /* TODO lambda */],
    // py:230  [exp.OnUpdateColumnConstraint, /* TODO lambda */],
    // py:231 — ported alongside `generators/postgres.js` (PORT_PLAN.md P4): reached by
    // `pg_catalog`-style custom-operator corpus rows, which previously threw
    // "Unsupported expression type Operator". `self.binary`'s own `node.args.operator`
    // branch (already ported) is what actually renders `OPERATOR(...)` — the empty
    // string here is upstream's own comment: "The operator is produced in `binary`".
    [exp.Operator, (self, e) => self.binary(e, "")],
    // py:232  [exp.OutputModelProperty, /* TODO lambda */],
    // py:233  [exp.ExtendsLeft, /* TODO lambda */],
    // py:234  [exp.ExtendsRight, /* TODO lambda */],
    // py:235  [exp.PathColumnConstraint, /* TODO lambda */],
    // py:236  [exp.PartitionedByBucket, /* TODO lambda */],
    // py:237  [exp.PartitionByTruncate, /* TODO lambda */],
    // py:238  [exp.PivotAny, /* TODO lambda */],
    // py:239  [exp.PositionalColumn, /* TODO lambda */],
    // py:240  [exp.ProjectionPolicyColumnConstraint, /* TODO lambda */],
    // py:243  [exp.InvisibleColumnConstraint, /* TODO lambda */],
    // py:244  [exp.ZeroFillColumnConstraint, /* TODO lambda */],
    // py:245  [exp.Put, /* TODO lambda */],
    // py:246  [exp.RemoteWithConnectionModelProperty, /* TODO lambda */],
    // py:249  [exp.ReturnsProperty, /* TODO lambda */],
    // py:252  [exp.RowAccessProperty, /* TODO lambda */],
    // py:253  [exp.SafeFunc, /* TODO lambda */],
    // py:254  [exp.SampleProperty, /* TODO lambda */],
    // py:255  [exp.SecureProperty, /* TODO lambda */],
    // py:256  [exp.SecurityIntegrationProperty, /* TODO lambda */],
    // py:257  [exp.SetConfigProperty, /* TODO lambda */],
    // py:258  [exp.SetProperty, /* TODO lambda */],
    // py:259  [exp.SettingsProperty, /* TODO lambda */],
    // py:260  [exp.SharingProperty, /* TODO lambda */],
    // py:261  [exp.SqlReadWriteProperty, /* TODO lambda */],
    // py:262  [exp.SqlSecurityProperty, /* TODO lambda */],
    // py:263  [exp.StabilityProperty, /* TODO lambda */],
    // py:264  [exp.Stream, /* TODO lambda */],
    // py:265  [exp.StreamingTableProperty, /* TODO lambda */],
    // py:266  [exp.StrictProperty, /* TODO lambda */],
    // py:267  [exp.SwapTable, /* TODO lambda */],
    // py:268  [exp.TableColumn, /* TODO lambda */],
    // py:269  [exp.Tags, /* TODO lambda */],
    // py:270  [exp.TemporaryProperty, /* TODO lambda */],
    // py:271  [exp.TitleColumnConstraint, /* TODO lambda */],
    // py:272  [exp.ToMap, /* TODO lambda */],
    // py:273  [exp.ToTableProperty, /* TODO lambda */],
    // py:274  [exp.TransformModelProperty, /* TODO lambda */],
    // py:275  [exp.TransientProperty, /* TODO lambda */],
    // py:276  [exp.VirtualProperty, /* TODO lambda */],
    // py:277  [exp.TriggerExecute, /* TODO lambda */],
    // py:278 — ported alongside `generators/postgres.js` (PORT_PLAN.md P4): a plain
    // `WITH RECURSIVE ... UNION ...` corpus row reached `set_operations`/
    // `set_operation` above, both real bodies now rather than `NotPorted` stubs.
    [exp.Union, (self, e) => self.set_operations(e)],
    // py:279  [exp.UnloggedProperty, /* TODO lambda */],
    // py:280  [exp.UsingTemplateProperty, /* TODO lambda */],
    // py:281  [exp.UsingData, /* TODO lambda */],
    // py:282  [exp.UppercaseColumnConstraint, /* TODO lambda */],
    // py:283  [exp.UtcDate, /* TODO lambda */],
    // py:284  [exp.UtcTime, /* TODO lambda */],
    // py:285  [exp.UtcTimestamp, /* TODO lambda */],
    // py:288 — ported alongside `generators/postgres.js` (PORT_PLAN.md P4): reached by
    // corpus rows like `MLEAST(VARIADIC ...)`, which previously threw "Unsupported
    // expression type Variadic" (no dispatch entry at all, not even a wrong string).
    [exp.Variadic, (self, e) => `VARIADIC ${self.sql(e, "this")}`],
    // py:289  [exp.VarMap, /* TODO lambda */],
    // py:290  [exp.ViewAttributeProperty, /* TODO lambda */],
    // py:291  [exp.VolatileProperty, /* TODO lambda */],
    // py:292  [exp.WithJournalTableProperty, /* TODO lambda */],
    // py:293  [exp.WithProcedureOptions, /* TODO lambda */],
    // py:294  [exp.WithSchemaBindingProperty, /* TODO lambda */],
    // py:295  [exp.WithOperator, /* TODO lambda */],
    // py:296  [exp.ForceProperty, /* TODO lambda */],
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

  /**
   * py: sqlglot/generator.py:671
   *
   * `cluster`/`distribute`/`sort` were TODO-commented stubs left by the P4 "render a
   * basic SELECT statement" keystone group (R25) — those three DML-only modifiers
   * (Hive/Spark's `CLUSTER BY`/`DISTRIBUTE BY`/`SORT BY`) had no caller until the
   * Databricks-chain generator step (PORT_PLAN.md) started reaching real HIVE corpus
   * rows through `query_modifiers`. `windows`/`qualify` (module-level
   * `AFTER_HAVING_MODIFIER_TRANSFORMS` above, py:65) stay unported — no dialect in this
   * port's scope reaches them yet.
   */
  static AFTER_HAVING_MODIFIER_TRANSFORMS = new Map([
    ["cluster", (self, e) => self.sql(e, "cluster")],
    ["distribute", (self, e) => self.sql(e, "distribute")],
    ["sort", (self, e) => self.sql(e, "sort")],
    // py:675  `**AFTER_HAVING_MODIFIER_TRANSFORMS` — the module-level constant (py:65,
    // "windows"/"qualify"), which is a no-op today: both its entries are themselves
    // still stub-queue-scoped comments, so the spread adds zero real keys. Spread
    // anyway, rather than leaving the merge as a TODO, so this class field's shape
    // matches upstream's `{**AFTER_HAVING_MODIFIER_TRANSFORMS}` construction exactly
    // and needs no further edit the day "windows"/"qualify" land for real.
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
      // transforms.js is P4 stub-queue scope, deliberately not ported here. Base
      // `Generator.ENSURE_BOOLS` is False, so this branch is unreachable for the base
      // class and only a dialect that flips it can hit this throw — loudly, rather
      // than silently skipping a transform that changes output SQL.
      throw new NotPorted("preprocess/ensure_bools", "sqlglot/generator.py:981");
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
      // Same reasoning as `preprocess` above: base `EXPRESSIONS_WITHOUT_NESTED_CTES` is
      // an empty set, so only a dialect that populates it reaches this.
      throw new NotPorted("_move_ctes_to_top_level", "sqlglot/generator.py:994");
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
  uncache_sql(expression) { throw new NotPorted("uncache_sql", "sqlglot/generator.py:1135"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1140
  cache_sql(expression) { throw new NotPorted("cache_sql", "sqlglot/generator.py:1140"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1150
  characterset_sql(expression) { throw new NotPorted("characterset_sql", "sqlglot/generator.py:1150"); }

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
  pseudocolumn_sql(expression) { throw new NotPorted("pseudocolumn_sql", "sqlglot/generator.py:1179"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1182
  columnposition_sql(expression) { throw new NotPorted("columnposition_sql", "sqlglot/generator.py:1182"); }

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

  /** @returns {*} */
  // py: sqlglot/generator.py:1203
  columnconstraint_sql(expression) { throw new NotPorted("columnconstraint_sql", "sqlglot/generator.py:1203"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1208
  computedcolumnconstraint_sql(expression) { throw new NotPorted("computedcolumnconstraint_sql", "sqlglot/generator.py:1208"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1219
  autoincrementcolumnconstraint_sql(_) { throw new NotPorted("autoincrementcolumnconstraint_sql", "sqlglot/generator.py:1219"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1222
  compresscolumnconstraint_sql(expression) { throw new NotPorted("compresscolumnconstraint_sql", "sqlglot/generator.py:1222"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1230
  generatedasidentitycolumnconstraint_sql(expression) { throw new NotPorted("generatedasidentitycolumnconstraint_sql", "sqlglot/generator.py:1230"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1263
  generatedasrowcolumnconstraint_sql(expression) { throw new NotPorted("generatedasrowcolumnconstraint_sql", "sqlglot/generator.py:1263"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1270
  periodforsystemtimeconstraint_sql(expression) { throw new NotPorted("periodforsystemtimeconstraint_sql", "sqlglot/generator.py:1270"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1275
  notnullcolumnconstraint_sql(expression) { throw new NotPorted("notnullcolumnconstraint_sql", "sqlglot/generator.py:1275"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1278
  primarykeycolumnconstraint_sql(expression) { throw new NotPorted("primarykeycolumnconstraint_sql", "sqlglot/generator.py:1278"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1286
  uniquecolumnconstraint_sql(expression) { throw new NotPorted("uniquecolumnconstraint_sql", "sqlglot/generator.py:1286"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1298
  inoutcolumnconstraint_sql(expression) { throw new NotPorted("inoutcolumnconstraint_sql", "sqlglot/generator.py:1298"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1316
  createable_sql(expression, locations) { throw new NotPorted("createable_sql", "sqlglot/generator.py:1316"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1319
  create_sql(expression) { throw new NotPorted("create_sql", "sqlglot/generator.py:1319"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1440
  sequenceproperties_sql(expression) { throw new NotPorted("sequenceproperties_sql", "sqlglot/generator.py:1440"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1465
  triggerproperties_sql(expression) { throw new NotPorted("triggerproperties_sql", "sqlglot/generator.py:1465"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1494
  triggerreferencing_sql(expression) { throw new NotPorted("triggerreferencing_sql", "sqlglot/generator.py:1494"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1505
  triggerevent_sql(expression) { throw new NotPorted("triggerevent_sql", "sqlglot/generator.py:1505"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1512
  clone_sql(expression) { throw new NotPorted("clone_sql", "sqlglot/generator.py:1512"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1518
  describe_sql(expression) { throw new NotPorted("describe_sql", "sqlglot/generator.py:1518"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1529
  heredoc_sql(expression) { throw new NotPorted("heredoc_sql", "sqlglot/generator.py:1529"); }

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
  bitstring_sql(expression) { throw new NotPorted("bitstring_sql", "sqlglot/generator.py:1592"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1598
  hexstring_sql(expression, binary_function_repr) { throw new NotPorted("hexstring_sql", "sqlglot/generator.py:1598"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1623
  bytestring_sql(expression) { throw new NotPorted("bytestring_sql", "sqlglot/generator.py:1623"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1654
  unicodestring_sql(expression) { throw new NotPorted("unicodestring_sql", "sqlglot/generator.py:1654"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1685
  rawstring_sql(expression) { throw new NotPorted("rawstring_sql", "sqlglot/generator.py:1685"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1693
  datatypeparam_sql(expression) { throw new NotPorted("datatypeparam_sql", "sqlglot/generator.py:1693"); }

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
  directory_sql(expression) { throw new NotPorted("directory_sql", "sqlglot/generator.py:1803"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1809
  delete_sql(expression) { throw new NotPorted("delete_sql", "sqlglot/generator.py:1809"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1829
  drop_sql(expression) { throw new NotPorted("drop_sql", "sqlglot/generator.py:1829"); }

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
  fetch_sql(expression) { throw new NotPorted("fetch_sql", "sqlglot/generator.py:1924"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1933
  limitoptions_sql(expression) { throw new NotPorted("limitoptions_sql", "sqlglot/generator.py:1933"); }

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
  hint_sql(expression) { throw new NotPorted("hint_sql", "sqlglot/generator.py:1946"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1953
  indexparameters_sql(expression) { throw new NotPorted("indexparameters_sql", "sqlglot/generator.py:1953"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1973
  index_sql(expression) { throw new NotPorted("index_sql", "sqlglot/generator.py:1973"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:1987
  dynamicidentifier_sql(expression) { throw new NotPorted("dynamicidentifier_sql", "sqlglot/generator.py:1987"); }

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
  hex_sql(expression) { throw new NotPorted("hex_sql", "sqlglot/generator.py:2018"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2025
  lowerhex_sql(expression) { throw new NotPorted("lowerhex_sql", "sqlglot/generator.py:2025"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2031
  inputoutputformat_sql(expression) { throw new NotPorted("inputoutputformat_sql", "sqlglot/generator.py:2031"); }

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
  partition_sql(expression) { throw new NotPorted("partition_sql", "sqlglot/generator.py:2042"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2046
  properties_sql(expression) { throw new NotPorted("properties_sql", "sqlglot/generator.py:2046"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2071
  root_properties(properties) { throw new NotPorted("root_properties", "sqlglot/generator.py:2071"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2076
  properties(properties, prefix, sep, suffix, wrapped) { throw new NotPorted("properties", "sqlglot/generator.py:2076"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2091
  with_properties(properties) { throw new NotPorted("with_properties", "sqlglot/generator.py:2091"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2094
  locate_properties(properties) { throw new NotPorted("locate_properties", "sqlglot/generator.py:2094"); }

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
  uuidproperty_sql(expression) { throw new NotPorted("uuidproperty_sql", "sqlglot/generator.py:2121"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2124
  likeproperty_sql(expression) { throw new NotPorted("likeproperty_sql", "sqlglot/generator.py:2124"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2141
  fallbackproperty_sql(expression) { throw new NotPorted("fallbackproperty_sql", "sqlglot/generator.py:2141"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2146
  journalproperty_sql(expression) { throw new NotPorted("journalproperty_sql", "sqlglot/generator.py:2146"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2155
  freespaceproperty_sql(expression) { throw new NotPorted("freespaceproperty_sql", "sqlglot/generator.py:2155"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2160
  checksumproperty_sql(expression) { throw new NotPorted("checksumproperty_sql", "sqlglot/generator.py:2160"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2169
  mergeblockratioproperty_sql(expression) { throw new NotPorted("mergeblockratioproperty_sql", "sqlglot/generator.py:2169"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2178
  moduleproperty_sql(expression) { throw new NotPorted("moduleproperty_sql", "sqlglot/generator.py:2178"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2183
  datablocksizeproperty_sql(expression) { throw new NotPorted("datablocksizeproperty_sql", "sqlglot/generator.py:2183"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2199
  blockcompressionproperty_sql(expression) { throw new NotPorted("blockcompressionproperty_sql", "sqlglot/generator.py:2199"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2218
  isolatedloadingproperty_sql(expression) { throw new NotPorted("isolatedloadingproperty_sql", "sqlglot/generator.py:2218"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2227
  partitionboundspec_sql(expression) { throw new NotPorted("partitionboundspec_sql", "sqlglot/generator.py:2227"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2239
  partitionedofproperty_sql(expression) { throw new NotPorted("partitionedofproperty_sql", "sqlglot/generator.py:2239"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2250
  lockingproperty_sql(expression) { throw new NotPorted("lockingproperty_sql", "sqlglot/generator.py:2250"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2259
  withdataproperty_sql(expression) { throw new NotPorted("withdataproperty_sql", "sqlglot/generator.py:2259"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2267
  withsystemversioningproperty_sql(expression) { throw new NotPorted("withsystemversioningproperty_sql", "sqlglot/generator.py:2267"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2288
  insert_sql(expression) { throw new NotPorted("insert_sql", "sqlglot/generator.py:2288"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2335
  introducer_sql(expression) { throw new NotPorted("introducer_sql", "sqlglot/generator.py:2335"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2338
  kill_sql(expression) { throw new NotPorted("kill_sql", "sqlglot/generator.py:2338"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2345
  pseudotype_sql(expression) { throw new NotPorted("pseudotype_sql", "sqlglot/generator.py:2345"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2348
  objectidentifier_sql(expression) { throw new NotPorted("objectidentifier_sql", "sqlglot/generator.py:2348"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2351
  onconflict_sql(expression) { throw new NotPorted("onconflict_sql", "sqlglot/generator.py:2351"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2374
  returning_sql(expression) { throw new NotPorted("returning_sql", "sqlglot/generator.py:2374"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2377
  rowformatdelimitedproperty_sql(expression) { throw new NotPorted("rowformatdelimitedproperty_sql", "sqlglot/generator.py:2377"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2392
  withtablehint_sql(expression) { throw new NotPorted("withtablehint_sql", "sqlglot/generator.py:2392"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2395
  indextablehint_sql(expression) { throw new NotPorted("indextablehint_sql", "sqlglot/generator.py:2395"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2401
  historicaldata_sql(expression) { throw new NotPorted("historicaldata_sql", "sqlglot/generator.py:2401"); }

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

  /** @returns {*} */
  // py: sqlglot/generator.py:2485
  tablefromrows_sql(expression) { throw new NotPorted("tablefromrows_sql", "sqlglot/generator.py:2485"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2496
  tablesample_sql(expression, tablesample_keyword) { throw new NotPorted("tablesample_sql", "sqlglot/generator.py:2496"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2525
  _pivot_in_value_aliases(expression) { throw new NotPorted("_pivot_in_value_aliases", "sqlglot/generator.py:2525"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2600
  pivot_sql(expression) { throw new NotPorted("pivot_sql", "sqlglot/generator.py:2600"); }

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

  /** @returns {*} */
  // py: sqlglot/generator.py:2659
  _update_from_joins_sql(expression) { throw new NotPorted("_update_from_joins_sql", "sqlglot/generator.py:2659"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2691
  update_sql(expression) { throw new NotPorted("update_sql", "sqlglot/generator.py:2691"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2709
  values_sql(expression, values_as_table) { throw new NotPorted("values_sql", "sqlglot/generator.py:2709"); }

  /**
   * py: sqlglot/generator.py:2753
   * @param {exp.Var} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:2753
  var_sql(expression) { return this.sql(expression, "this"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2757
  into_sql(expression) { throw new NotPorted("into_sql", "sqlglot/generator.py:2757"); }

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
  groupingsets_sql(expression) { throw new NotPorted("groupingsets_sql", "sqlglot/generator.py:2765"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2769
  rollup_sql(expression) { throw new NotPorted("rollup_sql", "sqlglot/generator.py:2769"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2773
  rollupindex_sql(expression) { throw new NotPorted("rollupindex_sql", "sqlglot/generator.py:2773"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2788
  rollupproperty_sql(expression) { throw new NotPorted("rollupproperty_sql", "sqlglot/generator.py:2788"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2791
  cube_sql(expression) { throw new NotPorted("cube_sql", "sqlglot/generator.py:2791"); }

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

  /** @returns {*} */
  // py: sqlglot/generator.py:2827
  having_sql(expression) { throw new NotPorted("having_sql", "sqlglot/generator.py:2827"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2831
  connect_sql(expression) { throw new NotPorted("connect_sql", "sqlglot/generator.py:2831"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2839
  prior_sql(expression) { throw new NotPorted("prior_sql", "sqlglot/generator.py:2839"); }

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

  /** @returns {*} */
  // py: sqlglot/generator.py:2958
  setitem_sql(expression) { throw new NotPorted("setitem_sql", "sqlglot/generator.py:2958"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2971
  set_sql(expression) { throw new NotPorted("set_sql", "sqlglot/generator.py:2971"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2976
  queryband_sql(expression) { throw new NotPorted("queryband_sql", "sqlglot/generator.py:2976"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2984
  pragma_sql(expression) { throw new NotPorted("pragma_sql", "sqlglot/generator.py:2984"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:2987
  lock_sql(expression) { throw new NotPorted("lock_sql", "sqlglot/generator.py:2987"); }

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
  loaddata_sql(expression) { throw new NotPorted("loaddata_sql", "sqlglot/generator.py:3040"); }

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
  booland_sql(expression) { throw new NotPorted("booland_sql", "sqlglot/generator.py:3074"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3077
  boolor_sql(expression) { throw new NotPorted("boolor_sql", "sqlglot/generator.py:3077"); }

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
  withfill_sql(expression) { throw new NotPorted("withfill_sql", "sqlglot/generator.py:3086"); }

  /**
   * py: sqlglot/generator.py:3104
   * @param {exp.Cluster} expression
   * @returns {string}
   */
  // py: sqlglot/generator.py:3104
  cluster_sql(expression) { return this.op_expressions("CLUSTER BY", expression); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3107
  clusterproperty_sql(expression) { throw new NotPorted("clusterproperty_sql", "sqlglot/generator.py:3107"); }

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
  _resolve_ordered_for_null_ordering_simulation(expression) { throw new NotPorted("_resolve_ordered_for_null_ordering_simulation", "sqlglot/generator.py:3120"); }

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

  /** @returns {*} */
  // py: sqlglot/generator.py:3235
  matchrecognizemeasure_sql(expression) { throw new NotPorted("matchrecognizemeasure_sql", "sqlglot/generator.py:3235"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3243
  matchrecognize_sql(expression) { throw new NotPorted("matchrecognize_sql", "sqlglot/generator.py:3243"); }

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

  /** @returns {*} */
  // py: sqlglot/generator.py:3311
  forclause_sql(expression) { throw new NotPorted("forclause_sql", "sqlglot/generator.py:3311"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3322
  queryoption_sql(expression) { throw new NotPorted("queryoption_sql", "sqlglot/generator.py:3322"); }

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

    const exclude = expression.args.exclude;

    if (!cls.STAR_EXCLUDE_REQUIRES_DERIVED_TABLE && exclude) {
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

    if (cls.STAR_EXCLUDE_REQUIRES_DERIVED_TABLE && exclude) {
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
  parameter_sql(expression) { throw new NotPorted("parameter_sql", "sqlglot/generator.py:3444"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3448
  sessionparameter_sql(expression) { throw new NotPorted("sessionparameter_sql", "sqlglot/generator.py:3448"); }

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
  qualify_sql(expression) { throw new NotPorted("qualify_sql", "sqlglot/generator.py:3472"); }

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
  prewhere_sql(expression) { throw new NotPorted("prewhere_sql", "sqlglot/generator.py:3506"); }

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
  window_sql(expression) { throw new NotPorted("window_sql", "sqlglot/generator.py:3513"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3538
  partition_by_sql(expression) { throw new NotPorted("partition_by_sql", "sqlglot/generator.py:3538"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3542
  windowspec_sql(expression) { throw new NotPorted("windowspec_sql", "sqlglot/generator.py:3542"); }

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

    return exp.applyIndexOffset(
      expression.this,
      expression.expressions,
      (index_offset ?? this.dialect.INDEX_OFFSET) - (expression.args.offset ?? 0),
      { dialect: this.dialect },
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
  constraint_sql(expression) { throw new NotPorted("constraint_sql", "sqlglot/generator.py:3639"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3644
  nextvaluefor_sql(expression) { throw new NotPorted("nextvaluefor_sql", "sqlglot/generator.py:3644"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3649
  extract_sql(expression) { throw new NotPorted("extract_sql", "sqlglot/generator.py:3649"); }

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
  convert_concat_args(expression) { throw new NotPorted("convert_concat_args", "sqlglot/generator.py:3679"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3710
  concat_sql(expression) { throw new NotPorted("concat_sql", "sqlglot/generator.py:3710"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3727
  concatws_sql(expression) { throw new NotPorted("concatws_sql", "sqlglot/generator.py:3727"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3743
  check_sql(expression) { throw new NotPorted("check_sql", "sqlglot/generator.py:3743"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3747
  foreignkey_sql(expression) { throw new NotPorted("foreignkey_sql", "sqlglot/generator.py:3747"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3760
  primarykey_sql(expression) { throw new NotPorted("primarykey_sql", "sqlglot/generator.py:3760"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3769
  timeserieskey_sql(expression) { throw new NotPorted("timeserieskey_sql", "sqlglot/generator.py:3769"); }

  /** py: sqlglot/generator.py:3773 — ported for PORT_PLAN.md R32. */
  if_sql(expression) {
    return this.case_sql(new exp.Case({ ifs: [expression], default: expression.args.false }));
  }

  /** @returns {*} */
  // py: sqlglot/generator.py:3776
  matchagainst_sql(expression) { throw new NotPorted("matchagainst_sql", "sqlglot/generator.py:3776"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3793
  jsonkeyvalue_sql(expression) { throw new NotPorted("jsonkeyvalue_sql", "sqlglot/generator.py:3793"); }

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
  formatjson_sql(expression) { throw new NotPorted("formatjson_sql", "sqlglot/generator.py:3825"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3828
  formatphrase_sql(expression) { throw new NotPorted("formatphrase_sql", "sqlglot/generator.py:3828"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3835
  _jsonobject_sql(expression, name) { throw new NotPorted("_jsonobject_sql", "sqlglot/generator.py:3835"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3861
  jsonarray_sql(expression) { throw new NotPorted("jsonarray_sql", "sqlglot/generator.py:3861"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3871
  jsonarrayagg_sql(expression) { throw new NotPorted("jsonarrayagg_sql", "sqlglot/generator.py:3871"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3885
  jsoncolumndef_sql(expression) { throw new NotPorted("jsoncolumndef_sql", "sqlglot/generator.py:3885"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3901
  jsonschema_sql(expression) { throw new NotPorted("jsonschema_sql", "sqlglot/generator.py:3901"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3904
  jsontable_sql(expression) { throw new NotPorted("jsontable_sql", "sqlglot/generator.py:3904"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3917
  openjsoncolumndef_sql(expression) { throw new NotPorted("openjsoncolumndef_sql", "sqlglot/generator.py:3917"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3925
  openjson_sql(expression) { throw new NotPorted("openjson_sql", "sqlglot/generator.py:3925"); }

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
  in_unnest_op(unnest) { throw new NotPorted("in_unnest_op", "sqlglot/generator.py:3954"); }

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
  return_sql(expression) { throw new NotPorted("return_sql", "sqlglot/generator.py:3989"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:3992
  reference_sql(expression) { throw new NotPorted("reference_sql", "sqlglot/generator.py:3992"); }

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

  /** @returns {*} */
  // py: sqlglot/generator.py:4013
  neg_sql(expression) { throw new NotPorted("neg_sql", "sqlglot/generator.py:4013"); }

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
  pivotalias_sql(expression) { throw new NotPorted("pivotalias_sql", "sqlglot/generator.py:4027"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4044
  aliases_sql(expression) { throw new NotPorted("aliases_sql", "sqlglot/generator.py:4044"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4047
  atindex_sql(expression) { throw new NotPorted("atindex_sql", "sqlglot/generator.py:4047"); }

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
  fromtimezone_sql(expression) { throw new NotPorted("fromtimezone_sql", "sqlglot/generator.py:4057"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4062
  fromiso8601date_sql(expression) { throw new NotPorted("fromiso8601date_sql", "sqlglot/generator.py:4062"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4065
  fromiso8601timestamp_sql(expression) { throw new NotPorted("fromiso8601timestamp_sql", "sqlglot/generator.py:4065"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4068
  fromiso8601timestampnanos_sql(expression) { throw new NotPorted("fromiso8601timestampnanos_sql", "sqlglot/generator.py:4068"); }

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
  xor_sql(expression, stack) { throw new NotPorted("xor_sql", "sqlglot/generator.py:4080"); }

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
  bitwiseand_sql(expression) { throw new NotPorted("bitwiseand_sql", "sqlglot/generator.py:4115"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4118
  bitwiseleftshift_sql(expression) { throw new NotPorted("bitwiseleftshift_sql", "sqlglot/generator.py:4118"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4121
  bitwisenot_sql(expression) { throw new NotPorted("bitwisenot_sql", "sqlglot/generator.py:4121"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4124
  bitwiseor_sql(expression) { throw new NotPorted("bitwiseor_sql", "sqlglot/generator.py:4124"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4127
  bitwiserightshift_sql(expression) { throw new NotPorted("bitwiserightshift_sql", "sqlglot/generator.py:4127"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4130
  bitwisexor_sql(expression) { throw new NotPorted("bitwisexor_sql", "sqlglot/generator.py:4130"); }

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
  strtotime_sql(expression) { throw new NotPorted("strtotime_sql", "sqlglot/generator.py:4145"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4149
  strtodate_sql(expression) { throw new NotPorted("strtodate_sql", "sqlglot/generator.py:4149"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4152
  parsedatetime_sql(expression) { throw new NotPorted("parsedatetime_sql", "sqlglot/generator.py:4152"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4160
  currentdate_sql(expression) { throw new NotPorted("currentdate_sql", "sqlglot/generator.py:4160"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4164
  collate_sql(expression) { throw new NotPorted("collate_sql", "sqlglot/generator.py:4164"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4169
  command_sql(expression) { throw new NotPorted("command_sql", "sqlglot/generator.py:4169"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4172
  comment_sql(expression) { throw new NotPorted("comment_sql", "sqlglot/generator.py:4172"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4180
  mergetreettlaction_sql(expression) { throw new NotPorted("mergetreettlaction_sql", "sqlglot/generator.py:4180"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4191
  mergetreettl_sql(expression) { throw new NotPorted("mergetreettl_sql", "sqlglot/generator.py:4191"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4202
  transaction_sql(expression) { throw new NotPorted("transaction_sql", "sqlglot/generator.py:4202"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4207
  commit_sql(expression) { throw new NotPorted("commit_sql", "sqlglot/generator.py:4207"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4214
  rollback_sql(expression) { throw new NotPorted("rollback_sql", "sqlglot/generator.py:4214"); }

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
  modifycolumn_sql(expression) { throw new NotPorted("modifycolumn_sql", "sqlglot/generator.py:4278"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4289
  alterindex_sql(expression) { throw new NotPorted("alterindex_sql", "sqlglot/generator.py:4289"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4297
  alterdiststyle_sql(expression) { throw new NotPorted("alterdiststyle_sql", "sqlglot/generator.py:4297"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4303
  altersortkey_sql(expression) { throw new NotPorted("altersortkey_sql", "sqlglot/generator.py:4303"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4310
  alterrename_sql(expression, include_to) { throw new NotPorted("alterrename_sql", "sqlglot/generator.py:4310"); }

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
  alterset_sql(expression) { throw new NotPorted("alterset_sql", "sqlglot/generator.py:4326"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4333
  alter_sql(expression) { throw new NotPorted("alter_sql", "sqlglot/generator.py:4333"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4379
  altersession_sql(expression) { throw new NotPorted("altersession_sql", "sqlglot/generator.py:4379"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4384
  add_column_sql(expression) { throw new NotPorted("add_column_sql", "sqlglot/generator.py:4384"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4395
  droppartition_sql(expression) { throw new NotPorted("droppartition_sql", "sqlglot/generator.py:4395"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4400
  dropprimarykey_sql(expression) { throw new NotPorted("dropprimarykey_sql", "sqlglot/generator.py:4400"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4403
  addconstraint_sql(expression) { throw new NotPorted("addconstraint_sql", "sqlglot/generator.py:4403"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4406
  addpartition_sql(expression) { throw new NotPorted("addpartition_sql", "sqlglot/generator.py:4406"); }

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
  respectnulls_sql(expression) { throw new NotPorted("respectnulls_sql", "sqlglot/generator.py:4430"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4433
  havingmax_sql(expression) { throw new NotPorted("havingmax_sql", "sqlglot/generator.py:4433"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4439
  intdiv_sql(expression) { throw new NotPorted("intdiv_sql", "sqlglot/generator.py:4439"); }

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
  div_sql(expression) { throw new NotPorted("div_sql", "sqlglot/generator.py:4452"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4473
  safedivide_sql(expression) { throw new NotPorted("safedivide_sql", "sqlglot/generator.py:4473"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4478
  overlaps_sql(expression) { throw new NotPorted("overlaps_sql", "sqlglot/generator.py:4478"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4481
  distance_sql(expression) { throw new NotPorted("distance_sql", "sqlglot/generator.py:4481"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4484
  distancend_sql(expression) { throw new NotPorted("distancend_sql", "sqlglot/generator.py:4484"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4487
  dot_sql(expression) { throw new NotPorted("dot_sql", "sqlglot/generator.py:4487"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4490
  eq_sql(expression) { return this.binary(expression, "="); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4493
  propertyeq_sql(expression) { throw new NotPorted("propertyeq_sql", "sqlglot/generator.py:4493"); }

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
  glob_sql(expression) { throw new NotPorted("glob_sql", "sqlglot/generator.py:4506"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4509
  gt_sql(expression) { return this.binary(expression, ">"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4512
  gte_sql(expression) { throw new NotPorted("gte_sql", "sqlglot/generator.py:4512"); }

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
  match_sql(expression) { throw new NotPorted("match_sql", "sqlglot/generator.py:4578"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4581
  similarto_sql(expression) { throw new NotPorted("similarto_sql", "sqlglot/generator.py:4581"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4584
  lt_sql(expression) { return this.binary(expression, "<"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4587
  lte_sql(expression) { throw new NotPorted("lte_sql", "sqlglot/generator.py:4587"); }

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
  jsoncast_sql(expression) { throw new NotPorted("jsoncast_sql", "sqlglot/generator.py:4611"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4614
  try_sql(expression) { throw new NotPorted("try_sql", "sqlglot/generator.py:4614"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4621
  log_sql(expression) { throw new NotPorted("log_sql", "sqlglot/generator.py:4621"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4635
  use_sql(expression) { throw new NotPorted("use_sql", "sqlglot/generator.py:4635"); }

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
  ceil_floor(expression) { throw new NotPorted("ceil_floor", "sqlglot/generator.py:4663"); }

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

  /** @returns {*} */
  // py: sqlglot/generator.py:4794
  tag_sql(expression) { throw new NotPorted("tag_sql", "sqlglot/generator.py:4794"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4797
  token_sql(token_type) { throw new NotPorted("token_sql", "sqlglot/generator.py:4797"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4800
  userdefinedfunction_sql(expression) { throw new NotPorted("userdefinedfunction_sql", "sqlglot/generator.py:4800"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4808
  macrooverloads_sql(expression) { throw new NotPorted("macrooverloads_sql", "sqlglot/generator.py:4808"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4811
  macrooverload_sql(expression) { throw new NotPorted("macrooverload_sql", "sqlglot/generator.py:4811"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4817
  joinhint_sql(expression) { throw new NotPorted("joinhint_sql", "sqlglot/generator.py:4817"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4822
  kwarg_sql(expression) { throw new NotPorted("kwarg_sql", "sqlglot/generator.py:4822"); }

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
  tonumber_sql(expression) { throw new NotPorted("tonumber_sql", "sqlglot/generator.py:4894"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4906
  dictproperty_sql(expression) { throw new NotPorted("dictproperty_sql", "sqlglot/generator.py:4906"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4913
  dictrange_sql(expression) { throw new NotPorted("dictrange_sql", "sqlglot/generator.py:4913"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4919
  dictsubproperty_sql(expression) { throw new NotPorted("dictsubproperty_sql", "sqlglot/generator.py:4919"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4922
  duplicatekeyproperty_sql(expression) { throw new NotPorted("duplicatekeyproperty_sql", "sqlglot/generator.py:4922"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4926
  uniquekeyproperty_sql(expression, prefix) { throw new NotPorted("uniquekeyproperty_sql", "sqlglot/generator.py:4926"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4932
  distributedbyproperty_sql(expression) { throw new NotPorted("distributedbyproperty_sql", "sqlglot/generator.py:4932"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4941
  oncluster_sql(expression) { throw new NotPorted("oncluster_sql", "sqlglot/generator.py:4941"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4944
  clusteredbyproperty_sql(expression) { throw new NotPorted("clusteredbyproperty_sql", "sqlglot/generator.py:4944"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4951
  anyvalue_sql(expression) { throw new NotPorted("anyvalue_sql", "sqlglot/generator.py:4951"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4960
  querytransform_sql(expression) { throw new NotPorted("querytransform_sql", "sqlglot/generator.py:4960"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:4975
  indexconstraintoption_sql(expression) { throw new NotPorted("indexconstraintoption_sql", "sqlglot/generator.py:4975"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5007
  checkcolumnconstraint_sql(expression) { throw new NotPorted("checkcolumnconstraint_sql", "sqlglot/generator.py:5007"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5011
  indexcolumnconstraint_sql(expression) { throw new NotPorted("indexcolumnconstraint_sql", "sqlglot/generator.py:5011"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5024
  nvl2_sql(expression) { throw new NotPorted("nvl2_sql", "sqlglot/generator.py:5024"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5039
  nthvalue_sql(expression) { throw new NotPorted("nthvalue_sql", "sqlglot/generator.py:5039"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5045
  comprehension_sql(expression) { throw new NotPorted("comprehension_sql", "sqlglot/generator.py:5045"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5055
  columnprefix_sql(expression) { throw new NotPorted("columnprefix_sql", "sqlglot/generator.py:5055"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5058
  opclass_sql(expression) { throw new NotPorted("opclass_sql", "sqlglot/generator.py:5058"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5061
  _ml_sql(expression, name) { throw new NotPorted("_ml_sql", "sqlglot/generator.py:5061"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5075
  predict_sql(expression) { throw new NotPorted("predict_sql", "sqlglot/generator.py:5075"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5078
  generateembedding_sql(expression) { throw new NotPorted("generateembedding_sql", "sqlglot/generator.py:5078"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5082
  generatetext_sql(expression) { throw new NotPorted("generatetext_sql", "sqlglot/generator.py:5082"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5085
  generatetable_sql(expression) { throw new NotPorted("generatetable_sql", "sqlglot/generator.py:5085"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5088
  generatebool_sql(expression) { throw new NotPorted("generatebool_sql", "sqlglot/generator.py:5088"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5091
  generateint_sql(expression) { throw new NotPorted("generateint_sql", "sqlglot/generator.py:5091"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5094
  generatedouble_sql(expression) { throw new NotPorted("generatedouble_sql", "sqlglot/generator.py:5094"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5097
  mltranslate_sql(expression) { throw new NotPorted("mltranslate_sql", "sqlglot/generator.py:5097"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5100
  mlforecast_sql(expression) { throw new NotPorted("mlforecast_sql", "sqlglot/generator.py:5100"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5103
  aiforecast_sql(expression) { throw new NotPorted("aiforecast_sql", "sqlglot/generator.py:5103"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5122
  featuresattime_sql(expression) { throw new NotPorted("featuresattime_sql", "sqlglot/generator.py:5122"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5135
  vectorsearch_sql(expression) { throw new NotPorted("vectorsearch_sql", "sqlglot/generator.py:5135"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5155
  forin_sql(expression) { throw new NotPorted("forin_sql", "sqlglot/generator.py:5155"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5160
  refresh_sql(expression) { throw new NotPorted("refresh_sql", "sqlglot/generator.py:5160"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5165
  toarray_sql(expression) { throw new NotPorted("toarray_sql", "sqlglot/generator.py:5165"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5178
  tsordstotime_sql(expression) { throw new NotPorted("tsordstotime_sql", "sqlglot/generator.py:5178"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5195
  tsordstotimestamp_sql(expression) { throw new NotPorted("tsordstotimestamp_sql", "sqlglot/generator.py:5195"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5202
  tsordstodatetime_sql(expression) { throw new NotPorted("tsordstodatetime_sql", "sqlglot/generator.py:5202"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5209
  tsordstodate_sql(expression) { throw new NotPorted("tsordstodate_sql", "sqlglot/generator.py:5209"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5229
  unixdate_sql(expression) { throw new NotPorted("unixdate_sql", "sqlglot/generator.py:5229"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5239
  lastday_sql(expression) { throw new NotPorted("lastday_sql", "sqlglot/generator.py:5239"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5249
  dateadd_sql(expression) { throw new NotPorted("dateadd_sql", "sqlglot/generator.py:5249"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5259
  arrayany_sql(expression) { throw new NotPorted("arrayany_sql", "sqlglot/generator.py:5259"); }

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
  partitionrange_sql(expression) { throw new NotPorted("partitionrange_sql", "sqlglot/generator.py:5287"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5293
  truncatetable_sql(expression) { throw new NotPorted("truncatetable_sql", "sqlglot/generator.py:5293"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5315
  convert_sql(expression) { throw new NotPorted("convert_sql", "sqlglot/generator.py:5315"); }

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

  /** @returns {*} */
  // py: sqlglot/generator.py:5383
  _jsonpathsubscript_sql(expression) { throw new NotPorted("_jsonpathsubscript_sql", "sqlglot/generator.py:5383"); }

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
  copyparameter_sql(expression) { throw new NotPorted("copyparameter_sql", "sqlglot/generator.py:5438"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5461
  credentials_sql(expression) { throw new NotPorted("credentials_sql", "sqlglot/generator.py:5461"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5486
  copy_sql(expression) { throw new NotPorted("copy_sql", "sqlglot/generator.py:5486"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5514
  semicolon_sql(expression) { throw new NotPorted("semicolon_sql", "sqlglot/generator.py:5514"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5517
  datadeletionproperty_sql(expression) { throw new NotPorted("datadeletionproperty_sql", "sqlglot/generator.py:5517"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5529
  maskingpolicycolumnconstraint_sql(expression) { throw new NotPorted("maskingpolicycolumnconstraint_sql", "sqlglot/generator.py:5529"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5537
  gapfill_sql(expression) { throw new NotPorted("gapfill_sql", "sqlglot/generator.py:5537"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5542
  scope_resolution(rhs, scope_name) { throw new NotPorted("scope_resolution", "sqlglot/generator.py:5542"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5545
  scoperesolution_sql(expression) { throw new NotPorted("scoperesolution_sql", "sqlglot/generator.py:5545"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5557
  parsejson_sql(expression) { throw new NotPorted("parsejson_sql", "sqlglot/generator.py:5557"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5563
  rand_sql(expression) { throw new NotPorted("rand_sql", "sqlglot/generator.py:5563"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5571
  changes_sql(expression) { throw new NotPorted("changes_sql", "sqlglot/generator.py:5571"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5581
  pad_sql(expression) { throw new NotPorted("pad_sql", "sqlglot/generator.py:5581"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5590
  summarize_sql(expression) { throw new NotPorted("summarize_sql", "sqlglot/generator.py:5590"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5594
  explodinggenerateseries_sql(expression) { throw new NotPorted("explodinggenerateseries_sql", "sqlglot/generator.py:5594"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5609
  converttimezone_sql(expression) { throw new NotPorted("converttimezone_sql", "sqlglot/generator.py:5609"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5626
  json_sql(expression) { throw new NotPorted("json_sql", "sqlglot/generator.py:5626"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5643
  jsonvalue_sql(expression) { throw new NotPorted("jsonvalue_sql", "sqlglot/generator.py:5643"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5653
  skipjsoncolumn_sql(expression) { throw new NotPorted("skipjsoncolumn_sql", "sqlglot/generator.py:5653"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5657
  conditionalinsert_sql(expression) { throw new NotPorted("conditionalinsert_sql", "sqlglot/generator.py:5657"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5664
  multitableinserts_sql(expression) { throw new NotPorted("multitableinserts_sql", "sqlglot/generator.py:5664"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5670
  oncondition_sql(expression) { throw new NotPorted("oncondition_sql", "sqlglot/generator.py:5670"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5698
  jsonextractquote_sql(expression) { throw new NotPorted("jsonextractquote_sql", "sqlglot/generator.py:5698"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5702
  jsonexists_sql(expression) { throw new NotPorted("jsonexists_sql", "sqlglot/generator.py:5702"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5716
  _add_arrayagg_null_filter(array_agg_sql, array_agg_expr, column_expr) { throw new NotPorted("_add_arrayagg_null_filter", "sqlglot/generator.py:5716"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5756
  arrayagg_sql(expression) { throw new NotPorted("arrayagg_sql", "sqlglot/generator.py:5756"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5764
  slice_sql(expression) { throw new NotPorted("slice_sql", "sqlglot/generator.py:5764"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5772
  apply_sql(expression) { throw new NotPorted("apply_sql", "sqlglot/generator.py:5772"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5778
  _grant_or_revoke_sql(expression, keyword, preposition, grant_option_prefix, grant_option_suffix) { throw new NotPorted("_grant_or_revoke_sql", "sqlglot/generator.py:5778"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5805
  grant_sql(expression) { throw new NotPorted("grant_sql", "sqlglot/generator.py:5805"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5813
  revoke_sql(expression) { throw new NotPorted("revoke_sql", "sqlglot/generator.py:5813"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5821
  grantprivilege_sql(expression) { throw new NotPorted("grantprivilege_sql", "sqlglot/generator.py:5821"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5828
  grantprincipal_sql(expression) { throw new NotPorted("grantprincipal_sql", "sqlglot/generator.py:5828"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5836
  columns_sql(expression) { throw new NotPorted("columns_sql", "sqlglot/generator.py:5836"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5843
  overlay_sql(expression) { throw new NotPorted("overlay_sql", "sqlglot/generator.py:5843"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5853
  todouble_sql(expression) { throw new NotPorted("todouble_sql", "sqlglot/generator.py:5853"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5857
  string_sql(expression) { throw new NotPorted("string_sql", "sqlglot/generator.py:5857"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5871
  median_sql(expression) { throw new NotPorted("median_sql", "sqlglot/generator.py:5871"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5879
  overflowtruncatebehavior_sql(expression) { throw new NotPorted("overflowtruncatebehavior_sql", "sqlglot/generator.py:5879"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5885
  unixseconds_sql(expression) { throw new NotPorted("unixseconds_sql", "sqlglot/generator.py:5885"); }

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
  attach_sql(expression) { throw new NotPorted("attach_sql", "sqlglot/generator.py:5910"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5918
  detach_sql(expression) { throw new NotPorted("detach_sql", "sqlglot/generator.py:5918"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5935
  attachoption_sql(expression) { throw new NotPorted("attachoption_sql", "sqlglot/generator.py:5935"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5941
  watermarkcolumnconstraint_sql(expression) { throw new NotPorted("watermarkcolumnconstraint_sql", "sqlglot/generator.py:5941"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5946
  encodeproperty_sql(expression) { throw new NotPorted("encodeproperty_sql", "sqlglot/generator.py:5946"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5956
  includeproperty_sql(expression) { throw new NotPorted("includeproperty_sql", "sqlglot/generator.py:5956"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5970
  xmlelement_sql(expression) { throw new NotPorted("xmlelement_sql", "sqlglot/generator.py:5970"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5975
  xmlkeyvalueoption_sql(expression) { throw new NotPorted("xmlkeyvalueoption_sql", "sqlglot/generator.py:5975"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5981
  partitionbyrangeproperty_sql(expression) { throw new NotPorted("partitionbyrangeproperty_sql", "sqlglot/generator.py:5981"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5986
  partitionbyrangepropertydynamic_sql(expression) { throw new NotPorted("partitionbyrangepropertydynamic_sql", "sqlglot/generator.py:5986"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:5998
  unpivotcolumns_sql(expression) { throw new NotPorted("unpivotcolumns_sql", "sqlglot/generator.py:5998"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6004
  analyzesample_sql(expression) { throw new NotPorted("analyzesample_sql", "sqlglot/generator.py:6004"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6009
  analyzestatistics_sql(expression) { throw new NotPorted("analyzestatistics_sql", "sqlglot/generator.py:6009"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6019
  analyzehistogram_sql(expression) { throw new NotPorted("analyzehistogram_sql", "sqlglot/generator.py:6019"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6028
  analyzedelete_sql(expression) { throw new NotPorted("analyzedelete_sql", "sqlglot/generator.py:6028"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6033
  analyzelistchainedrows_sql(expression) { throw new NotPorted("analyzelistchainedrows_sql", "sqlglot/generator.py:6033"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6037
  analyzevalidate_sql(expression) { throw new NotPorted("analyzevalidate_sql", "sqlglot/generator.py:6037"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6044
  analyze_sql(expression) { throw new NotPorted("analyze_sql", "sqlglot/generator.py:6044"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6061
  xmltable_sql(expression) { throw new NotPorted("xmltable_sql", "sqlglot/generator.py:6061"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6072
  xmlnamespace_sql(expression) { throw new NotPorted("xmlnamespace_sql", "sqlglot/generator.py:6072"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6076
  export_sql(expression) { throw new NotPorted("export_sql", "sqlglot/generator.py:6076"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6083
  declare_sql(expression) { throw new NotPorted("declare_sql", "sqlglot/generator.py:6083"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6087
  declareitem_sql(expression) { throw new NotPorted("declareitem_sql", "sqlglot/generator.py:6087"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6100
  recursivewithsearch_sql(expression) { throw new NotPorted("recursivewithsearch_sql", "sqlglot/generator.py:6100"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6111
  parameterizedagg_sql(expression) { throw new NotPorted("parameterizedagg_sql", "sqlglot/generator.py:6111"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6115
  anonymousaggfunc_sql(expression) { throw new NotPorted("anonymousaggfunc_sql", "sqlglot/generator.py:6115"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6118
  combinedaggfunc_sql(expression) { throw new NotPorted("combinedaggfunc_sql", "sqlglot/generator.py:6118"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6121
  combinedparameterizedagg_sql(expression) { throw new NotPorted("combinedparameterizedagg_sql", "sqlglot/generator.py:6121"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6124
  show_sql(expression) { throw new NotPorted("show_sql", "sqlglot/generator.py:6124"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6128
  install_sql(expression) { throw new NotPorted("install_sql", "sqlglot/generator.py:6128"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6132
  get_put_sql(expression) { throw new NotPorted("get_put_sql", "sqlglot/generator.py:6132"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6146
  translatecharacters_sql(expression) { throw new NotPorted("translatecharacters_sql", "sqlglot/generator.py:6146"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6152
  decodecase_sql(expression) { throw new NotPorted("decodecase_sql", "sqlglot/generator.py:6152"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6178
  semanticview_sql(expression) { throw new NotPorted("semanticview_sql", "sqlglot/generator.py:6178"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6196
  getextract_sql(expression) { throw new NotPorted("getextract_sql", "sqlglot/generator.py:6196"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6210
  datefromunixdate_sql(expression) { throw new NotPorted("datefromunixdate_sql", "sqlglot/generator.py:6210"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6219
  space_sql(expression) { throw new NotPorted("space_sql", "sqlglot/generator.py:6219"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6222
  buildproperty_sql(expression) { throw new NotPorted("buildproperty_sql", "sqlglot/generator.py:6222"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6225
  refreshtriggerproperty_sql(expression) { throw new NotPorted("refreshtriggerproperty_sql", "sqlglot/generator.py:6225"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6239
  modelattribute_sql(expression) { throw new NotPorted("modelattribute_sql", "sqlglot/generator.py:6239"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6243
  directorystage_sql(expression) { throw new NotPorted("directorystage_sql", "sqlglot/generator.py:6243"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6246
  uuid_sql(expression) { throw new NotPorted("uuid_sql", "sqlglot/generator.py:6246"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6255
  initcap_sql(expression) { throw new NotPorted("initcap_sql", "sqlglot/generator.py:6255"); }

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
  weekstart_name(expression) { throw new NotPorted("weekstart_name", "sqlglot/generator.py:6279"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6295
  weekstart_sql(expression) { throw new NotPorted("weekstart_sql", "sqlglot/generator.py:6295"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6304
  chr_sql(expression, name) { throw new NotPorted("chr_sql", "sqlglot/generator.py:6304"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6310
  block_sql(expression) { throw new NotPorted("block_sql", "sqlglot/generator.py:6310"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6315
  functionspecification_sql(expression) { throw new NotPorted("functionspecification_sql", "sqlglot/generator.py:6315"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6319
  storedprocedure_sql(expression) { throw new NotPorted("storedprocedure_sql", "sqlglot/generator.py:6319"); }

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
  casestatement_sql(expression) { throw new NotPorted("casestatement_sql", "sqlglot/generator.py:6327"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6331
  whileblock_sql(expression) { throw new NotPorted("whileblock_sql", "sqlglot/generator.py:6331"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6335
  loopblock_sql(expression) { throw new NotPorted("loopblock_sql", "sqlglot/generator.py:6335"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6339
  repeatblock_sql(expression) { throw new NotPorted("repeatblock_sql", "sqlglot/generator.py:6339"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6343
  leave_sql(expression) { throw new NotPorted("leave_sql", "sqlglot/generator.py:6343"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6347
  iterate_sql(expression) { throw new NotPorted("iterate_sql", "sqlglot/generator.py:6347"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6351
  execute_sql(expression) { throw new NotPorted("execute_sql", "sqlglot/generator.py:6351"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6355
  executesql_sql(expression) { throw new NotPorted("executesql_sql", "sqlglot/generator.py:6355"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6359
  altermodifysqlsecurity_sql(expression) { throw new NotPorted("altermodifysqlsecurity_sql", "sqlglot/generator.py:6359"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6363
  usingproperty_sql(expression) { throw new NotPorted("usingproperty_sql", "sqlglot/generator.py:6363"); }

  /** @returns {*} */
  // py: sqlglot/generator.py:6367
  renameindex_sql(expression) { throw new NotPorted("renameindex_sql", "sqlglot/generator.py:6367"); }

}

/** py: sqlglot/generator.py:4889 `@unsupported_args("format") def tochar_sql(self, expression)` */
const _tochar_sql = unsupported_args("format")(
  (self, expression) => self.sql(exp.cast(expression.this, exp.DType.TEXT)),
);

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
