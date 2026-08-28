// py: sqlglot/parser.py @ 91119bc
// @seeded by tools/seed_static.py — method stubs and class-table skeletons.
//
// Each stub and each table entry carries its own upstream anchor so that one task
// replaces exactly one line/method and two agents never touch adjacent hunks
// (PORT_PLAN.md §8.1 Rules 2 and 2'). Table ORDER is CI-asserted against a _gen/
// snapshot, because §4.6 establishes that insertion order is observable in output SQL.
//
// ---------------------------------------------------------------------------------
// READ THIS BEFORE IMPLEMENTING ANY OF THESE SEVEN METHODS
//
// The parser calls the GENERATOR mid-parse and bakes the resulting STRING into the
// AST. Seven upstream lines do it, and five are INVISIBLE at the call site — they are
// implicit `f"{expr}"` coercions through `Expression.__str__`
// (expressions/core.py:1237 -> self.sql()), so `grep '\.sql('` shows only two:
//
//   parser.py:3044  f"{number} "                   _parse_retention_period
//   parser.py:3046  exp.var(f"{number_str}{unit}") _parse_retention_period
//   parser.py:3179  f"{user}@{host}"               _parse_definer
//   parser.py:5491  fld.sql()                      _parse_pivot  (IN (...) field names)
//   parser.py:8069  default.this.sql()             _parse_case   (ELSE INTERVAL)
//   parser.py:9313  f"BUFFER_USAGE_LIMIT {...}"    _parse_analyze
//   parser.py:9462  f"{buckets} BUCKETS"           _parse_analyze_histogram
//
// In JS there is no `__str__`, so a transliterated `${expr}` yields "[object Object]".
// Route every one of them through `kernelSql` from ./generator_kernel.js — not a
// template literal, not a hand-written renderer. `tools/lint_deny.mjs` enforces this:
// all seven are `route: "kernelSql"` sites in corpus/deny/implicit_str.json, and the
// check flips from a note to a FAILURE the moment the owning method stops being a
// `NotPorted` stub.
//
// The kernel covers only the 13 node classes measured as reachable and throws
// `NotPorted` for anything else. That is deliberate, but it means ordinary SQL such as
// `PIVOT(... IN (NULL))` or `IN (1, -2, 3.5)` will THROW between the day _parse_pivot
// lands and the day P4's real Generator does. See P3_RESULTS.md "Known limitations".
// ---------------------------------------------------------------------------------

import {
  ErrorLevel,
  NotPorted,
  ParseError,
  concatMessages,
  highlightSql,
  mergeErrors,
} from "./errors.js";
import { Token, TokenType, Tokenizer } from "./tokens.js";
import { newTrie } from "./trie.js";
import { ensureList, seqGet } from "./helper.js";
import { logger } from "./logging.js";
import { PyTypeError } from "./_py/errors.js";
import { pyUpper } from "./_py/str.js";
import { pyFalsy } from "./_py/truthy.js";
import { kernelSql } from "./generator_kernel.js";
import * as exp from "./expressions/index.js";
import { findInScope } from "./optimizer/scope.js";

/**
 * py: parser.py:334 `SENTINEL_NONE: Token = Token(TokenType.SENTINEL, "SENTINEL")`
 *
 * The cursor fields (`_curr`/`_next`/`_prev`) are never null: they hold this token when
 * there is nothing there. `Token.__bool__` (tokenizer_core.py:523) returns False for
 * `TokenType.SENTINEL`, so upstream's `if self._curr:` and `token or self._curr` read
 * naturally while `self._curr.token_type` is always safe to touch.
 *
 * JS has no `__bool__`. Every upstream truthiness test on a Token therefore becomes an
 * explicit `.bool()` call in this file — the single most repeated transliteration rule
 * here, and the one whose omission fails silently: a SENTINEL is a truthy object, so
 * `if (this._curr)` is ALWAYS true and the parser walks off the end of the stream
 * instead of stopping.
 */
export const SENTINEL_NONE = new Token(TokenType.SENTINEL, "SENTINEL");

// Upstream computes several class tables with set algebra evaluated once at
// class-definition time (`TABLE_ALIAS_TOKENS = ID_VAR_TOKENS - {...}`). These reproduce
// that, preserving insertion order: a Python set literal is unordered, but the derived
// JS Set's iteration order still has to be deterministic, so it follows the base's.
function setDiff(base, remove) {
  const out = new Set();
  for (const x of base) if (!remove.has(x)) out.add(x);
  return out;
}

function setUnion(a, b) {
  const out = new Set(a);
  for (const x of b) out.add(x);
  return out;
}

/**
 * py: parser.py:277 `_resolve_dialect(dialect)`.
 *
 * `dialects/dialect.js` lands at P5. Until then this accepts an already-resolved
 * settings object or null, and THROWS on a dialect NAME — the same rule
 * `Tokenizer.__init__` already follows (CONTRACTS.md §8): silently falling back to the
 * default dialect would make every per-dialect parity row vacuously green.
 */
function _resolveDialect(dialect) {
  // py: `_resolve_dialect(None)` is `Dialect()`, whose `tokenizer_class` is the base
  // `Tokenizer`. Returning that stand-in (rather than null) keeps `self.dialect.…`
  // reads faithful for the base dialect without inventing a registry.
  if (dialect === null || dialect === undefined) return { tokenizer_class: Tokenizer };
  if (typeof dialect === "string") {
    throw new NotPorted(
      `_resolve_dialect(${JSON.stringify(dialect)}) — dialects/dialect.js is P5`,
      "sqlglot/parser.py:277",
    );
  }
  return dialect;
}

/**
 * py: `self._curr.text.upper() in texts` where TEXTS_TYPE is
 * `tuple | list | AbstractSet | Mapping` (parser.py:43).
 *
 * `in` means "is a member" for all four — for a Mapping it tests KEYS. The comment on
 * TEXTS_TYPE says bare strings are excluded precisely so `in` never degrades to
 * substring matching; this helper keeps that property by refusing a string outright
 * rather than silently doing `"FO" in "FOO"`.
 */
function _textIn(texts, text) {
  if (texts instanceof Set || texts instanceof Map) return texts.has(text);
  if (Array.isArray(texts)) return texts.includes(text);
  throw new PyTypeError(
    `TEXTS_TYPE must be a Set, Map or Array, got ${typeof texts} — bare strings are `
    + "excluded upstream so a single keyword cannot match with substring semantics",
  );
}

export class Parser {
  /** py: sqlglot/parser.py:375 */
  static FUNCTIONS = new Map([
    // py:376  SPREAD: DictComp — merge manually (§4.4 MRO)
    // py:377  ["COALESCE", /* TODO build_coalesce */],
    // py:377  ["IFNULL", /* TODO build_coalesce */],
    // py:377  ["NVL", /* TODO build_coalesce */],
    // py:378  ["ARRAY", /* TODO lambda */],
    // py:379  ["ARRAYAGG", /* TODO lambda */],
    // py:382  ["ARRAY_AGG", /* TODO lambda */],
    // py:385  ["ARRAY_APPEND", /* TODO build_array_append */],
    // py:386  ["ARRAY_CAT", /* TODO build_array_concat */],
    // py:387  ["ARRAY_CONCAT", /* TODO build_array_concat */],
    // py:388  ["ARRAY_INTERSECT", /* TODO lambda */],
    // py:389  ["ARRAY_INTERSECTION", /* TODO lambda */],
    // py:390  ["ARRAY_PREPEND", /* TODO build_array_prepend */],
    // py:391  ["ARRAY_REMOVE", /* TODO build_array_remove */],
    // py:392  ["COUNT", /* TODO lambda */],
    // py:393  ["CONCAT", /* TODO lambda */],
    // py:398  ["CONCAT_WS", /* TODO lambda */],
    // py:403  ["CONVERT_TIMEZONE", /* TODO build_convert_timezone */],
    // py:404  ["DATE_TO_DATE_STR", /* TODO lambda */],
    // py:408  ["GENERATE_DATE_ARRAY", /* TODO lambda */],
    // py:413  ["GENERATE_UUID", /* TODO lambda */],
    // py:416  ["GLOB", /* TODO lambda */],
    // py:417  ["GREATEST", /* TODO lambda */],
    // py:422  ["LEAST", /* TODO lambda */],
    // py:427  ["HEX", /* TODO build_hex */],
    // py:428  ["JSON_EXTRACT", /* TODO build_extract_json_with_path(...) */],
    // py:429  ["JSON_EXTRACT_SCALAR", /* TODO build_extract_json_with_path(...) */],
    // py:430  ["JSON_EXTRACT_PATH_TEXT", /* TODO build_extract_json_with_path(...) */],
    // py:431  ["JSON_KEYS", /* TODO lambda */],
    // py:434  ["LIKE", /* TODO build_like */],
    // py:435  ["LOG", /* TODO build_logarithm */],
    // py:436  ["LOG2", /* TODO lambda */],
    // py:437  ["LOG10", /* TODO lambda */],
    // py:438  ["LOWER", /* TODO build_lower */],
    // py:439  ["LPAD", /* TODO lambda */],
    // py:440  ["LEFTPAD", /* TODO lambda */],
    // py:441  ["LTRIM", /* TODO lambda */],
    // py:442  ["MOD", /* TODO build_mod */],
    // py:443  ["RIGHTPAD", /* TODO lambda */],
    // py:444  ["RPAD", /* TODO lambda */],
    // py:445  ["RTRIM", /* TODO lambda */],
    // py:446  ["SCOPE_RESOLUTION", /* TODO lambda */],
    /* py:451 */ ["STRPOS", exp.StrPosition.from_arg_list],
    // py:452  ["CHARINDEX", /* TODO lambda */],
    /* py:453 */ ["INSTR", exp.StrPosition.from_arg_list],
    // py:454  ["LOCATE", /* TODO lambda */],
    // py:455  ["TIME_TO_TIME_STR", /* TODO lambda */],
    // py:459  ["TO_HEX", /* TODO build_hex */],
    // py:460  ["TS_OR_DS_TO_DATE_STR", /* TODO lambda */],
    // py:468  ["UNNEST", /* TODO lambda */],
    // py:469  ["UPPER", /* TODO build_upper */],
    // py:470  ["UUID", /* TODO lambda */],
    // py:471  ["UUID_STRING", /* TODO lambda */],
    // py:476  ["VAR_MAP", /* TODO build_var_map */],
  ]);

  /** py: sqlglot/parser.py:479 */
  static NO_PAREN_FUNCTIONS = new Map([
    /* py:480 */ [TokenType.CURRENT_DATE, exp.CurrentDate],
    /* py:481 */ [TokenType.CURRENT_DATETIME, exp.CurrentDate],
    /* py:482 */ [TokenType.CURRENT_TIME, exp.CurrentTime],
    /* py:483 */ [TokenType.CURRENT_TIMESTAMP, exp.CurrentTimestamp],
    /* py:484 */ [TokenType.CURRENT_USER, exp.CurrentUser],
    /* py:485 */ [TokenType.CURRENT_ROLE, exp.CurrentRole],
  ]);

  /** py: sqlglot/parser.py:488 */
  static STRUCT_TYPE_TOKENS = new Set([
    /* py:489 */ TokenType.NESTED,
    /* py:490 */ TokenType.OBJECT,
    /* py:491 */ TokenType.STRUCT,
    /* py:492 */ TokenType.UNION,
  ]);

  /** py: sqlglot/parser.py:495 */
  static NESTED_TYPE_TOKENS = new Set([
    /* py:496 */ TokenType.ARRAY,
    /* py:497 */ TokenType.LIST,
    /* py:498 */ TokenType.LOWCARDINALITY,
    /* py:499 */ TokenType.MAP,
    /* py:500 */ TokenType.NULLABLE,
    /* py:501 */ TokenType.RANGE,
    /* py:502 */ ...this.STRUCT_TYPE_TOKENS,
  ]);

  /** py: sqlglot/parser.py:505 */
  static ENUM_TYPE_TOKENS = new Set([
    /* py:506 */ TokenType.DYNAMIC,
    /* py:507 */ TokenType.ENUM,
    /* py:508 */ TokenType.ENUM8,
    /* py:509 */ TokenType.ENUM16,
  ]);

  /** py: sqlglot/parser.py:512 */
  static AGGREGATE_TYPE_TOKENS = new Set([
    /* py:513 */ TokenType.AGGREGATEFUNCTION,
    /* py:514 */ TokenType.SIMPLEAGGREGATEFUNCTION,
  ]);

  /** py: sqlglot/parser.py:517 */
  static TYPE_TOKENS = new Set([
    /* py:518 */ TokenType.BIT,
    /* py:519 */ TokenType.BOOLEAN,
    /* py:520 */ TokenType.TINYINT,
    /* py:521 */ TokenType.UTINYINT,
    /* py:522 */ TokenType.SMALLINT,
    /* py:523 */ TokenType.USMALLINT,
    /* py:524 */ TokenType.INT,
    /* py:525 */ TokenType.UINT,
    /* py:526 */ TokenType.BIGINT,
    /* py:527 */ TokenType.UBIGINT,
    /* py:528 */ TokenType.BIGNUM,
    /* py:529 */ TokenType.INT128,
    /* py:530 */ TokenType.UINT128,
    /* py:531 */ TokenType.INT256,
    /* py:532 */ TokenType.UINT256,
    /* py:533 */ TokenType.MEDIUMINT,
    /* py:534 */ TokenType.UMEDIUMINT,
    /* py:535 */ TokenType.FIXEDSTRING,
    /* py:536 */ TokenType.FLOAT,
    /* py:537 */ TokenType.DOUBLE,
    /* py:538 */ TokenType.UDOUBLE,
    /* py:539 */ TokenType.CHAR,
    /* py:540 */ TokenType.NCHAR,
    /* py:541 */ TokenType.VARCHAR,
    /* py:542 */ TokenType.NVARCHAR,
    /* py:543 */ TokenType.BPCHAR,
    /* py:544 */ TokenType.TEXT,
    /* py:545 */ TokenType.MEDIUMTEXT,
    /* py:546 */ TokenType.LONGTEXT,
    /* py:547 */ TokenType.BLOB,
    /* py:548 */ TokenType.MEDIUMBLOB,
    /* py:549 */ TokenType.LONGBLOB,
    /* py:550 */ TokenType.BINARY,
    /* py:551 */ TokenType.VARBINARY,
    /* py:552 */ TokenType.JSON,
    /* py:553 */ TokenType.JSONB,
    /* py:554 */ TokenType.INTERVAL,
    /* py:555 */ TokenType.TINYBLOB,
    /* py:556 */ TokenType.TINYTEXT,
    /* py:557 */ TokenType.TIME,
    /* py:558 */ TokenType.TIMETZ,
    /* py:559 */ TokenType.TIME_NS,
    /* py:560 */ TokenType.TIMESTAMP,
    /* py:561 */ TokenType.TIMESTAMP_S,
    /* py:562 */ TokenType.TIMESTAMP_MS,
    /* py:563 */ TokenType.TIMESTAMP_NS,
    /* py:564 */ TokenType.TIMESTAMPTZ,
    /* py:565 */ TokenType.TIMESTAMPLTZ,
    /* py:566 */ TokenType.TIMESTAMPNTZ,
    /* py:567 */ TokenType.DATETIME,
    /* py:568 */ TokenType.DATETIME2,
    /* py:569 */ TokenType.DATETIME64,
    /* py:570 */ TokenType.SMALLDATETIME,
    /* py:571 */ TokenType.DATE,
    /* py:572 */ TokenType.DATE32,
    /* py:573 */ TokenType.INT4RANGE,
    /* py:574 */ TokenType.INT4MULTIRANGE,
    /* py:575 */ TokenType.INT8RANGE,
    /* py:576 */ TokenType.INT8MULTIRANGE,
    /* py:577 */ TokenType.NUMRANGE,
    /* py:578 */ TokenType.NUMMULTIRANGE,
    /* py:579 */ TokenType.TSRANGE,
    /* py:580 */ TokenType.TSMULTIRANGE,
    /* py:581 */ TokenType.TSTZRANGE,
    /* py:582 */ TokenType.TSTZMULTIRANGE,
    /* py:583 */ TokenType.DATERANGE,
    /* py:584 */ TokenType.DATEMULTIRANGE,
    /* py:585 */ TokenType.DECIMAL,
    /* py:586 */ TokenType.DECIMAL32,
    /* py:587 */ TokenType.DECIMAL64,
    /* py:588 */ TokenType.DECIMAL128,
    /* py:589 */ TokenType.DECIMAL256,
    /* py:590 */ TokenType.DECFLOAT,
    /* py:591 */ TokenType.UDECIMAL,
    /* py:592 */ TokenType.BIGDECIMAL,
    /* py:593 */ TokenType.UUID,
    /* py:594 */ TokenType.GEOGRAPHY,
    /* py:595 */ TokenType.GEOGRAPHYPOINT,
    /* py:596 */ TokenType.GEOMETRY,
    /* py:597 */ TokenType.POINT,
    /* py:598 */ TokenType.RING,
    /* py:599 */ TokenType.LINESTRING,
    /* py:600 */ TokenType.MULTILINESTRING,
    /* py:601 */ TokenType.POLYGON,
    /* py:602 */ TokenType.MULTIPOLYGON,
    /* py:603 */ TokenType.HLLSKETCH,
    /* py:604 */ TokenType.HSTORE,
    /* py:605 */ TokenType.PSEUDO_TYPE,
    /* py:606 */ TokenType.SUPER,
    /* py:607 */ TokenType.SERIAL,
    /* py:608 */ TokenType.SMALLSERIAL,
    /* py:609 */ TokenType.BIGSERIAL,
    /* py:610 */ TokenType.XML,
    /* py:611 */ TokenType.YEAR,
    /* py:612 */ TokenType.USERDEFINED,
    /* py:613 */ TokenType.MONEY,
    /* py:614 */ TokenType.SMALLMONEY,
    /* py:615 */ TokenType.ROWVERSION,
    /* py:616 */ TokenType.IMAGE,
    /* py:617 */ TokenType.VARIANT,
    /* py:618 */ TokenType.VECTOR,
    /* py:619 */ TokenType.VOID,
    /* py:620 */ TokenType.OBJECT,
    /* py:621 */ TokenType.OBJECT_IDENTIFIER,
    /* py:622 */ TokenType.INET,
    /* py:623 */ TokenType.IPADDRESS,
    /* py:624 */ TokenType.IPPREFIX,
    /* py:625 */ TokenType.IPV4,
    /* py:626 */ TokenType.IPV6,
    /* py:627 */ TokenType.UNKNOWN,
    /* py:628 */ TokenType.NOTHING,
    /* py:629 */ TokenType.NULL,
    /* py:630 */ TokenType.NAME,
    /* py:631 */ TokenType.TDIGEST,
    /* py:632 */ TokenType.DYNAMIC,
    /* py:633 */ ...this.ENUM_TYPE_TOKENS,
    /* py:634 */ ...this.NESTED_TYPE_TOKENS,
    /* py:635 */ ...this.AGGREGATE_TYPE_TOKENS,
  ]);

  /** py: sqlglot/parser.py:638 */
  static SIGNED_TO_UNSIGNED_TYPE_TOKEN = new Map([
    /* py:639 */ [TokenType.BIGINT, TokenType.UBIGINT],
    /* py:640 */ [TokenType.INT, TokenType.UINT],
    /* py:641 */ [TokenType.MEDIUMINT, TokenType.UMEDIUMINT],
    /* py:642 */ [TokenType.SMALLINT, TokenType.USMALLINT],
    /* py:643 */ [TokenType.TINYINT, TokenType.UTINYINT],
    /* py:644 */ [TokenType.DECIMAL, TokenType.UDECIMAL],
    /* py:645 */ [TokenType.DOUBLE, TokenType.UDOUBLE],
  ]);

  /** py: sqlglot/parser.py:648 */
  static SUBQUERY_PREDICATES = new Map([
    /* py:649 */ [TokenType.ANY, exp.Any],
    /* py:650 */ [TokenType.ALL, exp.All],
    /* py:651 */ [TokenType.EXISTS, exp.Exists],
    /* py:652 */ [TokenType.SOME, exp.Any],
  ]);

  /** py: sqlglot/parser.py:655 */
  static SUBQUERY_TOKENS = new Set([
    /* py:656 */ TokenType.SELECT,
    /* py:657 */ TokenType.WITH,
    /* py:658 */ TokenType.FROM,
  ]);

  /** py: sqlglot/parser.py:661 */
  static RESERVED_TOKENS = setDiff(
    new Set([
      /* py:662 */ ...Tokenizer.SINGLE_TOKENS.values(),
      /* py:663 */ TokenType.SELECT,
    ]),
    new Set([
      /* py:664 */ TokenType.IDENTIFIER,
    ]),
  );

  /** py: sqlglot/parser.py:669 */
  static TEXT_MATCH_EXCLUDED_TOKENS = new Set([
    /* py:670 */ TokenType.BIT_STRING,
    /* py:671 */ TokenType.BYTE_STRING,
    /* py:672 */ TokenType.HEREDOC_STRING,
    /* py:673 */ TokenType.HEX_STRING,
    /* py:674 */ TokenType.IDENTIFIER,
    /* py:675 */ TokenType.NATIONAL_STRING,
    /* py:676 */ TokenType.RAW_STRING,
    /* py:677 */ TokenType.STRING,
    /* py:678 */ TokenType.UNICODE_STRING,
  ]);

  /** py: sqlglot/parser.py:682 */
  static DB_CREATABLES = new Set([
    /* py:683 */ TokenType.DATABASE,
    /* py:684 */ TokenType.DICTIONARY,
    /* py:685 */ TokenType.FILE_FORMAT,
    /* py:686 */ TokenType.MODEL,
    /* py:687 */ TokenType.NAMESPACE,
    /* py:688 */ TokenType.SCHEMA,
    /* py:689 */ TokenType.SEMANTIC_VIEW,
    /* py:690 */ TokenType.SEQUENCE,
    /* py:691 */ TokenType.SINK,
    /* py:692 */ TokenType.SOURCE,
    /* py:693 */ TokenType.STAGE,
    /* py:694 */ TokenType.STORAGE_INTEGRATION,
    /* py:695 */ TokenType.STREAMLIT,
    /* py:696 */ TokenType.TABLE,
    /* py:697 */ TokenType.TAG,
    /* py:698 */ TokenType.VIEW,
    /* py:699 */ TokenType.WAREHOUSE,
  ]);

  /** py: sqlglot/parser.py:702 */
  static CREATABLES = new Set([
    /* py:703 */ TokenType.COLUMN,
    /* py:704 */ TokenType.CONSTRAINT,
    /* py:705 */ TokenType.FOREIGN_KEY,
    /* py:706 */ TokenType.FUNCTION,
    /* py:707 */ TokenType.INDEX,
    /* py:708 */ TokenType.PROCEDURE,
    /* py:709 */ TokenType.TRIGGER,
    /* py:710 */ TokenType.TYPE,
    /* py:711 */ ...this.DB_CREATABLES,
  ]);

  /** py: sqlglot/parser.py:714 */
  static TRIGGER_EVENTS = new Set([
    /* py:715 */ TokenType.INSERT,
    /* py:716 */ TokenType.UPDATE,
    /* py:717 */ TokenType.DELETE,
    /* py:718 */ TokenType.TRUNCATE,
  ]);

  /** py: sqlglot/parser.py:721 */
  static ALTERABLES = new Set([
    /* py:722 */ TokenType.INDEX,
    /* py:723 */ TokenType.TABLE,
    /* py:724 */ TokenType.VIEW,
    /* py:725 */ TokenType.SESSION,
  ]);

  /** py: sqlglot/parser.py:729 */
  static ID_VAR_TOKENS = setDiff(
    new Set([
      /* py:730 */ TokenType.ALL,
      /* py:731 */ TokenType.ANALYZE,
      /* py:732 */ TokenType.ATTACH,
      /* py:733 */ TokenType.VAR,
      /* py:734 */ TokenType.ANTI,
      /* py:735 */ TokenType.APPLY,
      /* py:736 */ TokenType.ASC,
      /* py:737 */ TokenType.ASOF,
      /* py:738 */ TokenType.AUTO_INCREMENT,
      /* py:739 */ TokenType.BEGIN,
      /* py:740 */ TokenType.BPCHAR,
      /* py:741 */ TokenType.CACHE,
      /* py:742 */ TokenType.CASE,
      /* py:743 */ TokenType.COLLATE,
      /* py:744 */ TokenType.COMMAND,
      /* py:745 */ TokenType.COMMENT,
      /* py:746 */ TokenType.COMMIT,
      /* py:747 */ TokenType.CONSTRAINT,
      /* py:748 */ TokenType.COPY,
      /* py:749 */ TokenType.CUBE,
      /* py:750 */ TokenType.CURRENT_SCHEMA,
      /* py:751 */ TokenType.DECLARE,
      /* py:752 */ TokenType.DEFAULT,
      /* py:753 */ TokenType.DELETE,
      /* py:754 */ TokenType.DESC,
      /* py:755 */ TokenType.DESCRIBE,
      /* py:756 */ TokenType.DETACH,
      /* py:757 */ TokenType.DICTIONARY,
      /* py:758 */ TokenType.DIV,
      /* py:759 */ TokenType.END,
      /* py:760 */ TokenType.EXECUTE,
      /* py:761 */ TokenType.EXPORT,
      /* py:762 */ TokenType.ESCAPE,
      /* py:763 */ TokenType.FALSE,
      /* py:764 */ TokenType.FIRST,
      /* py:765 */ TokenType.FILE,
      /* py:766 */ TokenType.FILTER,
      /* py:767 */ TokenType.FINAL,
      /* py:768 */ TokenType.FORMAT,
      /* py:769 */ TokenType.FULL,
      /* py:770 */ TokenType.GET,
      /* py:771 */ TokenType.IDENTIFIER,
      /* py:772 */ TokenType.INOUT,
      /* py:773 */ TokenType.IS,
      /* py:774 */ TokenType.ISNULL,
      /* py:775 */ TokenType.INTERVAL,
      /* py:776 */ TokenType.KEEP,
      /* py:777 */ TokenType.KILL,
      /* py:778 */ TokenType.LEFT,
      /* py:779 */ TokenType.LIMIT,
      /* py:780 */ TokenType.LOAD,
      /* py:781 */ TokenType.LOCK,
      /* py:782 */ TokenType.MATCH,
      /* py:783 */ TokenType.MERGE,
      /* py:784 */ TokenType.NATURAL,
      /* py:785 */ TokenType.NEXT,
      /* py:786 */ TokenType.OFFSET,
      /* py:787 */ TokenType.OPERATOR,
      /* py:788 */ TokenType.ORDINALITY,
      /* py:789 */ TokenType.OUT,
      /* py:790 */ TokenType.OVER,
      /* py:791 */ TokenType.OVERLAPS,
      /* py:792 */ TokenType.OVERWRITE,
      /* py:793 */ TokenType.PARTITION,
      /* py:794 */ TokenType.PERCENT,
      /* py:795 */ TokenType.PIVOT,
      /* py:796 */ TokenType.PROJECTION,
      /* py:797 */ TokenType.PRAGMA,
      /* py:798 */ TokenType.PUT,
      /* py:799 */ TokenType.RANGE,
      /* py:800 */ TokenType.RECURSIVE,
      /* py:801 */ TokenType.REFERENCES,
      /* py:802 */ TokenType.REFRESH,
      /* py:803 */ TokenType.RENAME,
      /* py:804 */ TokenType.REPLACE,
      /* py:805 */ TokenType.RIGHT,
      /* py:806 */ TokenType.ROLLUP,
      /* py:807 */ TokenType.ROW,
      /* py:808 */ TokenType.ROWS,
      /* py:809 */ TokenType.SEMI,
      /* py:810 */ TokenType.SET,
      /* py:811 */ TokenType.SETTINGS,
      /* py:812 */ TokenType.SHOW,
      /* py:813 */ TokenType.STREAM,
      /* py:814 */ TokenType.STREAMLIT,
      /* py:815 */ TokenType.TEMPORARY,
      /* py:816 */ TokenType.TOP,
      /* py:817 */ TokenType.TRUE,
      /* py:818 */ TokenType.TRUNCATE,
      /* py:819 */ TokenType.UNIQUE,
      /* py:820 */ TokenType.UNNEST,
      /* py:821 */ TokenType.UNPIVOT,
      /* py:822 */ TokenType.UPDATE,
      /* py:823 */ TokenType.USE,
      /* py:824 */ TokenType.VOLATILE,
      /* py:825 */ TokenType.WINDOW,
      /* py:826 */ TokenType.CURRENT_CATALOG,
      /* py:827 */ TokenType.LOCALTIME,
      /* py:828 */ TokenType.LOCALTIMESTAMP,
      /* py:829 */ TokenType.SESSION_USER,
      /* py:830 */ TokenType.STRAIGHT_JOIN,
      /* py:831 */ ...this.ALTERABLES,
      /* py:832 */ ...this.CREATABLES,
      /* py:833 */ ...this.SUBQUERY_PREDICATES.keys(),
      /* py:834 */ ...this.TYPE_TOKENS,
      /* py:835 */ ...this.NO_PAREN_FUNCTIONS.keys(),
    ]),
    new Set([
      /* py:836 */ TokenType.UNION,
    ]),
  );

  /** py: sqlglot/parser.py:838 */
  static TABLE_ALIAS_TOKENS = setDiff(
    this.ID_VAR_TOKENS,
    new Set([
      /* py:839 */ TokenType.ANTI,
      /* py:840 */ TokenType.ASOF,
      /* py:841 */ TokenType.FULL,
      /* py:842 */ TokenType.LEFT,
      /* py:843 */ TokenType.LOCK,
      /* py:844 */ TokenType.NATURAL,
      /* py:845 */ TokenType.RIGHT,
      /* py:846 */ TokenType.SEMI,
      /* py:847 */ TokenType.WINDOW,
    ]),
  );

  /** py: sqlglot/parser.py:850 */
  static ALIAS_TOKENS = this.ID_VAR_TOKENS;

  /** py: sqlglot/parser.py:852 */
  static COLON_PLACEHOLDER_TOKENS = this.ID_VAR_TOKENS;

  /** py: sqlglot/parser.py:854 */
  static ARRAY_CONSTRUCTORS = new Map([
    /* py:855 */ ["ARRAY", exp.Array],
    /* py:856 */ ["LIST", exp.List],
  ]);

  /** py: sqlglot/parser.py:859 */
  static COMMENT_TABLE_ALIAS_TOKENS = setDiff(
    this.TABLE_ALIAS_TOKENS,
    new Set([
      /* py:859 */ TokenType.IS,
    ]),
  );

  /** py: sqlglot/parser.py:861 */
  static UPDATE_ALIAS_TOKENS = setDiff(
    this.TABLE_ALIAS_TOKENS,
    new Set([
      /* py:861 */ TokenType.SET,
    ]),
  );

  /** py: sqlglot/parser.py:863 */
  static TRIM_TYPES = new Set([
    /* py:863 */ "LEADING",
    /* py:863 */ "TRAILING",
    /* py:863 */ "BOTH",
  ]);

  /** py: sqlglot/parser.py:866 */
  static IDENTIFIER_TOKENS = new Set([
    /* py:866 */ TokenType.VAR,
    /* py:866 */ TokenType.IDENTIFIER,
  ]);

  /** py: sqlglot/parser.py:868 */
  static BRACKETS = new Set([
    /* py:868 */ TokenType.L_BRACKET,
    /* py:868 */ TokenType.L_BRACE,
  ]);

  /** py: sqlglot/parser.py:872 */
  static COLUMN_POSTFIX_TOKENS = new Set([
    /* py:873 */ TokenType.L_PAREN,
    /* py:874 */ TokenType.L_BRACKET,
    /* py:875 */ TokenType.L_BRACE,
    /* py:876 */ TokenType.COLON,
    /* py:877 */ TokenType.JOIN_MARKER,
  ]);

  /** py: sqlglot/parser.py:882 */
  static TABLE_POSTFIX_TOKENS = new Set([
    /* py:883 */ TokenType.L_PAREN,
    /* py:884 */ TokenType.L_BRACKET,
    /* py:885 */ TokenType.L_BRACE,
    /* py:886 */ TokenType.PIVOT,
    /* py:887 */ TokenType.UNPIVOT,
    /* py:888 */ TokenType.TABLE_SAMPLE,
  ]);

  /** py: sqlglot/parser.py:892 */
  static FUNC_TOKENS = new Set([
    /* py:893 */ TokenType.COLLATE,
    /* py:894 */ TokenType.COMMAND,
    /* py:895 */ TokenType.CURRENT_DATE,
    /* py:896 */ TokenType.CURRENT_DATETIME,
    /* py:897 */ TokenType.CURRENT_SCHEMA,
    /* py:898 */ TokenType.CURRENT_TIMESTAMP,
    /* py:899 */ TokenType.CURRENT_TIME,
    /* py:900 */ TokenType.CURRENT_USER,
    /* py:901 */ TokenType.CURRENT_CATALOG,
    /* py:902 */ TokenType.DECLARE,
    /* py:903 */ TokenType.FILTER,
    /* py:904 */ TokenType.FIRST,
    /* py:905 */ TokenType.FORMAT,
    /* py:906 */ TokenType.GET,
    /* py:907 */ TokenType.GLOB,
    /* py:908 */ TokenType.IDENTIFIER,
    /* py:909 */ TokenType.INDEX,
    /* py:910 */ TokenType.ISNULL,
    /* py:911 */ TokenType.ILIKE,
    /* py:912 */ TokenType.INSERT,
    /* py:913 */ TokenType.LIKE,
    /* py:914 */ TokenType.LOCALTIME,
    /* py:915 */ TokenType.LOCALTIMESTAMP,
    /* py:916 */ TokenType.MERGE,
    /* py:917 */ TokenType.NEXT,
    /* py:918 */ TokenType.OFFSET,
    /* py:919 */ TokenType.PRIMARY_KEY,
    /* py:920 */ TokenType.RANGE,
    /* py:921 */ TokenType.REPLACE,
    /* py:922 */ TokenType.RLIKE,
    /* py:923 */ TokenType.ROW,
    /* py:924 */ TokenType.SESSION_USER,
    /* py:925 */ TokenType.UNNEST,
    /* py:926 */ TokenType.VAR,
    /* py:927 */ TokenType.LEFT,
    /* py:928 */ TokenType.RIGHT,
    /* py:929 */ TokenType.SEQUENCE,
    /* py:930 */ TokenType.DATE,
    /* py:931 */ TokenType.DATETIME,
    /* py:932 */ TokenType.TABLE,
    /* py:933 */ TokenType.TIMESTAMP,
    /* py:934 */ TokenType.TIMESTAMPTZ,
    /* py:935 */ TokenType.TRUNCATE,
    /* py:936 */ TokenType.UTC_DATE,
    /* py:937 */ TokenType.UTC_TIME,
    /* py:938 */ TokenType.UTC_TIMESTAMP,
    /* py:939 */ TokenType.WINDOW,
    /* py:940 */ TokenType.XOR,
    /* py:941 */ ...this.TYPE_TOKENS,
    /* py:942 */ ...this.SUBQUERY_PREDICATES.keys(),
  ]);

  /** py: sqlglot/parser.py:945 */
  static CONJUNCTION = new Map([
    /* py:946 */ [TokenType.AND, exp.And],
  ]);

  /** py: sqlglot/parser.py:949 */
  static ASSIGNMENT = new Map([
    /* py:950 */ [TokenType.COLON_EQ, exp.PropertyEQ],
  ]);

  /** py: sqlglot/parser.py:953 */
  static DISJUNCTION = new Map([
    /* py:954 */ [TokenType.OR, exp.Or],
  ]);

  /** py: sqlglot/parser.py:957 */
  static EQUALITY = new Map([
    /* py:958 */ [TokenType.EQ, exp.EQ],
    /* py:959 */ [TokenType.NEQ, exp.NEQ],
    /* py:960 */ [TokenType.NULLSAFE_EQ, exp.NullSafeEQ],
  ]);

  /** py: sqlglot/parser.py:963 */
  static COMPARISON = new Map([
    /* py:964 */ [TokenType.GT, exp.GT],
    /* py:965 */ [TokenType.GTE, exp.GTE],
    /* py:966 */ [TokenType.LT, exp.LT],
    /* py:967 */ [TokenType.LTE, exp.LTE],
  ]);

  /** py: sqlglot/parser.py:970 */
  static BITWISE = new Map([
    /* py:971 */ [TokenType.AMP, exp.BitwiseAnd],
    /* py:972 */ [TokenType.CARET, exp.BitwiseXor],
    /* py:973 */ [TokenType.PIPE, exp.BitwiseOr],
  ]);

  /** py: sqlglot/parser.py:976 */
  static TERM = new Map([
    /* py:977 */ [TokenType.DASH, exp.Sub],
    /* py:978 */ [TokenType.PLUS, exp.Add],
    /* py:979 */ [TokenType.MOD, exp.Mod],
    /* py:980 */ [TokenType.COLLATE, exp.Collate],
  ]);

  /** py: sqlglot/parser.py:983 */
  static FACTOR = new Map([
    /* py:984 */ [TokenType.DIV, exp.IntDiv],
    /* py:985 */ [TokenType.LR_ARROW, exp.Distance],
    /* py:986 */ [TokenType.LLRR_ARROW, exp.DistanceNd],
    /* py:987 */ [TokenType.SLASH, exp.Div],
    /* py:988 */ [TokenType.STAR, exp.Mul],
  ]);

  /** py: sqlglot/parser.py:991 */
  static EXPONENT = new Map([
  ]);

  /** py: sqlglot/parser.py:993 */
  static TIMES = new Set([
    /* py:994 */ TokenType.TIME,
    /* py:995 */ TokenType.TIMETZ,
  ]);

  /** py: sqlglot/parser.py:998 */
  static TIMESTAMPS = new Set([
    /* py:999 */ TokenType.TIMESTAMP,
    /* py:1000 */ TokenType.TIMESTAMPNTZ,
    /* py:1001 */ TokenType.TIMESTAMPTZ,
    /* py:1002 */ TokenType.TIMESTAMPLTZ,
    /* py:1003 */ ...this.TIMES,
  ]);

  /** py: sqlglot/parser.py:1006 */
  static SET_OPERATIONS = new Set([
    /* py:1007 */ TokenType.UNION,
    /* py:1008 */ TokenType.INTERSECT,
    /* py:1009 */ TokenType.EXCEPT,
  ]);

  /** py: sqlglot/parser.py:1012 */
  static JOIN_METHODS = new Set([
    /* py:1013 */ TokenType.ASOF,
    /* py:1014 */ TokenType.NATURAL,
    /* py:1015 */ TokenType.POSITIONAL,
  ]);

  /** py: sqlglot/parser.py:1018 */
  static JOIN_SIDES = new Set([
    /* py:1019 */ TokenType.LEFT,
    /* py:1020 */ TokenType.RIGHT,
    /* py:1021 */ TokenType.FULL,
  ]);

  /** py: sqlglot/parser.py:1024 */
  static JOIN_KINDS = new Set([
    /* py:1025 */ TokenType.ANTI,
    /* py:1026 */ TokenType.CROSS,
    /* py:1027 */ TokenType.INNER,
    /* py:1028 */ TokenType.OUTER,
    /* py:1029 */ TokenType.SEMI,
    /* py:1030 */ TokenType.STRAIGHT_JOIN,
  ]);

  /** py: sqlglot/parser.py:1033 */
  static JOIN_HINTS = new Set([
  ]);

  /** py: sqlglot/parser.py:1037 */
  static TABLE_TERMINATORS = new Set([
    /* py:1038 */ TokenType.COMMA,
    /* py:1039 */ TokenType.GROUP_BY,
    /* py:1040 */ TokenType.HAVING,
    /* py:1041 */ TokenType.JOIN,
    /* py:1042 */ TokenType.LIMIT,
    /* py:1043 */ TokenType.ON,
    /* py:1044 */ TokenType.ORDER_BY,
    /* py:1045 */ TokenType.R_PAREN,
    /* py:1046 */ TokenType.SEMICOLON,
    /* py:1047 */ TokenType.SENTINEL,
    /* py:1048 */ TokenType.WHERE,
    /* py:1049 */ ...this.SET_OPERATIONS,
    /* py:1050 */ ...this.JOIN_KINDS,
    /* py:1051 */ ...this.JOIN_METHODS,
    /* py:1052 */ ...this.JOIN_SIDES,
  ]);

  /** py: sqlglot/parser.py:1056 */
  static LAMBDAS = new Map([
    // py:1057  [TokenType.ARROW, /* TODO lambda */],
    // py:1066  [TokenType.FARROW, /* TODO lambda */],
  ]);

  /** py: sqlglot/parser.py:1075 */
  static TYPED_LAMBDA_ARGS = false;

  /** py: sqlglot/parser.py:1077 */
  static LAMBDA_ARG_TERMINATORS = new Set([
    /* py:1077 */ TokenType.COMMA,
    /* py:1077 */ TokenType.R_PAREN,
  ]);

  /** py: sqlglot/parser.py:1079 */
  static COLUMN_OPERATORS = new Map([
    /* py:1080 */ [TokenType.DOT, null],
    // py:1081  [TokenType.DOTCOLON, /* TODO lambda */],
    // py:1082  [TokenType.DCOLON, /* TODO lambda */],
    // py:1085  [TokenType.ARROW, /* TODO lambda */],
    // py:1092  [TokenType.DARROW, /* TODO lambda */],
    // py:1100  [TokenType.HASH_ARROW, /* TODO lambda */],
    // py:1103  [TokenType.DHASH_ARROW, /* TODO lambda */],
    // py:1106  [TokenType.PLACEHOLDER, /* TODO lambda */],
  ]);

  /** py: sqlglot/parser.py:1113 */
  static JSON_OPERATORS = new Map([
  ]);

  /** py: sqlglot/parser.py:1115 */
  static CAST_COLUMN_OPERATORS = new Set([
    /* py:1116 */ TokenType.DOTCOLON,
    /* py:1117 */ TokenType.DCOLON,
  ]);

  /** py: sqlglot/parser.py:1120 */
  static EXPRESSION_PARSERS = new Map([
    // py:1121  [exp.Cluster, /* TODO lambda */],
    // py:1122  [exp.Column, /* TODO lambda */],
    // py:1123  [exp.ColumnDef, /* TODO lambda */],
    // py:1124  [exp.Condition, /* TODO lambda */],
    // py:1125  [exp.DataType, /* TODO lambda */],
    // py:1126  [exp.Expr, /* TODO lambda */],
    // py:1127  [exp.From, /* TODO lambda */],
    // py:1128  [exp.GrantPrincipal, /* TODO lambda */],
    // py:1129  [exp.GrantPrivilege, /* TODO lambda */],
    // py:1130  [exp.Group, /* TODO lambda */],
    // py:1131  [exp.Having, /* TODO lambda */],
    // py:1132  [exp.Hint, /* TODO lambda */],
    // py:1133  [exp.Identifier, /* TODO lambda */],
    // py:1134  [exp.Join, /* TODO lambda */],
    // py:1135  [exp.Lambda, /* TODO lambda */],
    // py:1136  [exp.Lateral, /* TODO lambda */],
    // py:1137  [exp.Limit, /* TODO lambda */],
    // py:1138  [exp.Offset, /* TODO lambda */],
    // py:1139  [exp.Order, /* TODO lambda */],
    // py:1140  [exp.Ordered, /* TODO lambda */],
    // py:1141  [exp.Properties, /* TODO lambda */],
    // py:1142  [exp.PartitionedByProperty, /* TODO lambda */],
    // py:1143  [exp.Qualify, /* TODO lambda */],
    // py:1144  [exp.Returning, /* TODO lambda */],
    // py:1145  [exp.Select, /* TODO lambda */],
    // py:1146  [exp.Sort, /* TODO lambda */],
    // py:1147  [exp.Table, /* TODO lambda */],
    // py:1148  [exp.TableAlias, /* TODO lambda */],
    // py:1149  [exp.Tuple, /* TODO lambda */],
    // py:1150  [exp.Whens, /* TODO lambda */],
    // py:1151  [exp.Where, /* TODO lambda */],
    // py:1152  [exp.Window, /* TODO lambda */],
    // py:1153  [exp.With, /* TODO lambda */],
  ]);

  /** py: sqlglot/parser.py:1156 */
  static STATEMENT_PARSERS = new Map([
    // py:1157  [TokenType.ALTER, /* TODO lambda */],
    // py:1158  [TokenType.ANALYZE, /* TODO lambda */],
    // py:1159  [TokenType.BEGIN, /* TODO lambda */],
    // py:1160  [TokenType.CACHE, /* TODO lambda */],
    // py:1161  [TokenType.COMMENT, /* TODO lambda */],
    // py:1162  [TokenType.COMMIT, /* TODO lambda */],
    // py:1163  [TokenType.COPY, /* TODO lambda */],
    // py:1164  [TokenType.CREATE, /* TODO lambda */],
    // py:1165  [TokenType.DECLARE, /* TODO lambda */],
    // py:1166  [TokenType.DELETE, /* TODO lambda */],
    // py:1167  [TokenType.DESC, /* TODO lambda */],
    // py:1168  [TokenType.DESCRIBE, /* TODO lambda */],
    // py:1169  [TokenType.DROP, /* TODO lambda */],
    // py:1170  [TokenType.GRANT, /* TODO lambda */],
    // py:1171  [TokenType.REVOKE, /* TODO lambda */],
    // py:1172  [TokenType.INSERT, /* TODO lambda */],
    // py:1173  [TokenType.KILL, /* TODO lambda */],
    // py:1174  [TokenType.LOAD, /* TODO lambda */],
    // py:1175  [TokenType.MERGE, /* TODO lambda */],
    // py:1176  [TokenType.PIVOT, /* TODO lambda */],
    // py:1177  [TokenType.PRAGMA, /* TODO lambda */],
    // py:1178  [TokenType.REFRESH, /* TODO lambda */],
    // py:1179  [TokenType.ROLLBACK, /* TODO lambda */],
    // py:1180  [TokenType.SET, /* TODO lambda */],
    // py:1181  [TokenType.TRUNCATE, /* TODO lambda */],
    // py:1182  [TokenType.UNCACHE, /* TODO lambda */],
    // py:1183  [TokenType.UNPIVOT, /* TODO lambda */],
    // py:1184  [TokenType.UPDATE, /* TODO lambda */],
    // py:1185  [TokenType.USE, /* TODO lambda */],
    // py:1186  [TokenType.SEMICOLON, /* TODO lambda */],
  ]);

  /** py: sqlglot/parser.py:1189 */
  static UNARY_PARSERS = new Map([
    // py:1190  [TokenType.PLUS, /* TODO lambda */],
    // py:1191  [TokenType.NOT, /* TODO lambda */],
    // py:1192  [TokenType.TILDE, /* TODO lambda */],
    // py:1193  [TokenType.DASH, /* TODO lambda */],
    // py:1194  [TokenType.PIPE_SLASH, /* TODO lambda */],
    // py:1195  [TokenType.DPIPE_SLASH, /* TODO lambda */],
  ]);

  /** py: sqlglot/parser.py:1198 */
  // Four of the five entries are ported here because `_parse_command` reaches
  // `_parse_string` on the Command fallback path, which the 18 `check_command_warning`
  // assertions exercise. UNICODE_STRING is left as an anchored TODO: its lambda calls
  // `_match_text_seq("UESCAPE")` and recurses into `_parse_string`, so it belongs with
  // the stub-queue task that owns it rather than being half-done here.
  static STRING_PARSERS = new Map([
    /* py:1199 */ [TokenType.HEREDOC_STRING, (self, token) => self.expression(new exp.RawString({ this: token.text }), token)],
    /* py:1202 */ [TokenType.NATIONAL_STRING, (self, token) => self.expression(new exp.National({ this: token.text }), token)],
    /* py:1205 */ [TokenType.RAW_STRING, (self, token) => self.expression(new exp.RawString({ this: token.text }), token)],
    /* py:1208 */ [TokenType.STRING, (self, token) => self.expression(new exp.Literal({ this: token.text, is_string: true }), token)],
    // py:1211  [TokenType.UNICODE_STRING, /* TODO lambda */],
  ]);

  /** py: sqlglot/parser.py:1219 */
  static NUMERIC_PARSERS = new Map([
    // py:1220  [TokenType.BIT_STRING, /* TODO lambda */],
    // py:1223  [TokenType.BYTE_STRING, /* TODO lambda */],
    // py:1229  [TokenType.HEX_STRING, /* TODO lambda */],
    // py:1235  [TokenType.NUMBER, /* TODO lambda */],
  ]);

  /** py: sqlglot/parser.py:1240 */
  static PRIMARY_PARSERS = new Map([
    // py:1241  SPREAD: STRING_PARSERS — merge manually (§4.4 MRO)
    // py:1242  SPREAD: NUMERIC_PARSERS — merge manually (§4.4 MRO)
    // py:1243  [TokenType.INTRODUCER, /* TODO lambda */],
    // py:1244  [TokenType.NULL, /* TODO lambda */],
    // py:1245  [TokenType.TRUE, /* TODO lambda */],
    // py:1246  [TokenType.FALSE, /* TODO lambda */],
    // py:1247  [TokenType.SESSION_PARAMETER, /* TODO lambda */],
    // py:1248  [TokenType.STAR, /* TODO lambda */],
  ]);

  /** py: sqlglot/parser.py:1251 */
  static PLACEHOLDER_PARSERS = new Map([
    // py:1252  [TokenType.PLACEHOLDER, /* TODO lambda */],
    // py:1253  [TokenType.PARAMETER, /* TODO lambda */],
    // py:1254  [TokenType.COLON, /* TODO lambda */],
  ]);

  /** py: sqlglot/parser.py:1261 */
  static RANGE_PARSERS = new Map([
    // py:1262  [TokenType.AT_GT, /* TODO binary_range_parser(...) */],
    // py:1263  [TokenType.BETWEEN, /* TODO lambda */],
    // py:1264  [TokenType.GLOB, /* TODO binary_range_parser(...) */],
    // py:1265  [TokenType.ILIKE, /* TODO binary_range_parser(...) */],
    // py:1266  [TokenType.IN, /* TODO lambda */],
    // py:1267  [TokenType.IRLIKE, /* TODO binary_range_parser(...) */],
    // py:1268  [TokenType.IS, /* TODO lambda */],
    // py:1269  [TokenType.LIKE, /* TODO binary_range_parser(...) */],
    // py:1270  [TokenType.LT_AT, /* TODO binary_range_parser(...) */],
    // py:1271  [TokenType.OVERLAPS, /* TODO binary_range_parser(...) */],
    // py:1272  [TokenType.RLIKE, /* TODO binary_range_parser(...) */],
    // py:1273  [TokenType.SIMILAR_TO, /* TODO binary_range_parser(...) */],
    // py:1274  [TokenType.FOR, /* TODO lambda */],
    // py:1275  [TokenType.QMARK_AMP, /* TODO binary_range_parser(...) */],
    // py:1276  [TokenType.QMARK_PIPE, /* TODO binary_range_parser(...) */],
    // py:1277  [TokenType.HASH_DASH, /* TODO binary_range_parser(...) */],
    // py:1278  [TokenType.AT_QMARK, /* TODO binary_range_parser(...) */],
    // py:1279  [TokenType.ADJACENT, /* TODO binary_range_parser(...) */],
    // py:1280  [TokenType.OPERATOR, /* TODO lambda */],
    // py:1281  [TokenType.AMP_LT, /* TODO binary_range_parser(...) */],
    // py:1282  [TokenType.AMP_GT, /* TODO binary_range_parser(...) */],
  ]);

  /** py: sqlglot/parser.py:1285 */
  static PIPE_SYNTAX_TRANSFORM_PARSERS = new Map([
    // py:1286  ["AGGREGATE", /* TODO lambda */],
    // py:1287  ["AS", /* TODO lambda */],
    // py:1290  ["DISTINCT", /* TODO lambda */],
    // py:1291  ["EXTEND", /* TODO lambda */],
    // py:1292  ["LIMIT", /* TODO lambda */],
    // py:1293  ["ORDER BY", /* TODO lambda */],
    // py:1296  ["PIVOT", /* TODO lambda */],
    // py:1297  ["SELECT", /* TODO lambda */],
    // py:1298  ["TABLESAMPLE", /* TODO lambda */],
    // py:1299  ["UNPIVOT", /* TODO lambda */],
    // py:1300  ["WHERE", /* TODO lambda */],
  ]);

  /** py: sqlglot/parser.py:1303 */
  static PROPERTY_PARSERS = new Map([
    // py:1304  ["ALLOWED_VALUES", /* TODO lambda */],
    // py:1307  ["ALGORITHM", /* TODO lambda */],
    // py:1308  ["AUTO", /* TODO lambda */],
    // py:1309  ["AUTO_INCREMENT", /* TODO lambda */],
    // py:1310  ["BACKUP", /* TODO lambda */],
    // py:1313  ["BLOCKCOMPRESSION", /* TODO lambda */],
    // py:1314  ["CALLED", /* TODO lambda */],
    // py:1315  ["CHARSET", /* TODO lambda */],
    // py:1316  ["CHECKSUM", /* TODO lambda */],
    // py:1317  ["CLUSTER BY", /* TODO lambda */],
    // py:1318  ["CLUSTERED", /* TODO lambda */],
    // py:1319  ["COLLATE", /* TODO lambda */],
    // py:1322  ["COMMENT", /* TODO lambda */],
    // py:1323  ["CONTAINS", /* TODO lambda */],
    // py:1324  ["COPY", /* TODO lambda */],
    // py:1325  ["DATABLOCKSIZE", /* TODO lambda */],
    // py:1326  ["DATA_DELETION", /* TODO lambda */],
    // py:1327  ["DEFINER", /* TODO lambda */],
    // py:1328  ["DETERMINISTIC", /* TODO lambda */],
    // py:1331  ["DISTRIBUTED", /* TODO lambda */],
    // py:1332  ["DUPLICATE", /* TODO lambda */],
    // py:1333  ["DYNAMIC", /* TODO lambda */],
    // py:1334  ["DISTKEY", /* TODO lambda */],
    // py:1335  ["DISTSTYLE", /* TODO lambda */],
    // py:1336  ["EMPTY", /* TODO lambda */],
    // py:1337  ["ENGINE", /* TODO lambda */],
    // py:1338  ["ENVIRONMENT", /* TODO lambda */],
    // py:1341  ["HANDLER", /* TODO lambda */],
    // py:1342  ["EXECUTE", /* TODO lambda */],
    // py:1343  ["EXTERNAL", /* TODO lambda */],
    // py:1344  ["FALLBACK", /* TODO lambda */],
    // py:1345  ["FORMAT", /* TODO lambda */],
    // py:1346  ["FREESPACE", /* TODO lambda */],
    // py:1347  ["GLOBAL", /* TODO lambda */],
    // py:1348  ["HEAP", /* TODO lambda */],
    // py:1349  ["ICEBERG", /* TODO lambda */],
    // py:1350  ["IMMUTABLE", /* TODO lambda */],
    // py:1353  ["INHERITS", /* TODO lambda */],
    // py:1356  ["INPUT", /* TODO lambda */],
    // py:1357  ["JOURNAL", /* TODO lambda */],
    // py:1358  ["LANGUAGE", /* TODO lambda */],
    // py:1359  ["LAYOUT", /* TODO lambda */],
    // py:1360  ["LIFETIME", /* TODO lambda */],
    // py:1361  ["LIKE", /* TODO lambda */],
    // py:1362  ["LOCATION", /* TODO lambda */],
    // py:1363  ["LOCK", /* TODO lambda */],
    // py:1364  ["LOCKING", /* TODO lambda */],
    // py:1365  ["LOG", /* TODO lambda */],
    // py:1366  ["MATERIALIZED", /* TODO lambda */],
    // py:1367  ["MERGEBLOCKRATIO", /* TODO lambda */],
    // py:1368  ["MODIFIES", /* TODO lambda */],
    // py:1369  ["MULTISET", /* TODO lambda */],
    // py:1370  ["NO", /* TODO lambda */],
    // py:1371  ["ON", /* TODO lambda */],
    // py:1372  ["ORDER BY", /* TODO lambda */],
    // py:1373  ["OUTPUT", /* TODO lambda */],
    // py:1374  ["PARTITION", /* TODO lambda */],
    // py:1375  ["PARTITION BY", /* TODO lambda */],
    // py:1376  ["PARTITIONED BY", /* TODO lambda */],
    // py:1377  ["PARTITIONED_BY", /* TODO lambda */],
    // py:1378  ["PRIMARY KEY", /* TODO lambda */],
    // py:1379  ["RANGE", /* TODO lambda */],
    // py:1380  ["READS", /* TODO lambda */],
    // py:1381  ["REMOTE", /* TODO lambda */],
    // py:1382  ["RETURNS", /* TODO lambda */],
    // py:1383  ["STRICT", /* TODO lambda */],
    // py:1384  ["STREAMING", /* TODO lambda */],
    // py:1385  ["ROW", /* TODO lambda */],
    // py:1386  ["ROW_FORMAT", /* TODO lambda */],
    // py:1387  ["SAMPLE", /* TODO lambda */],
    // py:1390  ["SECURE", /* TODO lambda */],
    // py:1391  ["SECURITY", /* TODO lambda */],
    // py:1392  ["SQL SECURITY", /* TODO lambda */],
    // py:1393  ["SET", /* TODO lambda */],
    // py:1394  ["SETTINGS", /* TODO lambda */],
    // py:1395  ["SHARING", /* TODO lambda */],
    // py:1396  ["SORTKEY", /* TODO lambda */],
    // py:1397  ["SOURCE", /* TODO lambda */],
    // py:1398  ["STABLE", /* TODO lambda */],
    // py:1401  ["STORED", /* TODO lambda */],
    // py:1402  ["SYSTEM_VERSIONING", /* TODO lambda */],
    // py:1403  ["TBLPROPERTIES", /* TODO lambda */],
    // py:1404  ["TEMP", /* TODO lambda */],
    // py:1405  ["TEMPORARY", /* TODO lambda */],
    // py:1406  ["TO", /* TODO lambda */],
    // py:1407  ["TRANSIENT", /* TODO lambda */],
    // py:1408  ["TRANSFORM", /* TODO lambda */],
    // py:1411  ["TTL", /* TODO lambda */],
    // py:1412  ["USING", /* TODO lambda */],
    // py:1413  ["UNLOGGED", /* TODO lambda */],
    // py:1414  ["VOLATILE", /* TODO lambda */],
    // py:1415  ["WITH", /* TODO lambda */],
  ]);

  /** py: sqlglot/parser.py:1418 */
  static CONSTRAINT_PARSERS = new Map([
    // py:1419  ["AUTOINCREMENT", /* TODO lambda */],
    // py:1420  ["AUTO_INCREMENT", /* TODO lambda */],
    // py:1421  ["CASESPECIFIC", /* TODO lambda */],
    // py:1422  ["CHECK", /* TODO lambda */],
    // py:1423  ["COLLATE", /* TODO lambda */],
    // py:1426  ["COMMENT", /* TODO lambda */],
    // py:1429  ["COMPRESS", /* TODO lambda */],
    // py:1430  ["CLUSTERED", /* TODO lambda */],
    // py:1433  ["NONCLUSTERED", /* TODO lambda */],
    // py:1436  ["DEFAULT", /* TODO lambda */],
    // py:1439  ["ENCODE", /* TODO lambda */],
    // py:1440  ["EPHEMERAL", /* TODO lambda */],
    // py:1443  ["EXCLUDE", /* TODO lambda */],
    // py:1446  ["FOREIGN KEY", /* TODO lambda */],
    // py:1447  ["FORMAT", /* TODO lambda */],
    // py:1450  ["GENERATED", /* TODO lambda */],
    // py:1451  ["IDENTITY", /* TODO lambda */],
    // py:1452  ["INLINE", /* TODO lambda */],
    // py:1453  ["LIKE", /* TODO lambda */],
    // py:1454  ["NOT", /* TODO lambda */],
    // py:1455  ["NULL", /* TODO lambda */],
    // py:1456  ["ON", /* TODO lambda */],
    // py:1463  ["PATH", /* TODO lambda */],
    // py:1464  ["PERIOD", /* TODO lambda */],
    // py:1465  ["PRIMARY KEY", /* TODO lambda */],
    // py:1466  ["REFERENCES", /* TODO lambda */],
    // py:1467  ["TITLE", /* TODO lambda */],
    // py:1470  ["TTL", /* TODO lambda */],
    // py:1471  ["UNIQUE", /* TODO lambda */],
    // py:1472  ["UPPERCASE", /* TODO lambda */],
    // py:1473  ["WITH", /* TODO lambda */],
    // py:1476  ["BUCKET", /* TODO lambda */],
    // py:1477  ["TRUNCATE", /* TODO lambda */],
  ]);

  /** @returns {*} */
  // py: sqlglot/parser.py:1480
  _parse_partitioned_by_bucket_or_truncate() {
    if (!this._match(TokenType.L_PAREN, false)) {
      this._retreat(this._index - 1);
      return null;
    }
    const Klass = this._prev.text.toUpperCase() === "BUCKET" ? exp.PartitionedByBucket : exp.PartitionByTruncate;
    const args = this._parse_wrapped_csv(() => this._parse_primary() || this._parse_column());
    let this_ = seqGet(args, 0);
    let expression = seqGet(args, 1);
    if (this_ instanceof exp.Literal) [this_, expression] = [expression, this_];
    return this.expression(new Klass({ this: this_, expression }));
  }

  /** py: sqlglot/parser.py:1509 */
  static ALTER_PARSERS = new Map([
    // py:1510  ["ADD", /* TODO lambda */],
    // py:1511  ["AS", /* TODO lambda */],
    // py:1512  ["ALTER", /* TODO lambda */],
    // py:1513  ["CLUSTER BY", /* TODO lambda */],
    // py:1514  ["DELETE", /* TODO lambda */],
    // py:1515  ["DROP", /* TODO lambda */],
    // py:1516  ["RENAME", /* TODO lambda */],
    // py:1517  ["SET", /* TODO lambda */],
    // py:1518  ["SWAP", /* TODO lambda */],
  ]);

  /** py: sqlglot/parser.py:1523 */
  static ALTER_ALTER_PARSERS = new Map([
    // py:1524  ["DISTKEY", /* TODO lambda */],
    // py:1525  ["DISTSTYLE", /* TODO lambda */],
    // py:1526  ["SORTKEY", /* TODO lambda */],
    // py:1527  ["COMPOUND", /* TODO lambda */],
  ]);

  /** py: sqlglot/parser.py:1530 */
  static SCHEMA_UNNAMED_CONSTRAINTS = new Set([
    /* py:1531 */ "CHECK",
    /* py:1532 */ "EXCLUDE",
    /* py:1533 */ "FOREIGN KEY",
    /* py:1534 */ "LIKE",
    /* py:1535 */ "PERIOD",
    /* py:1536 */ "PRIMARY KEY",
    /* py:1537 */ "UNIQUE",
    /* py:1538 */ "BUCKET",
    /* py:1539 */ "TRUNCATE",
  ]);

  /** py: sqlglot/parser.py:1542 */
  static NO_PAREN_FUNCTION_PARSERS = new Map([
    // py:1543  ["ANY", /* TODO lambda */],
    // py:1544  ["CASE", /* TODO lambda */],
    // py:1545  ["CONNECT_BY_ROOT", /* TODO lambda */],
    // py:1548  ["IF", /* TODO lambda */],
  ]);

  /** py: sqlglot/parser.py:1551 */
  static INVALID_FUNC_NAME_TOKENS = new Set([
    /* py:1552 */ TokenType.IDENTIFIER,
    /* py:1553 */ TokenType.STRING,
  ]);

  /** py: sqlglot/parser.py:1556 */
  static FUNCTIONS_WITH_ALIASED_ARGS = new Set([
    /* py:1556 */ "STRUCT",
  ]);

  /** py: sqlglot/parser.py:1558 */
  static KEY_VALUE_DEFINITIONS = [
    /* py:1558 */ exp.Alias,
    /* py:1558 */ exp.EQ,
    /* py:1558 */ exp.PropertyEQ,
    /* py:1558 */ exp.Slice,
  ];

  /** py: sqlglot/parser.py:1560 */
  static FUNCTION_PARSERS = new Map([
    // py:1561  SPREAD: DictComp — merge manually (§4.4 MRO)
    // py:1565  SPREAD: DictComp — merge manually (§4.4 MRO)
    // py:1569  ["CAST", /* TODO lambda */],
    // py:1570  ["CEIL", /* TODO lambda */],
    // py:1571  ["CONVERT", /* TODO lambda */],
    // py:1572  ["CHAR", /* TODO lambda */],
    // py:1573  ["CHR", /* TODO lambda */],
    // py:1574  ["DECODE", /* TODO lambda */],
    // py:1575  ["EXTRACT", /* TODO lambda */],
    // py:1576  ["FLOOR", /* TODO lambda */],
    // py:1577  ["GAP_FILL", /* TODO lambda */],
    // py:1578  ["INITCAP", /* TODO lambda */],
    // py:1579  ["JSON_OBJECT", /* TODO lambda */],
    // py:1580  ["JSON_OBJECTAGG", /* TODO lambda */],
    // py:1581  ["JSON_TABLE", /* TODO lambda */],
    // py:1582  ["MATCH", /* TODO lambda */],
    // py:1583  ["NORMALIZE", /* TODO lambda */],
    // py:1584  ["OPENJSON", /* TODO lambda */],
    // py:1585  ["OVERLAY", /* TODO lambda */],
    // py:1586  ["POSITION", /* TODO lambda */],
    // py:1587  ["SAFE_CAST", /* TODO lambda */],
    // py:1588  ["STRING_AGG", /* TODO lambda */],
    // py:1589  ["SUBSTRING", /* TODO lambda */],
    // py:1590  ["TRIM", /* TODO lambda */],
    // py:1591  ["TRY_CAST", /* TODO lambda */],
    // py:1592  ["TRY_CONVERT", /* TODO lambda */],
    // py:1593  ["XMLELEMENT", /* TODO lambda */],
    // py:1594  ["XMLTABLE", /* TODO lambda */],
  ]);

  /** py: sqlglot/parser.py:1597 */
  static QUERY_MODIFIER_PARSERS = new Map([
    // py:1598  [TokenType.MATCH_RECOGNIZE, /* TODO lambda */],
    // py:1599  [TokenType.PREWHERE, /* TODO lambda */],
    // py:1600  [TokenType.WHERE, /* TODO lambda */],
    // py:1601  [TokenType.GROUP_BY, /* TODO lambda */],
    // py:1602  [TokenType.HAVING, /* TODO lambda */],
    // py:1603  [TokenType.QUALIFY, /* TODO lambda */],
    // py:1604  [TokenType.WINDOW, /* TODO lambda */],
    // py:1605  [TokenType.ORDER_BY, /* TODO lambda */],
    // py:1606  [TokenType.LIMIT, /* TODO lambda */],
    // py:1607  [TokenType.FETCH, /* TODO lambda */],
    // py:1608  [TokenType.OFFSET, /* TODO lambda */],
    // py:1609  [TokenType.FOR, /* TODO lambda */],
    // py:1610  [TokenType.LOCK, /* TODO lambda */],
    // py:1611  [TokenType.TABLE_SAMPLE, /* TODO lambda */],
    // py:1612  [TokenType.USING, /* TODO lambda */],
    // py:1613  [TokenType.CLUSTER_BY, /* TODO lambda */],
    // py:1617  [TokenType.DISTRIBUTE_BY, /* TODO lambda */],
    // py:1621  [TokenType.SORT_BY, /* TODO lambda */],
    // py:1622  [TokenType.CONNECT_BY, /* TODO lambda */],
  ]);

  /** py: sqlglot/parser.py:1624 */
  static QUERY_MODIFIER_TOKENS = new Set(this.QUERY_MODIFIER_PARSERS.keys());

  /** py: sqlglot/parser.py:1626 */
  static SET_PARSERS = new Map([
    // py:1627  ["GLOBAL", /* TODO lambda */],
    // py:1628  ["LOCAL", /* TODO lambda */],
    // py:1629  ["SESSION", /* TODO lambda */],
    // py:1630  ["TRANSACTION", /* TODO lambda */],
  ]);

  /** py: sqlglot/parser.py:1633 */
  static SHOW_PARSERS = new Map([
  ]);

  /** py: sqlglot/parser.py:1635 */
  static TYPE_LITERAL_PARSERS = new Map([
    // py:1636  [exp.DType.JSON, /* TODO lambda */],
  ]);

  /** py: sqlglot/parser.py:1639 */
  static TYPE_CONVERTERS = new Map([
  ]);

  /** py: sqlglot/parser.py:1641 */
  static DDL_SELECT_TOKENS = new Set([
    /* py:1641 */ TokenType.SELECT,
    /* py:1641 */ TokenType.WITH,
    /* py:1641 */ TokenType.L_PAREN,
  ]);

  /** py: sqlglot/parser.py:1643 */
  static PRE_VOLATILE_TOKENS = new Set([
    /* py:1643 */ TokenType.CREATE,
    /* py:1643 */ TokenType.REPLACE,
    /* py:1643 */ TokenType.UNIQUE,
  ]);

  /** py: sqlglot/parser.py:1645 */
  static TRANSACTION_KIND = new Set([
    /* py:1645 */ "DEFERRED",
    /* py:1645 */ "IMMEDIATE",
    /* py:1645 */ "EXCLUSIVE",
  ]);

  /** py: sqlglot/parser.py:1646 */
  static TRANSACTION_CHARACTERISTICS = new Map([
    /* py:1647 */ ["ISOLATION", [["LEVEL", "REPEATABLE", "READ"], ["LEVEL", "READ", "COMMITTED"], ["LEVEL", "READ", "UNCOMITTED"], ["LEVEL", "SERIALIZABLE"]]],
    /* py:1653 */ ["READ", ["WRITE", "ONLY"]],
  ]);

  /** py: sqlglot/parser.py:1656 */
  static CONFLICT_ACTIONS = new Map([
    /* py:1657 */ ["ABORT", []],
    /* py:1657 */ ["FAIL", []],
    /* py:1657 */ ["IGNORE", []],
    /* py:1657 */ ["REPLACE", []],
    /* py:1657 */ ["ROLLBACK", []],
    /* py:1657 */ ["UPDATE", []],
    /* py:1658 */ ["DO", ["NOTHING", "UPDATE"]],
  ]);

  /** py: sqlglot/parser.py:1661 */
  static TRIGGER_TIMING = new Map([
    /* py:1662 */ ["INSTEAD", [["OF"]]],
    /* py:1663 */ ["BEFORE", []],
    /* py:1664 */ ["AFTER", []],
  ]);

  /** py: sqlglot/parser.py:1667 */
  static TRIGGER_DEFERRABLE = new Map([
    /* py:1668 */ ["NOT", [["DEFERRABLE"]]],
    /* py:1669 */ ["DEFERRABLE", []],
  ]);

  /** py: sqlglot/parser.py:1672 */
  static CREATE_SEQUENCE = new Map([
    /* py:1673 */ ["SCALE", ["EXTEND", "NOEXTEND"]],
    /* py:1674 */ ["SHARD", ["EXTEND", "NOEXTEND"]],
    /* py:1675 */ ["NO", ["CYCLE", "CACHE", "MAXVALUE", "MINVALUE"]],
    /* py:1678 */ ["SESSION", []],
    /* py:1679 */ ["GLOBAL", []],
    /* py:1680 */ ["KEEP", []],
    /* py:1681 */ ["NOKEEP", []],
    /* py:1682 */ ["ORDER", []],
    /* py:1683 */ ["NOORDER", []],
    /* py:1684 */ ["NOCACHE", []],
    /* py:1685 */ ["CYCLE", []],
    /* py:1686 */ ["NOCYCLE", []],
    /* py:1687 */ ["NOMINVALUE", []],
    /* py:1688 */ ["NOMAXVALUE", []],
    /* py:1689 */ ["NOSCALE", []],
    /* py:1690 */ ["NOSHARD", []],
  ]);

  /** py: sqlglot/parser.py:1696 */
  static ISOLATED_LOADING_OPTIONS = new Map([
    /* py:1696 */ ["FOR", ["ALL", "INSERT", "NONE"]],
  ]);

  /** py: sqlglot/parser.py:1698 */
  static USABLES = new Map([
    /* py:1699 */ ["ROLE", []],
    /* py:1699 */ ["WAREHOUSE", []],
    /* py:1699 */ ["DATABASE", []],
    /* py:1699 */ ["SCHEMA", []],
    /* py:1699 */ ["CATALOG", []],
  ]);

  /** py: sqlglot/parser.py:1702 */
  static CAST_ACTIONS = new Map([
    /* py:1702 */ ["RENAME", ["FIELDS"]],
    /* py:1702 */ ["ADD", ["FIELDS"]],
  ]);

  /** py: sqlglot/parser.py:1704 */
  static SCHEMA_BINDING_OPTIONS = new Map([
    /* py:1705 */ ["TYPE", ["EVOLUTION"]],
    /* py:1706 */ ["BINDING", []],
    /* py:1706 */ ["COMPENSATION", []],
    /* py:1706 */ ["EVOLUTION", []],
  ]);

  /** py: sqlglot/parser.py:1709 */
  static PROCEDURE_OPTIONS = new Map([
  ]);

  /** py: sqlglot/parser.py:1711 */
  static EXECUTE_AS_OPTIONS = new Map([
    /* py:1712 */ ["CALLER", []],
    /* py:1712 */ ["SELF", []],
    /* py:1712 */ ["OWNER", []],
  ]);

  /** py: sqlglot/parser.py:1715 */
  static KEY_CONSTRAINT_OPTIONS = new Map([
    /* py:1716 */ ["NOT", ["ENFORCED"]],
    /* py:1717 */ ["MATCH", ["FULL", "PARTIAL", "SIMPLE"]],
    /* py:1722 */ ["INITIALLY", ["DEFERRED", "IMMEDIATE"]],
    /* py:1723 */ ["USING", ["BTREE", "HASH"]],
    /* py:1727 */ ["DEFERRABLE", []],
    /* py:1727 */ ["NORELY", []],
    /* py:1727 */ ["RELY", []],
  ]);

  /** py: sqlglot/parser.py:1730 */
  static WINDOW_EXCLUDE_OPTIONS = new Map([
    /* py:1731 */ ["NO", ["OTHERS"]],
    /* py:1732 */ ["CURRENT", ["ROW"]],
    /* py:1733 */ ["GROUP", []],
    /* py:1733 */ ["TIES", []],
  ]);

  /** py: sqlglot/parser.py:1736 */
  static INSERT_ALTERNATIVES = new Set([
    /* py:1736 */ "ABORT",
    /* py:1736 */ "FAIL",
    /* py:1736 */ "IGNORE",
    /* py:1736 */ "REPLACE",
    /* py:1736 */ "ROLLBACK",
  ]);

  /** py: sqlglot/parser.py:1738 */
  static CLONE_KEYWORDS = new Set([
    /* py:1738 */ "CLONE",
    /* py:1738 */ "COPY",
  ]);

  /** py: sqlglot/parser.py:1740 */
  static VERSION_PHRASES = new Map([
    /* py:1741 */ [["FOR", "SYSTEM_TIME"], "TIMESTAMP"],
    /* py:1742 */ [["FOR", "SYSTEM", "TIME"], "TIMESTAMP"],
    /* py:1743 */ [["FOR", "TIMESTAMP"], "TIMESTAMP"],
    /* py:1744 */ [["FOR", "VERSION"], "VERSION"],
    /* py:1745 */ [["TIMESTAMP", "AS", "OF"], "TIMESTAMP"],
    /* py:1746 */ [["VERSION", "AS", "OF"], "VERSION"],
  ]);

  /** py: sqlglot/parser.py:1749 */
  static HISTORICAL_DATA_PREFIX = new Set([
    /* py:1749 */ "AT",
    /* py:1749 */ "BEFORE",
    /* py:1749 */ "END",
  ]);

  /** py: sqlglot/parser.py:1750 */
  static HISTORICAL_DATA_KIND = new Set([
    /* py:1750 */ "OFFSET",
    /* py:1750 */ "STATEMENT",
    /* py:1750 */ "STREAM",
    /* py:1750 */ "TIMESTAMP",
    /* py:1750 */ "VERSION",
  ]);

  /** py: sqlglot/parser.py:1752 */
  static OPCLASS_FOLLOW_KEYWORDS = new Set([
    /* py:1752 */ "ASC",
    /* py:1752 */ "DESC",
    /* py:1752 */ "NULLS",
    /* py:1752 */ "WITH",
  ]);

  /** py: sqlglot/parser.py:1754 */
  static OPTYPE_FOLLOW_TOKENS = new Set([
    /* py:1754 */ TokenType.COMMA,
    /* py:1754 */ TokenType.R_PAREN,
  ]);

  /** py: sqlglot/parser.py:1756 */
  static TABLE_INDEX_HINT_TOKENS = new Set([
    /* py:1756 */ TokenType.FORCE,
    /* py:1756 */ TokenType.IGNORE,
    /* py:1756 */ TokenType.USE,
  ]);

  /** py: sqlglot/parser.py:1758 */
  static VIEW_ATTRIBUTES = new Set([
    /* py:1758 */ "ENCRYPTION",
    /* py:1758 */ "SCHEMABINDING",
    /* py:1758 */ "VIEW_METADATA",
  ]);

  /** py: sqlglot/parser.py:1760 */
  static WINDOW_ALIAS_TOKENS = setDiff(
    this.ID_VAR_TOKENS,
    new Set([
      /* py:1760 */ TokenType.RANGE,
      /* py:1760 */ TokenType.ROWS,
    ]),
  );

  /** py: sqlglot/parser.py:1761 */
  static WINDOW_BEFORE_PAREN_TOKENS = new Set([
    /* py:1761 */ TokenType.OVER,
  ]);

  /** py: sqlglot/parser.py:1762 */
  static WINDOW_SIDES = new Set([
    /* py:1762 */ "FOLLOWING",
    /* py:1762 */ "PRECEDING",
  ]);

  /** py: sqlglot/parser.py:1764 */
  static JSON_KEY_VALUE_SEPARATOR_TOKENS = new Set([
    /* py:1764 */ TokenType.COLON,
    /* py:1764 */ TokenType.COMMA,
    /* py:1764 */ TokenType.IS,
  ]);

  /** py: sqlglot/parser.py:1766 */
  static FETCH_TOKENS = setDiff(
    this.ID_VAR_TOKENS,
    new Set([
      /* py:1766 */ TokenType.ROW,
      /* py:1766 */ TokenType.ROWS,
      /* py:1766 */ TokenType.PERCENT,
    ]),
  );

  /** py: sqlglot/parser.py:1768 */
  static ADD_CONSTRAINT_TOKENS = new Set([
    /* py:1769 */ TokenType.CONSTRAINT,
    /* py:1770 */ TokenType.FOREIGN_KEY,
    /* py:1771 */ TokenType.INDEX,
    /* py:1772 */ TokenType.KEY,
    /* py:1773 */ TokenType.PRIMARY_KEY,
    /* py:1774 */ TokenType.UNIQUE,
  ]);

  /** py: sqlglot/parser.py:1777 */
  static DISTINCT_TOKENS = new Set([
    /* py:1777 */ TokenType.DISTINCT,
  ]);

  /** py: sqlglot/parser.py:1779 */
  static UNNEST_OFFSET_ALIAS_TOKENS = setDiff(
    this.TABLE_ALIAS_TOKENS,
    this.SET_OPERATIONS,
  );

  /** py: sqlglot/parser.py:1781 */
  static SELECT_START_TOKENS = new Set([
    /* py:1781 */ TokenType.L_PAREN,
    /* py:1781 */ TokenType.WITH,
    /* py:1781 */ TokenType.SELECT,
  ]);

  /** py: sqlglot/parser.py:1783 */
  static COPY_INTO_VARLEN_OPTIONS = new Set([
    /* py:1784 */ "FILE_FORMAT",
    /* py:1785 */ "COPY_OPTIONS",
    /* py:1786 */ "FORMAT_OPTIONS",
    /* py:1787 */ "CREDENTIAL",
  ]);

  /** py: sqlglot/parser.py:1790 */
  static IS_JSON_PREDICATE_KIND = new Set([
    /* py:1790 */ "VALUE",
    /* py:1790 */ "SCALAR",
    /* py:1790 */ "ARRAY",
    /* py:1790 */ "OBJECT",
  ]);

  /** py: sqlglot/parser.py:1792 */
  static ODBC_DATETIME_LITERALS = new Map([
  ]);

  /** py: sqlglot/parser.py:1794 */
  static ON_CONDITION_TOKENS = new Set([
    /* py:1794 */ "ERROR",
    /* py:1794 */ "NULL",
    /* py:1794 */ "TRUE",
    /* py:1794 */ "FALSE",
    /* py:1794 */ "EMPTY",
  ]);

  /** py: sqlglot/parser.py:1796 */
  static PRIVILEGE_FOLLOW_TOKENS = new Set([
    /* py:1796 */ TokenType.ON,
    /* py:1796 */ TokenType.COMMA,
    /* py:1796 */ TokenType.L_PAREN,
  ]);

  /** py: sqlglot/parser.py:1799 */
  static DESCRIBE_STYLES = new Set([
    /* py:1799 */ "ANALYZE",
    /* py:1799 */ "EXTENDED",
    /* py:1799 */ "FORMATTED",
    /* py:1799 */ "HISTORY",
  ]);

  /** py: sqlglot/parser.py:1801 */
  static SET_ASSIGNMENT_DELIMITERS = new Set([
    /* py:1801 */ "=",
    /* py:1801 */ ":=",
    /* py:1801 */ "TO",
  ]);

  /** py: sqlglot/parser.py:1804 */
  static ANALYZE_STYLES = new Set([
    /* py:1805 */ "BUFFER_USAGE_LIMIT",
    /* py:1806 */ "FULL",
    /* py:1807 */ "LOCAL",
    /* py:1808 */ "NO_WRITE_TO_BINLOG",
    /* py:1809 */ "SAMPLE",
    /* py:1810 */ "SKIP_LOCKED",
    /* py:1811 */ "VERBOSE",
  ]);

  /** py: sqlglot/parser.py:1814 */
  static ANALYZE_EXPRESSION_PARSERS = new Map([
    // py:1815  ["ALL", /* TODO lambda */],
    // py:1816  ["COMPUTE", /* TODO lambda */],
    // py:1817  ["DELETE", /* TODO lambda */],
    // py:1818  ["DROP", /* TODO lambda */],
    // py:1819  ["ESTIMATE", /* TODO lambda */],
    // py:1820  ["LIST", /* TODO lambda */],
    // py:1821  ["PREDICATE", /* TODO lambda */],
    // py:1822  ["UPDATE", /* TODO lambda */],
    // py:1823  ["VALIDATE", /* TODO lambda */],
  ]);

  /** py: sqlglot/parser.py:1826 */
  static PARTITION_KEYWORDS = new Set([
    /* py:1826 */ "PARTITION",
    /* py:1826 */ "SUBPARTITION",
  ]);

  /** py: sqlglot/parser.py:1828 */
  // note: upstream is a tuple, which the seeder default-maps to a JS Array, but this
  // one is consumed by `_match_set` (parser.py:5828), which calls `.has()` -- Set
  // required, not Array. Confirmed the only one of the 3 Array-seeded tables actually
  // consumed this way (PR #8's claim-overlap audit, 2026-08-28); fixed at the site
  // rather than generalizing the seeder's tuple-vs-set heuristic from one instance.
  static AMBIGUOUS_ALIAS_TOKENS = new Set([
    /* py:1828 */ TokenType.LIMIT,
    /* py:1828 */ TokenType.OFFSET,
  ]);

  /** py: sqlglot/parser.py:1830 */
  static OPERATION_MODIFIERS = new Set([
  ]);

  /** py: sqlglot/parser.py:1832 */
  static RECURSIVE_CTE_SEARCH_KIND = new Set([
    /* py:1832 */ "BREADTH",
    /* py:1832 */ "DEPTH",
    /* py:1832 */ "CYCLE",
  ]);

  /** py: sqlglot/parser.py:1834 */
  static SECURITY_PROPERTY_KEYWORDS = new Set([
    /* py:1834 */ "DEFINER",
    /* py:1834 */ "INVOKER",
    /* py:1834 */ "NONE",
  ]);

  /** py: sqlglot/parser.py:1836 */
  static MODIFIABLES = [
    /* py:1836 */ exp.Query,
    /* py:1836 */ exp.Table,
    /* py:1836 */ exp.TableFromRows,
    /* py:1836 */ exp.Values,
  ];

  /** py: sqlglot/parser.py:1838 */
  static STRICT_CAST = true;

  /** py: sqlglot/parser.py:1840 */
  static PREFIXED_PIVOT_COLUMNS = false;

  /** py: sqlglot/parser.py:1841 */
  static IDENTIFY_PIVOT_STRINGS = false;

  /** py: sqlglot/parser.py:1843 */
  static UNPIVOT_VALUE_COLUMNS_FIRST = false;

  /** py: sqlglot/parser.py:1848 */
  static PIVOT_COLUMN_NAMING = "agg_name_if_aliased";

  /** py: sqlglot/parser.py:1850 */
  static LOG_DEFAULTS_TO_LN = false;

  /** py: sqlglot/parser.py:1853 */
  static TABLESAMPLE_CSV = false;

  /** py: sqlglot/parser.py:1856 */
  static DEFAULT_SAMPLING_METHOD = null;

  /** py: sqlglot/parser.py:1859 */
  static SET_REQUIRES_ASSIGNMENT_DELIMITER = true;

  /** py: sqlglot/parser.py:1862 */
  static TRIM_PATTERN_FIRST = false;

  /** py: sqlglot/parser.py:1865 */
  static STRING_ALIASES = false;

  /** py: sqlglot/parser.py:1868 */
  static MODIFIERS_ATTACHED_TO_SET_OP = true;

  /** py: sqlglot/parser.py:1869 */
  static SET_OP_MODIFIERS = new Set([
    /* py:1869 */ "order",
    /* py:1869 */ "limit",
    /* py:1869 */ "offset",
  ]);

  /** py: sqlglot/parser.py:1872 */
  static NO_PAREN_IF_COMMANDS = true;

  /** py: sqlglot/parser.py:1875 */
  static JSON_ARROWS_REQUIRE_JSON_TYPE = false;

  /** py: sqlglot/parser.py:1878 */
  static COLON_IS_VARIANT_EXTRACT = false;

  /** py: sqlglot/parser.py:1882 */
  static COLON_CHAIN_IS_SINGLE_EXTRACT = true;

  /** py: sqlglot/parser.py:1886 */
  static VALUES_FOLLOWED_BY_PAREN = true;

  /** py: sqlglot/parser.py:1889 */
  static SUPPORTS_IMPLICIT_UNNEST = false;

  /** py: sqlglot/parser.py:1892 */
  static SUPPORTS_DIGIT_PREFIXED_FIELD_NAMES = false;

  /** py: sqlglot/parser.py:1895 */
  static INTERVAL_SPANS = true;

  /** py: sqlglot/parser.py:1898 */
  static SUPPORTS_PARTITION_SELECTION = false;

  /** py: sqlglot/parser.py:1901 */
  static WRAPPED_TRANSFORM_COLUMN_CONSTRAINT = true;

  /** py: sqlglot/parser.py:1904 */
  static OPTIONAL_ALIAS_TOKEN_CTE = true;

  /** py: sqlglot/parser.py:1907 */
  static ALTER_RENAME_REQUIRES_COLUMN = true;

  /** py: sqlglot/parser.py:1910 */
  static ALTER_TABLE_PARTITIONS = false;

  /** py: sqlglot/parser.py:1916 */
  static JOINS_HAVE_EQUAL_PRECEDENCE = false;

  /** py: sqlglot/parser.py:1919 */
  static ZONE_AWARE_TIMESTAMP_CONSTRUCTOR = false;

  /** py: sqlglot/parser.py:1924 */
  static MAP_KEYS_ARE_ARBITRARY_EXPRESSIONS = false;

  /** py: sqlglot/parser.py:1928 */
  static JSON_EXTRACT_REQUIRES_JSON_EXPRESSION = false;

  /** py: sqlglot/parser.py:1932 */
  static ADD_JOIN_ON_TRUE = false;

  /** py: sqlglot/parser.py:1936 */
  static SUPPORTS_OMITTED_INTERVAL_SPAN_UNIT = false;

  /** py: sqlglot/parser.py:1940 */
  static ADJACENT_STRINGS_CANNOT_BE_CONNECTED = false;

  /** py: sqlglot/parser.py:1944 */
  static SUPPORTS_NTH_VALUE_FROM_MODIFIER = false;

  /** py: sqlglot/parser.py:1946 */
  static SHOW_TRIE = newTrie([...this.SHOW_PARSERS.keys()].map((key) => key.split(" ")));

  /** py: sqlglot/parser.py:1947 */
  static SET_TRIE = newTrie([...this.SET_PARSERS.keys()].map((key) => key.split(" ")));

  /**
   * py: sqlglot/parser.py:1949 `__init__`
   *
   * A JS constructor cannot be named `__init__`, so the seeded stub becomes this.
   * The five parameters are keyword arguments upstream; they arrive as one trailing
   * options object, the same recorded deviation as `helper.csv` and
   * `TokenizerCore.__init__` (CONTRACTS.md §8).
   *
   * @param {{errorLevel?: string|null, errorMessageContext?: number,
   *          maxErrors?: number, maxNodes?: number, dialect?: unknown}} [options]
   */
  // py: sqlglot/parser.py:1949
  constructor(options = {}) {
    const {
      errorLevel = null,
      errorMessageContext = 100,
      maxErrors = 3,
      maxNodes = -1,
      dialect = null,
    } = options;
    // py: `error_level or ErrorLevel.IMMEDIATE` — an explicit IGNORE is a non-empty
    // string and therefore truthy, so it survives; only null/undefined defaults.
    this.error_level = errorLevel || ErrorLevel.IMMEDIATE;
    this.error_message_context = errorMessageContext;
    this.max_errors = maxErrors;
    this.max_nodes = maxNodes;
    this.dialect = _resolveDialect(dialect);
    this.reset();
  }

  /** py: sqlglot/parser.py:1976 */
  // py: sqlglot/parser.py:1976
  reset() {
    this.sql = "";
    // The code-point array of `sql`, per CONTRACTS.md §2. `raise_error` and
    // `_find_sql` slice THIS, never the JS string, so error columns and highlight
    // ranges stay correct under astral characters (§4.6 "Indexing").
    this.sqlCodePoints = [];
    this.errors = [];
    this._tokens = [];
    this._tokens_size = 0;
    this._index = 0;
    this._curr = SENTINEL_NONE;
    this._next = SENTINEL_NONE;
    this._prev = SENTINEL_NONE;
    this._prev_comments = [];
    this._pipe_cte_counter = 0;
    this._chunks = [];
    this._chunk_index = 0;
    this._node_count = 0;
  }

  /** py: sqlglot/parser.py:1991 */
  // py: sqlglot/parser.py:1991
  _advance(times = 1) {
    const index = this._index + times;
    this._index = index;
    const tokens = this._tokens;
    const size = this._tokens_size;
    this._curr = index < size ? tokens[index] : SENTINEL_NONE;
    this._next = index + 1 < size ? tokens[index + 1] : SENTINEL_NONE;

    if (index > 0) {
      const prev = tokens[index - 1];
      this._prev = prev;
      this._prev_comments = prev.comments;
    } else {
      // py: index <= 0. `_advance_chunk` sets `_index = -1` then advances by 1, so
      // index 0 lands here and `_prev` is correctly the sentinel, not `tokens[-1]` —
      // which in Python would be the LAST token. A JS `tokens[-1]` is undefined, so a
      // literal transliteration of `tokens[index - 1]` would crash rather than differ.
      this._prev = SENTINEL_NONE;
      this._prev_comments = [];
    }
  }

  /** py: sqlglot/parser.py:2007 */
  // py: sqlglot/parser.py:2007
  _advance_chunk() {
    this._index = -1;
    this._tokens = this._chunks[this._chunk_index];
    this._tokens_size = this._tokens.length;
    this._chunk_index += 1;
    this._advance();
  }

  /** py: sqlglot/parser.py:2014 */
  // py: sqlglot/parser.py:2014
  _retreat(index) {
    if (index !== this._index) this._advance(index - this._index);
  }

  /** py: sqlglot/parser.py:2018 */
  // py: sqlglot/parser.py:2018
  _add_comments(expression) {
    // py: `if expression and self._prev_comments` — an Expr is always truthy in
    // Python, so only null/undefined is excluded; an EMPTY comment list is falsy and
    // must not clear `_prev_comments`.
    if (expression && this._prev_comments.length) {
      expression.addComments(this._prev_comments);
      this._prev_comments = [];
    }
  }

  /** py: sqlglot/parser.py:2023 */
  // py: sqlglot/parser.py:2023
  _match(token_type, advance = true, expression = null) {
    if (this._curr.token_type === token_type) {
      if (advance) this._advance();
      this._add_comments(expression);
      return true;
    }
    return false;
  }

  /** py: sqlglot/parser.py:2033 */
  // py: sqlglot/parser.py:2033
  _match_set(types, advance = true) {
    if (types.has(this._curr.token_type)) {
      if (advance) this._advance();
      return true;
    }
    return false;
  }

  /** py: sqlglot/parser.py:2040 */
  // py: sqlglot/parser.py:2040
  _match_pair(token_type_a, token_type_b, advance = true) {
    if (this._curr.token_type === token_type_a && this._next.token_type === token_type_b) {
      if (advance) this._advance(2);
      return true;
    }
    return false;
  }

  /** py: sqlglot/parser.py:2049 */
  // py: sqlglot/parser.py:2049
  _match_texts(texts, advance = true) {
    if (
      !this.constructor.TEXT_MATCH_EXCLUDED_TOKENS.has(this._curr.token_type)
      && _textIn(texts, pyUpper(this._curr.text))
    ) {
      if (advance) this._advance();
      return true;
    }
    return false;
  }

  /**
   * py: sqlglot/parser.py:2059 `_match_text_seq(*texts, advance=True)`
   *
   * `advance` is keyword-only upstream and follows a var-args list, so it arrives here
   * as an options object in the final position: `_match_text_seq("A", "B", {advance:
   * false})`. Passing it positionally would make it the next TEXT to match.
   */
  // py: sqlglot/parser.py:2059
  _match_text_seq(...texts) {
    let advance = true;
    if (texts.length && typeof texts[texts.length - 1] === "object" && texts[texts.length - 1] !== null) {
      advance = texts.pop().advance ?? true;
    }
    const index = this._index;
    const excludedTokens = this.constructor.TEXT_MATCH_EXCLUDED_TOKENS;
    for (const text of texts) {
      if (!excludedTokens.has(this._curr.token_type) && pyUpper(this._curr.text) === text) {
        this._advance();
      } else {
        this._retreat(index);
        return false;
      }
    }

    if (!advance) this._retreat(index);

    return true;
  }

  /** py: sqlglot/parser.py:2074 */
  // py: sqlglot/parser.py:2074
  _is_connected() {
    const prev = this._prev;
    const curr = this._curr;
    // py: `bool(prev and curr and ...)` — Token.__bool__, so a SENTINEL is falsy.
    return prev.bool() && curr.bool() && prev.end + 1 === curr.start;
  }

  /** py: sqlglot/parser.py:2079 */
  // py: sqlglot/parser.py:2079
  _find_sql(start, end) {
    // py: `self.sql[start.start : end.end + 1]` — Token offsets are CODE POINTS
    // (CONTRACTS.md §2), so this slices the code-point array. `String.slice` would cut
    // a surrogate pair in half whenever the SQL contains an astral character.
    return this.sqlCodePoints.slice(start.start, end.end + 1).join("");
  }

  /** py: sqlglot/parser.py:2082 */
  // py: sqlglot/parser.py:2082
  raise_error(message, token = SENTINEL_NONE) {
    // py: `token or self._curr or self._prev or Token.string("")` — Token.__bool__
    // again: each arm falls through when its token is the SENTINEL.
    let tok = token;
    if (!tok.bool()) tok = this._curr;
    if (!tok.bool()) tok = this._prev;
    if (!tok.bool()) tok = Token.string("");

    const [formattedSql, startContext, highlight, endContext] = highlightSql(
      this.sql,
      [[tok.start, tok.end]],
      this.error_message_context,
    );
    const formattedMessage =
      `${message}. Line ${tok.line}, Col: ${tok.col}.\n  ${formattedSql}`;

    const error = ParseError.new(formattedMessage, {
      description: message,
      line: tok.line,
      col: tok.col,
      start_context: startContext,
      highlight,
      end_context: endContext,
    });

    if (this.error_level === ErrorLevel.IMMEDIATE) throw error;

    this.errors.push(error);
  }

  /** py: sqlglot/parser.py:2106 */
  // py: sqlglot/parser.py:2106
  validate_expression(expression, args = null) {
    if (this.max_nodes > -1) {
      this._node_count += 1;
      if (this._node_count > this.max_nodes) {
        this.raise_error(`Maximum number of AST nodes (${this.max_nodes}) exceeded`);
      }
    }
    if (this.error_level !== ErrorLevel.IGNORE) {
      for (const errorMessage of expression.errorMessages(args)) this.raise_error(errorMessage);
    }
    return expression;
  }

  /**
   * py: sqlglot/parser.py:2116 `_try_parse(parse_method, retreat=False)`
   *
   * The backtracking primitive. Three things have to happen in the right order, and
   * the `finally` is what makes them safe:
   *   1. `error_level` is forced to IMMEDIATE so a nested failure RAISES here instead
   *      of accumulating into `self.errors` — a speculative parse must not leave
   *      errors behind when it is abandoned.
   *   2. On failure (or when `retreat`), the cursor rewinds to where it started.
   *   3. `error_level` is always restored, including on a non-ParseError throw.
   */
  // py: sqlglot/parser.py:2116
  _try_parse(parse_method, retreat = false) {
    const index = this._index;
    const errorLevel = this.error_level;
    let self = null;

    this.error_level = ErrorLevel.IMMEDIATE;
    try {
      self = parse_method();
    } catch (e) {
      // py: `except ParseError` — narrow ON PURPOSE. A TokenError or any other
      // exception propagates; swallowing everything here would turn real defects into
      // silent "this production did not match".
      if (!(e instanceof ParseError)) {
        this._retreat(index);
        this.error_level = errorLevel;
        throw e;
      }
      self = null;
    }
    // py: `if not this or retreat` — `not this` is PYTHON falsiness, which is not JS
    // falsiness for containers. An earlier version of this line asserted that
    // `_parse_*` callables "return None or an Expr, never 0/''/[]"; that is false.
    // `_try_parse` takes an arbitrary callable, and `parser.py:10382` passes
    // `lambda: self._parse_csv(self._parse_declareitem)` — `_parse_csv`
    // (`parser.py:8918`) is typed `-> list[T]` and returns `[]` when nothing parses.
    // `not []` is True in Python; `![]` is `false` in JS, so the port did NOT retreat
    // and left the cursor advanced. `_parse_declare` then calls `_parse_as_command(start)`,
    // which quotes the SQL from the (now wrong) cursor — and that string is one of the
    // byte-exact `check_command_warning` lines this phase gates on.
    //
    // Fixed at the semantics, not at the example: `pyTruthy` implements the whole
    // protocol, so the next callable to return `{}`, `""`, `0` or an ExprSet is right
    // too. Enumerated the call sites rather than trusting the shape — base parser.py
    // has 10 (2691, 4629, 4659, 5440, 5772, 5833, 5834, 9343, 10064, 10382), of which
    // only 10382 is non-Expr today; dialects add 4 more (postgres x2, clickhouse,
    // oracle), all Expr-or-None.
    if (pyFalsy(self) || retreat) this._retreat(index);
    this.error_level = errorLevel;

    return self;
  }

  /**
   * py: sqlglot/parser.py:2133 — parse tokens into one syntax tree per statement.
   *
   * @param {Token[]} rawTokens
   * @param {string} sql the original SQL, used for error context
   * @returns {Array<object|null>}
   */
  // py: sqlglot/parser.py:2133
  parse(rawTokens, sql) {
    return this._parse(
      (self) => self._parse_statement(),
      rawTokens,
      sql,
    );
  }

  /** py: sqlglot/parser.py:2149 */
  // py: sqlglot/parser.py:2149
  parse_into(expression_types, rawTokens, sql = null) {
    const errors = [];
    for (const expressionType of ensureList(expression_types)) {
      const parser = this.constructor.EXPRESSION_PARSERS.get(expressionType);
      if (!parser) throw new PyTypeError(`No parser registered for ${expressionType?.name ?? expressionType}`);

      try {
        return this._parse(parser, rawTokens, sql);
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        e.errors[0].into_expression = expressionType;
        errors.push(e);
      }
    }

    throw new ParseError(
      `Failed to parse '${sql || rawTokens}' into ${expression_types}`,
      mergeErrors(errors),
    );
  }

  /** py: sqlglot/parser.py:2185 — log or raise, per the chosen error level. */
  // py: sqlglot/parser.py:2185
  check_errors() {
    if (this.error_level === ErrorLevel.WARN) {
      for (const error of this.errors) logger.error(String(error.message));
    } else if (this.error_level === ErrorLevel.RAISE && this.errors.length) {
      throw new ParseError(
        concatMessages(this.errors.map((e) => e.message), this.max_errors),
        mergeErrors(this.errors),
      );
    }
  }

  /** py: sqlglot/parser.py:2196 */
  // py: sqlglot/parser.py:2196
  expression(instance, token = null, comments = null) {
    // py: `if token:` — Token.__bool__, so a SENTINEL does not set positions.
    if (token && token.bool?.() !== false) instance.updatePositions(token);
    // py: `instance.add_comments(comments) if comments else self._add_comments(instance)`
    // — an EMPTY list is falsy, so `comments=[]` takes the `_add_comments` branch.
    if (comments && comments.length) instance.addComments(comments);
    else this._add_comments(instance);
    if (!instance.constructor.isPrimitive) instance = this.validate_expression(instance);
    return instance;
  }

  /** py: sqlglot/parser.py:2209 */
  // py: sqlglot/parser.py:2209
  _parse_batch_statements(parse_method, sep_first_statement = true) {
    const expressions = [];

    // py: chunkification binds if/while statements with the first statement of the body
    if (sep_first_statement) {
      this._match(TokenType.BEGIN);
      expressions.push(parse_method(this));
    }

    const chunksLength = this._chunks.length;
    while (this._chunk_index < chunksLength) {
      this._advance_chunk();

      if (this._match(TokenType.ELSE, false)) return expressions;

      // py: `if expressions and not self._next and self._match(TokenType.END)` —
      // `not self._next` is Token.__bool__ on the SENTINEL, i.e. "no token after this
      // one", NOT "_next is null".
      if (expressions.length && !this._next.bool() && this._match(TokenType.END)) {
        expressions.push(new exp.EndStatement());
        continue;
      }

      expressions.push(parse_method(this));

      if (this._index < this._tokens_size) {
        this.raise_error("Invalid expression / Unexpected token");
      }

      this.check_errors();
    }

    return expressions;
  }

  /** py: sqlglot/parser.py:2241 — reset, chunk on semicolons, then parse each chunk. */
  // py: sqlglot/parser.py:2241
  _parse(parse_method, rawTokens, sql = null) {
    this.reset();
    this.sql = sql || "";
    this.sqlCodePoints = [...this.sql];

    const total = rawTokens.length;
    /** @type {Token[][]} */
    const chunks = [[]];

    for (let i = 0; i < total; i++) {
      const token = rawTokens[i];
      if (token.token_type === TokenType.SEMICOLON) {
        // A semicolon carrying comments becomes its OWN chunk so the comments survive;
        // it is not appended to the statement it terminates.
        if (token.comments.length) chunks.push([token]);

        // No trailing empty chunk for a statement-final semicolon — that is what keeps
        // `parse("SELECT 1;")` one statement rather than two.
        if (i < total - 1) chunks.push([]);
      } else {
        chunks[chunks.length - 1].push(token);
      }
    }

    this._chunks = chunks;

    return this._parse_batch_statements(parse_method, false);
  }

  /** py: sqlglot/parser.py:2267 */
  // py: sqlglot/parser.py:2267
  _warn_unsupported() {
    if (this._tokens_size <= 1) return;

    // py: `_find_sql` because `self.sql` may span several chunks and only the chunk
    // being processed should be quoted. The `[:error_message_context]` truncation is
    // a CODE-POINT slice, and it is asserted byte-exact by 18 `check_command_warning`
    // call sites across the dialect suites — hence `error_message_context`, never a
    // hardcoded 100.
    const found = this._find_sql(this._tokens[0], this._tokens[this._tokens.length - 1]);
    const sql = [...found].slice(0, this.error_message_context).join("");

    logger.warning(`'${sql}' contains unsupported syntax. Falling back to parsing as a 'Command'.`);
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:2279
  _parse_command() {
    this._warn_unsupported();
    const comments = this._prev_comments;
    return this.expression(
      new exp.Command({ this: pyUpper(this._prev.text), expression: this._parse_string() }),
      null,
      comments,
    );
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:2287
  _parse_comment(allow_exists) { throw new NotPorted("_parse_comment", "sqlglot/parser.py:2287"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:2319
  _parse_to_table() { throw new NotPorted("_parse_to_table", "sqlglot/parser.py:2319"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:2326
  _parse_ttl() { const action = () => { const this_ = this._parse_bitwise(); if (this._match_text_seq("DELETE")) return this.expression(new exp.MergeTreeTTLAction({ this: this_, delete: true })); if (this._match_text_seq("RECOMPRESS")) return this.expression(new exp.MergeTreeTTLAction({ this: this_, recompress: this._parse_bitwise() })); if (this._match_text_seq("TO", "DISK")) return this.expression(new exp.MergeTreeTTLAction({ this: this_, to_disk: this._parse_string() })); if (this._match_text_seq("TO", "VOLUME")) return this.expression(new exp.MergeTreeTTLAction({ this: this_, to_volume: this._parse_string() })); return this_; }; const expressions = this._parse_csv(action), where = this._parse_where(), group = this._parse_group(); const aggregates = group && this._match(TokenType.SET) ? this._parse_csv(this._parse_set_item.bind(this)) : null; return this.expression(new exp.MergeTreeTTL({ expressions, where, group, aggregates })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:2361
  _parse_condition() { return this._parse_wrapped(this._parse_expression.bind(this), true); }

  /** @returns {*} */
  // py: sqlglot/parser.py:2364
  _parse_block() {
    return this.expression(new exp.Block({ expressions: this._parse_batch_statements((parser) => parser._parse_statement()) }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:2373
  _parse_whileblock() { throw new NotPorted("_parse_whileblock", "sqlglot/parser.py:2373"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:2378
  _parse_statement() {
    // py: `if not self._curr` — Token.__bool__, so an exhausted stream (SENTINEL) is
    // falsy. `!this._curr` would be false for the sentinel OBJECT and never return.
    if (!this._curr.bool()) return null;

    const cls = this.constructor;
    if (this._match_set(cls.STATEMENT_PARSERS)) {
      const comments = this._prev_comments;
      const stmt = cls.STATEMENT_PARSERS.get(this._prev.token_type)(this);
      stmt.addComments(comments, true);
      return stmt;
    }

    if (this._match_set(this.dialect.tokenizer_class.COMMANDS)) return this._parse_command();

    if (this._match_text_seq("WHILE")) return this._parse_whileblock();

    let expression = this._parse_expression();
    expression = expression ? this._parse_set_operations(expression) : this._parse_select();

    if (expression instanceof exp.Subquery && this._match(TokenType.PIPE_GT, false)) {
      expression = this._parse_pipe_syntax_query(expression);
    }

    return this._parse_query_modifiers(expression);
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:2402
  _parse_drop(exists = false) {
    const start = this._prev;
    const temporary = this._match(TokenType.TEMPORARY);
    const materialized = this._match_text_seq("MATERIALIZED");
    const iceberg = this._match_text_seq("ICEBERG");
    const kind = this._match_set(this.constructor.CREATABLES) ? this._prev.text.toUpperCase() : null;
    if (!kind || (iceberg && kind !== "TABLE")) return this._parse_as_command(start);
    const concurrently = this._match_text_seq("CONCURRENTLY");
    const ifExists = exists || this._parse_exists();
    let tables;
    if (kind === "COLUMN") tables = this._parse_column();
    else if (["TABLE", "VIEW"].includes(kind)) tables = this._parse_csv(() => this._parse_table_parts(true));
    else tables = this._parse_table_parts(true, kind === "SCHEMA");
    const cluster = this._match(TokenType.ON) ? this._parse_on_property() : null;
    const expressions = this._match(TokenType.L_PAREN, false) ? this._parse_wrapped_csv(() => this._parse_types()) : null;
    const cascadeOrRestrict = this._match_texts(["CASCADE", "RESTRICT"]) ? this._prev.text.toUpperCase() : null;
    return this.expression(new exp.Drop({ exists: ifExists, tables: ensureList(tables), expressions, kind: this.dialect.CREATABLE_KIND_MAPPING.get(kind) || kind, temporary, materialized, cascade: cascadeOrRestrict === "CASCADE", restrict: cascadeOrRestrict === "RESTRICT", constraints: this._match_text_seq("CONSTRAINTS"), purge: this._match_text_seq("PURGE"), cluster, concurrently, sync: this._match_text_seq("SYNC"), iceberg, force: this._match_text_seq("FORCE") }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:2452
  _parse_exists(not_ = false) {
    return this._match_text_seq("IF") && (!not_ || this._match(TokenType.NOT)) && this._match(TokenType.EXISTS);
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:2459
  _parse_create() {
    const start = this._prev;
    const replace = start.token_type === TokenType.REPLACE || this._match_pair(TokenType.OR, TokenType.REPLACE) || this._match_pair(TokenType.OR, TokenType.ALTER);
    const refresh = this._match_pair(TokenType.OR, TokenType.REFRESH);
    const unique = this._match(TokenType.UNIQUE);
    let clustered = null;
    if (this._match_text_seq("CLUSTERED", "COLUMNSTORE")) clustered = true;
    else if (this._match_text_seq("NONCLUSTERED", "COLUMNSTORE") || this._match_text_seq("COLUMNSTORE")) clustered = false;
    if (this._match_pair(TokenType.TABLE, TokenType.FUNCTION, false)) this._advance();
    let properties = null;
    let createToken = this._match_set(this.constructor.CREATABLES) ? this._prev : null;
    if (!createToken) {
      properties = this._parse_properties();
      createToken = this._match_set(this.constructor.CREATABLES) ? this._prev : null;
      if (!properties || !createToken) return this._parse_as_command(start);
    }
    const createTokenType = createToken.token_type;
    const concurrently = this._match_text_seq("CONCURRENTLY");
    const exists = this._parse_exists(true);
    let this_ = null, expression = null, indexes = null, noSchemaBinding = null, begin = null, clone = null;
    const extendProps = (more) => {
      if (properties && more) properties.expressions.push(...more.expressions);
      else if (more) properties = more;
    };
    if ([TokenType.FUNCTION, TokenType.PROCEDURE].includes(createTokenType)) {
      this_ = this._parse_user_defined_function(createTokenType);
      extendProps(this._parse_properties());
      expression = this._match(TokenType.ALIAS) ? this._parse_heredoc() : null;
      let isTable = false, overloadMode = false;
      if (!expression && createTokenType === TokenType.FUNCTION && this_ instanceof exp.UserDefinedFunction && this_.args.wrapped) {
        const preTableIndex = this._index;
        isTable = this._match(TokenType.TABLE);
        expression = this._parse_expression();
        overloadMode = !!(expression && this._curr.token_type === TokenType.COMMA && this._next.token_type === TokenType.L_PAREN);
        if (!overloadMode) {
          this._retreat(preTableIndex);
          isTable = false;
          expression = null;
        }
      }
      extendProps(this._parse_function_properties());
      if (!expression) {
        if (this._match(TokenType.COMMAND)) expression = this._parse_as_command(this._prev);
        else {
          begin = this._match(TokenType.BEGIN);
          const return_ = this._match_text_seq("RETURN");
          if (this._match(TokenType.STRING, false)) {
            expression = this._parse_string();
            extendProps(this._parse_properties());
          } else expression = createTokenType === TokenType.FUNCTION ? this._parse_user_defined_function_expression() : this._parse_block();
          if (return_) expression = this.expression(new exp.Return({ this: expression }));
        }
      }
      if (overloadMode && expression) expression = this._parse_macro_overloads(this_, expression, isTable);
    } else if (createTokenType === TokenType.INDEX) {
      let index = null, anonymous = true;
      if (!this._match(TokenType.ON)) {
        index = this._parse_id_var();
        anonymous = false;
      }
      this_ = this._parse_index(index, anonymous);
    } else if ((createTokenType === TokenType.CONSTRAINT && this._match(TokenType.TRIGGER)) || createTokenType === TokenType.TRIGGER) {
      const isConstraint = createTokenType === TokenType.CONSTRAINT;
      if (isConstraint) createToken = this._prev;
      const triggerName = this._parse_id_var();
      if (!triggerName) return this._parse_as_command(start);
      const timingVar = this._parse_var_from_options(this.constructor.TRIGGER_TIMING, false);
      const timing = timingVar ? timingVar.this : null;
      if (!timing) return this._parse_as_command(start);
      const events = this._parse_trigger_events();
      if (!this._match(TokenType.ON)) this.raise_error("Expected ON in trigger definition");
      const table = this._parse_table_parts();
      const referencedTable = this._match(TokenType.FROM) ? this._parse_table_parts() : null;
      const [deferrable, initially] = this._parse_trigger_deferrable();
      const referencing = this._parse_trigger_referencing();
      const forEach = this._parse_trigger_for_each();
      const when = this._match_text_seq("WHEN") && this._parse_wrapped(() => this._parse_disjunction(), true);
      const execute = this._parse_trigger_execute();
      if (execute == null) return this._parse_as_command(start);
      const triggerProps = this.expression(new exp.TriggerProperties({ table, timing, events, execute, constraint: isConstraint, referenced_table: referencedTable, deferrable, initially, referencing, for_each: forEach, when }));
      this_ = triggerName;
      extendProps(new exp.Properties({ expressions: triggerProps ? [triggerProps] : [] }));
    } else if (createTokenType === TokenType.TYPE) {
      this_ = this._parse_table_parts(true);
      if (!this_ || !this._match(TokenType.ALIAS)) return this._parse_as_command(start);
      if (this._match(TokenType.ENUM)) expression = new exp.DataType({ this: exp.DType.ENUM, expressions: this._parse_wrapped_csv(() => this._parse_string()) });
      else if (this._match(TokenType.L_PAREN, false)) expression = this._parse_schema();
      else return this._parse_as_command(start);
    } else if (this.constructor.DB_CREATABLES.has(createTokenType)) {
      const tableParts = this._parse_table_parts(true, createTokenType === TokenType.SCHEMA);
      this._match(TokenType.COMMA);
      extendProps(this._parse_properties(true));
      this_ = this._parse_schema(tableParts);
      extendProps(this._parse_properties());
      const hasAlias = this._match(TokenType.ALIAS);
      if (!this._match_set(this.constructor.DDL_SELECT_TOKENS, false)) extendProps(this._parse_properties());
      if (createTokenType === TokenType.SEQUENCE) {
        expression = this._parse_types();
        const props = this._parse_properties();
        if (props) {
          const sequenceProps = new exp.SequenceProperties();
          const options = [];
          for (const prop of [...props.expressions]) {
            if (prop instanceof exp.SequenceProperties) {
              for (const [arg, value] of Object.entries(prop.args)) {
                if (arg === "options") options.push(...value);
                else sequenceProps.set(arg, value);
              }
              prop.pop();
            }
          }
          if (options.length) sequenceProps.set("options", options);
          props.append("expressions", sequenceProps);
          extendProps(props);
        }
      } else {
        expression = this._parse_ddl_select();
        if (!expression && hasAlias) expression = this._try_parse(() => this._parse_table_parts());
      }
      if (createTokenType === TokenType.TABLE) {
        extendProps(this._parse_properties());
        indexes = [];
        while (true) {
          const index = this._parse_index();
          extendProps(this._parse_properties());
          if (!index) break;
          this._match(TokenType.COMMA);
          indexes.push(index);
        }
      } else if (createTokenType === TokenType.VIEW && this._match_text_seq("WITH", "NO", "SCHEMA", "BINDING")) noSchemaBinding = true;
      else if ([TokenType.SINK, TokenType.SOURCE].includes(createTokenType)) extendProps(this._parse_properties());
      const shallow = this._match_text_seq("SHALLOW");
      if (this._match_texts(this.constructor.CLONE_KEYWORDS)) {
        const copy = this._prev.text.toLowerCase() === "copy";
        clone = this.expression(new exp.Clone({ this: this._parse_table(true), shallow, copy }));
      }
    }
    if (this._curr.bool() && !this._match_set(new Set([TokenType.R_PAREN, TokenType.COMMA]), false)) return this._parse_as_command(start);
    const createKindText = createToken.text.toUpperCase();
    return this.expression(new exp.Create({ this: this_, kind: this.dialect.CREATABLE_KIND_MAPPING.get(createKindText) || createKindText, replace, refresh, unique, expression, exists, properties, indexes, no_schema_binding: noSchemaBinding, begin, clone, concurrently, clustered }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:2745
  _parse_sequence_properties() { throw new NotPorted("_parse_sequence_properties", "sqlglot/parser.py:2745"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:2781
  _parse_trigger_events() { const events = []; while (true) { const eventType = this._match_set(this.TRIGGER_EVENTS) && pyUpper(this._prev.text); if (!eventType) this.raise_error("Expected trigger event (INSERT, UPDATE, DELETE, TRUNCATE)"); const columns = eventType === "UPDATE" && this._match_text_seq("OF") ? this._parse_csv(() => this._parse_column()) : null; events.push(this.expression(new exp.TriggerEvent({ this: eventType, columns }))); if (!this._match(TokenType.OR)) break; } return events; }

  /** @returns {*} */
  // py: sqlglot/parser.py:2803
  _parse_trigger_deferrable() { const variable = this._parse_var_from_options(this.TRIGGER_DEFERRABLE, false); const deferrable = variable ? variable.this : null; let initially = null; if (deferrable && this._match_text_seq("INITIALLY")) initially = this._match_texts(["IMMEDIATE", "DEFERRED"]) ? pyUpper(this._prev.text) : null; return [deferrable, initially]; }

  /** @returns {*} */
  // py: sqlglot/parser.py:2819
  _parse_trigger_referencing_clause(keyword) {
    if (!this._match_text_seq(keyword)) return null;
    if (!this._match_text_seq("TABLE")) this.raise_error(`Expected TABLE after ${keyword} in REFERENCING clause`);
    this._match_text_seq("AS");
    return this._parse_id_var();
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:2827
  _parse_trigger_referencing() { if (!this._match_text_seq("REFERENCING")) return null; let oldAlias = null, newAlias = null; while (true) { let alias = this._parse_trigger_referencing_clause("OLD"); if (alias) { if (oldAlias !== null) this.raise_error("Duplicate OLD clause in REFERENCING"); oldAlias = alias; continue; } alias = this._parse_trigger_referencing_clause("NEW"); if (alias) { if (newAlias !== null) this.raise_error("Duplicate NEW clause in REFERENCING"); newAlias = alias; continue; } break; } if (oldAlias === null && newAlias === null) this.raise_error("REFERENCING clause requires at least OLD TABLE or NEW TABLE"); return this.expression(new exp.TriggerReferencing({ old: oldAlias, new: newAlias })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:2851
  _parse_trigger_for_each() { if (!this._match_text_seq("FOR", "EACH")) return null; return this._match_texts(["ROW", "STATEMENT"]) ? pyUpper(this._prev.text) : null; }

  /** @returns {*} */
  // py: sqlglot/parser.py:2857
  _parse_trigger_execute() { if (!this._match(TokenType.EXECUTE)) return null; if (!this._match_set(new Set([TokenType.FUNCTION, TokenType.PROCEDURE]))) this.raise_error("Expected FUNCTION or PROCEDURE after EXECUTE"); return this.expression(new exp.TriggerExecute({ this: this._parse_column() })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:2867
  _parse_property_before() { throw new NotPorted("_parse_property_before", "sqlglot/parser.py:2867"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:2895
  _parse_wrapped_properties() { throw new NotPorted("_parse_wrapped_properties", "sqlglot/parser.py:2895"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:2898
  _parse_property() { throw new NotPorted("_parse_property", "sqlglot/parser.py:2898"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:2927
  _parse_key_value_property(parse_value) { throw new NotPorted("_parse_key_value_property", "sqlglot/parser.py:2927"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:2953
  _parse_stored() { if (this._match_text_seq("BY")) return this.expression(new exp.StorageHandlerProperty({ this: this._parse_var_or_string() })); this._match(TokenType.ALIAS); const input_format = this._match_text_seq("INPUTFORMAT") ? this._parse_string() : null; const output_format = this._match_text_seq("OUTPUTFORMAT") ? this._parse_string() : null; const this_ = input_format || output_format ? this.expression(new exp.InputOutputFormat({ input_format, output_format })) : (this._parse_var_or_string() || this._parse_number() || this._parse_id_var()); return this.expression(new exp.FileFormatProperty({ this: this_, hive_format: true })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:2976
  _parse_unquoted_field() { throw new NotPorted("_parse_unquoted_field", "sqlglot/parser.py:2976"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:2983
  _parse_property_assignment(exp_class) { throw new NotPorted("_parse_property_assignment", "sqlglot/parser.py:2983"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:2989
  _parse_properties(before) { throw new NotPorted("_parse_properties", "sqlglot/parser.py:2989"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3006
  _parse_fallback(no) { throw new NotPorted("_parse_fallback", "sqlglot/parser.py:3006"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3011
  _parse_sql_security() {
    const definer = this._match_text_seq("DEFINER"); if (!definer) this._match_text_seq("INVOKER");
    return this.expression(new exp.SqlSecurityProperty({ definer }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:3018
  _parse_settings_property() { throw new NotPorted("_parse_settings_property", "sqlglot/parser.py:3018"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3023
  _parse_called_on_null_input_property() { throw new NotPorted("_parse_called_on_null_input_property", "sqlglot/parser.py:3023"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3030
  _parse_volatile_property() { throw new NotPorted("_parse_volatile_property", "sqlglot/parser.py:3030"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3041
  _parse_retention_period() {
    const number = this._parse_number();
    // deny:implicit_str sqlglot/parser.py:3044
    const number_str = number ? `${kernelSql(number)} ` : "";
    const unit = this._parse_var(true);
    // deny:implicit_str sqlglot/parser.py:3046
    return exp.var(`${number_str}${kernelSql(unit)}`);
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:3048
  _parse_system_versioning_property(with_) { throw new NotPorted("_parse_system_versioning_property", "sqlglot/parser.py:3048"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3072
  _parse_data_deletion_property() { throw new NotPorted("_parse_data_deletion_property", "sqlglot/parser.py:3072"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3088
  _parse_distributed_property() { throw new NotPorted("_parse_distributed_property", "sqlglot/parser.py:3088"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3107
  _parse_composite_key_property(expr_type) { throw new NotPorted("_parse_composite_key_property", "sqlglot/parser.py:3107"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3112
  _parse_with_property() {
    if (this._match_text_seq("(", "SYSTEM_VERSIONING")) {
      const prop = this._parse_system_versioning_property(true);
      this._match_r_paren();
      return prop;
    }
    if (this._match(TokenType.L_PAREN, false)) {
      const result = [];
      for (const item of this._parse_wrapped_properties()) Array.isArray(item) ? result.push(...item) : result.push(item);
      return result;
    }
    if (this._match_text_seq("JOURNAL")) return this._parse_withjournaltable();
    if (this._match_texts(this.constructor.VIEW_ATTRIBUTES)) {
      return this.expression(new exp.ViewAttributeProperty({ this: pyUpper(this._prev.text) }));
    }
    if (this._match_text_seq("DATA")) return this._parse_withdata(false);
    if (this._match_text_seq("NO", "DATA")) return this._parse_withdata(true);
    if (this._match(TokenType.SERDE_PROPERTIES, false)) return this._parse_serde_properties(true);
    if (this._match(TokenType.SCHEMA)) return this.expression(new exp.WithSchemaBindingProperty({ this: this._parse_var_from_options(this.constructor.SCHEMA_BINDING_OPTIONS) }));
    if (this._match_texts(this.constructor.PROCEDURE_OPTIONS, false)) {
      return this.expression(new exp.WithProcedureOptions({ expressions: this._parse_csv(() => this._parse_procedure_option()) }));
    }
    if (!this._next.bool()) return null;
    return this._parse_withisolatedloading();
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:3155
  _parse_procedure_option() { throw new NotPorted("_parse_procedure_option", "sqlglot/parser.py:3155"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3169
  _parse_definer() { throw new NotPorted("_parse_definer", "sqlglot/parser.py:3169"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3181
  _parse_withjournaltable() { throw new NotPorted("_parse_withjournaltable", "sqlglot/parser.py:3181"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3186
  _parse_log(no) { throw new NotPorted("_parse_log", "sqlglot/parser.py:3186"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3189
  _parse_journal() { throw new NotPorted("_parse_journal", "sqlglot/parser.py:3189"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3192
  _parse_checksum() { throw new NotPorted("_parse_checksum", "sqlglot/parser.py:3192"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3203
  _parse_cluster() { throw new NotPorted("_parse_cluster", "sqlglot/parser.py:3203"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3211
  _parse_cluster_property() { throw new NotPorted("_parse_cluster_property", "sqlglot/parser.py:3211"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3218
  _parse_clustered_by() {
    const expressions = this._parse_wrapped_csv(this._parse_column.bind(this)); let sorted_by = null, buckets = null;
    if (this._match_text_seq("SORTED", "BY")) sorted_by = this._parse_wrapped_csv(this._parse_ordered.bind(this));
    if (this._match_text_seq("INTO")) { buckets = this._parse_number(); this._match_text_seq("BUCKETS"); }
    return this.expression(new exp.ClusteredByProperty({ expressions, sorted_by, buckets }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:3240
  _parse_copy_property() {
    if (!this._match_text_seq("GRANTS")) {
      this._retreat(this._index - 1);
      return null;
    }
    return this.expression(new exp.CopyGrantsProperty());
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:3247
  _parse_freespace() { throw new NotPorted("_parse_freespace", "sqlglot/parser.py:3247"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3253
  // note: param `default` renamed to `default_` (JS reserved word)
  _parse_mergeblockratio(no, default_) { throw new NotPorted("_parse_mergeblockratio", "sqlglot/parser.py:3253"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3265
  // note: param `default` renamed to `default_` (JS reserved word)
  _parse_datablocksize(default_, minimum, maximum) { throw new NotPorted("_parse_datablocksize", "sqlglot/parser.py:3265"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3284
  _parse_blockcompression() { throw new NotPorted("_parse_blockcompression", "sqlglot/parser.py:3284"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3301
  _parse_withisolatedloading() {
    const index = this._index;
    const no = this._match_text_seq("NO");
    const concurrent = this._match_text_seq("CONCURRENT");
    if (!this._match_text_seq("ISOLATED", "LOADING")) {
      this._retreat(index);
      return null;
    }
    return this.expression(new exp.IsolatedLoadingProperty({ no, concurrent, target: this._parse_var_from_options(this.constructor.ISOLATED_LOADING_OPTIONS, false) }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:3315
  _parse_locking() { throw new NotPorted("_parse_locking", "sqlglot/parser.py:3315"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3362
  _parse_partition_by() { throw new NotPorted("_parse_partition_by", "sqlglot/parser.py:3362"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3367
  _parse_partition_bound_spec() { const bound = () => this._match_text_seq("MINVALUE") ? exp.var("MINVALUE") : this._match_text_seq("MAXVALUE") ? exp.var("MAXVALUE") : this._parse_bitwise(); let this_ = null, expression = null, from_expressions = null, to_expressions = null; if (this._match(TokenType.IN)) this_ = this._parse_wrapped_csv(() => this._parse_bitwise()); else if (this._match(TokenType.FROM)) { from_expressions = this._parse_wrapped_csv(bound); this._match_text_seq("TO"); to_expressions = this._parse_wrapped_csv(bound); } else if (this._match_text_seq("WITH", "(", "MODULUS")) { this_ = this._parse_number(); this._match_text_seq(",", "REMAINDER"); expression = this._parse_number(); this._match_r_paren(); } else this.raise_error("Failed to parse partition bound spec."); return this.expression(new exp.PartitionBoundSpec({ this: this_, expression, from_expressions, to_expressions })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3404
  _parse_partitioned_of() { if (!this._match_text_seq("OF")) { this._retreat(this._index - 1); return null; } const this_ = this._parse_table(true); let expression; if (this._match(TokenType.DEFAULT)) expression = exp.var("DEFAULT"); else if (this._match_text_seq("FOR", "VALUES")) expression = this._parse_partition_bound_spec(); else this.raise_error("Expecting either DEFAULT or FOR VALUES clause."); return this.expression(new exp.PartitionedOfProperty({ this: this_, expression })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3420
  _parse_partitioned_by() { this._match(TokenType.EQ); return this.expression(new exp.PartitionedByProperty({ this: this._parse_schema() || this._parse_bracket(this._parse_field()) })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3428
  _parse_withdata(no) { throw new NotPorted("_parse_withdata", "sqlglot/parser.py:3428"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3438
  _parse_contains_property() { throw new NotPorted("_parse_contains_property", "sqlglot/parser.py:3438"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3443
  _parse_modifies_property() { throw new NotPorted("_parse_modifies_property", "sqlglot/parser.py:3443"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3448
  _parse_no_property() { throw new NotPorted("_parse_no_property", "sqlglot/parser.py:3448"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3455
  _parse_on_property() { throw new NotPorted("_parse_on_property", "sqlglot/parser.py:3455"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3462
  _parse_reads_property() { throw new NotPorted("_parse_reads_property", "sqlglot/parser.py:3462"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3467
  _parse_distkey() { return this.expression(new exp.DistKeyProperty({ this: this._parse_wrapped_id_vars() })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3470
  _parse_create_like() {
    const table = this._parse_table(true);
    const expressions = [];
    while (this._match_texts(["INCLUDING", "EXCLUDING"])) {
      const this_ = this._prev.text.toUpperCase();
      const id = this._parse_id_var();
      if (!id) return null;
      expressions.push(this.expression(new exp.Property({ this: this_, value: exp.var(id.this.toUpperCase()) })));
    }
    return this.expression(new exp.LikeProperty({ this: table, expressions }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:3487
  _parse_sortkey(compound = false) { return this.expression(new exp.SortKeyProperty({ this: this._parse_wrapped_id_vars(), compound })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3492
  // note: param `default` renamed to `default_` (JS reserved word)
  _parse_character_set(default_ = false) {
    this._match(TokenType.EQ);
    return this.expression(new exp.CharacterSetProperty({ this: this._parse_var_or_string(), default: default_ }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:3498
  _parse_remote_with_connection() {
    this._match_text_seq("WITH", "CONNECTION");
    return this.expression(new exp.RemoteWithConnectionModelProperty({ this: this._parse_table_parts() }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:3504
  _parse_returns() {
    let value;
    let null_ = null;
    const is_table = this._match(TokenType.TABLE);
    if (is_table) {
      if (this._match(TokenType.LT)) {
        value = this.expression(new exp.Schema({ this: "TABLE", expressions: this._parse_csv(() => this._parse_struct_types()) }));
        if (!this._match(TokenType.GT)) this.raise_error("Expecting >");
      } else value = this._parse_schema(exp.var("TABLE"));
    } else if (this._match_text_seq("NULL", "ON", "NULL", "INPUT")) {
      null_ = true;
      value = null;
    } else value = this._parse_types();
    return this.expression(new exp.ReturnsProperty({ this: value, is_table, null: null_ }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:3526
  _parse_describe() {
    const kind = this._match_set(this.constructor.CREATABLES) ? this._prev.text : null;
    let style = this._match_texts(this.constructor.DESCRIBE_STYLES) ? this._prev.text.toUpperCase() : null;
    if (this._match(TokenType.DOT)) {
      style = null;
      this._retreat(this._index - 2);
    }
    const format = this._match(TokenType.FORMAT, false) ? this._parse_property() : null;
    const this_ = this._match_set(this.constructor.STATEMENT_PARSERS, false) ? this._parse_statement() : this._parse_table(true);
    const properties = this._parse_properties();
    return this.expression(new exp.Describe({ this: this_, style, kind, expressions: properties ? properties.expressions : null, partition: this._parse_partition(), format, as_json: this._match_text_seq("AS", "JSON") }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:3557
  _parse_multitable_inserts(comments) { throw new NotPorted("_parse_multitable_inserts", "sqlglot/parser.py:3557"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3596
  _parse_insert() { throw new NotPorted("_parse_insert", "sqlglot/parser.py:3596"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3700
  _parse_insert_table() { throw new NotPorted("_parse_insert_table", "sqlglot/parser.py:3700"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3706
  _parse_kill() { throw new NotPorted("_parse_kill", "sqlglot/parser.py:3706"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3711
  _parse_on_conflict() { const conflict = this._match_text_seq("ON", "CONFLICT"), duplicate = this._match_text_seq("ON", "DUPLICATE", "KEY"); if (!conflict && !duplicate) return null; let conflict_keys = null, constraint = null; if (conflict) { if (this._match_text_seq("ON", "CONSTRAINT")) constraint = this._parse_id_var(); else if (this._match(TokenType.L_PAREN)) { conflict_keys = this._parse_csv(this._parse_indexed_column.bind(this)); this._match_r_paren(); } } const index_predicate = this._parse_where(), action = this._parse_var_from_options(this.constructor.CONFLICT_ACTIONS); let expressions = null; if (this._prev.token_type === TokenType.UPDATE) { this._match(TokenType.SET); expressions = this._parse_csv(this._parse_equality.bind(this)); } return this.expression(new exp.OnConflict({ duplicate, expressions, action, conflict_keys, index_predicate, constraint, where: this._parse_where() })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3749
  _parse_returning() { throw new NotPorted("_parse_returning", "sqlglot/parser.py:3749"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3759
  _parse_row() { return this.expression(new exp.Row({ expressions: this._parse_wrapped_csv(this._parse_assignment.bind(this)) })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3764
  _parse_serde_properties(with_) { throw new NotPorted("_parse_serde_properties", "sqlglot/parser.py:3764"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3775
  _parse_row_format(match_row) { throw new NotPorted("_parse_row_format", "sqlglot/parser.py:3775"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3809
  _parse_load() {
    if (!this._match_text_seq("DATA")) return this._parse_as_command(this._prev);
    const local = this._match_text_seq("LOCAL");
    this._match_text_seq("INPATH");
    const inpath = this._parse_string();
    const overwrite = this._match(TokenType.OVERWRITE);
    let temp = null;
    if (this._match(TokenType.INTO)) {
      temp = this._match(TokenType.TEMPORARY);
      this._match(TokenType.TABLE);
    }
    return this.expression(new exp.LoadData({ this: this._parse_table(true), local, overwrite, temp, inpath, files: this._match_text_seq("FROM", "FILES") && new exp.Properties({ expressions: this._parse_wrapped_properties() }), partition: this._parse_partition(), input_format: this._match_text_seq("INPUTFORMAT") && this._parse_string(), serde: this._match_text_seq("SERDE") && this._parse_string() }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:3836
  _parse_delete() { throw new NotPorted("_parse_delete", "sqlglot/parser.py:3836"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3862
  _parse_update() { throw new NotPorted("_parse_update", "sqlglot/parser.py:3862"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3891
  _parse_use() {
    return this.expression(new exp.Use({ kind: this._parse_var_from_options(this.constructor.USABLES, false), this: this._parse_table(false) }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:3899
  _parse_uncache() { throw new NotPorted("_parse_uncache", "sqlglot/parser.py:3899"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3907
  _parse_cache() { throw new NotPorted("_parse_cache", "sqlglot/parser.py:3907"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3928
  _parse_partition() { throw new NotPorted("_parse_partition", "sqlglot/parser.py:3928"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3939
  _parse_value(values) { throw new NotPorted("_parse_value", "sqlglot/parser.py:3939"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3956
  _parse_projections() { throw new NotPorted("_parse_projections", "sqlglot/parser.py:3956"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3961
  _parse_wrapped_select(table) { throw new NotPorted("_parse_wrapped_select", "sqlglot/parser.py:3961"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:3994
  _parse_select(nested = false, table = false, parse_subquery_alias = true, parse_set_operation = true, consume_pipe = true, from_ = null) {
    let query = this._parse_select_query(nested, table, parse_subquery_alias, parse_set_operation);
    if (consume_pipe && this._match(TokenType.PIPE_GT, false)) {
      if (!query && from_) query = exp.select("*").from_(from_);
      if (query instanceof exp.Query) {
        query = this._parse_pipe_syntax_query(query);
        query = query && table ? query.subquery(null, { copy: false }) : query;
      }
    }
    return query;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:4019
  _parse_select_query(nested = false, table = false, parse_subquery_alias = true, parse_set_operation = true) {
    const cte = this._parse_with();
    if (cte) {
      let self = this._parse_statement();
      if (!self) { this.raise_error("Failed to parse any statement following CTE"); return cte; }
      while (self instanceof exp.Subquery && self.isWrapper) self = self.this;
      if (self.constructor.argTypes.has("with_")) {
        const inner = self.args.with_;
        if (inner) {
          cte.set("expressions", [...cte.expressions, ...inner.expressions]);
          if (inner.args.recursive) cte.set("recursive", true);
        }
        self.set("with_", cte);
      } else { this.raise_error(`${self.key} does not support CTE`); self = cte; }
      return self;
    }
    let from_ = this._match(TokenType.FROM, false) ? this._parse_from(true, false, true) : null;
    let self;
    if (this._match(TokenType.SELECT)) {
      const comments = this._prev_comments;
      const hint = this._parse_hint();
      let all_, matchedDistinct;
      if (this._next.bool() && this._next.token_type !== TokenType.DOT) {
        all_ = this._match(TokenType.ALL); matchedDistinct = this._match_set(this.constructor.DISTINCT_TOKENS);
      } else { all_ = null; matchedDistinct = false; }
      const kind = this._match(TokenType.ALIAS) && this._match_texts(["STRUCT", "VALUE"]) ? pyUpper(this._prev.text) : null;
      let distinct = matchedDistinct ? this.expression(new exp.Distinct({ on: this._match(TokenType.ON) ? this._parse_value(false) : null })) : null;
      const operationModifiers = [];
      while (this._curr.bool() && this._match_texts(this.constructor.OPERATION_MODIFIERS)) operationModifiers.push(exp.var(pyUpper(this._prev.text)));
      const limit = this._parse_limit(null, true);
      if (limit && !matchedDistinct && !all_) {
        matchedDistinct = this._match_set(this.constructor.DISTINCT_TOKENS);
        if (matchedDistinct) distinct = this.expression(new exp.Distinct({ on: this._match(TokenType.ON) ? this._parse_value(false) : null }));
        else all_ = this._match(TokenType.ALL);
      }
      if (all_ && distinct) this.raise_error("Cannot specify both ALL and DISTINCT after SELECT");
      const [projections, exclude] = this._parse_projections();
      self = this.expression(new exp.Select({ kind, hint, distinct, expressions: projections, limit, exclude, operation_modifiers: operationModifiers.length ? operationModifiers : null }));
      self.comments = comments;
      const into = this._parse_into(); if (into) self.set("into", into);
      if (!from_) from_ = this._parse_from();
      if (from_) self.set("from_", from_);
      self = this._parse_query_modifiers(self);
    } else if ((table || nested) && this._match(TokenType.L_PAREN)) {
      const comments = this._prev_comments;
      self = this._parse_wrapped_select(table);
      if (self) self.addComments(comments, true);
      this._match_r_paren();
      return this._parse_subquery(self, parse_subquery_alias);
    } else if (this._match(TokenType.VALUES, false)) self = this._parse_derived_table_values();
    else if (from_) { self = exp.select("*").from_(from_.this, { copy: false }); self = this._parse_query_modifiers(self); }
    else if (this._match(TokenType.SUMMARIZE)) {
      const isTable = this._match(TokenType.TABLE);
      self = this._parse_select() || this._parse_string() || this._parse_table();
      return this.expression(new exp.Summarize({ this: self, table: isTable }));
    } else if (this._match(TokenType.DESCRIBE)) self = this._parse_describe();
    else self = null;
    return parse_set_operation ? this._parse_set_operations(self) : self;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:4161
  _parse_recursive_with_search() { throw new NotPorted("_parse_recursive_with_search", "sqlglot/parser.py:4161"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:4180
  _parse_with(skip_with_token = false) {
    if (!skip_with_token && !this._match(TokenType.WITH)) return null;
    const comments = this._prev_comments;
    let recursive = this._match(TokenType.RECURSIVE), lastComments = null;
    const expressions = [], udfs = [];
    while (true) {
      const cte = this._parse_cte();
      if (cte) {
        (cte instanceof exp.FunctionSpecification ? udfs : expressions).push(cte);
        if (lastComments?.length) cte.addComments(lastComments);
      }
      if (!this._match(TokenType.COMMA) && !this._match(TokenType.WITH)) break;
      this._match(TokenType.WITH);
      recursive = this._match(TokenType.RECURSIVE) || recursive;
      lastComments = this._prev_comments;
    }
    return this.expression(new exp.With({ expressions, recursive: recursive || null, search: this._parse_recursive_with_search(), udfs: udfs.length ? udfs : null }), null, comments);
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:4219
  _parse_cte() { throw new NotPorted("_parse_cte", "sqlglot/parser.py:4219"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:4259
  _values_to_select(values) { throw new NotPorted("_values_to_select", "sqlglot/parser.py:4259"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:4264
  _parse_table_alias(alias_tokens) { throw new NotPorted("_parse_table_alias", "sqlglot/parser.py:4264"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:4302
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_subquery(this_, parse_alias) { throw new NotPorted("_parse_subquery", "sqlglot/parser.py:4302"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:4317
  // note: param `this` renamed to `this_` (JS reserved word)
  _implicit_unnests_to_explicit(this_) { throw new NotPorted("_implicit_unnests_to_explicit", "sqlglot/parser.py:4317"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:4350
  // note: param `this` renamed to `this_` (JS reserved word)
  // note: parser.py:4344/4348 are `@t.overload` type-only signatures (body `...`),
  // not real methods -- only this one (the undecorated definition) has a runtime
  // body upstream. Duplicate stubs removed 2026-08-28 (PR #8's claim-overlap audit).
  _parse_query_modifiers(this_) { if (this_ && this.constructor.MODIFIABLES.some(C => this_ instanceof C)) { for (const join of this._parse_joins()) this_.append("joins", join); while (true) { const lateral = this._parse_lateral(); if (!lateral) break; this_.append("laterals", lateral); } while (true) { if (this._match_set(this.constructor.QUERY_MODIFIER_PARSERS, false)) { const token = this._curr, parser = this.constructor.QUERY_MODIFIER_PARSERS.get(token.token_type); const [key, expression] = parser(this); if (expression) { if (this_.args[key]) this.raise_error(`Found multiple '${pyUpper(token.text)}' clauses`, token); this_.set(key, expression); if (key === "limit") { const offsetValue = expression.args.offset; expression.set("offset", null); if (offsetValue) { const offset = new exp.Offset({ expression: offsetValue }); this_.set("offset", offset); const xs = expression.expressions; expression.set("expressions", null); offset.set("expressions", xs); } } continue; } } if (pyUpper(this._curr.text) === "START") { const token = this._curr, connect = this._parse_connect(); if (connect) { if (this_.args.connect) this.raise_error("Found multiple 'START WITH' clauses", token); this_.set("connect", connect); continue; } } break; } } if (this.constructor.SUPPORTS_IMPLICIT_UNNEST && this_ && this_.args.from_) this_ = this._implicit_unnests_to_explicit(this_); return this_; }

  /** @returns {*} */
  // py: sqlglot/parser.py:4402
  _parse_hint_fallback_to_string() { throw new NotPorted("_parse_hint_fallback_to_string", "sqlglot/parser.py:4402"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:4410
  _parse_hint_function_call() { throw new NotPorted("_parse_hint_function_call", "sqlglot/parser.py:4410"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:4413
  _parse_hint_body() { throw new NotPorted("_parse_hint_body", "sqlglot/parser.py:4413"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:4435
  _parse_hint() { throw new NotPorted("_parse_hint", "sqlglot/parser.py:4435"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:4441
  _parse_into() { throw new NotPorted("_parse_into", "sqlglot/parser.py:4441"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:4453
  _parse_from(joins, skip_from_token, consume_pipe) { throw new NotPorted("_parse_from", "sqlglot/parser.py:4453"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:4468
  _parse_match_recognize_measure() { throw new NotPorted("_parse_match_recognize_measure", "sqlglot/parser.py:4468"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:4476
  _parse_match_recognize() { throw new NotPorted("_parse_match_recognize", "sqlglot/parser.py:4476"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:4569
  _parse_lateral() { let cross_apply=null, view=null, outer=null, this_; if(this._match_pair(TokenType.CROSS,TokenType.APPLY)) cross_apply=true; else if(this._match_pair(TokenType.OUTER,TokenType.APPLY)) cross_apply=false; if(cross_apply!==null) this_=this._parse_select(true); else if(this._match(TokenType.LATERAL)){this_=this._parse_select(true);view=this._match(TokenType.VIEW);outer=this._match(TokenType.OUTER);} else return null; if(!this_) this_=this._parse_unnest()||this._parse_function()||this._parse_id_var(false); let ordinality=null, alias; if(view){const table=this._parse_id_var(false),columns=this._match(TokenType.ALIAS)?this._parse_csv(this._parse_id_var.bind(this)):[];alias=this.expression(new exp.TableAlias({this:table,columns}));} else {ordinality=this._match_pair(TokenType.WITH,TokenType.ORDINALITY);alias=this._parse_table_alias();} return this.expression(new exp.Lateral({this:this_,view,outer,alias,cross_apply,ordinality})); }

  /** @returns {*} */
  // py: sqlglot/parser.py:4626
  _parse_stream() {
    const this_ = this._parse_table(); const alias = this._parse_table_alias(); return this.expression(new exp.Stream({ this: this_, alias }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:4634
  _parse_join_parts() {
    return [
      this._match_set(this.constructor.JOIN_METHODS) ? this._prev : null,
      this._match_set(this.constructor.JOIN_SIDES) ? this._prev : null,
      this._match_set(this.constructor.JOIN_KINDS) ? this._prev : null,
    ];
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:4643
  _parse_using_identifiers() { throw new NotPorted("_parse_using_identifiers", "sqlglot/parser.py:4643"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:4652
  _parse_join(skip_join_token, parse_bracket, alias_tokens) { throw new NotPorted("_parse_join", "sqlglot/parser.py:4652"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:4748
  _parse_opclass() { const this_ = this._parse_disjunction(); if (this._match_texts(this.OPCLASS_FOLLOW_KEYWORDS, false)) return this_; if (!this._match_set(this.OPTYPE_FOLLOW_TOKENS, false)) return this.expression(new exp.Opclass({ this: this_, expression: this._parse_table_parts() })); return this_; }

  /** @returns {*} */
  // py: sqlglot/parser.py:4759
  _parse_index_params() { throw new NotPorted("_parse_index_params", "sqlglot/parser.py:4759"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:4792
  _parse_index(index, anonymous) { throw new NotPorted("_parse_index", "sqlglot/parser.py:4792"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:4822
  _parse_table_hints() { throw new NotPorted("_parse_table_hints", "sqlglot/parser.py:4822"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:4850
  _parse_table_part(schema) { throw new NotPorted("_parse_table_part", "sqlglot/parser.py:4850"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:4858
  _parse_table_parts_fast() { throw new NotPorted("_parse_table_parts_fast", "sqlglot/parser.py:4858"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:4921
  _parse_table_parts(schema, is_db_reference, wildcard, fast) { throw new NotPorted("_parse_table_parts", "sqlglot/parser.py:4921"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:4992
  _parse_table(schema, joins, alias_tokens, parse_bracket, is_db_reference, parse_partition, consume_pipe) { throw new NotPorted("_parse_table", "sqlglot/parser.py:4992"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5132
  _parse_version() { throw new NotPorted("_parse_version", "sqlglot/parser.py:5132"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5160
  _parse_historical_data() { const index = this._index; if (!this._match_texts(this.constructor.HISTORICAL_DATA_PREFIX)) return null; const this_ = pyUpper(this._prev.text); const kind = this._match(TokenType.L_PAREN) && this._match_texts(this.constructor.HISTORICAL_DATA_KIND) ? pyUpper(this._prev.text) : null; const expression = this._match(TokenType.FARROW) ? this._parse_bitwise() : null; if (!expression) { this._retreat(index); return null; } this._match_r_paren(); return this.expression(new exp.HistoricalData({ this: this_, kind, expression })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5183
  _parse_changes() { if (!this._match_text_seq("CHANGES", "(", "INFORMATION", "=>")) return null; const information = this._parse_var(true); this._match_r_paren(); return this.expression(new exp.Changes({ information, at_before: this._parse_historical_data(), end: this._parse_historical_data() })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5198
  _parse_unnest(with_alias = true) {
    if (!this._match_pair(TokenType.UNNEST, TokenType.L_PAREN, false)) return null;
    this._advance();
    const expressions = this._parse_wrapped_csv(() => this._parse_equality());
    let offset = this._match_pair(TokenType.WITH, TokenType.ORDINALITY);
    const alias = with_alias ? this._parse_table_alias() : null;
    if (alias) {
      if (this.dialect.UNNEST_COLUMN_ONLY) {
        if (alias.args.columns) this.raise_error("Unexpected extra column alias in unnest.");
        alias.set("columns", [alias.this]); alias.set("this", null);
      }
      const columns = alias.args.columns || [];
      if (offset && expressions.length < columns.length) offset = columns.pop();
    }
    if (!offset && this._match_pair(TokenType.WITH, TokenType.OFFSET)) {
      this._match(TokenType.ALIAS);
      offset = this._parse_id_var(false, this.constructor.UNNEST_OFFSET_ALIAS_TOKENS) || exp.toIdentifier("offset");
    }
    return this.expression(new exp.Unnest({ expressions, alias, offset }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:5229
  _parse_derived_table_values() { const derived = this._match_pair(TokenType.L_PAREN, TokenType.VALUES); if (!derived && !(this._match_text_seq("VALUES") || this._match_text_seq("FORMAT", "VALUES"))) return null; const expressions = this._parse_csv(() => this._parse_value()); const alias = this._parse_table_alias(); if (derived) this._match_r_paren(); return this.expression(new exp.Values({ expressions, alias: alias || this._parse_table_alias() })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5247
  _parse_table_sample(as_modifier) { throw new NotPorted("_parse_table_sample", "sqlglot/parser.py:5247"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5313
  _parse_pivots() {
    if (this._curr.token_type !== TokenType.PIVOT && this._curr.token_type !== TokenType.UNPIVOT) return null;
    const pivots = []; let pivot;
    while ((pivot = this._parse_pivot()) !== null && pivot !== undefined) pivots.push(pivot);
    return pivots.length ? pivots : null;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:5318
  _parse_joins(alias_tokens) { throw new NotPorted("_parse_joins", "sqlglot/parser.py:5318"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5323
  _parse_unpivot_columns() {
    if (!this._match(TokenType.INTO)) return null;
    return this.expression(new exp.UnpivotColumns({
      this: this._match_text_seq("NAME") ? this._parse_column() : false,
      expressions: this._match_text_seq("VALUE") ? this._parse_csv(() => this._parse_column()) : false,
    }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:5335
  _parse_simplified_pivot(is_unpivot = null) {
    const parseOn = () => {
      const self = this._parse_bitwise();
      if (this._match(TokenType.IN)) return this._parse_in(self);
      if (this._match(TokenType.ALIAS, false)) return this._parse_alias(self);
      return self;
    };
    const self = this._parse_table();
    const expressions = this._match(TokenType.ON) ? this._parse_csv(parseOn) : false;
    const into = this._parse_unpivot_columns();
    const using = this._match(TokenType.USING) ? this._parse_csv(() => this._parse_alias(this._parse_column())) : false;
    const group = this._parse_group();
    return this.expression(new exp.Pivot({ this: self, expressions, using, group, unpivot: is_unpivot, into }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:5367
  _parse_pivot_in() { throw new NotPorted("_parse_pivot_in", "sqlglot/parser.py:5367"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5395
  _parse_pivot_aggregation() { throw new NotPorted("_parse_pivot_aggregation", "sqlglot/parser.py:5395"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5404
  _parse_pivot() { throw new NotPorted("_parse_pivot", "sqlglot/parser.py:5404"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5521
  _pivot_column_names(aggregations) { throw new NotPorted("_pivot_column_names", "sqlglot/parser.py:5521"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5524
  _parse_prewhere(skip_where_token) { throw new NotPorted("_parse_prewhere", "sqlglot/parser.py:5524"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5534
  _parse_where(skip_where_token = false) {
    if (!skip_where_token && !this._match(TokenType.WHERE)) return null;
    const comments = this._prev_comments;
    return this.expression(new exp.Where({ this: this._parse_disjunction() }), null, comments);
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:5544
  _parse_group(skip_group_by_token = false) {
    if (!skip_group_by_token && !this._match(TokenType.GROUP_BY)) return null;
    const comments = this._prev_comments;
    // Python's defaultdict only materialises a key when it is accessed. Empty
    // cube/rollup/grouping_sets args must therefore not be inserted eagerly.
    const elements = {};
    if (this._match(TokenType.ALL)) elements.all = true;
    else if (this._match(TokenType.DISTINCT)) elements.all = false;
    if (this._match_set(this.constructor.QUERY_MODIFIER_TOKENS, false)) return this.expression(new exp.Group(elements), null, comments);
    while (true) {
      const index = this._index;
      (elements.expressions ||= []).push(...this._parse_csv(() => this._match_set(new Set([TokenType.CUBE, TokenType.ROLLUP]), false) ? null : this._parse_disjunction()));
      const before_with_index = this._index;
      const with_prefix = this._match(TokenType.WITH);
      const cube_or_rollup = this._parse_cube_or_rollup(with_prefix);
      if (cube_or_rollup) (elements[cube_or_rollup instanceof exp.Rollup ? "rollup" : "cube"] ||= []).push(cube_or_rollup);
      else {
        const grouping_sets = this._parse_grouping_sets();
        if (grouping_sets) (elements.grouping_sets ||= []).push(grouping_sets);
        else if (this._match_text_seq("TOTALS")) elements.totals = true;
      }
      if (before_with_index <= this._index && this._index <= before_with_index + 1) { this._retreat(before_with_index); break; }
      if (index === this._index) break;
    }
    return this.expression(new exp.Group(elements), null, comments);
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:5592
  _parse_cube_or_rollup(with_prefix = false) {
    let kind;
    if (this._match(TokenType.CUBE)) kind = exp.Cube;
    else if (this._match(TokenType.ROLLUP)) kind = exp.Rollup;
    else return null;
    return this.expression(new kind({ expressions: with_prefix ? [] : this._parse_wrapped_csv(this._parse_bitwise.bind(this)) }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:5604
  _parse_grouping_sets() {
    return this._match(TokenType.GROUPING_SETS)
      ? this.expression(new exp.GroupingSets({ expressions: this._parse_wrapped_csv(() => this._parse_grouping_set()) }))
      : null;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:5611
  _parse_grouping_set() { throw new NotPorted("_parse_grouping_set", "sqlglot/parser.py:5611"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5614
  _parse_having(skip_having_token) { throw new NotPorted("_parse_having", "sqlglot/parser.py:5614"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5623
  _parse_qualify() { throw new NotPorted("_parse_qualify", "sqlglot/parser.py:5623"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5628
  _parse_connect_with_prior() { throw new NotPorted("_parse_connect_with_prior", "sqlglot/parser.py:5628"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5636
  _parse_connect(skip_start_token) { throw new NotPorted("_parse_connect", "sqlglot/parser.py:5636"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5653
  _parse_name_as_expression() { throw new NotPorted("_parse_name_as_expression", "sqlglot/parser.py:5653"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5659
  _parse_interpolate() { throw new NotPorted("_parse_interpolate", "sqlglot/parser.py:5659"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5664
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_order(this_ = null, skip_order_token = false) { let siblings = null; if (!skip_order_token && !this._match(TokenType.ORDER_BY)) { if (!this._match(TokenType.ORDER_SIBLINGS_BY)) return this_; siblings = true; } const comments = this._prev_comments; return this.expression(new exp.Order({ this: this_, expressions: this._parse_csv(this._parse_ordered.bind(this)), siblings }), null, comments); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5684
  _parse_sort(exp_class, token) { throw new NotPorted("_parse_sort", "sqlglot/parser.py:5684"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5689
  _parse_ordered(parse_method = null) { let this_ = parse_method ? parse_method() : this._parse_disjunction(); if (!this_) return null; if (pyUpper(this_.name) === "ALL" && this.dialect.SUPPORTS_ORDER_BY_ALL) this_ = exp.var("ALL"); const asc = this._match(TokenType.ASC); const desc = this._match(TokenType.DESC) ? true : asc ? false : null; const first = this._match_text_seq("NULLS", "FIRST"), last = this._match_text_seq("NULLS", "LAST"); let nulls_first = first || false; if (!(first || last) && ((!desc && this.dialect.NULL_ORDERING === "nulls_are_small") || (desc && this.dialect.NULL_ORDERING !== "nulls_are_small")) && this.dialect.NULL_ORDERING !== "nulls_are_last") nulls_first = true; let with_fill = null; if (this._match_text_seq("WITH", "FILL")) with_fill = this.expression(new exp.WithFill({ from: this._match(TokenType.FROM) && this._parse_bitwise(), to: this._match_text_seq("TO") && this._parse_bitwise(), step: this._match_text_seq("STEP") && this._parse_bitwise(), interpolate: this._parse_interpolate() })); return this.expression(new exp.Ordered({ this: this_, desc, nulls_first, with_fill })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5734
  _parse_limit_options() {
    const percent = this._match_set(new Set([TokenType.PERCENT, TokenType.MOD]));
    const rows = this._match_set(new Set([TokenType.ROW, TokenType.ROWS]));
    this._match_text_seq("ONLY");
    const with_ties = this._match_text_seq("WITH", "TIES");
    return percent || rows || with_ties ? this.expression(new exp.LimitOptions({ percent, rows, with_ties })) : null;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:5745
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_limit(this_ = null, top = false, skip_limit_token = false) {
    if (skip_limit_token || this._match(top ? TokenType.TOP : TokenType.LIMIT)) {
      const comments = this._prev_comments;
      let expression;
      if (top) {
        const limit_paren = this._match(TokenType.L_PAREN);
        expression = limit_paren ? (this._parse_term() || this._parse_select()) : this._parse_number();
        if (limit_paren) this._match_r_paren();
      } else {
        if (this.dialect.SUPPORTS_LIMIT_ALL && this._match(TokenType.ALL)) return this_;
        const index = this._index;
        expression = this._try_parse(() => this._parse_term());
        if (expression instanceof exp.Mod) { this._retreat(index); expression = this._parse_factor(); }
        else if (!expression) expression = this._parse_factor();
      }
      const limit_options = this._parse_limit_options();
      let offset = null;
      if (this._match(TokenType.COMMA)) { offset = expression; expression = this._parse_term(); }
      return this.expression(new exp.Limit({ this: this_, expression, offset, limit_options, expressions: this._parse_limit_by() }), null, comments);
    }
    if (this._match(TokenType.FETCH)) {
      const direction = this._match_set(new Set([TokenType.FIRST, TokenType.NEXT])) ? pyUpper(this._prev.text) : "FIRST";
      const count = this._parse_field(undefined, this.constructor.FETCH_TOKENS);
      return this.expression(new exp.Fetch({ direction, count, limit_options: this._parse_limit_options() }));
    }
    return this_;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:5816
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_offset(this_) { throw new NotPorted("_parse_offset", "sqlglot/parser.py:5816"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5827
  _can_parse_limit_or_offset() { throw new NotPorted("_can_parse_limit_or_offset", "sqlglot/parser.py:5827"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5844
  _can_parse_named_window() { throw new NotPorted("_can_parse_named_window", "sqlglot/parser.py:5844"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5861
  _parse_limit_by() { return this._match_text_seq("BY") ? this._parse_csv(() => this._parse_bitwise()) : null; }

  /** @returns {*} */
  // py: sqlglot/parser.py:5864
  _parse_locks() { throw new NotPorted("_parse_locks", "sqlglot/parser.py:5864"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5901
  // note: param `this` renamed to `this_` (JS reserved word)
  parse_set_operation(this_, consume_pipe = false) {
    const start = this._index;
    const [, sideToken, kindToken] = this._parse_join_parts();
    const side = sideToken ? sideToken.text : null;
    let kind = kindToken ? kindToken.text : null;
    if (!this._match_set(this.constructor.SET_OPERATIONS)) {
      this._retreat(start);
      return null;
    }
    const Operation = this._prev.token_type === TokenType.UNION ? exp.Union : this._prev.token_type === TokenType.EXCEPT ? exp.Except : exp.Intersect;
    const comments = this._prev.comments;
    let distinct;
    if (this._match(TokenType.DISTINCT)) distinct = true;
    else if (this._match(TokenType.ALL)) distinct = false;
    else {
      distinct = this.dialect.SET_OP_DISTINCT_BY_DEFAULT.get(Operation);
      if (distinct == null) this.raise_error(`Expected DISTINCT or ALL for ${Operation.name}`);
    }
    let byName = this._match_text_seq("BY", "NAME") || this._match_text_seq("STRICT", "CORRESPONDING") || null;
    if (this._match_text_seq("CORRESPONDING")) {
      byName = true;
      if (!side && !kind) kind = "INNER";
    }
    const on = byName && this._match_texts(["ON", "BY"]) ? this._parse_wrapped_csv(() => this._parse_column()) : null;
    let expression = this._parse_select(true, undefined, undefined, false, consume_pipe);
    if (this_ instanceof exp.Values) this_ = this._values_to_select(this_);
    if (expression instanceof exp.Values) expression = this._values_to_select(expression);
    if (this_ instanceof exp.Alias && this_.this instanceof exp.Subquery) {
      const subquery = this_.this;
      subquery.set("alias", new exp.TableAlias({ this: this_.args.alias }));
      subquery.addComments(this_.popComments());
      this_ = subquery;
    }
    return this.expression(new Operation({ this: this_, distinct, by_name: byName, expression, side, kind, on }), null, comments);
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:5978
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_set_operations(this_) {
    while (this_) {
      const setop = this.parse_set_operation(this_);
      if (!setop) break;
      this_ = setop;
    }
    if (this_ instanceof exp.SetOperation && this.constructor.MODIFIERS_ATTACHED_TO_SET_OP) {
      const expression = this_.expression;
      if (expression) {
        for (const arg of this.constructor.SET_OP_MODIFIERS) {
          const expr = expression.args[arg];
          if (expr) this_.set(arg, expr.pop());
        }
      }
    }
    return this_;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:5996
  _parse_expression() { return this._parse_alias(this._parse_assignment()); }

  /** @returns {*} */
  // py: sqlglot/parser.py:5999
  _parse_assignment() {
    let this_ = this._parse_disjunction();
    if (!this_ && this.ASSIGNMENT.has(this._next.token_type)) {
      this_ = exp.column(this._advance_any(true) && this._prev.text);
    }
    while (this._match_set(this.ASSIGNMENT)) {
      if (this_ instanceof exp.Column && this_.parts.length === 1) this_ = this_.this;
      const comments = this._prev_comments;
      const Klass = this.ASSIGNMENT.get(this._prev.token_type);
      this_ = this.expression(new Klass({ this: this_, expression: this._parse_assignment() }), null, comments);
    }
    return this_;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:6021
  _parse_disjunction() {
    let this_ = this._parse_conjunction();
    while (this._match_set(this.DISJUNCTION)) { const comments = this._prev_comments; const K = this.DISJUNCTION.get(this._prev.token_type); this_ = this.expression(new K({ this: this_, expression: this._parse_conjunction() }), null, comments); }
    return this_;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:6033
  _parse_conjunction() {
    let this_ = this._parse_equality();
    while (this._match_set(this.CONJUNCTION)) { const comments = this._prev_comments; const K = this.CONJUNCTION.get(this._prev.token_type); this_ = this.expression(new K({ this: this_, expression: this._parse_equality() }), null, comments); }
    return this_;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:6045
  _parse_equality() {
    let this_ = this._parse_comparison();
    while (this._match_set(this.EQUALITY)) { const comments = this._prev_comments; const K = this.EQUALITY.get(this._prev.token_type); this_ = this.expression(new K({ this: this_, expression: this._parse_comparison() }), null, comments); }
    return this_;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:6057
  _parse_comparison() {
    let this_ = this._parse_range();
    while (this._match_set(this.COMPARISON)) { const comments = this._prev_comments; const K = this.COMPARISON.get(this._prev.token_type); this_ = this.expression(new K({ this: this_, expression: this._parse_range() }), null, comments); }
    return this_;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:6067
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_range(this_ = null) {
    this_ ||= this._parse_bitwise();
    while (true) {
      const negate = this._match(TokenType.NOT);
      if (this._match_set(this.RANGE_PARSERS)) {
        const parser = this.RANGE_PARSERS.get(this._prev.token_type);
        const expression = parser(this, this_);
        if (!expression) return this_;
        this_ = expression;
      } else if (this._match(TokenType.ISNULL) || (negate && this._match(TokenType.NULL))) {
        this_ = this.expression(new exp.Is({ this: this_, expression: new exp.Null() }));
      } else if (this._match(TokenType.NOTNULL)) {
        this_ = this.expression(new exp.Is({ this: this_, expression: new exp.Null(), negate: !this.dialect.NORMALIZE_NOT_NULL }));
        if (this.dialect.NORMALIZE_NOT_NULL) this_ = this.expression(new exp.Not({ this: this_ }));
      } else {
        if (negate) this._retreat(this._index - 1);
        break;
      }
      if (negate) {
        this_ = this._negate_range(this_);
        if (this._curr.bool() && (this._curr.token_type === TokenType.NOT || this.RANGE_PARSERS.has(this._curr.token_type))) {
          this_ = this.expression(new exp.Paren({ this: this_ }));
        }
      }
    }
    return this_;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:6103
  // note: param `this` renamed to `this_` (JS reserved word)
  _negate_range(this_) { throw new NotPorted("_negate_range", "sqlglot/parser.py:6103"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:6114
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_is(this_) { const index = this._index - 1, negate = this._match(TokenType.NOT); if (this._match_text_seq("DISTINCT", "FROM")) { const C = negate ? exp.NullSafeEQ : exp.NullSafeNEQ; return this.expression(new C({ this: this_, expression: this._parse_bitwise() })); } let expression; if (this._match(TokenType.JSON)) { const kind = this._match_texts(this.constructor.IS_JSON_PREDICATE_KIND) ? pyUpper(this._prev.text) : null; let with_ = null; if (this._match_text_seq("WITH")) with_ = true; else if (this._match_text_seq("WITHOUT")) with_ = false; const unique = this._match(TokenType.UNIQUE); this._match_text_seq("KEYS"); expression = this.expression(new exp.JSON({ this: kind, with_, unique })); } else { expression = this._parse_null() || this._parse_bitwise(); if (!expression) { this._retreat(index); return null; } } if (negate && expression instanceof exp.Null && !this.dialect.NORMALIZE_NOT_NULL) this_ = this.expression(new exp.Is({ this: this_, expression, negate: true })); else { this_ = this.expression(new exp.Is({ this: this_, expression })); if (negate) this_ = this.expression(new exp.Not({ this: this_ })); } return this._parse_column_ops(this_); }

  /** @returns {*} */
  // py: sqlglot/parser.py:6151
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_in(this_, alias = false) { const unnest = this._parse_unnest(false); if (unnest) return this.expression(new exp.In({ this: this_, unnest })); if (this._match_set(new Set([TokenType.L_PAREN, TokenType.L_BRACKET]))) { const paren = this._prev.token_type === TokenType.L_PAREN; const expressions = this._parse_csv(() => this._parse_select_or_expression(alias)); if (expressions.length === 1 && expressions[0] instanceof exp.Query) this_ = this.expression(new exp.In({ this: this_, query: this._parse_query_modifiers(expressions[0]).subquery(false) })); else this_ = this.expression(new exp.In({ this: this_, expressions })); if (paren) this._match_r_paren(this_); else if (!this._match(TokenType.R_BRACKET, true, this_)) this.raise_error("Expecting ]"); return this_; } return this.expression(new exp.In({ this: this_, field: this._parse_column() })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:6175
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_between(this_) { let symmetric = null; if (this._match_text_seq("SYMMETRIC")) symmetric = true; else if (this._match_text_seq("ASYMMETRIC")) symmetric = false; const low = this._parse_bitwise(); this._match(TokenType.AND); const high = this._parse_bitwise(); return this.expression(new exp.Between({ this: this_, low, high, symmetric })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:6188
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_escape(this_) {
    if (!this._match(TokenType.ESCAPE)) return this_;
    return this.expression(new exp.Escape({ this: this_, expression: this._parse_string() || this._parse_null() }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:6195
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_interval_span(this_, parse_function_unit) { throw new NotPorted("_parse_interval_span", "sqlglot/parser.py:6195"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:6262
  _parse_interval(require_interval, parse_function_unit) { throw new NotPorted("_parse_interval", "sqlglot/parser.py:6262"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:6302
  _parse_bitwise() { throw new NotPorted("_parse_bitwise", "sqlglot/parser.py:6302"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:6337
  _parse_term() { throw new NotPorted("_parse_term", "sqlglot/parser.py:6337"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:6352
  _normalize_collate(collate) { throw new NotPorted("_normalize_collate", "sqlglot/parser.py:6352"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:6362
  _parse_factor() { throw new NotPorted("_parse_factor", "sqlglot/parser.py:6362"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:6383
  _parse_factor_operand() { throw new NotPorted("_parse_factor_operand", "sqlglot/parser.py:6383"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:6386
  _parse_exponent() { throw new NotPorted("_parse_exponent", "sqlglot/parser.py:6386"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:6396
  _parse_unary() { throw new NotPorted("_parse_unary", "sqlglot/parser.py:6396"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:6401
  _parse_type(parse_interval, fallback_to_identifier) { throw new NotPorted("_parse_type", "sqlglot/parser.py:6401"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:6464
  _parse_type_size() { let this_ = this._parse_type(); if (!this_) return null; if (this_ instanceof exp.Column && !this_.table) this_ = exp.var(pyUpper(this_.name)); return this.expression(new exp.DataTypeParam({ this: this_, expression: this._parse_var(true) })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:6476
  _parse_user_defined_type(identifier) {
    let typeName = identifier.name;
    while (this._match(TokenType.DOT)) typeName = `${typeName}.${this._advance_any() && this._prev.text}`;
    return exp.DataType.fromStr(typeName, { dialect: this.dialect, udt: true });
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:6484
  _parse_types(check_func, schema, allow_identifiers, with_collation) { throw new NotPorted("_parse_types", "sqlglot/parser.py:6484"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:6739
  _parse_json_type_arg() { throw new NotPorted("_parse_json_type_arg", "sqlglot/parser.py:6739"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:6765
  _parse_vector_expressions(expressions) { return [exp.DataType.fromStr(expressions[0].name, { dialect: this.dialect }), ...expressions.slice(1)]; }

  /** @returns {*} */
  // py: sqlglot/parser.py:6768
  _parse_struct_types(type_required) { throw new NotPorted("_parse_struct_types", "sqlglot/parser.py:6768"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:6798
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_at_time_zone(this_) { throw new NotPorted("_parse_at_time_zone", "sqlglot/parser.py:6798"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:6805
  _parse_atom() { throw new NotPorted("_parse_atom", "sqlglot/parser.py:6805"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:6830
  _parse_column() { throw new NotPorted("_parse_column", "sqlglot/parser.py:6830"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:6846
  _parse_column_parts_fast() { throw new NotPorted("_parse_column_parts_fast", "sqlglot/parser.py:6846"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:6919
  _parse_column_reference() { throw new NotPorted("_parse_column_reference", "sqlglot/parser.py:6919"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:6935
  // note: param `this` renamed to `this_` (JS reserved word)
  _build_json_extract(this_, path_parts) { throw new NotPorted("_build_json_extract", "sqlglot/parser.py:6935"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:6953
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_colon_as_variant_extract(this_) { throw new NotPorted("_parse_colon_as_variant_extract", "sqlglot/parser.py:6953"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7010
  _parse_dcolon() { return this._parse_types(); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7013
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_column_ops(this_) { throw new NotPorted("_parse_column_ops", "sqlglot/parser.py:7013"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7081
  _parse_paren() { throw new NotPorted("_parse_paren", "sqlglot/parser.py:7081"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7119
  _parse_primary() { throw new NotPorted("_parse_primary", "sqlglot/parser.py:7119"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7147
  _parse_field(any_token, tokens, anonymous_func) { throw new NotPorted("_parse_field", "sqlglot/parser.py:7147"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7178
  _parse_function(functions = null, anonymous = false, optional_parens = true, any_token = false) {
    let fn_syntax = false;
    if (this._match(TokenType.L_BRACE, false) && this._next.bool() && pyUpper(this._next.text) === "FN") {
      this._advance(2);
      fn_syntax = true;
    }
    const func = this._parse_function_call(functions, anonymous, optional_parens, any_token);
    if (fn_syntax) this._match(TokenType.R_BRACE);
    return func;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:7208
  _parse_function_args(alias = false) { return this._parse_csv(() => this._parse_lambda(alias)); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7211
  _parse_connector_function(connector) { throw new NotPorted("_parse_connector_function", "sqlglot/parser.py:7211"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7219
  _parse_function_call(functions = null, anonymous = false, optional_parens = true, any_token = false) {
    if (!this._curr.bool()) return null;
    const comments = this._curr.comments;
    const prev = this._prev;
    const token = this._curr;
    const token_type = token.token_type;
    let this_ = token.text;
    const upper = pyUpper(token.text);
    const cls = this.constructor;
    const after_dot = prev.token_type === TokenType.DOT;
    let parser = cls.NO_PAREN_FUNCTION_PARSERS.get(upper);
    if (optional_parens && parser && !cls.INVALID_FUNC_NAME_TOKENS.has(token_type) && !after_dot) {
      this._advance();
      return this._parse_window(parser(this));
    }
    if (this._next.token_type !== TokenType.L_PAREN) {
      if (optional_parens && cls.NO_PAREN_FUNCTIONS.has(token_type) && !after_dot) {
        this._advance();
        return this.expression(new (cls.NO_PAREN_FUNCTIONS.get(token_type))());
      }
      return null;
    }
    if (any_token ? cls.RESERVED_TOKENS.has(token_type) : !cls.FUNC_TOKENS.has(token_type)) return null;
    this._advance(2);
    parser = cls.FUNCTION_PARSERS.get(upper);
    let result;
    if (parser && !anonymous) result = parser(this);
    else {
      const subquery_predicate = cls.SUBQUERY_PREDICATES.get(token_type);
      if (subquery_predicate) {
        let expr = null;
        if (cls.SUBQUERY_TOKENS.has(this._curr.token_type)) { expr = this._parse_select(); this._match_r_paren(); }
        else if (prev && new Set([TokenType.LIKE, TokenType.ILIKE]).has(prev.token_type)) { this._advance(-1); expr = this._parse_bitwise(); }
        if (expr) return this.expression(new subquery_predicate({ this: expr }), null, comments);
      }
      functions ||= cls.FUNCTIONS;
      const func_builder = functions.get(upper);
      let known_function = !!func_builder && !anonymous;
      const alias = !known_function || cls.FUNCTIONS_WITH_ALIASED_ARGS.has(upper);
      let args = this._parse_function_args(alias);
      const post_func_comments = this._curr.bool() ? this._curr.comments : null;
      if (known_function && post_func_comments?.some((comment) => comment.trimStart().startsWith("sqlglot.anonymous"))) known_function = false;
      if (alias && known_function) args = this._kv_to_prop_eq(args);
      if (known_function) {
        let func;
        try { func = func_builder(args); }
        catch (e) { if (!(e instanceof TypeError)) throw e; func = func_builder(args, this.dialect); }
        func = this.validate_expression(func, args);
        if (this.dialect.PRESERVE_ORIGINAL_NAMES) func.meta.name = this_;
        result = func;
      } else {
        if (token_type === TokenType.IDENTIFIER) this_ = new exp.Identifier({ this: this_, quoted: true }).updatePositions(token);
        result = this.expression(new exp.Anonymous({ this: this_, expressions: args }));
      }
      result = result.updatePositions(token);
    }
    if (result instanceof exp.Expr) result.addComments(comments);
    if (parser) this._match(TokenType.R_PAREN, true, result);
    else this._match_r_paren(result);
    return this._parse_window(result);
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:7336
  _to_prop_eq(expression, index) { throw new NotPorted("_to_prop_eq", "sqlglot/parser.py:7336"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7339
  _kv_to_prop_eq(expressions, parse_map) { throw new NotPorted("_kv_to_prop_eq", "sqlglot/parser.py:7339"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7366
  _parse_function_properties() { throw new NotPorted("_parse_function_properties", "sqlglot/parser.py:7366"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7388
  _parse_user_defined_function_expression() { return this._parse_statement(); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7391
  _parse_function_parameter() { return this._parse_column_def(this._parse_id_var(), false); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7394
  _parse_user_defined_function(kind = null) {
    const this_ = this._parse_table_parts(true);
    if (!this._match(TokenType.L_PAREN)) return this_;
    const expressions = this._parse_csv(() => this._parse_function_parameter());
    this._match_r_paren();
    return this.expression(new exp.UserDefinedFunction({ this: this_, expressions, wrapped: true }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:7406
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_macro_overloads(this_, first_body, first_is_table = false) {
    const overloads = [this.expression(new exp.MacroOverload({ this: first_body, expressions: this_.expressions || null, is_table: first_is_table }))];
    this_.set("expressions", null);
    this_.set("wrapped", false);
    while (this._match(TokenType.COMMA)) {
      if (!this._match(TokenType.L_PAREN)) break;
      const params = this._parse_csv(() => this._parse_function_parameter());
      this._match_r_paren();
      if (!this._match(TokenType.ALIAS)) break;
      const isTable = this._match(TokenType.TABLE);
      overloads.push(this.expression(new exp.MacroOverload({ this: this._parse_expression(), expressions: params, is_table: isTable })));
    }
    return this.expression(new exp.MacroOverloads({ expressions: overloads }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:7441
  _parse_introducer(token) {
    const this_ = this._parse_primary();
    return this_ ? this.expression(new exp.Introducer({ this: this_, expression: token.text })) : null;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:7448
  _parse_session_parameter() {
    let kind = null;
    let this_ = this._parse_id_var() || this._parse_primary();
    if (this_ && this._match(TokenType.DOT)) { kind = this_.name; this_ = this._parse_var() || this._parse_primary(); }
    return this.expression(new exp.SessionParameter({ this: this_, kind }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:7458
  _parse_lambda_arg() { return this._parse_id_var(); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7461
  _parse_lambda(alias = false) {
    const cls = this.constructor;
    const next_token_type = this._next.token_type;
    if (cls.LAMBDA_ARG_TERMINATORS.has(next_token_type)) { const atom = this._parse_atom(); if (atom !== null && atom !== undefined) return atom; }
    const index = this._index;
    let expressions;
    if (this._match(TokenType.L_PAREN)) {
      expressions = this._parse_csv(() => this._parse_lambda_arg());
      if (!this._match(TokenType.R_PAREN)) this._retreat(index);
      else if (this._match_set(cls.LAMBDAS)) return cls.LAMBDAS.get(this._prev.token_type)(this, expressions);
      else this._retreat(index);
    } else if (cls.TYPED_LAMBDA_ARGS || cls.LAMBDAS.has(next_token_type)) {
      expressions = [this._parse_lambda_arg()];
      if (this._match_set(cls.LAMBDAS)) return cls.LAMBDAS.get(this._prev.token_type)(this, expressions);
      this._retreat(index);
    }
    let this_;
    if (this._match(TokenType.DISTINCT)) this_ = this.expression(new exp.Distinct({ expressions: this._parse_csv(() => this._parse_disjunction()) }));
    else { this._match(TokenType.ALL); this_ = this._parse_select_or_expression(alias); }
    return this._parse_limit(this._parse_respect_or_ignore_nulls(this._parse_order(this._parse_having_max(this._parse_respect_or_ignore_nulls(this_)))));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:7508
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_schema(this_) { throw new NotPorted("_parse_schema", "sqlglot/parser.py:7508"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7522
  _parse_field_def() { throw new NotPorted("_parse_field_def", "sqlglot/parser.py:7522"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7525
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_column_def(this_, computed_column) { throw new NotPorted("_parse_column_def", "sqlglot/parser.py:7525"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7610
  _parse_auto_increment() { let start = null, increment = null, order = null; if (this._match(TokenType.L_PAREN, false)) { const args = this._parse_wrapped_csv(this._parse_bitwise.bind(this)); start = args[0] ?? null; increment = args[1] ?? null; } while (true) { if (this._match_text_seq("START")) start = this._parse_bitwise(); else if (this._match_text_seq("INCREMENT")) increment = this._parse_bitwise(); else if (this._match_text_seq("ORDER")) order = true; else if (this._match_text_seq("NOORDER")) order = false; else break; } return start || increment || order !== null ? new exp.GeneratedAsIdentityColumnConstraint({ start, increment, this: false, order }) : new exp.AutoIncrementColumnConstraint(); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7643
  _parse_check_constraint() { throw new NotPorted("_parse_check_constraint", "sqlglot/parser.py:7643"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7654
  _parse_auto_property() { throw new NotPorted("_parse_auto_property", "sqlglot/parser.py:7654"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7660
  _parse_compress() {
    const this_ = this._match(TokenType.L_PAREN) ? this._parse_csv(this._parse_string.bind(this)) : null;
    if (this_) this._match_r_paren(); return this.expression(new exp.CompressColumnConstraint({ this: this_ }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:7668
  _parse_generated_as_identity() { let this_; if (this._match_text_seq("BY", "DEFAULT")) this_ = this.expression(new exp.GeneratedAsIdentityColumnConstraint({ this: false, on_null: this._match_pair(TokenType.ON, TokenType.NULL) })); else { this._match_text_seq("ALWAYS"); this_ = this.expression(new exp.GeneratedAsIdentityColumnConstraint({ this: true })); } this._match(TokenType.ALIAS); if (this._match_text_seq("ROW")) { const start = this._match_text_seq("START"); if (!start) this._match(TokenType.END); return this.expression(new exp.GeneratedAsRowColumnConstraint({ start, hidden: this._match_text_seq("HIDDEN") })); } const identity = this._match_text_seq("IDENTITY"); if (this._match(TokenType.L_PAREN)) { for (const [words,key] of [["START WITH","start"],["INCREMENT BY","increment"],["MINVALUE","minvalue"],["MAXVALUE","maxvalue"]]) if (this._match_text_seq(...words.split(" "))) this_.set(key,this._parse_bitwise()); if (this._match_text_seq("CYCLE")) this_.set("cycle",true); else if (this._match_text_seq("NO","CYCLE")) this_.set("cycle",false); if (!identity) this_.set("expression",this._parse_range()); else if (!this_.args.start && this._match(TokenType.NUMBER,false)) { const args=this._parse_csv(this._parse_bitwise.bind(this)); this_.set("start",args[0]??null); this_.set("increment",args[1]??null); } this._match_r_paren(); } return this_; }

  /** @returns {*} */
  // py: sqlglot/parser.py:7721
  _parse_inline() { throw new NotPorted("_parse_inline", "sqlglot/parser.py:7721"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7725
  _parse_not_constraint() { throw new NotPorted("_parse_not_constraint", "sqlglot/parser.py:7725"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7737
  _parse_column_constraint() { throw new NotPorted("_parse_column_constraint", "sqlglot/parser.py:7737"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7766
  _parse_constraint() { throw new NotPorted("_parse_constraint", "sqlglot/parser.py:7766"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7774
  _parse_unnamed_constraints() { throw new NotPorted("_parse_unnamed_constraints", "sqlglot/parser.py:7774"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7784
  _parse_unnamed_constraint(constraints) { throw new NotPorted("_parse_unnamed_constraint", "sqlglot/parser.py:7784"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7802
  _parse_unique_key() {
    const this_ = this._parse_wrapped_id_vars(); return this.expression(new exp.UniqueColumnConstraint({ this: this_, is_key: true }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:7811
  _parse_unique() {
    const nulls = this._match_text_seq("NULLS", "NOT", "DISTINCT") ? false : (this._match_text_seq("NULLS", "DISTINCT") ? true : null);
    return this.expression(new exp.UniqueColumnConstraint({ this: this._parse_wrapped_id_vars(), nulls }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:7823
  _parse_key_constraint_options() { throw new NotPorted("_parse_key_constraint_options", "sqlglot/parser.py:7823"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7857
  _parse_references(match) {
    const this_ = this._parse_table_parts(); const expressions = this._parse_wrapped_csv(this._parse_id_var.bind(this));
    return this.expression(new exp.Reference({ this: new exp.Schema({ this: this_, expressions }), options: this._parse_on_handling(), match }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:7866
  _parse_foreign_key() { const expressions = !this._match(TokenType.REFERENCES, false) ? this._parse_wrapped_id_vars() : null; const reference = this._parse_references(); const opts = {}; while (this._match(TokenType.ON)) { if (!this._match_set(new Set([TokenType.DELETE, TokenType.UPDATE]))) this.raise_error("Expected DELETE or UPDATE"); const kind = this._prev.text.toLowerCase(); let action; if (this._match_text_seq("NO", "ACTION")) action = "NO ACTION"; else if (this._match(TokenType.SET)) { this._match_set(new Set([TokenType.NULL, TokenType.DEFAULT])); action = `SET ${pyUpper(this._prev.text)}`; } else { this._advance(); action = pyUpper(this._prev.text); } opts[kind] = action; } return this.expression(new exp.ForeignKey({ expressions, reference, options: this._parse_key_constraint_options(), ...opts })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7901
  _parse_primary_key_part() { throw new NotPorted("_parse_primary_key_part", "sqlglot/parser.py:7901"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7904
  _parse_period_for_system_time() {
    if (!this._match_text_seq("PERIOD", "FOR", "SYSTEM_TIME")) return null;
    this._match(TokenType.L_PAREN); const start = this._parse_id_var(); this._match(TokenType.COMMA); const end = this._parse_id_var(); this._match(TokenType.R_PAREN);
    return this.expression(new exp.PeriodForSystemTimeConstraint({ start, end }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:7916
  _parse_primary_key(wrapped_optional, in_props, named_primary_key) { throw new NotPorted("_parse_primary_key", "sqlglot/parser.py:7916"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7957
  _parse_bracket_key_value(is_map = false) { return this._parse_slice(this._parse_alias(this._parse_disjunction(), true)); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7960
  _parse_odbc_datetime_literal() { throw new NotPorted("_parse_odbc_datetime_literal", "sqlglot/parser.py:7960"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:7976
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_bracket(this_) { throw new NotPorted("_parse_bracket", "sqlglot/parser.py:7976"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8035
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_slice(this_) { if (!this._match(TokenType.COLON)) return this_; let end; if (this._match_pair(TokenType.DASH, TokenType.COLON, false)) { this._advance(); end = new exp.Neg({ this: exp.Literal.number("1") }); } else end = this._parse_assignment(); const step = this._match(TokenType.COLON) ? this._parse_unary() : null; return this.expression(new exp.Slice({ this: this_, expression: end, step })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8047
  _parse_case() { if (this._match(TokenType.DOT, false)) { this._retreat(this._index - 1); return null; } const ifs = [], comments = this._prev_comments, expression = this._parse_disjunction(); let default_ = null; while (this._match(TokenType.WHEN)) { const this_ = this._parse_disjunction(); this._match(TokenType.THEN); ifs.push(this.expression(new exp.If({ this: this_, true: this._parse_disjunction() }))); } if (this._match(TokenType.ELSE)) default_ = this._parse_disjunction(); if (!this._match(TokenType.END)) { if (default_ instanceof exp.Interval && pyUpper(kernelSql(default_.this)) === "END") default_ = exp.column("interval"); else this.raise_error("Expected END after CASE", this._prev); } return this.expression(new exp.Case({ this: expression, ifs, default: default_ }), null, comments); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8078
  _parse_if() { let this_; if (this._match(TokenType.L_PAREN)) { const args = this._parse_csv(() => this._parse_alias(this._parse_assignment(), true)); this_ = this.validate_expression(exp.If.from_arg_list(args), args); this._match_r_paren(); } else { const index = this._index - 1; if (this.constructor.NO_PAREN_IF_COMMANDS && index === 0) return this._parse_as_command(this._prev); const condition = this._parse_disjunction(); if (!condition) { this._retreat(index); return null; } this._match(TokenType.THEN); const true_ = this._parse_disjunction(); const false_ = this._match(TokenType.ELSE) ? this._parse_disjunction() : null; this._match(TokenType.END); this_ = this.expression(new exp.If({ this: condition, true: true_, false: false_ })); } return this_; }

  /** @returns {*} */
  // py: sqlglot/parser.py:8105
  _parse_next_value_for() { throw new NotPorted("_parse_next_value_for", "sqlglot/parser.py:8105"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8117
  _parse_extract() {
    const this_ = this._parse_function_parameter(); this._match(TokenType.FROM); const expression = this._parse_bitwise();
    this._match_r_paren(); return this.expression(new exp.Extract({ this: this_, expression }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:8128
  _parse_gap_fill() { throw new NotPorted("_parse_gap_fill", "sqlglot/parser.py:8128"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8138
  _parse_char() {
    const this_ = this._parse_csv(this._parse_bitwise.bind(this)); const charset = this._match_text_seq("USING") ? this._parse_var() : null;
    this._match_r_paren(); return this.expression(new exp.Chr({ expressions: this_, charset }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:8146
  _parse_charset_name() { throw new NotPorted("_parse_charset_name", "sqlglot/parser.py:8146"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8155
  _parse_cast(strict, safe) { throw new NotPorted("_parse_cast", "sqlglot/parser.py:8155"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8215
  _parse_string_agg() { let args; if (this._match(TokenType.DISTINCT)) { args=[this.expression(new exp.Distinct({expressions:[this._parse_disjunction()]}))]; if(this._match(TokenType.COMMA)) args.push(...this._parse_csv(this._parse_disjunction.bind(this))); } else args=this._parse_csv(this._parse_disjunction.bind(this)); const index=this._index; if(!this._match(TokenType.R_PAREN) && args.length){ args[0]=this._parse_limit(this._parse_order(args[0])); return this.expression(new exp.GroupConcat({this:args[0],separator:args[1]??null})); } if(!this._match_text_seq("WITHIN","GROUP")){ this._retreat(index); return this.validate_expression(exp.GroupConcat.from_arg_list(args),args); } this._match_l_paren(); return this.expression(new exp.GroupConcat({this:this._parse_order(args[0]??null),separator:args[1]??null})); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8269
  _parse_convert(strict, safe) {
    const this_ = this._parse_bitwise(); this._match(TokenType.COMMA); const to = this._parse_types(); let style = null;
    if (this._match(TokenType.COMMA)) style = this._parse_bitwise(); this._match_r_paren();
    return this.expression(new exp.Convert({ this: this_, to, style, safe, strict }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:8281
  _parse_xml_element() { let evalname = null, this_; if (this._match_text_seq("EVALNAME")) { evalname = true; this_ = this._parse_bitwise(); } else { this._match_text_seq("NAME"); this_ = this._parse_id_var(); } return this.expression(new exp.XMLElement({ this: this_, expressions: this._match(TokenType.COMMA) ? this._parse_csv(this._parse_bitwise.bind(this)) : null, evalname })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8298
  _parse_xml_table() { let namespaces = null, passing = null, columns = null; if (this._match_text_seq("XMLNAMESPACES", "(")) { namespaces = this._parse_xml_namespace(); this._match_text_seq(")", ","); } const this_ = this._parse_string(); if (this._match_text_seq("PASSING")) { this._match_text_seq("BY", "VALUE"); passing = this._parse_csv(() => this._parse_column()); } const by_ref = this._match_text_seq("RETURNING", "SEQUENCE", "BY", "REF"); if (this._match_text_seq("COLUMNS")) columns = this._parse_csv(() => this._parse_field_def()); return this.expression(new exp.XMLTable({ this: this_, namespaces, passing, columns, by_ref })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8325
  _parse_xml_namespace() { throw new NotPorted("_parse_xml_namespace", "sqlglot/parser.py:8325"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8339
  _parse_decode() {
    const expressions = this._parse_csv(this._parse_bitwise.bind(this)); this._match_r_paren();
    return this.expression(new exp.Decode({ expressions }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:8347
  _parse_json_key_value() { throw new NotPorted("_parse_json_key_value", "sqlglot/parser.py:8347"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8358
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_format_json(this_) { throw new NotPorted("_parse_format_json", "sqlglot/parser.py:8358"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8364
  _parse_on_condition() { let empty, error; const values = [...this.constructor.ON_CONDITION_TOKENS]; if (this.dialect.ON_CONDITION_EMPTY_BEFORE_ERROR) { empty = this._parse_on_handling("EMPTY", ...values); error = this._parse_on_handling("ERROR", ...values); } else { error = this._parse_on_handling("ERROR", ...values); empty = this._parse_on_handling("EMPTY", ...values); } const null_ = this._parse_on_handling("NULL", ...values); return empty || error || null_ ? this.expression(new exp.OnCondition({ empty, error, null: null_ })) : null; }

  /** @returns {*} */
  // py: sqlglot/parser.py:8380
  _parse_on_handling(on, ...values) { for (const value of values) if (this._match_text_seq(value, "ON", on)) return `${value} ON ${on}`; const index = this._index; if (this._match(TokenType.DEFAULT)) { const value = this._parse_bitwise(); if (this._match_text_seq("ON", on)) return value; this._retreat(index); } return null; }

  /** @returns {*} */
  // py: sqlglot/parser.py:8402
  // note: parser.py:8396/8399 are `@t.overload` type-only signatures (body `...`),
  // not real methods -- only this one (the undecorated definition) has a runtime
  // body upstream. Duplicate stubs removed 2026-08-28 (PR #8's claim-overlap audit).
  _parse_json_object(agg) { throw new NotPorted("_parse_json_object", "sqlglot/parser.py:8402"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8435
  _parse_json_column_def() { throw new NotPorted("_parse_json_column_def", "sqlglot/parser.py:8435"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8462
  _parse_json_schema() { throw new NotPorted("_parse_json_schema", "sqlglot/parser.py:8462"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8470
  _parse_json_table() { throw new NotPorted("_parse_json_table", "sqlglot/parser.py:8470"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8485
  _parse_match_against() { let expressions; if (this._match_text_seq("TABLE")) { const table = this._parse_table(); expressions = table ? [table] : []; } else expressions = this._parse_csv(this._parse_column.bind(this)); this._match_text_seq(")", "AGAINST", "("); const this_ = this._parse_string(); let modifier = null; if (this._match_text_seq("IN", "NATURAL", "LANGUAGE", "MODE")) { modifier = "IN NATURAL LANGUAGE MODE"; if (this._match_text_seq("WITH", "QUERY", "EXPANSION")) modifier += " WITH QUERY EXPANSION"; } else if (this._match_text_seq("IN", "BOOLEAN", "MODE")) modifier = "IN BOOLEAN MODE"; else if (this._match_text_seq("WITH", "QUERY", "EXPANSION")) modifier = "WITH QUERY EXPANSION"; return this.expression(new exp.MatchAgainst({ this: this_, expressions, modifier })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8516
  _parse_open_json() { throw new NotPorted("_parse_open_json", "sqlglot/parser.py:8516"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8537
  _parse_position(haystack_first = false) { const args = this._parse_csv(this._parse_bitwise.bind(this)); if (this._match(TokenType.IN)) return this.expression(new exp.StrPosition({ this: this._parse_bitwise(), substr: args[0] ?? null })); const haystack = args[haystack_first ? 0 : 1] ?? null; const needle = args[haystack_first ? 1 : 0] ?? null; return this.expression(new exp.StrPosition({ this: haystack, substr: needle, position: args[2] ?? null })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8556
  _parse_join_hint(func_name) { throw new NotPorted("_parse_join_hint", "sqlglot/parser.py:8556"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8560
  _parse_substring() { const args = this._parse_csv(this._parse_bitwise.bind(this)); let start = null, length = null; while (this._curr.bool()) { if (this._match(TokenType.FROM)) start = this._parse_bitwise(); else if (this._match(TokenType.FOR)) { if (!start) start = exp.Literal.number(1); length = this._parse_bitwise(); } else break; } if (start) args.push(start); if (length) args.push(length); return this.validate_expression(exp.Substring.from_arg_list(args), args); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8586
  _parse_trim() { let position = null, collation = null, expression = null; if (this._match_texts(this.constructor.TRIM_TYPES)) position = pyUpper(this._prev.text); let this_ = this._parse_bitwise(); if (this._match_set(new Set([TokenType.FROM, TokenType.COMMA]))) { const invert = this._prev.token_type === TokenType.FROM || this.constructor.TRIM_PATTERN_FIRST; expression = this._parse_bitwise(); if (invert) [this_, expression] = [expression, this_]; } if (this._match(TokenType.COLLATE)) collation = this._parse_bitwise(); return this.expression(new exp.Trim({ this: this_, position, expression, collation })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8612
  _parse_window_clause() { throw new NotPorted("_parse_window_clause", "sqlglot/parser.py:8612"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8615
  _parse_named_window() { throw new NotPorted("_parse_named_window", "sqlglot/parser.py:8615"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8618
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_respect_or_ignore_nulls(this_) {
    if (this._curr.token_type === TokenType.VAR) {
      if (this._match_text_seq("IGNORE", "NULLS")) return this.expression(new exp.IgnoreNulls({ this: this_ }));
      if (this._match_text_seq("RESPECT", "NULLS")) return this.expression(new exp.RespectNulls({ this: this_ }));
    }
    return this_;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:8626
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_having_max(this_) {
    if (this._match(TokenType.HAVING)) {
      this._match_texts(["MAX", "MIN"]);
      return this.expression(new exp.HavingMax({ this: this_, expression: this._parse_column(), max: pyUpper(this._prev.text) !== "MIN" }));
    }
    return this_;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:8636
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_window(this_, alias = false) {
    const cls = this.constructor;
    const func = this_;
    const comments = func instanceof exp.Expr ? func.comments : null;
    if (cls.SUPPORTS_NTH_VALUE_FROM_MODIFIER && this_ instanceof exp.NthValue) {
      if (this._match_text_seq("FROM", "FIRST")) this_.set("from_first", true);
      else if (this._match_text_seq("FROM", "LAST")) this_.set("from_first", false);
    }
    if (this._match_text_seq("WITHIN", "GROUP")) this_ = this.expression(new exp.WithinGroup({ this: this_, expression: this._parse_wrapped(() => this._parse_order()) }));
    if (this._match_pair(TokenType.FILTER, TokenType.L_PAREN)) {
      this._match(TokenType.WHERE);
      this_ = this.expression(new exp.Filter({ this: this_, expression: this._parse_where(true) }));
      this._match_r_paren();
    }
    if (this_ instanceof exp.AggFunc) {
      const ignore_respect = findInScope(this_, exp.IgnoreNulls, exp.RespectNulls);
      if (ignore_respect && ignore_respect !== this_) {
        ignore_respect.replace(ignore_respect.this);
        this_ = this.expression(new ignore_respect.constructor({ this: this_ }));
      }
    }
    this_ = this._parse_respect_or_ignore_nulls(this_);
    let over;
    if (alias) { over = null; this._match(TokenType.ALIAS); }
    else if (!this._match_set(cls.WINDOW_BEFORE_PAREN_TOKENS)) return this_;
    else over = pyUpper(this._prev.text);
    if (comments && func instanceof exp.Expr) func.popComments();
    if (!this._match(TokenType.L_PAREN)) return this.expression(new exp.Window({ this: this_, alias: this._parse_id_var(false), over }), null, comments);
    const window_alias = this._parse_id_var(false, cls.WINDOW_ALIAS_TOKENS);
    let first = this._match(TokenType.FIRST) ? true : null;
    if (this._match_text_seq("LAST")) first = false;
    const [partition, order] = this._parse_partition_and_order();
    const has_kind = this._match_set(new Set([TokenType.ROWS, TokenType.RANGE])) || this._match_text_seq("GROUPS");
    const kind = has_kind ? this._prev.text : null;
    let spec = null;
    if (kind) {
      this._match(TokenType.BETWEEN);
      const start = this._parse_window_spec();
      const end = this._match(TokenType.AND) ? this._parse_window_spec() : {};
      const exclude = this._match_text_seq("EXCLUDE") ? this._parse_var_from_options(cls.WINDOW_EXCLUDE_OPTIONS) : null;
      spec = this.expression(new exp.WindowSpec({ kind, start: start.value, start_side: start.side, end: end.value, end_side: end.side, exclude }));
    }
    this._match_r_paren();
    const window = this.expression(new exp.Window({ this: this_, partition_by: partition, order, spec, alias: window_alias, over, first }), null, comments);
    return this._match_set(cls.WINDOW_BEFORE_PAREN_TOKENS, false) ? this._parse_window(window, alias) : window;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:8756
  _parse_partition_and_order() { return [this._parse_partition_by(), this._parse_order()]; }

  /** @returns {*} */
  // py: sqlglot/parser.py:8761
  _parse_window_spec() {
    this._match(TokenType.BETWEEN);
    const value = (this._match_text_seq("UNBOUNDED") && "UNBOUNDED") || (this._match_text_seq("CURRENT", "ROW") && "CURRENT ROW") || this._parse_bitwise();
    return { value, side: this._match_texts(this.constructor.WINDOW_SIDES) ? this._prev.text : null };
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:8773
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_alias(this_, explicit) { throw new NotPorted("_parse_alias", "sqlglot/parser.py:8773"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8816
  _parse_id_var(any_token, tokens) { throw new NotPorted("_parse_id_var", "sqlglot/parser.py:8816"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8830
  _parse_string() {
    const parsers = this.constructor.STRING_PARSERS;
    if (this._match_set(parsers)) return parsers.get(this._prev.token_type)(this, this._prev);
    return this._parse_placeholder();
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:8835
  _parse_string_as_identifier() { throw new NotPorted("_parse_string_as_identifier", "sqlglot/parser.py:8835"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8842
  _parse_number() { throw new NotPorted("_parse_number", "sqlglot/parser.py:8842"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8847
  _parse_identifier() { throw new NotPorted("_parse_identifier", "sqlglot/parser.py:8847"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8852
  _parse_var(any_token, tokens, upper) { throw new NotPorted("_parse_var", "sqlglot/parser.py:8852"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8868
  _advance_any(ignore_reserved) { throw new NotPorted("_advance_any", "sqlglot/parser.py:8868"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8874
  _parse_var_or_string(upper) { throw new NotPorted("_parse_var_or_string", "sqlglot/parser.py:8874"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8877
  _parse_primary_or_var() { throw new NotPorted("_parse_primary_or_var", "sqlglot/parser.py:8877"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8880
  _parse_null() { return this.expression(exp.null()); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8885
  _parse_boolean() { throw new NotPorted("_parse_boolean", "sqlglot/parser.py:8885"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8892
  _parse_star() { throw new NotPorted("_parse_star", "sqlglot/parser.py:8892"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8897
  _parse_parameter() { return this.expression(new exp.Parameter({ this: this._parse_identifier() || this._parse_primary_or_var() })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8901
  _parse_placeholder() {
    const parsers = this.constructor.PLACEHOLDER_PARSERS;
    if (this._match_set(parsers)) {
      const placeholder = parsers.get(this._prev.token_type)(this);
      if (placeholder) return placeholder;
      // py: `self._advance(-1)` — a PLACEHOLDER_PARSERS entry may decline by returning
      // None after `_match_set` already consumed its token, so the cursor is put back.
      this._advance(-1);
    }
    return null;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:8909
  _parse_star_op(...keywords) { if (!this._match_texts(keywords)) return null; if (this._match(TokenType.L_PAREN, false)) return this._parse_wrapped_csv(() => this._parse_expression()); const expression = this._parse_alias(this._parse_disjunction(), true); return expression ? [expression] : null; }

  /** @returns {*} */
  // py: sqlglot/parser.py:8918
  _parse_csv(parse_method, sep) { throw new NotPorted("_parse_csv", "sqlglot/parser.py:8918"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8933
  _parse_wrapped_id_vars(optional = false) { return this._parse_wrapped_csv(() => this._parse_id_var(), optional); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8936
  _parse_wrapped_csv(parse_method, sep, optional) { throw new NotPorted("_parse_wrapped_csv", "sqlglot/parser.py:8936"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8946
  _parse_wrapped(parse_method, optional) { throw new NotPorted("_parse_wrapped", "sqlglot/parser.py:8946"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8955
  _parse_expressions() { return this._parse_csv(() => this._parse_expression()); }

  /** @returns {*} */
  // py: sqlglot/parser.py:8958
  _parse_select_or_expression(alias = false) {
    return this._parse_set_operations(alias ? this._parse_alias(this._parse_assignment(), true) : this._parse_assignment()) || this._parse_select();
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:8968
  _parse_ddl_select() {
    return this._parse_query_modifiers(this._parse_set_operations(this._parse_select(true, false, false)));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:8973
  _parse_transaction() {
    let this_ = null;
    if (this._match_texts(this.constructor.TRANSACTION_KIND)) this_ = this._prev.text;
    this._match_texts(["TRANSACTION", "WORK"]);
    const modes = [];
    while (true) {
      const mode = [];
      while (this._match(TokenType.VAR) || this._match(TokenType.NOT)) mode.push(this._prev.text);
      if (mode.length) modes.push(mode.join(" "));
      if (!this._match(TokenType.COMMA)) break;
    }
    return this.expression(new exp.Transaction({ this: this_, modes }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:8993
  _parse_commit_or_rollback() {
    let chain = null;
    let savepoint = null;
    const isRollback = this._prev.token_type === TokenType.ROLLBACK;
    this._match_texts(["TRANSACTION", "WORK"]);
    if (this._match_text_seq("TO")) {
      this._match_text_seq("SAVEPOINT");
      savepoint = this._parse_id_var();
    }
    if (this._match(TokenType.AND)) {
      chain = !this._match_text_seq("NO");
      this._match_text_seq("CHAIN");
    }
    return this.expression(isRollback ? new exp.Rollback({ savepoint }) : new exp.Commit({ chain }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9013
  _parse_refresh() {
    let kind;
    if (this._match_text_seq("EXTERNAL", "TABLE")) kind = "EXTERNAL TABLE";
    else if (this._match(TokenType.TABLE)) kind = "TABLE";
    else if (this._match_text_seq("MATERIALIZED", "VIEW")) kind = "MATERIALIZED VIEW";
    else kind = "";
    const this_ = this._parse_string() || this._parse_table();
    if (!kind && !(this_ instanceof exp.Literal)) return this._parse_as_command(this._prev);
    return this.expression(new exp.Refresh({ this: this_, kind }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9029
  _parse_column_def_with_exists() {
    const start = this._index;
    this._match(TokenType.COLUMN);
    const exists = this._parse_exists(true);
    const expression = this._parse_field_def();
    if (!(expression instanceof exp.ColumnDef)) {
      this._retreat(start);
      return null;
    }
    expression.set("exists", exists);
    return expression;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9044
  _parse_add_column() { return pyUpper(this._prev.text) === "ADD" ? this._parse_column_def_with_exists() : null; }

  /** @returns {*} */
  // py: sqlglot/parser.py:9050
  _parse_drop_column() {
    const drop = this._match(TokenType.DROP) ? this._parse_drop() : null;
    if (drop && !(drop instanceof exp.Command)) drop.set("kind", drop.args.kind || "COLUMN");
    return drop;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9056
  _parse_alter_drop_action() { return this._parse_drop_column(); }

  /** @returns {*} */
  // py: sqlglot/parser.py:9060
  _parse_drop_partition(exists = null) {
    return this.expression(new exp.DropPartition({ expressions: this._parse_csv(() => this._parse_partition()), exists }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9065
  _parse_alter_table_add() {
    const parseAlteration = () => {
      this._match_text_seq("ADD");
      if (this._match_set(this.constructor.ADD_CONSTRAINT_TOKENS, false)) return this.expression(new exp.AddConstraint({ expressions: this._parse_csv(() => this._parse_constraint()) }));
      const columnDef = this._parse_add_column();
      if (columnDef instanceof exp.ColumnDef) return columnDef;
      const exists = this._parse_exists(true);
      if (this._match_pair(TokenType.PARTITION, TokenType.L_PAREN, false)) {
        return this.expression(new exp.AddPartition({ exists, this: this._parse_field(true), location: this._match_text_seq("LOCATION", false) && this._parse_property() }));
      }
      return null;
    };
    if (!this._match_set(this.constructor.ADD_CONSTRAINT_TOKENS, false) && (!this.dialect.ALTER_TABLE_ADD_REQUIRED_FOR_EACH_COLUMN || this._match_text_seq("COLUMNS"))) {
      const schema = this._parse_schema();
      return schema ? ensureList(schema) : this._parse_csv(() => this._parse_column_def_with_exists());
    }
    return this._parse_csv(parseAlteration);
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9104
  _parse_alter_table_alter() {
    if (this._match_texts(this.constructor.ALTER_ALTER_PARSERS)) return this.constructor.ALTER_ALTER_PARSERS.get(this._prev.text.toUpperCase())(this);
    this._match(TokenType.COLUMN);
    const exists = this._parse_exists();
    const column = this._parse_field(true);
    const opts = { this: column, exists: exists || null };
    if (this._match_pair(TokenType.DROP, TokenType.DEFAULT)) return this.expression(new exp.AlterColumn({ ...opts, drop: true }));
    if (this._match_pair(TokenType.SET, TokenType.DEFAULT)) return this.expression(new exp.AlterColumn({ ...opts, default: this._parse_disjunction() }));
    if (this._match(TokenType.COMMENT)) return this.expression(new exp.AlterColumn({ ...opts, comment: this._parse_string() }));
    if (this._match_text_seq("DROP", "NOT", "NULL")) return this.expression(new exp.AlterColumn({ ...opts, drop: true, allow_null: true }));
    if (this._match_text_seq("SET", "NOT", "NULL")) return this.expression(new exp.AlterColumn({ ...opts, allow_null: false }));
    if (this._match_text_seq("SET", "VISIBLE")) return this.expression(new exp.AlterColumn({ ...opts, visible: "VISIBLE" }));
    if (this._match_text_seq("SET", "INVISIBLE")) return this.expression(new exp.AlterColumn({ ...opts, visible: "INVISIBLE" }));
    this._match_text_seq("SET", "DATA");
    this._match_text_seq("TYPE");
    return this.expression(new exp.AlterColumn({ ...opts, dtype: this._parse_types(), collate: this._match(TokenType.COLLATE) && this._parse_term(), using: this._match(TokenType.USING) && this._parse_disjunction() }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9156
  _parse_alter_diststyle() {
    if (this._match_texts(["ALL", "EVEN", "AUTO"])) return this.expression(new exp.AlterDistStyle({ this: exp.var(this._prev.text.toUpperCase()) }));
    this._match_text_seq("KEY", "DISTKEY");
    return this.expression(new exp.AlterDistStyle({ this: this._parse_column() }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9163
  _parse_alter_sortkey(compound = null) {
    if (compound) this._match_text_seq("SORTKEY");
    if (this._match(TokenType.L_PAREN, false)) return this.expression(new exp.AlterSortKey({ expressions: this._parse_wrapped_id_vars(), compound }));
    this._match_texts(["AUTO", "NONE"]);
    return this.expression(new exp.AlterSortKey({ this: exp.var(this._prev.text.toUpperCase()), compound }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9177
  _parse_alter_table_drop() {
    const index = this._index - 1;
    const exists = this._parse_exists();
    if (this._match(TokenType.PARTITION, false)) return this._parse_csv(() => this._parse_drop_partition(exists));
    this._retreat(index);
    return this._parse_csv(() => this._parse_alter_drop_action());
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9187
  _parse_alter_table_rename() {
    if (this._match(TokenType.COLUMN) || (!this.constructor.ALTER_RENAME_REQUIRES_COLUMN && !this._match_text_seq("TO", false))) {
      const exists = this._parse_exists();
      const oldColumn = this._parse_column();
      const to = this._match_text_seq("TO");
      const newColumn = this._parse_column();
      if (!oldColumn || !to || !newColumn) return null;
      return this.expression(new exp.RenameColumn({ this: oldColumn, to: newColumn, exists }));
    }
    this._match_text_seq("TO");
    return this.expression(new exp.AlterRename({ this: this._parse_table(true) }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9204
  _parse_alter_table_set() {
    const alterSet = this.expression(new exp.AlterSet());
    if (this._match(TokenType.L_PAREN, false) || this._match_text_seq("TABLE", "PROPERTIES")) alterSet.set("expressions", this._parse_wrapped_csv(() => this._parse_assignment()));
    else if (this._match_text_seq("FILESTREAM_ON", false)) alterSet.set("expressions", [this._parse_assignment()]);
    else if (this._match_texts(["LOGGED", "UNLOGGED"])) alterSet.set("option", exp.var(this._prev.text.toUpperCase()));
    else if (this._match_text_seq("WITHOUT") && this._match_texts(["CLUSTER", "OIDS"])) alterSet.set("option", exp.var(`WITHOUT ${this._prev.text.toUpperCase()}`));
    else if (this._match_text_seq("LOCATION")) alterSet.set("location", this._parse_field());
    else if (this._match_text_seq("ACCESS", "METHOD")) alterSet.set("access_method", this._parse_field());
    else if (this._match_text_seq("TABLESPACE")) alterSet.set("tablespace", this._parse_field());
    else if (this._match_text_seq("FILE", "FORMAT") || this._match_text_seq("FILEFORMAT")) alterSet.set("file_format", [this._parse_field()]);
    else if (this._match_text_seq("STAGE_FILE_FORMAT")) alterSet.set("file_format", this._parse_wrapped_options());
    else if (this._match_text_seq("STAGE_COPY_OPTIONS")) alterSet.set("copy_options", this._parse_wrapped_options());
    else if (this._match_text_seq("TAG") || this._match_text_seq("TAGS")) alterSet.set("tag", this._parse_csv(() => this._parse_assignment()));
    else {
      if (this._match_text_seq("SERDE")) alterSet.set("serde", this._parse_field());
      alterSet.set("expressions", [this._parse_wrapped(() => this._parse_properties(), true)]);
    }
    return alterSet;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9240
  _parse_alter_session() {
    if (this._match(TokenType.SET)) return this.expression(new exp.AlterSession({ expressions: this._parse_csv(() => this._parse_set_item_assignment()), unset: false }));
    this._match_text_seq("UNSET");
    const expressions = this._parse_csv(() => this.expression(new exp.SetItem({ this: this._parse_id_var(true) })));
    return this.expression(new exp.AlterSession({ expressions, unset: true }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9252
  _parse_alter() {
    const start = this._prev;
    const iceberg = this._match_text_seq("ICEBERG");
    const alterToken = this._match_set(this.constructor.ALTERABLES) ? this._prev : null;
    if (!alterToken || (iceberg && alterToken.token_type !== TokenType.TABLE)) return this._parse_as_command(start);
    const exists = this._parse_exists();
    const only = this._match_text_seq("ONLY");
    let this_, check, cluster;
    if (alterToken.token_type === TokenType.SESSION) {
      this_ = check = cluster = null;
    } else {
      this_ = this._parse_table(true, undefined, undefined, undefined, undefined, this.constructor.ALTER_TABLE_PARTITIONS);
      check = this._match_text_seq("WITH", "CHECK");
      cluster = this._match(TokenType.ON) ? this._parse_on_property() : null;
      if (this._next.bool()) this._advance();
    }
    const parser = this.constructor.ALTER_PARSERS.get(this._prev.text.toUpperCase());
    if (parser) {
      const actions = ensureList(parser(this));
      const notValid = this._match_text_seq("NOT", "VALID");
      const options = this._parse_csv(() => this._parse_property());
      const cascade = this.dialect.ALTER_TABLE_SUPPORTS_CASCADE && this._match_text_seq("CASCADE");
      if (!this._curr.bool() && actions.length) return this.expression(new exp.Alter({ this: this_, kind: alterToken.text.toUpperCase(), exists, actions, only, options, cluster, not_valid: notValid, check, cascade, iceberg }));
    }
    return this._parse_as_command(start);
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9304
  _parse_analyze() {
    const start = this._prev;
    if (!this._curr.bool()) return this.expression(new exp.Analyze());
    const options = [];
    // deny:implicit_str sqlglot/parser.py:9313
    while (this._match_texts(this.constructor.ANALYZE_STYLES)) options.push(this._prev.text.toUpperCase() === "BUFFER_USAGE_LIMIT" ? `BUFFER_USAGE_LIMIT ${kernelSql(this._parse_number())}` : this._prev.text.toUpperCase());
    let tables = null;
    let innerExpression = null;
    let kind = this._curr.bool() ? this._curr.text.toUpperCase() : null;
    if (this._match(TokenType.TABLE)) tables = this._parse_csv(() => this._parse_table_parts());
    else if (this._match(TokenType.INDEX)) tables = this._parse_table_parts();
    else if (this._match_text_seq("TABLES")) {
      if (this._match_set(new Set([TokenType.FROM, TokenType.IN]))) {
        kind = `${kind} ${this._prev.text.toUpperCase()}`;
        tables = this._parse_table(true, undefined, undefined, undefined, true);
      }
    } else if (this._match_text_seq("DATABASE")) tables = this._parse_table(true, undefined, undefined, undefined, true);
    else if (this._match_text_seq("CLUSTER")) tables = this._parse_table();
    else if (this._match_texts(this.constructor.ANALYZE_EXPRESSION_PARSERS)) {
      kind = null;
      innerExpression = this.constructor.ANALYZE_EXPRESSION_PARSERS.get(this._prev.text.toUpperCase())(this);
    } else {
      kind = null;
      tables = this._parse_csv(() => this._parse_table_parts());
    }
    const partition = this._try_parse(() => this._parse_partition());
    if (!partition && this._match_texts(this.constructor.PARTITION_KEYWORDS)) return this._parse_as_command(start);
    const mode = this._match_text_seq("WITH", "SYNC", "MODE") || this._match_text_seq("WITH", "ASYNC", "MODE") ? `WITH ${this._tokens[this._index - 2].text.toUpperCase()} MODE` : null;
    if (this._match_texts(this.constructor.ANALYZE_EXPRESSION_PARSERS)) innerExpression = this.constructor.ANALYZE_EXPRESSION_PARSERS.get(this._prev.text.toUpperCase())(this);
    return this.expression(new exp.Analyze({ kind, tables: ensureList(tables), mode, partition, properties: this._parse_properties(), expression: innerExpression, options }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9372
  _parse_analyze_statistics() {
    let this_ = null;
    const kind = this._prev.text.toUpperCase();
    const option = this._match_text_seq("DELTA") ? this._prev.text.toUpperCase() : null;
    let expressions = [];
    if (!this._match_text_seq("STATISTICS")) this.raise_error("Expecting token STATISTICS");
    if (this._match_text_seq("NOSCAN")) this_ = "NOSCAN";
    else if (this._match(TokenType.FOR)) {
      if (this._match_text_seq("ALL", "COLUMNS")) this_ = "FOR ALL COLUMNS";
      if (this._match_text_seq("COLUMNS")) {
        this_ = "FOR COLUMNS";
        expressions = this._parse_csv(() => this._parse_column_reference());
      }
    } else if (this._match_text_seq("SAMPLE")) {
      const sample = this._parse_number();
      expressions = [this.expression(new exp.AnalyzeSample({ sample, kind: this._match(TokenType.PERCENT) ? this._prev.text.toUpperCase() : null }))];
    }
    return this.expression(new exp.AnalyzeStatistics({ kind, option, this: this_, expressions }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9405
  _parse_analyze_validate() {
    let kind = null, this_ = null, expression = null;
    if (this._match_text_seq("REF", "UPDATE")) {
      kind = "REF"; this_ = "UPDATE";
      if (this._match_text_seq("SET", "DANGLING", "TO", "NULL")) this_ = "UPDATE SET DANGLING TO NULL";
    } else if (this._match_text_seq("STRUCTURE")) {
      kind = "STRUCTURE";
      if (this._match_text_seq("CASCADE", "FAST")) this_ = "CASCADE FAST";
      else if (this._match_text_seq("CASCADE", "COMPLETE") && this._match_texts(["ONLINE", "OFFLINE"])) {
        this_ = `CASCADE COMPLETE ${this._prev.text.toUpperCase()}`;
        expression = this._parse_into();
      }
    }
    return this.expression(new exp.AnalyzeValidate({ kind, this: this_, expression }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9426
  _parse_analyze_columns() {
    const this_ = this._prev.text.toUpperCase();
    return this._match_text_seq("COLUMNS") ? this.expression(new exp.AnalyzeColumns({ this: `${this_} ${this._prev.text.toUpperCase()}` })) : null;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9432
  _parse_analyze_delete() {
    const kind = this._match_text_seq("SYSTEM") ? this._prev.text.toUpperCase() : null;
    return this._match_text_seq("STATISTICS") ? this.expression(new exp.AnalyzeDelete({ kind })) : null;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9438
  _parse_analyze_list() {
    return this._match_text_seq("CHAINED", "ROWS") ? this.expression(new exp.AnalyzeListChainedRows({ expression: this._parse_into() })) : null;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9444
  _parse_analyze_histogram() {
    const this_ = this._prev.text.toUpperCase();
    let expression = null;
    let expressions = [];
    let updateOptions = null;
    if (this._match_text_seq("HISTOGRAM", "ON")) {
      expressions = this._parse_csv(() => this._parse_column_reference());
      const withExpressions = [];
      while (this._match(TokenType.WITH)) {
        if (this._match_texts(["SYNC", "ASYNC"])) {
          if (this._match_text_seq("MODE", false)) {
            withExpressions.push(`${this._prev.text.toUpperCase()} MODE`);
            this._advance();
          }
        } else {
          const buckets = this._parse_number();
          // deny:implicit_str sqlglot/parser.py:9462
          if (this._match_text_seq("BUCKETS")) withExpressions.push(`${kernelSql(buckets)} BUCKETS`);
        }
      }
      if (withExpressions.length) expression = this.expression(new exp.AnalyzeWith({ expressions: withExpressions }));
      if (this._match_texts(["MANUAL", "AUTO"]) && this._match(TokenType.UPDATE, false)) {
        updateOptions = this._prev.text.toUpperCase();
        this._advance();
      } else if (this._match_text_seq("USING", "DATA")) expression = this.expression(new exp.UsingData({ this: this._parse_string() }));
    }
    return this.expression(new exp.AnalyzeHistogram({ this: this_, expressions, expression, update_options: updateOptions }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9483
  _parse_merge() { throw new NotPorted("_parse_merge", "sqlglot/parser.py:9483"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:9504
  _parse_when_matched() { throw new NotPorted("_parse_when_matched", "sqlglot/parser.py:9504"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:9557
  _parse_show() {
    const parser = this._find_parser(this.constructor.SHOW_PARSERS, this.constructor.SHOW_TRIE);
    return parser ? parser(this) : this._parse_as_command(this._prev);
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9563
  _parse_set_item_assignment(kind = null) {
    const index = this._index;
    if (["GLOBAL", "SESSION"].includes(kind) && this._match_text_seq("TRANSACTION")) return this._parse_set_transaction(kind === "GLOBAL");
    const left = this._parse_primary() || this._parse_column();
    const delimiter = this._match_texts(this.constructor.SET_ASSIGNMENT_DELIMITERS);
    if (!left || (this.constructor.SET_REQUIRES_ASSIGNMENT_DELIMITER && !delimiter)) {
      this._retreat(index);
      return null;
    }
    let right = this._parse_statement() || this._parse_id_var();
    if (right instanceof exp.Column || right instanceof exp.Identifier) right = exp.var(right.name);
    return this.expression(new exp.SetItem({ this: this.expression(new exp.EQ({ this: left, expression: right })), kind }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9583
  _parse_set_transaction(global_ = false) {
    this._match_text_seq("TRANSACTION");
    const expressions = this._parse_csv(() => this._parse_var_from_options(this.constructor.TRANSACTION_CHARACTERISTICS));
    return this.expression(new exp.SetItem({ expressions, kind: "TRANSACTION", global_: global_ }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9592
  _parse_set_item() {
    const parser = this._find_parser(this.constructor.SET_PARSERS, this.constructor.SET_TRIE);
    return parser ? parser(this) : this._parse_set_item_assignment();
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9596
  _parse_set(unset = false, tag = false) { const index = this._index; const set_ = this.expression(new exp.Set({ expressions: this._parse_csv(this._parse_set_item.bind(this)), unset, tag })); if (this._curr.bool()) { this._retreat(index); return this._parse_as_command(this._prev); } return set_; }

  /** @returns {*} */
  // py: sqlglot/parser.py:9608
  _parse_var_from_options(options, raise_unmatched = true) {
    const start = this._curr;
    if (!start.bool()) return null;
    let option = pyUpper(start.text);
    const continuations = this.constructor.TEXT_MATCH_EXCLUDED_TOKENS.has(start.token_type) ? null : options.get(option);
    const index = this._index; this._advance();
    let matched = false;
    for (let keywords of continuations || []) {
      if (typeof keywords === "string") keywords = [keywords];
      if (this._match_text_seq(...keywords)) { option = `${option} ${keywords.join(" ")}`; matched = true; break; }
    }
    if (!matched && (!pyFalsy(continuations) || continuations === null || continuations === undefined)) {
      if (raise_unmatched) this.raise_error(`Unknown option ${option}`);
      this._retreat(index); return null;
    }
    return exp.var(option);
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9639
  _parse_as_command(start) {
    while (this._curr.bool()) this._advance();
    const value = this._find_sql(start, this._prev);
    const size = [...start.text].length;
    this._warn_unsupported();
    return new exp.Command({ this: [...value].slice(0, size).join(""), expression: [...value].slice(size).join("") });
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9647
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_dict_property(this_) { throw new NotPorted("_parse_dict_property", "sqlglot/parser.py:9647"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:9668
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_dict_range(this_) { this._match_l_paren(); const hasMin = this._match_text_seq("MIN"); let min, max; if (hasMin) { min = this._parse_var() || this._parse_primary(); this._match_text_seq("MAX"); max = this._parse_var() || this._parse_primary(); } else { max = this._parse_var() || this._parse_primary(); min = exp.Literal.number(0); } this._match_r_paren(); return this.expression(new exp.DictRange({ this: this_, min, max })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:9681
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_comprehension(this_) { const index = this._index; const expression = this._parse_column(); const position = this._match(TokenType.COMMA) ? this._parse_column() : null; if (!this._match(TokenType.IN)) { this._retreat(index - 1); return null; } const iterator = this._parse_column(); const condition = this._match_text_seq("IF") ? this._parse_disjunction() : null; return this.expression(new exp.Comprehension({ this: this_, expression, position, iterator, condition })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:9701
  _parse_heredoc() {
    if (this._match(TokenType.HEREDOC_STRING)) return this.expression(new exp.Heredoc({ this: this._prev.text }));
    if (!this._match_text_seq("$")) return null;
    const tags = ["$"];
    let tag_text = null;
    if (this._is_connected()) { this._advance(); tags.push(pyUpper(this._prev.text)); }
    else this.raise_error("No closing $ found");
    if (tags.at(-1) !== "$") {
      if (this._is_connected() && this._match_text_seq("$")) { tag_text = tags.at(-1); tags.push("$"); }
      else this.raise_error("No closing $ found");
    }
    const heredoc_start = this._curr;
    while (this._curr.bool()) {
      if (this._match_text_seq(...tags, { advance: false })) {
        const this_ = this._find_sql(heredoc_start, this._prev);
        this._advance(tags.length);
        return this.expression(new exp.Heredoc({ this: this_, tag: tag_text }));
      }
      this._advance();
    }
    this.raise_error(`No closing ${tags.join("")} found`);
    return null;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9737
  _find_parser(parsers, trie) { throw new NotPorted("_find_parser", "sqlglot/parser.py:9737"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:9761
  _match_l_paren(expression) { throw new NotPorted("_match_l_paren", "sqlglot/parser.py:9761"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:9765
  _match_r_paren(expression) { throw new NotPorted("_match_r_paren", "sqlglot/parser.py:9765"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:9769
  _replace_lambda(node, expressions) { throw new NotPorted("_replace_lambda", "sqlglot/parser.py:9769"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:9799
  _parse_truncate_table() {
    const start = this._prev;
    if (this._match(TokenType.L_PAREN)) {
      this._retreat(this._index - 2);
      return this._parse_function();
    }
    const isDatabase = this._match(TokenType.DATABASE);
    this._match(TokenType.TABLE);
    const exists = this._parse_exists();
    const expressions = this._parse_csv(() => this._parse_table(true, undefined, undefined, undefined, isDatabase));
    const cluster = this._match(TokenType.ON) ? this._parse_on_property() : null;
    let identity = null;
    if (this._match_text_seq("RESTART", "IDENTITY")) identity = "RESTART";
    else if (this._match_text_seq("CONTINUE", "IDENTITY")) identity = "CONTINUE";
    const option = this._match_text_seq("CASCADE") || this._match_text_seq("RESTRICT") ? this._prev.text : null;
    const partition = this._parse_partition();
    if (this._curr.bool()) return this._parse_as_command(start);
    return this.expression(new exp.TruncateTable({ expressions, is_database: isDatabase, exists, cluster, identity, option, partition }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9850
  _parse_indexed_column() { return this._parse_ordered(() => this._parse_opclass()); }

  /** @returns {*} */
  // py: sqlglot/parser.py:9853
  _parse_with_operator() {
    const self = this._parse_indexed_column();
    if (!this._match(TokenType.WITH)) return self;
    const op = this._parse_var(true, this.constructor.RESERVED_TOKENS);
    return this.expression(new exp.WithOperator({ this: self, op }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:9863
  _parse_wrapped_options() { this._match(TokenType.EQ); this._match(TokenType.L_PAREN); const opts = []; while (this._curr.bool() && !this._match(TokenType.R_PAREN)) { const option = this._match_text_seq("FORMAT_NAME", "=") ? this._parse_format_name() : this._parse_property(); if (option === null || option === undefined) { this.raise_error("Unable to parse option"); break; } opts.push(...ensureList(option)); } return opts; }

  /** @returns {*} */
  // py: sqlglot/parser.py:9884
  _parse_copy_parameters() { throw new NotPorted("_parse_copy_parameters", "sqlglot/parser.py:9884"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:9923
  _parse_credentials() { throw new NotPorted("_parse_credentials", "sqlglot/parser.py:9923"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:9946
  _parse_file_location() { throw new NotPorted("_parse_file_location", "sqlglot/parser.py:9946"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:9949
  _parse_copy() { throw new NotPorted("_parse_copy", "sqlglot/parser.py:9949"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:9984
  _parse_normalize() { throw new NotPorted("_parse_normalize", "sqlglot/parser.py:9984"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:9991
  _parse_ceil_floor(expr_type) {
    const this_ = this._parse_bitwise(); const dec = this._match(TokenType.COMMA) || this._match_text_seq("TO"); const decimals = dec ? this._parse_bitwise() : null;
    this._match_r_paren(); return this.expression(new expr_type({ this: this_, decimals }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:10003
  _parse_star_ops() { const starToken = this._prev; if (this._match_text_seq("COLUMNS", "(", false)) { const this_ = this._parse_function(); if (this_ instanceof exp.Columns) this_.set("unpack", true); return this_; } const index = this._index; const ilike = this._match(TokenType.ILIKE) ? this._parse_string() : null; if (!ilike) this._retreat(index); return this.expression(new exp.Star({ ilike, except: this._parse_star_op("EXCEPT", "EXCLUDE"), replace: this._parse_star_op("REPLACE"), rename: this._parse_star_op("RENAME") })).updatePositions(starToken); }

  /** @returns {*} */
  // py: sqlglot/parser.py:10027
  _parse_grant_privilege() {
    const parts = [];
    while (this._curr.bool() && !this._match_set(this.constructor.PRIVILEGE_FOLLOW_TOKENS, false)) {
      parts.push(this._curr.text.toUpperCase());
      this._advance();
    }
    const expressions = this._match(TokenType.L_PAREN, false) ? this._parse_wrapped_csv(() => this._parse_column()) : null;
    return this.expression(new exp.GrantPrivilege({ this: exp.var(parts.join(" ")), expressions }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:10045
  _parse_grant_principal() {
    const kind = this._match_texts(["ROLE", "GROUP"]) ? this._prev.text.toUpperCase() : null;
    const principal = this._parse_id_var();
    return principal ? this.expression(new exp.GrantPrincipal({ this: principal, kind })) : null;
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:10054
  _parse_grant_revoke_common() {
    const privileges = this._parse_csv(() => this._parse_grant_privilege());
    this._match(TokenType.ON);
    const kind = this._match_set(this.constructor.CREATABLES) ? this._prev.text.toUpperCase() : null;
    return [privileges, kind, this._try_parse(() => this._parse_table_parts())];
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:10068
  _parse_grant() {
    const start = this._prev;
    const [privileges, kind, securable] = this._parse_grant_revoke_common();
    if (!securable || !this._match_text_seq("TO")) return this._parse_as_command(start);
    const principals = this._parse_csv(() => this._parse_grant_principal());
    const grantOption = this._match_text_seq("WITH", "GRANT", "OPTION");
    if (this._curr.bool()) return this._parse_as_command(start);
    return this.expression(new exp.Grant({ privileges, kind, securable, principals, grant_option: grantOption }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:10093
  _parse_revoke() {
    const start = this._prev;
    const grantOption = this._match_text_seq("GRANT", "OPTION", "FOR");
    const [privileges, kind, securable] = this._parse_grant_revoke_common();
    if (!securable || !this._match_text_seq("FROM")) return this._parse_as_command(start);
    const principals = this._parse_csv(() => this._parse_grant_principal());
    const cascade = this._match_texts(["CASCADE", "RESTRICT"]) ? this._prev.text.toUpperCase() : null;
    if (this._curr.bool()) return this._parse_as_command(start);
    return this.expression(new exp.Revoke({ privileges, kind, securable, principals, grant_option: grantOption, cascade }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:10123
  _parse_overlay() { throw new NotPorted("_parse_overlay", "sqlglot/parser.py:10123"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:10140
  _parse_format_name() {
    const this_ = this._parse_id_var(); const options = this._match(TokenType.L_PAREN) ? this._parse_csv(this._parse_property_assignment.bind(this, exp.Property)) : null;
    if (options) this._match_r_paren(); return this.expression(new exp.FormatNameProperty({ this: this_, expressions: options }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:10149
  _parse_distinct_arg_function(func, distinct_index = 0) {
    const is_distinct = this._match(TokenType.DISTINCT);
    if (!is_distinct) this._match(TokenType.ALL);
    const args = [this._parse_lambda()];
    if (this._match(TokenType.COMMA)) args.push(...this._parse_function_args());
    const target = seqGet(args, distinct_index);
    if (is_distinct && target) args[distinct_index] = this.expression(new exp.Distinct({ expressions: [target] }));
    return func.from_arg_list(args);
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:10164
  _identifier_expression(token, quoted) { throw new NotPorted("_identifier_expression", "sqlglot/parser.py:10164"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:10170
  _build_pipe_cte(query, expressions, alias_cte) { throw new NotPorted("_build_pipe_cte", "sqlglot/parser.py:10170"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:10192
  _parse_pipe_syntax_select(query) { throw new NotPorted("_parse_pipe_syntax_select", "sqlglot/parser.py:10192"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:10201
  _parse_pipe_syntax_limit(query) { throw new NotPorted("_parse_pipe_syntax_limit", "sqlglot/parser.py:10201"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:10215
  _parse_pipe_syntax_aggregate_fields() { throw new NotPorted("_parse_pipe_syntax_aggregate_fields", "sqlglot/parser.py:10215"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:10227
  _parse_pipe_syntax_aggregate_group_order_by(query, group_by_exists) { throw new NotPorted("_parse_pipe_syntax_aggregate_group_order_by", "sqlglot/parser.py:10227"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:10257
  _parse_pipe_syntax_aggregate(query) { throw new NotPorted("_parse_pipe_syntax_aggregate", "sqlglot/parser.py:10257"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:10268
  _parse_pipe_syntax_set_operator(query) { throw new NotPorted("_parse_pipe_syntax_set_operator", "sqlglot/parser.py:10268"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:10299
  _parse_pipe_syntax_join(query) { throw new NotPorted("_parse_pipe_syntax_join", "sqlglot/parser.py:10299"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:10309
  _parse_pipe_syntax_pivot(query) { throw new NotPorted("_parse_pipe_syntax_pivot", "sqlglot/parser.py:10309"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:10320
  _parse_pipe_syntax_extend(query) { throw new NotPorted("_parse_pipe_syntax_extend", "sqlglot/parser.py:10320"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:10325
  _parse_pipe_syntax_tablesample(query) { throw new NotPorted("_parse_pipe_syntax_tablesample", "sqlglot/parser.py:10325"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:10336
  _parse_pipe_syntax_query(query) { throw new NotPorted("_parse_pipe_syntax_query", "sqlglot/parser.py:10336"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:10364
  _parse_declareitem() {
    this._match_texts(["VAR", "VARIABLE"]);
    const vars = this._parse_csv(() => this._parse_id_var());
    if (!vars.length) return null;
    this._match(TokenType.ALIAS);
    const kind = this._match(TokenType.TABLE) ? this._parse_schema() : this._parse_types();
    const default_ = (this._match(TokenType.DEFAULT) || this._match(TokenType.EQ)) && this._parse_bitwise();
    return this.expression(new exp.DeclareItem({ this: vars, kind, default: default_ }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:10379
  _parse_declare() {
    const start = this._prev;
    const replace = this._match_text_seq("OR", "REPLACE");
    const expressions = this._try_parse(() => this._parse_csv(() => this._parse_declareitem()));
    if (!expressions || this._curr.bool()) return this._parse_as_command(start);
    return this.expression(new exp.Declare({ expressions, replace }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:10389
  build_cast(strict) { throw new NotPorted("build_cast", "sqlglot/parser.py:10389"); }

  /** @returns {*} */
  // py: sqlglot/parser.py:10397
  _parse_json_value() { const this_ = this._parse_bitwise(); this._match(TokenType.COMMA); const path = this._parse_bitwise(); const returning = this._match(TokenType.RETURNING) ? this._parse_type() : null; return this.expression(new exp.JSONValue({ this: this_, path: this.dialect.to_json_path(path), returning, on_condition: this._parse_on_condition() })); }

  /** @returns {*} */
  // py: sqlglot/parser.py:10413
  _parse_group_concat() {
    let args;
    const concat_exprs = (node, exprs) => {
      if (node instanceof exp.Distinct && node.expressions.length > 1) {
        node.set("expressions", [this.expression(new exp.Concat({ expressions: node.expressions, safe: true, coalesce: this.dialect.CONCAT_COALESCE }))]);
        return node;
      }
      if (exprs.length === 1) return exprs[0];
      return this.expression(new exp.Concat({ expressions: args, safe: true, coalesce: this.dialect.CONCAT_COALESCE }));
    };
    args = this._parse_csv(() => this._parse_lambda());
    let this_ = null;
    if (args.length) {
      const order = args.at(-1) instanceof exp.Order ? args.at(-1) : null;
      if (order) { args[args.length - 1] = order.this; order.set("this", concat_exprs(order.this, args)); }
      this_ = order || concat_exprs(args[0], args);
    }
    const separator = this._match(TokenType.SEPARATOR) ? this._parse_field() : null;
    return this.expression(new exp.GroupConcat({ this: this_, separator }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:10452
  _parse_initcap() {
    const this_ = this._parse_bitwise(); const expression = this._match(TokenType.COMMA) ? this._parse_bitwise() : null; this._match_r_paren();
    return this.expression(new exp.Initcap({ this: this_, expression }));
  }

  /** @returns {*} */
  // py: sqlglot/parser.py:10461
  // note: param `this` renamed to `this_` (JS reserved word)
  _parse_operator(this_) { while (true) { if (!this._match(TokenType.L_PAREN)) break; let op = ""; while (this._curr.bool() && !this._match(TokenType.R_PAREN)) { op += this._curr.text; this._advance(); } const comments = this._prev_comments; this_ = this.expression(new exp.Operator({ this: this_, operator: op, expression: this._parse_bitwise() }), null, comments); if (!this._match(TokenType.OPERATOR)) break; } return this_; }

}
