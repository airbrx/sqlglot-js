// py: a deliberately minimal subset of sqlglot/generator.py @ 91119bc.
//
// WHY THIS EXISTS AT P3 (PORT_PLAN.md §7 P3): the parser calls the generator MID-PARSE,
// and the result is baked into the AST — so the parse path cannot be correct without
// some generator, and P4 is too late.
//
// THE CALL SITES, MEASURED not assumed. The plan named two (`parser.py:5491`,
// `parser.py:8069`). Wrapping `Expression.sql` and running all 9,867 distinct corpus
// inputs through CPython's parser found SEVEN source lines that reach the generator,
// because five of them are IMPLICIT `f"{expr}"` coercions through `Expression.__str__`
// (expressions/core.py:1237 -> self.sql()) rather than a literal `.sql()` call:
//
//   parser.py:3044  f"{number} "                   _parse_retention_period   Literal
//   parser.py:3046  exp.var(f"{number_str}{unit}") _parse_retention_period   Var
//   parser.py:3179  f"{user}@{host}"               _parse_definer            Identifier
//   parser.py:5491  fld.sql()                      pivot field names         Literal, Select
//   parser.py:8069  default.this.sql()             CASE ... ELSE INTERVAL    Column, Literal
//   parser.py:9313  f"BUFFER_USAGE_LIMIT {...}"    _parse_analyze            Literal
//   parser.py:9462  f"{buckets} BUCKETS"           _parse_analyze_histogram  Literal
//
// The P0 implicit-`__str__` deny-list (corpus/deny/implicit_str.json) has ZERO entries
// for parser.py — its heuristics cannot see that `_parse_number()` returns an Expr — so
// static analysis alone would have shipped a kernel missing five of the seven.
//
// SCOPE, also measured: exactly 13 node classes appear anywhere inside a sub-AST that
// gets generated on the parse path across the whole corpus. `parser.py:5491` can hand a
// whole `SELECT ... FROM ... WHERE ... ORDER BY ... NULLS LAST` to the generator (a
// pivot `IN (SELECT ...)`), so this must be a real recursive generator, not a
// special-case renderer — but only over those 13 classes.
//
// EVERYTHING ELSE THROWS `NotPorted`. That is the whole safety argument: P4 replaces
// this file wholesale, and until then any node outside the measured set fails loudly
// instead of silently emitting almost-right SQL into an AST.
//
// Verified byte-for-byte against CPython by spike/p3/fuzz_generator_kernel.mjs over
// every node of every AST-oracle tree whose class is in the supported set.

import { NotPorted, UnsupportedError } from "./errors.js";
import * as exp from "./expressions/index.js";
import { cpAt, cpSlice, pyIsDigit, pyIsSpace, pyStrip } from "./_py/str.js";

// Base-`Dialect` / base-`Generator` settings this subset depends on, read out of
// CPython rather than assumed (see the probe's header for the extraction command).
// Hardcoded because a kernel with no dialect support must not pretend to have any:
// P4's real Generator takes these from the resolved Dialect.
const QUOTE_START = "'";
const QUOTE_END = "'";
const IDENTIFIER_START = '"';
const IDENTIFIER_END = '"';
const ESCAPED_IDENTIFIER_END = '""';
const NULL_ORDERING = "nulls_are_small";

// py: Generator.EXCLUDE_COMMENTS = (Binary, SetOperation) and
// Generator.WITH_SEPARATED_COMMENTS = (Command, Create, ..., Select, Where, With).
// Only the members that intersect KERNEL_CLASSES are listed; the rest cannot occur
// here because `sql()` refuses to render them at all.
const EXCLUDE_COMMENTS = [exp.Binary];
const WITH_SEPARATED_COMMENTS = [exp.From, exp.Order, exp.Select, exp.Where];

/**
 * The 13 classes measured as reachable, plus nothing. Kept as an explicit list so the
 * probe can assert that its coverage set and this dispatch table are the same set —
 * a kernel that quietly grew a 14th case would otherwise go unverified.
 */
export const KERNEL_CLASSES = Object.freeze([
  "Boolean", "Column", "Distinct", "EQ", "From", "Identifier", "Literal",
  "Order", "Ordered", "Select", "Table", "Var", "Where",
]);

/**
 * Refuse any node carrying an argument this kernel does not render.
 *
 * ALWAYS an allow-list. A deny-list of "args we know to reject" is only as complete as
 * whoever wrote it — the first `table_sql` used one, missed `pattern` and `indexed`,
 * and turned `FROM t INDEXED BY i` into `FROM t`: wrong output, no error, no test
 * failure outside the differential. The allow-list form cannot have that bug.
 */
function _onlyArgs(expression, allowed, className, anchor) {
  const ok = new Set(allowed);
  for (const [key, v] of Object.entries(expression.args)) {
    if (ok.has(key)) continue;
    // Only None/undefined/[] count as absent. `False` does NOT: upstream distinguishes
    // "flag absent" from "flag explicitly false" and sometimes renders the latter —
    // `Table(indexed=False)` is `t NOT INDEXED`, not `t`. Treating falsy as absent
    // dropped that silently, and only a tightened probe caught it.
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    throw new NotPorted(
      `GeneratorKernel: ${className} arg '${key}' is outside the measured parse-path scope`,
      anchor,
    );
  }
}

export class GeneratorKernel {
  constructor() {
    // py: Generator.unsupported_messages. The two explicit call sites discard them, but
    // `column_sql`'s join-mark arm really does call `unsupported()`, so they are
    // collected rather than dropped.
    this.unsupportedMessages = [];
  }

  /** py: Generator.unsupported(message) at ErrorLevel.WARN — collect, do not raise. */
  unsupported(message) {
    this.unsupportedMessages.push(message);
  }

  /**
   * py: Generator.sql(expression, key=None)
   *
   * Dispatches on the EXACT class, matching upstream's `getattr(self, exp_handler_name)`
   * over `expression.key`. No `Func`/`Property` fallback: this kernel has no function
   * surface to fall back to, and inventing one would emit plausible-looking SQL for a
   * node it has never been checked against.
   */
  sql(expression, key = null, comment = true) {
    if (key !== null) {
      const value = expression?.args?.[key];
      // py: `if not value: return ""` — Python falsiness, so None, "" and [] all
      // render as empty. An Expr is always truthy.
      if (value === null || value === undefined || value === "" ||
          (Array.isArray(value) && value.length === 0)) {
        return "";
      }
      return this.sql(value);
    }

    if (expression === null || expression === undefined) return "";
    if (typeof expression === "string") return expression;

    const name = expression.constructor.name;
    const handler = this[`${name.toLowerCase()}_sql`];
    if (typeof handler !== "function") {
      throw new NotPorted(
        `GeneratorKernel cannot render ${name} — the P3 kernel covers only the `
        + `${KERNEL_CLASSES.length} classes measured as reachable on the parse path `
        + `(${KERNEL_CLASSES.join(", ")}). P4 replaces this file with the real Generator.`,
        "sqlglot/generator.py",
      );
    }
    const out = handler.call(this, expression);
    // py: generator.py:1133 `return self.maybe_comment(sql, expression) if self.comments
    // and comment else sql`. `self.comments` defaults to True, and comments really do
    // reach the parse path (BigQuery atoms carry them on pivot fields), so dropping
    // them here would produce a silently-wrong pivot column name.
    return comment ? this.maybe_comment(out, expression) : out;
  }

  // py: generator.py:1009 sanitize_comment
  sanitize_comment(comment) {
    // py: `if comment[0].strip()` — `str.strip()` of a single character is "" exactly
    // when that character is whitespace, so this reads "pad unless already spaced".
    // `pyStrip`, not `trim`: Python's whitespace set is not JS's `\s`.
    // `cpAt`, not `comment[0]`: see identifier_sql below. No Unicode whitespace is
    // astral, so a lone surrogate happens to answer "not space" like the character it
    // came from — this pair is correct by accident today. It is still written the
    // code-point way, because the next reader copies the shape, not the accident.
    let out = pyStrip(cpAt(comment, 0)) ? ` ${comment}` : comment;
    out = pyStrip(cpAt(out, -1)) ? `${out} ` : out;
    // Escape block-comment markers: single-line `--` comments become `/* */` on output,
    // so any `*/` in the original would close the comment early.
    return out.split("*/").join("* /").split("/*").join("/ *");
  }

  /**
   * py: generator.py:1020 maybe_comment, non-pretty (`_replace_line_breaks` is identity
   * and `sep()` is a single space when `pretty` is False).
   */
  maybe_comment(sql, expression = null, comments = null) {
    const list = comments === null ? (expression && expression.comments) : comments;

    // py: `isinstance(expression, self.EXCLUDE_COMMENTS)` where EXCLUDE_COMMENTS is
    // (Binary, SetOperation) — so an EQ never renders its own comments.
    if (!list || !list.length || EXCLUDE_COMMENTS.some((C) => expression instanceof C)) {
      return sql;
    }

    // py: `for comment in comments if comment` — an empty-string comment is dropped.
    const commentsList = list
      .filter((c) => c)
      .map((c) => `/*${this.sanitize_comment(c)}*/`);
    if (!commentsList.length) return sql;

    if (WITH_SEPARATED_COMMENTS.some((C) => expression instanceof C)) {
      const commentsSql = commentsList.join(" ");
      // py: `if not sql or sql[0].isspace()` — leading-space clauses like " FROM x"
      // take the first arm so the comment lands before the space, not inside it.
      // `cpAt(sql, 0)`, not `sql[0]` — same reason as identifier_sql; the `!sql` guard
      // is what makes the index safe, exactly as upstream's `not sql` does.
      return (!sql || pyIsSpace(cpAt(sql, 0)))
        ? ` ${commentsSql}${sql}`
        : `${commentsSql} ${sql}`;
    }

    return `${sql} ${commentsList.join(" ")}`;
  }

  /**
   * py: Generator.expressions(...) reduced to the non-pretty, flat, comma-joined form.
   * `indent`/`sep`/`SENTINEL_LINE_BREAK` are P4's pretty machinery and are absent here.
   */
  expressions(expression, key = "expressions", sep = ", ") {
    const values = expression.args[key] || [];
    return values.map((v) => this.sql(v)).join(sep);
  }

  // py: generator.py:3010 literal_sql
  literal_sql(expression) {
    // py: `text = expression.this or ""` — a Literal whose `this` is the EMPTY STRING
    // is falsy in Python, so `''` and a missing `this` both yield "".
    let text = expression.this || "";
    if (expression.isString) text = `${QUOTE_START}${this.escape_str(text)}${QUOTE_END}`;
    return text;
  }

  /**
   * py: generator.py:3016 escape_str, at base-dialect settings.
   * `STRINGS_SUPPORT_ESCAPED_SEQUENCES` is False and `ESCAPED_SEQUENCES` is empty for
   * the base dialect, so the only transformation is doubling the quote delimiter.
   */
  escape_str(text) {
    return text.split(QUOTE_END).join(QUOTE_END + QUOTE_END);
  }

  // py: generator.py:2001 identifier_sql
  identifier_sql(expression) {
    // No guard: upstream's base `identifier_sql` reads `name` and `quoted` only.
    // `global_` and `temporary` are consumed by dialect generators (tsql) and are
    // genuinely IGNORED at the base dialect, so refusing them would invent a
    // restriction upstream does not have.
    let text = expression.name;
    const lower = text.toLowerCase();
    const quoted = expression.args.quoted;
    // `self.normalize` is False and `RESERVED_KEYWORDS` is empty on the base generator,
    // and `can_quote` is False without a dialect — so the quoting decision reduces to
    // the explicit `quoted` flag or a leading digit.
    text = text.split(IDENTIFIER_END).join(ESCAPED_IDENTIFIER_END);
    // py: `text[:1].isdigit()` — a CODE POINT, so `cpSlice`, never `text[0]`.
    // `text[0]` is a UTF-16 unit: for an astral digit like U+1D7CE MATHEMATICAL BOLD
    // DIGIT ZERO it is a lone high surrogate, `pyIsDigit` answers false, and the
    // identifier ships UNQUOTED where CPython quotes it. That is AST-visible at
    // parser.py:5491 (the pivot column NAME) and parser.py:3179 (DefinerProperty),
    // with no error and no probe failure — the silent-wrongness class this whole
    // kernel exists to avoid. `pyIsDigit("")` is already false, so the empty-string
    // case needs no guard, matching upstream's slice exactly.
    if (quoted || pyIsDigit(cpSlice(text, 0, 1))) {
      text = `${IDENTIFIER_START}${text}${IDENTIFIER_END}`;
    }
    return text;
  }

  // py: generator.py:2753 var_sql
  var_sql(expression) {
    return this.sql(expression, "this");
  }

  // py: generator.py:3071 boolean_sql
  boolean_sql(expression) {
    return expression.this ? "TRUE" : "FALSE";
  }

  // py: generator.py:1154 column_parts
  column_parts(expression) {
    const parts = [
      expression.args.catalog,
      expression.args.db,
      expression.args.table,
      expression.args.this,
    ];
    // py: `if part` — Python falsiness over the arg, so an absent part is skipped.
    return parts.filter((p) => p !== null && p !== undefined && p !== "")
      .map((p) => this.sql(p))
      .join(".");
  }

  // py: generator.py:1170 column_sql
  column_sql(expression) {
    // No guard: `column_parts` renders catalog/db/table/this, `join_mark` is handled
    // below, and `shadow` is inert because the base dialect's
    // PROJECTION_ALIASES_SHADOW_SOURCE_NAMES is False.
    let joinMark = expression.args.join_mark ? " (+)" : "";
    // py: base dialect SUPPORTS_COLUMN_JOIN_MARKS is False.
    if (joinMark) {
      joinMark = "";
      this.unsupported("Outer join syntax using the (+) operator is not supported.");
    }
    return `${this.column_parts(expression)}${joinMark}`;
  }

  // py: generator.py:2407 table_parts
  table_parts(expression) {
    const parts = [expression.args.catalog, expression.args.db, expression.args.this];
    // py: `if part is not None` — NOT Python falsiness here, unlike column_parts.
    // The asymmetry is upstream's and is preserved deliberately.
    return parts.filter((p) => p !== null && p !== undefined).map((p) => this.sql(p)).join(".");
  }

  /**
   * py: generator.py:2418 table_sql, reduced to what a pivot subquery's FROM can hold.
   * A Table carrying an alias, partition, version, sample, hints, joins, laterals,
   * pivots, ordinality or "when" is rejected rather than half-rendered.
   */
  table_sql(expression) {
    // ALLOW-list, not a deny-list. The first version listed the args to REJECT and
    // missed `pattern` and `indexed`, so `FROM @mystage (PATTERN => '...')` and
    // `FROM t INDEXED BY i` rendered as bare table names — silently wrong rather than
    // loudly unsupported. An allow-list is complete by construction and stays correct
    // when upstream adds a 21st Table arg.
    _onlyArgs(expression, ["catalog", "db", "this"], "Table", "sqlglot/generator.py:2418");
    return this.table_parts(expression);
  }

  // py: generator.py:2762 from_sql. `seg("FROM")` is " FROM" when not pretty.
  from_sql(expression) {
    return ` FROM ${this.sql(expression, "this")}`;
  }

  // py: generator.py:3509 where_sql. Non-pretty: seg() -> " WHERE", sep() -> " ",
  // indent() -> identity.
  where_sql(expression) {
    return ` WHERE ${this.sql(expression, "this")}`;
  }

  // py: generator.py:4412 distinct_sql. MULTI_ARG_DISTINCT is True on the base
  // generator, so the CASE-rewrite arm is unreachable here.
  distinct_sql(expression) {
    let self = this.expressions(expression);
    self = self ? ` ${self}` : "";
    let on = this.sql(expression, "on");
    on = on ? ` ON ${on}` : "";
    return `DISTINCT${self}${on}`;
  }

  // py: generator.py:3080 order_sql -> op_expressions("ORDER BY", ...), non-pretty.
  order_sql(expression) {
    // No guard: `this`, `expressions` and `siblings` are the whole arg surface and
    // all three are rendered below.
    let self = this.sql(expression, "this");
    self = self ? `${self} ` : self;
    const siblings = expression.args.siblings ? "SIBLINGS " : "";
    return ` ${self}ORDER ${siblings}BY ${this.expressions(expression)}`;
  }

  /**
   * py: generator.py:3154 ordered_sql.
   *
   * Base dialect NULL_ORDERING is "nulls_are_small" and NULL_ORDERING_SUPPORTED is
   * True, so: `nulls_are_large`/`nulls_are_last` are False and the simulate-with-an-
   * extra-sort-key branch is unreachable. Both surviving arms are kept explicit
   * because the `desc is False` vs `desc is None` distinction is output-visible —
   * an explicit ASC renders " ASC", an absent one renders nothing.
   */
  ordered_sql(expression) {
    // `with_fill` IS rendered by upstream (generator.py:3230), so it must be refused
    // rather than dropped; `this`/`desc`/`nulls_first` are handled below.
    _onlyArgs(expression, ["this", "desc", "nulls_first"], "Ordered",
      "sqlglot/generator.py:3154");
    const desc = expression.args.desc;
    const asc = !desc;
    const nullsFirst = expression.args.nulls_first;
    const nullsLast = !nullsFirst;
    const nullsAreLarge = NULL_ORDERING === "nulls_are_large";
    const nullsAreSmall = NULL_ORDERING === "nulls_are_small";
    const nullsAreLast = NULL_ORDERING === "nulls_are_last";

    const self = this.sql(expression, "this");

    // py: `" DESC" if desc else (" ASC" if desc is False else "")` — three-way on
    // None/False/True, which `desc === false` reproduces and `!desc` would not.
    const sortOrder = desc ? " DESC" : (desc === false ? " ASC" : "");

    let nullsSortChange = "";
    if (nullsFirst && ((asc && nullsAreLarge) || (desc && nullsAreSmall) || nullsAreLast)) {
      nullsSortChange = " NULLS FIRST";
    } else if (
      nullsLast
      && ((asc && nullsAreSmall) || (desc && nullsAreLarge))
      && !nullsAreLast
    ) {
      nullsSortChange = " NULLS LAST";
    }

    return `${self}${sortOrder}${nullsSortChange}`;
  }

  /**
   * py: generator.py:3339 select_sql, reduced to the clauses a pivot `IN (SELECT ...)`
   * can actually contain. Any other modifier throws rather than being dropped —
   * silently omitting a LIMIT would produce a pivot column name that is wrong in a way
   * no test would attribute to the generator.
   */
  select_sql(expression) {
    // NOTE the arg key is `from_`, not `from` — this fork renamed it (as it did
    // `with_`, `for_`). Reading `from` silently yields "" and drops the whole clause,
    // which is how the FROM went missing from 277 Selects until the differential
    // caught it.
    _onlyArgs(expression, ["expressions", "distinct", "from_", "where", "order"],
      "Select", "sqlglot/generator.py:3339");

    let distinct = this.sql(expression, "distinct");
    distinct = distinct ? ` ${distinct}` : "";
    const expressions = this.expressions(expression);

    // py: query_modifiers(expression, f"SELECT{top_distinct}{kind}{expressions}",
    //                     into_sql, from_sql) then csv(..., where, ..., order, sep="")
    // — a FIXED clause order that is not the args' insertion order. `sep()` is " " when
    // not pretty, and `csv(sep="")` drops empty pieces, which plain concatenation of
    // already-"" strings reproduces.
    const from = this.sql(expression, "from_");
    const where = this.sql(expression, "where");
    const order = this.sql(expression, "order");

    return `SELECT${distinct}${expressions ? ` ${expressions}` : ""}${from}${where}${order}`;
  }

  // py: generator.py:4642 binary(expression, "=") for exp.EQ. The upstream trampoline
  // exists for left-nested chains (§4.7); an EQ inside a pivot predicate is shallow,
  // but the iterative shape is kept so depth stays independent of chain length.
  eq_sql(expression) {
    return this.binary(expression, "=");
  }

  // py: generator.py:4642 binary — iterative, matching upstream's explicit stack.
  binary(expression, op) {
    const sqls = [];
    const stack = [expression];
    const binaryType = expression.constructor;

    while (stack.length) {
      const node = stack.pop();
      if (node !== null && node !== undefined && node.constructor === binaryType) {
        if (node.args.operator) {
          throw new NotPorted(
            "GeneratorKernel: OPERATOR(...) binary form is outside the measured scope",
            "sqlglot/generator.py:4642",
          );
        }
        if (node.comments && node.comments.length) {
          throw new NotPorted(
            "GeneratorKernel: comments on a binary node need maybe_comment (P4)",
            "sqlglot/generator.py:4642",
          );
        }
        stack.push(node.args.expression);
        stack.push(` ${op} `);
        stack.push(node.args.this);
      } else {
        sqls.push(this.sql(node));
      }
    }

    return sqls.join("");
  }
}

/**
 * py: `Expr.sql()` / `Expression.__str__` on the PARSE path only.
 *
 * The single entry point the parser uses, so every mid-parse generate goes through one
 * place that P4 can swap. Named `kernelSql` rather than installed as `Expr.prototype.sql`
 * on purpose: a real `.sql()` lands at P4 with dialect/pretty/identify options, and
 * shadowing that name now would make the P4 method look already-implemented.
 */
export function kernelSql(expression) {
  // py: generator.py:960 `sql = self.sql(expression).strip()` — the top-level strip is
  // why `From(...).sql()` is "FROM t" while the same node inside a Select contributes
  // " FROM t". `pyStrip`, not `String.trim`: Python's `str.strip()` strips
  // `str.isspace()`, which is not JS's `\s` (CONTRACTS.md §1.2).
  return pyStrip(new GeneratorKernel().sql(expression));
}

export { UnsupportedError };
